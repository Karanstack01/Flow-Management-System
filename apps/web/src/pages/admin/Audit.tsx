import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { toast } from 'sonner';
import { MANUAL_JOBS } from '@fms/core';
import { Badge, Button, Card, PageHeader, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';

interface AuditRow {
  id: string;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string;
  ip: string | null;
  createdAt: string;
}
interface JobRow {
  id: string;
  name: string;
  status: string;
  stats: Record<string, number> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  scope: 'platform' | 'organization';
  requestedBy: string | null;
}

export default function AuditAdmin() {
  const { can } = useAuth();
  const isAdmin = can('ADMIN');
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => api<{ items: JobRow[] }>('/admin/jobs').then((r) => r.items), refetchInterval: 15_000 });
  // The audit log is admin-only; RUN_JOBS alone gives the jobs card.
  const audit = useInfiniteQuery({
    enabled: isAdmin,
    queryKey: ['audit'],
    queryFn: ({ pageParam }) => api<{ items: AuditRow[]; nextCursor: string | null }>('/admin/audit', { query: { cursor: pageParam ?? undefined } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  async function run(name: string) {
    try {
      await api(`/admin/jobs/${name}/run`, { method: 'POST' });
      toast.success(`${name} queued`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title={isAdmin ? 'Audit & jobs' : 'Automation jobs'} subtitle={`${isAdmin ? 'Who changed what, and when automation last ran.' : 'When automation last ran.'} Manual runs here only process this organization.`} />
      <Card
        title="Background jobs"
        actions={
          can('RUN_JOBS') &&
          MANUAL_JOBS.map((j) => (
            <Button key={j} size="sm" icon={<Play className="size-3.5" />} onClick={() => void run(j)}>
              {j}
            </Button>
          ))
        }
        bodyClassName="p-0"
      >
        {!jobs.data ? (
          <Spinner />
        ) : (
          <div className="max-h-80 overflow-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Scope</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {jobs.data.map((j) => (
                  <tr key={j.id}>
                    <td className="font-medium">{j.name}</td>
                    <td className="text-xs text-muted">{j.scope === 'organization' ? `This organization${j.requestedBy ? ` · ${j.requestedBy}` : ''}` : 'Scheduled (all)'}</td>
                    <td>
                      <Badge tone={j.status === 'succeeded' ? 'success' : j.status === 'failed' ? 'danger' : 'warning'}>{j.status}</Badge>
                    </td>
                    <td className="whitespace-nowrap text-muted">{fmtDateTime(j.startedAt)}</td>
                    <td className="text-xs text-muted">{j.error ? <span className="text-danger">{j.error.split('\n')[0]}</span> : j.stats ? Object.entries(j.stats).map(([k, v]) => `${k}: ${v}`).join(' · ') : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {isAdmin && <Card title="Audit log" bodyClassName="p-0">
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
                    <th>Entity</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.pages.flatMap((p) => p.items).map((a) => (
                    <tr key={a.id}>
                      <td className="whitespace-nowrap text-muted">{fmtDateTime(a.createdAt)}</td>
                      <td>{a.actorEmail ?? 'System'}</td>
                      <td>
                        <Badge>{a.action}</Badge>
                      </td>
                      <td className="text-xs text-muted">
                        {a.entityType} · {a.entityId}
                      </td>
                      <td className="text-xs text-muted">{a.ip}</td>
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
      </Card>}
    </div>
  );
}
