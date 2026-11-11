import {CatalogAttributesRead} from './catalog-attributes';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { createCatalogJobReader, hasQueuedCatalogJob } from './catalog-job-polling';
const languages: Record<string, string> = {
  pl: 'Polski',
  en: 'Angielski',
  de: 'Niemiecki',
  fr: 'Francuski',
  es: 'Hiszpański',
  cs: 'Czeski',
};
const tones: Record<string, string> = { factual: 'Rzeczowy', marketing: 'Marketingowy', technical: 'Techniczny' };
const lengths: Record<string, string> = { short: 'Krótki (do 400 znaków)', medium: 'Średni (do 1500 znaków)', long: 'Długi (do 4000 znaków)' };
const states: Record<string, string> = {
  queued: 'W kolejce',
  ready: 'Do przeglądu',
  applied: 'Zastosowano',
  failed: 'Błąd generowania',
  conflict: 'Produkt lub model zmieniono',
  cancelled: 'Anulowano',
};
export function CatalogAi({ product, saved }: { product: any; saved: () => void }) {
  const [runtime, setRuntime] = useState<any>(),
    [data, setData] = useState<any>(),
    [selected, setSelected] = useState<string>(),
    [model, setModel] = useState(''),
    [locale, setLocale] = useState('pl'),
    [destination, setDestination] = useState('catalog'),
    [tone, setTone] = useState('factual'),
    [length, setLength] = useState('medium'),
    [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function runtimeLoad(signal?: AbortSignal) {
    try {
      const r = await api('/ai/catalog/runtime', 'GET', undefined, {}, signal);
      if (signal?.aborted) return;
      setRuntime(r);
      setModel(
        (m) =>
          m || r.models.find((x: any) => x.name === 'qwen2.5:7b')?.name || r.models[0]?.name || '',
      );
    } catch (e: any) {
      if (!signal?.aborted) setError(e.message);
    }
  }
  const reader = useRef<ReturnType<typeof createCatalogJobReader<any>> | undefined>(undefined);
  async function reload() { return reader.current?.refresh(); }
  useEffect(() => {
    const owned = new AbortController();
    runtimeLoad(owned.signal);
    return () => owned.abort();
  }, []);
  useEffect(() => {
    if (!runtime?.available) return;
    const owned = createCatalogJobReader<any>({
      read: (signal) => api('/products/' + product.id + '/ai', 'GET', undefined, {}, signal),
      accept: (r) => {
        setData(r);
      },
      error: (e: any) => setError(e.message),
      queued: hasQueuedCatalogJob,
    });
    reader.current = owned;
    void owned.refresh();
    return () => { owned.dispose(); if (reader.current === owned) reader.current = undefined; };
  }, [product.id, runtime?.available]);
  const draft = data?.data.find((d: any) => d.id === selected);
  useEffect(() => {
    setApproved(false);
    setName(draft?.reviewed_text?.name ?? draft?.output?.name ?? '');
    setDescription(draft?.reviewed_text?.description ?? draft?.output?.description ?? '');
  }, [draft?.id, draft?.state]);
  async function action(fn: () => Promise<any>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (runtime && !runtime.available) return null;
  return (
    <section className="catalog-ai-panel catalog-section">
      <header className="panel-heading">
        <div>
          <h3>Treści produktu z AI</h3>
          <p>Lokalny model · szkic do przeglądu</p>
        </div>
        <button type="button" className="button" onClick={() => runtimeLoad()}>
          Sprawdź silnik AI
        </button>
      </header>
      <button type="button" className="button" onClick={reload} disabled={busy}>
        Odśwież szkice
      </button>
      <p>
        AI korzysta z nazwy, opisu, kategorii i parametrów tego produktu. Sprawdź fakty i język
        przed zatwierdzeniem. Treść może wymagać poprawek.
      </p>
      {runtime?.notice && <p className="notice">{runtime.notice}</p>}
      {error && (
        <p role="alert" className="error-inline">
          {error}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          action(async () => {
            const d = await api('/products/' + product.id + '/ai', 'POST', {
              version: product.version,
              client_key: crypto.randomUUID(),
              model,
              locale,
              destination,
              ...(destination === 'catalog' ? { style: { tone, length } } : {}),
            });
            setSelected(d.id);
          });
        }}
      >
        <div className="catalog-ai-fields">
          <label>
            Model lokalny
            <select
              aria-label="Model lokalny AI"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              required
            >
              {!model && <option value="">Brak modelu</option>}
              {runtime?.models.map((m: any) => (
                <option key={m.digest} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Proces
            <select
              aria-label="Proces AI"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            >
              <option value="catalog">Popraw treść główną katalogu</option>
              <option value="translation">Przygotuj tłumaczenie</option>
            </select>
          </label>
          {destination === 'catalog' && (
            <>
              <label>
                Styl
                <select aria-label="Ton treści AI" value={tone} onChange={(e) => setTone(e.target.value)}>
                  {Object.entries(tones).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Długość opisu
                <select aria-label="Długość opisu AI" value={length} onChange={(e) => setLength(e.target.value)}>
                  {Object.entries(lengths).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label>
            Język
            <select
              aria-label="Język treści AI"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
            >
              {Object.entries(languages).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button className="button" disabled={busy || !runtime?.generation_allowed || !model}>
          Przygotuj szkic AI
        </button>
      </form>
      {draft && (
        <div className="catalog-ai-review">
          <strong>
            {states[draft.state]} · {draft.model} · {languages[draft.locale]}
            {draft.destination === 'catalog' && draft.source?.style
              ? ' · ' + tones[draft.source.style.tone] + ', ' + (lengths[draft.source.style.length] ?? '').split(' ')[0].toLowerCase()
              : ''}
          </strong>
          <p>
            {draft.destination === 'translation'
              ? 'Zapis do tłumaczenia; główna nazwa i opis pozostaną zachowane.'
              : 'Zatwierdzenie zmieni główną nazwę i opis w katalogu.'}
          </p>
          {draft.error && (
            <p role="alert" className="error-inline">
              {draft.error}
            </p>
          )}
          {draft.output && (
            <>
              <details>
                <summary>Dane źródłowe szkicu</summary>
                <strong>{draft.source.name}</strong>
                <p className="catalog-description">{draft.source.description || 'Brak opisu'}</p>
                <CatalogAttributesRead attributes={draft.source.attributes}/>
              </details>
              <label>
                Tytuł po przeglądzie
                <input
                  aria-label="Tytuł szkicu AI"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setApproved(false);
                  }}
                  maxLength={200}
                  disabled={busy || draft.state !== 'ready'}
                />
              </label>
              <label>
                Opis po przeglądzie
                <textarea
                  aria-label="Opis szkicu AI"
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setApproved(false);
                  }}
                  maxLength={10000}
                  rows={6}
                  disabled={busy || draft.state !== 'ready'}
                />
              </label>
              {draft.state === 'ready' && (
                <>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={approved}
                      onChange={(e) => setApproved(e.target.checked)}
                    />
                    Sprawdzono treść i fakty; zatwierdzam zapis
                  </label>
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      !approved ||
                      product.version !== draft.source_version ||
                      runtime?.read_only
                    }
                    onClick={() =>
                      action(async () => {
                        await api('/ai/catalog/drafts/' + draft.id + '/apply', 'POST', {
                          approve: true,
                          version: draft.source_version,
                          name,
                          description,
                        });
                        saved();
                      })
                    }
                  >
                    Zatwierdź treść AI
                  </button>
                  <p className="muted">
                    Szkic ważny do {new Date(draft.expires_at).toLocaleString('pl-PL')}. Wersja
                    źródła: {draft.source_version}.
                  </p>
                  {product.version !== draft.source_version && (
                    <p role="alert">Produkt zmieniono; wygeneruj nowy szkic.</p>
                  )}
                </>
              )}
            </>
          )}
          {['queued', 'ready'].includes(draft.state) && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                action(() => api('/ai/catalog/drafts/' + draft.id + '/cancel', 'POST', {}))
              }
            >
              Anuluj szkic AI
            </button>
          )}
        </div>
      )}
      {data?.translations.length > 0 && (
        <div className="catalog-ai-translations">
          <h4>Zapisane tłumaczenia</h4>
          {data.translations.map((t: any) => (
            <details key={t.locale}>
              <summary>
                {languages[t.locale] ?? t.locale} · {t.name}
              </summary>
              <p className="catalog-description">{t.description}</p>
            </details>
          ))}
        </div>
      )}
      {data?.data.length > 0 && (
        <details className="catalog-ai-history">
          <summary>Historia AI · ostatnie {data.history_limit} szkiców</summary>
          {data.data.map((d: any) => (
            <div key={d.id}>
              <button className="text-button" onClick={() => setSelected(d.id)}>
                {states[d.state]} · {languages[d.locale]} ·{' '}
                {new Date(d.created_at).toLocaleString('pl-PL')}
              </button>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
