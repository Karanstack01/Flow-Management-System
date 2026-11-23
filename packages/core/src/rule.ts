/**
 * Field validation rules — a small spreadsheet-style formula language, evaluated on the server
 * for every write (and in the editor's "Test formula"). No eval / Function: a tokenizer, a
 * recursive-descent parser that builds an AST, and a tree-walking evaluator, so IF only
 * evaluates the branch it takes.
 *
 *   =IF(qty > 100, "At most 100 units")      text result  → invalid, the text is the message
 *   =COUNT(value) >= 2                        TRUE / FALSE → valid / invalid
 *   =AND(NOT(ISBLANK(gst_no)), LEN(gst_no) = 15)
 *
 * Outcome: TRUE, a non-zero number, a non-empty list, blank (null) or "" are valid; FALSE, 0 or
 * an empty list are invalid with a generic message; any other text is invalid with that text.
 *
 * Names: field keys (`qty`), `value` (the field being validated) and upper-case record values
 * (`RECORD_NUMBER`, `CREATED_BY`, `CREATED_AT`, `CURRENT_STAGE`, `FLOW_NAME`).
 * Operators: + - * / % ^, & (join text), = == != <> < > <= >=, && ||, ! and unary minus.
 */
import type { RecordData } from './schema.js';

export type RuleValue = number | string | boolean | null | string[];

