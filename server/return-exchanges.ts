import { prepareReturnCompletionInTx, completeReturnCompletionInTx, replayReturnCompletionInTx, pinReturnCompletionInTx } from './return-completion';
import type { Pool, PoolClient } from 'pg';
import { pool } from './db';
import { ensure, Problem } from './errors';
import { createOrder, getOrder, orderSchema, transition, audit, type Actor } from './domain';
import { getReturn, receiveReturn, receiveInput } from './returns';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import { completeReturnExchangePreview } from './return-exchange-preview-values';
import {
  returnExchangeInput,
  returnExchangePreviewInput,
  type ReturnExchangeInput,
  type ReturnExchangePreviewInput,
} from './return-exchanges-schema';

const tables = ['return_exchanges', 'return_exchange_items', 'return_exchange_admissions'];
const functions = [
  'return_exchange_installed()',
  'return_exchange_access(uuid,uuid,boolean)',
  'return_exchange_frame(uuid,uuid,uuid,jsonb)',
  'return_exchange_prepare(uuid,uuid,uuid,jsonb)',
  'return_exchange_receive_admission(uuid,uuid,jsonb)',
  'return_exchange_order_admission(uuid)',
  'return_exchange_finish(uuid)',
  'return_exchange_validate(uuid)',
  'return_exchange_snapshot(uuid,uuid)',
  'return_exchange_immutable()',
  'return_exchange_guard()',
  'return_exchange_complete()',
  'return_exchange_financial_guard()',
  'return_exchange_seal()',
  'return_exchange_budget()',
];
const sealTables = [
  'orders',
  'order_items',
  'order_pick_items',
  'return_cases',
  'return_items',
  'stock',
  'stock_locations',
  'reservations',
  'reservation_locations',
  'wms_operations',
  'wms_layer_positions',
  'wms_reservation_layers',
  'wms_return_fragments',
  'wms_layer_movements',
  'stock_movements',
];
const financialTables = [
  'payment_entries',
  'documents',
  'invoice_plans',
  'odoo_invoice_exports',
  'order_merge_previews',
  'order_merge_executions',
  'order_merge_claims',
  'b2b_dropship_orders',
  'b2b_external_order_intents',
];
const guards = [
  ...['return_exchanges', 'return_exchange_items'].map((table) => ({
    table,
    name: 'return_exchange_immutable',
    fn: 'return_exchange_immutable()',
    deferred: false,
  })),
  ...['return_exchanges', 'return_exchange_admissions', 'orders', 'return_cases'].map((table) => ({
    table,
    name: 'return_exchange_complete',
    fn: 'return_exchange_complete()',
    deferred: true,
  })),
  ...['return_exchanges', 'return_exchange_admissions', 'return_exchange_items'].map((table) => ({
    table,
    name: 'return_exchange_budget',
    fn: 'return_exchange_budget()',
    deferred: false,
  })),
  ...sealTables.map((table) => ({
    table,
    name: 'return_exchange_seal',
    fn: 'return_exchange_seal()',
    deferred: false,
  })),
  ...financialTables.map((table) => ({
    table,
    name: 'return_exchange_financial_guard',
    fn: 'return_exchange_financial_guard()',
    deferred: false,
  })),
  ...[
    ['return_exchange_admissions', 'return_exchange_admission_guard'],
    ['return_exchanges', 'return_exchange_receipt_guard'],
    ['orders', 'return_exchange_order_guard'],
    ['order_items', 'return_exchange_item_guard'],
    ['return_cases', 'return_exchange_return_guard'],
    ['return_items', 'return_exchange_line_guard'],
  ].map(([table, name]) => ({ table, name, fn: 'return_exchange_guard()', deferred: false })),
];
async function fullCapability(c: Pool | PoolClient): Promise<boolean> {
  const r = (
    await c.query(
      `SELECT
    (SELECT count(*) FROM pg_class WHERE oid=ANY(ARRAY(SELECT to_regclass(x) FROM unnest($1::text[]) x))
      AND relrowsecurity AND relforcerowsecurity)=3
    AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) x WHERE to_regprocedure(x) IS NULL)
    AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) g("table" text,name text,fn text,deferred boolean)
      WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(g."table") AND t.tgname::text=g.name
       AND t.tgfoid=to_regprocedure(g.fn) AND NOT t.tgisinternal AND t.tgenabled='O'
       AND t.tgdeferrable=g.deferred AND t.tginitdeferred=g.deferred))
    AND (SELECT count(*) FROM pg_attribute WHERE NOT attisdropped AND attnotnull AND
      ((attrelid='orders'::regclass AND attname='fulfillment_kind' AND atttypid='text'::regtype)
       OR(attrelid='return_cases'::regclass AND attname='remedy' AND atttypid='text'::regtype)))=2
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='orders'::regclass AND attname='replacement_return_id' AND atttypid='uuid'::regtype AND NOT attisdropped)
    AND NOT EXISTS(SELECT 1 FROM unnest($1::text[]) x WHERE has_table_privilege('dyna_app',to_regclass(x),'INSERT,UPDATE,DELETE'))
    AND NOT has_table_privilege('dyna_app',to_regclass('return_exchange_admissions'),'SELECT') available`,
      [tables, functions, JSON.stringify(guards)],
    )
  ).rows[0];
  return Boolean(r.available);
}
export async function returnExchangeAvailable(c: Pool | PoolClient): Promise<boolean> {
  const probe = (
    await c.query(
      `SELECT
    EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'return_exchange_%')
    OR EXISTS(SELECT 1 FROM unnest($1::text[]) x WHERE to_regclass(x) IS NOT NULL)
    OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid IN('orders'::regclass,'return_cases'::regclass)
      AND attname IN('fulfillment_kind','replacement_return_id','remedy') AND NOT attisdropped) artifacts`,
      [tables],
    )
  ).rows[0];
  if (!probe.artifacts) {
    const installed = (
      await pool.query(
        "SELECT EXISTS(SELECT 1 FROM migrations WHERE name='120_return_exchanges') installed",
      )
    ).rows[0].installed;
    ensure(!installed, 503, 'Moduł wymian reklamacyjnych jest niekompletny');
    return false;
  }
  ensure(await fullCapability(c), 503, 'Moduł wymian reklamacyjnych jest niekompletny');
  ensure(
    (await c.query('SELECT return_exchange_installed() installed')).rows[0].installed,
    503,
    'Brak potwierdzonej migracji wymian reklamacyjnych',
  );
  await returnExchangeSubstitutionsAvailable(c);
  return true;
}
const substitutionFunctions = [
  'return_exchange_substitution_installed()',
  'return_exchange_substitution_access(uuid,uuid,boolean)',
  'return_exchange_receive_request(jsonb)',
  'return_exchange_physical_scope(jsonb)',
  'return_exchange_snapshot_v1(uuid,uuid)',
  'return_exchange_snapshot_v2(uuid,uuid,jsonb)',
  'return_exchange_frame_v1(uuid,uuid,uuid,jsonb)',
  'return_exchange_frame_v2(uuid,uuid,uuid,jsonb)',
  'return_exchange_validate_v1(uuid)',
  'return_exchange_validate_v2(uuid)',
  'return_exchange_replacements_valid(uuid)',
  'return_exchange_replacement_guard()',
  'return_exchange_substitution_seal()',
];
const substitutionGuards = [
  {
    table: 'return_exchange_replacements',
    name: 'return_exchange_replacement_guard',
    fn: 'return_exchange_replacement_guard()',
    deferred: false,
  },
  {
    table: 'return_exchange_replacements',
    name: 'return_exchange_complete',
    fn: 'return_exchange_complete()',
    deferred: true,
  },
  {
    table: 'return_exchange_replacements',
    name: 'return_exchange_budget',
    fn: 'return_exchange_budget()',
    deferred: false,
  },
  ...['products', 'bundle_components'].map((table) => ({
    table,
    name: 'return_exchange_substitution_seal',
    fn: 'return_exchange_substitution_seal()',
    deferred: false,
  })),
];
export async function returnExchangeSubstitutionsAvailable(c: Pool | PoolClient): Promise<boolean> {
  const probe = (
    await c.query(
      `SELECT to_regclass('return_exchange_replacements') IS NOT NULL OR
 EXISTS(SELECT 1 FROM unnest($1::text[]) signature WHERE to_regprocedure(signature) IS NOT NULL) artifacts`,
      [substitutionFunctions],
    )
  ).rows[0];
  if (!probe.artifacts) {
    const installed = (
      await pool.query(
        "SELECT EXISTS(SELECT 1 FROM migrations WHERE name='123_return_exchange_substitutions') installed",
      )
    ).rows[0].installed;
    ensure(!installed, 503, 'Moduł wyboru zamiennika jest niekompletny');
    return false;
  }
  const full = (
    await c.query(
      `SELECT
  EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('return_exchange_replacements') AND relrowsecurity AND relforcerowsecurity)
  AND NOT EXISTS(SELECT 1 FROM unnest($1::text[]) signature WHERE to_regprocedure(signature) IS NULL)
  AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) g("table" text,name text,fn text,deferred boolean)
    WHERE NOT EXISTS(SELECT 1 FROM pg_trigger tr WHERE tr.tgrelid=to_regclass(g."table") AND tr.tgname::text=g.name
      AND tr.tgfoid=to_regprocedure(g.fn) AND tr.tgenabled='O' AND NOT tr.tgisinternal
      AND tr.tgdeferrable=g.deferred AND tr.tginitdeferred=g.deferred))
  AND NOT has_table_privilege('dyna_app',to_regclass('return_exchange_replacements'),'INSERT,UPDATE,DELETE')
  AND has_table_privilege('dyna_app',to_regclass('return_exchange_replacements'),'SELECT')
  AND (SELECT count(*) FROM pg_attribute WHERE attrelid=to_regclass('return_exchange_replacements') AND NOT attisdropped AND attnotnull
    AND attname=ANY(ARRAY['tenant_id','exchange_id','original_item_id','replacement_order_id','replacement_item_id','replacement_product_id','quantity','components','product_snapshot']))=9
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('return_exchange_replacements') AND contype='f' AND convalidated)=3
  AND NOT EXISTS(SELECT 1 FROM (VALUES
   ('return_exchange_items',ARRAY['tenant_id','exchange_id','original_item_id']::text[],ARRAY['tenant_id','exchange_id','original_item_id']::text[]),
   ('order_items',ARRAY['tenant_id','replacement_order_id','replacement_item_id']::text[],ARRAY['tenant_id','order_id','id']::text[]),
   ('products',ARRAY['tenant_id','replacement_product_id']::text[],ARRAY['tenant_id','id']::text[])
  ) expected(parent,own_columns,parent_columns) WHERE NOT EXISTS(
   SELECT 1 FROM pg_constraint fk WHERE fk.conrelid=to_regclass('return_exchange_replacements') AND fk.contype='f'
   AND fk.confrelid=to_regclass(expected.parent) AND fk.convalidated
   AND (SELECT array_agg(att.attname::text ORDER BY col.n) FROM unnest(fk.conkey) WITH ORDINALITY col(k,n)
    JOIN pg_attribute att ON(att.attrelid,att.attnum)=(fk.conrelid,col.k))=expected.own_columns
   AND (SELECT array_agg(att.attname::text ORDER BY col.n) FROM unnest(fk.confkey) WITH ORDINALITY col(k,n)
    JOIN pg_attribute att ON(att.attrelid,att.attnum)=(fk.confrelid,col.k))=expected.parent_columns))
  AND NOT EXISTS(SELECT 1 FROM unnest($1::text[]) signature WHERE signature NOT IN('return_exchange_substitution_installed()','return_exchange_substitution_access(uuid,uuid,boolean)')
    AND has_function_privilege('dyna_app',to_regprocedure(signature),'EXECUTE')) available`,
      [substitutionFunctions, JSON.stringify(substitutionGuards)],
    )
  ).rows[0].available;
  ensure(full && (await fullCapability(c)), 503, 'Moduł wyboru zamiennika jest niekompletny');
  ensure(
    (await c.query('SELECT return_exchange_substitution_installed() installed')).rows[0].installed,
    503,
    'Brak potwierdzonej migracji wyboru zamiennika',
  );
  return true;
}
function usesSubstitution(input: ReturnExchangePreviewInput) {
  return input.items.some((item) => item.replacement_product_id !== undefined);
}
async function capability(c: PoolClient) {
  return returnExchangeAvailable(c);
}
async function access(c: PoolClient, a: Actor, pin = false, substitution = false) {
  ensure(
    (
      await c.query(
        "SELECT current_user='dyna_app' AND current_setting('app.tenant_id',true)=$1 ok",
        [a.tenantId],
      )
    ).rows[0].ok,
    403,
    'Niezgodny kontekst transakcji wymiany',
  );
  const g = (
    await c.query(
      substitution
        ? 'SELECT return_exchange_substitution_access($1,$2,$3) g'
        : 'SELECT return_exchange_access($1,$2,$3) g',
      [a.userId, a.apiKeyId ?? null, pin],
    )
  ).rows[0].g;
  ensure(g.key_valid, 401, 'Klucz został cofnięty lub wygasł');
  ensure(g.allowed, 403, 'Wymiana wymaga aktualnych uprawnień administratora i zakresów magazynu');
  return { available: true, can_manage: true, current_role: g.role };
}
async function sql<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e.code === 'P0002') throw new Problem(404, 'Nie znaleziono reklamacji');
    if (e.code === 'P0001') throw new Problem(409, e.message);
    throw e;
  }
}
export async function previewReturnExchange(
  c: PoolClient,
  a: Actor,
  id: string,
  body: ReturnExchangePreviewInput,
) {
  ensure(await capability(c), 503, 'Kopia nie obsługuje wymian reklamacyjnych');
  await access(c, a);
  const input = returnExchangePreviewInput.parse(body);
  const substitution_available = await returnExchangeSubstitutionsAvailable(c);
  const substitution = usesSubstitution(input);
  ensure(!substitution || substitution_available, 503, 'Kopia nie obsługuje wyboru zamiennika');
  await access(c, a, false, substitution);
  const preview = await sql(
    async () =>
      (
        await c.query('SELECT return_exchange_frame($1,$2,$3,$4) p', [
          id,
          a.userId,
          a.apiKeyId ?? null,
          JSON.stringify(input),
        ])
      ).rows[0].p,
  );
  return {
    preview: completeReturnExchangePreview(preview),
    substitution_available,
    ...(await access(c, a, true, substitution)),
  };
}
export async function executeReturnExchange(
  c: PoolClient,
  a: Actor,
  id: string,
  body: ReturnExchangeInput,
) {
  ensure(await capability(c), 503, 'Kopia nie obsługuje wymian reklamacyjnych');
  a = enlistWmsActorInTx(c, a, { orders: true });
  await access(c, a);
  const input = returnExchangeInput.parse(body);
  const substitution_available = await returnExchangeSubstitutionsAvailable(c);
  const substitution = usesSubstitution(input);
  ensure(!substitution || substitution_available, 503, 'Kopia nie obsługuje wyboru zamiennika');
  await access(c, a, false, substitution);
  const {
    client_key: _key,
    scope_hash: _hash,
    confirmed: _confirmed,
    warehouse_id: _warehouse,
    ...receipt
  } = input;
  const physicalReceipt = {
    ...receipt,
    items: receipt.items.map(({ replacement_product_id: _replacement, ...item }) => item),
    shipping_refund: 0,
  };
  const completion = await prepareReturnCompletionInTx(c, a, { return_id: id, protocol: 'exchange', request: receiveInput.parse(physicalReceipt) });
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `return.exchange:${a.tenantId}`,
  ]);
  const old = (
    await c.query('SELECT * FROM return_exchanges WHERE client_key=$1', [input.client_key])
  ).rows[0];
  if (old) {
    ensure(
      old.return_id === id && old.actor_id === a.userId && old.api_key_id === (a.apiKeyId ?? null),
      409,
      'Klucz wymiany ma inny zakres lub autora',
    );
    // JSONB object order is not a request semantic; compare in SQL as well.
    ensure(
      (
        await c.query('SELECT request=$2::jsonb equal FROM return_exchanges WHERE id=$1', [
          old.id,
          JSON.stringify(input),
        ])
      ).rows[0].equal,
      409,
      'Klucz wymiany ma inną treść',
    );
    await replayReturnCompletionInTx(c, a, completion);
    const ret = await getReturn(c, id),
      order = await getOrder(c, old.replacement_order_id);
    await pinReturnCompletionInTx(c, a, completion);
    return {
      return: ret,
      replacement_order: order,
      exchange: await returnExchangeMetadataInTx(c, ret, true),
      reused: true,
      substitution_available,
      ...(await access(c, a, true, substitution)),
    };
  }
  const admission = await sql(
    async () =>
      (
        await c.query('SELECT return_exchange_prepare($1,$2,$3,$4) p', [
          id,
          a.userId,
          a.apiKeyId ?? null,
          JSON.stringify(input),
        ])
      ).rows[0].p,
  );
  await receiveReturn(c, a, id, receiveInput.parse(physicalReceipt), false, {
    exchangeAdmissionId: admission.id, completion,
  });
  await createOrder(c, a, orderSchema.parse(admission.order_input), undefined, {
    replacementAdmissionId: admission.id,
  });
  await transition(c, a, admission.replacement_order_id, 'paid');
  const exchange = await sql(
    async () => (await c.query('SELECT return_exchange_finish($1) p', [admission.id])).rows[0].p,
  );
  await audit(c, a, 'return.exchange', id, {
    exchange_id: exchange.id,
    replacement_order_id: exchange.replacement_order_id,
  });
  await completeReturnCompletionInTx(c, a, completion, { exchange_id: exchange.id });
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  const ret = await getReturn(c, id),
    order = await getOrder(c, exchange.replacement_order_id);
  await pinReturnCompletionInTx(c, a, completion);
  return {
    return: ret,
    replacement_order: order,
    exchange: await returnExchangeMetadataInTx(c, ret, true),
    reused: false,
    substitution_available,
    ...(await access(c, a, true, substitution)),
  };
}
export async function returnExchangeMetadataInTx(c: PoolClient, r: any, installed?: boolean) {
  if (!(installed ?? (await capability(c)))) return null;
  const e = (
    await c.query(
      `SELECT e.id,e.return_id,e.replacement_order_id,e.scope_hash,e.created_at,
    jsonb_build_object('id',o.id,'number',o.number,'status',o.status,'warehouse_id',o.warehouse_id,
      'shipments',coalesce((SELECT jsonb_agg(jsonb_build_object('carrier',s.carrier,'tracking_number',s.tracking_number,
       'mode',s.mode,'status',s.status) ORDER BY s.created_at,s.id) FROM shipments s WHERE(s.tenant_id,s.order_id)=(o.tenant_id,o.id)),'[]')) replacement_order
    FROM return_exchanges e JOIN orders o ON(o.tenant_id,o.id)=(e.tenant_id,e.replacement_order_id) WHERE e.return_id=$1`,
      [r.id],
    )
  ).rows[0];
  if (!e) return null;
  const substitutionAvailable = await returnExchangeSubstitutionsAvailable(c);
  const proof = (
    await c.query(
      "SELECT coalesce((snapshot->'frame'->>'proof_version')::int,1) proof_version FROM return_exchanges WHERE id=$1",
      [e.id],
    )
  ).rows[0];
  ensure(
    proof.proof_version === 1 || (proof.proof_version === 2 && substitutionAvailable),
    503,
    'Niepełny dowód wyboru zamiennika',
  );
  return {
    ...e,
    proof_version: proof.proof_version,
    replacements: substitutionAvailable
      ? (
          await c.query(
            `SELECT original_item_id,replacement_item_id,replacement_product_id,quantity,components,product_snapshot
    FROM return_exchange_replacements WHERE exchange_id=$1 ORDER BY original_item_id`,
            [e.id],
          )
        ).rows
      : [],
  };
}
