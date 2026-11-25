import { Activity, AlertTriangle, ArrowUpRight, CheckCircle2, ClipboardList, FilePlus2, PlusCircle, Timer, Users, Workflow } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { OnTimeMeter, TeamBars, TrendChart } from '../components/charts';
import { CreateFlowDialog } from '../components/CreateFlowDialog';
import { DashboardTiles } from '../components/DashboardTiles';
import { Badge, Button, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';
import { fmtNumber, fmtRelative } from '../lib/format';
import { useDashboard, useMyTasks } from '../lib/queries';
import type { DashboardData, DashboardFlow } from '../lib/types';

/** Cards rise a little and gain depth on hover. */
const lift = 'transition-[transform,box-shadow,border-color] duration-300 ease-[var(--ease-apple)] hover:-translate-y-0.5 hover:border-line hover:shadow-[var(--shadow-float)]';

/**
 * Flows dashboard, on the app's own card surfaces (same as every other page, in light and dark):
 * numbers first, then trend and on-time performance, then where the work sits (teams, flows) and
 * what just happened.
 */
export default function Dashboard() {
  const { user, can } = useAuth();
  const { data, error, isLoading } = useDashboard();
  const tasks = useMyTasks();
  const [create, setCreate] = useState(false);
  const myOverdue = tasks.data?.filter((t) => t.overdue).length ?? 0;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="mx-auto max-w-7xl">
      <div>
        <section className="card relative mb-5 flex flex-wrap items-center gap-4 overflow-hidden bg-[linear-gradient(120deg,var(--color-surface)_45%,var(--color-surface-2)_100%)] p-6">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-muted">{greeting},</p>
            <h1 className="text-[28px] font-semibold leading-tight">{user?.name?.split(' ')[0]}</h1>
            <p className="mt-1 text-[15px] text-muted">Here is how every flow in {user?.org.name} is moving.</p>
          </div>
          <Link to="/tasks" className="group flex items-center gap-3 rounded-2xl border border-line/80 bg-surface px-4 py-3 shadow-[var(--shadow-soft)] transition-[transform,box-shadow,border-color] duration-300 ease-[var(--ease-apple)] hover:-translate-y-0.5 hover:border-line hover:shadow-[var(--shadow-float)]">
            <span className="grid size-10 place-items-center rounded-full bg-primary text-primary-fg">
              <ClipboardList className="size-5 stroke-[1.75]" />
            </span>
            <span>
              <span className="block text-sm font-semibold">My tasks</span>
              <span className="block text-[13px] text-muted">
                {tasks.data ? `${tasks.data.length} waiting on you` : 'Loading…'}
                {myOverdue > 0 && (
                  <span className="ml-1.5 inline-flex items-center gap-1 font-medium text-danger">
                    <AlertTriangle className="size-3.5" /> {myOverdue} overdue
                  </span>
                )}
              </span>
            </span>
            <ArrowUpRight className="size-4 text-muted transition-transform duration-300 ease-[var(--ease-apple)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-fg" />
          </Link>
          {can('ADMIN') && (
            <Button variant="primary" icon={<PlusCircle className="size-4" />} onClick={() => setCreate(true)}>
              Create Flow
            </Button>
          )}
        </section>

        <ErrorNote error={error} />
        {isLoading || !data ? (
          !error && <Spinner />
        ) : (
          <Body data={data} />
        )}
      </div>
      {create && <CreateFlowDialog onClose={() => setCreate(false)} />}
    </div>
  );
}

