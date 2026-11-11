// Exact row count of every table: restored template (Docker) vs its source on PG04 (read-only there).
// usage: node compare-template.mjs <pg04 locator.private.json> <template db> <docker template url> [--apply-owner-acl]
// pg_dump leaves out an ACL equal to the owner default, so a relation whose source ACL was materialized
// as exactly {owner=<all>/owner} comes back as NULL (same privileges, different catalog text). With
// --apply-owner-acl those relations get `GRANT ALL … TO <owner>`, which materializes the same ACL text.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const [locatorPath, template, dockerUrl, flag] = process.argv.slice(2);
const source = new URL(JSON.parse(readFileSync(locatorPath, 'utf8')).databaseUrl);
source.pathname = '/' + template;
async function counts(url) {
  const c = new pg.Client({ connectionString: url.toString(), options: '-c jit=off -c timezone=UTC' });
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = (await c.query(`SELECT format('%I.%I', n.nspname, c.relname) t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1`)).rows.map((r) => r.t);
    const out = {};
    for (const t of tables) out[t] = Number((await c.query(`SELECT count(*) n FROM ${t}`)).rows[0].n);
    const meta = (await c.query(`SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema'))::int functions,
      (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)::int triggers, (SELECT count(*) FROM pg_event_trigger)::int event_triggers,
      (SELECT count(*) FROM pg_policy)::int policies,
      (SELECT md5(string_agg(format('%s.%s %s', n.nspname, c.relname, c.relacl::text), ',' ORDER BY n.nspname, c.relname)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')) relation_acl_md5,
      (SELECT md5(string_agg(x, ',' ORDER BY x)) FROM (SELECT format('%s.%s(%s) %s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), p.proacl::text) x FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')) f) function_acl_md5,
      (SELECT md5(string_agg(format('%s %s', nspname, nspacl::text), ',' ORDER BY nspname)) FROM pg_namespace) schema_acl_md5,
      (SELECT md5(coalesce(string_agg(format('%s %s %s %s', defaclrole::regrole, defaclnamespace, defaclobjtype, defaclacl::text), ',' ORDER BY defaclrole, defaclnamespace, defaclobjtype), '')) FROM pg_default_acl) default_acl_md5,
      (SELECT md5(string_agg(format('%s.%s %s', n.nspname, t.typname, t.typacl::text), ',' ORDER BY n.nspname, t.typname)) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')) type_acl_md5, (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast'))::int indexes`)).rows[0];
    await c.query('ROLLBACK');
    return { tables: out, meta };
  } finally { await c.end(); }
}
const ACL_SQL = `SELECT format('%I.%I', n.nspname, c.relname) k, c.relkind::text kind, pg_get_userbyid(c.relowner) owner, c.relacl::text acl
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
  UNION ALL SELECT format('%I', nspname), 'schema', pg_get_userbyid(nspowner), nspacl::text FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`;
async function acls(url) {
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  try { return new Map((await c.query(ACL_SQL)).rows.map((r) => [r.k, r])); } finally { await c.end(); }
}
if (flag === '--apply-owner-acl') {
  const [src, dst] = await Promise.all([acls(source), acls(dockerUrl)]);
  const c = new pg.Client({ connectionString: dockerUrl });
  await c.connect();
  let applied = 0;
  try {
    for (const [k, s] of src) {
      const d = dst.get(k);
      if (!d || d.acl !== null || s.acl === null || !/^\{[^,]+\}$/.test(s.acl) || !s.acl.startsWith(`{${s.owner}=`)) continue;
      const what = s.kind === 'S' ? 'SEQUENCE' : s.kind === 'schema' ? 'SCHEMA' : 'TABLE';
      await c.query(`GRANT ALL ON ${what} ${k} TO ${s.owner}`);
      applied++;
    }
  } finally { await c.end(); }
  console.log(`owner ACL materialized on ${applied} relations`);
}
const [a, b] = await Promise.all([counts(source), counts(dockerUrl)]);
const names = new Set([...Object.keys(a.tables), ...Object.keys(b.tables)]);
const diff = [...names].filter((t) => a.tables[t] !== b.tables[t]).map((t) => ({ table: t, pg04: a.tables[t], docker: b.tables[t] }));
const rows = (x) => Object.values(x.tables).reduce((s, n) => s + n, 0);
console.log(JSON.stringify({ tables: names.size, rows_pg04: rows(a), rows_docker: rows(b), meta_pg04: a.meta, meta_docker: b.meta, differing_tables: diff }));
process.exit(diff.length || JSON.stringify(a.meta) !== JSON.stringify(b.meta) ? 1 : 0);
