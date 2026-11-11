import { demoAmazonOrder } from './amazon-example';
import { readAmazonOrders, amazonReadPolicy, commitAmazonOrder } from './amazon-order-sync';
import { demoEbayOrder } from './ebay-example';
import { readEbayOrders, ebayReadPolicy, commitEbayOrder } from './ebay-order-sync';
import { odooId } from './odoo';
import { demoOdooOrder } from './odoo-order-example';
import { readOdooOrders, odooReadPolicy, commitOdooOrder } from './odoo-order-sync';
import { shopifyId } from './shopify';
import {
  readShopifyOrders,
  readShopifyOrder,
  shopifyOrderReadPolicy,
  commitShopifyOrder,
} from './shopify-order-read';
import { demoShopifyOrder } from './shopify-example';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ImportOrderOptions } from './imports';
import { captureMiraklReadActor } from './mirakl-read-routes';
import { importConnectionHash } from './imports';
import { resolveProductSkus } from './product-sku';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { tenantTx, tenantReadTx } from './db';
import { audit } from './domain';
import { ensure } from './errors';
import { connector, Allegro, WooCommerce, PrestaShop, type Transport } from './integrations';
import { decrypt, encrypt } from './security';
import { stageOrders, importOrder, inspectImportOrderRollbackRefusal, acquireOrderFieldObservationAdmissionInTx } from './imports';
import { channelRead, withAllegroRequestContext, enlistAllegroContextInTx, type IntegrationContext } from './channel-access';
import { demoPrestaOrder } from './prestashop-example';

import { demoAllegroOrder } from './allegro-example';

export const demoWooOrder = {
  id: 97001,
  status: 'processing',
  currency: 'PLN',
  date_paid: '2026-10-03T10:00:00',
  payment_method: 'bacs',
  billing: {
    first_name: 'Jan',
    last_name: 'Demo',
    email: 'import@example.test',
    address_1: 'Testowa 1',
    city: 'Warszawa',
    postcode: '00-001',
    country: 'PL',
    phone: '',
  },
  shipping_total: '5.00',
  shipping_tax: '0.00',
  total: '100.01',
  customer_note: 'Lokalny przykład importu — dane syntetyczne',
  line_items: [
    {
      product_id: 701,
      variation_id: 0,
      name: 'Produkt z przykładowego sklepu',
      sku: 'DEMO-IMPORT',
      quantity: 3,
      total: '77.24',
      total_tax: '17.77',
    },
  ],
  fee_lines: [],
};
export const stagedImportQuery=z.object({page:z.coerce.number().int().min(1).max(10000).default(1)});
export const stageOrdersInput=z.object({data:z.array(z.record(z.string(),z.unknown())).min(1).max(50)});
export const importCommitInput=z.object({warehouse_id:z.uuid(),expected_hash:z.string().regex(/^[a-f0-9]{64}$/).optional()});
export const publicImportCommitInput=importCommitInput.required({expected_hash:true});
const genericImportResponseDispositions = new WeakMap<object, {error: object; disposition: NonNullable<ReturnType<typeof inspectImportOrderRollbackRefusal>> & {provider: string}}>();
export function genericImportResponseDisposition(error: unknown, request: object) {
  if (!error || typeof error !== 'object') return undefined;
  const record = genericImportResponseDispositions.get(request);
  return record && record.error === error ? Object.freeze({...record.disposition}) : undefined;
}
/** Preserve middleware-owned identity across the import transaction. No body actor,
 * captured role or API-key session can substitute the runtime's current IAM port. */
