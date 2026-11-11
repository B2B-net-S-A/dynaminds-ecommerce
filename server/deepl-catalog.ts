import { emitCatalogProductEvent } from './product-rule-events';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { assertProductsNotDeletedInTx } from './product-deletions';
import { decrypt } from './security';
import { DeepL, DeepLError, languageCode } from './deepl';
import type { IntegrationContext } from './channel-access';
import { systemActor } from './sync';
import { fenceSync } from './offer-sync';
import { cooldown, recordCooldown } from './deepl-throttle';
const plain = (max: number, min = 0) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine(
      (v) => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v),
      'Wymagany zwykły tekst bez HTML',
    );
export const deeplText = z.strictObject({ name: plain(200, 2), description: plain(10000) });
export const deeplPrepare = z.strictObject({
  version: z.number().int().positive(),
  client_key: z.uuid(),
  channel_id: z.uuid(),
  source_lang: languageCode,
  target_lang: languageCode,
  formality: z.enum(['default', 'more', 'less', 'prefer_more', 'prefer_less']).default('default'),
});
export const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const binding = (ch: any) =>
  sha({
    id: ch.id,
    provider: ch.provider,
    mode: ch.mode,
    settings: ch.settings,
    credentials: ch.credentials,
  });
export async function deeplAdmin(c: pg.PoolClient, a: Actor) {
  ensure(
    a.role === 'admin' &&
      (await c.query('SELECT offer_sync_is_admin($1) ok', [a.userId])).rows[0].ok,
    403,
    'Wymagany aktualny administrator firmy',
  );
}
export async function channel(c: pg.PoolClient, id: string) {
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [id])).rows[0];
  ensure(ch?.provider === 'deepl', 404, 'Nie znaleziono połączenia DeepL');
  return ch;
}
export function deeplClient(ch: any, ctx: IntegrationContext = {}) {
  if (!ch.settings.simulation)
    return new DeepL({ api_plan: ch.settings.api_plan }, decrypt(ch.credentials), ctx.transport);
  const languages = [
    {
      lang: 'pl',
      name: 'Polish',
      usable_as_source: true,
      usable_as_target: true,
      status: 'stable',
      features: {},
    },
    {
      lang: 'en-US',
      name: 'English (American)',
      usable_as_source: false,
      usable_as_target: true,
      status: 'stable',
      features: {},
    },
    {
      lang: 'de',
      name: 'German',
      usable_as_source: true,
      usable_as_target: true,
      status: 'stable',
      features: { formality: { status: 'stable' } },
    },
  ];
  const dictionary: Record<string, string> = {
    'Kubek stalowy 350 ml': 'Stainless steel mug 350 ml',
    'Kubek ze stali nierdzewnej. Pojemność 350 ml. Kolor czarny.':
      'Mug made of stainless steel. Capacity 350 ml. Color black.',
  };
  return new DeepL(
    { api_plan: 'free' },
    { api_key: 'local-deepl-example:fx' },
    async (url, init) => {
      if (url.includes('/v3/languages')) return Response.json(languages);
      if (url.endsWith('/v2/usage'))
        return Response.json({ character_count: 0, character_limit: 500000 });
      ensure(url.endsWith('/v2/translate'), 422, 'Nieznany proces przykładu DeepL');
      const b = JSON.parse(String(init?.body));
      return Response.json({
        translations: b.text.map((s: string) => ({
          text:
            b.target_lang === 'EN-US'
              ? (dictionary[s] ?? '[DEMO EN-US] ' + s)
              : '[DEMO ' + b.target_lang + '] ' + s,
          detected_source_language: b.source_lang,
          billed_characters: [...s].length,
          model_type_used: 'local_simulation',
        })),
      });
    },
  );
}
export async function deeplMetadata(a: Actor, id: string, ctx: IntegrationContext = {}) {
  const ch = await tenantTx(a.tenantId, async (c) => {
    await deeplAdmin(c, a);
    return channel(c, id);
  });
  const client = deeplClient(ch, ctx);
  return {
    languages: await client.languages(),
    usage: await client.usage(),
    simulation: !!ch.settings.simulation,
    api_plan: ch.settings.api_plan,
  };
}
export function languagePair(
  rows: Awaited<ReturnType<DeepL['languages']>>,
  from: string,
  to: string,
  formality: string,
) {
  const source = rows.find((r) => r.lang.toLowerCase() === from.toLowerCase()),
    target = rows.find((r) => r.lang.toLowerCase() === to.toLowerCase());
  ensure(
    source?.usable_as_source && target?.usable_as_target,
    422,
    'Para języków nie jest obsługiwana przez DeepL',
  );
  ensure(
    source.lang.toLowerCase() !== target.lang.toLowerCase(),
    422,
    'Wybierz inny język docelowy',
  );
  if (['more', 'less'].includes(formality))
    ensure(
      (target.features.formality as any)?.status === 'stable',
      422,
      'Ten język nie obsługuje wybranego stylu formalności',
    );
}
export function quota(u: Awaited<ReturnType<DeepL['usage']>>, characters: number) {
  ensure(
    u.character_limit - u.character_count >= characters &&
      (u.api_key_character_limit === undefined ||
        u.api_key_character_limit - (u.api_key_character_count ?? 0) >= characters),
    422,
    'Brak dostępnego limitu znaków DeepL',
  );
}
export async function prepareDeepL(
  a: Actor,
  id: string,
  b: z.infer<typeof deeplPrepare>,
  ctx: IntegrationContext = {},
) {
  const hash = sha({ id, ...b }),
    initial = await tenantTx(a.tenantId, async (c) => {
      await deeplAdmin(c, a);
      const old = (
        await c.query('SELECT * FROM deepl_catalog_drafts WHERE client_key=$1', [b.client_key])
      ).rows[0];
      if (old) {
        ensure(old.request_hash === hash, 409, 'Klucz podglądu ma inną treść');
        return { old };
      }
      const ch = await channel(c, b.channel_id),
        p = (await c.query('SELECT * FROM products WHERE id=$1 FOR SHARE', [id])).rows[0];
      ensure(p, 404, 'Nie znaleziono produktu');
      await assertProductsNotDeletedInTx(c, [id]);
      ensure(p.version === b.version, 409, 'Produkt zmienił się');
      const source = deeplText.parse({ name: p.name, description: p.description });
      return { ch, source, characters: [...source.name, ...source.description].length };
    });
  if (initial.old) return initial.old;
  const ch = initial.ch!,
    client = deeplClient(ch, ctx),
    langs = await client.languages(),
    usage = await client.usage();
  languagePair(langs, b.source_lang, b.target_lang, b.formality);
  quota(usage, initial.characters!);
  return tenantTx(a.tenantId, async (c) => {
    await deeplAdmin(c, a);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['deepl:' + a.tenantId]);
    const again = (
      await c.query('SELECT * FROM deepl_catalog_drafts WHERE client_key=$1', [b.client_key])
    ).rows[0];
    if (again) {
      ensure(again.request_hash === hash, 409, 'Klucz podglądu ma inną treść');
      return again;
    }
    const current = await channel(c, b.channel_id);
    ensure(binding(current) === binding(ch), 409, 'Połączenie DeepL zmieniło się');
    const p = (await c.query('SELECT * FROM products WHERE id=$1 FOR SHARE', [id])).rows[0];
    ensure(p?.version === b.version, 409, 'Produkt zmienił się');
    ensure(
      (
        await c.query(
          "SELECT count(*)::int n FROM deepl_catalog_drafts WHERE state='queued' OR (state='prepared' AND batch_id IS NULL AND expires_at>now())",
        )
      ).rows[0].n < 20,
      429,
      'Limit 20 aktywnych szkiców DeepL',
    );
    const d = (
      await c.query(
        'INSERT INTO deepl_catalog_drafts(id,tenant_id,product_id,channel_id,actor_id,client_key,request_hash,connection_hash,source_version,source,source_lang,target_lang,formality,characters,simulation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',
        [
          randomUUID(),
          a.tenantId,
          id,
          ch.id,
          a.userId,
          b.client_key,
          hash,
          binding(ch),
          b.version,
          JSON.stringify(initial.source),
          b.source_lang.toLowerCase(),
          b.target_lang.toLowerCase(),
          b.formality,
          initial.characters,
          !!ch.settings.simulation,
        ],
      )
    ).rows[0];
    await audit(c, a, 'deepl.prepare', d.id, {
      product_id: id,
      target_lang: d.target_lang,
      characters: d.characters,
      simulation: d.simulation,
    });
    return d;
  });
}
export async function queueDeepL(a: Actor, id: string, body: unknown) {
  const b = z
    .strictObject({
      confirm_external: z.literal(true),
      max_characters: z.number().int().positive().max(10200),
    })
    .parse(body);
  return tenantTx(a.tenantId, async (c) => {
    await deeplAdmin(c, a);
    const d = (await c.query('SELECT * FROM deepl_catalog_drafts WHERE id=$1 FOR UPDATE', [id]))
      .rows[0];
    ensure(d, 404, 'Nie znaleziono szkicu');
    ensure(!d.batch_id, 409, 'Szkic należy do partii; użyj przeglądu partii');
    ensure(d.characters <= b.max_characters, 422, 'Podgląd przekracza zatwierdzony limit znaków');
    if (d.state === 'queued' || ['ready', 'applied'].includes(d.state)) return d;
    ensure(
      d.state === 'prepared' && new Date(d.expires_at).getTime() > Date.now(),
      409,
      'Podgląd nie jest aktualny',
    );
    const ch = await channel(c, d.channel_id);
    ensure(binding(ch) === d.connection_hash, 409, 'Połączenie zmieniło się');
    ensure(
      (await c.query('SELECT version FROM products WHERE id=$1 FOR SHARE', [d.product_id])).rows[0]
        ?.version === d.source_version,
      409,
      'Produkt zmienił się',
    );
    ensure(
      d.simulation || process.env.DYNA_ALLOW_EXTERNAL_TRANSLATION === 'true',
      423,
      'Zewnętrzne tłumaczenie wymaga DYNA_ALLOW_EXTERNAL_TRANSLATION=true i zgody na użycie znaków',
    );
    const job = randomUUID();
    await c.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,'catalog.deepl',$3,$4,3)",
      [job, a.tenantId, JSON.stringify({ draft_id: d.id, actor_id: a.userId }), 'deepl:' + d.id],
    );
    const out = (
      await c.query(
        "UPDATE deepl_catalog_drafts SET state='queued',job_id=$2 WHERE id=$1 RETURNING *",
        [id, job],
      )
    ).rows[0];
    await audit(c, a, 'deepl.queue', id, { characters: d.characters, simulation: d.simulation });
    return out;
  });
}
export async function processDeepL(job: any, ctx: IntegrationContext = {}) {
  const a = await systemActor(job.tenant_id, job.payload.actor_id),
    initial = await tenantTx(a.tenantId, async (c) => {
      await deeplAdmin(c, a);
      ensure(await fenceSync(c, job, true), 409, 'Wygasła dzierżawa DeepL');
      const d = (
        await c.query('SELECT * FROM deepl_catalog_drafts WHERE id=$1 FOR UPDATE', [
          job.payload.draft_id,
        ])
      ).rows[0];
      ensure(d, 404, 'Nie znaleziono szkicu');
      ensure(!d.batch_id, 409, 'Szkic należy do partii; użyj przeglądu partii');
      if (d.state !== 'queued') return null;
      ensure(!d.attempted_at, 409, 'Niepewna wcześniejsza próba nie może zostać powtórzona');
      ensure(new Date(d.expires_at).getTime() > Date.now(), 409, 'Podgląd DeepL wygasł');
      const ch = await channel(c, d.channel_id);
      ensure(binding(ch) === d.connection_hash, 409, 'Połączenie zmieniło się');
      ensure(
        (await c.query('SELECT version FROM products WHERE id=$1 FOR SHARE', [d.product_id]))
          .rows[0]?.version === d.source_version,
        409,
        'Produkt zmienił się',
      );
      ensure(
        d.simulation || process.env.DYNA_ALLOW_EXTERNAL_TRANSLATION === 'true',
        423,
        'Zewnętrzne tłumaczenie jest wyłączone',
      );
      return { d, ch };
    });
  if (!initial) {
    await tenantTx(a.tenantId, async (c) => {
      if (await fenceSync(c, job))
        await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1", [
          job.id,
        ]);
    });
    return;
  }
  const { d, ch } = initial,
    lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'deepl-catalog');
  let key = '';
  try {
    return await holdingDbLock(lock, async () => {
    await lock.connect();
    key = sha({ key: decrypt(ch.credentials).api_key, plan: ch.settings.api_plan });
    if (
      !(
        await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked', [
          'deepl-key:' + key,
        ])
      ).rows[0].locked
    ) {
      await tenantTx(a.tenantId, async (c) => {
        if (await fenceSync(c, job))
          await c.query(
            "UPDATE jobs SET state='pending',attempts=greatest(0,attempts-1),run_at=now()+interval '2 seconds',lease_token=NULL,locked_at=NULL WHERE id=$1",
            [job.id],
          );
      });
      return;
    }
    const wait = await cooldown(lock, key);
    if (wait) {
      ensure(
        wait.getTime() < new Date(d.expires_at).getTime(),
        409,
        'Przerwa DeepL przekracza ważność szkicu',
      );
      await tenantTx(a.tenantId, async (c) => {
        if (await fenceSync(c, job))
          await c.query(
            "UPDATE jobs SET state='pending',attempts=greatest(0,attempts-1),run_at=$2,lease_token=NULL,locked_at=NULL WHERE id=$1",
            [job.id, wait],
          );
      });
      return;
    }
    const client = deeplClient(ch, ctx);
    languagePair(await client.languages(), d.source_lang, d.target_lang, d.formality);
    quota(await client.usage(), d.characters);
    const dispatch = await tenantTx(a.tenantId, async (c) => {
      await deeplAdmin(c, a);
      if (!(await fenceSync(c, job, true))) return false;
      const current = (
        await c.query('SELECT * FROM deepl_catalog_drafts WHERE id=$1 FOR UPDATE', [d.id])
      ).rows[0];
      if (current.state !== 'queued') return false;
      ensure(!current.attempted_at, 409, 'Próba DeepL już rozpoczęta');
      ensure(new Date(current.expires_at).getTime() > Date.now(), 409, 'Podgląd wygasł');
      ensure(
        binding(await channel(c, ch.id)) === d.connection_hash,
        409,
        'Połączenie zmieniło się',
      );
      ensure(
        (await c.query('SELECT version FROM products WHERE id=$1 FOR SHARE', [d.product_id]))
          .rows[0]?.version === d.source_version,
        409,
        'Produkt zmienił się',
      );
      await c.query('UPDATE deepl_catalog_drafts SET attempted_at=now() WHERE id=$1', [d.id]);
      return true;
    });
    if (!dispatch) {
      await tenantTx(a.tenantId, async (c) => {
        if (await fenceSync(c, job))
          await c.query(
            "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1",
            [job.id],
          );
      });
      return;
    }
    const out = await client.translate(d.source, d.source_lang, d.target_lang, d.formality),
      output = deeplText.parse(out.output);
    await tenantTx(a.tenantId, async (c) => {
      if (!(await fenceSync(c, job, true))) return;
      const authorized = (await c.query('SELECT offer_sync_is_admin($1) ok', [a.userId])).rows[0]
        .ok;
      const current = (
        await c.query('SELECT version FROM products WHERE id=$1 FOR SHARE', [d.product_id])
      ).rows[0];
      const currentChannel = await channel(c, ch.id),
        valid =
          authorized &&
          current?.version === d.source_version &&
          binding(currentChannel) === d.connection_hash;
      await c.query(
        "UPDATE deepl_catalog_drafts SET state=$2,output=$3,usage=$4,error=$5,finished_at=now() WHERE id=$1 AND state='queued'",
        [
          d.id,
          valid ? 'ready' : 'conflict',
          JSON.stringify(output),
          JSON.stringify(out.usage),
          valid
            ? null
            : !authorized
              ? 'Administrator utracił uprawnienia podczas tłumaczenia'
              : 'Produkt lub połączenie zmieniło się podczas tłumaczenia',
        ],
      );
      await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1", [
        job.id,
      ]);
    });
    });
  } catch (e) {
    if (key) await recordCooldown(lock, key, e);
    throw e;
  } finally {
    await lock.end();
  }
}
export async function failDeepL(job: any, error: unknown) {
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await fenceSync(c, job, true))) return;
    const d = (
      await c.query('SELECT * FROM deepl_catalog_drafts WHERE job_id=$1 FOR UPDATE', [job.id])
    ).rows[0];
    if (!d) return;
    const safeRetry =
      error instanceof DeepLError &&
      (error.retryable || (!d.attempted_at && [500, 503, 504].includes(error.http))) &&
      job.attempts < 3 &&
      Date.now() + Math.max(error.retryAfter, 5 * 2 ** (job.attempts - 1)) * 1000 <
        new Date(d.expires_at).getTime();
    if (safeRetry && d.state === 'queued') {
      const seconds = Math.max(
        error instanceof DeepLError ? error.retryAfter : 5,
        5 * 2 ** (job.attempts - 1),
      );
      await c.query(
        "UPDATE deepl_catalog_drafts SET attempted_at=NULL,error='DeepL ograniczył żądania; ponowienie po przerwie' WHERE id=$1",
        [d.id],
      );
      await c.query(
        "UPDATE jobs SET state='pending',run_at=now()+$2*interval '1 second',lease_token=NULL,locked_at=NULL WHERE id=$1",
        [job.id, seconds],
      );
      return;
    }
    const uncertain = !!d.attempted_at && !(error instanceof DeepLError && error.rejected);
    const state = uncertain
      ? 'uncertain'
      : error instanceof Problem && error.status === 409
        ? 'conflict'
        : 'failed';
    const message = uncertain
      ? 'Wynik DeepL jest niepewny; użycie mogło zostać naliczone. Nie ponowiono żądania.'
      : error instanceof DeepLError
        ? error.message
        : error instanceof Problem
          ? error.message
          : 'Nie udało się przygotować tłumaczenia DeepL';
    await c.query(
      "UPDATE deepl_catalog_drafts SET state=$2,error=$3,finished_at=now() WHERE id=$1 AND state='queued'",
      [d.id, state, message],
    );
    await c.query(
      "UPDATE jobs SET state='failed',error=$2,lease_token=NULL,locked_at=NULL WHERE id=$1",
      [job.id, message],
    );
  });
}
export async function applyDeepL(a: Actor, id: string, body: unknown) {
  const b = deeplText
    .extend({ approve: z.literal(true), version: z.number().int().positive() })
    .strict()
    .parse(body);
  return tenantTx(a.tenantId, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'catalog:' + a.tenantId,
    ]);
    await deeplAdmin(c, a);
    const d = (await c.query('SELECT * FROM deepl_catalog_drafts WHERE id=$1 FOR UPDATE', [id]))
      .rows[0];
    ensure(d, 404, 'Nie znaleziono szkicu');
    ensure(!d.batch_id, 409, 'Szkic należy do partii; użyj przeglądu partii');
    const reviewed = { name: b.name, description: b.description };
    if (d.state === 'applied') {
      ensure(
        d.source_version === b.version && sha(d.reviewed_text) === sha(reviewed),
        409,
        'Szkic zastosowano z inną treścią',
      );
      return { draft: d, reused: true };
    }
    ensure(
      d.state === 'ready' && new Date(d.expires_at).getTime() > Date.now(),
      409,
      'Szkic nie jest gotowy lub wygasł',
    );
    const p = (await c.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [d.product_id]))
      .rows[0];
    ensure(
      p?.version === b.version && p.version === d.source_version,
      409,
      'Produkt zmienił się; nie nadpisano danych',
    );
    ensure(
      binding(await channel(c, d.channel_id)) === d.connection_hash,
      409,
      'Połączenie zmieniło się',
    );
    await c.query(
      `INSERT INTO product_translations(tenant_id,product_id,locale,name,description,deepl_draft_id,ai_draft_id) VALUES($1,$2,$3,$4,$5,$6,NULL) ON CONFLICT(tenant_id,product_id,locale) DO UPDATE SET name=excluded.name,description=excluded.description,deepl_draft_id=excluded.deepl_draft_id,ai_draft_id=NULL,${(await c.query("SELECT to_regclass('public.product_translation_bulk_edit_execution_rows') p")).rows[0].p ? 'manual_receipt_id=NULL,' : ''}version=product_translations.version+1,updated_at=now()`,
      [a.tenantId, p.id, d.target_lang, b.name, b.description, d.id],
    );
    await c.query('UPDATE products SET version=version+1 WHERE id=$1', [p.id]);
    const draft = (
      await c.query(
        "UPDATE deepl_catalog_drafts SET state='applied',reviewed_text=$2,applied_version=$3 WHERE id=$1 RETURNING *",
        [id, JSON.stringify(reviewed), p.version + 1],
      )
    ).rows[0];
    await audit(c, a, 'deepl.apply', id, {
      product_id: p.id,
      locale: d.target_lang,
      reviewed_hash: sha(reviewed),
      simulation: d.simulation,
    });
    await emitCatalogProductEvent(c, a, p.id, 'product.updated', d.id);
    return { draft, reused: false };
  });
}
export async function cancelDeepL(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await deeplAdmin(c, a);
    const d = (await c.query('SELECT * FROM deepl_catalog_drafts WHERE id=$1 FOR UPDATE', [id]))
      .rows[0];
    ensure(d, 404, 'Nie znaleziono szkicu');
    ensure(!d.batch_id, 409, 'Szkic należy do partii; użyj przeglądu partii');
    ensure(
      (['prepared', 'queued', 'ready', 'cancelled'].includes(d.state) && !d.attempted_at) ||
        d.state === 'ready' ||
        d.state === 'cancelled',
      409,
      'Próba DeepL rozpoczęta; nie można odwołać użycia znaków',
    );
    await c.query("UPDATE deepl_catalog_drafts SET state='cancelled' WHERE id=$1", [id]);
    await audit(c, a, 'deepl.cancel', id, {});
    return { cancelled: true };
  });
}
export async function tickDeepL(ctx: IntegrationContext = {}) {
  await pool.query(
    "UPDATE jobs SET state='failed',error='Dzierżawa DeepL wygasła',lease_token=NULL,locked_at=NULL WHERE kind='catalog.deepl' AND state='running' AND locked_at<now()-interval '2 minutes'",
  );
  await pool.query(
    "UPDATE deepl_catalog_drafts d SET state=CASE WHEN attempted_at IS NOT NULL THEN 'uncertain' ELSE 'failed' END,error='Dzierżawa DeepL wygasła; nie powtórzono tłumaczenia',finished_at=now() FROM jobs j WHERE (j.tenant_id,j.id)=(d.tenant_id,d.job_id) AND j.state='failed' AND d.state='queued'",
  );
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$1,locked_at=now() WHERE id=(SELECT id FROM jobs WHERE kind='catalog.deepl' AND state='pending' AND run_at<=now() ORDER BY run_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",
      [randomUUID()],
    )
  ).rows[0];
  if (!job) return false;
  try {
    await processDeepL(job, ctx);
  } catch (e) {
    await failDeepL(job, e);
  }
  return true;
}
export function startDeepLWorker() {
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = (async () => {
      try {
        await tickDeepL();
      } catch {
        console.error('DeepL worker: błąd kolejki');
      } finally {
        running = undefined;
      }
    })();
  }, 1000);
  return async () => {
    clearInterval(timer);
    await running;
  };
}
