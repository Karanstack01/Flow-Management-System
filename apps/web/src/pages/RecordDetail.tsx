import { Archive, CheckCircle2, Eye, FileText, Layers, Lock, RefreshCw, RotateCcw, Save } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { FieldValue } from '@fms/core';
import { FieldInput, fieldDefaults } from '../components/FieldInput';
import { CurrentStageBadge, StageTimeline } from '../components/Stage';
import { StageIntro } from '../components/StageIntro';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, ErrorNote, FormField, Input, PageHeader, Spinner, Tabs } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { displayValue, fmtDateTime, fmtRelative } from '../lib/format';
import { useHistory, useRecord, useRecordsInvalidation, useWorkflow } from '../lib/queries';
import type { RecordData, RecordDto, WorkflowView } from '../lib/types';

export default function RecordDetail() {
  const { wf: wfKey = '', id = '' } = useParams();
  const { data: wf, error: wfError } = useWorkflow(wfKey);
  const { data: record, error } = useRecord(wfKey, id);
  if (wfError || error) return <ErrorNote error={wfError ?? error} />;
  if (!wf || !record) return <Spinner />;
  return <Detail key={`${record.id}:${record.version}`} wf={wf} record={record} />;
}

function Detail({ wf, record }: { wf: WorkflowView; record: RecordDto }) {
  const [sp, setSp] = useSearchParams();
  const { can } = useAuth();
  const isAdmin = can('ADMIN');
  const invalidate = useRecordsInvalidation(wf.key);
  const [tab, setTab] = useState<'stage' | 'all' | 'history'>('stage');
  const selected = sp.get('stage') ?? record.currentStageKey ?? wf.stages[wf.stages.length - 1]!.key;
  const stageDef = wf.stages.find((s) => s.key === selected) ?? wf.stages[0]!;
  const stageState = record.stages.find((s) => s.stageKey === stageDef.key);
  // Generated documents are replaced by generating them again, never typed in.
  const docFields = new Set(wf.stages.flatMap((s) => (s.document ? [s.document.fieldKey] : [])));
  /** Why a stage's fields are read-only for this user right now (null = editable). */
  const stageBlock = (key: string): { icon: 'lock' | 'eye' | 'bulk'; text: string } | null => {
    const s = wf.stages.find((x) => x.key === key);
    const status = record.stages.find((x) => x.stageKey === key)?.status;
    if (!s) return null;
    if (s.lockAfterComplete && status === 'done') return { icon: 'lock', text: 'Locked — this stage is completed and its data can no longer be changed.' };
    if (s.canEdit === false) return { icon: 'eye', text: 'You can see this stage but only its assigned editors can change it.' };
    if (s.singleUpdate === false && !isAdmin) return { icon: 'bulk', text: 'This stage is updated in bulk from the records table (select rows → Bulk update).' };
    return null;
  };
  // Empty fields of the active stage start with their default value (sent on Save / Complete).
  const [draft, setDraft] = useState<RecordData>(() => {
    if (record.archivedAt) return {};
    const active = new Set(record.stages.filter((s) => s.status === 'active').map((s) => s.stageKey));
    const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    return fieldDefaults(wf.fields.filter((f) => f.canEdit && active.has(f.stageKey) && !docFields.has(f.key) && !stageBlock(f.stageKey) && empty(record.data[f.key])), wf.timezone);
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [planned, setPlanned] = useState('');
  const history = useHistory(wf.key, record.id, tab === 'history');

  useEffect(() => setErrors({}), [selected]);
  const merged = useMemo(() => ({ ...record.data, ...draft }), [record.data, draft]);
  const dirty = Object.keys(draft).length > 0;
  const reached = (key: string) => ['active', 'done'].includes(record.stages.find((s) => s.stageKey === key)?.status ?? '');
  const visibleFields = tab === 'all' ? wf.fields : wf.fields.filter((f) => f.stageKey === stageDef.key);
  const block = stageBlock(stageDef.key);
  const canAct = stageState?.status === 'active' && !record.archivedAt && wf.isActive && !block && (stageDef.isMine || stageDef.responsibleGroups.length === 0);
  const doc = stageDef.document;
  const docFiles = doc ? record.data[doc.fieldKey] : undefined;
  const hasDoc = Array.isArray(docFiles) && docFiles.length > 0;
  const canGenerate = !!doc && stageState?.status === 'active' && !record.archivedAt && wf.isActive && stageDef.canEdit !== false && (stageDef.isMine || stageDef.responsibleGroups.length === 0);

  async function run(label: string, fn: () => Promise<unknown>, success: string) {
    setBusy(label);
    setErrors({});
    try {
      await fn();
      toast.success(success);
      setDraft({});
      invalidate();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.details) setErrors(e.details);
        if (e.status === 409) toast.error(e.message, { action: { label: 'Reload', onClick: invalidate } });
        else toast.error(e.message);
      } else toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const save = () => run('save', () => api(`/workflows/${wf.key}/records/${record.id}`, { method: 'PATCH', body: { data: draft, version: record.version } }), 'Saved');
  const complete = () =>
    run('complete', () => api(`/workflows/${wf.key}/records/${record.id}/stages/${stageDef.key}/complete`, { method: 'POST', body: { data: draft, version: record.version } }), `${stageDef.name} completed`);
  const setPlan = () =>
    run(
      'plan',
      () => api(`/workflows/${wf.key}/records/${record.id}/stages/${stageDef.key}/planned`, { method: 'PUT', body: { plannedAt: DateTime.fromISO(planned, { zone: wf.timezone }).toISO() } }),
      'Planned time set',
    );
  const generate = () => run('generate', () => api(`/workflows/${wf.key}/records/${record.id}/stages/${stageDef.key}/document`, { method: 'POST' }), hasDoc ? 'Document generated again' : 'Document generated');
  const archive = (restore: boolean) =>
    run('archive', () => api(`/workflows/${wf.key}/records/${restore ? 'restore' : 'archive'}`, { method: 'POST', body: { ids: [record.id] } }), restore ? 'Restored' : 'Archived');

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-muted">#{record.number}</span> {record.title}
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Link to={`/w/${wf.key}`} className="hover:underline">
              {wf.name}
            </Link>
            · <CurrentStageBadge stages={record.stages} defs={wf.stages} currentStageKey={record.currentStageKey} />
            {record.archivedAt && <Badge tone="warning">Archived</Badge>}
            {record.submissionId && <Badge>Multi-item submission</Badge>}
          </span>
        }
        actions={
          wf.canArchive && (
            <Button icon={record.archivedAt ? <RotateCcw className="size-4" /> : <Archive className="size-4" />} loading={busy === 'archive'} onClick={() => void archive(!!record.archivedAt)}>
              {record.archivedAt ? 'Restore' : 'Archive'}
            </Button>
          )
        }
      />

      <StageTimeline stages={record.stages} defs={wf.stages} zone={wf.timezone} selected={stageDef.key} onSelect={(k) => setSp({ stage: k }, { replace: true })} />

      <Card bodyClassName="p-0">
        <div className="px-4 pt-2">
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: 'stage', label: stageDef.name },
              { value: 'all', label: 'All fields' },
              { value: 'history', label: 'History' },
            ]}
          />
        </div>

        {tab === 'history' ? (
          <HistoryList wf={wf} entries={history.data} loading={history.isLoading} />
        ) : (
          <div className="space-y-4 p-4">
            {tab === 'stage' && stageState && (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-muted">
                <span>
                  Status: <b className="text-fg capitalize">{stageState.status}</b>
                </span>
                <span>Planned: {fmtDateTime(stageState.plannedAt, wf.timezone)}</span>
                <span>Actual: {fmtDateTime(stageState.actualAt, wf.timezone)}</span>
                {stageDef.responsibleGroups.length > 0 && <span>Owner: {stageDef.responsibleGroups.join(', ')}</span>}
              </div>
            )}
            {tab === 'stage' && <StageIntro description={stageDef.description} video={stageDef.video} />}
            {tab === 'stage' && block && (
              <p className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm text-muted">
                {block.icon === 'lock' ? <Lock className="size-4" /> : block.icon === 'eye' ? <Eye className="size-4" /> : <Layers className="size-4" />}
                {block.text}
              </p>
            )}
            {tab === 'stage' && doc && (
              <div className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-500/30 dark:bg-indigo-500/10">
                <div className="flex flex-wrap items-center gap-2">
                  <FileText className="size-5 text-indigo-600 dark:text-indigo-300" />
                  <p className="flex-1 text-sm font-semibold">{hasDoc ? 'Generated document' : stageState?.status === 'active' ? 'The document has not been generated yet' : 'Document'}</p>
                  {canGenerate && (
                    <Button size="sm" icon={<RefreshCw className="size-4" />} loading={busy === 'generate'} onClick={() => void generate()}>
                      {hasDoc ? 'Generate again' : 'Generate document'}
                    </Button>
                  )}
                </div>
                {hasDoc && wf.fields.find((f) => f.key === doc.fieldKey) && (
                  <div className="mt-3">
                    <FieldInput field={wf.fields.find((f) => f.key === doc.fieldKey)!} value={docFiles} onChange={() => undefined} disabled zone={wf.timezone} />
                  </div>
                )}
                <p className="mt-2 text-xs text-muted">
                  {doc.format === 'pdf' ? 'PDF' : 'Word'} ·{' '}
                  {doc.requireReview ? (stageState?.status === 'active' ? 'Check the document, correct the data and generate it again if needed, then approve to continue.' : 'Reviewed before the flow continued.') : 'The flow continued as soon as it was generated.'}
                </p>
              </div>
            )}
            {visibleFields.length === 0 ? (
              <p className="text-sm text-muted">No fields in this stage are visible to you.</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {visibleFields.filter((f) => !(tab === 'stage' && docFields.has(f.key))).map((f) => {
                  const editable = f.canEdit && !record.archivedAt && wf.isActive && reached(f.stageKey) && f.type !== 'computed' && f.type !== 'user-email' && !docFields.has(f.key) && !stageBlock(f.stageKey);
                  return (
                    <FormField key={f.key} label={f.label} required={f.required} error={errors[f.key]} hint={tab === 'all' ? wf.stages.find((s) => s.key === f.stageKey)?.name : f.helpText} className={f.type === 'textarea' ? 'md:col-span-2' : undefined}>
                      {editable ? (
                        <FieldInput field={f} value={merged[f.key]} onChange={(v: FieldValue) => setDraft((d) => ({ ...d, [f.key]: v }))} zone={wf.timezone} data={merged} invalid={!!errors[f.key]} />
                      ) : f.type === 'file' ? (
                        <FieldInput field={f} value={merged[f.key]} onChange={() => undefined} disabled zone={wf.timezone} />
                      ) : (
                        <div className="input min-h-9 bg-surface-2 whitespace-pre-wrap">{displayValue(f, merged[f.key], wf.timezone) || <span className="text-muted">—</span>}</div>
                      )}
                    </FormField>
                  );
                })}
              </div>
            )}

            {tab === 'stage' && canAct && stageDef.plannedMode === 'manual' && (
              <div className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-surface-2 p-3">
                <FormField label="Planned completion">
                  <Input type="datetime-local" value={planned} onChange={(e) => setPlanned(e.target.value)} />
                </FormField>
                <Button disabled={!planned} loading={busy === 'plan'} onClick={() => void setPlan()}>
                  Set planned time
                </Button>
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
              {dirty && (
                <Button variant="ghost" onClick={() => setDraft({})}>
                  Discard
                </Button>
              )}
              <Button icon={<Save className="size-4" />} disabled={!dirty} loading={busy === 'save'} onClick={() => void save()}>
                Save
              </Button>
              {tab === 'stage' && canAct && stageDef.completion === 'manual' && (
                <Button variant="primary" icon={<CheckCircle2 className="size-4" />} loading={busy === 'complete'} disabled={!!doc && !hasDoc} title={doc && !hasDoc ? 'Generate the document first' : undefined} onClick={() => void complete()}>
                  {doc ? 'Approve & continue' : dirty ? 'Save & mark done' : 'Mark stage done'}
                </Button>
              )}
              {tab === 'stage' && stageState?.status === 'active' && stageDef.completion === 'conditions' && (
                <span className="self-center text-xs text-muted">This stage completes automatically when its conditions are met.</span>
              )}
            </div>
          </div>
        )}
      </Card>
      <p className="text-xs text-muted">
        Created {fmtDateTime(record.createdAt, wf.timezone)} · Updated {fmtRelative(record.updatedAt)}
      </p>
    </div>
  );
}

