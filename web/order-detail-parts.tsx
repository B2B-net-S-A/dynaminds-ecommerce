/** Order card pieces built around fulfilment: flow stepper, payment pill, notes with history,
 * buyer/delivery edit form, add-product form and inline line quantity. Writes go through the
 * caller's `action`, which keeps the order card's read-only and lock custody. */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import { money, date, statusNames } from './api';
import { ProductPicker } from './catalog';
import { SECTION_LABELS, type OrderSection, type SectionChange } from '../shared/order-sections';
import { historyEvents } from './order-card-model';
import { SHIPMENT_STATUS_LABELS, type ShipmentStatus } from '../shared/shipment-status';
import { fulfilmentLabels, fulfilmentPath, type FulfilmentStage } from './order-stage';
import './order-detail.css';
import './order-status.css';

type Row = Record<string, any>;
export type OrderAction = (path: string, body?: unknown, method?: string) => Promise<boolean>;

/** Main flow: always the seven fulfilment steps; payment (code `new`) is a separate indicator, not a step. */
export function orderFlowSteps(): FulfilmentStage[] {
  return [...fulfilmentPath];
}
export function OrderFlowStepper({ order: o }: { order: Row }) {
  const steps = orderFlowSteps();
  const replacement = o.fulfillment_kind === 'replacement';
  const stage = o.fulfilment_stage ?? o.status;
  const waiting = o.status === 'new';
  const reached = (s: string) => (o.events ?? []).find((e: Row) => e.kind === 'order.' + s);
  const current = steps.indexOf(stage);
  // On the main flow the current stage is the progress; an order waiting for payment (also one sent back to it)
  // has reached nothing, whatever its history says. A cancelled or returned order shows how far it got.
  const progression = current >= 0 || waiting ? current : Math.max(-1, ...(o.events ?? []).map((e: Row) => steps.indexOf(String(e.kind).replace('order.', '') as FulfilmentStage)));
  const label = (s: FulfilmentStage) => (replacement && s === 'paid' ? 'Gotowe do kompletacji' : fulfilmentLabels[s]);
  // An order created directly as paid has no order.paid event; ready_to_ship has none at all, its label does.
  const when = (s: FulfilmentStage): string | undefined =>
    reached(s)?.created_at ?? (s === 'paid' ? o.created_at : s === 'ready_to_ship' ? o.shipments?.[0]?.created_at : undefined);
  return (
    <ol className="order-flow" aria-label="Etap realizacji zamówienia">
      {steps.map((s, i) => {
        const state = i === current ? 'now' : i <= progression ? 'done' : '';
        const at = i <= progression ? when(s) : undefined;
        return (
          <li key={s} className={`order-stage-${s}${state ? ' ' + state : ''}`} aria-current={i === current ? 'step' : undefined}>
            <span className="order-flow-bar" />
            <strong>
              {state === 'done' && <Check size={13} />} {label(s)}
            </strong>
            <small>{at ? date(at) : ' '}</small>
          </li>
        );
      })}
    </ol>
  );
}

export function orderPaymentState(o: Row): { tone: 'ok' | 'cod' | 'due' | 'none'; label: string } {
  const p = o.payment ?? {};
  if (o.fulfillment_kind === 'replacement') return { tone: 'none', label: 'Bez płatności (wymiana)' };
  if (o.payment_mode === 'cod') return { tone: 'cod', label: 'Pobranie ' + money(p.amount_due ?? o.total, o.currency) };
  if ((p.amount_due ?? o.total) === 0) return { tone: 'ok', label: 'Opłacone ' + money(p.net ?? o.total, o.currency) };
  return { tone: 'due', label: 'Nieopłacone · do zapłaty ' + money(p.amount_due ?? o.total, o.currency) };
}
export function OrderPaymentPill({ order }: { order: Row }) {
  const s = orderPaymentState(order);
  return <span className={'order-pill ' + s.tone}>{s.tone === 'ok' && <Check size={13} />}{s.label}</span>;
}

