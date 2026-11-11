// Editor footer: preview over today's orders, dry test on one order, and the rule's version log.
import { useEffect, useMemo, useState } from 'react';
import { ordersCountLabel } from './order-status-panel';
import { date } from './api';
import type { AutomationCatalog, AutomationRuleVersion, AutomationTestResult } from '../shared/automation-v2';
import { automationV2Api, errorText, type PreviewResult } from './automation-v2-api';
import { fieldMap, versionDiff } from './automation-v2-model';

const shown = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

export function RuleFooter({ catalog, ruleId, dirty, revision }: { catalog: AutomationCatalog; ruleId?: string; dirty: boolean; revision: number }) {
  const [preview, setPreview] = useState<PreviewResult | null>(null),
    [previewError, setPreviewError] = useState(''),
    [showSample, setShowSample] = useState(false),
    [number, setNumber] = useState(''),
    [testing, setTesting] = useState(false),
    [test, setTest] = useState<{ number: string; result: AutomationTestResult } | null>(null),
    [testError, setTestError] = useState('');
  const fields = useMemo(() => fieldMap(catalog), [catalog]);
  useEffect(() => {
    if (!ruleId) return;
    let live = true;
    setPreviewError('');
    automationV2Api
      .preview(ruleId)
      .then((p) => live && setPreview(p))
      .catch((e) => live && setPreviewError(errorText(e)));
    return () => {
      live = false;
    };
  }, [ruleId, revision]);

  async function runTest(order?: { id: string; number: string }) {
    if (!ruleId) return;
    setTesting(true);
    setTestError('');
    setTest(null);
    try {
      let target = order;
      if (!target) {
        const wanted = number.trim();
        const hits = await automationV2Api.findOrders(wanted);
        target = hits.find((o) => o.number.toLowerCase() === wanted.toLowerCase()) ?? (hits.length === 1 ? hits[0] : undefined);
        if (!target) throw new Error(hits.length ? 'Podaj pełny numer zamówienia — pasuje kilka zamówień.' : 'Nie znaleziono zamówienia ' + wanted + '.');
      }
      setTest({ number: target.number, result: await automationV2Api.test(ruleId, target.id) });
    } catch (e) {
      setTestError(errorText(e));
    } finally {
      setTesting(false);
    }
  }

  if (!ruleId) return <p className="av2-footer muted">Zapisz regułę, aby zobaczyć podgląd i przetestować ją na zamówieniu.</p>;
  return (
    <div className="av2-footer">
      <p role="status">
        {previewError
          ? 'Podgląd niedostępny: ' + previewError
          : preview
            ? 'Podgląd: warunki spełnia dziś ' + ordersCountLabel(preview.matching) + (dirty ? ' (dla zapisanej wersji)' : '') + '.'
            : 'Podgląd: liczę zamówienia…'}{' '}
        {preview && preview.sample.length > 0 && (
          <button type="button" className="text-button" aria-expanded={showSample} onClick={() => setShowSample(!showSample)}>
            {showSample ? 'Ukryj' : 'Pokaż'}
          </button>
        )}
      </p>
      {showSample && preview && (
        <ul className="av2-sample">
          {preview.sample.map((o) => (
            <li key={o.id}>
              {o.number}{' '}
              <button type="button" className="text-button" disabled={testing} onClick={() => void runTest(o)}>
                Testuj
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="av2-inline">
        <input aria-label="Numer zamówienia do testu" placeholder="Numer zamówienia" value={number} onChange={(e) => setNumber(e.target.value)} />
        <button type="button" className="button small-btn" disabled={testing || !number.trim()} onClick={() => void runTest()}>
          Testuj na zamówieniu
        </button>
        {dirty && <small className="muted">Test sprawdza zapisaną wersję reguły.</small>}
      </div>
      {testError && <p className="av2-error" role="alert">{testError}</p>}
      {test && (
        <div className="ops-result av2-test" aria-label="Wynik testu">
          <p role="status">
            <strong>{test.number}</strong>: {test.result.matched ? 'warunki spełnione' : 'warunki niespełnione'} · test nie zapisuje zmian.
          </p>
          <ul>
            {test.result.conditions.map((c) => (
              <li key={c.path} className={c.ok ? 'av2-ok' : 'av2-fail'}>
                {c.ok ? '✓' : '✗'} {fields.get(c.field)?.label ?? c.field} · wartość: {shown(c.actual)}
              </li>
            ))}
          </ul>
          {test.result.effects.length > 0 && (
            <>
              <strong>Efekty {test.result.matched ? '' : '(gdyby warunki były spełnione)'}</strong>
              <ol>
                {test.result.effects.map((e, i) => (
                  <li key={i}>
                    {catalog.effects.find((x) => x.type === e.type)?.label ?? e.type}: {e.would}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function RuleVersionsLog({ catalog, ruleId, revision }: { catalog: AutomationCatalog; ruleId: string; revision: number }) {
  const [versions, setVersions] = useState<AutomationRuleVersion[] | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setError('');
    automationV2Api
      .versions(ruleId)
      .then((v) => live && setVersions(v))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [ruleId, revision]);
  return (
    <section className="av2-section av2-log" aria-label="Log czynności akcji">
      <h3>Log czynności akcji</h3>
      {error && <p className="av2-error">{error}</p>}
      {!versions && !error && <p className="muted">Wczytuję…</p>}
      {versions && !versions.length && <p className="muted">Brak zapisanych wersji.</p>}
      <ol>
        {versions?.map((v) => {
          const d = versionDiff(v.before, v.after, catalog);
          const lines = [
            ...d.other,
            ...d.conditionsAdded.map((x) => '+ warunek: ' + x),
            ...d.conditionsRemoved.map((x) => '− warunek: ' + x),
            ...d.effectsAdded.map((x) => '+ efekt: ' + x),
            ...d.effectsRemoved.map((x) => '− efekt: ' + x),
          ];
          return (
            <li key={v.version}>
              <strong>
                v{v.version} · {v.actor} · {date(v.at)}
              </strong>
              {d.created && <span> · utworzono regułę</span>}
              {d.deleted && <span> · usunięto regułę</span>}
              {!d.created && !d.deleted && !lines.length && <span className="muted"> · bez zmian w treści</span>}
              {lines.length > 0 && (
                <ul>
                  {lines.map((l, i) => (
                    <li key={i} className={l.startsWith('+') ? 'av2-ok' : l.startsWith('−') ? 'av2-fail' : undefined}>
                      {l}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
