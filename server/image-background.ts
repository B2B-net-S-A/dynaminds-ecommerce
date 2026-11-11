/** DOM-AI-004: background removal creates a NEW product image (migration 249, table catalog_ai_image_jobs).
 * A request is queued for one image of one product; a local background processor (loopback HTTP only) returns a
 * transparent PNG that becomes a new ordinary product_images row with lineage in catalog_ai_image_jobs. The original
 * row and file are never deleted or modified. products.images changes only when an administrator accepts the
 * result: the source URL is swapped for the new one under the product row lock with a version CAS.
 *
 * Processor contract (e.g. a local rembg server, `rembg s`): POST <DYNA_IMAGE_BG_URL>/api/remove with multipart
 * field `file` = the original image bytes; answer = PNG bytes. Only the image is sent: no product text, no customer
 * data (product images hold no personal data). A loopback processor has no credentials, so none are configured or
 * sent. No DNS, no redirects, bounded answer (512 KiB like uploads), timeout.
 *
 * States: queued -> running (lease) -> ready | failed; queued -> cancelled | failed (expired);
 * ready -> applied | rejected. One automatic attempt; a stale running lease is failed by the next tick. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import type { Transport } from './integrations';
import { admin, aiBase } from './catalog-ai';
import { emitCatalogProductEvent } from './product-rule-events';
import { assertProductsNotDeletedInTx } from './product-deletions';
import { systemActor } from './sync';

export const IMAGE_BACKGROUND_FAILED = 'Usuwanie tła nie powiodło się';
const MAX_BYTES = 524288;
const LEASE = "interval '3 minutes'";
const HISTORY = 30;
const imageDir = () => resolve(process.env.DYNA_IMAGE_DIR ?? 'data/product-images');
const imageUrl = (id: string) => '/api/product-images/' + id;
const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');

/** Same rules as the local AI engine (aiBase): numeric loopback http origin without path or credentials. */
export function imageBackgroundBase(value: string | undefined = process.env.DYNA_IMAGE_BG_URL): string {
  return aiBase(value || 'http://127.0.0.1:11436');
}

export async function imageBackgroundAvailable(db: { query: typeof pool.query } = pool): Promise<boolean> {
  return Boolean((await db.query("SELECT to_regclass('public.catalog_ai_image_jobs') present")).rows[0].present);
}

/** Decompression-bomb bounds for the processor's answer, from IHDR alone (the bytes are never inflated here):
 * at most 25 megapixels and at most 100 MiB of filtered scanlines (25 MP at 8-bit RGBA fits; 16-bit RGBA does not). */
export const RESULT_MAX_PIXELS = 25_000_000;
export const RESULT_MAX_RAW_BYTES = 104_857_600;
/** Channels and allowed bit depths per PNG colour type (PNG spec, IHDR). */
const PNG_COLOUR: Record<number, { channels: number; depths: number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};

