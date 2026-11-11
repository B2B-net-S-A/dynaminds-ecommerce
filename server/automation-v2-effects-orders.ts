/**
 * Automation rules v2: effects of lane M (orders) on the existing order modules, with their own checks
 * (server/automation-v2-effect-types.ts).
 *
 * - split_order: the native 222 split (order-split222.ts) previews and executes in the rule's transaction (same
 *   functions as the HTTP routes, `inTx`). It moves whole lines to ONE new child order in the same warehouse. The
 *   module has no per-line warehouse, so "wg magazynu" is not possible; the rule picks the lines by product or by
 *   product category instead.
 * - set_delivery_method: the "Sposób dostawy" section save of the order card (updateOrderSectionInTx), with its
 *   locks (label, shipment, dropshipping, cancellation) and its "było → jest" history.
 *
 * merge_orders lives in server/automation-v2-effects-merge.ts: the merge module cannot execute inside the rule's
 * transaction (its 209 delivery inheritance needs the top-level transaction id and an administrator's request-bound
 * session proof), so the rule checks the pairs with the module's own checks and proposes the merge to administrators.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { result, type EffectEnv, type EffectModule } from './automation-v2-effect-types';
import { loadOrderContexts } from './automation-v2-context';
import { lockedOrder } from './domain';
import { ensure } from './errors';
import { createOrderSplit222Preview, executeOrderSplit222 } from './order-split222';
import { SECTION_EDITED, updateOrderSectionInTx } from './order-sections';
import { DELIVERY_METHODS, DELIVERY_METHOD_LABELS } from './order-sections-model';

type Row = Record<string, any>;
const uuid = z.uuid().transform((v) => v.toLowerCase());

const splitParams = z
  .strictObject({
    mode: z.enum(['products', 'category']),
    product_ids: z.array(uuid).max(100).optional(),
    categories: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'products' && !v.product_ids?.length)
      ctx.addIssue({ code: 'custom', path: ['product_ids'], message: 'Wybierz produkty do wydzielenia' });
    if (v.mode === 'category' && !v.categories?.length)
      ctx.addIssue({ code: 'custom', path: ['categories'], message: 'Wybierz kategorie do wydzielenia' });
  });
const carrier = z.string().trim().max(80);
const deliveryParams = z
  .strictObject({
    method: z.enum(DELIVERY_METHODS),
    carrier: carrier.optional(),
    /** Optional weight variant: above this many grams the order gets method_over / carrier_over. */
    weight_over_g: z.number().int().min(1).max(10_000_000).optional(),
    method_over: z.enum(DELIVERY_METHODS).optional(),
    carrier_over: carrier.optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.weight_over_g === undefined) !== (v.method_over === undefined))
      ctx.addIssue({ code: 'custom', path: ['method_over'], message: 'Podaj próg wagi i sposób dostawy powyżej progu' });
  });
type SplitParams = z.infer<typeof splitParams>;
type DeliveryParams = z.infer<typeof deliveryParams>;

/** The split execution ends with SET CONSTRAINTS ALL IMMEDIATE, the last step of its own HTTP transaction. In the
 * rule's transaction later effects follow, so the initially deferred constraints get their default mode back; the
 * immediate check of what the split wrote has already run. */
async function restoreDeferredConstraints(c: PoolClient) {
  await c.query(`DO $$ DECLARE names text; BEGIN
    SELECT string_agg(name, ',') INTO names FROM (
      SELECT format('%I.%I', n.nspname, x.conname) name FROM pg_constraint x JOIN pg_namespace n ON n.oid=x.connamespace
       WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND has_schema_privilege(n.oid,'USAGE')
       GROUP BY n.nspname, x.conname HAVING bool_and(x.condeferrable AND x.condeferred)) d;
    IF names IS NOT NULL THEN EXECUTE 'SET CONSTRAINTS ' || names || ' DEFERRED'; END IF;
  END $$`);
}

async function splitOrder(env: EffectEnv, p: SplitParams) {
  const { c, actor, orderId } = env;
  const lines = (
    await c.query(
      'SELECT i.id,i.product_id,i.quantity,i.sku,p.category FROM order_items i JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.product_id) WHERE i.order_id=$1 ORDER BY i.id',
      [orderId],
    )
  ).rows as Row[];
  const wanted = lines.filter((l) =>
    p.mode === 'products' ? p.product_ids!.includes(l.product_id) : p.categories!.includes(l.category),
  );
  if (!wanted.length) return result('split_order', false, 'Zamówienie nie ma pozycji do wydzielenia');
  if (wanted.length === lines.length)
    return result('split_order', false, 'Wszystkie pozycje spełniają kryterium — zamówienie zostaje bez podziału');
  const preview = await createOrderSplit222Preview(
    actor,
    orderId,
    { client_key: randomUUID(), items: wanted.map((l) => ({ item_id: l.id, quantity: l.quantity })) },
    c,
  );
  const done = await executeOrderSplit222(
    actor,
    preview.preview.id,
    { client_key: randomUUID(), scope_hash: preview.preview.scope_hash },
    c,
  );
  await restoreDeferredConstraints(c);
  const child = done.execution as Row;
  return result(
    'split_order',
    true,
    `Wydzielono ${wanted.map((l) => l.sku).join(', ')} do nowego zamówienia ${child.child_number ?? child.child_order_id}`,
  );
}

