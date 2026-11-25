/**
 * Records list: export (CSV file or a Google Sheet tab — legacy pastedatafun) and CSV import.
 */
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, Download, ExternalLink, FileSpreadsheet, FileUp, Sheet, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, FormField, Input, Modal, Select } from '../../components/ui';
import { api, download } from '../../lib/api';
import type { FieldView, WorkflowView } from '../../lib/types';

type Query = Record<string, string | number | undefined>;
const clean = (q: Query) => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));

// ------------------------------------------------------------------ export
export function ExportMenu({ wf, query }: { wf: WorkflowView; query: Query }) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const item = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2 [&>svg]:size-4 [&>svg]:text-muted';
  return (
    <div ref={ref} className="relative">
      <Button icon={<Download className="size-4" />} onClick={() => setOpen(!open)} aria-expanded={open}>
        Export <ChevronDown className={clsx('size-3.5 transition-transform duration-200', open && 'rotate-180')} />
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-56 animate-pop-in rounded-xl border border-line bg-surface p-1 shadow-[var(--shadow-float)]">
          <button
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              download(`/workflows/${wf.key}/records/export.csv`, clean(query)).catch((e: Error) => toast.error(e.message));
            }}
          >
            <FileSpreadsheet /> CSV file (Excel)
          </button>
          <button type="button" className={item} onClick={() => (setOpen(false), setSheet(true))}>
            <Sheet /> Google Sheet…
          </button>
        </div>
      )}
      {sheet && <SheetExport wf={wf} query={query} onClose={() => setSheet(false)} />}
    </div>
  );
}

