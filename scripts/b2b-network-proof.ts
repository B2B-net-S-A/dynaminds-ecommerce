import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/b2b-network-stage049.json',
  phase = process.argv[2];
let cookie = '',
  state: any;
async function api(url: string, method = 'GET', body?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + url, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d: any = await r.json();
  assert.equal(r.status, status, url + ':' + JSON.stringify(d));
  return d;
}
const save = () => writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
async function login(side: string) {
  await api('/auth/login', 'POST', { email: state[side].email, password: 'DynaDemo!2026' });
}
async function fingerprint(table: string, columns: string[], tenants: string[]) {
  assert(/^[a-z_][a-z_0-9]*$/.test(table) && columns.every((c) => /^[a-z_][a-z_0-9]*$/.test(c)));
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
}
try {
  if (phase === 'baseline') {
    await assert.rejects(readFile(path), 'Do not replace an existing baseline');
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const columns = (
      await pool.query(
        "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
      )
    ).rows;
    const all: Record<string, string[]> = {};
    for (const c of columns) (all[c.table_name] ??= []).push(c.column_name);
    const before: Record<string, any> = {};
    const excluded = [
      'sessions',
      'b2b_sessions',
      'jobs',
      'job_attempts',
      'webhook_deliveries',
      'order_status_configs',
    ];
    for (const [table, cols] of Object.entries(all))
      if (cols.includes('tenant_id') && !excluded.includes(table))
        before[table] = { columns: cols, ...(await fingerprint(table, cols, tenants)) };
    state = { tenants, before, excluded };
    await save();
    console.log({ previous_tenants: tenants.length, tables: Object.keys(before).length });
  } else {
    state = JSON.parse(await readFile(path, 'utf8'));
    if (phase === 'setup') {
      assert(!state.supplier && !state.buyer, 'Do not repeat QA creation');
      for (const [side, label] of [
        ['supplier', 'Dostawca'],
        ['buyer', 'Odbiorca'],
      ]) {
        const email = 'qa-network-' + side + '@demo.local';
        await api(
          '/auth/signup',
          'POST',
          {
            email,
            password: 'DynaDemo!2026',
            name: 'QA ' + label,
            organization: { name: 'QA Sieć B2B ' + label + ' 20261004' },
          },
          201,
        );
        const f: any = (state[side!] = { email, tenant: (await api('/auth/me')).user.tenant_id });
        await save();
        await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
        f.warehouse = (await api('/warehouses')).data[0].id;
      }
      await login('supplier');
      state.products = [];
      for (const [sku, name] of [
        ['NET-QA-049-A', 'Pudełko kraft do wysyłki'],
        ['NET-QA-049-B', 'Etykiety do pakowania'],
      ]) {
        const p = await api(
          '/products',
          'POST',
          {
            sku,
            name,
            description: 'Lokalny katalog testowy dostawcy DYNAMINDS.',
            attributes: { Materiał: 'Papier', Rynek: 'Polska' },
            price: 20000,
            quantity: 12,
            warehouse_id: state.supplier.warehouse,
          },
          201,
        );
        state.products.push(p.id);
      }
      const list = await api(
        '/price-lists',
        'POST',
        { name: 'Cennik sieci B2B QA', currency: 'PLN' },
        201,
      );
      state.list = list.id;
      await api('/price-lists/' + list.id + '/items', 'PUT', {
        version: list.version,
        items: state.products.map((product_id: string) => ({ product_id, price: 12345 })),
      });
      const body = {
        name: 'Firma odbiorcy QA',
        email: 'qa-network-partner@example.test',
        warehouse_id: state.supplier.warehouse,
        price_list_id: list.id,
        address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
        payment_mode: 'prepaid',
      };
      const a = await api('/b2b/accounts', 'POST', body, 201);
      state.account = (
        await api('/b2b/accounts/' + a.id, 'PATCH', {
          ...body,
          version: 1,
          active: true,
          confirmed: true,
        })
      ).id;
      await save();
      console.log({
        supplier: state.supplier.tenant,
        buyer: state.buyer.tenant,
        account: state.account,
      });
    } else if (phase === 'changed') {
      assert(!state.order, 'Do not repeat the QA reservation');
      await login('buyer');
      state.link = (await api('/b2b/network/links')).data[0].id;
      const rows = (await api('/b2b/network/links/' + state.link + '/catalog')).data;
      assert.equal(rows.length, 2);
      const copied = rows.find((i: any) => i.source_product_id === state.products[0]);
      assert(copied.product_id, 'Import first product in Chrome before changing supplier');
      state.local_product = copied.product_id;
      await login('supplier');
      const list = (await api('/price-lists')).data.find((l: any) => l.id === state.list);
      assert(list);
      await api('/price-lists/' + state.list + '/items', 'PUT', {
        version: list.version,
        items: [
          { product_id: state.products[0], price: 14000 },
          { product_id: state.products[1], price: null },
        ],
      });
      state.order = (
        await api(
          '/orders',
          'POST',
          {
            customer_name: 'QA Rezerwacja',
            email: 'qa-reservation@example.test',
            warehouse_id: state.supplier.warehouse,
            items: [{ product_id: state.products[0], quantity: 2 }],
          },
          201,
        )
      ).id;
      await save();
      console.log({ changed_price: 14000, available: 10, withdrawn_sku: 'NET-QA-049-B' });
    } else if (phase === 'due') {
      await login('buyer');
      const l = (await api('/b2b/network/links')).data.find((l: any) => l.id === state.link);
      assert.equal(l.schedule_minutes, 5);
      // Only move the synthetic QA clock; the real worker performs the read.
      await pool.query(
        "UPDATE b2b_links SET next_at=now()-interval '1 minute' WHERE id=$1 AND tenant_id=$2",
        [state.link, state.buyer.tenant],
      );
      console.log({ fixture_clock_moved: true });
    } else if (phase === 'verify' || phase === 'runtime') {
      await login('buyer');
      const l = (await api('/b2b/network/links')).data.find((l: any) => l.id === state.link);
      assert.equal(l.schedule_minutes, 0);
      assert(!l.paused);
      const base = '/b2b/network/links/' + l.id;
      const cat = (await api(base + '/catalog')).data;
      const current = cat.find((i: any) => i.source_product_id === state.products[0]);
      const removed = cat.find((i: any) => i.source_product_id === state.products[1]);
      assert.equal(current.snapshot.price, 14000);
      assert.equal(current.snapshot.available, 10);
      assert.equal(current.product_id, state.local_product);
      assert(removed && !removed.published);
      const p = await api('/products/' + state.local_product);
      assert.equal(p.price, 25000);
      assert.equal(p.description, 'Lokalny katalog testowy dostawcy DYNAMINDS.');
      const stock = (
        await pool.query(
          'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
          [state.buyer.tenant, p.id],
        )
      ).rows[0];
      assert.deepEqual(stock, { on_hand: 0, reserved: 0 });
      const runs = (await api(base + '/runs')).data;
      assert(runs.length >= 2 && runs.every((r: any) => r.state === 'done'));
      const unchanged = [];
      for (const [table, old] of Object.entries(state.before) as [string, any][]) {
        assert.deepEqual(
          await fingerprint(table, old.columns, state.tenants),
          { count: old.count, sha256: old.sha256 },
          table,
        );
        unchanged.push(table);
      }
      const health = await api('/health');
      assert.equal(health.schema_revision, '039_b2b_network');
      const report = {
        local_only: true,
        external_requests: 0,
        schema_revision: health.schema_revision,
        revision: health.revision,
        supplier_tenant: state.supplier.tenant,
        buyer_tenant: state.buyer.tenant,
        link: l.id,
        local_product: p.id,
        supplier_price: 14000,
        supplier_available: 10,
        local_sale_price: p.price,
        local_stock: stock,
        withdrawn_sku_preserved: true,
        completed_runs: runs.length,
        previous_tenants_unchanged: state.tenants.length,
        preserved_tables: unchanged,
        exclusions: state.excluded,
        schedule_disabled: true,
        whole_goal_complete: false,
      };
      await writeFile(
        phase === 'runtime' ? 'data/b2b-network-runtime.json' : 'docs/b2b-network-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log({
        verified: true,
        previous_tenants: state.tenants.length,
        tables: unchanged.length,
        revision: health.revision,
      });
    } else throw Error('Unknown phase');
  }
} finally {
  await pool.end();
}
