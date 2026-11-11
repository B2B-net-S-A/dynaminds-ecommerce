import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { tokenHash } from '../server/security';
import {
  createMixedHarness,
  freshMixedFixture,
  requestMixedReturn,
  localBody,
  localReceive,
  prefix,
  type Harness,
  type MixedFixture,
  type Row,
} from './b2b-return-local-origins-fixture';

let h: Harness;
before(async () => {
  h = await createMixedHarness();
});
after(async () => {
  if (h) await h.close();
  else await pool.end();
});
const writeScopes = [
  'orders:read',
  'inventory:read',
  'orders:write',
  'inventory:write',
  'purchasing:write',
];
const financialScopes = [...writeScopes, 'purchasing:read'];
const path = (id: string) => prefix + '/returns/' + id;
const headers = (f: MixedFixture, token: string) => ({
  authorization: 'Bearer ' + token,
  'X-Workspace-ID': f.buyer.tenant,
});
function publicRequest(
  f: MixedFixture,
  token: string,
  route: string,
  method: 'GET' | 'POST' = 'GET',
  payload?: Row,
) {
  return h.app.inject({ url: '/api/v1' + route, method, payload, headers: headers(f, token) });
}
function noStore(response: Row) {
  assert.match(String(response.headers['cache-control']), /no-store/);
}
async function publicBody(f: MixedFixture, key: Row, r: Row) {
  const response = await publicRequest(f, key.token, path(r.id) + '/context');
  assert.equal(response.statusCode, 200, response.body);
  noStore(response);
  const context = response.json().context;
  const source = context.local_sources.find((s: Row) => s.customer_item_id === f.customerItem.id);
  assert(source);
  assert.equal(source.shipment_id, f.localShipment);
  assert.match(context.local_scope_hash, /^[a-f0-9]{64}$/);
  return {
    client_key: randomUUID(),
    version: Number(r.version),
    scope_hash: context.local_scope_hash,
    confirmed: true,
    items: [
      {
        customer_item_id: f.customerItem.id,
        shipment_id: source.shipment_id,
        quantity: r.items[0].requested,
      },
    ],
  };
}
async function mint(f: MixedFixture, scopes: string[]) {
  const key = await f.ok('/developer/keys', 'POST', {
    name: 'Own mixed-RMA public compound grant',
    scopes,
    expires_days: 30,
  });
  assert.match(key.token, /^dyna_api_[a-f0-9]{64}$/);
  const saved = (
    await pool.query(
      `SELECT tenant_id,user_id,scopes,token_hash,
    revoked_at,expires_at>clock_timestamp() active FROM api_keys WHERE id=$1`,
      [key.id],
    )
  ).rows;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].tenant_id, f.buyer.tenant);
  assert.equal(saved[0].user_id, f.buyer.user);
  assert.deepEqual(saved[0].scopes, scopes);
  assert.equal(saved[0].token_hash, tokenHash(key.token));
  assert.equal(saved[0].revoked_at, null);
  assert.equal(saved[0].active, true);
  return key;
}
async function protectedBusiness(f: MixedFixture) {
  const all = await f.snapshot();
  // Only intentionally changed IAM/quota accounting are excluded, never source/RMA/stock/evidence.
  const { api_keys, memberships, workspace_usage, ...business } = all;
  return business;
}
function noFinancialFields(value: unknown) {
  if (Array.isArray(value)) {
    for (const v of value) noFinancialFields(v);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [name, v] of Object.entries(value)) {
    assert(
      !name.endsWith('_minor') && name !== 'payment_balance',
      'Quantity projection leaked finances',
    );
    noFinancialFields(v);
  }
}

