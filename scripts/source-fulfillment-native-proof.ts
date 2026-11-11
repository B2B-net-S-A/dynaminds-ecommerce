/** Dedicated local-only QA124. Original accepted files are read, never rewritten. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { demoShopifyOrder } from '../server/shopify-example';
import { verifyOrderMergesPreservation } from './order-merges-preservation';

type Row = Record<string, any>;
const file = 'data/source-fulfillment-stage124.json';
const phase = process.argv[2];
assert(
  [
    'baseline',
    'verify-baseline',
    'setup',
    'dispatch',
    'first',
    'return',
    'verify',
    'restart',
  ].includes(phase),
);
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesSha = (v: Buffer) => createHash('sha256').update(v).digest('hex');
const save = (s: Row, fresh = false) =>
  writeFile(file, JSON.stringify(s, null, 2), { mode: 0o600, ...(fresh ? { flag: 'wx' } : {}) });
async function regular(path: string) {
  const st = await lstat(path);
  assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o077) === 0);
  return readFile(path);
}
async function ownCheckpoint(
  tenant: string,
  user: string,
  names?: string[],
  bareTenantRows = false,
) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const tables: string[] =
      names ??
      (
        await c.query(`SELECT t.table_name FROM information_schema.tables t
      JOIN information_schema.columns k USING(table_schema,table_name)
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id'
      AND t.table_name<>'sessions' ORDER BY t.table_name`)
      ).rows.map((r) => r.table_name);
    const out: Row = {};
    for (const name of tables) {
      assert(/^[a-z_][a-z0-9_]*$/.test(name));
      const identity = ['tenants', 'users'].includes(name) ? 'id' : 'tenant_id';
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${identity}=$1 ORDER BY 1`, [
          name === 'users' ? user : tenant,
        ])
      ).rows;
      out[name] = {
        count: rows.length,
        sha256: sha(
          bareTenantRows && !['tenants', 'users'].includes(name) ? rows.map((r) => r.row) : rows,
        ),
      };
    }
    for (const name of names ? [] : ['tenants', 'users']) {
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM ${name} t WHERE id=$1 ORDER BY 1`, [
          name === 'users' ? user : tenant,
        ])
      ).rows;
      out[name] = { count: rows.length, sha256: sha(rows) };
    }
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
async function api(s: Row, path: string, method = 'GET', body?: Row, expected = 200) {
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      ...(s.cookie ? { cookie: s.cookie, 'X-Workspace-ID': s.tenant } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method === 'POST' && path === '/orders' ? { 'Idempotency-Key': s.pending.key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: HTTP${response.status}; do not repeat uncertain mutations`,
  );
  const data = await response.json();
  if (path === '/auth/signup') {
    assert(response.headers.get('set-cookie'));
    s.cookie = response.headers.get('set-cookie')!.split(';')[0];
    s.tenant = data.user.tenant_id;
    s.user = data.user.id;
  }
  return data;
}
async function mutate(
  s: Row,
  name: string,
  path: string,
  method: string,
  body: Row,
  expected = 200,
) {
  assert.equal(phase, 'setup');
  assert(!s.pending && !Object.hasOwn(s, name), 'Each setup mutation is executed at most once');
  s.pending = { name, path, method, body, expected, key: randomUUID() };
  await save(s);
  const result = await api(s, path, method, body, expected);
  s[name] = result;
  s.pending = null;
  await save(s);
  return result;
}
async function earlierExact(s: Row) {
  for (const old of s.previous) {
    assert.equal(bytesSha(await regular(old.file)), old.private_sha256);
    assert.deepEqual(
      await ownCheckpoint(old.tenant, old.user, Object.keys(old.checkpoint)),
      old.checkpoint,
      'Original earlier firm unchanged: ' + old.file,
    );
    if (old.file === 'data/order-merges-stage122.json') {
      const accepted = JSON.parse((await regular(old.file)).toString());
      assert.deepEqual(
        await ownCheckpoint(
          old.tenant,
          old.user,
          Object.keys(accepted.fulfilment_checkpoint),
          true,
        ),
        accepted.fulfilment_checkpoint,
        'QA122 original accepted checkpoint remains exact; no rebasing',
      );
    }
    const now = await ownCheckpoint(old.tenant, old.user);
    for (const [name, value] of Object.entries(now)) {
      if (!Object.hasOwn(old.checkpoint, name))
        assert.equal(
          (value as Row).count,
          0,
          'No new source evidence for an earlier firm: ' + name,
        );
    }
  }
}
async function business(s: Row, stage: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const rows = async (table: string) => {
      assert(/^[a-z_][a-z0-9_]*$/.test(table));
      return (
        await c.query(`SELECT t.* FROM "${table}" t WHERE tenant_id=$1 ORDER BY to_jsonb(t)`, [
          s.tenant,
        ])
      ).rows;
    };
    const claims = await rows('order_merge_claims');
    assert.equal(claims.length, 2);
    assert(
      claims.every((v) => [s.shopify_order.id, s.manual_order.id].includes(v.source_order_id)),
    );
    assert.equal(new Set(claims.map((v) => v.target_order_id)).size, 1);
    const ownerId = claims[0].target_order_id;
    const owner = (await rows('orders')).find((v) => v.id === ownerId);
    assert(owner && owner.number.startsWith('MERGE-') && owner.status === 'shipped');
    assert.equal(owner.total, 5800);
    const ownerDetail = await api(s, '/orders/' + ownerId);
    assert.equal(ownerDetail.payment.received, 5800);
    assert.equal(ownerDetail.payment.refunded, 0);
    const items = (await rows('order_items')).filter((v) => v.order_id === ownerId);
    assert.deepEqual(
      items
        .map((v) => [v.price, v.quantity, v.line_total])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
      [
        [1000, 2, 2000],
        [1700, 1, 1700],
        [1700, 1, 1700],
      ],
    );
    const ships = await rows('shipments');
    assert.equal(ships.length, 1);
    assert.equal(ships[0].order_id, ownerId);
    assert(ships[0].dispatched_at && ships[0].mode === 'demo');
    const bindings = await rows('order_source_lines');
    assert.equal(bindings.length, 2);
    assert(
      bindings.every(
        (v) => v.source_order_id === s.shopify_order.id && v.product_id === s.product.id,
      ),
    );
    assert.deepEqual(bindings.map((v) => [v.remote_line_id, v.quantity, v.line_total]).sort(), [
      ['gid://shopify/LineItem/1240011', 2, 2000],
      ['gid://shopify/LineItem/1240012', 1, 1700],
    ]);
    const evidence = (
      await c.query(
        'SELECT * FROM shopify_dispatch_evidence WHERE tenant_id=$1 AND shipment_id=$2',
        [s.tenant, ships[0].id],
      )
    ).rows;
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].order_id, ownerId);
    assert.equal(evidence[0].receiver.email, s.email);
    assert.equal(
      evidence[0].items.reduce((n: number, v: Row) => n + v.quantity, 0),
      4,
    );
    const stock = (
      await c.query(
        'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3',
        [s.tenant, s.product.id, s.warehouse],
      )
    ).rows;
    assert.equal(stock.length, 1);
    const movements = await rows('stock_movements');
    assert.equal(
      movements.filter((v) => v.kind === 'shipment').reduce((n, v) => n - v.delta, 0),
      4,
    );
    const returns = await rows('return_items');
    const plans = await rows('shopify_fulfillment_plans');
    const requestRows = (
      await c.query('SELECT * FROM shopify_source_fulfillment_requests WHERE tenant_id=$1', [
        s.tenant,
      ])
    ).rows;
    const consumed = (
      await c.query(
        'SELECT remote_line_id,quantity,maximum_quantity FROM shopify_source_fulfillment_capacity_ledger WHERE tenant_id=$1 ORDER BY remote_line_id,plan_id',
        [s.tenant],
      )
    ).rows;
    const confirmations = (
      await c.query(
        'SELECT * FROM shopify_source_fulfillment_confirmations WHERE tenant_id=$1 ORDER BY plan_id',
        [s.tenant],
      )
    ).rows;
    const expectedParts = stage === 'dispatch' ? 0 : stage === 'verify' ? 2 : 1;
    assert.equal(plans.length, expectedParts);
    assert.equal(requestRows.length, expectedParts);
    assert.equal(confirmations.length, expectedParts);
    assert.equal(new Set(confirmations.map((v) => v.remote_id)).size, expectedParts);
    for (const p of plans) {
      assert.equal(p.state, 'done');
      assert.equal(p.phase, 'done');
      assert.equal(p.payload.partial.source_order_id, s.shopify_order.id);
      assert.equal(p.payload.partial.owner_order_id, ownerId);
      assert.equal(p.shipment_id, ships[0].id);
      assert(
        p.remote_id && confirmations.some((v) => v.plan_id === p.id && v.remote_id === p.remote_id),
      );
      assert(
        requestRows.some(
          (v) => v.plan_id === p.id && v.client_key === p.payload.partial.client_key,
        ),
      );
    }
    const returned = stage === 'return' || stage === 'verify';
    assert.deepEqual(stock[0], { on_hand: returned ? 27 : 26, reserved: 0 });
    assert.equal(returns.length, returned ? 1 : 0);
    assert.equal(
      movements.filter((v) => v.kind === 'return').reduce((n, v) => n + v.delta, 0),
      returned ? 1 : 0,
    );
    if (returned) {
      assert.equal(returns[0].order_id, ownerId);
      assert.equal(returns[0].accepted, 1);
      assert.equal(returns[0].restocked, 1);
      assert.equal(returns[0].refund_amount, 1000);
      assert.equal(items.find((v) => v.id === returns[0].item_id)?.price, 1000);
    }
    if (expectedParts) {
      const total = (id: string) =>
        consumed.filter((v) => v.remote_line_id === id).reduce((n, v) => n + v.quantity, 0);
      assert.equal(total('gid://shopify/LineItem/1240011'), stage === 'verify' ? 2 : 1);
      assert.equal(total('gid://shopify/LineItem/1240012'), stage === 'verify' ? 1 : 0);
      assert(
        consumed.every(
          (v) => v.maximum_quantity === (v.remote_line_id.endsWith('1240011') ? 2 : 1),
        ),
      );
    }
    await c.query('COMMIT');
    const cp = await ownCheckpoint(s.tenant, s.user);
    assert.deepEqual(
      cp.payment_entries,
      s.setup_checkpoint.payment_entries,
      'External confirmation and return do not mutate the original payment ledger',
    );
    if (s.dispatch_checkpoint)
      for (const name of [
        'order_source_lines',
        'shopify_dispatch_evidence',
        'order_merge_origins',
        'order_merge_claims',
        'order_merge_execution_rows',
      ])
        assert.deepEqual(
          cp[name],
          s.dispatch_checkpoint[name],
          'Frozen provenance remains unchanged: ' + name,
        );
    if (stage === 'first')
      for (const name of [
        'stock',
        'stock_movements',
        'stock_locations',
        'stock_location_movements',
        'payment_entries',
        'orders',
        'order_items',
        'shipments',
        'return_items',
      ])
        assert.deepEqual(
          cp[name],
          s.dispatch_checkpoint[name],
          'First ACK has no physical or financial side effects: ' + name,
        );
    if (stage === 'verify')
      for (const name of [
        'stock',
        'stock_movements',
        'stock_locations',
        'stock_location_movements',
        'payment_entries',
        'orders',
        'order_items',
        'shipments',
        'return_items',
        'return_cases',
      ])
        assert.deepEqual(
          cp[name],
          s.return_checkpoint[name],
          'Remaining ACK has no physical or financial side effects: ' + name,
        );
    return {
      checkpoint: cp,
      owner_order_id: ownerId,
      shipment_id: ships[0].id,
      confirmed_parts: expectedParts,
      source_lines: bindings.length,
      on_hand: stock[0].on_hand,
      reserved: 0,
    };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
try {
  if (phase === 'baseline') {
    const prior = await verifyOrderMergesPreservation('check');
    const previous = prior.checkpoints.map((p) => ({
      file: p.file,
      tenant: p.tenant_id,
      user: p.user_id,
      private_sha256: p.private_state_sha256,
      checkpoint: p.captured,
    }));
    // Compare the original acceptance using its own serialization, independently
    // of this helper's wrapper-based preservation checkpoint.
    const path = 'data/order-merges-stage122.json',
      bytes = await regular(path),
      old = JSON.parse(bytes.toString());
    assert(old.fulfilment_verified && old.fulfilment_checkpoint);
    assert.deepEqual(
      await ownCheckpoint(old.tenant, old.user, Object.keys(old.fulfilment_checkpoint), true),
      old.fulfilment_checkpoint,
    );
    const cp = await ownCheckpoint(old.tenant, old.user);
    assert.equal(Object.keys(cp).length, 275);
    const original = JSON.parse(await readFile('docs/order-merge-dashboard-after-qa.json', 'utf8'));
    assert.equal(original.private_fixture_sha256, bytesSha(bytes));
    assert.equal(original.original_business_checkpoint_sha256, sha(old.fulfilment_checkpoint));
    previous.push({
      file: path,
      tenant: old.tenant,
      user: old.user,
      private_sha256: bytesSha(bytes),
      checkpoint: cp,
    });
    const nonce = randomBytes(4).toString('hex');
    const state = {
      stage: 124,
      created_at: new Date().toISOString(),
      baseline_schema: prior.schema_revision,
      previous,
      nonce,
      email: `qa124-${nonce}@example.test`,
      password: 'DynaQA124!' + randomBytes(12).toString('hex'),
      organization: 'QA124 Shopify częściowe ' + nonce,
      pending: null,
    };
    await save(state, true);
    console.log(
      JSON.stringify({
        status: 'BASELINE_PASS',
        previous_firms: previous.length,
        baseline_tables: 275,
      }),
    );
  } else {
    const s: Row = JSON.parse((await regular(file)).toString());
    assert(!s.pending, 'Uncertain pending mutation must be resolved by readback, never repeated');
    await earlierExact(s);
    const health = await api(s, '/health');
    assert.equal(health.restore_preview, false);
    if (phase === 'verify-baseline') {
      console.log(
        JSON.stringify({
          status: 'BASELINE_REVALIDATED_PASS',
          previous_firms: s.previous.length,
          original_qa122_checkpoint_exact: true,
          revision: health.revision,
          schema: health.schema_revision,
          private_state_rewritten: false,
        }),
      );
      process.exitCode = 0;
    } else {
      assert(health.schema_revision.startsWith('107_'), 'Both additive schemas must be loaded');
      const expectedRevision = process.env.QA_EXPECTED_REVISION ?? s.runtime_revision;
      assert(
        typeof expectedRevision === 'string' && /^[a-f0-9]{7,40}$/.test(expectedRevision),
        'An exact source revision is required before native mutations or acceptance',
      );
      assert.equal(
        health.revision,
        expectedRevision,
        'Runtime must match the reviewed source revision',
      );
      if (phase === 'setup') {
        assert(!s.setup_complete && !s.signup, 'Setup is deliberately single-use');
        s.runtime_revision = expectedRevision;
        await save(s);
        await mutate(
          s,
          'signup',
          '/auth/signup',
          'POST',
          {
            email: s.email,
            password: s.password,
            name: 'QA124 Realizacja źródeł',
            organization: { name: s.organization },
          },
          201,
        );
        s.warehouse = (await api(s, '/warehouses')).data[0].id;
        await save(s);
        const p = await mutate(
          s,
          'product',
          '/products',
          'POST',
          {
            sku: 'QA124-' + s.nonce,
            name: 'QA124 Jeden wariant, dwie ceny Shopify',
            price: 1700,
            vat: 23,
            quantity: 30,
            warehouse_id: s.warehouse,
          },
          201,
        );
        const example = await mutate(s, 'example', '/integrations/shopify-example', 'POST', {});
        s.channel = example.channel_id;
        await save(s);
        await mutate(s, 'mapping', '/integrations/' + s.channel + '/mappings', 'POST', {
          external_id: 'gid://shopify/ProductVariant/701',
          sku: p.sku,
        });
        const raw: Row = structuredClone(demoShopifyOrder),
          money = (amount: string) => ({ presentmentMoney: { amount, currencyCode: 'PLN' } });
        raw.id = 'gid://shopify/Order/1240001';
        raw.name = '#QA124';
        raw.updatedAt = new Date().toISOString();
        raw.email = s.email;
        raw.shippingAddress.firstName = 'QA124';
        raw.shippingAddress.lastName = 'Shopify';
        const first = structuredClone(raw.lineItems.nodes[0]),
          second = structuredClone(first);
        Object.assign(first, {
          id: 'gid://shopify/LineItem/1240011',
          sku: p.sku,
          quantity: 2,
          currentQuantity: 2,
          unfulfilledQuantity: 2,
          originalTotalSet: money('20.00'),
          discountAllocations: [],
          taxLines: [{ priceSet: money('3.74') }],
        });
        Object.assign(second, {
          id: 'gid://shopify/LineItem/1240012',
          sku: p.sku,
          quantity: 1,
          currentQuantity: 1,
          unfulfilledQuantity: 1,
          originalTotalSet: money('17.00'),
          discountAllocations: [],
          taxLines: [{ priceSet: money('3.18') }],
        });
        raw.lineItems.nodes = [first, second];
        Object.assign(raw.shippingLines.nodes[0], {
          originalPriceSet: money('3.00'),
          discountedPriceSet: money('3.00'),
          taxLines: [{ priceSet: money('0.56') }],
        });
        raw.totalPriceSet = raw.currentTotalPriceSet = raw.totalReceivedSet = money('40.00');
        raw.totalTaxSet = money('7.48');
        const staged = await mutate(
          s,
          'staged',
          '/integrations/' + s.channel + '/stage-orders',
          'POST',
          { data: [raw] },
        );
        assert.equal(staged.data.length, 1);
        assert.equal(staged.data[0].state, 'staged');
        const source = await mutate(
          s,
          'shopify_order',
          '/imports/' + staged.data[0].id + '/commit',
          'POST',
          { warehouse_id: s.warehouse, expected_hash: staged.data[0].source_hash },
        );
        assert.equal(source.items.length, 2);
        assert.equal(source.total, 4000);
        assert.deepEqual(
          source.items
            .map((r: Row) => [r.price, r.quantity])
            .sort((a: number[], b: number[]) => a[0] - b[0]),
          [
            [1000, 2],
            [1700, 1],
          ],
        );
        const other = await mutate(
          s,
          'manual_order',
          '/orders',
          'POST',
          {
            customer_name: source.customer_name,
            email: source.email,
            address: source.address,
            warehouse_id: s.warehouse,
            shipping_cost: 100,
            items: [{ product_id: p.id, quantity: 1 }],
          },
          201,
        );
        assert.equal(other.total, 1800);
        await mutate(s, 'manual_receipt', '/orders/' + other.id + '/payments', 'POST', {
          client_key: randomUUID(),
          version: Number(other.version),
          kind: 'receipt',
          amount: 1800,
          currency: 'PLN',
          reference: 'QA124 Lokalna wpłata',
          confirmed: true,
        });
        s.setup_complete = true;
        s.setup_checkpoint = await ownCheckpoint(s.tenant, s.user);
        await save(s);
        await earlierExact(s);
        console.log(
          JSON.stringify({
            status: 'SETUP_PASS',
            source_order_id: source.id,
            other_order_id: other.id,
            product_sku: p.sku,
            source_total_minor: 4000,
            planned_combined_minor: 5800,
            physical_reserved: 4,
          }),
        );
      } else {
        assert(s.setup_complete && s.tenant);
        const me = (await api(s, '/auth/me')).user;
        assert.equal(me.id, s.user);
        assert.equal(me.tenant_id, s.tenant);
        if (phase === 'restart') {
          assert(s.verify_checkpoint);
          assert.deepEqual(
            await ownCheckpoint(s.tenant, s.user),
            s.verify_checkpoint,
            'Accepted business state remains exact after restart',
          );
          await earlierExact(s);
          assert.deepEqual(
            await ownCheckpoint(s.tenant, s.user),
            s.verify_checkpoint,
            'Fresh snapshot remains exact',
          );
          console.log(
            JSON.stringify({
              status: 'RESTART_EXACT_PASS',
              revision: health.revision,
              original_acceptance_revision: s.runtime_revision,
              schema: health.schema_revision,
              previous_firms: s.previous.length,
              accepted_tables: Object.keys(s.verify_checkpoint).length,
              checkpoint_sha256: sha(s.verify_checkpoint),
              private_fixture_rewritten: false,
            }),
          );
        } else {
          if (phase === 'first') assert(s.dispatch_checkpoint && !s.first_checkpoint);
          if (phase === 'return') assert(s.first_checkpoint && !s.return_checkpoint);
          if (phase === 'verify') assert(s.return_checkpoint && !s.verify_checkpoint);
          if (phase === 'dispatch') assert(!s.dispatch_checkpoint);
          const result = await business(s, phase);
          await earlierExact(s);
          assert.deepEqual(
            await ownCheckpoint(s.tenant, s.user),
            result.checkpoint,
            'Fresh snapshot has no GET/readback effects',
          );
          s[phase + '_checkpoint'] = result.checkpoint;
          s[phase + '_evidence'] = {
            ...result,
            checkpoint: undefined,
            revision: health.revision,
            schema: health.schema_revision,
          };
          await save(s);
          await earlierExact(s);
          console.log(
            JSON.stringify({
              status: phase.toUpperCase() + '_READBACK_PASS',
              previous_firms: s.previous.length,
              revision: health.revision,
              schema: health.schema_revision,
              ...s[phase + '_evidence'],
              checkpoint_sha256: sha(result.checkpoint),
            }),
          );
        }
      }
    }
  }
} finally {
  await pool.end();
}
