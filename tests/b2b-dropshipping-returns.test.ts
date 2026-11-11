import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, tenantTx } from '../server/db';
import { returnInvoiceSnapshot } from '../server/return-invoices';
import {
  createReturnHarness,
  freshReturnFixture,
  requestRetail,
  sourcePreview,
  submitReturn,
  submitBody,
  supplierCase,
  receiveBody,
  reconcileBody,
  returnBase,
  type Harness,
  type Row,
  type ReturnFixture,
} from './b2b-dropshipping-returns-fixture';

let h: Harness;
before(async () => {
  h = await createReturnHarness();
});
after(async () => {
  if (h) await h.close();
  else await pool.end();
});
async function payments(f: ReturnFixture) {
  return (
    await pool.query(
      'SELECT to_jsonb(t) row FROM payment_entries t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
      [[f.buyer.tenant, f.supplier.tenant]],
    )
  ).rows;
}
async function receive(f: ReturnFixture, id: string, restocked = 1) {
  const c = await supplierCase(f, id),
    body = await receiveBody(f, c, restocked);
  const response = await f.ok(
    returnBase + '/cases/' + id + '/receive',
    'POST',
    body,
    f.supplier.cookie,
  );
  return { c: response.case as Row, body };
}
async function assertPartnerReport(f: ReturnFixture, returnId: string, amount: string) {
  const date = (
    await pool.query(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'Europe/Warsaw','YYYY-MM-DD') date",
    )
  ).rows[0].date;
  const query = '?from=' + date + '&to=' + date;
  const report = await f.ok('/reports/sales/returns' + query);
  const r = report.data.find((row: Row) => row.id === returnId);
  assert(r);
  assert.equal(r.received_at, null);
  assert.equal(r.acceptance_kind, 'partner');
  assert(Number.isFinite(Date.parse(r.accepted_at)));
  assert.equal(r.accepted_quantity, '1');
  assert.equal(r.restocked_quantity, '0');
  assert.equal(r.goods_gross_minor, amount);
  const overview = await f.ok('/orders/' + f.order.id + '/returns');
  const correctionCase = overview.invoice_cases.find((row: Row) => row.id === returnId);
  assert(
    correctionCase?.accepted_at,
    'Partner acceptance must remain selectable for an independent correction',
  );
  assert.equal(correctionCase.received_at, null);
  const portal = await f.ok('/public/orders/' + f.order.portal_token + '/data');
  const customerCase = portal.cases.find((row: Row) => row.id === returnId);
  assert(customerCase);
  assert.equal(customerCase.acceptance_kind, 'partner');
  assert.equal(customerCase.received_at, null);
  assert(Number.isFinite(Date.parse(customerCase.accepted_at)));
  assert.equal(String(customerCase.refund_amount), amount);
  for (const field of [
    'partner_acceptance',
    'case_ids',
    'supplier_return_id',
    'wholesale_refund_minor',
  ])
    assert(
      !Object.hasOwn(customerCase, field),
      'Customer portal must not expose internal partner evidence',
    );
  const summary = await f.ok('/reports/sales/summary' + query);
  assert.equal(summary.returns.length, 1);
  assert.equal(summary.returns[0].goods_gross_minor, amount);
  assert.equal(summary.returns[0].restocked_quantity, '0');
  // Financial report credit is separate from the supplier's physical cost and recorded cash.
  assert.equal(
    summary.costs.reduce((sum: bigint, c: Row) => sum + BigInt(c.restocked_known_minor), 0n),
    0n,
  );
}

