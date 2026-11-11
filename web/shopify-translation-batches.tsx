import { useEffect, useRef, useState } from 'react';
import { api, date } from './api';
import type { ShopifyLocale } from '../server/shopify-translation-api';

type Selection = { id: string; version: number; sku: string }[];
const states: Record<string, string> = {
  building: 'Przygotowywanie podglądów',
  preview: 'Podgląd',
  ready: 'Gotowe do zlecenia',
  pending: 'Oczekuje na podgląd',
  queued: 'W kolejce',
  running: 'Przetwarzanie',
  done: 'Potwierdzono odczytem',
  partial: 'Partia częściowo zakończona',
  uncertain: 'Wynik niepotwierdzony',
  failed: 'Błąd',
  conflict: 'Dane zmieniły się',
  cancelled: 'Anulowano',
  abandoned: 'Zakończono bez potwierdzenia',
};
const fieldNames: Record<string, string> = { title: 'Nazwa produktu', body_html: 'Opis produktu' };
const counts: Record<string, string> = {
  total: 'Wszystkie SKU',
  ready: 'Gotowe do zlecenia',
  pending: 'Oczekujące',
  queued: 'W kolejce',
  done: 'Potwierdzone odczytem',
  uncertain: 'Niepotwierdzone',
  failed: 'Błędy',
  conflict: 'Konflikty',
  cancelled: 'Anulowane',
  abandoned: 'Zakończone bez potwierdzenia',
  needs_replace: 'Zastąpienie istniejącej treści',
};

