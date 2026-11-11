/** PayU payment sessions of the customer portal (migration 242, COM-PORTAL-6, docs/parity/PAYU242-20261027.md).
 * The buyer starts a session from the portal for the order's open balance, PayU confirms it with a signed
 * notification (or a status read when the notification was lost), and a COMPLETED session books exactly one
 * receipt through the existing payment path (appendPayment, client_key 'payu:<PayU orderId>'), so the order
 * card and the settlement report see it like any other payment. HTTP to PayU never runs inside a database
 * transaction: a session row is written first (create_started), PayU is called, then the result is stored. */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { localConfig, pool, tenantAppendTx, tenantReadTx, tenantTx } from './db';
import type { Actor } from './domain';
import { ensure, Problem } from './errors';
import { insertAuditEvent } from './audit-log';
import { appendPayment, advancePaid, paymentBalance } from './payments';
import { orderMergeOriginInTx } from './order-merge-guards';
import { decrypt, encrypt } from './security';
import { safeFetch, type Transport } from './integrations';
import { PayU, type PayuIdempotencyStore, type PayuOrderView, type PayuRefundView } from './payment-payu';
import { verifyPayuNotification, type PayuNotification } from './payment-payu-notify';
import { createPayuFake, type PayuFake } from './payment-payu-fake';
import { PAYU_MAX_NOTIFICATION_BYTES, type PayuMode } from './payment-payu-values';
import {
  decidePayu242,
  newPayu242Secret,
  payu242ConfigInput,
  payu242Currency,
  payu242PeerAllowed,
  payu242PublicOrigin,
  payu242Refundable,
  payu242ReturnSecretMatches,
  payu242SecretMatches,
  payu242Sha256,
  PAYU242_NOTIFY_IPS,
  PAYU242_OPEN,
  PAYU242_SESSION_SECONDS,
  PAYU242_TOKEN,
  type Payu242Observation,
  type Payu242Status,
} from './payu242-session';

// Production payments need a PayU production account and an approved public deployment; this local build
// never talks to secure.payu.com.
export const PAYU242_PRODUCTION_ENABLED = false;
/** Local simulation: every PayU call goes to the in-process fake (server/payment-payu-fake.ts), nothing leaves
 * the machine, and every booked payment says SYMULACJA. Only with DYNA_PAYU_FAKE=local. */
export const payu242Simulation = () => process.env.DYNA_PAYU_FAKE === 'local' && process.env.NODE_ENV !== 'production';
/** The SYMULACJA pay page address carries a key derived from the local encryption key, so fake PayU ids
 * (sequential in the fake) cannot be enumerated to "pay" someone else's order. */
export const payu242FakePageKey = (orderId: string) => createHmac('sha256', localConfig.encryptionKey).update('payu242-fake:' + orderId).digest('base64url');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let installed = false;
/** False on a restored copy older than 242: the portal shows no PayU button and the routes refuse. */
export async function payu242Available(c: Pick<PoolClient, 'query'> = pool): Promise<boolean> {
  if (!installed)
    installed = (await c.query("SELECT to_regclass('public.payu242_sessions') IS NOT NULL AND to_regclass('public.payu242_configs') IS NOT NULL AS ok")).rows[0]?.ok === true;
  return installed;
}

async function requireInstalled() {
  ensure(await payu242Available(), 409, 'Płatności PayU wymagają migracji 242; ta kopia bazy jej nie ma');
}
interface ConfigRow {
  tenant_id: string;
  id: string;
  environment: PayuMode;
  pos_id: string;
  client_id: string;
  public_origin: string;
  credentials: string;
  enabled: boolean;
  version: number;
  updated_at: Date;
}
interface Secrets {
  client_secret: string;
  second_key: string;
  notify_token: string;
}
interface SessionRow {
  id: string;
  tenant_id: string;
  order_id: string;
  config_id: string;
  environment: PayuMode;
  simulated: boolean;
  client_key: string;
  ext_order_id: string;
  amount: number;
  currency: 'PLN' | 'EUR';
  status: Payu242Status;
  phase: string;
  provider_order_id: string | null;
  redirect_uri: string | null;
  payment_id: string | null;
  receipt_entry_id: string | null;
  return_secret_sha256: string;
  review: string | null;
  expires_at: Date;
  completed_at: Date | null;
  created_at: Date;
}
interface RefundRow {
  id: string;
  session_id: string;
  order_id: string;
  ext_refund_id: string;
  amount: number;
  currency: string;
  status: string;
  provider_refund_id: string | null;
  refund_entry_id: string | null;
  review: string | null;
  created_at: Date;
}
function secretsOf(row: ConfigRow): Secrets {
  const s = decrypt(row.credentials);
  ensure(typeof s.client_secret === 'string' && typeof s.second_key === 'string' && PAYU242_TOKEN.test(s.notify_token ?? ''), 409,
    'Konfiguracja PayU jest niekompletna; zapisz ją ponownie');
  return { client_secret: s.client_secret, second_key: s.second_key, notify_token: s.notify_token };
}
const systemActor = (tenantId: string): Actor => ({ tenantId, userId: null as unknown as string, role: 'admin' });
const auditWriter = (a: Actor | null, tenantId: string) => a ?? { tenantId, userId: null };

