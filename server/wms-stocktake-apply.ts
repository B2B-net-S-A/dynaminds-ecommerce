import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ensure } from './errors';
import { wmsLotsHash, wmsLotsPolicyInTx } from './wms-lots';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import type { WmsActor } from './wms-lots-schema';
import { wmsCostValue, WMS_INT64_MAX } from './wms-lots-values';

export type WmsStocktakeApplyRow = {
  line_id: string;
  product_id: string;
  location: string;
  lot: { id: string | null; lot_code: string; expiry_date: string | null };
  before_quantity: number;
  after_quantity: number;
  fragments: {
    layer_id: string | null;
    quantity: number;
    delta: number;
    unit_cost_minor: string | null;
    currency: string;
  }[];
};
export type WmsStocktakeApply = {
  stocktake_id: string;
  posting_id: string;
  review_id: string;
  client_key: string;
  policy_version: string;
  warehouse_id: string;
  request: unknown;
  rows: WmsStocktakeApplyRow[];
};

const integer = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647;
const signed = (n: bigint) => {
  ensure(n >= -WMS_INT64_MAX && n <= WMS_INT64_MAX, 422, 'Suma korekty przekracza int64');
  return n.toString();
};
const batches = <T>(items: T[]): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += 100) result.push(items.slice(i, i + 100));
  return result;
};

