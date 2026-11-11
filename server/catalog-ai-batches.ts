/** DOM-AI-003: batch generation with a result per item, on migration 249 (catalog_ai_batches,
 * catalog_ai_batch_items). A batch freezes model, destination, language, style and the product versions the
 * administrator saw. The feeder (AI lane) turns waiting items into ordinary ai_catalog_drafts through the same queue
 * code as a single product, only while the firm's queue has room, so a batch never crowds out other firms or the
 * single-product path. Review and apply stay the draft's own (server/catalog-ai.ts applyAi): an item can be applied
 * one by one with edited text, or approved in bulk with the generated text, each item in its own transaction so one
 * refused item never blocks the others. On an older copy (no 249) every write answers 503 and the list is empty. */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { assertProductsNotDeletedInTx } from './product-deletions';
import { systemActor } from './sync';
import type { Transport } from './integrations';
import { admin, aiModels, aiRequest, aiStyle, applyAi, defaultAiStyle, derivedUuid, queueDraftInTx } from './catalog-ai';

export const batchRequest = z
  .object({
    client_key: z.uuid(),
    model: z.string().min(1).max(100),
    destination: z.enum(['catalog', 'translation']),
    locale: z.enum(['pl', 'en', 'de', 'fr', 'es', 'cs']),
    style: aiStyle.default(defaultAiStyle),
    products: z
      .array(z.object({ id: z.uuid(), version: z.number().int().positive() }).strict())
      .min(1)
      .max(50)
      .refine((l) => new Set(l.map((p) => p.id)).size === l.length, 'Produkty w partii nie mogą się powtarzać'),
  })
  .strict();
export type BatchRequest = z.infer<typeof batchRequest>;
const applyBody = z
  .object({ approve: z.literal(true), item_ids: z.array(z.uuid()).min(1).max(50) })
  .strict();
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** The draft key of one item is derived from batch and product, so a replayed feed finds the same draft. */
const itemKey = (batchId: string, productId: string) => derivedUuid('catalog-ai-batch:' + batchId + ':' + productId);
export async function catalogAiBatchesAvailableInTx(c: Pick<pg.PoolClient, 'query'>): Promise<boolean> {
  return (
    (await c.query("SELECT to_regclass('public.catalog_ai_batch_items') IS NOT NULL AS present")).rows[0]
      .present === true
  );
}
async function requireBatches(c: pg.PoolClient) {
  ensure(await catalogAiBatchesAvailableInTx(c), 503, 'Kopia nie zawiera partii AI katalogu');
}
const waitingLimit = 200;

export async function queueCatalogAiBatch(a: Actor, raw: unknown, transport?: Transport) {
  const input = batchRequest.parse(raw);
  const { client_key, ...rest } = input;
  const hash = sha(rest);
  const prior = await tenantTx(a.tenantId, async (c) => {
    await requireBatches(c);
    await admin(c, a);
    return (await c.query('SELECT * FROM catalog_ai_batches WHERE client_key=$1', [client_key])).rows[0];
  });
  if (prior) {
    ensure(prior.request_hash === hash, 409, 'Klucz partii AI wykorzystano dla innego żądania');
    return { batch: prior, replayed: true };
  }
  const model = (await aiModels(transport)).find((m: { name: string }) => m.name === input.model);
  ensure(model, 422, 'Wybierz zainstalowany lokalny model GGUF do 8 GiB');
  return tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('catalog-ai-queue',0))");
    const again = (await c.query('SELECT * FROM catalog_ai_batches WHERE client_key=$1', [client_key])).rows[0];
    if (again) {
      ensure(again.request_hash === hash, 409, 'Klucz partii AI wykorzystano dla innego żądania');
      return { batch: again, replayed: true };
    }
    const ids = input.products.map((p) => p.id);
    const found = (await c.query('SELECT id FROM products WHERE id=ANY($1::uuid[])', [ids])).rowCount;
    ensure(found === ids.length, 404, 'Nie znaleziono co najmniej jednego produktu partii');
    await assertProductsNotDeletedInTx(c, ids);
    const waiting = (await c.query("SELECT count(*)::int n FROM catalog_ai_batch_items WHERE state='waiting'")).rows[0].n;
    ensure(waiting + ids.length <= waitingLimit, 429, 'Zbyt wiele pozycji czeka w partiach AI; zaczekaj na ich szkice');
    const id = randomUUID();
    const batch = (
      await c.query(
        'INSERT INTO catalog_ai_batches(id,tenant_id,actor_id,client_key,request_hash,destination,locale,style,model,model_digest,item_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [id, a.tenantId, a.userId, client_key, hash, input.destination, input.locale, JSON.stringify(input.style), model.name, model.digest, ids.length],
      )
    ).rows[0];
    await c.query(
      `INSERT INTO catalog_ai_batch_items(tenant_id,batch_id,product_id,position,source_version)
       SELECT $1,$2,x.id,x.n,x.v FROM unnest($3::uuid[],$4::int[]) WITH ORDINALITY AS x(id,v,n)`,
      [a.tenantId, id, ids, input.products.map((p) => p.version)],
    );
    await audit(c, a, 'catalog.ai.batch.queue', id, {
      model: model.name,
      destination: input.destination,
      locale: input.locale,
      style: input.style,
      items: ids.length,
    });
    return { batch, replayed: false };
  });
}

