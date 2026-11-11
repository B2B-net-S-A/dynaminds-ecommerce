import type { PoolClient } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { ensure } from './errors';
import { audit, type Actor, type AuditActor } from './domain';
import { assertWmsLegacyQuantityWriteInTx } from './wms-lots';
import { prepareCatalogStockEffectInTx, finishCatalogStockEffectInTx, abandonCatalogStockEffectInTx } from './catalog-stock-control';
import { captureCatalogStockEffectJournalsInTx, catalogStockEffectProofInTx } from './catalog-stock-effects';
import { assertCatalogStockCountLocationInTx, type CatalogStockCountParent } from './catalog-stock-count-effects';
const location = z.string().trim().min(1).max(80);
export const locationScan = z
  .object({
    code: z.string().trim().min(1).max(80),
    location: location.optional(),
    layer_id: z.uuid().optional(),
    client_key: z.uuid().optional(),
  })
  .strict();
const base = z.object({
  warehouse_id: z.uuid(),
  product_id: z.uuid(),
  location,
  expected_version: z.string().regex(/^\d+$/).max(30),
  client_key: z.uuid(),
  note: z.string().trim().min(3).max(500),
});
export const locationMove = base
  .extend({ destination: location, quantity: z.number().int().min(1).max(1000000) })
  .strict();
export const locationCount = base
  .extend({ quantity: z.number().int().min(0).max(1000000) })
  .strict();
