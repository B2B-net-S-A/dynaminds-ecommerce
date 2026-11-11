import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../server/db';
import {
  createReturnHarness,
  freshReturnFixture,
  requestRetail,
  submitReturn,
  supplierCase,
  returnBase,
  type Harness,
  type Row,
} from './b2b-dropshipping-returns-fixture';

let h: Harness;
const sqlErrors: Array<{ code: string | undefined; message: string }> = [];
before(async () => {
  h = await createReturnHarness();
  h.app.addHook('onError', (_request, _reply, error, done) => {
    // Preserve only constraint evidence; never capture request bodies or credentials.
    sqlErrors.push({ code: error.code, message: error.message });
    done();
  });
});
after(async () => {
  if (h) await h.close();
  else await pool.end();
});

test('genuine two-bin FIFO dispatch reserves issue A1 for the partner RMA: ordinary A2 receipt rolls back, ordinary A1+B1 and then partner A1 restore exactly the original three units and cost951', async () => {
  const f = await freshReturnFixture(h, true, 2000, true);
  const issues = (
    await pool.query(
      'SELECT * FROM wms_issue_fragments WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3 ORDER BY id',
      [f.supplier.tenant, f.forwarded.supplier_order_id, f.source.id],
    )
  ).rows;
  assert.equal(issues.length, 2);
  const a = issues.find((row: Row) => row.quantity === 2),
    b = issues.find((row: Row) => row.quantity === 1);
  assert(
    a && b,
    'The genuine move/opening/scan/dispatch must issue two units from A and one from B',
  );
  assert.notEqual(a.layer_id, b.layer_id);
  assert.notEqual(a.location, b.location);
  assert.equal(a.unit_cost_minor, '317');
  assert.equal(b.unit_cost_minor, '317');
  assert.equal(a.value_minor, '634');
  assert.equal(b.value_minor, '317');
  assert.deepEqual(await f.stock(), { on_hand: 17, reserved: 0, available: 17 });
  const payments = (
    await pool.query(
      'SELECT to_jsonb(p) row FROM payment_entries p WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
      [[f.buyer.tenant, f.supplier.tenant]],
    )
  ).rows;

  const retail = await requestRetail(f),
    sources = await f.ok(returnBase + '/returns/' + retail.id + '/sources?limit=100'),
    source = sources.data.find(
      (row: Row) => row.customer_item_id === f.cheap.id && row.dropship_order_id === f.forwarded.id,
    );
  assert(source);
  const selected = source.physical_sources.find((part: Row) => part.issue_fragment_id === a.id);
  assert(selected);
  assert.equal(selected.quantity_per_unit, 1);
  assert.equal(selected.quantity_available, 2);
  const { preview } = await f.ok(returnBase + '/returns/' + retail.id + '/previews', 'POST', {
    client_key: randomUUID(),
    version: Number(retail.version),
    confirmed: true,
    items: [
      {
        customer_item_id: f.cheap.id,
        dropship_order_id: f.forwarded.id,
        quantity: 1,
        physical_sources: [
          {
            supplier_item_id: selected.supplier_item_id,
            shipment_id: selected.shipment_id,
            issue_fragment_id: a.id,
            quantity: 1,
          },
        ],
      },
    ],
  });
  const c = (await submitReturn(f, preview)).cases[0];
  const ordinary = await f.ok(
    '/orders/' + f.forwarded.supplier_order_id + '/returns',
    'POST',
    {
      client_key: randomUUID(),
      reason: 'Own128 ordinary supplier RMA competes with an explicit pending issue share',
      items: [{ item_id: selected.supplier_item_id, quantity: 2 }],
    },
    f.supplier.cookie,
  );
  assert.equal(ordinary.state, 'requested');
  assert.equal(ordinary.items[0].requested, 2);

  async function lots(picks: Row[]) {
    const stock = (
      await pool.query(
        'SELECT version::text FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
        [f.supplier.tenant, f.supplier.warehouse, f.source.id],
      )
    ).rows[0];
    const policy = (
      await pool.query('SELECT version::text,enabled FROM wms_policies WHERE tenant_id=$1', [
        f.supplier.tenant,
      ])
    ).rows[0];
    assert.equal(policy.enabled, true);
    return {
      client_key: randomUUID(),
      policy_version: policy.version,
      stock_versions: [
        { warehouse_id: f.supplier.warehouse, product_id: f.source.id, version: stock.version },
      ],
      picks,
    };
  }
  const ordinaryBody = {
    version: Number(ordinary.version),
    shipping_refund: 0,
    note: 'Own128 real ordinary receipt must preserve the pending partner issue',
    items: [{ item_id: selected.supplier_item_id, accepted: 2, restocked: 2 }],
  };
  const beforeRefusal = await f.snapshot();
  const priorErrors = sqlErrors.length;
  const refused = await f.request(
    '/returns/' + ordinary.id + '/receive',
    'POST',
    {
      ...ordinaryBody,
      wms_lots: await lots([{ issue_fragment_id: a.id, quantity: 2, location: 'OWN128-RETURN-A' }]),
    },
    f.supplier.cookie,
  );
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(
    refused.json().detail,
    'Zakres zwrotu koliduje z inną sprawą. Odczytaj aktualne ilości i fragmenty wydania.',
  );
  assert.deepEqual(sqlErrors.slice(priorErrors), [
    { code: '23514', message: 'Przekazanie przekracza bieżący wolny fragment wydania WMS' },
  ]);
  assert.match(String(refused.headers['cache-control']), /no-store/);
  assert.deepEqual(await f.snapshot(), beforeRefusal);
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);

  const receivedOrdinary = await f.ok(
    '/returns/' + ordinary.id + '/receive',
    'POST',
    {
      ...ordinaryBody,
      wms_lots: await lots([
        { issue_fragment_id: a.id, quantity: 1, location: 'OWN128-RETURN-A' },
        { issue_fragment_id: b.id, quantity: 1, location: 'OWN128-RETURN-B' },
      ]),
    },
    f.supplier.cookie,
  );
  assert.equal(receivedOrdinary.state, 'refund_pending');
  assert.equal(receivedOrdinary.items[0].accepted, 2);
  assert.equal(receivedOrdinary.items[0].restocked, 2);
  assert.equal(receivedOrdinary.refund_amount, 1400);
  assert.deepEqual(await f.stock(), { on_hand: 19, reserved: 0, available: 19 });
  const pending = await supplierCase(f, c.id);
  assert.equal(pending.state, 'requested');
  const { case: receivedPartner } = await f.ok(
    returnBase + '/cases/' + c.id + '/receive',
    'POST',
    {
      client_key: randomUUID(),
      version: pending.version,
      supplier_return_version: pending.supplier_return_version,
      shipping_refund_minor: 0,
      note: 'Own128 real partner receipt consumes its preserved original issue A share',
      items: [{ supplier_item_id: selected.supplier_item_id, accepted: 1, restocked: 1 }],
      wms_lots: await lots([{ issue_fragment_id: a.id, quantity: 1, location: 'OWN128-RETURN-A' }]),
      confirmed: true,
    },
    f.supplier.cookie,
  );
  assert.equal(receivedPartner.state, 'received');
  assert.equal(receivedPartner.wholesale_refund_minor, '700');
  assert.deepEqual(await f.stock(), { on_hand: 20, reserved: 0, available: 20 });

  const returned = (
    await pool.query(
      'SELECT * FROM wms_return_fragments WHERE tenant_id=$1 AND order_id=$2 ORDER BY return_id,issue_fragment_id',
      [f.supplier.tenant, f.forwarded.supplier_order_id],
    )
  ).rows;
  assert.equal(returned.length, 3);
  assert.equal(
    returned.reduce((sum, row) => sum + row.quantity, 0),
    3,
  );
  assert.equal(
    returned.reduce((sum, row) => sum + BigInt(row.value_minor), 0n),
    951n,
  );
  assert.deepEqual(
    returned.map((row) => row.return_id).sort(),
    [ordinary.id, ordinary.id, receivedPartner.supplier_return_id].sort(),
  );
  for (const row of returned) {
    const issue = issues.find((original: Row) => original.id === row.issue_fragment_id);
    assert(issue);
    assert.equal(row.layer_id, issue.layer_id);
    assert.equal(row.product_id, issue.product_id);
    assert.equal(BigInt(row.value_minor), BigInt(issue.unit_cost_minor) * BigInt(row.quantity));
  }
  assert.equal(
    returned
      .filter((row) => row.issue_fragment_id === a.id)
      .reduce((sum, row) => sum + row.quantity, 0),
    2,
  );
  assert.equal(
    returned
      .filter((row) => row.issue_fragment_id === b.id)
      .reduce((sum, row) => sum + row.quantity, 0),
    1,
  );
  const physical = (
    await pool.query(
      'SELECT sum(quantity)::text quantity,sum(reserved)::text reserved FROM wms_layer_positions WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [f.supplier.tenant, f.supplier.warehouse, f.source.id],
    )
  ).rows[0];
  assert.deepEqual(physical, { quantity: '20', reserved: '0' });
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
  assert.deepEqual(
    (
      await pool.query(
        'SELECT to_jsonb(p) row FROM payment_entries p WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
        [[f.buyer.tenant, f.supplier.tenant]],
      )
    ).rows,
    payments,
  );
  const customer = await f.ok('/returns/' + retail.id);
  assert.equal(customer.state, 'requested');
  assert.equal(customer.received_at, null);
  assert.equal(customer.refund_amount, 0, 'Supplier acceptance alone must not apply retail credit');
});

