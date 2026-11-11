/** Read-only assertions of actual IAB QA104 actions; private state is never printed. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/catalog-bulk-edit-stage104.json';
const phase = process.argv[2];
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function snapshot(s: any, names: string[]) {
  const result: Record<string, string> = {};
  for (const name of names) {
    assert(/^[a-z][a-z0-9_]*$/.test(name));
    result[name] = digest(
      (
        await pool.query(
          `SELECT to_jsonb(t) row FROM "${name}" t WHERE ${name === 'tenants' ? 'id' : 'tenant_id'}=$1 ORDER BY 1`,
          [s.tenant],
        )
      ).rows,
    );
  }
  return result;
}
const commerce = [
  'orders',
  'order_items',
  'order_pick_items',
  'stock',
  'stock_movements',
  'reservations',
  'shipments',
  'documents',
  'listings',
  'bundle_components',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
];
try {
  const s = JSON.parse(await readFile(path, 'utf8'));
  assert(s.api_acceptance);
  const productRows = async () =>
    JSON.parse(
      JSON.stringify(
        (await pool.query('SELECT * FROM products WHERE tenant_id=$1 ORDER BY id', [s.tenant]))
          .rows,
      ),
    ) as any[];
  if (phase === 'begin') {
    assert(!s.ui_started);
    s.ui_started = true;
    s.ui_write_revision = s.runtime_revision;
    s.ui_commerce_before = await snapshot(s, commerce);
    s.ui_products_before = await productRows();
  } else if (phase === 'preview-before') {
    assert(s.ui_started && !s.ui_preview_before);
    s.ui_preview_before = await snapshot(
      s,
      s.own_names.filter((n: string) => !n.startsWith('catalog_bulk_edit_')),
    );
    s.ui_previous_previews = (
      await pool.query('SELECT id FROM catalog_bulk_edit_previews WHERE tenant_id=$1 ORDER BY id', [
        s.tenant,
      ])
    ).rows.map((r) => r.id);
  } else if (phase === 'preview-after') {
    assert(s.ui_preview_before && !s.ui_preview_unchanged);
    assert.deepEqual(await snapshot(s, Object.keys(s.ui_preview_before)), s.ui_preview_before);
    const p = (
      await pool.query(
        'SELECT * FROM catalog_bulk_edit_previews WHERE tenant_id=$1 AND NOT(id=ANY($2::uuid[]))',
        [s.tenant, s.ui_previous_previews],
      )
    ).rows;
    assert.equal(p.length, 1);
    assert(p[0].ready);
    assert.equal(p[0].total, 2);
    assert.equal(p[0].changed, 2);
    s.ui_preview_id = p[0].id;
    s.ui_preview_unchanged = true;
  } else if (phase === 'finish') {
    assert(s.ui_preview_unchanged && !s.ui_acceptance);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND state IN ('pending','running')",
          [s.tenant],
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(await snapshot(s, commerce), s.ui_commerce_before);
    const products = await productRows();
    for (const [index, price] of [
      [1, 15999],
      [2, 4999],
    ]) {
      const before = s.ui_products_before.find((p: any) => p.id === s.products[index].id);
      const after = products.find((p) => p.id === before.id)!;
      assert.equal(after.price, price);
      assert.equal(after.category, 'Arkusz UI104');
      assert.equal(after.name, 'UI produkt104-' + index);
      assert.equal(after.active, true);
      assert.equal(after.version, before.version + 1);
      for (const key of [
        'sku',
        'kind',
        'parent_id',
        'ean',
        'vat',
        'description',
        'attributes',
        'images',
      ])
        assert.deepEqual(after[key], before[key], key);
    }
    for (const id of [s.products[0].id, s.bundle.id])
      assert.deepEqual(
        products.find((p) => p.id === id),
        s.ui_products_before.find((p: any) => p.id === id),
      );
    const e = (
      await pool.query(
        'SELECT * FROM catalog_bulk_edit_executions WHERE tenant_id=$1 AND preview_id=$2',
        [s.tenant, s.ui_preview_id],
      )
    ).rows;
    assert.equal(e.length, 1);
    assert.equal(e[0].state, 'done');
    assert.equal(e[0].changed, 2);
    const rows = (
      await pool.query(
        'SELECT * FROM catalog_bulk_edit_execution_rows WHERE tenant_id=$1 AND execution_id=$2 ORDER BY index',
        [s.tenant, e[0].id],
      )
    ).rows;
    assert.equal(rows.length, 2);
    assert(rows.every((r) => r.status === 'changed' && r.after_version === r.before_version + 1));
    assert.deepEqual(
      rows.map((r) => r.product_id).sort(),
      [s.products[1].id, s.products[2].id].sort(),
    );
    s.ui_execution_id = e[0].id;
    s.ui_acceptance = true;
    s.own_snapshot = await snapshot(s, s.own_names);
    s.own_snapshot_timezone = (await pool.query('SHOW TimeZone')).rows[0].TimeZone;
    await writeFile(
      'docs/catalog-bulk-edit-ui-qa.json',
      JSON.stringify(
        {
          stage: 104,
          revision: s.runtime_revision,
          initial_ui_write_revision: s.ui_write_revision ?? s.api_source_revision,
          final_history_read_revision: s.runtime_revision,
          schema: '082_catalog_bulk_edit',
          actual_iab_interactions: true,
          products: 2,
          preview_no_business_effect: true,
          explicit_confirmation: true,
          changed: 2,
          execution_state: 'done',
          prices: [15999, 4999],
          old_orders_stock_and_components_unchanged: true,
          history_detail_read: true,
          provider_effects: 0,
          goal_complete: false,
        },
        null,
        2,
      ) + '\n',
    );
  } else throw Error('Unknown UI phase');
  await writeFile(path, JSON.stringify(s, null, 2), { mode: 0o600 });
  console.log({ phase, verified: true });
} finally {
  await pool.end();
}
