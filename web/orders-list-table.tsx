/**
 * Order list table (Uwagi v3 §3): checkbox, Zamówienie (number + date), Produkty, Klient, Kanał,
 * Status (fulfilment stage), Płatność (payment state), Wartość, then the chosen custom field columns.
 */
import { Box, ChevronRight } from 'lucide-react';
import { FulfilmentBadge, PaymentBadge } from './order-status-badges';
import { date, money } from './api';
import { WorkflowBadge } from './operations';
import { OrderFieldCell, type OrderFieldListSelection } from './order-fields';
import { type PaymentState } from './order-stage';
import { polishCount } from './order-status-panel';
import './order-filters.css';

/** Selection limit of the batch endpoints. */
export const MAX_SELECTION = 100;

const orderSourceLabels: Record<string, string> = {
  manual: 'Ręczne',
  demo: 'Demo',
  b2b: 'Kontrahenci B2B',
  order_merge: 'Połączone zamówienia',
  prestashop: 'PrestaShop',
  shopify: 'Shopify',
  ebay: 'eBay',
  amazon: 'Amazon',
  odoo: 'Odoo',
  woocommerce: 'WooCommerce',
  allegro: 'Allegro',
  olx: 'OLX',
  ceneo: 'Ceneo',
  mirakl: 'Mirakl',
};
export const orderSourceLabel = (source: string) => orderSourceLabels[source] || source;

/** Fulfilment stage with its semantic colour and label (web/order-status-badges.tsx). */
export const StageBadge = FulfilmentBadge;

export function OrderListPaymentPill({ order: o }: { order: any }) {
  if (o.amount_due === undefined || o.status === 'cancelled') return <small>—</small>;
  const due = Number(o.amount_due);
  const state: PaymentState = o.payment_state ?? (due === 0 ? 'paid' : o.payment_mode === 'cod' ? 'cod' : 'unpaid');
  return (
    <>
      <PaymentBadge state={state} />
      {due > 0 && (
        <small>
          {o.payment_mode === 'cod' ? 'do pobrania ' : 'do zapłaty '}
          {money(due, o.currency)}
        </small>
      )}
    </>
  );
}

export function OrderTable({
  rows,
  onOrder,
  compact = false,
  selected,
  onToggle,
  fieldColumns = [],
}: {
  fieldColumns?: OrderFieldListSelection['columns'];
  selected?: string[];
  onToggle?: (ids: string[]) => void;
  rows: any[];
  onOrder: (id: string) => void;
  /** Dashboard: number, customer, status and value only. */
  compact?: boolean;
}) {
  if (!rows.length)
    return (
      <div className="empty">
        <Box size={30} />
        <p>Brak zamówień dla wybranych filtrów.</p>
      </div>
    );
  const chosen = selected ?? [];
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {onToggle && (
              <th>
                <input
                  type="checkbox"
                  className="order-select"
                  aria-label="Zaznacz wszystkie widoczne zamówienia"
                  checked={rows.length > 0 && rows.slice(0, MAX_SELECTION).every((o) => chosen.includes(o.id))}
                  onChange={(e) => onToggle(e.target.checked ? rows.slice(0, MAX_SELECTION).map((o) => o.id) : [])}
                />
              </th>
            )}
            <th>Zamówienie</th>
            {!compact && <th>Produkty</th>}
            <th>Klient</th>
            {!compact && <th>Kanał</th>}
            <th>Status</th>
            {!compact && <th>Płatność</th>}
            <th className="right">Wartość</th>
            {!compact && fieldColumns.map((d) => <th key={d.id}>{d.label}</th>)}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id} className={'clickable' + (chosen.includes(o.id) ? ' selected-row' : '')} onClick={() => onOrder(o.id)}>
              {onToggle && (
                <td onClick={(e) => e.stopPropagation()}>
                  <input
                    className="order-select"
                    type="checkbox"
                    aria-label={'Zaznacz ' + o.number}
                    checked={chosen.includes(o.id)}
                    disabled={!chosen.includes(o.id) && chosen.length >= MAX_SELECTION}
                    onChange={(e) =>
                      onToggle(
                        e.target.checked ? [...chosen, o.id].slice(0, MAX_SELECTION) : chosen.filter((id) => id !== o.id),
                      )
                    }
                  />
                </td>
              )}
              <td>
                <button
                  className="order-link"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOrder(o.id);
                  }}
                >
                  {o.number}
                </button>
                <small>{date(o.created_at)}</small>
              </td>
              {!compact && (
                <td>
                  {o.first_item_name ? (
                    <>
                      <span className="order-products">{o.first_item_name}</span>
                      <small>
                        {o.line_count > 1 ? `+ ${polishCount(o.line_count - 1, 'pozycja', 'pozycje', 'pozycji')} · ` : ''}
                        {o.quantity_total ?? o.item_count ?? 0} szt.
                      </small>
                    </>
                  ) : (
                    <small>Brak pozycji</small>
                  )}
                </td>
              )}
              <td>
                <strong className="normal-weight">{o.customer_name}</strong>
                {(o.email || o.address?.city) && <small>{[o.email, o.address?.city].filter(Boolean).join(' · ')}</small>}
              </td>
              {!compact && (
                <td>
                  {orderSourceLabel(o.source)}
                  {o.external_id && <small>{o.external_id}</small>}
                </td>
              )}
              <td>
                <StageBadge stage={o.fulfilment_stage ?? o.status} />
                <WorkflowBadge status={o.workflow_status} />
                {o.tags?.map((t: string) => (
                  <span className="tag-pill" key={t}>
                    {t}
                  </span>
                ))}
              </td>
              {!compact && (
                <td>
                  <OrderListPaymentPill order={o} />
                </td>
              )}
              <td className="right value-cell">{money(o.total, o.currency)}</td>
              {!compact &&
                fieldColumns.map((d) => (
                  <td key={d.id}>
                    <OrderFieldCell definition={d} value={o.extra_fields?.find((v: any) => v.field_id === d.id)} />
                  </td>
                ))}
              <td>
                <ChevronRight size={16} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
