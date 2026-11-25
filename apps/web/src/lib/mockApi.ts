import { staleDependents } from '@fms/core';
import type { Me, WorkflowSummary, WorkflowView, RecordList, RecordDto, StageSummaryRow, PendingTask, MyTask, PlatformOrg, PlatformUser, PlatformOverview, HistoryEntry, DeliveryLog } from './types';

import { definitionOf, handleFlowsRequest, saveDefinition, viewOf, workflowSummaries } from './mockFlows';

let isMockAuthenticated = false;

export function setMockAuth(auth: boolean) {
  isMockAuthenticated = auth;
}

export function isMockAuth() {
  return isMockAuthenticated;
}

const HOME_ORG = 'org-default-01';

// ---------------------------------------------------------------- platform (super admin) mock state
const mockOrgs: PlatformOrg[] = [
  { id: HOME_ORG, name: 'Default Organization', slug: 'default', isActive: true, status: 'ACTIVE', suspendedReason: null, maxUsers: null, maxWorkflows: null, licenseExpiresAt: null, createdAt: '2026-11-01T04:30:00.000Z', activeUsers: 6, workflows: 1, records: 24 },
  { id: 'org-acme-02', name: 'Acme Industries', slug: 'acme-industries', isActive: true, status: 'ACTIVE', suspendedReason: null, maxUsers: 25, maxWorkflows: 3, licenseExpiresAt: '2027-03-31T18:29:59.000Z', createdAt: '2026-11-05T04:30:00.000Z', activeUsers: 18, workflows: 2, records: 412 },
  { id: 'org-zen-03', name: 'Zenith Traders', slug: 'zenith-traders', isActive: false, status: 'SUSPENDED', suspendedReason: 'Invoice overdue', maxUsers: 10, maxWorkflows: 1, licenseExpiresAt: '2026-12-31T18:29:59.000Z', createdAt: '2026-11-08T04:30:00.000Z', activeUsers: 7, workflows: 1, records: 96 },
];

const mockPlatformUsers: PlatformUser[] = [
  { id: 'usr-admin-01', name: 'Administrator', email: 'admin@example.com', isActive: true, isSuperAdmin: true, org: { id: HOME_ORG, name: 'Default Organization' }, lastLoginAt: new Date().toISOString(), locked: false },
  { id: 'usr-acme-01', name: 'Priya Sharma', email: 'priya@acme.example', isActive: true, isSuperAdmin: false, org: { id: 'org-acme-02', name: 'Acme Industries' }, lastLoginAt: new Date(Date.now() - 3600000 * 5).toISOString(), locked: false },
  { id: 'usr-acme-02', name: 'Rahul Verma', email: 'rahul@acme.example', isActive: true, isSuperAdmin: false, org: { id: 'org-acme-02', name: 'Acme Industries' }, lastLoginAt: null, locked: true },
  { id: 'usr-zen-01', name: 'Meera Iyer', email: 'meera@zenith.example', isActive: true, isSuperAdmin: false, org: { id: 'org-zen-03', name: 'Zenith Traders' }, lastLoginAt: new Date(Date.now() - 86400000 * 9).toISOString(), locked: false },
];

const mockPlatformAudit: { id: string; actorEmail: string | null; action: string; entityType: string; entityId: string; orgName: string; createdAt: string }[] = [
  { id: 'pa-2', actorEmail: 'admin@example.com', action: 'platform.org_suspended', entityType: 'Organization', entityId: 'org-zen-03', orgName: 'Zenith Traders', createdAt: new Date(Date.now() - 86400000).toISOString() },
  { id: 'pa-1', actorEmail: 'admin@example.com', action: 'platform.org_created', entityType: 'Organization', entityId: 'org-acme-02', orgName: 'Acme Industries', createdAt: new Date(Date.now() - 86400000 * 13).toISOString() },
];

let activeOrgId: string | null = null;

function orgName(id: string) {
  return mockOrgs.find((o) => o.id === id)?.name ?? 'Unknown';
}

function platformAudit(action: string, entityType: string, entityId: string, orgId: string) {
  mockPlatformAudit.unshift({ id: `pa-${Date.now()}`, actorEmail: 'admin@example.com', action, entityType, entityId, orgName: orgName(orgId), createdAt: new Date().toISOString() });
}

function currentMe(): Me {
  const orgId = activeOrgId ?? HOME_ORG;
  const org = mockOrgs.find((o) => o.id === orgId)!;
  const home = orgId === HOME_ORG;
  return {
    ...mockMe,
    orgId,
    org: { id: org.id, name: org.name, slug: org.slug, status: org.status },
    // Group memberships only apply in the home organization.
    groups: home ? mockMe.groups : [],
  };
}

const mockMe: Me = {
  id: 'usr-admin-01',
  orgId: HOME_ORG,
  homeOrgId: HOME_ORG,
  org: { id: HOME_ORG, name: 'Default Organization', slug: 'default', status: 'ACTIVE' },
  email: 'admin@example.com',
  name: 'Administrator',
  groups: ['ADMINS', 'SALES', 'MANAGER', 'PRODUCTION', 'STORE', 'ACCOUNTS'],
  capabilities: ['ADMIN', 'CREATE', 'DELETE', 'RUN_JOBS', 'EXPORT', 'MANAGE_RULES'],
  isSuperAdmin: true,
};

const mockWorkflowSummary: WorkflowSummary[] = [
  {
    id: 'wf-orders-01',
    key: 'orders',
    name: 'Order to Delivery',
    description: 'Sample flow: order intake → approval → production → dispatch → payment follow-up',
    isActive: true,
  },
];

