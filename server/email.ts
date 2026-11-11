import { checkEmailOrigin, lockEmailQueue } from './email-actions';
import { randomUUID } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { ensure, Problem } from './errors';
import { audit, type Actor } from './domain';
import { SmtpClient, smtpSettings, localSmtpPort } from './smtp';
import { decrypt, encrypt } from './security';
import { emailAttachment, savedEmailFile, EMAIL_BATCH_FILE_LIMIT } from './email-attachments';
import {
  isPortalLink,
  orderMessageValues,
  orderVariables,
  rowVariables,
  sampleMessageValues,
  usedVariables,
} from './message-variables';

import { teamEmailAddresses } from './team-email-recipients';
import { emailHash, emailChannelHash } from './email-hash';
export { emailHash, emailChannelHash } from './email-hash';
export const emailTemplate = z
  .object({
    name: z.string().trim().min(2).max(120),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20000),
    html: z.string().max(20000).default(''),
    active: z.boolean().default(true),
    attachment: z.enum(['none', 'invoice', 'odoo_invoice']).default('none'),
  })
  .strict();
export const emailPreview = z
  .object({
    template_id: z.uuid(),
    template_version: z.string().regex(/^\d+$/),
    order_ids: z
      .array(z.uuid())
      .min(1)
      .max(200)
      .refine((v) => new Set(v).size === v.length, 'Powtórzone zamówienie'),
    mode: z.enum(['local', 'smtp']).default('local'),
    channel_id: z.uuid().optional(),
    client_key: z.uuid(),
  })
  .strict()
  .refine(
    (v) => (v.mode === 'smtp' ? Boolean(v.channel_id) : !v.channel_id),
    'SMTP wymaga skrzynki; symulacja jest bez połączenia',
  );
export const emailConfirmation = z
  .object({ confirmed: z.literal(true), confirm_external: z.boolean().default(false) })
  .strict();
export const emailVariables = [...rowVariables, ...orderVariables];
const variables = emailVariables;
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function cleanEmailHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'strong',
      'em',
      'b',
      'i',
      'u',
      'h1',
      'h2',
      'h3',
      'ul',
      'ol',
      'li',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'a',
      'blockquote',
    ],
    allowedAttributes: { a: ['href', 'title'] },
    // http is allowed only for the exact local buyer-portal link ({{portal_link}}); every other
    // http href is dropped before the scheme filter runs.
    allowedSchemes: ['https', 'mailto', 'http'],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href ?? '';
        if (!/^http:/i.test(href.replace(/[\u0000-\u0020]/g, '')) || isPortalLink(href))
          return { tagName, attribs };
        const { href: _dropped, ...rest } = attribs;
        return { tagName, attribs: rest };
      },
    },
  });
}
export function validateEmailTemplate(t: z.infer<typeof emailTemplate>) {
  for (const value of [t.subject, t.body, t.html]) {
    const stripped = value.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => {
      ensure(variables.includes(key), 422, 'Nieznana zmienna: ' + key);
      return '';
    });
    ensure(!/[{}]/.test(stripped), 422, 'Użyj zmiennych {{order_number}}');
    ensure(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value), 422, 'Niedozwolony znak kontrolny');
  }
  ensure(!/[\r\n]/.test(t.subject), 422, 'Temat musi mieć jeden wiersz');
  return { ...t, html: cleanEmailHtml(t.html) };
}
function fillEmail(t: any, values: Record<string, string>) {
  const fill = (s: string, html = false) =>
    s.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => (html ? escape(values[key]) : values[key]));
  const subject = fill(t.subject),
    text = fill(t.body),
    html = t.html
      ? cleanEmailHtml(fill(t.html, true))
      : '<p>' + escape(text).replace(/\n/g, '<br>') + '</p>';
  ensure(
    subject.length <= 200 &&
      !/[\r\n\u0000-\u001f\u007f]/.test(subject) &&
      text.length <= 30000 &&
      html.length <= 50000,
    422,
    'Wiadomość po wstawieniu danych przekracza limit lub temat jest niepoprawny',
  );
  return { subject, text, html };
}
async function render(
  c: PoolClient,
  t: any,
  o: any,
  file?: Awaited<ReturnType<typeof emailAttachment>>,
  teamRecipient?: string,
) {
  // A team e-mail (v2 notify_team) goes to a team member's address, never to an address from the order.
  const recipient = z.string().trim().toLowerCase().max(254).pipe(z.email()).safeParse(teamRecipient ?? o.email);
  ensure(recipient.success, 422, teamRecipient === undefined ? 'Zamówienie nie ma poprawnego adresu email' : 'Osoba z zespołu nie ma poprawnego adresu email');
  const values = await orderMessageValues(c, o, usedVariables([t.subject, t.body, t.html ?? '']));
  const filled = fillEmail(t, values);
  const attachment = file === undefined ? await emailAttachment(c, t, o) : file;
  return {
    recipient: recipient.data,
    ...filled,
    ...(attachment ? { attachment: attachment.meta } : {}),
  };
}
/** Payload of a team e-mail (snapshot.team_user_id): the template filled with the order's variables, no attachment.
 * processEmail renders the same snapshot again for the member's current address before the send. */
