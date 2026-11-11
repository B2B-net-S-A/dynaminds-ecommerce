/** AUTHORED / NOT_RUN. Genuine native recovered-address validator, not archive/restore proof.
 * Root supplies the accepted native166 numeric fixture DB exclusively, with its private config
 * and DATABASE_URL before imports. No seed, migration, app, listener or provider is started.
 * Corruption is confined to this owned test DB, one savepoint/TX, and always rolled back.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

let pool: Pool, key: string;
let validate: typeof import('../server/buyer-address').validateRecoveredBuyerAddresses;
const family = ['buyer_address_state', 'buyer_address_previews', 'buyer_address_receipts', 'buyer_address_manifest', 'migrations'] as const;
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') return '{' + Object.entries(v)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x)).join(',') + '}';
  assert.ok(v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number');
  return JSON.stringify(v);
};
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const exact = (a: unknown, b: unknown, message: string) => assert.equal(sha(canonical(a)), sha(canonical(b)), message);

async function snapshot(c: PoolClient) {
  const rows: Record<string, unknown[]> = {};
  for (const name of family) rows[name] = (await c.query('SELECT to_jsonb(t) row FROM public.' + name + ' t ORDER BY to_jsonb(t)::text')).rows;
  const relations = (await c.query(`SELECT c.oid,c.relname,to_jsonb(c)-ARRAY['relpages','reltuples','relallvisible','relallfrozen'] meta,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0) columns,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p WHERE p.polrelid=c.oid) policies,
    (SELECT jsonb_agg(jsonb_build_object('meta',to_jsonb(x),'definition',pg_get_constraintdef(x.oid,false)) ORDER BY x.oid) FROM pg_constraint x WHERE x.conrelid=c.oid) constraints,
    (SELECT jsonb_agg(jsonb_build_object('meta',to_jsonb(i),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid) FROM pg_index i WHERE i.indrelid=c.oid) indexes
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) ORDER BY c.oid`, [[...family]])).rows;
  const functions = (await c.query("SELECT p.oid,to_jsonb(p) meta,pg_get_functiondef(p.oid) definition FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'buyer_address_') ORDER BY p.oid")).rows;
  const triggers = (await c.query(`SELECT t.oid,to_jsonb(t) meta,pg_get_triggerdef(t.oid,false) definition FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) ORDER BY t.oid`, [[...family]])).rows;
  return { rows, relations, functions, triggers };
}
async function readSnapshot() {
  const c = await pool.connect();
  try { await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    return await snapshot(c);
  } finally { try { await c.query('ROLLBACK'); } finally { c.release(); } }
}
const deniedAead = (e: unknown) => typeof e === 'object' && e !== null &&
  (e as { status?: unknown }).status === 503 && e instanceof Error &&
  e.message === 'Uwierzytelnienie dowodu adresu nie powiodło się';

before(async () => {
  assert.equal(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.DYNA_BUYER_ADDRESS_RECOVERY_NATIVE, 'true', 'Root authorizes exclusive owned native validator gate');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.port, '55432'); assert.match(url.pathname, /^\/dynaminds_test_[0-9]{13}$/);
  const path = process.env.DYNA_LOCAL_CONFIG_PATH;
  assert.ok(path, 'Private config is supplied before module imports');
  const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.mode & 0o777, 0o600);
  const cfg = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(typeof cfg.encryptionKey === 'string' && /^[a-f0-9]{64}$/.test(cfg.encryptionKey), 'Valid private encryption key');
  key = cfg.encryptionKey;
  const { Pool: NativePool } = (await import('pg')).default;
  pool = new NativePool({ connectionString: process.env.DATABASE_URL, max: 2 });
  ({ validateRecoveredBuyerAddresses: validate } = await import('../server/buyer-address'));
  assert.equal((await pool.query("SELECT EXISTS(SELECT FROM migrations WHERE name='166_buyer_address_sidecar') ok")).rows[0].ok, true);
  assert.equal((await pool.query('SELECT buyer_address_guards() ok')).rows[0].ok, true);
  assert.ok((await pool.query('SELECT count(*)::int n FROM buyer_address_state WHERE delivery_override_encrypted IS NOT NULL')).rows[0].n > 0, 'Accepted native fixture has genuine encrypted delivery');
});
after(async () => {
  if (!pool) return;
  const waiting = pool.waitingCount, checkedOut = pool.totalCount - pool.idleCount;
  try { await pool.end(); } finally { key = ''; }
  assert.equal(waiting, 0); assert.equal(checkedOut, 0, 'All owned checked-out readers released');
  assert.equal(pool.totalCount, 0, 'Owned pool clients closed');
});

test('actual correct-key recovered validator reads the complete native address family without effects', async () => {
  const before = await readSnapshot(), c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    assert.equal((await c.query('SELECT buyer_address_guards() ok')).rows[0].ok, true);
    const counts = await validate(c, key);
    const expected = { states: before.rows.buyer_address_state.length,
      previews: before.rows.buyer_address_previews.length, receipts: before.rows.buyer_address_receipts.length,
      records: before.rows.buyer_address_state.filter((x: any) => x.row.delivery_override_encrypted !== null).length +
        before.rows.buyer_address_previews.length + before.rows.buyer_address_receipts.length };
    assert.deepEqual(counts, expected);
    exact(await snapshot(c), before, 'Correct-key validator leaves all five tables and exact own metadata unchanged');
  } finally { try { await c.query('ROLLBACK'); } finally { c.release(); } }
  exact(await readSnapshot(), before, 'Reader closure preserves committed native address evidence');
});

test('actual wrong key is rejected by AEAD with full native rows and metadata unchanged', async () => {
  const before = await readSnapshot(), wrong = Buffer.from(key, 'hex'); wrong[0] ^= 1;
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    await assert.rejects(validate(c, wrong.toString('hex')), deniedAead, 'Native AES-GCM rejects a different key');
    exact(await snapshot(c), before, 'Wrong-key attempt is read-only, including metadata and migration certificate');
  } finally { wrong.fill(0); try { await c.query('ROLLBACK'); } finally { c.release(); } }
  exact(await readSnapshot(), before, 'Wrong-key reader leaves committed evidence literal');
});

for (const [kind, offset] of [['tag', 12], ['ciphertext', 28]] as const) {
  test('actual ' + kind + ' tamper passes updated ciphertext envelope/hash then fails AEAD and rolls back', async () => {
    const before = await readSnapshot(), c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query("SET LOCAL TimeZone='UTC'"); await c.query('SAVEPOINT address_aead_probe');
      const source = (await c.query('SELECT tenant_id,order_id,delivery_override_encrypted,override_byte_count FROM buyer_address_state WHERE delivery_override_encrypted IS NOT NULL ORDER BY tenant_id,order_id LIMIT 1 FOR UPDATE')).rows[0];
      assert.ok(source); const bytes = Buffer.from(source.delivery_override_encrypted, 'base64'); assert.ok(bytes.length > 28);
      // One-bit mutation preserves plaintext byte-count and full IV/tag/body length.
      bytes[offset] ^= 1; const encrypted = bytes.toString('base64'), digest = sha(encrypted);
      await c.query("SET LOCAL session_replication_role='replica'");
      const changed = await c.query('UPDATE buyer_address_state SET delivery_override_encrypted=$3,override_sha256=$4 WHERE(tenant_id,order_id)=($1,$2)', [source.tenant_id, source.order_id, encrypted, digest]);
      assert.equal(changed.rowCount, 1); await c.query("SET LOCAL session_replication_role='origin'");
      assert.equal((await c.query('SELECT buyer_address_cipher_valid($1,$2,$3) ok', [encrypted, source.override_byte_count, digest])).rows[0].ok, true, 'Corrupted bytes have valid exact envelope/byte-count/new hash');
      assert.equal((await c.query('SELECT buyer_address_guards() ok')).rows[0].ok, true, 'Origin and every own metadata check restored before validator');
      await assert.rejects(validate(c, key), deniedAead, 'Actual authenticated decrypt must reject the single-bit change');
      await c.query('ROLLBACK TO SAVEPOINT address_aead_probe');
      assert.equal((await c.query("SELECT current_setting('session_replication_role') role")).rows[0].role, 'origin');
      exact(await snapshot(c), before, 'Savepoint removes the complete isolated corruption and restores exact metadata');
    } finally { try { await c.query('ROLLBACK'); } finally { c.release(); } }
    exact(await readSnapshot(), before, 'No tampered row or metadata persists after owned TX cleanup');
  });
}
