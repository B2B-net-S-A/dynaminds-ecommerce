/** MIG-4: the verified way back from a failed upgrade N -> N+1 (docs/release-upgrade-rollback.md).
 * There are no down-migrations: the database goes back by restoring the backup taken before the upgrade (MIG-3,
 * `<data>/backups/pre-migration/<id>.dyna`, or a manual `npm run backup -- create` of N) into a NEW database
 * dynaminds_restore_<hex>. Release N is then started on that database; the N+1 database is left untouched for
 * analysis. Nothing happens without the operator's explicit consent (`confirm` = name of the N+1 database) and while
 * any other session still uses the N+1 database (N+1 must be stopped). The restored ledger must be a strict prefix
 * state of the N+1 ledger (every restored migration is in N+1, N+1 has at least one more); otherwise the restored
 * database is dropped again and nothing else changes. Writes made by N+1 after the backup are not in the restore:
 * the result names the backup time (`data_lost_after`); a later point needs the physical PITR (tools/recovery). */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import pg from 'pg';
import { watchDbClient } from './db-connection-errors';

export class RollbackRefusedError extends Error {
  readonly code = 'ROLLBACK_REFUSED';
  constructor(message: string) { super(message); this.name = 'RollbackRefusedError'; }
}
export interface RollbackDatabase { readonly database: string; readonly password: string; readonly host: string; readonly port: number; readonly user: string }
interface RestoreResult { readonly id: string; readonly database: string; readonly directory: string; readonly config: string; readonly images: string;
  readonly snapshot_at: string; readonly source: string; readonly status: string; readonly preview_only: boolean; readonly purpose?: string }
export interface RollbackDeps {
  source: () => RollbackDatabase;
  /** Other sessions (not this process) connected to the database. */
  sessions: (db: RollbackDatabase, database: string) => Promise<number>;
  ledger: (db: RollbackDatabase, database: string) => Promise<string[]>;
  restore: (file: string, options: { directory?: string; keyFile?: string; purpose: 'rollback' }) => Promise<RestoreResult>;
  drop: (db: RollbackDatabase, database: string) => Promise<void>;
  sha256: (file: string) => Promise<string>;
  readText: (file: string) => Promise<string>;
  writeResult: (file: string, text: string) => Promise<void>;
  now: () => Date;
  operator?: () => string;
}
export interface RollbackOptions { backup: string; confirm?: string; keyFile?: string; directory?: string }
export interface RollbackResult {
  readonly status: 'rolled_back'; readonly purpose: 'rollback'; readonly preview_only: false;
  readonly rollback_of: string; readonly database: string; readonly directory: string; readonly config: string; readonly images: string;
  readonly backup: { readonly file: string; readonly id: string; readonly sha256: string; readonly created_at: string };
  readonly data_lost_after: string;
  readonly ledger: { readonly restored: number; readonly restored_last: string; readonly failed: number; readonly removed: readonly string[] };
  readonly consent: { readonly confirmed_database: string; readonly by: string; readonly at: string };
  readonly next: string;
}

const MASK = /(postgres(?:ql)?:\/\/)[^@\s/]*@/g;
const fail = (m: string): never => { throw new RollbackRefusedError(m); };

/** The backup's report `<file>.json` written by createBackup: it must describe this file and this database. */
function backupReport(text: string, file: string, sha: string, database: string) {
  let r: Record<string, unknown>;
  try { r = JSON.parse(text); } catch { return fail('Raport kopii ' + file + '.json nie jest poprawnym JSON.'); }
  // `schema` is the row count of `migrations` in the backup (createBackup writes it as the numeric text of count(*)).
  const schema = typeof r.schema === 'string' && /^[1-9][0-9]{0,5}$/.test(r.schema) ? Number(r.schema) : r.schema;
  if (r.status !== 'created' || typeof r.id !== 'string' || typeof r.created_at !== 'string' || typeof schema !== 'number' || !Number.isSafeInteger(schema))
    fail('Raport kopii ' + file + '.json nie opisuje utworzonej kopii (status, id, created_at, schema).');
  if (r.sha256 !== sha) fail('Plik kopii ' + file + ' ma inną sumę sha256 niż jej raport: kopia jest uszkodzona albo podmieniona.');
  if (resolve(String(r.file)) !== resolve(file)) fail('Raport kopii wskazuje inny plik (' + String(r.file) + ').');
  if (r.source !== database)
    fail('Kopia pochodzi z bazy ' + String(r.source) + ', a cofamy bazę ' + database + '. Wybierz kopię tej bazy sprzed aktualizacji.');
  return { id: r.id as string, created_at: r.created_at as string, schema: schema as number };
}

