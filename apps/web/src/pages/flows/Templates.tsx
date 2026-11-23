import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, Eye, FileStack, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { normalizeGuard, type FieldDef, type StageDef } from '@fms/core';
import { CreateFlowDialog } from '../../components/CreateFlowDialog';
import { Badge, Button, EmptyState, ErrorNote, Input, Modal, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useTemplates } from '../../lib/queries';
import type { TemplateSummary } from '../../lib/types';

export default function TemplatesPage() {
  const { can, isSuperAdmin } = useAuth();
  const templates = useTemplates();
  const [category, setCategory] = useState('All');
  const [q, setQ] = useState('');
  const [use, setUse] = useState<TemplateSummary | null>(null);
  const [preview, setPreview] = useState<TemplateSummary | null>(null);

  const categories = useMemo(() => ['All', ...new Set(templates.data?.items.map((t) => t.category) ?? [])], [templates.data]);
  const list = (templates.data?.items ?? []).filter((t) => (category === 'All' || t.category === category) && (!q || `${t.name} ${t.description ?? ''}`.toLowerCase().includes(q.toLowerCase())));

  async function remove(t: TemplateSummary) {
    if (!window.confirm(`Delete the template “${t.name}”? Flows already created from it are not affected.`)) return;
    try {
      await api(`/templates/${t.id}`, { method: 'DELETE' });
      toast.success('Template deleted');
      void templates.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Templates</h1>
        <p className="mt-1 text-sm text-muted">Ready-made processes. Copy one into your organization and adapt the stages, fields and timings in the flow editor.</p>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              aria-pressed={category === c}
              className={clsx('rounded-full border px-3 py-1 text-sm', category === c ? 'border-primary bg-primary text-primary-fg' : 'border-line bg-surface text-muted hover:text-fg')}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input className="pl-9" placeholder="Search templates…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search templates" />
        </div>
      </div>

      <ErrorNote error={templates.error} />
      {templates.isLoading ? (
        <Spinner />
      ) : list.length === 0 ? (
        <EmptyState title="No templates found" />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((t) => (
            <article key={t.id} className="card flex flex-col p-5">
              <div className="mb-3 flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
                  <FileStack className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="font-semibold leading-snug">{t.name}</h2>
                  <p className="mt-0.5 flex flex-wrap gap-1.5 text-xs">
                    <Badge>{t.category}</Badge>
                    <Badge tone={t.builtIn ? 'primary' : t.scope === 'global' ? 'info' : 'neutral'}>{t.builtIn ? 'Built-in' : t.scope === 'global' ? 'All organizations' : 'Your organization'}</Badge>
                  </p>
                </div>
              </div>
              <p className="mb-4 line-clamp-3 text-sm text-muted">{t.description}</p>
              <div className="mb-4 flex flex-wrap items-center gap-1">
                {t.stages.map((s, i) => (
                  <span key={s.key} className="flex items-center gap-1">
                    {i > 0 && <ArrowRight className="size-3 text-muted" />}
                    <span className="rounded px-1.5 py-0.5 text-[11px] font-medium" style={{ background: `${s.color}1f`, color: s.color }}>
                      {s.name}
                    </span>
                  </span>
                ))}
              </div>
              <div className="mt-auto flex items-center gap-2 border-t border-line pt-3">
                <span className="text-xs text-muted">
                  {t.stages.length} stages · {t.fieldCount} fields
                </span>
                <span className="ml-auto flex gap-1.5">
                  {((!t.builtIn && t.scope === 'organization' && can('ADMIN')) || (!t.builtIn && t.scope === 'global' && isSuperAdmin)) && (
                    <Button size="sm" variant="ghost" aria-label={`Delete ${t.name}`} icon={<Trash2 className="size-4" />} onClick={() => void remove(t)} />
                  )}
                  <Button size="sm" icon={<Eye className="size-3.5" />} onClick={() => setPreview(t)}>
                    Preview
                  </Button>
                  {can('ADMIN') && (
                    <Button size="sm" variant="primary" onClick={() => setUse(t)}>
                      Use template
                    </Button>
                  )}
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
      {use && <CreateFlowDialog template={use} onClose={() => setUse(null)} />}
      {preview && <PreviewDialog template={preview} onClose={() => setPreview(null)} onUse={can('ADMIN') ? () => (setUse(preview), setPreview(null)) : undefined} />}
    </div>
  );
}

const planText = (s: StageDef) => {
  if (s.planned.mode === 'manual') return 'Planned date set by owner';
  if (s.planned.mode !== 'tat') return null;
  const base = s.planned.base.kind === 'previous_stage' ? 'after previous stage' : s.planned.base.kind === 'created' ? 'after creation' : `from ${s.planned.base.field}`;
  return s.planned.tat.kind === 'fixed' ? `${s.planned.tat.hours} working h ${base}` : `TAT by ${s.planned.tat.field} ${base}`;
};

function PreviewDialog({ template, onClose, onUse }: { template: TemplateSummary; onClose: () => void; onUse?: () => void }) {
  const detail = useQuery({ queryKey: ['template', template.id], queryFn: () => api<{ definition: { stages: StageDef[]; fields: FieldDef[] } }>(`/templates/${template.id}`) });
  const def = detail.data?.definition;
  return (
    <Modal open onClose={onClose} title={template.name} wide footer={onUse && <Button variant="primary" onClick={onUse}>Use template</Button>}>
      <p className="mb-4 text-sm text-muted">{template.description}</p>
      {!def ? (
        <Spinner />
      ) : (
        <ol className="space-y-3">
          {def.stages.map((s, i) => (
            <li key={s.key} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid size-6 place-items-center rounded-full text-xs font-semibold text-white" style={{ background: s.color }}>
                  {i + 1}
                </span>
                <span className="font-medium">{s.name}</span>
                {s.responsibleGroups.length > 0 && <span className="text-xs text-muted">owner: {s.responsibleGroups.join(', ')}</span>}
                {planText(s) && <Badge>{planText(s)}</Badge>}
                {s.guards?.length ? <Badge tone="info">{normalizeGuard(s.guards[s.guards.length - 1]!).take === 'else' ? 'Otherwise path' : 'Conditional path'}</Badge> : s.applicableWhen?.conditions.length ? <Badge tone="info">conditional</Badge> : null}
                <Badge tone="success">{s.completion.kind === 'on_create' ? 'form submit' : s.completion.kind === 'manual' ? 'mark done' : 'auto when filled'}</Badge>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {def.fields
                  .filter((f) => f.stageKey === s.key)
                  .map((f) => (
                    <span key={f.key} className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-xs">
                      {f.label}
                      {f.required && <span className="text-danger">*</span>} <span className="text-muted">· {f.type}</span>
                    </span>
                  ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
