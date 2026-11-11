import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, money, date } from './api';
const states: Record<string, string> = {
  requested: 'Do rozpatrzenia',
  refund_pending: 'Przyjęte — do rozliczenia',
  closed: 'Rozliczone',
  rejected: 'Odrzucone',
  cancelled: 'Wycofane',
};
export function B2bNetworkReturns({
  order,
  admin,
  changed,
  readOnly = false,
  externalWriteBlocked = false,
  guardFreshWrite,
  onLockedChange,
}: {
  order: any;
  admin: boolean;
  changed: () => Promise<void>;
  readOnly?: boolean;
  externalWriteBlocked?: boolean;
  guardFreshWrite?: (exactRetry?: boolean) => Promise<() => void>;
  onLockedChange?: (locked: boolean) => void;
}) {
  const base = '/b2b/network/orders/' + order.id;
  const [rows, setRows] = useState<any>(null),
    [after, setAfter] = useState<string | undefined>(),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [requestKey, setRequestKey] = useState(crypto.randomUUID()),
    [cancelKey] = useState(crypto.randomUUID()),
    [selected, updateSelected] = useState<any>(null),
    [recoverKey, setRecoverKey] = useState(crypto.randomUUID());
  const selectedId = useRef<string | null>(null);
  const alive = useRef(false), latest = useRef({ id: order.id, admin, readOnly, externalWriteBlocked, guardFreshWrite }), lockCallback = useRef(onLockedChange);
  latest.current = { id: order.id, admin, readOnly, externalWriteBlocked, guardFreshWrite }; lockCallback.current = onLockedChange;
  const writeBlocked = !admin || readOnly || externalWriteBlocked;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, [order.id]);
  useEffect(() => { lockCallback.current?.(busy); return () => lockCallback.current?.(false); }, [busy]);
  async function write(p: string, method: string, body: unknown) {
    const check = () => { const v = latest.current; if (!alive.current || v.id !== order.id || !v.admin || v.readOnly || v.externalWriteBlocked) throw Error('Nowy zapis zwrotu B2B jest wstrzymany.'); };
    check(); const fence = await latest.current.guardFreshWrite?.(); check(); fence?.();
    const d = await api(p, method, body); if (!alive.current || latest.current.id !== order.id) throw Error('Wybrany zwrot zmienił się. Odczytaj jego historię.'); return d;
  }
  function setSelected(value: any) {
    selectedId.current = value?.id ?? null;
    updateSelected(value);
  }
  async function load() {
    setRows(await api(base + '/returns' + (after ? '?after=' + after : '')));
    const id = selectedId.current;
    if (id) {
      const value = await api(base + '/returns/' + id);
      if (selectedId.current === id) setSelected(value);
    }
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [order.id, order.version, after]);
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
  async function cancel(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await action(async () => {
      await write(base + '/cancel', 'POST', {
        version: order.version,
        client_key: cancelKey,
        reason: String(f.get('reason')),
        confirmed: true,
      });
      await changed();
      setMessage('Zakup anulowany. Rezerwacja dostawcy została zwolniona.');
    });
  }
  async function request(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      f = new FormData(form);
    await action(async () => {
      const lines = order.lines
        .map((l: any) => ({
          product_id: l.product_id,
          quantity: Number(f.get('qty-' + l.product_id)),
        }))
        .filter((l: any) => l.quantity > 0);
      if (!lines.length) throw Error('Wybierz przynajmniej jedną przyjętą sztukę');
      const raw = String(f.get('shipping')).trim().replace(',', '.');
      if (!/^\d+(\.\d{1,2})?$/.test(raw))
        throw Error('Koszt dostawy wymaga maksymalnie dwóch miejsc dziesiętnych');
      const [a, b = ''] = raw.split('.');
      const r = await write(base + '/returns', 'POST', {
        version: order.version,
        client_key: requestKey,
        kind: String(f.get('kind')),
        reason: String(f.get('reason')),
        shipping_refund: Number(a) * 100 + Number(b.padEnd(2, '0')),
        lines,
        confirmed: true,
      });
      setRequestKey(crypto.randomUUID());
      setSelected(r);
      form.reset();
      await changed();
      await load();
      setMessage(
        'Zgłoszenie ' +
          r.source_number +
          ' zapisane. Magazyn zmieni się po potwierdzeniu wysłania towaru.',
      );
    });
  }
  async function withdraw(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await action(async () => {
      setSelected(
        await write(base + '/returns/' + selected.id + '/cancel', 'POST', {
          version: selected.version,
          reason: String(f.get('reason')),
          confirmed: true,
        }),
      );
      await changed();
      await load();
      setMessage('Niewysłane zgłoszenie wycofane. Stan magazynu pozostał bez zmian.');
    });
  }
  async function recover(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await action(async () => {
      const lines = selected.lines
        .map((l: any) => ({
          product_id: l.product_id,
          quantity: Number(f.get('recover-' + l.product_id)),
          location: String(f.get('location-' + l.product_id)),
        }))
        .filter((l: any) => l.quantity > 0);
      if (!lines.length) throw Error('Podaj odebrane ilości nieprzyjęte przez dostawcę');
      await write(base + '/returns/' + selected.id + '/recoveries', 'POST', {
        version: selected.version,
        client_key: recoverKey,
        confirmed: true,
        lines,
      });
      setRecoverKey(crypto.randomUUID());
      await changed();
      await load();
      setMessage('Powrót towaru przyjęty przez PZ. Twój magazyn został zwiększony.');
    });
  }
  const canRequest =
    !writeBlocked && order.state !== 'cancelled' && order.lines.some((l: any) => l.received > l.return_committed);
  const remaining = (l: any) =>
    Math.max(
      0,
      l.quantity -
        l.recovered -
        (['refund_pending', 'closed'].includes(selected.supplier.state)
          ? (selected.supplier.items.find((x: any) => x.item_id === l.source_item_id)?.accepted ??
            0)
          : 0),
    );
  return (
    <div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {order.fulfillment.payments && (
        <p>
          Według rozliczeń dostawcy: wpłacono{' '}
          {money(order.fulfillment.payments.received, order.currency)}
          {' · '}zwrócono {money(order.fulfillment.payments.refunded, order.currency)}
          {' · '}do zapłaty {money(order.fulfillment.payments.amount_due, order.currency)}
          {' · '}nadpłata {money(order.fulfillment.payments.overpayment, order.currency)}.
          {order.state === 'cancelled' &&
            order.fulfillment.payments.overpayment > 0 &&
            ' Anulowanie nie wykonuje przelewu zwrotnego. Uzgodnij zwrot nadpłaty z dostawcą.'}
        </p>
      )}
      {admin &&
        ['ordered', 'cancelled'].includes(order.state) &&
        !order.cancel_request &&
        order.lines.every((l: any) => l.received === 0) &&
        ['new', 'paid', 'picking', 'packed', 'cancelled'].includes(order.fulfillment.status) && (
          <form className="network-card" onSubmit={cancel}>
            <h3>Anulowanie zakupu</h3>
            <label>
              Powód anulowania zakupu
              <textarea name="reason" minLength={3} maxLength={2000} required />
            </label>
            <label className="network-check">
              <input type="checkbox" required />
              Potwierdzam anulowanie i zwolnienie rezerwacji u dostawcy
            </label>
            <button className="button" disabled={busy || writeBlocked}>
              Anuluj zakup B2B
            </button>
          </form>
        )}
      {admin && canRequest && (
        <form className="network-card" onSubmit={request}>
          <h3>Zwrot lub reklamacja zakupu</h3>
          <p>
            Zgłoszenie dotyczy towaru przyjętego przez PZ. Jego wysłanie potwierdzisz osobno, po
            fizycznym wydaniu.
          </p>
          <label>
            Rodzaj zgłoszenia
            <select name="kind">
              <option value="return">Zwrot</option>
              <option value="complaint">Reklamacja</option>
            </select>
          </label>
          {order.lines.map((l: any) => (
            <label key={l.product_id}>
              Ilość zgłoszenia {l.sku} · dostępne {Math.max(0, l.received - l.return_committed)}
              <input
                type="number"
                name={'qty-' + l.product_id}
                min={0}
                max={Math.max(0, l.received - l.return_committed)}
                defaultValue={0}
                required
              />
            </label>
          ))}
          <label>
            Wnioskowany zwrot kosztu dostawy ({order.currency})
            <input name="shipping" defaultValue="0.00" inputMode="decimal" required />
          </label>
          <label>
            Powód zwrotu lub reklamacji
            <textarea name="reason" minLength={3} maxLength={2000} required />
          </label>
          <label className="network-check">
            <input type="checkbox" required />
            Potwierdzam przekazanie zgłoszenia dostawcy
          </label>
          <button className="button primary" disabled={busy || writeBlocked}>
            Zgłoś zwrot zakupu B2B
          </button>
        </form>
      )}
      <div className="panel-heading">
        <h3>Zwroty tego zakupu</h3>
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            action(async () => {
              await changed();
              await load();
            })
          }
        >
          Odśwież decyzje dostawcy
        </button>
      </div>
      {rows?.data.map((r: any) => (
        <div className="inline-actions" key={r.id}>
          <span>
            {r.source_number} · {states[r.supplier.state]} ·{' '}
            {r.state === 'dispatched'
              ? 'Towar wysłany'
              : r.state === 'cancelled'
                ? 'Zgłoszenie wycofane'
                : 'Towar niewysłany'}
          </span>
          <button
            className="button"
            onClick={() => {
              setSelected(r);
              setRecoverKey(crypto.randomUUID());
            }}
          >
            Otwórz zwrot {r.source_number}
          </button>
        </div>
      ))}
      {!rows?.data.length && <p>Brak zgłoszeń dla tego zakupu.</p>}
      <div className="inline-actions">
        <button className="button" disabled={!after} onClick={() => setAfter(undefined)}>
          Pierwsze zwroty B2B
        </button>
        <button className="button" disabled={!rows?.next} onClick={() => setAfter(rows.next)}>
          Dalsze zwroty B2B
        </button>
      </div>
      {selected && (
        <div className="network-card">
          <h3>
            {selected.source_number} · {states[selected.supplier.state]}
          </h3>
          <p>{selected.input.reason}</p>
          <p>{selected.supplier.decision_note}</p>
          <p>
            Kwota przyjęta do rozliczenia: {money(selected.supplier.refund_amount, order.currency)}{' '}
            · potwierdzone rozliczenie: {money(selected.supplier.settled_amount, order.currency)}
          </p>
          <p>
            {selected.supplier.refunded_at
              ? 'Dostawca potwierdził rozliczenie ' + date(selected.supplier.refunded_at)
              : 'Rozliczenie nie zostało jeszcze potwierdzone.'}
          </p>
          {selected.dispatch_document && (
            <p>
              Wydanie {selected.dispatch_document.number} · {date(selected.dispatched_at)}
            </p>
          )}
          <div className="inline-actions">
            {selected.supplier.documents.map((d: any) =>
              ['demo', 'simulation'].includes(d.mode) ? (
                <a
                  className="button"
                  key={d.id}
                  href={'/api' + base + '/documents/' + d.id + '/print'}
                  target="_blank"
                  rel="noreferrer"
                >
                  {d.number} · DEMO
                </a>
              ) : (
                <span key={d.id}>{d.number} · pobranie u dostawcy</span>
              ),
            )}
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th>Zgłoszono</th>
                  <th>Przyjęto u dostawcy</th>
                  <th>Wróciło do Ciebie</th>
                </tr>
              </thead>
              <tbody>
                {selected.lines.map((l: any) => (
                  <tr key={l.product_id}>
                    <td>
                      {l.name}
                      <small>{l.sku}</small>
                    </td>
                    <td>{l.quantity}</td>
                    <td>
                      {selected.supplier.items.find((x: any) => x.item_id === l.source_item_id)
                        ?.accepted ?? 0}
                    </td>
                    <td>{l.recovered}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {admin && selected.state === 'requested' && (
            <>
              <form onSubmit={withdraw}>
                <label>
                  Powód wycofania zgłoszenia
                  <textarea name="reason" minLength={3} maxLength={2000} required />
                </label>
                <label className="network-check">
                  <input type="checkbox" required />
                  Potwierdzam wycofanie niewysłanego zgłoszenia
                </label>
                <button
                  className="button"
                  disabled={
                    busy ||
                    writeBlocked ||
                    !['requested', 'rejected', 'cancelled'].includes(selected.supplier.state)
                  }
                >
                  Wycofaj zgłoszenie B2B
                </button>
              </form>
              {selected.supplier.state === 'requested' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    action(async () => {
                      setSelected(
                        await write(base + '/returns/' + selected.id + '/dispatch', 'POST', {
                          version: selected.version,
                          confirmed: true,
                        }),
                      );
                      await changed();
                      await load();
                      setMessage('WZ zaksięgowane. Towar wydany z Twojego magazynu.');
                    });
                  }}
                >
                  <p>
                    Wydanie zmniejszy dostępny stan Twojego magazynu. Aktywne rezerwacje pozostaną
                    chronione.
                  </p>
                  <label className="network-check">
                    <input type="checkbox" required />
                    Potwierdzam fizyczne wysłanie towaru do dostawcy
                  </label>
                  <button className="button primary" disabled={busy || writeBlocked}>
                    Potwierdź wysłanie i zaksięguj WZ
                  </button>
                </form>
              )}
            </>
          )}
          {admin &&
            selected.state === 'dispatched' &&
            selected.lines.some((l: any) => remaining(l) > 0) &&
            ['rejected', 'cancelled', 'refund_pending', 'closed'].includes(
              selected.supplier.state,
            ) && (
              <form key={selected.id + '-' + selected.version} onSubmit={recover}>
                <h4>Odbiór towaru nieprzyjętego przez dostawcę</h4>
                {selected.lines.map((l: any) => {
                  const left = remaining(l);
                  return left > 0 ? (
                    <div key={l.product_id}>
                      <label>
                        Odbieram z powrotem {l.sku} · pozostało {left}
                        <input
                          name={'recover-' + l.product_id}
                          type="number"
                          min={0}
                          max={left}
                          defaultValue={0}
                          required
                        />
                      </label>
                      <label>
                        Lokalizacja powrotu {l.sku}
                        <input
                          name={'location-' + l.product_id}
                          defaultValue="B2B-RETURN"
                          maxLength={80}
                          required
                        />
                      </label>
                    </div>
                  ) : null;
                })}
                <label className="network-check">
                  <input type="checkbox" required />
                  Potwierdzam fizyczny odbiór odesłanych sztuk
                </label>
                <button className="button primary" disabled={busy || writeBlocked}>
                  Przyjmij powrót towaru przez PZ
                </button>
              </form>
            )}
          {selected.recoveries.map((r: any) => (
            <p key={r.id}>
              Powrót: {r.number} · {date(r.created_at)}
            </p>
          ))}
          {selected.recoveries_next && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  const page = await api(
                    base +
                      '/returns/' +
                      selected.id +
                      '/recoveries?after=' +
                      selected.recoveries_next,
                  );
                  setSelected({
                    ...selected,
                    recoveries: [...selected.recoveries, ...page.data],
                    recoveries_next: page.next,
                  });
                })
              }
            >
              Dalsze przyjęcia powrotu B2B
            </button>
          )}
        </div>
      )}
    </div>
  );
}
