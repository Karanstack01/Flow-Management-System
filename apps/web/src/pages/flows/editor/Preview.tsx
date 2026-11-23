/**
 * "What's in this step" previews: the form a stage shows (live, with sample-free inputs), the
 * document a document step generates, the paths of a Depends-on, a timer's due rule, a jump,
 * a message as it will be sent, and the JSON a webhook posts.
 */
import clsx from 'clsx';
import { ArrowRight, Download, FileText, Lock, Users } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  conditionCases,
  documentBodyHtml,
  documentFileName,
  ELSE_HANDLE,
  recordTitle,
  sampleRecord,
  type ConditionNodeData,
  type DocumentConfig,
  type FieldDef,
  type FieldValue,
  type JumpNodeData,
  type MessageNodeData,
  type StageDef,
  type TimerNodeData,
  type WebhookNodeData,
  type WorkflowDef,
} from '@fms/core';
import { FieldInput } from '../../../components/FieldInput';
import { StageIntro } from '../../../components/StageIntro';
import { Badge, Button, FormField, Modal } from '../../../components/ui';
import { downloadPost } from '../../../lib/api';
import type { FieldView, RecordData } from '../../../lib/types';
import { MessagePreview } from './MessageComposer';
import { conditionText, timerText, type FlowNode } from './nodes';

export const toFieldView = (f: FieldDef): FieldView => ({
  key: f.key,
  label: f.label,
  type: f.type,
  stageKey: f.stageKey,
  required: f.required,
  unique: f.unique,
  searchKey: f.searchKey,
  frozen: f.frozen,
  lineItem: f.lineItem,
  options: f.options,
  dependsOn: f.dependsOn,
  optionMap: f.optionMap,
  width: f.width,
  helpText: f.helpText,
  placeholder: f.placeholder,
  defaultValue: f.defaultValue,
  allowMultiple: f.allowMultiple,
  canEdit: true,
});

// ------------------------------------------------------------------ document
const PAGE = { portrait: { w: 794, h: 1123 }, landscape: { w: 1123, h: 794 } }; // A4 at 96 dpi

