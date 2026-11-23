import { Download } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { Badge, Button, Card, EmptyState, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { download } from '../lib/api';
import { fmtDateTime, fmtHours } from '../lib/format';
import { usePending, useSummary, useWorkflow } from '../lib/queries';
import type { StageSummaryRow } from '../lib/types';

/** Segments carry *status*, so they use the reserved status tokens and always ship with a legend + table. */
const SEGMENTS = [
  { key: 'doneOnTime', label: 'Done on time', color: 'var(--color-success)' },
  { key: 'doneLate', label: 'Done late', color: 'var(--color-warning)' },
  { key: 'overdue', label: 'Overdue', color: 'var(--color-danger)' },
  { key: 'upcoming', label: 'In progress', color: 'var(--color-muted)' },
] as const;

/** Replaces legacy Rep_Stage, Rep_Pending and Rep_Activity_Funnel. */
export default function Reports() {
  const { wf: wfKey = '' } = useParams();
  const { data: wf } = useWorkflow(wfKey);
  const summary = useSummary(wfKey);
  const [overdueOnly, setOverdueOnly] = useState(true);
  const pending = usePending(wfKey, overdueOnly);

  if (!wf) return <Spinner />;
  const stageName = (k: string) => wf.stages.find((s) => s.key === k);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title={`${wf.name} — Reports`}
        subtitle={summary.data ? `${summary.data.totalRecords} active records · updated ${fmtDateTime(summary.data.generatedAt)}` : ' '}
        actions={
          wf.canExport && (
            <Button icon={<Download className="size-4" />} onClick={() => download(`/workflows/${wf.key}/records/export.csv`, { status: 'overdue' }).catch((e: Error) => toast.error(e.message))}>
              Export overdue
            </Button>
          )
        }
      />
      <ErrorNote error={summary.error ?? pending.error} />

      <Card title="Stage funnel">
        {!summary.data ? <Spinner /> : <StageFunnel rows={summary.data.stages} />}
      </Card>

      <Card title="Stage summary" bodyClassName="p-0">
        {summary.data && (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th className="text-right">In progress</th>
                  <th className="text-right">Overdue</th>
                  <th className="text-right">Done on time</th>
                  <th className="text-right">Done late</th>
                  <th className="text-right">Skipped</th>
                  <th className="text-right">On-time rate</th>
                  <th className="text-right">Avg delay</th>
                </tr>
              </thead>
              <tbody>
                {summary.data.stages.map((s) => {
                  const done = s.doneOnTime + s.doneLate;
                  return (
                    <tr key={s.stageKey}>
                      <td>
                        <Badge color={s.color}>{s.stageName}</Badge>
                      </td>
                      <td className="text-right tabular-nums">{s.upcoming + s.unplanned}</td>
                      <td className="text-right font-medium tabular-nums">{s.overdue > 0 ? <Link className="text-danger hover:underline" to={`/w/${wf.key}?status=overdue&stage=${s.stageKey}`}>{s.overdue}</Link> : 0}</td>
                      <td className="text-right tabular-nums">{s.doneOnTime}</td>
                      <td className="text-right tabular-nums">{s.doneLate}</td>
                      <td className="text-right tabular-nums text-muted">{s.skipped}</td>
                      <td className="text-right tabular-nums">{done ? `${Math.round((s.doneOnTime / done) * 100)}%` : '—'}</td>
                      <td className="text-right tabular-nums">{s.overdue ? fmtHours(s.avgOverdueHours) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Pending tasks"
        actions={
          <label className="inline-flex items-center gap-1.5 text-sm text-muted">
            <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} /> Overdue only
          </label>
        }
        bodyClassName="p-0"
      >
        {pending.isLoading ? (
          <Spinner />
        ) : !pending.data?.length ? (
          <div className="p-4">
            <EmptyState title="No pending tasks" />
          </div>
        ) : (
          <div className="max-h-[32rem] overflow-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Record</th>
                  <th>Stage</th>
                  <th>Planned</th>
                  <th className="text-right">Delay (working h)</th>
                </tr>
              </thead>
              <tbody>
                {pending.data.map((t) => {
                  const st = stageName(t.stageKey);
                  return (
                    <tr key={`${t.recordId}:${t.stageKey}`}>
                      <td>
                        <Link className="text-primary hover:underline" to={`/w/${wf.key}/records/${t.recordId}?stage=${t.stageKey}`}>
                          #{t.recordNumber} {t.title}
                        </Link>
                      </td>
                      <td>
                        <Badge color={st?.color}>{st?.name ?? t.stageKey}</Badge>
                      </td>
                      <td className="whitespace-nowrap">{fmtDateTime(t.plannedAt, wf.timezone)}</td>
                      <td className={`text-right tabular-nums ${t.overdue ? 'font-medium text-danger' : 'text-muted'}`}>{fmtHours(t.delayHours)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Horizontal stacked bars, one per stage, sharing one scale (the largest stage total). */
function StageFunnel({ rows }: { rows: StageSummaryRow[] }) {
  const [hover, setHover] = useState<{ stage: string; label: string; value: number } | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.doneOnTime + r.doneLate + r.overdue + r.upcoming + r.unplanned));
  if (!rows.length) return <EmptyState title="No stages after intake" />;
  return (
    <div>
      <ul className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
        {SEGMENTS.map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} /> {s.label}
          </li>
        ))}
      </ul>
      <div className="space-y-3">
        {rows.map((r) => {
          const values = { doneOnTime: r.doneOnTime, doneLate: r.doneLate, overdue: r.overdue, upcoming: r.upcoming + r.unplanned };
          const total = Object.values(values).reduce((a, b) => a + b, 0);
          return (
            <div key={r.stageKey} className="grid grid-cols-[minmax(6rem,10rem)_1fr_3rem] items-center gap-3 text-sm">
              <span className="truncate text-muted" title={r.stageName}>
                {r.stageName}
              </span>
              <div className="flex h-5 gap-0.5" style={{ width: `${(total / max) * 100}%`, minWidth: total ? '0.5rem' : 0 }}>
                {SEGMENTS.map((s) => {
                  const v = values[s.key];
                  if (!v) return null;
                  return (
                    <span
                      key={s.key}
                      role="img"
                      aria-label={`${r.stageName}: ${s.label} ${v}`}
                      className="h-full first:rounded-l last:rounded-r"
                      style={{ flexGrow: v, background: s.color, opacity: hover && (hover.stage !== r.stageKey || hover.label !== s.label) ? 0.45 : 1 }}
                      onMouseEnter={() => setHover({ stage: r.stageKey, label: s.label, value: v })}
                      onMouseLeave={() => setHover(null)}
                    />
                  );
                })}
              </div>
              <span className="text-right tabular-nums text-muted">{total}</span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 h-4 text-xs text-muted" aria-live="polite">
        {hover ? `${rows.find((r) => r.stageKey === hover.stage)?.stageName} — ${hover.label}: ${hover.value}` : 'Hover a segment for details'}
      </p>
    </div>
  );
}
