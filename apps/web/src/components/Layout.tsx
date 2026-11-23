import clsx from 'clsx';
import {
  BarChart3,
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronsUpDown,
  CircleUserRound,
  ClipboardCheck,
  Database,
  FileStack,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sun,
  UsersRound,
  Workflow,
  X,
} from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '../lib/auth';
import { useWorkflows } from '../lib/queries';
import { StackDroveLogo } from './StackDroveLogo';
import { Button } from './ui';

// ------------------------------------------------------------------ theme
type ThemeMode = 'light' | 'dark' | 'system';

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      return (localStorage.getItem('fms-theme') as ThemeMode | null) ?? 'system';
    } catch {
      return 'system';
    }
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  useEffect(() => {
    if (mode === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = mode;
    try {
      localStorage.setItem('fms-theme', mode);
    } catch {
      /* storage unavailable */
    }
  }, [mode]);
  const isDark = mode === 'system' ? systemDark : mode === 'dark';
  return { mode, setMode, isDark, toggle: () => setMode(isDark ? 'light' : 'dark') };
}

// ------------------------------------------------------------------ sidebar state
const SidebarContext = createContext<{ collapsed: boolean }>({ collapsed: false });
const useSidebar = () => useContext(SidebarContext);

function usePersistentFlag(key: string, initial: boolean) {
  const [value, setValue] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? initial : v === '1';
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, value ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

/** Fixed-position tooltip to the right of the target (the sidebar clips absolute children). */
function HoverTip({ label, enabled, children }: { label: ReactNode; enabled: boolean; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const show = () => {
    if (!enabled || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ top: r.top + r.height / 2, left: r.right + 14 });
  };
  const hide = () => setPos(null);
  useEffect(() => {
    if (!enabled) setPos(null);
  }, [enabled]);
  return (
    <span ref={ref} className="block" onMouseEnter={show} onMouseLeave={hide} onFocusCapture={show} onBlurCapture={hide}>
      {children}
      {pos &&
        createPortal(
        <span role="tooltip" className="pointer-events-none fixed z-[60] -translate-y-1/2 animate-pop-in" style={{ top: pos.top, left: pos.left }}>
          <span className="relative block whitespace-nowrap rounded-[10px] bg-[#1d1d1f] px-3 py-1.5 text-[13px] font-medium text-white shadow-[var(--shadow-float)] ring-1 ring-white/10">
            <span className="absolute -left-1 top-1/2 size-2 -translate-y-1/2 rotate-45 bg-[#1d1d1f]" aria-hidden />
            {label}
          </span>
        </span>,
          document.body,
        )}
    </span>
  );
}

const rowBase = 'group relative flex h-10 w-full items-center gap-3 rounded-xl text-[14px] transition-[background-color,color] duration-200 ease-[var(--ease-apple)]';
const rowState = (active: boolean) => (active ? 'bg-side-active font-medium text-white' : 'text-side-text hover:bg-side-hover hover:text-white');

function Label({ children }: { children: ReactNode }) {
  const { collapsed } = useSidebar();
  return <span className={clsx('min-w-0 flex-1 truncate text-left transition-[opacity,transform] duration-200 ease-[var(--ease-apple)]', collapsed ? 'pointer-events-none -translate-x-1 opacity-0' : 'opacity-100')}>{children}</span>;
}

function NavItem({ to, icon, label, end }: { to: string; icon: ReactNode; label: string; end?: boolean }) {
  const { collapsed } = useSidebar();
  return (
    <HoverTip label={label} enabled={collapsed}>
      <NavLink to={to} end={end} aria-label={collapsed ? label : undefined} className={({ isActive }) => clsx(rowBase, 'px-3', rowState(isActive))}>
        {({ isActive }) => (
          <>
            {isActive && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-white" aria-hidden />}
            <span className="grid size-5 shrink-0 place-items-center [&>svg]:size-[19px] [&>svg]:stroke-[1.75]">{icon}</span>
            <Label>{label}</Label>
          </>
        )}
      </NavLink>
    </HoverTip>
  );
}

/**
 * Expandable group (Settings, Reports, Records). Expanded sidebar: smooth accordion.
 * Collapsed sidebar: a flyout menu to the right of the icon.
 */
function NavGroup({ icon, label, links, emptyText }: { icon: ReactNode; label: string; links: { to: string; label: string }[]; emptyText?: string }) {
  const { collapsed } = useSidebar();
  const location = useLocation();
  const activeInside = links.some((l) => location.pathname === l.to || location.pathname.startsWith(`${l.to}/`));
  const [open, setOpen] = useState(activeInside);
  const [fly, setFly] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeInside) setOpen(true);
  }, [activeInside]);
  useEffect(() => setFly(null), [location.pathname, collapsed]);
  useEffect(() => {
    if (!fly) return;
    const close = (e: Event) => !panel.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setFly(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setFly(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [fly]);

  const toggle = () => {
    if (!collapsed) return setOpen(!open);
    if (fly) return setFly(null);
    const r = btn.current!.getBoundingClientRect();
    setFly({ top: Math.min(r.top, window.innerHeight - 80 - links.length * 38), left: r.right + 14 });
  };

  return (
    <div>
      <HoverTip label={label} enabled={collapsed && !fly}>
        <button ref={btn} type="button" onClick={toggle} aria-expanded={collapsed ? !!fly : open} aria-label={collapsed ? label : undefined} className={clsx(rowBase, 'px-3', rowState(collapsed && activeInside))}>
          <span className="grid size-5 shrink-0 place-items-center [&>svg]:size-[19px] [&>svg]:stroke-[1.75]">{icon}</span>
          <Label>{label}</Label>
          {!collapsed && <ChevronDown className={clsx('size-4 shrink-0 text-side-muted transition-transform duration-300 ease-[var(--ease-apple)]', open ? 'rotate-0' : '-rotate-90')} />}
        </button>
      </HoverTip>
      {/* Accordion: animates height with the grid-rows technique. */}
      <div className={clsx('grid transition-[grid-template-rows,opacity] duration-300 ease-[var(--ease-apple)]', !collapsed && open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}>
        <div className="overflow-hidden">
          <div className="ml-[22px] mt-1 space-y-0.5 border-l border-white/10 pb-1 pl-3">
            {links.length === 0 && <p className="px-3 py-1.5 text-[13px] text-side-muted">{emptyText}</p>}
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end
                tabIndex={!collapsed && open ? 0 : -1}
                className={({ isActive }) => clsx('block truncate rounded-lg px-3 py-1.5 text-[13px] transition-colors duration-200', isActive ? 'bg-side-active font-medium text-white' : 'text-side-text/85 hover:bg-side-hover hover:text-white')}
              >
                {l.label}
              </NavLink>
            ))}
          </div>
        </div>
      </div>
      {fly &&
        createPortal(
        <div ref={panel} role="menu" className="fixed z-[60] w-60 animate-pop-in overflow-hidden rounded-2xl border border-white/10 bg-[#1d1d1f] p-1.5 text-white shadow-[var(--shadow-float)]" style={fly}>
          <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-side-muted">{label}</p>
          {links.length === 0 && <p className="px-3 py-2 text-[13px] text-side-muted">{emptyText}</p>}
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end role="menuitem" className={({ isActive }) => clsx('block truncate rounded-lg px-3 py-2 text-[13px] transition-colors', isActive ? 'bg-white/15 font-medium' : 'text-side-text hover:bg-white/10 hover:text-white')}>
              {l.label}
            </NavLink>
          ))}
        </div>,
          document.body,
        )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { collapsed } = useSidebar();
  return (
    <div>
      <div className="relative mb-1.5 h-5">
        <p className={clsx('absolute inset-0 px-3 text-[11px] font-semibold uppercase leading-5 tracking-[0.12em] text-side-muted transition-opacity duration-200', collapsed ? 'opacity-0' : 'opacity-100')}>{title}</p>
        <span className={clsx('absolute left-1/2 top-1/2 h-px w-6 -translate-x-1/2 bg-white/15 transition-opacity duration-200', collapsed ? 'opacity-100' : 'opacity-0')} aria-hidden />
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function UserMenu() {
  const { user, logout, isSuperAdmin } = useAuth();
  const { collapsed } = useSidebar();
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const location = useLocation();
  useEffect(() => setPos(null), [location.pathname, collapsed]);
  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => !menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setPos(null);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [pos]);
  const initials = (user?.name ?? '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const role = isSuperAdmin ? 'Super admin' : user?.capabilities.includes('ADMIN') ? 'Administrator' : 'Member';
  return (
    <>
      <HoverTip label={`${user?.name ?? ''} · ${role}`} enabled={collapsed && !pos}>
        <button
          ref={btn}
          type="button"
          aria-label="Account menu"
          aria-expanded={!!pos}
          onClick={() => {
            if (pos) return setPos(null);
            const r = btn.current!.getBoundingClientRect();
            setPos(collapsed ? { left: r.right + 14, bottom: window.innerHeight - r.bottom } : { left: r.left, bottom: window.innerHeight - r.top + 8 });
          }}
          className={clsx('flex w-full items-center gap-3 rounded-2xl p-2 text-left transition-colors duration-200 hover:bg-side-hover', !collapsed && 'bg-white/[0.05]')}
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#e5e5ea] to-[#aeaeb2] text-[13px] font-semibold text-[#1d1d1f]">{initials}</span>
          <Label>
            <span className="block truncate text-[14px] font-medium text-white">{user?.name}</span>
            <span className="block truncate text-[12px] text-side-muted">{role}</span>
          </Label>
          {!collapsed && <ChevronsUpDown className="size-4 shrink-0 text-side-muted" />}
        </button>
      </HoverTip>
      {pos &&
        createPortal(
        <div ref={menu} role="menu" className="fixed z-[60] w-64 animate-pop-in overflow-hidden rounded-2xl border border-line bg-surface p-1.5 text-fg shadow-[var(--shadow-float)]" style={pos}>
          <div className="px-3 pb-2 pt-1.5">
            <p className="truncate text-sm font-medium">{user?.name}</p>
            <p className="truncate text-xs text-muted">{user?.email}</p>
          </div>
          <div className="h-px bg-line" />
          <Link to="/account" role="menuitem" className="mt-1 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-surface-2">
            <CircleUserRound className="size-4 stroke-[1.75]" /> My account
          </Link>
          <button type="button" role="menuitem" onClick={() => void logout()} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-danger transition-colors hover:bg-surface-2">
            <LogOut className="size-4 stroke-[1.75]" /> Sign out
          </button>
        </div>,
          document.body,
        )}
    </>
  );
}

function SidebarBody({ onCollapse, mobile }: { onCollapse?: () => void; mobile?: boolean }) {
  const { user, can, isSuperAdmin } = useAuth();
  const { collapsed } = useSidebar();
  const { data: flows } = useWorkflows();
  const live = (flows ?? []).filter((f) => !f.isDraft);
  // Each link shows for whoever holds its capability (admins hold all of them).
  const settingsLinks = [
    ...(can('ADMIN') ? [{ to: '/admin/connections', label: 'Connections' }, { to: '/admin/calendars', label: 'Calendars & lists' }] : []),
    ...(can('MANAGE_RULES') ? [{ to: '/admin/rules', label: 'Notification rules' }] : []),
    ...(can('ADMIN') ? [{ to: '/admin/workflows', label: 'Form editor' }] : []),
    ...(can('RUN_JOBS') ? [{ to: '/admin/audit', label: can('ADMIN') ? 'Audit & jobs' : 'Automation jobs' }] : []),
    { to: '/account', label: 'My account' },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Header — same height as the top bar so both rows line up. */}
      <div className={clsx('flex h-16 shrink-0 items-center', collapsed ? 'justify-center px-2' : 'justify-between pl-5 pr-3')}>
        <Link to="/" aria-label="StackDrove home" className="flex min-w-0 items-center">
          {collapsed ? <StackDroveLogo markOnly className="h-8" /> : <StackDroveLogo className="h-[26px]" />}
        </Link>
        {!collapsed && onCollapse && (
          <button type="button" onClick={onCollapse} aria-label={mobile ? 'Close menu' : 'Collapse sidebar'} title={mobile ? 'Close menu' : 'Collapse sidebar (Ctrl+B)'} className="grid size-8 place-items-center rounded-lg text-side-muted transition-colors hover:bg-side-hover hover:text-white">
            {mobile ? <X className="size-[18px]" /> : <ChevronLeft className="size-[18px]" />}
          </button>
        )}
      </div>

      {/* Organization */}
      <div className={clsx('shrink-0 pb-3', collapsed ? 'px-3' : 'px-4')}>
        <HoverTip label={`${user?.org.name ?? ''} · ${user?.org.status === 'ACTIVE' ? 'Live' : 'Restricted'}`} enabled={collapsed}>
          <div className={clsx('flex h-11 items-center gap-2.5 rounded-xl bg-white/[0.06] ring-1 ring-white/[0.06]', collapsed ? 'justify-center' : 'px-3')}>
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-white/10 text-[11px] font-semibold text-white">{(user?.org.name ?? 'O').slice(0, 1).toUpperCase()}</span>
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-[13px] font-medium text-white" title={user?.org.name}>
                    {user?.org.name}
                  </span>
                  <span className="block truncate whitespace-nowrap text-[11px] text-side-muted">Workspace</span>
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#30d158]/15 px-2 py-0.5 text-[11px] font-medium text-[#5ee07c]">
                  <span className="size-1.5 rounded-full bg-[#30d158]" /> Live
                </span>
              </>
            )}
          </div>
        </HoverTip>
      </div>

      {/* Navigation — scrolls without a scrollbar; edges fade when there is more. */}
      <nav aria-label="Main" className={clsx('scroll-clean fade-y min-h-0 flex-1 space-y-5 py-2', collapsed ? 'px-3' : 'px-3')}>
        <Section title="Menu">
          <NavItem to="/" end icon={<LayoutDashboard />} label="Dashboard" />
          <NavItem to="/flows" icon={<Workflow />} label="All Flows" />
          <NavItem to="/templates" icon={<FileStack />} label="Templates" />
          <NavItem to="/tasks" icon={<ClipboardCheck />} label="My Tasks" />
          {can('ADMIN') && <NavItem to="/admin/users" icon={<UsersRound />} label="All Users" />}
        </Section>
        <Section title="Other">
          <NavGroup icon={<Settings2 />} label="Settings" links={settingsLinks} />
          <NavGroup icon={<BarChart3 />} label="Reports" links={live.map((f) => ({ to: `/w/${f.key}/reports`, label: f.name }))} emptyText="No live flows yet" />
          <NavGroup icon={<Database />} label="Records" links={live.map((f) => ({ to: `/w/${f.key}`, label: f.name }))} emptyText="No live flows yet" />
        </Section>
        {isSuperAdmin && (
          <Section title="Platform">
            <NavItem to="/platform" end icon={<Gauge />} label="Overview" />
            <NavItem to="/platform/orgs" icon={<Building2 />} label="Organizations" />
            <NavItem to="/platform/users" icon={<ShieldCheck />} label="Super admins" />
          </Section>
        )}
      </nav>

      <div className="shrink-0 p-3 pt-2">
        <UserMenu />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ top bar
