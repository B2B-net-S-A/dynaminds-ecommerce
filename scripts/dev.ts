import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { localConfig } from '../server/db';
const children: ReturnType<typeof spawn>[] = [];
let stopping = false;
const run = (args: string[]) => {
  const c = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', ...args], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  children.push(c);
  c.on('exit', () => {
    if (!stopping) stop();
  });
  return c;
};
function stop() {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(1500).then(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
run(['scripts/postgres.ts']);
let ready = false;
for (let n = 0; n < 40 && !stopping; n++) {
  const c = new pg.Client({
    host: '127.0.0.1',
    port: 55432,
    user: 'postgres',
    password: localConfig.dbPassword,
    database: 'dynaminds',
    connectionTimeoutMillis: 1000,
  });
  try {
    await c.connect();
    ready = true;
    break;
  } catch {
    await setTimeout(500);
  } finally {
    await c.end().catch(() => {});
  }
}
if (!ready) throw new Error('Nie udało się uruchomić lokalnego PostgreSQL');
run(['server/index.ts']);
const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' });
children.push(web);
web.on('exit', () => {
  if (!stopping) stop();
});
