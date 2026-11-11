/** B2B-002 routes (251): disconnect by either company, the link state and history, revoking a pending
 * invitation. Registered from registerB2bNetworkOrderRoutes, so server/app.ts is unchanged. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantReadTx } from './db';
import { audit } from './domain';
import { ensure } from './errors';
import { networkTx as tx, networkScope as scope, networkLink as ownLink, networkAdmin as admin } from './b2b-network';
import { networkLifecycleInstalled } from './b2b-network-lifecycle-release';
import { disconnectNetworkLinkInTx, publicLinkState } from './b2b-network-link-state';

const reason = z.string().trim().min(3).max(500);
const buyerDisconnect = z.object({ version: z.number().int().positive(), reason, confirmed: z.literal(true) }).strict();
const supplierDisconnect = z.object({ reason, confirmed: z.literal(true) }).strict();
const confirm = z.object({ confirmed: z.literal(true) }).strict();
const uuid = (v: unknown) => z.uuid().parse(v);

async function requireInstalled(c: Parameters<typeof networkLifecycleInstalled>[0]) {
  ensure(await networkLifecycleInstalled(c), 503, 'Odłączanie połączeń wymaga migracji 251');
}

export function registerB2bNetworkLifecycleRoutes(app: FastifyInstance) {
  const role = (r: any) => ensure(r.actor.role === 'admin', 403, 'Połączenia B2B odłącza administrator');
  // Buyer side: the company that owns the link.
  app.post('/api/b2b/network/links/:id/disconnect', async (r) => {
    role(r);
    const b = buyerDisconnect.parse(r.body), id = uuid((r.params as any).id), a = r.actor;
    return tx(a.tenantId, async (c) => {
      await requireInstalled(c);
      await admin(c, a);
      const l = await ownLink(c, id);
      const st = (await c.query('SELECT state FROM b2b258_link_states WHERE link_id=$1', [l.id])).rows[0];
      if (st?.state !== 'disconnected') ensure(l.version === b.version, 409, 'Połączenie zmieniło się; odśwież widok');
      const out = await disconnectNetworkLinkInTx(c, l, 'buyer', a, b.reason);
      return { ...out, link: (await c.query('SELECT * FROM b2b_links WHERE id=$1', [l.id])).rows[0] };
    });
  });
  app.get('/api/b2b/network/link-states', async (r) =>
    tenantReadTx(r.actor.tenantId, async (c) => {
      if (!(await networkLifecycleInstalled(c))) return { data: [] };
      const rows = (await c.query('SELECT * FROM b2b258_link_states WHERE tenant_id=$1 ORDER BY link_id LIMIT 1000', [r.actor.tenantId])).rows;
      return { data: rows.map(publicLinkState) };
    }),
  );
  app.get('/api/b2b/network/links/:id/history', async (r) =>
    tenantReadTx(r.actor.tenantId, async (c) => {
      const id = uuid((r.params as any).id);
      ensure((await c.query('SELECT 1 FROM b2b_links WHERE id=$1', [id])).rowCount, 404, 'Nie znaleziono połączenia B2B');
      if (!(await networkLifecycleInstalled(c))) return { data: [] };
      const rows = (await c.query('SELECT kind,side,reason,created_at FROM b2b258_link_events WHERE tenant_id=$1 AND link_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100', [r.actor.tenantId, id])).rows;
      return { data: rows };
    }),
  );
  // Supplier side: the company that owns the account.
  app.get('/api/b2b/accounts/:id/network-link', async (r) =>
    tenantReadTx(r.actor.tenantId, async (c) => {
      const id = uuid((r.params as any).id);
      ensure((await c.query('SELECT 1 FROM b2b_accounts WHERE id=$1', [id])).rowCount, 404, 'Nie znaleziono konta kontrahenta');
      if (!(await networkLifecycleInstalled(c))) return { link: null, events: [] };
      const l = (await c.query('SELECT * FROM b2b258_supplier_link($1)', [id])).rows[0];
      if (!l) return { link: null, events: [] };
      const st = (await c.query('SELECT * FROM b2b258_link_states WHERE link_id=$1', [l.link_id])).rows[0];
      const events = (await c.query('SELECT kind,side,reason,created_at FROM b2b258_link_events WHERE link_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50', [l.link_id])).rows;
      return {
        link: { id: l.link_id, state: st?.state ?? 'connected', disconnected_side: st?.disconnected_side ?? null, reason: st?.reason ?? '', disconnected_at: st?.disconnected_at ?? null, reconnected_at: st?.reconnected_at ?? null },
        events,
      };
    }),
  );
  app.post('/api/b2b/accounts/:id/network-disconnect', async (r) => {
    role(r);
    const b = supplierDisconnect.parse(r.body), id = uuid((r.params as any).id), a = r.actor;
    return tx(a.tenantId, async (c) => {
      await requireInstalled(c);
      await admin(c, a);
      // No account lock: quote and checkout lock the link before the account, so the link (then the state row,
      // which also serialises the invitation check) is the first lock here too.
      ensure((await c.query('SELECT 1 FROM b2b_accounts WHERE id=$1', [id])).rowCount, 404, 'Nie znaleziono konta kontrahenta');
      const ref = (await c.query('SELECT * FROM b2b258_supplier_link($1)', [id])).rows[0];
      ensure(ref, 404, 'Konto kontrahenta nie ma połączenia B2B');
      await scope(c, ref.buyer_tenant_id);
      const l = await ownLink(c, ref.link_id);
      return disconnectNetworkLinkInTx(c, l, 'supplier', a, b.reason);
    });
  });
  app.post('/api/b2b/accounts/:id/network-invite/revoke', async (r) => {
    role(r);
    confirm.parse(r.body);
    const id = uuid((r.params as any).id), a = r.actor;
    return tx(a.tenantId, async (c) => {
      await admin(c, a);
      const account = (await c.query('SELECT id FROM b2b_accounts WHERE id=$1 FOR UPDATE', [id])).rows[0];
      ensure(account, 404, 'Nie znaleziono konta kontrahenta');
      const rows = (await c.query("UPDATE b2b_link_invitations SET state='revoked' WHERE account_id=$1 AND state='pending' RETURNING id", [id])).rows;
      for (const row of rows) await audit(c, a, 'b2b.network.invite_revoked', row.id, { account_id: id });
      return { revoked: rows.length };
    });
  });
}
