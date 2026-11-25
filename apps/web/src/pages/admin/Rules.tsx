import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { notificationRuleSchema, type NotificationRuleDef } from '@fms/core';
import { ConditionEditor } from '../../components/ConditionEditor';
import { Badge, Button, Card, Checkbox, EmptyState, FormField, Input, Modal, PageHeader, Select, Spinner, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { useWorkflow, useWorkflows } from '../../lib/queries';
import type { WorkflowView } from '../../lib/types';

interface RuleRow {
  id: string;
  isActive: boolean;
  definition: NotificationRuleDef;
}

const TRIGGER_LABEL: Record<NotificationRuleDef['trigger']['type'], string> = {
  condition: 'When conditions match',
  stage_activated: 'When a stage starts',
  stage_completed: 'When a stage is completed',
  stage_overdue: 'When a stage becomes overdue',
};

/** Replaces the legacy Messages tab. */
export default function RulesAdmin() {
  const { data: workflows } = useWorkflows();
  const [wfKey, setWfKey] = useState('');
  useEffect(() => {
    if (!wfKey && workflows?.length) setWfKey(workflows[0]!.key);
  }, [workflows, wfKey]);
  const { data: wf } = useWorkflow(wfKey);
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ['rules', wfKey], queryFn: () => api<{ items: RuleRow[] }>(`/workflows/${wfKey}/rules`).then((r) => r.items), enabled: !!wfKey });
  const [editing, setEditing] = useState<RuleRow | 'new' | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['rules', wfKey] });

  async function remove(r: RuleRow) {
    if (!confirm(`Delete rule "${r.definition.name}"?`)) return;
    try {
      await api(`/workflows/${wfKey}/rules/${r.id}`, { method: 'DELETE' });
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Notification rules"
        subtitle="Email / WhatsApp messages with {{field_key}} or <<Field Label>> tags. Each rule fires once per record (or every N days)."
        actions={
          <>
            <Select className="w-auto" value={wfKey} onChange={(e) => setWfKey(e.target.value)} aria-label="Workflow">
              {workflows?.map((w) => (
                <option key={w.key} value={w.key}>
                  {w.name}
                </option>
              ))}
            </Select>
            <Button variant="primary" icon={<Plus className="size-4" />} disabled={!wf} onClick={() => setEditing('new')}>
              New rule
            </Button>
          </>
        }
      />
      <Card bodyClassName="p-0">
        {!rules.data ? (
          <Spinner />
        ) : rules.data.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No rules yet">Hand-offs, reminders and digests are built in; add rules for customer emails and custom alerts.</EmptyState>
          </div>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Trigger</th>
                <th>Channels</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.data.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium">
                    {r.definition.name} {!r.isActive && <Badge>Paused</Badge>}
                  </td>
                  <td className="text-muted">
                    {TRIGGER_LABEL[r.definition.trigger.type]}
                    {'stageKey' in r.definition.trigger && `: ${wf?.stages.find((s) => s.key === (r.definition.trigger as { stageKey: string }).stageKey)?.name ?? ''}`}
                    {r.definition.repeatEveryDays ? ` · every ${r.definition.repeatEveryDays}d` : ''}
                  </td>
                  <td>
                    <span className="flex gap-1">
                      {r.definition.email && <Badge tone="primary">Email</Badge>}
                      {r.definition.whatsapp && <Badge tone="success">WhatsApp</Badge>}
                    </span>
                  </td>
                  <td className="whitespace-nowrap">
                    <Button size="sm" variant="ghost" aria-label="Edit" icon={<Pencil className="size-4" />} onClick={() => setEditing(r)} />
                    <Button size="sm" variant="ghost" aria-label="Delete" icon={<Trash2 className="size-4" />} onClick={() => void remove(r)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {editing && wf && <RuleDialog wf={wf} rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}

function RuleDialog({ wf, rule, onClose, onSaved }: { wf: WorkflowView; rule: RuleRow | null; onClose: () => void; onSaved: () => void }) {
  const [def, setDef] = useState<NotificationRuleDef>(
    // Older stored rules get today's defaults (e.g. no attachments) before they are edited.
    (rule && (notificationRuleSchema.safeParse(rule.definition).data ?? rule.definition)) ?? { name: 'New rule', isActive: true, trigger: { type: 'stage_activated', stageKey: wf.stages[1]?.key ?? wf.stages[0]!.key }, email: { to: '{{customer_email}}', subject: 'Update on #{{record_number}}', body: 'Hello {{customer}},\n\nYour request is now at {{current_stage}}.', attachments: [] } },
  );
  const fileFields = wf.fields.filter((f) => f.type === 'file');
  const [busy, setBusy] = useState(false);
  const fields = wf.fields.map((f) => ({ key: f.key, label: f.label, options: f.options }));
  const check = notificationRuleSchema.safeParse(def);

  async function save() {
    setBusy(true);
    try {
      await api(rule ? `/workflows/${wf.key}/rules/${rule.id}` : `/workflows/${wf.key}/rules`, { method: rule ? 'PUT' : 'POST', body: def });
      toast.success('Rule saved');
      onSaved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const t = def.trigger;
  return (
    <Modal open onClose={onClose} wide title={rule ? 'Edit rule' : 'New rule'} footer={<Button variant="primary" disabled={!check.success} loading={busy} onClick={() => void save()}>Save rule</Button>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <FormField label="Name">
            <Input value={def.name} onChange={(e) => setDef({ ...def, name: e.target.value })} />
          </FormField>
          <FormField label="Repeat every (days)" hint="Empty = send once">
            <Input type="number" min={1} value={def.repeatEveryDays ?? ''} onChange={(e) => setDef({ ...def, repeatEveryDays: e.target.value ? Number(e.target.value) : undefined })} />
          </FormField>
          <label className="inline-flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" checked={def.isActive} onChange={(e) => setDef({ ...def, isActive: e.target.checked })} /> Active
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <FormField label="Trigger">
            <Select
              value={t.type}
              onChange={(e) => {
                const type = e.target.value as NotificationRuleDef['trigger']['type'];
                setDef({ ...def, trigger: type === 'condition' ? { type, when: { mode: 'all', conditions: [] } } : { type, stageKey: 'stageKey' in t ? t.stageKey : wf.stages[1]!.key } });
              }}
            >
              {Object.entries(TRIGGER_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </FormField>
          {'stageKey' in t && (
            <FormField label="Stage">
              <Select value={t.stageKey} onChange={(e) => setDef({ ...def, trigger: { ...t, stageKey: e.target.value } })}>
                {wf.stages.slice(1).map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        </div>
        {t.type === 'condition' && <ConditionEditor fields={fields} value={t.when} onChange={(when) => setDef({ ...def, trigger: { type: 'condition', when } })} />}

        <fieldset className="space-y-3 rounded-md border border-line p-3">
          <label className="inline-flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={!!def.email} onChange={(e) => setDef({ ...def, email: e.target.checked ? { to: '', subject: '', body: '', attachments: [] } : undefined })} /> Email
          </label>
          {def.email && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <FormField label="To" hint="Emails or tags, comma separated">
                <Input value={def.email.to} onChange={(e) => setDef({ ...def, email: { ...def.email!, to: e.target.value } })} />
              </FormField>
              <FormField label="Cc">
                <Input value={def.email.cc ?? ''} onChange={(e) => setDef({ ...def, email: { ...def.email!, cc: e.target.value || undefined } })} />
              </FormField>
              <FormField label="Sender name" hint="Shown as the sender; the address stays the email connection's">
                <Input value={def.email.fromName ?? ''} placeholder="e.g. Acme Sales Team" onChange={(e) => setDef({ ...def, email: { ...def.email!, fromName: e.target.value || undefined } })} />
              </FormField>
              <div>
                <span className="label">Attach files from</span>
                {fileFields.length === 0 ? (
                  <p className="text-xs text-muted">This flow has no file fields (uploads or document steps).</p>
                ) : (
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {fileFields.map((f) => (
                      <Checkbox
                        key={f.key}
                        label={f.label}
                        checked={def.email!.attachments.includes(f.key)}
                        onChange={(on) => setDef({ ...def, email: { ...def.email!, attachments: on ? [...def.email!.attachments, f.key] : def.email!.attachments.filter((k) => k !== f.key) } })}
                      />
                    ))}
                  </div>
                )}
              </div>
              <FormField label="Subject" className="md:col-span-2">
                <Input value={def.email.subject} onChange={(e) => setDef({ ...def, email: { ...def.email!, subject: e.target.value } })} />
              </FormField>
              <FormField label="Body (HTML allowed)" className="md:col-span-2">
                <Textarea className="min-h-32" value={def.email.body} onChange={(e) => setDef({ ...def, email: { ...def.email!, body: e.target.value } })} />
              </FormField>
            </div>
          )}
        </fieldset>
        <fieldset className="space-y-3 rounded-md border border-line p-3">
          <label className="inline-flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={!!def.whatsapp} onChange={(e) => setDef({ ...def, whatsapp: e.target.checked ? { to: '', body: '' } : undefined })} /> WhatsApp
          </label>
          {def.whatsapp && (
            <div className="grid grid-cols-1 gap-3">
              <FormField label="To (phone numbers or tags)">
                <Input value={def.whatsapp.to} onChange={(e) => setDef({ ...def, whatsapp: { ...def.whatsapp!, to: e.target.value } })} />
              </FormField>
              <FormField label="Message">
                <Textarea value={def.whatsapp.body} onChange={(e) => setDef({ ...def, whatsapp: { ...def.whatsapp!, body: e.target.value } })} />
              </FormField>
            </div>
          )}
        </fieldset>
        <div className="rounded-md bg-surface-2 p-3 text-xs text-muted">
          <p className="mb-1 font-medium text-fg">Available tags</p>
          <p className="font-mono">
            {'{{record_number}} {{record_title}} {{workflow_name}} {{current_stage}} {{link}} '}
            {wf.fields.map((f) => `{{${f.key}}}`).join(' ')}
          </p>
        </div>
        {!check.success && <p className="text-sm text-danger">{check.error.issues[0]?.message}</p>}
      </div>
    </Modal>
  );
}