export async function allocations(c: PoolClient, order: string, product?: string) {
  return (
    await c.query(
      `SELECT a.*,r.state FROM reservation_locations a JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id) WHERE a.order_id=$1 AND ($2::uuid IS NULL OR a.product_id=$2) ORDER BY a.product_id,a.location`,
      [order, product ?? null],
    )
  ).rows;
}
export async function binStock(c: PoolClient, warehouse: string, product: string) {
  return (
    await c.query(
      `SELECT l.*,s.version,s.on_hand AS warehouse_on_hand,s.reserved AS warehouse_reserved,coalesce(h.quantity,0)::int AS reserved,(l.quantity-coalesce(h.quantity,0))::int AS available
 FROM stock_locations l JOIN stock s USING(tenant_id,warehouse_id,product_id)
 LEFT JOIN LATERAL(SELECT sum(a.quantity-coalesce((to_jsonb(a)->>'consumed_quantity')::integer,0)) AS quantity FROM reservation_locations a JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id) WHERE (a.tenant_id,a.warehouse_id,a.product_id,a.location)=(l.tenant_id,l.warehouse_id,l.product_id,l.location) AND r.state='active') h ON true WHERE l.warehouse_id=$1 AND l.product_id=$2 ORDER BY l.location`,
      [warehouse, product],
    )
  ).rows;
}
export async function reserveLocations(
  c: PoolClient,
  a: AuditActor,
  order: string,
  product: string,
  warehouse: string,
  quantity: number,
) {
  let remaining = quantity;
  for (const b of await binStock(c, warehouse, product)) {
    const take = Math.min(remaining, b.available);
    if (take > 0)
      await c.query(
        'INSERT INTO reservation_locations(tenant_id,order_id,product_id,warehouse_id,location,quantity) VALUES($1,$2,$3,$4,$5,$6)',
        [a.tenantId, order, product, warehouse, b.location, take],
      );
    remaining -= take;
    if (remaining === 0) break;
  }
  ensure(remaining === 0, 409, 'Brak dostępnego towaru w lokalizacjach');
}
export async function scanLocation(c: PoolClient, order: string, product: string, code?: string) {
  const bins = await allocations(c, order, product);
  ensure(
    bins.length > 0 && bins.every((b) => b.state === 'active'),
    409,
    'Brak aktywnych lokalizacji kompletacji',
  );
  ensure(
    code !== undefined || bins.length === 1,
    422,
    'Produkt jest w kilku lokalizacjach. Zeskanuj lub wybierz lokalizację.',
  );
  const b = bins.find((b) => b.location === (code ?? bins[0].location));
  ensure(b, 422, 'Lokalizacja nie należy do rezerwacji tego produktu');
  ensure(b.scanned < b.quantity, 409, 'Produkt w tej lokalizacji jest już skompletowany');
  await c.query(
    'UPDATE reservation_locations SET scanned=scanned+1 WHERE order_id=$1 AND product_id=$2 AND location=$3',
    [order, product, b.location],
  );
  return b.location;
}
export async function consumeLocations(c: PoolClient, a: Actor, r: any) {
  const movements: Array<{id:string;product_id:string;warehouse_id:string;location:string;quantity:number}> = [];
  await c.query('SELECT product_id FROM stock WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE', [
    r.warehouse_id,
    r.product_id,
  ]);
  const bins = await allocations(c, r.order_id, r.product_id);
  ensure(
    bins.length > 0 &&
      bins.every((b) => b.scanned === b.quantity) &&
      bins.reduce((s, b) => s + b.quantity, 0) === r.quantity,
    409,
    'Kompletacja lokalizacji nie jest zakończona',
  );
  for (const b of bins) {
    const n = await c.query(
      'UPDATE stock_locations SET quantity=quantity-$4 WHERE warehouse_id=$1 AND product_id=$2 AND location=$3 AND quantity>=$4',
      [r.warehouse_id, r.product_id, b.location, b.quantity],
    );
    ensure(n.rowCount === 1, 409, 'Brak towaru w lokalizacji rezerwacji');
    const movement = await c.query(
      "INSERT INTO stock_location_movements(tenant_id,warehouse_id,product_id,location,delta,kind,order_id) VALUES($1,$2,$3,$4,$5,'shipment',$6) RETURNING id",
      [a.tenantId, r.warehouse_id, r.product_id, b.location, -b.quantity, r.order_id],
    );
    movements.push({id:movement.rows[0].id,product_id:r.product_id,warehouse_id:r.warehouse_id,location:b.location,quantity:b.quantity});
  }
  return movements;
}
export async function locationOperation(
  c: PoolClient,
  a: Actor,
  b: z.infer<typeof locationCount> | z.infer<typeof locationMove>,
  kind: 'move' | 'count',
  internal: { catalogStockCountParent?: CatalogStockCountParent } = {},
) {
  await assertWmsLegacyQuantityWriteInTx(c, a);
  ensure(
    a.role === 'admin' || (kind === 'move' && a.role === 'operator'),
    403,
    'Brak uprawnień do operacji lokalizacji',
  );
  const hash = createHash('sha256')
    .update(JSON.stringify({ kind, ...b }))
    .digest('hex');
  const id = randomUUID();
  if (internal.catalogStockCountParent)
    await assertCatalogStockCountLocationInTx(c,a,internal.catalogStockCountParent,b,kind);
  const catalogEffect = kind === 'move' && !internal.catalogStockCountParent ? await prepareCatalogStockEffectInTx(c,a,{
    source_kind:'location_operation',source_id:id,warehouse_ids:[b.warehouse_id],product_ids:[b.product_id],
  }) : null;
  const catalogBaseline = await captureCatalogStockEffectJournalsInTx(c,catalogEffect);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'stock-location:' + a.tenantId + ':' + b.client_key,
  ]);
  const prior = (
    await c.query('SELECT * FROM stock_location_operations WHERE idempotency_key=$1', [
      b.client_key,
    ])
  ).rows[0];
  if (prior) {
    ensure(prior.input_hash === hash, 409, 'Klucz operacji ma inny zakres');
    if(catalogEffect)await abandonCatalogStockEffectInTx(c,a,catalogEffect);
    return { ...prior.result, reused: true };
  }
  const s = (
    await c.query('SELECT * FROM stock WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE', [
      b.warehouse_id,
      b.product_id,
    ])
  ).rows[0];
  ensure(s, 404, 'Nie znaleziono stanu produktu');
  ensure(
    s.version === b.expected_version,
    409,
    'Stan lub rezerwacje zmieniły się. Odczytaj lokalizacje i przelicz ponownie.',
  );
  const bins = await binStock(c, b.warehouse_id, b.product_id),
    source = bins.find((x) => x.location === b.location);
  ensure(source, 404, 'Nie znaleziono lokalizacji');
  async function delta(loc: string, n: number) {
    if (!n) return;
    await c.query(
      'INSERT INTO stock_locations(tenant_id,warehouse_id,product_id,location,quantity) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,warehouse_id,product_id,location) DO UPDATE SET quantity=stock_locations.quantity+excluded.quantity',
      [a.tenantId, b.warehouse_id, b.product_id, loc, n > 0 ? n : 0],
    );
    if (n < 0)
      await c.query(
        'UPDATE stock_locations SET quantity=quantity+$4 WHERE warehouse_id=$1 AND product_id=$2 AND location=$3',
        [b.warehouse_id, b.product_id, loc, n],
      );
    await c.query(
      'INSERT INTO stock_location_movements(tenant_id,warehouse_id,product_id,location,delta,kind,operation_id,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [a.tenantId, b.warehouse_id, b.product_id, loc, n, kind, id, b.note],
    );
  }
  if (kind === 'move') {
    const move = b as z.infer<typeof locationMove>;
    ensure(move.destination !== move.location, 422, 'Wybierz inną lokalizację docelową');
    ensure(source.available >= b.quantity, 409, 'Przesunięcie narusza rezerwacje lokalizacji');
    await delta(b.location, -b.quantity);
    await delta(move.destination, b.quantity);
    await c.query('UPDATE stock SET on_hand=on_hand WHERE warehouse_id=$1 AND product_id=$2', [
      b.warehouse_id,
      b.product_id,
    ]);
  } else {
    ensure(b.quantity >= source.reserved, 409, 'Pomiar narusza rezerwacje lokalizacji');
    const diff = b.quantity - source.quantity;
    ensure(s.on_hand + diff <= 2147483647, 409, 'Stan przekracza limit');
    await delta(b.location, diff);
    await c.query('UPDATE stock SET on_hand=on_hand+$3 WHERE warehouse_id=$1 AND product_id=$2', [
      b.warehouse_id,
      b.product_id,
      diff,
    ]);
    if (diff)
      await c.query(
        "INSERT INTO stock_movements(id,tenant_id,product_id,warehouse_id,delta,kind,note) VALUES($1,$2,$3,$4,$5,'location_count',$6)",
        [randomUUID(), a.tenantId, b.product_id, b.warehouse_id, diff, b.note],
      );
  }
  const result = { id, kind, data: await binStock(c, b.warehouse_id, b.product_id) };
  await c.query(
    'INSERT INTO stock_location_operations(id,tenant_id,idempotency_key,input_hash,result) VALUES($1,$2,$3,$4,$5)',
    [id, a.tenantId, b.client_key, hash, JSON.stringify(result)],
  );
  if(catalogEffect&&catalogBaseline)await finishCatalogStockEffectInTx(c,a,catalogEffect,
    await catalogStockEffectProofInTx(c,catalogBaseline,{location_operation_id:id}));
  await audit(c, a, 'stock.location.' + kind, b.product_id, {
    operation_id: id,
    warehouse_id: b.warehouse_id,
    location: b.location,
    quantity: b.quantity,
    note: b.note,
  });
  return result;
}