export class RuleError extends Error {
  constructor(
    message: string,
    readonly at?: number,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ catalogue (also drives the editor UI)
export interface RuleFunction {
  name: string;
  syntax: string;
  description: string;
  category: 'Logic' | 'Text' | 'Number' | 'Date' | 'List';
}

export const RULE_FUNCTIONS: RuleFunction[] = [
  { name: 'IF', syntax: 'IF(condition, then, [else])', description: 'Returns “then” when the condition holds, otherwise “else” (blank when left out).', category: 'Logic' },
  { name: 'AND', syntax: 'AND(a, b, …)', description: 'TRUE when every argument is true.', category: 'Logic' },
  { name: 'OR', syntax: 'OR(a, b, …)', description: 'TRUE when any argument is true.', category: 'Logic' },
  { name: 'NOT', syntax: 'NOT(a)', description: 'Reverses TRUE and FALSE.', category: 'Logic' },
  { name: 'ISBLANK', syntax: 'ISBLANK(x)', description: 'TRUE when x is empty (no text, no number, no files).', category: 'Logic' },
  { name: 'ISNUMBER', syntax: 'ISNUMBER(x)', description: 'TRUE when x is a number.', category: 'Logic' },
  { name: 'ISEMAIL', syntax: 'ISEMAIL(x)', description: 'TRUE when x looks like an email address.', category: 'Logic' },
  { name: 'IN', syntax: 'IN(x, a, b, …)', description: 'TRUE when x equals one of the listed values (case-insensitive).', category: 'Logic' },
  { name: 'LEN', syntax: 'LEN(text)', description: 'Number of characters (or of items, for a list).', category: 'Text' },
  { name: 'LOWER', syntax: 'LOWER(text)', description: 'Lower-case text.', category: 'Text' },
  { name: 'UPPER', syntax: 'UPPER(text)', description: 'Upper-case text.', category: 'Text' },
  { name: 'TRIM', syntax: 'TRIM(text)', description: 'Removes spaces at both ends.', category: 'Text' },
  { name: 'LEFT', syntax: 'LEFT(text, n)', description: 'The first n characters.', category: 'Text' },
  { name: 'RIGHT', syntax: 'RIGHT(text, n)', description: 'The last n characters.', category: 'Text' },
  { name: 'CONTAINS', syntax: 'CONTAINS(text, part)', description: 'TRUE when text contains part (case-insensitive). For a list: when it has that item.', category: 'Text' },
  { name: 'STARTSWITH', syntax: 'STARTSWITH(text, part)', description: 'TRUE when text starts with part (case-insensitive).', category: 'Text' },
  { name: 'ENDSWITH', syntax: 'ENDSWITH(text, part)', description: 'TRUE when text ends with part (case-insensitive).', category: 'Text' },
  { name: 'ISDIGITS', syntax: 'ISDIGITS(text)', description: 'TRUE when text is only the digits 0–9.', category: 'Text' },
  { name: 'ROUND', syntax: 'ROUND(x, [digits])', description: 'Rounds to the given decimals (0 by default).', category: 'Number' },
  { name: 'ABS', syntax: 'ABS(x)', description: 'Absolute value.', category: 'Number' },
  { name: 'MIN', syntax: 'MIN(a, b, …)', description: 'Smallest number.', category: 'Number' },
  { name: 'MAX', syntax: 'MAX(a, b, …)', description: 'Largest number.', category: 'Number' },
  { name: 'SUM', syntax: 'SUM(a, b, …)', description: 'Adds the numbers.', category: 'Number' },
  { name: 'TODAY', syntax: 'TODAY()', description: 'Today’s date (YYYY-MM-DD, UTC).', category: 'Date' },
  { name: 'NOW', syntax: 'NOW()', description: 'The current date and time (ISO).', category: 'Date' },
  { name: 'DAYS', syntax: 'DAYS(end, start)', description: 'Whole days from start to end (negative when end is earlier).', category: 'Date' },
  { name: 'COUNT', syntax: 'COUNT(x)', description: 'Number of items in a list (files, multi-select); 1 for any other non-empty value.', category: 'List' },
];

export const RULE_EXAMPLES: { title: string; rule: string }[] = [
  { title: 'Between two numbers', rule: '=AND(value >= 1, value <= 100)' },
  { title: 'Custom error message', rule: '=IF(value > 100, "At most 100 units per entry")' },
  { title: 'Exact length (e.g. GSTIN)', rule: '=IF(LEN(value) <> 15, "GSTIN must be 15 characters")' },
  { title: 'Digits only', rule: '=ISDIGITS(value)' },
  { title: 'Date not in the past', rule: '=IF(DAYS(value, TODAY()) < 0, "Pick today or a later date")' },
  { title: 'At least two files', rule: '=IF(COUNT(value) < 2, "Upload at least 2 files")' },
  { title: 'Required when another field says so', rule: '=IF(AND(status = "Rejected", ISBLANK(value)), "Give a reason for the rejection")' },
  { title: 'Not equal to another field', rule: '=IF(value = other_field, "Must differ from the other field")' },
];

/** Record-level names (upper case, so they never collide with lower_snake field keys). */
export const RULE_RECORD_VALUES: { name: string; label: string }[] = [
  { name: 'value', label: 'This field’s value' },
  { name: 'RECORD_NUMBER', label: 'Record number' },
  { name: 'CREATED_BY', label: 'Created by (email)' },
  { name: 'CREATED_AT', label: 'Created at' },
  { name: 'CURRENT_STAGE', label: 'Current stage' },
  { name: 'FLOW_NAME', label: 'Flow name' },
];

// ------------------------------------------------------------------ tokens
type Tok = { t: 'num'; v: number; at: number } | { t: 'str'; v: string; at: number } | { t: 'id'; v: string; at: number } | { t: 'op'; v: string; at: number };

const OPS = ['<>', '<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '^', '&', '=', '<', '>', '!', '(', ')', ','];
const MAX_LEN = 1000;

function tokenize(src: string): Tok[] {
  if (src.length > MAX_LEN) throw new RuleError(`A rule can be at most ${MAX_LEN} characters`);
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]), at: i });
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === '“' || ch === '”') {
      // "text" with "" as an escaped quote (spreadsheet style); curly quotes from pasted text are accepted.
      let s = '';
      let j = i + 1;
      for (;;) {
        if (j >= src.length) throw new RuleError('Text is missing its closing quote', i);
        const c = src[j]!;
        if (c === '"' || c === '”' || c === '“') {
          if (src[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          break;
        }
        s += c;
        j++;
      }
      out.push({ t: 'str', v: s, at: i });
      i = j + 1;
      continue;
    }
    if (/[a-z_]/i.test(ch)) {
      const m = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new RuleError(`Unexpected "${ch}"`, i);
    out.push({ t: 'op', v: op, at: i });
    i += op.length;
  }
  return out;
}

// ------------------------------------------------------------------ AST
type Node =
  | { k: 'lit'; v: RuleValue }
  | { k: 'name'; name: string; at: number }
  | { k: 'call'; fn: string; args: Node[]; at: number }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node };

