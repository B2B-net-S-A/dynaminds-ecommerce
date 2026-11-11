import type { PoolClient } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { ensure } from './errors';
import { audit, scan, transition, type Actor } from './domain';
import { fulfillmentPayment } from './payments';
import { resolveProductSkus } from './product-sku';
import { assertNoActivePackingInTx } from './packing-workstation-guards';
import { enlistWmsActorInTx } from './wms-lots-transaction';

export const waveSelection = z.strictObject({
  warehouse_id: z.uuid(),
  order_ids: z
    .array(z.uuid())
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Zamówienia nie mogą się powtarzać'),
});
export const waveCreateInput = waveSelection.extend({
  name: z.string().trim().min(2).max(100),
  preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
  client_key: z.uuid(),
});
export const waveVersion = z.strictObject({
  version: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .max(30),
});
export const waveScanInput = waveVersion.extend({
  layer_id: z.uuid().optional(),
  code: z.string().trim().min(1).max(80),
  location: z.string().trim().min(1).max(80),
  client_key: z.uuid(),
});
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const write = (a: Actor) =>
  ensure(a.role !== 'viewer', 403, 'Konto ma uprawnienia tylko do odczytu');
// paid is "Nowe" (ready to fulfil, cash on delivery included); new is "Nieopłacone" and never picked.
const eligible = (o: any) => ['paid', 'picking'].includes(o.status);
const orderFields = `o.*,to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') precise_created,
  to_char(o.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') precise_updated`;

