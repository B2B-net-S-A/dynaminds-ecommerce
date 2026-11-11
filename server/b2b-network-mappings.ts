/** B2B-003 (251): unbind and rebind a supplier offer from the buyer's own product, sync the supplier
 * purchase price and preview the differences.
 *
 * Decisions (see INTEGRATION.md): unbinding is an overlay (b2b258_mappings.state='unbound') because the 144 binding
 * proof is immutable; the quote, checkout and dropshipping mapping reads refuse an unbound offer. Rebinding to the
 * same product reattaches it; another product is allowed only for an offer without the 144 proof (then
 * b2b_catalog_items.product_id, which every consumer and the dropshipping trigger read, changes). Past orders keep
 * their own product lines. The price sync stores only the supplier purchase price (minor units, currency) per
 * mapping; it never writes the own sale price or own stock (the supplier's availability is shown, not booked). */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { tenantReadTx } from './db';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { networkTx as tx, networkLink as ownLink, networkAdmin as admin } from './b2b-network';
import { networkLifecycleInstalled } from './b2b-network-lifecycle-release';
import { assertNetworkLinkConnectedInTx } from './b2b-network-link-state';
import { priceSyncPlan, rebindPlan, unbindPlan, type MappingState } from './b2b-network-lifecycle-model';
import { productCatalogsAvailable } from './product-catalogs';
import { guardB2BCatalogPairInTx, assertB2BCatalogProductsInTx, type B2BCatalogPair } from './b2b-catalog-scope-adapters';

const MAX_SYNC = 1000;
const unbindInput = z.object({ reason: z.string().trim().min(3).max(500), confirmed: z.literal(true) }).strict();
const rebindInput = z.object({ product_id: z.uuid(), confirmed: z.literal(true) }).strict();
const confirm = z.object({ confirmed: z.literal(true) }).strict();

/** Buyer scope: the offers of these ids that are unbound (empty before 251). */
export async function unboundItemIdsInTx(c: PoolClient, itemIds: string[]): Promise<Set<string>> {
  if (!itemIds.length || !(await networkLifecycleInstalled(c))) return new Set();
  const rows = (await c.query("SELECT item_id FROM b2b258_mappings WHERE item_id=ANY($1::uuid[]) AND state='unbound'", [itemIds])).rows;
  return new Set(rows.map((r) => r.item_id));
}
const publicMapping = (m: any) => ({
  item_id: m.item_id, link_id: m.link_id, product_id: m.product_id, state: m.state as MappingState,
  purchase_price_minor: m.purchase_price_minor === null ? null : Number(m.purchase_price_minor), purchase_currency: m.purchase_currency,
  price_synced_at: m.price_synced_at, version: m.version, updated_at: m.updated_at,
});
async function event(c: PoolClient, a: Actor, m: { item_id: string; link_id: string }, kind: string, x: Record<string, unknown>) {
  await c.query(
    `INSERT INTO b2b258_mapping_events(id,tenant_id,item_id,link_id,kind,product_before,product_after,price_before_minor,price_after_minor,currency,reason,actor_id,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp())`,
    [randomUUID(), a.tenantId, m.item_id, m.link_id, kind, x.product_before ?? null, x.product_after ?? null, x.price_before ?? null, x.price_after ?? null, x.currency ?? null, x.reason ?? '', a.userId],
  );
}
async function upsert(c: PoolClient, a: Actor, item: any, set: { product_id: string; state: MappingState }) {
  return (await c.query(
    `INSERT INTO b2b258_mappings(tenant_id,item_id,link_id,product_id,state,updated_by) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(tenant_id,item_id) DO UPDATE SET product_id=excluded.product_id,state=excluded.state,version=b2b258_mappings.version+1,
       updated_by=excluded.updated_by,updated_at=now() RETURNING *`,
    [a.tenantId, item.id, item.link_id, set.product_id, set.state, a.userId],
  )).rows[0];
}
async function lockedItem(c: PoolClient, linkId: string, itemId: string) {
  const item = (await c.query('SELECT * FROM b2b_catalog_items WHERE id=$1 AND link_id=$2 FOR UPDATE', [itemId, linkId])).rows[0];
  ensure(item, 404, 'Nie znaleziono oferty w katalogu połączenia');
  const overlay = (await c.query('SELECT * FROM b2b258_mappings WHERE tenant_id=$1 AND item_id=$2 FOR UPDATE', [item.tenant_id, item.id])).rows[0] ?? null;
  return { item, overlay };
}
async function write<T, P = null>(r: any, fn: (c: PoolClient, a: Actor, l: any, pre: P | null) => Promise<T>, before?: (c: PoolClient, a: Actor, linkId: string) => Promise<P | null>) {
  ensure(r.actor.role === 'admin', 403, 'Powiązania B2B zmienia administrator');
  const a: Actor = r.actor, linkId = z.uuid().parse(r.params.id);
  return tx(a.tenantId, async (c) => {
    ensure(await networkLifecycleInstalled(c), 503, 'Odpinanie powiązań wymaga migracji 251');
    await admin(c, a);
    // Catalogue locks (taken by `before`) precede the link lock, as in quote, checkout and bind.
    const pre = before ? await before(c, a, linkId) : null;
    return fn(c, a, await ownLink(c, linkId), pre);
  });
}