/** The document as it will be generated, filled with sample values, on an A4 page. */
export function DocumentPreview({ cfg, def, stageName, flowKey }: { cfg: DocumentConfig; def: WorkflowDef; stageName: string; flowKey?: string }) {
  const [busy, setBusy] = useState(false);
  const ctx = useMemo(() => {
    const data = sampleRecord(def.fields);
    return { fields: def.fields, data, extra: { record_number: 1024, record_title: recordTitle(def.fields, data, 1024), workflow_name: def.name, current_stage: stageName, link: 'https://app.example.com/r/1024' } };
  }, [def, stageName]);
  const html = documentBodyHtml(cfg, ctx);
  const name = documentFileName(cfg, ctx);
  const page = PAGE[cfg.orientation];
  const scale = cfg.orientation === 'landscape' ? 0.62 : 0.56;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:66px;font:15px/1.5 Arial,Helvetica,sans-serif;color:#1d1d1f}
    h1{font-size:29px;margin:.3em 0}h2{font-size:24px;margin:.3em 0}h3{font-size:20px;margin:.3em 0}h4{font-size:17px;margin:.3em 0}
    p{margin:0 0 .6em}a{color:#0066cc}table{border-collapse:collapse;width:100%;margin:.4em 0 .8em}
    td,th{border:1px solid #d2d2d7;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f2f2f5}
  </style></head><body>${html || '<p style="color:#888">The document body is empty.</p>'}</body></html>`;

  async function sample() {
    if (!flowKey) return;
    setBusy(true);
    try {
      await downloadPost(`/flows/${flowKey}/document-preview`, { document: cfg, fields: def.fields, stageName }, name);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <FileText className="size-4 text-indigo-500" />
        <span className="font-medium text-fg">{name}</span>
        <Badge>{cfg.format === 'pdf' ? 'PDF' : 'Word'}</Badge>
        <Badge>{cfg.orientation === 'landscape' ? 'Landscape' : 'Portrait'}</Badge>
        {flowKey && (
          <Button size="sm" className="ml-auto" icon={<Download className="size-4" />} loading={busy} onClick={() => void sample()}>
            Download sample
          </Button>
        )}
      </div>
      <div className="grid place-items-center overflow-auto rounded-2xl bg-surface-2 p-4">
        <div className="overflow-hidden rounded bg-white shadow-[0_8px_30px_-12px_rgb(0_0_0/0.35)]" style={{ width: page.w * scale, height: page.h * scale }}>
          <iframe title="Document preview" sandbox="" srcDoc={doc} style={{ width: page.w, height: page.h, transform: `scale(${scale})`, transformOrigin: '0 0', border: 0 }} />
        </div>
      </div>
      <p className="text-[11px] text-muted">Filled with sample values. The generated file uses the record’s real values; images are left out of PDFs.</p>
    </div>
  );
}

// ------------------------------------------------------------------ stage form
function StageFormPreview({ stage, def, isIntake }: { stage: StageDef; def: WorkflowDef; isIntake: boolean }) {
  const fields = def.fields.filter((f) => f.stageKey === stage.key && !f.hidden && f.key !== stage.document?.fieldKey);
  const [data, setData] = useState<RecordData>({});
  const facts = [
    isIntake ? 'Intake form — done when submitted' : stage.document ? (stage.document.requireReview ? 'Done after someone reviews the document' : 'Done as soon as the document is generated') : stage.completion.kind === 'conditions' ? 'Done automatically when its conditions are met' : 'The owner marks it done',
    stage.responsibleGroups.length ? `Owners: ${stage.responsibleGroups.join(', ')}` : 'No owners',
    stage.lockAfterComplete && 'Locked after completion',
    stage.singleUpdate === false && 'Single update off',
    stage.bulkUpdate && 'Bulk update on',
    isIntake && stage.publicForm && 'Public form',
  ].filter(Boolean) as string[];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {facts.map((f) => (
          <Badge key={f}>{f}</Badge>
        ))}
        {stage.stageAccessRestricted && (
          <Badge tone="warning">
            <Lock className="size-3" /> {stage.stageUsers?.length ?? 0} assigned user(s)
          </Badge>
        )}
      </div>
      <StageIntro description={stage.description} video={stage.video} compact />
      {fields.length === 0 ? (
        <p className="rounded-xl bg-surface-2 p-4 text-sm text-muted">This stage has no form fields.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 rounded-2xl border border-line p-4 md:grid-cols-2">
          {fields.map((f) => {
            const v = toFieldView(f);
            return (
              <FormField key={f.key} label={f.label} required={f.required} hint={f.helpText} className={f.type === 'textarea' ? 'md:col-span-2' : undefined}>
                <FieldInput field={v} value={data[f.key]} onChange={(x: FieldValue) => setData((d) => ({ ...d, [f.key]: x }))} zone="UTC" data={data} disabled={f.type === 'file' || f.type === 'computed' || f.type === 'user-email'} />
              </FormField>
            );
          })}
        </div>
      )}
      <p className="text-[11px] text-muted">A working copy of the form — try it out; nothing is saved.</p>
    </div>
  );
}

// ------------------------------------------------------------------ the modal
export function StepPreview({ node, def, flowKey, nodeName, targetOf, onClose }: { node: FlowNode; def: WorkflowDef; flowKey: string; nodeName: (id: string) => string; targetOf: (handle: string | null) => string | null; onClose: () => void }) {
  const stage = def.stages.find((s) => s.key === node.data.stageKey);
  const isIntake = def.stages[0]?.key === stage?.key;
  let title = 'Preview';
  let body: ReactNode = null;

  if ((node.type === 'stage' || node.type === 'document') && stage) {
    title = stage.name;
    body = stage.document ? (
      <div className="space-y-6">
        <DocumentPreview cfg={stage.document} def={def} stageName={stage.name} flowKey={flowKey} />
        <StageFormPreview stage={stage} def={def} isIntake={false} />
      </div>
    ) : (
      <StageFormPreview stage={stage} def={def} isIntake={isIntake} />
    );
  } else if (node.type === 'condition') {
    const d = node.data as ConditionNodeData;
    const { cases, otherwise } = conditionCases(d);
    title = d.label || 'Depends on';
    body = (
      <ol className="space-y-2">
        {[...cases.map((c, k) => ({ id: c.id, name: c.label || `Path ${k + 1}`, text: conditionText(c.when, def) })), ...(otherwise ? [{ id: ELSE_HANDLE, name: 'Otherwise', text: 'None of the paths above matched' }] : [])].map((p, k) => (
          <li key={p.id} className="rounded-xl border border-line p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-300">
              {k + 1}. {p.name}
            </p>
            <p className="mt-0.5 text-sm font-medium">{p.text}</p>
            <p className="mt-1 flex items-center gap-1 text-xs text-muted">
              <ArrowRight className="size-3.5" /> {targetOf(p.id) ?? 'Not connected'}
            </p>
          </li>
        ))}
        {!cases.length && <p className="text-sm text-muted">No paths yet.</p>}
      </ol>
    );
  } else if (node.type === 'timer') {
    title = 'Delay / Timer';
    body = (
      <div className="space-y-2 text-sm">
        <p>
          The next stage{targetOf(null) ? <> (<b>{targetOf(null)}</b>)</> : ''} is due <b>{timerText(node.data as TimerNodeData, def)}</b>.
        </p>
        <p className="text-xs text-muted">Only working hours on the flow’s calendar count: off-shift time, weekly offs and holidays are skipped.</p>
      </div>
    );
  } else if (node.type === 'jump') {
    const d = node.data as JumpNodeData;
    title = d.label || 'Stage Jump';
    body = (
      <div className="space-y-2 text-sm">
        <p>
          When the stage before it is done and <b>{conditionText(d.when, def)}</b>, the record goes to <b>{targetOf(null) ?? '— no target yet —'}</b>.
        </p>
        {(d.clearFields ?? []).length > 0 && <p className="text-muted">Clears: {(d.clearFields ?? []).map((k) => def.fields.find((f) => f.key === k)?.label ?? k).join(', ')}</p>}
      </div>
    );
  } else if (node.type === 'message') {
    const d = node.data as MessageNodeData;
    title = d.name || 'Message';
    body = <MessagePreview data={d} def={def} flowName={def.name} />;
  } else if (node.type === 'webhook') {
    const d = node.data as WebhookNodeData;
    const data = sampleRecord(def.fields);
    const picked = d.fields?.length ? Object.fromEntries(d.fields.map((k) => [k, data[k] ?? null])) : data;
    title = 'Webhook';
    body = (
      <div className="space-y-3 text-sm">
        <p>
          <Badge tone="info">POST</Badge> <code className="break-all">{d.url || 'no URL yet'}</code>
        </p>
        <p className="text-xs text-muted">Sent once per record after the stage is done{d.when?.conditions.length ? ` and when ${conditionText(d.when, def)}` : ''}. Signed with x-fms-signature when a secret is set.</p>
        <pre className="max-h-80 overflow-auto rounded-xl bg-surface-2 p-3 text-xs">{JSON.stringify({ event: 'record.matched', webhook: d.key ?? node.id, workflow: def.key, record: { id: 'rec_…', number: 1024, data: picked }, sentAt: new Date().toISOString() }, null, 2)}</pre>
      </div>
    );
  } else if (node.type === 'note') {
    title = 'Note';
    body = <p className="whitespace-pre-wrap text-sm">{(node.data.text as string) || 'Empty note'}</p>;
  } else {
    body = <p className="text-sm text-muted">{nodeName(node.id)}</p>;
  }

  return (
    <Modal open wide onClose={onClose} title={`Preview — ${title}`} footer={<Button onClick={onClose}>Close</Button>}>
      <div className={clsx('min-h-24')}>{body}</div>
      {stage?.stageAccessRestricted && (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-muted">
          <Users className="size-3.5" /> Only assigned users (and admins) see this stage.
        </p>
      )}
    </Modal>
  );
}
