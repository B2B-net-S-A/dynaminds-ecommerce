/** Tenant order settings (migration 266, uwaga klienta §7): "Drukuj etykietę przy pakowaniu", default off.
 * When on, the order that becomes packed (after its last item is scanned) gets the DEMO label at once, so it reads
 * "Gotowe do nadania". Only the demo carrier: a real carrier label costs money, so it is never created here. */
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { tenantReadTx, tenantTx } from './db';
import { audit, createDemoLabel, type Actor } from './domain';
import { ensure, Problem } from './errors';

export const DEMO_LABEL_CARRIER = 'Symulator lokalny';
export const orderSettingsInput = z.strictObject({
  print_label_at_packing: z.boolean({ error: 'Wybierz, czy drukować etykietę przy pakowaniu' }),
  version: z.number().int().min(0),
});
export interface OrderSettings {
  available: boolean;
  print_label_at_packing: boolean;
  version: number;
  updated_at: string | null;
}

export async function orderSettingsAvailable(c: PoolClient): Promise<boolean> {
  return (await c.query("SELECT to_regclass('public.tenant_order_settings') IS NOT NULL ok")).rows[0]?.ok === true;
}
async function view(c: PoolClient): Promise<OrderSettings> {
  if (!(await orderSettingsAvailable(c))) return { available: false, print_label_at_packing: false, version: 0, updated_at: null };
  const row = (await c.query('SELECT print_label_at_packing,version,updated_at FROM tenant_order_settings')).rows[0];
  return {
    available: true,
    print_label_at_packing: row?.print_label_at_packing === true,
    version: row?.version ?? 0,
    updated_at: row?.updated_at ?? null,
  };
}

export async function saveOrderSettingsInTx(c: PoolClient, a: Actor, input: unknown): Promise<OrderSettings> {
  ensure(a.role === 'admin', 403, 'Wymagana rola administratora');
  const b = orderSettingsInput.parse(input);
  ensure(await orderSettingsAvailable(c), 409, 'Ustawienia zamówień wymagają migracji 266; ta kopia bazy jej nie ma');
  const row = (await c.query('SELECT version FROM tenant_order_settings FOR UPDATE')).rows[0];
  ensure((row?.version ?? 0) === b.version, 409, 'Ustawienia zmieniły się w międzyczasie. Odśwież widok.');
  await c.query(
    `INSERT INTO tenant_order_settings(tenant_id,print_label_at_packing,actor_id) VALUES($1,$2,$3)
     ON CONFLICT (tenant_id) DO UPDATE SET print_label_at_packing=EXCLUDED.print_label_at_packing,actor_id=EXCLUDED.actor_id,
       version=tenant_order_settings.version+1,updated_at=clock_timestamp()`,
    [a.tenantId, b.print_label_at_packing, a.userId],
  );
  await audit(c, a, 'order.settings', null, { print_label_at_packing: b.print_label_at_packing });
  return view(c);
}

/** The carrier chosen in the order's Dostawa section (the latest saved value), '' when none was chosen. */
async function chosenCarrier(c: PoolClient, orderId: string): Promise<string> {
  const row = (
    await c.query(
      `SELECT detail->'values'->>'carrier' carrier FROM order_events WHERE order_id=$1 AND kind='order.section_edited'
        AND detail->>'section'='delivery_method' AND detail ? 'values' ORDER BY created_at DESC,id DESC LIMIT 1`,
      [orderId],
    )
  ).rows[0];
  return String(row?.carrier ?? '').trim();
}
/** No carrier chosen, or the local simulator: the DEMO label is free. Any other name is a real carrier. */
export function isDemoCarrier(carrier: string): boolean {
  const name = carrier.trim().toLowerCase();
  return name === '' || name === DEMO_LABEL_CARRIER.toLowerCase() || name === 'demo';
}

/** Called by transition() right after an order became packed. With the setting on and the demo carrier it creates
 * the DEMO label (createDemoLabel, as POST /api/orders/:id/demo-label). A label the order cannot have now (an existing
 * shipment, a prepared shipping or parcel plan, dropshipping) is skipped and audited; packing is never undone. */
export async function autoDemoLabelAfterPackingInTx(c: PoolClient, a: Actor, orderId: string): Promise<'created' | 'off' | 'real_carrier' | 'skipped'> {
  if (!(await orderSettingsAvailable(c))) return 'off';
  const on = (await c.query('SELECT print_label_at_packing FROM tenant_order_settings')).rows[0]?.print_label_at_packing === true;
  if (!on) return 'off';
  const carrier = await chosenCarrier(c, orderId);
  if (!isDemoCarrier(carrier)) return 'real_carrier';
  await c.query('SAVEPOINT auto_demo_label');
  try {
    await createDemoLabel(c, a, orderId);
    await c.query('RELEASE SAVEPOINT auto_demo_label');
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
    await c.query('ROLLBACK TO SAVEPOINT auto_demo_label');
    await c.query('RELEASE SAVEPOINT auto_demo_label');
    await audit(c, a, 'shipment.demo_label_auto_skipped', orderId, { reason: e.message.slice(0, 300) });
    return 'skipped';
  }
  await audit(c, a, 'shipment.demo_label_auto', orderId, { setting: 'print_label_at_packing' });
  return 'created';
}

export function registerOrderSettingsRoutes(app: FastifyInstance, opts: { readOnly: boolean }) {
  app.get('/api/order-settings', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return { ...(await tenantReadTx(req.actor.tenantId, view)), read_only: opts.readOnly };
  });
  app.put('/api/order-settings', async (req) => {
    ensure(!opts.readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(!req.apiScopes, 403, 'Ustawienia zamówień zmienia administrator w sesji użytkownika');
    return { ...(await tenantTx(req.actor.tenantId, (c) => saveOrderSettingsInTx(c, req.actor, req.body))), read_only: false };
  });
}
