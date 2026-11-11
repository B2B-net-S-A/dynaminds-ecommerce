// Migration 251_b2b_network_lifecycle (B2B-002, B2B-003, B2B-004-X, B2B-005; prepared as 258, registered after 250;
// docs/parity/B2B-LIFECYCLE251-20261028.md): SQL shape, manifest pin and wiring, without a database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const sql = await read('server/251_b2b_network_lifecycle.sql');
const body = sql.replace(/--[^\n]*/g, '');
const TABLES = ['b2b258_link_states', 'b2b258_link_events', 'b2b258_mappings', 'b2b258_mapping_events', 'b2b258_order_decisions', 'b2b258_order_events', 'b2b258_tracking_copies'];

test('seven own tables, each with RLS enabled and forced and a tenant_scope policy', () => {
  assert.deepEqual([...body.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]), TABLES);
  for (const t of TABLES) {
    assert.match(body, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`));
    assert.match(body, new RegExp(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`));
    assert.match(body, new RegExp(`CREATE POLICY tenant_scope ON ${t} `));
  }
});

test('no DELETE or TRUNCATE for the application; histories, events and copies are append-only', () => {
  assert.doesNotMatch(body, /GRANT[^;]*(DELETE|TRUNCATE|ALL)/);
  assert.match(body, /GRANT SELECT,INSERT,UPDATE ON TABLE b2b258_link_states, b2b258_mappings, b2b258_order_decisions TO dyna_app;/);
  assert.match(body, /GRANT SELECT,INSERT ON TABLE b2b258_link_events, b2b258_mapping_events, b2b258_order_events, b2b258_tracking_copies TO dyna_app;/);
});

test('no core table is altered or referenced; only own-to-own foreign keys', () => {
  assert.doesNotMatch(body, /ALTER TABLE (?!b2b258_)/);
  assert.doesNotMatch(body, /DROP |TRUNCATE|DELETE FROM|UPDATE public\.|INSERT INTO public\./);
  for (const m of body.matchAll(/REFERENCES (\w+)/g)) assert.match(m[1], /^b2b258_/, m[0]);
  assert.deepEqual([...body.matchAll(/CREATE TRIGGER (\w+)[^;]* ON (\w+)/g)].map((m) => m[2]), ['b2b258_link_states', 'b2b258_link_events']);
});

test('object names avoid every sealed fingerprint family', () => {
  const names = [...body.matchAll(/CREATE (?:TABLE|INDEX|FUNCTION|TRIGGER|POLICY) (\w+)/g)].map((m) => m[1]);
  assert(names.length >= 20);
  for (const n of names) {
    if (['tenant_scope', 'supplier_side', 'buyer_read'].includes(n)) continue;
    assert.match(n, /^b2b258_/, n);
    assert.doesNotMatch(n, /^(b2b_credit_|b2b_dropship_|b2b_invoice_|b2b_catalog_scope_|warehouse_wz_issuer_)/, n);
  }
});

test('money is integer minor units; decisions carry a deadline; one event per decision or parcel', () => {
  assert.match(body, /purchase_price_minor bigint CHECK \(purchase_price_minor BETWEEN 0 AND 100000000000\)/);
  assert.match(body, /decide_by timestamptz NOT NULL/);
  assert.match(body, /UNIQUE \(tenant_id, network_order_id, dedup_key\)/);
  assert.match(body, /PRIMARY KEY \(tenant_id, dropship_order_id, source_shipment_id\)/);
  assert.match(sql, /^-- Migration 251_b2b_network_lifecycle \(prepared as 258, registered after 250_wms_evidence_settle_unlocked; object names\n-- keep the b2b258_ prefix\)\./);
});

test('251 follows 250 in the release list and pins the exact SQL bytes', async () => {
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 251), row = RELEASE_MIGRATIONS[i];
  const b = await readFile(new URL('server/251_b2b_network_lifecycle.sql', root));
  assert(row, 'manifest row 251');
  assert.equal(row.name, '251_b2b_network_lifecycle');
  assert.equal(row.file, '251_b2b_network_lifecycle.sql');
  assert.equal(row.native_id, 'b2b_network_lifecycle251');
  assert.equal(row.cold.contract, 'b2b-network-lifecycle251');
  assert.equal(row.cold.project, 'projectCompiledB2bNetworkLifecycle251Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 14123);
  assert.equal(row.sha256, '23a3b94c3248ea0aa323aba7c01a3878c5c895bc10d381e1686a4597b20a423f');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '250_wms_evidence_settle_unlocked');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '252_mirakl_operations', '252 follows 251');
  const db = await read('server/db.ts');
  assert.doesNotMatch(db, /b2b_network_lifecycle/, 'db.ts takes 251 from the manifest, not a literal pair');
});

test('the routes are wired through existing registrations, so app.ts stays unchanged', async () => {
  const orders = await read('server/b2b-network-orders.ts');
  assert.match(orders, /registerB2bNetworkLifecycleRoutes\(app\);/);
  assert.match(orders, /registerB2bNetworkMappingRoutes\(app\);/);
  assert.match(orders, /registerB2bNetworkDecisionRoutes\(app\);/);
  assert.match(orders, /openNetworkDecisionInTx\(c, own\)/);
  const network = await read('server/b2b-network.ts');
  for (const call of ['networkLinkDisconnectedInTx(c, a.id)', 'reconnectNetworkLinkInTx(c, r.actor,', 'assertNetworkLinkConnectedInTx(c, l)'])
    assert.equal(network.split(call).length, 2, call);
  const worker = await read('server/worker.ts');
  assert.match(worker, /run: sweepB2bNetworkLifecycleDue/);
  const routes = await read('server/b2b-network-dropshipping-routes.ts');
  assert.match(routes, /root \+ '\/orders\/:id\/tracking\/sync'/);
});
