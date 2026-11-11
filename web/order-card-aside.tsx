/** Right column of the order card (client mockup "Karta zamówienia"): KLIENT, ADRES DOSTAWY,
 * PŁATNOŚĆ, DANE DO FAKTURY, DOKUMENTY and, once there are any, PRZESYŁKI. Every section has its own
 * "✎ Edytuj" (order-card-section.tsx). */
import { ExternalLink, FileText, Printer } from 'lucide-react';
import { money } from './api';
import { PortalAccess } from './return-queue';
import { Badge } from './order-card-common';
import { PaymentBadge } from './order-status-badges';
import { useMoreMenu } from './order-card-header';
import { SectionCard, SectionEditControl, SectionForm, type SectionControl } from './order-card-section';
import { cardPaymentState, deliveryMethodLabel, deliveryMethodText, PAYMENT_METHOD_OPTIONS, sectionValuesOf, type Row } from './order-card-model';
import type { OrderAction } from './order-detail-parts';
import type { MessageKind } from './order-card-message';
import type { CardTab } from './order-card-tabs';

export interface OrderAsideProps {
  order: Row;
  control: SectionControl;
  write: boolean;
  busy: boolean;
  portalAdmin: boolean;
  emailBlocked: boolean;
  action: OrderAction;
  onCompose: (kind: MessageKind) => void;
  onOpenTab: (tab: CardTab) => void;
  onPrintShipment: (shipmentId: string) => void;
}

export function OrderAside(p: OrderAsideProps) {
  return (
    <aside className="order-card-aside">
      <CustomerCard {...p} />
      <DeliveryCard {...p} />
      <PaymentCard {...p} />
      <InvoiceCard {...p} />
      <DocumentsCard {...p} />
      {p.order.shipments.length > 0 && <ShipmentsCard {...p} />}
    </aside>
  );
}

function CustomerCard({ order: o, control, write, busy, portalAdmin, emailBlocked, action, onCompose }: OrderAsideProps) {
  const c = sectionValuesOf(o, 'customer');
  const canAdd = control.canEdit && !control.locks.customer.locked;
  const menuRef = useMoreMenu();
  const menu = (
    <details className="order-more order-card-menu" ref={menuRef}>
      <summary className="icon-btn" aria-label="Więcej akcji klienta">⋯</summary>
      <div className="order-more-menu">
        <strong className="order-menu-title">Portal kupującego</strong>
        <PortalAccess order={o} admin={portalAdmin} busy={busy} action={action} />
      </div>
    </details>
  );
  return (
    <SectionCard section="customer" title="Klient" control={control} aside={menu}>
      <div className="order-customer-head">
        <div className="customer-avatar">{(c.name || '?').slice(0, 1)}</div>
        <div>
          <h3>{c.name}</h3>
          {c.company && <p>{c.company}</p>}
        </div>
      </div>
      <p>{c.email || <span className="muted">Brak e-maila</span>}</p>
      {c.phone ? (
        <p>{c.phone}</p>
      ) : (
        <p className="order-warning">
          ⚠ Brak telefonu (wymagany przez kuriera)
          {canAdd && (
            <button type="button" className="text-button" disabled={busy} onClick={() => control.onEdit('customer')}>
              Dodaj
            </button>
          )}
        </p>
      )}
      {write && (
        <div className="order-contact-actions">
          <button
            type="button"
            className="button"
            disabled={busy || !c.email || emailBlocked}
            title={!c.email ? 'Zamówienie nie ma adresu e-mail.' : emailBlocked ? 'Najpierw rozstrzygnij niepewny zapis skrzynki email.' : undefined}
            onClick={() => onCompose('email')}
          >
            ✉ Wyślij e-mail
          </button>
          <button
            type="button"
            className="button"
            disabled={busy || !c.phone}
            title={!c.phone ? 'Zamówienie nie ma numeru telefonu.' : undefined}
            onClick={() => onCompose('sms')}
          >
            💬 Wyślij SMS
          </button>
        </div>
      )}
    </SectionCard>
  );
}

function DeliveryCard({ order: o, control }: OrderAsideProps) {
  const a = sectionValuesOf(o, 'delivery_address');
  const portalDelivery =
    o.effective_delivery?.delivery && String(o.effective_delivery.delivery_version ?? '0') !== '0' ? o.effective_delivery.delivery : null;
  const methodEditing = control.edit?.section === 'delivery_method';
  const method = sectionValuesOf(o, 'delivery_method');
  return (
    <SectionCard section="delivery_address" title="Adres dostawy" control={control}>
      <p>
        {a.recipient}
        <br />
        {a.street}
        <br />
        {a.postal_code} {a.city}
        <br />
        {a.country}
        {a.pickup_point && (
          <>
            <br />
            Punkt odbioru: {a.pickup_point}
          </>
        )}
      </p>
      {portalDelivery && (
        <p className="notice">
          Kupujący zmienił adres dostawy: {portalDelivery.recipient_name}, {portalDelivery.street}, {portalDelivery.postal_code} {portalDelivery.city}.
          Szczegóły w zakładce „Historia adresu”.
        </p>
      )}
      <div className="order-subsection">
        <div className="order-subsection-heading">
          <strong>Sposób dostawy</strong>
          <SectionEditControl section="delivery_method" control={control} />
        </div>
        {methodEditing ? (
          <SectionForm section="delivery_method" control={control} />
        ) : (
          <div className="order-kv">
            <span>Sposób</span>
            <span>{method.method ? deliveryMethodLabel(method.method) : deliveryMethodText(o)}</span>
            {method.carrier && (
              <>
                <span>Przewoźnik</span>
                <span>{method.carrier}</span>
              </>
            )}
            <span>Koszt</span>
            <span>{money(method.cost, o.currency)}</span>
          </div>
        )}
      </div>
      <p className="order-shipment-state">
        {o.shipments.length
          ? 'Przesyłka: ' + o.shipments.map((s: Row) => s.tracking_number).join(', ')
          : 'Przesyłka jeszcze nie nadana'}
      </p>
    </SectionCard>
  );
}