/** AI lane: drafts for waiting items while the firm's queue has room (per-firm and global capacity of 070). */
export async function feedCatalogAiBatches(): Promise<number> {
  if (!(await catalogAiBatchesAvailableInTx(pool))) return 0;
  const open = (
    await pool.query(
      `SELECT b.tenant_id,b.id,b.actor_id FROM catalog_ai_batches b WHERE b.state='open'
       AND EXISTS(SELECT FROM catalog_ai_batch_items i WHERE (i.tenant_id,i.batch_id)=(b.tenant_id,b.id) AND i.state='waiting')
       ORDER BY b.created_at,b.id LIMIT 20`,
    )
  ).rows;
  let fed = 0;
  for (const b of open) {
    let a: Actor | undefined;
    try {
      a = await systemActor(b.tenant_id, b.actor_id);
    } catch {
      a = undefined;
    }
    if (!a) {
      await tenantTx(b.tenant_id, (c) =>
        c.query(
          "UPDATE catalog_ai_batch_items SET state='failed',error='Autor partii nie jest już administratorem',updated_at=now() WHERE batch_id=$1 AND state='waiting'",
          [b.id],
        ),
      );
      continue;
    }
    const actor = a;
    fed += await tenantTx(actor.tenantId, async (c) => {
      try {
        await admin(c, actor);
      } catch {
        await c.query(
          "UPDATE catalog_ai_batch_items SET state='failed',error='Autor partii nie jest już administratorem',updated_at=now() WHERE batch_id=$1 AND state='waiting'",
          [b.id],
        );
        return 0;
      }
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('catalog-ai-queue',0))");
      const batch = (await c.query('SELECT * FROM catalog_ai_batches WHERE id=$1 FOR UPDATE', [b.id])).rows[0];
      if (batch.state !== 'open') return 0;
      const items = (
        await c.query("SELECT * FROM catalog_ai_batch_items WHERE batch_id=$1 AND state='waiting' ORDER BY position FOR UPDATE", [b.id])
      ).rows;
      let n = 0;
      for (const item of items) {
        const input = aiRequest.parse({
          version: item.source_version,
          client_key: itemKey(b.id, item.product_id),
          model: batch.model,
          destination: batch.destination,
          locale: batch.locale,
          style: batch.style,
        });
        await c.query('SAVEPOINT batch_item');
        try {
          const draft = await queueDraftInTx(c, actor, item.product_id, input, { name: batch.model, digest: batch.model_digest }, sha({ id: item.product_id, ...input }));
          await c.query('RELEASE SAVEPOINT batch_item');
          await c.query(
            "UPDATE catalog_ai_batch_items SET state='drafted',draft_id=$3,updated_at=now() WHERE batch_id=$1 AND product_id=$2",
            [b.id, item.product_id, draft.id],
          );
          n++;
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT batch_item');
          if (e instanceof Problem && e.status === 429) break;
          const conflict = e instanceof Problem && e.status === 409;
          await c.query(
            'UPDATE catalog_ai_batch_items SET state=$3,error=$4,updated_at=now() WHERE batch_id=$1 AND product_id=$2',
            [
              b.id,
              item.product_id,
              conflict ? 'conflict' : 'failed',
              conflict
                ? 'Produkt zmieniono po utworzeniu partii; pozycję pominięto'
                : e instanceof Problem
                  ? e.message.slice(0, 300)
                  : 'Nie udało się przygotować szkicu pozycji',
            ],
          );
        }
      }
      return n;
    });
  }
  return fed;
}

const itemsQuery = `SELECT i.product_id,i.position,i.source_version,i.state,i.error,i.outcome,i.updated_at,p.name product_name,p.version product_version,
  CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object('id',d.id,'state',d.state,'output',d.output,'reviewed_text',d.reviewed_text,'error',d.error,'source_version',d.source_version,'expires_at',d.expires_at) END draft
  FROM catalog_ai_batch_items i LEFT JOIN products p ON p.id=i.product_id LEFT JOIN ai_catalog_drafts d ON d.id=i.draft_id
  WHERE i.batch_id=$1 ORDER BY i.position`;