for (const on of [false, true])
  test(`genuine historic cheap line direct supplier receipt and partner acceptance preserve independent credits and buyer physical absence, WMS ${on ? 'ON' : 'OFF'}`, async () => {
    const f = await freshReturnFixture(h, on),
      cash = await payments(f);
    const retail = await requestRetail(f);
    const { context: initialContext } = await f.ok(
      returnBase + '/returns/' + retail.id + '/context',
    );
    assert.equal(initialContext.side, 'buyer');
    assert.equal(initialContext.can_preview, true);
    assert.equal(initialContext.can_receive_locally, false);
    assert.equal(initialContext.case_refs.length, 0);
    const { preview } = await sourcePreview(f, retail);
    const previewRows = await f.ok(returnBase + '/previews/' + preview.id + '/rows?limit=1');
    assert.equal(previewRows.meta.total, 1);
    assert.equal(previewRows.data[0].customer_item_id, f.cheap.id);
    assert.equal(previewRows.data[0].retail_refund_minor, '1000');
    assert.equal(previewRows.data[0].wholesale_refund_minor, '700');
    const submitted = await submitReturn(f, preview);
    assert.equal(submitted.cases.length, 1);
    const id = submitted.cases[0].id;
    assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
    assert.deepEqual(await f.stock(), { on_hand: 17, reserved: 0, available: 17 });
    const { c, body } = await receive(f, id);
    assert.equal(c.state, 'received');
    assert.equal(c.wholesale_refund_minor, '700');
    assert.deepEqual(await f.stock(), { on_hand: 18, reserved: 0, available: 18 });
    const supplierReturn = await f.ok(
      '/returns/' + c.supplier_return_id,
      'GET',
      undefined,
      f.supplier.cookie,
    );
    assert.equal(supplierReturn.refund_amount, 700);
    assert(supplierReturn.received_at);
    if (on) {
      const restored = (
        await pool.query(
          'SELECT r.*,i.layer_id original_layer,i.unit_cost_minor original_cost FROM wms_return_fragments r JOIN wms_issue_fragments i ON(i.tenant_id,i.id)=(r.tenant_id,r.issue_fragment_id) WHERE r.tenant_id=$1 AND r.return_id=$2',
          [f.supplier.tenant, c.supplier_return_id],
        )
      ).rows;
      assert.equal(restored.length, 1);
      assert.equal(Number(restored[0].quantity), 1);
      assert.equal(String(restored[0].value_minor), '317');
      assert.equal(restored[0].layer_id, restored[0].original_layer);
      assert.equal(String(restored[0].original_cost), '317');
    } else
      assert.equal(
        (
          await pool.query('SELECT count(*)::int n FROM wms_return_fragments WHERE tenant_id=$1', [
            f.supplier.tenant,
          ])
        ).rows[0].n,
        0,
      );
    const afterReceive = await f.snapshot();
    const receiveReplay = await f.ok(
      returnBase + '/cases/' + id + '/receive',
      'POST',
      body,
      f.supplier.cookie,
    );
    assert.equal(receiveReplay.reused, true);
    assert.deepEqual(await f.snapshot(), afterReceive);
    const approved = await supplierCase(f, id),
      reconcile = await reconcileBody(f, retail, approved);
    const reconciled = await f.ok(
      returnBase + '/returns/' + retail.id + '/reconcile',
      'POST',
      reconcile,
    );
    assert.equal(reconciled.return.refund_amount, 1000);
    assert.equal(reconciled.return.received_at, null);
    assert.equal(reconciled.return.items[0].accepted, 1);
    assert.equal(reconciled.return.items[0].restocked, 0);
    await assertPartnerReport(f, retail.id, '1000');
    // Each seller corrects its own original sale, using its own commercial price.
    const retailInvoice = await f.ok('/orders/' + f.order.id + '/documents', 'POST', {
      kind: 'invoice',
    });
    const wholesaleInvoice = await f.ok(
      '/orders/' + f.forwarded.supplier_order_id + '/documents',
      'POST',
      { kind: 'invoice' },
      f.supplier.cookie,
    );
    const retailCorrection = await f.ok('/returns/' + retail.id + '/document', 'POST', {});
    const wholesaleCorrection = await f.ok(
      '/returns/' + c.supplier_return_id + '/document',
      'POST',
      {},
      f.supplier.cookie,
    );
    assert.equal(retailCorrection.data.total, -1000);
    assert.equal(retailCorrection.data.original.id, retailInvoice.id);
    assert.equal(wholesaleCorrection.data.total, -700);
    assert.equal(wholesaleCorrection.data.original.id, wholesaleInvoice.id);
    assert.notEqual(retailCorrection.id, wholesaleCorrection.id);
    assert.deepEqual(
      await payments(f),
      cash,
      'Acceptances and credits do not fabricate payment entries',
    );
    assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
    const afterReconcile = await f.snapshot();
    const retry = await f.ok(
      returnBase + '/returns/' + retail.id + '/reconcile',
      'POST',
      reconcile,
    );
    assert.equal(retry.reused, true);
    assert.deepEqual(await f.snapshot(), afterReconcile);
    assert.equal((await f.ok(f.dropPath + '/orders/' + f.forwarded.id)).order.state, 'ordered');
    assert.equal(
      (await f.ok('/orders/' + f.order.id)).dropshipping.external_dispatched_quantity,
      3,
    );
    const history = await f.ok(
      returnBase + '/cases?side=buyer&return_id=' + retail.id + '&limit=1',
    );
    assert.deepEqual(
      history.data.map((c: Row) => c.id),
      [id],
    );
    const events = await f.ok(returnBase + '/cases/' + id + '/events?limit=100');
    assert.deepEqual(events.data.map((e: Row) => e.kind).sort(), [
      'receive',
      'reconcile',
      'submit',
    ]);
  });

