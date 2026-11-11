/** Coordinator QA115. Creates only its own synthetic local firm; private state is never committed. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { SaxesParser } from 'saxes';
type Json = Record<string, any>;
const phase = process.argv[2];
assert(['setup', 'readback'].includes(phase));
const statePath = 'data/catalog-export-profiles-stage115.json';
const revision = process.env.QA_EXPECTED_REVISION;
assert(revision && /^[a-f0-9]{7,40}$/.test(revision));
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const save = (s: Json) => writeFile(statePath, JSON.stringify(s, null, 2), { mode: 0o600 });
async function call(s: Json, path: string, method = 'GET', body?: unknown, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(s.cookie ? { cookie: s.cookie, 'X-Workspace-ID': s.tenant } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  assert.equal(r.status, status, `${method} ${path}: ${text.slice(0, 500)}`);
  return { response: r, data: JSON.parse(text) as Json };
}
try {
  const health = (await call({}, '/health')).data;
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, '096_catalog_export_profiles');
  assert.equal(health.restore_preview, false);
  let s: Json;
  if (phase === 'setup') {
    let existing = false;
    try {
      await lstat(statePath);
      existing = true;
    } catch (e: any) {
      assert.equal(e.code, 'ENOENT');
    }
    assert(!existing, 'Do not recreate or overwrite an existing QA115 state. Read it first.');
    s = {
      stage: 115,
      email: `qa115-export-${randomUUID().slice(0, 8)}@demo.local`,
      password: `DynaQa115!${randomUUID()}`,
      pending: 'signup',
      setup_complete: false,
    };
    await save(s);
    const signup = await call(
      {},
      '/auth/signup',
      'POST',
      {
        email: s.email,
        password: s.password,
        name: 'QA115 Eksport',
        organization: { name: 'QA115 Profile eksportów', currency: 'PLN', locale: 'pl-PL' },
      },
      201,
    );
    s.cookie = signup.response.headers.get('set-cookie')!.split(';')[0];
    s.user = signup.data.user.id;
    s.tenant = signup.data.user.tenant_id;
    assert.equal(signup.data.user.role, 'admin');
    s.pending = 'product';
    await save(s);
    s.warehouse = (await call(s, '/warehouses')).data.data[0].id;
    s.product = (
      await call(
        s,
        '/products',
        'POST',
        {
          sku: 'QA115-EXPORT-' + randomUUID().slice(0, 8),
          ean: '001150000009',
          name: 'Produkt dla partnera ą😀',
          description: 'Opis & XML',
          price: 2599,
          quantity: 0,
          warehouse_id: s.warehouse,
        },
        201,
      )
    ).data;
    s.pending = 'profiles';
    s.profiles = [];
    await save(s);
    for (const format of ['csv', 'xml']) {
      const definition = {
        format,
        columns: ['sku', 'ean', 'name', 'price_minor', 'vat_rate', 'active'],
        headers:
          format === 'csv'
            ? { sku: 'Kod produktu', ean: 'GTIN', name: 'Nazwa partnera' }
            : { sku: 'product_code', ean: 'gtin', name: 'product_name' },
        spreadsheet_safe: format === 'csv',
      };
      const body = {
        name: 'QA115 ' + format.toUpperCase() + ' partner',
        definition,
        client_key: randomUUID(),
      };
      s.pending_request = body;
      await save(s);
      const created = await call(s, '/catalog/export-profiles', 'POST', body, 201);
      const replay = await call(s, '/catalog/export-profiles', 'POST', body);
      assert.equal(replay.data.reused, true);
      assert.deepEqual(replay.data.profile, created.data.profile);
      s.profiles.push({ body, profile: created.data.profile });
      await save(s);
      await call(
        s,
        '/catalog/export-profiles',
        'POST',
        { ...body, name: body.name + ' changed' },
        409,
      );
    }
    s.pending = null;
    delete s.pending_request;
    s.setup_complete = true;
    await save(s);
    await writeFile(
      'docs/catalog-export-profiles-native-setup-qa.json',
      JSON.stringify(
        {
          status: 'PASS',
          runtime_revision: revision,
          schema_revision: health.schema_revision,
          own_tenant: s.tenant,
          profiles: s.profiles.map((p: Json) => ({
            id: p.profile.id,
            version: 1,
            format: p.profile.definition.format,
          })),
          create_replay: 2,
          altered_create_denied: 2,
          provider_operations: false,
          full_goal_complete: false,
        },
        null,
        2,
      ),
    );
    process.stdout.write(
      JSON.stringify({ status: 'PASS', phase, profiles: s.profiles.length }) + '\n',
    );
  } else {
    const st = await lstat(statePath);
    assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600);
    s = JSON.parse(await readFile(statePath, 'utf8'));
    assert(s.setup_complete && !s.pending && s.stage === 115);
    const me = (await call(s, '/auth/me')).data.user;
    assert.equal(me.id, s.user);
    assert.equal(me.tenant_id, s.tenant);
    assert.equal(me.role, 'admin');
    const list = (await call(s, '/catalog/export-profiles')).data;
    assert(list.available && list.can_manage && !list.read_only);
    const profiles = list.data as Json[];
    assert.equal(profiles.length, 3);
    assert(profiles.every((p) => !p.archived));
    const csvProfile = profiles.find(
      (p) =>
        p.id === s.profiles.find((p: Json) => p.profile.definition.format === 'csv').profile.id,
    )!;
    const xmlProfile = profiles.find(
      (p) =>
        p.id === s.profiles.find((p: Json) => p.profile.definition.format === 'xml').profile.id,
    )!;
    assert.equal(csvProfile.version, 4);
    assert.equal(xmlProfile.version, 1);
    assert.deepEqual(csvProfile.definition.columns, [
      'ean',
      'sku',
      'name',
      'price_minor',
      'vat_rate',
      'active',
    ]);
    assert.equal(csvProfile.definition.headers.sku, 'SKU partnera');
    const newProfile = profiles.find((p) => p.name === 'QA115 CSV własny');
    assert(newProfile);
    assert.equal(newProfile.version, 1);
    assert.deepEqual(newProfile.definition, csvProfile.definition);
    const audits = (
      await pool.query(
        "SELECT action,count(*)::int n FROM audit_events WHERE tenant_id=$1 AND action LIKE 'catalog.export_profile.%' GROUP BY action ORDER BY action",
        [s.tenant],
      )
    ).rows;
    assert.deepEqual(audits, [
      { action: 'catalog.export_profile.archive', n: 1 },
      { action: 'catalog.export_profile.create', n: 3 },
      { action: 'catalog.export_profile.restore', n: 1 },
      { action: 'catalog.export_profile.update', n: 1 },
    ]);
    const rows = (
      await pool.query(
        'SELECT name,sku,ean,price,vat,active FROM products WHERE tenant_id=$1 AND id=$2',
        [s.tenant, s.product.id],
      )
    ).rows[0];
    assert.equal(rows.ean, '001150000009');
    assert.equal(rows.sku, s.product.sku);
    assert.equal(rows.price, 2599);
    const files = [];
    for (const format of ['csv', 'xml']) {
      const p = format === 'csv' ? csvProfile : xmlProfile;
      const r = await fetch('http://127.0.0.1:4100/api/catalog/exports/file', {
        method: 'POST',
        headers: {
          cookie: s.cookie,
          'X-Workspace-ID': s.tenant,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...p.definition, selection: 'selected', ids: [s.product.id] }),
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(r.status, 200);
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.equal(Number(r.headers.get('content-length')), bytes.length);
      assert.equal(r.headers.get('x-catalog-export-count'), '1');
      const text = bytes.toString('utf8'),
        values = { ...rows, price_minor: rows.price, vat_rate: rows.vat };
      if (format === 'csv') {
        const quote = (v: unknown) => '"' + String(v).replaceAll('"', '""') + '"';
        const keys = p.definition.columns as string[];
        const expected =
          '\ufeff' +
          keys.map((k) => quote(p.definition.headers[k] ?? k)).join(',') +
          '\r\n' +
          keys
            .map((k) => quote((['sku', 'ean'].includes(k) ? "'" : '') + String(values[k])))
            .join(',') +
          '\r\n';
        assert.equal(
          text,
          expected,
          'Real customized CSV must preserve headings/order/exact own values',
        );
      } else {
        const parser = new SaxesParser({ xmlns: false }),
          fields: Record<string, string> = {},
          expected: Record<string, string> = {};
        for (const k of p.definition.columns)
          expected[p.definition.headers[k] ?? k] = String(values[k]);
        let tag = '',
          products = 0;
        parser.on('opentag', (t) => {
          tag = t.name;
          if (tag === 'product') products++;
          if (tag === 'catalog') assert.equal(t.attributes.currency, 'PLN');
          if (tag in expected) fields[tag] = '';
        });
        parser.on('text', (v) => {
          if (tag in fields) fields[tag] += v;
        });
        parser.on('closetag', () => {
          tag = '';
        });
        parser.on('error', (e) => {
          throw e;
        });
        parser.write(text).close();
        assert.equal(products, 1);
        assert.deepEqual(fields, expected);
      }
      const path = `docs/catalog-export-profiles-native-custom.${format}`;
      await writeFile(path, bytes);
      files.push({
        format,
        profile_id: p.id,
        version: p.version,
        bytes: bytes.length,
        sha256: sha(bytes),
        artifact: path,
      });
    }
    const saved = (
      await pool.query(
        'SELECT to_jsonb(p) row FROM catalog_export_profiles p WHERE tenant_id=$1 ORDER BY id',
        [s.tenant],
      )
    ).rows;
    const checkpoint = {
      profiles_sha256: sha(JSON.stringify(saved)),
      profiles_count: saved.length,
      product_sha256: sha(JSON.stringify(rows)),
      profile_versions: profiles.map((p) => ({
        id: p.id,
        version: p.version,
        archived: p.archived,
      })),
    };
    if (s.accepted_checkpoint)
      assert.deepEqual(
        checkpoint,
        s.accepted_checkpoint,
        'Accepted QA115 profile/product checkpoint changed',
      );
    else {
      s.accepted_checkpoint = checkpoint;
      await save(s);
    }
    await writeFile(
      'docs/catalog-export-profiles-native-readback-qa.json',
      JSON.stringify(
        {
          status: 'PASS',
          runtime_revision: revision,
          schema_revision: health.schema_revision,
          own_tenant: s.tenant,
          checkpoint,
          files,
          provider_operations: false,
          full_goal_complete: false,
        },
        null,
        2,
      ),
    );
    process.stdout.write(
      JSON.stringify({ status: 'PASS', phase, profiles: profiles.length, files: files.length }) +
        '\n',
    );
  }
} finally {
  await pool.end();
}
