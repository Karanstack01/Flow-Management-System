/**
 * Safe evaluator for `computed` fields — the common part of the legacy sheet formulas
 * (=Qty*Rate, =IF(…), =A&" "&B, =TODAY()-C). No eval / Function: a small recursive-descent parser
 * builds a tree that is then evaluated, so IF only evaluates the branch it takes.
 *
 * Grammar (lowest precedence first, like a spreadsheet):
 *   compare := concat (('=' | '==' | '<>' | '!=' | '<' | '<=' | '>' | '>=') concat)?
 *   concat  := add ('&' add)*
 *   add     := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '%') unary)*
 *   unary   := '-' unary | primary
 *   primary := number | "text" | 'text' | TRUE | FALSE | field_key | NAME(args) | '(' compare ')'
 *
 * A blank input used in arithmetic makes the result blank (as before: `qty * rate` stays empty
 * until both are filled). Text, comparisons and the IS / IF functions handle blanks themselves.
 */
import { DateTime } from 'luxon';
import type { FieldValue, RecordData } from './schema.js';

type Value = number | string | boolean | null;
type Node =
  | { k: 'lit'; v: Value }
  | { k: 'ref'; name: string }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node };
type Token = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };

export class FormulaError extends Error {}

export interface FormulaOptions {
  /** Business timezone for TODAY() / NOW() and date maths (default UTC). */
  timezone?: string;
  now?: Date;
}

/** Functions for the editor's help text, grouped. */
export const FORMULA_FUNCTIONS: { group: string; items: { name: string; example: string; hint: string }[] }[] = [
  {
    group: 'Numbers',
    items: [
      { name: 'ROUND', example: 'ROUND(qty * rate, 2)', hint: 'Round to N decimals' },
      { name: 'SUM', example: 'SUM(a, b, c)', hint: 'Add up (blanks count as 0)' },
      { name: 'AVERAGE', example: 'AVERAGE(a, b)', hint: 'Average of the filled values' },
      { name: 'MIN / MAX', example: 'MAX(a, b)', hint: 'Smallest / largest' },
      { name: 'ABS / CEIL / FLOOR / MOD', example: 'MOD(qty, 12)', hint: 'Absolute, round up / down, remainder' },
    ],
  },
  {
    group: 'Logic',
    items: [
      { name: 'IF', example: 'IF(amount > 50000, "Needs approval", "Auto")', hint: 'Pick a value by a condition' },
      { name: 'AND / OR / NOT', example: 'AND(paid, delivered)', hint: 'Combine conditions' },
      { name: 'ISBLANK', example: 'ISBLANK(remarks)', hint: 'True when the field is empty' },
      { name: 'COALESCE', example: 'COALESCE(phone, mobile, "—")', hint: 'First value that is filled' },
    ],
  },
  {
    group: 'Text',
    items: [
      { name: '&', example: 'first_name & " " & last_name', hint: 'Join text' },
      { name: 'TEXTJOIN', example: 'TEXTJOIN(", ", city, state)', hint: 'Join the filled values with a separator' },
      { name: 'UPPER / LOWER / TRIM / LEN', example: 'UPPER(code)', hint: 'Change case, trim spaces, length' },
      { name: 'LEFT / RIGHT', example: 'LEFT(name, 3)', hint: 'First / last N characters' },
      { name: 'CONTAINS', example: 'CONTAINS(remarks, "urgent")', hint: 'True when the text contains the part (any case)' },
      { name: 'TEXT', example: 'TEXT(amount, 2)', hint: 'A number as text with N decimals' },
    ],
  },
  {
    group: 'Dates',
    items: [
      { name: 'TODAY / NOW', example: 'TODAY()', hint: 'Today’s date / the current time' },
      { name: 'DAYS', example: 'DAYS(TODAY(), order_date)', hint: 'Days from the second date to the first' },
      { name: 'HOURS', example: 'HOURS(delivered_at, ordered_at)', hint: 'Clock hours between two times' },
      { name: 'ADDDAYS', example: 'ADDDAYS(order_date, 7)', hint: 'A date N days later' },
      { name: 'YEAR / MONTH / DAY', example: 'MONTH(order_date)', hint: 'Part of a date' },
    ],
  },
];

