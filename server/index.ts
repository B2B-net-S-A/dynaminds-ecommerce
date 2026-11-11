import { migrate, pool, lastMigrationBackup } from './db';
import { assertDatabaseTempPrivilege } from './database-temp-privilege';
import { seed } from './seed';
import { buildApp } from './app';
import { startWorker } from './worker';
import { startCatalogAiWorker } from './catalog-ai';
import { startDeepLWorker } from './deepl-catalog';
import { startDeepLBatchWorker } from './deepl-batches';
import { readRateLimitSetting } from './rate-limit-config';
const disabledSetting = process.env.DYNA_WORKER_DISABLED;
if (disabledSetting != null && !['true', 'false'].includes(disabledSetting))
  throw new Error('DYNA_WORKER_DISABLED wymaga wartości true lub false');
const backgroundWorkersEnabled = disabledSetting !== 'true';
// An invalid DYNA_RATE_LIMIT_PER_MIN refuses before migrate(); buildApp reads the same setting.
readRateLimitSetting();
// Refuses a database migrated by a newer release (MIG-6) and backs up before applying pending migrations (MIG-3).
await migrate();
// 262: a clone or a logical restore brings back TEMPORARY for PUBLIC under a ledger that says 262 ran; refuse to start.
await assertDatabaseTempPrivilege(pool);
const preMigrationBackup = lastMigrationBackup();
if (preMigrationBackup)
  process.stdout.write(JSON.stringify({ event: 'pre-migration-backup', id: preMigrationBackup.id, file: preMigrationBackup.file, sha256: preMigrationBackup.sha256, pending: preMigrationBackup.pending }) + '\n');
await seed();
const app = await buildApp({ logging: true, backgroundWorkersEnabled });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4100) });
const stopped = async () => {};
const stopWorker = backgroundWorkersEnabled ? startWorker() : stopped;
const stopAiWorker = backgroundWorkersEnabled ? startCatalogAiWorker() : stopped;
const stopDeepLWorker = backgroundWorkersEnabled ? startDeepLWorker() : stopped;
const stopDeepLBatchWorker = backgroundWorkersEnabled ? startDeepLBatchWorker() : stopped;
async function stop() {
  await Promise.all([stopWorker(), stopAiWorker(), stopDeepLWorker(), stopDeepLBatchWorker()]);
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
