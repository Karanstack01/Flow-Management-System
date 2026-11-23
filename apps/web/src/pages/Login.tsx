import { KeyRound, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { StackDroveLogo } from '../components/StackDroveLogo';
import { Button, ErrorNote, FormField, Input } from '../components/ui';
import { useAuth } from '../lib/auth';

export function Login() {
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('ChangeMe!2026');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  if (status === 'authenticated') return <Navigate to={from} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full place-items-center bg-bg px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center text-center space-y-2">
          {/* Cropped artwork — the square brand files render the wordmark tiny. */}
          <StackDroveLogo variant="dark" className="h-9 dark:hidden" />
          <StackDroveLogo variant="white" className="hidden h-9 dark:flex" />
          <p className="text-xs font-medium tracking-wide text-muted uppercase">
            Flow Management System
          </p>
        </div>

        <form onSubmit={submit} className="card space-y-4 p-7 shadow-sm border border-line">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-fg">Sign in</h1>
            <p className="text-xs text-muted">Enter your corporate credentials to continue</p>
          </div>

          <div className="rounded-md bg-surface-2 border border-line p-3 text-xs text-fg space-y-1">
            <div className="flex items-center gap-1.5 font-semibold text-fg">
              <ShieldCheck className="size-3.5 text-muted" /> Default Login Credentials
            </div>
            <div>
              <span className="text-muted font-medium">Email:</span>{' '}
              <code className="bg-surface px-1 py-0.5 rounded border border-line/60 font-mono text-[11px]">
                admin@example.com
              </code>
            </div>
            <div>
              <span className="text-muted font-medium">Password:</span>{' '}
              <code className="bg-surface px-1 py-0.5 rounded border border-line/60 font-mono text-[11px]">
                ChangeMe!2026
              </code>
            </div>
          </div>

          <ErrorNote error={error} />
          <FormField label="Email">
            <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </FormField>
          <FormField label="Password">
            <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </FormField>
          <Button type="submit" variant="primary" className="w-full flex items-center justify-center gap-2 h-10" loading={busy}>
            <KeyRound className="size-4" /> Sign in
          </Button>
        </form>

        <p className="text-center text-xs text-muted">
          StackDrove Flow Management System &bull; Build. Automate. Scale.
        </p>
      </div>
    </div>
  );
}