const COMPARE = ['=', '==', '<>', '!=', '<', '<=', '>', '>='];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new FormulaError(`Bad number at ${i + 1}`);
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
    } else if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) throw new FormulaError('Text is missing its closing quote');
      out.push({ t: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
    } else if (/[a-z_]/i.test(ch)) {
      const m = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else {
      const two = src.slice(i, i + 2);
      if (['<=', '>=', '<>', '!=', '=='].includes(two)) {
        out.push({ t: 'op', v: two });
        i += 2;
      } else if ('+-*/%(),&=<>'.includes(ch)) {
        out.push({ t: 'op', v: ch });
        i++;
      } else {
        throw new FormulaError(`Unexpected "${ch}" at ${i + 1}`);
      }
    }
  }
  return out;
}

function parse(expression: string): Node {
  const tokens = tokenize(expression);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const take = (v?: string) => {
    const tok = tokens[pos];
    if (!tok || (v !== undefined && !(tok.t === 'op' && tok.v === v))) throw new FormulaError(`Expected ${v ? `"${v}"` : 'more'}${tok ? ` before "${tok.v}"` : ' at the end'}`);
    pos++;
    return tok;
  };
  const primary = (): Node => {
    const tok = take();
    if (tok.t === 'num') return { k: 'lit', v: tok.v };
    if (tok.t === 'str') return { k: 'lit', v: tok.v };
    if (tok.t === 'op' && tok.v === '(') {
      const n = compare();
      take(')');
      return n;
    }
    if (tok.t === 'id') {
      if (isOp('(')) {
        take('(');
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(compare());
          while (isOp(',')) {
            take(',');
            args.push(compare());
          }
        }
        take(')');
        const name = tok.v.toUpperCase();
        if (!FUNCS[name]) throw new FormulaError(`Unknown function ${tok.v}`);
        return { k: 'call', name, args };
      }
      const low = tok.v.toLowerCase();
      if (low === 'true' || low === 'false') return { k: 'lit', v: low === 'true' };
      return { k: 'ref', name: tok.v };
    }
    throw new FormulaError(`Unexpected "${tok.v}"`);
  };
  const unary = (): Node => (isOp('-') ? (take('-'), { k: 'neg', a: unary() }) : primary());
  const binary = (next: () => Node, ops: string[]) => (): Node => {
    let n = next();
    while (peek()?.t === 'op' && ops.includes(peek()!.v as string)) {
      const op = take().v as string;
      n = { k: 'bin', op, a: n, b: next() };
    }
    return n;
  };
  const term = binary(unary, ['*', '/', '%']);
  const add = binary(term, ['+', '-']);
  const concat = binary(add, ['&']);
  const compare = (): Node => {
    const a = concat();
    if (peek()?.t === 'op' && COMPARE.includes(peek()!.v as string)) {
      const op = take().v as string;
      return { k: 'bin', op, a, b: concat() };
    }
    return a;
  };
  const root = compare();
  if (pos !== tokens.length) throw new FormulaError(`Unexpected "${tokens[pos]!.v}"`);
  return root;
}

// ------------------------------------------------------------------ evaluation
const blank = (v: unknown): v is null | undefined | '' => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const toText = (v: Value): string => (v === null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? String(Math.round(v * 1e10) / 1e10) : v);
const truthy = (v: Value): boolean => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : typeof v === 'string' ? !['', 'false', 'no', '0'].includes(v.trim().toLowerCase()) : false);
const numberOf = (v: Value): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/,/g, '')))) return Number(v.replace(/,/g, ''));
  return null;
};

interface Ctx {
  data: RecordData;
  zone: string;
  now: DateTime;
  /** A blank (or non-number) was used in arithmetic: the whole result is blank. */
  missing: boolean;
}

function dateOf(v: Value, ctx: Ctx): DateTime | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const d = DateTime.fromISO(v, { zone: ctx.zone });
  return d.isValid ? d : null;
}
const isDateOnly = (v: Value) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

