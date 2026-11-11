/** Installation identity on a real clone (docs/parity/INSTALLATION-IDENTITY248-20261027.md). The per-transaction
 * installation cut skips hashing the full seal rows while installationIdentitySql() returns the identity the cold
 * transaction recorded. The property pinned here: for every change to a seal table, either the identity changes (the
 * full read then decides) or the full cut is unchanged. Changes of content or definition must change the identity, also
 * in replica mode, with event triggers off and with unchanged values. Runs the actual SQL builders of
 * profile-startup.mjs as the owner on a disposable PG04 clone dynaminds_m248_YYYYMMDD_NN (or the older p256 family); every change but the
 * maintenance commands is rolled back. */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import pg from 'pg';

const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_(?:p256_20261027|m(?:24[89]|25[0123456789]|26[0123])_2026[0-9]{4})_[0-9]{2}$/, 'disposable clone dynaminds_m248_YYYYMMDD_NN (or m249/m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263) required');
const startup = fs.readFileSync(new URL('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/profile-startup.mjs', import.meta.url), 'utf8');
const from = startup.indexOf('// Installation-only facts:'), to = startup.indexOf('const ordinarySchemaGates=new WeakSet();', from);
const api = new Function('assert', `${startup.slice(from, to)}
 return {installationIdentitySql,installationSealSql,readInstallationIdentity,readInstallationCut,SEALS:[...ORDER_READ_INSTALLATION_SEALS,'return_credit211_metadata']};`)(assert);
const c = new pg.Client({ connectionString: database.href, options: '-c jit=off -c timezone=UTC -c statement_timeout=120000' });
before(() => c.connect());
after(() => c.end());

const seals = api.SEALS;
const read = async (lock) => ({ identity: await api.readInstallationIdentity(c, lock, seals), cut: await api.readInstallationCut(c, lock, seals) });
/** In one rolled-back transaction: the cold read, the change, the later read (the same transaction sees its own change). */
async function across(change, { lock = true } = {}) {
  await c.query('BEGIN');
  try {
    const before = await read(lock);
    for (const q of change) await c.query(q);
    const later = await read(lock);
    return { before, later, sameIdentity: JSON.stringify(before.identity) === JSON.stringify(later.identity), sameCut: JSON.stringify(before.cut) === JSON.stringify(later.cut) };
  } finally { await c.query('ROLLBACK'); }
}
const replica = (...q) => ['SET LOCAL session_replication_role=replica', ...q, 'SET LOCAL session_replication_role=origin'];
const quiet = (...q) => ['SET LOCAL event_triggers=off', ...q, 'SET LOCAL event_triggers=on'];

test('the identity covers all 16 seals of the order-read cut (one row each), their pg_class and pg_attribute rows', async () => {
  for (const lock of [true, false]) {
    const r = await read(lock);
    assert.equal(r.identity.filter((x) => x.startsWith('["row"')).length, seals.length);
    assert.equal(r.identity.filter((x) => x.startsWith('["class"')).length, seals.length);
    assert(r.identity.filter((x) => x.startsWith('["attribute"')).length > seals.length * 3);
  }
  // An unchanged state reads the same identity in a new transaction, RW (FOR SHARE) and RR RO alike.
  const a = await across([]);
  assert(a.sameIdentity && a.sameCut);
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try { assert.deepEqual(await api.readInstallationIdentity(c, false, seals), a.before.identity); } finally { await c.query('ROLLBACK'); }
});