// ---- transport and client --------------------------------------------------------------------------------
const fakes = new Map<string, { key: string; fake: PayuFake }>();
/** The simulated PayU of one configuration (tests and the local pay page drive it). */
export function payu242Fake(configId: string): PayuFake | undefined {
  return fakes.get(configId)?.fake;
}
export function payu242FakeOrder(orderId: string): { configId: string; fake: PayuFake } | undefined {
  for (const [configId, { fake }] of fakes) if (fake.orders.has(orderId)) return { configId, fake };
  return undefined;
}
// Creation is fenced by the session row written before the call (phase create_started); the client's own
// replay store is therefore not needed and stays empty.
const rowFencedStore: PayuIdempotencyStore = { claim: async () => ({ state: 'new' }), finish: async () => {}, release: async () => {} };
const clients = new Map<string, { key: string; client: PayU }>();
function clientFor(cfg: ConfigRow, secrets: Secrets): PayU {
  ensure(cfg.environment !== 'production' || PAYU242_PRODUCTION_ENABLED, 409, 'Tryb produkcyjny PayU jest wyłączony w tej instalacji');
  const key = payu242Sha256(JSON.stringify([cfg.environment, cfg.pos_id, cfg.client_id, secrets.client_secret, secrets.second_key, payu242Simulation()]));
  const cached = clients.get(cfg.id);
  if (cached?.key === key) return cached.client;
  let transport: Transport;
  if (payu242Simulation()) {
    let entry = fakes.get(cfg.id);
    if (!entry || entry.key !== key)
      fakes.set(cfg.id, (entry = { key, fake: createPayuFake({ mode: 'sandbox', posId: cfg.client_id, clientSecret: secrets.client_secret, secondKey: secrets.second_key, orderTag: randomBytes(5).toString('hex').toUpperCase().slice(0, 8) }) }));
    transport = entry.fake.transport;
  } else {
    // Tests never reach a real PayU: a sandbox account is a provider-side prerequisite (see the doc).
    ensure(process.env.DYNA_TEST !== 'true', 503, 'Połączenie z PayU jest wyłączone w testach; użyj symulacji DYNA_PAYU_FAKE=local');
    transport = safeFetch;
  }
  const client = new PayU(cfg.environment, { pos_id: cfg.pos_id, client_id: cfg.client_id }, { client_secret: secrets.client_secret }, transport, { store: rowFencedStore });
  clients.set(cfg.id, { key, client });
  return client;
}
// A refusal PayU gave before creating anything, versus an outcome we cannot know without a read.
const uncertain = (e: unknown) => !(e instanceof Problem) || e.status >= 500 || /^PAYU_(UNCERTAIN|TIMEOUT|RECONCILE|AMOUNT_MISMATCH)/.test(e.code ?? '');

// ---- configuration ---------------------------------------------------------------------------------------
async function configRow(c: Pick<PoolClient, 'query'>, lock = false): Promise<ConfigRow | null> {
  return (await c.query(`SELECT * FROM payu242_configs${lock ? ' FOR UPDATE' : ''}`)).rows[0] ?? null;
}
export function payu242ConfigView(row: ConfigRow | null) {
  const simulation = payu242Simulation();
  if (!row) return { configured: false, simulation, production_available: PAYU242_PRODUCTION_ENABLED };
  let secrets: Partial<Secrets> = {};
  try {
    secrets = decrypt(row.credentials);
  } catch {
    secrets = {};
  }
  return {
    configured: true,
    simulation,
    production_available: PAYU242_PRODUCTION_ENABLED,
    environment: row.environment,
    pos_id: row.pos_id,
    client_id: row.client_id,
    public_origin: row.public_origin,
    enabled: row.enabled,
    version: row.version,
    updated_at: row.updated_at,
    // Only whether a secret is stored; the values never leave the server.
    client_secret_set: typeof secrets.client_secret === 'string',
    second_key_set: typeof secrets.second_key === 'string',
    notify_url: row.public_origin + '/callbacks/payu/' + row.id + '/…',
  };
}
function requireConfigAdmin(a: Actor) {
  ensure(a.role === 'admin', 403, 'Konfiguracja PayU wymaga roli administratora');
  ensure(!a.apiKeyId, 403, 'Konfiguracja PayU jest dostępna tylko z sesji administratora, nie kluczem API');
}
export async function readPayu242Config(a: Actor) {
  requireConfigAdmin(a);
  await requireInstalled();
  return tenantReadTx(a.tenantId, async (c) => payu242ConfigView(await configRow(c)));
}
export async function savePayu242Config(a: Actor, body: unknown) {
  requireConfigAdmin(a);
  await requireInstalled();
  const r = payu242ConfigInput.safeParse(body);
  if (!r.success) throw new Problem(422, r.error.issues[0]?.message ?? 'Nieprawidłowa konfiguracja PayU');
  const b = r.data;
  ensure(b.environment !== 'production' || PAYU242_PRODUCTION_ENABLED, 422,
    'Tryb produkcyjny PayU jest wyłączony w tej lokalnej instalacji; użyj środowiska testowego (sandbox)');
  const origin = payu242PublicOrigin(b.public_origin, payu242Simulation());
  return tenantTx(a.tenantId, async (c) => {
    const old = await configRow(c, true);
    if (old) ensure(b.version === old.version, 409, 'Konfiguracja PayU zmieniła się; odśwież formularz');
    const prior: Partial<Secrets> = old ? decrypt(old.credentials) : {};
    const client_secret = b.client_secret ?? prior.client_secret, second_key = b.second_key ?? prior.second_key;
    ensure(client_secret && second_key, 422, 'Podaj client_secret i drugi klucz (MD5) z panelu PayU');
    const credentials = encrypt({ client_secret, second_key, notify_token: prior.notify_token ?? newPayu242Secret() });
    const row: ConfigRow = old
      ? (await c.query(
          'UPDATE payu242_configs SET environment=$1,pos_id=$2,client_id=$3,public_origin=$4,credentials=$5,enabled=$6,version=version+1,updated_by=$7,updated_at=now() RETURNING *',
          [b.environment, b.pos_id, b.client_id ?? b.pos_id, origin, credentials, b.enabled, a.userId],
        )).rows[0]
      : (await c.query(
          'INSERT INTO payu242_configs(tenant_id,id,environment,pos_id,client_id,public_origin,credentials,enabled,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [a.tenantId, randomUUID(), b.environment, b.pos_id, b.client_id ?? b.pos_id, origin, credentials, b.enabled, a.userId],
        )).rows[0];
    await insertAuditEvent(c, a, old ? 'payu.config.updated' : 'payu.config.created', row.id, {
      environment: row.environment, pos_id: row.pos_id, enabled: row.enabled, public_origin: row.public_origin,
      client_secret_changed: b.client_secret !== undefined, second_key_changed: b.second_key !== undefined,
    });
    return payu242ConfigView(row);
  });
}