export async function renderTeamEmail(c: PoolClient, snapshot: Record<string, unknown>, o: any, recipient: string) {
  return render(c, snapshot, o, null, recipient);
}
export const emailTemplatePreview = z
  .object({
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20000),
    html: z.string().max(20000).default(''),
    order_id: z.uuid().optional(),
  })
  .strict();
/** Live editor preview: renders an unsaved template against one order of the tenant
 * (RLS scope of the caller's tenantTx) or sample data. No batch, job or attachment is created. */
export async function previewEmailTemplate(c: PoolClient, input: z.infer<typeof emailTemplatePreview>) {
  const t = validateEmailTemplate({ name: 'Podgląd', active: true, attachment: 'none', ...input });
  if (!input.order_id)
    return { sample: true, recipient: 'kupujacy@example.test', ...fillEmail(t, sampleMessageValues) };
  const o = (await c.query('SELECT * FROM orders WHERE id=$1', [input.order_id])).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia w firmie');
  const { attachment: _none, ...rendered } = await render(c, t, o, null);
  return { sample: false, order_number: o.number, ...rendered };
}
async function channel(c: PoolClient, id: string) {
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [id])).rows[0];
  ensure(ch?.provider === 'smtp', 422, 'Wymagane konto SMTP');
  const s = smtpSettings.parse(ch.settings);
  ensure(s.delivery !== 'local_sink' || ch.mode === 'sandbox', 422, 'Lokalny SMTP wymaga sandbox');
  return { ch, s };
}
export async function emailBatch(c: PoolClient, id: string) {
  const b = (await c.query('SELECT * FROM email_batches WHERE id=$1', [id])).rows[0];
  ensure(b, 404, 'Nie znaleziono partii email');
  return {
    ...b,
    items: (
      await c.query('SELECT * FROM email_messages WHERE batch_id=$1 ORDER BY number,id', [id])
    ).rows,
  };
}
export async function prepareEmail(c: PoolClient, a: Actor, b: z.infer<typeof emailPreview>) {
  ensure(a.role !== 'viewer', 403, 'Brak prawa komunikacji');
  await lockEmailQueue(c, a.tenantId);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'email-preview:' + a.tenantId + ':' + b.client_key,
  ]);
  const hash = emailHash({ ...b, order_ids: [...b.order_ids].sort() }),
    old = (await c.query('SELECT * FROM email_batches WHERE client_key=$1', [b.client_key]))
      .rows[0];
  if (old) {
    ensure(
      old.actor_id === a.userId && old.request_hash === hash,
      409,
      'Klucz podglądu ma inny zakres',
    );
    return emailBatch(c, old.id);
  }
  const t = (await c.query('SELECT * FROM email_templates WHERE id=$1 FOR SHARE', [b.template_id]))
    .rows[0];
  ensure(
    t?.active && t.version === b.template_version,
    409,
    'Szablon zmienił się lub jest wyłączony',
  );
  const connection = b.channel_id ? await channel(c, b.channel_id) : null;
  ensure(
    !connection || connection.s.delivery === 'local_sink' || a.role === 'admin',
    403,
    'Zewnętrzny SMTP wymaga administratora',
  );
  const orders = (
    await c.query('SELECT * FROM orders WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [
      b.order_ids,
    ])
  ).rows;
  ensure(orders.length === b.order_ids.length, 404, 'Nie znaleziono wszystkich zamówień w firmie');
  const id = randomUUID();
  await c.query(
    'INSERT INTO email_batches(id,tenant_id,actor_id,template_id,template_version,mode,channel_id,channel_hash,client_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      id,
      a.tenantId,
      a.userId,
      t.id,
      t.version,
      b.mode,
      connection?.ch.id ?? null,
      connection ? emailChannelHash(connection.ch) : null,
      b.client_key,
      hash,
    ],
  );
  let attachmentBytes = 0;
  for (const o of orders) {
    let payload: any = null,
      error: null | string = null;
    let file: Awaited<ReturnType<typeof emailAttachment>> = null;
    try {
      file = await emailAttachment(c, t, o);
      payload = await render(c, t, o, file);
      if (file && connection?.s.delivery === 'external')
        ensure(
          file.meta.mode === 'external',
          422,
          'Zewnętrzne SMTP wymaga rzeczywistego dokumentu; załączniki DEMO są dostępne lokalnie',
        );
      if (connection?.s.delivery === 'local_sink')
        ensure(payload.recipient.endsWith('.test'), 422, 'Lokalny SMTP wymaga odbiorcy .test');
    } catch (e) {
      if (!(e instanceof Problem)) throw e;
      error = e.message;
    }
    if (file && !error) attachmentBytes += file.bytes.length;
    ensure(
      attachmentBytes <= EMAIL_BATCH_FILE_LIMIT,
      422,
      'Załączniki partii przekraczają 20 MiB; wybierz mniej zamówień',
    );
    const messageId = randomUUID();
    await c.query(
      'INSERT INTO email_messages(id,tenant_id,batch_id,order_id,number,snapshot,payload,sender,state,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        messageId,
        a.tenantId,
        id,
        o.id,
        o.number,
        JSON.stringify({
          version: o.version,
          subject: t.subject,
          body: t.body,
          html: t.html,
          attachment: t.attachment ?? 'none',
        }),
        payload ? JSON.stringify(payload) : null,
        connection
          ? JSON.stringify({
              email: connection.s.from_email,
              name: connection.s.from_name,
              local_sink: connection.s.delivery === 'local_sink',
            })
          : null,
        error ? 'invalid' : 'draft',
        error,
      ],
    );
    if (file && !error)
      await c.query(
        'INSERT INTO email_message_files(tenant_id,message_id,filename,content_type,size,sha256,content_encrypted) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          a.tenantId,
          messageId,
          file.meta.filename,
          file.meta.content_type,
          file.meta.size,
          file.meta.sha256,
          encrypt({ file_base64: file.bytes.toString('base64') }),
        ],
      );
  }
  await audit(c, a, 'email.preview', id, { count: orders.length, mode: b.mode });
  return emailBatch(c, id);
}
export async function queueEmail(
  c: PoolClient,
  a: Actor,
  id: string,
  confirm: z.infer<typeof emailConfirmation>,
) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'email-queue:' + a.tenantId,
  ]);
  const b = (await c.query('SELECT * FROM email_batches WHERE id=$1 FOR UPDATE', [id])).rows[0];
  ensure(b, 404, 'Brak partii');
  ensure(b.actor_id === a.userId, 403, 'Zatwierdza autor podglądu');
  if (b.state !== 'preview') {
    ensure(['queued', 'done'].includes(b.state), 409, 'Partia anulowana');
    return emailBatch(c, id);
  }
  ensure(new Date(b.created_at).getTime() > Date.now() - 30 * 60000, 409, 'Podgląd wygasł');
  const role = (
    await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
      a.tenantId,
      a.userId,
    ])
  ).rows[0]?.role;
  ensure(role && role !== 'viewer', 403, 'Brak aktualnego prawa komunikacji');
  const t = (await c.query('SELECT * FROM email_templates WHERE id=$1 FOR SHARE', [b.template_id]))
    .rows[0];
  ensure(t?.active && t.version === b.template_version, 409, 'Szablon zmienił się');
  if (b.channel_id) {
    const { ch, s } = await channel(c, b.channel_id);
    ensure(emailChannelHash(ch) === b.channel_hash, 409, 'Skrzynka zmieniła się');
    if (s.delivery === 'external') {
      ensure(
        role === 'admin' && confirm.confirm_external,
        403,
        'Wymagana zgoda administratora na zewnętrzną wysyłkę',
      );
      ensure(
        process.env.DYNA_ALLOW_EXTERNAL_EMAIL === 'true',
        423,
        'Zewnętrzny email wymaga autoryzacji operatora',
      );
    }
  }
  const items = (
    await c.query(
      "SELECT * FROM email_messages WHERE batch_id=$1 AND state='draft' ORDER BY order_id FOR UPDATE",
      [id],
    )
  ).rows;
  ensure(items.length > 0, 409, 'Brak poprawnych wiadomości');
  ensure(
    (await c.query("SELECT count(*)::int n FROM jobs WHERE (state='pending' OR state='running')")).rows[0]
      .n +
      items.length <=
      1000,
    409,
    'Kolejka pełna',
  );
  for (const m of items) {
    if (b.mode === 'smtp' && !m.sender?.local_sink && m.payload?.attachment)
      ensure(
        m.payload.attachment.mode === 'external',
        422,
        'Zewnętrzne SMTP wymaga rzeczywistego dokumentu',
      );
    const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR SHARE', [m.order_id])).rows[0];
    ensure(
      o?.version === m.snapshot.version &&
        emailHash(await render(c, m.snapshot, o)) === emailHash(m.payload),
      409,
      'Zamówienie zmieniło się',
    );
    if (m.payload?.attachment) await savedEmailFile(c, m.id, m.payload.attachment);
    const job = randomUUID();
    await c.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,'email.send',$3,$4,3)",
      [job, a.tenantId, JSON.stringify({ message_id: m.id }), 'email:' + m.id],
    );
    await c.query(
      "UPDATE email_messages SET state='queued',job_id=$2,updated_at=now() WHERE id=$1",
      [m.id, job],
    );
  }
  await c.query("UPDATE email_batches SET state='queued' WHERE id=$1", [id]);
  await audit(c, a, 'email.queue', id, { count: items.length, mode: b.mode });
  return emailBatch(c, id);
}
export async function finishEmailBatch(c: PoolClient, id: string) {
  await c.query(
    "UPDATE email_batches SET state='done' WHERE id=$1 AND state='queued' AND NOT EXISTS(SELECT 1 FROM email_messages WHERE batch_id=$1 AND state='queued')",
    [id],
  );
}
export async function processEmail(job: any,automatic?:{localSinkOnly:true;beforeAttemptInTx:(c:PoolClient)=>Promise<void>}) {
  const prepared = await tenantTx(job.tenant_id, async (c) => {
    if(automatic)await automatic.beforeAttemptInTx(c);
    await lockEmailQueue(c, job.tenant_id);
    const j = (
      await c.query(
        "SELECT id FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 AND locked_at>clock_timestamp()-interval '2 minutes' FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rows[0];
    if (!j) return null;
    const m = (
      await c.query(
        'SELECT m.*,b.actor_id,b.mode,b.channel_id,b.channel_hash,b.template_id,to_jsonb(b) AS origin FROM email_messages m JOIN email_batches b ON (b.tenant_id,b.id)=(m.tenant_id,m.batch_id) WHERE m.id=$1 AND m.job_id=$2 FOR UPDATE OF m',
        [job.payload.message_id, job.id],
      )
    ).rows[0];
    ensure(m, 404, 'Brak wiadomości email');
    if (m.state !== 'queued') {
      await c.query("UPDATE jobs SET state='done',lease_token=NULL WHERE id=$1", [job.id]);
      return null;
    }
    if (m.attempted_at) {
      await c.query(
        "UPDATE email_messages SET state='uncertain',error='Rozpoczęta próba SMTP; brak automatycznego ponowienia',updated_at=now() WHERE id=$1",
        [m.id],
      );
      await c.query("UPDATE jobs SET state='done',lease_token=NULL WHERE id=$1", [job.id]);
      await finishEmailBatch(c, m.batch_id);
      return null;
    }
    await checkEmailOrigin(c, { ...m, ...m.origin, id: m.id });
    const inbound=Boolean(m.origin?.inbound_reply_preview_id);
    const grant=inbound?(await c.query('SELECT email_inbound_worker_context($1,false) g',[m.id])).rows[0].g:null;
    const role=inbound?grant.role:(await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2',[job.tenant_id,m.actor_id])).rows[0]?.role;
    ensure(role&&role!=='viewer',403,'Autor utracił prawo komunikacji');
    if(!inbound){const t=(await c.query('SELECT active FROM email_templates WHERE id=$1 FOR SHARE',[m.template_id])).rows[0];ensure(t?.active,409,'Szablon wyłączony');}
    let ch:any=null;
    if(m.channel_id){const connection=await channel(c,m.channel_id);ch=connection.ch;
      if(!inbound)ensure(emailChannelHash(ch)===m.channel_hash,409,'Skrzynka zmieniła się');
      if(connection.s.delivery==='external')ensure(role==='admin'&&process.env.DYNA_ALLOW_EXTERNAL_EMAIL==='true',403,'Brak autoryzacji zewnętrznej wysyłki');
    }
    if(automatic)ensure(m.mode==='smtp'&&ch?.mode==='sandbox'&&ch.settings?.delivery==='local_sink'
      &&ch.settings.host==='127.0.0.1'&&Number(ch.settings.port)===localSmtpPort()&&m.sender?.local_sink===true
      &&m.payload?.recipient?.endsWith('.test'),403,'Automatyczny email jest wyłącznie lokalnym SMTP .test');
    const teamUser=m.snapshot?.team_user_id;
    const teamRecipient=teamUser?(await teamEmailAddresses(job.tenant_id,[teamUser])).get(teamUser):undefined;
    if(teamUser){ensure(teamRecipient,409,'Adresat e-maila nie należy już do zespołu firmy');ensure(teamRecipient===m.payload?.recipient,409,'Adres e-mail osoby z zespołu zmienił się');}
    if(!inbound){const o=(await c.query('SELECT * FROM orders WHERE id=$1 FOR SHARE',[m.order_id])).rows[0];ensure((m.origin?.order_guard==='content'||o?.version===m.snapshot.version)&&emailHash(teamUser?await renderTeamEmail(c,m.snapshot,o,teamRecipient!):await render(c,m.snapshot,o))===emailHash(m.payload),409,'Zamówienie zmieniło się');}
    const attachment = m.payload?.attachment
      ? await savedEmailFile(c, m.id, m.payload.attachment)
      : null;
    if (attachment && ch && smtpSettings.parse(ch.settings).delivery === 'external')
      ensure(
        m.payload.attachment.mode === 'external',
        422,
        'Załącznik DEMO nie może być wysłany zewnętrznie',
      );
    await c.query('UPDATE email_messages SET attempted_at=now(),updated_at=now() WHERE id=$1', [
      m.id,
    ]);
    if(inbound){
      // No grant is pinned until every core/FK wait and output preparation has finished.
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await c.query('SELECT email_inbound_worker_context($1,true)',[m.id]);
    }
    return { m, ch, attachment };
  });
  if (!prepared) return;
  const { m, ch, attachment } = prepared;
  let state = 'simulated',
    result: any = { local: true, delivered: false },
    error: null | string = null;
  if (m.mode === 'smtp') {
    try {
      result = await new SmtpClient(ch.settings, decrypt(ch.credentials)).send({
        id: m.id,
        recipient: m.payload.recipient,
        subject: m.payload.subject,
        text: m.payload.text,
        html: m.payload.html,
        ...(m.origin?.inbound_reply_preview_id?{in_reply_to:m.payload.in_reply_to,references:m.payload.references}:{}),
        ...(attachment
          ? {
              attachment: {
                filename: attachment.filename,
                content_type: attachment.content_type,
                content: attachment.bytes,
              },
            }
          : {}),
      });
      state = 'smtp_accepted';
    } catch {
      state = 'uncertain';
      result = null;
      error =
        'Niepotwierdzony wynik SMTP. Sprawdź konto lub lokalny odbiornik; wiadomość nie zostanie ponowiona automatycznie.';
    }
  }
  await tenantTx(job.tenant_id, async (c) => {
    if (
      !(
        await c.query(
          "SELECT id FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 AND locked_at>clock_timestamp()-interval '2 minutes' FOR UPDATE",
          [job.id, job.lease_token],
        )
      ).rowCount
    )
      return;
    await c.query(
      "UPDATE email_messages SET state=$2,result=$3,error=$4,updated_at=now() WHERE id=$1 AND state='queued'",
      [m.id, state, JSON.stringify(result), error],
    );
    await c.query("UPDATE jobs SET state='done',lease_token=NULL,error=$2 WHERE id=$1", [
      job.id,
      error,
    ]);
    await finishEmailBatch(c, m.batch_id);
    await audit(c, { tenantId: job.tenant_id, userId: m.actor_id }, 'email.result', m.id, {
      state,
      mode: m.mode,
    });
  });
}
export async function failEmail(job: any, _error: unknown) {
  await tenantTx(job.tenant_id, async (c) => {
    if (
      !(
        await c.query(
          "SELECT id FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",
          [job.id, job.lease_token],
        )
      ).rowCount
    )
      return;
    const m = (
      await c.query('SELECT * FROM email_messages WHERE id=$1 FOR UPDATE', [job.payload.message_id])
    ).rows[0];
    if (m) {
      await c.query(
        "UPDATE email_messages SET state=CASE WHEN attempted_at IS NULL THEN 'failed' ELSE 'uncertain' END,error='Przetwarzanie email zatrzymane; brak automatycznego ponowienia',updated_at=now() WHERE id=$1 AND state='queued'",
        [m.id],
      );
      await finishEmailBatch(c, m.batch_id);
    }
    await c.query(
      "UPDATE jobs SET state='failed',lease_token=NULL,error='Email zatrzymany' WHERE id=$1",
      [job.id],
    );
  });
}
