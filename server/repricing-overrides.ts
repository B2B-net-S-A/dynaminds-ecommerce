/** REPRICE-004 (migration 247): manual override of the automatic price per price list and product.
 * "exclude" keeps the current price (the SKU is not repriced), "fixed" writes the given gross price.
 * The override is embedded in every preview row it touched, so an override created, changed or revoked
 * after a preview makes the apply recompute differ (409). Scheduled runs read the active override in
 * every batch. Overrides are never deleted: a change revokes the previous row in the same transaction. */
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit } from './domain';
import { ensure } from './errors';
import { assertProductsNotDeletedInTx } from './product-deletions';

export interface RepricingOverride {
  id: string;
  mode: 'exclude' | 'fixed';
  fixed_price: number | null;
  reason: string;
  created_at: string;
  created_by: string;
}
type Row = Record<string, any>;
type Product = { active?: boolean; kind?: string };

export const overrideInput = z
  .object({
    product_id: z.uuid(),
    mode: z.enum(['exclude', 'fixed']),
    fixed_price: z.number().int().min(0).max(100000000).optional(),
    reason: z.string().trim().min(3, 'Podaj powód nadpisania (3–500 znaków)').max(500, 'Podaj powód nadpisania (3–500 znaków)'),
    replaces: z.uuid().nullable().default(null),
  })
  .strict()
  .refine((b) => (b.mode === 'fixed') === (b.fixed_price !== undefined), 'Cena ręczna wymaga kwoty; wykluczenie nie przyjmuje kwoty');
export const overrideRevokeInput = z
  .object({ confirmed: z.literal(true), reason: z.string().trim().max(500).optional() })
  .strict();
export const overrideRowKey = (o: Pick<RepricingOverride, 'id'>): string => o.id;

/** Applies the active override to one computed preview row. Inactive products and variant groups stay blocked. */
export function applyRepricingOverride(row: Row, override: RepricingOverride | null, product: Product): Row {
  if (!override || !product.active || product.kind === 'group') return row;
  const ov = {
    id: override.id,
    mode: override.mode,
    fixed_price: override.fixed_price,
    reason: override.reason,
    created_at: override.created_at,
    created_by: override.created_by,
  };
  const computed = row.proposed_price ?? null;
  if (override.mode === 'exclude')
    return { ...row, state: 'override', proposed_price: row.current_price ?? null, computed_price: computed, override: ov, reason: 'Wykluczone ręcznie: ' + override.reason };
  const price = override.fixed_price as number;
  return {
    ...row,
    state: price === row.current_price ? 'unchanged' : 'change',
    proposed_price: price,
    computed_price: computed,
    below_floor: row.floor !== null && row.floor !== undefined && price < row.floor,
    override: ov,
    reason: 'Ręczna cena: ' + override.reason,
  };
}

export async function overridesAvailable(c: PoolClient): Promise<boolean> {
  return (await c.query("SELECT to_regclass('public.repricing_overrides') IS NOT NULL AS ok")).rows[0].ok === true;
}
const SELECT = `SELECT o.id,o.price_list_id,o.product_id,o.mode,o.fixed_price,o.reason,o.created_by,o.replaces_id,o.revoked_by,o.revoke_reason,
  to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') created_at,
  to_char(o.revoked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') revoked_at`;

/** Active overrides of the list for the given products (empty without the migration). */
export async function activeOverrides(c: PoolClient, listId: string, ids: readonly string[]): Promise<Map<string, RepricingOverride>> {
  if (!ids.length || !(await overridesAvailable(c))) return new Map();
  const rows = (
    await c.query(`${SELECT} FROM repricing_overrides o WHERE o.price_list_id=$1 AND o.product_id=ANY($2::uuid[]) AND o.revoked_at IS NULL`, [listId, ids])
  ).rows;
  return new Map(rows.map((r) => [r.product_id, { id: r.id, mode: r.mode, fixed_price: r.fixed_price, reason: r.reason, created_at: r.created_at, created_by: r.created_by }]));
}

async function people(ids: string[], tenantId: string): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  // users and memberships are outside the dyna_app grant; names only, members of this tenant only.
  const rows = (
    await pool.query('SELECT u.id,u.name FROM users u JOIN memberships m ON (m.user_id,m.tenant_id)=(u.id,$1) WHERE u.id=ANY($2::uuid[])', [tenantId, ids])
  ).rows;
  return new Map(rows.map((r) => [r.id, r.name]));
}

