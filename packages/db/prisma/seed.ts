/**
 * Seed: one organization, an admin, a few groups, a business calendar and a sample
 * "Order to Delivery" workflow equivalent to a typical legacy FMS sheet.
 * Idempotent — safe to run repeatedly.
 */
import { hash } from '@node-rs/argon2';
import { BUILT_IN_TEMPLATES, workflowDefSchema, workflowSettingsSchema, type WorkflowDefInput } from '@fms/core';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const sampleWorkflow: WorkflowDefInput = {
  key: 'orders',
  name: 'Order to Delivery',
  description: 'Sample flow: order intake → approval → production → dispatch → payment follow-up',
  stages: [
    { key: 'intake', name: 'Order Received', color: '#2563eb', completion: { kind: 'on_create' } },
    {
      key: 'approval',
      name: 'Approval',
      color: '#7c3aed',
      responsibleGroups: ['MANAGER'],
      planned: { mode: 'tat', base: { kind: 'previous_stage' }, tat: { kind: 'by_field', field: 'priority', map: { Urgent: 2, Normal: 8 }, defaultHours: 8 } },
      completion: { kind: 'conditions', when: { mode: 'any', conditions: [{ field: 'approval_status', op: 'in', value: ['Approved', 'Rejected'] }] } },
    },
    {
      key: 'production',
      name: 'Production',
      color: '#ea580c',
      responsibleGroups: ['PRODUCTION'],
      applicableWhen: { mode: 'all', conditions: [{ field: 'approval_status', op: 'eq', value: 'Approved' }] },
      planned: { mode: 'tat', base: { kind: 'previous_stage' }, tat: { kind: 'fixed', hours: 24 } },
      completion: { kind: 'manual' },
    },
    {
      key: 'dispatch',
      name: 'Dispatch',
      color: '#0891b2',
      responsibleGroups: ['STORE'],
      applicableWhen: { mode: 'all', conditions: [{ field: 'approval_status', op: 'eq', value: 'Approved' }] },
      planned: { mode: 'tat', base: { kind: 'previous_stage' }, tat: { kind: 'fixed', hours: 4 } },
      completion: { kind: 'conditions', when: { mode: 'all', conditions: [{ field: 'dispatch_no', op: 'not_empty' }] } },
    },
    {
      key: 'payment',
      name: 'Payment Follow-up',
      color: '#16a34a',
      responsibleGroups: ['ACCOUNTS'],
      applicableWhen: { mode: 'all', conditions: [{ field: 'approval_status', op: 'eq', value: 'Approved' }] },
      planned: { mode: 'tat', base: { kind: 'field', field: 'due_date' }, tat: { kind: 'fixed', hours: 0 } },
      completion: { kind: 'conditions', when: { mode: 'all', conditions: [{ field: 'payment_received', op: 'is_true' }] } },
    },
  ],
  fields: [
    { key: 'customer', label: 'Customer Name', type: 'text', stageKey: 'intake', required: true, searchKey: true, frozen: true },
    { key: 'customer_email', label: 'Customer Email', type: 'email', stageKey: 'intake' },
    { key: 'customer_phone', label: 'Customer Phone', type: 'phone', stageKey: 'intake' },
    { key: 'city', label: 'City', type: 'select', stageKey: 'intake', optionSetKey: 'cities', required: true },
    { key: 'priority', label: 'Priority', type: 'select', stageKey: 'intake', options: ['Urgent', 'Normal'], required: true },
    { key: 'due_date', label: 'Payment Due Date', type: 'date', stageKey: 'intake' },
    { key: 'po_file', label: 'PO Attachment', type: 'file', stageKey: 'intake' },
    { key: 'entered_by', label: 'Entered By', type: 'user-email', stageKey: 'intake' },
    { key: 'product', label: 'Product', type: 'select', stageKey: 'intake', lineItem: true, required: true, options: ['Widget A', 'Widget B', 'Widget C'] },
    { key: 'qty', label: 'Qty', type: 'number', stageKey: 'intake', lineItem: true, required: true },
    { key: 'rate', label: 'Rate', type: 'number', stageKey: 'intake', lineItem: true, required: true },
    { key: 'amount', label: 'Amount', type: 'computed', stageKey: 'intake', lineItem: true, expression: 'round(qty * rate, 2)' },
    { key: 'approval_status', label: 'Approval Status', type: 'select', stageKey: 'approval', options: ['Approved', 'Rejected'], editGroups: ['MANAGER'] },
    { key: 'approval_remarks', label: 'Approval Remarks', type: 'textarea', stageKey: 'approval', editGroups: ['MANAGER'] },
    { key: 'batch_no', label: 'Batch No.', type: 'text', stageKey: 'production', editGroups: ['PRODUCTION'] },
    { key: 'dispatch_no', label: 'Dispatch / LR No.', type: 'text', stageKey: 'dispatch', editGroups: ['STORE'], unique: true },
    { key: 'dispatch_date', label: 'Dispatch Date', type: 'datetime', stageKey: 'dispatch', editGroups: ['STORE'] },
    { key: 'payment_received', label: 'Payment Received', type: 'checkbox', stageKey: 'payment', editGroups: ['ACCOUNTS'], viewGroups: ['ACCOUNTS', 'MANAGER'] },
  ],
};