export function ShopifyTranslationBatches({ selection }: { selection: Selection }) {
  const [history, setHistory] = useState<any>(),
    [metadata, setMetadata] = useState<any>(),
    [channel, setChannel] = useState(''),
    [localLocale, setLocalLocale] = useState(''),
    [target, setTarget] = useState(''),
    [locales, setLocales] = useState<ShopifyLocale[] | null>(null),
    [fields, setFields] = useState(['title', 'body_html']),
    [mappings, setMappings] = useState<Record<string, string>>({}),
    [versions, setVersions] = useState<Record<string, number>>({}),
    [batchId, setBatchId] = useState(''),
    [pollEpoch, setPollEpoch] = useState(0),
    [detail, setDetail] = useState<any>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [scope, setScope] = useState(false),
    [replace, setReplace] = useState(false),
    [external, setExternal] = useState(false),
    [review, setReview] = useState(false),
    [acks, setAcks] = useState<Record<string, boolean>>({});
  const previewKey = useRef<{ body: string; key: string } | null>(null);
  const selectionKey = selection
    .map((p) => `${p.id}:${p.version}`)
    .sort()
    .join(',');
  const readOnly = Boolean(history?.read_only || metadata?.read_only || detail?.read_only);
  function resetConsent() {
    setScope(false);
    setReplace(false);
    setExternal(false);
    setReview(false);
    setAcks({});
  }
  function clearPreview() {
    setBatchId('');
    setDetail(undefined);
    resetConsent();
    previewKey.current = null;
  }
  function choose(id: string) {
    setBatchId(id);
    setPollEpoch((v) => v + 1);
    setDetail(undefined);
    resetConsent();
    setError('');
    setNotice('');
  }
  async function loadHistory(cursor?: string) {
    const r = await api(
      '/shopify-translation-batches' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    );
    setHistory((old: any) => (cursor ? { ...r, data: [...(old?.data ?? []), ...r.data] } : r));
  }
  useEffect(() => {
    let active = true;
    api('/shopify-translation-batches')
      .then((r) => active && setHistory(r))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setMetadata(undefined);
    setMappings({});
    setVersions({});
    if (selection.length > 0 && selection.length <= 100 && history?.available) {
      api(
        '/shopify-translation-batches/selection?product_ids=' +
          selection.map((p) => p.id).join(','),
      )
        .then((r) => {
          if (active) setMetadata(r);
        })
        .catch((e) => active && setError(e.message));
    }
    return () => {
      active = false;
    };
  }, [selectionKey, history?.available]);
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    async function read() {
      if (!batchId) return;
      try {
        const r = await api('/shopify-translation-batches/' + batchId);
        if (!active) return;
        setDetail(r);
        if (r.state === 'building' || r.summary?.pending || r.summary?.queued)
          timer = setTimeout(read, 3000);
      } catch (e: any) {
        if (active) setError(e.message);
      }
    }
    read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [batchId, pollEpoch]);
  async function action(fn: () => Promise<void>, refresh = true) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      if (refresh) await loadHistory();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function refreshDetail(id = batchId) {
    if (id) setDetail(await api('/shopify-translation-batches/' + id));
  }
  const products: any[] = metadata?.products ?? [],
    channels: any[] = history?.channels ?? [],
    localLanguages: string[] = [
      ...new Set<string>(products.flatMap((p) => p.translations.map((t: any) => t.locale))),
    ].sort();
  const rows = products.map((p) => {
    const options = p.mappings.filter((m: any) => m.channel_id === channel),
      mapping =
        options.find((m: any) => m.id === mappings[p.id]) ??
        (options.length === 1 ? options[0] : undefined),
      translation = p.translations.find((t: any) => t.locale === localLocale),
      selectedVersion = selection.find((s) => s.id === p.id)?.version,
      stale = p.version !== selectedVersion && versions[p.id] !== p.version;
    return { p, options, mapping, translation, stale };
  });
  const readySelection =
      selection.length > 0 &&
      selection.length <= 100 &&
      rows.length === selection.length &&
      rows.every((r) => r.mapping && r.translation && !r.stale),
    queueReady =
      detail?.state === 'preview' &&
      detail?.items?.length > 0 &&
      detail.items.every((i: any) => i.plan?.state === 'preview') &&
      !detail.summary?.pending &&
      !detail.summary?.failed &&
      !detail.summary?.conflict;
  if (history && !history.available)
    return <p className="info-body">Ta kopia nie zawiera masowej publikacji tłumaczeń Shopify.</p>;
  return (
    <div className="shopify-batch-panel">
      <p>
        Zaznacz do 100 produktów. Publikacja użyje zapisanych i sprawdzonych tłumaczeń AI lub DeepL.
        Nazwa i opis dotyczą całego produktu Shopify, także innych wariantów.
      </p>
      {error && (
        <p role="alert" className="error-block">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {readOnly && (
        <p className="notice">
          Podgląd kopii: historia jest dostępna; odczyty dostawcy i publikacja są wyłączone.
        </p>
      )}
      {!history && <p>Wczytywanie publikacji masowych…</p>}
      {history?.available && !readOnly && (
        <section className="catalog-section">
          <h3>Nowa partia · {selection.length} zaznaczonych SKU</h3>
          {!selection.length && <p>Zamknij panel i zaznacz produkty w katalogu.</p>}
          {selection.length > 100 && (
            <p role="alert">
              Wybrano {selection.length} produktów. Limit publikacji to 100; zmniejsz wybór w
              katalogu. Żaden produkt nie zostanie automatycznie pominięty.
            </p>
          )}
          {selection.length > 0 && selection.length <= 100 && !metadata && (
            <p>Wczytywanie lokalnych tłumaczeń i powiązań…</p>
          )}
          {metadata && (
            <fieldset disabled={busy}>
              <legend>Zakres nowej publikacji</legend>
              <button
                type="button"
                className="button"
                onClick={() =>
                  action(async () => {
                    const r = await api(
                      '/shopify-translation-batches/selection?product_ids=' +
                        selection.map((p) => p.id).join(','),
                    );
                    setMetadata(r);
                    setMappings({});
                    setVersions({});
                    clearPreview();
                    setNotice(
                      'Odświeżono lokalne tłumaczenia i powiązania. Sprawdź aktualne wersje produktów.',
                    );
                  }, false)
                }
              >
                Odśwież lokalne tłumaczenia i powiązania
              </button>
              <div className="form-grid">
                <label>
                  Sklep Shopify
                  <select
                    aria-label="Sklep masowej publikacji Shopify"
                    value={channel}
                    onChange={(e) => {
                      setChannel(e.target.value);
                      setMappings({});
                      setLocales(null);
                      setTarget('');
                      clearPreview();
                    }}
                  >
                    <option value="">Wybierz sklep</option>
                    {channels.map((ch: any) => (
                      <option key={ch.id} value={ch.id}>
                        {ch.name}
                        {ch.simulation ? ' · DEMO lokalne' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Lokalne tłumaczenie
                  <select
                    aria-label="Lokalny język masowej publikacji"
                    value={localLocale}
                    onChange={(e) => {
                      setLocalLocale(e.target.value);
                      clearPreview();
                    }}
                  >
                    <option value="">Wybierz język</option>
                    {localLanguages.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {!channels.length && (
                <p>
                  Najpierw skonfiguruj połączenie Shopify i powiąż produkty z wariantami sklepu.
                </p>
              )}
              {!localLanguages.length && (
                <p>Najpierw przygotuj, sprawdź i zapisz tłumaczenia produktów w AI lub DeepL.</p>
              )}
              <button
                type="button"
                className="button"
                disabled={!channel}
                onClick={() =>
                  action(async () => {
                    const r = await api(`/integrations/${channel}/shopify-locales`);
                    setLocales(r.locales);
                    setTarget('');
                    clearPreview();
                    setNotice(
                      r.source === 'local_simulation'
                        ? 'Odczytano języki lokalnego przykładu.'
                        : 'Odczytano języki sklepu Shopify.',
                    );
                  }, false)
                }
              >
                Odczytaj języki sklepu
              </button>
              {locales && (
                <label>
                  Docelowy język sklepu
                  <select
                    aria-label="Docelowy język masowej publikacji Shopify"
                    value={target}
                    onChange={(e) => {
                      setTarget(e.target.value);
                      clearPreview();
                    }}
                  >
                    <option value="">Wybierz dokładny język</option>
                    {locales.map((l) => (
                      <option key={l.locale} value={l.locale} disabled={l.primary || !l.published}>
                        {l.name} · {l.locale}
                        {l.primary ? ' · podstawowy' : !l.published ? ' · nieopublikowany' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="info-body">
                Kody regionalne nie są automatycznie mapowane. Wybierz dokładny język sklepu dla
                wskazanego lokalnego tłumaczenia.
              </p>
              <div className="shopify-batch-fields">
                {Object.entries(fieldNames).map(([key, label]) => (
                  <label className="checkbox-row" key={key}>
                    <input
                      type="checkbox"
                      checked={fields.includes(key)}
                      onChange={(e) => {
                        setFields((old) =>
                          e.target.checked ? [...old, key] : old.filter((v) => v !== key),
                        );
                        clearPreview();
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <details>
                <summary>Wybrane SKU i powiązania · {rows.length}</summary>
                {rows.map(({ p, options, mapping, translation, stale }) => (
                  <article className="shopify-batch-selection" key={p.id}>
                    <h4>
                      {p.sku} · {p.name}
                    </h4>
                    {channel && !options.length && (
                      <p role="status">Brak powiązania z wybranym sklepem.</p>
                    )}
                    {channel && options.length > 0 && (
                      <label>
                        Wariant Shopify
                        <select
                          aria-label={'Wariant Shopify dla ' + p.sku}
                          value={mapping?.id ?? ''}
                          onChange={(e) => {
                            setMappings((old) => ({ ...old, [p.id]: e.target.value }));
                            clearPreview();
                          }}
                        >
                          <option value="">Wybierz powiązanie</option>
                          {options.map((m: any) => (
                            <option key={m.id} value={m.id}>
                              {m.external_id}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {localLocale && !translation && (
                      <p role="status">Brak zapisanego tłumaczenia {localLocale}.</p>
                    )}
                    {translation && (
                      <p>
                        {translation.locale} · wersja tłumaczenia {translation.version} ·{' '}
                        {translation.name}
                      </p>
                    )}
                    <p>Lokalna wersja produktu: {p.version}.</p>
                    {stale && (
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={false}
                          onChange={() => {
                            setVersions((old) => ({ ...old, [p.id]: p.version }));
                            clearPreview();
                          }}
                        />
                        Produkt zmienił się od zaznaczenia. Sprawdziłem aktualną wersję {p.version}{' '}
                        i zatwierdzam ją do podglądu.
                      </label>
                    )}
                  </article>
                ))}
              </details>
              {channel && localLocale && !readySelection && (
                <p role="status">
                  Uzupełnij powiązania, tłumaczenia lub zatwierdzenie aktualnych wersji dla
                  wszystkich wybranych SKU.
                </p>
              )}
              <button
                type="button"
                className="button primary"
                disabled={!channel || !localLocale || !target || !fields.length || !readySelection}
                onClick={() =>
                  action(async () => {
                    const body = {
                      channel_id: channel,
                      local_locale: localLocale,
                      target_locale: target,
                      fields,
                      items: rows.map(({ p, mapping, translation }) => ({
                        product_id: p.id,
                        listing_id: mapping.id,
                        version: p.version,
                        translation_version: translation.version,
                      })),
                    };
                    const serial = JSON.stringify(body);
                    if (previewKey.current?.body !== serial)
                      previewKey.current = { body: serial, key: crypto.randomUUID() };
                    const r = await api('/shopify-translation-batches/preview', 'POST', {
                      ...body,
                      client_key: previewKey.current!.key,
                    });
                    setBatchId(r.id);
                    setDetail(r);
                    resetConsent();
                    setNotice(
                      'Przygotowano partię podglądów. Nie wykonano zapisu w Shopify. Sprawdź wynik każdego SKU.',
                    );
                  })
                }
              >
                Przygotuj podgląd publikacji partii
              </button>
            </fieldset>
          )}
        </section>
      )}
      <section className="catalog-section">
        <h3>Historia publikacji masowych</h3>
        <div className="translation-history">
          {history?.data?.map((h: any) => (
            <button
              type="button"
              disabled={busy}
              key={h.id}
              className={'button ' + (batchId === h.id ? 'active' : '')}
              onClick={() => choose(h.id)}
            >
              {date(h.created_at)} · {h.local_locale} → {h.target_locale} ·{' '}
              {states[h.state] ?? h.state}
              {h.simulation ? ' · DEMO' : ''}
            </button>
          ))}
        </div>
        {history?.data?.length === 0 && <p>Brak partii publikacji.</p>}
        {history?.meta?.cursor && (
          <button
            className="button"
            disabled={busy}
            onClick={() => action(() => loadHistory(history.meta.cursor), false)}
          >
            Wczytaj starsze partie
          </button>
        )}
      </section>
      {batchId && !detail && <p>Wczytywanie partii…</p>}
      {detail && (
        <section className="catalog-section" aria-label="Partia publikacji tłumaczeń Shopify">
          <h3>
            {detail.simulation ? 'DEMO lokalne' : 'Shopify API'} ·{' '}
            {states[detail.state] ?? detail.state}
          </h3>
          <p>
            {detail.local_locale} → {detail.target_locale} ·{' '}
            {detail.fields?.map((f: string) => fieldNames[f]).join(', ')} · podgląd ważny do{' '}
            {date(detail.expires_at)}
          </p>
          {detail.simulation && (
            <p className="notice">
              Cała partia używa lokalnego przykładu. Treści nie są zapisywane w zewnętrznym Shopify.
            </p>
          )}
          <div className="batch-counts" role="status">
            {Object.entries(detail.summary ?? {})
              .filter(([key]) => key in counts)
              .map(([key, value]) => (
                <span key={key}>
                  {counts[key]}: {String(value)}
                </span>
              ))}
          </div>
          {detail.error && (
            <p role="alert" className="error-block">
              {detail.error}
            </p>
          )}
          {detail.state === 'preview' && !queueReady && (
            <p role="status">
              Partia nie jest gotowa do zlecenia. Błąd lub konflikt dowolnego SKU blokuje publikację
              całej partii; popraw dane i przygotuj nowy podgląd.
            </p>
          )}
          {queueReady && (
            <fieldset disabled={busy || readOnly || Date.parse(detail.expires_at) <= Date.now()}>
              <legend>Zatwierdzenie całej zamrożonej partii</legend>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={review}
                  onChange={(e) => setReview(e.target.checked)}
                />
                Sprawdziłem podgląd każdego SKU w tej partii i zatwierdzam wszystkie wskazane
                treści.
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={scope}
                  onChange={(e) => setScope(e.target.checked)}
                />
                Zatwierdzam wskazane pola dla całych produktów Shopify, także ich innych wariantów.
              </label>
              {!!detail.summary?.needs_replace && (
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={replace}
                    onChange={(e) => setReplace(e.target.checked)}
                  />
                  Zatwierdzam zastąpienie istniejących tłumaczeń ogólnych we wszystkich wskazanych
                  podglądach.
                </label>
              )}
              {!detail.simulation && (
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={external}
                    onChange={(e) => setExternal(e.target.checked)}
                  />
                  Zatwierdzam zapis całej partii w zewnętrznym sklepie Shopify.
                </label>
              )}
              <button
                className="button primary"
                disabled={
                  !review ||
                  !scope ||
                  (!!detail.summary?.needs_replace && !replace) ||
                  (!detail.simulation && !external)
                }
                onClick={() =>
                  action(async () => {
                    await api(`/shopify-translation-batches/${detail.id}/queue`, 'POST', {
                      confirm_product_scope: scope,
                      replace_existing: replace,
                      external_authorized: external,
                    });
                    await refreshDetail();
                    resetConsent();
                    setNotice(
                      'Zlecono całą partię. Każdy SKU zostanie potwierdzony osobnym odczytem; niepotwierdzone zapisy nie będą automatycznie ponawiane.',
                    );
                    setPollEpoch((v) => v + 1);
                  })
                }
              >
                {detail.simulation
                  ? 'Zleć publikację partii DEMO'
                  : 'Zleć publikację partii Shopify'}
              </button>
            </fieldset>
          )}
          {detail.items?.some(
            (i: any) =>
              i.plan && ['preview', 'queued'].includes(i.plan.state) && i.plan.phase === 'fresh',
          ) && (
            <button
              className="button"
              disabled={busy || readOnly}
              onClick={() =>
                action(async () => {
                  await api(`/shopify-translation-batches/${detail.id}/cancel`, 'POST', {});
                  await refreshDetail();
                  resetConsent();
                  setNotice(
                    'Anulowano publikacje przed próbą zapisu. Rozpoczęte zapisy zachowują rzeczywisty wynik w historii.',
                  );
                })
              }
            >
              Anuluj pozostałe publikacje przed zapisem
            </button>
          )}
          {detail.state === 'building' && !readOnly && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await api(`/shopify-translation-batches/${detail.id}/resume`, 'POST', {});
                  await refreshDetail();
                  setPollEpoch((v) => v + 1);
                  setNotice(
                    'Wznowiono odczyty brakujących podglądów. Nie wykonano zapisu Shopify.',
                  );
                })
              }
            >
              Wznów odczyt podglądów
            </button>
          )}
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              action(async () => {
                await refreshDetail();
                setPollEpoch((v) => v + 1);
              }, false)
            }
          >
            Odśwież lokalny stan partii
          </button>
          {detail.items?.map((item: any) => {
            const plan = item.plan;
            return (
              <article className="shopify-batch-product" key={item.product_id}>
                <h4>
                  {item.sku} · {item.name} · {states[plan?.state ?? item.state] ?? item.state}
                </h4>
                {(item.error || plan?.error) && (
                  <p role="status" className="error-block">
                    {item.error || plan.error}
                  </p>
                )}
                {plan && (
                  <>
                    <FrozenShopifyPlan key={plan.id} id={plan.id} sku={item.sku} />
                    {plan.result?.fields && (
                      <div aria-label={'Wynik odczytu ' + item.sku}>
                        {plan.result.fields.map((f: any) => (
                          <p key={f.key}>
                            {fieldNames[f.key]} ·{' '}
                            {f.confirmed ? 'Potwierdzono odczytem' : 'Nie potwierdzono'}
                            {f.outdated ? ' · nieaktualne źródło' : ''}
                          </p>
                        ))}
                      </div>
                    )}
                    {plan.state === 'uncertain' && (
                      <fieldset disabled={busy || readOnly}>
                        <legend>Niepotwierdzony wynik · {item.sku}</legend>
                        <p>
                          Zapis nie będzie ponawiany. Odczyt sprawdzi rzeczywiste wartości tego
                          produktu.
                        </p>
                        <button
                          className="button"
                          onClick={() =>
                            action(async () => {
                              await api(
                                `/shopify-translation-plans/${plan.id}/reconcile`,
                                'POST',
                                {},
                              );
                              await refreshDetail();
                              setNotice('Odczytano wynik wskazanego SKU bez ponowienia zapisu.');
                            })
                          }
                        >
                          Odczytaj wynik bez ponowienia · {item.sku}
                        </button>
                        <label className="checkbox-row">
                          <input
                            type="checkbox"
                            checked={!!acks[plan.id]}
                            onChange={(e) =>
                              setAcks((old) => ({ ...old, [plan.id]: e.target.checked }))
                            }
                          />
                          Zatwierdzam zakończenie {item.sku} bez potwierdzenia wszystkich pól. Zapis
                          mógł być częściowy lub nadal kończyć się u dostawcy.
                        </label>
                        <button
                          className="button"
                          disabled={!acks[plan.id]}
                          onClick={() =>
                            action(async () => {
                              await api(
                                `/shopify-translation-plans/${plan.id}/acknowledge`,
                                'POST',
                                { acknowledge_unconfirmed: true },
                              );
                              await refreshDetail();
                              setAcks((old) => ({ ...old, [plan.id]: false }));
                              setNotice(
                                'Zakończono wskazany SKU po nowym odczycie, bez ponowienia zapisu. Nowa publikacja wymaga nowego podglądu i zgody.',
                              );
                            })
                          }
                        >
                          Zakończ bez ponowienia · {item.sku}
                        </button>
                      </fieldset>
                    )}
                  </>
                )}
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}

function FrozenShopifyPlan({ id, sku }: { id: string; sku: string }) {
  const [open, setOpen] = useState(false),
    [plan, setPlan] = useState<any>(),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open || plan) return;
    let active = true;
    setError('');
    api(`/shopify-translation-plans/${id}`)
      .then((r) => {
        if (active) setPlan(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id, open, retry, plan]);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Źródło, obecna treść i publikowana wersja · {sku}</summary>
      {error && (
        <>
          <p role="alert" className="error-block">
            {error}
          </p>
          <button className="button" onClick={() => setRetry((v) => v + 1)}>
            Ponów odczyt lokalnego podglądu · {sku}
          </button>
        </>
      )}
      {open && !plan && !error && <p>Wczytywanie zamrożonego podglądu z lokalnej historii…</p>}
      {plan && (
        <>
          <p>
            {plan.store_url} · {plan.remote_product_id} · wariant {plan.remote_variant_id}
          </p>
          <p>
            Lokalna wersja produktu {plan.local_snapshot.product_version}; tłumaczenie{' '}
            {plan.local_locale}, wersja {plan.local_snapshot.translation.version}.
          </p>
          {plan.spec.translations.map((f: any) => {
            const original = plan.remote_snapshot.source.find((s: any) => s.key === f.key),
              current = plan.remote_snapshot.translations.find(
                (t: any) => t.key === f.key && t.market === null,
              );
            return (
              <div className="translation-field" key={f.key}>
                <h5>{fieldNames[f.key]}</h5>
                <p>Źródło Shopify w chwili podglądu · {original?.locale}</p>
                <pre>{original?.value ?? 'Brak treści'}</pre>
                <p>
                  Tłumaczenie ogólne w chwili podglądu · {plan.target_locale}
                  {current?.outdated ? ' · nieaktualne' : ''}
                </p>
                <pre>{current?.value ?? 'Brak tłumaczenia'}</pre>
                <p>Treść do publikacji</p>
                <pre>{f.value || '(pusta treść)'}</pre>
              </div>
            );
          })}
          {plan.remote_snapshot.translations.some((t: any) => t.market !== null) && (
            <p className="notice">
              Produkt ma również tłumaczenia dla osobnych rynków. Publikacja ogólna je zachowa; na
              tych rynkach może być widoczna inna treść.
            </p>
          )}
        </>
      )}
    </details>
  );
}