async function selectionOrders(c: PoolClient, ids: string[], lock = false) {
  const rows = (
    await c.query(
      `SELECT ${orderFields} FROM orders o WHERE o.id=ANY($1::uuid[]) ORDER BY o.id ${lock ? 'FOR UPDATE OF o' : ''}`,
      [ids],
    )
  ).rows;
  ensure(rows.length === ids.length, 404, 'Nie znaleziono wszystkich zamówień w tej firmie');
  return rows.sort(
    (a, b) => a.precise_created.localeCompare(b.precise_created) || a.id.localeCompare(b.id),
  );
}
async function physicalLines(c: PoolClient, ids: string[]) {
  const rows = (
    await c.query(
      `SELECT a.order_id,a.product_id,a.location,a.quantity,a.scanned,r.state AS reservation_state,
    i.sku AS order_sku,i.ean AS order_ean,i.quantity AS pick_quantity,i.scanned AS pick_scanned,
    p.sku,p.ean,p.name
    FROM reservation_locations a JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id)
    JOIN order_pick_items i USING(tenant_id,order_id,product_id)
    JOIN products p ON (p.tenant_id,p.id)=(a.tenant_id,a.product_id)
    WHERE a.order_id=ANY($1::uuid[]) ORDER BY a.order_id,a.product_id,a.location LIMIT 2001`,
      [ids],
    )
  ).rows;
  ensure(
    rows.length <= 2000,
    409,
    'Partia obejmuje więcej niż 2000 pozycji lokalizacji. Wybierz mniej zamówień.',
  );
  return rows;
}
function grouped(lines: any[], orders: any[]) {
  const byOrder = new Map(orders.map((o, i) => [o.id, { ...o, slot: o.slot ?? i + 1 }]));
  const groups = new Map<string, any>();
  for (const l of lines) {
    const o = byOrder.get(l.order_id);
    if (!o || o.status === 'cancelled') continue;
    const key = JSON.stringify([l.product_id, l.location]);
    if (!groups.has(key))
      groups.set(key, {
        product_id: l.product_id,
        sku: l.sku,
        ean: l.ean,
        name: l.name,
        location: l.location,
        quantity: 0,
        scanned: 0,
        destinations: [],
      });
    const g = groups.get(key);
    g.quantity += l.quantity;
    g.scanned += l.scanned;
    g.destinations.push({
      order_id: o.id,
      number: o.number,
      slot: o.slot,
      quantity: l.quantity,
      scanned: l.scanned,
      status: o.status,
    });
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.location.localeCompare(b.location, 'pl', { numeric: true }) ||
      a.sku.localeCompare(b.sku, 'pl', { numeric: true }) ||
      a.product_id.localeCompare(b.product_id),
  );
}
function orderSummary(o: any) {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    payment_mode: o.payment_mode,
    slot: o.slot,
  };
}
export async function previewWave(
  c: PoolClient,
  a: Actor,
  input: z.infer<typeof waveSelection>,
  lock = false,
) {
  write(a);
  const orders = await selectionOrders(c, input.order_ids, lock);
  for (const order of orders) await assertNoActivePackingInTx(c, order.id);
  ensure(
    orders.every((o) => o.warehouse_id === input.warehouse_id),
    409,
    'Wybierz zamówienia z jednego magazynu',
  );
  ensure(
    orders.every(eligible),
    409,
    'Partia wymaga opłaconych zamówień, pobrań lub zamówień w kompletacji',
  );
  ensure(
    !(
      await c.query(
        'SELECT 1 FROM picking_wave_orders WHERE active AND order_id=ANY($1::uuid[]) LIMIT 1',
        [input.order_ids],
      )
    ).rowCount,
    409,
    'Zamówienie należy już do otwartej partii',
  );
  const financial = [];
  for (const o of orders)
    financial.push({ id: o.id, cod_expected: await fulfillmentPayment(c, o) });
  const lines = await physicalLines(c, input.order_ids);
  ensure(
    orders.every((o) => lines.some((l) => l.order_id === o.id)),
    409,
    'Brak lokalizacji rezerwacji dla zamówienia',
  );
  ensure(
    lines.every((l) => l.reservation_state === 'active'),
    409,
    'Rezerwacje zamówienia zostały zmienione',
  );
  const basis = orders.map((o) => ({
    id: o.id,
    status: o.status,
    warehouse_id: o.warehouse_id,
    updated: o.precise_updated,
    created: o.precise_created,
    payment_mode: o.payment_mode,
  }));
  const groups = grouped(lines, orders);
  ensure(
    groups.some((g) => g.scanned < g.quantity),
    409,
    'Wszystkie produkty zostały już zebrane',
  );
  return {
    preview_hash: digest([a.tenantId, input.warehouse_id, basis, financial, lines]),
    orders: orders.map((o, i) => orderSummary({ ...o, slot: i + 1 })),
    groups,
  };
}
export async function waveHeader(c: PoolClient, id: string, lock = false) {
  const row = (
    await c.query(
      `SELECT w.*,h.name AS warehouse_name FROM picking_waves w JOIN warehouses h ON (h.tenant_id,h.id)=(w.tenant_id,w.warehouse_id) WHERE w.id=$1 ${lock ? 'FOR UPDATE OF w' : ''}`,
      [id],
    )
  ).rows[0];
  ensure(row, 404, 'Nie znaleziono partii kompletacji');
  return row;
}
async function memberOrders(c: PoolClient, id: string, lock = false) {
  const rows = (
    await c.query(
      `SELECT ${orderFields},m.slot,m.active FROM picking_wave_orders m JOIN orders o ON (o.tenant_id,o.id)=(m.tenant_id,m.order_id) WHERE m.wave_id=$1 ORDER BY o.id ${lock ? 'FOR UPDATE OF o' : ''}`,
      [id],
    )
  ).rows;
  return rows.sort((a, b) => a.slot - b.slot);
}
export async function waveDetail(c: PoolClient, id: string) {
  const wave = await waveHeader(c, id);
  const orders = await memberOrders(c, id);
  const groups = grouped(
    await physicalLines(
      c,
      orders.map((o) => o.id),
    ),
    orders,
  );
  const scans = (
    await c.query(
      'SELECT id,client_key,result,created_at FROM picking_wave_scans WHERE wave_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20',
      [id],
    )
  ).rows;
  return {
    wave,
    orders: orders.map(orderSummary),
    groups,
    progress: {
      quantity: groups.reduce((n, g) => n + g.quantity, 0),
      scanned: groups.reduce((n, g) => n + g.scanned, 0),
      cancelled_orders: orders.filter((o) => o.status === 'cancelled').length,
    },
    scans,
  };
}
export async function createWave(c: PoolClient, a: Actor, input: z.infer<typeof waveCreateInput>) {
  write(a);
  const hash = digest({ ...input, order_ids: [...input.order_ids].sort() });
  const reused = (
    await c.query('SELECT id,input_hash FROM picking_waves WHERE client_key=$1', [input.client_key])
  ).rows[0];
  if (reused) {
    ensure(reused.input_hash === hash, 409, 'Klucz operacji został użyty z innymi danymi');
    return { reused: true, ...(await waveDetail(c, reused.id)) };
  }
  await selectionOrders(c, input.order_ids, true);
  // Recheck before eligibility after the order locks so a concurrent identical replay succeeds.
  const raced = (
    await c.query('SELECT id,input_hash FROM picking_waves WHERE client_key=$1', [input.client_key])
  ).rows[0];
  if (raced) {
    ensure(raced.input_hash === hash, 409, 'Klucz operacji został użyty z innymi danymi');
    return { reused: true, ...(await waveDetail(c, raced.id)) };
  }
  const p = await previewWave(c, a, input);
  ensure(
    p.preview_hash === input.preview_hash,
    409,
    'Zamówienia zmieniły się. Przygotuj nowy podgląd partii.',
  );
  const id = randomUUID();
  await c.query(
    'INSERT INTO picking_waves(id,tenant_id,warehouse_id,name,created_by,client_key,input_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [id, a.tenantId, input.warehouse_id, input.name, a.userId, input.client_key, hash],
  );
  for (const o of p.orders) {
    await c.query(
      'INSERT INTO picking_wave_orders(tenant_id,wave_id,order_id,slot) VALUES($1,$2,$3,$4)',
      [a.tenantId, id, o.id, o.slot],
    );
    if (o.status !== 'picking') await transition(c, a, o.id, 'picking');
  }
  await audit(c, a, 'picking_wave.created', id, {
    orders: p.orders.length,
    warehouse_id: input.warehouse_id,
  });
  return { reused: false, ...(await waveDetail(c, id)) };
}
export async function scanWave(
  c: PoolClient,
  a: Actor,
  id: string,
  input: z.infer<typeof waveScanInput>,
) {
  a = enlistWmsActorInTx(c, a, { orders: true });
  write(a);
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    `catalog:${a.tenantId}`,
  ]);
  const wave = await waveHeader(c, id, true),
    hash = digest({ id, ...input });
  const prior = (
    await c.query('SELECT input_hash,result FROM picking_wave_scans WHERE client_key=$1', [
      input.client_key,
    ])
  ).rows[0];
  if (prior) {
    ensure(prior.input_hash === hash, 409, 'Klucz skanu został użyty z innymi danymi');
    return { reused: true, scan: prior.result, ...(await waveDetail(c, id)) };
  }
  ensure(wave.state === 'picking', 409, 'Partia została zamknięta');
  ensure(
    wave.version === input.version,
    409,
    'Partia zmieniła się. Odśwież przed kolejnym skanem.',
  );
  const orders = await memberOrders(c, id, true),
    orderMap = new Map(orders.map((o) => [o.id, o]));
  const lines = await physicalLines(
    c,
    orders.map((o) => o.id),
  );
  const aliasProducts = new Set((await resolveProductSkus(c, [input.code])).map((p) => p.id));
  const coded = lines.filter(
    (l) =>
      orderMap.get(l.order_id)?.status !== 'cancelled' &&
      ([l.sku, l.ean, l.order_sku, l.order_ean].filter(Boolean).includes(input.code) ||
        aliasProducts.has(l.product_id)),
  );
  ensure(coded.length > 0, 422, 'Kod nie należy do tej partii');
  ensure(
    new Set(coded.map((l) => l.product_id)).size === 1,
    422,
    'Kod odpowiada kilku produktom. Użyj unikalnego SKU.',
  );
  const product = coded[0].product_id;
  const bins = lines.filter(
    (l) =>
      l.product_id === product &&
      l.location === input.location &&
      orderMap.get(l.order_id)?.status !== 'cancelled',
  );
  ensure(bins.length > 0, 422, 'Lokalizacja nie należy do tego produktu w partii');
  const pending = bins
    .filter(
      (l) =>
        l.scanned < l.quantity &&
        l.reservation_state === 'active' &&
        orderMap.get(l.order_id)?.status === 'picking',
    )
    .sort((x, y) => orderMap.get(x.order_id)!.slot - orderMap.get(y.order_id)!.slot);
  ensure(
    pending.length > 0,
    409,
    'Produkt w tej lokalizacji jest już zebrany lub zamówienie nie jest w kompletacji',
  );
  const selected = pending[0],
    order = orderMap.get(selected.order_id)!;
  await scan(c, a, order.id, input.code, selected.location, undefined, {
    wave_id: id,
    layer_id: input.layer_id,
  });
  const version = (
    await c.query('UPDATE picking_waves SET version=version+1 WHERE id=$1 RETURNING version', [id])
  ).rows[0].version;
  const result = {
    order_id: order.id,
    number: order.number,
    slot: order.slot,
    product_id: product,
    sku: selected.sku,
    location: selected.location,
    version,
  };
  await c.query(
    'INSERT INTO picking_wave_scans(id,tenant_id,wave_id,order_id,actor_id,client_key,input_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(), a.tenantId, id, order.id, a.userId, input.client_key, hash, result],
  );
  await audit(c, a, 'picking_wave.scanned', id, result);
  return { reused: false, scan: result, ...(await waveDetail(c, id)) };
}
export async function closeWave(
  c: PoolClient,
  a: Actor,
  id: string,
  input: z.infer<typeof waveVersion>,
  action: 'completed' | 'cancelled',
) {
  write(a);
  const wave = await waveHeader(c, id, true);
  if (wave.state === action) return { reused: true, ...(await waveDetail(c, id)) };
  ensure(wave.state === 'picking', 409, 'Partia została już zamknięta');
  ensure(wave.version === input.version, 409, 'Partia zmieniła się. Odśwież przed zatwierdzeniem.');
  const orders = await memberOrders(c, id, true);
  if (action === 'completed') {
    const groups = grouped(
      await physicalLines(
        c,
        orders.map((o) => o.id),
      ),
      orders,
    );
    ensure(groups.length > 0, 409, 'Wszystkie zamówienia anulowano. Anuluj partię.');
    ensure(
      groups.every((g) => g.scanned === g.quantity),
      409,
      'Zbierz wszystkie produkty przed zakończeniem partii',
    );
  }
  await c.query(
    'UPDATE picking_waves SET state=$2,version=version+1,finished_at=clock_timestamp() WHERE id=$1',
    [id, action],
  );
  await c.query('UPDATE picking_wave_orders SET active=false WHERE wave_id=$1', [id]);
  await audit(c, a, 'picking_wave.' + action, id, { orders: orders.length });
  return { reused: false, ...(await waveDetail(c, id)) };
}
