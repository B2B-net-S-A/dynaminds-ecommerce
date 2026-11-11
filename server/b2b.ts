import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { secureSessionCookie } from './workspace-routes';
import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import {
  guardSupplierB2BCatalogScopeInTx,
  assertB2BCatalogProductsInTx,
  readB2BSupplierCatalogPageInTx,
  type B2BSupplierCatalogFrame,
  b2bCatalogScopeMetadataPresent,
} from './b2b-catalog-scope-adapters';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, createOrder, orderSchema } from './domain';
import { prices } from './pricing';
import { checkPassword, hashPassword, tokenHash } from './security';
import { ensure, Problem } from './errors';
import { requestReturn, returnInput, returnOverview } from './returns';
import { paymentBalance } from './payments';
import { orderMergeBuyerPaymentBalanceInTx } from './order-merge-payments';
import { documentBody } from './portal-view';
import { returnQuery } from './return-query';
import { productCatalogsAvailable } from './product-catalogs';
import { warehouseInventoryPoliciesAvailable } from './warehouse-inventory-policies';
import { warehousePolicyMapSQL, warehousePolicySellableQuantitySQL } from './warehouse-sellability';
import { registerB2bSupplierDirectoryRoutes } from './b2b-supplier-directory';
import { chargeTradeCreditInTx, registerB2bTradeCreditRoutes, tradeCreditViewInTx, type TradeCreditChannel } from './b2b-trade-credit';
const dummyHash = hashPassword('invalid-dummy-b2b-password');

export const b2bAccountInput = z
  .object({
    name: z.string().trim().min(2).max(200),
    email: z.email().transform((s) => s.toLowerCase()),
    tax_id: z.string().trim().max(40).default(''),
    warehouse_id: z.uuid(),
    price_list_id: z.uuid(),
    address: orderSchema.shape.address
      .unwrap()
      .extend({
        street: z.string().trim().min(1).max(200),
        city: z.string().trim().min(1).max(100),
        postal_code: z.string().trim().min(1).max(20),
        country: z
          .string()
          .trim()
          .regex(/^[A-Za-z]{2}$/)
          .transform((s) => s.toUpperCase()),
      })
      .strict(),
    min_total: z.number().int().min(0).max(2147483647).default(0),
    min_quantity: z.number().int().min(1).max(100000).default(1),
    quantity_step: z.number().int().min(1).max(100000).default(1),
    shipping_cost: z.number().int().min(0).max(1000000).default(0),
    payment_mode: z.enum(['prepaid', 'cod']).default('prepaid'),
  })
  .strict();
export const b2bCartInput = z
  .object({
    client_key: z.uuid(),
    items: orderSchema.shape.items.refine(
      (rows) => new Set(rows.map((i) => i.product_id)).size === rows.length,
      'Pozycje muszą być różne',
    ),
  })
  .strict();
