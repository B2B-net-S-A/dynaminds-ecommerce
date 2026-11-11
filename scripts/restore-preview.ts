import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const args = process.argv.slice(2),
  resultPath = args[args.indexOf('--result') + 1];
if (!args.includes('--result') || !resultPath)
  throw new Error('Wymagany --result <data/restores/ID/result.json>');
const result = JSON.parse(await readFile(resolve(resultPath), 'utf8'));
if (
  !/^dynaminds_restore_[a-f0-9]{16}$/.test(result.database) ||
  !result.preview_only ||
  result.worker_enabled !== false ||
  result.status !== 'verified'
)
  throw new Error('Wymagana zweryfikowana, odizolowana kopia odtworzenia');
const directory = resolve(result.directory);
if (
  resolve(result.config) !== resolve(directory, 'local-config.json') ||
  resolve(result.images) !== resolve(directory, 'images')
)
  throw new Error('Nieprawidłowe ścieżki odtworzenia');
const config = JSON.parse(await readFile(result.config, 'utf8'));
const port = Number(process.env.DYNA_PREVIEW_PORT ?? 4101);
if (!Number.isInteger(port) || port < 4101 || port > 4199)
  throw new Error('Podgląd wymaga wolnego lokalnego portu 4101–4199');
process.env.DYNA_LOCAL_CONFIG_PATH = result.config;
process.env.DYNA_IMAGE_DIR = result.images;
process.env.DATABASE_URL = `postgres://postgres:${encodeURIComponent(config.dbPassword)}@127.0.0.1:55432/${result.database}`;
process.env.APP_REVISION ??= result.revision;
const [{ buildApp }, { pool }, { Problem }] = await Promise.all([
  import('../server/app'),
  import('../server/db'),
  import('../server/errors'),
]);
const app = await buildApp({
  readOnly: true,
  previewPort: port,
  integrationTransport: async () => {
    throw new Problem(503, 'Połączenia z dostawcami są wyłączone w podglądzie kopii');
  },
});
await app.listen({ host: '127.0.0.1', port });
console.log(
  `Podgląd tylko do odczytu: http://localhost:${port} · odtworzona baza ${result.database} · worker wyłączony`,
);
async function stop() {
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