test('same SKU expensive original UUID credits1700 independently of wholesale700; accepted damage restock0 leaves supplier17 and recorded cash unchanged', async () => {
  const f = await freshReturnFixture(h, true),
    cash = await payments(f);
  const retail = await requestRetail(f, f.expensive),
    { preview } = await sourcePreview(f, retail, f.expensive);
  const rows = (await f.ok(returnBase + '/previews/' + preview.id + '/rows')).data;
  assert.equal(rows[0].customer_item_id, f.expensive.id);
  assert.equal(rows[0].retail_refund_minor, '1700');
  assert.equal(rows[0].wholesale_refund_minor, '700');
  const c = (await submitReturn(f, preview)).cases[0],
    received = (await receive(f, c.id, 0)).c;
  assert.deepEqual(await f.stock(), { on_hand: 17, reserved: 0, available: 17 });
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM wms_return_fragments WHERE tenant_id=$1 AND return_id=$2',
        [f.supplier.tenant, received.supplier_return_id],
      )
    ).rows[0].n,
    0,
  );
  const body = await reconcileBody(f, retail, received);
  const result = await f.ok(returnBase + '/returns/' + retail.id + '/reconcile', 'POST', body);
  assert.equal(result.return.refund_amount, 1700);
  assert.equal(result.return.items[0].restocked, 0);
  await assertPartnerReport(f, retail.id, '1700');
  assert.deepEqual(await payments(f), cash);
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
});

test('genuine indivisible original2001 for two units credits1000 then1001 in preview and partner acceptance, without losing a cent or reopening dispatch capacity', async () => {
  const f = await freshReturnFixture(h, false, 2001),
    cash = await payments(f);
  assert.equal(f.order.total, 4201);
  assert.equal(f.cheap.line_total, 2001);
  const accepted: number[] = [];
  for (const expected of [1000, 1001]) {
    const retail = await requestRetail(f),
      { preview } = await sourcePreview(f, retail);
    const rows = (await f.ok(returnBase + '/previews/' + preview.id + '/rows')).data;
    assert.equal(rows[0].retail_refund_minor, String(expected));
    assert.equal(rows[0].wholesale_refund_minor, '700');
    const c = (await submitReturn(f, preview)).cases[0],
      received = (await receive(f, c.id)).c;
    const body = await reconcileBody(f, retail, received);
    const reconciled = await f.ok(
      returnBase + '/returns/' + retail.id + '/reconcile',
      'POST',
      body,
    );
    assert.equal(reconciled.return.refund_amount, expected);
    assert.equal(reconciled.return.items[0].restocked, 0);
    assert.equal(Number(reconciled.return.receipt_sequence), accepted.length + 1);
    if (accepted.length === 0) {
      const firstSnapshot = await tenantTx(f.buyer.tenant, (client) =>
        returnInvoiceSnapshot(client, retail.id, f.order.id, randomUUID(), 'demo'),
      );
      assert.equal(Number(firstSnapshot.receipt_sequence), 1);
      assert.equal(firstSnapshot.items[0].refund_amount, 1000);
      assert.equal(firstSnapshot.prior.length, 0);
    } else {
      await assert.rejects(
        tenantTx(f.buyer.tenant, (client) =>
          returnInvoiceSnapshot(client, retail.id, f.order.id, randomUUID(), 'demo'),
        ),
        (error: any) =>
          error.status === 409 &&
          error.message === 'Najpierw wystaw korektę wcześniejszej przyjętej sprawy',
        'The second partner credit must respect the existing correction chain',
      );
    }
    accepted.push(reconciled.return.refund_amount);
  }
  assert.equal(
    accepted.reduce((a, b) => a + b, 0),
    2001,
  );
  const retailAmounts = (
    await pool.query(
      "SELECT i.item_id,sum(i.accepted)::int accepted,sum(i.refund_amount)::int refunded FROM return_items i JOIN return_cases r ON(r.tenant_id,r.id)=(i.tenant_id,i.return_id) WHERE i.tenant_id=$1 AND i.order_id=$2 AND r.state IN('refund_pending','closed') GROUP BY i.item_id",
      [f.buyer.tenant, f.order.id],
    )
  ).rows;
  assert.deepEqual(retailAmounts, [{ item_id: f.cheap.id, accepted: 2, refunded: 2001 }]);
  assert.deepEqual(await f.stock(), { on_hand: 19, reserved: 0, available: 19 });
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
  assert.deepEqual(await payments(f), cash);
  assert.equal((await f.ok('/orders/' + f.order.id)).dropshipping.external_dispatched_quantity, 3);
});

