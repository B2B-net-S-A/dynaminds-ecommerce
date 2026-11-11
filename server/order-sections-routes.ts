/** PATCH /api/orders/:id/sections/:section (Uwagi v3 §6, contract shared/order-sections.ts). */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { ensure } from './errors';
import type { Actor } from './domain';
import { SectionLockedError, updateOrderSectionInTx } from './order-sections';
import { EDITABLE_SECTIONS } from './order-sections-model';

const params = z.strictObject({
  id: z.uuid('Nieprawidłowy identyfikator zamówienia'),
  section: z.enum(EDITABLE_SECTIONS, { error: 'Nieznana sekcja zamówienia. Produkty zmienisz w pozycjach zamówienia.' }),
});

/** Name of the person (or API key) shown in the history; users and api_keys are read by the owner connection. */
export async function actorDisplayName(a: Actor): Promise<string | null> {
  if (a.apiKeyId) {
    const k = (await pool.query('SELECT name FROM api_keys WHERE tenant_id=$1 AND id=$2', [a.tenantId, a.apiKeyId])).rows[0];
    return k ? 'Klucz API: ' + k.name : 'Klucz API';
  }
  return (await pool.query('SELECT name FROM users WHERE id=$1', [a.userId])).rows[0]?.name ?? null;
}

export function registerOrderSectionRoutes(app: FastifyInstance) {
  app.patch('/api/orders/:id/sections/:section', async (req: FastifyRequest, reply) => {
    ensure(!req.apiScopes || req.apiScopes.includes('orders:write'), 403, 'Klucz wymaga zakresu orders:write');
    const { id, section } = params.parse(req.params);
    // The accountant (Księgowa) changes only the payment section; any other viewer reads only.
    ensure(
      req.actor.role !== 'viewer' || (req.actor.accountant === true && section === 'payment'),
      403,
      req.actor.accountant === true ? 'Księgowa zmienia tylko sekcję Płatność' : 'Konto ma uprawnienia tylko do odczytu',
    );
    const name = await actorDisplayName(req.actor);
    try {
      return await tenantTx(req.actor.tenantId, (c) =>
        updateOrderSectionInTx(c, req.actor, name, id, section, req.body, req.apiScopes),
      );
    } catch (e) {
      if (!(e instanceof SectionLockedError)) throw e;
      return reply.code(423).type('application/problem+json').send({
        type: 'about:blank',
        title: 'Sekcja jest zablokowana',
        status: 423,
        detail: e.message,
        code: 'section_locked',
        lock: e.lock,
        request_id: req.id,
      });
    }
  });
}
