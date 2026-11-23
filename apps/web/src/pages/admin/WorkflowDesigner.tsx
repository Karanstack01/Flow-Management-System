import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2, UploadCloud } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  FIELD_TYPES,
  normalizeGuard,
  workflowDefSchema,
  workflowSettingsSchema,
  type ConditionGroup,
  type FieldDef,
  type FieldType,
  type StageDef,
  type WorkflowDef,
  type WorkflowSettings,
} from '@fms/core';
import { ConditionEditor } from '../../components/ConditionEditor';
import { Button, Card, FormField, Input, PageHeader, Select, Spinner, Tabs, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { useWorkflows } from '../../lib/queries';

const EMPTY: ConditionGroup = { mode: 'all', conditions: [] };
const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 64) || 'field';
const groupsText = (g: string[]) => g.join(', ');
const parseGroups = (s: string) => s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);

function newStage(n: number): StageDef {
  return { key: `stage_${n}`, name: `Stage ${n}`, color: '#64748b', responsibleGroups: [], planned: { mode: 'tat', base: { kind: 'previous_stage' }, tat: { kind: 'fixed', hours: 8 } }, completion: { kind: 'manual' } };
}
function newField(stageKey: string, n: number): FieldDef {
  return { key: `field_${n}`, label: `Field ${n}`, type: 'text', stageKey, required: false, unique: false, hidden: false, searchKey: false, frozen: false, lineItem: false, viewGroups: ['ALL'], editGroups: ['ALL'] };
}
const blankWorkflow = (): WorkflowDef => ({
  key: 'new_workflow',
  name: 'New workflow',
  stages: [{ key: 'intake', name: 'Intake', color: '#2563eb', responsibleGroups: [], planned: { mode: 'none' }, completion: { kind: 'on_create' } }, newStage(2)],
  fields: [newField('intake', 1)],
});

interface Loaded {
  id: string;
  version: number;
  calendarId: string;
  isActive: boolean;
  definition: WorkflowDef;
  settings: WorkflowSettings;
}

export default function WorkflowDesigner() {
  const { data: workflows } = useWorkflows();
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<string>(params.get('wf') ?? '');
  useEffect(() => {
    if (!selected && workflows?.length) setSelected(workflows[0]!.key);
  }, [workflows, selected]);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Form editor (advanced)"
        subtitle="Every stage and field setting as a form, plus the raw JSON. For the visual node editor, open a flow from All Flows."
        actions={
          <Select className="w-auto" value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Workflow">
            {workflows?.map((w) => (
              <option key={w.key} value={w.key}>
                {w.name}
              </option>
            ))}
            <option value="__new">+ New workflow</option>
          </Select>
        }
      />
      {selected === '__new' ? <Editor key="new" initial={null} onCreated={setSelected} /> : selected ? <LoadedEditor key={selected} wfKey={selected} /> : <Spinner />}
    </div>
  );
}

