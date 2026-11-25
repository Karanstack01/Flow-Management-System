/**
 * Stage › General: basic settings (name, description, instruction video, colours, lock),
 * public form access, stage access control, owners & completion, update options and the
 * thank-you message — plus the Document step's configuration.
 */
import clsx from 'clsx';
import { ChevronDown, Copy, ExternalLink, Eye, FileText, Globe, Lock, MessageCircle, PencilLine, Trash2, UserPlus, Users } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { type ConditionGroup, type DocumentConfig, type FieldDef, type StageDef, type WorkflowDef } from '@fms/core';
import { ConditionEditor } from '../../../components/ConditionEditor';
import { videoEmbedUrl } from '../../../components/StageIntro';
import { Button, Input, Modal, Select, Switch, Tabs, Textarea } from '../../../components/ui';
import { RichTextEditor, TagPicker, TokenInput } from './MessageComposer';
import { DocumentPreview } from './Preview';

const EMPTY: ConditionGroup = { mode: 'all', conditions: [] };
type Users = { name: string; email: string }[];
type Access = { email: string; role: 'Viewer' | 'Editor' }[];

export interface StageSettingsProps {
  stage: StageDef;
  def: WorkflowDef;
  isIntake: boolean;
  groups: string[];
  users: Users;
  /** The key is used by saved records. */
  keyLocked: boolean;
  flowKey: string;
  wide: boolean;
  onStage: (patch: Partial<StageDef>) => void;
  onFields: (fn: (fields: FieldDef[]) => FieldDef[]) => void;
}

// ------------------------------------------------------------------ building blocks
/** Collapsible card with a dot, title and an optional right-hand slot. */
export function Panel({ title, icon, right, children, defaultOpen = true, tone = 'plain' }: { title: string; icon?: ReactNode; right?: ReactNode; children: ReactNode; defaultOpen?: boolean; tone?: 'plain' | 'green' }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={clsx('overflow-hidden rounded-2xl border', tone === 'green' ? 'border-success/25 bg-success-soft/40' : 'border-line bg-surface-2/50')}>
      <div className="flex items-center gap-2 px-3.5 py-3">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {icon ?? <span className="size-1.5 shrink-0 rounded-full bg-muted" />}
          <span className="truncate text-[14px] font-semibold">{title}</span>
        </button>
        {right}
        <button type="button" onClick={() => setOpen(!open)} aria-label={open ? `Collapse ${title}` : `Expand ${title}`} className="grid size-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface hover:text-fg">
          <ChevronDown className={clsx('size-4 transition-transform duration-200', open && 'rotate-180')} />
        </button>
      </div>
      {open && <div className="animate-pop-in space-y-3.5 px-3.5 pb-3.5">{children}</div>}
    </section>
  );
}

const Label = ({ children, hint }: { children: ReactNode; hint?: ReactNode }) => (
  <div className="mb-1.5">
    <p className="text-[13px] font-semibold text-fg">{children}</p>
    {hint && <p className="text-[11px] text-muted">{hint}</p>}
  </div>
);

/** A labelled on/off row in a soft box; `children` (e.g. "how many hours") show while it is on. */
export function ToggleRow({ title, hint, icon, checked, onChange, disabled, children }: { title: string; hint: string; icon?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children?: ReactNode }) {
  return (
    <div className={clsx('rounded-xl border border-line bg-surface px-3 py-2.5 transition-colors duration-200', disabled && 'opacity-60')}>
      <div className="flex items-start gap-3">
        {icon && <span className="mt-0.5 shrink-0 text-muted [&>svg]:size-4">{icon}</span>}
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">{title}</span>
          <span className="block text-[11px] leading-snug text-muted">{hint}</span>
        </span>
        <Switch checked={checked} onChange={onChange} label={title} disabled={disabled} />
      </div>
      {children && checked && <div className={clsx('mt-2.5 animate-pop-in border-t border-dashed border-line pt-2.5', icon && 'pl-7')}>{children}</div>}
    </div>
  );
}

