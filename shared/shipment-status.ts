/**
 * Carrier shipment statuses shown to people and used by automation rules v2 (trigger shipment.status_changed,
 * condition "Status przesyłki"). Carriers report their own codes (server/tracking.ts, dpd-info.ts,
 * carrier-dhl-values.ts, carrier-pocztapolska-tracking.ts, InPost ShipX names); shipmentStatusOf groups them.
 */
export const SHIPMENT_STATUSES = ['picked_up', 'in_transit', 'ready_to_pickup', 'delivered', 'returned_to_sender', 'problem'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  picked_up: 'Odebrana przez kuriera',
  in_transit: 'W drodze',
  ready_to_pickup: 'W punkcie odbioru',
  delivered: 'Doręczona',
  returned_to_sender: 'Zwrot do nadawcy',
  problem: 'Problem z doręczeniem',
};

const GROUPS: Record<string, ShipmentStatus> = {
  picked_up: 'picked_up',
  collected_from_sender: 'picked_up',
  taken_by_courier: 'picked_up',
  adopted_at_source_branch: 'picked_up',
  dispatched_by_sender: 'picked_up',
  dispatched_by_sender_to_pok: 'picked_up',
  taken_by_courier_from_pok: 'picked_up',
  in_transit: 'in_transit',
  out_for_delivery: 'in_transit',
  out_for_delivery_to_address: 'in_transit',
  sent_from_source_branch: 'in_transit',
  adopted_at_sorting_center: 'in_transit',
  sent_from_sorting_center: 'in_transit',
  adopted_at_target_branch: 'in_transit',
  redirected: 'in_transit',
  ready_to_pickup: 'ready_to_pickup',
  ready_to_pickup_from_pok: 'ready_to_pickup',
  ready_to_pickup_from_branch: 'ready_to_pickup',
  avizo: 'ready_to_pickup',
  stack_in_box_machine: 'ready_to_pickup',
  stack_in_customer_service_point: 'ready_to_pickup',
  pickup_reminder_sent: 'ready_to_pickup',
  delivered: 'delivered',
  returned_to_sender: 'returned_to_sender',
  return_in_transit: 'returned_to_sender',
  problem: 'problem',
  delivery_failed: 'problem',
  undelivered: 'problem',
  lost: 'problem',
  missing: 'problem',
  claimed: 'problem',
  rejected_by_receiver: 'problem',
  pickup_time_expired: 'problem',
};

/** Group of a carrier code; null for codes before pickup (created, confirmed), cancelled labels and unknown codes. */
export function shipmentStatusOf(code: string | null | undefined): ShipmentStatus | null {
  return code ? GROUPS[code] ?? null : null;
}
