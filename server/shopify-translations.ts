import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { channelRead, type IntegrationContext } from './channel-access';
import { importConnectionHash } from './imports';
import { shopifyAccountPolicy } from './shopify-oauth';
import { Shopify, shopifyId, shopifyStore } from './shopify';
import { shopifyFulfillmentHash as hash } from './shopify-fulfillment';
import { effectiveShopifyScopes } from './shopify-auth-input';
import {
  parseProductTranslation,
  prepareProductTranslation,
  translationPreviewMatches,
  translationReadback,
  translationDescriptionHtml,
  shopifyTranslationLocale,
  type ShopifyProductTranslation,
} from './shopify-translation-api';
export const translationPublicationInput = z
  .strictObject({
    client_key: z.uuid(),
    listing_id: z.uuid(),
    version: z.number().int().positive(),
    local_locale: z
      .string()
      .max(40)
      .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/),
    translation_version: z.number().int().positive(),
    target_locale: shopifyTranslationLocale,
    fields: z
      .array(z.enum(['title', 'body_html']))
      .min(1)
      .max(2),
  })
  .refine((v) => new Set(v.fields).size === v.fields.length, 'Powtórzone pola');
export const translationConsent = z.strictObject({
  external_authorized: z.boolean().default(false),
  replace_existing: z.boolean().default(false),
  confirm_product_scope: z.boolean().default(false),
});
// Keyset cursors contain no SQL fragments and are bound to the product/plan in each query.
export function translationCursor(value?: string) {
  if (!value) return null;
  try {
    return z
      .tuple([z.string().datetime(), z.uuid()])
      .parse(JSON.parse(Buffer.from(z.string().max(300).parse(value), 'base64url').toString()));
  } catch {
    throw new Problem(422, 'Nieprawidłowy kursor historii tłumaczeń');
  }
}
const cursor = (r: any) => Buffer.from(JSON.stringify([r.cursor_time, r.id])).toString('base64url');
async function admin(c: PoolClient, a: Actor) {
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) ok', [a.userId])).rows[0]?.ok,
    403,
    'Wymagany aktualny administrator',
  );
}
async function connection(c: PoolClient, a: Actor, id: string, expected?: string) {
  await admin(c, a);
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [id])).rows[0];
  ensure(ch?.provider === 'shopify', 404, 'Nie znaleziono połączenia Shopify');
  ensure(
    !expected || importConnectionHash(ch) === expected,
    409,
    'Połączenie Shopify zmieniło się',
  );
  await shopifyAccountPolicy(c, ch);
  const binding = (
    await c.query('SELECT * FROM shopify_account_bindings WHERE channel_id=$1 FOR SHARE', [id])
  ).rows[0];
  if (ch.settings.simulation)
    ensure(
      binding?.source === 'simulation',
      409,
      'Zakończ lokalne połączenie Shopify z uprawnieniem tłumaczeń',
    );
  return {
    ch,
    binding,
    store: ch.settings.simulation ? binding.store_url : shopifyStore(ch.settings.store_url),
  };
}
const getPlan = async (c: PoolClient, id: string, lock = false) =>
  (
    await c.query(
      'SELECT * FROM shopify_translation_plans WHERE id=$1' + (lock ? ' FOR UPDATE' : ''),
      [id],
    )
  ).rows[0];
