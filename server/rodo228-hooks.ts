/** 228 access-register hooks for existing reads of customer data: the CRM customer card
 * (session routes) and the Base CRM connector.php reads (API keys). Installed by buildApp
 * only when 228 is present and the copy is writable. */
import type { Pool } from 'pg';
import { tenantAppendTx } from './db';
import type { Actor } from './domain';
import type { CrmAccessEntry } from './crm-routes';
import type { BaseWireReadObserver } from './base-wire-routes';
import { listAccessEntries, logAccessInTx, logListAccess, logPersonalDataAccess, type AccessEntry } from './rodo228';
import { normalEmail, normalPhone, subjectHash } from './rodo228-model';

const CARD_PURPOSE = 'Obsługa klienta — karta klienta CRM';
export function rodo228CrmAccess(pool: Pool, key: string) {
  return async (actor: Actor, entries: CrmAccessEntry[]) => {
    // A list page is one register row per request (SEC-013); card reads stay one row per client.
    const lists = entries.filter(e => e.action === 'list'), reads = entries.filter(e => e.action !== 'list');
    for (const resource of new Set(lists.map(e => e.resource)))
      await logListAccess(pool, actor, { purpose: CARD_PURPOSE, resource }, lists.filter(e => e.resource === resource).map(e => e.crm_client_id));
    await logPersonalDataAccess(pool, actor, key, reads.map(e => ({ action: e.action, purpose: CARD_PURPOSE, resource: e.resource, crm_client_id: e.crm_client_id, email: e.email, phone: e.phone })));
  };
}
const WIRE_READS: Record<string, AccessEntry['action']> = { getCrmClientData: 'read', getCrmClients: 'list', file: 'read' };
type WireClient = { crm_client_id?: unknown; email?: unknown; phone?: unknown };
/** connector.php reads of CRM clients: card and file reads one row per client keyed by its
 * local CRM id; getCrmClients one row per call naming the local ids (SEC-013), plus a hashed
 * row for a returned client without a local id. */
export function rodo228WireObserver(pool: Pool, key: string, available: () => Promise<boolean>): BaseWireReadObserver {
  return async (label, actor, method, payload) => {
    const action = WIRE_READS[method];
    if (label !== 'CRM' || !action) return;
    const p = payload as { clients?: WireClient[] } & WireClient;
    const clients: WireClient[] = method === 'getCrmClients' ? p.clients ?? [] : [p];
    const ids = clients.map(cl => Number(cl.crm_client_id)).filter(n => Number.isSafeInteger(n) && n > 0);
    if (!ids.length || !(await available())) return;
    await tenantAppendTx(actor.tenantId, async c => {
      const local = new Map((await c.query('SELECT public_id::text p,local_id::text l FROM base_wire218_client_ids WHERE public_id=ANY($1::bigint[]) AND local_id IS NOT NULL', [ids])).rows.map(r => [r.p as string, r.l as string]));
      const base = { purpose: 'Integracja — odczyt klienta przez Base API (connector.php)', resource: 'connector.php ' + method }, listed: string[] = [];
      const entries = clients.flatMap(cl => {
        const id = local.get(String(cl.crm_client_id)), e = normalEmail(cl.email), ph = normalPhone(cl.phone);
        if (id && action === 'list') { listed.push(id); return []; }
        const hash = e ? subjectHash(key, actor.tenantId, 'email', e) : ph.length >= 6 ? subjectHash(key, actor.tenantId, 'phone', ph) : null;
        return id || hash ? [{ ...base, action, crm_client_id: id ?? null, subject_hash: hash }] : [];
      });
      await logAccessInTx(c, actor, [...listAccessEntries(base, listed), ...entries]);
    });
  };
}
