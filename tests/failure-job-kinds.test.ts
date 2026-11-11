/** S4 static coverage of job kinds (RES-21): every kind the server enqueues is claimed by exactly one
 * worker, every kind with external I/O has its own failure handler, every queued side row of a failure
 * handler is reconciled when the job dies by lease expiry (the reaper marks the job failed without
 * running the handler), and every external write keeps a durable marker (phase / attempted_at /
 * remote id) written before the call, so the generic reaper's "running → pending" re-run cannot repeat
 * the effect. Read from the sources only; no database. A new kind fails here until it is classified. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, '..', 'server');
const src: Record<string, string> = Object.fromEntries(
  fs.readdirSync(dir).filter((f) => /\.(ts|sql)$/.test(f) && !/\.test\./.test(f)).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]),
);
const all = Object.values(src).join('\n');
const consts: Record<string, string> = {};
for (const s of Object.values(src)) for (const m of s.matchAll(/export const ([A-Z][A-Z0-9_]*)\s*=\s*'([a-z0-9_.]+)'/g)) consts[m[1]!] = m[2]!;

function group(s: string, i: number, open: string, close: string): [string, number] {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === open) d++;
    else if (s[j] === close && --d === 0) return [s.slice(i + 1, j), j];
  }
  throw new Error('unbalanced ' + open + ' at ' + i);
}
function split(s: string): string[] {
  const out: string[] = [];
  let d = 0, cur = '', q: string | null = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) d++;
    if (')]}'.includes(ch)) d--;
    if (ch === ',' && !d) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The kind is a parameter of the enclosing helper (e.g. mirakl262.ts newJob): every call site in the file must pass a
 * literal or an exported constant, else nothing is returned and the INSERT stays unresolved. */
function kindsFromCallers(s: string, at: number, param: string): string[] {
  const fn = [...s.slice(0, at).matchAll(/function (\w+)\(([^)]*)\)/g)].at(-1);
  const pi = fn ? fn[2]!.split(',').map((p) => p.trim().split(/[\s:?=]/)[0]).indexOf(param) : -1;
  if (pi < 0) return [];
  const out: string[] = [];
  for (const c of s.matchAll(new RegExp('(?<!function )\\b' + fn![1] + '\\(', 'g'))) {
    const a = split(group(s, c.index! + c[0].length - 1, '(', ')')[0])[pi] ?? '';
    const k = a.startsWith("'") ? a.slice(1, -1) : consts[a];
    if (!k) return [];
    out.push(k);
  }
  return out;
}

/** Kinds written by INSERT INTO jobs, in TypeScript and in SQL functions. */
function enqueuedKinds(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [f, s] of Object.entries(src))
    for (const m of s.matchAll(/INSERT INTO (?:public\.)?jobs\s*\(/g)) {
      const [cols, e1] = group(s, m.index! + m[0].length - 1, '(', ')');
      const ci = cols.split(',').map((x) => x.trim()).indexOf('kind');
      assert(ci >= 0, `${f}: INSERT INTO jobs without kind`);
      const [vals, e2] = group(s, s.indexOf('(', s.indexOf('VALUES', e1)), '(', ')');
      // A row inserted directly as state 'done' is an inert state record (automation v2 rule and stock state), never
      // claimed by any worker, so it is not a queued kind.
      const si = cols.split(',').map((x) => x.trim()).indexOf('state');
      if (si >= 0 && split(vals)[si] === "'done'") continue;
      const v = split(vals)[ci]!;
      let kinds: string[];
      if (v.startsWith("'")) kinds = [v.slice(1, -1)];
      else if (/^\$\d+$/.test(v)) {
        const [arr] = group(s, s.indexOf('[', e2), '[', ']');
        const el = split(arr)[Number(v.slice(1)) - 1]!;
        const chosen = el.includes('?') ? el.slice(el.indexOf('?') + 1) : el;
        kinds = [...chosen.matchAll(/'([a-z0-9_.]+)'/g)].map((x) => x[1]!);
        if (!kinds.length && consts[el]) kinds = [consts[el]!];
        if (!kinds.length && /^\w+$/.test(el)) kinds = kindsFromCallers(s, m.index!, el);
      } else kinds = [];
      assert(kinds.length, `${f}: kind of INSERT INTO jobs not resolved (${v})`);
      for (const k of kinds) out.set(k, (out.get(k) ?? new Set()).add(f));
    }
  return out;
}

