import { useEffect, useState } from 'react';
import { api, date, money, statusNames } from './api';
import { readTogether } from './read-polling';
import { useVisibleReadPolling } from './use-visible-read-polling';
import { EmailAttachment } from './email-attachment';
import { MessageVariables, TemplateLivePreview } from './messages-template-preview';
import { BatchResultTools } from './messages-batch-results';
const names: Record<string, string> = {
  draft: 'Podgląd',
  invalid: 'Niepoprawna',
  queued: 'W kolejce',
  simulated: 'Symulacja lokalna',
  smtp_accepted: 'Przyjęta przez SMTP',
  uncertain: 'Wynik niepewny',
  failed: 'Zatrzymana',
  cancelled: 'Anulowano',
};
export function EmailPanel({
  admin,
  write,
  refresh,
  orderId,
}: {
  admin: boolean;
  write: boolean;
  refresh: number;
  orderId?: string;
}) {
  const [templates, setTemplates] = useState<any[]>([]),
    [channels, setChannels] = useState<any[]>([]),
    [editor, setEditor] = useState<any>(null),
    [templateId, setTemplateId] = useState(''),
    [mode, setMode] = useState('local'),
    [channelId, setChannelId] = useState(''),
    [search, setSearch] = useState(''),
    [cursor, setCursor] = useState(''),
    [orders, setOrders] = useState<any>(null),
    [selected, setSelected] = useState<Record<string, any>>({}),
    [preview, setPreview] = useState<any>(null),
    [history, setHistory] = useState<any>(null),
    [historyCursor, setHistoryCursor] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [local, setLocal] = useState(0),
    [externalConfirmed, setExternalConfirmed] = useState(false);
  useVisibleReadPolling(JSON.stringify(['templates', refresh, local]), async current => {
    const [t, c] = await readTogether([api('/email/templates'), api('/integrations')]);
    if (!current()) return;
    setTemplates(t.data);
    setChannels(c.channels.filter((v: any) => v.provider === 'smtp'));
  }, e => setError((e as Error).message));
  useEffect(() => {
    let live = true;
    const url = orderId
      ? '/orders/' + orderId
      : '/orders?' +
        new URLSearchParams({ search, limit: '50', ...(cursor ? { after: cursor } : {}) });
    api(url)
      .then((r) => {
        if (live) {
          setOrders(orderId ? { data: [r] } : r);
          if (orderId) setSelected({ [orderId]: r });
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [search, cursor, refresh, orderId]);
  useVisibleReadPolling(JSON.stringify(['history', historyCursor, refresh, local, orderId]), async current => {
    const result = await api(
      '/email/messages?' +
        new URLSearchParams({
          ...(historyCursor ? { after: historyCursor } : {}),
          ...(orderId ? { order_id: orderId } : {}),
        }),
    );
    if (current()) setHistory(result);
  }, e => setError((e as Error).message));
  useVisibleReadPolling(JSON.stringify(['batch', preview?.id, preview?.state, refresh, local]), async current => {
    const result = await api('/email/batches/' + preview.id);
    if (current()) setPreview(result);
  }, e => setError((e as Error).message), preview?.state === 'queued');
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      setLocal((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const change = () => {
      setPreview(null);
      setExternalConfirmed(false);
    },
    chosen = templates.find((t) => t.id === templateId),
    connection = channels.find((c) => c.id === channelId),
    external = mode === 'smtp' && connection?.settings?.delivery !== 'local_sink',
    valid = preview?.items.filter((m: any) => m.state === 'draft').length ?? 0;
  return (
    <div className="sms-panels">
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!orderId && (
        <section className="panel ops-panel">
          <div className="panel-heading">
            <div>
              <h2>Szablony email</h2>
              <p>Temat, tekst i opcjonalny HTML, z danymi zamówienia.</p>
            </div>
            {admin && (
              <button
                className="button primary"
                onClick={() =>
                  setEditor({
                    name: '',
                    subject: 'Zamówienie {{order_number}}',
                    body: 'Dzień dobry {{customer_name}}, Twoje zamówienie {{order_number}}: {{total}} {{currency}}. Numer śledzenia: {{tracking_number}}.',
                    html: '',
                    active: true,
                    attachment: 'none',
                    client_key: crypto.randomUUID(),
                  })
                }
              >
                Nowy szablon email
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
                  const t = await api(
                    editor.id ? '/email/templates/' + editor.id : '/email/templates',
                    editor.id ? 'PATCH' : 'POST',
                    {
                      name: editor.name,
                      subject: editor.subject,
                      body: editor.body,
                      html: editor.html,
                      active: editor.active,
                      attachment: editor.attachment ?? 'none',
                      ...(editor.id
                        ? { version: editor.version }
                        : { client_key: editor.client_key }),
                    },
                  );
                  setTemplateId(t.id);
                  setEditor(null);
                  change();
                });
              }}
            >
              <label>
                Nazwa szablonu
                <input
                  aria-label="Nazwa szablonu email"
                  required
                  minLength={2}
                  maxLength={120}
                  value={editor.name}
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                />
              </label>
              <label>
                Temat
                <input
                  aria-label="Temat email"
                  required
                  maxLength={200}
                  value={editor.subject}
                  onChange={(e) => setEditor({ ...editor, subject: e.target.value })}
                />
              </label>
              <label>
                Treść tekstowa
                <textarea
                  aria-label="Treść email"
                  required
                  rows={4}
                  maxLength={20000}
                  value={editor.body}
                  onChange={(e) => setEditor({ ...editor, body: e.target.value })}
                />
              </label>
              <label>
                Treść HTML (opcjonalnie)
                <textarea
                  aria-label="HTML email"
                  rows={4}
                  maxLength={20000}
                  value={editor.html}
                  onChange={(e) => setEditor({ ...editor, html: e.target.value })}
                />
                <small>
                  Obsługa tekstu, tabel i linków HTTPS. Skrypty, style i zewnętrzne obrazy są
                  usuwane.
                </small>
              </label>
              <label>
                Wymagany załącznik
                <select
                  aria-label="Załącznik szablonu email"
                  value={editor.attachment ?? 'none'}
                  onChange={(e) => setEditor({ ...editor, attachment: e.target.value })}
                >
                  <option value="none">Bez załącznika</option>
                  <option value="invoice">Faktura zamówienia (DEMO HTML / PDF Fakturowni)</option>
                  <option value="odoo_invoice">PDF faktury Odoo</option>
                </select>
                <small>
                  Brak gotowego dokumentu zatrzyma wiadomość. PDF Fakturowni przygotujesz w panelu
                  faktur; PDF Odoo pobierzesz w panelu eksportu.
                </small>
              </label>
              <label className="check-line">
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
              <TemplateLivePreview kind="email" draft={editor} />
              <div className="ops-actions">
                <button className="button primary" disabled={busy}>
                  Zapisz szablon email
                </button>
                <button type="button" className="button" onClick={() => setEditor(null)}>
                  Zamknij edytor
                </button>
              </div>
            </form>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Szablon</th>
                  <th>Temat</th>
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
                      <small className="cell-sub">
                        {t.attachment === 'invoice'
                          ? 'Wymagana faktura'
                          : t.attachment === 'odoo_invoice'
                            ? 'Wymagany PDF Odoo'
                            : 'Bez załącznika'}
                      </small>
                    </td>
                    <td>{t.subject}</td>
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
      )}
      {write && (
        <section className="panel ops-panel">
          <div className="panel-heading">
            <div>
              <h2>Przygotuj email</h2>
              <p>Do 200 zamówień w partii. Podgląd zapisuje odbiorcę i dokładną treść.</p>
            </div>
            <span className="tag-pill">Wybrano {Object.keys(selected).length}</span>
          </div>
          <div className="sms-controls">
            <label>
              Szablon
              <select
                aria-label="Szablon email"
                value={templateId}
                disabled={busy}
                onChange={(e) => {
                  setTemplateId(e.target.value);
                  change();
                }}
              >
                <option value="">Wybierz szablon</option>
                {templates
                  .filter((t) => t.active)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Tryb
              <select
                aria-label="Tryb email"
                value={mode}
                disabled={busy}
                onChange={(e) => {
                  setMode(e.target.value);
                  change();
                }}
              >
                <option value="local">Symulacja lokalna — bez połączenia</option>
                <option value="smtp">SMTP — wysyłka przez konto</option>
              </select>
            </label>
            {mode === 'smtp' && (
              <label>
                Konto SMTP
                <select
                  aria-label="Konto SMTP"
                  value={channelId}
                  disabled={busy}
                  onChange={(e) => {
                    setChannelId(e.target.value);
                    change();
                  }}
                >
                  <option value="">Wybierz konto</option>
                  {channels
                    .filter((c) => admin || c.settings?.delivery === 'local_sink')
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
          </div>
          {admin && (
            <div className="ops-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  perform(async () => {
                    const r = await api('/integrations/smtp-example', 'POST', {});
                    setMode('smtp');
                    setChannelId(r.channel_id);
                    change();
                  })
                }
              >
                Dodaj lokalny odbiornik SMTP
              </button>
              {connection && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      await api('/integrations/' + connection.id + '/test', 'POST', {});
                      setNotice('Połączenie SMTP potwierdzone. Wiadomość nie została wysłana.');
                    })
                  }
                >
                  Sprawdź konto SMTP
                </button>
              )}
            </div>
          )}
          <p className="notice">
            {mode === 'local'
              ? 'Symulacja zapisuje wynik bez połączenia SMTP.'
              : connection?.settings?.delivery === 'local_sink'
                ? 'Lokalny odbiornik SMTP: 127.0.0.1:1025. Przyjmuje tylko adresy .test i nie przekazuje poczty dalej. Uruchom npm run mail:sink.'
                : 'Zewnętrzny SMTP wymaga konta i zgody administratora. Przyjęcie przez SMTP nie potwierdza doręczenia. Zewnętrzna wysyłka jest domyślnie wyłączona.'}
          </p>
          {!orderId && (
            <label>
              Szukaj zamówienia
              <input
                aria-label="Szukaj zamówienia do email"
                value={search}
                placeholder="Numer, kupujący lub email"
                onChange={(e) => {
                  setSearch(e.target.value);
                  setCursor('');
                }}
              />
            </label>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Wybierz</th>
                  <th>Zamówienie</th>
                  <th>Kupujący</th>
                  <th>Email</th>
                  <th>Wartość</th>
                </tr>
              </thead>
              <tbody>
                {orders?.data.map((o: any) => (
                  <tr key={o.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={'Wybierz email ' + o.number}
                        checked={Boolean(selected[o.id])}
                        disabled={
                          busy ||
                          Boolean(orderId) ||
                          (!selected[o.id] && Object.keys(selected).length >= 200)
                        }
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
                    <td>{o.email || 'Brak email'}</td>
                    <td>{money(o.total, o.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ops-actions">
            {!orderId && (
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
            )}
            {orders?.meta?.cursor && (
              <button className="button" onClick={() => setCursor(orders.meta.cursor)}>
                Następne zamówienia
              </button>
            )}
            <button
              className="button primary"
              disabled={
                busy || !chosen || !Object.keys(selected).length || (mode === 'smtp' && !channelId)
              }
              onClick={() =>
                perform(async () => {
                  setPreview(
                    await api('/email/preview', 'POST', {
                      template_id: chosen.id,
                      template_version: chosen.version,
                      order_ids: Object.keys(selected),
                      mode,
                      ...(mode === 'smtp' ? { channel_id: channelId } : {}),
                      client_key: crypto.randomUUID(),
                    }),
                  );
                })
              }
            >
              Podgląd email
            </button>
          </div>
          {preview && (
            <div className="sms-preview">
              <h3>Podgląd partii · {preview.items.length} wiadomości</h3>
              <p>
                Zmiana zamówienia, szablonu lub konta przed zatwierdzeniem wymaga nowego podglądu.
              </p>
              {preview.items.map((m: any) => (
                <article className="sms-message" key={m.id}>
                  <div>
                    <strong>{m.number}</strong>
                    <span className="tag-pill">{names[m.state]}</span>
                  </div>
                  <small>
                    Do: {m.payload?.recipient || '—'} · Od:{' '}
                    {m.sender ? `${m.sender.name} <${m.sender.email}>` : 'Symulacja'}
                  </small>
                  <h4>{m.payload?.subject}</h4>
                  <p className="sms-text">{m.payload?.text}</p>
                  <EmailAttachment
                    file={m.payload?.attachment}
                    messageId={m.state === 'invalid' ? undefined : m.id}
                  />
                  {m.payload?.html && (
                    <details>
                      <summary>Podgląd HTML</summary>
                      <iframe
                        title={'HTML email ' + m.number}
                        sandbox=""
                        referrerPolicy="no-referrer"
                        srcDoc={m.payload.html}
                        style={{
                          width: '100%',
                          minHeight: 150,
                          border: '1px solid #ddd',
                          background: 'white',
                        }}
                      />
                    </details>
                  )}
                  {m.error && <p className="error">{m.error}</p>}
                </article>
              ))}
              {preview.state === 'preview' && (
                <>
                  {external && (
                    <label className="check-line">
                      <input
                        type="checkbox"
                        checked={externalConfirmed}
                        onChange={(e) => setExternalConfirmed(e.target.checked)}
                      />{' '}
                      Zatwierdzam wysyłkę do wskazanych odbiorców przez zewnętrzne SMTP
                    </label>
                  )}
                  <button
                    className="button primary"
                    disabled={busy || !valid || (external && !externalConfirmed)}
                    onClick={() =>
                      perform(async () =>
                        setPreview(
                          await api('/email/batches/' + preview.id + '/queue', 'POST', {
                            confirmed: true,
                            confirm_external: externalConfirmed,
                          }),
                        ),
                      )
                    }
                  >
                    Zatwierdź{' '}
                    {preview.mode === 'local'
                      ? 'symulację'
                      : external
                        ? 'wysyłkę SMTP'
                        : 'lokalny SMTP'}{' '}
                    ({valid})
                  </button>
                </>
              )}
              <BatchResultTools
                batch={preview}
                names={names}
                kind="email"
                busy={busy}
                onRetry={
                  orderId
                    ? undefined
                    : (orders) => {
                        setSelected(orders);
                        change();
                        setNotice('Wybrano zamówienia z nieudanymi wiadomościami. Popraw dane i przygotuj nowy podgląd.');
                      }
                }
              />
              {['preview', 'queued'].includes(preview.state) && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    perform(async () =>
                      setPreview(
                        await api('/email/batches/' + preview.id + '/cancel', 'POST', {
                          confirmed: true,
                        }),
                      ),
                    )
                  }
                >
                  Anuluj oczekujące email
                </button>
              )}
            </div>
          )}
        </section>
      )}
      <section className="panel ops-panel">
        <div className="panel-heading">
          <div>
            <h2>Historia email</h2>
            <p>
              SMTP potwierdza przyjęcie, nie doręczenie. Wynik niepewny wymaga sprawdzenia konta;
              automatyczna wysyłka nie jest ponawiana.
            </p>
          </div>
          <button
            className="button"
            onClick={() => {
              setHistoryCursor('');
              setLocal((n) => n + 1);
            }}
          >
            Odśwież historię email
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Data / zamówienie</th>
                <th>Odbiorca / temat</th>
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
                  <td>
                    {m.payload?.recipient || '—'}
                    <small className="cell-sub">{m.payload?.subject}</small>
                    <EmailAttachment
                      file={m.payload?.attachment}
                      messageId={m.state === 'invalid' ? undefined : m.id}
                    />
                  </td>
                  <td>
                    {names[m.state]}
                    <small>
                      {m.automation_run_id
                        ? 'Reguła automatyczna'
                        : m.automation_schedule_run_id
                          ? 'Harmonogram'
                          : m.order_batch_id
                            ? 'Operacja masowa'
                            : 'Email ręczny'}
                    </small>
                    <small className="cell-sub">
                      {m.error ||
                        (m.sender?.local_sink
                          ? 'Lokalny odbiornik — bez doręczenia'
                          : m.result?.accepted_by_smtp
                            ? 'SMTP przyjął wiadomość — doręczenie niepotwierdzone'
                            : '')}
                    </small>
                    {m.state === 'uncertain' && (
                      <small className="cell-sub">
                        Message-ID: {'<' + m.id + '@dynaminds.local>'}
                      </small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {history?.next_cursor && (
          <button className="button" onClick={() => setHistoryCursor(history.next_cursor)}>
            Starsze wiadomości email
          </button>
        )}
      </section>
    </div>
  );
}
