/**
 * Public intake form (Stage › Public Form Access). No sign-in: anyone with the link can submit
 * the first stage of a live flow whose intake form is switched to public.
 *
 * What a public submitter may fill in is deliberately narrow: intake fields that everyone may
 * edit (edit groups include ALL), are not hidden or restricted to named users, and are not file
 * uploads (uploading needs an account). Everything else gets its default value, if any.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { editableFieldKeys, type Capability } from '@fms/core';
import { loadWorkflow, prisma, type LoadedWorkflow } from '@fms/db';
import { AppError, parse } from '../lib/errors.js';
import type { AuthUser } from '../plugins/auth.js';
import { createSubmission } from '../services/records.js';

const tokenParam = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });

/** The anonymous submitter: no groups, may only create. */
const publicPrincipal = (wf: LoadedWorkflow): AuthUser => ({
  userId: 'public-form',
  orgId: wf.orgId,
  homeOrgId: wf.orgId,
  email: 'public-form',
  name: 'Public form',
  groups: [],
  capabilities: new Set<Capability>(['CREATE']),
  rowFilter: null,
});

async function publicFlow(token: string) {
  const hit = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Workflow" WHERE "deletedAt" IS NULL AND "definition"->'stages'->0->>'publicFormId' = ${token} LIMIT 1`;
  const wf = hit[0] ? await loadWorkflow(prisma, { id: hit[0].id }) : null;
  const intake = wf?.def.stages[0];
  // Same answer for "no such form" and "switched off", so links can not be probed.
  if (!wf || !intake?.publicForm || intake.publicFormId !== token || !wf.isActive || wf.isDraft || wf.deletedAt || !wf.orgLive) throw AppError.notFound('Form');
  return wf;
}

function publicFields(wf: LoadedWorkflow) {
  const intake = wf.def.stages[0]!;
  const editable = editableFieldKeys(wf.def.fields, publicPrincipal(wf), wf.def.stages);
  return wf.def.fields.filter((f) => f.stageKey === intake.key && editable.has(f.key) && f.type !== 'file' && f.type !== 'computed' && f.type !== 'user-email');
}

export default async function publicRoutes(app: FastifyInstance) {
  app.get('/public/forms/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = parse(tokenParam, req.params);
    const wf = await publicFlow(token);
    const intake = wf.def.stages[0]!;
    return {
      name: wf.name,
      description: wf.def.description ?? null,
      timezone: wf.calendar.config.timezone,
      stage: { name: intake.name, description: intake.description ?? null, video: intake.video ?? null, thankYou: intake.showThankYou ? intake.thankYouText || null : null },
      fields: publicFields(wf).map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        stageKey: f.stageKey,
        required: f.required,
        unique: f.unique,
        searchKey: false,
        frozen: false,
        lineItem: f.lineItem,
        options: wf.options.get(f.key) ?? f.options,
        dependsOn: f.dependsOn,
        dependsOnLabel: f.dependsOn ? wf.def.fields.find((x) => x.key === f.dependsOn)?.label : undefined,
        optionMap: f.optionMap,
        helpText: f.helpText,
        placeholder: f.placeholder,
        defaultValue: f.defaultValue,
        canEdit: true,
      })),
    };
  });

  app.post('/public/forms/:token', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = parse(tokenParam, req.params);
    const body = parse(z.object({ data: z.record(z.unknown()).default({}), items: z.array(z.record(z.unknown())).max(50).optional() }), req.body);
    const wf = await publicFlow(token);
    const allowed = new Set(publicFields(wf).map((f) => f.key));
    const strip = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([k]) => allowed.has(k)));
    const records = await createSubmission(publicPrincipal(wf), wf, { data: strip(body.data), items: body.items?.map(strip) }, req.ip);
    reply.code(201);
    // Only the record numbers: a public submitter never reads data back.
    return { numbers: records.map((r) => r.number), thankYou: wf.def.stages[0]!.showThankYou ? wf.def.stages[0]!.thankYouText || null : null };
  });
}
