/** B2B-008 public supplier directory (migration 246). A supplier publishes an opt-in profile (name, description,
 * place, categories; never prices or catalogue). Administrators of other companies search the listed profiles and
 * send a connection request. The supplier accepts it for one of its own B2B accounts: that creates an ordinary
 * network invitation (b2b_link_invitations, as POST /api/b2b/accounts/:id/network-invite) addressed to the
 * requesting administrator, and the requester connects through the existing POST /api/b2b/network/accept. The
 * one-time token is never stored: it is an HMAC of the invitation id under the installation key, handed only to
 * the addressed administrator of the requesting company. Prices stay invisible until the link exists. */
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { localConfig, pool, tenantReadTx, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { tokenHash } from './security';

type Querier = Pick<PoolClient, 'query'>;
let installed = false;
export async function supplierDirectoryInstalled(c: Querier): Promise<boolean> {
  if (!installed)
    installed = (await c.query("SELECT to_regclass('public.b2b254_directory_profiles') IS NOT NULL AND to_regclass('public.b2b254_directory_requests') IS NOT NULL AS ok")).rows[0]?.ok === true;
  return installed;
}
async function requireInstalled(c: Querier) {
  ensure(await supplierDirectoryInstalled(c), 409, 'Katalog dostawców wymaga migracji 246; ta kopia bazy jej nie ma');
}
const adminOnly = (a: Actor) => ensure(a.role === 'admin', 403, 'Katalog dostawców obsługuje administrator');
/** The invitation's one-time token, recomputable only by the server. 64 hex characters like a random token. */
export function directoryInvitationToken(invitationId: string): string {
  return createHmac('sha256', localConfig.encryptionKey).update('b2b254-directory-invitation\0' + invitationId).digest('hex');
}

const text = (max: number) => z.string().trim().max(max);
export const directoryProfileInput = z.strictObject({
  display_name: z.string().trim().min(2).max(120),
  description: text(2000).default(''),
  city: text(100).default(''),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase()).default('PL'),
  categories: z.array(z.string().trim().min(1).max(40)).max(10).default([]).refine((xs) => new Set(xs.map((x) => x.toLowerCase())).size === xs.length, 'Kategorie muszą być różne'),
  listed: z.boolean(),
  version: z.number().int().min(0),
  confirmed: z.literal(true),
});
export const directoryRequestInput = z.strictObject({
  supplier_tenant_id: z.uuid(),
  client_key: z.uuid(),
  message: text(1000).default(''),
  confirmed: z.literal(true),
});
export const directoryAcceptInput = z.strictObject({ account_id: z.uuid(), version: z.number().int().positive(), confirmed: z.literal(true) });
const confirmOnly = z.strictObject({ confirmed: z.literal(true) });
const searchQuery = z.strictObject({ search: z.string().trim().max(100).default(''), after: z.string().max(400).optional() });
const params = z.object({ id: z.uuid() });

const publicProfile = (p: any) => ({ tenant_id: p.tenant_id, display_name: p.display_name, description: p.description, city: p.city, country: p.country, categories: p.categories });
const ownProfile = (p: any) => ({ ...publicProfile(p), listed: p.listed, version: p.version, updated_at: p.updated_at });
const requestView = (r: any, side: 'outgoing' | 'incoming') => ({
  id: r.id, state: r.state, supplier_tenant_id: r.supplier_tenant_id, supplier_name: r.supplier_name, requester_name: r.requester_name,
  message: r.message, created_at: r.created_at, decided_at: r.decided_at,
  ...(side === 'incoming' ? { recipient_email: r.recipient_email, account_id: r.account_id } : {}),
});
type Cursor = { n: string; id: string };
const cursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function uncursor(s: string): Cursor {
  try {
    return z.strictObject({ n: z.string().max(120), id: z.uuid() }).parse(JSON.parse(Buffer.from(s, 'base64url').toString('utf8')));
  } catch {
    throw new Problem(422, 'Niepoprawny kursor katalogu dostawców');
  }
}
async function actorEmail(userId: string): Promise<string> {
  // users is not tenant data; read like POST /api/b2b/network/accept does.
  const u = (await pool.query('SELECT email FROM users WHERE id=$1', [userId])).rows[0];
  ensure(u, 401, 'Zaloguj się ponownie');
  return String(u.email).toLowerCase();
}
async function asTenant(c: PoolClient, tenantId: string) {
  await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
}

