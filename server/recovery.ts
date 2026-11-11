import {validateRecoveredPimIfAvailableInTx} from './pim-dictionaries/recovery-gate';
import {validateRecoveredManualOff} from './manual-inventory-off';
import {validateRecoveredPhysicalParcelWz} from './physical-parcel-wz';
import { spawn } from 'node:child_process';
import { ensure } from './errors';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { watchDbClient } from './db-connection-errors';
import { z } from 'zod';
import { localConfig } from './db';
import { recoveryPostgresPort } from './test-postgres-port';
import { decrypt } from './security';
import { supplierRemoteAuthValue, supplierRemoteUpdateInput } from './supplier-remote-schema';
import { supplierRemoteFeedUrl } from './supplier-remote-fetch-transport';
import { recoveredLabelBytes } from './recovery-label-files';
import { validateShipmentLabelBatchContent } from './shipment-label-batch-pdf';
import { validateReturnAssistantPhoto } from './return-assistant-photo';
import { validateRecoveredInboundEmail } from './email-inbound-recovery';
import { validateRecoveredBuyerAddresses } from './buyer-address';
import { validateRecoveredOperationalDeliveries } from './operational-delivery-consumers';
import { captureRelationAclSnapshot, relationAclSnapshotSchema, restoreRelationAclSnapshot } from './recovery-relation-acl';
import { splitRestoreEventTriggers } from './recovery-restore-toc';
import { reapplyRevokePublicTemporary } from './database-temp-privilege';
import {capturePrivateAclSnapshot,privateAclSnapshotSchema,restorePrivateAclSnapshot,verifyPrivateAclSnapshot} from './recovery-private-acl';
import {privateTableFingerprints,privateTablesSnapshotSchema,verifyPrivateTableFingerprints} from './recovery-private-tables';
import { capturePrivateRoots, privateRootArchiveFiles, privateRootsManifestSchema, restorePrivateRoots, type PrivateRoots } from './recovery-private-roots';