async function main() {
  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com').toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026';

  const org = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { name: 'Default Organization', slug: 'default' },
  });

  const groupSpecs: Array<[string, string, string[]]> = [
    ['ADMINS', 'Full administrative access', ['ADMIN']],
    ['SALES', 'Creates orders', ['CREATE', 'EXPORT']],
    ['MANAGER', 'Approves orders', ['DELETE', 'EXPORT']],
    ['PRODUCTION', 'Production team', []],
    ['STORE', 'Dispatch team', []],
    ['ACCOUNTS', 'Collections', ['EXPORT']],
  ];
  const groups = new Map<string, string>();
  for (const [name, description, capabilities] of groupSpecs) {
    const g = await prisma.group.upsert({
      where: { orgId_name: { orgId: org.id, name } },
      update: { capabilities },
      create: { orgId: org.id, name, description, capabilities },
    });
    groups.set(name, g.id);
  }

  // The seed admin is the platform super admin (owner of every organization).
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: { isSuperAdmin: true },
    create: { orgId: org.id, email: adminEmail, name: 'Administrator', passwordHash: await hash(adminPassword), isSuperAdmin: true },
  });
  await prisma.userGroup.upsert({
    where: { userId_groupId: { userId: admin.id, groupId: groups.get('ADMINS')! } },
    update: {},
    create: { userId: admin.id, groupId: groups.get('ADMINS')! },
  });

  const calendar =
    (await prisma.businessCalendar.findFirst({ where: { orgId: org.id, name: 'Head Office' } })) ??
    (await prisma.businessCalendar.create({
      data: {
        orgId: org.id,
        name: 'Head Office',
        timezone: 'Asia/Kolkata',
        shiftStart: '09:30',
        shiftEnd: '18:30',
        weeklyOff: [7],
        holidays: {
          create: [
            { date: '2027-01-26', name: 'Republic Day' },
            { date: '2027-08-15', name: 'Independence Day' },
            { date: '2027-10-02', name: 'Gandhi Jayanti' },
          ],
        },
      },
    }));

  await prisma.optionSet.upsert({
    where: { orgId_key: { orgId: org.id, key: 'cities' } },
    update: {},
    create: { orgId: org.id, key: 'cities', name: 'Cities', options: ['Delhi', 'Mumbai', 'Bengaluru', 'Kolkata', 'Chennai', 'Pune'] },
  });

  const definition = workflowDefSchema.parse(sampleWorkflow);
  const settings = workflowSettingsSchema.parse({ upcoming: { enabled: true, hoursBefore: 1 } });
  const existing = await prisma.workflow.findUnique({ where: { orgId_key: { orgId: org.id, key: definition.key } } });
  if (!existing) {
    await prisma.workflow.create({
      data: {
        orgId: org.id,
        key: definition.key,
        name: definition.name,
        description: definition.description,
        definition: definition as object,
        settings: settings as object,
        calendarId: calendar.id,
        label: 'Sales',
        createdById: admin.id,
        versions: { create: { version: 1, definition: definition as object, settings: settings as object, createdById: admin.id } },
      },
    });
  }

  // Global template library (idempotent: refreshed from @fms/core on every seed).
  for (const t of BUILT_IN_TEMPLATES) {
    const def = workflowDefSchema.parse(t.definition);
    const set = workflowSettingsSchema.parse(t.settings ?? {});
    const data = { name: t.name, description: t.description, category: t.category, definition: def as object, settings: set as object };
    await prisma.workflowTemplate.upsert({ where: { builtInKey: t.key }, update: data, create: { builtInKey: t.key, orgId: null, ...data } });
  }

  console.log(`Seed complete. Sign in as ${adminEmail} (super admin). ${BUILT_IN_TEMPLATES.length} templates available.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