async function saveProfile(c: PoolClient, a: Actor, body: unknown) {
  adminOnly(a);
  const b = directoryProfileInput.parse(body);
  await requireInstalled(c);
  const old = (await c.query('SELECT * FROM b2b254_directory_profiles WHERE tenant_id=$1 FOR UPDATE', [a.tenantId])).rows[0];
  if (!old) {
    ensure(b.version === 0, 409, 'Profil zmienił się; odśwież dane');
    await c.query(
      'INSERT INTO b2b254_directory_profiles(tenant_id,display_name,description,city,country,categories,listed,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [a.tenantId, b.display_name, b.description, b.city, b.country, b.categories, b.listed, a.userId],
    );
  } else {
    ensure(b.version === old.version, 409, 'Profil zmienił się; odśwież dane');
    await c.query(
      'UPDATE b2b254_directory_profiles SET display_name=$2,description=$3,city=$4,country=$5,categories=$6,listed=$7,updated_by=$8,version=version+1,updated_at=now() WHERE tenant_id=$1',
      [a.tenantId, b.display_name, b.description, b.city, b.country, b.categories, b.listed, a.userId],
    );
  }
  await audit(c, a, old ? 'b2b.directory.profile_updated' : 'b2b.directory.profile_created', a.tenantId, { listed: b.listed, was_listed: old?.listed ?? null });
  return { available: true, profile: ownProfile((await c.query('SELECT * FROM b2b254_directory_profiles WHERE tenant_id=$1', [a.tenantId])).rows[0]) };
}

async function createRequest(c: PoolClient, a: Actor, body: unknown) {
  adminOnly(a);
  const b = directoryRequestInput.parse(body);
  await requireInstalled(c);
  const email = await actorEmail(a.userId);
  const replay = (await c.query('SELECT * FROM b2b254_directory_requests WHERE tenant_id=$1 AND client_key=$2', [a.tenantId, b.client_key])).rows[0];
  if (replay) {
    ensure(replay.supplier_tenant_id === b.supplier_tenant_id && replay.message === b.message, 409, 'Klucz prośby użyto z inną treścią');
    return { request: requestView(replay, 'outgoing'), reused: true };
  }
  ensure(b.supplier_tenant_id !== a.tenantId, 422, 'Nie można wysłać prośby do własnej firmy');
  // directory_read: only a listed profile is visible from another company.
  const p = (await c.query('SELECT * FROM b2b254_directory_profiles WHERE tenant_id=$1 AND listed', [b.supplier_tenant_id])).rows[0];
  ensure(p && p.tenant_id !== a.tenantId, 404, 'Dostawca nie jest widoczny w katalogu');
  ensure(!(await c.query('SELECT 1 FROM b2b_links WHERE tenant_id=$1 AND supplier_tenant_id=$2 LIMIT 1', [a.tenantId, b.supplier_tenant_id])).rowCount, 409, 'Masz już połączenie z tym dostawcą');
  ensure(!(await c.query("SELECT 1 FROM b2b254_directory_requests WHERE tenant_id=$1 AND supplier_tenant_id=$2 AND state='pending'", [a.tenantId, b.supplier_tenant_id])).rowCount, 409, 'Prośba do tego dostawcy już czeka na odpowiedź');
  const name = (await c.query('SELECT name FROM tenants WHERE id=$1', [a.tenantId])).rows[0].name as string;
  const id = randomUUID();
  const row = (await c.query(
    'INSERT INTO b2b254_directory_requests(id,tenant_id,supplier_tenant_id,client_key,requester_name,supplier_name,recipient_email,message,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [id, a.tenantId, b.supplier_tenant_id, b.client_key, name.slice(0, 200), p.display_name, email, b.message, a.userId],
  )).rows[0];
  await audit(c, a, 'b2b.directory.requested', id, { supplier_tenant_id: b.supplier_tenant_id });
  return { request: requestView(row, 'outgoing'), reused: false };
}

