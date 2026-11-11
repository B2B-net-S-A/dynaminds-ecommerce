import { SmsDeliveryStatus } from './sms-delivery';
import { useEffect, useState } from 'react';
import { api, date } from './api';
export function SmsActionFields({
  value,
  onChange,
  versioned,
}: {
  value: any;
  onChange: (v: any) => void;
  versioned: boolean;
}) {
  const [templates, setTemplates] = useState<any[]>([]),
    [channels, setChannels] = useState<any[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    Promise.all([api('/sms/templates'), api('/integrations')])
      .then(([t, c]) => {
        if (live) {
          setTemplates(t.data);
          setChannels(
            c.channels.filter((v: any) => v.provider === 'smsapi' && v.mode === 'sandbox'),
          );
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="sms-action-fields">
      <select
        aria-label="Szablon akcji SMS"
        value={value.template_id}
        onChange={(e) => {
          const { template_version, confirmed, channel_hash, ...rest } = value;
          onChange({
            ...rest,
            template_id: e.target.value,
            ...(versioned
              ? { template_version: templates.find((t) => t.id === e.target.value)?.version }
              : {}),
            client_key: crypto.randomUUID(),
          });
        }}
      >
        <option value="">Wybierz szablon SMS</option>
        {templates
          .filter((t) => t.active)
          .map((t) => (
            <option value={t.id} key={t.id}>
              {t.name} · do {t.max_parts} części
            </option>
          ))}
      </select>
      <select
        aria-label="Tryb akcji SMS"
        value={value.mode}
        onChange={(e) => {
          const { channel_id, channel_hash, confirmed, ...rest } = value;
          onChange({ ...rest, mode: e.target.value, client_key: crypto.randomUUID() });
        }}
      >
        <option value="local">Symulacja lokalna</option>
        <option value="provider_test">Test SMSAPI — tylko administrator</option>
      </select>
      {value.mode === 'provider_test' && (
        <select
          aria-label="Kanał akcji SMS"
          value={value.channel_id ?? ''}
          onChange={(e) => {
            const { channel_hash, confirmed, ...rest } = value;
            onChange({ ...rest, channel_id: e.target.value, client_key: crypto.randomUUID() });
          }}
        >
          <option value="">Wybierz SMSAPI</option>
          {channels.map((c) => (
            <option value={c.id} key={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      <small>
        Wiadomość trafia do trwałej kolejki.{' '}
        {value.mode === 'local'
          ? 'Bez połączenia z dostawcą.'
          : 'API zawsze test=1 — bez doręczenia.'}
      </small>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
const states: Record<string, string> = {
  draft: 'Podgląd',
  invalid: 'Niepoprawna',
  queued: 'W kolejce',
  simulated: 'Symulacja lokalna',
  tested: 'Test SMSAPI — bez doręczenia',
  uncertain: 'Wynik niepewny',
  failed: 'Błąd',
  cancelled: 'Anulowano',
};
export function SmsActionReceipts({
  actions,
  preview = false,
}: {
  actions?: any[];
  preview?: boolean;
}) {
  return (
    <>
      {actions
        ?.filter((a) => a.sms)
        .map((a, i) => (
          <div key={a.sms.message_id ?? i} className="sms-preview">
            <small>
              {preview ? 'Podgląd SMS' : 'SMS zapisany w kolejce · wynik w historii SMS'} · +
              {a.sms.recipient}
            </small>
            <p className="sms-text">{a.sms.payload}</p>
            <small>
              {a.sms.mode === 'local' ? 'Symulacja lokalna' : 'Test SMSAPI bez doręczenia'}
            </small>
          </div>
        ))}
    </>
  );
}
export function OrderSmsHistory({ orderId }: { orderId: string }) {
  const [data, setData] = useState<any[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const load = () =>
      api('/sms/messages?order_id=' + orderId)
        .then((r) => live && setData(r.data))
        .catch((e) => live && setError(e.message));
    load();
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [orderId]);
  return (
    <section className="panel ops-panel">
      <div className="panel-heading">
        <div>
          <h2>Wiadomości SMS zamówienia</h2>
          <p>Ostatnie 25 pozycji. Pełna historia w Komunikacja SMS.</p>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!data.length && <p className="muted">Brak wiadomości SMS dla tego zamówienia.</p>}
      {data.map((m) => (
        <article key={m.id} className="sms-message">
          <div>
            <strong>{states[m.state]}</strong>
            <small>{date(m.created_at)}</small>
          </div>
          <small>
            {m.recipient ? '+' + m.recipient : 'Brak poprawnego telefonu'} ·{' '}
            {m.mode === 'local' ? 'Lokalnie' : 'SMSAPI test=1'}
          </small>
          <SmsDeliveryStatus mode={m.mode} delivery={m.delivery} />
          <p className="sms-text">{m.payload}</p>
          {m.error && <p className="error">{m.error}</p>}
        </article>
      ))}
    </section>
  );
}
