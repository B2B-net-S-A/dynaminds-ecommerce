// Read-only evidence for the local recovery drill. Does not select credentials or session tokens.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { pool } from '../server/db';
import { publicOperations } from '../server/developer-api';
import {
  localDatabase,
  restoreDatabaseName,
  schemaFingerprint,
  tableFingerprints,
} from '../server/recovery';
const args = process.argv.slice(2);
const argument = (name: string) => {
  const at = args.indexOf(name);
  assert(at >= 0 && args[at + 1], `Wymagany ${name}`);
  return args[at + 1];
};
const result = JSON.parse(await readFile(argument('--result'), 'utf8'));
const backup = JSON.parse(await readFile(argument('--backup') + '.json', 'utf8'));
assert.equal(result.status, 'verified');
assert(result.row_fingerprints_match && result.schema_fingerprint_match);
assert.equal(result.worker_enabled, false);
const source = new pg.Client(localDatabase());
const restored = new pg.Client({
  ...localDatabase(),
  database: restoreDatabaseName(result.database),
});
const qaTenant = '96fa8749-1da7-46f7-9997-c4527c2474bf';
try {
  await source.connect();
  await restored.connect();
  for (const client of [source, restored]) {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
  }
  const original = await tableFingerprints(source),
    recovered = await tableFingerprints(restored);
  const businessTables = [
    'tenants',
    'users',
    'memberships',
    'products',
    'stock',
    'orders',
    'order_items',
    'order_events',
    'documents',
    'shipments',
    'product_images',
    'workspace_usage',
    'outbound_deliveries',
    'local_webhook_inbox',
    'channels',
    'return_cases',
    'return_items',
    'invoice_plans',
    'stock_movements',
  ];
  for (const table of businessTables) {
    assert(original[table], `Brak tabeli ${table}`);
    assert.deepEqual(recovered[table], original[table], `Zmiana danych ${table}`);
  }
  assert.equal(await schemaFingerprint(restored), await schemaFingerprint(source));
  const prior = (
    await restored.query(
      "SELECT id,number,status,total,currency FROM orders WHERE number='DE-20261003-87D02A09'",
    )
  ).rows[0];
  assert.equal(prior.status, 'return_completed');
  assert.equal(prior.total, 3299);
  const documents = (
    await restored.query(
      "SELECT number,kind,mode,(data->>'total')::int AS total FROM documents WHERE order_id=$1 ORDER BY number",
      [prior.id],
    )
  ).rows;
  assert(documents.some((d) => d.kind === 'invoice' && d.total === 3299));
  const qa = (
    await restored.query(
      'SELECT number,status,total FROM orders WHERE tenant_id=$1 ORDER BY number',
      [qaTenant],
    )
  ).rows;
  assert.equal(qa.length, 3);
  assert(qa.every((o) => o.status === 'return_completed' && o.total === 26189));
  const stock = (
    await restored.query(
      'SELECT p.sku,s.on_hand,s.reserved FROM stock s JOIN products p ON (p.tenant_id,p.id)=(s.tenant_id,s.product_id) WHERE s.tenant_id=$1 ORDER BY p.sku',
      [qaTenant],
    )
  ).rows;
  assert(stock.every((s) => s.on_hand === 5 && s.reserved === 0));
  const images = (await restored.query('SELECT id,size FROM product_images ORDER BY id')).rows;
  for (const image of images) {
    const a = await readFile(resolve('data/product-images', image.id));
    const b = await readFile(resolve(result.images, image.id));
    assert.deepEqual(a, b);
    assert.equal(b.length, image.size);
    image.sha256 = createHash('sha256').update(b).digest('hex');
  }
  const deniedNoteCount = Number(
    (
      await restored.query(
        "SELECT count(*) FROM order_events WHERE detail::text LIKE '%QA RESTORE%'",
      )
    ).rows[0].count,
  );
  assert.equal(deniedNoteCount, 0);
  await restored.query('SET LOCAL ROLE dyna_app');
  await restored.query("SELECT set_config('app.tenant_id',$1,true)", [qaTenant]);
  const rlsTenants = (await restored.query('SELECT DISTINCT tenant_id FROM products')).rows;
  assert.deepEqual(rlsTenants, [{ tenant_id: qaTenant }]);
  assert.equal(Number((await restored.query('SELECT count(*) FROM products')).rows[0].count), 3);
  let denied = '';
  try {
    await restored.query('SELECT password_hash FROM users');
  } catch (e) {
    denied = (e as any).code;
  }
  assert.equal(denied, '42501');
  await restored.query('ROLLBACK');
  await source.query('ROLLBACK');
  const health = await (await fetch('http://127.0.0.1:4100/api/health')).json();
  const previewHealth = await (await fetch('http://localhost:4101/api/health')).json();
  // The source can still run the previous revision during a drill; its legacy health omits this flag.
  assert.notEqual(health.restore_preview, true);
  assert.equal(previewHealth.restore_preview, true);
  const primarySpec = await (await fetch('http://127.0.0.1:4100/api/v1/openapi')).json();
  assert.deepEqual(primarySpec, JSON.parse(await readFile('docs/openapi.json', 'utf8')));
  const previewSpec = await (await fetch('http://localhost:4101/api/v1/openapi')).json();
  const countOperations = (spec: any) =>
    Object.values(spec.paths).reduce((n: number, p: any) => n + Object.keys(p).length, 0);
  assert.equal(countOperations(primarySpec), publicOperations.length);
  assert.equal(previewSpec.servers[0].url, 'http://localhost:4101/api/v1');
  assert(
    Object.values(previewSpec.paths).every((p: any) => Object.keys(p).every((k) => k === 'get')),
  );
  for (const [method, path] of [
    ['POST', '/api/products'],
    ['GET', '/api/inpost/points?city=Warszawa'],
    ['GET', '/api/oauth/allegro/start'],
  ]) {
    const response = await fetch('http://localhost:4101' + path, { method });
    assert.equal(response.status, 423);
  }
  const report = {
    checked_at: new Date().toISOString(),
    scope: 'native pg_dump/pg_restore + PostgreSQL + local HTTP + Chrome; local synthetic data',
    backup,
    restore: { ...result, config: undefined },
    health,
    preview_health: previewHealth,
    business_tables_checked: businessTables,
    business_fingerprints_unchanged: true,
    schema_fingerprint_match: true,
    prior_prestashop_order: prior,
    documents,
    qa_orders: qa,
    qa_stock: stock,
    images,
    denied_note_count: deniedNoteCount,
    rls: { visible_tenants: rlsTenants, password_column_denial: denied },
    openapi: {
      primary_operations: countOperations(primarySpec),
      preview_operations: countOperations(previewSpec),
      preview_server: previewSpec.servers[0].url,
    },
    mutations_and_provider_reads_blocked: true,
    limitations: [
      'same local cluster; not fresh-machine recovery',
      'no PITR/off-device replica or automatic schedule',
      'small snapshot timings are not an RTO/SLA or target-scale proof',
    ],
  };
  await writeFile(
    process.env.DYNA_RECOVERY_OUTPUT ?? 'docs/recovery-qa.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      tables: result.tables,
      images: images.length,
      encrypted_records: result.encrypted_records_verified,
      business_tables: businessTables.length,
      rows_match: true,
      schema_match: true,
      rls: true,
      read_only_preview: true,
      health,
      preview_health: previewHealth,
    }),
  );
} finally {
  await source.end().catch(() => {});
  await restored.end().catch(() => {});
  await pool.end();
}