async function lockIncoming(c: PoolClient, a: Actor, id: string) {
  const r = (await c.query('SELECT * FROM b2b254_directory_requests WHERE id=$1 AND supplier_tenant_id=$2 FOR UPDATE', [id, a.tenantId])).rows[0];
  ensure(r, 404, 'Nie znaleziono prośby');
  return r;
}
async function decline(c: PoolClient, a: Actor, id: string) {
  adminOnly(a);
  await requireInstalled(c);
  const r = await lockIncoming(c, a, id);
  ensure(r.state === 'pending', 409, 'Prośba nie czeka już na decyzję');
  await c.query("UPDATE b2b254_directory_requests SET state='declined',decided_by=$2,decided_at=now(),updated_at=now() WHERE id=$1", [id, a.userId]);
  await audit(c, a, 'b2b.directory.declined', id, { requester_tenant_id: r.tenant_id });
  return { request: requestView({ ...r, state: 'declined', decided_at: new Date() }, 'incoming') };
}
async function accept(c: PoolClient, a: Actor, id: string, body: unknown) {
  adminOnly(a);
  const b = directoryAcceptInput.parse(body);
  await requireInstalled(c);
  const r = await lockIncoming(c, a, id);
  let again = false;
  if (r.state === 'accepted') {
    // The previous invitation lapsed (24 h) or was replaced before the requester connected: issue a new one.
    const prev = (await c.query('SELECT state,expires_at>now() live FROM b2b_link_invitations WHERE id=$1', [r.invitation_id])).rows[0];
    ensure(prev && prev.state !== 'accepted' && !(prev.state === 'pending' && prev.live), 409, 'Zaproszenie z tej prośby jest aktywne albo zostało przyjęte');
    again = true;
  } else ensure(r.state === 'pending', 409, 'Prośba nie czeka już na decyzję');
  const account = (await c.query('SELECT * FROM b2b_accounts WHERE id=$1 FOR UPDATE', [b.account_id])).rows[0];
  ensure(account?.active && account.version === b.version, 409, 'Zatwierdź aktualne, aktywne konto kontrahenta');
  ensure(!(await c.query("SELECT 1 FROM b2b_link_invitations WHERE account_id=$1 AND state='accepted'", [account.id])).rowCount, 409, 'Kontrahent ma już połączoną firmę');
  await c.query("UPDATE b2b_link_invitations SET state='revoked' WHERE account_id=$1 AND state='pending'", [account.id]);
  const invitation = randomUUID();
  await c.query(
    'INSERT INTO b2b_link_invitations(id,tenant_id,account_id,actor_id,recipient_email,token_hash,account_version) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [invitation, a.tenantId, account.id, a.userId, r.recipient_email, tokenHash(directoryInvitationToken(invitation)), account.version],
  );
  await c.query("UPDATE b2b254_directory_requests SET state='accepted',account_id=$2,invitation_id=$3,decided_by=$4,decided_at=now(),updated_at=now() WHERE id=$1", [id, account.id, invitation, a.userId]);
  await audit(c, a, 'b2b.network.invite', invitation, { account_id: account.id, recipient_email: r.recipient_email, directory_request_id: id });
  await audit(c, a, 'b2b.directory.accepted', id, { requester_tenant_id: r.tenant_id, account_id: account.id, invitation_id: invitation, reissued: again });
  return { request: requestView({ ...r, state: 'accepted', account_id: account.id, decided_at: new Date() }, 'incoming'), expires_hours: 24 };
}
async function withdraw(c: PoolClient, a: Actor, id: string) {
  adminOnly(a);
  await requireInstalled(c);
  const r = (await c.query('SELECT * FROM b2b254_directory_requests WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [id, a.tenantId])).rows[0];
  ensure(r, 404, 'Nie znaleziono prośby');
  ensure(r.state === 'pending', 409, 'Prośba nie czeka już na decyzję');
  await c.query("UPDATE b2b254_directory_requests SET state='withdrawn',decided_by=$2,decided_at=now(),updated_at=now() WHERE id=$1", [id, a.userId]);
  await audit(c, a, 'b2b.directory.withdrawn', id, { supplier_tenant_id: r.supplier_tenant_id });
  return { request: requestView({ ...r, state: 'withdrawn', decided_at: new Date() }, 'outgoing') };
}
/** The token for the existing accept route, only for the addressed administrator of the requesting company. */
async function invitationToken(c: PoolClient, a: Actor, id: string) {
  adminOnly(a);
  await requireInstalled(c);
  const email = await actorEmail(a.userId);
  const r = (await c.query('SELECT * FROM b2b254_directory_requests WHERE id=$1 AND tenant_id=$2', [id, a.tenantId])).rows[0];
  ensure(r, 404, 'Nie znaleziono prośby');
  ensure(r.state === 'accepted', 409, 'Dostawca jeszcze nie przyjął prośby');
  ensure(r.recipient_email === email, 403, 'Zaproszenie jest adresowane do administratora, który wysłał prośbę');
  await asTenant(c, r.supplier_tenant_id);
  const i = (await c.query("SELECT id FROM b2b_link_invitations WHERE id=$1 AND state='pending' AND expires_at>now()", [r.invitation_id])).rows[0];
  await asTenant(c, a.tenantId);
  ensure(i, 409, 'Zaproszenie wygasło lub zostało użyte; poproś dostawcę o ponowne przyjęcie');
  await audit(c, a, 'b2b.directory.invitation_opened', id, { invitation_id: i.id });
  return { token: directoryInvitationToken(i.id), accept_path: '/api/b2b/network/accept' };
}

export function registerB2bSupplierDirectoryRoutes(app: FastifyInstance): void {
  app.get('/api/b2b/directory/profile', (r: any) =>
    tenantReadTx(r.actor.tenantId, async (c) => {
      if (!(await supplierDirectoryInstalled(c))) return { available: false, profile: null };
      const p = (await c.query('SELECT * FROM b2b254_directory_profiles WHERE tenant_id=$1', [r.actor.tenantId])).rows[0];
      return { available: true, profile: p ? ownProfile(p) : null };
    }),
  );
  app.put('/api/b2b/directory/profile', (r: any) => {
    adminOnly(r.actor);
    return tenantTx(r.actor.tenantId, (c) => saveProfile(c, r.actor, r.body));
  });
  app.get('/api/b2b/directory', (r: any) =>
    tenantReadTx(r.actor.tenantId, async (c) => {
      const q = searchQuery.parse(r.query ?? {});
      if (!(await supplierDirectoryInstalled(c))) return { available: false, data: [], next: null };
      const after = q.after ? uncursor(q.after) : null;
      const rows = (await c.query(
        `SELECT p.*,(SELECT jsonb_build_object('id',x.id,'state',x.state) FROM b2b254_directory_requests x
            WHERE x.tenant_id=$1 AND x.supplier_tenant_id=p.tenant_id ORDER BY x.created_at DESC,x.id DESC LIMIT 1) AS request,
          EXISTS(SELECT 1 FROM b2b_links l WHERE l.tenant_id=$1 AND l.supplier_tenant_id=p.tenant_id) AS connected
         FROM b2b254_directory_profiles p
         WHERE p.listed AND p.tenant_id<>$1
           AND ($2='' OR strpos(lower(p.display_name||' '||p.description||' '||p.city||' '||array_to_string(p.categories,' ')),lower($2))>0)
           AND ($3::text IS NULL OR (lower(p.display_name),p.tenant_id)>($3,$4::uuid))
         ORDER BY lower(p.display_name),p.tenant_id LIMIT 26`,
        [r.actor.tenantId, q.search, after?.n ?? null, after?.id ?? null],
      )).rows;
      const page = rows.slice(0, 25);
      const last = page.at(-1);
      return {
        available: true,
        data: page.map((p) => ({ ...publicProfile(p), connected: p.connected, request: p.request })),
        next: rows.length > 25 && last ? cursor({ n: String(last.display_name).toLowerCase(), id: last.tenant_id }) : null,
      };
    }),
  );
  app.get('/api/b2b/directory/requests', (r: any) =>
    tenantReadTx(r.actor.tenantId, async (c) => {
      if (!(await supplierDirectoryInstalled(c))) return { available: false, outgoing: [], incoming: [] };
      const outgoing = (await c.query(
        `SELECT x.*,EXISTS(SELECT 1 FROM b2b_links l WHERE l.tenant_id=x.tenant_id AND l.supplier_tenant_id=x.supplier_tenant_id) AS connected
         FROM b2b254_directory_requests x WHERE x.tenant_id=$1 ORDER BY x.created_at DESC,x.id DESC LIMIT 50`,
        [r.actor.tenantId],
      )).rows;
      // The requester's contact e-mail is shown to the supplier's administrator only.
      const incoming = r.actor.role === 'admin'
        ? (await c.query('SELECT * FROM b2b254_directory_requests WHERE supplier_tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50', [r.actor.tenantId])).rows
        : [];
      return { available: true, outgoing: outgoing.map((x) => ({ ...requestView(x, 'outgoing'), connected: x.connected === true })), incoming: incoming.map((x) => requestView(x, 'incoming')) };
    }),
  );
  app.post('/api/b2b/directory/requests', (r: any) => {
    adminOnly(r.actor);
    return tenantTx(r.actor.tenantId, (c) => createRequest(c, r.actor, r.body));
  });
  const actions: [string, (c: PoolClient, a: Actor, id: string) => Promise<unknown>][] = [
    ['decline', decline],
    ['withdraw', withdraw],
    ['invitation', invitationToken],
  ];
  for (const [path, fn] of actions)
    app.post('/api/b2b/directory/requests/:id/' + path, (r: any) => {
      adminOnly(r.actor);
      confirmOnly.parse(r.body ?? {});
      const { id } = params.parse(r.params);
      return tenantTx(r.actor.tenantId, (c) => fn(c, r.actor, id));
    });
  app.post('/api/b2b/directory/requests/:id/accept', (r: any) => {
    adminOnly(r.actor);
    const { id } = params.parse(r.params);
    return tenantTx(r.actor.tenantId, (c) => accept(c, r.actor, id, r.body));
  });
}
