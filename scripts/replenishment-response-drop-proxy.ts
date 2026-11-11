/** Explicit local QA118 only. Importing starts no listener or Vite process.
 * QA_REPLENISHMENT_DROP_PROXY=true tsx scripts/replenishment-response-drop-proxy.ts run
 * Separate preparation: ... prepare-vite; then vite --config data/replenishment-ack-vite.config.ts.
 * Private immutable setup: data/replenishment-ack-stage118.json. No new fixture or consent is fabricated.
 * First own-admin execute201 is dropped ONLY after complete upstream body, SQL-bound two-currency
 * draft proof and exact GET readback. The real same-key/body retry is forwarded200 after proving
 * reused evidence and unchanged full own non-session checkpoint. Other requests pass through.
 * Stop only these owned proxy/Vite processes with Ctrl-C. Retain proof artifacts; the temporary
 * Vite config may be removed manually. No application config, database, worker or provider setup.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { pool } from '../server/db';

type Json = Record<string, any>;
type Reply = { status: number; headers: string[]; body: Buffer };
const statePath = 'data/replenishment-ack-stage118.json';
const privateProofPath = 'data/replenishment-ack-proxy-proof.json';
const publicProofPath = 'docs/replenishment-ack-proxy-qa.json';
const vitePath = 'data/replenishment-ack-vite.config.ts';
const timeoutMs = 20000,
  socketLimit = 32,
  requestLimit = 4194304,
  responseLimit = 5242880;
const uuid = z.uuid().transform((v) => v.toLowerCase());
const input = z.strictObject({
  client_key: uuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, value]) => [k, canonical(value)]),
    );
  return v;
}
const hash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
async function state() {
  const fd = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fd.stat();
    assert(st.isFile() && (st.mode & 0o777) === 0o600 && st.size <= 1048576);
    const s = JSON.parse(await fd.readFile('utf8')) as Json;
    assert(s.stage === 118 && s.setup_complete && !s.pending);
    assert.equal(s.schema_revision, '099_replenishment_plans');
    assert(/^[a-f0-9]{7,40}$/.test(s.runtime_revision));
    for (const id of [
      s.tenant,
      s.user,
      s.warehouse?.id,
      s.products?.pln?.id,
      s.products?.eur?.id,
      s.suppliers?.pln?.id,
      s.suppliers?.eur?.id,
    ])
      uuid.parse(id);
    assert.notEqual(s.products.pln.id, s.products.eur.id);
    return s;
  } finally {
    await fd.close();
  }
}
const identity = (s: Json) =>
  hash({
    tenant: s.tenant,
    user: s.user,
    warehouse: s.warehouse.id,
    products: [s.products.pln.id, s.products.eur.id],
    suppliers: [s.suppliers.pln.id, s.suppliers.eur.id],
    revision: s.runtime_revision,
    schema: s.schema_revision,
  });
async function readBody(req: IncomingMessage) {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += b.length;
    assert(bytes <= requestLimit);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
function proofHeaders(h: IncomingHttpHeaders) {
  const copy = { ...h };
  delete copy['content-length'];
  delete copy['transfer-encoding'];
  delete copy.expect;
  return copy;
}
function publicHead(r: Json) {
  const stamp = (v: Date | string) => new Date(v).toISOString();
  return JSON.parse(
    JSON.stringify({
      id: r.id,
      actor_id: r.actor_id,
      warehouse_id: r.warehouse_id,
      ...r.summary,
      scope_hash: r.scope_hash,
      groups: r.groups,
      warnings: [],
      created_at: stamp(r.created_at),
      preview_id: r.preview_id,
      state: r.state,
      before_source_version: String(r.before_source_version),
      after_source_version: String(r.after_source_version),
    }),
  );
}
async function previewProof(s: Json, previewId: string, body: z.infer<typeof input>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='8000ms'");
    const p = (
      await c.query('SELECT * FROM replenishment_previews WHERE tenant_id=$1 AND id=$2', [
        s.tenant,
        previewId,
      ])
    ).rows[0];
    assert(
      p &&
        p.ready &&
        p.actor_id === s.user &&
        p.warehouse_id === s.warehouse.id &&
        p.scope_hash === body.scope_hash,
    );
    assert.equal(p.source, 'manual');
    assert.equal(p.summary.total, 2);
    assert.equal(p.summary.purchase, 2);
    assert.equal(p.summary.unchanged, 0);
    assert.equal(p.summary.invalid, 0);
    assert.equal(p.summary.conflicts, 0);
    assert.equal(p.groups.length, 2);
    assert.deepEqual(p.groups.map((g: Json) => g.currency).sort(), ['EUR', 'PLN']);
    const rows = (
      await c.query(
        'SELECT * FROM replenishment_rows WHERE tenant_id=$1 AND preview_id=$2 ORDER BY index',
        [s.tenant, previewId],
      )
    ).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.product_id).sort(),
      [s.products.pln.id, s.products.eur.id].sort(),
    );
    for (const [currency, product, supplier, cost] of [
      ['PLN', s.products.pln, s.suppliers.pln, 125],
      ['EUR', s.products.eur, s.suppliers.eur, 250],
    ] as const) {
      const r = rows.find((r) => r.product_id === product.id);
      assert(r);
      assert.equal(r.status, 'purchase');
      assert.equal(r.result.recommended_quantity, '10');
      assert.equal(r.result.unit_cost_minor, cost);
      assert.equal(r.result.currency, currency);
      assert.equal(r.snapshot.policy.supplier_id, supplier.id);
      const g = p.groups.find((g: Json) => g.currency === currency);
      assert(g);
      assert.equal(g.supplier_id, supplier.id);
      assert.deepEqual(g.product_ids, [product.id]);
      assert.equal(g.line_count, 1);
      assert.equal(g.total_minor, String(10 * cost));
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
async function executionProof(
  s: Json,
  previewId: string,
  body: z.infer<typeof input>,
  response: Json,
) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='8000ms'");
    const e = (
      await c.query(
        'SELECT * FROM replenishment_executions WHERE tenant_id=$1 AND preview_id=$2 AND client_key=$3',
        [s.tenant, previewId, body.client_key],
      )
    ).rows[0];
    assert(
      e &&
        e.actor_id === s.user &&
        e.warehouse_id === s.warehouse.id &&
        e.scope_hash === body.scope_hash &&
        e.state === 'done',
    );
    assert.equal(e.source, 'manual');
    assert.equal(e.groups.length, 2);
    assert.deepEqual(response.execution, publicHead(e));
    assert.equal(
      (
        await c.query('SELECT count(*)::int n FROM replenishment_executions WHERE tenant_id=$1', [
          s.tenant,
        ])
      ).rows[0].n,
      1,
    );
    const orders = (
      await c.query('SELECT * FROM purchase_orders WHERE tenant_id=$1 ORDER BY id', [s.tenant])
    ).rows;
    assert.equal(orders.length, 2);
    assert.deepEqual(orders.map((p) => p.currency).sort(), ['EUR', 'PLN']);
    const executionRows = (
      await c.query(
        'SELECT * FROM replenishment_execution_rows WHERE tenant_id=$1 AND execution_id=$2 ORDER BY index',
        [s.tenant, e.id],
      )
    ).rows;
    assert.equal(executionRows.length, 2);
    for (const g of e.groups) {
      const p = orders.find((p) => p.id === g.purchase_order_id);
      assert(p);
      assert.equal(p.replenishment_execution_id, e.id);
      assert.equal(p.replenishment_group_index, g.index);
      assert.equal(p.state, 'draft');
      assert.equal(p.version, 1);
      assert.equal(p.created_by, s.user);
      assert.equal(p.warehouse_id, s.warehouse.id);
      assert.equal(p.supplier_id, g.supplier_id);
      assert.equal(p.currency, g.currency);
      assert.equal(p.number, g.number);
      const lines = (
        await c.query('SELECT * FROM purchase_order_lines WHERE tenant_id=$1 AND order_id=$2', [
          s.tenant,
          p.id,
        ])
      ).rows;
      assert.equal(lines.length, 1);
      const l = lines[0];
      const r = executionRows.find((r) => r.product_id === l.product_id);
      assert(r);
      assert.equal(r.purchase_order_id, p.id);
      assert.equal(r.status, 'purchase');
      assert.deepEqual(g.product_ids, [l.product_id]);
      assert.equal(l.quantity, 10);
      assert.equal(l.unit_cost, p.currency === 'PLN' ? 125 : 250);
      assert.equal(l.quantity * l.unit_cost, Number(g.total_minor));
      assert.equal(l.received_quantity, 0);
      assert.equal(l.closed_quantity, 0);
      assert.equal(l.sku, r.snapshot.product.sku);
      assert.equal(l.name, r.snapshot.product.name);
      assert.equal(l.supplier_sku, r.snapshot.policy.supplier_sku);
    }
    // Complete non-session own data is the retry oracle, including audit, epochs and every outbox.
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const names = (
      await c.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name)
      WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE' AND c.table_name<>'sessions' ORDER BY 1`)
    ).rows.map((r) => r.table_name as string);
    const checkpoint: Json = {};
    for (const name of [...names, 'users', 'tenants']) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const field = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${field}=$1 ORDER BY 1`, [
          name === 'users' ? s.user : s.tenant,
        ])
      ).rows;
      checkpoint[name] = { count: rows.length, sha256: hash(rows) };
    }
    await c.query('COMMIT');
    return {
      execution: response.execution,
      checkpoint,
      checkpoint_sha256: hash(checkpoint),
      purchase_order_ids: orders.map((p) => p.id),
    };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function startReplenishmentResponseDropProxy() {
  assert.equal(process.env.QA_REPLENISHMENT_DROP_PROXY, 'true');
  const setup = await state(),
    setupIdentity = identity(setup);
  const proofFd = await open(
    privateProofPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let reportFd: Awaited<ReturnType<typeof open>>;
  try {
    reportFd = await open(
      publicProofPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (e) {
    await proofFd.close();
    throw e;
  }
  const agent = new http.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4 });
  const sockets = new Set<Socket>();
  const stats: Json = {
    stage: 118,
    status: 'AWAITING_ACTUAL_EXECUTE',
    runtime_revision: setup.runtime_revision,
    schema_revision: setup.schema_revision,
    listen: '127.0.0.1:4159',
    upstream: '127.0.0.1:4100',
    tenant: setup.tenant,
    actor_id: setup.user,
    requests: 0,
    active_requests: 0,
    forwarded: 0,
    first_ack_dropped: false,
    exact_retries: 0,
    proof_failures: 0,
    errors: 0,
    events: [],
    sessions_excluded_from_retry_checkpoint: true,
    ui_verified: false,
    full_goal_complete: false,
  };
  let tail = Promise.resolve(),
    pendingWrite = Promise.resolve(),
    stopping = false;
  let captured:
    | {
        path: string;
        bodyHash: string;
        body: z.infer<typeof input>;
        proof: Awaited<ReturnType<typeof executionProof>>;
      }
    | undefined;
  const persist = () => {
    const safe = JSON.stringify(stats, null, 2) + '\n';
    const privateBytes =
      JSON.stringify(
        {
          ...stats,
          captured: captured
            ? {
                path: captured.path,
                body: captured.body,
                body_sha256: captured.bodyHash,
                checkpoint: captured.proof.checkpoint,
              }
            : null,
        },
        null,
        2,
      ) + '\n';
    pendingWrite = pendingWrite.then(async () => {
      for (const [fd, bytes] of [
        [proofFd, privateBytes],
        [reportFd, safe],
      ] as const) {
        await fd.truncate(0);
        await fd.write(bytes, 0, 'utf8');
        await fd.sync();
      }
    });
    return pendingWrite;
  };
  const event = async (kind: string, values: Json = {}) => {
    stats.events.push({ kind, at: new Date().toISOString(), ...values });
    if (stats.events.length > 64) stats.events.shift();
    await persist();
  };
  const buffered = (
    path: string,
    method: string,
    headers: IncomingHttpHeaders,
    body?: Buffer,
  ): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const up = http.request(
        { hostname: '127.0.0.1', port: 4100, path, method, headers, agent },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > responseLimit) response.destroy(new Error('QA response bound'));
            else chunks.push(chunk);
          });
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 502,
              headers: response.rawHeaders,
              body: Buffer.concat(chunks),
            }),
          );
          response.on('error', reject);
          response.on('aborted', () => reject(new Error('Incomplete response')));
        },
      );
      const deadline = setTimeout(() => up.destroy(new Error('Upstream deadline')), timeoutMs);
      deadline.unref();
      up.on('error', reject);
      up.on('close', () => clearTimeout(deadline));
      up.end(body);
    });
  const pass = (res: ServerResponse, r: Reply) => {
    stats.forwarded++;
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  };
  // Ordinary responses stream with native backpressure; neither CSV bytes nor private API responses are logged.
  const passthrough = (req: IncomingMessage, res: ServerResponse, body: Buffer) =>
    new Promise<void>((resolve, reject) => {
      const up = http.request(
        {
          hostname: '127.0.0.1',
          port: 4100,
          path: req.url,
          method: req.method,
          headers: req.headers,
          agent,
        },
        (response) => {
          stats.forwarded++;
          res.writeHead(response.statusCode ?? 502, response.rawHeaders);
          response.pipe(res);
          response.on('end', resolve);
          response.on('error', reject);
          response.on('aborted', () => reject(new Error('Incomplete passthrough')));
        },
      );
      const deadline = setTimeout(() => up.destroy(new Error('Upstream deadline')), timeoutMs);
      deadline.unref();
      const disconnected = () => {
        if (!res.writableFinished) up.destroy(new Error('Client disconnected'));
      };
      res.once('close', disconnected);
      up.on('error', reject);
      up.on('close', () => {
        clearTimeout(deadline);
        res.off('close', disconnected);
      });
      up.end(body);
    });
  const server = http.createServer(async (req, res) => {
    stats.requests++;
    stats.active_requests++;
    let release: (() => void) | undefined;
    const deadline = setTimeout(() => res.destroy(), timeoutMs * 3);
    deadline.unref();
    try {
      assert(
        !stopping &&
          stats.active_requests <= socketLimit &&
          req.url?.startsWith('/api/') &&
          !req.url.startsWith('//'),
      );
      const body = await readBody(req),
        match = req.url!.match(/^\/api\/replenishment\/previews\/([a-f0-9-]{36})\/execute$/);
      if (req.method !== 'POST' || !match || req.headers['x-workspace-id'] !== setup.tenant) {
        await passthrough(req, res, body);
        return;
      }
      const previous = tail;
      tail = new Promise<void>((done) => {
        release = done;
      });
      await previous;
      assert(!stopping && !res.destroyed);
      const rawInput = JSON.parse(body.toString('utf8'));
      const target = input.safeParse(rawInput);
      assert(target.success && body.length <= 65536);
      const parsed = target.data,
        bodyHash = hash(rawInput),
        previewId = uuid.parse(match[1]);
      if (captured && (captured.path !== req.url || captured.bodyHash !== bodyHash)) {
        // A different own request is ordinary API traffic; it cannot become the lost-ACK evidence.
        await passthrough(req, res, body);
        return;
      }
      try {
        assert.equal(identity(await state()), setupIdentity);
        const me = await buffered('/api/auth/me', 'GET', proofHeaders(req.headers));
        assert.equal(me.status, 200);
        const actor = JSON.parse(me.body.toString('utf8')).user;
        assert.equal(actor.id, setup.user);
        assert.equal(actor.tenant_id, setup.tenant);
        assert.equal(actor.role, 'admin');
        const h = await buffered('/api/health', 'GET', proofHeaders(req.headers));
        assert.equal(h.status, 200);
        const health = JSON.parse(h.body.toString('utf8'));
        assert.equal(health.revision, setup.runtime_revision);
        assert.equal(health.schema_revision, setup.schema_revision);
        assert(!health.restore_preview && health.replenishment_plans_available);
        await previewProof(setup, previewId, parsed);
      } catch {
        stats.proof_failures++;
        stats.status = 'FAIL_IDENTITY_OR_SCOPE';
        await event('own_target_identity_or_scope_not_proved', { post_forwarded: false });
        res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end('{"error":"QA own execution scope not proved"}');
        return;
      }
      if (captured) {
        const before = await executionProof(setup, previewId, parsed, {
          execution: captured.proof.execution,
        });
        assert.deepEqual(
          before.checkpoint,
          captured.proof.checkpoint,
          'Own effects changed before retry',
        );
      }
      const reply = await buffered(req.url!, 'POST', req.headers, body);
      let shouldDrop = false;
      try {
        const response = JSON.parse(reply.body.toString('utf8')) as Json;
        assert.equal(reply.status, captured ? 200 : 201);
        assert.equal(response.reused, Boolean(captured));
        const proof = await executionProof(setup, previewId, parsed, response);
        const get = await buffered(
          '/api/replenishment/executions/' + response.execution.id,
          'GET',
          proofHeaders(req.headers),
        );
        assert.equal(get.status, 200);
        assert.deepEqual(JSON.parse(get.body.toString('utf8')).execution, proof.execution);
        assert.equal(identity(await state()), setupIdentity);
        if (!captured) {
          captured = { path: req.url!, bodyHash, body: parsed, proof };
          stats.first_ack_dropped = true;
          stats.status = 'LOST_ACK_PROVED_AWAITING_RETRY';
          Object.assign(stats, {
            preview_id: previewId,
            execution_id: proof.execution.id,
            body_sha256: bodyHash,
            generated_purchase_order_ids: proof.purchase_order_ids,
            generated_currencies: ['EUR', 'PLN'],
            checkpoint_tables: Object.keys(proof.checkpoint).length,
            checkpoint_sha256: proof.checkpoint_sha256,
          });
          await event('first_complete_201_dropped_after_sql_and_get', {
            upstream_status: 201,
            readback_status: 200,
            two_own_drafts_proved: true,
          });
          shouldDrop = true;
        } else {
          assert.deepEqual(response.execution, captured.proof.execution);
          assert.deepEqual(proof.checkpoint, captured.proof.checkpoint);
          stats.exact_retries++;
          stats.status =
            stats.proof_failures || stats.errors
              ? 'RETRY_PROVED_WITH_PRIOR_FAILURE'
              : 'PASS_LOST_ACK_AND_EXACT_RETRY';
          await event('same_key_full_body_retry_proved', {
            upstream_status: 200,
            reused: true,
            effects_sha256_unchanged: true,
            ack_forwarded: true,
          });
        }
      } catch {
        stats.proof_failures++;
        stats.status = 'FAIL_EVIDENCE';
        await event('insufficient_postcommit_proof_ack_forwarded', {
          upstream_status: reply.status,
          ack_forwarded: true,
        });
      }
      if (shouldDrop) res.destroy();
      else pass(res, reply);
    } catch {
      stats.errors++;
      stats.status = 'FAIL_PROXY';
      await event('proxy_request_failed', { private_details_suppressed: true }).catch(() => {});
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end('{"error":"QA loopback proxy failed"}');
      } else res.destroy();
    } finally {
      release?.();
      clearTimeout(deadline);
      stats.active_requests--;
      await persist().catch(() => res.destroy());
    }
  });
  server.maxHeadersCount = 100;
  server.requestTimeout = timeoutMs;
  server.headersTimeout = timeoutMs;
  server.keepAliveTimeout = 5000;
  server.on('connection', (socket) => {
    if (sockets.size >= socketLimit) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const closed = new Promise<void>((done) => server.close(() => done()));
    const force = setTimeout(() => {
      for (const s of sockets) s.destroy();
      agent.destroy();
    }, 5000);
    force.unref();
    await closed;
    clearTimeout(force);
    agent.destroy();
    await tail;
    while (stats.active_requests > 0) await delay(20);
    await pendingWrite;
    stats.stopped_at = new Date().toISOString();
    await persist();
    await proofFd.close();
    await reportFd.close();
    await pool.end();
  };
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(4159, '127.0.0.1', () => {
        server.off('error', reject);
        done();
      });
    });
    await persist();
  } catch (e) {
    agent.destroy();
    server.close();
    stats.status = 'PROXY_NOT_STARTED';
    await persist().catch(() => {});
    await proofFd.close();
    await reportFd.close();
    await pool.end();
    throw e;
  }
  return { shutdown };
}
export async function prepareReplenishmentAckVite() {
  assert.equal(process.env.QA_REPLENISHMENT_DROP_PROXY, 'true');
  await state();
  const fd = await open(
    vitePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await fd.writeFile(`import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],root:'web',server:{host:'127.0.0.1',port:5189,strictPort:true,
proxy:{'/api/':{target:'http://127.0.0.1:4159',configure(proxy){proxy.on('proxyReq',(up,req)=>{
if(req.headers.origin==='http://127.0.0.1:5189')up.setHeader('origin','http://127.0.0.1:5173');
});}}}}});\n`);
    await fd.sync();
  } finally {
    await fd.close();
  }
}
if (process.argv[1]?.endsWith('/replenishment-response-drop-proxy.ts')) {
  try {
    if (process.argv[2] === 'prepare-vite') {
      await prepareReplenishmentAckVite();
      await pool.end();
      console.log({
        status: 'QA_VITE_CONFIG_PREPARED',
        listen: '127.0.0.1:5189',
        existing_config_changed: false,
      });
    } else {
      assert.equal(process.argv[2], 'run');
      const proxy = await startReplenishmentResponseDropProxy();
      const stop = () => {
        void proxy.shutdown().catch(() => {
          process.exitCode = 1;
        });
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      console.log({
        status: 'READY',
        qa_only: true,
        listen: '127.0.0.1:4159',
        upstream: '127.0.0.1:4100',
        credentials_logged: false,
      });
    }
  } catch {
    console.error({ status: 'PROXY_NOT_STARTED', private_details_suppressed: true });
    await pool.end().catch(() => {});
    process.exitCode = 1;
  }
}