const mockWorkflowView: WorkflowView = {
  id: 'wf-orders-01',
  key: 'orders',
  name: 'Order to Delivery',
  version: 1,
  isActive: true,
  description: 'Sample flow: order intake → approval → production → dispatch → payment follow-up',
  timezone: 'Asia/Kolkata',
  canCreate: true,
  canArchive: true,
  canExport: true,
  stages: [
    // Offline demo of the access states the record page shows (a real admin can act on every stage).
    { key: 'intake', name: 'Order Received', color: '#2563eb', responsibleGroups: ['SALES'], plannedMode: 'none', completion: 'on_create', isMine: true, canAct: true, canView: true, canEdit: true, description: 'Sales logs the order with the customer details.' },
    { key: 'approval', name: 'Approval', color: '#7c3aed', responsibleGroups: ['MANAGER'], plannedMode: 'tat', completion: 'manual', isMine: true, canAct: true, canView: true, canEdit: true, description: 'The manager approves or rejects the order within 4 working hours.' },
    { key: 'production', name: 'Production', color: '#ea580c', responsibleGroups: ['PRODUCTION'], plannedMode: 'tat', completion: 'manual', isMine: true, canAct: true, canView: true, canEdit: true, assignees: [{ email: 'priya@example.com', role: 'Editor' }, { email: 'admin@example.com', role: 'Editor' }, { email: 'ravi@example.com', role: 'Viewer' }] },
    { key: 'dispatch', name: 'Dispatch', color: '#0891b2', responsibleGroups: ['STORE'], plannedMode: 'tat', completion: 'manual', isMine: false, canAct: false, canView: true, canEdit: false, conditional: false },
    { key: 'payment', name: 'Payment Follow-up', color: '#16a34a', responsibleGroups: ['ACCOUNTS'], plannedMode: 'tat', completion: 'manual', isMine: false, canAct: false, canView: false, canEdit: false, conditional: true },
  ],
  fields: [
    { key: 'customer', label: 'Customer Name', type: 'text', stageKey: 'intake', required: true, unique: false, searchKey: true, frozen: true, lineItem: false, canEdit: true },
    { key: 'customer_email', label: 'Customer Email', type: 'email', stageKey: 'intake', required: false, unique: false, searchKey: false, frozen: false, lineItem: false, canEdit: true },
    { key: 'customer_phone', label: 'Customer Phone', type: 'phone', stageKey: 'intake', required: false, unique: false, searchKey: false, frozen: false, lineItem: false, canEdit: true },
    { key: 'city', label: 'City', type: 'select', stageKey: 'intake', required: true, unique: false, searchKey: false, frozen: false, lineItem: false, options: ['Mumbai', 'Delhi', 'Bengaluru', 'Pune', 'Hyderabad'], canEdit: true },
    {
      key: 'area',
      label: 'Area',
      type: 'dependent-select',
      stageKey: 'intake',
      required: false,
      unique: false,
      searchKey: false,
      frozen: false,
      lineItem: false,
      dependsOn: 'city',
      dependsOnLabel: 'City',
      optionMap: { Mumbai: ['Andheri', 'Bandra', 'Powai'], Delhi: ['Saket', 'Dwarka'], Bengaluru: ['Whitefield', 'Koramangala'], Pune: ['Hinjewadi', 'Kothrud'] },
      canEdit: true,
    },
    { key: 'priority', label: 'Priority', type: 'select', stageKey: 'intake', required: true, unique: false, searchKey: false, frozen: false, lineItem: false, options: ['Urgent', 'Normal'], canEdit: true },
    { key: 'due_date', label: 'Payment Due Date', type: 'date', stageKey: 'intake', required: false, unique: false, searchKey: false, frozen: false, lineItem: false, canEdit: true },
    { key: 'approval_status', label: 'Approval Status', type: 'select', stageKey: 'approval', required: false, unique: false, searchKey: false, frozen: false, lineItem: false, options: ['Approved', 'Rejected', 'Pending Review'], canEdit: true },
    { key: 'approval_remarks', label: 'Approval Remarks', type: 'textarea', stageKey: 'approval', required: false, unique: false, searchKey: false, frozen: false, lineItem: false, canEdit: true },
    { key: 'batch_no', label: 'Batch No.', type: 'text', stageKey: 'production', required: false, unique: false, searchKey: false, frozen: false, lineItem: false, canEdit: true },
    { key: 'dispatch_no', label: 'Dispatch / LR No.', type: 'text', stageKey: 'dispatch', required: false, unique: true, searchKey: false, frozen: false, lineItem: false, canEdit: false },
  ],
};

const sampleRecords: RecordDto[] = [
  {
    id: 'rec-001',
    number: 1001,
    title: 'Acme Corp — Hardware Order',
    submissionId: 'SUB-2026-001',
    currentStageKey: 'production',
    completedAt: null,
    archivedAt: null,
    createdAt: new Date(Date.now() - 3600000 * 24).toISOString(),
    updatedAt: new Date(Date.now() - 3600000 * 4).toISOString(),
    version: 3,
    data: {
      customer: 'Acme Corporation',
      customer_email: 'procurement@acme.com',
      customer_phone: '+91 98765 43210',
      city: 'Mumbai',
      priority: 'Urgent',
      due_date: '2026-11-25',
      approval_status: 'Approved',
      approval_remarks: 'Approved by Sales VP',
      batch_no: 'BATCH-2026-A1',
      dispatch_no: '',
      payment_received: false,
    },
    stages: [
      { stageKey: 'intake', status: 'done', plannedAt: null, actualAt: new Date(Date.now() - 3600000 * 24).toISOString(), overdue: false },
      { stageKey: 'approval', status: 'done', plannedAt: new Date(Date.now() - 3600000 * 20).toISOString(), actualAt: new Date(Date.now() - 3600000 * 22).toISOString(), overdue: false },
      { stageKey: 'production', status: 'active', plannedAt: new Date(Date.now() + 3600000 * 12).toISOString(), actualAt: null, overdue: false },
      { stageKey: 'dispatch', status: 'waiting', plannedAt: null, actualAt: null, overdue: false },
      { stageKey: 'payment', status: 'waiting', plannedAt: null, actualAt: null, overdue: false },
    ],
  },
  {
    id: 'rec-002',
    number: 1002,
    title: 'TechSol Pvt Ltd — Cloud Devices',
    submissionId: 'SUB-2026-002',
    currentStageKey: 'dispatch',
    completedAt: null,
    archivedAt: null,
    createdAt: new Date(Date.now() - 3600000 * 48).toISOString(),
    updatedAt: new Date(Date.now() - 3600000 * 8).toISOString(),
    version: 4,
    data: {
      customer: 'TechSol Pvt Ltd',
      customer_email: 'contact@techsol.in',
      customer_phone: '+91 98220 12345',
      city: 'Bengaluru',
      priority: 'Normal',
      due_date: '2026-11-28',
      approval_status: 'Approved',
      approval_remarks: 'Standard pricing applied',
      batch_no: 'BATCH-2026-B4',
      dispatch_no: 'DTDC-884920',
      payment_received: false,
    },
    stages: [
      { stageKey: 'intake', status: 'done', plannedAt: null, actualAt: new Date(Date.now() - 3600000 * 48).toISOString(), overdue: false },
      { stageKey: 'approval', status: 'done', plannedAt: new Date(Date.now() - 3600000 * 40).toISOString(), actualAt: new Date(Date.now() - 3600000 * 42).toISOString(), overdue: false },
      { stageKey: 'production', status: 'done', plannedAt: new Date(Date.now() - 3600000 * 16).toISOString(), actualAt: new Date(Date.now() - 3600000 * 18).toISOString(), overdue: false },
      { stageKey: 'dispatch', status: 'active', plannedAt: new Date(Date.now() - 3600000 * 2).toISOString(), actualAt: null, overdue: true },
      { stageKey: 'payment', status: 'waiting', plannedAt: null, actualAt: null, overdue: false },
    ],
  },
  {
    id: 'rec-003',
    number: 1003,
    title: 'Global Retailers — Store Supplies',
    submissionId: 'SUB-2026-003',
    currentStageKey: 'approval',
    completedAt: null,
    archivedAt: null,
    createdAt: new Date(Date.now() - 3600000 * 6).toISOString(),
    updatedAt: new Date(Date.now() - 3600000 * 6).toISOString(),
    version: 1,
    data: {
      customer: 'Global Retailers',
      customer_email: 'orders@globalretail.com',
      customer_phone: '+91 91234 56789',
      city: 'Delhi',
      priority: 'Urgent',
      due_date: '2026-11-22',
      approval_status: 'Pending Review',
      approval_remarks: '',
      batch_no: '',
      dispatch_no: '',
      payment_received: false,
    },
    stages: [
      { stageKey: 'intake', status: 'done', plannedAt: null, actualAt: new Date(Date.now() - 3600000 * 6).toISOString(), overdue: false },
      { stageKey: 'approval', status: 'active', plannedAt: new Date(Date.now() + 3600000 * 2).toISOString(), actualAt: null, overdue: false },
      { stageKey: 'production', status: 'waiting', plannedAt: null, actualAt: null, overdue: false },
      { stageKey: 'dispatch', status: 'waiting', plannedAt: null, actualAt: null, overdue: false },
      { stageKey: 'payment', status: 'waiting', plannedAt: null, actualAt: null, overdue: false },
    ],
  },
];

