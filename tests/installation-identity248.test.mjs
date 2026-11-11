/** Installation identity (docs/parity/INSTALLATION-IDENTITY248-20261027.md): the per-transaction installation cut skips
 * hashing the full seal rows only while the visible seal tuples and their tables' pg_class/pg_attribute rows have
 * exactly the (relation, ctid, xmin) the cold transaction recorded beside its full cut. Actual source, controlled
 * transaction/catalogue ports (as tests/order-read-installation.test.mjs). No PG/app/HTTP; the PostgreSQL side of the
 * argument is pinned by tests/installation-identity248.database.test.mjs. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const startup = fs.readFileSync(new URL('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/profile-startup.mjs', import.meta.url), 'utf8');
const from = startup.indexOf('// Installation-only facts:'), to = startup.indexOf('const ordinarySchemaGates=new WeakSet();', from);
assert(from > 0 && to > from);
const roContext = () => ({ database: 'owned', pid: 17, start: '2026-10-27 16:00:00.123456+00', read_only: 'on', isolation: 'repeatable read', role: 'postgres', owner: 'postgres', role_setting: 'none', tenant: 'own', replication: 'origin', timezone: 'UTC', timeout: '8s' });
const rwContext = () => ({ database: 'owned', pid: 17, start: '2026-10-27 16:00:00.123456+00', root: '991', read_only: 'off', role: 'postgres', owner: 'postgres', role_setting: 'none', tenant: 'own', replication: 'origin', timezone: 'UTC', timeout: '8s' });

/** Identity rows as PostgreSQL returns them: one row version per seal, its pg_class row and some pg_attribute rows. */
const identityRows = (seals) => seals.flatMap((n, i) => [
  { kind: 'row', seal: n, rel: 16000 + i, tid: '(0,1)', version: String(700 + i), attnum: null },
  { kind: 'class', seal: n, rel: 16000 + i, tid: `(3,${i + 1})`, version: '650', attnum: null },
  { kind: 'attribute', seal: n, rel: 16000 + i, tid: `(9,${i + 1})`, version: '650', attnum: 1 },
  { kind: 'attribute', seal: n, rel: 16000 + i, tid: `(9,${i + 40})`, version: '650', attnum: 2 },
]);

