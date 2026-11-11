// Automation rules v2 (Uwagi v3 §0): rules list by group, priority order, editor, run log.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { date } from './api';
import type { AutomationCatalog, AutomationRuleV2, AutomationRunSummary } from '../shared/automation-v2';
import { automationV2Api, errorText, isStaleVersion } from './automation-v2-api';
import { RuleEditor } from './automation-v2-editor';
import { ProductRulesTab } from './automation-v2-products';
import { describeTree, draftFromRule, emptyDraft, fieldMap, groupRules, moveRuleId, runSummary, toRuleInput, type RuleDraft } from './automation-v2-model';
import './automation-v2.css';

type Tab = 'orders' | 'products' | 'runs';
const TABS: Array<[Tab, string]> = [
  ['orders', 'Zamówienia'],
  ['products', 'Asortyment'],
  ['runs', 'Dziennik uruchomień'],
];

export interface AutomationRulesV2Props {
  admin: boolean;
  /** "Automatyzacje: edycja" (267): an operator with the grant may create and change rules; the administrator always may. */
  editor?: boolean;
  readOnly?: boolean;
  refresh?: number;
  notify: (message: string, error?: boolean) => void;
  /** Preloaded catalog (tests, development without the server); otherwise GET /catalog. */
  catalog?: AutomationCatalog;
}

