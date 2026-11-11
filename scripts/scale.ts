// Disposable localhost database only. An optional repeat uses the same disposable fixture; current is the default profile.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import pg from 'pg';
import { localConfig, pool } from '../server/db';
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const name = 'dynaminds_scale_' + randomUUID().replaceAll('-', ''),
  fixtureFile = resolve('data/scale-' + name + '.json');
const admin = new pg.Client({
  host: '127.0.0.1',
  port: 55432,
  user: 'postgres',
  password: localConfig.dbPassword,
  database: 'postgres',
});
let created = false,
  interrupted = false,
  activeChild: ChildProcess | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    interrupted = true;
    activeChild?.kill('SIGTERM');
  });
const run = async (phase: string) => {
  if (interrupted) throw new Error('Pomiar przerwany; usuwanie osobnej bazy.');
  const child = spawn(
    process.execPath,
    [
      'node_modules/tsx/dist/cli.mjs',
      phase === 'odoo-catalog'
        ? 'scripts/odoo-catalog-scale-measure.ts'
        : 'scripts/scale-measure.ts',
      phase,
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        APP_REVISION: revision,
        DYNA_SCALE_SOURCE_STATE: execFileSync('git', ['status', '--porcelain'], {
          encoding: 'utf8',
        }).trim()
          ? 'modified'
          : 'clean',
        DYNA_TEST: 'true',
        DYNA_SCALE_NAME: name,
        DYNA_SCALE_FIXTURE: fixtureFile,
        DATABASE_URL: `postgres://postgres:${localConfig.dbPassword}@127.0.0.1:55432/${name}`,
      },
    },
  );
  activeChild = child;
  const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? 1)));
  activeChild = undefined;
  if (code !== 0) throw new Error('Pomiar skali zakończył się błędem: ' + phase);
};
await admin.connect();
await mkdir(resolve('data'), { recursive: true });
try {
  await admin.query('CREATE DATABASE ' + name);
  created = true;
  console.log('Osobna baza testu skali utworzona. Baza aplikacji pozostaje bez zmian.');
  if (process.argv.includes('--repeat')) {
    await run('baseline');
    await run('confirmation');
  } else
    await run(
      process.argv.includes('--odoo-catalog')
        ? 'odoo-catalog'
        : process.argv.includes('--inventory')
          ? 'inventory'
          : 'current',
    );
} finally {
  if (created) await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await rm(fixtureFile, { force: true });
  await admin.end();
  await pool.end();
  console.log('Baza pomiaru i plik sesji usunięte.');
}
