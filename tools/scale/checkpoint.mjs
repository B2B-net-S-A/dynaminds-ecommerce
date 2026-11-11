// Resumable progress: written atomically (tmp + rename) after every batch, mode 0600.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const CHECKPOINT_SCHEMA = 'dyna-scale-checkpoint/v1';

export function loadCheckpoint(path, { planSha256, database }) {
  if (!existsSync(path)) return { schema: CHECKPOINT_SCHEMA, plan_sha256: planSha256, database, tenants: {}, runs: [] };
  const cp = JSON.parse(readFileSync(path, 'utf8'));
  if (cp.schema !== CHECKPOINT_SCHEMA) throw new Error(`Nieznany format checkpointu ${path}`);
  // Same seed and parameters only: a different plan in the same database would mix two datasets.
  if (cp.plan_sha256 !== planSha256) throw new Error(`Checkpoint ${path} dotyczy innego planu (${cp.plan_sha256.slice(0, 12)}…); użyj innego pliku lub tego samego seeda/parametrów`);
  if (cp.database !== database) throw new Error(`Checkpoint ${path} dotyczy bazy ${cp.database}, nie ${database}`);
  return cp;
}

export function saveCheckpoint(path, cp) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cp, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function tenantProgress(cp, slot) {
  return (cp.tenants[slot] ??= { phase: 'setup', products_next: 0, orders_next: 0, tenant_id: null, product_seconds: 0, order_seconds: 0 });
}
