import clsx from 'clsx';
import { FilePlus2, FileStack } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useFlowsInvalidation, useTemplates } from '../lib/queries';
import type { TemplateSummary } from '../lib/types';
import { Button, FormField, Input, Modal, Spinner, Textarea } from './ui';

/** New flow: blank or copied from a template. Always created as a draft and opened in the flow editor. */
export function CreateFlowDialog({ onClose, template: preset }: { onClose: () => void; template?: TemplateSummary }) {
  const navigate = useNavigate();
  const invalidate = useFlowsInvalidation();
  const templates = useTemplates();
  const [templateId, setTemplateId] = useState<string | null>(preset?.id ?? null);
  const chosen = templates.data?.items.find((t) => t.id === templateId) ?? preset;
  const [name, setName] = useState(preset?.name ?? '');
  const [description, setDescription] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const r = await api<{ key: string }>('/flows', {
        method: 'POST',
        body: { name: name.trim(), description: description.trim() || undefined, label: label.trim() || undefined, templateId: templateId ?? undefined },
      });
      invalidate();
      toast.success('Draft flow created', { description: 'Design it, then click Publish.' });
      onClose();
      navigate(`/flows/${r.key}/editor`);
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
      title="Create flow"
      wide
      footer={
        <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void create()}>
          Create and open editor
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_1.1fr]">
        <div className="space-y-3">
          <FormField label="Flow name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Purchase Indent" autoFocus />
          </FormField>
          <FormField label="Description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this process is for" />
          </FormField>
          <FormField label="Label" hint="Group flows on the All Flows page, e.g. Sales, HR">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} />
          </FormField>
        </div>
        <div>
          <p className="label">Start from</p>
          <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
            <button
              type="button"
              onClick={() => setTemplateId(null)}
              className={clsx('flex w-full items-start gap-3 rounded-lg border p-3 text-left', templateId === null ? 'border-primary bg-primary-soft' : 'border-line hover:bg-surface-2')}
            >
              <FilePlus2 className="mt-0.5 size-5 shrink-0 text-primary" />
              <span>
                <span className="block text-sm font-medium">Blank flow</span>
                <span className="block text-xs text-muted">An intake form and one review stage to build on</span>
              </span>
            </button>
            {templates.isLoading && <Spinner />}
            {templates.data?.items.map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => {
                  setTemplateId(t.id);
                  if (!name.trim() || name === chosen?.name) setName(t.name);
                }}
                className={clsx('flex w-full items-start gap-3 rounded-lg border p-3 text-left', templateId === t.id ? 'border-primary bg-primary-soft' : 'border-line hover:bg-surface-2')}
              >
                <FileStack className="mt-0.5 size-5 shrink-0 text-muted" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t.name}</span>
                  <span className="block text-xs text-muted">
                    {t.category} · {t.stages.length} stages · {t.fieldCount} fields
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