function PaymentCard({ order: o, control, write, busy, action, onOpenTab }: OrderAsideProps) {
  const replacement = o.fulfillment_kind === 'replacement';
  const state = cardPaymentState(o);
  const values = sectionValuesOf(o, 'payment');
  const methodLabel = replacement
    ? 'Bez płatności'
    : o.payment_mode === 'cod'
      ? 'Pobranie przy odbiorze'
      : PAYMENT_METHOD_OPTIONS.find((m) => m.value === values.method)?.label ?? 'Przedpłata';
  return (
    <SectionCard section="payment" title="Płatność" control={control} aside={state && <PaymentBadge state={state} />}>
      <div className="order-kv">
        <span>Forma</span>
        <span>{methodLabel}</span>
        <span>Wpłacono</span>
        <span>{money(o.payment?.received ?? 0, o.currency)}</span>
        <span>Do zapłaty</span>
        <span>{money(o.payment?.amount_due ?? 0, o.currency)}</span>
        {values.reference && (
          <>
            <span>Transakcja</span>
            <span>{values.reference}</span>
          </>
        )}
      </div>
      {control.canEdit && !control.locks.payment.locked && !replacement && o.status === 'new' && o.payment_mode !== 'cod' && (
        // Uwagi v3 §1/§6: payment is confirmed in the Płatność section (amount, date), which books it in the
        // ledger; a bare status change would show "Nowe" while the payment state still read "Nieopłacone".
        <button className="button full" disabled={busy} onClick={() => control.onEdit('payment')}>
          Potwierdź wpłatę
        </button>
      )}
      <button type="button" className="text-button" onClick={() => onOpenTab('more')}>
        Wpłaty, zwroty środków i pobrania
      </button>
    </SectionCard>
  );
}

function InvoiceCard({ order: o, control }: OrderAsideProps) {
  const v = sectionValuesOf(o, 'invoice');
  return (
    <SectionCard section="invoice" title="Dane do faktury" control={control}>
      {v.wants_invoice ? (
        <p>
          {v.buyer}
          {v.nip && (
            <>
              <br />
              NIP {v.nip}
            </>
          )}
          <br />
          {v.street}
          <br />
          {v.postal_code} {v.city}, {v.country}
        </p>
      ) : (
        <p className="muted">Klient nie prosił o fakturę — dokument sprzedaży na dane klienta.</p>
      )}
    </SectionCard>
  );
}

function DocumentsCard({ order: o, write, busy, action, onOpenTab }: OrderAsideProps) {
  const replacement = o.fulfillment_kind === 'replacement';
  return (
    <section className="panel order-section-card" aria-label="Dokumenty">
      <div className="panel-heading">
        <h2>Dokumenty</h2>
        <FileText size={19} />
      </div>
      <div className="info-body">
        {o.documents.map((d: Row) => (
          <a className="document-link" key={d.id} href={`/api/documents/${d.id}/print`} target="_blank" rel="noreferrer">
            <FileText size={17} />
            {d.number}
            <ExternalLink size={14} />
          </a>
        ))}
        {!o.documents.length && <p className="muted">Brak dokumentów sprzedaży.</p>}
        {!replacement && (
          <button type="button" className="button full" onClick={() => onOpenTab('documents')}>
            Wystaw fakturę lub paragon
          </button>
        )}
        {write && !replacement && ['return_received', 'return_completed'].includes(o.status) && !o.returns?.has_partial && (
          <button className="button full" disabled={busy} onClick={() => action(`/orders/${o.id}/documents`, { kind: 'correction' })}>
            Korekta DEMO
          </button>
        )}
      </div>
    </section>
  );
}

function ShipmentsCard({ order: o, write, onPrintShipment }: OrderAsideProps) {
  return (
    <section className="panel order-section-card" aria-label="Przesyłki">
      <div className="panel-heading">
        <h2>Przesyłki</h2>
      </div>
      <div className="info-body">
        {o.shipments.map((s: Row) => (
          <div key={s.id} className="order-shipment">
            <Badge status={s.mode} />
            <p>
              <strong>{s.tracking_number}</strong>
              <br />
              {s.carrier}
            </p>
            {/* A cancelled label (shipment-cancel.ts) keeps its row but is not printed any more. */}
            {s.status === 'canceled' ? (
              <span className="muted">Etykieta anulowana</span>
            ) : (
              <>
                <a className="button" href={`/api/shipments/${s.id}/label`} target="_blank" rel="noreferrer">
                  <Printer size={16} /> {s.mode === 'demo' ? 'Etykieta testowa' : 'Etykieta PDF'}
                </a>
                <button className="button" disabled={!write} onClick={() => onPrintShipment(s.id)}>
                  <Printer size={16} /> Zleć druk etykiety
                </button>
              </>
            )}
          </div>
        ))}
        {/* Migration 268: a new label took over the cancelled one; the cancelled label stays in the history. */}
        {(o.replaced_labels ?? []).map((r: Row) => (
          <div key={r.tracking_number} className="order-shipment">
            <p className="muted">
              <s>{r.tracking_number}</s>
              <br />
              {r.carrier}: etykieta anulowana, zastąpiona przez {r.replaced_by}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
