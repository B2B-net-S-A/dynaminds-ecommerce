import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { aiBase } from '../server/catalog-ai';
import { pool } from '../server/db';
// Uses an installed binary. Never downloads weights, provisions accounts or stops another engine.
await pool.end();
const base = aiBase();
try {
  const response = await fetch(base + '/api/version', { signal: AbortSignal.timeout(1500) });
  if (response.ok) {
    const result = (await response.json()) as { version?: unknown };
    if (typeof result.version === 'string') {
      console.log('Lokalny silnik Ollama już działa:', base, result.version);
      process.exit(0);
    }
  }
} catch {
  /* Start only on the configured loopback port; bind failure leaves existing processes intact. */
}
const bundled = resolve('data/ollama-runtime/ollama');
const models = resolve('data/ollama-models');
await mkdir(models, { recursive: true });
const child = spawn(existsSync(bundled) ? bundled : 'ollama', ['serve'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    OLLAMA_HOST: new URL(base).host,
    OLLAMA_MODELS: models,
    OLLAMA_NO_CLOUD: '1',
    OLLAMA_NUM_PARALLEL: '1',
    OLLAMA_MAX_LOADED_MODELS: '1',
    OLLAMA_KEEP_ALIVE: '0',
  },
});
child.on('error', () => {
  console.error('Brak silnika Ollama. Zainstaluj lokalny CLI według docs/CATALOG-AI.md.');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
