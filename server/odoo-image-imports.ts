import { emitCatalogProductEvent } from './product-rule-events';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import { audit, type Actor } from './domain';
import { sourceHash } from './catalog-source-normalize';
import { connectionHash } from './offer-sync-policy';
import { decrypt } from './security';
import { Odoo, odooId } from './odoo';
import { safeFetch } from './integrations';
import type { IntegrationContext } from './channel-access';
import { demoOdooImage } from './odoo-image-demo';
const imageDir = () => resolve(process.env.DYNA_IMAGE_DIR ?? 'data/product-images');
export const imagePreviewInput = z
  .object({ channel_id: z.uuid(), version: z.number().int().positive(), client_key: z.uuid() })
  .strict();
export const imageApplyInput = z.object({ confirm: z.literal(true) }).strict();
const meta = (r: any) => ({
  id: r.id,
  product_id: r.product_id,
  channel_id: r.channel_id,
  image_id: r.image_id,
  url: '/api/product-images/' + r.image_id,
  sha256: r.sha256,
  state: r.state,
  mode: r.mode,
  expires_at: r.expires_at,
  created_at: r.created_at,
});
async function admin(c: PoolClient, a: Actor) {
  ensure(
    (await c.query('SELECT odoo_image_authorized($1) ok', [a.userId])).rows[0]?.ok,
    403,
    'Wymagana aktualna rola administratora',
  );
}
const imageConnection = (ch: any, l: any) =>
  sourceHash({ connection: connectionHash(ch), parent: l.parent_external_id ?? null });
