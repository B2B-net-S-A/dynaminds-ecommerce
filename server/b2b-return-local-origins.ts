import type { Pool, PoolClient } from 'pg';
import type { Actor } from './domain';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import {
  b2bReturnLocalOriginInput,
  type B2bReturnLocalContext,
  type B2bReturnLocalOrigin,
} from './b2b-return-local-origins-schema';
export * from './b2b-return-local-origins-schema';

export async function b2bReturnLocalOriginsAvailable(c: Pool | PoolClient) {
  return Boolean(
    (
      await c.query(`SELECT
    to_regclass('public.b2b_return_local_origins') IS NOT NULL
    AND to_regclass('public.b2b_return_local_proofs') IS NOT NULL
    AND to_regprocedure('public.b2b_return_local_installed()') IS NOT NULL
    AND to_regprocedure('public.b2b_return_local_external(uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_return_local_auth(uuid,uuid,boolean)') IS NOT NULL
    AND to_regprocedure('public.b2b_return_local_choices(uuid,uuid,uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_return_local_select(uuid,uuid,uuid,jsonb)') IS NOT NULL
    AND to_regprocedure('public.b2b_return_local_snapshot(uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_return_local_prepare(uuid,uuid,uuid,jsonb)') IS NOT NULL
    AND to_regprocedure('public.b2b_return_local_finish(uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_return_local_receive_replay(uuid,uuid,uuid,jsonb)') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_return_key_grant(uuid,uuid,boolean,boolean)') IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['b2b_return_local_origins','b2b_return_local_proofs']) name
      LEFT JOIN pg_class cls ON cls.oid=to_regclass('public.'||name)
      WHERE cls.oid IS NULL OR NOT cls.relrowsecurity OR NOT cls.relforcerowsecurity)
    AND NOT EXISTS(SELECT 1 FROM (VALUES
      ('b2b_return_local_origins','complete','b2b_return_local_origin_complete()'),
      ('b2b_return_local_origins','immutable','b2b_return_local_immutable()'),
      ('b2b_return_local_origins','budget','b2b_return_local_budget()'),
      ('b2b_return_local_proofs','proof_complete','b2b_return_local_proof_complete()'),
      ('b2b_return_local_proofs','immutable','b2b_return_local_private_guard()'),
      ('b2b_return_local_proofs','budget','b2b_return_local_budget()'),
      ('return_cases','local_origin_guard','b2b_return_local_rma_guard()'),
      ('return_items','local_origin_guard','b2b_return_local_rma_guard()'),
      ('return_cases','local_origin_complete','b2b_return_local_initial_complete()'),
      ('return_items','local_origin_complete','b2b_return_local_initial_complete()'),
      ('b2b_dropship_return_previews','local_origin_guard','b2b_return_local_bridge_guard()'),
      ('b2b_dropship_return_cases','local_origin_guard','b2b_return_local_bridge_guard()')
    ) required(relation,trigger_name,helper)
      WHERE NOT EXISTS(SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid=to_regclass('public.'||required.relation)
        AND tg.tgname=required.trigger_name AND tg.tgfoid=to_regprocedure('public.'||required.helper)
        AND tg.tgenabled IN('O','A') AND NOT tg.tgisinternal))
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['stock','stock_locations','stock_movements','wms_layer_positions',
      'wms_layer_movements','wms_return_fragments','wms_operations','return_cases','return_items','orders','order_items','shipments']) relation
      WHERE NOT EXISTS(SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid=to_regclass('public.'||relation)
        AND tg.tgname='local_return_seal' AND tg.tgfoid=to_regprocedure('public.b2b_return_local_seal()')
        AND tg.tgenabled IN('O','A') AND NOT tg.tgisinternal)) available`)
    ).rows[0].available,
  );
}

