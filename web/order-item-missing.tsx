// "Zgłoś brak" at an order line (order card and the WMS packing screen): POST /api/orders/:id/items/:itemId/missing.
// The report changes nothing in the order; it is an order event (order.item_missing) for automation rules v2.
import { useState, type FormEvent } from 'react';

/** Stages in which goods are still being collected (server/order-item-missing.ts ITEM_MISSING_STATUSES). */
export const ITEM_MISSING_STATUSES = ['paid', 'picking', 'packed'];

export const itemMissingPath = (orderId: string, itemId: string) => `/orders/${orderId}/items/${itemId}/missing`;

/** Pieces not yet scanned are the likely missing ones; at least one. */
export function defaultMissing(quantity: number, scanned: number | undefined): number {
  return Math.max(1, quantity - (scanned ?? 0));
}

interface MissingItemButtonProps {
  quantity: number;
  scanned?: number;
  busy?: boolean;
  /** Sends the report; resolves true when it was saved. */
  onReport: (body: { quantity_missing: number; client_key: string }) => Promise<boolean>;
}

export function MissingItemButton({ quantity, scanned, busy, onReport }: MissingItemButtonProps) {
  const [open, setOpen] = useState(false),
    [value, setValue] = useState(String(defaultMissing(quantity, scanned))),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [error, setError] = useState('');
  if (!open)
    return (
      <button
        type="button"
        className="text-button"
        disabled={busy}
        onClick={() => {
          setValue(String(defaultMissing(quantity, scanned)));
          setError('');
          setOpen(true);
        }}
      >
        Zgłoś brak
      </button>
    );
  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > quantity) {
      setError(`Podaj liczbę od 1 do ${quantity}`);
      return;
    }
    if (await onReport({ quantity_missing: n, client_key: key })) {
      setOpen(false);
      setKey(crypto.randomUUID());
    }
  }
  return (
    <form className="item-missing-form" onSubmit={submit} aria-label="Zgłoś brak produktu">
      <label>
        Brakuje (szt.)
        <input type="number" min={1} max={quantity} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      </label>
      <button type="submit" className="button small-btn" disabled={busy}>Zgłoś</button>
      <button type="button" className="text-button" onClick={() => setOpen(false)}>Anuluj</button>
      {error && <small className="error-text" role="alert">{error}</small>}
    </form>
  );
}