test('public local-origin fresh write requires every compound business scope, and purchasing read controls only financial projection', async () => {
  const f = await freshMixedFixture(h),
    r = await requestMixedReturn(f),
    body = await localBody(f, r);
  for (const missing of writeScopes) {
    const key = await mint(
      f,
      financialScopes.filter((s) => s !== missing),
    );
    const before = await protectedBusiness(f);
    const refused = await publicRequest(f, key.token, path(r.id) + '/local-origin', 'POST', body);
    assert.equal(refused.statusCode, 403, refused.body);
    noStore(refused);
    if (!['orders:read', 'inventory:read'].includes(missing)) {
      const read = await publicRequest(f, key.token, path(r.id) + '/context');
      assert.equal(read.statusCode, 200, read.body);
      noStore(read);
      assert.equal(read.json().can_manage, false);
      assert.equal(read.json().context.can_select_local_origin, false);
      assert.equal(read.json().context.can_receive_locally, false);
    }
    assert.deepEqual(
      await protectedBusiness(f),
      before,
      'Missing grant cannot create any origin/proof/physical effect',
    );
  }
  const quantityKey = await mint(f, writeScopes);
  const context = await publicRequest(f, quantityKey.token, path(r.id) + '/context');
  assert.equal(context.statusCode, 200, context.body);
  noStore(context);
  assert.equal(context.json().current_role, 'admin');
  assert.equal(context.json().can_manage, true);
  assert.equal(context.json().can_read_value, false);
  assert.equal(context.json().context.can_select_local_origin, true);
  noFinancialFields(context.json());
  const quantityBody = await publicBody(f, quantityKey, r);
  const physicalBefore = await f.snapshot({ physicalOnly: true });
  const created = await publicRequest(
    f,
    quantityKey.token,
    path(r.id) + '/local-origin',
    'POST',
    quantityBody,
  );
  assert.equal(created.statusCode, 201, created.body);
  noStore(created);
  assert.equal(created.json().reused, false);
  assert.equal(created.json().can_read_value, false);
  assert.equal(created.json().context.fulfillment_origin, 'local');
  assert.equal(created.json().context.can_receive_locally, true);
  assert.deepEqual(created.json().origin.items, quantityBody.items);
  noFinancialFields(created.json());
  assert.deepEqual(
    await f.snapshot({ physicalOnly: true }),
    physicalBefore,
    'Provenance is not a receipt',
  );
});

test('public exact local-origin replay remains inert and rechecks lost scope, revocation and expiry before reading a durable result', async () => {
  const f = await freshMixedFixture(h),
    r = await requestMixedReturn(f);
  const key = await mint(f, financialScopes);
  const body = await publicBody(f, key, r);
  const created = await publicRequest(f, key.token, path(r.id) + '/local-origin', 'POST', body);
  assert.equal(created.statusCode, 201, created.body);
  noStore(created);
  const accepted = created.json(),
    afterCreation = await f.snapshot();
  const replay = await publicRequest(f, key.token, path(r.id) + '/local-origin', 'POST', body);
  assert.equal(replay.statusCode, 200, replay.body);
  noStore(replay);
  assert.equal(replay.json().reused, true);
  assert.equal(replay.json().origin.id, accepted.origin.id);
  assert.deepEqual(replay.json().origin, accepted.origin);
  assert.deepEqual(
    await f.snapshot(),
    afterCreation,
    'Exact replay cannot append a second origin/action/proof',
  );
  const expiry = (await pool.query('SELECT expires_at FROM api_keys WHERE id=$1', [key.id])).rows[0]
    .expires_at;
  for (const denial of ['scope', 'revoked', 'expired'] as const) {
    try {
      if (denial === 'scope')
        await pool.query('UPDATE api_keys SET scopes=$2::text[] WHERE id=$1', [
          key.id,
          financialScopes.filter((s) => s !== 'inventory:write'),
        ]);
      else if (denial === 'revoked')
        await pool.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE id=$1', [key.id]);
      else
        await pool.query(
          "UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [key.id],
        );
      const before = await protectedBusiness(f);
      const refused = await publicRequest(f, key.token, path(r.id) + '/local-origin', 'POST', body);
      assert.equal(refused.statusCode, denial === 'scope' ? 403 : 401, refused.body);
      noStore(refused);
      assert.deepEqual(
        await protectedBusiness(f),
        before,
        'Current ACL denial cannot replay a private receipt or mutate state',
      );
    } finally {
      await pool.query(
        'UPDATE api_keys SET scopes=$2::text[],revoked_at=NULL,expires_at=$3 WHERE id=$1',
        [key.id, financialScopes, expiry],
      );
    }
    const before = await f.snapshot();
    const restored = await publicRequest(f, key.token, path(r.id) + '/local-origin', 'POST', body);
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().reused, true);
    assert.equal(restored.json().origin.id, accepted.origin.id);
    assert.deepEqual(
      await f.snapshot(),
      before,
      'Restored authority recovers only the immutable original result',
    );
  }
});

