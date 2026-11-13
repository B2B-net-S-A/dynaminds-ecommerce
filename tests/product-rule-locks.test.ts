import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { applyAi } from '../server/catalog-ai';
import { applyDeepL, binding } from '../server/deepl-catalog';
import { applyBatchProduct } from '../server/deepl-batches';
import { createProductRule } from '../server/product-rules';
import { tick } from '../server/worker';
import { encrypt } from '../server/security';
import { Problem } from '../server/errors';
import type { Actor } from '../server/domain';
import { tenantScopedOwnerQuery } from './tenant-scoped-owner-write';

assert.equal(process.env.DYNA_TEST, 'true', 'Lock tests require an isolated ephemeral DB');
const testUrl = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(testUrl.hostname));
assert.match(
  testUrl.pathname,
  /^\/dynaminds_test_\d+$/,
  'Never run these fixtures on the native app DB',
);

let user: string, actor: Actor, warehouse: string, channel: any;
const reviewed = { name: 'Zatwierdzona nazwa', description: 'Zatwierdzony opis produktu.' };
type Operation = 'AI' | 'DeepL' | 'DeepL batch';
type Fixture = { operation: Operation; product: any; drafts: string[]; batch?: string };

before(async () => {
  await migrate();
  await seed();
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  actor = { tenantId: randomUUID(), userId: user, role: 'admin' };
  warehouse = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Lock order QA','enterprise')", [
    actor.tenantId,
  ]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    actor.tenantId,
    user,
  ]);
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Locks','LOCKS')", [
    warehouse,
    actor.tenantId,
  ]);
  channel = (
    await pool.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,'deepl','Local lock fixture','sandbox',$3,$4,'simulation') RETURNING *",
      [
        randomUUID(),
        actor.tenantId,
        encrypt({ api_key: 'isolated-lock-fixture:fx' }),
        JSON.stringify({ api_plan: 'free', simulation: true }),
      ],
    )
  ).rows[0];
  await createProductRule(actor, {
    client_key: randomUUID(),
    confirm_future_changes: true,
    definition: {
      name: 'Observe actual apply',
      event: 'product.updated',
      enabled: true,
      conditions: [{ field: 'sku', op: 'prefix', value: 'LOCK-' }],
      actions: [{ type: 'set_category', category: 'Automatyczna kategoria' }],
    },
  });
});
after(async () => {
  await pool.end();
});

