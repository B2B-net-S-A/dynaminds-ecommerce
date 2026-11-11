/** PRODUKTY · N POZYCJE on the order card: scan bar, lines with bin location and scan state, totals.
 * Editing keeps the existing line endpoints (POST/PATCH/DELETE /api/orders/:id/items). */
import { useEffect, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { money } from './api';
import { OrderAddItemForm, OrderLineQuantity, type OrderAction } from './order-detail-parts';
import { SectionLockNote, type SectionControl } from './order-card-section';
import { lineScan, positionsLabel, scanProgress, type Row } from './order-card-model';
import { ITEM_MISSING_STATUSES, MissingItemButton, itemMissingPath } from './order-item-missing';

export function OrderProductsCard({ order: o, control, action, scanForm }: { order: Row; control: SectionControl; action: OrderAction; scanForm?: ReactNode }) {
  const replacement = o.fulfillment_kind === 'replacement';
  const editing = control.edit?.section === 'products';
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (!editing) setAdding(false); }, [editing]);
  const lock = control.locks.products;
  const progress = scanProgress(o);
  const linesTotal = o.items.reduce((n: number, i: Row) => n + i.line_total, 0);
  const busy = control.busy;
  // "Zgłoś brak" (automation event order.item_missing) while goods are collected, for people who may write.
  const reportMissing = control.canEdit && !replacement && !editing && ITEM_MISSING_STATUSES.includes(o.status);
  return (
    <section className="panel order-products" aria-label="Produkty">
      <div className="panel-heading">
        <div>
          <h2>{replacement ? 'POZYCJE REALIZACJI' : 'PRODUKTY'} · {positionsLabel(o.items.length)}</h2>
          {replacement && <p>Bezpłatne zamienniki i fizyczny zakres realizacji reklamacji.</p>}
          {editing && <p>Ceny nowych produktów pochodzą z katalogu lub cennika zamówienia, rezerwacje magazynu są przeliczane.</p>}
        </div>
        <div className="order-section-heading-actions">
          {lock.locked ? (
            <SectionLockNote lock={lock} onAction={control.onLockAction} />
          ) : control.canEdit && !replacement ? (
            editing ? (
              <button type="button" className="text-button" onClick={control.onCancel}>Zakończ edycję</button>
            ) : (
              <>
                <button type="button" className="text-button" disabled={busy} onClick={() => control.onEdit('products')}>✎ Edytuj</button>
                <span className="muted" aria-hidden="true">·</span>
                <button type="button" className="text-button" disabled={busy} onClick={() => { control.onEdit('products'); setAdding(true); }}>+ Dodaj produkt</button>
              </>
            )
          ) : null}
          {editing && !adding && (
            <button type="button" className="button" disabled={busy} onClick={() => setAdding(true)}>+ Dodaj produkt</button>
          )}
        </div>
      </div>
      {progress.total > 0 && (
        <div className="order-scan-bar" role="progressbar" aria-label="Postęp skanowania" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.scanned}>
          <span>Zeskanowano {progress.scanned} z {progress.total}</span>
          <span className="order-scan-track"><span style={{ width: progress.percent + '%' }} /></span>
          <strong>{progress.percent}%</strong>
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Produkt</th>
              <th>Lokalizacja</th>
              <th>Skan</th>
              <th>Ilość</th>
              <th className="right">Brutto</th>
              {editing && <th aria-label="Akcje" />}
            </tr>
          </thead>
          <tbody>
            {o.items.map((i: Row) => {
              const scan = lineScan(o, i);
              const complete = scan && scan.scanned >= scan.quantity;
              return (
                <tr key={i.id}>
                  <td>
                    <strong>{i.name}</strong>
                    <small>{i.sku}</small>
                    {reportMissing && (
                      <MissingItemButton quantity={i.quantity} scanned={scan?.scanned} busy={busy} onReport={(body) => action(itemMissingPath(o.id, i.id), body)} />
                    )}
                  </td>
                  <td>{scan?.locations.length ? scan.locations.map((l) => <code key={l}>{l}</code>) : <span className="muted">—</span>}</td>
                  <td>
                    {scan ? (
                      <span className={'scan-count' + (complete ? ' complete' : '')}>
                        {complete && <Check size={14} />} {scan.scanned}/{scan.quantity}
                      </span>
                    ) : (
                      <span className="muted" title="Zestaw: skanuje się składniki">zestaw</span>
                    )}
                  </td>
                  <td>{editing ? <OrderLineQuantity order={o} item={i} busy={busy} action={action} /> : i.quantity}</td>
                  <td className="right">{money(i.line_total, o.currency)}</td>
                  {editing && (
                    <td className="right">
                      <button
                        className="button danger subtle"
                        disabled={busy || o.items.length < 2}
                        title={o.items.length < 2 ? 'Zamówienie musi mieć co najmniej jedną pozycję.' : undefined}
                        onClick={() => {
                          if (confirm(`Usunąć ${i.name} z zamówienia?`))
                            action(`/orders/${o.id}/items/${i.id}?expected_version=${encodeURIComponent(String(o.version))}`, undefined, 'DELETE');
                        }}
                      >
                        Usuń
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing && adding && <OrderAddItemForm order={o} busy={busy} action={action} onClose={() => setAdding(false)} />}
      <div className="order-lines-total">
        <span>Produkty</span><strong>{money(linesTotal, o.currency)}</strong>
        <span>Dostawa</span><strong>{money(o.shipping_cost, o.currency)}</strong>
        <span>Razem brutto</span><strong>{money(o.total, o.currency)}</strong>
      </div>
      {scanForm}
    </section>
  );
}
