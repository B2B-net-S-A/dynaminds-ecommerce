import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, tenantTx } from '../server/db';
import { wmsLotsHash } from '../server/wms-lots';
import { b2bDropshipReturnPreviewInput } from '../server/b2b-dropshipping-returns-schema';
import {
  createReturnHarness,
  freshReturnFixture,
  requestRetail,
  sourcePreview,
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

async function approvedPreview(f: ReturnFixture) {
  const retail = await requestRetail(f),
    { preview } = await sourcePreview(f, retail);
  const row = (
    await pool.query(
      'SELECT *,expires_at>clock_timestamp() AS still_valid FROM b2b_dropship_return_previews WHERE tenant_id=$1 AND id=$2',
      [f.buyer.tenant, preview.id],
    )
  ).rows[0] as Row;
  assert(row?.still_valid);
  assert.equal(row.actor_id, f.buyer.user);
  assert.equal(row.api_key_id, null);
  assert.equal(row.snapshot.groups.length, 1);
  assert.equal(row.request.items.length, 1);
  assert.equal(row.snapshot.rows.length, 1);
  return row;
}

async function refuseForgedPreview(
  f: ReturnFixture,
  approved: Row,
  snapshot: Row,
  request: Row,
  message: string,
) {
  const input = b2bDropshipReturnPreviewInput.parse({ ...request, client_key: randomUUID() });
  const requestHash = wmsLotsHash({
    tenant_id: approved.tenant_id,
    actor_id: approved.actor_id,
    api_key_id: approved.api_key_id,
    kind: 'preview',
    parent: approved.return_id,
    body: input,
  });
  const before = await f.snapshot();
  let insertReached = false;
  await assert.rejects(
    tenantTx(
      f.buyer.tenant,
      async (client) => {
        // The approved JSON uses the service's UTC projection; a timezone mismatch
        // must not turn either attack into an unrelated generic snapshot refusal.
        await client.query("SET LOCAL TIME ZONE 'UTC'");
        insertReached = true;
        await client.query(
          'INSERT INTO b2b_dropship_return_previews(id,tenant_id,return_id,order_id,actor_id,api_key_id,client_key,request_hash,request,snapshot,scope_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
          [
            randomUUID(),
            approved.tenant_id,
            approved.return_id,
            approved.order_id,
            approved.actor_id,
            approved.api_key_id,
            input.client_key,
            requestHash,
            input,
            snapshot,
            wmsLotsHash(snapshot),
            approved.created_at,
            approved.expires_at,
          ],
        );
        assert.fail('A raw application INSERT must not certify the forged supplier source');
      },
      { purchasingAdmission: true },
    ),
    (error: any) => error.code === '23514' && error.message === message,
  );
  assert.equal(insertReached, true);
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
  assert.deepEqual(await f.stock(), { on_hand: 17, reserved: 0, available: 17 });
}

function withoutIssueIds(value: any): any {
  if (Array.isArray(value)) return value.map(withoutIssueIds);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'issue_fragment_id')
        .map(([key, child]) => [key, withoutIssueIds(child)]),
    );
  return value;
}

test('raw dyna_app cannot downgrade an actual WMS supplier preview to OFF and remove issue identifiers while preserving valid own commercial proofs and hashes', async () => {
  const f = await freshReturnFixture(h, true),
    approved = await approvedPreview(f);
  const policy = (
    await pool.query('SELECT enabled FROM wms_policies WHERE tenant_id=$1', [f.supplier.tenant])
  ).rows[0];
  assert.equal(policy.enabled, true);
  assert.equal(approved.snapshot.groups[0].wms_lots_enabled, true);
  assert(approved.request.items[0].physical_sources.every((part: Row) => part.issue_fragment_id));
  const snapshot = withoutIssueIds(structuredClone(approved.snapshot)),
    request = withoutIssueIds(structuredClone(approved.request));
  snapshot.groups[0].wms_lots_enabled = false;
  assert(
    request.items[0].physical_sources.every(
      (part: Row) => !Object.hasOwn(part, 'issue_fragment_id'),
    ),
  );
  assert(
    snapshot.rows[0].physical_sources.every(
      (part: Row) => !Object.hasOwn(part, 'issue_fragment_id'),
    ),
  );
  await refuseForgedPreview(
    f,
    approved,
    snapshot,
    request,
    'Podgląd nie odpowiada rzeczywistej polityce WMS dostawcy',
  );
});

test('raw dyna_app cannot approve one grosz of supplier shipping credit against an actual zero-cost shipment through matching forged request and group', async () => {
  const f = await freshReturnFixture(h),
    approved = await approvedPreview(f);
  const supplier = (
    await pool.query('SELECT shipping_cost FROM orders WHERE tenant_id=$1 AND id=$2', [
      f.supplier.tenant,
      f.forwarded.supplier_order_id,
    ])
  ).rows[0];
  assert.equal(supplier.shipping_cost, 0);
  assert.equal(approved.snapshot.groups[0].supplier.shipping_cost, 0);
  assert.equal(approved.snapshot.groups[0].wms_lots_enabled, false);
  const snapshot = structuredClone(approved.snapshot),
    request = structuredClone(approved.request);
  snapshot.groups[0].shipping_refund = 1;
  request.supplier_shipping_refunds = [{ dropship_order_id: f.forwarded.id, amount_minor: 1 }];
  await refuseForgedPreview(
    f,
    approved,
    snapshot,
    request,
    'Przekazanie przekracza bieżący koszt dostawy dostawcy',
  );
});
