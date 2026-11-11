import {OrdinaryConnectorJobControl,type ConnectorJobContext} from './ordinary-connector-job';
import { DpdPickupSchedule } from './dpd-pickup-schedule';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, date } from './api';
import { FileDown, Truck } from 'lucide-react';
export function DpdCollections({ channelId, admin, connectorContext }: { channelId: string; admin: boolean; connectorContext?:ConnectorJobContext }) {
  const [data, setData] = useState<any>(null),
    [parcels, setParcels] = useState<any>(null),
    [kind, setKind] = useState('pickup'),
    [formOpen, setFormOpen] = useState(false),
    [selected, setSelected] = useState<Record<string, any>>({}),
    [search, setSearch] = useState(''),
    [day, setDay] = useState(new Date(Date.now() + 86400000).toISOString().slice(0, 10)),
    [from, setFrom] = useState('09:00'),
    [to, setTo] = useState('17:00'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<Record<string, boolean>>({}),
    [hours, setHours] = useState<any>(null),
    [resolve, setResolve] = useState<any>(null),
    [historyAfter, setHistoryAfter] = useState<string | undefined>(),
    [parcelAfter, setParcelAfter] = useState<string | undefined>();
  const key = useRef(crypto.randomUUID());
  async function load() {
    const [d, p] = await Promise.all([
      api(
        '/integrations/' +
          channelId +
          '/dpd-collections' +
          (historyAfter ? '?after=' + historyAfter : ''),
      ),
      api(
        '/integrations/' +
          channelId +
          '/dpd-parcels?' +
          new URLSearchParams({ q: search, ...(parcelAfter ? { after: parcelAfter } : {}) }),
      ),
    ]);
    setData(d);
    setParcels(p);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
    const t = setInterval(() => load().catch((e) => setError(e.message)), 3000);
    return () => clearInterval(t);
  }, [channelId, historyAfter, parcelAfter, search]);
  async function run(path: string, body: any = {}) {
    setBusy(true);
    setError('');
    try {
      const r = await api(path, 'POST', body);
      await load();
      return r;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function preview(e: FormEvent) {
    e.preventDefault();
    const ids = Object.keys(selected);
    const p = await run('/integrations/' + channelId + '/dpd-collections', {
      kind,
      client_key: key.current,
      plan_ids: ids,
      ...(kind === 'pickup' ? { date: day, from, to } : {}),
    });
    if (p) {
      key.current = crypto.randomUUID();
      setSelected({});
      setFormOpen(false);
      setHistoryAfter(undefined);
    }
  }
  const resetKey = () => {
    key.current = crypto.randomUUID();
    setHours(null);
  };
  const selectedItems = Object.values(selected),
    local = data?.channel.settings.simulation;
  // This DTO comes from the DPD-only collections route (which does not return provider).
  // Bind its exact channel and sandbox; the job endpoint still owns provider/capability admission.
  const manualConnector=!!connectorContext&&data?.channel.id===channelId&&data.channel.mode==='sandbox'&&data.channel.settings?.simulation===false;
  const stateNames: Record<string, string> = {
    preview: 'Podgląd',
    queued: 'W realizacji',
    ready: 'Potwierdzone',
    failed: 'Błąd',
    uncertain: 'Wynik niepewny',
    cancel_queued: 'Anulowanie w realizacji',
    cancelled: 'Anulowane',
  };
  if (!data || !parcels) return <p>Wczytywanie paczek DPD…</p>;
  return (
    <div className="dpd-collections">
      <p>
        <strong>{data.channel.name}</strong> ·{' '}
        {local
          ? 'DEMO lokalne'
          : data.channel.mode === 'sandbox'
            ? 'DEMO DPD API'
            : 'API produkcyjne'}
      </p>
      <p className="muted">
        Wybierz do 200 paczek z jednym adresem nadawcy. Zlecenie odbioru i protokół nie rozchodują
        towaru. Przekazanie potwierdzasz osobno w zamówieniach.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {admin && <DpdPickupSchedule channelId={channelId} local={!!local} />}
      {data.data.length > 0 && (
        <button className="button" onClick={() => setFormOpen(!formOpen)}>
          {formOpen ? 'Zamknij formularz zlecenia' : 'Przygotuj nowe zlecenie DPD'}
        </button>
      )}
      {(formOpen || data.data.length === 0) && (
        <form onSubmit={preview} className="dpd-collection-form">
          <label>
            Operacja DPD
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setSelected({});
                resetKey();
              }}
            >
              <option value="pickup">Zamów odbiór paczek</option>
              <option value="protocol">Wygeneruj protokół PDF</option>
            </select>
          </label>
          <label>
            Szukaj paczek DPD
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setParcelAfter(undefined);
              }}
              placeholder="Numer zamówienia lub listu"
            />
          </label>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Wybór</th>
                  <th>Zamówienie / list</th>
                  <th>Nadawca</th>
                  <th>Paczka</th>
                  <th>Odbiór</th>
                </tr>
              </thead>
              <tbody>
                {parcels.data.map((p: any) => (
                  <tr key={p.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={'Wybierz paczkę ' + p.number}
                        checked={!!selected[p.id]}
                        disabled={
                          (kind === 'pickup' && (p.state !== 'ready' || !!p.pickup_id)) ||
                          (!selected[p.id] && selectedItems.length >= 200)
                        }
                        onChange={(e) => {
                          setSelected((prev) => {
                            const n = { ...prev };
                            if (e.target.checked) n[p.id] = p;
                            else delete n[p.id];
                            return n;
                          });
                          resetKey();
                        }}
                      />
                    </td>
                    <td>
                      {p.number}
                      <br />
                      <strong>{p.tracking_number}</strong>
                    </td>
                    <td>
                      {p.sender.name}
                      <br />
                      {p.sender.postalCode} {p.sender.city}, {p.sender.address}
                    </td>
                    <td>
                      {p.weight} kg
                      <br />
                      {p.dimensions.length}×{p.dimensions.width}×{p.dimensions.height} cm
                    </td>
                    <td>
                      {p.pickup_id
                        ? 'Aktywne lub niepewne zlecenie'
                        : p.state === 'dispatched'
                          ? 'Paczka przekazana'
                          : 'Do odbioru'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!parcels.data.length && <p>Brak gotowych paczek dla tego konta.</p>}
          <div className="shipping-actions">
            <button
              type="button"
              className="button"
              disabled={!parcelAfter}
              onClick={() => setParcelAfter(undefined)}
            >
              Pierwsza strona paczek
            </button>
            <button
              type="button"
              className="button"
              disabled={!parcels.next}
              onClick={() => setParcelAfter(parcels.next)}
            >
              Następne paczki
            </button>
          </div>
          <p>
            Wybrano <strong>{selectedItems.length}</strong> paczek
            {selectedItems.length ? <> · {selectedItems.map((p) => p.number).join(', ')}</> : null}
          </p>
          {kind === 'pickup' && (
            <div className="form-grid dpd-collection-time">
              <label>
                Data odbioru DPD
                <input
                  type="date"
                  value={day}
                  required
                  onChange={(e) => {
                    setDay(e.target.value);
                    resetKey();
                  }}
                />
              </label>
              <label>
                Odbiór od
                <input
                  type="time"
                  value={from}
                  required
                  onChange={(e) => {
                    setFrom(e.target.value);
                    resetKey();
                  }}
                />
              </label>
              <label>
                Odbiór do
                <input
                  type="time"
                  value={to}
                  required
                  onChange={(e) => {
                    setTo(e.target.value);
                    resetKey();
                  }}
                />
              </label>
              <p className="muted">
                Godziny czasu polskiego. Termin do 14 dni, cena według umowy z DPD.
              </p>
              <button
                type="button"
                className="button"
                disabled={!selectedItems.length || busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    setHours(
                      await api(
                        '/integrations/' +
                          channelId +
                          '/dpd-availability?postal_code=' +
                          selectedItems[0].sender.postalCode,
                      ),
                    );
                  } catch (e: any) {
                    setError(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Sprawdź godziny kuriera
              </button>
              {hours && (
                <p>
                  Dostępne przedziały{' '}
                  {hours.scope === 'local_simulation' ? '(przykład lokalny)' : 'według API DPD'}:{' '}
                  {hours.ranges.map((r: any) => r.range).join(', ')}. Termin jest ostatecznie
                  potwierdzany przy zleceniu.
                </p>
              )}
            </div>
          )}
          <button className="button primary" disabled={busy || !selectedItems.length}>
            Zapisz podgląd zlecenia DPD
          </button>
        </form>
      )}
      <h3>Historia odbiorów i protokołów</h3>
      {!data.data.length && <p>Brak zleceń dla tego konta.</p>}
      {data.data.map((r: any) => (
        <section className="shipping-plan" key={r.id}>
          <header>
            <strong>
              {r.kind === 'pickup' ? (
                <>
                  <Truck size={16} /> Odbiór paczek
                </>
              ) : (
                <>
                  <FileDown size={16} /> Protokół nadania
                </>
              )}
            </strong>
            <span>
              {stateNames[r.state]} · {date(r.created_at)}
            </span>
          </header>
          <p>
            {r.input.count} paczek · {r.input.weight} kg · {r.input.sender.city},{' '}
            {r.input.sender.address}
            {r.kind === 'pickup' ? (
              <>
                {' '}
                · {r.input.date}, {r.input.from}–{r.input.to}
              </>
            ) : null}
          </p>
          {r.remote_id && (
            <p>
              Numer zlecenia DPD: <strong>{r.remote_id}</strong>
            </p>
          )}
          {r.error && <p className="notice error">{r.error}</p>}
          {manualConnector&&r.job_id&&<OrdinaryConnectorJobControl {...connectorContext!} externalWriteBlocked={connectorContext!.externalWriteBlocked||busy} jobId={r.job_id} kind="dpd.collection" onChanged={()=>void load()}/>}
          {r.result?.scope === 'manual_confirmation' && (
            <p className="notice">
              Ręczne potwierdzenie administratora: {r.result.evidence}. Wynik nie został
              potwierdzony odczytem API.
            </p>
          )}
          <details>
            <summary>Dane zlecenia i paczki</summary>
            <pre>{JSON.stringify(r.payload, null, 2)}</pre>
          </details>
          {(r.state === 'preview' ||
            (r.state === 'ready' && r.kind === 'pickup') ||
            (!manualConnector && r.state === 'failed' && r.kind === 'protocol')) && (
            <>
              <label className="shipping-check">
                <input
                  type="checkbox"
                  checked={!!confirm[r.id + ':' + r.state + ':' + r.updated_at]}
                  onChange={(e) =>
                    setConfirm({
                      ...confirm,
                      [r.id + ':' + r.state + ':' + r.updated_at]: e.target.checked,
                    })
                  }
                />
                {local
                  ? 'Potwierdzam lokalną symulację.'
                  : r.state === 'ready'
                    ? 'Potwierdzam anulowanie odbioru paczek w DPD.'
                    : 'Potwierdzam przekazanie danych i zlecenie DPD według umowy.'}
              </label>
              <div className="shipping-actions">
                {r.state === 'preview' && (
                  <>
                    <button
                      className="button primary"
                      disabled={busy || !confirm[r.id + ':' + r.state + ':' + r.updated_at]}
                      onClick={() =>
                        run('/dpd-collections/' + r.id + '/queue', { confirm_external: true })
                      }
                    >
                      Zatwierdź {r.kind === 'pickup' ? 'odbiór DPD' : 'protokół DPD'}
                    </button>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => run('/dpd-collections/' + r.id + '/cancel')}
                    >
                      Anuluj podgląd zlecenia
                    </button>
                  </>
                )}
                {r.state === 'ready' && r.kind === 'pickup' && (
                  <button
                    className="button"
                    disabled={busy || !confirm[r.id + ':' + r.state + ':' + r.updated_at]}
                    onClick={() =>
                      run('/dpd-collections/' + r.id + '/cancel', { confirm_external: true })
                    }
                  >
                    Anuluj odbiór w DPD
                  </button>
                )}
                {!manualConnector && r.state === 'failed' && r.kind === 'protocol' && (
                  <button
                    className="button"
                    disabled={busy || !confirm[r.id + ':' + r.state + ':' + r.updated_at]}
                    onClick={() =>
                      run('/dpd-collections/' + r.id + '/retry', { confirm_external: true })
                    }
                  >
                    Ponów protokół DPD
                  </button>
                )}
              </div>
            </>
          )}
          {r.kind === 'protocol' && r.state === 'ready' && (
            <a
              className="button"
              href={'/api/dpd-collections/' + r.id + '/document'}
              target="_blank"
              rel="noreferrer"
            >
              {r.input.simulation ? 'Protokół DEMO lokalny' : 'Zapisany protokół DPD PDF'}
            </a>
          )}
          {r.state === 'failed' && r.phase === 'ready' && (
            <button
              className="button"
              disabled={busy}
              onClick={() => run('/dpd-collections/' + r.id + '/cancel')}
            >
              Anuluj niewysłane zlecenie
            </button>
          )}
          {r.state === 'uncertain' && (
            <>
              <p>
                Sprawdź wynik tego zlecenia u DPD. System nie ponowi niepewnego zamówienia ani
                anulowania odbioru.
              </p>
              {admin && (
                <button className="button" onClick={() => setResolve(r)}>
                  Potwierdź sprawdzony wynik DPD
                </button>
              )}
            </>
          )}
        </section>
      ))}
      <div className="shipping-actions">
        <button
          className="button"
          disabled={!historyAfter}
          onClick={() => setHistoryAfter(undefined)}
        >
          Pierwsza strona historii
        </button>
        <button className="button" disabled={!data.next} onClick={() => setHistoryAfter(data.next)}>
          Następne zlecenia
        </button>
      </div>
      {resolve && (
        <form
          className="form-grid shipping-form"
          onSubmit={async (e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const f = Object.fromEntries(new FormData(e.currentTarget));
            const r = await run('/dpd-collections/' + resolve.id + '/resolve', {
              outcome: f.outcome,
              evidence: f.evidence,
              confirmed: true,
              ...(f.outcome === 'created'
                ? { order_number: f.order_number, checksum: f.checksum }
                : {}),
            });
            if (r) setResolve(null);
          }}
        >
          <h3>Wynik sprawdzony u DPD</h3>
          <p>
            To ręczne potwierdzenie. Dodaj źródło potwierdzenia; nie traktujemy go jako weryfikacji
            API.
          </p>
          <label>
            Wynik u dostawcy
            <select name="outcome" required>
              {resolve.phase === 'create_started' ? (
                <>
                  <option value="created">DPD potwierdziło utworzenie odbioru</option>
                  <option value="not_created">DPD potwierdziło brak zlecenia</option>
                </>
              ) : (
                <>
                  <option value="cancelled">DPD potwierdziło anulowanie</option>
                  <option value="still_active">DPD potwierdziło aktywne zlecenie</option>
                </>
              )}
            </select>
          </label>
          {resolve.phase === 'create_started' && (
            <>
              <label>
                Potwierdzony numer zlecenia
                <input name="order_number" placeholder="Numer otrzymany od DPD" />
              </label>
              <label>
                Suma zlecenia otrzymana od DPD
                <input name="checksum" />
              </label>
            </>
          )}
          <label>
            Źródło i opis potwierdzenia
            <textarea name="evidence" minLength={10} maxLength={500} required />
          </label>
          <label className="shipping-check">
            <input name="confirmed" type="checkbox" required />
            Sprawdziłem wynik u DPD i potwierdzam jego zgodność.
          </label>
          <button className="button primary" disabled={busy}>
            Zapisz ręczne potwierdzenie
          </button>
          <button type="button" className="button" onClick={() => setResolve(null)}>
            Zamknij potwierdzenie
          </button>
        </form>
      )}
    </div>
  );
}