async function state(c: PoolClient) {
  const row = (
    await c.query(`SELECT
    to_regclass('public.b2b_return_local_origins') IS NOT NULL origins,
    to_regclass('public.b2b_return_local_proofs') IS NOT NULL proofs,
    to_regprocedure('public.b2b_return_local_installed()') IS NOT NULL probe`)
  ).rows[0];
  const installed = row.probe
    ? Boolean((await c.query('SELECT b2b_return_local_installed() installed')).rows[0].installed)
    : false;
  if (!installed && !row.origins && !row.proofs && !row.probe) return false;
  ensure(
    await b2bReturnLocalOriginsAvailable(c),
    503,
    'Niekompletna kopia lokalnego pochodzenia RMA',
  );
  return true;
}

async function sql(c: PoolClient, query: string, values: unknown[]) {
  try {
    return await c.query(query, values);
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === '23514') {
      if (e.message === 'Klucz został cofnięty lub wygasł') throw new Problem(401, e.message);
      if (
        e.message === 'Brak aktualnej zgody administratora' ||
        e.message === 'Brak bieżących zakresów zwrotu'
      )
        throw new Problem(403, e.message);
      throw new Problem(409, e.message ?? 'Zmienił się zakres lokalnego RMA');
    }
    if (e.code === 'P0001' && e.message?.startsWith('Limit lokalnych źródeł RMA'))
      throw new Problem(429, e.message);
    throw error;
  }
}

function view(row: Record<string, any>): B2bReturnLocalOrigin {
  return {
    id: row.id,
    scope_hash: row.scope_hash,
    created_at: new Date(row.created_at).toISOString(),
    items: row.request.items,
  };
}

export async function localReturnOriginContextInTx(
  c: PoolClient,
  a: Actor,
  id: string,
): Promise<B2bReturnLocalContext & { can_receive_locally?: boolean }> {
  const neutral: B2bReturnLocalContext = {
    fulfillment_origin: 'ordinary',
    local_origin: null,
    local_sources: [],
    local_scope_hash: null,
    can_select_local_origin: false,
  };
  if (!(await state(c))) return neutral;
  const r = (await c.query('SELECT * FROM return_cases WHERE id=$1', [id])).rows[0];
  ensure(r, 404, 'Nie znaleziono własnej sprawy RMA');
  const partner = Boolean(
    (await c.query('SELECT id FROM b2b_dropship_return_cases WHERE return_id=$1 LIMIT 1', [id]))
      .rowCount,
  );
  const supplier = Boolean(
    (
      await c.query(
        'SELECT case_id FROM b2b_dropship_return_supplier_cases WHERE return_id=$1 LIMIT 1',
        [id],
      )
    ).rowCount,
  );
  const external = Boolean(
    (await sql(c, 'SELECT b2b_return_local_external($1) external', [id])).rows[0].external,
  );
  const origin = (
    await c.query(
      'SELECT id,scope_hash,created_at,request FROM b2b_return_local_origins WHERE return_id=$1',
      [id],
    )
  ).rows[0];
  const role = (await c.query('SELECT b2b_dropship_current_role($1,false) role', [a.userId]))
    .rows[0].role;
  const canManage =
    role === 'admin' &&
    (!a.apiKeyId ||
      (
        await c.query('SELECT b2b_dropship_return_key_grant($1,$2,true,false) result', [
          a.userId,
          a.apiKeyId,
        ])
      ).rows[0].result === 'ok');
  const choices =
    external && !partner && !supplier && !origin && r.state === 'requested' && !r.receipt
      ? (
          await sql(c, 'SELECT b2b_return_local_choices($1,$2,$3) result', [
            id,
            a.userId,
            a.apiKeyId ?? null,
          ])
        ).rows[0].result
      : null;
  const sources = choices?.sources ?? [];
  const items = (
    await c.query(
      'SELECT item_id,requested FROM return_items WHERE return_id=$1 ORDER BY item_id',
      [id],
    )
  ).rows;
  return {
    fulfillment_origin: supplier
      ? 'supplier'
      : partner
        ? 'partner'
        : origin
          ? 'local'
          : external
            ? 'unselected'
            : 'ordinary',
    local_origin: origin ? view(origin) : null,
    local_sources: sources,
    local_scope_hash: choices?.scope_hash ?? null,
    can_select_local_origin:
      canManage &&
      Boolean(choices) &&
      items.length > 0 &&
      items.every((item) => {
        const matching = sources.filter(
          (source: { customer_item_id: string }) => source.customer_item_id === item.item_id,
        );
        return matching.length === 1 && matching[0].quantity_available >= item.requested;
      }),
    can_receive_locally: !partner && !supplier && (!external || Boolean(origin)),
  };
}

