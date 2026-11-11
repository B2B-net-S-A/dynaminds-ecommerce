import {useEffect, useRef, useState} from 'react';
import {
  ORDER_SPLIT_LIMITS as L, orderSplitPreviewInput, orderSplitUuid, orderSplitVersion,
  type OrderSplitPreviewInput,
} from '../server/order-splits-schema';

export type OrderSplitAllocationSource = {
  order_id: string; version: string; currency: string; shipping_cost: number;
  items: {id: string; name: string; sku: string; quantity: number; price: number; line_total: number}[];
};
export type OrderSplitAllocationProps = {
  source: OrderSplitAllocationSource;
  contextKey?: string;
  readOnly: boolean;
  /** Parent includes unresolved command custody in busy; this editor never resolves it. */
  busy: boolean;
  onPreview: (request: OrderSplitPreviewInput) => void | Promise<void>;
};
type Slot = {id: string; name: string; shipping: string; items: {id: string; quantity: string}[]};
const PAGE = 25;
const amount = (minor: number, currency: string) => new Intl.NumberFormat('pl-PL', {style: 'currency', currency}).format(minor / 100);
const integer = (raw: string) => /^[1-9][0-9]{0,5}$/.test(raw) && Number(raw) <= L.quantity ? Number(raw) : null;
function delivery(raw: string) {
  if (!/^[0-9]{1,8}(?:[.,][0-9]{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.replace(',', '.').split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return minor <= BigInt(L.delivery_minor) ? Number(minor) : null;
}
const newSlot = (index: number): Slot => ({id: crypto.randomUUID(), name: `Zamówienie ${index}`, shipping: '0', items: []});
const sourceIdentity = (source: OrderSplitAllocationSource) => JSON.stringify([source.order_id, source.version, source.currency, source.shipping_cost,
  source.items.map(x => [x.id, x.name, x.sku, x.quantity, x.price, x.line_total])]);
function validSource(source: OrderSplitAllocationSource) {
  return !!source && orderSplitUuid.safeParse(source.order_id).success && orderSplitVersion.safeParse(source.version).success &&
    ['PLN', 'EUR', 'USD', 'GBP', 'CZK'].includes(source.currency) && Number.isSafeInteger(source.shipping_cost) && source.shipping_cost >= 0 && source.shipping_cost <= L.delivery_minor &&
    Array.isArray(source.items) && source.items.length > 0 && source.items.length <= L.source_lines &&
    source.items.every(x => x && orderSplitUuid.safeParse(x.id).success && typeof x.name === 'string' && x.name.length <= 4096 && typeof x.sku === 'string' && x.sku.length <= 4096 &&
      Number.isSafeInteger(x.quantity) && x.quantity >= 1 && x.quantity <= L.quantity && Number.isSafeInteger(x.price) && x.price >= 0 && x.price <= L.unit_price_minor &&
      Number.isSafeInteger(x.line_total) && x.line_total >= 0 && x.line_total <= L.money_minor) &&
    new Set(source.items.map(x => x.id.toLowerCase())).size === source.items.length &&
    new TextEncoder().encode(sourceIdentity(source)).byteLength <= L.source_bytes;
}

/** Allocation intent only. No network, execution, VAT calculation or command recovery. */
export function OrderSplitAllocationEditor(props: OrderSplitAllocationProps) {
  if (!validSource(props.source)) return <section aria-label="Podział zamówienia"><p role="alert">Brak kompletnych danych zamówienia do przygotowania podziału.</p></section>;
  // Source/context changes replace the draft immediately, not after an effect. Parent retains any command custody.
  return <Editor key={(props.contextKey ?? '') + ':' + sourceIdentity(props.source)} {...props} />;
}
function Editor({source, readOnly, busy, onPreview}: OrderSplitAllocationProps) {
  const [slots, setSlots] = useState<Slot[]>(() => [newSlot(1)]);
  const [clientKey, setClientKey] = useState(() => crypto.randomUUID());
  const [active, setActive] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false), dispatched = useRef(false), alive = useRef(true);
  const nextSlotName = useRef(2);
  const current = useRef({readOnly, busy}); current.current = {readOnly, busy};
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  const locked = readOnly || busy || submitting;
  const selectedSlot = slots.some(s => s.id === active) ? active : slots[0].id;
  const sources = new Map(source.items.map(x => [x.id, x]));
  const allocated = new Map<string, number>();
  const issues: string[] = [];
  let shipping = 0, rowCount = 0;
  for (const slot of slots) {
    if (!slot.name.trim() || slot.name.length > 120 || /[\x00-\x1f\x7f-\x9f]/.test(slot.name)) issues.push('Każde wynikowe zamówienie musi mieć poprawną nazwę.');
    const cost = delivery(slot.shipping);
    if (cost === null) issues.push('Podaj koszt dostawy jako nieujemną kwotę z maksymalnie dwoma miejscami po przecinku.'); else shipping += cost;
    if (!slot.items.length) issues.push('Każde wynikowe zamówienie musi otrzymać co najmniej jedną pozycję.');
    for (const item of slot.items) {
      rowCount++; const q = integer(item.quantity);
      if (q === null || !sources.has(item.id)) issues.push('Ilości muszą być dodatnimi liczbami całkowitymi.');
      else allocated.set(item.id, (allocated.get(item.id) ?? 0) + q);
    }
  }
  if (source.items.some(item => (allocated.get(item.id) ?? 0) > item.quantity)) issues.push('Przydzielono więcej sztuk niż jest w zamówieniu.');
  if (!source.items.some(item => (allocated.get(item.id) ?? 0) < item.quantity)) issues.push('W tym zamówieniu musi pozostać co najmniej jedna sztuka.');
  if (shipping > source.shipping_cost) issues.push('Przydzielony koszt dostawy przekracza koszt źródłowy.');
  if (rowCount + source.items.filter(item => (allocated.get(item.id) ?? 0) < item.quantity).length > L.allocation_rows) issues.push('Za dużo przydziałów pozycji.');
  const parsed = orderSplitPreviewInput.safeParse({client_key: clientKey, source_order_id: source.order_id, expected_source_version: source.version,
    children: slots.map(slot => ({slot_id: slot.id, name: slot.name, delivery_minor: delivery(slot.shipping), items: slot.items.map(item => ({source_item_id: item.id, quantity: integer(item.quantity)}))}))});
  if (parsed.success && new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > L.request_bytes) issues.push('Przydział jest zbyt duży. Zmniejsz liczbę pozycji lub wyników.');
  if (!parsed.success && issues.length === 0) issues.push('Sprawdź nazwy, ilości i liczbę wynikowych zamówień.');
  const uniqueIssues = [...new Set(issues)];
  function edit(change: (prior: Slot[]) => Slot[]) {
    if (current.current.readOnly || current.current.busy || inFlight.current) return;
    if (dispatched.current) {setClientKey(crypto.randomUUID()); dispatched.current = false;}
    setError(''); setSlots(change);
  }
  async function preview() {
    if (current.current.readOnly || current.current.busy || inFlight.current || !parsed.success || uniqueIssues.length) return;
    inFlight.current = true; dispatched.current = true; setSubmitting(true); setError('');
    try {await onPreview(structuredClone(parsed.data));}
    catch {if (alive.current) setError('Nie potwierdzono podglądu. Sprawdź wynik i komunikat w panelu podziału.');}
    finally {inFlight.current = false; if (alive.current) setSubmitting(false);}
  }
  const matches = source.items.map((item, index) => ({item, index})).filter(({item}) => `${item.name} ${item.sku}`.toLocaleLowerCase('pl-PL').includes(search.toLocaleLowerCase('pl-PL')));
  const safePage = Math.min(page, Math.max(0, Math.ceil(matches.length / PAGE) - 1));
  const visible = matches.slice(safePage * PAGE, (safePage + 1) * PAGE);
  return <section aria-label="Przydział podziału zamówienia" className="card">
    <h3>Podział zamówienia</h3>
    <p>Dodaj pozycje do nowych zamówień. Nieprzydzielone sztuki pozostaną w tym zamówieniu. Kwoty wyników i VAT zobaczysz w podglądzie.</p>
    {readOnly && <p>Dostępny jest tylko odczyt.</p>}
    {busy && <p role="status">Trwa operacja lub jej wynik wymaga sprawdzenia w panelu podziału.</p>}
    <fieldset disabled={locked} style={{border: 0, padding: 0, margin: 0, minWidth: 0}}>
      <div className="actions">
        <button type="button" className="button" disabled={locked || slots.length >= L.results - 1} onClick={() => {if (locked || inFlight.current) return; const slot = newSlot(nextSlotName.current++); edit(old => old.length < L.results - 1 ? [...old, slot] : old); setActive(slot.id);}}>Dodaj wynikowe zamówienie</button>
        <label>Dodawaj pozycje do<select aria-label="Wynik dla dodawanej pozycji" value={selectedSlot} onChange={e => setActive(e.target.value)}>{slots.map((slot, n) => <option key={slot.id} value={slot.id}>{slot.name || `Wynik ${n + 1}`}</option>)}</select></label>
      </div>
      <label>Szukaj pozycji źródłowej<input aria-label="Szukaj pozycji źródłowej" value={search} onChange={e => {setSearch(e.target.value); setPage(0);}} /></label>
      <div className="table-wrap"><table><caption>Pozycje i kwoty źródłowe</caption><thead><tr><th>Pozycja</th><th>Ilość źródłowa</th><th>Pozostanie tutaj</th><th>Cena jednostkowa</th><th>Kwota źródłowa</th><th /></tr></thead><tbody>
        {visible.map(({item, index}) => {
          const slot = slots.find(s => s.id === selectedSlot)!, remaining = item.quantity - (allocated.get(item.id) ?? 0), already = slot.items.some(x => x.id === item.id);
          return <tr key={item.id}><td>Pozycja {index + 1}: {item.name}<small>{item.sku}</small></td><td>{item.quantity}</td><td data-remaining-line={item.id}>{remaining}</td><td>{amount(item.price, source.currency)}</td><td>{amount(item.line_total, source.currency)}</td><td><button type="button" className="button" disabled={locked || already || remaining <= 0 || rowCount >= L.allocation_rows} aria-label={`Dodaj pozycję ${index + 1} do wybranego wyniku`} onClick={() => edit(old => old.reduce((sum, s) => sum + s.items.length, 0) >= L.allocation_rows ? old : old.map(s => s.id === selectedSlot && !s.items.some(i => i.id === item.id) ? {...s, items: [...s.items, {id: item.id, quantity: '1'}]} : s))}>{already ? 'Już przydzielona' : 'Dodaj do wyniku'}</button></td></tr>;
        })}
      </tbody></table></div>
      {!matches.length && <p>Brak pasujących pozycji.</p>}
      <div className="actions"><button type="button" className="button" disabled={locked || safePage === 0} onClick={() => setPage(safePage - 1)}>Poprzednie pozycje</button><span role="status">Pozycje {matches.length ? safePage * PAGE + 1 : 0}–{Math.min((safePage + 1) * PAGE, matches.length)} z {matches.length}</span><button type="button" className="button" disabled={locked || (safePage + 1) * PAGE >= matches.length} onClick={() => setPage(safePage + 1)}>Następne pozycje</button></div>
      {slots.map((slot, n) => <section key={slot.id} aria-label={`Wynik podziału ${n + 1}`}>
        <h4>Nowe zamówienie {n + 1}</h4>
        <label>Nazwa zamówienia<input aria-label={`Nazwa wyniku ${n + 1}`} maxLength={120} value={slot.name} onChange={e => edit(old => old.map(s => s.id === slot.id ? {...s, name: e.target.value} : s))} /></label>
        <label>Koszt dostawy ({source.currency})<input aria-label={`Dostawa wyniku ${n + 1}`} inputMode="decimal" value={slot.shipping} onChange={e => edit(old => old.map(s => s.id === slot.id ? {...s, shipping: e.target.value} : s))} /></label>
        {!slot.items.length && <p>Nie dodano jeszcze pozycji.</p>}
        {slot.items.map(item => {const original = sources.get(item.id)!; return <div key={item.id} className="form-row"><span>{original.name} · {original.sku}</span><label>Ilość<input aria-label={`Ilość: ${original.name}, wynik ${n + 1}`} inputMode="numeric" value={item.quantity} onChange={e => edit(old => old.map(s => s.id === slot.id ? {...s, items: s.items.map(i => i.id === item.id ? {...i, quantity: e.target.value} : i)} : s))} /></label><button type="button" className="button" aria-label={`Usuń pozycję ${original.name} z wyniku ${n + 1}`} onClick={() => edit(old => old.map(s => s.id === slot.id ? {...s, items: s.items.filter(i => i.id !== item.id)} : s))}>Usuń pozycję</button></div>;})}
        <button type="button" className="button" disabled={locked || slots.length === 1} onClick={() => {edit(old => old.length > 1 ? old.filter(s => s.id !== slot.id) : old); if (active === slot.id) setActive('');}}>Usuń wynikowe zamówienie {n + 1}</button>
      </section>)}
    </fieldset>
    <p aria-label="Bilans kosztu dostawy">Dostawa źródłowa: {amount(source.shipping_cost, source.currency)}. Przydzielono: {amount(shipping, source.currency)}. Pozostanie tutaj: {amount(source.shipping_cost - shipping, source.currency)}.</p>
    {uniqueIssues.length > 0 && <ul aria-label="Błędy przydziału">{uniqueIssues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="button primary" disabled={locked || !parsed.success || uniqueIssues.length > 0} onClick={() => void preview()}>{submitting ? 'Przygotowywanie podglądu…' : 'Przygotuj podgląd podziału'}</button>
  </section>;
}