function usePageTitle(): { group?: string; title: string } {
  const { pathname } = useLocation();
  const { data: flows } = useWorkflows();
  const flowName = (key: string) => flows?.find((f) => f.key === key)?.name ?? key;
  const map: Record<string, [string | undefined, string]> = {
    '/': [undefined, 'Dashboard'],
    '/flows': [undefined, 'All Flows'],
    '/templates': [undefined, 'Templates'],
    '/tasks': [undefined, 'My Tasks'],
    '/admin/users': [undefined, 'All Users'],
    '/admin/connections': ['Settings', 'Connections'],
    '/admin/calendars': ['Settings', 'Calendars & lists'],
    '/admin/rules': ['Settings', 'Notification rules'],
    '/admin/workflows': ['Settings', 'Form editor'],
    '/admin/audit': ['Settings', 'Audit & jobs'],
    '/account': ['Settings', 'My account'],
    '/platform': ['Platform', 'Overview'],
    '/platform/orgs': ['Platform', 'Organizations'],
    '/platform/users': ['Platform', 'Super admins'],
  };
  if (map[pathname]) return { group: map[pathname]![0], title: map[pathname]![1] };
  const m = /^\/w\/([^/]+)(\/new|\/reports|\/records\/[^/]+)?$/.exec(pathname);
  if (m) {
    const sub = m[2];
    return { group: sub === '/reports' ? 'Reports' : 'Records', title: sub === '/new' ? `${flowName(m[1]!)} · New entry` : sub?.startsWith('/records') ? `${flowName(m[1]!)} · Record` : flowName(m[1]!) };
  }
  return { title: 'StackDrove' };
}

