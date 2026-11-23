/**
 * Per-field settings for a stage's form: name, type, placeholder, default, access control,
 * flags and a validation rule with an insert / examples / guide / test toolbar.
 */
import clsx from 'clsx';
import { BookOpen, Braces, ChevronDown, CircleAlert, CircleCheck, Database, FlaskConical, FunctionSquare, Lightbulb, Search, Trash2, UserPlus, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { checkRule, FIELD_TYPES, RULE_EXAMPLES, RULE_FUNCTIONS, RULE_RECORD_VALUES, ruleReferences, RuleError, type FieldDef, type FieldType, type RuleValue, type WorkflowDef } from '@fms/core';
import { Button, Input, Modal, Select, Textarea } from '../../../components/ui';

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: 'Short Text',
  textarea: 'Long Text',
  number: 'Number',
  email: 'Email',
  phone: 'Phone',
  date: 'Date',
  datetime: 'Date & Time',
  checkbox: 'Checkbox (Yes / No)',
  select: 'Dropdown',
  multiselect: 'Multi-select',
  combobox: 'Dropdown + free text',
  'dependent-select': 'Dependent Dropdown',
  file: 'File Upload',
  'user-email': 'Submitter’s Email (auto)',
  computed: 'Formula (calculated)',
};

const NO_PLACEHOLDER = new Set<FieldType>(['checkbox', 'date', 'datetime', 'computed', 'user-email']);
const NO_DEFAULT = new Set<FieldType>(['file', 'computed', 'user-email']);
const CHOICE = new Set<FieldType>(['select', 'multiselect', 'combobox']);
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export interface FieldSettingsProps {
  field: FieldDef;
  def: WorkflowDef;
  isIntake: boolean;
  /** The key is used by saved records and can not change. */
  locked: boolean;
  users: { name: string; email: string }[];
  groups: string[];
  onChange: (patch: Partial<FieldDef>) => void;
  /** Wide layout (full-screen editor). */
  wide?: boolean;
}

const Label = ({ children }: { children: ReactNode }) => <p className="mb-1.5 text-[13px] font-semibold text-fg">{children}</p>;