async function policy(
  c: PoolClient,
  a: Actor,
  product: string,
  channel: string,
  version: number,
  pinned?: any,
) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['catalog:' + a.tenantId]);
  const p = (await c.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [product])).rows[0];
  ensure(p, 404, 'Nie znaleziono produktu');
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [channel])).rows[0];
  ensure(ch?.provider === 'odoo', 404, 'Nie znaleziono konta Odoo');
  const l = (
    await c.query('SELECT * FROM listings WHERE product_id=$1 AND channel_id=$2 FOR SHARE', [
      product,
      channel,
    ])
  ).rows;
  ensure(l.length === 1, 409, 'Wymagane jedno powiązanie wariantu Odoo z produktem');
  ensure(
    p.active && p.kind !== 'group' && p.kind !== 'bundle',
    409,
    'Zdjęcie wymaga aktywnego produktu fizycznego',
  );
  odooId(l[0].external_id);
  await admin(c, a);
  ensure(p.version === version, 409, 'Produkt zmienił się; odśwież kartę i przygotuj nowy podgląd');
  ensure(
    !pinned ||
      (pinned.listing_id === l[0].id &&
        pinned.remote_id === l[0].external_id &&
        pinned.connection_hash === imageConnection(ch, l[0]) &&
        pinned.credentials_hash === sourceHash(ch.credentials) &&
        pinned.mode === (ch.settings.simulation ? 'simulation' : 'external')),
    409,
    'Powiązanie, konto lub klucz Odoo zmieniły się od podglądu',
  );
  return { p, ch, l: l[0] };
}
async function previewCapacity(c: PoolClient, product: string) {
  const n = (
    await c.query(
      "SELECT count(*)::int n FROM odoo_image_imports WHERE product_id=$1 AND state='preview' AND expires_at>now()",
      [product],
    )
  ).rows[0].n;
  ensure(
    n < 10,
    409,
    'Masz już 10 aktywnych podglądów tego produktu; zatwierdź wybrany lub poczekaj na wygaśnięcie',
  );
}
export async function previewOdooImage(
  a: Actor,
  product: string,
  b: z.infer<typeof imagePreviewInput>,
  ctx: IntegrationContext = {},
) {
  const hash = sourceHash(b);
  const initial: any = await tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    const prior = (
      await c.query('SELECT * FROM odoo_image_imports WHERE product_id=$1 AND client_key=$2', [
        product,
        b.client_key,
      ])
    ).rows[0];
    if (prior) {
      ensure(
        prior.actor_id === a.userId && prior.input_hash === hash,
        409,
        'Klucz podglądu już wykorzystano',
      );
      return { prior };
    }
    const current = await policy(c, a, product, b.channel_id, b.version);
    await previewCapacity(c, product);
    return current;
  });
  if (initial.prior) return { ...meta(initial.prior), reused: true };
  const pinned = {
    listing_id: initial.l.id,
    remote_id: initial.l.external_id,
    connection_hash: imageConnection(initial.ch, initial.l),
    credentials_hash: sourceHash(initial.ch.credentials),
    mode: initial.ch.settings.simulation ? 'simulation' : 'external',
  };
  const fence = () =>
    tenantTx(a.tenantId, (c) => policy(c, a, product, b.channel_id, b.version, pinned)).then(
      () => {},
    );
  let bytes: Buffer, mime: string;
  if (pinned.mode === 'simulation') {
    await fence();
    bytes = demoOdooImage();
    mime = 'image/png';
  } else {
    const img = await new Odoo(
      initial.ch.settings,
      decrypt(initial.ch.credentials),
      ctx.transport ?? safeFetch,
    ).primaryImage(odooId(pinned.remote_id), fence);
    ensure(
      !initial.l.parent_external_id ||
        initial.l.parent_external_id === 'template:' + img.template_id,
      409,
      'Rodzic wariantu ERP zmienił się od powiązania',
    );
    bytes = img.bytes;
    mime = img.mime;
  }
  const sha = createHash('sha256').update(bytes).digest('hex'),
    image = randomUUID(),
    file = resolve(imageDir(), image);
  await mkdir(imageDir(), { recursive: true });
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  try {
    return await tenantTx(a.tenantId, async (c) => {
      await policy(c, a, product, b.channel_id, b.version, pinned);
      const prior = (
        await c.query('SELECT * FROM odoo_image_imports WHERE product_id=$1 AND client_key=$2', [
          product,
          b.client_key,
        ])
      ).rows[0];
      if (prior) {
        ensure(
          prior.input_hash === hash && prior.actor_id === a.userId,
          409,
          'Klucz podglądu już wykorzystano',
        );
        await unlink(file);
        return { ...meta(prior), reused: true };
      }
      await previewCapacity(c, product);
      await c.query('INSERT INTO product_images(id,tenant_id,mime,size) VALUES($1,$2,$3,$4)', [
        image,
        a.tenantId,
        mime,
        bytes.length,
      ]);
      const r = (
        await c.query(
          'INSERT INTO odoo_image_imports(id,tenant_id,product_id,channel_id,listing_id,actor_id,client_key,input_hash,connection_hash,credentials_hash,product_version,image_id,sha256,remote_id,mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',
          [
            randomUUID(),
            a.tenantId,
            product,
            b.channel_id,
            pinned.listing_id,
            a.userId,
            b.client_key,
            hash,
            pinned.connection_hash,
            pinned.credentials_hash,
            b.version,
            image,
            sha,
            pinned.remote_id,
            pinned.mode,
          ],
        )
      ).rows[0];
      await audit(c, a, 'odoo.image.preview', r.id, {
        product_id: product,
        sha256: sha,
        mode: pinned.mode,
        size: bytes.length,
      });
      return meta(r);
    });
  } catch (e) {
    await unlink(file).catch(() => {});
    throw e;
  }
}
export async function applyOdooImage(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'catalog:' + a.tenantId,
    ]);
    const r = (await c.query('SELECT * FROM odoo_image_imports WHERE id=$1 FOR UPDATE', [id]))
      .rows[0];
    ensure(r, 404, 'Nie znaleziono podglądu zdjęcia');
    await admin(c, a);
    ensure(r.actor_id === a.userId, 403, 'Podgląd należy do innego administratora');
    if (r.state === 'applied') return { ...meta(r), reused: true };
    ensure(new Date(r.expires_at).getTime() > Date.now(), 409, 'Podgląd wygasł; przygotuj nowy');
    const { p } = await policy(c, a, r.product_id, r.channel_id, r.product_version, r);
    const img = (await c.query('SELECT * FROM product_images WHERE id=$1 FOR SHARE', [r.image_id]))
      .rows[0];
    const bytes = await readFile(resolve(imageDir(), r.image_id)).catch(() => null);
    ensure(
      bytes &&
        bytes.length === img?.size &&
        createHash('sha256').update(bytes).digest('hex') === r.sha256,
      502,
      'Plik podglądu nie przeszedł kontroli integralności',
    );
    // Avoid duplicate gallery entries when a later preview captures identical provider bytes.
    const existing = (
      await c.query(
        "SELECT image_id FROM odoo_image_imports WHERE product_id=$1 AND sha256=$2 AND state='applied' ORDER BY applied_at DESC LIMIT 1",
        [r.product_id, r.sha256],
      )
    ).rows[0];
    const url = '/api/product-images/' + (existing?.image_id ?? r.image_id);
    const duplicate = p.images.includes(url);
    ensure(duplicate || p.images.length < 10, 409, 'Galeria ma już 10 zdjęć');
    if (!duplicate)
      await c.query('UPDATE products SET images=images||$2::jsonb,version=version+1 WHERE id=$1', [
        p.id,
        JSON.stringify([url]),
      ]);
    const saved = (
      await c.query(
        "UPDATE odoo_image_imports SET state='applied',applied_at=now() WHERE id=$1 RETURNING *",
        [id],
      )
    ).rows[0];
    await audit(c, a, 'odoo.image.applied', id, {
      product_id: p.id,
      sha256: r.sha256,
      duplicate,
      mode: r.mode,
    });
    if (!duplicate) await emitCatalogProductEvent(c, a, p.id, 'product.updated', r.id);
    return { ...meta(saved), gallery_url: url, duplicate };
  });
}
export function registerOdooImageRoutes(app: FastifyInstance, ctx: IntegrationContext = {}) {
  const id = (p: any) => z.object({ id: z.uuid() }).parse(p).id;
  app.get('/api/products/:id/odoo-images', (r) =>
    tenantTx(r.actor.tenantId, async (c) => {
      const p = (await c.query('SELECT id FROM products WHERE id=$1', [id(r.params)])).rows[0];
      ensure(p, 404, 'Nie znaleziono produktu');
      const mappings = (
        await c.query(
          "SELECT ch.id,ch.name,l.external_id,ch.settings->>'simulation' AS simulation FROM channels ch JOIN listings l ON (l.tenant_id,l.channel_id)=(ch.tenant_id,ch.id) WHERE l.product_id=$1 AND ch.provider='odoo' ORDER BY ch.name,ch.id",
          [p.id],
        )
      ).rows;
      const history = (
        await c.query(
          'SELECT * FROM odoo_image_imports WHERE product_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25',
          [p.id],
        )
      ).rows.map((v: any) => ({
        ...meta(v),
        can_apply:
          v.actor_id === r.actor.userId && r.actor.role === 'admin' && v.state === 'preview',
      }));
      return { mappings, history };
    }),
  );
  app.post('/api/products/:id/odoo-images/preview', (r) =>
    previewOdooImage(r.actor, id(r.params), imagePreviewInput.parse(r.body), ctx),
  );
  app.post('/api/odoo-image-imports/:id/apply', (r) => {
    imageApplyInput.parse(r.body);
    return applyOdooImage(r.actor, id(r.params));
  });
}
