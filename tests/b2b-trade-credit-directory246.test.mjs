/** Migration 246_b2b_trade_credit_directory (prepared as placeholder 254; object names keep the b2b254_ prefix).
 * B2B-007 trade credit lines and the append-only charge list; B2B-008 supplier directory profiles and requests;
 * M6 FORCE ROW LEVEL SECURITY on payu242_*, audit238_event_keys and the 244 tables custom_event_defs and
 * custom_event_calls. Only own objects, no foreign key to and no change of an existing table besides the seven FORCE
 * flags; dyna_app without DELETE. The manifest row pins the exact bytes after 245. No database; behaviour is pinned by
 * tests/b2b-trade-credit246.database.test.ts, tests/b2b-supplier-directory246.database.test.ts and
 * tests/force-rls246.database.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/246_b2b_trade_credit_directory.sql', import.meta.url);
const code = () => readFileSync(file, 'utf8').replace(/--.*$/gm, '');
const TABLES = ['b2b254_trade_lines', 'b2b254_trade_charges', 'b2b254_directory_profiles', 'b2b254_directory_requests'];
const FORCED = ['payu242_configs', 'payu242_sessions', 'payu242_notifications', 'payu242_refunds', 'audit238_event_keys', 'custom_event_defs', 'custom_event_calls'];
const tenant = "NULLIF\\(current_setting\\('app\\.tenant_id',true\\),''\\)::uuid";

test('246 follows 245 in the release list and pins the exact SQL bytes', () => {
  assert(existsSync(file), 'server/246_b2b_trade_credit_directory.sql exists');
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 246), row = RELEASE_MIGRATIONS[i], b = readFileSync(file);
  assert(row, 'manifest row 246');
  assert.equal(row.name, '246_b2b_trade_credit_directory');
  assert.equal(row.file, '246_b2b_trade_credit_directory.sql');
  assert.equal(row.native_id, 'b2b_trade_credit_directory246');
  assert.equal(row.cold.contract, 'b2b-trade-credit-directory246');
  assert.equal(row.cold.project, 'projectCompiledB2bTradeCreditDirectory246Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 8768);
  assert.equal(row.sha256, '9accc42198c993fa5f22678f404bdbd3dc8940f1cc9c96cc73d144b3c1b42ad1');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '245_s5_comm');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '247_sales_dimensions_repricing', '247 follows 246');
});

test('the SQL exists and creates exactly the four own tables', () => {
  assert(existsSync(file));
  assert.deepEqual([...code().matchAll(/CREATE\s+TABLE\s+([a-z0-9_]+)/g)].map((m) => m[1]), TABLES);
});

test('only own objects; the only change of an existing table is the FORCE flag of the seven M6 tables; no sealed family name', () => {
  const s = code();
  for (const m of s.matchAll(/(?:CREATE|DROP)\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|FUNCTION|TRIGGER|VIEW|TYPE|SEQUENCE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:public\.)?([a-z0-9_]+)/gi))
    assert.match(m[1], /^b2b254_/, m[0]);
  const altered = [...s.matchAll(/ALTER\s+TABLE\s+([a-z0-9_]+)\s+([A-Z ]+?);/g)];
  for (const [, t, what] of altered)
    if (!/^b2b254_/.test(t)) assert(FORCED.includes(t) && what === 'FORCE ROW LEVEL SECURITY', t + ' ' + what);
  assert.deepEqual(altered.filter(([, t]) => !/^b2b254_/.test(t)).map((m) => m[1]), FORCED);
  for (const m of s.matchAll(/\bON\s+(?:TABLE\s+)?(?:public\.)?([a-z0-9_]+)/gi)) assert.match(m[1], /^b2b254_/, m[0]);
  // Own-to-own keys only: no RI trigger lands on b2b_accounts, orders or tenants.
  assert.deepEqual([...s.matchAll(/\bREFERENCES\s+([a-z0-9_]+)/gi)].map((m) => m[1]), ['b2b254_trade_lines', 'b2b254_directory_profiles']);
  assert.doesNotMatch(s, /\b(?:INSERT\s+INTO|UPDATE\s+[a-z_.]+\s+SET|DELETE\s+FROM)\b/i, 'the migration writes no rows');
  assert.doesNotMatch(s, /SECURITY\s+DEFINER|EVENT\s+TRIGGER|CREATE\s+TRIGGER|CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
  // Sealed fingerprints match by LIKE prefix with `_` as a wildcard (docs/parity/WZ-ISSUER239-20261027.md).
  for (const m of s.matchAll(/(?:TABLE|INDEX|POLICY)\s+([a-z0-9_]+)/g))
    for (const sealed of ['b2b.credit.', 'b2b.dropship.', 'b2b.invoice.', 'b2b.catalog.scope.', 'buyer.address.', 'warehouse.wz.issuer.', 'catalog.stock.', 'return.', 'order.parcel.', 'competitor.observation', 'local.invoice.', 'proforma.'])
      assert.doesNotMatch(m[1], new RegExp('^' + sealed), m[1]);
});

test('B2B-007: money in minor units, a currency per line, the admitted exposure never above the limit', () => {
  const s = code();
  assert.match(s, /limit_minor bigint NOT NULL CHECK \(limit_minor BETWEEN 0 AND 100000000000\)/);
  assert.match(s, /term_days integer NOT NULL CHECK \(term_days BETWEEN 1 AND 365\)/);
  assert.match(s, /PRIMARY KEY \(tenant_id, account_id\)/);
  assert.match(s, /amount_minor bigint NOT NULL CHECK \(amount_minor > 0\)/);
  assert.match(s, /CHECK \(exposure_before_minor \+ amount_minor <= limit_minor\)/);
  assert.match(s, /PRIMARY KEY \(tenant_id, order_id\)/, 'an order is charged at most once');
  assert.match(s, /channel text NOT NULL CHECK \(channel IN \('portal','network','dropship'\)\)/);
  assert.equal([...s.matchAll(/currency text NOT NULL CHECK \(currency IN \('PLN','EUR','USD','GBP','CZK'\)\)/g)].length, 2);
  assert.doesNotMatch(s, /\b(?:numeric|real|double precision|money)\b/i, 'no fractional money type');
});

test('B2B-008: opt-in profile without prices; one open request per pair; accepted means an invitation', () => {
  const s = code();
  assert.match(s, /listed boolean NOT NULL DEFAULT false/);
  assert.doesNotMatch(s.slice(s.indexOf('CREATE TABLE b2b254_directory_profiles'), s.indexOf('CREATE INDEX b2b254_directory_profiles_listed')), /price|cost|total|limit/i);
  assert.match(s, /CREATE UNIQUE INDEX b2b254_directory_requests_open ON b2b254_directory_requests\(tenant_id, supplier_tenant_id\) WHERE state = 'pending'/);
  assert.match(s, /CHECK \(tenant_id <> supplier_tenant_id\)/);
  assert.match(s, /CHECK \(\(state = 'accepted'\) = \(account_id IS NOT NULL AND invitation_id IS NOT NULL\)\)/);
  assert.match(s, /state text NOT NULL DEFAULT 'pending' CHECK \(state IN \('pending','accepted','declined','withdrawn'\)\)/);
});

test('RLS: own tables forced with tenant_scope; the two cross-company reads are narrow dyna_app policies', () => {
  const s = code();
  for (const t of TABLES) {
    assert.match(s, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`));
    assert.match(s, new RegExp(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`));
    assert.match(s, new RegExp(`CREATE POLICY tenant_scope ON ${t} USING \\(tenant_id=${tenant}\\) WITH CHECK \\(tenant_id=${tenant}\\);`));
  }
  assert.deepEqual([...s.matchAll(/CREATE POLICY (\w+) ON (\w+) FOR (\w+) TO (\w+)/g)].map((m) => m.slice(1)), [
    ['directory_read', 'b2b254_directory_profiles', 'SELECT', 'dyna_app'],
    ['supplier_read', 'b2b254_directory_requests', 'SELECT', 'dyna_app'],
    ['supplier_decide', 'b2b254_directory_requests', 'UPDATE', 'dyna_app'],
  ]);
  assert.match(s, /directory_read ON b2b254_directory_profiles FOR SELECT TO dyna_app USING \(listed\);/);
  assert.match(s, /REVOKE ALL ON TABLE b2b254_trade_lines, b2b254_trade_charges, b2b254_directory_profiles, b2b254_directory_requests FROM PUBLIC,dyna_app;/);
  assert.deepEqual([...s.matchAll(/\bGRANT\s+([A-Z, ]+?(?:\([a-z_, ]+\))?)\s+ON\s+TABLE\s+(\S+)\s+TO\s+(\S+);/g)].map((m) => [m[1].trim(), m[2], m[3]]), [
    ['SELECT,INSERT,UPDATE', 'b2b254_trade_lines', 'dyna_app'],
    ['SELECT,INSERT', 'b2b254_trade_charges', 'dyna_app'],
    ['SELECT,INSERT,UPDATE', 'b2b254_directory_profiles', 'dyna_app'],
    ['SELECT,INSERT', 'b2b254_directory_requests', 'dyna_app'],
    ['UPDATE (state, account_id, invitation_id, decided_by, decided_at, updated_at)', 'b2b254_directory_requests', 'dyna_app'],
  ]);
  assert.doesNotMatch(s, /\bGRANT\b[^;]*\b(?:DELETE|TRUNCATE|ALL)\b/i);
});

test('M6: FORCE on the four PayU tables, audit238_event_keys and the two 244 custom-event tables, nothing else changed on them', () => {
  const s = code();
  for (const t of FORCED) assert.equal([...s.matchAll(new RegExp(`\\b${t}\\b`, 'g'))].length, 1, t);
  for (const t of FORCED) assert.match(s, new RegExp(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`));
  assert.doesNotMatch(s, /(?:POLICY|GRANT|REVOKE)[^;]*\b(?:payu242_|audit238_|custom_event_)/);
});