const EVENT_LABELS: Record<string, string> = {
  'order.created': 'Utworzono zamówienie',
  'order.paid': 'Płatność potwierdzona — zamówienie gotowe do realizacji',
  'order.payment_reopened': 'Dopłata do zapłaty — zamówienie wróciło do Nieopłacone',
  'order.picking': 'Przekazano do kompletacji',
  'order.packed': 'Spakowano',
  'order.shipped': 'Nadano przesyłkę',
  'order.delivered': 'Dostarczono',
  'order.completed': 'Zakończono zamówienie',
  'order.cancelled': 'Anulowano zamówienie',
  'order.note_added': 'Dodano notatkę',
  'order.customer_updated': 'Zmieniono dane klienta',
  'order.item_added': 'Dodano produkt',
  'order.item_quantity_changed': 'Zmieniono ilość produktu',
  'order.item_removed': 'Usunięto produkt',
  'order.delivery_address_changed': 'Zmieniono adres dostawy',
  'payment.receipt': 'Zapisano wpłatę',
  'payment.courier_collection': 'Potwierdzono pobranie przez kuriera',
  'payment.courier_remittance': 'Zapisano rozliczenie kuriera',
  'payment.refund': 'Potwierdzono zwrot środków',
  'payment.reversal': 'Skorygowano wpis płatności',
  'return.photo_created': 'Wykonano zdjęcie produktów zwrotu',
  'return.requested': 'Zgłoszono sprawę zwrotową',
  'return.received': 'Przyjęto pozycje zwrotu',
  'return.refund_recorded': 'Zapisano potwierdzenie rozliczenia',
  'return.rejected': 'Odrzucono zgłoszenie',
  'return.cancelled': 'Anulowano zgłoszenie',
  // Uwagi v3 §0/§6/§7: automation rules, payment state, labels and documents.
  'automation.manual_run': 'Uruchomiono akcję ręcznie',
  'automation.barcode_run': 'Uruchomiono akcję kodem kreskowym',
  'automation.rule_applied': 'Wykonano regułę automatyczną',
  'automation.notify': 'Powiadomiono zespół',
  'order.workflow_changed': 'Zmieniono status własny',
  'payment.changed': 'Zmieniono status płatności',
  'shipment.created': 'Utworzono przesyłkę',
  'shipment.label_created': 'Wygenerowano etykietę — gotowe do nadania',
  'shipment.demo_label': 'Wygenerowano etykietę DEMO — gotowe do nadania',
  'shipment.status_changed': 'Zmiana statusu przesyłki u przewoźnika',
  'document.issued': 'Wystawiono dokument',
  // Automation rules v2 events (lane J).
  'order.item_missing': 'Zgłoszono brak produktu przy kompletacji',
  'stock.changed': 'Zmienił się stan magazynowy produktu',
  'shipment.cancelled': 'Anulowano etykietę — zamówienie wróciło do Spakowane',
  'customer_message.received': 'Wiadomość od klienta',
};
const MESSAGE_CHANNELS: Record<string, string> = {
  email: 'e-mail', portal: 'portal kupującego', allegro: 'Allegro', ebay: 'eBay', amazon: 'Amazon', helpdesk: 'helpdesk',
};
const PAYMENT_STATE_PL: Record<string, string> = {
  unpaid: 'Nieopłacone', paid: 'Opłacone', partial: 'Częściowo', overpaid: 'Nadpłata', cod: 'Pobranie',
};
const FIELD_LABELS: Record<string, string> = {
  customer_name: 'nazwa', email: 'e-mail', phone: 'telefon', street: 'ulica', postal_code: 'kod pocztowy', city: 'miejscowość',
};
export function orderEventText(e: Row, replacement = false): { title: string; detail?: string; changes?: SectionChange[] } {
  const d = e.detail ?? {};
  if (e.kind === 'order.section_edited') {
    const section = SECTION_LABELS[d.section as OrderSection] ?? d.section ?? 'zamówienie';
    const changes: SectionChange[] = Array.isArray(d.changes) ? d.changes : [];
    return { title: [`Edycja: ${section}`, date(e.created_at), d.actor_name].filter(Boolean).join(' · '), changes };
  }
  if (e.kind === 'item.scanned') return { title: `Zeskanowano ${d.sku ?? ''}`.trim() };
  if (replacement && e.kind === 'order.paid') return { title: 'Gotowe do kompletacji' };
  const title = EVENT_LABELS[e.kind] ?? statusNames[String(e.kind).replace('order.', '')] ?? e.kind;
  if (e.kind === 'order.item_added') return { title, detail: `${d.sku} · ${d.quantity} szt.` };
  if (e.kind === 'order.item_quantity_changed') return { title, detail: `${d.sku} · ${d.from} → ${d.to} szt.` };
  if (e.kind === 'order.item_removed') return { title, detail: `${d.sku} · ${d.quantity} szt.` };
  // A rule's own summary ("Reguła X: Dodano tag Y") says more than the generic label.
  if ((e.kind === 'automation.rule_applied' || e.kind === 'automation.notify') && typeof d.message === 'string' && d.message)
    return { title: d.message };
  if (e.kind === 'order.tags_changed')
    return { title: d.operation === 'remove_tag' ? 'Usunięto tag' : 'Dodano tag', detail: d.tag ? String(d.tag) : undefined };
  if (e.kind === 'payment.changed' && (d.from || d.to))
    return { title, detail: `${PAYMENT_STATE_PL[d.from] ?? d.from ?? '—'} → ${PAYMENT_STATE_PL[d.to] ?? d.to ?? '—'}` };
  if (e.kind === 'document.issued' && d.number) return { title, detail: String(d.number) };
  if (e.kind === 'shipment.status_changed' && (d.status || d.to))
    return { title, detail: SHIPMENT_STATUS_LABELS[d.status as ShipmentStatus] ?? String(d.to ?? d.status) };
  if (e.kind === 'order.item_missing')
    return { title, detail: [`${d.sku ?? ''} · brakuje ${d.quantity_missing ?? '?'} szt.`, d.actor?.name].filter(Boolean).join(' · ') };
  if (e.kind === 'stock.changed') return { title, detail: `${d.sku ?? ''} · stan ${d.before} → ${d.after} szt.` };
  if (e.kind === 'shipment.cancelled')
    return { title, detail: [d.carrier, d.tracking_number, d.scope === 'simulation' ? 'symulacja przewoźnika' : null].filter(Boolean).join(' · ') };
  if (e.kind === 'customer_message.received')
    return { title: `${title} (${MESSAGE_CHANNELS[d.channel] ?? d.channel ?? 'kanał nieznany'})`, detail: d.excerpt ? String(d.excerpt) : undefined };
  if (e.kind === 'order.customer_updated' && Array.isArray(d.fields))
    return { title, detail: d.fields.map((f: string) => FIELD_LABELS[f] ?? f).join(', ') };
  return { title };
}