type Fn = (ctx: Ctx, args: Node[]) => Value;
const values = (ctx: Ctx, args: Node[]) => args.map((a) => evalNode(a, ctx));
const num = (ctx: Ctx, v: Value): number => {
  const n = numberOf(v);
  if (n === null) ctx.missing = true;
  return n ?? 0;
};
const math = (f: (...n: number[]) => number): Fn => (ctx, args) => f(...values(ctx, args).map((v) => num(ctx, v)));
const text1 = (f: (s: string) => Value): Fn => (ctx, args) => f(toText(evalNode(args[0] ?? { k: 'lit', v: null }, ctx)));
const date1 = (f: (d: DateTime) => number): Fn => (ctx, args) => {
  const d = dateOf(evalNode(args[0] ?? { k: 'lit', v: null }, ctx), ctx);
  if (!d) return (ctx.missing = true), null;
  return f(d);
};
const between = (unit: 'days' | 'hours'): Fn => (ctx, args) => {
  const [a, b] = values(ctx, args);
  const end = dateOf(a ?? null, ctx);
  const start = dateOf(b ?? null, ctx);
  if (!end || !start) return (ctx.missing = true), null;
  if (unit === 'days') return Math.round(end.startOf('day').diff(start.startOf('day'), 'days').days);
  return Math.round(end.diff(start, 'hours').hours * 100) / 100;
};

const FUNCS: Record<string, Fn> = {
  // numbers (legacy names kept: round, min, max, abs, ceil, floor)
  ROUND: (ctx, args) => {
    const [x, d] = values(ctx, args);
    const f = 10 ** Math.max(0, Math.min(10, numberOf(d ?? 0) ?? 0));
    return Math.round((num(ctx, x ?? null) + Number.EPSILON) * f) / f;
  },
  MIN: math((...a) => Math.min(...a)),
  MAX: math((...a) => Math.max(...a)),
  ABS: math((x = 0) => Math.abs(x)),
  CEIL: math((x = 0) => Math.ceil(x)),
  FLOOR: math((x = 0) => Math.floor(x)),
  MOD: math((a = 0, b = 1) => a % b),
  SUM: (ctx, args) => values(ctx, args).reduce<number>((s, v) => s + (numberOf(v) ?? 0), 0),
  AVERAGE: (ctx, args) => {
    const ns = values(ctx, args).map(numberOf).filter((n): n is number => n !== null);
    return ns.length ? ns.reduce((s, n) => s + n, 0) / ns.length : ((ctx.missing = true), null);
  },
  // logic
  IF: (ctx, args) => (truthy(evalNode(args[0] ?? { k: 'lit', v: null }, ctx)) ? (args[1] ? evalNode(args[1], ctx) : true) : args[2] ? evalNode(args[2], ctx) : null),
  AND: (ctx, args) => args.every((a) => truthy(evalNode(a, ctx))),
  OR: (ctx, args) => args.some((a) => truthy(evalNode(a, ctx))),
  NOT: (ctx, args) => !truthy(evalNode(args[0] ?? { k: 'lit', v: null }, ctx)),
  ISBLANK: (ctx, args) => blank(evalNode(args[0] ?? { k: 'lit', v: null }, ctx)),
  COALESCE: (ctx, args) => {
    for (const a of args) {
      const v = evalNode(a, ctx);
      if (!blank(v)) return v;
    }
    return null;
  },
  // text
  CONCAT: (ctx, args) => values(ctx, args).map(toText).join(''),
  TEXTJOIN: (ctx, args) => {
    const [sep, ...rest] = values(ctx, args);
    return rest.filter((v) => !blank(v)).map(toText).join(toText(sep ?? ''));
  },
  UPPER: text1((s) => s.toUpperCase()),
  LOWER: text1((s) => s.toLowerCase()),
  TRIM: text1((s) => s.trim().replace(/\s+/g, ' ')),
  LEN: text1((s) => s.length),
  LEFT: (ctx, args) => {
    const [s, n] = values(ctx, args);
    return toText(s ?? null).slice(0, Math.max(0, numberOf(n ?? 1) ?? 1));
  },
  RIGHT: (ctx, args) => {
    const [s, n] = values(ctx, args);
    const t = toText(s ?? null);
    const k = Math.max(0, numberOf(n ?? 1) ?? 1);
    return k ? t.slice(-k) : '';
  },
  CONTAINS: (ctx, args) => {
    const [s, part] = values(ctx, args);
    return toText(s ?? null).toLowerCase().includes(toText(part ?? null).toLowerCase());
  },
  TEXT: (ctx, args) => {
    const [v, d] = values(ctx, args);
    const n = numberOf(v ?? null);
    return n === null ? toText(v ?? null) : n.toFixed(Math.max(0, Math.min(10, numberOf(d ?? 0) ?? 0)));
  },
  // dates
  TODAY: (ctx) => ctx.now.toISODate(),
  NOW: (ctx) => ctx.now.toUTC().toISO(),
  DAYS: between('days'),
  HOURS: between('hours'),
  ADDDAYS: (ctx, args) => {
    const [d, n] = values(ctx, args);
    const date = dateOf(d ?? null, ctx);
    if (!date) return (ctx.missing = true), null;
    const next = date.plus({ days: num(ctx, n ?? 0) });
    return isDateOnly(d ?? null) ? next.toISODate() : next.toUTC().toISO();
  },
  YEAR: date1((d) => d.year),
  MONTH: date1((d) => d.month),
  DAY: date1((d) => d.day),
};
// Alias
FUNCS.AVG = FUNCS.AVERAGE!;
FUNCS.IFBLANK = FUNCS.COALESCE!;