export function registerRepricingOverrideRoutes(app: FastifyInstance, options: { readOnly: boolean }): void {
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const write = (req: any) => {
    ensure(!options.readOnly, 423, 'Kopia tylko do odczytu');
    ensure(req.actor.role !== 'viewer', 403, 'Konto ma uprawnienia tylko do odczytu');
  };
  const required = async (c: PoolClient) =>
    ensure(await overridesAvailable(c), 503, 'Kopia nie zawiera tabeli nadpisań repricingu (migracja 247)');
  const listLock = async (c: PoolClient, listId: string) => {
    await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('catalog:'||current_setting('app.tenant_id'),0))");
    const list = (await c.query('SELECT * FROM price_lists WHERE id=$1 FOR UPDATE', [listId])).rows[0];
    ensure(list, 404, 'Nie znaleziono cennika');
    return list;
  };
  const page = z.object({
    state: z.enum(['active', 'all']).default('active'),
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });
  app.get('/api/price-lists/:id/repricing/overrides', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const listId = id(req.params),
        q = page.parse(req.query);
      ensure((await c.query('SELECT 1 FROM price_lists WHERE id=$1', [listId])).rowCount, 404, 'Nie znaleziono cennika');
      if (!(await overridesAvailable(c))) return { available: false, data: [], meta: { cursor: null } };
      const rows = (
        await c.query(
          `${SELECT},p.sku,p.name,i.price current_price FROM repricing_overrides o JOIN products p ON (p.tenant_id,p.id)=(o.tenant_id,o.product_id)
           LEFT JOIN price_list_items i ON (i.tenant_id,i.price_list_id,i.product_id)=(o.tenant_id,o.price_list_id,o.product_id)
           WHERE o.price_list_id=$1 AND ($2::text='all' OR o.revoked_at IS NULL)
             AND ($3::uuid IS NULL OR (o.created_at,o.id)<(SELECT created_at,id FROM repricing_overrides WHERE id=$3))
           ORDER BY o.created_at DESC,o.id DESC LIMIT $4`,
          [listId, q.state, q.after ?? null, q.limit + 1],
        )
      ).rows;
      const shown = rows.slice(0, q.limit);
      const names = await people([...new Set(shown.flatMap((r) => [r.created_by, r.revoked_by]).filter(Boolean))], req.actor.tenantId);
      return {
        available: true,
        data: shown.map((r) => ({ ...r, created_by_name: names.get(r.created_by) ?? '', revoked_by_name: r.revoked_by ? names.get(r.revoked_by) ?? '' : null })),
        meta: { cursor: rows.length > q.limit ? shown.at(-1)!.id : null },
      };
    }),
  );
  app.post('/api/price-lists/:id/repricing/overrides', (req) => {
    write(req);
    const b = overrideInput.parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      await required(c);
      const list = await listLock(c, id(req.params));
      const product = (await c.query('SELECT id,kind,active FROM products WHERE id=$1 FOR SHARE', [b.product_id])).rows[0];
      ensure(product, 404, 'Nie znaleziono produktu');
      await assertProductsNotDeletedInTx(c, [product.id]);
      ensure(product.kind !== 'group', 422, 'Grupa wariantów nie ma ceny sprzedaży');
      const active = (
        await c.query('SELECT id FROM repricing_overrides WHERE price_list_id=$1 AND product_id=$2 AND revoked_at IS NULL FOR UPDATE', [list.id, product.id])
      ).rows[0];
      ensure((active?.id ?? null) === b.replaces, 409, 'Nadpisanie tego SKU zmieniło się; odśwież dane');
      if (active)
        await c.query("UPDATE repricing_overrides SET revoked_at=now(),revoked_by=$2,revoke_reason='Zastąpione nowym nadpisaniem' WHERE id=$1", [active.id, req.actor.userId]);
      const created = (
        await c.query(
          `INSERT INTO repricing_overrides(id,tenant_id,price_list_id,product_id,mode,fixed_price,reason,created_by,replaces_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id`,
          [randomUUID(), req.actor.tenantId, list.id, product.id, b.mode, b.fixed_price ?? null, b.reason, req.actor.userId, active?.id ?? null],
        )
      ).rows[0];
      await audit(c, req.actor, 'repricing.override', created.id, {
        price_list_id: list.id, product_id: product.id, mode: b.mode, fixed_price: b.fixed_price ?? null, replaces: active?.id ?? null,
      });
      return (await c.query(`${SELECT} FROM repricing_overrides o WHERE o.id=$1`, [created.id])).rows[0];
    });
  });
  app.post('/api/repricing-overrides/:id/revoke', (req) => {
    write(req);
    const b = overrideRevokeInput.parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      await required(c);
      const ref = (await c.query('SELECT price_list_id FROM repricing_overrides WHERE id=$1', [id(req.params)])).rows[0];
      ensure(ref, 404, 'Nie znaleziono nadpisania');
      await listLock(c, ref.price_list_id);
      const row = (await c.query('SELECT * FROM repricing_overrides WHERE id=$1 FOR UPDATE', [id(req.params)])).rows[0];
      if (!row.revoked_at) {
        await c.query('UPDATE repricing_overrides SET revoked_at=now(),revoked_by=$2,revoke_reason=$3 WHERE id=$1', [row.id, req.actor.userId, b.reason || 'Wycofane ręcznie']);
        await audit(c, req.actor, 'repricing.override.revoke', row.id, { price_list_id: row.price_list_id, product_id: row.product_id });
      }
      return (await c.query(`${SELECT} FROM repricing_overrides o WHERE o.id=$1`, [row.id])).rows[0];
    });
  });
}
