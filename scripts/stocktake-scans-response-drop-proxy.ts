/**
 * QA only, explicit root launch; importing this source starts no server.
 * QA_RESPONSE_DROP_PROXY=true tsx scripts/stocktake-scans-response-drop-proxy.ts run
 * Loopback4154 forwards to loopback4100. No application/Vite/Origin changes here.
 *
 * PRIVATE control file data/stocktake-scans-response-drop-control.json, regular0600:
 * {"version":1,"mode":"armed","arm_id":"<fresh UUID>","engine":"wms",
 *  "stocktake_id":"<own UUID>","client_key":"next",
 *  "line_id":"<exact own line UUID>","code":"001130000007",
 *  "tenant_id":"<own UUID>","operator_id":"<own operator UUID>",
 *  "operation":"increment","body_sha256":"<optional canonical JSON SHA256>"}
 * client_key: exact UUID or "next"; next REQUIRES exact line_id and code.
 * engine: wms|quantity; operation: start|increment. No credentials in this file.
 * Own operator auth200 is required BEFORE forwarding a targeted armed POST.
 * Unproved identity on that target returns QA403 without forwarding its POST.
 * First authenticated target binds its real UUID key and full canonical body.
 * Only valid201 + immutable same-cookie readback200 permits its ACK to be dropped.
 * Same arm/key/body retries200 remain dropped. Set mode:"released" manually to
 * release ACKs; they still forward to the real API. New arm_id explicitly rearms.
 * Released captured retries record proof only for exact key/body + canonical200
 * reused receipt. Uncaptured released arms remain ordinary passthrough.
 * Arm target cannot change under the same arm_id. No reset/account/control routes.
 * Stats file data/stocktake-scans-response-drop-stats.json is created0600wx;
 * retain it after shutdown. Move previous own stats explicitly before another run.
 * Neither file is a production config. No UI/browser/hardware attestation is made.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { z } from 'zod';

const controlPath = 'data/stocktake-scans-response-drop-control.json';
const statsPath = 'data/stocktake-scans-response-drop-stats.json';
const requestLimit = 16384,
  responseLimit = 5242880,
  timeoutMs = 20000,
  socketLimit = 64;
const uuid = z.uuid().transform((v) => v.toLowerCase());
const code = z
  .string()
  .refine(
    (v) =>
      v.length >= 1 &&
      v.length <= 80 &&
      v === v.trim() &&
      !/[\u0000-\u001f\u007f]/u.test(v) &&
      Buffer.from(v, 'utf8').toString('utf8') === v,
  );
const controlSchema = z
  .strictObject({
    version: z.literal(1),
    mode: z.enum(['armed', 'released']),
    arm_id: uuid,
    engine: z.enum(['wms', 'quantity']),
    stocktake_id: uuid,
    client_key: z.union([uuid, z.literal('next')]),
    line_id: uuid.optional(),
    code: code.optional(),
    tenant_id: uuid,
    operator_id: uuid,
    operation: z.enum(['start', 'increment']),
    body_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.client_key === 'next' && (!v.line_id || !v.code))
      ctx.addIssue({ code: 'custom', message: 'Next key requires exact line_id and code' });
  });
type Control = z.infer<typeof controlSchema>;
type Receipt = Record<string, unknown>;
type Arm = {
  identity: string;
  bodyHash?: string;
  capturedKey?: string;
  tail: Promise<void>;
  receipt?: Receipt;
  receiptId?: string;
  drops: number;
};
type Upstream = { status: number; headers: string[]; body: Buffer };
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
const object = (value: unknown): Receipt | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Receipt) : null;
async function readControl(): Promise<Control> {
  const fd = await open(controlPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fd.stat();
    assert(
      st.isFile() && (st.mode & 0o777) === 0o600 && st.size <= 4096,
      'Private bounded0600 control required',
    );
    return controlSchema.parse(JSON.parse(await fd.readFile('utf8')));
  } finally {
    await fd.close();
  }
}
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    assert(bytes <= requestLimit, 'Bounded QA request required');
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

export async function startStocktakeScansResponseDropProxy() {
  assert.equal(process.env.QA_RESPONSE_DROP_PROXY, 'true', 'Explicit QA proxy launch required');
  await readControl();
  const statsFd = await open(
    statsPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  const agent = new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 });
  const sockets = new Set<Socket>();
  const arms = new Map<string, Arm>();
  const stats = {
    stage: 113,
    listen: '127.0.0.1:4154',
    upstream: '127.0.0.1:4100',
    started_at: new Date().toISOString(),
    state: 'starting',
    requests: 0,
    forwarded: 0,
    matching: 0,
    dropped: 0,
    proof_failures: 0,
    errors: 0,
    released: 0,
    active_requests: 0,
    events: [] as Record<string, unknown>[],
    captured_arms: [] as Record<string, unknown>[],
    ui_verified: false,
  };
  let pendingWrite: Promise<void> = Promise.resolve(),
    shuttingDown = false;
  const persist = () => {
    const bytes = JSON.stringify(stats, null, 2) + '\n';
    pendingWrite = pendingWrite.then(async () => {
      await statsFd.truncate(0);
      await statsFd.write(bytes, 0, 'utf8');
      await statsFd.sync();
    });
    return pendingWrite;
  };
  const event = (kind: string, values: Record<string, unknown> = {}) => {
    stats.events.push({ kind, at: new Date().toISOString(), ...values });
    if (stats.events.length > 128) stats.events.shift();
    return persist();
  };
  const request = (
    path: string,
    method: string,
    headers: IncomingHttpHeaders,
    body?: Buffer,
  ): Promise<Upstream> =>
    new Promise((resolve, reject) => {
      const upstream = http.request(
        { hostname: '127.0.0.1', port: 4100, path, method, headers, agent },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > responseLimit)
              response.destroy(new Error('Bounded upstream response required'));
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
          response.on('aborted', () => reject(new Error('Upstream response incomplete')));
        },
      );
      const deadline = setTimeout(
        () => upstream.destroy(new Error('Upstream deadline exceeded')),
        timeoutMs,
      );
      deadline.unref();
      upstream.on('error', reject);
      upstream.on('close', () => clearTimeout(deadline));
      if (body?.length) upstream.write(body);
      upstream.end();
    });
  const getHeaders = (headers: IncomingHttpHeaders) => {
    // Proof GET has no entity body. Preserve cookie/workspace/origin/authorization.
    const copy = { ...headers };
    delete copy['content-length'];
    delete copy['transfer-encoding'];
    delete copy['expect'];
    return copy;
  };
  const decode = (reply: Upstream) => object(JSON.parse(reply.body.toString('utf8')));
  const pass = (res: ServerResponse, reply: Upstream) => {
    res.writeHead(reply.status, reply.headers);
    res.end(reply.body);
    stats.forwarded++;
  };
  const server = http.createServer(async (req, res) => {
    stats.requests++;
    stats.active_requests++;
    const deadline = setTimeout(() => res.destroy(), timeoutMs * 3);
    deadline.unref();
    let releaseArm: (() => void) | undefined;
    try {
      assert(
        !shuttingDown &&
          stats.active_requests <= socketLimit &&
          req.url?.startsWith('/') &&
          !req.url.startsWith('//'),
      );
      const body = await readBody(req),
        method = req.method ?? 'GET',
        path = req.url!;
      let cfg: Control | null = null;
      try {
        cfg = await readControl();
      } catch {
        /* Invalid/unavailable control always disarms; ordinary forwarding remains safe. */
      }
      const expectedPath = cfg
        ? `/api/${cfg.engine === 'wms' ? 'wms-lots/stocktakes' : 'stocktakes'}/${cfg.stocktake_id}/${cfg.operation === 'start' ? 'scan-start' : 'scans'}`
        : null;
      let parsed: Receipt | null = null;
      try {
        parsed = object(JSON.parse(body.toString('utf8')));
      } catch {
        /* Upstream validates all request bodies. */
      }
      const key = uuid.safeParse(parsed?.client_key);
      const line = uuid.safeParse(parsed?.line_id);
      const matches =
        method === 'POST' &&
        path === expectedPath &&
        key.success &&
        (cfg?.client_key === 'next' || key.data === cfg?.client_key) &&
        (!cfg?.line_id || (line.success && line.data === cfg.line_id)) &&
        (!cfg?.code || parsed?.code === cfg.code);
      if (!matches || !key.success || !cfg || cfg.mode === 'released') {
        if (matches && cfg?.mode === 'released') stats.released++;
        const reply = await request(path, method, req.headers, body);
        // Forward the actual ACK even when the QA evidence below cannot be proved.
        pass(res, reply);
        if (matches && key.success && cfg?.mode === 'released') {
          const captured = arms.get(cfg.arm_id);
          if (captured?.capturedKey) {
            const bodyHash = hash(JSON.stringify(canonical(parsed)));
            try {
              assert.equal(captured.identity, hash(JSON.stringify({ ...cfg, mode: undefined })));
              assert.equal(key.data, captured.capturedKey);
              assert.equal(bodyHash, captured.bodyHash);
              assert(captured.receipt && captured.receiptId && captured.drops > 0);
              assert.equal(reply.status, 200);
              const result = decode(reply),
                scan = object(result?.scan);
              assert.equal(result?.reused, true);
              assert.equal(
                JSON.stringify(canonical(scan)),
                JSON.stringify(canonical(captured.receipt)),
              );
              await event('released_ack_exact_retry_proved', {
                arm_id: cfg.arm_id,
                client_key: captured.capturedKey,
                body_sha256: bodyHash,
                receipt_id: captured.receiptId,
                upstream_status: reply.status,
                reused: true,
                ack_forwarded: true,
              });
            } catch {
              stats.proof_failures++;
              await event('released_ack_exact_retry_not_proved', {
                arm_id: cfg.arm_id,
                client_key: key.data,
                body_sha256: bodyHash,
                captured_receipt_id: captured.receiptId ?? null,
                upstream_status: reply.status,
                ack_forwarded: true,
              });
            }
          }
        }
        return;
      }
      stats.matching++;
      const bodyHash = hash(JSON.stringify(canonical(parsed))),
        rawHash = hash(body);
      const identity = hash(JSON.stringify({ ...cfg, mode: undefined }));
      let arm = arms.get(cfg.arm_id);
      if (!arm) {
        assert(arms.size < 20, 'QA arms bound exceeded');
        arm = { identity, drops: 0, tail: Promise.resolve() };
        arms.set(cfg.arm_id, arm);
      }
      // Serialize only this bounded exact target. A concurrent retry cannot get
      // its ACK before the first201 has been proved and its receipt frozen.
      const before = arm.tail;
      arm.tail = new Promise<void>((resolve) => {
        releaseArm = resolve;
      });
      await before;
      if (
        arm.identity !== identity ||
        (cfg.body_sha256 && bodyHash !== cfg.body_sha256) ||
        (arm.capturedKey && (key.data !== arm.capturedKey || bodyHash !== arm.bodyHash))
      ) {
        pass(res, await request(path, method, req.headers, body));
        return;
      }
      try {
        const current = await readControl();
        assert.equal(hash(JSON.stringify({ ...current, mode: undefined })), identity);
        assert.equal(current.mode, 'armed');
        const me = await request('/api/auth/me', 'GET', getHeaders(req.headers));
        assert.equal(me.status, 200);
        const user = object(decode(me)?.user);
        assert.equal(user?.id, cfg.operator_id);
        assert.equal(user?.tenant_id, cfg.tenant_id);
        assert.equal(user?.role, 'operator');
        // Auth may wait; release or target changes during that wait disarm too.
        const authorizedControl = await readControl();
        assert.equal(hash(JSON.stringify({ ...authorizedControl, mode: undefined })), identity);
        assert.equal(authorizedControl.mode, 'armed');
      } catch {
        stats.proof_failures++;
        await event('pre_forward_identity_not_proved_post_blocked', {
          arm_id: cfg.arm_id,
          response_status: 403,
          post_forwarded: false,
        });
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end('{"error":"QA target operator identity not proved"}');
        return;
      }
      if (!arm.capturedKey) {
        arm.capturedKey = key.data;
        arm.bodyHash = bodyHash;
        stats.captured_arms.push({
          arm_id: cfg.arm_id,
          engine: cfg.engine,
          stocktake_id: cfg.stocktake_id,
          line_id: line.success ? line.data : null,
          client_key: key.data,
          body_sha256: bodyHash,
        });
        await event('target_captured_before_forward', {
          arm_id: cfg.arm_id,
          client_key: key.data,
          body_sha256: bodyHash,
        });
      }
      const reply = await request(path, method, req.headers, body);
      try {
        assert.equal(arm.identity, identity, 'An arm target cannot change');
        if (cfg.body_sha256) assert.equal(bodyHash, cfg.body_sha256);
        if (arm.bodyHash)
          assert.equal(bodyHash, arm.bodyHash, 'Same key requires exact canonical body');
        assert.equal(reply.status, arm.receipt ? 200 : 201);
        const result = decode(reply),
          scan = object(result?.scan);
        assert(scan && typeof scan.id === 'string' && z.uuid().safeParse(scan.id).success);
        assert.equal(result?.reused, Boolean(arm.receipt));
        assert.equal(scan.engine, cfg.engine);
        assert.equal(scan.stocktake_id, cfg.stocktake_id);
        assert.equal(scan.kind, cfg.operation);
        assert.equal(scan.line_id, line.success ? line.data : parsed?.line_id);
        assert.equal(scan.code, parsed?.code);
        if (arm.receipt)
          assert.equal(JSON.stringify(canonical(scan)), JSON.stringify(canonical(arm.receipt)));
        const readback = await request(
          `${expectedPath!.slice(0, expectedPath!.lastIndexOf('/'))}/scans/${scan.id}`,
          'GET',
          getHeaders(req.headers),
        );
        assert.equal(readback.status, 200);
        assert.equal(
          JSON.stringify(canonical(decode(readback)?.scan)),
          JSON.stringify(canonical(scan)),
        );
        const now = await readControl();
        assert.equal(
          hash(JSON.stringify({ ...now, mode: undefined })),
          identity,
          'Control changed during proof',
        );
        if (now.mode === 'released') {
          stats.released++;
          pass(res, reply);
          return;
        }
        arm.bodyHash = bodyHash;
        arm.receipt = scan;
        arm.receiptId = scan.id;
        arm.drops++;
        stats.dropped++;
        await event('ack_dropped_after_canonical_readback', {
          arm_id: cfg.arm_id,
          engine: cfg.engine,
          stocktake_id: cfg.stocktake_id,
          client_key: arm.capturedKey,
          receipt_id: scan.id,
          upstream_status: reply.status,
          readback_status: 200,
          body_sha256: bodyHash,
          raw_body_sha256: rawHash,
          drop_count: arm.drops,
        });
        res.destroy();
      } catch {
        // Lack of proof is never a reason to hide a real API response.
        stats.proof_failures++;
        await event('proof_not_sufficient_ack_forwarded', {
          arm_id: cfg.arm_id,
          upstream_status: reply.status,
          body_sha256: bodyHash,
          raw_body_sha256: rawHash,
        });
        pass(res, reply);
      }
    } catch {
      stats.errors++;
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end('{"error":"QA loopback proxy request failed"}');
      } else res.destroy();
    } finally {
      releaseArm?.();
      clearTimeout(deadline);
      stats.active_requests--;
      await persist().catch(() => {
        res.destroy();
      });
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
    if (shuttingDown) return;
    shuttingDown = true;
    stats.state = 'stopping';
    await persist().catch(() => {});
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const force = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      agent.destroy();
    }, 5000);
    force.unref();
    await closed;
    clearTimeout(force);
    agent.destroy();
    await pendingWrite.catch(() => {});
    stats.state = 'stopped';
    await persist().catch(() => {});
    await statsFd.close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(4154, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    stats.state = 'listening';
    await persist();
  } catch (error) {
    agent.destroy();
    server.close();
    await statsFd.close();
    throw error;
  }
  return { shutdown };
}
if (process.argv[1]?.endsWith('/stocktake-scans-response-drop-proxy.ts')) {
  try {
    assert.equal(process.argv[2], 'run', 'Explicit run required');
    const proxy = await startStocktakeScansResponseDropProxy();
    const stop = () => {
      void proxy.shutdown().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    console.log({
      qa_only: true,
      listen: '127.0.0.1:4154',
      upstream: '127.0.0.1:4100',
      status: 'READY',
      credentials_logged: false,
    });
  } catch (error) {
    console.error({
      status: 'PROXY_NOT_STARTED',
      error_type: error instanceof Error ? error.name : 'Error',
    });
    process.exitCode = 1;
  }
}