/** Notes are the order's note lines; history is the event timeline, newest first. */
export function OrderNotesPanel({ order: o, write, busy, action }: { order: Row; write: boolean; busy: boolean; action: OrderAction }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | OrderSection>('all');
  useEffect(() => { setNote(''); setError(''); setFilter('all'); }, [o.id]);
  const history = historyEvents(o.events, filter);
  const notes = String(o.note ?? '').split('\n').map((n) => n.trim()).filter(Boolean);
  const replacement = o.fulfillment_kind === 'replacement';
  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = note.trim();
    if (!text) return setError('Wpisz treść notatki.');
    if (text.length > 500) return setError('Notatka może mieć najwyżej 500 znaków.');
    setError('');
    if (await action(`/orders/${o.id}/operations`, { type: 'add_note', note: text })) setNote('');
  }
  return (
    <section className="panel order-notes">
      <div className="panel-heading">
        <div>
          <h2>Notatki i historia</h2>
          <p>Notatki zespołu i zapisane zdarzenia zamówienia</p>
        </div>
        <label className="order-history-filter">
          Sekcja:
          <select value={filter} onChange={(e) => setFilter(e.target.value as 'all' | OrderSection)} aria-label="Sekcja historii">
            <option value="all">wszystkie</option>
            {(Object.keys(SECTION_LABELS) as OrderSection[]).map((k) => (
              <option key={k} value={k}>{SECTION_LABELS[k]}</option>
            ))}
          </select>
        </label>
      </div>
      {write && (
        <form className="order-note-form" onSubmit={submit}>
          <label>
            Nowa notatka
            <textarea value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)}
              placeholder="Np. pakować osobno, klient prosi o kontakt przed wysyłką" />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="button primary" disabled={busy || !note.trim()}>Dodaj notatkę</button>
        </form>
      )}
      {notes.length > 0 && (
        <div className="order-note-list">
          {notes.map((n, i) => (
            <div className="note" key={i}>
              <strong>Notatka</strong>
              <p>{n}</p>
            </div>
          ))}
        </div>
      )}
      <div className="timeline">
        {history.map((e: Row) => {
          const t = orderEventText(e, replacement);
          return (
            <div key={e.id}>
              <span className="timeline-dot" />
              <div>
                <strong>{t.title}</strong>
                {t.detail && <small>{t.detail}</small>}
                {t.changes ? (
                  <ul className="order-history-changes">
                    {t.changes.map((c, i) => (
                      <li key={c.field + i}>{c.label}: {c.before || '—'} → {c.after || '—'}</li>
                    ))}
                  </ul>
                ) : (
                  <small>{date(e.created_at)}</small>
                )}
              </div>
            </div>
          );
        })}
        {!history.length && <p className="muted">Brak zdarzeń dla wybranej sekcji.</p>}
      </div>
    </section>
  );
}

