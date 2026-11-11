import {OrdinaryConnectorJobControl,type ConnectorJobContext} from './ordinary-connector-job';
import { useEffect, useState, type FormEvent } from 'react';
import { Truck, Printer } from 'lucide-react';
import { api, date, money } from './api';
import { orderRecipientName } from '../shared/order-invoice-party';
import { readTogether } from './read-polling';
import { useVisibleReadPolling } from './use-visible-read-polling';
import { trackingName } from './tracking';
import { CarrierReturns } from './carrier-returns';
import type { PackingParcelSeed } from './packing-workstation';
export function DpdShippingPanel({
  order,
  write,
  admin,
  onChanged,
  parcelSeed,
  onPrintLabel,
  connectorContext,
}: {
  order: any;
  connectorContext?: ConnectorJobContext;
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
  const [data, setData] = useState<any[]>([]),
    [channels, setChannels] = useState<any[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [form, setForm] = useState(false),
    [confirmed, setConfirmed] = useState<Record<string, boolean>>({}),
    [rates, setRates] = useState<Record<string, boolean>>({}),
    [selected, setSelected] = useState('');
  const [packing, setPacking] = useState<PackingParcelSeed | undefined>();
  const [parcel, setParcel] = useState({ weight: '1', length: '20', width: '20', height: '20' });
  // Extra parcels of the same consignment (max 10 parcels in total).
  const [extras, setExtras] = useState<(typeof parcel)[]>([]);
  useEffect(() => { setForm(false); setConfirmed({}); setRates({}); setExtras([]); }, [deliveryBasis]);
  function changeParcel(key: keyof typeof parcel, value: string) {
    setPacking(undefined);
    setParcel((current) => ({ ...current, [key]: value }));
  }
  function changeExtra(index: number, key: keyof typeof parcel, value: string) {
    setExtras((current) => current.map((e, i) => (i === index ? { ...e, [key]: value } : e)));
  }
  async function readData(current: () => boolean) {
    const [p, c] = await readTogether([
      api('/orders/' + order.id + '/shipping'),
      api('/shipping/channels'),
    ]);
    if (!current()) return;
    setData(p.data);
    setChannels(c.data.filter((ch: any) => ch.provider === 'dpd'));
  }
  const load = useVisibleReadPolling(order.id, readData, e => setError((e as Error).message));
  async function run(path: string, body: any = {}) {
    setBusy(true);
    setError('');
    try {
      const r = await api(path, 'POST', body);
      await load();
      onChanged();
      return r;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function preview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    const address = (prefix: string) =>
      Object.fromEntries(
        ['name', 'address', 'city', 'postalCode', 'phone', 'email'].map((key) => [
          key,
          f[prefix + '_' + key],
        ]),
      );
    const p = await run('/orders/' + order.id + '/dpd-shipping/preview', {
      channel_id: f.channel_id,
      sender: address('sender'),
      receiver: address('receiver'),
      weight: Number(f.weight),
      dimensions: { length: Number(f.length), width: Number(f.width), height: Number(f.height) },
      additional_parcels: extras.map((e) => ({
        weight: Number(e.weight),
        dimensions: { length: Number(e.length), width: Number(e.width), height: Number(e.height) },
      })),
      content: f.content,
      cod: Math.round(Number(f.cod) * 100),
      insurance: Math.round(Number(f.insurance) * 100),
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
    if (p) {
      setForm(false);
      setExtras([]);
    }
  }
  const local = channels.find((ch) => ch.id === (selected || channels[0]?.id))?.settings.simulation;
  const active = data.some((p) => !['preview', 'cancelled', 'dispatched'].includes(p.state));
  return (
    <section className="panel shipping-panel">
      <div className="panel-heading">
        <h2>
          <Truck size={18} /> Wysyłka DPD
        </h2>
        <span className="muted">Podgląd → numer i PDF → przekazanie</span>
      </div>
      <div className="shipping-body">
        <div className="notice" style={{ overflowWrap: 'anywhere' }}>
          <strong>Operacyjny adres dostawy</strong>
          {delivery ? <p>{delivery.recipient_name} · {delivery.street} · {delivery.postal_code} {delivery.city} · {delivery.country} · {delivery.phone}</p> : <p>Rodzaj dostawy nie udostępnia zwykłego adresu. Sprawdź klasyfikację dostawy w karcie zamówienia.</p>}
          <p>Nowy formularz DPD zachowuje pełną ulicę i numer. Wpisany odbiorca i wcześniejsze podglądy są osobnymi danymi; przed przyjęciem przesyłki sprawdź je jawnie.</p>
        </div>
        {parcelSeed && write && order.status === 'packed' && (
          <div className="notice">
            <p>
              Pomiar paczki: {parcelSeed.measurements.weight_grams} g ·{' '}
              {parcelSeed.measurements.length_mm} × {parcelSeed.measurements.width_mm} ×{' '}
              {parcelSeed.measurements.height_mm} mm. Zastosowanie zastąpi wagę i wymiary bieżącego
              formularza; dane nadawcy i odbiorcy pozostaną w formularzu.
            </p>
            <button
              className="button"
              disabled={busy || active || Boolean(order.shipments.length)}
              onClick={() => {
                const m = parcelSeed.measurements;
                setPacking(parcelSeed);
                setParcel({
                  weight: String(m.weight_grams / 1000),
                  length: String(m.length_mm / 10),
                  width: String(m.width_mm / 10),
                  height: String(m.height_mm / 10),
                });
                setConfirmed({});
                setRates({});
                setForm(true);
              }}
            >
              Zastosuj pomiar w formularzu DPD
            </button>
          </div>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <p className="muted">
          Przesyłka krajowa, do 10 paczek w jednym nadaniu. Cena według umowy z DPD. Utworzenie etykiety nie rozchoduje towaru.
          Odbiór kuriera i protokoły znajdziesz w Integracjach → DPD. Automatyczny tracking
          skonfigurujesz w Integracjach → DPD → Automatyczny tracking.
        </p>
        {write && order.status === 'packed' && !active && !order.shipments.length && (
          <div className="shipping-actions">
            <button
              className="button primary"
              disabled={busy || !channels.length}
              onClick={() => setForm(!form)}
            >
              {form ? 'Zamknij formularz DPD' : 'Przygotuj przesyłkę DPD'}
            </button>
            {admin && !channels.some((ch) => ch.settings.simulation) && (
              <button
                className="button"
                disabled={busy}
                onClick={async () => {
                  const r = await run('/dpd-shipping/example');
                  if (r) setSelected(r.channel_id);
                }}
              >
                Dodaj przykład DPD DEMO
              </button>
            )}
          </div>
        )}
        {form && (
          <form className="form-grid shipping-form dpd-form" onSubmit={preview}>
            <label>
              Połączenie DPD
              <select
                name="channel_id"
                value={selected || channels[0]?.id || ''}
                onChange={(e) => setSelected(e.target.value)}
                required
              >
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.name} ·{' '}
                    {ch.settings.simulation
                      ? 'DEMO lokalne'
                      : ch.mode === 'sandbox'
                        ? 'DEMO DPD API'
                        : 'API produkcyjne'}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              {local
                ? 'Przykład lokalny nie wysyła danych do DPD.'
                : 'Dane nadawcy i odbiorcy trafią do wskazanego środowiska DPD po zatwierdzeniu.'}
            </p>
            {(['sender', 'receiver'] as const).map((prefix) => {
              const title = prefix === 'sender' ? 'Nadawca' : 'Odbiorca';
              const defaults: Record<string, string> =
                prefix === 'sender'
                  ? local
                    ? {
                        name: 'Nadawca DEMO',
                        address: 'Testowa 1',
                        city: 'Warszawa',
                        postalCode: '01-354',
                        phone: '500600700',
                        email: 'qa@example.test',
                      }
                    : {}
                  : {
                      name: delivery?.recipient_name ?? '',
                      address: delivery?.street ?? '',
                      city: delivery?.city ?? '',
                      postalCode: delivery?.postal_code ?? '',
                      phone: delivery?.phone ?? '',
                      email: order.email ?? '',
                    };
              return (
                <fieldset className="form-grid full-field" key={prefix + String(local)}>
                  <legend>{title}</legend>
                  {Object.entries({
                    name: 'Nazwa / imię i nazwisko',
                    address: 'Ulica i numer',
                    city: 'Miasto',
                    postalCode: 'Kod pocztowy',
                    phone: 'Telefon',
                    email: 'Email',
                  }).map(([key, label]) => (
                    <label key={key}>
                      {title} — {label}
                      <input
                        name={prefix + '_' + key}
                        type={key === 'email' ? 'email' : 'text'}
                        maxLength={key === 'city' ? 50 : 100}
                        pattern={
                          key === 'postalCode'
                            ? '[0-9]{2}-?[0-9]{3}'
                            : key === 'phone'
                              ? '[+]?[0-9]{9,15}'
                              : undefined
                        }
                        defaultValue={defaults[key]}
                        required
                      />
                    </label>
                  ))}
                </fieldset>
              );
            })}
            <label>
              Waga DPD (kg)
              <input
                name="weight"
                type="number"
                min="0.01"
                max="31.5"
                step="0.01"
                value={parcel.weight}
                onChange={(e) => changeParcel('weight', e.target.value)}
                required
              />
            </label>
            {Object.entries({
              length: 'Długość DPD (cm)',
              width: 'Szerokość DPD (cm)',
              height: 'Wysokość DPD (cm)',
            }).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  name={key}
                  type="number"
                  min="1"
                  max="175"
                  step="1"
                  value={parcel[key as 'length' | 'width' | 'height']}
                  onChange={(e) =>
                    changeParcel(key as 'length' | 'width' | 'height', e.target.value)
                  }
                  required
                />
              </label>
            ))}
            {extras.map((e, index) => (
              <fieldset className="form-grid full-field" key={index}>
                <legend>Paczka {index + 2}</legend>
                <label>
                  Waga paczki {index + 2} (kg)
                  <input
                    type="number"
                    min="0.01"
                    max="31.5"
                    step="0.01"
                    value={e.weight}
                    onChange={(ev) => changeExtra(index, 'weight', ev.target.value)}
                    required
                  />
                </label>
                {Object.entries({ length: 'Długość', width: 'Szerokość', height: 'Wysokość' }).map(
                  ([key, label]) => (
                    <label key={key}>
                      {label} paczki {index + 2} (cm)
                      <input
                        type="number"
                        min="1"
                        max="175"
                        step="1"
                        value={e[key as 'length' | 'width' | 'height']}
                        onChange={(ev) =>
                          changeExtra(index, key as 'length' | 'width' | 'height', ev.target.value)
                        }
                        required
                      />
                    </label>
                  ),
                )}
                <button
                  type="button"
                  className="button"
                  onClick={() => setExtras((current) => current.filter((_, i) => i !== index))}
                >
                  Usuń paczkę {index + 2}
                </button>
              </fieldset>
            ))}
            <div className="shipping-actions full-field">
              <button
                type="button"
                className="button"
                disabled={busy || extras.length >= 9}
                onClick={() => {
                  // A packing measurement proves one box; more parcels detach it.
                  setPacking(undefined);
                  setExtras((current) => [...current, { ...parcel }]);
                }}
              >
                Dodaj paczkę
              </button>
              <span className="muted">Paczki w nadaniu: {extras.length + 1} z 10</span>
            </div>
            {packing && (
              <p className="notice full-field">
                Formularz jest powiązany z pomiarem paczki, wersja {packing.profile_revision}.
                Zmiana wagi lub wymiarów odłączy pomiar. Serwer sprawdzi jego aktualność przed
                nadaniem.
              </p>
            )}
            <label>
              Zawartość DPD
              <input name="content" maxLength={300} defaultValue="Towar ecommerce" required />
            </label>
            <label>
              Pobranie DPD (PLN)
              <input name="cod" type="number" min="0" step="0.01" defaultValue="0" required />
            </label>
            <label>
              Deklarowana wartość DPD (PLN)
              <input
                name="insurance"
                type="number"
                min="0"
                step="0.01"
                defaultValue={order.total / 100}
                required
              />
            </label>
            <button className="button primary full-field" disabled={busy}>
              Zapisz podgląd DPD
            </button>
          </form>
        )}
        {data
          .filter((p) => p.provider === 'dpd')
          .map((p) => (
            <div className="shipping-plan" key={p.id}>
              <header>
                <strong>{p.channel_name}</strong>
                <span>
                  {(
                    {
                      preview: 'Podgląd',
                      queued: 'Tworzenie',
                      ready: 'Etykieta gotowa',
                      dispatched: 'Przekazana',
                      failed: 'Wymaga uzgodnienia',
                      cancelled: 'Anulowana',
                    } as any
                  )[p.state] ?? p.state}{' '}
                  ·{' '}
                  {p.simulation === 'true'
                    ? 'DEMO lokalne'
                    : p.mode === 'sandbox'
                      ? 'DEMO DPD API'
                      : 'API produkcyjne'}
                </span>
              </header>
              <p className="muted">
                {date(p.created_at)} · {p.input.weight} kg
                {p.input.additional_parcels?.length
                  ? ' · paczek: ' + (p.input.additional_parcels.length + 1)
                  : ''}{' '}
                · COD {money(p.input.cod)} · cena według
                umowy
              </p>
              {p.error && <p className="notice error">{p.error}</p>}
              {connectorContext&&p.provider==='dpd'&&p.simulation==='false'&&p.job_id&&<OrdinaryConnectorJobControl {...connectorContext} externalWriteBlocked={connectorContext.externalWriteBlocked||busy||!write} jobId={p.job_id} kind="shipping.dpd" onChanged={()=>{void load();onChanged();}}/>}
              {p.state === 'preview' && (
                <>
                  <details>
                    <summary>Dane planowanej przesyłki DPD</summary>
                    <pre className="api-preview">{JSON.stringify(p.payload, null, 2)}</pre>
                  </details>
                  {write && (
                    <>
                      <label className="shipping-check">
                        <input
                          type="checkbox"
                          checked={!!confirmed[p.id]}
                          onChange={(e) => setConfirmed({ ...confirmed, [p.id]: e.target.checked })}
                        />
                        {p.simulation === 'true'
                          ? 'Potwierdzam lokalną symulację DPD.'
                          : 'Potwierdzam przekazanie danych oraz utworzenie przesyłki i etykiety w DPD.'}
                      </label>
                      <label className="shipping-check">
                        <input
                          type="checkbox"
                          checked={!!rates[p.id]}
                          onChange={(e) => setRates({ ...rates, [p.id]: e.target.checked })}
                        />
                        Akceptuję cenę według umowy; API DPD nie zwraca wyceny.
                      </label>
                      <div className="shipping-actions">
                        <button
                          className="button primary"
                          disabled={busy || !confirmed[p.id] || !rates[p.id]}
                          onClick={() =>
                            run('/dpd-shipping/' + p.id + '/queue', {
                              confirm_external: true,
                              ack_contract_rate: true,
                            })
                          }
                        >
                          Utwórz przesyłkę i etykietę DPD
                        </button>
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() => run('/shipping-plans/' + p.id + '/cancel')}
                        >
                          Anuluj podgląd DPD
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
              {['ready', 'dispatched'].includes(p.state) && (
                <>
                  <p>
                    <strong>{p.result?.tracking_number}</strong> ·{' '}
                    {p.result?.scope === 'external_sandbox_verified'
                      ? 'Potwierdzone przez API DEMO DPD'
                      : p.result?.scope === 'local_simulation'
                        ? 'Symulacja lokalna'
                        : 'Potwierdzone przez API DPD'}
                  </p>
                  {p.result?.parcels?.length > 1 && (
                    <p>
                      Paczki ({p.result.parcels.length}):{' '}
                      {p.result.parcels.map((s: any) => s.waybill).join(', ')}
                    </p>
                  )}
                  {order.shipments.find((s: any) => s.id === p.shipment_id)?.tracking_data && (
                    <p>
                      {trackingName(
                        order.shipments.find((s: any) => s.id === p.shipment_id).tracking_data
                          .status,
                      )}
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
                      {p.simulation === 'true'
                        ? 'Etykieta DPD DEMO'
                        : 'Zapisana etykieta DPD PDF A4'}
                    </a>
                  {onPrintLabel && p.shipment_id && <button className="button" disabled={busy || !write}
                    onClick={() => onPrintLabel(p.shipment_id)}><Printer size={16} /> Zleć druk etykiety</button>}
                    {write && (p.simulation === 'true' || p.mode === 'live') && (
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => run('/shipments/' + p.shipment_id + '/tracking')}
                      >
                        Sprawdź tracking DPD
                      </button>
                    )}
                    {write && p.state === 'ready' && (
                      <>
                        <label className="shipping-check">
                          <input
                            type="checkbox"
                            checked={!!confirmed[p.id + 'dispatch']}
                            onChange={(e) =>
                              setConfirmed({ ...confirmed, [p.id + 'dispatch']: e.target.checked })
                            }
                          />
                          Paczka DPD przekazana; potwierdzam rozchód towaru.
                        </label>
                        <button
                          className="button primary"
                          disabled={busy || !confirmed[p.id + 'dispatch']}
                          onClick={() => run('/dpd-shipping/' + p.id + '/dispatch')}
                        >
                          Potwierdź przekazanie DPD
                        </button>
                      </>
                    )}
                  </div>
                  {p.state === 'dispatched' && p.shipment_id && (
                    <CarrierReturns shipmentId={p.shipment_id} provider="dpd" write={write} admin={admin} buyer={{ name: order.customer_name ?? '', email: order.email ?? '', phone: order.address?.phone ?? '', street: order.address?.street ?? '', city: order.address?.city ?? '', postal_code: order.address?.postal_code ?? '' }} />
                  )}
                </>
              )}
              {p.state === 'failed' && write && (
                <div className="shipping-actions">
                  {['create_started', 'numbers_ready'].includes(p.phase) && (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => run('/dpd-shipping/' + p.id + '/reconcile')}
                    >
                      Uzgodnij DPD po referencji
                    </button>
                  )}
                  {['ready', 'rejected'].includes(p.phase) && (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => run('/shipping-plans/' + p.id + '/cancel')}
                    >
                      Anuluj niewysłany lub odrzucony plan DPD
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
      </div>
    </section>
  );
}
