/**
 * In-memory mock of the flow-management API (All Flows, Templates, Dashboard,
 * node editor) for running the UI without a backend. Uses the real @fms/core
 * compiler, so the editor behaves exactly as it does against the API.
 */
import {
  BUILT_IN_TEMPLATES,
  CONNECTION_PROVIDERS,
  CONNECTION_SPECS,
  maskSecret,
  validateConnection,
  type ConnectionProvider,
  compileCanvas,
  reconcileCanvas,
  workflowDefSchema,
  workflowSettingsSchema,
  type Canvas,
  type WorkflowDef,
  type WorkflowSettings,
} from '@fms/core';
import type { DashboardData, EditorData, FlowRow, TemplateSummary, WorkflowSummary, WorkflowView } from './types';

interface MockFlow {
  row: FlowRow;
  def: WorkflowDef;
  settings: WorkflowSettings;
  canvas: Canvas | null;
  calendarId: string;
}

const ADMIN = { id: 'usr-admin-01', name: 'Administrator', email: 'admin@example.com' };
const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function fromTemplate(templateKey: string, key: string, name: string, extra: Partial<FlowRow>): MockFlow {
  const t = BUILT_IN_TEMPLATES.find((x) => x.key === templateKey)!;
  const def = workflowDefSchema.parse({ ...t.definition, key, name });
  return {
    def,
    settings: workflowSettingsSchema.parse(t.settings ?? {}),
    canvas: null,
    calendarId: 'cal-1',
    row: {
      id: `wf-${key}`,
      key,
      name,
      description: def.description ?? null,
      label: null,
      status: 'active',
      isFavorite: false,
      version: 1,
      stageCount: def.stages.length,
      openRecords: 0,
      overdue: 0,
      createdBy: ADMIN,
      createdAt: days(20),
      updatedAt: days(2),
      deletedAt: null,
      ...extra,
    },
  };
}

const flows: MockFlow[] = [
  fromTemplate('order_to_delivery', 'orders', 'Order to Delivery', { label: 'Sales', isFavorite: true, openRecords: 3, overdue: 1, version: 4, updatedAt: days(0.2) }),
  fromTemplate('purchase_indent', 'purchase_indent', 'Purchase Indent to GRN', { label: 'Procurement', openRecords: 12, overdue: 2, version: 2, updatedAt: days(1) }),
  fromTemplate('complaint_resolution', 'complaints', 'Customer Complaints', { label: 'Support', openRecords: 7, overdue: 0, updatedAt: days(5) }),
  fromTemplate('lead_to_close', 'leads', 'Sales Lead to Close', { label: 'Sales', status: 'inactive', openRecords: 0, updatedAt: days(40) }),
  fromTemplate('employee_onboarding', 'onboarding', 'Employee Onboarding', { label: 'HR', status: 'draft', updatedAt: days(0.5) }),
];

const templates: (TemplateSummary & { def: WorkflowDef; settings: WorkflowSettings })[] = BUILT_IN_TEMPLATES.map((t) => {
  const def = workflowDefSchema.parse(t.definition);
  return {
    id: `tpl-${t.key}`,
    name: t.name,
    description: t.description,
    category: t.category,
    scope: 'global',
    builtIn: true,
    stages: def.stages.map((s) => ({ key: s.key, name: s.name, color: s.color })),
    fieldCount: def.fields.length,
    updatedAt: days(30),
    def,
    settings: workflowSettingsSchema.parse(t.settings ?? {}),
  };
});

const find = (key: string) => {
  const f = flows.find((x) => x.row.key === key);
  if (!f) throw new Error('Flow not found');
  return f;
};
const freeKey = (wanted: string) => {
  const base = wanted.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1') || 'flow';
  if (!flows.some((f) => f.row.key === base)) return base;
  for (let i = 2; ; i++) if (!flows.some((f) => f.row.key === `${base}_${i}`)) return `${base}_${i}`;
};
const touch = (f: MockFlow) => {
  f.row.updatedAt = new Date().toISOString();
  f.row.stageCount = f.def.stages.length;
};

