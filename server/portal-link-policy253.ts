/** COM-PORTAL-4 (migration 245): the administrator's default validity of buyer links.
 * New orders and rotations take it (server/domain.ts createOrder, POST /api/orders/:id/portal); existing links
 * without a date get one only on an explicit, bounded request. The portal keeps refusing expired links as before. */
import { z } from 'zod';
import { tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { portal253Available } from './portal-link-default253';

export { portalExpiry } from './portal-link-default253';
export const portalLinkPolicyInput = z.strictObject({
  default_days: z.number().int().min(1).max(365).nullable(),
  version: z.number().int().min(0),
});
export const portalLinkApplyInput = z.strictObject({
  confirmed: z.literal(true),
  limit: z.number().int().min(1).max(1000).default(1000),
});
export interface PortalLinkPolicy {
  available: boolean;
  default_days: number | null;
  version: number;
  updated_at: string | null;
  links_without_expiry: number;
}

const admin = (a: Actor) => ensure(a.role === 'admin', 403, 'Wymagana rola administratora');
async function view(c: import('pg').PoolClient): Promise<PortalLinkPolicy> {
  const row = (await c.query('SELECT default_days,version,updated_at FROM portal253_link_policies')).rows[0];
  const open = (await c.query('SELECT count(*)::int n FROM orders WHERE portal_enabled AND portal_expires_at IS NULL')).rows[0].n;
  return { available: true, default_days: row?.default_days ?? null, version: row?.version ?? 0, updated_at: row?.updated_at ?? null, links_without_expiry: open };
}
async function available(c: import('pg').PoolClient) {
  ensure(await portal253Available(c), 409, 'Ważność linku kupującego wymaga migracji 245; ta kopia bazy jej nie ma');
}

export async function readPortalLinkPolicy(a: Actor): Promise<PortalLinkPolicy> {
  admin(a);
  return tenantTx(a.tenantId, async (c) => {
    if (!(await portal253Available(c))) return { available: false, default_days: null, version: 0, updated_at: null, links_without_expiry: 0 };
    return view(c);
  });
}
export async function savePortalLinkPolicy(a: Actor, input: unknown): Promise<PortalLinkPolicy> {
  admin(a);
  const b = portalLinkPolicyInput.parse(input);
  return tenantTx(a.tenantId, async (c) => {
    await available(c);
    const row = (await c.query('SELECT version FROM portal253_link_policies FOR UPDATE')).rows[0];
    ensure((row?.version ?? 0) === b.version, 409, 'Ustawienia zmieniły się w międzyczasie. Odśwież widok.');
    await c.query(
      `INSERT INTO portal253_link_policies(tenant_id,default_days,updated_by) VALUES($1,$2,$3)
       ON CONFLICT (tenant_id) DO UPDATE SET default_days=EXCLUDED.default_days,updated_by=EXCLUDED.updated_by,version=portal253_link_policies.version+1,updated_at=now()`,
      [a.tenantId, b.default_days, a.userId],
    );
    await audit(c, a, 'portal.link_policy', null, { default_days: b.default_days });
    return view(c);
  });
}
/** Gives links that are enabled and have no date the default validity from now, at most `limit` per call. */
export async function applyPortalLinkPolicy(a: Actor, input: unknown): Promise<{ updated: number; remaining: number; default_days: number }> {
  admin(a);
  const b = portalLinkApplyInput.parse(input);
  return tenantTx(a.tenantId, async (c) => {
    await available(c);
    const days = (await c.query('SELECT default_days FROM portal253_link_policies FOR SHARE')).rows[0]?.default_days ?? null;
    ensure(days !== null, 409, 'Najpierw ustaw domyślną ważność linku');
    const updated = (
      await c.query(
        `UPDATE orders SET portal_expires_at=now()+make_interval(days=>$1) WHERE id IN (
           SELECT id FROM orders WHERE portal_enabled AND portal_expires_at IS NULL ORDER BY created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)
         AND portal_enabled AND portal_expires_at IS NULL`,
        [days, b.limit],
      )
    ).rowCount ?? 0;
    const remaining = (await c.query('SELECT count(*)::int n FROM orders WHERE portal_enabled AND portal_expires_at IS NULL')).rows[0].n;
    await audit(c, a, 'portal.link_policy.apply', null, { default_days: days, updated, remaining });
    return { updated, remaining, default_days: days };
  });
}
