import type { Capability, ConditionGroup, FieldType, FieldValue, StageStatus } from '@fms/core';

export type OrgStatus = 'ACTIVE' | 'SUSPENDED' | 'LICENSE_EXPIRED';

export interface Me {
  id: string;
  /** Organization being worked in (differs from homeOrgId while a super admin visits another one). */
  orgId: string;
  homeOrgId: string;
  org: { id: string; name: string; slug: string; status: OrgStatus };
  email: string;
  name: string;
  groups: string[];
  capabilities: Capability[];
  isSuperAdmin: boolean;
}

export interface PlatformOrg {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  status: OrgStatus;
  suspendedReason: string | null;
  maxUsers: number | null;
  maxWorkflows: number | null;
  licenseExpiresAt: string | null;
  createdAt: string;
  activeUsers: number;
  workflows: number;
  records: number;
}

export interface PlatformUser {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  isSuperAdmin: boolean;
  org: { id: string; name: string };
  lastLoginAt: string | null;
  locked: boolean;
}

export interface PlatformOverview {
  organizations: { total: number; live: number; closed: number };
  users: { active: number; inactive: number; superAdmins: number };
  workflows: number;
  openRecords: number;
  overdueStages: number;
  notifications24h: { sent: number; failed: number };
  jobs: { name: string; status: string; startedAt: string; finishedAt: string | null; error: string | null }[];
}

export interface WorkflowSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isDraft?: boolean;
  label?: string | null;
}

export type FlowStatus = 'active' | 'inactive' | 'draft' | 'trashed';

export interface FlowRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  label: string | null;
  status: FlowStatus;
  isFavorite: boolean;
  version: number;
  stageCount: number;
  openRecords: number;
  overdue: number;
  createdBy: { id: string; name: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface FlowsResponse {
  items: FlowRow[];
  counts: { primary: number; drafts: number; trash: number };
  labels: string[];
  canManage: boolean;
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string | null;
  category: string;
  scope: 'global' | 'organization';
  builtIn: boolean;
  stages: { key: string; name: string; color: string }[];
  fieldCount: number;
  updatedAt: string;
}

export interface DashboardFlow {
  key: string;
  name: string;
  label: string | null;
  status: 'active' | 'inactive' | 'draft';
  open: number;
  created7d: number;
  completed7d: number;
  overdue: number;
  stages: { key: string; name: string; color: string; active: number; overdue: number }[];
  updatedAt: string;
}

export interface DashboardData {
  timezone: string;
  totals: { flows: number; drafts: number; openRecords: number; overdue: number; created7d: number; completed7d: number };
  flows: DashboardFlow[];
  /** Last 14 days, oldest first, in the organization's timezone. */
  trend: { date: string; created: number; completed: number }[];
  /** Stage completions in the last 30 days that had a planned time. */
  onTime: { onTime: number; late: number; avgLateHours: number | null };
  teams: { group: string; active: number; overdue: number }[];
  activity: { id: string; action: string; actorEmail: string | null; createdAt: string; recordId: string; recordNumber: number | null; flowKey: string | null; flowName: string | null }[];
}

export interface EditorData {
  flow: { id: string; key: string; name: string; description: string | null; label: string | null; isActive: boolean; isDraft: boolean; version: number; calendarId: string };
  definition: import('@fms/core').WorkflowDef;
  settings: import('@fms/core').WorkflowSettings;
  canvas: import('@fms/core').Canvas;
  otherRules: number;
  groups: string[];
  calendars: { id: string; name: string }[];
  /** Active users of the organization, for per-field access lists. */
  users?: { name: string; email: string }[];
}

export interface StageView {
  key: string;
  name: string;
  color: string;
  responsibleGroups: string[];
  plannedMode: 'none' | 'manual' | 'tat';
  completion: 'on_create' | 'manual' | 'conditions';
  isMine: boolean;
  /** Stage Access Control: may this user fill in / complete the stage (default true). */
  canEdit?: boolean;
  description?: string;
  video?: { title?: string; url: string };
  headerColor?: string;
  lockAfterComplete?: boolean;
  /** Edit one record at a time on the record page (default true). */
  singleUpdate?: boolean;
  bulkUpdate?: boolean;
  document?: { fieldKey: string; format: 'pdf' | 'doc'; requireReview: boolean } | null;
  /** Intake only: custom thank-you message, and the public link id (admins, when public). */
  thankYou?: string | null;
  publicFormId?: string | null;
}

/** GET /public/forms/:token */
export interface PublicFormView {
  name: string;
  description: string | null;
  timezone: string;
  stage: { name: string; description: string | null; video: { title?: string; url: string } | null; thankYou: string | null };
  fields: FieldView[];
}

export interface FieldView {
  key: string;
  label: string;
  type: FieldType;
  stageKey: string;
  required: boolean;
  unique: boolean;
  searchKey: boolean;
  frozen: boolean;
  lineItem: boolean;
  options?: string[];
  dependsOn?: string;
  optionMap?: Record<string, string[]>;
  width?: number;
  helpText?: string;
  placeholder?: string;
  /** Pre-filled on the form; `TODAY` / `NOW` for date fields. */
  defaultValue?: string;
  /** File fields: more than one file. */
  allowMultiple?: boolean;
  canEdit: boolean;
}

export interface WorkflowView {
  id: string;
  key: string;
  name: string;
  version: number;
  isActive: boolean;
  description?: string;
  timezone: string;
  canCreate: boolean;
  canArchive: boolean;
  canExport: boolean;
  stages: StageView[];
  fields: FieldView[];
}

export interface StageDto {
  stageKey: string;
  status: StageStatus;
  plannedAt: string | null;
  actualAt: string | null;
  overdue: boolean;
}

export type RecordData = Record<string, FieldValue | undefined>;

export type RecordLifecycleStatus = 'active' | 'completed' | 'archived';

export interface RecordDto {
  id: string;
  number: number;
  title: string;
  submissionId: string | null;
  data: RecordData;
  currentStageKey: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  status?: RecordLifecycleStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
  stages: StageDto[];
}

export interface RecordList {
  items: RecordDto[];
  total: number;
  page: number;
  pageSize: number;
  aggregates: Record<string, { sum: number | null; avg: number | null }>;
}

export interface HistoryEntry {
  id: string;
  action: string;
  actorEmail: string | null;
  createdAt: string;
  fields?: Record<string, { from: unknown; to: unknown }>;
  events?: { type: string; stageKey: string }[];
}

export interface StageSummaryRow {
  stageKey: string;
  stageName: string;
  color: string;
  upcoming: number;
  overdue: number;
  unplanned: number;
  doneOnTime: number;
  doneLate: number;
  skipped: number;
  total: number;
  avgOverdueHours: number;
}

export interface PendingTask {
  recordId: string;
  recordNumber: number;
  title?: string;
  stageKey: string;
  plannedAt: string | null;
  overdue: boolean;
  delayHours: number | null;
}

export interface MyTask {
  workflowKey: string;
  workflowName: string;
  recordId: string;
  recordNumber: number;
  title: string;
  stageKey: string;
  stageName: string;
  stageColor: string;
  plannedAt: string | null;
  overdue: boolean;
  delayHours: number | null;
}

export interface SavedViewDto {
  id: string;
  name: string;
  isShared: boolean;
  isMine: boolean;
  config: { columns: string[]; filters?: ConditionGroup; sort?: { by: string; dir: 'asc' | 'desc' }; status?: string; stage?: string };
}
