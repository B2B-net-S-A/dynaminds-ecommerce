/** Read-only checkpoints of the isolated QA146 firm. No writes to business data. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = '<workspace>/app';
assert.equal(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? ''), resolve(root, '.local.json'));
const phase = process.argv[2];
assert(['before', 'after-queued', 'after-files', 'after-denied', 'after-restart'].includes(phase));
const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const hash = (v: unknown) => digest(JSON.stringify(v));
const raw = await readFile(resolve(root, 'data/print-jobs-stage146.json'));
const setup = JSON.parse(raw.toString());
assert.equal(setup.stage, 146);
assert.equal(setup.complete, true);
assert.equal(setup.pending, null);
const privatePath = (p: string) => resolve(root, `data/shipment-label-print-stage146-${p}.json`);
const previous = (
  {
    'after-queued': 'before',
    'after-files': 'after-queued',
    'after-denied': 'after-files',
    'after-restart': 'after-denied',
  } as Record<string, string>
)[phase];
const prior = previous ? JSON.parse(await readFile(privatePath(previous), 'utf8')) : null;
if (prior) assert.equal(prior.setup_sha256, digest(raw));
const get = async (path: string, auth = true) => {
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: auth ? { cookie: setup.cookie, 'X-Workspace-ID': setup.tenant_id } : {},
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<any>;
};
const health = await get('/health', false);
assert.equal(health.revision, process.env.QA_EXPECTED_REVISION);
assert.equal(health.schema_revision, '130_shipment_label_prints');
assert.equal(health.shipment_label_print_available, true);
assert.equal(health.print_jobs_available, true);
assert.equal(health.background_workers_enabled, false);
assert.equal(health.restore_preview, false);
const { pool } = await import('../server/db');
try {
  const c = await pool.connect();
  const rows: Record<string, any[]> = {};
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const db = (
      await c.query(
        "SELECT current_database() db,current_user actor,inet_server_port() port,current_setting('transaction_read_only') ro",
      )
    ).rows[0];
    assert.equal(db.db, 'dynaminds');
    assert.equal(db.actor, 'postgres');
    assert.equal(db.port, 55432);
    assert.equal(db.ro, 'on');
    const names = (
      await c.query(
        "SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id') ORDER BY table_name",
      )
    ).rows;
    for (const { table_name: name } of names) {
      assert(/^[a-z_][a-z0-9_]*$/.test(name));
      rows[name] = (
        await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE tenant_id=$1 ORDER BY 1`, [
          setup.tenant_id,
        ])
      ).rows.map((v) => v.row);
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  if (prior)
    for (const table of Object.keys(rows)) {
      if (
        ['after-denied', 'after-restart'].includes(phase) ||
        ![
          'print_label_assets',
          'print_label_previews',
          'print_job_label_sources',
          'print_jobs',
          'print_job_events',
          'audit_events',
        ].includes(table)
      )
        assert.deepEqual(
          rows[table],
          prior.rows[table],
          'Printing modified protected table ' + table,
        );
    }
  const options = await get('/print-jobs/shipment-labels/options');
  assert.equal(options.can_write, true);
  assert.equal(options.read_only, false);
  const page = await get('/print-jobs/jobs');
  assert.equal(page.next_cursor, null);
  assert.equal(page.jobs.length, rows.print_jobs.length);
  let contentHash: string | null = null,
    previewId: string | null = null,
    jobId: string | null = null;
  if (phase === 'before') {
    for (const table of [
      'print_label_assets',
      'print_label_previews',
      'print_job_label_sources',
      'print_jobs',
    ])
      assert.equal(rows[table].length, 0);
  } else {
    // The first preview remains immutable after the UI/runtime reload. A second
    // explicit preview reviewed in the canvas owns the single queued job.
    assert.equal(rows.print_label_previews.length, 2);
    for (const table of ['print_label_assets', 'print_job_label_sources', 'print_jobs'])
      assert.equal(rows[table].length, 1);
    const job = page.jobs[0],
      link = rows.print_job_label_sources[0];
    assert.equal(link.preview_id, '0af78cfb-0475-4eba-953b-6d48537a6e2f');
    assert(rows.print_label_previews.some((p) => p.id === '900ebd10-e8b2-4924-81a0-3c734bde087d'));
    assert.equal(rows.print_label_assets[0].id, link.asset_id);
    jobId = job.id;
    previewId = link.preview_id;
    const preview = (await get('/print-jobs/label-previews/' + previewId)).preview;
    const content = await get('/print-jobs/label-previews/' + previewId + '/content');
    const bytes = Buffer.from(content.content_base64, 'base64');
    contentHash = digest(bytes);
    assert.equal(contentHash, preview.content_sha256);
    assert.equal(contentHash, job.content_sha256);
    assert.equal(contentHash, rows.print_label_assets[0].content_sha256);
    assert.equal(bytes.length, job.content_bytes);
    assert.equal(job.source_kind, 'shipment_label');
    assert.equal(jobId, link.job_id);
    assert.equal(preview.queued_job_id, jobId);
    assert.equal(link.shipment_id, setup.shipment_id);
    assert.equal(preview.shipment_id, setup.shipment_id);
    assert.equal(preview.source_kind, 'demo_generated');
    assert.equal(preview.can_queue, false);
    assert.equal(job.state, phase === 'after-queued' ? 'queued' : 'file_saved');
    if (phase !== 'after-queued') {
      const dir = resolve(root, `data/print-bridge/${setup.tenant_id}/${setup.printer.id}`);
      const journal = JSON.parse(await readFile(resolve(dir, 'current.json'), 'utf8'));
      assert.equal(journal.state, 'complete');
      assert.equal(journal.job_id, jobId);
      const file = await readFile(resolve(dir, `${jobId}-${contentHash}.pdf`));
      assert.deepEqual(file, bytes);
    }
  }
  const order = await get('/orders/' + setup.orders[0].id);
  for (const key of [
    'status',
    'total',
    'currency',
    'payment',
    'items',
    'shipments',
    'documents',
    'version',
  ])
    assert.deepEqual(order[key], setup.born.orders[0][key]);
  assert.deepEqual((await get('/products/' + setup.product.id)).stock, setup.born.stock);
  const snap = { stage: 146, phase, setup_sha256: digest(raw), rows };
  await writeFile(privatePath(phase), JSON.stringify(snap, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  const report = {
    stage: 146,
    phase,
    status: 'OWN_READBACK_PASS',
    runtime_revision: health.revision,
    tenant_id: setup.tenant_id,
    tables: Object.keys(rows).length,
    rows_sha256: hash(rows),
    preview_id: previewId,
    job_id: jobId,
    content_sha256: contentHash,
    counts: Object.fromEntries(
      [
        'print_label_assets',
        'print_label_previews',
        'print_job_label_sources',
        'print_jobs',
        'print_job_events',
        'shipments',
        'shipping_plans',
      ].map((n) => [n, rows[n].length]),
    ),
    protected_tables_unchanged: !!prior,
    stock_order_payment_documents_unchanged: true,
    provider_verified: false,
    physical_print_verified: false,
    full_goal_complete: false,
  };
  await writeFile(
    resolve(root, `docs/shipment-label-print-native-${phase}.json`),
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  await pool.end();
}