function compareValues(op: string, a: Value, b: Value): boolean {
  if (op === '==') op = '=';
  if (op === '!=') op = '<>';
  const na = numberOf(a);
  const nb = numberOf(b);
  if (na !== null && nb !== null && typeof a !== 'boolean' && typeof b !== 'boolean') {
    return op === '=' ? na === nb : op === '<>' ? na !== nb : op === '<' ? na < nb : op === '<=' ? na <= nb : op === '>' ? na > nb : na >= nb;
  }
  if (blank(a) || blank(b)) {
    const same = blank(a) && blank(b);
    return op === '=' ? same : op === '<>' ? !same : false;
  }
  // Text (and ISO dates, which sort as text) — equality ignores case like a spreadsheet.
  const sa = toText(a).toLowerCase();
  const sb = toText(b).toLowerCase();
  const c = sa < sb ? -1 : sa > sb ? 1 : 0;
  return op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
}

function evalNode(n: Node, ctx: Ctx): Value {
  switch (n.k) {
    case 'lit':
      return n.v;
    case 'ref': {
      const raw = ctx.data[n.name];
      if (blank(raw)) return null;
      if (Array.isArray(raw)) return raw.join(', ');
      return raw as Value;
    }
    case 'call':
      return FUNCS[n.name]!(ctx, n.args);
    case 'neg':
      return -num(ctx, evalNode(n.a, ctx));
    case 'bin': {
      if (COMPARE.includes(n.op)) return compareValues(n.op, evalNode(n.a, ctx), evalNode(n.b, ctx));
      if (n.op === '&') return toText(evalNode(n.a, ctx)) + toText(evalNode(n.b, ctx));
      const a = num(ctx, evalNode(n.a, ctx));
      const b = num(ctx, evalNode(n.b, ctx));
      return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : n.op === '/' ? a / b : a % b;
    }
  }
}

/** Field keys referenced by an expression (used to validate workflow definitions). */
export function formulaReferences(expression: string): string[] {
  const refs = new Set<string>();
  const walk = (n: Node) => {
    if (n.k === 'ref') refs.add(n.name);
    else if (n.k === 'call') n.args.forEach(walk);
    else if (n.k === 'neg') walk(n.a);
    else if (n.k === 'bin') (walk(n.a), walk(n.b));
  };
  walk(parse(expression));
  return [...refs];
}

/**
 * The value of a formula for one record: a number, text, TRUE / FALSE or blank (null). Blank when
 * an input it calculates with is still empty, or the result is not a finite number.
 */
export function evaluateFormula(expression: string, data: RecordData, opts: FormulaOptions = {}): FieldValue {
  const zone = opts.timezone ?? 'UTC';
  const ctx: Ctx = { data, zone, now: DateTime.fromJSDate(opts.now ?? new Date()).setZone(zone), missing: false };
  const v = evalNode(parse(expression), ctx);
  if (ctx.missing) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === '') return null;
  return v;
}

/** Check an expression without data (editor feedback); returns the error message or null. */
export function formulaError(expression: string): string | null {
  try {
    parse(expression);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
