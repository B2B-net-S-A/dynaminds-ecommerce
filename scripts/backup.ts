import { createBackup, restoreBackup } from '../server/recovery';
import { pool } from '../server/db';
const args = process.argv.slice(2),
  mode = args.shift();
function option(name: string) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error('Brak wartości ' + name);
  return value;
}
try {
  for (let i = 0; i < args.length; i += 2)
    if (!['--key-file', '--directory', '--file'].includes(args[i]))
      throw new Error('Nieznana opcja: ' + args[i]);
  const options = { keyFile: option('--key-file'), directory: option('--directory') };
  if (mode === 'create') console.log(JSON.stringify(await createBackup(options), null, 2));
  else if (mode === 'restore') {
    const file = option('--file');
    if (!file) throw new Error('Wymagany --file wskazujący szyfrowaną kopię');
    console.log(JSON.stringify(await restoreBackup(file, options), null, 2));
  } else
    throw new Error(
      'Użycie: npm run backup -- create | restore --file <kopia.dyna> [--key-file <klucz>] [--directory <katalog>]',
    );
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