const KEYWORDS: Record<string, RuleValue> = { true: true, false: false, null: null, blank: null };

export function parseRule(source: string): Node {
  const src = source.trim().replace(/^=/, '');
  const toks = tokenize(src);
  if (!toks.length) throw new RuleError('The rule is empty');
  let p = 0;
  const peek = () => toks[p];
  const isOp = (...v: string[]) => {
    const t = toks[p];
    return !!t && t.t === 'op' && v.includes(t.v);
  };
  const expect = (v: string) => {
    const t = toks[p];
    if (!t || t.t !== 'op' || t.v !== v) throw new RuleError(t ? `Expected "${v}" but found "${t.v}"` : `Expected "${v}" at the end`, t?.at ?? src.length);
    p++;
  };

  const or = (): Node => {
    let a = and();
    while (isOp('||')) {
      p++;
      a = { k: 'bin', op: '||', a, b: and() };
    }
    return a;
  };
  const and = (): Node => {
    let a = cmp();
    while (isOp('&&')) {
      p++;
      a = { k: 'bin', op: '&&', a, b: cmp() };
    }
    return a;
  };
  const cmp = (): Node => {
    let a = concat();
    while (isOp('=', '==', '!=', '<>', '<', '>', '<=', '>=')) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: 'bin', op: op === '==' ? '=' : op === '<>' ? '!=' : op, a, b: concat() };
    }
    return a;
  };
  const concat = (): Node => {
    let a = add();
    while (isOp('&')) {
      p++;
      a = { k: 'bin', op: '&', a, b: add() };
    }
    return a;
  };
  const add = (): Node => {
    let a = mul();
    while (isOp('+', '-')) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: 'bin', op, a, b: mul() };
    }
    return a;
  };
  const mul = (): Node => {
    let a = unary();
    while (isOp('*', '/', '%')) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: 'bin', op, a, b: unary() };
    }
    return a;
  };
  const unary = (): Node => {
    if (isOp('-', '!')) {
      const op = (toks[p++] as { v: string }).v;
      return { k: 'un', op, a: unary() };
    }
    return pow();
  };
  const pow = (): Node => {
    const a = primary();
    if (isOp('^')) {
      p++;
      return { k: 'bin', op: '^', a, b: unary() };
    }
    return a;
  };
  const primary = (): Node => {
    const t = peek();
    if (!t) throw new RuleError('The rule ends too early', src.length);
    p++;
    if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'op' && t.v === '(') {
      const e = or();
      expect(')');
      return e;
    }
    if (t.t === 'id') {
      if (isOp('(')) {
        const fn = t.v.toUpperCase();
        if (!FUNCS[fn]) throw new RuleError(`Unknown function ${t.v}()`, t.at);
        p++;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(or());
          while (isOp(',')) {
            p++;
            args.push(or());
          }
        }
        expect(')');
        const [min, max] = ARITY[fn] ?? [0, 99];
        if (args.length < min || args.length > max) throw new RuleError(`${fn}() takes ${min === max ? min : `${min}–${max === 99 ? 'any' : max}`} argument${max === 1 ? '' : 's'}`, t.at);
        return { k: 'call', fn, args, at: t.at };
      }
      if (t.v.toLowerCase() in KEYWORDS) return { k: 'lit', v: KEYWORDS[t.v.toLowerCase()]! };
      return { k: 'name', name: t.v, at: t.at };
    }
    throw new RuleError(`Unexpected "${t.v}"`, t.at);
  };

  const tree = or();
  if (p < toks.length) throw new RuleError(`Unexpected "${toks[p]!.v}"`, toks[p]!.at);
  return tree;
}

/** Names a rule reads (field keys, `value`, record values), in order of first use. */
export function ruleReferences(source: string): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    if (n.k === 'name') out.add(n.name);
    else if (n.k === 'call') n.args.forEach(walk);
    else if (n.k === 'un') walk(n.a);
    else if (n.k === 'bin') (walk(n.a), walk(n.b));
  };
  walk(parseRule(source));
  return [...out];
}

