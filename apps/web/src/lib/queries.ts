import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { DashboardData, DeliveryLog, FlowsResponse, HistoryEntry, MyTask, PendingTask, RecordDto, RecordList, SavedViewDto, StageSummaryRow, TemplateSummary, WorkflowSummary, WorkflowView } from './types';

export const qk = {
  workflows: ['workflows'] as const,
  workflow: (wf: string) => ['workflow', wf] as const,
  records: (wf: string, params: object) => ['records', wf, params] as const,
  record: (wf: string, id: string) => ['record', wf, id] as const,
  history: (wf: string, id: string) => ['history', wf, id] as const,
  summary: (wf: string) => ['summary', wf] as const,
  pending: (wf: string, overdueOnly: boolean) => ['pending', wf, overdueOnly] as const,
  myTasks: ['my-tasks'] as const,
  views: (wf: string) => ['views', wf] as const,
};

export const useWorkflows = () => useQuery({ queryKey: qk.workflows, queryFn: () => api<{ items: WorkflowSummary[] }>('/workflows').then((r) => r.items) });

export const useWorkflow = (wf: string) => useQuery({ queryKey: qk.workflow(wf), queryFn: () => api<WorkflowView>(`/workflows/${wf}`), staleTime: 60_000 });

export interface RecordParams {
  page: number;
  pageSize: number;
  sort: string;
  dir: 'asc' | 'desc';
  search?: string;
  stage?: string;
  status?: string;
  archived?: string;
  mine?: string;
  filters?: string;
  /** Columns on screen (comma separated) — they get filled / unique totals. */
  cols?: string;
}

export const useRecords = (wf: string, params: RecordParams) =>
  useQuery({
    queryKey: qk.records(wf, params),
    queryFn: ({ signal }) => api<RecordList>(`/workflows/${wf}/records`, { query: { ...params }, signal }),
    placeholderData: keepPreviousData,
  });

export const useRecord = (wf: string, id: string) => useQuery({ queryKey: qk.record(wf, id), queryFn: () => api<RecordDto>(`/workflows/${wf}/records/${id}`) });

export const useHistory = (wf: string, id: string, enabled: boolean) =>
  useQuery({ queryKey: qk.history(wf, id), queryFn: () => api<{ items: HistoryEntry[] }>(`/workflows/${wf}/records/${id}/history`).then((r) => r.items), enabled });

/** Hand-off / reminder / message / webhook deliveries of one record (admins only). */
export const useDeliveries = (wf: string, id: string, enabled: boolean) =>
  useQuery({ queryKey: ['deliveries', wf, id], queryFn: () => api<{ items: DeliveryLog[] }>(`/workflows/${wf}/records/${id}/notifications`).then((r) => r.items), enabled, refetchInterval: 60_000 });

export const useSummary = (wf: string) =>
  useQuery({ queryKey: qk.summary(wf), queryFn: () => api<{ generatedAt: string; totalRecords: number; stages: StageSummaryRow[] }>(`/workflows/${wf}/reports/summary`), refetchInterval: 60_000 });

export const usePending = (wf: string, overdueOnly: boolean) =>
  useQuery({ queryKey: qk.pending(wf, overdueOnly), queryFn: () => api<{ items: PendingTask[] }>(`/workflows/${wf}/reports/pending`, { query: { overdueOnly } }).then((r) => r.items) });

export const useMyTasks = () => useQuery({ queryKey: qk.myTasks, queryFn: () => api<{ items: MyTask[] }>('/me/tasks').then((r) => r.items), refetchInterval: 60_000 });

export interface FlowFilters {
  tab: 'primary' | 'drafts' | 'trash';
  q?: string;
  label?: string;
  status: 'all' | 'active' | 'inactive';
  since: 'any' | '7d' | '30d' | '90d';
}

export const useFlows = (f: FlowFilters) =>
  useQuery({ queryKey: ['flows', f], queryFn: ({ signal }) => api<FlowsResponse>('/flows', { query: { ...f }, signal }), placeholderData: keepPreviousData });

export const useTemplates = () => useQuery({ queryKey: ['templates'], queryFn: () => api<{ items: TemplateSummary[]; canPublishGlobal: boolean }>('/templates') });

export const useDashboard = () => useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardData>('/dashboard'), refetchInterval: 60_000 });

/** After creating, renaming or trashing flows: lists, nav and dashboard all change. */
export function useFlowsInvalidation() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['flows'] });
    void qc.invalidateQueries({ queryKey: qk.workflows });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['workflow'] });
  };
}

export const useViews = (wf: string) => useQuery({ queryKey: qk.views(wf), queryFn: () => api<{ items: SavedViewDto[] }>(`/workflows/${wf}/views`).then((r) => r.items) });

/** Invalidate everything derived from records after a write. */
export function useRecordsInvalidation(wf: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['records', wf] });
    void qc.invalidateQueries({ queryKey: ['record', wf] });
    void qc.invalidateQueries({ queryKey: ['history', wf] });
    void qc.invalidateQueries({ queryKey: ['deliveries', wf] });
    void qc.invalidateQueries({ queryKey: qk.summary(wf) });
    void qc.invalidateQueries({ queryKey: ['pending', wf] });
    void qc.invalidateQueries({ queryKey: qk.myTasks });
  };
}

export function useApiMutation<TVars, TResult = unknown>(fn: (v: TVars) => Promise<TResult>, onSuccess?: (r: TResult, v: TVars) => void) {
  return useMutation({ mutationFn: fn, onSuccess });
}
