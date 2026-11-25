/**
 * Compiles the condition DSL into parameterised SQL over the JSONB `data` column so
 * row-level security, column filters, search, sort and pagination happen in
 * Postgres. Field keys are always passed as bind parameters and are additionally
 * whitelisted against the workflow definition by the caller.
 */
import { Prisma } from '@fms/db';
import type { Condition, ConditionGroup, FieldDef } from '@fms/core';

const TRUTHY = ['true', 'yes', '1', 'y'];

const text = (key: string) => Prisma.sql`(r."data"->>${key})`;
const json = (key: string) => Prisma.sql`(r."data"->${key})`;
const numeric = (key: string) => Prisma.sql`(CASE WHEN jsonb_typeof(r."data"->${key}) = 'number' THEN (r."data"->>${key})::numeric END)`;

function eqSql(key: string, value: unknown): Prisma.Sql {
  const v = String(value ?? '').trim().toLowerCase();
  return Prisma.sql`(lower(trim(coalesce(${text(key)}, ''))) = ${v} OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${json(key)}) = 'array' THEN ${json(key)} ELSE '[]'::jsonb END) AS e(v)
    WHERE lower(trim(e.v)) = ${v}))`;
}

function emptySql(key: string): Prisma.Sql {
  return Prisma.sql`(${json(key)} IS NULL OR jsonb_typeof(${json(key)}) = 'null' OR trim(coalesce(${text(key)}, '')) = '' OR ${json(key)} = '[]'::jsonb)`;
}

function compareSql(key: string, op: 'gt' | 'gte' | 'lt' | 'lte', value: unknown): Prisma.Sql {
  const sym = Prisma.raw({ gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]);
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(n) && String(value).trim() !== '') return Prisma.sql`(${numeric(key)} ${sym} ${n})`;
  return Prisma.sql`(${text(key)} ${sym} ${String(value ?? '')})`; // ISO dates compare lexically
}

