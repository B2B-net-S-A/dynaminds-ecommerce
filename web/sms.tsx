import { SmsLiveEndpointSetup } from './sms-live-endpoint';
import { SmsDeliveryStatus } from './sms-delivery';
import { useEffect, useRef, useState } from 'react';
import { api, date, money, statusNames } from './api';
import { MessageVariables, TemplateLivePreview } from './messages-template-preview';
import { BatchResultTools } from './messages-batch-results';
const names: Record<string, string> = {
  draft: 'Podgląd',
  invalid: 'Niepoprawna',
  queued: 'W kolejce',
  simulated: 'Symulacja lokalna',
  tested: 'Test SMSAPI — bez doręczenia',
  submitted: 'Przyjęta przez SMSAPI — czeka na raport',
  uncertain: 'Wynik niepewny',
  failed: 'Błąd',
  cancelled: 'Anulowano',
};
export function SmsPanel({
  admin,
  write,
  refresh,
  reload,
}: {
  admin: boolean;
  write: boolean;
  refresh: number;
  reload: () => void;
}) {
  const [templates, setTemplates] = useState<any[]>([]),
    [channels, setChannels] = useState<any[]>([]),
    [editor, setEditor] = useState<any>(null),
    [selectedTemplate, setSelectedTemplate] = useState(''),
    [mode, setMode] = useState('local'),
    [channel, setChannel] = useState(''),
    [endpoints,setEndpoints]=useState<any[]>([]),
    [search, setSearch] = useState(''),
    [cursor, setCursor] = useState(''),
    [orders, setOrders] = useState<any>(null),
    [selected, setSelected] = useState<Record<string, any>>({}),
    [preview, setPreview] = useState<any>(null),
    [history, setHistory] = useState<any>(null),
    [historyCursor, setHistoryCursor] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [local, setLocal] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setLocal((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    let live = true;
    Promise.all([api('/sms/templates'), api('/integrations'),admin?api('/sms/live-endpoints').catch(()=>({data:[]})):Promise.resolve({data:[]})])
      .then(([t, c,e]) => {
        if (live) {
          setTemplates(t.data);setEndpoints(e.data);
          setChannels(c.channels.filter((x: any) => x.provider === 'smsapi'));
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [refresh, local]);
  useEffect(() => {
    let live = true;
    api(
      '/orders?' +
        new URLSearchParams({ search, limit: '50', ...(cursor ? { after: cursor } : {}) }),
    )
      .then((r) => live && setOrders(r))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [search, cursor, refresh]);
  // Under load a history reply can take longer than the 5 s tick, so a tick waits for the
  // request in flight instead of discarding it. A reply is shown only for the page still open
  // and only when it is newer than the reply already shown.
  const historyPoll = useRef({ seq: 0, shown: 0, pending: 0, key: '' });
  useEffect(() => () => void (historyPoll.current.key = ''), []);
  useEffect(() => {
    const p = historyPoll.current,
      key = historyCursor + '\n' + refresh;
    if (p.pending && p.key === key) return;
    const seq = ++p.seq,
      current = () => p.key === key && seq > p.shown;
    p.pending = seq;
    p.key = key;
    api('/sms/messages?' + new URLSearchParams(historyCursor ? { after: historyCursor } : {}))
      .then((r) => {
        if (!current()) return;
        p.shown = seq;
        setHistory(r);
      })
      .catch((e) => current() && setError(e.message))
      .finally(() => {
        if (p.pending === seq) p.pending = 0;
      });
  }, [historyCursor, refresh, local]);
  useEffect(() => {
    if (!preview || preview.state === 'preview') return;
    let live = true;
    api('/sms/batches/' + preview.id)
      .then((r) => live && setPreview(r))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [preview?.id, preview?.state, refresh, local]);
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      setLocal((n) => n + 1);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const change = () => setPreview(null),
    chosen = templates.find((t) => t.id === selectedTemplate),
    valid = preview?.items.filter((m: any) => m.state === 'draft').length ?? 0;
  return (
    <div className="sms-panels">
      {admin && <SmsLiveEndpointSetup create={async body=>{const r=await api('/sms/live-endpoints','POST',body);setLocal(n=>n+1);return r;}}/>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="panel ops-panel">
        <div className="panel-heading">
          <div>
            <h2>Szablony wiadomości</h2>
            <p>Informacje o zamówieniu wstawiane osobno dla każdego odbiorcy.</p>
          </div>
          {admin && (
            <button
              className="button primary"
              onClick={() =>
                setEditor({
                  name: '',
                  body: 'Dzień dobry {{customer_name}}, zamówienie {{order_number}}: {{total}} {{currency}}.',
                  max_parts: 3,
                  active: true,
                  client_key: crypto.randomUUID(),
                })
              }
            >
              Nowy szablon SMS
            </button>
          )}
        </div>
        {!editor && <MessageVariables />}
        {editor && (
          <form
            className="rule-editor"
            onSubmit={(e) => {
              e.preventDefault();
              perform(async () => {
                const b = {
                  name: editor.name,
                  body: editor.body,
                  max_parts: editor.max_parts,
                  active: editor.active,
                  ...(editor.id ? { version: editor.version } : { client_key: editor.client_key }),
                };
                const t = await api(
                  editor.id ? '/sms/templates/' + editor.id : '/sms/templates',
                  editor.id ? 'PATCH' : 'POST',
                  b,
                );
                setSelectedTemplate(t.id);
                setEditor(null);
                change();
              });
            }}
          >
            <label>
              Nazwa szablonu
              <input
                required
                aria-label="Nazwa szablonu SMS"
                value={editor.name}
                maxLength={120}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              />
            </label>
            <label>
              Treść SMS
              <textarea
                required
                rows={4}
                aria-label="Treść szablonu SMS"
                maxLength={1500}
                value={editor.body}
                onChange={(e) => setEditor({ ...editor, body: e.target.value })}
              />
            </label>
            <label>
              Maksymalna liczba części
              <input
                type="number"
                min={1}
                max={10}
                value={editor.max_parts}
                onChange={(e) => setEditor({ ...editor, max_parts: Number(e.target.value) })}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={editor.active}
                onChange={(e) => setEditor({ ...editor, active: e.target.checked })}
              />{' '}
              Aktywny szablon
            </label>
            <MessageVariables
              onInsert={(tag) => setEditor({ ...editor, body: editor.body + (editor.body.endsWith(' ') || !editor.body ? '' : ' ') + tag })}
            />
            <TemplateLivePreview kind="sms" draft={editor} />
            <div className="ops-actions">
              <button className="button primary" disabled={busy}>
                Zapisz szablon
              </button>
              <button type="button" className="button" onClick={() => setEditor(null)}>
                Zamknij
              </button>
            </div>
          </form>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Szablon</th>
                <th>Treść</th>
                <th>Limit</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.name}
                    <small className="cell-sub">
                      Wersja {t.version} · {t.active ? 'aktywny' : 'wyłączony'}
                    </small>
                  </td>
                  <td className="sms-text">{t.body}</td>
                  <td>{t.max_parts} części</td>
                  <td>
                    {admin && (
                      <button className="button small" onClick={() => setEditor(t)}>
                        Edytuj {t.name}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!templates.length && (
          <p className="muted">Utwórz pierwszy szablon, aby przygotować wiadomości.</p>
        )}
      </section>
      {write && (
        <section className="panel ops-panel">
          <div className="panel-heading">
            <div>
              <h2>Przygotuj wiadomości</h2>
              <p>Wybierz do 250 zamówień. Podgląd sprawdzi telefon, treść i liczbę części.</p>
            </div>
            <span className="tag-pill">Wybrano {Object.keys(selected).length}</span>
          </div>
          <div className="sms-controls">
            <label>
              Szablon
              <select
                disabled={busy}
                aria-label="Szablon SMS"
                value={selectedTemplate}
                onChange={(e) => {
                  setSelectedTemplate(e.target.value);
                  change();
                }}
              >
                <option value="">Wybierz szablon</option>
                {templates
                  .filter((t) => t.active)
                  .map((t) => (
                    <option value={t.id} key={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Tryb
              <select
                disabled={busy}
                aria-label="Tryb wiadomości"
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value);
                  change();
                }}
              >
                <option value="local">Symulacja lokalna — bez połączenia</option>
                {admin && <option value="provider_test">Test SMSAPI — bez doręczenia</option>}
                {admin && endpoints.some(e=>e.enabled) && <option value="provider_live">Rzeczywista wysyłka SMSAPI</option>}
              </select>
            </label>
            {mode !== 'local' && (
              <label>
                Połączenie SMSAPI
                <select
                  disabled={busy}
                  aria-label="Połączenie SMSAPI"
                  value={channel}
                  onChange={(e) => {
                    setChannel(e.target.value);
                    change();
                  }}
                >
                  <option value="">Wybierz połączenie</option>
                  {channels.filter(c=>mode==='provider_live'?c.mode==='live'&&endpoints.some(e=>e.enabled&&e.channel_id===c.id):c.mode==='sandbox').map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <p className="notice">
            {mode === 'local'
              ? 'Symulacja zapisuje wynik lokalnie. Nie kontaktuje się z dostawcą.'
              : mode==='provider_live'?'Wysyłka rzeczywista i płatna. Zatwierdzenie wymaga sesji administratora z MFA. Przyjęcie przez SMSAPI nie oznacza doręczenia.':'Test używa test=1 w API SMSAPI i wymaga tokenu konta. Nie doręcza SMS.'}
          </p>
          <label>
            Szukaj zamówienia
            <input
              aria-label="Szukaj zamówienia do SMS"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setCursor('');
              }}
              placeholder="Numer, kupujący lub e-mail"
            />
          </label>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Wybierz</th>
                  <th>Zamówienie</th>
                  <th>Kupujący</th>
                  <th>Telefon</th>
                  <th>Wartość</th>
                </tr>
              </thead>
              <tbody>
                {orders?.data.map((o: any) => (
                  <tr key={o.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={'Wybierz SMS ' + o.number}
                        checked={Boolean(selected[o.id])}
                        disabled={busy || (!selected[o.id] && Object.keys(selected).length >= 250)}
                        onChange={(e) => {
                          setSelected((prev) => {
                            const n = { ...prev };
                            if (e.target.checked) n[o.id] = o;
                            else delete n[o.id];
                            return n;
                          });
                          change();
                        }}
                      />
                    </td>
                    <td>
                      {o.number}
                      <small className="cell-sub">{statusNames[o.status]}</small>
                    </td>
                    <td>{o.customer_name}</td>
                    <td>{o.address.phone || 'Brak telefonu'}</td>
                    <td>{money(o.total, o.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ops-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                setCursor('');
                setSelected({});
                change();
              }}
            >
              Wyczyść wybór
            </button>
            {orders?.meta?.cursor && (
              <button className="button" onClick={() => setCursor(orders.meta.cursor)}>
                Następne zamówienia
              </button>
            )}
            <button
              className="button primary"
              disabled={
                busy ||
                !chosen ||
                !Object.keys(selected).length ||
                (mode !== 'local' && !channel)
              }
              onClick={() =>
                perform(async () =>
                  setPreview(
                    await api('/sms/preview', 'POST', {
                      template_id: chosen.id,
                      template_version: chosen.version,
                      order_ids: Object.keys(selected),
                      mode,
                      ...(mode !== 'local' ? { channel_id: channel } : {}),
                      ...(mode==='provider_live'?{delivery_endpoint_id:endpoints.find(e=>e.enabled&&e.channel_id===channel)?.id}:{}),
                      client_key: crypto.randomUUID(),
                    }),
                  ),
                )
              }
            >
              Podgląd SMS
            </button>
          </div>
          {preview && (
            <div className="sms-preview">
              <h3>Podgląd partii · {preview.items.length} wiadomości</h3>
              <p>
                Telefon i treść są zapisane. Zmiana zamówienia lub szablonu przed zatwierdzeniem
                wymaga nowego podglądu.
              </p>
              {preview.items.map((m: any) => (
                <article className="sms-message" key={m.id}>
                  <div>
                    <strong>{m.number}</strong>
                    <span className="tag-pill">{names[m.state]}</span>
                  </div>
                  <small>
                    {m.recipient ? '+' + m.recipient : 'Niepoprawny telefon'}
                    {m.parts
                      ? ` · ${m.encoding} · ${m.units} jednostek · ${m.parts} ${m.parts === 1 ? 'część' : 'części'}`
                      : ''}
                  </small>
                  <p className="sms-text">{m.payload}</p>
                  {m.error && <p className="error">{m.error}</p>}
                </article>
              ))}
              {preview.state === 'preview' && (
                <button
                  className="button primary"
                  disabled={busy || !valid}
                  onClick={() =>
                    perform(async () =>
                      setPreview(
                        await api('/sms/batches/' + preview.id + '/queue', 'POST', {
                          confirmed: true,
                          ...(preview.mode==='provider_live'?{confirm_external:true}:{}),
                        }),
                      ),
                    )
                  }
                >
                  Zatwierdź {preview.mode === 'local' ? 'symulację' : preview.mode==='provider_live'?'płatną wysyłkę SMSAPI':'test SMSAPI'} ({valid})
                </button>
              )}
              <BatchResultTools
                batch={preview}
                names={names}
                kind="sms"
                busy={busy}
                onRetry={(orders) => {
                  setSelected(orders);
                  change();
                }}
              />
              {['preview', 'queued'].includes(preview.state) && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    perform(async () =>
                      setPreview(
                        await api('/sms/batches/' + preview.id + '/cancel', 'POST', {
                          confirmed: true,
                        }),
                      ),
                    )
                  }
                >
                  Anuluj oczekujące
                </button>
              )}
            </div>
          )}
        </section>
      )}
      <section className="panel ops-panel">
        <div className="panel-heading">
          <div>
            <h2>Historia SMS</h2>
            <p>
              Podglądy, wyniki lokalne i testy dostawcy. Wynik niepewny nie jest ponawiany
              automatycznie.
            </p>
          </div>
          <button
            className="button"
            onClick={() => {
              setHistoryCursor('');
              setLocal((n) => n + 1);
            }}
          >
            Odśwież historię
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Data / zamówienie</th>
                <th>Odbiorca</th>
                <th>Treść</th>
                <th>Wynik</th>
              </tr>
            </thead>
            <tbody>
              {history?.data.map((m: any) => (
                <tr key={m.id}>
                  <td>
                    {date(m.created_at)}
                    <small className="cell-sub">{m.number}</small>
                  </td>
                  <td>{m.recipient ? '+' + m.recipient : '—'}</td>
                  <td className="sms-text">
                    {m.payload || '—'}
                    <small className="cell-sub">
                      {m.parts
                        ? `${m.parts} ${m.parts === 1 ? 'część' : 'części'} · ${m.encoding}`
                        : ''}
                    </small>
                  </td>
                  <td>
                    {names[m.state]}
                    <SmsDeliveryStatus mode={m.mode} delivery={m.delivery} />
                    <small className="cell-sub">
                      {m.error || (m.mode === 'local' ? 'Lokalnie' : m.mode==='provider_live'?'SMSAPI — wysyłka rzeczywista':'SMSAPI test=1')}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {history?.meta.cursor && (
          <button className="button" onClick={() => setHistoryCursor(history.meta.cursor)}>
            Starsze wiadomości
          </button>
        )}
      </section>
    </div>
  );
}
