import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { createCatalogJobReader } from './catalog-job-polling';

/** DOM-AI-005: proposal of an offer category and parameters from product data, with preview and explicit consent.
 * Accepting stores the reviewed match for the offer form; it does not create or publish an offer. */
const states: Record<string, string> = {
  queued: 'W kolejce',
  running: 'Trwa dopasowanie',
  ready: 'Do przeglądu',
  accepted: 'Zatwierdzono',
  rejected: 'Odrzucono',
  failed: 'Błąd dopasowania',
  conflict: 'Produkt lub model zmieniono',
  cancelled: 'Anulowano',
  expired: 'Wygasło',
};
// Channels whose category and parameter definitions can be read today (server/catalog-ai-matching.ts).
const providers = ['allegro'];
const pending = (v: any) => Array.isArray(v?.data) && v.data.some((m: any) => ['queued', 'running'].includes(m?.state));
interface CatalogAiMatchProps {
  product: { id: string; version: number };
  saved: () => void;
}
export function CatalogAiMatch({ product, saved }: CatalogAiMatchProps) {
  const [runtime, setRuntime] = useState<any>(),
    [channels, setChannels] = useState<any[]>([]),
    [integration, setIntegration] = useState(''),
    [model, setModel] = useState(''),
    [phrase, setPhrase] = useState(''),
    [data, setData] = useState<any>(),
    [selected, setSelected] = useState<string>(),
    [candidate, setCandidate] = useState(''),
    [unchecked, setUnchecked] = useState<string[]>([]),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const owned = new AbortController();
    (async () => {
      try {
        const [r, i] = await Promise.all([
          api('/ai/catalog/runtime', 'GET', undefined, {}, owned.signal),
          api('/integrations', 'GET', undefined, {}, owned.signal),
        ]);
        if (owned.signal.aborted) return;
        setRuntime(r);
        setModel((m) => m || r.models?.[0]?.name || '');
        const list = (i.channels ?? []).filter((c: any) => providers.includes(c.provider));
        setChannels(list);
        setIntegration((v) => v || list[0]?.id || '');
      } catch (e: any) {
        if (!owned.signal.aborted) setError(e.message);
      }
    })();
    return () => owned.abort();
  }, []);
  const reader = useRef<ReturnType<typeof createCatalogJobReader<any>> | undefined>(undefined);
  useEffect(() => {
    if (!integration) return;
    const owned = createCatalogJobReader<any>({
      read: (signal) => api('/products/' + product.id + '/ai/matches?integration_id=' + integration, 'GET', undefined, {}, signal),
      accept: (r) => {
        setData(r);
        setSelected((s) => (s && r.data.some((m: any) => m.id === s) ? s : r.data[0]?.id));
      },
      error: (e: any) => setError(e.message),
      queued: pending,
    });
    reader.current = owned;
    void owned.refresh();
    return () => {
      owned.dispose();
      if (reader.current === owned) reader.current = undefined;
    };
  }, [product.id, integration]);
  const match = data?.data.find((m: any) => m.id === selected);
  const proposal = match?.proposal;
  useEffect(() => {
    setCandidate(proposal?.candidate?.id ?? '');
    setUnchecked([]);
    setConsent(false);
  }, [match?.id, match?.state]);
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
  if (data && !data.available) return null;
  const readOnly = Boolean(runtime?.read_only);
  const chosen = match?.snapshot?.candidates?.find((c: any) => c.id === candidate);
  const sameCategory = Boolean(chosen && proposal && chosen.category_id === proposal.category_id);
  const reviewable = match?.state === 'ready' && !readOnly;
  return (
    <section className="catalog-ai-match catalog-section">
      <header className="panel-heading">
        <div>
          <h3>Dopasowanie kategorii i parametrów</h3>
          <p>Lokalny model wybiera spośród kategorii odczytanych z kanału · propozycja do przeglądu</p>
        </div>
      </header>
      <p>
        AI korzysta z nazwy, opisu, kategorii i parametrów produktu. Kandydatów i słowniki parametrów odczytuje serwer z
        kanału; model nie tworzy własnych identyfikatorów. Zatwierdzenie zapisuje dopasowanie dla formularza oferty,
        nie wystawia oferty.
      </p>
      {runtime?.notice && <p className="notice">{runtime.notice}</p>}
      {error && (
        <p role="alert" className="error-inline">
          {error}
        </p>
      )}
      {runtime && !channels.length && <p className="muted">Brak integracji Allegro z odczytem kategorii.</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          action(async () => {
            const r = await api('/products/' + product.id + '/ai/matches', 'POST', {
              version: product.version,
              client_key: crypto.randomUUID(),
              model,
              integration_id: integration,
              ...(phrase.trim() ? { phrase: phrase.trim() } : {}),
            });
            setSelected(r.id);
          });
        }}
      >
        <div className="catalog-ai-fields">
          <label>
            Integracja
            <select aria-label="Integracja dopasowania" value={integration} onChange={(e) => setIntegration(e.target.value)}>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model lokalny
            <select aria-label="Model dopasowania AI" value={model} onChange={(e) => setModel(e.target.value)}>
              {!model && <option value="">Brak modelu</option>}
              {runtime?.models?.map((m: any) => (
                <option key={m.digest} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fraza katalogu (opcjonalnie)
            <input
              aria-label="Fraza katalogu"
              value={phrase}
              maxLength={200}
              placeholder="Domyślnie EAN albo nazwa produktu"
              onChange={(e) => setPhrase(e.target.value)}
            />
          </label>
        </div>
        <button className="button" disabled={busy || !runtime?.generation_allowed || !model || !integration}>
          Zaproponuj kategorię i parametry
        </button>
      </form>
      {data?.accepted && (
        <div className="catalog-ai-match-accepted">
          <strong>Zatwierdzone dopasowanie</strong>
          <p>
            Kategoria {data.accepted.accepted.category_id} · produkt katalogu {data.accepted.accepted.catalog_product_id} ·
            parametry: {data.accepted.accepted.parameters.length}
          </p>
        </div>
      )}
      {match && (
        <div className="catalog-ai-review">
          <strong>
            {states[match.state] ?? match.state} · {match.model} · fraza „{match.phrase}”
            {match.simulated ? ' · przykład lokalny' : ''}
          </strong>
          {match.error && (
            <p role="alert" className="error-inline">
              {match.error}
            </p>
          )}
          {proposal && (
            <>
              {proposal.reason && <p>{proposal.reason}</p>}
              <fieldset>
                <legend>Kandydaci z kanału</legend>
                {match.snapshot.candidates.map((c: any) => (
                  <label key={c.id} className="checkbox-row">
                    <input
                      type="radio"
                      name={'match-candidate-' + match.id}
                      aria-label={'Kandydat ' + c.name}
                      checked={candidate === c.id}
                      disabled={!reviewable || busy}
                      onChange={() => {
                        setCandidate(c.id);
                        setConsent(false);
                      }}
                    />
                    {c.name} · kategoria {c.category_id}
                    {proposal.candidate?.id === c.id ? ' (wybór AI)' : ''}
                  </label>
                ))}
              </fieldset>
              {proposal.parameters.length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th>Parametr</th>
                      <th>Obecnie w produkcie</th>
                      <th>Propozycja</th>
                      <th>Akceptuj</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposal.parameters.map((p: any) => (
                      <tr key={p.id}>
                        <td>{p.name}</td>
                        <td>{p.current ?? '—'}</td>
                        <td>{p.display}</td>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={'Akceptuj ' + p.name}
                            checked={sameCategory && !unchecked.includes(p.id)}
                            disabled={!reviewable || busy || !sameCategory}
                            onChange={(e) => {
                              setConsent(false);
                              setUnchecked((u) => (e.target.checked ? u.filter((x) => x !== p.id) : [...u, p.id]));
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {!sameCategory && chosen && proposal.parameters.length > 0 && (
                <p className="muted">Parametry zaproponowano dla innej kategorii; uzupełnisz je w formularzu oferty.</p>
              )}
              {proposal.rejected.length > 0 && (
                <details open>
                  <summary>Odrzucone wpisy modelu ({proposal.rejected.length})</summary>
                  <ul>
                    {proposal.rejected.map((r: any, i: number) => (
                      <li key={i}>
                        {r.name ?? r.id}: {r.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {proposal.missing_required.length > 0 && (
                <p className="notice">
                  Wymagane parametry bez propozycji: {proposal.missing_required.map((m: any) => m.name).join(', ')}
                </p>
              )}
              {reviewable && (
                <>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      aria-label="Zgoda na dopasowanie"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    Sprawdziłem kategorię i zaznaczone parametry; zatwierdzam dopasowanie
                  </label>
                  <button
                    className="button primary"
                    disabled={busy || !consent || !chosen || product.version !== match.source_version}
                    onClick={() =>
                      action(async () => {
                        await api('/ai/catalog/matches/' + match.id + '/accept', 'POST', {
                          approve: true,
                          version: match.source_version,
                          candidate_id: chosen.id,
                          category_id: chosen.category_id,
                          parameters: sameCategory
                            ? proposal.parameters.map((p: any) => p.id).filter((id: string) => !unchecked.includes(id))
                            : [],
                        });
                        saved();
                      })
                    }
                  >
                    Zatwierdź dopasowanie
                  </button>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => action(() => api('/ai/catalog/matches/' + match.id + '/reject', 'POST', {}))}
                  >
                    Odrzuć
                  </button>
                  {product.version !== match.source_version && (
                    <p role="alert">Produkt zmieniono; utwórz nową propozycję.</p>
                  )}
                </>
              )}
            </>
          )}
          {match.state === 'queued' && !readOnly && (
            <button
              className="button"
              disabled={busy}
              onClick={() => action(() => api('/ai/catalog/matches/' + match.id + '/cancel', 'POST', {}))}
            >
              Anuluj propozycję
            </button>
          )}
        </div>
      )}
      {data?.data.length > 0 && (
        <details className="catalog-ai-history">
          <summary>Historia dopasowań · ostatnie {data.history_limit ?? 30}</summary>
          {data.data.map((m: any) => (
            <div key={m.id}>
              <button type="button" className="text-button" onClick={() => setSelected(m.id)}>
                {states[m.state] ?? m.state} · {m.phrase} · {new Date(m.created_at).toLocaleString('pl-PL')}
              </button>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
