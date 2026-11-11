import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../server/db';
import {
  createMixedHarness, freshMixedFixture, requestMixedReturn, localBody, prefix,
  type Harness, type Row,
} from './b2b-return-local-origins-fixture';

let h: Harness;
before(async () => { h = await createMixedHarness(); });
after(async () => { if (h) await h.close(); else await pool.end(); });
function noStore(response: Row) {
  assert.match(String(response.headers['cache-control']), /no-store/);
}

test('an unsubmitted partner preview remains readable but cannot submit or change an immutable subsequently selected local origin', async () => {
  const f = await freshMixedFixture(h), r = await requestMixedReturn(f);
  const returnPath = prefix + '/returns/' + r.id;
  const sources = (await f.ok(returnPath + '/sources?limit=100')).data;
  const source = sources.find((s: Row) => s.customer_item_id === f.customerItem.id
    && s.dropship_order_id === f.forwarded.id);
  assert(source); assert(source.physical_sources.length > 0);
  const previewBody = {
    client_key: randomUUID(), version: Number(r.version), confirmed: true,
    items: [{ customer_item_id: f.customerItem.id, dropship_order_id: f.forwarded.id, quantity: 1,
      physical_sources: source.physical_sources.map((p: Row) => ({
        supplier_item_id: p.supplier_item_id, shipment_id: p.shipment_id,
        quantity: p.quantity_per_unit,
        ...(p.issue_fragment_id ? { issue_fragment_id: p.issue_fragment_id } : {}),
      })) }],
  };
  const created = await f.request(returnPath + '/previews', 'POST', previewBody);
  assert.equal(created.statusCode, 201, created.body); noStore(created);
  const preview = created.json().preview;
  assert.equal(preview.version, 1); assert.equal(preview.can_submit, true);
  assert.match(preview.scope_hash, /^[a-f0-9]{64}$/);

  // Creating a partner preview changes the frozen source scope, so obtain the local
  // selection precondition only afterwards. No partner submission occurs here.
  const body = await localBody(f, r);
  const selected = await f.request(returnPath + '/local-origin', 'POST', body);
  assert.equal(selected.statusCode, 201, selected.body); noStore(selected);
  const origin = selected.json().origin;
  assert.deepEqual(origin.items, body.items);
  assert.equal(selected.json().context.fulfillment_origin, 'local');
  const before = await f.snapshot();

  const detail = await f.request(prefix + '/previews/' + preview.id);
  assert.equal(detail.statusCode, 200, detail.body); noStore(detail);
  assert.equal(detail.json().preview.id, preview.id);
  assert.equal(detail.json().preview.scope_hash, preview.scope_hash);
  assert.equal(detail.json().preview.can_submit, false);
  const replay = await f.request(returnPath + '/previews', 'POST', previewBody);
  assert.equal(replay.statusCode, 200, replay.body); noStore(replay);
  assert.equal(replay.json().reused, true);
  assert.equal(replay.json().preview.id, preview.id);
  assert.equal(replay.json().preview.scope_hash, preview.scope_hash);
  assert.equal(replay.json().preview.can_submit, false);
  assert.deepEqual(await f.snapshot(), before, 'Reading or replaying the old preview is inert');

  const submitBody = { client_key: randomUUID(), version: 1,
    scope_hash: preview.scope_hash, confirmed: true };
  const refused = await f.request(prefix + '/previews/' + preview.id + '/submit', 'POST', submitBody);
  assert.equal(refused.statusCode, 409, refused.body); noStore(refused);
  assert.deepEqual(await f.snapshot(), before,
    'Rejected partner submission cannot create cases/RMAs/actions or alter any local physical or financial state');
  const context = (await f.ok(returnPath + '/context')).context;
  assert.equal(context.fulfillment_origin, 'local');
  assert.equal(context.can_receive_locally, true);
  assert.deepEqual(context.local_origin, origin);
  assert.deepEqual(await f.snapshot(), before, 'Local receipt identity and all business evidence remain immutable');
});
