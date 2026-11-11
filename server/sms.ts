import { pinSmsSubmissionIntent, registerSmsAcceptedReceipt } from './sms-submission-store';
import { sendSmsApiLive, SmsLiveRejected } from './sms-live-transport';
import { smsApiNotifyUrl } from './sms-delivery';
import { requireSmsLiveAuthority, smsLiveJobAuthority, type LiveAuthority } from './sms-live-authority';
import { checkSmsOrigin } from './sms-actions';
import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { ensure, Problem } from './errors';
import { audit, type Actor } from './domain';
import { SmsApi, SmsRejected } from './smsapi';
import { decrypt } from './security';
import type { IntegrationContext } from './channel-access';
import {
  orderMessageValues,
  orderVariables,
  rowValues,
  rowVariables,
  sampleMessageValues,
  usedVariables,
} from './message-variables';
export const smsHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const smsTemplate = z
  .object({
    name: z.string().trim().min(2).max(120),
    body: z.string().trim().min(1).max(1500),
    max_parts: z.number().int().min(1).max(10).default(3),
    active: z.boolean().default(true),
  })
  .strict();
export const smsPreview = z
  .object({
    template_id: z.uuid(),
    template_version: z.string().regex(/^\d+$/),
    order_ids: z
      .array(z.uuid())
      .min(1)
      .max(250)
      .refine((ids) => new Set(ids).size === ids.length, 'Powtórzone zamówienie'),
    mode: z.enum(['local', 'provider_test', 'provider_live']).default('local'),
    delivery_endpoint_id: z.uuid().optional(),
    channel_id: z.uuid().optional(),
    client_key: z.uuid(),
  })
  .strict()
  .refine(
    (v) => (v.mode === 'local' ? !v.channel_id : Boolean(v.channel_id)) &&
      (v.mode === 'provider_live' ? Boolean(v.delivery_endpoint_id) : !v.delivery_endpoint_id),
    'Test dostawcy wymaga połączenia; symulacja jest bez połączenia',
  );
export const smsVariables = [...rowVariables, ...orderVariables];
const variables = smsVariables;
export function validateSmsBody(body: string) {
  const stripped = body.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => {
    ensure(variables.includes(key), 422, 'Nieznana zmienna szablonu: ' + key);
    return '';
  });
  ensure(!/[{}]/.test(stripped), 422, 'Użyj zmiennych w formacie {{order_number}}');
  ensure(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(body), 422, 'Niedozwolony znak kontrolny');
}
const gsm = new Set(
  Array.from(
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ),
);
const extension = new Set(Array.from('^{}\\[~]|€'));
export function smsLength(body: string) {
  const chars = Array.from(body),
    isGsm = chars.every((c) => gsm.has(c) || extension.has(c));
  const widths = chars.map((c) => (isGsm ? (extension.has(c) ? 2 : 1) : c.length)),
    units = widths.reduce((a, b) => a + b, 0),
    single = isGsm ? 160 : 70,
    multi = isGsm ? 153 : 67;
  let parts = 1,
    used = 0;
  if (units > single)
    for (const w of widths) {
      if (used + w > multi) {
        parts++;
        used = 0;
      }
      used += w;
    }
  return { encoding: isGsm ? 'GSM-7' : 'UTF-16', units, parts };
}
export function smsRecipient(phone: string, country: string) {
  ensure(/^[+\d ()-]+$/.test(phone), 422, 'Brak poprawnego telefonu zamówienia');
  let n = phone.replace(/[ ()-]/g, '');
  if (n.startsWith('00')) n = '+' + n.slice(2);
  if (country === 'PL' && /^\d{9}$/.test(n)) n = '+48' + n;
  if (/^48\d{9}$/.test(n) && country === 'PL') n = '+' + n;
  ensure(/^\+[1-9]\d{7,14}$/.test(n), 422, 'Telefon zagraniczny wymaga + i kodu kraju');
  return n.slice(1);
}
/** Values for the tags used by `body`; extra reads only for tags that need them. */
export function smsValues(c: PoolClient, body: string, o: any) {
  return orderMessageValues(c, o, usedVariables([body]));
}
function fillSms(t: any, values: Record<string, string>) {
  return t.body.replace(/\{\{([a-z_]+)\}\}/g, (_: string, key: string) => {
    ensure(values[key] !== undefined, 422, 'Brak danych zmiennej szablonu: ' + key);
    return values[key];
  });
}
/** `values` from smsValues(); without it only the order-row tags are available. */
export function renderSms(t: any, o: any, values: Record<string, string> = rowValues(o)) {
  validateSmsBody(t.body);
  const payload = fillSms(t, values);
  ensure(
    payload.length <= 1500 && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(payload),
    422,
    'Treść po wstawieniu danych jest za długa lub zawiera znaki kontrolne',
  );
  const length = smsLength(payload);
  ensure(length.parts <= t.max_parts, 422, 'Wiadomość przekracza limit ' + t.max_parts + ' części');
  return {
    payload,
    recipient: smsRecipient(o.address.phone ?? '', o.address.country ?? ''),
    ...length,
    max_parts: t.max_parts,
  };
}
export const smsTemplatePreview = z
  .object({
    body: z.string().trim().min(1).max(1500),
    max_parts: z.number().int().min(1).max(10).default(3),
    order_id: z.uuid().optional(),
  })
  .strict();
