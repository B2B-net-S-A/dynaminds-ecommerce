import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** MIG-3: before a startup applies pending migrations to a database that already has a migration history,
 * it takes the full encrypted local backup (server/recovery.ts createBackup: pg_dump of one snapshot, images,
 * configuration) into a configured directory. If that backup fails, no migration is applied. */
export type MigrationBackupMode = 'required' | 'off';
/** directory/keyFile are absent and `unavailable` names the reason when no safe location is configured. */
export interface MigrationBackupSettings { readonly mode: MigrationBackupMode; readonly directory?: string; readonly keyFile?: string; readonly unavailable?: string }
export interface MigrationBackupReport { readonly id: string; readonly file: string; readonly sha256: string; readonly bytes: number; readonly source: string }
export interface MigrationBackupTarget { readonly database: string; readonly port: number }
export interface MigrationBackupReceipt extends MigrationBackupReport { readonly pending: readonly string[] }
export type MigrationBackupCreate = (options: { directory: string; keyFile: string }, target: MigrationBackupTarget) => Promise<MigrationBackupReport>;

/** The packaged release directory (release.json next to runtime/) that contains the running module, if any.
 * A source checkout has none. */
export function installedReleaseDirectory(from: string = import.meta.url): string | undefined {
  if (!from.startsWith('file:')) return undefined;
  for (let d = dirname(fileURLToPath(from)); ; d = dirname(d)) {
    if (existsSync(join(d, 'release.json')) && existsSync(join(d, 'runtime'))) return d;
    if (dirname(d) === d) return undefined;
  }
}
const absolutePath = (name: string, value: string | undefined) => {
  if (value === undefined) return undefined;
  if (value.trim() === '') throw new Error(name + ' nie może być pusty');
  if (!isAbsolute(value)) throw new Error(name + ' wymaga ścieżki bezwzględnej (względna zależy od katalogu startu)');
  return resolve(value);
};
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);
const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
const HOW = 'ustaw DYNA_DATA_DIR (ścieżka bezwzględna poza katalogiem wydania: kopie trafią do <DYNA_DATA_DIR>/backups/pre-migration, ' +
  'klucz do <DYNA_DATA_DIR>/.recovery-key) albo DYNA_MIGRATION_BACKUP_DIR i DYNA_MIGRATION_BACKUP_KEY_FILE. Nic nie zostało zapisane.';

/** DYNA_MIGRATION_BACKUP=required|off (default: required, off under DYNA_TEST=true).
 * Location (absolute paths only, never relative to the start directory): DYNA_MIGRATION_BACKUP_DIR and
 * DYNA_MIGRATION_BACKUP_KEY_FILE, else <data>/backups/pre-migration and <data>/.recovery-key, where <data> is
 * DYNA_DATA_DIR or the directory of DYNA_LOCAL_CONFIG_PATH (the installation's private configuration).
 * No location, or one inside the release package, sets `unavailable`: a due backup is then refused. */
export function migrationBackupSettings(env: NodeJS.ProcessEnv = process.env, releaseDirectory: string | undefined = installedReleaseDirectory()): MigrationBackupSettings {
  const raw = env.DYNA_MIGRATION_BACKUP;
  if (raw !== undefined && raw !== 'required' && raw !== 'off')
    throw new Error('DYNA_MIGRATION_BACKUP wymaga wartości required lub off');
  const mode: MigrationBackupMode = raw ?? (env.DYNA_TEST === 'true' ? 'off' : 'required');
  const data = absolutePath('DYNA_DATA_DIR', env.DYNA_DATA_DIR) ??
    (env.DYNA_LOCAL_CONFIG_PATH ? dirname(resolve(env.DYNA_LOCAL_CONFIG_PATH)) : undefined);
  const directory = absolutePath('DYNA_MIGRATION_BACKUP_DIR', env.DYNA_MIGRATION_BACKUP_DIR) ?? (data && join(data, 'backups', 'pre-migration'));
  const keyFile = absolutePath('DYNA_MIGRATION_BACKUP_KEY_FILE', env.DYNA_MIGRATION_BACKUP_KEY_FILE) ?? (data && join(data, '.recovery-key'));
  if (!directory || !keyFile) return { mode, unavailable: 'Kopia przed migracją nie ma skonfigurowanego miejsca: ' + HOW };
  if (releaseDirectory) {
    const roots = [releaseDirectory, real(releaseDirectory)];
    if ([directory, keyFile].some((p) => roots.some((root) => inside(p, root) || inside(real(p), root))))
      return { mode, unavailable: 'Kopia przed migracją nie może trafić do katalogu wydania (' + releaseDirectory + '): ' + HOW };
  }
  return { mode, directory, keyFile };
}

export class MigrationBackupError extends Error {
  readonly code = 'MIGRATION_BACKUP_FAILED';
  constructor(readonly pending: readonly string[], cause: unknown) {
    super('Nie udało się wykonać kopii bazy przed migracją, więc migracje (' + pending.join(', ') + ') nie zostały wykonane. ' +
      'Popraw przyczynę i uruchom ponownie; świadome pominięcie kopii: DYNA_MIGRATION_BACKUP=off. Przyczyna: ' +
      (cause instanceof Error ? cause.message : String(cause)), { cause });
    this.name = 'MigrationBackupError';
  }
}

// recovery.ts imports db.ts, so it is loaded only when a backup is due. It must back up the database being migrated.
const recoveryBackup: MigrationBackupCreate = async (options, target) => {
  const recovery = await import('./recovery'), source = recovery.localDatabase();
  if (source.database !== target.database || source.port !== target.port)
    throw new Error('kopia wskazuje inną bazę (' + source.database + ':' + source.port + ') niż migracja (' + target.database + ':' + target.port + ')');
  return recovery.createBackup(options);
};

/** Runs under migrate's exclusive lock, after the ledger check and before the first pending migration.
 * An empty history (first install) has nothing to protect; no pending migration needs no backup. */
export async function backupBeforeMigrating({ applied, pending, settings, target, create = recoveryBackup }: {
  applied: number; pending: readonly string[]; settings: MigrationBackupSettings; target: MigrationBackupTarget; create?: MigrationBackupCreate;
}): Promise<MigrationBackupReceipt | undefined> {
  if (!pending.length || applied === 0 || settings.mode === 'off') return undefined;
  const { directory, keyFile } = settings;
  if (settings.unavailable || !directory || !keyFile)
    throw new MigrationBackupError(pending, new Error(settings.unavailable ?? 'Kopia przed migracją nie ma skonfigurowanego miejsca: ' + HOW));
  let report: MigrationBackupReport;
  try {
    report = await create({ directory, keyFile }, target);
  } catch (e) {
    throw new MigrationBackupError(pending, e);
  }
  if (!report || typeof report.file !== 'string' || !report.file.startsWith(directory + '/') ||
      !/^[a-f0-9]{64}$/.test(report.sha256) || !(report.bytes > 0) || report.source !== target.database)
    throw new MigrationBackupError(pending, new Error('kopia nie zwróciła pliku w skonfigurowanym katalogu'));
  return Object.freeze({ id: report.id, file: report.file, sha256: report.sha256, bytes: report.bytes, source: report.source, pending: Object.freeze([...pending]) });
}
