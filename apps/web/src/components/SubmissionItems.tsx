/**
 * Items of a multi-item submission (legacy EditResponse): every record that came in with this one,
 * adding more items later (they get the submission's header values) and removing one (archived).
 */
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Archive, Layers, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { FieldValue } from '@fms/core';
import { api, ApiError } from '../lib/api';
import { displayValue } from '../lib/format';
import type { RecordData, RecordDto, RecordList, WorkflowView } from '../lib/types';
import { changeWithDependents, FieldInput, fieldDefaults } from './FieldInput';
import { CurrentStageBadge } from './Stage';
import { Button, FormField } from './ui';

export function SubmissionItems({ wf, record, onChanged }: { wf: WorkflowView; record: RecordDto; onChanged: () => void }) {
  const items = useQuery({
    queryKey: ['records', wf.key, { submissionId: record.submissionId }],
    queryFn: () => api<RecordList>(`/workflows/${wf.key}/records`, { query: { submissionId: record.submissionId, status: undefined, pageSize: 200, sort: 'number', dir: 'asc' } }).then((r) => r.items),
    enabled: !!record.submissionId,
  });
  const itemFields = wf.fields.filter((f) => f.lineItem && f.stageKey === wf.stages[0]?.key);
  const editable = itemFields.filter((f) => f.canEdit && f.type !== 'computed' && f.type !== 'user-email');
  const [adding, setAdding] = useState<RecordData[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (!record.submissionId || !itemFields.length) return null;
  const columns = itemFields.slice(0, 5);

  async function add() {
    if (!adding) return;
    setBusy(true);
    setErrors({});
    try {
      const r = await api<{ records: RecordDto[] }>(`/workflows/${wf.key}/records/${record.id}/items`, { method: 'POST', body: { items: adding } });
      toast.success(`${r.records.length} item${r.records.length === 1 ? '' : 's'} added`, { description: r.records.map((x) => `#${x.number}`).join(', ') });
      setAdding(null);
      onChanged();
      void items.refetch();
    } catch (e) {
      if (e instanceof ApiError && e.details) setErrors(e.details);
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(r: RecordDto) {
    if (!confirm(`Remove item #${r.number} from this submission? It is archived and can be restored.`)) return;
    try {
      await api(`/workflows/${wf.key}/records/archive`, { method: 'POST', body: { ids: [r.id] } });
      toast.success(`#${r.number} archived`);
      onChanged();
      void items.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const list = items.data ?? [];
  return (
    <section className="card p-5" aria-label="Items in this submission">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <Layers className="size-4 text-muted" />
        <h2 className="flex-1 text-[15px] font-semibold">Items in this submission</h2>
        <span className="text-xs text-muted">{list.length} item{list.length === 1 ? '' : 's'}</span>
        {wf.canCreate && wf.isActive && !record.archivedAt && !adding && editable.length > 0 && (
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding([fieldDefaults(editable, wf.timezone)])}>
            Add items
          </Button>
        )}
      </header>
      <div className="overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>#</th>
              {columns.map((f) => (
                <th key={f.key}>{f.label}</th>
              ))}
              <th>Stage</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className={clsx(r.id === record.id && 'bg-info-soft/60')}>
                <td className="font-medium tabular-nums">
                  {r.id === record.id ? (
                    `#${r.number}`
                  ) : (
                    <Link className="text-info hover:underline" to={`/w/${wf.key}/records/${r.id}`}>
                      #{r.number}
                    </Link>
                  )}
                </td>
                {columns.map((f) => (
                  <td key={f.key}>{displayValue(f, r.data[f.key], wf.timezone) || <span className="text-muted">—</span>}</td>
                ))}
                <td>
                  <CurrentStageBadge stages={r.stages} defs={wf.stages} currentStageKey={r.currentStageKey} />
                </td>
                <td className="text-right">
                  {wf.canArchive && list.length > 1 && (
                    <Button size="xs" variant="ghost" aria-label={`Archive item #${r.number}`} icon={<Archive />} onClick={() => void remove(r)} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && (
        <div className="mt-4 space-y-3 rounded-2xl border border-line bg-surface-2/40 p-4">
          <p className="text-sm font-semibold">New items</p>
          <p className="text-xs text-muted">They join this submission with its details ({wf.fields.filter((f) => !f.lineItem && f.stageKey === wf.stages[0]?.key).slice(0, 3).map((f) => f.label).join(', ') || 'header fields'}) and start the flow like the others.</p>
          {adding.map((it, i) => (
            <div key={i} className="rounded-xl border border-line bg-surface p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">Item {i + 1}</span>
                <Button size="xs" variant="ghost" aria-label="Remove this new item" icon={<X />} onClick={() => setAdding(adding.length === 1 ? null : adding.filter((_, j) => j !== i))} />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {editable.map((f) => (
                  <FormField key={f.key} label={f.label} required={f.required} error={errors[`items.${i}.${f.key}`]}>
                    <FieldInput
                      field={f}
                      value={it[f.key]}
                      onChange={(v: FieldValue) => setAdding(adding.map((x, j) => (j === i ? changeWithDependents(wf.fields, x, f.key, v, { context: record.data }) : x)))}
                      zone={wf.timezone}
                      data={{ ...record.data, ...it }}
                      invalid={!!errors[`items.${i}.${f.key}`]}
                    />
                  </FormField>
                ))}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap justify-between gap-2">
            <Button size="sm" variant="soft" icon={<Plus className="size-4" />} onClick={() => setAdding([...adding, fieldDefaults(editable, wf.timezone)])}>
              Another item
            </Button>
            <span className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => (setAdding(null), setErrors({}))}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" loading={busy} onClick={() => void add()}>
                Add {adding.length} item{adding.length === 1 ? '' : 's'}
              </Button>
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
