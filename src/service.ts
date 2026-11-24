import cors from 'cors';
import express, { Express, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Pool, PoolClient } from 'pg';
import client from 'prom-client';
import { ZodError } from 'zod';
import { authenticate, sign } from './auth';
import { Bus, Handler } from './bus';
import { crudRouter, ddl, Resource } from './crud';
import { CallOptions, Ctx, HttpError } from './types';

export interface ServiceConfig {
  name: string;
  /** postgres schema; omit (and set db:false) for stateless services */
  schema?: string;
  db?: boolean;
  resources?: Resource[];
  /** raw extra DDL (custom tables) */
  migrate?: string[];
  /** custom routes: mounted BEFORE the generic CRUD routes, so they can take precedence */
  routes?: (app: Express, ctx: Ctx) => void;
  /** NATS subscriptions */
  subscribe?: Record<string, (env: Parameters<Handler>[0], subject: string, ctx: Ctx) => Promise<void> | void>;
  /** runs once after migrations */
  seed?: (ctx: Ctx) => Promise<void>;
  /** gateway-style services mount their own middleware and skip JSON parsing / auth */
  raw?: (app: Express, ctx: Ctx) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function log(service: string, msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), service, msg, ...extra }));
}

async function connectDb(name: string, schema: string): Promise<Pool> {
  const url = process.env.DATABASE_URL || 'postgres://hms:hms@postgres:5432/hms';
  for (let i = 1; i <= 60; i++) {
    try {
      const admin = new Pool({ connectionString: url, max: 1 });
      await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await admin.end();
      return new Pool({ connectionString: url, max: 8, options: `-c search_path=${schema},public` });
    } catch (e) {
      log(name, `waiting for postgres (${i}/60)`, { err: String(e) });
      await sleep(2000);
    }
  }
  throw new Error('postgres not reachable');
}

export function serviceUrl(service: string): string {
  const pattern = process.env.SERVICE_URL_PATTERN || 'http://{name}:3000';
  return pattern.replace('{name}', service);
}

export async function startService(cfg: ServiceConfig) {
  const app = express();
  const port = Number(process.env.PORT || 3000);
  const bus = new Bus(cfg.name);

  let pool: Pool | undefined;
  if (cfg.db !== false) pool = await connectDb(cfg.name, cfg.schema ?? cfg.name.replace(/-service$/, '').replace(/-/g, '_'));

  const q = async (sql: string, params: unknown[] = []) => {
    if (!pool) throw new Error('service has no database');
    return (await pool.query(sql, params as any[])).rows;
  };
  const tx = async <T>(fn: (c: PoolClient) => Promise<T>) => {
    if (!pool) throw new Error('service has no database');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };
  const call = async (service: string, path: string, opts: CallOptions = {}) => {
    const token = sign({ id: 'system', email: `${cfg.name}@hms.internal`, role: 'system' }, '2m');
    const res = await fetch(serviceUrl(service) + path, {
      method: opts.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(opts.user ? { 'x-actor': opts.user.id } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new HttpError(res.status, json?.error ?? `${service} responded ${res.status}`, json?.details);
    return json;
  };
  const ctx: Ctx = { name: cfg.name, db: pool as Pool, bus, tx, q, call, log: (m, e) => log(cfg.name, m, e) };

  // ---- observability ----
  client.collectDefaultMetrics({ labels: { service: cfg.name } });
  const httpHist = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP latency',
    labelNames: ['method', 'route', 'status', 'service'],
    buckets: [0.01, 0.05, 0.1, 0.3, 1, 3],
  });
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const end = httpHist.startTimer();
    res.on('finish', () => {
      const route = (req.baseUrl || '') + (req.route?.path ?? '');
      end({ method: req.method, route: route || 'unmatched', status: res.statusCode, service: cfg.name });
      if (req.path !== '/healthz' && req.path !== '/readyz' && req.path !== '/metrics')
        log(cfg.name, 'http', { method: req.method, url: req.originalUrl, status: res.statusCode });
    });
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ status: 'ok', service: cfg.name }));
  app.get('/readyz', async (_req, res) => {
    try {
      if (pool) await pool.query('SELECT 1');
      res.json({ status: 'ready', service: cfg.name, nats: bus.connected });
    } catch {
      res.status(503).json({ status: 'not-ready' });
    }
  });
  app.get('/metrics', async (_req, res) => {
    res.set('content-type', client.register.contentType);
    res.send(await client.register.metrics());
  });

  if (cfg.raw) {
    cfg.raw(app, ctx);
  } else {
    app.use(helmet());
    app.use(cors());
    app.use(express.json({ limit: '1mb' }));
  }

  // ---- database ----
  if (pool) {
    for (const r of cfg.resources ?? []) for (const s of ddl(r)) await q(s);
    for (const s of cfg.migrate ?? []) await q(s);
    if (cfg.seed) await cfg.seed(ctx);
  }

  // ---- routes ----
  if (!cfg.raw) {
    cfg.routes?.(app, ctx);
    for (const r of cfg.resources ?? []) app.use('/' + r.name, authenticate, crudRouter(r, ctx));
  }

  bus.start();
  for (const [subject, handler] of Object.entries(cfg.subscribe ?? {}))
    bus.subscribe(subject, (env, subj) => handler(env, subj, ctx));

  // ---- errors ----
  app.use((req, _res, next) => next(new HttpError(404, `Not found: ${req.method} ${req.originalUrl}`)));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err instanceof ZodError) return res.status(400).json({ error: 'Validation failed', details: err.issues });
    if (err?.code === '23505') return res.status(409).json({ error: 'Already exists', details: err.detail });
    if (err?.code === '23503') return res.status(400).json({ error: 'Referenced record does not exist', details: err.detail });
    if (err?.code === '22P02' || err?.code === '22007' || err?.code === '22008') return res.status(400).json({ error: 'Invalid value', details: err.message });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    log(cfg.name, 'unhandled error', { err: String(err?.stack ?? err) });
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(port, () => log(cfg.name, `listening on :${port}`));
  const stop = () => {
    log(cfg.name, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/** Look up a record in another service; turn a 404 into a clean 400 for the caller. */
export async function mustExist(ctx: Ctx, service: string, path: string, label: string) {
  try {
    return await ctx.call(service, path);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new HttpError(400, `${label} does not exist`);
    throw e;
  }
}
