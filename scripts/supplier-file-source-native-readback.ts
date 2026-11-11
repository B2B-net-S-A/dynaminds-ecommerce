/** Read-only SQL acceptance of own QA135. No source apply, product, purchase or receipt writes. */
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pool } from '../server/db';
import { decrypt } from '../server/security';
import { wmsLotsHash } from '../server/wms-lots';
const phase = process.argv[2];
assert(['setup', 'csv', 'product', 'purchase', 'pz', 'xml'].includes(phase ?? ''));
assert.notEqual(process.env.DYNA_TEST, 'true');
const revision = process.env.QA_EXPECTED_REVISION;
assert.match(revision ?? '', /^[a-f0-9]{40}$/);
const root = resolve(process.env.QA_STATE_ROOT ?? '<workspace>/app');
const ledger = resolve(root, 'data/supplier-file-source-stage135.json');
assert.equal((await lstat(ledger)).mode & 0o777, 0o600);
const state = JSON.parse(await readFile(ledger, 'utf8'));
assert.equal(state.tenant_id, '675f4d1d-4adf-4b8e-9747-019057faf862');
assert.equal(state.organization, 'QA135 Supplier file 0ceff4f1');
const hash = (v: unknown) =>
  createHash('sha256')
    .update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v))
    .digest('hex');
