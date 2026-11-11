// Asortyment tab of automation rules v2: product rules of the "Reguły produktów" module (list, on/off, run log).
// Uses only /api/product-rules and /api/product-rule-runs; the full editor stays in the module.
import { useCallback, useEffect, useState } from 'react';
import { api, date } from './api';
import { navigateTo, pagePath } from './app-route';
import { errorText, isStaleVersion } from './automation-v2-api';

type ProductEvent = 'product.created' | 'product.updated';
interface ProductRuleDefinition {
  name: string;
  event: ProductEvent;
  enabled: boolean;
  priority: number;
  conditions: unknown[];
  actions: unknown[];
}
export interface ProductRule {
  id: string;
  version: number;
  name: string;
  enabled: boolean;
  definition: ProductRuleDefinition;
}
interface ProductRuleList {
  available: boolean;
  read_only: boolean;
  data: ProductRule[];
  meta?: { cursor: string | null };
}
export interface ProductRuleRun {
  id: string;
  event: ProductEvent;
  origin: 'manual' | 'catalog';
  state: 'preview' | 'queued' | 'done' | 'failed';
  error: string | null;
  result: { changed?: number; skipped?: number } | null;
  created_at: string;
  product_count?: number;
}
interface Page<T> {
  data: T[];
  meta: { cursor: string | null };
}

const MAX_PAGES = 20;
export const productRulesApi = {
  /** Every active definition (the server pages by 50). */
  async rules() {
    let first: ProductRuleList | null = null,
      cursor: string | null = null;
    const data: ProductRule[] = [];
    for (let i = 0; i < MAX_PAGES; i++) {
      const page: ProductRuleList = await api<ProductRuleList>('/product-rules' + (cursor ? '?after=' + encodeURIComponent(cursor) : ''));
      first ??= page;
      data.push(...page.data);
      cursor = page.meta?.cursor ?? null;
      if (!cursor) break;
    }
    return { ...first!, data };
  },
  /** server/product-rules.ts productRuleUpdate: version + full definition; enabling needs confirm_future_changes. */
  setEnabled: (r: ProductRule, enabled: boolean) =>
    api<ProductRule>('/product-rules/' + encodeURIComponent(r.id), 'PUT', {
      version: r.version,
      definition: { ...r.definition, enabled },
      confirm_future_changes: enabled,
    }),
  runs: (after?: string | null) => api<Page<ProductRuleRun>>('/product-rule-runs' + (after ? '?after=' + encodeURIComponent(after) : '')),
};

const EVENT: Record<ProductEvent, string> = { 'product.created': 'Po utworzeniu produktu', 'product.updated': 'Po zmianie produktu' };
const ORIGIN: Record<ProductRuleRun['origin'], string> = { manual: 'ręcznie', catalog: 'po zapisie produktu' };
const STATE: Record<ProductRuleRun['state'], string> = { preview: 'Podgląd', queued: 'W kolejce', done: 'Wykonano', failed: 'Błąd' };
const MODULE = pagePath('productRules');
const byPriority = (a: ProductRule, b: ProductRule) => a.definition.priority - b.definition.priority || a.name.localeCompare(b.name, 'pl');

function ModuleLink({ children }: { children: string }) {
  return (
    <a
      className="button small-btn"
      href={MODULE}
      onClick={(e) => {
        e.preventDefault();
        navigateTo(MODULE);
      }}
    >
      {children}
    </a>
  );
}

