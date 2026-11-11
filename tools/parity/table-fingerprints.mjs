#!/usr/bin/env node
/** MIG-5/MIG-4: row count and sha256 of every public table of a database, and a comparison with an earlier snapshot.
 *
 *   DATABASE_URL=postgres://postgres:…@127.0.0.1:<port>/<db> node tools/parity/table-fingerprints.mjs <out.json> [--compare <earlier.json>]
 *
 * A table's digest is md5 over its rows (text form of the columns of the snapshot, sorted), so a later release that
 * adds columns or tables compares on what the earlier one had: an added column with a default does not count as a
 * change, a changed or lost value does. `--compare` prints every table whose count or digest differs, every table
 * that disappeared, and the tables that are new; exit code 1 when any earlier table differs. Read-only (one
 * REPEATABLE READ READ ONLY transaction); no secret is printed. */
import fs from 'node:fs/promises';
import pg from 'pg';

const [outFile, flag, earlierFile] = process.argv.slice(2);
if (!outFile || (flag && (flag !== '--compare' || !earlierFile))) throw new Error('usage: table-fingerprints.mjs <out.json> [--compare <earlier.json>]');
const earlier = earlierFile ? JSON.parse(await fs.readFile(earlierFile, 'utf8')) : undefined;
const q = (name) => '"' + name.replaceAll('"', '""') + '"';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c statement_timeout=600000 -c timezone=UTC -c extra_float_digits=3 -c DateStyle=ISO' });
await c.connect();
const snapshot = { database: new URL(process.env.DATABASE_URL).pathname.slice(1), taken_at: new Date().toISOString(), tables: {} };
try {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const tables = (await c.query(`SELECT c.relname, array_agg(a.attname::text ORDER BY a.attnum) cols FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname='public' AND c.relkind IN ('r','p') GROUP BY c.relname ORDER BY c.relname`)).rows;
  for (const { relname, cols } of tables) {
    const use = earlier?.tables[relname]?.columns ?? cols, present = use.filter((x) => cols.includes(x));
    const row = present.length ? present.map((x) => `coalesce(${q(x)}::text,'∅')`).join(`||'|'||`) : `''`;
    const r = (await c.query(`SELECT count(*)::bigint n, md5(coalesce(string_agg(t.v, E'\\n' ORDER BY t.v),'')) d FROM (SELECT ${row} v FROM public.${q(relname)}) t`)).rows[0];
    snapshot.tables[relname] = { count: Number(r.n), md5: r.d, columns: earlier?.tables[relname] ? use : cols, missing_columns: use.filter((x) => !cols.includes(x)) };
  }
  await c.query('COMMIT');
} finally { await c.end(); }
await fs.writeFile(outFile, JSON.stringify(snapshot, null, 1) + '\n', { mode: 0o600 });
if (earlier) {
  const changed = [], gone = [], added = [];
  for (const [t, e] of Object.entries(earlier.tables)) {
    const n = snapshot.tables[t];
    if (!n) gone.push(t);
    else if (n.count !== e.count || n.md5 !== e.md5 || n.missing_columns.length) changed.push({ table: t, count: [e.count, n.count], missing_columns: n.missing_columns });
  }
  for (const t of Object.keys(snapshot.tables)) if (!earlier.tables[t]) added.push(t);
  const report = { earlier: earlier.database, now: snapshot.database, tables_earlier: Object.keys(earlier.tables).length, tables_now: Object.keys(snapshot.tables).length,
    identical: Object.keys(earlier.tables).length - changed.length - gone.length, changed, gone, added };
  console.log(JSON.stringify(report, null, 1));
  process.exitCode = changed.length || gone.length ? 1 : 0;
} else console.log(JSON.stringify({ database: snapshot.database, tables: Object.keys(snapshot.tables).length, rows: Object.values(snapshot.tables).reduce((s, t) => s + t.count, 0) }));