export function conditionSql(c: Condition): Prisma.Sql {
  switch (c.op) {
    case 'empty':
      return emptySql(c.field);
    case 'not_empty':
      return Prisma.sql`NOT ${emptySql(c.field)}`;
    case 'is_true':
      return Prisma.sql`(lower(coalesce(${text(c.field)}, '')) = ANY(${TRUTHY}::text[]))`;
    case 'is_false':
      return Prisma.sql`NOT (lower(coalesce(${text(c.field)}, '')) = ANY(${TRUTHY}::text[]))`;
    case 'eq':
      return eqSql(c.field, c.value);
    case 'neq':
      return Prisma.sql`NOT ${eqSql(c.field, c.value)}`;
    case 'in': {
      const list = (Array.isArray(c.value) ? c.value : String(c.value ?? '').split(',')).map((v) => v.trim().toLowerCase());
      // Multi-select values are arrays: any element in the list counts.
      return Prisma.sql`(lower(trim(coalesce(${text(c.field)}, ''))) = ANY(${list}::text[]) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${json(c.field)}) = 'array' THEN ${json(c.field)} ELSE '[]'::jsonb END) AS e(v)
        WHERE lower(trim(e.v)) = ANY(${list}::text[])))`;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compareSql(c.field, c.op, c.value);
  }
}

export function groupSql(group: ConditionGroup | null | undefined): Prisma.Sql {
  if (!group || group.conditions.length === 0) return Prisma.sql`TRUE`;
  const parts = group.conditions.map(conditionSql);
  return Prisma.sql`(${Prisma.join(parts, group.mode === 'any' ? ' OR ' : ' AND ')})`;
}

export interface ListQuery {
  workflowId: string;
  archived: boolean;
  rowFilter?: ConditionGroup | null;
  filters?: ConditionGroup | null;
  search?: string;
  searchKeys: string[];
  stageKey?: string;
  status?: 'open' | 'overdue' | 'completed';
  /** Only records whose active stage is one of these (my tasks). */
  activeStageKeys?: string[];
  submissionId?: string;
  sort: { by: string; dir: 'asc' | 'desc'; field?: FieldDef };
  limit: number;
  offset: number;
  numericKeys: string[];
  /** Columns on screen that also get "filled" and "unique" counts (legacy footer: count / unique). */
  countKeys?: string[];
}

export function whereSql(q: ListQuery): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`r."workflowId" = ${q.workflowId}`,
    q.archived ? Prisma.sql`r."archivedAt" IS NOT NULL` : Prisma.sql`r."archivedAt" IS NULL`,
    groupSql(q.rowFilter),
    groupSql(q.filters),
  ];
  if (q.search && q.searchKeys.length) {
    const term = `%${q.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const haystack = Prisma.join(q.searchKeys.map((k) => Prisma.sql`coalesce(r."data"->>${k}, '')`), ` || ' ' || `);
    parts.push(Prisma.sql`(r."number"::text = ${q.search} OR (${haystack}) ILIKE ${term})`);
  }
  if (q.stageKey) parts.push(Prisma.sql`r."currentStageKey" = ${q.stageKey}`);
  if (q.submissionId) parts.push(Prisma.sql`r."submissionId" = ${q.submissionId}`);
  if (q.status === 'completed') parts.push(Prisma.sql`r."completedAt" IS NOT NULL`);
  if (q.status === 'open') parts.push(Prisma.sql`r."completedAt" IS NULL`);
  if (q.status === 'overdue') {
    parts.push(Prisma.sql`EXISTS (SELECT 1 FROM "RecordStage" s WHERE s."recordId" = r."id" AND s."status" = 'active' AND s."plannedAt" < now())`);
  }
  if (q.activeStageKeys) {
    parts.push(
      q.activeStageKeys.length
        ? Prisma.sql`EXISTS (SELECT 1 FROM "RecordStage" s WHERE s."recordId" = r."id" AND s."status" = 'active' AND s."stageKey" = ANY(${q.activeStageKeys}::text[]))`
        : Prisma.sql`FALSE`,
    );
  }
  return Prisma.join(parts, ' AND ');
}

function orderSql(q: ListQuery): Prisma.Sql {
  const dir = Prisma.raw(q.sort.dir === 'asc' ? 'ASC' : 'DESC');
  switch (q.sort.by) {
    case 'number':
      return Prisma.sql`r."number" ${dir}`;
    case 'createdAt':
      return Prisma.sql`r."createdAt" ${dir}, r."number" DESC`;
    case 'updatedAt':
      return Prisma.sql`r."updatedAt" ${dir}, r."number" DESC`;
    default: {
      const f = q.sort.field;
      const expr = f && (f.type === 'number' || f.type === 'computed') ? numeric(q.sort.by) : Prisma.sql`lower(${text(q.sort.by)})`;
      return Prisma.sql`${expr} ${dir} NULLS LAST, r."number" DESC`;
    }
  }
}

export function listSql(q: ListQuery): Prisma.Sql {
  return Prisma.sql`
    SELECT r."id", r."number", r."data", r."currentStageKey", r."submissionId", r."createdAt", r."updatedAt", r."archivedAt", r."completedAt", r."version"
    FROM "Record" r
    WHERE ${whereSql(q)}
    ORDER BY ${orderSql(q)}
    LIMIT ${q.limit} OFFSET ${q.offset}`;
}

/**
 * Footer totals over the whole filtered set (legacy column footers: count / sum / unique / average):
 * sum, average, min and max of every visible numeric field, and filled / unique counts of the
 * columns on screen.
 */
export function aggregateSql(q: ListQuery): Prisma.Sql {
  const cols = q.numericKeys.flatMap((k, i) => [
    Prisma.sql`sum(${numeric(k)}) AS ${Prisma.raw(`"sum_${i}"`)}`,
    Prisma.sql`avg(${numeric(k)}) AS ${Prisma.raw(`"avg_${i}"`)}`,
    Prisma.sql`min(${numeric(k)}) AS ${Prisma.raw(`"min_${i}"`)}`,
    Prisma.sql`max(${numeric(k)}) AS ${Prisma.raw(`"max_${i}"`)}`,
  ]);
  for (const [i, k] of (q.countKeys ?? []).entries()) {
    cols.push(Prisma.sql`(count(*) FILTER (WHERE NOT ${emptySql(k)}))::int AS ${Prisma.raw(`"filled_${i}"`)}`);
    cols.push(Prisma.sql`count(DISTINCT nullif(lower(trim(coalesce(${text(k)}, ''))), ''))::int AS ${Prisma.raw(`"unique_${i}"`)}`);
  }
  const select = cols.length ? Prisma.sql`count(*)::int AS "count", ${Prisma.join(cols, ', ')}` : Prisma.sql`count(*)::int AS "count"`;
  return Prisma.sql`SELECT ${select} FROM "Record" r WHERE ${whereSql(q)}`;
}

/** The most used values of one field (column filter lists), over the records the user may see. */
export function distinctValuesSql(workflowId: string, key: string, rowFilter: ConditionGroup | null, archived: boolean): Prisma.Sql {
  return Prisma.sql`
    SELECT x.v AS "value", count(*)::int AS "count" FROM (
      SELECT CASE WHEN jsonb_typeof(${json(key)}) = 'array' THEN e.v ELSE ${text(key)} END AS v
      FROM "Record" r
      LEFT JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(${json(key)}) = 'array' THEN ${json(key)} ELSE '[]'::jsonb END) AS e(v) ON TRUE
      WHERE r."workflowId" = ${workflowId} AND ${archived ? Prisma.sql`r."archivedAt" IS NOT NULL` : Prisma.sql`r."archivedAt" IS NULL`} AND ${groupSql(rowFilter)}
    ) x
    WHERE x.v IS NOT NULL AND trim(x.v) <> ''
    GROUP BY x.v ORDER BY count(*) DESC, x.v LIMIT 200`;
}
