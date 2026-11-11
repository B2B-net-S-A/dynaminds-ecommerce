/** ROOT ONLY. Authoring does not run this helper.
 * QA_EXPECTED_REVISION=<40 SHA> DYNA_WORKER_DISABLED=true DATABASE_URL=<native loopback>
 * tsx scripts/price-file-import-native-readback.ts checkpoint|verifyrestart
 * GET + UTC REPEATABLE READ READ ONLY. New checkpoints/reports use wx; setup is immutable.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
type Row = Record<string, any>;
type Snapshot = Record<string, { count: number; sha256: string }>;
type Readback = {
  snapshot: Snapshot;
  previews: Row[];
  executions: Row[];
  core_previews: Row[];
  core_rows: Row[];
  core_executions: Row[];
  core_execution_rows: Row[];
  lists: Row[];
  items: Row[];
  audit: Row[];
  unchanged_tables: string[];
  causal_tables: string[];
};
const setupPath = 'data/price-file-import-stage130.json';
const checkpointPath = 'data/price-file-import-stage130-chrome-checkpoint.json';
const schema = '113_price_file_imports';
const prefix = '/price-file-imports';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
let pool: Pool | undefined;
let step = 'preflight';
const phase = process.argv[2];
async function absent(path: string) {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw new Error('Refuse existing checkpoint/report');
}
async function privateBytes(path: string) {
  const st = await lstat(path);
  assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600);
  assert(st.size <= 32 * 1024 * 1024);
  return readFile(path);
}
function sameSet(actual: string[], expected: string[]) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}
function ms(value: unknown) {
  assert.equal(typeof value, 'string');
  const result = new Date(value as string).toISOString();
  assert(!Number.isNaN(Date.parse(result)));
  return result;
}
async function get(s: Row | null, path: string): Promise<Row> {
  assert(path.startsWith('/') && !path.startsWith('//'));
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: s ? { cookie: s.cookie, 'X-Workspace-ID': s.tenant } : {},
  });
  assert.equal(r.status, 200, 'GET failed; no login or automatic retry here');
  if (s) assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  const body = await r.text();
  assert(Buffer.byteLength(body) <= 8 * 1024 * 1024);
  return JSON.parse(body) as Row;
}
async function health() {
  const h = await get(null, '/health');
  assert.equal(h.status, 'ok');
  assert.equal(h.mode, 'local');
  assert.equal(h.schema_revision, schema);
  assert.equal(h.revision, process.env.QA_EXPECTED_REVISION);
  assert.equal(h.background_workers_enabled, false);
  assert.equal(h.restore_preview, false);
  assert.equal(h.price_file_import_available, true);
  return h;
}
async function rows(c: PoolClient, table: string, s: Row): Promise<Row[]> {
  assert.match(table, /^[a-z_][a-z0-9_]*$/);
  const key = ['users', 'tenants'].includes(table) ? 'id' : 'tenant_id';
  return (
    await c.query(`SELECT to_jsonb(t) row FROM "${table}" t WHERE ${key}=$1 ORDER BY 1`, [
      table === 'users' ? s.user : s.tenant,
    ])
  ).rows;
}
async function snapshot(c: PoolClient, s: Row): Promise<Snapshot> {
  const names: string[] = (
    await c.query(
      `SELECT t.table_name FROM information_schema.tables t JOIN information_schema.columns k USING(table_schema,table_name) WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id' AND t.table_name<>'sessions' UNION SELECT 'users' UNION SELECT 'tenants' ORDER BY 1`,
    )
  ).rows.map((r) => r.table_name);
  const result: Snapshot = {};
  for (const name of names) {
    const v = await rows(c, name, s);
    result[name] = { count: v.length, sha256: hash(v) };
  }
  return result;
}
async function readback(s: Row): Promise<Readback> {
  assert(pool);
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    assert.equal((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    const now: Snapshot = await snapshot(c, s),
      baseline = s.setup_checkpoint as Snapshot;
    sameSet(Object.keys(now), Object.keys(baseline));
    const causal = [
      'price_lists',
      'price_list_items',
      'price_file_import_previews',
      'price_file_import_executions',
      'price_bulk_edit_previews',
      'price_bulk_edit_rows',
      'price_bulk_edit_executions',
      'price_bulk_edit_execution_rows',
      'audit_events',
    ];
    const unchanged: string[] = [];
    for (const [name, v] of Object.entries(now))
      if (!causal.includes(name)) {
        assert.deepEqual(v, baseline[name], 'Unexpected change outside import: ' + name);
        unchanged.push(name);
      }
    const load = async (table: string) => (await rows(c, table, s)).map((r) => r.row as Row);
    const previews: Row[] = await load('price_file_import_previews'),
      executions: Row[] = await load('price_file_import_executions'),
      core_previews: Row[] = await load('price_bulk_edit_previews'),
      core_rows: Row[] = await load('price_bulk_edit_rows'),
      core_executions: Row[] = await load('price_bulk_edit_executions'),
      core_execution_rows: Row[] = await load('price_bulk_edit_execution_rows'),
      lists: Row[] = await load('price_lists'),
      items: Row[] = await load('price_list_items'),
      audit: Row[] = await load('audit_events');
    for (const name of causal.filter(
      (n) => n.startsWith('price_file_import_') || n.startsWith('price_bulk_edit_'),
    ))
      assert.equal(baseline[name].count, 0, 'Fixture already had import history');
    assert.equal(previews.length, 2);
    assert.equal(executions.length, 2);
    assert.equal(core_previews.length, 2);
    assert.equal(core_executions.length, 2);
    assert.equal(core_rows.length, 54);
    assert.equal(core_execution_rows.length, 54);
    assert.equal(lists.length, 2);
    assert.equal(baseline.price_lists.count, 2);
    assert.equal(baseline.price_list_items.count, 3);
    const csv = previews.find((p) => p.definition.format === 'csv'),
      xml = previews.find((p) => p.definition.format === 'xml');
    assert(csv && xml);
    assert.equal(csv.price_list_id, s.pln.id);
    assert.equal(xml.price_list_id, s.eur.id);
    assert.equal(csv.source_hash, s.files.csv.sha256);
    assert.equal(xml.source_hash, s.files.xml.sha256);
    assert.equal(csv.definition.basis, 'net');
    assert.equal(csv.definition.amount_mode, 'decimal');
    assert.equal(csv.definition.decimal_separator, ',');
    assert.equal(csv.definition.native_price_mode, 'mapped');
    assert.equal(xml.definition.native_price_mode, 'own_entries');
    assert.equal(csv.list_snapshot.version, 2);
    assert.equal(csv.list_snapshot.currency, 'PLN');
    assert.equal(xml.list_snapshot.version, 3);
    assert.equal(xml.list_snapshot.currency, 'EUR');
    assert.deepEqual(csv.summary, {
      total: 53,
      changed: 52,
      unchanged: 1,
      invalid: 0,
      conflicts: 0,
      missing_after_count: 0,
      ready: true,
    });
    assert.deepEqual(xml.summary, {
      total: 1,
      changed: 1,
      unchanged: 0,
      invalid: 0,
      conflicts: 0,
      missing_after_count: 0,
      ready: true,
    });
    assert.equal(csv.rows.length, 53);
    assert.equal(xml.rows.length, 1);
    const { parsePriceFile } = await import('../server/price-file-import-parse');
    for (const p of [csv, xml]) {
      assert.equal(p.tenant_id, s.tenant);
      assert.equal(p.actor_id, s.user);
      assert.equal(p.api_key_id, null);
      assert.equal(p.source, 'manual');
      assert.match(p.scope_hash, /^[a-f0-9]{64}$/);
      assert.match(p.request_hash, /^[a-f0-9]{64}$/);
      const file: Row = p === csv ? s.files.csv : s.files.xml,
        source = await readFile(file.path, 'utf8');
      assert.equal(bytesHash(source), file.sha256);
      const parsed = parsePriceFile({
        client_key: p.client_key,
        price_list_id: p.price_list_id,
        list_version: p.list_snapshot.version,
        file_name: p.file_name,
        content: source,
        definition: p.definition,
      });
      assert.deepEqual(
        p.rows.map((r: Row) => r.raw_cells),
        parsed.rows.map((r) => r.raw_cells),
      );
      const cp = core_previews.find((v) => v.id === p.core_preview_id),
        e = executions.find((v) => v.preview_id === p.id);
      assert(cp && e);
      const ce = core_executions.find((v) => v.id === e.core_execution_id);
      assert(ce);
      assert.equal(cp.client_key, p.id);
      assert.equal(cp.actor_id, s.user);
      assert.equal(cp.price_list_id, p.price_list_id);
      assert.deepEqual(cp.list_snapshot, p.list_snapshot);
      assert.deepEqual(cp.warnings, p.warnings);
      assert.equal(cp.total, p.summary.total);
      assert.equal(cp.changed, p.summary.changed);
      assert.equal(cp.unchanged, p.summary.unchanged);
      assert.equal(cp.ready, true);
      assert.equal(e.tenant_id, s.tenant);
      assert.equal(e.actor_id, s.user);
      assert.equal(e.api_key_id, null);
      assert.equal(e.scope_hash, p.scope_hash);
      assert.equal(e.ack_missing_prices, false);
      assert(e.top_xid && e.transaction_started_at);
      assert.equal(ce.preview_id, cp.id);
      assert.equal(ce.price_list_id, p.price_list_id);
      assert.equal(ce.actor_id, s.user);
      assert.equal(ce.scope_hash, cp.scope_hash);
      assert.equal(ce.total, p.summary.total);
      assert.equal(ce.changed, p.summary.changed);
      assert.equal(ce.unchanged, p.summary.unchanged);
      assert.equal(ce.before_list_version, p.list_snapshot.version);
      assert.equal(ce.after_list_version, p.list_snapshot.version + 1);
      assert.equal(ce.state, 'done');
      const cr = core_rows.filter((v) => v.preview_id === cp.id).sort((a, b) => a.index - b.index),
        er = core_execution_rows
          .filter((v) => v.execution_id === ce.id)
          .sort((a, b) => a.index - b.index);
      assert.equal(cr.length, p.rows.length);
      assert.equal(er.length, p.rows.length);
      for (let i = 0; i < p.rows.length; i++) {
        const r = p.rows[i],
          core = cr[i],
          done = er[i];
        assert.equal(r.index, i);
        assert.deepEqual(r.errors, []);
        assert.equal(core.index, i);
        assert.equal(done.index, i);
        assert.equal(core.product_id, r.product_id);
        assert.equal(done.product_id, r.product_id);
        for (const key of ['sku', 'name', 'input', 'status', 'before', 'after']) {
          assert.deepEqual(core[key], r[key]);
          assert.deepEqual(done[key], r[key]);
        }
        assert.equal(done.operation, r.input.operation);
        assert.equal(done.preview_id, cp.id);
        assert.equal(done.before_list_version, ce.before_list_version);
        assert.equal(done.after_list_version, ce.after_list_version);
      }
    }
    const expectedItems: Row[] = [];
    for (let i = 0; i < 53; i++) {
      const p = s.products[i],
        r: Row = csv.rows[i];
      assert.equal(r.product_id, p.id);
      assert.equal(r.sku, p.sku);
      assert.equal(r.input.product_version, p.version);
      assert.equal(r.before.currency, 'PLN');
      assert.equal(r.after.currency, 'PLN');
      assert.equal(r.before.vat, 23);
      assert.equal(r.after.vat, 23);
      const original = i === 0 ? 10001 : i === 2 ? 3000 : 1000;
      assert.equal(r.before.catalog_price, original);
      assert.equal(r.after.catalog_price, original);
      if (i === 1) {
        assert.equal(r.input.operation, 'none');
        assert.equal(r.status, 'unchanged');
        assert.equal(r.before.override_price, 700);
        assert.deepEqual(r.after, r.before);
      } else if (i === 2) {
        assert.equal(r.input.operation, 'remove');
        assert.equal(r.before.override_price, 900);
        assert.equal(r.after.override_present, false);
        assert.equal(r.after.override_price, null);
        assert.equal(r.after.source, 'rule');
        assert.equal(r.after.effective_price, 3000);
        assert.equal(r.status, 'changed');
      } else {
        const minor = i === 0 ? 10001 : i === 3 ? 0 : 1000,
          gross = i === 0 ? 12301 : i === 3 ? 0 : 1230;
        assert.deepEqual(r.input, {
          product_id: p.id,
          product_version: p.version,
          operation: 'set',
          basis: 'net',
          amount_minor: minor,
        });
        assert.equal(r.before.override_present, false);
        assert.equal(r.before.source, 'rule');
        assert.equal(r.after.override_present, true);
        assert.equal(r.after.override_price, gross);
        assert.equal(r.after.effective_price, gross);
        assert.equal(r.after.source, 'override');
        assert.equal(r.status, 'changed');
      }
      if (i !== 2)
        expectedItems.push({
          tenant_id: s.tenant,
          price_list_id: s.pln.id,
          product_id: p.id,
          price: i === 0 ? 12301 : i === 1 ? 700 : i === 3 ? 0 : 1230,
        });
    }
    const xr = xml.rows[0];
    assert.equal(xr.product_id, s.products[0].id);
    assert.equal(xr.input.operation, 'set');
    assert.equal(xr.input.basis, 'gross');
    assert.equal(xr.input.amount_minor, 2100);
    assert.equal(xr.before.override_price, 1000);
    assert.equal(xr.before.currency, 'EUR');
    assert.equal(xr.after.override_price, 2100);
    assert.equal(xr.after.currency, 'EUR');
    assert.equal(xr.skipped_price_groups, 1);
    assert.equal(xr.status, 'changed');
    expectedItems.push({
      tenant_id: s.tenant,
      price_list_id: s.eur.id,
      product_id: s.products[0].id,
      price: 2100,
    });
    const canonical = async (data: Row[]) =>
      (
        await c.query(
          'SELECT to_jsonb(x) row FROM jsonb_to_recordset($1::jsonb) x(tenant_id uuid,price_list_id uuid,product_id uuid,price integer) ORDER BY 1',
          [JSON.stringify(data)],
        )
      ).rows;
    assert.deepEqual(await rows(c, 'price_list_items', s), await canonical(expectedItems));
    const oldItems = [
      { tenant_id: s.tenant, price_list_id: s.pln.id, product_id: s.products[1].id, price: 700 },
      { tenant_id: s.tenant, price_list_id: s.pln.id, product_id: s.products[2].id, price: 900 },
      { tenant_id: s.tenant, price_list_id: s.eur.id, product_id: s.products[0].id, price: 1000 },
    ];
    assert.equal(hash(await canonical(oldItems)), baseline.price_list_items.sha256);
    // Exactly eight causal pricing audit entries. Removing them must recover the original full audit hash.
    const newAudit: Row[] = [];
    for (const p of [csv, xml]) {
      const e = executions.find((v) => v.preview_id === p.id)!;
      const cp = core_previews.find((v) => v.id === p.core_preview_id)!;
      const ce = core_executions.find((v) => v.id === e.core_execution_id)!;
      const expected: [string, string, Row][] = [
        [
          'pricing.bulk.preview',
          cp.id,
          { price_list_id: p.price_list_id, total: p.summary.total, scope_hash: cp.scope_hash },
        ],
        [
          'pricing.file.preview',
          p.id,
          { price_list_id: p.price_list_id, source_hash: p.source_hash, total: p.summary.total },
        ],
        [
          'pricing.bulk.execute',
          ce.id,
          {
            preview_id: cp.id,
            price_list_id: p.price_list_id,
            total: p.summary.total,
            changed: p.summary.changed,
            before_list_version: ce.before_list_version,
            after_list_version: ce.after_list_version,
          },
        ],
        ['pricing.file.execute', e.id, { preview_id: p.id, core_execution_id: ce.id }],
      ];
      for (const [action, entity_id, detail] of expected) {
        const found = audit.filter((v) => v.action === action && v.entity_id === entity_id);
        assert.equal(found.length, 1);
        assert.equal(found[0].user_id, s.user);
        assert.deepEqual(found[0].detail, detail);
        newAudit.push(found[0]);
      }
    }
    assert.equal(newAudit.length, 8);
    const auditIds = newAudit.map((v) => v.id);
    assert.equal(new Set(auditIds).size, 8);
    const originalAudit = (
      await c.query(
        'SELECT to_jsonb(a) row FROM audit_events a WHERE tenant_id=$1 AND NOT(id=ANY($2::uuid[])) ORDER BY 1',
        [s.tenant, auditIds],
      )
    ).rows;
    assert.equal(originalAudit.length, baseline.audit_events.count);
    assert.equal(hash(originalAudit), baseline.audit_events.sha256);
    // PUT pricing writes updated_at=now(); its original audit created_at is the same transaction clock, retaining microseconds.
    const restoredLists = (
      await c.query(
        `SELECT jsonb_set(jsonb_set(to_jsonb(l),'{version}',to_jsonb(x.version)),'{updated_at}',to_jsonb(a.created_at)) row
 FROM price_lists l JOIN (VALUES ($2::uuid,$3::int),($4::uuid,$5::int)) x(id,version) ON x.id=l.id
 JOIN audit_events a ON a.tenant_id=l.tenant_id AND a.entity_id=l.id AND a.action='pricing.items' AND (a.detail->>'version')::int=x.version
 WHERE l.tenant_id=$1 ORDER BY 1`,
        [s.tenant, s.pln.id, s.pln.version, s.eur.id, s.eur.version],
      )
    ).rows;
    assert.equal(restoredLists.length, 2);
    assert.equal(hash(restoredLists), baseline.price_lists.sha256);
    for (const list of lists) {
      const p: Row = list.id === s.pln.id ? csv : xml,
        e: Row = executions.find((v) => v.preview_id === p.id)!;
      assert.equal(list.version, list.id === s.pln.id ? 3 : 4);
      assert.equal(list.updated_at, e.transaction_started_at);
    }
    const effectCounts = {
      price_file_import_previews: 2,
      price_file_import_executions: 2,
      price_bulk_edit_previews: 2,
      price_bulk_edit_rows: 54,
      price_bulk_edit_executions: 2,
      price_bulk_edit_execution_rows: 54,
    };
    for (const [table, count] of Object.entries(effectCounts))
      assert.equal(now[table].count, count);
    await c.query('COMMIT');
    return {
      snapshot: now,
      previews,
      executions,
      core_previews,
      core_rows,
      core_executions,
      core_execution_rows,
      lists,
      items,
      audit: newAudit,
      unchanged_tables: unchanged,
      causal_tables: causal,
    };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
async function apiEvidence(s: Row, b: Readback) {
  const options = await get(s, prefix + '/options');
  assert.equal(options.available, true);
  assert.equal(options.read_only, false);
  assert.equal(options.can_write, true);
  assert.equal(options.catalog_currency, 'PLN');
  const observed: Row[] = [];
  for (const kind of ['previews', 'executions'] as const) {
    const h = await get(s, prefix + '/' + kind);
    assert.equal(h.meta.total, 2);
    assert.equal(h.meta.cursor, null);
    sameSet(
      h.data.map((v: Row) => v.id),
      b[kind].map((v) => v.id),
    );
    for (const row of b[kind]) {
      const p = kind === 'previews' ? row : b.previews.find((v) => v.id === row.preview_id)!;
      const detail = await get(s, prefix + '/' + kind + '/' + row.id),
        view = detail[kind === 'previews' ? 'preview' : 'execution'];
      assert.equal(view.id, row.id);
      assert.equal(view.core_preview_id, p.core_preview_id);
      assert.equal(view.scope_hash, p.scope_hash);
      assert.equal(view.source_hash, p.source_hash);
      assert.deepEqual(view.definition, p.definition);
      assert.deepEqual(view.list_snapshot, p.list_snapshot);
      assert.deepEqual(view.summary, p.summary);
      assert.equal(view.can_execute, false);
      assert.equal(
        view.execution_id,
        kind === 'executions' ? row.id : b.executions.find((v) => v.preview_id === p.id)!.id,
      );
      assert.equal(view.created_at, ms(row.created_at));
      if (kind === 'executions') {
        assert.equal(view.preview_id, p.id);
        assert.equal(view.core_execution_id, row.core_execution_id);
      }
      const found: Row[] = [];
      let cursor: string | null = null;
      const cursors = new Set<string>();
      do {
        const r = await get(
          s,
          prefix +
            '/' +
            kind +
            '/' +
            row.id +
            '/rows' +
            (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
        );
        assert.equal(r.meta.total, p.rows.length);
        assert(r.data.length <= 50);
        found.push(...r.data);
        cursor = r.meta.cursor;
        if (cursor) {
          assert(!cursors.has(cursor));
          cursors.add(cursor);
        }
      } while (cursor);
      assert.deepEqual(found, p.rows);
      assert.equal(found.length, p.rows.length);
      observed.push({ kind, id: row.id, total: found.length, source_hash: p.source_hash });
    }
  }
  return observed;
}
try {
  assert(phase === 'checkpoint' || phase === 'verifyrestart');
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.match(process.env.QA_EXPECTED_REVISION ?? '', /^[a-f0-9]{40}$/);
  const url = new URL(process.env.DATABASE_URL ?? 'postgres://127.0.0.1:55432/dynaminds');
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(decodeURIComponent(url.pathname), '/dynaminds');
  const reportPath =
    phase === 'checkpoint'
      ? 'docs/price-file-import-native-chrome-qa.json'
      : 'docs/price-file-import-native-restart-qa.json';
  await absent(reportPath);
  if (phase === 'checkpoint') await absent(checkpointPath);
  const original = await privateBytes(setupPath),
    s = JSON.parse(original.toString()) as Row;
  assert.equal(s.stage, 130);
  assert.equal(s.setup_complete, true);
  assert.equal(s.pending, null);
  assert.equal(s.schema_revision, schema);
  assert.equal(s.revision, process.env.QA_EXPECTED_REVISION);
  assert.equal(s.products.length, 53);
  assert(s.cookie && s.tenant && s.user);
  for (const file of [s.files.csv, s.files.xml]) {
    const st = await lstat(file.path);
    assert(st.isFile() && !st.isSymbolicLink());
    assert.equal(bytesHash(await readFile(file.path)), file.sha256);
  }
  const h = await health();
  const db = await import('../server/db');
  pool = db.pool;
  assert.equal((await pool.query('SELECT current_database() n')).rows[0].n, 'dynaminds');
  step = 'SQL-readback';
  const before: Readback = await readback(s);
  step = 'GET-evidence';
  const api = await apiEvidence(s, before);
  step = 'after-GET-preservation';
  const after: Readback = await readback(s);
  assert.deepEqual(after.snapshot, before.snapshot);
  assert.equal(bytesHash(await privateBytes(setupPath)), bytesHash(original));
  await health();
  let cpHash: string;
  if (phase === 'checkpoint') {
    const cp = {
      stage: 130,
      status: 'PASS',
      revision: h.revision,
      schema_revision: schema,
      setup_sha256: bytesHash(original),
      snapshot: after.snapshot,
      evidence: {
        previews: after.previews,
        executions: after.executions,
        core_previews: after.core_previews,
        core_rows: after.core_rows,
        core_executions: after.core_executions,
        core_execution_rows: after.core_execution_rows,
        lists: after.lists,
        items: after.items,
        audit: after.audit,
      },
      created_at: new Date().toISOString(),
      chrome_attestation:
        'Root performed real two-import flow; this helper verifies its current durable effects.',
    };
    await writeFile(checkpointPath, JSON.stringify(cp, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    cpHash = bytesHash(await privateBytes(checkpointPath));
  } else {
    const cpBytes = await privateBytes(checkpointPath),
      cp = JSON.parse(cpBytes.toString()) as Row;
    assert.equal(cp.stage, 130);
    assert.equal(cp.status, 'PASS');
    assert.equal(cp.revision, h.revision);
    assert.equal(cp.schema_revision, schema);
    assert.equal(cp.setup_sha256, bytesHash(original));
    assert.deepEqual(cp.snapshot, after.snapshot);
    assert.deepEqual(cp.evidence, {
      previews: after.previews,
      executions: after.executions,
      core_previews: after.core_previews,
      core_rows: after.core_rows,
      core_executions: after.core_executions,
      core_execution_rows: after.core_execution_rows,
      lists: after.lists,
      items: after.items,
      audit: after.audit,
    });
    cpHash = bytesHash(cpBytes);
  }
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        status: 'PASS',
        stage: 130,
        phase,
        revision: h.revision,
        schema_revision: schema,
        all_own_baseline_tables_verified: true,
        table_count: Object.keys(after.snapshot).length,
        unchanged_tables: after.unchanged_tables,
        causal_tables: after.causal_tables,
        setup_sha256: bytesHash(original),
        checkpoint_sha256: cpHash,
        pln: {
          rows: 53,
          changed: 52,
          unchanged: 1,
          basis: 'net',
          vat: 23,
          version: 3,
          own_entries: 52,
          first_minor: 12301,
          skip_minor: 700,
          remove_fallback_minor: 3000,
          zero_minor: 0,
          remaining_minor: 1230,
        },
        eur: { rows: 1, changed: 1, version: 4, first_minor: 2100, skipped_price_groups: 1 },
        api,
        background_workers_enabled: false,
        read_only_sql: true,
        restart_verified: phase === 'verifyrestart',
        restore_verified: false,
        previous_firms_verified: false,
        full_goal_complete: false,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  process.stdout.write(
    JSON.stringify({
      status: 'PASS',
      phase,
      tables: Object.keys(after.snapshot).length,
      rows: 54,
      restart_verified: phase === 'verifyrestart',
      restore_verified: false,
      full_goal_complete: false,
    }) + '\n',
  );
} catch (e) {
  const err = e as Error & { code?: string };
  await writeFile(
    `data/price-file-import-native-readback-failure-${phase ?? 'unknown'}-${randomUUID()}.txt`,
    `${step}\n${err.stack ?? err.message}\n`,
    { flag: 'wx', mode: 0o600 },
  ).catch(() => {});
  process.stderr.write(
    JSON.stringify({ status: 'FAIL', phase, step, error: err.name, code: err.code ?? null }) + '\n',
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