export function registerB2bNetworkMappingRoutes(app: FastifyInstance) {
  const base = '/api/b2b/network/links/:id';
  app.post(base + '/catalog/:item/unbind', async (r) => {
    const b = unbindInput.parse(r.body), itemId = z.uuid().parse((r.params as any).item);
    return write(r, async (c, a, l) => {
      const { item, overlay } = await lockedItem(c, l.id, itemId);
      const plan = unbindPlan({ product_id: item.product_id, proof: false }, overlay?.state ?? null);
      if (plan === 'replay') return { mapping: publicMapping(overlay), reused: true };
      const m = await upsert(c, a, item, { product_id: item.product_id, state: 'unbound' });
      await event(c, a, m, 'unbound', { product_before: item.product_id, reason: b.reason });
      await audit(c, a, 'b2b.network.unbound', item.id, { link_id: l.id, product_id: item.product_id, reason: b.reason });
      return { mapping: publicMapping(m), reused: false };
    });
  });
  app.post(base + '/catalog/:item/rebind', async (r) => {
    const b = rebindInput.parse(r.body), itemId = z.uuid().parse((r.params as any).item);
    return write<unknown, B2BCatalogPair>(r, async (c, a, l, pair) => {
      const { item, overlay } = await lockedItem(c, l.id, itemId);
      const proof = (await c.query('SELECT public.b2b258_item_has_proof($1) p', [item.id])).rows[0].p === true;
      const plan = rebindPlan({ product_id: item.product_id, proof }, overlay?.state ?? null, b.product_id);
      if (plan === 'replay') return { mapping: overlay ? publicMapping(overlay) : { item_id: item.id, link_id: l.id, product_id: item.product_id, state: 'bound' }, reused: true };
      if (plan === 'switch') {
        ensure(item.published, 409, 'Oferta nie jest opublikowana; odśwież katalog');
        ensure((await c.query("SELECT id FROM products WHERE id=$1 AND active AND kind IN('simple','variant') FOR SHARE", [b.product_id])).rowCount, 409, 'Powiązanie przyjęcia wymaga prostego produktu lub wariantu');
        if (await productCatalogsAvailable(c)) {
          ensure(pair, 409, 'Powiązanie oferty zmieniło się; spróbuj ponownie');
          await assertB2BCatalogProductsInTx(c, pair.buyer, [b.product_id]);
        }
        await c.query('UPDATE b2b_catalog_items SET product_id=$2,version=version+1 WHERE id=$1', [item.id, b.product_id]);
      }
      const m = await upsert(c, a, item, { product_id: b.product_id, state: 'bound' });
      await event(c, a, m, 'rebound', { product_before: item.product_id, product_after: b.product_id });
      await audit(c, a, 'b2b.network.rebound', item.id, { link_id: l.id, product_before: item.product_id, product_after: b.product_id });
      return { mapping: publicMapping(m), reused: false };
    }, async (c, a, linkId) => {
      // Only a switch to another product needs the exclusive catalogue frame; it must precede the link lock.
      const seen = (await c.query('SELECT product_id FROM b2b_catalog_items WHERE id=$1 AND link_id=$2', [itemId, linkId])).rows[0];
      if (!seen?.product_id || seen.product_id === b.product_id || !(await productCatalogsAvailable(c))) return null;
      return guardB2BCatalogPairInTx(c, { tenantId: a.tenantId, linkId, purpose: 'bind_product' });
    });
  });
  app.post(base + '/mappings/price-sync', async (r) => {
    confirm.parse(r.body);
    return write(r, async (c, a, l) => {
      await assertNetworkLinkConnectedInTx(c, l);
      const items = (await c.query('SELECT id,link_id,product_id,snapshot FROM b2b_catalog_items WHERE link_id=$1 AND product_id IS NOT NULL AND published ORDER BY id LIMIT $2 FOR UPDATE', [l.id, MAX_SYNC + 1])).rows;
      ensure(items.length <= MAX_SYNC, 413, 'Za dużo powiązanych ofert dla jednej synchronizacji cen');
      const overlays = new Map((await c.query('SELECT * FROM b2b258_mappings WHERE tenant_id=$1 AND item_id=ANY($2::uuid[]) ORDER BY item_id FOR UPDATE', [a.tenantId, items.map((i) => i.id)])).rows.map((m) => [m.item_id, m]));
      let changed = 0, unchanged = 0;
      for (const item of items) {
        const o = overlays.get(item.id);
        if (o?.state === 'unbound') continue;
        const stored = o && o.purchase_price_minor !== null ? { minor: Number(o.purchase_price_minor), currency: o.purchase_currency } : null;
        const plan = priceSyncPlan(stored, { price: item.snapshot.price, currency: item.snapshot.currency });
        if (!plan.changed) { unchanged++; continue; }
        const m = o ?? await upsert(c, a, item, { product_id: item.product_id, state: 'bound' });
        await c.query('UPDATE b2b258_mappings SET purchase_price_minor=$3,purchase_currency=$4,price_synced_at=now(),version=version+1,updated_by=$5,updated_at=now() WHERE tenant_id=$1 AND item_id=$2',
          [a.tenantId, item.id, plan.after.minor, plan.after.currency, a.userId]);
        await event(c, a, m, 'price_synced', { price_before: stored?.minor ?? null, price_after: plan.after.minor, currency: plan.after.currency, product_before: item.product_id });
        changed++;
      }
      if (changed) await audit(c, a, 'b2b.network.price_sync', l.id, { changed, unchanged });
      return { changed, unchanged };
    });
  });
  // Diff preview: the supplier's current offer price and availability against the synced purchase price and the own
  // product. Read only.
  app.get(base + '/mappings', async (r) =>
    tenantReadTx(r.actor.tenantId, async (c) => {
      const linkId = z.uuid().parse((r.params as any).id), q = z.object({ after: z.uuid().optional() }).strict().parse(r.query);
      ensure((await c.query('SELECT 1 FROM b2b_links WHERE id=$1', [linkId])).rowCount, 404, 'Nie znaleziono połączenia B2B');
      const installed = await networkLifecycleInstalled(c);
      const rows = (await c.query(
        `SELECT i.id item_id,i.snapshot,i.published,i.product_id,p.sku own_sku,p.name own_name,p.price own_price,
          coalesce((SELECT sum(s.on_hand) FROM stock s WHERE s.tenant_id=i.tenant_id AND s.product_id=i.product_id),0)::int own_on_hand
          ${installed ? ',m.state,m.purchase_price_minor,m.purchase_currency,m.price_synced_at' : ''}
         FROM b2b_catalog_items i LEFT JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.product_id)
         ${installed ? 'LEFT JOIN b2b258_mappings m ON (m.tenant_id,m.item_id)=(i.tenant_id,i.id)' : ''}
         WHERE i.link_id=$1 AND i.product_id IS NOT NULL AND ($2::uuid IS NULL OR i.id>$2) ORDER BY i.id LIMIT 101`,
        [linkId, q.after ?? null],
      )).rows;
      const data = rows.slice(0, 100).map((x) => {
        const supplier = Number.isSafeInteger(x.snapshot?.price) ? x.snapshot.price as number : null;
        const purchase = x.purchase_price_minor === null || x.purchase_price_minor === undefined ? null : Number(x.purchase_price_minor);
        const sameCurrency = !x.purchase_currency || x.purchase_currency === x.snapshot?.currency;
        return {
          item_id: x.item_id, sku: x.snapshot?.sku, name: x.snapshot?.name, published: x.published, state: x.state ?? 'bound',
          product_id: x.product_id, own_sku: x.own_sku, own_name: x.own_name, own_price_minor: x.own_price, own_on_hand: x.own_on_hand,
          currency: x.snapshot?.currency, supplier_price_minor: supplier, purchase_price_minor: purchase, purchase_currency: x.purchase_currency ?? null,
          price_delta_minor: supplier !== null && purchase !== null && sameCurrency ? supplier - purchase : null,
          price_changed: purchase === null || supplier !== purchase || !sameCurrency,
          supplier_available: x.published ? x.snapshot?.available ?? 0 : 0, price_synced_at: x.price_synced_at ?? null,
        };
      });
      return { data, next: rows.length > 100 ? rows[99].item_id : null };
    }),
  );
  app.get(base + '/catalog/:item/history', async (r) =>
    tenantReadTx(r.actor.tenantId, async (c) => {
      const linkId = z.uuid().parse((r.params as any).id), itemId = z.uuid().parse((r.params as any).item);
      ensure((await c.query('SELECT 1 FROM b2b_catalog_items WHERE id=$1 AND link_id=$2', [itemId, linkId])).rowCount, 404, 'Nie znaleziono oferty w katalogu połączenia');
      if (!(await networkLifecycleInstalled(c))) return { data: [] };
      const rows = (await c.query(
        `SELECT kind,product_before,product_after,price_before_minor::text,price_after_minor::text,currency,reason,created_at
         FROM b2b258_mapping_events WHERE tenant_id=$1 AND item_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100`,
        [r.actor.tenantId, itemId],
      )).rows;
      return { data: rows.map((e) => ({ ...e, price_before_minor: e.price_before_minor === null ? null : Number(e.price_before_minor), price_after_minor: e.price_after_minor === null ? null : Number(e.price_after_minor) })) };
    }),
  );
}
