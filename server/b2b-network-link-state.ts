/** B2B-002 link state (251), used by the invitation, acceptance and settings routes of b2b-network.ts.
 * This module does not import b2b-network.ts, so the network module can call it without an import cycle.
 *
 * Decisions (see INTEGRATION.md): either company may disconnect; the link is paused (no quote, purchase, refresh or
 * catalogue read) and keeps its row, orders, receipts, returns, mappings and history. No stock and no price changes:
 * open supplier orders keep their reservations and are finished or cancelled as before. Reconnecting needs the
 * supplier's new invitation accepted by the same buyer company and reuses the same link row (new version). */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { networkLifecycleInstalled as installed, networkLifecycleSetScope as scope } from './b2b-network-lifecycle-release';
import { disconnectPlan, reconnectPlan, type Side } from './b2b-network-lifecycle-model';

export interface LinkStateRow {
  tenant_id: string; link_id: string; supplier_tenant_id: string; account_id: string; state: 'connected' | 'disconnected';
  disconnected_side: Side | null; reason: string; disconnected_at: Date | null; reconnected_at: Date | null; version: number; updated_at: Date;
}
export const publicLinkState = (s: LinkStateRow) => ({
  link_id: s.link_id, state: s.state, disconnected_side: s.disconnected_side, reason: s.reason, disconnected_at: s.disconnected_at,
  reconnected_at: s.reconnected_at, version: s.version, updated_at: s.updated_at,
});

/** Supplier scope: the account's link is disconnected (a new invitation may then reconnect it). */
export async function networkLinkDisconnectedInTx(c: PoolClient, accountId: string): Promise<boolean> {
  if (!(await installed(c))) return false;
  const r = (await c.query(
    "SELECT state FROM b2b258_link_states WHERE supplier_tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND account_id=$1 FOR UPDATE",
    [accountId],
  )).rows[0];
  return r?.state === 'disconnected';
}

/** Buyer scope: refuses any settings change of a disconnected link (it stays paused until reconnected). */
export async function assertNetworkLinkConnectedInTx(c: PoolClient, link: { id: string }): Promise<void> {
  if (!(await installed(c))) return;
  const r = (await c.query('SELECT state FROM b2b258_link_states WHERE link_id=$1', [link.id])).rows[0];
  ensure(r?.state !== 'disconnected', 409, 'Połączenie jest odłączone; połączy je ponownie nowe zaproszenie dostawcy');
}

/** Acceptance, buyer scope on entry and on return: a disconnected link of this account reconnects in place for the
 * same buyer company (null: no earlier link, insert a new one). Locks the link before its state, like disconnect. */
export async function reconnectNetworkLinkInTx(
  c: PoolClient,
  a: Actor,
  x: { supplierTenantId: string; accountId: string; invitationId: string; supplierName: string },
): Promise<Record<string, unknown> | null> {
  if (!(await installed(c))) return null;
  await scope(c, x.supplierTenantId);
  const seen = (await c.query('SELECT link_id,tenant_id,state FROM b2b258_link_states WHERE supplier_tenant_id=$1 AND account_id=$2', [x.supplierTenantId, x.accountId])).rows[0];
  const plan = reconnectPlan(seen ?? null, a.tenantId);
  await scope(c, a.tenantId);
  if (plan === 'insert') return null;
  const locked = (await c.query('SELECT id FROM b2b_links WHERE id=$1 FOR UPDATE', [seen.link_id])).rows[0];
  ensure(locked, 409, 'Połączenie zmieniło się; spróbuj ponownie');
  const st = (await c.query('SELECT state FROM b2b258_link_states WHERE link_id=$1 FOR UPDATE', [seen.link_id])).rows[0];
  ensure(st?.state === 'disconnected', 409, 'Kontrahent ma juz polaczona firme');
  const link = (await c.query(
    `UPDATE b2b_links SET paused=false,invitation_id=$2,actor_id=$3,supplier_name=$4,version=version+1,error=NULL,
      next_at=CASE WHEN schedule_minutes>0 THEN now()+make_interval(mins=>schedule_minutes) ELSE NULL END WHERE id=$1 RETURNING *`,
    [seen.link_id, x.invitationId, a.userId, x.supplierName],
  )).rows[0];
  await c.query("UPDATE b2b258_link_states SET state='connected',reconnected_at=now(),version=version+1,updated_by=$2,updated_at=now() WHERE link_id=$1", [link.id, a.userId]);
  await c.query(
    "INSERT INTO b2b258_link_events(id,tenant_id,link_id,supplier_tenant_id,account_id,kind,side,actor_id,created_at) VALUES($1,$2,$3,$4,$5,'reconnected','buyer',$6,clock_timestamp())",
    [randomUUID(), a.tenantId, link.id, x.supplierTenantId, x.accountId, a.userId],
  );
  await audit(c, a, 'b2b.network.reconnect', link.id, { supplier_tenant: x.supplierTenantId, invitation_id: x.invitationId });
  return link;
}

