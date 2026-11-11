import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { seed } from './fixtures';
import {
  bootstrap151169, install152169, fixture169, facts169, physicalExact169,
  wait169, type Fixture169, type Row,
} from './catalog-stock-control169-fixture';

// Source-authored actual PG/App gates. Root alone executes this disposable
// numeric database. These cases prove lifecycle admission of metadata writers;
// they do not claim BO activation or physical writer certification.
let app: Awaited<ReturnType<typeof buildApp>>, providers = 0;
before(async () => {
  await bootstrap151169(); await seed(); await install152169();
  app = await buildApp({ integrationTransport: async () => {
    providers++; throw Error('No providers in custom lifecycle proof169');
  } });
});
after(async () => { try { assert.equal(providers, 0); await app?.close(); } finally { await pool.end(); } });

type Kind = '146 policy' | '147 status' | '150 WZ configuration';
const kinds: Kind[] = ['146 policy', '147 status', '150 WZ configuration'];
function input(f: Fixture169, kind: Kind) {
  const warehouse = f.warehouses.find((w: Row) => w.id !== f.warehouse.id);
  assert(warehouse, 'Use a genuine own empty assigned warehouse, not forged stock');
  if (kind === '146 policy') return {
    previewPath: '/warehouse-inventory-policies/warehouses/' + warehouse.id + '/previews',
    commitPrefix: '/warehouse-inventory-policies/previews/',
    body: { client_key: randomUUID(), version: '0', usage: 'sale', enabled: true },
    warehouse,
  };
  if (kind === '147 status') return {
    previewPath: '/return-assistant/statuses/previews',
    commitPrefix: '/return-assistant/statuses/previews/',
    body: { client_key: randomUUID(), kind: 'create', settings: {
      name: 'Own lifecycle169 accepted', color: '#12abef', active: true,
      decision: 'accept', inventory_effect: 'sale', warehouse_id: warehouse.id,
      warehouse_policy_version: '0', default_location: 'RET-169',
    } },
    warehouse,
  };
  return {
    previewPath: '/warehouse-automatic-wz/warehouses/' + warehouse.id + '/previews',
    commitPrefix: '/warehouse-automatic-wz/previews/',
    body: { client_key: randomUUID(), expected_version: '0', settings: {
      enabled: false, moment: 'physical_dispatch', series_name: 'Own lifecycle169 WZ', prefix: 'L169-WZ',
    } },
    warehouse,
  };
}
const consent = (preview: Row) => ({ client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true });

async function unpinnedMembership(f: Fixture169) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // A real conflicting NOWAIT lock proves that the blocked writer has not
    // obtained a membership SHARE PIN before its lifecycle wait. It changes
    // no role and makes no unsupported claim from pg_locks tuple visibility.
    const r = await c.query('SELECT role FROM public.memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE NOWAIT', [f.tenant, f.user]);
    assert.equal(r.rowCount, 1); assert.equal(r.rows[0].role, 'admin');
  } finally { await c.query('ROLLBACK'); c.release(); }
}

for (const kind of kinds) for (const phase of ['preview', 'commit'] as const)
  test(`${kind} ${phase} waits on actual lifecycle EXCLUSIVE before metadata/IAM locks`, async () => {
    const f = await fixture169(app), b = input(f, kind);
    const prepared = phase === 'commit' ? await f.ok(b.previewPath, 'POST', b.body, 201) : null;
    const path = prepared ? b.commitPrefix + prepared.preview.id + '/commit' : b.previewPath;
    const body = prepared ? consent(prepared.preview) : b.body;
    const before = await facts169(), block = await pool.connect();
    let request: ReturnType<typeof f.request> | undefined;
    try {
      await block.query('BEGIN');
      const pid = (await block.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await block.query("SELECT pg_advisory_xact_lock(hashtextextended('catalog.strict.lifecycle:'||$1,0))", [f.tenant]);
      request = f.request(path, 'POST', body);
      const waiting = await wait169(pid, /catalog\.strict\.lifecycle/i);
      assert(waiting, 'The real endpoint must be observed waiting, not inferred from a timer');
      await unpinnedMembership(f);
      assert.deepEqual(await facts169(), before, 'No private preview/operation/audit or physical effect before lifecycle admission');
      await block.query('COMMIT');
      const response = await request;
      assert.equal(response.statusCode, 201, response.body);
      const saved = response.json(); assert.equal(saved.reused, false); assert.equal(saved.current_role, 'admin');
      if (phase === 'preview') {
        assert(saved.preview); assert.equal(kind === '147 status' ? saved.preview.request.client_key : saved.preview.client_key, b.body.client_key);
        assert.deepEqual(saved.preview.request, b.body); assert.equal(saved.preview.ready, true);
      } else {
        assert(saved.operation); assert.equal(saved.operation.preview_id, prepared!.preview.id);
        assert.equal(kind === '147 status' ? saved.operation.request.client_key : saved.operation.client_key, body.client_key);
        if (kind === '146 policy') {
          assert.equal(saved.operation.warehouse_id, b.warehouse.id);
          assert.deepEqual(saved.operation.before, { usage: 'sale', enabled: true, version: '0' });
          assert.deepEqual(saved.operation.after, { usage: 'sale', enabled: true, version: '1' });
        } else if (kind === '147 status') {
          assert.equal(saved.status.version, '1'); assert.deepEqual(saved.status.settings, b.body.settings);
          assert.equal(saved.operation.after.id, saved.status.id);
        } else {
          assert.equal(saved.operation.warehouse_id, b.warehouse.id);
          assert.equal(saved.operation.before.version, '0'); assert.equal(saved.operation.after.version, '1');
          assert.deepEqual(saved.operation.after.settings, b.body.settings);
        }
      }
    } finally {
      await block.query('ROLLBACK').catch(() => {}); block.release();
      if (request) await request;
    }
    physicalExact169(before, await facts169());
  });

for (const kind of kinds) test(`${kind} actual preview and commit fail503 on missing152 ledger, without any metadata/physical change`, async () => {
  const f = await fixture169(app), b = input(f, kind);
  const prepared = await f.ok(b.previewPath, 'POST', b.body, 201), before = await facts169();
  const ledger = (await pool.query("SELECT name,applied_at::text applied_at FROM public.migrations WHERE name='152_catalog_stock_control'")).rows[0];
  assert(ledger);
  try {
    await pool.query('DELETE FROM public.migrations WHERE name=$1', [ledger.name]);
    const torn = await facts169();
    const preview = await f.request(b.previewPath, 'POST', { ...b.body, client_key: randomUUID() });
    assert.equal(preview.statusCode, 503, preview.body);
    const commit = await f.request(b.commitPrefix + prepared.preview.id + '/commit', 'POST', consent(prepared.preview));
    assert.equal(commit.statusCode, 503, commit.body);
    assert.deepEqual(await facts169(), torn, 'Missing152 is not treated as legacy; both refused calls leave all global rows/sessions exact');
  } finally {
    await pool.query('INSERT INTO public.migrations(name,applied_at) VALUES($1,$2)', [ledger.name, ledger.applied_at]);
  }
  assert.deepEqual(await facts169(), before, 'Exact ledger repair and unconditional cleanup, no new revisions/counters/audits');
});