function ThemeSwitch() {
  const { mode, setMode } = useTheme();
  const opts: { value: ThemeMode; icon: ReactNode; label: string }[] = [
    { value: 'light', icon: <Sun />, label: 'Light' },
    { value: 'dark', icon: <Moon />, label: 'Dark' },
    { value: 'system', icon: <Monitor />, label: 'System' },
  ];
  return (
    <div role="radiogroup" aria-label="Theme" className="flex rounded-full bg-surface-2 p-0.5">
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={mode === o.value}
          aria-label={o.label}
          title={o.label}
          onClick={() => setMode(o.value)}
          className={clsx('grid size-8 place-items-center rounded-full transition-all duration-200 ease-[var(--ease-apple)] [&>svg]:size-4 [&>svg]:stroke-[1.75]', mode === o.value ? 'bg-surface text-fg shadow-[0_1px_3px_rgb(0_0_0/0.12)]' : 'text-muted hover:text-fg')}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { group, title } = usePageTitle();
  const { user } = useAuth();
  return (
    <header className="glass flex h-16 shrink-0 items-center gap-3 rounded-[22px] px-3 shadow-[var(--shadow-soft)] sm:px-5">
      <button type="button" aria-label="Open menu" onClick={onMenu} className="grid size-9 place-items-center rounded-xl text-fg transition-colors hover:bg-surface-2 lg:hidden">
        <Menu className="size-5 stroke-[1.75]" />
      </button>
      <span className="lg:hidden">
        <StackDroveLogo variant="dark" markOnly className="h-7 dark:hidden" />
        <StackDroveLogo variant="white" markOnly className="hidden h-7 dark:block" />
      </span>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[15px]">
        {group && (
          <>
            <span className="hidden text-muted sm:inline">{group}</span>
            <span className="hidden text-muted/60 sm:inline" aria-hidden>
              /
            </span>
          </>
        )}
        <span className="truncate font-semibold">{title}</span>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <span className="hidden items-center gap-2 rounded-full border border-line px-3 py-1.5 text-[13px] text-muted md:inline-flex">
          <span className="size-1.5 rounded-full bg-success" aria-hidden />
          {user?.org.name}
        </span>
        <ThemeSwitch />
      </div>
    </header>
  );
}

/** Always-visible reminder that a super admin is acting inside someone else's organization. */
function VisitingBanner() {
  const { user, isVisiting, switchOrg } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!isVisiting || !user) return null;
  async function leave() {
    setBusy(true);
    try {
      await switchOrg(null);
      navigate('/platform/orgs');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div role="status" className="flex shrink-0 animate-pop-in flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-2.5 text-sm text-warning">
      <ShieldAlert className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        Super admin view of <strong className="font-semibold">{user.org.name}</strong>. Changes are made in this organization and recorded in its audit log.
      </span>
      <Button size="sm" loading={busy} onClick={() => void leave()}>
        Return to my organization
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ shell
export function Layout() {
  const [collapsed, setCollapsed] = usePersistentFlag('fms-sidebar-collapsed', false);
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  useEffect(() => setDrawer(false), [location.pathname]);
  // New page starts at the top.
  useLayoutEffect(() => {
    // Braces matter: newer Chrome returns a Promise from scrollTo, and an effect must not return one.
    if (main.current) main.current.scrollTop = 0;
  }, [location.pathname]);
  const toggle = useCallback(() => setCollapsed((c) => !c), [setCollapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && !(e.target as HTMLElement).closest('input, textarea, [contenteditable]')) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  return (
    <div className="flex h-full gap-3 p-3">
      {/* Desktop sidebar: floating panel that animates between full width and an icon rail. */}
      <SidebarContext.Provider value={{ collapsed }}>
        <aside
          className="sidebar relative hidden shrink-0 rounded-[22px] shadow-[0_10px_30px_rgb(0_0_0/0.12)] ring-1 ring-black/5 transition-[width] duration-300 ease-[var(--ease-apple)] lg:block"
          style={{ width: collapsed ? 76 : 272 }}
        >
          <SidebarBody onCollapse={toggle} />
          {collapsed && (
            <button
              type="button"
              onClick={toggle}
              aria-label="Expand sidebar"
              title="Expand sidebar (Ctrl+B)"
              className="absolute -right-3 top-5 z-10 grid size-6 place-items-center rounded-full border border-line bg-surface text-fg shadow-[var(--shadow-soft)] transition-transform duration-200 hover:scale-110"
            >
              <ChevronLeft className="size-3.5 rotate-180" />
            </button>
          )}
        </aside>
      </SidebarContext.Provider>

      {/* Mobile drawer */}
      <div className={clsx('fixed inset-0 z-50 lg:hidden', drawer ? 'pointer-events-auto' : 'pointer-events-none')} aria-hidden={!drawer}>
        <div className={clsx('absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity duration-300', drawer ? 'opacity-100' : 'opacity-0')} onClick={() => setDrawer(false)} />
        <SidebarContext.Provider value={{ collapsed: false }}>
          <aside className={clsx('sidebar absolute bottom-3 left-3 top-3 w-[min(300px,calc(100%-24px))] rounded-[22px] shadow-2xl transition-transform duration-300 ease-[var(--ease-apple)]', drawer ? 'translate-x-0' : '-translate-x-[110%]')}>
            <SidebarBody onCollapse={() => setDrawer(false)} mobile />
          </aside>
        </SidebarContext.Provider>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <TopBar onMenu={() => setDrawer(true)} />
        <VisitingBanner />
        <main ref={main} className="scroll-clean fade-y min-h-0 flex-1 rounded-[22px]">
          <div key={location.pathname} className="animate-page-in px-1 pb-8 pt-3 sm:px-4">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