// Only completed source fixtures are inserted. No inference, translation or provider call is made.
// Positive apply controls below prove these rows exercise the real writable branches.
async function ready(operation: Operation): Promise<Fixture> {
  const id = randomUUID();
  const product = (
    await pool.query(
      "INSERT INTO products(id,tenant_id,sku,name,description,price,category,attributes) VALUES($1,$2,$3,'Pierwotna nazwa','Pierwotny opis',1234,'Pierwotna kategoria',$4) RETURNING *",
      [id, actor.tenantId, 'LOCK-' + id, JSON.stringify({ Materiał: 'stal' })],
    )
  ).rows[0];
  await tenantScopedOwnerQuery(
    actor.tenantId,
    'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) VALUES($1,$2,$3,7)',
    [actor.tenantId, warehouse, id],
  );
  const source = { name: product.name, description: product.description };
  if (operation === 'AI') {
    const job = randomUUID(),
      draft = randomUUID();
    await pool.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,state,dedup_key) VALUES($1,$2,'catalog.ai',$3,'done',$4)",
      [job, actor.tenantId, JSON.stringify({ draft_id: draft }), job],
    );
    await pool.query(
      "INSERT INTO ai_catalog_drafts(id,tenant_id,product_id,actor_id,client_key,request_hash,source_version,source,destination,locale,model,model_digest,state,output,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'catalog','pl','qa-local:small',$9,'ready',$10,$11)",
      [
        draft,
        actor.tenantId,
        id,
        user,
        randomUUID(),
        'a'.repeat(64),
        product.version,
        JSON.stringify(source),
        'b'.repeat(64),
        JSON.stringify(reviewed),
        job,
      ],
    );
    return { operation, product, drafts: [draft] };
  }
  let batch: string | undefined;
  const targets = operation === 'DeepL batch' ? ['de', 'en-us'] : ['de'];
  if (operation === 'DeepL batch') {
    batch = randomUUID();
    await pool.query(
      "INSERT INTO deepl_catalog_batches(id,tenant_id,actor_id,channel_id,client_key,request_hash,connection_hash,source_lang,target_langs,formality,product_count,draft_count,characters,simulation,state) VALUES($1,$2,$3,$4,$5,$6,$7,'pl',$8,'default',1,2,100,true,'finished')",
      [
        batch,
        actor.tenantId,
        user,
        channel.id,
        randomUUID(),
        'c'.repeat(64),
        binding(channel),
        JSON.stringify(targets),
      ],
    );
  }
  const drafts: string[] = [];
  for (const [index, locale] of targets.entries()) {
    const draft = randomUUID();
    drafts.push(draft);
    await pool.query(
      "INSERT INTO deepl_catalog_drafts(id,tenant_id,product_id,channel_id,actor_id,client_key,request_hash,connection_hash,source_version,source,source_lang,target_lang,formality,characters,simulation,state,output,batch_id,batch_ordinal,batch_sku) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pl',$11,'default',50,true,'ready',$12,$13,$14,$15)",
      [
        draft,
        actor.tenantId,
        id,
        channel.id,
        user,
        randomUUID(),
        'd'.repeat(64),
        binding(channel),
        product.version,
        JSON.stringify(source),
        locale,
        JSON.stringify(reviewed),
        batch ?? null,
        batch ? index : null,
        batch ? product.sku : null,
      ],
    );
  }
  return { operation, product, drafts, batch };
}
function apply(f: Fixture) {
  if (f.operation === 'AI')
    return applyAi(actor, f.drafts[0], { approve: true, version: f.product.version, ...reviewed });
  if (f.operation === 'DeepL')
    return applyDeepL(actor, f.drafts[0], {
      approve: true,
      version: f.product.version,
      ...reviewed,
    });
  return applyBatchProduct(actor, f.batch!, f.product.id, {
    approve: true,
    version: f.product.version,
    texts: f.drafts.map((draft_id) => ({ draft_id, ...reviewed })),
  });
}
async function snapshot() {
  const tables = [
    'products',
    'stock',
    'product_translations',
    'ai_catalog_drafts',
    'deepl_catalog_drafts',
    'deepl_catalog_batches',
    'jobs',
    'product_rule_runs',
    'product_rule_items',
    'product_rule_causes',
    'audit_events',
  ];
  const rows: Record<string, unknown> = {};
  for (const table of tables) {
    // Identifiers come from the closed list above, never from profile or request data.
    rows[table] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,
        [actor.tenantId],
      )
    ).rows;
  }
  return rows;
}
async function blockedByCatalog(holder: number) {
  // Deadline to reach the wait, not part of it: the request first runs the ungated test tenantTx schema
  // validators, and 2.5 s missed the wait locally under load on 13.11.2026.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const blocked = await pool.query(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%' AND $1=ANY(pg_blocking_pids(pid))",
      [holder],
    );
    if (blocked.rows.length) return blocked.rows[0].pid;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('Apply did not actually wait on the held tenant catalogue lock');
}

