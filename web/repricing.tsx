import { useEffect, useState, type FormEvent } from 'react';
import { api, money } from './api';
import { ProductPicker } from './catalog';
import { RepricingSchedulePanel } from './repricing-schedules';
import { RepricingOverridesPanel } from './repricing-overrides';
import { channelText } from './repricing-channel';
import { CompetitorObservations, competitorObservationsLocked, type CompetitorObservationContext } from './competitor-observations';
const minor = (v: FormDataEntryValue | null) => {
  const value = String(v ?? '')
    .trim()
    .replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(value))
    throw Error('Kwota wymaga maksymalnie dwóch miejsc dziesiętnych');
  const [a, b = ''] = value.split('.');
  return Number(a) * 100 + Number(b.padEnd(2, '0'));
};
const defaults = {
  enabled: true,
  strategy: 'cost_margin',
  min_margin_bps: 1000,
  target_margin_bps: 2000,
  fee_bps: 0,
  fixed_net_cost: 0,
  min_price: 0,
  max_price: 100000000,
  undercut_amount: 1,
  observation_minutes: 60,
  direction: 'both',
  ending: null,
};
// Rounding presets: value "step:ending" in grosze; '99' keeps the original ,99 rule.
const ROUNDINGS: [string, string][] = [
  ['', 'Pełne grosze'],
  ['99', ',99 w granicach ceny'],
  ['100:90', ',90'],
  ['50:49', ',49 albo ,99'],
  ['100:0', 'Pełne złote (,00)'],
  ['1000:990', 'Końcówka 9,90 zł'],
  ['1000:999', 'Końcówka 9,99 zł'],
];
const CURRENCIES = ['PLN', 'EUR', 'USD', 'GBP', 'CZK'];
const STRATEGIES: Record<string, string> = {
  cost_margin: 'Docelowa marża',
  competitor: 'Cena konkurencji',
  competitor_rank: 'Ranking ofert z dostawą',
};
const roundingValue = (c: any) =>
  c.rounding ? c.rounding.step + ':' + c.rounding.ending : c.ending === 99 ? '99' : '';
