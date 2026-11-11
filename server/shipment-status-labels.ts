/** Polish labels of shipment / carrier tracking statuses, shared by the admin tracking views
 * (web/tracking.tsx) and the buyer portal (portal-view.ts). Plain data: web imports it at
 * runtime, so it must not import a Node builtin. An unknown status is shown as stored. */
export const SHIPMENT_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  created: 'Utworzona',
  confirmed: 'Etykieta gotowa',
  label_ready: 'Etykieta gotowa',
  in_transit: 'W transporcie',
  return_in_transit: 'Zwrot w transporcie',
  redirected: 'Przekierowana',
  delivery_failed: 'Próba doręczenia nieudana',
  lost: 'Zagubiona',
  unknown: 'Brak statusu przewoźnika',
  out_for_delivery: 'W doręczeniu',
  delivered: 'Doręczona',
  returned_to_sender: 'Zwrócona do nadawcy',
  canceled: 'Anulowana',
  ready_to_pickup: 'Gotowa do odbioru',
  collected_from_sender: 'Odebrana od nadawcy',
  taken_by_courier: 'Odebrana przez kuriera',
});
export const shipmentStatusLabel = (s: string): string =>
  Object.hasOwn(SHIPMENT_STATUS_LABELS, s) ? SHIPMENT_STATUS_LABELS[s] : s;
