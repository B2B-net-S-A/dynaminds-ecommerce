import { useEffect, useState, useRef } from 'react';
import { RotateCcw, ArrowRight } from 'lucide-react';
import { api, money, date } from './api';
import { ReturnAssistantPanel, type ReturnAssistantGuard, type ReturnAssistantCompletion } from './return-assistant';
import { ReturnAssistantQueuesPanel, type ReturnAssistantViewSettings } from './return-assistant-queues';
const states: Record<string, string> = {
  requested: 'Do rozpatrzenia',
  refund_pending: 'Do rozliczenia',
  closed: 'Zamknięte',
  rejected: 'Odrzucone',
  cancelled: 'Anulowane',
};
export function ReturnQueue({
  refresh,
  onOrder,
  contextKey,
  readOnly,
  write,
  onChanged,
  destinationsAvailable = false,
  externalWriteBlocked = false,
}: {
  refresh: number;
  onOrder: (id: string) => void;
  contextKey: string;
  readOnly: boolean;
  write: boolean;
  onChanged: () => void;
  destinationsAvailable?: boolean;
  externalWriteBlocked?: boolean;
}) {
  const [assistant, setAssistant] = useState<{ returnId?: string; returnNumber?: string } | null>(null);
  const [assistantGuard, setAssistantGuard] = useState<ReturnAssistantGuard>({dirty:false,inFlight:false,unknown:false,hasActiveSession:false});
  const [completion, setCompletion] = useState<ReturnAssistantCompletion|null>(null);
  const [viewSettings, setViewSettings] = useState<ReturnAssistantViewSettings|undefined>();
  const assistantBlocked=assistantGuard.dirty||assistantGuard.inFlight||assistantGuard.unknown;
  function openAssistant(value:{returnId?:string;returnNumber?:string}){if(assistantBlocked){setError('Zapisz albo jawnie odrzuć zmiany kontroli. Przy nieznanym wyniku wróć do dokładnego ponowienia.');return;}setCompletion(null);setAssistantGuard({dirty:false,inFlight:false,unknown:false,hasActiveSession:false});setAssistant(value);}
  const [state, setState] = useState('requested'),
    [kind, setKind] = useState(''),
    [origin, setOrigin] = useState(''),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [rows, setRows] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const params = new URLSearchParams({ limit: '25', search: query });
  if (state) params.set('state', state);
  if (kind) params.set('kind', kind);
  if (origin) params.set('submitted_by', origin);
  const path = '/returns?' + params.toString();
  const identity = useRef('');
  identity.current = contextKey + ':' + readOnly + '|' + path + '|' + refresh;
  useEffect(() => { setAssistant(null);setCompletion(null);setViewSettings(undefined);setAssistantGuard({dirty:false,inFlight:false,unknown:false,hasActiveSession:false}); }, [contextKey, readOnly]);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setRows([]);
    setCursor(null);
    setError('');
    api(path)
      .then((d) => {
        if (active) {
          setRows(d.data);
          setCursor(d.meta.cursor);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [path, refresh, contextKey, readOnly]);
  async function more() {
    const current = identity.current;
    setBusy(true);
    try {
      const d = await api(path + '&after=' + encodeURIComponent(cursor!));
      if (current !== identity.current) return;
      setRows((r) => [...r, ...d.data]);
      setCursor(d.meta.cursor);
    } catch (e: any) {
      if (current === identity.current) setError(e.message);
    } finally {
      if (current === identity.current) setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>
            <RotateCcw size={20} /> Sprawy zwrotowe
          </h2>
          <p>Zgłoszenia kupujących i operatorów w aktywnej organizacji</p>
        </div>
        <button type="button" className="button" disabled={assistantBlocked} onClick={() => openAssistant({})}>Asystent zwrotów</button>
      </div>
      <ReturnAssistantQueuesPanel contextKey={contextKey} readOnly={readOnly} write={write} guard={assistantGuard} completion={completion} onViewSettingsChange={setViewSettings} onOpenReturn={selection=>{if(assistantBlocked)return;setViewSettings(selection.viewSettings);openAssistant(selection);}} />
      {assistant && <ReturnAssistantPanel key={contextKey + ':' + readOnly + ':' + (assistant.returnId ?? 'lookup')} contextKey={contextKey} readOnly={readOnly} write={write} destinationsAvailable={destinationsAvailable} externalWriteBlocked={externalWriteBlocked} returnId={assistant.returnId} returnNumber={assistant.returnNumber} viewSettings={viewSettings} onGuardChange={setAssistantGuard} onReceipt={setCompletion} onOrder={onOrder} onChanged={onChanged} onClose={() => {if(!assistantBlocked){setAssistant(null);setAssistantGuard({dirty:false,inFlight:false,unknown:false,hasActiveSession:false});}else setError('Kontrola ma niezapisane zmiany albo nieznany wynik. Najpierw rozwiąż je w asystencie.');}} />}
      <div className="info-body">
        <form
          className="return-queue-filters"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search);
          }}
        >
          <label>
            Status sprawy
            <select value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">Wszystkie</option>
              {Object.entries(states).map(([v, n]) => (
                <option key={v} value={v}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            Rodzaj sprawy
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Wszystkie</option>
              <option value="return">Zwrot</option>
              <option value="complaint">Reklamacja</option>
            </select>
          </label>
          <label>
            Źródło zgłoszenia
            <select value={origin} onChange={(e) => setOrigin(e.target.value)}>
              <option value="">Wszystkie</option>
              <option value="buyer">Kupujący</option>
              <option value="operator">Operator</option>
            </select>
          </label>
          <label>
            Numer sprawy, zamówienia lub klient
            <input value={search} onChange={(e) => setSearch(e.target.value)} maxLength={100} />
          </label>
          <button className="button" disabled={busy}>
            Szukaj
          </button>
        </form>
        {error && (
          <div role="alert" className="error-block">
            {error}
          </div>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Sprawa / zgłoszenie</th>
                <th>Zamówienie / klient</th>
                <th>Status</th>
                <th>Ilości</th>
                <th>Kwota przyjęta</th>
                <th>Obsługa</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.number}</strong>
                    <small>
                      {r.kind === 'complaint' ? 'Reklamacja' : 'Zwrot'} ·{' '}
                      {r.submitted_by === 'buyer' ? 'Kupujący' : 'Operator'} · {date(r.created_at)}
                    </small>
                  </td>
                  <td>
                    <strong>{r.order_number}</strong>
                    <small>{r.customer_name}</small>
                  </td>
                  <td>{states[r.state]}</td>
                  <td>
                    {r.items.reduce((n: number, i: any) => n + i.accepted, 0)} /{' '}
                    {r.items.reduce((n: number, i: any) => n + i.requested, 0)}
                  </td>
                  <td>{r.state === 'requested' ? 'Do rozpatrzenia' : money(r.refund_amount, r.currency)}</td>
                  <td>
                    <button type="button" className="button" aria-label={'Asystent zwrotu ' + r.number} disabled={assistantBlocked} onClick={() => openAssistant({ returnId: r.id, returnNumber: r.number })}>Asystent zwrotu</button>
                    <button
                      className="button"
                      disabled={assistantBlocked}
                      onClick={() => {if(!assistantBlocked)onOrder(r.order_id);}}
                      aria-label={'Obsłuż ' + r.number}
                    >
                      Zamówienie <ArrowRight size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <p className="muted">
            {busy ? 'Wczytywanie spraw…' : 'Brak spraw dla wybranych filtrów.'}
          </p>
        )}
        {cursor && (
          <button className="button" disabled={busy} onClick={more}>
            Starsze sprawy
          </button>
        )}
      </div>
    </section>
  );
}
export function PortalAccess({
  order,
  admin,
  busy,
  action,
}: {
  order: any;
  admin: boolean;
  busy: boolean;
  action: (path: string, body?: unknown, method?: string) => void;
}) {
  const enabled =
    order.portal_enabled &&
    (!order.portal_expires_at || new Date(order.portal_expires_at) > new Date());
  return (
    <div className="portal-access">
      {enabled ? (
        <a
          className="text-button"
          href={'/api/public/orders/' + order.portal_token}
          target="_blank"
          rel="noreferrer"
        >
          Portal kupującego
        </a>
      ) : (
        <p className="muted">Link kupującego wyłączony lub wygasły.</p>
      )}
      {order.portal_expires_at && <small>Ważny do: {date(order.portal_expires_at)}</small>}
      {admin && (
        <div className="toolbar-actions">
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              action('/orders/' + order.id + '/portal', { action: 'rotate' })
            }
          >
            Nowy link kupującego
          </button>
          {enabled && (
            <button
              className="button"
              disabled={busy}
              onClick={() => action('/orders/' + order.id + '/portal', { action: 'disable' })}
            >
              Wyłącz link kupującego
            </button>
          )}
        </div>
      )}
      <small>
        Nowy link unieważnia poprzedni i jest ważny tyle dni, ile ustawiono w „Ważność linku kupującego” (bez ustawienia: 90 dni). Link nie został wysłany klientowi.
      </small>
    </div>
  );
}
