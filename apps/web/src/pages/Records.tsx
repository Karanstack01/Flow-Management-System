import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type RowSelectionState, type VisibilityState } from '@tanstack/react-table';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Archive, ArchiveRestore, Columns3, Download, Filter, Layers, Plus, Save, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { ConditionGroup } from '@fms/core';
import { ConditionEditor } from '../components/ConditionEditor';
import { CurrentStageBadge } from '../components/Stage';
import { FieldInput } from '../components/FieldInput';
import { Badge, Button, EmptyState, ErrorNote, FormField, Input, Modal, PageHeader, Select, Spinner } from '../components/ui';
import { api, download } from '../lib/api';
import { displayValue, fmtDateTime, fmtNumber } from '../lib/format';
import { useRecords, useRecordsInvalidation, useViews, useWorkflow, type RecordParams } from '../lib/queries';
import type { FieldView, RecordData, RecordDto, StageView, WorkflowView } from '../lib/types';

const EMPTY_GROUP: ConditionGroup = { mode: 'all', conditions: [] };

function defaultColumns(wf: WorkflowView): string[] {
  const intake = wf.stages[0]?.key;
  const pinned = wf.fields.filter((f) => f.frozen || f.searchKey).map((f) => f.key);
  const rest = wf.fields.filter((f) => f.stageKey === intake && !pinned.includes(f.key) && f.type !== 'file').map((f) => f.key);
  return [...pinned, ...rest].slice(0, 8);
}

export default function Records() {
  const { wf: wfKey = '' } = useParams();
  const { data: wf, error } = useWorkflow(wfKey);
  if (error) return <ErrorNote error={error} />;
  if (!wf) return <Spinner />;
  return <RecordsGrid key={wf.id} wf={wf} />;
}

