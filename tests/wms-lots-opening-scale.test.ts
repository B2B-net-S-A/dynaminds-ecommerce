/** WMS opening of a company with more than 10 000 stock rows (docs/parity/WMS-LIMITS-20261026.md, "Otwarcie").
 * Every product gets a stock row on creation, so a 20 000 SKU catalogue has ~19 200 stock and bin rows of which
 * only ~5 % hold stock. The opening counts all of them against a plan-dependent cap: starter/business keep
 * 10 000 (413, nothing written), enterprise opens. Rows without stock are locked and digested in SQL, so the
 * preview stays small and a change to one of them still invalidates the opening.
 * Fresh companies through the real signup route; positive stock through createProduct, the zero rows in bulk as
 * the owner with all triggers on (the ordinary path would take hours on PG04). Prints wall times of the snapshot
 * statement, preview and activation at 19 200 and 100 000 rows (`wms-opening-scale-results`).
 * Root-only on a fresh clone dynaminds_wmsopen_20261029_NN of the restored template after the real migrate(). */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, tenantTx } from '../server/db';
import { createProduct } from '../server/catalog';
import { productSchema } from '../server/domain';
import {
  activateWmsOpening,
  createWmsOpeningPreview,
  wmsLotsPolicyInTx,
  wmsOpeningScope,
  wmsPreviewDetail,
} from '../server/wms-lots';
import { relaxPoolTimeouts } from './failure-helpers';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_wmsopen_20261029_[0-9]{2}$/, 'fresh clone dynaminds_wmsopen_20261029_NN required');
relaxPoolTimeouts(900);

type Company = { tenantId: string; userId: string; warehouse: string; actor: { tenantId: string; userId: string; role: 'admin'; source: 'manual' } };
const results: Record<string, unknown> = {};
let app: FastifyInstance;
const ms = (start: number) => Math.round(performance.now() - start);

async function company(label: string): Promise<Company> {
  const email = `wmsopen-${label}-${randomUUID().slice(0, 8)}@scale.example.test`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email, name: 'Otwarcie WMS ' + label, password: randomUUID() + randomUUID(), organization: { name: 'WMS open ' + label, currency: 'PLN', locale: 'pl-PL' } },
  });
  assert.equal(res.statusCode, 201, res.body);
  const r = (
    await pool.query(
      `SELECT m.tenant_id,m.user_id,(SELECT id FROM warehouses w WHERE w.tenant_id=m.tenant_id ORDER BY code='MAIN' DESC,id LIMIT 1) warehouse
      FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=$1 AND m.role='admin'`,
      [email],
    )
  ).rows[0];
  assert(r?.warehouse);
  // The catalogue needs the enterprise product quota (500 000); the plan under test is set per case.
  await pool.query("UPDATE tenants SET plan='enterprise' WHERE id=$1", [r.tenant_id]);
  return { tenantId: r.tenant_id, userId: r.user_id, warehouse: r.warehouse, actor: { tenantId: r.tenant_id, userId: r.user_id, role: 'admin', source: 'manual' } };
}
const setPlan = (t: Company, plan: string) => pool.query('UPDATE tenants SET plan=$2 WHERE id=$1', [t.tenantId, plan]);

/** `positive` products with stock through the ordinary createProduct, then zero-stock products up to `total`
 * stock rows, inserted as the owner in chunks with every trigger on (stock_location_reconcile adds the bin). */
