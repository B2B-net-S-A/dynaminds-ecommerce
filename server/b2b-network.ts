import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tenantTx, localConfig } from './db';
import { beginCatalogStockControlTransaction, endCatalogStockControlTransaction,
  catalogStockControlAdmissionInTx, finalizeCatalogStockControlActorsInTx, finalizeCatalogStockCountTerminalInTx } from './catalog-stock-control-transaction';
import { audit, productSchema, type Actor } from './domain';
import { createProduct } from './catalog';
import { ensure, Problem } from './errors';
import { tokenHash } from './security';
import {
  beginPurchasingTransaction,
  endPurchasingTransaction,
  purchasingSourceAdmissionInTx,
} from './purchasing-transaction';
import { b2bCatalogPage } from './b2b';
import { b2bCatalogScopeAvailable } from './b2b-catalog-scope';
import { productCatalogsAvailable } from './product-catalogs';
import { b2bCatalogBindInput } from './b2b-catalog-scope-schema';
import { networkLinkDisconnectedInTx, reconnectNetworkLinkInTx, assertNetworkLinkConnectedInTx } from './b2b-network-link-state';
import * as catalogScope from './b2b-catalog-scope-adapters';
import { isDeepStrictEqual } from 'node:util';
import {
  beginWmsTransaction,
  endWmsTransaction,
  finalizeWmsActorsInTx,
  wmsLotsAdmissionInTx,
  wmsTransactionActive,
  enlistWmsActorInTx,
} from './wms-lots-transaction';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function publicRun(row: any) { const { catalog_scope: _scope, catalog_scope_hash: _hash, api_key_id: _key, ...result } = row; return result; }
function publicSnapshot(row: any) { const { catalog_scope: _scope, ...result } = row; return result; }
function currentFingerprint(f: { i: any; snapshot: any }) {
  // Historical unstamped hashes used the original supplier-page field order.
  // Compare against the freshly reconstructed source, never JSONB read order.
  return hash(Object.hasOwn(f.i.snapshot, 'catalog_scope') ? f.snapshot : publicSnapshot(f.snapshot));
}
const imageDir = () => resolve(process.env.DYNA_IMAGE_DIR ?? 'data/product-images');
const networkActors = new WeakMap<PoolClient, Map<string, { actor: Actor; writing: boolean; scopes: string[] }>>();
async function owner<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  const x = (await c.query("SELECT current_user role,session_user login,pg_get_userbyid(relowner) owner FROM pg_class WHERE oid='public.b2b_accounts'::regclass")).rows[0];
  ensure(x && x.login === x.owner && [x.owner, 'dyna_app'].includes(x.role), 403, 'Niezgodny kontekst sieci B2B');
  try { if (x.role === 'dyna_app') await c.query('RESET ROLE'); return await fn(); }
  finally { if (x.role === 'dyna_app') await c.query('SET LOCAL ROLE dyna_app').catch(() => undefined); }
}
const scopeAvailable = (c: PoolClient) => owner(c, () => b2bCatalogScopeAvailable(c));
async function catalogAvailable(c: PoolClient) {
  await scopeAvailable(c); // A partial144 installation must never fall back.
  return owner(c, () => productCatalogsAvailable(c));
}
function enlistNetworkActor(c: PoolClient, a: Actor, writing: boolean, required: string[] = []) {
  const actors = networkActors.get(c); ensure(actors, 500, 'Brak transakcji sieci B2B');
  const key = [a.tenantId, a.userId, a.apiKeyId ?? ''].join(':');
  actors.set(key, { actor: a, writing: writing || !!actors.get(key)?.writing, scopes: [...new Set([...(actors.get(key)?.scopes ?? []), ...required])] });
}
async function networkAccess(c: PoolClient, a: Actor, writing: boolean, pin: boolean, required: string[] = []) {
  return owner(c, async () => {
    const role = (await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2' + (pin ? ' FOR SHARE' : ''), [a.tenantId, a.userId])).rows[0]?.role;
    let scopes: string[] | null = null;
    if (a.apiKeyId) {
      const k = (await c.query('SELECT user_id,scopes,revoked_at,expires_at FROM api_keys WHERE tenant_id=$1 AND id=$2' + (pin ? ' FOR SHARE' : ''), [a.tenantId, a.apiKeyId])).rows[0];
      const now = (await c.query('SELECT clock_timestamp() now')).rows[0].now;
      ensure(k && k.user_id === a.userId && !k.revoked_at && (!k.expires_at || k.expires_at > now), 401, 'Klucz sieci B2B został cofnięty lub wygasł'); scopes = k.scopes;
    }
    ensure((writing ? role === 'admin' : ['admin', 'operator', 'viewer'].includes(role)) && (!scopes || required.every(s => scopes!.includes(s))), 403, writing ? 'Sieć B2B konfiguruje administrator z aktualnymi uprawnieniami' : 'Brak aktualnego uprawnienia do sieci B2B');
  });
}
async function finishNetwork(c: PoolClient) {
  await finalizeWmsActorsInTx(c);
  await finalizeCatalogStockControlActorsInTx(c);
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  // Keep the trusted owner role through all terminal IAM locks and COMMIT.
  await c.query('RESET ROLE');
  const actors = [...(networkActors.get(c)?.values() ?? [])].sort((a, b) =>
    [a.actor.tenantId, a.actor.userId, a.actor.apiKeyId ?? ''].join(':').localeCompare([b.actor.tenantId, b.actor.userId, b.actor.apiKeyId ?? ''].join(':')));
  for (const entry of actors) await networkAccess(c, entry.actor, entry.writing, true, entry.scopes);
  // All partner-specific waits precede the schema and final DB-clock batch.
  await finalizeCatalogStockCountTerminalInTx(c, actors.map(entry => ({
    actor: entry.actor, roles: entry.writing ? ['admin'] : ['admin','operator','viewer'], scopes: entry.scopes,
  })));
}
async function scope(c: PoolClient, tenant: string) {
  await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
}
async function tx<T>(tenant: string, fn: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SET LOCAL statement_timeout='8s'");
    await scope(c, tenant);
    beginWmsTransaction(c);
    beginPurchasingTransaction(c);
    beginCatalogStockControlTransaction(c);
    networkActors.set(c, new Map());
    // Candidate partners are read before every owner/catalog/stock lock. A new
    // partner cannot write until a fresh transaction admits its whole scope.
    const partners = (
      await c.query(
        `SELECT DISTINCT supplier_tenant_id FROM b2b_links
      WHERE tenant_id=$1 ORDER BY supplier_tenant_id LIMIT 1001`,
        [tenant],
      )
    ).rows;
    ensure(partners.length <= 1000, 413, 'Za dużo partnerów dla jednej transakcji sieci B2B');
    const tenants = [...new Set([tenant, ...partners.map((p) => p.supplier_tenant_id)])].sort();
    for (const id of tenants) {
      await scope(c, id);
      await wmsLotsAdmissionInTx(c, { tenantId: id });
    }
    // Admit all WMS scopes first, then all purchase sources, before owner locks.
    for (const id of tenants) {
      await scope(c, id);
      await purchasingSourceAdmissionInTx(c, { tenantId: id });
    }
    // Admit every partner's strict lifecycle in the same tenant order.
    for (const id of tenants) {
      await scope(c, id);
      await catalogStockControlAdmissionInTx(c, { tenantId: id });
    }
    await scope(c, tenant);
    const result = await fn(c);
    await finishNetwork(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    endWmsTransaction(c);
    endPurchasingTransaction(c);
    endCatalogStockControlTransaction(c);
    networkActors.delete(c);
    c.release();
  }
}
/** The counterparty comes only from the caller's persisted return bridge.
 * Admit both firms in one global order before any business or warehouse lock. */
export async function networkPairTx<T>(
  tenant: string,
  caseId: string,
  fn: (c: PoolClient) => Promise<T>,
) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SET LOCAL statement_timeout='8s'");
    await scope(c, tenant);
    const available = (
      await c.query(
        "SELECT to_regprocedure('public.b2b_dropship_return_pair(uuid)') IS NOT NULL available",
      )
    ).rows[0].available;
    ensure(available, 503, 'Zwroty dropshipping wymagają aktualnego schematu');
    const pair = (await c.query('SELECT public.b2b_dropship_return_pair($1::uuid) pair', [caseId]))
      .rows[0].pair;
    ensure(pair, 404, 'Nie znaleziono własnej sprawy zwrotu dropshipping');
    const tenants = [pair.buyer_tenant_id, pair.supplier_tenant_id];
    ensure(
      tenants.every(
        (id) => typeof id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id),
      ) &&
        tenants.includes(tenant) &&
        tenants[0] !== tenants[1],
      503,
      'Niekompletne powiązanie firm w sprawie zwrotu',
    );
    tenants.sort();
    beginWmsTransaction(c);
    beginPurchasingTransaction(c);
    beginCatalogStockControlTransaction(c);
    networkActors.set(c, new Map());
    for (const id of tenants) {
      await scope(c, id);
      await wmsLotsAdmissionInTx(c, { tenantId: id });
    }
    for (const id of tenants) {
      await scope(c, id);
      await purchasingSourceAdmissionInTx(c, { tenantId: id });
    }
    // Admit every partner's strict lifecycle in the same tenant order.
    for (const id of tenants) {
      await scope(c, id);
      await catalogStockControlAdmissionInTx(c, { tenantId: id });
    }
    await scope(c, tenant);
    const result = await fn(c);
    await finishNetwork(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    endWmsTransaction(c);
    endPurchasingTransaction(c);
    endCatalogStockControlTransaction(c);
    networkActors.delete(c);
    c.release();
  }
}
async function currentAdmin(c: PoolClient, a: Actor) {
  enlistNetworkActor(c, a, true);
  await networkAccess(c, a, true, false);
  if (wmsTransactionActive(c)) {
    ensure(
      (await c.query('SELECT wms_current_role($1,false) role', [a.userId])).rows[0].role ===
        'admin',
      403,
      'Sieć B2B konfiguruje bieżący administrator',
    );
    enlistWmsActorInTx(c, a, { adminOnly: true });
    return;
  }
  // OFF uses the same unpinned admission and terminal owner PIN as ON.
}
async function ownLink(c: PoolClient, id: string) {
  const l = (await c.query('SELECT * FROM b2b_links WHERE id=$1 FOR UPDATE', [id])).rows[0];
  ensure(l, 404, 'Nie znaleziono polaczenia B2B');
  return l;
}
async function source(c: PoolClient, l: any) {
  ensure(!l.paused, 409, 'Polaczenie B2B jest wstrzymane');
  await scope(c, l.supplier_tenant_id);
  const a = (await c.query('SELECT * FROM b2b_accounts WHERE id=$1 FOR SHARE', [l.account_id]))
    .rows[0];
  ensure(a?.active, 409, 'Dostawca wylaczyl konto kontrahenta');
  const list = (
    await c.query('SELECT id,currency,version FROM price_lists WHERE id=$1 AND active FOR SHARE', [
      a.price_list_id,
    ])
  ).rows[0];
  ensure(list, 409, 'Cennik dostawcy jest nieaktywny');
  return { account: a, list };
}
async function withLink<T>(
  tenant: string,
  id: string,
  fn: (c: PoolClient, l: any, s: any) => Promise<T>,
  options: { actor?: Actor; purpose?: 'read' | 'create_product' | 'bind_product' } = {},
) {
  return tx(tenant, async (c) => {
    if (options.actor) { const writing = options.purpose === 'create_product' || options.purpose === 'bind_product', required = ['products:read', 'purchasing:read', ...(writing ? ['products:write', 'purchasing:write'] : [])]; enlistNetworkActor(c, options.actor, writing, required); await networkAccess(c, options.actor, writing, false, required); }
    const pair = await catalogAvailable(c) ? await catalogScope.guardB2BCatalogPairInTx(c, { tenantId: tenant, linkId: id, purpose: options.purpose ?? 'read' }) : null;
    const l = await ownLink(c, id),
      s = await source(c, l);
    return fn(c, l, { ...s, catalogScope: pair });
  });
}
const inviteInput = z
  .object({
    version: z.number().int().positive(),
    recipient_email: z.email().transform((s) => s.toLowerCase()),
    confirmed: z.literal(true),
  })
  .strict();
