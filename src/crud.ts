import { Request, Router } from 'express';
import { z, ZodTypeAny } from 'zod';
import { allow, wrap } from './auth';
import { Ctx, HttpError, Role, STAFF_ROLES, User } from './types';

export type ColType = 'text' | 'int' | 'numeric' | 'bool' | 'date' | 'timestamp' | 'json' | 'uuid';

export interface HookCtx {
  ctx: Ctx;
  user: User;
  req: Request;
}

/** extra row filter for the current user: rows where `field` is one of `values` (null = no restriction) */
export type RowScope = { field: string; values: string[]; orNull?: boolean } | null;

export interface Resource {
  /** URL path and (by default) table name */
  name: string;
  table?: string;
  /**
   * Column spec: `type[!][=default]`.  `!` = required. `=@sql` uses raw SQL default.
   * e.g.  { name: 'text!', status: 'text=active', created: 'timestamp=@now()' }
   */
  columns: Record<string, string>;
  unique?: (string | string[])[];
  read?: Role[];
  write?: Role[];
  remove?: Role[];
  readonly?: boolean;
  /** column holding the patient id; enables "patients see only their own rows" */
  patientField?: string;
  patientCanCreate?: boolean;
  /** row-level restriction applied to staff reads, updates and deletes (e.g. a doctor only sees their own patients) */
  scope?: (user: User, ctx: Ctx) => Promise<RowScope>;
  searchable?: string[];
  defaultSort?: string;
  hooks?: {
    beforeCreate?: (data: any, h: HookCtx) => Promise<void> | void;
    afterCreate?: (row: any, h: HookCtx) => Promise<void> | void;
    beforeUpdate?: (data: any, existing: any, h: HookCtx) => Promise<void> | void;
    afterUpdate?: (row: any, h: HookCtx) => Promise<void> | void;
    afterDelete?: (row: any, h: HookCtx) => Promise<void> | void;
  };
}

interface Col {
  name: string;
  type: ColType;
  required: boolean;
  def?: string;
}

const SQL_TYPES: Record<ColType, string> = {
  text: 'text',
  int: 'integer',
  numeric: 'numeric(12,2)',
  bool: 'boolean',
  date: 'date',
  timestamp: 'timestamptz',
  json: 'jsonb',
  uuid: 'uuid',
};

export function parseCols(spec: Record<string, string>): Col[] {
  return Object.entries(spec).map(([name, s]) => {
    const m = /^(\w+)(!)?(?:=(.*))?$/.exec(s);
    if (!m || !(m[1] in SQL_TYPES)) throw new Error(`bad column spec ${name}: ${s}`);
    return { name, type: m[1] as ColType, required: !!m[2], def: m[3] };
  });
}

function sqlDefault(c: Col): string {
  if (c.def === undefined) return '';
  if (c.def.startsWith('@')) return ` DEFAULT ${c.def.slice(1)}`;
  if (c.type === 'text' || c.type === 'date' || c.type === 'timestamp' || c.type === 'uuid')
    return ` DEFAULT '${c.def.replace(/'/g, "''")}'`;
  if (c.type === 'json') return ` DEFAULT '${c.def}'::jsonb`;
  return ` DEFAULT ${c.def}`;
}

export function ddl(r: Resource): string[] {
  const t = r.table ?? r.name;
  const cols = parseCols(r.columns);
  const lines = cols.map(
    (c) => `${c.name} ${SQL_TYPES[c.type]}${c.required && c.def !== undefined ? ' NOT NULL' : c.required ? ' NOT NULL' : ''}${sqlDefault(c)}`,
  );
  const out = [
    `CREATE TABLE IF NOT EXISTS ${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ${lines.join(', ')}, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
    // allow adding columns in later releases without manual migrations
    ...cols.map((c) => `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c.name} ${SQL_TYPES[c.type]}${sqlDefault(c)}`),
  ];
  for (const u of r.unique ?? []) {
    const list = Array.isArray(u) ? u : [u];
    out.push(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${t}_${list.join('_')} ON ${t} (${list.join(', ')})`);
  }
  for (const c of cols) if (c.name.endsWith('_id')) out.push(`CREATE INDEX IF NOT EXISTS ix_${t}_${c.name} ON ${t} (${c.name})`);
  return out;
}

