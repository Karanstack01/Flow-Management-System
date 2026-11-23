import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/csv.js';
import { convertDataRows, convertSettings } from '../src/convert.js';

/**
 * A miniature legacy Settings tab: columns A..T (index 0..19).
 *   A col | B label | C flags | D type | E source | F stage name | G stage no | H deps | I hours |
 *   J bg | K qtype | L font | M notify | N view | O edit | P width | Q | R | S stage list name | T stage list no
 */
const row = (cells: Record<number, string>) => Array.from({ length: 20 }, (_, i) => cells[i] ?? '');
const settings: string[][] = [
  row({ 1: 'Header', 18: 'Stage', 19: 'No' }),
  row({ 0: '1', 1: 'Timestamp', 3: 'TS_Data', 6: '1', 18: 'Enquiry', 19: '1' }),
  row({ 0: '2', 1: 'Customer Name', 2: 'REQUIRED,SEARCHKEY', 3: 'text', 6: '1', 18: 'Quotation', 19: '2' }),
  row({ 0: '3', 1: 'Priority', 3: 'dropdown_Itm', 4: "'Urgent,Normal'", 6: '1', 18: 'Follow up', 19: '3' }),
  row({ 0: '4', 1: 'Brochure', 3: 'file', 6: '1' }),
  row({ 0: '5', 1: 'Planned', 3: 'TS_TAT', 6: '2', 7: '1:TIME,3:CONDITION', 8: '{"Urgent":2,"Normal":8}', 9: '#ff9900', 12: 'sales' }),
  row({ 0: '6', 1: 'Quote Sent', 3: 'dropdown_Itm', 4: 'Yes,No', 6: '2', 13: 'SALES', 14: 'SALES' }),
  row({ 0: '7', 1: 'Actual', 3: 'TS_Data', 6: '2', 7: '6:Yes' }),
  row({ 0: '8', 1: 'Planned 3', 3: 'TS_TAT', 6: '3', 7: '7:TIME,2:NOT NULL', 8: '24', 12: 'Sales, Manager' }),
  row({ 0: '9', 1: 'Actual 3', 3: 'TS_Data', 6: '3' }),
  row({ 0: '10', 1: 'Total', 3: 'formula', 6: '1' }),
];

describe('convertSettings', () => {
  const r = convertSettings(settings, { key: 'enquiries', name: 'Enquiries' });

  it('builds sequential stages from the S:T list', () => {
    expect(r.definition.stages.map((s) => s.key)).toEqual(['enquiry', 'quotation', 'follow_up']);
    expect(r.definition.stages[0]!.completion).toEqual({ kind: 'on_create' });
  });

  it('translates TAT maps keyed by a CONDITION column and TIME bases', () => {
    const q = r.definition.stages[1]!;
    expect(q.planned).toEqual({ mode: 'tat', base: { kind: 'previous_stage' }, tat: { kind: 'by_field', field: 'priority', map: { Urgent: 2, Normal: 8 } } });
    expect(q.completion).toEqual({ kind: 'conditions', when: { mode: 'all', conditions: [{ field: 'quote_sent', op: 'eq', value: 'Yes' }] } });
    expect(q.responsibleGroups).toEqual(['SALES']);
    expect(q.color).toBe('#ff9900');
  });

  it('turns field conditions on planned columns into applicability and drops timeline refs', () => {
    const f = r.definition.stages[2]!;
    expect(f.planned).toEqual({ mode: 'tat', base: { kind: 'previous_stage' }, tat: { kind: 'fixed', hours: 24 } });
    expect(f.applicableWhen).toEqual({ mode: 'all', conditions: [{ field: 'customer_name', op: 'not_empty' }] });
    expect(f.completion).toEqual({ kind: 'manual' });
    expect(f.responsibleGroups).toEqual(['SALES', 'MANAGER']);
  });

  it('maps field flags, options, file links and formulas', () => {
    const byKey = Object.fromEntries(r.definition.fields.map((f) => [f.key, f]));
    expect(byKey.customer_name).toMatchObject({ required: true, searchKey: true, viewGroups: ['ALL'] });
    expect(byKey.priority!.options).toEqual(['Urgent', 'Normal']);
    expect(byKey.brochure_legacy_links).toMatchObject({ type: 'textarea', editGroups: [] });
    expect(byKey.total).toMatchObject({ type: 'text', editGroups: [] });
    expect(r.warnings.some((w) => w.includes('sheet formula'))).toBe(true);
  });

  it('imports data rows with planned/actual times', () => {
    const data = parseCsv(
      'Record #,Timestamp,Customer Name,Priority,Brochure,Planned,Quote Sent,Actual\r\n' +
        '7,22/Jan/2026 10:00,Acme,Urgent,https://drive.google.com/x,22/Jan/2026 12:00,Yes,22/Jan/2026 11:30\r\n' +
        ',,"ignored, no number",,,,,\r\n',
    );
    const { records } = convertDataRows(data, r, { timezone: 'Asia/Kolkata', dateOrder: 'dmy' });
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.number).toBe(7);
    expect(rec.data).toMatchObject({ customer_name: 'Acme', priority: 'Urgent', brochure: [], brochure_legacy_links: 'https://drive.google.com/x', quote_sent: 'Yes' });
    expect(rec.createdAt.toISOString()).toBe('2026-01-22T04:30:00.000Z');
    expect(rec.stages.get('quotation')!.actualAt!.toISOString()).toBe('2026-01-22T06:00:00.000Z');
  });
});

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, newlines in cells and BOM', () => {
    expect(parseCsv('﻿a,"b ""x"", y","line1\nline2"\r\n1,2,3')).toEqual([
      ['a', 'b "x", y', 'line1\nline2'],
      ['1', '2', '3'],
    ]);
  });
});
