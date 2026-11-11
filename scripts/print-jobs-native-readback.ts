/** Read-only manual acceptance of the owned QA145 fixture. No business retries. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = '<workspace>/app';
assert.equal(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? ''), resolve(root, '.local.json'));
const phase = process.argv[2];
assert(['before', 'after-queued', 'after-files', 'after-denied', 'after-restart', 'after-openapi-fix'].includes(phase));
const raw = await readFile(resolve(root, 'data/print-jobs-stage145.json'));
const setup = JSON.parse(raw.toString());
assert.equal(setup.stage, 145); assert.equal(setup.complete, true); assert.equal(setup.pending, null);
const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const hash = (v: unknown) => digest(JSON.stringify(v));
const privatePath = (p: string) => resolve(root, `data/print-jobs-stage145-${p}.json`);
const reportPath = resolve(root, `docs/print-jobs-native-${phase}.json`);
for (const path of [privatePath(phase), reportPath]) {
  try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
  throw Error('QA145 phase already exists; never overwrite or resume');
}
const previous = ({ 'after-queued': 'before', 'after-files': 'after-queued', 'after-denied': 'after-files', 'after-restart': 'after-denied', 'after-openapi-fix': 'after-restart' } as Record<string, string>)[phase];
const prior = previous ? JSON.parse(await readFile(privatePath(previous), 'utf8')) : null;
if (prior) assert.equal(prior.setup_sha256, digest(raw));
const get = async (path: string, auth = true) => {
  const r = await fetch('http://127.0.0.1:4100/api' + path, { redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: auth ? { cookie: setup.cookie, 'X-Workspace-ID': setup.tenant_id } : {} });
  assert.equal(r.status, 200, 'QA145 owned GET ' + path); return r.json() as Promise<any>;
};
const health = await get('/health', false);
assert.equal(health.revision, process.env.QA_EXPECTED_REVISION);
assert.equal(health.schema_revision, '129_print_jobs'); assert.equal(health.print_jobs_available, true);
assert.equal(health.background_workers_enabled, false); assert.equal(health.restore_preview, false);
const { pool } = await import('../server/db');
try {
  const snapshot = async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TimeZone='UTC'");
      const db = (await c.query("SELECT current_database() db,current_user actor,inet_server_port() port,current_setting('transaction_read_only') ro")).rows[0];
      assert.equal(db.db, 'dynaminds'); assert.equal(db.actor, 'postgres'); assert.equal(db.port, 55432); assert.equal(db.ro, 'on');
      const names = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id') ORDER BY table_name")).rows;
      const rows: Record<string, any[]> = {};
      for (const { table_name: name } of names) {
        assert(/^[a-z_][a-z0-9_]*$/.test(name));
        rows[name] = (await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE tenant_id=$1 ORDER BY 1`, [setup.tenant_id])).rows.map(r => r.row);
      }
      await c.query('COMMIT'); return rows;
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  };
  const rows = await snapshot();
  if (prior) {
    if (['after-denied', 'after-restart', 'after-openapi-fix'].includes(phase)) assert.deepEqual(rows, prior.rows, 'Denied requests/restart changed owned rows');
    else for (const table of Object.keys(rows)) {
      if (!['print_printers', 'print_jobs', 'print_job_events', 'audit_events'].includes(table))
        assert.deepEqual(rows[table], prior.rows[table], 'Printing changed ' + table);
    }
  }
  const options = await get('/print-jobs/options');
  assert.equal(options.can_manage, true); assert.equal(options.can_write, true); assert.equal(options.read_only, false);
  const page = await get('/print-jobs/jobs');
  assert.equal(page.next_cursor, null); assert.equal(page.jobs.length, rows.print_jobs.length);
  const details = await Promise.all(page.jobs.map((j: any) => get('/print-jobs/jobs/' + j.id)));
  const forbidden = new Set(['lease_token', 'lease_hash', 'content_base64', 'request_hash', 'claim_actor_id', 'claim_api_key_id']);
  const publicFields = (v: any) => { if (!v || typeof v !== 'object') return; for (const [k, x] of Object.entries(v)) { assert(!forbidden.has(k), 'Private custody leaked'); publicFields(x); } };
  publicFields(page); publicFields(details);
  const order = await get('/orders/' + setup.orders[0].id);
  for (const k of ['status', 'total', 'currency', 'shipping_cost', 'payment_mode', 'items', 'payment', 'documents', 'version'])
    assert.deepEqual(order[k], setup.born.orders[0][k], 'Printing changed order ' + k);
  assert.deepEqual((await get('/products/' + setup.product.id)).stock, setup.born.stock);
  const files: any[] = [];
  if (phase === 'before') {
    for (const table of ['print_printers', 'print_jobs', 'print_job_events']) assert.equal(rows[table].length, 0);
  } else {
    assert.equal(rows.print_printers.length, 2); assert.equal(rows.print_jobs.length, 2);
    assert.deepEqual(rows.print_jobs.map(j => j.format).sort(), ['pdf', 'zpl']);
    const saved = phase !== 'after-queued';
    assert.equal(rows.print_job_events.length, saved ? 8 : 4);
    for (const j of rows.print_jobs) {
      assert.equal(j.order_id, order.id); assert.equal(j.station_id, setup.station.id);
      assert.equal(j.source_kind, 'manual'); assert.equal(j.copies, 1);
      assert.equal(j.state, saved ? 'file_saved' : 'queued'); assert.equal(j.version, saved ? 3 : 1);
      const source = await readFile(resolve(root, `docs/qa145-manual-label.${j.format}`));
      assert.equal(j.content_base64, source.toString('base64')); assert.equal(j.content_sha256, digest(source)); assert.equal(j.content_bytes, source.length);
      const events = rows.print_job_events.filter(e => e.job_id === j.id).sort((a, b) => a.version_after - b.version_after);
      assert.deepEqual(events.map(e => e.operation), saved ? ['job_create', 'claim', 'ack'] : ['job_create']);
      assert.deepEqual(events.map(e => e.version_after), saved ? [1, 2, 3] : [1]);
      const apiHead = Object.fromEntries(Object.entries(details.find(d => d.job.id === j.id).job).filter(([k]) => !['can_claim','can_reconcile'].includes(k)));
      const receiptHead = { ...events.at(-1).result.job };
      for (const k of ['created_at', 'updated_at', 'lease_expires_at']) if (receiptHead[k]) receiptHead[k] = new Date(receiptHead[k]).toISOString();
      assert.deepEqual(receiptHead, apiHead, 'API head differs from immutable receipt');
      if (saved) {
        const dir = resolve(root, 'data/print-bridge', setup.tenant_id, j.printer_id);
        const journal = JSON.parse(await readFile(resolve(dir, 'current.json'), 'utf8'));
        assert.equal(journal.state, 'complete'); assert.equal(journal.job_id, j.id); assert.equal(journal.ack.result, 'file_saved');
        const name = `${j.id}-${j.content_sha256}.${j.format}`;
        assert.equal(journal.ack.artifact_name, name);
        const stat = await lstat(resolve(dir, name)); assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.nlink, 1); assert(!stat.isSymbolicLink());
        const output = await readFile(resolve(dir, name)); assert.deepEqual(output, source);
        files.push({ job_id: j.id, format: j.format, content_bytes: output.length, sha256: digest(output), mode: '0600', identical_to_manual_demo: true });
      }
    }
  }
  assert.deepEqual(await snapshot(), rows, 'GET reads changed tenant data');
  const full = { stage: 145, phase, setup_sha256: digest(raw), rows };
  await writeFile(privatePath(phase), JSON.stringify(full), { flag: 'wx', mode: 0o600 });
  const summary = { stage: 145, phase, status: 'OWNED_LOCAL_READBACK_PASS_LIMITED', runtime_revision: health.revision,
    schema_revision: health.schema_revision, tenant_id: setup.tenant_id, tenant_tables: Object.keys(rows).length,
    rows_sha256: hash(rows), protected_rows_unchanged: !!prior, gets_changed_no_rows: true,
    printers: rows.print_printers.length, jobs: page.jobs, event_count: rows.print_job_events.length,
    files, physical_paper_verified: false, manual_inputs_not_provider_labels: true,
    open: ['API-key execution', 'CUPS/device output', 'lost-ACK/crash recovery', 'concurrency/late IAM', 'restore', 'provider labels', 'capacity'] };
  await writeFile(reportPath, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ phase, status: summary.status, tables: summary.tenant_tables, printers: summary.printers, jobs: page.jobs.length, events: summary.event_count, files: files.length, rows_sha256: summary.rows_sha256 }));
} finally { await pool.end(); }