/** The processor's answer must be a complete PNG with an alpha channel or a tRNS chunk, within the bomb bounds. */
export function transparentPng(bytes: Buffer): { width: number; height: number } {
  const bad = () => new Problem(502, 'Procesor tła nie zwrócił obrazu PNG');
  const tooLarge = () => new Problem(502, 'Wynik procesora tła jest zbyt duży (limit 25 megapikseli)');
  if (bytes.length < 8 + 25 + 12 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw bad();
  let at = 8, first = true, alpha = false, ended = false, width = 0, height = 0;
  while (at + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(at), type = bytes.subarray(at + 4, at + 8).toString('latin1');
    if (len > bytes.length - at - 12) throw bad();
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (first) {
      if (type !== 'IHDR' || len !== 13) throw bad();
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (!width || !height || width > 10000 || height > 10000) throw bad();
      const colour = PNG_COLOUR[data[9]], depth = data[8];
      if (!colour || !colour.depths.includes(depth) || data[10] !== 0 || data[11] !== 0 || data[12] > 1) throw bad();
      // One filter byte per scanline plus the packed samples (as non-interlaced; Adam7 adds only per-pass filter and padding bytes).
      const raw = height * (1 + Math.ceil((width * colour.channels * depth) / 8));
      if (width * height > RESULT_MAX_PIXELS || raw > RESULT_MAX_RAW_BYTES) throw tooLarge();
      alpha = data[9] === 4 || data[9] === 6;
      first = false;
    } else if (type === 'tRNS') alpha = true;
    at += 12 + len;
    if (type === 'IEND') {
      ended = at === bytes.length;
      break;
    }
  }
  if (!ended) throw bad();
  if (!alpha) throw new Problem(502, 'Wynik procesora tła nie zawiera przezroczystości');
  return { width, height };
}

/** Failure text stored for people: our own Polish Problem messages only, never runtime or processor text. */
export function safeImageError(e: unknown): string {
  return e instanceof Problem && e.message.length <= 300 ? e.message : IMAGE_BACKGROUND_FAILED;
}

async function removeBackground(bytes: Buffer, mime: string, transport: Transport, timeoutMs: number): Promise<Buffer> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), 'image');
  const unavailable = 'Lokalny procesor tła jest niedostępny lub przekroczył czas odpowiedzi';
  const signal = AbortSignal.timeout(timeoutMs);
  let r: Response;
  try {
    r = await transport(imageBackgroundBase() + '/api/remove', { method: 'POST', redirect: 'error', body: form, signal });
  } catch {
    throw new Problem(503, unavailable);
  }
  ensure(r.ok, 502, 'Lokalny procesor tła odrzucił zdjęcie');
  ensure(/^image\/png(;|$)/i.test(r.headers.get('content-type') ?? ''), 502, 'Procesor tła nie zwrócił obrazu PNG');
  const reader = r.body?.getReader();
  ensure(reader, 502, 'Procesor tła nie zwrócił obrazu PNG');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      let p: ReadableStreamReadResult<Uint8Array>;
      try {
        p = await reader.read();
      } catch {
        throw new Problem(503, unavailable);
      }
      if (p.done) break;
      size += p.value.length;
      ensure(size <= MAX_BYTES, 502, 'Wynik procesora tła przekracza 512 KiB');
      chunks.push(p.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  ensure(!signal.aborted, 503, unavailable);
  return Buffer.concat(chunks);
}

type Row = Record<string, any>;
/** API view: lease and request hash stay internal. */
export function imageJobView(r: Row) {
  const { lease_token: _lease, request_hash: _hash, ...rest } = r;
  return {
    ...rest,
    source_url: imageUrl(r.source_image_id),
    result_url: r.result_image_id ? imageUrl(r.result_image_id) : null,
  };
}

const productImages = (images: unknown): { id: string; url: string }[] =>
  (Array.isArray(images) ? images : [])
    .filter((u): u is string => typeof u === 'string' && /^\/api\/product-images\/[0-9a-f-]{36}$/.test(u))
    .map((url) => ({ id: url.split('/').at(-1)!, url }));

export const imageQueueRequest = z.object({ client_key: z.uuid(), image_id: z.uuid(), version: z.number().int().positive() }).strict();
const applyRequest = z.object({ approve: z.literal(true), version: z.number().int().positive() }).strict();

async function jobForUpdate(c: PoolClient, id: string) {
  const j = (await c.query('SELECT * FROM catalog_ai_image_jobs WHERE id=$1 FOR UPDATE', [id])).rows[0];
  ensure(j, 404, 'Nie znaleziono zlecenia usuwania tła');
  return j;
}

export async function listImageBackground(a: Actor, productId: string, readOnly: boolean) {
  return tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    const p = (await c.query('SELECT id,version,images FROM products WHERE id=$1', [productId])).rows[0];
    ensure(p, 404, 'Nie znaleziono produktu');
    const rows = (
      await c.query('SELECT * FROM catalog_ai_image_jobs WHERE product_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2', [productId, HISTORY])
    ).rows;
    return { available: true, read_only: readOnly, version: p.version, images: productImages(p.images), data: rows.map(imageJobView), history_limit: HISTORY };
  });
}