test('administrator demotion revokes public local-origin replay and fresh selection, while its own viewer session stays quantity-only', async () => {
  const f = await freshMixedFixture(h),
    r = await requestMixedReturn(f);
  const key = await mint(f, financialScopes);
  const body = await publicBody(f, key, r);
  const selected = await publicRequest(f, key.token, path(r.id) + '/local-origin', 'POST', body);
  assert.equal(selected.statusCode, 201, selected.body);
  const otherRma = await requestMixedReturn(f),
    freshBody = await publicBody(f, key, otherRma);
  let revokedAt: string | null = null;
  try {
    await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      f.buyer.tenant,
      f.buyer.user,
    ]);
    revokedAt = (await pool.query<{ revoked_at: string | null }>(
      'SELECT revoked_at::text FROM api_keys WHERE id=$1', [key.id],
    )).rows[0].revoked_at;
    assert(revokedAt, 'Actual membership trigger must revoke the key on administrator demotion');
    const before = await protectedBusiness(f);
    for (const [id, request] of [
      [r.id, body],
      [otherRma.id, freshBody],
    ] as const) {
      const refused = await publicRequest(
        f,
        key.token,
        path(id) + '/local-origin',
        'POST',
        request,
      );
      assert.equal(refused.statusCode, 401, refused.body);
      noStore(refused);
      const publicRead = await publicRequest(f, key.token, path(id) + '/context');
      assert.equal(publicRead.statusCode, 401, publicRead.body);
      noStore(publicRead);
      const read = await f.request(path(id) + '/context');
      assert.equal(read.statusCode, 200, read.body);
      noStore(read);
      assert.equal(read.json().current_role, 'viewer');
      assert.equal(read.json().can_manage, false);
      assert.equal(read.json().can_read_value, false);
      assert.equal(read.json().context.can_select_local_origin, false);
      assert.equal(read.json().context.can_receive_locally, false);
      assert.equal(read.json().context.can_preview, false);
      assert.equal(read.json().context.can_reconcile, false);
      noFinancialFields(read.json());
    }
    assert.deepEqual(await protectedBusiness(f), before);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      f.buyer.tenant,
      f.buyer.user,
    ]);
  }
  assert.equal((await pool.query<{ revoked_at: string | null }>(
    'SELECT revoked_at::text FROM api_keys WHERE id=$1', [key.id],
  )).rows[0].revoked_at, revokedAt, 'Restoring administrator membership must not resurrect the key');
  const before = await protectedBusiness(f);
  const deniedReplay = await publicRequest(f, key.token, path(r.id) + '/local-origin', 'POST', body);
  assert.equal(deniedReplay.statusCode, 401, deniedReplay.body);
  noStore(deniedReplay);
  const deniedRead = await publicRequest(f, key.token, path(r.id) + '/context');
  assert.equal(deniedRead.statusCode, 401, deniedRead.body);
  noStore(deniedRead);
  assert.deepEqual(await protectedBusiness(f), before);
});