const plDay = (d: string) => d.slice(8, 10) + '.' + d.slice(5, 7) + '.' + d.slice(0, 4);
function historyPath(root: string, filters: Record<string, string>, after?: string) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  if (after) q.set('after', after);
  const t = q.toString();
  return root + '/previews' + (t ? '?' + t : '');
}
export function RepricingPanel({
  listId,
  write,
  admin,
  onApplied,
  context,
  refresh,
  externalWriteBlocked,
}: {
  listId: string;
  write: boolean;
  admin: boolean;
  onApplied: () => Promise<void>;
  context: CompetitorObservationContext;
  refresh: number;
  externalWriteBlocked: boolean;
}) {
  const [data, setData] = useState<any>(null),
    [inputs, setInputs] = useState<any>({ data: [], meta: {} }),
    [history, setHistory] = useState<any>({ data: [], meta: {} }),
    [product, setProduct] = useState<any>(null),
    [selected, setSelected] = useState<string[]>([]),
    [preview, setPreview] = useState<any>(null),
    [lists, setLists] = useState<any[]>([]),
    [filters, setFilters] = useState<Record<string, string>>({ state: '', sku: '', strategy: '', source: '' }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const root = '/price-lists/' + listId + '/repricing';
  function requireWrite() {
    if (!write || externalWriteBlocked || competitorObservationsLocked(context))
      throw Error('Zapis repricingu jest zablokowany; sprawdź wynik poprzedniej próby.');
  }
  async function load(f = filters) {
    const d = await api(root);
    setData(d);
    setHistory(await api(historyPath(root, f)));
    if (d.rule) setInputs(await api(root + '/inputs'));
  }
  useEffect(() => {
    let active = true;
    api('/price-lists?active=true&limit=100')
      .then((l) => active && setLists(l.data))
      .catch(() => active && setLists([]));
    api(root)
      .then(async (d) => {
        if (!active) return;
        setData(d);
        const h = await api(historyPath(root, filters));
        if (active) setHistory(h);
        if (d.rule) {
          const i = await api(root + '/inputs');
          if (active) setInputs(i);
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [root]);
  async function run(f: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await f();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return <p>Wczytywanie repricingu…</p>;
  const rule = data.rule,
    config = rule?.config ?? defaults,
    currency = data.list.currency;
  const amountField = (name: string, label: string, value: number, max = 1000000) => (
    <label>
      {label}
      <input
        name={name}
        type="number"
        min="0"
        max={max}
        step="0.01"
        defaultValue={value / 100}
        required
      />
    </label>
  );
  function saveRule(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    run(async () => {
      requireWrite();
      const rounding = String(f.get('rounding') ?? '');
      const [step, end] = rounding.includes(':') ? rounding.split(':').map(Number) : [0, 0];
      // Base list and cost currency are administrator fields; others resend the stored values.
      const costCurrency = String(f.get('cost_currency') ?? currency),
        base = String(f.get('base_price_list_id') ?? ''),
        maxAge = String(f.get('max_rate_age_days') ?? '');
      const structural = admin
        ? {
            ...(costCurrency !== currency ? { cost_currency: costCurrency } : {}),
            ...(maxAge && costCurrency !== currency ? { max_rate_age_days: Number(maxAge) } : {}),
            ...(base ? { base_price_list_id: base } : {}),
          }
        : Object.fromEntries(
            ['cost_currency', 'max_rate_age_days', 'base_price_list_id']
              .filter((k) => config[k] !== undefined)
              .map((k) => [k, config[k]]),
          );
      await api(root, 'PUT', {
        version: rule?.version ?? 0,
        config: {
          enabled: f.get('enabled') === 'on',
          strategy: f.get('strategy'),
          min_margin_bps: minor(f.get('min_margin_bps')),
          target_margin_bps: minor(f.get('target_margin_bps')),
          fee_bps: minor(f.get('fee_bps')),
          fixed_net_cost: minor(f.get('fixed_net_cost')),
          min_price: minor(f.get('min_price')),
          max_price: minor(f.get('max_price')),
          undercut_amount: minor(f.get('undercut_amount')),
          observation_minutes: Number(f.get('observation_minutes')),
          direction: f.get('direction'),
          ending: rounding === '99' ? 99 : null,
          ...(step ? { rounding: { step, ending: end } } : {}),
          ...structural,
        },
      });
      setPreview(null);
      await load();
    });
  }
  return (
    <details className="repricing-panel" open>
      <summary>
        <strong>Repricing · ochrona marży</strong>
        {rule && (
          <span className="muted">
            {' '}
            · wersja {rule.version}
            {config.enabled ? ' · aktywny' : ' · wyłączony'}
          </span>
        )}
      </summary>
      <p className="muted">
        Ceny brutto w {currency}; koszty netto w {config.cost_currency ?? currency}
        {config.cost_currency && config.cost_currency !== currency
          ? ' przeliczane średnim kursem NBP (tabela A) z datą, zaokrąglone w górę do grosza'
          : ''}
        . Prowizja jest procentem sprzedaży netto.
        Zastosowane ceny trafiają do tego cennika; powiązane kanały korzystają z własnych ustawień
        synchronizacji.
      </p>
      {error && (
        <p role="alert" className="error-block">
          {error}
        </p>
      )}
      <button className="button" disabled={busy} onClick={() => run(load)}>
        Odśwież repricing
      </button>
      {write && (
        <form className="form-grid" key={rule?.version ?? 0} onSubmit={saveRule}>
          <label>
            Strategia
            <select name="strategy" defaultValue={config.strategy}>
              <option value="cost_margin">Docelowa marża</option>
              <option value="competitor">Cena konkurencji</option>
              <option value="competitor_rank" disabled={!admin}>Ranking ofert z dostawą</option>
            </select>
          </label>
          {amountField('min_margin_bps', 'Minimalna marża netto (%)', config.min_margin_bps, 90)}
          {amountField(
            'target_margin_bps',
            'Docelowa marża netto (%)',
            config.target_margin_bps,
            90,
          )}
          {amountField('fee_bps', 'Prowizja od sprzedaży netto (%)', config.fee_bps, 50)}
          {amountField('fixed_net_cost', 'Dodatkowy koszt netto / szt.', config.fixed_net_cost)}
          {amountField('min_price', 'Minimalna cena brutto', config.min_price)}
          {amountField('max_price', 'Maksymalna cena brutto', config.max_price)}
          {amountField('undercut_amount', 'Różnica względem konkurencji', config.undercut_amount)}
          <label>
            Ważność obserwacji (minuty)
            <input
              name="observation_minutes"
              type="number"
              min="1"
              max="10080"
              defaultValue={config.observation_minutes}
              required
            />
          </label>
          <label>
            Kierunek zmian
            <select name="direction" defaultValue={config.direction}>
              <option value="both">Obniżaj i podnoś</option>
              <option value="down">Tylko obniżaj</option>
              <option value="up">Tylko podnoś</option>
            </select>
          </label>
          <label>
            Zaokrąglenie ceny
            <select name="rounding" defaultValue={roundingValue(config)}>
              {!ROUNDINGS.some(([v]) => v === roundingValue(config)) && (
                <option value={roundingValue(config)}>
                  Zapisane: krok {config.rounding.step / 100} zł, końcówka {config.rounding.ending}
                </option>
              )}
              {ROUNDINGS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            Waluta kosztu netto
            <select
              name="cost_currency"
              defaultValue={config.cost_currency ?? currency}
              disabled={!admin}
              title={admin ? undefined : 'Zmienia administrator'}
            >
              {CURRENCIES.map((v) => (
                <option key={v} value={v}>
                  {v}
                  {v === currency ? ' (waluta cennika)' : ' → kurs NBP'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Maks. wiek kursu NBP (dni)
            <input
              name="max_rate_age_days"
              type="number"
              min="1"
              max="31"
              defaultValue={config.max_rate_age_days ?? 7}
              disabled={!admin}
            />
          </label>
          <label>
            Cennik bazowy (obecna cena, gdy brak wpisu)
            <select
              name="base_price_list_id"
              defaultValue={config.base_price_list_id ?? ''}
              disabled={!admin}
              title={admin ? undefined : 'Zmienia administrator'}
            >
              <option value="">Brak</option>
              {config.base_price_list_id &&
                !lists.some((l) => l.id === config.base_price_list_id) && (
                  <option value={config.base_price_list_id}>Wybrany cennik bazowy</option>
                )}
              {lists
                .filter((l) => l.id !== listId)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.currency})
                  </option>
                ))}
            </select>
          </label>
          <label className="warehouse-check">
            <input name="enabled" type="checkbox" defaultChecked={config.enabled} />
            Reguła aktywna
          </label>
          <button className="button primary" disabled={busy}>
            Zapisz regułę repricingu
          </button>
        </form>
      )}
      {rule && (
        <>
          <h3>Koszty i obserwacje</h3>
          <p className="muted">
            Jawne koszty netto operatora w {config.cost_currency ?? currency}. Dla rankingu wiele ofert i dostawa
            pochodzą z profilu i zapisanych obserwacji w panelu poniżej. Brak kosztu blokuje zmianę.
          </p>
          {write && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                run(async () => {
                  requireWrite();
                  if (!product) throw Error('Wybierz produkt');
                  const rival = String(f.get('competitor_price') ?? '').trim(),
                    time = String(f.get('observed_at') ?? '');
                  if (rival && !time) throw Error('Podaj czas obserwacji');
                  await api(root + '/inputs', 'PUT', {
                    version: rule.version,
                    items: [
                      {
                        product_id: product.id,
                        net_cost: minor(f.get('net_cost')),
                        competitor_price: rival ? minor(rival) : null,
                        observed_at: rival ? new Date(time).toISOString() : null,
                        source: f.get('source'),
                      },
                    ],
                  });
                  setPreview(null);
                  setSelected((s) => (s.includes(product.id) ? s : [...s, product.id]));
                  await load();
                });
              }}
            >
              <ProductPicker
                value={product?.id ?? ''}
                initial={product}
                select={setProduct}
                label="Produkt do repricingu"
                filter={(p) => p.kind !== 'group'}
              />
              <div className="form-grid">
                {amountField('net_cost', 'Koszt netto / szt.', 0)}
                <label>
                  Cena konkurencji brutto (opcjonalna)
                  <input name="competitor_price" type="number" min="0" max="1000000" step="0.01" />
                </label>
                <label>
                  Czas obserwacji
                  <input name="observed_at" type="datetime-local" />
                </label>
                <label>
                  Źródło danych
                  <input
                    name="source"
                    defaultValue="Ręczne dane operatora"
                    minLength={2}
                    maxLength={200}
                    required
                  />
                </label>
                <button className="button" disabled={busy}>
                  Zapisz koszt i obserwację
                </button>
              </div>
            </form>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Wybór</th>
                  <th>SKU / źródło</th>
                  <th>Koszt netto</th>
                  <th>Konkurencja brutto</th>
                </tr>
              </thead>
              <tbody>
                {inputs.data.map((i: any) => (
                  <tr key={i.product_id}>
                    <td>
                      <input
                        type="checkbox"
                        className="repricing-check"
                        aria-label={'Repricing ' + i.sku}
                        checked={selected.includes(i.product_id)}
                        onChange={(e) => {
                          setSelected((s) =>
                            e.target.checked
                              ? [...s, i.product_id]
                              : s.filter((v) => v !== i.product_id),
                          );
                          setPreview(null);
                        }}
                      />
                    </td>
                    <td>
                      <strong>{i.sku}</strong>
                      <small>{i.source}</small>
                    </td>
                    <td>{money(i.net_cost, currency)}</td>
                    <td>
                      {i.competitor_price === null ? '—' : money(i.competitor_price, currency)}
                      {i.observed_at && (
                        <small>{new Date(i.observed_at).toLocaleString('pl-PL')}</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!inputs.data.length && (
            <p className="muted">Dodaj koszty produktów do wyliczenia cen.</p>
          )}
          {inputs.meta.cursor && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const d = await api(root + '/inputs?after=' + inputs.meta.cursor);
                  setInputs({ ...d, data: [...inputs.data, ...d.data] });
                })
              }
            >
              Kolejne dane SKU
            </button>
          )}
          <RepricingOverridesPanel
            listId={listId}
            currency={currency}
            write={write && !externalWriteBlocked}
            skus={inputs.data.map((i: any) => ({ product_id: i.product_id, sku: i.sku }))}
            onChanged={() => setPreview(null)}
          />
          {write && config.strategy !== 'competitor_rank' && (
            <div className="toolbar-actions">
              <button
                className="button"
                onClick={() => {
                  setSelected(inputs.data.map((i: any) => i.product_id));
                  setPreview(null);
                }}
              >
                Zaznacz wczytane SKU
              </button>
              <button
                className="button primary"
                disabled={busy || !config.enabled || !selected.length || selected.length > 500}
                onClick={() =>
                  run(async () => {
                    requireWrite();
                    setPreview(
                      await api(root + '/previews', 'POST', {
                        client_key: crypto.randomUUID(),
                        product_ids: selected,
                      }),
                    );
                  })
                }
              >
                Wylicz podgląd cen ({selected.length})
              </button>
            </div>
          )}
        </>
      )}
      {preview && (
        <section aria-label="Podgląd repricingu">
          <h3>Podgląd cen · {preview.state === 'applied' ? 'zastosowany' : 'do zastosowania'}</h3>
          <p className="muted">
            Cennik v{preview.list_version} · reguła v{preview.rule_version} · ważny do{' '}
            {new Date(preview.expires_at).toLocaleString('pl-PL')}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Obecna cena</th>
                  <th>Minimum z marżą</th>
                  <th>Nowa cena</th>
                  <th>Wynik</th>
                </tr>
              </thead>
              <tbody>
                {preview.result.map((i: any) => (
                  <tr key={i.product_id}>
                    <td>{i.sku}</td>
                    <td>
                      {i.current_price === null ? '—' : money(i.current_price, preview.currency)}
                      {i.current_source === 'base' && <small>z cennika bazowego</small>}
                      {i.current_source === 'fallback' && <small>z reguły katalogowej</small>}
                    </td>
                    <td>
                      {i.floor === null ? '—' : money(i.floor, preview.currency)}
                      {i.fx && (
                        <small>
                          Koszt {money(i.fx.net_cost_original, i.fx.cost_currency)} →{' '}
                          {money(i.fx.net_cost, i.fx.list_currency)} ·{' '}
                          {i.fx.rates
                            .map(
                              (r: any) =>
                                `NBP ${r.currency} ${r.mid.replace('.', ',')} z ${plDay(r.effective_date)} (${r.table_no})`,
                            )
                            .join(', ')}
                        </small>
                      )}
                    </td>
                    <td>
                      {i.proposed_price === null ? '—' : money(i.proposed_price, preview.currency)}
                    </td>
                    <td>
                      {i.state === 'blocked'
                        ? 'Zablokowany'
                        : i.state === 'override'
                          ? 'Wykluczony ręcznie'
                          : i.state === 'unchanged'
                            ? 'Bez zmiany'
                            : 'Zmiana'}
                      <small>{i.reason}</small>
                      {i.override && i.computed_price !== null && i.computed_price !== undefined && (
                        <small>wyliczona automatycznie: {money(i.computed_price, preview.currency)}</small>
                      )}
                      {i.below_floor && <small>Cena ręczna poniżej minimum z marżą</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {write && preview.state === 'preview' && !preview.result.some((r: any) => r.rank_basis) && (
            <button
              className="button primary"
              disabled={busy || preview.result.some((i: any) => i.state === 'blocked')}
              onClick={() =>
                run(async () => {
                  requireWrite();
                  setPreview(
                    await api('/repricing-previews/' + preview.id + '/apply', 'POST', {
                      confirmed: true,
                    }),
                  );
                  await load();
                  await onApplied();
                })
              }
            >
              Zastosuj ceny w cenniku
            </button>
          )}
          {preview.state === 'applied' && (
            <p role="status">
              Ceny zastosowane atomowo · wersja cennika {preview.applied_list_version}
            </p>
          )}
        </section>
      )}
      {rule && (
        <RepricingSchedulePanel
          listId={listId}
          rule={rule}
          admin={admin && write}
          onRefresh={async () => {
            await load();
            await onApplied();
          }}
        />
      )}
      <h3>Historia repricingu</h3>
      <form
        className="form-grid"
        aria-label="Filtry historii repricingu"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const next = Object.fromEntries(
            ['state', 'sku', 'strategy', 'source'].map((k) => [k, String(f.get(k) ?? '').trim()]),
          );
          setFilters(next);
          run(async () => setHistory(await api(historyPath(root, next))));
        }}
      >
        <label>
          Stan
          <select name="state" defaultValue={filters.state}>
            <option value="">Wszystkie</option>
            <option value="preview">Podgląd do zastosowania</option>
            <option value="applied">Zastosowany</option>
            <option value="expired">Wygasły</option>
          </select>
        </label>
        <label>
          SKU zawiera
          <input name="sku" defaultValue={filters.sku} maxLength={120} />
        </label>
        <label>
          Strategia
          <select name="strategy" defaultValue={filters.strategy}>
            <option value="">Wszystkie</option>
            {Object.entries(STRATEGIES).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Źródło
          <select name="source" defaultValue={filters.source}>
            <option value="">Wszystkie</option>
            <option value="manual">Ręczny podgląd</option>
            <option value="schedule">Automat (harmonogram)</option>
          </select>
        </label>
        <button className="button" disabled={busy}>
          Filtruj historię
        </button>
      </form>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Utworzono</th>
              <th>Reguła</th>
              <th>Źródło</th>
              <th>Wynik</th>
              <th>Stan</th>
            </tr>
          </thead>
          <tbody>
            {history.data.map((p: any) => (
              <tr key={p.id}>
                <td>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      run(async () => setPreview(await api('/repricing-previews/' + p.id)))
                    }
                  >
                    {new Date(p.created_at).toLocaleString('pl-PL')}
                  </button>
                </td>
                <td>
                  {STRATEGIES[p.strategy] ?? 'Reguła sprzed zapisu strategii'}
                  <small>
                    reguła v{p.rule_version} · cennik v{p.list_version}
                  </small>
                </td>
                <td>{p.schedule_run_id ? 'Automat' : 'Ręczny'}</td>
                <td>
                  {p.count} SKU: {p.changed} zmian, {p.unchanged} bez zmiany, {p.blocked}{' '}
                  zablokowanych{p.overridden ? `, ${p.overridden} wykluczonych ręcznie` : ''}
                  {p.schedule_run_id && p.state === 'applied' && <small>{channelText(p.channel)}</small>}
                </td>
                <td>{p.state === 'applied' ? 'Zastosowany' : p.expired ? 'Wygasły' : 'Podgląd'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!history.data.length && <p className="muted">Brak podglądów dla wybranych filtrów.</p>}
      {history.meta.cursor && (
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const h = await api(historyPath(root, filters, history.meta.cursor));
              setHistory({ ...h, data: [...history.data, ...h.data] });
            })
          }
        >
          Kolejne podglądy
        </button>
      )}
      <CompetitorObservations
        listId={listId}
        context={context}
        rankEnabled={config.strategy === 'competitor_rank'}
        refresh={refresh}
        externalWriteBlocked={externalWriteBlocked || busy}
        onApplied={() => { void run(async () => { await load(); await onApplied(); }); }}
      />
    </details>
  );
}