const outputTag = process.env.QA_OUTPUT_TAG;
if (outputTag) assert.match(outputTag, /^[a-z0-9-]{1,40}$/);
const output = `docs/supplier-file-source-native-${phase}${outputTag ? '-' + outputTag : ''}-readback.json`;
try {
  const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, '118_supplier_file_sources');
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.restore_preview, false);
  const c = await pool.connect();
  let snapshot: any;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    assert.equal((await c.query('SELECT current_database() n')).rows[0].n, 'dynaminds');
    const names = (
      await c.query(
        "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' AND table_name<>'sessions' UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1",
      )
    ).rows.map((r) => r.table_name);
    assert.equal(names.length, 339);
    const tables: any = {};
    const q = async (name: string) => {
      assert.match(name, /^[a-z][a-z0-9_]*$/);
      return (
        await c.query(
          `SELECT to_jsonb(t) row FROM "${name}" t WHERE ${['tenants', 'users'].includes(name) ? 'id' : 'tenant_id'}=$1 ORDER BY 1`,
          [name === 'users' ? state.user_id : state.tenant_id],
        )
      ).rows.map((r) => r.row);
    };
    for (const name of names) {
      const rows = await q(name);
      tables[name] = { count: rows.length, sha256: hash(rows) };
    }
    const selected = [
      'supplier_sources',
      'supplier_file_source_configs',
      'supplier_file_source_revisions',
      'supplier_file_previews',
      'supplier_file_preview_rows',
      'supplier_file_runs',
      'supplier_file_run_rows',
      'supplier_catalog_items',
      'products',
      'stock',
      'stock_locations',
      'stock_movements',
      'stock_location_movements',
      'reservations',
      'purchase_orders',
      'purchase_order_lines',
      'supplier_catalog_purchases',
      'purchase_receipts',
      'purchase_receipt_lines',
      'warehouse_documents',
      'warehouse_document_lines',
    ];
    const rows: any = {};
    for (const n of selected) rows[n] = await q(n);
    for (const p of rows.supplier_file_previews) {
      const original = await readFile(
        state[p.payload.config_snapshot.format === 'csv' ? 'fixture_csv' : 'fixture_xml'].path,
      );
      const content = decrypt(p.raw_content).content;
      assert.equal(typeof content, 'string');
      assert.deepEqual(Buffer.from(content, 'utf8'), original);
      assert.equal(p.raw_hash, hash(original));
      assert.equal(p.raw_bytes, original.length);
      assert.equal(p.scope_hash, wmsLotsHash(p.payload));
      p.cipher_sha256 = hash(p.raw_content);
      delete p.raw_content;
      assert.equal(p.payload.rows.length, 2);
      assert.equal(p.payload.summary.invalid, 0);
      assert.equal(
        rows.supplier_file_preview_rows.filter((r: any) => r.preview_id === p.id).length,
        2,
      );
    }
    snapshot = {
      status: 'PASS',
      phase,
      revision,
      schema_revision: health.schema_revision,
      tenant_id: state.tenant_id,
      tables,
      rows,
      business_writes_performed_by_helper: 0,
      full_goal_complete: false,
    };
    if (phase === 'setup') {
      assert.equal(rows.supplier_sources.length, 0);
      assert.equal(rows.products.length, 0);
      assert.equal(rows.purchase_orders.length, 0);
      assert.equal(rows.stock_movements.length, 0);
    } else {
      assert.equal(rows.supplier_sources.length, 1);
      const s = rows.supplier_sources[0];
      assert.equal(s.kind, 'file');
      assert.equal(s.channel_id, null);
      assert.equal(s.currency, 'EUR');
      assert.equal(s.supplier_id, state.supplier.id);
      assert.equal(rows.supplier_catalog_items.length, 2);
      assert.equal(rows.supplier_file_previews.length, phase === 'xml' ? 2 : 1);
      assert.equal(rows.supplier_file_runs.length, phase === 'xml' ? 2 : 1);
      assert.equal(rows.supplier_file_run_rows.length, phase === 'xml' ? 4 : 2);
      const items = [...rows.supplier_catalog_items].sort((a, b) =>
        a.remote_product_id.localeCompare(b.remote_product_id),
      );
      assert.deepEqual(
        items.map((i) => i.remote_product_id),
        ['remote/A', 'remote/B'],
      );
      assert.equal(items[0].snapshot.unit_cost, phase === 'xml' ? 5000 : 10001);
      assert.equal(items[0].snapshot.quantity, phase === 'xml' ? 6 : 7);
      assert.equal(items[1].snapshot.unit_cost, 0);
      assert.equal(items[1].snapshot.quantity, 0);
      if (phase === 'csv') {
        assert(items.every((i) => i.product_id === null));
        const setup = JSON.parse(
          await readFile('docs/supplier-file-source-native-setup-readback.json', 'utf8'),
        );
        const changes = new Set([
          'supplier_sources',
          'supplier_file_source_configs',
          'supplier_file_source_revisions',
          'supplier_file_previews',
          'supplier_file_preview_rows',
          'supplier_file_runs',
          'supplier_file_run_rows',
          'supplier_catalog_items',
          'audit_events',
        ]);
        for (const n of names) if (!changes.has(n)) assert.deepEqual(tables[n], setup.tables[n], n);
        for (const run of rows.supplier_file_runs) {
          const rr = rows.supplier_file_run_rows
            .filter((x: any) => x.run_id === run.id)
            .sort((a: any, b: any) => a.index - b.index);
          assert.deepEqual(
            rr.map((x: any) => x.index),
            [0, 1],
          );
          const equalities = (
            await c.query(
              `SELECT rr.index,
               ((rr.payload->'after')-'refreshed_at') = (to_jsonb(i)-ARRAY['tenant_id','source_id','refreshed_at']) AS other_fields_exact,
               (rr.payload#>>'{after,refreshed_at}')::timestamptz = i.refreshed_at AS timestamp_exact
               FROM supplier_file_run_rows rr JOIN supplier_catalog_items i
               ON (i.tenant_id,i.id)=(rr.tenant_id,rr.item_id)
               WHERE rr.tenant_id=$1 AND rr.run_id=$2 ORDER BY rr.index`,
              [state.tenant_id, run.id],
            )
          ).rows;
          assert.deepEqual(
            equalities.map((x: any) => x.index),
            [0, 1],
          );
          assert(equalities.every((x: any) => x.other_fields_exact && x.timestamp_exact));
          snapshot.receipt_item_equalities = equalities;
          for (const r of rr) {
            const item = items.find((i) => i.id === r.item_id);
            const { tenant_id, source_id, refreshed_at, ...after } = item;
            const { refreshed_at: recordedTime, ...recorded } = r.payload.after;
            assert.deepEqual(after, recorded);
          }
        }
      } else {
        assert.equal(rows.products.length, 1);
        const product = rows.products[0];
        assert.equal(product.price, 25000);
        assert.equal(product.vat, 23);
        assert.equal(items[0].product_id, product.id);
        assert.equal(items[1].product_id, null);
        assert.equal(rows.stock.length, 1);
        assert.equal(rows.stock[0].on_hand, ['pz', 'xml'].includes(phase!) ? 2 : 0);
        assert.equal(rows.stock[0].reserved, 0);
        assert.equal(rows.stock[0].product_id, product.id);
        if (phase === 'product') {
          assert.equal(rows.purchase_orders.length, 0);
          assert.equal(rows.purchase_receipts.length, 0);
          assert.equal(rows.stock_movements.length, 1);
          assert.equal(rows.stock_movements[0].kind, 'initial');
          assert.equal(rows.stock_movements[0].delta, 0);
          assert.equal(rows.stock_movements[0].product_id, product.id);
        } else {
          assert.equal(rows.purchase_orders.length, 1);
          assert.equal(rows.purchase_order_lines.length, 1);
          assert.equal(rows.supplier_catalog_purchases.length, 1);
          const po = rows.purchase_orders[0],
            line = rows.purchase_order_lines[0],
            bridge = rows.supplier_catalog_purchases[0],
            proof = bridge.snapshot[0];
          assert.equal(bridge.snapshot.length, 1);
          assert.equal(po.currency, 'EUR');
          assert.equal(po.id, line.order_id);
          assert.equal(bridge.purchase_id, po.id);
          assert.equal(line.product_id, product.id);
          assert.equal(line.quantity, 5);
          assert.equal(line.unit_cost, 10001);
          assert.equal(line.closed_quantity, 0);
          assert.equal(proof.item_id, items[0].id);
          assert.equal(proof.quantity, 5);
          assert.equal(proof.unit_cost, 10001);
          assert.equal(proof.currency, 'EUR');
          assert(
            rows.supplier_file_run_rows.some(
              (x: any) => x.run_id === proof.file_run_id && x.item_id === proof.item_id,
            ),
          );
          const pp = rows.supplier_file_previews.find((x: any) => x.id === proof.file_preview_id);
          assert.equal(proof.raw_hash, pp.raw_hash);
          const originRun = rows.supplier_file_runs.find((x: any) => x.id === proof.file_run_id);
          assert.equal(originRun.preview_id, pp.id);
          assert.equal(originRun.source_id, bridge.source_id);
          assert.equal(pp.source_id, bridge.source_id);
          assert.equal(proof.source_version, pp.source_version);
          const productCheckpoint = JSON.parse(
            await readFile('docs/supplier-file-source-native-product-readback.json', 'utf8'),
          );
          assert.equal(
            proof.version,
            productCheckpoint.rows.supplier_catalog_items.find((x: any) => x.id === proof.item_id)
              .version,
          );
          if (phase === 'purchase') {
            assert.equal(po.state, 'ordered');
            assert.equal(line.received_quantity, 0);
            assert.equal(rows.purchase_receipts.length, 0);
            assert.equal(rows.stock_movements.length, 1);
            const before = JSON.parse(
              await readFile('docs/supplier-file-source-native-product-readback.json', 'utf8'),
            );
            for (const n of [
              'stock',
              'stock_locations',
              'stock_movements',
              'stock_location_movements',
              'reservations',
              'supplier_catalog_items',
              'products',
            ])
              assert.deepEqual(rows[n], before.rows[n], n);
          } else {
            assert.equal(po.state, 'partial');
            assert.equal(line.received_quantity, 2);
            assert.equal(rows.purchase_receipts.length, 1);
            assert.equal(rows.purchase_receipt_lines.length, 1);
            assert.equal(rows.warehouse_documents.length, 1);
            assert.equal(rows.warehouse_document_lines.length, 1);
            assert.equal(rows.stock_movements.length, 2);
            const receipt = rows.purchase_receipts[0],
              rl = rows.purchase_receipt_lines[0],
              doc = rows.warehouse_documents[0],
              dl = rows.warehouse_document_lines[0],
              move = rows.stock_movements.find((x: any) => x.warehouse_document_id === doc.id);
            assert.equal(receipt.order_id, po.id);
            assert.equal(receipt.document_id, doc.id);
            assert.equal(rl.receipt_id, receipt.id);
            assert.equal(rl.order_id, po.id);
            assert.equal(rl.quantity, 2);
            assert.equal(rl.product_id, product.id);
            assert.equal(rl.location, 'FEED-01');
            assert.equal(dl.document_id, doc.id);
            assert.equal(dl.product_id, product.id);
            assert.equal(dl.location, 'FEED-01');
            assert.equal(dl.quantity, 2);
            assert.equal(doc.kind, 'receipt');
            assert.equal(doc.status, 'posted');
            assert.equal(move.warehouse_document_id, doc.id);
            assert.equal(move.product_id, product.id);
            assert.equal(move.warehouse_id, state.warehouse_id);
            assert.equal(doc.warehouse_id, state.warehouse_id);
            assert.equal(po.warehouse_id, state.warehouse_id);
            assert.equal(rows.stock[0].warehouse_id, state.warehouse_id);
            assert.equal(move.kind, 'receipt');
            assert.equal(move.delta, 2);
            assert.equal(rows.stock_location_movements.length, 1);
            const binMove = rows.stock_location_movements[0];
            assert.equal(binMove.product_id, product.id);
            assert.equal(binMove.warehouse_id, state.warehouse_id);
            assert.equal(binMove.location, 'FEED-01');
            assert.equal(binMove.delta, 2);
            assert.equal(binMove.kind, 'stock_in');
            assert.equal(
              rows.stock_locations.reduce((n: number, x: any) => n + x.quantity, 0),
              2,
            );
            assert.equal(
              rows.stock_locations.find((x: any) => x.location === 'FEED-01')?.quantity,
              2,
            );
            const before = JSON.parse(
              await readFile('docs/supplier-file-source-native-purchase-readback.json', 'utf8'),
            );
            assert.deepEqual(
              rows.stock_movements.filter((x: any) => x.id !== move.id),
              before.rows.stock_movements,
            );
            if (phase === 'pz') {
              for (const n of [
                'supplier_catalog_items',
                'products',
                'supplier_catalog_purchases',
                'reservations',
              ])
                assert.deepEqual(rows[n], before.rows[n], n);
              snapshot.net_values = {
                ordered: 5 * 10001,
                received: 2 * 10001,
                remaining: 3 * 10001,
                currency: 'EUR',
              };
            }
            if (phase === 'xml') {
              const pz = JSON.parse(
                await readFile('docs/supplier-file-source-native-pz-readback.json', 'utf8'),
              );
              for (const n of [
                'products',
                'stock',
                'stock_locations',
                'stock_movements',
                'stock_location_movements',
                'reservations',
                'purchase_orders',
                'purchase_order_lines',
                'purchase_receipts',
                'purchase_receipt_lines',
                'warehouse_documents',
                'warehouse_document_lines',
                'supplier_catalog_purchases',
              ])
                assert.deepEqual(rows[n], pz.rows[n], n);
              assert.equal(s.version, 2);
              assert.equal(items[0].snapshot.description, 'Opis <b>XML</b> 雪');
              const allowedChanges = new Set([
                'supplier_sources',
                'supplier_file_source_configs',
                'supplier_file_source_revisions',
                'supplier_file_previews',
                'supplier_file_preview_rows',
                'supplier_file_runs',
                'supplier_file_run_rows',
                'supplier_catalog_items',
                'audit_events',
              ]);
              for (const n of names)
                if (!allowedChanges.has(n))
                  assert.deepEqual(tables[n], pz.tables[n], n + ' unchanged by XML');
              const latestReceiptEquality = (
                await c.query(
                  `SELECT rr.index,
                 ((rr.payload->'after')-'refreshed_at')=(to_jsonb(i)-ARRAY['tenant_id','source_id','refreshed_at']) AS other_fields_exact,
                 (rr.payload#>>'{after,refreshed_at}')::timestamptz=i.refreshed_at AS timestamp_exact
                 FROM supplier_file_run_rows rr JOIN supplier_catalog_items i
                 ON (i.tenant_id,i.id,i.file_run_id)=(rr.tenant_id,rr.item_id,rr.run_id)
                 WHERE rr.tenant_id=$1 ORDER BY rr.index`,
                  [state.tenant_id],
                )
              ).rows;
              assert.deepEqual(
                latestReceiptEquality.map((x: any) => x.index),
                [0, 1],
              );
              assert(
                latestReceiptEquality.every((x: any) => x.other_fields_exact && x.timestamp_exact),
              );
              snapshot.receipt_item_equalities = latestReceiptEquality;
              for (const n of [
                'supplier_file_previews',
                'supplier_file_preview_rows',
                'supplier_file_runs',
                'supplier_file_run_rows',
              ]) {
                for (const old of pz.rows[n])
                  assert(
                    rows[n].some((x: any) => JSON.stringify(x) === JSON.stringify(old)),
                    n + ' immutable old data',
                  );
              }
            }
          }
        }
      }
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  await writeFile(output, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
  console.log('NATIVE_READBACK_PASS: ' + phase + '; own tables339; no writes');
} finally {
  await pool.end();
}