function zodFor(c: Col): ZodTypeAny {
  switch (c.type) {
    case 'text': return z.string();
    case 'int': return z.coerce.number().int();
    case 'numeric': return z.coerce.number();
    case 'bool': return z.boolean();
    case 'date': return z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'expected YYYY-MM-DD');
    case 'timestamp': return z.string().refine((v) => !isNaN(Date.parse(v)), 'invalid date-time');
    case 'uuid': return z.string().uuid();
    case 'json': return z.any();
  }
}

function buildSchema(cols: Col[], partial: boolean) {
  const shape: Record<string, ZodTypeAny> = {};
  for (const c of cols) {
    const base = zodFor(c);
    shape[c.name] = !partial && c.required && c.def === undefined ? base : base.nullish();
  }
  return z.object(shape).strip();
}

/** '' -> null (HTML forms) */
function clean(body: any): any {
  const out: any = {};
  for (const [k, v] of Object.entries(body ?? {})) out[k] = v === '' ? null : v;
  return out;
}

function ser(c: Col, v: unknown) {
  return c.type === 'json' && v !== null && v !== undefined ? JSON.stringify(v) : v;
}

export function crudRouter(r: Resource, ctx: Ctx): Router {
  const t = r.table ?? r.name;
  const cols = parseCols(r.columns);
  const names = cols.map((c) => c.name);
  const textCols = r.searchable ?? cols.filter((c) => c.type === 'text').map((c) => c.name);
  const rangeCols = cols.filter((c) => c.type === 'date' || c.type === 'timestamp').map((c) => c.name);
  const createSchema = buildSchema(cols, false);
  const updateSchema = buildSchema(cols, true);
  const readRoles = r.read ?? STAFF_ROLES;
  const writeRoles = r.write ?? ['admin'];
  const removeRoles = r.remove ?? ['admin'];
  const sortable = new Set([...names, 'created_at', 'updated_at']);
  const router = Router();

  /** returns an extra WHERE restriction for the current user, or throws 403 */
  async function readScope(user: User): Promise<RowScope> {
    if (allow(user, readRoles)) return r.scope ? r.scope(user, ctx) : null;
    if (user.role === 'patient' && r.patientField && user.patientId) return { field: r.patientField, values: [user.patientId] };
    throw new HttpError(403, 'Forbidden for role ' + user.role);
  }
  const scopeSql = (scope: NonNullable<RowScope>, param: string) =>
    scope.orNull ? `(${scope.field}::text = ANY(${param}::text[]) OR ${scope.field} IS NULL)` : `${scope.field}::text = ANY(${param}::text[])`;
  const inScope = (scope: RowScope, row: any) =>
    !scope || scope.values.includes(String(row[scope.field])) || (!!scope.orNull && (row[scope.field] === null || row[scope.field] === undefined));

  const hc = (req: Request): HookCtx => ({ ctx, user: req.user!, req });

  router.get('/', wrap(async (req, res) => {
    const scope = await readScope(req.user!);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', '$' + params.length));
    };
    for (const n of ['id', ...names]) {
      const v = req.query[n];
      if (typeof v === 'string' && v !== '') add(`${n} = ?`, v);
    }
    for (const n of rangeCols) {
      const from = req.query[n + '_from'];
      const to = req.query[n + '_to'];
      if (typeof from === 'string' && from) add(`${n} >= ?`, from);
      if (typeof to === 'string' && to) add(`${n} < ?`, to);
    }
    const q = req.query.q;
    if (typeof q === 'string' && q && textCols.length) {
      params.push(`%${q}%`);
      where.push('(' + textCols.map((c) => `${c} ILIKE $${params.length}`).join(' OR ') + ')');
    }
    if (scope) {
      params.push(scope.values);
      where.push(scopeSql(scope, '$' + params.length));
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sortKey = typeof req.query.sort === 'string' && sortable.has(req.query.sort) ? req.query.sort : r.defaultSort ?? 'created_at';
    const dir = req.query.order === 'asc' ? 'ASC' : req.query.order === 'desc' ? 'DESC' : sortKey === 'created_at' && !req.query.sort ? 'DESC' : 'ASC';
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 500);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const [{ count }] = await ctx.q(`SELECT count(*)::int AS count FROM ${t} ${w}`, params);
    const data = await ctx.q(`SELECT * FROM ${t} ${w} ORDER BY ${sortKey} ${dir} LIMIT ${limit} OFFSET ${offset}`, params);
    res.json({ data, total: count, limit, offset });
  }));

  router.get('/:id', wrap(async (req, res) => {
    const scope = await readScope(req.user!);
    const params: unknown[] = [req.params.id];
    let w = 'id = $1';
    if (scope) {
      params.push(scope.values);
      w += ` AND ${scopeSql(scope, '$2')}`;
    }
    const rows = await ctx.q(`SELECT * FROM ${t} WHERE ${w}`, params);
    if (!rows.length) throw new HttpError(404, `${r.name} not found`);
    res.json(rows[0]);
  }));

  if (r.readonly) return router;

  router.post('/', wrap(async (req, res) => {
    const user = req.user!;
    let body = clean(req.body);
    if (user.role === 'patient') {
      if (!r.patientCanCreate || !r.patientField || !user.patientId) throw new HttpError(403, 'Forbidden for role patient');
      body[r.patientField] = user.patientId;
    } else if (!allow(user, writeRoles)) throw new HttpError(403, 'Forbidden for role ' + user.role);
    const data: any = createSchema.parse(body);
    await r.hooks?.beforeCreate?.(data, hc(req));
    const keys = names.filter((n) => data[n] !== undefined && data[n] !== null);
    const row = (
      await ctx.q(
        `INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING *`.replace('() VALUES ()', 'DEFAULT VALUES'),
        keys.map((k) => ser(cols.find((c) => c.name === k)!, data[k])),
      )
    )[0];
    await r.hooks?.afterCreate?.(row, hc(req));
    ctx.bus.publish(`hms.${r.name}.created`, row, user.id);
    res.status(201).json(row);
  }));

  const update = wrap(async (req, res) => {
    const user = req.user!;
    if (!allow(user, writeRoles)) throw new HttpError(403, 'Forbidden for role ' + user.role);
    const data: any = updateSchema.parse(clean(req.body));
    const existing = (await ctx.q(`SELECT * FROM ${t} WHERE id = $1`, [req.params.id]))[0];
    if (!existing) throw new HttpError(404, `${r.name} not found`);
    if (r.scope && !inScope(await r.scope(user, ctx), existing)) throw new HttpError(403, 'Not allowed for this record');
    await r.hooks?.beforeUpdate?.(data, existing, hc(req));
    const keys = names.filter((n) => data[n] !== undefined);
    if (!keys.length) return res.json(existing);
    const row = (
      await ctx.q(
        `UPDATE ${t} SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`,
        [...keys.map((k) => ser(cols.find((c) => c.name === k)!, data[k])), req.params.id],
      )
    )[0];
    await r.hooks?.afterUpdate?.(row, hc(req));
    ctx.bus.publish(`hms.${r.name}.updated`, row, user.id);
    res.json(row);
  });
  router.put('/:id', update);
  router.patch('/:id', update);

  router.delete('/:id', wrap(async (req, res) => {
    const user = req.user!;
    if (!allow(user, removeRoles)) throw new HttpError(403, 'Forbidden for role ' + user.role);
    if (r.scope) {
      const cur = (await ctx.q(`SELECT * FROM ${t} WHERE id = $1`, [req.params.id]))[0];
      if (cur && !inScope(await r.scope(user, ctx), cur)) throw new HttpError(403, 'Not allowed for this record');
    }
    const rows = await ctx.q(`DELETE FROM ${t} WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!rows.length) throw new HttpError(404, `${r.name} not found`);
    await r.hooks?.afterDelete?.(rows[0], hc(req));
    ctx.bus.publish(`hms.${r.name}.deleted`, rows[0], user.id);
    res.status(204).end();
  }));

  return router;
}
