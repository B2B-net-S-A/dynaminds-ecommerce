// "Uruchom akcję ▾": manual v2 rules (run.manual_button) for the order list bulk bar and the order card.
import { useEffect, useRef, useState } from 'react';
import { automationV2Api, errorText, type ManualRule } from './automation-v2-api';
import { runResultText } from './automation-v2-model';
import './automation-v2.css';

export interface ManualAutomationButtonsProps {
  orderIds: string[];
  /** Called after a run finished (refresh the list or the card). */
  onDone?: () => void;
  /** Toast callback; without it the result is shown inline next to the button. */
  notify?: (message: string, error?: boolean) => void;
  disabled?: boolean;
}

export function ManualAutomationButtons({ orderIds, onDone, notify, disabled }: ManualAutomationButtonsProps) {
  const single = orderIds.length === 1 ? orderIds[0] : undefined;
  const [rules, setRules] = useState<ManualRule[] | null>(null),
    [loadError, setLoadError] = useState(''),
    [open, setOpen] = useState(false),
    [running, setRunning] = useState<string | null>(null),
    [result, setResult] = useState<{ text: string; error: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    setLoadError('');
    automationV2Api
      .manual(single)
      .then((r) => live && setRules(r))
      .catch((e) => {
        if (!live) return;
        setRules([]);
        setLoadError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [single]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  async function run(rule: ManualRule) {
    if (running || !orderIds.length) return;
    setOpen(false);
    setRunning(rule.id);
    setResult(null);
    let outcome: { text: string; error: boolean };
    try {
      outcome = runResultText(rule.name, await automationV2Api.run(rule.id, orderIds));
    } catch (e) {
      outcome = { text: '„' + rule.name + '”: ' + errorText(e), error: true };
    }
    setRunning(null);
    if (notify) notify(outcome.text, outcome.error);
    else setResult(outcome);
    onDone?.();
  }

  if (loadError) return <span className="av2-error av2-manual-error">Akcje ręczne niedostępne: {loadError}</span>;
  if (!rules?.length) return null;
  const groups = [...new Set(rules.map((r) => r.group || 'Bez grupy'))];
  return (
    <div className="av2-manual" ref={box} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        className="button small-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || !!running || !orderIds.length}
        onClick={() => setOpen(!open)}
      >
        {running ? 'Uruchamiam…' : 'Uruchom akcję ▾'}
      </button>
      {open && (
        <div className="av2-manual-menu" role="menu" aria-label="Akcje ręczne">
          {groups.map((g) => (
            <div key={g} role="group" aria-label={g}>
              <strong className="av2-picker-group">{g}</strong>
              {rules
                .filter((r) => (r.group || 'Bez grupy') === g)
                .map((r) => (
                  <button type="button" role="menuitem" key={r.id} onClick={() => void run(r)}>
                    {r.name}
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}
      {result && (
        <span className={result.error ? 'av2-error' : 'av2-ok'} role="status">
          {result.text}
        </span>
      )}
    </div>
  );
}
