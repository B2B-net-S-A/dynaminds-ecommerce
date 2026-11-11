import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { parseCsv } from '../server/catalog';
import { demoWooOrder } from '../server/import-routes';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  operator: string,
  warehouse: string,
  otherWarehouse: string;
const images: string[] = [];
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url, method, payload, headers: { cookie: auth } });
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const login = async (email: string) =>
    (
      await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email, password: 'DynaDemo!2026' },
      })
    ).headers['set-cookie']!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  operator = await login('operator@demo.local');
  warehouse = (await req('/api/warehouses')).json().data[0].id;
  otherWarehouse = (await req('/api/warehouses', 'GET', undefined, other)).json().data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
  for (const id of images) await unlink('data/product-images/' + id).catch(() => {});
});
const sku = () => 'PIM-' + randomUUID().slice(0, 8);
async function product(extra: any = {}, auth = cookie) {
  const r = await req(
    '/api/products',
    'POST',
    {
      sku: sku(),
      name: 'Produkt PIM',
      price: 1000,
      quantity: 10,
      warehouse_id: warehouse,
      ...extra,
    },
    auth,
  );
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
async function bundle(parts: any[], extra: any = {}) {
  return product({ kind: 'bundle', quantity: 0, price: 5000, components: parts, ...extra });
}
async function detail(p: any) {
  return (await req('/api/products/' + p.id)).json();
}
async function edit(p: any, extra: any = {}) {
  const current = await detail(p);
  return req('/api/products/' + p.id, 'PATCH', { ...current, ...extra });
}
async function stock(p: any) {
  return (await req('/api/inventory?product_id=' + p.id))
    .json()
    .data.find((s: any) => s.product_id === p.id && s.warehouse_id === warehouse);
}
async function order(items: any[]) {
  return req('/api/orders', 'POST', {
    customer_name: 'Klient PIM',
    email: 'pim@example.test',
    warehouse_id: warehouse,
    items,
  });
}
async function status(id: string, status: string) {
  const r = await req('/api/orders/' + id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/api/orders/' + id + '/status', { status }));
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function preview(csv: string, auth = cookie) {
  return req('/api/catalog/imports/preview', 'POST', { warehouse_id: warehouse, csv }, auth);
}
const component = (p: any, quantity = 1) => ({ product_id: p.id, quantity });
test('wariant ma własny SKU i stan, grupa jest niesprzedawalna, parametry pozostają na karcie', async () => {
  const g = await product({ kind: 'group', quantity: 0 }),
    v = await product({
      kind: 'variant',
      parent_id: g.id,
      attributes: { Kolor: 'czarny', Rozmiar: 'M' },
    });
  assert.equal((await detail(g)).variants[0].id, v.id);
  assert.equal((await detail(v)).attributes.Rozmiar, 'M');
  assert.equal((await stock(v)).available, 10);
  assert.equal(await stock(g), undefined);
  assert.equal((await order([component(g)])).statusCode, 422);
  assert.equal((await order([component(v)])).statusCode, 201);
  const physical = await product();
  assert.equal(
    (
      await req('/api/products', 'POST', {
        sku: sku(),
        name: 'Zły wariant',
        price: 0,
        warehouse_id: warehouse,
        kind: 'variant',
        parent_id: physical.id,
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (await req('/api/products?sellable=true')).json().data.some((p: any) => p.id === g.id),
    false,
  );
});
test('zestaw oblicza dostępność w pojedynczym magazynie, bez fikcyjnego własnego stanu', async () => {
  const a = await product({ quantity: 8 }),
    b = await product({ quantity: 5 }),
    kit = await bundle([component(a, 2), component(b)]);
  assert.equal((await req('/api/products?search=' + kit.sku)).json().data[0].available, 4);
  assert.equal(await stock(kit), undefined);
  const w = (await req('/api/warehouses')).json().data.find((v: any) => v.id !== warehouse);
  await tenantTx(DEMO_TENANT, async (c) => {
    await c.query(
      'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) VALUES($1,$2,$3,4)',
      [DEMO_TENANT, w.id, a.id],
    );
    await c.query(
      'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) VALUES($1,$2,$3,0)',
      [DEMO_TENANT, w.id, b.id],
    );
  });
  assert.equal((await req('/api/products?search=' + kit.sku)).json().data[0].available, 4);
  assert.equal(
    (await req('/api/products?search=' + kit.sku + '&warehouse_id=' + w.id)).json().data[0]
      .available,
    0,
  );
});
test('zestaw i bezpośrednia pozycja współdzielą jedną atomową rezerwację składnika', async () => {
  const a = await product({ quantity: 5 }),
    b = await product(),
    kit = await bundle([component(a, 2), component(b)]);
  const rejected = await order([component(kit, 2), component(a, 2)]);
  assert.equal(rejected.statusCode, 409);
  assert.equal((await stock(a)).reserved, 0);
  assert.equal((await stock(b)).reserved, 0);
  const r = await order([component(kit, 2), component(a)]);
  assert.equal(r.statusCode, 201, r.body);
  const o = r.json();
  assert.equal(o.items.length, 2);
  assert.equal(o.picking_items.length, 2);
  assert.equal(o.picking_items.find((i: any) => i.product_id === a.id).quantity, 5);
  assert.equal(o.total, 11000);
  assert.equal((await stock(a)).reserved, 5);
  await status(o.id, 'cancelled');
  assert.equal((await stock(a)).reserved, 0);
  assert.equal((await stock(b)).reserved, 0);
});
test('konkurujące zestawy nie sprzedają tych samych składników dwa razy', async () => {
  const p = await product({ quantity: 3 }),
    kit = await bundle([component(p, 2)]);
  const out = await Promise.all([order([component(kit)]), order([component(kit)])]);
  assert.deepEqual(out.map((r) => r.statusCode).sort(), [201, 409]);
  assert.equal((await stock(p)).reserved, 2);
});
test('kompletacja i zwrot używają zapisanych składników mimo późniejszej edycji zestawu', async () => {
  const a = await product({ quantity: 5 }),
    b = await product({ quantity: 5 }),
    kit = await bundle([component(a, 2), component(b)]);
  const r = await order([component(kit)]);
  assert.equal(r.statusCode, 201, r.body);
  const o = r.json();
  assert.equal((await edit(kit, { components: [component(b, 3)], price: 9900 })).statusCode, 200);
  await status(o.id, 'paid');
  await status(o.id, 'picking');
  assert.equal(
    (await req('/api/orders/' + o.id + '/scan', 'POST', { code: kit.sku })).statusCode,
    422,
  );
  assert.equal(
    (await req('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: 'packed' }))).statusCode,
    409,
  );
  for (const code of [a.sku, a.sku, b.sku])
    assert.equal((await req('/api/orders/' + o.id + '/scan', 'POST', { code })).statusCode, 200);
  await status(o.id, 'packed');
  assert.equal((await req('/api/orders/' + o.id + '/ship-demo', 'POST')).statusCode, 200);
  assert.equal((await stock(a)).on_hand, 3);
  assert.equal((await stock(b)).on_hand, 4);
  const invoice = (
    await req('/api/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' })
  ).json();
  assert.equal(invoice.data.total, 5000);
  assert.equal(invoice.data.items.length, 1);
  assert.equal(invoice.data.items[0].sku, kit.sku);
  await status(o.id, 'return_initiated');
  await status(o.id, 'return_received');
  assert.equal((await stock(a)).on_hand, 5);
  assert.equal((await stock(b)).on_hand, 5);
  const correction = (
    await req('/api/orders/' + o.id + '/documents', 'POST', { kind: 'correction' })
  ).json();
  assert.equal(correction.data.total, -5000);
  await status(o.id, 'return_completed');
});
test('skanowanie zachowuje SKU i EAN z chwili zakupu, zmiana katalogu nie blokuje realizacji', async () => {
  const p = await product({ ean: 'PIM-EAN' }),
    o = (await order([component(p)])).json();
  await edit(p, { ean: 'NEW-EAN' });
  await status(o.id, 'paid');
  await status(o.id, 'picking');
  assert.equal(
    (await req('/api/orders/' + o.id + '/scan', 'POST', { code: 'PIM-EAN' })).statusCode,
    200,
  );
});
test('zestawy zagnieżdżone, powtórzone, obce i nieaktywne składniki są odrzucane', async () => {
  const p = await product(),
    kit = await bundle([component(p)]),
    inactive = await product({ active: false });
  const foreign = await product({ warehouse_id: otherWarehouse }, other);
  for (const parts of [
    [component(kit)],
    [component(p), component(p)],
    [component(inactive)],
    [component(foreign)],
  ])
    assert.equal((await edit(kit, { components: parts })).statusCode, 422);
  assert.equal((await edit(kit, { components: [component(kit)] })).statusCode, 422);
  assert.equal(
    (
      await req('/api/products', 'POST', {
        sku: sku(),
        name: 'Wadliwy',
        price: 10,
        kind: 'group',
        warehouse_id: warehouse,
        quantity: 1,
      })
    ).statusCode,
    422,
  );
});
test('wersjonowanie zapobiega utracie zmian; role i RLS chronią kartę, receptury i importy', async () => {
  const p = await product(),
    snap = await detail(p);
  assert.equal((await edit(p, { name: 'Zmiana pierwsza' })).statusCode, 200);
  assert.equal(
    (await req('/api/products/' + p.id, 'PATCH', { ...snap, name: 'Stara karta' })).statusCode,
    409,
  );
  assert.equal((await req('/api/products/' + p.id, 'GET', undefined, other)).statusCode, 404);
  assert.equal((await req('/api/products/' + p.id, 'PATCH', snap, operator)).statusCode, 403);
  assert.equal((await preview('sku;name;price\nX;Test;1', viewer)).statusCode, 403);
  const kit = await bundle([component(p)]);
  await tenantTx(SECOND_TENANT, async (c) => {
    assert.equal(
      (await c.query('SELECT * FROM bundle_components WHERE bundle_id=$1', [kit.id])).rowCount,
      0,
    );
    assert.equal(
      (await c.query('SELECT * FROM order_pick_items')).rows.some(
        (i) => i.tenant_id === DEMO_TENANT,
      ),
      false,
    );
  });
});
test('CSV poprawnie obsługuje BOM, cytowane separatory, nowe linie i podwójny cudzysłów', () => {
  const rows = parseCsv(
    '\uFEFFsku,name,price,description\r\nA,"Nazwa, produktu",1.23,"Linia 1\nLinia ""2"""\r\n',
  );
  assert.equal(rows[0].name, 'Nazwa, produktu');
  assert.equal(rows[0].description, 'Linia 1\nLinia "2"');
  assert.throws(() => parseCsv('sku;name;price\nA;"broken;1'));
});
test('CSV tworzy grupę, wariant i zestaw niezależnie od kolejności, a replay nie dubluje stanu', async () => {
  const prefix = sku(),
    g = prefix + 'G',
    v = prefix + 'V',
    b = prefix + 'B';
  const csv = `sku;name;price;kind;parent_sku;components;quantity;attributes\n${b};Zestaw CSV;39,99;bundle;;"[{""sku"":""${v}"",""quantity"":2}]";0;\n${v};Wariant CSV;20,00;variant;${g};;6;"{""Kolor"":""granat""}"\n${g};Grupa CSV;0;group;;;0;`;
  const r = await preview(csv);
  assert.equal(r.statusCode, 200, r.body);
  const data = r.json();
  assert.equal(data.valid, true, JSON.stringify(data.errors));
  assert.equal((await req('/api/products?search=' + prefix)).json().data.length, 0);
  const applied = await req('/api/catalog/imports/' + data.id + '/apply', 'POST');
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json().created, 3);
  const again = await req('/api/catalog/imports/' + data.id + '/apply', 'POST');
  assert.equal(again.json().reused, true);
  const rows = (await req('/api/products?search=' + prefix)).json().data;
  assert.equal(rows.length, 3);
  const variant = rows.find((p: any) => p.sku === v),
    kit = rows.find((p: any) => p.sku === b);
  assert.equal((await stock(variant)).on_hand, 6);
  assert.equal(kit.available, 3);
  assert.equal((await detail(variant)).attributes.Kolor, 'granat');
});
test('CSV błędy wiersza, nieznane powiązania i powtórzone SKU blokują zatwierdzenie', async () => {
  for (const text of [
    'sku;name;price\nA;Test;1.234',
    'sku;name;price\nA;Test;1\nA;Drugi;2',
    'sku;name;price;kind;parent_sku\nA;Test;1;variant;MISSING',
    'sku;name;price;wat\nA;Test;1;x',
  ]) {
    const r = await preview(text);
    assert.ok(r.statusCode === 422 || r.json().valid === false, r.body);
  }
});
test('CSV konflikt po podglądzie i obcy tenant nie zapisują części pliku', async () => {
  const p = await product(),
    newSku = sku();
  const r = (await preview(`sku;name;price\n${newSku};Nowy CSV;1\n${p.sku};Zmiana CSV;2`)).json();
  assert.equal(r.valid, true);
  assert.equal(
    (await req('/api/catalog/imports/' + r.id + '/apply', 'POST', undefined, other)).statusCode,
    404,
  );
  await edit(p, { price: 2500 });
  assert.equal((await req('/api/catalog/imports/' + r.id + '/apply', 'POST')).statusCode, 409);
  assert.equal((await req('/api/products?search=' + newSku)).json().data.length, 0);
});
test('CSV istniejący SKU aktualizuje katalog, a nie nadpisuje stanów lub typów', async () => {
  const p = await product();
  const bad = (await preview(`sku;name;price;quantity\n${p.sku};Zmieniony;9;5`)).json();
  assert.equal(bad.valid, false);
  const good = (await preview(`sku;name;price\n${p.sku};Zmieniony;9,01`)).json();
  assert.equal(good.valid, true);
  assert.equal((await req('/api/catalog/imports/' + good.id + '/apply', 'POST')).statusCode, 200);
  assert.equal((await detail(p)).price, 901);
  assert.equal((await stock(p)).on_hand, 10);
});
test('lokalne zdjęcie jest prywatne dla tenanta, HTML i obce obrazy są odrzucone', async () => {
  const data =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5FkAAAAASUVORK5CYII=';
  const image = await req('/api/product-images', 'POST', { data });
  assert.equal(image.statusCode, 201, image.body);
  const img = image.json();
  images.push(img.id);
  const p = await product({ images: [img.url] });
  assert.equal((await detail(p)).images[0], img.url);
  const read = await req(img.url);
  assert.equal(read.statusCode, 200);
  assert.match(String(read.headers['content-type']), /image\/png/);
  assert.equal(read.headers['x-content-type-options'], 'nosniff');
  assert.equal((await req(img.url, 'GET', undefined, other)).statusCode, 404);
  assert.equal((await app.inject({ url: img.url })).statusCode, 401);
  assert.equal(
    (
      await req('/api/product-images', 'POST', {
        data: Buffer.from('<svg onload="evil"/>').toString('base64'),
      })
    ).statusCode,
    422,
  );
  const foreign = await product({ warehouse_id: otherWarehouse }, other);
  const f = (await req('/api/products/' + foreign.id, 'GET', undefined, other)).json();
  assert.equal(
    (await req('/api/products/' + foreign.id, 'PATCH', { ...f, images: [img.url] }, other))
      .statusCode,
    422,
  );
  assert.equal((await edit(p, { images: ['javascript:alert(1)'] })).statusCode, 422);
});
test('kolejne strony katalogu nie pomijają i nie powtarzają produktów', async () => {
  const count = await tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT count(*)::int AS count FROM products')).rows[0].count,
  );
  const all = new Set<string>();
  let cursor = '';
  for (let n = 0; n <= Math.ceil(count / 3); n++) {
    const d = (await req('/api/products?limit=3' + (cursor ? '&after=' + cursor : ''))).json();
    for (const p of d.data) {
      assert.ok(!all.has(p.id));
      all.add(p.id);
    }
    if (!d.meta.has_more) break;
    cursor = d.meta.cursor;
  }
  assert.equal(all.size, count);
});
test('importowana oferta zestawu zachowuje cenę kanału i rezerwuje lokalne składniki', async () => {
  const a = await product({ quantity: 10 }),
    b = await product({ quantity: 10 }),
    kit = await bundle([component(a), component(b, 2)]);
  const channel = (
    await req('/api/integrations', 'POST', {
      provider: 'woocommerce',
      name: 'PIM Woo',
      mode: 'sandbox',
      settings: { store_url: 'https://example.com' },
      credentials: { consumer_key: 'fixture', consumer_secret: 'fixture' },
    })
  ).json().id;
  assert.equal(
    (
      await req('/api/integrations/' + channel + '/mappings', 'POST', {
        external_id: '701',
        sku: kit.sku,
      })
    ).statusCode,
    200,
  );
  const r = await req('/api/integrations/' + channel + '/stage-orders', 'POST', {
    data: [demoWooOrder],
  });
  assert.equal(r.statusCode, 200, r.body);
  const list = (await req('/api/integrations/' + channel + '/imports')).json();
  const committed = await req('/api/imports/' + list.data[0].id + '/commit', 'POST', {
    warehouse_id: warehouse,
  });
  assert.equal(committed.statusCode, 200, committed.body);
  const o = committed.json();
  assert.equal(o.total, 10001);
  assert.equal(o.items[0].line_total, 9501);
  assert.equal(o.items[0].quantity, 3);
  assert.equal(o.picking_items.find((i: any) => i.product_id === b.id).quantity, 6);
  assert.equal((await stock(a)).reserved, 3);
  assert.equal((await stock(b)).reserved, 6);
});
test('dwa zatwierdzenia odrębnych podglądów tego samego nowego SKU nie dublują dostawy', async () => {
  const newSku = sku(),
    csv = `sku;name;price;quantity\n${newSku};Konkurencyjny CSV;1;4`;
  const a = (await preview(csv)).json(),
    b = (await preview(csv)).json();
  assert.ok(a.valid && b.valid);
  const out = await Promise.all([
    req('/api/catalog/imports/' + a.id + '/apply', 'POST'),
    req('/api/catalog/imports/' + b.id + '/apply', 'POST'),
  ]);
  assert.deepEqual(out.map((r) => r.statusCode).sort(), [200, 409]);
  const p = (await req('/api/products?search=' + newSku)).json().data[0];
  assert.equal((await stock(p)).on_hand, 4);
});
test('CSV zachowuje pominięte parametry, zdjęcia, opis, rodzica i skład istniejącego produktu', async () => {
  const g = await product({ kind: 'group', quantity: 0 }),
    p = await product({
      kind: 'variant',
      parent_id: g.id,
      attributes: { Kolor: 'biały' },
      images: ['https://example.com/catalog-fixture.png'],
      description: 'Nie kasuj',
      active: true,
    }),
    kit = await bundle([component(p, 2)], { description: 'Opis zestawu' });
  const plan = (
    await preview(
      `sku;name;price\n${p.sku};Nowa nazwa wariantu;11\n${kit.sku};Nowa nazwa zestawu;22`,
    )
  ).json();
  assert.equal(plan.valid, true, JSON.stringify(plan.errors));
  assert.equal((await req('/api/catalog/imports/' + plan.id + '/apply', 'POST')).statusCode, 200);
  const variant = await detail(p),
    bundleNow = await detail(kit);
  assert.equal(variant.parent_id, g.id);
  assert.deepEqual(variant.attributes, { Kolor: 'biały' });
  assert.deepEqual(variant.images, ['https://example.com/catalog-fixture.png']);
  assert.equal(variant.description, 'Nie kasuj');
  assert.equal(bundleNow.components[0].product_id, p.id);
  assert.equal(bundleNow.components[0].quantity, 2);
  assert.equal(bundleNow.description, 'Opis zestawu');
});

test('strony katalogu zachowują pełny zbiór i bilans zestawów w wielu magazynach', async () => {
  const prefix = 'PAGE-' + randomUUID().slice(0, 8);
  const a = await product({ name: prefix + ' A', quantity: 11 });
  const b = await product({ name: prefix + ' B', quantity: 7 });
  const g = await product({ name: prefix + ' grupa', kind: 'group', quantity: 0 });
  const v = await product({
    name: prefix + ' wariant',
    kind: 'variant',
    parent_id: g.id,
    quantity: 6,
  });
  const inactive = await product({ name: prefix + ' nieaktywny', active: false, quantity: 4 });
  const kit = await bundle([component(a, 2), component(b, 3)], { name: prefix + ' zestaw' });
  const records = [a, b, g, v, inactive, kit];
  const expected = new Map(
    records.map((p) => [
      p.id,
      p.id === kit.id
        ? 2
        : p.id === g.id
          ? 0
          : p.id === a.id
            ? 11
            : p.id === b.id
              ? 7
              : p.id === v.id
                ? 6
                : 4,
    ]),
  );
  for (let i = 0; i < 9; i++) {
    const p = await product({ name: prefix + ' fizyczny ' + i, quantity: i + 1 });
    records.push(p);
    expected.set(p.id, i + 1);
  }
  const w = (await req('/api/warehouses')).json().data.find((row: any) => row.id !== warehouse);
  await tenantTx(DEMO_TENANT, async (c) => {
    await c.query(
      'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) VALUES($1,$2,$3,10),($1,$2,$4,9)',
      [DEMO_TENANT, w.id, a.id, b.id],
    );
  });
  async function pages(params: string, ids: string[], quantities: Map<string, number>) {
    const seen: string[] = [];
    let cursor = '';
    do {
      const r = await req(
        '/api/products?search=' + prefix + '&limit=4' + params + (cursor ? '&after=' + cursor : ''),
      );
      assert.equal(r.statusCode, 200, r.body);
      const page = r.json();
      assert(page.data.length <= 4);
      for (const row of page.data) {
        assert.equal(row.tenant_id, DEMO_TENANT);
        assert.equal(row.available, quantities.get(row.id));
        if (row.kind === 'bundle') assert.equal(row.on_hand, 0);
        seen.push(row.id);
      }
      assert.equal(page.meta.has_more, page.meta.cursor !== null);
      cursor = page.meta.cursor ?? '';
    } while (cursor);
    assert.deepEqual(seen, [...ids].sort());
  }
  const ids = records.map((p) => p.id);
  await pages('&warehouse_id=' + warehouse, ids, expected);
  const all = new Map(expected);
  all.set(a.id, 21);
  all.set(b.id, 16);
  all.set(kit.id, 5);
  await pages('', ids, all);
  await pages(
    '&sellable=true',
    records.filter((p) => p.id !== g.id && p.id !== inactive.id).map((p) => p.id),
    all,
  );
  await pages('&warehouse_id=' + otherWarehouse, ids, new Map(ids.map((id) => [id, 0])));
  const foreign = await req('/api/products?search=' + prefix, 'GET', undefined, other);
  assert.equal(foreign.statusCode, 200);
  assert.deepEqual(foreign.json().data, []);
});