/** Caller owns admission, header and exact physical fences; managed TX checks actors last. */
export async function applyWmsStocktakeInTx(
  c: PoolClient,
  actor: WmsActor,
  input: WmsStocktakeApply,
) {
  const a = enlistWmsActorInTx(c, actor, { cost: true, adminOnly: true });
  const policy = await wmsLotsPolicyInTx(c);
  ensure(
    policy.enabled && policy.version === input.policy_version,
    409,
    'Polityka WMS zmieniła się',
  );
  ensure(input.rows.length <= 10000, 422, 'Za dużo pozycji spisu');
  const seen = new Set<string>();
  const identities = new Set<string>();
  const newLots = new Map<
    string,
    { id: string; product_id: string; lot_code: string; expiry_date: string | null }
  >();
  const changes: any[] = [];
  const layers: any[] = [];
  const resultRows: any[] = [];
  const productDeltas = new Map<string, number>();
  const binDeltas = new Map<string, { product_id: string; location: string; delta: number }>();
  const positions = new Set<string>();
  let known = 0n,
    unknown = 0n,
    incoming = 0n,
    outgoing = 0n;
  for (const row of input.rows) {
    ensure(!seen.has(row.line_id), 422, 'Powtórzona pozycja spisu');
    seen.add(row.line_id);
    ensure(
      integer(row.before_quantity) && integer(row.after_quantity),
      422,
      'Nieprawidłowa ilość spisu',
    );
    ensure(
      row.location.length > 0 &&
        row.location.length <= 80 &&
        !/[\u0000-\u001f\u007f]/.test(row.location),
      422,
      'Nieprawidłowy bin',
    );
    const identity = JSON.stringify([
      row.product_id,
      row.location,
      row.lot.id ?? [row.lot.lot_code, row.lot.expiry_date],
    ]);
    ensure(!identities.has(identity), 422, 'Powtórzona fizyczna pozycja partii');
    identities.add(identity);
    const delta = row.after_quantity - row.before_quantity;
    ensure(
      row.fragments.reduce((sum, f) => sum + f.delta, 0) === delta,
      409,
      'Fragmenty nie pokrywają różnicy spisu',
    );
    ensure(delta !== 0 || row.fragments.length === 0, 409, 'Brak różnicy wymaga pustego planu');
    let lotId = row.lot.id;
    if (delta > 0 && !lotId) {
      const lotKey = JSON.stringify([row.product_id, row.lot.lot_code, row.lot.expiry_date]);
      if (!newLots.has(lotKey))
        newLots.set(lotKey, {
          id: randomUUID(),
          product_id: row.product_id,
          lot_code: row.lot.lot_code,
          expiry_date: row.lot.expiry_date,
        });
      lotId = newLots.get(lotKey)!.id;
    }
    const fragments: any[] = [];
    for (const fragment of row.fragments) {
      ensure(
        integer(fragment.quantity) &&
          fragment.quantity > 0 &&
          Math.abs(fragment.delta) === fragment.quantity,
        422,
        'Nieprawidłowy fragment korekty',
      );
      ensure(Math.sign(fragment.delta) === Math.sign(delta), 409, 'Fragment ma inny kierunek');
      ensure(fragment.currency === policy.currency, 409, 'Waluta korekty różni się od polityki');
      ensure(
        delta < 0
          ? fragment.layer_id !== null && row.lot.id !== null
          : fragment.layer_id === null && fragment.unit_cost_minor !== null,
        409,
        'Niedobór wymaga starej warstwy, nadwyżka jawnego kosztu',
      );
      const value = wmsCostValue(fragment.quantity, fragment.unit_cost_minor);
      const valueDelta =
        fragment.unit_cost_minor === null
          ? null
          : signed(BigInt(value.known_minor) * BigInt(Math.sign(delta)));
      known += BigInt(value.known_minor) * BigInt(Math.sign(delta));
      unknown += BigInt(value.unknown_quantity) * BigInt(Math.sign(delta));
      if (delta > 0) incoming += BigInt(fragment.quantity);
      else outgoing += BigInt(fragment.quantity);
      const layerId = fragment.layer_id ?? randomUUID();
      const position = JSON.stringify([row.product_id, row.location, layerId]);
      ensure(!positions.has(position), 409, 'Warstwa występuje w planie więcej niż raz');
      positions.add(position);
      const change = {
        id: randomUUID(),
        line_id: row.line_id,
        product_id: row.product_id,
        location: row.location,
        lot_id: lotId,
        layer_id: layerId,
        quantity: fragment.quantity,
        delta: fragment.delta,
        unit_cost_minor: fragment.unit_cost_minor,
        currency: fragment.currency,
        value_delta: valueDelta,
      };
      changes.push(change);
      fragments.push(change);
      if (delta > 0) layers.push(change);
    }
    resultRows.push({
      line_id: row.line_id,
      product_id: row.product_id,
      location: row.location,
      lot_id: lotId,
      delta,
      fragments,
    });
    if (delta !== 0) {
      productDeltas.set(row.product_id, (productDeltas.get(row.product_id) ?? 0) + delta);
      const binKey = JSON.stringify([row.product_id, row.location]);
      const bin = binDeltas.get(binKey) ?? {
        product_id: row.product_id,
        location: row.location,
        delta: 0,
      };
      bin.delta += delta;
      binDeltas.set(binKey, bin);
    }
  }
  ensure(changes.length <= 10000, 422, 'Za dużo fragmentów korekty');
  const products = [...productDeltas.keys()].sort();
  const bins = [...binDeltas.values()].sort(
    (x, y) =>
      x.product_id.localeCompare(y.product_id) ||
      Buffer.compare(Buffer.from(x.location), Buffer.from(y.location)),
  );
  if (products.length) {
    const current = (
      await c.query(
        'SELECT product_id,on_hand,reserved FROM stock WHERE warehouse_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id FOR UPDATE',
        [input.warehouse_id, products],
      )
    ).rows;
    const byProduct = new Map(current.map((r) => [r.product_id, r]));
    for (const product of products) {
      const stock = byProduct.get(product);
      const after = (stock?.on_hand ?? 0) + productDeltas.get(product)!;
      ensure(integer(after), 422, 'Łączna ilość produktu po korekcie przekracza int32');
      ensure(after >= (stock?.reserved ?? 0), 409, 'Korekta narusza rezerwacje produktu');
    }
    const currentBins = (
      await c.query(
        `SELECT b.product_id,b.location,b.quantity FROM stock_locations b
      JOIN jsonb_to_recordset($2::jsonb) r(product_id uuid,location text) ON (b.product_id,b.location)=(r.product_id,r.location)
      WHERE b.warehouse_id=$1 ORDER BY b.product_id,b.location COLLATE "C" FOR UPDATE OF b`,
        [input.warehouse_id, JSON.stringify(bins)],
      )
    ).rows;
    const byBin = new Map(
      currentBins.map((r) => [JSON.stringify([r.product_id, r.location]), r.quantity]),
    );
    for (const bin of bins)
      ensure(
        integer((byBin.get(JSON.stringify([bin.product_id, bin.location])) ?? 0) + bin.delta),
        422,
        'Łączna ilość lokalizacji po korekcie przekracza int32',
      );
  }
  const operationId = randomUUID();
  const result = {
    stocktake_id: input.stocktake_id,
    posting_id: input.posting_id,
    review_id: input.review_id,
    changed: resultRows.filter((r) => r.delta !== 0).length,
    summary: {
      currency: policy.currency,
      known_delta_minor: signed(known),
      unknown_delta_quantity: signed(unknown),
      incoming_quantity: signed(incoming),
      outgoing_quantity: signed(outgoing),
    },
    rows: resultRows,
  };
  const request = {
    stocktake_id: input.stocktake_id,
    posting_id: input.posting_id,
    review_id: input.review_id,
    body: input.request,
  };
  ensure(
    Buffer.byteLength(JSON.stringify(result), 'utf8') <= 5 * 1024 * 1024,
    413,
    'Wynik korekty przekracza limit',
  );
  const source = a.source ?? 'manual';
  await c.query(
    `INSERT INTO wms_operations(id,tenant_id,actor_id,client_key,request_hash,kind,source,policy_version,request,result,stocktake_id,stocktake_posting_id,stocktake_review_id)
    VALUES($1,$2,$3,$4,$5,'stocktake_post',$6,$7,$8,$9,$10,$11,$12)`,
    [
      operationId,
      a.tenantId,
      a.userId,
      input.client_key,
      wmsLotsHash({ actor_id: a.userId, source, kind: 'stocktake_post', request }),
      source,
      input.policy_version,
      request,
      result,
      input.stocktake_id,
      input.posting_id,
      input.review_id,
    ],
  );

  for (const part of batches(products))
    await c.query(
      `INSERT INTO stock(tenant_id,warehouse_id,product_id) SELECT $1,$2,id FROM unnest($3::uuid[]) id ORDER BY id ON CONFLICT DO NOTHING`,
      [a.tenantId, input.warehouse_id, part],
    );
  for (const part of batches(bins))
    await c.query(
      `INSERT INTO stock_locations(tenant_id,warehouse_id,product_id,location,quantity)
      SELECT $1,$2,r.product_id,r.location,0 FROM jsonb_to_recordset($3::jsonb) r(product_id uuid,location text) ORDER BY r.product_id,r.location COLLATE "C" ON CONFLICT DO NOTHING`,
      [a.tenantId, input.warehouse_id, JSON.stringify(part)],
    );
  for (const part of batches([...newLots.values()]))
    await c.query(
      `INSERT INTO wms_lots(id,tenant_id,product_id,operation_id,lot_code,origin,expiry_date)
      SELECT r.id,$1,r.product_id,$2,r.lot_code,'adjustment',r.expiry_date FROM jsonb_to_recordset($3::jsonb) r(id uuid,product_id uuid,lot_code text,expiry_date date)`,
      [a.tenantId, operationId, JSON.stringify(part)],
    );
  for (const part of batches(layers)) {
    await c.query(
      `INSERT INTO wms_cost_layers(id,tenant_id,lot_id,product_id,operation_id,quantity_received,unit_cost_minor,currency,exponent,stocktake_line_id)
      SELECT r.layer_id,$1,r.lot_id,r.product_id,$2,r.quantity,r.unit_cost_minor,r.currency,2,r.line_id FROM jsonb_to_recordset($3::jsonb) r(layer_id uuid,lot_id uuid,product_id uuid,quantity integer,unit_cost_minor bigint,currency text,line_id uuid)`,
      [a.tenantId, operationId, JSON.stringify(part)],
    );
    await c.query(
      `INSERT INTO wms_layer_positions(tenant_id,warehouse_id,product_id,location,layer_id,quantity)
      SELECT $1,$2,r.product_id,r.location,r.layer_id,r.quantity FROM jsonb_to_recordset($3::jsonb) r(product_id uuid,location text,layer_id uuid,quantity integer)`,
      [a.tenantId, input.warehouse_id, JSON.stringify(part)],
    );
  }
  for (const part of batches(changes.filter((f) => f.delta < 0))) {
    const written = await c.query(
      `UPDATE wms_layer_positions p SET quantity=p.quantity+r.delta,version=p.version+1
      FROM jsonb_to_recordset($3::jsonb) r(layer_id uuid,product_id uuid,location text,delta integer,lot_id uuid,unit_cost_minor bigint,currency text)
      JOIN wms_cost_layers l ON (l.tenant_id,l.id,l.product_id,l.lot_id)=($1::uuid,r.layer_id,r.product_id,r.lot_id)
      WHERE (p.tenant_id,p.warehouse_id,p.product_id,p.location,p.layer_id)=($1::uuid,$2::uuid,r.product_id,r.location,r.layer_id)
      AND p.quantity+r.delta>=p.reserved AND (l.unit_cost_minor,l.currency) IS NOT DISTINCT FROM (r.unit_cost_minor,r.currency)
      RETURNING p.layer_id`,
      [a.tenantId, input.warehouse_id, JSON.stringify(part)],
    );
    ensure(
      written.rowCount === part.length,
      409,
      'Stan, koszt lub rezerwacja warstwy zmieniły się',
    );
  }
  for (const part of batches(changes))
    await c.query(
      `INSERT INTO wms_layer_movements(id,tenant_id,operation_id,warehouse_id,product_id,location,layer_id,delta,value_delta,kind)
      SELECT r.id,$1,$2,$3,r.product_id,r.location,r.layer_id,r.delta,r.value_delta,'stocktake' FROM jsonb_to_recordset($4::jsonb) r(id uuid,product_id uuid,location text,layer_id uuid,delta integer,value_delta bigint)`,
      [a.tenantId, operationId, input.warehouse_id, JSON.stringify(part)],
    );
  for (const part of batches(bins.filter((b) => b.delta !== 0))) {
    await c.query(
      `UPDATE stock_locations b SET quantity=b.quantity+r.delta FROM jsonb_to_recordset($3::jsonb) r(product_id uuid,location text,delta integer)
      WHERE (b.tenant_id,b.warehouse_id,b.product_id,b.location)=($1::uuid,$2::uuid,r.product_id,r.location)`,
      [a.tenantId, input.warehouse_id, JSON.stringify(part)],
    );
    await c.query(
      `INSERT INTO stock_location_movements(tenant_id,warehouse_id,product_id,location,delta,kind,operation_id,note)
      SELECT $1,$2,r.product_id,r.location,r.delta,'wms_stocktake',$3,$4 FROM jsonb_to_recordset($5::jsonb) r(product_id uuid,location text,delta integer)`,
      [
        a.tenantId,
        input.warehouse_id,
        operationId,
        'Inwentaryzacja WMS ' + input.stocktake_id,
        JSON.stringify(part),
      ],
    );
  }
  for (const part of batches(
    products.map((product_id) => ({ product_id, delta: productDeltas.get(product_id)! })),
  )) {
    await c.query(
      `UPDATE stock s SET on_hand=s.on_hand+r.delta FROM jsonb_to_recordset($3::jsonb) r(product_id uuid,delta integer)
      WHERE (s.tenant_id,s.warehouse_id,s.product_id)=($1::uuid,$2::uuid,r.product_id)`,
      [a.tenantId, input.warehouse_id, JSON.stringify(part)],
    );
    await c.query(
      `INSERT INTO stock_movements(id,tenant_id,warehouse_id,product_id,delta,kind,note)
      SELECT gen_random_uuid(),$1,$2,r.product_id,r.delta,'wms_stocktake',$3 FROM jsonb_to_recordset($4::jsonb) r(product_id uuid,delta integer) WHERE r.delta<>0`,
      [
        a.tenantId,
        input.warehouse_id,
        'Inwentaryzacja WMS ' + input.stocktake_id,
        JSON.stringify(part),
      ],
    );
  }
  return { operation_id: operationId, result };
}