const mockCalendars = [
  {
    id: 'cal-1',
    name: 'Head Office (Standard IST)',
    timezone: 'Asia/Kolkata',
    shiftStart: '09:30',
    shiftEnd: '18:30',
    weeklyOff: [7],
    holidays: [
      { date: '2026-01-26', name: 'Republic Day' },
      { date: '2026-08-15', name: 'Independence Day' },
      { date: '2026-10-02', name: 'Gandhi Jayanti' },
      { date: '2026-12-25', name: 'Christmas' },
    ],
  },
  {
    id: 'cal-2',
    name: '24/7 Operations',
    timezone: 'Asia/Kolkata',
    shiftStart: '00:00',
    shiftEnd: '23:59',
    weeklyOff: [],
    holidays: [],
  },
];

const mockOptionSets = [
  { id: 'opt-cities', key: 'cities', name: 'Cities', options: ['Mumbai', 'Delhi', 'Bengaluru', 'Pune', 'Hyderabad', 'Chennai', 'Kolkata'] },
  { id: 'opt-priorities', key: 'priorities', name: 'Priority Levels', options: ['Urgent', 'High', 'Normal', 'Low'] },
  { id: 'opt-departments', key: 'departments', name: 'Departments', options: ['Sales', 'Engineering', 'Operations', 'Accounts', 'HR'] },
];

const mockRules: Record<string, { id: string; isActive: boolean; definition: any }[]> = {
  orders: [
    {
      id: 'rule-01',
      isActive: true,
      definition: {
        name: 'Urgent Order Production Alert',
        trigger: { type: 'condition', conditions: { mode: 'all', conditions: [{ fieldKey: 'priority', op: 'eq', value: 'Urgent' }] } },
        email: { to: ['production@stackdrove.com'], subject: 'Urgent Order: {{customer}}', body: 'A high priority order #{{_number}} for {{customer}} has been placed in {{city}}.' },
        whatsapp: null,
        repeatEveryDays: null,
      },
    },
    {
      id: 'rule-02',
      isActive: true,
      definition: {
        name: 'Dispatch LR Tracking to Customer',
        trigger: { type: 'stage_completed', stageKey: 'dispatch' },
        email: { to: ['{{customer_email}}'], subject: 'Your Order #{{_number}} Dispatched', body: 'Dear {{customer}}, your consignment is dispatched. LR Tracking Number: {{dispatch_no}}.' },
        whatsapp: null,
        repeatEveryDays: null,
      },
    },
  ],
};

const mockJobs = [
  {
    id: 'job-01',
    name: 'sweep_overdue',
    status: 'succeeded',
    stats: { checked: 24, marked_overdue: 1, notifications_sent: 1 },
    error: null,
    startedAt: new Date(Date.now() - 3600000 * 2).toISOString(),
    finishedAt: new Date(Date.now() - 3600000 * 2 + 1200).toISOString(),
    scope: 'organization' as const,
    requestedBy: 'admin@example.com',
  },
  {
    id: 'job-02',
    name: 'send_digests',
    status: 'succeeded',
    stats: { sent: 6, skipped: 0 },
    error: null,
    startedAt: new Date(Date.now() - 3600000 * 5).toISOString(),
    finishedAt: new Date(Date.now() - 3600000 * 5 + 3400).toISOString(),
    scope: 'platform' as const,
    requestedBy: null,
  },
  {
    id: 'job-03',
    name: 'archive_completed',
    status: 'succeeded',
    stats: { checked: 24, archived: 0 },
    error: null,
    startedAt: new Date(Date.now() - 86400000).toISOString(),
    finishedAt: new Date(Date.now() - 86400000 + 800).toISOString(),
    scope: 'organization' as const,
    requestedBy: null,
  },
];

const mockAudit = [
  { id: 'aud-01', actorEmail: 'admin@example.com', action: 'auth.login', entityType: 'Session', entityId: 'sess-01', ip: '127.0.0.1', createdAt: new Date(Date.now() - 1800000).toISOString() },
  { id: 'aud-02', actorEmail: 'admin@example.com', action: 'record.create', entityType: 'Record', entityId: 'rec-003', ip: '127.0.0.1', createdAt: new Date(Date.now() - 3600000 * 6).toISOString() },
  { id: 'aud-03', actorEmail: 'admin@example.com', action: 'workflow.update', entityType: 'Workflow', entityId: 'wf-orders-01', ip: '127.0.0.1', createdAt: new Date(Date.now() - 3600000 * 24).toISOString() },
  { id: 'aud-04', actorEmail: 'system', action: 'job.sweep_overdue', entityType: 'Job', entityId: 'job-01', ip: null, createdAt: new Date(Date.now() - 3600000 * 2).toISOString() },
];

interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  groups: string[];
  rowFilter: any;
  lastLoginAt: string | null;
  locked: boolean;
  isSuperAdmin: boolean;
}

const mockAdminUsers: AdminUserRow[] = [
  {
    id: 'usr-admin-01',
    name: 'Administrator',
    email: 'admin@example.com',
    phone: '+91 98765 00001',
    isActive: true,
    groups: ['ADMINS', 'SALES', 'MANAGER', 'PRODUCTION', 'STORE', 'ACCOUNTS'],
    rowFilter: null,
    lastLoginAt: new Date().toISOString(),
    locked: false,
    isSuperAdmin: true,
  },
  {
    id: 'usr-sales-01',
    name: 'Vikram Mehta',
    email: 'vikram.mehta@stackdrove.com',
    phone: '+91 98765 00002',
    isActive: true,
    groups: ['SALES'],
    rowFilter: null,
    lastLoginAt: new Date(Date.now() - 3600000 * 3).toISOString(),
    locked: false,
    isSuperAdmin: false,
  },
  {
    id: 'usr-prod-01',
    name: 'Ananya Roy',
    email: 'ananya.roy@stackdrove.com',
    phone: '+91 98765 00003',
    isActive: true,
    groups: ['PRODUCTION', 'STORE'],
    rowFilter: null,
    lastLoginAt: new Date(Date.now() - 3600000 * 18).toISOString(),
    locked: false,
    isSuperAdmin: false,
  },
];

interface MockTile {
  id: string;
  name: string;
  url: string;
  description: string | null;
  icon: string;
  groups: string[];
}
const mockTiles: MockTile[] = [
  { id: 'tile-1', name: 'Sales dashboard', url: 'https://example.com/sales', description: 'Monthly targets and orders', icon: 'chart', groups: [] },
  { id: 'tile-2', name: 'Price list', url: 'https://example.com/price-list', description: null, icon: 'sheet', groups: ['SALES'] },
];