for (const operation of ['AI', 'DeepL', 'DeepL batch'] as const) {
  test(
    `${operation}: admin revocation commits while real apply waits for catalogue; then 403 without mutations or jobs`,
    // Hang guard only: 16 s and more locally under load on 13.11.2026 (15 s cut it off).
    { timeout: 120000 },
    async () => {
      const control = await ready(operation);
      await apply(control);
      const changed = (await pool.query('SELECT * FROM products WHERE id=$1', [control.product.id]))
        .rows[0];
      assert.equal(changed.version, control.product.version + 1);
      assert.equal(changed.price, control.product.price);
      assert.equal(
        changed.category,
        control.product.category,
        'Rule is queued, not synchronously applied',
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND kind='product.rules' AND state='pending'",
            [actor.tenantId],
          )
        ).rows[0].n,
        1,
      );
      const savedTranslations = (
        await pool.query('SELECT * FROM product_translations WHERE product_id=$1', [
          control.product.id,
        ])
      ).rows;
      assert.equal(savedTranslations.length, operation === 'AI' ? 0 : control.drafts.length);
      for (const t of savedTranslations) assert.equal(t.name, reviewed.name);
      if (operation === 'AI') assert.equal(changed.name, reviewed.name);

      const fixture = await ready(operation),
        before = await snapshot();
      const holder = await pool.connect(),
        revoke = await pool.connect();
      let outcome: Promise<{ value?: unknown; error?: unknown }> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'catalog:' + actor.tenantId,
        ]);
        const holderPid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        outcome = apply(fixture).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        const waiterPid = await blockedByCatalog(holderPid);
        await revoke.query('BEGIN');
        // Bound a genuine lock regression so it fails promptly instead of deadlocking the suite.
        await revoke.query("SET LOCAL statement_timeout='1500ms'");
        const revoked = await revoke.query(
          "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2 RETURNING role",
          [actor.tenantId, user],
        );
        assert.equal(revoked.rows[0].role, 'viewer');
        await revoke.query('COMMIT');
        assert.equal(
          (await pool.query('SELECT $1=ANY(pg_blocking_pids($2)) blocked', [holderPid, waiterPid]))
            .rows[0].blocked,
          true,
          'Membership commit must precede releasing catalogue',
        );
        assert.equal(
          (
            await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
              actor.tenantId,
              user,
            ])
          ).rows[0].role,
          'viewer',
        );
        await holder.query('COMMIT');
        const result = await outcome;
        assert.ok(
          result.error instanceof Problem,
          'Expected an actual service authorization rejection',
        );
        assert.equal(result.error.status, 403);
        assert.deepEqual(
          await snapshot(),
          before,
          'Revoked apply must leave catalogue, drafts, translations, audit and rule jobs unchanged',
        );
      } finally {
        await revoke.query('ROLLBACK');
        revoke.release();
        await holder.query('ROLLBACK');
        holder.release();
        if (outcome) await outcome;
      }
    },
  );
}

test(
  'actual worker tick does not claim another pending lease if product-rule reaper transaction fails',
  // Hang guard only: the fault trigger changes pg_catalog, so the tick runs every schema guard uncached:
  // 25 s locally on 13.11.2026; 15 s cut it off on CI (run 43425966080).
  { timeout: 120000 },
  async () => {
    const failedSource = await ready('AI'),
      pendingSource = await ready('AI');
    await apply(failedSource);
    await apply(pendingSource);
    const runs = (
      await pool.query(
        'SELECT r.* FROM product_rule_runs r JOIN product_rule_items i ON (i.tenant_id,i.run_id)=(r.tenant_id,r.id) WHERE r.tenant_id=$1 ORDER BY i.product_id',
        [actor.tenantId],
      )
    ).rows;
    const failed = runs.find((r) => r.cause_id === failedSource.drafts[0]);
    const pending = runs.find((r) => r.cause_id === pendingSource.drafts[0]);
    assert.ok(failed && pending, 'Actual apply should emit both automatic runs');
    await pool.query(
      "UPDATE jobs SET state='failed',error='Controlled exhausted lease' WHERE id=$1",
      [failed.job_id],
    );
    const before = await snapshot();
    // Real PostgreSQL fault, scoped to one disposable fixture. No function or transport mock.
    await pool.query(`CREATE FUNCTION locks_test_reaper_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD.id='${failed.id}'::uuid AND NEW.state='failed' THEN
      RAISE EXCEPTION 'LOCKS_TEST_REAPER_FAULT';
    END IF; RETURN NEW; END $$`);
    try {
      await pool.query(
        'CREATE TRIGGER locks_test_reaper_fault BEFORE UPDATE ON product_rule_runs FOR EACH ROW EXECUTE FUNCTION locks_test_reaper_fault()',
      );
      await assert.rejects(
        tick({
          transport: async () => {
            throw new Error('Lock tests never contact providers');
          },
        }),
        (e: unknown) => e instanceof Error && e.message.includes('LOCKS_TEST_REAPER_FAULT'),
      );
      assert.deepEqual(
        await snapshot(),
        before,
        'Failed reaper must rollback item writes and leave unrelated pending jobs untouched',
      );
      const job = (
        await pool.query('SELECT state,attempts,lease_token,locked_at FROM jobs WHERE id=$1', [
          pending.job_id,
        ])
      ).rows[0];
      assert.deepEqual(job, { state: 'pending', attempts: 0, lease_token: null, locked_at: null });
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS locks_test_reaper_fault ON product_rule_runs');
      await pool.query('DROP FUNCTION IF EXISTS locks_test_reaper_fault()');
    }
  },
);