/** Disconnects a link locked FOR UPDATE by the caller. Ends in the caller's own scope. The same request again is a
 * replay. Queued catalogue runs are cancelled as a settings change does; pending invitations of the account end. */
export async function disconnectNetworkLinkInTx(c: PoolClient, link: any, side: Side, a: Actor, reason: string) {
  await scope(c, link.tenant_id);
  const old = (await c.query('SELECT * FROM b2b258_link_states WHERE link_id=$1 FOR UPDATE', [link.id])).rows[0] as LinkStateRow | undefined;
  if (disconnectPlan(old?.state ?? null) === 'replay') {
    await scope(c, a.tenantId);
    return { state: publicLinkState(old!), reused: true };
  }
  await c.query(
    "UPDATE jobs SET state='done',error='Połączenie odłączone',lease_token=NULL,locked_at=NULL WHERE id IN(SELECT job_id FROM b2b_catalog_runs WHERE link_id=$1 AND state='queued')",
    [link.id],
  );
  await c.query("UPDATE b2b_catalog_runs SET state='cancelled',error='Połączenie odłączone',finished_at=now() WHERE link_id=$1 AND state='queued'", [link.id]);
  await c.query("DELETE FROM b2b_catalog_staging WHERE run_id IN(SELECT id FROM b2b_catalog_runs WHERE link_id=$1 AND state='cancelled')", [link.id]);
  await c.query('UPDATE b2b_links SET paused=true,next_at=NULL,version=version+1 WHERE id=$1', [link.id]);
  const state = (await c.query(
    `INSERT INTO b2b258_link_states(tenant_id,link_id,supplier_tenant_id,account_id,state,disconnected_side,reason,disconnected_at,updated_by)
     VALUES($1,$2,$3,$4,'disconnected',$5,$6,now(),$7)
     ON CONFLICT(link_id) DO UPDATE SET state='disconnected',disconnected_side=excluded.disconnected_side,reason=excluded.reason,
       disconnected_at=now(),version=b2b258_link_states.version+1,updated_by=excluded.updated_by,updated_at=now() RETURNING *`,
    [link.tenant_id, link.id, link.supplier_tenant_id, link.account_id, side, reason, a.userId],
  )).rows[0] as LinkStateRow;
  await c.query(
    "INSERT INTO b2b258_link_events(id,tenant_id,link_id,supplier_tenant_id,account_id,kind,side,actor_id,reason,created_at) VALUES($1,$2,$3,$4,$5,'disconnected',$6,$7,$8,clock_timestamp())",
    [randomUUID(), link.tenant_id, link.id, link.supplier_tenant_id, link.account_id, side, a.userId, reason],
  );
  const partner = side === 'buyer' ? link.supplier_tenant_id : link.tenant_id;
  await scope(c, link.supplier_tenant_id);
  await c.query("UPDATE b2b_link_invitations SET state='revoked' WHERE account_id=$1 AND state='pending'", [link.account_id]);
  await scope(c, partner);
  await audit(c, { tenantId: partner, userId: null }, 'b2b.network.disconnected_by_partner', link.id, { side, reason });
  await scope(c, a.tenantId);
  await audit(c, a, 'b2b.network.disconnect', link.id, { side, reason });
  return { state: publicLinkState(state), reused: false };
}
