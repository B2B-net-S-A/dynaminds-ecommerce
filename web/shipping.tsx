import {OrdinaryConnectorJobControl,type ConnectorJobContext} from './ordinary-connector-job';
import { useEffect, useState, useRef, type FormEvent } from 'react';
import { Truck, RefreshCw, Printer } from 'lucide-react';
import { api, money, date } from './api';
import { orderRecipientName } from '../shared/order-invoice-party';
import { readTogether } from './read-polling';
import { useVisibleReadPolling } from './use-visible-read-polling';
import { trackingName } from './tracking';
import {LocalCarrierDemo} from './local-carrier-demo';
import type { PackingParcelSeed } from './packing-workstation';
import { CarrierReturns } from './carrier-returns';
const names: Record<string, string> = {
  preview: 'Podgląd',
  queued: 'Przygotowanie wyceny',
  quoted: 'Wyceniona',
  buy_queued: 'Zakup w toku',
  ready: 'Etykieta gotowa',
  dispatched: 'Przekazana do wysyłki',
  failed: 'Wymaga uzgodnienia',
  cancelled: 'Anulowana',
  cancel_queued: 'Anulowanie w toku',
};
export function ShippingPanel({
  order,
  contextKey,
  write,
  admin,
  onChanged,
  parcelSeed,
  onPrintLabel,
  connectorContext,
}: {
  order: any;
  connectorContext?: ConnectorJobContext;
  contextKey?: string;
  write: boolean;
  admin: boolean;
  onChanged: () => void;
  parcelSeed?: PackingParcelSeed;
  onPrintLabel?: (shipmentId: string) => void;
}) {
  const deliveryBasis = JSON.stringify([order.id, order.effective_delivery?.delivery_version, order.effective_delivery?.delivery_hash]);
  const delivery = order.effective_delivery?.available ? order.effective_delivery.delivery : {
    recipient_name: orderRecipientName(order), ...order.address,
  };
  const [data, setData] = useState<any>({ data: [], meta: {} }),
    [channels, setChannels] = useState<any[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [form, setForm] = useState(false),
    [confirmation, setConfirmation] = useState<Record<string, boolean>>({}),
    [unknown, setUnknown] = useState<Record<string, boolean>>({});
  const observed = useRef<string | undefined>(undefined);
  const [packing, setPacking] = useState<PackingParcelSeed | undefined>();
  const [parcel, setParcel] = useState({ weight: '1', length: '', width: '', height: '' });
  const [extraParcels, setExtraParcels] = useState<(typeof parcel)[]>([]);
  useEffect(() => { setForm(false); setConfirmation({}); }, [deliveryBasis]);
  function changeParcel(key: keyof typeof parcel, value: string) {
    setPacking(undefined);
    setParcel((current) => ({ ...current, [key]: value }));
  }
  // The packing measurement proves one box; extra courier parcels detach it.
  function changeExtraParcels(next: (typeof parcel)[]) {
    setPacking(undefined);
    setExtraParcels(next);
  }
  async function readData(current: () => boolean) {
    const [d, ch] = await readTogether([
      api('/orders/' + order.id + '/shipping'),
      api('/shipping/channels'),
    ]);
    if (!current()) return;
    const version = JSON.stringify(d.data.map((p: any) => [p.id, p.state, p.updated_at, p.error]));
    if (observed.current !== undefined && observed.current !== version) onChanged();
    observed.current = version;
    setData({ ...d, data: d.data.filter((p: any) => p.provider === 'inpost') });
    setChannels(ch.data.filter((ch: any) => ch.provider === 'inpost'));
  }
  const load = useVisibleReadPolling(order.id, readData, e => setError((e as Error).message));
  useEffect(() => {
    observed.current = undefined;
  }, [order.id]);
  async function run(path: string, body: any = {}) {
    setBusy(true);
    setError('');
    try {
      await api(path, 'POST', body);
      await load();
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function preview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.currentTarget)),
      courier = d.service === 'inpost_courier_standard';
    if (courier && d.confirmed_address !== 'on') {
      setError('Sprawdź ulicę i osobny numer budynku przed podglądem kuriera.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/orders/' + order.id + '/shipping/preview', 'POST', {
        channel_id: d.channel_id,
        service: d.service,
        receiver: {
          first_name: d.first_name,
          last_name: d.last_name,
          email: d.email,
          phone: d.phone,
          ...(courier
            ? {
                address: {
                  street: d.street,
                  building_number: d.building_number,
                  city: d.city,
                  post_code: d.post_code,
                  country_code: 'PL',
                },
              }
            : {}),
        },
        ...(courier
          ? {
              dimensions: {
                length: Number(d.length),
                width: Number(d.width),
                height: Number(d.height),
              },
              ...(extraParcels.length
                ? {
                    additional_parcels: extraParcels.map((x) => ({
                      dimensions: {
                        length: Number(x.length),
                        width: Number(x.width),
                        height: Number(x.height),
                      },
                      weight: Number(x.weight),
                    })),
                  }
                : {}),
            }
          : { target_point: d.target_point, template: d.template }),
        weight: Number(d.weight),
        cod: Math.round(Number(d.cod) * 100),
        insurance: Math.round(Number(d.insurance) * 100),
        ...(packing
          ? {
              packing: {
                receipt_id: packing.receipt_id,
                scope_hash: packing.scope_hash,
                profile_revision: packing.profile_revision,
              },
            }
          : {}),
      });
      setForm(false);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const [service, setService] = useState('inpost_locker_standard'),
    parts = (delivery?.recipient_name ?? '').trim().split(/\s+/),
    active = data.data.some((p: any) => !['preview', 'cancelled', 'dispatched'].includes(p.state));
  return (
    <section className="panel shipping-panel">
      <div className="panel-heading">
        <h2>
          <Truck size={18} /> Wysyłka InPost
        </h2>
        <span className="muted">Wyceń → etykieta → przekazanie</span>
      </div>
      <div className="shipping-body">
        <div className="notice" style={{ overflowWrap: 'anywhere' }}>
          <strong>Operacyjny adres dostawy</strong>
          {delivery ? <p>{delivery.recipient_name} · {delivery.street} · {delivery.postal_code} {delivery.city} · {delivery.country} · {delivery.phone}</p> : <p>Rodzaj dostawy nie udostępnia zwykłego adresu. Sprawdź punkt odbioru lub potwierdź klasyfikację w karcie zamówienia.</p>}
          <p>Nowy formularz korzysta z bieżących danych. Dane odbiorcy wpisane w podglądzie oraz wcześniejsze plany pozostają osobnymi, jawnie zatwierdzanymi danymi.</p>
        </div>
        {parcelSeed && write && order.status === 'packed' && (
          <div className="notice">
            <p>
              Pomiar paczki: {parcelSeed.measurements.weight_grams} g ·{' '}
              {parcelSeed.measurements.length_mm} × {parcelSeed.measurements.width_mm} ×{' '}
              {parcelSeed.measurements.height_mm} mm. Zastosowanie zastąpi wagę i wymiary bieżącego
              formularza; dane odbiorcy pozostaną w formularzu.
            </p>
            <button
              className="button"
              disabled={busy || active || Boolean(order.shipments.length)}
              onClick={() => {
                const m = parcelSeed.measurements;
                setPacking(parcelSeed);
                setParcel({
                  weight: String(m.weight_grams / 1000),
                  length: String(m.length_mm),
                  width: String(m.width_mm),
                  height: String(m.height_mm),
                });
                setService('inpost_courier_standard');
                setExtraParcels([]);
                setConfirmation({});
                setUnknown({});
                setForm(true);
              }}
            >
              Zastosuj pomiar w formularzu kuriera InPost
            </button>
          </div>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <p className="muted">
          Zakup etykiety zachowuje rezerwację towaru. Potwierdzenie przekazania paczki zapisuje
          rozchód magazynowy. Odbiór przez kuriera zamawia się osobno.
        </p>
        {write &&
          order.status === 'packed' &&
          !active &&
          !order.shipping_active &&
          !order.shipments.length && (
            <div className="shipping-actions">
              <button
                className="button primary"
                disabled={busy || !channels.length}
                onClick={() => setForm(!form)}
              >
                {form ? 'Zamknij formularz' : 'Przygotuj przesyłkę'}
              </button>
              {admin && !channels.some((c) => c.settings.simulation) && (
                <button className="button" disabled={busy} onClick={() => run('/shipping/example')}>
                  Dodaj przykład InPost DEMO
                </button>
              )}
            </div>
          )}
        {form && (
          <form className="form-grid shipping-form" onSubmit={preview}>
            <label>
              Połączenie
              <select name="channel_id" required>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.settings.simulation ? 'DEMO' : c.mode}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Usługa
              <select
                name="service"
                value={service}
                onChange={(e) => {
                  setService(e.target.value);
                  setPacking(undefined);
                }}
              >
                <option value="inpost_locker_standard">
                  Paczkomat — nadanie w dowolnym punkcie
                </option>
                <option value="inpost_courier_standard">Kurier — odbiór zamawiany osobno</option>
              </select>
            </label>
            <label>
              Imię
              <input name="first_name" required defaultValue={parts[0]} />
            </label>
            <label>
              Nazwisko
              <input name="last_name" required defaultValue={parts.slice(1).join(' ')} />
            </label>
            <label>
              E-mail
              <input name="email" type="email" required defaultValue={order.email} />
            </label>
            <label>
              Telefon
              <input
                name="phone"
                required
                pattern="\+?[0-9]{9,15}"
                defaultValue={delivery?.phone ?? ''}
              />
            </label>
            {service === 'inpost_locker_standard' ? (
              <>
                <label>
                  Punkt odbioru
                  <input
                    name="target_point"
                    required
                    pattern="[A-Z0-9_-]{3,30}"
                    defaultValue={order.address.locker_code ?? ''}
                    placeholder="Kod z wyszukiwarki punktów"
                  />
                </label>
                <label>
                  Gabaryt
                  <select name="template">
                    <option value="small">A — mała</option>
                    <option value="medium">B — średnia</option>
                    <option value="large">C — duża</option>
                  </select>
                </label>
              </>
            ) : (
              <>
                <label>
                  Ulica
                  <input name="street" required defaultValue={order.effective_delivery?.origin === 'override' ? '' : delivery?.street ?? ''} />
                </label>
                <label>
                  Numer budynku
                  <input name="building_number" required />
                </label>
                <label>
                  Miasto
                  <input name="city" required defaultValue={delivery?.city ?? ''} />
                </label>
                <label>
                  Kod pocztowy
                  <input
                    name="post_code"
                    required
                    pattern="[0-9]{2}-[0-9]{3}"
                    defaultValue={delivery?.postal_code ?? ''}
                  />
                </label>
                <label className="full-field"><input type="checkbox" name="confirmed_address" required /> Sprawdziłem ulicę i osobny numer budynku kuriera. Pełny adres powyżej nie jest automatycznie dzielony.</label>
                {['length', 'width', 'height'].map((key, i) => (
                  <label key={key}>
                    {['Długość', 'Szerokość', 'Wysokość'][i]} (mm)
                    <input
                      name={key}
                      required
                      type="number"
                      min="1"
                      max="1200"
                      value={parcel[key as 'length' | 'width' | 'height']}
                      onChange={(e) =>
                        changeParcel(key as 'length' | 'width' | 'height', e.target.value)
                      }
                    />
                  </label>
                ))}
              </>
            )}
            <label>
              Waga (kg)
              <input
                name="weight"
                required
                type="number"
                min="0.001"
                max="25"
                step="0.001"
                value={parcel.weight}
                onChange={(e) => changeParcel('weight', e.target.value)}
              />
            </label>
            {service === 'inpost_courier_standard' && (
              <fieldset className="full-field">
                <legend>Paczki w przesyłce kurierskiej: {1 + extraParcels.length} z 10</legend>
                {extraParcels.map((x, n) => (
                  <div className="form-grid" key={n}>
                    <strong>Paczka {n + 2}</strong>
                    {(['length', 'width', 'height'] as const).map((key, i) => (
                      <label key={key}>
                        {['Długość', 'Szerokość', 'Wysokość'][i]} (mm)
                        <input
                          required
                          type="number"
                          min="1"
                          max="1200"
                          value={x[key]}
                          onChange={(e) =>
                            changeExtraParcels(
                              extraParcels.map((y, k) => (k === n ? { ...y, [key]: e.target.value } : y)),
                            )
                          }
                        />
                      </label>
                    ))}
                    <label>
                      Waga (kg)
                      <input
                        required
                        type="number"
                        min="0.001"
                        max="25"
                        step="0.001"
                        value={x.weight}
                        onChange={(e) =>
                          changeExtraParcels(
                            extraParcels.map((y, k) => (k === n ? { ...y, weight: e.target.value } : y)),
                          )
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="button"
                      onClick={() => changeExtraParcels(extraParcels.filter((_, k) => k !== n))}
                    >
                      Usuń paczkę {n + 2}
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="button"
                  disabled={busy || extraParcels.length >= 9}
                  onClick={() =>
                    changeExtraParcels([...extraParcels, { weight: '1', length: '', width: '', height: '' }])
                  }
                >
                  Dodaj paczkę
                </button>
                <p className="muted">
                  Wszystkie paczki trafią do jednej przesyłki InPost z jedną wyceną i jedną etykietą.
                  Pomiar ze stanowiska pakowania dotyczy tylko jednej paczki.
                </p>
              </fieldset>
            )}
            {packing && (
              <p className="notice full-field">
                Formularz jest powiązany z pomiarem paczki, wersja {packing.profile_revision}.
                Zmiana wagi, wymiarów lub usługi odłączy pomiar. Serwer sprawdzi jego aktualność
                przed nadaniem.
              </p>
            )}
            <label>
              Pobranie (PLN)
              <input
                name="cod"
                required
                type="number"
                min="0"
                max={order.total / 100}
                step="0.01"
                value={(order.payment_mode === 'cod' ? order.payment.amount_due : 0) / 100}
                readOnly
              />
            </label>
            <label>
              Ubezpieczenie (PLN)
              <input
                name="insurance"
                required
                type="number"
                min="0"
                max="100000"
                step="0.01"
                defaultValue={order.payment_mode === 'cod' ? order.payment.amount_due / 100 : 0}
              />
            </label>
            <button className="button primary" disabled={busy}>
              Zapisz podgląd przesyłki
            </button>
          </form>
        )}
        {data.data.map((p: any) => (
          <article className="shipping-plan" key={p.id}>
            <header>
              <strong>{names[p.state] ?? p.state}</strong>
              <span>
                {p.simulation === 'true'
                  ? 'DEMO lokalne'
                  : p.mode === 'sandbox'
                    ? 'Sandbox InPost'
                    : 'InPost API'}{' '}
                · {date(p.created_at)}
              </span>
            </header>
            <p>
              {p.input.service === 'inpost_locker_standard' ? 'Paczkomat' : 'Kurier'} ·{' '}
              {p.input.receiver.first_name} {p.input.receiver.last_name}
              {p.input.target_point && ' · ' + p.input.target_point} · {p.input.weight} kg
            </p>
            {p.error && <p className="notice error">{p.error}</p>}
              {connectorContext&&p.provider==='inpost'&&p.simulation==='false'&&p.job_id&&<OrdinaryConnectorJobControl {...connectorContext} externalWriteBlocked={connectorContext.externalWriteBlocked||busy||!write} jobId={p.job_id} kind="shipping" onChanged={()=>{void load();onChanged();}}/>}
            {p.state === 'preview' && (
              <>
                <details>
                  <summary>Dane do wysłania do InPost</summary>
                  <pre>{JSON.stringify(p.payload, null, 2)}</pre>
                </details>
                {write && (
                  <>
                    <label className="shipping-check">
                      <input
                        type="checkbox"
                        checked={!!confirmation[p.id]}
                        onChange={(e) =>
                          setConfirmation({ ...confirmation, [p.id]: e.target.checked })
                        }
                      />
                      Potwierdzam przekazanie danych odbiorcy do InPost (DEMO pozostaje lokalne).
                    </label>
                    <div className="shipping-actions">
                      {!(contextKey && p.simulation === 'true') && <button
                        className="button primary"
                        disabled={busy || (p.mode === 'live' && !confirmation[p.id])}
                        onClick={() =>
                          run('/shipping-plans/' + p.id + '/queue', {
                            confirm_live: !!confirmation[p.id],
                          })
                        }
                      >
                        Pobierz wycenę
                      </button>}
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => run('/shipping-plans/' + p.id + '/cancel')}
                      >
                        Anuluj podgląd
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
            {p.state === 'quoted' && (
              <>
                <p className="muted">
                  {p.simulation === 'true'
                    ? 'Cena przykładowa z lokalnej symulacji. Nie jest ofertą przewoźnika.'
                    : 'Cena zwrócona przez API. Warunki podatkowe i rozliczeniowe wynikają z umowy z InPost.'}
                </p>
                {p.offers.map((o: any) => (
                  <div className="shipping-quote" key={o.id}>
                    <strong>
                      {o.rate === null ? 'Cena według umowy' : money(o.rate, o.currency)}
                    </strong>
                    <span>Ważna do {o.expires_at ? date(o.expires_at) : 'brak terminu'}</span>
                    {write && (
                      <>
                        <label className="shipping-check">
                          <input
                            type="checkbox"
                            checked={!!confirmation[p.id + 'buy']}
                            onChange={(e) =>
                              setConfirmation({ ...confirmation, [p.id + 'buy']: e.target.checked })
                            }
                          />
                          {p.simulation === 'true'
                            ? 'Potwierdzam symulowany zakup'
                            : 'Potwierdzam zakup i rozliczenie tej etykiety'}
                        </label>
                        {o.rate === null && (
                          <label className="shipping-check">
                            <input
                              type="checkbox"
                              checked={!!unknown[p.id]}
                              onChange={(e) => setUnknown({ ...unknown, [p.id]: e.target.checked })}
                            />
                            Akceptuję cenę według umowy, której API nie zwraca.
                          </label>
                        )}
                        <button
                          className="button primary"
                          disabled={
                            busy ||
                            !confirmation[p.id + 'buy'] ||
                            (o.rate === null && !unknown[p.id]) ||
                            !o.expires_at ||
                            new Date(o.expires_at).getTime() <= Date.now()
                          }
                          onClick={() =>
                            run('/shipping-plans/' + p.id + '/buy', {
                              offer_id: o.id,
                              confirm_cost: !!confirmation[p.id + 'buy'],
                              ack_unknown_rate: !!unknown[p.id],
                            })
                          }
                        >
                          Kup etykietę{o.rate !== null ? ' · ' + money(o.rate, o.currency) : ''}
                        </button>
                      </>
                    )}
                  </div>
                ))}
                {write && (
                  <div className="shipping-actions">
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => run('/shipping-plans/' + p.id + '/refresh')}
                    >
                      <RefreshCw size={16} />
                      Odśwież wycenę
                    </button>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => run('/shipping-plans/' + p.id + '/cancel')}
                    >
                      Anuluj przesyłkę
                    </button>
                  </div>
                )}
              </>
            )}
            {['ready', 'dispatched'].includes(p.state) && (
              <>
                <p>
                  <strong>{p.result?.tracking_number}</strong>
                </p>
                {Array.isArray(p.result?.parcels) && p.result.parcels.length > 1 && (
                  <p>
                    Paczki ({p.result.parcels.length}):{' '}
                    {p.result.parcels
                      .map((x: any) => x.tracking_number ?? 'numer paczki ' + (x.index + 1) + ' nieznany')
                      .join(' · ')}
                  </p>
                )}
                <div className="shipping-actions">
                  <a
                    className="button"
                    href={'/api/shipments/' + p.shipment_id + '/label'}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Printer size={16} />
                    {p.simulation === 'true' ? 'Etykieta DEMO' : 'Etykieta PDF'}
                  </a>
                  {onPrintLabel && p.shipment_id && <button className="button" disabled={busy || !write}
                    onClick={() => onPrintLabel(p.shipment_id)}><Printer size={16} /> Zleć druk etykiety</button>}
                  {write && p.state === 'ready' && (
                    <>
                      <label className="shipping-check">
                        <input
                          type="checkbox"
                          checked={!!confirmation[p.id + 'dispatch']}
                          onChange={(e) =>
                            setConfirmation({
                              ...confirmation,
                              [p.id + 'dispatch']: e.target.checked,
                            })
                          }
                        />
                        Paczka jest spakowana i przekazana do wysyłki; potwierdzam rozchód towaru.
                      </label>
                      <button
                        className="button primary"
                        disabled={busy || !confirmation[p.id + 'dispatch']}
                        onClick={() => run('/shipping-plans/' + p.id + '/dispatch')}
                      >
                        Potwierdź przekazanie paczki
                      </button>
                    </>
                  )}
                  {write && (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => run('/shipments/' + p.shipment_id + '/tracking')}
                    >
                      Odczytaj tracking
                    </button>
                  )}
                  {write && p.simulation === 'true' && p.state === 'dispatched' && (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        run('/shipments/' + p.shipment_id + '/tracking', {
                          demo_status: 'delivered',
                        })
                      }
                    >
                      DEMO: zasymuluj doręczenie
                    </button>
                  )}
                </div>
                {p.state === 'dispatched' && p.shipment_id && (
                  <CarrierReturns shipmentId={p.shipment_id} provider="inpost" write={write} admin={admin} buyer={{ name: order.customer_name ?? '', email: order.email ?? '', phone: order.address?.phone ?? '', street: order.address?.street ?? '', city: order.address?.city ?? '', postal_code: order.address?.postal_code ?? '' }} />
                )}
              </>
            )}
            {contextKey && p.simulation === 'true' && <LocalCarrierDemo
              key={contextKey+':'+order.id+':'+p.id} contextKey={contextKey}
              order={order} plan={p} write={write} disabled={busy}
              onChanged={()=>{void load();onChanged();}} />}
            {p.state === 'failed' && write && (
              <div className="shipping-actions">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => run('/shipping-plans/' + p.id + '/reconcile')}
                >
                  Uzgodnij wynik zadania
                </button>
                {p.remote_id && ['created', 'buy_ready', 'refresh_started'].includes(p.phase) && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => run('/shipping-plans/' + p.id + '/refresh')}
                  >
                    Nowa wycena
                  </button>
                )}
                {!['buy_started', 'confirmed'].includes(p.phase) && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => run('/shipping-plans/' + p.id + '/cancel')}
                  >
                    Anuluj przygotowanie
                  </button>
                )}
              </div>
            )}
          </article>
        ))}
        {data.meta.cursor && (
          <button
            className="button"
            disabled={busy}
            onClick={async () => {
              try {
                const d = await api('/orders/' + order.id + '/shipping?after=' + data.meta.cursor);
                setData({ ...d, data: [...data.data, ...d.data] });
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            Starsze plany
          </button>
        )}
        {order.shipments
          .filter((s: any) => s.channel_id && s.tracking_data)
          .map((s: any) => (
            <div className="shipping-tracking" key={s.id}>
              <strong>Tracking: {trackingName(s.tracking_data.status)}</strong>
              <p className="muted">
                {s.tracking_data.scope === 'local_simulation'
                  ? 'Symulacja lokalna'
                  : 'Odczyt InPost'}{' '}
                · {date(s.tracking_at)}. Automatyczne doręczenie zależy od harmonogramu kanału.
              </p>
              {s.tracking_data.tracking_details.slice(0, 10).map((x: any, i: number) => (
                <p key={i}>
                  {trackingName(x.status ?? 'unknown')} · {date(x.datetime)}
                  {x.code ? ' · DPD ' + x.code : ''}
                  {x.waybill ? ' · ' + x.waybill : ''}
                </p>
              ))}
            </div>
          ))}
      </div>
    </section>
  );
}
