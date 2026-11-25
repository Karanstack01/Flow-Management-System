import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/pages/records/ExportImport';

describe('CSV import parser', () => {
  it('reads quotes, escaped quotes, commas and line breaks inside cells', () => {
    const csv = '﻿Name,Remarks,Qty\r\n"Acme, Inc.","He said ""rush""\nby Friday",5\r\nBeta Ltd,,2\r\n\r\n';
    expect(parseCsv(csv)).toEqual([
      ['Name', 'Remarks', 'Qty'],
      ['Acme, Inc.', 'He said "rush"\nby Friday', '5'],
      ['Beta Ltd', '', '2'],
    ]);
  });

  it('detects semicolon and tab separated files', () => {
    expect(parseCsv('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});