/** Live editor preview of an unsaved SMS template: one order of the tenant or sample data.
 * Nothing is saved or queued; the recipient is checked like a real preview. */
export async function previewSmsTemplate(c: PoolClient, input: z.infer<typeof smsTemplatePreview>) {
  validateSmsBody(input.body);
  if (!input.order_id) {
    const payload = fillSms(input, sampleMessageValues);
    return { sample: true, payload, recipient: '48500100200', max_parts: input.max_parts, ...smsLength(payload) };
  }
  const o = (await c.query('SELECT * FROM orders WHERE id=$1', [input.order_id])).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia w firmie');
  return { sample: false, order_number: o.number, ...renderSms(input, o, await smsValues(c, input.body, o)) };
}
export const smsChannelHash = (ch: any) =>
  smsHash({
    provider: ch.provider,
    mode: ch.mode,
    settings: ch.settings,
    credentials: ch.credentials,
  });
export async function smsPrepare(c: PoolClient, a: Actor, b: z.infer<typeof smsPreview>) {
  ensure(a.role !== 'viewer', 403, 'Brak prawa obsługi komunikacji');
  ensure(b.mode === 'local' || a.role === 'admin', 403, 'Test SMSAPI wymaga administratora');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'sms-preview:' + a.tenantId + ':' + b.client_key,
  ]);
  const hash = smsHash({ ...b, order_ids: [...b.order_ids].sort() }),
    old = (await c.query('SELECT * FROM sms_batches WHERE client_key=$1', [b.client_key])).rows[0];
  if (old) {
    ensure(
      old.request_hash === hash && old.actor_id === a.userId,
      409,
      'Klucz podglądu ma inny zakres',
    );
    return smsBatch(c, old.id);
  }
  const t = (await c.query('SELECT * FROM sms_templates WHERE id=$1 FOR SHARE', [b.template_id]))
    .rows[0];
  ensure(t?.active, 422, 'Brak aktywnego szablonu SMS');
  ensure(t.version === b.template_version, 409, 'Szablon zmienił się; przygotuj nowy podgląd');
  let ch: any = null;
  if (b.channel_id) {
    ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [b.channel_id])).rows[0];
    ensure(
      ch?.provider === 'smsapi' && ch.mode === (b.mode === 'provider_live' ? 'live' : 'sandbox') && !ch.settings.simulation,
      422,
      'Wymagane połączenie SMSAPI w trybie testowym',
    );
  }
  if (b.mode === 'provider_live') {
    const e=(await c.query('SELECT * FROM sms_delivery_endpoints WHERE tenant_id=$1 AND id=$2 AND enabled FOR SHARE',[a.tenantId,b.delivery_endpoint_id])).rows[0];
    ensure(e && e.channel_id===ch.id && e.channel_hash===smsChannelHash(ch),409,'Endpoint SMS nie zgadza się z połączeniem');
  }
  const orders = (
    await c.query('SELECT * FROM orders WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [
      b.order_ids,
    ])
  ).rows;
  ensure(
    orders.length === b.order_ids.length,
    404,
    'Nie znaleziono wszystkich zamówień w organizacji',
  );
  const id = randomUUID();
  await c.query(
    'INSERT INTO sms_batches(id,tenant_id,actor_id,template_id,template_version,mode,channel_id,channel_hash,client_key,request_hash,delivery_endpoint_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      id,
      a.tenantId,
      a.userId,
      t.id,
      t.version,
      b.mode,
      ch?.id ?? null,
      ch ? smsChannelHash(ch) : null,
      b.client_key,
      hash,
      b.delivery_endpoint_id ?? null,
    ],
  );
  for (const o of orders) {
    let p: any,
      error: string | null = null;
    try {
      p = renderSms(t, o, await smsValues(c, t.body, o));
    } catch (e) {
      if (!(e instanceof Problem)) throw e;
      error = e.message;
    }
    await c.query(
      'INSERT INTO sms_messages(id,tenant_id,batch_id,order_id,number,snapshot,payload,recipient,encoding,units,parts,max_parts,sender,state,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [
        randomUUID(),
        a.tenantId,
        id,
        o.id,
        o.number,
        JSON.stringify({
          version: o.version,
          template_body: t.body,
          customer_name: o.customer_name,
          total: o.total,
          currency: o.currency,
          status: o.status,
          source: o.source,
          address: o.address,
        }),
        p?.payload ?? null,
        p?.recipient ?? null,
        p?.encoding ?? null,
        p?.units ?? null,
        p?.parts ?? null,
        p?.max_parts ?? null,
        ch?.settings.sender ?? 'Test',
        error ? 'invalid' : 'draft',
        error,
      ],
    );
  }
  await audit(c, a, 'sms.preview', id, { count: orders.length, mode: b.mode });
  return smsBatch(c, id);
}
export async function smsBatch(c: PoolClient, id: string) {
  const b = (await c.query('SELECT * FROM sms_batches WHERE id=$1', [id])).rows[0];
  ensure(b, 404, 'Nie znaleziono partii SMS');
  return {
    ...b,
    items: (await c.query("SELECT m.*,CASE WHEN b.mode='provider_live' THEN jsonb_build_object('status_code',s.status_code,'needs_reconciliation',coalesce(s.needs_reconciliation,false)) ELSE NULL END AS delivery FROM sms_messages m JOIN sms_batches b ON(b.tenant_id,b.id)=(m.tenant_id,m.batch_id) LEFT JOIN sms_delivery_submissions s ON(s.tenant_id,s.message_id)=(m.tenant_id,m.id) WHERE m.batch_id=$1 ORDER BY m.number,m.id", [id]))
      .rows,
  };
}
export async function smsQueue(c: PoolClient, a: Actor, id: string, live?: LiveAuthority) {
  const b = (await c.query('SELECT * FROM sms_batches WHERE id=$1 FOR UPDATE', [id])).rows[0];
  ensure(b, 404, 'Nie znaleziono partii SMS');
  ensure(
    a.userId === b.actor_id && a.role !== 'viewer' && (b.mode === 'local' || a.role === 'admin'),
    403,
    'Zatwierdza autor z prawem do tego trybu',
  );
  if (b.mode === 'provider_live') {
    ensure(live && live.tenantId===a.tenantId && live.userId===a.userId,403,'Potwierdź zewnętrzną wysyłkę w sesji administratora z MFA');
    await requireSmsLiveAuthority(pool,live!);
  }
  if (b.state === 'queued' || b.state === 'done') return smsBatch(c, id);
  ensure(
    b.state === 'preview' && Date.now() - new Date(b.created_at).getTime() < 1800000,
    409,
    'Podgląd wygasł; przygotuj nowy',
  );
  const t = (await c.query('SELECT * FROM sms_templates WHERE id=$1 FOR SHARE', [b.template_id]))
    .rows[0];
  ensure(
    t?.active && t.version === b.template_version,
    409,
    'Szablon zmienił się; przygotuj nowy podgląd',
  );
  if (b.channel_id) {
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [b.channel_id]))
      .rows[0];
    ensure(
      ch && smsChannelHash(ch) === b.channel_hash,
      409,
      'Połączenie zmieniło się; przygotuj nowy podgląd',
    );
  }
  const items = (
    await c.query(
      "SELECT * FROM sms_messages WHERE batch_id=$1 AND state='draft' ORDER BY order_id FOR UPDATE",
      [id],
    )
  ).rows;
  ensure(items.length > 0, 409, 'Brak poprawnych wiadomości');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'sms-queue:' + a.tenantId,
  ]);
  ensure(
    (await c.query("SELECT count(*)::int AS n FROM jobs WHERE (state='pending' OR state='running')"))
      .rows[0].n +
      items.length <=
      1000,
    409,
    'Kolejka jest pełna; spróbuj później',
  );
  if (b.mode === 'provider_live') {
    await c.query('INSERT INTO sms_live_queue_authorities(tenant_id,batch_id,actor_id,session_hash) VALUES($1,$2,$3,$4)',[a.tenantId,id,a.userId,live!.sessionHash]);
  }
  for (const m of items) {
    const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR SHARE', [m.order_id])).rows[0];
    const rendered = renderSms(
      { body: m.snapshot.template_body, max_parts: m.max_parts },
      o,
      await smsValues(c, m.snapshot.template_body, o),
    );
    ensure(
      o.version === m.snapshot.version &&
        rendered.recipient === m.recipient &&
        rendered.payload === m.payload,
      409,
      'Zamówienie zmieniło się; przygotuj nowy podgląd',
    );
    const job = randomUUID();
    await c.query(
      'INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,$3,$4,$5,$6)',
      [job, a.tenantId, b.mode==='provider_live'?'sms.send':'sms.test', JSON.stringify({ message_id: m.id }), 'sms:' + m.id,3],
    );
    await c.query("UPDATE sms_messages SET state='queued',job_id=$2,updated_at=now() WHERE id=$1", [
      m.id,
      job,
    ]);
  }
  await c.query("UPDATE sms_batches SET state='queued' WHERE id=$1", [id]);
  await audit(c, a, 'sms.queue', id, { count: items.length, mode: b.mode });
  return smsBatch(c, id);
}
async function finishBatch(c: PoolClient, id: string) {
  await c.query(
    "UPDATE sms_batches SET state='done' WHERE id=$1 AND state='queued' AND NOT EXISTS(SELECT 1 FROM sms_messages WHERE batch_id=$1 AND state='queued')",
    [id],
  );
}
export async function processSms(job: any, ctx: IntegrationContext = {}) {
  const prepared = await tenantTx(job.tenant_id, async (c) => {
    const j = (
      await c.query(
        "SELECT * FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rows[0];
    if (!j) return null;
    const m = (
      await c.query(
        'SELECT m.*,b.actor_id,b.mode,b.channel_id,b.channel_hash,b.delivery_endpoint_id,b.template_id,b.order_guard,b.automation_run_id,b.automation_schedule_run_id,b.order_batch_id FROM sms_messages m JOIN sms_batches b ON (b.tenant_id,b.id)=(m.tenant_id,m.batch_id) WHERE m.id=$1 AND m.job_id=$2 FOR UPDATE OF m',
        [job.payload.message_id, job.id],
      )
    ).rows[0];
    ensure(m, 404, 'Brak wiadomości dla zadania');
    if (m.state !== 'queued') {
      await c.query("UPDATE jobs SET state='done',lease_token=NULL WHERE id=$1", [job.id]);
      return null;
    }
    if (m.attempted_at) {
      await c.query(
        "UPDATE sms_messages SET state='uncertain',error='Poprzednia próba rozpoczęta; brak automatycznego ponowienia',updated_at=now() WHERE id=$1",
        [m.id],
      );
      await c.query("UPDATE jobs SET state='done',lease_token=NULL WHERE id=$1", [job.id]);
      await finishBatch(c, m.batch_id);
      return null;
    }
    const member = (
      await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
        job.tenant_id,
        m.actor_id,
      ])
    ).rows[0];
    ensure(
      member && member.role !== 'viewer' && (m.mode === 'local' || member.role === 'admin'),
      403,
      'Autor utracił prawo do komunikacji',
    );
    if(m.mode==='provider_live'){
      const live=await smsLiveJobAuthority(c,m.batch_id);
      ensure(live.tenantId===job.tenant_id && live.userId===m.actor_id,403,'Inny zakres zgody SMS');
      await requireSmsLiveAuthority(pool,live);
    }
    await checkSmsOrigin(c, m);
    const t = (
      await c.query('SELECT active FROM sms_templates WHERE id=$1 FOR SHARE', [m.template_id])
    ).rows[0];
    ensure(t?.active, 409, 'Szablon SMS wyłączony');
    let credentials: Record<string, string> = {};
    if (m.channel_id) {
      const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [m.channel_id]))
        .rows[0];
      ensure(
        ch?.provider === 'smsapi' && ch.mode === (m.mode==='provider_live'?'live':'sandbox') && smsChannelHash(ch) === m.channel_hash,
        409,
        'Połączenie SMS zmieniło się',
      );
      credentials = decrypt(ch.credentials);
    }
    const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR SHARE', [m.order_id])).rows[0];
    const rendered = renderSms(
      { body: m.snapshot.template_body, max_parts: m.max_parts },
      o,
      await smsValues(c, m.snapshot.template_body, o),
    );
    ensure(
      (m.order_guard === 'content' || o.version === m.snapshot.version) &&
        rendered.recipient === m.recipient &&
        rendered.payload === m.payload,
      409,
      'Zamówienie zmieniło się od podglądu',
    );
    const endpoint=m.mode==='provider_live'?await pinSmsSubmissionIntent(c,m,m.delivery_endpoint_id):null;
    ensure(!endpoint || endpoint.channel_hash===m.channel_hash,409,'Endpoint zmienił się od zgody');
    // Secret callback segment (encrypted credentials); missing token refuses before attempted_at, so nothing is sent.
    const notifyUrl=endpoint?smsApiNotifyUrl(endpoint.callback_url,credentials.callback_token):null;
    await c.query('UPDATE sms_messages SET attempted_at=now(),updated_at=now() WHERE id=$1', [
      m.id,
    ]);
    return { m, credentials, endpoint, notifyUrl };
  });
  if (!prepared) return;
  const { m, credentials, endpoint, notifyUrl } = prepared;
  let result: any = null,
    state = 'simulated',
    error: string | null = null;
  if (m.mode === 'provider_test') {
    try {
      result = await new SmsApi(credentials, ctx.transport).testMessage(m);
      state = 'tested';
    } catch (e) {
      state = e instanceof SmsRejected ? 'failed' : 'uncertain';
      error = e instanceof Problem ? e.message : 'Niepewny wynik testu SMSAPI';
    }
  } else if(m.mode==='provider_live'){
    try{
      const receipt=await sendSmsApiLive(credentials.access_token,{...m,callbackUrl:notifyUrl!},ctx.transport??fetch);
      // Known acceptance is durable independently of job-lease settlement; no second provider POST on retry.
      await tenantTx(job.tenant_id,c=>registerSmsAcceptedReceipt(c,job.tenant_id,m.id,receipt));
      state='submitted'; result={provider_id:receipt.providerId,idx:receipt.idx,date_sent:receipt.providerSentAt,status:receipt.status,delivered:false,submission_accepted:true};
    }catch(e){state=e instanceof SmsLiveRejected?'failed':'uncertain';error=e instanceof SmsLiveRejected?e.message:'Niepewny wynik wysyłki SMSAPI; bez ponownej wysyłki';}
  } else result = { local: true, delivered: false };
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
    await c.query(
      "UPDATE sms_messages SET state=$2,result=$3,error=$4,updated_at=now() WHERE id=$1 AND state='queued'",
      [m.id, state, JSON.stringify(result), error],
    );
    await c.query("UPDATE jobs SET state='done',lease_token=NULL,error=$2 WHERE id=$1", [
      job.id,
      error,
    ]);
    await finishBatch(c, m.batch_id);
    await audit(c, { tenantId: job.tenant_id, userId: m.actor_id }, 'sms.result', m.id, {
      state,
      mode: m.mode,
    });
  });
}
export async function failSms(job: any, e: unknown) {
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
      await c.query('SELECT * FROM sms_messages WHERE id=$1 FOR UPDATE', [job.payload.message_id])
    ).rows[0];
    if (m) {
      await c.query(
        "UPDATE sms_messages SET state=CASE WHEN attempted_at IS NULL THEN 'failed' ELSE 'uncertain' END,error=$2,updated_at=now() WHERE id=$1 AND state='queued'",
        [m.id, e instanceof Problem ? e.message : 'Błąd przetwarzania wiadomości'],
      );
      await finishBatch(c, m.batch_id);
    }
    await c.query(
      "UPDATE jobs SET state='failed',lease_token=NULL,error='Przetwarzanie SMS zatrzymane' WHERE id=$1",
      [job.id],
    );
  });
}
