import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { CAPABILITIES, type Capability, type ConditionGroup } from '@fms/core';
import { ConditionEditor } from '../../components/ConditionEditor';
import { Badge, Button, Card, FormField, Input, Modal, PageHeader, Spinner, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtRelative } from '../../lib/format';
import { useWorkflow, useWorkflows } from '../../lib/queries';

interface UserRow {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  isActive: boolean;
  groups: string[];
  rowFilter: ConditionGroup | null;
  lastLoginAt: string | null;
  locked: boolean;
  isSuperAdmin: boolean;
}
interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  capabilities: Capability[];
  members: number;
}

const CAP_HELP: Record<Capability, string> = {
  ADMIN: 'Everything in this organization, including configuration',
  CREATE: 'Create records',
  DELETE: 'Archive / restore records',
  RUN_JOBS: 'Run automation jobs manually',
  EXPORT: 'Export CSV',
  MANAGE_RULES: 'Edit notification rules',
};

export default function UsersAdmin() {
  const qc = useQueryClient();
  const { isSuperAdmin } = useAuth();
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ items: UserRow[] }>('/admin/users').then((r) => r.items) });
  const groups = useQuery({ queryKey: ['admin-groups'], queryFn: () => api<{ items: GroupRow[] }>('/admin/groups').then((r) => r.items) });
  const [editUser, setEditUser] = useState<UserRow | 'new' | null>(null);
  const [editGroup, setEditGroup] = useState<GroupRow | 'new' | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin-users'] });
    void qc.invalidateQueries({ queryKey: ['admin-groups'] });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title="Users & groups" subtitle="Groups grant capabilities and control which fields people can see and edit." />
      <Card title="Users" actions={<Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditUser('new')}>Add user</Button>} bodyClassName="p-0">
        {!users.data ? (
          <Spinner />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Groups</th>
                  <th>Row filter</th>
                  <th>Last sign-in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => (
                  <tr key={u.id}>
                    <td className="font-medium">
                      {u.name} {u.isSuperAdmin && <Badge tone="primary">Super admin</Badge>} {!u.isActive && <Badge tone="danger">Disabled</Badge>} {u.locked && <Badge tone="warning">Locked</Badge>}
                    </td>
                    <td className="text-muted">{u.email}</td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        {u.groups.map((g) => (
                          <Badge key={g}>{g}</Badge>
                        ))}
                      </span>
                    </td>
                    <td className="text-muted">{u.rowFilter?.conditions?.length ? `${u.rowFilter.conditions.length} condition(s)` : 'All records'}</td>
                    <td className="text-muted">{u.lastLoginAt ? fmtRelative(u.lastLoginAt) : 'Never'}</td>
                    <td>
                      {u.isSuperAdmin && !isSuperAdmin ? (
                        <span className="text-xs text-muted" title="Platform accounts are managed by super admins">Managed by platform</span>
                      ) : (
                        <Button size="sm" variant="ghost" aria-label={`Edit ${u.name}`} icon={<Pencil className="size-4" />} onClick={() => setEditUser(u)} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Groups" actions={<Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditGroup('new')}>Add group</Button>} bodyClassName="p-0">
        {!groups.data ? (
          <Spinner />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Group</th>
                <th>Capabilities</th>
                <th>Members</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {groups.data.map((g) => (
                <tr key={g.id}>
                  <td>
                    <p className="font-medium">{g.name}</p>
                    <p className="text-xs text-muted">{g.description}</p>
                  </td>
                  <td>
                    <span className="flex flex-wrap gap-1">
                      {g.capabilities.map((c) => (
                        <Badge key={c} tone="primary">
                          {c}
                        </Badge>
                      ))}
                    </span>
                  </td>
                  <td className="tabular-nums">{g.members}</td>
                  <td>
                    <Button size="sm" variant="ghost" aria-label={`Edit ${g.name}`} icon={<Pencil className="size-4" />} onClick={() => setEditGroup(g)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editUser && <UserDialog user={editUser === 'new' ? null : editUser} groups={groups.data ?? []} onClose={() => setEditUser(null)} onSaved={refresh} />}
      {editGroup && <GroupDialog group={editGroup === 'new' ? null : editGroup} onClose={() => setEditGroup(null)} onSaved={refresh} />}
    </div>
  );
}

function UserDialog({ user, groups, onClose, onSaved }: { user: UserRow | null; groups: GroupRow[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: user?.name ?? '', email: user?.email ?? '', phone: user?.phone ?? '', isActive: user?.isActive ?? true, groups: user?.groups ?? [], password: '' });
  const [rowFilter, setRowFilter] = useState<ConditionGroup>(user?.rowFilter ?? { mode: 'all', conditions: [] });
  const [busy, setBusy] = useState(false);
  const { data: workflows } = useWorkflows();
  const { data: wf } = useWorkflow(workflows?.[0]?.key ?? '');

  async function save() {
    setBusy(true);
    try {
      const body = { ...form, phone: form.phone || null, password: form.password || undefined, rowFilter: rowFilter.conditions.length ? rowFilter : null };
      await api(user ? `/admin/users/${user.id}` : '/admin/users', { method: user ? 'PUT' : 'POST', body });
      toast.success('User saved');
      onSaved();
      onClose();
    } catch (e) {
      const d = (e as { details?: Record<string, string> }).details;
      toast.error((e as Error).message, { description: d ? Object.values(d).join('; ') : undefined });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={user ? `Edit ${user.name}` : 'Add user'} wide footer={<Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button>}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <FormField label="Name" required>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </FormField>
        <FormField label="Email" required>
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </FormField>
        <FormField label="Phone (WhatsApp)">
          <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </FormField>
        <FormField label={user ? 'New password (optional)' : 'Password'} required={!user} hint="At least 10 characters with letters and numbers">
          <Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </FormField>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Active
        </label>
      </div>
      <p className="label mt-4">Groups</p>
      <div className="flex flex-wrap gap-2">
        {groups.map((g) => (
          <label key={g.id} className="inline-flex items-center gap-1.5 rounded border border-line px-2 py-1 text-sm">
            <input type="checkbox" checked={form.groups.includes(g.name)} onChange={(e) => setForm({ ...form, groups: e.target.checked ? [...form.groups, g.name] : form.groups.filter((x) => x !== g.name) })} />
            {g.name}
          </label>
        ))}
      </div>
      <p className="label mt-4">Row filter — the user only sees records matching (leave empty for all)</p>
      {wf ? <ConditionEditor fields={wf.fields.map((f) => ({ key: f.key, label: f.label, options: f.options }))} value={rowFilter} onChange={setRowFilter} /> : <Spinner />}
    </Modal>
  );
}

function GroupDialog({ group, onClose, onSaved }: { group: GroupRow | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [caps, setCaps] = useState<Capability[]>(group?.capabilities ?? []);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api(group ? `/admin/groups/${group.id}` : '/admin/groups', { method: group ? 'PUT' : 'POST', body: { name, description: description || null, capabilities: caps } });
      toast.success('Group saved');
      onSaved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={group ? `Edit ${group.name}` : 'Add group'} footer={<Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button>}>
      <div className="space-y-3">
        <FormField label="Name" hint="Referenced by fields and stages, e.g. STORE">
          <Input value={name} onChange={(e) => setName(e.target.value.toUpperCase())} />
        </FormField>
        <FormField label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
        <div className="space-y-1">
          <p className="label">Capabilities</p>
          {CAPABILITIES.map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={caps.includes(c)} onChange={(e) => setCaps(e.target.checked ? [...caps, c] : caps.filter((x) => x !== c))} />
              <span className="font-medium">{c}</span> <span className="text-muted">— {CAP_HELP[c]}</span>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
