// Migration 251: B2B-002 link lifecycle, B2B-003 mappings and price sync, B2B-004-X supplier decisions and buyer
// events, B2B-005 dropshipping tracking copied to the customer order.
import { useEffect, useState, type FormEvent } from 'react';
import { api, money, date } from './api';

const sides: Record<string, string> = { buyer: 'kupujący', supplier: 'dostawca' };
const decisionNames: Record<string, string> = {
  pending: 'Czeka na decyzję dostawcy', accepted: 'Przyjęte przez dostawcę', rejected: 'Odrzucone przez dostawcę',
  expired: 'Wygasło bez decyzji', withdrawn: 'Wycofane przez kupującego',
};
const eventNames: Record<string, string> = {
  accepted: 'Dostawca przyjął zamówienie', rejected: 'Dostawca odrzucił zamówienie', expired: 'Zamówienie wygasło bez decyzji dostawcy',
  withdrawn: 'Zakup wycofany', dispatched: 'Dostawca nadał przesyłkę',
};
const viaNames: Record<string, string> = { supplier: 'decyzja dostawcy', dispatch: 'rozpoczęta realizacja', expiry: 'termin', buyer: 'kupujący' };

function useAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  async function run(fn: () => Promise<string | void>) {
    setBusy(true); setError(''); setMessage('');
    try { const m = await fn(); if (m) setMessage(m); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  const notes = <>{error && <p className="error" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}</>;
  return { busy, run, notes };
}

/** Buyer: the link's state, its history and the disconnect form. */
export function B2bNetworkLinkLifecycle({ link, admin, readOnly, onChanged }: { link: any; admin: boolean; readOnly: boolean; onChanged: (link: any) => void }) {
  const [state, setState] = useState<any>(null), [history, setHistory] = useState<any[]>([]);
  const { busy, run, notes } = useAction();
  async function load() {
    const [s, h] = await Promise.all([api('/b2b/network/link-states'), api('/b2b/network/links/' + link.id + '/history')]);
    setState(s.data.find((x: any) => x.link_id === link.id) ?? null);
    setHistory(h.data);
  }
  useEffect(() => { void load().catch(() => undefined); }, [link.id, link.version]);
  const disconnected = state?.state === 'disconnected';
  function disconnect(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(async () => {
      const d = await api('/b2b/network/links/' + link.id + '/disconnect', 'POST', { version: link.version, reason: String(f.get('reason')).trim(), confirmed: true });
      await load();
      onChanged(d.link);
      return d.reused ? 'Połączenie było już odłączone.' : 'Połączenie odłączone. Zakupy i odczyt oferty są wstrzymane; historia zostaje.';
    });
  }
  return (
    <section className="panel network-card" aria-label="Stan połączenia B2B">
      <h2>Stan połączenia</h2>
      <p>
        {disconnected
          ? `Odłączone ${date(state.disconnected_at)} przez: ${sides[state.disconnected_side]}${state.reason ? ' · ' + state.reason : ''}. Ponowne połączenie wymaga nowego zaproszenia od dostawcy.`
          : state?.reconnected_at ? `Połączone ponownie ${date(state.reconnected_at)}.` : 'Połączone.'}
      </p>
      <p className="muted">Odłączenie wstrzymuje nowe wyceny, zakupy i odczyt oferty. Otwarte zamówienia, przyjęcia, zwroty, rezerwacje dostawcy i powiązania produktów zostają bez zmian.</p>
      {admin && !disconnected && (
        <form onSubmit={disconnect}>
          <label>Powód odłączenia<input name="reason" required minLength={3} maxLength={500} /></label>
          <label className="network-check"><input type="checkbox" required />Potwierdzam odłączenie od {link.supplier_name}</label>
          <button className="button danger" disabled={busy || readOnly}>Odłącz od dostawcy</button>
        </form>
      )}
      {history.length > 0 && (
        <ul className="muted" aria-label="Historia połączenia">
          {history.map((h, i) => <li key={i}>{date(h.created_at)} · {h.kind === 'disconnected' ? 'odłączono' : 'połączono ponownie'} ({sides[h.side]}){h.reason ? ' · ' + h.reason : ''}</li>)}
        </ul>
      )}
      {notes}
    </section>
  );
}

/** Buyer: bound offers with the supplier's current price against the synced purchase price; unbind, rebind, sync. */
export function B2bNetworkMappings({ link, admin, readOnly }: { link: any; admin: boolean; readOnly: boolean }) {
  const [rows, setRows] = useState<any[] | null>(null), [target, setTarget] = useState<Record<string, string>>({});
  const { busy, run, notes } = useAction();
  const base = '/b2b/network/links/' + link.id;
  async function load() { setRows((await api(base + '/mappings')).data); }
  useEffect(() => { void load().catch(() => setRows([])); }, [link.id, link.version]);
  const write = !admin || readOnly || busy;
  return (
    <section className="panel network-card" aria-label="Powiązania i ceny zakupu">
      <div className="panel-heading">
        <h2>Powiązania i ceny zakupu</h2>
        <div className="inline-actions">
          <button className="button" disabled={busy} onClick={() => void run(load)}>Odśwież różnice</button>
          <button className="button primary" disabled={write} onClick={() => void run(async () => {
            const d = await api(base + '/mappings/price-sync', 'POST', { confirmed: true });
            await load();
            return d.changed ? `Zaktualizowano ceny zakupu: ${d.changed}, bez zmian: ${d.unchanged}.` : `Ceny zakupu są aktualne (${d.unchanged}).`;
          })}>Synchronizuj ceny zakupu</button>
        </div>
      </div>
      <p className="muted">Synchronizacja zapisuje tylko cenę zakupu od dostawcy. Nie zmienia Twojej ceny sprzedaży ani stanu magazynu; dostępność dostawcy jest tylko podglądem.</p>
      {rows && rows.length === 0 && <p className="muted">Brak powiązanych ofert.</p>}
      {rows && rows.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Oferta</th><th>Twój produkt</th><th>Cena dostawcy</th><th>Cena zakupu</th><th>Różnica</th><th>Twoja cena</th><th>U dostawcy</th><th>Akcje</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.item_id}>
                  <td>{r.sku} · {r.name}</td>
                  <td>{r.state === 'unbound' ? <strong>Odpięte</strong> : `${r.own_sku ?? '—'} · stan ${r.own_on_hand}`}</td>
                  <td>{r.supplier_price_minor === null ? '—' : money(r.supplier_price_minor, r.currency)}</td>
                  <td>{r.purchase_price_minor === null ? 'nie zsynchronizowano' : money(r.purchase_price_minor, r.purchase_currency)}</td>
                  <td>{r.price_delta_minor === null ? '—' : (r.price_delta_minor > 0 ? '+' : '') + money(r.price_delta_minor, r.currency)}{r.price_changed && r.purchase_price_minor !== null ? ' · zmiana' : ''}</td>
                  <td>{r.own_price_minor === null ? '—' : money(r.own_price_minor, r.currency)}</td>
                  <td>{r.supplier_available}</td>
                  <td>
                    {r.state === 'unbound' ? (
                      <button className="button" disabled={write} onClick={() => void run(async () => {
                        await api(base + '/catalog/' + r.item_id + '/rebind', 'POST', { product_id: r.product_id, confirmed: true });
                        await load();
                        return 'Przywrócono powiązanie.';
                      })}>Przywróć powiązanie</button>
                    ) : (
                      <button className="button" disabled={write} onClick={() => void run(async () => {
                        await api(base + '/catalog/' + r.item_id + '/unbind', 'POST', { reason: 'Odpięcie z widoku powiązań', confirmed: true });
                        await load();
                        return 'Odpięto ofertę. Zakupy tej oferty są wstrzymane do ponownego powiązania.';
                      })}>Odepnij</button>
                    )}
                    <label className="sr-only" htmlFor={'rebind-' + r.item_id}>Nowy produkt (id)</label>
                    <input id={'rebind-' + r.item_id} placeholder="id innego produktu" value={target[r.item_id] ?? ''} onChange={(e) => setTarget({ ...target, [r.item_id]: e.target.value.trim() })} />
                    <button className="button" disabled={write || !target[r.item_id]} onClick={() => void run(async () => {
                      await api(base + '/catalog/' + r.item_id + '/rebind', 'POST', { product_id: target[r.item_id], confirmed: true });
                      setTarget({ ...target, [r.item_id]: '' });
                      await load();
                      return 'Oferta powiązana z innym produktem. Wcześniejsze zakupy zostają przy poprzednim.';
                    })}>Przepnij</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {notes}
    </section>
  );
}

/** Buyer: the supplier's decision on a purchase and the event feed. */
export function B2bNetworkOrderDecision({ orderId, admin, readOnly }: { orderId: string; admin: boolean; readOnly: boolean }) {
  const [data, setData] = useState<any>(null);
  const { busy, run, notes } = useAction();
  async function load() { setData(await api('/b2b/network/orders/' + orderId + '/events')); }
  useEffect(() => { void load().catch(() => setData({ decision: null, data: [] })); }, [orderId]);
  if (!data) return null;
  const d = data.decision;
  return (
    <div aria-label="Decyzja dostawcy">
      {d && <p><strong>{decisionNames[d.state]}</strong>{d.state === 'pending' ? ` · decyzja do ${date(d.decide_by)}; towar jest zarezerwowany u dostawcy` : ` · ${date(d.decided_at)} (${viaNames[d.decided_via]})`}{d.reason ? ' · ' + d.reason : ''}</p>}
      {data.data.length > 0 && <ul aria-label="Zdarzenia zakupu">{data.data.map((e: any, i: number) => <li key={i}>{date(e.created_at)} · {eventNames[e.kind]}{e.detail?.tracking_number ? ` · ${e.detail.carrier} ${e.detail.tracking_number}` : ''}{e.detail?.reason ? ' · ' + e.detail.reason : ''}</li>)}</ul>}
      {admin && <button className="button" disabled={busy || readOnly} onClick={() => void run(async () => {
        const r = await api('/b2b/network/orders/' + orderId + '/events/sync', 'POST', { confirmed: true });
        await load();
        return r.added ? `Nowe nadania: ${r.added}.` : 'Brak nowych nadań.';
      })}>Sprawdź nadania dostawcy</button>}
      {notes}
    </div>
  );
}

/** Supplier: network purchases waiting for acceptance. */
export function B2bNetworkDecisionInbox({ admin, readOnly }: { admin: boolean; readOnly: boolean }) {
  const [filter, setFilter] = useState('pending'), [rows, setRows] = useState<any[] | null>(null), [reason, setReason] = useState<Record<string, string>>({});
  const { busy, run, notes } = useAction();
  async function load() { setRows((await api('/b2b/network/decisions?state=' + filter)).data); }
  useEffect(() => { void load().catch(() => setRows([])); }, [filter]);
  const decide = (r: any, decision: 'accept' | 'reject') => void run(async () => {
    await api('/b2b/network/decisions/' + r.order_id, 'POST', { decision, version: r.version, reason: (reason[r.order_id] ?? '').trim(), confirmed: true });
    await load();
    return decision === 'accept' ? `Przyjęto zamówienie ${r.number}.` : `Odrzucono zamówienie ${r.number}; rezerwacja została zwolniona.`;
  });
  return (
    <section className="panel network-card" aria-label="Zamówienia z sieci B2B do akceptacji">
      <div className="panel-heading">
        <h2>Zamówienia z sieci B2B</h2>
        <label>Pokaż<select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="pending">Do decyzji</option><option value="accepted">Przyjęte</option><option value="rejected">Odrzucone</option>
          <option value="expired">Wygasłe</option><option value="withdrawn">Wycofane</option><option value="">Wszystkie</option>
        </select></label>
      </div>
      <p className="muted">Zamówienie z sieci rezerwuje towar od razu. Bez decyzji w terminie nierozpoczęte zamówienie wygasa i zwalnia rezerwację; rozpoczęcie kompletacji lub nadanie oznacza przyjęcie.</p>
      {rows && rows.length === 0 && <p className="muted">Brak zamówień.</p>}
      {rows && rows.length > 0 && (
        <div className="table-scroll"><table>
          <thead><tr><th>Zamówienie</th><th>Kontrahent</th><th>Wartość</th><th>Stan</th><th>Termin</th><th>Decyzja</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.order_id}>
              <td>{r.number}</td><td>{r.account_name}</td><td>{money(r.total_gross, r.currency)}</td>
              <td>{decisionNames[r.state]}{r.decided_via ? ` (${viaNames[r.decided_via]})` : ''}</td>
              <td>{r.state === 'pending' ? date(r.decide_by) : date(r.decided_at)}</td>
              <td>{r.state === 'pending' && admin ? (
                <div className="inline-actions">
                  <button className="button primary" disabled={busy || readOnly} onClick={() => decide(r, 'accept')}>Przyjmij</button>
                  <input aria-label={'Powód odrzucenia ' + r.number} placeholder="Powód odrzucenia" value={reason[r.order_id] ?? ''} onChange={(e) => setReason({ ...reason, [r.order_id]: e.target.value })} />
                  <button className="button danger" disabled={busy || readOnly || (reason[r.order_id] ?? '').trim().length < 3} onClick={() => decide(r, 'reject')}>Odrzuć</button>
                </div>
              ) : r.reason || '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {notes}
    </section>
  );
}

/** Supplier: the network link of one account; disconnect and revoke a pending invitation. */
export function B2bAccountNetworkLink({ accountId, accountName, admin, readOnly, onClose }: { accountId: string; accountName: string; admin: boolean; readOnly: boolean; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const { busy, run, notes } = useAction();
  async function load() { setData(await api('/b2b/accounts/' + accountId + '/network-link')); }
  useEffect(() => { void load().catch(() => setData({ link: null, events: [] })); }, [accountId]);
  function disconnect(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(async () => {
      const d = await api('/b2b/accounts/' + accountId + '/network-disconnect', 'POST', { reason: String(f.get('reason')).trim(), confirmed: true });
      await load();
      return d.reused ? 'Połączenie było już odłączone.' : 'Odłączono firmę kontrahenta. Otwarte zamówienia realizujesz jak dotąd.';
    });
  }
  const l = data?.link;
  return (
    <section className="panel network-card" aria-label="Połączenie kontrahenta w sieci B2B">
      <div className="panel-heading"><h2>Sieć B2B · {accountName}</h2><button type="button" className="button" onClick={onClose}>Zamknij</button></div>
      {data && !l && <p>Konto nie ma połączonej firmy.</p>}
      {l && <p>{l.state === 'disconnected' ? `Odłączone ${date(l.disconnected_at)} przez: ${sides[l.disconnected_side]}${l.reason ? ' · ' + l.reason : ''}. Nowe zaproszenie tej samej firmy połączy je ponownie.` : 'Połączone.'}</p>}
      {l && l.state !== 'disconnected' && admin && (
        <form onSubmit={disconnect}>
          <label>Powód odłączenia<input name="reason" required minLength={3} maxLength={500} /></label>
          <label className="network-check"><input type="checkbox" required />Potwierdzam odłączenie firmy kontrahenta</label>
          <button className="button danger" disabled={busy || readOnly}>Odłącz firmę</button>
        </form>
      )}
      {admin && <div className="inline-actions"><button className="button" disabled={busy || readOnly} onClick={() => void run(async () => {
        const d = await api('/b2b/accounts/' + accountId + '/network-invite/revoke', 'POST', { confirmed: true });
        return d.revoked ? 'Cofnięto oczekujące zaproszenie.' : 'Brak oczekującego zaproszenia.';
      })}>Cofnij oczekujące zaproszenie</button></div>}
      {data?.events?.length > 0 && <ul className="muted" aria-label="Historia połączenia kontrahenta">{data.events.map((h: any, i: number) => <li key={i}>{date(h.created_at)} · {h.kind === 'disconnected' ? 'odłączono' : 'połączono ponownie'} ({sides[h.side]}){h.reason ? ' · ' + h.reason : ''}</li>)}</ul>}
      {notes}
    </section>
  );
}

/** Seller: supplier parcel numbers copied to the customer order of a dropshipping order. */
export function B2bDropshipCustomerTracking({ path, order, canWrite, onOrder }: { path: string; order: any; canWrite: boolean; onOrder: (order: any) => void }) {
  const { busy, run, notes } = useAction();
  const rows: any[] = order.customer_tracking ?? [];
  return (
    <div aria-label="Śledzenie w zamówieniu klienta">
      <h4>Śledzenie w zamówieniu klienta</h4>
      {rows.length ? <ul>{rows.map((t) => <li key={t.tracking_number}>{t.carrier} · {t.tracking_number} · nadano {date(t.dispatched_at)}</li>)}</ul> : <p>Numer przesyłki dostawcy pojawi się tu po nadaniu.</p>}
      <button className="button" disabled={busy || !canWrite} onClick={() => void run(async () => {
        const d = await api(path + '/orders/' + order.id + '/tracking/sync', 'POST', { confirmed: true });
        onOrder(d.order);
        return d.added ? `Skopiowano numery przesyłek: ${d.added}.` : 'Brak nowych numerów przesyłek.';
      })}>Pobierz numer przesyłki od dostawcy</button>
      {notes}
    </div>
  );
}
