import { originalRecoveryParams, intentRecoveryQuery, originalRecoveryEntity, checkedOriginalRecovery } from './original-key-recovery';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  audit,
  createOrder,
  cancelOrder,
  getOrder,
  orderSchema,
  event,
  type Actor,
} from './domain';
import { ensure, Problem } from './errors';
import { networkTx } from './b2b-network';
import {
  b2bDropshipAccessInTx,
  b2bDropshipProject,
  b2bNetworkDropshippingAvailable,
} from './b2b-network-dropshipping';
import { wmsLotsHash } from './wms-lots';
import { paymentBalance } from './payments';
import { assertB2bExternalCommercialSnapshotInTx } from './b2b-external-order-intent-preconditions';
import * as S from './b2b-external-order-intents-schema';
export * from './b2b-external-order-intents-schema';
export { registerB2bExternalOrderIntentRoutes } from './b2b-external-order-intents-routes';
type Row = Record<string, any>;
export async function b2bExternalOrderIntentsAvailable(c: Pool | PoolClient) {
  return (
    Boolean(
      (
        await c.query(
          `SELECT bool_and(to_regclass('public.'||n) IS NOT NULL) AND to_regprocedure('public.b2b_external_intent_complete()') IS NOT NULL AND to_regprocedure('public.b2b_external_allocate(uuid,uuid,uuid,jsonb,boolean)') IS NOT NULL AND to_regprocedure('public.b2b_external_create_proof(uuid,uuid)') IS NOT NULL AND to_regprocedure('public.b2b_external_intent_installed()') IS NOT NULL AND to_regprocedure('public.b2b_external_intent_fulfilled(uuid)') IS NOT NULL AND to_regprocedure('public.b2b_external_fields_write_allowed(uuid,uuid,boolean)') IS NOT NULL available FROM unnest(ARRAY['b2b_external_order_intents','b2b_external_order_intent_revisions','b2b_external_order_allocation_proofs','b2b_external_order_created_orders']) n`,
        )
      ).rows[0].available,
    ) && (await b2bNetworkDropshippingAvailable(c))
  );
}
const hash = (a: Actor, kind: string, id: string, body: unknown) =>
  wmsLotsHash({
    tenant_id: a.tenantId,
    actor_id: a.userId,
    api_key_id: a.apiKeyId ?? null,
    kind,
    id,
    body,
  });
