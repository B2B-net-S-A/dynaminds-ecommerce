import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, money, date, statusNames } from './api';
import { TradeCreditBalanceFrom } from './b2b-trade-credit';
import { B2bNetworkReturns } from './b2b-network-returns';
import { B2bNetworkOrderDecision } from './b2b-network-lifecycle';
const receiptStates: Record<string, string> = {
  ordered: 'Oczekuje na przyjęcie',
  partial: 'Przyjęto część',
  received: 'Przyjęto całość',
  cancelled: 'Anulowano zakup',
};
export function B2bNetworkOrders({
  link,
  warehouses,
  cart,
  setCart,
  admin,
  readOnly = false,
  externalWriteBlocked = false,
  guardFreshWrite,
  onLockedChange,
}: {
  link: any;
  warehouses: any[];
  cart: any[];
  setCart: (v: any[]) => void;
  admin: boolean;
  readOnly?: boolean;
  externalWriteBlocked?: boolean;
  guardFreshWrite?: (exactRetry?: boolean) => Promise<() => void>;
  onLockedChange?: (locked: boolean) => void;
}) {
  const base = '/b2b/network/links/' + link.id;
  const [warehouse, setWarehouse] = useState(warehouses[0]?.id ?? ''),
    [quote, setQuote] = useState<any>(null),
    [orders, setOrders] = useState<any>(null),
    [selected, setSelected] = useState<any>(null),
    [after, setAfter] = useState<string | undefined>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [quoteKey, setQuoteKey] = useState(crypto.randomUUID()),
    [receiptKey, setReceiptKey] = useState(crypto.randomUUID());
  const [returnBusy, setReturnBusy] = useState(false);
  const alive = useRef(false), latest = useRef({ id: link.id, admin, readOnly, externalWriteBlocked, guardFreshWrite }), lockCallback = useRef(onLockedChange);
  latest.current = { id: link.id, admin, readOnly, externalWriteBlocked, guardFreshWrite }; lockCallback.current = onLockedChange;
  const writeBlocked = !admin || readOnly || externalWriteBlocked;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, [link.id]);
  useEffect(() => { lockCallback.current?.(busy || returnBusy); return () => lockCallback.current?.(false); }, [busy, returnBusy]);
  async function write(p: string, method: string, body: unknown) {
    const check = () => { const v = latest.current; if (!alive.current || v.id !== link.id || !v.admin || v.readOnly || v.externalWriteBlocked) throw Error('Nowy zapis zakupu B2B jest wstrzymany.'); };
    check(); const fence = await latest.current.guardFreshWrite?.(); check(); fence?.();
    const d = await api(p, method, body); if (!alive.current || latest.current.id !== link.id) throw Error('Wybrany zakup zmienił się. Odczytaj jego historię.'); return d;
  }
  async function load() {
    setOrders(await api(base + '/orders' + (after ? '?after=' + after : '')));
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [link.id, after]);
  useEffect(() => {
    setQuote(null);
    setQuoteKey(crypto.randomUUID());
  }, [cart, warehouse]);
  useEffect(() => {
    if (!warehouse && warehouses[0]) setWarehouse(warehouses[0].id);
  }, [warehouses]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function preview(e: FormEvent) {
    e.preventDefault();
    await action(async () => {
      if (!cart.length) throw Error('Dodaj produkty do koszyka');
      setQuote(
        await write(base + '/quotes', 'POST', {
          client_key: quoteKey,
          warehouse_id: warehouse,
          items: cart.map((i) => ({ item_id: i.id, quantity: i.quantity })),
        }),
      );
    });
  }
  async function buy(e: FormEvent) {
    e.preventDefault();
    await action(async () => {
      const o = await write(base + '/quotes/' + quote.id + '/checkout', 'POST', { confirmed: true });
      setSelected(o);
      setCart([]);
      await load();
      setMessage('Zakup ' + o.source_number + ' zapisany. Towar został zarezerwowany u dostawcy.');
    });
  }
  async function receive(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      f = new FormData(form);
    await action(async () => {
      if (selected.fulfillment.read_only)
        throw Error(
          'Zakup połączono u dostawcy. Przyjęcie wymaga realizacji przypisanej do tego źródła.',
        );
      const lines = selected.lines
        .map((l: any) => ({
          product_id: l.product_id,
          quantity: Number(f.get('qty-' + l.product_id)),
          location: String(f.get('location-' + l.product_id)),
        }))
        .filter((l: any) => l.quantity > 0);
      if (!lines.length) throw Error('Podaj odebrane ilości');
      await write('/b2b/network/orders/' + selected.id + '/receipts', 'POST', {
        client_key: receiptKey,
        version: selected.version,
        confirmed: true,
        lines,
      });
      setReceiptKey(crypto.randomUUID());
      setSelected(await api('/b2b/network/orders/' + selected.id));
      await load();
      setMessage('PZ zaksięgowane. Stan Twojego magazynu został zwiększony.');
    });
  }
  return (
    <>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {admin && (
        <section className="panel network-card">
          <h2>Koszyk zakupu B2B</h2>
          <p>
            Ceny zostaną sprawdzone u dostawcy przed zakupem. Towar trafi do Twojego magazynu po
            potwierdzeniu odbioru.
          </p>
          <form onSubmit={preview}>
            <label>
              Magazyn przyjęcia
              <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)} required>
                <option value="">Wybierz magazyn</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            {cart.map((i) => (
              <div className="inline-actions" key={i.id}>
                <span>
                  {i.snapshot.name} · {i.snapshot.sku}
                </span>
                <label>
                  Ilość {i.snapshot.sku}
                  <input
                    type="number"
                    min={1}
                    max={100000}
                    required
                    value={i.quantity}
                    onChange={(e) =>
                      setCart(
                        cart.map((x) =>
                          x.id === i.id ? { ...x, quantity: Number(e.target.value) } : x,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="button"
                  onClick={() => setCart(cart.filter((x) => x.id !== i.id))}
                >
                  Usuń {i.snapshot.sku}
                </button>
              </div>
            ))}
            {!cart.length && <p>Dodaj powiązane produkty z oferty dostawcy.</p>}
            <button className="button primary" disabled={busy || writeBlocked || link.paused || !cart.length}>
              Sprawdź warunki zakupu B2B
            </button>
          </form>
          {quote && (
            <form onSubmit={buy}>
              <h3>Wycena dostawcy · ważna do {date(quote.expires_at)}</h3>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Produkt</th>
                      <th>Ilość</th>
                      <th>Cena brutto</th>
                      <th>Wartość brutto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quote.summary.items.map((i: any) => (
                      <tr key={i.item_id}>
                        <td>{i.name}</td>
                        <td>{i.quantity}</td>
                        <td>{money(i.unit_gross, quote.summary.currency)}</td>
                        <td>{money(i.quantity * i.unit_gross, quote.summary.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>
                Dostawa: {money(quote.summary.shipping_gross, quote.summary.currency)} ·{' '}
                {quote.summary.payment_mode === 'cod' ? 'Pobranie' : 'Przedpłata'}
              </p>
              <p>
                Adres:{' '}
                {[
                  quote.summary.address.street,
                  quote.summary.address.postal_code + ' ' + quote.summary.address.city,
                  quote.summary.address.country,
                ].join(', ')}
              </p>
              <strong>
                Razem brutto: {money(quote.summary.total_gross, quote.summary.currency)}
              </strong>
              <label className="network-check">
                <input type="checkbox" required />
                Potwierdzam zakup na podanych warunkach
              </label>
              <button className="button primary" disabled={busy || writeBlocked || link.paused}>
                Złóż zamówienie u dostawcy
              </button>
            </form>
          )}
        </section>
      )}
      <TradeCreditBalanceFrom path={base + '/trade-credit'} refresh={orders} title="Kredyt kupiecki u dostawcy" className="panel network-card" />
      <section className="panel network-card">
        <div className="panel-heading">
          <h2>Zakupy u dostawcy</h2>
          <button className="button" disabled={busy} onClick={() => action(load)}>
            Odśwież zakupy B2B
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Zamówienie dostawcy</th>
                <th>Data</th>
                <th>Brutto</th>
                <th>Przyjęcie</th>
                <th>Szczegóły</th>
              </tr>
            </thead>
            <tbody>
              {orders?.data.map((o: any) => (
                <tr key={o.id}>
                  <td>{o.source_number}</td>
                  <td>{date(o.created_at)}</td>
                  <td>{money(o.total_gross, o.currency)}</td>
                  <td>{receiptStates[o.state]}</td>
                  <td>
                    <button
                      className="button"
                      onClick={() =>
                        action(async () => {
                          setSelected(await api('/b2b/network/orders/' + o.id));
                          setReceiptKey(crypto.randomUUID());
                        })
                      }
                    >
                      Otwórz zakup {o.source_number}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="inline-actions">
          <button className="button" disabled={!after} onClick={() => setAfter(undefined)}>
            Pierwsze zakupy
          </button>
          <button className="button" disabled={!orders?.next} onClick={() => setAfter(orders.next)}>
            Dalsze zakupy
          </button>
        </div>
      </section>
      {selected && (
        <section className="panel network-card">
          <div className="panel-heading">
            <h2>Zakup {selected.source_number}</h2>
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  setSelected(await api('/b2b/network/orders/' + selected.id));
                })
              }
            >
              Sprawdź realizację zakupu
            </button>
          </div>
          <p>
            Dostawca:{' '}
            {selected.fulfillment.status_label !== selected.fulfillment.status
              ? selected.fulfillment.status_label
              : (statusNames[selected.fulfillment.status] ?? selected.fulfillment.status)}{' '}
            · {receiptStates[selected.state]}
          </p>
          {selected.fulfillment.read_only && (
            <p className="notice">
              Dostawca połączył to zamówienie. Pokazujemy pierwotny zakup; przyjęcie wymaga
              realizacji przypisanej do tego źródła.
              {selected.fulfillment.payment_as_of_merge &&
                ' Saldo pochodzi z chwili połączenia. Późniejsze wpłaty wymagają przypisania.'}
            </p>
          )}
          <B2bNetworkOrderDecision key={selected.id + ':' + selected.version} orderId={selected.id} admin={admin} readOnly={readOnly} />
          {selected.fulfillment.shipments.map((s: any) => (
            <p key={s.tracking_number}>
              {s.carrier} · {s.tracking_number} · {s.mode === 'demo' ? 'Przesyłka DEMO' : s.status}
              {s.dispatched_at ? ' · wydano ' + date(s.dispatched_at) : ' · czeka na wydanie'}
            </p>
          ))}
          <div className="inline-actions">
            {selected.fulfillment.documents.map((d: any) =>
              ['demo', 'simulation'].includes(d.mode) ||
              (d.kind === 'proforma' && d.mode === 'local') ? (
                <a
                  className="button"
                  key={d.id}
                  href={'/api/b2b/network/orders/' + selected.id + '/documents/' + d.id + '/print'}
                  target="_blank"
                  rel="noreferrer"
                >
                  {d.number} · {d.kind === 'proforma' && d.mode === 'local' ? 'Pro forma' : 'DEMO'}
                </a>
              ) : (
                <span key={d.id}>{d.number} · pobranie u dostawcy</span>
              ),
            )}
          </div>
          <form onSubmit={receive} key={selected.id + '-' + selected.version}>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Produkt dostawcy</th>
                    <th>Zamówiono</th>
                    <th>Przyjęto</th>
                    <th>Odbieram teraz</th>
                    <th>Lokalizacja</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.lines.map((l: any) => {
                    const returned =
                        selected.fulfillment.returned.find(
                          (x: any) => x.product_id === l.source_product_id,
                        )?.quantity ?? 0,
                      remaining = Math.max(0, l.quantity - l.received - returned);
                    return (
                      <tr key={l.product_id}>
                        <td>
                          {l.name}
                          <small>{l.sku}</small>
                          {returned > 0 && <small>Zwrot u dostawcy: {returned}</small>}
                        </td>
                        <td>{l.quantity}</td>
                        <td>{l.received}</td>
                        <td>
                          <input
                            aria-label={'Odbieram ' + l.sku}
                            name={'qty-' + l.product_id}
                            type="number"
                            min={0}
                            max={remaining}
                            defaultValue={0}
                            disabled={
                              !admin ||
                              !remaining ||
                              selected.state === 'cancelled' ||
                              selected.fulfillment.read_only
                            }
                          />
                        </td>
                        <td>
                          <input
                            aria-label={'Lokalizacja ' + l.sku}
                            name={'location-' + l.product_id}
                            defaultValue="B2B-01"
                            maxLength={80}
                            required
                            disabled={
                              !admin ||
                              !remaining ||
                              selected.state === 'cancelled' ||
                              selected.fulfillment.read_only
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {admin && ['ordered', 'partial'].includes(selected.state) && (
              <>
                <label className="network-check">
                  <input type="checkbox" required />
                  Potwierdzam fizyczny odbiór podanych ilości
                </label>
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    writeBlocked ||
                    selected.fulfillment.read_only ||
                    !['shipped', 'delivered', 'completed'].includes(selected.fulfillment.status) ||
                    !selected.fulfillment.shipments.some((s: any) => s.dispatched_at)
                  }
                >
                  Przyjmij zakup i zaksięguj PZ
                </button>
              </>
            )}
          </form>
          <h3>Przyjęcia magazynowe</h3>
          {selected.receipts.map((r: any) => (
            <p key={r.id}>
              {r.number} · {date(r.created_at)}
            </p>
          ))}
          {selected.receipts_next && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  const page = await api(
                    '/b2b/network/orders/' +
                      selected.id +
                      '/receipts?after=' +
                      selected.receipts_next,
                  );
                  setSelected({
                    ...selected,
                    receipts: [...selected.receipts, ...page.data],
                    receipts_next: page.next,
                  });
                })
              }
            >
              Dalsze przyjęcia PZ
            </button>
          )}
          <B2bNetworkReturns
            key={selected.id}
            order={selected}
            admin={admin}
            readOnly={readOnly}
            externalWriteBlocked={externalWriteBlocked}
            guardFreshWrite={guardFreshWrite}
            onLockedChange={setReturnBusy}
            changed={async () => {
              setSelected(await api('/b2b/network/orders/' + selected.id));
              await load();
            }}
          />
        </section>
      )}
    </>
  );
}