function Check({ checked, onChange, children, disabled, title }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <label className={clsx('inline-flex items-center gap-2 text-sm', disabled ? 'cursor-not-allowed text-muted' : 'cursor-pointer')} title={title}>
      <input type="checkbox" className="size-4 rounded accent-[var(--color-success)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export function FieldSettings({ field: f, def, isIntake, locked, users, groups, onChange, wide }: FieldSettingsProps) {
  const others = def.fields.filter((x) => x.key !== f.key);
  return (
    <div className="space-y-4">
      <div className={clsx('grid gap-4', wide ? 'grid-cols-2' : 'grid-cols-1')}>
        <div>
          <Label>Field Name</Label>
          <Input value={f.label} placeholder="e.g. Production Drawing" onChange={(e) => onChange({ label: e.target.value })} />
          <p className="mt-1 text-[11px] text-muted">
            Key <code className="rounded bg-surface-2 px-1">{f.key}</code>
            {locked ? ' · locked, records use it' : ' · set from the name when you leave the field'}
          </p>
        </div>
        <div>
          <Label>Field Type</Label>
          <Select value={f.type} onChange={(e) => onChange({ type: e.target.value as FieldType })}>
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </div>
        {!NO_PLACEHOLDER.has(f.type) && (
          <div>
            <Label>{f.type === 'file' ? 'Upload Button Text' : 'Placeholder Text'}</Label>
            <Input value={f.placeholder ?? ''} placeholder={f.type === 'file' ? 'e.g. Attach drawing' : 'Enter placeholder text'} onChange={(e) => onChange({ placeholder: e.target.value || undefined })} />
          </div>
        )}
        {!NO_DEFAULT.has(f.type) && (
          <div>
            <Label>Default Value</Label>
            <DefaultValue field={f} onChange={(v) => onChange({ defaultValue: v || undefined })} />
          </div>
        )}
      </div>

      {CHOICE.has(f.type) && (
        <div>
          <Label>Options</Label>
          <Textarea className="min-h-16" defaultValue={(f.options ?? []).join(', ')} placeholder="Option 1, Option 2, Option 3" onBlur={(e) => onChange({ options: list(e.target.value).length ? list(e.target.value) : undefined })} />
          <p className="mt-1 text-[11px] text-muted">Comma separated.</p>
        </div>
      )}
      {f.type === 'dependent-select' && (
        <div className="space-y-2">
          <div>
            <Label>Depends on</Label>
            <Select value={f.dependsOn ?? ''} onChange={(e) => onChange({ dependsOn: e.target.value || undefined })}>
              <option value="">— Choose the parent field —</option>
              {others
                .filter((x) => ['select', 'combobox', 'dependent-select'].includes(x.type))
                .map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.label}
                  </option>
                ))}
            </Select>
          </div>
          <div>
            <Label>Options per parent value</Label>
            <Textarea
              className="min-h-20 font-mono text-xs"
              placeholder={'Mumbai: Andheri, Bandra\nDelhi: Saket, Dwarka'}
              defaultValue={Object.entries(f.optionMap ?? {}).map(([k, v]) => `${k}: ${v.join(', ')}`).join('\n')}
              onBlur={(e) => {
                const map: Record<string, string[]> = {};
                for (const line of e.target.value.split('\n')) {
                  const i = line.indexOf(':');
                  if (i > 0) map[line.slice(0, i).trim()] = list(line.slice(i + 1));
                }
                onChange({ optionMap: Object.keys(map).length ? map : undefined });
              }}
            />
          </div>
        </div>
      )}
      {f.type === 'computed' && (
        <div>
          <Label>Formula</Label>
          <Input className="font-mono text-[13px]" value={f.expression ?? ''} placeholder="round(qty * rate, 2)" onChange={(e) => onChange({ expression: e.target.value || undefined })} />
          <p className="mt-1 text-[11px] text-muted">Number field keys with + − × ÷, round(), min(), max(), abs().</p>
        </div>
      )}

      <AccessControl field={f} users={users} groups={groups} onChange={onChange} wide={wide} />

      <div className="border-t border-dashed border-line pt-4">
        <div className="flex flex-wrap gap-x-5 gap-y-2.5">
          <Check checked={f.hidden} onChange={(v) => onChange({ hidden: v })}>
            Hidden field
          </Check>
          <Check checked={f.required} onChange={(v) => onChange({ required: v })}>
            Required field
          </Check>
          <Check
            checked={isIntake ? f.lineItem : false}
            disabled={!isIntake}
            title={isIntake ? 'Each row of the repeating table becomes its own record' : 'Repeating rows are available on the intake form (the first stage)'}
            onChange={(v) => onChange({ lineItem: v, inRepeatingTable: v })}
          >
            Include in repeating rows table
          </Check>
          <Check checked={f.unique} onChange={(v) => onChange({ unique: v })}>
            Unique
          </Check>
          <Check checked={f.searchKey} onChange={(v) => onChange({ searchKey: v })}>
            Record title
          </Check>
        </div>
        {!isIntake && <p className="mt-2 text-[11px] text-muted">Repeating rows are only available on the intake form.</p>}
      </div>

      {f.type === 'file' && (
        <div className="rounded-xl bg-surface-2 px-3.5 py-3">
          <Check checked={!!f.allowMultiple} onChange={(v) => onChange({ allowMultiple: v })}>
            Allow multiple files
          </Check>
        </div>
      )}

      <div>
        <Label>Help text</Label>
        <Input value={f.helpText ?? ''} placeholder="Shown under the field" onChange={(e) => onChange({ helpText: e.target.value || undefined })} />
      </div>

      {f.type !== 'computed' && f.type !== 'user-email' && <RuleEditor field={f} def={def} onChange={(v) => onChange({ validationRule: v || undefined })} />}
    </div>
  );
}

