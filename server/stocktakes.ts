import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ensure } from './errors';
import { productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
import { audit, type Actor } from './domain';
import { assertWmsLegacyQuantityWriteInTx } from './wms-lots';
const version = z.string().regex(/^\d+$/).max(30);
export const stocktakeInput = z
  .object({
    warehouse_id: z.uuid(),
    name: z.string().trim().min(3).max(100),
    location_prefix: z.string().trim().max(80).default(''),
    blind: z.boolean().default(true),
    client_key: z.uuid(),
  })
  .strict();
export const stocktakeVersion = z.object({ version }).strict();
export const stocktakePost = stocktakeVersion.extend({ confirmed: z.literal(true) }).strict();
export const stocktakeCount = z
  .object({
    client_key: z.uuid(),
    note: z.string().trim().min(3).max(500),
    lines: z
      .array(
        z
          .object({
            id: z.uuid(),
            version,
            expected_stock_version: version,
            quantity: z.number().int().min(0).max(1000000),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine((v) => new Set(v.map((l) => l.id)).size === v.length, 'Powtórzona pozycja'),
  })
  .strict();
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const stocktakePage = z.object({
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(80).default(''),
});
export async function stocktakeHeader(c: PoolClient, id: string, lock: boolean | 'share' = false) {
  const d = (
    await c.query(
      `SELECT t.*,w.name AS warehouse_name FROM stocktakes t JOIN warehouses w ON (w.tenant_id,w.id)=(t.tenant_id,t.warehouse_id) WHERE t.id=$1 ${lock === 'share' ? 'FOR SHARE OF t' : lock ? 'FOR UPDATE OF t' : ''}`,
      [id],
    )
  ).rows[0];
  ensure(d, 404, 'Nie znaleziono spisu');
  return d;
}
const lineSql = `SELECT l.*,s.version AS current_stock_version,s.on_hand AS warehouse_on_hand,b.quantity AS current_quantity,coalesce(h.quantity,0)::int AS reserved
 FROM stocktake_lines l JOIN stocktakes t ON (t.tenant_id,t.id)=(l.tenant_id,l.stocktake_id)
 JOIN stock s ON (s.tenant_id,s.warehouse_id,s.product_id)=(l.tenant_id,t.warehouse_id,l.product_id)
 JOIN stock_locations b ON (b.tenant_id,b.warehouse_id,b.product_id,b.location)=(l.tenant_id,t.warehouse_id,l.product_id,l.location)
 LEFT JOIN LATERAL(SELECT sum(a.quantity) AS quantity FROM reservation_locations a JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id) WHERE (a.tenant_id,a.warehouse_id,a.product_id,a.location)=(b.tenant_id,b.warehouse_id,b.product_id,b.location) AND r.state='active')h ON true WHERE l.stocktake_id=$1`;
async function allLines(c: PoolClient, id: string) {
  return (await c.query(lineSql + ' ORDER BY l.product_id,l.location', [id])).rows;
}
function conflict(l: any) {
  return l.current_stock_version !== l.basis_version;
}
function receiptHash(lines: any[]) {
  return digest(
    lines.map((l) => ({
      id: l.id,
      version: l.version,
      counted: l.counted,
      basis_version: l.basis_version,
      basis_quantity: l.basis_quantity,
    })),
  );
}
function summary(lines: any[]) {
  return {
    total: lines.length,
    counted: lines.filter((l) => l.counted !== null).length,
    changed: lines.filter((l) => l.counted !== null && l.counted !== l.basis_quantity).length,
    conflicts: lines.filter(conflict).length,
    below_reserved: lines.filter((l) => l.counted !== null && l.counted < l.reserved).length,
    delta: lines.reduce((n, l) => n + (l.counted === null ? 0 : l.counted - l.basis_quantity), 0),
  };
}
export async function stocktakeDetail(
  c: PoolClient,
  a: Actor,
  id: string,
  q: z.infer<typeof stocktakePage>,
) {
  const d = await stocktakeHeader(c, id, 'share');
  const total = (
    await c.query(
      `SELECT count(*)::int total,count(*) FILTER(WHERE counted IS NOT NULL)::int counted,count(*) FILTER(WHERE counted IS NOT NULL AND counted<>basis_quantity)::int changed,count(*) FILTER(WHERE current_stock_version<>basis_version)::int conflicts,count(*) FILTER(WHERE counted IS NOT NULL AND counted<reserved)::int below_reserved,coalesce(sum(counted-basis_quantity),0)::bigint delta FROM (${lineSql}) live`,
      [id],
    )
  ).rows[0];
  total.delta = Number(total.delta);
  if (!['counting', 'review'].includes(d.state)) {
    total.conflicts = 0;
    total.below_reserved = 0;
  }
  let after: any;
  if (q.after) {
    after = (
      await c.query(
        'SELECT product_id,location FROM stocktake_lines WHERE stocktake_id=$1 AND id=$2',
        [id, q.after],
      )
    ).rows[0];
    ensure(after, 422, 'Kursor nie należy do spisu');
  }
  const matched = (
    await c.query(
      lineSql +
        ` AND ($2::uuid IS NULL OR (l.product_id,l.location)>($2::uuid,$3::text)) AND ($4='' OR starts_with(lower(l.sku),lower($4)) OR starts_with(lower(l.location),lower($4))) ORDER BY l.product_id,l.location LIMIT $5`,
      [id, after?.product_id ?? null, after?.location ?? null, q.q, q.limit + 1],
    )
  ).rows;
  const data = matched.slice(0, q.limit).map((l) => ({
    ...l,
    conflict: ['counting', 'review'].includes(d.state) && conflict(l),
    difference: l.counted === null ? null : l.counted - l.basis_quantity,
  }));
  const hidden = d.blind && a.role !== 'admin' && ['counting', 'review'].includes(d.state);
  if (hidden)
    for (const l of data)
      for (const field of [
        'original_quantity',
        'basis_quantity',
        'current_quantity',
        'reserved',
        'difference',
        'warehouse_on_hand',
      ])
        delete l[field];
  return {
    ...d,
    summary: hidden
      ? { total: total.total, counted: total.counted, conflicts: total.conflicts }
      : total,
    lines: data,
    meta: { cursor: matched.length > q.limit ? data.at(-1)!.id : null },
  };
}
export async function createStocktake(c: PoolClient, a: Actor, b: z.infer<typeof stocktakeInput>) {
  ensure(a.role === 'admin', 403, 'Spis tworzy administrator');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'stocktakes:' + a.tenantId,
  ]);
  const hash = digest(b),
    old = (await c.query('SELECT * FROM stocktakes WHERE client_key=$1', [b.client_key])).rows[0];
  if (old) {
    ensure(old.input_hash === hash, 409, 'Klucz spisu ma inny zakres');
    return old;
  }
  await assertWmsLegacyQuantityWriteInTx(c, a);
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=$1', [b.warehouse_id])).rowCount,
    404,
    'Nie znaleziono magazynu',
  );
  ensure(
    (await c.query("SELECT count(*)::int n FROM stocktakes WHERE state IN ('counting','review')"))
      .rows[0].n < 20,
    422,
    'Limit 20 otwartych spisów',
  );
  const id = randomUUID();
  await c.query(
    'INSERT INTO stocktakes(id,tenant_id,warehouse_id,name,location_prefix,blind,created_by,client_key,input_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      id,
      a.tenantId,
      b.warehouse_id,
      b.name,
      b.location_prefix,
      b.blind,
      a.userId,
      b.client_key,
      hash,
    ],
  );
  // A deleted product (225) is never counted again.
  const deletions = await productDeletionsAvailable(c);
  const inserted = await c.query(
    `INSERT INTO stocktake_lines(tenant_id,stocktake_id,product_id,sku,name,location,original_quantity,basis_quantity,basis_version)
 SELECT l.tenant_id,$1,l.product_id,p.sku,p.name,l.location,l.quantity,l.quantity,s.version FROM stock_locations l JOIN products p ON (p.tenant_id,p.id)=(l.tenant_id,l.product_id) JOIN stock s ON (s.tenant_id,s.warehouse_id,s.product_id)=(l.tenant_id,l.warehouse_id,l.product_id) WHERE l.warehouse_id=$2 AND starts_with(l.location,$3) AND p.kind IN ('simple','variant') AND ${productNotDeletedSQL(deletions)} ORDER BY l.product_id,l.location LIMIT 2001`,
    [id, b.warehouse_id, b.location_prefix],
  );
  ensure(
    inserted.rowCount && inserted.rowCount <= 2000,
    422,
    'Zakres musi zawierać 1–2000 pozycji; zawęź lokalizacje',
  );
  await audit(c, a, 'stocktake.create', id, {
    lines: inserted.rowCount,
    warehouse_id: b.warehouse_id,
    blind: b.blind,
  });
  return stocktakeHeader(c, id);
}
export async function countStocktake(
  c: PoolClient,
  a: Actor,
  id: string,
  b: z.infer<typeof stocktakeCount>,
  actorName: string,
) {
  ensure(['admin', 'operator'].includes(a.role), 403, 'Brak prawa liczenia');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'stocktake-measure:' + a.tenantId + ':' + b.client_key,
  ]);
  const d = await stocktakeHeader(c, id, true),
    hash = digest({ id, ...b, lines: [...b.lines].sort((x, y) => x.id.localeCompare(y.id)) }),
    old = (
      await c.query('SELECT * FROM stocktake_measurements WHERE client_key=$1', [b.client_key])
    ).rows[0];
  if (old) {
    if (
      (await c.query("SELECT to_regclass('public.stocktake_scan_receipts') IS NOT NULL available"))
        .rows[0].available
    ) {
      ensure(
        !(
          await c.query('SELECT 1 FROM stocktake_scan_receipts WHERE quantity_measurement_id=$1', [
            old.id,
          ])
        ).rowCount,
        409,
        'Pomiar skanu można ponowić wyłącznie przez jego dowód skanu',
      );
    }
    ensure(
      old.input_hash === hash && old.actor_id === a.userId,
      409,
      'Klucz pomiaru ma inny zakres',
    );
    return { ...old.result, reused: true };
  }
  ensure(d.state === 'counting', 409, 'Spis nie jest w fazie liczenia');
  const ids = b.lines.map((l) => l.id),
    lines = (
      await c.query(
        'SELECT * FROM stocktake_lines WHERE stocktake_id=$1 AND id=ANY($2::uuid[]) ORDER BY product_id,location FOR UPDATE',
        [id, ids],
      )
    ).rows;
  ensure(lines.length === ids.length, 404, 'Pozycja nie należy do spisu');
  await c.query(
    'SELECT product_id FROM stock WHERE warehouse_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id FOR SHARE',
    [d.warehouse_id, lines.map((l) => l.product_id)],
  );
  const current = (
    await c.query(lineSql + ' AND l.id=ANY($2::uuid[]) ORDER BY l.product_id,l.location', [id, ids])
  ).rows;
  for (const l of current) {
    const v = b.lines.find((v) => v.id === l.id)!;
    ensure(l.version === v.version, 409, 'Pozycja została już przeliczona przez inną osobę');
    ensure(
      l.current_stock_version === v.expected_stock_version,
      409,
      'Stan zmienił się podczas liczenia; przelicz ponownie',
    );
    await c.query(
      'UPDATE stocktake_lines SET counted=$2,basis_quantity=$3,basis_version=$4,counted_by=$5,counted_at=clock_timestamp(),version=version+1 WHERE id=$1',
      [l.id, v.quantity, l.current_quantity, l.current_stock_version, a.userId],
    );
  }
  const result = (
    await c.query('UPDATE stocktakes SET version=version+1 WHERE id=$1 RETURNING id,version', [id])
  ).rows[0];
  await c.query(
    'INSERT INTO stocktake_measurements(id,tenant_id,stocktake_id,actor_id,client_key,input_hash,inputs,result,note,actor_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      randomUUID(),
      a.tenantId,
      id,
      a.userId,
      b.client_key,
      hash,
      JSON.stringify(b.lines),
      JSON.stringify({ ...result, updated: lines.length }),
      b.note,
      actorName,
    ],
  );
  await audit(c, a, 'stocktake.count', id, { lines: lines.length });
  return { ...result, updated: lines.length };
}
export async function transitionStocktake(
  c: PoolClient,
  a: Actor,
  id: string,
  b: z.infer<typeof stocktakeVersion>,
  action: 'review' | 'reopen' | 'cancel' | 'post',
) {
  ensure(a.role === 'admin', 403, 'Spis rozlicza administrator');
  if (action === 'post') await assertWmsLegacyQuantityWriteInTx(c, a);
  const d = await stocktakeHeader(c, id, true);
  if (
    (action === 'post' && d.state === 'posted') ||
    (action === 'cancel' && d.state === 'cancelled')
  )
    return d;
  ensure(d.version === b.version, 409, 'Spis zmienił się; odśwież dane');
  ensure(['counting', 'review'].includes(d.state), 409, 'Spis jest zamknięty');
  if (action === 'reopen') {
    ensure(d.state === 'review', 409, 'Spis nie jest w przeglądzie');
    await c.query(
      "UPDATE stocktakes SET state='counting',review_hash=NULL,version=version+1 WHERE id=$1",
      [id],
    );
  } else if (action === 'cancel')
    await c.query("UPDATE stocktakes SET state='cancelled',version=version+1 WHERE id=$1", [id]);
  else {
    ensure(
      d.state === (action === 'post' ? 'review' : 'counting'),
      409,
      'Nieprawidłowa faza spisu',
    );
    // Same SKU order as reservation, shipment and warehouse document writers.
    await c.query(
      'SELECT product_id FROM stock WHERE warehouse_id=$1 AND product_id IN (SELECT product_id FROM stocktake_lines WHERE stocktake_id=$2) ORDER BY product_id FOR UPDATE',
      [d.warehouse_id, id],
    );
    const lines = await allLines(c, id),
      s = summary(lines);
    ensure(s.counted === s.total, 409, 'Policz wszystkie pozycje, także z wynikiem zero');
    ensure(
      !s.conflicts,
      409,
      'Ruch lub rezerwacja po pomiarze; wróć do liczenia i przelicz zmienione SKU',
    );
    ensure(
      !s.below_reserved,
      409,
      'Wynik poniżej rezerwacji lokalizacji; wyjaśnij różnicę przed rozliczeniem',
    );
    const deltas = new Map<string, number>();
    for (const l of lines)
      deltas.set(l.product_id, (deltas.get(l.product_id) ?? 0) + l.counted - l.basis_quantity);
    ensure(
      lines.every((l) => l.warehouse_on_hand + (deltas.get(l.product_id) ?? 0) <= 2147483647),
      409,
      'Stan po korekcie przekracza limit',
    );
    const hash = receiptHash(lines);
    if (action === 'review')
      await c.query(
        "UPDATE stocktakes SET state='review',review_hash=$2,version=version+1 WHERE id=$1",
        [id, hash],
      );
    else {
      ensure(d.review_hash === hash, 409, 'Pomiar zmienił się od przeglądu');
      await c.query(
        `INSERT INTO stock_location_movements(tenant_id,warehouse_id,product_id,location,delta,kind,operation_id,note,stocktake_id) SELECT tenant_id,$2,product_id,location,counted-basis_quantity,'stocktake',$1,$3,$1 FROM stocktake_lines WHERE stocktake_id=$1 AND counted<>basis_quantity`,
        [id, d.warehouse_id, d.name],
      );
      await c.query(
        `UPDATE stock_locations b SET quantity=l.counted FROM stocktake_lines l WHERE l.stocktake_id=$1 AND (b.tenant_id,b.warehouse_id,b.product_id,b.location)=(l.tenant_id,$2,l.product_id,l.location) AND l.counted<>l.basis_quantity`,
        [id, d.warehouse_id],
      );
      await c.query(
        `INSERT INTO stock_movements(id,tenant_id,warehouse_id,product_id,delta,kind,note,stocktake_id) SELECT gen_random_uuid(),tenant_id,$2,product_id,sum(counted-basis_quantity)::int,'stocktake',$3,$1 FROM stocktake_lines WHERE stocktake_id=$1 GROUP BY tenant_id,product_id HAVING sum(counted-basis_quantity)<>0`,
        [id, d.warehouse_id, d.name],
      );
      await c.query(
        `UPDATE stock s SET on_hand=s.on_hand+v.delta FROM (SELECT tenant_id,product_id,sum(counted-basis_quantity)::int delta FROM stocktake_lines WHERE stocktake_id=$1 GROUP BY tenant_id,product_id HAVING bool_or(counted<>basis_quantity))v WHERE (s.tenant_id,s.warehouse_id,s.product_id)=(v.tenant_id,$2,v.product_id)`,
        [id, d.warehouse_id],
      );
      await c.query(
        "UPDATE stocktakes SET state='posted',posted_at=now(),posted_by=$2,version=version+1 WHERE id=$1",
        [id, a.userId],
      );
    }
  }
  await audit(c, a, 'stocktake.' + action, id, {});
  return stocktakeHeader(c, id);
}