// ---- views -----------------------------------------------------------------------------------------------
const refundView = (r: RefundRow) => ({
  id: r.id, amount: r.amount, currency: r.currency, status: r.status, provider_refund_id: r.provider_refund_id,
  refund_entry_id: r.refund_entry_id, review: r.review, created_at: r.created_at,
});
function sessionView(s: SessionRow, refunds: RefundRow[] = []) {
  return {
    id: s.id, status: s.status, phase: s.phase, amount: s.amount, currency: s.currency, environment: s.environment,
    simulated: s.simulated, provider_order_id: s.provider_order_id, payment_id: s.payment_id,
    receipt_entry_id: s.receipt_entry_id, review: s.review, expires_at: s.expires_at, completed_at: s.completed_at,
    created_at: s.created_at, refunds: refunds.filter((r) => r.session_id === s.id).map(refundView),
    refundable: s.status === 'COMPLETED' && s.receipt_entry_id ? payu242Refundable(s.amount, refunds.filter((r) => r.session_id === s.id)) : 0,
  };
}
export async function listPayu242Sessions(a: Actor, orderId: string) {
  await requireInstalled();
  return tenantReadTx(a.tenantId, async (c) => {
    ensure((await c.query('SELECT 1 FROM orders WHERE id=$1', [orderId])).rowCount, 404, 'Nie znaleziono zamówienia');
    const sessions: SessionRow[] = (await c.query('SELECT * FROM payu242_sessions WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50', [orderId])).rows;
    const refunds: RefundRow[] = (await c.query('SELECT * FROM payu242_refunds WHERE order_id=$1 ORDER BY created_at', [orderId])).rows;
    const cfg = await configRow(c);
    // What may still go back is also bounded by the order-wide overpayment less refunds on their way out.
    const inFlight = refunds.filter((r) => !r.refund_entry_id && ['started', 'PENDING', 'FINALIZED'].includes(r.status)).reduce((sum, r) => sum + r.amount, 0);
    const available = Math.max(0, (await paymentBalance(c, orderId)).overpayment - inFlight);
    return { configured: Boolean(cfg?.enabled), data: sessions.map((s) => { const v = sessionView(s, refunds); return { ...v, refundable: Math.min(v.refundable, available) }; }) };
  });
}

// ---- booking (inside the caller's transaction, order row locked) -----------------------------------------
async function lockOrder(c: PoolClient, orderId: string) {
  const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  return o;
}
async function bookReceipt(c: PoolClient, s: SessionRow, paymentId: string | null): Promise<string> {
  const key = 'payu:' + s.provider_order_id;
  const prior = (await c.query('SELECT id FROM payment_entries WHERE order_id=$1 AND client_key=$2', [s.order_id, key])).rows[0];
  if (prior) return prior.id;
  const o = (await c.query('SELECT currency FROM orders WHERE id=$1', [s.order_id])).rows[0];
  ensure(o?.currency === s.currency, 409, 'Waluta zamówienia różni się od waluty płatności PayU');
  const a = systemActor(s.tenant_id);
  const entry = await appendPayment(c, a, s.order_id, key,
    { provider: 'payu', session_id: s.id, provider_order_id: s.provider_order_id, payment_id: paymentId },
    {
      kind: 'receipt', amount: s.amount, currency: s.currency, method: 'payu',
      reference: ((s.simulated ? 'PayU SYMULACJA ' : 'PayU ') + (paymentId ?? s.provider_order_id)).slice(0, 200),
      note: s.simulated ? 'Symulacja lokalna PayU, bez prawdziwej płatności' : '',
    });
  await advancePaid(c, a, s.order_id);
  return entry;
}
/** A Problem from the payment path (e.g. a shipment write in progress) must not lose PayU's answer: the session
 * keeps COMPLETED with review booking_refused and the next status read retries. Other errors abort. */
async function tryBook(c: PoolClient, s: SessionRow, paymentId: string | null): Promise<string | null> {
  await c.query('SAVEPOINT payu242_book');
  try {
    const entry = await bookReceipt(c, s, paymentId);
    await c.query('RELEASE SAVEPOINT payu242_book');
    return entry;
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
    await c.query('ROLLBACK TO SAVEPOINT payu242_book');
    return null;
  }
}
type ApplyOutcome = 'applied' | 'booked' | 'duplicate' | 'ignored_terminal' | 'ignored_out_of_order' | 'conflict' | 'amount_mismatch' | 'foreign' | 'booking_refused';
/** One PayU observation (signed notification or status read) under the order and session locks. */
async function applyObservation(c: PoolClient, s: SessionRow, o: Payu242Observation, by: Actor | null): Promise<{ outcome: ApplyOutcome; session: SessionRow }> {
  const d = decidePayu242({ extOrderId: s.ext_order_id, providerOrderId: s.provider_order_id, amount: s.amount, currency: s.currency, status: s.status }, o);
  const update = async (sql: string, values: unknown[]) => (await c.query(`UPDATE payu242_sessions SET ${sql},updated_at=now() WHERE id=$1 RETURNING *`, [s.id, ...values])).rows[0] as SessionRow;
  if (d.outcome === 'conflict' || d.outcome === 'amount_mismatch') {
    const next = await update('review=$2', [d.review]);
    await insertAuditEvent(c, auditWriter(by, s.tenant_id), 'payu.session.review', s.order_id, { session_id: s.id, review: d.review, observed: o.status });
    return { outcome: d.outcome, session: next };
  }
  // A session whose create answer was lost learns its PayU id from the first matching observation.
  if (!s.provider_order_id && d.outcome !== 'foreign') s = await update('provider_order_id=$2', [o.orderId]);
  if (d.outcome === 'duplicate' && s.status === 'COMPLETED' && !s.receipt_entry_id) {
    // An earlier booking was refused; PayU's repeat (or a status read) tries again.
    const entry = await tryBook(c, s, s.payment_id ?? o.paymentId);
    if (!entry) return { outcome: 'booking_refused', session: s };
    return { outcome: 'booked', session: await update('receipt_entry_id=$2,review=NULL', [entry]) };
  }
  if (d.outcome !== 'apply') return { outcome: d.outcome, session: s };
  let next = await update(
    "status=$2,provider_order_id=coalesce(provider_order_id,$3),payment_id=coalesce($4,payment_id),completed_at=CASE WHEN $2='COMPLETED' THEN now() ELSE completed_at END",
    [d.status, d.providerOrderId, d.paymentId],
  );
  if (!d.book) return { outcome: 'applied', session: next };
  const entry = await tryBook(c, next, next.payment_id);
  if (!entry) {
    next = await update("review='booking_refused'", []);
    await insertAuditEvent(c, auditWriter(by, s.tenant_id), 'payu.session.review', s.order_id, { session_id: s.id, review: 'booking_refused' });
    return { outcome: 'booking_refused', session: next };
  }
  next = await update('receipt_entry_id=$2,review=NULL', [entry]);
  await insertAuditEvent(c, auditWriter(by, s.tenant_id), 'payu.payment.completed', s.order_id, {
    session_id: s.id, entry_id: entry, amount: s.amount, currency: s.currency, provider_order_id: next.provider_order_id, simulated: s.simulated,
  });
  return { outcome: 'booked', session: next };
}
async function bookRefund(c: PoolClient, r: RefundRow, s: SessionRow): Promise<string | null> {
  await c.query('SAVEPOINT payu242_refund');
  try {
    const key = 'payu-refund:' + r.provider_refund_id;
    const prior = (await c.query('SELECT id FROM payment_entries WHERE order_id=$1 AND client_key=$2', [r.order_id, key])).rows[0];
    let entry: string = prior?.id;
    if (!entry) {
      const b = await paymentBalance(c, r.order_id);
      ensure(r.amount <= b.overpayment, 422, 'Zwrot przekracza środki dostępne do oddania');
      entry = await appendPayment(c, systemActor(s.tenant_id), r.order_id, key,
        { provider: 'payu', refund_id: r.id, provider_refund_id: r.provider_refund_id, session_id: s.id },
        { kind: 'refund', amount: r.amount, currency: r.currency, method: 'payu', reference: ((s.simulated ? 'PayU SYMULACJA zwrot ' : 'PayU zwrot ') + r.provider_refund_id).slice(0, 200) });
    }
    await c.query('RELEASE SAVEPOINT payu242_refund');
    return entry;
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
    await c.query('ROLLBACK TO SAVEPOINT payu242_refund');
    return null;
  }
}
type RefundObservation = { refundId: string; extRefundId: string | null; status: 'PENDING' | 'FINALIZED' | 'CANCELED'; amount: number; currency: string };
async function applyRefund(c: PoolClient, r: RefundRow, s: SessionRow, o: RefundObservation, by: Actor | null): Promise<'refund_applied' | 'refund_booked' | 'refund_duplicate' | 'foreign' | 'booking_refused'> {
  if ((o.extRefundId !== null && o.extRefundId !== r.ext_refund_id) || (r.provider_refund_id !== null && r.provider_refund_id !== o.refundId) || o.amount !== r.amount || o.currency !== r.currency)
    return 'foreign';
  const final = ['FINALIZED', 'CANCELED', 'refused'].includes(r.status);
  if (final && !(r.status === 'FINALIZED' && !r.refund_entry_id)) return 'refund_duplicate';
  let row: RefundRow = (await c.query("UPDATE payu242_refunds SET status=$2,provider_refund_id=coalesce(provider_refund_id,$3),updated_at=now() WHERE id=$1 RETURNING *", [r.id, final ? r.status : o.status, o.refundId])).rows[0];
  if (row.status !== 'FINALIZED') return 'refund_applied';
  const entry = await bookRefund(c, row, s);
  if (!entry) {
    await c.query("UPDATE payu242_refunds SET review='booking_refused',updated_at=now() WHERE id=$1", [r.id]);
    return 'booking_refused';
  }
  row = (await c.query('UPDATE payu242_refunds SET refund_entry_id=$2,review=NULL,updated_at=now() WHERE id=$1 RETURNING *', [r.id, entry])).rows[0];
  await insertAuditEvent(c, auditWriter(by, s.tenant_id), 'payu.refund.finalized', r.order_id, { refund_id: r.id, entry_id: entry, amount: r.amount, currency: r.currency });
  return 'refund_booked';
}

