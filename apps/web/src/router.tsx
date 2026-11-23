import { TriangleAlert } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, isRouteErrorResponse, Navigate, useLocation, useRouteError } from 'react-router';
import type { Capability } from '@fms/core';
import { Layout } from './components/Layout';
import { Button, Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import { Login } from './pages/Login';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const MyTasks = lazy(() => import('./pages/MyTasks'));
const AllFlows = lazy(() => import('./pages/flows/AllFlows'));
const Templates = lazy(() => import('./pages/flows/Templates'));
const FlowEditor = lazy(() => import('./pages/flows/editor/FlowEditor'));
const Records = lazy(() => import('./pages/Records'));
const RecordNew = lazy(() => import('./pages/RecordNew'));
const RecordDetail = lazy(() => import('./pages/RecordDetail'));
const Reports = lazy(() => import('./pages/Reports'));
const Account = lazy(() => import('./pages/Account'));
const WorkflowDesigner = lazy(() => import('./pages/admin/WorkflowDesigner'));
const UsersAdmin = lazy(() => import('./pages/admin/Users'));
const CalendarsAdmin = lazy(() => import('./pages/admin/Calendars'));
const RulesAdmin = lazy(() => import('./pages/admin/Rules'));
const AuditAdmin = lazy(() => import('./pages/admin/Audit'));
const ConnectionsAdmin = lazy(() => import('./pages/admin/Connections'));
const PlatformOverview = lazy(() => import('./pages/platform/Overview'));
const PlatformOrgs = lazy(() => import('./pages/platform/Organizations'));
const PlatformUsers = lazy(() => import('./pages/platform/PlatformUsers'));
const PublicForm = lazy(() => import('./pages/PublicForm'));

/** 'admin', 'super', or a single capability (admins hold every capability). */
type Guard = 'admin' | 'super' | Capability | undefined;

function RequireAuth({ children, guard }: { children: ReactNode; guard?: Guard }) {
  const { status, can, isSuperAdmin } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Spinner label="Restoring session…" />;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (guard === 'super' && !isSuperAdmin) return <Navigate to="/" replace />;
  if (guard && guard !== 'super' && !can(guard === 'admin' ? 'ADMIN' : guard)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Friendly recovery screen instead of React Router's developer stack trace. */
function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : 'Unknown error';
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="card w-full max-w-md animate-pop-in p-8 text-center">
        <span className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-danger-soft text-danger">
          <TriangleAlert className="size-6 stroke-[1.75]" />
        </span>
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted">This page hit an unexpected problem. Your saved data is safe.</p>
        <p className="mt-3 break-words rounded-xl bg-surface-2 px-3 py-2 font-mono text-xs text-muted">{message}</p>
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={() => window.location.reload()}>Reload</Button>
          <Button variant="primary" onClick={() => window.location.assign('/')}>
            Go to dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}

const page = (el: ReactNode, guard?: Guard) => (
  <RequireAuth guard={guard}>
    <Suspense fallback={<Spinner />}>{el}</Suspense>
  </RequireAuth>
);

export const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  // Public intake form: no sign-in.
  { path: '/f/:token', element: <Suspense fallback={<Spinner />}><PublicForm /></Suspense>, errorElement: <RouteError /> },
  // Full-screen canvas, no sidebar.
  { path: '/flows/:wf/editor', element: page(<FlowEditor />, 'admin'), errorElement: <RouteError /> },
  {
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    errorElement: <RouteError />,
    // Pathless child route: a page crash shows the error card inside the shell, sidebar intact.
    children: [{ errorElement: <RouteError />, children: [
      { path: '/', element: page(<Dashboard />) },
      { path: '/flows', element: page(<AllFlows />) },
      { path: '/templates', element: page(<Templates />) },
      { path: '/tasks', element: page(<MyTasks />) },
      { path: '/account', element: page(<Account />) },
      { path: '/w/:wf', element: page(<Records />) },
      { path: '/w/:wf/new', element: page(<RecordNew />) },
      { path: '/w/:wf/records/:id', element: page(<RecordDetail />) },
      { path: '/w/:wf/reports', element: page(<Reports />) },
      { path: '/admin/workflows', element: page(<WorkflowDesigner />, 'admin') },
      { path: '/admin/users', element: page(<UsersAdmin />, 'admin') },
      { path: '/admin/calendars', element: page(<CalendarsAdmin />, 'admin') },
      // Reachable with just the matching capability, not only by admins.
      { path: '/admin/rules', element: page(<RulesAdmin />, 'MANAGE_RULES') },
      { path: '/admin/audit', element: page(<AuditAdmin />, 'RUN_JOBS') },
      { path: '/admin/connections', element: page(<ConnectionsAdmin />, 'admin') },
      { path: '/platform', element: page(<PlatformOverview />, 'super') },
      { path: '/platform/orgs', element: page(<PlatformOrgs />, 'super') },
      { path: '/platform/users', element: page(<PlatformUsers />, 'super') },
      { path: '*', element: <Navigate to="/" replace /> },
    ] }],
  },
]);