async function canWriteFields(c: PoolClient, a: Actor, pin = false) {
  return (
    !a.apiKeyId ||
    Boolean(
      (
        await c.query('SELECT b2b_external_fields_write_allowed($1,$2,$3) valid', [
          a.userId,
          a.apiKeyId,
          pin,
        ])
      ).rows[0]?.valid,
    )
  );
}
async function fieldAccess(c: PoolClient, a: Actor, needed: boolean, pin = false) {
  if (needed)
    ensure(await canWriteFields(c, a, pin), 403, 'Brak bieżącego scope order-fields:write');
}
async function tx<T>(a: Actor, write: boolean, fn: (c: PoolClient) => Promise<T>, fields = false) {
  try {
    return await networkTx(a.tenantId, async (c) => {
      await c.query("SET LOCAL TIME ZONE 'UTC'");
      await b2bDropshipAccessInTx(c, a, write);
      ensure(
        await b2bExternalOrderIntentsAvailable(c),
        503,
        'Kopia nie obsługuje zewnętrznych intencji zamówień',
      );
      if (write) {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'b2b.external.intent.proof:' + a.tenantId,
        ]);
        await fieldAccess(c, a, fields);
      }
      const result = await fn(c);
      if (write) await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      const flags = await b2bDropshipAccessInTx(c, a, write, true);
      await fieldAccess(c, a, fields, true);
      const canFields = await canWriteFields(c, a);
      return {
        ...b2bDropshipProject(result, flags.can_read_value),
        ...flags,
        can_write_fields: flags.can_manage && canFields,
      };
    });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === '23514' && e.message === 'Brak aktualnej zgody administratora')
      throw new Problem(403, 'Administrator utracił uprawnienia');
    if (
      e.code === '23514' &&
      [
        'Za mało własnego towaru dla lokalnego przydziału',
        'Brak dostępnych pojemników lub warstw dla przydziału',
        'Przydział narusza zeskanowaną lub fizyczną ilość',
        'Przydział narusza zeskanowaną warstwę',
        'Przydział narusza zeskanowany pojemnik',
      ].includes(e.message ?? '')
    )
      throw new Problem(409, e.message!);
    if (
      e.code === 'P0001' &&
      [
        'Limit historii intencji realizacji',
        'Limit rozmiaru historii intencji realizacji',
      ].includes(e.message ?? '')
    )
      throw new Problem(429, e.message!);
    throw error;
  }
}
async function own(c: PoolClient, orderId: string, required = true) {
  const order = (await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
  ensure(order, 404, 'Nie znaleziono własnego zamówienia');
  const h = (
    await c.query('SELECT * FROM b2b_external_order_intents WHERE order_id=$1 FOR UPDATE', [
      orderId,
    ])
  ).rows[0];
  if (required) ensure(h, 404, 'Nie znaleziono intencji zamówienia');
  return { order, h };
}
async function validateAllocations(c: PoolClient, h: Row, alloc: Row[], reopening = false) {
  ensure(alloc.length === h.original_items.length, 422, 'Przydziel wszystkie pozycje');
  for (const item of h.original_items) {
    const v = alloc.find((v) => v.customer_item_id === item.id);
    ensure(
      v && v.local_quantity + v.external_quantity + v.unassigned_quantity === item.quantity,
      422,
      'Suma przydziałów nie odpowiada ilości handlowej',
    );
  }
  if (!reopening) {
    const counted = (
      await c.query('SELECT id,scanned FROM order_items WHERE order_id=$1', [h.order_id])
    ).rows;
    ensure(
      counted.every((i) =>
        alloc.some((v) => v.customer_item_id === i.id && v.local_quantity >= i.scanned),
      ),
      409,
      'Nie można odebrać lokalnej ilości zeskanowanej pozycji',
    );
  }
  const links = [...new Set(alloc.filter((v) => v.link_id).map((v) => v.link_id))].sort();
  if (links.length) {
    const ls = (
      await c.query('SELECT * FROM b2b_links WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [
        links,
      ])
    ).rows;
    ensure(
      ls.length === links.length && ls.every((l) => !l.paused),
      409,
      'Połączenie dostawcy jest nieaktywne lub obce',
    );
  }
  const committed = (
    await c.query(
      "SELECT l.customer_item_id,d.link_id,sum(l.quantity)::int quantity FROM b2b_dropship_lines l JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(l.tenant_id,l.order_id) WHERE l.customer_order_id=$1 AND d.state='ordered' GROUP BY l.customer_item_id,d.link_id",
      [h.order_id],
    )
  ).rows;
  ensure(
    committed.every((v) =>
      alloc.some(
        (a) =>
          a.customer_item_id === v.customer_item_id &&
          a.link_id === v.link_id &&
          a.external_quantity >= v.quantity,
      ),
    ),
    409,
    'Najpierw anuluj zleconą dostawę',
  );
}
const snapshot = (h: Row) => ({ version: h.version, state: h.state, allocations: h.allocations });
async function view(c: PoolClient, h: Row) {
  const fulfill = (await c.query('SELECT b2b_dropship_fulfillment($1) rows', [h.order_id])).rows[0]
    .rows as Row[];
  const dispatched = fulfill.filter((v) => v.dispatched && v.state === 'ordered').map((v) => v.id);
  const committed = (
    await c.query(
      "SELECT l.customer_item_id,sum(l.quantity)::int quantity,coalesce(sum(l.quantity) FILTER(WHERE d.id=ANY($2::uuid[])),0)::int dispatched FROM b2b_dropship_lines l JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(l.tenant_id,l.order_id) WHERE l.customer_order_id=$1 AND d.state='ordered' GROUP BY l.customer_item_id",
      [h.order_id, dispatched],
    )
  ).rows;
  return {
    id: h.id,
    order_id: h.order_id,
    version: h.version,
    state: h.state,
    created_at: h.created_at,
    updated_at: h.updated_at,
    items: h.original_items.map((i: Row) => {
      const a = h.allocations.find((a: Row) => a.customer_item_id === i.id),
        m = committed.find((v) => v.customer_item_id === i.id);
      return {
        customer_item_id: i.id,
        product_id: i.product_id,
        sku: i.sku,
        name: i.name,
        quantity: i.quantity,
        components: i.components,
        ...a,
        committed_quantity: m?.quantity ?? 0,
        dispatched_quantity: m?.dispatched ?? 0,
      };
    }),
  };
}
async function output(c: PoolClient, h: Row) {
  return { intent: await view(c, h), order: await getOrder(c, h.order_id) };
}
async function replay(c: PoolClient, a: Actor, key: string, digest: string) {
  const r = (
    await c.query('SELECT * FROM b2b_external_order_intent_revisions WHERE client_key=$1', [key])
  ).rows[0];
  if (r) {
    ensure(r.request_hash === digest, 409, 'Klucz próby należy do innego aktora lub treści');
    const h = (await c.query('SELECT * FROM b2b_external_order_intents WHERE id=$1', [r.intent_id]))
      .rows[0];
    return { ...(await output(c, h)), reused: true };
  }
  ensure(
    !(
      await c.query(
        'SELECT 1 FROM b2b_dropship_quotes WHERE client_key=$1 UNION ALL SELECT 1 FROM b2b_dropship_orders WHERE client_key=$1 UNION ALL SELECT 1 FROM b2b_dropship_actions WHERE client_key=$1 LIMIT 1',
        [key],
      )
    ).rowCount,
    409,
    'Klucz jest zajęty przez inną operację',
  );
  return null;
}
async function revision(
  c: PoolClient,
  a: Actor,
  h: Row,
  kind: string,
  input: Row,
  before: Row | null,
  id = randomUUID(),
) {
  await c.query(
    'INSERT INTO b2b_external_order_intent_revisions(tenant_id,id,intent_id,actor_id,api_key_id,client_key,request_hash,request,kind,version,before_snapshot,after_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [
      a.tenantId,
      id,
      h.id,
      a.userId,
      a.apiKeyId ?? null,
      input.client_key,
      hash(a, kind, kind === 'create' ? '' : h.order_id, input),
      JSON.stringify(input),
      kind,
      h.version,
      before && JSON.stringify(before),
      JSON.stringify(snapshot(h)),
    ],
  );
  return id;
}
export async function b2bExternalOrderIntentOptions(a: Actor) {
  return networkTx(a.tenantId, async (c) => {
    const flags = await b2bDropshipAccessInTx(c, a, false, true);
    const available = await b2bExternalOrderIntentsAvailable(c);
    const warehouses = (await c.query('SELECT id,name,code FROM warehouses ORDER BY id LIMIT 201'))
      .rows;
    const links = (
      await c.query('SELECT id,supplier_name FROM b2b_links WHERE NOT paused ORDER BY id LIMIT 201')
    ).rows;
    const currency = (await c.query('SELECT currency FROM tenants WHERE id=$1', [a.tenantId]))
      .rows[0].currency;
    return {
      ...flags,
      available,
      can_manage: available && flags.can_manage,
      can_write_fields: available && flags.can_manage && (await canWriteFields(c, a)),
      catalog_currency: currency,
      limits: S.B2B_EXTERNAL_ORDER_INTENT_LIMITS,
      warehouses: { data: warehouses.slice(0, 200), capped: warehouses.length > 200 },
      links: { data: links.slice(0, 200), capped: links.length > 200 },
    };
  });
}
export async function createB2bExternalOrderIntent(
  a: Actor,
  input: z.infer<typeof S.b2bExternalOrderIntentCreateInput>,
) {
  return tx(
    a,
    true,
    async (c) => {
      const old = await replay(c, a, input.client_key, hash(a, 'create', '', input));
      if (old) return old;
      const temp = {
        original_items: input.order.items.map((i) => ({
          id: i.customer_item_id,
          quantity: i.quantity,
        })),
        order_id: null,
      };
      await validateAllocations(c, temp, input.allocations);
      const order = await createOrder(c, a, orderSchema.parse(input.order), undefined, {
        fieldWritesAllowed: true,
        fieldSource: a.apiKeyId ? 'api' : 'manual',
        externalIntentLines: input.order.items.map((i) => ({
          ...i,
          local_quantity: input.allocations.find((v) => v.customer_item_id === i.customer_item_id)!
            .local_quantity,
        })),
      });
      // Ordinary create permits operators; intent authorization remains admin-only
      // after catalogue waits, without pinning grants before the proof/FK writes.
      await b2bDropshipAccessInTx(c, a, true);
      if (input.expected_commercial_snapshot)
        await assertB2bExternalCommercialSnapshotInTx(c, order, input.expected_commercial_snapshot);
      const items = (
        await c.query('SELECT to_jsonb(i) row FROM order_items i WHERE order_id=$1 ORDER BY id', [
          order.id,
        ])
      ).rows.map((r) => r.row);
      const h = (
        await c.query(
          'INSERT INTO b2b_external_order_intents(tenant_id,id,order_id,actor_id,api_key_id,client_key,request_hash,initial_request,original_items,allocations) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
          [
            a.tenantId,
            randomUUID(),
            order.id,
            a.userId,
            a.apiKeyId ?? null,
            input.client_key,
            hash(a, 'create', '', input),
            JSON.stringify(input),
            JSON.stringify(items),
            JSON.stringify(input.allocations),
          ],
        )
      ).rows[0];
      const rid = await revision(c, a, h, 'create', input, null);
      await c.query('SELECT b2b_external_create_proof($1,$2)', [order.id, rid]);
      await audit(c, a, 'b2b.external.intent.create', h.id);
      return { ...(await output(c, h)), reused: false };
    },
    Boolean(input.order.initial_fields?.length),
  );
}
/** Attach only a newly certified source import in the caller's existing custody transaction.
 * The caller owns admission, source bindings, constraints and the final current-principal pin.
 */