test('partial partner acceptance of A1 from an A1+B1 request leaves no ghost escrow: a genuine ordinary A1+B1 receipt restores the remaining two units', async () => {
  const f = await freshReturnFixture(h, true, 2000, true);
  const issues = (
    await pool.query(
      'SELECT * FROM wms_issue_fragments WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3 ORDER BY id',
      [f.supplier.tenant, f.forwarded.supplier_order_id, f.source.id],
    )
  ).rows;
  assert.equal(issues.length, 2);
  const a = issues.find((row: Row) => row.quantity === 2),
    b = issues.find((row: Row) => row.quantity === 1);
  assert(a && b, 'The genuine physical split issues A2 and B1');
  assert.notEqual(a.layer_id, b.layer_id);
  assert.notEqual(a.location, b.location);
  assert.equal(a.unit_cost_minor, '317');
  assert.equal(b.unit_cost_minor, '317');
  assert.deepEqual(await f.stock(), { on_hand: 17, reserved: 0, available: 17 });
  const payments = (
    await pool.query(
      'SELECT to_jsonb(p) row FROM payment_entries p WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
      [[f.buyer.tenant, f.supplier.tenant]],
    )
  ).rows;
  const retail = await requestRetail(f, f.cheap, 2),
    sources = await f.ok(returnBase + '/returns/' + retail.id + '/sources?limit=100'),
    source = sources.data.find(
      (row: Row) => row.customer_item_id === f.cheap.id && row.dropship_order_id === f.forwarded.id,
    );
  assert(source);
  const parts = [a, b].map((issue) => {
    const part = source.physical_sources.find((row: Row) => row.issue_fragment_id === issue.id);
    assert(part, 'Both dispatched issue fragments are real available return sources');
    assert.equal(part.quantity_per_unit, 1);
    assert(part.quantity_available >= 1);
    return part;
  });
  assert.equal(parts[0].supplier_item_id, parts[1].supplier_item_id);
  const { preview } = await f.ok(returnBase + '/returns/' + retail.id + '/previews', 'POST', {
    client_key: randomUUID(),
    version: Number(retail.version),
    confirmed: true,
    items: [
      {
        customer_item_id: f.cheap.id,
        dropship_order_id: f.forwarded.id,
        quantity: 2,
        physical_sources: parts.map((part: Row) => ({
          supplier_item_id: part.supplier_item_id,
          shipment_id: part.shipment_id,
          issue_fragment_id: part.issue_fragment_id,
          quantity: 1,
        })),
      },
    ],
  });
  const c = (await submitReturn(f, preview)).cases[0],
    pending = await supplierCase(f, c.id);
  assert.equal(pending.supplier_items.length, 1);
  assert.equal(pending.supplier_items[0].requested, 2);

  async function lots(picks: Row[]) {
    const stock = (
      await pool.query(
        'SELECT version::text FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
        [f.supplier.tenant, f.supplier.warehouse, f.source.id],
      )
    ).rows[0];
    const policy = (
      await pool.query('SELECT version::text,enabled FROM wms_policies WHERE tenant_id=$1', [
        f.supplier.tenant,
      ])
    ).rows[0];
    assert.equal(policy.enabled, true);
    return {
      client_key: randomUUID(),
      policy_version: policy.version,
      stock_versions: [
        { warehouse_id: f.supplier.warehouse, product_id: f.source.id, version: stock.version },
      ],
      picks,
    };
  }
  const { case: receivedPartner } = await f.ok(
    returnBase + '/cases/' + c.id + '/receive',
    'POST',
    {
      client_key: randomUUID(),
      version: pending.version,
      supplier_return_version: pending.supplier_return_version,
      shipping_refund_minor: 0,
      note: 'Own128 accept only one actual A unit from the two-unit partner request',
      items: [{ supplier_item_id: parts[0].supplier_item_id, accepted: 1, restocked: 1 }],
      wms_lots: await lots([
        { issue_fragment_id: a.id, quantity: 1, location: 'OWN128-PARTIAL-A' },
      ]),
      confirmed: true,
    },
    f.supplier.cookie,
  );
  assert.equal(receivedPartner.state, 'received');
  assert.equal(receivedPartner.wholesale_refund_minor, '700');
  assert.deepEqual(await f.stock(), { on_hand: 18, reserved: 0, available: 18 });
  const partialFragments = (
    await pool.query(
      'SELECT issue_fragment_id,quantity,value_minor::text FROM wms_return_fragments WHERE tenant_id=$1 AND return_id=$2 ORDER BY id',
      [f.supplier.tenant, receivedPartner.supplier_return_id],
    )
  ).rows;
  assert.deepEqual(partialFragments, [
    { issue_fragment_id: a.id, quantity: 1, value_minor: '317' },
  ]);

  const ordinary = await f.ok(
    '/orders/' + f.forwarded.supplier_order_id + '/returns',
    'POST',
    {
      client_key: randomUUID(),
      reason: 'Own128 return both genuinely remaining units after partial partner acceptance',
      items: [{ item_id: parts[0].supplier_item_id, quantity: 2 }],
    },
    f.supplier.cookie,
  );
  assert.equal(ordinary.state, 'requested');
  assert.equal(ordinary.items[0].requested, 2);
  const receivedOrdinary = await f.ok(
    '/returns/' + ordinary.id + '/receive',
    'POST',
    {
      version: Number(ordinary.version),
      shipping_refund: 0,
      note: 'Own128 no ghost issue B claim after an accepted and fully restocked A unit',
      items: [{ item_id: parts[0].supplier_item_id, accepted: 2, restocked: 2 }],
      wms_lots: await lots([
        { issue_fragment_id: a.id, quantity: 1, location: 'OWN128-PARTIAL-A' },
        { issue_fragment_id: b.id, quantity: 1, location: 'OWN128-PARTIAL-B' },
      ]),
    },
    f.supplier.cookie,
  );
  assert.equal(receivedOrdinary.state, 'refund_pending');
  assert.equal(receivedOrdinary.items[0].accepted, 2);
  assert.equal(receivedOrdinary.items[0].restocked, 2);
  assert.equal(receivedOrdinary.refund_amount, 1400);
  assert.deepEqual(await f.stock(), { on_hand: 20, reserved: 0, available: 20 });
  const restored = (
    await pool.query(
      'SELECT * FROM wms_return_fragments WHERE tenant_id=$1 AND order_id=$2 ORDER BY return_id,issue_fragment_id',
      [f.supplier.tenant, f.forwarded.supplier_order_id],
    )
  ).rows;
  assert.equal(restored.length, 3);
  assert.equal(
    restored.reduce((sum, row) => sum + row.quantity, 0),
    3,
  );
  assert.equal(
    restored.reduce((sum, row) => sum + BigInt(row.value_minor), 0n),
    951n,
  );
  for (const issue of issues) {
    const rows = restored.filter((row: Row) => row.issue_fragment_id === issue.id);
    assert.equal(
      rows.reduce((sum, row) => sum + row.quantity, 0),
      issue.quantity,
    );
    for (const row of rows) {
      assert.equal(row.layer_id, issue.layer_id);
      assert.equal(row.product_id, issue.product_id);
      assert.equal(BigInt(row.value_minor), BigInt(row.quantity) * BigInt(issue.unit_cost_minor));
    }
  }
  assert.deepEqual(
    restored.map((row) => row.return_id).sort(),
    [receivedPartner.supplier_return_id, ordinary.id, ordinary.id].sort(),
  );
  const positionTotals = (
    await pool.query(
      'SELECT sum(quantity)::text quantity,sum(reserved)::text reserved FROM wms_layer_positions WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [f.supplier.tenant, f.supplier.warehouse, f.source.id],
    )
  ).rows[0];
  assert.deepEqual(positionTotals, { quantity: '20', reserved: '0' });
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
  assert.deepEqual(
    (
      await pool.query(
        'SELECT to_jsonb(p) row FROM payment_entries p WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
        [[f.buyer.tenant, f.supplier.tenant]],
      )
    ).rows,
    payments,
  );
  const customer = await f.ok('/returns/' + retail.id);
  assert.equal(customer.state, 'requested');
  assert.equal(customer.received_at, null);
  assert.equal(
    customer.refund_amount,
    0,
    'Supplier partial acceptance never creates retail cash or credit',
  );
});