function model(mode) {
  const api = new Function('assert', 'mode', `const schemaGenerations=new WeakMap(),activationFailures=new WeakSet(),activationBusy=new WeakSet();
 ${startup.slice(from, to)}
 return {prepareOrderReadInstallation,recordOrderReadInstallation,prepareOrdinaryInstallation,recordEnteredInstallation,
  readInstallationIdentity,installationIdentitySql,installationSealSql,ORDER_READ_CONTEXT_SQL,INSTALLATION_CONTEXT_SQL,
  seals:mode==='ro'?ORDER_READ_INSTALLATION_SEALS:INSTALLATION_SEALS,markers:INSTALLATION_MARKERS,
  seed(gate,generation,cold){const state={};ordinaryInstallationGates.set(gate,{state,generation});schemaGenerations.set(state,generation);
   (mode==='ro'?ordinaryOrderReadCuts:ordinaryInstallationCuts).set(state,cold);return state;}};`)(assert, mode);
  const generation = { generation: '1703', dirty: false, release_sha256: 'r'.repeat(64) };
  const cut = { seals: Object.fromEntries(api.seals.map((n) => [n, { count: 1, hashes: ['a'.repeat(64)] }])), markers: [...api.markers].sort() };
  const metadata = { roles: [['dyna_app', false, true, false, false, false, false, false], ['postgres', true, true, true, true, true, true, true]], memberships: [['1', '2', '3', false, true, true]] };
  const rows = identityRows(api.seals), ctx = mode === 'ro' ? roContext() : rwContext(), calls = [], gate = {}, txIdentity = {};
  const live = { rows: structuredClone(rows), cut: structuredClone(cut), metadata: structuredClone(metadata) };
  const coldIdentity = Object.freeze(rows.map((r) => JSON.stringify([r.kind, r.seal, String(r.rel), r.tid, r.version, r.attnum])).sort());
  const cold = { generation, installation: { cut: structuredClone(cut), metadata: structuredClone(metadata) }, identity: coldIdentity };
  const state = api.seed(gate, generation, cold);
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === api.ORDER_READ_CONTEXT_SQL || sql === api.INSTALLATION_CONTEXT_SQL) return { rows: [structuredClone(ctx)] };
      if (sql === 'SET LOCAL ROLE NONE') { ctx.role = 'postgres'; ctx.role_setting = 'none'; return { rows: [] }; }
      if (sql === 'SET LOCAL ROLE dyna_app') { ctx.role = 'dyna_app'; ctx.role_setting = 'dyna_app'; return { rows: [] }; }
      if (sql.startsWith('WITH s0 AS MATERIALIZED (SELECT t.tableoid,t.ctid,t.xmin')) { assert.equal(sql.includes('FOR SHARE'), mode === 'rw'); return { rows: structuredClone(live.rows) }; }
      if (sql.startsWith('WITH s0 AS MATERIALIZED (SELECT t.* ')) { assert.equal(sql.includes('FOR SHARE'), mode === 'rw'); return { rows: [{ cut: structuredClone(live.cut) }] }; }
      if (sql.startsWith("SELECT coalesce(jsonb_agg(m.name ORDER BY m.name),'[]'::jsonb) AS markers")) { assert.equal(sql.includes('FOR SHARE'), mode === 'rw'); return { rows: [{ markers: structuredClone(live.cut.markers) }] }; }
      if (sql.startsWith("SELECT jsonb_build_object('roles'")) return { rows: [{ metadata: structuredClone(live.metadata) }] };
      assert.fail('Unexpected controlled SQL ' + sql.slice(0, 60));
    },
  };
  const enter = async () => {
    ctx.role = 'postgres'; ctx.role_setting = 'none';
    if (mode === 'ro') await api.recordOrderReadInstallation(client, gate); else await api.recordEnteredInstallation(client, gate);
    ctx.role = 'dyna_app'; ctx.role_setting = 'dyna_app';
  };
  const prepare = () => mode === 'ro' ? api.prepareOrderReadInstallation(client, gate, 'own', txIdentity) : api.prepareOrdinaryInstallation(client, gate, 'own');
  const fullReads = () => calls.filter((s) => s.startsWith('WITH s0 AS MATERIALIZED (SELECT t.* ')).length;
  return { api, cold, live, calls, ctx, state, enter, prepare, fullReads };
}

