// "Edytujesz akcję automatyczną": the v2 rule editor (Uwagi v3 §0).
import { useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Printer, X } from 'lucide-react';
import type { AutomationCatalog, AutomationRuleV2, CatalogEffect, EffectSpec, RunSettings } from '../shared/automation-v2';
import { automationV2Api, errorText, isStaleVersion } from './automation-v2-api';
import { code128Svg } from './automation-v2-barcode';
import { ConditionsEditor, EffectParamsForm, GroupedPicker, ListValueEditor, WeekdayChips } from './automation-v2-fields';
import { RuleFooter, RuleVersionsLog } from './automation-v2-footer';
import {
  draftFromRule,
  fieldMap,
  isSupported,
  moveItem,
  newEffect,
  toRuleInput,
  validateConditions,
  validateDraft,
  type RuleDraft,
} from './automation-v2-model';

export interface RuleEditorProps {
  catalog: AutomationCatalog;
  initial: RuleDraft;
  /** Existing rule groups for the "Grupa akcji" combobox. */
  groups: string[];
  onSaved: (rule: AutomationRuleV2, message: string) => void;
  onClose: () => void;
}

const sameInput = (a: RuleDraft, b: RuleDraft) => JSON.stringify(toRuleInput(a)) === JSON.stringify(toRuleInput(b));

