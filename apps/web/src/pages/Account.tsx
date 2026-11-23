import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button, Card, ErrorNote, FormField, Input, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

export default function Account() {
  const { user, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      toast.success('Password changed. Please sign in again.');
      await logout();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Account" subtitle={user?.email} />
      <Card title="Profile">
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted">Name</dt>
          <dd>{user?.name}</dd>
          <dt className="text-muted">Organization</dt>
          <dd>{user?.org.name}</dd>
          <dt className="text-muted">Role</dt>
          <dd>{user?.isSuperAdmin ? 'Super admin — every organization on the platform' : user?.capabilities.includes('ADMIN') ? 'Organization admin' : 'User'}</dd>
          <dt className="text-muted">Groups</dt>
          <dd>{user?.groups.join(', ') || '—'}</dd>
          <dt className="text-muted">Permissions</dt>
          <dd>{user?.capabilities.join(', ') || '—'}</dd>
        </dl>
      </Card>
      <Card title="Change password">
        <form onSubmit={submit} className="space-y-3">
          <ErrorNote error={error} />
          <FormField label="Current password">
            <Input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </FormField>
          <FormField label="New password" hint="At least 10 characters, with letters and numbers">
            <Input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
          </FormField>
          <Button type="submit" variant="primary" loading={busy}>
            Change password
          </Button>
        </form>
      </Card>
    </div>
  );
}