function RecordsGrid({ wf }: { wf: WorkflowView }) {
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const invalidate = useRecordsInvalidation(wf.key);
  const { data: views, refetch: refetchViews } = useViews(wf.key);

  const params: RecordParams = {
    page: Number(sp.get('page') ?? 1),
    pageSize: Number(sp.get('size') ?? 50),
    sort: sp.get('sort') ?? 'number',
    dir: (sp.get('dir') as 'asc' | 'desc') ?? 'desc',
    search: sp.get('q') ?? undefined,
    stage: sp.get('stage') ?? undefined,
    status: ['archived', 'all'].includes(sp.get('status') ?? '') ? undefined : (sp.get('status') ?? 'open'),
    archived: sp.get('status') === 'archived' ? 'true' : undefined,
    mine: sp.get('mine') ?? undefined,
    filters: sp.get('filters') ?? undefined,
  };
  const set = (patch: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) (v === null || v === '' ? next.delete(k) : next.set(k, v));
    if (resetPage) next.delete('page');
    setSp(next, { replace: true });
  };

  const { data, isFetching, error } = useRecords(wf.key, params);
  const [searchText, setSearchText] = useState(params.search ?? '');
  useEffect(() => {
    const t = setTimeout(() => searchText !== (params.search ?? '') && set({ q: searchText || null }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  const [columns, setColumns] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`fms-cols-${wf.key}`) ?? 'null');
      if (Array.isArray(saved)) return saved;
    } catch {
      /* ignore */
    }
    return defaultColumns(wf);
  });
  useEffect(() => {
    try {
      localStorage.setItem(`fms-cols-${wf.key}`, JSON.stringify(columns));
    } catch {
      /* ignore */
    }
  }, [columns, wf.key]);

  const filters: ConditionGroup = useMemo(() => {
    try {
      return params.filters ? (JSON.parse(params.filters) as ConditionGroup) : EMPTY_GROUP;
    } catch {
      return EMPTY_GROUP;
    }
  }, [params.filters]);

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState<ConditionGroup>(filters);
  const fieldByKey = useMemo(() => new Map(wf.fields.map((f) => [f.key, f])), [wf.fields]);
  const headerTint = useMemo(() => {
    const colorOf = new Map(wf.stages.filter((s) => s.headerColor).map((s) => [s.key, s.headerColor!]));
    return new Map(wf.fields.filter((f) => colorOf.has(f.stageKey)).map((f) => [f.key, colorOf.get(f.stageKey)!]));
  }, [wf]);
  const bulkStages = wf.stages.filter((s) => s.bulkUpdate && s.canEdit !== false);
  const [bulkOpen, setBulkOpen] = useState(false);

  const tableColumns = useMemo<ColumnDef<RecordDto>[]>(() => {
    const cols: ColumnDef<RecordDto>[] = [
      {
        id: 'select',
        header: ({ table }) => <input type="checkbox" aria-label="Select all" checked={table.getIsAllRowsSelected()} onChange={table.getToggleAllRowsSelectedHandler()} />,
        cell: ({ row }) => <input type="checkbox" aria-label={`Select #${row.original.number}`} checked={row.getIsSelected()} onChange={row.getToggleSelectedHandler()} onClick={(e) => e.stopPropagation()} />,
        size: 36,
      },
      { id: 'number', header: '#', cell: ({ row }) => <span className="font-medium tabular-nums">{row.original.number}</span>, size: 64 },
      { id: 'stage', header: 'Current stage', enableSorting: false, cell: ({ row }) => <CurrentStageBadge stages={row.original.stages} defs={wf.stages} currentStageKey={row.original.currentStageKey} /> },
    ];
    for (const key of columns) {
      const f = fieldByKey.get(key);
      if (!f) continue;
      cols.push({ id: f.key, header: f.label, size: f.width, cell: ({ row }) => <Cell field={f} value={row.original.data[f.key]} zone={wf.timezone} /> });
    }
    cols.push({ id: 'createdAt', header: 'Created', cell: ({ row }) => <span className="whitespace-nowrap text-muted">{fmtDateTime(row.original.createdAt)}</span> });
    return cols;
  }, [columns, fieldByKey, wf.stages, wf.timezone]);

  const table = useReactTable({
    data: data?.items ?? [],
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => r.id,
    manualPagination: true,
    manualSorting: true,
    enableRowSelection: true,
    state: { rowSelection, columnVisibility: {} as VisibilityState },
    onRowSelectionChange: setRowSelection,
  });

  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);
  const totalPages = data ? Math.max(1, Math.ceil(data.total / params.pageSize)) : 1;
  const archivedView = sp.get('status') === 'archived';

  async function bulk(action: 'archive' | 'restore') {
    try {
      const r = await api<{ count: number }>(`/workflows/${wf.key}/records/${action}`, { method: 'POST', body: { ids: selectedIds } });
      toast.success(`${r.count} record(s) ${action === 'archive' ? 'archived' : 'restored'}`);
      setRowSelection({});
      invalidate();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function saveView() {
    const name = window.prompt('Name this view');
    if (!name) return;
    try {
      await api(`/workflows/${wf.key}/views`, {
        method: 'POST',
        body: { name, config: { columns, filters, sort: { by: params.sort, dir: params.dir }, status: sp.get('status') ?? undefined, stage: params.stage } },
      });
      toast.success('View saved');
      void refetchViews();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function applyView(id: string) {
    const v = views?.find((x) => x.id === id);
    if (!v) return;
    if (v.config.columns?.length) setColumns(v.config.columns);
    set({
      filters: v.config.filters?.conditions?.length ? JSON.stringify(v.config.filters) : null,
      sort: v.config.sort?.by ?? null,
      dir: v.config.sort?.dir ?? null,
      status: v.config.status ?? null,
      stage: v.config.stage ?? null,
    });
  }

  const sortBy = (id: string) => {
    if (id === 'select' || id === 'stage') return;
    set({ sort: id, dir: params.sort === id && params.dir === 'desc' ? 'asc' : 'desc' });
  };

  return (
    <div className="mx-auto max-w-[1600px]">
      <PageHeader
        title={wf.name}
        subtitle={data ? `${data.total.toLocaleString()} record${data.total === 1 ? '' : 's'}` : ' '}
        actions={
          <>
            {wf.canExport && (
              <Button icon={<Download className="size-4" />} onClick={() => download(`/workflows/${wf.key}/records/export.csv`, { ...params, page: undefined, pageSize: undefined }).catch((e: Error) => toast.error(e.message))}>
                Export
              </Button>
            )}
            {wf.canCreate && wf.isActive && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate(`/w/${wf.key}/new`)}>
                New record
              </Button>
            )}
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" />
          <Input className="pl-8" placeholder="Search records…" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="Search records" />
        </div>
        <Select className="w-auto" aria-label="Status" value={sp.get('status') ?? 'open'} onChange={(e) => set({ status: e.target.value })}>
          <option value="open">Open</option>
          <option value="overdue">Overdue</option>
          <option value="completed">Completed</option>
          <option value="all">All active</option>
          <option value="archived">Archived</option>
        </Select>
        <Select className="w-auto" aria-label="Stage" value={params.stage ?? ''} onChange={(e) => set({ stage: e.target.value || null })}>
          <option value="">All stages</option>
          {wf.stages.slice(1).map((s) => (
            <option key={s.key} value={s.key}>
              {s.name}
            </option>
          ))}
        </Select>
        <label className="inline-flex items-center gap-1.5 text-sm text-muted">
          <input type="checkbox" checked={params.mine === 'true'} onChange={(e) => set({ mine: e.target.checked ? 'true' : null })} /> My tasks
        </label>
        <Button
          icon={<Filter className="size-4" />}
          onClick={() => {
            setDraftFilters(filters);
            setFilterOpen(true);
          }}
        >
          Filters{filters.conditions.length ? ` (${filters.conditions.length})` : ''}
        </Button>
        <Button icon={<Columns3 className="size-4" />} onClick={() => setColsOpen(true)}>
          Columns
        </Button>
        <Select className="w-auto" aria-label="Saved views" value="" onChange={(e) => applyView(e.target.value)}>
          <option value="">Saved views…</option>
          {views?.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.isShared ? ' (shared)' : ''}
            </option>
          ))}
        </Select>
        <Button variant="ghost" icon={<Save className="size-4" />} onClick={() => void saveView()}>
          Save view
        </Button>
      </div>

      {selectedIds.length > 0 && (wf.canArchive || (bulkStages.length > 0 && !archivedView && wf.isActive)) && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm">
          {selectedIds.length} selected
          {bulkStages.length > 0 && !archivedView && wf.isActive && (
            <Button size="sm" variant="primary" icon={<Layers className="size-4" />} onClick={() => setBulkOpen(true)}>
              Bulk update
            </Button>
          )}
          {!wf.canArchive ? null : archivedView ? (
            <Button size="sm" icon={<ArchiveRestore className="size-4" />} onClick={() => void bulk('restore')}>
              Restore
            </Button>
          ) : (
            <Button size="sm" variant="danger" icon={<Archive className="size-4" />} onClick={() => confirm(`Archive ${selectedIds.length} record(s)?`) && void bulk('archive')}>
              Archive
            </Button>
          )}
        </div>
      )}

      <ErrorNote error={error} />
      <div className={clsx('card overflow-hidden', isFetching && 'opacity-80')}>
        <div className="max-h-[calc(100vh-17rem)] overflow-auto">
          <table className="table-base">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => {
                    const sortable = !['select', 'stage'].includes(h.column.id);
                    // Stage header colour (Stage › Basic settings) tints the columns of that stage's fields.
                    const tint = headerTint.get(h.column.id);
                    return (
                      <th
                        key={h.id}
                        style={{ minWidth: h.column.columnDef.size, ...(tint ? { background: tint, color: readableOn(tint) } : {}) }}
                        className={clsx(sortable && 'cursor-pointer select-none')}
                        onClick={() => sortable && sortBy(h.column.id)}
                      >
                        <span className="inline-flex items-center gap-1">
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {params.sort === h.column.id && (params.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="cursor-pointer hover:bg-surface-2" onClick={() => navigate(`/w/${wf.key}/records/${row.original.id}`)}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            {data && data.items.length > 0 && Object.keys(data.aggregates).some((k) => columns.includes(k)) && (
              <tfoot>
                <tr className="bg-surface-2 text-xs text-muted">
                  {table.getVisibleLeafColumns().map((c) => {
                    const agg = data.aggregates[c.id];
                    return <td key={c.id}>{agg ? <span title={`Average ${fmtNumber(agg.avg)}`}>Σ {fmtNumber(agg.sum)}</span> : c.id === 'number' ? 'Total' : ''}</td>;
                  })}
                </tr>
              </tfoot>
            )}
          </table>
          {data && data.items.length === 0 && (
            <div className="p-4">
              <EmptyState title="No records match">Try clearing filters or changing the status.</EmptyState>
            </div>
          )}
          {!data && !error && <Spinner />}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-sm text-muted">
          <span>
            Page {params.page} of {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <Select className="w-auto" aria-label="Rows per page" value={params.pageSize} onChange={(e) => set({ size: e.target.value })}>
              {[25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n} / page
                </option>
              ))}
            </Select>
            <Button size="sm" disabled={params.page <= 1} onClick={() => set({ page: String(params.page - 1) }, false)}>
              Previous
            </Button>
            <Button size="sm" disabled={params.page >= totalPages} onClick={() => set({ page: String(params.page + 1) }, false)}>
              Next
            </Button>
          </div>
        </div>
      </div>

      <Modal
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        title="Filter records"
        wide
        footer={
          <>
            <Button
              variant="ghost"
              icon={<Trash2 className="size-4" />}
              onClick={() => {
                set({ filters: null });
                setFilterOpen(false);
              }}
            >
              Clear
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                set({ filters: draftFilters.conditions.length ? JSON.stringify(draftFilters) : null });
                setFilterOpen(false);
              }}
            >
              Apply
            </Button>
          </>
        }
      >
        <ConditionEditor fields={wf.fields.map((f) => ({ key: f.key, label: f.label, options: f.options }))} value={draftFilters} onChange={setDraftFilters} />
      </Modal>

      {bulkOpen && (
        <BulkUpdate
          wf={wf}
          stages={bulkStages}
          ids={selectedIds}
          initialStage={bulkStages.some((s) => s.key === params.stage) ? params.stage! : bulkStages[0]!.key}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setRowSelection({});
            invalidate();
          }}
        />
      )}

      <Modal open={colsOpen} onClose={() => setColsOpen(false)} title="Columns" footer={<Button onClick={() => setColumns(defaultColumns(wf))}>Reset</Button>}>
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {wf.fields.map((f) => (
            <label key={f.key} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-surface-2">
              <input type="checkbox" checked={columns.includes(f.key)} onChange={(e) => setColumns((c) => (e.target.checked ? [...c, f.key] : c.filter((k) => k !== f.key)))} />
              <span className="truncate">{f.label}</span>
              <span className="ml-auto text-xs text-muted">{wf.stages.find((s) => s.key === f.stageKey)?.name}</span>
            </label>
          ))}
        </div>
      </Modal>
    </div>
  );
}

