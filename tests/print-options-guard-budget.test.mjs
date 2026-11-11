// wave_print177_valid() hashes the whole sealed certificate chain: 2-6 s per call on the demo data. A print read runs the
// availability chain once, not once per helper layer; writes keep the check before and inside their transaction.
// Real routes and domain code; only the database is replaced, because the query count is what is under test.
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after } from 'node:test';
import Fastify from 'fastify';
import { createServer } from 'vite';

const onPool = [], inTx = [];
const row = { artifacts: true, available: true, installed: true, ok: true, helper: true, helpers: true, db_role: 'postgres', certificate: false, validator: false, column_present: false, id: 'a', code: 'A', label: 'A', enabled: true, version: '1', g: { role: 'admin', allowed: true, key_valid: true, can_write: true } };
let answer = text => row;
const db = sink => ({ query: async text => { sink.push(text); return { rows: [answer(text)], rowCount: 1 }; } });
const dbPath = path.resolve('server/db.ts');
const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error', plugins: [{ name: 'database-counter', enforce: 'pre', load(file) {
  if (file.split('?')[0] !== dbPath) return;
  return 'export const pool = globalThis.__printGuardBudgetPool; export const tenantTx = (_tenant, work) => work(globalThis.__printGuardBudgetTx);';
} }] });
after(() => vite.close());
globalThis.__printGuardBudgetPool = db(onPool);
globalThis.__printGuardBudgetTx = db(inTx);
const printRoutes = await vite.ssrLoadModule(path.resolve('server/print-job-routes.ts'));
const batchRoutes = await vite.ssrLoadModule(path.resolve('server/shipment-label-batch-routes.ts'));
const labelRoutes = await vite.ssrLoadModule(path.resolve('server/shipment-label-print-routes.ts'));
const cacheRoutes = await vite.ssrLoadModule(path.resolve('server/shipment-label-cache-routes.ts'));
const app = Fastify();
app.decorateRequest('actor', null);
app.addHook('onRequest', async req => { req.actor = { tenantId: 'tenant', userId: 'user', role: 'admin' }; });
batchRoutes.registerShipmentLabelBatchRoutes(app, { available: true, readOnly: false });
labelRoutes.registerShipmentLabelPrintRoutes(app, { available: true, readOnly: false, sessionName: 'session' });
cacheRoutes.registerShipmentLabelCacheRoutes(app, { available: true, readOnly: false });
printRoutes.registerPrintJobRoutes(app, { available: true, readOnly: false });
await app.ready();
after(() => app.close());

