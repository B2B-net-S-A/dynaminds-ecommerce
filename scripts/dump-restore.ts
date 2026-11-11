import { restorePlainDump } from '../server/recovery-dump-restore';
// npx tsx scripts/dump-restore.ts --file <pg_dump --format=custom file> --database <new database>
// DATABASE_URL names the local cluster (postgres user, loopback); see tools/recovery/README.md "Logical dump restore".
const args = process.argv.slice(2);
function option(name: string) {
  const i = args.indexOf(name), value = args[i + 1];
  if (i < 0 || !value || value.startsWith('--')) throw new Error('Wymagany ' + name);
  return value;
}
try {
  if (args.length !== 4) throw new Error('Użycie: npx tsx scripts/dump-restore.ts --file <dump> --database <nowa baza>');
  console.log(JSON.stringify(await restorePlainDump(option('--file'), option('--database'))));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
