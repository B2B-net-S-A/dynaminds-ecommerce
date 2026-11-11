/** ROOT ONLY. Authoring does not run this helper.
 * QA_EXPECTED_REVISION=<40 SHA> DYNA_WORKER_DISABLED=true DATABASE_URL=<native loopback>
 * QA131_CHROME_VERIFIED=true checkpoint; QA131_RESTART_VERIFIED=true verifyrestart
 * tsx scripts/price-matrix-import-native-readback.ts checkpoint|verifyrestart
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
  evidence: Record<string, Row[]>;
  unchanged_tables: string[];
  causal_tables: string[];
};
const setupPath = 'data/price-matrix-import-stage131.json';
const checkpointPath = 'data/price-matrix-import-stage131-chrome-checkpoint.json';
const schema = '114_price_matrix_imports';
const prefix = '/price-matrix-imports';
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
  assert.equal(h.price_matrix_import_available, true);
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
    const now = await snapshot(c, s),
      baseline = s.setup_checkpoint as Snapshot;
    sameSet(Object.keys(now), Object.keys(baseline));
    assert.equal(Object.keys(now).length, 318);
    const causal = [
      'price_lists',
      'price_list_items',
      'price_matrix_import_previews',
      'price_matrix_import_targets',
      'price_matrix_import_executions',
      'price_matrix_import_execution_targets',
      'price_matrix_import_profiles',
      'price_matrix_import_profile_revisions',
      'price_bulk_edit_previews',
      'price_bulk_edit_rows',
      'price_bulk_edit_executions',
      'price_bulk_edit_execution_rows',
      'audit_events',
    ];
    const unchanged: string[] = [];
    for (const [name, value] of Object.entries(now))
      if (!causal.includes(name)) {
        assert.deepEqual(value, baseline[name], 'Unexpected change outside matrix: ' + name);
        unchanged.push(name);
      }
    const evidence: Record<string, Row[]> = {};
    for (const table of causal) evidence[table] = (await rows(c, table, s)).map((r) => r.row);
    const one = (name: string) => {
      assert.equal(evidence[name].length, 1, 'Expected exact single ' + name);
      return evidence[name][0];
    };
    const p = one('price_matrix_import_previews'),
      e = one('price_matrix_import_executions'),
      profile = one('price_matrix_import_profiles'),
      revision = one('price_matrix_import_profile_revisions');
    for (const name of causal.filter(
      (n) => n.startsWith('price_matrix_') || n.startsWith('price_bulk_'),
    ))
      assert.equal(baseline[name].count, 0, 'Setup already contained matrix/core/profile evidence');
    assert.equal(evidence.price_matrix_import_targets.length, 2);
    assert.equal(evidence.price_matrix_import_execution_targets.length, 2);
    assert.equal(evidence.price_bulk_edit_previews.length, 2);
    assert.equal(evidence.price_bulk_edit_executions.length, 2);
    assert.equal(evidence.price_bulk_edit_rows.length, 106);
    assert.equal(evidence.price_bulk_edit_execution_rows.length, 106);
    assert.equal(evidence.price_lists.length, 3);
    assert.equal(baseline.price_lists.count, 3);
    assert.equal(baseline.price_list_items.count, 5);
    assert.equal(p.actor_id, s.user);
    assert.equal(p.tenant_id, s.tenant);
    assert.equal(p.api_key_id, null);
    assert.equal(p.source, 'manual');
    assert.match(p.request_hash, /^[a-f0-9]{64}$/);
    assert.match(p.scope_hash, /^[a-f0-9]{64}$/);
    assert.equal(p.source_hash, s.files.csv.sha256);
    assert.equal(p.rows.length, 53);
    assert.deepEqual(
      p.targets.map((t: Row) => t.price_list_id),
      s.targets.map((t: Row) => t.price_list_id),
    );
    assert.deepEqual(p.summary, {
      total_products: 53,
      total_cells: 106,
      changed: 105,
      unchanged: 1,
      invalid: 0,
      conflicts: 0,
      missing_after_count: 1,
      ready: true,
    });
    const { priceBulkEditHash } = await import('../server/price-bulk-edit'),
      { parsePriceFile } = await import('../server/price-file-import-parse');
    const content = await readFile(s.files.csv.path, 'utf8');
    assert.equal(bytesHash(content), s.files.csv.sha256);
    const request = {
      client_key: p.client_key,
      file_name: p.file_name,
      content,
      targets: s.targets,
    };
    assert.equal(
      p.request_hash,
      priceBulkEditHash({ actor_id: s.user, api_key_id: null, request }),
    );
    const payload = {
      id: p.id,
      client_key: p.client_key,
      request_hash: p.request_hash,
      file_name: p.file_name,
      source_hash: p.source_hash,
      source: p.source,
      targets: p.targets,
      rows: p.rows,
      warnings: p.warnings,
      summary: p.summary,
    };
    assert.equal(p.scope_hash, priceBulkEditHash(payload));
    const parsed = parsePriceFile({
      client_key: p.client_key,
      file_name: p.file_name,
      content,
      price_list_id: s.pln.id,
      list_version: s.pln.version,
      definition: s.targets.find((t: Row) => t.price_list_id === s.pln.id).definition,
    });
    assert.deepEqual(
      p.rows.map((r: Row) => r.raw_cells),
      parsed.rows.map((r) => r.raw_cells),
    );
    assert.equal(e.preview_id, p.id);
    assert.equal(e.actor_id, s.user);
    assert.equal(e.tenant_id, s.tenant);
    assert.equal(e.api_key_id, null);
    assert.equal(e.scope_hash, p.scope_hash);
    assert(e.top_xid && e.transaction_started_at);
    assert.deepEqual(e.ack_missing_price_list_ids, [s.eur.id]);
    assert.deepEqual(
      e.core_execution_ids.map((v: Row) => v.price_list_id),
      s.targets.map((v: Row) => v.price_list_id),
    );
    assert.equal(
      e.request_hash,
      priceBulkEditHash({
        actor_id: s.user,
        api_key_id: null,
        request: {
          preview_id: p.id,
          client_key: e.client_key,
          scope_hash: p.scope_hash,
          confirmed: true,
          ack_missing_price_list_ids: [s.eur.id],
        },
      }),
    );
    const expectedItems: Row[] = [
      { tenant_id: s.tenant, price_list_id: s.third.id, product_id: s.products[0].id, price: 777 },
    ];
    for (const target of p.targets) {
      const original = s.targets.find((t: Row) => t.price_list_id === target.price_list_id);
      assert(original);
      assert.equal(target.list_version, original.list_version);
      assert.deepEqual(target.definition, original.definition);
      const pln = target.price_list_id === s.pln.id;
      assert.equal(target.list_snapshot.version, original.list_version);
      assert.equal(target.list_snapshot.currency, pln ? 'PLN' : 'EUR');
      const originalList = s.setup_pricing_rows.lists
        .map((v: Row) => v.row)
        .find((v: Row) => v.id === target.price_list_id);
      assert(originalList);
      const frameKeys = [
        'id',
        'name',
        'currency',
        'version',
        'active',
        'fallback',
        'adjustment_bps',
        'adjustment_amount',
      ];
      assert.deepEqual(target.list_snapshot, {
        ...Object.fromEntries(frameKeys.map((k) => [k, originalList[k]])),
        catalog_currency: 'PLN',
      });
      assert.deepEqual(target.repricing_snapshot, { rule: null, schedule: null, queued_run: null });
      assert.deepEqual(target.warnings, []);
      assert.deepEqual(p.warnings, []);
      assert.deepEqual(target.summary, {
        total: 53,
        changed: pln ? 52 : 53,
        unchanged: pln ? 1 : 0,
        invalid: 0,
        conflicts: 0,
        missing_after_count: pln ? 0 : 1,
        ready: true,
      });
      const cp = evidence.price_bulk_edit_previews.find((v) => v.id === target.core_preview_id),
        link = e.core_execution_ids.find((v: Row) => v.price_list_id === target.price_list_id);
      assert(cp && link);
      const ce = evidence.price_bulk_edit_executions.find((v) => v.id === link.core_execution_id);
      assert(ce);
      assert.equal(cp.client_key, target.core_client_key);
      assert.equal(cp.actor_id, s.user);
      assert.equal(cp.tenant_id, s.tenant);
      assert.equal(cp.source, 'manual');
      assert.equal(cp.price_list_id, target.price_list_id);
      assert.deepEqual(cp.list_snapshot, target.list_snapshot);
      assert.deepEqual(cp.repricing_snapshot, target.repricing_snapshot);
      assert.deepEqual(cp.warnings, target.warnings);
      for (const key of [
        'total',
        'changed',
        'unchanged',
        'invalid',
        'conflicts',
        'missing_after_count',
        'ready',
      ])
        assert.deepEqual(cp[key], target.summary[key]);
      assert.equal(ce.tenant_id, s.tenant);
      assert.equal(ce.actor_id, s.user);
      assert.equal(ce.preview_id, cp.id);
      assert.equal(ce.price_list_id, target.price_list_id);
      assert.equal(ce.scope_hash, cp.scope_hash);
      assert.equal(ce.state, 'done');
      assert.equal(ce.before_list_version, original.list_version);
      assert.equal(ce.after_list_version, original.list_version + 1);
      assert.equal(ce.ack_missing_prices, !pln);
      for (const key of ['total', 'changed', 'unchanged', 'missing_after_count'])
        assert.equal(ce[key], target.summary[key]);
      assert.deepEqual(ce.list_snapshot, target.list_snapshot);
      assert.deepEqual(ce.repricing_snapshot, target.repricing_snapshot);
      assert.deepEqual(ce.warnings, target.warnings);
      const typed = evidence.price_matrix_import_targets.find(
        (v) => v.price_list_id === target.price_list_id,
      );
      assert(typed);
      assert.deepEqual(typed, {
        tenant_id: s.tenant,
        preview_id: p.id,
        price_list_id: target.price_list_id,
        core_preview_id: cp.id,
        core_client_key: cp.client_key,
      });
      const typedDone = evidence.price_matrix_import_execution_targets.find(
        (v) => v.price_list_id === target.price_list_id,
      );
      assert(typedDone);
      assert.deepEqual(typedDone, {
        tenant_id: s.tenant,
        execution_id: e.id,
        preview_id: p.id,
        price_list_id: target.price_list_id,
        core_execution_id: ce.id,
      });
      const cr = evidence.price_bulk_edit_rows
          .filter((v) => v.preview_id === cp.id)
          .sort((a, b) => a.index - b.index),
        er = evidence.price_bulk_edit_execution_rows
          .filter((v) => v.execution_id === ce.id)
          .sort((a, b) => a.index - b.index);
      assert.equal(cr.length, 53);
      assert.equal(er.length, 53);
      const frozenKeys = [
        'index',
        'product_id',
        'sku',
        'name',
        'kind',
        'product_version',
        'input',
        'status',
        'before',
        'after',
        'errors',
      ];
      assert.equal(
        cp.scope_hash,
        priceBulkEditHash({
          list_snapshot: cp.list_snapshot,
          repricing_snapshot: cp.repricing_snapshot,
          warnings: cp.warnings,
          rows: cr.map((v) => Object.fromEntries(frozenKeys.map((k) => [k, v[k]]))),
        }),
      );
      assert.equal(
        cp.request_hash,
        priceBulkEditHash({
          source: 'manual',
          request: {
            client_key: cp.client_key,
            price_list_id: cp.price_list_id,
            list_version: original.list_version,
            rows: cr.map((v) => v.input),
          },
        }),
      );
      assert.equal(
        ce.request_hash,
        priceBulkEditHash({
          source: 'manual',
          request: {
            preview_id: cp.id,
            client_key: ce.client_key,
            scope_hash: cp.scope_hash,
            confirmed: true,
            ack_missing_prices: !pln,
          },
        }),
      );
      for (let i = 0; i < 53; i++) {
        const r = p.rows[i],
          product = s.products[i],
          cell = r.cells.find((v: Row) => v.price_list_id === target.price_list_id);
        assert(cell);
        assert.equal(r.index, i);
        assert.equal(r.product_id, product.id);
        assert.equal(r.sku, product.sku);
        assert.equal(r.name, product.name);
        assert.deepEqual(r.errors, []);
        assert.deepEqual(cell.errors, []);
        assert.deepEqual(r.resolution, {
          identity: 'sku',
          value: product.sku,
          matched_historical_sku: false,
        });
        assert.equal(r.cells.length, 2);
        sameSet(
          r.cells.map((v: Row) => v.price_list_id),
          [s.pln.id, s.eur.id],
        );
        for (const v of [cr[i], er[i]]) {
          assert.equal(v.index, i);
          assert.equal(v.product_id, product.id);
          assert.equal(v.tenant_id, s.tenant);
          for (const key of ['input', 'status', 'before', 'after'])
            assert.deepEqual(v[key], cell[key]);
          assert.equal(v.sku, r.sku);
          assert.equal(v.name, r.name);
        }
        assert.equal(cr[i].preview_id, cp.id);
        assert.equal(cr[i].product_version, product.version);
        assert.equal(er[i].preview_id, cp.id);
        assert.equal(er[i].execution_id, ce.id);
        assert.equal(er[i].operation, cell.input.operation);
        assert.equal(er[i].before_list_version, ce.before_list_version);
        assert.equal(er[i].after_list_version, ce.after_list_version);
        const originalPrice = i === 0 ? 10001 : i === 2 ? 3000 : 1000;
        for (const v of [cell.before, cell.after]) {
          assert.equal(v.currency, pln ? 'PLN' : 'EUR');
          assert.equal(v.catalog_price, originalPrice);
          assert.equal(v.vat, 23);
        }
        assert.equal(cell.input.product_id, product.id);
        assert.equal(cell.input.product_version, product.version);
        assert.equal(cell.skipped_price_groups, 0);
        const oldOwn = pln
          ? i === 1
            ? 700
            : i === 2
              ? 900
              : null
          : i === 0
            ? 1000
            : i === 2
              ? 500
              : null;
        assert.equal(cell.before.override_present, oldOwn !== null);
        assert.equal(cell.before.override_price, oldOwn);
        assert.deepEqual(cell.before, {
          currency: pln ? 'PLN' : 'EUR',
          vat: 23,
          catalog_price: originalPrice,
          override_present: oldOwn !== null,
          override_price: oldOwn,
          effective_price: oldOwn ?? (pln ? originalPrice : null),
          source: oldOwn !== null ? 'override' : pln ? 'rule' : 'missing',
          issue: !pln && oldOwn === null ? 'missing_override' : null,
        });
        if (pln && i === 1) {
          assert.deepEqual(cell.input, {
            product_id: product.id,
            product_version: product.version,
            operation: 'none',
          });
          assert.deepEqual(cell.after, cell.before);
          assert.equal(cell.status, 'unchanged');
        } else if (i === 2) {
          assert.deepEqual(cell.input, {
            product_id: product.id,
            product_version: product.version,
            operation: 'remove',
          });
          assert.equal(cell.after.override_present, false);
          assert.equal(cell.after.override_price, null);
          assert.equal(cell.after.source, pln ? 'rule' : 'missing');
          assert.equal(cell.after.effective_price, pln ? 3000 : null);
          assert.equal(cell.status, 'changed');
        } else {
          const amount = pln
            ? i === 0
              ? 10001
              : i === 3
                ? 0
                : 1000
            : i === 0
              ? 2100
              : i === 1
                ? 0
                : i === 3
                  ? 3000
                  : 1100;
          assert.deepEqual(cell.input, {
            product_id: product.id,
            product_version: product.version,
            operation: 'set',
            basis: pln ? 'net' : 'gross',
            amount_minor: amount,
          });
          assert.equal(cell.status, 'changed');
        }
        const price = pln
          ? i === 0
            ? 12301
            : i === 1
              ? 700
              : i === 3
                ? 0
                : 1230
          : i === 0
            ? 2100
            : i === 1
              ? 0
              : i === 3
                ? 3000
                : 1100;
        assert.deepEqual(cell.after, {
          currency: pln ? 'PLN' : 'EUR',
          vat: 23,
          catalog_price: originalPrice,
          override_present: i !== 2,
          override_price: i === 2 ? null : price,
          effective_price: i === 2 ? (pln ? 3000 : null) : price,
          source: i === 2 ? (pln ? 'rule' : 'missing') : 'override',
          issue: i === 2 && !pln ? 'missing_override' : null,
        });
        if (i !== 2) {
          assert.equal(cell.after.override_present, true);
          assert.equal(cell.after.override_price, price);
          assert.equal(cell.after.effective_price, price);
          assert.equal(cell.after.source, 'override');
          expectedItems.push({
            tenant_id: s.tenant,
            price_list_id: target.price_list_id,
            product_id: product.id,
            price,
          });
        }
      }
    }
    const canonical = async (values: Row[]) =>
      (
        await c.query('SELECT value row FROM jsonb_array_elements($1::jsonb) x(value) ORDER BY 1', [
          JSON.stringify(values),
        ])
      ).rows;
    assert.deepEqual(await rows(c, 'price_list_items', s), await canonical(expectedItems));
    assert.equal(
      hash(await canonical(s.setup_pricing_rows.items.map((v: Row) => v.row))),
      baseline.price_list_items.sha256,
    );
    assert.equal(
      hash(await canonical(s.setup_pricing_rows.lists.map((v: Row) => v.row))),
      baseline.price_lists.sha256,
    );
    for (const list of evidence.price_lists) {
      const original = s.setup_pricing_rows.lists
        .map((v: Row) => v.row)
        .find((v: Row) => v.id === list.id);
      assert(original);
      const selected = list.id !== s.third.id;
      if (selected) {
        assert.equal(list.version, original.version + 1);
        assert.equal(list.updated_at, e.transaction_started_at);
        assert.deepEqual(
          { ...list, version: original.version, updated_at: original.updated_at },
          original,
        );
      } else assert.deepEqual(list, original);
    }
    assert.equal(profile.version, 1);
    assert.equal(profile.tenant_id, s.tenant);
    assert.equal(revision.version, 1);
    assert.equal(revision.profile_id, profile.id);
    assert.equal(revision.actor_id, s.user);
    assert.equal(revision.api_key_id, null);
    assert.equal(revision.tenant_id, s.tenant);
    const profileTargets = s.targets.map(({ list_version, ...t }: Row) => t);
    assert.deepEqual(profile.targets, profileTargets);
    const { tenant_id, ...publicProfile } = profile;
    const revisionProfile = { ...revision.snapshot };
    // Preserve PostgreSQL microsecond precision while accepting equivalent offsets.
    for (const field of ["created_at", "updated_at"]) {
      const exactInstant = await c.query(
        "SELECT $1::timestamptz = $2::timestamptz AS same",
        [revisionProfile[field], publicProfile[field]],
      );
      assert.equal(exactInstant.rows[0].same, true, `Profile revision ${field}`);
      revisionProfile[field] = publicProfile[field];
    }
    assert.deepEqual(revisionProfile, publicProfile);
    const profileRequest = {
      client_key: revision.client_key,
      name: profile.name,
      targets: profileTargets,
    };
    assert.equal(
      revision.request_hash,
      priceBulkEditHash({
        actor_id: s.user,
        api_key_id: null,
        request: { id: null, body: profileRequest },
      }),
    );
    // Exactly six pricing audits: 2 core previews + matrix preview + 2 core executions + matrix execution.
    const newAudit: Row[] = [];
    const expected: [string, string, Row][] = [
      [
        'pricing.matrix.preview',
        p.id,
        {
          price_list_ids: p.targets.map((t: Row) => t.price_list_id),
          source_hash: p.source_hash,
          total_products: 53,
          total_cells: 106,
        },
      ],
      [
        'pricing.matrix.execute',
        e.id,
        { preview_id: p.id, core_execution_ids: e.core_execution_ids },
      ],
    ];
    for (const cp of evidence.price_bulk_edit_previews)
      expected.push([
        'pricing.bulk.preview',
        cp.id,
        { price_list_id: cp.price_list_id, total: 53, scope_hash: cp.scope_hash },
      ]);
    for (const ce of evidence.price_bulk_edit_executions)
      expected.push([
        'pricing.bulk.execute',
        ce.id,
        {
          preview_id: ce.preview_id,
          price_list_id: ce.price_list_id,
          total: 53,
          changed: ce.changed,
          before_list_version: ce.before_list_version,
          after_list_version: ce.after_list_version,
        },
      ]);
    for (const [action, id, detail] of expected) {
      const found = evidence.audit_events.filter((v) => v.action === action && v.entity_id === id);
      assert.equal(found.length, 1);
      assert.equal(found[0].user_id, s.user);
      assert.deepEqual(found[0].detail, detail);
      newAudit.push(found[0]);
    }
    assert.equal(newAudit.length, 6);
    assert.equal(new Set(newAudit.map((v) => v.id)).size, 6);
    const originals = (
      await c.query(
        'SELECT to_jsonb(a) row FROM audit_events a WHERE tenant_id=$1 AND NOT(id=ANY($2::uuid[])) ORDER BY 1',
        [s.tenant, newAudit.map((v) => v.id)],
      )
    ).rows;
    assert.equal(originals.length, baseline.audit_events.count);
    assert.equal(hash(originals), baseline.audit_events.sha256);
    evidence.audit_events = newAudit;
    await c.query('COMMIT');
    return { snapshot: now, evidence, unchanged_tables: unchanged, causal_tables: causal };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
function flags(v: Row) {
  assert.equal(v.available, true);
  assert.equal(v.read_only, false);
  assert.equal(v.current_role, 'admin');
  assert.equal(v.can_read, true);
  assert.equal(v.can_write, true);
}
function previewProjection(p: Row, e: Row) {
  return {
    id: p.id,
    actor_id: p.actor_id,
    file_name: p.file_name,
    source_hash: p.source_hash,
    targets: p.targets,
    warnings: p.warnings,
    summary: p.summary,
    scope_hash: p.scope_hash,
    execution_id: e.id,
    can_execute: false,
    created_at: ms(p.created_at),
  };
}
function executionProjection(p: Row, e: Row) {
  return {
    ...previewProjection(p, e),
    id: e.id,
    preview_id: p.id,
    core_execution_ids: e.core_execution_ids,
    ack_missing_price_list_ids: e.ack_missing_price_list_ids,
    created_at: ms(e.created_at),
  };
}
async function apiEvidence(s: Row, b: Readback) {
  const p = b.evidence.price_matrix_import_previews[0],
    e = b.evidence.price_matrix_import_executions[0],
    profile = b.evidence.price_matrix_import_profiles[0];
  const options = await get(s, prefix + '/options');
  flags(options);
  assert.equal(options.catalog_currency, 'PLN');
  assert.equal(options.meta.cursor, null);
  const optionKeys = [
    'id',
    'name',
    'currency',
    'version',
    'active',
    'fallback',
    'adjustment_bps',
    'adjustment_amount',
  ];
  assert.deepEqual(
    options.price_lists,
    [...b.evidence.price_lists]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((l) => Object.fromEntries(optionKeys.map((k) => [k, l[k]]))),
  );
  const { PRICE_MATRIX_IMPORT_LIMITS } = await import('../server/price-matrix-import-schema');
  assert.deepEqual(options.limits, PRICE_MATRIX_IMPORT_LIMITS);
  const result: Row[] = [];
  for (const kind of ['previews', 'executions'] as const) {
    const row = kind === 'previews' ? p : e,
      projection = kind === 'previews' ? previewProjection(p, e) : executionProjection(p, e);
    const history = await get(s, prefix + '/' + kind);
    flags(history);
    assert.deepEqual(history.meta, { total: 1, cursor: null });
    assert.deepEqual(history.data, [projection]);
    const detail = await get(s, prefix + '/' + kind + '/' + row.id);
    flags(detail);
    assert.deepEqual(detail[kind === 'previews' ? 'preview' : 'execution'], projection);
    const collected: Row[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    let page = 0;
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
      flags(r);
      assert.equal(r.meta.total, 53);
      assert.equal(r.data.length, page === 0 ? 50 : 3);
      collected.push(...r.data);
      cursor = r.meta.cursor;
      assert.equal(cursor, page === 0 ? '50' : null);
      if (cursor) {
        assert(!seen.has(cursor));
        seen.add(cursor);
      }
      page++;
      assert(page <= 2);
    } while (cursor);
    assert.equal(page, 2);
    assert.deepEqual(collected, p.rows);
    result.push({
      kind,
      history_count: 1,
      pages: 2,
      rows: 53,
      cells: 106,
      full_sql_projection_sha256: hash(projection),
      rows_sha256: hash(collected),
    });
  }
  const profileProjection = {
    id: profile.id,
    name: profile.name,
    version: profile.version,
    targets: profile.targets,
    created_at: ms(profile.created_at),
    updated_at: ms(profile.updated_at),
  };
  const profiles = await get(s, prefix + '/profiles');
  flags(profiles);
  assert.deepEqual(profiles.meta, { total: 1, cursor: null });
  assert.deepEqual(profiles.data, [profileProjection]);
  const detail = await get(s, prefix + '/profiles/' + profile.id);
  flags(detail);
  assert.deepEqual(detail.profile, profileProjection);
  return {
    no_store: true,
    options_exact: true,
    profile_count: 1,
    profile_version: 1,
    profile_sql_projection_sha256: hash(profileProjection),
    histories: result,
  };
}
try {
  assert(phase === 'checkpoint' || phase === 'verifyrestart');
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.match(process.env.QA_EXPECTED_REVISION ?? '', /^[a-f0-9]{40}$/);
  assert.equal(
    process.env[phase === 'checkpoint' ? 'QA131_CHROME_VERIFIED' : 'QA131_RESTART_VERIFIED'],
    'true',
    'Root process/UI attestation is required explicitly',
  );
  const configured = process.env.DYNA_LOCAL_CONFIG_PATH ?? '.local.json';
  const configStat = await lstat(configured);
  assert(
    configStat.isFile() && !configStat.isSymbolicLink(),
    'Existing native config required; no config creation',
  );
  const url = new URL(process.env.DATABASE_URL ?? 'postgres://127.0.0.1:55432/dynaminds');
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(decodeURIComponent(url.pathname), '/dynaminds');
  const reportPath =
    phase === 'checkpoint'
      ? 'docs/price-matrix-import-native-chrome-qa.json'
      : 'docs/price-matrix-import-native-restart-qa.json';
  await absent(reportPath);
  if (phase === 'checkpoint') await absent(checkpointPath);
  const original = await privateBytes(setupPath),
    s = JSON.parse(original.toString()) as Row;
  assert.equal(s.stage, 131);
  assert.equal(s.setup_complete, true);
  assert.equal(s.pending, null);
  assert.equal(s.schema_revision, schema);
  assert.equal(s.revision, process.env.QA_EXPECTED_REVISION);
  assert.equal(s.products.length, 53);
  assert.equal(new Set(s.products.map((p: Row) => p.id)).size, 53);
  assert.equal(s.completed.length, 60);
  assert(s.cookie && s.tenant && s.user);
  assert.equal(Object.keys(s.setup_checkpoint).length, 318);
  assert.equal(s.targets.length, 2);
  sameSet(
    s.targets.map((t: Row) => t.price_list_id),
    [s.pln.id, s.eur.id],
  );
  assert(s.setup_pricing_rows);
  for (const l of [s.pln, s.eur, s.third]) assert.equal(l.version, 2);
  const csvStat = await lstat(s.files.csv.path);
  assert(csvStat.isFile() && !csvStat.isSymbolicLink());
  const csvOriginal = await readFile(s.files.csv.path);
  assert.equal(csvOriginal.length, s.files.csv.bytes);
  assert.equal(bytesHash(csvOriginal), s.files.csv.sha256);
  const setupReport = JSON.parse(
    await readFile('docs/price-matrix-import-native-setup-qa.json', 'utf8'),
  ) as Row;
  assert.equal(setupReport.status, 'PASS');
  assert.equal(setupReport.stage, 131);
  assert.equal(setupReport.private_setup_sha256, bytesHash(original));
  assert.equal(setupReport.setup_checkpoint_sha256, hash(s.setup_checkpoint));
  assert.equal(setupReport.revision, s.revision);
  assert.equal(setupReport.schema_revision, schema);
  assert.equal(setupReport.table_count, 318);
  assert.equal(setupReport.background_workers_enabled, false);
  const h = await health();
  const db = await import('../server/db');
  pool = db.pool;
  assert.equal((await pool.query('SELECT current_database() n')).rows[0].n, 'dynaminds');
  step = 'SQL-readback';
  const before = await readback(s);
  step = 'GET-evidence';
  const api = await apiEvidence(s, before);
  step = 'after-GET-preservation';
  const after = await readback(s);
  assert.deepEqual(after.snapshot, before.snapshot);
  assert.deepEqual(after.evidence, before.evidence);
  assert.equal(bytesHash(await privateBytes(setupPath)), bytesHash(original));
  assert.equal(bytesHash(await readFile(s.files.csv.path)), bytesHash(csvOriginal));
  await health();
  let checkpointHash: string;
  if (phase === 'checkpoint') {
    const cp = {
      stage: 131,
      status: 'PASS',
      revision: h.revision,
      schema_revision: schema,
      setup: { path: setupPath, bytes: original.length, sha256: bytesHash(original) },
      source_csv_sha256: bytesHash(csvOriginal),
      snapshot: after.snapshot,
      evidence: after.evidence,
      api,
      chrome_verified: true,
      root_chrome_attestation:
        'QA131_CHROME_VERIFIED=true; root performed the profile and one matrix import.',
      created_at: new Date().toISOString(),
    };
    await writeFile(checkpointPath, JSON.stringify(cp, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    checkpointHash = bytesHash(await privateBytes(checkpointPath));
  } else {
    const cpBytes = await privateBytes(checkpointPath),
      cp = JSON.parse(cpBytes.toString()) as Row;
    assert.equal(cp.stage, 131);
    assert.equal(cp.status, 'PASS');
    assert.equal(cp.chrome_verified, true);
    assert.equal(cp.revision, h.revision);
    assert.equal(cp.schema_revision, schema);
    assert.deepEqual(cp.setup, {
      path: setupPath,
      bytes: original.length,
      sha256: bytesHash(original),
    });
    assert.equal(cp.source_csv_sha256, bytesHash(csvOriginal));
    assert.deepEqual(cp.snapshot, after.snapshot);
    assert.deepEqual(cp.evidence, after.evidence);
    assert.deepEqual(cp.api, api);
    checkpointHash = bytesHash(cpBytes);
    const chrome = JSON.parse(
      await readFile('docs/price-matrix-import-native-chrome-qa.json', 'utf8'),
    ) as Row;
    assert.equal(chrome.status, 'PASS');
    assert.equal(chrome.stage, 131);
    assert.equal(chrome.checkpoint_sha256, checkpointHash);
    assert.equal(chrome.setup_sha256, bytesHash(original));
    assert.equal(chrome.snapshot_sha256, hash(after.snapshot));
    assert.equal(chrome.evidence_sha256, hash(after.evidence));
    assert.equal(chrome.chrome_verified, true);
    assert.equal(chrome.revision, h.revision);
    assert.equal(chrome.schema_revision, schema);
    assert.equal(bytesHash(await privateBytes(checkpointPath)), checkpointHash);
  }
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        status: 'PASS',
        stage: 131,
        phase,
        revision: h.revision,
        schema_revision: schema,
        table_count: Object.keys(after.snapshot).length,
        sessions_excluded: true,
        setup_sha256: bytesHash(original),
        setup_checkpoint_sha256: hash(s.setup_checkpoint),
        checkpoint_sha256: checkpointHash,
        snapshot_sha256: hash(after.snapshot),
        evidence_sha256: hash(after.evidence),
        unchanged_tables: after.unchanged_tables,
        causal_tables: after.causal_tables,
        all_other_business_tables_exact: true,
        original_pricing_rows_verified: true,
        original_audit_prefix_exact: true,
        causal_audits: 6,
        profile: { count: 1, version: 1 },
        matrix: {
          previews: 1,
          executions: 1,
          targets: 2,
          execution_targets: 2,
          products: 53,
          cells: 106,
          changed: 105,
          unchanged: 1,
          missing: 1,
          acknowledged_missing_currencies: ['EUR'],
        },
        core: { previews: 2, executions: 2, preview_rows: 106, execution_rows: 106 },
        pln: {
          version: 3,
          changed: 52,
          unchanged: 1,
          own_entries: 52,
          first_minor: 12301,
          skip_minor: 700,
          remove_fallback_minor: 3000,
          zero_minor: 0,
          remaining_minor: 1230,
        },
        eur: {
          version: 3,
          changed: 53,
          own_entries: 52,
          first_minor: 2100,
          second_minor: 0,
          remove_missing: true,
          fourth_minor: 3000,
          remaining_minor: 1100,
        },
        third_list_unchanged: true,
        api,
        background_workers_enabled: false,
        read_only_sql: true,
        chrome_verified: true,
        restart_verified: phase === 'verifyrestart',
        root_restart_attestation:
          phase === 'verifyrestart'
            ? 'QA131_RESTART_VERIFIED=true; root verified shutdown and relaunch.'
            : null,
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
      stage: 131,
      phase,
      tables: 318,
      products: 53,
      cells: 106,
      changed: 105,
      unchanged: 1,
      restart_verified: phase === 'verifyrestart',
      restore_verified: false,
      full_goal_complete: false,
    }) + '\n',
  );
} catch (e) {
  const err = e as Error & { code?: string };
  await writeFile(
    `data/price-matrix-import-native-readback-failure-${phase === 'checkpoint' || phase === 'verifyrestart' ? phase : 'unknown'}-${randomUUID()}.txt`,
    `${step}\n${err.stack ?? err.message}\n`,
    { flag: 'wx', mode: 0o600 },
  ).catch(() => {});
  const frames = [
    ...(err.stack ?? '').matchAll(/price-matrix-import-native-readback\.ts:(\d+):\d+/g),
  ].map((m) => Number(m[1]));
  process.stderr.write(
    JSON.stringify({
      status: 'FAIL',
      phase: phase === 'checkpoint' || phase === 'verifyrestart' ? phase : 'unknown',
      step,
      error: err.name,
      code: err.code ?? null,
      source_lines: [...new Set(frames)],
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
