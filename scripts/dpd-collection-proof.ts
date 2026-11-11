import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/dpd-collection-stage046.json';
const email = 'qa-dpd-collections@demo.local',
  password = 'DynaDemo!2026';
let cookie = '';
async function api(url: string, method = 'GET', body?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + url, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d = await r.json();
  assert.equal(r.status, status, url + ':' + JSON.stringify(d));
  return d as any;
}
let state: any;
const save = () => writeFile(path, JSON.stringify(state), { mode: 0o600 });
try {
  state = JSON.parse(await readFile(path, 'utf8'));
  const phase = process.argv[2];
  if (phase === 'setup') {
    assert(!state.fixture, 'Do not repeat setup');
    await api(
      '/auth/signup',
      'POST',
      {
        email,
        password,
        name: 'QA DPD Odbiory',
        organization: { name: 'QA DPD Odbiory 20261004' },
      },
      201,
    );
    const f: any = (state.fixture = { tenant: (await api('/auth/me')).user.tenant_id });
    await save();
    await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
    f.warehouse = (await api('/warehouses')).data[0].id;
    const s = (await (
        await fetch('https://dpdservices.dpd.com.pl/api-docs/01.%20All%20methods')
      ).json()) as any,
      d = s.info.description;
    f.channel = (
      await api('/integrations', 'POST', {
        provider: 'dpd',
        name: 'DPD DEMO odbiory QA',
        mode: 'sandbox',
        settings: { master_fid: d.match(/\*\*Master FID:\*\* (\d+)/)[1] },
        credentials: {
          username: d.match(/\*\*Login:\*\* (\S+)/)[1],
          password: d.match(/\*\*Password:\*\* (\S+)/)[1],
        },
      })
    ).id;
    f.read_probe = await api('/integrations/' + f.channel + '/test', 'POST', {});
    f.local = (await api('/dpd-shipping/example', 'POST', {})).channel_id;
    f.orders = [];
    await save();
    const party = {
      name: 'Nadawca syntetyczny QA',
      address: 'Testowa 1',
      city: 'Warszawa',
      postalCode: '01354',
      countryCode: 'PL',
      phone: '500600700',
      email: 'qa@example.test',
    };
    for (let n = 1; n <= 3; n++) {
      const p = await api(
        '/products',
        'POST',
        {
          sku: 'DPD-COL-QA-' + n,
          name: 'Paczka odbiory QA ' + n,
          quantity: 12,
          price: 5000,
          vat: 23,
          warehouse_id: f.warehouse,
        },
        201,
      );
      const o = await api(
        '/orders',
        'POST',
        {
          customer_name: 'Odbiorca syntetyczny QA',
          payment_mode: 'cod',
          email: party.email,
          address: {
            street: party.address,
            city: party.city,
            postal_code: party.postalCode,
            country: 'PL',
            phone: party.phone,
          },
          warehouse_id: f.warehouse,
          items: [{ product_id: p.id, quantity: 2 }],
        },
        201,
      );
      await api('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
      for (let x = 0; x < 2; x++) await api('/orders/' + o.id + '/scan', 'POST', { code: p.sku });
      await api('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
      const plan = await api('/orders/' + o.id + '/dpd-shipping/preview', 'POST', {
        channel_id: n === 3 ? f.local : f.channel,
        sender: party,
        receiver: { ...party, name: 'Odbiorca syntetyczny QA' },
        weight: n === 1 ? 1 : 1.5,
        dimensions: { length: 20, width: 15, height: 10 },
        content: 'Syntetyczny test API DPD',
        cod: 10000,
        insurance: 10000,
      });
      await api('/dpd-shipping/' + plan.id + '/queue', 'POST', {
        confirm_external: true,
        ack_contract_rate: true,
      });
      f.orders.push({
        id: o.id,
        number: o.number,
        product: p.id,
        plan: plan.id,
        scope: n === 3 ? 'local_simulation' : 'external_sandbox_verified',
      });
      await save();
    }
    console.log(JSON.stringify(f));
  } else {
    await api('/auth/login', 'POST', { email, password });
    const f = state.fixture;
    if (phase === 'ready') {
      for (const o of f.orders) {
        const d = await api('/orders/' + o.id);
        assert.equal(d.status, 'packed');
        const p = (await api('/orders/' + o.id + '/shipping')).data.find(
          (p: any) => p.id === o.plan,
        );
        assert.equal(p.state, 'ready', p.error);
        o.tracking = p.result.tracking_number;
      }
      await save();
      console.log(JSON.stringify(f.orders));
    } else if (phase === 'local') {
      const plan = f.orders[2].plan;
      const pickup = await api('/integrations/' + f.local + '/dpd-collections', 'POST', {
        kind: 'pickup',
        client_key: randomUUID(),
        plan_ids: [plan],
        date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        from: '09:00',
        to: '17:00',
      });
      const protocol = await api('/integrations/' + f.local + '/dpd-collections', 'POST', {
        kind: 'protocol',
        client_key: randomUUID(),
        plan_ids: [plan],
      });
      f.local_pickup = pickup.id;
      f.local_protocol = protocol.id;
      await save();
      await api('/dpd-collections/' + pickup.id + '/queue', 'POST', {});
      await api('/dpd-collections/' + protocol.id + '/queue', 'POST', {});
      console.log({ pickup: pickup.id, protocol: protocol.id });
    } else if (phase === 'local-cancel') {
      const p = (await api('/integrations/' + f.local + '/dpd-collections')).data.find(
        (p: any) => p.id === f.local_pickup,
      );
      assert.equal(p.state, 'ready');
      await api('/dpd-collections/' + p.id + '/cancel', 'POST', {});
      console.log('Local cancellation queued');
    } else if (phase === 'verify' || phase === 'runtime') {
      const results = [];
      for (const channel of [f.channel, f.local]) {
        const d = await api('/integrations/' + channel + '/dpd-collections');
        const pickup = d.data.find((r: any) => r.kind === 'pickup'),
          protocol = d.data.find((r: any) => r.kind === 'protocol');
        assert(pickup && protocol);
        assert.equal(pickup.state, 'cancelled', pickup.error);
        assert.equal(protocol.state, 'ready', protocol.error);
        assert.equal(
          pickup.result.scope,
          channel === f.channel ? 'external_sandbox_verified' : 'local_simulation',
        );
        assert.equal(protocol.result.document_base64, undefined);
        const r = await fetch(
          'http://127.0.0.1:4100/api/dpd-collections/' + protocol.id + '/document',
          { headers: { cookie } },
        );
        assert.equal(r.status, 200);
        const bytes = Buffer.from(await r.arrayBuffer());
        const result: any = {
          scope: pickup.result.scope,
          channel,
          pickup: pickup.id,
          remote_id: pickup.remote_id,
          protocol: protocol.id,
          count: pickup.input.count,
          weight: pickup.input.weight,
          document_bytes: bytes.length,
        };
        if (channel === f.channel) {
          assert.equal(r.headers.get('content-type'), 'application/pdf');
          assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
          result.pdf_sha256 = createHash('sha256').update(bytes).digest('hex');
          await writeFile('data/dpd-protocol-demo.pdf', bytes);
          f.external_protocol = protocol.id;
          f.protocol_sha256 = result.pdf_sha256;
          f.external_pickup = pickup.id;
        } else assert.match(bytes.toString(), /PROTOKÓŁ TESTOWY/);
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM dpd_pickup_claims WHERE collection_id=$1',
              [pickup.id],
            )
          ).rows[0].n,
          0,
        );
        await api('/dpd-collections/' + pickup.id + '/cancel', 'POST', {});
        results.push(result);
      }
      for (const o of f.orders) {
        assert.equal((await api('/orders/' + o.id)).status, 'packed');
        assert.deepEqual(
          (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [o.product]))
            .rows[0],
          { on_hand: 12, reserved: 2 },
        );
      }
      for (const [table, before] of Object.entries(state.before) as any) {
        const rows = (
          await pool.query(
            'SELECT to_jsonb(t)::text row FROM ' +
              table +
              ' t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
            [state.tenants],
          )
        ).rows;
        assert.deepEqual(
          {
            count: rows.length,
            sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
          },
          before,
          table,
        );
      }
      await save();
      const out = {
        checked_at: new Date().toISOString(),
        scope: 'native_local_runtime_official_dpd_demo_pickup_cancel_protocol',
        previous_tenants: state.tenants.length,
        preserved_tables: Object.keys(state.before).length,
        previous_rows_unchanged: true,
        stock_unchanged: true,
        reservations_retained: true,
        results,
        health: await api('/health'),
      };
      await writeFile(
        phase === 'runtime'
          ? 'data/dpd-collection-stage046-runtime.json'
          : 'docs/dpd-collection-qa.json',
        JSON.stringify(out, null, 2) + '\n',
      );
      console.log(JSON.stringify(out));
    }
  }
} finally {
  await pool.end();
}
