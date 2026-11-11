/** Migration 257_order_merge_snapshot_index_paths (prepared as 271) on a real clone (docs/parity/MERGE209-SNAPSHOT-GEN271-20261029.md
 * "Integracja jako 257"). Runs on a fresh PG04 clone dynaminds_m257_YYYYMMDD_NN of the restored template migrated to HEAD by
 * the real migrate(), which applies 257 and its ledger row (the prepared run applied 271 by hand; that step is dropped). Every tampering runs in a transaction that is rolled back.
 * The question for every case: does the Source271 snapshot detect exactly what the Source209 snapshot detects on
 * the same catalogue, and, where the snapshot function itself is not touched, give the byte-identical answer?
 * "The same catalogue" is made by swapping the Source209 body back in (CREATE OR REPLACE, same attributes) inside
 * the case transaction and repeating any change aimed at the snapshot function after the swap. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { migrate, pool } from '../server/db';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:25[789]|26[0123])_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_m257_YYYYMMDD_NN of the restored template required');

const options = '-c jit=off -c timezone=UTC -c statement_timeout=300000 -c lock_timeout=8000';
const A = new pg.Client({ connectionString: database.href, options });
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const KEY = 'public.order_merge_delivery209_validation_snapshot()';
const C209 = 'CREATE FUNCTION public.order_merge_delivery209_validation_snapshot() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $snapshot209$';
const C271 = 'CREATE OR REPLACE FUNCTION public.order_merge_delivery209_validation_snapshot() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $snapshot271$';
function between(sql: string, open: string, close: string) {
  const i = sql.indexOf(open); assert(i >= 0 && sql.indexOf(open, i + 1) < 0);
  return sql.slice(i + open.length, sql.indexOf(close, i + open.length));
}
const body209 = between(readFileSync(new URL('../server/209_order_merge_delivery_inheritance.sql', import.meta.url), 'utf8'), C209, '$snapshot209$;');
const body271 = between(readFileSync(new URL('../server/257_order_merge_snapshot_index_paths.sql', import.meta.url), 'utf8'), C271, '$snapshot271$;');
/** The sealed 209 body under the same attributes: what "the same catalogue with Source209" means here. */
const SWAP209 = 'CREATE OR REPLACE FUNCTION public.order_merge_delivery209_validation_snapshot() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $snapshot209$' + body209 + '$snapshot209$';
const SNAP = 'SELECT public.order_merge_delivery209_validation_snapshot()::text s';
let manifest = '';

before(async () => {
  await migrate();
  await A.connect();
  assert.equal((await A.query("SELECT count(*)::int n FROM migrations WHERE name='257_order_merge_snapshot_index_paths'")).rows[0].n, 1, 'the real migrate() applied 257 with its ledger row');
  manifest = (await A.query('SELECT fingerprint FROM public.order_merge_delivery209_manifest')).rows[0].fingerprint;
});
after(async () => { await A.end(); await pool.end(); });

type Answer = { text: string | null; error: string | null };
const answer = async (): Promise<Answer> => {
  await A.query('SAVEPOINT s271');
  try { const text = (await A.query(SNAP)).rows[0].s as string; await A.query('RELEASE SAVEPOINT s271'); return { text, error: null }; }
  catch (e) { await A.query('ROLLBACK TO SAVEPOINT s271'); return { text: null, error: (e as Error).message }; }
};
/** Refused (error) or a fingerprint other than the sealed manifest's: the state is not the sealed 209 state. */
const detected = (a: Answer) => a.error !== null || (JSON.parse(a.text!) as { fingerprint: string }).fingerprint !== manifest;

/** Applies the change, asks Source271, swaps Source209 in (re-applying a change aimed at the snapshot), asks Source209. */
async function pair(change: string[], self = false) {
  await A.query('BEGIN');
  try {
    for (const q of change) await A.query(q);
    const n = await answer();
    await A.query(SWAP209);
    if (self) for (const q of change) await A.query(q);
    const o = await answer();
    return { n, o };
  } finally { await A.query('ROLLBACK'); }
}

test('257 is installed: the exact producer body, the 209 attributes and owner-only ACL', async () => {
  const r = (await A.query(`SELECT p.prosrc,pg_get_functiondef(p.oid) def,p.proacl::text acl,p.provolatile,p.prosecdef,p.proconfig
    FROM pg_proc p WHERE p.oid=to_regprocedure($1)`, [KEY])).rows[0];
  assert.equal(r.prosrc, body271);
  assert.equal(r.def, "CREATE OR REPLACE FUNCTION public.order_merge_delivery209_validation_snapshot()\n RETURNS jsonb\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\nAS $function$" + body271 + '$function$\n');
  assert.equal(r.provolatile, 's'); assert.equal(r.prosecdef, true); assert.deepEqual(r.proconfig, ['search_path=pg_catalog, public']);
  assert.equal(r.acl, '{postgres=X/postgres}', 'the 209 owner-only ACL, no grant to the application or PUBLIC');
});