// ---- portal ----------------------------------------------------------------------------------------------
export interface Payu242PortalOffer {
  available: boolean;
  pending: boolean;
  last_status: Payu242Status | null;
}
/** Whether the portal shows „Zapłać”: PayU configured and enabled for the shop, a prepaid sale with an open
 * balance in PLN/EUR, and a writable, current link. Read inside the portal's own transaction. */
export async function payu242PortalOffer(c: PoolClient, i: { orderId: string; order: { status: string; currency: string; fulfillment_kind?: string | null }; balance: { payment_mode: string; amount_due: number }; writable: boolean }): Promise<Payu242PortalOffer> {
  if (!(await payu242Available(c))) return { available: false, pending: false, last_status: null };
  const cfg = await configRow(c);
  const last: SessionRow | undefined = (await c.query('SELECT status FROM payu242_sessions WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [i.orderId])).rows[0];
  const held = await unresolvedPayment(c, i.orderId);
  const pending = held || Boolean(last && PAYU242_OPEN.has(last.status));
  const available = !held && Boolean(cfg?.enabled) && (cfg!.environment !== 'production' || PAYU242_PRODUCTION_ENABLED) && i.writable &&
    i.balance.payment_mode === 'prepaid' && i.balance.amount_due > 0 && payu242Currency(i.order.currency) !== null &&
    i.order.fulfillment_kind !== 'replacement' && i.order.status !== 'cancelled';
  return { available, pending, last_status: last?.status ?? null };
}
/** PayU reported money that is not booked yet (booking refused, or COMPLETED after CANCELED): the buyer is not
 * asked to pay again until the seller resolves it. */
async function unresolvedPayment(c: PoolClient, orderId: string): Promise<boolean> {
  return Boolean((await c.query("SELECT 1 FROM payu242_sessions WHERE order_id=$1 AND ((status='COMPLETED' AND receipt_entry_id IS NULL) OR review='completed_after_canceled') LIMIT 1", [orderId])).rowCount);
}
const clientKeyInput = z.strictObject({ client_key: z.uuid() });
type Prepared =
  | { kind: 'ready'; session: SessionRow; reused: boolean }
  | { kind: 'reconcile'; sessionId: string }
  | { kind: 'create'; session: SessionRow; cfg: ConfigRow; secrets: Secrets; returnSecret: string; number: string; email: string };
async function preparePortalSession(c: PoolClient, orderId: string, token: string, clientKey: string): Promise<Prepared> {
  // Link re-checked under the order lock, as the portal's return intake does; a stale link cannot win a race.
  const o = await lockOrder(c, orderId);
  ensure(o.portal_token === token && o.portal_enabled && (!o.portal_expires_at || o.portal_expires_at > new Date()), 404, 'Nie znaleziono aktywnego linku zamówienia');
  const origin = await orderMergeOriginInTx(c, orderId);
  ensure(origin?.header.portal_token !== token, 409, 'Ten link przedstawia pierwotne zamówienie. Płatność obsługuje sprzedawca.');
  const replay: SessionRow | undefined = (await c.query('SELECT * FROM payu242_sessions WHERE client_key=$1', [clientKey])).rows[0];
  if (replay) {
    ensure(replay.order_id === orderId, 409, 'Ten klucz próby użyto już dla innego zamówienia');
    return { kind: 'ready', session: replay, reused: true };
  }
  const cfg = await configRow(c);
  ensure(cfg?.enabled && (cfg.environment !== 'production' || PAYU242_PRODUCTION_ENABLED), 409, 'Płatność online nie jest dostępna dla tego sklepu');
  ensure(o.payment_mode === 'prepaid', 409, 'To zamówienie jest płatne przy odbiorze');
  ensure(o.fulfillment_kind !== 'replacement' && o.status !== 'cancelled', 409, 'Tego zamówienia nie można opłacić online');
  const currency = payu242Currency(o.currency);
  ensure(currency, 409, 'Płatność PayU jest możliwa w PLN i EUR');
  const due = (await paymentBalance(c, orderId)).amount_due;
  ensure(Number.isSafeInteger(due) && due > 0, 409, 'Zamówienie nie ma kwoty do zapłaty');
  ensure(z.email().max(255).safeParse(o.email).success, 409, 'Brak poprawnego adresu e-mail kupującego; skontaktuj się ze sprzedawcą');
  ensure(!(await unresolvedPayment(c, orderId)), 409, 'Płatność PayU tego zamówienia czeka na wyjaśnienie przez sprzedawcę. Nie płać ponownie.');
  const open: SessionRow | undefined = (await c.query("SELECT * FROM payu242_sessions WHERE order_id=$1 AND status IN ('NEW','PENDING','WAITING_FOR_CONFIRMATION') FOR UPDATE", [orderId])).rows[0];
  if (open) {
    if (open.status === 'NEW' && open.phase === 'created' && open.redirect_uri && open.expires_at > new Date() && open.amount === due && open.currency === currency)
      return { kind: 'ready', session: open, reused: true };
    if (open.status !== 'NEW') throw new Problem(409, 'Płatność PayU jest w toku. Poczekaj na jej potwierdzenie.');
    return { kind: 'reconcile', sessionId: open.id };
  }
  const id = randomUUID(), returnSecret = newPayu242Secret();
  const session: SessionRow = (await c.query(
    `INSERT INTO payu242_sessions(id,tenant_id,order_id,config_id,environment,simulated,client_key,ext_order_id,amount,currency,request_sha256,return_secret_sha256,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+make_interval(secs=>$13)) RETURNING *`,
    [id, o.tenant_id, orderId, cfg!.id, cfg!.environment, payu242Simulation(), clientKey, id, due, currency,
      payu242Sha256(JSON.stringify({ order: orderId, amount: due, currency, config: cfg!.id, version: cfg!.version })),
      payu242Sha256(returnSecret), PAYU242_SESSION_SECONDS],
  )).rows[0];
  await insertAuditEvent(c, { tenantId: o.tenant_id, userId: null }, 'payu.session.started', orderId, { session_id: id, amount: due, currency, simulated: session.simulated });
  return { kind: 'create', session, cfg: cfg!, secrets: secretsOf(cfg!), returnSecret, number: String(o.number), email: o.email };
}
/** The buyer's browser goes to PayU's pay page; under the local simulation to the local SYMULACJA page. */
function buyerRedirect(s: SessionRow): string | null {
  if (!s.redirect_uri || s.status !== 'NEW') return null;
  return s.simulated ? '/payu-fake/pay/' + s.provider_order_id + '?k=' + payu242FakePageKey(s.provider_order_id!) : s.redirect_uri;
}
const portalAnswer = (s: SessionRow, reused: boolean) => ({ session_id: s.id, status: s.status, amount: s.amount, currency: s.currency, redirect: buyerRedirect(s), reused });
async function resolvePortalToken(token: string) {
  ensure(/^[a-f0-9]{48}$/.test(token), 404, 'Nie znaleziono aktywnego linku zamówienia');
  const o = (await pool.query('SELECT id,tenant_id FROM orders WHERE portal_token=$1 AND portal_enabled AND (portal_expires_at IS NULL OR portal_expires_at>now())', [token])).rows[0];
  ensure(o, 404, 'Nie znaleziono aktywnego linku zamówienia');
  return o as { id: string; tenant_id: string };
}
/** POST /api/public/orders/:token/payments/payu — the amount is the server's open balance, never the buyer's. */
export async function startPayu242PortalPayment(token: string, body: unknown, peer: string | undefined) {
  ensure(await payu242Available(), 409, 'Płatność online nie jest dostępna');
  const { client_key } = clientKeyInput.parse(body);
  const ref = await resolvePortalToken(token);
  for (let round = 0; round < 2; round++) {
    const step = await tenantTx(ref.tenant_id, (c) => preparePortalSession(c, ref.id, token, client_key));
    if (step.kind === 'ready') return portalAnswer(step.session, step.reused);
    if (step.kind === 'reconcile') {
      await reconcilePayu242Session(ref.tenant_id, step.sessionId, null, true);
      continue;
    }
    return createAtPayu(step, peer);
  }
  throw new Problem(409, 'Poprzednia płatność PayU jest jeszcze w toku. Spróbuj ponownie za kilka minut.');
}
async function createAtPayu(step: Extract<Prepared, { kind: 'create' }>, peer: string | undefined) {
  const { session: s, cfg, secrets } = step;
  const ip = peer?.startsWith('::ffff:') ? peer.slice(7) : peer;
  // PayU requires HTTPS addresses; under the local simulation (HTTP loopback origin) the fake never calls
  // them and its pay page returns the buyer by path only.
  const https = cfg.public_origin.replace(/^http:/, 'https:');
  const client = clientFor(cfg, secrets);
  const update = (sql: string, values: unknown[]) =>
    tenantTx(s.tenant_id, async (c) => (await c.query(`UPDATE payu242_sessions SET ${sql},updated_at=now() WHERE id=$1 RETURNING *`, [s.id, ...values])).rows[0] as SessionRow);
  let created;
  try {
    created = await client.createOrder({
      extOrderId: s.ext_order_id,
      description: ('Zamówienie ' + step.number).slice(0, 255),
      currency: s.currency,
      amount: s.amount,
      customerIp: ip && ip.length <= 45 ? ip : '127.0.0.1',
      notifyUrl: https + '/callbacks/payu/' + cfg.id + '/' + secrets.notify_token,
      continueUrl: https + '/payu/return/' + s.id + '?s=' + step.returnSecret,
      // Data minimisation: e-mail and language only; the products line names the order, not the goods.
      buyer: { email: step.email, language: 'pl' },
      products: [{ name: ('Zamówienie ' + step.number).slice(0, 255), unitPrice: s.amount, quantity: 1 }],
      validitySeconds: PAYU242_SESSION_SECONDS,
    });
  } catch (e) {
    if (uncertain(e))
      throw new Problem(503, 'Nie udało się potwierdzić płatności w PayU. Spróbuj ponownie za chwilę; nie zapłacisz dwa razy.', 'PAYU242_UNCERTAIN');
    await update("status='REJECTED',phase='refused'", []);
    throw new Problem(502, 'PayU odrzucił utworzenie płatności. Skontaktuj się ze sprzedawcą.', 'PAYU242_REFUSED');
  }
  if (!created.redirectUri) {
    // Recovered by a read after a lost answer: PayU gives no pay link on reads, so this attempt is cancelled.
    await update("provider_order_id=coalesce(provider_order_id,$2),phase='recovered'", [created.orderId]);
    await reconcilePayu242Session(s.tenant_id, s.id, null, true);
    throw new Problem(409, 'Płatności nie udało się rozpocząć. Spróbuj ponownie.');
  }
  const next = await update(
    "provider_order_id=coalesce(provider_order_id,$2),redirect_uri=$3,phase='created'",
    [created.orderId, created.redirectUri],
  ).catch((e) => {
    // The PayU orderId is already bound to another session of this shop: never reuse it for this one.
    if ((e as { code?: string }).code === '23505') throw new Problem(409, 'PayU zwrócił płatność przypisaną do innej próby; skontaktuj się ze sprzedawcą', 'PAYU242_FOREIGN_ORDER');
    throw e;
  });
  ensure(next.provider_order_id === created.orderId, 409, 'PayU zwrócił inną płatność niż zapisana; skontaktuj się ze sprzedawcą');
  return portalAnswer(next, false);
}

// ---- status read (lost notification, expired attempt, operator's „Sprawdź w PayU”) --------------------
export async function reconcilePayu242Session(tenantId: string, sessionId: string, by: Actor | null, cancelOpen = false) {
  const loaded = await tenantReadTx(tenantId, async (c) => {
    const s: SessionRow | undefined = (await c.query('SELECT * FROM payu242_sessions WHERE id=$1', [sessionId])).rows[0];
    ensure(s, 404, 'Nie znaleziono płatności PayU');
    const cfg = (await c.query('SELECT * FROM payu242_configs WHERE id=$1', [s.config_id])).rows[0] as ConfigRow | undefined;
    ensure(cfg, 409, 'Brak konfiguracji PayU tej płatności');
    const refunds: RefundRow[] = (await c.query("SELECT * FROM payu242_refunds WHERE session_id=$1 AND (status IN ('started','PENDING') OR (status='FINALIZED' AND refund_entry_id IS NULL))", [sessionId])).rows;
    return { s, cfg, refunds };
  });
  const { s, cfg } = loaded;
  const client = clientFor(cfg, secretsOf(cfg));
  let view: PayuOrderView | null = null;
  if (s.provider_order_id) view = await client.order(s.provider_order_id);
  else if (s.phase === 'create_started') {
    const found = await client.ordersByExtOrderId(s.ext_order_id);
    ensure(found.length <= 1, 409, 'PayU ma kilka płatności dla tej sesji; wymagane ręczne uzgodnienie');
    view = found[0] ?? null;
  }
  const expired = s.expires_at.getTime() < Date.now();
  // Only an attempt the buyer has not started paying is cancelled (NEW at PayU): a PENDING one may still pay.
  if (view && (cancelOpen || expired) && view.status === 'NEW' && s.status === 'NEW') {
    try {
      await client.cancel(view.orderId);
    } catch (e) {
      if (!(e instanceof Problem)) throw e;
    }
    view = await client.order(view.orderId);
  }
  const refundViews: { r: RefundRow; v: PayuRefundView }[] = [];
  if (loaded.refunds.length && s.provider_order_id) {
    const list = await client.refunds(s.provider_order_id);
    for (const r of loaded.refunds) {
      const v = list.find((x) => (r.provider_refund_id && x.refundId === r.provider_refund_id) || x.extRefundId === r.ext_refund_id);
      if (v) refundViews.push({ r, v });
    }
  }
  return tenantTx(tenantId, async (c) => {
    await lockOrder(c, s.order_id);
    let cur: SessionRow = (await c.query('SELECT * FROM payu242_sessions WHERE id=$1 FOR UPDATE', [sessionId])).rows[0];
    let outcome: string = 'unchanged';
    if (view) {
      const r = await applyObservation(c, cur, { orderId: view.orderId, extOrderId: view.extOrderId, status: view.status as Payu242Observation['status'], amount: view.amount, currency: view.currency, paymentId: view.paymentId }, by);
      cur = r.session;
      outcome = r.outcome;
      if (cur.phase === 'create_started') cur = (await c.query("UPDATE payu242_sessions SET phase='recovered',updated_at=now() WHERE id=$1 RETURNING *", [sessionId])).rows[0];
    } else if (cur.phase === 'create_started' && cur.status === 'NEW' && (expired || cur.created_at.getTime() < Date.now() - 120_000)) {
      // PayU has no order for this attempt: it can never be paid, a new click starts a new extOrderId.
      cur = (await c.query("UPDATE payu242_sessions SET status='REJECTED',phase='absent',updated_at=now() WHERE id=$1 RETURNING *", [sessionId])).rows[0];
      outcome = 'absent';
    }
    for (const { r, v } of refundViews) {
      const row: RefundRow = (await c.query('SELECT * FROM payu242_refunds WHERE id=$1 FOR UPDATE', [r.id])).rows[0];
      await applyRefund(c, row, cur, { refundId: v.refundId, extRefundId: v.extRefundId, status: v.status, amount: v.amount, currency: v.currency }, by);
    }
    if (by) await insertAuditEvent(c, by, 'payu.session.reconciled', s.order_id, { session_id: sessionId, outcome, status: cur.status });
    const refunds: RefundRow[] = (await c.query('SELECT * FROM payu242_refunds WHERE session_id=$1 ORDER BY created_at', [sessionId])).rows;
    return { outcome, session: sessionView(cur, refunds) };
  });
}
export async function reconcilePayu242ForOrder(a: Actor, orderId: string, sessionId: string) {
  await requireInstalled();
  ensure(a.role !== 'viewer', 403, 'Konto ma uprawnienia tylko do odczytu');
  const owned = await tenantReadTx(a.tenantId, async (c) => (await c.query('SELECT 1 FROM payu242_sessions WHERE id=$1 AND order_id=$2', [sessionId, orderId])).rowCount);
  ensure(owned, 404, 'Nie znaleziono płatności PayU tego zamówienia');
  return reconcilePayu242Session(a.tenantId, sessionId, a);
}

// ---- refunds ---------------------------------------------------------------------------------------------
const refundInput = z.strictObject({ client_key: z.uuid(), amount: z.number().int().min(1).max(999_999_999), confirmed: z.literal(true) });
export async function startPayu242Refund(a: Actor, orderId: string, sessionId: string, body: unknown) {
  await requireInstalled();
  ensure(a.role === 'admin', 403, 'Zwrot PayU wymaga roli administratora');
  const b = refundInput.parse(body);
  const step = await tenantTx(a.tenantId, async (c) => {
    const o = await lockOrder(c, orderId);
    const s: SessionRow | undefined = (await c.query('SELECT * FROM payu242_sessions WHERE id=$1 AND order_id=$2 FOR UPDATE', [sessionId, orderId])).rows[0];
    ensure(s, 404, 'Nie znaleziono płatności PayU tego zamówienia');
    const replay: RefundRow | undefined = (await c.query('SELECT * FROM payu242_refunds WHERE client_key=$1', [b.client_key])).rows[0];
    if (replay) {
      ensure(replay.session_id === sessionId && replay.amount === b.amount, 409, 'Klucz potwierdzenia użyty z innymi danymi');
      return { replay };
    }
    ensure(s.status === 'COMPLETED' && s.receipt_entry_id && s.provider_order_id, 409, 'Zwrot jest możliwy tylko dla zaksięgowanej płatności PayU');
    const prior: RefundRow[] = (await c.query('SELECT * FROM payu242_refunds WHERE session_id=$1', [sessionId])).rows;
    ensure(b.amount <= payu242Refundable(s.amount, prior), 422, 'Kwota zwrotu przekracza kwotę tej płatności pomniejszoną o wcześniejsze zwroty');
    // Refunds already sent to PayU but not booked yet (started, PENDING, FINALIZED without an entry) of any session
    // of this order are money on its way out: the overpayment is order-wide.
    const inFlight = Number((await c.query("SELECT coalesce(sum(amount),0)::bigint n FROM payu242_refunds WHERE order_id=$1 AND refund_entry_id IS NULL AND status IN ('started','PENDING','FINALIZED')", [orderId])).rows[0].n);
    ensure(b.amount <= (await paymentBalance(c, orderId)).overpayment - inFlight, 422, 'Zwrot przekracza środki dostępne do oddania (nadpłatę zamówienia pomniejszoną o zwroty w toku)');
    const id = randomUUID();
    const r: RefundRow = (await c.query(
      'INSERT INTO payu242_refunds(id,tenant_id,session_id,order_id,client_key,ext_refund_id,amount,currency,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [id, a.tenantId, sessionId, orderId, b.client_key, 'r-' + id, b.amount, s.currency, a.userId],
    )).rows[0];
    await insertAuditEvent(c, a, 'payu.refund.started', orderId, { refund_id: id, session_id: sessionId, amount: b.amount, currency: s.currency });
    const cfg = (await c.query('SELECT * FROM payu242_configs WHERE id=$1', [s.config_id])).rows[0] as ConfigRow;
    return { refund: r, session: s, cfg, number: String(o.number) };
  });
  if ('replay' in step) return { refund: refundView(step.replay!), reused: true };
  const { refund: r, session: s, cfg } = step;
  const client = clientFor(cfg, secretsOf(cfg));
  let v: PayuRefundView;
  try {
    v = await client.refund(s.provider_order_id!, { extRefundId: r.ext_refund_id, description: ('Zwrot do zamówienia ' + step.number).slice(0, 255), currency: s.currency, amount: r.amount });
  } catch (e) {
    const status = uncertain(e) ? null : 'refused';
    await tenantTx(a.tenantId, (c) => c.query(`UPDATE payu242_refunds SET ${status ? "status='refused'" : "review='uncertain'"},updated_at=now() WHERE id=$1`, [r.id]));
    throw status
      ? new Problem(422, 'PayU odrzucił zwrot; środki nie zostały zwrócone', 'PAYU242_REFUND_REFUSED')
      : new Problem(503, 'Wynik zwrotu w PayU jest niepewny; użyj „Sprawdź w PayU” przed ponowieniem', 'PAYU242_REFUND_UNCERTAIN');
  }
  return tenantTx(a.tenantId, async (c) => {
    await lockOrder(c, orderId);
    const cur: SessionRow = (await c.query('SELECT * FROM payu242_sessions WHERE id=$1 FOR UPDATE', [sessionId])).rows[0];
    const row: RefundRow = (await c.query('SELECT * FROM payu242_refunds WHERE id=$1 FOR UPDATE', [r.id])).rows[0];
    const outcome = await applyRefund(c, row, cur, { refundId: v.refundId, extRefundId: v.extRefundId, status: v.status, amount: v.amount, currency: v.currency }, a);
    const after: RefundRow = (await c.query('SELECT * FROM payu242_refunds WHERE id=$1', [r.id])).rows[0];
    return { refund: refundView(after), outcome, reused: false };
  });
}

// ---- notifications ---------------------------------------------------------------------------------------
export interface Payu242NotifyInput {
  configId: string;
  token: string;
  peer: string | undefined;
  contentType: string | undefined;
  raw: Buffer;
  headers: Record<string, string | string[] | undefined>;
}
type NotifyLog = { session_id?: string | null; kind: 'order' | 'refund' | 'unknown'; provider_order_id?: string | null; status?: string | null; algorithm: string | null; signature_valid: boolean; outcome: string };
async function writeLog(c: Pick<PoolClient, 'query'>, cfg: ConfigRow, raw: Buffer, l: NotifyLog) {
  await c.query(
    'INSERT INTO payu242_notifications(id,tenant_id,config_id,session_id,kind,provider_order_id,status,signature_algorithm,signature_valid,body_sha256,body_bytes,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [randomUUID(), cfg.tenant_id, cfg.id, l.session_id ?? null, l.kind, l.provider_order_id?.slice(0, 64) ?? null, l.status?.slice(0, 40) ?? null, l.algorithm, l.signature_valid, payu242Sha256(raw), raw.length, l.outcome],
  );
}
const algorithmOf = (header: unknown) => {
  const m = typeof header === 'string' ? /algorithm=([A-Za-z0-9-]+)/i.exec(header) : null;
  const a = m?.[1].toUpperCase();
  return a === 'MD5' ? 'MD5' : a === 'SHA-256' || a === 'SHA256' ? 'SHA-256' : null;
};
const ANY_PAYU_SENDER = (peer: string | undefined) => payu242PeerAllowed(peer, 'sandbox') || payu242PeerAllowed(peer, 'production');
/** POST /callbacks/payu/:config/:token. 200 only after the outcome is committed (also for a replay, a late
 * status or a conflict, so PayU stops repeating); a refusal books nothing. Responses carry no detail. */
export async function handlePayu242Notification(i: Payu242NotifyInput, readOnly: boolean): Promise<number> {
  if (readOnly) return 423;
  // The actual network peer first: no database read for a sender outside PayU's published addresses.
  if (!ANY_PAYU_SENDER(i.peer)) return 403;
  if (!UUID.test(i.configId) || !PAYU242_TOKEN.test(i.token)) return 404;
  if (!(await payu242Available())) return 404;
  const cfg: ConfigRow | undefined = (await pool.query('SELECT * FROM payu242_configs WHERE id=$1', [i.configId])).rows[0];
  if (!cfg || !cfg.enabled) return 404;
  if (!payu242PeerAllowed(i.peer, cfg.environment)) return 403;
  let secrets: Secrets;
  try {
    secrets = secretsOf(cfg);
  } catch {
    return 404;
  }
  if (!payu242SecretMatches(secrets.notify_token, i.token)) return 404;
  if ((i.contentType ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return 415;
  if (i.raw.length === 0 || i.raw.length > PAYU_MAX_NOTIFICATION_BYTES) return 413;
  const signatureHeader = i.headers['openpayu-signature'] ?? i.headers['x-openpayu-signature'];
  const headers = { 'openpayu-signature': Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader };
  const algorithm = algorithmOf(headers['openpayu-signature']);
  let n: PayuNotification;
  try {
    n = verifyPayuNotification(i.raw, headers, secrets.second_key);
  } catch (e) {
    const status = e instanceof Problem ? e.status : 400;
    await tenantAppendTx(cfg.tenant_id, (c) => writeLog(c, cfg, i.raw, { kind: 'unknown', algorithm, signature_valid: status !== 401, outcome: status === 401 ? 'invalid_signature' : 'invalid' }));
    return status === 401 ? 401 : 400;
  }
  return tenantTx(cfg.tenant_id, async (c) => {
    const base = { algorithm, signature_valid: true, provider_order_id: n.orderId, status: n.status };
    if (n.kind === 'order') {
      const found: SessionRow | undefined = (await c.query('SELECT * FROM payu242_sessions WHERE ext_order_id=$1 AND config_id=$2', [n.extOrderId, cfg.id])).rows[0];
      if (!found) {
        await writeLog(c, cfg, i.raw, { ...base, kind: 'order', outcome: 'unknown_session' });
        return 404;
      }
      await lockOrder(c, found.order_id);
      const s: SessionRow = (await c.query('SELECT * FROM payu242_sessions WHERE id=$1 FOR UPDATE', [found.id])).rows[0];
      const r = await applyObservation(c, s, { orderId: n.orderId, extOrderId: n.extOrderId, status: n.status, amount: n.amount, currency: n.currency, paymentId: n.paymentId }, null);
      await writeLog(c, cfg, i.raw, { ...base, kind: 'order', session_id: s.id, outcome: r.outcome });
      // A refused booking stays committed as review; 503 makes PayU repeat until the payment path accepts it.
      return r.outcome === 'foreign' || r.outcome === 'amount_mismatch' ? 409 : r.outcome === 'booking_refused' ? 503 : 200;
    }
    const s0: SessionRow | undefined = (await c.query('SELECT * FROM payu242_sessions WHERE provider_order_id=$1 AND config_id=$2', [n.orderId, cfg.id])).rows[0];
    const r0: RefundRow | undefined = s0
      ? (await c.query('SELECT * FROM payu242_refunds WHERE session_id=$1 AND (provider_refund_id=$2 OR ext_refund_id=$3)', [s0.id, n.refundId, n.extRefundId ?? ''])).rows[0]
      : undefined;
    if (!s0 || !r0) {
      await writeLog(c, cfg, i.raw, { ...base, kind: 'refund', session_id: s0?.id, outcome: 'refund_unknown' });
      return 404;
    }
    await lockOrder(c, s0.order_id);
    const s: SessionRow = (await c.query('SELECT * FROM payu242_sessions WHERE id=$1 FOR UPDATE', [s0.id])).rows[0];
    const row: RefundRow = (await c.query('SELECT * FROM payu242_refunds WHERE id=$1 FOR UPDATE', [r0.id])).rows[0];
    const outcome = await applyRefund(c, row, s, { refundId: n.refundId, extRefundId: n.extRefundId, status: n.status, amount: n.amount, currency: n.currency }, null);
    await writeLog(c, cfg, i.raw, { ...base, kind: 'refund', session_id: s.id, outcome });
    return outcome === 'foreign' ? 409 : 200;
  });
}

// ---- return page -----------------------------------------------------------------------------------------
/** The buyer's landing page after PayU: reads the session, books nothing. */
export async function payu242ReturnState(sessionId: string, secret: unknown) {
  ensure(UUID.test(sessionId) && (await payu242Available()), 404, 'Nie znaleziono płatności');
  const s = (await pool.query(
    'SELECT s.id,s.tenant_id,s.status,s.amount,s.currency,s.simulated,s.return_secret_sha256,s.receipt_entry_id,o.number FROM payu242_sessions s JOIN orders o ON (o.tenant_id,o.id)=(s.tenant_id,s.order_id) WHERE s.id=$1',
    [sessionId],
  )).rows[0];
  ensure(s && payu242ReturnSecretMatches(s.return_secret_sha256, secret), 404, 'Nie znaleziono płatności');
  return { session_id: s.id, number: String(s.number), status: s.status as Payu242Status, booked: Boolean(s.receipt_entry_id), amount: s.amount as number, currency: s.currency as string, simulated: s.simulated as boolean };
}

// ---- local simulation: PayU's pay page and its notifications (only with DYNA_PAYU_FAKE=local) ------------
export function payu242FakePayment(orderId: string) {
  const found = payu242FakeOrder(orderId);
  if (!found) return null;
  const o = found.fake.orders.get(orderId)!;
  return { configId: found.configId, fake: found.fake, order: o };
}
/** The notification PayU would POST: the fake signs it with the configuration's second key. */
export function payu242FakeNotification(orderId: string): { path: string; body: string; headers: Record<string, string>; peer: string } | null {
  const found = payu242FakePayment(orderId);
  if (!found) return null;
  const { body, headers } = found.fake.orderNotification(orderId);
  return { path: new URL(found.order.request.notifyUrl).pathname, body, headers, peer: PAYU242_NOTIFY_IPS.sandbox[0] };
}
export function payu242FakeReturnPath(orderId: string): string | null {
  const found = payu242FakePayment(orderId);
  if (!found) return null;
  const u = new URL(found.order.request.continueUrl);
  return u.pathname + u.search;
}
export const payu242BodyHash = (b: string) => createHash('sha256').update(b).digest('hex');