// ------------------------------------------------------------------ evaluation
export interface RuleContext {
  data: RecordData;
  /** The value of the field being validated (`value`). */
  value?: RuleValue | undefined;
  record?: { RECORD_NUMBER?: number | null; CREATED_BY?: string | null; CREATED_AT?: string | null; CURRENT_STAGE?: string | null; FLOW_NAME?: string | null };
  now?: Date;
}

const isBlank = (v: RuleValue): boolean => v === null || v === '' || (Array.isArray(v) && v.length === 0);
const toNum = (v: RuleValue): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || Array.isArray(v)) return Array.isArray(v) ? v.length : 0;
  const n = Number(v.replace(/,/g, '').trim());
  return v.trim() === '' || !Number.isFinite(n) ? NaN : n;
};
const toStr = (v: RuleValue): string => (v === null ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
const truthy = (v: RuleValue): boolean => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 && !Number.isNaN(v) : Array.isArray(v) ? v.length > 0 : v === null ? false : !['', 'false', '0'].includes(v.trim().toLowerCase()));
const numeric = (v: RuleValue) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/,/g, ''))));

function compare(a: RuleValue, b: RuleValue): number {
  if (isBlank(a) && isBlank(b)) return 0;
  if (numeric(a) && numeric(b)) return toNum(a) - toNum(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(truthy(a)) - Number(truthy(b));
  return toStr(a).toLowerCase().localeCompare(toStr(b).toLowerCase());
}

const dayMs = 86_400_000;
const toDay = (v: RuleValue): number => {
  const s = toStr(v);
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(t)) throw new RuleError(`"${s}" is not a date`);
  return Math.floor(t / dayMs);
};

const ARITY: Record<string, [number, number]> = {
  IF: [2, 3], NOT: [1, 1], ISBLANK: [1, 1], ISNUMBER: [1, 1], ISEMAIL: [1, 1], IN: [2, 99], LEN: [1, 1], LOWER: [1, 1], UPPER: [1, 1], TRIM: [1, 1],
  LEFT: [2, 2], RIGHT: [2, 2], CONTAINS: [2, 2], STARTSWITH: [2, 2], ENDSWITH: [2, 2], ISDIGITS: [1, 1], ROUND: [1, 2], ABS: [1, 1], MIN: [1, 99], MAX: [1, 99],
  SUM: [1, 99], TODAY: [0, 0], NOW: [0, 0], DAYS: [2, 2], COUNT: [1, 1], AND: [1, 99], OR: [1, 99],
};

type Fn = (args: Node[], ev: (n: Node) => RuleValue, ctx: RuleContext) => RuleValue;
const strict = (f: (...v: RuleValue[]) => RuleValue): Fn => (args, ev) => f(...args.map(ev));

const FUNCS: Record<string, Fn> = {
  IF: (a, ev) => (truthy(ev(a[0]!)) ? ev(a[1]!) : a[2] ? ev(a[2]) : null),
  AND: (a, ev) => a.every((x) => truthy(ev(x))),
  OR: (a, ev) => a.some((x) => truthy(ev(x))),
  NOT: strict((x) => !truthy(x)),
  ISBLANK: strict((x) => isBlank(x)),
  ISNUMBER: strict((x) => numeric(x)),
  ISEMAIL: strict((x) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(toStr(x).trim())),
  IN: strict((x, ...list) => list.some((y) => compare(x, y) === 0)),
  LEN: strict((x) => (Array.isArray(x) ? x.length : toStr(x).length)),
  LOWER: strict((x) => toStr(x).toLowerCase()),
  UPPER: strict((x) => toStr(x).toUpperCase()),
  TRIM: strict((x) => toStr(x).trim()),
  LEFT: strict((x, n) => toStr(x).slice(0, Math.max(0, toNum(n)))),
  RIGHT: strict((x, n) => (toNum(n) > 0 ? toStr(x).slice(-toNum(n)) : '')),
  CONTAINS: strict((x, part) => (Array.isArray(x) ? x.some((i) => compare(i, part) === 0) : toStr(x).toLowerCase().includes(toStr(part).toLowerCase()))),
  STARTSWITH: strict((x, part) => toStr(x).toLowerCase().startsWith(toStr(part).toLowerCase())),
  ENDSWITH: strict((x, part) => toStr(x).toLowerCase().endsWith(toStr(part).toLowerCase())),
  ISDIGITS: strict((x) => /^\d+$/.test(toStr(x))),
  ROUND: strict((x, d) => {
    const f = 10 ** (d === undefined ? 0 : toNum(d));
    return Math.round((toNum(x) + Number.EPSILON) * f) / f;
  }),
  ABS: strict((x) => Math.abs(toNum(x))),
  MIN: strict((...v) => Math.min(...v.map(toNum))),
  MAX: strict((...v) => Math.max(...v.map(toNum))),
  SUM: strict((...v) => v.reduce<number>((s, x) => s + (isBlank(x) ? 0 : toNum(x)), 0)),
  TODAY: (_a, _ev, ctx) => (ctx.now ?? new Date()).toISOString().slice(0, 10),
  NOW: (_a, _ev, ctx) => (ctx.now ?? new Date()).toISOString(),
  DAYS: strict((end, start) => (isBlank(end) || isBlank(start) ? null : toDay(end) - toDay(start))),
  COUNT: strict((x) => (Array.isArray(x) ? x.length : isBlank(x) ? 0 : 1)),
};

