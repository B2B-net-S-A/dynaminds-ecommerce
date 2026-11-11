import { EmailActionReceipts } from './email-action';
import { useEffect, useRef, useState } from 'react';
import { api, date, statusNames } from './api';
import { ActionEditor, ConditionEditor } from './operations';
import { SmsActionReceipts } from './sms-action';
const states: Record<string, string> = {
  queued: 'W kolejce',
  done: 'Zakończono',
  failed: 'Błąd',
  cancelled: 'Zatrzymano',
  skipped: 'Pominięto',
};
const weekdays = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Nd'];
const empty = () =>
  ({
    name: '',
    enabled: false,
    frequency: { kind: 'interval', seconds: 3600 },
    statuses: ['new'],
    min_age_seconds: 86400,
    repetition: 'once_per_version',
    match: 'all',
    conditions: [],
    actions: [{ type: 'add_tag', tag: '' }],
    client_key: crypto.randomUUID(),
  }) as any;
// A response belongs to one selected resource and cursor. Changing pages must
// never display the preceding page while its replacement is pending or failed.
function useHistoryPage(route: string | null, refresh: number, poll: number) {
  const [page, setPage] = useState<{ route: string; value: any } | null>(null);
  const [failure, setFailure] = useState<{ route: string; message: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!route) return;
    let live = true;
    setPending(route);
    setFailure(null);
    api(route)
      .then((value) => live && setPage({ route, value }))
      .catch((e) => {
        if (live) {
          setPage(null);
          setFailure({ route, message: (e as Error).message });
        }
      })
      .finally(() => live && setPending(null));
    return () => { live = false; };
  }, [route, refresh, poll, revision]);
  return {
    data: page?.route === route ? page.value : null,
    error: failure?.route === route ? failure.message : '',
    loading: !!route && (pending === route || page?.route !== route && failure?.route !== route),
    retry() { setPage(null); setFailure(null); setRevision((n) => n + 1); },
  };
}
export function AutomationSchedules({
  admin,
  readOnly = false,
  refresh,
  reload,
}: {
  admin: boolean;
  readOnly?: boolean;
  refresh: number;
  reload: () => void;
}) {
  const writeAccess = useRef(false), writeEpoch = useRef(0), writeBusy = useRef(false), mounted = useRef(true);
  const access = useRef({ admin, readOnly });
  if (access.current.admin !== admin || access.current.readOnly !== readOnly) {
    access.current = { admin, readOnly };
    writeEpoch.current++;
    writeBusy.current = false;
  }
  writeAccess.current = admin && !readOnly;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; writeEpoch.current++; }; }, []);
  const [data, setData] = useState<any[]>([]),
    [statuses, setStatuses] = useState<any[]>([]),
    [warehouses, setWarehouses] = useState<any[]>([]),
    [draft, setDraft] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<any>(null),
    [selected, setSelected] = useState<any>(null),
    [runCursor, setRunCursor] = useState(''),
    [run, setRun] = useState<any>(null),
    [itemCursor, setItemCursor] = useState(''),
    [local, setLocal] = useState(0),
    [queueKey, setQueueKey] = useState('');
  useEffect(() => {
    const timer = setInterval(() => setLocal((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let live = true;
    Promise.all([api('/automation-schedules'), api('/workflow-statuses'), api('/settings')])
      .then(([s, w, t]) => {
        if (live) {
          setData(s.data);
          setStatuses(w.data);
          setWarehouses(t.warehouses);
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [refresh, local]);
  const history = useHistoryPage(selected
    ? '/automation-schedules/' + selected.id + '/runs?' + new URLSearchParams(runCursor ? { after: runCursor } : {})
    : null, refresh, local);
  const details = useHistoryPage(run
    ? '/automation-schedule-runs/' + run.id + '?' + new URLSearchParams(itemCursor ? { after: itemCursor } : {})
    : null, refresh, local);
  const runs = history.data, runDetails = details.data, runView = runDetails ?? run;
  useEffect(() => {
    if (!admin || readOnly) { setDraft(null); setPreview(null); setQueueKey(''); }
    setBusy(false);
  }, [admin, readOnly]);
  async function perform(fn: (current: () => boolean) => Promise<void>) {
    if (!mounted.current || !writeAccess.current || writeBusy.current) return;
    const epoch = writeEpoch.current;
    const current = () => mounted.current && writeAccess.current && writeEpoch.current === epoch;
    writeBusy.current = true;
    setBusy(true);
    setError('');
    try {
      await fn(current);
      if (!current()) return;
      setLocal((n) => n + 1);
      reload();
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      if (writeEpoch.current === epoch) { writeBusy.current = false; setBusy(false); }
    }
  }
  const editArray = (key: string, i: number, value: any) =>
    setDraft({ ...draft, [key]: draft[key].map((v: any, j: number) => (i === j ? value : v)) });
  return (
    <section className="panel ops-panel schedule-panel">
      {readOnly && <p className="notice" role="status">Kopia odtworzona · tylko odczyt. Harmonogramy i historia pozostają dostępne; zapis, podgląd i uruchamianie są wyłączone.</p>}
      <div className="panel-heading">
        <div>
          <h2>Harmonogramy zamówień</h2>
          <p>Cyklicznie wybieraj zamówienia i wykonuj akcje w partiach.</p>
        </div>
        {admin && (
          <button
            className="button primary"
            disabled={busy || readOnly}
            onClick={() => {
              if (!writeAccess.current) return;
              setDraft(empty());
              setPreview(null);
              setError('');
            }}
          >
            Nowy harmonogram
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {draft && admin && !readOnly && (
        <form
          className="rule-editor"
          onSubmit={(e) => {
            e.preventDefault();
            perform(async (current) => {
              const { id, version, ...input } = draft;
              await api(
                '/automation-schedules' + (id ? '/' + id : ''),
                id ? 'PATCH' : 'POST',
                id ? { ...input, version } : input,
              );
              if (!current()) return;
              setDraft(null);
              setPreview(null);
            });
          }}
        >
          <div className="form-grid">
            <label>
              Nazwa harmonogramu
              <input
                required
                minLength={2}
                maxLength={120}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              Częstotliwość
              <select
                value={draft.frequency.kind}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    frequency:
                      e.target.value === 'interval'
                        ? { kind: 'interval', seconds: 3600 }
                        : {
                            kind: 'daily',
                            time: '09:00',
                            timezone: 'Europe/Warsaw',
                            weekdays: [1, 2, 3, 4, 5],
                          },
                  })
                }
              >
                <option value="interval">Co określony czas</option>
                <option value="daily">Godzina i dni tygodnia</option>
              </select>
            </label>
            {draft.frequency.kind === 'interval' ? (
              <label>
                Interwał w sekundach
                <input
                  type="number"
                  min={60}
                  max={604800}
                  required
                  value={draft.frequency.seconds}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      frequency: { ...draft.frequency, seconds: Number(e.target.value) },
                    })
                  }
                />
              </label>
            ) : (
              <>
                <label>
                  Godzina lokalna
                  <input
                    type="time"
                    required
                    value={draft.frequency.time}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        frequency: { ...draft.frequency, time: e.target.value },
                      })
                    }
                  />
                </label>
                <label>
                  Strefa czasowa
                  <input
                    required
                    maxLength={80}
                    value={draft.frequency.timezone}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        frequency: { ...draft.frequency, timezone: e.target.value },
                      })
                    }
                  />
                </label>
              </>
            )}
            <label>
              Minimalny wiek od utworzenia (godziny)
              <input
                type="number"
                min={0}
                max={8760}
                step="0.01"
                required
                value={draft.min_age_seconds / 3600}
                onChange={(e) =>
                  setDraft({ ...draft, min_age_seconds: Math.round(Number(e.target.value) * 3600) })
                }
              />
            </label>
            <label>
              Powtarzanie
              <select
                value={draft.repetition}
                onChange={(e) => setDraft({ ...draft, repetition: e.target.value })}
              >
                <option value="once_per_version">Raz na zamówienie i definicję</option>
                <option value="each_run">Przy każdym wykonaniu</option>
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
              Włącz automatyczne wykonania
            </label>
          </div>
          {draft.frequency.kind === 'daily' && (
            <div className="schedule-checks">
              {weekdays.map((day, i) => (
                <label className="check" key={day}>
                  <input
                    type="checkbox"
                    checked={draft.frequency.weekdays.includes(i + 1)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        frequency: {
                          ...draft.frequency,
                          weekdays: e.target.checked
                            ? [...draft.frequency.weekdays, i + 1].sort()
                            : draft.frequency.weekdays.filter((n: number) => n !== i + 1),
                        },
                      })
                    }
                  />
                  {day}
                </label>
              ))}
            </div>
          )}
          <h3>Etapy do sprawdzenia</h3>
          <div className="schedule-checks">
            {Object.entries(statusNames).map(([id, n]) => (
              <label className="check" key={id}>
                <input
                  type="checkbox"
                  checked={draft.statuses.includes(id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      statuses: e.target.checked
                        ? [...draft.statuses, id]
                        : draft.statuses.filter((s: string) => s !== id),
                    })
                  }
                />
                {n}
              </label>
            ))}
          </div>
          <h3>Dodatkowe warunki</h3>
          <select
            aria-label="Łączenie warunków harmonogramu"
            value={draft.match}
            onChange={(e) => setDraft({ ...draft, match: e.target.value })}
          >
            <option value="all">Wszystkie (AND)</option>
            <option value="any">Dowolny (OR)</option>
          </select>
          {draft.conditions.map((v: any, i: number) => (
            <div className="ops-editor-row" key={i}>
              <ConditionEditor
                totalLabel="walucie zamówienia"
                value={v}
                onChange={(n) => editArray('conditions', i, n)}
                statuses={statuses}
                warehouses={warehouses}
              />
              <button
                type="button"
                className="button"
                onClick={() =>
                  setDraft({
                    ...draft,
                    conditions: draft.conditions.filter((_: any, j: number) => j !== i),
                  })
                }
              >
                Usuń warunek
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button"
            disabled={draft.conditions.length >= 10}
            onClick={() =>
              setDraft({
                ...draft,
                conditions: [...draft.conditions, { field: 'source', op: 'eq', value: 'manual' }],
              })
            }
          >
            Dodaj warunek
          </button>
          <h3>Akcje w kolejności</h3>
          {draft.actions.map((v: any, i: number) => (
            <div className="ops-editor-row" key={i}>
              <ActionEditor
                value={v}
                onChange={(n) => editArray('actions', i, n)}
                statuses={statuses}
              />
              <button
                type="button"
                className="button"
                disabled={draft.actions.length === 1}
                onClick={() =>
                  setDraft({
                    ...draft,
                    actions: draft.actions.filter((_: any, j: number) => j !== i),
                  })
                }
              >
                Usuń akcję
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button"
            disabled={draft.actions.length >= 5}
            onClick={() =>
              setDraft({ ...draft, actions: [...draft.actions, { type: 'add_tag', tag: '' }] })
            }
          >
            Dodaj akcję
          </button>
          <p>
            Włączenie uruchamia akcje automatycznie. Edycja definicji pozwoli ponownie objąć
            wcześniejsze zamówienia. Wiek liczony od utworzenia. Kwoty dotyczą waluty zamówienia;
            dodaj warunek waluty, aby ograniczyć porównanie.
          </p>
          <div className="ops-buttons">
            <button className="button primary" disabled={busy || readOnly || !admin}>
              Zapisz harmonogram
            </button>
            <button className="button" type="button" onClick={() => setDraft(null)}>
              Zamknij
            </button>
          </div>
        </form>
      )}
      {!data.length && !draft && (
        <p>Brak harmonogramów. Utwórz np. oznaczanie zamówień oczekujących ponad dobę.</p>
      )}
      <div className="rule-grid">
        {data.map((s) => (
          <article className="rule-card" key={s.id}>
            <div className="rule-header">
              <h3>{s.name}</h3>
              <span className="badge">{s.enabled ? 'Włączony' : 'Wyłączony'}</span>
            </div>
            <p>
              {s.definition.frequency.kind === 'interval'
                ? 'Co ' + s.definition.frequency.seconds + ' s'
                : s.definition.frequency.time +
                  ' · ' +
                  s.definition.frequency.timezone +
                  ' · ' +
                  s.definition.frequency.weekdays.map((n: number) => weekdays[n - 1]).join(', ')}
            </p>
            <p>
              {s.definition.statuses.map((v: string) => statusNames[v]).join(', ')} · od{' '}
              {s.definition.min_age_seconds / 3600} h
            </p>
            <p>
              {s.definition.repetition === 'once_per_version'
                ? 'Raz na zamówienie i definicję'
                : 'Każde wykonanie'}{' '}
              · definicja {s.definition_version}
            </p>
            {s.error && <p className="error">{s.error}</p>}
            <small>
              Następne: {s.next_at ? date(s.next_at) : '—'} · ostatnio:{' '}
              {states[s.last_state] ?? '—'} · wykonano {s.last_done ?? 0}, błędów{' '}
              {s.last_failed ?? 0}
            </small>
            <div className="ops-buttons">
              {admin && (
                <>
                  <button
                    className="button"
                    disabled={busy || readOnly}
                    onClick={() => {
                      if (!writeAccess.current) return;
                      setDraft({ id: s.id, version: s.version, ...s.definition });
                      setPreview(null);
                    }}
                  >
                    Edytuj harmonogram
                  </button>
                  <button
                    className="button"
                    disabled={busy || readOnly}
                    onClick={() =>
                      perform(async (current) => {
                        await api('/automation-schedules/' + s.id, 'PATCH', {
                          version: s.version,
                          enabled: !s.enabled,
                        });
                        if (!current()) return;
                        setPreview(null);
                      })
                    }
                  >
                    {s.enabled ? 'Wyłącz' : 'Włącz'}
                  </button>
                  <button
                    className="button"
                    disabled={busy || readOnly}
                    onClick={() =>
                      perform(async (current) => {
                        const p = await api(
                          '/automation-schedules/' + s.id + '/preview',
                          'POST',
                          {},
                        );
                        if (!current()) return;
                        setPreview({ ...p, schedule: s });
                        setQueueKey(crypto.randomUUID());
                      })
                    }
                  >
                    Podgląd zamówień
                  </button>
                </>
              )}
              <button
                className="button"
                onClick={() => {
                  setSelected(s);
                  history.retry();
                  setRunCursor('');
                  setRun(null);
                }}
              >
                Historia harmonogramu
              </button>
            </div>
          </article>
        ))}
      </div>
      {preview && admin && !readOnly && (
        <div className="schedule-detail">
          <h3>Podgląd: {preview.schedule.name}</h3>
          <p>
            Pierwsze 25 kandydatów według wieku i etapu;{' '}
            {preview.meta.more_candidates ? 'są dalsze strony' : 'koniec bieżącej listy'}. Wykonanie
            sprawdzi wszystkie pasujące zamówienia i ponownie oceni warunki.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Zamówienie</th>
                  <th>Etap</th>
                  <th>Warunki i akcje</th>
                </tr>
              </thead>
              <tbody>
                {preview.data.map((i: any) => (
                  <tr key={i.order_id}>
                    <td>{i.number}</td>
                    <td>{statusNames[i.snapshot.status]}</td>
                    <td>
                      {i.allowed ? 'Gotowe' : i.error}
                      <SmsActionReceipts actions={i.result} preview />
                      <EmailActionReceipts actions={i.result} preview />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            className="button primary"
            disabled={busy || readOnly || !admin || !preview.schedule.enabled}
            onClick={() =>
              perform(async (current) => {
                const r = await api(
                  '/automation-schedules/' + preview.schedule.id + '/run',
                  'POST',
                  { version: preview.schedule.version, client_key: queueKey, confirmed: true },
                );
                if (!current()) return;
                setSelected(preview.schedule);
                setRun(r);
                details.retry();
                history.retry();
                setRunCursor('');
                setItemCursor('');
                setPreview(null);
              })
            }
          >
            Uruchom teraz dla wszystkich pasujących
          </button>{' '}
          <button className="button" onClick={() => setPreview(null)}>
            Zamknij podgląd
          </button>
        </div>
      )}
      {selected && (
        <div className="schedule-detail">
          <h3>Historia: {selected.name}</h3>
          {history.loading && <p role="status">Wczytywanie strony historii…</p>}
          {history.error && <><p role="alert">Nie udało się odczytać tej strony historii: {history.error}</p>
            <button className="button" onClick={() => history.retry()}>Ponów odczyt historii</button></>}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Termin</th>
                  <th>Wynik</th>
                  <th>Sprawdzono / wykonano / pominięto / błędy</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs?.data.map((r: any) => (
                  <tr key={r.id}>
                    <td>{date(r.scheduled_for)}</td>
                    <td>
                      {states[r.state]} {r.error}
                    </td>
                    <td>
                      {r.scanned} / {r.done} / {r.skipped} / {r.failed}
                    </td>
                    <td>
                      <button
                        className="button"
                        onClick={() => {
                          setRun(r);
                          setItemCursor('');
                          details.retry();
                        }}
                      >
                        Wyniki zamówień
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ops-buttons">
            {runCursor && (
              <button className="button" disabled={history.loading} onClick={() => setRunCursor('')}>
                Najnowsze wykonania
              </button>
            )}
            {runs?.meta.cursor && (
              <button className="button" disabled={history.loading} onClick={() => setRunCursor(runs.meta.cursor)}>
                Starsze wykonania
              </button>
            )}
            <button
              className="button"
              onClick={() => {
                setSelected(null);
                setRun(null);
              }}
            >
              Zamknij historię
            </button>
          </div>
        </div>
      )}
      {run && (
        <div className="schedule-detail">
          <h3>Wyniki wykonania · {states[runView.state]}</h3>
          <p>{runView.error || runView.job_error}</p>
          {details.loading && <p role="status">Wczytywanie strony wyników…</p>}
          {details.error && <><p role="alert">Nie udało się odczytać tej strony wyników: {details.error}</p>
            <button className="button" onClick={() => details.retry()}>Ponów odczyt wyników</button></>}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Zamówienie</th>
                  <th>Wynik</th>
                  <th>Szczegóły</th>
                </tr>
              </thead>
              <tbody>
                {runDetails?.items?.map((i: any) => (
                  <tr key={i.order_id}>
                    <td>{i.number}</td>
                    <td>{states[i.state]}</td>
                    <td>
                      {i.error || 'Akcje zakończone'}
                      <SmsActionReceipts actions={i.result?.actions} />
                      <EmailActionReceipts actions={i.result?.actions} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ops-buttons">
            {itemCursor && (
              <button className="button" disabled={details.loading} onClick={() => setItemCursor('')}>
                Pierwsza strona wyników
              </button>
            )}
            {runDetails?.meta?.cursor && (
              <button className="button" disabled={details.loading} onClick={() => setItemCursor(runDetails.meta.cursor)}>
                Dalsze wyniki
              </button>
            )}
            <button className="button" onClick={() => setRun(null)}>
              Zamknij wyniki
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
