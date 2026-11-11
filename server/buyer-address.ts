import {
  inspectActiveManagedSchemaTransaction,
  inspectActiveManagedInstallation,
  prepareOrderReadInstallationInTx,
  consumeOrderReadInstallationInTx,
} from './db';
import { assertOwnedOrdinarySchemaTransactionGate } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
import { drainPublicConstraintsInTx } from './public-constraint-drain';
import {
  createOrderMergeDeliveryInheritanceEvidence,
  readOrderMergeDeliveryInheritanceEvidence,
  authenticateOrderMergeDeliverySource,
  type OrderMergeDeliveryInheritanceContext,
} from './order-merge-delivery-inheritance';
/** Local operational delivery sidecar. Billing/source data remains original.
 * Request-bound authority is application-native; SQL-role possession alone is
 * not represented as an independently certified HTTP buyer/admin actor. */
import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { ensure, Problem } from './errors';
import type { Actor } from './domain';
import {
  effectiveDelivery166,
  validateBuyerDeliveryAddress166,
  BuyerDeliveryAddressError166,
  type BuyerDeliveryAddress166,
  type DeliveryKind166,
} from './buyer-delivery-address';
export type BuyerAddressRequest = {
  actor: Actor;
  currentUser?: { id: string; tenant_id: string };
  headers: { authorization?: string; 'x-workspace-id'?: string | string[] };
  cookies: Record<string, string | undefined>;
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
        .join(',') +
      '}'
    );
  ensure(
    v === null || ['string', 'number', 'boolean'].includes(typeof v),
    422,
    'Niepoprawny jawny obiekt',
  );
  return JSON.stringify(v);
}
const version = z
  .union([
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  ])
  .transform(String)
  .refine((v) => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n);
const uuid = z.uuid();
const token = z.string().regex(/^[a-f0-9]{48}$/);
const delivery = z.strictObject({
  recipient_name: z.string().max(800),
  street: z.string().max(800),
  city: z.string().max(400),
  postal_code: z.string().max(80),
  country: z.string().length(2),
  phone: z.string().max(64),
});
const previewInput = z.strictObject({
  client_key: uuid,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  delivery,
});
const applyInput = z.strictObject({
  client_key: uuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  local_only: z.literal(true),
});
const accessInput = z
  .strictObject({
    version,
    policy_version: version,
    enabled: z.boolean(),
    delivery_kind: z.enum(['address', 'pickup_point']).optional(),
    confirmed_delivery_kind: z.literal(true).optional(),
  })
  .refine((v) => (v.delivery_kind !== undefined) === (v.confirmed_delivery_kind !== undefined));
