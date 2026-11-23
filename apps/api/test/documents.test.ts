import { describe, expect, it } from 'vitest';
import { documentConfigSchema, documentFileName, type FieldDef } from '@fms/core';
import { renderDocument } from '../src/lib/docgen.js';
import { parseHtml } from '../src/lib/pdf.js';

const field = (key: string, label: string, type: FieldDef['type'] = 'text'): FieldDef => ({ key, label, type, stageKey: 'intake', required: false, unique: false, hidden: false, searchKey: false, frozen: false, lineItem: false, viewGroups: ['ALL'], editGroups: ['ALL'] });
const fields = [field('customer', 'Customer'), field('amount', 'Amount', 'number'), field('quote_file', 'Quote', 'file')];
const ctx = { fields, data: { customer: 'Acme <Ltd>', amount: 1250 }, extra: { record_number: 42, record_title: 'Acme', workflow_name: 'Orders' } };

describe('document steps', () => {
  it('parses the editor HTML into styled blocks, lists and tables', () => {
    const blocks = parseHtml('<h1 style="text-align:center">Quote</h1><p>Dear <b>Acme</b>, <span style="color: rgb(255, 0, 0)">red</span></p><ul><li>One</li><li>Two</li></ul><table><tr><th>A</th><td>1</td></tr></table>');
    expect(blocks[0]).toMatchObject({ kind: 'text', align: 'center', runs: [{ text: 'Quote', bold: true, size: 22 }] });
    expect(blocks[1]).toMatchObject({ kind: 'text', runs: [{ text: 'Dear ' }, { text: 'Acme', bold: true }, { text: ', ' }, { text: 'red', color: '#ff0000' }] });
    expect(blocks.filter((b) => b.kind === 'text' && b.bullet === '•')).toHaveLength(2);
    expect(blocks.at(-1)).toMatchObject({ kind: 'table', rows: [{ cells: [{ header: true }, { header: false }] }] });
  });

  it('generates a real PDF with the record values filled in', async () => {
    const cfg = documentConfigSchema.parse({ fieldKey: 'quote_file', fileName: 'Quote {{record_number}} {{customer}}', body: '<h2>Quote for {{customer}}</h2><p>Amount: <b>{{amount}}</b> ₹</p>', orientation: 'landscape' });
    const doc = await renderDocument(cfg, ctx);
    expect(doc.mimeType).toBe('application/pdf');
    expect(doc.fileName).toBe('Quote 42 Acme Ltd .pdf'.replace(' .', '.'));
    expect(doc.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(doc.buffer.length).toBeGreaterThan(800);
    expect(doc.buffer.toString('latin1')).toMatch(/\/MediaBox \[0 0 841\.\d+ 595\.\d+\]/); // A4 landscape
  });

  it('generates a Word document with escaped values, and an all-fields table', async () => {
    const cfg = documentConfigSchema.parse({ fieldKey: 'quote_file', format: 'doc', source: 'all_fields' });
    const doc = await renderDocument(cfg, ctx);
    const html = doc.buffer.toString('utf8');
    expect(doc.mimeType).toBe('application/msword');
    expect(doc.fileName).toBe('Document 42.doc');
    expect(html).toContain('<th align="left">Customer</th><td>Acme &lt;Ltd&gt;</td>');
    expect(html).not.toContain('Quote</th>'); // the document's own file field is left out
  });

  it('keeps file names safe', () => {
    expect(documentFileName({ fileName: 'a/b:c*{{x}}.pdf', format: 'pdf' }, { fields: [field('x', 'X')], data: { x: '../evil' } })).toBe('a b c .. evil.pdf');
  });
});