function newDraft(name: string, def: WorkflowDef, settings: WorkflowSettings, label?: string | null, description?: string | null): MockFlow {
  const key = freeKey(name);
  const f: MockFlow = {
    def: { ...def, key, name, description: description ?? def.description },
    settings,
    canvas: null,
    calendarId: 'cal-1',
    row: { id: `wf-${key}`, key, name, description: description ?? def.description ?? null, label: label ?? null, status: 'draft', isFavorite: false, version: 1, stageCount: def.stages.length, openRecords: 0, overdue: 0, createdBy: ADMIN, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null },
  };
  flows.push(f);
  return f;
}

const blank = (): WorkflowDef =>
  workflowDefSchema.parse({
    key: 'blank',
    name: 'Blank',
    stages: [
      { key: 'intake', name: 'Form Submitted', color: '#16a34a', completion: { kind: 'on_create' } },
      { key: 'review', name: 'Review', color: '#2563eb', planned: { mode: 'tat', base: { kind: 'previous_stage' }, tat: { kind: 'fixed', hours: 8 } }, completion: { kind: 'manual' } },
    ],
    fields: [{ key: 'title', label: 'Title', type: 'text', stageKey: 'intake', required: true, searchKey: true, frozen: true }],
  });

export function viewOf(key: string): WorkflowView | undefined {
  const f = flows.find((x) => x.row.key === key);
  if (!f) return undefined;
  return {
    id: f.row.id,
    key: f.row.key,
    name: f.row.name,
    version: f.row.version,
    isActive: f.row.status === 'active',
    description: f.def.description,
    timezone: 'Asia/Kolkata',
    canCreate: true,
    canArchive: true,
    canExport: true,
    stages: f.def.stages.map((s, i) => ({
      key: s.key,
      name: s.name,
      color: s.color,
      responsibleGroups: s.responsibleGroups,
      plannedMode: s.planned.mode,
      completion: s.completion.kind,
      isMine: true,
      canEdit: true,
      description: s.description,
      video: s.video,
      headerColor: s.headerColor,
      lockAfterComplete: !!s.lockAfterComplete,
      singleUpdate: s.singleUpdate !== false,
      bulkUpdate: !!s.bulkUpdate,
      document: s.document ? { fieldKey: s.document.fieldKey, format: s.document.format, requireReview: s.document.requireReview } : null,
      ...(i === 0 ? { thankYou: s.showThankYou ? s.thankYouText || null : null, publicFormId: s.publicForm ? (s.publicFormId ?? null) : null } : {}),
    })),
    fields: f.def.fields.filter((x) => !x.hidden).map((x) => ({ key: x.key, label: x.label, type: x.type, stageKey: x.stageKey, required: x.required, unique: x.unique, searchKey: x.searchKey, frozen: x.frozen, lineItem: x.lineItem, options: x.options, dependsOn: x.dependsOn, optionMap: x.optionMap, width: x.width, helpText: x.helpText, placeholder: x.placeholder, defaultValue: x.defaultValue, allowMultiple: x.allowMultiple, canEdit: true })),
  };
}

/** GET/PUT /workflows/:key/definition (form editor), using the same flows as the canvas. */
export function definitionOf(key: string) {
  const f = flows.find((x) => x.row.key === key);
  if (!f) return undefined;
  return { id: f.row.id, version: f.row.version, calendarId: f.calendarId, isActive: f.row.status !== 'inactive', definition: f.def, settings: f.settings };
}

export function saveDefinition(key: string, body: { definition?: unknown; settings?: unknown; isActive?: boolean }) {
  const f = find(key);
  f.def = workflowDefSchema.parse(body.definition);
  f.settings = workflowSettingsSchema.parse(body.settings ?? f.settings);
  if (typeof body.isActive === 'boolean' && f.row.status !== 'draft') f.row.status = body.isActive ? 'active' : 'inactive';
  f.row.name = f.def.name;
  f.row.version += 1;
  touch(f);
  return { version: f.row.version };
}