const mockAdminGroups = [
  { id: 'grp-1', name: 'ADMINS', description: 'Full system administration and flow configuration', capabilities: ['ADMIN', 'CREATE', 'DELETE', 'RUN_JOBS', 'EXPORT', 'MANAGE_RULES'], members: 1 },
  { id: 'grp-2', name: 'SALES', description: 'Sales intake and client communications', capabilities: ['CREATE'], members: 2 },
  { id: 'grp-3', name: 'MANAGER', description: 'Order approval and escalation review', capabilities: ['CREATE', 'EXPORT'], members: 1 },
  { id: 'grp-4', name: 'PRODUCTION', description: 'Shop floor manufacturing and batch tracking', capabilities: [], members: 2 },
  { id: 'grp-5', name: 'STORE', description: 'Inventory, packaging and dispatch LR assignment', capabilities: [], members: 1 },
  { id: 'grp-6', name: 'ACCOUNTS', description: 'Invoicing, payment reconciliation and follow-up', capabilities: ['EXPORT'], members: 1 },
];

const mockOrdersDefinition = {
  id: 'wf-orders-01',
  version: 1,
  calendarId: 'cal-1',
  isActive: true,
  definition: {
    key: 'orders',
    name: 'Order to Delivery',
    stages: [
      { key: 'intake', name: 'Order Received', color: '#2563eb', responsibleGroups: ['SALES'], planned: { mode: 'none' }, completion: { kind: 'on_create' } },
      { key: 'approval', name: 'Approval', color: '#7c3aed', responsibleGroups: ['MANAGER'], planned: { mode: 'tat', base: { kind: 'previous_stage' }, tat: { kind: 'fixed', hours: 4 } }, completion: { kind: 'conditions', conditions: { mode: 'all', conditions: [{ fieldKey: 'approval_status', op: 'in', value: ['Approved', 'Rejected'] }] } } },
      { key: 'production', name: 'Production', color: '#ea580c', responsibleGroups: ['PRODUCTION'], planned: { mode: 'tat', base: { kind: 'previous_stage' }, tat: { kind: 'fixed', hours: 24 } }, completion: { kind: 'manual' } },
      { key: 'dispatch', name: 'Dispatch', color: '#0891b2', responsibleGroups: ['STORE'], planned: { mode: 'tat', base: { kind: 'previous_stage' }, tat: { kind: 'fixed', hours: 8 } }, completion: { kind: 'conditions', conditions: { mode: 'all', conditions: [{ fieldKey: 'dispatch_no', op: 'is_not_empty', value: '' }] } } },
      { key: 'payment', name: 'Payment Follow-up', color: '#16a34a', responsibleGroups: ['ACCOUNTS'], planned: { mode: 'tat', base: { kind: 'previous_stage' }, tat: { kind: 'fixed', hours: 48 } }, completion: { kind: 'conditions', conditions: { mode: 'all', conditions: [{ fieldKey: 'payment_received', op: 'eq', value: true }] } } },
    ],
    fields: [
      { key: 'customer', label: 'Customer Name', type: 'text', stageKey: 'intake', required: true, unique: false, searchKey: true, frozen: true, lineItem: false, viewGroups: ['ALL'], editGroups: ['ALL'] },
      { key: 'customer_email', label: 'Customer Email', type: 'email', stageKey: 'intake', required: false, unique: false, searchKey: false, frozen: false, lineItem: false, viewGroups: ['ALL'], editGroups: ['ALL'] },
      { key: 'customer_phone', label: 'Customer Phone', type: 'phone', stageKey: 'intake', required: false, unique: false, searchKey: false, frozen: false, lineItem: false, viewGroups: ['ALL'], editGroups: ['ALL'] },
      { key: 'city', label: 'City', type: 'select', stageKey: 'intake', required: true, unique: false, searchKey: false, frozen: false, lineItem: false, options: ['Mumbai', 'Delhi', 'Bengaluru', 'Pune', 'Hyderabad'], viewGroups: ['ALL'], editGroups: ['ALL'] },
      { key: 'priority', label: 'Priority', type: 'select', stageKey: 'intake', required: true, unique: false, searchKey: false, frozen: false, lineItem: false, options: ['Urgent', 'Normal'], viewGroups: ['ALL'], editGroups: ['ALL'] },
      { key: 'due_date', label: 'Payment Due Date', type: 'date', stageKey: 'intake', required: false, unique: false, searchKey: false, frozen: false, lineItem: false, viewGroups: ['ALL'], editGroups: ['ALL'] },
      { key: 'approval_status', label: 'Approval Status', type: 'select', stageKey: 'approval', required: false, unique: false, searchKey: false, frozen: false, lineItem: false, options: ['Approved', 'Rejected', 'Pending Review'], viewGroups: ['ALL'], editGroups: ['ALL'] },
      { key: 'approval_remarks', label: 'Approval Remarks', type: 'textarea', stageKey: 'approval', required: false, unique: false, searchKey: false, frozen: false, lineItem: false, viewGroups: ['ALL'], editGroups: ['ALL'] },
      { key: 'batch_no', label: 'Batch No.', type: 'text', stageKey: 'production', required: false, unique: false, searchKey: false, frozen: false, lineItem: false, viewGroups: ['ALL'], editGroups: ['ALL'] },
      { key: 'dispatch_no', label: 'Dispatch / LR No.', type: 'text', stageKey: 'dispatch', required: false, unique: true, searchKey: false, frozen: false, lineItem: false, viewGroups: ['ALL'], editGroups: ['ALL'] },
      { key: 'payment_received', label: 'Payment Received', type: 'checkbox', stageKey: 'payment', required: false, unique: false, searchKey: false, frozen: false, lineItem: false, viewGroups: ['ALL'], editGroups: ['ALL'] },
    ],
  },
  settings: {
    channels: ['email', 'whatsapp'],
    handoff: { enabled: true },
    sendOnHolidays: false,
    upcoming: { enabled: true, hoursBefore: 2 },
    overdueDigest: { enabled: true, hour: 9 },
    archive: { enabled: false, completedDaysAgo: 30 },
  },
};

