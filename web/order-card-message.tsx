/** "✉ Wyślij e-mail" / "💬 Wyślij SMS" on the KLIENT card: the existing template flow for this order
 * (POST /orders/:id/operations/preview, then the confirmed operation that queues the message),
 * the same one as in "Organizacja pracy", limited to one message kind. */
import { useState, type FormEvent } from 'react';
import { api } from './api';
import { EmailActionFields, EmailActionReceipts } from './email-action';
import { SmsActionFields, SmsActionReceipts } from './sms-action';
import { Dialog } from './order-detail-parts';
import type { Row } from './order-card-model';

export type MessageKind = 'email' | 'sms';
const newAction = (type: MessageKind): Row => ({ type, template_id: '', mode: 'local', client_key: crypto.randomUUID() });

/** `blocked`: the card's write custody (refresh in flight, pending B2B recovery); no preview or send then. */
export function OrderMessageDialog({ order, kind, blocked, onClose, onSent }: { order: Row; kind: MessageKind; blocked: boolean; onClose: () => void; onSent: () => void }) {
  const [action, setAction] = useState<Row>(() => newAction(kind));
  const [preview, setPreview] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const word = kind === 'email' ? 'e-mail' : 'SMS';
  const change = (next: Row) => {
    setAction(next);
    setPreview(null);
  };
  async function showPreview(e: FormEvent) {
    e.preventDefault();
    if (blocked) return;
    if (!action.template_id) return setError('Wybierz szablon wiadomości.');
    setBusy(true);
    setError('');
    try {
      setPreview(await api('/orders/' + order.id + '/operations/preview', 'POST', action));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (!preview?.allowed || blocked) return;
    setBusy(true);
    setError('');
    try {
      await api('/orders/' + order.id + '/operations', 'POST', { ...preview.actions[0], confirmed: true, order_version: preview.order_version });
      onSent();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const recipient = kind === 'email' ? order.email : order.address?.phone;
  return (
    <Dialog title={kind === 'email' ? 'Wyślij e-mail do klienta' : 'Wyślij SMS do klienta'} onClose={onClose} className="order-message-dialog">
      <form className="form-body order-message-form" onSubmit={showPreview}>
        <p className="muted">Odbiorca: <strong>{recipient || '—'}</strong> · zamówienie {order.number}. Treść pochodzi z szablonu.</p>
        {kind === 'email' ? (
          <EmailActionFields value={action} onChange={change} versioned />
        ) : (
          <SmsActionFields value={action} onChange={change} versioned />
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {preview && (
          <div className="sms-preview">
            <h3>Podgląd {word}</h3>
            {preview.allowed ? (
              <>
                <SmsActionReceipts actions={preview.result} preview />
                <EmailActionReceipts actions={preview.result} preview />
              </>
            ) : (
              <p className="error">{preview.error}</p>
            )}
          </div>
        )}
        <div className="order-form-actions">
          <button type="button" className="button" onClick={onClose}>Anuluj</button>
          {preview?.allowed ? (
            <button type="button" className="button primary" disabled={busy || blocked} onClick={send}>
              {action.mode === 'local' ? `Zapisz symulację ${word}` : `Wyślij ${word}`}
            </button>
          ) : (
            <button className="button primary" disabled={busy || blocked}>Pokaż podgląd</button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