export async function rollbackToBackup(options: RollbackOptions, deps?: RollbackDeps): Promise<RollbackResult> {
  deps ??= await localRollbackDeps();
  const db = deps.source(), file = resolve(options.backup);
  if (options.confirm !== db.database)
    fail('Cofnięcie aktualizacji wymaga jawnej zgody operatora: podaj --confirm ' + db.database +
      ' (nazwa bazy wydania N+1, którą cofamy). Nic nie zostało zmienione.');
  const others = await deps.sessions(db, db.database);
  if (others > 0)
    fail('Baza ' + db.database + ' ma ' + others + ' inne połączenia: zatrzymaj wydanie N+1 (serwer, worker, runtime) przed cofnięciem. Nic nie zostało zmienione.');
  const report = backupReport(await deps.readText(file + '.json').catch(() => fail('Brak raportu kopii ' + file + '.json obok pliku kopii.')),
    file, await deps.sha256(file), db.database);
  const failed = await deps.ledger(db, db.database);
  if (report.schema >= failed.length)
    fail('Kopia ma ' + report.schema + ' migracji, a baza ' + db.database + ' ' + failed.length + ': to nie jest kopia sprzed tej aktualizacji. Nic nie zostało zmienione.');
  const restored = await deps.restore(file, { directory: options.directory, keyFile: options.keyFile, purpose: 'rollback' });
  try {
    if (restored.status !== 'verified' || restored.preview_only !== false || restored.purpose !== 'rollback' || restored.source !== db.database)
      fail('Odtworzenie nie zwróciło zweryfikowanej bazy do cofnięcia.');
    const names = await deps.ledger(db, restored.database), known = new Set(failed);
    const foreign = names.filter((n) => !known.has(n));
    if (names.length !== report.schema || foreign.length)
      fail('Rejestr migracji odtworzonej bazy (' + names.length + ') nie jest stanem sprzed aktualizacji bazy ' + db.database +
        (foreign.length ? ' (migracje spoza niej: ' + foreign.join(', ') + ')' : '') + '. Odtworzona baza została usunięta.');
    const kept = new Set(names), removed = failed.filter((n) => !kept.has(n)).sort();
    const at = deps.now().toISOString();
    const result: RollbackResult = {
      status: 'rolled_back', purpose: 'rollback', preview_only: false, rollback_of: db.database,
      database: restored.database, directory: restored.directory, config: restored.config, images: restored.images,
      backup: { file, id: report.id, sha256: await deps.sha256(file), created_at: report.created_at },
      data_lost_after: restored.snapshot_at,
      ledger: { restored: names.length, restored_last: [...names].sort().at(-1) ?? '', failed: failed.length, removed },
      consent: { confirmed_database: db.database, by: deps.operator?.() ?? 'operator', at },
      next: 'Uruchom wydanie N z DATABASE_URL wskazującym bazę ' + restored.database + ', konfiguracją ' + restored.config +
        ' i DYNA_IMAGE_DIR=' + restored.images + '; baza ' + db.database + ' zostaje bez zmian do analizy.',
    };
    await deps.writeResult(resolve(restored.directory, 'rollback.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } catch (e) {
    await deps.drop(db, restored.database).catch(() => {});
    throw e instanceof RollbackRefusedError ? e : new RollbackRefusedError('Cofnięcie przerwane, odtworzona baza została usunięta. Przyczyna: ' +
      String((e as Error)?.message ?? e).replace(MASK, '$1***@'));
  }
}

const client = async <T>(db: RollbackDatabase, database: string, fn: (c: pg.Client) => Promise<T>) => {
  const c = watchDbClient(new pg.Client({ ...db, database, connectionTimeoutMillis: 5000 }), 'release-rollback');
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
};
function defaultDeps(): RollbackDeps {
  return {
    source: () => { throw new Error('defaultDeps.source is replaced by the loader'); },
    sessions: (db, database) => client(db, 'postgres', async (c) =>
      Number((await c.query('SELECT count(*) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database])).rows[0].count)),
    ledger: (db, database) => client(db, database, async (c) => (await c.query('SELECT name FROM public.migrations ORDER BY name')).rows.map((r) => r.name as string)),
    restore: async (file, options) => (await import('./recovery')).restoreBackup(file, options) as Promise<RestoreResult>,
    drop: async (db, database) => {
      if (!/^dynaminds_restore_[a-f0-9]{16}$/.test(database)) throw new Error('only a restore database is dropped');
      await client(db, 'postgres', (c) => c.query(`DROP DATABASE ${database} WITH (FORCE)`));
    },
    sha256: (file) => new Promise((ok, no) => { const h = createHash('sha256'); createReadStream(file).on('error', no).on('data', (b) => h.update(b)).on('end', () => ok(h.digest('hex'))); }),
    readText: (file) => readFile(file, 'utf8'),
    writeResult: (file, text) => writeFile(file, text, { mode: 0o600 }),
    now: () => new Date(),
    operator: () => userInfo().username,
  };
}
/** The defaults with the local database of DATABASE_URL (recovery.ts localDatabase: local cluster, user postgres). */
export async function localRollbackDeps(): Promise<RollbackDeps> {
  const { localDatabase } = await import('./recovery');
  return { ...defaultDeps(), source: localDatabase };
}