async function stockRows(t: Company, positive: number, total: number) {
  for (let from = 0; from < positive; from += 250)
    await tenantTx(t.tenantId, async (c) => {
      for (let i = from; i < Math.min(from + 250, positive); i++)
        await createProduct(c, t.actor, productSchema.parse({
          name: 'Produkt z zapasem ' + i, sku: `WO-P-${i}`, price: 1000, warehouse_id: t.warehouse,
          quantity: 1 + (i % 7), location: 'A-' + String(i % 40).padStart(2, '0'), kind: 'simple',
        }));
    });
  const catalog = (await pool.query('SELECT catalog_id FROM products WHERE tenant_id=$1 LIMIT 1', [t.tenantId])).rows[0].catalog_id;
  for (let from = positive; from < total; from += 5000) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [t.tenantId]);
      await c.query(
        `WITH p AS (INSERT INTO products(id,tenant_id,sku,name,price,catalog_id)
          SELECT gen_random_uuid(),$1,'WO-Z-'||i,'Produkt bez zapasu '||i,1000,$2 FROM generate_series($3::int,$4::int) i RETURNING id)
        INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand,location) SELECT $1,$5,id,0,'A-01' FROM p`,
        [t.tenantId, catalog, from, Math.min(from + 5000, total) - 1, t.warehouse],
      );
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  await pool.query('ANALYZE products; ANALYZE stock; ANALYZE stock_locations');
  const n = (await pool.query(
    `SELECT (SELECT count(*) FROM stock WHERE tenant_id=$1)::int stock,(SELECT count(*) FROM stock WHERE tenant_id=$1 AND on_hand>0)::int stocked,
    (SELECT count(*) FROM stock_locations WHERE tenant_id=$1)::int bins`, [t.tenantId])).rows[0];
  assert.deepEqual(n, { stock: total, stocked: positive, bins: total });
}

/** The opening lines: every positive bin (what tools/scale/writer.mjs enableLots sends). */
async function lines(t: Company) {
  return (
    await pool.query(
      `SELECT b.warehouse_id,b.product_id,b.location,b.quantity,s.version::text stock_version FROM stock_locations b
      JOIN stock s USING(tenant_id,warehouse_id,product_id) WHERE b.tenant_id=$1 AND b.quantity>0 ORDER BY b.product_id,b.location`,
      [t.tenantId],
    )
  ).rows.map((b, i) => ({ ...b, lot_code: 'OPEN-' + i, unit_cost_minor: i % 5 ? String(100 + i) : null }));
}
const preview = async (t: Company) =>
  createWmsOpeningPreview(t.actor, { client_key: randomUUID(), policy_version: '0', currency: 'PLN', note: 'Otwarcie testu skali', lines: await lines(t) });

/** Preview, detail and activation with wall times; the policy is on and every positive bin has one layer. */
async function open(t: Company, label: string) {
  let s = performance.now();
  await tenantTx(t.tenantId, (c) => c.query('SELECT 1'), { wmsAdmission: 'read' });
  const emptyTxMs = ms(s);
  s = performance.now();
  const scope = await wmsOpeningScope(t.actor, {});
  const scopeMs = ms(s);
  s = performance.now();
  const pv = await preview(t);
  const previewMs = ms(s);
  assert.deepEqual(pv.preview.issues, []);
  assert.equal(pv.preview.ready, true);
  assert.equal(scope.scope_hash.length, 64);
  const detail = await wmsPreviewDetail(t.actor, pv.preview.id, 'opening');
  const detailBytes = Buffer.byteLength(JSON.stringify(detail));
  const stored = (await pool.query('SELECT octet_length(snapshot::text) n FROM wms_previews WHERE id=$1', [pv.preview.id])).rows[0].n;
  // Zero rows are summarised: the stored preview and its detail do not grow with the catalogue.
  assert(stored < 2 * 1024 * 1024 && detailBytes < 1024 * 1024, `preview ${stored} B, detail ${detailBytes} B`);
  s = performance.now();
  const r = await activateWmsOpening(t.actor, pv.preview.id, {
    client_key: randomUUID(), scope_hash: pv.preview.scope_hash, confirmed: true, ack_unknown_costs: true,
  });
  const activateMs = ms(s);
  assert.equal(r.reused, false);
  const policy = await tenantTx(t.tenantId, (c) => wmsLotsPolicyInTx(c), { wmsAdmission: 'read' });
  assert.equal(policy.enabled, true);
  const counts = (await pool.query(
    `SELECT (SELECT count(*) FROM wms_cost_layers WHERE tenant_id=$1)::int layers,
    (SELECT count(*) FROM stock_locations WHERE tenant_id=$1 AND quantity>0)::int positive`, [t.tenantId])).rows[0];
  assert.equal(counts.layers, counts.positive);
  results[label] = { empty_tx_ms: emptyTxMs, scope_ms: scopeMs, preview_ms: previewMs, activate_ms: activateMs, detail_bytes: detailBytes, stored_snapshot_bytes: stored, layers: counts.layers };
}

