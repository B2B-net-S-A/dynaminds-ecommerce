import { emitCatalogProductEvent } from './product-rule-events';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { assertProductsNotDeletedInTx } from './product-deletions';
import { decrypt } from './security';
import { DeepLError, deepLBody, languageCode } from './deepl';
import {
  binding,
  channel,
  deeplAdmin,
  deeplClient,
  deeplText,
  languagePair,
  quota,
  sha,
} from './deepl-catalog';
import { cooldown, recordCooldown } from './deepl-throttle';
import { fenceSync } from './offer-sync';
import { systemActor } from './sync';
import type { IntegrationContext } from './channel-access';
export const batchInput = z
  .strictObject({
    client_key: z.uuid(),
    channel_id: z.uuid(),
    source_lang: languageCode,
    target_langs: z.array(languageCode).min(1).max(6),
    formality: z.enum(['default', 'more', 'less', 'prefer_more', 'prefer_less']).default('default'),
    products: z
      .array(z.strictObject({ id: z.uuid(), version: z.number().int().positive() }))
      .min(1)
      .max(500),
  })
  .refine(
    (b) => new Set(b.products.map((p) => p.id.toLowerCase())).size === b.products.length,
    'Powielony produkt',
  )
  .refine(
    (b) => new Set(b.target_langs.map((l) => l.toLowerCase())).size === b.target_langs.length,
    'Powielony język',
  );
