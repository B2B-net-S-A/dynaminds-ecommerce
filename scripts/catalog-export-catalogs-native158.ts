/** ROOT ONLY: fixed local own-fixture metadata/preview/file reads. No profile writes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseCatalogCsvRecords, parseNativeCatalogXmlRecords } from '../server/catalog-file-import-parse';
const ROOT = '<workspace>/app';
const phase = process.argv[2], restored = phase === 'restore';
const revision = process.env.APP_REVISION ?? '', port = restored ? '4198' : '4100';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
let step = 'preflight';
async function wx(path: string, value: Buffer | string, mode: number) {
  const h = await open(path, 'wx', mode); try { await h.writeFile(value); await h.sync(); } finally { await h.close(); }
}
async function input(path: string, digest: string | undefined) {
  assert.match(digest ?? '', /^[a-f0-9]{64}$/);
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink()); assert.equal(s.mode & 0o777, 0o600);
  const bytes = await readFile(path); assert.equal(sha(bytes), digest); return JSON.parse(bytes.toString());
}
async function main() {
  assert.equal(process.cwd(), ROOT); assert(['primary', 'primary-reviewed', 'restart', 'restore'].includes(phase));
  assert.equal(process.env.QA158_NATIVE_CONFIRM, 'PURE_OWN_CATALOG_READS_ONLY');
  assert.match(revision, /^[a-f0-9]{40}$/); assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert(!process.env.DYNA_TEST);
  const setup = await input(resolve(ROOT, 'data/product-catalogs-stage157.json'), process.env.QA157_SETUP_SHA256);
  assert.equal(setup.complete, true); assert.equal(setup.pending, null); assert.equal(setup.stage, 157);
  const own = { tenant_id: 'd490db0e-ce10-45fa-94e2-c977bb513e5a', user_id: 'ff49c04e-e152-43b9-91b1-99ae969d0044' };
  assert.equal(setup.actor.tenant_id, own.tenant_id); assert.equal(setup.actor.user_id, own.user_id);
  let cookie = setup.actor.cookie;
  if (restored) {
    const a = await input(resolve(ROOT, 'data/catalog-export-catalogs-restore-auth158.json'), process.env.QA158_RESTORE_AUTH_SHA256);
    assert.equal(a.stage, 158); assert.equal(a.tenant_id, own.tenant_id); assert.equal(a.user_id, own.user_id); assert.equal(String(a.port), port);
    assert(a.cookie.startsWith('dyna_session_preview_4198=') && a.cookie !== cookie); cookie = a.cookie;
  }
  async function req(path: string, prefix = '/api', body?: unknown) {
    assert(['/api', '/api/v1'].includes(prefix));
    assert(['/health', '/auth/me', '/catalog/exports/options', '/catalog/exports/preview', '/catalog/exports/file', '/catalog/export-profiles'].includes(path));
    return fetch('http://127.0.0.1:' + port + prefix + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, 'X-Workspace-ID': own.tenant_id, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(20000) });
  }
  const h = await (await req('/health')).json();
  assert.equal(h.status, 'ok'); assert.equal(h.revision, revision); assert.equal(h.schema_revision, '143_catalog_export_catalogs');
  assert.equal(h.background_workers_enabled, false); assert.equal(h.restore_preview, restored);
  const me = await (await req('/auth/me')).json(); assert.equal(me.user.id, own.user_id); assert.equal(me.user.tenant_id, own.tenant_id); assert.equal(me.user.role, 'admin');
  const catalog = '1ce0d077-8b58-4029-a963-7c79e2a3ae97', warehouse = '9c3df0e9-2cb8-4fc8-b388-c576b442b819', list = 'c3a33613-9e44-46af-a903-da9ffc36233c';
  const products = [{ id: 'b7891620-f95a-4a61-8013-e7e4d3c7992d', sku: 'QA157-f03715f7-ON', name: 'QA157 Drugi produkt ON' },
    { id: 'e3ba245f-cef3-4cef-9001-d18d62141f88', sku: 'QA157-f03715f7-OFF', name: 'QA157 Drugi produkt OFF' }];
  const columns = ['sku', 'ean', 'name', 'price_minor', 'vat_rate', 'active', 'id', 'inventory_json', 'prices_json'];
  const headers = { sku: 'external_sku', name: 'product_name' };
  const records: unknown[] = [], negatives: unknown[] = [];
  function values(rows: Record<string, any>[]) {
    assert.equal(rows.length, 2); assert.deepEqual(rows.map(r => r.id), products.map(p => p.id));
    for (const [i, row] of rows.entries()) {
      assert.equal(row.external_sku, products[i].sku); assert.equal(row.product_name, products[i].name);
      assert.equal(Number(row.price_minor), 1501); assert.equal(String(row.active), 'true');
      assert.equal(row.inventory_json.length, 1); const w = row.inventory_json[0];
      assert.equal(w.warehouse_id, warehouse); assert.equal(w.on_hand, 3); assert.equal(w.reserved, 0); assert.equal(w.available, 3); assert.equal(w.source, 'stock'); assert.equal(w.status, 'available');
      assert.equal(row.prices_json.length, 1); const p = row.prices_json[0];
      assert.equal(p.price_list_id, list); assert.equal(p.currency, 'PLN'); assert.equal(p.own_price_minor, 1501); assert.equal(p.effective_price_minor, 1501); assert.equal(p.source, 'override'); assert.equal(p.status, 'available');
    }
  }
  for (const prefix of ['/api', '/api/v1']) for (const format of ['csv', 'xml']) {
    step = prefix + '-' + format;
    const definition = { catalog_id: catalog, format, columns, headers, spreadsheet_safe: false,
      selection: 'filtered', search: '', active: 'all', warehouse_ids: [warehouse], price_list_ids: [list] };
    const pr = await req('/catalog/exports/preview', prefix, definition); assert.equal(pr.status, 200);
    const preview = await pr.json(); assert.equal(preview.catalog.id, catalog); assert.equal(preview.catalog_version, '1');
    assert.match(preview.scope_hash, /^[a-f0-9]{64}$/); assert.equal(preview.count.matched_products, 2); assert.equal(preview.count.capped, false);
    assert.deepEqual(preview.sample.map((s: any) => s.product_id), products.map(p => p.id));
    const body = { ...definition, catalog_version: preview.catalog_version, scope_hash: preview.scope_hash };
    const r = await req('/catalog/exports/file', prefix, body); assert.equal(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer()); assert(bytes.length > 0 && bytes.length < 65536);
    assert.equal(r.headers.get('content-length'), String(bytes.length)); assert.equal(r.headers.get('x-catalog-export-count'), '2');
    assert.equal(r.headers.get('x-product-catalog-id'), catalog); assert.equal(r.headers.get('x-product-catalog-version'), '1');
    assert.equal(r.headers.get('x-catalog-export-scope-hash'), preview.scope_hash); assert.equal(r.headers.get('x-catalog-currency'), 'PLN');
    assert(r.headers.get('content-type')?.startsWith(format === 'csv' ? 'text/csv;' : 'application/xml;'));
    let parsed: Record<string, any>[];
    if (format === 'csv') {
      const csv = parseCatalogCsvRecords(bytes.toString('utf8'), ',');
      assert.deepEqual(csv[0], columns.map(k => headers[k as keyof typeof headers] ?? k));
      parsed = csv.slice(1).map(row => { assert.equal(row.length, columns.length); return Object.fromEntries(row.map((v, i) => [csv[0][i], ['inventory_json', 'prices_json'].includes(csv[0][i]) ? JSON.parse(v) : v])); });
    } else { const xml = parseNativeCatalogXmlRecords(bytes.toString('utf8')); assert.equal(xml.currency, 'PLN'); parsed = xml.rows; }
    values(parsed);
    const filename = 'catalog-export-catalogs-native158-' + phase + '-' + (prefix === '/api' ? 'normal' : 'v1') + '.' + format;
    await wx(resolve(ROOT, 'data', filename), bytes, 0o600);
    records.push({ prefix, format, request: body, preview, headers: Object.fromEntries(r.headers), bytes: bytes.length, sha256: sha(bytes), file: filename, parsed });
    for (const [label, denied, expected] of [
      ['altered_hash', { ...body, scope_hash: '0'.repeat(64) }, 409],
      ['stale_version', { ...body, catalog_version: '2' }, 409],
      ['missing_proof', definition, 422],
      ['cross_pool_selection', { ...body, selection: 'selected', ids: [products[0].id, 'd36804c6-24c5-4697-a170-0e8c58eea1b0'] }, 409],
      ['unassigned_warehouse', { ...body, warehouse_ids: ['6b5a9ffb-fb6e-485d-a3fa-35d5346a7944'] }, 409],
    ] as const) {
      step = prefix + '-' + format + '-' + label;
      const refusal = await req('/catalog/exports/file', prefix, denied); assert.equal(refusal.status, expected);
      assert(/^application\/(?:problem\+)?json(?:;|$)/.test(refusal.headers.get('content-type') ?? '')); assert.equal(refusal.headers.get('x-product-catalog-id'), null);
      const errorBytes = await refusal.arrayBuffer(); assert(errorBytes.byteLength < 16384); negatives.push({ prefix, format, label, status: refusal.status, no_file_headers: true });
    }
  }
  if (restored) for (const prefix of ['/api', '/api/v1']) {
    const r = await req('/catalog/export-profiles', prefix, {}); assert.equal(r.status, 423); await r.arrayBuffer();
    negatives.push({ prefix, label: 'malformed_profile_write', status: r.status });
  }
  await wx(resolve(ROOT, 'data/catalog-export-catalogs-native158-' + phase + '.json'), JSON.stringify({ stage: 158, phase, revision, records, negatives }, null, 2) + '\n', 0o600);
  await wx(resolve(ROOT, 'docs/catalog-export-catalogs-native158-files-' + phase + '.json'), JSON.stringify({ stage: 158, phase, revision,
    status: 'LOCAL_SCOPED_EXPORT_BYTES_PASS', schema_revision: h.schema_revision, restored, files: records.map((r: any) => ({ prefix: r.prefix, format: r.format, bytes: r.bytes, sha256: r.sha256, count: 2 })),
    literal_stock: 3, literal_reserved: 0, literal_price_minor: 1501, scope_headers_verified: true, negative_checks: negatives,
    browser_download_path_verified: false, profile_writes_verified: false, provider_verified: false, baseline_rebased: false, full_goal_complete: false }, null, 2) + '\n', 0o644);
  console.log('LOCAL_SCOPED_EXPORT_BYTES_PASS');
}
main().catch((error: unknown) => {
  const line = (error instanceof Error ? error.stack ?? '' : '').match(/catalog-export-catalogs-native158\.ts:(\d+):(\d+)/);
  console.error(JSON.stringify({ status: 'QA158_NATIVE_FILES_FAILED', step, ...(line ? { source_line: Number(line[1]) } : {}), private_details_withheld: true })); process.exitCode = 1;
});
