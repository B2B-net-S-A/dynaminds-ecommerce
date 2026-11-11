import { useEffect, useState } from 'react';
import { api } from './api';
const labels: Record<string, string> = {
  prepared: 'Podgląd',
  queued: 'W kolejce',
  finished: 'Przetworzono',
  expired: 'Wygasła',
  cancelled: 'Anulowano',
  ready: 'Do przeglądu',
  applied: 'Zapisano',
  failed: 'Błąd',
  uncertain: 'Niepewny wynik',
  conflict: 'Konflikt danych',
};
const date = (s: string) => new Date(s).toLocaleString('pl-PL');
type Text = { name: string; description: string };
export function DeepLBatches({
  selection,
  saved,
}: {
  selection: { id: string; version: number; sku: string }[];
  saved: (id: string) => void;
}) {
  const [history, setHistory] = useState<any>(),
    [metadata, setMetadata] = useState<any>(),
    [channel, setChannel] = useState(''),
    [source, setSource] = useState('pl'),
    [targets, setTargets] = useState<string[]>([]),
    [style, setStyle] = useState('default'),
    [detail, setDetail] = useState<any>(),
    [batchId, setBatchId] = useState(''),
    [page, setPage] = useState(1),
    [consent, setConsent] = useState(false),
    [edits, setEdits] = useState<Record<string, Text>>({}),
    [approvals, setApprovals] = useState<Record<string, boolean>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const readOnly = Boolean(history?.read_only || detail?.read_only);
  async function loadHistory(after?: string) {
    const r = await api('/deepl/batches' + (after ? '?after=' + after : ''));
    setHistory((old: any) => (after ? { ...r, data: [...old.data, ...r.data] } : r));
    setChannel((old) => old || r.channels[0]?.id || '');
  }
  useEffect(() => {
    let active = true;
    api('/deepl/batches')
      .then((r) => {
        if (active) {
          setHistory(r);
          setChannel(r.channels[0]?.id || '');
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setMetadata(undefined);
    setTargets([]);
    setStyle('default');
    if (channel && !readOnly)
      api('/integrations/' + channel + '/deepl')
        .then((r) => {
          if (active) {
            setMetadata(r);
            setSource((v) =>
              r.languages.some((l: any) => l.lang === v && l.usable_as_source)
                ? v
                : (r.languages.find((l: any) => l.usable_as_source)?.lang ?? ''),
            );
          }
        })
        .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [channel, readOnly]);
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    async function load() {
      if (!batchId) return;
      try {
        const r = await api('/deepl/batches/' + batchId + '?page=' + page);
        if (!active) return;
        setDetail(r);
        setEdits((old) => {
          const next = { ...old };
          for (const p of r.products)
            for (const d of p.drafts)
              if (!next[d.id] && (d.reviewed_text || d.output))
                next[d.id] = d.reviewed_text || d.output;
          return next;
        });
      } catch (e: any) {
        if (active) setError(e.message);
      } finally {
        if (active) timer = setTimeout(load, 2000);
      }
    }
    setDetail(undefined);
    setConsent(false);
    setApprovals({});
    load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [batchId, page]);
  async function refreshDetail() {
    if (batchId) setDetail(await api('/deepl/batches/' + batchId + '?page=' + page));
  }
  async function action(fn: () => Promise<void>, refreshHistory = true) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      await refreshDetail();
      if (refreshHistory) await loadHistory();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function choose(id: string) {
    setBatchId(id);
    setPage(1);
    setApprovals({});
    setConsent(false);
    setError('');
  }
  function edit(id: string, pid: string, field: keyof Text, value: string) {
    setEdits((old) => ({ ...old, [id]: { ...old[id], [field]: value } }));
    setApprovals((old) => ({ ...old, [pid]: false }));
  }
  const languages = metadata?.languages ?? [],
    b = detail?.batch;
  if (history && !history.available)
    return <p className="info-body">Kopia nie zawiera modułu tłumaczeń masowych.</p>;
  return (
    <div className="deepl-batch-panel">
      <p>
        Wybierz do 500 produktów w katalogu i maksymalnie 6 języków. Każdy produkt zapiszesz po
        przeglądzie jego gotowych tłumaczeń.
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="info-body">
          {notice}
        </p>
      )}
      {readOnly && (
        <p className="info-body">Podgląd kopii: tylko odczyt, połączenia z dostawcą wyłączone.</p>
      )}
      {!readOnly && (
        <section className="catalog-section">
          <h3>Nowa partia · {selection.length} wybranych produktów</h3>
          {!history?.channels.length && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  const r = await api('/integrations/deepl-example', 'POST', {});
                  setChannel(r.channel_id);
                })
              }
            >
              Dodaj lokalny przykład DeepL
            </button>
          )}
          {!!history?.channels.length && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action(async () => {
                  const r = await api('/deepl/batches/preview', 'POST', {
                    client_key: crypto.randomUUID(),
                    channel_id: channel,
                    source_lang: source,
                    target_langs: targets,
                    formality: style,
                    products: selection.map((p) => ({ id: p.id, version: p.version })),
                  });
                  choose(r.id);
                  setNotice('Podgląd utworzony. Nazwy i opisy nie zostały wysłane do dostawcy.');
                });
              }}
            >
              <div className="form-grid">
                <label>
                  Połączenie
                  <select
                    aria-label="Połączenie masowych tłumaczeń"
                    value={channel}
                    onChange={(e) => setChannel(e.target.value)}
                  >
                    {history.channels.map((ch: any) => (
                      <option key={ch.id} value={ch.id}>
                        {ch.name}
                        {ch.simulation ? ' · DEMO lokalne' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Język źródłowy
                  <select
                    aria-label="Źródło masowych tłumaczeń"
                    value={source}
                    onChange={(e) => {
                      setSource(e.target.value);
                      setTargets([]);
                    }}
                  >
                    {languages
                      .filter((l: any) => l.usable_as_source)
                      .map((l: any) => (
                        <option key={l.lang} value={l.lang}>
                          {l.name} · {l.lang}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Styl
                  <select
                    aria-label="Styl masowych tłumaczeń"
                    value={style}
                    onChange={(e) => setStyle(e.target.value)}
                  >
                    <option value="default">Domyślny</option>
                    <option value="prefer_more">Formalny, jeśli dostępny</option>
                    <option value="prefer_less">Nieformalny, jeśli dostępny</option>
                  </select>
                </label>
              </div>
              <fieldset className="batch-targets">
                <legend>Języki docelowe · {targets.length}/6</legend>
                {languages
                  .filter(
                    (l: any) => l.usable_as_target && l.lang.toLowerCase() !== source.toLowerCase(),
                  )
                  .map((l: any) => (
                    <label key={l.lang}>
                      <input
                        type="checkbox"
                        checked={targets.includes(l.lang)}
                        disabled={busy || (!targets.includes(l.lang) && targets.length >= 6)}
                        onChange={(e) =>
                          setTargets((old) =>
                            e.target.checked ? [...old, l.lang] : old.filter((v) => v !== l.lang),
                          )
                        }
                      />
                      {l.name} · {l.lang}
                    </label>
                  ))}
              </fieldset>
              <p className="info-body">
                Podgląd sprawdza języki i limit konta. Wysyłanie treści wymaga osobnego
                zatwierdzenia całego budżetu znaków.
              </p>
              <button
                className="button primary"
                disabled={busy || !metadata || !selection.length || !targets.length}
              >
                Przygotuj podgląd partii
              </button>
            </form>
          )}
        </section>
      )}
      <section className="catalog-section">
        <h3>Historia partii</h3>
        <div className="batch-history">
          {history?.data.map((h: any) => (
            <button
              type="button"
              className={'button ' + (h.id === batchId ? 'active' : '')}
              key={h.id}
              onClick={() => choose(h.id)}
            >
              {date(h.created_at)} · {h.product_count} produktów × {h.target_langs.length} języków ·{' '}
              {labels[h.state]}
              {h.simulation ? ' · DEMO' : ''}
            </button>
          ))}
        </div>
        {history?.data.length === 0 && <p>Brak partii.</p>}
        {history?.cursor && (
          <button
            className="button"
            disabled={busy}
            onClick={() => action(() => loadHistory(history.cursor), false)}
          >
            Wczytaj starsze partie
          </button>
        )}
      </section>
      {batchId && !detail && <p>Wczytywanie partii…</p>}
      {b && (
        <section className="catalog-section">
          <h3>
            {b.simulation ? 'DEMO lokalne' : 'DeepL API'} · {labels[b.state]}
          </h3>
          <p>
            {b.product_count} produktów × {b.target_langs.length} języków ·{' '}
            {b.characters.toLocaleString('pl-PL')} znaków Unicode · {b.source_lang} →{' '}
            {b.target_langs.join(', ')}
          </p>
          <p className="info-body">
            Zlecenie do {date(b.preview_until)}. Przetwarzanie i zapis po przeglądzie do{' '}
            {date(b.expires_at)}.
          </p>
          <div className="batch-counts">
            {Object.entries(detail.counts).map(([state, n]) => (
              <span key={state}>
                {labels[state]}: {String(n)}
              </span>
            ))}
          </div>
          {b.error && <p role="alert">{b.error}</p>}
          {b.state === 'prepared' && !readOnly && (
            <div className="batch-consent">
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={busy}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                {b.simulation
                  ? 'Zatwierdzam lokalną symulację całej partii; bez naliczania u dostawcy.'
                  : `Zgadzam się na przekazanie treści produktów do DeepL oraz użycie ${b.characters} znaków w ramach mojego planu API.`}
              </label>
              <button
                className="button primary"
                disabled={busy || !consent || Date.parse(b.preview_until) <= Date.now()}
                onClick={() =>
                  action(async () => {
                    await api('/deepl/batches/' + b.id + '/queue', 'POST', {
                      confirm_external: true,
                      max_characters: b.characters,
                    });
                    setConsent(false);
                  })
                }
              >
                Zleć tłumaczenie całej partii
              </button>
            </div>
          )}
          {!['cancelled', 'expired'].includes(b.state) && !readOnly && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  const r = await api('/deepl/batches/' + b.id + '/cancel', 'POST', {});
                  setNotice(
                    `Anulowano ${r.cancelled} szkiców. Rozpoczęte: ${r.already_started}; ich naliczenia nie można cofnąć. Zapisane tłumaczenia pozostają.`,
                  );
                })
              }
            >
              Anuluj pozostałą partię
            </button>
          )}
          {detail.products.map((p: any) => {
            const ready = p.drafts.filter((d: any) => d.state === 'ready'),
              waiting = p.drafts.some((d: any) => ['prepared', 'queued'].includes(d.state)),
              stale = p.drafts[0]?.current_version !== p.source_version;
            const applicable =
              !readOnly &&
              !['cancelled', 'expired'].includes(b.state) &&
              Date.parse(b.expires_at) > Date.now() &&
              !waiting &&
              !stale &&
              ready.length > 0;
            return (
              <article className="batch-product" key={p.product_id}>
                <h4>
                  {p.sku} · wersja źródła {p.source_version}
                </h4>
                <details>
                  <summary>Zamrożony tekst źródłowy · {p.sku}</summary>
                  <p>{p.drafts[0]?.source.name}</p>
                  <p className="plain-text">{p.drafts[0]?.source.description}</p>
                </details>
                {stale && !p.drafts.some((d: any) => d.state === 'applied') && (
                  <p role="status">
                    Produkt zmienił się. Przygotuj nową partię dla aktualnej wersji.
                  </p>
                )}
                {p.drafts.map((d: any) => (
                  <section className="batch-locale" key={d.id}>
                    <h5>
                      {d.target_lang} · {labels[d.state]}
                    </h5>
                    {d.error && <p role="status">{d.error}</p>}
                    {d.usage && (
                      <p className="info-body">
                        {b.simulation ? 'Symulowane' : 'Zwrócone przez dostawcę'} naliczenie:{' '}
                        {d.usage.billed_characters} znaków
                      </p>
                    )}
                    {(d.reviewed_text || d.output) && (
                      <>
                        <label>
                          Nazwa · {d.target_lang}
                          <input
                            aria-label={'Nazwa ' + p.sku + ' ' + d.target_lang}
                            maxLength={200}
                            value={edits[d.id]?.name ?? ''}
                            disabled={busy || !applicable || d.state !== 'ready'}
                            onChange={(e) => edit(d.id, p.product_id, 'name', e.target.value)}
                          />
                        </label>
                        <label>
                          Opis · {d.target_lang}
                          <textarea
                            aria-label={'Opis ' + p.sku + ' ' + d.target_lang}
                            maxLength={10000}
                            rows={3}
                            value={edits[d.id]?.description ?? ''}
                            disabled={busy || !applicable || d.state !== 'ready'}
                            onChange={(e) =>
                              edit(d.id, p.product_id, 'description', e.target.value)
                            }
                          />
                        </label>
                      </>
                    )}
                  </section>
                ))}
                {waiting && (
                  <p role="status">
                    Zapis będzie dostępny po zakończeniu wszystkich języków tego produktu.
                  </p>
                )}
                {!!ready.length && (
                  <div className="batch-consent">
                    {ready.length < p.drafts.length && (
                      <p>
                        Gotowych: {ready.length}/{p.drafts.length}. Zapis obejmie wyłącznie cały
                        zestaw gotowych języków; pozostałe zachowają swój wynik w historii.
                      </p>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        aria-label={'Zatwierdzam tłumaczenia ' + p.sku}
                        checked={!!approvals[p.product_id]}
                        disabled={busy || !applicable}
                        onChange={(e) =>
                          setApprovals((old) => ({ ...old, [p.product_id]: e.target.checked }))
                        }
                      />
                      Sprawdziłem wszystkie gotowe języki produktu {p.sku} i zatwierdzam ich treść.
                    </label>
                    <button
                      className="button primary"
                      disabled={busy || !applicable || !approvals[p.product_id]}
                      onClick={() =>
                        action(async () => {
                          await api(
                            '/deepl/batches/' + b.id + '/products/' + p.product_id + '/apply',
                            'POST',
                            {
                              approve: true,
                              version: p.source_version,
                              texts: ready.map((d: any) => ({ draft_id: d.id, ...edits[d.id] })),
                            },
                          );
                          setApprovals((old) => ({ ...old, [p.product_id]: false }));
                          saved(p.product_id);
                          setNotice('Zapisano gotowe języki produktu jedną transakcją.');
                        })
                      }
                    >
                      Zapisz wszystkie języki · {p.sku}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
          <div className="table-footer">
            <button
              className="button"
              disabled={page <= 1 || busy}
              onClick={() => setPage((p) => p - 1)}
            >
              Poprzednie produkty
            </button>
            <span>
              Strona {page}/{detail.pages} · 5 produktów na stronie
            </span>
            <button
              className="button"
              disabled={page >= detail.pages || busy}
              onClick={() => setPage((p) => p + 1)}
            >
              Następne produkty
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