const magic = Buffer.from('DYNAEC01');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const configSchema = z.object({ dbPassword: z.string().min(1), encryptionKey: hex });
const fingerprintSchema = z.object({
  count: z.string().regex(/^\d+$/),
  high: z.string().regex(/^-?\d+$/),
  low: z.string().regex(/^-?\d+$/),
});
export const manifestSchema = z.object({
  format: z.literal(1),
  created_at: z.iso.datetime(),
  revision: z.string().max(100),
  database: z.string().regex(/^[a-z][a-z0-9_]*$/),
  server_version: z.string().max(100),
  tables: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), fingerprintSchema),
  dump: z.object({ sha256: hex, size: z.number().int().positive() }),
  config_sha256: hex,
  schema_sha256: hex.optional(),
  schema_fingerprint_version: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  relation_acl_snapshot: relationAclSnapshotSchema.optional(),
  private_roots: privateRootsManifestSchema.optional(),
  private_tables: privateTablesSnapshotSchema.optional(),
  private_acl_snapshot: privateAclSnapshotSchema.optional(),
  images: z.array(
    z.object({
      id: z.string().regex(uuid),
      sha256: hex,
      size: z.number().int().positive().max(524288),
    }),
  ),
});
type Manifest = z.infer<typeof manifestSchema>;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function localDatabase() {
  const port = recoveryPostgresPort();
  const url = new URL(
    process.env.DATABASE_URL ??
      `postgres://postgres:${localConfig.dbPassword}@127.0.0.1:${port}/dynaminds`,
  );
  check(
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && Number(url.port) === port,
    `Odtwarzanie obsługuje tylko lokalny klaster na porcie ${port}`,
  );
  const database = url.pathname.slice(1);
  check(/^[a-z][a-z0-9_]*$/.test(database), 'Nieprawidłowa nazwa lokalnej bazy');
  check(url.username === 'postgres', 'Kopia całej instancji wymaga lokalnego operatora postgres');
  return {
    database,
    password: decodeURIComponent(url.password),
    host: '127.0.0.1',
    port,
    user: 'postgres',
  };
}
export function restoreDatabaseName(name: string) {
  check(
    /^dynaminds_restore_[a-f0-9]{16}$/.test(name),
    'Dozwolona jest wyłącznie nowa, odizolowana baza odtworzenia',
  );
  return name;
}
/** Returns the first directory this call created (mkdir -p), if any. */
async function privateDirectory(path: string) {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  check(s.isDirectory() && !s.isSymbolicLink(), 'Katalog kopii nie może być dowiązaniem');
  check(
    (s.mode & 0o077) === 0,
    'Katalog kopii musi być prywatny (0700); wybierz osobny katalog zamiast współdzielonego',
  );
  return created;
}
async function flush(path: string) {
  const f = await open(path, 'r');
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}
export async function recoveryKey(path = resolve('.recovery-key'), create = false) {
  if (create) await createRecoveryKey(path);
  return readRecoveryKey(path, create);
}
/** True when this call wrote the key; an existing key is kept. */
async function createRecoveryKey(path: string) {
  try {
    await writeFile(path, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return false;
  }
}
/** Backup destination: the private directory and the recovery key. discard() removes exactly what this
 * call created (a new directory tree, a new key), so a failed backup leaves no partial files; an existing
 * directory or key stays. A failure inside this call discards by itself. */
export async function prepareBackupTarget(directory: string, keyFile: string) {
  let createdDirectory: string | undefined, createdKey = false;
  const discard = async () => {
    if (createdKey) await rm(keyFile, { force: true });
    if (createdDirectory) await rm(createdDirectory, { recursive: true, force: true });
  };
  try {
    createdDirectory = await mkdir(directory, { recursive: true, mode: 0o700 });
    const s = await lstat(directory);
    check(s.isDirectory() && !s.isSymbolicLink(), 'Katalog kopii nie może być dowiązaniem');
    check(
      (s.mode & 0o077) === 0,
      'Katalog kopii musi być prywatny (0700); wybierz osobny katalog zamiast współdzielonego',
    );
    createdKey = await createRecoveryKey(keyFile);
    return { key: await readRecoveryKey(keyFile, createdKey), discard };
  } catch (e) {
    await discard().catch(() => {});
    throw e;
  }
}
async function readRecoveryKey(path: string, flushKey: boolean) {
  const s = await lstat(path);
  check(
    s.isFile() && !s.isSymbolicLink() && (s.mode & 0o077) === 0,
    'Klucz odzyskiwania wymaga pliku właściciela z uprawnieniami 0600',
  );
  const key = (await readFile(path, 'utf8')).trim();
  check(/^[a-f0-9]{64}$/.test(key), 'Nieprawidłowy klucz odzyskiwania');
  if (flushKey) await flush(path);
  return Buffer.from(key, 'hex');
}
async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const b of createReadStream(path)) hash.update(b);
  return hash.digest('hex');
}
async function pgTool(name: 'pg_dump' | 'pg_restore') {
  const dir =
    process.env.DYNA_PG_TOOLS ?? resolve(homedir(), '.local/share/dynaminds/pg-tools/18/bin');
  const path = resolve(dir, name);
  try {
    await access(path);
  } catch {
    throw new Error(
      'Brak narzędzi PostgreSQL. Uruchom npm run pg:tools lub ustaw DYNA_PG_TOOLS na katalog narzędzi wersji 18+.',
    );
  }
  return path;
}
const pgArgs = (database: string, port: number) => {
  check(port === recoveryPostgresPort(), 'Niezgodny port lokalnego klastra odtwarzania');
  return [
  '--host=127.0.0.1',
  `--port=${port}`,
  '--username=postgres',
  '--no-password',
  `--dbname=${database}`,
  ];
};
function child(executable: string, args: string[], password?: string) {
  const c = spawn(executable, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: password
      ? { PATH: process.env.PATH, PGPASSWORD: password, PGCONNECT_TIMEOUT: '5', LC_ALL: 'C' }
      : process.env,
  });
  // Do not expose database rows or credential-bearing stderr in terminal logs.
  c.stderr.resume();
  const done = new Promise<void>((ok, bad) => {
    c.on('error', () => bad(new Error(`Nie można uruchomić ${basename(executable)}`)));
    c.on('exit', (code) =>
      code === 0 ? ok() : bad(new Error(`${basename(executable)} zakończył się błędem (${code})`)),
    );
  });
  return { c, done };
}
async function run(executable: string, args: string[], password?: string) {
  const p = child(executable, args, password);
  p.c.stdout.resume();
  await p.done;
}
async function output(executable: string, args: string[]) {
  const p = child(executable, args);
  let text = '';
  p.c.stdout.on('data', (b) => {
    text += b.toString();
    if (text.length > 67108864) p.c.kill('SIGTERM');
  });
  await p.done;
  return text;
}
export async function tableFingerprints(c: pg.Client) {
  const names = (
    await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  ).rows.map((r) => r.tablename as string);
  const result: Record<string, z.infer<typeof fingerprintSchema>> = {};
  for (const name of names) {
    check(/^[a-z][a-z0-9_]*$/.test(name), 'Nieobsługiwana nazwa tabeli');
    // Commutative row fingerprints: aggregate fixed-size values, not the complete table in RAM.
    result[name] = (
      await c.query(
        `SELECT count(*)::text AS count,coalesce(sum(('x'||substr(md5(to_jsonb(t)::text),1,16))::bit(64)::bigint),0)::text AS high,coalesce(sum(('x'||substr(md5(to_jsonb(t)::text),17,16))::bit(64)::bigint),0)::text AS low FROM "${name}" t`,
      )
    ).rows[0];
  }
  return result;
}
export async function schemaFingerprint(c: pg.Client, version: 1 | 2 | 3 | 4 = 4) {
  // v3 introduced effective ACLs. v4 canonicalizes constraint deparse only:
  // pg_dump/restore can flatten equivalent nested AND without changing the check.
  // Keep every v1-v3 query representation for already sealed archives.
  const tableAcl =
    version >= 3
      ? "coalesce(relacl,acldefault(CASE WHEN relkind='S' THEN 's'::\"char\" ELSE 'r'::\"char\" END,relowner))"
      : 'relacl';
  const functionAcl = version >= 3 ? "coalesce(p.proacl,acldefault('f',p.proowner))" : 'p.proacl';
  const constraintDefinition = version === 4 ? 'pg_get_constraintdef(oid,true)' : 'pg_get_constraintdef(oid)';
  const metadata = await c.query(`
    SELECT 'table' AS kind,${version >= 2 ? 'relname::text' : 'relname'} AS name,jsonb_build_object('kind',relkind,'rls',relrowsecurity,'force_rls',relforcerowsecurity,'acl',(SELECT array_agg(a::text ORDER BY a::text) FROM unnest(${tableAcl}) a),'options',reloptions) AS definition
    FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','S')
    UNION ALL SELECT 'column',c.relname||'.'||a.attname,jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'position',a.attnum)
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT 'constraint',conrelid::regclass::text||'.'||conname,to_jsonb(${constraintDefinition}) FROM pg_constraint WHERE connamespace='public'::regnamespace
    UNION ALL SELECT 'index',indexname,to_jsonb(indexdef) FROM pg_indexes WHERE schemaname='public'
    UNION ALL SELECT 'policy',polrelid::regclass::text||'.'||polname,jsonb_build_object('command',polcmd,'permissive',polpermissive,'using',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid),'roles',(SELECT array_agg(r.rolname ORDER BY r.rolname) FROM pg_roles r WHERE r.oid=ANY(polroles))) FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
    UNION ALL SELECT 'function',p.oid::regprocedure::text,jsonb_build_object('body',pg_get_functiondef(p.oid),'acl',(SELECT array_agg(a::text ORDER BY a::text) FROM unnest(${functionAcl}) a)) FROM pg_proc p WHERE pronamespace='public'::regnamespace AND prokind='f'
    UNION ALL SELECT 'trigger',tgrelid::regclass::text||'.'||tgname,to_jsonb(pg_get_triggerdef(oid)) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
    ORDER BY kind,name`);
  return createHash('sha256').update(JSON.stringify(metadata.rows)).digest('hex');
}
export async function sealStream(stream: NodeJS.ReadableStream, path: string, key: Buffer) {
  check(key.length === 32, 'Klucz kopii musi mieć 256 bitów');
  const header = Buffer.concat([magic, randomBytes(12)]),
    cipher = createCipheriv('aes-256-gcm', key, header.subarray(8));
  cipher.setAAD(header);
  await writeFile(path, header, { flag: 'wx', mode: 0o600 });
  try {
    await pipeline(stream, cipher, createWriteStream(path, { flags: 'a' }));
    await appendFile(path, cipher.getAuthTag());
    await flush(path);
  } catch (e) {
    await rm(path, { force: true });
    throw e;
  }
}
export async function unsealFile(path: string, target: string, key: Buffer) {
  const file = await open(path, 'r');
  let size: number, header: Buffer, tag: Buffer;
  try {
    size = (await file.stat()).size;
    check(size >= 36, 'Kopia jest ucięta');
    header = Buffer.alloc(20);
    tag = Buffer.alloc(16);
    await file.read(header, 0, 20, 0);
    await file.read(tag, 0, 16, size - 16);
  } finally {
    await file.close();
  }
  check(header!.subarray(0, 8).equals(magic), 'Nieobsługiwany format kopii');
  const decipher = createDecipheriv('aes-256-gcm', key, header!.subarray(8));
  decipher.setAAD(header!);
  decipher.setAuthTag(tag!);
  try {
    await pipeline(
      createReadStream(path, { start: 20, end: size! - 17 }),
      decipher,
      createWriteStream(target, { flags: 'wx', mode: 0o600 }),
    );
  } catch {
    await rm(target, { force: true });
    throw new Error(
      'Kopia nie przeszła weryfikacji podpisu szyfrowania: błędny klucz, uszkodzenie lub zmieniona treść',
    );
  }
}
export type BackupOptions = { directory?: string; keyFile?: string; imageDirectory?: string;
  privateRoots?: PrivateRoots;
  // Trusted local operator holds real writer exclusion through the entire callback.
  // A callback by itself is not evidence of authentic quiescence.
  withPrivateRootsQuiescence?: <T>(work: () => Promise<T>) => Promise<T>;
};
export async function createBackup(options: BackupOptions = {}) {
  if (options.privateRoots === undefined) return createBackupInScope(options);
  check(typeof options.withPrivateRootsQuiescence === 'function', 'Prywatne katalogi wymagają wyciszonego zakresu lokalnego operatora');
  let started = false, completed = false;
  let result: Awaited<ReturnType<typeof createBackupInScope>> | undefined;
  const observed = await options.withPrivateRootsQuiescence(async () => {
    check(!started, 'Zakres kopii może zostać wykonany tylko raz'); started = true;
    result = await createBackupInScope(options); completed = true; return result;
  });
  check(started && completed && observed === result, 'Operator nie zakończył wyciszonego zakresu kopii');
  return result!;
}
async function createBackupInScope(options: BackupOptions) {
  const start = performance.now(),
    source = localDatabase(),
    base = resolve(options.directory ?? 'data/backups');
  // Preconditions that write nothing come first (PostgreSQL tools, the database connection); the directory
  // and key are created only then, and a later failure discards everything this backup created.
  const pgDump = await pgTool('pg_dump');
  const c = watchDbClient(new pg.Client(source), 'recovery-backup');
  await c.connect();
  let target: Awaited<ReturnType<typeof prepareBackupTarget>> | undefined, tmp: string | undefined;
  const id = Date.now().toString(36) + '-' + randomBytes(8).toString('hex'),
    destination = resolve(base, id + '.dyna'),
    partial = destination + '.partial';
  try {
    target = await prepareBackupTarget(base, options.keyFile ?? resolve('.recovery-key'));
    const key = target.key;
    tmp = await mkdtemp(resolve(base, '.snapshot-'));
    await chmod(tmp, 0o700);
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const snapshot = (await c.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const tables = await tableFingerprints(c),
      server_version = (await c.query('SHOW server_version')).rows[0].server_version;
    const dump = resolve(tmp, 'database.dump');
    await run(
      pgDump,
      [
        ...pgArgs(source.database, source.port),
        '--format=custom',
        '--compress=gzip:6',
        `--snapshot=${snapshot}`,
        `--file=${dump}`,
      ],
      source.password,
    );
    const config = Buffer.from(JSON.stringify(configSchema.parse(localConfig)));
    await writeFile(resolve(tmp, 'local-config.json'), config, { mode: 0o600 });
    await mkdir(resolve(tmp, 'images'), { mode: 0o700 });
    const images: Manifest['images'] = [];
    const imageDirectory = resolve(options.imageDirectory ?? process.env.DYNA_IMAGE_DIR ?? 'data/product-images');
    for (const image of (await c.query('SELECT id,size FROM product_images ORDER BY id')).rows) {
      check(uuid.test(image.id), 'Nieprawidłowy identyfikator zdjęcia');
      const from = resolve(imageDirectory, image.id),
        to = resolve(tmp, 'images', image.id),
        s = await lstat(from).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e;
          throw new Error(`Brak lub nieprawidłowe zdjęcie w kopii: brak pliku zdjęcia ${image.id} w katalogu ${imageDirectory} ` +
            '(DYNA_IMAGE_DIR musi wskazywać zdjęcia tej bazy)');
        });
      check(
        s.isFile() && !s.isSymbolicLink() && s.size === image.size,
        'Brak lub nieprawidłowe zdjęcie w kopii',
      );
      await copyFile(from, to);
      await chmod(to, 0o600);
      check((await stat(to)).size === image.size, 'Zdjęcie zmieniło się podczas kopiowania');
      images.push({ id: image.id, size: image.size, sha256: await hashFile(to) });
    }
    const privateRoots = options.privateRoots === undefined ? undefined : await capturePrivateRoots(options.privateRoots, tmp);
    const manifest = manifestSchema.parse({
      format: 1,
      created_at: new Date().toISOString(),
      revision: process.env.APP_REVISION ?? 'local',
      database: source.database,
      server_version,
      tables,
      dump: { sha256: await hashFile(dump), size: (await stat(dump)).size },
      config_sha256: createHash('sha256').update(config).digest('hex'),
      schema_sha256: await schemaFingerprint(c),
      schema_fingerprint_version: 4,
      relation_acl_snapshot: await captureRelationAclSnapshot(c),
      private_tables: await privateTableFingerprints(c),
      private_acl_snapshot: await capturePrivateAclSnapshot(c),
      ...(privateRoots ? {private_roots: privateRoots.manifest} : {}),
      images,
    });
    await writeFile(resolve(tmp, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    const list = resolve(tmp, 'archive-files.txt');
    await writeFile(
      list,
      [
        'manifest.json',
        'database.dump',
        'local-config.json',
        ...images.map((i) => 'images/' + i.id),
        ...privateRootArchiveFiles(manifest.private_roots),
      ].join('\n') + '\n',
      { mode: 0o600 },
    );
    const archive = child('tar', ['-czf', '-', '-C', tmp, '-T', list]);
    try {
      await Promise.all([archive.done, sealStream(archive.c.stdout, partial, key)]);
    } finally {
      if (archive.c.exitCode === null) archive.c.kill('SIGTERM');
    }
    await privateRoots?.verifyUnchanged();
    await c.query('COMMIT');
    await rename(partial, destination);
    await flush(base);
    const report = {
      id,
      created_at: manifest.created_at,
      file: destination,
      bytes: (await stat(destination)).size,
      sha256: await hashFile(destination),
      tables: Object.keys(tables).length,
      images: images.length,
      schema: tables.migrations?.count,
      source: source.database,
      duration_ms: Math.round(performance.now() - start),
      encryption: 'AES-256-GCM',
      status: 'created',
      ...(privateRoots ? {private_root_count: privateRoots.manifest.length, private_roots_quiescence: 'operator-provided', private_root_hashes_verified: true} : {}),
    };
    await writeFile(destination + '.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return report;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    await rm(partial, { force: true });
    await target?.discard().catch(() => {});
    throw e;
  } finally {
    await c.end();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}
/** Restores a backup into a new isolated database dynaminds_restore_<hex>. `purpose: 'rollback'` (MIG-4, only through
 * server/release-rollback.ts after the operator's explicit consent) marks the result as the database release N will run
 * on (preview_only false); the default is the read-only preview (scripts/restore-preview.ts). The restore is the same. */
export async function restoreBackup(
  backup: string,
  options: { directory?: string; keyFile?: string; purpose?: 'preview' | 'rollback' } = {},
) {
  const start = performance.now(),
    source = localDatabase(),
    base = resolve(options.directory ?? 'data/restores');
  await privateDirectory(base);
  const id = randomBytes(8).toString('hex'),
    database = restoreDatabaseName('dynaminds_restore_' + id),
    tmp = await mkdtemp(resolve(base, '.decode-'));
  await chmod(tmp, 0o700);
  const admin = watchDbClient(new pg.Client({ ...source, database: 'postgres' }), 'recovery-admin');
  let created = false;
  try {
    const archive = resolve(tmp, 'bundle.tar.gz');
    await unsealFile(resolve(backup), archive, await recoveryKey(options.keyFile));
    const names = (await output('tar', ['-tzf', archive])).trim().split('\n');
    check(
      names.length === new Set(names).size &&
        names.every(
          (n) =>
            ['manifest.json', 'database.dump', 'local-config.json'].includes(n) ||
            /^images\/[a-f0-9-]{36}$/.test(n) ||
            /^private-root-files\/[0-9]{8}$/.test(n),
        ),
      'Kopia zawiera niedozwolone lub powtórzone ścieżki',
    );
    const types = (await output('tar', ['-tvzf', archive])).trim().split('\n');
    check(
      types.length === names.length && types.every((n) => n.startsWith('-')),
      'Kopia może zawierać wyłącznie zwykłe pliki',
    );
    const bundle = resolve(tmp, 'content');
    await mkdir(bundle, { mode: 0o700 });
    await run('tar', ['-xzf', archive, '-C', bundle, '--no-same-owner', '--no-same-permissions']);
    const manifestPath = resolve(bundle, 'manifest.json');
    check((await stat(manifestPath)).size <= 67108864, 'Manifest przekracza 64 MiB');
    const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    check(
      new Set(manifest.images.map((i) => i.id)).size === manifest.images.length,
      'Manifest powtarza identyfikatory zdjęć',
    );
    const privateFiles = privateRootArchiveFiles(manifest.private_roots);
    check(names.length === manifest.images.length + privateFiles.length + 3, 'Nieprawidłowa liczba plików kopii');
    const expected = [
      'database.dump',
      'local-config.json',
      ...manifest.images.map((i) => 'images/' + i.id),
      ...privateFiles,
    ];
    check(
      expected.every((n) => names.includes(n)),
      'Kopia nie zawiera wszystkich wymaganych plików',
    );
    const dump = resolve(bundle, 'database.dump');
    check(
      (await stat(dump)).size === manifest.dump.size &&
        (await hashFile(dump)) === manifest.dump.sha256,
      'Uszkodzony dump bazy',
    );
    const configBytes = await readFile(resolve(bundle, 'local-config.json'));
    check(
      createHash('sha256').update(configBytes).digest('hex') === manifest.config_sha256,
      'Uszkodzony klucz konfiguracji',
    );
    const recovered = configSchema.parse(JSON.parse(configBytes.toString()));
    for (const image of manifest.images) {
      const path = resolve(bundle, 'images', image.id);
      check(
        (await stat(path)).size === image.size && (await hashFile(path)) === image.sha256,
        'Uszkodzone zdjęcie w kopii',
      );
      await chmod(path, 0o600);
    }
    const privateRootsRestored = await restorePrivateRoots(manifest.private_roots, bundle);
    await admin.connect();
    await admin.query(
      "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='dyna_app') THEN CREATE ROLE dyna_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$",
    );
    const role = (
      await admin.query(
        "SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname='dyna_app'",
      )
    ).rows[0];
    check(
      !role.rolsuper && !role.rolbypassrls && !role.rolcanlogin,
      'Rola aplikacji w klastrze ma nadmierne uprawnienia',
    );
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    const restoreTool = await pgTool('pg_restore');
    let deferredList: string | undefined, deferredEntries = 0;
    const primaryArgs: string[] = [];
    if (manifest.relation_acl_snapshot) {
      const toc = splitRestoreEventTriggers(await output(restoreTool, ['--list', dump]));
      if (toc.entries) {
        const primaryList = resolve(tmp, 'restore-main.list');
        deferredList = resolve(tmp, 'restore-event-triggers.list');
        deferredEntries = toc.entries;
        await writeFile(primaryList, toc.ordinary, { mode: 0o600 });
        await writeFile(deferredList, toc.deferred, { mode: 0o600 });
        primaryArgs.push('--use-list=' + primaryList);
      }
    }
    await run(restoreTool,
      [...pgArgs(database, source.port), '--single-transaction', '--exit-on-error', '--no-owner', ...primaryArgs, dump],
      source.password);
    const c = watchDbClient(new pg.Client({ ...source, database }), 'recovery-restore');
    await c.connect();
    let encryptedRecords = 0, restoredRelationAcls = 0;
    let privateAclVerified: Awaited<ReturnType<typeof verifyPrivateAclSnapshot>> = null, privateAclMaterialized: Awaited<ReturnType<typeof restorePrivateAclSnapshot>> = null;
    let privateTablesVerified: Awaited<ReturnType<typeof verifyPrivateTableFingerprints>> = null;
    try {
      if (manifest.relation_acl_snapshot || manifest.private_acl_snapshot) {
        await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        if (manifest.relation_acl_snapshot) restoredRelationAcls = await restoreRelationAclSnapshot(c, manifest.relation_acl_snapshot);
        privateAclMaterialized = await restorePrivateAclSnapshot(c, manifest.private_acl_snapshot);
        await c.query('COMMIT');
      }
      if (deferredList)
        await run(restoreTool,
          [...pgArgs(database, source.port), '--single-transaction', '--exit-on-error', '--no-owner', '--use-list=' + deferredList, dump],
          source.password);
      // 262: pg_restore does not carry the database ACL, so the new database grants TEMPORARY to PUBLIC again; a restored
      // ledger that includes 262 gets the exact 262 statement once more (as the owner) and must then pass the start check.
      await reapplyRevokePublicTemporary(c);
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TIME ZONE 'UTC'");
      const restoredTables = await tableFingerprints(c);
      if (JSON.stringify(restoredTables) !== JSON.stringify(manifest.tables)) {
        const changed = [...new Set([...Object.keys(restoredTables), ...Object.keys(manifest.tables)])]
          .filter(name => JSON.stringify(restoredTables[name]) !== JSON.stringify(manifest.tables[name]));
        throw Object.assign(new Error('Odtworzone wiersze nie odpowiadają snapshotowi'), {
          code: 'RESTORE_ROW_FINGERPRINT_MISMATCH', tables: changed,
        });
      }
      privateTablesVerified = await verifyPrivateTableFingerprints(c, manifest.private_tables);
      privateAclVerified = await verifyPrivateAclSnapshot(c, manifest.private_acl_snapshot);
      if (manifest.schema_sha256)
        check(
          (await schemaFingerprint(c, manifest.schema_fingerprint_version ?? 1)) ===
            manifest.schema_sha256,
          'Odtworzony schemat, RLS lub uprawnienia różnią się od snapshotu',
        );
      for (const row of (
        await c.query(
          'SELECT credentials AS cipher FROM channels UNION ALL SELECT secret AS cipher FROM outbound_subscriptions UNION ALL SELECT verifier AS cipher FROM oauth_states',
        )
      ).rows) {
        decrypt(row.cipher, recovered.encryptionKey);
        encryptedRecords++;
      }
      if (
        (await c.query("SELECT to_regclass('public.amazon_oauth_states') present")).rows[0].present
      ) {
        for (const row of (await c.query('SELECT verifier AS cipher FROM amazon_oauth_states'))
          .rows) {
          decrypt(row.cipher, recovered.encryptionKey);
          encryptedRecords++;
        }
      }
      if (
        (await c.query("SELECT to_regclass('public.shopify_oauth_states') present")).rows[0].present
      ) {
        for (const row of (await c.query('SELECT verifier AS cipher FROM shopify_oauth_states'))
          .rows) {
          decrypt(row.cipher, recovered.encryptionKey);
          encryptedRecords++;
        }
      }
      if (
        (await c.query("SELECT to_regclass('public.shopify_webhook_configs') present")).rows[0]
          .present
      ) {
        for (const row of (await c.query('SELECT signing_secret FROM shopify_webhook_configs'))
          .rows) {
          const secret = decrypt(row.signing_secret, recovered.encryptionKey).secret;
          ensure(
            typeof secret === 'string' && secret.length >= 16 && secret.length <= 4096,
            422,
            'Nieprawidłowy sekret webhooka Shopify w kopii',
          );
          encryptedRecords++;
        }
      }
      if (
        (await c.query("SELECT to_regclass('public.account_security') present")).rows[0].present
      ) {
        for (const row of (
          await c.query(`SELECT secret_encrypted AS cipher FROM account_security WHERE secret_encrypted IS NOT NULL
          UNION ALL SELECT pending_encrypted AS cipher FROM account_security WHERE pending_encrypted IS NOT NULL`)
        ).rows) {
          const secret = decrypt(row.cipher, recovered.encryptionKey).secret;
          check(
            typeof secret === 'string' && /^[A-Z2-7]{32}$/.test(secret),
            'Nieprawidłowy odtworzony sekret MFA',
          );
          encryptedRecords++;
        }
      }
      if (
        (await c.query("SELECT to_regclass('public.account_local_mail') present")).rows[0].present
      ) {
        for (const row of (await c.query('SELECT kind,body_encrypted FROM account_local_mail'))
          .rows) {
          const body = decrypt(row.body_encrypted, recovered.encryptionKey);
          check(
            typeof body.to === 'string' &&
              typeof body.subject === 'string' &&
              typeof body.text === 'string',
            'Nieprawidłowa lokalna wiadomość konta w kopii',
          );
          if (row.kind === 'password_reset')
            check(
              /^http:\/\/127\.0\.0\.1:5173\/#password-reset=[a-f0-9]{64}$/.test(body.url ?? ''),
              'Nieprawidłowy lokalny link konta w kopii',
            );
          encryptedRecords++;
        }
      }
      if (
        (await c.query("SELECT to_regclass('public.odoo_invoice_files') present")).rows[0].present
      ) {
        for (const f of (
          await c.query('SELECT content_encrypted,size,sha256 FROM odoo_invoice_files')
        ).rows) {
          const body = decrypt(f.content_encrypted, recovered.encryptionKey).pdf_base64;
          check(typeof body === 'string', 'Brak danych PDF w odtworzonej kopii');
          const pdf = Buffer.from(body, 'base64');
          check(
            pdf.toString('base64') === body &&
              pdf.length === f.size &&
              createHash('sha256').update(pdf).digest('hex') === f.sha256,
            'Odtworzony PDF nie odpowiada metadanym',
          );
          encryptedRecords++;
        }
      }
      for (const fileTable of [
        'payment_import_files',
        'order_field_files',
        'order_field_batch_previews',
        'order_field_source_observations',
      ]) {
        if (
          !(await c.query('SELECT to_regclass($1) present', ['public.' + fileTable])).rows[0]
            .present
        )
          continue;
        let cursor: string | null = null;
        while (true) {
          const page: any[] = (
            await c.query(
              `SELECT id,encrypted_bytes,byte_count,file_hash FROM ${fileTable} WHERE encrypted_bytes IS NOT NULL AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 5`,
              [cursor],
            )
          ).rows;
          if (!page.length) break;
          for (const f of page) {
            const content = decrypt(f.encrypted_bytes, recovered.encryptionKey).content_base64;
            check(
              typeof content === 'string' && content.length <= 6990508,
              'Brak danych prywatnego pliku w odtworzonej kopii',
            );
            const bytes = Buffer.from(content, 'base64');
            check(
              bytes.length > 0 &&
                bytes.length <= 5 * 1024 * 1024 &&
                bytes.toString('base64') === content &&
                bytes.length === f.byte_count &&
                createHash('sha256').update(bytes).digest('hex') === f.file_hash,
              'Odtworzony prywatny plik nie odpowiada metadanym',
            );
            encryptedRecords++;
          }
          cursor = page.at(-1).id;
        }
      }
      if (
        (await c.query("SELECT to_regclass('public.supplier_file_previews') present")).rows[0]
          .present
      ) {
        let cursor: string | null = null;
        while (true) {
          const page: any[] = (
            await c.query(
              'SELECT id,raw_content,raw_bytes,raw_hash FROM supplier_file_previews WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 5',
              [cursor],
            )
          ).rows;
          if (!page.length) break;
          for (const f of page) {
            const content = decrypt(f.raw_content, recovered.encryptionKey).content;
            check(
              typeof content === 'string' && !content.includes('\0'),
              'Brak poprawnej treści źródła hurtowni w kopii',
            );
            const bytes = Buffer.from(content, 'utf8');
            check(
              bytes.length > 0 &&
                bytes.length <= 2097152 &&
                bytes.toString('utf8') === content &&
                bytes.length === Number(f.raw_bytes) &&
                createHash('sha256').update(bytes).digest('hex') === f.raw_hash,
              'Źródło hurtowni nie odpowiada metadanym pliku',
            );
            encryptedRecords++;
          }
          cursor = page.at(-1).id;
        }
      }
      // Owner-only crypto verification. Never expose decrypted supplier credentials in diagnostics.
      for (const table of ['supplier_file_remotes', 'supplier_file_remote_revisions']) {
        if (!(await c.query('SELECT to_regclass($1) present', ['public.' + table])).rows[0].present)
          continue;
        let cursor: string | null = null;
        while (true) {
          const page: any[] = (await c.query(
            `SELECT id,url_cipher,auth_cipher${table.endsWith('_revisions') ? ',request_cipher' : ''} FROM ${table} WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 5`,
            [cursor],
          )).rows;
          if (!page.length) break;
          for (const remote of page) {
            const url = decrypt(remote.url_cipher, recovered.encryptionKey).url;
            let validUrl = false;
            try { validUrl = typeof url === 'string' && supplierRemoteFeedUrl(url).href === url; }
            catch { /* Fixed diagnostic below; the URL can contain secrets. */ }
            check(validUrl, 'Niepoprawny zaszyfrowany adres feedu w kopii');
            encryptedRecords++;
            if (remote.auth_cipher !== null) {
              check(supplierRemoteAuthValue.safeParse(decrypt(remote.auth_cipher, recovered.encryptionKey).auth).success,
                'Niepoprawne zaszyfrowane dane dostępu feedu w kopii');
              encryptedRecords++;
            }
            if (remote.request_cipher !== undefined) {
              check(supplierRemoteUpdateInput.safeParse(decrypt(remote.request_cipher, recovered.encryptionKey).request).success,
                'Niepoprawne zaszyfrowane żądanie konfiguracji feedu w kopii');
              encryptedRecords++;
            }
          }
          cursor = page.at(-1).id;
        }
      }
      encryptedRecords += await validateRecoveredInboundEmail(c, recovered.encryptionKey);
      encryptedRecords += (await validateRecoveredBuyerAddresses(c, recovered.encryptionKey)).records;
      encryptedRecords += (await validateRecoveredOperationalDeliveries(c, recovered.encryptionKey)).records;
      await validateRecoveredPhysicalParcelWz(c);
      await validateRecoveredManualOff(c);
      await validateRecoveredPimIfAvailableInTx(c);
      for (const table of ['invoice_email_files', 'email_message_files']) {
        if (!(await c.query('SELECT to_regclass($1) present', ['public.' + table])).rows[0].present)
          continue;
        const keys =
          table === 'invoice_email_files'
            ? ['tenant_id', 'document_id', 'source_hash']
            : ['tenant_id', 'message_id'];
        let cursor: string[] | null = null;
        while (true) {
          const predicate: string = cursor
            ? 'WHERE ROW(' +
              keys.join(',') +
              ') > ROW(' +
              keys.map((_, i) => '$' + (i + 1) + '::' + (i === 2 ? 'text' : 'uuid')).join(',') +
              ')'
            : '';
          const page: any[] = (
            await c.query(
              `SELECT * FROM ${table} ${predicate} ORDER BY ${keys.join(',')} LIMIT 10`,
              cursor ?? [],
            )
          ).rows;
          if (!page.length) break;
          for (const f of page) {
            const body = decrypt(f.content_encrypted, recovered.encryptionKey).file_base64;
            check(
              typeof body === 'string' && body.length <= 2796204,
              'Brak danych załącznika w odtworzonej kopii',
            );
            const bytes = Buffer.from(body, 'base64');
            check(
              bytes.length > 0 &&
                bytes.length <= 2097152 &&
                bytes.toString('base64') === body &&
                bytes.length === f.size &&
                createHash('sha256').update(bytes).digest('hex') === f.sha256,
              'Odtworzony załącznik nie odpowiada metadanym',
            );
            encryptedRecords++;
          }
          cursor = keys.map((k) => page.at(-1)[k]);
        }
      }
      for (const table of ['print_label_assets', 'shipment_label_cache_assets']) {
        if (!(await c.query('SELECT to_regclass($1) present', ['public.' + table])).rows[0].present)
          continue;
        let cursor: string | null = null;
        while (true) {
          const page: any[] = (await c.query(
            `SELECT id,format,content_encrypted,content_bytes,content_sha256 FROM ${table} WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 5`,
            [cursor],
          )).rows;
          if (!page.length) break;
          for (const file of page) {
            recoveredLabelBytes(decrypt(file.content_encrypted, recovered.encryptionKey), file);
            encryptedRecords++;
          }
          cursor = page.at(-1).id;
        }
      }
      if ((await c.query("SELECT to_regclass('public.shipment_label_batch_previews') present")).rows[0].present) {
        let cursor: string | null = null;
        while (true) {
          // Combined reviews may reach16MiB: validate one decrypted document at a time.
          const page: any[] = (await c.query(
            "SELECT id,combined_content_encrypted,payload->'combined_pdf' metadata FROM shipment_label_batch_previews WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 1",
            [cursor],
          )).rows;
          if (!page.length) break;
          for (const file of page) {
            const body = decrypt(file.combined_content_encrypted, recovered.encryptionKey);
            const head = file.metadata;
            check(body && typeof body.content_base64 === 'string' && head && Number.isSafeInteger(head.pages) && ['A4', 'A6'].includes(head.layout), 'Brak danych partii etykiet w odtworzonej kopii');
            const verified = await validateShipmentLabelBatchContent(body.content_base64, head.content_sha256, head.content_bytes);
            check(verified.pages === head.pages && verified.layout === head.layout, 'Odtworzony podgląd partii nie odpowiada stronom i formatowi');
            encryptedRecords++;
          }
          cursor = page.at(-1).id;
        }
      }
      if ((await c.query("SELECT to_regclass('public.return_assistant_photos') present")).rows[0].present) {
        let cursor: string | null = null;
        while (true) {
          const page: any[] = (await c.query(
            `SELECT id,content_encrypted,mime,byte_count,sha256,width,height
             FROM return_assistant_photos WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 1`,
            [cursor],
          )).rows;
          if (!page.length) break;
          for (const photo of page) {
            const body = decrypt(photo.content_encrypted, recovered.encryptionKey);
            const verified = validateReturnAssistantPhoto({ mime: photo.mime, content_base64: body.content_base64 });
            check(verified.byte_count === photo.byte_count && verified.sha256 === photo.sha256 &&
              verified.width === photo.width && verified.height === photo.height,
              'Odtworzone zdjęcie zwrotu nie odpowiada metadanym');
            encryptedRecords++;
          }
          cursor = page.at(-1).id;
        }
      }
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    // The cluster may have a new connection password; preserve the recovered data encryption key.
    await writeFile(
      resolve(bundle, 'local-config.json'),
      JSON.stringify({ ...recovered, dbPassword: source.password }),
      { mode: 0o600 },
    );
    await mkdir(resolve(bundle, 'images'), { recursive: true, mode: 0o700 });
    const target = resolve(base, id);
    await rename(bundle, target);
    const result = {
      id,
      database,
      directory: target,
      config: resolve(target, 'local-config.json'),
      images: resolve(target, 'images'),
      source: manifest.database,
      snapshot_at: manifest.created_at,
      revision: manifest.revision,
      tables: Object.keys(manifest.tables).length,
      image_count: manifest.images.length,
      ...(manifest.private_roots ? {private_roots: Object.fromEntries(privateRootsRestored.root_names.map(name => [name, resolve(target, 'private-roots', name)])), private_roots_verified: privateRootsRestored, restored_importer_authority: false, requires_fresh_census: true} : {}),
      encrypted_records_verified: encryptedRecords,
      ...(privateTablesVerified ? {private_tables_verified: privateTablesVerified} : {}),
      ...(privateAclVerified ? {private_acl_verified: privateAclVerified, private_acl_defaults_materialized: privateAclMaterialized} : {}),
      relation_acl_records_verified: manifest.relation_acl_snapshot?.length ?? null,
      relation_acl_defaults_materialized: restoredRelationAcls,
      deferred_event_trigger_entries_restored: deferredEntries,
      row_fingerprints_match: true,
      schema_fingerprint_match: !!manifest.schema_sha256,
      duration_ms: Math.round(performance.now() - start),
      purpose: options.purpose ?? 'preview',
      preview_only: options.purpose !== 'rollback',
      worker_enabled: false,
      status: 'verified',
    };
    await writeFile(resolve(target, 'result.json'), JSON.stringify(result, null, 2) + '\n', {
      mode: 0o600,
    });
    return result;
  } catch (e) {
    if (created) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`).catch(() => {});
    throw e;
  } finally {
    await admin.end().catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
}