const projection = z.strictObject({
  version: z.string(),
  delivery_version: z.string(),
  enabled: z.boolean(),
  delivery_kind: z.enum(['address', 'pickup_point', 'unknown']),
  classification_origin: z.enum(['unknown', 'operator_confirmed', 'adapter']),
  delivery_override_encrypted: z.string().nullable(),
  override_byte_count: z.number().int().nullable(),
  override_sha256: z.string().nullable(),
  last_receipt_id: uuid.nullable(),
});
type State = z.infer<typeof projection>;
type Order = {
  id: string;
  tenant_id: string;
  customer_name: string;
  email: string;
  address: {
    street: string;
    city: string;
    postal_code: string;
    country: string;
    phone: string;
    locker_code?: string;
  };
  version: string;
  status: string;
  portal_token: string;
  portal_enabled: boolean;
  portal_expires_at: Date | string | null;
};
type Frame = { order: Order; state: State; buyer_basis_hash: string };
type Duty = {
  tenant: string;
  orderId: string;
  hash: string;
  actor: Actor | null;
  write: boolean;
  initial: string | null;
  requirePolicy: boolean;
  eligibility: boolean;
  expiresAt: string | null;
  frame: Frame;
  key: string;
};
type Tx = {
  root: string;
  start: string;
  pid: number;
  duties: Duty[];
  createInstallations: Set<object>;
};
const txs = new WeakMap<PoolClient, Tx>();
/** Presence only; never authorization, admission or transaction readiness. */
export function hasBuyerAddressTransactionDuty(c:PoolClient){return Boolean(txs.get(c)?.duties.length || txs.get(c)?.createInstallations.size);}
const authorities = new WeakMap<Actor, { hash: string }>();
export function beginBuyerAddressTransaction(c: PoolClient) {
  ensure(!txs.has(c), 500, 'Powtórzona transakcja adresu');
  txs.set(c, { root: '', start: '', pid: 0, duties: [], createInstallations:new Set() });
}
export function endBuyerAddressTransaction(c: PoolClient) {
  for(const p of txs.get(c)?.createInstallations??[])createdOrderInstallations.delete(p);
  txs.delete(c);
}
async function context(c: PoolClient, t: string) {
  const tx = txs.get(c);
  ensure(tx, 500, 'Brak zarządzanej transakcji adresu');
  const r = (
    await c.query(
      "SELECT pg_current_xact_id()::text root,transaction_timestamp()::text start,pg_backend_pid() pid,current_user role,current_setting('app.tenant_id',true) tenant",
    )
  ).rows[0];
  ensure(r.role === 'dyna_app' && r.tenant === t, 403, 'Nieprawidłowy kontekst firmy');
  if (!tx.root) Object.assign(tx, { root: r.root, start: r.start, pid: r.pid });
  else
    ensure(
      tx.root === r.root && tx.start === r.start && tx.pid === r.pid,
      409,
      'Zmieniony korzeń transakcji',
    );
  return tx;
}
function nativeError(e: unknown): never {
  if (e instanceof Problem || e instanceof z.ZodError) throw e;
  if (e instanceof BuyerDeliveryAddressError166) throw new Problem(422, e.message);
  const code = (e as { code?: string })?.code;
  if (code === 'P0002') throw new Problem(404, 'Nie znaleziono aktywnego linku lub własnego planu');
  if (code === '28000') throw new Problem(401, 'Sesja lub klucz wygasły');
  if (code === '42501') throw new Problem(403, 'Brak bieżących uprawnień');
  if (['23505', '23514', '40001'].includes(code ?? ''))
    throw new Problem(409, 'Zmieniła się podstawa korekty adresu');
  if (['55000', '42P01', '42883'].includes(code ?? ''))
    throw new Problem(503, 'Niekompletny moduł adresu');
  throw e;
}
declare const createdOrderInstallationBrand: unique symbol;
export type CreatedOrderBuyerInstallation = Readonly<{
  [createdOrderInstallationBrand]: true;
}>;
type CreatedInstallation = {
  client: PoolClient;
  tenant: string;
  tx: Tx;
  identity: object;
  gate: object;
  root: string;
  start: string;
  pid: number;
};
const createdOrderInstallations=new WeakMap<object,CreatedInstallation>();
/** Installation fact only, checked before createOrder's stock/quota locks. No actor/policy/data verdict. */
export async function prepareCreatedOrderBuyerInstallationInTx(c:PoolClient,tenant:string):Promise<CreatedOrderBuyerInstallation|undefined>{
 const issued=inspectActiveManagedSchemaTransaction(c,tenant),tx=txs.get(c);
 if(!issued?.gate||!tx)return undefined; // all other paths retain the complete existing check
 assertOwnedOrdinarySchemaTransactionGate(issued.gate);
 const ro=(await c.query("SHOW transaction_read_only")).rows[0]?.transaction_read_only;
 ensure(ro==='on'||ro==='off',503,'Nieznany tryb transakcji adresu');
 if(ro==='on')return undefined;
 const current=await context(c,tenant);
 const installation=await inspectActiveManagedInstallation(c,tenant);
 if(!installation?.buyer&&!await available(c))return undefined;
 const proof=Object.freeze({}) as CreatedOrderBuyerInstallation;
 createdOrderInstallations.set(proof,{client:c,tenant,tx:current,identity:issued.identity,gate:issued.gate,root:current.root,start:current.start,pid:current.pid});
 current.createInstallations.add(proof);return proof;
}
async function consumeCreatedOrderInstallation(c:PoolClient,tenant:string,proof:CreatedOrderBuyerInstallation){
 const p=createdOrderInstallations.get(proof);ensure(p&&p.client===c&&p.tenant===tenant&&txs.get(c)===p.tx&&p.tx.createInstallations.has(proof),409,'Brak bieżącej instalacji adresu dla createOrder');
 // One use, including every failed await; no authority survives pool reuse or endTX.
 createdOrderInstallations.delete(proof);p.tx.createInstallations.delete(proof);
 const issued=inspectActiveManagedSchemaTransaction(c,tenant);
 ensure(issued&&issued.identity===p.identity&&issued.gate===p.gate,409,'Zmieniona dzierżawa transakcji adresu');
 assertOwnedOrdinarySchemaTransactionGate(issued.gate!);
 ensure((await c.query("SHOW transaction_read_only")).rows[0]?.transaction_read_only==='off',409,'Zmieniony tryb transakcji adresu');
 const current=await context(c,tenant);
 ensure(current===p.tx&&current.root===p.root&&current.start===p.start&&current.pid===p.pid,409,'Zmieniony korzeń instalacji adresu');
}
async function available(c: PoolClient) {
  const p = (
    await c.query(
      "SELECT to_regprocedure('public.buyer_address_available()') present,to_regprocedure('public.buyer_available236()') verdict",
    )
  ).rows[0];
  if (!p.present) {
    const remnants = (
      await c.query(
        "SELECT EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'buyer_address_')) OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'buyer_address_')) OR EXISTS(SELECT FROM pg_trigger WHERE starts_with(tgname,'buyer_address_')) bad",
      )
    ).rows[0].bad;
    ensure(!remnants, 503, 'Niekompletna instalacja adresu');
    return false;
  }
  // 236: the same verdict, reused while the cold-approved schema and its sealed basis are unchanged.
  const sql = p.verdict ? 'SELECT buyer_available236() ok' : 'SELECT buyer_address_available() ok';
  return (await c.query(sql)).rows[0].ok === true;
}
function requestActor(req: BuyerAddressRequest, sessionName: string) {
  ensure(/^dyna_session(?:_preview_\d+)?$/.test(sessionName), 500, 'Niepoprawna przestrzeń sesji');
  ensure(
    req.currentUser?.id === req.actor.userId && req.currentUser.tenant_id === req.actor.tenantId,
    401,
    'Brak zaufanej tożsamości',
  );
  const a = Object.freeze({ ...req.actor });
  const raw = a.apiKeyId
    ? req.headers.authorization?.replace(/^Bearer /, '')
    : (req.cookies[sessionName] ?? req.headers.authorization?.replace(/^Bearer /, ''));
  ensure(raw && (!a.apiKeyId || /^dyna_api_[a-f0-9]{64}$/.test(raw)), 401, 'Brak sesji lub klucza');
  ensure(
    !req.headers['x-workspace-id'] || req.headers['x-workspace-id'] === a.tenantId,
    409,
    'Zmieniono firmę',
  );
  authorities.set(a, { hash: sha(raw) });
  return a;
}
export function captureOrderMergeBuyerAddressActor(
  req: BuyerAddressRequest,
  sessionName: string,
): Actor {
  return requestActor(req, sessionName);
}
async function identity(c: PoolClient, a: Actor, write: boolean, pin = false) {
  const p = authorities.get(a);
  ensure(p, 401, 'Brak zaufanego żądania');
  return (
    await c.query('SELECT buyer_address_identity($1,$2,$3,$4,$5,$6,$7) proof', [
      a.tenantId,
      a.userId,
      a.apiKeyId ?? null,
      p.hash,
      a.role,
      write,
      pin,
    ])
  ).rows[0].proof;
}
// Used solely for genuinely absent-module neutral status, while still owner.
async function absentIdentity(c: PoolClient, a: Actor, write: boolean) {
  const p = authorities.get(a)!;
  const from = a.apiKeyId
    ? `FROM api_keys k JOIN memberships m ON(m.user_id,m.tenant_id)=(k.user_id,k.tenant_id) LEFT JOIN account_security s ON s.user_id=m.user_id LEFT JOIN workspace_security_policies w ON w.tenant_id=m.tenant_id WHERE(k.id,k.user_id,k.tenant_id,k.token_hash)=($4::uuid,$2::uuid,$1::uuid,$3) AND k.revoked_at IS NULL AND k.expires_at>clock_timestamp()`
    : `FROM sessions k JOIN memberships m ON(m.user_id,m.tenant_id)=(k.user_id,k.tenant_id) LEFT JOIN account_security s ON s.user_id=m.user_id LEFT JOIN workspace_security_policies w ON w.tenant_id=m.tenant_id WHERE(k.user_id,k.tenant_id,k.token_hash)=($2::uuid,$1::uuid,$3) AND k.expires_at>clock_timestamp() AND k.account_version=coalesce(s.version,0)`;
  const r = (
    await c.query(
      `SELECT m.role,coalesce(s.version,0)::text account_version,to_jsonb(w) policy,${a.apiKeyId ? "k.scopes,k.scopes@>CASE WHEN $5::boolean THEN ARRAY['orders:read','orders:write']::text[] ELSE ARRAY['orders:read']::text[] END scope_ok,coalesce(w.require_mfa,false) AND s.enabled_at IS NULL mfa_required" : "NULL::text[] scopes,true scope_ok,coalesce(w.require_mfa,false) AND NOT coalesce(s.enabled_at IS NOT NULL AND k.mfa_verified_at IS NOT NULL AND k.mfa_verified_at>clock_timestamp()-interval '8 hours',false) mfa_required"} ${from}`,
      a.apiKeyId
        ? [a.tenantId, a.userId, p.hash, a.apiKeyId, write]
        : [a.tenantId, a.userId, p.hash],
    )
  ).rows[0];
  ensure(r, 401, 'Sesja lub klucz wygasły');
  ensure(r.role === a.role, 409, 'Rola zmieniła się');
  ensure(
    r.scope_ok && !r.mfa_required && (!write || r.role === 'admin'),
    403,
    'Brak bieżących uprawnień',
  );
  return sha(canonical(r));
}
function seal(value: unknown, key: string) {
  const text = canonical(value);
  ensure(Buffer.byteLength(text) <= 16384, 413, 'Dowód adresu przekracza limit');
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv),
    body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]),
    ciphertext = Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  return { encrypted: ciphertext, byte_count: Buffer.byteLength(text), sha256: sha(ciphertext) };
}
function unseal(ciphertext: string, bytes: number, digest: string, key: string): unknown {
  ensure(
    sha(ciphertext) === digest && Buffer.byteLength(ciphertext) <= 87420,
    503,
    'Uszkodzony zaszyfrowany dowód adresu',
  );
  try {
    const b = Buffer.from(ciphertext, 'base64');
    ensure(
      b.length === bytes + 28 && b.toString('base64') === ciphertext,
      503,
      'Uszkodzona otoczka adresu',
    );
    const d = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const plain = Buffer.concat([d.update(b.subarray(28)), d.final()]);
    ensure(plain.length === bytes && plain.length <= 16384, 503, 'Uszkodzony rozmiar adresu');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(plain);
    const value = JSON.parse(text);
    ensure(canonical(value) === text, 503, 'Niekononiczny dowód adresu');
    return value;
  } catch (e) {
    if (e instanceof Problem) throw e;
    throw new Problem(503, 'Uwierzytelnienie dowodu adresu nie powiodło się');
  }
}
function effective(frame: Frame, key: string) {
  const s = frame.state;
  let override: unknown | null = null;
  if (s.delivery_override_encrypted !== null) {
    ensure(
      s.override_byte_count !== null && s.override_sha256 !== null,
      503,
      'Niekompletny sidecar adresu',
    );
    override = unseal(s.delivery_override_encrypted, s.override_byte_count, s.override_sha256, key);
    try {
      const valid = validateBuyerDeliveryAddress166(override, {
        originalCountry: frame.order.address.country,
        deliveryKind: s.delivery_kind,
      });
      ensure(canonical(valid) === canonical(override), 503, 'Zmieniony zapis adresu');
    } catch {
      throw new Problem(503, 'Niepoprawna semantyka zapisanego adresu');
    }
  }
  return effectiveDelivery166({
    original: frame.order,
    sidecarOverride: override,
    deliveryKind: s.delivery_kind,
  });
}
async function frame(
  c: PoolClient,
  t: string,
  id: string,
  lock: 'share' | 'update' | 'none' = 'share',
): Promise<Frame> {
  const order = (
    await c.query(
      'SELECT *,version::text version FROM orders WHERE tenant_id=$1 AND id=$2' +
        (lock === 'none' ? '' : ' FOR ' + (lock === 'update' ? 'UPDATE' : 'SHARE')),
      [t, id],
    )
  ).rows[0];
  ensure(order, 404, 'Nie znaleziono zamówienia');
  const s = (
    await c.query(
      'SELECT buyer_address_current_state($1,$2) state,buyer_address_buyer_basis($1,$2) basis',
      [t, id],
    )
  ).rows[0];
  return { order, state: projection.parse(s.state), buyer_basis_hash: s.basis };
}
function policy(s: State) {
  return {
    enabled: s.enabled,
    delivery_kind: s.delivery_kind,
    classification_origin: s.classification_origin,
  };
}
function revision(f: Frame, h: string, key: string) {
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(
      'buyer-address-revision/v1\0' +
        canonical({
          tenant: f.order.tenant_id,
          order: f.order.id,
          order_version: f.order.version,
          buyer_basis_hash: f.buyer_basis_hash,
          state: f.state,
          token: h,
        }),
    )
    .digest('hex');
}
const utc = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
function evidence(p: any, f: Frame, key: string) {
  if (p.kind === 'merge_inherit') {
    const v = readOrderMergeDeliveryInheritanceEvidence(
      {
        encrypted: p.evidence_encrypted,
        byte_count: p.evidence_byte_count,
        sha256: p.evidence_sha256,
      },
      key,
    );
    ensure(
      v.tenant_id === p.tenant_id &&
        v.target_order_id === p.order_id &&
        p.tenant_id === f.order.tenant_id &&
        p.order_id === f.order.id,
      503,
      'Zmieniony rodzic dowodu dziedziczenia',
    );
    const before = projection.parse(p.before_state),
      after = projection.parse(p.after_state);
    const expected = {
      ...v.source_frame.state,
      version: '1',
      delivery_version:
        v.source_frame.state.delivery_override_encrypted === null ? '0' : '1',
      enabled: false,
      last_receipt_id: p.reserved_receipt_id ?? p.id,
    };
    const zero = {
      version: '0',
      delivery_version: '0',
      enabled: false,
      delivery_kind: 'unknown',
      classification_origin: 'unknown',
      delivery_override_encrypted: null,
      override_byte_count: null,
      override_sha256: null,
      last_receipt_id: null,
    };
    ensure(
      canonical(before) === canonical(zero) &&
        canonical(after) === canonical(expected) &&
        p.changed === true,
      503,
      'Zmieniony stan dowodu dziedziczenia',
    );
    const actual = effective({ ...f, state: after }, key);
    ensure(
      canonical(actual) === canonical(v.source_effective),
      503,
      'Zmieniony docelowy adres dziedziczenia',
    );
    return {
      before: null,
      after: actual.delivery,
      classification: {
        delivery_kind: after.delivery_kind,
        origin: after.classification_origin,
      },
    };
  }
  const v = z
    .strictObject({
      schema: z.literal('buyer-address-evidence/v1'),
      before: delivery.nullable(),
      after: delivery.nullable(),
      classification: z.strictObject({
        delivery_kind: z.enum(['address', 'pickup_point', 'unknown']),
        origin: z.enum(['unknown', 'operator_confirmed', 'adapter']),
      }),
    })
    .parse(
      unseal(
        p.evidence_encrypted,
        p.evidence_byte_count,
        p.evidence_sha256,
        key,
      ),
    );
  const savedBefore = { ...f, state: projection.parse(p.before_state) },
    savedAfter = { ...f, state: projection.parse(p.after_state) };
  ensure(
    canonical(v.before) === canonical(effective(savedBefore, key).delivery) &&
      canonical(v.after) === canonical(effective(savedAfter, key).delivery),
    503,
    'Dowód adresu różni się od zamrożonych sidecarów',
  );
  ensure(
    v.classification.delivery_kind === savedAfter.state.delivery_kind &&
      v.classification.origin === savedAfter.state.classification_origin,
    503,
    'Dowód klasyfikacji różni się',
  );
  if (p.kind === 'delivery') {
    ensure(v.after !== null, 503, 'Brak adresu w dowodzie');
    try {
      ensure(
        canonical(
          validateBuyerDeliveryAddress166(v.after, {
            originalCountry: f.order.address.country,
            deliveryKind: 'address',
          }),
        ) === canonical(v.after),
        503,
        'Niekononiczny adres w dowodzie',
      );
    } catch {
      throw new Problem(503, 'Niepoprawna semantyka dowodu');
    }
    ensure(
      p.changed === (canonical(v.before) !== canonical(v.after)),
      503,
      'Zmiana adresu różni się od dowodu',
    );
  }
  return v;
}
async function duty(
  c: PoolClient,
  f: Frame,
  key: string,
  authority: { actor: Actor | null; hash: string; write: boolean; initial: string | null },
  extra: { requirePolicy: boolean; eligibility?: boolean; expiresAt?: string | null },
) {
  const tx = await context(c, f.order.tenant_id);
  effective(f, key);
  tx.duties.push({
    tenant: f.order.tenant_id,
    orderId: f.order.id,
    ...authority,
    key,
    frame: f,
    requirePolicy: extra.requirePolicy,
    eligibility: extra.eligibility ?? false,
    expiresAt: extra.expiresAt ?? null,
  });
}
export async function enlistOrderMergeBuyerAddressActorInTx(
  c: PoolClient,
  a: Actor,
  orderId: string,
  key: string,
) {
  const p = authorities.get(a);
  ensure(p, 401, 'Brak dowodu sesji lub klucza');
  const initial = sha(canonical(await identity(c, a, true, true)));
  await duty(
    c,
    await frame(c, a.tenantId, orderId),
    key,
    { actor: a, hash: p.hash, write: true, initial },
    { requirePolicy: false },
  );
}
/** Same managed MERGE transaction, genuine request-owned identity, independently owned target duty. */
export async function inheritOrderMergeBuyerAddressInTx(
  c: PoolClient,
  a: Actor,
  input: OrderMergeDeliveryInheritanceContext,
  key: string,
) {
  ensure(
    input.tenant_id === a.tenantId,
    403,
    'Obca firma dziedziczenia adresu',
  );
  const proof = authorities.get(a);
  ensure(proof, 401, 'Brak dowodu sesji lub klucza');
  await context(c, a.tenantId);
  const initial = await identity(c, a, true, true);
  ensure(
    typeof input.source.order.portal_enabled === 'boolean' &&
      /^[a-f0-9]{48}$/.test(input.source.order.portal_token) &&
      (input.source.order.portal_expires_at === null ||
        Number.isFinite(
          new Date(input.source.order.portal_expires_at).getTime(),
        )),
    503,
    'Niekompletna polityka portalu źródła',
  );
  const e = createOrderMergeDeliveryInheritanceEvidence(input, key);
  try {
    const result = (
      await c.query(
        'SELECT order_merge_delivery209_inherit($1,$2,$3,$4,$5,$6,$7,$8) proof',
        [
          input.execution_id,
          a.userId,
          a.apiKeyId ?? null,
          proof.hash,
          a.role,
          e.encrypted,
          e.byte_count,
          e.sha256,
        ],
      )
    ).rows[0]?.proof;
    ensure(
      result &&
        result.target_order_id === input.target_order_id &&
        result.source_order_id === input.source.order.id &&
        result.source_buyer_basis_hash === input.source.buyer_basis_hash &&
        canonical(result.source_state) === canonical(input.source.state),
      503,
      'Niezgodny wynik dziedziczenia adresu',
    );
    const target = await frame(c, a.tenantId, input.target_order_id);
    ensure(
      canonical(target.state) === canonical(result.after_state) &&
        target.state.last_receipt_id === result.receipt_id,
      503,
      'Niekompletny docelowy sidecar',
    );
    const source = authenticateOrderMergeDeliverySource(input.source, key);
    ensure(
      canonical(effective(target, key)) === canonical(source.effective) &&
        !target.state.enabled &&
        target.order.portal_enabled === input.source.order.portal_enabled &&
        (target.order.portal_expires_at === null
          ? null
          : utc(target.order.portal_expires_at)) ===
          (input.source.order.portal_expires_at === null
            ? null
            : utc(input.source.order.portal_expires_at)) &&
        /^[a-f0-9]{48}$/.test(target.order.portal_token) &&
        target.order.portal_token !== input.source.order.portal_token,
      503,
      'Niezgodny adres lub zgoda docelowa',
    );
    await identity(c, a, true, true);
    await duty(
      c,
      target,
      key,
      {
        actor: a,
        hash: proof.hash,
        write: true,
        initial: sha(canonical(initial)),
      },
      { requirePolicy: false },
    );
    return result;
  } catch (e) {
    nativeError(e);
  }
}
export async function finalizeBuyerAddressInTx(c: PoolClient) {
  const tx = txs.get(c);
  if (!tx?.duties.length) return;
  await drainPublicConstraintsInTx(c);
  for (const d of tx.duties)
    if (d.actor) await identity(c, d.actor, d.write, true);
    else
      await c.query('SELECT buyer_address_public_identity($1,$2,$3,$4,true)', [
        d.tenant,
        d.orderId,
        d.hash,
        d.requirePolicy,
      ]);
  for (const d of tx.duties) {
    await context(c, d.tenant);
    const fresh = await frame(c, d.tenant, d.orderId);
    ensure(
      canonical(fresh.state) === canonical(d.frame.state) &&
        fresh.order.version === d.frame.order.version &&
        fresh.buyer_basis_hash === d.frame.buyer_basis_hash,
      409,
      'Zmieniła się podstawa adresu',
    );
    effective(fresh, d.key);
    if (d.actor)
      ensure(
        sha(canonical(await identity(c, d.actor, d.write))) === d.initial,
        409,
        'Zmieniła się tożsamość administratora',
      );
  }
  for (const d of tx.duties)
    await c.query('SELECT buyer_address_terminal($1,$2,$3,$4,$5,$6,$7::jsonb)', [
      d.tenant,
      d.actor?.userId ?? null,
      d.actor?.apiKeyId ?? null,
      d.hash,
      d.actor?.role ?? null,
      d.write,
      JSON.stringify([
        {
          order_id: d.orderId,
          order_version: d.frame.order.version,
          state: d.frame.state,
          buyer_basis_hash: d.frame.buyer_basis_hash,
          require_policy: d.requirePolicy,
          eligibility: d.eligibility,
          expires_at: d.expiresAt,
        },
      ]),
    ]);
}
async function effectiveDeliveryWithInstallationInTx(
  c: PoolClient,
  tenantId: string,
  orderId: string,
  encryptionKey: string,
  installation?:CreatedOrderBuyerInstallation,
) {
  if(installation)await consumeCreatedOrderInstallation(c,tenantId,installation);
  if (!installation&&!(await available(c)))
    return {
      kind: 'unknown' as const,
      origin: null,
      delivery: null,
      reason: 'delivery_kind_unknown' as const,
      delivery_version: '0',
      delivery_hash: null,
      available: false,
      policy_version: '0',
      enabled: false,
    };
  return readEffectiveDeliveryInTx(c,tenantId,orderId,encryptionKey);
}
async function readEffectiveDeliveryInTx(c:PoolClient,tenantId:string,orderId:string,encryptionKey:string){
  const f = await frame(c, tenantId, orderId, 'none'),
    e = effective(f, encryptionKey);
  return {
    ...e,
    delivery_version: f.state.delivery_version,
    delivery_hash: e.delivery ? sha(canonical(e.delivery)) : null,
    available: true,
    policy_version: f.state.version,
    enabled: f.state.enabled,
  };
}
/** Generic/direct/read-only reads keep their original full installation validation. */
export async function effectiveDeliveryInTx(c:PoolClient,tenantId:string,orderId:string,encryptionKey:string){
 return effectiveDeliveryWithInstallationInTx(c,tenantId,orderId,encryptionKey);
}
/** Dedicated GET hydrator only. Generic/RW/direct consumers keep the full guard;
 * the database module can issue a proof only for its real active RRRO client. */