export async function queueImageBackground(a: Actor, productId: string, body: unknown) {
  const b = imageQueueRequest.parse(body);
  const hash = sha({ product: productId, image: b.image_id, version: b.version, operation: 'background_removed' });
  return tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['catalog-ai-image-queue:' + a.tenantId]);
    const existing = (await c.query('SELECT * FROM catalog_ai_image_jobs WHERE client_key=$1', [b.client_key])).rows[0];
    if (existing) {
      ensure(existing.request_hash === hash, 409, 'Klucz zlecenia wykorzystano dla innego żądania');
      return { job: imageJobView(existing), replayed: true };
    }
    const p = (await c.query('SELECT id,version,images FROM products WHERE id=$1 FOR SHARE', [productId])).rows[0];
    ensure(p, 404, 'Nie znaleziono produktu');
    await assertProductsNotDeletedInTx(c, [productId]);
    ensure(p.version === b.version, 409, 'Produkt zmieniono; odśwież kartę przed usuwaniem tła');
    ensure(productImages(p.images).some((x) => x.id === b.image_id), 422, 'Zdjęcie nie należy do tego produktu');
    const img = (await c.query('SELECT id,mime FROM product_images WHERE id=$1', [b.image_id])).rows[0];
    ensure(img, 422, 'Zdjęcie nie należy do tego produktu');
    ensure(
      !(await c.query("SELECT 1 FROM catalog_ai_image_jobs WHERE source_image_id=$1 AND state IN ('queued','running')", [b.image_id])).rowCount,
      409,
      'Dla tego zdjęcia trwa już usuwanie tła',
    );
    const open = (await c.query("SELECT count(*)::int n FROM catalog_ai_image_jobs WHERE state IN ('queued','running')")).rows[0].n;
    ensure(open < 20, 429, 'Kolejka usuwania tła jest pełna; zaczekaj na zakończenie zleceń');
    const id = randomUUID();
    const r = (
      await c.query(
        'INSERT INTO catalog_ai_image_jobs(id,tenant_id,product_id,actor_id,client_key,request_hash,source_image_id,source_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [id, a.tenantId, productId, a.userId, b.client_key, hash, b.image_id, p.version],
      )
    ).rows[0];
    await audit(c, a, 'catalog.ai.image.queue', id, { product_id: productId, source_image_id: b.image_id, operation: 'background_removed' });
    return { job: imageJobView(r), replayed: false };
  });
}

export async function applyImageBackground(a: Actor, id: string, body: unknown) {
  const b = applyRequest.parse(body);
  return tenantTx(a.tenantId, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['catalog:' + a.tenantId]);
    await admin(c, a);
    const j = await jobForUpdate(c, id);
    if (j.state === 'applied') {
      ensure(j.applied_version === b.version + 1, 409, 'To zdjęcie zastosowano dla innej wersji produktu');
      return { job: imageJobView(j), reused: true };
    }
    ensure(j.state === 'ready', 409, 'Wynik usuwania tła nie jest gotowy do zastosowania');
    const p = (await c.query('SELECT id,version,images FROM products WHERE id=$1 FOR UPDATE', [j.product_id])).rows[0];
    ensure(p, 404, 'Nie znaleziono produktu');
    await assertProductsNotDeletedInTx(c, [p.id]);
    ensure(p.version === b.version, 409, 'Produkt zmieniono; nie zmieniono zdjęć');
    const images: unknown[] = Array.isArray(p.images) ? p.images : [];
    const source = imageUrl(j.source_image_id), result = imageUrl(j.result_image_id);
    ensure(images.includes(source), 409, 'Zdjęcie źródłowe nie należy już do produktu');
    ensure(!images.includes(result), 409, 'Nowe zdjęcie jest już w produkcie');
    const next = images.map((u) => (u === source ? result : u));
    await c.query('UPDATE products SET images=$2::jsonb,version=version+1 WHERE id=$1', [p.id, JSON.stringify(next)]);
    const r = (
      await c.query(
        "UPDATE catalog_ai_image_jobs SET state='applied',applied_version=$2,decided_by=$3,decided_at=now() WHERE id=$1 RETURNING *",
        [id, p.version + 1, a.userId],
      )
    ).rows[0];
    await audit(c, a, 'catalog.ai.image.apply', id, {
      product_id: p.id,
      source_image_id: j.source_image_id,
      result_image_id: j.result_image_id,
      version: p.version + 1,
    });
    await emitCatalogProductEvent(c, a, p.id, 'product.updated', id as `${string}-${string}-${string}-${string}-${string}`);
    return { job: imageJobView(r), reused: false };
  });
}

/** Ready -> rejected, queued -> cancelled; both images stay. A repeat answers the same terminal row. */
export async function rejectImageBackground(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    const j = await jobForUpdate(c, id);
    if (['rejected', 'cancelled'].includes(j.state)) return { job: imageJobView(j) };
    ensure(['ready', 'queued'].includes(j.state), 409, 'Tego zlecenia nie można już odrzucić');
    const state = j.state === 'ready' ? 'rejected' : 'cancelled';
    const r = (
      await c.query(
        'UPDATE catalog_ai_image_jobs SET state=$2,decided_by=$3,decided_at=now(),finished_at=coalesce(finished_at,now()) WHERE id=$1 RETURNING *',
        [id, state, a.userId],
      )
    ).rows[0];
    await audit(c, a, state === 'rejected' ? 'catalog.ai.image.reject' : 'catalog.ai.image.cancel', id, { product_id: j.product_id });
    return { job: imageJobView(r) };
  });
}