test('public read-only context keeps immutable provenance readable but purges physical write capabilities and refuses malformed writes before parsing', async () => {
  const f = await freshMixedFixture(h),
    r = await requestMixedReturn(f);
  const key = await mint(f, financialScopes);
  const unselected = await requestMixedReturn(f);
  const body = await publicBody(f, key, r);
  const selected = await publicRequest(f, key.token, path(r.id) + '/local-origin', 'POST', body);
  assert.equal(selected.statusCode, 201, selected.body);
  const readonly = await buildApp({ readOnly: true });
  try {
    const before = await f.snapshot();
    for (const id of [r.id, unselected.id]) {
      const response = await readonly.inject({
        url: '/api/v1' + path(id) + '/context',
        headers: headers(f, key.token),
      });
      assert.equal(response.statusCode, 200, response.body);
      noStore(response);
      const dto = response.json();
      assert.equal(dto.read_only, true);
      assert.equal(dto.can_manage, false);
      assert.equal(dto.context.can_select_local_origin, false);
      assert.equal(dto.context.can_receive_locally, false);
      assert.equal(dto.context.can_preview, false);
      assert.equal(dto.context.can_reconcile, false);
      if (id === r.id) {
        assert.equal(dto.context.fulfillment_origin, 'local');
        assert.deepEqual(dto.context.local_origin, selected.json().origin);
      }
    }
    for (const route of [path(r.id) + '/local-origin', '/returns/' + r.id + '/receive']) {
      const refused = await readonly.inject({
        url: '/api/v1' + route,
        method: 'POST',
        headers: { ...headers(f, key.token), 'content-type': 'application/json' },
        payload: '{',
      });
      assert.equal(refused.statusCode, 423, refused.body);
      noStore(refused);
      assert(
        !refused.body.includes('Unexpected end') && !refused.body.includes('JSON input'),
        'Read-only denial precedes parser',
      );
    }
    assert.deepEqual(
      await f.snapshot(),
      before,
      'Public read-only reads/denials never create a receipt or mutate business state',
    );
  } finally {
    await readonly.close();
  }
});

test('public selected local provenance fails closed when an actual physical seal is disabled and recovers without any business mutation', async () => {
  const f = await freshMixedFixture(h),
    r = await requestMixedReturn(f);
  const key = await mint(f, financialScopes),
    unselected = await requestMixedReturn(f);
  const freshBody = await publicBody(f, key, unselected),
    body = await publicBody(f, key, r);
  const selected = await publicRequest(f, key.token, path(r.id) + '/local-origin', 'POST', body);
  assert.equal(selected.statusCode, 201, selected.body);
  const receiptBody = await localReceive(f, await f.ok('/returns/' + r.id), selected.json().origin);
  const before = await f.snapshot();
  // Only the isolated native harness owner may deliberately tear its disposable schema.
  assert.equal(process.env.DYNA_TEST, 'true');
  assert.match(
    (await pool.query('SELECT current_database() name')).rows[0].name,
    /^dynaminds_test_/,
  );
  let torn: Awaited<ReturnType<typeof buildApp>> | undefined;
  await pool.query('ALTER TABLE stock_locations DISABLE TRIGGER local_return_seal');
  try {
    const disabled = (
      await pool.query(`SELECT tgenabled FROM pg_trigger
      WHERE tgrelid='stock_locations'::regclass AND tgname='local_return_seal'`)
    ).rows;
    assert.equal(disabled.length, 1);
    assert.equal(disabled[0].tgenabled, 'D');
    torn = await buildApp();
    const health = await torn.inject({ url: '/api/health' });
    assert.equal(health.statusCode, 200, health.body);
    assert.equal(health.json().b2b_local_return_origins_available, false);
    for (const id of [r.id, unselected.id]) {
      const context: Row = await torn.inject({
        url: '/api/v1' + path(id) + '/context',
        headers: headers(f, key.token),
      });
      assert.equal(context.statusCode, 503, context.body);
      noStore(context);
    }
    for (const [route, request] of [
      [path(r.id) + '/local-origin', body],
      [path(unselected.id) + '/local-origin', freshBody],
      ['/returns/' + r.id + '/receive', receiptBody],
    ] as const) {
      const refused: Row = await torn.inject({
        url: '/api/v1' + route,
        method: 'POST',
        payload: request,
        headers: headers(f, key.token),
      });
      assert.equal(refused.statusCode, 503, refused.body);
      noStore(refused);
    }
    assert.deepEqual(
      await f.snapshot(),
      before,
      'Torn physical protection cannot select, replay or receive any RMA',
    );
  } finally {
    try {
      await pool.query('ALTER TABLE stock_locations ENABLE TRIGGER local_return_seal');
    } finally {
      await torn?.close();
    }
  }
  const recovered = await publicRequest(f, key.token, path(r.id) + '/context');
  assert.equal(recovered.statusCode, 200, recovered.body);
  noStore(recovered);
  assert.equal(recovered.json().context.can_receive_locally, true);
  assert.deepEqual(recovered.json().context.local_origin, selected.json().origin);
  assert.deepEqual(
    await f.snapshot(),
    before,
    'Restoring the real seal recovers only the existing authoritative local context',
  );
});