const invitationHistoryQuery = z.object({
  after: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
}).strict();
const invitationTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
const invitationHistoryAnchor = z.object({
  schema: z.literal('b2b-network-invitation-page/v1'), tenant: z.uuid(), actor: z.uuid(), key: z.uuid().nullable(),
  account: z.uuid(), account_version: z.number().int().positive(), limit: z.number().int().min(1).max(50),
  at: invitationTimestamp, id: z.uuid(), as_of: invitationTimestamp,
}).strict();
function invitationCursor(body: z.infer<typeof invitationHistoryAnchor>) {
  const data = Buffer.from(JSON.stringify(body)).toString('base64url');
  return data + '.' + createHmac('sha256', localConfig.encryptionKey).update('b2b-network-invitations\0' + data).digest('hex');
}
function invitationAnchor(cursor: string) {
  try {
    const [data, mac, ...extra] = cursor.split('.');
    ensure(!extra.length && /^[A-Za-z0-9_-]+$/.test(data ?? '') && /^[a-f0-9]{64}$/.test(mac ?? ''), 422, 'Niepoprawny kursor historii zaproszeń');
    const expected = createHmac('sha256', localConfig.encryptionKey).update('b2b-network-invitations\0' + data).digest();
    ensure(timingSafeEqual(Buffer.from(mac, 'hex'), expected), 422, 'Niepoprawny kursor historii zaproszeń');
    const raw = Buffer.from(data, 'base64url');
    ensure(raw.toString('base64url') === data, 422, 'Niepoprawny kursor historii zaproszeń');
    return invitationHistoryAnchor.parse(JSON.parse(raw.toString('utf8')));
  } catch { throw new Problem(422, 'Niepoprawny kursor historii zaproszeń'); }
}
const acceptInput = z
  .object({ token: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) })
  .strict();
