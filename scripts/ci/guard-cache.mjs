/** CI-only preload (NODE_OPTIONS=--import, set by scripts/ci/run-tests.mjs for --kind db): reuses the answer of a
 * schema guard — `SELECT x_valid() ok`, `SELECT a_guards() AND a_installed() ok, …`, zero-argument functions only —
 * while nothing the guard depends on has changed. Production never loads this file; the server code is unchanged.
 *
 * Why: without the startup gate every tenantTx and every buildApp runs the full guards again (server/db.ts
 * preflightUngatedTenantSchema, ~70 availability probes in server/app.ts). One guard takes 2.5–5.5 s on a migrated
 * empty database (local measurement 12.11.2026), so an empty tenantTx took 13.7 s and buildApp 27 s, per call.
 *
 * Soundness: the first call runs the real guard on the caller's own connection and transaction and records what it
 * read and wrote (pg_stat_xact_user_tables before and after, in one implicit or the caller's transaction).
 * The answer is reused only when, on the caller's connection and snapshot, all of these are the same (a guard's
 * answer is a function of them; zero-argument guards check structure, not time or randomness):
 *  - every pg_catalog table (count and hash of ctid+xmin of all rows; pg_roles content instead of pg_authid; shared
 *    catalogues by the content of this database's rows, so that the next file's copy of the template matches),
 *  - every row version (ctid+xmin) of every table the guard read,
 *  - session settings (every non-default pg_settings value except timeouts), custom placeholders, current_user, session_user,
 *    own TEMP schema, advisory locks and strong relation locks (the session's own, or of the database when a called
 *    function tries a lock or reads pg_locks without the own-session filter),
 *  - the backend pid / the transaction's xid, when the guard read a table with a pid / xid column.
 * Not cached: a guard that read a TEMP table, wrote a row, took an xid, changed a setting, lock or the catalogue, or
 * raised; a built-in function (now(), …); a session without superuser
 * (inside tenantTx after SET ROLE dyna_app); any query with parameters or another shape. A wrong reuse would show as a
 * failing test (a refusal that does not come), never as a hidden pass in production code.
 * Files that inspect pg_stat_xact_* or count guard calls opt out (run-tests.mjs: noGuardCache, auto-detected).
 *
 * DYNA_CI_GUARD_CACHE_FILE=<file> keeps answers for the next files of the shard (each gets a copy of the same template).
 * DYNA_CI_GUARD_CACHE_STATS=<file> appends one JSON line per process: hits, misses (by cause), bypassed, uncacheable, ms.
 */
import { createRequire } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';

if (process.env.DYNA_TEST === 'true' && process.env.DYNA_CI_GUARD_CACHE === '1') install();

// A zero-argument call, or a row count of one table (nested-capability.ts asks both in one statement).
const CALL = String.raw`(?:(?:public\.)?[a-z_][a-z0-9_]*\(\)|\(SELECT count\(\*\)(?:::integer)? FROM (?:public\.)?[a-z_][a-z0-9_]*\))`;
const ITEM = String.raw`${CALL}(?:\s+AND\s+${CALL})*(?:\s+(?:AS\s+)?[a-z_][a-z0-9_]*)?`;
export const GUARD_QUERY = new RegExp(String.raw`^\s*SELECT\s+${ITEM}(?:\s*,\s*${ITEM})*\s*;?\s*$`, 'i');
// Not part of the answer of a guard: limits only change whether a slow guard would time out.
const IGNORED_SETTINGS = ['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout',
  'idle_session_timeout', 'transaction_timeout', 'application_name', 'track_functions'];
// Restricted to superusers or not about schema state (statistics, large object data).
const SKIPPED_CATALOGS = ['pg_authid', 'pg_statistic', 'pg_statistic_ext_data', 'pg_largeobject', 'pg_user_mapping'];

