import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/dpd-stage045.json',
  email = 'qa-dpd@demo.local',
  password = 'DynaDemo!2026';
const tables = Object.keys(
  JSON.parse(await readFile('data/allegro-publishing-stage044.json', 'utf8')).before,
);
let state: any,
  cookie = '';
async function fingerprints(tenants: string[]) {
  const out: any = {};
  for (const t of tables) {
    assert(/^[a-z_]+$/.test(t));
    const rows = (
      await pool.query(
        'SELECT to_jsonb(t)::text row FROM ' + t + ' t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
        [tenants],
      )
    ).rows;
    out[t] = {
      count: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return out;
}
async function api(path: string, method = 'GET', body?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d = await r.json();
  assert.equal(r.status, status, path + ': ' + JSON.stringify(d));
  return d;
}
const save = () => writeFile(file, JSON.stringify(state), { mode: 0o600 });
try {
  const phase = process.argv[2];
  if (phase === 'baseline') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    state = { tenants, before: await fingerprints(tenants) };
    await save();
    console.log(JSON.stringify({ tenants: tenants.length, tables: tables.length }));
  } else {
    state = JSON.parse(await readFile(file, 'utf8'));
    if (phase === 'setup') {
      assert(!state.fixture?.channel, 'Do not repeat completed setup');
      if (!state.fixture) {
        await api(
          '/auth/signup',
          'POST',
          { email, password, name: 'QA DPD', organization: { name: 'QA DPD 20261004' } },
          201,
        );
        state.fixture = { tenant: (await api('/auth/me')).user.tenant_id };
        await save();
      } else await api('/auth/login', 'POST', { email, password });
      const f: any = state.fixture;
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      f.warehouse = (await api('/warehouses')).data[0].id;
      const spec = (await (
        await fetch('https://dpdservices.dpd.com.pl/api-docs/01.%20All%20methods')
      ).json()) as any;
      // Public test credentials from the provider's official documentation. Never production credentials.
      const d = spec.info.description;
      const credentials = {
        username: d.match(/\*\*Login:\*\* (\S+)/)[1],
        password: d.match(/\*\*Password:\*\* (\S+)/)[1],
      };
      f.channel = (
        await api('/integrations', 'POST', {
          provider: 'dpd',
          name: 'DPD oficjalne DEMO API',
          mode: 'sandbox',
          credentials,
          settings: { master_fid: d.match(/\*\*Master FID:\*\* (\d+)/)[1] },
        })
      ).id;
      f.read_probe = await api('/integrations/' + f.channel + '/test', 'POST', {});
      f.local = (await api('/dpd-shipping/example', 'POST', {})).channel_id;
      f.orders = [];
      for (let n = 1; n <= 2; n++) {
        const p = await api(
          '/products',
          'POST',
          {
            sku: 'DPD-QA-' + n,
            name: 'Paczka DPD QA ' + n,
            price: 5000,
            vat: 23,
            quantity: 12,
            warehouse_id: f.warehouse,
          },
          201,
        );
        const o = await api(
          '/orders',
          'POST',
          {
            customer_name: 'Odbiorca syntetyczny DPD',
            payment_mode: 'prepaid',
            email: 'qa@example.test',
            warehouse_id: f.warehouse,
            address: {
              street: 'Testowa 1',
              city: 'Warszawa',
              postal_code: '01-354',
              phone: '500600700',
              country: 'PL',
            },
            items: [{ product_id: p.id, quantity: 2 }],
          },
          201,
        );
        await api('/orders/' + o.id + '/payments', 'POST', {
          client_key: randomUUID(),
          version: Number(o.version),
          kind: 'receipt',
          amount: 10000,
          currency: 'PLN',
          reference: 'Wpłata syntetyczna DPD QA',
          confirmed: true,
        });
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
        for (let x = 0; x < 2; x++) await api('/orders/' + o.id + '/scan', 'POST', { code: p.sku });
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
        f.orders.push({
          id: o.id,
          number: o.number,
          product: p.id,
          mode: n === 1 ? 'external_sandbox' : 'local_simulation',
        });
        await save();
      }
      await save();
      console.log(JSON.stringify(f));
    } else {
      await api('/auth/login', 'POST', { email, password });
      const f = state.fixture;
      if (phase === 'before-dispatch') {
        const results = [];
        for (const o of f.orders) {
          const d = await api('/orders/' + o.id),
            p = (await api('/orders/' + o.id + '/shipping')).data.find(
              (p: any) => p.state === 'ready',
            );
          assert(p);
          assert.equal(d.status, 'packed');
          assert.equal(d.shipments.length, 1);
          assert.equal(p.result.label_base64, undefined);
          const stock = (
            await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [o.product])
          ).rows[0];
          assert.deepEqual(stock, { on_hand: 12, reserved: 2 });
          o.plan = p.id;
          o.shipment = p.shipment_id;
          const r = await fetch('http://127.0.0.1:4100/api/shipments/' + o.shipment + '/label', {
            headers: { cookie },
          });
          assert.equal(r.status, 200);
          assert.equal(r.headers.get('cache-control'), 'no-store');
          const b = Buffer.from(await r.arrayBuffer());
          if (o.mode === 'external_sandbox') {
            assert.equal(r.headers.get('content-type'), 'application/pdf');
            assert.equal(b.subarray(0, 5).toString(), '%PDF-');
            await writeFile('data/dpd-provider-demo.pdf', b);
            o.pdf_sha256 = createHash('sha256').update(b).digest('hex');
            o.pdf_bytes = b.length;
            assert.equal(p.result.scope, 'external_sandbox_verified');
          } else {
            assert.match(b.toString(), /ETYKIETA TESTOWA/);
            assert.equal(p.result.scope, 'local_simulation');
          }
          results.push({
            number: o.number,
            scope: p.result.scope,
            tracking: p.result.tracking_number,
            stock,
          });
        }
        await save();
        console.log(JSON.stringify(results));
      } else if (phase === 'verify' || phase === 'runtime') {
        const results = [];
        for (const o of f.orders) {
          const d = await api('/orders/' + o.id),
            p = (await api('/orders/' + o.id + '/shipping')).data.find((p: any) => p.id === o.plan);
          assert.equal(d.status, 'shipped');
          assert.equal(p.state, 'dispatched');
          assert.equal(d.shipments.length, 1);
          const stock = (
            await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [o.product])
          ).rows[0];
          assert.deepEqual(stock, { on_hand: 10, reserved: 0 });
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM stock_movements WHERE order_id=$1 AND kind='shipment'",
                [o.id],
              )
            ).rows[0].n,
            1,
          );
          const event = (
            await pool.query(
              "SELECT detail FROM order_events WHERE order_id=$1 AND kind='order.shipped'",
              [o.id],
            )
          ).rows[0];
          assert.equal(event.detail.provider, 'dpd');
          // Replaying dispatch cannot consume stock twice or invoke DPD.
          await api('/dpd-shipping/' + o.plan + '/dispatch', 'POST', {});
          assert.deepEqual(
            (
              await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [
                o.product,
              ])
            ).rows[0],
            stock,
          );
          if (o.mode === 'external_sandbox') {
            const r = await fetch('http://127.0.0.1:4100/api/shipments/' + o.shipment + '/label', {
              headers: { cookie },
            });
            assert.equal(r.status, 200);
            const b = Buffer.from(await r.arrayBuffer());
            assert.equal(createHash('sha256').update(b).digest('hex'), o.pdf_sha256);
          }
          results.push({
            number: o.number,
            state: p.state,
            scope: p.result.scope,
            tracking: p.result.tracking_number,
            stock,
            movements: 1,
            pdf_bytes: o.pdf_bytes,
            pdf_sha256: o.pdf_sha256,
          });
        }
        const after = await fingerprints(state.tenants);
        assert.deepEqual(after, state.before);
        const proof = {
          checked_at: new Date().toISOString(),
          scope: 'native_local_runtime_and_official_dpd_demo',
          previous_tenants: state.tenants.length,
          preserved_tables: tables.length,
          previous_rows_unchanged: true,
          read_probe: f.read_probe,
          results,
          health: await api('/health'),
        };
        const out = phase === 'runtime' ? 'data/dpd-stage045-runtime.json' : 'docs/dpd-qa.json';
        await writeFile(out, JSON.stringify(proof, null, 2) + '\n');
        console.log(JSON.stringify(proof));
      }
    }
  }
} finally {
  await pool.end();
}
