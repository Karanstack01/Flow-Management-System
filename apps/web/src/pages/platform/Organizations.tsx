import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Badge, Button, Card, ErrorNote, FormField, Input, Modal, PageHeader, Spinner, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtNumber } from '../../lib/format';
import type { OrgStatus, PlatformOrg } from '../../lib/types';

const STATUS: Record<OrgStatus, { label: string; tone: 'success' | 'danger' | 'warning' }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  SUSPENDED: { label: 'Suspended', tone: 'danger' },
  LICENSE_EXPIRED: { label: 'Licence expired', tone: 'warning' },
};

/** yyyy-MM-dd (local) ⇄ ISO end of that day, so "expires on 31 Dec" includes 31 Dec. */
const toDateInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fromDateInput = (v: string) => (v ? new Date(`${v}T23:59:59`).toISOString() : null);
const toLimit = (v: string) => (v.trim() === '' ? null : Math.max(1, Math.floor(Number(v))));
const usage = (used: number, max: number | null) => (max == null ? fmtNumber(used) : `${fmtNumber(used)} / ${fmtNumber(max)}`);

function errorText(e: unknown) {
  const d = (e as { details?: Record<string, string> }).details;
  return { message: (e as Error).message, description: d ? Object.entries(d).map(([k, v]) => `${k}: ${v}`).join('; ') : undefined };
}

export default function OrganizationsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user, switchOrg } = useAuth();
  const orgs = useQuery({ queryKey: ['platform-orgs'], queryFn: () => api<{ items: PlatformOrg[] }>('/platform/orgs').then((r) => r.items) });
  const [edit, setEdit] = useState<PlatformOrg | 'new' | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['platform-orgs'] });

  async function enter(org: PlatformOrg) {
    setEntering(org.id);
    try {
      await switchOrg(org.id === user?.homeOrgId ? null : org.id);
      toast.success(`Now working in ${org.name}`);
      navigate('/');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setEntering(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Organizations"
        subtitle="Each client company is an organization with its own users, workflows and data. Licence limits and suspension are set here."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit('new')}>
            New organization
          </Button>
        }
      />
      <ErrorNote error={orgs.error} />
      <Card bodyClassName="p-0">
        {!orgs.data ? (
          !orgs.error && <Spinner />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Status</th>
                  <th className="text-right">Active users</th>
                  <th className="text-right">Workflows</th>
                  <th className="text-right">Open records</th>
                  <th>Licence until</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orgs.data.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <p className="font-medium">
                        {o.name} {o.id === user?.orgId && <Badge tone="primary">You are here</Badge>}
                      </p>
                      <p className="text-xs text-muted">{o.slug}</p>
                    </td>
                    <td>
                      <Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge>
                      {o.suspendedReason && <p className="mt-0.5 max-w-56 truncate text-xs text-muted" title={o.suspendedReason}>{o.suspendedReason}</p>}
                    </td>
                    <td className="text-right tabular-nums">{usage(o.activeUsers, o.maxUsers)}</td>
                    <td className="text-right tabular-nums">{usage(o.workflows, o.maxWorkflows)}</td>
                    <td className="text-right tabular-nums">{fmtNumber(o.records)}</td>
                    <td className="whitespace-nowrap text-muted">{o.licenseExpiresAt ? fmtDate(o.licenseExpiresAt) : 'No expiry'}</td>
                    <td>
                      <span className="flex justify-end gap-1">
                        {o.id !== user?.orgId && (
                          <Button size="sm" icon={<LogIn className="size-3.5" />} loading={entering === o.id} onClick={() => void enter(o)}>
                            Enter
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" aria-label={`Edit ${o.name}`} icon={<Pencil className="size-4" />} onClick={() => setEdit(o)} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {edit === 'new' && <CreateOrgDialog onClose={() => setEdit(null)} onSaved={refresh} />}
      {edit && edit !== 'new' && <EditOrgDialog org={edit} isHome={edit.id === user?.homeOrgId} onClose={() => setEdit(null)} onSaved={refresh} />}
    </div>
  );
}

function CreateOrgDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: '', slug: '', timezone: 'Asia/Kolkata', maxUsers: '', maxWorkflows: '', licenseExpiresAt: '', adminName: '', adminEmail: '', adminPassword: '' });
  const [busy, setBusy] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    try {
      await api('/platform/orgs', {
        method: 'POST',
        body: {
          name: f.name,
          slug: f.slug,
          timezone: f.timezone,
          maxUsers: toLimit(f.maxUsers),
          maxWorkflows: toLimit(f.maxWorkflows),
          licenseExpiresAt: fromDateInput(f.licenseExpiresAt),
          admin: { name: f.adminName, email: f.adminEmail, password: f.adminPassword },
        },
      });
      toast.success(`${f.name} created`, { description: `${f.adminEmail} can now sign in and set up workflows.` });
      onSaved();
      onClose();
    } catch (e) {
      const { message, description } = errorText(e);
      toast.error(message, { description });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="New organization" wide footer={<Button variant="primary" loading={busy} onClick={() => void save()}>Create organization</Button>}>
      <p className="mb-3 text-sm text-muted">Creates the organization, an ADMINS group, a “Head Office” business calendar and its first administrator.</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <FormField label="Company name" required>
          <Input
            value={f.name}
            onChange={(e) => {
              const name = e.target.value;
              setF((x) => ({ ...x, name, slug: slugTouched ? x.slug : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) }));
            }}
          />
        </FormField>
        <FormField label="Slug" required hint="Unique short name, e.g. acme-industries">
          <Input
            value={f.slug}
            onChange={(e) => {
              setSlugTouched(true);
              set('slug')(e);
            }}
          />
        </FormField>
        <FormField label="Timezone" hint="IANA name, e.g. Asia/Kolkata">
          <Input value={f.timezone} onChange={set('timezone')} />
        </FormField>
        <FormField label="Licence valid until" hint="Leave empty for no expiry">
          <Input type="date" value={f.licenseExpiresAt} onChange={set('licenseExpiresAt')} />
        </FormField>
        <FormField label="Max active users" hint="Empty = unlimited">
          <Input type="number" min={1} value={f.maxUsers} onChange={set('maxUsers')} />
        </FormField>
        <FormField label="Max workflows" hint="Empty = unlimited">
          <Input type="number" min={1} value={f.maxWorkflows} onChange={set('maxWorkflows')} />
        </FormField>
      </div>
      <p className="label mt-4">First administrator</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <FormField label="Name" required>
          <Input value={f.adminName} onChange={set('adminName')} />
        </FormField>
        <FormField label="Email" required>
          <Input type="email" value={f.adminEmail} onChange={set('adminEmail')} />
        </FormField>
        <FormField label="Temporary password" required hint="10+ characters, letters and numbers">
          <Input type="password" autoComplete="new-password" value={f.adminPassword} onChange={set('adminPassword')} />
        </FormField>
      </div>
    </Modal>
  );
}

