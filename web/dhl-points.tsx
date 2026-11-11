import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { api } from './api';

// Read-only DHL service point lookup (WebAPI2 getNearestServicepoints) for the DHL panel of the
// order card. Informational: the DHL shipment does not send delivery to a point yet.
export interface DhlPoint {
  id: string;
  name: string;
  type: string;
  address: { street: string; postalCode: string; city: string };
  location: { lat: number; lng: number } | null;
  hours: { day: string; open: string; close: string }[];
  description: string;
}
export interface DhlPointsReply {
  channel_id: string;
  scope: 'local_simulation' | 'external_sandbox' | 'external_api';
  count: number;
  data: DhlPoint[];
}
const malformed = () => new Error('Odpowiedź wyszukiwania punktów DHL jest niepoprawna. Wyszukaj ponownie.');
const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
/** Accepts only the bounded answer of GET /api/integrations/:id/dhl-points for the asked channel. */
export function dhlPointsReply(value: unknown, channelId: string): DhlPointsReply {
  const r = value as DhlPointsReply;
  if (
    !r ||
    Object.keys(r).sort().join(',') !== 'channel_id,count,data,scope' ||
    r.channel_id !== channelId ||
    !['local_simulation', 'external_sandbox', 'external_api'].includes(r.scope) ||
    !Array.isArray(r.data) ||
    r.data.length > 50 ||
    r.count !== r.data.length
  )
    throw malformed();
  for (const p of r.data)
    if (
      !p ||
      !str(p.id, 40) ||
      !p.id ||
      !str(p.name, 100) ||
      !str(p.type, 30) ||
      !str(p.description, 300) ||
      !p.address ||
      !str(p.address.street, 100) ||
      !str(p.address.postalCode, 6) ||
      !str(p.address.city, 50) ||
      !Array.isArray(p.hours) ||
      p.hours.length > 7 ||
      !p.hours.every((h) => h && str(h.day, 10) && str(h.open, 5) && str(h.close, 5))
    )
      throw malformed();
  return r;
}
const postcode = (v: string) => (/^\d{5}$/.test(v) ? v.slice(0, 2) + '-' + v.slice(2) : v);
const SCOPE: Record<DhlPointsReply['scope'], string> = {
  local_simulation: 'przykład lokalny — dane nie pochodzą z DHL24',
  external_sandbox: 'sandbox DHL24',
  external_api: 'API DHL24',
};
interface DhlPointsLookupProps {
  channelId: string;
  defaultPostcode?: string;
  defaultCity?: string;
}
export function DhlPointsLookup({ channelId, defaultPostcode = '', defaultCity = '' }: DhlPointsLookupProps) {
  const [code, setCode] = useState(defaultPostcode),
    [city, setCity] = useState(defaultCity),
    [result, setResult] = useState<DhlPointsReply | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setResult(null);
    setError('');
    setBusy(false);
  }, [channelId]);
  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const g = ++epoch.current;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const q = new URLSearchParams({ postcode: code.trim(), ...(city.trim() ? { city: city.trim() } : {}) });
      const reply = dhlPointsReply(await api('/integrations/' + channelId + '/dhl-points?' + q), channelId);
      if (epoch.current === g) setResult(reply);
    } catch (err) {
      if (epoch.current === g) setError(err instanceof Error ? err.message : 'Nie udało się wyszukać punktów DHL.');
    } finally {
      if (epoch.current === g) setBusy(false);
    }
  }
  return (
    <details className="shipping-plan">
      <summary>Znajdź punkt DHL</summary>
      <p className="muted">
        Podgląd punktów DHL (POP, Parcelshop) w pobliżu kodu pocztowego. Wybór punktu nie zmienia przesyłki — doręczenie do
        punktu nie jest jeszcze wysyłane do DHL.
      </p>
      <form className="points-search" onSubmit={search}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label="Kod pocztowy punktów DHL"
          placeholder="00-000"
          pattern="[0-9]{2}-?[0-9]{3}"
          required
        />
        <input
          value={city}
          onChange={(e) => setCity(e.target.value)}
          aria-label="Miasto punktów DHL (opcjonalnie)"
          placeholder="Miasto (opcjonalnie)"
          maxLength={50}
        />
        <button className="button" disabled={busy} type="submit">
          <Search size={16} />
          Znajdź punkt DHL
        </button>
      </form>
      {busy && (
        <p className="notice" role="status">
          Wyszukiwanie punktów DHL…
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <p className="muted" role="status">
            Znaleziono {result.count} {result.count === 1 ? 'punkt' : 'punktów'} · {SCOPE[result.scope]}
          </p>
          <div className="points-grid">
            {result.data.map((p) => (
              <div key={p.id}>
                <strong>{p.name}</strong>
                <p>
                  {p.address.street}
                  <br />
                  {postcode(p.address.postalCode)} {p.address.city}
                </p>
                <small>
                  {p.type} · ID {p.id}
                </small>
              </div>
            ))}
          </div>
        </>
      )}
    </details>
  );
}
