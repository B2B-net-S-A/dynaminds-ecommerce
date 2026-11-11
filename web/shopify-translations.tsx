import { useEffect, useRef, useState } from 'react';
import { api, date } from './api';
import type { ShopifyLocale } from '../server/shopify-translation-api';
const states: Record<string, string> = {
  preview: 'Podgląd',
  queued: 'W kolejce',
  done: 'Potwierdzono odczytem',
  failed: 'Błąd przed zapisem',
  conflict: 'Dane zmieniły się',
  uncertain: 'Wynik niepotwierdzony',
  cancelled: 'Anulowano',
  abandoned: 'Zakończono bez potwierdzenia',
};
const labels: Record<string, string> = { title: 'Nazwa produktu', body_html: 'Opis produktu' };
export function ShopifyTranslations({ product }: { product: any }) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<any>(),
    [mapping, setMapping] = useState(''),
    [localLocale, setLocalLocale] = useState(''),
    [target, setTarget] = useState(''),
    [locales, setLocales] = useState<ShopifyLocale[] | null>(null),
    [fields, setFields] = useState(['title', 'body_html']),
    [selected, setSelected] = useState(''),
    [plan, setPlan] = useState<any>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [scope, setScope] = useState(false),
    [external, setExternal] = useState(false),
    [replace, setReplace] = useState(false),
    [ack, setAck] = useState(false),
    [historyCursor, setHistoryCursor] = useState(''),
    [readCursor, setReadCursor] = useState('');
  const selectedId = useRef('');
  const reset = () => {
    setScope(false);
    setExternal(false);
    setReplace(false);
    setAck(false);
  };
  const clearPreview = () => {
    selectedId.current = '';
    setSelected('');
    setPlan(null);
    setReadCursor('');
    reset();
  };
  async function load() {
    const d = await api(
      `/products/${product.id}/shopify-translations${historyCursor ? '?cursor=' + encodeURIComponent(historyCursor) : ''}`,
    );
    setData(d);
    setMapping((v) => (d.mappings.some((m: any) => m.id === v) ? v : (d.mappings[0]?.id ?? '')));
    setLocalLocale((v) =>
      d.translations.some((t: any) => t.locale === v) ? v : (d.translations[0]?.locale ?? ''),
    );
  }
  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = async () => {
      try {
        const d = await api(
          `/products/${product.id}/shopify-translations${historyCursor ? '?cursor=' + encodeURIComponent(historyCursor) : ''}`,
        );
        if (!active) return;
        setData(d);
        setMapping((v) =>
          d.mappings.some((m: any) => m.id === v) ? v : (d.mappings[0]?.id ?? ''),
        );
        setLocalLocale((v) =>
          d.translations.some((t: any) => t.locale === v) ? v : (d.translations[0]?.locale ?? ''),
        );
        if (selected) {
          const p = await api(
            `/shopify-translation-plans/${selected}${readCursor ? '?cursor=' + encodeURIComponent(readCursor) : ''}`,
          );
          if (active && selectedId.current === selected) setPlan(p);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open, product.id, historyCursor, selected, readCursor]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const selectedMapping = data?.mappings.find((m: any) => m.id === mapping),
    translation = data?.translations.find((t: any) => t.locale === localLocale),
    readOnly = Boolean(data?.read_only || plan?.read_only);
  return (
    <details
      className="catalog-section shopify-translations"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Publikacja tłumaczeń Shopify</summary>
      {error && (
        <p role="alert" className="error-block">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {open && !data && <p>Wczytywanie publikacji tłumaczeń…</p>}
      {open && data && !data.available && (
        <p>Ta kopia nie zawiera modułu publikacji tłumaczeń Shopify.</p>
      )}
      {open && data?.available && (
        <>
          <p>
            Wyślij zatwierdzoną wersję językową katalogu. Nazwa i opis dotyczą całego produktu
            Shopify, również jego pozostałych wariantów.
          </p>
          {readOnly && (
            <p className="notice">
              Podgląd kopii — historia jest dostępna; odczyt dostawcy i zapisy są wyłączone.
            </p>
          )}
          {!data.mappings.length && (
            <p>
              Najpierw powiąż produkt z wariantem Shopify w integracjach lub zaimportuj katalog
              sklepu.
            </p>
          )}
          {!data.translations.length && (
            <p>
              Najpierw sprawdź i zapisz wersję językową ręcznie w arkuszu albo zatwierdź tłumaczenie
              AI lub DeepL.
            </p>
          )}
          {!!data.mappings.length && !!data.translations.length && (
            <fieldset disabled={busy || readOnly}>
              <legend>Nowa publikacja</legend>
              <label>
                Powiązanie Shopify
                <select
                  aria-label="Powiązanie publikacji Shopify"
                  value={mapping}
                  onChange={(e) => {
                    setMapping(e.target.value);
                    setLocales(null);
                    setTarget('');
                    clearPreview();
                  }}
                >
                  {data.mappings.map((m: any) => (
                    <option key={m.id} value={m.id}>
                      {m.name} · {m.external_id}
                      {m.simulation ? ' · DEMO' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Lokalne tłumaczenie
                <select
                  aria-label="Lokalny język publikacji"
                  value={localLocale}
                  onChange={(e) => {
                    setLocalLocale(e.target.value);
                    clearPreview();
                  }}
                >
                  {data.translations.map((t: any) => (
                    <option key={t.locale} value={t.locale}>
                      {t.locale} · wersja {t.version} ·{' '}
                      {t.manual_receipt_id
                        ? 'Ręcznie'
                        : t.ai_draft_id
                          ? 'AI'
                          : t.deepl_draft_id
                            ? 'DeepL'
                            : 'Nieznane źródło'}
                    </option>
                  ))}
                </select>
              </label>
              {translation && (
                <p>
                  {translation.name} · lokalny kod {translation.locale}. Wybierz dokładny język
                  sklepu; kody regionalne nie są automatycznie mapowane.
                </p>
              )}
              <button
                className="button"
                disabled={!selectedMapping}
                onClick={() =>
                  act(async () => {
                    const r = await api(
                      `/integrations/${selectedMapping.channel_id}/shopify-locales`,
                    );
                    setLocales(r.locales);
                    setTarget('');
                    clearPreview();
                    setMessage(
                      r.source === 'local_simulation'
                        ? 'Odczytano języki lokalnego przykładu.'
                        : 'Odczytano języki Shopify.',
                    );
                  })
                }
              >
                Odczytaj języki publikacji
              </button>
              {locales && (
                <label>
                  Docelowy język sklepu
                  <select
                    aria-label="Docelowy język Shopify"
                    value={target}
                    onChange={(e) => {
                      setTarget(e.target.value);
                      clearPreview();
                    }}
                  >
                    <option value="">Wybierz język</option>
                    {locales.map((l) => (
                      <option key={l.locale} value={l.locale} disabled={l.primary || !l.published}>
                        {l.name} · {l.locale}
                        {l.primary ? ' · podstawowy' : !l.published ? ' · nieopublikowany' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div>
                {Object.entries(labels).map(([key, label]) => (
                  <label key={key} className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={fields.includes(key)}
                      onChange={(e) => {
                        setFields((v) =>
                          e.target.checked ? [...v, key] : v.filter((k) => k !== key),
                        );
                        clearPreview();
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <button
                className="button primary"
                disabled={!target || !mapping || !translation || !fields.length}
                onClick={() =>
                  act(async () => {
                    const p = await api(
                      `/products/${product.id}/shopify-translations/preview`,
                      'POST',
                      {
                        client_key: crypto.randomUUID(),
                        listing_id: mapping,
                        version: data.product_version ?? product.version,
                        local_locale: localLocale,
                        translation_version: translation.version,
                        target_locale: target,
                        fields,
                      },
                    );
                    selectedId.current = p.id;
                    setSelected(p.id);
                    setPlan(p);
                    setReadCursor('');
                    reset();
                    setMessage('Przygotowano podgląd. Nie wykonano zapisu Shopify.');
                  })
                }
              >
                Przygotuj podgląd publikacji
              </button>
            </fieldset>
          )}
          <h4>Historia publikacji</h4>
          {!data.data.length && <p>Brak publikacji tego produktu.</p>}
          <div className="translation-history">
            {data.data.map((p: any) => (
              <button
                key={p.id}
                className="button"
                disabled={busy}
                onClick={() => {
                  selectedId.current = p.id;
                  setPlan(null);
                  setSelected(p.id);
                  setReadCursor('');
                  reset();
                }}
              >
                {date(p.created_at)} · {p.local_locale} → {p.target_locale} · {states[p.state]}
              </button>
            ))}
          </div>
          <div className="inline-actions">
            {historyCursor && (
              <button className="button" disabled={busy} onClick={() => setHistoryCursor('')}>
                Najnowsze publikacje
              </button>
            )}
            {data.meta.cursor && (
              <button
                className="button"
                disabled={busy}
                onClick={() => setHistoryCursor(data.meta.cursor)}
              >
                Starsze publikacje
              </button>
            )}
          </div>
          {plan && (
            <section className="translation-plan" aria-label="Podgląd publikacji tłumaczenia">
              <h4>
                {plan.target_locale} · {states[plan.state]}
                {plan.remote_snapshot.simulation ? ' · DEMO lokalne' : ''}
              </h4>
              <p>
                {plan.store_url} · {plan.remote_product_id} · wariant {plan.remote_variant_id}
              </p>
              <p>
                Lokalna wersja produktu {plan.local_snapshot.product_version}; tłumaczenie{' '}
                {plan.local_locale}, wersja {plan.local_snapshot.translation.version}. Podgląd ważny
                do {date(plan.expires_at)}.
              </p>
              {plan.remote_snapshot.simulation && (
                <p className="notice">
                  Publikacja zostanie wykonana wyłącznie w lokalnym przykładzie. Nie zapisuje treści
                  w Shopify.
                </p>
              )}
              {plan.error && (
                <p className="error-block" role="alert">
                  {plan.error}
                </p>
              )}
              {plan.spec.translations.map((f: any) => {
                const original = plan.remote_snapshot.source.find((s: any) => s.key === f.key),
                  current = plan.remote_snapshot.translations.find(
                    (t: any) => t.key === f.key && t.market === null,
                  );
                return (
                  <div key={f.key} className="translation-field">
                    <h5>{labels[f.key]}</h5>
                    <p>Źródło w Shopify · {original?.locale}</p>
                    <pre>{original?.value ?? 'Brak treści'}</pre>
                    <p>
                      Obecne tłumaczenie ogólne · {plan.target_locale}
                      {current?.outdated ? ' · nieaktualne' : ''}
                    </p>
                    <pre>{current?.value ?? 'Brak tłumaczenia'}</pre>
                    <p>Treść do publikacji</p>
                    <pre>{f.value || '(pusta treść)'}</pre>
                  </div>
                );
              })}
              {plan.remote_snapshot.translations.some((t: any) => t.market !== null) && (
                <details>
                  <summary>Tłumaczenia przypisane do rynków</summary>
                  <p>
                    Publikacja treści ogólnej zachowa te wersje. W tych rynkach może być widoczna
                    inna treść.
                  </p>
                  {plan.remote_snapshot.translations
                    .filter((t: any) => t.market !== null)
                    .map((t: any) => (
                      <pre key={t.market.id + t.key}>
                        {t.market.id} · {labels[t.key]} · {t.value}
                      </pre>
                    ))}
                </details>
              )}
              {plan.state === 'preview' && (
                <fieldset disabled={busy || readOnly}>
                  <legend>Zgoda na publikację tego podglądu</legend>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={scope}
                      onChange={(e) => setScope(e.target.checked)}
                    />
                    Zatwierdzam treść dla całego produktu Shopify, także innych wariantów
                  </label>
                  {plan.needs_replace && (
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={replace}
                        onChange={(e) => setReplace(e.target.checked)}
                      />
                      Zatwierdzam zastąpienie istniejącego tłumaczenia ogólnego
                    </label>
                  )}
                  {!plan.remote_snapshot.simulation && (
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={external}
                        onChange={(e) => setExternal(e.target.checked)}
                      />
                      Zatwierdzam zapis w zewnętrznym sklepie Shopify
                    </label>
                  )}
                  <button
                    className="button primary"
                    disabled={
                      !scope ||
                      (plan.needs_replace && !replace) ||
                      (!plan.remote_snapshot.simulation && !external)
                    }
                    onClick={() =>
                      act(async () => {
                        await api(`/shopify-translation-plans/${plan.id}/queue`, 'POST', {
                          confirm_product_scope: scope,
                          replace_existing: replace,
                          external_authorized: external,
                        });
                        setPlan(await api(`/shopify-translation-plans/${plan.id}`));
                        reset();
                        setMessage(
                          'Publikacja w kolejce. Ukończenie wymaga potwierdzenia odczytem.',
                        );
                      })
                    }
                  >
                    {plan.remote_snapshot.simulation
                      ? 'Zleć publikację DEMO'
                      : 'Zleć publikację Shopify'}
                  </button>
                </fieldset>
              )}
              {['preview', 'queued'].includes(plan.state) && plan.phase === 'fresh' && (
                <button
                  className="button"
                  disabled={busy || readOnly}
                  onClick={() =>
                    act(async () => {
                      await api(`/shopify-translation-plans/${plan.id}/cancel`, 'POST', {});
                      setPlan(await api(`/shopify-translation-plans/${plan.id}`));
                      reset();
                      setMessage('Anulowano przed próbą zapisu.');
                    })
                  }
                >
                  Anuluj publikację przed zapisem
                </button>
              )}
              {plan.state === 'uncertain' && (
                <fieldset disabled={busy || readOnly}>
                  <legend>Wynik wymaga odczytu</legend>
                  <p>
                    Nie zostanie wykonana kolejna próba zapisu. Sprawdź rzeczywiste wartości u
                    dostawcy.
                  </p>
                  <button
                    className="button"
                    onClick={() =>
                      act(async () => {
                        await api(`/shopify-translation-plans/${plan.id}/reconcile`, 'POST', {});
                        setPlan(await api(`/shopify-translation-plans/${plan.id}`));
                        setMessage('Odczytano wynik bez ponawiania zapisu.');
                      })
                    }
                  >
                    Odczytaj wynik bez ponowienia
                  </button>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    Zatwierdzam zakończenie bez potwierdzenia wszystkich pól. Zapis mógł być
                    częściowy lub nadal kończyć się u dostawcy.
                  </label>
                  <button
                    className="button"
                    disabled={!ack}
                    onClick={() =>
                      act(async () => {
                        await api(`/shopify-translation-plans/${plan.id}/acknowledge`, 'POST', {
                          acknowledge_unconfirmed: true,
                        });
                        setPlan(await api(`/shopify-translation-plans/${plan.id}`));
                        setAck(false);
                        setMessage(
                          'Zakończono po nowym odczycie. Nowy zapis wymaga nowego podglądu i zgody.',
                        );
                      })
                    }
                  >
                    Zakończ bez ponowienia zapisu
                  </button>
                </fieldset>
              )}
              {plan.result.fields && (
                <div>
                  <h5>Ostatni wynik odczytu</h5>
                  {plan.result.fields.map((f: any) => (
                    <p key={f.key}>
                      {labels[f.key]} · {f.confirmed ? 'Potwierdzono' : 'Nie potwierdzono'}
                      {f.outdated ? ' · nieaktualne źródło' : ''}
                    </p>
                  ))}
                </div>
              )}
              {!!plan.observations?.length && (
                <details>
                  <summary>Historia odczytów · ostatnie {plan.observations.length}</summary>
                  {plan.observations.map((o: any) => (
                    <div key={o.id}>
                      {o.data.resource_present === false && (
                        <p>
                          Brak zasobu produktu w tym odczycie Shopify. Zapis nie jest potwierdzony.
                        </p>
                      )}
                      {!o.data.locales.some(
                        (l: ShopifyLocale) => l.locale === plan.target_locale,
                      ) && <p>Docelowy język nie jest już włączony w sklepie.</p>}
                      <p>
                        {date(o.created_at)} ·{' '}
                        {o.source === 'local_simulation' ? 'DEMO lokalne' : 'API Shopify'}
                      </p>
                      {o.data.fields.map((f: any) => (
                        <pre key={f.key}>
                          {labels[f.key]} · {f.confirmed ? 'Potwierdzono' : 'Nie potwierdzono'}
                          {'\n'}
                          {f.observed ?? '(brak wartości)'}
                        </pre>
                      ))}
                    </div>
                  ))}
                  {readCursor && (
                    <button className="button" onClick={() => setReadCursor('')}>
                      Najnowsze odczyty
                    </button>
                  )}
                  {plan.meta?.cursor && (
                    <button className="button" onClick={() => setReadCursor(plan.meta.cursor)}>
                      Starsze odczyty
                    </button>
                  )}
                </details>
              )}
            </section>
          )}
        </>
      )}
    </details>
  );
}
