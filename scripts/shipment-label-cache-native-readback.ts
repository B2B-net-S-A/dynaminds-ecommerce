/** Root-run QA147 GET/native readback only. No provider transport, login or business writes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = '<workspace>/app';
const docs = '<workspace>/worktrees/stock-file-import/docs';
const setupPath = resolve(root, 'data/shipment-label-cache-stage147.json');
const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const hash = (v: unknown) => digest(JSON.stringify(v));
const encode = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
type Rows = Record<string, any[]>;
const privatePath = (phase: string) =>
  resolve(root, `data/shipment-label-cache-stage147-${phase}.json`);
const changed = new Set([
  'print_label_assets',
  'print_label_previews',
  'print_job_label_sources',
  'print_jobs',
  'print_job_events',
  'audit_events',
]);
let step = 'preflight';
async function privateBytes(path: string) {
  const st = await lstat(path);
  assert(st.isFile() && !st.isSymbolicLink(), 'Private file type');
  assert.equal(st.mode & 0o777, 0o600, 'Private file mode');
  assert.equal(await realpath(path), path, 'Private file alias');
  return readFile(path);
}
async function exclusive(path: string, value: unknown, mode: number) {
  assert.equal(await realpath(dirname(path)), dirname(path), 'Evidence directory alias');
  const f = await open(path, 'wx', mode);
  try {
    await f.writeFile(encode(value));
    await f.sync();
  } finally {
    await f.close();
  }
}
function one(rows: any[]) {
  assert.equal(rows.length, 1, 'Exact one row');
  return rows[0];
}
function publicMetadata(v: unknown) {
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    assert(
      !/password|token|credentials|encrypted|connection_hash|source_frame|request_hash|content_base64/i.test(
        k,
      ),
      'Public metadata secrecy',
    );
    publicMetadata(x);
  }
}
async function main() {
  const phase = process.argv[2];
  assert(phase && ['before', 'after-files', 'after-restart'].includes(phase), 'Phase');
  const revision = process.env.QA_EXPECTED_REVISION ?? '';
  assert.match(revision, /^[a-f0-9]{40}$/, 'Expected revision');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true', 'Workers disabled');
  assert.notEqual(process.env.DYNA_TEST, 'true', 'Native only');
  assert.equal(resolve(process.cwd()), root, 'Primary cwd');
  assert.equal(resolve(dirname(fileURLToPath(import.meta.url)), '..'), root, 'Primary script');
  assert.equal(
    resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? ''),
    resolve(root, '.local.json'),
    'Config path',
  );
  await privateBytes(resolve(root, '.local.json'));
  const setupBytes = await privateBytes(setupPath),
    s = JSON.parse(setupBytes.toString());
  assert.equal(s.stage, 147);
  assert.equal(s.complete, true);
  assert.equal(s.pending, null);
  assert.equal(s.provider_verified, false);
  assert.equal(s.fixture_seeded_source, true);
  assert.equal(s.schema_revision, '131_shipment_label_cache');
  assert.equal(s.orders.length, 2);
  const previousPhase =
    phase === 'after-files' ? 'before' : phase === 'after-restart' ? 'after-files' : null;
  const previous = previousPhase
    ? JSON.parse((await privateBytes(privatePath(previousPhase))).toString())
    : null;
  if (previous) {
    assert.equal(previous.stage, 147);
    assert.equal(previous.phase, previousPhase);
    assert.equal(previous.setup_sha256, digest(setupBytes));
  }
  const pdf = Buffer.from(s.controlled_pdf.content_base64, 'base64');
  assert.equal(digest(pdf), s.controlled_pdf.content_sha256);
  assert.equal(pdf.length, s.controlled_pdf.content_bytes);
  async function response(path: string, auth = true) {
    assert(path.startsWith('/'), 'GET path');
    const r = await fetch('http://127.0.0.1:4100/api' + path, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: auth ? { cookie: s.cookie, 'X-Workspace-ID': s.tenant_id } : {},
    });
    assert.equal(r.status, 200, 'GET status');
    return r;
  }
  const get = async (path: string, auth = true) =>
    (await response(path, auth)).json() as Promise<any>;
  async function health() {
    const h = await get('/health', false);
    assert.equal(h.status, 'ok');
    assert.equal(h.mode, 'local');
    assert.equal(h.revision, revision);
    assert.equal(h.schema_revision, '131_shipment_label_cache');
    assert.equal(h.background_workers_enabled, false);
    assert.equal(h.restore_preview, false);
    assert.equal(h.shipment_label_cache_available, true);
    assert.equal(h.shipment_label_print_available, true);
    assert.equal(h.print_jobs_available, true);
    return h;
  }
  step = 'health';
  await health();
  const { pool } = await import('../server/db');
  try {
    const url = new URL(pool.options.connectionString!);
    assert(['127.0.0.1', 'localhost'].includes(url.hostname));
    assert.equal(url.port, '55432');
    assert.equal(url.pathname, '/dynaminds');
    async function snapshot(): Promise<Rows> {
      const c = await pool.connect();
      const rows: Rows = {};
      try {
        await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await c.query("SET LOCAL TimeZone='UTC'");
        const db = (
          await c.query(
            "SELECT current_database() db,current_user role,host(inet_server_addr()) host,inet_server_port() port,current_setting('transaction_read_only') ro",
          )
        ).rows[0];
        assert.equal(db.db, 'dynaminds');
        assert.equal(db.role, 'postgres');
        assert(['127.0.0.1', '::1'].includes(db.host));
        assert.equal(db.port, 55432);
        assert.equal(db.ro, 'on');
        const names = (
          await c.query(
            "SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id') ORDER BY table_name",
          )
        ).rows.map((r) => r.table_name);
        for (const name of [...names, 'users', 'tenants']) {
          assert.match(name, /^[a-z_][a-z0-9_]*$/);
          rows[name] = (
            await c.query(
              `SELECT to_jsonb(t) row FROM "${name}" t WHERE ${['users', 'tenants'].includes(name) ? 'id' : 'tenant_id'}=$1 ORDER BY 1`,
              [name === 'users' ? s.user_id : s.tenant_id],
            )
          ).rows.map((r) => r.row);
        }
        await c.query('COMMIT');
        return rows;
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    }
    step = 'native_before';
    const rows = await snapshot();
    if (previous) {
      assert.deepEqual(Object.keys(rows), Object.keys(previous.rows), 'Table inventory');
      for (const name of Object.keys(rows))
        if (phase === 'after-restart' || !changed.has(name))
          assert.deepEqual(rows[name], previous.rows[name], 'Protected table ' + name);
      for (const name of changed)
        for (const old of previous.rows[name]) {
          // Jobs legitimately transition only between before and after-files; there are none in before.
          assert(
            rows[name].some((v) => hash(v) === hash(old)),
            'Original printing/audit row retained ' + name,
          );
        }
    }
    assert.equal(rows.shipment_label_cache_assets.length, 1);
    assert.equal(rows.shipment_label_cache_acquisitions.length, 3);
    const cache = one(rows.shipment_label_cache_assets),
      first = s.orders[0],
      second = s.orders[1];
    assert.equal(cache.shipment_id, first.shipment_id);
    assert.equal(cache.order_id, first.id);
    assert.equal(cache.provider, 'inpost');
    assert.equal(cache.origin, 'provider_get');
    assert.equal(cache.mode, 'sandbox');
    assert.equal(cache.content_sha256, digest(pdf));
    assert.equal(cache.content_bytes, pdf.length);
    const originalAcq = one(
      rows.shipment_label_cache_acquisitions.filter((r) => r.id === cache.acquisition_id),
    );
    assert.equal(originalAcq.state, 'ready');
    assert.equal(originalAcq.asset_id, cache.id);
    const hit = one(
      rows.shipment_label_cache_acquisitions.filter(
        (r) => r.shipment_id === first.shipment_id && r.id !== cache.acquisition_id,
      ),
    );
    assert.equal(hit.state, 'ready');
    assert.equal(hit.asset_id, cache.id);
    assert.notEqual(hit.id, cache.acquisition_id);
    const abandoned = one(
      rows.shipment_label_cache_acquisitions.filter((r) => r.shipment_id === second.shipment_id),
    );
    assert.equal(abandoned.state, 'abandoned');
    assert.equal(abandoned.asset_id, null);
    step = 'cache_api';
    const meta = await get('/print-jobs/shipments/' + first.shipment_id + '/label-cache');
    const history = await get(
      '/print-jobs/shipments/' + first.shipment_id + '/label-cache/history?limit=50',
    );
    const detail = await get('/print-jobs/label-cache/' + cache.id);
    for (const v of [meta, history, detail]) publicMetadata(v);
    assert.equal(meta.cache.id, cache.id);
    assert.equal(meta.source_hash, cache.source_hash);
    assert.equal(meta.cache.acquisition_id, cache.acquisition_id);
    assert.equal(meta.can_queue, true);
    assert.equal(history.data.length, 2);
    assert.equal(history.next_cursor, null);
    assert.deepEqual(
      new Set(history.data.map((r: any) => r.id)),
      new Set([originalAcq.id, hit.id]),
    );
    assert.equal(detail.cache.id, cache.id);
    assert.equal(detail.acquisition.id, cache.acquisition_id);
    const content = await get('/print-jobs/label-cache/' + cache.id + '/content');
    assert.equal(content.content_base64, pdf.toString('base64'));
    assert.equal(content.content_sha256, digest(pdf));
    assert.equal(content.content_bytes, pdf.length);
    const rawPdf = await response(
      '/print-jobs/label-cache/' + cache.id + '/pdf?workspace_id=' + s.tenant_id,
    );
    assert.equal(rawPdf.headers.get('content-type')?.split(';')[0], 'application/pdf');
    assert.deepEqual(Buffer.from(await rawPdf.arrayBuffer()), pdf);
    step = 'original_business';
    for (let i = 0; i < s.orders.length; i++)
      assert.deepEqual(
        await get('/orders/' + s.orders[i].id),
        s.born.order_details[i],
        'Original order API exact',
      );
    assert.deepEqual(
      (await get('/products/' + s.product.id)).stock,
      s.born.stock,
      'Stock API exact',
    );
    let previewId: string | null = null,
      jobId: string | null = null;
    if (phase === 'before') {
      for (const name of [
        'print_label_assets',
        'print_label_previews',
        'print_job_label_sources',
        'print_jobs',
      ])
        assert.equal(rows[name].length, 0);
    } else {
      step = 'print_graph';
      const asset = one(rows.print_label_assets),
        p = one(rows.print_label_previews),
        link = one(rows.print_job_label_sources),
        job = one(rows.print_jobs);
      previewId = p.id;
      jobId = job.id;
      assert.equal(asset.cache_asset_id, cache.id);
      assert.equal(asset.source_kind, 'inpost_cached');
      assert.equal(asset.content_sha256, digest(pdf));
      assert.equal(asset.content_bytes, pdf.length);
      assert.equal(p.asset_id, asset.id);
      assert.equal(p.request.asset_id, cache.id);
      assert.equal(link.asset_id, asset.id);
      assert.equal(link.preview_id, p.id);
      assert.equal(link.job_id, job.id);
      assert.equal(link.shipment_id, first.shipment_id);
      assert.equal(link.order_id, first.id);
      assert.equal(job.state, 'file_saved');
      assert.equal(job.version, 3);
      assert.equal(job.printer_id, s.printer.id);
      assert.equal(job.source_kind, 'shipment_label');
      assert.equal(job.content_sha256, digest(pdf));
      assert.equal(job.content_bytes, pdf.length);
      assert.equal(job.content_base64, pdf.toString('base64'));
      assert.equal(job.printer_snapshot.output_mode, 'file');
      assert.equal(job.copies, 1);
      const events = rows.print_job_events
        .filter((r) => r.job_id === job.id)
        .sort((a, b) => a.version_after - b.version_after);
      assert.deepEqual(
        events.map((e) => e.operation),
        ['job_create', 'claim', 'ack'],
      );
      assert.deepEqual(
        events.map((e) => e.version_after),
        [1, 2, 3],
      );
      const preview = (await get('/print-jobs/label-previews/' + p.id)).preview;
      assert.equal(preview.source_snapshot.cache_asset_id, cache.id);
      assert.equal(preview.source_snapshot.source_hash, cache.source_hash);
      assert.equal(preview.source_kind, 'inpost_cached');
      assert.equal(preview.queued_job_id, job.id);
      assert.equal(preview.can_queue, false);
      assert.equal(preview.content_sha256, digest(pdf));
      assert.equal(preview.content_bytes, pdf.length);
      const pc = await get('/print-jobs/label-previews/' + p.id + '/content');
      assert.equal(pc.content_base64, pdf.toString('base64'));
      const apiJob = await get('/print-jobs/jobs/' + job.id);
      assert.equal(apiJob.job.state, 'file_saved');
      assert.equal(apiJob.job.content_sha256, digest(pdf));
      step = 'file_sink';
      const dir = resolve(root, 'data/print-bridge', s.tenant_id, s.printer.id);
      const journal = JSON.parse((await privateBytes(resolve(dir, 'current.json'))).toString());
      assert.equal(journal.state, 'complete');
      assert.equal(journal.job_id, job.id);
      assert.equal(journal.config.tenant_id, s.tenant_id);
      assert.equal(journal.config.printer_id, s.printer.id);
      assert.equal(journal.content.content_base64, pdf.toString('base64'));
      assert.equal(journal.content.content_sha256, digest(pdf));
      assert.equal(journal.ack.result, 'file_saved');
      assert.equal(journal.ack.content_sha256, digest(pdf));
      const name = job.id + '-' + digest(pdf) + '.pdf';
      assert.equal(journal.ack.artifact_name, name);
      assert.deepEqual(await privateBytes(resolve(dir, name)), pdf);
    }
    step = 'effect_free';
    assert.deepEqual(await snapshot(), rows, 'GET/native effect free');
    await health();
    assert.equal(digest(await privateBytes(setupPath)), digest(setupBytes), 'Setup bytes exact');
    const snapshotSha = hash(rows);
    const checkpoint = {
      stage: 147,
      phase,
      runtime_revision: revision,
      schema_revision: '131_shipment_label_cache',
      setup_sha256: digest(setupBytes),
      rows,
      snapshot_sha256: snapshotSha,
      evidence: {
        cache_id: cache.id,
        original_acquisition_id: cache.acquisition_id,
        cache_hit_acquisition_id: hit.id,
        preview_id: previewId,
        job_id: jobId,
        content_sha256: digest(pdf),
      },
    };
    step = 'save_evidence';
    await exclusive(privatePath(phase), checkpoint, 0o600);
    const report = {
      stage: 147,
      phase,
      status: 'OWN_CACHE_PRINT_READBACK_PASS',
      runtime_revision: revision,
      schema_revision: '131_shipment_label_cache',
      tenant_id: s.tenant_id,
      own_tables: Object.keys(rows).length,
      snapshot_sha256: snapshotSha,
      checkpoint_sha256: digest(encode(checkpoint)),
      setup_sha256: digest(setupBytes),
      cache_assets: 1,
      acquisitions: 3,
      print_assets: rows.print_label_assets.length,
      previews: rows.print_label_previews.length,
      jobs: rows.print_jobs.length,
      ...checkpoint.evidence,
      readback_effect_free: true,
      sessions_excluded: true,
      provider_verified: false,
      external_dispatch_verified: false,
      physical_print_verified: false,
      restore_verified: false,
      full_goal_verified: false,
    };
    await exclusive(resolve(docs, 'shipment-label-cache-native-' + phase + '.json'), report, 0o600);
    console.log(
      JSON.stringify({
        status: report.status,
        phase,
        own_tables: report.own_tables,
        snapshot_sha256: snapshotSha,
        provider_verified: false,
      }),
    );
  } finally {
    await pool.end();
  }
}
main().catch((e: unknown) => {
  const code = (e as { code?: string }).code;
  const frames = [
    ...String((e as Error).stack ?? '').matchAll(
      /shipment-label-cache-native-readback\.ts:(\d+):\d+/g,
    ),
  ].map((m) => Number(m[1]));
  console.error(
    JSON.stringify({
      status: 'READBACK_FAIL',
      step,
      code: typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'ASSERTION',
      source_frames: [...new Set(frames)],
    }),
  );
  process.exitCode = 1;
});