export function Dialog({ title, onClose, children, className }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);
  return (
    <div className="modal-shade" onClick={onClose}>
      <section className={className ? 'modal ' + className : 'modal'} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Zamknij" onClick={onClose}><X size={20} /></button>
        </header>
        {children}
      </section>
    </div>
  );
}

export type CustomerForm = { customer_name: string; email: string; phone: string; street: string; postal_code: string; city: string };
/** Client-side checks mirror the server schema; the server stays the authority. */
export function customerFormErrors(f: CustomerForm, emailRequired = true): string[] {
  const errors: string[] = [];
  if (f.customer_name.trim().length < 2) errors.push('Nazwa klienta musi mieć co najmniej 2 znaki.');
  if (f.customer_name.trim().length > 200) errors.push('Nazwa klienta może mieć najwyżej 200 znaków.');
  const email = f.email.trim();
  if (!email && emailRequired) errors.push('Podaj adres e-mail klienta.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Nieprawidłowy adres e-mail.');
  if (!/^[0-9+()\s-]*$/.test(f.phone.trim())) errors.push('Telefon może zawierać tylko cyfry, spacje oraz znaki + - ( ).');
  if (f.phone.trim().length > 30) errors.push('Telefon może mieć najwyżej 30 znaków.');
  if (f.street.trim().length > 200) errors.push('Ulica może mieć najwyżej 200 znaków.');
  if (f.postal_code.trim().length > 20) errors.push('Kod pocztowy może mieć najwyżej 20 znaków.');
  if (f.city.trim().length > 100) errors.push('Miejscowość może mieć najwyżej 100 znaków.');
  return errors;
}
export function OrderCustomerModal({ order: o, busy, action, onClose }: { order: Row; busy: boolean; action: OrderAction; onClose: () => void }) {
  const a = o.address ?? {};
  const [f, setF] = useState<CustomerForm>({
    customer_name: o.customer_name ?? '', email: o.email ?? '', phone: a.phone ?? '', street: a.street ?? '', postal_code: a.postal_code ?? '', city: a.city ?? '',
  });
  const [errors, setErrors] = useState<string[]>([]);
  const field = (key: keyof CustomerForm, label: string, extra: Row = {}) => (
    <label>
      {label}
      <input value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} {...extra} />
    </label>
  );
  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = customerFormErrors(f, o.source !== 'amazon');
    setErrors(found);
    if (found.length) return;
    const body = { expected_version: String(o.version), ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim()])) };
    if (await action(`/orders/${o.id}/customer`, body, 'PATCH')) onClose();
  }
  return (
    <Dialog title="Edytuj dane klienta i dostawy" onClose={onClose}>
      <form className="form-body order-customer-form" onSubmit={submit} noValidate>
        {field('customer_name', 'Imię i nazwisko lub nazwa firmy', { autoFocus: true, maxLength: 200 })}
        <div className="order-form-row">
          {field('email', 'E-mail', { type: 'email', maxLength: 254 })}
          {field('phone', 'Telefon', { inputMode: 'tel', maxLength: 30 })}
        </div>
        <div className="form-section-title">Adres dostawy</div>
        {field('street', 'Ulica i numer', { maxLength: 200 })}
        <div className="order-form-row">
          {field('postal_code', 'Kod pocztowy', { maxLength: 20 })}
          {field('city', 'Miejscowość', { maxLength: 100 })}
        </div>
        <p className="muted">Kraj {a.country ?? 'PL'}{a.locker_code ? ` i punkt odbioru ${a.locker_code}` : ''} pozostają bez zmian.</p>
        {errors.length > 0 && (
          <ul className="error" role="alert">{errors.map((x) => <li key={x}>{x}</li>)}</ul>
        )}
        <div className="order-form-actions">
          <button type="button" className="button" onClick={onClose}>Anuluj</button>
          <button className="button primary" disabled={busy}>Zapisz dane</button>
        </div>
      </form>
    </Dialog>
  );
}

