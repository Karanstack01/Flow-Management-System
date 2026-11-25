import { describe, expect, it } from 'vitest';
import { reportsPdf } from '../src/jobs/reports.js';

describe('scheduled report PDF', () => {
  it('renders sections into a PDF, across pages when long', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`#${1000 + i}`, `Customer ${i}`, 'Dispatch', '24 Nov 2026, 10:00', `${i} h late`]);
    const buf = await reportsPdf('Orders — reports', '25 Nov 2026, 09:00', [
      { kind: 'pending', title: 'Pending tasks', headers: ['Record', 'Title', 'Step', 'Due', 'Delay'], rows, htmlRows: rows, line: '' },
      { kind: 'missing', title: 'Fields still empty', headers: ['Record', 'Step', 'Still empty'], rows: [], htmlRows: [], line: '' },
    ]);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    // 120 rows do not fit on one landscape page.
    expect((buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });
});