test('installed state: the identical answer as Source209 on the same catalogue, and it is the sealed one', async () => {
  const { n, o } = await pair([]);
  assert.equal(n.error, null); assert.equal(n.text, o.text);
  assert.equal(detected(n), false);
  assert.equal(sha(n.text!), sha(o.text!));
});

test('the answer does not depend on the plan the index paths enable', async () => {
  const want = (await A.query(SNAP)).rows[0].s;
  for (const settings of ['-c enable_indexscan=off -c enable_bitmapscan=off -c enable_indexonlyscan=off', '-c enable_seqscan=off -c enable_hashjoin=off',
    '-c enable_nestloop=off -c enable_mergejoin=off', '-c enable_material=off -c enable_memoize=off']) {
    const c = new pg.Client({ connectionString: database.href, options: options + ' ' + settings });
    await c.connect();
    try { assert.equal((await c.query(SNAP)).rows[0].s, want, settings); } finally { await c.end(); }
  }
});

/** [name, statements, detected by both]. None touches the snapshot function: both answers must be identical. */
const CASES: [string, string[], boolean][] = [
  ['control: a comment on a 209 function (not part of either descriptor)', ["COMMENT ON FUNCTION public.order_merge_delivery209_valid() IS 'p271'"], false],
  ['control: name without the 209 underscore', ['CREATE FUNCTION public.order_merge_delivery209x() RETURNS int LANGUAGE sql AS $$SELECT 1$$'], false],
  ['control: the first name after the prefix range', ['CREATE FUNCTION public."order_merge_delivery209`"() RETURNS int LANGUAGE sql AS $$SELECT 1$$'], false],
  ['control: a 209 name outside public', ['CREATE SCHEMA zz271', 'CREATE FUNCTION zz271.order_merge_delivery209_zz() RETURNS int LANGUAGE sql AS $$SELECT 1$$'], false],
  ['function with the bare prefix', ['CREATE FUNCTION public.order_merge_delivery209_() RETURNS int LANGUAGE sql AS $$SELECT 1$$'], true],
  ['function with a multibyte name', ['CREATE FUNCTION public."order_merge_delivery209_ż"() RETURNS int LANGUAGE sql AS $$SELECT 1$$'], true],
  ['function attribute (cost) of a 209 function', ['ALTER FUNCTION public.order_merge_delivery209_valid() COST 7'], true],
  ['function body of a 209 function (catalogue UPDATE)', ["UPDATE pg_proc SET prosrc=prosrc||E'\\n-- p271' WHERE oid='public.order_merge_delivery209_fingerprint()'::regprocedure"], true],
  ['grant on a 209 function', ['GRANT EXECUTE ON FUNCTION public.order_merge_delivery209_valid() TO dyna_app'], true],
  ['column added to a 209 table', ['ALTER TABLE public.order_merge_delivery209_receipts ADD COLUMN zz271 integer'], true],
  ['column statistics of a 209 table', ['ALTER TABLE public.order_merge_delivery209_receipts ALTER COLUMN tenant_id SET STATISTICS 5'], true],
  ['209 immutability trigger disabled', ['ALTER TABLE public.order_merge_delivery209_receipts DISABLE TRIGGER order_merge_delivery209_immutable'], true],
  ['209 trigger on another table disabled (name branch)', ['ALTER TABLE public.order_merge_previews DISABLE TRIGGER order_merge_delivery209_source_preview'], true],
  ['new 209-named trigger on another table (name branch)', ['CREATE TRIGGER order_merge_delivery209_zz BEFORE TRUNCATE ON public.order_merge_previews FOR EACH STATEMENT EXECUTE FUNCTION public.order_merge_delivery209_immutable()'], true],
  ['control: trigger named after the prefix range', ['CREATE TRIGGER "order_merge_delivery209`" BEFORE TRUNCATE ON public.order_merge_previews FOR EACH STATEMENT EXECUTE FUNCTION public.order_merge_delivery209_immutable()'], false],
  ['internal FK trigger on a referenced table disabled (constraint branch)', [`UPDATE pg_trigger SET tgenabled='D' WHERE oid=(SELECT t.oid FROM pg_trigger t JOIN pg_constraint k ON k.oid=t.tgconstraint
     WHERE k.conname='order_merge_delivery209_receipts_tenant_id_source_order_id_fkey' AND t.tgrelid='public.orders'::regclass ORDER BY t.oid LIMIT 1)`], true],
  ['209-named constraint on another table (name branch)', ['ALTER TABLE public.order_merge_previews ADD CONSTRAINT order_merge_delivery209_zz CHECK (true) NOT VALID'], true],
  ['constraint of a 209 table', ['ALTER TABLE public.order_merge_delivery209_receipts ADD CONSTRAINT zz271 CHECK (true) NOT VALID'], true],
  ['index on a 209 table', ['CREATE INDEX zz271 ON public.order_merge_delivery209_receipts(tenant_id)'], true],
  ['grant on the 209 manifest', ['GRANT SELECT ON public.order_merge_delivery209_manifest TO dyna_app'], true],
  ['policy of the 209 manifest', ['ALTER POLICY owner_scope ON public.order_merge_delivery209_manifest TO postgres,dyna_app'], true],
  ['209 composite type (type and relation arms)', ['CREATE TYPE public.order_merge_delivery209_zz AS (a integer)'], true],
  ['type in the underscore branch', ['CREATE DOMAIN public._order_merge_delivery209_q AS integer'], true],
  ['legacy function body (catalogue UPDATE)', ["UPDATE pg_proc SET prosrc=prosrc||' ' WHERE oid='public.pim_dictionary_valid()'::regprocedure"], true],
  ['legacy function attribute', ['ALTER FUNCTION public.buyer_address_fingerprint() COST 7'], true],
  ['legacy function grant', ['GRANT EXECUTE ON FUNCTION public.ordinary187_valid() TO dyna_app'], true],
  ['buyer address constraint (constraints part)', ['ALTER TABLE public.buyer_address_previews ADD CONSTRAINT zz271 CHECK (true) NOT VALID'], true],
];
for (const [name, change, want] of CASES) {
  test('same answer and same verdict: ' + name, async () => {
    const { n, o } = await pair(change);
    assert.equal(detected(o), want, 'Source209 verdict');
    assert.equal(detected(n), want, 'Source271 verdict');
    assert.deepEqual(n, o, 'byte-identical answer (or the same refusal)');
  });
}