export function miraklImportAuthorityForRequest(req: FastifyRequest, context: IntegrationContext): NonNullable<ImportOrderOptions['miraklAuthority']> {
  const actor = captureMiraklReadActor(req, context.sessionName ?? 'dyna_session');
  const authority = context.miraklImportAuthority;
  ensure(authority, 503, 'Mirakl: brak portu aktualnej sesji importu');
  return (c, channelId) => authority(c, actor, channelId);
}
export function registerImportRoutes(app: FastifyInstance, context: IntegrationContext = {}) {
  const idOf = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const admin = (req: any) =>
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
  const channel = async (req: any) => {
    const ch = await tenantTx(
      req.actor.tenantId,
      async (c) =>
        (await c.query('SELECT * FROM channels WHERE id=$1', [idOf(req.params)])).rows[0],
    );
    ensure(ch, 404, 'Nie znaleziono integracji');
    ensure(
      ['woocommerce', 'allegro', 'prestashop', 'shopify', 'odoo', 'ebay', 'amazon', 'mirakl'].includes(
        ch.provider,
      ),
      422,
      'Ten kanał nie obsługuje importów',
    );
    return ch;
  };
  app.post('/api/integrations/amazon-example', async (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [req.actor.tenantId]);
      let ch = (
        await c.query(
          "SELECT * FROM channels WHERE provider='amazon' AND settings->>'simulation'='true' ORDER BY created_at LIMIT 1 FOR UPDATE",
        )
      ).rows[0];
      if (!ch)
        ch = (
          await c.query(
            `INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,'amazon','Amazon — przykład lokalny','sandbox',$3,'{"simulation":true,"region":"eu","marketplace_id":"A1C3SOZRARQ6R3"}','simulation') RETURNING *`,
            [randomUUID(), req.actor.tenantId, encrypt({})],
          )
        ).rows[0];
      return {
        channel_id: ch.id,
        data: await stageOrders(c, req.actor, ch, [demoAmazonOrder()]),
        scope: 'local_simulation',
      };
    });
  });
  app.post('/api/integrations/ebay-example', async (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [req.actor.tenantId]);
      let ch = (
        await c.query(
          "SELECT * FROM channels WHERE provider='ebay' AND settings->>'simulation'='true' ORDER BY created_at LIMIT 1 FOR UPDATE",
        )
      ).rows[0];
      if (!ch)
        ch = (
          await c.query(
            `INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,'ebay','eBay — przykład lokalny','sandbox',$3,'{"simulation":true}','simulation') RETURNING *`,
            [randomUUID(), req.actor.tenantId, encrypt({})],
          )
        ).rows[0];
      return {
        channel_id: ch.id,
        data: await stageOrders(c, req.actor, ch, [demoEbayOrder()]),
        scope: 'local_simulation',
      };
    });
  });
  app.post('/api/integrations/shopify-example', async (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [req.actor.tenantId]);
      let ch = (
        await c.query(
          "SELECT * FROM channels WHERE provider='shopify' AND settings->>'simulation'='true' ORDER BY created_at LIMIT 1 FOR UPDATE",
        )
      ).rows[0];
      if (!ch)
        ch = (
          await c.query(
            "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,'shopify','Shopify — przykład lokalny','sandbox',$3,'{\"simulation\":true}','simulation') RETURNING *",
            [randomUUID(), req.actor.tenantId, encrypt({})],
          )
        ).rows[0];
      return {
        channel_id: ch.id,
        data: await stageOrders(c, req.actor, ch, [demoShopifyOrder]),
        scope: 'local_simulation',
      };
    });
  });
  app.post('/api/integrations/prestashop-example', async (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [req.actor.tenantId]);
      let ch = (
        await c.query(
          "SELECT * FROM channels WHERE provider='prestashop' AND settings->>'simulation'='true' ORDER BY created_at LIMIT 1 FOR UPDATE",
        )
      ).rows[0];
      if (!ch)
        ch = (
          await c.query(
            `INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,'prestashop','PrestaShop — przykład lokalny','sandbox',$3,$4,'simulation') RETURNING *`,
            [
              randomUUID(),
              req.actor.tenantId,
              encrypt({}),
              JSON.stringify({ simulation: true, shop_id: '1', order_state_ids: '2' }),
            ],
          )
        ).rows[0];
      return {
        channel_id: ch.id,
        data: await stageOrders(c, req.actor, ch, [demoPrestaOrder]),
        scope: 'local_simulation',
      };
    });
  });
  app.post('/api/integrations/demo-import', async (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [req.actor.tenantId]);
      let ch = (
        await c.query(
          "SELECT * FROM channels WHERE provider='woocommerce' AND settings->>'simulation'='true' ORDER BY created_at LIMIT 1 FOR UPDATE",
        )
      ).rows[0];
      if (!ch)
        ch = (
          await c.query(
            `INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status)
        VALUES($1,$2,'woocommerce','WooCommerce — przykład lokalny','sandbox',$3,'{"simulation":true}','simulation') RETURNING *`,
            [randomUUID(), req.actor.tenantId, encrypt({})],
          )
        ).rows[0];
      return {
        channel_id: ch.id,
        data: await stageOrders(c, req.actor, ch, [demoWooOrder]),
        scope: 'local_simulation',
      };
    });
  });
  app.post('/api/integrations/allegro-example', async (req) => {
    admin(req);
    return tenantTx(req.actor.tenantId, async (c) => {
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [req.actor.tenantId]);
      let ch = (
        await c.query(
          "SELECT * FROM channels WHERE provider='allegro' AND settings->>'simulation'='true' ORDER BY created_at LIMIT 1 FOR UPDATE",
        )
      ).rows[0];
      if (!ch)
        ch = (
          await c.query(
            `INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status)
        VALUES($1,$2,'allegro','Allegro — przykład lokalny','sandbox',$3,'{"simulation":true}','simulation') RETURNING *`,
            [randomUUID(), req.actor.tenantId, encrypt({})],
          )
        ).rows[0];
      return {
        channel_id: ch.id,
        data: await stageOrders(c, req.actor, ch, [demoAllegroOrder]),
        scope: 'local_simulation',
      };
    });
  });
  app.post('/api/integrations/:id/odoo-order-example', async (req) => {
    admin(req);
    const ch = await channel(req);
    ensure(ch.provider === 'odoo' && ch.settings.simulation, 422, 'Wymagany lokalny przykład Odoo');
    return tenantTx(req.actor.tenantId, async (c) => ({
      data: await stageOrders(c, req.actor, ch, [demoOdooOrder()]),
      scope: 'local_simulation',
    }));
  });
  // Recover one original inbound source even when commit moved it between queue pages.
  app.get('/api/imports/:id', async (req, reply) => {
    admin(req);
    const id = idOf(req.params);
    reply.header('Cache-Control', 'no-store');
    return tenantReadTx(req.actor.tenantId, async (c) => {
      const row = (
        await c.query(
          `SELECT i.id,i.external_id,i.normalized,i.state,i.issues,i.order_id,i.updated_at,
          i.source_hash,i.imported_hash,
          (i.imported_hash IS NOT NULL AND i.source_hash<>i.imported_hash) AS source_changed,
          ch.id AS channel_id,ch.name AS channel_name,ch.provider AS channel_provider,
          ch.mode AS channel_mode,ch.status AS channel_status,
          ch.settings->'simulation' AS channel_simulation
          FROM inbound_orders i JOIN channels ch
          ON (ch.tenant_id,ch.id)=(i.tenant_id,i.channel_id)
          WHERE i.tenant_id=$1 AND i.id=$2 AND ch.tenant_id=$1`,
          [req.actor.tenantId, id],
        )
      ).rows[0];
      ensure(row, 404, 'Nie znaleziono zamówienia do importu');
      ensure(
        ['woocommerce', 'allegro', 'prestashop', 'shopify', 'odoo', 'ebay', 'amazon', 'mirakl'].includes(
          row.channel_provider,
        ),
        422,
        'Ten kanał nie obsługuje importów',
      );
      return {
        channel: {
          id: row.channel_id,
          name: row.channel_name,
          provider: row.channel_provider,
          mode: row.channel_mode,
          status: row.channel_status,
          simulation: Boolean(row.channel_simulation),
        },
        data: {
          id: row.id,
          external_id: row.external_id,
          normalized: row.normalized,
          state: row.state,
          issues: row.issues,
          order_id: row.order_id,
          updated_at: row.updated_at,
          source_hash: row.source_hash,
          imported_hash: row.imported_hash,
          source_changed: row.source_changed,
        },
      };
    });
  });
  app.get('/api/integrations/:id/imports', async (req) => {
    admin(req);
    const ch = await channel(req);
    const q = stagedImportQuery.parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      const data = (
        await c.query(
          `SELECT id,external_id,normalized,state,issues,order_id,updated_at,source_hash,
        (imported_hash IS NOT NULL AND source_hash<>imported_hash) AS source_changed
        FROM inbound_orders WHERE channel_id=$1 ORDER BY updated_at DESC,id LIMIT 51 OFFSET $2`,
          [ch.id, (q.page - 1) * 50],
        )
      ).rows;
      const externalIds = [
        ...new Set<string>(
          data.flatMap((r) => (r.normalized?.items ?? []).map((i: any) => i.external_id)),
        ),
      ];
      return {
        data,
        mappings: (
          await c.query(
            'SELECT l.*,p.sku,p.name FROM listings l JOIN products p ON p.tenant_id=l.tenant_id AND p.id=l.product_id WHERE l.channel_id=$1 AND l.external_id=ANY($2::text[]) ORDER BY l.external_id',
            [ch.id, externalIds],
          )
        ).rows,
        channel: {
          id: ch.id,
          name: ch.name,
          provider: ch.provider,
          simulation: Boolean(ch.settings.simulation),
        },
        page: q.page,
      };
    });
  });
  app.post('/api/integrations/:id/fetch-orders', async (req) => {
    admin(req);
    const ch = await channel(req);
    ensure(ch.provider !== 'mirakl', 422, 'Mirakl: pobierz wskazane okno przez /mirakl/orders-stage');
    const readContext = withAllegroRequestContext(context, req);
    ensure(!ch.settings.simulation, 422, 'To połączenie zawiera wyłącznie lokalny przykład');
    const b = z
      .object({
        page: z.number().int().min(1).max(100000).default(1),
        cursor: z
          .string()
          .min(1)
          .max(ch.provider === 'amazon' ? 65536 : 2048)
          .optional(),
      })
      .parse(req.body ?? {});
    ensure(ch.provider === 'odoo' || b.page <= 20000, 422, 'Przekroczono limit strony');
    ensure(
      ['shopify', 'odoo', 'ebay', 'amazon'].includes(ch.provider) || b.page <= 200,
      422,
      'Przekroczono limit strony',
    );
    ensure(
      !['shopify', 'odoo', 'ebay', 'amazon'].includes(ch.provider) || b.page === 1 || b.cursor,
      422,
      'Kolejna strona tego kanału wymaga cursora',
    );
    const result =
      ch.provider === 'amazon'
        ? await readAmazonOrders(req.actor, ch, b.cursor, context)
        : ch.provider === 'ebay'
          ? await readEbayOrders(req.actor, ch, b.cursor, context)
          : ch.provider === 'odoo'
            ? await readOdooOrders(req.actor, ch, b.cursor, context)
            : ch.provider === 'shopify'
              ? await readShopifyOrders(req.actor, ch, b.cursor, context)
              : await channelRead<{
                  data: any[];
                  has_more: boolean;
                  next_cursor?: string | null;
                }>(
                  req.actor.tenantId,
                  ch.id,
                  (client) =>
                    client instanceof WooCommerce || client instanceof PrestaShop
                      ? client.orders(b.page)
                      : (client as Allegro).orders((b.page - 1) * 50),
                  readContext,
                );
    const staged = await tenantTx(req.actor.tenantId, async (c) => {
      if (ch.provider === 'allegro')
        await enlistAllegroContextInTx(c, readContext, req.actor.tenantId, ch.id, req.actor.userId);
      await acquireOrderFieldObservationAdmissionInTx(c, req.actor, ch.provider);
      if (ch.provider === 'odoo') await odooReadPolicy(c, req.actor, ch);
      if (ch.provider === 'amazon') await amazonReadPolicy(c, req.actor, ch);
      if (ch.provider === 'ebay') await ebayReadPolicy(c, req.actor, ch);
      if (ch.provider === 'shopify') await shopifyOrderReadPolicy(c, req.actor, ch);
      const data = await stageOrders(c, req.actor, ch, result.data);
      await c.query(
        'INSERT INTO integration_runs(id,tenant_id,channel_id,operation,status,detail) VALUES($1,$2,$3,$4,$5,$6)',
        [
          randomUUID(),
          req.actor.tenantId,
          ch.id,
          'orders.stage',
          'done',
          JSON.stringify({ page: b.page, count: data.length, has_more: result.has_more }),
        ],
      );
      return data;
    });
    return {
      data: staged,
      page: b.page,
      has_more: result.has_more,
      ...(['shopify', 'odoo', 'ebay', 'amazon'].includes(ch.provider)
        ? { next_cursor: result.next_cursor }
        : {}),
      scope: 'external_read_local_write',
    };
  });
  app.post('/api/integrations/:id/fetch-order', async (req) => {
    admin(req);
    const ch = await channel(req);
    ensure(ch.provider === 'shopify', 422, 'Punktowy odczyt dotyczy Shopify');
    const b = z
      .object({ external_id: z.string().min(1).max(160) })
      .strict()
      .parse(req.body);
    shopifyId(b.external_id, 'Order');
    if (ch.settings.simulation)
      return tenantTx(req.actor.tenantId, async (c) => {
        await shopifyOrderReadPolicy(c, req.actor, ch);
        const row = (
          await c.query(
            'SELECT id,state,source_hash FROM inbound_orders WHERE channel_id=$1 AND external_id=$2',
            [ch.id, b.external_id],
          )
        ).rows[0];
        ensure(row, 404, 'Nie znaleziono lokalnego przykładu zamówienia');
        await audit(c, req.actor, 'integration.order.refresh', ch.id, {
          external_id: b.external_id,
          scope: 'local_simulation',
        });
        return { data: [row], scope: 'local_simulation' };
      });
    const raw = await readShopifyOrder(req.actor, ch, b.external_id, context);
    return tenantTx(req.actor.tenantId, async (c) => {
      await acquireOrderFieldObservationAdmissionInTx(c, req.actor, ch.provider);
      await shopifyOrderReadPolicy(c, req.actor, ch);
      const data = await stageOrders(c, req.actor, ch, [raw]);
      await audit(c, req.actor, 'integration.order.refresh', ch.id, {
        external_id: b.external_id,
        scope: 'external_read_local_write',
      });
      return { data, scope: 'external_read_local_write' };
    });
  });
  app.post('/api/integrations/:id/stage-orders', async (req) => {
    admin(req);
    const ch = await channel(req);
    ensure(ch.provider !== 'mirakl', 422, 'Mirakl: staging wymaga zaufanego odczytu /mirakl/orders-stage');
    const b = stageOrdersInput.parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => ({
      data: await stageOrders(c, req.actor, ch, b.data),
      scope: 'manual_payload',
    }));
  });
  app.post('/api/integrations/:id/mappings', async (req) => {
    admin(req);
    const ch = await channel(req);
    const b = z
      .object({
        external_id: z.string().trim().min(1).max(160),
        sku: z.string().trim().min(1).max(80),
      })
      .parse(req.body);
    if (ch.provider === 'shopify') shopifyId(b.external_id, 'ProductVariant');
    if (ch.provider === 'odoo') odooId(b.external_id);
    return tenantTx(req.actor.tenantId, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
        `catalog:${req.actor.tenantId}`,
      ]);
      const p = (await resolveProductSkus(c, [b.sku]))[0];
      ensure(p, 422, 'Nie znaleziono produktu o podanym SKU w tej organizacji');
      const locked = (
        await c.query('SELECT id FROM listings WHERE channel_id=$1 AND external_id=$2 FOR UPDATE', [
          ch.id,
          b.external_id,
        ])
      ).rows[0];
      if (locked)
        ensure(
          !(
            await c.query(
              "SELECT 1 FROM offer_plans WHERE listing_id=$1 AND (state='queued' OR (state='failed' AND phase IN ('write_started','verify')))",
              [locked.id],
            )
          ).rowCount,
          409,
          'Trwa zapis oferty albo wymaga uzgodnienia; nie można zmienić powiązania',
        );
      const mapping = (
        await c.query(
          `INSERT INTO listings(id,tenant_id,channel_id,product_id,external_id,status,price)
        VALUES($1,$2,$3,$4,$5,'linked',$6) ON CONFLICT(tenant_id,channel_id,external_id)
        DO UPDATE SET product_id=EXCLUDED.product_id,status='linked',price=EXCLUDED.price,warehouse_id=NULL,parent_external_id=NULL,last_result=NULL RETURNING *`,
          [randomUUID(), req.actor.tenantId, ch.id, p.id, b.external_id, p.price],
        )
      ).rows[0];
      await audit(c, req.actor, 'listing.link', mapping.id, {
        channel_id: ch.id,
        external_id: b.external_id,
        sku: b.sku,
      });
      return mapping;
    });
  });
  app.post('/api/imports/:id/commit', async (req) => {
    admin(req);
    // The public alias always requires the reviewed source cut; ordinary UI remains compatible.
    const b = (req.url.split('?')[0].startsWith('/api/v1/')
      ? publicImportCommitInput : importCommitInput).parse(req.body),
      id = idOf(req.params);
    const provider = await tenantTx(
      req.actor.tenantId,
      async (c) =>
        (
          await c.query(
            'SELECT ch.provider FROM inbound_orders i JOIN channels ch ON (ch.tenant_id,ch.id)=(i.tenant_id,i.channel_id) WHERE i.id=$1',
            [id],
          )
        ).rows[0]?.provider,
    );
    if (provider === 'mirakl') {
      ensure(b.expected_hash, 422, 'Potwierdź aktualny podgląd Mirakl');
      const miraklAuthority = miraklImportAuthorityForRequest(req, context);
      const connection = await tenantTx(req.actor.tenantId, async c => {
        const ch = (await c.query(
          "SELECT ch.* FROM inbound_orders i JOIN channels ch ON (ch.tenant_id,ch.id)=(i.tenant_id,i.channel_id) WHERE i.id=$1 AND ch.provider='mirakl'",
          [id],
        )).rows[0];
        ensure(ch && ch.tenant_id === req.actor.tenantId, 404, 'Nie znaleziono własnego źródła Mirakl');
        await miraklAuthority(c, ch.id);
        return importConnectionHash(ch);
      });
      return importOrder(req.actor, id, b.warehouse_id, b.expected_hash, connection, {miraklAuthority});
    }
    if (provider === 'amazon') {
      ensure(b.expected_hash, 422, 'Potwierdź aktualny podgląd Amazon');
      return commitAmazonOrder(req.actor, id, b.warehouse_id, b.expected_hash, context);
    }
    if (provider === 'ebay') {
      ensure(b.expected_hash, 422, 'Potwierdź aktualny podgląd eBay');
      return commitEbayOrder(req.actor, id, b.warehouse_id, b.expected_hash, context);
    }
    if (provider === 'odoo') {
      ensure(b.expected_hash, 422, 'Potwierdź aktualny podgląd Odoo');
      return commitOdooOrder(req.actor, id, b.warehouse_id, b.expected_hash, context);
    }
    if (provider === 'shopify') {
      ensure(b.expected_hash, 422, 'Potwierdź aktualny podgląd Shopify');
      return commitShopifyOrder(req.actor, id, b.warehouse_id, b.expected_hash, context);
    }
    try {
      return await importOrder(req.actor, id, b.warehouse_id, b.expected_hash);
    } catch (error) {
      if (['woocommerce', 'allegro', 'prestashop'].includes(provider)) {
        const disposition = inspectImportOrderRollbackRefusal(error, req.actor, id, b.warehouse_id, b.expected_hash);
        if (disposition && error && typeof error === 'object')
          genericImportResponseDispositions.set(req, {error, disposition: Object.freeze({...disposition, provider})});
      }
      throw error;
    }
  });
}