const settingInput = z
  .object({
    version: z.number().int().positive(),
    paused: z.boolean(),
    schedule_minutes: z
      .number()
      .int()
      .refine((n) => n === 0 || (n >= 5 && n <= 1440)),
    confirmed: z.literal(true),
  })
  .strict();
const refreshInput = z.object({ client_key: z.uuid(), confirmed: z.literal(true) }).strict();
const createInput = z
  .object({
    version: z.number().int().positive(),
    sku: z.string().trim().min(1).max(80),
    sale_price: z.number().int().min(0).max(100000000),
    warehouse_id: z.uuid(),
    confirmed: z.literal(true),
  })
  .strict();
export { b2bCatalogBindInput };
async function startRun(c: PoolClient, a: Actor, l: any, s: any, key: string) {
  await scope(c, a.tenantId);
  await currentAdmin(c, a);
  const old = (await c.query('SELECT * FROM b2b_catalog_runs WHERE link_id=$1 AND client_key=$2', [l.id, key])).rows[0];
  if (old) { ensure(old.actor_id === a.userId && (old.api_key_id ?? null) === (a.apiKeyId ?? null), 409, 'Klucz odświeżania należy do innego aktora'); return old; }
  await c.query(
    "UPDATE b2b_catalog_runs r SET state='failed',error='Zadanie zakonczone po utracie dzierzawy',finished_at=now() FROM jobs j WHERE r.link_id=$1 AND r.job_id=j.id AND r.state='queued' AND j.state='failed'",
    [l.id],
  );
  await c.query(
    "DELETE FROM b2b_catalog_staging WHERE run_id IN(SELECT id FROM b2b_catalog_runs WHERE link_id=$1 AND state='failed')",
    [l.id],
  );
  ensure(
    !(await c.query("SELECT 1 FROM b2b_catalog_runs WHERE link_id=$1 AND state='queued'", [l.id]))
      .rowCount,
    409,
    'Odswiezanie katalogu juz trwa',
  );
  ensure(
    (await c.query("SELECT count(*)::int n FROM jobs WHERE state IN ('pending','running')")).rows[0]
      .n < 1000,
    429,
    'Kolejka firmy jest pelna',
  );
  const id = randomUUID(),
    job = randomUUID();
  const pair = s.catalogScope ?? null;
  const stamped = pair && await scopeAvailable(c);
  const scopeHash = stamped ? await owner(c, async () => (await c.query('SELECT public.b2b_catalog_scope_hash($1::jsonb) h', [JSON.stringify(pair)])).rows[0].h) : null;
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'b2b.catalog',$3,$4)",
    [
      job,
      a.tenantId,
      JSON.stringify({ run_id: id, link_id: l.id, actor_id: a.userId, ...(stamped ? { api_key_id: a.apiKeyId ?? null, catalog_scope_hash: scopeHash } : {}) }),
      'b2b.catalog:' + id,
    ],
  );
  const r = (
    await c.query(
      stamped ? 'INSERT INTO b2b_catalog_runs(id,tenant_id,link_id,actor_id,client_key,link_version,account_version,list_version,job_id,catalog_scope,catalog_scope_hash,api_key_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING *'
        : 'INSERT INTO b2b_catalog_runs(id,tenant_id,link_id,actor_id,client_key,link_version,account_version,list_version,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [id, a.tenantId, l.id, a.userId, key, l.version, s.account.version, s.list.version, job, ...(stamped ? [JSON.stringify(pair), scopeHash, a.apiKeyId ?? null] : [])],
    )
  ).rows[0];
  await audit(c, a, 'b2b.network.refresh', id, { link_id: l.id });
  return r;
}
export async function processB2bCatalog(job: any) {
  await tx(job.tenant_id, async (c) => {
    const pair = await catalogAvailable(c) ? await catalogScope.guardB2BCatalogPairInTx(c, { tenantId: job.tenant_id, linkId: job.payload.link_id }) : null;
    const l = await ownLink(c, job.payload.link_id);
    const r = (
      await c.query('SELECT * FROM b2b_catalog_runs WHERE id=$1 FOR UPDATE', [job.payload.run_id])
    ).rows[0];
    ensure(
      r && r.link_id === l.id && r.job_id === job.id && r.state === 'queued',
      409,
      'Przebieg katalogu nieaktywny',
    );
    const owned = (
      await c.query("SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running'", [
        job.id,
        job.lease_token,
      ])
    ).rowCount;
    ensure(owned, 409, 'Dzierzawa nieaktualna');
    await currentAdmin(c, { tenantId: job.tenant_id, userId: r.actor_id, role: 'admin', ...(r.api_key_id ? { apiKeyId: r.api_key_id, source: 'api' as const } : {}) });
    if (r.api_key_id) {
      const actor: Actor = { tenantId:job.tenant_id,userId:r.actor_id,role:'admin',apiKeyId:r.api_key_id,source:'api' };
      const required = ['products:read','products:write','purchasing:read','purchasing:write'];
      enlistNetworkActor(c,actor,true,required);await networkAccess(c,actor,true,false,required);
    }
    if (r.catalog_scope) {
      ensure(pair && isDeepStrictEqual(pair, r.catalog_scope) && job.payload.catalog_scope_hash === r.catalog_scope_hash && (job.payload.api_key_id ?? null) === (r.api_key_id ?? null), 409, 'Warunki lub ceny zmienily sie podczas odczytu');
    } else ensure(!pair || (pair.buyer.mode === 'legacy_default' && pair.supplier.mode === 'legacy_default'), 409, 'Historyczny przebieg nie ma dowodu skonfigurowanego katalogu');
    const s = await source(c, l);
    ensure(
      l.version === r.link_version &&
        s.account.version === r.account_version &&
        s.list.version === r.list_version,
      409,
      'Warunki lub ceny zmienily sie podczas odczytu',
    );
    const page = pair ? await catalogScope.readB2BSupplierCatalogPageInTx(c, pair.supplier, { ...(r.cursor ? { after: r.cursor } : {}), limit: 200 })
      : await b2bCatalogPage(c, s.account, { after: r.cursor ?? undefined }, 200);
    ensure(r.fetched + page.data.length <= 100000, 422, 'Katalog przekracza limit 100000 SKU');
    const rows = page.data.map((p) => ({
      source_product_id: p.id,
      snapshot: { ...p, currency: page.currency, ...(pair ? { catalog_scope: { protocol: 'b2b_catalog_snapshot_v1', buyer: pair.buyer, supplier: pair.supplier } } : {}) },
      fingerprint: hash({ ...p, currency: page.currency, ...(pair ? { catalog_scope: { protocol: 'b2b_catalog_snapshot_v1', buyer: pair.buyer, supplier: pair.supplier } } : {}) }),
    }));
    await scope(c, job.tenant_id);
    if (rows.length)
      await c.query(
        `INSERT INTO b2b_catalog_staging(tenant_id,run_id,source_product_id,snapshot,fingerprint)
   SELECT $1,$2,x.source_product_id,x.snapshot,x.fingerprint FROM jsonb_to_recordset($3::jsonb) x(source_product_id uuid,snapshot jsonb,fingerprint text)
   ON CONFLICT(tenant_id,run_id,source_product_id) DO UPDATE SET snapshot=excluded.snapshot,fingerprint=excluded.fingerprint`,
        [job.tenant_id, r.id, JSON.stringify(rows)],
      );
    await c.query('UPDATE b2b_catalog_runs SET cursor=$2,fetched=fetched+$3 WHERE id=$1', [
      r.id,
      page.next,
      page.data.length,
    ]);
    if (!page.next) {
      await c.query(
        `INSERT INTO b2b_catalog_items(tenant_id,link_id,source_product_id,snapshot,fingerprint)
    SELECT tenant_id,$2,source_product_id,snapshot,fingerprint FROM b2b_catalog_staging WHERE run_id=$1
    ON CONFLICT(tenant_id,link_id,source_product_id) DO UPDATE SET snapshot=excluded.snapshot,fingerprint=excluded.fingerprint,published=true,
    version=b2b_catalog_items.version+CASE WHEN b2b_catalog_items.fingerprint<>excluded.fingerprint OR NOT b2b_catalog_items.published THEN 1 ELSE 0 END,refreshed_at=now()`,
        [r.id, l.id],
      );
      await c.query(
        `UPDATE b2b_catalog_items i SET published=false,version=version+1,refreshed_at=now() WHERE i.link_id=$1 AND i.published AND NOT EXISTS(SELECT 1 FROM b2b_catalog_staging s WHERE s.run_id=$2 AND s.source_product_id=i.source_product_id)`,
        [l.id, r.id],
      );
      await c.query("UPDATE b2b_catalog_runs SET state='done',finished_at=now() WHERE id=$1", [
        r.id,
      ]);
      await c.query('UPDATE b2b_links SET last_at=now(),last_run_id=$2,error=NULL WHERE id=$1', [
        l.id,
        r.id,
      ]);
      await c.query('DELETE FROM b2b_catalog_staging WHERE run_id=$1', [r.id]);
    }
    const updated = await c.query(
      "UPDATE jobs SET state=$3,attempts=0,lease_token=NULL,locked_at=NULL,error=NULL,run_at=now() WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING id",
      [job.id, job.lease_token, page.next ? 'pending' : 'done'],
    );
    ensure(updated.rowCount, 409, 'Dzierzawa zmieniona przed zapisem');
  });
}
export async function failB2bCatalog(job: any, error: unknown) {
  const message = error instanceof Problem ? error.message : 'Blad lokalnego katalogu B2B';
  await tenantTx(job.tenant_id, async (c) => {
    const l = await ownLink(c, job.payload.link_id);
    const retry =
      !(error instanceof Problem && [403, 404, 409, 422].includes(error.status)) &&
      job.attempts < job.max_attempts;
    const updated = await c.query(
      "UPDATE jobs SET state=$3,error=$4,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING id",
      [job.id, job.lease_token, retry ? 'pending' : 'failed', message],
    );
    if (!updated.rowCount) return;
    await c.query('UPDATE b2b_links SET error=$2 WHERE id=$1', [l.id, message]);
    if (!retry) {
      await c.query(
        "UPDATE b2b_catalog_runs SET state='failed',error=$2,finished_at=now() WHERE id=$1 AND state='queued'",
        [job.payload.run_id, message],
      );
      await c.query('DELETE FROM b2b_catalog_staging WHERE run_id=$1', [job.payload.run_id]);
    }
  });
}
export async function scheduleB2bNetworkDue() {
  const rows = (
    await pool.query(
      'SELECT id,tenant_id,actor_id FROM b2b_links WHERE NOT paused AND schedule_minutes>0 AND next_at<=now() ORDER BY next_at,id LIMIT 20',
    )
  ).rows;
  for (const row of rows)
    try {
      await withLink(row.tenant_id, row.id, async (c, l, s) => {
        await scope(c, row.tenant_id);
        if (l.paused || !l.schedule_minutes || l.next_at > new Date()) return;
        if (
          !(
            await c.query(
              "SELECT 1 FROM b2b_catalog_runs r JOIN jobs j ON j.id=r.job_id WHERE r.link_id=$1 AND r.state='queued' AND j.state IN ('pending','running')",
              [l.id],
            )
          ).rowCount
        )
          await startRun(
            c,
            { tenantId: row.tenant_id, userId: l.actor_id, role: 'admin' },
            l,
            s,
            randomUUID(),
          );
        await c.query(
          'UPDATE b2b_links SET next_at=now()+make_interval(mins=>schedule_minutes) WHERE id=$1',
          [l.id],
        );
      });
    } catch (e) {
      await tenantTx(row.tenant_id, (c) =>
        c.query(
          'UPDATE b2b_links SET error=$2,next_at=now()+make_interval(mins=>greatest(5,schedule_minutes)) WHERE id=$1',
          [row.id, e instanceof Problem ? e.message : 'Blad harmonogramu B2B'],
        ),
      );
    }
}
export function registerB2bNetworkRoutes(app: FastifyInstance) {
  const id = (r: any) => z.object({ id: z.uuid() }).parse(r.params).id;
  const admin = (r: any) =>
    ensure(r.actor.role === 'admin', 403, 'Siec B2B konfiguruje administrator');
  app.get('/api/b2b/accounts/:id/network-invitations', async (r, reply) => {
    reply.header('Cache-Control', 'no-store');
    admin(r);
    const accountId = id(r), q = invitationHistoryQuery.parse(r.query), a = r.actor;
    const anchor = q.after ? invitationAnchor(q.after) : null;
    ensure(!anchor || (anchor.tenant === a.tenantId && anchor.actor === a.userId && anchor.key === (a.apiKeyId ?? null) && anchor.account === accountId && anchor.limit === q.limit), 422, 'Kursor należy do innego zakresu historii zaproszeń');
    // Reuse the normal network admission and final current-admin locks. The
    // history itself issues only SELECTs and never refreshes/revokes an invite.
    const page = await tx(a.tenantId, async c => {
      await currentAdmin(c, a);
      const account = (await c.query('SELECT id,version FROM b2b_accounts WHERE tenant_id=$1 AND id=$2', [a.tenantId, accountId])).rows[0];
      ensure(account, 404, 'Nie znaleziono własnego konta kontrahenta');
      ensure(!anchor || anchor.account_version === account.version, 409, 'Konto kontrahenta zmieniło się; odśwież historię');
      // PostgreSQL text retains microseconds; a JS Date would truncate a page
      // boundary. Expiry and the creation cut keep the same DB time on all pages.
      const asOf = anchor?.as_of ?? (await c.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed_at`)).rows[0].observed_at;
      invitationTimestamp.parse(asOf);
      const rows = (await c.query(`SELECT id,state,account_version,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at,
        to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') expires_at,
        (state='pending' AND expires_at <= $5::timestamptz) expired
        FROM b2b_link_invitations WHERE tenant_id=$1 AND account_id=$2
        AND created_at <= $5::timestamptz
        AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
        ORDER BY created_at DESC,id DESC LIMIT $6`, [a.tenantId, accountId, anchor?.at ?? null, anchor?.id ?? null, asOf, q.limit + 1])).rows;
      const data = rows.slice(0, q.limit).map(row => ({ id: row.id, state: row.state, expired: row.expired, account_version: row.account_version, created_at: row.created_at, expires_at: row.expires_at }));
      const last = data.at(-1);
      const next = rows.length > q.limit && last ? invitationCursor({ schema: 'b2b-network-invitation-page/v1', tenant: a.tenantId, actor: a.userId, key: a.apiKeyId ?? null, account: accountId, account_version: account.version, limit: q.limit, at: last.created_at, id: last.id, as_of: asOf }) : null;
      const result = { account: { id: account.id, version: account.version }, expiry_evaluated_at: asOf, data, next };
      ensure(Buffer.byteLength(JSON.stringify(result)) <= 65536, 413, 'Historia zaproszeń przekracza limit odczytu');
      return result; // tx performs the existing fresh terminal IAM check before COMMIT.
    });
    return page;
  });
  app.post('/api/b2b/accounts/:id/network-invite', async (r) => {
    admin(r);
    const b = inviteInput.parse(r.body),
      token = randomBytes(32).toString('hex');
    return tx(r.actor.tenantId, async (c) => {
      await currentAdmin(c, r.actor);
      const a = (await c.query('SELECT * FROM b2b_accounts WHERE id=$1 FOR UPDATE', [id(r)]))
        .rows[0];
      ensure(a?.active && a.version === b.version, 409, 'Zatwierdz aktualne konto kontrahenta');
      ensure(
        !(
          await c.query(
            "SELECT 1 FROM b2b_link_invitations WHERE account_id=$1 AND state='accepted'",
            [a.id],
          )
        ).rowCount ||
          // 251 (B2B-002): a disconnected link is reconnected by a new invitation to the same company.
          (await networkLinkDisconnectedInTx(c, a.id)),
        409,
        'Kontrahent ma juz polaczona firme',
      );
      await c.query(
        "UPDATE b2b_link_invitations SET state='revoked' WHERE account_id=$1 AND state='pending'",
        [a.id],
      );
      const invitation = randomUUID();
      await c.query(
        'INSERT INTO b2b_link_invitations(id,tenant_id,account_id,actor_id,recipient_email,token_hash,account_version) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          invitation,
          r.actor.tenantId,
          a.id,
          r.actor.userId,
          b.recipient_email,
          tokenHash(token),
          a.version,
        ],
      );
      await audit(c, r.actor, 'b2b.network.invite', invitation, {
        account_id: a.id,
        recipient_email: b.recipient_email,
      });
      return { token, expires_hours: 24, recipient_email: b.recipient_email };
    });
  });
  app.post('/api/b2b/network/accept', async (r) => {
    admin(r);
    const b = acceptInput.parse(r.body),
      email = (await pool.query('SELECT email FROM users WHERE id=$1', [r.actor.userId])).rows[0]
        .email;
    const ref = (
      await pool.query(
        "SELECT id,tenant_id,account_id FROM b2b_link_invitations WHERE token_hash=$1 AND recipient_email=$2 AND state='pending' AND expires_at>now()",
        [tokenHash(b.token), email],
      )
    ).rows[0];
    ensure(
      ref && ref.tenant_id !== r.actor.tenantId,
      404,
      'Zaproszenie nie jest aktywne dla tego administratora',
    );
    return tx(r.actor.tenantId, async (c) => {
      await currentAdmin(c, r.actor);
      await scope(c, ref.tenant_id);
      const a = (
        await c.query('SELECT * FROM b2b_accounts WHERE id=$1 FOR UPDATE', [ref.account_id])
      ).rows[0];
      const i = (
        await c.query('SELECT * FROM b2b_link_invitations WHERE id=$1 FOR UPDATE', [ref.id])
      ).rows[0];
      ensure(
        a?.active &&
          i?.state === 'pending' &&
          i.expires_at > new Date() &&
          i.account_version === a.version,
        409,
        'Zaproszenie lub warunki zmienily sie',
      );
      const supplierName = (await c.query('SELECT name FROM tenants WHERE id=$1', [ref.tenant_id]))
        .rows[0].name;
      await c.query("UPDATE b2b_link_invitations SET state='accepted' WHERE id=$1", [i.id]);
      await audit(c, { tenantId: ref.tenant_id, userId: null }, 'b2b.network.accepted', i.id, {
        buyer_tenant: r.actor.tenantId,
      });
      await scope(c, r.actor.tenantId);
      // 251 (B2B-002): a disconnected link of this account reconnects in place, for the same buyer company only.
      const reconnected = await reconnectNetworkLinkInTx(c, r.actor, { supplierTenantId: ref.tenant_id, accountId: a.id, invitationId: i.id, supplierName });
      if (reconnected) return reconnected;
      const link = randomUUID();
      const l = (
        await c.query(
          'INSERT INTO b2b_links(id,tenant_id,supplier_tenant_id,account_id,invitation_id,actor_id,supplier_name) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [link, r.actor.tenantId, ref.tenant_id, a.id, i.id, r.actor.userId, supplierName],
        )
      ).rows[0];
      await audit(c, r.actor, 'b2b.network.accept', l.id, { supplier_tenant: ref.tenant_id });
      return l;
    });
  });
  app.get('/api/b2b/network/links', (r) =>
    tenantTx(r.actor.tenantId, async (c) => {
      const q = z.object({ after: z.uuid().optional() }).strict().parse(r.query),
        rows = (
          await c.query(
            'SELECT * FROM b2b_links WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 26',
            [q.after ?? null],
          )
        ).rows;
      return {
        data: rows.slice(0, 25),
        currency: (await c.query('SELECT currency FROM tenants WHERE id=$1', [r.actor.tenantId]))
          .rows[0].currency,
        next: rows.length > 25 ? rows[24].id : null,
      };
    }),
  );
  app.patch('/api/b2b/network/links/:id', (r) => {
    admin(r);
    const b = settingInput.parse(r.body);
    return tx(r.actor.tenantId, async (c) => {
      await currentAdmin(c, r.actor);
      const l = await ownLink(c, id(r));
      ensure(l.version === b.version, 409, 'Polaczenie zmienilo sie');
      // 251 (B2B-002): a disconnected link stays paused until the supplier's new invitation reconnects it.
      await assertNetworkLinkConnectedInTx(c, l);
      await c.query(
        "UPDATE jobs SET state='done',error='Przebieg anulowany przez administratora',lease_token=NULL,locked_at=NULL WHERE id IN(SELECT job_id FROM b2b_catalog_runs WHERE link_id=$1 AND state='queued')",
        [l.id],
      );
      await c.query(
        "UPDATE b2b_catalog_runs SET state='cancelled',error='Zmiana ustawien polaczenia',finished_at=now() WHERE link_id=$1 AND state='queued'",
        [l.id],
      );
      await c.query(
        "DELETE FROM b2b_catalog_staging WHERE run_id IN(SELECT id FROM b2b_catalog_runs WHERE link_id=$1 AND state='cancelled')",
        [l.id],
      );
      const row = (
        await c.query(
          'UPDATE b2b_links SET paused=$2,schedule_minutes=$3,actor_id=$4,version=version+1,next_at=CASE WHEN $2 OR $3=0 THEN NULL ELSE now()+make_interval(mins=>$3) END,error=NULL WHERE id=$1 RETURNING *',
          [l.id, b.paused, b.schedule_minutes, r.actor.userId],
        )
      ).rows[0];
      await audit(c, r.actor, 'b2b.network.settings', l.id, {
        paused: b.paused,
        schedule_minutes: b.schedule_minutes,
      });
      return row;
    });
  });
  app.post('/api/b2b/network/links/:id/refresh', (r) => {
    admin(r);
    const b = refreshInput.parse(r.body);
    return (async () => {
      const replay = await tx(r.actor.tenantId, async c => {
        await currentAdmin(c, r.actor);
        const old = (await c.query('SELECT * FROM b2b_catalog_runs WHERE link_id=$1 AND client_key=$2', [id(r), b.client_key])).rows[0];
        if (old) ensure(old.actor_id === r.actor.userId && (old.api_key_id ?? null) === (r.actor.apiKeyId ?? null), 409, 'Klucz odświeżania należy do innego aktora');
        return old ? publicRun(old) : null;
      });
      if (replay) return replay;
      return publicRun(await withLink(r.actor.tenantId, id(r), (c, l, s) => startRun(c, r.actor, l, s, b.client_key), { actor: r.actor }));
    })();
  });
  app.get('/api/b2b/network/links/:id/runs', (r) =>
    tenantTx(r.actor.tenantId, async (c) => {
      await ownLink(c, id(r));
      const q = z.object({ after: z.uuid().optional() }).strict().parse(r.query),
        rows = (
          await c.query(
            'SELECT * FROM b2b_catalog_runs WHERE link_id=$1 AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM b2b_catalog_runs WHERE id=$2 AND link_id=$1)) ORDER BY created_at DESC,id DESC LIMIT 26',
            [id(r), q.after ?? null],
          )
        ).rows;
      return { data: rows.slice(0, 25).map(publicRun), next: rows.length > 25 ? rows[24].id : null };
    }),
  );
  app.get('/api/b2b/network/links/:id/catalog', (r) =>
    withLink(r.actor.tenantId, id(r), async (c, l, s) => {
      await scope(c, r.actor.tenantId);
      const q = z
        .object({ after: z.uuid().optional(), search: z.string().trim().max(100).default('') })
        .strict()
        .parse(r.query);
      const rows = (
        await c.query(
          "SELECT * FROM b2b_catalog_items WHERE link_id=$1 AND ($2::uuid IS NULL OR id>$2) AND ($3='' OR strpos(lower(snapshot->>'sku'||' '||(snapshot->>'name')),lower($3))>0) ORDER BY id LIMIT 51",
          [l.id, q.after ?? null, q.search],
        )
      ).rows;
      if (s.catalogScope) {
        const visible = rows.slice(0, 50).map(i => i.id);
        if (visible.length) await catalogScope.assertB2BBuyerCatalogItemPoolsInTx(c, s.catalogScope, visible);
      }
      const target = s.catalogScope ? await owner(c, async () => (await c.query('SELECT id,name,version::text FROM product_catalogs WHERE tenant_id=$1 AND id=$2', [r.actor.tenantId, s.catalogScope.buyer.target_catalog_id])).rows[0]) : null;
      return {
        data: rows.slice(0, 50).map((i) => ({
          ...i,
          snapshot: {
            ...publicSnapshot(i.snapshot),
            available: i.published ? i.snapshot.available : 0,
            images: i.snapshot.images.map((url: string) =>
              url.startsWith('/api/product-images/')
                ? '/api/b2b/network/links/' +
                  l.id +
                  '/catalog/' +
                  i.id +
                  '/images/' +
                  url.split('/').at(-1)
                : url,
            ),
          },
        })),
        next: rows.length > 50 ? rows[49].id : null,
        last_at: l.last_at,
        target_catalog: target,
      };
    }, { actor: r.actor }),
  );
  async function fresh(c: PoolClient, l: any, s: any, itemId: string) {
    await scope(c, l.tenant_id);
    const i = (
      await c.query('SELECT * FROM b2b_catalog_items WHERE id=$1 AND link_id=$2 FOR UPDATE', [
        itemId,
        l.id,
      ])
    ).rows[0];
    ensure(i?.published, 404, 'Produkt nie jest opublikowany w katalogu');
    await scope(c, l.supplier_tenant_id);
    const pair: catalogScope.B2BCatalogPair | null = s.catalogScope ?? null;
    const snapshot = pair ? await (async () => {
      await scope(c, l.tenant_id);
      const next = await catalogScope.b2bCatalogSourceSnapshotInTx(c, pair, i.source_product_id);
      await catalogScope.assertB2BCatalogSourceSnapshotInTx(c, pair, i.source_product_id, i.snapshot);
      await scope(c, l.supplier_tenant_id); return next;
    })() : await (async () => {
      const p = await b2bCatalogPage(c, s.account, { ids: [i.source_product_id] }, 1);
      ensure(p.data.length === 1, 409, 'Dostawca wycofal produkt'); return { ...p.data[0], currency: p.currency };
    })();
    return { i, snapshot };
  }
  async function image(c: PoolClient, snapshot: any, imageId: string) {
    ensure(
      snapshot.images.includes('/api/product-images/' + imageId),
      404,
      'Zdjecie nie nalezy do udostepnionego produktu',
    );
    const img = (await c.query('SELECT mime,size FROM product_images WHERE id=$1', [imageId]))
      .rows[0];
    ensure(img, 404, 'Nie znaleziono zdjecia');
    const bytes = await readFile(resolve(imageDir(), imageId)).catch(() => null);
    ensure(bytes, 404, 'Plik zdjecia niedostepny');
    return { ...img, bytes };
  }
  app.get('/api/b2b/network/links/:id/catalog/:item/images/:image', async (r, reply) => {
    const img = await withLink(r.actor.tenantId, id(r), async (c, l, s) => {
      const p = z.object({ item: z.uuid(), image: z.uuid() }).parse(r.params);
      if (s.catalogScope) {
        await scope(c, l.tenant_id);
        const item = (await catalogScope.assertB2BBuyerCatalogItemPoolsInTx(c, s.catalogScope, [p.item]))[0];
        ensure(item.published, 404, 'Produkt nie jest opublikowany w katalogu');
        await scope(c, l.supplier_tenant_id);
        return image(c, item.snapshot, p.image);
      }
      const f = await fresh(c, l, s, p.item);
      return image(c, f.snapshot, p.image);
    }, { actor: r.actor });
    return reply.type(img.mime).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').send(img.bytes);
});
  app.post('/api/b2b/network/links/:id/catalog/:item/product', async (r) => {
    admin(r);
    const b = createInput.parse(r.body),
      item = z.object({ item: z.uuid() }).parse(r.params).item,
      createdFiles: string[] = [];
    try {
      return await withLink(r.actor.tenantId, id(r), async (c, l, s) => {
        const f = await fresh(c, l, s, item);
        ensure(
          f.i.version === b.version && f.i.fingerprint === currentFingerprint(f),
          409,
          'Produkt lub stan zmienily sie; odswiez katalog',
        );
        ensure(!f.i.product_id, 409, 'Produkt ma juz lokalne powiazanie');
        const photos = [] as { id: string; mime: string; size: number; bytes: Buffer }[],
          images = [] as string[];
        for (const url of f.snapshot.images)
          if (url.startsWith('/api/product-images/')) {
            const img = await image(c, f.snapshot, z.uuid().parse(url.split('/').at(-1)));
            const id = randomUUID();
            await mkdir(imageDir(), { recursive: true });
            await writeFile(resolve(imageDir(), id), img.bytes, { flag: 'wx', mode: 0o600 });
            createdFiles.push(id);
            photos.push({ id, ...img });
            images.push('/api/product-images/' + id);
          } else images.push(url);
        await scope(c, r.actor.tenantId);
        if (s.catalogScope) await catalogScope.assertB2BBuyerCatalogWarehouseInTx(c, s.catalogScope.buyer, b.warehouse_id);
        else await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['catalog:' + r.actor.tenantId]);
        await currentAdmin(c, r.actor);
        for (const img of photos)
          await c.query('INSERT INTO product_images(id,tenant_id,mime,size) VALUES($1,$2,$3,$4)', [
            img.id,
            r.actor.tenantId,
            img.mime,
            img.size,
          ]);
        const product = await createProduct(
          c,
          r.actor,
          productSchema.parse({
            sku: b.sku,
            name: f.snapshot.name,
            description: f.snapshot.description,
            attributes:
              Object.keys(f.snapshot.attributes).length < 50
                ? { ...f.snapshot.attributes, 'Rodzaj u dostawcy': f.snapshot.kind }
                : f.snapshot.attributes,
            images,
            vat: f.snapshot.vat,
            price: b.sale_price,
            warehouse_id: b.warehouse_id,
            quantity: 0,
            ...(s.catalogScope ? { catalog_id: s.catalogScope.buyer.target_catalog_id } : {}),
          }),
        );
        await c.query('UPDATE b2b_catalog_items SET product_id=$2,version=version+1 WHERE id=$1', [
          f.i.id,
          product.id,
        ]);
        await audit(c, r.actor, 'b2b.network.product', product.id, {
          link_id: l.id,
          source_product_id: f.i.source_product_id,
          supplier_currency: f.snapshot.currency,
          supplier_price: f.snapshot.price,
        });
        return { product_id: product.id, quantity: 0, supplier_available: f.snapshot.available };
      }, { actor: r.actor, purpose: 'create_product' });
    } catch (e) {
      for (const id of createdFiles) await unlink(resolve(imageDir(), id)).catch(() => {});
      throw e;
    }
  });
  app.post('/api/b2b/network/links/:id/catalog/:item/bind', { bodyLimit: 16384 }, async (r, reply) => {
    admin(r); const b = b2bCatalogBindInput.parse(r.body), item = z.object({ item: z.uuid().transform(v => v.toLowerCase()) }).parse(r.params).item, linkId = id(r).toLowerCase();
    const result = await tx(r.actor.tenantId, async c => {
      const required = ['products:read','products:write','purchasing:read','purchasing:write'];
      enlistNetworkActor(c, r.actor, true, required); await networkAccess(c, r.actor, true, false, required);
      ensure(await scopeAvailable(c), 503, 'Powiązanie wymaga schematu zakresów B2B');
      // Quota precedes both sorted catalog locks, including exact replay.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['b2b.catalog.scope.quota:' + r.actor.tenantId]);
      const requestHash = await owner(c, async () => (await c.query("SELECT public.b2b_catalog_scope_hash(jsonb_build_object('actor',$1::uuid,'key',$2::uuid,'link_id',$3::uuid,'item_id',$4::uuid,'request',$5::jsonb)) h", [r.actor.userId,r.actor.apiKeyId ?? null,linkId,item,JSON.stringify(b)])).rows[0].h);
      const old = await owner(c, async () => (await c.query('SELECT * FROM b2b_catalog_bindings WHERE tenant_id=$1 AND client_key=$2', [r.actor.tenantId,b.client_key])).rows[0]);
      if (old) {
        ensure(old.actor_id === r.actor.userId && (old.api_key_id ?? null) === (r.actor.apiKeyId ?? null) && old.request_hash === requestHash && old.link_id === linkId && old.item_id === item, 409, 'Klucz powiązania ma innego wykonawcę lub treść');
        return { binding: old.response, reused: true };
      }
      const pair = await catalogScope.guardB2BCatalogPairInTx(c, { tenantId:r.actor.tenantId,linkId,purpose:'bind_product' });
      const l = await ownLink(c, linkId), s = { ...await source(c,l), catalogScope:pair };
      const f = await fresh(c, l, s, item);
      ensure(f.i.version === b.version && f.i.fingerprint === currentFingerprint(f), 409, 'Produkt lub stan zmieniły się; odśwież katalog');
      ensure(!f.i.product_id, 409, 'Produkt ma już lokalne powiązanie');
      await scope(c, r.actor.tenantId); await currentAdmin(c, r.actor);
      await catalogScope.assertB2BCatalogProductsInTx(c, pair.buyer, [b.product_id]);
      ensure((await c.query("SELECT id FROM products WHERE id=$1 AND active AND kind IN('simple','variant') FOR SHARE", [b.product_id])).rowCount, 409, 'Powiązanie przyjęcia wymaga prostego produktu lub wariantu');
      await c.query('UPDATE b2b_catalog_items SET product_id=$2,version=version+1 WHERE id=$1', [f.i.id, b.product_id]);
      const binding = await owner(c, async () => (await c.query(`WITH stamp AS(SELECT gen_random_uuid() id,clock_timestamp() at)
        INSERT INTO b2b_catalog_bindings(id,tenant_id,actor_id,api_key_id,link_id,item_id,product_id,client_key,request_hash,request,catalog_scope,source_snapshot,response,created_at)
        SELECT stamp.id,$1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,
         jsonb_build_object('id',stamp.id,'link_id',$4::uuid,'item_id',$5::uuid,'product_id',$6::uuid,'item_version_before',$12::int,'item_version_after',$12::int+1,'quantity',0,'supplier_available',$13::int,'created_at',stamp.at),stamp.at FROM stamp RETURNING response`,
        [r.actor.tenantId,r.actor.userId,r.actor.apiKeyId ?? null,l.id,f.i.id,b.product_id,b.client_key,requestHash,JSON.stringify(b),JSON.stringify(pair),JSON.stringify(f.i.snapshot),f.i.version,f.snapshot.available])).rows[0].response);
      await owner(c, () => c.query('SELECT public.b2b_catalog_scope_budget($1::uuid)', [r.actor.tenantId]));
      await audit(c, r.actor, 'b2b.network.bound', f.i.id, { link_id: l.id, product_id: b.product_id, source_product_id: f.i.source_product_id });
      return { binding, reused: false };
    });
    return reply.code(result.reused ? 200 : 201).send(result);
  });
}

// Internal bridge helpers: callers must start from their own accepted link.
export {
  tx as networkTx,
  scope as networkScope,
  ownLink as networkLink,
  source as networkSource,
  currentAdmin as networkAdmin,
  enlistNetworkActor as networkEnlistActorInTx,
};
