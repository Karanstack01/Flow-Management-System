import clsx from 'clsx';
import {
  ArchiveRestore,
  BarChart3,
  Copy,
  Database,
  Filter,
  FolderOpen,
  ListPlus,
  MoreVertical,
  Pencil,
  PlusCircle,
  Power,
  RotateCw,
  Search,
  Star,
  Trash2,
  Upload,
  Workflow,
} from 'lucide-react';
import { useDeferredValue, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { CreateFlowDialog } from '../../components/CreateFlowDialog';
import { Badge, Button, EmptyState, ErrorNote, FormField, Input, Modal, Select, Spinner, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtRelative } from '../../lib/format';
import { useFlows, useFlowsInvalidation, useTemplates, type FlowFilters } from '../../lib/queries';
import type { FlowRow, FlowStatus } from '../../lib/types';

const STATUS: Record<FlowStatus, { label: string; tone: 'success' | 'neutral' | 'info' | 'danger' }> = {
  active: { label: 'Active', tone: 'success' },
  inactive: { label: 'Inactive', tone: 'neutral' },
  draft: { label: 'Draft', tone: 'info' },
  trashed: { label: 'In trash', tone: 'danger' },
};

type Dialog = { kind: 'create' } | { kind: 'edit'; flow: FlowRow } | { kind: 'template'; flow: FlowRow } | { kind: 'delete'; flow: FlowRow } | null;

export default function AllFlows() {
  const navigate = useNavigate();
  const invalidate = useFlowsInvalidation();
  const [filters, setFilters] = useState<FlowFilters>({ tab: 'primary', status: 'all', since: 'any' });
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const flows = useFlows({ ...filters, q: q || undefined });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  useEffect(() => setSelected(new Set()), [filters.tab]);

  const data = flows.data;
  const manage = data?.canManage ?? false;
  const items = data?.items ?? [];
  const allChecked = items.length > 0 && items.every((f) => selected.has(f.key));

  async function call(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast.success(ok);
      invalidate();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const bulk = (action: 'trash' | 'restore', keys: string[]) =>
    call(() => api('/flows/bulk', { method: 'POST', body: { action, keys } }), action === 'trash' ? `${keys.length} flow(s) moved to trash` : `${keys.length} flow(s) restored`).then(() => setSelected(new Set()));
  const star = (f: FlowRow) => call(() => api(`/flows/${f.key}/favorite`, { method: 'PUT', body: { starred: !f.isFavorite } }), f.isFavorite ? 'Removed from favourites' : 'Added to favourites');

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Manage Your Flows</h1>
          <p className="mt-1 text-sm text-muted">Create, connect, and monitor every stage of your process in one place</p>
        </div>
        {manage && (
          <Button variant="primary" icon={<PlusCircle className="size-4" />} onClick={() => setDialog({ kind: 'create' })}>
            Create Flow
          </Button>
        )}
      </div>

      {manage && (
        <div role="tablist" className="mb-5 inline-flex rounded-xl bg-surface-2 p-1">
          {(['primary', 'drafts', 'trash'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={filters.tab === t}
              onClick={() => setFilters({ ...filters, tab: t })}
              className={clsx('rounded-lg px-4 py-1.5 text-sm capitalize', filters.tab === t ? 'bg-surface font-medium shadow-sm' : 'text-muted hover:text-fg')}
            >
              {t} <span className="text-muted">({data?.counts[t] ?? 0})</span>
            </button>
          ))}
        </div>
      )}

      <div className="card mb-5 flex flex-wrap items-center gap-3 p-4">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input className="pl-9" placeholder="Search flows…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search flows" />
        </div>
        <Filter className="size-4 text-muted" aria-hidden />
        <label className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-sm">
          <FolderOpen className="size-4 text-muted" />
          <select className="h-9 bg-transparent pr-1 outline-none" value={filters.label ?? ''} onChange={(e) => setFilters({ ...filters, label: e.target.value || undefined })} aria-label="Label">
            <option value="">All labels</option>
            {data?.labels.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-sm">
          <span className="font-medium">Status:</span>
          <select className="h-9 bg-transparent outline-none" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as FlowFilters['status'] })} aria-label="Status">
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
        <label className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-sm">
          <span className="font-medium">Date:</span>
          <select className="h-9 bg-transparent outline-none" value={filters.since} onChange={(e) => setFilters({ ...filters, since: e.target.value as FlowFilters['since'] })} aria-label="Updated within">
            <option value="any">Any time</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
        </label>
        {manage && filters.tab !== 'trash' && (
          <Button variant="secondary" aria-label="Move selected to trash" title="Move selected to trash" disabled={!selected.size} icon={<Trash2 className="size-4" />} onClick={() => void bulk('trash', [...selected])} />
        )}
        {manage && filters.tab === 'trash' && (
          <Button variant="secondary" disabled={!selected.size} icon={<ArchiveRestore className="size-4" />} onClick={() => void bulk('restore', [...selected])}>
            Restore
          </Button>
        )}
        <Button variant="secondary" aria-label="Refresh" title="Refresh" icon={<RotateCw className={clsx('size-4', flows.isFetching && 'animate-spin')} />} onClick={() => void flows.refetch()} />
      </div>

      <ErrorNote error={flows.error} />
      <div className="card overflow-hidden">
        {!data ? (
          !flows.error && <Spinner />
        ) : items.length === 0 ? (
          <div className="p-6">
            <EmptyState title={filters.tab === 'trash' ? 'Trash is empty' : filters.tab === 'drafts' ? 'No drafts' : 'No flows match'}>
              {manage && filters.tab !== 'trash' && (
                <span>
                  Start from a <Link className="text-primary underline" to="/templates">template</Link> or create a blank flow.
                </span>
              )}
            </EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead>
                <tr className="border-b-2 border-primary/30 bg-surface-2 text-left">
                  {manage && (
                    <th className="w-12 px-4 py-3">
                      <input type="checkbox" aria-label="Select all" checked={allChecked} onChange={(e) => setSelected(e.target.checked ? new Set(items.map((f) => f.key)) : new Set())} />
                    </th>
                  )}
                  <th className="px-3 py-3 font-semibold">Actions</th>
                  <th className="px-3 py-3 font-semibold">Flow Name</th>
                  <th className="px-3 py-3 font-semibold">Description</th>
                  <th className="px-3 py-3 font-semibold">Label</th>
                  <th className="px-3 py-3 font-semibold">Status</th>
                  <th className="px-3 py-3 text-right font-semibold">Open</th>
                  <th className="hidden px-3 py-3 font-semibold 2xl:table-cell">Created By</th>
                  <th className="px-3 py-3 font-semibold">Updated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((f) => (
                  <tr key={f.id} className="border-b border-line hover:bg-surface-2/60">
                    {manage && (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${f.name}`}
                          checked={selected.has(f.key)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(f.key);
                            else next.delete(f.key);
                            setSelected(next);
                          }}
                        />
                      </td>
                    )}
                    <td className="px-3 py-3">
                      <span className="flex items-center gap-1">
                        {f.status !== 'trashed' && f.status !== 'draft' && (
                          <IconLink to={`/w/${f.key}/new`} label="Add entry">
                            <ListPlus className="size-4" />
                          </IconLink>
                        )}
                        {manage && f.status !== 'trashed' && (
                          <IconLink to={`/flows/${f.key}/editor`} label="Edit flow">
                            <Pencil className="size-4" />
                          </IconLink>
                        )}
                        <RowMenu
                          items={[
                            ...(f.status !== 'trashed'
                              ? [
                                  { icon: <Database />, label: 'Open records', onClick: () => navigate(`/w/${f.key}`) },
                                  { icon: <BarChart3 />, label: 'Reports', onClick: () => navigate(`/w/${f.key}/reports`) },
                                ]
                              : []),
                            ...(manage && f.status !== 'trashed'
                              ? [
                                  { icon: <Workflow />, label: 'Open flow editor', onClick: () => navigate(`/flows/${f.key}/editor`) },
                                  { icon: <Pencil />, label: 'Rename / label', onClick: () => setDialog({ kind: 'edit', flow: f }) },
                                  ...(f.status !== 'draft'
                                    ? [{ icon: <Power />, label: f.status === 'active' ? 'Deactivate (read-only)' : 'Activate', onClick: () => void call(() => api(`/flows/${f.key}`, { method: 'PATCH', body: { isActive: f.status !== 'active' } }), f.status === 'active' ? 'Flow deactivated' : 'Flow activated') }]
                                    : []),
                                  { icon: <Copy />, label: 'Duplicate', onClick: () => void call(() => api(`/flows/${f.key}/duplicate`, { method: 'POST', body: {} }), 'Copy created in Drafts') },
                                  { icon: <Upload />, label: 'Save as template', onClick: () => setDialog({ kind: 'template', flow: f }) },
                                  { icon: <Trash2 />, label: 'Move to trash', danger: true, onClick: () => void bulk('trash', [f.key]) },
                                ]
                              : []),
                            ...(manage && f.status === 'trashed'
                              ? [
                                  { icon: <ArchiveRestore />, label: 'Restore', onClick: () => void bulk('restore', [f.key]) },
                                  { icon: <Trash2 />, label: 'Delete forever…', danger: true, onClick: () => setDialog({ kind: 'delete', flow: f }) },
                                ]
                              : []),
                          ]}
                        />
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span className="flex min-w-[210px] items-center gap-2 whitespace-nowrap">
                        <button type="button" onClick={() => void star(f)} aria-label={f.isFavorite ? 'Unstar' : 'Star'} aria-pressed={f.isFavorite} className="shrink-0">
                          <Star className={clsx('size-4', f.isFavorite ? 'fill-amber-400 text-amber-400' : 'text-muted hover:text-amber-500')} />
                        </button>
                        <Link to={f.status === 'draft' && manage ? `/flows/${f.key}/editor` : f.status === 'trashed' ? '#' : `/w/${f.key}`} className="font-medium hover:text-primary hover:underline">
                          {f.name}
                        </Link>
                        <span className="rounded-full bg-surface-2 px-1.5 text-[11px] text-muted" title={`${f.stageCount} stages · version ${f.version}`}>
                          v{f.version}
                        </span>
                      </span>
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-3 text-muted" title={f.description ?? ''}>
                      {f.description || 'No description'}
                    </td>
                    <td className="px-3 py-3">{f.label ? <Badge>{f.label}</Badge> : <span className="text-muted">—</span>}</td>
                    <td className="px-3 py-3">
                      <Badge tone={STATUS[f.status].tone}>
                        <span className="size-1.5 rounded-full bg-current" /> {STATUS[f.status].label}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                      {f.openRecords}
                      {f.overdue > 0 && <span className="ml-1.5 text-xs font-medium text-danger">({f.overdue} late)</span>}
                    </td>
                    <td className="hidden max-w-40 truncate whitespace-nowrap px-3 py-3 text-muted 2xl:table-cell" title={f.createdBy?.email}>
                      {f.createdBy?.name ?? '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-muted">{fmtRelative(f.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dialog?.kind === 'create' && <CreateFlowDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <EditFlowDialog flow={dialog.flow} labels={data?.labels ?? []} onClose={() => setDialog(null)} onSaved={invalidate} />}
      {dialog?.kind === 'template' && <SaveTemplateDialog flow={dialog.flow} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && <DeleteForeverDialog flow={dialog.flow} onClose={() => setDialog(null)} onDone={invalidate} />}
    </div>
  );
}

function IconLink({ to, label, children }: { to: string; label: string; children: ReactNode }) {
  return (
    <Link to={to} aria-label={label} title={label} className="grid size-8 place-items-center rounded-md text-fg hover:bg-surface-2">
      {children}
    </Link>
  );
}

interface MenuItem {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/** Kebab menu positioned with `fixed` so the scrolling table does not clip it. */
function RowMenu({ items }: { items: MenuItem[] }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => {
      if (menu.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return;
      setPos(null);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setPos(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('scroll', close, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('scroll', close, true);
      document.removeEventListener('keydown', esc);
    };
  }, [pos]);
  if (!items.length) return null;
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={!!pos}
        className="grid size-8 place-items-center rounded-md hover:bg-surface-2"
        onClick={() => {
          if (pos) return setPos(null);
          const r = btn.current!.getBoundingClientRect();
          const height = items.length * 36 + 8;
          setPos({ top: r.bottom + height > window.innerHeight ? Math.max(8, r.top - height) : r.bottom + 4, left: Math.min(r.left, window.innerWidth - 230) });
        }}
      >
        <MoreVertical className="size-4" />
      </button>
      {pos && (
        <div ref={menu} role="menu" className="fixed z-50 w-56 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-xl" style={pos}>
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              type="button"
              onClick={() => {
                setPos(null);
                it.onClick();
              }}
              className={clsx('flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-surface-2 [&>svg]:size-4', it.danger && 'text-danger')}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function EditFlowDialog({ flow, labels, onClose, onSaved }: { flow: FlowRow; labels: string[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: flow.name, description: flow.description ?? '', label: flow.label ?? '' });
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api(`/flows/${flow.key}`, { method: 'PATCH', body: { name: f.name.trim(), description: f.description.trim() || null, label: f.label.trim() || null } });
      toast.success('Flow updated');
      onSaved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Edit ${flow.name}`} footer={<Button variant="primary" loading={busy} disabled={!f.name.trim()} onClick={() => void save()}>Save</Button>}>
      <div className="space-y-3">
        <FormField label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </FormField>
        <FormField label="Description">
          <Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </FormField>
        <FormField label="Label">
          <Input list="flow-labels" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
          <datalist id="flow-labels">
            {labels.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </FormField>
        <p className="text-xs text-muted">Key: {flow.key} (used in links; can not change)</p>
      </div>
    </Modal>
  );
}

function SaveTemplateDialog({ flow, onClose }: { flow: FlowRow; onClose: () => void }) {
  const templates = useTemplates();
  const [f, setF] = useState({ name: flow.name, description: flow.description ?? '', category: flow.label ?? 'General', scope: 'organization' as 'organization' | 'global' });
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api(`/flows/${flow.key}/save-as-template`, { method: 'POST', body: { ...f, description: f.description || undefined } });
      toast.success('Template saved', { description: f.scope === 'global' ? 'Every organization can now use it.' : 'Your organization can now use it.' });
      void templates.refetch();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title="Save as template" footer={<Button variant="primary" loading={busy} onClick={() => void save()}>Save template</Button>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">Copies the stages, fields, rules and canvas. Records, webhook URLs and secrets are not included.</p>
        <FormField label="Template name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </FormField>
        <FormField label="Description">
          <Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </FormField>
        <FormField label="Category">
          <Input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
        </FormField>
        {templates.data?.canPublishGlobal && (
          <FormField label="Available to">
            <Select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as 'organization' | 'global' })}>
              <option value="organization">This organization</option>
              <option value="global">Every organization (super admin)</option>
            </Select>
          </FormField>
        )}
      </div>
    </Modal>
  );
}

function DeleteForeverDialog({ flow, onClose, onDone }: { flow: FlowRow; onClose: () => void; onDone: () => void }) {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  async function del() {
    setBusy(true);
    try {
      const r = await api<{ recordsDeleted: number }>(`/flows/${flow.key}`, { method: 'DELETE', body: { confirm } });
      toast.success(`${flow.name} deleted`, { description: `${r.recordsDeleted} record(s) removed.` });
      onDone();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title="Delete flow forever" footer={<Button variant="danger" loading={busy} disabled={confirm !== flow.key} onClick={() => void del()}>Delete forever</Button>}>
      <div className="space-y-3 text-sm">
        <p>
          This permanently deletes <strong>{flow.name}</strong> and all of its records, history and rules. It can not be undone.
        </p>
        <FormField label={`Type ${flow.key} to confirm`}>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        </FormField>
      </div>
    </Modal>
  );
}
