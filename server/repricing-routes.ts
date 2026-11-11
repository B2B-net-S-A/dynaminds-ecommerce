import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { tenantTx } from './db';
import { audit } from './domain';
import { ensure } from './errors';
import { assertProductsNotDeletedInTx, productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
import { invalidateRepricingSchedule } from './repricing-schedules';
import { competitorObservationRequestActor, enlistCompetitorObservationAuthorityInTx } from './competitor-observations';
import {
  repricingRuleInput,
  repricingInputsInput,
  repricingPreviewInput,
  repricingApplyInput,
  repricingRows,
  applyRepricingPrices,
  assertRepricingBaseInTx,
} from './repricing';
import { historyAfter, historyCursor } from './repricing-rules';
import { registerRepricingOverrideRoutes } from './repricing-overrides';
import { channelSummaries } from './repricing-channel';

/** History filters (REPRICE-006). Cursor: created_at (µs, UTC) and id of the last row. */
export const repricingHistoryQuery = z.object({
  after: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  state: z.enum(['preview', 'applied', 'expired']).optional(),
  sku: z.string().trim().min(1).max(120).optional(),
  strategy: z.enum(['cost_margin', 'competitor', 'competitor_rank']).optional(),
  source: z.enum(['manual', 'schedule']).optional(),
});
/** Structural rule fields (base list chain and cost currency) belong to an administrator. */
const STRUCTURAL = ['base_price_list_id', 'cost_currency', 'max_rate_age_days'] as const;

export function registerRepricingRoutes(app: FastifyInstance, options: { sessionName: string; readOnly: boolean } = { sessionName: 'dyna_session', readOnly: false }) {
  const rankAuthority = async (c: any, req: any, rule: any, preview?: any, intent: 'read' | 'write' = 'write') => {
    if (rule?.config?.strategy === 'competitor_rank' || preview?.result?.some((r: any) => r.rank_basis)) {
      if (intent === 'write') ensure(!options.readOnly, 423, 'Kopia tylko do odczytu');
      await enlistCompetitorObservationAuthorityInTx(c, competitorObservationRequestActor(req, options.sessionName), intent);
    }
  };
  registerRepricingOverrideRoutes(app, { readOnly: options.readOnly });
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const write = (req: any) =>
    ensure(req.actor.role !== 'viewer', 403, 'Konto ma uprawnienia tylko do odczytu');
  const page = z.object({
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  });
  const listLock = async (c: any, listId: string) => {
    await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('catalog:'||current_setting('app.tenant_id'),0))");
    const list = (await c.query('SELECT * FROM price_lists WHERE id=$1 FOR UPDATE', [listId]))
      .rows[0];
    ensure(list, 404, 'Nie znaleziono cennika');
    return list;
  };
  const ruleLock = async (c: any, listId: string) => {
    const rule = (
      await c.query('SELECT * FROM repricing_rules WHERE price_list_id=$1 FOR UPDATE', [listId])
    ).rows[0];
    ensure(rule, 404, 'Nie skonfigurowano repricingu');
    return rule;
  };
  app.get('/api/price-lists/:id/repricing', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const list = (await c.query('SELECT * FROM price_lists WHERE id=$1', [id(req.params)]))
        .rows[0];
      ensure(list, 404, 'Nie znaleziono cennika');
      return {
        list,
        rule:
          (await c.query('SELECT * FROM repricing_rules WHERE price_list_id=$1', [list.id]))
            .rows[0] ?? null,
      };
    }),
  );
  app.put('/api/price-lists/:id/repricing', (req) => {
    write(req);
    const b = repricingRuleInput.parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const list = await listLock(c, id(req.params));
      const old = (
        await c.query('SELECT * FROM repricing_rules WHERE price_list_id=$1 FOR UPDATE', [list.id])
      ).rows[0];
      await rankAuthority(c, req, b.config.strategy === 'competitor_rank' ? { config: b.config } : old);
      ensure(
        (old?.version ?? 0) === b.version,
        409,
        'Reguła lub jej dane zostały zmienione; odśwież dane',
      );
      const before = old?.config ?? {};
      ensure(
        req.actor.role === 'admin' || STRUCTURAL.every((k) => before[k] === b.config[k]),
        403,
        'Cennik bazowy i walutę kosztu może zmienić tylko administrator',
      );
      await assertRepricingBaseInTx(c, list, b.config);
      const rule = (
        await c.query(
          'INSERT INTO repricing_rules(tenant_id,price_list_id,config) VALUES($1,$2,$3) ON CONFLICT(tenant_id,price_list_id) DO UPDATE SET config=excluded.config,version=repricing_rules.version+1,config_version=repricing_rules.config_version+1,updated_at=now() RETURNING *',
          [req.actor.tenantId, list.id, b.config],
        )
      ).rows[0];
      await invalidateRepricingSchedule(
        c,
        list.id,
        'Reguła repricingu została zmieniona; włącz ponownie harmonogram',
      );
      await audit(c, req.actor, 'repricing.rule', list.id, {
        version: rule.version,
        config: rule.config,
      });
      return rule;
    });
  });
  app.get('/api/price-lists/:id/repricing/inputs', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const listId = id(req.params),
        q = page.parse(req.query);
      const rule = (await c.query('SELECT * FROM repricing_rules WHERE price_list_id=$1', [listId]))
        .rows[0];
      ensure(rule, 404, 'Nie skonfigurowano repricingu');
      const deletions = await productDeletionsAvailable(c);
      const rows = (
        await c.query(
          `SELECT i.*,p.sku,p.name FROM repricing_inputs i JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.product_id) WHERE i.price_list_id=$1 AND ${productNotDeletedSQL(deletions)} AND ($2::uuid IS NULL OR i.product_id>$2) ORDER BY i.product_id LIMIT $3`,
          [listId, q.after ?? null, q.limit + 1],
        )
      ).rows;
      return {
        rule,
        data: rows.slice(0, q.limit),
        meta: { cursor: rows.length > q.limit ? rows[q.limit - 1].product_id : null },
      };
    }),
  );
  app.put('/api/price-lists/:id/repricing/inputs', (req) => {
    write(req);
    const b = repricingInputsInput.parse(req.body);
    ensure(
      new Set(b.items.map((i) => i.product_id)).size === b.items.length,
      422,
      'SKU nie mogą się powtarzać',
    );
    return tenantTx(req.actor.tenantId, async (c) => {
      const list = await listLock(c, id(req.params)),
        rule = await ruleLock(c, list.id);
      await rankAuthority(c, req, rule);
      ensure(
        rule.version === b.version,
        409,
        'Reguła lub jej dane zostały zmienione; odśwież dane',
      );
      const products = (
        await c.query(
          'SELECT id,kind FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
          [b.items.map((i) => i.product_id)],
        )
      ).rows;
      ensure(products.length === b.items.length, 404, 'Nie znaleziono produktu');
      await assertProductsNotDeletedInTx(c, products.map((p) => p.id));
      ensure(
        products.every((p) => p.kind !== 'group'),
        422,
        'Grupa wariantów nie ma ceny sprzedaży',
      );
      const now = Number(
        (await c.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS ms')).rows[0].ms,
      );
      ensure(
        b.items.every((i) => !i.observed_at || new Date(i.observed_at).getTime() <= now),
        422,
        'Obserwacja nie może pochodzić z przyszłości',
      );
      await c.query(
        'INSERT INTO repricing_inputs(tenant_id,price_list_id,product_id,net_cost,competitor_price,observed_at,source) SELECT $1,$2,product_id,net_cost,competitor_price,observed_at,source FROM jsonb_to_recordset($3::jsonb) AS x(product_id uuid,net_cost integer,competitor_price integer,observed_at timestamptz,source text) ON CONFLICT(tenant_id,price_list_id,product_id) DO UPDATE SET net_cost=excluded.net_cost,competitor_price=excluded.competitor_price,observed_at=excluded.observed_at,source=excluded.source,updated_at=now()',
        [req.actor.tenantId, list.id, JSON.stringify(b.items)],
      );
      const next = (
        await c.query(
          'UPDATE repricing_rules SET version=version+1,updated_at=now() WHERE price_list_id=$1 RETURNING *',
          [list.id],
        )
      ).rows[0];
      await audit(c, req.actor, 'repricing.inputs', list.id, {
        count: b.items.length,
        version: next.version,
        items: b.items,
      });
      return next;
    });
  });
  app.post('/api/price-lists/:id/repricing/previews', (req) => {
    write(req);
    const b = repricingPreviewInput.parse(req.body),
      ids = [...b.product_ids].sort();
    ensure(new Set(ids).size === ids.length, 422, 'SKU nie mogą się powtarzać');
    return tenantTx(req.actor.tenantId, async (c) => {
      const list = await listLock(c, id(req.params)),
        rule = await ruleLock(c, list.id);
      const replay = async (row: any) => {
        ensure(
          row.price_list_id === list.id && isDeepStrictEqual(row.product_ids, ids),
          409,
          'Klucz podglądu został użyty z innym zakresem',
        );
        return row;
      };
      const old = (
        await c.query('SELECT * FROM repricing_previews WHERE client_key=$1', [b.client_key])
      ).rows[0];
      await rankAuthority(c, req, rule, old);
      if (old) return replay(old);
      ensure(list.active && rule.config.enabled, 409, 'Cennik lub reguła jest nieaktywna');
      const rows = await repricingRows(c, req.actor.tenantId, list, rule, ids);
      const created = (
        await c.query(
          'INSERT INTO repricing_previews(id,tenant_id,price_list_id,client_key,product_ids,rule_version,list_version,currency,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,client_key) DO NOTHING RETURNING *',
          [
            randomUUID(),
            req.actor.tenantId,
            list.id,
            b.client_key,
            ids,
            rule.version,
            list.version,
            list.currency,
            JSON.stringify(rows),
          ],
        )
      ).rows[0];
      if (!created)
        return replay(
          (await c.query('SELECT * FROM repricing_previews WHERE client_key=$1', [b.client_key]))
            .rows[0],
        );
      await audit(c, req.actor, 'repricing.preview', created.id, {
        price_list_id: list.id,
        count: ids.length,
      });
      return created;
    });
  });
  app.get('/api/price-lists/:id/repricing/previews', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const q = repricingHistoryQuery.parse(req.query),
        listId = id(req.params),
        after = historyAfter(q.after);
      ensure(
        (await c.query('SELECT 1 FROM price_lists WHERE id=$1', [listId])).rowCount,
        404,
        'Nie znaleziono cennika',
      );
      const sku = q.sku === undefined ? null : '%' + q.sku.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
      const rows = (
        await c.query(
          `SELECT p.id,p.state,p.created_at,p.expires_at,p.applied_at,p.rule_version,p.list_version,p.currency,p.schedule_run_id,cardinality(p.product_ids) AS count,
             (p.state='preview' AND p.expires_at<=clock_timestamp()) AS expired,p.result->0->>'strategy' AS strategy,
             (SELECT count(*) FILTER (WHERE e->>'state'='change') FROM jsonb_array_elements(p.result) e)::int AS changed,
             (SELECT count(*) FILTER (WHERE e->>'state'='unchanged') FROM jsonb_array_elements(p.result) e)::int AS unchanged,
             (SELECT count(*) FILTER (WHERE e->>'state'='blocked') FROM jsonb_array_elements(p.result) e)::int AS blocked,
             (SELECT count(*) FILTER (WHERE e->>'state'='override') FROM jsonb_array_elements(p.result) e)::int AS overridden,
             to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
           FROM repricing_previews p WHERE p.price_list_id=$1
             AND ($2::timestamptz IS NULL OR (p.created_at,p.id)<($2::timestamptz,$3::uuid))
             AND ($4::text IS NULL OR CASE $4::text WHEN 'expired' THEN p.state='preview' AND p.expires_at<=clock_timestamp()
               WHEN 'preview' THEN p.state='preview' AND p.expires_at>clock_timestamp() ELSE p.state=$4::text END)
             AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.result) e WHERE e->>'sku' ILIKE $5::text ESCAPE '\\'))
             AND ($6::text IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.result) e WHERE e->>'strategy'=$6::text))
             AND ($7::text IS NULL OR ($7::text='schedule')=(p.schedule_run_id IS NOT NULL))
           ORDER BY p.created_at DESC,p.id DESC LIMIT $8`,
          [listId, after.at, after.id, q.state ?? null, sku, q.strategy ?? null, q.source ?? null, q.limit + 1],
        )
      ).rows;
      const shown = rows.slice(0, q.limit).map(({ cursor_at, ...row }) => row);
      // REPRICE-006: channel result of scheduled batches (migration 247; null when not recorded).
      const channel = await channelSummaries(c, 'preview_id', shown.filter((r) => r.schedule_run_id).map((r) => r.id));
      const data = shown.map((r) => ({ ...r, channel: channel.get(r.id) ?? null }));
      const last = rows.length > q.limit ? rows[q.limit - 1] : null;
      return {
        data,
        meta: { cursor: last ? historyCursor(last.cursor_at, last.id) : null },
      };
    }),
  );
  app.get('/api/repricing-previews/:id', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const row = (await c.query('SELECT * FROM repricing_previews WHERE id=$1', [id(req.params)]))
        .rows[0];
      ensure(row, 404, 'Nie znaleziono podglądu');
      await rankAuthority(c, req, null, row, 'read');
      return row;
    }),
  );
  app.post('/api/repricing-previews/:id/apply', (req) => {
    write(req);
    repricingApplyInput.parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const ref = (
        await c.query('SELECT price_list_id FROM repricing_previews WHERE id=$1', [id(req.params)])
      ).rows[0];
      ensure(ref, 404, 'Nie znaleziono podglądu');
      const list = await listLock(c, ref.price_list_id),
        rule = await ruleLock(c, list.id);
      const row = (
        await c.query(
          'SELECT *,expires_at>clock_timestamp() AS fresh FROM repricing_previews WHERE id=$1 FOR UPDATE',
          [id(req.params)],
        )
      ).rows[0];
      await rankAuthority(c, req, rule, row);
      if (row.state === 'applied') {
        delete row.fresh;
        return row;
      }
      ensure(row.fresh, 409, 'Podgląd wygasł; utwórz nowy');
      ensure(list.active && rule.config.enabled, 409, 'Cennik lub reguła jest nieaktywna');
      ensure(
        row.rule_version === rule.version && row.list_version === list.version,
        409,
        'Reguła, dane wejściowe lub cennik zmieniły się; utwórz nowy podgląd',
      );
      const current = await repricingRows(c, req.actor.tenantId, list, rule, row.product_ids);
      ensure(
        isDeepStrictEqual(current, row.result),
        409,
        'Produkt lub ważność obserwacji zmieniły się; utwórz nowy podgląd',
      );
      ensure(
        current.every((i) => i.state !== 'blocked'),
        409,
        'Podgląd zawiera zablokowane SKU; popraw dane i utwórz nowy',
      );
      const change = await applyRepricingPrices(c, req.actor.tenantId, list, current);
      const applied = (
        await c.query(
          "UPDATE repricing_previews SET state='applied',applied_at=now(),applied_list_version=$2 WHERE id=$1 RETURNING *",
          [row.id, change.version],
        )
      ).rows[0];
      await audit(c, req.actor, 'repricing.apply', row.id, {
        price_list_id: list.id,
        changed: change.changed,
        list_version: applied.applied_list_version,
      });
      return applied;
    });
  });
}