/** Super admin endpoints and organization switching. Returns undefined when the path is not a platform path. */
function handlePlatformRequest(path: string, method: string, body: Record<string, unknown>, query: Record<string, unknown>): unknown {
  if (path === '/auth/switch-org' && method === 'POST') {
    const target = (body.orgId as string | null) ?? HOME_ORG;
    if (!mockOrgs.some((o) => o.id === target)) throw new Error('Organization not found');
    activeOrgId = target === HOME_ORG ? null : target;
    platformAudit(activeOrgId ? 'platform.org_entered' : 'platform.org_returned', 'Organization', target, target);
    return { accessToken: 'mock-admin-token-xyz' };
  }
  if (!path.startsWith('/platform/')) return undefined;

  if (path === '/platform/overview') {
    const now = Date.now();
    const closed = mockOrgs.filter((o) => o.status !== 'ACTIVE').length;
    const overview: PlatformOverview = {
      organizations: { total: mockOrgs.length, live: mockOrgs.length - closed, closed },
      users: { active: mockOrgs.reduce((s, o) => s + o.activeUsers, 0), inactive: 2, superAdmins: mockPlatformUsers.filter((u) => u.isSuperAdmin).length },
      workflows: mockOrgs.reduce((s, o) => s + o.workflows, 0),
      openRecords: mockOrgs.reduce((s, o) => s + o.records, 0),
      overdueStages: 9,
      notifications24h: { sent: 184, failed: 2 },
      jobs: [
        { name: 'sweep', status: 'succeeded', startedAt: new Date(now - 120000).toISOString(), finishedAt: new Date(now - 118000).toISOString(), error: null },
        { name: 'reminders', status: 'succeeded', startedAt: new Date(now - 420000).toISOString(), finishedAt: new Date(now - 417000).toISOString(), error: null },
        { name: 'digests', status: 'failed', startedAt: new Date(now - 780000).toISOString(), finishedAt: new Date(now - 779000).toISOString(), error: 'SMTP connection refused (mock)' },
        { name: 'archive', status: 'succeeded', startedAt: new Date(now - 2400000).toISOString(), finishedAt: new Date(now - 2398000).toISOString(), error: null },
      ],
    };
    return overview;
  }

  if (path === '/platform/orgs' && method === 'GET') return { items: [...mockOrgs].sort((a, b) => a.name.localeCompare(b.name)) };

  if (path === '/platform/orgs' && method === 'POST') {
    const admin = (body.admin ?? {}) as { name?: string; email?: string };
    const slug = String(body.slug ?? '');
    if (mockOrgs.some((o) => o.slug === slug)) throw new Error('That slug is already used');
    const org: PlatformOrg = {
      id: `org-${Date.now()}`,
      name: String(body.name ?? 'New organization'),
      slug,
      isActive: true,
      status: 'ACTIVE',
      suspendedReason: null,
      maxUsers: (body.maxUsers as number | null) ?? null,
      maxWorkflows: (body.maxWorkflows as number | null) ?? null,
      licenseExpiresAt: (body.licenseExpiresAt as string | null) ?? null,
      createdAt: new Date().toISOString(),
      activeUsers: 1,
      workflows: 0,
      records: 0,
    };
    mockOrgs.push(org);
    mockPlatformUsers.push({ id: `usr-${Date.now()}`, name: admin.name ?? 'Admin', email: admin.email ?? '', isActive: true, isSuperAdmin: false, org: { id: org.id, name: org.name }, lastLoginAt: null, locked: false });
    platformAudit('platform.org_created', 'Organization', org.id, org.id);
    return { id: org.id };
  }

  const orgMatch = /^\/platform\/orgs\/([^/]+)$/.exec(path);
  if (orgMatch && method === 'PATCH') {
    const org = mockOrgs.find((o) => o.id === orgMatch[1]);
    if (!org) throw new Error('Organization not found');
    Object.assign(org, body);
    if (body.isActive === true) org.suspendedReason = null;
    const expired = org.licenseExpiresAt ? new Date(org.licenseExpiresAt).getTime() < Date.now() : false;
    org.status = !org.isActive ? 'SUSPENDED' : expired ? 'LICENSE_EXPIRED' : 'ACTIVE';
    platformAudit(body.isActive === false ? 'platform.org_suspended' : body.isActive === true ? 'platform.org_reactivated' : 'platform.org_updated', 'Organization', org.id, org.id);
    return { ok: true };
  }

  if (path === '/platform/users') {
    const q = String(query.q ?? '').toLowerCase();
    const items = mockPlatformUsers.filter((u) => (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)) && (query.superAdmins !== 'true' || u.isSuperAdmin));
    return { items: items.sort((a, b) => Number(b.isSuperAdmin) - Number(a.isSuperAdmin) || a.name.localeCompare(b.name)) };
  }

  const userMatch = /^\/platform\/users\/([^/]+)\/(super-admin|revoke-sessions)$/.exec(path);
  if (userMatch) {
    const u = mockPlatformUsers.find((x) => x.id === userMatch[1]);
    if (!u) throw new Error('User not found');
    if (userMatch[2] === 'revoke-sessions') {
      u.locked = false;
      platformAudit('platform.sessions_revoked', 'User', u.id, u.org.id);
      return { ok: true };
    }
    const enabled = body.enabled === true;
    if (!enabled && u.id === mockMe.id) throw new Error('You cannot remove your own super admin access');
    u.isSuperAdmin = enabled;
    platformAudit(enabled ? 'platform.super_admin_granted' : 'platform.super_admin_revoked', 'User', u.id, u.org.id);
    return { ok: true };
  }

  if (path === '/platform/audit') return { items: mockPlatformAudit, nextCursor: null };

  if (/^\/platform\/jobs\/[^/]+\/run$/.test(path)) {
    platformAudit('platform.job_triggered', 'Job', path.split('/')[3]!, HOME_ORG);
    return { queued: true };
  }
  return {};
}

