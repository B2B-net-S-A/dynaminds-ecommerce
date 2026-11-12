import { useEffect, useState, type FormEvent } from 'react';
import { liveShipments } from './order-relabel';
import { Truck, Printer } from 'lucide-react';
import { api, date, money } from './api';
import { orderRecipientName, orderPickupPoint } from '../shared/order-invoice-party';
import { readTogether } from './read-polling';
import { useVisibleReadPolling } from './use-visible-read-polling';
import { trackingName } from './tracking';
import { DhlPointsLookup } from './dhl-points';

// Order panel of the carriers added by migration 234 (DHL Parcel Polska, Poczta Polska), on the DPD
// panel pattern: preview → explicit confirmation → number and stored PDF → tracking → hand-over.
export type CarrierProvider = 'dhl' | 'pocztapolska';
const CARRIER: Record<CarrierProvider, { title: string; short: string; services?: [string, string][]; codAccount: string; maxWeight: number; maxSide: number; content: number }> = {
  dhl: { title: 'Wysyłka DHL Parcel', short: 'DHL', codAccount: 'cod_bank_account', maxWeight: 31.5, maxSide: 175, content: 30 },
  pocztapolska: {
    title: 'Wysyłka Poczta Polska',
    short: 'Poczta Polska',
    services: [['pocztex_kurier', 'Pocztex Kurier'], ['paczka_pocztowa', 'Paczka pocztowa'], ['pocztex_punkt', 'Pocztex — odbiór w punkcie']],
    codAccount: 'cod_account',
    maxWeight: 30,
    maxSide: 150,
    content: 100,
  },
};
const STATE: Record<string, string> = {
  preview: 'Podgląd',
  queued: 'Tworzenie',
  ready: 'Etykieta gotowa',
  dispatched: 'Przekazana',
  failed: 'Wymaga uzgodnienia',
  cancelled: 'Anulowana',
};
const ADDRESS: Record<string, string> = {
  name: 'Nazwa / imię i nazwisko',
  address: 'Ulica i numer',
  city: 'Miasto',
  postalCode: 'Kod pocztowy',
  phone: 'Telefon',
  email: 'Email',
};
interface CarrierShippingPanelProps {
  provider: CarrierProvider;
  order: any;
  write: boolean;
  admin: boolean;
  onChanged: () => void;
}
export function CarrierShippingPanel({ provider, order, write, admin, onChanged }: CarrierShippingPanelProps) {
  const c = CARRIER[provider];
  const delivery = order.effective_delivery?.available
    ? order.effective_delivery.delivery
    : { recipient_name: orderRecipientName(order), ...order.address };
  const [data, setData] = useState<any[]>([]),
    [channels, setChannels] = useState<any[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [form, setForm] = useState(false),
    [confirmed, setConfirmed] = useState<Record<string, boolean>>({}),
    [selected, setSelected] = useState(''),
    [service, setService] = useState(c.services?.[0][0] ?? ''),
    [cod, setCod] = useState('0');
  useEffect(() => {
    setForm(false);
    setConfirmed({});
  }, [order.id, order.updated_at]);
  async function readData(current: () => boolean) {
    const [p, ch] = await readTogether([api('/orders/' + order.id + '/shipping'), api('/shipping/channels')]);
    if (!current()) return;
    setData(p.data.filter((x: any) => x.provider === provider));
    setChannels(ch.data.filter((x: any) => x.provider === provider));
  }
  const load = useVisibleReadPolling(order.id, readData, (e) => setError((e as Error).message));
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
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const address = (prefix: string) => Object.fromEntries(Object.keys(ADDRESS).map((k) => [k, f[prefix + '_' + k]]));
    const codMinor = Math.round(Number(f.cod) * 100);
    const p = await run('/orders/' + order.id + '/' + provider + '-shipping/preview', {
      channel_id: f.channel_id,
      ...(c.services ? { service: f.service } : {}),
      sender: address('sender'),
      receiver: address('receiver'),
      weight: Number(f.weight),
      dimensions: { length: Number(f.length), width: Number(f.width), height: Number(f.height) },
      content: f.content,
      cod: codMinor,
      ...(codMinor > 0 ? { [c.codAccount]: f.cod_account } : {}),
      insurance: Math.round(Number(f.insurance) * 100),
      ...(f.pickup_point_id ? { pickup_point_id: f.pickup_point_id } : {}),
    });
    if (p) setForm(false);
  }
  const channel = channels.find((ch) => ch.id === (selected || channels[0]?.id));
  const local = channel?.settings.simulation;
  const active = data.some((p) => !['preview', 'cancelled', 'dispatched'].includes(p.state));
  const scopeName = (p: any) =>
    p.simulation === 'true' ? 'Przykład lokalny' : p.mode === 'sandbox' ? 'Sandbox ' + c.short : 'API produkcyjne';
  return (
    <section className="panel shipping-panel">
      <div className="panel-heading">
        <h2>
          <Truck size={18} /> {c.title}
        </h2>
        <span className="muted">Podgląd → numer i PDF → przekazanie</span>
      </div>
      <div className="shipping-body">
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <p className="muted">
          Jedna paczka krajowa. Cena według umowy z przewoźnikiem. Etykieta PDF jest zapisywana przy utworzeniu
          przesyłki; utworzenie etykiety nie rozchoduje towaru. Pobranie trafia na wskazany rachunek (NRB).
        </p>
        {write && order.status === 'packed' && !active && !liveShipments(order.shipments).length && (
          <div className="shipping-actions">
            <button className="button primary" disabled={busy || !channels.length} onClick={() => setForm(!form)}>
              {form ? 'Zamknij formularz ' + c.short : 'Przygotuj przesyłkę ' + c.short}
            </button>
            {admin && !channels.some((ch) => ch.settings.simulation) && (
              <button
                className="button"
                disabled={busy}
                onClick={async () => {
                  const r = await run('/' + provider + '-shipping/example');
                  if (r) setSelected(r.channel_id);
                }}
              >
                Dodaj przykład lokalny {c.short}
              </button>
            )}
            {!channels.length && <span className="muted">Dodaj połączenie {c.short} w Integracjach.</span>}
          </div>
        )}
        {provider === 'dhl' && write && channel && (
          <DhlPointsLookup
            key={channel.id}
            channelId={channel.id}
            defaultPostcode={delivery?.postal_code ?? ''}
            defaultCity={delivery?.city ?? ''}
          />
        )}
        {form && (
          <form className="form-grid shipping-form" onSubmit={preview}>
            <label>
              Połączenie {c.short}
              <select name="channel_id" value={selected || channels[0]?.id || ''} onChange={(e) => setSelected(e.target.value)} required>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.name} · {ch.settings.simulation ? 'przykład lokalny' : ch.mode === 'sandbox' ? 'sandbox' : 'API produkcyjne'}
                  </option>
                ))}
              </select>
            </label>
            {c.services && (
              <label>
                Usługa
                <select name="service" value={service} onChange={(e) => setService(e.target.value)}>
                  {c.services.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="muted full-field">
              {local
                ? `Przykład lokalny nie wysyła danych do ${c.short}; numer jest lokalny (DEMO).`
                : `Dane nadawcy i odbiorcy trafią do wskazanego środowiska ${c.short} po zatwierdzeniu.`}
            </p>
            {(['sender', 'receiver'] as const).map((prefix) => {
              const title = prefix === 'sender' ? 'Nadawca' : 'Odbiorca';
              const defaults: Record<string, string> =
                prefix === 'sender'
                  ? local
                    ? { name: 'Nadawca DEMO', address: 'Testowa 1', city: 'Warszawa', postalCode: '01-354', phone: '500600700', email: 'qa@example.test' }
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
                  {Object.entries(ADDRESS).map(([key, label]) => (
                    <label key={key}>
                      {title} — {label}
                      <input
                        name={prefix + '_' + key}
                        type={key === 'email' ? 'email' : 'text'}
                        maxLength={key === 'city' ? 50 : key === 'name' ? 60 : 100}
                        pattern={key === 'postalCode' ? '[0-9]{2}-?[0-9]{3}' : key === 'phone' ? '[+]?[0-9]{9,15}' : undefined}
                        defaultValue={defaults[key]}
                        required
                      />
                    </label>
                  ))}
                </fieldset>
              );
            })}
            <label>
              Waga (kg)
              <input name="weight" type="number" min="0.01" max={c.maxWeight} step="0.01" defaultValue="1" required />
            </label>
            {Object.entries({ length: 'Długość (cm)', width: 'Szerokość (cm)', height: 'Wysokość (cm)' }).map(([key, label]) => (
              <label key={key}>
                {label}
                <input name={key} type="number" min="1" max={c.maxSide} step="1" defaultValue="20" required />
              </label>
            ))}
            <label>
              Zawartość
              <input name="content" maxLength={c.content} defaultValue="Towar ecommerce" required />
            </label>
            <label>
              Pobranie (PLN)
              <input name="cod" type="number" min="0" step="0.01" value={cod} onChange={(e) => setCod(e.target.value)} required />
            </label>
            {Number(cod) > 0 && (
              <label>
                Rachunek pobrania (NRB, 26 cyfr)
                <input name="cod_account" inputMode="numeric" pattern="(PL)?[0-9 ]{26,32}" required />
              </label>
            )}
            <label>
              Deklarowana wartość (PLN)
              <input name="insurance" type="number" min="0" step="0.01" defaultValue={order.total / 100} required />
            </label>
            {service === 'pocztex_punkt' && (
              <label>
                Identyfikator punktu odbioru
                <input name="pickup_point_id" pattern="[0-9]{1,10}" required defaultValue={/^\d{1,10}$/.test(orderPickupPoint(order)) ? orderPickupPoint(order) : ''} />
              </label>
            )}
            <button className="button primary full-field" disabled={busy}>
              Zapisz podgląd {c.short}
            </button>
          </form>
        )}
        {data.map((p) => {
          const s = order.shipments.find((x: any) => x.id === p.shipment_id);
          return (
            <div className="shipping-plan" key={p.id}>
              <header>
                <strong>{p.channel_name}</strong>
                <span>
                  {STATE[p.state] ?? p.state} · {scopeName(p)}
                </span>
              </header>
              <p className="muted">
                {date(p.created_at)} · {p.input.weight} kg · pobranie {money(p.input.cod)} · cena według umowy
              </p>
              {p.error && <p className="notice error">{p.error}</p>}
              {p.state === 'preview' && write && (
                <>
                  <details>
                    <summary>Dane planowanej przesyłki {c.short}</summary>
                    <pre className="api-preview">{JSON.stringify(p.payload, null, 2)}</pre>
                  </details>
                  <label className="shipping-check">
                    <input type="checkbox" checked={!!confirmed[p.id]} onChange={(e) => setConfirmed({ ...confirmed, [p.id]: e.target.checked })} />
                    {p.simulation === 'true'
                      ? `Potwierdzam lokalny przykład ${c.short}.`
                      : `Potwierdzam przekazanie danych, utworzenie przesyłki i etykiety w ${c.short} oraz cenę według umowy.`}
                  </label>
                  <div className="shipping-actions">
                    <button
                      className="button primary"
                      disabled={busy || !confirmed[p.id]}
                      onClick={() => run('/' + provider + '-shipping/' + p.id + '/queue', { confirm_external: true, ack_contract_rate: true })}
                    >
                      Utwórz przesyłkę i etykietę {c.short}
                    </button>
                    <button className="button" disabled={busy} onClick={() => run('/shipping-plans/' + p.id + '/cancel')}>
                      Anuluj podgląd
                    </button>
                  </div>
                </>
              )}
              {p.state === 'queued' && <p className="muted">Tworzenie przesyłki trwa; wynik pojawi się po odczycie.</p>}
              {['ready', 'dispatched'].includes(p.state) && (
                <>
                  <p>
                    <strong>{p.result?.tracking_number}</strong> ·{' '}
                    {p.result?.scope === 'local_simulation'
                      ? 'przykład lokalny'
                      : p.result?.scope === 'external_sandbox_verified'
                        ? 'potwierdzone przez sandbox ' + c.short
                        : 'potwierdzone przez API ' + c.short}
                    {p.result?.reconciled ? ' · uzgodnione po utraconej odpowiedzi' : ''}
                  </p>
                  {p.result?.cod && (
                    <p className="muted">
                      Pobranie {money(p.result.cod.amount)} na rachunek …{String(p.result.cod.bank_account).slice(-4)}
                    </p>
                  )}
                  {s?.tracking_data && <p>{trackingName(s.tracking_data.status)}</p>}
                  <div className="shipping-actions">
                    <a className="button" href={'/api/shipments/' + p.shipment_id + '/label'} target="_blank" rel="noreferrer">
                      <Printer size={16} />
                      {p.simulation === 'true' ? 'Etykieta przykładu' : 'Zapisana etykieta PDF'}
                    </a>
                    {write && (
                      <button className="button" disabled={busy} onClick={() => run('/shipments/' + p.shipment_id + '/tracking')}>
                        Sprawdź tracking {c.short}
                      </button>
                    )}
                    {write && p.state === 'ready' && (
                      <>
                        <label className="shipping-check">
                          <input
                            type="checkbox"
                            checked={!!confirmed[p.id + 'dispatch']}
                            onChange={(e) => setConfirmed({ ...confirmed, [p.id + 'dispatch']: e.target.checked })}
                          />
                          Paczka przekazana; potwierdzam rozchód towaru.
                        </label>
                        <button
                          className="button primary"
                          disabled={busy || !confirmed[p.id + 'dispatch']}
                          onClick={() => run('/' + provider + '-shipping/' + p.id + '/dispatch')}
                        >
                          Potwierdź przekazanie {c.short}
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
              {p.state === 'failed' && write && (
                <div className="shipping-actions">
                  {['create_started', 'numbers_ready'].includes(p.phase) && (
                    <button className="button" disabled={busy} onClick={() => run('/' + provider + '-shipping/' + p.id + '/reconcile')}>
                      Uzgodnij wynik bez ponownego utworzenia
                    </button>
                  )}
                  {['ready', 'rejected', 'absent'].includes(p.phase) && (
                    <button className="button" disabled={busy} onClick={() => run('/shipping-plans/' + p.id + '/cancel')}>
                      Anuluj niewysłany lub odrzucony plan
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
