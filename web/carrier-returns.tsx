import { useEffect, useState, type FormEvent } from 'react';
import { Printer, Undo2 } from 'lucide-react';
import { api, date } from './api';

// Return label (migration 254, prepared as 261) for a dispatched DPD or InPost shipment: a separate carrier
// shipment from the buyer back to the merchant. The original shipment and the stock stay untouched.
const STATE: Record<string, string> = {
  preview: 'Podgląd',
  queued: 'Tworzenie',
  label_ready: 'Etykieta gotowa',
  failed: 'Odrzucona',
  uncertain: 'Niepewna — uzgodnij u przewoźnika',
  cancelled: 'Wycofana',
};
interface Props {
  shipmentId: string;
  provider: 'dpd' | 'inpost';
  write: boolean;
  /** An administrator may withdraw an uncertain request after checking the carrier panel. */
  admin?: boolean;
  /** Prefills the buyer as sender of the return. */
  buyer: { name: string; email: string; phone: string; street: string; city: string; postal_code: string };
}
export function CarrierReturns({ shipmentId, provider, write, admin = false, buyer }: Props) {
  const [data, setData] = useState<any[] | null>(null),
    [open, setOpen] = useState(false),
    [confirmed, setConfirmed] = useState<Record<string, boolean>>({}),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(() => crypto.randomUUID());
  async function load() {
    try {
      setData((await api('/shipments/' + shipmentId + '/returns')).data);
    } catch (e: any) {
      // A database without migration 254 answers 503: the section stays hidden.
      setData(null);
      if (!/nie są zainstalowane/.test(e.message)) setError(e.message);
    }
  }
  useEffect(() => {
    void load();
  }, [shipmentId]);
  // The label is created by the worker: re-read while a request is queued.
  const pending = data?.some((r) => r.state === 'queued') ?? false;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [pending, shipmentId]);
  async function run(path: string, body: unknown = {}) {
    setBusy(true);
    setError('');
    try {
      await api(path, 'POST', body);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function preview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      v = (k: string) => String(f.get(k) ?? '').trim();
    const [first, ...rest] = buyer.name.split(' ');
    const body =
      provider === 'dpd'
        ? {
            client_key: key,
            sender: { name: buyer.name, address: buyer.street, city: buyer.city, postalCode: buyer.postal_code, phone: buyer.phone, email: buyer.email },
            receiver: { name: v('name'), address: v('address'), city: v('city'), postalCode: v('postalCode'), phone: v('phone'), email: v('email') },
            weight: Number(v('weight')),
            dimensions: { length: Number(v('length')), width: Number(v('width')), height: Number(v('height')) },
            content: v('content'),
          }
        : {
            client_key: key,
            sender: { first_name: first, last_name: rest.join(' ') || first, email: buyer.email, phone: buyer.phone },
            receiver: { first_name: v('first_name'), last_name: v('last_name'), email: v('email'), phone: v('phone') },
            target_point: v('target_point').toUpperCase(),
            template: v('template'),
            weight: Number(v('weight')),
            max_rate_minor: Math.round(Number(v('max_rate').replace(',', '.')) * 100),
          };
    await run('/shipments/' + shipmentId + '/returns/preview', body);
    setKey(crypto.randomUUID());
    setOpen(false);
  }
  if (data === null) return error ? <p className="error">{error}</p> : null;
  const live = data.some((r) => ['queued', 'label_ready', 'uncertain'].includes(r.state));
  return (
    <div className="carrier-returns">
      <h4>
        <Undo2 size={16} /> Etykieta zwrotna {provider === 'dpd' ? 'DPD' : 'InPost'}
      </h4>
      {error && <p className="error">{error}</p>}
      {data.map((r) => (
        <div key={r.id} className="shipping-plan">
          <p>
            <strong>{STATE[r.state] ?? r.state}</strong> · {date(r.created_at)}
            {r.tracking_number && <> · numer zwrotu <strong>{r.tracking_number}</strong></>}
            {r.result?.rate_minor ? <> · cena {(r.result.rate_minor / 100).toFixed(2)} zł</> : null}
          </p>
          {r.error && <p className="error">{r.error}</p>}
          <div className="shipping-actions">
            {r.state === 'label_ready' && (
              <a className="button" href={'/api/carrier-returns/' + r.id + '/label'} target="_blank" rel="noreferrer">
                <Printer size={16} /> Etykieta zwrotna PDF
              </a>
            )}
            {write && r.state === 'preview' && (
              <>
                <label className="shipping-check">
                  <input type="checkbox" checked={!!confirmed[r.id]} onChange={(e) => setConfirmed({ ...confirmed, [r.id]: e.target.checked })} />
                  Przekazuję dane kupującego przewoźnikowi i zlecam przesyłkę zwrotną według umowy
                  {provider === 'inpost' && ` (najwyżej ${(r.input.max_rate_minor / 100).toFixed(2)} zł)`}.
                </label>
                <button className="button primary" disabled={busy || !confirmed[r.id]}
                  onClick={() => run('/carrier-returns/' + r.id + '/queue', { confirm_external: true })}>
                  Utwórz etykietę zwrotną
                </button>
              </>
            )}
            {write && ['uncertain', 'failed'].includes(r.state) && ['create_started', 'created', 'buy_started', 'numbers_ready'].includes(r.phase) && (
              <button className="button" disabled={busy} onClick={() => run('/carrier-returns/' + r.id + '/reconcile')}>
                Uzgodnij wynik u przewoźnika
              </button>
            )}
            {write && (r.state === 'preview' || (r.state === 'failed' && ['ready', 'rejected', 'created'].includes(r.phase)) || (r.state === 'uncertain' && admin)) && (
              <button className="button" disabled={busy} onClick={() => run('/carrier-returns/' + r.id + '/cancel')}>
                Wycofaj
              </button>
            )}
          </div>
        </div>
      ))}
      {write && !live && !open && (
        <button className="button" onClick={() => setOpen(true)}>
          <Undo2 size={16} /> Przygotuj etykietę zwrotną
        </button>
      )}
      {write && !live && open && (
        <form className="shipping-form" onSubmit={preview}>
          <p>Nadawca zwrotu: {buyer.name}, {buyer.street}, {buyer.postal_code} {buyer.city}</p>
          {provider === 'dpd' ? (
            <>
              <label>Odbiorca zwrotu (magazyn)<input name="name" required minLength={2} /></label>
              <label>Ulica i numer<input name="address" required minLength={3} /></label>
              <label>Kod pocztowy<input name="postalCode" required pattern="\d{2}-?\d{3}" /></label>
              <label>Miasto<input name="city" required /></label>
              <label>Telefon<input name="phone" required pattern="\+?\d{9,15}" /></label>
              <label>E-mail<input name="email" type="email" required /></label>
              <label>Waga kg<input name="weight" type="number" step="0.01" min="0.01" max="31.5" defaultValue="1" required /></label>
              <label>Dł. cm<input name="length" type="number" min="1" max="175" defaultValue="30" required /></label>
              <label>Szer. cm<input name="width" type="number" min="1" max="175" defaultValue="20" required /></label>
              <label>Wys. cm<input name="height" type="number" min="1" max="175" defaultValue="10" required /></label>
              <label>Zawartość<input name="content" required minLength={2} defaultValue="Zwrot towaru" /></label>
            </>
          ) : (
            <>
              <label>Imię odbiorcy zwrotu<input name="first_name" required /></label>
              <label>Nazwisko<input name="last_name" required /></label>
              <label>E-mail<input name="email" type="email" required /></label>
              <label>Telefon<input name="phone" required pattern="\+?[0-9]{9,15}" /></label>
              <label>Paczkomat docelowy<input name="target_point" required pattern="[A-Za-z0-9_-]{3,30}" /></label>
              <label>Gabaryt
                <select name="template" defaultValue="small">
                  <option value="small">A</option>
                  <option value="medium">B</option>
                  <option value="large">C</option>
                </select>
              </label>
              <label>Waga kg<input name="weight" type="number" step="0.1" min="0.1" max="25" defaultValue="1" required /></label>
              <label>Najwyższa zatwierdzona cena zł<input name="max_rate" inputMode="decimal" required pattern="\d{1,4}([.,]\d{1,2})?" /></label>
            </>
          )}
          <div className="shipping-actions">
            <button className="button primary" disabled={busy}>Podgląd etykiety zwrotnej</button>
            <button type="button" className="button" onClick={() => setOpen(false)}>Anuluj</button>
          </div>
        </form>
      )}
    </div>
  );
}
