/**
 * "Anuluj etykietę" keeps the cancelled label row (status 'canceled'); migration 268 lets a new label take it over.
 * The label forms of the logistics tab count only labels that are still in force.
 */
interface ShipmentRow {
  status: string;
  dispatched_at?: string | null;
}

/** A label cancelled before hand-over: it neither blocks a new label nor is printed. */
export const isCancelledLabel = (s: ShipmentRow): boolean => s.status === 'canceled' && !s.dispatched_at;

/** Shipments that still stand in the way of a new label. */
export const liveShipments = <T extends ShipmentRow>(shipments: readonly T[]): T[] => shipments.filter((s) => !isCancelledLabel(s));

/** The order's only label was cancelled, so "Nowa etykieta" applies. */
export const needsNewLabel = (shipments: readonly ShipmentRow[]): boolean =>
  shipments.length > 0 && liveShipments(shipments).length === 0;