/** Wall time of the opening snapshot statements alone as the app role, locked as in the preview. */
async function snapshotStatementMs(t: Company) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [t.tenantId]);
    await c.query("SET LOCAL statement_timeout='8s'");
    const s = performance.now();
    const stock = (await c.query('SELECT count(*)::int n FROM (SELECT 1 FROM stock s ORDER BY s.warehouse_id,s.product_id FOR UPDATE OF s) x')).rows[0].n;
    const bins = (await c.query('SELECT count(*)::int n FROM (SELECT 1 FROM stock_locations b ORDER BY b.warehouse_id,b.product_id,b.location COLLATE "C" FOR UPDATE OF b) x')).rows[0].n;
    return { ms: ms(s), stock, bins };
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

before(async () => {
  assert.equal((await pool.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name, RELEASE_MIGRATIONS.at(-1)!.name, 'clone after the real migrate() required (ledger at the last release migration)');
  app = await buildApp({});
  await app.ready();
});
after(async () => {
  console.log('wms-opening-scale-results', JSON.stringify(results));
  await app?.close();
  await pool.end();
});

test('19 200 stock rows (950 stocked): business is refused with 413 and nothing written; enterprise opens', async () => {
  const t = await company('a');
  let s = performance.now();
  await stockRows(t, 950, 19_200);
  results.seed_19200_ms = ms(s);
  await setPlan(t, 'business');
  await assert.rejects(preview(t), (e: any) => e.status === 413 && /za dużo stanów/.test(e.message));
  assert.equal((await pool.query('SELECT count(*)::int n FROM wms_previews WHERE tenant_id=$1', [t.tenantId])).rows[0].n, 0);
  await setPlan(t, 'enterprise');
  results.lock_19200_ms = await snapshotStatementMs(t);
  await open(t, 'rows_19200');
});

test('a zero-stock row that changes after the preview invalidates the activation (409)', async () => {
  const t = await company('b');
  await stockRows(t, 20, 10_500);
  await setPlan(t, 'enterprise');
  const pv = await preview(t);
  assert.equal(pv.preview.ready, true);
  // A rename of a product without stock (its stock row stays zero) changes the digested zero rows.
  await pool.query("UPDATE products SET name=name||' (zmiana)' WHERE id=(SELECT product_id FROM stock WHERE tenant_id=$1 AND on_hand=0 LIMIT 1)", [t.tenantId]);
  await assert.rejects(
    activateWmsOpening(t.actor, pv.preview.id, { client_key: randomUUID(), scope_hash: pv.preview.scope_hash, confirmed: true, ack_unknown_costs: true }),
    (e: any) => e.status === 409,
  );
  assert.equal((await pool.query('SELECT count(*)::int n FROM wms_policies WHERE tenant_id=$1', [t.tenantId])).rows[0].n, 0);
});

test('100 000 stock rows (950 stocked) on enterprise open within the statement limit', async () => {
  const t = await company('c');
  const s = performance.now();
  await stockRows(t, 950, 100_000);
  results.seed_100000_ms = ms(s);
  await setPlan(t, 'enterprise');
  results.lock_100000_ms = await snapshotStatementMs(t);
  await open(t, 'rows_100000');
});