const uuid = '00000000-0000-4000-8000-000000000001';
const sha = 'a'.repeat(64);
const chain = sink => sink.filter(text => text.includes('print_job_installed()')).length;
const request = async spec => {
  onPool.length = 0; inTx.length = 0;
  return app.inject(spec);
};
const reads = [
  '/api/print-jobs/options', '/api/print-jobs/printers', '/api/print-jobs/jobs', `/api/print-jobs/jobs/${uuid}`,
  `/api/print-jobs/original-results/${uuid}?operation=job_create`,
  '/api/print-jobs/label-batches/options', `/api/print-jobs/label-batches/previews/${uuid}`,
  `/api/print-jobs/label-batches/executions/${uuid}`, '/api/print-jobs/label-batches/history?kind=preview',
  '/api/print-jobs/shipment-labels/options', `/api/print-jobs/label-previews/${uuid}`,
  `/api/print-jobs/shipments/${uuid}/label-cache`, `/api/print-jobs/shipments/${uuid}/label-cache/history`, `/api/print-jobs/label-cache/${uuid}`,
];
for (const url of reads) {
  test('GET ' + url + ' checks availability once, before its transaction', async () => {
    await request({ url });
    assert.deepEqual({ pool: chain(onPool), tx: chain(inTx) }, { pool: 1, tx: 0 });
  });
  test('GET ' + url + ' still answers 503 when the sealed chain fails', async () => {
    answer = text => (text.includes('print_job_installed()') ? { ...row, installed: false } : row);
    try { assert.equal((await request({ url })).statusCode, 503); } finally { answer = () => row; }
  });
  test('GET ' + url + ' still checks current access inside its transaction', async () => {
    answer = text => (text.includes('print_job_access') || text.includes('label_cache_access') ? { ...row, g: { ...row.g, allowed: false } } : row);
    try {
      const reply = await request({ url });
      assert.equal(reply.statusCode, 403, reply.body);
      assert.ok(inTx.some(text => text.includes('_access(')));
    } finally { answer = () => row; }
  });
}
for (const url of ['/api/print-jobs/options', '/api/print-jobs/label-batches/options']) {
  test(url + ' answers from the single check', async () => {
    const reply = await request({ url });
    assert.equal(reply.statusCode, 200, reply.body);
    assert.equal(reply.json().can_read, true);
  });
}
const printerBody = { client_key: uuid, station_id: uuid, station_version: '1', name: 'A', format: 'pdf', output_mode: 'file', cups_queue: null, enabled: true };
const writes = [
  { method: 'POST', url: '/api/print-jobs/printers', payload: printerBody },
  { method: 'PATCH', url: `/api/print-jobs/printers/${uuid}`, payload: { ...printerBody, version: '1' } },
  { method: 'POST', url: `/api/print-jobs/jobs/${uuid}/claim`, payload: { client_key: uuid, version: '1', lease_token: uuid } },
  { method: 'POST', url: `/api/print-jobs/jobs/${uuid}/reconcile`, payload: { client_key: uuid, version: '1', result: 'cancelled', confirmed: true, note: 'abc' } },
  { url: `/api/print-jobs/jobs/${uuid}/content`, headers: { 'x-print-lease': uuid } },
  { url: `/api/print-jobs/label-previews/${uuid}/content` },
  { method: 'POST', url: `/api/print-jobs/shipments/${uuid}/label-cache`, payload: { client_key: uuid, order_version: '1', source_hash: sha, confirmed_existing_label: true } },
  { url: `/api/print-jobs/label-cache/${uuid}/content` },
  { method: 'POST', url: `/api/print-jobs/label-cache/acquisitions/${uuid}/reconcile`, payload: { client_key: uuid, confirmed_abandon: true } },
  { method: 'POST', url: `/api/print-jobs/label-batches/previews/${uuid}/queue`, payload: { client_key: uuid, scope_hash: sha, confirmed: true } },
  { url: `/api/print-jobs/label-batches/previews/${uuid}/content` },
];
for (const spec of writes) {
  test((spec.method ?? 'GET') + ' ' + spec.url + ' keeps the check before and inside its transaction', async () => {
    await request(spec);
    assert.ok(chain(onPool) >= 1, 'availability before the transaction');
    assert.ok(chain(inTx) >= 1, 'availability inside the transaction');
  });
}
// These two routes first capture the delivery authority of a real session, so they are called below it.
const labels = await vite.ssrLoadModule(path.resolve('server/shipment-label-print.ts'));
const actor = { tenantId: 'tenant', userId: 'user', role: 'admin' };
for (const [name, write] of Object.entries({
  createShipmentLabelPrintPreview: () => labels.createShipmentLabelPrintPreview(actor, uuid, { client_key: uuid, order_version: '1', station_id: uuid, station_version: '1', printer_id: uuid, printer_version: '1', copies: 1 }),
  queueShipmentLabelPrint: () => labels.queueShipmentLabelPrint(actor, uuid, { client_key: uuid, scope_hash: sha, confirmed: true }),
})) {
  test(name + ' keeps the check before and inside its transaction', async () => {
    onPool.length = 0; inTx.length = 0;
    await write().catch(() => {});
    assert.ok(chain(onPool) >= 1, 'availability before the transaction');
    assert.ok(chain(inTx) >= 1, 'availability inside the transaction');
  });
}