export function OrderAddItemForm({ order: o, busy, action, onClose }: { order: Row; busy: boolean; action: OrderAction; onClose: () => void }) {
  const [product, setProduct] = useState<Row | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [error, setError] = useState('');
  const present = new Set((o.items ?? []).map((i: Row) => i.product_id));
  async function submit(e: FormEvent) {
    e.preventDefault();
    const q = Number(quantity);
    if (!product) return setError('Wybierz produkt.');
    if (present.has(product.id)) return setError('Produkt jest już w zamówieniu. Zmień ilość w jego pozycji.');
    if (!Number.isInteger(q) || q < 1) return setError('Ilość musi być liczbą całkowitą większą od zera.');
    if (q > 100000) return setError('Za duża ilość produktu.');
    setError('');
    if (await action(`/orders/${o.id}/items`, { expected_version: String(o.version), product_id: product.id, quantity: q }, 'POST')) onClose();
  }
  return (
    <form className="order-add-item" onSubmit={submit}>
      <ProductPicker label="Produkt do dodania" value={product?.id ?? ''} initial={product ?? undefined}
        filter={(p) => p.active && p.kind !== 'group'} select={(p) => setProduct(p ?? null)} />
      <label>
        Ilość
        <input aria-label="Ilość dodawanego produktu" type="number" min="1" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </label>
      {product && <small className="muted">Cena z katalogu lub cennika zamówienia, przeliczona przy zapisie.</small>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="order-form-actions">
        <button type="button" className="button" onClick={onClose}>Anuluj</button>
        <button className="button primary" disabled={busy}>Dodaj do zamówienia</button>
      </div>
    </form>
  );
}

export function OrderLineQuantity({ order: o, item, busy, action }: { order: Row; item: Row; busy: boolean; action: OrderAction }) {
  const [value, setValue] = useState(String(item.quantity));
  const [error, setError] = useState('');
  useEffect(() => setValue(String(item.quantity)), [item.quantity, o.version]);
  async function save(e: FormEvent) {
    e.preventDefault();
    const q = Number(value);
    if (!Number.isInteger(q) || q < 1) return setError('Ilość musi być liczbą całkowitą większą od zera.');
    setError('');
    if (q !== item.quantity) await action(`/orders/${o.id}/items/${item.id}`, { expected_version: String(o.version), quantity: q }, 'PATCH');
  }
  return (
    <form className="order-line-qty" onSubmit={save}>
      <input aria-label={`Ilość ${item.sku}`} type="number" min="1" step="1" value={value} onChange={(e) => setValue(e.target.value)} />
      <button className="button subtle" disabled={busy || value === String(item.quantity)}>Zapisz</button>
      {error && <small className="error" role="alert">{error}</small>}
    </form>
  );
}
