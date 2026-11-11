/** DOM-AI-004 „Usuń tło”: per product image a background-removal request to the local processor; the result is a
 * new image shown next to the original. Only after „Sprawdziłem wynik” may the administrator swap it into the
 * product; „Odrzuć” keeps the product and both images. API: server/image-background-routes.ts. */
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { createCatalogJobReader } from './catalog-job-polling';

const states: Record<string, string> = {
  queued: 'W kolejce',
  running: 'Przetwarzanie',
  ready: 'Do przeglądu',
  applied: 'Zastosowano',
  rejected: 'Odrzucono',
  failed: 'Błąd usuwania tła',
  cancelled: 'Anulowano',
};
const open = (j: any) => j?.state === 'queued' || j?.state === 'running';
const hasOpenJob = (v: any) => Array.isArray(v?.data) && v.data.some(open);

export function CatalogAiImages({ product, saved }: { product: any; saved: () => void }) {
  const [data, setData] = useState<any>(),
    [selected, setSelected] = useState<string>(),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const reader = useRef<ReturnType<typeof createCatalogJobReader<any>> | undefined>(undefined);
  useEffect(() => {
    const owned = createCatalogJobReader<any>({
      read: (signal) => api('/products/' + product.id + '/ai/images', 'GET', undefined, {}, signal),
      accept: (r) => setData(r),
      error: (e: any) => setError(e.message),
      queued: hasOpenJob,
    });
    reader.current = owned;
    void owned.refresh();
    return () => {
      owned.dispose();
      if (reader.current === owned) reader.current = undefined;
    };
  }, [product.id]);
  const jobs: any[] = data?.data ?? [];
  const job = jobs.find((j) => j.id === selected) ?? jobs[0];
  useEffect(() => setApproved(false), [job?.id, job?.state]);
  async function action(fn: () => Promise<any>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await reader.current?.refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!data?.available) return null;
  const writable = !data.read_only;
  return (
    <section className="catalog-ai-panel catalog-section">
      <header className="panel-heading">
        <div>
          <h3>Zdjęcia: usuwanie tła</h3>
          <p>Lokalny procesor · nowa wersja zdjęcia do przeglądu</p>
        </div>
      </header>
      <p>
        Do lokalnego procesora trafia wyłącznie plik zdjęcia. Oryginał zostaje bez zmian; nowe zdjęcie zastąpi je w
        produkcie dopiero po zatwierdzeniu.
      </p>
      {error && (
        <p role="alert" className="error-inline">
          {error}
        </p>
      )}
      {data.images.length === 0 && <p className="muted">Produkt nie ma zdjęć z biblioteki.</p>}
      <ul className="catalog-ai-images">
        {data.images.map((img: any) => (
          <li key={img.id}>
            <img src={img.url} alt="Zdjęcie produktu" width={96} height={96} style={{ objectFit: 'contain' }} />
            {writable && (
              <button
                type="button"
                className="button"
                disabled={busy || jobs.some((j) => j.source_image_id === img.id && open(j))}
                onClick={() =>
                  action(async () => {
                    const r = await api('/products/' + product.id + '/ai/images', 'POST', {
                      client_key: crypto.randomUUID(),
                      image_id: img.id,
                      version: product.version,
                    });
                    setSelected(r.job.id);
                  })
                }
              >
                Usuń tło
              </button>
            )}
          </li>
        ))}
      </ul>
      {job && (
        <div className="catalog-ai-review">
          <strong>{states[job.state] ?? job.state}</strong>
          {job.error && (
            <p role="alert" className="error-inline">
              {job.error}
            </p>
          )}
          {job.result_url && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
              <figure>
                <img src={job.source_url} alt="Oryginał" style={{ maxWidth: '100%' }} />
                <figcaption>Oryginał</figcaption>
              </figure>
              <figure>
                <img
                  src={job.result_url}
                  alt="Wynik bez tła"
                  style={{ maxWidth: '100%', backgroundImage: 'repeating-conic-gradient(#ddd 0 25%, #fff 0 50%)', backgroundSize: '16px 16px' }}
                />
                <figcaption>Wynik bez tła</figcaption>
              </figure>
            </div>
          )}
          {job.state === 'ready' && writable && (
            <>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  aria-label="Sprawdziłem wynik"
                  checked={approved}
                  onChange={(e) => setApproved(e.target.checked)}
                />
                Sprawdziłem wynik
              </label>
              <button
                type="button"
                className="button primary"
                disabled={busy || !approved}
                onClick={() =>
                  action(async () => {
                    await api('/ai/catalog/images/' + job.id + '/apply', 'POST', { approve: true, version: product.version });
                    saved();
                  })
                }
              >
                Zastosuj nowe zdjęcie
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => action(() => api('/ai/catalog/images/' + job.id + '/reject', 'POST', {}))}
              >
                Odrzuć
              </button>
            </>
          )}
          {job.state === 'queued' && writable && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => action(() => api('/ai/catalog/images/' + job.id + '/reject', 'POST', {}))}
            >
              Anuluj zlecenie
            </button>
          )}
        </div>
      )}
      {jobs.length > 0 && (
        <details className="catalog-ai-history">
          <summary>Historia · ostatnie {data.history_limit} zleceń</summary>
          {jobs.map((j) => (
            <div key={j.id}>
              <button type="button" className="text-button" onClick={() => setSelected(j.id)}>
                {states[j.state] ?? j.state} · {new Date(j.created_at).toLocaleString('pl-PL')}
              </button>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