/** One leased job: read the source, call the processor outside any transaction, publish only under the same lease. */
export async function processImageBackground(job: Row, transport: Transport = fetch, timeoutMs = 60000) {
  const a = await systemActor(job.tenant_id, job.actor_id);
  const source = await tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    const j = (
      await c.query("SELECT * FROM catalog_ai_image_jobs WHERE id=$1 AND lease_token=$2 AND state='running'", [job.id, job.lease_token])
    ).rows[0];
    ensure(j, 409, 'Dzierżawa usuwania tła wygasła; zleć ponownie');
    const img = (await c.query('SELECT id,mime FROM product_images WHERE id=$1', [j.source_image_id])).rows[0];
    ensure(img, 404, 'Nie znaleziono zdjęcia źródłowego');
    return img;
  });
  const bytes = await readFile(resolve(imageDir(), source.id)).catch(() => null);
  ensure(bytes && bytes.length > 0 && bytes.length <= MAX_BYTES, 404, 'Plik zdjęcia źródłowego jest niedostępny');
  const out = await removeBackground(bytes, source.mime, transport, timeoutMs);
  transparentPng(out);
  const id = randomUUID(), file = resolve(imageDir(), id);
  await mkdir(imageDir(), { recursive: true });
  await writeFile(file, out, { flag: 'wx', mode: 0o600 });
  let published = false;
  try {
    published = await tenantTx(a.tenantId, async (c) => {
      await admin(c, a);
      const j = (await c.query('SELECT * FROM catalog_ai_image_jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
      if (j?.state !== 'running' || j.lease_token !== job.lease_token) return false;
      await c.query("INSERT INTO product_images(id,tenant_id,mime,size) VALUES($1,$2,'image/png',$3)", [id, a.tenantId, out.length]);
      await c.query(
        "UPDATE catalog_ai_image_jobs SET state='ready',result_image_id=$2,result_sha256=$3,result_size=$4,lease_token=NULL,locked_at=NULL,finished_at=now() WHERE id=$1",
        [job.id, id, sha(out), out.length],
      );
      await audit(c, a, 'catalog.ai.image.ready', job.id, { product_id: j.product_id, source_image_id: j.source_image_id, result_image_id: id, size: out.length });
      return true;
    });
  } finally {
    if (!published) await unlink(file).catch(() => {});
  }
}

export async function failImageBackground(job: Row, e: unknown) {
  await tenantTx(job.tenant_id, (c) =>
    c.query(
      "UPDATE catalog_ai_image_jobs SET state='failed',error=$3,lease_token=NULL,locked_at=NULL,finished_at=now() WHERE id=$1 AND lease_token=$2 AND state='running'",
      [job.id, job.lease_token, safeImageError(e)],
    ),
  );
}

/** One queue step for startCatalogAiWorker: sweep stale leases and expired requests, then claim and process at
 * most one job. Returns whether a job was claimed. The pool session reads all tenants (as tickCatalogAi does). */
export async function tickImageBackground(transport: Transport = fetch, timeoutMs = 60000): Promise<boolean> {
  if (!(await imageBackgroundAvailable())) return false;
  await pool.query(
    `UPDATE catalog_ai_image_jobs SET state='failed',error='Dzierżawa usuwania tła wygasła; zleć ponownie',lease_token=NULL,locked_at=NULL,finished_at=now() WHERE state='running' AND locked_at<now()-${LEASE}`,
  );
  await pool.query(
    "UPDATE catalog_ai_image_jobs SET state='failed',error='Zlecenie usuwania tła wygasło przed przetworzeniem',finished_at=now() WHERE state='queued' AND expires_at<=now()",
  );
  const job = (
    await pool.query(
      "UPDATE catalog_ai_image_jobs SET state='running',attempts=attempts+1,lease_token=$1,locked_at=now() WHERE id=(SELECT id FROM catalog_ai_image_jobs WHERE state='queued' AND attempts=0 AND expires_at>now() ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",
      [randomUUID()],
    )
  ).rows[0];
  if (!job) return false;
  try {
    await processImageBackground(job, transport, timeoutMs);
  } catch (e) {
    await failImageBackground(job, e);
  }
  return true;
}