export async function effectiveDeliveryForOrderReadInTx(c:PoolClient,tenantId:string,orderId:string,encryptionKey:string){
 const proof=await prepareOrderReadInstallationInTx(c,tenantId);
 if(!proof)return effectiveDeliveryInTx(c,tenantId,orderId,encryptionKey);
 await consumeOrderReadInstallationInTx(c,tenantId,proof);
 return readEffectiveDeliveryInTx(c,tenantId,orderId,encryptionKey);
}
/** Only the private createOrder hydrator supplies a genuine one-shot installation proof. */
export async function effectiveDeliveryForCreatedOrderInTx(c:PoolClient,tenantId:string,orderId:string,encryptionKey:string,proof:CreatedOrderBuyerInstallation){
 return effectiveDeliveryWithInstallationInTx(c,tenantId,orderId,encryptionKey,proof);
}
export async function deliveryBindingInTx(
  c: PoolClient,
  tenantId: string,
  orderId: string,
  encryptionKey: string,
) {
  const e = await effectiveDeliveryInTx(c, tenantId, orderId, encryptionKey);
  return e.origin === 'override' && e.delivery
    ? { version: e.delivery_version, hash: e.delivery_hash!, delivery: e.delivery }
    : null;
}
export function createBuyerAddressService(cfg: {
  pool: Pool;
  encryptionKey: string;
  sessionName: string;
  readOnly: boolean;
}) {
  ensure(/^[a-f0-9]{64}$/.test(cfg.encryptionKey), 500, 'Brak prywatnego klucza szyfrowania');
  async function transact<T>(
    a: Actor | null,
    rawToken: string | null,
    write: boolean,
    fn: (
      c: PoolClient,
      t: string,
      id: string | null,
      installed: boolean,
      auth: { actor: Actor | null; hash: string; write: boolean; initial: string | null },
    ) => Promise<T>,
  ) {
    ensure(!write || !cfg.readOnly, 423, 'Kopia przywrócona jest tylko do odczytu');
    const c = await cfg.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL TimeZone='UTC'");
      await c.query("SET LOCAL statement_timeout='8s'");
      ensure(
        rawToken === null || /^[a-f0-9]{48}$/.test(rawToken),
        404,
        'Nie znaleziono aktywnego linku zamówienia',
      );
      const raw = rawToken,
        h = a ? authorities.get(a)!.hash : sha(raw!);
      let t = a?.tenantId,
        id: string | null = null,
        initial: string | null = null;
      if (a) initial = await absentIdentity(c, a, write);
      else {
        const ref = (
          await c.query(
            'SELECT id,tenant_id FROM orders WHERE portal_token=$1 AND portal_enabled AND(portal_expires_at IS NULL OR portal_expires_at>clock_timestamp()) FOR ' +
              (write ? 'UPDATE' : 'SHARE'),
            [raw],
          )
        ).rows[0];
        ensure(ref, 404, 'Nie znaleziono aktywnego linku zamówienia');
        t = ref.tenant_id;
        id = ref.id;
      }
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [t]);
      await c.query('SET LOCAL ROLE dyna_app');
      beginBuyerAddressTransaction(c);
      const installed = await available(c);
      if (a && installed) initial = sha(canonical(await identity(c, a, write)));
      if (!a && installed)
        await c.query('SELECT buyer_address_public_identity($1,$2,$3,false,false)', [t, id, h]);
      const result = await fn(c, t!, id, installed, { actor: a, hash: h, write, initial });
      await finalizeBuyerAddressInTx(c);
      if (!installed) {
        await c.query('RESET ROLE');
        if (a)
          ensure((await absentIdentity(c, a, write)) === initial, 409, 'Uprawnienia zmieniły się');
        else
          ensure(
            (
              await c.query(
                'SELECT 1 FROM orders WHERE tenant_id=$1 AND id=$2 AND portal_enabled AND portal_token=$3 AND(portal_expires_at IS NULL OR portal_expires_at>clock_timestamp())',
                [t, id, raw],
              )
            ).rowCount,
            404,
            'Nie znaleziono aktywnego linku',
          );
      }
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      return nativeError(e);
    } finally {
      endBuyerAddressTransaction(c);
      c.release();
    }
  }
  const installed = (value: boolean) =>
    ensure(value, 503, 'Moduł korekty adresu nie jest dostępny');
  const body = (v: unknown) => {
    ensure(
      Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8') <= 16384,
      413,
      'Żądanie adresu przekracza limit',
    );
    return v;
  };
  async function last(c: PoolClient, t: string, id: string) {
    const r = (
      await c.query(
        "SELECT created_at FROM buyer_address_receipts WHERE tenant_id=$1 AND order_id=$2 AND kind='delivery' AND changed ORDER BY created_at DESC,id DESC LIMIT 1",
        [t, id],
      )
    ).rows[0];
    return r ? { created_at: utc(r.created_at) } : null;
  }
  async function reason(c: PoolClient, f: Frame) {
    if (!f.state.enabled) return 'access_disabled';
    if (cfg.readOnly) return 'read_only';
    const e = effective(f, cfg.encryptionKey);
    if (e.reason) return e.reason;
    return (
      await c.query('SELECT buyer_address_block_reason($1,$2) reason', [
        f.order.tenant_id,
        f.order.id,
      ])
    ).rows[0].reason as string | null;
  }
  async function operatorStatus(
    c: PoolClient,
    t: string,
    id: string,
    isInstalled: boolean,
    a: Actor,
  ) {
    if (!isInstalled) {
      const o = (
        await c.query('SELECT version::text version FROM orders WHERE tenant_id=$1 AND id=$2', [
          t,
          id,
        ])
      ).rows[0];
      ensure(o, 404, 'Nie znaleziono zamówienia');
      return {
        available: false,
        read_only: cfg.readOnly,
        can_manage: false,
        order_version: o.version,
        policy_version: '0',
        enabled: false,
        delivery_kind: 'unknown' as const,
        classification_origin: 'unknown' as const,
        delivery_version: '0',
        effective_delivery: null,
        reason: 'module_unavailable',
        last_change: null,
      };
    }
    const f = await frame(c, t, id);
    const e = effective(f, cfg.encryptionKey);
    const readProof = await identity(c, a, false);
    const canManage =
      !cfg.readOnly &&
      a.role === 'admin' &&
      (!a.apiKeyId || readProof.scopes.includes('orders:write'));
    return {
      available: true,
      read_only: cfg.readOnly,
      can_manage: canManage,
      order_version: f.order.version,
      policy_version: f.state.version,
      enabled: f.state.enabled,
      delivery_kind: f.state.delivery_kind,
      classification_origin: f.state.classification_origin,
      delivery_version: f.state.delivery_version,
      effective_delivery: e.delivery,
      reason: await reason(c, f),
      last_change: await last(c, t, id),
    };
  }
  async function prepare(
    c: PoolClient,
    f: Frame,
    auth: { actor: Actor | null; hash: string },
    kind: 'access' | 'delivery',
    clientKey: string,
    requestHash: string,
    after: State,
    changed: boolean,
    beforeDelivery: BuyerDeliveryAddress166 | null,
    afterDelivery: BuyerDeliveryAddress166 | null,
    reserved: string,
  ) {
    const id = randomUUID(),
      encrypted = seal(
        {
          schema: 'buyer-address-evidence/v1',
          before: beforeDelivery,
          after: afterDelivery,
          classification: {
            delivery_kind: after.delivery_kind,
            origin: after.classification_origin,
          },
        },
        cfg.encryptionKey,
      ),
      v = {
        id,
        reserved_receipt_id: reserved,
        client_key: clientKey,
        kind,
        expected_order_version: f.order.version,
        before_state: f.state,
        after_state: after,
        buyer_basis_hash: f.buyer_basis_hash,
        request_hash: requestHash,
        evidence_encrypted: encrypted.encrypted,
        evidence_byte_count: encrypted.byte_count,
        evidence_sha256: encrypted.sha256,
        changed,
      };
    return (
      await c.query('SELECT buyer_address_prepare($1,$2,$3,$4,$5,$6,$7::jsonb) preview', [
        f.order.tenant_id,
        f.order.id,
        auth.actor?.userId ?? null,
        auth.actor?.apiKeyId ?? null,
        auth.hash,
        auth.actor?.role ?? null,
        JSON.stringify(v),
      ])
    ).rows[0].preview;
  }
  function previewDto(p: any, f: Frame, reused: boolean) {
    const e = evidence(p, f, cfg.encryptionKey);
    return {
      available: true,
      read_only: cfg.readOnly,
      id: p.id,
      scope_hash: p.scope_hash,
      expires_at: utc(p.expires_at),
      before: e.before!,
      after: e.after!,
      changed: p.changed,
      state: 'preview' as const,
      local_only: true,
      reused,
    };
  }
  function receiptDto(r: any, f: Frame, h: string, reused: boolean) {
    const e = evidence(r, f, cfg.encryptionKey),
      saved = {
        ...f,
        order: { ...f.order, version: String(r.after_order_version) },
        state: projection.parse(r.after_state),
        buyer_basis_hash: r.buyer_basis_hash,
      };
    return {
      available: true,
      read_only: cfg.readOnly,
      id: r.id,
      state: 'applied' as const,
      changed: r.changed,
      delivery: e.after!,
      revision: revision(saved, h, cfg.encryptionKey),
      created_at: utc(r.created_at),
      reused,
    };
  }
  async function apply(
    c: PoolClient,
    f: Frame,
    p: any,
    key: string,
    requestHash: string,
    auth: { actor: Actor | null; hash: string },
  ) {
    evidence(p, f, cfg.encryptionKey);
    return (
      await c.query('SELECT buyer_address_apply($1,$2,$3,$4,$5,$6,$7,$8,$9) receipt', [
        f.order.tenant_id,
        f.order.id,
        p.id,
        key,
        requestHash,
        auth.actor?.userId ?? null,
        auth.actor?.apiKeyId ?? null,
        auth.hash,
        auth.actor?.role ?? null,
      ])
    ).rows[0].receipt;
  }
  async function publicFrame(
    c: PoolClient,
    t: string,
    id: string,
    auth: { hash: string },
    write: boolean,
    policyRequired: boolean,
  ) {
    const f = await frame(c, t, id, write ? 'update' : 'share');
    await c.query('SELECT buyer_address_public_identity($1,$2,$3,$4,false)', [
      t,
      id,
      auth.hash,
      policyRequired,
    ]);
    return f;
  }
  return {
    status: (req: BuyerAddressRequest, id: string) => {
      const a = requestActor(req, cfg.sessionName);
      return transact(a, null, false, async (c, t, _id, on, auth) => {
        uuid.parse(id);
        const result = await operatorStatus(c, t, id, on, a);
        if (on)
          await duty(c, await frame(c, t, id), cfg.encryptionKey, auth, { requirePolicy: false });
        return result;
      });
    },
    overview: (rawToken: string) =>
      transact(null, rawToken, false, async (c, t, id, on, auth) => {
        if (!on)
          return {
            available: false,
            read_only: cfg.readOnly,
            enabled: false,
            can_edit: false,
            reason: 'module_unavailable',
            delivery: null,
            revision: null,
            last_change: null,
          };
        const f = await publicFrame(c, t, id!, auth, false, false),
          blocked = await reason(c, f);
        await duty(c, f, cfg.encryptionKey, auth, { requirePolicy: false });
        return {
          available: true,
          read_only: cfg.readOnly,
          enabled: f.state.enabled,
          can_edit: blocked === null,
          reason: blocked,
          delivery: f.state.enabled ? effective(f, cfg.encryptionKey).delivery : null,
          revision: f.state.enabled ? revision(f, auth.hash, cfg.encryptionKey) : null,
          last_change: f.state.enabled ? await last(c, t, id!) : null,
        };
      }),
    publicPreview: (rawToken: string, raw: unknown) =>
      transact(null, rawToken, true, async (c, t, id, on, auth) => {
        installed(on);
        const b = previewInput.parse(body(raw)),
          f = await publicFrame(c, t, id!, auth, true, true),
          requestHash = sha(canonical(b)),
          previous = (
            await c.query(
              "SELECT * FROM buyer_address_previews WHERE tenant_id=$1 AND order_id=$2 AND client_key=$3 AND kind='delivery'",
              [t, id, b.client_key],
            )
          ).rows[0];
        if (previous) {
          ensure(
            previous.request_hash === requestHash && previous.token_digest === auth.hash,
            409,
            'Klucz podglądu jest związany z inną próbą',
          );
          await duty(c, f, cfg.encryptionKey, auth, { requirePolicy: true });
          return { statusCode: 200, body: previewDto(previous, f, true) };
        }
        ensure((await reason(c, f)) === null, 409, 'Korekta adresu nie jest już dostępna');
        ensure(
          revision(f, auth.hash, cfg.encryptionKey) === b.revision,
          409,
          'Adres lub polityka zmieniły się',
        );
        const before = effective(f, cfg.encryptionKey).delivery!,
          afterDelivery = validateBuyerDeliveryAddress166(b.delivery, {
            originalCountry: f.order.address.country,
            deliveryKind: f.state.delivery_kind,
          }),
          changed = canonical(before) !== canonical(afterDelivery),
          reserved = randomUUID(),
          after = { ...f.state };
        if (changed) {
          const sealed = seal(afterDelivery, cfg.encryptionKey);
          Object.assign(after, {
            version: (BigInt(after.version) + 1n).toString(),
            delivery_version: (BigInt(after.delivery_version) + 1n).toString(),
            delivery_override_encrypted: sealed.encrypted,
            override_byte_count: sealed.byte_count,
            override_sha256: sealed.sha256,
            last_receipt_id: reserved,
          });
        }
        const p = await prepare(
          c,
          f,
          auth,
          'delivery',
          b.client_key,
          requestHash,
          after,
          changed,
          before,
          afterDelivery,
          reserved,
        );
        evidence(p, f, cfg.encryptionKey);
        await duty(c, f, cfg.encryptionKey, auth, {
          requirePolicy: true,
          eligibility: true,
          expiresAt: p.expires_at,
        });
        return { statusCode: 201, body: previewDto(p, f, false) };
      }),
    publicReadPreview: (rawToken: string, id: string) =>
      transact(null, rawToken, false, async (c, t, orderId, on, auth) => {
        installed(on);
        uuid.parse(id);
        const f = await publicFrame(c, t, orderId!, auth, false, true),
          p = (
            await c.query(
              "SELECT * FROM buyer_address_previews WHERE tenant_id=$1 AND order_id=$2 AND id=$3 AND kind='delivery' AND token_digest=$4",
              [t, orderId, id, auth.hash],
            )
          ).rows[0];
        ensure(p, 404, 'Nie znaleziono własnego podglądu');
        const r = (
            await c.query(
              'SELECT * FROM buyer_address_receipts WHERE tenant_id=$1 AND order_id=$2 AND preview_id=$3',
              [t, orderId, id],
            )
          ).rows[0],
          now = (await c.query('SELECT clock_timestamp() now')).rows[0].now,
          blocked = await reason(c, f),
          canApply =
            !r &&
            !blocked &&
            new Date(p.expires_at) > now &&
            String(p.expected_order_version) === f.order.version &&
            canonical(p.before_state) === canonical(f.state);
        await duty(c, f, cfg.encryptionKey, auth, { requirePolicy: true });
        return {
          preview: previewDto(p, f, true),
          receipt: r ? receiptDto(r, f, auth.hash, true) : null,
          can_apply: canApply,
          reason: r ? 'already_applied' : canApply ? null : (blocked ?? 'preview_stale'),
        };
      }),
    publicApply: (rawToken: string, id: string, raw: unknown) =>
      transact(null, rawToken, true, async (c, t, orderId, on, auth) => {
        installed(on);
        uuid.parse(id);
        const b = applyInput.parse(body(raw)),
          f = await publicFrame(c, t, orderId!, auth, true, true),
          p = (
            await c.query(
              "SELECT * FROM buyer_address_previews WHERE tenant_id=$1 AND order_id=$2 AND id=$3 AND kind='delivery' AND token_digest=$4",
              [t, orderId, id, auth.hash],
            )
          ).rows[0];
        ensure(p, 404, 'Nie znaleziono własnego podglądu');
        ensure(p.scope_hash === b.scope_hash, 409, 'Zgoda dotyczy innego zakresu');
        const old = (
          await c.query(
            'SELECT * FROM buyer_address_receipts WHERE tenant_id=$1 AND order_id=$2 AND preview_id=$3',
            [t, orderId, id],
          )
        ).rows[0];
        const r = await apply(c, f, p, b.client_key, sha(canonical(b)), auth),
          fresh = await frame(c, t, orderId!);
        if (!old && r.changed) {
          const detail = {
            change_id: r.id,
            scope_hash: r.scope_hash,
            source: 'buyer',
            changed_keys: Object.keys(delivery.shape).filter(
              (k) =>
                (evidence(r, f, cfg.encryptionKey).before as any)?.[k] !==
                (evidence(r, f, cfg.encryptionKey).after as any)?.[k],
            ),
            before_version: String(r.before_order_version),
            after_version: String(r.after_order_version),
          };
          await (
            await import('./events')
          ).localOrderEvent(c, t, orderId!, 'order.delivery_address_changed', detail);
          await (
            await import('./domain')
          ).audit(
            c,
            { tenantId: t, userId: null, source: 'system' },
            'buyer.delivery_address.changed',
            orderId,
            detail,
          );
        }
        await duty(c, fresh, cfg.encryptionKey, auth, {
          requirePolicy: true,
          eligibility: !old,
          expiresAt: old ? null : p.expires_at,
        });
        return { statusCode: old ? 200 : 201, body: receiptDto(r, f, auth.hash, !!old) };
      }),
    adminAccess: (req: BuyerAddressRequest, id: string, raw: unknown) => {
      const a = requestActor(req, cfg.sessionName);
      return transact(a, null, true, async (c, t, _id, on, auth) => {
        installed(on);
        uuid.parse(id);
        const b = accessInput.parse(body(raw)),
          f = await frame(c, t, id, 'update');
        await identity(c, a, true);
        ensure(
          f.order.version === b.version && f.state.version === b.policy_version,
          409,
          'Zmieniono wersję zamówienia lub polityki',
        );
        const after = { ...f.state };
        if (b.delivery_kind) {
          ensure(
            b.delivery_kind !== 'address' || !f.order.address.locker_code,
            409,
            'Dostawa do punktu nie jest adresem',
          );
          after.delivery_kind = b.delivery_kind;
          after.classification_origin = 'operator_confirmed';
        }
        after.enabled = b.enabled;
        ensure(
          !after.enabled || after.delivery_kind !== 'unknown',
          422,
          'Wymagane jawne potwierdzenie rodzaju dostawy',
        );
        const before = effective(f, cfg.encryptionKey).delivery,
          afterDelivery = effective({ ...f, state: after }, cfg.encryptionKey).delivery,
          changed = canonical(after) !== canonical(f.state),
          reserved = randomUUID();
        if (changed) {
          after.version = (BigInt(after.version) + 1n).toString();
          after.last_receipt_id = reserved;
        }
        const ck = randomUUID(),
          requestHash = sha(canonical(b)),
          p = await prepare(
            c,
            f,
            auth,
            'access',
            ck,
            requestHash,
            after,
            changed,
            before,
            afterDelivery,
            reserved,
          ),
          r = await apply(c, f, p, ck, requestHash, auth);
        await (
          await import('./domain')
        ).audit(c, a, 'buyer.address.access', id, {
          receipt_id: r.id,
          enabled: after.enabled,
          delivery_kind: after.delivery_kind,
          classification_origin: after.classification_origin,
          changed,
        });
        const fresh = await frame(c, t, id);
        await duty(c, fresh, cfg.encryptionKey, auth, { requirePolicy: false });
        return { ...(await operatorStatus(c, t, id, true, a)), changed, receipt_id: r.id };
      });
    },
    history: (req: BuyerAddressRequest, id: string, query: unknown) => {
      const a = requestActor(req, cfg.sessionName);
      return transact(a, null, false, async (c, t, _id, on, auth) => {
        installed(on);
        uuid.parse(id);
        const q = z.strictObject({ cursor: z.string().max(4096).optional() }).parse(query),
          f = await frame(c, t, id),
          bound = {
            v: 1,
            tenant: t,
            order: id,
            user: a.userId,
            key: a.apiKeyId ?? null,
            auth: auth.initial,
            readonly: cfg.readOnly,
            limit: 20,
          };
        let after: { stamp: string; id: string } | null = null;
        if (q.cursor) {
          const [text, mac, ...rest] = q.cursor.split('.');
          ensure(
            !rest.length && /^[A-Za-z0-9_-]+$/.test(text ?? '') && /^[a-f0-9]{64}$/.test(mac ?? ''),
            422,
            'Niepoprawny kursor',
          );
          const expected = createHmac('sha256', Buffer.from(cfg.encryptionKey, 'hex'))
            .update('buyer-address-history/v1\0' + text)
            .digest();
          ensure(timingSafeEqual(expected, Buffer.from(mac, 'hex')), 422, 'Niepoprawny kursor');
          let decoded: any;
          try {
            decoded = JSON.parse(Buffer.from(text, 'base64url').toString());
          } catch {
            throw new Problem(422, 'Niepoprawny kursor');
          }
          for (const k of Object.keys(bound) as (keyof typeof bound)[])
            ensure(decoded[k] === bound[k], 409, 'Kursor dotyczy innego zakresu');
          after = z
            .strictObject({ stamp: z.string().datetime({ offset: true }), id: uuid })
            .parse(decoded.after);
        }
        const rows = (
          await c.query(
            'SELECT *,to_char(created_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') stamp FROM buyer_address_receipts WHERE tenant_id=$1 AND order_id=$2 AND($3::timestamptz IS NULL OR(created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT 21',
            [t, id, after?.stamp ?? null, after?.id ?? null],
          )
        ).rows;
        const page = rows.slice(0, 20),
          lastRow = page.at(-1);
        let nextCursor: string | null = null;
        if (rows.length > 20) {
          const text = Buffer.from(
            canonical({ ...bound, after: { stamp: lastRow.stamp, id: lastRow.id } }),
          ).toString('base64url');
          nextCursor =
            text +
            '.' +
            createHmac('sha256', Buffer.from(cfg.encryptionKey, 'hex'))
              .update('buyer-address-history/v1\0' + text)
              .digest('hex');
        }
        const data = page.map((r) => {
          const e = evidence(r, f, cfg.encryptionKey);
          return {
            id: r.id,
            kind: r.kind,
            changed: r.changed,
            created_at: utc(r.created_at),
            before: e.before,
            after: e.after,
            before_policy: policy(projection.parse(r.before_state)),
            after_policy: policy(projection.parse(r.after_state)),
          };
        });
        await duty(c, f, cfg.encryptionKey, auth, { requirePolicy: false });
        return { data, next_cursor: nextCursor };
      });
    },
  };
}

