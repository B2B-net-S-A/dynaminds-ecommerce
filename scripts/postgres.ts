import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { localConfig } from '../server/db';
const dbDir = resolve('data/postgres');
mkdirSync(resolve('data'), { recursive: true });
const pg = new EmbeddedPostgres({
  databaseDir: dbDir,
  user: 'postgres',
  password: localConfig.dbPassword,
  port: 55432,
  persistent: true,
  onLog: () => {},
  onError: (m: unknown) => console.error(m),
});
if (!existsSync(resolve(dbDir, 'PG_VERSION'))) await pg.initialise();
await pg.start();
const client = pg.getPgClient();
await client.connect();
if (!(await client.query("SELECT 1 FROM pg_database WHERE datname='dynaminds'")).rowCount)
  await pg.createDatabase('dynaminds');
await client.end();
console.log('PostgreSQL lokalnie: 127.0.0.1:55432 / dynaminds');
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await pg.stop();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 60000);
