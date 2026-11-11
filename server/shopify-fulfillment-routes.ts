import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure, Problem } from './errors';
import type { IntegrationContext } from './channel-access';
import { orderMergeOriginInTx } from './order-merge-guards';
import { resolveOrderMergeOwnerInTx } from './order-merge-payments';
import {
  shopifyFulfillmentInput,
  previewShopifyFulfillment,
  queueShopifyFulfillment,
  cancelShopifyFulfillment,
  reconcileShopifyFulfillment,
  shopifyFulfillmentLocal,
  shopifyFulfillmentSources,
  shopifySourceFulfillmentLocal,
  shopifySourceFulfillmentAvailable,
} from './shopify-fulfillment';
export function registerShopifyFulfillmentRoutes(
  app: FastifyInstance,
  ctx: IntegrationContext = {},
  available = true,
  readOnly = false,
) {
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const flags = async (c: any, req: any) => {
    actor(req);
    const role = (await c.query('SELECT offer_sync_is_admin($1) ok', [req.actor.userId])).rows[0].ok
      ? 'admin'
      : req.actor.role;
    ensure(role, 403, 'Brak dostępu do firmy');
    return {
      available,
      source_available: available && (await shopifySourceFulfillmentAvailable(c)),
      read_only: readOnly,
      current_role: role,
      can_read: true,
      can_preview: available && !readOnly && role === 'admin',
      can_queue: available && !readOnly && role === 'admin',
    };
  };
  const actor = (req: any, write = false) => {
    const required = [write ? 'orders:write' : 'orders:read'];
    ensure(
      !req.apiScopes || required.every((s) => req.apiScopes.includes(s)),
      403,
      'Brak wymaganych uprawnień orders',
    );
    const apiKeyId = req.currentUser?.api_key_id;
    ensure(!req.apiScopes || typeof apiKeyId === 'string', 401, 'Brak kontekstu klucza');
    return { ...req.actor, ...(req.apiScopes ? { apiKeyId } : {}) };
  };
  const write = (req: any) => {
    ensure(!readOnly, 423, 'Kopia odtworzona jest tylko do odczytu');
    ensure(available, 404, 'Potwierdzanie wysyłek Shopify jest niedostępne w tej kopii');
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
  };
  app.get('/api/orders/:id/shopify-fulfillment/sources', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const f = await flags(c, req);
      const oid = id(req.params);
      ensure(
        (await c.query('SELECT 1 FROM orders WHERE id=$1', [oid])).rowCount,
        404,
        'Nie znaleziono zamówienia',
      );
      return { ...f, data: available ? await shopifyFulfillmentSources(c, oid) : [] };
    }),
  );
  app.get('/api/orders/:id/shopify-fulfillment', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      ensure(available, 404, 'Potwierdzanie wysyłek Shopify jest niedostępne w tej kopii');
      const f = await flags(c, req),
        oid = id(req.params);
      const current = (await c.query('SELECT * FROM orders WHERE id=$1', [oid])).rows[0];
      ensure(current, 404, 'Nie znaleziono zamówienia Shopify');
      const origin = await orderMergeOriginInTx(c, oid),
        o = origin ? { ...origin.header, id: oid } : current;
      ensure(o.source === 'shopify', 404, 'Nie znaleziono źródła Shopify');
      const ch = (
        await c.query(
          'SELECT id,name,provider,mode,settings,oauth_scopes FROM channels WHERE id=$1',
          [o.channel_id],
        )
      ).rows[0];
      if (!available)
        return {
          ...f,
          channel: ch,
          ready: false,
          reason: 'Realizacja Shopify jest niedostępna w tej kopii',
          data: [],
          lines: [],
          shipments: [],
        };
      const ownerId = await resolveOrderMergeOwnerInTx(c, oid),
        owner = (await c.query('SELECT id,number,version FROM orders WHERE id=$1', [ownerId]))
          .rows[0];
      const ships = (
        await c.query(
          'SELECT id,tracking_number,carrier,dispatched_at FROM shipments WHERE order_id=$1 ORDER BY id',
          [ownerId],
        )
      ).rows;
      let lines: any[] = [],
        ready = false,
        reason = '',
        partial = false;
      if (f.source_available) {
        const bindings = (
          await c.query(
            'SELECT remote_line_id,source_item_id,quantity,product_id FROM order_source_lines WHERE source_order_id=$1 ORDER BY remote_line_id',
            [oid],
          )
        ).rows;
        partial = bindings.length > 0;
        if (partial) {
          const capacities = (
            await c.query('SELECT * FROM shopify_source_fulfillment_capacity($1::jsonb,NULL)', [
              JSON.stringify([
                ch.settings.store_url,
                o.external_id,
                ch.settings.simulation ? req.actor.tenantId : '',
              ]),
            ])
          ).rows;
          const items =
            origin?.items ??
            (
              await c.query(
                'SELECT id,sku,name,price,line_total,vat FROM order_items WHERE order_id=$1',
                [oid],
              )
            ).rows;
          lines = bindings.map((b) => {
            const item = items.find((i: any) => i.id === b.source_item_id);
            ensure(item, 409, 'Brak oryginalnej pozycji źródłowej');
            return {
              remote_line_id: b.remote_line_id,
              source_item_id: b.source_item_id,
              sku: items.find((i: any) => i.id === b.source_item_id)?.sku ?? null,
              name: items.find((i: any) => i.id === b.source_item_id)?.name ?? null,
              quantity: b.quantity,
              unit_price: item.price,
              line_total: item.line_total,
              vat: item.vat,
              currency: o.currency,
              confirmed_quantity: Number(
                capacities.find((v: any) => v.remote_line_id === b.remote_line_id)
                  ?.confirmed_quantity ?? 0,
              ),
              reserved_quantity: Number(
                capacities.find((v: any) => v.remote_line_id === b.remote_line_id)
                  ?.reserved_quantity ?? 0,
              ),
              remaining_quantity: Math.max(
                0,
                b.quantity -
                  Number(
                    capacities.find((v: any) => v.remote_line_id === b.remote_line_id)?.quantity ??
                      0,
                  ),
              ),
            };
          });
        }
      }
      let localReason = '';
      if (partial) {
        try {
          const x = await shopifySourceFulfillmentLocal(c, oid, {
            company: 'DPD',
            notify_customer: false,
            client_key: '00000000-0000-4000-8000-000000000000',
            lines: [],
          });
          lines = lines.map((l) => ({
            ...l,
            returned_quantity:
              x.returned.find(
                (r: any) =>
                  r.item_id === x.lines.find((v) => v.id === l.remote_line_id)?.owner_item_id,
              )?.quantity ?? 0,
          }));
        } catch (e) {
          if (!(e instanceof Problem)) throw e;
          localReason = e.message;
        }
      }
      try {
        const prior = (
          await c.query(
            "SELECT state,phase,payload FROM shopify_fulfillment_plans WHERE (order_id=$1 AND NOT(payload ? 'partial')) OR payload#>>'{partial,source_order_id}'=$1::text ORDER BY created_at DESC,id DESC",
            [oid],
          )
        ).rows.find(
          (p) =>
            p.state === 'queued' ||
            ['write_started', 'verify'].includes(p.phase) ||
            (p.state === 'done' && !p.payload.partial) ||
            (p.phase === 'done' && p.state === 'conflict'),
        );
        ensure(
          !prior,
          409,
          prior?.state === 'done'
            ? 'Realizacja przesyłki została potwierdzona. Historia pozostaje dostępna po zwrocie.'
            : prior?.state === 'queued'
              ? 'Zgłoszenie realizacji oczekuje na wynik.'
              : 'Wcześniejsze zgłoszenie wymaga uzgodnienia. Nie ponawiaj zapisu w sklepie.',
        );
        if (partial) {
          const eligible = lines.filter((l) => l.remaining_quantity > 0);
          ensure(
            eligible.length,
            409,
            'Wszystkie źródłowe ilości zostały już potwierdzone lub zarezerwowane',
          );
          ensure(!localReason, 409, localReason);
        } else await shopifyFulfillmentLocal(c, oid);
        ready = true;
      } catch (e) {
        if (!(e instanceof Problem)) throw e;
        reason = e.message;
      }
      const q = z.object({ cursor: z.uuid().optional() }).strict().parse(req.query);
      const data = (
        await c.query(
          "SELECT p.*,j.state job_state,j.provider_wait_until,j.provider_wait_reason FROM shopify_fulfillment_plans p LEFT JOIN jobs j ON(j.tenant_id,j.id)=(p.tenant_id,p.job_id) WHERE ((p.order_id=$1 AND NOT(p.payload ? 'partial')) OR p.payload#>>'{partial,source_order_id}'=$1::text) AND ($2::uuid IS NULL OR(p.created_at,p.id)<(SELECT created_at,id FROM shopify_fulfillment_plans WHERE id=$2)) ORDER BY p.created_at DESC,p.id DESC LIMIT 26",
          [oid, q.cursor ?? null],
        )
      ).rows;
      return {
        ...f,
        channel: ch,
        ready,
        reason,
        partial,
        partial_available: partial,
        owner_order: owner,
        lines,
        shipments: ships,
        data: data.slice(0, 25),
        meta: { cursor: data.length > 25 ? data[24].id : null },
      };
    }),
  );
  app.post('/api/orders/:id/shopify-fulfillment/preview', (req) => {
    write(req);
    return previewShopifyFulfillment(
      actor(req, true),
      id(req.params),
      shopifyFulfillmentInput.parse(req.body),
      ctx,
    );
  });
  app.get('/api/shopify-fulfillment-plans/:id', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const f = await flags(c, req);
      ensure(available, 404, 'Niedostępne');
      const p = (
        await c.query('SELECT * FROM shopify_fulfillment_plans WHERE id=$1', [id(req.params)])
      ).rows[0];
      ensure(p, 404, 'Nie znaleziono planu');
      return { ...f, plan: p };
    }),
  );
  app.post('/api/shopify-fulfillment-plans/:id/queue', (req) => {
    write(req);
    const b = z
      .object({ confirm_external: z.boolean().default(false) })
      .strict()
      .parse(req.body ?? {});
    return queueShopifyFulfillment(actor(req, true), id(req.params), b.confirm_external);
  });
  app.post('/api/shopify-fulfillment-plans/:id/cancel', (req) => {
    write(req);
    z.object({})
      .strict()
      .parse(req.body ?? {});
    return cancelShopifyFulfillment(actor(req, true), id(req.params));
  });
  app.post('/api/shopify-fulfillment-plans/:id/reconcile', (req) => {
    write(req);
    const b = z
      .object({ acknowledge_mismatch: z.boolean().default(false) })
      .strict()
      .parse(req.body ?? {});
    return reconcileShopifyFulfillment(
      actor(req, true),
      id(req.params),
      ctx,
      b.acknowledge_mismatch,
    );
  });
}
