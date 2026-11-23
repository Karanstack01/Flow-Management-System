import { AlarmClock, CheckCircle2, Clock } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Badge, Card, EmptyState, ErrorNote, PageHeader, Spinner, Tabs } from '../components/ui';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtHours } from '../lib/format';
import { useMyTasks } from '../lib/queries';

/** "My work" — every active stage the user is responsible for, across workflows. */
export default function MyTasks() {
  const { user } = useAuth();
  const { data: tasks, isLoading, error } = useMyTasks();
  const [tab, setTab] = useState<'overdue' | 'upcoming' | 'all'>('overdue');

  const overdue = tasks?.filter((t) => t.overdue) ?? [];
  const upcoming = tasks?.filter((t) => !t.overdue) ?? [];
  const list = tab === 'overdue' ? overdue : tab === 'upcoming' ? upcoming : (tasks ?? []);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="My Tasks" subtitle={`Hi ${user?.name?.split(' ')[0] ?? ''} — every stage waiting on the groups you belong to`} />
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat icon={<AlarmClock className="size-5 text-danger" />} label="Overdue" value={overdue.length} />
        <Stat icon={<Clock className="size-5 text-warning" />} label="Due / upcoming" value={upcoming.length} />
        <Stat icon={<CheckCircle2 className="size-5 text-success" />} label="Total open tasks" value={tasks?.length ?? 0} />
      </div>
      <Card bodyClassName="p-0">
        <div className="px-4 pt-2">
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: 'overdue', label: `Overdue (${overdue.length})` },
              { value: 'upcoming', label: `Upcoming (${upcoming.length})` },
              { value: 'all', label: 'All' },
            ]}
          />
        </div>
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <div className="p-4">
            <ErrorNote error={error} />
          </div>
        ) : list.length === 0 ? (
          <div className="p-4">
            <EmptyState title="Nothing here">You're all caught up.</EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Record</th>
                  <th>Workflow</th>
                  <th>Stage</th>
                  <th>Planned</th>
                  <th>Delay</th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <tr key={`${t.recordId}:${t.stageKey}`} className="hover:bg-surface-2">
                    <td>
                      <Link className="font-medium text-primary hover:underline" to={`/w/${t.workflowKey}/records/${t.recordId}?stage=${t.stageKey}`}>
                        #{t.recordNumber} {t.title}
                      </Link>
                    </td>
                    <td className="text-muted">{t.workflowName}</td>
                    <td>
                      <Badge color={t.stageColor}>{t.stageName}</Badge>
                    </td>
                    <td className="whitespace-nowrap">{fmtDateTime(t.plannedAt)}</td>
                    <td className={t.overdue ? 'whitespace-nowrap font-medium text-danger' : 'whitespace-nowrap text-muted'}>{fmtHours(t.delayHours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="card flex items-center gap-3 p-4">
      <span className="grid size-10 place-items-center rounded-full bg-surface-2">{icon}</span>
      <div>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <p className="text-xs text-muted">{label}</p>
      </div>
    </div>
  );
}
