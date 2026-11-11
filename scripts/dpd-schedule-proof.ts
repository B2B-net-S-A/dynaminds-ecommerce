import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pool, tenantTx } from '../server/db';
const f = JSON.parse(await readFile('data/dpd-collection-stage046.json', 'utf8')).fixture;
const login = await fetch('http://127.0.0.1:4100/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'qa-dpd-collections@demo.local', password: 'DynaDemo!2026' }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie')!.split(';')[0];
async function api(path: string) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, { headers: { cookie } });
  assert.equal(r.status, 200);
  return (await r.json()) as any;
}
try {
  const d = await api('/integrations/' + f.local + '/dpd-pickup-schedule');
  if (process.argv[2] === 'due') {
    // QA-only clock fixture: real local scheduler/worker still perform the run.
    assert.equal(
      (await pool.query('SELECT name FROM tenants WHERE id=$1', [f.tenant])).rows[0].name,
      'QA DPD Odbiory 20261004',
    );
    assert.equal(
      (await pool.query('SELECT settings FROM channels WHERE id=$1', [f.local])).rows[0].settings
        .simulation,
      true,
    );
    assert.equal(d.schedule.enabled, true);
    assert.equal(d.runs.length, 0, 'Do not repeat forced QA slot');
    await tenantTx(f.tenant, (c) =>
      c.query(
        "UPDATE dpd_pickup_schedules SET next_at=now()-interval '1 second' WHERE channel_id=$1",
        [f.local],
      ),
    );
    console.log('Only the local simulated DPD schedule made due once');
  } else {
    assert.equal(d.runs.length, 1);
    const run = d.runs[0];
    assert.equal(run.count, 1);
    assert.equal(run.collection_ids.length, 1);
    const p = (await api('/integrations/' + f.local + '/dpd-collections')).data.find(
      (p: any) => p.id === run.collection_ids[0],
    );
    assert(p);
    assert.equal(p.result.scope, 'local_simulation');
    assert.equal(
      p.state,
      ['terminal', 'runtime'].includes(process.argv[2]) ? 'cancelled' : 'ready',
    );
    if (['terminal', 'runtime'].includes(process.argv[2])) {
      assert.equal(d.schedule.enabled, false);
      assert.equal(d.eligible, 1);
    }
    for (const o of f.orders) {
      assert.equal((await api('/orders/' + o.id)).status, 'packed');
      assert.deepEqual(
        (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [o.product]))
          .rows[0],
        { on_hand: 12, reserved: 2 },
      );
    }
    const out = {
      checked_at: new Date().toISOString(),
      scope: 'native_local_schedule_worker_no_provider_requests',
      forced_clock_fixture: true,
      provider_requests: 0,
      run_id: run.id,
      collection_id: p.id,
      state: p.state,
      scope_result: p.result.scope,
      enabled: d.schedule.enabled,
      stock_unchanged: true,
      reservations_retained: true,
      health: await api('/health'),
    };
    await writeFile(
      process.argv[2] === 'runtime'
        ? 'data/dpd-schedule-stage047-runtime.json'
        : 'docs/dpd-schedule-qa.json',
      JSON.stringify(out, null, 2) + '\n',
    );
    console.log(JSON.stringify(out));
  }
} finally {
  await pool.end();
}