function LoadedEditor({ wfKey }: { wfKey: string }) {
  const { data, error } = useQuery({ queryKey: ['definition', wfKey], queryFn: () => api<Loaded>(`/workflows/${wfKey}/definition`) });
  if (error) return <p className="text-danger">{(error as Error).message}</p>;
  if (!data) return <Spinner />;
  // Never render a definition the schema rejects — show why instead of crashing.
  const def = workflowDefSchema.safeParse(data.definition);
  const set = workflowSettingsSchema.safeParse(data.settings ?? {});
  if (!def.success || !set.success) {
    const issues = [...(def.success ? [] : def.error.issues), ...(set.success ? [] : set.error.issues)].slice(0, 6);
    return (
      <div className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
        <p className="font-medium">This flow’s saved definition is not valid, so it can’t be edited here.</p>
        <ul className="mt-2 list-disc pl-5">
          {issues.map((i, n) => (
            <li key={n}>
              {i.path.join('.')}: {i.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return <Editor key={data.version} initial={{ ...data, definition: def.data, settings: set.data }} />;
}

function Editor({ initial, onCreated }: { initial: Loaded | null; onCreated?: (key: string) => void }) {
  const qc = useQueryClient();
  const [def, setDef] = useState<WorkflowDef>(initial?.definition ?? blankWorkflow());
  const [settings, setSettings] = useState<WorkflowSettings>(initial?.settings ?? workflowSettingsSchema.parse({}));
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [calendarId, setCalendarId] = useState(initial?.calendarId ?? '');
  const [tab, setTab] = useState<'stages' | 'fields' | 'automation' | 'json'>('stages');
  const [busy, setBusy] = useState(false);
  const calendars = useQuery({ queryKey: ['calendars'], queryFn: () => api<{ items: { id: string; name: string }[] }>('/admin/calendars').then((r) => r.items) });
  useEffect(() => {
    if (!calendarId && calendars.data?.length) setCalendarId(calendars.data[0]!.id);
  }, [calendars.data, calendarId]);

  const issues = useMemo(() => {
    const out: string[] = [];
    const a = workflowDefSchema.safeParse(def);
    if (!a.success) out.push(...a.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    const b = workflowSettingsSchema.safeParse(settings);
    if (!b.success) out.push(...b.error.issues.map((i) => `settings.${i.path.join('.')}: ${i.message}`));
    return out;
  }, [def, settings]);

  const patchStage = (i: number, patch: Partial<StageDef>) => setDef((d) => ({ ...d, stages: d.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const patchField = (i: number, patch: Partial<FieldDef>) => setDef((d) => ({ ...d, fields: d.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  const move = <T,>(arr: T[], i: number, dir: -1 | 1) => {
    const next = [...arr];
    const j = i + dir;
    if (j < 0 || j >= next.length) return arr;
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  };
  const conditionFields = def.fields.map((f) => ({ key: f.key, label: f.label, options: f.options }));

  async function publish() {
    setBusy(true);
    try {
      if (initial) {
        const r = await api<{ version: number }>(`/workflows/${def.key}/definition`, { method: 'PUT', body: { definition: def, settings, calendarId, isActive } });
        toast.success(`Published version ${r.version}`);
      } else {
        await api('/workflows', { method: 'POST', body: { definition: def, settings, calendarId } });
        toast.success('Workflow created');
        onCreated?.(def.key);
      }
      void qc.invalidateQueries();
    } catch (e) {
      const details = (e as { details?: Record<string, string> }).details;
      toast.error((e as Error).message, { description: details ? Object.entries(details).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join('\n') : undefined });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <FormField label="Name">
            <Input value={def.name} onChange={(e) => setDef({ ...def, name: e.target.value })} />
          </FormField>
          <FormField label="Key" hint={initial ? 'Cannot change after creation' : 'Used in URLs'}>
            <Input value={def.key} disabled={!!initial} onChange={(e) => setDef({ ...def, key: slug(e.target.value) })} />
          </FormField>
          <FormField label="Business calendar">
            <Select value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
              {calendars.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Status">
            <Select value={isActive ? '1' : '0'} onChange={(e) => setIsActive(e.target.value === '1')} disabled={!initial}>
              <option value="1">Active</option>
              <option value="0">Inactive (read-only)</option>
            </Select>
          </FormField>
          <FormField label="Description" className="md:col-span-4">
            <Input value={def.description ?? ''} onChange={(e) => setDef({ ...def, description: e.target.value || undefined })} />
          </FormField>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: 'stages', label: `Stages (${def.stages.length})` },
            { value: 'fields', label: `Fields (${def.fields.length})` },
            { value: 'automation', label: 'Automation' },
            { value: 'json', label: 'JSON' },
          ]}
        />
        <Button variant="primary" icon={<UploadCloud className="size-4" />} disabled={issues.length > 0} loading={busy} onClick={() => void publish()}>
          {initial ? `Publish v${initial.version + 1}` : 'Create workflow'}
        </Button>
      </div>

      {issues.length > 0 && (
        <div className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
          <p className="font-medium">Fix before publishing:</p>
          <ul className="list-disc pl-5">
            {issues.slice(0, 8).map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {tab === 'stages' && (
        <div className="space-y-3">
          {def.stages.map((s, i) => (
            <StageEditor
              key={i}
              stage={s}
              index={i}
              fields={conditionFields}
              onChange={(p) => patchStage(i, p)}
              onMove={(dir) => setDef({ ...def, stages: move(def.stages, i, dir) })}
              onRemove={() => setDef({ ...def, stages: def.stages.filter((_, j) => j !== i) })}
            />
          ))}
          <Button icon={<Plus className="size-4" />} onClick={() => setDef({ ...def, stages: [...def.stages, newStage(def.stages.length + 1)] })}>
            Add stage
          </Button>
        </div>
      )}

      {tab === 'fields' && (
        <Card bodyClassName="p-0">
          <div className="divide-y divide-line">
            {def.fields.map((f, i) => (
              <FieldEditor
                key={i}
                field={f}
                stages={def.stages}
                allFields={def.fields}
                onChange={(p) => patchField(i, p)}
                onMove={(dir) => setDef({ ...def, fields: move(def.fields, i, dir) })}
                onRemove={() => setDef({ ...def, fields: def.fields.filter((_, j) => j !== i) })}
              />
            ))}
          </div>
          <div className="p-3">
            <Button icon={<Plus className="size-4" />} onClick={() => setDef({ ...def, fields: [...def.fields, newField(def.stages[0]!.key, def.fields.length + 1)] })}>
              Add field
            </Button>
          </div>
        </Card>
      )}

      {tab === 'automation' && <SettingsEditor settings={settings} onChange={setSettings} fields={conditionFields} />}

      {tab === 'json' && <JsonEditor value={{ definition: def, settings }} onApply={(v) => (setDef(v.definition), setSettings(v.settings))} />}
    </div>
  );
}

function StageEditor({ stage: s, index, fields, onChange, onMove, onRemove }: { stage: StageDef; index: number; fields: { key: string; label: string; options?: string[] }[]; onChange: (p: Partial<StageDef>) => void; onMove: (d: -1 | 1) => void; onRemove: () => void }) {
  const intake = index === 0;
  const tat = s.planned.mode === 'tat' ? s.planned : null;
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="size-3 rounded-sm" style={{ background: s.color }} />
          {index + 1}. {s.name} {intake && <span className="text-xs font-normal text-muted">(intake)</span>}
        </span>
      }
      actions={
        <>
          <Button size="sm" variant="ghost" aria-label="Move up" icon={<ArrowUp className="size-4" />} onClick={() => onMove(-1)} />
          <Button size="sm" variant="ghost" aria-label="Move down" icon={<ArrowDown className="size-4" />} onClick={() => onMove(1)} />
          {!intake && <Button size="sm" variant="ghost" aria-label="Remove stage" icon={<Trash2 className="size-4" />} onClick={onRemove} />}
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <FormField label="Name">
          <Input value={s.name} onChange={(e) => onChange({ name: e.target.value })} />
        </FormField>
        <FormField label="Key">
          <Input value={s.key} onChange={(e) => onChange({ key: slug(e.target.value) })} />
        </FormField>
        <FormField label="Colour">
          <Input type="color" className="h-9 p-1" value={s.color} onChange={(e) => onChange({ color: e.target.value })} />
        </FormField>
        <FormField label="Responsible groups" hint="Comma separated">
          <Input value={groupsText(s.responsibleGroups)} onChange={(e) => onChange({ responsibleGroups: parseGroups(e.target.value) })} />
        </FormField>
      </div>
      {!intake && (
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-md border border-line p-3">
            <p className="text-sm font-medium">Planned time</p>
            <Select
              value={s.planned.mode}
              onChange={(e) => {
                const mode = e.target.value as StageDef['planned']['mode'];
                onChange({ planned: mode === 'tat' ? { mode, base: { kind: 'previous_stage' }, tat: { kind: 'fixed', hours: 8 } } : { mode } });
              }}
            >
              <option value="tat">TAT — working hours after a base time</option>
              <option value="manual">Entered manually by the owner</option>
              <option value="none">No planned time</option>
            </Select>
            {tat && (
              <div className="grid grid-cols-2 gap-2">
                <FormField label="Counted from">
                  <Select
                    value={tat.base.kind === 'field' ? `field:${tat.base.field}` : tat.base.kind}
                    onChange={(e) => {
                      const v = e.target.value;
                      onChange({ planned: { ...tat, base: v.startsWith('field:') ? { kind: 'field', field: v.slice(6) } : { kind: v as 'previous_stage' | 'created' } } });
                    }}
                  >
                    <option value="previous_stage">Previous stage done</option>
                    <option value="created">Record created</option>
                    {fields.map((f) => (
                      <option key={f.key} value={`field:${f.key}`}>
                        Date field: {f.label}
                      </option>
                    ))}
                  </Select>
                </FormField>
                {tat.tat.kind === 'fixed' ? (
                  <FormField label="TAT (working hours)" hint="Negative = before the base time">
                    <Input type="number" step="any" value={tat.tat.hours} onChange={(e) => onChange({ planned: { ...tat, tat: { kind: 'fixed', hours: Number(e.target.value) } } })} />
                  </FormField>
                ) : (
                  <FormField label="Default hours">
                    <Input type="number" step="any" value={tat.tat.defaultHours ?? ''} onChange={(e) => tat.tat.kind === 'by_field' && onChange({ planned: { ...tat, tat: { ...tat.tat, defaultHours: e.target.value === '' ? undefined : Number(e.target.value) } } })} />
                  </FormField>
                )}
                <label className="col-span-2 inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={tat.tat.kind === 'by_field'}
                    onChange={(e) => onChange({ planned: { ...tat, tat: e.target.checked ? { kind: 'by_field', field: fields[0]?.key ?? 'field', map: {}, defaultHours: 8 } : { kind: 'fixed', hours: 8 } } })}
                  />
                  TAT depends on a field value (e.g. Priority)
                </label>
                {tat.tat.kind === 'by_field' && (
                  <>
                    <FormField label="Field">
                      <Select value={tat.tat.field} onChange={(e) => tat.tat.kind === 'by_field' && onChange({ planned: { ...tat, tat: { ...tat.tat, field: e.target.value } } })}>
                        {fields.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                    <FormField label="Hours per value" hint="One per line: Value = hours">
                      <Textarea
                        defaultValue={Object.entries(tat.tat.map).map(([k, v]) => `${k} = ${v}`).join('\n')}
                        onBlur={(e) => {
                          const map = Object.fromEntries(
                            e.target.value
                              .split('\n')
                              .map((l) => l.split('='))
                              .filter((p) => p.length === 2 && p[0]!.trim() && Number.isFinite(Number(p[1])))
                              .map((p) => [p[0]!.trim(), Number(p[1])]),
                          );
                          if (tat.tat.kind === 'by_field') onChange({ planned: { ...tat, tat: { ...tat.tat, map } } });
                        }}
                      />
                    </FormField>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="space-y-3 rounded-md border border-line p-3">
            <p className="text-sm font-medium">Completion</p>
            <Select value={s.completion.kind} onChange={(e) => onChange({ completion: e.target.value === 'conditions' ? { kind: 'conditions', when: EMPTY } : { kind: 'manual' } })}>
              <option value="manual">Owner clicks “Mark done”</option>
              <option value="conditions">Automatically when conditions are met</option>
            </Select>
            {s.completion.kind === 'conditions' && <ConditionEditor fields={fields} value={s.completion.when} onChange={(when) => onChange({ completion: { kind: 'conditions', when } })} />}
            <label className="inline-flex items-center gap-2 pt-2 text-sm">
              <input type="checkbox" checked={!!s.applicableWhen} onChange={(e) => onChange({ applicableWhen: e.target.checked ? EMPTY : undefined })} />
              Only applies when…
            </label>
            {s.applicableWhen && <ConditionEditor fields={fields} value={s.applicableWhen} onChange={(applicableWhen) => onChange({ applicableWhen })} />}
            {!!s.guards?.length && (
              <div className="rounded-xl bg-info-soft px-3 py-2 text-xs text-info">
                <p className="font-medium">On a Depends-on path (edit in the flow editor)</p>
                {s.guards.map(normalizeGuard).map((g, gi) => {
                  const text = (w: ConditionGroup) => w.conditions.map((c) => `${fields.find((f) => f.key === c.field)?.label ?? c.field} ${c.op} ${Array.isArray(c.value) ? c.value.join(', ') : (c.value ?? '')}`).join(w.mode === 'all' ? ' and ' : ' or ');
                  return (
                    <p key={gi} className="mt-0.5">
                      {g.take === 'else' ? `Otherwise (none of: ${g.cases.map(text).join(' / ')})` : `Path ${g.take + 1}: ${text(g.cases[g.take]!)}`}
                    </p>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function FieldEditor({ field: f, stages, allFields, onChange, onMove, onRemove }: { field: FieldDef; stages: StageDef[]; allFields: FieldDef[]; onChange: (p: Partial<FieldDef>) => void; onMove: (d: -1 | 1) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const choice = ['select', 'multiselect', 'combobox'].includes(f.type);
  const flags: [keyof FieldDef, string][] = [
    ['required', 'Required'],
    ['unique', 'Unique'],
    ['hidden', 'Hidden'],
    ['searchKey', 'Title'],
    ['frozen', 'Pinned'],
    ['lineItem', 'Line item'],
  ];
  return (
    <div className="p-3">
      <div className="grid grid-cols-1 items-end gap-2 md:grid-cols-[auto_1.4fr_1fr_1fr_1fr_auto]">
        <button type="button" className="self-center text-muted" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <FormField label="Label">
          <Input value={f.label} onChange={(e) => onChange({ label: e.target.value })} />
        </FormField>
        <FormField label="Key">
          <Input value={f.key} onChange={(e) => onChange({ key: slug(e.target.value) })} />
        </FormField>
        <FormField label="Type">
          <Select value={f.type} onChange={(e) => onChange({ type: e.target.value as FieldType })}>
            {FIELD_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </FormField>
        <FormField label="Stage">
          <Select value={f.stageKey} onChange={(e) => onChange({ stageKey: e.target.value })}>
            {stages.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="flex">
          <Button size="sm" variant="ghost" aria-label="Move up" icon={<ArrowUp className="size-4" />} onClick={() => onMove(-1)} />
          <Button size="sm" variant="ghost" aria-label="Move down" icon={<ArrowDown className="size-4" />} onClick={() => onMove(1)} />
          <Button size="sm" variant="ghost" aria-label="Remove field" icon={<Trash2 className="size-4" />} onClick={onRemove} />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 pl-6 text-sm">
        {flags.map(([k, label]) => (
          <label key={k} className="inline-flex items-center gap-1.5 text-muted">
            <input type="checkbox" checked={!!f[k]} onChange={(e) => onChange({ [k]: e.target.checked } as Partial<FieldDef>)} /> {label}
          </label>
        ))}
      </div>
      {open && (
        <div className="mt-3 grid grid-cols-1 gap-3 pl-6 md:grid-cols-2">
          {choice && (
            <FormField label="Options" hint="Comma separated (or use an option set)">
              <Input defaultValue={(f.options ?? []).join(', ')} onBlur={(e) => onChange({ options: e.target.value ? e.target.value.split(',').map((x) => x.trim()).filter(Boolean) : undefined })} />
            </FormField>
          )}
          {choice && (
            <FormField label="Option set key" hint="Admin-managed list (Calendars & lists)">
              <Input value={f.optionSetKey ?? ''} onChange={(e) => onChange({ optionSetKey: e.target.value ? slug(e.target.value) : undefined })} />
            </FormField>
          )}
          {f.type === 'dependent-select' && (
            <>
              <FormField label="Depends on">
                <Select value={f.dependsOn ?? ''} onChange={(e) => onChange({ dependsOn: e.target.value || undefined })}>
                  <option value="">—</option>
                  {allFields.filter((x) => x.key !== f.key).map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.label}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="Options per parent value" hint="Parent: a, b, c — one per line">
                <Textarea
                  defaultValue={Object.entries(f.optionMap ?? {}).map(([k, v]) => `${k}: ${v.join(', ')}`).join('\n')}
                  onBlur={(e) =>
                    onChange({
                      optionMap: Object.fromEntries(
                        e.target.value
                          .split('\n')
                          .filter((l) => l.includes(':'))
                          .map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).split(',').map((x) => x.trim()).filter(Boolean)]),
                      ),
                    })
                  }
                />
              </FormField>
            </>
          )}
          {f.type === 'computed' && (
            <FormField label="Expression" hint="Field keys with + − × ÷, round(), min(), max()">
              <Input value={f.expression ?? ''} placeholder="round(qty * rate, 2)" onChange={(e) => onChange({ expression: e.target.value || undefined })} />
            </FormField>
          )}
          <FormField label="Visible to groups" hint="ALL or comma separated">
            <Input value={groupsText(f.viewGroups)} onChange={(e) => onChange({ viewGroups: parseGroups(e.target.value) })} />
          </FormField>
          <FormField label="Editable by groups" hint="ALL or comma separated">
            <Input value={groupsText(f.editGroups)} onChange={(e) => onChange({ editGroups: parseGroups(e.target.value) })} />
          </FormField>
          <FormField label="Help text">
            <Input value={f.helpText ?? ''} onChange={(e) => onChange({ helpText: e.target.value || undefined })} />
          </FormField>
          <FormField label="Column width (px)">
            <Input type="number" value={f.width ?? ''} onChange={(e) => onChange({ width: e.target.value ? Number(e.target.value) : undefined })} />
          </FormField>
        </div>
      )}
    </div>
  );
}

function SettingsEditor({ settings: s, onChange, fields }: { settings: WorkflowSettings; onChange: (s: WorkflowSettings) => void; fields: { key: string; label: string; options?: string[] }[] }) {
  const toggle = (label: string, checked: boolean, set: (v: boolean) => void) => (
    <label className="inline-flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} /> {label}
    </label>
  );
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title="Delivery">
        <div className="space-y-2">
          {toggle('Email', s.channels.includes('email'), (v) => onChange({ ...s, channels: v ? [...new Set([...s.channels, 'email' as const])] : s.channels.filter((c) => c !== 'email') }))}
          <br />
          {toggle('WhatsApp', s.channels.includes('whatsapp'), (v) => onChange({ ...s, channels: v ? [...new Set([...s.channels, 'whatsapp' as const])] : s.channels.filter((c) => c !== 'whatsapp') }))}
          <br />
          {toggle('Send on holidays and weekly offs', s.sendOnHolidays, (v) => onChange({ ...s, sendOnHolidays: v }))}
        </div>
      </Card>
      <Card title="Task notifications">
        <div className="space-y-3">
          {toggle('Notify owners when a stage becomes active (hand-off)', s.handoff.enabled, (v) => onChange({ ...s, handoff: { enabled: v } }))}
          <div className="flex flex-wrap items-center gap-2">
            {toggle('Remind before due — working hours:', s.upcoming.enabled, (v) => onChange({ ...s, upcoming: { ...s.upcoming, enabled: v } }))}
            <Input type="number" className="w-24" min={0} value={s.upcoming.hoursBefore} onChange={(e) => onChange({ ...s, upcoming: { ...s.upcoming, hoursBefore: Number(e.target.value) } })} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {toggle('Daily overdue digest at hour:', s.overdueDigest.enabled, (v) => onChange({ ...s, overdueDigest: { ...s.overdueDigest, enabled: v } }))}
            <Input type="number" className="w-24" min={0} max={23} value={s.overdueDigest.hour} onChange={(e) => onChange({ ...s, overdueDigest: { ...s.overdueDigest, hour: Number(e.target.value) } })} />
          </div>
        </div>
      </Card>
      <Card title="Daily management summary">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {toggle('Email stage summary at hour:', s.summaryReport.enabled, (v) => onChange({ ...s, summaryReport: { ...s.summaryReport, enabled: v } }))}
            <Input type="number" className="w-24" min={0} max={23} value={s.summaryReport.hour} onChange={(e) => onChange({ ...s, summaryReport: { ...s.summaryReport, hour: Number(e.target.value) } })} />
          </div>
          <FormField label="Recipients" hint="Comma separated emails">
            <Input defaultValue={s.summaryReport.recipients.join(', ')} onBlur={(e) => onChange({ ...s, summaryReport: { ...s.summaryReport, recipients: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })} />
          </FormField>
        </div>
      </Card>
      <Card title="Auto-archive">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {toggle('Archive finished records after days:', s.archive.enabled, (v) => onChange({ ...s, archive: { ...s.archive, enabled: v } }))}
            <Input type="number" className="w-24" min={0} value={s.archive.completedDaysAgo} onChange={(e) => onChange({ ...s, archive: { ...s.archive, completedDaysAgo: Number(e.target.value) } })} />
          </div>
          <p className="text-xs text-muted">Optional extra conditions:</p>
          <ConditionEditor fields={fields} value={s.archive.when} onChange={(when) => onChange({ ...s, archive: { ...s.archive, when } })} />
        </div>
      </Card>
      <p className="text-xs text-muted lg:col-span-2">Outbound webhooks (legacy “post data”) are configured in the JSON tab under settings.webhooks.</p>
    </div>
  );
}

function JsonEditor({ value, onApply }: { value: { definition: WorkflowDef; settings: WorkflowSettings }; onApply: (v: { definition: WorkflowDef; settings: WorkflowSettings }) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="Definition JSON" actions={<Button onClick={() => {
      try {
        const parsed = JSON.parse(text) as { definition: unknown; settings: unknown };
        onApply({ definition: workflowDefSchema.parse(parsed.definition), settings: workflowSettingsSchema.parse(parsed.settings ?? {}) });
        setErr(null);
        toast.success('Applied — review and publish');
      } catch (e) {
        setErr((e as Error).message.slice(0, 600));
      }
    }}>Apply JSON</Button>}>
      {err && <p className="mb-2 whitespace-pre-wrap text-sm text-danger">{err}</p>}
      <Textarea className="min-h-[28rem] font-mono text-xs" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
    </Card>
  );
}
