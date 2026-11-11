import { useEffect, useRef, useState } from 'react';
import { api, date, money } from './api';
const resources: Record<string, string> = {
  products: 'produkty',
  orders: 'zamówienia miesięcznie',
  channels: 'połączenia',
  warehouses: 'magazyny',
  memberships: 'miejsca zespołu',
};
export function WorkspaceBillingPanel({
  refresh,
  onChanged,
  readOnly,
  contextKey,
}: {
  refresh: number;
  onChanged: () => Promise<void>;
  readOnly: boolean;
  contextKey: string;
}) {
  const [data, setData] = useState<any>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState('business'),
    [kind, setKind] = useState('change'),
    [preview, setPreview] = useState<any>(),
    [message, setMessage] = useState(''),
    [older, setOlder] = useState<any[]>([]);
  const access = useRef({contextKey, readOnly, admin: false}), alive = useRef(false), flight = useRef(false);
  access.current = {contextKey, readOnly, admin: data?.admin === true};
  useEffect(() => {alive.current = true;return () => {alive.current = false;};}, []);
  const current = () => alive.current && access.current.contextKey === contextKey;
  const writable = () => current() && !access.current.readOnly && access.current.admin;
  async function load() {
    const s = await api('/workspaces/billing');
    if (current()) {setData(s);setOlder([]);}
    return s;
  }
  useEffect(() => {
    let active = true;
    api('/workspaces/billing')
      .then((d) => {
        if (active) {
          setData(d);
          setOlder([]);
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [refresh, contextKey]);
  async function act(fn: () => Promise<void>) {
    if (!writable() || flight.current) return;
    flight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
      if (current()) await load();
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  if (!data) return <p role={error ? 'alert' : undefined}>{error || 'Wczytywanie abonamentu…'}</p>;
  const a = data.account,
    expired = a && new Date(a.period_end) <= new Date();
  return (
    <section className="panel billing-panel">
      <div className="panel-heading">
        <div>
          <h2>Abonament i rozliczenia lokalne</h2>
          <p>Przykładowy cennik i historia okresów — bez pobierania pieniędzy.</p>
        </div>
      </div>
      <div className="info-body">
        <p className="notice">
          Kwoty są przykładową kalkulacją produktu, bez VAT i dokumentu podatkowego. Nie zawierasz
          umowy ani nie uruchamiasz płatności. Zmiana planu wpływa na limity Twojej organizacji.
        </p>
        <div className="billing-plans">
          {data.plans.map((p: any) => (
            <article key={p.plan}>
              <strong>{p.name}</strong>
              <p>{money(p.monthly_amount, p.currency)} / miesiąc · przykład</p>
              <p>
                {Object.entries(p.limits)
                  .map(([r, n]) => `${Number(n).toLocaleString('pl-PL')} ${resources[r]}`)
                  .join(' · ')}
              </p>
            </article>
          ))}
        </div>
        {a ? (
          <>
            <p>
              Plan: <strong>{a.current_terms.name}</strong> · okres {date(a.period_start)} –{' '}
              {date(a.period_end)} · {money(a.monthly_amount, a.currency)} / miesiąc ·{' '}
              {expired
                ? 'okres zakończony'
                : new Date(a.period_start) > new Date()
                  ? 'okres przyszły'
                  : 'okres bieżący'}
            </p>
            <p>
              Automatyczne odnowienie kalkulacji: {a.auto_renew ? 'włączone' : 'wyłączone'}.
              Obejmuje wyłącznie lokalne wpisy historii.
            </p>
            {a.next_terms && (
              <p>
                Zaplanowano {a.next_terms.name} od {date(a.period_end)} za{' '}
                {money(a.next_terms.monthly_amount, a.next_terms.currency)} / miesiąc (przykład).
                Limity zostaną sprawdzone ponownie.
              </p>
            )}
            {a.next_error && (
              <p role="alert" className="error-block">
                {a.next_error}. Dotychczasowy plan zachowany; odnowienie wymaga rozwiązania tej
                przyczyny.
              </p>
            )}
            {data.admin && (
              <div className="button-row">
                <button
                  className="button"
                  disabled={busy || readOnly}
                  onClick={() =>
                    act(async () => {
                      await api('/workspaces/billing', 'PATCH', {
                        version: a.version,
                        auto_renew: !a.auto_renew,
                      });
                      if (!writable()) return;
                      setMessage('Zmieniono automatyczne odnowienie kalkulacji.');
                    })
                  }
                >
                  {a.auto_renew
                    ? 'Wyłącz automatyczne odnowienie'
                    : 'Włącz automatyczne odnowienie'}
                </button>
                {a.next_terms && (
                  <button
                    className="button"
                    disabled={busy || readOnly}
                    onClick={() =>
                      act(async () => {
                        await api('/workspaces/billing', 'PATCH', {
                          version: a.version,
                          cancel_scheduled: true,
                        });
                        if (!writable()) return;
                        setMessage('Anulowano zaplanowaną zmianę planu.');
                      })
                    }
                  >
                    Anuluj zmianę na kolejny okres
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <p>
            Abonament lokalny nie jest uruchomiony. Obecny plan i jego limity działają bez
            rozliczeń.
          </p>
        )}
        {data.admin && (
          <form
            className="workspace-plan"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const p = await api('/workspaces/billing/preview', 'POST', {
                  kind: !a ? 'activate' : expired ? 'renew' : kind,
                  plan: selected,
                });
                if (writable()) setPreview(p);
              });
            }}
          >
            <label>
              Docelowy plan
              <select
                aria-label="Docelowy plan abonamentu"
                value={selected}
                disabled={busy || readOnly}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setPreview(undefined);
                }}
              >
                {data.plans.map((p: any) => (
                  <option key={p.plan} value={p.plan}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {a && !expired && (
              <label>
                Termin zmiany
                <select
                  aria-label="Termin zmiany abonamentu"
                  value={kind}
                  disabled={busy || readOnly}
                  onChange={(e) => {
                    setKind(e.target.value);
                    setPreview(undefined);
                  }}
                >
                  <option value="change">Teraz — rozliczenie proporcjonalne</option>
                  <option value="schedule">Od następnego okresu</option>
                </select>
              </label>
            )}
            <button className="button secondary" disabled={busy || readOnly}>
              Przygotuj podgląd abonamentu
            </button>
          </form>
        )}
        {preview && (
          <div className="notice billing-preview">
            <strong>
              Podgląd: {preview.terms.name} ·{' '}
              {preview.kind === 'schedule'
                ? 'kolejny okres'
                : preview.kind === 'renew'
                  ? 'odnowienie'
                  : preview.kind === 'activate'
                    ? 'uruchomienie'
                    : 'zmiana teraz'}
            </strong>
            <p>
              Okres: {date(preview.effective_at)} – {date(preview.period_end)}
            </p>
            <p>
              Kalkulacja: {money(preview.debit, preview.terms.currency)} · kredyt za poprzedni plan{' '}
              {money(preview.credit, preview.terms.currency)} · razem{' '}
              <strong>{money(preview.total, preview.terms.currency)}</strong>
            </p>
            <p>
              Kwoty proporcjonalne do czasu pozostałego w miesiącu UTC, zaokrąglone do grosza.
              Podgląd ważny 15 minut; zatwierdzenie ponownie sprawdza limity i wersję abonamentu.
            </p>
            {preview.blockers.length > 0 && (
              <p role="alert">
                Przekroczone limity:{' '}
                {preview.blockers
                  .map((b: any) => `${resources[b.resource]} ${b.used}/${b.limit}`)
                  .join(', ')}
                .{' '}
                {preview.kind === 'schedule'
                  ? 'Zmianę można zaplanować; przy odnowieniu musi mieścić się w limitach.'
                  : 'Zmiana obecnie niedostępna.'}
              </p>
            )}
            <div className="button-row">
              <button
                className="button primary"
                disabled={busy || readOnly || !preview.can_commit}
                onClick={() =>
                  act(async () => {
                    await api(`/workspaces/billing/previews/${preview.id}/commit`, 'POST', {});
                    if (!writable()) return;
                    setPreview(undefined);
                    await onChanged();
                    if (!writable()) return;
                    setMessage('Zatwierdzono lokalny abonament. Nie pobrano pieniędzy.');
                  })
                }
              >
                Zatwierdź abonament lokalny
              </button>
              <button className="button" disabled={busy} onClick={() => setPreview(undefined)}>
                Zamknij podgląd abonamentu
              </button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="error-block">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="notice">
            {message}
          </p>
        )}
        {data.admin && (
          <>
            <h3>Historia kalkulacji</h3>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Operacja / plan</th>
                    <th>Okres</th>
                    <th>Kwota przykładowa</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.entries, ...older].map((e: any) => (
                    <tr key={e.id}>
                      <td>
                        {(
                          {
                            activate: 'Uruchomienie',
                            change: 'Zmiana planu',
                            credit: 'Kredyt',
                            renew: 'Odnowienie',
                          } as Record<string, string>
                        )[e.kind] || e.kind}{' '}
                        · {e.terms.name || e.plan}
                        <small>{date(e.created_at)}</small>
                      </td>
                      <td>
                        {date(e.period_start)} – {date(e.period_end)}
                      </td>
                      <td>{money(e.amount, e.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.entries.length && <p>Brak wpisów rozliczenia lokalnego.</p>}
            {data.next_cursor && (
              <button
                className="button"
                disabled={busy}
                onClick={() => {
                  if (!current() || busy) return;
                  setBusy(true);
                  const q = new URLSearchParams({
                    before: data.next_cursor.created_at,
                    id: data.next_cursor.id,
                  });
                  api('/workspaces/billing?' + q)
                    .then((d) => {
                      if (!current()) return;
                      setOlder((v) => [...v, ...d.entries]);
                      setData((v: any) => ({ ...v, next_cursor: d.next_cursor }));
                    })
                    .catch((e) => {if (current()) setError(e.message);})
                    .finally(() => {if (alive.current) setBusy(false);});
                }}
              >
                Starsze kalkulacje
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
