import { useEffect, useState } from 'react';
import { api, date } from './api';
const states: Record<string, string> = {
  pending: 'Oczekuje',
  running: 'W trakcie',
  done: 'Zakończono',
  queued: 'W kolejce',
  skipped: 'Pominięto',
  conflict: 'Wymaga uzgodnienia',
  failed: 'Błąd',
  cancelled: 'Anulowano',
  preview: 'Podgląd',
};
export function EbayFulfillmentSchedulePanel({ channel }: { channel: any }) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [since, setSince] = useState(new Date(Date.now() - 86400000).toISOString().slice(0, 10)),
    [rows, setRows] = useState([{ local_carrier: '', ebay_code: '' }]);
  const load = async () => {
    const v = await api(`/integrations/${channel.id}/ebay-fulfillment`);
    setData(v);
    if (v.config) {
      setRows(v.config.carrier_mappings);
      setSince(v.config.shipped_since.slice(0, 10));
    }
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [channel.id]);
  async function save(enabled: boolean) {
    setBusy(true);
    setError('');
    try {
      await api(`/integrations/${channel.id}/ebay-fulfillment`, 'PATCH', {
        version: data.config?.version ?? 0,
        enabled,
        confirm_external: confirm,
        shipped_since: enabled
          ? new Date(since + 'T00:00:00.000Z').toISOString()
          : data.config.shipped_since,
        carrier_mappings: enabled ? rows : data.config.carrier_mappings,
      });
      setConfirm(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel ebay-oauth-panel ebay-fulfillment-schedule-panel">
      <h3>{channel.name}</h3>
      <p>
        Po lokalnym przekazaniu całej paczki kurierowi aplikacja odczyta zamówienie eBay i zgłosi
        pozycje, przewoźnika oraz numer śledzenia. Sprawdza partie co minutę.
      </p>
      <p>
        {channel.settings.simulation
          ? 'Przykład lokalny — zero żądań do eBay.'
          : 'Automatyzacja może powiadamiać kupujących przez eBay. Wymaga sprawdzonej tożsamości konta i zgody sell.fulfillment.'}
      </p>
      {error && (
        <p role="alert" className="error-block">
          {error}
        </p>
      )}
      {data?.config?.error && <p className="error-block">{data.config.error}</p>}
      <strong>
        {data?.config?.enabled ? 'Automatyzacja włączona' : 'Automatyzacja wyłączona'}
      </strong>
      <label>
        Początek przekazanych przesyłek (UTC)
        <input
          type="date"
          value={since}
          disabled={busy}
          onChange={(e) => setSince(e.target.value)}
        />
      </label>
      <p>
        Maksymalnie 90 dni wstecz. Mapuj dokładną nazwę przewoźnika zapisaną na lokalnej przesyłce
        na kod akceptowany przez eBay. Brak mapowania zatrzymuje paczkę.
      </p>
      {rows.map((r, i) => (
        <div className="inline-actions" key={i}>
          <label>
            Lokalny przewoźnik {i + 1}
            <input
              value={r.local_carrier}
              disabled={busy}
              onChange={(e) =>
                setRows(rows.map((m, j) => (j === i ? { ...m, local_carrier: e.target.value } : m)))
              }
            />
          </label>
          <label>
            Kod eBay {i + 1}
            <input
              value={r.ebay_code}
              disabled={busy}
              onChange={(e) =>
                setRows(rows.map((m, j) => (j === i ? { ...m, ebay_code: e.target.value } : m)))
              }
            />
          </label>
          {rows.length > 1 && (
            <button
              className="button"
              disabled={busy}
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              Usuń mapowanie {i + 1}
            </button>
          )}
        </div>
      ))}
      <button
        className="button"
        disabled={busy || rows.length >= 30}
        onClick={() => setRows([...rows, { local_carrier: '', ebay_code: '' }])}
      >
        Dodaj mapowanie przewoźnika
      </button>
      {!channel.settings.simulation && (
        <label className="checkbox-label">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          Potwierdzam automatyczne przekazywanie wysyłek i powiadomienia przez eBay.
        </label>
      )}
      <div className="inline-actions">
        <button
          className="button primary"
          disabled={busy || !data || (!channel.settings.simulation && !confirm)}
          onClick={() => save(true)}
        >
          Zapisz i włącz wysyłki eBay
        </button>
        <button
          className="button"
          disabled={busy || !data?.config?.enabled}
          onClick={() => save(false)}
        >
          Wyłącz wysyłki eBay
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() => load().catch((e) => setError(e.message))}
        >
          Odśwież automatyzację eBay
        </button>
      </div>
      <details>
        <summary>Zasady automatyzacji i uzgadniania</summary>
        <p>
          Już potwierdzone wysyłki i niepewne zgłoszenia są pomijane. Błąd jednej paczki jest
          zapisany raz dla tej konfiguracji; po poprawieniu danych zapisz konfigurację ponownie.
          Niepewny zapis wymaga uzgodnienia na karcie zamówienia.
        </p>
        <p>
          Wyłączenie zatrzymuje niewysłane plany automatyczne. Zgłoszenie, które mogło dotrzeć do
          eBay, zachowuje uzgadnianie odczytem. Ręczne plany pozostają niezależne.
        </p>
      </details>
      {data?.jobs.map((j: any) => (
        <p key={j.id}>
          Przegląd {date(j.created_at)} · {states[j.state] ?? j.state} · sprawdzono{' '}
          {j.stats?.checked ?? 0}, w kolejce {j.stats?.queued ?? 0}, pominięto{' '}
          {j.stats?.skipped ?? 0}, błędy {j.stats?.errors ?? 0}
          {j.error ? ' · ' + j.error : ''}
        </p>
      ))}
      <h4>Ostatnie wyniki przesyłek</h4>
      {data?.receipts.length === 0 && <p>Brak przetworzonych przesyłek.</p>}
      {data?.receipts.map((r: any) => (
        <p key={r.config_version + ':' + r.order_id}>
          Zamówienie {r.number} · konfiguracja {r.config_version} ·{' '}
          {r.plan_state === 'done'
            ? channel.settings.simulation
              ? 'Potwierdzono w przykładzie lokalnym'
              : 'Potwierdzono w eBay'
            : (states[r.plan_state ?? r.state] ?? r.state)}
          {r.error ? ' · ' + r.error : ''}
        </p>
      ))}
    </section>
  );
}