// Shared catalogues hold rows of every database: only this database's rows count, by content, so each copy of the
// shard's template (CREATE DATABASE … TEMPLATE) has the same key as the previous file's copy (DYNA_CI_GUARD_CACHE_FILE).
const SHARED_BY_CONTENT = {
  pg_database: `SELECT 'pg_database' r,'1' n,md5(row(datdba,encoding,datistemplate,datallowconn,datconnlimit,datcollate,datctype,datacl)::text) h
    FROM pg_database WHERE datname=current_database()`,
  pg_db_role_setting: `SELECT 'pg_db_role_setting' r,count(*)::text n,md5(coalesce(string_agg(x,',' ORDER BY x),'')) h FROM (SELECT concat_ws(':',setdatabase<>0,setrole,setconfig) x
    FROM pg_db_role_setting WHERE setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))) y`,
  pg_shdepend: `SELECT 'pg_shdepend' r,count(*)::text n,md5(coalesce(string_agg(x,',' ORDER BY x),'')) h FROM (SELECT concat_ws(':',dbid<>0,classid,objid,objsubid,refclassid,refobjid,deptype) x
    FROM pg_shdepend WHERE dbid IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))) y`,
  pg_shdescription: `SELECT 'pg_shdescription' r,count(*)::text n,md5(coalesce(string_agg(x::text,',' ORDER BY x::text),'')) h FROM pg_shdescription x`,
  pg_shseclabel: `SELECT 'pg_shseclabel' r,count(*)::text n,md5(coalesce(string_agg(x::text,',' ORDER BY x::text),'')) h FROM pg_shseclabel x`,
};

