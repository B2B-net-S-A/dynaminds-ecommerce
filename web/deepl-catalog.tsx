import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { createCatalogJobReader, hasQueuedCatalogJob } from './catalog-job-polling';
const states: Record<string, string> = {
  prepared: 'Podgląd przed wysłaniem',
  queued: 'W kolejce',
  ready: 'Do przeglądu',
  applied: 'Zapisano tłumaczenie',
  failed: 'Błąd',
  uncertain: 'Niepewny wynik',
  conflict: 'Dane lub uprawnienia zmieniono',
  cancelled: 'Anulowano',
};
export function DeepLCatalog({ product, saved }: { product: any; saved: () => void }) {
  const [data, setData] = useState<any>(),
    [metadata, setMetadata] = useState<any>(),
    [channel, setChannel] = useState(''),
    [source, setSource] = useState('pl'),
    [target, setTarget] = useState('en-US'),
    [formality, setFormality] = useState('default'),
    [selected, setSelected] = useState(''),
    [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [consent, setConsent] = useState(false),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const reader = useRef<ReturnType<typeof createCatalogJobReader<any>> | undefined>(undefined);
  async function reload() { return reader.current?.refresh(); }
  useEffect(() => {
    const owned = createCatalogJobReader<any>({
      read: (signal) => api('/products/' + product.id + '/deepl', 'GET', undefined, {}, signal),
      accept: (r) => {
        setData(r);
        setChannel((c) => c || r.channels[0]?.id || '');
      },
      error: (e: any) => setError(e.message),
      queued: hasQueuedCatalogJob,
    });
    reader.current = owned;
    void owned.refresh();
    return () => { owned.dispose(); if (reader.current === owned) reader.current = undefined; };
  }, [product.id]);
  async function loadMetadata() {
    if (!channel) return;
    setMetadata(undefined);
    try {
      setMetadata(await api('/integrations/' + channel + '/deepl'));
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    let active = true;
    const owned = new AbortController();
    setMetadata(undefined);
    setConsent(false);
    if (channel)
      api('/integrations/' + channel + '/deepl', 'GET', undefined, {}, owned.signal)
        .then((r) => {
          if (!active) return;
          setMetadata(r);
          setSource((v) =>
            r.languages.some((l: any) => l.lang === v && l.usable_as_source)
              ? v
              : (r.languages.find((l: any) => l.usable_as_source)?.lang ?? ''),
          );
          setTarget((v) =>
            r.languages.some((l: any) => l.lang === v && l.usable_as_target)
              ? v
              : (r.languages.find((l: any) => l.usable_as_target)?.lang ?? ''),
          );
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
      owned.abort();
    };
  }, [channel]);
  const draft = data?.data.find((d: any) => d.id === selected),
    languages = metadata?.languages ?? [],
    supportsFormality =
      languages.find((l: any) => l.lang === target)?.features?.formality?.status === 'stable';
  useEffect(() => {
    setConsent(false);
    setApproved(false);
    setName(draft?.reviewed_text?.name ?? draft?.output?.name ?? '');
    setDescription(draft?.reviewed_text?.description ?? draft?.output?.description ?? '');
  }, [draft?.id, draft?.state]);
  useEffect(() => {
    setFormality('default');
  }, [target]);
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
  if (data && !data.available) return null;
  return (
    <section className="catalog-ai-panel catalog-section deepl-panel">
      <header className="panel-heading">
        <div>
          <h3>Tłumaczenia DeepL</h3>
          <p>Nazwa i opis · osobna wersja językowa</p>
        </div>
        <button className="button" onClick={loadMetadata} disabled={!channel || busy}>
          Sprawdź języki i limit
        </button>
      </header>
      <button type="button" className="button" onClick={reload} disabled={busy}>
        Odśwież szkice
      </button>
      <p>
        Podgląd nie wysyła nazwy ani opisu do DeepL. Po tłumaczeniu sprawdź treść i zatwierdź zapis
        do wybranego języka.
      </p>
      {data?.read_only && (
        <p className="notice">Podgląd kopii: operacje i odczyt API dostawcy wyłączone.</p>
      )}
      {error && (
        <p role="alert" className="error-inline">
          {error}
        </p>
      )}
      {!data?.channels.length && <p>Dodaj konto w Integracjach albo uruchom lokalny przykład.</p>}
      <button
        className="button"
        disabled={busy || data?.read_only}
        onClick={() =>
          action(async () => {
            const r = await api('/integrations/deepl-example', 'POST', {});
            setChannel(r.channel_id);
          })
        }
      >
        Dodaj lokalny przykład DeepL
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          action(async () => {
            const r = await api('/products/' + product.id + '/deepl/preview', 'POST', {
              version: product.version,
              client_key: crypto.randomUUID(),
              channel_id: channel,
              source_lang: source,
              target_lang: target,
              formality,
            });
            setSelected(r.id);
          });
        }}
      >
        <div className="catalog-ai-fields">
          <label>
            Połączenie DeepL
            <select
              aria-label="Połączenie DeepL"
              value={channel}
              required
              onChange={(e) => setChannel(e.target.value)}
            >
              {!channel && <option value="">Wybierz połączenie</option>}
              {data?.channels.map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.simulation ? 'DEMO lokalne' : 'API ' + c.api_plan}
                </option>
              ))}
            </select>
          </label>
          <label>
            Język źródłowy
            <select
              aria-label="Język źródłowy DeepL"
              value={source}
              required
              onChange={(e) => setSource(e.target.value)}
            >
              {languages
                .filter((l: any) => l.usable_as_source)
                .map((l: any) => (
                  <option key={l.lang} value={l.lang}>
                    {l.name} ({l.lang})
                  </option>
                ))}
            </select>
          </label>
          <label>
            Język docelowy
            <select
              aria-label="Język docelowy DeepL"
              value={target}
              required
              onChange={(e) => setTarget(e.target.value)}
            >
              {languages
                .filter((l: any) => l.usable_as_target)
                .map((l: any) => (
                  <option key={l.lang} value={l.lang}>
                    {l.name} ({l.lang})
                  </option>
                ))}
            </select>
          </label>
          <label>
            Styl tłumaczenia
            <select
              aria-label="Styl DeepL"
              value={formality}
              onChange={(e) => setFormality(e.target.value)}
            >
              <option value="default">Domyślny</option>
              <option value="prefer_more">Preferuj formalny</option>
              <option value="prefer_less">Preferuj nieformalny</option>
              {supportsFormality && (
                <>
                  <option value="more">Formalny</option>
                  <option value="less">Nieformalny</option>
                </>
              )}
            </select>
          </label>
        </div>
        {metadata?.simulation && (
          <p className="notice">
            DEMO: odpowiedzi lokalne. Brak połączenia z DeepL i naliczania znaków u dostawcy.
          </p>
        )}
        {metadata?.usage && (
          <p>
            Użycie konta: {metadata.usage.character_count.toLocaleString('pl-PL')} /{' '}
            {metadata.usage.character_limit.toLocaleString('pl-PL')} znaków.
            {metadata.usage.api_key_character_limit !== undefined && (
              <>
                {' '}
                Limit klucza: {metadata.usage.api_key_character_count.toLocaleString(
                  'pl-PL',
                )} / {metadata.usage.api_key_character_limit.toLocaleString('pl-PL')}.
              </>
            )}{' '}
            Dane mogą mieć opóźnienie; limit zostanie ponownie sprawdzony przed tłumaczeniem.
          </p>
        )}
        <button
          className="button"
          disabled={
            busy ||
            data?.read_only ||
            !channel ||
            !languages.length ||
            source.toLowerCase() === target.toLowerCase()
          }
        >
          Przygotuj podgląd DeepL
        </button>
      </form>
      {draft && (
        <div className="catalog-ai-review">
          <strong>
            {states[draft.state]} · {draft.source_lang} → {draft.target_lang} ·{' '}
            {draft.simulation ? 'DEMO lokalne' : 'DeepL API'}
          </strong>
          <p>
            Źródło: wersja {draft.source_version} · {draft.characters} znaków. Ważny do{' '}
            {new Date(draft.expires_at).toLocaleString('pl-PL')}.
          </p>
          <details open={draft.state === 'prepared'}>
            <summary>Tekst źródłowy DeepL</summary>
            <strong>{draft.source.name}</strong>
            <p className="catalog-description">{draft.source.description || 'Brak opisu'}</p>
          </details>
          {draft.error && (
            <p role="alert" className="error-inline">
              {draft.error}
            </p>
          )}
          {draft.state === 'uncertain' && (
            <p>
              Sprawdź użycie i wynik na koncie dostawcy. Automatyczne ponowienie tego szkicu jest
              zablokowane.
            </p>
          )}
          {draft.state === 'prepared' && (
            <>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                {draft.simulation
                  ? 'Uruchom lokalną symulację tłumaczenia'
                  : `Zgadzam się na przekazanie nazwy i opisu do DeepL oraz użycie ${draft.characters} znaków w ramach mojego planu API`}
              </label>
              <button
                className="button primary"
                disabled={
                  busy || !consent || data?.read_only || product.version !== draft.source_version
                }
                onClick={() =>
                  action(() =>
                    api('/deepl/drafts/' + draft.id + '/queue', 'POST', {
                      confirm_external: true,
                      max_characters: draft.characters,
                    }),
                  )
                }
              >
                Zleć tłumaczenie DeepL
              </button>
            </>
          )}
          {draft.output && (
            <>
              <label>
                Nazwa po przeglądzie
                <input
                  aria-label="Nazwa tłumaczenia DeepL"
                  value={name}
                  maxLength={200}
                  disabled={busy || draft.state !== 'ready'}
                  onChange={(e) => {
                    setName(e.target.value);
                    setApproved(false);
                  }}
                />
              </label>
              <label>
                Opis po przeglądzie
                <textarea
                  aria-label="Opis tłumaczenia DeepL"
                  value={description}
                  maxLength={10000}
                  rows={5}
                  disabled={busy || draft.state !== 'ready'}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setApproved(false);
                  }}
                />
              </label>
              {draft.usage && (
                <p>
                  {draft.simulation ? 'Symulowane' : 'Zwrócone przez DeepL'} naliczenie:{' '}
                  {draft.usage.billed_characters} znaków.
                </p>
              )}
              {draft.state === 'ready' && (
                <>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={approved}
                      onChange={(e) => setApproved(e.target.checked)}
                    />
                    Sprawdzono tłumaczenie i fakty; zatwierdzam wersję językową
                  </label>
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      !approved ||
                      data?.read_only ||
                      product.version !== draft.source_version
                    }
                    onClick={() =>
                      action(async () => {
                        await api('/deepl/drafts/' + draft.id + '/apply', 'POST', {
                          approve: true,
                          version: draft.source_version,
                          name,
                          description,
                        });
                        saved();
                      })
                    }
                  >
                    Zapisz tłumaczenie DeepL
                  </button>
                </>
              )}
            </>
          )}
          {['prepared', 'queued', 'ready'].includes(draft.state) &&
            (draft.state === 'ready' || !draft.attempted_at) && (
              <button
                className="button"
                disabled={busy || data?.read_only}
                onClick={() =>
                  action(() => api('/deepl/drafts/' + draft.id + '/cancel', 'POST', {}))
                }
              >
                Anuluj szkic DeepL
              </button>
            )}
          {product.version !== draft.source_version &&
            !['applied', 'cancelled'].includes(draft.state) && (
              <p role="alert">Produkt zmieniono. Przygotuj nowy podgląd aktualnej wersji.</p>
            )}
        </div>
      )}
      {!!data?.translations.length && (
        <div className="catalog-ai-translations">
          <h4>Zapisane wersje językowe</h4>
          {data.translations.map((t: any) => (
            <details key={t.locale}>
              <summary>
                {t.locale} · {t.name} ·{' '}
                {t.manual_receipt_id
                  ? 'Ręcznie'
                  : t.ai_draft_id
                    ? 'AI'
                    : t.deepl_draft_id
                      ? 'DeepL'
                      : 'Nieznane źródło'}
              </summary>
              <p className="catalog-description">{t.description}</p>
            </details>
          ))}
        </div>
      )}
      {!!data?.data.length && (
        <details className="catalog-ai-history">
          <summary>Historia DeepL · ostatnie {data.data.length} szkiców</summary>
          {data.data.map((d: any) => (
            <div key={d.id}>
              <button className="text-button" onClick={() => setSelected(d.id)}>
                {states[d.state]} · {d.source_lang} → {d.target_lang} ·{' '}
                {new Date(d.created_at).toLocaleString('pl-PL')}
              </button>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
