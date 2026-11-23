/**
 * Safe arithmetic evaluator for `computed` fields (replaces legacy sheet formulas
 * such as =Qty*Rate). No eval / Function — a tiny recursive-descent parser.
 *
 * Grammar: expr := term (('+'|'-') term)* ; term := unary (('*'|'/'|'%') unary)* ;
 *          unary := '-' unary | primary ; primary := number | identifier | call | '(' expr ')'
 * Functions: round(x[, digits]), min(...), max(...), abs(x), ceil(x), floor(x)
 */
import type { RecordData } from './schema.js';

type Token = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

const FUNCS: Record<string, (...a: number[]) => number> = {
  round: (x = 0, d = 0) => {
    const f = 10 ** d;
    return Math.round((x + Number.EPSILON) * f) / f;
  },
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  abs: (x = 0) => Math.abs(x),
  ceil: (x = 0) => Math.ceil(x),
  floor: (x = 0) => Math.floor(x),
};

export class FormulaError extends Error {}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new FormulaError(`Bad number at ${i}`);
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
    } else if (/[a-z_]/i.test(ch)) {
      const m = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else if ('+-*/%(),'.includes(ch)) {
      out.push({ t: 'op', v: ch });
      i++;
    } else {
      throw new FormulaError(`Unexpected "${ch}" at ${i}`);
    }
  }
  return out;
}

/** Field keys referenced by an expression (used to validate workflow definitions). */
export function formulaReferences(expression: string): string[] {
  const tokens = tokenize(expression);
  return [...new Set(tokens.filter((t, i) => t.t === 'id' && tokens[i + 1]?.v !== '(').map((t) => t.v as string))];
}

export function evaluateFormula(expression: string, data: RecordData): number | null {
  const tokens = tokenize(expression);
  let pos = 0;
  let missing = false;
  const peek = () => tokens[pos];
  const take = (v?: string) => {
    const tok = tokens[pos];
    if (!tok || (v !== undefined && tok.v !== v)) throw new FormulaError(`Expected ${v ?? 'token'}`);
    pos++;
    return tok;
  };

  const primary = (): number => {
    const tok = take();
    if (tok.t === 'num') return tok.v;
    if (tok.t === 'op' && tok.v === '(') {
      const v = expr();
      take(')');
      return v;
    }
    if (tok.t === 'id') {
      if (peek()?.v === '(') {
        const fn = FUNCS[tok.v.toLowerCase()];
        if (!fn) throw new FormulaError(`Unknown function ${tok.v}`);
        take('(');
        const args: number[] = [];
        if (peek()?.v !== ')') {
          args.push(expr());
          while (peek()?.v === ',') {
            take(',');
            args.push(expr());
          }
        }
        take(')');
        return fn(...args);
      }
      const raw = data[tok.v];
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(n)) missing = true;
      return Number.isFinite(n) ? n : 0;
    }
    throw new FormulaError(`Unexpected ${tok.v}`);
  };
  const unary = (): number => {
    if (peek()?.v === '-') {
      take('-');
      return -unary();
    }
    return primary();
  };
  const term = (): number => {
    let v = unary();
    while (peek() && ['*', '/', '%'].includes(peek()!.v as string)) {
      const op = take().v;
      const r = unary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (peek() && ['+', '-'].includes(peek()!.v as string)) {
      const op = take().v;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };

  const result = expr();
  if (pos !== tokens.length) throw new FormulaError(`Unexpected ${tokens[pos]!.v}`);
  if (missing || !Number.isFinite(result)) return null;
  return result;
}
