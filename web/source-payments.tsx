import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RefreshCw, Wallet } from 'lucide-react';
import { api, money, date } from './api';
const states: Record<string, string> = {
  review: 'Do potwierdzenia',
  applied: 'Zapisano wpłatę',
  unchanged: 'Bez nowej wpłaty',
  blocked: 'Do uzgodnienia',
};
export function SourcePaymentsPanel({ order, onChanged, readOnly = false }: { order: any; onChanged: () => void; readOnly?: boolean }) {
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const [data, setData] = useState<any>(null),
    [config, setConfig] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [showConfig, setShowConfig] = useState(false),
    [confirm, setConfirm] = useState('');
  const [enabled, setEnabled] = useState(false),
    [interval, setInterval] = useState(300),
    [external, setExternal] = useState(false);
  const [exampleAmount, setExampleAmount] = useState('');
  async function load() {
    const [d, c] = await Promise.all([
      api('/orders/' + order.id + '/source-payments'),
      api('/integrations/' + order.channel_id + '/payment-sync'),
    ]);
    setData(d);
    setConfig(c.config);
    setEnabled(c.config?.enabled ?? false);
    setInterval(c.config?.interval_seconds ?? 300);
  }
  useEffect(() => {
    let active = true;
    load().catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [order.id, order.version]);
  async function run(fn: () => Promise<void>, localRead = false) {
    if (readOnlyRef.current && !localRead) return;
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await api('/integrations/' + order.channel_id + '/payment-sync', 'PATCH', {
        version: config?.version ?? 0,
        enabled,
        interval_seconds: interval,
        confirm_external: external,
      });
      setShowConfig(false);
    });
  }
  if (!data)
    return error ? (
      <p role="alert" className="notice error">
        {error}
      </p>
    ) : null;
  return (
    <section className="panel source-payments-panel">
      <div className="panel-heading">
        <h2>
          <Wallet size={18} /> Płatność w kanale sprzedaży
        </h2>
        <span>{data.channel?.name}</span>
      </div>
      <div className="shipping-body">
        {readOnly && <p className="muted">Podgląd zapisanej historii. Odczyt API dostawcy i zapisy płatności są wyłączone.</p>}
        <p className="muted">
          Odczyt API sprawdza deklarację wpłaty. Potwierdzenie zapisuje wyłącznie nową różnicę; nie
          pobiera pieniędzy. Ręczne wpłaty i spadek kwoty wymagają uzgodnienia.
        </p>
        <p>
          Uwzględniono ze źródła: <strong>{money(data.totals.amount, order.currency)}</strong> ·
          harmonogram kanału: <strong>{config?.enabled ? 'włączony' : 'wyłączony'}</strong>.
        </p>
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        {config?.error && <p className="notice error">{config.error}</p>}
        <div className="inline-actions">
          <button
            className="button"
            disabled={readOnly || busy || ['pending', 'running'].includes(data.job?.state)}
            onClick={() =>
              run(async () => {
                await api('/orders/' + order.id + '/source-payments/read', 'POST', {});
              })
            }
          >
            <RefreshCw size={16} /> Odczytaj płatność
          </button>
          <button className="button" disabled={busy} onClick={() => run(async () => {}, true)}>
            Odśwież płatność kanału
          </button>
          <button className="button" disabled={busy} onClick={() => setShowConfig(!showConfig)}>
            Harmonogram płatności
          </button>
        </div>
        {data.channel?.simulation && (
          <p className="muted">Przykład lokalny — bez żądań do dostawcy.</p>
        )}
        {data.channel?.simulation && (
          <form
            className="inline-actions"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const text = exampleAmount.replace(',', '.');
                if (!/^\d+(\.\d{1,2})?$/.test(text))
                  throw Error('Wpisz kwotę z maksymalnie dwoma miejscami po przecinku');
                const [whole, fraction = ''] = text.split('.');
                await api('/orders/' + order.id + '/source-payments/example', 'POST', {
                  amount: Number(whole) * 100 + Number(fraction.padEnd(2, '0')),
                });
              });
            }}
          >
            <label>
              Kwota wpłat w źródle DEMO ({order.currency})
              <input
                disabled={readOnly}
                type="text"
                inputMode="decimal"
                value={exampleAmount}
                onChange={(e) => setExampleAmount(e.target.value)}
                required
              />
            </label>
            <button className="button" disabled={readOnly || busy}>
              Ustaw kwotę DEMO w źródle
            </button>
          </form>
        )}
        {data.job && (
          <p className="muted">
            Ostatni odczyt:{' '}
            {
              (
                {
                  pending: 'oczekuje',
                  running: 'w toku',
                  done: 'zakończony',
                  failed: 'błąd',
                } as Record<string, string>
              )[data.job.state]
            }
            {data.job.error ? ' · ' + data.job.error : ''}
          </p>
        )}
        {showConfig && (
          <form className="payment-form" onSubmit={save}>
            <p>
              Dotyczy zaimportowanych przedpłat tego kanału z ostatnich 90 dni. Partie po 25
              zamówień, maksymalnie 100 aktywnych odczytów. Nowe deklaracje wpłat są zapisywane
              automatycznie.
            </p>
            <label className="checkbox-label">
              <input
                disabled={readOnly}
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />{' '}
              Włącz automatyczne płatności kanału
            </label>
            <label>
              Odstęp między pełnymi przeglądami (sekundy)
              <input
                disabled={readOnly}
                type="number"
                min="60"
                max="86400"
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value))}
                required
              />
            </label>
            {!data.channel?.simulation && enabled && (
              <label className="checkbox-label">
                <input
                  disabled={readOnly}
                  type="checkbox"
                  checked={external}
                  onChange={(e) => setExternal(e.target.checked)}
                  required
                />{' '}
                Potwierdzam cykliczny odczyt API i zapisy deklaracji wpłat
              </label>
            )}
            <button className="button primary" disabled={readOnly || busy}>
              Zapisz harmonogram płatności
            </button>
          </form>
        )}
        {!data.data.length && <p className="muted">Nie wykonano jeszcze odczytu płatności.</p>}
        {data.data.map((p: any) => (
          <article className="source-payment-check" key={p.id}>
            <div>
              <strong>{states[p.state]}</strong>
              <p className="muted">
                {date(p.created_at)} · {p.basis || 'Kontrola zgodności źródła'}
              </p>
              {p.seen_count > 1 && (
                <p className="muted">
                  Ostatnia kontrola: {date(p.last_seen_at)} · {p.seen_count} zgodnych odczytów
                </p>
              )}
              {p.source_amount !== null && (
                <p>
                  W źródle: {money(p.source_amount, p.currency)} · poprzednio:{' '}
                  {money(p.previous_amount, p.currency)} · różnica:{' '}
                  <strong>{money(p.delta, p.currency)}</strong>
                </p>
              )}
              {p.reason && <p className="notice error">{p.reason}</p>}
            </div>
            {p.state === 'review' && (
              <div>
                <label className="checkbox-label">
                  <input
                    disabled={readOnly}
                    type="checkbox"
                    checked={confirm === p.id}
                    onChange={(e) => setConfirm(e.target.checked ? p.id : '')}
                  />{' '}
                  Potwierdzam nową wpłatę z kanału
                </label>
                <button
                  className="button primary"
                  disabled={readOnly || busy || confirm !== p.id}
                  onClick={() =>
                    run(async () => {
                      await api('/source-payment-checks/' + p.id + '/apply', 'POST', {
                        version: Number(p.order_version),
                        confirmed: true,
                      });
                      setConfirm('');
                      onChanged();
                    })
                  }
                >
                  Zapisz wpłatę ze źródła
                </button>
              </div>
            )}
          </article>
        ))}
        <p className="muted">
          Ostatnie 25 odczytów tego zamówienia. Rozliczenia banku, kuriera i automatyczne refundacje
          pozostają osobnymi procesami.
        </p>
      </div>
    </section>
  );
}
