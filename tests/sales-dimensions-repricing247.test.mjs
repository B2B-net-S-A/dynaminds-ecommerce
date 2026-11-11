/** Migration server/247_sales_dimensions_repricing.sql (prepared as placeholder 252, registered after 246). Three own
 * tables only: the order sales dimensions recorded at import
 * (ANALYTICS-002), manual repricing overrides (REPRICE-004) and the channel result of a scheduled repricing run
 * (REPRICE-005/006). No core table is altered, referenced or written; the application role cannot DELETE; RLS per
 * tenant. The manifest row pins the exact bytes after 246. No database; behaviour is pinned by
 * tests/sales-dimensions-repricing247.database.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const dir = new URL('../server/', import.meta.url);
const name = readdirSync(dir).find((f) => /^247_[a-z0-9_]+\.sql$/.test(f));
const code = () => readFileSync(new URL(name, dir), 'utf8').replace(/--.*$/gm, '');
const TABLES = ['order_sales_dimensions', 'repricing_overrides', 'repricing_channel_results'];
// Function name families sealed by fingerprints of earlier migrations (LIKE '<prefix>%'); no new object may match.
const SEALED = ['b2b_invoice_', 'fa3_draft_', 'b2b_credit_', 'credit_source_upgrade_', 'competitor_observation', 'warehouse_wz_issuer_',
  'catalog_stock_', 'local_invoice_', 'warehouse_automatic_wz_', 'return_', 'stocktake_adjustment_', 'local_consumer_credit_',
  'allegro_oauth_recovery_', 'order_parcel_', 'packed_label_print_', 'product_catalog_', 'price_matrix_import_', 'price_file_import_',
  'proforma_', 'label_', 'email_inbound_', 'warehouse_inventory_policy_', 'stock_file_import_', 'language_file_import_', 'b2b_dropship_return_', 'b2b_catalog_scope_'];

test('247 follows 246 in the release list and pins the exact SQL bytes', () => {
  assert.equal(name, '247_sales_dimensions_repricing.sql');
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 247), row = RELEASE_MIGRATIONS[i], b = readFileSync(new URL(name, dir));
  assert(row, 'manifest row 247');
  assert.equal(row.name, '247_sales_dimensions_repricing');
  assert.equal(row.file, '247_sales_dimensions_repricing.sql');
  assert.equal(row.native_id, 'sales_dimensions_repricing247');
  assert.equal(row.cold.contract, 'sales-dimensions-repricing247');
  assert.equal(row.cold.project, 'projectCompiledSalesDimensionsRepricing247Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 5695);
  assert.equal(row.sha256, '62fd185e0b205b6b530392b7353702c7fb8303cb6428058067b30aa04ba9700b');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '246_b2b_trade_credit_directory');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '248_guard_verdicts', '248 follows 247');
});

test('one file 247_<topic>.sql creates exactly the three own tables', () => {
  assert(name, 'server/247_<topic>.sql exists');
  assert.deepEqual([...code().matchAll(/CREATE\s+TABLE\s+([a-z0-9_]+)/g)].map((m) => m[1]), TABLES);
  for (const m of code().matchAll(/(?:CREATE|ALTER|DROP)\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|FUNCTION|TRIGGER|VIEW|TYPE|SEQUENCE|POLICY)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:public\.)?([a-z0-9_]+)/gi)) {
    if (/POLICY/i.test(m[0])) continue;
    assert(TABLES.some((t) => m[1] === t || m[1].startsWith(t + '_')), m[0]);
    for (const p of SEALED) assert(!m[1].startsWith(p), `${m[1]} matches the sealed family ${p}`);
  }
  for (const m of code().matchAll(/\bON\s+(?!CONFLICT\b)(?:TABLE\s+)?(?:public\.)?([a-z0-9_]+)/gi)) assert(TABLES.includes(m[1]), m[0]);
});

test('no core table is altered, referenced or written; no function, trigger or definer code', () => {
  const s = code();
  assert.doesNotMatch(s, /\bREFERENCES\b/i, 'no foreign key: no RI trigger lands on orders, products, price_lists or offer_plans');
  assert.doesNotMatch(s, /\b(?:INSERT\s+INTO|UPDATE\s+[a-z_.]+\s+SET|DELETE\s+FROM)\b/i, 'the migration writes no rows');
  assert.doesNotMatch(s, /SECURITY\s+DEFINER|EVENT\s+TRIGGER|CREATE\s+TRIGGER|CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|\bDO\s+\$/i);
  assert.doesNotMatch(s, /ALTER\s+TABLE\s+(?!(?:order_sales_dimensions|repricing_overrides|repricing_channel_results)\b)/i);
  assert.doesNotMatch(s, /\b(?:email|customer_name|phone|address)\b/i, 'no personal data column');
});

test('groups, states and amounts are constrained in the tables themselves', () => {
  const s = code();
  assert.match(s, /delivery_method text NOT NULL CHECK \(delivery_method IN \('parcel_locker','pickup_point','courier','post','personal_pickup','digital','other','unknown'\)\)/);
  assert.match(s, /payment_method text NOT NULL CHECK \(payment_method IN \('cod','transfer','card','online','cash','marketplace','other','unknown'\)\)/);
  assert.match(s, /PRIMARY KEY \(tenant_id, order_id\)/);
  assert.match(s, /mode text NOT NULL CHECK \(mode IN \('exclude','fixed'\)\)/);
  assert.match(s, /CHECK \(\(mode = 'fixed'\) = \(fixed_price IS NOT NULL\)\)/);
  assert.match(s, /fixed_price integer CHECK \(fixed_price BETWEEN 0 AND 100000000\)/);
  assert.match(s, /CREATE UNIQUE INDEX repricing_overrides_active ON repricing_overrides\(tenant_id, price_list_id, product_id\) WHERE revoked_at IS NULL;/);
  assert.match(s, /CHECK \(\(revoked_at IS NULL\) = \(revoked_by IS NULL\)\)/);
  assert.match(s, /status text NOT NULL DEFAULT 'pending' CHECK \(status IN \('pending','sent','acknowledged','mismatch','failed','superseded'\)\)/);
  assert.match(s, /PRIMARY KEY \(tenant_id, run_id, listing_id\)/);
  assert.match(s, /CREATE INDEX repricing_channel_results_open ON repricing_channel_results\(tenant_id, created_at, run_id\) WHERE status IN \('pending','sent'\);/);
});

test('dyna_app works under a tenant policy and never deletes; dimensions are append-only for it', () => {
  const s = code();
  for (const t of TABLES) {
    assert.match(s, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`));
    assert.match(s, new RegExp(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`));
    assert.match(s, new RegExp(`CREATE POLICY tenant_scope ON ${t} USING \\(tenant_id=NULLIF\\(current_setting\\('app\\.tenant_id',true\\),''\\)::uuid\\) WITH CHECK \\(tenant_id=NULLIF\\(current_setting\\('app\\.tenant_id',true\\),''\\)::uuid\\);`));
  }
  assert.match(s, /REVOKE ALL ON TABLE order_sales_dimensions, repricing_overrides, repricing_channel_results FROM PUBLIC,dyna_app;/);
  assert.deepEqual([...s.matchAll(/\bGRANT\s+([A-Z, ]+)\s+ON\s+TABLE\s+(\S+)\s+TO\s+(\S+);/g)].map((m) => [m[1].trim(), m[2], m[3]]), [
    ['SELECT,INSERT', 'order_sales_dimensions', 'dyna_app'],
    ['SELECT,INSERT,UPDATE', 'repricing_overrides', 'dyna_app'],
    ['SELECT,INSERT,UPDATE', 'repricing_channel_results', 'dyna_app'],
  ]);
});