const CHANGES = {
  'replica UPDATE with the same value': replica("UPDATE local_invoice_manifest SET fingerprint=fingerprint"),
  'replica UPDATE of the 209 projection basis with the same value': replica('UPDATE order_merge_delivery209_projection_basis SET id=id'),
  'replica UPDATE with a forged value': replica("UPDATE fa3_draft_manifest SET fingerprint=repeat('0',64)"),
  'replica DELETE and INSERT of the same row': replica('CREATE TEMP TABLE zz_keep AS SELECT * FROM catalog_stock_control_manifest', 'DELETE FROM catalog_stock_control_manifest', 'INSERT INTO catalog_stock_control_manifest SELECT * FROM zz_keep'),
  'UPDATE and UPDATE back': replica("UPDATE local_invoice_manifest SET fingerprint=fingerprint||'x'", "UPDATE local_invoice_manifest SET fingerprint=left(fingerprint,-1)"),
  'ADD COLUMN with a fast default': quiet('ALTER TABLE local_invoice_manifest ADD COLUMN zz248 int DEFAULT 7'),
  'RENAME COLUMN': quiet('ALTER TABLE local_invoice_manifest RENAME COLUMN fingerprint TO fp248'),
  'ALTER COLUMN TYPE (rewrite)': quiet('ALTER TABLE local_invoice_manifest ALTER COLUMN fingerprint TYPE varchar(80)'),
  'DROP COLUMN': quiet('ALTER TABLE buyer_address_manifest DROP COLUMN installed_at'),
  'SET DEFAULT only': quiet("ALTER TABLE local_invoice_manifest ALTER COLUMN fingerprint SET DEFAULT 'x'"),
  'inherited child with a row': quiet('CREATE TABLE zz_child248 () INHERITS (local_invoice_manifest)', "INSERT INTO zz_child248 SELECT * FROM ONLY local_invoice_manifest"),
  'table replaced by a copy': quiet('ALTER TABLE local_invoice_manifest RENAME TO zz_old248', 'CREATE TABLE local_invoice_manifest AS SELECT * FROM zz_old248'),
  'TRUNCATE and reinsert': replica('CREATE TEMP TABLE zz_keep2 AS SELECT * FROM fa3_draft_manifest', 'TRUNCATE fa3_draft_manifest', 'INSERT INTO fa3_draft_manifest SELECT * FROM zz_keep2'),
};
for (const [name, steps] of Object.entries(CHANGES)) {
  test(`identity changes: ${name}`, async () => {
    let r;
    try { r = await across(steps); } catch (e) {
      // The change may make the cut itself unreadable (refused by its shape checks): never an accepted state.
      assert.match(String(e.message), /ordinary-installation|count|singleton|shape|Expected values/, name + ': ' + e.message);
      return;
    }
    assert.equal(r.sameIdentity, false, name + ': a new identity, so the full read decides');
    assert(r.sameIdentity === false || r.sameCut, name + ': never the same identity over a different cut');
  });
}

test('changes that leave the content alone: the identity may stay; then the full cut is the same', async () => {
  for (const steps of [['GRANT SELECT ON local_invoice_manifest TO dyna_app', 'REVOKE SELECT ON local_invoice_manifest FROM dyna_app'],
    ["COMMENT ON TABLE local_invoice_manifest IS 'p248'"], ['SELECT 1 FROM local_invoice_manifest FOR UPDATE'],
    ['SAVEPOINT s', 'SET LOCAL session_replication_role=replica', "UPDATE local_invoice_manifest SET fingerprint='x'", 'ROLLBACK TO SAVEPOINT s']]) {
    const r = await across(steps);
    assert(!r.sameIdentity || r.sameCut, steps.join('; '));
  }
  const before = await read(false);
  for (const q of ['VACUUM (FREEZE) local_invoice_manifest', 'ANALYZE local_invoice_manifest', 'VACUUM (FULL) local_invoice_manifest', 'CLUSTER local_invoice_manifest USING local_invoice_manifest_pkey']) {
    await c.query(q).catch((e) => { if (!/no index|is not an index|does not exist/.test(e.message)) throw e; });
    const later = await read(false);
    const same = JSON.stringify(before.identity) === JSON.stringify(later.identity);
    console.log(JSON.stringify({ maintenance: q, identity_unchanged: same }));
    assert(!same || JSON.stringify(before.cut) === JSON.stringify(later.cut), q);
    assert.deepEqual(later.cut, before.cut, q + ': maintenance never changes the content');
  }
});

test('cost: identity read vs full seal read (order-read cut with the 209 projection basis)', async () => {
  const time = async (fn) => { const ms = []; for (let i = 0; i < 9; i++) { await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); const t = performance.now(); await fn(); ms.push(performance.now() - t); await c.query('ROLLBACK'); } return +ms.sort((a, b) => a - b)[4].toFixed(2); };
  const identity = await time(() => c.query(api.installationIdentitySql(false, seals)));
  const full = await time(() => c.query(api.installationSealSql(false, seals)));
  console.log(JSON.stringify({ order_read_cut_median_ms: { identity, full } }));
  assert(identity * 5 < full, 'the identity read is far cheaper than hashing every full row');
});
