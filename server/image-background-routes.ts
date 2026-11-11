/** DOM-AI-004 routes (migration 249, server/image-background.ts). Administrator only; the table missing
 * (`available` false) answers available:false on read and 503 on every write; a restored copy refuses writes.
 * Result bytes are served by the existing GET /api/product-images/:id (the result is an ordinary image row). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import type { Transport } from './integrations';
import {
  applyImageBackground,
  listImageBackground,
  queueImageBackground,
  rejectImageBackground,
} from './image-background';

export function registerImageBackgroundRoutes(
  app: FastifyInstance,
  options: { available: boolean; readOnly: boolean; transport?: Transport },
): void {
  const admin = (req: any) => ensure(req.actor?.role === 'admin', 403, 'Usuwanie tła jest dostępne dla administratora');
  const id = (req: any) => z.object({ id: z.uuid() }).parse(req.params).id;
  const writable = (req: any) => {
    admin(req);
    ensure(options.available, 503, 'Kopia nie zawiera modułu usuwania tła zdjęć');
    ensure(!options.readOnly, 423, 'Kopia tylko do odczytu');
  };
  app.get('/api/products/:id/ai/images', async (req) => {
    admin(req);
    if (!options.available) return { available: false, read_only: options.readOnly, images: [], data: [], history_limit: 0 };
    return listImageBackground(req.actor, id(req), options.readOnly);
  });
  app.post('/api/products/:id/ai/images', async (req, reply) => {
    writable(req);
    const r = await queueImageBackground(req.actor, id(req), req.body);
    return reply.code(r.replayed ? 200 : 201).send(r);
  });
  app.post('/api/ai/catalog/images/:id/apply', async (req) => {
    writable(req);
    return applyImageBackground(req.actor, id(req), req.body);
  });
  app.post('/api/ai/catalog/images/:id/reject', async (req) => {
    writable(req);
    return rejectImageBackground(req.actor, id(req));
  });
}
