// MIG-4: take a failed upgrade N -> N+1 back to N from the backup taken before the upgrade (docs/release-upgrade-rollback.md).
//   DATABASE_URL=<N+1 database> DYNA_LOCAL_CONFIG_PATH=<installation config> \
//   npm run release:rollback -- --backup <data>/backups/pre-migration/<id>.dyna --confirm <N+1 database name> \
//     [--key-file <data>/.recovery-key] [--directory <private restores directory>]
// Prints the rollback result (JSON, no secrets). Stop N+1 first; the N+1 database is not changed.
import { rollbackToBackup } from '../server/release-rollback';
import { pool } from '../server/db';

const args = process.argv.slice(2), allowed = ['--backup', '--confirm', '--key-file', '--directory'];
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
try {
  for (let i = 0; i < args.length; i += 2)
    if (!allowed.includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Nieznana opcja albo brak wartości: ' + args[i]);
  const backup = option('--backup');
  if (!backup) throw new Error('Użycie: npm run release:rollback -- --backup <kopia.dyna> --confirm <baza N+1> [--key-file <klucz>] [--directory <katalog>]');
  console.log(JSON.stringify(await rollbackToBackup({ backup, confirm: option('--confirm'), keyFile: option('--key-file'), directory: option('--directory') }), null, 2));
} catch (e) {
  console.error(JSON.stringify({ status: 'ROLLBACK_FAILED', code: (e as { code?: string }).code ?? 'ERROR', message: String((e as Error)?.message ?? e).replace(/(postgres(?:ql)?:\/\/)[^@\s/]*@/g, '$1***@') }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
