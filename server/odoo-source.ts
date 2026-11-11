import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ensure } from './errors';
import { audit, type Actor } from './domain';
import { channelRead, type IntegrationContext } from './channel-access';
import { guardCatalogSource, catalogConnectionMatches } from './catalog-source';
import { Odoo } from './odoo';
import { demoOdooCatalog, demoOdooContext, normalizeOdooCatalog } from './odoo-catalog';
export async function processOdooCatalog(
  job: any,
  actor: Actor,
  run: any,
  ch: any,
  ctx: IntegrationContext,
) {
  const validate = (current: any) =>
    ensure(
      current?.provider === 'odoo' && catalogConnectionMatches(current, run),
      409,
      'Połączenie Odoo zmieniono; rozpocznij nowy przegląd',
    );
  validate(ch);
  const fence = async () => {
    ensure(
      await guardCatalogSource(
        job,
        async (c, current) => {
          ensure(
            (await c.query('SELECT offer_sync_is_admin($1) AS authorized', [current.actor_id]))
              .rows[0]?.authorized,
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
  };
  const read = <T>(fn: (client: Odoo) => Promise<T>) =>
    channelRead(
      job.tenant_id,
      ch.id,
      async (client) => {
        ensure(client instanceof Odoo, 422, 'Wymagany serwer Odoo');
        return fn(client);
      },
      ctx,
      false,
      validate,
    );
  const cursor = run.cursor;
  ensure(
    cursor.phase === 'odoo' &&
      Number.isInteger(cursor.pages) &&
      cursor.pages < 50000 &&
      Number.isSafeInteger(cursor.after) &&
      cursor.after >= 0,
    422,
    'Przekroczono limit przeglądu Odoo',
  );
  await fence();
  const result = ch.settings.simulation
    ? {
        data: cursor.after ? [] : demoOdooCatalog(),
        context: demoOdooContext,
        has_more: false,
        next_cursor: 102,
      }
    : await read((client) => client.catalogPage(cursor.after, fence));
  const context = run.context ?? result.context;
  ensure(
    isDeepStrictEqual(result.context, context),
    409,
    'Firma, magazyn, jednostka lub waluta Odoo zmieniły się; rozpocznij nowy przegląd',
  );
  const rows = new Map<string, ReturnType<typeof normalizeOdooCatalog>>();
  let last = cursor.after;
  for (const raw of result.data) {
    ensure(Number.isInteger(raw.id) && raw.id > last, 502, 'Brak postępu katalogu Odoo');
    last = raw.id;
    const input = { ...run, context };
    for (const row of raw.template.product_variant_count > 1
      ? [normalizeOdooCatalog(raw, input, true), normalizeOdooCatalog(raw, input)]
      : [normalizeOdooCatalog(raw, input)]) {
      const prior = rows.get(row.external_id);
      ensure(
        !prior || prior.source_hash === row.source_hash,
        409,
        'Szablon Odoo zmienił się podczas pobierania',
      );
      rows.set(row.external_id, row);
    }
  }
  ensure(
    !result.has_more || (result.next_cursor === last && last > cursor.after),
    502,
    'Brak postępu paginacji Odoo',
  );
  if (!result.has_more && !ch.settings.simulation)
    ensure(
      isDeepStrictEqual(await read((client) => client.catalogSettings(fence)), context),
      409,
      'Ustawienia Odoo zmieniły się; rozpocznij nowy przegląd',
    );
  await guardCatalogSource(job, async (c, current) => {
    ensure(
      (await c.query('SELECT offer_sync_is_admin($1) AS authorized', [current.actor_id])).rows[0]
        ?.authorized,
      403,
      'Administrator utracił prawo importu katalogu',
    );
    validate((await c.query('SELECT * FROM channels WHERE id=$1', [current.channel_id])).rows[0]);
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
          'Powtórzone ID lub zmieniony szablon Odoo',
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
    }
    const done = !result.has_more;
    await c.query(
      "UPDATE catalog_source_runs SET context=$2,cursor=$3,state=$4,fetched=(SELECT count(*) FROM catalog_source_items WHERE run_id=$1),error=NULL,updated_at=now(),finished_at=CASE WHEN $4='ready' THEN now() ELSE NULL END WHERE id=$1",
      [
        run.id,
        JSON.stringify(context),
        JSON.stringify({ ...cursor, after: last, pages: cursor.pages + 1 }),
        done ? 'ready' : 'queued',
      ],
    );
    await c.query(
      "UPDATE jobs SET state=$2,attempts=0,lease_token=NULL,locked_at=NULL,error=NULL,run_at=now()+interval '1 second' WHERE id=$1",
      [job.id, done ? 'done' : 'pending'],
    );
    if (done)
      await audit(c, actor, 'catalog.source.ready', run.id, {
        channel_id: ch.id,
        provider: 'odoo',
        stock_scope: 'external_availability',
      });
  });
}
