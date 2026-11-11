import { useEffect, useRef, useState } from 'react';
import './messages.css';
import { api } from './api';
import { messageVariables } from './messages-variables';

type Draft = { subject?: string; body: string; html?: string; max_parts?: number };
type Rendered = {
  sample: boolean;
  order_number?: string;
  recipient?: string;
  subject?: string;
  text?: string;
  html?: string;
  payload?: string;
  parts?: number;
  encoding?: string;
  max_parts?: number;
};

export function MessageVariables({ onInsert }: { onInsert?: (tag: string) => void }) {
  return (
    <div className="message-variables">
      <span className="muted">Dostępne zmienne:</span>
      {messageVariables.map((v) =>
        onInsert ? (
          <button
            key={v.key}
            type="button"
            className="button small"
            title={v.label}
            onClick={() => onInsert('{{' + v.key + '}}')}
          >
            {'{{' + v.key + '}}'}
          </button>
        ) : (
          <code key={v.key} title={v.label}>
            {'{{' + v.key + '}}'}
          </code>
        ),
      )}
      <small className="muted">
        {'{{portal_link}}'} wymaga aktywnego linku zamówienia, a {'{{invoice_number}}'} wystawionej
        faktury — inaczej wiadomość zostanie oznaczona jako niepoprawna.
      </small>
    </div>
  );
}

/** Renders the unsaved template on every change (after a short pause) against sample data or
 * one order of the company. Nothing is saved, queued or sent. */
export function TemplateLivePreview({ kind, draft }: { kind: 'email' | 'sms'; draft: Draft }) {
  const [orderNumber, setOrderNumber] = useState('');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [result, setResult] = useState<Rendered | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const body =
    kind === 'email'
      ? { subject: draft.subject ?? '', body: draft.body, html: draft.html ?? '' }
      : { body: draft.body, max_parts: draft.max_parts ?? 3 };
  const key = JSON.stringify([body, orderId]);
  useEffect(() => {
    if (!draft.body.trim() || (kind === 'email' && !(draft.subject ?? '').trim())) {
      setResult(null);
      return;
    }
    const current = ++generation.current;
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api<Rendered>('/' + kind + '/templates/preview', 'POST', {
          ...body,
          ...(orderId ? { order_id: orderId } : {}),
        });
        if (current !== generation.current) return;
        setResult(r);
        setError('');
      } catch (e) {
        if (current !== generation.current) return;
        setResult(null);
        setError((e as Error).message);
      } finally {
        if (current === generation.current) setBusy(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [key]);
  async function chooseOrder() {
    const wanted = orderNumber.trim();
    setError('');
    if (!wanted) {
      setOrderId(null);
      return;
    }
    try {
      const found = await api<{ data: { id: string; number: string }[] }>(
        '/orders?' + new URLSearchParams({ search: wanted, limit: '20' }),
      );
      const exact = found.data.find((o) => o.number === wanted);
      if (!exact) throw new Error('Nie znaleziono zamówienia o numerze ' + wanted);
      setOrderId(exact.id);
    } catch (e) {
      setOrderId(null);
      setError((e as Error).message);
    }
  }
  return (
    <section className="template-live-preview" aria-label="Podgląd szablonu na żywo">
      <div className="panel-heading">
        <div>
          <h3>Podgląd na żywo</h3>
          <p className="muted">
            {orderId
              ? 'Dane zamówienia ' + (result?.order_number ?? orderNumber) + '. Nic nie jest zapisywane ani wysyłane.'
              : 'Dane przykładowe. Wpisz numer zamówienia, aby zobaczyć prawdziwe dane.'}
          </p>
        </div>
        {busy && <small role="status">Odświeżanie…</small>}
      </div>
      <div className="sms-controls">
        <label>
          Zamówienie do podglądu
          <input
            aria-label="Numer zamówienia do podglądu szablonu"
            value={orderNumber}
            placeholder="np. ZAM/2026/0001"
            onChange={(e) => setOrderNumber(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void chooseOrder();
              }
            }}
          />
        </label>
        <button type="button" className="button" onClick={() => void chooseOrder()}>
          {orderNumber.trim() ? 'Użyj zamówienia' : 'Dane przykładowe'}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && kind === 'email' && (
        <article className="sms-message">
          <small>Do: {result.recipient}</small>
          <h4>{result.subject}</h4>
          <p className="sms-text">{result.text}</p>
          {draft.html && result.html && (
            <iframe
              title="Podgląd HTML szablonu"
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={result.html}
              style={{ width: '100%', minHeight: 150, border: '1px solid #ddd', background: 'white' }}
            />
          )}
        </article>
      )}
      {result && kind === 'sms' && (
        <article className="sms-message">
          <small>
            Do: {result.recipient} · {result.encoding} · {result.parts} z {result.max_parts} części
          </small>
          <p className="sms-text">{result.payload}</p>
          {result.parts !== undefined && result.max_parts !== undefined && result.parts > result.max_parts && (
            <p className="error">Wiadomość przekracza limit części.</p>
          )}
        </article>
      )}
    </section>
  );
}
