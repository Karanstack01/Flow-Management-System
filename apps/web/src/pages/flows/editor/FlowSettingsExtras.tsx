/**
 * Flow settings sections: scheduled reports (legacy Rep_* PDFs), the records table (default sort and
 * row colours) and AI reports.
 */
import clsx from 'clsx';
import { Brain, Palette, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { REPORT_KINDS, type ReportKind, type WorkflowDef, type WorkflowSettings } from '@fms/core';
import { ConditionEditor } from '../../../components/ConditionEditor';
import { Button, Checkbox, Input, Select, Switch, Textarea } from '../../../components/ui';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[\d\s()-]{6,20}$/;
const split = (s: string) => s.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'r_$1').slice(0, 40) || 'report';

/** A comma list (emails or phone numbers) typed freely, checked, and saved on blur. */
export function ListInput({ value, onChange, kind, placeholder, label }: { value: string[]; onChange: (v: string[]) => void; kind: 'email' | 'phone'; placeholder: string; label: string }) {
  const saved = value.join(', ');
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  const bad = split(text).filter((x) => !(kind === 'email' ? EMAIL : PHONE).test(x));
  return (
    <div>
      <Input aria-label={label} className={clsx('h-9', bad.length > 0 && 'border-danger')} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(split(text).filter((x) => !bad.includes(x)))} />
      {bad.length > 0 && <p className="mt-1 text-[11px] text-danger">{kind === 'email' ? 'Not an email address' : 'Not a phone number (digits with country code)'}: {bad.join(', ')}</p>}
    </div>
  );
}

export const REPORT_LABEL: Record<ReportKind, { title: string; hint: string }> = {
  summary: { title: 'Stage summary', hint: 'Open, overdue and finished per step' },
  pending: { title: 'Pending tasks', hint: 'Every open task with its due time' },
  funnel: { title: 'On-time funnel', hint: 'Done on time / late, overdue, upcoming per step' },
  matrix: { title: 'Status matrix', hint: 'Each open record × each step: done / pending' },
  missing: { title: 'Fields still empty', hint: 'Which fields are still blank at the current step' },
};

