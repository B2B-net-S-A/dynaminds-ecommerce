import { useEffect, useId, useRef, useState } from 'react';
import {
  readScale,
  readScaleSettings,
  saveScaleSettings,
  scaleUnavailableReason,
  SCALE_BAUD_RATES,
  SCALE_COMMANDS,
  type ScaleSettings,
} from './scale-reader';
import { packingUnitText } from './packing-measurements-input';
import './scale-weight.css';

interface ScaleWeightButtonProps {
  /** Called once with whole grams, only for a stable reading. */
  onWeight: (grams: number) => void;
  disabled?: boolean;
  timeoutMs?: number;
}

type Status = { tone: 'idle' } | { tone: 'busy' } | { tone: 'ok' | 'error'; text: string };

/** "Pobierz z wagi" next to the manual weight input; the input stays the fallback. */
export function ScaleWeightButton({ onWeight, disabled = false, timeoutMs = 5000 }: ScaleWeightButtonProps) {
  const id = useId();
  const [settings, setSettings] = useState<ScaleSettings>(readScaleSettings);
  const [status, setStatus] = useState<Status>({ tone: 'idle' });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const unavailable = scaleUnavailableReason(settings);
  const busy = status.tone === 'busy';

  function update(patch: Partial<ScaleSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveScaleSettings(next);
    setStatus({ tone: 'idle' });
  }

  async function read() {
    if (disabled || busy || unavailable) return;
    setStatus({ tone: 'busy' });
    const result = await readScale(settings, timeoutMs);
    if (!alive.current) return;
    if (!result.ok) {
      setStatus({ tone: 'error', text: result.message });
      return;
    }
    setStatus({
      tone: 'ok',
      text: 'Pobrano z wagi: ' + packingUnitText(result.grams, 3) + ' kg (' + result.grams + ' g).',
    });
    onWeight(result.grams);
  }

  return (
    <div className="scale-weight">
      {unavailable ? (
        <p className="scale-weight-note">{unavailable}</p>
      ) : (
        <button
          type="button"
          className="scale-weight-read"
          disabled={disabled || busy}
          aria-describedby={status.tone === 'error' || status.tone === 'ok' ? id + '-status' : undefined}
          onClick={read}
        >
          {busy ? 'Czytam wagę…' : 'Pobierz z wagi'}
        </button>
      )}
      {status.tone === 'error' && (
        <p className="scale-weight-error" id={id + '-status'} role="alert">
          {status.text}
        </p>
      )}
      {status.tone === 'ok' && (
        <p className="scale-weight-ok" id={id + '-status'} role="status">
          {status.text}
        </p>
      )}
      <details className="scale-weight-settings">
        <summary>Ustawienia wagi</summary>
        <label>
          Źródło odczytu
          <select
            value={settings.source}
            disabled={busy}
            onChange={(e) => update({ source: e.target.value === 'bridge' ? 'bridge' : 'serial' })}
          >
            <option value="serial">Ta przeglądarka (Web Serial)</option>
            <option value="bridge">Mostek wagi (localhost)</option>
          </select>
        </label>
        {settings.source === 'serial' ? (
          <>
            <label>
              Prędkość transmisji
              <select
                value={settings.baudRate}
                disabled={busy}
                onChange={(e) => update({ baudRate: Number(e.target.value) })}
              >
                {SCALE_BAUD_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate} bd
                  </option>
                ))}
              </select>
            </label>
            <label>
              Format ramki
              <select
                value={settings.frame}
                disabled={busy}
                onChange={(e) => update({ frame: e.target.value === '7E1' ? '7E1' : '8N1' })}
              >
                <option value="8N1">8N1 (8 bitów)</option>
                <option value="7E1">7E1 (7 bitów, parzystość)</option>
              </select>
            </label>
            <label>
              Polecenie odczytu
              <select value={settings.command} disabled={busy} onChange={(e) => update({ command: e.target.value })}>
                {SCALE_COMMANDS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <label>
            Adres mostka
            <input
              type="url"
              value={settings.bridgeUrl}
              disabled={busy}
              autoComplete="off"
              onChange={(e) => update({ bridgeUrl: e.target.value.trim() })}
            />
          </label>
        )}
        <p className="scale-weight-help">
          Ustawienia są zapamiętane tylko w tej przeglądarce. Masa jest wpisywana tylko przy stabilnym
          odczycie; przed zapisem sprawdź ją w polu masy.
        </p>
      </details>
    </div>
  );
}