function Body({ data }: { data: DashboardData }) {
  const { can } = useAuth();
  const trend = data?.trend ?? [];
  const created14 = trend.reduce((s, d) => s + (d.created ?? 0), 0);
  const completed14 = trend.reduce((s, d) => s + (d.completed ?? 0), 0);
  const totals = data?.totals ?? { flows: 0, drafts: 0, openRecords: 0, overdue: 0, created7d: 0, completed7d: 0 };
  const onTime = data?.onTime ?? { onTime: 0, late: 0, avgLateHours: null };
  const teams = data?.teams ?? [];
  const activity = data?.activity ?? [];
  const flows = data?.flows ?? [];
  const timezone = data?.timezone ?? 'Asia/Kolkata';

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile icon={<Workflow />} label="Live flows" value={totals.flows} note={totals.drafts ? `${totals.drafts} draft${totals.drafts === 1 ? '' : 's'}` : 'No drafts'} />
        <Tile icon={<ClipboardList />} label="Open records" value={totals.openRecords} note="across all flows" />
        <Tile icon={<AlertTriangle />} label="Overdue stages" value={totals.overdue} danger={totals.overdue > 0} note={totals.overdue ? 'need attention' : 'all on track'} />
        <Tile icon={<FilePlus2 />} label="Created, 7 days" value={totals.created7d} note={`${created14} in 14 days`} />
        <Tile icon={<CheckCircle2 />} label="Completed, 7 days" value={totals.completed7d} note={`${completed14} in 14 days`} />
      </div>

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2" icon={<Activity />} title="Throughput" subtitle={`Records created and completed per day · last 14 days · ${timezone}`}>
          <TrendChart data={trend} />
        </Panel>
        <Panel icon={<Timer />} title="On-time completion" subtitle="Stages with a due time, last 30 days">
          <OnTimeMeter {...onTime} />
        </Panel>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel className={can('ADMIN') ? 'lg:col-span-2' : 'lg:col-span-3'} icon={<Users />} title="Open work by team" subtitle="Active stages owned by each group">
          <TeamBars teams={teams} />
        </Panel>
        {can('ADMIN') && (
          <Panel icon={<Activity />} title="Recent activity" subtitle="Latest record changes">
            {activity.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted">Nothing yet.</p>
            ) : (
              <ol className="relative space-y-3 before:absolute before:bottom-1 before:left-[5px] before:top-1 before:w-px before:bg-line">
                {activity.map((a) => (
                  <li key={a.id} className="relative pl-5">
                    <span className="absolute left-0 top-1.5 size-[11px] rounded-full border-2 border-surface bg-primary" aria-hidden />
                    <p className="text-[13px]">
                      <span className="font-medium">{a.actorEmail?.split('@')[0] ?? 'System'}</span> <span className="text-muted">{actionText(a.action)}</span>{' '}
                      {a.flowKey && a.recordNumber ? (
                        <Link className="font-medium hover:underline" to={`/w/${a.flowKey}/records/${a.recordId}`}>
                          #{a.recordNumber}
                        </Link>
                      ) : (
                        'a record'
                      )}
                    </p>
                    <p className="text-xs text-muted">
                      {a.flowName ? `${a.flowName} · ` : ''}
                      {fmtRelative(a.createdAt)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        )}
      </div>

      <DashboardTiles />

      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">Flows</h2>
      {flows.length === 0 ? (
        <EmptyState title="No flows yet">{can('ADMIN') ? 'Create one, or start from a template.' : 'Ask an administrator to set one up.'}</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {flows.map((f) => (
            <FlowCard key={f.key} flow={f} />
          ))}
        </div>
      )}
    </>
  );
}

const actionText = (action: string) =>
  ({ 'record.created': 'created', 'record.updated': 'updated', 'record.stage_completed': 'completed a stage on', 'record.planned_set': 'set a due time on', 'record.archived': 'archived', 'record.restored': 'restored' })[action] ??
  action.replace(/^record\./, '').replace(/_/g, ' ');

function Panel({ icon, title, subtitle, children, className }: { icon: ReactNode; title: string; subtitle?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`card flex flex-col p-5 ${className ?? ''}`}>
      <header className="mb-4 flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-fg [&>svg]:size-4 [&>svg]:stroke-[1.75]">{icon}</span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
        </div>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function Tile({ icon, label, value, note, danger }: { icon: ReactNode; label: string; value: number; note?: string; danger?: boolean }) {
  return (
    <div className={`card p-4 ${lift}`}>
      <div className="mb-3 flex items-center gap-2 text-[13px] text-muted">
        <span className={`grid size-7 place-items-center rounded-lg [&>svg]:size-4 [&>svg]:stroke-[1.75] ${danger ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-fg'}`}>{icon}</span>
        {label}
      </div>
      <p className={danger ? 'text-[32px] font-semibold leading-none text-danger' : 'text-[32px] font-semibold leading-none'}>{fmtNumber(value)}</p>
      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
    </div>
  );
}

const STATUS = { active: ['Active', 'success'], inactive: ['Inactive', 'neutral'], draft: ['Draft', 'info'] } as const;

function FlowCard({ flow: f }: { flow: DashboardFlow }) {
  const [hover, setHover] = useState<string | null>(null);
  const withOpen = f.stages.filter((s) => s.active > 0);
  const total = withOpen.reduce((s, x) => s + x.active, 0);
  const hovered = f.stages.find((s) => s.key === hover);
  return (
    <article className={`card p-5 ${lift}`}>
      <div className="mb-4 flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <Link to={f.status === 'draft' ? `/flows/${f.key}/editor` : `/w/${f.key}`} className="font-semibold hover:underline">
            {f.name}
          </Link>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Badge tone={STATUS[f.status][1]}>{STATUS[f.status][0]}</Badge>
            {f.label && <Badge>{f.label}</Badge>}
            updated {fmtRelative(f.updatedAt)}
          </p>
        </div>
        <dl className="flex gap-5 text-right">
          <div>
            <dt className="text-xs text-muted">Open</dt>
            <dd className="text-lg font-semibold tabular-nums">{fmtNumber(f.open)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Overdue</dt>
            <dd className={f.overdue ? 'text-lg font-semibold tabular-nums text-danger' : 'text-lg font-semibold tabular-nums'}>{fmtNumber(f.overdue)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Done 7d</dt>
            <dd className="text-lg font-semibold tabular-nums">{fmtNumber(f.completed7d)}</dd>
          </div>
        </dl>
      </div>

      <p className="mb-1.5 text-xs text-muted">Open records by current stage</p>
      {total === 0 ? (
        <div className="h-3 rounded-full bg-surface-2" aria-label="No open records" />
      ) : (
        <div className="relative">
          {/* 2px surface gap between segments; colour = the stage's own colour (follows the stage). */}
          <div className="flex h-3 gap-[2px] overflow-hidden rounded-full" role="img" aria-label={withOpen.map((s) => `${s.name}: ${s.active}`).join(', ')}>
            {withOpen.map((s) => (
              <div
                key={s.key}
                className="h-full transition-opacity duration-200"
                style={{ width: `${(s.active / total) * 100}%`, minWidth: 4, background: s.color, opacity: hover && hover !== s.key ? 0.35 : 1 }}
                onMouseEnter={() => setHover(s.key)}
                onMouseLeave={() => setHover(null)}
              />
            ))}
          </div>
          {hovered && (
            <div className="pointer-events-none absolute -top-10 left-0 z-10 animate-pop-in rounded-xl border border-line bg-surface/95 px-2.5 py-1 text-xs shadow-[var(--shadow-float)] backdrop-blur">
              <span className="font-medium">{hovered.name}</span>: {hovered.active} open{hovered.overdue ? `, ${hovered.overdue} overdue` : ''}
            </div>
          )}
        </div>
      )}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        {f.stages.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5" onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}>
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
            <span className="text-fg">{s.name}</span>
            <span className="tabular-nums text-muted">{s.active}</span>
            {s.overdue > 0 && (
              <span className="inline-flex items-center gap-0.5 font-medium text-danger">
                <AlertTriangle className="size-3" />
                {s.overdue} late
              </span>
            )}
          </li>
        ))}
      </ul>
    </article>
  );
}