/** Dark or light text, whichever reads better on a header colour. */
function readableOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1d1d1f' : '#ffffff';
}

/** Stage bulk tool: the same values (and optionally "mark done") for every selected record. */
function BulkUpdate({ wf, stages, ids, initialStage, onClose, onDone }: { wf: WorkflowView; stages: StageView[]; ids: string[]; initialStage: string; onClose: () => void; onDone: () => void }) {
  const [stageKey, setStageKey] = useState(initialStage);
  const [data, setData] = useState<RecordData>({});
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ id: string; number: number | null; message: string }[]>([]);
  const stage = stages.find((s) => s.key === stageKey)!;
  const fields = wf.fields.filter((f) => f.stageKey === stageKey && f.canEdit && !['computed', 'user-email'].includes(f.type) && f.key !== stage.document?.fieldKey);
  const filled = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));

  async function submit() {
    setBusy(true);
    setFailed([]);
    try {
      const r = await api<{ updated: number; failed: { id: string; number: number | null; message: string }[] }>(`/workflows/${wf.key}/records/bulk-update`, { method: 'POST', body: { ids, stageKey, data: filled, complete } });
      if (r.updated) toast.success(`${r.updated} record${r.updated === 1 ? '' : 's'} updated`);
      onDone();
      if (r.failed.length) setFailed(r.failed);
      else onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Bulk update — ${ids.length} record${ids.length === 1 ? '' : 's'}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!Object.keys(filled).length && !complete} onClick={() => void submit()}>
            Update {ids.length}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {stages.length > 1 && (
          <FormField label="Stage">
            <Select value={stageKey} onChange={(e) => (setStageKey(e.target.value), setData({}))}>
              {stages.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <p className="text-sm text-muted">Fields you fill in are written to every selected record; empty fields are left as they are.</p>
        {fields.length === 0 ? (
          <p className="rounded-xl bg-surface-2 p-3 text-sm text-muted">This stage has no fields you can fill in.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {fields.map((f) => (
              <FormField key={f.key} label={f.label} hint={f.helpText}>
                <FieldInput field={f} value={data[f.key]} onChange={(v) => setData((d) => ({ ...d, [f.key]: v }))} zone={wf.timezone} data={data} />
              </FormField>
            ))}
          </div>
        )}
        {stage.completion === 'manual' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} /> Also mark “{stage.name}” done (records where it is the active stage)
          </label>
        )}
        {failed.length > 0 && (
          <div className="rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm">
            <p className="mb-1 font-medium text-danger">{failed.length} not updated:</p>
            <ul className="max-h-40 space-y-0.5 overflow-auto text-xs">
              {failed.map((f) => (
                <li key={f.id}>
                  <b>#{f.number ?? '?'}</b> — {f.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Cell({ field, value, zone }: { field: FieldView; value: unknown; zone: string }) {
  if (field.type === 'multiselect' && Array.isArray(value)) {
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((v) => (
          <Badge key={String(v)}>{String(v)}</Badge>
        ))}
      </span>
    );
  }
  const text = displayValue(field, value, zone);
  return (
    <span className={clsx('line-clamp-2', (field.type === 'number' || field.type === 'computed') && 'tabular-nums')} title={text}>
      {text || <span className="text-muted">—</span>}
    </span>
  );
}