type Route = { kinds: string[]; fn: string; ctx: boolean };
const worker = src['worker.ts']!;
const tryAt = worker.indexOf('if (!job) return false;'),
  catchAt = worker.indexOf('} catch (e) {', tryAt),
  genericAt = worker.indexOf('const message =', catchAt);
function routes(block: string): Route[] {
  const re = /if \((?:\(?job\.kind === ([A-Z][A-Z0-9_]*|'[^']+')(?:\s*\|\|\s*job\.kind === ([A-Z][A-Z0-9_]*|'[^']+'))?\)?|\[([^\]]+)\]\.includes\(job\.kind\))\)\s*\{\s*await (\w+)\(job(, ctx|, e)?\)/g;
  return [...block.matchAll(re)].map((m) => ({
    kinds: m[3] ? [...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1]!) : [m[1], m[2]].filter(Boolean).map((x) => (x!.startsWith("'") ? x!.slice(1, -1) : consts[x!]!)),
    fn: m[4]!,
    ctx: m[5] === ', ctx',
  }));
}
const dispatched = routes(worker.slice(tryAt, catchAt)),
  failures = routes(worker.slice(catchAt, genericAt));
const dispatchedKinds = new Set(dispatched.flatMap((r) => r.kinds)),
  failedKinds = new Set(failures.flatMap((r) => r.kinds));
const claimSql = /SELECT \* FROM jobs WHERE state='pending' AND kind NOT IN \(([^)]*)\)/.exec(worker);
const excludedFromTick = new Set([...(claimSql?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]!));
function fnBody(name: string): [string, string] {
  for (const [f, s] of Object.entries(src)) {
    const i = s.search(new RegExp('export async function ' + name + '\\('));
    if (i >= 0) return [f, group(s, s.indexOf('{', s.indexOf(')', i)), '{', '}')[0]];
  }
  throw new Error('no function ' + name);
}
/** Side tables whose state a failure handler moves (UPDATE <t> SET … state=). */
const sideTables = (fn: string) =>
  [...new Set([...fnBody(fn)[1].matchAll(/UPDATE (\w+)\s+(?:\w+\s+)?SET\s[^;]*?\b(?:state|outcome)\s*=/g)].map((x) => x[1]!).filter((t) => t !== 'jobs'))];
/** A statement that updates `t` for jobs the reaper already failed (lease of the last attempt expired). */
function reconciledAfterLeaseExpiry(t: string): boolean {
  for (const m of all.matchAll(new RegExp('UPDATE (?:public\\.)?' + t + '\\b', 'g'))) {
    const stmt = all.slice(m.index!, m.index! + 700).split(/\bUPDATE\b/)[1] ?? '';
    if (/j\.state\s*=\s*'failed'|j\.state\s+IN\s*\([^)]*'failed'/.test(stmt)) return true;
  }
  return false;
}
function columnsOf(t: string): string[] {
  const m = new RegExp('CREATE TABLE (?:IF NOT EXISTS )?(?:public\\.)?' + t + '\\s*\\(').exec(all);
  assert(m, 'no CREATE TABLE ' + t);
  const cols = group(all, m.index + m[0].length - 1, '(', ')')[0].split(/,\s*/).map((c) => c.trim().split(/\s+/)[0]!);
  const added = [...all.matchAll(new RegExp('ALTER TABLE (?:public\\.)?' + t + '\\s+ADD COLUMN (?:IF NOT EXISTS )?(\\w+)', 'g'))].map((x) => x[1]!);
  return [...cols, ...added];
}

