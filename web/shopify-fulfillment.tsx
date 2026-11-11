import { useEffect, useRef, useState } from 'react';
import { ApiError, api, date, money } from './api';

const names: Record<string, string> = {
  preview: 'Podgląd',
  queued: 'W kolejce',
  done: 'Potwierdzono w Shopify',
  failed: 'Błąd / niepewny wynik',
  conflict: 'Wymaga uzgodnienia',
  cancelled: 'Anulowano',
};
type Source = {
  source_order_id: string;
  number: string;
  channel_name: string;
  external_id: string;
  owner_order_id: string;
};
type Line = {
  remote_line_id: string;
  source_item_id: string;
  sku: string;
  name: string;
  quantity: number;
  confirmed_quantity: number;
  reserved_quantity: number;
  returned_quantity: number;
  remaining_quantity: number;
  unit_price?: number;
  line_total?: number;
  vat?: number;
  currency?: string;
};
type Pending = { path: string; body: Record<string, unknown>; label: string; retrySafe?: boolean };

function originalMoney(value: unknown, currency: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && typeof currency === 'string'
    ? money(value, currency)
    : '—';
}

export function ShopifyFulfillmentPanel({
  order,
  refreshSignal = 0,
  readOnly = false,
}: {
  order: any;
  refreshSignal?: number;
  readOnly?: boolean;
}) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [legacy, setLegacy] = useState(false);
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    let active = true;
    setError('');
    api(`/orders/${order.id}/shopify-fulfillment/sources`)
      .then((v) => {
        if (!active) return;
        const rows: Source[] = v.data;
        setSources(rows);
        setLegacy(false);
        setSelected((prior) =>
          rows.some((s) => s.source_order_id === prior)
            ? prior
            : rows.some((s) => s.source_order_id === order.id)
              ? order.id
              : '',
        );
      })
      .catch((e) => {
        if (!active) return;
        // Older copies retain the original full-shipment panel without inferring line bindings.
        if (e instanceof ApiError && e.status === 404 && order.source === 'shopify') {
          setLegacy(true);
          setSources([
            {
              source_order_id: order.id,
              number: order.number,
              channel_name: 'Shopify',
              external_id: order.external_id ?? '',
              owner_order_id: order.id,
            },
          ]);
          setSelected(order.id);
        } else {
          setSources(null);
          setSelected('');
          if (!(e instanceof ApiError && e.status === 404)) setError(e.message);
        }
      });
    return () => {
      active = false;
    };
  }, [order.id, order.version, refreshSignal]);
  if (!sources?.length)
    return error ? (
      <p role="alert" className="error-block">
        {error}
      </p>
    ) : null;
  const source = sources.find((s) => s.source_order_id === selected);
  return (
    <section className="panel amazon-fulfillment-panel">
      <div className="panel-heading">
        <div>
          <h2>Realizacja i numer śledzenia w Shopify</h2>
          <p>Wybierz źródłowe zamówienie sklepu. Potwierdzenie Shopify nie nadaje nowej paczki.</p>
        </div>
      </div>
      <div className="info-body">
        {error && (
          <p role="alert" className="error-block">
            {error}
          </p>
        )}
        <label>
          Zamówienie źródłowe Shopify
          <select value={selected} disabled={locked} onChange={(e) => setSelected(e.target.value)}>
            <option value="">Wybierz zamówienie źródłowe</option>
            {sources.map((s) => (
              <option key={s.source_order_id} value={s.source_order_id}>
                {s.number} · {s.channel_name} · {s.external_id}
              </option>
            ))}
          </select>
        </label>
        {source && (
          <ShopifySourceFulfillment
            key={source.source_order_id}
            source={source}
            owner={order}
            refreshSignal={refreshSignal}
            legacy={legacy}
            readOnly={readOnly}
            onLocked={setLocked}
          />
        )}
      </div>
    </section>
  );
}