export function workflowSummaries(): WorkflowSummary[] {
  return flows.filter((f) => !f.row.deletedAt).map((f) => ({ id: f.row.id, key: f.row.key, name: f.row.name, description: f.row.description, isActive: f.row.status !== 'inactive', isDraft: f.row.status === 'draft', label: f.row.label }));
}

// ------------------------------------------------------------------ Settings › Connections (mock)
interface MockConnection {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  isActive: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  updatedAt: string;
}
const mockConnections = new Map<ConnectionProvider, MockConnection>();

function connectionView(provider: ConnectionProvider) {
  const spec = CONNECTION_SPECS[provider];
  const row = mockConnections.get(provider);
  return {
    provider,
    kind: spec.kind,
    label: spec.label,
    saved: !!row,
    complete: row ? validateConnection(provider, row.config, row.secrets).ok : false,
    isActive: row?.isActive ?? false,
    config: row?.config ?? {},
    secrets: Object.fromEntries(spec.secretFields.map((f) => [f, maskSecret(row?.secrets[f])])),
    lastTestAt: row?.lastTestAt ?? null,
    lastTestOk: row?.lastTestOk ?? null,
    lastTestMessage: row?.lastTestMessage ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

function handleConnections(path: string, method: string, body: Record<string, unknown>): unknown {
  if (path === '/admin/connections') return { items: CONNECTION_PROVIDERS.map(connectionView), cloudinaryFiles: 0 };
  const m = /^\/admin\/connections\/(cloudinary|google|microsoft|redlava)(?:\/(activate|deactivate|test))?$/.exec(path);
  if (!m) return undefined;
  const provider = m[1] as ConnectionProvider;
  const row = mockConnections.get(provider);
  if (!m[2] && method === 'PUT') {
    const secrets = { ...(row?.secrets ?? {}) };
    for (const [k, v] of Object.entries((body.secrets ?? {}) as Record<string, string>)) if (v.trim()) secrets[k] = v.trim();
    const v = validateConnection(provider, body.config, secrets);
    if (!v.ok) throw new Error(v.issues.map((i) => `${i.path.replace(/^(config|secrets)\./, '')}: ${i.message}`).join('; '));
    mockConnections.set(provider, { config: v.value.config as Record<string, unknown>, secrets: v.value.secrets as Record<string, string>, isActive: row?.isActive ?? false, lastTestAt: null, lastTestOk: null, lastTestMessage: null, updatedAt: new Date().toISOString() });
    return connectionView(provider);
  }
  if (!m[2] && method === 'DELETE') {
    mockConnections.delete(provider);
    return { ok: true };
  }
  if (m[2] === 'activate') {
    if (!row) throw new Error('Save complete settings before switching this connection on');
    for (const [p, r] of mockConnections) if (CONNECTION_SPECS[p].kind === CONNECTION_SPECS[provider].kind) r.isActive = p === provider;
    return { ok: true };
  }
  if (m[2] === 'deactivate') {
    if (row) row.isActive = false;
    return { ok: true };
  }
  if (m[2] === 'test') {
    if (!row) throw new Error('Save the settings first');
    const kind = CONNECTION_SPECS[provider].kind;
    if (kind !== 'storage' && !body.to) throw new Error(kind === 'email' ? 'Enter an email address to send the test to' : 'Enter a WhatsApp number to send the test to');
    const message = `(mock — nothing was sent) ${kind === 'storage' ? 'Upload, download and delete would be tested against Cloudinary.' : `A test would be sent to ${String(body.to)}.`}`;
    Object.assign(row, { lastTestAt: new Date().toISOString(), lastTestOk: true, lastTestMessage: message });
    return { ok: true, message };
  }
  return undefined;
}

/** Returns undefined when the path is not a flow-management path. */
export function handleFlowsRequest(path: string, method: string, body: Record<string, unknown>, query: Record<string, unknown>): unknown {
  if (path.startsWith('/admin/connections')) return handleConnections(path, method, body);
  // Public intake form (offline demo): any flow whose intake form is switched to public.
  const pub = /^\/public\/forms\/([\w-]+)$/.exec(path);
  if (pub) {
    const f = flows.find((x) => x.def.stages[0]?.publicForm && x.def.stages[0].publicFormId === pub[1] && !x.row.deletedAt);
    if (!f) throw new Error('Form not found');
    const intake = f.def.stages[0]!;
    if (method === 'POST') return { numbers: [1000 + Math.floor(Math.random() * 900)], thankYou: intake.showThankYou ? intake.thankYouText || null : null };
    const view = viewOf(f.row.key)!;
    return {
      name: f.row.name,
      description: f.def.description ?? null,
      timezone: view.timezone,
      stage: { name: intake.name, description: intake.description ?? null, video: intake.video ?? null, thankYou: intake.showThankYou ? intake.thankYouText || null : null },
      fields: view.fields.filter((x) => x.stageKey === intake.key && x.type !== 'file' && x.type !== 'computed' && x.type !== 'user-email'),
    };
  }
  if (/^\/flows\/[^/]+\/document-preview$/.test(path)) throw new Error('Sample downloads need the API server; the live preview above shows the same document.');
  if (path === '/flows' && method === 'GET') {
    const tab = String(query.tab ?? 'primary');
    const q = String(query.q ?? '').toLowerCase();
    const since = String(query.since ?? 'any');
    const sinceMs = since === 'any' ? 0 : Date.now() - Number(since.slice(0, -1)) * 86_400_000;
    const inTab = (f: MockFlow) => (tab === 'trash' ? !!f.row.deletedAt : !f.row.deletedAt && (tab === 'drafts' ? f.row.status === 'draft' : f.row.status !== 'draft'));
    const items = flows
      .filter(inTab)
      .filter((f) => !q || `${f.row.name} ${f.row.description ?? ''} ${f.row.key}`.toLowerCase().includes(q))
      .filter((f) => !query.label || f.row.label === query.label)
      .filter((f) => !query.status || query.status === 'all' || (query.status === 'active' ? f.row.status === 'active' : f.row.status === 'inactive'))
      .filter((f) => new Date(f.row.updatedAt).getTime() >= sinceMs)
      .map((f) => ({ ...f.row, status: f.row.deletedAt ? ('trashed' as const) : f.row.status }))
      .sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite) || b.updatedAt.localeCompare(a.updatedAt));
    return {
      items,
      counts: { primary: flows.filter((f) => !f.row.deletedAt && f.row.status !== 'draft').length, drafts: flows.filter((f) => !f.row.deletedAt && f.row.status === 'draft').length, trash: flows.filter((f) => f.row.deletedAt).length },
      labels: [...new Set(flows.filter((f) => !f.row.deletedAt && f.row.label).map((f) => f.row.label!))].sort(),
      canManage: true,
    };
  }

  if (path === '/flows' && method === 'POST') {
    const t = templates.find((x) => x.id === body.templateId);
    const f = newDraft(String(body.name), t?.def ?? blank(), t?.settings ?? workflowSettingsSchema.parse({}), (body.label as string) || null, (body.description as string) || null);
    return { id: f.row.id, key: f.row.key };
  }

  if (path === '/flows/bulk' && method === 'POST') {
    const keys = body.keys as string[];
    for (const f of flows) if (keys.includes(f.row.key)) f.row.deletedAt = body.action === 'trash' ? new Date().toISOString() : null;
    return { updated: keys.length };
  }

  const m = /^\/flows\/([^/]+)(?:\/(favorite|duplicate|editor|save-as-template))?$/.exec(path);
  if (m) {
    const f = find(m[1]!);
    const sub = m[2];
    if (!sub && method === 'PATCH') {
      if (typeof body.name === 'string') (f.row.name = body.name), (f.def = { ...f.def, name: body.name });
      if (body.description !== undefined) f.row.description = (body.description as string | null) ?? null;
      if (body.label !== undefined) f.row.label = (body.label as string | null) ?? null;
      if (typeof body.isActive === 'boolean') f.row.status = body.isActive ? 'active' : 'inactive';
      touch(f);
      return { ok: true };
    }
    if (!sub && method === 'DELETE') {
      if (body.confirm !== f.row.key) throw new Error(`Type the flow key “${f.row.key}” to confirm`);
      flows.splice(flows.indexOf(f), 1);
      return { ok: true, recordsDeleted: f.row.openRecords };
    }
    if (sub === 'favorite') {
      f.row.isFavorite = body.starred === true;
      return { ok: true };
    }
    if (sub === 'duplicate') {
      const copy = newDraft(`${f.row.name} (copy)`, f.def, f.settings, f.row.label, f.row.description);
      copy.canvas = f.canvas;
      return { id: copy.row.id, key: copy.row.key };
    }
    if (sub === 'save-as-template') {
      const id = `tpl-${Date.now()}`;
      templates.push({ id, name: String(body.name), description: (body.description as string) ?? null, category: String(body.category ?? 'General'), scope: body.scope === 'global' ? 'global' : 'organization', builtIn: false, stages: f.def.stages.map((s) => ({ key: s.key, name: s.name, color: s.color })), fieldCount: f.def.fields.length, updatedAt: new Date().toISOString(), def: f.def, settings: f.settings });
      return { id };
    }
    if (sub === 'editor' && method === 'GET') {
      const data: EditorData = {
        flow: { id: f.row.id, key: f.row.key, name: f.row.name, description: f.row.description, label: f.row.label, isActive: f.row.status !== 'inactive', isDraft: f.row.status === 'draft', version: f.row.version, calendarId: f.calendarId },
        definition: f.def,
        settings: f.settings,
        canvas: reconcileCanvas(f.canvas, f.def, f.settings),
        otherRules: 0,
        groups: ['ACCOUNTS', 'ADMINS', 'HOD', 'HR', 'IT', 'MANAGEMENT', 'MANAGER', 'PRODUCTION', 'PURCHASE', 'SALES', 'SERVICE', 'STORE', 'SUPPORT'],
        calendars: [{ id: 'cal-1', name: 'Head Office' }],
        users: [
          { name: 'Asha Admin', email: 'admin@example.com' },
          { name: 'Ravi Sales', email: 'ravi@example.com' },
          { name: 'Priya Production', email: 'priya@example.com' },
          { name: 'Kabir Support', email: 'kabir@example.com' },
        ],
      };
      return data;
    }
    if (sub === 'editor' && method === 'PUT') {
      const out = compileCanvas(body.canvas as Canvas, body.definition as WorkflowDef, body.settings as WorkflowSettings);
      if (!out.definition || !out.settings) throw new Error(out.errors[0]?.message ?? 'The flow has problems');
      f.def = out.definition;
      f.settings = out.settings;
      f.canvas = body.canvas as Canvas;
      f.row.name = out.definition.name;
      f.row.version += 1;
      if (body.publish) f.row.status = 'active';
      touch(f);
      return { version: f.row.version, warnings: out.warnings, isDraft: f.row.status === 'draft' };
    }
  }

  if (path === '/templates') return { items: templates.map(({ def: _d, settings: _s, ...t }) => t), canPublishGlobal: true };
  const tm = /^\/templates\/([^/]+)$/.exec(path);
  if (tm) {
    const t = templates.find((x) => x.id === tm[1]);
    if (!t) throw new Error('Template not found');
    if (method === 'DELETE') {
      if (t.builtIn) throw new Error('Built-in templates can not be deleted');
      templates.splice(templates.indexOf(t), 1);
      return { ok: true };
    }
    return { id: t.id, name: t.name, description: t.description, category: t.category, definition: t.def, settings: t.settings };
  }

  if (path === '/dashboard') {
    const live = flows.filter((f) => !f.row.deletedAt);
    const list = live.map((f) => {
      const per = f.def.stages.map((s, i) => {
        const active = i === 0 ? 0 : Math.max(0, Math.round((f.row.openRecords * (f.def.stages.length - i)) / ((f.def.stages.length * (f.def.stages.length - 1)) / 2 || 1)));
        return { key: s.key, name: s.name, color: s.color, active, overdue: 0 };
      });
      const lastWithRecords = [...per].reverse().find((s) => s.active > 0);
      if (lastWithRecords) lastWithRecords.overdue = f.row.overdue;
      return {
        key: f.row.key,
        name: f.row.name,
        label: f.row.label,
        status: f.row.status === 'trashed' ? 'inactive' : f.row.status,
        open: f.row.openRecords,
        created7d: Math.round(f.row.openRecords / 2),
        completed7d: Math.round(f.row.openRecords / 3),
        overdue: f.row.overdue,
        stages: per,
        updatedAt: f.row.updatedAt,
      } as DashboardData['flows'][number];
    });
    const active = list.filter((f) => f.status === 'active');
    // Deterministic sample series (mock only).
    const trend = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(Date.now() - (13 - i) * 86_400_000);
      const weekday = d.getDay();
      const base = weekday === 0 ? 1 : 4 + ((i * 7) % 5);
      return { date: d.toISOString().slice(0, 10), created: base + (i % 3), completed: Math.max(0, base - 1 + ((i + 1) % 4)) };
    });
    const teamMap = new Map<string, { active: number; overdue: number }>();
    for (const f of list) {
      const flow = flows.find((x) => x.row.key === f.key)!;
      for (const s of f.stages) {
        const owners = flow.def.stages.find((x) => x.key === s.key)?.responsibleGroups ?? [];
        for (const g of owners.length ? owners : ['Unassigned']) {
          const t = teamMap.get(g) ?? { active: 0, overdue: 0 };
          t.active += s.active;
          t.overdue += s.overdue;
          teamMap.set(g, t);
        }
      }
    }
    const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    return {
      timezone: 'Asia/Kolkata',
      trend,
      onTime: { onTime: 46, late: 9, avgLateHours: 5.4 },
      teams: [...teamMap].map(([group, t]) => ({ group, ...t })).filter((t) => t.active > 0).sort((a, b) => b.active - a.active).slice(0, 8),
      activity: [
        { id: 'a1', action: 'record.stage_completed', actorEmail: 'priya@acme.example', createdAt: minsAgo(12), recordId: 'rec-002', recordNumber: 1002, flowKey: 'orders', flowName: 'Order to Delivery' },
        { id: 'a2', action: 'record.created', actorEmail: 'admin@example.com', createdAt: minsAgo(48), recordId: 'rec-003', recordNumber: 1003, flowKey: 'orders', flowName: 'Order to Delivery' },
        { id: 'a3', action: 'record.updated', actorEmail: 'rahul@acme.example', createdAt: minsAgo(130), recordId: 'rec-001', recordNumber: 1001, flowKey: 'orders', flowName: 'Order to Delivery' },
        { id: 'a4', action: 'record.planned_set', actorEmail: 'admin@example.com', createdAt: minsAgo(300), recordId: 'rec-001', recordNumber: 1001, flowKey: 'orders', flowName: 'Order to Delivery' },
      ],
      totals: {
        flows: active.length,
        drafts: list.filter((f) => f.status === 'draft').length,
        openRecords: list.reduce((s, f) => s + f.open, 0),
        overdue: list.reduce((s, f) => s + f.overdue, 0),
        created7d: list.reduce((s, f) => s + f.created7d, 0),
        completed7d: list.reduce((s, f) => s + f.completed7d, 0),
      },
      flows: list,
    } satisfies DashboardData;
  }

  return undefined;
}
