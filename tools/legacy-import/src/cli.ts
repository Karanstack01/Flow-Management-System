#!/usr/bin/env -S npx tsx
/**
 * Legacy FMS migration.
 *
 *   1. In the old spreadsheet: File → Download → CSV for the Settings, Data and Archive tabs.
 *   2. Dry run:   npm run convert -w @fms/legacy-import -- --settings Settings.csv --key orders --name "Orders" --out orders.json
 *   3. Import:    npm run load -w @fms/legacy-import -- --settings Settings.csv --data Data.csv [--archive Archive.csv] --key orders --name "Orders" [--org default] [--date-order dmy]
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { computeTimeline, workflowSettingsSchema, type StageState } from '@fms/core';
import { loadWorkflow, prisma, Prisma } from '@fms/db';
import { parseCsv } from './csv.js';
import { convertDataRows, convertSettings } from './convert.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    settings: { type: 'string' },
    data: { type: 'string' },
    archive: { type: 'string' },
    key: { type: 'string', default: 'imported' },
    name: { type: 'string', default: 'Imported workflow' },
    out: { type: 'string' },
    org: { type: 'string', default: 'default' },
    calendar: { type: 'string' },
    'date-order': { type: 'string', default: 'dmy' },
  },
});

const cmd = positionals[0];
if (!values.settings || (cmd !== 'convert' && cmd !== 'load')) {
  console.error('Usage: fms-import <convert|load> --settings Settings.csv [--data Data.csv] [--archive Archive.csv] --key <key> --name <name>');
  process.exit(2);
}
const dateOrder = values['date-order'] === 'mdy' ? 'mdy' : 'dmy';
const conv = convertSettings(parseCsv(readFileSync(values.settings, 'utf8')), { key: values.key!, name: values.name! });
for (const w of conv.warnings) console.warn(`warn: ${w}`);

if (cmd === 'convert') {
  const json = JSON.stringify({ definition: conv.definition, columns: Object.fromEntries(conv.columns) }, null, 2);
  if (values.out) writeFileSync(values.out, json);
  else console.log(json);
  console.error(`Converted ${conv.definition.stages.length} stages, ${conv.definition.fields.length} fields.`);
  process.exit(0);
}

// ------------------------------------------------------------------ load
const org = await prisma.organization.findUnique({ where: { slug: values.org! } });
if (!org) throw new Error(`Organization "${values.org}" not found (run the seed first)`);
const calendarId = values.calendar ?? (await prisma.businessCalendar.findFirst({ where: { orgId: org.id } }))?.id;
if (!calendarId) throw new Error('No business calendar found; create one first');
if (await prisma.workflow.findUnique({ where: { orgId_key: { orgId: org.id, key: conv.definition.key } } })) {
  throw new Error(`Workflow "${conv.definition.key}" already exists — choose another --key`);
}

const settings = workflowSettingsSchema.parse({});
const created = await prisma.workflow.create({
  data: {
    orgId: org.id,
    key: conv.definition.key,
    name: conv.definition.name,
    definition: conv.definition as Prisma.InputJsonObject,
    settings: settings as Prisma.InputJsonObject,
    calendarId,
    // Inactive while loading: the worker's sweep skips inactive flows, so it can not send hand-offs
    // for historic tasks before they are marked as handed off below. Activated at the end.
    isActive: false,
    versions: { create: { version: 1, definition: conv.definition as Prisma.InputJsonObject, settings: settings as Prisma.InputJsonObject } },
  },
});
const wf = (await loadWorkflow(prisma, { id: created.id }))!;

async function importRows(file: string, archived: boolean) {
  const { records, warnings } = convertDataRows(parseCsv(readFileSync(file, 'utf8')), conv, { timezone: wf.calendar.config.timezone, dateOrder });
  for (const w of warnings) console.warn(`warn: ${w}`);
  const now = new Date();
  let max = 0;
  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500);
    const recordRows: Prisma.RecordCreateManyInput[] = [];
    const stageRows: Prisma.RecordStageCreateManyInput[] = [];
    for (const r of batch) {
      const previous: StageState[] = wf.def.stages.map((s) => {
        const imported = r.stages.get(s.key);
        return { stageKey: s.key, status: imported?.actualAt ? 'done' : imported?.plannedAt ? 'active' : 'waiting', plannedAt: imported?.plannedAt ?? null, actualAt: imported?.actualAt ?? null };
      });
      const t = computeTimeline({ stages: wf.def.stages, data: r.data, createdAt: r.createdAt, now, calendar: wf.calendar, previous });
      const id = randomUUID();
      max = Math.max(max, r.number);
      recordRows.push({
        id,
        orgId: wf.orgId,
        workflowId: wf.id,
        number: r.number,
        data: r.data as Prisma.InputJsonObject,
        currentStageKey: t.currentStageKey,
        completedAt: t.currentStageKey ? null : (t.states.at(-1)?.actualAt ?? now),
        createdAt: r.createdAt,
        archivedAt: archived ? now : null,
      });
      for (const s of t.states) stageRows.push({ recordId: id, stageKey: s.stageKey, status: s.status, plannedAt: s.plannedAt, actualAt: s.actualAt });
    }
    await prisma.$transaction([prisma.record.createMany({ data: recordRows, skipDuplicates: true }), prisma.recordStage.createMany({ data: stageRows, skipDuplicates: true })]);
    console.log(`  ${archived ? 'archive' : 'data'}: ${Math.min(i + 500, records.length)}/${records.length}`);
  }
  return max;
}

let maxNumber = 0;
if (values.data) maxNumber = Math.max(maxNumber, await importRows(values.data, false));
if (values.archive) maxNumber = Math.max(maxNumber, await importRows(values.archive, true));
await prisma.workflow.update({ where: { id: wf.id }, data: { recordSeq: maxNumber } });
// Mark existing active stages as already handed off so the worker does not notify historic tasks.
await prisma.$executeRaw`
  INSERT INTO "NotificationLog" ("id", "kind", "channel", "recipient", "status", "dedupeKey", "recordId", "createdAt")
  SELECT gen_random_uuid()::text, 'handoff-marker', 'none', '*', 'skipped', 'handoff:' || s."recordId" || ':' || s."stageKey", s."recordId", now()
  FROM "RecordStage" s JOIN "Record" r ON r."id" = s."recordId"
  WHERE r."workflowId" = ${wf.id} AND s."status" = 'active'
  ON CONFLICT ("dedupeKey") DO NOTHING`;
await prisma.workflow.update({ where: { id: wf.id }, data: { isActive: true } });
console.log(`Imported workflow "${wf.key}" (next record number ${maxNumber + 1}).`);
await prisma.$disconnect();
