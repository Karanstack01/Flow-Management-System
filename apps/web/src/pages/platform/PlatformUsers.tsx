import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Search, ShieldCheck, ShieldOff } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, ErrorNote, Input, PageHeader, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';
import type { PlatformUser } from '../../lib/types';

export default function PlatformUsersPage() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const [q, setQ] = useState('');
  const [onlySuper, setOnlySuper] = useState(false);
  const query = useDeferredValue(q.trim());
  const users = useQuery({
    queryKey: ['platform-users', query, onlySuper],
    queryFn: () => api<{ items: PlatformUser[] }>('/platform/users', { query: { q: query || undefined, superAdmins: onlySuper ? 'true' : undefined } }).then((r) => r.items),
    placeholderData: (prev) => prev,
  });
  const [busy, setBusy] = useState<string | null>(null);

  async function act(u: PlatformUser, kind: 'grant' | 'revoke' | 'signout') {
    const prompts = {
      grant: `Make ${u.name} a super admin? They will be able to see and change every organization.`,
      revoke: `Remove super admin access from ${u.name}?`,
      signout: `Sign ${u.name} out on every device and clear any lockout?`,
    };
    if (!window.confirm(prompts[kind])) return;
    setBusy(u.id);
    try {
      if (kind === 'signout') await api(`/platform/users/${u.id}/revoke-sessions`, { method: 'POST' });
      else await api(`/platform/users/${u.id}/super-admin`, { method: 'PUT', body: { enabled: kind === 'grant' } });
      toast.success(kind === 'signout' ? 'Signed out everywhere' : kind === 'grant' ? `${u.name} is now a super admin` : 'Super admin access removed');
      void qc.invalidateQueries({ queryKey: ['platform-users'] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title="All users & super admins" subtitle="Find anyone on the platform. Group membership is managed by each organization’s admins under Users & groups." />
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input className="pl-8" placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" />
        </div>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={onlySuper} onChange={(e) => setOnlySuper(e.target.checked)} /> Only super admins
        </label>
      </div>
      <ErrorNote error={users.error} />
      <Card bodyClassName="p-0">
        {!users.data ? (
          !users.error && <Spinner />
        ) : users.data.length === 0 ? (
          <p className="p-4 text-sm text-muted">No users match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Organization</th>
                  <th>Role</th>
                  <th>Last sign-in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <p className="font-medium">
                        {u.name} {!u.isActive && <Badge tone="danger">Disabled</Badge>} {u.locked && <Badge tone="warning">Locked</Badge>}
                      </p>
                      <p className="text-xs text-muted">{u.email}</p>
                    </td>
                    <td className="text-muted">{u.org.name}</td>
                    <td>{u.isSuperAdmin ? <Badge tone="primary">Super admin</Badge> : <span className="text-muted">Organization user</span>}</td>
                    <td className="whitespace-nowrap text-muted">{u.lastLoginAt ? fmtRelative(u.lastLoginAt) : 'Never'}</td>
                    <td>
                      <span className="flex justify-end gap-1">
                        {u.isSuperAdmin ? (
                          u.id !== me?.id && (
                            <Button size="sm" icon={<ShieldOff className="size-3.5" />} loading={busy === u.id} onClick={() => void act(u, 'revoke')}>
                              Remove super admin
                            </Button>
                          )
                        ) : (
                          u.isActive && (
                            <Button size="sm" icon={<ShieldCheck className="size-3.5" />} loading={busy === u.id} onClick={() => void act(u, 'grant')}>
                              Make super admin
                            </Button>
                          )
                        )}
                        {u.id !== me?.id && <Button size="sm" variant="ghost" aria-label={`Sign out ${u.name} everywhere`} title="Sign out everywhere" icon={<LogOut className="size-4" />} onClick={() => void act(u, 'signout')} />}
                      </span>
                    </td>
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
