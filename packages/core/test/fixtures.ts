import { DateTime } from 'luxon';
import { BusinessCalendar, workflowDefSchema, type WorkflowDefInput } from '../src/index.js';

export const TZ = 'Asia/Kolkata';
/** Parse a wall-clock time in IST. */
export const ist = (s: string) => DateTime.fromISO(s, { zone: TZ }).toJSDate();
/** Format a Date as IST wall-clock. */
export const fmt = (d: Date | null | undefined) => (d ? DateTime.fromJSDate(d).setZone(TZ).toFormat('yyyy-MM-dd HH:mm') : null);

// Jan 2026: Thu 22, Fri 23, Sat 24, Sun 25 (weekly off), Mon 26 (holiday), Tue 27.
export const calendar = new BusinessCalendar({
  timezone: TZ,
  shiftStart: '09:00',
  shiftEnd: '18:00',
  weeklyOff: [7],
  holidays: ['2026-01-26'],
});

export const orderWorkflowInput: WorkflowDefInput = {
  key: 'orders',
  name: 'Order to Delivery',
  stages: [
    { key: 'intake', name: 'Order Received', completion: { kind: 'on_create' } },
    {
      key: 'approval',
      name: 'Approval',
      responsibleGroups: ['manager'],
      planned: { mode: 'tat', base: { kind: 'previous_stage' }, tat: { kind: 'fixed', hours: 4 } },
      completion: { kind: 'conditions', when: { mode: 'all', conditions: [{ field: 'approved', op: 'is_true' }] } },
    },
    {
      key: 'dispatch',
      name: 'Dispatch',
      responsibleGroups: ['store'],
      planned: {
        mode: 'tat',
        base: { kind: 'previous_stage' },
        tat: { kind: 'by_field', field: 'priority', map: { Urgent: 2, Normal: 16 }, defaultHours: 8 },
      },
      completion: { kind: 'manual' },
    },
    {
      key: 'qc',
      name: 'Quality Check',
      applicableWhen: { mode: 'all', conditions: [{ field: 'needs_qc', op: 'is_true' }] },
      planned: { mode: 'tat', base: { kind: 'previous_stage' }, tat: { kind: 'fixed', hours: 2 } },
      completion: { kind: 'manual' },
    },
  ],
  fields: [
    { key: 'customer', label: 'Customer Name', type: 'text', stageKey: 'intake', required: true, searchKey: true },
    { key: 'email', label: 'Email', type: 'email', stageKey: 'intake', unique: true },
    { key: 'priority', label: 'Priority', type: 'select', stageKey: 'intake', options: ['Urgent', 'Normal', 'Low'] },
    { key: 'needs_qc', label: 'Needs QC', type: 'checkbox', stageKey: 'intake' },
    { key: 'qty', label: 'Qty', type: 'number', stageKey: 'intake', lineItem: true },
    { key: 'rate', label: 'Rate', type: 'number', stageKey: 'intake', lineItem: true },
    { key: 'amount', label: 'Amount', type: 'computed', stageKey: 'intake', lineItem: true, expression: 'round(qty * rate, 2)' },
    { key: 'approved', label: 'Approved', type: 'checkbox', stageKey: 'approval', editGroups: ['manager'] },
    { key: 'remarks', label: 'Manager Remarks', type: 'textarea', stageKey: 'approval', viewGroups: ['manager', 'store'], editGroups: ['manager'] },
  ],
};

export const orderWorkflow = workflowDefSchema.parse(orderWorkflowInput);