export async function createB2bExternalOrderIntentFromImportInTx(
  c: PoolClient,
  a: Actor,
  input: {
    order_id: string;
    client_key: string;
    initial_request: Row;
    allocations: z.infer<typeof S.b2bExternalOrderIntentAllocateInput>['allocations'];
    source_certificate_id: string;
  },
) {
  await b2bDropshipAccessInTx(c, a, true);
  const request = { ...input.initial_request, client_key: input.client_key };
  const digest = hash(a, 'create', '', request);
  // Exact replay is owned by the typed import execution ledger. An ordinary
  // imported order or a reused intent key cannot be attached retroactively.
  ensure(!(await replay(c, a, input.client_key, digest)), 409, 'Intencja importu już istnieje');
  const items = (
    await c.query('SELECT to_jsonb(i) row FROM order_items i WHERE order_id=$1 ORDER BY id', [input.order_id])
  ).rows.map((r) => r.row);
  ensure(items.length > 0, 409, 'Import nie zawiera pozycji handlowych');
  const allocations = S.b2bExternalOrderIntentAllocateInput.shape.allocations.parse(input.allocations);
  await validateAllocations(c, { original_items: items, order_id: input.order_id }, allocations);
  const h = (
    await c.query(
      'INSERT INTO b2b_external_order_intents(tenant_id,id,order_id,actor_id,api_key_id,client_key,request_hash,initial_request,original_items,allocations) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [a.tenantId, randomUUID(), input.order_id, a.userId, a.apiKeyId ?? null, input.client_key,
        digest, JSON.stringify(request), JSON.stringify(items), JSON.stringify(allocations)],
    )
  ).rows[0];
  const rid = await revision(c, a, h, 'create', request, null);
  await c.query('SELECT b2b_external_import_create_proof($1,$2,$3)', [input.order_id, rid, input.source_certificate_id]);
  await audit(c, a, 'b2b.external.intent.import', h.id);
  return { ...(await output(c, h)), reused: false };
}
export async function b2bExternalOrderIntentDetail(a: Actor, id: string) {
  return tx(a, false, async (c) => {
    const { h } = await own(c, id, false);
    return { intent: h ? await view(c, h) : null, order: await getOrder(c, id) };
  });
}
export async function b2bExternalOrderIntentList(
  a: Actor,
  input: z.infer<typeof S.b2bExternalOrderIntentPageQuery>,
) {
  return tx(a, false, async (c) => {
    const rows = (
      await c.query(
        'SELECT * FROM b2b_external_order_intents WHERE ($1::uuid IS NULL OR order_id>$1) ORDER BY order_id LIMIT $2',
        [input.cursor ?? null, input.limit + 1],
      )
    ).rows;
    const data = [];
    for (const h of rows.slice(0, input.limit)) data.push(await view(c, h));
    return { data, meta: { cursor: rows.length > input.limit ? data.at(-1)!.order_id : null } };
  });
}
export async function allocateB2bExternalOrderIntent(
  a: Actor,
  id: string,
  input: z.infer<typeof S.b2bExternalOrderIntentAllocateInput>,
) {
  return tx(a, true, async (c) => {
    const old = await replay(c, a, input.client_key, hash(a, 'allocate', id, input));
    if (old) return old;
    const { h, order } = await own(c, id);
    ensure(
      h.version === input.version && h.state === 'open',
      409,
      'Intencja została zmieniona lub zamknięta',
    );
    ensure(
      ['new', 'paid', 'picking', 'packed'].includes(order.status),
      409,
      'Nie można zmienić wydanego zamówienia',
    );
    await validateAllocations(c, h, input.allocations);
    const before = snapshot(h),
      rid = randomUUID();
    await c.query('SELECT b2b_external_allocate($1,$2,$3,$4,false)', [
      id,
      rid,
      a.userId,
      JSON.stringify(input.allocations),
    ]);
    const updated = (
      await c.query(
        'UPDATE b2b_external_order_intents SET allocations=$2,version=version+1,updated_at=clock_timestamp() WHERE order_id=$1 RETURNING *',
        [id, JSON.stringify(input.allocations)],
      )
    ).rows[0];
    await revision(c, a, updated, 'allocate', input, before, rid);
    await audit(c, a, 'b2b.external.intent.allocate', h.id);
    return { ...(await output(c, updated)), reused: false };
  });
}
export async function actionB2bExternalOrderIntent(
  a: Actor,
  id: string,
  kind: 'close' | 'reopen',
  input: z.infer<typeof S.b2bExternalOrderIntentActionInput>,
) {
  return tx(a, true, async (c) => {
    const old = await replay(c, a, input.client_key, hash(a, kind, id, input));
    if (old) return old;
    const { h, order } = await own(c, id);
    ensure(h.version === input.version, 409, 'Intencja została zmieniona');
    const before = snapshot(h),
      rid = randomUUID();
    if (kind === 'close') {
      ensure(h.state === 'open', 409, 'Intencja jest zamknięta');
      await cancelOrder(c, a, id, undefined, { externalIntentClose: rid });
    } else {
      ensure(
        h.state === 'closed' && order.status === 'cancelled',
        409,
        'Najpierw zamknij niewydaną intencję',
      );
      ensure(
        !(
          await c.query(
            "SELECT 1 FROM invoice_plans WHERE order_id=$1 AND state NOT IN('preview','cancelled') UNION ALL SELECT 1 FROM shipping_plans WHERE order_id=$1 AND state NOT IN('preview','cancelled') UNION ALL SELECT 1 FROM return_cases WHERE order_id=$1 LIMIT 1",
            [id],
          )
        ).rowCount,
        409,
        'Zamówienie ma aktywny dokument lub zwrot',
      );
      await validateAllocations(c, h, h.allocations, true);
      await c.query('SELECT b2b_external_allocate($1,$2,$3,$4,true)', [
        id,
        rid,
        a.userId,
        JSON.stringify(h.allocations),
      ]);
      const bal = await paymentBalance(c, id);
      await c.query('UPDATE order_items SET scanned=0 WHERE order_id=$1', [id]);
      await c.query(
        'UPDATE orders SET status=$2,workflow_status_id=NULL,updated_at=clock_timestamp() WHERE id=$1',
        [id, bal.amount_due === 0 ? 'paid' : 'new'],
      );
      await event(c, a.tenantId, id, 'order.external_intent_reopened');
    }
    const updated = (
      await c.query(
        'UPDATE b2b_external_order_intents SET state=$2,version=version+1,updated_at=clock_timestamp() WHERE order_id=$1 RETURNING *',
        [id, kind === 'close' ? 'closed' : 'open'],
      )
    ).rows[0];
    await revision(c, a, updated, kind, input, before, rid);
    await audit(c, a, 'b2b.external.intent.' + kind, h.id);
    return { ...(await output(c, updated)), reused: false };
  });
}