/** Called by the111 transaction wrapper, which supplies source admission and final ACL. */
export async function selectLocalReturnOriginInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  raw: unknown,
) {
  const body = b2bReturnLocalOriginInput.parse(raw);
  ensure(await state(c), 503, 'Ta kopia nie obsługuje wyboru lokalnego pochodzenia RMA');
  const result = (
    await sql(c, 'SELECT b2b_return_local_select($1,$2,$3,$4) result', [
      id,
      a.userId,
      a.apiKeyId ?? null,
      body,
    ])
  ).rows[0].result;
  const saved = (
    await c.query(
      'SELECT id,scope_hash,created_at,request FROM b2b_return_local_origins WHERE id=$1',
      [result.id],
    )
  ).rows[0];
  ensure(saved, 409, 'Brak utrwalonego wyboru źródła');
  if (!result.reused)
    await audit(c, a, 'return.local_origin', saved.id, {
      return_id: id,
      scope_hash: saved.scope_hash,
    });
  return { origin: view(saved), reused: Boolean(result.reused) };
}

export async function prepareLocalReturnReceiveInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  input: { origin_id?: string },
) {
  if (!(await state(c))) {
    ensure(!input.origin_id, 503, 'Ta kopia nie obsługuje lokalnego pochodzenia RMA');
    return null;
  }
  // Bound111 receipts remain governed only by their own typed private proof.
  if (
    (
      await c.query('SELECT case_id FROM b2b_dropship_return_supplier_cases WHERE return_id=$1', [
        id,
      ])
    ).rowCount ||
    (await c.query('SELECT id FROM b2b_dropship_return_cases WHERE return_id=$1', [id])).rowCount
  ) {
    ensure(!input.origin_id, 409, 'Partnerowy zwrot nie dopuszcza lokalnego pochodzenia');
    return null;
  }
  const external = (await sql(c, 'SELECT b2b_return_local_external($1) result', [id])).rows[0]
    .result;
  const origin = (await c.query('SELECT id FROM b2b_return_local_origins WHERE return_id=$1', [id]))
    .rows[0];
  if (!external && !origin) {
    ensure(!input.origin_id, 409, 'Obce lokalne pochodzenie RMA');
    return null;
  }
  ensure(
    origin && input.origin_id === origin.id,
    409,
    'Zewnętrzny zwrot wymaga jawnego lokalnego pochodzenia albo przyjęcia partnera',
  );
  const proof = (
    await sql(c, 'SELECT b2b_return_local_prepare($1,$2,$3,$4) id', [
      id,
      a.userId,
      a.apiKeyId ?? null,
      input,
    ])
  ).rows[0].id;
  return { id: proof as string, actor: a };
}

/** The quota lock precedes the core's order/RMA locks, just as in local selection. */
export async function admitLocalReturnReceiveInTx(c: PoolClient, a: Actor, id: string) {
  if (!(await state(c))) return;
  const origin = (await c.query('SELECT id FROM b2b_return_local_origins WHERE return_id=$1', [id]))
    .rows[0];
  if (!origin) return;
  const role = (await c.query('SELECT b2b_dropship_current_role($1,false) role', [a.userId]))
    .rows[0].role;
  ensure(role === 'admin', 403, 'Brak aktualnej zgody administratora');
  if (a.apiKeyId) {
    const grant = (
      await c.query('SELECT b2b_dropship_return_key_grant($1,$2,true,false) result', [
        a.userId,
        a.apiKeyId,
      ])
    ).rows[0].result;
    ensure(grant !== 'invalid', 401, 'Klucz został cofnięty lub wygasł');
    ensure(grant === 'ok', 403, 'Brak bieżących zakresów zwrotu');
  }
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'b2b.return.local:' + a.tenantId,
  ]);
}

