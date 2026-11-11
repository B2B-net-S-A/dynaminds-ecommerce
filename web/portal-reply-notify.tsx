import { useEffect, useState } from 'react';
import './messages.css';
import { api } from './api';
import { usesPortalLink } from './messages-variables';

type Template = { id: string; name: string; version: string; active: boolean; subject: string; body: string; html: string };
type Channel = { id: string; name: string; provider: string; settings?: { delivery?: string } };
type Batch = {
  id: string;
  state: string;
  mode: string;
  items: { id: string; state: string; error: string | null; payload: { recipient: string; subject: string; text: string } | null }[];
};

/** After a portal reply: tell the buyer by email that an answer is waiting. Uses the normal
 * email preview → confirmation flow (same rights and checks); nothing is sent without it. */
export function PortalReplyNotify({ orderId, admin, disabled }: { orderId: string; admin: boolean; disabled: boolean }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [mode, setMode] = useState<'local' | 'smtp'>('local');
  const [channelId, setChannelId] = useState('');
  const [batch, setBatch] = useState<Batch | null>(null);
  const [confirmExternal, setConfirmExternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    Promise.all([api<{ data: Template[] }>('/email/templates'), api<{ channels: Channel[] }>('/integrations')])
      .then(([t, c]) => {
        if (!live) return;
        const active = t.data.filter((x) => x.active);
        setTemplates(active);
        setChannels(c.channels.filter((x) => x.provider === 'smtp' && (admin || x.settings?.delivery === 'local_sink')));
        const suggested = active.find(usesPortalLink);
        if (suggested) setTemplateId((old) => old || suggested.id);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [orderId, admin]);
  const chosen = templates.find((t) => t.id === templateId);
  const connection = channels.find((c) => c.id === channelId);
  const external = mode === 'smtp' && connection?.settings?.delivery !== 'local_sink';
  const item = batch?.items[0];
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const reset = () => {
    setBatch(null);
    setConfirmExternal(false);
  };
  return (
    <section className="portal-reply-notify" aria-label="Powiadomienie kupującego o odpowiedzi">
      <h3>Powiadom kupującego emailem</h3>
      <p className="muted">
        Odpowiedź w portalu nie wysyła wiadomości. Wybierz szablon z {'{{portal_link}}'}, aby kupujący
        dostał link do rozmowy. Najpierw zobaczysz podgląd; wysyłka wymaga zatwierdzenia.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="sms-controls">
        <label>
          Szablon powiadomienia
          <select
            aria-label="Szablon powiadomienia o odpowiedzi"
            value={templateId}
            disabled={busy || disabled}
            onChange={(e) => {
              setTemplateId(e.target.value);
              reset();
            }}
          >
            <option value="">Wybierz szablon</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {usesPortalLink(t) ? ' · z linkiem do zamówienia' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tryb
          <select
            aria-label="Tryb powiadomienia"
            value={mode}
            disabled={busy || disabled}
            onChange={(e) => {
              setMode(e.target.value as 'local' | 'smtp');
              reset();
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
              aria-label="Konto SMTP powiadomienia"
              value={channelId}
              disabled={busy || disabled}
              onChange={(e) => {
                setChannelId(e.target.value);
                reset();
              }}
            >
              <option value="">Wybierz konto</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!templates.some(usesPortalLink) && templates.length > 0 && (
        <p className="muted">Żaden aktywny szablon nie zawiera {'{{portal_link}}'}. Dodaj go w Komunikacja → Email.</p>
      )}
      {!templates.length && <p className="muted">Brak aktywnych szablonów email.</p>}
      <div className="ops-actions">
        <button
          type="button"
          className="button"
          disabled={busy || disabled || !chosen || (mode === 'smtp' && !channelId)}
          onClick={() =>
            run(async () => {
              setBatch(
                await api<Batch>('/email/preview', 'POST', {
                  template_id: chosen!.id,
                  template_version: chosen!.version,
                  order_ids: [orderId],
                  mode,
                  ...(mode === 'smtp' ? { channel_id: channelId } : {}),
                  client_key: crypto.randomUUID(),
                }),
              );
            })
          }
        >
          Podgląd powiadomienia
        </button>
      </div>
      {batch && item && (
        <article className="sms-message">
          <small>Do: {item.payload?.recipient ?? '—'}</small>
          <h4>{item.payload?.subject}</h4>
          <p className="sms-text">{item.payload?.text}</p>
          {item.error && <p className="error">{item.error}</p>}
          {batch.state === 'preview' && item.state === 'draft' && (
            <>
              {external && (
                <label className="check-line">
                  <input type="checkbox" checked={confirmExternal} onChange={(e) => setConfirmExternal(e.target.checked)} />{' '}
                  Zatwierdzam wysyłkę do kupującego przez zewnętrzne SMTP
                </label>
              )}
              <button
                type="button"
                className="button primary"
                disabled={busy || disabled || (external && !confirmExternal)}
                onClick={() =>
                  run(async () => {
                    const queued = await api<Batch>('/email/batches/' + batch.id + '/queue', 'POST', {
                      confirmed: true,
                      confirm_external: confirmExternal,
                    });
                    setBatch(queued);
                    setNotice(
                      batch.mode === 'local'
                        ? 'Powiadomienie zapisano jako symulację lokalną. Email nie wyszedł poza aplikację.'
                        : 'Powiadomienie jest w kolejce wysyłki. Wynik zobaczysz w historii email zamówienia.',
                    );
                  })
                }
              >
                {batch.mode === 'local' ? 'Zatwierdź symulację powiadomienia' : 'Wyślij powiadomienie'}
              </button>
            </>
          )}
        </article>
      )}
    </section>
  );
}