function DefaultValue({ field: f, onChange }: { field: FieldDef; onChange: (v: string) => void }) {
  const v = f.defaultValue ?? '';
  if (f.type === 'checkbox')
    return (
      <Select value={v} onChange={(e) => onChange(e.target.value)}>
        <option value="">No default</option>
        <option value="true">Checked (Yes)</option>
        <option value="false">Unchecked (No)</option>
      </Select>
    );
  if ((f.type === 'select' || f.type === 'combobox') && f.options?.length)
    return (
      <Select value={v} onChange={(e) => onChange(e.target.value)}>
        <option value="">No default</option>
        {f.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </Select>
    );
  if (f.type === 'date' || f.type === 'datetime')
    return (
      <div className="flex gap-2">
        <Input className="flex-1" value={v} placeholder={f.type === 'date' ? 'YYYY-MM-DD or TODAY' : 'YYYY-MM-DDTHH:mm or NOW'} onChange={(e) => onChange(e.target.value)} />
        <Button size="sm" className="h-10" onClick={() => onChange(f.type === 'date' ? 'TODAY' : 'NOW')}>
          {f.type === 'date' ? 'Today' : 'Now'}
        </Button>
      </div>
    );
  return <Input value={v} type={f.type === 'number' ? 'number' : 'text'} placeholder={f.type === 'multiselect' ? 'Option A, Option B' : 'Optional initial value'} onChange={(e) => onChange(e.target.value)} />;
}

// ------------------------------------------------------------------ access control
function GroupChips({ value, groups, onChange }: { value: string[]; groups: string[]; onChange: (v: string[]) => void }) {
  const all = value.includes('ALL');
  const chip = (on: boolean) => clsx('rounded-full border px-2.5 py-0.5 text-xs transition-colors', on ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-surface text-muted hover:text-fg');
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" className={chip(all)} aria-pressed={all} onClick={() => onChange(['ALL'])}>
        Everyone
      </button>
      {groups.map((g) => {
        const on = !all && value.includes(g);
        return (
          <button
            type="button"
            key={g}
            aria-pressed={on}
            className={chip(on)}
            onClick={() => {
              const next = all ? [g] : on ? value.filter((x) => x !== g) : [...value, g];
              onChange(next.length ? next : ['ALL']);
            }}
          >
            {g}
          </button>
        );
      })}
    </div>
  );
}

function AccessControl({ field: f, users, groups, onChange, wide }: { field: FieldDef; users: FieldSettingsProps['users']; groups: string[]; onChange: (p: Partial<FieldDef>) => void; wide?: boolean }) {
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<'Viewer' | 'Editor'>('Viewer');
  const assigned = f.fieldUsers ?? [];
  const available = users.filter((u) => !assigned.some((a) => a.email.toLowerCase() === u.email.toLowerCase()));
  const nameOf = (email: string) => users.find((u) => u.email.toLowerCase() === email.toLowerCase())?.name;
  const add = () => {
    const email = pick.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || assigned.some((a) => a.email.toLowerCase() === email)) return;
    onChange({ fieldUsers: [...assigned, { email, role }] });
    setPick('');
  };
  return (
    <div className="rounded-2xl border border-line bg-surface-2/60 p-3.5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm font-semibold">Field Access Control</p>
        <Check checked={!!f.fieldAccessRestricted} onChange={(v) => onChange({ fieldAccessRestricted: v })}>
          Allow only assigned users
        </Check>
      </div>
      {f.fieldAccessRestricted ? (
        <>
          <div className={clsx('gap-2', wide ? 'flex' : 'grid grid-cols-[1fr_auto]')}>
            {users.length ? (
              <Select className={clsx('min-w-0', wide ? 'flex-1' : 'col-span-2')} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="User">
                <option value="">Select user…</option>
                {available.map((u) => (
                  <option key={u.email} value={u.email}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </Select>
            ) : (
              <Input className={clsx('min-w-0', wide ? 'flex-1' : 'col-span-2')} type="email" value={pick} placeholder="user@company.com" onChange={(e) => setPick(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} />
            )}
            <Select className={clsx('shrink-0', wide && 'w-32')} value={role} onChange={(e) => setRole(e.target.value as 'Viewer' | 'Editor')} aria-label="Role">
              <option value="Viewer">Viewer (can see)</option>
              <option value="Editor">Editor (can change)</option>
            </Select>
            <Button className="h-10 shrink-0" aria-label="Add user" title="Add user" disabled={!pick} onClick={add} icon={<UserPlus className="size-4" />}>
              Add
            </Button>
          </div>
          {assigned.length === 0 ? (
            <div className="mt-3 rounded-xl border border-dashed border-line px-3 py-4 text-center text-sm text-muted">
              No users assigned to this field
              <p className="mt-0.5 text-[11px]">Until you add someone, only admins can see it.</p>
            </div>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {assigned.map((a, i) => (
                <li key={a.email} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-semibold uppercase">{(nameOf(a.email) ?? a.email)[0]}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{nameOf(a.email) ?? a.email}</span>
                    {nameOf(a.email) && <span className="block truncate text-[11px] text-muted">{a.email}</span>}
                  </span>
                  <Select
                    className="h-8 w-[6.75rem] shrink-0 py-0 pl-2.5 text-xs"
                    value={a.role}
                    aria-label={`Role of ${a.email}`}
                    onChange={(e) => onChange({ fieldUsers: assigned.map((x, j) => (j === i ? { ...x, role: e.target.value as 'Viewer' | 'Editor' } : x)) })}
                  >
                    <option>Viewer</option>
                    <option>Editor</option>
                  </Select>
                  <button type="button" className="text-muted hover:text-danger" aria-label={`Remove ${a.email}`} onClick={() => onChange({ fieldUsers: assigned.filter((_, j) => j !== i) })}>
                    <Trash2 className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11px] text-muted">
            <b>Viewer</b> sees the value, <b>Editor</b> can also change it. Everyone else can’t see the field at all. Admins always can.
          </p>
        </>
      ) : (
        <div className="space-y-3">
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted">
              <Users className="size-3.5" /> Who can see it
            </p>
            <GroupChips value={f.viewGroups} groups={groups} onChange={(viewGroups) => onChange({ viewGroups })} />
          </div>
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted">
              <Users className="size-3.5" /> Who can edit it
            </p>
            <GroupChips value={f.editGroups} groups={groups} onChange={(editGroups) => onChange({ editGroups })} />
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ popover menu
function Menu({ label, icon, children, width = 280 }: { label: string; icon: ReactNode; children: (close: () => void) => ReactNode; width?: number }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => !panel.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setPos(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setPos(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [pos]);
  return (
    <>
      <button
        ref={btn}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (pos) return setPos(null);
          const r = btn.current!.getBoundingClientRect();
          setPos({ top: Math.min(r.bottom + 6, window.innerHeight - 380), left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
        }}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium text-fg transition-colors hover:bg-surface-2"
      >
        {icon}
        {label}
        <ChevronDown className="size-3 text-muted" />
      </button>
      {pos &&
        createPortal(
          <div ref={panel} role="menu" className="fixed z-[80] max-h-[360px] animate-pop-in overflow-hidden overflow-y-auto rounded-2xl border border-line bg-surface p-1 text-fg shadow-[var(--shadow-float)]" style={{ ...pos, width }}>
            {children(() => setPos(null))}
          </div>,
          document.body,
        )}
    </>
  );
}

const MenuItem = ({ onPick, title, sub }: { onPick: () => void; title: ReactNode; sub?: ReactNode }) => (
  <button type="button" role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={onPick} className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2">
    <span className="w-full truncate">{title}</span>
    {sub && <span className="w-full truncate font-mono text-[10.5px] text-muted">{sub}</span>}
  </button>
);
const MenuTitle = ({ children }: { children: ReactNode }) => <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">{children}</p>;

// ------------------------------------------------------------------ validation rule
function FieldMenu({ def, onPick }: { def: WorkflowDef; onPick: (key: string) => void }) {
  const [q, setQ] = useState('');
  const groups = def.stages
    .map((s) => ({ s, fields: def.fields.filter((f) => f.stageKey === s.key && (!q || `${f.label} ${f.key}`.toLowerCase().includes(q.toLowerCase()))) }))
    .filter((g) => g.fields.length);
  return (
    <Menu label="Insert Field" icon={<FunctionSquare className="size-3.5" />}>
      {(close) => (
        <>
          <div className="relative p-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fields…" className="h-8 w-full rounded-lg bg-surface-2 pl-7 pr-2 text-xs outline-none" />
          </div>
          {groups.length === 0 && <p className="p-3 text-xs text-muted">No matching fields</p>}
          {groups.map(({ s, fields }) => (
            <div key={s.key}>
              <MenuTitle>{s.name}</MenuTitle>
              {fields.map((f) => (
                <MenuItem key={f.key} title={f.label} sub={f.key} onPick={() => (onPick(f.key), close())} />
              ))}
            </div>
          ))}
        </>
      )}
    </Menu>
  );
}

const sampleFor = (f: FieldDef | undefined): string => {
  if (!f) return '';
  if (f.type === 'number' || f.type === 'computed') return '10';
  if (f.type === 'date') return new Date().toISOString().slice(0, 10);
  if (f.type === 'checkbox') return 'TRUE';
  if (f.type === 'file') return 'file-1, file-2';
  if (f.options?.length) return f.options[0]!;
  if (f.type === 'email') return 'name@example.com';
  return 'Sample';
};
const asValue = (s: string, f: FieldDef | undefined): RuleValue => {
  if (!s.trim()) return null;
  if (f && (f.type === 'file' || f.type === 'multiselect')) return s.split(',').map((x) => x.trim()).filter(Boolean);
  if (f?.type === 'checkbox') return /^(true|yes|1)$/i.test(s.trim());
  if (f && (f.type === 'number' || f.type === 'computed') && Number.isFinite(Number(s))) return Number(s);
  return s;
};

export function RuleEditor({ field, def, onChange }: { field: FieldDef; def: WorkflowDef; onChange: (rule: string) => void }) {
  const rule = field.validationRule ?? '';
  const ref = useRef<HTMLTextAreaElement>(null);
  const [guide, setGuide] = useState(false);
  const [testing, setTesting] = useState(false);
  const byKey = useMemo(() => new Map(def.fields.map((f) => [f.key, f])), [def.fields]);

  const insert = (text: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? rule.length;
    const end = el?.selectionEnd ?? rule.length;
    let base = rule;
    let s = start;
    let e = end;
    if (!base.trim()) {
      base = '=';
      s = e = 1;
    }
    const next = base.slice(0, s) + text + base.slice(e);
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      const caret = s + text.length - (text.endsWith('()') ? 1 : 0);
      el?.setSelectionRange(caret, caret);
    });
  };

  const status = useMemo(() => {
    if (!rule.trim()) return null;
    try {
      const refs = ruleReferences(rule);
      const unknown = refs.filter((r) => r !== 'value' && !RULE_RECORD_VALUES.some((x) => x.name === r) && !byKey.has(r));
      return unknown.length ? { ok: false as const, text: `Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}` } : { ok: true as const, text: 'Formula looks good', refs };
    } catch (e) {
      const at = e instanceof RuleError && e.at !== undefined ? ` (at character ${e.at + 1})` : '';
      return { ok: false as const, text: `${(e as Error).message}${at}` };
    }
  }, [rule, byKey]);

  return (
    <div className="rounded-2xl border border-line bg-surface-2/60 p-3.5">
      <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Validation rule (optional)</p>
      <div className="mb-2.5 flex flex-wrap gap-1.5">
        <FieldMenu def={def} onPick={insert} />
        <Menu label="Insert Record" icon={<Database className="size-3.5" />} width={260}>
          {(close) => (
            <>
              <MenuTitle>This entry</MenuTitle>
              {RULE_RECORD_VALUES.map((r) => (
                <MenuItem key={r.name} title={r.label} sub={r.name} onPick={() => (insert(r.name), close())} />
              ))}
              <MenuTitle>Dates</MenuTitle>
              <MenuItem title="Today" sub="TODAY()" onPick={() => (insert('TODAY()'), close())} />
              <MenuItem title="Now" sub="NOW()" onPick={() => (insert('NOW()'), close())} />
            </>
          )}
        </Menu>
        <Menu label="Examples" icon={<Lightbulb className="size-3.5" />} width={320}>
          {(close) => (
            <>
              {RULE_EXAMPLES.map((x) => (
                <MenuItem key={x.title} title={x.title} sub={x.rule} onPick={() => (onChange(x.rule), close())} />
              ))}
            </>
          )}
        </Menu>
        <button type="button" onClick={() => setGuide(true)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium hover:bg-surface-2">
          <BookOpen className="size-3.5" /> Functions Guide
        </button>
        <button
          type="button"
          disabled={!rule.trim() || status?.ok === false}
          onClick={() => setTesting(!testing)}
          aria-pressed={testing}
          className={clsx('inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors disabled:opacity-45', testing ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-surface hover:bg-surface-2')}
        >
          <FlaskConical className="size-3.5" /> Test Formula
        </button>
      </div>

      <div className={clsx('flex overflow-hidden rounded-xl border bg-surface transition-colors focus-within:border-info/60 focus-within:shadow-[0_0_0_4px_rgb(0_102_204/0.12)]', status?.ok === false ? 'border-danger/60' : 'border-line')}>
        <span className="grid w-10 shrink-0 place-items-center border-r border-line bg-surface-2 font-serif text-sm font-semibold italic text-success">fx</span>
        <textarea
          ref={ref}
          value={rule}
          spellCheck={false}
          rows={3}
          placeholder={'=IF(value > 100, "At most 100 units")'}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-20 w-full resize-y bg-transparent px-3 py-2.5 font-mono text-[13px] leading-relaxed text-fg outline-none placeholder:text-muted/70"
          aria-label="Validation rule"
        />
      </div>
      {status && (
        <p className={clsx('mt-1.5 flex items-center gap-1 text-xs', status.ok ? 'text-success' : 'text-danger')}>
          {status.ok ? <CircleCheck className="size-3.5" /> : <CircleAlert className="size-3.5" />}
          {status.text}
        </p>
      )}

      {testing && status?.ok && <RuleTester rule={rule} field={field} refs={status.refs} byKey={byKey} flowName={def.name} />}

      <div className="mt-2.5 text-[11px] leading-6 text-muted">
        <span className="mr-1">Available fields:</span>
        {def.fields.map((f) => (
          <button key={f.key} type="button" title={`Insert ${f.key}`} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(f.key)} className="mr-1 rounded bg-info-soft px-1.5 py-0.5 font-mono text-[10.5px] text-info hover:brightness-95">
            {f.label}
          </button>
        ))}
        {RULE_RECORD_VALUES.map((r) => (
          <button key={r.name} type="button" title={r.label} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(r.name)} className="mr-1 rounded bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-fg ring-1 ring-line hover:bg-surface-2">
            {r.name}
          </button>
        ))}
        <p className="mt-1 leading-relaxed">
          Return <b>TRUE</b> when the value is fine, or the <b>message</b> to show when it isn’t. <code className="rounded bg-surface px-1">value</code> is this field. Use <code className="rounded bg-surface px-1">&lt;&gt;</code> or{' '}
          <code className="rounded bg-surface px-1">!=</code> for “not equal”, <code className="rounded bg-surface px-1">null</code> for empty, and <code className="rounded bg-surface px-1">=</code> or <code className="rounded bg-surface px-1">==</code> for equal.
        </p>
      </div>

      {guide && <FunctionsGuide onClose={() => setGuide(false)} onInsert={(t) => (insert(t), setGuide(false))} />}
    </div>
  );
}

function RuleTester({ rule, field, refs, byKey, flowName }: { rule: string; field: FieldDef; refs: string[]; byKey: Map<string, FieldDef>; flowName: string }) {
  const inputs = ['value', ...refs.filter((r) => r !== 'value' && r !== field.key)];
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(inputs.map((k) => [k, sampleFor(k === 'value' ? field : byKey.get(k))])));
  const fieldOf = (k: string) => (k === 'value' ? field : byKey.get(k));
  let outcome: ReturnType<typeof checkRule> | null = null;
  let error = '';
  try {
    const data: Record<string, RuleValue> = {};
    for (const k of inputs) if (k !== 'value' && byKey.has(k)) data[k] = asValue(vals[k] ?? '', byKey.get(k));
    const value = asValue(vals.value ?? '', field);
    data[field.key] = value;
    const record = Object.fromEntries(RULE_RECORD_VALUES.filter((r) => r.name !== 'value').map((r) => [r.name, vals[r.name] ?? (r.name === 'FLOW_NAME' ? flowName : null)]));
    outcome = checkRule(rule, { data: data as never, value, record: record as never }, field.label);
  } catch (e) {
    error = (e as Error).message;
  }
  const blank = !(vals.value ?? '').trim();
  return (
    <div className="mt-3 animate-pop-in rounded-xl border border-line bg-surface p-3">
      <p className="mb-2 text-xs font-medium text-muted">Try sample values</p>
      <div className="space-y-2">
        {inputs.map((k) => (
          <label key={k} className="flex items-center gap-2 text-xs">
            <span className="w-28 shrink-0 truncate font-mono text-muted" title={k}>
              {k === 'value' ? `value (${field.label})` : (fieldOf(k)?.label ?? k)}
            </span>
            <Input className="h-8 flex-1 py-1 text-xs" value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} placeholder={fieldOf(k)?.type === 'file' || fieldOf(k)?.type === 'multiselect' ? 'a, b, c' : 'empty'} />
          </label>
        ))}
      </div>
      <div
        className={clsx(
          'mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-sm',
          error ? 'bg-danger-soft text-danger' : blank ? 'bg-surface-2 text-muted' : outcome?.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger',
        )}
        role="status"
      >
        {error || (!blank && !outcome?.ok) ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <CircleCheck className="mt-0.5 size-4 shrink-0" />}
        <span>
          {error
            ? error
            : blank
              ? 'Empty values are not checked (use “Required field” for that).'
              : outcome?.ok
                ? 'Valid — the entry would be saved.'
                : `Rejected: “${outcome && !outcome.ok ? outcome.message : ''}”`}
          {!error && outcome && !blank && (
            <span className="mt-0.5 block font-mono text-[11px] opacity-75">
              Result: {Array.isArray(outcome.result) ? `[${outcome.result.join(', ')}]` : JSON.stringify(outcome.result)}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function FunctionsGuide({ onClose, onInsert }: { onClose: () => void; onInsert: (text: string) => void }) {
  const [q, setQ] = useState('');
  const cats = [...new Set(RULE_FUNCTIONS.map((f) => f.category))];
  const match = (f: (typeof RULE_FUNCTIONS)[number]) => !q || `${f.name} ${f.description}`.toLowerCase().includes(q.toLowerCase());
  return (
    <Modal open wide onClose={onClose} title="Functions guide">
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input className="pl-9" autoFocus placeholder="Search functions…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="mb-5 grid grid-cols-1 gap-2 rounded-xl bg-surface-2 p-3 text-xs text-muted sm:grid-cols-2">
        <p>
          <b className="text-fg">Result</b> — TRUE (or blank) means valid. FALSE means invalid. Any other text is shown to the user as the error.
        </p>
        <p>
          <b className="text-fg">Operators</b> — <code>+ - * / % ^</code>, <code>&amp;</code> joins text, <code>= == != &lt;&gt; &lt; &gt; &lt;= &gt;=</code>, <code>&amp;&amp; ||</code>, <code>!</code>.
        </p>
        <p>
          <b className="text-fg">Names</b> — field keys (<code>qty</code>), <code>value</code> for this field, and record values like <code>RECORD_NUMBER</code>.
        </p>
        <p>
          <b className="text-fg">Text</b> — in double quotes: <code>"Approved"</code>. Comparisons ignore upper / lower case.
        </p>
      </div>
      {cats.map((c) => {
        const items = RULE_FUNCTIONS.filter((f) => f.category === c && match(f));
        if (!items.length) return null;
        return (
          <section key={c} className="mb-5">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{c}</h3>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {items.map((f) => (
                <button key={f.name} type="button" onClick={() => onInsert(`${f.name}()`)} className="group rounded-xl border border-line p-3 text-left transition-colors hover:border-info/50 hover:bg-info-soft/40">
                  <code className="flex items-center gap-1.5 text-[13px] font-semibold text-info">
                    <Braces className="size-3.5" />
                    {f.syntax}
                  </code>
                  <p className="mt-1 text-xs text-muted">{f.description}</p>
                  <p className="mt-1.5 text-[11px] font-medium text-info opacity-0 transition-opacity group-hover:opacity-100">Click to insert</p>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </Modal>
  );
}