export function handleMockRequest(path: string, opts?: { method?: string; body?: unknown; query?: Record<string, unknown> }): unknown {
  const method = opts?.method ?? 'GET';
  const cleanPath = path.split('?')[0];
  const platform = handlePlatformRequest(cleanPath, method, (opts?.body ?? {}) as Record<string, unknown>, opts?.query ?? {});
  if (platform !== undefined) return platform;
  const flowsResult = handleFlowsRequest(cleanPath, method, (opts?.body ?? {}) as Record<string, unknown>, opts?.query ?? {});
  if (flowsResult !== undefined) return flowsResult;

  if (cleanPath === '/auth/login' && method === 'POST') {
    isMockAuthenticated = true;
    return { accessToken: 'mock-admin-token-xyz' };
  }

  if (cleanPath === '/auth/refresh') {
    if (isMockAuthenticated) return { accessToken: 'mock-admin-token-xyz' };
    throw new Error('Not authenticated');
  }

  if (cleanPath === '/auth/me') {
    return currentMe();
  }

  if (cleanPath === '/auth/logout') {
    isMockAuthenticated = false;
    activeOrgId = null;
    return {};
  }

  if (cleanPath === '/auth/change-password' && method === 'POST') {
    return { ok: true };
  }

  if (cleanPath === '/workflows' && method === 'GET') {
    return { items: workflowSummaries() };
  }

  if (cleanPath === '/workflows' && method === 'POST') {
    const body = (opts?.body ?? {}) as any;
    const def = body.definition ?? { key: 'new_wf', name: 'New workflow', stages: [], fields: [] };
    return { id: `wf-${Date.now()}`, key: def.key || 'new_wf', version: 1 };
  }

  // --- Workflow Definition endpoint for Form editor (advanced) ---
  const defMatch = /^\/workflows\/([^/]+)\/definition$/.exec(cleanPath);
  if (defMatch) {
    const wfKey = defMatch[1]!;
    // Served from the same schema-valid flows the canvas editor uses (the old hand-written
    // definition here used a different shape and crashed the form editor).
    if (method === 'GET') {
      const found = definitionOf(wfKey);
      if (!found) throw new Error('Workflow not found');
      return found;
    }
    if (method === 'PUT') {
      return saveDefinition(wfKey, (opts?.body ?? {}) as { definition?: unknown; settings?: unknown; isActive?: boolean });
    }
  }

  // --- Notification Rules endpoints ---
  const ruleMatch = /^\/workflows\/([^/]+)\/rules(?:\/([^/]+))?$/.exec(cleanPath);
  if (ruleMatch || cleanPath === '/admin/rules') {
    const wfKey = ruleMatch ? ruleMatch[1]! : 'orders';
    const ruleId = ruleMatch ? ruleMatch[2] : undefined;
    if (!mockRules[wfKey]) mockRules[wfKey] = [];

    if (method === 'GET') {
      return { items: mockRules[wfKey] ?? [] };
    }
    if (method === 'POST') {
      const body = (opts?.body ?? {}) as any;
      const newRule = { id: `rule-${Date.now()}`, isActive: true, definition: body };
      mockRules[wfKey].push(newRule);
      return { id: newRule.id };
    }
    if (method === 'PUT' && ruleId) {
      const body = (opts?.body ?? {}) as any;
      const r = mockRules[wfKey].find((x) => x.id === ruleId);
      if (r) r.definition = body;
      return { ok: true };
    }
    if (method === 'DELETE' && ruleId) {
      mockRules[wfKey] = mockRules[wfKey].filter((x) => x.id !== ruleId);
      return { ok: true };
    }
  }

  // --- Records endpoints (Creation, List, Single, History, Complete, Planned, Archive) ---
  const recordsCreateMatch = /^\/workflows\/([^/]+)\/records$/.exec(cleanPath);
  if (recordsCreateMatch && method === 'POST') {
    const body = (opts?.body ?? {}) as { data?: Record<string, any>; items?: Record<string, any>[] };
    const nextNum = sampleRecords.length > 0 ? Math.max(...sampleRecords.map((r) => r.number)) + 1 : 1001;
    const title = String(body.data?.customer ?? body.data?.title ?? `Order #${nextNum}`);
    const newRec: RecordDto = {
      id: `rec-${Date.now()}`,
      number: nextNum,
      title,
      submissionId: `SUB-2026-${String(nextNum).slice(-3)}`,
      currentStageKey: 'intake',
      completedAt: null,
      archivedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      data: body.data ?? {},
      stages: [
        { stageKey: 'intake', status: 'done', plannedAt: null, actualAt: new Date().toISOString(), overdue: false },
        { stageKey: 'approval', status: 'active', plannedAt: new Date(Date.now() + 86400000).toISOString(), actualAt: null, overdue: false },
        { stageKey: 'production', status: 'waiting', plannedAt: null, actualAt: null, overdue: false },
        { stageKey: 'dispatch', status: 'waiting', plannedAt: null, actualAt: null, overdue: false },
        { stageKey: 'payment', status: 'waiting', plannedAt: null, actualAt: null, overdue: false },
      ],
    };
    sampleRecords.unshift(newRec);
    return { records: [newRec] };
  }

  // Record batch archive / restore
  if (cleanPath.startsWith('/workflows/') && (cleanPath.endsWith('/records/archive') || cleanPath.endsWith('/records/restore'))) {
    const body = (opts?.body ?? {}) as { ids?: string[] };
    const isArchive = cleanPath.endsWith('/records/archive');
    for (const id of body.ids ?? []) {
      const rec = sampleRecords.find((r) => r.id === id);
      if (rec) rec.archivedAt = isArchive ? new Date().toISOString() : null;
    }
    return { count: body.ids?.length ?? 1 };
  }

  // Record stage complete
  const completeMatch = /^\/workflows\/([^/]+)\/records\/([^/]+)\/stages\/([^/]+)\/complete$/.exec(cleanPath);
  if (completeMatch && method === 'POST') {
    const [, , recId, stageKey] = completeMatch;
    const rec = sampleRecords.find((r) => r.id === recId);
    if (rec) {
      rec.version += 1;
      rec.updatedAt = new Date().toISOString();
      const body = (opts?.body ?? {}) as { data?: Record<string, any> };
      if (body.data) Object.assign(rec.data, body.data);
      const stageIdx = rec.stages.findIndex((s) => s.stageKey === stageKey);
      if (stageIdx !== -1) {
        rec.stages[stageIdx]!.status = 'done';
        rec.stages[stageIdx]!.actualAt = new Date().toISOString();
        if (stageIdx + 1 < rec.stages.length) {
          rec.stages[stageIdx + 1]!.status = 'active';
          rec.currentStageKey = rec.stages[stageIdx + 1]!.stageKey;
        } else {
          rec.completedAt = new Date().toISOString();
        }
      }
    }
    return { ok: true };
  }

  // Record stage planned
  const planMatch = /^\/workflows\/([^/]+)\/records\/([^/]+)\/stages\/([^/]+)\/planned$/.exec(cleanPath);
  if (planMatch && method === 'PUT') {
    const [, , recId, stageKey] = planMatch;
    const body = (opts?.body ?? {}) as { plannedAt?: string };
    const rec = sampleRecords.find((r) => r.id === recId);
    if (rec) {
      const st = rec.stages.find((s) => s.stageKey === stageKey);
      if (st && body.plannedAt) st.plannedAt = body.plannedAt;
    }
    return { ok: true };
  }

  // Record history
  const historyMatch = /^\/workflows\/([^/]+)\/records\/([^/]+)\/history$/.exec(cleanPath);
  if (historyMatch) {
    // Same shape as the API: who did what, with the stage events each change caused (newest first).
    const rec = sampleRecords.find((r) => r.id === historyMatch[2]) ?? sampleRecords[0]!;
    const items: HistoryEntry[] = [];
    const done = rec.stages.filter((s) => s.status === 'done' && s.actualAt);
    done.forEach((s, i) => {
      const next = rec.stages.slice(rec.stages.indexOf(s) + 1).find((x) => x.status === 'active' || x.status === 'done');
      items.push({
        id: `h-${rec.id}-${i}`,
        action: i === 0 ? 'record.created' : 'record.stage_completed',
        actorEmail: i === 0 ? 'ravi@example.com' : 'admin@example.com',
        createdAt: s.actualAt!,
        events: [{ type: 'stage_completed', stageKey: s.stageKey }, ...(next ? [{ type: 'stage_activated', stageKey: next.stageKey }] : [])],
      });
    });
    return { items: items.reverse() };
  }

  // Column filter values (most used first).
  if (/^\/workflows\/[^/]+\/records\/values$/.test(cleanPath)) {
    const key = String(opts?.query?.field ?? '');
    const counts = new Map<string, number>();
    for (const r of sampleRecords) {
      const v = r.data[key];
      for (const x of Array.isArray(v) ? v : v === null || v === undefined || v === '' ? [] : [String(v)]) counts.set(String(x), (counts.get(String(x)) ?? 0) + 1);
    }
    return { items: [...counts].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count })) };
  }

  // Google Sheets export: not set up in the offline demo.
  if (/^\/workflows\/[^/]+\/records\/export-sheet$/.test(cleanPath)) {
    if (method === 'GET') return { configured: false, clientEmail: null };
    throw new Error('Exporting to Google Sheets needs the API server and a Google Sheets connection.');
  }

  // CSV import: required fields of the intake form, then new records (dry run saves nothing).
  if (/^\/workflows\/[^/]+\/records\/import$/.test(cleanPath) && method === 'POST') {
    const body = (opts?.body ?? {}) as { rows: Record<string, string>[]; dryRun: boolean };
    const required = mockWorkflowView.fields.filter((f) => f.stageKey === 'intake' && f.required);
    const results = body.rows.map((r, i) => {
      const missing = required.filter((f) => !r[f.key]);
      return missing.length ? { row: i + 1, ok: false, errors: Object.fromEntries(missing.map((f) => [f.key, `${f.label} is required`])) } : { row: i + 1, ok: true };
    });
    if (!body.dryRun) {
      body.rows.forEach((r, i) => {
        if (!results[i]!.ok) return;
        const base = sampleRecords[0]!;
        const number = Math.max(...sampleRecords.map((x) => x.number)) + 1;
        sampleRecords.unshift({ ...JSON.parse(JSON.stringify(base)), id: `rec-imp-${Date.now()}-${i}`, number, title: r.customer ?? `#${number}`, submissionId: null, data: r, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      });
    }
    const ok = results.filter((r) => r.ok).length;
    return { total: results.length, ok, failed: results.length - ok, results: results.filter((r) => !r.ok) };
  }

  // Add line items to a record's submission.
  const itemsMatch = /^\/workflows\/([^/]+)\/records\/([^/]+)\/items$/.exec(cleanPath);
  if (itemsMatch && method === 'POST') {
    const rec = sampleRecords.find((r) => r.id === itemsMatch[2]);
    if (!rec?.submissionId) throw new Error('This record is not part of a multi-item submission');
    const body = (opts?.body ?? {}) as { items?: Record<string, unknown>[] };
    const created = (body.items ?? []).map((it, i) => {
      const number = Math.max(...sampleRecords.map((r) => r.number)) + 1 + i;
      const copy: RecordDto = { ...JSON.parse(JSON.stringify(rec)), id: `rec-${Date.now()}-${i}`, number, data: { ...rec.data, ...(it as RecordDto['data']) }, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      return copy;
    });
    sampleRecords.push(...created);
    return { records: created };
  }

  // Deliveries for a record (admins): one failed WhatsApp hand-off to show the "how to fix" help.
  const deliveriesMatch = /^\/workflows\/([^/]+)\/records\/([^/]+)\/notifications$/.exec(cleanPath);
  if (deliveriesMatch) {
    const rec = sampleRecords.find((r) => r.id === deliveriesMatch[2]) ?? sampleRecords[0]!;
    const items: DeliveryLog[] = [];
    for (const s of rec.stages.filter((x) => x.status !== 'waiting' && x.stageKey !== 'intake')) {
      const at = rec.stages[rec.stages.indexOf(s) - 1]?.actualAt ?? rec.createdAt;
      const owner = mockWorkflowView.stages.find((x) => x.key === s.stageKey)?.responsibleGroups[0]?.toLowerCase() ?? 'team';
      items.push({ id: `d-${s.stageKey}-e`, kind: 'handoff', channel: 'email', recipient: `${owner}@example.com`, status: 'sent', error: null, attempts: 1, stageKey: s.stageKey, ruleName: null, event: 'stage_activated', createdAt: at, updatedAt: at });
      if (s.stageKey === 'approval')
        items.push({ id: `d-${s.stageKey}-w`, kind: 'rule', channel: 'whatsapp', recipient: '9876543210', status: 'failed', error: 'WhatsApp: (#132001) Template name does not exist in the translation', attempts: 5, stageKey: s.stageKey, ruleName: 'Client approval on WhatsApp', event: 'stage_activated', createdAt: at, updatedAt: at });
    }
    return { items };
  }

  // Single record PATCH
  const patchRecMatch = /^\/workflows\/([^/]+)\/records\/([^/]+)$/.exec(cleanPath);
  if (patchRecMatch && method === 'PATCH') {
    const [, , recId] = patchRecMatch;
    const body = (opts?.body ?? {}) as { data?: Record<string, any> };
    const rec = sampleRecords.find((r) => r.id === recId);
    if (rec) {
      rec.version += 1;
      rec.updatedAt = new Date().toISOString();
      if (body.data) {
        // Same as the server: a changed parent clears dependent dropdowns that no longer fit.
        const next = { ...rec.data, ...body.data };
        Object.assign(rec.data, body.data, staleDependents(mockWorkflowView.fields, next, Object.keys(body.data)));
      }
      return rec;
    }
    return { ok: true };
  }

  if (cleanPath === '/workflows/orders') {
    return mockWorkflowView;
  }

  if (cleanPath === '/workflows/orders/records') {
    const sub = opts?.query?.submissionId as string | undefined;
    const items = sub ? sampleRecords.filter((r) => r.submissionId === sub) : sampleRecords;
    const list: RecordList = {
      items,
      total: items.length,
      page: 1,
      pageSize: 25,
      aggregates: {},
    };
    return list;
  }

  if (cleanPath.startsWith('/workflows/orders/records/')) {
    const id = cleanPath.split('/').pop();
    const rec = sampleRecords.find((r) => r.id === id || String(r.number) === id) ?? sampleRecords[0];
    return rec;
  }

  if (/^\/workflows\/[^/]+\/reports\/missing$/.test(cleanPath)) {
    const only = opts?.query?.stage as string | undefined;
    const items = sampleRecords.flatMap((r) =>
      r.stages
        .filter((s) => s.status === 'active' && (!only || s.stageKey === only))
        .map((s) => ({
          recordId: r.id,
          recordNumber: r.number,
          title: r.title,
          stageKey: s.stageKey,
          missing: mockWorkflowView.fields.filter((f) => f.stageKey === s.stageKey && (r.data[f.key] === undefined || r.data[f.key] === null || r.data[f.key] === '')).map((f) => ({ key: f.key, label: f.label, required: f.required })),
        }))
        .filter((x) => x.missing.length),
    );
    return { items, total: items.length };
  }

  if (cleanPath === '/workflows/orders/reports/summary') {
    const summary: { generatedAt: string; totalRecords: number; stages: StageSummaryRow[] } = {
      generatedAt: new Date().toISOString(),
      totalRecords: 24,
      stages: [
        { stageKey: 'intake', stageName: 'Order Received', color: '#2563eb', upcoming: 0, overdue: 0, unplanned: 0, doneOnTime: 24, doneLate: 0, skipped: 0, total: 24, avgOverdueHours: 0 },
        { stageKey: 'approval', stageName: 'Approval', color: '#7c3aed', upcoming: 1, overdue: 0, unplanned: 0, doneOnTime: 21, doneLate: 2, skipped: 0, total: 24, avgOverdueHours: 0 },
        { stageKey: 'production', stageName: 'Production', color: '#ea580c', upcoming: 3, overdue: 0, unplanned: 0, doneOnTime: 18, doneLate: 1, skipped: 0, total: 22, avgOverdueHours: 0 },
        { stageKey: 'dispatch', stageName: 'Dispatch', color: '#0891b2', upcoming: 2, overdue: 1, unplanned: 0, doneOnTime: 15, doneLate: 1, skipped: 0, total: 19, avgOverdueHours: 3.5 },
        { stageKey: 'payment', stageName: 'Payment Follow-up', color: '#16a34a', upcoming: 4, overdue: 1, unplanned: 0, doneOnTime: 12, doneLate: 0, skipped: 0, total: 17, avgOverdueHours: 2.1 },
      ],
    };
    return summary;
  }

  if (cleanPath === '/workflows/orders/reports/pending') {
    const pending: { items: PendingTask[] } = {
      items: [
        { recordId: 'rec-002', recordNumber: 1002, title: 'TechSol Pvt Ltd', stageKey: 'dispatch', plannedAt: new Date(Date.now() - 3600000 * 2).toISOString(), overdue: true, delayHours: 2 },
        { recordId: 'rec-003', recordNumber: 1003, title: 'Global Retailers', stageKey: 'approval', plannedAt: new Date(Date.now() + 3600000 * 2).toISOString(), overdue: false, delayHours: null },
      ],
    };
    return pending;
  }

  if (cleanPath === '/my-tasks' || cleanPath === '/me/tasks') {
    const tasks: { items: MyTask[] } = {
      items: [
        { workflowKey: 'orders', workflowName: 'Order to Delivery', recordId: 'rec-002', recordNumber: 1002, title: 'TechSol Pvt Ltd — Cloud Devices', stageKey: 'dispatch', stageName: 'Dispatch', stageColor: '#0891b2', plannedAt: new Date(Date.now() - 3600000 * 2).toISOString(), overdue: true, delayHours: 2 },
      ],
    };
    return tasks;
  }

  if (cleanPath.startsWith('/workflows/orders/views')) {
    return { items: [] };
  }

  // Any other flow: view from its definition, no records yet.
  const wfMatch = /^\/workflows\/([^/]+)(\/.*)?$/.exec(cleanPath);
  if (wfMatch && wfMatch[1] !== 'orders') {
    const view = viewOf(wfMatch[1]!);
    const rest = wfMatch[2] ?? '';
    if (view && !rest) return view;
    if (view && rest === '/records') return { items: [], total: 0, page: 1, pageSize: 25, aggregates: {} } satisfies RecordList;
    if (view && rest === '/reports/summary')
      return { generatedAt: new Date().toISOString(), totalRecords: 0, stages: view.stages.map((s) => ({ stageKey: s.key, stageName: s.name, color: s.color, upcoming: 0, overdue: 0, unplanned: 0, doneOnTime: 0, doneLate: 0, skipped: 0, total: 0, avgOverdueHours: 0 })) };
    if (rest.startsWith('/reports')) return { items: [] };
    if (rest.startsWith('/views')) return { items: [] };
  }

  // --- Admin Groups ---
  // --- Dashboard quick links ---
  if (cleanPath === '/dashboard/tiles') return { items: mockTiles, canManage: true };
  if (cleanPath === '/admin/dashboard-tiles' && method === 'POST') {
    const b = (opts?.body ?? {}) as Omit<MockTile, 'id'>;
    if (!/^https?:\/\//i.test(String(b.url))) throw new Error('Links must start with https:// or http://');
    const t = { ...b, id: `tile-${Date.now()}`, description: b.description || null };
    mockTiles.push(t);
    return { id: t.id };
  }
  if (cleanPath === '/admin/dashboard-tiles' && method === 'PUT') {
    const order = ((opts?.body ?? {}) as { order: string[] }).order;
    mockTiles.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    return { ok: true };
  }
  const tileMatch = /^\/admin\/dashboard-tiles\/([^/]+)$/.exec(cleanPath);
  if (tileMatch) {
    const i = mockTiles.findIndex((t) => t.id === tileMatch[1]);
    if (i < 0) throw new Error('Tile not found');
    if (method === 'DELETE') mockTiles.splice(i, 1);
    else mockTiles[i] = { ...mockTiles[i]!, ...((opts?.body ?? {}) as Partial<MockTile>) };
    return { ok: true };
  }

  if (cleanPath === '/admin/groups') {
    if (method === 'GET') return { items: mockAdminGroups };
    if (method === 'POST') {
      const body = (opts?.body ?? {}) as any;
      const g = { id: `grp-${Date.now()}`, name: body.name ?? 'GROUP', description: body.description ?? null, capabilities: body.capabilities ?? [], members: 0 };
      mockAdminGroups.push(g);
      return { id: g.id };
    }
  }
  const groupMatch = /^\/admin\/groups\/([^/]+)$/.exec(cleanPath);
  if (groupMatch && method === 'PUT') {
    const body = (opts?.body ?? {}) as any;
    const g = mockAdminGroups.find((x) => x.id === groupMatch[1]);
    if (g) Object.assign(g, body);
    return { ok: true };
  }

  // --- Admin Users ---
  if (cleanPath === '/admin/users') {
    if (method === 'GET') return { items: mockAdminUsers };
    if (method === 'POST') {
      const body = (opts?.body ?? {}) as any;
      const u = { id: `usr-${Date.now()}`, name: body.name ?? 'New User', email: body.email ?? '', phone: body.phone ?? null, isActive: true, groups: body.groups ?? [], rowFilter: null, lastLoginAt: null, locked: false, isSuperAdmin: false };
      mockAdminUsers.push(u);
      return { id: u.id };
    }
  }
  const userAdminMatch = /^\/admin\/users\/([^/]+)$/.exec(cleanPath);
  if (userAdminMatch && (method === 'PUT' || method === 'PATCH')) {
    const body = (opts?.body ?? {}) as any;
    const u = mockAdminUsers.find((x) => x.id === userAdminMatch[1]);
    if (u) Object.assign(u, body);
    return { ok: true };
  }

  // --- Calendars ---
  if (cleanPath === '/admin/calendars') {
    if (method === 'GET') return { items: mockCalendars };
    if (method === 'POST') {
      const body = (opts?.body ?? {}) as any;
      const id = `cal-${Date.now()}`;
      mockCalendars.push({ id, name: body.name ?? 'New Calendar', timezone: body.config?.timezone ?? 'Asia/Kolkata', shiftStart: body.config?.shiftStart ?? '09:00', shiftEnd: body.config?.shiftEnd ?? '18:00', weeklyOff: body.config?.weeklyOff ?? [7], holidays: body.holidays ?? [] });
      return { id };
    }
  }
  const calMatch = /^\/admin\/calendars\/([^/]+)$/.exec(cleanPath);
  if (calMatch && (method === 'PUT' || method === 'PATCH')) {
    const body = (opts?.body ?? {}) as any;
    const cal = mockCalendars.find((x) => x.id === calMatch[1]);
    if (cal) {
      if (body.name) cal.name = body.name;
      if (body.config) {
        cal.timezone = body.config.timezone ?? cal.timezone;
        cal.shiftStart = body.config.shiftStart ?? cal.shiftStart;
        cal.shiftEnd = body.config.shiftEnd ?? cal.shiftEnd;
        cal.weeklyOff = body.config.weeklyOff ?? cal.weeklyOff;
      }
      if (body.holidays) cal.holidays = body.holidays;
    }
    return { ok: true };
  }

  // --- Option Sets ---
  if (cleanPath === '/admin/option-sets') {
    if (method === 'GET') return { items: mockOptionSets };
    if (method === 'PUT' || method === 'POST') {
      const body = (opts?.body ?? {}) as any;
      const existing = mockOptionSets.find((x) => x.key === body.key);
      if (existing) {
        existing.name = body.name ?? existing.name;
        existing.options = body.options ?? existing.options;
      } else {
        mockOptionSets.push({ id: `opt-${Date.now()}`, key: body.key, name: body.name, options: body.options ?? [] });
      }
      return { ok: true };
    }
  }

  // --- Background Jobs ---
  if (cleanPath === '/admin/jobs') {
    return { items: mockJobs };
  }
  const jobRunMatch = /^\/admin\/jobs\/([^/]+)\/run$/.exec(cleanPath);
  if (jobRunMatch && method === 'POST') {
    return { queued: true };
  }

  // --- Audit Log ---
  if (cleanPath === '/admin/audit') {
    return { items: mockAudit, nextCursor: null };
  }

  return {};
}