export async function readCatalogAiBatch(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await requireBatches(c);
    const batch = (await c.query('SELECT * FROM catalog_ai_batches WHERE id=$1', [id])).rows[0];
    ensure(batch, 404, 'Nie znaleziono partii AI');
    return { ...batch, items: (await c.query(itemsQuery, [id])).rows };
  });
}
export async function listCatalogAiBatches(a: Actor) {
  return tenantTx(a.tenantId, async (c) => {
    if (!(await catalogAiBatchesAvailableInTx(c))) return { available: false, data: [] };
    const data = (
      await c.query(
        `SELECT b.*,(SELECT jsonb_object_agg(s,n) FROM (SELECT coalesce(d.state,i.state) s,count(*)::int n FROM catalog_ai_batch_items i LEFT JOIN ai_catalog_drafts d ON d.id=i.draft_id WHERE i.batch_id=b.id GROUP BY 1) x) counts
         FROM catalog_ai_batches b ORDER BY b.created_at DESC,b.id DESC LIMIT 20`,
      )
    ).rows;
    return { available: true, data };
  });
}

type ItemResult = { product_id: string; outcome: 'applied' | 'failed'; error: string | null };
/** Bulk approval with the generated (or already reviewed) text; each item is applied in its own transaction. */
export async function applyCatalogAiBatch(a: Actor, id: string, raw: unknown) {
  const body = applyBody.parse(raw);
  const batch = await readCatalogAiBatch(a, id);
  const items = new Map(batch.items.map((i: any) => [i.product_id, i]));
  for (const pid of body.item_ids) ensure(items.has(pid), 422, 'Pozycja nie należy do tej partii');
  const results: ItemResult[] = [];
  for (const pid of body.item_ids) {
    const item: any = items.get(pid);
    const d = item.draft;
    let result: ItemResult;
    if (item.state !== 'drafted' || !d) result = { product_id: pid, outcome: 'failed', error: 'Pozycja nie ma szkicu do zatwierdzenia' };
    else if (d.state !== 'ready' && d.state !== 'applied') result = { product_id: pid, outcome: 'failed', error: 'Szkic AI nie jest gotowy do zastosowania' };
    else {
      const text = d.state === 'applied' ? d.reviewed_text : d.output;
      try {
        await applyAi(a, d.id, { approve: true, version: d.source_version, name: text.name, description: text.description });
        result = { product_id: pid, outcome: 'applied', error: null };
      } catch (e) {
        if (!(e instanceof Problem)) throw e;
        result = { product_id: pid, outcome: 'failed', error: e.message.slice(0, 300) };
      }
    }
    if (item.state === 'drafted')
      await tenantTx(a.tenantId, (c) =>
        c.query("UPDATE catalog_ai_batch_items SET outcome=$3,error=$4,updated_at=now() WHERE batch_id=$1 AND product_id=$2 AND outcome IS DISTINCT FROM 'applied'", [
          id,
          pid,
          result.outcome,
          result.error,
        ]),
      );
    results.push(result);
  }
  await tenantTx(a.tenantId, (c) =>
    audit(c, a, 'catalog.ai.batch.apply', id, {
      applied: results.filter((r) => r.outcome === 'applied').map((r) => r.product_id),
      failed: results.filter((r) => r.outcome === 'failed').map((r) => r.product_id),
    }),
  );
  return { results };
}

export async function cancelCatalogAiBatch(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await requireBatches(c);
    await admin(c, a);
    const batch = (await c.query('SELECT * FROM catalog_ai_batches WHERE id=$1 FOR UPDATE', [id])).rows[0];
    ensure(batch, 404, 'Nie znaleziono partii AI');
    if (batch.state === 'cancelled') return { cancelled: true, reused: true };
    await c.query("UPDATE catalog_ai_batches SET state='cancelled' WHERE id=$1", [id]);
    await c.query("UPDATE catalog_ai_batch_items SET state='cancelled',updated_at=now() WHERE batch_id=$1 AND state='waiting'", [id]);
    const drafts = (
      await c.query(
        "UPDATE ai_catalog_drafts d SET state='cancelled' FROM catalog_ai_batch_items i WHERE i.batch_id=$1 AND d.id=i.draft_id AND d.state IN ('queued','ready') RETURNING d.id",
        [id],
      )
    ).rows.map((r) => r.id);
    await audit(c, a, 'catalog.ai.batch.cancel', id, { cancelled_drafts: drafts.length });
    return { cancelled: true, reused: false };
  });
}
