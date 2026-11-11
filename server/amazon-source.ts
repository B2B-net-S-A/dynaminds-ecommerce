import { amazonAccountPolicy } from './amazon-account';
import { randomUUID } from 'node:crypto';
import { ensure } from './errors';
import { audit, type Actor } from './domain';
import { tenantTx } from './db';
import { channelRead, type IntegrationContext } from './channel-access';
import { guardCatalogSource, catalogConnectionMatches } from './catalog-source';
import { Amazon, amazonSettings } from './amazon';
import {
  amazonCatalogHash,
  createAmazonCatalogReport,
  amazonCatalogReport,
  downloadAmazonCatalog,
  readAmazonCatalogBatch,
  normalizeAmazonCatalog,
} from './amazon-catalog';
import type { PoolClient } from 'pg';
import { demoAmazonCatalog } from './amazon-example';

export async function processAmazonCatalog(
  job: any,
  actor: Actor,
  run: any,
  ch: any,
  ctx: IntegrationContext,
) {
  const settings = amazonSettings.parse({
    ...ch.settings,
    ...(ch.settings.simulation
      ? { selling_partner_id: ch.settings.selling_partner_id || 'DEMO074' }
      : {}),
  });
  const validate = (current: any) =>
    ensure(
      current?.provider === 'amazon' && catalogConnectionMatches(current, run),
      409,
      'Połączenie Amazon zmieniono; rozpocznij nowy przegląd',
    );
  validate(ch);
  ensure(
    settings.selling_partner_id && !run.import_stock,
    422,
    'Katalog Amazon wymaga identyfikatora sprzedawcy i importu bez stanów fizycznych',
  );
  const authorize = async (c: PoolClient, current: any) => {
    ensure(
      (await c.query('SELECT offer_sync_is_admin($1) ok', [current.actor_id])).rows[0]?.ok,
      403,
      'Administrator utracił prawo importu katalogu',
    );
    const channel = (
      await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [current.channel_id])
    ).rows[0];
    validate(channel);
    await amazonAccountPolicy(c, channel);
  };
  const fence = async () =>
    ensure(
      await guardCatalogSource(job, authorize, true),
      409,
      'Import zatrzymano lub dzierżawa wygasła',
    );
  const read = <T>(fn: (client: Amazon) => Promise<T>) =>
    channelRead(
      job.tenant_id,
      ch.id,
      async (client) => {
        ensure(client instanceof Amazon, 422, 'Wymagane połączenie Amazon');
        return fn(client);
      },
      ctx,
      true,
      async (current) => {
        validate(current);
        await fence();
      },
    );
  const cursor = run.cursor;
  ensure(
    ['amazon', 'amazon.report', 'amazon.document', 'amazon.enrich'].includes(cursor.phase),
    422,
    'Nieprawidłowy checkpoint katalogu Amazon',
  );
  ensure(
    Date.now() - new Date(run.created_at).getTime() < 24 * 3600000,
    409,
    'Przegląd Amazon ma ponad 24 godziny; rozpocznij nowy import',
  );
  const context = {
    marketplace_id: settings.marketplace_id,
    selling_partner_id: settings.selling_partner_id,
    prices_include_tax: true,
    currency: null,
    stock_scope: 'external_availability',
  };
  const finish = async (next: any, done = false, wait = 1) => {
    ensure(
      await guardCatalogSource(job, async (c, current) => {
        await authorize(c, current);
        await c.query(
          "UPDATE catalog_source_runs SET context=$2,cursor=$3,state=$4,error=NULL,updated_at=now(),finished_at=CASE WHEN $4='ready' THEN now() ELSE NULL END WHERE id=$1",
          [run.id, JSON.stringify(context), JSON.stringify(next), done ? 'ready' : 'queued'],
        );
        await c.query(
          'UPDATE jobs SET state=$2,attempts=0,lease_token=NULL,locked_at=NULL,error=NULL,run_at=now()+make_interval(secs=>$3) WHERE id=$1',
          [job.id, done ? 'done' : 'pending', wait],
        );
        if (done)
          await audit(c, actor, 'catalog.source.ready', run.id, {
            provider: 'amazon',
            channel_id: ch.id,
            report_skus: next.manifest_total,
            stock_scope: 'external_availability',
          });
      }),
      409,
      'Import zatrzymano lub dzierżawa wygasła',
    );
  };
  if (ch.settings.simulation) {
    ensure(cursor.phase === 'amazon', 422, 'Nieprawidłowy checkpoint przykładu Amazon');
    const rows = demoAmazonCatalog().map((raw) => normalizeAmazonCatalog(raw, { ...run, context }));
    ensure(
      await guardCatalogSource(job, async (c, current) => {
        await authorize(c, current);
        for (const row of rows)
          await c.query(
            'INSERT INTO catalog_source_items(id,tenant_id,run_id,external_id,parent_external_id,kind,source,source_hash,issues) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,run_id,external_id) DO NOTHING',
            [
              randomUUID(),
              job.tenant_id,
              run.id,
              row.external_id,
              row.parent_external_id,
              row.kind,
              JSON.stringify(row.source),
              row.source_hash,
              JSON.stringify(row.issues),
            ],
          );
        await c.query('UPDATE catalog_source_runs SET fetched=$2 WHERE id=$1', [
          run.id,
          rows.length,
        ]);
      }),
      409,
      'Import zatrzymano lub dzierżawa wygasła',
    );
    return finish(
      {
        ...cursor,
        manifest_total: rows.length,
        completed_at: new Date().toISOString(),
        scope: 'local_simulation',
      },
      true,
    );
  }
  if (cursor.phase === 'amazon') {
    const report = await read((client) => createAmazonCatalogReport(client, fence));
    return finish(
      {
        ...cursor,
        phase: 'amazon.report',
        report_id: report,
        requested_at: new Date().toISOString(),
      },
      false,
      30,
    );
  }
  if (cursor.phase === 'amazon.report') {
    ensure(
      Date.now() - Date.parse(cursor.requested_at) < 2 * 3600000,
      422,
      'Amazon nie wygenerował raportu w ciągu dwóch godzin',
    );
    const doc = await read((client) => amazonCatalogReport(client, cursor.report_id, fence));
    return finish(
      doc ? { ...cursor, phase: 'amazon.document', document_id: doc, manifest_offset: 0 } : cursor,
      false,
      doc ? 1 : 30,
    );
  }
  if (cursor.phase === 'amazon.document') {
    const skus = await read((client) => downloadAmazonCatalog(client, cursor.document_id, fence));
    const hash = amazonCatalogHash(skus);
    ensure(
      !cursor.manifest_hash || cursor.manifest_hash === hash,
      409,
      'Zawartość raportu Amazon zmieniła się podczas pobierania',
    );
    ensure(
      Number.isSafeInteger(cursor.manifest_offset) &&
        cursor.manifest_offset >= 0 &&
        cursor.manifest_offset <= skus.length,
      422,
      'Nieprawidłowy postęp raportu Amazon',
    );
    for (let offset = cursor.manifest_offset; offset < skus.length; offset += 1000) {
      const slice = skus.slice(offset, offset + 1000).map((sku) => ({
        id: randomUUID(),
        sku,
        source: { amazon_pending: true, source_sku: sku },
        hash: amazonCatalogHash(sku),
      }));
      ensure(
        await guardCatalogSource(
          job,
          async (c, current) => {
            await authorize(c, current);
            await c.query(
              `INSERT INTO catalog_source_items(id,tenant_id,run_id,external_id,kind,source,source_hash)
          SELECT x.id,$1,$2,x.sku,'unsupported',x.source,x.hash FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,sku text,source jsonb,hash text)
          ON CONFLICT(tenant_id,run_id,external_id) DO NOTHING`,
              [job.tenant_id, run.id, JSON.stringify(slice)],
            );
            await c.query(
              'UPDATE catalog_source_runs SET cursor=$2,fetched=$3,updated_at=now() WHERE id=$1',
              [
                run.id,
                JSON.stringify({
                  ...cursor,
                  manifest_hash: hash,
                  manifest_total: skus.length,
                  manifest_offset: Math.min(offset + 1000, skus.length),
                }),
                Math.min(offset + 1000, skus.length),
              ],
            );
          },
          true,
        ),
        409,
        'Import zatrzymano lub dzierżawa wygasła',
      );
    }
    return finish({
      ...cursor,
      phase: 'amazon.enrich',
      manifest_hash: hash,
      manifest_total: skus.length,
      manifest_offset: skus.length,
      batches: 0,
    });
  }
  // Indexed pending queue rather than an unbounded SKU array in job/cursor JSON.
  const pending = await tenantTx(job.tenant_id, async (c) =>
    (
      await c.query(
        "SELECT external_id FROM catalog_source_items WHERE run_id=$1 AND source->>'amazon_pending'='true' ORDER BY external_id LIMIT 20",
        [run.id],
      )
    ).rows.map((r) => r.external_id as string),
  );
  if (pending.length) {
    const skus = pending[0].includes(',') ? [pending[0]] : pending.filter((s) => !s.includes(','));
    const raw = await read((client) => readAmazonCatalogBatch(client, skus, fence));
    const rows = raw.map((item) => normalizeAmazonCatalog(item, { ...run, context }));
    ensure(
      await guardCatalogSource(job, async (c, current) => {
        await authorize(c, current);
        let inserted = 0;
        for (const row of rows) {
          await c.query(
            "UPDATE catalog_source_items SET parent_external_id=$3,kind=$4,source=$5,source_hash=$6,issues=$7,captured_at=now() WHERE run_id=$1 AND external_id=$2 AND source->>'amazon_pending'='true'",
            [
              run.id,
              row.external_id,
              row.parent_external_id,
              row.kind,
              JSON.stringify(row.source),
              row.source_hash,
              JSON.stringify(row.issues),
            ],
          );
          // A parent may be absent from the report. Fetch it before accepting a variant.
          for (const related of [...row.source.amazon.parents, ...row.source.amazon.children])
            inserted +=
              (
                await c.query(
                  "INSERT INTO catalog_source_items(id,tenant_id,run_id,external_id,kind,source,source_hash) VALUES($1,$2,$3,$4,'unsupported',$5,$6) ON CONFLICT(tenant_id,run_id,external_id) DO NOTHING",
                  [
                    randomUUID(),
                    job.tenant_id,
                    run.id,
                    related,
                    JSON.stringify({ amazon_pending: true, source_sku: related }),
                    amazonCatalogHash(related),
                  ],
                )
              ).rowCount ?? 0;
        }
        await c.query(
          'UPDATE catalog_source_runs SET context=$2,cursor=$3,fetched=fetched+$4,updated_at=now() WHERE id=$1',
          [
            run.id,
            JSON.stringify(context),
            JSON.stringify({ ...cursor, batches: (cursor.batches ?? 0) + 1 }),
            inserted,
          ],
        );
      }),
      409,
      'Import zatrzymano lub dzierżawa wygasła',
    );
    return finish({ ...cursor, batches: (cursor.batches ?? 0) + 1 });
  }
  // Check every edge in PostgreSQL, without loading the full catalog into process memory.
  await guardCatalogSource(job, async (c, current) => {
    await authorize(c, current);
    const invalid = await c.query(
      `SELECT child.external_id FROM catalog_source_items child
      LEFT JOIN catalog_source_items parent ON parent.tenant_id=child.tenant_id AND parent.run_id=child.run_id AND parent.external_id=child.parent_external_id
      WHERE child.run_id=$1 AND child.kind='variant' AND (parent.id IS NULL OR parent.kind<>'group' OR NOT (parent.source->'amazon'->'children' ? child.external_id)) LIMIT 1`,
      [run.id],
    );
    ensure(!invalid.rowCount, 409, 'Niepełna lub niespójna rodzina wariantów Amazon');
    const missing = await c.query(
      `SELECT p.external_id FROM catalog_source_items p CROSS JOIN LATERAL jsonb_array_elements_text(p.source->'amazon'->'children') v(sku)
      LEFT JOIN catalog_source_items child ON child.tenant_id=p.tenant_id AND child.run_id=p.run_id AND child.external_id=v.sku
      WHERE p.run_id=$1 AND p.kind='group' AND (child.id IS NULL OR child.kind<>'variant' OR child.parent_external_id<>p.external_id) LIMIT 1`,
      [run.id],
    );
    ensure(!missing.rowCount, 409, 'Raport Amazon nie zawiera całej rodziny wariantów');
  });
  return finish({ ...cursor, completed_at: new Date().toISOString() }, true);
}
