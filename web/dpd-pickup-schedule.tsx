import { useEffect, useState, type FormEvent } from 'react';
import { api, date } from './api';
export function DpdPickupSchedule({ channelId, local }: { channelId: string; local: boolean }) {
  const [data, setData] = useState<any>(null),
    [version, setVersion] = useState(0),
    [open, setOpen] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [enabled, setEnabled] = useState(false),
    [time, setTime] = useState('08:00'),
    [days, setDays] = useState([1, 2, 3, 4, 5]),
    [offset, setOffset] = useState(1),
    [from, setFrom] = useState('09:00'),
    [to, setTo] = useState('17:00');
  async function load() {
    const d = await api('/integrations/' + channelId + '/dpd-pickup-schedule');
    setData(d);
    return d;
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
    const timer = setInterval(() => load().catch((e) => setError(e.message)), 5000);
    return () => clearInterval(timer);
  }, [channelId]);
  function edit() {
    const s = data?.schedule;
    setVersion(s?.version ?? 0);
    setEnabled(s?.enabled ?? false);
    setTime(s?.definition.time ?? '08:00');
    setDays(s?.definition.weekdays ?? [1, 2, 3, 4, 5]);
    setOffset(s?.definition.business_days ?? 1);
    setFrom(s?.definition.from ?? '09:00');
    setTo(s?.definition.to ?? '17:00');
    setConfirm(false);
    setOpen(true);
    setError('');
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/integrations/' + channelId + '/dpd-pickup-schedule', 'PUT', {
        version,
        enabled,
        time,
        weekdays: days,
        business_days: offset,
        from,
        to,
        confirm_external: confirm,
      });
      await load();
      setOpen(false);
      setConfirm(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="dpd-pickup-schedule">
      <h3>Automatyczne podjazdy DPD</h3>
      <p className="muted">
        Dni i godziny w Europe/Warsaw. Do 2000 gotowych paczek na termin, grupowanych według nadawcy
        w partie do 200. Każda partia tworzy osobne zlecenie podjazdu według umowy. Święta nie są
        pomijane automatycznie. Aplikacja musi być uruchomiona.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {data && (
        <p>
          {data.schedule?.enabled ? 'Harmonogram włączony' : 'Harmonogram wyłączony'} ·{' '}
          {data.eligible_capped ? 'co najmniej ' : ''}
          {data.eligible} gotowych paczek bez zlecenia odbioru
          {data.schedule?.next_at ? ' · następny termin: ' + date(data.schedule.next_at) : ''}
        </p>
      )}
      {data?.schedule?.error && <p className="notice error">{data.schedule.error}</p>}
      {!open && (
        <button className="button" onClick={edit} disabled={!data}>
          Ustaw harmonogram DPD
        </button>
      )}
      {open && (
        <form onSubmit={save} className="dpd-collection-form">
          <label className="check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                setConfirm(false);
              }}
            />
            Włącz automatyczne podjazdy
          </label>
          <label>
            Godzina uruchomienia harmonogramu
            <input type="time" required value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <fieldset>
            <legend>Dni uruchomienia</legend>
            <div className="dpd-weekdays">
              {['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Nd'].map((label, i) => (
                <label key={i} className="check">
                  <input
                    type="checkbox"
                    checked={days.includes(i + 1)}
                    onChange={(e) =>
                      setDays(
                        e.target.checked
                          ? [...days, i + 1].sort()
                          : days.filter((d) => d !== i + 1),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            Podjazd po ilu dniach roboczych
            <input
              type="number"
              min={0}
              max={7}
              required
              value={offset}
              onChange={(e) => setOffset(Number(e.target.value))}
            />
          </label>
          <div className="form-grid dpd-collection-time">
            <label>
              Odbiór od
              <input type="time" required value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              Odbiór do
              <input type="time" required value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          {enabled && !local && (
            <label className="check">
              <input
                type="checkbox"
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
              />
              Zgadzam się na automatyczne zlecanie podjazdów DPD według umowy, dla każdej wybranej
              partii.
            </label>
          )}
          <p className="muted">
            Termin spóźniony ponad 15 minut zostanie pominięty. Wyłączenie zatrzymuje zlecenia przed
            zapisem do DPD. Rozpoczęte i potwierdzone odbiory sprawdzisz i anulujesz w historii.
          </p>
          <div className="row">
            <button className="button primary" disabled={busy || (enabled && !local && !confirm)}>
              Zapisz harmonogram DPD
            </button>
            <button type="button" className="button" onClick={() => setOpen(false)}>
              Zamknij ustawienia harmonogramu
            </button>
          </div>
        </form>
      )}
      {data?.runs?.length > 0 && (
        <details>
          <summary>Ostatnie wykonania harmonogramu ({data.runs.length})</summary>
          {data.runs.map((r: any) => (
            <div className="plan-card" key={r.id}>
              <strong>
                {date(r.scheduled_for)} ·{' '}
                {r.state === 'missed'
                  ? 'Termin pominięty'
                  : r.state === 'empty'
                    ? 'Brak paczek'
                    : 'Utworzono kolejkę'}
              </strong>
              <p>
                {r.count} paczek · {r.collection_ids.length} zleceń
                {r.remaining ? ' · pozostały paczki ponad limit' : ''}
              </p>
              {r.collections.map((c: any) => (
                <p key={c.id}>
                  {
                    (
                      {
                        queued: 'W realizacji',
                        ready: 'Potwierdzone',
                        cancelled: 'Anulowane',
                        uncertain: 'Wynik niepewny',
                        failed: 'Błąd',
                        cancel_queued: 'Anulowanie',
                      } as any
                    )[c.state]
                  }
                  {c.remote_id ? ' · DPD ' + c.remote_id : ''}
                  {c.error ? ' · ' + c.error : ''}
                </p>
              ))}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
