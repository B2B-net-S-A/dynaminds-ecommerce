/** Root-only read-only QA149 native evidence. Exclusive outputs; no baseline replacement. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFArray, PDFRawStream, PDFName } from 'pdf-lib';
import { pool } from '../server/db';
import { decrypt } from '../server/security';
const root = '<workspace>/app';
const docs = '<workspace>/worktrees/stock-file-import/docs';
const hash = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
async function main() {
  const phase = process.argv[2];
  assert(['before-preview', 'after-queue', 'after-files', 'after-restart'].includes(phase));
  assert.equal(process.cwd(), root);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(root, '.local.json'));
  assert.notEqual(process.env.DYNA_TEST, 'true');
  const revision = process.env.QA_EXPECTED_REVISION ?? '';
  assert.match(revision, /^[a-f0-9]{40}$/);
  const statePath = resolve(root, 'data/shipment-label-batch-stage149.json');
  assert.equal((await lstat(statePath)).mode & 0o777, 0o600);
  const s = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(s.stage, 149);
  assert.equal(s.complete, true);
  assert.equal(s.pending, null);
  assert.equal(s.shipments.length, 3);
  assert.equal(s.controlled_transport_callbacks.length, 3);
  const h = await (await fetch('http://127.0.0.1:4100/api/health')).json();
  assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, '132_shipment_label_batches');
  assert.equal(h.mode, 'local');
  assert.equal(h.restore_preview, false);
  assert.equal(h.background_workers_enabled, false);
  assert.equal(h.shipment_label_batches_available, true);
  const u = new URL(pool.options.connectionString!);
  assert.equal(u.hostname, '127.0.0.1');
  assert.equal(u.port, '55432');
  const c = await pool.connect();
  const snapshot: Record<string, { count: number; sha256: string }> = {};
  let batches: any[] = [],
    jobs: any[] = [],
    pageMap: any[] = [],
    graph: any[] = [],
    combinedMeta: any = null;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    assert.equal((await c.query('SELECT current_user role')).rows[0].role, 'postgres');
    const tables = (
      await c.query(
        "SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND (table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND column_name='tenant_id')) ORDER BY table_name",
      )
    ).rows.map((r) => r.table_name);
    for (const name of tables) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      const id = name === 'users' ? s.user_id : s.tenant_id;
      const rows = (
        await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE ${key}=$1 ORDER BY 1`, [id])
      ).rows;
      snapshot[name] = { count: rows.length, sha256: hash(JSON.stringify(rows)) };
    }
    assert.equal(tables.length, 378);
    assert.equal(snapshot.shipment_label_cache_assets.count, 3);
    assert.equal(snapshot.shipment_label_cache_acquisitions.count, 3);
    for (const table of [
      'orders',
      'order_items',
      'shipments',
      'channels',
      'products',
      'product_stock',
      'stock_movements',
      'stock_reservations',
      'documents',
      'packing_stations',
    ]) {
      if (s.setup_checkpoint[table]) {
        const predicate = ['users', 'tenants'].includes(table) ? 'id' : 'tenant_id';
        const rows = (
          await c.query(
            `SELECT coalesce(jsonb_agg(row ORDER BY row::text),'[]'::jsonb) rows FROM (SELECT to_jsonb(t) row FROM "${table}" t WHERE ${predicate}=$1) s`,
            [s.tenant_id],
          )
        ).rows[0].rows;
        assert.equal(
          hash(JSON.stringify(rows)),
          s.setup_checkpoint[table].sha256,
          'Business data changed: ' + table,
        );
      }
    }
    const headers = (
      await c.query(
        'SELECT id,request,scope_hash,payload,combined_content_encrypted FROM shipment_label_batch_previews WHERE tenant_id=$1 ORDER BY created_at,id',
        [s.tenant_id],
      )
    ).rows;
    const executions = (
      await c.query(
        'SELECT id,preview_id,payload,top_xid::text xid FROM shipment_label_batch_executions WHERE tenant_id=$1 ORDER BY created_at,id',
        [s.tenant_id],
      )
    ).rows;
    jobs = (
      await c.query(
        'SELECT id,state,version::text,content_base64,content_sha256,content_bytes FROM print_jobs WHERE tenant_id=$1 ORDER BY id',
        [s.tenant_id],
      )
    ).rows;
    if (phase === 'before-preview') {
      assert.equal(headers.length, 0);
      assert.equal(executions.length, 0);
      assert.equal(jobs.length, 0);
    } else {
      assert.equal(headers.length, 1);
      assert.equal(executions.length, 1);
      assert.equal(jobs.length, 3);
      const p = headers[0],
        e = executions[0];
      assert.equal(e.preview_id, p.id);
      assert.equal(p.payload.rows.length, 3);
      assert.equal(e.payload.rows.length, 3);
      assert.equal(p.payload.summary.orders, 2);
      assert.equal(p.payload.summary.combined_pages, 4);
      const binary = Buffer.from(decrypt(p.combined_content_encrypted).content_base64, 'base64');
      assert.equal(hash(binary), p.payload.combined_pdf.content_sha256);
      assert.equal(binary.length, p.payload.combined_pdf.content_bytes);
      const pdf = await PDFDocument.load(binary, { updateMetadata: false });
      assert.equal(pdf.getPageCount(), 4);
      for (const [i, r] of p.payload.rows.entries()) {
        const requested = p.request.shipments[i],
          source = s.shipments.find((v: any) => v.id === r.shipment_id),
          b = s.controlled_pdfs.find((v: any) => v.shipment_id === r.shipment_id);
        assert(source && b);
        assert.equal(requested.shipment_id, r.shipment_id);
        assert.equal(requested.asset_id, r.cache_asset_id);
        assert.equal(r.cache_asset_id, source.asset_id);
        assert.equal(r.content_sha256, b.content_sha256);
        assert.equal(r.pages, b.pages);
        const er = e.payload.rows[i],
          job = jobs.find((v) => v.id === er.job_id);
        assert(job);
        assert.equal(job.content_base64, b.content_base64);
        assert.equal(job.content_sha256, b.content_sha256);
        assert.equal(job.content_bytes, b.content_bytes);
        assert.equal(job.state, phase === 'after-queue' ? 'queued' : 'file_saved');
        assert.equal(job.version, phase === 'after-queue' ? '1' : '3');
        for (let j = 0; j < r.pages; j++) {
          const page = pdf.getPage(r.page_from - 1 + j);
          assert.deepEqual(page.getMediaBox(), { x: 0, y: 0, width: 297.64, height: 419.53 });
          const value = page.node.Contents(),
            objects =
              value instanceof PDFArray
                ? value.asArray().map((ref) => pdf.context.lookup(ref))
                : [value];
          const text = objects
            .map((v) => {
              assert(v instanceof PDFRawStream);
              const bytes = Buffer.from(v.getContents());
              return v.dict.get(PDFName.of('Filter'))?.toString() === '/FlateDecode'
                ? inflateSync(bytes).toString('latin1')
                : bytes.toString('latin1');
            })
            .join('\n');
          const marker = 'QA149 SOURCE ' + (source.index + 1) + ' PAGE ' + (j + 1) + '/' + r.pages;
          assert(text.includes(Buffer.from(marker).toString('hex').toUpperCase()));
          pageMap.push({ page: r.page_from + j, shipment_id: r.shipment_id, marker });
        }
      }
      graph = (
        await c.query(
          'SELECT r.index,r.child_preview_id,r.job_id,r.job_create_event_id,l.top_xid::text child_xid,ev.top_xid::text event_xid,e.top_xid::text parent_xid FROM shipment_label_batch_execution_rows r JOIN shipment_label_batch_executions e ON(e.tenant_id,e.id)=(r.tenant_id,r.execution_id) JOIN print_job_label_sources l ON(l.tenant_id,l.job_id)=(r.tenant_id,r.job_id) JOIN print_job_events ev ON(ev.tenant_id,ev.id)=(r.tenant_id,r.job_create_event_id) WHERE r.tenant_id=$1 ORDER BY r.index',
          [s.tenant_id],
        )
      ).rows;
      assert.equal(graph.length, 3);
      assert(
        graph.every(
          (v) =>
            v.child_xid === v.parent_xid && v.event_xid === v.parent_xid && v.parent_xid === e.xid,
        ),
      );
      assert.equal(snapshot.shipment_label_batch_admissions.count, 2);
      assert.equal(snapshot.shipment_label_batch_preview_rows.count, 3);
      assert.equal(snapshot.shipment_label_batch_execution_rows.count, 3);
      assert.equal(snapshot.print_job_label_sources.count, 3);
      assert.equal(snapshot.print_job_events.count, phase === 'after-queue' ? 4 : 10);
      batches = [
        {
          preview_id: p.id,
          scope_hash: p.scope_hash,
          execution_id: e.id,
          summary: p.payload.summary,
        },
      ];
      combinedMeta = p.payload.combined_pdf;
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  jobs = jobs.map(({ content_base64, ...v }) => v);
  const report = {
    stage: 149,
    status: 'NATIVE_READBACK_PASS',
    phase,
    revision,
    tenant_id: s.tenant_id,
    schema_revision: h.schema_revision,
    snapshot,
    batches,
    jobs,
    page_map: pageMap,
    combined_pdf: combinedMeta,
    transaction_graph: graph,
    original_job_bytes_exact: phase === 'before-preview' ? null : true,
    provider_verified: false,
    physical_print_verified: false,
    full_goal_complete: false,
  };
  await writeFile(
    resolve(docs, 'shipment-label-batch-native-' + phase + '.json'),
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      status: report.status,
      phase,
      tables: Object.keys(snapshot).length,
      jobs: jobs.length,
      batches: batches.length,
      pages: pageMap.length,
    }),
  );
}
main()
  .catch(() => {
    console.error('QA149_READBACK_FAILED_NO_PRIVATE_OUTPUT');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
