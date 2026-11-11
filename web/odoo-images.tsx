import { useEffect, useState } from 'react';
import { api, date } from './api';
export function OdooImages({ product, admin, saved }: any) {
  const [data, setData] = useState<any>(),
    [channel, setChannel] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState<Record<string, boolean>>({});
  const load = () =>
    api(`/products/${product.id}/odoo-images`).then((d) => {
      setData(d);
      setChannel((c) => c || d.mappings[0]?.id || '');
    });
  useEffect(() => {
    let current = true;
    api(`/products/${product.id}/odoo-images`)
      .then((d) => {
        if (current) {
          setData(d);
          setChannel(d.mappings[0]?.id || '');
        }
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [product.id, product.version]);
  if (!data?.mappings.length && !error) return null;
  async function run(fn: () => Promise<any>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="catalog-section">
      <h3>Zdjęcie z Odoo</h3>
      <p className="muted">
        Główne zdjęcie wariantu lub szablonu ERP, do 512 KiB. Podgląd zapisuje kopię lokalną.
        Zatwierdzenie dodaje zdjęcie do galerii i zachowuje dotychczasowe zdjęcia, cenę i stan.
        Galeria ERP i automatyczne odświeżanie nie są objęte tym importem.
      </p>
      {error && <div className="error">{error}</div>}
      {admin && data?.mappings.length > 0 && (
        <div className="toolbar-actions">
          <select
            aria-label="Konto Odoo zdjęcia"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            disabled={busy}
          >
            {data.mappings.map((m: any) => (
              <option key={m.id} value={m.id}>
                {m.name} · ID {m.external_id}
                {m.simulation ? ' · DEMO' : ''}
              </option>
            ))}
          </select>
          <button
            className="button"
            disabled={busy || !channel}
            onClick={() =>
              run(() =>
                api(`/products/${product.id}/odoo-images/preview`, 'POST', {
                  channel_id: channel,
                  version: product.version,
                  client_key: crypto.randomUUID(),
                }),
              )
            }
          >
            Pobierz podgląd zdjęcia Odoo
          </button>
        </div>
      )}
      {data?.history.map((p: any) => (
        <div className="info-body" key={p.id}>
          {p.state === 'preview' ? (
            <div className="catalog-images">
              <img
                src={p.url}
                alt={p.mode === 'simulation' ? 'Zdjęcie DEMO Odoo' : 'Podgląd zdjęcia Odoo'}
              />
            </div>
          ) : (
            <a href={p.url} target="_blank" rel="noreferrer">
              Otwórz zapisaną kopię zdjęcia
            </a>
          )}
          <p>
            {p.mode === 'simulation' ? 'DEMO — lokalny przykład' : 'Odoo — odczyt API'} ·{' '}
            {p.state === 'applied' ? 'Zatwierdzone w galerii' : 'Podgląd'} · {date(p.created_at)}
          </p>
          <p className="muted">SHA-256 {p.sha256}</p>
          {admin && p.can_apply && (
            <>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={!!confirm[p.id]}
                  onChange={(e) => setConfirm({ ...confirm, [p.id]: e.target.checked })}
                />
                Zatwierdzam dodanie tego zdjęcia do galerii produktu
              </label>
              <button
                className="button primary"
                disabled={busy || !confirm[p.id]}
                onClick={() =>
                  run(async () => {
                    await api(`/odoo-image-imports/${p.id}/apply`, 'POST', { confirm: true });
                    saved();
                  })
                }
              >
                Dodaj zdjęcie Odoo do galerii
              </button>
              <p className="muted">
                Podgląd ważny do {date(p.expires_at)}. Zmiana produktu, klucza lub powiązania wymaga
                nowego podglądu.
              </p>
            </>
          )}
        </div>
      ))}
    </section>
  );
}