test('supplier explicit refusal and withdrawal do not simulate stock receipt, retail acceptance or a cash refund', async () => {
  const f = await freshReturnFixture(h),
    cash = await payments(f),
    retail = await requestRetail(f);
  const first = (await submitReturn(f, (await sourcePreview(f, retail)).preview)).cases[0];
  const c = await supplierCase(f, first.id);
  const body = {
    client_key: randomUUID(),
    version: c.version,
    supplier_return_version: c.supplier_return_version,
    decision: 'reject',
    note: 'Own128 not physically accepted',
    confirmed: true,
  };
  const rejected = (
    await f.ok(returnBase + '/cases/' + c.id + '/decision', 'POST', body, f.supplier.cookie)
  ).case;
  assert.equal(rejected.state, 'rejected');
  assert.equal(
    (await f.ok('/returns/' + retail.id)).state,
    'requested',
    'Supplier rejection does not decide consumer rights',
  );
  const beforeReplay = await f.snapshot();
  assert.equal(
    (await f.ok(returnBase + '/cases/' + c.id + '/decision', 'POST', body, f.supplier.cookie))
      .reused,
    true,
  );
  assert.deepEqual(await f.snapshot(), beforeReplay);
  const second = (await submitReturn(f, (await sourcePreview(f, retail)).preview)).cases[0];
  const withdrawal = {
    client_key: randomUUID(),
    version: second.version,
    reason: 'Own128 withdraw unused request',
    confirmed: true,
  };
  const withdrawn = (
    await f.ok(returnBase + '/cases/' + second.id + '/withdraw', 'POST', withdrawal)
  ).case;
  assert.equal(withdrawn.state, 'withdrawn');
  assert.deepEqual(await f.stock(), { on_hand: 17, reserved: 0, available: 17 });
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
  assert.deepEqual(await payments(f), cash);
  // Withdrawn forwarding remains in history but must not permanently prevent
  // a fresh, physically received forwarding from resolving the customer's RMA.
  const third = (await submitReturn(f, (await sourcePreview(f, retail)).preview)).cases[0];
  const { c: received } = await receive(f, third.id);
  const { context } = await f.ok(returnBase + '/returns/' + retail.id + '/context');
  assert.equal(context.can_reconcile, true);
  assert(!context.case_refs.some((ref: Row) => ref.id === second.id));
  const reconciliation = await reconcileBody(f, retail, received);
  reconciliation.case_versions = context.case_refs.map((ref: Row) => ({
    id: ref.id,
    version: ref.version,
  }));
  const resolved = await f.ok(
    returnBase + '/returns/' + retail.id + '/reconcile',
    'POST',
    reconciliation,
  );
  assert.equal(resolved.return.refund_amount, 1000);
  assert.equal(resolved.return.received_at, null);
  assert.deepEqual(await f.stock(), { on_hand: 18, reserved: 0, available: 18 });
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
  assert.deepEqual(await payments(f), cash);
  const history = await f.ok(returnBase + '/cases?side=buyer&return_id=' + retail.id);
  assert.equal(history.data.length, 3);
  assert(history.data.some((row: Row) => row.id === second.id && row.state === 'withdrawn'));
});

test('concurrent same-key submit and overlapping frozen previews consume exactly one genuine RMA capacity with no duplicate supplier case', async () => {
  const f = await freshReturnFixture(h),
    retail = await requestRetail(f, f.expensive);
  const a = (await sourcePreview(f, retail, f.expensive)).preview,
    b = (await sourcePreview(f, retail, f.expensive)).preview;
  const body = submitBody(a);
  const responses = await Promise.all([
    f.request(returnBase + '/previews/' + a.id + '/submit', 'POST', body),
    f.request(returnBase + '/previews/' + a.id + '/submit', 'POST', body),
  ]);
  assert.deepEqual(
    responses.map((r) => r.statusCode).sort(),
    [200, 201],
    responses.map((r) => r.body).join('\n'),
  );
  const id = responses[0].json().cases[0].id;
  assert(responses.every((r) => r.json().cases.length === 1 && r.json().cases[0].id === id));
  const before = await f.snapshot();
  const conflict = await f.request(
    returnBase + '/previews/' + b.id + '/submit',
    'POST',
    submitBody(b),
  );
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.deepEqual(await f.snapshot(), before);
  const ordinary = await f.request(
    '/orders/' + f.forwarded.supplier_order_id + '/returns',
    'POST',
    {
      client_key: randomUUID(),
      reason: 'Own128 cannot double reserve all physical units',
      items: [
        { item_id: (await supplierCase(f, id)).supplier_items[0].supplier_item_id, quantity: 3 },
      ],
    },
    f.supplier.cookie,
  );
  assert.equal(ordinary.statusCode, 409, ordinary.body);
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
});
