import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ensure } from './errors';
import { psId, psStateIds } from './prestashop-orders';
export const psStatusKeys = [
  'paid',
  'picking',
  'packed',
  'shipped',
  'delivered',
  'completed',
  'cancelled',
] as const;
export const psStatusMapSchema = z
  .object(
    Object.fromEntries(psStatusKeys.map((k) => [k, z.string().regex(/^[1-9]\d{0,9}$/)])) as Record<
      (typeof psStatusKeys)[number],
      z.ZodString
    >,
  )
  .strict()
  .superRefine((v, c) => {
    if (psStatusKeys.some((k) => k !== 'cancelled' && v[k] === v.cancelled))
      c.addIssue({ code: 'custom', message: 'Status anulowania musi być oddzielny od realizacji' });
    for (const early of ['paid', 'picking', 'packed'] as const)
      for (const late of ['shipped', 'delivered', 'completed'] as const)
        if (v[early] === v[late])
          c.addIssue({
            code: 'custom',
            message: 'Status przed wysyłką musi być oddzielny od wysyłki i doręczenia',
          });
  });
export function psStatusMap(ch: any, required = true): Record<string, string> {
  const r = psStatusMapSchema.safeParse(ch.settings?.status_mappings);
  ensure(
    r.success || !required,
    422,
    'Skonfiguruj mapowanie ID statusów PrestaShop w synchronizacji statusów',
  );
  return r.success ? r.data : {};
}
export function psResourceKey(ch: any, o: any) {
  ensure(
    ch.settings.simulation || typeof ch.settings.store_url === 'string',
    422,
    'Brak adresu sklepu PrestaShop',
  );
  const u = new URL(ch.settings.store_url ?? 'https://local-example.invalid');
  u.search = '';
  u.hash = '';
  u.pathname = u.pathname.replace(/\/+$/, '');
  return (
    'prestashop-status:' +
    createHash('sha256')
      .update(
        JSON.stringify([
          u.toString(),
          psId(ch.settings.shop_id),
          psId(o.external_id),
          ch.settings.simulation ? ch.tenant_id : null,
        ]),
      )
      .digest('hex')
  );
}
export function psState(s: any, id: string) {
  ensure(s && psId(s.id) === id, 502, 'Brak zgodnego statusu PrestaShop');
  for (const k of ['paid', 'shipped', 'delivery', 'deleted'])
    ensure(
      ['0', '1', 0, 1, true, false].includes(s[k]),
      502,
      'Niekompletne flagi statusu PrestaShop',
    );
  return {
    id,
    paid: Number(s.paid),
    shipped: Number(s.shipped),
    delivery: Number(s.delivery),
    deleted: Number(s.deleted),
  };
}
// Synthetic flags are confined to explicitly local example channels.
export function psSimState(ch: any, id: string) {
  const map = psStatusMap(ch),
    delivered = [map.delivered, map.completed].includes(id),
    shipped = delivered || id === map.shipped;
  return {
    id,
    paid: id === map.cancelled ? '0' : '1',
    shipped: shipped ? '1' : '0',
    delivery: delivered ? '1' : '0',
    deleted: '0',
  };
}
export function psWritable(ch: any, remote: any, target: string, local: string) {
  const map = psStatusMap(ch),
    before = JSON.parse(remote.ps_state),
    after = JSON.parse(remote.ps_target_state);
  ensure(
    !before.deleted && !after.deleted,
    409,
    'Usunięty status PrestaShop wymaga osobnego uzgodnienia',
  );
  ensure(!after.delivery || after.shipped, 409, 'Status doręczenia musi również oznaczać wysyłkę');
  const expectedShip = ['shipped', 'delivered', 'completed'].includes(local),
    expectedDelivery = ['delivered', 'completed'].includes(local);
  ensure(
    Boolean(after.shipped) === expectedShip && Boolean(after.delivery) === expectedDelivery,
    409,
    'Flagi docelowego statusu PrestaShop nie odpowiadają etapowi realizacji',
  );
  if (local !== 'cancelled')
    ensure(
      after.paid === (remote.payment_mode === 'cod' ? 0 : 1),
      409,
      'Flaga opłacenia statusu PrestaShop nie odpowiada rodzajowi płatności',
    );
  ensure(
    !after.paid || remote.paid,
    409,
    'Status docelowy oznacza płatność, której sklep nie potwierdził',
  );
  if (remote.status === target) return;
  ensure(
    remote.status !== map.cancelled,
    409,
    'Zamówienie jest anulowane w sklepie; wymagane uzgodnienie',
  );
  ensure(
    !before.delivery || expectedDelivery,
    409,
    'Sklep potwierdził doręczenie; cofnięcie zatrzymane',
  );
  ensure(!before.shipped || expectedShip, 409, 'Sklep potwierdził wysyłkę; cofnięcie zatrzymane');
  ensure(
    Object.values(map).includes(remote.status) ||
      psStateIds(ch.settings.order_state_ids).includes(remote.status),
    409,
    'Status sklepu nie jest zmapowany ani dopuszczony do realizacji',
  );
  if (local === 'cancelled')
    ensure(
      !before.shipped && !before.delivery,
      409,
      'Nie można anulować wysłanego zamówienia PrestaShop',
    );
  else {
    ensure(
      remote.paid || remote.payment_mode === 'cod',
      409,
      'Sklep nie potwierdza pełnej płatności ani pobrania',
    );
    ensure(
      remote.payment_mode !== 'cod' || !after.paid,
      409,
      'Status opłacony dla pobrania wymaga potwierdzenia odbioru pieniędzy',
    );
    const ranks = psStatusKeys.filter((k) => k !== 'cancelled');
    const sourceRank = Math.max(-1, ...ranks.map((k, i) => (map[k] === remote.status ? i : -1)));
    const targetRank = Math.max(...ranks.map((k, i) => (map[k] === target ? i : -1)));
    ensure(
      sourceRank <= targetRank,
      409,
      'Status sklepu wyprzedza lokalną realizację; cofnięcie zatrzymane',
    );
  }
}
