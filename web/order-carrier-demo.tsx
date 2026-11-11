// "Więcej" → "Symuluj status przewoźnika (DEMO)": a dispatched DEMO shipment has no tracking, so the card sets its
// carrier status by hand (POST /api/orders/:id/demo-shipment-status); automation rules see it like real tracking.
import { SHIPMENT_STATUSES, SHIPMENT_STATUS_LABELS, shipmentStatusOf, type ShipmentStatus } from '../shared/shipment-status';

type Row = Record<string, any>;

/** The latest dispatched DEMO shipment (no carrier account, label not cancelled), or null. */
export function demoShipment(order: Row): Row | null {
  const list: Row[] = (order.shipments ?? []).filter(
    (s: Row) => s.mode === 'demo' && !s.channel_id && s.dispatched_at && s.status !== 'canceled',
  );
  return list.length ? list[list.length - 1] : null;
}

interface DemoCarrierStatusProps {
  order: Row;
  busy: boolean;
  onPick: (status: ShipmentStatus) => void;
}

export function DemoCarrierStatus({ order, busy, onPick }: DemoCarrierStatusProps) {
  const s = demoShipment(order);
  if (!s) return null;
  const current = shipmentStatusOf(s.status);
  return (
    <label className="order-demo-carrier">
      Symuluj status przewoźnika (DEMO)
      <select
        value=""
        disabled={busy}
        aria-label="Symuluj status przewoźnika (DEMO)"
        onChange={(e) => {
          if (e.target.value) onPick(e.target.value as ShipmentStatus);
        }}
      >
        <option value="">{current ? 'Teraz: ' + SHIPMENT_STATUS_LABELS[current] : 'Wybierz status…'}</option>
        {SHIPMENT_STATUSES.map((v) => (
          <option key={v} value={v} disabled={v === s.status}>
            {SHIPMENT_STATUS_LABELS[v]}
          </option>
        ))}
      </select>
    </label>
  );
}