export function AutomationRulesV2({ admin, editor = false, readOnly = false, refresh = 0, notify, catalog: given }: AutomationRulesV2Props) {
  const [catalog, setCatalog] = useState<AutomationCatalog | null>(given ?? null),
    [rules, setRules] = useState<AutomationRuleV2[] | null>(null),
    [error, setError] = useState(''),
    [tab, setTab] = useState<Tab>('orders'),
    [editing, setEditing] = useState<RuleDraft | null>(null),
    [busy, setBusy] = useState(false),
    [confirmDelete, setConfirmDelete] = useState<string | null>(null),
    [dragId, setDragId] = useState<string | null>(null),
    [attempt, setAttempt] = useState(0);
  const write = (admin || editor) && !readOnly;

  const load = useCallback(async () => {
    setError('');
    try {
      const [c, r] = await Promise.all([given ? Promise.resolve(given) : automationV2Api.catalog(), automationV2Api.rules()]);
      setCatalog(c);
      setRules(r);
    } catch (e) {
      setError('Nie udało się wczytać reguł automatycznych: ' + errorText(e));
    }
  }, [given]);
  useEffect(() => {
    void load();
  }, [load, refresh, attempt]);

  const allGroups = useMemo(() => [...new Set((rules ?? []).map((r) => r.config.group).filter(Boolean))], [rules]);
  const fields = useMemo(() => (catalog ? fieldMap(catalog) : new Map()), [catalog]);

  async function act(fn: () => Promise<void>) {
    if (!write || busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(isStaleVersion(e) ? 'Reguła została zmieniona przez kogoś innego. Wczytano aktualną listę.' : errorText(e), true);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const toggle = (r: AutomationRuleV2) =>
    act(async () => {
      const saved = await automationV2Api.update(r.id, { ...toRuleInput(draftFromRule(r)), enabled: !r.enabled }, r.version);
      setRules((list) => list?.map((x) => (x.id === saved.id ? saved : x)) ?? null);
      notify((saved.enabled ? 'Włączono' : 'Wyłączono') + ' regułę „' + saved.name + '”.');
    });

  const copy = (r: AutomationRuleV2) =>
    act(async () => {
      const created = await automationV2Api.copy(r.id);
      await load();
      notify('Utworzono kopię „' + created.name + '”.');
    });

  const remove = (r: AutomationRuleV2) =>
    act(async () => {
      setConfirmDelete(null);
      await automationV2Api.remove(r.id);
      if (editing?.id === r.id) setEditing(null);
      await load();
      notify('Usunięto regułę „' + r.name + '”.');
    });

  const reorder = (id: string, targetId: string, place: 'before' | 'after') =>
    act(async () => {
      if (!rules) return;
      const ids = moveRuleId(rules.map((r) => r.id), id, targetId, place);
      if (ids.join() === rules.map((r) => r.id).join()) return;
      const byId = new Map(rules.map((r) => [r.id, r]));
      setRules(ids.map((x) => byId.get(x)!));
      await automationV2Api.order(ids);
      await load();
    });

  const tabs = (
    <div className="av2-tabs" role="tablist" aria-label="Reguły automatyczne">
      {TABS.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id} className="button small-btn" onClick={() => setTab(id)}>
          {label}
        </button>
      ))}
    </div>
  );

  if (error && !rules)
    return (
      <section className="panel ops-panel av2">
        <div className="panel-heading">
          <h2>Reguły automatyczne</h2>
        </div>
        <p className="notice" role="alert">
          {error}
        </p>
        <div className="ops-buttons">
          <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
            Spróbuj ponownie
          </button>
        </div>
      </section>
    );
  if (!catalog || !rules)
    return (
      <section className="panel ops-panel av2">
        <p className="muted av2-pad">Wczytuję reguły automatyczne…</p>
      </section>
    );

  const scoped = rules.filter((r) => r.config.scope === (tab === 'products' ? 'products' : 'orders'));
  const priority = new Map(rules.map((r, i) => [r.id, i + 1]));

  return (
    <div className="av2">
      {editing && (
        <RuleEditor
          key={(editing.id ?? 'new') + ':' + (editing.version ?? 0)}
          catalog={catalog}
          initial={editing}
          groups={allGroups}
          onClose={() => setEditing(null)}
          onSaved={(rule, message) => {
            setRules((list) => (list?.some((x) => x.id === rule.id) ? list.map((x) => (x.id === rule.id ? rule : x)) : [...(list ?? []), rule]));
            notify(message);
            void load();
          }}
        />
      )}
      <section className="panel ops-panel">
        <div className="panel-heading">
          <div>
            <h2>Reguły automatyczne</h2>
            <p>Warunki → efekty · kolejność na liście = priorytet (wyżej = wcześniej)</p>
          </div>
          {write && tab !== 'runs' && (
            <button type="button" className="button primary" disabled={busy} onClick={() => setEditing(emptyDraft(tab === 'products' ? 'products' : 'orders'))}>
              <Plus size={16} /> Nowa reguła
            </button>
          )}
        </div>
        {tabs}
        {readOnly && <p className="notice">Tryb tylko do odczytu — zmiany reguł są wyłączone.</p>}
        {tab === 'products' && <ProductRulesTab admin={admin} write={admin && !readOnly} refresh={refresh} notify={notify} />}
        {tab === 'products' && !!scoped.length && <h3 className="av2-subhead">Reguły automatyczne asortymentu</h3>}
        {tab === 'runs' ? (
          <RunsLog rules={rules} refresh={refresh} />
        ) : !scoped.length ? (
          tab === 'products' ? null : <p className="muted av2-pad">Brak reguł w tej zakładce.</p>
        ) : (
          groupRules(scoped).map((g) => (
            <div className="av2-rule-group" key={g.group}>
              <h3>{g.group}</h3>
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
                  {g.rules.map((r, i) => (
                    <tr
                      key={r.id}
                      className={dragId === r.id ? 'av2-dragging' : undefined}
                      onDragOver={(e) => dragId && dragId !== r.id && e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragId) void reorder(dragId, r.id, (priority.get(dragId) ?? 0) < (priority.get(r.id) ?? 0) ? 'after' : 'before');
                        setDragId(null);
                      }}
                    >
                      <td className="av2-order">
                        {write && (
                          <span className="av2-handle" draggable aria-hidden title="Przeciągnij, aby zmienić priorytet" onDragStart={() => setDragId(r.id)} onDragEnd={() => setDragId(null)}>
                            ↕
                          </span>
                        )}
                        <span>{priority.get(r.id)}</span>
                        {write && (
                          <>
                            <button type="button" className="icon-btn" disabled={busy || i === 0} aria-label={'Przesuń „' + r.name + '” wyżej'} onClick={() => void reorder(r.id, g.rules[i - 1].id, 'before')}>
                              <ArrowUp size={14} />
                            </button>
                            <button type="button" className="icon-btn" disabled={busy || i === g.rules.length - 1} aria-label={'Przesuń „' + r.name + '” niżej'} onClick={() => void reorder(r.id, g.rules[i + 1].id, 'after')}>
                              <ArrowDown size={14} />
                            </button>
                          </>
                        )}
                      </td>
                      <td>
                        <strong>{r.name}</strong>
                        <small>{runSummary(r, catalog)}</small>
                        <small className="av2-tree">{describeTree(r.config.conditions, fields)}</small>
                      </td>
                      <td>
                        <button type="button" className={'switch ' + (r.enabled ? 'on' : '')} role="switch" aria-checked={r.enabled} aria-label={'Reguła ' + r.name + ' aktywna'} disabled={!write || busy} onClick={() => void toggle(r)}>
                          <span />
                        </button>
                      </td>
                      <td>
                        <div className="ops-buttons av2-row-actions">
                          <button type="button" className="button small-btn" disabled={!write} onClick={() => setEditing(draftFromRule(r))}>
                            Edytuj
                          </button>
                          <button type="button" className="button small-btn" disabled={!write || busy} onClick={() => void copy(r)}>
                            Zapisz jako nowy
                          </button>
                          {confirmDelete === r.id ? (
                            <>
                              <button type="button" className="button small-btn danger" disabled={busy} onClick={() => void remove(r)}>
                                Potwierdź usunięcie
                              </button>
                              <button type="button" className="button small-btn" onClick={() => setConfirmDelete(null)}>
                                Anuluj
                              </button>
                            </>
                          ) : (
                            <button type="button" className="button small-btn danger" disabled={!write || busy} onClick={() => setConfirmDelete(r.id)}>
                              Usuń
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

const RUN_STATUS: Record<AutomationRunSummary['status'], string> = { queued: 'W kolejce', done: 'Wykonano', skipped: 'Pominięto', failed: 'Błąd' };
const RUN_SOURCE: Record<AutomationRunSummary['source'], string> = {
  auto: 'samoczynnie',
  event: 'zdarzenie',
  manual: 'ręcznie',
  barcode: 'kod kreskowy',
  schedule: 'harmonogram',
};

export function RunsLog({ rules, refresh = 0 }: { rules: AutomationRuleV2[]; refresh?: number }) {
  const [ruleId, setRuleId] = useState(''),
    [runs, setRuns] = useState<AutomationRunSummary[] | null>(null),
    [error, setError] = useState(''),
    [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setError('');
    automationV2Api
      .runs(ruleId ? { rule_id: ruleId } : {})
      .then((r) => live && setRuns(r))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [ruleId, refresh, tick]);
  return (
    <div className="av2-runs">
      <div className="av2-inline av2-pad">
        <label>
          Reguła{' '}
          <select value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
            <option value="">Wszystkie reguły</option>
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="button small-btn" onClick={() => setTick((n) => n + 1)}>
          Odśwież
        </button>
      </div>
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="table-scroll">
        <table className="av2-table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Reguła</th>
              <th>Zamówienie</th>
              <th>Uruchomienie</th>
              <th>Wynik</th>
              <th>Szczegóły</th>
            </tr>
          </thead>
          <tbody>
            {runs?.map((r) => (
              <tr key={r.id} className={r.status === 'failed' ? 'av2-invalid' : undefined}>
                <td>{date(r.created_at)}</td>
                <td>{r.rule_name}</td>
                <td>{r.order_number ?? '—'}</td>
                <td>{RUN_SOURCE[r.source] ?? r.source}</td>
                <td>{RUN_STATUS[r.status] ?? r.status}</td>
                <td>{r.error ?? r.reason ?? '—'}</td>
              </tr>
            ))}
            {runs && !runs.length && (
              <tr>
                <td colSpan={6} className="muted">
                  Brak uruchomień.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
