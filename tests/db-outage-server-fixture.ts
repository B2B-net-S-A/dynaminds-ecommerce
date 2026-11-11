/** Child process of tests/db-connection-errors.database.test.ts: the ordinary app (buildApp) and the real
 * background worker on the selected clone. It installs no uncaughtException/unhandledRejection guard of its
 * own, so an unwatched pg 'error' event ends it exactly as in dry run -68. Commands arrive as stdin lines
 * (signals go to the tsx parent): 'worker' prints the worker snapshot, 'transaction' opens one read transaction. */
import { migrate, pool, tenantReadTx } from '../server/db';
import { buildApp } from '../server/app';
import { startWorker } from '../server/worker';
import { workerRuntime } from '../server/worker-supervisor';
import { createInterface } from 'node:readline';

await migrate();
const app = await buildApp({ logging: false, backgroundWorkersEnabled: true });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT) });
const stopWorker = startWorker();
const commands: Record<string, () => void> = {};
commands.worker = () => {
  const steps = workerRuntime()?.snapshot().steps.map(({ name, runs, failures, last_success_at, last_error }) =>
    ({ name, runs, failures, last_success_at, last_error_code: last_error?.code ?? null })) ?? null;
  process.stdout.write(JSON.stringify({ status: 'WORKER', steps }) + '\n');
};
// A read transaction (the real tenantReadTx) that stays checked out between two statements for 8 s,
// as a request awaiting other work inside its transaction does; pg-pool has no 'error' listener on it then.
commands.transaction = () => {
  void tenantReadTx('00000000-0000-4000-8000-000000000330', async (c) => {
    await c.query('SELECT 1');
    process.stdout.write(JSON.stringify({ status: 'TRANSACTION_OPEN' }) + '\n');
    await new Promise((r) => setTimeout(r, 8000));
    await c.query('SELECT 2');
  }).then(() => process.stdout.write(JSON.stringify({ status: 'TRANSACTION_COMMITTED' }) + '\n'),
    (e) => process.stdout.write(JSON.stringify({ status: 'TRANSACTION_FAILED', code: typeof e?.code === 'string' ? e.code : null }) + '\n'));
};
createInterface({ input: process.stdin }).on('line', (line) => commands[line.trim()]?.());
process.on('SIGTERM', () => {
  void (async () => {
    await stopWorker();
    await app.close();
    await pool.end();
    process.exit(0);
  })();
});
process.stdout.write(JSON.stringify({ status: 'LISTENING' }) + '\n');
