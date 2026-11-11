import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { returnAssistantFixture } from './return-assistant-fixture';
import { receiveReturnAssistantInTx } from '../server/return-assistant';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { await migrate(); await seed(); app = await buildApp({ integrationTransport: async () => { throw Error('Own return safety cannot call a provider'); } }); });
after(async () => { try { await app?.close(); } finally { await pool.end(); } });

async function snapshot(tenant: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    const names = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND column_name='tenant_id') ORDER BY 1")).rows.map(r => r.table_name as string);
    const rows: Record<string, Row[]> = {};
    for (const name of names) { assert.match(name, /^[a-z_][a-z0-9_]*$/); rows[name] = (await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE tenant_id=$1 ORDER BY 1`, [tenant])).rows; }
    await c.query('COMMIT'); return rows;
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}
async function request(f: Row, path: string, method: any = 'GET', payload?: any, key?: Row) {
  return await app.inject({ url: '/api' + (key ? '/v1' : '') + path, method, payload,
    headers: key ? { authorization: 'Bearer ' + key.token } : { cookie: f.cookie }, remoteAddress: '127.154.1.1' });
}
async function ok(f: Row, path: string, method: any = 'GET', payload?: any, key?: Row) {
  const r = await request(f, path, method, payload, key); assert(r.statusCode < 300, `${method} ${path}: ${r.statusCode}`); return r.json() as Row;
}
async function approved(f: Row, key?: Row) {
  const lease = randomUUID();
  let session = (await ok(f, '/return-assistant/sessions', 'POST', { client_key: randomUUID(), return_number: f.rma.number, station_id: f.station.id, station_version: String(f.station.version), lease_token: lease }, key)).session;
  session = (await ok(f, '/return-assistant/sessions/' + session.id + '/scans', 'POST', { client_key: randomUUID(), version: String(session.version), lease_token: lease, code: f.product.sku, item_id: f.rma.items[0].item_id }, key)).session;
  session = (await ok(f, '/return-assistant/sessions/' + session.id + '/draft', 'PATCH', { client_key: randomUUID(), version: String(session.version), lease_token: lease, note: 'Own inspected goods, same physical receive ledger', shipping_refund: 0, parts: [{ part_id: randomUUID(), item_id: f.rma.items[0].item_id, status: 'sale', quantity: 1 }], ...(f.receiveBody?.wms_lots ? { wms_lots: f.receiveBody.wms_lots } : {}) }, key)).session;
  const preview = (await ok(f, '/return-assistant/sessions/' + session.id + '/previews', 'POST', { client_key: randomUUID(), version: String(session.version), lease_token: lease }, key)).preview;
  return { session, preview, body: { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true as const, lease_token: lease }, path: '/return-assistant/previews/' + preview.id + '/receive' };
}
async function holder(f: Row) {
  const c = await pool.connect(); await c.query('BEGIN');
  await c.query('SELECT id FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [f.tenant, f.order.id]); return c;
}
async function waitOn(c: PoolClient, query = /return_assistant_prepare|orders.*FOR UPDATE/i) {
  const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid, until = Date.now() + 4000;
  while (Date.now() < until) {
    const waiting = (await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))", [pid])).rows;
    if (waiting.some(r => query.test(r.query))) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Actual assistant receive must wait on its own held order before authority withdrawal');
}
async function change(sql: string, args: unknown[]) {
  const c = await pool.connect(); try { await c.query('BEGIN'); await c.query("SET LOCAL statement_timeout='1500ms'"); await c.query(sql, args); await c.query('COMMIT'); } finally { await c.query('ROLLBACK'); c.release(); }
}

test('ordinary OFF receive withdraws current membership after a genuine order wait and rolls back all approval rows', async () => {
  const f = await returnAssistantFixture(app, false), made = await approved(f), beforeRows = await snapshot(f.tenant), held = await holder(f);
  let pending: ReturnType<typeof request> | undefined, revoked = false;
  try {
    pending = request(f, made.path, 'POST', made.body); await waitOn(held);
    await change("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]); revoked = true;
    await held.query('ROLLBACK'); assert.equal((await pending).statusCode, 403);
  } finally { await held.query('ROLLBACK'); held.release(); await pending?.catch(() => undefined); if (revoked) await change("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]); }
  assert.deepEqual(await snapshot(f.tenant), beforeRows, 'Entire own business snapshot including restored membership is exact');
});

test('ordinary OFF final IAM waits after receipt validation and output hydration, then rejects the withdrawn role', async () => {
  const f = await returnAssistantFixture(app, false), made = await approved(f), beforeRows = await snapshot(f.tenant);
  let hydrated!: () => void, releaseHydration!: () => void;
  const reachedHydration = new Promise<void>(resolve => { hydrated = resolve; });
  const resumeHydration = new Promise<void>(resolve => { releaseHydration = resolve; });
  let flushed = false, reached = false, withdrawn = false;
  const authority = await pool.connect();
  const pending = tenantTx(f.tenant, async c => {
    const original = c.query.bind(c);
    (c as any).query = async (...args: any[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      const result = await (original as any)(...args);
      if (/^SET CONSTRAINTS ALL IMMEDIATE$/i.test(sql ?? '')) flushed = true;
      // Pause only after the actual immutable receipt read, not before core or
      // deferred validation. The later wait is the real final IAM FOR SHARE.
      if (flushed && /^SELECT \* FROM return_assistant_receipts WHERE id=/i.test(sql ?? '')) {
        assert.equal(result.rows.length, 1); reached = true; hydrated(); await resumeHydration;
      }
      return result;
    };
    try { return await receiveReturnAssistantInTx(c, f.actor, made.preview.id, made.body); }
    finally { c.query = original as any; }
  });
  // Attach rejection handling immediately while the separate owner connection
  // establishes the real membership lock; preserve the exact service error.
  const outcome = pending.then(value => ({ value, error: undefined as unknown }), error => ({ value: undefined, error }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([reachedHydration, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Must reach genuine receipt hydration after flush')), 5000); })]);
    if (timer) clearTimeout(timer);
    await authority.query('BEGIN'); await authority.query("SET LOCAL statement_timeout='1500ms'");
    await authority.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
    releaseHydration();
    // pg_stat_activity exposes the SD outer call, while blocking_pids proves
    // that this request is waiting on our own membership row, not any lock.
    await waitOn(authority, /return_assistant_access/i);
    await authority.query('COMMIT'); withdrawn = true;
    const result = await outcome;
    assert.equal((result.error as any)?.status, 403); assert.equal(result.value, undefined);
  } finally {
    if (timer) clearTimeout(timer); releaseHydration();
    await authority.query('ROLLBACK'); authority.release(); await outcome;
    if (withdrawn) await change("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
  }
  assert.equal(reached, true); assert.equal(flushed, true);
  assert.deepEqual(await snapshot(f.tenant), beforeRows, 'Final authority denial rolls back RMA, receipt, stock and journals after validation');
});

test('a live API key is revalidated after an actual receive wait and a different valid key cannot approve its frozen session', async () => {
  const f = await returnAssistantFixture(app, false), key = await ok(f, '/developer/keys', 'POST', { name: 'Own return assistant held-key safety', scopes: ['orders:read', 'orders:write'] });
  assert.equal((await request(f, '/return-assistant/options', 'GET', undefined, key)).statusCode, 200);
  const made = await approved(f, key), other = await ok(f, '/developer/keys', 'POST', { name: 'Different current key cannot impersonate session', scopes: ['orders:read', 'orders:write'] });
  assert.equal((await request(f, '/return-assistant/options', 'GET', undefined, other)).statusCode, 200);
  const beforeRows = await snapshot(f.tenant);
  assert.equal((await request(f, made.path, 'POST', made.body, other)).statusCode, 409);
  assert.deepEqual(await snapshot(f.tenant), beforeRows);
  const held = await holder(f); let pending: ReturnType<typeof request> | undefined, revoked = false;
  try { pending = request(f, made.path, 'POST', made.body, key); await waitOn(held); await change('UPDATE api_keys SET revoked_at=now() WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id]); revoked = true; await held.query('ROLLBACK'); assert.equal((await pending).statusCode, 401); }
  finally { await held.query('ROLLBACK'); held.release(); await pending?.catch(() => undefined); if (revoked) await change('UPDATE api_keys SET revoked_at=NULL WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id]); }
  assert.deepEqual(await snapshot(f.tenant), beforeRows);
});

test('a throw immediately before assistant finish rolls back genuine RMA, stock and both OFF/ON journals', async () => {
  for (const on of [false, true]) {
    const f = await returnAssistantFixture(app, on), made = await approved(f), beforeRows = await snapshot(f.tenant);
    const sentinel = new Error('Own deliberate rollback after actual core receive'); let reached = false;
    await assert.rejects(tenantTx(f.tenant, async c => {
      const original = c.query.bind(c);
      (c as any).query = async (...args: any[]) => {
        const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        if (/\bSELECT\s+return_assistant_finish\s*\(/i.test(sql ?? '')) {
          const rma = (await original('SELECT state,receipt FROM return_cases WHERE id=$1', [f.rma.id])).rows[0];
          assert.equal(rma.state, 'refund_pending'); assert(rma.receipt);
          const movements = (await original("SELECT delta FROM stock_movements WHERE return_id=$1 AND kind='return'", [f.rma.id])).rows;
          assert(movements.length > 0 && movements.every(r => r.delta > 0), 'Actual physical core return already happened in this same transaction');
          const fragments = (await original('SELECT id FROM wms_return_fragments WHERE return_id=$1', [f.rma.id])).rows;
          assert.equal(fragments.length > 0, on); reached = true; throw sentinel;
        }
        return (original as any)(...args);
      };
      try { await receiveReturnAssistantInTx(c, f.actor, made.preview.id, made.body); }
      finally { c.query = original as any; }
    }), e => e === sentinel);
    assert.equal(reached, true, 'Must reach actual assistant finish after successful core receive');
    assert.deepEqual(await snapshot(f.tenant), beforeRows);
  }
});

test('foreign tenant cannot read or receive a frozen preview and exact committed replay has no second physical effect', async () => {
  const f = await returnAssistantFixture(app, false), foreign = await returnAssistantFixture(app, false), made = await approved(f);
  const beforeRows = await snapshot(f.tenant), foreignBefore = await snapshot(foreign.tenant);
  assert.equal((await request(foreign, '/return-assistant/previews/' + made.preview.id)).statusCode, 404);
  assert.equal((await request(foreign, made.path, 'POST', made.body)).statusCode, 404);
  assert.deepEqual(await snapshot(f.tenant), beforeRows); assert.deepEqual(await snapshot(foreign.tenant), foreignBefore);
  const first = await request(f, made.path, 'POST', made.body); assert.equal(first.statusCode, 201); const accepted = await snapshot(f.tenant);
  const replay = await request(f, made.path, 'POST', made.body); assert.equal(replay.statusCode, 200); assert.equal(replay.json().reused, true);
  assert.deepEqual(replay.json().receipt, first.json().receipt); assert.deepEqual(await snapshot(f.tenant), accepted);
  assert.equal((await request(f, made.path, 'POST', { ...made.body, scope_hash: '0'.repeat(64) })).statusCode, 409);
  assert.deepEqual(await snapshot(f.tenant), accepted); assert.deepEqual(await snapshot(foreign.tenant), foreignBefore);
});

test('raw admitted OFF stock-only RMA cannot certify a physical return without its actual core journal', async () => {
  const f = await returnAssistantFixture(app, false), made = await approved(f), beforeRows = await snapshot(f.tenant);
  const frozen = (await pool.query('SELECT payload FROM return_assistant_previews WHERE tenant_id=$1 AND id=$2', [f.tenant, made.preview.id])).rows[0].payload;
  const core = frozen.receive_input, receiptId = randomUUID(); let prepared = false, reachedFinish = false;
  await assert.rejects(tenantTx(f.tenant, async c => {
    const admitted = (await c.query('SELECT return_assistant_prepare($1,$2,$3,$4,$5) id', [made.preview.id, receiptId, made.body, f.user, null])).rows[0].id;
    assert.equal(admitted, receiptId); prepared = true;
    // Preserve the legitimate request, receipt sequence and exact commercial
    // credit. Only the actual core movement is missing from this raw attack.
    await c.query('UPDATE return_items SET accepted=$1,restocked=$2,refund_amount=$3 WHERE return_id=$4 AND item_id=$5', [core.items[0].accepted, core.items[0].restocked, frozen.summary.refund_minor, f.rma.id, core.items[0].item_id]);
    await c.query("SELECT set_config('app.stock_location','ZWROT',true)");
    await c.query('UPDATE stock SET on_hand=on_hand+1 WHERE warehouse_id=$1 AND product_id=$2', [f.warehouse, f.product.id]);
    await c.query("SELECT set_config('app.stock_location','',true)");
    await c.query("UPDATE return_cases SET state='refund_pending',receipt=$2,refunded_shipping=$3,refund_amount=$4,decision_note=$5,received_at=now(),receipt_sequence=(SELECT coalesce(max(receipt_sequence),0)+1 FROM return_cases WHERE order_id=$6),version=version+1,updated_at=now() WHERE id=$1", [f.rma.id, core, core.shipping_refund, frozen.summary.refund_minor, core.note, f.order.id]);
    await c.query('UPDATE orders SET updated_at=now() WHERE id=$1', [f.order.id]);
    assert.equal((await c.query('SELECT count(*)::int n FROM stock_movements WHERE return_id=$1', [f.rma.id])).rows[0].n, 0);
    reachedFinish = true;
    await c.query('SELECT return_assistant_finish($1,$2,$3)', [receiptId, f.user, null]);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  }), (e: any) => e.code === '23514' && e.message === 'Przyjęcie wymaga dokładnego rzeczywistego dziennika zwrotu');
  assert.equal(prepared, true); assert.equal(reachedFinish, true);
  assert.deepEqual(await snapshot(f.tenant), beforeRows);
});

test('genuine OFF and ON approval cannot append an extra return journal after deferred validation', async () => {
  for (const on of [false, true]) {
    const f = await returnAssistantFixture(app, on), made = await approved(f), beforeRows = await snapshot(f.tenant);
    let reachedFlush = false;
    await assert.rejects(tenantTx(f.tenant, async c => {
      const original = c.query.bind(c);
      (c as any).query = async (...args: any[]) => {
        const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        const result = await (original as any)(...args);
        if (/^SET CONSTRAINTS ALL IMMEDIATE$/i.test(sql ?? '') && !reachedFlush) {
          const actual = (await original('SELECT id FROM return_assistant_receipts WHERE preview_id=$1', [made.preview.id])).rows;
          assert.equal(actual.length, 1, 'Real core receive, assistant finish and complete graph must already validate');
          reachedFlush = true;
          await original("INSERT INTO stock_movements(id,tenant_id,product_id,warehouse_id,order_id,delta,kind,return_id,note) VALUES($1,$2,$3,$4,$5,1,'return',$6,'Own extra journal without any stock update')", [randomUUID(), f.tenant, f.components[0].id, f.warehouse, f.order.id, f.rma.id]);
        }
        return result;
      };
      try { await receiveReturnAssistantInTx(c, f.actor, made.preview.id, made.body); }
      finally { c.query = original as any; }
    }), (e: any) => e.code === '23514' && e.message === 'Zatwierdzone przyjęcie asystenta jest zamknięte');
    assert.equal(reachedFlush, true);
    assert.deepEqual(await snapshot(f.tenant), beforeRows);
  }
});

test('orders-only readers see physical custody without private WMS costs, ciphertext or a guessable frame hash', async () => {
  const f = await returnAssistantFixture(app, true), made = await approved(f);
  const readKey = await ok(f, '/developer/keys', 'POST', { name: 'Own custody reader without purchasing grant', scopes: ['orders:read'] });
  const forbidden = new Set(['unit_cost_minor', 'value_minor', 'value_delta', 'unit_cost', 'known_minor', 'financial_hash', 'layers_hash', 'cost_hash', 'valuation_hash', 'positions_hash', 'private_scope_nonce', 'scope_nonce', 'lease_token_hash', 'content_encrypted', 'request_hash', 'api_key_id']);
  const safe = (v: any, path = '$') => {
    if (Array.isArray(v)) { v.forEach((x, i) => safe(x, path + '[' + i + ']')); return; }
    if (v && typeof v === 'object') for (const [key, value] of Object.entries(v)) {
      assert(!forbidden.has(key), 'Private custody field must not appear at ' + path + '.' + key); safe(value, path + '.' + key);
    }
  };
  const frozen = (await pool.query(`SELECT scope_hash,return_assistant_hash(payload) bare_hash,
    scope_hash=return_assistant_hash(payload||jsonb_build_object('private_scope_nonce',private_scope_nonce)) salted,
    EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'snapshot'->'source'->'issue_fragments') f WHERE f->>'unit_cost_minor'='1000') genuine_cost
    FROM return_assistant_previews WHERE tenant_id=$1 AND id=$2`, [f.tenant, made.preview.id])).rows[0];
  assert.equal(frozen.genuine_cost, true, 'Fixture must contain a private known cost to exercise redaction');
  assert.equal(frozen.salted, true); assert.notEqual(frozen.scope_hash, frozen.bare_hash);
  await assert.rejects(tenantTx(f.tenant, c => c.query('SELECT private_scope_nonce FROM return_assistant_previews WHERE id=$1', [made.preview.id])), (e: any) => e.code === '42501');
  for (const path of ['/return-assistant/options', '/return-assistant/sessions/' + made.session.id, '/return-assistant/previews/' + made.preview.id]) {
    const dto = await ok(f, path, 'GET', undefined, readKey); safe(dto); assert.equal(dto.can_write, false);
    if (dto.session) assert.equal(dto.session.can_control, false, 'Read-only key cannot control its user\'s active cookie-owned session');
    if (dto.preview) { assert.equal(dto.preview.can_read_value, false); assert.equal(dto.preview.can_receive, false); assert(dto.preview.snapshot.source.issue_fragments.length > 0); }
  }
  await change("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
  try {
    const dto = await ok(f, '/return-assistant/sessions/' + made.session.id); safe(dto);
    assert.equal(dto.current_role, 'viewer'); assert.equal(dto.can_write, false); assert.equal(dto.session.state, 'active');
    assert.equal(dto.session.can_control, false, 'Current viewer cannot control an active session it originally created as admin');
  } finally { await change("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]); }
  const accepted = (await ok(f, made.path, 'POST', made.body)).receipt;
  safe(accepted); assert.equal(accepted.can_read_value, false);
  const beforeRows = await snapshot(f.tenant); let viewer = false;
  try {
    await change("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]); viewer = true;
    for (const path of ['/return-assistant/sessions/' + made.session.id, '/return-assistant/previews/' + made.preview.id, '/return-assistant/receipts/' + accepted.id]) {
      const dto = await ok(f, path); safe(dto); assert.equal(dto.current_role, 'viewer'); assert.equal(dto.can_write, false);
      if (dto.receipt) assert.equal(dto.receipt.can_read_value, false);
    }
    assert.equal((await request(f, made.path, 'POST', made.body)).statusCode, 403, 'An exact committed receipt does not bypass current authority');
  } finally { if (viewer) await change("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]); }
  assert.deepEqual(await snapshot(f.tenant), beforeRows);
});
