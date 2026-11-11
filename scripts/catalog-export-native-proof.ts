/** Root QA114: reads existing own QA113 fixtures; never logs in or mutates them. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { SaxesParser } from 'saxes';
import { pool } from '../server/db';
import { verifyStocktakeScansPreservation } from './stocktake-scans-preservation';

type Json = Record<string, any>;
const phase = process.argv[2];
const fileImportStage = process.env.QA_FILE_IMPORT_STAGE === 'true';
const sourceStage = fileImportStage || process.env.QA_EXPORT_SOURCES_STAGE === 'true';
const profileStage = sourceStage || process.env.QA_EXPORT_PROFILE_STAGE === 'true';
const proofPrefix = fileImportStage
  ? 'catalog-file-import-preservation'
  : sourceStage
    ? 'catalog-export-sources-native'
    : profileStage
      ? 'catalog-export-profiles-native'
      : 'catalog-export-native';
assert(['before', 'after'].includes(phase), 'Use before or after');
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const revision = process.env.QA_EXPECTED_REVISION;
assert(revision && /^[a-f0-9]{7,40}$/.test(revision));
async function privateState(path: string): Promise<Json> {
  const st = await lstat(path);
  assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600);
  return JSON.parse(await readFile(path, 'utf8'));
}
async function checkpoint(s: Json, c: Json) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    const out: Json = {};
    for (const name of s.own_names as string[]) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const where =
        name === 'users' ? 'id=ANY($1::uuid[])' : name === 'tenants' ? 'id=$1' : 'tenant_id=$1';
      const rows = (
        await db.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${where} ORDER BY 1`, [
          name === 'users' ? [c.user, c.operator.user] : c.tenant,
        ])
      ).rows;
      out[name] = { count: rows.length, sha256: sha(rows) };
    }
    await db.query('COMMIT');
    assert.deepEqual(out, c.own_snapshot, 'Accepted own QA113 checkpoint changed');
    return { tenant: c.tenant, engine: c.engine, tables: s.own_names.length, sha256: sha(out) };
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    db.release();
  }
}
function csvExpected(row: Json, safe: boolean) {
  const keys = ['sku', 'ean', 'name', 'price_minor', 'vat_rate', 'active'];
  const values = [
    safe ? "'" + row.sku : row.sku,
    safe ? "'" + row.ean : row.ean,
    row.name,
    row.price,
    row.vat,
    row.active,
  ];
  const quote = (v: unknown) => '"' + String(v).replaceAll('"', '""') + '"';
  return (
    (safe ? '\ufeff' : '') +
    keys.map(quote).join(',') +
    '\r\n' +
    values.map(quote).join(',') +
    '\r\n'
  );
}
function verifyXml(body: string, row: Json) {
  const fields: Json = {};
  const parser = new SaxesParser({ xmlns: false });
  let name = '';
  let count = 0;
  parser.on('opentag', (tag) => {
    name = tag.name;
    if (name === 'catalog') assert.equal(tag.attributes.currency, 'PLN');
    if (name === 'product') ++count;
    if (['sku', 'ean', 'name', 'price_minor', 'vat_rate', 'active'].includes(name))
      fields[name] = '';
  });
  parser.on('text', (text) => {
    if (name in fields) fields[name] += text;
  });
  parser.on('closetag', () => {
    name = '';
  });
  parser.on('error', (error) => {
    throw error;
  });
  parser.write(body).close();
  assert.equal(count, 1);
  assert.deepEqual(fields, {
    sku: row.sku,
    ean: row.ean,
    name: row.name,
    price_minor: String(row.price),
    vat_rate: String(row.vat),
    active: String(row.active),
  });
}
async function apiFiles(c: Json) {
  const headers = {
    cookie: c.operator.cookie,
    'X-Workspace-ID': c.tenant,
    'Content-Type': 'application/json',
  };
  const me = await fetch('http://127.0.0.1:4100/api/auth/me', { headers });
  assert.equal(me.status, 200);
  const user = ((await me.json()) as Json).user;
  assert.equal(user.id, c.operator.user);
  assert.equal(user.tenant_id, c.tenant);
  assert.equal(user.role, 'operator');
  const row = (
    await pool.query(
      'SELECT sku,ean,name,price,vat,active FROM products WHERE tenant_id=$1 AND id=$2',
      [c.tenant, c.product.id],
    )
  ).rows[0];
  assert.equal(row.ean, '001130000007');
  const results: Json[] = [];
  for (const kind of ['safe', 'raw', 'xml']) {
    const format = kind === 'xml' ? 'xml' : 'csv';
    const r = await fetch('http://127.0.0.1:4100/api/catalog/exports/file', {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        format,
        selection: 'selected',
        ids: [c.product.id],
        columns: ['sku', 'ean', 'name', 'price_minor', 'vat_rate', 'active'],
        spreadsheet_safe: kind === 'safe',
      }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-catalog-export-count'), '1');
    assert.equal(r.headers.get('x-catalog-currency'), 'PLN');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('content-disposition') ?? '', new RegExp(`catalog\\.${format}`));
    const bytes = Buffer.from(await r.arrayBuffer()),
      body = bytes.toString('utf8');
    assert.equal(Number(r.headers.get('content-length')), bytes.length);
    if (kind === 'xml') verifyXml(body, row);
    else assert.equal(body, csvExpected(row, kind === 'safe'));
    const path = `docs/${proofPrefix}-${kind}.${format}`;
    await writeFile(path, bytes);
    results.push({
      kind,
      status: 200,
      count: 1,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      artifact: path,
    });
  }
  return results;
}
try {
  const health = await fetch('http://127.0.0.1:4100/api/health');
  assert.equal(health.status, 200);
  const h = (await health.json()) as Json;
  assert.equal(h.revision, revision);
  const withImports = h.schema_revision === '098_catalog_file_imports';
  const withSources = withImports || h.schema_revision === '097_catalog_export_sources';
  const withProfiles = withSources || h.schema_revision === '096_catalog_export_profiles';
  assert.equal(
    h.schema_revision,
    fileImportStage
      ? phase === 'after'
        ? '098_catalog_file_imports'
        : '097_catalog_export_sources'
      : sourceStage
        ? phase === 'after'
          ? '097_catalog_export_sources'
          : '096_catalog_export_profiles'
        : profileStage && phase === 'after'
          ? '096_catalog_export_profiles'
          : '095_stocktake_scan_recovery',
  );
  assert.equal(h.restore_preview, false);
  const s = await privateState('data/stocktake-scans-ack-stage113.json');
  assert.equal(s.stage, 113);
  assert.equal(s.ui_verified, true);
  const previous = await privateState('data/stocktake-scans-stage113.json');
  assert.equal(previous.stage, 113);
  assert.equal(previous.post_complete, true);
  const cases = [
    ...s.cases.map((c: Json) => ({ state: s, case: c })),
    ...previous.cases.map((c: Json) => ({ state: previous, case: c })),
  ];
  const before = [];
  for (const c of cases) before.push(await checkpoint(c.state, c.case));
  const original = await verifyStocktakeScansPreservation({
    catalogExportProfiles: withProfiles,
    catalogExportSources: withSources,
    catalogFileImports: withImports,
  });
  if (withProfiles) {
    for (const c of cases)
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM catalog_export_profiles WHERE tenant_id=$1',
            [c.case.tenant],
          )
        ).rows[0].n,
        0,
      );
    const baseline = JSON.parse(
      await readFile('data/stocktake-scans-stage113-baseline.json', 'utf8'),
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM catalog_export_profiles WHERE tenant_id=ANY($1::uuid[])',
          [baseline.firms],
        )
      ).rows[0].n,
      0,
      'Profiles cannot be added to protected original firms',
    );
  }
  assert(
    ['PASS_EXACT_ORIGINAL_ROWS', 'PASS_WITH_SOURCE_BOUND_LOCAL_JOBS'].includes(original.status),
  );
  const spoolBefore = (await readdir('data/catalog-export-temp')).sort();
  const downloads =
    phase === 'after' ? await apiFiles(s.cases.find((c: Json) => c.engine === 'quantity')) : [];
  const after = [];
  for (const c of cases) after.push(await checkpoint(c.state, c.case));
  assert.deepEqual(after, before);
  assert.deepEqual((await readdir('data/catalog-export-temp')).sort(), spoolBefore);
  let acceptedProfileCheckpoint;
  let acceptedSourcesCheckpoint;
  if (fileImportStage) {
    const sources = await privateState('data/catalog-export-sources-stage116.json');
    assert.equal(sources.stage, 116);
    assert(sources.accepted_checkpoint && sources.own_snapshot);
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TIME ZONE 'UTC'");
      const snapshot: Json = {};
      for (const name of sources.own_names as string[]) {
        assert(/^[a-z][a-z0-9_]*$/.test(name));
        const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
        const rows = (
          await c.query(
            `SELECT to_jsonb(t) row FROM "${name}" t
          WHERE ${key}=$1 ORDER BY 1`,
            [name === 'users' ? sources.user : sources.tenant],
          )
        ).rows;
        snapshot[name] = { count: rows.length, sha256: sha(rows) };
      }
      assert.deepEqual(snapshot, sources.own_snapshot, 'Accepted QA116 checkpoint changed');
      assert.deepEqual(snapshot, sources.accepted_checkpoint);
      await c.query('COMMIT');
      acceptedSourcesCheckpoint = {
        exact: true,
        tables: sources.own_names.length,
        sha256: sha(snapshot),
      };
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }
  if (sourceStage) {
    const profileState = await privateState('data/catalog-export-profiles-stage115.json');
    assert(profileState.stage === 115 && profileState.accepted_checkpoint);
    const profiles = (
      await pool.query(
        'SELECT to_jsonb(p) row FROM catalog_export_profiles p WHERE tenant_id=$1 ORDER BY id',
        [profileState.tenant],
      )
    ).rows;
    const product = (
      await pool.query(
        'SELECT name,sku,ean,price,vat,active FROM products WHERE tenant_id=$1 AND id=$2',
        [profileState.tenant, profileState.product.id],
      )
    ).rows[0];
    assert.equal(sha(profiles), profileState.accepted_checkpoint.profiles_sha256);
    assert.equal(sha(product), profileState.accepted_checkpoint.product_sha256);
    assert.equal(profiles.length, 3);
    acceptedProfileCheckpoint = {
      profiles: 3,
      profiles_sha256: sha(profiles),
      product_sha256: sha(product),
      exact: true,
    };
  }
  const proof = {
    status: 'PASS',
    phase,
    runtime_revision: revision,
    schema_revision: h.schema_revision,
    accepted_scan_checkpoints: after,
    ...(acceptedSourcesCheckpoint
      ? { accepted_export_sources_checkpoint: acceptedSourcesCheckpoint }
      : {}),
    ...(acceptedProfileCheckpoint
      ? { accepted_profile_checkpoint: acceptedProfileCheckpoint }
      : {}),
    older_preservation: original,
    downloads,
    provider_operations_performed: false,
    browser_download_bytes_verified: false,
    full_goal_complete: false,
  };
  await writeFile(`docs/${proofPrefix}-${phase}-qa.json`, JSON.stringify(proof, null, 2));
  process.stdout.write(
    JSON.stringify({
      status: 'PASS',
      phase,
      checkpoints: after.length,
      downloads: downloads.length,
    }) + '\n',
  );
} finally {
  await pool.end();
}
