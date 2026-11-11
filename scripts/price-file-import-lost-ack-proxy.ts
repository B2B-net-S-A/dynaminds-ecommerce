/** Root-only, host-native QA130. Importing this file does not start a listener.
 * From the primary app directory after reviewed source/setup:
 * DYNA_WORKER_DISABLED=true QA_PRICE_FILE_IMPORT_LOST_ACK_PROXY=true \
 * QA_EXPECTED_REVISION=<actual 40-char SHA> tsx scripts/price-file-import-lost-ack-proxy.ts run
 * Chrome: http://127.0.0.1:5174. Actual Vite5173/API4100 must already be running.
 * No DB access, login, direct mutation, automatic resend, offline mode or production Origin change.
 * The first validated own-fixture execution201 is dropped only after its COMPLETE upstream
 * response and authenticated durable GET readback. Only a browser-sent exact retry200/reused
 * with the SAME execution ID completes this transport proof. Other actors cannot arm it.
 * PASS is transport evidence, also possible with a headless HTTP client. Root must separately
 * attest actual Chrome unknown-state, manual button, visible result and preserved business data.
 * Cookies/headers/file contents stay in RAM; the bounded public report contains hashes/counters.
 * A fresh wx report is required. Ctrl-C closes only this helper's listener/sockets.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const appRoot = '<workspace>/app';
const statePath = appRoot + '/data/price-file-import-stage130.json';
const reportPath = appRoot + '/docs/price-file-import-lost-ack-proxy-qa.json';
const proxyOrigin = 'http://127.0.0.1:5174';
const sourceOrigin = 'http://127.0.0.1:5173';
const requestLimit = 4194304,
  responseLimit = 16777216,
  socketLimit = 32,
  timeoutMs = 30000;
const uuid = z.uuid();
const setupSchema = z.object({
  stage: z.literal(130),
  setup_complete: z.literal(true),
  pending: z.null(),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  schema_revision: z.literal('113_price_file_imports'),
  tenant: uuid,
  user: uuid,
  warehouse: uuid,
  products: z.array(z.object({ id: uuid })).length(53),
  pln: z.object({ id: uuid, currency: z.literal('PLN') }),
  eur: z.object({ id: uuid, currency: z.literal('EUR') }),
  setup_checkpoint: z.record(
    z.string(),
    z.object({ count: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  ),
});
type Setup = z.infer<typeof setupSchema>;
type Json = Record<string, unknown>;
type Reply = { status: number; headers: string[]; body: Buffer };
const executeInput = z.strictObject({
  client_key: uuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  ack_missing_prices: z.boolean().optional(),
});
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return value;
}
const jsonHash = (value: unknown) => sha(JSON.stringify(canonical(value)));
function object(value: unknown): Json {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected bounded object',
  );
  return value as Json;
}
function decode(reply: Reply): Json {
  return object(JSON.parse(reply.body.toString('utf8')));
}
async function setup() {
  const fd = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fd.stat();
    assert(
      st.isFile() && (st.mode & 0o777) === 0o600 && st.size > 0 && st.size <= 8388608,
      'Private bounded0600 fixture required',
    );
    const bytes = await fd.readFile();
    const s = setupSchema.parse(JSON.parse(bytes.toString('utf8')));
    assert.equal(s.revision, process.env.QA_EXPECTED_REVISION);
    assert.notEqual(s.pln.id, s.eur.id);
    assert.equal(new Set(s.products.map((p) => p.id)).size, 53);
    assert(
      Object.keys(s.setup_checkpoint).length > 200,
      'Complete owned fixture checkpoint required',
    );
    return { state: s, sha256: sha(bytes) };
  } finally {
    await fd.close();
  }
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    assert(size <= requestLimit, 'QA request limit exceeded');
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
function headers(original: IncomingHttpHeaders, port: number, size?: number) {
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
  delete out['content-length'];
  delete out['x-forwarded-host'];
  delete out['x-forwarded-proto'];
  out.host = `127.0.0.1:${port}`;
  out['accept-encoding'] = 'identity';
  if (out.origin === proxyOrigin) out.origin = sourceOrigin;
  if (size !== undefined) out['content-length'] = String(size);
  return out;
}
function pass(res: ServerResponse, reply: Reply) {
  // Preserve Set-Cookie verbatim, including duplicate cookie headers; loopback host is unchanged.
  const pairs: string[] = [];
  for (let i = 0; i < reply.headers.length; i += 2) {
    const key = reply.headers[i].toLowerCase();
    if (
      ![
        'connection',
        'keep-alive',
        'transfer-encoding',
        'content-length',
        'trailer',
        'upgrade',
      ].includes(key)
    )
      pairs.push(reply.headers[i], reply.headers[i + 1]);
  }
  pairs.push('Content-Length', String(reply.body.length), 'Connection', 'close');
  res.writeHead(reply.status, pairs);
  res.end(reply.body);
}

export async function startPriceFileImportLostAckProxy() {
  assert.equal(resolve(process.cwd()), appRoot, 'Run only from the primary app directory');
  assert.equal(process.env.QA_PRICE_FILE_IMPORT_LOST_ACK_PROXY, 'true');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.match(process.env.QA_EXPECTED_REVISION ?? '', /^[a-f0-9]{40}$/);
  const initial = await setup(),
    s: Setup = initial.state;
  const agent = new http.Agent({ keepAlive: false, maxSockets: 32 });
  const upstreams = new Set<http.ClientRequest>(),
    sockets = new Set<Socket>();
  function upstream(
    path: string,
    method: string,
    h: IncomingHttpHeaders,
    b?: Buffer,
    port = 4100,
  ): Promise<Reply> {
    return new Promise((resolveReply, reject) => {
      const request = http.request(
        { hostname: '127.0.0.1', port, path, method, headers: h, agent },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > responseLimit) response.destroy(new Error('QA response limit'));
            else chunks.push(chunk);
          });
          response.on('aborted', () => reject(new Error('Incomplete upstream response')));
          response.on('error', reject);
          response.on('end', () => {
            if (!response.complete) reject(new Error('Incomplete upstream response'));
            else
              resolveReply({
                status: response.statusCode ?? 502,
                headers: response.rawHeaders,
                body: Buffer.concat(chunks),
              });
          });
        },
      );
      upstreams.add(request);
      const timer = setTimeout(() => request.destroy(new Error('QA upstream deadline')), timeoutMs);
      timer.unref();
      request.on('close', () => {
        clearTimeout(timer);
        upstreams.delete(request);
      });
      request.on('error', reject);
      if (b) request.write(b);
      request.end();
    });
  }
  async function health() {
    const reply = await upstream('/api/health', 'GET', { host: '127.0.0.1:4100' });
    assert.equal(reply.status, 200);
    const h = decode(reply);
    assert.equal(h.status, 'ok');
    assert.equal(h.mode, 'local');
    assert.equal(h.revision, s.revision);
    assert.equal(h.schema_revision, s.schema_revision);
    assert.equal(h.price_file_import_available, true);
    assert.equal(h.background_workers_enabled, false);
    assert.equal(h.restore_preview, false);
  }
  async function principal(h: IncomingHttpHeaders) {
    assert.equal(h['x-workspace-id'], s.tenant, 'Exact QA workspace required');
    assert(typeof h.cookie === 'string' && h.cookie.length > 0, 'Actual browser cookie required');
    assert(!h.authorization, 'QA source principal must use the browser cookie');
    const reply = await upstream('/api/auth/me', 'GET', headers(h, 4100));
    assert.equal(reply.status, 200);
    const user = object(decode(reply).user);
    assert.equal(user.id, s.user);
    assert.equal(user.tenant_id, s.tenant);
    assert.equal(user.role, 'admin');
  }
  async function get(path: string, h: IncomingHttpHeaders) {
    const reply = await upstream(path, 'GET', headers(h, 4100));
    assert.equal(reply.status, 200);
    const d = decode(reply);
    assert.equal(d.available, true);
    assert.equal(d.current_role, 'admin');
    assert.equal(d.can_read, true);
    assert.equal(d.can_write, true);
    assert.equal(d.read_only, false);
    return d;
  }
  async function rows(path: string, h: IncomingHttpHeaders, total: number) {
    assert(
      Number.isInteger(total) && total >= 1 && total <= 53,
      'Bounded genuine fixture rows required',
    );
    const all: Json[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const d = await get(path + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''), h),
        meta = object(d.meta);
      assert.equal(meta.total, total);
      assert(Array.isArray(d.data));
      all.push(...d.data.map(object));
      assert(all.length <= total);
      assert(
        meta.cursor === null ||
          (typeof meta.cursor === 'string' && /^(0|[1-9][0-9]{0,2})$/.test(meta.cursor)),
      );
      cursor = meta.cursor as string | null;
      if (cursor) {
        assert(!seen.has(cursor));
        seen.add(cursor);
      }
    } while (cursor);
    assert.equal(all.length, total);
    assert.equal(new Set(all.map((r) => r.index)).size, total);
    const owned = new Set(s.products.map((p) => p.id));
    for (const row of all) {
      assert(owned.has(uuid.parse(row.product_id)));
      assert(['changed', 'unchanged'].includes(String(row.status)));
      assert.deepEqual(row.errors, []);
    }
    assert.equal(new Set(all.map((r) => r.product_id)).size, total);
    return all;
  }
  await health();
  const proof = await open(
    reportPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o644,
  );
  const report = {
    stage: 130,
    status: 'IN_PROGRESS',
    phase: 'lost_response_transport',
    revision: s.revision,
    schema_revision: s.schema_revision,
    listen: '127.0.0.1:5174',
    vite_upstream: '127.0.0.1:5173',
    api_upstream: '127.0.0.1:4100',
    started_at: new Date().toISOString(),
    stopped_at: null as string | null,
    setup_file_sha256: initial.sha256,
    tenant_sha256: sha(s.tenant),
    principal_sha256: sha(s.user),
    dropped_successful_responses: 0,
    exact_retries: 0,
    errors: 0,
    browser_attestation: false,
    manual_retry_human_verified: false,
    headless_supported: true,
    physical_checkpoint_verified: false,
    full_goal_complete: false,
    evidence: null as null | {
      path_sha256: string;
      request_body_sha256: string;
      canonical_body_sha256: string;
      client_key_sha256: string;
      scope_hash: string;
      preview_id_sha256: string;
      frozen_rows_sha256: string;
      execution_id: string;
      execution_head_sha256: string;
      first_status: number;
      first_reused: boolean;
      first_full_response_bytes: number;
      dropped_at: string;
      retry_status?: number;
      retry_reused?: boolean;
      retry_same_execution?: boolean;
      retry_at?: string;
    },
    note: 'PASS covers fully committed response loss and exact replay transport only. Root must separately attach actual Chrome unknown-state/manual retry observations and native preservation evidence.',
  };
  let writes = Promise.resolve();
  function persist() {
    const text = JSON.stringify(report, null, 2) + '\n';
    writes = writes.then(async () => {
      await proof.truncate(0);
      await proof.write(text, 0, 'utf8');
      await proof.sync();
    });
    return writes;
  }
  let captured: { path: string; body: Buffer; execution: Json; rowHash: string } | null = null;
  let targetBusy = false,
    shuttingDown = false,
    halted = false;
  const server = http.createServer(async (req, res) => {
    let ownTarget = false;
    try {
      assert(!shuttingDown && !halted, 'QA proxy stopped or halted');
      assert.equal(req.socket.remoteAddress, '127.0.0.1');
      assert.equal(req.headers.host, '127.0.0.1:5174');
      assert(
        typeof req.url === 'string' &&
          req.url.startsWith('/') &&
          !req.url.startsWith('//') &&
          !/[\r\n]/.test(req.url),
      );
      if (req.headers.origin)
        assert(
          [proxyOrigin, sourceOrigin, 'http://127.0.0.1:4100'].includes(req.headers.origin),
          'Unsupported Origin',
        );
      const url = new URL(req.url, proxyOrigin);
      assert.equal(url.origin, proxyOrigin);
      const isApi = url.pathname.startsWith('/api/');
      assert(
        isApi
          ? ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'].includes(req.method ?? '')
          : ['GET', 'HEAD'].includes(req.method ?? ''),
      );
      const declared = Number(req.headers['content-length'] ?? 0);
      assert(Number.isSafeInteger(declared) && declared >= 0 && declared <= requestLimit);
      if (isApi && req.headers['x-workspace-id'])
        assert.equal(req.headers['x-workspace-id'], s.tenant, 'Other workspace refused');
      const payload = await body(req),
        forward = headers(req.headers, isApi ? 4100 : 5173, payload.length);
      const match =
        isApi &&
        req.method === 'POST' &&
        !url.search &&
        /^\/api\/price-file-imports\/previews\/([0-9a-f-]{36})\/execute$/.exec(url.pathname);
      if (!match) {
        pass(
          res,
          await upstream(req.url, req.method ?? 'GET', forward, payload, isApi ? 4100 : 5173),
        );
        return;
      }
      assert(!targetBusy, 'Overlapping target refused; manual retry required');
      targetBusy = true;
      ownTarget = true;
      await health();
      const current = await setup();
      assert.equal(current.sha256, initial.sha256, 'Setup bytes changed');
      await principal(req.headers);
      assert(
        payload.length <= 4096 &&
          /^application\/json(?:;|$)/i.test(String(req.headers['content-type'] ?? '')),
      );
      const input = executeInput.parse(JSON.parse(payload.toString('utf8'))),
        previewId = uuid.parse(match[1]);
      if (captured && report.status !== 'PASS') {
        assert.equal(req.url, captured.path, 'Different target while ACK unknown');
        assert(payload.equals(captured.body), 'Only exact browser retry permitted');
      }
      let frozen: Json[] | null = null;
      if (!captured) {
        const d = await get(`/api/price-file-imports/previews/${previewId}`, req.headers),
          preview = object(d.preview),
          summary = object(preview.summary),
          list = object(preview.list_snapshot);
        assert.equal(preview.id, previewId);
        assert.equal(preview.actor_id, s.user);
        assert.equal(preview.scope_hash, input.scope_hash);
        assert.equal(preview.can_execute, true);
        assert.equal(preview.execution_id, null);
        assert.equal(summary.ready, true);
        assert.equal(summary.invalid, 0);
        assert.equal(summary.conflicts, 0);
        assert([s.pln.id, s.eur.id].includes(uuid.parse(list.id)));
        frozen = await rows(
          `/api/price-file-imports/previews/${previewId}/rows`,
          req.headers,
          Number(summary.total),
        );
      }
      // Exactly one pass-through. Never retry this HTTP request from the proxy.
      const reply = await upstream(req.url, 'POST', forward, payload);
      if (!captured && reply.status === 201) {
        const d = decode(reply),
          execution = object(d.execution);
        assert.equal(d.reused, false);
        uuid.parse(execution.id);
        assert.equal(execution.actor_id, s.user);
        assert.equal(execution.preview_id, previewId);
        assert.equal(execution.scope_hash, input.scope_hash);
        const durable = await get(
          `/api/price-file-imports/executions/${execution.id}`,
          req.headers,
        );
        assert.deepEqual(durable.execution, execution);
        const durableRows = await rows(
          `/api/price-file-imports/executions/${execution.id}/rows`,
          req.headers,
          Number(object(execution.summary).total),
        );
        assert(frozen);
        assert.equal(jsonHash(durableRows), jsonHash(frozen));
        assert.equal(report.dropped_successful_responses, 0);
        assert(
          !res.destroyed && !req.aborted && res.socket && !res.socket.destroyed,
          'Live browser response socket required before intentional loss',
        );
        captured = {
          path: req.url,
          body: Buffer.from(payload),
          execution,
          rowHash: jsonHash(durableRows),
        };
        report.evidence = {
          path_sha256: sha(req.url),
          request_body_sha256: sha(payload),
          canonical_body_sha256: jsonHash(input),
          client_key_sha256: sha(input.client_key),
          scope_hash: input.scope_hash,
          preview_id_sha256: sha(previewId),
          frozen_rows_sha256: captured.rowHash,
          execution_id: String(execution.id),
          execution_head_sha256: jsonHash(execution),
          first_status: 201,
          first_reused: false,
          first_full_response_bytes: reply.body.length,
          dropped_at: new Date().toISOString(),
        };
        report.dropped_successful_responses = 1;
        await persist();
        res.destroy();
        return; // FULL committed upstream/readback exists, no ACK headers sent.
      }
      if (captured && req.url === captured.path && payload.equals(captured.body)) {
        assert.equal(reply.status, 200);
        const d = decode(reply);
        assert.equal(d.reused, true);
        assert.deepEqual(d.execution, captured.execution);
        const durable = await get(
          `/api/price-file-imports/executions/${captured.execution.id}`,
          req.headers,
        );
        assert.deepEqual(durable.execution, captured.execution);
        const durableRows = await rows(
          `/api/price-file-imports/executions/${captured.execution.id}/rows`,
          req.headers,
          Number(object(captured.execution.summary).total),
        );
        assert.equal(jsonHash(durableRows), captured.rowHash);
        assert(report.evidence);
        report.exact_retries++;
        Object.assign(report.evidence, {
          retry_status: 200,
          retry_reused: true,
          retry_same_execution: true,
          retry_at: new Date().toISOString(),
        });
        assert.equal(report.dropped_successful_responses, 1);
        report.status = 'PASS';
        await persist();
      }
      pass(res, reply);
    } catch {
      report.errors++;
      if (ownTarget) {
        halted = true;
        report.status = 'NOT_PROVEN';
      }
      await persist().catch(() => {
        halted = true;
      });
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, {
          'Content-Type': 'application/problem+json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            detail:
              'Proxy QA nie potwierdziło żądania. Nie ponowiło go automatycznie; sprawdź wynik i raport.',
          }),
        );
      } else res.destroy();
    } finally {
      if (ownTarget) targetBusy = false;
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = timeoutMs * 3;
  server.on('connection', (socket) => {
    if (sockets.size >= socketLimit) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
  });
  async function close() {
    if (shuttingDown) return;
    shuttingDown = true;
    const done = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    for (const request of upstreams) request.destroy();
    for (const socket of sockets) socket.destroy();
    agent.destroy();
    await done;
    report.stopped_at = new Date().toISOString();
    await persist();
    await proof.close();
    process.off('SIGINT', signal);
    process.off('SIGTERM', signal);
  }
  const signal = () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(5174, '127.0.0.1', () => {
        server.off('error', reject);
        resolveListen();
      });
    });
    await persist();
    process.on('SIGINT', signal);
    process.on('SIGTERM', signal);
    process.stdout.write(
      'QA130 proxy listening on 127.0.0.1:5174; actual Chrome attestation remains separate.\n',
    );
    return { server, close };
  } catch {
    agent.destroy();
    for (const socket of sockets) socket.destroy();
    report.status = 'NOT_PROVEN';
    report.errors++;
    await persist();
    await proof.close();
    throw new Error('QA130 proxy startup refused');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], 'run', 'Explicit run phase required');
  startPriceFileImportLostAckProxy().catch(() => {
    process.stderr.write(
      'QA130 proxy refused or failed. No request was automatically replayed; inspect sanitized report if created.\n',
    );
    process.exitCode = 1;
  });
}
