import { useEffect, useState } from 'react';
import { api } from './api';
import {readLocalEffectOptions} from './automation-local-effects';
import { EmailAttachment } from './email-attachment';
export function EmailActionFields({
  value,
  onChange,
  versioned,
  localAutomaticContext,
}: {
  value: any;
  onChange: (v: any) => void;
  versioned: boolean;
  localAutomaticContext?: string;
}) {
  const [templates, setTemplates] = useState<any[]>([]),
    [channels, setChannels] = useState<any[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setChannels([]);setTemplates([]);setError('');
    Promise.all([api('/email/templates'), api(localAutomaticContext?'/automations/local-effects/options':'/integrations')])
      .then(([t, c]) => {
        if (live) {
          setTemplates(t.data);
          setChannels(localAutomaticContext?readLocalEffectOptions(c,localAutomaticContext).smtp_channels.map((v:any)=>({...v,settings:{delivery:'local_sink'}})):c.channels.filter((v: any) => v.provider === 'smtp'));
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [localAutomaticContext]);
  const change = (extra: any) => {
    const { confirmed, channel_hash, order_version, ...rest } = value;
    onChange({ ...rest, ...extra, client_key: crypto.randomUUID() });
  };
  const external =
    channels.find((c) => c.id === value.channel_id)?.settings?.delivery === 'external';
  return (
    <div className="sms-action-fields">
      <select
        aria-label="Szablon akcji email"
        value={value.template_id}
        onChange={(e) =>
          change({
            template_id: e.target.value,
            template_version: versioned
              ? templates.find((t) => t.id === e.target.value)?.version
              : undefined,
          })
        }
      >
        <option value="">Wybierz szablon email</option>
        {templates
          .filter((t) => t.active)
          .map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
      </select>
      <select
        aria-label="Tryb akcji email"
        value={value.mode}
        onChange={(e) =>
          change({ mode: e.target.value, channel_id: undefined, confirm_external: false })
        }
      >
        <option value="local">Symulacja lokalna</option>
        <option value="smtp">SMTP</option>
      </select>
      {value.mode === 'smtp' && (
        <select
          aria-label="Konto akcji email"
          value={value.channel_id ?? ''}
          onChange={(e) => change({ channel_id: e.target.value, confirm_external: false })}
        >
          <option value="">Wybierz konto SMTP</option>
          {channels.map((c) => (
            <option value={c.id} key={c.id}>
              {c.name}
              {c.settings.delivery === 'local_sink'
                ? ' · lokalny odbiornik'
                : ' · wysyłka zewnętrzna'}
            </option>
          ))}
        </select>
      )}
      {external && (
        <label>
          <input
            type="checkbox"
            checked={value.confirm_external ?? false}
            onChange={(e) => change({ confirm_external: e.target.checked })}
          />
          Zezwalam tej akcji na zewnętrzny email do kupującego. Wymaga administratora i włączonej
          wysyłki na serwerze.
        </label>
      )}
      <small>
        Odbiorcą jest kupujący zamówienia.{' '}
        {value.mode === 'local'
          ? 'Symulacja bez połączenia SMTP.'
          : external
            ? 'Akceptacja SMTP nie potwierdza doręczenia.'
            : 'Lokalny odbiornik przyjmuje adresy .test i nie przekazuje wiadomości dalej.'}
      </small>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
export function EmailActionReceipts({
  actions,
  preview = false,
}: {
  actions?: any[];
  preview?: boolean;
}) {
  return (
    <>
      {actions
        ?.filter((a) => a.email)
        .map((a, i) => (
          <article key={a.email.message_id ?? i} className="sms-preview email-action-receipt">
            <small>
              {preview ? 'Podgląd email' : 'Email zapisany w kolejce · wynik w historii email'} ·{' '}
              {a.email.recipient}
            </small>
            <strong>{a.email.payload?.subject}</strong>
            <p className="sms-text">{a.email.payload?.text}</p>
            <EmailAttachment
              file={a.email.payload?.attachment}
              messageId={preview ? undefined : a.email.message_id}
            />
            {a.email.payload?.html && (
              <details>
                <summary>Podgląd HTML akcji</summary>
                <iframe sandbox="" title="Podgląd HTML akcji email" srcDoc={a.email.payload.html} />
              </details>
            )}
            <small>
              {a.email.mode === 'local'
                ? 'Symulacja lokalna'
                : a.email.sender?.local_sink
                  ? 'Lokalny odbiornik SMTP — bez wysyłki zewnętrznej'
                  : 'SMTP — akceptacja nie potwierdza doręczenia'}
            </small>
          </article>
        ))}
    </>
  );
}
