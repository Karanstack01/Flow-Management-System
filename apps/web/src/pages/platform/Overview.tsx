import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Building2, ClipboardList, Mail, Play, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { MANUAL_JOBS } from '@fms/core';
import { Badge, Button, Card, ErrorNote, PageHeader, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDateTime, fmtNumber, fmtRelative } from '../../lib/format';
import type { PlatformOverview } from '../../lib/types';

interface PlatformAuditRow {
  id: string;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string;
  orgName: string;
  createdAt: string;
}

function Tile({ icon, label, value, note, tone }: { icon: ReactNode; label: string; value: string; note?: ReactNode; tone?: 'danger' }) {
  return (
    <div className="card flex items-start gap-3 p-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-muted [&>svg]:size-4">{icon}</span>
      <div className="min-w-0">
        <p className={tone === 'danger' ? 'text-2xl font-semibold tabular-nums text-danger' : 'text-2xl font-semibold tabular-nums'}>{value}</p>
        <p className="text-xs text-muted">{label}</p>
        {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
      </div>
    </div>
  );
}

export default function PlatformOverviewPage() {
  const overview = useQuery({ queryKey: ['platform-overview'], queryFn: () => api<PlatformOverview>('/platform/overview'), refetchInterval: 30_000 });
  const audit = useInfiniteQuery({
    queryKey: ['platform-audit'],
    queryFn: ({ pageParam }) => api<{ items: PlatformAuditRow[]; nextCursor: string | null }>('/platform/audit', { query: { cursor: pageParam ?? undefined } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  async function runEverywhere(name: string) {
    try {
      await api(`/platform/jobs/${name}/run`, { method: 'POST', body: { orgId: null } });
      toast.success(`${name} queued for every organization`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const o = overview.data;
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title="Platform overview" subtitle="Health of every organization on this installation." />
      <ErrorNote error={overview.error} />
      {!o ? (
        !overview.error && <Spinner />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile icon={<Building2 />} label="Organizations live" value={fmtNumber(o.organizations.live)} note={o.organizations.closed ? `${o.organizations.closed} suspended or expired` : 'None suspended'} />
          <Tile icon={<Users />} label="Active users" value={fmtNumber(o.users.active)} note={`${o.users.superAdmins} super admin${o.users.superAdmins === 1 ? '' : 's'}`} />
          <Tile icon={<ClipboardList />} label="Open records" value={fmtNumber(o.openRecords)} note={`${o.workflows} active workflow${o.workflows === 1 ? '' : 's'}`} />
          <Tile icon={<AlertTriangle />} label="Overdue stages" value={fmtNumber(o.overdueStages)} tone={o.overdueStages ? 'danger' : undefined} />
          <Tile
            icon={<Mail />}
            label="Notifications, last 24 h"
            value={fmtNumber(o.notifications24h.sent)}
            note={o.notifications24h.failed ? <span className="text-danger">{o.notifications24h.failed} failed</span> : 'No failures'}
          />
        </div>
      )}

      <Card
        title="Automation (all organizations)"
        actions={MANUAL_JOBS.map((j) => (
          <Button key={j} size="sm" icon={<Play className="size-3.5" />} onClick={() => void runEverywhere(j)}>
            {j}
          </Button>
        ))}
        bodyClassName="p-0"
      >
        {!o ? (
          <Spinner />
        ) : o.jobs.length === 0 ? (
          <p className="p-4 text-sm text-muted">No scheduled run recorded yet. Is the worker running?</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Last run</th>
                  <th>Status</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {o.jobs.map((j) => (
                  <tr key={j.name}>
                    <td className="font-medium">{j.name}</td>
                    <td className="whitespace-nowrap text-muted" title={fmtDateTime(j.startedAt)}>
                      {fmtRelative(j.startedAt)}
                    </td>
                    <td>
                      <Badge tone={j.status === 'succeeded' ? 'success' : j.status === 'failed' ? 'danger' : 'warning'}>{j.status}</Badge>
                    </td>
                    <td className="text-xs text-danger">{j.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Platform activity" bodyClassName="p-0">
        {!audit.data ? (
          <Spinner />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>Action</th>
                    <th>Organization</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.pages.flatMap((p) => p.items).map((a) => (
                    <tr key={a.id}>
                      <td className="whitespace-nowrap text-muted">{fmtDateTime(a.createdAt)}</td>
                      <td>{a.actorEmail ?? 'System'}</td>
                      <td>
                        <Badge>{a.action.replace(/^platform\./, '')}</Badge>
                      </td>
                      <td className="text-muted">{a.orgName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {audit.hasNextPage && (
              <div className="p-3">
                <Button loading={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
