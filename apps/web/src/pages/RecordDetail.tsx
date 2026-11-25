import { Archive, CheckCircle2, Eye, FileText, Layers, Lock, RefreshCw, RotateCcw, Save } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { FieldValue } from '@fms/core';
import { changeWithDependents, FieldInput, fieldDefaults } from '../components/FieldInput';
import { canActOn, NextSteps, ownersOf, StepDetails, StepList, stepStarts } from '../components/FlowRun';
import { CurrentStageBadge } from '../components/Stage';
import { SubmissionItems } from '../components/SubmissionItems';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, ErrorNote, FormField, Input, PageHeader, Spinner, Tabs } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { displayValue, fmtDateTime, fmtRelative } from '../lib/format';
import { useDeliveries, useHistory, useRecord, useRecordsInvalidation, useWorkflow } from '../lib/queries';
import type { RecordData, RecordDto, WorkflowView } from '../lib/types';

export default function RecordDetail() {
  const { wf: wfKey = '', id = '' } = useParams();
  const { data: wf, error: wfError } = useWorkflow(wfKey);
  const { data: record, error } = useRecord(wfKey, id);
  if (wfError || error) return <ErrorNote error={wfError ?? error} />;
  if (!wf || !record) return <Spinner />;
  return <Detail key={record.id} wf={wf} record={record} />;
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
    // No access at all: the fields area says so; nothing to explain about editing.
    if (!s || s.canView === false) return null;
    if (s.lockAfterComplete && status === 'done') return { icon: 'lock', text: 'Locked — this stage is completed and its data can no longer be changed.' };
    if (s.canEdit === false) return { icon: 'eye', text: 'You can see this stage but only its assigned editors can change it.' };
    if (s.singleUpdate === false && !isAdmin) return { icon: 'bulk', text: 'This stage is updated in bulk from the records table (select rows → Bulk update).' };
    return null;
  };
  // Empty fields of the active stage start with their default value (sent on Save / Complete).
  const initialDraft = (): RecordData => {
    if (record.archivedAt) return {};
    const active = new Set(record.stages.filter((s) => s.status === 'active').map((s) => s.stageKey));
    const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    return fieldDefaults(wf.fields.filter((f) => f.canEdit && active.has(f.stageKey) && !docFields.has(f.key) && !stageBlock(f.stageKey) && empty(record.data[f.key])), wf.timezone);
  };
  /*
   * Draft vs. record version. `base` is the version the draft was started from and is sent with
   * Save / Complete (optimistic concurrency). When the record changes elsewhere:
   *   - nothing typed yet → silently rebase on the new version (fresh defaults);
   *   - something typed   → keep the draft and show "changed by someone else" with Reload;
   *     saving anyway gets a 409 from the server instead of overwriting their change.
   */
  const [draft, setDraft] = useState<RecordData>(initialDraft);
  const [base, setBase] = useState(record.version);
  const [touched, setTouched] = useState(false);
  const rebase = () => {
    setBase(record.version);
    setDraft(initialDraft());
    setTouched(false);
  };
  useEffect(() => {
    if (record.version !== base && !touched) rebase();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to new versions only
  }, [record.version]);
  const stale = record.version !== base;
  const reached = (key: string) => ['active', 'done'].includes(record.stages.find((s) => s.stageKey === key)?.status ?? '');
  const editable = (f: WorkflowView['fields'][number]) => f.canEdit && !record.archivedAt && wf.isActive && reached(f.stageKey) && f.type !== 'computed' && f.type !== 'user-email' && !docFields.has(f.key) && !stageBlock(f.stageKey);
  // Changing a dropdown clears dependent dropdowns below it that no longer fit (the server clears the
  // ones this user can not edit).
  const edit = (key: string, v: FieldValue) => {
    setTouched(true);
    setDraft((d) => changeWithDependents(wf.fields, d, key, v, { context: record.data, canClear: (k) => !!wf.fields.find((f) => f.key === k && editable(f)) }));
  };
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [planned, setPlanned] = useState('');
  const history = useHistory(wf.key, record.id, true);
  const deliveries = useDeliveries(wf.key, record.id, isAdmin);
  const starts = useMemo(() => stepStarts(wf, record, history.data), [wf, record, history.data]);
  const failedSteps = useMemo(() => new Set((deliveries.data ?? []).filter((d) => d.status === 'failed' && d.stageKey).map((d) => d.stageKey!)), [deliveries.data]);

  useEffect(() => setErrors({}), [selected]);
  const merged = useMemo(() => ({ ...record.data, ...draft }), [record.data, draft]);
  const dirty = Object.keys(draft).length > 0;
  const visibleFields = tab === 'all' ? wf.fields : wf.fields.filter((f) => f.stageKey === stageDef.key);
  const block = stageBlock(stageDef.key);
  const canAct = stageState?.status === 'active' && !record.archivedAt && wf.isActive && !block && canActOn(stageDef);
  const doc = stageDef.document;
  const docFiles = doc ? record.data[doc.fieldKey] : undefined;
  const hasDoc = Array.isArray(docFiles) && docFiles.length > 0;
  const canGenerate = !!doc && stageState?.status === 'active' && !record.archivedAt && wf.isActive && stageDef.canEdit !== false && canActOn(stageDef);

  // After "Mark done": follow the record to its new current step and say who has it now.
  const completedFrom = useRef<string | null>(null);
  useEffect(() => {
    const from = completedFrom.current;
    if (!from) return;
    completedFrom.current = null;
    // Saving can complete a step too (conditions met) — only then does the page move on.
    if (record.stages.find((s) => s.stageKey === from)?.status !== 'done') return;
    setSp({}, { replace: true });
    const next = wf.stages.find((s) => s.key === record.currentStageKey);
    const name = wf.stages.find((s) => s.key === from)?.name ?? 'Step';
    if (!next) toast.success(`${name} done`, { description: 'That was the last step — the record is finished.' });
    else toast.success(`${name} done → ${next.name}`, { description: canActOn(next) && next.canEdit !== false ? 'It is your turn next.' : `Now with ${ownersOf(next).label}.` });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to the record moving on
  }, [record.version]);
  const select = (key: string) => {
    setSp(key === record.currentStageKey ? {} : { stage: key }, { replace: true });
    setTab('stage');
  };

  async function run(label: string, fn: () => Promise<unknown>, success: string) {
    setBusy(label);
    setErrors({});
    try {
      await fn();
      if (success) toast.success(success);
      setDraft({});
      setTouched(false); // the next version (our own) rebases the page
      invalidate();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.details) setErrors(e.details);
        if (e.status === 409) toast.error(e.message, { action: { label: 'Reload', onClick: () => (rebase(), invalidate()) } });
        else toast.error(e.message);
      } else toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run(
      'save',
      async () => {
        await api(`/workflows/${wf.key}/records/${record.id}`, { method: 'PATCH', body: { data: draft, version: base } });
        if (record.currentStageKey) completedFrom.current = record.currentStageKey;
      },
      'Saved',
    );
  // The toast comes once the record has moved on (it names the next step and who has it).
  const complete = () =>
    run(
      'complete',
      async () => {
        await api(`/workflows/${wf.key}/records/${record.id}/stages/${stageDef.key}/complete`, { method: 'POST', body: { data: draft, version: base } });
        completedFrom.current = stageDef.key;
      },
      '',
    );
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
    <div className="mx-auto max-w-7xl space-y-4">
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

      {stale && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm">
          <span className="flex-1 text-fg">Someone else changed this record while you were editing. Your unsaved changes are kept — reload to see theirs (this discards yours).</span>
          <Button size="sm" onClick={rebase}>
            Reload
          </Button>
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-2">
          <StepList wf={wf} record={record} selected={stageDef.key} onSelect={select} failed={failedSteps} />
        </aside>

        <div className="min-w-0 space-y-4">
          <div key={stageDef.key} className="animate-page-in">
            <StepDetails
              wf={wf}
              record={record}
              stage={stageDef}
              start={starts.get(stageDef.key)}
              deliveries={deliveries.data}
              isAdmin={isAdmin}
              onResend={async (d) => {
                try {
                  await api(`/workflows/${wf.key}/records/${record.id}/notifications/${d.id}/resend`, { method: 'POST' });
                  toast.success('Queued to send again', { description: `To ${d.recipient}. The list updates once it has gone out.` });
                  invalidate();
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            />
          </div>

      <Card bodyClassName="p-0">
        <div className="px-4 pt-3">
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: 'stage', label: stageDef.canView === false ? `${stageDef.name} (no access)` : `${stageDef.name} — fields` },
              { value: 'all', label: 'All fields' },
              { value: 'history', label: 'History' },
            ]}
          />
        </div>

        {tab === 'history' ? (
          <HistoryList wf={wf} entries={history.data} loading={history.isLoading} />
        ) : (
          <div className="space-y-4 p-4">
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
              <p className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">
                {tab === 'stage' && stageDef.canView === false ? <Lock className="size-4" /> : <Eye className="size-4" />}
                {tab === 'stage' && stageDef.canView === false ? `“${stageDef.name}” is restricted to the people assigned to it.` : tab === 'stage' ? 'This step has no fields you can see.' : 'No fields are visible to you.'}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {visibleFields.filter((f) => !(tab === 'stage' && docFields.has(f.key))).map((f) => {
                  const canType = editable(f);
                  return (
                    <FormField key={f.key} label={f.label} required={f.required} error={errors[f.key]} hint={tab === 'all' ? wf.stages.find((s) => s.key === f.stageKey)?.name : f.helpText} className={f.type === 'textarea' ? 'md:col-span-2' : undefined}>
                      {canType ? (
                        <FieldInput field={f} value={merged[f.key]} onChange={(v: FieldValue) => edit(f.key, v)} zone={wf.timezone} data={merged} invalid={!!errors[f.key]} />
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
                <Button variant="ghost" onClick={() => (setBase(record.version), setDraft({}), setTouched(false))}>
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

          <NextSteps wf={wf} record={record} stage={stageDef} onSelect={select} />
          <SubmissionItems wf={wf} record={record} onChanged={invalidate} />
          <p className="text-xs text-muted">
            Created {fmtDateTime(record.createdAt, wf.timezone)} · Updated {fmtRelative(record.updatedAt)}
          </p>
        </div>
      </div>
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