const lockPlan = async (c: PoolClient, id: string) => {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'shopify.translation.plan:' + id,
  ]);
};
async function local(
  c: PoolClient,
  a: Actor,
  productId: string,
  listingId: string,
  locale: string,
) {
  await admin(c, a);
  const p = (await c.query('SELECT * FROM products WHERE id=$1 FOR SHARE', [productId])).rows[0];
  ensure(p, 404, 'Nie znaleziono produktu');
  const l = (await c.query('SELECT * FROM listings WHERE id=$1 FOR SHARE', [listingId])).rows[0];
  ensure(l?.product_id === productId, 404, 'Nie znaleziono powiązania produktu');
  shopifyId(l.external_id, 'ProductVariant');
  const t = (
    await c.query(
      'SELECT * FROM product_translations WHERE product_id=$1 AND locale=$2 FOR SHARE',
      [productId, locale],
    )
  ).rows[0];
  ensure(t, 404, 'Brak zatwierdzonego tłumaczenia');
  let d: any;
  if (t.manual_receipt_id) {
    const receipt = (
      await c.query(
        `SELECT r.*,e.state FROM product_translation_bulk_edit_execution_rows r JOIN product_translation_bulk_edit_executions e ON (e.tenant_id,e.id)=(r.tenant_id,r.execution_id) WHERE r.id=$1 AND r.product_id=$2 AND r.locale=$3`,
        [t.manual_receipt_id, p.id, locale],
      )
    ).rows[0];
    ensure(
      receipt?.state === 'done' &&
        receipt.status === 'changed' &&
        receipt.operation === 'set' &&
        receipt.after?.present === true &&
        receipt.after.version === t.version &&
        receipt.after.name === t.name &&
        receipt.after.description === t.description &&
        receipt.after.provenance?.kind === 'manual' &&
        receipt.after.provenance.id === t.manual_receipt_id,
      409,
      'Ręczne tłumaczenie nie odpowiada zatwierdzonemu dowodowi',
    );
    // Price/logistics edits do not invalidate origin; source content still must match.
    d = { source: receipt.source };
  } else {
    const table = t.ai_draft_id ? 'ai_catalog_drafts' : 'deepl_catalog_drafts',
      draftId = t.ai_draft_id ?? t.deepl_draft_id;
    d = (await c.query(`SELECT * FROM ${table} WHERE id=$1 FOR SHARE`, [draftId])).rows[0];
    ensure(
      d?.state === 'applied' &&
        d.product_id === p.id &&
        (t.ai_draft_id
          ? d.destination === 'translation' && d.locale === locale
          : d.target_lang === locale) &&
        hash(d.reviewed_text) === hash({ name: t.name, description: t.description }),
      409,
      'Pochodzenie tłumaczenia nie odpowiada zatwierdzonej treści',
    );
  }
  ensure(
    Object.keys(d.source).length > 0 &&
      Object.entries(d.source).every(
        ([key, value]) => Object.hasOwn(p, key) && hash(p[key]) === hash(value),
      ),
    409,
    'Źródło lokalnego tłumaczenia zmieniło się; przygotuj i zatwierdź aktualne tłumaczenie',
  );
  return {
    p,
    l,
    t,
    snapshot: {
      product_version: p.version,
      sku: p.sku,
      name: p.name,
      description: p.description,
      attributes: p.attributes,
      category: p.category,
      listing: {
        id: l.id,
        channel_id: l.channel_id,
        external_id: l.external_id,
        product_id: l.product_id,
      },
      translation: {
        locale: t.locale,
        version: t.version,
        name: t.name,
        description: t.description,
        ai_draft_id: t.ai_draft_id,
        deepl_draft_id: t.deepl_draft_id,
        ...(t.manual_receipt_id ? { manual_receipt_id: t.manual_receipt_id } : {}),
        updated_at: new Date(t.updated_at).toISOString(),
      },
    },
  };
}
async function planPolicy(c: PoolClient, a: Actor, p: any, write = false) {
  // A new grant may read an already attempted result for the same frozen shop.
  // It can never execute the old write or make an unattempted preview current.
  const conn = await connection(
    c,
    a,
    p.channel_id,
    write || p.phase === 'fresh' ? p.connection_hash : undefined,
  );
  ensure(
    conn.store === p.store_url &&
      Boolean(conn.ch.settings.simulation) === Boolean(p.remote_snapshot.simulation) &&
      (!conn.binding || conn.binding.shop_id === p.shop_id),
    409,
    'Tożsamość sklepu Shopify zmieniła się',
  );
  if (write) {
    const x = await local(c, a, p.product_id, p.listing_id, p.local_locale);
    ensure(
      x.l.channel_id === p.channel_id && hash(x.snapshot) === hash(p.local_snapshot),
      409,
      'Produkt, powiązanie lub tłumaczenie zmieniło się po podglądzie',
    );
  }
  return conn;
}
async function readRemote(
  a: Actor,
  ch: any,
  ids: { productId: string; variantId: string; locale: string; shopId?: string },
  productId: string,
  ctx: IntegrationContext,
  extra?: () => Promise<void>,
  evidenceOnly = false,
): Promise<ShopifyProductTranslation> {
  const fence = async () => {
    await extra?.();
    await tenantTx(a.tenantId, (c) => connection(c, a, ch.id, importConnectionHash(ch)));
  };
  await fence();
  if (ch.settings.simulation)
    return tenantTx(a.tenantId, async (c) => {
      const conn = await connection(c, a, ch.id, importConnectionHash(ch)),
        p = (await c.query('SELECT name,description FROM products WHERE id=$1', [productId]))
          .rows[0];
      ensure(p, 404, 'Produkt nie istnieje');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'shopify.translation.sim:' + ch.id + ':' + ids.productId,
      ]);
      let sim = (
        await c.query(
          'SELECT data FROM shopify_translation_simulations WHERE channel_id=$1 AND remote_product_id=$2 AND target_locale=$3',
          [ch.id, ids.productId, ids.locale],
        )
      ).rows[0]?.data;
      if (!sim) {
        const old = (
          await c.query(
            'SELECT data FROM shopify_translation_simulations WHERE channel_id=$1 AND remote_product_id=$2 ORDER BY target_locale LIMIT 1',
            [ch.id, ids.productId],
          )
        ).rows[0]?.data;
        const source = old?.source ?? [
          { key: 'title', locale: 'pl', value: p.name, digest: hash(['title', p.name]) },
          {
            key: 'body_html',
            locale: 'pl',
            value: translationDescriptionHtml(p.description),
            digest: hash(['body_html', translationDescriptionHtml(p.description)]),
          },
        ];
        sim = { source, translations: [] };
        await c.query(
          'INSERT INTO shopify_translation_simulations(tenant_id,channel_id,remote_product_id,target_locale,data) VALUES($1,$2,$3,$4,$5)',
          [a.tenantId, ch.id, ids.productId, ids.locale, JSON.stringify(sim)],
        );
      }
      const l = (
        await c.query(
          'SELECT last_result FROM listings WHERE channel_id=$1 AND external_id=$2 LIMIT 1',
          [ch.id, ids.variantId],
        )
      ).rows[0];
      return parseProductTranslation(
        {
          shop: { id: conn.binding.shop_id, myshopifyDomain: new URL(conn.store).hostname },
          currentAppInstallation: {
            accessScopes: effectiveShopifyScopes(conn.binding.scopes).map((handle) => ({ handle })),
          },
          shopLocales: [
            { locale: 'pl', name: 'Polski', primary: true, published: true },
            { locale: 'de', name: 'Niemiecki', primary: false, published: true },
            { locale: 'en', name: 'Angielski', primary: false, published: true },
            { locale: 'fr', name: 'Francuski', primary: false, published: false },
          ],
          productVariant: {
            id: ids.variantId,
            sku: l?.last_result?.sku ?? null,
            product: { id: ids.productId },
          },
          translatableResource: {
            resourceId: ids.productId,
            translatableContent: sim.source,
            translations: sim.translations,
          },
        },
        new URL(conn.store).hostname,
        ids,
      );
    });
  return channelRead(
    a.tenantId,
    ch.id,
    (client) =>
      evidenceOnly
        ? (client as Shopify).productTranslationEvidence({ ...ids, shopId: ids.shopId! }, fence)
        : (client as Shopify).productTranslation(ids, fence),
    ctx,
    true,
    async () => fence(),
  );
}
async function observation(c: PoolClient, p: any, s: ShopifyProductTranslation) {
  const fields = translationReadback(s, p.spec),
    data = {
      fields,
      source: s.source,
      translations: s.translations,
      locales: s.locales,
      variant_observed: s.variantObserved,
      resource_present: s.resourcePresent,
    };
  const row = (
    await c.query(
      'INSERT INTO shopify_translation_observations(id,tenant_id,plan_id,data,source) VALUES($1,$2,$3,$4,$5) RETURNING id,created_at',
      [
        randomUUID(),
        p.tenant_id,
        p.id,
        JSON.stringify(data),
        p.remote_snapshot.simulation ? 'local_simulation' : 'graphql',
      ],
    )
  ).rows[0];
  return {
    observation_id: row.id,
    observed_at: new Date(row.created_at).toISOString(),
    fields,
    confirmed: fields.every((f) => f.confirmed),
  };
}
export async function translationHistory(a: Actor, product: string, page?: string) {
  const after = translationCursor(page);
  return tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    const productRow = (await c.query('SELECT id,version FROM products WHERE id=$1', [product]))
      .rows[0];
    ensure(productRow, 404, 'Nie znaleziono produktu');
    const rows = (
      await c.query(
        `SELECT id,channel_id,local_locale,target_locale,state,phase,needs_replace,error,job_id,result,expires_at,created_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time FROM shopify_translation_plans WHERE product_id=$1 ${after ? 'AND (created_at,id)<($2::timestamptz,$3::uuid)' : ''} ORDER BY created_at DESC,id DESC LIMIT 21`,
        after ? [product, ...after] : [product],
      )
    ).rows;
    return {
      product_version: productRow.version,
      data: rows.slice(0, 20),
      meta: { cursor: rows.length > 20 ? cursor(rows[19]) : null },
      translations: (
        await c.query(
          "SELECT locale,version,name,description,ai_draft_id,deepl_draft_id,to_jsonb(t)->>'manual_receipt_id' manual_receipt_id FROM product_translations t WHERE product_id=$1 ORDER BY locale",
          [product],
        )
      ).rows,
      mappings: (
        await c.query(
          "SELECT l.id,l.external_id,l.channel_id,ch.name,ch.settings->>'simulation'='true' simulation FROM listings l JOIN channels ch ON (ch.tenant_id,ch.id)=(l.tenant_id,l.channel_id) WHERE l.product_id=$1 AND ch.provider='shopify' AND l.external_id LIKE 'gid://shopify/ProductVariant/%' ORDER BY ch.name,l.id LIMIT 100",
          [product],
        )
      ).rows,
    };
  });
}
export async function translationDetail(a: Actor, id: string, page?: string) {
  const after = translationCursor(page);
  return tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    const p = await getPlan(c, id);
    ensure(p, 404, 'Nie znaleziono planu tłumaczenia');
    const rows = (
      await c.query(
        `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time FROM shopify_translation_observations WHERE plan_id=$1 ${after ? 'AND (created_at,id)<($2::timestamptz,$3::uuid)' : ''} ORDER BY created_at DESC,id DESC LIMIT 11`,
        after ? [id, ...after] : [id],
      )
    ).rows;
    return {
      ...p,
      observations: rows.slice(0, 10),
      meta: { cursor: rows.length > 10 ? cursor(rows[9]) : null },
    };
  });
}
export async function previewTranslation(
  a: Actor,
  product: string,
  b: z.infer<typeof translationPublicationInput>,
  ctx: IntegrationContext = {},
) {
  const requestHash = hash({ product, ...b, fields: [...b.fields].sort() });
  const initial = await tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    const prior = (
      await c.query('SELECT * FROM shopify_translation_plans WHERE client_key=$1', [b.client_key])
    ).rows[0];
    if (prior) {
      ensure(
        prior.request_hash === requestHash,
        409,
        'Klucz podglądu wykorzystano dla innych danych',
      );
      return { reused: true as const, prior };
    }
    const x = await local(c, a, product, b.listing_id, b.local_locale);
    ensure(
      x.p.version === b.version && x.t.version === b.translation_version,
      409,
      'Odśwież produkt i tłumaczenie',
    );
    const conn = await connection(c, a, x.l.channel_id);
    return { reused: false as const, ...x, ...conn };
  });
  if (initial.reused) return initial.prior;
  const { ch, l, t, snapshot, binding } = initial;
  const extra = async () => {
    await tenantTx(a.tenantId, async (c) => {
      const x = await local(c, a, product, l.id, b.local_locale);
      ensure(hash(x.snapshot) === hash(snapshot), 409, 'Dane zmieniły się w czasie podglądu');
    });
  };
  let remoteProduct = l.last_result?.product_id;
  if (!remoteProduct) {
    if (ch.settings.simulation) remoteProduct = 'gid://shopify/Product/702';
    else
      remoteProduct = (
        await channelRead(
          a.tenantId,
          ch.id,
          async (client) => {
            await extra();
            return (client as Shopify).translationProductIdentity(
              l.external_id,
              extra,
              binding?.shop_id,
            );
          },
          ctx,
          true,
          async () => extra(),
        )
      ).productId;
  }
  shopifyId(remoteProduct, 'Product');
  const remote = await readRemote(
    a,
    ch,
    {
      productId: remoteProduct,
      variantId: l.external_id,
      locale: b.target_locale,
      shopId: binding?.shop_id,
    },
    product,
    ctx,
    extra,
  );
  const spec = prepareProductTranslation(remote, {
    ...(b.fields.includes('title') ? { name: t.name } : {}),
    ...(b.fields.includes('body_html') ? { description: t.description } : {}),
  });
  const needsReplace = spec.translations.some((f) =>
    remote.translations.some(
      (t) => t.market === null && t.key === f.key && (t.value !== f.value || t.outdated),
    ),
  );
  return tenantTx(a.tenantId, async (c) => {
    const conn = await connection(c, a, ch.id, importConnectionHash(ch)),
      x = await local(c, a, product, l.id, b.local_locale);
    ensure(hash(x.snapshot) === hash(snapshot), 409, 'Dane zmieniły się po odczycie');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'shopify.translation.preview-key:' + a.tenantId + ':' + b.client_key,
    ]);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'shopify.translation.preview:' + a.tenantId + ':' + product,
    ]);
    const prior = (
      await c.query('SELECT * FROM shopify_translation_plans WHERE client_key=$1', [b.client_key])
    ).rows[0];
    if (prior) {
      ensure(
        prior.request_hash === requestHash,
        409,
        'Klucz podglądu wykorzystano dla innych danych',
      );
      return prior;
    }
    ensure(
      Number(
        (
          await c.query(
            "SELECT count(*) n FROM shopify_translation_plans WHERE product_id=$1 AND state='preview' AND expires_at>now()",
            [product],
          )
        ).rows[0].n,
      ) < 20,
      429,
      'Produkt ma już 20 aktualnych podglądów',
    );
    const plan = (
      await c.query(
        `INSERT INTO shopify_translation_plans(id,tenant_id,channel_id,product_id,listing_id,actor_id,client_key,request_hash,connection_hash,store_url,shop_id,remote_product_id,remote_variant_id,local_locale,target_locale,local_snapshot,remote_snapshot,spec,needs_replace) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [
          randomUUID(),
          a.tenantId,
          ch.id,
          product,
          l.id,
          a.userId,
          b.client_key,
          requestHash,
          importConnectionHash(ch),
          conn.store,
          remote.shopId,
          remote.productId,
          remote.variantId,
          b.local_locale,
          b.target_locale,
          JSON.stringify(snapshot),
          JSON.stringify({ ...remote, simulation: !!ch.settings.simulation }),
          JSON.stringify(spec),
          needsReplace,
        ],
      )
    ).rows[0];
    await audit(c, a, 'shopify.translation.preview', plan.id, {
      product_id: product,
      locale: b.target_locale,
      fields: b.fields,
      simulation: !!ch.settings.simulation,
    });
    return plan;
  });
}
export async function queueTranslation(
  a: Actor,
  id: string,
  body: z.infer<typeof translationConsent>,
) {
  return tenantTx(a.tenantId, (c) => queueTranslationInTx(c, a, id, body));
}
export async function queueTranslationInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  body: z.infer<typeof translationConsent>,
) {
  await admin(c, a);
  await lockPlan(c, id);
  const p = await getPlan(c, id, true);
  ensure(p, 404, 'Nie znaleziono planu');
  if (['queued', 'done'].includes(p.state)) {
    ensure(hash(body) === hash(p.consent), 409, 'Zgoda różni się od zapisanego zlecenia');
    return { id, state: p.state, reused: true };
  }
  ensure(
    p.state === 'preview' && p.phase === 'fresh' && new Date(p.expires_at).getTime() > Date.now(),
    409,
    'Podgląd wygasł lub nie jest dostępny',
  );
  const conn = await planPolicy(c, a, p, true);
  ensure(
    body.confirm_product_scope &&
      (!p.needs_replace || body.replace_existing) &&
      (conn.ch.settings.simulation || body.external_authorized),
    422,
    'Zatwierdź zakres produktu, zastąpienie istniejącej treści i zapis zewnętrzny',
  );
  ensure(
    Number(
      (
        await c.query(
          "SELECT count(*) n FROM shopify_translation_plans WHERE state IN ('queued','uncertain')",
        )
      ).rows[0].n,
    ) < 100,
    429,
    'Firma ma już 100 aktywnych lub nieuzgodnionych publikacji',
  );
  ensure(
    (await c.query('SELECT shopify_translation_claim($1) ok', [id])).rows[0].ok,
    409,
    'Inna publikacja tego produktu i języka wymaga zakończenia lub odczytu; kolejka może też być pełna',
  );
  const job = randomUUID();
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,'shopify.translation',$3,$4,1)",
    [
      job,
      a.tenantId,
      JSON.stringify({ plan_id: id, actor_id: a.userId, channel_id: p.channel_id }),
      'shopify.translation:' + id,
    ],
  );
  await c.query(
    "UPDATE shopify_translation_plans SET state='queued',consent=$2,queued_actor=$3,queued_at=now(),job_id=$4,updated_at=now() WHERE id=$1",
    [id, JSON.stringify(body), a.userId, job],
  );
  await audit(c, a, 'shopify.translation.queue', id, {
    simulation: !!conn.ch.settings.simulation,
    consent: body,
  });
  return { id, state: 'queued', reused: false };
}

async function guard(c: PoolClient, job: any, write = false) {
  await lockPlan(c, job.payload.plan_id);
  const j = (
    await c.query(
      "SELECT * FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
      [job.id, job.lease_token],
    )
  ).rows[0];
  if (!j) return null;
  const p = await getPlan(c, job.payload.plan_id, true);
  ensure(
    p &&
      p.job_id === job.id &&
      p.state === 'queued' &&
      j.kind === 'shopify.translation' &&
      j.payload.actor_id === p.queued_actor &&
      job.payload.actor_id === p.queued_actor &&
      j.payload.channel_id === p.channel_id,
    409,
    'Zadanie publikacji zmieniło się',
  );
  const a: Actor = { tenantId: job.tenant_id, userId: p.queued_actor, role: 'admin' },
    conn = await planPolicy(c, a, p, write || p.phase === 'fresh');
  ensure(
    (await c.query('SELECT shopify_translation_claimed($1) ok', [p.id])).rows[0].ok,
    409,
    'Utracono blokadę publikacji',
  );
  ensure(
    p.consent.confirm_product_scope &&
      (!p.needs_replace || p.consent.replace_existing) &&
      (conn.ch.settings.simulation || p.consent.external_authorized),
    409,
    'Brak zgody na publikację',
  );
  await c.query('UPDATE jobs SET locked_at=now() WHERE id=$1', [job.id]);
  return { p, a, ...conn };
}
async function finish(c: PoolClient, p: any, a: Actor, s: ShopifyProductTranslation) {
  const result = { ...p.result, ...(await observation(c, p, s)) };
  await c.query(
    'UPDATE shopify_translation_plans SET state=$2,phase=$3,result=$4,error=$5,updated_at=now() WHERE id=$1',
    [
      p.id,
      result.confirmed ? 'done' : 'uncertain',
      result.confirmed ? 'done' : 'attempted',
      JSON.stringify(result),
      result.confirmed ? null : 'Odczyt nie potwierdził wszystkich pól; nie ponowiono zapisu',
    ],
  );
  if (result.confirmed) await c.query('SELECT shopify_translation_release($1)', [p.id]);
  await audit(
    c,
    a,
    result.confirmed ? 'shopify.translation.confirmed' : 'shopify.translation.uncertain',
    p.id,
    { observation_id: result.observation_id, simulation: p.remote_snapshot.simulation },
  );
  return result;
}
// A separate session lock covers HTTP without holding a tenant transaction or pool slot.
// A duplicate invocation with the same lease leaves the active worker in charge.
export async function processTranslation(job: any, ctx: IntegrationContext = {}) {
  const lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'shopify-translations');
  await lock.connect();
  try {
    return await holdingDbLock(lock, async () => {
    const { rows } = await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok', [
      'shopify.translation.worker:' + job.tenant_id + ':' + job.payload.plan_id,
    ]);
    if (!rows[0].ok) return;
    await runTranslation(job, ctx);
    });
  } finally {
    await lock.end();
  }
}
async function runTranslation(job: any, ctx: IntegrationContext) {
  const initial = await tenantTx(job.tenant_id, (c) => guard(c, job));
  if (!initial) return;
  const fence = async () =>
    ensure(
      await tenantTx(job.tenant_id, (c) => guard(c, job)),
      409,
      'Utracono dzierżawę publikacji',
    );
  const ids = {
    productId: initial.p.remote_product_id,
    variantId: initial.p.remote_variant_id,
    locale: initial.p.target_locale,
    shopId: initial.p.shop_id,
  };
  let remote = await readRemote(
    initial.a,
    initial.ch,
    ids,
    initial.p.product_id,
    ctx,
    fence,
    initial.p.phase === 'attempted',
  );
  if (initial.p.phase === 'fresh') {
    ensure(
      translationPreviewMatches(initial.p.remote_snapshot, remote, initial.p.spec),
      409,
      'Źródło lub istniejące tłumaczenie Shopify zmieniło się po podglądzie',
    );
    const already = translationReadback(remote, initial.p.spec).every((f) => f.confirmed);
    if (already) {
      await tenantTx(job.tenant_id, async (c) => {
        const cur = await guard(c, job, true);
        if (!cur) return;
        ensure(new Date(cur.p.expires_at).getTime() > Date.now(), 409, 'Podgląd wygasł');
        await finish(c, cur.p, cur.a, remote);
        await c.query(
          "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
          [job.id],
        );
      });
      return;
    }
    const mark = async (c: PoolClient) => {
      const cur = await guard(c, job, true);
      ensure(
        cur && cur.p.phase === 'fresh' && new Date(cur.p.expires_at).getTime() > Date.now(),
        409,
        'Podgląd wygasł lub próba zapisu już nastąpiła',
      );
      await observation(c, cur.p, remote);
      await c.query(
        "UPDATE shopify_translation_plans SET phase='attempted',attempted_at=now(),updated_at=now() WHERE id=$1",
        [cur.p.id],
      );
      return cur;
    };
    if (initial.ch.settings.simulation)
      await tenantTx(job.tenant_id, async (c) => {
        const cur = await mark(c),
          next = remote.translations.filter(
            (t) => t.market !== null || !cur.p.spec.translations.some((f: any) => f.key === t.key),
          );
        next.push(
          ...cur.p.spec.translations.map((f: any) => ({
            key: f.key,
            locale: f.locale,
            value: f.value,
            outdated: false,
            updatedAt: new Date().toISOString(),
            market: null,
          })),
        );
        await c.query(
          'UPDATE shopify_translation_simulations SET data=$4 WHERE channel_id=$1 AND remote_product_id=$2 AND target_locale=$3',
          [
            cur.ch.id,
            ids.productId,
            ids.locale,
            JSON.stringify({ source: remote.source, translations: next }),
          ],
        );
      });
    else {
      const reply = await channelRead(
        job.tenant_id,
        initial.ch.id,
        (client) =>
          (client as Shopify).registerProductTranslations(initial.p.spec, async () => {
            await tenantTx(job.tenant_id, mark);
          }),
        ctx,
        false,
        async () =>
          ensure(
            await tenantTx(job.tenant_id, (c) => guard(c, job, true)),
            409,
            'Utracono dzierżawę publikacji',
          ),
      );
      await tenantTx(job.tenant_id, async (c) => {
        const cur = await guard(c, job);
        if (cur)
          await c.query(
            "UPDATE shopify_translation_plans SET result=result||jsonb_build_object('mutation_response',$2::jsonb) WHERE id=$1",
            [cur.p.id, JSON.stringify(reply)],
          );
      });
    }
    remote = await readRemote(initial.a, initial.ch, ids, initial.p.product_id, ctx, fence, true);
  }
  await tenantTx(job.tenant_id, async (c) => {
    const cur = await guard(c, job);
    if (!cur) return;
    await finish(c, cur.p, cur.a, remote);
    await c.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
      [job.id],
    );
  });
}
export async function failTranslation(job: any, error: unknown) {
  await tenantTx(job.tenant_id, async (c) => {
    await lockPlan(c, job.payload.plan_id);
    const j = (
      await c.query(
        "SELECT * FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rows[0];
    if (!j) return;
    const p = await getPlan(c, job.payload.plan_id, true);
    if (!p || p.state !== 'queued' || p.job_id !== j.id) return;
    const msg =
      error instanceof Problem ? error.message : 'Błąd komunikacji Shopify; wynik wymaga odczytu';
    await c.query(
      'UPDATE shopify_translation_plans SET state=$2,error=$3,updated_at=now() WHERE id=$1',
      [
        p.id,
        p.phase === 'fresh'
          ? error instanceof Problem && error.status === 409
            ? 'conflict'
            : 'failed'
          : 'uncertain',
        msg,
      ],
    );
    if (p.phase === 'fresh') await c.query('SELECT shopify_translation_release($1)', [p.id]);
    await c.query(
      "UPDATE jobs SET state='done',error=$2,lease_token=NULL,locked_at=NULL WHERE id=$1",
      [job.id, msg],
    );
  });
}
export async function cancelTranslation(a: Actor, id: string) {
  return tenantTx(a.tenantId, (c) => cancelTranslationInTx(c, a, id));
}
export async function cancelTranslationInTx(c: PoolClient, a: Actor, id: string) {
  await admin(c, a);
  await lockPlan(c, id);
  const initial = await getPlan(c, id);
  ensure(initial, 404, 'Nie znaleziono planu');
  if (initial.job_id) await c.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [initial.job_id]);
  const p = await getPlan(c, id, true);
  if (p.state === 'cancelled') return { cancelled: true, reused: true };
  ensure(
    p.phase === 'fresh' && ['preview', 'queued'].includes(p.state),
    409,
    'Po rozpoczęciu próby zapisu można tylko odczytać wynik',
  );
  await c.query(
    "UPDATE shopify_translation_plans SET state='cancelled',updated_at=now() WHERE id=$1",
    [id],
  );
  if (p.job_id)
    await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1", [
      p.job_id,
    ]);
  await c.query('SELECT shopify_translation_release($1)', [id]);
  await audit(c, a, 'shopify.translation.cancel', id);
  return { cancelled: true, reused: false };
}

export async function reconcileTranslation(
  a: Actor,
  id: string,
  ctx: IntegrationContext = {},
  acknowledge = false,
) {
  const initial = await tenantTx(a.tenantId, async (c) => {
    const p = await getPlan(c, id);
    ensure(p, 404, 'Nie znaleziono planu');
    ensure(
      p.state === 'uncertain' && p.phase === 'attempted',
      409,
      'Plan nie wymaga odczytu wyniku',
    );
    const conn = await planPolicy(c, a, p);
    return { p, ...conn };
  });
  const fence = async () => {
    await tenantTx(a.tenantId, async (c) => {
      const p = await getPlan(c, id);
      ensure(p?.state === 'uncertain', 409, 'Plan zmienił się');
      await planPolicy(c, a, p);
      if (p.job_id)
        ensure(
          (await c.query('SELECT state FROM jobs WHERE id=$1', [p.job_id])).rows[0]?.state !==
            'running',
          409,
          'Poczekaj na zakończenie zadania',
        );
    });
  };
  const remote = await readRemote(
    a,
    initial.ch,
    {
      productId: initial.p.remote_product_id,
      variantId: initial.p.remote_variant_id,
      locale: initial.p.target_locale,
      shopId: initial.p.shop_id,
    },
    initial.p.product_id,
    ctx,
    fence,
    true,
  );
  return tenantTx(a.tenantId, async (c) => {
    await lockPlan(c, id);
    if (initial.p.job_id)
      await c.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [initial.p.job_id]);
    const p = await getPlan(c, id, true);
    ensure(p?.state === 'uncertain', 409, 'Plan zmienił się');
    await planPolicy(c, a, p);
    if (p.job_id)
      ensure(
        (await c.query('SELECT state FROM jobs WHERE id=$1 FOR UPDATE', [p.job_id])).rows[0]
          ?.state !== 'running',
        409,
        'Zadanie nadal pracuje',
      );
    const result = await finish(c, p, a, remote);
    if (acknowledge && !result.confirmed) {
      await c.query(
        "UPDATE shopify_translation_plans SET state='abandoned',acknowledged_by=$2,acknowledged_at=now(),updated_at=now() WHERE id=$1",
        [id, a.userId],
      );
      await c.query('SELECT shopify_translation_release($1)', [id]);
      await audit(c, a, 'shopify.translation.acknowledged', id, {
        observation_id: result.observation_id,
        no_retry: true,
      });
    }
    return {
      ...result,
      state: result.confirmed ? 'done' : acknowledge ? 'abandoned' : 'uncertain',
    };
  });
}