const safeAccount = (a: any) => {
  const { password_hash, invite_hash, invite_expires_at, ...rest } = a;
  return {
    ...rest,
    activated: !!password_hash,
    invitation_pending: !!invite_hash && new Date(invite_expires_at) > new Date(),
  };
};
const summary = (o: any) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  total: o.total,
  currency: o.currency,
  created_at: o.created_at,
});
// Never expose an aggregate order through an original buyer's account.
async function mergeHistoryAvailable(c: PoolClient) {
  const r = (
    await c.query(`SELECT to_regclass('public.order_merge_origins') IS NOT NULL AS origins,
    to_regclass('public.order_merge_executions') IS NOT NULL AS executions`)
  ).rows[0];
  ensure(r.origins === r.executions, 503, 'Historia zamówień jest niekompletna w tej kopii');
  return Boolean(r.origins);
}
async function buyerOrder(c: PoolClient, a: any, orderId: string) {
  const current = (await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
  ensure(current, 404, 'Nie znaleziono zamówienia kontrahenta');
  let origin: any = null;
  if (await mergeHistoryAvailable(c)) {
    ensure(
      !(
        await c.query(
          `SELECT 1 FROM order_merge_executions
      WHERE target_order_id=$1 AND merge_mode='technical_merge' LIMIT 1`,
          [orderId],
        )
      ).rowCount,
      404,
      'Nie znaleziono zamówienia kontrahenta',
    );
    origin =
      (await c.query('SELECT header,items FROM order_merge_origins WHERE order_id=$1', [orderId]))
        .rows[0] ?? null;
  }
  const header = origin?.header ?? current;
  ensure(header.b2b_account_id === a.id, 404, 'Nie znaleziono zamówienia kontrahenta');
  return { header, origin };
}
const buyerSummary = (header: any, historical: boolean) => ({
  ...summary(header),
  ...(historical
    ? {
        historical: true,
        read_only: true,
        status_label: 'Zamówienie źródłowe — historia po połączeniu',
      }
    : {}),
});
const caseSummary = (r: any) => ({
  id: r.id,
  number: r.number,
  kind: r.kind,
  state: r.state,
  reason: r.reason,
  created_at: r.created_at,
  refund_amount: r.refund_amount,
  items: r.items.map((i: any) => ({
    name: i.name,
    sku: i.sku,
    requested: i.requested,
    accepted: i.accepted,
  })),
});
async function account(c: PoolClient, id: string, lock = 'SHARE') {
  const a = (await c.query('SELECT * FROM b2b_accounts WHERE id=$1 FOR ' + lock, [id])).rows[0];
  ensure(a, 404, 'Nie znaleziono konta kontrahenta');
  return a;
}
async function list(c: PoolClient, a: any) {
  const l = (await c.query('SELECT * FROM price_lists WHERE id=$1 FOR SHARE', [a.price_list_id]))
    .rows[0];
  ensure(l?.active, 409, 'Cennik kontrahenta jest nieaktywny');
  return l;
}
async function published(c: PoolClient, a: any, ids: string[]) {
  const frame = await supplierCatalog(c, a);
  if (frame) await assertB2BCatalogProductsInTx(c, frame, ids);
  const rows = (
    await c.query(
      `SELECT i.product_id FROM price_list_items i JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.product_id)
    WHERE i.price_list_id=$1 AND i.product_id=ANY($2::uuid[]) AND p.active AND p.kind<>'group'`,
      [a.price_list_id, ids],
    )
  ).rows;
  ensure(
    rows.length === ids.length,
    404,
    'Nie znaleziono wszystkich produktów w ofercie kontrahenta',
  );
}
async function supplierCatalog(c: PoolClient, a: any): Promise<B2BSupplierCatalogFrame | null> {
  if (await productCatalogsAvailable(c))
    return guardSupplierB2BCatalogScopeInTx(c, { tenantId: a.tenant_id, accountId: a.id });
  ensure(!(await b2bCatalogScopeMetadataPresent(c)), 503, 'Zakres B2B wymaga katalogów produktów');
  return null;
}
// Persisted proof stays internal; public portal quotes retain their established DTO.
function portalQuote(q: any) {
  const { catalog_scope: _proof, ...pricing } = q.pricing;
  return { ...q, pricing };
}
export async function b2bCatalogPage(
  c: PoolClient,
  a: any,
  q: { after?: string; search?: string; ids?: string[] },
  limit = 50,
) {
  const frame = await supplierCatalog(c, a);
  if (frame) {
    const { scope: _internal, ...page } = await readB2BSupplierCatalogPageInTx(c, frame, { ...q, limit });
    return page;
  }
  const l = await list(c, a);
  const warehousePolicies = await warehouseInventoryPoliciesAvailable(c);
  const saleStock = warehousePolicySellableQuantitySQL('wp.policy', 's.available');
  const rows = (
    await c.query(
      `${warehousePolicyMapSQL(warehousePolicies, {warehouseParam: 2})} SELECT p.id,p.sku,p.name,p.vat,p.description,p.attributes,p.images,p.kind,i.price,
      CASE WHEN p.kind='bundle' THEN coalesce((SELECT min(CASE WHEN x.active THEN floor(${saleStock}::numeric/b.quantity) ELSE 0 END)::int FROM bundle_components b LEFT JOIN stock s ON (s.tenant_id,s.product_id,s.warehouse_id)=(b.tenant_id,b.product_id,$2) JOIN products x ON(x.tenant_id,x.id)=(b.tenant_id,b.product_id) WHERE b.bundle_id=p.id),0) ELSE ${saleStock} END available
      FROM price_list_items i JOIN products p ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id) JOIN warehouse_policy_map wp ON wp.tenant_id=p.tenant_id AND wp.id=$2 LEFT JOIN stock s ON (s.tenant_id,s.product_id,s.warehouse_id)=(p.tenant_id,p.id,$2)
      WHERE i.price_list_id=$1 AND p.active AND p.kind<>'group' AND ($3::uuid IS NULL OR p.id>$3) AND ($4='' OR strpos(lower(p.sku||' '||p.name),lower($4))>0) AND ($5::uuid[] IS NULL OR p.id=ANY($5)) ORDER BY p.id LIMIT $6`,
      [a.price_list_id, a.warehouse_id, q.after ?? null, q.search ?? '', q.ids ?? null, limit + 1],
    )
  ).rows;
  return {
    data: rows.slice(0, limit),
    next: rows.length > limit ? rows[limit - 1].id : null,
    currency: l.currency,
    list_version: l.version,
  };
}
export async function quoteB2b(c: PoolClient, a: any, b: z.infer<typeof b2bCartInput>) {
  const input = { items: [...b.items].sort((x, y) => x.product_id.localeCompare(y.product_id)) };
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const old = (
    await c.query('SELECT * FROM b2b_quotes WHERE account_id=$1 AND client_key=$2', [
      a.id,
      b.client_key,
    ])
  ).rows[0];
  if (old) {
    ensure(old.fingerprint === fingerprint, 409, 'Klucz wyceny użyto z innymi pozycjami');
    return old;
  }
  const frame = await supplierCatalog(c, a);
  await published(
    c,
    a,
    input.items.map((i) => i.product_id),
  );
  ensure(
    input.items.every((i) => i.quantity >= a.min_quantity && i.quantity % a.quantity_step === 0),
    422,
    'Ilości muszą spełniać minimum i wielokrotność opakowania',
  );
  const pricing = await prices(
    c,
    input.items.map((i) => i.product_id),
    a.price_list_id,
    a.tenant_id,
  );
  const total =
    input.items.reduce(
      (n, i) => n + pricing.items.find((p) => p.product_id === i.product_id)!.price * i.quantity,
      0,
    ) + a.shipping_cost;
  ensure(
    Number.isSafeInteger(total) && total <= 2147483647,
    422,
    'Wartość zamówienia przekracza limit',
  );
  ensure(
    total - a.shipping_cost >= a.min_total,
    422,
    'Wartość towarów poniżej minimum kontrahenta',
  );
  const row = (
    await c.query(
      `INSERT INTO b2b_quotes(id,tenant_id,account_id,client_key,fingerprint,account_version,input,pricing,total)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        randomUUID(),
        a.tenant_id,
        a.id,
        b.client_key,
        fingerprint,
        a.version,
        JSON.stringify(input),
        JSON.stringify({ ...pricing, ...(frame ? { catalog_scope: frame } : {}) }),
        total,
      ],
    )
  ).rows[0];
  await audit(c, { tenantId: a.tenant_id, userId: null }, 'b2b.quote', row.id, {
    account_id: a.id,
  });
  return row;
}
export async function checkoutB2b(c: PoolClient, a: any, quoteId: string, channel: TradeCreditChannel = 'portal') {
  const q = (
    await c.query('SELECT * FROM b2b_quotes WHERE id=$1 AND account_id=$2 FOR UPDATE', [
      quoteId,
      a.id,
    ])
  ).rows[0];
  ensure(q, 404, 'Nie znaleziono wyceny kontrahenta');
  if (q.order_id) {
    const { header, origin } = await buyerOrder(c, a, q.order_id);
    return buyerSummary(header, !!origin);
  }
  ensure(
    q.expires_at > new Date() && q.account_version === a.version,
    409,
    'Wycena wygasła lub warunki zmieniły się; przygotuj nową',
  );
  const frame = await supplierCatalog(c, a);
  if (q.pricing.catalog_scope)
    ensure(isDeepStrictEqual(frame, q.pricing.catalog_scope), 409, 'Zakres katalogu zmienił się; przygotuj nową wycenę');
  else ensure(!frame || frame.mode === 'legacy_default', 409, 'Wycena nie potwierdza zakresu katalogu; przygotuj nową');
  // Match createOrder/catalog editors: catalog lock precedes list/product locks.
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'catalog:' + a.tenant_id,
  ]);
  const ids = q.input.items.map((i: any) => i.product_id);
  await published(c, a, ids);
  const current = await prices(c, ids, a.price_list_id, a.tenant_id);
  const { catalog_scope: _proof, ...quotedPricing } = q.pricing;
  ensure(
    isDeepStrictEqual(current, quotedPricing),
    409,
    'Ceny lub produkty zmieniły się; przygotuj nową wycenę',
  );
  const o = await createOrder(
    c,
    { tenantId: a.tenant_id, userId: null },
    orderSchema.parse({
      customer_name: a.name,
      email: a.email,
      address: a.address,
      warehouse_id: a.warehouse_id,
      price_list_id: a.price_list_id,
      currency: current.currency,
      source: 'b2b',
      payment_mode: a.payment_mode,
      shipping_cost: a.shipping_cost,
      items: q.input.items,
    }),
  );
  await c.query('UPDATE orders SET b2b_account_id=$2,b2b_snapshot=$3 WHERE id=$1', [
    o.id,
    a.id,
    JSON.stringify({
      account_version: a.version,
      name: a.name,
      email: a.email,
      tax_id: a.tax_id,
      address: a.address,
      quote_id: q.id,
    }),
  ]);
  await c.query('UPDATE b2b_quotes SET order_id=$2 WHERE id=$1', [q.id, o.id]);
  // 246 (B2B-007): an account with an active credit line buys on credit; a refusal rolls the checkout back.
  const credit = await chargeTradeCreditInTx(c, a, o.id, channel);
  await audit(c, { tenantId: a.tenant_id, userId: null }, 'b2b.checkout', o.id, {
    account_id: a.id,
    quote_id: q.id,
  });
  return { ...summary(o), ...(credit ? { trade_credit: credit } : {}) };
}
export function registerB2bRoutes(
  app: FastifyInstance,
  {
    readOnly,
    previewPort,
    printLayout,
  }: {
    readOnly: boolean;
    previewPort?: number;
    printLayout: (title: string, body: string, nativeProforma?: boolean) => string;
  },
) {
  app.addHook('onRequest', async (r, reply) => {
    if (r.url.startsWith('/api/public/b2b/'))
      reply.header('X-Robots-Tag', 'noindex, nofollow').header('X-Frame-Options', 'DENY');
  });
  const key = readOnly ? 'dyna_b2b_preview_' + previewPort : 'dyna_b2b';
  const cookieOptions = {
    path: '/api/public/b2b',
    httpOnly: true,
    sameSite: 'strict' as const,
    maxAge: 8 * 3600,
  };
  const id = (r: any) => z.object({ id: z.uuid() }).parse(r.params).id;
  const buyerId = (r: any) => z.object({ account: z.uuid() }).parse(r.params).account;
  const admin = (r: any) =>
    ensure(r.actor.role === 'admin', 403, 'Kontrahentów konfiguruje administrator');
  async function buyer<T>(r: any, fn: (c: PoolClient, a: any) => Promise<T>) {
    const token = r.cookies[key],
      aid = buyerId(r);
    ensure(
      typeof token === 'string' && /^[a-f0-9]{64}$/.test(token),
      401,
      'Zaloguj się do portalu B2B',
    );
    const ref = (
      await pool.query(
        'SELECT tenant_id FROM b2b_sessions WHERE token_hash=$1 AND account_id=$2 AND expires_at>now()',
        [tokenHash(token), aid],
      )
    ).rows[0];
    ensure(ref, 401, 'Sesja kontrahenta wygasła');
    return tenantTx(ref.tenant_id, async (c) => {
      // Scope/catalog writers take catalog before account. Historical reads and
      // completed checkout replay do not require a fresh active catalog frame.
      await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', ['catalog:' + ref.tenant_id]);
      const a = await account(c, aid, 'UPDATE');
      ensure(
        a.active &&
          (
            await c.query(
              'SELECT 1 FROM b2b_sessions WHERE token_hash=$1 AND account_id=$2 AND expires_at>now()',
              [tokenHash(token), aid],
            )
          ).rowCount,
        401,
        'Konto lub sesja kontrahenta jest nieaktywna',
      );
      return fn(c, a);
    });
  }
  registerB2bTradeCreditRoutes(app);
  registerB2bSupplierDirectoryRoutes(app);
  app.get('/api/b2b/accounts', (r) =>
    tenantTx(r.actor.tenantId, async (c) => {
      const q = z
        .object({ after: z.uuid().optional(), search: z.string().trim().max(100).default('') })
        .parse(r.query);
      const rows = (
        await c.query(
          "SELECT * FROM b2b_accounts WHERE ($1::uuid IS NULL OR id>$1) AND ($2='' OR strpos(lower(name||' '||email),lower($2))>0) ORDER BY id LIMIT 51",
          [q.after ?? null, q.search],
        )
      ).rows;
      return {
        data: rows.slice(0, 50).map(safeAccount),
        next: rows.length > 50 ? rows[49].id : null,
      };
    }),
  );
  app.post('/api/b2b/accounts', async (r, reply) => {
    admin(r);
    const b = b2bAccountInput.parse(r.body);
    const a = await tenantTx(r.actor.tenantId, async (c) => {
      ensure(
        (await c.query('SELECT id FROM warehouses WHERE id=$1', [b.warehouse_id])).rowCount,
        404,
        'Nie znaleziono magazynu',
      );
      await list(c, b);
      const a = (
        await c.query(
          `INSERT INTO b2b_accounts(id,tenant_id,name,email,tax_id,warehouse_id,price_list_id,address,min_total,min_quantity,quantity_step,shipping_cost,payment_mode)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            randomUUID(),
            r.actor.tenantId,
            b.name,
            b.email,
            b.tax_id,
            b.warehouse_id,
            b.price_list_id,
            JSON.stringify(b.address),
            b.min_total,
            b.min_quantity,
            b.quantity_step,
            b.shipping_cost,
            b.payment_mode,
          ],
        )
      ).rows[0];
      await audit(c, r.actor, 'b2b.account.create', a.id);
      return safeAccount(a);
    });
    return reply.code(201).send(a);
  });
  app.patch('/api/b2b/accounts/:id', async (r) => {
    admin(r);
    const b = b2bAccountInput
      .extend({
        version: z.number().int().positive(),
        active: z.boolean(),
        confirmed: z.literal(true),
      })
      .parse(r.body);
    return tenantTx(r.actor.tenantId, async (c) => {
      const a = await account(c, id(r), 'UPDATE');
      ensure(a.version === b.version, 409, 'Konto zmieniło się; odśwież');
      ensure(
        (await c.query('SELECT id FROM warehouses WHERE id=$1', [b.warehouse_id])).rowCount,
        404,
        'Nie znaleziono magazynu',
      );
      if (b.active) await list(c, b);
      const row = (
        await c.query(
          `UPDATE b2b_accounts SET name=$2,email=$3,tax_id=$4,warehouse_id=$5,price_list_id=$6,address=$7,min_total=$8,min_quantity=$9,quantity_step=$10,shipping_cost=$11,payment_mode=$12,active=$13,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
          [
            a.id,
            b.name,
            b.email,
            b.tax_id,
            b.warehouse_id,
            b.price_list_id,
            JSON.stringify(b.address),
            b.min_total,
            b.min_quantity,
            b.quantity_step,
            b.shipping_cost,
            b.payment_mode,
            b.active,
          ],
        )
      ).rows[0];
      await c.query('DELETE FROM b2b_sessions WHERE account_id=$1', [a.id]);
      await audit(c, r.actor, 'b2b.account.edit', a.id, { version: row.version, active: b.active });
      return safeAccount(row);
    });
  });
  app.post('/api/b2b/accounts/:id/invite', async (r) => {
    admin(r);
    const b = z
      .object({ version: z.number().int().positive(), confirmed: z.literal(true) })
      .strict()
      .parse(r.body);
    const token = randomBytes(32).toString('hex');
    return tenantTx(r.actor.tenantId, async (c) => {
      const a = await account(c, id(r), 'UPDATE');
      ensure(a.active && a.version === b.version, 409, 'Aktywuj aktualną wersję kontrahenta');
      await c.query(
        "UPDATE b2b_accounts SET invite_hash=$2,invite_expires_at=now()+interval '24 hours',password_hash=NULL,version=version+1,updated_at=now() WHERE id=$1",
        [a.id, tokenHash(token)],
      );
      await c.query('DELETE FROM b2b_sessions WHERE account_id=$1', [a.id]);
      await audit(c, r.actor, 'b2b.account.invite', a.id);
      return {
        account_id: a.id,
        version: a.version + 1,
        invitation: '/b2b/' + a.id + '#invite=' + token,
        expires_hours: 24,
      };
    });
  });
  const publicBase = '/api/public/b2b/:account';
  app.post(
    publicBase + '/activate',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (r) => {
      const b = z
        .object({
          token: z.string().regex(/^[a-f0-9]{64}$/),
          password: z.string().min(12).max(128),
        })
        .strict()
        .parse(r.body);
      const ref = (
        await pool.query(
          'SELECT tenant_id FROM b2b_accounts WHERE id=$1 AND invite_hash=$2 AND invite_expires_at>now() AND active',
          [buyerId(r), tokenHash(b.token)],
        )
      ).rows[0];
      ensure(ref, 404, 'Zaproszenie wygasło lub jest nieaktywne');
      return tenantTx(ref.tenant_id, async (c) => {
        const a = await account(c, buyerId(r), 'UPDATE');
        ensure(
          a.active && a.invite_hash === tokenHash(b.token) && a.invite_expires_at > new Date(),
          404,
          'Zaproszenie wygasło lub zostało wykorzystane',
        );
        await c.query(
          'UPDATE b2b_accounts SET password_hash=$2,invite_hash=NULL,invite_expires_at=NULL,version=version+1,updated_at=now() WHERE id=$1',
          [a.id, hashPassword(b.password)],
        );
        await audit(c, { tenantId: ref.tenant_id, userId: null }, 'b2b.account.activate', a.id);
        return { activated: true };
      });
    },
  );
  app.post(
    publicBase + '/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (r, reply) => {
      const b = z
        .object({
          email: z.email().transform((s) => s.toLowerCase()),
          password: z.string().min(1).max(128),
        })
        .strict()
        .parse(r.body);
      const a = (
        await pool.query('SELECT * FROM b2b_accounts WHERE id=$1 AND email=$2', [
          buyerId(r),
          b.email,
        ])
      ).rows[0];
      const valid = checkPassword(b.password, a?.password_hash ?? dummyHash);
      ensure(
        valid && a?.active && a?.password_hash,
        401,
        'Nieprawidłowe dane logowania lub nieaktywne konto',
      );
      const token = randomBytes(32).toString('hex');
      await tenantTx(a.tenant_id, async (c) => {
        const current = await account(c, a.id, 'UPDATE');
        ensure(
          current.active && current.password_hash === a.password_hash,
          401,
          'Konto zmieniło się; zaloguj ponownie',
        );
        await c.query('DELETE FROM b2b_sessions WHERE account_id=$1 AND expires_at<=now()', [a.id]);
        ensure(
          (await c.query('SELECT count(*)::int n FROM b2b_sessions WHERE account_id=$1', [a.id]))
            .rows[0].n < 20,
          429,
          'Za dużo aktywnych sesji kontrahenta',
        );
        await c.query(
          "INSERT INTO b2b_sessions(token_hash,tenant_id,account_id,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",
          [tokenHash(token), a.tenant_id, a.id],
        );
      });
      reply.setCookie(key, token, { ...cookieOptions, secure: secureSessionCookie(reply) });
      return { logged_in: true };
    },
  );
  app.post(publicBase + '/logout', async (r, reply) => {
    if (r.cookies[key])
      await pool.query('DELETE FROM b2b_sessions WHERE token_hash=$1 AND account_id=$2', [
        tokenHash(r.cookies[key]),
        buyerId(r),
      ]);
    reply.clearCookie(key, { path: cookieOptions.path });
    return { logged_out: true };
  });
  app.get(publicBase + '/me', (r) =>
    buyer(r, async (c, a) => {
      const l = await list(c, a),
        seller = (await c.query('SELECT name FROM tenants WHERE id=$1', [a.tenant_id])).rows[0];
      return {
        account: {
          id: a.id,
          name: a.name,
          email: a.email,
          tax_id: a.tax_id,
          address: a.address,
          min_total: a.min_total,
          min_quantity: a.min_quantity,
          quantity_step: a.quantity_step,
          shipping_cost: a.shipping_cost,
          payment_mode: a.payment_mode,
          currency: l.currency,
        },
        seller: seller.name,
        read_only: readOnly,
      };
    }),
  );
  // 246 (B2B-007): the buyer's own credit balance (limit, open, free, after the term), without order ids.
  app.get(publicBase + '/trade-credit', (r) =>
    buyer(r, async (c, a) => {
      const v = await tradeCreditViewInTx(c, a.tenant_id, a.id);
      return { ...v, orders: v.orders.map(({ order_id: _id, ...o }) => o) };
    }),
  );
  app.get(publicBase + '/catalog', (r) =>
    buyer(r, async (c, a) => {
      const l = await list(c, a),
        q = z
          .object({ after: z.uuid().optional(), search: z.string().trim().max(100).default('') })
          .strict()
          .parse(r.query);
      const page = await b2bCatalogPage(c, a, q);
      return {
        data: page.data.map((p) => ({
          ...p,
          images: p.images.map((url: string) =>
            url.startsWith('/api/product-images/')
              ? publicBase.replace(':account', a.id) +
                '/catalog/' +
                p.id +
                '/images/' +
                url.split('/').at(-1)
              : url,
          ),
        })),
        next: page.next,
        currency: l.currency,
      };
    }),
  );
  app.get(publicBase + '/catalog/:id/images/:image', (r, reply) =>
    buyer(r, async (c, a) => {
      await list(c, a);
      const product = id(r),
        image = z.object({ image: z.uuid() }).parse(r.params).image;
      await published(c, a, [product]);
      const img = (
        await c.query(
          `SELECT i.mime FROM product_images i JOIN products p ON p.tenant_id=i.tenant_id
        WHERE i.id=$1 AND p.id=$2 AND p.images @> $3::jsonb`,
          [image, product, JSON.stringify(['/api/product-images/' + image])],
        )
      ).rows[0];
      ensure(img, 404, 'Nie znaleziono zdjęcia w ofercie kontrahenta');
      const bytes = await readFile(
        resolve(process.env.DYNA_IMAGE_DIR ?? 'data/product-images', image),
      ).catch(() => null);
      ensure(bytes, 404, 'Plik zdjęcia jest niedostępny');
      return reply
        .type(img.mime)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .send(bytes);
    }),
  );
  app.post(publicBase + '/quotes', (r) =>
    buyer(r, async (c, a) => portalQuote(await quoteB2b(c, a, b2bCartInput.parse(r.body)))),
  );
  app.post(publicBase + '/quotes/:id/checkout', (r) =>
    buyer(r, (c, a) => {
      z.object({ confirmed: z.literal(true) })
        .strict()
        .parse(r.body);
      return checkoutB2b(c, a, id(r));
    }),
  );
  app.get(publicBase + '/orders', (r) =>
    buyer(r, async (c, a) => {
      const q = z.object({ after: z.uuid().optional() }).strict().parse(r.query);
      if (q.after) {
        try {
          await buyerOrder(c, a, q.after);
        } catch (e) {
          // A foreign or missing cursor remains an empty page, as in the legacy buyer API.
          if (e instanceof Problem && e.status === 404) return { data: [], next: null };
          throw e;
        }
      }
      const history = await mergeHistoryAvailable(c);
      const rows = (
        await c.query(
          `SELECT o.* ${history ? ',m.header AS merge_original' : ''}
        FROM orders o ${history ? 'LEFT JOIN order_merge_origins m ON(m.tenant_id,m.order_id)=(o.tenant_id,o.id)' : ''}
        WHERE ${history ? "CASE WHEN m.order_id IS NOT NULL THEN m.header->>'b2b_account_id' ELSE o.b2b_account_id::text END" : 'o.b2b_account_id::text'}=$1
        ${history ? "AND NOT EXISTS(SELECT 1 FROM order_merge_executions e WHERE e.tenant_id=o.tenant_id AND e.target_order_id=o.id AND e.merge_mode='technical_merge')" : ''}
        AND ($2::uuid IS NULL OR (o.created_at,o.id)<(SELECT created_at,id FROM orders WHERE id=$2))
        ORDER BY o.created_at DESC,o.id DESC LIMIT 26`,
          [a.id, q.after ?? null],
        )
      ).rows;
      return {
        data: rows.slice(0, 25).map((o) => buyerSummary(o.merge_original ?? o, !!o.merge_original)),
        next: rows.length > 25 ? rows[24].id : null,
      };
    }),
  );
  app.get(publicBase + '/orders/:id', (r) =>
    buyer(r, async (c, a) => {
      const q = z
          .object({ case_after: z.string().max(1600).optional() })
          .strict()
          .parse(r.query),
        view = await buyerOrder(c, a, id(r)),
        o = view.header;
      if (view.origin) {
        const { balance: payment, payment_as_of_merge } = await orderMergeBuyerPaymentBalanceInTx(
          c,
          o.id,
        );
        ensure(
          payment && payment.currency === o.currency,
          503,
          'Historyczne saldo jest niedostępne',
        );
        return {
          ...buyerSummary(o, true),
          items: view.origin.items.map((i: any) => ({
            id: i.id,
            sku: i.sku,
            name: i.name,
            quantity: i.quantity,
            line_total: i.line_total,
            available: 0,
          })),
          payment: {
            amount_due: payment.amount_due,
            received: payment.received,
            refunded: payment.refunded,
          },
          payment_as_of_merge,
          shipments: [],
          documents: [],
          cases: [],
          case_meta: { has_more: false, cursor: null },
          shipping_available: 0,
          read_only: true,
        };
      }
      const overview = await returnOverview(c, o.id, returnQuery.parse({ after: q.case_after })),
        payment = await paymentBalance(c, o.id);
      const shipments = (
        await c.query(
          'SELECT carrier,tracking_number,status,mode FROM shipments WHERE order_id=$1',
          [o.id],
        )
      ).rows;
      const documents = (
        await c.query(
          'SELECT id,number,kind,mode FROM documents WHERE order_id=$1 ORDER BY created_at DESC,id LIMIT 100',
          [o.id],
        )
      ).rows;
      return {
        ...summary(o),
        items: overview.items,
        payment: {
          amount_due: payment.amount_due,
          received: payment.received,
          refunded: payment.refunded,
        },
        shipments,
        documents,
        cases: overview.cases.map(caseSummary),
        case_meta: overview.meta,
        shipping_available: overview.shipping_available,
        read_only: readOnly,
      };
    }),
  );
  app.get(publicBase + '/orders/:id/documents/:document/print', async (r, reply) =>
    buyer(r, async (c, a) => {
      const view = await buyerOrder(c, a, id(r));
      ensure(!view.origin, 409, 'Dokument zamówienia połączonego wymaga uzgodnienia ze sprzedawcą');
      const o = view.header,
        doc = z.object({ document: z.uuid() }).parse(r.params).document;
      const d = (await c.query('SELECT * FROM documents WHERE id=$1 AND order_id=$2', [doc, o.id]))
        .rows[0];
      ensure(d, 404, 'Nie znaleziono dokumentu zamówienia');
      ensure(
        ['demo', 'simulation'].includes(d.mode) || (d.kind === 'proforma' && d.mode === 'local'),
        409,
        'Dokument dostawcy pobierzesz po uzgodnieniu ze sprzedawcą',
      );
      return reply
        .type('text/html')
        .send(printLayout(d.number, documentBody(d), d.kind === 'proforma' && d.mode === 'local'));
    }),
  );
  app.post(publicBase + '/orders/:id/returns', async (r, reply) => {
    const result = await buyer(r, async (c, a) => {
      const view = await buyerOrder(c, a, id(r));
      ensure(!view.origin, 409, 'Zwrot historycznego źródła wymaga uzgodnienia ze sprzedawcą');
      const o = view.header,
        b = returnInput.omit({ warehouse_id: true, reason_id: true }).strict().parse(r.body);
      return requestReturn(
        c,
        { tenantId: a.tenant_id, userId: null },
        o.id,
        { ...b, warehouse_id: o.warehouse_id },
        false,
        'buyer',
      );
    });
    return reply.code(201).send(caseSummary(result));
  });
}