// ------------------------------------------------------------------ scheduled reports
export function ScheduledReports({ s, def, onSettings }: { s: WorkflowSettings; def: WorkflowDef; onSettings: (s: WorkflowSettings) => void }) {
  const r = s.summaryReport;
  const set = (patch: Partial<WorkflowSettings['summaryReport']>) => onSettings({ ...s, summaryReport: { ...r, ...patch } });
  const hours = r.hours.length ? r.hours : [r.hour];
  const setHours = (h: number[]) => set({ hours: [...new Set(h)].sort((a, b) => a - b), hour: h[0] ?? r.hour });
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1.5 text-[12px] font-medium">Send at</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {hours.map((h, i) => (
            <span key={i} className="inline-flex items-center gap-0.5">
              <Select aria-label={`Send time ${i + 1}`} className="h-8 w-24 text-[13px]" value={h} onChange={(e) => setHours(hours.map((x, j) => (j === i ? Number(e.target.value) : x)))}>
                {Array.from({ length: 24 }, (_, k) => (
                  <option key={k} value={k}>
                    {String(k).padStart(2, '0')}:00
                  </option>
                ))}
              </Select>
              {hours.length > 1 && <Button size="xs" variant="ghost" aria-label={`Remove send time ${i + 1}`} icon={<Trash2 />} onClick={() => setHours(hours.filter((_, j) => j !== i))} />}
            </span>
          ))}
          {hours.length < 4 && (
            <Button size="xs" variant="soft" icon={<Plus />} onClick={() => setHours([...hours, Math.min(23, (hours[hours.length - 1] ?? 9) + 3)])}>
              Time
            </Button>
          )}
        </div>
        <p className="mt-1 text-[11px] text-muted">Up to four times a day, in the flow’s calendar timezone.</p>
      </div>
      <div>
        <p className="mb-1.5 text-[12px] font-medium">Reports</p>
        <div className="grid gap-1.5 @md:grid-cols-2">
          {REPORT_KINDS.map((k) => (
            <Checkbox
              key={k}
              label={REPORT_LABEL[k].title}
              hint={REPORT_LABEL[k].hint}
              checked={r.reports.includes(k)}
              onChange={(on) => {
                const next = on ? [...r.reports, k] : r.reports.filter((x) => x !== k);
                if (next.length) set({ reports: next });
              }}
            />
          ))}
        </div>
        {r.reports.includes('missing') && (
          <Select aria-label="Step for the empty-fields report" className="mt-2 h-8 text-[13px]" value={r.missingStage ?? ''} onChange={(e) => set({ missingStage: e.target.value || undefined })}>
            <option value="">Empty fields: at each record’s current step</option>
            {def.stages.slice(1).map((st) => (
              <option key={st.key} value={st.key}>
                Empty fields: only “{st.name}”
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className="grid gap-2">
        <ListInput label="Report recipients" kind="email" value={r.recipients} onChange={(v) => set({ recipients: v })} placeholder="To: manager@company.com, owner@company.com" />
        <ListInput label="Report copy to" kind="email" value={r.cc} onChange={(v) => set({ cc: v })} placeholder="Cc (optional)" />
        <ListInput label="Report WhatsApp numbers" kind="phone" value={r.whatsapp} onChange={(v) => set({ whatsapp: v })} placeholder="WhatsApp: 91XXXXXXXXXX (optional)" />
      </div>
      <label className="flex items-center gap-2.5 text-[13px]">
        <Switch size="sm" label="Attach as PDF" checked={r.pdf} onChange={(v) => set({ pdf: v })} />
        Attach the reports as a PDF (email). WhatsApp gets a short text summary with a link.
      </label>
    </div>
  );
}

// ------------------------------------------------------------------ records table
export function TableSettings({ s, def, onSettings }: { s: WorkflowSettings; def: WorkflowDef; onSettings: (s: WorkflowSettings) => void }) {
  const t = s.table;
  const set = (patch: Partial<WorkflowSettings['table']>) => onSettings({ ...s, table: { ...t, ...patch } });
  const fields = def.fields.map((f) => ({ key: f.key, label: f.label, options: f.options }));
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-[12px] font-medium">Default sort</p>
        <div className="flex flex-wrap gap-2">
          <Select aria-label="Default sort column" className="h-9 min-w-0 flex-1 text-[13px]" value={t.defaultSort?.by ?? ''} onChange={(e) => set({ defaultSort: e.target.value ? { by: e.target.value, dir: t.defaultSort?.dir ?? 'desc' } : undefined })}>
            <option value="">Record number (newest first)</option>
            <option value="createdAt">Created</option>
            <option value="updatedAt">Last updated</option>
            {def.fields
              .filter((f) => f.type !== 'file')
              .map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
          </Select>
          {t.defaultSort && (
            <Select aria-label="Default sort direction" className="h-9 w-auto text-[13px]" value={t.defaultSort.dir} onChange={(e) => set({ defaultSort: { ...t.defaultSort!, dir: e.target.value as 'asc' | 'desc' } })}>
              <option value="asc">Ascending (A→Z, oldest, smallest)</option>
              <option value="desc">Descending (Z→A, newest, largest)</option>
            </Select>
          )}
        </div>
        <p className="mt-1 text-[11px] text-muted">How the records list opens. Clicking a column header still re-sorts.</p>
      </div>

      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium">
          <Palette className="size-3.5 text-muted" /> Row colours
        </p>
        <div className="space-y-2">
          {t.rowColors.map((rule, i) => (
            <div key={i} className="space-y-2 rounded-xl border border-line bg-surface p-2.5" style={{ boxShadow: `inset 3px 0 0 ${rule.color}` }}>
              <div className="flex items-center gap-2">
                <input type="color" aria-label={`Colour ${i + 1}`} value={rule.color} onChange={(e) => set({ rowColors: t.rowColors.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) })} className="h-8 w-10 cursor-pointer rounded-lg border border-line bg-transparent" />
                <Input className="h-8 text-[13px]" placeholder="Label shown on hover, e.g. Urgent" value={rule.label ?? ''} onChange={(e) => set({ rowColors: t.rowColors.map((x, j) => (j === i ? { ...x, label: e.target.value || undefined } : x)) })} />
                <Button size="xs" variant="ghost" aria-label={`Remove colour rule ${i + 1}`} icon={<Trash2 />} onClick={() => set({ rowColors: t.rowColors.filter((_, j) => j !== i) })} />
              </div>
              <ConditionEditor fields={fields} value={rule.when} onChange={(when) => set({ rowColors: t.rowColors.map((x, j) => (j === i ? { ...x, when } : x)) })} />
            </div>
          ))}
          {t.rowColors.length < 20 && (
            <Button size="xs" variant="soft" icon={<Plus />} onClick={() => set({ rowColors: [...t.rowColors, { color: '#f59e0b', when: { mode: 'all', conditions: [] } }] })}>
              Add a colour rule
            </Button>
          )}
          <p className="text-[11px] text-muted">The first rule that matches colours the row. A rule needs at least one condition; rules on fields a user can not see are skipped for them.</p>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ AI reports
export function AiReports({ s, def, onSettings }: { s: WorkflowSettings; def: WorkflowDef; onSettings: (s: WorkflowSettings) => void }) {
  const list = s.aiReports;
  const set = (next: WorkflowSettings['aiReports']) => onSettings({ ...s, aiReports: next });
  const patch = (i: number, p: Partial<WorkflowSettings['aiReports'][number]>) => set(list.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const fields = def.fields.map((f) => ({ key: f.key, label: f.label, options: f.options }));
  return (
    <div className="space-y-2">
      {list.map((r, i) => (
        <div key={r.key} className="space-y-2.5 rounded-xl border border-line bg-surface p-3">
          <div className="flex items-center gap-2">
            <Switch size="sm" label={`${r.name} on`} checked={r.enabled} onChange={(v) => patch(i, { enabled: v })} />
            <Input className="h-8 text-[13px] font-medium" value={r.name} onChange={(e) => patch(i, { name: e.target.value })} aria-label="Report name" />
            <Button size="xs" variant="ghost" aria-label={`Remove ${r.name}`} icon={<Trash2 />} onClick={() => set(list.filter((_, j) => j !== i))} />
          </div>
          <Textarea className="min-h-20 text-[13px]" value={r.prompt} placeholder="e.g. Summarise today’s delayed orders by customer and suggest who to follow up first." onChange={(e) => patch(i, { prompt: e.target.value })} aria-label="Prompt" />
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Records to include</p>
            <ConditionEditor fields={fields} value={r.when} onChange={(when) => patch(i, { when })} />
          </div>
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Fields to send ({r.fields.length ? r.fields.length : 'all visible'})</p>
            <div className="flex max-h-28 flex-wrap gap-x-3 gap-y-1 overflow-y-auto">
              {def.fields
                .filter((f) => f.type !== 'file')
                .map((f) => (
                  <Checkbox key={f.key} label={f.label} checked={r.fields.includes(f.key)} onChange={(on) => patch(i, { fields: on ? [...r.fields, f.key] : r.fields.filter((k) => k !== f.key) })} />
                ))}
            </div>
          </div>
          <label className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
            Every
            <Select aria-label="How often" className="h-8 w-auto text-[13px]" value={r.everyHours} onChange={(e) => patch(i, { everyHours: Number(e.target.value) })}>
              {[1, 2, 4, 6, 12, 24, 48, 168].map((h) => (
                <option key={h} value={h}>
                  {h === 168 ? 'week' : h === 24 ? 'day' : h === 48 ? '2 days' : `${h} hour${h === 1 ? '' : 's'}`}
                </option>
              ))}
            </Select>
          </label>
          <ListInput label="AI report recipients" kind="email" value={r.recipients} onChange={(v) => patch(i, { recipients: v })} placeholder="Email to: manager@company.com" />
          <ListInput label="AI report WhatsApp" kind="phone" value={r.whatsapp} onChange={(v) => patch(i, { whatsapp: v })} placeholder="WhatsApp: 91XXXXXXXXXX (optional)" />
        </div>
      ))}
      {list.length < 10 && (
        <Button
          size="xs"
          variant="soft"
          icon={<Brain />}
          onClick={() => {
            let key = slug(`report ${list.length + 1}`);
            while (list.some((x) => x.key === key)) key = `${key}_x`;
            set([...list, { key, name: `AI report ${list.length + 1}`, enabled: true, prompt: 'Summarise these records: what is late, what needs attention today, and who should act.', when: { mode: 'all', conditions: [] }, fields: [], everyHours: 24, recipients: [], whatsapp: [] }]);
          }}
        >
          Add an AI report
        </Button>
      )}
      <p className="text-[11px] text-muted">Uses the organization’s AI connection (Settings › Connections). Only the chosen fields of matching records are sent, at most 200 records per run.</p>
    </div>
  );
}