export async function batch(c: pg.PoolClient, id: string, update = false) {
  const b = (
    await c.query(
      'SELECT * FROM deepl_catalog_batches WHERE id=$1 ' + (update ? 'FOR UPDATE' : 'FOR SHARE'),
      [id],
    )
  ).rows[0];
  ensure(b, 404, 'Nie znaleziono partii tłumaczeń');
  return b;
}
export async function prepareBatch(a: Actor, body: unknown, ctx: IntegrationContext = {}) {
  const input = batchInput.parse(body),
    b = {
      ...input,
      source_lang: input.source_lang.toLowerCase(),
      target_langs: input.target_langs.map((l) => l.toLowerCase()).sort(),
      products: input.products
        .map((p) => ({ ...p, id: p.id.toLowerCase() }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    },
    hash = sha(b);
  const init = await tenantTx(a.tenantId, async (c) => {
    await deeplAdmin(c, a);
    const old = (
      await c.query('SELECT * FROM deepl_catalog_batches WHERE client_key=$1', [b.client_key])
    ).rows[0];
    if (old) {
      ensure(old.request_hash === hash, 409, 'Klucz partii ma inny zakres');
      return { old };
    }
    const ch = await channel(c, b.channel_id),
      products = (
        await c.query(
          'SELECT id,sku,name,description,version FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
          [b.products.map((p) => p.id)],
        )
      ).rows;
    ensure(products.length === b.products.length, 404, 'Nie znaleziono części produktów');
    await assertProductsNotDeletedInTx(c, products.map((p) => p.id));
    products.forEach((p) => {
      ensure(
        p.version === b.products.find((x) => x.id === p.id)!.version,
        409,
        'Produkt zmienił się: ' + p.sku,
      );
      deeplText.parse(pickText(p));
    });
    return { ch, products };
  });
  if (init.old) return init.old;
  const client = deeplClient(init.ch, ctx),
    langs = await client.languages(),
    usage = await client.usage();
  b.target_langs.forEach((l) => languagePair(langs, b.source_lang, l, b.formality));
  const total =
    init.products!.reduce(
      (n, p) =>
        n +
        [...deeplText.parse(pickText(p)).name, ...deeplText.parse(pickText(p)).description].length,
      0,
    ) * b.target_langs.length;
  quota(usage, total);
  return tenantTx(a.tenantId, async (c) => {
    await deeplAdmin(c, a);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['deepl:' + a.tenantId]);
    const old = (
      await c.query('SELECT * FROM deepl_catalog_batches WHERE client_key=$1', [b.client_key])
    ).rows[0];
    if (old) {
      ensure(old.request_hash === hash, 409, 'Klucz partii ma inny zakres');
      return old;
    }
    ensure(
      (
        await c.query(
          "SELECT count(*)::int n FROM deepl_catalog_batches WHERE state='queued' OR (state='prepared' AND preview_until>now())",
        )
      ).rows[0].n < 3,
      429,
      'Limit 3 aktywnych partii firmy',
    );
    ensure(
      binding(await channel(c, b.channel_id)) === binding(init.ch),
      409,
      'Połączenie zmieniło się',
    );
    const products = (
      await c.query(
        'SELECT id,sku,name,description,version FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
        [b.products.map((p) => p.id)],
      )
    ).rows;
    ensure(
      products.length === b.products.length &&
        products.every((p) => p.version === b.products.find((x) => x.id === p.id)!.version),
      409,
      'Zakres produktów zmienił się',
    );
    const id = randomUUID(),
      batchRow = (
        await c.query(
          'INSERT INTO deepl_catalog_batches(id,tenant_id,actor_id,channel_id,client_key,request_hash,connection_hash,source_lang,target_langs,formality,product_count,draft_count,characters,simulation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',
          [
            id,
            a.tenantId,
            a.userId,
            b.channel_id,
            b.client_key,
            hash,
            binding(init.ch),
            b.source_lang,
            JSON.stringify(b.target_langs),
            b.formality,
            products.length,
            products.length * b.target_langs.length,
            total,
            !!init.ch.settings.simulation,
          ],
        )
      ).rows[0];
    const rows = products.flatMap((p, index) =>
      b.target_langs.map((l, j) => {
        const source = deeplText.parse(pickText(p));
        return {
          id: randomUUID(),
          client_key: randomUUID(),
          product_id: p.id,
          source_version: p.version,
          source,
          characters: [...source.name, ...source.description].length,
          target_lang: l,
          ordinal: index * b.target_langs.length + j,
          sku: p.sku,
        };
      }),
    );
    await c.query(
      "INSERT INTO deepl_catalog_drafts(id,tenant_id,product_id,channel_id,actor_id,client_key,request_hash,connection_hash,source_version,source,source_lang,target_lang,formality,characters,simulation,batch_id,batch_ordinal,batch_sku,expires_at) SELECT (x->>'id')::uuid,$2,(x->>'product_id')::uuid,$3,$4,(x->>'client_key')::uuid,$5,$6,(x->>'source_version')::int,x->'source',$7,x->>'target_lang',$8,(x->>'characters')::int,$9,$10,(x->>'ordinal')::int,x->>'sku',$11 FROM jsonb_array_elements($1::jsonb) x",
      [
        JSON.stringify(rows),
        a.tenantId,
        b.channel_id,
        a.userId,
        hash,
        binding(init.ch),
        b.source_lang,
        b.formality,
        batchRow.simulation,
        id,
        batchRow.expires_at,
      ],
    );
    await audit(c, a, 'deepl.batch.preview', id, {
      products: products.length,
      languages: b.target_langs,
      characters: total,
      simulation: batchRow.simulation,
    });
    return batchRow;
  });
}
const pickText = (p: any) => ({ name: p.name, description: p.description });
export async function queueBatch(a: Actor, id: string, body: unknown) {
  const consent = z
    .strictObject({
      confirm_external: z.literal(true),
      max_characters: z.number().int().positive().max(30600000),
    })
    .parse(body);
  return tenantTx(a.tenantId, async (c) => {
    await deeplAdmin(c, a);
    const b = await batch(c, id, true);
    ensure(
      consent.max_characters >= b.characters,
      422,
      'Zakres przekracza zatwierdzony budżet znaków',
    );
    if (['queued', 'finished'].includes(b.state)) return b;
    ensure(
      b.state === 'prepared' && new Date(b.preview_until).getTime() > Date.now(),
      409,
      'Podgląd partii wygasł',
    );
    ensure(
      b.simulation || process.env.DYNA_ALLOW_EXTERNAL_TRANSLATION === 'true',
      423,
      'Zewnętrzne tłumaczenie wyłączone',
    );
    ensure(
      binding(await channel(c, b.channel_id)) === b.connection_hash,
      409,
      'Połączenie zmieniło się',
    );
    const products = (
      await c.query(
        'SELECT p.id,p.version FROM products p WHERE p.id IN (SELECT product_id FROM deepl_catalog_drafts WHERE batch_id=$1) ORDER BY p.id FOR SHARE',
        [id],
      )
    ).rows;
    const versions = (
      await c.query(
        'SELECT DISTINCT product_id,source_version FROM deepl_catalog_drafts WHERE batch_id=$1',
        [id],
      )
    ).rows;
    ensure(
      products.length === b.product_count &&
        products.every(
          (p) => versions.find((v) => v.product_id === p.id)?.source_version === p.version,
        ),
      409,
      'Produkt zmienił się; przygotuj nową partię',
    );
    const out = (
      await c.query(
        "UPDATE deepl_catalog_batches SET state='queued',approved_characters=$2,queued_at=now() WHERE id=$1 RETURNING *",
        [id, consent.max_characters],
      )
    ).rows[0];
    await audit(c, a, 'deepl.batch.queue', id, { characters: b.characters });
    return out;
  });
}
export async function cancelBatch(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await deeplAdmin(c, a);
    const b = await batch(c, id, true);
    await c.query(
      "UPDATE deepl_catalog_batches SET state='cancelled',finished_at=coalesce(finished_at,now()) WHERE id=$1",
      [id],
    );
    const cancelled = await c.query(
      "UPDATE deepl_catalog_drafts SET state='cancelled' WHERE batch_id=$1 AND (state IN ('prepared','ready') OR (state='queued' AND attempted_at IS NULL)) RETURNING id",
      [id],
    );
    const started = (
      await c.query(
        "SELECT count(*)::int n FROM deepl_catalog_drafts WHERE batch_id=$1 AND state='queued' AND attempted_at IS NOT NULL",
        [id],
      )
    ).rows[0].n;
    await audit(c, a, 'deepl.batch.cancel', id, { cancelled: cancelled.rowCount, started });
    return { cancelled: cancelled.rowCount, already_started: started, simulation: b.simulation };
  });
}
export async function applyBatchProduct(a: Actor, id: string, product: string, body: unknown) {
  const b = z
    .strictObject({
      approve: z.literal(true),
      version: z.number().int().positive(),
      texts: z
        .array(deeplText.extend({ draft_id: z.uuid() }))
        .min(1)
        .max(6),
    })
    .parse(body);
  ensure(new Set(b.texts.map((t) => t.draft_id)).size === b.texts.length, 422, 'Powielony szkic');
  return tenantTx(a.tenantId, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'catalog:' + a.tenantId,
    ]);
    await deeplAdmin(c, a);
    const parent = await batch(c, id);
    ensure(
      !['cancelled', 'expired'].includes(parent.state),
      409,
      'Partia jest anulowana lub wygasła',
    );
    const rows = (
      await c.query(
        'SELECT * FROM deepl_catalog_drafts WHERE batch_id=$1 AND product_id=$2 ORDER BY id FOR UPDATE',
        [id, product],
      )
    ).rows;
    ensure(rows.length, 404, 'Produkt nie należy do partii');
    const applied = rows.filter((d) => d.state === 'applied');
    if (applied.length) {
      ensure(
        applied.length === b.texts.length &&
          applied.every((d) => {
            const t = b.texts.find((t) => t.draft_id === d.id);
            return t && d.source_version === b.version && sha(d.reviewed_text) === sha(pickText(t));
          }),
        409,
        'Produkt zapisano z inną treścią',
      );
      return { reused: true, version: applied[0].applied_version };
    }
    ensure(
      !rows.some((d) => ['prepared', 'queued'].includes(d.state)),
      409,
      'Zaczekaj na wszystkie języki tego produktu',
    );
    const ready = rows.filter((d) => d.state === 'ready');
    ensure(
      ready.length === b.texts.length &&
        ready.every((d) => b.texts.some((t) => t.draft_id === d.id)),
      409,
      'Zatwierdź cały zestaw gotowych języków',
    );
    ensure(new Date(parent.expires_at).getTime() > Date.now(), 409, 'Ważność partii wygasła');
    ensure(
      binding(await channel(c, parent.channel_id)) === parent.connection_hash,
      409,
      'Połączenie zmieniło się',
    );
    const p = (await c.query('SELECT id,version FROM products WHERE id=$1 FOR UPDATE', [product]))
      .rows[0];
    ensure(
      p?.version === b.version && ready.every((d) => d.source_version === p.version),
      409,
      'Produkt zmienił się; nie nadpisano danych',
    );
    for (const d of ready) {
      const t = b.texts.find((t) => t.draft_id === d.id)!;
      await c.query(
        `INSERT INTO product_translations(tenant_id,product_id,locale,name,description,deepl_draft_id,ai_draft_id) VALUES($1,$2,$3,$4,$5,$6,NULL) ON CONFLICT(tenant_id,product_id,locale) DO UPDATE SET name=excluded.name,description=excluded.description,deepl_draft_id=excluded.deepl_draft_id,ai_draft_id=NULL,${(await c.query("SELECT to_regclass('public.product_translation_bulk_edit_execution_rows') p")).rows[0].p ? 'manual_receipt_id=NULL,' : ''}version=product_translations.version+1,updated_at=now()`,
        [a.tenantId, product, d.target_lang, t.name, t.description, d.id],
      );
      await c.query(
        "UPDATE deepl_catalog_drafts SET state='applied',reviewed_text=$2,applied_version=$3 WHERE id=$1",
        [d.id, JSON.stringify(pickText(t)), p.version + 1],
      );
    }
    await c.query('UPDATE products SET version=version+1 WHERE id=$1', [product]);
    await audit(c, a, 'deepl.batch.apply', id, {
      product_id: product,
      languages: ready.map((d) => d.target_lang),
      reviewed_hash: sha(b.texts),
      simulation: parent.simulation,
    });
    await emitCatalogProductEvent(c, a, product, 'product.updated', ready[0].id);
    return { reused: false, version: p.version + 1, languages: ready.map((d) => d.target_lang) };
  });
}
// Claim one bounded portion under the same tenant lock as single-product admission.
export async function pumpBatch() {
  const candidates = (
    await pool.query(
      "SELECT id,tenant_id FROM deepl_catalog_batches WHERE state='queued' AND NOT EXISTS(SELECT 1 FROM deepl_catalog_drafts d WHERE (d.tenant_id,d.batch_id)=(deepl_catalog_batches.tenant_id,deepl_catalog_batches.id) AND d.state='queued') AND EXISTS(SELECT 1 FROM deepl_catalog_drafts d WHERE (d.tenant_id,d.batch_id)=(deepl_catalog_batches.tenant_id,deepl_catalog_batches.id) AND d.state='prepared') AND (SELECT count(*) FROM deepl_catalog_drafts d WHERE d.tenant_id=deepl_catalog_batches.tenant_id AND (d.state='queued' OR (d.batch_id IS NULL AND d.state='prepared' AND d.expires_at>now())))<20 ORDER BY last_dispatch_at NULLS FIRST,created_at,id LIMIT 30",
    )
  ).rows;
  for (const candidate of candidates) {
    const queued = await tenantTx(candidate.tenant_id, async (c) => {
      const parent = (
        await c.query(
          "SELECT * FROM deepl_catalog_batches WHERE id=$1 AND state='queued' FOR UPDATE SKIP LOCKED",
          [candidate.id],
        )
      ).rows[0];
      if (!parent) return false;
      // One in-flight portion per batch avoids fragmentation when a single-product
      // reservation releases one slot while the preceding bulk portion is queued.
      if (
        (
          await c.query(
            "SELECT EXISTS(SELECT 1 FROM deepl_catalog_drafts WHERE batch_id=$1 AND state='queued') busy",
            [parent.id],
          )
        ).rows[0].busy
      )
        return false;
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'deepl:' + parent.tenant_id,
      ]);
      const authorized = (await c.query('SELECT offer_sync_is_admin($1) ok', [parent.actor_id]))
          .rows[0].ok,
        ch = await channel(c, parent.channel_id);
      if (
        parent.error ||
        !authorized ||
        binding(ch) !== parent.connection_hash ||
        new Date(parent.expires_at).getTime() <= Date.now() ||
        (!parent.simulation && process.env.DYNA_ALLOW_EXTERNAL_TRANSLATION !== 'true')
      ) {
        await c.query(
          "UPDATE deepl_catalog_drafts SET state='conflict',error='Zakres, uprawnienia lub ważność partii zmieniły się',finished_at=now() WHERE batch_id=$1 AND state='prepared'",
          [parent.id],
        );
        return false;
      }
      const slots =
        20 -
        (
          await c.query(
            "SELECT count(*)::int n FROM deepl_catalog_drafts WHERE state='queued' OR (batch_id IS NULL AND state='prepared' AND expires_at>now())",
          )
        ).rows[0].n;
      if (slots <= 0) return false;
      const pending = (
        await c.query(
          "SELECT * FROM deepl_catalog_drafts WHERE batch_id=$1 AND state='prepared' AND target_lang=(SELECT target_lang FROM deepl_catalog_drafts WHERE batch_id=$1 AND state='prepared' ORDER BY batch_ordinal LIMIT 1) ORDER BY batch_ordinal LIMIT $2 FOR UPDATE SKIP LOCKED",
          [parent.id, Math.min(20, slots)],
        )
      ).rows;
      if (!pending.length) return false;
      const rows: any[] = [];
      for (const d of pending) {
        if (d.target_lang !== pending[0].target_lang) break;
        if (
          Buffer.byteLength(
            JSON.stringify(
              deepLBody(
                [...rows, d].map((d) => d.source),
                parent.source_lang,
                d.target_lang,
                parent.formality,
              ),
            ),
          ) >
          120 * 1024
        )
          break;
        rows.push(d);
      }
      ensure(rows.length, 422, 'Tekst przekracza porcję DeepL');
      const job = randomUUID();
      await c.query(
        "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,'catalog.deepl.batch',$3,$4,3)",
        [
          job,
          parent.tenant_id,
          JSON.stringify({
            batch_id: parent.id,
            actor_id: parent.actor_id,
            draft_ids: rows.map((d) => d.id),
          }),
          'deepl-batch:' + job,
        ],
      );
      await c.query(
        "UPDATE deepl_catalog_drafts SET state='queued',job_id=$2 WHERE id=ANY($1::uuid[])",
        [rows.map((d) => d.id), job],
      );
      await c.query('UPDATE deepl_catalog_batches SET last_dispatch_at=now() WHERE id=$1', [
        parent.id,
      ]);
      return true;
    });
    if (queued) return true;
  }
  return false;
}
async function doneJob(c: pg.PoolClient, job: any) {
  await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1", [
    job.id,
  ]);
}
async function defer(job: any, when: Date) {
  await tenantTx(job.tenant_id, async (c) => {
    if (await fenceSync(c, job, true))
      await c.query(
        "UPDATE jobs SET state='pending',attempts=greatest(0,attempts-1),run_at=$2,lease_token=NULL,locked_at=NULL WHERE id=$1",
        [job.id, when],
      );
  });
}
export async function processBatchJob(job: any, ctx: IntegrationContext = {}) {
  const a = await systemActor(job.tenant_id, job.payload.actor_id);
  const initial = await tenantTx(a.tenantId, async (c) => {
    await deeplAdmin(c, a);
    ensure(await fenceSync(c, job, true), 409, 'Wygasła dzierżawa partii');
    const b = await batch(c, job.payload.batch_id),
      ch = await channel(c, b.channel_id);
    ensure(binding(ch) === b.connection_hash, 409, 'Połączenie zmieniło się');
    ensure(
      b.simulation || process.env.DYNA_ALLOW_EXTERNAL_TRANSLATION === 'true',
      423,
      'Tłumaczenie zewnętrzne wyłączone',
    );
    const rows = (
      await c.query(
        "SELECT * FROM deepl_catalog_drafts WHERE job_id=$1 AND state='queued' ORDER BY batch_ordinal FOR UPDATE",
        [job.id],
      )
    ).rows;
    ensure(
      rows.every((d) => !d.attempted_at),
      409,
      'Niepewna wcześniejsza próba nie może zostać powtórzona',
    );
    if (b.state === 'cancelled' || !rows.length) {
      await c.query(
        "UPDATE deepl_catalog_drafts SET state='cancelled' WHERE job_id=$1 AND state='queued' AND attempted_at IS NULL",
        [job.id],
      );
      await doneJob(c, job);
      return null;
    }
    ensure(!b.error, 409, 'Partia zatrzymana po błędzie dostawcy');
    ensure(new Date(b.expires_at).getTime() > Date.now(), 409, 'Partia wygasła');
    return { b, ch, rows };
  });
  if (!initial) return;
  const { b, ch } = initial,
    lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'deepl-batches'),
    key = sha({ key: decrypt(ch.credentials).api_key, plan: ch.settings.api_plan });
  try {
    return await holdingDbLock(lock, async () => {
    await lock.connect();
    if (
      !(
        await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked', [
          'deepl-key:' + key,
        ])
      ).rows[0].locked
    ) {
      await defer(job, new Date(Date.now() + 2000));
      return;
    }
    const wait = await cooldown(lock, key);
    if (wait) {
      ensure(
        wait.getTime() < new Date(b.expires_at).getTime(),
        409,
        'Przerwa DeepL przekracza ważność partii',
      );
      await defer(job, wait);
      return;
    }
    const client = deeplClient(ch, ctx),
      languages = await client.languages(),
      usage = await client.usage();
    languagePair(languages, b.source_lang, initial.rows[0].target_lang, b.formality);
    const rows = await tenantTx(a.tenantId, async (c) => {
      await deeplAdmin(c, a);
      if (!(await fenceSync(c, job, true))) return [];
      const current = await batch(c, b.id);
      if (current.state === 'cancelled') {
        await c.query(
          "UPDATE deepl_catalog_drafts SET state='cancelled' WHERE job_id=$1 AND state='queued' AND attempted_at IS NULL",
          [job.id],
        );
        await doneJob(c, job);
        return [];
      }
      ensure(!current.error, 409, 'Partia zatrzymana po błędzie dostawcy');
      ensure(new Date(current.expires_at).getTime() > Date.now(), 409, 'Partia wygasła');
      ensure(
        binding(await channel(c, ch.id)) === b.connection_hash,
        409,
        'Połączenie zmieniło się',
      );
      const drafts = (
        await c.query(
          "SELECT * FROM deepl_catalog_drafts WHERE job_id=$1 AND state='queued' ORDER BY batch_ordinal FOR UPDATE",
          [job.id],
        )
      ).rows;
      ensure(
        drafts.every((d) => !d.attempted_at),
        409,
        'Próba już rozpoczęta',
      );
      const products = (
        await c.query(
          'SELECT id,version FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
          [drafts.map((d) => d.product_id)],
        )
      ).rows;
      const valid: any[] = [];
      for (const d of drafts) {
        if (products.find((p) => p.id === d.product_id)?.version !== d.source_version)
          await c.query(
            "UPDATE deepl_catalog_drafts SET state='conflict',error='Produkt zmienił się przed tłumaczeniem',finished_at=now() WHERE id=$1",
            [d.id],
          );
        else valid.push(d);
      }
      if (!valid.length) {
        await doneJob(c, job);
        return [];
      }
      quota(
        usage,
        valid.reduce((n, d) => n + d.characters, 0),
      );
      ensure(current.approved_characters >= current.characters, 409, 'Brak zatwierdzonego budżetu');
      await c.query('UPDATE deepl_catalog_drafts SET attempted_at=now() WHERE id=ANY($1::uuid[])', [
        valid.map((d) => d.id),
      ]);
      return valid;
    });
    if (!rows.length) return;
    const outputs = await client.translateMany(
      rows.map((d) => d.source),
      b.source_lang,
      rows[0].target_lang,
      b.formality,
    );
    await tenantTx(a.tenantId, async (c) => {
      if (!(await fenceSync(c, job, true))) return;
      const current = await batch(c, b.id),
        authorized = (await c.query('SELECT offer_sync_is_admin($1) ok', [a.userId])).rows[0].ok;
      const currentChannel = await channel(c, ch.id),
        products = (
          await c.query(
            'SELECT id,version FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
            [rows.map((d) => d.product_id)],
          )
        ).rows;
      for (let i = 0; i < rows.length; i++) {
        const d = rows[i],
          out = outputs[i],
          plain = deeplText.safeParse(out.output),
          valid =
            current.state !== 'expired' &&
            new Date(current.expires_at).getTime() > Date.now() &&
            authorized &&
            binding(currentChannel) === b.connection_hash &&
            products.find((p) => p.id === d.product_id)?.version === d.source_version;
        const state =
          current.state === 'cancelled'
            ? 'cancelled'
            : !plain.success
              ? 'failed'
              : valid
                ? 'ready'
                : 'conflict';
        await c.query(
          "UPDATE deepl_catalog_drafts SET state=$2,output=$3,usage=$4,error=$5,finished_at=now() WHERE id=$1 AND state='queued'",
          [
            d.id,
            state,
            plain.success ? JSON.stringify(plain.data) : null,
            JSON.stringify(out.usage),
            !plain.success
              ? 'Wynik nie spełnia wymagań zwykłego tekstu; naliczenie zachowano'
              : !valid
                ? 'Produkt, połączenie lub uprawnienia zmieniły się'
                : null,
          ],
        );
      }
      await doneJob(c, job);
    });
    });
  } catch (e) {
    await recordCooldown(lock, key, e);
    throw e;
  } finally {
    await lock.end();
  }
}
export async function failBatchJob(job: any, error: unknown) {
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await fenceSync(c, job, true))) return;
    const b = await batch(c, job.payload.batch_id),
      rows = (
        await c.query(
          "SELECT * FROM deepl_catalog_drafts WHERE job_id=$1 AND state='queued' ORDER BY id FOR UPDATE",
          [job.id],
        )
      ).rows;
    const attempted = rows.some((d) => d.attempted_at),
      seconds =
        error instanceof DeepLError ? Math.max(error.retryAfter, 5 * 2 ** (job.attempts - 1)) : 0;
    if (
      rows.length &&
      error instanceof DeepLError &&
      (error.retryable || (!attempted && [500, 503, 504].includes(error.http))) &&
      job.attempts < 3 &&
      Date.now() + seconds * 1000 < new Date(b.expires_at).getTime() &&
      b.state !== 'cancelled'
    ) {
      await c.query(
        "UPDATE deepl_catalog_drafts SET attempted_at=NULL,error='DeepL ograniczył żądania; zaczekaj na ponowienie' WHERE job_id=$1 AND state='queued'",
        [job.id],
      );
      await c.query(
        "UPDATE jobs SET state='pending',run_at=now()+$2*interval '1 second',lease_token=NULL,locked_at=NULL WHERE id=$1",
        [job.id, seconds],
      );
      return;
    }
    const uncertain = attempted && !(error instanceof DeepLError && error.rejected),
      message = uncertain
        ? 'Wynik porcji DeepL jest niepewny; naliczenie mogło nastąpić. Brak replay.'
        : error instanceof Problem
          ? error.message
          : 'Nie udało się przetłumaczyć porcji';
    await c.query(
      "UPDATE deepl_catalog_drafts SET state=$2,error=$3,finished_at=now() WHERE job_id=$1 AND state='queued'",
      [
        job.id,
        uncertain
          ? 'uncertain'
          : error instanceof Problem && error.status === 409
            ? 'conflict'
            : 'failed',
        message,
      ],
    );
    if (error instanceof DeepLError && [403, 456].includes(error.http)) {
      await c.query('UPDATE deepl_catalog_batches SET error=$2 WHERE id=$1', [b.id, message]);
      await c.query(
        "UPDATE deepl_catalog_drafts SET state='failed',error=$2,finished_at=now() WHERE batch_id=$1 AND state='prepared'",
        [b.id, message],
      );
    }
    await c.query(
      "UPDATE jobs SET state='failed',error=$2,lease_token=NULL,locked_at=NULL WHERE id=$1",
      [job.id, message],
    );
  });
}
export async function tickDeepLBatches(ctx: IntegrationContext = {}) {
  await pool.query(
    "UPDATE jobs SET state='failed',error='Dzierżawa porcji DeepL wygasła',lease_token=NULL,locked_at=NULL WHERE kind='catalog.deepl.batch' AND state='running' AND locked_at<now()-interval '2 minutes'",
  );
  await pool.query(
    "UPDATE deepl_catalog_drafts d SET state=CASE WHEN attempted_at IS NOT NULL THEN 'uncertain' ELSE 'failed' END,error='Dzierżawa wygasła; brak replay',finished_at=now() FROM jobs j WHERE j.id=d.job_id AND j.kind='catalog.deepl.batch' AND j.state='failed' AND d.state='queued'",
  );
  await pool.query(
    "UPDATE deepl_catalog_batches SET state='expired',finished_at=now() WHERE (state='prepared' AND preview_until<=now()) OR (state='queued' AND expires_at<=now())",
  );
  await pool.query(
    "UPDATE deepl_catalog_drafts d SET state='cancelled',error='Podgląd partii wygasł' FROM deepl_catalog_batches b WHERE (b.tenant_id,b.id)=(d.tenant_id,d.batch_id) AND b.state='expired' AND d.state='prepared'",
  );
  await pool.query(
    "UPDATE deepl_catalog_batches b SET state='finished',finished_at=now() WHERE state='queued' AND NOT EXISTS(SELECT 1 FROM deepl_catalog_drafts d WHERE (d.tenant_id,d.batch_id)=(b.tenant_id,b.id) AND d.state IN ('prepared','queued'))",
  );
  await pool.query(
    "UPDATE jobs j SET state='failed',error='Ważność partii wygasła',lease_token=NULL,locked_at=NULL FROM deepl_catalog_batches b WHERE j.kind='catalog.deepl.batch' AND j.state='pending' AND (j.payload->>'batch_id')::uuid=b.id AND b.state='expired'",
  );
  await pool.query(
    "UPDATE deepl_catalog_drafts d SET state=CASE WHEN attempted_at IS NOT NULL THEN 'uncertain' ELSE 'failed' END,error='Ważność partii wygasła',finished_at=now() FROM jobs j WHERE (j.tenant_id,j.id)=(d.tenant_id,d.job_id) AND j.kind='catalog.deepl.batch' AND j.state='failed' AND d.state='queued'",
  );
  await pumpBatch();
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$1,locked_at=now() WHERE id=(SELECT id FROM jobs WHERE kind='catalog.deepl.batch' AND state='pending' AND run_at<=now() ORDER BY run_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",
      [randomUUID()],
    )
  ).rows[0];
  if (!job) return false;
  try {
    await processBatchJob(job, ctx);
  } catch (e) {
    await failBatchJob(job, e);
  }
  return true;
}
export function startDeepLBatchWorker() {
  let timer: ReturnType<typeof setTimeout>,
    running: Promise<void> | undefined,
    stopped = false;
  const schedule = (ms: number) => {
    timer = setTimeout(() => {
      running = (async () => {
        let worked = false;
        try {
          worked = await tickDeepLBatches();
        } catch {
          console.error('DeepL batch worker: błąd kolejki');
        } finally {
          running = undefined;
          if (!stopped) schedule(worked ? 100 : 1000);
        }
      })();
    }, ms);
  };
  schedule(1000);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
