import { useEffect, useState, type FormEvent } from 'react';
import { api, date } from './api';

// DHL courier booking (dhl234_pickups): label-ready DHL parcels of one connection and a pickup window.
const STATE: Record<string, string> = {
  preview: 'Podgląd',
  queued: 'Zamawianie',
  booked: 'Zamówiony',
  failed: 'Odrzucony',
  uncertain: 'Niepewny — sprawdź w DHL24',
  cancel_queued: 'Anulowanie',
  cancelled: 'Anulowany',
};
export function DhlPickups({ channelId }: { channelId: string }) {
  const [data, setData] = useState<{ channel: any; data: any[]; parcels: any[] } | null>(null),
    [chosen, setChosen] = useState<string[]>([]),
    [confirmed, setConfirmed] = useState<Record<string, boolean>>({}),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(() => crypto.randomUUID());
  async function load() {
    try {
      setData(await api('/integrations/' + channelId + '/dhl-pickups'));
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    void load();
  }, [channelId]);
  // A queued booking or cancellation is finished by the worker: re-read until it settles.
  const pending = data?.data.some((r) => ['queued', 'cancel_queued'].includes(r.state));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [pending, channelId]);
  async function run(path: string, body: any = {}) {
    setBusy(true);
    setError('');
    try {
      const r = await api(path, 'POST', body);
      await load();
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
    const r = await run('/integrations/' + channelId + '/dhl-pickups/preview', {
      client_key: key,
      shipment_ids: chosen,
      date: f.date,
      from: f.from,
      to: f.to,
      ...(f.postcode ? { postcode: f.postcode } : {}),
      ...(f.info ? { info: f.info } : {}),
    });
    if (r) {
      setChosen([]);
      setKey(crypto.randomUUID());
    }
  }
  if (!data) return <p className="muted">{error || 'Wczytywanie…'}</p>;
  const local = data.channel.settings?.simulation;
  return (
    <div className="shipping-body">
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <p className="muted">
        Kurier DHL odbiera od poniedziałku do piątku, w oknie co najmniej 2 godzin, najpóźniej za 14 dni (czas polski).
        {local ? ' Przykład lokalny nie łączy się z DHL24.' : ' Zlecenie trafia do DHL24 po potwierdzeniu.'}
      </p>
      <form className="form-grid shipping-form" onSubmit={preview}>
        <div className="full-field">
          <strong>Przesyłki DHL z etykietą, jeszcze nieprzekazane</strong>
          {!data.parcels.length && <p className="muted">Brak przesyłek do odbioru.</p>}
          {data.parcels.map((p) => (
            <label key={p.id} className="shipping-check">
              <input
                type="checkbox"
                checked={chosen.includes(p.id)}
                onChange={(e) => setChosen(e.target.checked ? [...chosen, p.id] : chosen.filter((x) => x !== p.id))}
              />
              {p.tracking_number} · zamówienie {p.number}
            </label>
          ))}
        </div>
        <label>
          Data odbioru
          <input name="date" type="date" required />
        </label>
        <label>
          Od
          <input name="from" type="time" defaultValue="10:00" required />
        </label>
        <label>
          Do
          <input name="to" type="time" defaultValue="14:00" required />
        </label>
        <label>
          Kod pocztowy nadawcy (sprawdzenie godzin DHL)
          <input name="postcode" pattern="[0-9]{2}-?[0-9]{3}" />
        </label>
        <label>
          Uwagi dla kuriera
          <input name="info" maxLength={50} />
        </label>
        <button className="button primary full-field" disabled={busy || !chosen.length}>
          Przygotuj zamówienie kuriera DHL
        </button>
      </form>
      {data.data.map((r) => (
        <div className="shipping-plan" key={r.id}>
          <header>
            <strong>{r.requested_number}</strong>
            <span>{STATE[r.state] ?? r.state}</span>
          </header>
          <p className="muted">
            {r.payload.date} {r.payload.from}–{r.payload.to} · {r.waybills.length} przesyłek · {date(r.created_at)}
            {r.order_ids ? ' · zlecenie DHL ' + r.order_ids.join(', ') : ''}
          </p>
          {r.error && <p className="notice error">{r.error}</p>}
          {r.state === 'preview' && (
            <>
              {!local && (
                <label className="shipping-check">
                  <input type="checkbox" checked={!!confirmed[r.id]} onChange={(e) => setConfirmed({ ...confirmed, [r.id]: e.target.checked })} />
                  Potwierdzam przekazanie danych i zamówienie kuriera DHL według umowy.
                </label>
              )}
              <div className="shipping-actions">
                <button
                  className="button primary"
                  disabled={busy || (!local && !confirmed[r.id])}
                  onClick={() => run('/dhl-pickups/' + r.id + '/queue', { confirm_external: true })}
                >
                  Zamów kuriera DHL
                </button>
                <button className="button" disabled={busy} onClick={() => run('/dhl-pickups/' + r.id + '/cancel')}>
                  Odrzuć podgląd
                </button>
              </div>
            </>
          )}
          {r.state === 'booked' && (
            <button className="button" disabled={busy} onClick={() => run('/dhl-pickups/' + r.id + '/cancel')}>
              Anuluj zamówienie kuriera
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