/** Stage header colour for the All Entries table (optional). */
function HeaderColor({ value, onChange }: { value?: string; onChange: (v: string | undefined) => void }) {
  const [text, setText] = useState(value ?? '');
  // Follow outside changes (undo / redo); half-typed text that is not a colour yet is kept.
  useEffect(() => {
    if ((value ?? '') !== text.toLowerCase()) setText(value ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the stored value changes
  }, [value]);
  return (
    <div>
      <Label hint="Choose a colour for this stage’s column headers in the entries table.">Stage header colour (All Entries table)</Label>
      <div className="flex items-center gap-2">
        <label className="relative h-9 w-12 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-line" style={{ background: value ?? '#e2e8f0' }} title="Pick a colour">
          <input type="color" aria-label="Header colour" className="absolute inset-0 cursor-pointer opacity-0" value={value ?? '#e2e8f0'} onChange={(e) => (onChange(e.target.value), setText(e.target.value))} />
        </label>
        <Input
          className="h-9 w-36 font-mono text-xs"
          value={text}
          placeholder="#e2e8f0 (optional)"
          onChange={(e) => {
            setText(e.target.value);
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toLowerCase());
            if (!e.target.value) onChange(undefined);
          }}
        />
        {value && (
          <Button size="sm" variant="ghost" onClick={() => (onChange(undefined), setText(''))}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

/** Assign users with a Viewer / Editor role (stage access). */
export function UsersAccess({ value, users, onChange, wide, empty }: { value: Access; users: Users; onChange: (v: Access) => void; wide: boolean; empty: string }) {
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<'Viewer' | 'Editor'>('Editor');
  const nameOf = (email: string) => users.find((u) => u.email.toLowerCase() === email.toLowerCase())?.name;
  const available = users.filter((u) => !value.some((a) => a.email.toLowerCase() === u.email.toLowerCase()));
  const add = () => {
    const email = pick.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || value.some((a) => a.email === email)) return;
    onChange([...value, { email, role }]);
    setPick('');
  };
  return (
    <div className="space-y-2.5">
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
        <Select className={clsx('shrink-0', wide && 'w-40')} value={role} onChange={(e) => setRole(e.target.value as 'Viewer' | 'Editor')} aria-label="Role">
          <option value="Editor">Editor (fills in)</option>
          <option value="Viewer">Viewer (can see)</option>
        </Select>
        <Button className="h-10 shrink-0" disabled={!pick} onClick={add} icon={<UserPlus className="size-4" />}>
          Add
        </Button>
      </div>
      {value.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-sm text-muted">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {value.map((a, i) => (
            <li key={a.email} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-semibold uppercase">{(nameOf(a.email) ?? a.email)[0]}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{nameOf(a.email) ?? a.email}</span>
                {nameOf(a.email) && <span className="block truncate text-[11px] text-muted">{a.email}</span>}
              </span>
              <Select className="h-8 w-[6.75rem] shrink-0 py-0 pl-2.5 text-xs" value={a.role} aria-label={`Role of ${a.email}`} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, role: e.target.value as 'Viewer' | 'Editor' } : x)))}>
                <option>Editor</option>
                <option>Viewer</option>
              </Select>
              <button type="button" className="text-muted hover:text-danger" aria-label={`Remove ${a.email}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const newPublicId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Instruction video: kept locally while typing; written to the stage once the link is a valid https URL. */
function VideoSetting({ value, onChange }: { value?: StageDef['video']; onChange: (v: StageDef['video'] | undefined) => void }) {
  const [title, setTitle] = useState(value?.title ?? '');
  const [url, setUrl] = useState(value?.url ?? '');
  const valid = /^https:\/\/[^\s]+\.[^\s]+/i.test(url.trim());
  // Follow outside changes (undo / redo). While a link is being typed (not valid yet) the stage has
  // no video, so only a stored value that differs from what is typed replaces the inputs.
  useEffect(() => {
    if (value && (value.url !== url.trim() || (value.title ?? '') !== title.trim())) {
      setUrl(value.url);
      setTitle(value.title ?? '');
    } else if (!value && valid) {
      setUrl('');
      setTitle('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the stored value changes
  }, [value?.url, value?.title]);
  const commit = (t: string, u: string) => onChange(/^https:\/\/[^\s]+\.[^\s]+/i.test(u.trim()) ? { title: t.trim() || undefined, url: u.trim() } : undefined);
  return (
    <div>
      <Label hint="Add a YouTube, Google Drive, Vimeo or Loom link. Users see it above the form.">Instruction Video</Label>
      <div className="space-y-2">
        <Input value={title} placeholder="Tutorial link" onChange={(e) => (setTitle(e.target.value), commit(e.target.value, url))} aria-label="Video title" />
        <Input value={url} placeholder="https://youtube.com/watch?v=… or Google Drive link" onChange={(e) => (setUrl(e.target.value), commit(title, e.target.value))} aria-label="Video link" />
        {url && !valid && <p className="text-[11px] text-danger">Use a full https:// link — it is not saved until then.</p>}
        {url && valid && <p className="text-[11px] text-muted">{videoEmbedUrl(url) ? 'Plays inside the form.' : 'Shown as a link (this site can not be embedded).'}</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Stage › General
export function StageGeneral({ stage, def, isIntake, groups, users, keyLocked, wide, onStage }: StageSettingsProps) {
  const isDoc = !!stage.document;
  const single = stage.singleUpdate !== false;
  const bulk = !!stage.bulkUpdate;
  const updateMode = single && bulk ? 'Single + Bulk' : single ? 'Single' : bulk ? 'Bulk' : 'Off';
  const publicUrl = stage.publicFormId ? `${window.location.origin}/f/${stage.publicFormId}` : '';
  const publicFields = def.fields.filter((f) => f.stageKey === stage.key && !f.hidden && !f.fieldAccessRestricted && f.editGroups.includes('ALL') && !['file', 'computed', 'user-email'].includes(f.type));
  const conditionFields = def.fields.map((f) => ({ key: f.key, label: f.label, options: f.options }));

  return (
    <div className="space-y-3">
      <Panel title="Basic Settings">
        <div>
          <Label>Stage name</Label>
          <Input value={stage.name} onChange={(e) => onStage({ name: e.target.value })} aria-label="Stage name" />
        </div>
        <div>
          <Label>Description</Label>
          <Textarea value={stage.description ?? ''} placeholder="What should people do in this stage? Shown above its form." onChange={(e) => onStage({ description: e.target.value || undefined })} aria-label="Stage description" />
        </div>
        <VideoSetting value={stage.video} onChange={(video) => onStage({ video })} />
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <div>
            <Label hint={keyLocked ? 'Locked: records use it' : 'Used internally'}>Key</Label>
            <Input value={stage.key} disabled readOnly aria-label="Stage key" />
          </div>
          <div>
            <Label hint="Canvas & badges">Colour</Label>
            <Input type="color" className="h-10 w-14 p-1" value={stage.color} onChange={(e) => onStage({ color: e.target.value })} aria-label="Stage colour" />
          </div>
        </div>
        <HeaderColor value={stage.headerColor} onChange={(headerColor) => onStage({ headerColor })} />
        <ToggleRow
          icon={<Lock />}
          title="Lock editing after this stage is completed"
          hint="When on, this stage’s data becomes read-only once the stage is done — no one (including flow creators and admins) can edit it afterwards."
          checked={!!stage.lockAfterComplete}
          onChange={(v) => onStage({ lockAfterComplete: v || undefined })}
        />
        {isIntake && (
          <div className="rounded-2xl border border-success/25 bg-success-soft/40 p-3.5">
            <div className="flex items-center gap-2">
              <Globe className="size-4 text-success" />
              <p className="flex-1 text-[14px] font-semibold">Public Form Access</p>
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={!!stage.publicForm} onChange={(e) => onStage(e.target.checked ? { publicForm: true, publicFormId: stage.publicFormId ?? newPublicId() } : { publicForm: undefined })} />
                Allow public access
              </label>
            </div>
            {stage.publicForm && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Input readOnly value={publicUrl} className="h-9 font-mono text-xs" aria-label="Public form link" onFocus={(e) => e.target.select()} />
                  <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => void navigator.clipboard.writeText(publicUrl).then(() => toast.success('Link copied'))}>
                    Copy
                  </Button>
                  <a href={publicUrl} target="_blank" rel="noopener noreferrer" className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface hover:text-fg" aria-label="Open public form" title="Open">
                    <ExternalLink className="size-4" />
                  </a>
                </div>
                <button
                  type="button"
                  className="text-[11px] font-medium text-info hover:underline"
                  onClick={() => window.confirm('Create a new link? The current link stops working once you save.') && onStage({ publicFormId: newPublicId() })}
                >
                  New link (retire the current one)
                </button>
                <p className="text-[11px] text-muted">
                  Anyone with the link can submit once the flow is saved and live — no sign-in. Switching access off and on again brings back the same link. It shows the fields everyone may edit ({publicFields.length}: {publicFields.map((f) => f.label).join(', ') || 'none yet'}). File uploads are not offered publicly.
                </p>
              </div>
            )}
          </div>
        )}
        <Panel title="Stage Access Control" icon={<UserPlus className="size-4 text-success" />} tone="green" defaultOpen={!!stage.stageAccessRestricted}>
          <ToggleRow
            icon={<Users />}
            title="Allow only assigned users"
            hint="Only these people (and admins) see this stage’s fields. Editors work on it — they are notified, see it in My Tasks and complete it (they replace the owner groups); Viewers can only see it."
            checked={!!stage.stageAccessRestricted}
            onChange={(v) => onStage({ stageAccessRestricted: v || undefined })}
          />
          {stage.stageAccessRestricted && (
            <UsersAccess value={stage.stageUsers ?? []} users={users} wide={wide} onChange={(stageUsers) => onStage({ stageUsers })} empty="No users assigned — until you add someone, only admins can work on this stage." />
          )}
        </Panel>
      </Panel>

      <Panel title="Owners & completion" defaultOpen={!isIntake}>
        <div>
          <Label hint={stage.stageAccessRestricted ? 'Stage Access Control is on: its assigned Editors work on this stage (notified, My Tasks, Mark done) instead of these groups.' : 'Notified when it starts; it appears in their My Tasks.'}>Owners</Label>
          <div className="flex flex-wrap gap-1.5">
            {groups.map((g) => {
              const on = stage.responsibleGroups.includes(g);
              return (
                <button
                  type="button"
                  key={g}
                  aria-pressed={on}
                  onClick={() => onStage({ responsibleGroups: on ? stage.responsibleGroups.filter((x) => x !== g) : [...stage.responsibleGroups, g] })}
                  className={on ? 'rounded-full border border-primary bg-primary-soft px-2.5 py-0.5 text-xs font-medium text-primary' : 'rounded-full border border-line px-2.5 py-0.5 text-xs text-muted hover:text-fg'}
                >
                  {g}
                </button>
              );
            })}
            {groups.length === 0 && <p className="text-xs text-muted">Create groups under All Users first.</p>}
          </div>
        </div>
        {isIntake ? (
          <p className="rounded-xl bg-surface p-3 text-xs text-muted">This is the intake form: it is done as soon as someone submits it. Its fields form the “Add entry” page.</p>
        ) : isDoc ? (
          <p className="rounded-xl bg-surface p-3 text-xs text-muted">A document step is done {stage.document!.requireReview ? 'when someone reviews the document and marks it done' : 'as soon as its document is generated'} — change it in the Document tab.</p>
        ) : (
          <>
            <div>
              <Label>Done when</Label>
              <Select value={stage.completion.kind} onChange={(e) => onStage({ completion: e.target.value === 'conditions' ? { kind: 'conditions', when: EMPTY } : { kind: 'manual' } })}>
                <option value="manual">The owner clicks “Mark done”</option>
                <option value="conditions">These conditions are met (auto)</option>
              </Select>
            </div>
            {stage.completion.kind === 'conditions' && <ConditionEditor fields={conditionFields} value={stage.completion.when} onChange={(when) => onStage({ completion: { kind: 'conditions', when } })} />}
          </>
        )}
        {!isIntake && (
          <div>
            <Label hint="For a TAT in working hours, put a Delay/Timer node in front of this stage.">Due time</Label>
            <Select value={stage.planned.mode === 'manual' ? 'manual' : 'auto'} onChange={(e) => onStage({ planned: e.target.value === 'manual' ? { mode: 'manual' } : { mode: 'none' } })}>
              <option value="auto">From a Delay/Timer node (or none)</option>
              <option value="manual">The owner enters a planned date</option>
            </Select>
          </div>
        )}
      </Panel>

      <Panel title="Stage update options" icon={<PencilLine className="size-4 text-muted" />} right={<span className="text-[11px] text-muted">{updateMode}</span>}>
        <ToggleRow title="Single Item Update" hint="Allow editing one record at a time via the entry form." checked={single} onChange={(v) => onStage({ singleUpdate: v ? undefined : false })} />
        <ToggleRow title="Bulk Update" hint="Allow updating many records of this stage at once from the records table (select rows → Bulk update)." checked={bulk} onChange={(v) => onStage({ bulkUpdate: v || undefined })} />
        {!single && !bulk && <p className="rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning">With both off, only admins can fill in this stage.</p>}
      </Panel>

      {isIntake && (
        <Panel title="Thank you message" icon={<MessageCircle className="size-4 text-success" />} tone="green" defaultOpen={!!stage.showThankYou}>
          <p className="text-[12px] text-muted">Show a custom message after someone submits the form (e.g. on the public form page).</p>
          <ToggleRow title="Show thank you message after submission" hint="When on, people see your message instead of the default confirmation." checked={!!stage.showThankYou} onChange={(v) => onStage({ showThankYou: v || undefined })} />
          {stage.showThankYou && <Textarea value={stage.thankYouText ?? ''} maxLength={2000} placeholder="Thank you! We have received your request and will call you within one working day." onChange={(e) => onStage({ thankYouText: e.target.value || undefined })} aria-label="Thank you message" />}
        </Panel>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Document step
export function DocumentSettings(p: StageSettingsProps) {
  const { stage, def, wide, onStage, onFields, flowKey } = p;
  const [tab, setTab] = useState<'document' | 'stage'>('document');
  const [preview, setPreview] = useState(false);
  const cfg = stage.document!;
  const docField = def.fields.find((f) => f.key === cfg.fieldKey);
  const set = (patch: Partial<DocumentConfig>) => onStage({ document: { ...cfg, ...patch } });
  return (
    <div className="space-y-3">
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'document', label: <><FileText className="size-3.5" />Document</> },
          { value: 'stage', label: 'Stage settings' },
        ]}
      />
      {tab === 'stage' ? (
        <StageGeneral {...p} />
      ) : (
        <Panel
          title={wide ? 'Document Configuration' : 'Document'}
          icon={<span className="size-1.5 shrink-0 rounded-full bg-info" />}
          right={
            <span className="flex items-center gap-1.5">
              <TagPicker def={def} compact onPick={(t) => void navigator.clipboard.writeText(t).then(() => toast.success(`${t} copied — paste it into the name or the body`))} />
              <Button size="sm" variant="ghost" className="h-7 rounded-full bg-info-soft px-2.5 text-info" icon={<Eye className="size-3.5" />} onClick={() => setPreview(true)}>
                Preview
              </Button>
            </span>
          }
        >
          <div>
            <Label hint="Used as the column header in the entries table; the generated file is stored in this field.">Field Name</Label>
            <Input
              value={docField?.label ?? ''}
              placeholder="Enter field name used as header"
              onChange={(e) => onFields((all) => all.map((f) => (f.key === cfg.fieldKey ? { ...f, label: e.target.value } : f)))}
              aria-label="Document field name"
            />
          </div>
          <HeaderColor value={stage.headerColor} onChange={(headerColor) => onStage({ headerColor })} />
          <div>
            <Label hint="The name of the generated file. Tags are filled in; the extension is added.">Document Name</Label>
            <TokenInput def={def} value={cfg.fileName} placeholder="e.g. Quote {{record_number}} {{customer}}" onChange={(fileName) => set({ fileName })} />
          </div>
          <ToggleRow
            title="Require review before continuing"
            hint="When on, this step waits on the record page until someone checks the document and marks it done. When off, the flow continues by itself after generating it."
            checked={cfg.requireReview}
            onChange={(requireReview) => set({ requireReview })}
          />
          <div className={clsx('grid gap-3', wide ? 'grid-cols-3' : 'grid-cols-1')}>
            <div>
              <Label hint="Where the content comes from.">Source Type</Label>
              <Select value={cfg.source} onChange={(e) => set({ source: e.target.value as DocumentConfig['source'] })}>
                <option value="custom">Custom (write the body)</option>
                <option value="all_fields">All fields (automatic table)</option>
              </Select>
            </div>
            <div>
              <Label hint="File type of the document.">Output Format</Label>
              <Select value={cfg.format} onChange={(e) => set({ format: e.target.value as DocumentConfig['format'] })}>
                <option value="pdf">PDF</option>
                <option value="doc">Word (.doc)</option>
              </Select>
            </div>
            <div>
              <Label hint="Page orientation.">Orientation</Label>
              <Select value={cfg.orientation} onChange={(e) => set({ orientation: e.target.value as DocumentConfig['orientation'] })}>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </Select>
            </div>
          </div>
          {cfg.source === 'custom' ? (
            <div>
              <Label hint="Use Tags to insert form fields; they are replaced with each record’s values.">Document Body</Label>
              <RichTextEditor def={def} extended value={cfg.body} minHeight={wide ? 360 : 240} placeholder="Type your document here…" onChange={(body) => set({ body })} />
            </div>
          ) : (
            <p className="rounded-xl bg-surface p-3 text-xs text-muted">The document lists every field of the record with its value, in a table.</p>
          )}
          {!docField && <p className="text-xs text-danger">This step’s file field is missing — delete the step and add it again.</p>}
        </Panel>
      )}
      {preview && (
        <Modal open wide onClose={() => setPreview(false)} title={`Preview — ${stage.name}`} footer={<Button onClick={() => setPreview(false)}>Close</Button>}>
          <DocumentPreview cfg={cfg} def={def} stageName={stage.name} flowKey={flowKey} />
        </Modal>
      )}
    </div>
  );
}