/** Existing109 RLS/SELECT grants suffice; never return stored request/snapshots. */
export async function recoverExternalIntentOriginalKey(a: Actor, rawKey: string, input: unknown) {
  const key = originalRecoveryParams.parse({key: rawKey}).key, q = intentRecoveryQuery.parse(input);
  const entity = originalRecoveryEntity(q.operation, q.resource_id);
  return tx(a, false, async c => {
    const row = (await c.query(`SELECT r.client_key::text, r.kind operation, 'external_order'::text resource_kind,
      h.order_id::text resource_id, h.id::text related_id, r.id::text receipt_id,
      h.version::text version, r.version::text receipt_version, NULL::text content_sha256, h.state
      FROM b2b_external_order_intent_revisions r JOIN b2b_external_order_intents h
        ON h.tenant_id=r.tenant_id AND h.id=r.intent_id
      WHERE r.tenant_id=$1 AND r.client_key=$2 AND r.actor_id=$3 AND r.api_key_id IS NOT DISTINCT FROM $4::uuid
        AND r.kind=$5 AND ($6::uuid IS NULL OR h.order_id=$6)`,
      [a.tenantId,key,a.userId,a.apiKeyId ?? null,q.operation,entity])).rows[0];
    return {recovery: checkedOriginalRecovery(row, key, q.operation, entity)};
  });
}