function EditOrgDialog({ org, isHome, onClose, onSaved }: { org: PlatformOrg; isHome: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: org.name,
    maxUsers: org.maxUsers?.toString() ?? '',
    maxWorkflows: org.maxWorkflows?.toString() ?? '',
    licenseExpiresAt: toDateInput(org.licenseExpiresAt),
    suspendedReason: org.suspendedReason ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function patch(body: Record<string, unknown>, done: string) {
    setBusy(true);
    try {
      await api(`/platform/orgs/${org.id}`, { method: 'PATCH', body });
      toast.success(done);
      onSaved();
      onClose();
    } catch (e) {
      const { message, description } = errorText(e);
      toast.error(message, { description });
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    patch({ name: f.name, maxUsers: toLimit(f.maxUsers), maxWorkflows: toLimit(f.maxWorkflows), licenseExpiresAt: fromDateInput(f.licenseExpiresAt) }, 'Organization updated');

  function toggleSuspend() {
    if (org.isActive) {
      if (!window.confirm(`Suspend ${org.name}? Its users are signed out immediately and notifications pause until you reactivate it.`)) return;
      void patch({ isActive: false, suspendedReason: f.suspendedReason.trim() || null }, `${org.name} suspended`);
    } else {
      void patch({ isActive: true }, `${org.name} reactivated`);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${org.name}`}
      footer={
        <>
          {!isHome && (
            <Button variant={org.isActive ? 'danger' : 'secondary'} loading={busy} onClick={toggleSuspend}>
              {org.isActive ? 'Suspend' : 'Reactivate'}
            </Button>
          )}
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Company name">
          <Input value={f.name} onChange={set('name')} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Max active users" hint={`In use: ${org.activeUsers}. Empty = unlimited`}>
            <Input type="number" min={1} value={f.maxUsers} onChange={set('maxUsers')} />
          </FormField>
          <FormField label="Max workflows" hint={`In use: ${org.workflows}. Empty = unlimited`}>
            <Input type="number" min={1} value={f.maxWorkflows} onChange={set('maxWorkflows')} />
          </FormField>
        </div>
        <FormField label="Licence valid until" hint="After this date only super admins can sign in. Empty = no expiry">
          <Input type="date" value={f.licenseExpiresAt} onChange={set('licenseExpiresAt')} />
        </FormField>
        {org.isActive && !isHome && (
          <FormField label="Suspension reason (shown in the audit log)">
            <Textarea value={f.suspendedReason} onChange={set('suspendedReason')} placeholder="e.g. Invoice overdue" />
          </FormField>
        )}
        {isHome && <p className="text-xs text-muted">This is your own organization, so it can not be suspended from here.</p>}
      </div>
    </Modal>
  );
}