const ACTIONS: Record<string, string> = {
  'record.created': 'created the record',
  'record.updated': 'updated',
  'record.stage_completed': 'completed a stage',
  'record.planned_set': 'set a planned time',
  'record.archived': 'archived',
  'record.restored': 'restored',
  'record.auto_archived': 'auto-archived',
};

function HistoryList({ wf, entries, loading }: { wf: WorkflowView; entries?: import('../lib/types').HistoryEntry[]; loading: boolean }) {
  if (loading) return <Spinner />;
  if (!entries?.length) return <p className="p-4 text-sm text-muted">No history yet.</p>;
  const field = (k: string) => wf.fields.find((f) => f.key === k);
  return (
    <ol className="divide-y divide-line">
      {entries.map((h) => (
        <li key={h.id} className="px-4 py-3 text-sm">
          <p>
            <b>{h.actorEmail ?? 'System'}</b> {ACTIONS[h.action] ?? h.action} <span className="text-muted">· {fmtDateTime(h.createdAt, wf.timezone)}</span>
          </p>
          {h.fields && Object.keys(h.fields).length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-muted">
              {Object.entries(h.fields).map(([k, d]) => (
                <li key={k}>
                  <span className="font-medium text-fg">{field(k)?.label ?? k}</span>: {displayValue(field(k), d.from, wf.timezone) || '∅'} → {displayValue(field(k), d.to, wf.timezone) || '∅'}
                </li>
              ))}
            </ul>
          )}
          {h.events && h.events.length > 0 && (
            <p className="mt-1 flex flex-wrap gap-1">
              {h.events.map((e, i) => (
                <Badge key={i} tone={e.type === 'stage_completed' ? 'success' : 'primary'}>
                  {wf.stages.find((s) => s.key === e.stageKey)?.name}: {e.type.replace('stage_', '')}
                </Badge>
              ))}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
