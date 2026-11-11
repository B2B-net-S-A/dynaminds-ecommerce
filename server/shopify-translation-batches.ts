import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
import type { IntegrationContext } from './channel-access';
import { shopifyFulfillmentHash as hash } from './shopify-fulfillment';
import { shopifyTranslationLocale } from './shopify-translation-api';
import {
  previewTranslation,
  queueTranslationInTx,
  cancelTranslation,
  translationConsent,
  translationCursor,
} from './shopify-translations';
export const translationBatchInput = z
  .strictObject({
    client_key: z.uuid(),
    channel_id: z.uuid(),
    local_locale: z
      .string()
      .max(40)
      .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/),
    target_locale: shopifyTranslationLocale,
    fields: z
      .array(z.enum(['title', 'body_html']))
      .min(1)
      .max(2),
    items: z
      .array(
        z.strictObject({
          product_id: z.uuid(),
          listing_id: z.uuid(),
          version: z.number().int().positive(),
          translation_version: z.number().int().positive(),
        }),
      )
      .min(1)
      .max(100),
  })
  .refine(
    (b) =>
      new Set(b.fields).size === b.fields.length &&
      new Set(b.items.map((i) => i.product_id)).size === b.items.length,
    'Powtórzone pola lub produkty',
  );
async function admin(c: PoolClient, a: Actor) {
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) ok', [a.userId])).rows[0]?.ok,
    403,
    'Wymagany aktualny administrator',
  );
}
const batchLock = async (c: PoolClient, id: string) => {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'shopify.translation.batch:' + id,
  ]);
};
const batchRow = async (c: PoolClient, id: string, lock = false) =>
  (
    await c.query(
      'SELECT * FROM shopify_translation_batches WHERE id=$1' + (lock ? ' FOR UPDATE' : ''),
      [id],
    )
  ).rows[0];
const items = async (c: PoolClient, id: string) =>
  (
    await c.query(
      `SELECT i.*,CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id',p.id,'state',p.state,'phase',p.phase,'attempted_at',p.attempted_at,'needs_replace',p.needs_replace,'remote_snapshot',jsonb_build_object('simulation',p.remote_snapshot->'simulation'),'expires_at',p.expires_at,'error',p.error,'result',jsonb_build_object('confirmed',p.result->'confirmed','observed_at',p.result->'observed_at','fields',(SELECT coalesce(jsonb_agg(jsonb_build_object('key',f->'key','confirmed',f->'confirmed','outdated',f->'outdated','sourceMatches',f->'sourceMatches')),'[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.result->'fields')='array' THEN p.result->'fields' ELSE '[]'::jsonb END) f)),'shop_id',p.shop_id,'remote_product_id',p.remote_product_id,'remote_variant_id',p.remote_variant_id,'local_locale',p.local_locale,'target_locale',p.target_locale) END plan FROM shopify_translation_batch_items i LEFT JOIN shopify_translation_plans p ON (p.tenant_id,p.id)=(i.tenant_id,i.plan_id) WHERE i.batch_id=$1 ORDER BY i.position`,
      [id],
    )
  ).rows;