export function RuleEditor({ catalog, initial, groups, onSaved, onClose }: RuleEditorProps) {
  const [draft, setDraft] = useState<RuleDraft>(initial),
    [saved, setSaved] = useState<RuleDraft>(initial),
    [busy, setBusy] = useState(false),
    [errors, setErrors] = useState<string[]>([]),
    [stale, setStale] = useState(false),
    [message, setMessage] = useState(''),
    [revision, setRevision] = useState(0);
  const flight = useRef(false);
  const fields = useMemo(() => fieldMap(catalog), [catalog]);
  const conditionErrors = useMemo(
    () => new Map(validateConditions(draft.config.conditions, fields).map((e) => [e.path.join('.'), e.message])),
    [draft.config.conditions, fields],
  );
  const dirty = !sameInput(draft, saved);
  const config = draft.config,
    run = config.run;
  const setConfig = (patch: Partial<RuleDraft['config']>) => setDraft((d) => ({ ...d, config: { ...d.config, ...patch } }));
  const setRun = (patch: Partial<RunSettings>) => setDraft((d) => ({ ...d, config: { ...d.config, run: { ...d.config.run, ...patch } } }));
  const setEffects = (effects: EffectSpec[]) => setConfig({ effects });

  async function save(asNew: boolean) {
    if (flight.current) return;
    const problems = validateDraft(draft, catalog);
    setErrors(problems);
    setMessage('');
    if (problems.length) return;
    flight.current = true;
    setBusy(true);
    try {
      const input = toRuleInput(draft);
      if (asNew && draft.id && input.name === saved.name.trim()) input.name = (input.name + ' (kopia)').slice(0, 120);
      const rule =
        draft.id && !asNew && draft.version !== undefined
          ? await automationV2Api.update(draft.id, input, draft.version)
          : await automationV2Api.create(input);
      const next = draftFromRule(rule);
      setDraft(next);
      setSaved(next);
      setStale(false);
      setRevision((n) => n + 1);
      onSaved(rule, asNew ? 'Zapisano jako nową regułę „' + rule.name + '”.' : 'Zapisano regułę „' + rule.name + '”.');
    } catch (e) {
      if (isStaleVersion(e)) setStale(true);
      else setMessage(errorText(e));
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }

  async function reloadCurrent() {
    if (!draft.id) return;
    setBusy(true);
    try {
      const current = (await automationV2Api.rules()).find((r) => r.id === draft.id);
      if (!current) {
        setMessage('Reguła została usunięta przez innego użytkownika. Możesz zapisać ją jako nową.');
        return;
      }
      const next = draftFromRule(current);
      setDraft(next);
      setSaved(next);
      setStale(false);
      setRevision((n) => n + 1);
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const effectItems = catalog.effects.map((e) => ({ key: e.type, group: e.group, label: e.label, disabled: !isSupported(e) }));
  const effectGroups = [...new Set(catalog.effects.map((e) => e.group))];
  const allGroups = [...new Set([...groups, ...catalog.groups].filter(Boolean))];
  const triggerGroups = [...new Set(catalog.triggers.map((t) => t.group))];
  const hasMatches = catalog.triggers.some((t) => t.key === 'order.matches');

  return (
    <form
      className="panel av2-editor"
      aria-label="Edytor reguły automatycznej"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <div className="panel-heading">
        <div>
          <h2>{draft.id ? 'Edytujesz akcję automatyczną: ' + (saved.name || draft.name) : 'Nowa akcja automatyczna'}</h2>
          <p>Warunki → efekty w kolejności · {config.scope === 'orders' ? 'Zamówienia' : 'Asortyment'}</p>
        </div>
        <button type="button" className="icon-btn" aria-label="Zamknij edytor" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <div className="av2-body">
        <section className="av2-section av2-basics">
          <label>
            Nazwa
            <input required maxLength={120} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            Grupa akcji
            <input list="av2-groups" value={config.group} onChange={(e) => setConfig({ group: e.target.value })} placeholder="np. Wysyłka" />
            <datalist id="av2-groups">
              {allGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
          <label>
            Dotyczy
            <select value={config.scope} onChange={(e) => setConfig({ scope: e.target.value as 'orders' | 'products' })}>
              <option value="orders">Zamówienia</option>
              <option value="products">Asortyment</option>
            </select>
          </label>
          <label className="av2-check">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            Reguła aktywna
          </label>
        </section>

        <BarcodeBlock draft={draft} onToggle={(barcode) => setRun({ barcode })} />

        <section className="av2-section">
          <h3>Uruchamianie samoczynne</h3>
          <div className="av2-inline">
            <button type="button" className={'switch ' + (run.auto ? 'on' : '')} role="switch" aria-checked={run.auto} aria-label="Uruchamianie samoczynne" onClick={() => setRun({ auto: !run.auto })}>
              <span />
            </button>
            <label>
              Zdarzenie
              <select value={draft.trigger} onChange={(e) => setDraft({ ...draft, trigger: e.target.value })}>
                {!hasMatches && <option value="order.matches">Gdy zamówienie spełni warunki</option>}
                {triggerGroups.map((g) => (
                  <optgroup key={g} label={g}>
                    {catalog.triggers.filter((t) => t.group === g).map((t) => (
                      <option key={t.key} value={t.key} disabled={t.supported === false && t.key !== draft.trigger} title={t.hint}>
                        {t.label}
                        {t.supported === false ? ' (niedostępne)' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          </div>
          {draft.trigger === 'order.status_changed' && (
            <StatusChangeFilter catalog={catalog} value={config.status_change} onChange={(status_change) => setConfig({ status_change })} />
          )}
          {run.auto && (
            <div className="av2-run-grid">
              <label>
                Opóźnienie (min)
                <input type="number" min={0} value={run.delay_minutes} onChange={(e) => setRun({ delay_minutes: Number(e.target.value) })} />
              </label>
              <label>
                Tryb działania
                <select value={run.mode} onChange={(e) => setRun({ mode: e.target.value as RunSettings['mode'] })}>
                  <option value="continuous">Ciągły (za każdym razem, gdy zamówienie spełni warunki)</option>
                  <option value="once">Jednorazowo (najwyżej raz na zamówienie)</option>
                </select>
              </label>
              <div className="av2-hours">
                <label className="av2-check">
                  <input
                    type="checkbox"
                    checked={!!run.hours}
                    onChange={(e) => setRun({ hours: e.target.checked ? { days: [1, 2, 3, 4, 5], from: '08:00', to: '16:00' } : null })}
                  />
                  Tylko w godzinach pracy
                </label>
                {run.hours && (
                  <div className="av2-inline">
                    <WeekdayChips value={run.hours.days} onChange={(days) => setRun({ hours: { ...run.hours!, days } })} label="Dni pracy" />
                    od <input type="time" aria-label="Godziny pracy od" value={run.hours.from} onChange={(e) => setRun({ hours: { ...run.hours!, from: e.target.value } })} />
                    do <input type="time" aria-label="Godziny pracy do" value={run.hours.to} onChange={(e) => setRun({ hours: { ...run.hours!, to: e.target.value } })} />
                    <small className="muted">Czas polski; poza oknem uruchomienie czeka na najbliższe otwarcie.</small>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="av2-section">
          <h3>Uruchamianie ręczne</h3>
          <label className="av2-check">
            <input type="checkbox" checked={run.manual_button} onChange={(e) => setRun({ manual_button: e.target.checked })} />
            Pokaż przycisk aktywacji (lista zamówień i karta)
          </label>
        </section>

        <section className="av2-section">
          <h3>Warunki</h3>
          <ConditionsEditor root={config.conditions} fields={catalog.fields} fieldMap={fields} errors={conditionErrors} onChange={(conditions) => setConfig({ conditions })} />
        </section>

        <section className="av2-section">
          <h3>Efekty</h3>
          <EffectsTable catalog={catalog} effects={config.effects} onChange={setEffects} />
          <div className="ops-buttons">
            <GroupedPicker
              label="Dodaj efekt"
              items={effectItems}
              order={effectGroups}
              onPick={(type) => {
                const e = catalog.effects.find((x) => x.type === type);
                if (e) setEffects([...config.effects, newEffect(e)]);
              }}
            />
          </div>
          <label className="av2-check">
            <input type="checkbox" checked={config.stop_further} onChange={(e) => setConfig({ stop_further: e.target.checked })} />
            Nie sprawdzaj kolejnych reguł (po wykonaniu tej reguły reguły o niższym priorytecie pomijają to zdarzenie)
          </label>
        </section>

        {errors.length > 0 && (
          <div className="notice av2-errors" role="alert">
            <strong>Popraw przed zapisem:</strong>
            <ul>
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}
        {stale && (
          <div className="notice av2-errors" role="alert">
            <p>Ktoś zapisał nowszą wersję tej reguły. Wczytaj aktualną wersję (Twoje zmiany przepadną) albo zapisz swoje zmiany jako nową regułę.</p>
            <div className="ops-buttons">
              <button type="button" className="button small-btn" disabled={busy} onClick={() => void reloadCurrent()}>
                Wczytaj aktualną wersję
              </button>
              <button type="button" className="button small-btn" disabled={busy} onClick={() => void save(true)}>
                Zapisz moje zmiany jako nowy
              </button>
            </div>
          </div>
        )}
        {message && (
          <p className="notice" role="alert">
            {message}
          </p>
        )}
      </div>

      <RuleFooter catalog={catalog} ruleId={draft.id} dirty={dirty} revision={revision} />
      <div className="av2-footer-actions">
        <button type="button" className="button" onClick={onClose}>
          Zamknij
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => void save(true)}>
          Zapisz jako nowy
        </button>
        <button type="submit" className="button primary" disabled={busy || (!!draft.id && !dirty)}>
          Zapisz
        </button>
      </div>
      {draft.id && <RuleVersionsLog catalog={catalog} ruleId={draft.id} revision={revision} />}
    </form>
  );
}

/** "Z dowolnego lub z wybranego statusu na wybrany": stages and own statuses; empty = any. */
function StatusChangeFilter({
  catalog,
  value,
  onChange,
}: {
  catalog: AutomationCatalog;
  value: { from: string[]; to: string[] } | undefined;
  onChange: (v: { from: string[]; to: string[] }) => void;
}) {
  const field = (key: string) => catalog.fields.find((f) => f.key === key)?.options ?? [];
  // "Gotowe do nadania" follows the label, not a status change, so it is not offered here.
  const options = [
    ...field('order.status').filter((o) => o.value !== 'ready_to_ship').map((o) => ({ ...o, group: 'Status realizacji' })),
    ...field('order.workflow_status').map((o) => ({ ...o, group: 'Własny status' + (o.group ? ': ' + o.group : '') })),
  ];
  const current = value ?? { from: [], to: [] };
  return (
    <div className="av2-inline av2-status-change">
      <div className="av2-status-col">
        <span>Ze statusu</span>
        <ListValueEditor label="Ze statusu" emptyLabel="Dowolny" options={options} value={current.from} onChange={(from) => onChange({ ...current, from })} />
      </div>
      <div className="av2-status-col">
        <span>Na status</span>
        <ListValueEditor label="Na status" emptyLabel="Dowolny" options={options} value={current.to} onChange={(to) => onChange({ ...current, to })} />
      </div>
      <small className="muted">Pusta lista oznacza dowolny status.</small>
    </div>
  );
}

function BarcodeBlock({ draft, onToggle }: { draft: RuleDraft; onToggle: (on: boolean) => void }) {
  const on = draft.config.run.barcode;
  let svg = '',
    problem = '';
  if (on && draft.barcode) {
    try {
      svg = code128Svg(draft.barcode);
    } catch (e) {
      problem = errorText(e);
    }
  }
  const print = () => {
    const w = window.open('', '_blank', 'width=480,height=320');
    if (!w) return;
    w.document.title = 'Kod reguły ' + draft.name;
    w.document.body.innerHTML = `<div style="font-family:sans-serif;text-align:center;padding:16px"><p></p>${svg}</div>`;
    w.document.querySelector('p')!.textContent = draft.name;
    w.focus();
    w.print();
  };
  return (
    <section className="av2-section av2-barcode">
      <h3>Kod kreskowy aktywujący akcję</h3>
      <label className="av2-check">
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        Uruchamiaj regułę po zeskanowaniu kodu razem z zamówieniem
      </label>
      {on && !draft.barcode && <p className="muted">Kod zostanie nadany po zapisaniu reguły.</p>}
      {problem && <p className="av2-error">{problem}</p>}
      {svg && (
        <div className="av2-inline">
          <span className="av2-barcode-svg" dangerouslySetInnerHTML={{ __html: svg }} />
          <button type="button" className="button small-btn" onClick={print}>
            <Printer size={14} /> Drukuj
          </button>
        </div>
      )}
    </section>
  );
}

function EffectsTable({ catalog, effects, onChange }: { catalog: AutomationCatalog; effects: EffectSpec[]; onChange: (e: EffectSpec[]) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const byType = (t: string): CatalogEffect | undefined => catalog.effects.find((e) => e.type === t);
  const move = (from: number, to: number) => onChange(moveItem(effects, from, to));
  if (!effects.length) return <p className="muted">Brak efektów — dodaj co najmniej jeden.</p>;
  return (
    <table className="av2-table av2-effects">
      <thead>
        <tr>
          <th aria-label="Kolejność" />
          <th>Nr</th>
          <th>Efekt</th>
          <th>Ustawienia</th>
          <th aria-label="Usuń" />
        </tr>
      </thead>
      <tbody>
        {effects.map((spec, i) => {
          const effect = byType(spec.type);
          return (
            <tr
              key={i + ':' + spec.type}
              className={drag === i ? 'av2-dragging' : undefined}
              onDragOver={(e) => drag !== null && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (drag !== null) move(drag, i);
                setDrag(null);
              }}
            >
              <td className="av2-order">
                <span
                  className="av2-handle"
                  draggable
                  title="Przeciągnij, aby zmienić kolejność"
                  aria-hidden
                  onDragStart={(e) => {
                    e.dataTransfer?.setData('text/plain', String(i));
                    setDrag(i);
                  }}
                  onDragEnd={() => setDrag(null)}
                >
                  ↕
                </span>
                <button type="button" className="icon-btn" disabled={i === 0} aria-label={'Przesuń efekt ' + (i + 1) + ' wyżej'} onClick={() => move(i, i - 1)}>
                  <ArrowUp size={14} />
                </button>
                <button type="button" className="icon-btn" disabled={i === effects.length - 1} aria-label={'Przesuń efekt ' + (i + 1) + ' niżej'} onClick={() => move(i, i + 1)}>
                  <ArrowDown size={14} />
                </button>
              </td>
              <td>{i + 1}</td>
              <td>
                <strong>{effect?.label ?? spec.type}</strong>
                <small>{effect?.group ?? 'Nieznany efekt'}</small>
                {effect && !isSupported(effect) && <small className="av2-error">Nieobsługiwany</small>}
              </td>
              <td>
                {effect ? (
                  <EffectParamsForm effect={effect} params={spec.params} onChange={(params) => onChange(effects.map((x, j) => (j === i ? { ...x, params } : x)))} />
                ) : (
                  <span className="av2-error">Efekt nie istnieje w katalogu — usuń go.</span>
                )}
              </td>
              <td>
                <button type="button" className="icon-btn" aria-label={'Usuń efekt ' + (i + 1)} onClick={() => onChange(effects.filter((_, j) => j !== i))}>
                  <X size={16} />
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