async function setDeliveryMethod(env: EffectEnv, p: DeliveryParams) {
  const { c, actor, orderId } = env;
  let method = p.method,
    carrierName = p.carrier,
    reason = '';
  if (p.weight_over_g !== undefined) {
    // The same weight as the condition field order.weight (product logistics × quantity).
    const weight = Number((await loadOrderContexts(c, [orderId])).get(orderId)?.values['order.weight'] ?? 0);
    const over = weight > p.weight_over_g;
    if (over) [method, carrierName] = [p.method_over!, p.carrier_over];
    reason = ` (waga ${weight} g ${over ? '>' : '≤'} ${p.weight_over_g} g)`;
  }
  const o = await lockedOrder(c, orderId);
  const name = (await c.query('SELECT customer_message_actor_name($1) name', [actor.userId])).rows[0]?.name ?? null;
  const edits = async () =>
    (await c.query('SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND kind=$2', [orderId, SECTION_EDITED])).rows[0].n as number;
  const before = await edits();
  await updateOrderSectionInTx(c, actor, name ? `${name} (reguła ${env.rule.name})` : `Reguła ${env.rule.name}`, orderId, 'delivery_method', {
    expected_version: String(o.version),
    values: { method, ...(carrierName === undefined ? {} : { carrier: carrierName }) },
  });
  const label = DELIVERY_METHOD_LABELS[method] + (carrierName ? `, ${carrierName}` : '');
  if ((await edits()) === before) return result('set_delivery_method', false, `Sposób dostawy bez zmian: ${label}${reason}`);
  return result('set_delivery_method', true, `Zmieniono sposób dostawy na ${label}${reason}`);
}

async function existing(c: PoolClient, sql: string, values: string[], message: string) {
  const n = (await c.query(sql, [values])).rows[0].n as number;
  ensure(n === new Set(values).size, 422, message);
}

export const effects: EffectModule = {
  handlers: {
    split_order: {
      schema: splitParams,
      validate: async (c, p: SplitParams) => {
        if (p.mode === 'products')
          await existing(c, 'SELECT count(*)::int n FROM products WHERE id=ANY($1::uuid[])', p.product_ids!, 'Produkt nie istnieje w tej organizacji');
      },
      describe: (p: SplitParams, names) =>
        'Wydzieli do nowego zamówienia pozycje ' +
        (p.mode === 'products'
          ? 'produktów: ' + p.product_ids!.map((id) => names[id] ?? id).join(', ')
          : 'z kategorii: ' + p.categories!.join(', ')),
      apply: (env, p: SplitParams) => splitOrder(env, p),
    },
    set_delivery_method: {
      schema: deliveryParams,
      describe: (p: DeliveryParams) => {
        const one = (m: string, k?: string) => DELIVERY_METHOD_LABELS[m] + (k ? ` (${k})` : '');
        return p.weight_over_g === undefined
          ? `Zmieni sposób dostawy na ${one(p.method, p.carrier)}`
          : `Zmieni sposób dostawy na ${one(p.method, p.carrier)} do ${p.weight_over_g} g, powyżej na ${one(p.method_over!, p.carrier_over)}`;
      },
      apply: (env, p: DeliveryParams) => setDeliveryMethod(env, p),
    },
  },
  catalogParams: async (c) => {
    const methods = DELIVERY_METHODS.map((m) => ({ value: m, label: DELIVERY_METHOD_LABELS[m]! }));
    const products = (await c.query('SELECT id,name,sku FROM products ORDER BY name,id LIMIT 500')).rows.map((r) => ({
      value: r.id as string,
      label: `${r.name} (${r.sku})`,
    }));
    const categories = (await c.query('SELECT DISTINCT category FROM products ORDER BY category LIMIT 200')).rows.map((r) => ({
      value: r.category as string,
      label: r.category as string,
    }));
    return {
      split_order: [
        {
          key: 'mode',
          label: 'Wydziel pozycje',
          kind: 'select',
          required: true,
          options: [
            { value: 'products', label: 'Wybranych produktów' },
            { value: 'category', label: 'Z wybranych kategorii' },
          ],
        },
        { key: 'product_ids', label: 'Produkty', kind: 'multiselect', options: products },
        { key: 'categories', label: 'Kategorie', kind: 'multiselect', options: categories },
      ],
      set_delivery_method: [
        { key: 'method', label: 'Sposób dostawy', kind: 'select', required: true, options: methods },
        { key: 'carrier', label: 'Przewoźnik', kind: 'text' },
        { key: 'weight_over_g', label: 'Powyżej wagi (g) — opcjonalnie', kind: 'number' },
        { key: 'method_over', label: 'Sposób dostawy powyżej wagi', kind: 'select', options: methods },
        { key: 'carrier_over', label: 'Przewoźnik powyżej wagi', kind: 'text' },
      ],
    };
  },
};
