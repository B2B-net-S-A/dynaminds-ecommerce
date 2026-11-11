/** SOURCE AUTHOR / NOT_RUN. Root executes only on its quiet, genuine restored167
 * copy. Config and DATABASE_URL must be set before app/db imports. No migration,
 * signup, address correction, API-key mint, readonly toggle, listener or provider.
 * Required WX0600 fixture: {email,password,tenant_id,user_id,order_id,
 * expected_delivery:{recipient_name,street,city,postal_code,country,phone}}.
 * Select an actual corrected synthetic order WITHOUT a parcel plan (the native167
 * manual-label fixture is suitable). Missing source credentials is a dependency,
 * never permission to manufacture a session. Root owns archive/source/cluster
 * custody; this gate proves native normal-cookie reads and pre-parser refusals.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Client, Pool } from 'pg';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { BuyerDeliveryAddress166 } from '../server/buyer-delivery-address';

type Row = Record<string, any>;
type Fixture = { email: string; password: string; tenant_id: string; user_id: string;
  order_id: string; expected_delivery: BuyerDeliveryAddress166 };
let app: FastifyInstance | undefined, pool: Pool | undefined, reader: Client | undefined;
let fixture: Fixture, previewPort: number, cookie = '', providerCalls = 0, fetchCalls = 0;
let originalFetch: typeof globalThis.fetch | undefined;
const refusedFetch: typeof globalThis.fetch = async () => { ++fetchCalls; throw Error('Provider HTTP is forbidden in readonly167'); };
let preserve: typeof import('../scripts/stocktake-adjustments-native164-preservation').captureStocktakeAdjustmentPreservation;
const guards = ['catalog_stock_control_guards','catalog_stock_return_guards','catalog_stock_count_guards',
  'catalog_stock_legacy_group_guards','stocktake_adjustment_guards','warehouse_automatic_wz_guards',
  'warehouse_wz_issuer_guards','allegro_oauth_recovery_guards','product_rule_price_tags_guards',
  'product_rule_schedule_guards','packed_label_print_guards','label_print_guards','print_job_guards',
  'local_invoice_guards','fa3_draft_guards','b2b_invoice_guards','b2b_credit_guards',
  'credit_source_upgrade_valid','financial_return_guards','financial_return_upgrade_valid',
  'competitor_observation_guards','buyer_address_guards','operative_delivery_valid'] as const;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k,x]) => JSON.stringify(k)+':'+canonical(x)).join(',') + '}';
  assert(v === null || ['string','boolean','number'].includes(typeof v)); return JSON.stringify(v);
};
async function capture() {
  assert(reader);
  await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await reader.query("SET LOCAL TimeZone='UTC'");
    const graph = await preserve(reader);
    assert.equal(Object.keys(graph.rows).length, 562, 'Actual committed167 restored catalog');
    assert.equal(graph.rows.migrations.length, 167);
    assert.equal(graph.rows.migrations.filter((r: Row) => r.row.name === '167_operational_delivery_consumers').length, 1);
    const guardState = (await reader.query('SELECT '+guards.map(n => 'public.'+n+'() '+n).join(','))).rows[0];
    assert.equal(Object.keys(guardState).length, 23); assert(Object.values(guardState).every(v => v === true));
    const primary_keys = (await reader.query(`SELECT c.relname,array_agg(a.attname::text ORDER BY k.ordinality) fields
      FROM pg_class c JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
      JOIN pg_attribute a ON(a.attrelid,a.attnum)=(c.oid,k.attnum)
      WHERE c.relnamespace='public'::regnamespace GROUP BY c.relname ORDER BY c.relname`)).rows;
    assert.deepEqual(primary_keys.map((r: Row) => r.relname).sort(), Object.keys(graph.rows).sort());
    const sequences: Row[] = [];
    for (const { sequencename } of (await reader.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY 1")).rows) {
      assert(/^[a-z][a-z0-9_]*$/.test(sequencename));
      sequences.push({ name: sequencename,
        ...(await reader.query('SELECT last_value::text,is_called FROM public."'+sequencename+'"')).rows[0],
        options: (await reader.query('SELECT seqtypid,seqstart::text,seqincrement::text,seqmax::text,seqmin::text,seqcache::text,seqcycle FROM pg_sequence WHERE seqrelid=$1::regclass',['public.'+sequencename])).rows[0] });
    }
    const views = (await reader.query("SELECT viewname,definition FROM pg_views WHERE schemaname='public' ORDER BY viewname")).rows;
    await reader.query('COMMIT'); return { graph, guards: guardState, primary_keys, sequences, views };
  } catch (e) { await reader.query('ROLLBACK'); throw e; }
}
type Snapshot = Awaited<ReturnType<typeof capture>>;
let baseline: Snapshot | undefined, afterLogin: Snapshot | undefined;
const rows = (s: Snapshot, table: string): Row[] => s.graph.rows[table].map((r: Row) => r.row);
const one = (xs: Row[]) => { assert.equal(xs.length, 1); return xs[0]; };
function assertOnlyLogin(b: Snapshot, a: Snapshot, token?: string) {
  const old = rows(b,'sessions'), current = rows(a,'sessions');
  assert.equal(current.length, old.length + 1);
  for (const session of old) assert.deepEqual(one(current.filter(r => r.token_hash === session.token_hash)), session, 'Every old session literal');
  const fresh = one(current.filter(r => !old.some(s => s.token_hash === r.token_hash)));
  assert.equal(fresh.user_id, fixture.user_id); assert.equal(fresh.tenant_id, fixture.tenant_id);
  if (token !== undefined) assert.equal(fresh.token_hash, sha(token));
  assert.equal(Date.parse(fresh.expires_at)-Date.parse(fresh.created_at),8*60*60*1000);
  const restored = { ...a, graph: { ...a.graph, rows: { ...a.graph.rows, sessions: b.graph.rows.sessions } } };
  assert.deepEqual(restored,b,'Only one native new session; all562 business rows, certificate, exact metadata, PKs, sequences and views literal');
}
async function privateJson(path: string | undefined, digest: string | undefined) {
  assert(typeof path === 'string' && isAbsolute(path)); assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest));
  const stat = await lstat(path); assert(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.mode & 0o777,0o600);
  const bytes = await readFile(path); assert.equal(sha(bytes),digest,'Root-pinned private input bytes'); return JSON.parse(bytes.toString('utf8'));
}
before(async () => {
  assert.equal(process.env.DYNA_TEST,'true'); assert.equal(process.env.DYNA_OPERATIONAL_DELIVERY_READONLY_NATIVE,'true');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname)); assert.equal(url.port,'55432');
  assert.match(url.pathname,/^\/dynaminds_restore_[a-f0-9]{16}$/,'Root-owned genuine restored167 database only');
  const config = await privateJson(process.env.DYNA_LOCAL_CONFIG_PATH,process.env.DYNA_RO167_CONFIG_SHA256);
  assert(typeof config.encryptionKey === 'string' && /^[a-f0-9]{64}$/.test(config.encryptionKey));
  fixture = await privateJson(process.env.DYNA_RO167_FIXTURE_PATH,process.env.DYNA_RO167_FIXTURE_SHA256);
  assert.deepEqual(Object.keys(fixture).sort(),['email','expected_delivery','order_id','password','tenant_id','user_id'].sort());
  assert(uuid(fixture.tenant_id) && uuid(fixture.user_id) && uuid(fixture.order_id));
  assert(typeof fixture.email === 'string' && fixture.email.includes('@')); assert(typeof fixture.password === 'string' && fixture.password.length >= 8);
  assert.deepEqual(Object.keys(fixture.expected_delivery).sort(),['recipient_name','street','city','postal_code','country','phone'].sort());
  assert(Object.values(fixture.expected_delivery).every(v => typeof v === 'string' && v.length > 0));
  assert.match(process.env.DYNA_RO167_PREVIEW_PORT ?? '',/^41[0-9]{2}$/);
  previewPort = Number(process.env.DYNA_RO167_PREVIEW_PORT); assert(previewPort >= 4101 && previewPort <= 4199);
  originalFetch = globalThis.fetch; globalThis.fetch = refusedFetch;
  const { Client: NativeClient } = (await import('pg')).default;
  reader = new NativeClient({connectionString: process.env.DATABASE_URL}); await reader.connect();
  ({captureStocktakeAdjustmentPreservation: preserve} = await import('../scripts/stocktake-adjustments-native164-preservation'));
  baseline = await capture();
  const o = one(rows(baseline,'orders').filter(r => r.tenant_id === fixture.tenant_id && r.id === fixture.order_id));
  const state = one(rows(baseline,'buyer_address_state').filter(r => r.tenant_id === fixture.tenant_id && r.order_id === fixture.order_id));
  assert.equal(state.delivery_kind,'address'); assert.equal(typeof state.delivery_override_encrypted,'string');
  assert(uuid(state.last_receipt_id)); assert(rows(baseline,'buyer_address_receipts').some(r => r.tenant_id === fixture.tenant_id && r.order_id === fixture.order_id && r.id === state.last_receipt_id));
  assert.equal(rows(baseline,'order_parcel_plans').filter(r => r.tenant_id === fixture.tenant_id && r.order_id === fixture.order_id).length,0,'Use corrected order without legacy or current parcel plan');
  assert.notDeepEqual({recipient_name:o.customer_name,street:o.address.street,city:o.address.city,postal_code:o.address.postal_code,country:o.address.country,phone:o.address.phone},fixture.expected_delivery,'Fixture really corrects the original operational receiver');
  const membership = one(rows(baseline,'memberships').filter(r => r.user_id === fixture.user_id && r.tenant_id === fixture.tenant_id)); assert.equal(membership.role,'admin');
  const security = rows(baseline,'account_security').find(r => r.user_id === fixture.user_id); assert(!security?.secret_encrypted,'No factor-consumption mutation in this session-only gate');
  const mfa = rows(baseline,'workspace_security_policies').find(r => r.tenant_id === fixture.tenant_id); assert(!mfa?.require_mfa,'Select genuine non-MFA own fixture; never disable policy');
  ({pool} = await import('../server/db'));
  const {buildApp} = await import('../server/app');
  app = await buildApp({readOnly:true,previewPort,logging:false,backgroundWorkersEnabled:false,
    integrationTransport:async () => { ++providerCalls; throw Error('Provider transport forbidden in readonly167'); }});
  assert.deepEqual(await capture(),baseline,'Building the actual readonly app creates no persistent row');
});
after(async () => {
  let failure: unknown;
  try { if (app) await app.close(); } catch (e) { failure = e; }
  try { if (baseline && reader) { const final = await capture(); if (afterLogin) assert.deepEqual(final,afterLogin,'After app.close all native reads/refusals remain literal'); else assert.deepEqual(final,baseline,'Failed prelogin setup has no writes'); } } catch (e) { failure ??= e; }
  try { if (reader) await reader.end(); } catch (e) { failure ??= e; }
  if (pool) {
    const waiting = pool.waitingCount, checkedOut = pool.totalCount-pool.idleCount;
    try { await pool.end(); } catch (e) { failure ??= e; }
    try { assert.equal(waiting,0); assert.equal(checkedOut,0); assert.equal(pool.totalCount,0); } catch (e) { failure ??= e; }
  }
  cookie = ''; if (fixture) fixture.password = '';
  if (originalFetch !== undefined) {
    try { assert.equal(globalThis.fetch,refusedFetch,'Owned provider hook was replaced'); } catch (e) { failure ??= e; }
    globalThis.fetch = originalFetch;
  }
  try { assert.equal(fetchCalls,0); assert.equal(providerCalls,0); } catch (e) { failure ??= e; }
  if (failure) throw failure;
});

test('real secureLogin creates exactly one own preview-cookie session and trusts readonly auth context', async () => {
  assert(app && baseline && reader);
  const from = (await reader.query('SELECT clock_timestamp()::text now')).rows[0].now;
  const login = await app.inject({method:'POST',url:'/api/auth/login',payload:{email:fixture.email,password:fixture.password},remoteAddress:'127.0.167.31'});
  assert.equal(login.statusCode,200,'Genuine password login, no forged token');
  const body = login.json(); assert.equal(body.user.id,fixture.user_id); assert.equal(body.user.tenant_id,fixture.tenant_id); assert.equal(body.user.role,'admin');
  const set = login.headers['set-cookie']; assert(typeof set === 'string' || Array.isArray(set));
  const matches = (Array.isArray(set) ? set : [set]).filter((v: string) => v.startsWith('dyna_session_preview_'+previewPort+'=')); assert.equal(matches.length,1);
  cookie = matches[0].split(';')[0]; const token = decodeURIComponent(cookie.slice(cookie.indexOf('=')+1)); assert.match(token,/^[a-f0-9]{64}$/);
  afterLogin = await capture(); assertOnlyLogin(baseline,afterLogin,token);
  const to = (await reader.query('SELECT clock_timestamp()::text now')).rows[0].now;
  const fresh = one(rows(afterLogin,'sessions').filter(r => r.token_hash === sha(token)));
  assert(Date.parse(fresh.created_at) >= Date.parse(from) && Date.parse(fresh.created_at) <= Date.parse(to));
  const me = await app.inject({method:'GET',url:'/api/auth/me',headers:{cookie}}); assert.equal(me.statusCode,200);
  assert.equal(me.json().restore_preview,true); assert.equal(me.json().user.id,fixture.user_id); assert.equal(me.json().user.tenant_id,fixture.tenant_id);
  assert.deepEqual(await capture(),afterLogin,'Auth/me is a real readonly GET with no extra session or business delta');
});

test('normal operator parcel source exposes exact six corrected fields and typed binding without persistent evidence', async () => {
  assert(app && baseline && afterLogin && cookie);
  const state = one(rows(baseline,'buyer_address_state').filter(r => r.tenant_id === fixture.tenant_id && r.order_id === fixture.order_id));
  const order = one(rows(baseline,'orders').filter(r => r.tenant_id === fixture.tenant_id && r.id === fixture.order_id));
  let first: unknown;
  for (let repeat = 0; repeat < 2; repeat++) {
    const r: LightMyRequestResponse = await app.inject({method:'GET',url:'/api/order-parcels/orders/'+fixture.order_id+'/source',headers:{cookie}});
    assert.equal(r.statusCode,200); assert.equal(r.headers['cache-control'],'no-store');
    const b = r.json(); assert.equal(b.available,true); assert.equal(b.can_read,true); assert.equal(b.read_only,true); assert.equal(b.can_write,false); assert.equal(b.current_role,'admin'); assert.equal(b.source.can_preview,false);
    assert.equal(b.source.order.id,fixture.order_id); assert.equal(b.source.order.version,String(order.version));
    const delivery = fixture.expected_delivery;
    assert.deepEqual(b.source.operative_delivery,{version:String(state.delivery_version),hash:sha(canonical(delivery)),delivery},'Exact generic delivery binding comes from actual decrypted sidecar');
    const address = {...order.address}; for (const k of ['street','city','postal_code','country','phone','locker_code']) delete address[k];
    const {recipient_name,...five} = delivery;
    assert.deepEqual(b.source.receiver,{name:recipient_name,email:order.email,address:{...address,...five}},'Native receiver keeps unrelated original address keys and email, replaces exactly six operational fields');
    if (repeat === 0) first = b; else assert.deepEqual(b,first,'Read admission random client key is neither exposed nor persisted');
    assert.deepEqual(await capture(),afterLogin,'Full562 default-zero after each corrected native source GET, including operative_delivery_evidence and certificates');
  }
});

test('registered normal/v1 parcel and label mutations reject malformed JSON423 before auth or parsing', async () => {
  assert(app && afterLogin && cookie);
  const id = fixture.order_id;
  const routes = [
    ['/order-parcels/orders/:id/previews','/order-parcels/orders/'+id+'/previews'],
    ['/order-parcels/previews/:id/apply','/order-parcels/previews/'+id+'/apply'],
    ['/order-parcels/plans/:id/parcels/:index/dispatch','/order-parcels/plans/'+id+'/parcels/0/dispatch'],
    ['/print-jobs/shipments/:id/label-previews','/print-jobs/shipments/'+id+'/label-previews'],
    ['/print-jobs/label-previews/:id/queue','/print-jobs/label-previews/'+id+'/queue'],
    ['/order-parcel-releases/plans/:id/previews','/order-parcel-releases/plans/'+id+'/previews'],
  ] as const;
  let refused = 0;
  const attempts = ['/api','/api/v1'].flatMap(prefix => routes.map(([pattern,path]) => ({ pattern: prefix+pattern, url: prefix+path })));
  // Packed156 resolution requires an ordinary cookie. It deliberately has no
  // developer-api descriptor/v1 alias; never present a fabricated v1 barrier.
  const packedPattern = '/api/print-jobs/packed-labels/intentions/:id/resolve';
  assert.equal(app.hasRoute({method:'POST',url:'/api/v1/print-jobs/packed-labels/intentions/:id/resolve'}),false,
    'Packed worker resolution v1 is explicitly NOT_SUPPORTED');
  attempts.push({pattern:packedPattern,url:'/api/print-jobs/packed-labels/intentions/'+id+'/resolve'});
  for (const {pattern,url} of attempts) for (const authenticated of [false,true]) {
    assert(app.hasRoute({method:'POST',url:pattern}),'Actual registered route pattern exists before readonly refusal');
    const r: LightMyRequestResponse = await app.inject({method:'POST',url,payload:'{"broken":',headers:{'content-type':'application/json',...(authenticated ? {cookie} : {})}});
    assert.equal(r.statusCode,423,'Native readonly barrier precedes malformed JSON and credential checks');
    assert.match(String(r.headers['content-type']),/^application\/problem\+json/); assert.equal(r.headers['cache-control'],'no-store'); assert.equal(r.json().status,423); ++refused;
    assert.deepEqual(await capture(),afterLogin,'Each malformed refusal preserves full562 rows/OIDs/metadata/certificate/guards/native sequences');
  }
  assert.equal(refused,26);
  // No v1-key read/IAM claim: a key cannot be minted through this readonly app.
});
