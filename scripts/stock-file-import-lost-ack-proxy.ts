/** ROOT-ONLY QA132 transport proof; importing this file starts nothing.
 * From the primary app directory, after setup and an actual Chrome OFF preview:
 * DYNA_WORKER_DISABLED=true QA_STOCK_FILE_IMPORT_LOST_ACK_PROXY=true \
 * QA_EXPECTED_REVISION=<40-char runtime SHA> QA_EXPECTED_SCHEMA=116_stock_file_import_validation \
 * QA_STOCK_FILE_IMPORT_PREVIEW_ID=<the reviewed own preview UUID> \
 * tsx scripts/stock-file-import-lost-ack-proxy.ts run
 * Chrome uses http://127.0.0.1:5174. Existing Vite5173/API4100 remain untouched.
 * Three browser-sent identical requests are forwarded once each; two complete,
 * committed responses are intentionally lost. No login/mutation/resend is generated.
 * A new durable0600 custody file holds the exact browser request/cookie and receipts.
 * The public report contains hashes/counts only. Chrome/navigation observations and
 * historical acceptance remain separate root evidence, never inferred from transport.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, rename, unlink } from 'node:fs/promises';
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Pool } from 'pg';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const appRoot = '<workspace>/app';
const setupPath = appRoot + '/data/stock-file-import-stage132.json';
const custodyPath = appRoot + '/data/stock-file-import-lost-ack-stage132.json';
const reportPath = appRoot + '/docs/stock-file-import-lost-ack-proxy-qa.json';
const manifestPath = appRoot + '/docs/stock-file-import-116-source-evidence-manifest.json';
const proxyOrigin = 'http://127.0.0.1:5174';
const viteOrigin = 'http://127.0.0.1:5173';
const maxRequest = 4194304,
  maxResponse = 33554432,
  maxSockets = 32,
  upstreamTimeout = 30000;
type Json = Record<string, unknown>;
type Reply = { status: number; headers: string[]; body: Buffer };
type Fingerprint = {
  count: number;
  sha256: string;
  sql_sha256: string;
  row_sha256: string[];
  immutable_sha256: string;
};
type Snapshot = Record<string, Fingerprint>;
const uuid = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const savedFingerprint = z.object({ count: z.number().int().nonnegative(), sha256: digest });
const actorSchema = z.object({
  mode: z.enum(['off', 'on']),
  tenant: uuid,
  user: uuid,
  warehouse: uuid,
  second_warehouse: uuid,
  products: z.array(z.object({ id: uuid })).length(53),
  definition: z.record(z.string(), z.unknown()),
  targets: z.array(z.record(z.string(), z.unknown())).length(2),
  files: z.object({
    csv: z.object({ path: z.string(), sha256: digest, bytes: z.number().int().positive() }),
  }),
});
const setupSchema = z.object({
  stage: z.literal(132),
  setup_complete: z.literal(true),
  pending: z.null(),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  schema_revision: z.literal('115_stock_file_imports'),
  off: actorSchema,
  on: actorSchema,
  setup_checkpoint: z.object({
    off: z.record(z.string(), savedFingerprint),
    on: z.record(z.string(), savedFingerprint),
  }),
  prior_tenant_ids: z.array(uuid).nonempty(),
  prior_user_ids: z.array(uuid).nonempty(),
  prior_checkpoint: z.record(z.string(), savedFingerprint),
});
type Setup = z.infer<typeof setupSchema>;
const executeSchema = z.strictObject({
  client_key: uuid,
  scope_hash: digest,
  confirmed: z.literal(true),
  ack_unknown_loss_warehouse_ids: z.array(uuid).length(0),
  ack_surplus_warehouse_ids: z.array(uuid).length(0),
});
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x)]),
    );
  return v;
}
const jsonHash = (v: unknown) => sha(JSON.stringify(canonical(v)));
const setupHash = (v: unknown) => sha(JSON.stringify(v));
function obj(v: unknown): Json {
  assert(v !== null && typeof v === 'object' && !Array.isArray(v), 'Bounded object required');
  return v as Json;
}
function list(v: unknown): Json[] {
  assert(Array.isArray(v));
  return v.map(obj);
}
function decode(r: Reply): Json {
  return obj(JSON.parse(r.body.toString('utf8')));
}
function without(v: Json, keys: string[]): Json {
  return Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k)));
}
function publicSqlRow(row: Json): Json {
  const privateKeys = [
    'snapshot',
    'request',
    'request_hash',
    'children',
    'child_keys',
    'basis',
    'epoch',
    'execute_request',
    'actor_id',
    'api_key_id',
  ];
  function project(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(project);
    if (v !== null && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => !privateKeys.includes(k))
          .map(([k, x]) => [k, project(x)]),
      );
    return v;
  }
  return obj(project(without(row, ['basis', 'epoch', 'position', 'product_version', 'line_id'])));
}
async function syncDir(path: string) {
  const f = await open(dirname(path), constants.O_RDONLY);
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}
async function readBounded(path: string, limit: number, privateFile = false): Promise<Buffer> {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await f.stat();
    assert(st.isFile() && st.size > 0 && st.size <= limit, 'Bounded regular input required');
    if (privateFile) assert.equal(st.mode & 0o777, 0o600, 'Private input must remain0600');
    return await f.readFile();
  } finally {
    await f.close();
  }
}
async function freshFile(path: string, mode: number, value: unknown) {
  const f = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await f.writeFile(JSON.stringify(value, null, 2) + '\n');
    await f.sync();
  } finally {
    await f.close();
  }
  await syncDir(path);
}
async function atomicFile(path: string, mode: number, value: unknown) {
  const st = await lstat(path);
  assert(
    st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === mode,
    'Owned report mode changed',
  );
  const temp = path + '.write-' + randomUUID();
  await freshFile(temp, mode, value);
  try {
    await rename(temp, path);
    await syncDir(path);
  } catch (e) {
    await unlink(temp).catch(() => {});
    throw e;
  }
}
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const b = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += b.length;
    assert(size <= maxRequest);
    parts.push(b);
  }
  return Buffer.concat(parts);
}
function cleanHeaders(
  original: IncomingHttpHeaders,
  port: number,
  size?: number,
): IncomingHttpHeaders {
  const out = { ...original };
  const extra = String(out.connection ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase());
  for (const key of [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'expect',
    ...extra,
  ])
    delete out[key];
  for (const key of ['content-length', 'x-forwarded-host', 'x-forwarded-proto']) delete out[key];
  out.host = `127.0.0.1:${port}`;
  out['accept-encoding'] = 'identity';
  if (out.origin === proxyOrigin) out.origin = viteOrigin;
  if (size !== undefined) out['content-length'] = String(size);
  return out;
}
function responseHeaders(r: Reply): string[] {
  const out: string[] = [];
  for (let i = 0; i < r.headers.length; i += 2)
    if (
      ![
        'connection',
        'keep-alive',
        'transfer-encoding',
        'content-length',
        'trailer',
        'upgrade',
      ].includes(r.headers[i].toLowerCase())
    )
      out.push(r.headers[i], r.headers[i + 1]);
  out.push('Content-Length', String(r.body.length), 'Connection', 'close');
  return out;
}
function pass(res: ServerResponse, r: Reply) {
  res.writeHead(r.status, responseHeaders(r));
  res.end(r.body);
}
function failure(res: ServerResponse, status: number) {
  if (res.destroyed || res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/problem+json',
    'Cache-Control': 'no-store',
  });
  res.end(
    JSON.stringify({
      status,
      detail:
        'Proxy QA zatrzymało tę próbę; nie ponowiło żądania. Sprawdź trwały wynik i sanitizowany raport.',
    }),
  );
}
function validateRequest(req: IncomingMessage): URL {
  assert.equal(req.socket.remoteAddress, '127.0.0.1');
  assert.equal(req.headers.host, '127.0.0.1:5174');
  assert(
    req.url && req.url.startsWith('/') && !req.url.startsWith('//') && !/[\r\n]/.test(req.url),
  );
  if (req.headers.origin)
    assert([proxyOrigin, viteOrigin, 'http://127.0.0.1:4100'].includes(req.headers.origin));
  const u = new URL(req.url, proxyOrigin);
  assert.equal(u.origin, proxyOrigin);
  const n = Number(req.headers['content-length'] ?? 0);
  assert(Number.isSafeInteger(n) && n >= 0 && n <= maxRequest);
  return u;
}

type StartupStage =
  | 'NOT_STARTED' | 'ENVIRONMENT' | 'LOCAL_CONFIG' | 'SETUP_INPUT'
  | 'CSV_INPUT' | 'FROZEN_SOURCE_MANIFEST' | 'DATABASE_POOL'
  | 'HEALTH' | 'SOURCE_PRESERVATION' | 'FRESH_CUSTODY'
  | 'LOOPBACK_LISTENER' | 'READY';
let startupStage: StartupStage = 'NOT_STARTED';
function startupStep(stage: StartupStage) {
  startupStage = stage;
  // Only a compile-time stage name: never paths, IDs, credentials, SQL errors or values.
  process.stdout.write(`[QA132 startup] ${stage}\n`);
}

export async function startStockFileImportLostAckProxy() {
  startupStep('ENVIRONMENT');
  assert.equal(resolve(process.cwd()), appRoot, 'Primary app directory required');
  assert.equal(process.env.QA_STOCK_FILE_IMPORT_LOST_ACK_PROXY, 'true');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.notEqual(process.env.DYNA_TEST, 'true');
  const revision = z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(process.env.QA_EXPECTED_REVISION);
  const schema = z
    .enum(['115_stock_file_imports', '116_stock_file_import_validation'])
    .parse(process.env.QA_EXPECTED_SCHEMA);
  const previewId = uuid.parse(process.env.QA_STOCK_FILE_IMPORT_PREVIEW_ID);
  startupStep('LOCAL_CONFIG');
  const config = await lstat(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? '.local.json'));
  assert(
    config.isFile() && !config.isSymbolicLink(),
    'Existing local config required; no provisioning',
  );
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    assert(['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
    assert.equal(u.pathname, '/dynaminds');
  }
  startupStep('SETUP_INPUT');
  const original = await readBounded(setupPath, 33554432, true);
  const s: Setup = setupSchema.parse(JSON.parse(original.toString('utf8')));
  assert.equal(s.off.mode, 'off');
  assert.equal(s.on.mode, 'on');
  assert.notEqual(s.off.tenant, s.on.tenant);
  assert.notEqual(s.off.user, s.on.user);
  assert.equal(new Set(s.off.products.map((p) => p.id)).size, 53);
  assert.notEqual(s.off.warehouse, s.off.second_warehouse);
  assert(!s.prior_tenant_ids.includes(s.off.tenant) && !s.prior_tenant_ids.includes(s.on.tenant));
  assert(
    Object.keys(s.setup_checkpoint.off).length > 300 &&
      Object.keys(s.setup_checkpoint.on).length > 300,
  );
  assert.equal(s.off.files.csv.path, 'docs/stock-file-import-native-off.csv');
  startupStep('CSV_INPUT');
  const sourceBytes = await readBounded(appRoot + '/' + s.off.files.csv.path, 2097152);
  assert.equal(sourceBytes.length, s.off.files.csv.bytes);
  assert.equal(sha(sourceBytes), s.off.files.csv.sha256);
  const sourceHashes = new Set([
    sha(sourceBytes),
    sha(sourceBytes.toString('utf8').replace(/\r\n/g, '\n')),
  ]);
  startupStep('FROZEN_SOURCE_MANIFEST');
  const manifestBytes = await readBounded(manifestPath, 2097152);
  const manifest = obj(JSON.parse(manifestBytes.toString('utf8')));
  assert.equal(manifest.stage, 132);
  assert.equal(manifest.schema_revision, schema);
  const sources = list(manifest.source);
  assert.equal(sources.length, 30);
  assert.equal(new Set(sources.map((x) => x.path)).size, 30);
  for (const entry of sources) {
    assert(
      typeof entry.path === 'string' &&
        /^(server|web|scripts|tests)\/[a-zA-Z0-9_./-]+$/.test(entry.path) &&
        !entry.path.split('/').includes('..'),
    );
    assert.equal(
      sha(await readBounded(appRoot + '/' + entry.path, 16777216)),
      digest.parse(entry.sha256),
      'Accepted primary source changed',
    );
  }
  const gates = obj(manifest.gates);
  assert.equal(gates.build, 'PASS');
  for (const name of ['module', 'compatibility']) {
    const g = obj(gates[name]);
    assert.equal(g.fail, 0);
    assert.equal(g.cancelled, 0);
    assert.equal(g.skipped, 0);
    assert.equal(g.tests, g.pass);
  }
  startupStep('DATABASE_POOL');
  const db: Pool = (await import('../server/db')).pool;
  const agent = new http.Agent({ keepAlive: false, maxSockets });
  const upstreams = new Set<http.ClientRequest>(),
    sockets = new Set<Socket>();
  let busy = false,
    halted = false,
    closing = false,
    closed = false;
  let active: Promise<void> | null = null;
  let pinned: {
    cookie: string;
    body: Buffer;
    path: string;
    head: Json;
    frozen: Json[];
    after: Snapshot | null;
    execution: Json | null;
    rowHash: string | null;
  } | null = null;
  const custody: Json = {
    stage: 132,
    phase: 'READY',
    preview_id: previewId,
    setup_sha256: sha(original),
    revision,
    schema_revision: schema,
    runtime_setup_revision_differs: s.revision !== revision,
    prepared_at: new Date().toISOString(),
    request: null,
    receipts: [],
    snapshots: {},
    state: 'IN_PROGRESS',
    automatic_resends: 0,
  };
  const report: Json = {
    stage: 132,
    status: 'IN_PROGRESS',
    phase: 'two_lost_successful_responses',
    revision,
    schema_revision: schema,
    source_manifest_sha256: sha(manifestBytes),
    accepted_primary_source_files: 30,
    setup_sha256: sha(original),
    setup_revision: s.revision,
    setup_schema_revision: s.schema_revision,
    listen: '127.0.0.1:5174',
    vite: '127.0.0.1:5173',
    api: '127.0.0.1:4100',
    tenant_sha256: sha(s.off.tenant),
    principal_sha256: sha(s.off.user),
    preview_sha256: sha(previewId),
    started_at: new Date().toISOString(),
    stopped_at: null,
    execute_upstream_requests: 0,
    manual_exact_retries: 0,
    dropped_successful_responses: 0,
    natural_downstream_losses: 0,
    blocked_mutations: 0,
    errors: 0,
    automatic_resends: 0,
    durable_business_executions: 0,
    retry_all_table_fingerprints_identical: false,
    first_causal_scope_verified: false,
    browser_attestation: false,
    navigation_lock_attestation: false,
    historical_acceptance_revalidated: false,
    full_goal_complete: false,
    evidence: [],
    note: 'Transport/own business readback only. Root separately verifies actual Chrome/manual buttons/navigation, previous accepted history and normal ON import. No automatic replay or resume.',
  };
  let writes = Promise.resolve();
  function persist(): Promise<void> {
    const privateCopy = JSON.parse(JSON.stringify(custody)) as unknown;
    const publicCopy = JSON.parse(JSON.stringify(report)) as unknown;
    writes = writes.then(async () => {
      await atomicFile(custodyPath, 0o600, privateCopy);
      await atomicFile(reportPath, 0o644, publicCopy);
    });
    return writes;
  }
  function upstream(
    path: string,
    method: string,
    h: IncomingHttpHeaders,
    b?: Buffer,
    port = 4100,
  ): Promise<Reply> {
    return new Promise((resolveReply, reject) => {
      const r = http.request(
        { hostname: '127.0.0.1', port, path, method, headers: h, agent },
        (response) => {
          const parts: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxResponse) response.destroy(new Error('Bounded response exceeded'));
            else parts.push(chunk);
          });
          response.on('aborted', () => reject(new Error('Incomplete upstream response')));
          response.on('error', reject);
          response.on('end', () => {
            if (!response.complete) reject(new Error('Incomplete upstream response'));
            else
              resolveReply({
                status: response.statusCode ?? 502,
                headers: response.rawHeaders,
                body: Buffer.concat(parts),
              });
          });
        },
      );
      upstreams.add(r);
      const timer = setTimeout(() => r.destroy(new Error('Upstream deadline')), upstreamTimeout);
      timer.unref();
      r.on('close', () => {
        clearTimeout(timer);
        upstreams.delete(r);
      });
      r.on('error', reject);
      if (b) r.write(b);
      r.end();
    });
  }
  async function health() {
    const r = await upstream('/api/health', 'GET', { host: '127.0.0.1:4100' });
    assert.equal(r.status, 200);
    const h = decode(r);
    assert.equal(h.status, 'ok');
    assert.equal(h.mode, 'local');
    assert.equal(h.revision, revision);
    assert.equal(h.schema_revision, schema);
    for (const feature of [
      'stock_file_import_available',
      'inventory_bulk_edit_available',
      'wms_lots_available',
      'wms_stocktakes_available',
    ])
      assert.equal(h[feature], true);
    assert.equal(h.background_workers_enabled, false);
    assert.equal(h.restore_preview, false);
  }
  async function principal(h: IncomingHttpHeaders) {
    assert.equal(h['x-workspace-id'], s.off.tenant);
    assert(typeof h.cookie === 'string' && h.cookie.length > 0 && !h.authorization);
    const r = await upstream('/api/auth/me', 'GET', cleanHeaders(h, 4100));
    assert.equal(r.status, 200);
    const user = obj(decode(r).user);
    assert.equal(user.id, s.off.user);
    assert.equal(user.tenant_id, s.off.tenant);
    assert.equal(user.role, 'admin');
    if (pinned) assert.equal(h.cookie, pinned.cookie, 'Exact original browser session required');
  }
  async function get(path: string, h: IncomingHttpHeaders): Promise<Json> {
    const r = await upstream(path, 'GET', cleanHeaders(h, 4100));
    assert.equal(r.status, 200);
    assert(
      r.headers.some(
        (x, i) =>
          i % 2 === 0 && x.toLowerCase() === 'cache-control' && /no-store/.test(r.headers[i + 1]),
      ),
    );
    const d = decode(r);
    assert.equal(d.available, true);
    assert.equal(d.current_role, 'admin');
    assert.equal(d.can_read, true);
    assert.equal(d.can_write, true);
    assert.equal(d.can_read_value, true);
    assert.equal(d.read_only, false);
    return d;
  }
  async function rows(path: string, h: IncomingHttpHeaders): Promise<Json[]> {
    const all: Json[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const d: Json = await get(path + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), h);
      assert.equal(d.total, 106);
      const page = list(d.rows);
      assert(page.length >= 1 && page.length <= 50);
      all.push(...page);
      assert(all.length <= 106);
      assert(
        d.next_cursor === null ||
          (typeof d.next_cursor === 'string' && /^(0|[1-9][0-9]{0,3})$/.test(d.next_cursor)),
      );
      cursor = d.next_cursor as string | null;
      if (cursor) {
        assert(!seen.has(cursor));
        seen.add(cursor);
      }
    } while (cursor);
    assert.equal(all.length, 106);
    const ids = new Set(s.off.products.map((p) => p.id));
    all.forEach((r, index) => {
      assert.equal(r.index, index);
      assert(ids.has(uuid.parse(r.product_id)));
      assert.equal(r.status, 'changed');
      assert.deepEqual(r.errors, []);
      assert([s.off.warehouse, s.off.second_warehouse].includes(uuid.parse(r.warehouse_id)));
      assert.equal(r.location, 'A-01');
      assert.equal(r.lot, null);
      assert.equal(obj(r.input).operation, 'count');
      assert.equal(obj(r.input).quantity, r.warehouse_id === s.off.warehouse ? 8 : 5);
    });
    assert.equal(
      new Set(all.map((r) => JSON.stringify([r.warehouse_id, r.product_id, r.location]))).size,
      106,
    );
    return all;
  }
  async function snapshot(tenants: string[], users: string[]): Promise<Snapshot> {
    const c = await db.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TimeZone='UTC'");
      await c.query("SET LOCAL statement_timeout='8s'");
      assert.equal((await c.query('SELECT current_database() name')).rows[0].name, 'dynaminds');
      const names: string[] = (
        await c.query(
          `SELECT t.table_name FROM information_schema.tables t JOIN information_schema.columns k USING(table_schema,table_name) WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id' AND t.table_name<>'sessions' UNION SELECT 'users' UNION SELECT 'tenants' ORDER BY 1`,
        )
      ).rows.map((r) => r.table_name);
      const out: Snapshot = {};
      for (const name of names) {
        assert.match(name, /^[a-z_][a-z0-9_]*$/);
        const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
        const data = (
          await c.query(
            `SELECT to_jsonb(t) row,to_jsonb(t)::text exact_text,(to_jsonb(t)-$2::text[])::text immutable_text FROM "${name}" t WHERE ${key}=ANY($1::uuid[]) ORDER BY to_jsonb(t)`,
            [
              name === 'users' ? users : tenants,
              name === 'stock'
                ? ['on_hand', 'available', 'version']
                : name === 'stock_locations'
                  ? ['quantity']
                  : [],
            ],
          )
        ).rows as Array<{ row: unknown; exact_text: string; immutable_text: string }>;
        out[name] = {
          count: data.length,
          sha256: setupHash(data.map((r) => ({ row: r.row }))),
          sql_sha256: setupHash(data.map((r) => r.exact_text)),
          row_sha256: data.map((r) => sha(r.exact_text)),
          immutable_sha256: setupHash(data.map((r) => r.immutable_text).sort()),
        };
      }
      await c.query('COMMIT');
      return out;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }
  function baseline(actual: Snapshot, expected: Record<string, { count: number; sha256: string }>) {
    assert.deepEqual(Object.keys(actual), Object.keys(expected));
    for (const name of Object.keys(expected))
      assert.deepEqual(
        { count: actual[name].count, sha256: actual[name].sha256 },
        expected[name],
        'Frozen baseline changed: ' + name,
      );
  }
  async function preservation() {
    assert.equal(
      sha(await readBounded(manifestPath, 2097152)),
      sha(manifestBytes),
      'Accepted primary manifest bytes changed',
    );
    for (const entry of sources)
      assert.equal(
        sha(await readBounded(appRoot + '/' + String(entry.path), 16777216)),
        entry.sha256,
        'Accepted primary source changed',
      );
    assert.equal(
      sha(await readBounded(setupPath, 33554432, true)),
      sha(original),
      'Original setup bytes changed',
    );
    baseline(await snapshot([s.on.tenant], [s.on.user]), s.setup_checkpoint.on);
    baseline(await snapshot(s.prior_tenant_ids, s.prior_user_ids), s.prior_checkpoint);
  }
  async function checkStock(after: boolean) {
    const c = await db.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TimeZone='UTC'");
      const data = (
        await c.query(
          'SELECT warehouse_id,product_id,on_hand,reserved FROM stock WHERE tenant_id=$1 ORDER BY warehouse_id,product_id',
          [s.off.tenant],
        )
      ).rows as Array<{
        warehouse_id: string;
        product_id: string;
        on_hand: number;
        reserved: number;
      }>;
      assert.equal(data.length, 106);
      const pids = new Set(s.off.products.map((p) => p.id));
      for (const r of data) {
        assert(pids.has(r.product_id));
        assert([s.off.warehouse, s.off.second_warehouse].includes(r.warehouse_id));
        assert.equal(
          r.on_hand,
          r.warehouse_id === s.off.warehouse ? (after ? 8 : 10) : after ? 5 : 3,
        );
        assert.equal(
          r.reserved,
          r.product_id === s.off.products[0].id && r.warehouse_id === s.off.warehouse ? 4 : 0,
        );
      }
      const bins = (
        await c.query(
          'SELECT warehouse_id,product_id,location,quantity FROM stock_locations WHERE tenant_id=$1 ORDER BY warehouse_id,product_id,location',
          [s.off.tenant],
        )
      ).rows as Array<{
        warehouse_id: string;
        product_id: string;
        location: string;
        quantity: number;
      }>;
      assert.equal(bins.length, 106);
      for (const r of bins) {
        assert.equal(r.location, 'A-01');
        assert.equal(
          r.quantity,
          r.warehouse_id === s.off.warehouse ? (after ? 8 : 10) : after ? 5 : 3,
        );
      }
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }
  function causal(before: Snapshot, after: Snapshot) {
    assert.deepEqual(Object.keys(after), Object.keys(before));
    const additions: Record<string, number> = {
      stock_file_import_executions: 1,
      stock_file_import_admissions: 1,
      stock_file_import_core_witnesses: 4,
      inventory_bulk_edit_previews: 2,
      inventory_bulk_edit_rows: 106,
      inventory_bulk_edit_executions: 2,
      inventory_bulk_edit_execution_rows: 106,
      stock_location_operations: 106,
      stock_location_movements: 106,
      stock_movements: 106,
      audit_events: 111,
      purchasing_stock_changes: 212,
    };
    for (const name of Object.keys(before)) {
      if (name === 'stock' || name === 'stock_locations') {
        assert.equal(after[name].count, before[name].count);
        assert.equal(
          after[name].immutable_sha256,
          before[name].immutable_sha256,
          'Stock/bin metadata or exact keys changed',
        );
      } else if (name in additions) {
        assert.equal(
          after[name].count,
          before[name].count + additions[name],
          'Unexpected causal count: ' + name,
        );
        const remaining = new Map<string, number>();
        for (const hash of after[name].row_sha256)
          remaining.set(hash, (remaining.get(hash) ?? 0) + 1);
        for (const hash of before[name].row_sha256) {
          const count = remaining.get(hash) ?? 0;
          assert(count > 0, 'Earlier causal-table row changed: ' + name);
          remaining.set(hash, count - 1);
        }
      } else assert.deepEqual(after[name], before[name], 'Unrelated own table changed: ' + name);
    }
  }
  async function linkedReceipt(
    execution: Json,
    request: z.infer<typeof executeSchema>,
    actualRows: Json[],
  ) {
    const c = await db.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TimeZone='UTC'");
      const e = (
        await c.query('SELECT * FROM stock_file_import_executions WHERE tenant_id=$1 AND id=$2', [
          s.off.tenant,
          execution.id,
        ])
      ).rows[0];
      assert(e);
      assert.equal(e.preview_id, previewId);
      assert.equal(e.actor_id, s.off.user);
      assert.equal(e.api_key_id, null);
      assert.equal(e.client_key, request.client_key);
      assert.equal(e.scope_hash, request.scope_hash);
      assert.deepEqual(e.payload.execute_request, request);
      assert.deepEqual(
        actualRows,
        list(e.payload.rows).map((r) => publicSqlRow(r)),
        'HTTP rows must equal durable full actual-after projection',
      );
      const a = (
        await c.query(
          'SELECT a.*,a.transaction_started_at=e.transaction_started_at exact_transaction_clock FROM stock_file_import_admissions a JOIN stock_file_import_executions e ON e.tenant_id=a.tenant_id AND e.id=a.execution_id WHERE a.tenant_id=$1 AND a.execution_id=$2',
          [s.off.tenant, execution.id],
        )
      ).rows[0];
      assert(a);
      assert.equal(a.preview_id, previewId);
      assert.equal(a.actor_id, s.off.user);
      assert.equal(a.api_key_id, null);
      const p = (
        await c.query(
          'SELECT payload FROM stock_file_import_previews WHERE tenant_id=$1 AND id=$2',
          [s.off.tenant, previewId],
        )
      ).rows[0];
      assert(p);
      assert.deepEqual(a.before_snapshot, p.payload.snapshot);
      assert.deepEqual(a.after_snapshot, e.payload.snapshot);
      assert.deepEqual(a.request, request);
      assert.equal(String(a.top_xid), String(e.top_xid));
      assert.equal(a.exact_transaction_clock, true);
      const links = list(e.payload.links);
      assert.equal(links.length, 2);
      assert.deepEqual(
        links.map((l) => l.warehouse_id).sort(),
        [s.off.warehouse, s.off.second_warehouse].sort(),
      );
      for (const l of links) {
        const core = (
          await c.query(
            'SELECT * FROM inventory_bulk_edit_executions WHERE tenant_id=$1 AND id=$2 AND preview_id=$3',
            [s.off.tenant, uuid.parse(l.core_execution_id), uuid.parse(l.core_preview_id)],
          )
        ).rows[0];
        assert(core);
        assert.equal(core.actor_id, s.off.user);
        assert.equal(core.total, 53);
        assert.equal(core.changed, 53);
        const w = (
          await c.query(
            'SELECT w.kind,w.id,w.top_xid::text,w.transaction_started_at=e.transaction_started_at exact_transaction_clock FROM stock_file_import_core_witnesses w JOIN stock_file_import_executions e ON e.tenant_id=w.tenant_id AND e.id=$4::uuid WHERE w.tenant_id=$1 AND w.preview_id=$2 AND w.id=ANY($3::uuid[]) ORDER BY w.kind',
            [s.off.tenant, previewId, [l.core_preview_id, l.core_execution_id], execution.id],
          )
        ).rows;
        assert.equal(w.length, 2);
        for (const row of w) {
          assert.equal(row.top_xid, String(e.top_xid));
          assert.equal(row.exact_transaction_clock, true);
        }
      }
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }

  let server: http.Server;
  async function target(req: IncomingMessage, res: ServerResponse, payload: Buffer) {
    await health();
    await preservation();
    await principal(req.headers);
    assert.equal(req.url, `/api/stock-file-imports/previews/${previewId}/execute`);
    assert(
      payload.length <= 4096 &&
        /^application\/json(?:;|$)/i.test(String(req.headers['content-type'] ?? '')),
    );
    const request = executeSchema.parse(JSON.parse(payload.toString('utf8')));
    if (pinned) {
      assert(payload.equals(pinned.body));
      assert.equal(req.url, pinned.path);
      assert(Number(report.execute_upstream_requests) < 3);
    } else {
      const head = obj(
        (await get(`/api/stock-file-imports/previews/${previewId}`, req.headers)).preview,
      );
      assert.equal(head.id, previewId);
      assert.equal(head.scope_hash, request.scope_hash);
      assert(
        sourceHashes.has(String(head.source_hash)),
        'Only original CSV or exact textarea CRLF-to-LF normalization permitted',
      );
      assert.equal(head.can_execute, true);
      assert.equal(obj(head.policy).enabled, false);
      assert.deepEqual(head.definition, s.off.definition);
      const targets = list(head.targets);
      assert.equal(targets.length, 2);
      assert.deepEqual(
        targets.map((t) => t.warehouse_id).sort(),
        [s.off.warehouse, s.off.second_warehouse].sort(),
      );
      assert.equal(obj(head.summary).source_rows, 53);
      assert.equal(obj(head.summary).positions, 106);
      assert.equal(obj(head.summary).invalid, 0);
      assert.equal(obj(head.summary).conflicts, 0);
      const frozen = await rows(`/api/stock-file-imports/previews/${previewId}/rows`, req.headers);
      await checkStock(false);
      const c = await db.connect();
      try {
        await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await c.query("SET LOCAL TimeZone='UTC'");
        const p = (
          await c.query(
            'SELECT actor_id,api_key_id,payload FROM stock_file_import_previews WHERE tenant_id=$1 AND id=$2',
            [s.off.tenant, previewId],
          )
        ).rows[0];
        assert(p);
        assert.equal(p.actor_id, s.off.user);
        assert.equal(p.api_key_id, null);
        assert.equal(p.payload.source_hash, head.source_hash);
        assert(
          [
            sourceBytes.toString('utf8'),
            sourceBytes.toString('utf8').replace(/\r\n/g, '\n'),
          ].includes(p.payload.request.content),
        );
        assert.deepEqual(frozen, list(p.payload.rows).map(publicSqlRow));
        await c.query('COMMIT');
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
      const before = await snapshot([s.off.tenant], [s.off.user]);
      assert.equal(before.stock_file_import_executions.count, 0);
      assert.equal(before.stock_file_import_admissions.count, 0);
      pinned = {
        cookie: String(req.headers.cookie),
        body: Buffer.from(payload),
        path: req.url!,
        head,
        frozen,
        after: null,
        execution: null,
        rowHash: null,
      };
      custody.request = {
        path: req.url,
        exact_body_base64: payload.toString('base64'),
        body_sha256: sha(payload),
        canonical_body_sha256: jsonHash(request),
        cookie: pinned.cookie,
        tenant_id: s.off.tenant,
        user_id: s.off.user,
        preview_id: previewId,
        client_key: request.client_key,
        scope_hash: request.scope_hash,
      };
      obj(custody.snapshots).before_execution = before;
      report.before_execution_checkpoint_sha256 = jsonHash(before);
      report.source_hash = head.source_hash;
      report.scope_hash = request.scope_hash;
    }
    assert(pinned);
    custody.phase = 'FORWARDING';
    custody.attempt = Number(report.execute_upstream_requests) + 1;
    await persist(); // The exact body/cookie and intent to forward are durable FIRST.
    report.execute_upstream_requests = Number(report.execute_upstream_requests) + 1;
    const reply = await upstream(
      req.url!,
      'POST',
      cleanHeaders(req.headers, 4100, payload.length),
      payload,
    ); // ONE upstream, never retried.
    const number = Number(report.execute_upstream_requests);
    assert.equal(reply.status, number === 1 ? 201 : 200);
    assert(
      reply.headers.some(
        (x, i) =>
          i % 2 === 0 &&
          x.toLowerCase() === 'cache-control' &&
          /no-store/.test(reply.headers[i + 1]),
      ),
    );
    const decoded = decode(reply);
    assert.equal(decoded.reused, number !== 1);
    const sentHead = obj(decoded.execution);
    uuid.parse(sentHead.id);
    const execution = obj(
      (await get(`/api/stock-file-imports/executions/${sentHead.id}`, req.headers)).execution,
    );
    assert.equal(execution.id, sentHead.id);
    assert.equal(execution.preview_id, previewId);
    assert.equal(execution.scope_hash, request.scope_hash);
    assert(
      Number.isFinite(Date.parse(String(sentHead.created_at))) &&
        Number.isFinite(Date.parse(String(execution.created_at))),
    );
    if (number === 1)
      assert.deepEqual(without(sentHead, ['created_at']), without(execution, ['created_at']));
    else assert.deepEqual(sentHead, execution);
    const actualRows = await rows(
      `/api/stock-file-imports/executions/${execution.id}/rows`,
      req.headers,
    );
    assert.deepEqual(
      actualRows.map((r) => without(r, ['after'])),
      pinned.frozen.map((r) => without(r, ['after'])),
    );
    for (const row of actualRows) {
      const before = obj(row.before),
        after = obj(row.after);
      assert.equal(BigInt(String(after.stock_version)), BigInt(String(before.stock_version)) + 1n);
      assert.equal(after.quantity, obj(row.input).quantity);
      assert.equal(after.warehouse_on_hand, obj(row.input).quantity);
      assert.equal(after.warehouse_reserved, before.warehouse_reserved);
      assert.equal(after.reserved, before.reserved);
    }
    await linkedReceipt(execution, request, actualRows);
    await checkStock(true);
    const after = await snapshot([s.off.tenant], [s.off.user]);
    await preservation();
    await health();
    if (number === 1) {
      causal(obj(custody.snapshots).before_execution as Snapshot, after);
      pinned.execution = execution;
      pinned.rowHash = jsonHash(actualRows);
      pinned.after = after;
      obj(custody.snapshots).after_first_commit = after;
      report.first_causal_scope_verified = true;
      report.durable_business_executions = 1;
      report.after_first_commit_checkpoint_sha256 = jsonHash(after);
    } else {
      assert.deepEqual(execution, pinned.execution);
      assert.equal(jsonHash(actualRows), pinned.rowHash);
      assert.deepEqual(after, pinned.after);
      report.manual_exact_retries = Number(report.manual_exact_retries) + 1;
      report.retry_all_table_fingerprints_identical = true;
    }
    const receipt: Json = {
      attempt: number,
      received_at: new Date().toISOString(),
      status: reply.status,
      reused: decoded.reused,
      complete_upstream_response: JSON.parse(reply.body.toString('utf8')),
      raw_response_sha256: sha(reply.body),
      persisted_execution: execution,
      persisted_rows_sha256: jsonHash(actualRows),
      checkpoint_sha256: jsonHash(after),
      suppression: 'PENDING',
    };
    (custody.receipts as Json[]).push(receipt);
    custody.phase = 'CONFIRMED_COMMIT';
    (report.evidence as Json[]).push({
      attempt: number,
      status: reply.status,
      reused: decoded.reused,
      execution_id: execution.id,
      complete_response_bytes: reply.body.length,
      response_sha256: sha(reply.body),
      persisted_head_sha256: jsonHash(execution),
      persisted_rows_sha256: jsonHash(actualRows),
      checkpoint_sha256: jsonHash(after),
    });
    await persist(); // Never destroy a successful response before durable readback/receipt.
    if (number <= 2) {
      assert(
        !res.headersSent && !res.destroyed && !req.aborted && res.socket && !res.socket.destroyed,
        'Natural downstream loss is not a deliberate drop',
      );
      receipt.suppression = 'DROP_ARMED';
      await persist();
      assert(
        !res.destroyed && !req.aborted && res.socket && !res.socket.destroyed,
        'Natural downstream loss is not a deliberate drop',
      );
      res.destroy(); // This helper now actually caused the downstream loss; durable successful receipt already exists.
      receipt.suppression = 'INTENTIONAL_DROP';
      custody.phase = number === 1 ? 'WAITING_FIRST_MANUAL_RETRY' : 'WAITING_SECOND_MANUAL_RETRY';
      report.dropped_successful_responses = Number(report.dropped_successful_responses) + 1;
      await persist();
      return;
    }
    assert.equal(report.dropped_successful_responses, 2);
    assert.equal(report.manual_exact_retries, 2);
    assert(!res.destroyed && !req.aborted);
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Downstream completion deadline')), 10000);
      timer.unref();
      res.once('finish', () => {
        clearTimeout(timer);
        done();
      });
      res.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      res.once('close', () => {
        if (!res.writableFinished) {
          clearTimeout(timer);
          reject(new Error('Natural downstream close'));
        }
      });
      pass(res, reply);
    });
    receipt.suppression = 'ACK_FORWARDED';
    custody.phase = 'COMPLETED';
    custody.state = 'PASS';
    report.status = 'PASS';
    await persist();
  }

  try {
    startupStep('HEALTH');
    await health();
    assert.equal((await db.query('SELECT current_database() name')).rows[0].name, 'dynaminds');
    startupStep('SOURCE_PRESERVATION');
    await preservation();
    startupStep('FRESH_CUSTODY');
    // OFF preview/profile/audit already exist: capture their immutable baseline at first browser execute, never rebase setup.
    // No resume: either preexisting custody/report prevents listening or a fresh pair is created.
    try {
      await lstat(custodyPath);
      throw new Error('Existing custody refused');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    try {
      await lstat(reportPath);
      throw new Error('Existing report refused');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await freshFile(custodyPath, 0o600, custody);
    await freshFile(reportPath, 0o644, report);
  } catch {
    agent.destroy();
    await db.end();
    throw new Error('QA132 preflight refused; no execute was forwarded');
  }
  server = http.createServer(async (req, res) => {
    try {
      assert(!closing && !halted, 'Proxy halted');
      const u = validateRequest(req);
      if (req.headers['x-workspace-id']) assert.equal(req.headers['x-workspace-id'], s.off.tenant);
      const isApi = u.pathname.startsWith('/api/');
      assert(
        isApi
          ? ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'].includes(req.method ?? '')
          : ['GET', 'HEAD'].includes(req.method ?? ''),
      );
      const payload = await readBody(req);
      const isExecute =
        isApi &&
        req.method === 'POST' &&
        !u.search &&
        u.pathname === `/api/stock-file-imports/previews/${previewId}/execute`;
      if (!isExecute) {
        if (isApi && !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '')) {
          report.blocked_mutations = Number(report.blocked_mutations) + 1;
          await persist();
          failure(res, 409);
          return;
        }
        pass(
          res,
          await upstream(
            req.url!,
            req.method ?? 'GET',
            cleanHeaders(req.headers, isApi ? 4100 : 5173, payload.length),
            payload,
            isApi ? 4100 : 5173,
          ),
        );
        return;
      }
      if (busy || report.status === 'PASS') {
        report.blocked_mutations = Number(report.blocked_mutations) + 1;
        await persist();
        failure(res, 409);
        return;
      }
      busy = true;
      active = target(req, res, payload)
        .catch(async () => {
          halted = true;
          report.status = 'NOT_PROVEN';
          report.errors = Number(report.errors) + 1;
          if (res.destroyed || req.aborted)
            report.natural_downstream_losses = Number(report.natural_downstream_losses) + 1;
          custody.phase = 'UNKNOWN_OR_REJECTED';
          custody.state = 'NOT_PROVEN';
          await persist().catch(() => {});
          failure(res, 502);
        })
        .finally(() => {
          busy = false;
          active = null;
        });
      await active;
    } catch {
      halted = true;
      report.status = 'NOT_PROVEN';
      report.errors = Number(report.errors) + 1;
      custody.state = 'NOT_PROVEN';
      await persist().catch(() => {});
      failure(res, 502);
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 120000;
  server.on('connection', (socket) => {
    if (sockets.size >= maxSockets) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    try {
      assert(!closing && !halted);
      const u = validateRequest(req);
      assert.equal(req.method, 'GET');
      assert.equal(u.pathname, '/');
      assert.equal(req.headers['sec-websocket-protocol'], 'vite-hmr');
      assert.equal(req.headers.upgrade?.toLowerCase(), 'websocket');
      assert.equal(req.headers['sec-websocket-version'], '13');
      assert([proxyOrigin, viteOrigin].includes(req.headers.origin ?? ''));
      const h = cleanHeaders(req.headers, 5173);
      h.connection = 'Upgrade';
      h.upgrade = 'websocket';
      const r = http.request({
        hostname: '127.0.0.1',
        port: 5173,
        path: req.url,
        method: 'GET',
        headers: h,
        agent: false,
      });
      upstreams.add(r);
      const timer = setTimeout(() => r.destroy(), 10000);
      timer.unref();
      r.on('close', () => {
        clearTimeout(timer);
        upstreams.delete(r);
      });
      r.on('upgrade', (response, peer, remainder) => {
        clearTimeout(timer);
        if (
          closing ||
          halted ||
          socket.destroyed ||
          response.statusCode !== 101 ||
          sockets.size >= maxSockets
        ) {
          peer.destroy();
          socket.destroy();
          return;
        }
        sockets.add(peer);
        peer.on('close', () => sockets.delete(peer));
        const lines: string[] = ['HTTP/1.1 101 Switching Protocols'];
        for (let i = 0; i < response.rawHeaders.length; i += 2)
          lines.push(response.rawHeaders[i] + ': ' + response.rawHeaders[i + 1]);
        socket.write(lines.join('\r\n') + '\r\n\r\n');
        if (remainder.length) socket.write(remainder);
        if (head.length) peer.write(head);
        peer.pipe(socket);
        socket.pipe(peer);
        peer.on('error', () => socket.destroy());
        socket.on('error', () => peer.destroy());
        socket.on('close', () => peer.destroy());
        peer.on('close', () => socket.destroy());
      });
      r.on('response', (response) => {
        response.resume();
        socket.destroy();
      });
      r.on('error', () => socket.destroy());
      r.end();
    } catch {
      socket.destroy();
    }
  });
  async function close() {
    if (closing || closed) return;
    closing = true;
    const listenerClosed = new Promise<void>((done) => server.close(() => done()));
    if (active) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        active,
        new Promise<void>((done) => {
          timer = setTimeout(() => {
            custody.phase = 'UNKNOWN_AT_SHUTDOWN';
            custody.state = 'NOT_PROVEN';
            report.status = 'NOT_PROVEN';
            halted = true;
            for (const r of upstreams) r.destroy();
            done();
          }, 120000);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    for (const r of upstreams) r.destroy();
    for (const socket of sockets) socket.destroy();
    await listenerClosed;
    try {
      await preservation();
      if (report.status === 'PASS') {
        assert(pinned?.after);
        assert.deepEqual(await snapshot([s.off.tenant], [s.off.user]), pinned.after);
        await checkStock(true);
      }
      await health();
      report.shutdown_source_readback_verified = true;
    } catch {
      report.status = 'NOT_PROVEN';
      custody.state = 'NOT_PROVEN';
      report.shutdown_source_readback_verified = false;
    }
    // A stopped partial run has no future opportunity to fulfill the three-request proof.
    // Keep the last custody phase/receipts intact and never convert known partial evidence to PASS.
    if (report.status === 'IN_PROGRESS') {
      report.status = 'INTERRUPTED';
      custody.state = 'INTERRUPTED';
      report.stopped_before_completion = true;
    }
    report.stopped_at = new Date().toISOString();
    custody.stopped_at = report.stopped_at;
    try {
      await persist();
    } finally {
      agent.destroy();
      await db.end();
      closed = true;
      process.off('SIGINT', signal);
      process.off('SIGTERM', signal);
    }
  }
  const signal = () => {
    void close().catch(() => {
      process.stderr.write(
        'QA132 proxy cleanup failed; inspect private custody and public report.\n',
      );
      process.exitCode = 1;
    });
  };
  try {
    startupStep('LOOPBACK_LISTENER');
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(5174, '127.0.0.1', () => {
        server.off('error', reject);
        done();
      });
    });
    startupStep('READY');
    process.on('SIGINT', signal);
    process.on('SIGTERM', signal);
    process.stdout.write(
      'QA132 lost-ACK proxy listening on127.0.0.1:5174. Root Chrome attestation remains separate.\n',
    );
    return { server, close };
  } catch {
    halted = true;
    report.status = 'NOT_PROVEN';
    custody.state = 'NOT_PROVEN';
    report.errors = Number(report.errors) + 1;
    await persist().catch(() => {});
    agent.destroy();
    for (const r of upstreams) r.destroy();
    for (const socket of sockets) socket.destroy();
    await db.end();
    throw new Error('QA132 proxy startup refused');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'run') {
    process.stderr.write('QA132 startup refused at CLI_PHASE. Explicit run phase required.\n');
    process.exitCode = 1;
  } else {
    startStockFileImportLostAckProxy().catch(() => {
      process.stderr.write(
        `QA132 proxy refused at startup stage ${startupStage}. No request was automatically retried; inspect owned artifacts if created.\n`,
      );
      process.exitCode = 1;
    });
  }
}
