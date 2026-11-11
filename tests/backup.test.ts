import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  chmod,
  stat,
  access,
  mkdir,
  readdir,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import pg from 'pg';
import { migrate, pool, localConfig } from '../server/db';
import { seed } from './fixtures';
import {
  createBackup,
  restoreBackup,
  restoreDatabaseName,
  recoveryKey,
  sealStream,
  unsealFile,
  localDatabase,
  tableFingerprints,
  schemaFingerprint,
  manifestSchema,
} from '../server/recovery';
import { encrypt, decrypt } from '../server/security';
import { newTotpSecret } from '../server/totp';
import { buildApp } from '../server/app';
assert.equal(process.env.DYNA_TEST, 'true');
let directory: string;
const databases: string[] = [];
before(async () => {
  await migrate();
  await seed();
  await mkdir('data/test-recovery', { recursive: true });
  directory = await mkdtemp(resolve('data/test-recovery/case-'));
});
test('effective ACL fingerprint restores explicit defaults and still detects an additional tenant grant', async () => {
  const source = new pg.Client(localDatabase());
  await source.connect();
  let c: pg.Client | undefined;
  try {
    await source.query(
      'CREATE FUNCTION qa_default_acl() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
    );
    await source.query('REVOKE ALL ON FUNCTION qa_default_acl() FROM dyna_app');
    const current = await schemaFingerprint(source),
      legacy = await schemaFingerprint(source, 2);
    const backup = await createBackup({
      directory: resolve(directory, 'acl-backups'),
      keyFile: resolve(directory, 'acl-key'),
      imageDirectory: resolve(directory, 'empty-images'),
    });
    const restored = await restoreBackup(backup.file, {
      directory: resolve(directory, 'acl-restores'),
      keyFile: resolve(directory, 'acl-key'),
    });
    databases.push(restored.database);
    c = new pg.Client({ ...localDatabase(), database: restored.database });
    await c.connect();
    assert.equal(await schemaFingerprint(c), current);
    assert.notEqual(await schemaFingerprint(c, 2), legacy);
    const manifest = JSON.parse(
      await readFile(resolve(restored.directory, 'manifest.json'), 'utf8'),
    );
    assert.equal(manifest.schema_fingerprint_version, 4);
    for (const version of [2, 3, 4]) assert.equal(
      manifestSchema.parse({ ...manifest, schema_fingerprint_version: version }).schema_fingerprint_version,
      version,
    );
    const { schema_fingerprint_version: _version, ...legacyManifest } = manifest;
    assert.equal(manifestSchema.parse(legacyManifest).schema_fingerprint_version, undefined, 'v1 archives retain the omitted version');
    assert.equal(manifestSchema.safeParse({ ...manifest, schema_fingerprint_version: 1 }).success, false, 'Explicit v1 was never an archive field');
    assert.equal(
      (
        await c.query(
          "SELECT has_table_privilege('dyna_app','ebay_revision_attempts','SELECT') allowed",
        )
      ).rows[0].allowed,
      false,
    );
    await c.query('GRANT SELECT ON ebay_revision_attempts TO dyna_app');
    assert.notEqual(await schemaFingerprint(c), current);
  } finally {
    await c?.end();
    await source.query('DROP FUNCTION qa_default_acl()');
    await source.end();
  }
});
test('v4 restores nested AND CHECKs and still detects changed limits and semantic OR grouping', async () => {
  const source = new pg.Client(localDatabase()); await source.connect();
  let c: pg.Client | undefined;
  const constraint = async (client: pg.Client, name: string) => (await client.query(
    "SELECT pg_get_constraintdef(oid) raw,pg_get_constraintdef(oid,true) canonical FROM pg_constraint WHERE conrelid='public.qa_nested_restore_check'::regclass AND conname=$1", [name],
  )).rows[0];
  try {
    // PostgreSQL dump emits the original nested range/AND expression; reparsing
    // that SQL flattens it. This is the real product_catalogs_name_check pattern.
    await source.query(`CREATE TABLE qa_nested_restore_check(name text NOT NULL,a boolean NOT NULL,b boolean NOT NULL,c boolean NOT NULL,
      CONSTRAINT qa_nested_name CHECK(length(name) BETWEEN 2 AND 120 AND name !~ '[[:cntrl:]]'),
      CONSTRAINT qa_grouped_or CHECK((a OR b) AND c))`);
    await source.query("INSERT INTO qa_nested_restore_check VALUES('QA',true,false,true)");
    const original = await constraint(source, 'qa_nested_name'), grouped = await constraint(source, 'qa_grouped_or');
    assert.match(grouped.canonical, /\(a OR b\) AND c/);
    const legacy = await schemaFingerprint(source, 3), current = await schemaFingerprint(source, 4);
    assert.equal(await schemaFingerprint(source), current);
    const backup = await createBackup({ directory: resolve(directory, 'nested-backups'), keyFile: resolve(directory, 'nested-key'), imageDirectory: resolve(directory, 'empty-images') });
    const restored = await restoreBackup(backup.file, { directory: resolve(directory, 'nested-restores'), keyFile: resolve(directory, 'nested-key') });
    databases.push(restored.database);
    c = new pg.Client({ ...localDatabase(), database: restored.database }); await c.connect();
    const copied = await constraint(c, 'qa_nested_name');
    assert.notEqual(copied.raw, original.raw, 'Actual dump/restore reparses nested AND');
    assert.equal(copied.canonical, original.canonical);
    assert.equal(await schemaFingerprint(c, 4), current);
    assert.notEqual(await schemaFingerprint(c, 3), legacy, 'Old v3 archives still fail their exact old comparison; no fallback to v4');
    assert.equal((await constraint(c, 'qa_grouped_or')).canonical, grouped.canonical);
    await c.query(`ALTER TABLE qa_nested_restore_check DROP CONSTRAINT qa_nested_name,
      ADD CONSTRAINT qa_nested_name CHECK(length(name) BETWEEN 2 AND 119 AND name !~ '[[:cntrl:]]')`);
    assert.notEqual(await schemaFingerprint(c, 4), current, 'A genuinely different bound changes v4');
    await c.query(`ALTER TABLE qa_nested_restore_check DROP CONSTRAINT qa_nested_name,
      ADD CONSTRAINT qa_nested_name CHECK(length(name) BETWEEN 2 AND 120 AND name !~ '[[:cntrl:]]')`);
    assert.equal(await schemaFingerprint(c, 4), current);
    await c.query(`ALTER TABLE qa_nested_restore_check DROP CONSTRAINT qa_grouped_or,
      ADD CONSTRAINT qa_grouped_or CHECK(a OR (b AND c))`);
    assert.notEqual((await constraint(c, 'qa_grouped_or')).canonical, grouped.canonical);
    assert.notEqual(await schemaFingerprint(c, 4), current, 'Pretty deparse must preserve semantic OR grouping');
    assert.equal((await c.query('SELECT (true OR false) AND false original,true OR (false AND false) changed')).rows[0].original, false);
    assert.equal((await c.query('SELECT (true OR false) AND false original,true OR (false AND false) changed')).rows[0].changed, true);
  } finally {
    await c?.end(); await source.query('DROP TABLE IF EXISTS qa_nested_restore_check'); await source.end();
  }
});
after(async () => {
  for (const name of databases)
    await pool.query(`DROP DATABASE ${restoreDatabaseName(name)} WITH (FORCE)`);
  await rm(directory, { recursive: true, force: true });
  await pool.end();
});
test('kopie strumieniowe szyfrują i odtwarzają bajty bez ujawnienia treści', async () => {
  const key = randomBytes(32),
    body = Buffer.concat([Buffer.from('private recovery data'), randomBytes(1048576)]),
    file = resolve(directory, 'stream.dyna'),
    out = resolve(directory, 'stream.tar');
  await sealStream(Readable.from([body.subarray(0, 100), body.subarray(100)]), file, key);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert(!(await readFile(file)).includes(Buffer.from('private recovery data')));
  await unsealFile(file, out, key);
  assert.deepEqual(await readFile(out), body);
});
test('zły klucz, zmiana ciphertext lub taga i ucięcie nie pozostawiają jawnej treści', async () => {
  const key = randomBytes(32),
    file = resolve(directory, 'auth.dyna');
  await sealStream(Readable.from(['sensitive']), file, key);
  const good = await readFile(file);
  for (const [i, bytes, k] of [
    [0, good, randomBytes(32)],
    [1, Buffer.from(good), key],
    [2, Buffer.from(good), key],
    [3, good.subarray(0, 30), key],
  ] as [number, Buffer, Buffer][]) {
    if (i === 1) bytes[21] ^= 1;
    if (i === 2) bytes[bytes.length - 1] ^= 1;
    const bad = resolve(directory, `bad-${i}.dyna`),
      out = resolve(directory, `plain-${i}`);
    await writeFile(bad, bytes);
    await assert.rejects(unsealFile(bad, out, k));
    await assert.rejects(access(out));
  }
});
test('klucz odzyskiwania jest stały, prywatny i nigdy nie zastępowany przy błędzie', async () => {
  const path = resolve(directory, 'key'),
    a = await recoveryKey(path, true);
  assert.deepEqual(await recoveryKey(path, true), a);
  await chmod(path, 0o644);
  await assert.rejects(recoveryKey(path, true), /0600/);
  assert.equal((await readFile(path, 'utf8')).trim(), a.toString('hex'));
  await chmod(path, 0o600);
  await writeFile(path, 'broken');
  await assert.rejects(recoveryKey(path, true), /Nieprawidłowy/);
  assert.equal(await readFile(path, 'utf8'), 'broken');
});
test('odtwarzanie nie dopuszcza nazwy bazy roboczej ani wstrzyknięcia SQL', () => {
  for (const name of [
    'dynaminds',
    'postgres',
    'dynaminds_test_1',
    'dynaminds_restore_xyz',
    'dynaminds_restore_0123456789abcdef;DROP DATABASE dynaminds',
  ])
    assert.throws(() => restoreDatabaseName(name));
  assert.equal(
    restoreDatabaseName('dynaminds_restore_0123456789abcdef'),
    'dynaminds_restore_0123456789abcdef',
  );
});
test('pg_dump/pg_restore zachowuje wszystkie wiersze, zdjęcie, szyfrowanie, role, granty i RLS', async () => {
  const image = randomUUID(),
    images = resolve(directory, 'images');
  await mkdir(images);
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(resolve(images, image), bytes);
  const tenant = (await pool.query("SELECT id FROM tenants WHERE name='DYNAMINDS Demo'")).rows[0]
    .id;
  const channel = randomUUID(),
    secret = encrypt({ token: 'synthetic-recovery-token' });
  await pool.query('INSERT INTO product_images(id,tenant_id,mime,size) VALUES($1,$2,$3,$4)', [
    image,
    tenant,
    'image/png',
    bytes.length,
  ]);
  await pool.query(
    "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials) VALUES($1,$2,'qa','QA recovery','sandbox',$3)",
    [channel, tenant, secret],
  );
  const mfaUsers = [randomUUID(), randomUUID()],
    mfaSecrets = [newTotpSecret(), newTotpSecret()];
  for (const [i, id] of mfaUsers.entries()) {
    await pool.query(
      "INSERT INTO users(id,email,name,password_hash) SELECT $1,$2,'QA MFA recovery',password_hash FROM users LIMIT 1",
      [id, id + '@example.test'],
    );
    await pool.query(
      i === 0
        ? 'INSERT INTO account_security(user_id,secret_encrypted,enabled_at,last_step,recovery_hashes,version) VALUES($1,$2,now(),123456,\'["hashed-recovery-proof"]\',4)'
        : "INSERT INTO account_security(user_id,pending_encrypted,pending_session_hash,pending_expires_at) VALUES($1,$2,'synthetic-session',now()+interval '10 minutes')",
      [id, encrypt({ secret: mfaSecrets[i] })],
    );
  }
  const amazonState = randomUUID(),
    amazonVerifier = encrypt({ provider: 'amazon', expected_seller: 'RECOVERY076', beta: true });
  await pool.query(
    "INSERT INTO amazon_oauth_states(id,tenant_id,channel_id,user_id,session_hash,state_hash,verifier,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')",
    [amazonState, tenant, channel, mfaUsers[0], 'a'.repeat(64), 'b'.repeat(64), amazonVerifier],
  );
  const resetMail = encrypt({
    to: 'backup@example.test',
    subject: 'Recovery fixture',
    text: 'Synthetic local link',
    url: 'http://127.0.0.1:5173/#password-reset=' + 'c'.repeat(64),
  });
  await pool.query(
    "INSERT INTO account_local_mail(user_id,kind,body_encrypted,expires_at) VALUES($1,'password_reset',$2,now()+interval '15 minutes')",
    [mfaUsers[0], resetMail],
  );
  await pool.query(
    "INSERT INTO account_password_resets(user_id,token_hash,password_fingerprint,account_version,expires_at) VALUES($1,$2,$3,4,now()+interval '15 minutes')",
    [mfaUsers[0], 'd'.repeat(64), 'e'.repeat(64)],
  );
  const keyFile = resolve(directory, 'full-key'),
    source = new pg.Client(localDatabase());
  await source.connect();
  await source.query("SET TIME ZONE 'UTC'");
  const baseline = await tableFingerprints(source);
  try {
    const backup = await createBackup({
      directory: resolve(directory, 'backups'),
      keyFile,
      imageDirectory: images,
    });
    assert.equal(backup.encryption, 'AES-256-GCM');
    assert.equal(backup.images, 1);
    const restored = await restoreBackup(backup.file, {
      directory: resolve(directory, 'restores'),
      keyFile,
    });
    databases.push(restored.database);
    assert(restored.row_fingerprints_match);
    assert(restored.schema_fingerprint_match);
    assert(restored.encrypted_records_verified >= 5);
    assert.equal(restored.worker_enabled, false);
    const recovered = JSON.parse(await readFile(restored.config, 'utf8'));
    assert.deepEqual(decrypt(amazonVerifier, recovered.encryptionKey), {
      provider: 'amazon',
      expected_seller: 'RECOVERY076',
      beta: true,
    });
    assert.deepEqual(decrypt(secret, recovered.encryptionKey), {
      token: 'synthetic-recovery-token',
    });
    assert.deepEqual(await readFile(resolve(restored.images, image)), bytes);
    const c = new pg.Client({ ...localDatabase(), database: restored.database });
    await c.connect();
    await c.query("SET TIME ZONE 'UTC'");
    try {
      assert.deepEqual(await tableFingerprints(c), baseline);
      const restoredMail = (
        await c.query('SELECT body_encrypted FROM account_local_mail WHERE user_id=$1', [
          mfaUsers[0],
        ])
      ).rows[0];
      assert.deepEqual(
        decrypt(restoredMail.body_encrypted, recovered.encryptionKey),
        decrypt(resetMail),
      );
      assert.equal(
        (
          await c.query(
            'SELECT database_name=current_database() AS usable FROM account_password_resets WHERE user_id=$1',
            [mfaUsers[0]],
          )
        ).rows[0].usable,
        false,
      );
      const mfa = (
        await c.query(
          'SELECT * FROM account_security WHERE user_id=ANY($1::uuid[]) ORDER BY version DESC',
          [mfaUsers],
        )
      ).rows;
      assert.equal(decrypt(mfa[0].secret_encrypted, recovered.encryptionKey).secret, mfaSecrets[0]);
      assert.equal(
        decrypt(mfa[1].pending_encrypted, recovered.encryptionKey).secret,
        mfaSecrets[1],
      );
      assert.equal(mfa[0].last_step, '123456');
      assert.equal(mfa[0].version, '4');
      assert.deepEqual(mfa[0].recovery_hashes, ['hashed-recovery-proof']);

      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE dyna_app');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      assert.equal((await c.query('SELECT DISTINCT tenant_id FROM products')).rows.length, 1);
      assert.equal(
        (await c.query('SELECT DISTINCT tenant_id FROM products')).rows[0].tenant_id,
        tenant,
      );
      await assert.rejects(
        c.query('SELECT password_hash FROM users'),
        (e) => (e as any).code === '42501',
      );
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    assert.deepEqual(
      await tableFingerprints(source),
      baseline,
      'Baza źródłowa ma pozostać bez zmian',
    );
  } finally {
    await source.end();
    await pool.query('DELETE FROM amazon_oauth_states WHERE id=$1', [amazonState]);
    await pool.query('DELETE FROM channels WHERE id=$1', [channel]);
    await pool.query('DELETE FROM product_images WHERE id=$1', [image]);
  }
});
test('uszkodzony backup nie tworzy bazy ani nie pozostawia katalogu odszyfrowanych danych', async () => {
  const keyFile = resolve(directory, 'damaged-key'),
    file = resolve(directory, 'damaged.dyna');
  const key = await recoveryKey(keyFile, true);
  await sealStream(Readable.from(['not a tar']), file, key);
  const b = await readFile(file);
  b[b.length - 1] ^= 1;
  await writeFile(file, b);
  const before = (
    await pool.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'dynaminds_restore_%' ORDER BY datname",
    )
  ).rows;
  await assert.rejects(
    restoreBackup(file, { keyFile, directory: resolve(directory, 'broken-restores') }),
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT datname FROM pg_database WHERE datname LIKE 'dynaminds_restore_%' ORDER BY datname",
      )
    ).rows,
    before,
  );
});
test('wspólny snapshot pozostaje spójny podczas równoczesnych zapisów źródła', async () => {
  const writer = new pg.Client(localDatabase());
  await writer.connect();
  const tenant = (await pool.query("SELECT id FROM tenants WHERE name='DYNAMINDS Demo'")).rows[0]
    .id;
  let running = true;
  const ids: string[] = [];
  const writes = (async () => {
    while (running) {
      const id = randomUUID();
      ids.push(id);
      await writer.query(
        "INSERT INTO audit_events(id,tenant_id,action) VALUES($1,$2,'QA.recovery.concurrent')",
        [id, tenant],
      );
      await new Promise((done) => setTimeout(done, 2));
    }
  })();
  try {
    const options = {
      directory: resolve(directory, 'concurrent-backups'),
      keyFile: resolve(directory, 'concurrent-key'),
    };
    const backup = await createBackup(options);
    running = false;
    await writes;
    const restored = await restoreBackup(backup.file, {
      directory: resolve(directory, 'concurrent-restores'),
      keyFile: options.keyFile,
    });
    databases.push(restored.database);
    const c = new pg.Client({ ...localDatabase(), database: restored.database });
    await c.connect();
    try {
      const snapshotCount = Number(
        (await c.query("SELECT count(*) FROM audit_events WHERE action='QA.recovery.concurrent'"))
          .rows[0].count,
      );
      assert(ids.length > snapshotCount);
      assert(restored.row_fingerprints_match);
      assert(restored.schema_fingerprint_match);
    } finally {
      await c.end();
    }
  } finally {
    running = false;
    await writes;
    await writer.end();
    await pool.query('DELETE FROM audit_events WHERE id=ANY($1::uuid[])', [ids]);
  }
});
test('brak zdjęcia referencjonowanego przez bazę uniemożliwia publikację kompletnej kopii', async () => {
  const id = randomUUID(),
    tenant = (await pool.query("SELECT id FROM tenants WHERE name='DYNAMINDS Demo'")).rows[0].id;
  await pool.query(
    "INSERT INTO product_images(id,tenant_id,mime,size) VALUES($1,$2,'image/png',8)",
    [id, tenant],
  );
  const output = resolve(directory, 'missing-backups');
  try {
    await assert.rejects(
      createBackup({
        directory: output,
        keyFile: resolve(directory, 'missing-key'),
        imageDirectory: resolve(directory, 'absent-images'),
      }),
    );
    // MIG-3 (27.10): a failed backup discards the directory and key it created, not only the archive.
    await assert.rejects(readdir(output), { code: 'ENOENT' });
    await assert.rejects(readdir(resolve(directory, 'missing-key')), { code: 'ENOENT' });
  } finally {
    await pool.query('DELETE FROM product_images WHERE id=$1', [id]);
  }
});
test('podgląd odtworzenia blokuje każdy zapis biznesowy, signup, OAuth i webhooki, dopuszcza lokalne logowanie', async () => {
  const app = await buildApp({ readOnly: true, previewPort: 4101 });
  try {
    assert.equal((await app.inject('/api/health')).json().restore_preview, true);
    const spec = (await app.inject('/api/v1/openapi')).json();
    assert.equal(spec.servers[0].url, 'http://localhost:4101/api/v1');
    assert.equal(
      spec.paths['/orders'].get.description,
      'Podgląd odtworzonej kopii. Dostęp wyłącznie do odczytu. Zakres klucza: orders:read',
    );
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations as Record<string, any>)) {
        assert(
          method === 'get' ||
            (method === 'post' &&
              ['/catalog/exports/file', '/catalog/exports/preview'].includes(path) &&
              operation['x-read-only-operation'] === true),
          path + ':' + method,
        );
      }
    }
    assert(!spec.paths['/supplier-file-sources/{id}/previews']);
    for (const [method, url] of [
      ['POST', '/api/products'],
      ['PATCH', '/api/orders/' + randomUUID() + '/status'],
      ['POST', '/api/auth/signup'],
      ['POST', '/api/local-webhooks/' + randomUUID()],
      ['GET', '/api/oauth/allegro/start'],
      ['GET', '/api/inpost/points?city=Warszawa'],
      ['GET', '/api/integrations/' + randomUUID() + '/preview?resource=orders'],
    ])
      assert.equal(
        (
          await app.inject({
            method: method as any,
            url,
            payload: method === 'GET' ? undefined : {},
          })
        ).statusCode,
        423,
      );
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://localhost:4101' },
      payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers['set-cookie']!.toString().split(';')[0];
    assert.equal((await app.inject({ url: '/api/orders', headers: { cookie } })).statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: {
            email: 'admin@demo.local',
            password: 'DynaDemo!2026',
            invitation_token: '0'.repeat(64),
          },
        })
      ).statusCode,
      423,
    );
    const orphan = randomUUID(),
      orphanEmail = `restore-${orphan}@example.test`;
    const tenantsBefore = (await pool.query('SELECT count(*) FROM tenants')).rows[0].count;
    await pool.query(
      "INSERT INTO users(id,email,name,password_hash) SELECT $1,$2,'QA orphan',password_hash FROM users WHERE email='admin@demo.local'",
      [orphan, orphanEmail],
    );
    try {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { email: orphanEmail, password: 'DynaDemo!2026' },
          })
        ).statusCode,
        423,
      );
      assert.equal((await pool.query('SELECT count(*) FROM tenants')).rows[0].count, tenantsBefore);
      assert.equal(
        (await pool.query('SELECT count(*) FROM memberships WHERE user_id=$1', [orphan])).rows[0]
          .count,
        '0',
      );
    } finally {
      await pool.query('DELETE FROM users WHERE id=$1', [orphan]);
    }
  } finally {
    await app.close();
  }
});
