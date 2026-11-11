// COM-PORTAL-4 (migration 245): the administrator's default validity of buyer portal links.
import { useEffect, useState, type FormEvent } from 'react';
import { Link2 } from 'lucide-react';
import { api } from './api';
import { portalPolicySummary } from './s5comm253-labels';

interface Policy {
  available: boolean;
  default_days: number | null;
  version: number;
  links_without_expiry: number;
}
export function PortalLinkPolicy({ readOnly }: { readOnly: boolean }) {
  const [p, setP] = useState<Policy | null>(null),
    [error, setError] = useState(''),
    [info, setInfo] = useState(''),
    [busy, setBusy] = useState(false);
  const load = () => api<Policy>('/portal/link-policy').then(setP).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  async function run(fn: () => Promise<string>) {
    if (busy || readOnly) return;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      setInfo(await fn());
      await load();
    } catch (x: any) {
      setError(x.message);
    } finally {
      setBusy(false);
    }
  }
  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const raw = String(new FormData(e.currentTarget).get('days') ?? '').trim();
    run(async () => {
      const next = await api<Policy>('/portal/link-policy', 'PUT', { default_days: raw ? Number(raw) : null, version: p!.version });
      return 'Zapisano: ' + portalPolicySummary(next.default_days).toLowerCase() + '.';
    });
  }
  const apply = () =>
    run(async () => {
      const r = await api('/portal/link-policy/apply', 'POST', { confirmed: true, limit: 1000 });
      return `Ustawiono termin dla ${r.updated} linków${r.remaining ? `; zostało ${r.remaining} — uruchom ponownie` : ''}.`;
    });
  if (!p) return error ? <p className="notice error" role="alert">{error}</p> : null;
  if (!p.available) return null;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2><Link2 size={18} /> Ważność linku kupującego</h2>
        <span>{portalPolicySummary(p.default_days)}</span>
      </div>
      <div className="shipping-body">
        <p className="muted">
          Nowe zamówienia i każdy nowy link (rotacja) dostają ten termin. Po terminie portal, wiadomości, zwroty i płatność z linku są niedostępne,
          a kupujący widzi prośbę o kontakt ze sprzedawcą. Puste pole = linki bez terminu.
        </p>
        {error && <p className="notice error" role="alert">{error}</p>}
        {info && <p className="notice" role="status">{info}</p>}
        <form key={p.version} onSubmit={save} className="payment-form">
          <label>
            Ważność nowych linków (dni, 1–365)
            <input name="days" type="number" min={1} max={365} defaultValue={p.default_days ?? ''} disabled={readOnly} />
          </label>
          <button className="button primary" disabled={busy || readOnly}>Zapisz</button>
        </form>
        <p>
          Aktywne linki bez terminu: <strong>{p.links_without_expiry}</strong>
        </p>
        {p.default_days !== null && p.links_without_expiry > 0 && (
          <button className="button" disabled={busy || readOnly} onClick={apply}>
            Ustaw termin {p.default_days} dni od dziś dla istniejących linków
          </button>
        )}
      </div>
    </section>
  );
}