/** Recovery's owner reader calls this inside its existing consistent read-only
 * snapshot. No row locks, role/GUC changes, application bootstrap or side effects.
 * SQL-role authority is not inferred from successfully decrypted historical data. */
export async function validateRecoveredBuyerAddresses(
  c: Pick<PoolClient, 'query'>,
  encryptionKey: string,
) {
  const names = [
    'buyer_address_state',
    'buyer_address_previews',
    'buyer_address_receipts',
  ];
  const found = (
    await c.query(
      "SELECT relname::text name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname=ANY($1::text[])",
      [names],
    )
  ).rows.map((r) => r.name);
  if (!found.length) {
    const remnants = (
      await c.query(
        "SELECT EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'buyer_address_')) OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'buyer_address_')) OR EXISTS(SELECT FROM pg_trigger WHERE starts_with(tgname,'buyer_address_')) OR EXISTS(SELECT FROM public.migrations WHERE name='166_buyer_address_sidecar') bad",
      )
    ).rows[0].bad;
    ensure(!remnants, 503, 'Niekompletny odzyskany moduł adresu');
    return { records: 0, states: 0, previews: 0, receipts: 0 };
  }
  ensure(found.length === 3, 503, 'Niekompletny odzyskany moduł adresu');
  ensure(
    (await c.query('SELECT buyer_address_guards() ok')).rows[0].ok === true,
    503,
    'Odzyskany schemat adresu nie przeszedł walidacji',
  );
  const zero: State = {
    version: '0',
    delivery_version: '0',
    enabled: false,
    delivery_kind: 'unknown',
    classification_origin: 'unknown',
    delivery_override_encrypted: null,
    override_byte_count: null,
    override_sha256: null,
    last_receipt_id: null,
  };
  function stateRow(row: any): State {
    return projection.parse({
      version: String(row.version),
      delivery_version: String(row.delivery_version),
      enabled: row.enabled,
      delivery_kind: row.delivery_kind,
      classification_origin: row.classification_origin,
      delivery_override_encrypted: row.delivery_override_encrypted,
      override_byte_count: row.override_byte_count,
      override_sha256: row.override_sha256,
      last_receipt_id: row.last_receipt_id,
    });
  }
  async function recoveredFrame(t: string, id: string): Promise<Frame> {
    const order = (
      await c.query(
        'SELECT *,version::text version FROM orders WHERE tenant_id=$1 AND id=$2',
        [t, id],
      )
    ).rows[0];
    ensure(order, 503, 'Brak rodzica odzyskanego adresu');
    const state = (
      await c.query(
        'SELECT * FROM buyer_address_state WHERE tenant_id=$1 AND order_id=$2',
        [t, id],
      )
    ).rows[0];
    const basis = (
      await c.query(
        "SELECT buyer_address_hash(jsonb_build_object('tenant_id',$1::uuid,'order_id',$2::uuid,'customer_name',$3::text,'email',$4::text,'address',$5::jsonb)) hash",
        [
          t,
          id,
          order.customer_name,
          order.email,
          JSON.stringify(order.address),
        ],
      )
    ).rows[0].hash;
    return {
      order,
      state: state ? stateRow(state) : zero,
      buyer_basis_hash: basis,
    };
  }
  // Historical209 validation never calls the current-XID/expiry admission function.
  // Select an explicit safe projection: credential_hash is deliberately never read.
  async function recoveredInheritance(row: any) {
    if (row.kind !== 'merge_inherit') return;
    const rows = (
      await c.query(
        `SELECT r.tenant_id,r.execution_id,r.source_order_id,r.target_order_id,r.merge_preview_id,r.actor_id,r.api_key_id,
      r.preview_id,r.receipt_id,r.scope_hash,r.request_hash,r.sidecar_scope_hash,r.source_frames,r.source_state,r.source_buyer_basis_hash,r.target_buyer_basis_hash,
      r.before_state,r.after_state,r.target_order_version::text,r.evidence_encrypted,r.evidence_byte_count,r.evidence_sha256,r.root_xid::text,
      r.transaction_started_at::text,r.created_at::text,r.expires_at::text,
      e.id parent_id,e.preview_id parent_preview,e.actor_id parent_actor,e.api_key_id parent_key,e.main_order_id parent_main,e.target_order_id parent_target,
      e.client_key parent_client_key,e.source_ids parent_sources,e.scope_hash parent_scope,e.request_hash parent_request,e.merge_mode parent_mode,e.state parent_state,
      e.before_snapshot parent_before,e.after_snapshot->'target' target_header,
      p.snapshot merge_snapshot,p.actor_id merge_actor,p.api_key_id merge_key,p.main_order_id merge_main,p.target_order_id merge_target,p.source_ids merge_sources,p.scope_hash merge_scope,p.ready merge_ready,p.expires_at::text merge_expires_at
      FROM order_merge_delivery209_receipts r
      LEFT JOIN order_merge_executions e ON(e.tenant_id,e.id)=(r.tenant_id,r.execution_id)
      LEFT JOIN order_merge_previews p ON(p.tenant_id,p.id)=(r.tenant_id,r.merge_preview_id)
      WHERE r.tenant_id=$1 AND r.target_order_id=$2 AND(r.preview_id=$3 OR r.receipt_id=$3)`,
        [row.tenant_id, row.order_id, row.id],
      )
    ).rows;
    ensure(
      rows.length === 1,
      503,
      'Brak jedynego rodzica odzyskanego dziedziczenia',
    );
    const r = rows[0],
      v = readOrderMergeDeliveryInheritanceEvidence(
        {
          encrypted: row.evidence_encrypted,
          byte_count: row.evidence_byte_count,
          sha256: row.evidence_sha256,
        },
        encryptionKey,
      );
    ensure(
      r.parent_id === r.execution_id &&
        r.parent_preview === r.merge_preview_id &&
        r.parent_mode === 'technical_merge' &&
        r.parent_state === 'done' &&
        r.merge_ready === true &&
        canonical(r.parent_before) === canonical(r.merge_snapshot) &&
        canonical(r.source_frames) ===
          canonical(r.parent_before?.buyer_delivery_frames) &&
        r.parent_actor === r.actor_id &&
        r.merge_actor === r.actor_id &&
        (r.parent_key ?? null) === (r.api_key_id ?? null) &&
        (r.merge_key ?? null) === (r.api_key_id ?? null) &&
        r.parent_main === r.source_order_id &&
        r.merge_main === r.source_order_id &&
        r.parent_target === r.target_order_id &&
        r.merge_target === r.target_order_id &&
        r.parent_scope === r.scope_hash &&
        r.merge_scope === r.scope_hash &&
        r.parent_request === r.request_hash &&
        canonical(r.parent_sources) === canonical(r.merge_sources),
      503,
      'Niezgodny historyczny rodzic dziedziczenia',
    );
    const sourceOrders = r.parent_before?.orders;
    ensure(
      Array.isArray(sourceOrders) &&
        Array.isArray(r.parent_sources) &&
        sourceOrders.length >= 2 &&
        sourceOrders.length <= 100 &&
        Array.isArray(r.source_frames) &&
        r.source_frames.length === sourceOrders.length &&
        new Set(r.source_frames.map((f: any) => f.order_id)).size ===
          sourceOrders.length &&
        canonical(sourceOrders.map((o: any) => o.id).sort()) ===
          canonical([...r.parent_sources].sort()),
      503,
      'Niekompletne odzyskane źródła adresu',
    );
    for (const f of r.source_frames) {
      const o = sourceOrders.find((o: any) => o.id === f.order_id);
      ensure(
        o && o.tenant_id === row.tenant_id,
        503,
        'Obce odzyskane źródło adresu',
      );
      const actual = authenticateOrderMergeDeliverySource(
        { order: o, state: f.state, buyer_basis_hash: f.buyer_basis_hash },
        encryptionKey,
      );
      ensure(
        canonical(actual.snapshot) === canonical(f),
        503,
        'Zmieniony odzyskany source frame',
      );
      const basis = (
        await c.query(
          "SELECT buyer_address_hash(jsonb_build_object('tenant_id',$1::uuid,'order_id',$2::uuid,'customer_name',$3::text,'email',$4::text,'address',$5::jsonb)) hash",
          [
            o.tenant_id,
            o.id,
            o.customer_name,
            o.email,
            JSON.stringify(o.address),
          ],
        )
      ).rows[0]?.hash;
      ensure(
        basis === f.buyer_basis_hash,
        503,
        'Zmieniona historyczna podstawa źródła',
      );
      if (f.state.version !== '0') {
        const parent = (
          await c.query(
            'SELECT after_state,buyer_basis_hash,changed FROM buyer_address_receipts WHERE tenant_id=$1 AND order_id=$2 AND id=$3',
            [o.tenant_id, o.id, f.state.last_receipt_id],
          )
        ).rows[0];
        ensure(
          parent?.changed === true &&
            parent.buyer_basis_hash === basis &&
            canonical(parent.after_state) === canonical(f.state),
          503,
          'Brak własnej historycznej linii źródła',
        );
      }
    }
    const f = r.source_frames.find(
        (f: any) => f.order_id === r.source_order_id,
      ),
      o = sourceOrders.find((o: any) => o.id === r.source_order_id),
      target = r.target_header;
    ensure(
      f &&
        o &&
        target &&
        target.id === r.target_order_id &&
        target.tenant_id === row.tenant_id &&
        target.portal_enabled === o.portal_enabled &&
        target.portal_expires_at === o.portal_expires_at &&
        /^[a-f0-9]{48}$/.test(target.portal_token) &&
        !sourceOrders.some(
          (o: any) => o.portal_token === target.portal_token,
        ) &&
        canonical([
          o.customer_name,
          o.email,
          o.address,
          o.b2b_account_id ?? null,
        ]) ===
          canonical([
            target.customer_name,
            target.email,
            target.address,
            target.b2b_account_id ?? null,
          ]) &&
        String(target.version) === r.target_order_version &&
        r.source_buyer_basis_hash === f.buyer_basis_hash &&
        canonical(r.source_state) === canonical(f.state),
      503,
      'Zmieniony historyczny cel dziedziczenia',
    );
    const targetBasis = (
      await c.query(
        "SELECT buyer_address_hash(jsonb_build_object('tenant_id',$1::uuid,'order_id',$2::uuid,'customer_name',$3::text,'email',$4::text,'address',$5::jsonb)) hash",
        [
          target.tenant_id,
          target.id,
          target.customer_name,
          target.email,
          JSON.stringify(target.address),
        ],
      )
    ).rows[0]?.hash;
    ensure(
      targetBasis === r.target_buyer_basis_hash,
      503,
      'Zmieniona historyczna podstawa celu',
    );
    const self = readOrderMergeDeliveryInheritanceEvidence(
      {
        encrypted: r.evidence_encrypted,
        byte_count: r.evidence_byte_count,
        sha256: r.evidence_sha256,
      },
      encryptionKey,
    );
    ensure(
      canonical(v) === canonical(self) &&
        self.tenant_id === r.tenant_id &&
        self.execution_id === r.execution_id &&
        self.merge_preview_id === r.merge_preview_id &&
        self.scope_hash === r.scope_hash &&
        self.target_order_id === r.target_order_id &&
        canonical(self.source_frame) === canonical(f),
      503,
      'Zmieniony kontekst odzyskanego dowodu',
    );
    // Compare the encrypted source header to the immutable MERGE header, not today's mutable order.
    ensure(
      canonical(self.source.order) ===
        canonical({
          id: o.id,
          tenant_id: o.tenant_id,
          version: o.version,
          customer_name: o.customer_name,
          email: o.email,
          address: o.address,
        }),
      503,
      'Zmieniony zaszyfrowany zakres źródła',
    );
    for (const k of [
      'actor_id',
      'api_key_id',
      'request_hash',
      'evidence_encrypted',
      'evidence_byte_count',
      'evidence_sha256',
    ])
      ensure(
        (row[k] ?? null) === (r[k] ?? null),
        503,
        'Niezgodny odzyskany tuple dziedziczenia',
      );
    ensure(
      row.client_key === r.parent_client_key &&
        row.token_digest === null &&
        row.scope_hash === r.sidecar_scope_hash &&
        row.buyer_basis_hash === r.target_buyer_basis_hash &&
        canonical(row.before_state) === canonical(r.before_state) &&
        canonical(row.after_state) === canonical(r.after_state) &&
        (row.reserved_receipt_id ?? row.id) === r.receipt_id &&
        (row.preview_id ?? row.id) === r.preview_id &&
        String(row.expected_order_version ?? row.before_order_version) ===
          r.target_order_version &&
        (row.after_order_version === undefined ||
          String(row.after_order_version) === r.target_order_version) &&
        /^[0-9]+$/.test(r.root_xid) &&
        Number.isFinite(Date.parse(r.transaction_started_at)) &&
        Date.parse(r.created_at) >= Date.parse(r.transaction_started_at) &&
        Date.parse(r.expires_at) > Date.parse(r.created_at) &&
        Date.parse(r.expires_at) <= Date.parse(r.created_at) + 900000 &&
        Number.isFinite(Date.parse(r.merge_expires_at)) && Date.parse(r.created_at)<Date.parse(r.merge_expires_at) &&
        row.recovery_created_at===r.created_at &&
        (row.id===r.preview_id||(row.recovery_top_xid===r.root_xid&&row.recovery_transaction_started_at===r.transaction_started_at)),
      503,
      'Niezgodny historyczny zakres własnego dowodu',
    );
  }
  const totals = { records: 0, states: 0, previews: 0, receipts: 0 };
  let stateAfter: { tenant: string; order: string } | null = null;
  while (true) {
    const rows: any[] = (
      await c.query(
        'SELECT * FROM buyer_address_state WHERE($1::uuid IS NULL OR(tenant_id,order_id)>($1::uuid,$2::uuid)) ORDER BY tenant_id,order_id LIMIT 100',
        [stateAfter?.tenant ?? null, stateAfter?.order ?? null],
      )
    ).rows;
    if (!rows.length) break;
    for (const row of rows) {
      const f = await recoveredFrame(row.tenant_id, row.order_id);
      effective(f, encryptionKey);
      const r = (
        await c.query(
          'SELECT *,created_at::text recovery_created_at,transaction_started_at::text recovery_transaction_started_at,top_xid::text recovery_top_xid FROM buyer_address_receipts WHERE tenant_id=$1 AND order_id=$2 AND id=$3',
          [row.tenant_id, row.order_id, row.last_receipt_id],
        )
      ).rows[0];
      ensure(
        r && r.changed && canonical(r.after_state) === canonical(f.state),
        503,
        'Odzyskany sidecar nie wskazuje własnego dowodu',
      );
      await recoveredInheritance(r);
      evidence(r, f, encryptionKey);
      totals.states++;
      if (row.delivery_override_encrypted !== null) totals.records++;
    }
    const last: any = rows.at(-1);
    stateAfter = { tenant: last.tenant_id, order: last.order_id };
  }
  for (const table of [
    'buyer_address_previews',
    'buyer_address_receipts',
  ] as const) {
    let after: string | null = null;
    while (true) {
      const rows: any[] = (
        await c.query(
          'SELECT *,created_at::text recovery_created_at' +
            (table==='buyer_address_receipts'?',transaction_started_at::text recovery_transaction_started_at,top_xid::text recovery_top_xid':'') +
            ' FROM ' + table +
            ' WHERE($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT 100',
          [after],
        )
      ).rows;
      if (!rows.length) break;
      for (const row of rows) {
        const f = await recoveredFrame(row.tenant_id, row.order_id);
        ensure(
          row.buyer_basis_hash === f.buyer_basis_hash,
          503,
          'Odzyskany dowód ma zmieniony pierwotny zakres nabywcy',
        );
        await recoveredInheritance(row);
        evidence(row, f, encryptionKey);
        const before = projection.parse(row.before_state),
          next = projection.parse(row.after_state);
        ensure(
          row.changed === (canonical(before) !== canonical(next)),
          503,
          'Zmiana odzyskanego dowodu różni się',
        );
        if (table === 'buyer_address_receipts') {
          const p = (
            await c.query(
              'SELECT * FROM buyer_address_previews WHERE tenant_id=$1 AND order_id=$2 AND id=$3',
              [row.tenant_id, row.order_id, row.preview_id],
            )
          ).rows[0];
          ensure(
            p && p.reserved_receipt_id === row.id,
            503,
            'Brak własnego podglądu odzyskanego dowodu',
          );
          for (const key of [
            'kind',
            'actor_id',
            'api_key_id',
            'token_digest',
            'scope_hash',
            'buyer_basis_hash',
            'evidence_encrypted',
            'evidence_byte_count',
            'evidence_sha256',
            'changed',
          ])
            ensure(
              row[key] === p[key],
              503,
              'Niezgodny tuple odzyskanego dowodu',
            );
          ensure(
            canonical(p.before_state) === canonical(row.before_state) &&
              canonical(p.after_state) === canonical(row.after_state) &&
              String(p.expected_order_version) ===
                String(row.before_order_version),
            503,
            'Niezgodny zamrożony zakres odzyskanego dowodu',
          );
          totals.receipts++;
        } else {
          const scoped = {
            id: row.id,
            reserved_receipt_id: row.reserved_receipt_id,
            kind: row.kind,
            tenant_id: row.tenant_id,
            order_id: row.order_id,
            request_hash: row.request_hash,
            token_digest: row.token_digest,
            actor_id: row.actor_id,
            api_key_id: row.api_key_id,
            buyer_basis_hash: row.buyer_basis_hash,
            order_version: String(row.expected_order_version),
            before_state: row.before_state,
            after_state: row.after_state,
            evidence_sha256: row.evidence_sha256,
          };
          const h = (
            await c.query('SELECT buyer_address_hash($1::jsonb) hash', [
              JSON.stringify(scoped),
            ])
          ).rows[0].hash;
          ensure(
            h === row.scope_hash,
            503,
            'Niezgodny zakres odzyskanego podglądu',
          );
          totals.previews++;
        }
        totals.records++;
      }
      after = rows.at(-1).id;
    }
  }
  const successor = (
    await c.query(
      "SELECT to_regclass('public.order_merge_delivery209_receipts') present",
    )
  ).rows[0]?.present;
  if (successor) {
    const bad = (
      await c.query(`SELECT EXISTS(SELECT FROM order_merge_delivery209_receipts r
      LEFT JOIN buyer_address_previews p ON(p.tenant_id,p.order_id,p.id)=(r.tenant_id,r.target_order_id,r.preview_id)
      LEFT JOIN buyer_address_receipts b ON(b.tenant_id,b.order_id,b.id)=(r.tenant_id,r.target_order_id,r.receipt_id)
      WHERE p.id IS NULL OR b.id IS NULL OR p.kind<>'merge_inherit' OR b.kind<>'merge_inherit') bad`)
    ).rows[0]?.bad;
    ensure(bad === false, 503, 'Osierocony odzyskany dowód dziedziczenia');
  }
  return totals;
}

export { accessInput as buyerAddressAccessInput };
