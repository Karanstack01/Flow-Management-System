/**
 * Quick links on the dashboard (legacy Dashboard tab): reports, sheets and sites the team opens
 * often, each shown to the groups chosen. Admins add, edit, reorder and remove them.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, BarChart3, CalendarDays, ClipboardList, ExternalLink, FileText, Folder, Link2, Pencil, Plus, Settings2, Sheet, Trash2, Video } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { Button, Checkbox, EmptyState, FormField, Input, Modal, Select } from './ui';

interface Tile {
  id: string;
  name: string;
  url: string;
  description: string | null;
  icon: string;
  groups: string[];
}

const ICONS: Record<string, { icon: ReactNode; label: string }> = {
  link: { icon: <Link2 />, label: 'Link' },
  chart: { icon: <BarChart3 />, label: 'Report / chart' },
  sheet: { icon: <Sheet />, label: 'Spreadsheet' },
  doc: { icon: <FileText />, label: 'Document' },
  folder: { icon: <Folder />, label: 'Folder' },
  video: { icon: <Video />, label: 'Video' },
  form: { icon: <ClipboardList />, label: 'Form' },
  calendar: { icon: <CalendarDays />, label: 'Calendar' },
};

const host = (u: string) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return u;
  }
};

export function DashboardTiles() {
  const q = useQuery({ queryKey: ['dashboard-tiles'], queryFn: () => api<{ items: Tile[]; canManage: boolean }>('/dashboard/tiles') });
  const [managing, setManaging] = useState(false);
  const tiles = q.data?.items ?? [];
  if (!q.data || (!tiles.length && !q.data.canManage)) return null;
  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">Quick links</h2>
        {q.data.canManage && (
          <Button size="xs" variant="ghost" icon={<Settings2 />} onClick={() => setManaging(true)}>
            Manage
          </Button>
        )}
      </div>
      {tiles.length === 0 ? (
        <EmptyState title="No quick links yet">Add the reports, sheets and sites your team opens every day.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {tiles.map((t) => (
            <a
              key={t.id}
              href={t.url}
              target="_blank"
              rel="noreferrer noopener"
              className="card group flex items-start gap-3 p-4 transition-[transform,box-shadow,border-color] duration-300 ease-[var(--ease-apple)] hover:-translate-y-0.5 hover:border-line hover:shadow-[var(--shadow-float)]"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-fg [&>svg]:size-[18px] [&>svg]:stroke-[1.75]">{ICONS[t.icon]?.icon ?? <Link2 />}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 text-sm font-semibold">
                  <span className="truncate">{t.name}</span>
                  <ExternalLink className="size-3.5 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
                </span>
                <span className="block truncate text-xs text-muted">{t.description || host(t.url)}</span>
              </span>
            </a>
          ))}
        </div>
      )}
      {managing && <ManageTiles tiles={tiles} onClose={() => setManaging(false)} />}
    </section>
  );
}

function ManageTiles({ tiles, onClose }: { tiles: Tile[]; onClose: () => void }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['dashboard-tiles'] });
  const groups = useQuery({ queryKey: ['admin-groups'], queryFn: () => api<{ items: { name: string }[] }>('/admin/groups').then((r) => r.items.map((g) => g.name)) });
  const [editing, setEditing] = useState<Partial<Tile> | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      const body = { name: editing.name ?? '', url: editing.url ?? '', description: editing.description ?? '', icon: editing.icon ?? 'link', groups: editing.groups ?? [] };
      await api(editing.id ? `/admin/dashboard-tiles/${editing.id}` : '/admin/dashboard-tiles', { method: editing.id ? 'PUT' : 'POST', body });
      toast.success(editing.id ? 'Link updated' : 'Link added');
      setEditing(null);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(t: Tile) {
    if (!confirm(`Remove “${t.name}”?`)) return;
    try {
      await api(`/admin/dashboard-tiles/${t.id}`, { method: 'DELETE' });
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function move(i: number, d: -1 | 1) {
    const order = tiles.map((t) => t.id);
    [order[i], order[i + d]] = [order[i + d]!, order[i]!];
    try {
      await api('/admin/dashboard-tiles', { method: 'PUT', body: { order } });
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Modal open onClose={onClose} wide title="Quick links">
      {editing ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Name" required>
              <Input value={editing.name ?? ''} placeholder="e.g. Daily sales report" onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </FormField>
            <FormField label="Icon">
              <Select value={editing.icon ?? 'link'} onChange={(e) => setEditing({ ...editing, icon: e.target.value })}>
                {Object.entries(ICONS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <FormField label="Link" required hint="https:// address of the report, sheet or site">
            <Input type="url" value={editing.url ?? ''} placeholder="https://" onChange={(e) => setEditing({ ...editing, url: e.target.value })} />
          </FormField>
          <FormField label="Description">
            <Input value={editing.description ?? ''} placeholder="Shown under the name (optional)" onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
          </FormField>
          <div>
            <p className="label">Who sees it</p>
            <p className="mb-2 text-xs text-muted">No group ticked = everyone. Admins always see every link.</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {(groups.data ?? []).map((g) => (
                <Checkbox key={g} label={g} checked={(editing.groups ?? []).includes(g)} onChange={(on) => setEditing({ ...editing, groups: on ? [...(editing.groups ?? []), g] : (editing.groups ?? []).filter((x) => x !== g) })} />
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-line/70 pt-3">
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Back
            </Button>
            <Button variant="primary" loading={busy} disabled={!editing.name?.trim() || !/^https?:\/\//i.test(editing.url ?? '')} onClick={() => void save()}>
              {editing.id ? 'Save link' : 'Add link'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {tiles.length === 0 && <p className="text-sm text-muted">No links yet.</p>}
          {tiles.map((t, i) => (
            <div key={t.id} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2">
              <span className="text-muted [&>svg]:size-4">{ICONS[t.icon]?.icon ?? <Link2 />}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{t.name}</span>
                <span className="block truncate text-xs text-muted">
                  {host(t.url)} · {t.groups.length ? t.groups.join(', ') : 'everyone'}
                </span>
              </span>
              <Button size="xs" variant="ghost" aria-label="Move up" disabled={i === 0} icon={<ArrowUp />} onClick={() => void move(i, -1)} />
              <Button size="xs" variant="ghost" aria-label="Move down" disabled={i === tiles.length - 1} icon={<ArrowDown />} onClick={() => void move(i, 1)} />
              <Button size="xs" variant="ghost" aria-label={`Edit ${t.name}`} icon={<Pencil />} onClick={() => setEditing(t)} />
              <Button size="xs" variant="ghost" aria-label={`Remove ${t.name}`} icon={<Trash2 />} onClick={() => void remove(t)} />
            </div>
          ))}
          <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ icon: 'chart', groups: [] })}>
            Add a link
          </Button>
        </div>
      )}
    </Modal>
  );
}