function ShopifySourceFulfillment({
  source,
  owner,
  refreshSignal,
  legacy,
  readOnly,
  onLocked,
}: {
  source: Source;
  owner: any;
  refreshSignal: number;
  legacy: boolean;
  readOnly: boolean;
  onLocked: (locked: boolean) => void;
}) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [company, setCompany] = useState('');
  const [notify, setNotify] = useState(false);
  const [shipment, setShipment] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<string | null>(null);
  const [ack, setAck] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<(string | null)[]>([]);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onLocked(busy || Boolean(pending));
    return () => onLocked(false);
  }, [busy, pending, onLocked]);
  useEffect(() => {
    let active = true;
    api(
      `/orders/${source.source_order_id}/shopify-fulfillment${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
    )
      .then((v) => {
        if (!active) return;
        setData(v);
        setShipment((prior) =>
          v.shipments?.some((s: any) => s.id === prior)
            ? prior
            : v.shipments?.length === 1
              ? v.shipments[0].id
              : '',
        );
      })
      .catch((e) => {
        if (!active) return;
        setError(e.message);
        setData(null);
        if (e instanceof ApiError && [401, 403].includes(e.status)) {
          setQuantities({});
          setPending(null);
        }
      });
    return () => {
      active = false;
    };
  }, [source.source_order_id, owner.version, refresh, refreshSignal, cursor]);
  useEffect(() => {
    if (!data?.data?.some((p: any) => p.state === 'queued')) return;
    const t = setInterval(() => setRefresh((v) => v + 1), 2000);
    return () => clearInterval(t);
  }, [data]);
  async function action(request: Pending) {
    setBusy(true);
    setPending(request);
    setError('');
    try {
      await api(request.path, 'POST', request.body);
      if (!alive.current) return;
      setPending(null);
      setCursor(null);
      setPages([]);
      setRefresh((v) => v + 1);
      setConfirm(null);
      setAck(null);
    } catch (e) {
      if (!alive.current) return;
      setError((e as Error).message);
      if (e instanceof ApiError && e.status < 500 && e.status !== 408) {
        setPending(null);
        if ([401, 403].includes(e.status)) {
          setData(null);
          setQuantities({});
        }
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function readLegacyHistory() {
    setBusy(true);
    try {
      const value = await api(`/orders/${source.source_order_id}/shopify-fulfillment`);
      if (!alive.current) return;
      setData(value);
      setCursor(null);
      setPages([]);
      setPending(null);
      setError('');
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  if (!data)
    return error ? (
      <p role="alert" className="error-block">
        {error}
      </p>
    ) : (
      <p>Odczytywanie źródła Shopify…</p>
    );
  const simulation = Boolean(data.channel?.settings?.simulation);
  const lines: Line[] = data.lines ?? [];
  const partial = !legacy && data.partial_available === true;
  const writable =
    !readOnly &&
    !data.read_only &&
    (data.current_role === undefined || data.current_role === 'admin');
  const disabled = busy || Boolean(pending) || !writable;
  const canPreview = !disabled && (data.can_preview ?? true) && (partial || data.ready);
  const selectedLines = lines
    .filter((line) => Number(quantities[line.remote_line_id] ?? 0) > 0)
    .map((line) => ({
      remote_line_id: line.remote_line_id,
      quantity: Number(quantities[line.remote_line_id]),
    }));
  const invalidQuantity = Object.entries(quantities).some(([id, value]) => {
    if (!value) return false;
    const n = Number(value),
      line = lines.find((l) => l.remote_line_id === id);
    return (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(n) ||
      n < 0 ||
      (n > 0 && (!line || n > Math.min(line.remaining_quantity, 1000000)))
    );
  });
  return (
    <>
      <p>
        Źródło: <b>{source.number}</b> · {source.channel_name} · {source.external_id}
        <br />
        Właściciel realizacji: <b>{data.owner_order?.number ?? owner.number}</b>
      </p>
      <p>
        {simulation
          ? 'Przykład lokalny — bez żądań do Shopify.'
          : 'Podgląd odczyta sklep. Zapis wymaga osobnego potwierdzenia.'}
      </p>
      <button className="button small-btn" disabled={busy} onClick={() => setRefresh((v) => v + 1)}>
        Odśwież realizację Shopify
      </button>
      {error && (
        <p role="alert" className="error-block">
          {error}
        </p>
      )}
      {pending && (
        <div role="status" className="notice">
          <p>
            Odpowiedź operacji „{pending.label}” jest niepewna.{' '}
            {pending.retrySafe === false
              ? 'Starszy podgląd nie ma klucza powtórzenia. Odczytaj historię przed kolejnym podglądem.'
              : 'Powtórz ten sam wniosek przed zmianą wyboru.'}
          </p>
          {pending.retrySafe === false ? (
            <button className="button" disabled={busy} onClick={readLegacyHistory}>
              Odczytaj historię podglądów
            </button>
          ) : (
            <button className="button" disabled={busy || !writable} onClick={() => action(pending)}>
              Ponów dokładnie ten sam wniosek
            </button>
          )}
        </div>
      )}
      {!data.ready && <p>{data.reason}</p>}
      {(data.ready || lines.length > 0) && (
        <>
          {partial && (
            <>
              <label>
                Nadana przesyłka właściciela realizacji
                <select
                  value={shipment}
                  disabled={disabled}
                  onChange={(e) => setShipment(e.target.value)}
                >
                  <option value="">Wybierz nadaną przesyłkę</option>
                  {(data.shipments ?? []).map((s: any) => (
                    <option key={s.id} value={s.id}>
                      {s.carrier} · {s.tracking_number} · {date(s.dispatched_at)}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                Podaj sztuki z tego źródła w wybranej paczce. Zero oznacza pominięcie. ID pozycji
                Shopify rozróżnia pozycje o tym samym SKU.
              </p>
              <p>
                Potwierdzamy historyczny rozchód tej paczki. Przyjęty lokalnie zwrot nie nadaje
                ponownie sztuk i nie zwiększa limitu realizacji Shopify.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Pozycja źródłowa</th>
                      <th>Cena źródłowa / szt.</th>
                      <th>Kwota pozycji źródłowej</th>
                      <th>Zamówiono</th>
                      <th>Potwierdzono</th>
                      <th>Oczekuje / niepewne</th>
                      <th>Przyjęto zwrot</th>
                      <th>Pozostało</th>
                      <th>W tej paczce</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.remote_line_id}>
                        <td>
                          {l.sku} · {l.name}
                          <br />
                          <small>{l.remote_line_id}</small>
                        </td>
                        <td>
                          {originalMoney(l.unit_price, l.currency)}
                          {typeof l.vat === 'number' && (
                            <>
                              <br />
                              <small>VAT {l.vat}%</small>
                            </>
                          )}
                        </td>
                        <td>{originalMoney(l.line_total, l.currency)}</td>
                        <td>{l.quantity}</td>
                        <td>{l.confirmed_quantity}</td>
                        <td>{l.reserved_quantity ?? 0}</td>
                        <td>{l.returned_quantity ?? 0}</td>
                        <td>{l.remaining_quantity}</td>
                        <td>
                          <input
                            aria-label={`Ilość Shopify ${l.remote_line_id}`}
                            type="number"
                            min="0"
                            max={Math.min(l.remaining_quantity, 1000000)}
                            step="1"
                            value={quantities[l.remote_line_id] ?? ''}
                            disabled={disabled || l.remaining_quantity <= 0}
                            onChange={(e) =>
                              setQuantities((old) => ({
                                ...old,
                                [l.remote_line_id]: e.target.value,
                              }))
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {invalidQuantity && (
                <p role="alert" className="error-block">
                  Sprawdź całkowite ilości i pozostały zakres źródła. Dane mogły się zmienić.
                </p>
              )}
              <button
                className="button small-btn"
                disabled={disabled}
                onClick={() => setQuantities({})}
              >
                Wyczyść ilości
              </button>
            </>
          )}
          <label>
            Nazwa przewoźnika Shopify
            <input
              value={company}
              disabled={disabled}
              onChange={(e) => setCompany(e.target.value)}
              maxLength={100}
              placeholder="np. DPD"
              autoComplete="off"
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={notify}
              disabled={disabled}
              onChange={(e) => setNotify(e.target.checked)}
            />
            Poproś Shopify o powiadomienie kupującego{simulation ? ' (tylko symulacja)' : ''}
          </label>
          <button
            className="button"
            disabled={
              !canPreview ||
              !company.trim() ||
              (partial && (!shipment || !selectedLines.length || invalidQuantity))
            }
            onClick={() =>
              action({
                path: `/orders/${source.source_order_id}/shopify-fulfillment/preview`,
                label: 'Podgląd realizacji Shopify',
                retrySafe: partial,
                body: partial
                  ? {
                      client_key: crypto.randomUUID(),
                      company,
                      notify_customer: notify,
                      shipment_id: shipment,
                      lines: selectedLines,
                    }
                  : { company, notify_customer: notify },
              })
            }
          >
            Podgląd realizacji Shopify
          </button>
        </>
      )}
      {(data.data ?? []).map((p: any) => (
        <ShopifyPlan
          key={p.id}
          plan={p}
          simulation={simulation}
          disabled={disabled}
          canQueue={data.can_queue ?? true}
          confirm={confirm}
          ack={ack}
          setConfirm={setConfirm}
          setAck={setAck}
          action={action}
        />
      ))}
      {data.meta && (
        <div className="pager">
          <button
            className="button small-btn"
            disabled={busy || Boolean(pending) || pages.length === 0}
            onClick={() => {
              setCursor(pages.at(-1) ?? null);
              setPages((old) => old.slice(0, -1));
            }}
          >
            Poprzednia strona realizacji
          </button>
          <button
            className="button small-btn"
            disabled={busy || Boolean(pending) || !data.meta.cursor}
            onClick={() => {
              setPages((old) => [...old, cursor]);
              setCursor(data.meta.cursor);
            }}
          >
            Następna strona realizacji
          </button>
        </div>
      )}
    </>
  );
}

function ShopifyPlan({
  plan: p,
  simulation,
  disabled,
  canQueue,
  confirm,
  ack,
  setConfirm,
  setAck,
  action,
}: {
  plan: any;
  simulation: boolean;
  disabled: boolean;
  canQueue: boolean;
  confirm: string | null;
  ack: string | null;
  setConfirm: (id: string | null) => void;
  setAck: (id: string | null) => void;
  action: (request: Pending) => Promise<void>;
}) {
  const f = p.payload?.fulfillment;
  const partial = p.payload?.partial;
  const receiver = partial?.receiver;
  return (
    <article className="status-plan">
      <strong>
        {p.state === 'done' && simulation
          ? 'Potwierdzono w przykładzie lokalnym'
          : (names[p.state] ?? p.state)}{' '}
        · {date(p.created_at)}
      </strong>
      <p>
        Przewoźnik: {f?.trackingInfo?.company} · numer: <b>{f?.trackingInfo?.number}</b>
        <br />
        Lokalizacja Shopify: <b>{p.payload?.location_id}</b> ·{' '}
        {(p.payload?.lines ?? []).reduce((n: number, i: any) => n + i.quantity, 0)} szt.
      </p>
      <p>Powiadomienie kupującego: {f?.notifyCustomer ? 'tak' : 'nie'}</p>
      {partial && (
        <div className="notice">
          <p>
            Źródło podglądu: <b>{partial.source_number}</b> · {p.remote?.external_id}
            <br />
            Właściciel paczki w podglądzie: <b>{partial.owner_number}</b>
            <br />
            Sklep: {p.account_scope?.[0]} · przesyłka {p.shipment_id}
          </p>
          {receiver && (
            <p>
              Odbiorca zgodny z dowodem nadania: <b>{receiver.customer_name}</b> · {receiver.email}
              <br />
              {receiver.address?.street} · {receiver.address?.postal_code} {receiver.address?.city}{' '}
              · {receiver.address?.country}
            </p>
          )}
          {partial.returned?.some((r: any) => r.quantity > 0) && (
            <p>
              Istnieje przyjęty lokalny zwrot. Ten podgląd potwierdza wcześniej nadane sztuki; nie
              wykonuje nowego rozchodu ani płatności.
            </p>
          )}
          {partial.bindings?.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Zamrożona pozycja źródłowa</th>
                    <th>Cena źródłowa / szt.</th>
                    <th>Kwota pozycji źródłowej</th>
                    <th>Zamówiono w źródle</th>
                    <th>Sztuki w podglądzie</th>
                  </tr>
                </thead>
                <tbody>
                  {(partial.requested ?? []).map((r: any) => {
                    const b = partial.bindings.find((line: any) => line.id === r.remote_line_id);
                    return (
                      <tr key={r.remote_line_id}>
                        <td>
                          {b?.sku} · {b?.name}
                          <br />
                          <small>{r.remote_line_id}</small>
                        </td>
                        <td>
                          {originalMoney(b?.unit_price, b?.currency)}
                          {typeof b?.vat === 'number' && (
                            <>
                              <br />
                              <small>VAT {b.vat}%</small>
                            </>
                          )}
                        </td>
                        <td>{originalMoney(b?.line_total, b?.currency)}</td>
                        <td>{b?.quantity ?? '—'}</td>
                        <td>{r.quantity}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <details>
        <summary>Zamrożone pozycje i zlecenia realizacji Shopify</summary>
        {(p.payload?.lines ?? []).map((i: any) => (
          <p key={i.id}>
            Pozycja {i.id}: {i.quantity} szt.
          </p>
        ))}
        {(f?.lineItemsByFulfillmentOrder ?? []).map((o: any) => (
          <div key={o.fulfillmentOrderId}>
            <b>{o.fulfillmentOrderId}</b>
            {(o.fulfillmentOrderLineItems ?? []).map((l: any) => (
              <p key={l.id}>
                {l.id}: {l.quantity} szt.
              </p>
            ))}
          </div>
        ))}
      </details>
      {p.remote?.existing && (
        <p>Sklep ma już zgodną przesyłkę. Zatwierdzenie odczyta jej wynik bez nowego zapisu.</p>
      )}
      {p.error && <p className="error-inline">{p.error}</p>}
      {p.result?.fulfillment && (
        <p>
          ID realizacji: <b>{p.result.fulfillment.id}</b>
          {p.result.unchanged ? ' · bez nowego zapisu' : ''}
          {p.result.stale_local ? ' · lokalne zamówienie zmieniło się od zgłoszenia' : ''}
        </p>
      )}
      {p.state === 'preview' && (
        <div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              disabled={disabled || !canQueue}
              checked={confirm === p.id}
              onChange={(e) => setConfirm(e.target.checked ? p.id : null)}
            />
            {simulation
              ? 'Potwierdzam lokalną symulację tego podglądu'
              : 'Potwierdzam zapis realizacji tego podglądu w Shopify'}
            {f?.notifyCustomer ? ' oraz powiadomienie kupującego' : ''}.
          </label>
          <button
            className="button primary"
            disabled={disabled || !canQueue || confirm !== p.id}
            onClick={() =>
              action({
                path: `/shopify-fulfillment-plans/${p.id}/queue`,
                body: { confirm_external: true },
                label: 'Zatwierdzenie realizacji Shopify',
              })
            }
          >
            Zatwierdź realizację Shopify
          </button>
        </div>
      )}
      {['preview', 'queued'].includes(p.state) && p.phase === 'ready' && (
        <button
          className="button"
          disabled={disabled}
          onClick={() =>
            action({
              path: `/shopify-fulfillment-plans/${p.id}/cancel`,
              body: {},
              label: 'Anulowanie realizacji Shopify',
            })
          }
        >
          Anuluj realizację Shopify
        </button>
      )}
      {['failed', 'conflict'].includes(p.state) &&
        ['write_started', 'verify'].includes(p.phase) && (
          <>
            <p>Zapis mógł zostać przyjęty. Uzgodnienie wykonuje odczyt zamrożonej próby.</p>
            <button
              className="button"
              disabled={disabled}
              onClick={() =>
                action({
                  path: `/shopify-fulfillment-plans/${p.id}/reconcile`,
                  body: {},
                  label: 'Odczyt wyniku Shopify',
                })
              }
            >
              Odczytaj wynik Shopify
            </button>
            <label className="checkbox-label">
              <input
                type="checkbox"
                disabled={disabled}
                checked={ack === p.id}
                onChange={(e) => setAck(e.target.checked ? p.id : null)}
              />
              Sprawdziłem rozbieżność w sklepie. Zamknij bez potwierdzenia zapisu.
            </label>
            <button
              className="button"
              disabled={disabled || ack !== p.id}
              onClick={() =>
                action({
                  path: `/shopify-fulfillment-plans/${p.id}/reconcile`,
                  body: { acknowledge_mismatch: true },
                  label: 'Zamknięcie rozbieżności Shopify',
                })
              }
            >
              Zapisz uzgodnioną rozbieżność
            </button>
          </>
        )}
    </article>
  );
}