/** No new proof on replay, but fresh ACL and actor/body identity precede the return. */
export async function assertLocalReturnReceiveReplayInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  input: { origin_id?: string },
) {
  if (!(await state(c))) {
    ensure(!input.origin_id, 503, 'Ta kopia nie obsługuje lokalnego pochodzenia RMA');
    return;
  }
  const origin = (await c.query('SELECT id FROM b2b_return_local_origins WHERE return_id=$1', [id]))
    .rows[0];
  if (origin) {
    ensure(input.origin_id === origin.id, 409, 'Replay wskazuje inne lokalne pochodzenie');
    await sql(c, 'SELECT b2b_return_local_receive_replay($1,$2,$3,$4)', [
      id,
      a.userId,
      a.apiKeyId ?? null,
      input,
    ]);
    return;
  }
  const partner = (
    await c.query('SELECT id FROM b2b_dropship_return_cases WHERE return_id=$1', [id])
  ).rowCount;
  const supplier = (
    await c.query('SELECT case_id FROM b2b_dropship_return_supplier_cases WHERE return_id=$1', [id])
  ).rowCount;
  if (!partner && !supplier)
    ensure(
      !(await sql(c, 'SELECT b2b_return_local_external($1) result', [id])).rows[0].result,
      409,
      'Historyczne przyjęcie nie posiada jawnego lokalnego pochodzenia',
    );
  ensure(!input.origin_id, 409, 'Obce lokalne pochodzenie RMA');
}

/** Native SQL completion applies the real proof and its physical seal. A
 * coordinating transaction calls this only after all outer physical/core DML. */
export async function completeLocalReturnReceiveInTx(
  c: PoolClient,
  proof: { id: string; actor: Actor } | null,
): Promise<string | null> {
  if (!proof) return null;
  await sql(c, 'SELECT b2b_return_local_finish($1)', [proof.id]);
  return proof.id;
}

/** Fresh native IAM only. The coordinating owner must flush all deferred
 * constraints after every completion/write and before this terminal PIN. */
export async function pinLocalReturnReceiveInTx(
  c: PoolClient,
  proof: { id: string; actor: Actor } | null,
) {
  if (!proof) return;
  const role = (
    await c.query('SELECT b2b_dropship_current_role($1,true) role', [proof.actor.userId])
  ).rows[0].role;
  ensure(role === 'admin', 403, 'Brak aktualnej zgody administratora');
  if (proof.actor.apiKeyId) {
    const grant = (
      await c.query('SELECT b2b_dropship_return_key_grant($1,$2,true,true) result', [
        proof.actor.userId,
        proof.actor.apiKeyId,
      ])
    ).rows[0].result;
    ensure(grant !== 'invalid', 401, 'Klucz został cofnięty lub wygasł');
    ensure(grant === 'ok', 403, 'Brak bieżących zakresów zwrotu');
  }
}

/** Safe standalone behavior remains complete → full flush → fresh native PIN,
 * including WMS OFF. Only trusted outer coordinators use the separate phases. */
export async function finishLocalReturnReceiveInTx(
  c: PoolClient,
  proof: { id: string; actor: Actor } | null,
) {
  if (!proof) return;
  await completeLocalReturnReceiveInTx(c, proof);
  await sql(c, 'SET CONSTRAINTS ALL IMMEDIATE', []);
  await pinLocalReturnReceiveInTx(c, proof);
}
