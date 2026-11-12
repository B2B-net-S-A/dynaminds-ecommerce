// Migration 268, carrier APIs on the local fakes (DHL, Poczta Polska, sandbox: numbers from the provider): a cancelled
// DEMO label → provider label → stored PDF → hand-over → shipped. Setup: relabel-after-cancel-fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, packed, shipments, plan, run, assertNewLabel, shipped, carrierInput, confirm, NRB, channels } from './relabel-after-cancel-fixture';

test('carrier APIs (DHL, Poczta Polska on the local fakes, sandbox): DEMO label cancelled → provider label → PDF → hand-over → shipped', async () => {
  for (const carrier of [
    { kind: 'dhl' as const, base: 'dhl-shipping', name: 'DHL Parcel Polska', input: () => ({ ...carrierInput(channels.dhl), cod_bank_account: NRB }) },
    { kind: 'pp' as const, base: 'pocztapolska-shipping', name: 'Poczta Polska', input: () => ({ ...carrierInput(channels.pp), service: 'pocztex_kurier', cod_account: 'PL ' + NRB }) },
  ]) {
    const { o } = await packed();
    await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
    const [first] = await shipments(o.id);
    await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
    const preview = await ok(`/api/orders/${o.id}/${carrier.base}/preview`, 'POST', carrier.input());
    await run(carrier.kind, (await ok(`/api/${carrier.base}/${preview.id}/queue`, 'POST', confirm)).job_id);
    const p = await plan(preview.id);
    assert.equal(p.state, 'ready', carrier.name);
    assert.equal(p.shipment_id, first.id);
    const s = await assertNewLabel(o.id, first.id, carrier.name, first.tracking_number);
    assert.equal(s.mode, 'sandbox');
    assert.equal(s.tracking_number, p.remote_id, 'the provider number');
    assert.equal(Number(s.cod_expected), 10000);
    await ok(`/api/${carrier.base}/${preview.id}/dispatch`, 'POST', {});
    await shipped(o.id);
  }
});