export function ProductRulesTab({ admin, write, refresh = 0, notify }: { admin: boolean; write: boolean; refresh?: number; notify: (message: string, error?: boolean) => void }) {
  const [list, setList] = useState<ProductRuleList | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirmOn, setConfirmOn] = useState<string | null>(null),
    [attempt, setAttempt] = useState(0);
  const load = useCallback(async () => {
    setError('');
    try {
      setList(await productRulesApi.rules());
    } catch (e) {
      setError('Nie udało się wczytać reguł produktów: ' + errorText(e));
    }
  }, []);
  useEffect(() => {
    if (admin) void load();
  }, [admin, load, refresh, attempt]);

  if (!admin) return <p className="muted av2-pad">Reguły produktów widzi tylko administrator.</p>;
  if (error && !list)
    return (
      <div className="av2-pad">
        <p className="notice" role="alert">
          {error}
        </p>
        <button type="button" className="button small-btn" onClick={() => setAttempt((n) => n + 1)}>
          Spróbuj ponownie
        </button>
      </div>
    );
  if (!list) return <p className="muted av2-pad">Wczytuję reguły produktów…</p>;
  if (!list.available) return <p className="notice av2-pad">Ta kopia nie zawiera automatyzacji produktów.</p>;

  const canWrite = write && !list.read_only;
  const rules = [...list.data].sort(byPriority);
  async function toggle(r: ProductRule, enabled: boolean) {
    if (!canWrite || busy) return;
    setBusy(true);
    setConfirmOn(null);
    try {
      const saved = await productRulesApi.setEnabled(r, enabled);
      setList((l) => (l ? { ...l, data: l.data.map((x) => (x.id === saved.id ? saved : x)) } : l));
      notify((saved.enabled ? 'Włączono' : 'Wyłączono') + ' regułę produktów „' + saved.name + '”.');
    } catch (e) {
      notify(isStaleVersion(e) ? 'Reguła została zmieniona przez kogoś innego. Wczytano aktualną listę.' : errorText(e), true);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="av2-products">
      {list.read_only && write && <p className="notice av2-pad">Reguły produktów są w tej kopii tylko do odczytu.</p>}
      <div className="av2-rule-group">
        <div className="av2-group-head">
          <h3>Reguły produktów</h3>
          <ModuleLink>Otwórz moduł Reguły produktów</ModuleLink>
        </div>
        {!rules.length ? (
          <p className="muted">Brak reguł produktów.</p>
        ) : (
          <table className="av2-table av2-rules">
            <thead>
              <tr>
                <th>Priorytet</th>
                <th>Nazwa</th>
                <th>Aktywna</th>
                <th aria-label="Akcje" />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td className="av2-order">
                    <span>{r.definition.priority}</span>
                  </td>
                  <td>
                    <strong>{r.name}</strong>
                    <small>
                      {EVENT[r.definition.event] ?? r.definition.event} · warunki: {r.definition.conditions.length} · akcje: {r.definition.actions.length}
                    </small>
                    <small>{r.enabled ? 'Aktywna' : 'Wyłączona'}</small>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={'switch ' + (r.enabled ? 'on' : '')}
                      role="switch"
                      aria-checked={r.enabled}
                      aria-label={'Reguła produktów ' + r.name + ' aktywna'}
                      disabled={!canWrite || busy}
                      onClick={() => (r.enabled ? void toggle(r, false) : setConfirmOn(r.id))}
                    >
                      <span />
                    </button>
                  </td>
                  <td>
                    <div className="ops-buttons av2-row-actions">
                      {confirmOn === r.id && canWrite ? (
                        <>
                          <small className="av2-consent">Włączona reguła będzie zmieniać produkty przy każdym ich zapisie.</small>
                          <button type="button" className="button small-btn primary" disabled={busy} onClick={() => void toggle(r, true)}>
                            Potwierdź włączenie
                          </button>
                          <button type="button" className="button small-btn" onClick={() => setConfirmOn(null)}>
                            Anuluj
                          </button>
                        </>
                      ) : (
                        canWrite && <ModuleLink>Edytuj w module Reguły produktów</ModuleLink>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <ProductRunsLog refresh={refresh} />
    </div>
  );
}

function ProductRunsLog({ refresh }: { refresh: number }) {
  const [runs, setRuns] = useState<Page<ProductRuleRun> | null>(null),
    [error, setError] = useState(''),
    [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setError('');
    productRulesApi
      .runs()
      .then((r) => live && setRuns(r))
      .catch((e) => live && setError('Nie udało się wczytać dziennika reguł produktów: ' + errorText(e)));
    return () => {
      live = false;
    };
  }, [refresh, tick]);
  async function older() {
    if (!runs?.meta.cursor) return;
    try {
      const next = await productRulesApi.runs(runs.meta.cursor);
      setRuns({ data: [...runs.data, ...next.data], meta: next.meta });
    } catch (e) {
      setError('Nie udało się wczytać starszych uruchomień: ' + errorText(e));
    }
  }
  return (
    <div className="av2-rule-group av2-product-runs">
      <div className="av2-group-head">
        <h3>Dziennik reguł produktów</h3>
        <button type="button" className="button small-btn" onClick={() => setTick((n) => n + 1)}>
          Odśwież
        </button>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <div className="table-scroll">
        <table className="av2-table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Zdarzenie</th>
              <th>Uruchomienie</th>
              <th>Produkty</th>
              <th>Wynik</th>
              <th>Szczegóły</th>
            </tr>
          </thead>
          <tbody>
            {runs?.data.map((r) => (
              <tr key={r.id} className={r.state === 'failed' ? 'av2-invalid' : undefined}>
                <td>{date(r.created_at)}</td>
                <td>{EVENT[r.event] ?? r.event}</td>
                <td>{ORIGIN[r.origin] ?? r.origin}</td>
                <td>{r.product_count ?? '—'}</td>
                <td>{STATE[r.state] ?? r.state}</td>
                <td>{r.error ?? (r.state === 'done' ? 'zmienione: ' + (r.result?.changed ?? 0) + ', bez zmian: ' + (r.result?.skipped ?? 0) : '—')}</td>
              </tr>
            ))}
            {runs && !runs.data.length && (
              <tr>
                <td colSpan={6} className="muted">
                  Brak uruchomień reguł produktów.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {runs?.meta.cursor && (
        <button type="button" className="button small-btn" onClick={() => void older()}>
          Starsze uruchomienia
        </button>
      )}
    </div>
  );
}