/** Claimed by a dedicated loop, not by tick(). */
const OWN_WORKERS: Record<string, { file: string; reason: string }> = {
  'catalog.ai': { file: 'catalog-ai.ts', reason: 'startCatalogAiWorker; own reaper fails the expired lease' },
  'catalog.deepl': { file: 'deepl-catalog.ts', reason: 'startDeepLWorker; own reaper' },
  'catalog.deepl.batch': { file: 'deepl-batches.ts', reason: 'startDeepLBatchWorker; attempted drafts → uncertain' },
  'automation.local_stock': { file: 'local-automation-worker-control.ts', reason: 'scoped automation worker; claims attempts=0 only' },
};
/** External I/O processors that may use the generic retry path (no own failure handler). */
const GENERIC_RETRY_OK: Record<string, string> = {
  'orders.sync': 'read of the channel; import upsert ON CONFLICT (RES-01, tests/imports.test.ts)',
  'webhook.stage': 'staged inbound webhook; delivery dedup (tests/sync.test.ts)',
};
/** Failure-handler side rows that need no lease-expiry reconciliation, with the reason. */
const SIDE_ROWS_OK: Record<string, string> = {
  order_batch_items: 'skipped by the reaper through order_batches b.state=failed (worker.ts)',
};
/** External processors that need no durable pre-call marker: reads, or effects deduplicated elsewhere. */
const NO_MARKER_OK: Record<string, string> = {
  'odoo.catalog.sync': 'read of the ERP catalog',
  'catalog.fetch': 'read of a catalog source',
  'supplier.read': 'read of a supplier feed',
  'supplier.bulk': 'read of supplier feeds',
  'ebay.fulfillment.scan': 'read; writes go through ebay.fulfillment plans',
  'order.status.scan': 'read; writes go through order.status.write plans',
  'payment.source.read': 'read of payments of the source (RES-15)',
  'shipping.tracking': 'read of carrier tracking',
  'shopify.webhook': 'processing of an inbound webhook, local upserts',
  'offer.sync': 'writes go through offer_plans with phase write_started/verify (RES-09)',
  'offer.variants': 'writes go through offer plans of the batch items (RES-09)',
  'outbound.webhook': 'at-least-once by contract: stable X-Dyna-Delivery-ID, receiver dedup (RES-13, failure-outbound-webhooks.test.ts)',
  'orders.sync': 'read',
  'webhook.stage': 'read of a staged webhook',
};

test('każdy kolejkowany kind ma dokładnie jednego właściciela: tick() albo własną pętlę wyłączoną z tick()', () => {
  const enq = enqueuedKinds();
  assert(enq.size >= 40, 'extraction found only ' + enq.size + ' kinds');
  for (const k of ['outbound.webhook', 'email.send', 'sms.send', 'replenishment.automation', 'supplier.file.fetch', 'automation.run', 'mirakl262.orders', 'mirakl262.write'])
    assert(enq.has(k), 'extraction misses ' + k);
  const orphan: string[] = [];
  for (const [kind, files] of enq) {
    if (dispatchedKinds.has(kind)) {
      assert(!excludedFromTick.has(kind), `${kind} is dispatched by tick() and excluded from its claim`);
      continue;
    }
    const own = OWN_WORKERS[kind];
    if (!own) { orphan.push(`${kind} (${[...files].join(',')})`); continue; }
    assert(new RegExp(`kind='${kind.replace(/\./g, '\\.')}'[^"\`]*SKIP LOCKED|SKIP LOCKED[^"\`]*kind='${kind.replace(/\./g, '\\.')}'`).test(src[own.file]!) ||
      new RegExp(`j\\.kind='${kind.replace(/\./g, '\\.')}'[\\s\\S]{0,400}SKIP LOCKED`).test(src[own.file]!), `${kind}: no claim in ${own.file}`);
  }
  assert.deepEqual(orphan, [], 'enqueued kinds without a worker: tick() would fail them as unsupported');
  for (const kind of dispatchedKinds) assert(enq.has(kind), `tick() dispatches ${kind}, which nothing enqueues (stale route?)`);
});

