// Release mode of the scale generator (tools/scale/release-runtime.mjs) and the clock lock (simclock.mjs).
// Pure: no database, no package. Run: node --test tests/scale-release-runtime.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { locateChunks, readReleaseBuild, RELEASE_MODULES } from '../tools/scale/release-runtime.mjs';
import { acquireClockLock } from '../tools/scale/simclock.mjs';

const V = '.deployment-emitted-not-written/';
const sha = (b) => createHash('sha256').update(b).digest('hex');
function fixture(outputs, closure = Object.keys(outputs)) {
  const dir = mkdtempSync(join(tmpdir(), 'scale-release-'));
  writeFileSync(join(dir, 'release.json'), JSON.stringify({ emitted_output_closure: { files: closure } }));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const one = { db: ['server/db.ts', ['tenantTx', 'pool']] };

test('each writer module maps to the one emitted chunk of the package that exports its names', () => {
  const outputs = { [V + 'chunks/chunk-A.mjs']: { inputs: { 'server/db.ts': { bytesInOutput: 10 } }, exports: ['pool', 'tenantTx', 'migrate'] },
    [V + 'chunks/chunk-B.mjs']: { inputs: { 'server/db.ts': { bytesInOutput: 0 } }, exports: [] } };
  const f = fixture(outputs);
  try {
    assert.deepEqual(locateChunks({ outputs }, f.dir, one),
      { db: { source: 'server/db.ts', chunk: 'runtime/chunks/chunk-A.mjs', names: ['tenantTx', 'pool'] } });
  } finally { f.done(); }
});

test('a missing export, a module outside the shipped closure or in two chunks refuses before any import', () => {
  const meta = { outputs: { [V + 'chunks/a.mjs']: { inputs: { 'server/db.ts': { bytesInOutput: 5 } }, exports: ['pool'] } } };
  let f = fixture(meta.outputs);
  try { assert.throws(() => locateChunks(meta, f.dir, one), /server\/db\.ts: exports missing/); } finally { f.done(); }
  f = fixture(meta.outputs, []);
  try { assert.throws(() => locateChunks(meta, f.dir, one), /expected one emitted chunk, found 0/); } finally { f.done(); }
  const two = { outputs: { [V + 'chunks/a.mjs']: { inputs: { 'server/db.ts': { bytesInOutput: 5 } }, exports: ['pool', 'tenantTx'] },
    [V + 'chunks/b.mjs']: { inputs: { 'server/db.ts': { bytesInOutput: 5 } }, exports: ['pool', 'tenantTx'] } } };
  f = fixture(two.outputs);
  try { assert.throws(() => locateChunks(two, f.dir, one), /found 2/); } finally { f.done(); }
});

test('every rt.<module>.<name> the writer uses is in the release surface', () => {
  // writer.mjs reaches modules as rt.x.name or through destructuring (domain, catalog, returns, st = status).
  const src = readFileSync(new URL('../tools/scale/writer.mjs', import.meta.url), 'utf8'), alias = { st: 'status' };
  const used = new Set([...src.matchAll(/\b(?:rt\.)?(domain|catalog|returns|st|wms|li|tax|i230|ws|db)\.([A-Za-z_]\w*)\b/g)]
    .filter((m) => !/^ts$/.test(m[2])).map((m) => `${alias[m[1]] ?? m[1]}.${m[2]}`));
  const surface = new Set(Object.entries(RELEASE_MODULES).flatMap(([k, [, names]]) => names.map((n) => `${k}.${n}`)));
  assert.deepEqual([...used].filter((u) => !surface.has(u)), []);
  assert.equal(surface.size, 25);
  assert(used.has('i230.invoice230Preview'), 'the writer issues its invoices through the 230 preview');
  assert(!used.has('li.previewLocalInvoice'), 'no 157 preview: its lifetime budget (2000 per company) cannot hold the full plan');
});

test('the build record is re-verified against release.json and the metafile on disk', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scale-build-')));
  try {
    writeFileSync(join(dir, 'release.json'), '{"a":1}'); writeFileSync(join(dir, 'meta.json'), '{}');
    writeFileSync(join(dir, 'build.json'), JSON.stringify({ schema: 'dyna-scale-release-build/v1', release_directory: dir,
      release_manifest_sha256: sha('{"a":1}'), metafile: join(dir, 'meta.json'), metafile_sha256: sha('{}') }));
    assert.equal(readReleaseBuild(join(dir, 'build.json')).release_manifest_sha256, sha('{"a":1}'));
    writeFileSync(join(dir, 'release.json'), '{"a":2}');
    assert.throws(() => readReleaseBuild(join(dir, 'build.json')), /release\.json sha256 differs/);
    writeFileSync(join(dir, 'release.json'), '{"a":1}'); writeFileSync(join(dir, 'meta.json'), '{"x":1}');
    assert.throws(() => readReleaseBuild(join(dir, 'build.json')), /metafile sha256 differs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('clock lock: own leftover (same host, same pid after a container restart) is stale; another host refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scale-lock-')), file = join(dir, 'faketime.rc'), lock = file + '.lock';
  try {
    writeFileSync(lock, `${hostname()} ${process.pid}`);
    const release = acquireClockLock(file);
    assert.equal(readFileSync(lock, 'utf8'), `${hostname()} ${process.pid}`);
    release(); assert.equal(existsSync(lock), false);
    writeFileSync(lock, `other-host ${process.pid}`);
    assert.throws(() => acquireClockLock(file), /other-host/);
    writeFileSync(lock, String(process.ppid)); // legacy spelling: pid only, a live process here
    assert.throws(() => acquireClockLock(file), /używany przez proces/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dataset invoices: 230 preview (strict body, consumer PL) issued through tax-issue, found again on rerun', async () => {
  // The sealed 157 budget (local_invoice_budget, 157:137) refuses a company's 2001st local invoice for life; the full
  // plan has ~7 400 per company (run full02, 29.10). The 230 path (server/invoice230.ts) has no lifetime budget.
  const { issueOrderInvoice, orderState } = await import('../tools/scale/writer.mjs');
  const calls = [];
  const rt = {
    db: { pool: { query: async (sql, args) => { calls.push(['sql', sql, args]);
      if (/SELECT version::text v FROM orders/.test(sql)) return { rows: [{ v: '7' }] };
      if (/SELECT status FROM orders/.test(sql)) return { rows: [{ status: 'shipped' }] };
      if (/FROM documents/.test(sql)) return { rows: /'invoice230'/.test(sql) && /kind='invoice'/.test(sql) ? [{ '?column?': 1 }] : [] };
      return { rows: [] }; } } },
    tax: { taxInvoiceActor: (req, name) => ({ actor: req.actor, name }),
      issueLocalInvoiceWithTax: async (a, id, body) => { calls.push(['issue', a, id, body]); return { invoice230: true, reused: false }; } },
    i230: { invoice230Preview: async (a, id, body) => { calls.push(['preview', a, id, body]); return { preview: { id: 'pv-1', scope_hash: 'h'.repeat(64) } }; } },
    li: { previewLocalInvoice: async () => { throw new Error('157 preview must not be used'); } },
  };
  const tenant = { tenantId: 't-1', userId: 'u-1', token: 'tok', actor: { tenantId: 't-1' }, seriesId: 's-1' };
  const o = { key: 'scale:5076fb8f:A:order:42' };
  const cust = { name: 'Anna Nowak', address: { street: 'Polna 3', postal_code: '60-001', city: 'Poznań', phone: '500000000' } };
  await issueOrderInvoice(rt, tenant, o, 'o-1', cust);
  const pv = calls.find((c) => c[0] === 'preview'), is = calls.find((c) => c[0] === 'issue');
  assert.equal(pv[2], 'o-1');
  assert.deepEqual(Object.keys(pv[3]).sort(), ['buyer', 'client_key', 'order_version', 'sell_date', 'series_id', 'shipping_vat']);
  assert.deepEqual(pv[3].buyer, { kind: 'consumer', name: 'Anna Nowak', address: { street: 'Polna 3', postal_code: '60-001', city: 'Poznań', country: 'PL' } });
  assert.equal(pv[3].order_version, '7'); assert.equal(pv[3].series_id, 's-1'); assert.equal(pv[3].shipping_vat, 23);
  assert.match(pv[3].sell_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(is.slice(2), ['pv-1', { client_key: is[3].client_key, scope_hash: 'h'.repeat(64), confirmed: true, local_only: true }]);
  assert.notEqual(is[3].client_key, pv[3].client_key);
  assert.deepEqual(pv[1], is[1], 'one tax actor for preview and issue');
  // Rerun after a crash: an order with a 230 invoice is recognised as invoiced (no second preview).
  const st = await orderState(rt, tenant, 'o-1', { key: o.key });
  assert.equal(st.invoice, true);
});