function SheetExport({ wf, query, onClose }: { wf: WorkflowView; query: Query; onClose: () => void }) {
  const info = useQuery({ queryKey: ['export-sheet', wf.key], queryFn: () => api<{ configured: boolean; clientEmail: string | null }>(`/workflows/${wf.key}/records/export-sheet`) });
  const store = `fms-sheet-${wf.key}`;
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(store) ?? 'null') as { url: string; tab: string } | null;
    } catch {
      return null;
    }
  })();
  const [url, setUrl] = useState(saved?.url ?? '');
  const [tab, setTab] = useState(saved?.tab ?? wf.name.slice(0, 90));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ url: string; rows: number } | null>(null);
  async function run() {
    setBusy(true);
    try {
      const r = await api<{ url: string; rows: number }>(`/workflows/${wf.key}/records/export-sheet`, { method: 'POST', body: { url, tab, query: clean(query) } });
      try {
        localStorage.setItem(store, JSON.stringify({ url, tab }));
      } catch {
        /* private mode */
      }
      setDone(r);
      toast.success(`${r.rows} record${r.rows === 1 ? '' : 's'} written to “${tab}”`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Export to a Google Sheet"
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" icon={<Upload className="size-4" />} loading={busy} disabled={!info.data?.configured || !url.trim() || !tab.trim()} onClick={() => void run()}>
              Export
            </Button>
          </>
        )
      }
    >
      {info.data && !info.data.configured ? (
        <p className="rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning">Google Sheets is not set up yet. An admin can add a service account in Settings › Connections › Google Sheets.</p>
      ) : done ? (
        <div className="space-y-2 text-sm">
          <p>
            <b>{done.rows}</b> record{done.rows === 1 ? '' : 's'} are in the tab “{tab}”.
          </p>
          <a className="inline-flex items-center gap-1 text-info underline" href={done.url} target="_blank" rel="noreferrer">
            Open the spreadsheet <ExternalLink className="size-3.5" />
          </a>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">The records in the current list (search, status, stage and filters applied) replace everything in the tab. Only fields you can see are exported.</p>
          <FormField label="Spreadsheet link" required>
            <Input value={url} placeholder="https://docs.google.com/spreadsheets/d/…" onChange={(e) => setUrl(e.target.value)} />
          </FormField>
          <FormField label="Tab" required hint="Created if it does not exist.">
            <Input value={tab} onChange={(e) => setTab(e.target.value)} />
          </FormField>
          {info.data?.clientEmail && (
            <p className="rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted">
              First share the spreadsheet with <b className="select-all font-mono text-fg">{info.data.clientEmail}</b> as an Editor.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ import
/** RFC 4180 CSV (quotes, commas / semicolons / tabs, line breaks inside quotes, BOM). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** dd/mm/yyyy [hh:mm] (the legacy sheets' format) → ISO; ISO and anything else pass through. */
function normalizeDate(v: string, withTime: boolean): string {
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(v.trim());
  if (!m) return v.trim();
  const date = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return withTime ? `${date}T${(m[4] ?? '00').padStart(2, '0')}:${m[5] ?? '00'}` : date;
}

interface ImportResult {
  total: number;
  ok: number;
  failed: number;
  results: { row: number; ok: boolean; errors?: Record<string, string>; message?: string }[];
}

export function ImportDialog({ wf, onClose, onDone }: { wf: WorkflowView; onClose: () => void; onDone: () => void }) {
  const intake = wf.stages[0]!.key;
  const targets = useMemo(() => wf.fields.filter((f) => f.stageKey === intake && f.canEdit && !['computed', 'user-email', 'file'].includes(f.type)), [wf, intake]);
  const [file, setFile] = useState<{ name: string; header: string[]; rows: string[][] } | null>(null);
  const [map, setMap] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<'check' | 'import' | null>(null);
  const [result, setResult] = useState<(ImportResult & { dryRun: boolean }) | null>(null);

  async function pick(f: File | undefined) {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return void toast.error('The file is larger than 5 MB — split it into smaller files');
    const rows = parseCsv(await f.text());
    if (rows.length < 2) return void toast.error('The file needs a header row and at least one record');
    const header = rows[0]!.map((h) => h.trim());
    // Match columns to fields by label or key.
    const auto: Record<number, string> = {};
    header.forEach((h, i) => {
      const t = targets.find((x) => norm(x.label) === norm(h) || norm(x.key) === norm(h));
      if (t && !Object.values(auto).includes(t.key)) auto[i] = t.key;
    });
    setFile({ name: f.name, header, rows: rows.slice(1) });
    setMap(auto);
    setResult(null);
  }

  const toRecords = () =>
    file!.rows.map((r) => {
      const out: Record<string, string> = {};
      for (const [i, key] of Object.entries(map)) {
        if (!key) continue;
        const f = targets.find((x) => x.key === key) as FieldView;
        const v = (r[Number(i)] ?? '').trim();
        if (v === '') continue;
        out[key] = f.type === 'date' || f.type === 'datetime' ? normalizeDate(v, f.type === 'datetime') : v;
      }
      return out;
    });

  async function send(dryRun: boolean) {
    setBusy(dryRun ? 'check' : 'import');
    try {
      const records = toRecords();
      const total: ImportResult = { total: 0, ok: 0, failed: 0, results: [] };
      for (let i = 0; i < records.length; i += 1000) {
        const r = await api<ImportResult>(`/workflows/${wf.key}/records/import`, { method: 'POST', body: { rows: records.slice(i, i + 1000), dryRun } });
        total.total += r.total;
        total.ok += r.ok;
        total.failed += r.failed;
        total.results.push(...r.results.map((x) => ({ ...x, row: x.row + i })));
      }
      setResult({ ...total, dryRun });
      if (!dryRun) {
        toast.success(`${total.ok} record${total.ok === 1 ? '' : 's'} imported`, total.failed ? { description: `${total.failed} row${total.failed === 1 ? '' : 's'} not imported — see the list` } : undefined);
        onDone();
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const mapped = Object.values(map).filter(Boolean);
  const missingRequired = targets.filter((f) => f.required && !mapped.includes(f.key));
  const label = (k: string) => targets.find((f) => f.key === k)?.label ?? k;

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Import records — ${wf.name}`}
      footer={
        file && (
          <>
            <Button variant="ghost" onClick={onClose}>
              {result && !result.dryRun ? 'Close' : 'Cancel'}
            </Button>
            {!(result && !result.dryRun) && (
              <>
                <Button loading={busy === 'check'} disabled={!!busy || !mapped.length} onClick={() => void send(true)}>
                  Check {file.rows.length} row{file.rows.length === 1 ? '' : 's'}
                </Button>
                <Button variant="primary" icon={<FileUp className="size-4" />} loading={busy === 'import'} disabled={!!busy || !result?.dryRun || !result.ok} onClick={() => void send(false)}>
                  Import {result?.dryRun ? result.ok : ''} row{result?.dryRun && result.ok === 1 ? '' : 's'}
                </Button>
              </>
            )}
          </>
        )
      }
    >
      {!file ? (
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-line px-6 py-10 text-center transition-colors hover:border-muted hover:bg-surface-2/50">
          <Upload className="size-7 text-muted" />
          <span className="text-sm font-medium">Choose a CSV file</span>
          <span className="max-w-md text-xs text-muted">
            One record per row, with a header row. Columns are matched to the intake form’s fields by name. Dates may be dd/mm/yyyy. Up to 5 MB; rows go through the same checks as the form, and you check them before
            anything is saved.
          </span>
          <input type="file" accept=".csv,.tsv,.txt,text/csv" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} />
        </label>
      ) : (
        <div className="space-y-4">
          <p className="text-sm">
            <b>{file.name}</b> — {file.rows.length} row{file.rows.length === 1 ? '' : 's'}, {file.header.length} columns.{' '}
            <button type="button" className="text-info hover:underline" onClick={() => setFile(null)}>
              Choose another file
            </button>
          </p>
          <div>
            <p className="label">Columns → fields</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {file.header.map((h, i) => (
                <div key={i} className="flex items-center gap-2 rounded-xl border border-line px-2.5 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium" title={h}>
                      {h || `Column ${i + 1}`}
                    </span>
                    <span className="block truncate text-[11px] text-muted">{file.rows[0]?.[i] || '—'}</span>
                  </span>
                  <Select aria-label={`Field for ${h}`} className="h-8 w-44 text-[13px]" value={map[i] ?? ''} onChange={(e) => setMap({ ...map, [i]: e.target.value })}>
                    <option value="">Skip</option>
                    {targets.map((f) => (
                      <option key={f.key} value={f.key} disabled={mapped.includes(f.key) && map[i] !== f.key}>
                        {f.label}
                        {f.required ? ' *' : ''}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>
            {missingRequired.length > 0 && <p className="mt-2 text-xs text-warning">Required fields with no column (rows need a default value for them): {missingRequired.map((f) => f.label).join(', ')}</p>}
          </div>

          {result && (
            <div className="space-y-2">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                {result.dryRun ? 'Check:' : 'Imported:'} <Badge tone="success">{result.ok} ok</Badge>
                {result.failed > 0 && <Badge tone="danger">{result.failed} with problems</Badge>}
                {result.dryRun && result.ok > 0 && <span className="text-xs text-muted">Rows with problems are skipped when you import.</span>}
              </p>
              {result.results.length > 0 && (
                <div className="max-h-56 overflow-auto rounded-xl border border-line">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Problem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.results.map((r) => (
                        <tr key={r.row}>
                          <td className="tabular-nums">{r.row + 1}</td>
                          <td className="text-[13px]">{r.errors ? Object.entries(r.errors).map(([k, v]) => `${label(k)}: ${v}`).join(' · ') : r.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[11px] text-muted">Row numbers count the header as row 1, like a spreadsheet.</p>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