test('kindy własnych pętli są wyłączone z przejęcia przez tick() (inaczej tick odrzuca je jako „Nieobsługiwane zadanie”)', () => {
  for (const kind of Object.keys(OWN_WORKERS)) assert(excludedFromTick.has(kind), `${kind} would be claimed by tick() and failed as unsupported (max_attempts=1: effect lost)`);
});

test('każdy kind z zewnętrznym I/O ma własną obsługę błędu (nie ogólny retry, który ponawia procesor)', () => {
  const missing = dispatched.filter((r) => r.ctx || r.kinds.includes('email.send')).flatMap((r) => r.kinds).filter((k) => !failedKinds.has(k) && !GENERIC_RETRY_OK[k]);
  assert.deepEqual(missing, []);
  for (const k of Object.keys(GENERIC_RETRY_OK)) assert(dispatchedKinds.has(k) && !failedKinds.has(k), `allowlist entry ${k} is stale`);
});

test('każdy wiersz stanu z obsługi błędu jest uzgadniany, gdy reaper kończy zadanie po wygaśnięciu dzierżawy ostatniej próby', () => {
  const stuck: string[] = [];
  for (const r of failures)
    for (const t of sideTables(r.fn)) if (!SIDE_ROWS_OK[t] && !reconciledAfterLeaseExpiry(t)) stuck.push(`${r.kinds.join('|')} → ${t} (${r.fn})`);
  assert.deepEqual(stuck, [], 'side rows left queued forever after the reaper fails the job');
  // Kinds whose failure handler moves no side table keep their state in a reap function run by tick().
  for (const fn of ['reapReplenishmentAutomations', 'reapSupplierRemoteFetches', 'reapProductRuleJobs', 'reapPaymentImportJobs', 'reapOrderFieldBatchJobs', 'reapOrderFieldMappingJobs'])
    assert(worker.slice(0, tryAt).includes(fn + '()'), `tick() does not run ${fn}`);
});

test('każdy zewnętrzny zapis ma trwały znacznik przed wywołaniem (phase / attempted_at / remote id), więc ponowienie po restarcie nie powtarza skutku', () => {
  const unmarked: string[] = [];
  for (const r of failures) {
    const external = dispatched.find((d) => d.kinds.some((k) => r.kinds.includes(k)))?.ctx || r.kinds.includes('email.send');
    if (!external || r.kinds.every((k) => NO_MARKER_OK[k])) continue;
    const tables = sideTables(r.fn);
    const marked = tables.some((t) => columnsOf(t).some((c) => /^(phase|attempted_at|remote_id)$/.test(c)));
    if (!marked) unmarked.push(`${r.kinds.join('|')} (${tables.join(',') || 'no side table'})`);
  }
  assert.deepEqual(unmarked, []);
  for (const k of Object.keys(NO_MARKER_OK)) assert(dispatchedKinds.has(k), `allowlist entry ${k} is stale`);
});

test('reaper tick() zwraca do kolejki tylko po 2 min i liczy próby; kindy DeepL mają własny reaper', () => {
  const reaper = /UPDATE jobs SET state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,lease_token=NULL,locked_at=NULL,run_at=now\(\) WHERE state='running' AND kind NOT IN \(([^)]*)\) AND locked_at<now\(\)-interval '2 minutes'/.exec(worker);
  assert(reaper, 'tick() reaper statement changed; re-check the restart contract');
  const ownReaped = new Set([...reaper[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!));
  for (const k of ownReaped) assert(OWN_WORKERS[k], `${k} is excluded from the reaper but has no own worker`);
  // The claim always rotates the lease token, so a stale worker's fence fails after a takeover.
  assert.match(worker, /UPDATE jobs SET state='running',attempts=attempts\+1,locked_at=now\(\),lease_token=\$2/);
});
