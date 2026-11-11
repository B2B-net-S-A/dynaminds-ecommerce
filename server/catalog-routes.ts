import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { tenantTx, tenantReadTx } from './db';
import { decodePage, encodePage } from './inventory';
import { ensure } from './errors';
import { audit } from './domain';
import { productImageData } from './product-image-format';
import { productLogisticsRequestActor } from './product-logistics';
import { deleteProductInTx, productDeletionSchema } from './product-deletion-command';
import {
  listProducts,
  productDetail,
  editProduct,
  editSchema,
  previewCsv,
  applyCsv,
} from './catalog';
const imageDir = resolve(process.env.DYNA_IMAGE_DIR ?? 'data/product-images');
export function registerCatalogRoutes(app: FastifyInstance, readTx: typeof tenantTx = tenantTx) {
  const admin = (req: any) =>
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
  const idOf = (p: any) => z.object({ id: z.uuid() }).parse(p).id;
  app.get('/api/products', async (req) => {
    const q = z
      .object({
        search: z.string().max(200).default(''),
        warehouse_id: z.uuid().optional(),
        catalog_id: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        after: z.uuid().optional(),
        sellable: z.enum(['true', 'false']).optional(),
      })
      .parse(req.query);
    return readTx(req.actor.tenantId, (c) =>
      listProducts(c, { ...q, sellable: q.sellable === 'true' }, readTx !== tenantTx),
    );
  });
  app.get('/api/products/:id', (req) =>
    readTx(req.actor.tenantId, (c) => productDetail(c, idOf(req.params), readTx !== tenantTx)),
  );
  app.patch('/api/products/:id', (req) => {
    admin(req);
    const b = editSchema.parse(req.body);
    return tenantTx(req.actor.tenantId, (c) =>
      editProduct(c, productLogisticsRequestActor(req), idOf(req.params), b),
    );
  });
  // 225: permanent "deleted" state (refusals and effects: server/product-deletion-command.ts).
  app.post('/api/products/:id/deletion', (req) => {
    admin(req);
    const b = productDeletionSchema.parse(req.body);
    return tenantTx(req.actor.tenantId, (c) => deleteProductInTx(c, productLogisticsRequestActor(req), idOf(req.params), b));
  });
  app.post('/api/catalog/imports/preview', (req) => {
    admin(req);
    const b = z
      .object({ warehouse_id: z.uuid(), catalog_id: z.uuid().optional(), csv: z.string().min(1).max(500000) })
      .parse(req.body);
    return tenantTx(req.actor.tenantId, (c) => previewCsv(c, req.actor, b.warehouse_id, b.csv, b.catalog_id));
  });
  app.post('/api/catalog/imports/:id/apply', (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, (c) => applyCsv(c, req.actor, idOf(req.params)));
  });
  app.get('/api/product-images', async (req, reply) => {
    ensure(['admin', 'operator', 'viewer'].includes(req.actor.role), 403, 'Brak uprawnień do biblioteki zdjęć');
    const q = z.strictObject({
      mime: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(25),
      after: z.string().min(1).max(500).optional(),
    }).parse(req.query);
    const after = decodePage(q.after, z.strictObject({
      tenant: z.uuid(), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']).nullable(),
      limit: z.number().int().min(1).max(50),
      time: z.iso.datetime({precision: 6}), id: z.uuid(),
    }));
    ensure(!after || (after.tenant === req.actor.tenantId && after.mime === (q.mime ?? null) && after.limit === q.limit), 422, 'Kursor należy do innej firmy lub innych filtrów biblioteki');
    const rows = await tenantReadTx(req.actor.tenantId, async c => (await c.query(
      `SELECT id,mime,size,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM product_images WHERE tenant_id=$1 AND ($2::text IS NULL OR mime=$2)
       AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
       ORDER BY product_images.created_at DESC,product_images.id DESC LIMIT $5`,
      [req.actor.tenantId,q.mime ?? null,after?.time ?? null,after?.id ?? null,q.limit+1],
    )).rows);
    const data = rows.slice(0,q.limit).map(row => ({id:row.id,url:'/api/product-images/'+row.id,mime:row.mime,size:row.size,created_at:row.created_at}));
    const last=data.at(-1);
    return reply.header('Cache-Control','private, no-store').send({data,next:rows.length>q.limit&&last?encodePage({tenant:req.actor.tenantId,mime:q.mime??null,limit:q.limit,time:last.created_at,id:last.id}):null});
  });
  app.post('/api/product-images', async (req, reply) => {
    admin(req);
    const b = z.object({ data: z.string().min(1).max(699052) }).parse(req.body);
    const { bytes, mime } = productImageData(b.data);
    const id = randomUUID(),
      file = resolve(imageDir, id);
    await mkdir(imageDir, { recursive: true });
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    try {
      await tenantTx(req.actor.tenantId, async (c) => {
        await c.query('INSERT INTO product_images(id,tenant_id,mime,size) VALUES($1,$2,$3,$4)', [
          id,
          req.actor.tenantId,
          mime,
          bytes.length,
        ]);
        await audit(c, req.actor, 'product.image.upload', id, { mime, size: bytes.length });
      });
    } catch (e) {
      await unlink(file).catch(() => {});
      throw e;
    }
    return reply.code(201).send({ id, url: `/api/product-images/${id}`, mime, size: bytes.length });
  });
  app.get('/api/product-images/:id', async (req, reply) => {
    const id = idOf(req.params),
      img = await tenantTx(
        req.actor.tenantId,
        async (c) => (await c.query('SELECT * FROM product_images WHERE id=$1', [id])).rows[0],
      );
    ensure(img, 404, 'Nie znaleziono zdjęcia');
    const bytes = await readFile(resolve(imageDir, id)).catch(() => null);
    ensure(bytes, 404, 'Plik zdjęcia jest niedostępny');
    return reply
      .type(img.mime)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .send(bytes);
  });
}