/** Changes aimed at the snapshot function itself: both bodies must reject them (the answers differ by the body digest). */
const SELF: [string, string[], string[] | null][] = [
  ['grant on the snapshot', [`GRANT EXECUTE ON FUNCTION ${KEY} TO dyna_app`], null],
  ['configuration of the snapshot', [`ALTER FUNCTION ${KEY} SET work_mem='64kB'`], null],
  ['cost of the snapshot', [`ALTER FUNCTION ${KEY} COST 9`], null],
  ['volatility of the snapshot', [`ALTER FUNCTION ${KEY} VOLATILE`], null],
  ['owner of the snapshot', [`ALTER FUNCTION ${KEY} OWNER TO dyna_app`], null],
  ['appended comment in the body (the p260 seal probe)', [`UPDATE pg_proc SET prosrc=prosrc||E'\\n-- p271 seal probe\\n' WHERE oid=to_regprocedure('${KEY}')`], null],
  ['edit only inside the self literal (Source209: any body edit)',
    [`UPDATE pg_proc SET prosrc=overlay(prosrc placing 'v3' from strpos(prosrc,'merge-delivery-complete-record-text-digests/v2')+44 for 2) WHERE oid=to_regprocedure('${KEY}')`],
    [`UPDATE pg_proc SET prosrc=replace(prosrc,'merge-delivery-complete-record-text-digests/v2','merge-delivery-complete-record-text-digests/v2 ') WHERE oid=to_regprocedure('${KEY}')`]],
];
for (const [name, change, change209] of SELF) {
  test('both reject a change of the snapshot itself: ' + name, async () => {
    await A.query('BEGIN');
    try {
      for (const q of change) await A.query(q);
      const n = await answer();
      await A.query(SWAP209);
      for (const q of change209 ?? change) await A.query(q);
      const o = await answer();
      assert.equal(detected(o), true, 'Source209 rejects');
      assert.equal(detected(n), true, 'Source271 rejects');
    } finally { await A.query('ROLLBACK'); }
  });
}

test('the literal edit really is inside the self literal (first occurrence of the profile text)', async () => {
  const at = body271.indexOf('merge-delivery-complete-record-text-digests/v2');
  assert(at > body271.indexOf('$q271$') && at < body271.lastIndexOf('$q271$'));
});

test('the ten guards, warehouse_wz_issuer_guards and email_inbound_guards are true with 257 installed', async () => {
  await A.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
  try {
    for (const g of ['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards', 'ordinary188_structure_valid',
      'return_credit211_metadata_valid', 'large_import173_valid', 'fa3_draft_guards', 'pim_dictionary_valid', 'local_invoice_guards',
      'warehouse_wz_issuer_guards', 'email_inbound_guards'])
      assert.equal((await A.query(`SELECT public.${g}() v`)).rows[0].v, true, g);
  } finally { await A.query('ROLLBACK'); }
});
