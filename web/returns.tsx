import { useEffect, useRef, useState, type FormEvent } from 'react';
import {LocalConsumerCreditPanel} from './local-consumer-credits';
import { RotateCcw, FileText } from 'lucide-react';
import { api, money, date } from './api';
import { WmsReturnLotsFields, type WmsReturnLotsPayload } from './wms-lots';
import { ReturnExchangePanel } from './return-exchanges';
import { ReturnStockReceipts } from './return-stock-receipts';
import { ReturnDestinationStatusesPanel, subscribeReturnDestinationStatusesLock,
  returnDestinationStatusesWriteLocked } from './return-destination-statuses';
import { warehouseInventoryPoliciesWriteLocked } from './warehouse-inventory-policies';
import { ReturnReasonsPanel, useReturnReasons } from './return-reasons';
import { subscribeReturnDestinationsIntakeLock, returnDestinationsIntakeWriteLocked } from './return-destinations-intake';
import {
  B2bDropshippingReturns,
  useDropshipReturnWriteState,
  performDropshipReturnWrite,
  purgeDropshipReturnAttempts,
} from './b2b-dropshipping-returns';
const names: Record<string, string> = {
  requested: 'Do rozpatrzenia',
  refund_pending: 'Uznane · do rozliczenia',
  closed: 'Zamknięte',
  rejected: 'Odrzucone',
  cancelled: 'Anulowane',
};
const minor = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '0')
    .trim()
    .replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s))
    throw new Error('Kwota wymaga maksymalnie dwóch miejsc dziesiętnych');
  const [a, b = ''] = s.split('.');
  return Number(a) * 100 + Number(b.padEnd(2, '0'));
};
function ReplacementReturnOrigin({
  order,
  onOpenOrder,
}: {
  order: any;
  onOpenOrder?: (id: string) => void;
}) {
  const [originalOrderId, setOriginalOrderId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const canOpenOrder = Boolean(onOpenOrder);
  useEffect(() => {
    let current = true;
    setOriginalOrderId(null);
    setError('');
    if (canOpenOrder && order.replacement_return_id) {
      void api('/returns/' + encodeURIComponent(order.replacement_return_id))
        .then((r: any) => {
          if (!current) return;
          if (
            r.id !== order.replacement_return_id ||
            r.exchange?.replacement_order_id !== order.id ||
            typeof r.order_id !== 'string' ||
            r.order_id === order.id
          )
            throw Error('Nie można potwierdzić powiązania z oryginalnym zamówieniem.');
          setOriginalOrderId(r.order_id);
        })
        .catch((e: unknown) => {
          if (current)
            setError(
              e instanceof Error ? e.message : 'Nie udało się odczytać oryginalnej reklamacji.',
            );
        });
    }
    return () => {
      current = false;
    };
  }, [order.id, order.replacement_return_id, canOpenOrder]);
  return (
    <section className="panel returns-panel">
      <div className="info-body">
        <p className="notice">
          To bezpłatna realizacja zamiennika. Kolejną reklamację obsłuż na oryginalnym zamówieniu;
          tutaj nie tworzysz nowej sprawy zwrotowej.
        </p>
        {error && (
          <p className="error-block" role="alert">
            {error}
          </p>
        )}
        {originalOrderId && onOpenOrder && (
          <button className="button" type="button" onClick={() => onOpenOrder(originalOrderId)}>
            Otwórz oryginalne zamówienie i reklamację
          </button>
        )}
      </div>
    </section>
  );
}
export type ReturnReceiveFocus = {
  contextKey: string;
  orderId: string;
  orderVersion: string;
  token: string;
};
export function ReturnsPanel({
  order,
  write,
  onChanged,
  contextKey,
  readOnly,
  onOpenOrder,
  externalWriteBlocked = false,
  receiveFocus,
}: {
  order: any;
  write: boolean;
  onChanged: () => void;
  contextKey: string;
  readOnly: boolean;
  onOpenOrder?: (id: string) => void;
  externalWriteBlocked?: boolean;
  receiveFocus?: ReturnReceiveFocus;
}) {
  const sharedWrites = useDropshipReturnWriteState(contextKey, readOnly);
  const settingsContext = contextKey.split(':').length === 3 ? contextKey + ':' + readOnly : contextKey;
  const [statusSettingsLocked, setStatusSettingsLocked] = useState(() => returnDestinationStatusesWriteLocked(settingsContext));
  const [destinationsIntakeLocked, setDestinationsIntakeLocked] = useState(() => returnDestinationsIntakeWriteLocked(settingsContext));
  useEffect(() => subscribeReturnDestinationStatusesLock(settingsContext, setStatusSettingsLocked), [settingsContext]);
  useEffect(() => subscribeReturnDestinationsIntakeLock(settingsContext, setDestinationsIntakeLocked), [settingsContext]);
  const policyBlocked = externalWriteBlocked || warehouseInventoryPoliciesWriteLocked(settingsContext) || destinationsIntakeLocked || returnDestinationsIntakeWriteLocked(settingsContext);
  const freshWriteBlocked = policyBlocked || statusSettingsLocked || returnDestinationStatusesWriteLocked(settingsContext);
  const latest = useRef({ contextKey, readOnly, write, externalWriteBlocked, orderId: order.id });
  latest.current = { contextKey, readOnly, write, externalWriteBlocked, orderId: order.id };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reasonsOpen, setReasonsOpen] = useState(false);
  useEffect(() => { setSettingsOpen(false); setReasonsOpen(false); }, [contextKey, readOnly, order.id]);
  const ordinaryPrefix = `${contextKey}:${readOnly}:ordinary-return:${order.id}:`;
  const ordinaryPending = sharedWrites.entries.find((entry) =>
    entry.scope.startsWith(ordinaryPrefix),
  );
  const [form, setForm] = useState(false),
    [error, setError] = useState(''),
    [denied, setDenied] = useState(false),
    [writeBusy, setBusy] = useState(false),
    [key, setKey] = useState(() => crypto.randomUUID());
  const dictionary = useReturnReasons(form, settingsContext);
  const data = order.returns;
  const commerceById = new Map<string, any>(
    (order.items ?? []).map((line: any) => [line.id, line]),
  );
  const [older, setOlder] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [paginationBusy, setPaginationBusy] = useState(false);
  const [focusedReceive, setFocusedReceive] = useState<{ identity: string; token: string; returnId: string } | null>(null);
  const [focusError, setFocusError] = useState<{ identity: string; message: string } | null>(null);
  const busy = writeBusy || paginationBusy;
  const paginationIdentity = JSON.stringify([contextKey, readOnly, order.id, String(order.version)]);
  const focusAccess = useRef({ identity: paginationIdentity, write, readOnly, blocked: freshWriteBlocked || sharedWrites.locked || writeBusy });
  focusAccess.current = { identity: paginationIdentity, write, readOnly, blocked: freshWriteBlocked || sharedWrites.locked || writeBusy };
  const pagination = useRef({ identity: paginationIdentity, generation: 0, request: 0, alive: true });
  if (pagination.current.identity !== paginationIdentity) {
    pagination.current.identity = paginationIdentity;
    ++pagination.current.generation;
  }
  useEffect(() => {
    pagination.current.alive = true;
    return () => {
      pagination.current.alive = false;
      ++pagination.current.generation;
    };
  }, []);
  useEffect(() => {
    setOlder([]);
    setCursor(order.returns?.meta.cursor ?? null);
    setPaginationBusy(false);
  }, [paginationIdentity]);
  useEffect(() => {
    if (!receiveFocus || receiveFocus.contextKey !== settingsContext ||
      receiveFocus.orderId !== order.id || receiveFocus.orderVersion !== String(order.version)) return;
    let alive = true;
    const generation = pagination.current.generation;
    const current = () => alive && pagination.current.alive &&
      focusAccess.current.identity === paginationIdentity && pagination.current.generation === generation;
    const writable = () => current() && focusAccess.current.write && !focusAccess.current.readOnly &&
      !focusAccess.current.blocked && !returnDestinationStatusesWriteLocked(settingsContext) &&
      !warehouseInventoryPoliciesWriteLocked(settingsContext) && !returnDestinationsIntakeWriteLocked(settingsContext);
    setFocusedReceive(null);
    setFocusError(null);
    const canonical = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:(admin|operator|viewer):(true|false)$/i.test(settingsContext);
    if (!canonical || !writable() || order.wms_lots_enabled !== true || order.fulfillment_kind === 'replacement') {
      setFocusError({ identity: paginationIdentity, message: 'Nie można teraz otworzyć przyjęcia. Sprawdź uprawnienia, tryb odczytu i wynik wcześniejszych zapisów.' });
      return;
    }
    setPaginationBusy(true);
    void (async () => {
      try {
        const cases: any[] = [], ids = new Set<string>(), cursors = new Set<string>();
        let page = { data: order.returns?.cases, meta: order.returns?.meta };
        for (;;) {
          if (!Array.isArray(page.data) || !page.meta ||
            !(page.meta.cursor === null || typeof page.meta.cursor === 'string')) throw Error('Nie można potwierdzić pełnej listy zgłoszeń.');
          for (const r of page.data) {
            if (!r || typeof r.id !== 'string' || r.order_id !== order.id || ids.has(r.id)) throw Error('Lista zgłoszeń nie odpowiada temu zamówieniu.');
            ids.add(r.id); cases.push(r);
          }
          if (cases.length > 1000) throw Error('Lista przekracza 1000 zgłoszeń. Otwórz właściwą sprawę z listy; nie wybrano jej automatycznie.');
          const after = page.meta.cursor;
          if (after === null) break;
          if (!after || cursors.has(after) || cursors.size >= 100) throw Error('Nie można potwierdzić pełnej listy zgłoszeń.');
          cursors.add(after);
          const reply = await api('/orders/' + order.id + '/returns?after=' + encodeURIComponent(after));
          page = { data: reply.cases, meta: reply.meta };
          if (!current()) return;
        }
        if (!writable()) throw Error('Kontekst lub możliwość zapisu zmieniły się. Otwórz sprawę ponownie po potwierdzeniu wcześniejszych zapisów.');
        const matches = cases.filter(r => r.legacy === true && r.state === 'requested' && r.kind === 'return');
        if (matches.length !== 1) throw Error(matches.length ? 'Więcej niż jedna sprawa oczekuje na przyjęcie. Wybierz właściwą sprawę poniżej.' : 'Brak oczekującej sprawy pełnego zwrotu. Sprawdź zgłoszenia poniżej.');
        const embedded = new Set(order.returns.cases.map((r: any) => r.id));
        setOlder(cases.filter(r => !embedded.has(r.id)));
        setCursor(null);
        setFocusedReceive({ identity: paginationIdentity, token: receiveFocus.token, returnId: matches[0].id });
      } catch (e: any) {
        if (current()) setFocusError({ identity: paginationIdentity, message: e.message });
      } finally { if (current()) setPaginationBusy(false); }
    })();
    return () => { alive = false; };
  }, [receiveFocus, paginationIdentity]);
  async function more() {
    if (busy || !cursor) return;
    const generation = pagination.current.generation;
    const request = ++pagination.current.request;
    const current = () => pagination.current.alive &&
      pagination.current.identity === paginationIdentity &&
      pagination.current.generation === generation && pagination.current.request === request;
    setPaginationBusy(true);
    try {
      const d = await api('/orders/' + order.id + '/returns?after=' + encodeURIComponent(cursor!));
      if (!current()) return;
      setOlder((r) => [...r, ...d.cases]);
      setCursor(d.meta.cursor);
    } catch (e: any) {
      if (!current()) return;
      setError(e.message);
      if ([401, 403, 423].includes(e.status)) {
        purgeDropshipReturnAttempts(contextKey, readOnly);
        setDenied(true);
        setOlder([]);
        setCursor(null);
        setForm(false);
      }
    } finally {
      if (current()) setPaginationBusy(false);
    }
  }
  if (order.fulfillment_kind === 'replacement')
    return (
      <ReplacementReturnOrigin
        key={`replacement-origin:${contextKey}:${readOnly}:${order.id}`}
        order={order}
        onOpenOrder={onOpenOrder}
      />
    );
  if (!data) return null;
  const eligible =
    [
      'shipped',
      'delivered',
      'completed',
      'return_initiated',
      'return_received',
      'return_completed',
    ].includes(order.status) || (order.status === 'packed' && data.parcel_origins_required === true);
  const canCreate = eligible && data.items.some((i: any) => i.available > 0);
  async function run(
    path: string,
    body: any,
    rejected?: (status: number) => void,
    exactRetry = false,
  ) {
    if (
      order.fulfillment_kind === 'replacement' ||
      busy ||
      readOnly ||
      !write ||
      latest.current.contextKey !== contextKey ||
      latest.current.orderId !== order.id ||
      latest.current.readOnly ||
      !latest.current.write ||
      (!exactRetry && (sharedWrites.locked || latest.current.externalWriteBlocked ||
        returnDestinationStatusesWriteLocked(settingsContext) || warehouseInventoryPoliciesWriteLocked(settingsContext) || returnDestinationsIntakeWriteLocked(settingsContext)))
    )
      return false;
    setBusy(true);
    setError('');
    try {
      await performDropshipReturnWrite(contextKey, readOnly, ordinaryPrefix + path, {
        action: 'zapis sprawy zwrotu',
        path,
        method: 'POST',
        body: JSON.stringify(body),
      });
      onChanged();
      return true;
    } catch (e: any) {
      setError(e.message);
      if ([401, 403, 423].includes(e.status)) {
        purgeDropshipReturnAttempts(contextKey, readOnly);
        setDenied(true);
        setOlder([]);
        setCursor(null);
        setForm(false);
      }
      rejected?.(e.status);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (
      order.fulfillment_kind === 'replacement' ||
      readOnly ||
      !write ||
      busy ||
      sharedWrites.locked ||
      freshWriteBlocked
    )
      return;
    const f = new FormData(e.currentTarget);
    try {
      const origins = data.parcel_origins_required === true
        ? (data.parcel_origins ?? []).map((origin: any) => ({
          item_id: origin.item_id,
          dispatch_id: origin.dispatch_id,
          quantity: Number(f.get('origin-' + origin.origin_id) ?? 0),
          available: origin.available,
        }))
        : null;
      if (origins && origins.some((origin: any) => !Number.isSafeInteger(origin.quantity) || origin.quantity < 0 || origin.quantity > origin.available))
        throw Error('Zgłoszenie przekracza dostępne pełne jednostki wybranego wydania.');
      const items = data.items.map((i: any) => ({
        item_id: i.id,
        quantity: origins ? origins.filter((o: any) => o.item_id === i.id).reduce((n: number, o: any) => n + o.quantity, 0) : Number(f.get('qty-' + i.id) ?? 0),
      }));
      if (!items.some((i:any)=>i.quantity>0) || items.some((i: any) => !Number.isSafeInteger(i.quantity) || i.quantity < 0 || i.quantity > data.items.find((v: any) => v.id === i.item_id)?.available))
        throw Error('Wybierz poprawne ilości dostępnych pozycji zgłoszenia.');
      const saved = await run('/orders/' + order.id + '/returns', {
        client_key: key,
        kind: f.get('kind'),
        reason: f.get('reason'),
        ...(f.get('reason_id') ? { reason_id: f.get('reason_id') } : {}),
        shipping_refund: minor(f.get('shipping')),
        items:items.filter((i:any)=>i.quantity>0),
        ...(origins ? { parcel_origins: origins.filter((o:any)=>o.quantity>0).map(({ item_id, dispatch_id, quantity }: any) => ({ item_id, dispatch_id, quantity })) } : {}),
      });
      if (saved) {
        setForm(false);
        setKey(crypto.randomUUID());
      }
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function retryOrdinary() {
    if (!ordinaryPending || ordinaryPending.inFlight || readOnly || !write || busy) return;
    const { attempt } = ordinaryPending;
    if (await run(attempt.path, JSON.parse(attempt.body), undefined, true)) {
      setForm(false);
      setKey(crypto.randomUUID());
    }
  }
  if (denied)
    return (
      <section className="panel returns-panel">
        <p role="alert">
          {error} Dostęp do formularzy zwrotu został wstrzymany. Odśwież dostęp do firmy.
        </p>
      </section>
    );
  return (
    <section className="panel returns-panel">
      <div className="panel-heading">
        <div>
          <h2>
            <RotateCcw size={20} /> Zwroty i reklamacje
          </h2>
          <p>Wybrane pozycje, przyjęcie towaru i osobne rozliczenie</p>
        </div>
        {contextKey.split(':')[2] === 'admin' && (
          <button type="button" className="button" onClick={() => setSettingsOpen(value => !value)}>
            {settingsOpen ? 'Zamknij ustawienia statusów zwrotu' : 'Statusy pozycji zwrotu — ustawienia'}
          </button>
        )}
        {contextKey.split(':')[2] === 'admin' && (
          <button type="button" className="button" onClick={() => setReasonsOpen(value => !value)}>
            {reasonsOpen ? 'Zamknij słownik powodów' : 'Powody zwrotu — słownik'}
          </button>
        )}
        {write && canCreate && (
          <button
            className="button primary"
            disabled={busy || sharedWrites.locked || readOnly || freshWriteBlocked}
            onClick={() => setForm(!form)}
          >
            Nowa sprawa zwrotowa
          </button>
        )}
      </div>
      <div className="info-body">
        {focusError?.identity === paginationIdentity && <p className="error-block" role="alert">{focusError.message}</p>}
        {settingsOpen && contextKey.split(':')[2] === 'admin' && (
          <ReturnDestinationStatusesPanel
            key={'return-status-settings:' + contextKey + ':' + readOnly}
            contextKey={settingsContext}
            readOnly={readOnly}
            externalWriteBlocked={policyBlocked || sharedWrites.locked || busy || !write}
          />
        )}
        {reasonsOpen && contextKey.split(':')[2] === 'admin' && (
          <ReturnReasonsPanel contextKey={settingsContext} readOnly={readOnly} blocked={!write || sharedWrites.locked || busy} />
        )}
        {sharedWrites.entries.length > 0 && (
          <p className="notice">
            Zapis zwrotu lub jego ustawień wymaga potwierdzenia w bieżącej firmie. Nowe zapisy są
            wstrzymane; odczyty i historia pozostają dostępne.
          </p>
        )}
        {freshWriteBlocked && <p className="notice">Zapis polityki magazynu lub ustawień statusów wymaga potwierdzenia. Świeże zapisy sprawy zwrotowej są wstrzymane; odczyt i własne dokładne ponowienie pozostają dostępne.</p>}
        {ordinaryPending && (
          <button
            className="button primary"
            disabled={busy || ordinaryPending.inFlight || readOnly || !write}
            onClick={() => void retryOrdinary()}
          >
            Ponów dokładną próbę sprawy
          </button>
        )}
        {error && (
          <div className="error-block" role="alert">
            {error}
          </div>
        )}
        <div className="notice">
          Przyjęcie nie wykonuje płatności. Towar uszkodzony pozostaje poza stanem dostępnym do
          sprzedaży; zwrot środków potwierdzasz osobno.
        </div>
        <p>
          Kwota przyjętych zwrotów: <strong>{money(data.refund_total, order.currency)}</strong> ·
          Potwierdzone rozliczenia: <strong>{money(data.settled_total, order.currency)}</strong>
        </p>
        {form && (
          <form className="return-form" onSubmit={create}>
            <fieldset disabled={busy || sharedWrites.locked || readOnly || !write || freshWriteBlocked}>
              {data.parcel_origins_required === true && <p className="notice">Wskaż rzeczywiste wydanie każdej zwracanej pełnej jednostki. Niewydane paczki nie stanowią zakresu zwrotu i pozostają do realizacji.</p>}
              <div className="form-grid">
                <label>
                  Rodzaj sprawy
                  <select name="kind">
                    <option value="return">Zwrot</option>
                    <option value="complaint">Reklamacja</option>
                  </select>
                </label>
                <label>
                  Zwrot dostawy (maks. {money(data.shipping_available, order.currency)})
                  <input name="shipping" inputMode="decimal" defaultValue="0.00" required />
                </label>
                {dictionary.available && (
                  <label className="full-span">
                    Powód z listy
                    <select name="reason_id" defaultValue="" onChange={(e) => {
                      const text = e.currentTarget.form?.elements.namedItem('reason') as HTMLTextAreaElement | null;
                      const chosen = dictionary.reasons.find((r) => r.id === e.currentTarget.value);
                      if (text && chosen && !text.value.trim()) text.value = chosen.name;
                    }}>
                      <option value="">Inny powód (opisz poniżej)</option>
                      {dictionary.reasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </label>
                )}
                <label className="full-span">
                  {dictionary.available ? 'Opis zgłoszenia' : 'Powód zgłoszenia'}
                  <textarea name="reason" minLength={3} maxLength={2000} required />
                </label>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Pozycja</th>
                      <th>Cena jednostkowa brutto / VAT</th>
                      <th>Sprzedano / przyjęto</th>
                      <th>Można zgłosić</th>
                      <th>Ilość zgłoszenia</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((i: any, lineIndex: number) => {
                      const commerce = commerceById.get(i.id);
                      const priceLabel = commerce
                        ? money(commerce.price, order.currency)
                        : 'Cena niedostępna';
                      return (
                        <tr key={i.id}>
                          <td>
                            <strong>{i.name}</strong>
                            <small className="muted">Pozycja {lineIndex + 1} · {i.sku}</small>
                          </td>
                          <td>
                            {priceLabel}
                            {commerce && <> / {commerce.vat}%</>}
                          </td>
                          <td>
                            {i.quantity} / {i.returned}
                          </td>
                          <td>{i.available}</td>
                          <td>
                            {data.parcel_origins_required === true ? <>{(data.parcel_origins ?? []).filter((o: any) => o.item_id === i.id).map((origin: any) => <label key={origin.origin_id}>
                              Paczka {origin.parcel_index + 1} · wydano {origin.quantity} · można zgłosić {origin.available}
                              <input type="number" min={0} max={origin.available} defaultValue={0} name={'origin-' + origin.origin_id} aria-label={`Zwrot pozycji ${lineIndex + 1} ${i.sku} z paczki ${origin.parcel_index + 1}`} />
                            </label>)}{!(data.parcel_origins ?? []).some((o: any) => o.item_id === i.id && o.available > 0) && <span>Brak dostępnego wydania</span>}</> : <input
                              type="number"
                              min={0}
                              max={i.available}
                              name={'qty-' + i.id}
                              aria-label={'Zwrot ' + i.sku + ' · ' + priceLabel}
                              defaultValue={0}
                            />}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="toolbar-actions">
                <button
                  className="button primary"
                  disabled={busy || sharedWrites.locked || readOnly || freshWriteBlocked}
                >
                  Zapisz zgłoszenie
                </button>
                <button className="button" type="button" onClick={() => setForm(false)}>
                  Zamknij formularz
                </button>
              </div>
            </fieldset>
          </form>
        )}
        {!data.cases.length && !form && (
          <p className="muted">Brak zgłoszeń. Sprawę możesz otworzyć po wydaniu towaru.</p>
        )}
        {[...data.cases, ...older].map((r: any) => (
          <ReturnCase
            key={r.id}
            r={r}
            order={order}
            write={write}
            busy={busy}
            run={run}
            contextKey={contextKey}
            readOnly={readOnly}
            onChanged={onChanged}
            onOpenOrder={onOpenOrder}
            receiveFocus={focusedReceive?.identity === paginationIdentity && focusedReceive.returnId === r.id ? focusedReceive.token : undefined}
            freshWriteBlocked={freshWriteBlocked}
          />
        ))}
        {cursor && (
          <button className="button" disabled={busy} onClick={more}>
            Starsze zgłoszenia
          </button>
        )}
      </div>
    </section>
  );
}
function ReturnCase({
  r,
  order,
  write,
  busy,
  run,
  contextKey,
  readOnly,
  onChanged,
  onOpenOrder,
  receiveFocus,
  freshWriteBlocked,
}: any) {
  const heading = useRef<HTMLDivElement>(null);
  const handledFocus = useRef<string | null>(null);
  const [dropshipLocked, setDropshipLocked] = useState(false);
  const [exchangeBusy, setExchangeBusy] = useState(false);
  const [canReceiveLocally, setCanReceiveLocally] = useState(false);
  const [localOriginId, setLocalOriginId] = useState<string | null>(null);
  const sharedWrites = useDropshipReturnWriteState(contextKey, readOnly);
  const legacyLocked = busy || dropshipLocked || exchangeBusy || sharedWrites.locked;
  const [storedMode, setStoredMode] = useState<'receive' | 'refund' | 'decision' | null>(null);
  const focusModeContext = useRef<string | null>(null);
  const caseContext = JSON.stringify([contextKey, readOnly, order.id]);
  const mode = focusModeContext.current && focusModeContext.current !== caseContext ? null : storedMode;
  function setMode(next: 'receive' | 'refund' | 'decision' | null) {
    focusModeContext.current = null;
    setStoredMode(next);
  }
  const [formError, setFormError] = useState('');
  const [restocked, setRestocked] = useState<Record<string, string>>(() =>
    Object.fromEntries(r.items.map((i: any) => [i.item_id, String(i.requested)])),
  );
  const [accepted,setAccepted] = useState<Record<string,string>>(()=>Object.fromEntries(r.items.map((i:any)=>[i.item_id,String(i.requested)])));
  const [lots, setLots] = useState<WmsReturnLotsPayload | null>(null),
    [lotsReady, setLotsReady] = useState(false),
    [receiveAttempt, setReceiveAttempt] = useState<any>(null);
  useEffect(() => {
    if (!receiveFocus || handledFocus.current === receiveFocus) return;
    heading.current?.focus();
    heading.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    // A newly paged case first reads its real local authority. Its temporary
    // read lock must not consume the focus intent; retained writes still do.
    if (busy || exchangeBusy || sharedWrites.locked || freshWriteBlocked || receiveAttempt || mode !== null || readOnly || !write) {
      handledFocus.current = receiveFocus;
      return;
    }
    if (dropshipLocked || !canReceiveLocally || r.order_id !== order.id || r.legacy !== true || r.state !== 'requested' || order.wms_lots_enabled !== true) return;
    handledFocus.current = receiveFocus;
    focusModeContext.current = caseContext;
    setStoredMode('receive');
  }, [receiveFocus, canReceiveLocally, legacyLocked, freshWriteBlocked, receiveAttempt, mode, readOnly, write, r.id, r.state, order.id, caseContext]);
  useEffect(() => {
    if (
      receiveAttempt &&
      !sharedWrites.entries.some((entry) => entry.attempt.path === '/returns/' + r.id + '/receive')
    ) {
      setReceiveAttempt(null);
      setMode(null);
    }
  }, [receiveAttempt, sharedWrites.entries, r.id]);
  const physicalProductIds = [
    ...new Set<string>(
      r.items
        .filter((i: any) => Number(restocked[i.item_id] ?? 0) > 0)
        .flatMap((i: any) => (i.components ?? []).map((component: any) => component.product_id)),
    ),
  ].sort();
  const needsLots = Boolean(order.wms_lots_enabled && physicalProductIds.length);
  const acceptanceLeft = new Map<string,number>(r.items.map((i:any)=>[i.item_id,Math.max(0,Math.min(Number(accepted[i.item_id]??0),i.requested))]));
  const restockLeft = new Map<string,number>(r.items.map((i:any)=>[i.item_id,Math.max(0,Math.min(Number(restocked[i.item_id]??0),Number(accepted[i.item_id]??0),i.requested))]));
  const originDecisions = r.parcel_origins_required===true && Array.isArray(r.parcel_origins) ? r.parcel_origins.map((origin:any)=>{
    const accept=Math.min(acceptanceLeft.get(origin.item_id)??0,origin.requested);
    const restock=Math.min(restockLeft.get(origin.item_id)??0,accept);
    acceptanceLeft.set(origin.item_id,(acceptanceLeft.get(origin.item_id)??0)-accept);
    restockLeft.set(origin.item_id,(restockLeft.get(origin.item_id)??0)-restock);
    return {...origin,accepted_capacity:accept,restocked_capacity:restock};
  }):undefined;
  const allowedFragments = originDecisions ? [...originDecisions.reduce((all: Map<string,{fragment_id:string;product_id:string;available:number}>, origin:any)=>{
    for(const fragment of origin.fragments ?? []){
      if(!physicalProductIds.includes(fragment.product_id))continue;
      const component=origin.components?.find((c:any)=>c.product_id===fragment.product_id);
      const available=Math.min(fragment.available,origin.restocked_capacity*(component?.quantity??0));
      if(!(available>0))continue;
      const prior=all.get(fragment.fragment_id);
      all.set(fragment.fragment_id,{fragment_id:fragment.fragment_id,product_id:fragment.product_id,available:(prior?.available??0)+available});
    }
    return all;
  },new Map()).values()] : undefined;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (legacyLocked || readOnly || !write || (mode === 'receive' && !canReceiveLocally)) return;
    const f = new FormData(e.currentTarget);
    setFormError('');
    try {
      if (mode === 'receive' && needsLots && !lotsReady && !receiveAttempt)
        throw Error('Wczytaj i wybierz partie całego przywracanego zakresu');
      const fresh =
        mode === 'receive' && receiveAttempt
          ? receiveAttempt
          : mode === 'receive'
            ? {
                version: Number(r.version),
                shipping_refund: minor(f.get('received-shipping')),
                note: f.get('note'),
                items: r.items.map((i: any) => ({
                  item_id: i.item_id,
                  accepted: Number(f.get('accept-' + i.item_id)),
                  restocked: Number(f.get('restock-' + i.item_id)),
                })),
                ...(needsLots && lots ? { wms_lots: lots } : {}),
                ...(localOriginId ? { origin_id: localOriginId } : {}),
              }
            : mode === 'refund'
              ? {
                  version: Number(r.version),
                  amount: r.settlement_amount ?? r.refund_amount,
                  reference: f.get('reference'),
                  confirmed: f.get('confirmed') === 'on',
                }
              : { version: Number(r.version), decision: f.get('decision'), note: f.get('note') };
      const body = mode === 'receive' ? (receiveAttempt ?? fresh) : fresh;
      if (mode === 'receive') setReceiveAttempt(body);
      if (
        await run(
          '/returns/' + r.id + '/' + (mode === 'decision' ? 'decision' : mode),
          body,
          (status: number) => {
            if ([401, 403, 423].includes(status)) {
              setReceiveAttempt(null);
              setLots(null);
              setLotsReady(false);
              setMode(null);
            } else if ([400, 409, 413, 422].includes(status)) {
              setReceiveAttempt(null);
              setLots(null);
              setLotsReady(false);
            }
          },
        )
      ) {
        setReceiveAttempt(null);
        setMode(null);
      }
    } catch (e: any) {
      setFormError(e.message);
    }
  }
  const docs = order.documents.filter(
    (d: any) => d.return_id === r.id || (r.legacy && !d.return_id && d.kind === 'correction'),
  );
  return (
    <article className="return-case">
      <div className="return-heading" ref={heading} tabIndex={-1}>
        <div>
          <strong>
            {r.number} · {r.kind === 'complaint' ? 'Reklamacja' : 'Zwrot'}
          </strong>
          <small>
            {date(r.created_at)} · {names[r.state]}
            {r.legacy
              ? ' · dotychczasowy pełny proces'
              : r.submitted_by === 'buyer'
                ? ' · zgłoszone przez kupującego'
                : ' · zgłoszone przez operatora'}
          </small>
        </div>
        <strong>
          {r.accepted_at || r.received_at
            ? money(r.refund_amount, order.currency)
            : 'Rozpatrzenie ilości'}
        </strong>
      </div>
      {receiveFocus && mode === null && !canReceiveLocally && <p className="notice">Przyjęcie wymaga potwierdzenia lokalnej realizacji i uprawnień. Sprawdź informacje o realizacji poniżej; nie zapisano przyjęcia.</p>}
      {receiveFocus && mode === null && (legacyLocked || freshWriteBlocked || readOnly || !write) && <p className="notice">Nowe przyjęcie jest wstrzymane. Odczyt sprawy i potwierdzenie wcześniejszej próby pozostają dostępne.</p>}
      {r.reason_choice && <p><strong>Powód: {r.reason_choice.name}</strong>{r.reason_choice.active ? '' : ' (nieaktywny)'}</p>}
      <p>{r.reason}</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Pozycja</th>
              <th>Zgłoszono</th>
              <th>Uznano</th>
              <th>Przywrócono lokalnie</th>
              <th>Poza lokalnym zapasem</th>
              <th>Kwota</th>
            </tr>
          </thead>
          <tbody>
            {r.items.map((i: any) => (
              <tr key={i.item_id}>
                <td>
                  <strong>{i.sku}</strong>
                  <small>{i.name}</small>
                </td>
                <td>{i.requested}</td>
                <td>{i.accepted}</td>
                <td>{i.restocked}</td>
                <td>{i.accepted - i.restocked}</td>
                <td>{money(i.refund_amount, order.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.acceptance_kind === 'partner' && (
        <p className="notice">
          Zwrot uznano na podstawie decyzji dostawcy. Towaru nie przyjęto do lokalnego magazynu;
          rozliczenie klienta pozostaje osobne.
        </p>
      )}
      <ReturnStockReceipts
        receipts={r.stock_receipts === undefined ? undefined : r.order_id === order.id ? r.stock_receipts : null}
        returnId={r.id}
        orderId={order.id}
        contextKey={contextKey.split(':').length === 3 ? contextKey + ':' + readOnly : contextKey}
      />
      {r.parcel_origins_required===true && Array.isArray(r.parcel_origins) && r.parcel_origins.length>0 && <div className="notice"><strong>Pierwotne wydania zgłoszenia</strong>{r.parcel_origins.map((origin:any)=><p key={origin.origin_id}>Paczka {origin.parcel_index+1} · {r.items.find((item:any)=>item.item_id===origin.item_id)?.sku} · zgłoszono {origin.requested ?? origin.quantity} pełnych jednostek. Przyjęcie partii obejmuje wyłącznie to wydanie.</p>)}</div>}
      <B2bDropshippingReturns
        key={`dropship:${contextKey}:${readOnly}:${order.id}:${r.id}`}
        orderId={order.id}
        returnId={r.id}
        contextKey={contextKey}
        readOnly={readOnly}
        disabled={busy || exchangeBusy || Boolean(receiveAttempt)}
        onChanged={onChanged}
        onLockedChange={setDropshipLocked}
        onLocalReceiveChange={setCanReceiveLocally}
        onLocalOriginChange={setLocalOriginId}
      />
      <ReturnExchangePanel
        key={`exchange:${contextKey}:${readOnly}:${order.id}:${r.id}`}
        r={r}
        order={order}
        contextKey={contextKey}
        readOnly={readOnly}
        write={write}
        disabled={busy || dropshipLocked || Boolean(receiveAttempt) || mode !== null}
        localOriginId={localOriginId}
        onChanged={onChanged}
        onOpenOrder={onOpenOrder}
        onLockedChange={setExchangeBusy}
      />
      {r.decision_note && <p className="muted">Decyzja: {r.decision_note}</p>}
      {r.refunded_at && (
        <p className="notice">
          Potwierdzenie operatora: {r.settlement.reference} · {date(r.refunded_at)}. System nie
          wykonał przelewu.
        </p>
      )}
      {r.legacy && !r.refunded_at && (
        <p className="muted">Historyczny proces nie potwierdza wypłaty środków.</p>
      )}
      <div className="toolbar-actions">
        {write &&
          canReceiveLocally &&
          r.state === 'requested' &&
          (!r.legacy || order.wms_lots_enabled) && (
            <>
              <button
                className="button primary"
                disabled={legacyLocked || Boolean(receiveAttempt)}
                onClick={() => setMode(mode === 'receive' ? null : 'receive')}
              >
                {r.kind === 'complaint'
                  ? 'Przyjmij w ścieżce zwrotu środków'
                  : 'Rozpatrz i przyjmij'}
              </button>
              <button
                className="button"
                disabled={legacyLocked || Boolean(receiveAttempt)}
                onClick={() => setMode(mode === 'decision' ? null : 'decision')}
              >
                Odrzuć lub anuluj
              </button>
            </>
          )}
        {write && r.state === 'refund_pending' && (
          <button
            className="button primary"
            disabled={legacyLocked}
            onClick={() => setMode(mode === 'refund' ? null : 'refund')}
          >
            Potwierdź zwrot środków
          </button>
        )}
        {write &&
          (r.accepted_at || r.received_at) &&
          !r.legacy &&
          r.refund_amount > 0 &&
          order.documents.some((d: any) => d.kind === 'invoice' && d.mode === 'demo') &&
          !docs.some((d: any) => d.mode === 'demo') && (
            <button
              className="button"
              disabled={legacyLocked}
              onClick={() => {
                if (!legacyLocked && !readOnly) void run('/returns/' + r.id + '/document', {});
              }}
            >
              <FileText size={16} /> Korekta tej sprawy DEMO
            </button>
          )}
        {(r.received_at || r.accepted_at || r.state === 'rejected') && !r.legacy && order.documents.some((d:any)=>d.kind==='invoice'&&d.mode==='local_invoice') && <LocalConsumerCreditPanel orderId={order.id} returnId={r.id} contextKey={contextKey} readOnly={readOnly} inspectionOnly={!r.received_at && !r.accepted_at} externalWriteBlocked={legacyLocked||freshWriteBlocked} onChanged={onChanged} />}
        {docs.map((d: any) => (
          <a
            key={d.id}
            className="button"
            target="_blank"
            rel="noreferrer"
            href={'/api/documents/' + d.id + '/print'}
          >
            {d.number}
          </a>
        ))}
      </div>
      {mode && (
        <form className="return-form" onSubmit={submit}>
          <fieldset
            disabled={
              legacyLocked || readOnly || !write || (mode === 'receive' && !canReceiveLocally)
            }
          >
            {receiveAttempt && !busy && (
              <p className="notice">
                Wynik przyjęcia wymaga potwierdzenia. Ponów zapis z tymi samymi ilościami i
                partiami.
              </p>
            )}
            {formError && (
              <div className="error-block" role="alert">
                {formError}
              </div>
            )}
            {mode === 'receive' ? (
              <>
                <p>Kwota produktów zostanie wyliczona z przyjętych ilości.</p>
                <label>
                  Przyjęty zwrot dostawy (maks. {money(r.requested_shipping, order.currency)})
                  <input
                    name="received-shipping"
                    disabled={legacyLocked || Boolean(receiveAttempt)}
                    inputMode="decimal"
                    defaultValue={(r.requested_shipping / 100).toFixed(2)}
                    required
                  />
                </label>
                <div className="table-scroll">
                  <table className="return-receive-table">
                    <thead>
                      <tr>
                        <th>Pozycja zgłoszenia</th>
                        <th>Oryginalna ilość / kwota brutto</th>
                        <th>Przyjęte sztuki</th>
                        <th>Sztuki do sprzedaży</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.items.map((i: any, lineIndex: number) => {
                        const original = order.items?.find((line: any) => line.id === i.item_id);
                        const originalAmount = Number.isSafeInteger(original?.quantity) && Number.isSafeInteger(original?.line_total)
                          ? `${original.quantity} szt. / ${money(original.line_total, order.currency)} za całą pozycję`
                          : Number.isSafeInteger(original?.price)
                            ? `${money(original.price, order.currency)} za jednostkę`
                            : 'Historyczna kwota niedostępna';
                        return (
                        <tr key={i.item_id}>
                          <td>
                            <strong>Pozycja {lineIndex + 1} · {i.sku}</strong>
                            <small>{i.name} (maks. {i.requested})</small>
                          </td>
                          <td>{originalAmount}</td>
                          <td>
                            <input
                              type="number"
                              name={'accept-' + i.item_id}
                              aria-label={`Przyjęte pozycji ${lineIndex + 1} ${i.sku}`}
                              disabled={legacyLocked || Boolean(receiveAttempt)}
                              value={accepted[i.item_id]??'0'}
                              onChange={e=>{setLots(null);setLotsReady(false);setAccepted(old=>({...old,[i.item_id]:e.target.value}));}}
                              min={0}
                              max={i.requested}
                              required
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              name={'restock-' + i.item_id}
                              aria-label={`Do sprzedaży pozycji ${lineIndex + 1} ${i.sku}`}
                              value={restocked[i.item_id] ?? '0'}
                              disabled={legacyLocked || Boolean(receiveAttempt)}
                              onChange={(e) => {
                                setLots(null);
                                setLotsReady(false);
                                setRestocked((old) => ({ ...old, [i.item_id]: e.target.value }));
                              }}
                              min={0}
                              max={i.requested}
                              required
                            />
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {originDecisions && <div className="notice"><p>Uznane i przywracane jednostki przypisuje się w kolejności wydań wybranej w zgłoszeniu. Partie muszą pochodzić z zakresu przywracanego poniżej.</p>{originDecisions.map((origin:any)=><p key={origin.origin_id}>Paczka {origin.parcel_index+1} · {r.items.find((item:any)=>item.item_id===origin.item_id)?.sku} · uznaj {origin.accepted_capacity} · przywróć do sprzedaży {origin.restocked_capacity} pełnych jednostek</p>)}</div>}
                {needsLots && (
                  <fieldset disabled={legacyLocked || Boolean(receiveAttempt)}>
                    <WmsReturnLotsFields
                      key={
                        contextKey +
                        ':' +
                        readOnly +
                        ':' +
                        r.id +
                        ':' +
                        JSON.stringify(physicalProductIds)
                      }
                      orderId={order.id}
                      warehouseId={r.warehouse_id}
                      physicalProductIds={physicalProductIds}
                      allowedFragments={allowedFragments}
                      contextKey={contextKey}
                      readOnly={readOnly}
                      onChange={(payload, ready) => {
                        setLots(payload);
                        setLotsReady(ready && (!needsLots || payload !== null));
                        if (needsLots && ready && payload === null) setFormError('Polityka partii zmieniła się. Odśwież zamówienie przed przyjęciem; nie wybrano partii automatycznie.');
                      }}
                    />
                  </fieldset>
                )}
                <label>
                  Uzasadnienie przyjęcia
                  <textarea
                    name="note"
                    minLength={3}
                    maxLength={2000}
                    required
                    disabled={legacyLocked || Boolean(receiveAttempt)}
                  />
                </label>
              </>
            ) : mode === 'refund' ? (
              <>
                <p>
                  Potwierdzasz rozliczenie{' '}
                  <strong>{money(r.settlement_amount ?? r.refund_amount, order.currency)}</strong>{' '}
                  {(r.settlement_amount ?? r.refund_amount) > 0
                    ? 'wykonane poza systemem.'
                    : '— przyjęty zwrot obniża nieopłaconą należność; środki nie są wypłacane.'}
                </p>
                <label>
                  Referencja rozliczenia
                  <input name="reference" minLength={3} maxLength={200} required />
                </label>
                <label className="checkbox-label">
                  <input type="checkbox" name="confirmed" required />
                  Potwierdzam rozliczenie wskazanej kwoty
                </label>
              </>
            ) : (
              <>
                <label>
                  Decyzja
                  <select name="decision">
                    <option value="reject">Odrzuć z uzasadnieniem</option>
                    <option value="cancel">Anuluj zgłoszenie</option>
                  </select>
                </label>
                <label>
                  Uzasadnienie decyzji (widoczne kupującemu)
                  <textarea name="note" minLength={3} maxLength={2000} required />
                </label>
              </>
            )}
            <div className="toolbar-actions">
              <button
                className="button primary"
                disabled={
                  legacyLocked ||
                  readOnly ||
                  !write ||
                  (mode === 'receive' && !canReceiveLocally) ||
                  (mode === 'receive' && needsLots && !lotsReady && !receiveAttempt)
                }
              >
                Zapisz{' '}
                {mode === 'receive' ? 'przyjęcie' : mode === 'refund' ? 'potwierdzenie' : 'decyzję'}
              </button>
              <button
                type="button"
                className="button"
                disabled={legacyLocked || Boolean(receiveAttempt)}
                onClick={() => setMode(null)}
              >
                Zamknij
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </article>
  );
}
