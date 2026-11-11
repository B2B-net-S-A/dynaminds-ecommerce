// Read-only business proof; synthetic QA sign-in changes sessions only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { pool } from '../server/db';
const snapshot = 'data/scale-stage035-native.json';
const previous = JSON.parse(await readFile('data/shopify-publication-stage034.json', 'utf8'));
const tables = Object.keys(previous.before);
assert.equal(tables.length, 45);
async function fingerprints() {
  const result: Record<string, { count: number; sha256: string }> = {};
  for (const table of tables) {
    assert(/^[a-z_]+$/.test(table));
    const rows = (await pool.query('SELECT to_jsonb(t)::text row FROM ' + table + ' t ORDER BY 1'))
      .rows;
    result[table] = {
      count: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return result;
}
try {
  if (process.argv[2] === 'baseline') {
    await writeFile(snapshot, JSON.stringify({ before: await fingerprints() }), { mode: 0o600 });
    console.log('Zapisano fingerprinty 45 tabel biznesowych bieżącej lokalnej bazy.');
  } else {
    const before = JSON.parse(await readFile(snapshot, 'utf8')).before;
    assert.deepEqual(await fingerprints(), before);
    const health = await (await fetch('http://127.0.0.1:4100/api/health')).json();
    assert.equal(health.status, 'ok');
    assert.equal(health.schema_revision, '029_stocktakes');
    const login = await fetch('http://127.0.0.1:4100/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'qa-shopify-publication@demo.local',
        password: 'DynaDemo!2026',
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const tenant = previous.fixture.tenant_id;
    const expected = (
      await pool.query('SELECT id,sku FROM products WHERE tenant_id=$1 ORDER BY id', [tenant])
    ).rows;
    const seen: string[] = [];
    let cursor = '';
    do {
      const response = await fetch(
        'http://127.0.0.1:4100/api/products?limit=2' + (cursor ? '&after=' + cursor : ''),
        { headers: { cookie } },
      );
      assert.equal(response.status, 200);
      const page = await response.json();
      for (const p of page.data) {
        assert.equal(p.tenant_id, tenant);
        seen.push(p.id);
      }
      cursor = page.meta.cursor ?? '';
    } while (cursor);
    assert.deepEqual(
      seen,
      expected.map((p) => p.id),
    );
    const searched = await fetch('http://127.0.0.1:4100/api/products?search=QA-SHOPIFY', {
      headers: { cookie },
    });
    assert.equal(searched.status, 200);
    assert((await searched.json()).data.every((p: any) => p.tenant_id === tenant));
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM pg_database WHERE datname LIKE 'dynaminds_scale_%'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await readdir('data')).filter((name) => /^scale-dynaminds_scale_.*\.json$/.test(name))
        .length,
      0,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM tenants WHERE name LIKE 'SCALE-FIXTURE-%'"))
        .rows[0].n,
      0,
    );
    assert.deepEqual(await fingerprints(), before);
    const proof = {
      checked_at: new Date().toISOString(),
      health,
      business_tables_preserved: 45,
      total_tenants: (await pool.query('SELECT count(*)::int n FROM tenants')).rows[0].n,
      native_qa_products: seen.length,
      cursor_complete_unique: true,
      search: true,
      fixture_tenants_in_native_database: 0,
      disposable_databases_remaining: 0,
      session_fixture_files_remaining: 0,
      provider_requests: 0,
    };
    await writeFile(
      process.argv.includes('--runtime')
        ? 'data/scale-stage035-runtime.json'
        : 'docs/scale-native-qa.json',
      JSON.stringify(proof, null, 2) + '\n',
    );
    console.log(JSON.stringify(proof));
  }
} finally {
  await pool.end();
}