function install() {
  let pg;
  try { pg = createRequire(process.cwd() + '/')('pg'); } catch { return; }
  const proto = pg.Client.prototype;
  if (proto.__dynaGuardCache) return;
  const original = proto.query;
  const stats = { pid: process.pid, hits: 0, sharedHits: 0, misses: 0, bypassed: 0, uncacheable: 0, guardMs: 0, savedMs: 0, bypassedBy: {}, missBy: {} };
  const entries = new Map(); // text\0key -> up to 8 variants {result, rel:[{oid,name}], relBasis, pid?, xid?, ms}
  const refused = new Set(); // text: never cacheable (built-in call, write, new xid)
  // Answers of earlier files of the same shard (run-tests.mjs): same template, so the same catalogue and rows.
  const shared = process.env.DYNA_CI_GUARD_CACHE_FILE;
  if (shared) try {
    for (const line of readFileSync(shared, 'utf8').split('\n')) if (line) {
      // With --concurrency > 1 another file of the shard may be appending the last line right now.
      let row; try { row = JSON.parse(line); } catch { continue; }
      entries.set(row.id, [...(entries.get(row.id) ?? []), { ...row.variant, shared: true }].slice(0, 8));
    }
  } catch {}
  let catalogSql;
  const customNames = new Map(); // catalog hash -> custom GUC names the database's functions read or set

  const q = (client, text, values) => original.call(client, text, values);
  const one = async (client, text, values) => (await q(client, text, values)).rows[0];
  const clone = (r) => ({ command: r.command, rowCount: r.rowCount, oid: r.oid, fields: r.fields, rows: r.rows.map((x) => ({ ...x })) });

  const memo = new Map(); // pg_current_snapshot() text (session without xid) -> catalogue hash / row hashes
  const remember = (key, value) => { if (memo.size > 4000) memo.clear(); memo.set(key, value); return value; };
  async function catalogOf(client) {
    catalogSql ??= (await q(client, `SELECT c.oid::regclass::text n FROM pg_class c WHERE c.relnamespace='pg_catalog'::regnamespace
      AND c.relkind='r' AND NOT c.relname=ANY($1) ORDER BY 1`, [SKIPPED_CATALOGS])).rows
      .map(({ n }) => SHARED_BY_CONTENT[n] ?? `SELECT '${n}' r,count(*)::text n,coalesce(sum(hashtextextended(ctid::text||xmin::text,0)::numeric),0)::text h FROM ${n}`)
      .concat(`SELECT 'pg_roles' r,count(*)::text,md5(coalesce(string_agg(x::text,',' ORDER BY x.oid),'')) FROM pg_roles x`)
      .join(' UNION ALL ');
    return (await one(client, `SELECT md5(string_agg(r||':'||n||':'||h,',' ORDER BY r)) c FROM (${catalogSql}) t`)).c;
  }
  const placeholdersSql = `SELECT md5(coalesce(string_agg(n||'='||coalesce(current_setting(n,true),'<null>'),',' ORDER BY n),'')) FROM unnest($2::text[]) n`;
  /** One round trip while nothing was committed since the last call (same snapshot, no own xid); else +1–2. */
  async function keyOf(client, names = lastNames) {
    const k = await one(client, `WITH locks AS (SELECT concat_ws(':',locktype,classid,objid,objsubid,relation,mode,granted,pid=pg_backend_pid()) x,pid=pg_backend_pid() own
        FROM pg_locks WHERE (database IS NULL OR database=(SELECT oid FROM pg_database WHERE datname=current_database()))
        AND (locktype='advisory' OR (locktype='relation' AND mode IN('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock'))))
      SELECT current_setting('is_superuser') sup,current_user::text cu,session_user::text su,
      coalesce(pg_my_temp_schema()::oid::text,'0') tmp,pg_backend_pid() pid,pg_current_xact_id_if_assigned()::text xid,
      pg_current_snapshot()::text snap,
      (SELECT md5(string_agg(name||'='||coalesce(setting,''),',' ORDER BY name)) FROM pg_settings WHERE NOT name=ANY($1) AND (source<>'default' OR setting IS DISTINCT FROM boot_val)) s,
      (${placeholdersSql}) g,
      (SELECT md5(coalesce(string_agg(x,',' ORDER BY x),'')) FROM locks) l,
      (SELECT md5(coalesce(string_agg(x,',' ORDER BY x) FILTER (WHERE own),'')) FROM locks) lo`,
    [IGNORED_SETTINGS, names]);
    if (k.sup !== 'on') return k;
    k.clean = k.xid === null;
    k.c = (k.clean && memo.get('c' + k.snap)) || await catalogOf(client);
    if (k.clean) remember('c' + k.snap, k.c);
    // Placeholders (app.tenant_id set by tenantTx, …) are not in pg_settings; their names come from function sources.
    if (!customNames.has(k.c)) customNames.set(k.c, [...new Set(['app.tenant_id', ...((await one(client, `SELECT array_agg(DISTINCT lower(m[1]) ORDER BY lower(m[1])) n
      FROM pg_proc p, regexp_matches(p.prosrc, '(?:current_setting|set_config)\\(\\s*''{1,2}([a-z_][a-z0-9_$]*\\.[a-z0-9_$.]+)''', 'gi') m
      WHERE p.pronamespace NOT IN ('pg_catalog'::regnamespace,'information_schema'::regnamespace)`)).n ?? [])])].sort());
    const wanted = customNames.get(k.c);
    if (wanted.join() !== names.join()) { lastNames = wanted; k.g = Object.values(await one(client, placeholdersSql.replace('$2', '$1'), [wanted]))[0]; }
    return k;
  }
  let lastNames = ['app.tenant_id'];
  const debugSettings = new Map();
  const debugLocks = new Map();
  // {table oid: "count:hash"} as one JSON text (sorted keys), so a miss can name the table that changed.
  const relBasisSql = (rel) => `SELECT json_object_agg(r,n||':'||h ORDER BY r)::text b FROM (${
    rel.map(({ oid, name }) => `SELECT '${oid}' r,count(*)::text n,coalesce(sum(hashtextextended(ctid::text||xmin::text,0)::numeric),0)::text h FROM ${name}`).join(' UNION ALL ')}) t`;
  async function relBasis(client, rel, k) {
    if (!rel.length) return '{}';
    const key = 'r' + k.snap + '|' + rel.map((r) => r.oid).join();
    const known = k.clean && memo.get(key);
    if (known) return known;
    const b = (await one(client, relBasisSql(rel))).b;
    return k.clean ? remember(key, b) : b;
  }
  const KEY_PARTS = ['text', 'current_user', 'session_user', 'temp_schema', 'settings', 'catalog'];
  const countMiss = (cause) => { stats.missBy[cause] = (stats.missBy[cause] ?? 0) + 1; };
  function missCause(text, id, k, bases) {
    const now = id.split('\0');
    let best;
    for (const [eid, es] of entries) {
      if (!eid.startsWith(text + '\0')) continue;
      const diff = eid.split('\0').map((p, i) => p === now[i] ? '' : KEY_PARTS[i]).filter(Boolean);
      for (const e of es) {
        let cause = diff.length ? 'key:' + diff.join('+') : e.pid !== undefined && e.pid !== k.pid ? 'pid' : e.xid !== undefined && e.xid !== k.xid ? 'xid'
          : (e.locks !== undefined && e.locks !== k.l) || (e.ownLocks !== undefined && e.ownLocks !== k.lo) ? 'locks' : e.custom !== undefined && e.custom !== k.g ? 'placeholders' : '';
        if (!cause) {
          const was = JSON.parse(e.relBasis), is = JSON.parse(bases.get(e.rel.map((r) => r.oid).join()) ?? '{}');
          cause = 'rows:' + e.rel.filter((r) => was[r.oid] !== is[r.oid]).map((r) => r.name.replace(/^public\./, '')).join('+');
        }
        if (!best || cause.length < best.length) best = cause;
      }
    }
    return best ?? 'first';
  }

  async function cached(client, text) {
    const k = refused.has(text) ? undefined : await keyOf(client);
    const why = !k ? 'refused' : k.sup !== 'on' ? 'role' : '';
    if (why) {
      stats.bypassed++;
      const name = why + ':' + text.replace(/^\s*SELECT\s+/i, '').slice(0, 60);
      stats.bypassedBy[name] = (stats.bypassedBy[name] ?? 0) + 1;
      return q(client, text);
    }
    const id = [text, k.cu, k.su, k.tmp, k.s, k.c].join('\0');
    const bases = new Map(); // one row hash per table set (variants usually share it)
    for (const e of entries.get(id) ?? []) {
      if ((e.pid !== undefined && e.pid !== k.pid) || (e.xid !== undefined && e.xid !== k.xid)) continue;
      if ((e.locks !== undefined && e.locks !== k.l) || (e.ownLocks !== undefined && e.ownLocks !== k.lo) || (e.custom !== undefined && e.custom !== k.g)) continue;
      const set = e.rel.map((r) => r.oid).join();
      if (!bases.has(set)) bases.set(set, await relBasis(client, e.rel, k));
      if (bases.get(set) !== e.relBasis) continue;
      stats.hits++; stats.savedMs += e.ms; if (e.shared) stats.sharedHits++;
      return clone(e.result);
    }
    stats.misses++;
    const cause = missCause(text, id, k, bases);
    countMiss(cause);
    if (process.env.DYNA_CI_GUARD_CACHE_DEBUG) {
      const now = (await one(client, `SELECT json_object_agg(name,setting) s FROM pg_settings WHERE NOT name=ANY($1) AND (source<>'default' OR setting IS DISTINCT FROM boot_val)`, [IGNORED_SETTINGS])).s;
      const was = debugSettings.get(text) ?? {};
      const locks = (await one(client, `SELECT coalesce(json_agg(concat_ws(':',locktype,classid,objid,objsubid,relation::regclass,mode,granted,pid=pg_backend_pid()) ORDER BY 1),'[]') l
        FROM pg_locks WHERE (database IS NULL OR database=(SELECT oid FROM pg_database WHERE datname=current_database()))
        AND (locktype='advisory' OR (locktype='relation' AND mode IN('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')))`)).l;
      const wasLocks = debugLocks.get(text) ?? [];
      console.error('guard-cache miss', text.slice(0, 80), cause, cause.includes('settings') ? Object.keys({ ...was, ...now }).filter((n) => was[n] !== now[n]).map((n) => `${n}:${was[n]}->${now[n]}`).join(' ') : '',
        cause === 'locks' ? `-[${wasLocks.filter((x) => !locks.includes(x))}] +[${locks.filter((x) => !wasLocks.includes(x))}]` : '');
      debugSettings.set(text, now);
      debugLocks.set(text, locks);
    }
    const snap = `SELECT (SELECT coalesce(json_agg(json_build_array(relid,seq_scan,coalesce(idx_scan,0))),'[]') FROM pg_stat_xact_user_tables) t,
      (SELECT coalesce(json_agg(json_build_array(relid,n_tup_ins,n_tup_upd,n_tup_del)),'[]') FROM pg_stat_xact_user_tables) w,
      (SELECT coalesce(json_agg(json_build_array(funcid,calls)),'[]') FROM pg_stat_xact_user_functions) f`;
    const started = Date.now();
    const out = await q(client, `SELECT set_config('track_functions','all',true);${snap};${text.trim().replace(/;$/, '')};${snap}`);
    const ms = Date.now() - started;
    stats.guardMs += ms;
    const [, before, result, after] = out;
    const delta = (b, a, read) => {
      const m = new Map(b.rows[0][read].map(([id, ...v]) => [id, v.join()]));
      return a.rows[0][read].filter(([id, ...v]) => m.get(id) !== v.join()).map(([id]) => id);
    };
    const tables = delta(before, after, 't'), written = delta(before, after, 'w'), called = delta(before, after, 'f');
    const named = [...text.matchAll(/([a-z_][a-z0-9_.]*)\(\)/gi)].map((m) => m[1] + '()').filter((f) => f !== 'count()');
    const meta = await one(client, `SELECT
      (SELECT bool_and(p.oid IS NOT NULL AND p.pronamespace<>'pg_catalog'::regnamespace)
          FROM unnest($2::text[]) f LEFT JOIN pg_proc p ON p.oid=to_regprocedure(f)) stable,
      (SELECT coalesce(bool_or(relpersistence='t'),false) FROM pg_class WHERE oid=ANY($1::oid[])) temp,
      (SELECT coalesce(json_agg(json_build_object('oid',c.oid::text,'name',format('%I.%I',n.nspname,c.relname)) ORDER BY c.oid),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=ANY($1::oid[])) rel,
      EXISTS(SELECT FROM pg_attribute WHERE attrelid=ANY($1::oid[]) AND attnum>0 AND NOT attisdropped AND attname ~ 'pid') pid,
      EXISTS(SELECT FROM pg_attribute WHERE attrelid=ANY($1::oid[]) AND attnum>0 AND NOT attisdropped AND attname ~ 'xid') xid,
      -- Locks and placeholders are part of the answer only for a guard whose called functions mention them at all
      -- (literal copies of other definitions count too: over-inclusive, never under). Locks of other sessions only
      -- when a function tries a lock, asks for blockers or reads pg_locks without the own-session filter; the
      -- database's guards read only their own advisory locks (l.pid=pg_backend_pid()), while other connections of
      -- the test (OAuth refresh, workers) take and release advisory locks all the time (3688 misses, run 43262334505).
      (SELECT CASE WHEN bool_or(prosrc ~* 'pg_try_advisory|pg_blocking_pids|pg_lock_status'
          OR regexp_count(prosrc,'pg_locks',1,'i')>regexp_count(prosrc,'pg_locks\\M[^;]{0,250}\\mpid\\s*=\\s*pg_backend_pid\\(\\)',1,'i')) THEN 'all'
        WHEN bool_or(prosrc ~* 'pg_locks|advisory') THEN 'own' END FROM pg_proc WHERE oid=ANY($3::oid[])) locks,
      (SELECT coalesce(bool_or(prosrc ~* 'current_setting|set_config'),false) FROM pg_proc WHERE oid=ANY($3::oid[])) custom`,
    [tables, named, called]);
    // Many read-only guards are declared VOLATILE (the plpgsql default), so the test is what the call did: no row
    // written, no xid taken, the same settings, locks, catalogue and TEMP schema afterwards.
    const k2 = await keyOf(client);
    const id2 = [text, k2.cu, k2.su, k2.tmp, k2.s, k2.c].join('\0');
    if (!meta.stable || meta.temp || written.length || id2 !== id || k2.xid !== k.xid || k2.lo !== k.lo || (meta.locks === 'all' && k2.l !== k.l) || k2.g !== k.g) {
      if (process.env.DYNA_CI_GUARD_CACHE_DEBUG) console.error('guard-cache uncacheable', text, { stable: meta.stable, temp: meta.temp, written, sameKey: id2 === id, xid: [k.xid, k2.xid] });
      stats.uncacheable++;
      // A built-in call, a write or a new xid is the guard itself; a moved key or a TEMP read may be this call only.
      if (!meta.stable || written.length || k2.xid !== k.xid) refused.add(text);
      return result;
    }
    const variant = { result: clone(result), rel: meta.rel, relBasis: await relBasis(client, meta.rel, k2), ms,
      pid: meta.pid ? k2.pid : undefined, xid: meta.xid ? k2.xid : undefined,
      locks: meta.locks === 'all' ? k2.l : undefined, ownLocks: meta.locks === 'own' ? k2.lo : undefined, custom: meta.custom ? k2.g : undefined };
    entries.set(id2, [variant, ...(entries.get(id2) ?? [])].slice(0, 8));
    if (shared && variant.pid === undefined && variant.xid === undefined) try { appendFileSync(shared, JSON.stringify({ id: id2, variant }) + '\n'); } catch {}
    return result;
  }

  proto.query = function (config, values, callback) {
    if (typeof values === 'function') { callback = values; values = undefined; }
    if (typeof config !== 'string' || (values !== undefined && !(Array.isArray(values) && values.length === 0)) || !GUARD_QUERY.test(config))
      return original.call(this, config, values, callback);
    const p = cached(this, config);
    if (!callback) return p;
    p.then((r) => callback(null, r), (e) => callback(e));
    return undefined;
  };
  Object.defineProperty(proto, '__dynaGuardCache', { value: true });
  const file = process.env.DYNA_CI_GUARD_CACHE_STATS;
  if (file) process.on('exit', () => {
    if (stats.hits + stats.misses + stats.bypassed) try { appendFileSync(file, JSON.stringify(stats) + '\n'); } catch {}
  });
}
