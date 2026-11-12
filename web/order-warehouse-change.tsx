/** "Zmień magazyn" in the order card's "⋯ Więcej" menu (migration 269): the order and its reservations move to
 * another warehouse of the company. Offered before picking only (Nieopłacone/Nowe), for a sale that is not a split
 * or merge result; the server makes the full check (documents, shipping, stock in the new warehouse) and refuses in
 * Polish, nothing changing then. */
import { useState } from 'react';
import { Warehouse } from 'lucide-react';

type Row = Record<string, any>;
export type WarehouseOption = { id: string; name: string };

/** Whether the card offers the action; the server still decides. */
export function canChangeOrderWarehouse(o: Row): boolean {
  return ['new', 'paid'].includes(o.status) && (o.fulfillment_kind ?? 'sale') === 'sale' && !['order_split', 'order_merge'].includes(o.source) && !o.merge_claim;
}
/** Warehouses the order can move to: every other warehouse of the company, by name. */
export function warehouseChoices(all: WarehouseOption[], current: string): WarehouseOption[] {
  return all.filter((w) => w.id !== current).sort((a, b) => a.name.localeCompare(b.name, 'pl'));
}

export function OrderWarehouseChange({ order: o, busy, loadWarehouses, onMove }: {
  order: Row;
  busy: boolean;
  loadWarehouses: () => Promise<WarehouseOption[]>;
  /** Sends the move; true when it was saved. */
  onMove: (warehouseId: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<WarehouseOption[] | null>(null);
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  if (!canChangeOrderWarehouse(o)) return null;
  const current = all?.find((w) => w.id === o.warehouse_id)?.name;
  const choices = all ? warehouseChoices(all, o.warehouse_id) : [];
  async function start() {
    setOpen(true);
    setError('');
    try {
      const list = await loadWarehouses();
      setAll(list);
      setTarget(warehouseChoices(list, o.warehouse_id)[0]?.id ?? '');
    } catch {
      setError('Nie udało się wczytać listy magazynów.');
    }
  }
  if (!open)
    return (
      <button type="button" className="button" data-keep-open disabled={busy} onClick={() => void start()}>
        <Warehouse size={16} /> Zmień magazyn
      </button>
    );
  return (
    <form
      className="order-warehouse-change"
      aria-label="Zmień magazyn"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!target) return;
        setError('');
        try {
          if (await onMove(target)) setOpen(false);
        } catch {
          setError('Nie udało się zmienić magazynu. Spróbuj ponownie.');
        }
      }}
    >
      <p className="muted">
        {all && <>Obecny magazyn: <strong>{current ?? '—'}</strong>. </>}Rezerwacje wszystkich pozycji przejdą do nowego magazynu; przy braku
        stanu nic się nie zmieni.
      </p>
      {error && <p role="alert">{error}</p>}
      {!all && !error && <p className="muted">Wczytywanie magazynów…</p>}
      {all && !choices.length && <p className="muted">Firma nie ma innego magazynu.</p>}
      {choices.length > 0 && (
        <label>
          Nowy magazyn
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {choices.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="order-warehouse-change-actions">
        <button className="button primary" disabled={busy || !target}>
          Przenieś zamówienie
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => setOpen(false)}>
          Anuluj
        </button>
      </div>
    </form>
  );
}