/** Caller has catalogue admission and any measurement advisory before the header lock. */
export async function quantityStocktakeScanBasisInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  lineIds: string[],
  write = false,
) {
  const h = await stocktakeHeader(c, id, write);
  const ls = (
    await c.query(
      `SELECT * FROM stocktake_lines WHERE stocktake_id=$1 AND id=ANY($2::uuid[]) ORDER BY product_id,location COLLATE "C",id ${write ? 'FOR UPDATE' : 'FOR SHARE'}`,
      [id, lineIds],
    )
  ).rows;
  ensure(ls.length === lineIds.length, 404, 'Pozycja nie należy do spisu');
  const ids = [...new Set(ls.map((l) => l.product_id))].sort();
  await c.query('SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [ids]);
  await c.query(
    'SELECT product_id FROM stock WHERE warehouse_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id FOR SHARE',
    [h.warehouse_id, ids],
  );
  await c.query(
    `SELECT product_id FROM stock_locations WHERE warehouse_id=$1 AND EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb)x(product_id uuid,location text) WHERE (x.product_id,x.location)=(stock_locations.product_id,stock_locations.location)) ORDER BY product_id,location COLLATE "C" FOR SHARE`,
    [
      h.warehouse_id,
      JSON.stringify(ls.map((l) => ({ product_id: l.product_id, location: l.location }))),
    ],
  );
  const live = (
    await c.query(lineSql + ' AND l.id=ANY($2::uuid[]) ORDER BY l.product_id,l.location', [
      id,
      lineIds,
    ])
  ).rows;
  ensure(live.length === ls.length, 409, 'Fizyczna pozycja nie istnieje');
  const reservations = (
    await c.query(
      `SELECT a.order_id,a.product_id,a.location,a.quantity,a.scanned,r.state FROM reservation_locations a JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id) WHERE a.warehouse_id=$1 AND a.product_id=ANY($2::uuid[]) ORDER BY a.product_id,a.location COLLATE "C",a.order_id`,
      [h.warehouse_id, ids],
    )
  ).rows;
  return {
    header: h,
    lines: live,
    entries: new Map(
      live.map((l) => [
        l.id,
        {
          basis: {
            stock: { version: l.current_stock_version, on_hand: l.warehouse_on_hand },
            bin: { quantity: l.current_quantity },
            reservations: reservations.filter(
              (r) => r.product_id === l.product_id && r.location === l.location,
            ),
          },
        },
      ]),
    ),
  };
}
/** Single absolute measurement, with additive before/after proof for the linked immutable scan. */
export async function applyQuantityStocktakeScanCountInTx(
  c: PoolClient,
  a: Actor,
  prepared: Awaited<ReturnType<typeof quantityStocktakeScanBasisInTx>>,
  input: { client_key: string; quantity: number; note: string; basis_hash: string },
) {
  const h = prepared.header,
    l = prepared.lines[0];
  ensure(
    prepared.lines.length === 1 && h.state === 'counting',
    409,
    'Spis nie jest w fazie liczenia',
  );
  await assertWmsLegacyQuantityWriteInTx(c, a);
  ensure(
    BigInt(l.version) < 9223372036854775807n && BigInt(h.version) < 9223372036854775807n,
    422,
    'Wyczerpano wersje pomiaru',
  );
  ensure(
    !(
      await c.query(
        'SELECT 1 FROM stocktake_measurements WHERE client_key=$1 UNION ALL SELECT 1 FROM stocktakes WHERE client_key=$1',
        [input.client_key],
      )
    ).rowCount,
    409,
    'Klucz wewnętrznego pomiaru jest zajęty',
  );
  const mid = randomUUID(),
    lv = (BigInt(l.version) + 1n).toString(),
    v = (BigInt(h.version) + 1n).toString();
  const lines = [
    {
      id: l.id,
      version: l.version,
      expected_stock_version: l.current_stock_version,
      quantity: input.quantity,
    },
  ];
  const result = {
    id: h.id,
    version: v,
    updated: 1,
    lines: [
      {
        line_id: l.id,
        previous_count: l.counted,
        before_version: l.version,
        version: lv,
        counted: input.quantity,
        basis_hash: input.basis_hash,
      },
    ],
  };
  await c.query(
    'UPDATE stocktake_lines SET counted=$2,basis_quantity=$3,basis_version=$4,counted_by=$5,counted_at=clock_timestamp(),version=$6 WHERE id=$1',
    [l.id, input.quantity, l.current_quantity, l.current_stock_version, a.userId, lv],
  );
  await c.query('UPDATE stocktakes SET version=$2 WHERE id=$1', [h.id, v]);
  await c.query(
    'INSERT INTO stocktake_measurements(id,tenant_id,stocktake_id,actor_id,client_key,input_hash,inputs,result,note,actor_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      mid,
      a.tenantId,
      h.id,
      a.userId,
      input.client_key,
      digest({ id: h.id, client_key: input.client_key, note: input.note, lines }),
      JSON.stringify(lines),
      JSON.stringify(result),
      input.note,
      'Skan fizyczny',
    ],
  );
  await audit(c, a, 'stocktake.count', h.id, { lines: 1 });
  return { measurement_id: mid, stocktake_version: v, after_line_version: lv };
}