function detail(b: any, rows: any[]) {
  const summary: any = {
    total: rows.length,
    pending: 0,
    ready: 0,
    queued: 0,
    done: 0,
    uncertain: 0,
    failed: 0,
    cancelled: 0,
    conflict: 0,
    abandoned: 0,
    needs_replace: 0,
  };
  for (const i of rows) {
    i.state = i.plan?.state === 'preview' ? 'ready' : (i.plan?.state ?? i.state);
    summary[i.state] = (summary[i.state] ?? 0) + 1;
    i.needs_replace = !!i.plan?.needs_replace;
    if (i.needs_replace) summary.needs_replace++;
  }
  let state = b.state;
  if (b.state !== 'building') {
    if (summary.uncertain) state = 'uncertain';
    else if (summary.queued) state = rows.some((i) => i.plan?.attempted_at) ? 'running' : 'queued';
    else if (summary.done === summary.total) state = 'done';
    else if (summary.cancelled === summary.total) state = 'cancelled';
    else if (b.state === 'queued' || b.state === 'cancelled')
      state = summary.done
        ? 'partial'
        : summary.failed + summary.conflict + summary.abandoned
          ? 'failed'
          : b.state;
  }
  return {
    ...b,
    state,
    batch_state: b.state,
    simulation: rows.length > 0 && rows.every((i) => i.plan?.remote_snapshot?.simulation),
    needs_replace: summary.needs_replace > 0,
    summary,
    items: rows,
  };
}
export async function translationBatchDetail(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    const b = await batchRow(c, id);
    ensure(b, 404, 'Nie znaleziono partii');
    return detail(b, await items(c, id));
  });
}
export async function translationBatchSelection(a: Actor, ids: string[]) {
  return tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    // A deleted product (225) counts as missing.
    const deletions = await productDeletionsAvailable(c);
    const ps = (
      await c.query(
        `SELECT id,sku,name,version FROM products WHERE id=ANY($1::uuid[]) AND ${productNotDeletedSQL(deletions, 'products')} ORDER BY sku,id`,
        [ids],
      )
    ).rows;
    ensure(ps.length === ids.length, 404, 'Nie znaleziono wybranych produktów');
    const ts = (
      await c.query(
        'SELECT product_id,locale,version,name FROM product_translations WHERE product_id=ANY($1::uuid[]) ORDER BY locale LIMIT 5001',
        [ids],
      )
    ).rows;
    const ls = (
      await c.query(
        "SELECT l.id,l.product_id,l.channel_id,l.external_id,ch.name channel_name,coalesce((ch.settings->>'simulation')::boolean,false) simulation FROM listings l JOIN channels ch ON (ch.tenant_id,ch.id)=(l.tenant_id,l.channel_id) WHERE l.product_id=ANY($1::uuid[]) AND ch.provider='shopify' AND l.external_id LIKE 'gid://shopify/ProductVariant/%' ORDER BY ch.name,l.id LIMIT 1001",
        [ids],
      )
    ).rows;
    ensure(ts.length <= 5000, 422, 'Zbyt wiele wersji językowych; ogranicz wybór produktów');
    ensure(ls.length <= 1000, 422, 'Zbyt wiele powiązań; ogranicz wybór produktów');
    return {
      products: ps.map((p) => ({
        ...p,
        translations: ts.filter((t) => t.product_id === p.id),
        mappings: ls.filter((l) => l.product_id === p.id),
      })),
    };
  });
}
export async function translationBatchHistory(a: Actor, page?: string) {
  const after = translationCursor(page);
  return tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    const bs = (
      await c.query(
        `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time FROM shopify_translation_batches ${after ? 'WHERE (created_at,id)<($1::timestamptz,$2::uuid)' : ''} ORDER BY created_at DESC,id DESC LIMIT 21`,
        after ? [...after] : [],
      )
    ).rows;
    const data = [];
    for (const b of bs.slice(0, 20)) {
      const d = detail(b, await items(c, b.id));
      data.push({ ...d, items: undefined });
    }
    return {
      data,
      meta: {
        cursor:
          bs.length > 20
            ? Buffer.from(JSON.stringify([bs[19].cursor_time, bs[19].id])).toString('base64url')
            : null,
      },
      channels: (
        await c.query(
          "SELECT id,name,coalesce((settings->>'simulation')::boolean,false) simulation FROM channels WHERE provider='shopify' ORDER BY name,id LIMIT 100",
        )
      ).rows,
      local_locales: (
        await c.query('SELECT DISTINCT locale FROM product_translations ORDER BY locale')
      ).rows.map((x) => x.locale),
    };
  });
}
export async function previewTranslationBatch(
  a: Actor,
  b: z.infer<typeof translationBatchInput>,
  ctx: IntegrationContext = {},
) {
  const requestHash = hash({
    ...b,
    fields: [...b.fields].sort(),
    items: [...b.items].sort((a, b) => a.product_id.localeCompare(b.product_id)),
  });
  const batch = await tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'shopify.translation.batch-key:' + a.tenantId + ':' + b.client_key,
    ]);
    const old = (
      await c.query('SELECT * FROM shopify_translation_batches WHERE client_key=$1', [b.client_key])
    ).rows[0];
    if (old) {
      ensure(old.request_hash === requestHash, 409, 'Klucz partii wykorzystano dla innych danych');
      return old;
    }
    ensure(
      (
        await c.query("SELECT id FROM channels WHERE id=$1 AND provider='shopify' FOR SHARE", [
          b.channel_id,
        ])
      ).rowCount,
      404,
      'Nie znaleziono kanału Shopify',
    );
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'shopify.translation.batch-admission:' + a.tenantId,
    ]);
    ensure(
      Number(
        (
          await c.query(
            "SELECT count(*) n FROM shopify_translation_batches WHERE state IN ('building','preview') AND expires_at>now()",
          )
        ).rows[0].n,
      ) < 20,
      429,
      'Firma ma już 20 aktualnych partii',
    );
    const ps = (
      await c.query(
        'SELECT p.id,p.sku,p.name,l.id listing_id,l.channel_id FROM products p JOIN listings l ON (l.tenant_id,l.product_id)=(p.tenant_id,p.id) WHERE p.id=ANY($1::uuid[]) AND l.id=ANY($2::uuid[]) FOR SHARE OF p,l',
        [b.items.map((i) => i.product_id), b.items.map((i) => i.listing_id)],
      )
    ).rows;
    for (const i of b.items)
      ensure(
        ps.some(
          (p) =>
            p.id === i.product_id && p.listing_id === i.listing_id && p.channel_id === b.channel_id,
        ),
        404,
        'Powiązanie nie należy do wybranego produktu i kanału',
      );
    const id = randomUUID();
    const out = (
      await c.query(
        'INSERT INTO shopify_translation_batches(id,tenant_id,actor_id,channel_id,client_key,request_hash,local_locale,target_locale,fields) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [
          id,
          a.tenantId,
          a.userId,
          b.channel_id,
          b.client_key,
          requestHash,
          b.local_locale,
          b.target_locale,
          JSON.stringify(b.fields),
        ],
      )
    ).rows[0];
    for (const [n, i] of b.items.entries()) {
      const p = ps.find((p) => p.id === i.product_id)!;
      await c.query(
        'INSERT INTO shopify_translation_batch_items(tenant_id,batch_id,position,product_id,listing_id,version,translation_version,sku,name,client_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          a.tenantId,
          id,
          n,
          i.product_id,
          i.listing_id,
          i.version,
          i.translation_version,
          p.sku,
          p.name,
          randomUUID(),
        ],
      );
    }
    await audit(c, a, 'shopify.translation.batch.preview', id, {
      count: b.items.length,
      target_locale: b.target_locale,
    });
    return out;
  });
  if (batch.state !== 'building') return translationBatchDetail(a, batch.id);
  const lease = lockDbClient(new pg.Client({
    connectionString: pool.options.connectionString,
    connectionTimeoutMillis: 5000,
  }), 'shopify-translation-batches');
  await lease.connect();
  const key = 'shopify.translation.batch-build:' + batch.id;
  let locked = false;
  try {
    return await holdingDbLock(lease, async () => {
    locked = !!(await lease.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok', [key]))
      .rows[0].ok;
    if (!locked) return translationBatchDetail(a, batch.id);
    const pending = await tenantTx(a.tenantId, async (c) => {
      await admin(c, a);
      return (await items(c, batch.id)).filter((i) => i.state === 'pending');
    });
    for (const i of pending) {
      let plan: any, error: string | undefined;
      try {
        ensure(new Date(batch.expires_at).getTime() > Date.now(), 409, 'Podgląd partii wygasł');
        plan = await previewTranslation(
          a,
          i.product_id,
          {
            client_key: i.client_key,
            listing_id: i.listing_id,
            version: i.version,
            translation_version: i.translation_version,
            local_locale: batch.local_locale,
            target_locale: batch.target_locale,
            fields: batch.fields,
          },
          ctx,
        );
      } catch (e) {
        error = e instanceof Problem ? e.message : 'Nie udało się przygotować podglądu Shopify';
      }
      await tenantTx(a.tenantId, async (c) => {
        await admin(c, a);
        await c.query(
          "UPDATE shopify_translation_batch_items SET state=$3,plan_id=$4,error=$5 WHERE batch_id=$1 AND position=$2 AND state='pending'",
          [batch.id, i.position, plan ? 'ready' : 'failed', plan?.id ?? null, error ?? null],
        );
      });
    }
    await tenantTx(a.tenantId, async (c) => {
      await admin(c, a);
      await c.query(
        "UPDATE shopify_translation_batches SET state='preview',updated_at=now() WHERE id=$1 AND state='building' AND NOT EXISTS(SELECT 1 FROM shopify_translation_batch_items WHERE batch_id=$1 AND state='pending')",
        [batch.id],
      );
    });
    return translationBatchDetail(a, batch.id);
    });
  } finally {
    if (locked) await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
    await lease.end();
  }
}
export async function queueTranslationBatch(
  a: Actor,
  id: string,
  body: z.infer<typeof translationConsent>,
) {
  await tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    await batchLock(c, id);
    const b = await batchRow(c, id, true);
    ensure(b, 404, 'Nie znaleziono partii');
    if (b.consent) {
      ensure(hash(b.consent) === hash(body), 409, 'Zgoda różni się od zapisanej partii');
      return;
    }
    ensure(
      b.state === 'preview' && new Date(b.expires_at).getTime() > Date.now(),
      409,
      'Podgląd partii wygasł lub nie jest dostępny',
    );
    const rows = await items(c, id);
    ensure(
      rows.length > 0 && rows.every((i) => i.state === 'ready' && i.plan?.state === 'preview'),
      409,
      'Każdy produkt wymaga poprawnego aktualnego podglądu',
    );
    const keys = rows.map((i) =>
      hash([i.plan.shop_id, i.plan.remote_product_id, i.plan.target_locale]),
    );
    ensure(
      new Set(keys).size === keys.length,
      409,
      'Dwa produkty partii dotyczą tego samego produktu Shopify i języka; wybierz jeden wariant',
    );
    // Stable ordering shared by competing batches prevents deadlocks on per-plan/claim locks.
    rows.sort((x, y) => x.plan.id.localeCompare(y.plan.id));
    for (const i of rows)
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'shopify.translation.plan:' + i.plan_id,
      ]);
    ensure(
      (
        await c.query(
          "SELECT id FROM shopify_translation_plans WHERE id=ANY($1::uuid[]) AND state='preview'",
          [rows.map((i) => i.plan_id)],
        )
      ).rowCount === rows.length,
      409,
      'Stan produktu zmienił się podczas zatwierdzania partii',
    );
    for (const i of rows) await queueTranslationInTx(c, a, i.plan_id, body);
    await c.query(
      "UPDATE shopify_translation_batches SET state='queued',consent=$2,queued_actor=$3,queued_at=now(),updated_at=now() WHERE id=$1",
      [id, JSON.stringify(body), a.userId],
    );
    await audit(c, a, 'shopify.translation.batch.queue', id, { count: rows.length, consent: body });
  });
  return translationBatchDetail(a, id);
}
export async function cancelTranslationBatch(a: Actor, id: string) {
  const rows = await tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    await batchLock(c, id);
    const b = await batchRow(c, id, true);
    ensure(b, 404, 'Nie znaleziono partii');
    ensure(b.state !== 'building', 409, 'Poczekaj na zakończenie podglądu');
    if (b.state !== 'cancelled')
      await c.query(
        "UPDATE shopify_translation_batches SET state='cancelled',updated_at=now() WHERE id=$1",
        [id],
      );
    await audit(c, a, 'shopify.translation.batch.cancel', id, {
      unattempted_only: true,
      resumable: true,
    });
    return items(c, id);
  });
  // Each child keeps its own job→plan lock order. No transaction retains several
  // job locks while the global lease reaper can acquire them in a different order.
  // A repeated cancel resumes any remaining fresh children after interruption.
  for (const i of rows.filter(
    (i) => i.plan?.phase === 'fresh' && ['preview', 'queued'].includes(i.plan.state),
  )) {
    try {
      await cancelTranslation(a, i.plan_id);
    } catch (e) {
      if (!(e instanceof Problem && e.status === 409)) throw e;
    }
  }
  return translationBatchDetail(a, id);
}
// Explicit recovery of a interrupted preview uses the already frozen selection.
// This can only resume safe provider reads; queue/write consent is a separate route.
export async function resumeTranslationBatch(a: Actor, id: string, ctx: IntegrationContext = {}) {
  const b = await tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    const b = await batchRow(c, id);
    ensure(b, 404, 'Nie znaleziono partii');
    const rows = await items(c, id);
    return {
      client_key: b.client_key,
      channel_id: b.channel_id,
      local_locale: b.local_locale,
      target_locale: b.target_locale,
      fields: b.fields,
      items: rows.map((i) => ({
        product_id: i.product_id,
        listing_id: i.listing_id,
        version: i.version,
        translation_version: i.translation_version,
      })),
    };
  });
  return previewTranslationBatch(a, translationBatchInput.parse(b), ctx);
}