const asRuleValue = (v: unknown): RuleValue => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => String(x));
  return String(v);
};

export function evaluateRule(source: string, ctx: RuleContext): RuleValue {
  const tree = parseRule(source);
  let steps = 0;
  const ev = (n: Node): RuleValue => {
    if (++steps > 10_000) throw new RuleError('The rule is too complex');
    switch (n.k) {
      case 'lit':
        return n.v;
      case 'name': {
        if (n.name === 'value') return asRuleValue(ctx.value);
        if (/^[A-Z][A-Z_]*$/.test(n.name) && ctx.record && n.name in ctx.record) return asRuleValue(ctx.record[n.name as keyof NonNullable<RuleContext['record']>]);
        if (RULE_RECORD_VALUES.some((r) => r.name === n.name)) return null;
        if (!(n.name in ctx.data)) {
          const key = Object.keys(ctx.data).find((k) => k.toLowerCase() === n.name.toLowerCase());
          return key ? asRuleValue(ctx.data[key]) : null;
        }
        return asRuleValue(ctx.data[n.name]);
      }
      case 'call':
        return FUNCS[n.fn]!(n.args, ev, ctx);
      case 'un': {
        const a = ev(n.a);
        return n.op === '!' ? !truthy(a) : -toNum(a);
      }
      case 'bin': {
        if (n.op === '&&') return truthy(ev(n.a)) && truthy(ev(n.b));
        if (n.op === '||') return truthy(ev(n.a)) || truthy(ev(n.b));
        const a = ev(n.a);
        const b = ev(n.b);
        switch (n.op) {
          case '&':
            return toStr(a) + toStr(b);
          case '=':
            return compare(a, b) === 0;
          case '!=':
            return compare(a, b) !== 0;
          case '<':
            return compare(a, b) < 0;
          case '>':
            return compare(a, b) > 0;
          case '<=':
            return compare(a, b) <= 0;
          case '>=':
            return compare(a, b) >= 0;
        }
        const x = toNum(a);
        const y = toNum(b);
        const r = n.op === '+' ? x + y : n.op === '-' ? x - y : n.op === '*' ? x * y : n.op === '/' ? x / y : n.op === '%' ? x % y : x ** y;
        return Number.isFinite(r) ? r : null;
      }
    }
  };
  return ev(tree);
}

export type RuleOutcome = { ok: true; result: RuleValue } | { ok: false; result: RuleValue; message: string };

/** Run a validation rule and turn its result into valid / invalid (+ message). Syntax errors throw RuleError. */
export function checkRule(source: string, ctx: RuleContext, label = 'This field'): RuleOutcome {
  const result = evaluateRule(source, ctx);
  if (result === null || result === '') return { ok: true, result };
  if (typeof result === 'string') {
    const t = result.trim().toLowerCase();
    if (t === 'true' || t === 'ok' || t === 'valid') return { ok: true, result };
    return t === 'false' ? { ok: false, result, message: `${label} is not valid` } : { ok: false, result, message: result.slice(0, 300) };
  }
  return truthy(result) ? { ok: true, result } : { ok: false, result, message: `${label} is not valid` };
}
