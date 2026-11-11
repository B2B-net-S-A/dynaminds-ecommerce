import { useEffect, useState } from 'react';
import { api } from './api';
import { channelText, RunChannelResults } from './repricing-channel';
const stateName = (s: string) =>
  ({
    queued: 'W kolejce',
    success: 'Zakończony',
    failed: 'Błąd',
    partial: 'Częściowy',
    cancelled: 'Anulowany',
  })[s] ?? s;
export function RepricingSchedulePanel({
  listId,
  rule,
  admin,
  onRefresh,
}: {
  listId: string;
  rule: any;
  admin: boolean;
  onRefresh: () => Promise<void>;
}) {
  const root = '/price-lists/' + listId + '/repricing',
    [data, setData] = useState<any>(null),
    [history, setHistory] = useState<any>({ data: [], meta: {} }),
    [detail, setDetail] = useState<any>(null),
    [runState, setRunState] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const runs = (after?: string) => {
    const q = new URLSearchParams();
    if (runState) q.set('state', runState);
    if (after) q.set('after', after);
    const t = q.toString();
    return root + '/runs' + (t ? '?' + t : '');
  };
  async function load() {
    setData(await api(root + '/schedule'));
    setHistory(await api(runs()));
  }
  useEffect(() => {
    let active = true;
    Promise.all([api(root + '/schedule'), api(runs())])
      .then(([d, h]) => {
        if (active) {
          setData(d);
          setHistory(h);
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [root, rule.version, runState]);
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
  if (!data) return <p>Wczytywanie harmonogramu repricingu…</p>;
  const cfg = data.schedule;
  return (
    <details open className="repricing-panel">
      <summary>
        <strong>Automatyczny repricing</strong>
        {cfg && (
          <span className="muted">
            {' '}
            · {cfg.enabled ? 'aktywny' : 'wyłączony'} · wersja {cfg.version}
          </span>
        )}
      </summary>
      <p className="muted">
        {data.purpose==='collection_only'?'Harmonogram zbiera obserwacje Shopify bez zmian cen.':data.purpose==='collect_then_reprice'?'Harmonogram zbiera obserwacje Shopify, potem wykonuje lokalny repricing z istniejącymi limitami.':'Automatyczne zmiany cen wszystkich SKU z kosztami w tym cenniku.'} Przerwa liczona od zakończenia; bez nakładających się przebiegów. Powiązane kanały korzystają z własnej synchronizacji. Źródła i tryb zbierania konfigurujesz w panelu obserwacji konkurencji.
      </p>
      {error && (
        <p role="alert" className="error-block">
          {error}
        </p>
      )}
      {cfg?.error && <p className="error-block">{cfg.error}</p>}
      {admin && (
        <form
          className="form-grid"
          key={(cfg?.version ?? 0) + ':' + rule.config_version}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            run(async () => {
              await api(root + '/schedule', 'PUT', {
                version: cfg?.version ?? 0,
                enabled: f.get('enabled') === 'on',
                rule_config_version: rule.config_version,
                interval_minutes: Number(f.get('interval')),
                batch_size: Number(f.get('batch')),
                confirmed: f.get('confirmed') === 'on',
              });
              setDetail(null);
              await load();
            });
          }}
        >
          <label className="warehouse-check">
            <input type="checkbox" name="enabled" defaultChecked={cfg?.enabled ?? false} />
            Włącz harmonogram repricingu
          </label>
          <label>
            Przerwa po zakończeniu (minuty)
            <input
              name="interval"
              type="number"
              min="5"
              max="10080"
              defaultValue={cfg?.interval_minutes ?? 30}
              required
            />
          </label>
          <label>
            SKU w partii
            <input
              name="batch"
              type="number"
              min="1"
              max="200"
              defaultValue={cfg?.batch_size ?? 100}
              required
            />
          </label>
          <label className="warehouse-check">
            <input type="checkbox" name="confirmed" />
            Potwierdzam automatyczne zmiany cen w tym cenniku
          </label>
          <button className="button primary" disabled={busy}>
            Zapisz harmonogram repricingu
          </button>
        </form>
      )}
      {cfg && (
        <p className="muted">
          Następny przebieg:{' '}
          {cfg.last_state === 'queued'
            ? 'po zakończeniu bieżącego'
            : cfg.next_at
              ? new Date(cfg.next_at).toLocaleString('pl-PL')
              : '—'}
          {cfg.last_state && (
            <>
              {' '}
              · ostatni: {stateName(cfg.last_state)} · {cfg.last_scanned ?? 0} sprawdzonych /{' '}
              {cfg.last_changed ?? 0} zmian / {cfg.last_blocked ?? 0} blokad
            </>
          )}
        </p>
      )}
      <div className="toolbar-actions">
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await load();
              await onRefresh();
              if (detail) setDetail(await api('/repricing-runs/' + detail.run.id));
            })
          }
        >
          Odśwież wykonania repricingu
        </button>
        {admin && cfg?.enabled && (
          <button
            className="button"
            disabled={busy || cfg.last_state === 'queued'}
            onClick={() =>
              run(async () => {
                const r = await api(root + '/schedule/run', 'POST', {
                  version: cfg.version,
                  client_key: crypto.randomUUID(),
                });
                setDetail(await api('/repricing-runs/' + r.id));
                await load();
              })
            }
          >
            Przelicz cennik teraz
          </button>
        )}
      </div>
      <h3>Przebiegi automatu</h3>
      <p className="muted">
        Zatrzymanie nie cofa już zapisanych partii. Błędna partia jest pomijana w całości;
        wcześniejsze zmiany pozostają widoczne w historii. Najnowsze przebiegi są na górze.
      </p>
      <label>
        Stan przebiegu
        <select value={runState} disabled={busy} onChange={(e) => setRunState(e.target.value)}>
          <option value="">Wszystkie</option>
          {['queued', 'success', 'failed', 'partial', 'cancelled'].map((v) => (
            <option key={v} value={v}>
              {stateName(v)}
            </option>
          ))}
        </select>
      </label>
      {!history.data.length && <p className="muted">Brak przebiegów dla wybranego stanu.</p>}
      {history.data.map((r: any) => (
        <p key={r.id}>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => run(async () => setDetail(await api('/repricing-runs/' + r.id)))}
          >
            {new Date(r.created_at).toLocaleString('pl-PL')} · {stateName(r.state)} · {r.scanned}/
            {r.total} SKU · {r.changed} zmian
          </button>
          {r.changed > 0 && <small> · {channelText(r.channel)}</small>}
        </p>
      ))}
      {history.meta.cursor && (
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const h = await api(runs(history.meta.cursor));
              setHistory({ ...h, data: [...history.data, ...h.data] });
            })
          }
        >
          Kolejne przebiegi repricingu
        </button>
      )}
      {detail && (
        <section aria-label="Wykonanie repricingu">
          <h3>Wykonanie · {stateName(detail.run.state)}</h3>
          <p role="status">
            {detail.run.scanned}/{detail.run.total} SKU · {detail.run.changed} zmienionych ·{' '}
            {detail.run.unchanged} bez zmian · {detail.run.blocked} zablokowanych ·{' '}
            {detail.run.skipped} pominiętych (błędna partia lub wykluczone ręcznie)
          </p>
          <RunChannelResults key={detail.run.id} runId={detail.run.id} write={admin} />
          {detail.run.error && <p className="error-block">{detail.run.error}</p>}
          {admin && detail.run.state === 'queued' && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api('/repricing-runs/' + detail.run.id + '/cancel', 'POST', {
                    confirmed: true,
                  });
                  setDetail(await api('/repricing-runs/' + detail.run.id));
                  await load();
                  await onRefresh();
                })
              }
            >
              Zatrzymaj ten przebieg
            </button>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Partia</th>
                  <th>SKU</th>
                  <th>Zmiany / blokady</th>
                  <th>Cennik</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.map((p: any) => (
                  <tr key={p.id}>
                    <td>
                      {p.state === 'applied' ? 'Zastosowana' : 'Zablokowana'}
                      <small>{new Date(p.created_at).toLocaleString('pl-PL')}</small>
                    </td>
                    <td>{p.result.length}</td>
                    <td>
                      {p.state === 'applied'
                        ? p.result.filter((i: any) => i.state === 'change').length
                        : 0}{' '}
                      / {p.result.filter((i: any) => i.state === 'blocked').length}
                    </td>
                    <td>
                      v{p.list_version} →{' '}
                      {p.applied_list_version ? 'v' + p.applied_list_version : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {detail.meta.cursor && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const d = await api(
                    '/repricing-runs/' + detail.run.id + '?after=' + detail.meta.cursor,
                  );
                  setDetail({ ...d, data: [...detail.data, ...d.data] });
                })
              }
            >
              Kolejne partie repricingu
            </button>
          )}
        </section>
      )}
    </details>
  );
}
