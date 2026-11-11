// Local synthetic organization only; never prints credentials or private buyer links.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { paymentBalance } from '../server/payments';
import { tenantTx } from '../server/db';
const d = JSON.parse(await readFile('data/payments-stage023.json', 'utf8')),
  f = d.fixture;
let cookie = '';
async function response(p: string, method = 'GET', body?: any, token?: string) {
  return fetch('http://127.0.0.1:4100/api' + p, {
    method,
    headers: {
      ...(token
        ? { authorization: 'Bearer ' + token }
        : {
            cookie,
            ...(!['/auth/login', '/workspaces/switch'].includes(p)
              ? { 'x-workspace-id': f.tenant_id }
              : {}),
          }),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function api(p: string, method = 'GET', body?: any) {
  const r = await response(p, method, body);
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, method + ' ' + p + ': ' + r.status);
  return r.json();
}
try {
  await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
  await api('/workspaces/switch', 'POST', { tenant_id: f.tenant_id });
  const phase = process.argv[2];
  if (phase === 'aux') {
    assert(!d.aux);
    const results = [];
    for (const x of f.orders.filter((x: any) => x.provider !== 'woocommerce')) {
      let o = await api('/orders/' + x.order_id);
      assert.equal(o.status, 'new');
      assert.equal(o.payment.received, 0);
      await api('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
      for (const i of o.picking_items)
        for (let n = 0; n < i.quantity; n++)
          await api('/orders/' + o.id + '/scan', 'POST', { code: i.sku });
      await api('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
      o = await api('/orders/' + o.id + '/ship-demo', 'POST', {});
      assert.equal(o.payment.received, 0);
      assert.equal(o.shipments[0].cod_expected, o.total);
      await api('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
      const r = await api('/orders/' + o.id + '/returns', 'POST', {
        client_key: randomUUID(),
        reason: 'QA pełny zwrot nieopłaconego COD',
        shipping_refund: o.shipping_cost,
        items: o.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
      });
      const received = await api('/returns/' + r.id + '/receive', 'POST', {
        version: Number(r.version),
        shipping_refund: o.shipping_cost,
        note: 'QA przyjęcie całego nieopłaconego COD',
        items: o.items.map((i: any) => ({
          item_id: i.id,
          accepted: i.quantity,
          restocked: i.quantity,
        })),
      });
      assert.equal(received.settlement_amount, 0);
      await api('/returns/' + r.id + '/refund', 'POST', {
        version: Number(received.version),
        amount: 0,
        reference: 'QA nie pobrano środków; rozliczono należność',
        confirmed: true,
      });
      await api('/returns/' + r.id + '/document', 'POST', {});
      o = await api('/orders/' + o.id);
      assert.equal(o.status, 'return_completed');
      assert.equal(o.payment.net, 0);
      assert.equal(o.payment.amount_due, 0);
      assert.equal(o.payment.credit, o.total);
      results.push({
        provider: x.provider,
        order_id: o.id,
        credit: o.payment.credit,
        received: o.payment.received,
        refunded: o.payment.refunded,
        amount_due: o.payment.amount_due,
        mode: 'local_demo_no_external_calls',
      });
    }
    const k = await api('/developer/keys', 'POST', {
      name: 'QA payments write',
      scopes: ['orders:read', 'orders:write'],
    });
    const read = await api('/developer/keys', 'POST', {
      name: 'QA payments read',
      scopes: ['orders:read'],
    });
    try {
      const o = await api('/orders/' + f.prepaid.order_id),
        body = {
          client_key: randomUUID(),
          version: Number(o.version),
          kind: 'receipt',
          amount: 2000,
          currency: 'PLN',
          reference: 'QA public API zaliczka 20 PLN',
          confirmed: true,
        };
      assert.equal(
        (await response('/v1/orders/' + o.id + '/payments', 'POST', body, read.token)).status,
        403,
      );
      let r = await response('/v1/orders/' + o.id + '/payments', 'POST', body, k.token);
      assert.equal(r.status, 200);
      const a = await r.json();
      assert.equal(a.balance.amount_due, 8000);
      r = await response('/v1/orders/' + o.id + '/payments', 'POST', body, k.token);
      assert.equal(r.status, 200);
      const h = await r.json();
      assert.equal(h.data.length, 1);
      const spec = await api('/v1/openapi');
      await writeFile('docs/openapi.json', JSON.stringify(spec, null, 2) + '\n');
      const portal = await api('/public/orders/' + o.portal_token + '/data');
      assert.equal(portal.payment.received, 2000);
      assert(!JSON.stringify(portal).includes(body.reference));
      d.aux = {
        cod_full_returns: results,
        public_api: {
          partial_amount: 2000,
          amount_due: 8000,
          replay_entries: 1,
          read_only_status: 403,
          portal_private_references_absent: true,
          keys_revoked: true,
        },
      };
    } finally {
      await api('/developer/keys/' + k.id, 'DELETE');
      await api('/developer/keys/' + read.id, 'DELETE');
    }
    await writeFile('data/payments-stage023.json', JSON.stringify(d), { mode: 0o600 });
    console.log(JSON.stringify(d.aux));
  } else if (phase === 'capture') {
    const orders = [];
    for (const x of [...f.orders, f.prepaid]) {
      const o = await api('/orders/' + x.order_id),
        h = await api('/orders/' + o.id + '/payments');
      const stocks = (
        await pool.query(
          'SELECT product_id,on_hand,reserved FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=ANY($3::uuid[])',
          [f.tenant_id, f.warehouse_id, o.picking_items.map((i: any) => i.product_id)],
        )
      ).rows;
      if (x.provider === 'woocommerce') {
        assert.equal(o.status, 'shipped');
        assert.equal(o.payment.received, 10001);
        assert.equal(o.payment.collected, 5001);
        assert.equal(o.payment.remitted, 4900);
        assert.equal(o.payment.fees, 101);
        assert.equal(o.payment.refunded, 3167);
        assert.equal(o.payment.amount_due, 0);
        assert.equal(h.data.length, 4);
        assert.equal(stocks[0].on_hand, 18);
        assert.equal(stocks[0].reserved, 0);
      }
      if (!x.provider) {
        assert.equal(o.status, 'paid');
        assert.equal(o.payment.received, 10000);
        assert.equal(h.data.length, 2);
      }
      const portal = await api('/public/orders/' + o.portal_token + '/data');
      assert(!h.data.some((e: any) => e.reference && JSON.stringify(portal).includes(e.reference)));
      orders.push({
        provider: x.provider ?? 'manual',
        id: o.id,
        number: o.number,
        status: o.status,
        payment: o.payment,
        entries: h.data.map((e: any) => ({
          id: e.id,
          kind: e.kind,
          amount: e.amount,
          fee: e.fee,
          method: e.method,
          reversed: e.reversed,
        })),
        shipments: o.shipments.map((s: any) => ({
          id: s.id,
          mode: s.mode,
          cod_expected: s.cod_expected,
          dispatched: Boolean(s.dispatched_at),
        })),
        documents: o.documents.map((a: any) => ({
          id: a.id,
          mode: a.mode,
          kind: a.kind,
          total: a.data.total,
        })),
        stocks,
      });
    }
    const proof = {
      checked_at: new Date().toISOString(),
      environment: 'local native runtime / synthetic QA only',
      tenant_id: f.tenant_id,
      migration: d.migration,
      aux: d.aux,
      orders,
    };
    await writeFile('docs/payments-qa.json', JSON.stringify(proof, null, 2) + '\n');
    console.log(
      JSON.stringify({
        orders: orders.map((o) => ({
          number: o.number,
          status: o.status,
          payment: o.payment,
          stock: o.stocks,
        })),
        prior_tables_preserved: d.migration.previous_tables_preserved,
      }),
    );
  } else throw Error('Unknown phase');
} finally {
  await pool.end();
}
