import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/b2b-stage048.json',
  phase = process.argv[2];
let cookie = '',
  state: any;
async function api(url: string, method = 'GET', body?: any, status = 200, auth = cookie) {
  const r = await fetch('http://127.0.0.1:4100/api' + url, {
    method,
    headers: { cookie: auth, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (auth === cookie && r.headers.get('set-cookie'))
    cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d = await r.json();
  assert.equal(r.status, status, url + ':' + JSON.stringify(d));
  return d as any;
}
const save = () => writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
const fingerprint = async (table: string, columns: string[], tenants: string[]) => {
  assert(/^[a-z_]+$/.test(table) && columns.every((c) => /^[a-z_]+$/.test(c)));
  const rows = (
    await pool.query(
      'SELECT to_jsonb(t)::text row FROM (SELECT ' +
        columns.join(',') +
        ' FROM ' +
        table +
        ' WHERE tenant_id=ANY($1::uuid[])) t ORDER BY 1',
      [tenants],
    )
  ).rows;
  return {
    count: rows.length,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
};
try {
  if (phase === 'baseline') {
    await assert.rejects(readFile(path), 'Existing baseline must not be replaced');
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const columns = (
      await pool.query(
        "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
      )
    ).rows;
    const all: Record<string, string[]> = {};
    for (const c of columns) (all[c.table_name] ??= []).push(c.column_name);
    const before: Record<string, any> = {};
    for (const [table, cols] of Object.entries(all))
      if (
        cols.includes('tenant_id') &&
        !['sessions', 'b2b_sessions', 'jobs', 'job_attempts', 'webhook_deliveries'].includes(table)
      )
        before[table] = { columns: cols, ...(await fingerprint(table, cols, tenants)) };
    state = { tenants, before };
    await save();
    console.log({ previous_tenants: tenants.length, tables: Object.keys(before).length });
  } else {
    state = JSON.parse(await readFile(path, 'utf8'));
    if (phase === 'setup') {
      assert(!state.fixture, 'Do not repeat QA creation');
      await api(
        '/auth/signup',
        'POST',
        {
          email: 'qa-b2b@demo.local',
          password: 'DynaDemo!2026',
          name: 'QA B2B',
          organization: { name: 'QA B2B 20261004' },
        },
        201,
      );
      const f: any = (state.fixture = { tenant: (await api('/auth/me')).user.tenant_id });
      await save();
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.product = (
        await api(
          '/products',
          'POST',
          {
            sku: 'B2B-QA-048',
            name: 'Zestaw do pakowania B2B',
            description: 'Syntetyczny produkt lokalny. Zamówienia w opakowaniach po dwie sztuki.',
            attributes: { Materiał: 'Papier', Opakowanie: '2 sztuki' },
            price: 20000,
            quantity: 20,
            warehouse_id: f.warehouse,
          },
          201,
        )
      ).id;
      const l = await api('/price-lists', 'POST', { name: 'Hurtowy QA B2B', currency: 'PLN' }, 201);
      f.list = l.id;
      await api('/price-lists/' + l.id + '/items', 'PUT', {
        version: l.version,
        items: [{ product_id: f.product, price: 12345 }],
      });
      await save();
      console.log({ tenant: f.tenant, product: f.product, list: f.list });
    } else {
      const f = state.fixture;
      assert(f);
      await api('/auth/login', 'POST', { email: 'qa-b2b@demo.local', password: 'DynaDemo!2026' });
      if (phase === 'activate') {
        const a = (await api('/b2b/accounts')).data.find(
          (a: any) => a.email === 'buyer-b2b@example.test',
        );
        assert(a?.active, 'Create and approve synthetic buyer in Chrome first');
        assert(!a.activated);
        const i = await api('/b2b/accounts/' + a.id + '/invite', 'POST', {
          version: a.version,
          confirmed: true,
        });
        await api('/public/b2b/' + a.id + '/activate', 'POST', {
          token: i.invitation.split('#invite=')[1],
          password: 'BuyerDemo!2026',
        });
        f.account = a.id;
        await save();
        console.log({ account: f.account, portal: 'http://127.0.0.1:5173/b2b/' + a.id });
      } else if (phase === 'ship') {
        assert(!f.order, 'Do not repeat fulfillment');
        const rows = (
          await pool.query('SELECT id,total FROM orders WHERE tenant_id=$1 AND b2b_account_id=$2', [
            f.tenant,
            f.account,
          ])
        ).rows;
        assert.equal(rows.length, 1, 'One Chrome checkout expected');
        const o = rows[0];
        assert.equal(o.total, 25190);
        f.order = o.id;
        await save();
        assert.deepEqual(
          (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product]))
            .rows[0],
          { on_hand: 20, reserved: 2 },
        );
        for (const status of ['paid', 'picking'])
          await api('/orders/' + o.id + '/status', 'PATCH', { status });
        for (let n = 0; n < 2; n++)
          await api('/orders/' + o.id + '/scan', 'POST', { code: 'B2B-QA-048' });
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
        await api('/orders/' + o.id + '/ship-demo', 'POST', {});
        await api('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
        assert.deepEqual(
          (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product]))
            .rows[0],
          { on_hand: 18, reserved: 0 },
        );
        console.log({ order: f.order, stock: 18, reserved: 0, shipment: 'local_demo' });
      } else if (phase === 'settle') {
        const o = await api('/orders/' + f.order);
        assert.equal(o.returns.cases.length, 1, 'One Chrome buyer return expected');
        const r = o.returns.cases[0];
        assert.equal(r.submitted_by, 'buyer');
        assert.equal(r.state, 'requested');
        f.return = r.id;
        const received = await api('/returns/' + r.id + '/receive', 'POST', {
          version: r.version,
          note: 'Lokalna syntetyczna kontrola B2B',
          items: [{ item_id: o.items[0].id, accepted: 1, restocked: 1 }],
        });
        assert.equal(received.refund_amount, 12345);
        await api('/returns/' + r.id + '/refund', 'POST', {
          version: received.version,
          amount: 12345,
          reference: 'Lokalna deklaracja QA B2B bez przelewu',
          confirmed: true,
        });
        await save();
        console.log({ return: r.id, declared_refund: 12345, external_payment: false });
      } else if (['verify', 'runtime'].includes(phase)) {
        const o = await api('/orders/' + f.order);
        assert.equal(o.source, 'b2b');
        assert.equal(o.total, 25190);
        assert.equal(o.items[0].price, 12345);
        assert.equal(o.b2b_account_id, f.account);
        assert.equal(o.returns.cases[0].state, 'closed');
        assert.equal(o.returns.cases[0].refund_amount, 12345);
        assert.equal(o.shipments.length, 1);
        assert.equal(o.documents.length, 1);
        const stock = (
          await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product])
        ).rows[0];
        assert.deepEqual(stock, { on_hand: 19, reserved: 0 });
        for (const [table, before] of Object.entries(state.before) as any)
          if (table !== 'order_status_configs')
            assert.deepEqual(
              await fingerprint(table, before.columns, state.tenants),
              { count: before.count, sha256: before.sha256 },
              table,
            );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM orders WHERE tenant_id=ANY($1::uuid[]) AND (b2b_account_id IS NOT NULL OR b2b_snapshot IS NOT NULL)',
              [state.tenants],
            )
          ).rows[0].n,
          0,
        );
        const login = await fetch('http://127.0.0.1:4100/api/public/b2b/' + f.account + '/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'buyer-b2b@example.test', password: 'BuyerDemo!2026' }),
        });
        assert.equal(login.status, 200);
        const buyer = login.headers.get('set-cookie')!.split(';')[0],
          detail = await api(
            '/public/b2b/' + f.account + '/orders/' + f.order,
            'GET',
            undefined,
            200,
            buyer,
          );
        assert.equal(detail.cases[0].state, 'closed');
        assert.equal(detail.portal_token, undefined);
        assert.equal(detail.items[0].cost, undefined);
        await api('/public/b2b/' + f.account + '/logout', 'POST', {}, 200, buyer);
        const audit = (
          await pool.query(
            "SELECT action,user_id,detail FROM audit_events WHERE tenant_id=$1 AND action IN ('b2b.quote','b2b.checkout','order.create') ORDER BY created_at",
            [f.tenant],
          )
        ).rows;
        assert(audit.length >= 3 && audit.every((a) => a.user_id === null));
        const out = {
          checked_at: new Date().toISOString(),
          scope: 'native_local_B2B_Chrome_purchase_return_and_API_fulfillment',
          previous_tenants: state.tenants.length,
          preserved_tables: Object.keys(state.before).length - 1,
          excluded_runtime_table: {
            table: 'order_status_configs',
            reason:
              'Previously enabled local status scheduler advances next_run_at/last_run_at independently of B2B. Business rows in other 92 tables are compared to the original baseline.',
          },
          previous_rows_unchanged: true,
          order: f.order,
          account: f.account,
          total: 25190,
          currency: o.currency,
          buyer_price: 12345,
          stock,
          return_state: 'closed',
          refund_declared: 12345,
          external_sales: 0,
          external_payments: 0,
          provider_requests: 0,
          audit_actions: audit.map((a) => a.action),
          health: await api('/health'),
        };
        await writeFile(
          phase === 'runtime' ? 'data/b2b-stage048-runtime.json' : 'docs/b2b-qa.json',
          JSON.stringify(out, null, 2) + '\n',
        );
        console.log(JSON.stringify(out));
      } else throw Error('Unknown phase');
    }
  }
} finally {
  await pool.end();
}