for (const mode of ['rw', 'ro']) {
  test(`${mode}: an unchanged identity skips the full seal hash; markers and roles are still read fresh`, async () => {
    const m = model(mode); await m.enter();
    const fact = await m.prepare();
    assert(fact && Object.isFrozen(fact));
    assert.equal(m.fullReads(), 0, 'no full seal read');
    assert(m.calls.some((s) => s.includes('AS markers')) && m.calls.some((s) => s.startsWith("SELECT jsonb_build_object('roles'")));
    assert.equal(m.ctx.role, 'dyna_app');
  });

  test(`${mode}: any changed tuple or definition version is a full read, and the full read decides`, async () => {
    const changes = [
      ['row xmin', (r) => r.find((x) => x.kind === 'row').version = '99999'],
      ['row ctid', (r) => r.find((x) => x.kind === 'row').tid = '(0,2)'],
      ['row relation', (r) => r.find((x) => x.kind === 'row').rel = 77777],
      ['class version', (r) => r.find((x) => x.kind === 'class').version = '99999'],
      ['attribute version', (r) => r.find((x) => x.kind === 'attribute').version = '99999'],
      ['new attribute', (r) => r.push({ ...r.find((x) => x.kind === 'attribute'), attnum: 3, tid: '(9,99)' })],
      ['dropped attribute', (r) => r.splice(r.findIndex((x) => x.kind === 'attribute'), 1)],
    ];
    for (const [name, change] of changes) {
      // Same content after the change (e.g. VACUUM FULL, GRANT): the full read passes, the fact is issued.
      const same = model(mode); await same.enter(); change(same.live.rows);
      assert(await same.prepare(), name + ': unchanged content passes the full read');
      assert.equal(same.fullReads(), 1, name + ': one full read');
      // Changed content: refused.
      const bad = model(mode); await bad.enter(); change(bad.live.rows); bad.live.cut.seals[bad.api.seals[0]].hashes[0] = 'b'.repeat(64);
      await assert.rejects(() => bad.prepare(), undefined, name + ': changed content is refused');
      assert.equal(bad.ctx.role, 'dyna_app');
    }
    for (const [name, change] of [['extra row', (r) => r.push({ ...r[0], tid: '(0,2)', version: '9' })], ['missing row', (r) => r.splice(0, 1)]]) {
      const m = model(mode); await m.enter(); change(m.live.rows);
      await assert.rejects(() => m.prepare(), /identity-singleton/, name + ': refused before any comparison');
      assert.equal(m.fullReads(), 0);
    }
  });

  test(`${mode}: with the identity unchanged, a changed marker or role is still refused`, async () => {
    for (const change of [(m) => m.live.cut.markers.pop(), (m) => m.live.cut.markers.push('unexpected'),
      (m) => { m.live.metadata.roles[0][2] = false; }, (m) => { m.live.metadata.memberships = []; }]) {
      const m = model(mode); await m.enter(); change(m);
      await assert.rejects(() => m.prepare());
      assert.equal(m.fullReads(), 0, 'decided without the full seal hash');
      assert.equal(m.ctx.role, 'dyna_app');
    }
  });

  test(`${mode}: a cold fact without an identity keeps the full read on every transaction`, async () => {
    const m = model(mode); delete m.cold.identity; await m.enter();
    assert(await m.prepare());
    assert.equal(m.fullReads(), 1);
    assert(!m.calls.some((s) => s.startsWith('WITH s0 AS MATERIALIZED (SELECT t.tableoid')), 'no identity read');
  });
}

test('the identity SQL returns only system columns and pg_catalog rows, locks like the full read, and the cold transaction records it beside the full cuts', () => {
  const m = model('rw'), rw = m.api.installationIdentitySql(true, m.api.seals), ro = m.api.installationIdentitySql(false, m.api.seals);
  for (const n of m.api.seals) assert(rw.includes(`(SELECT t.tableoid,t.ctid,t.xmin FROM public.${n} t FOR SHARE)`), n);
  assert(!ro.includes('FOR SHARE'));
  assert.doesNotMatch(rw, /to_jsonb|sha256|convert_to|::text|encode\(/, 'no cast or function on the compared values');
  assert.match(rw, /FROM pg_catalog\.pg_class c WHERE c\.relnamespace OPERATOR\(pg_catalog\.=\) 'public'::pg_catalog\.regnamespace AND c\.relname OPERATOR\(pg_catalog\.=\) ANY\(ARRAY\[/);
  assert.match(rw, /JOIN pg_catalog\.pg_attribute a ON a\.attrelid OPERATOR\(pg_catalog\.=\) c\.oid/);
  const full = (n) => startup.indexOf(n);
  const a = full('installation=await readInstallationCut(owner,true);'), b = full('installationIdentity=await readInstallationIdentity(owner,true,Object.keys(installation.cut.seals));');
  const c = full("'ordinary-installation-closing-cold-identity'"), d = full("'ordinary-order-read-closing-cold-identity'"), commit = full("await owner.query('COMMIT');committed=true;");
  assert(a > 0 && b > a && c > b && d > c && commit > d, 'identity read right after the full cuts under the same locks, rechecked at the close, before COMMIT');
  assert(startup.includes('ordinaryInstallationCuts.set(state,Object.freeze({generation:structuredClone(generation),installation,identity:installationIdentity}));'));
  assert(startup.includes('ordinaryOrderReadCuts.set(state,Object.freeze({generation:structuredClone(generation),installation:readInstallation,identity:readInstallationIdentity248}));'));
});
