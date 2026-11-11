import { randomUUID } from 'node:crypto';
import { ensure } from './errors';
import { audit, type Actor } from './domain';
import { channelRead, type IntegrationContext } from './channel-access';
import { guardCatalogSource, catalogConnectionMatches } from './catalog-source';
import { Ebay, ebaySettings } from './ebay';
import { readEbayCatalogPage, normalizeEbayCatalog } from './ebay-inventory';
import { demoEbayCatalog } from './ebay-example';
export async function processEbayCatalog(
  job: any,
  actor: Actor,
  run: any,
  ch: any,
  ctx: IntegrationContext,
) {
  const validate = (current: any) =>
    ensure(
      current?.provider === 'ebay' && catalogConnectionMatches(current, run),
      409,
      'Połączenie eBay zmieniono; rozpocznij nowy przegląd',
    );
  validate(ch);
  const fence = async () =>
    ensure(
      await guardCatalogSource(
        job,
        async (c, current) => {
          ensure(
            (await c.query('SELECT offer_sync_is_admin($1) AS ok', [current.actor_id])).rows[0]?.ok,
            403,
            'Administrator utracił prawo importu katalogu',
          );
          validate(
            (await c.query('SELECT * FROM channels WHERE id=$1', [current.channel_id])).rows[0],
          );
        },
        true,
      ),
      409,
      'Import zatrzymano lub dzierżawa wygasła',
    );
  const cursor = run.cursor,
    settings = ebaySettings.parse(ch.settings);
  ensure(
    cursor.phase === 'ebay' &&
      Number.isInteger(cursor.pages) &&
      cursor.pages < 50000 &&
      Number.isSafeInteger(cursor.after) &&
      cursor.after >= 0 &&
      cursor.after <= 1000000,
    422,
    'Nieprawidłowy checkpoint katalogu eBay',
  );
  const context = run.context ?? {
    currency: null,
    prices_include_tax: settings.price_mode === 'gross',
    marketplace_id: settings.marketplace_id,
    stock_scope: 'external_availability',
  };
  await fence();
  const response = ch.settings.simulation
    ? { rows: cursor.after ? [] : demoEbayCatalog(), next: null, total: 3 }
    : await channelRead(
        job.tenant_id,
        ch.id,
        async (client) => {
          ensure(client instanceof Ebay, 422, 'Wymagane połączenie eBay');
          return readEbayCatalogPage(client, cursor.after, settings.marketplace_id, fence);
        },
        ctx,
        true,
        async (current) => {
          validate(current);
          await fence();
        },
      );
  ensure(
    cursor.total === undefined || cursor.total === response.total,
    409,
    'Liczba SKU eBay zmieniła się podczas przeglądu; pobierz ponownie',
  );
  const rows = new Map<string, ReturnType<typeof normalizeEbayCatalog>>();
  for (const raw of response.rows) {
    for (const row of raw.group
      ? [
          normalizeEbayCatalog(raw, { ...run, context }, true),
          normalizeEbayCatalog(raw, { ...run, context }),
        ]
      : [normalizeEbayCatalog(raw, { ...run, context })]) {
      const prior = rows.get(row.external_id);
      ensure(
        !prior || (row.kind === 'group' && prior.source_hash === row.source_hash),
        409,
        'Powtórzone SKU lub zmieniona grupa eBay',
      );
      rows.set(row.external_id, row);
    }
  }
  await guardCatalogSource(job, async (c, current) => {
    ensure(
      (await c.query('SELECT offer_sync_is_admin($1) AS ok', [current.actor_id])).rows[0]?.ok,
      403,
      'Administrator utracił prawo importu katalogu',
    );
    validate(
      (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [current.channel_id])).rows[0],
    );
    let inserted = 0;
    for (const row of rows.values()) {
      const prior = (
        await c.query(
          'SELECT kind,source_hash FROM catalog_source_items WHERE run_id=$1 AND external_id=$2',
          [run.id, row.external_id],
        )
      ).rows[0];
      if (prior) {
        ensure(
          row.kind === 'group' && prior.kind === 'group' && prior.source_hash === row.source_hash,
          409,
          'Powtórzone SKU lub zmieniona grupa eBay',
        );
        continue;
      }
      await c.query(
        'INSERT INTO catalog_source_items(id,tenant_id,run_id,external_id,parent_external_id,kind,source,source_hash,issues) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
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
      inserted++;
    }
    const seen = (cursor.seen ?? 0) + response.rows.length,
      done = response.next === null;
    ensure(
      seen <= response.total && (!done || seen === response.total),
      409,
      'Niepełny katalog lub zmiana zbioru SKU eBay',
    );
    await c.query(
      "UPDATE catalog_source_runs SET context=$2,cursor=$3,state=$4,fetched=$5,error=NULL,updated_at=now(),finished_at=CASE WHEN $4='ready' THEN now() ELSE NULL END WHERE id=$1",
      [
        run.id,
        JSON.stringify(context),
        JSON.stringify({
          ...cursor,
          after: response.next ?? cursor.after,
          pages: cursor.pages + 1,
          seen,
          total: response.total,
        }),
        done ? 'ready' : 'queued',
        current.fetched + inserted,
      ],
    );
    await c.query(
      "UPDATE jobs SET state=$2,attempts=0,lease_token=NULL,locked_at=NULL,error=NULL,run_at=now()+interval '1 second' WHERE id=$1",
      [job.id, done ? 'done' : 'pending'],
    );
    if (done)
      await audit(c, actor, 'catalog.source.ready', run.id, {
        channel_id: ch.id,
        provider: 'ebay',
        marketplace_id: settings.marketplace_id,
        stock_scope: 'external_availability',
      });
  });
}
