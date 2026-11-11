import assert from 'node:assert/strict';
import type { Pool } from 'pg';

const ident = (name: string) => {
  assert.match(name, /^[a-z][a-z0-9_]*$/);
  return '"' + name + '"';
};

// Disposable, serial test fixture only. Rename the complete optional module,
// retaining every object OID and row, rather than pretending a torn module is old.
export async function withHistoricalCatalogModules<T>(pool: Pool, run: () => Promise<T>): Promise<T> {
  assert.equal(process.env.DYNA_TEST, 'true');
  const database = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
  assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
  const functions = (await pool.query(`SELECT oid,proname,proowner,proacl,pg_get_functiondef(oid) definition
    FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND (proname LIKE 'product_catalog_%' OR proname LIKE 'catalog_export_catalogs_%') ORDER BY oid`)).rows;
  const relations = (await pool.query(`SELECT oid,relname,relkind,relowner,relacl,relrowsecurity,relforcerowsecurity FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relname LIKE 'product_catalog%' ORDER BY oid`)).rows;
  assert(functions.length >= 26);
  assert.equal(relations.filter(r => r.relkind === 'r').length, 7);
  assert(relations.every(r => ['r', 'i'].includes(r.relkind)));
  const names = ['142_product_catalogs', '143_catalog_export_catalogs'];
  const markers = (await pool.query('SELECT name,applied_at::text applied_at FROM migrations WHERE name=ANY($1::text[]) ORDER BY name', [names])).rows;
  assert.equal(markers.length, 2);
  const rowHashes = async () => {
    const hashes: Record<string, string> = {};
    for (const r of relations.filter(r => r.relkind === 'r')) {
      hashes[r.relname] = (await pool.query(`SELECT encode(sha256(convert_to(coalesce(jsonb_agg(row ORDER BY row)::text,'[]'),'UTF8')),'hex') hash
        FROM (SELECT to_jsonb(q) row FROM ${ident(r.relname)} q) rows`)).rows[0].hash;
    }
    hashes.products_membership = (await pool.query(`SELECT encode(sha256(convert_to(coalesce(jsonb_agg(row ORDER BY row)::text,'[]'),'UTF8')),'hex') hash
      FROM (SELECT jsonb_build_array(id,tenant_id,catalog_id) row FROM products) rows`)).rows[0].hash;
    return hashes;
  };
  const before = await rowHashes();
  const c = await pool.connect();
  let hidden = false;
  try {
    await c.query('BEGIN');
    for (const fn of functions) {
      const signature = (await c.query('SELECT $1::oid::regprocedure::text signature', [fn.oid])).rows[0].signature;
      await c.query(`ALTER FUNCTION ${signature} RENAME TO ${ident('qa158_hidden_fn_' + fn.oid)}`);
    }
    for (const r of relations) await c.query(`ALTER ${r.relkind === 'i' ? 'INDEX' : 'TABLE'} ${ident(r.relname)} RENAME TO ${ident('qa158_hidden_rel_' + r.oid)}`);
    await c.query('ALTER TABLE products RENAME COLUMN catalog_id TO qa158_hidden_catalog_id');
    await c.query('DELETE FROM migrations WHERE name=ANY($1::text[])', [names]);
    await c.query('COMMIT');
    hidden = true;
    return await run();
  } finally {
    try {
      await c.query('ROLLBACK');
      if (hidden) {
        await c.query('BEGIN');
        await c.query('ALTER TABLE products RENAME COLUMN qa158_hidden_catalog_id TO catalog_id');
        for (const r of relations) await c.query(`ALTER ${r.relkind === 'i' ? 'INDEX' : 'TABLE'} ${ident('qa158_hidden_rel_' + r.oid)} RENAME TO ${ident(r.relname)}`);
        for (const fn of functions) {
          const signature = (await c.query('SELECT $1::oid::regprocedure::text signature', [fn.oid])).rows[0].signature;
          await c.query(`ALTER FUNCTION ${signature} RENAME TO ${ident(fn.proname)}`);
        }
        for (const m of markers) await c.query('INSERT INTO migrations(name,applied_at) VALUES($1,$2::timestamptz)', [m.name, m.applied_at]);
        await c.query('COMMIT');
        assert.deepEqual(await rowHashes(), before);
        assert.deepEqual((await c.query(`SELECT oid,proname,proowner,proacl,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid=ANY($1::oid[]) ORDER BY oid`, [functions.map(f => f.oid)])).rows, functions);
        assert.deepEqual((await c.query('SELECT oid,relname,relkind,relowner,relacl,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=ANY($1::oid[]) ORDER BY oid', [relations.map(r => r.oid)])).rows, relations);
        assert.deepEqual((await c.query('SELECT name,applied_at::text applied_at FROM migrations WHERE name=ANY($1::text[]) ORDER BY name', [names])).rows, markers);
      }
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }
}
