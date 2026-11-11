/** Root-only diagnostic after a rejected restore. Preserves the original
 * archive and retains an isolated copy; never weakens acceptance checks. */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import pg from 'pg';
import { localConfig, pool } from '../server/db';
import { schemaFingerprint, recoveryKey, unsealFile, tableFingerprints } from '../server/recovery';
const root = '<workspace>/app';
const dir = resolve(root, 'data/product-catalogs-restore-diagnostic157');
let source: pg.Client | undefined, copy: pg.Client | undefined;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function command(name: string, args: string[], password?: string) {
  const c = spawn(name, args, { stdio: ['ignore','ignore','ignore'],
    env: password ? { PATH: process.env.PATH, PGPASSWORD: password, PGCONNECT_TIMEOUT: '5', LC_ALL: 'C' } : process.env });
  await new Promise<void>((ok, bad) => { c.on('error', bad); c.on('exit', code => code === 0 ? ok() : bad(Error('Diagnostic child failed'))); });
}
async function metadata(c: pg.Client) {
  let rows: any[] = [];
  const h = await schemaFingerprint({ query: async (sql: string) => { const r = await c.query(sql); rows = r.rows; return r; } } as any, 3);
  return { hash: h, rows };
}
async function main() {
  assert.equal(process.cwd(), root); assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(root,'.local.json'));
  assert.equal(process.env.QA157_RESTORE_DIAGNOSTIC_CONFIRM, 'ISOLATED_COPY_SCHEMA_DIFF_ONLY');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  await mkdir(dir, { mode: 0o700 });
  const archive = resolve(root, 'data/product-catalogs-backups157/mux7bq72-a84ab32f20cd9884.dyna');
  assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), '2621a3f27a80dfb99e302179779bc52f95bd54854bf2f3947218ab02a066028f');
  await unsealFile(archive, resolve(dir,'bundle.tar.gz'), await recoveryKey(resolve(root,'data/product-catalogs-backup-key157')));
  await command('tar',['-xzf',resolve(dir,'bundle.tar.gz'),'-C',dir]);
  const manifest = JSON.parse(await readFile(resolve(dir,'manifest.json'),'utf8'));
  const database = 'dynaminds_restore_' + randomBytes(8).toString('hex');
  await writeFile(resolve(dir,'custody.json'),JSON.stringify({stage:157,database,status:'DIAGNOSTIC_PREPARED_NOT_ACCEPTED',archive_sha256:'2621a3f27a80dfb99e302179779bc52f95bd54854bf2f3947218ab02a066028f'})+'\n',{flag:'wx',mode:0o600});
  source = new pg.Client(pool.options); await source.connect();
  await source.query(`CREATE DATABASE ${database}`);
  await command(resolve(homedir(),'.local/share/dynaminds/pg-tools/18/bin/pg_restore'),
    ['--host=127.0.0.1','--port=55432','--username=postgres','--no-password','--dbname='+database,'--single-transaction','--exit-on-error','--no-owner',resolve(dir,'database.dump')],localConfig.dbPassword);
  copy = new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:localConfig.dbPassword,database}); await copy.connect();
  for(const c of[source,copy]){await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");}
  const a = await metadata(source), b = await metadata(copy);
  assert.equal(a.hash, manifest.schema_sha256, 'Source schema still equals sealed snapshot');
  const key = (r: any) => r.kind+':'+r.name;
  const sourceMap = new Map(a.rows.map(r=>[key(r),r])); const copyMap = new Map(b.rows.map(r=>[key(r),r]));
  const diffs = [...new Set([...sourceMap.keys(),...copyMap.keys()])].sort()
    .filter(k=>hash(sourceMap.get(k))!==hash(copyMap.get(k)))
    .map(k=>({key:k,source:sourceMap.get(k),copy:copyMap.get(k)}));
  const rowsMatch = JSON.stringify(await tableFingerprints(copy))===JSON.stringify(manifest.tables);
  await writeFile(resolve(dir,'schema-diff.json'),JSON.stringify({database,source:a,copy:b,diffs,rows_match:rowsMatch},null,2)+'\n',{flag:'wx',mode:0o600});
  const report={stage:157,status:'DIAGNOSTIC_ONLY_RESTORE_NOT_ACCEPTED',source_schema_hash:a.hash,copy_schema_hash:b.hash,
    row_fingerprints_match:rowsMatch,differences:diffs.map(d=>d.key),retained_isolated_copy:true,acceptance_checks_weakened:false,full_goal_complete:false};
  await writeFile(resolve(root,'docs/product-catalogs-restore157-diagnostic.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(report));
}
main().catch(()=>{process.stderr.write('QA157_RESTORE_DIAGNOSTIC_FAILED_PRIVATE_DETAILS_WITHHELD\n');process.exitCode=1;})
  .finally(async()=>{await source?.end();await copy?.end();await pool.end();});
