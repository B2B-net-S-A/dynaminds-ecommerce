import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { publicAddresses } from './integrations';
import { localConfig } from './db';
import { ensure, Problem } from './errors';

/** Owner-private local profile choice. Never a request/env override. */
export function localSmtpPort(): number {
  const port = localConfig.localSmtpPort;
  if (port === undefined) return 1025;
  ensure(typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535, 500, 'Niepoprawny port prywatnego lokalnego SMTP');
  return port;
}

const address = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const smtpSettings = z
  .object({
    delivery: z.enum(['external', 'local_sink']).default('external'),
    host: z.string().trim().toLowerCase().min(1).max(253),
    port: z.coerce.number().int().min(1).max(65535),
    from_email: address,
    from_name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^\r\n\u0000-\u001f]+$/),
  })
  .strict()
  .superRefine((s, ctx) => {
    const local = s.delivery === 'local_sink';
    if (
      local
        ? s.host !== '127.0.0.1' || s.port !== localSmtpPort() || !s.from_email.endsWith('.test')
        : ![465, 587].includes(s.port) ||
          !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(s.host) ||
          !s.host.includes('.') ||
          s.host.endsWith('.local') ||
          !/[a-z]/.test(s.host)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'SMTP: zewnętrzny DNS i port465/587 albo lokalny odbiornik127.0.0.1 na porcie prywatnego profilu (domyślnie1025) z adresem .test',
      });
  });
export const smtpCredentials = z
  .object({
    username: z
      .string()
      .trim()
      .min(1)
      .max(254)
      .regex(/^[^\r\n\u0000-\u001f]+$/),
    password: z.string().min(1).max(1000),
  })
  .strict();
export const localSmtpPassword = () =>
  createHmac('sha256', Buffer.from(localConfig.encryptionKey, 'hex'))
    .update('dyna-local-smtp-sink')
    .digest('hex');
export const smtpReplyHeaders=z.strictObject({
 in_reply_to:z.string().max(998).regex(/^<[^<>\s\x00-\x1f\x7f]+@[^<>\s\x00-\x1f\x7f]+>$/).nullable().optional(),
 references:z.array(z.string().max(998).regex(/^<[^<>\s\x00-\x1f\x7f]+@[^<>\s\x00-\x1f\x7f]+>$/)).max(101).optional(),
}).refine(v=>(v.in_reply_to?.length??0)+(v.references??[]).reduce((n,s)=>n+s.length+1,0)<=32768,'Łańcuch odpowiedzi przekracza32KiB');
export type EmailEnvelope = {
  in_reply_to?:string|null;
  references?:string[];
  id: string;
  recipient: string;
  subject: string;
  text: string;
  html: string;
  attachment?: { filename: string; content_type: string; content: Buffer };
};
export class SmtpClient {
  settings: z.infer<typeof smtpSettings>;
  credentials: Record<string, string>;
  constructor(settings: unknown, credentials: Record<string, string>) {
    this.settings = smtpSettings.parse(settings);
    this.credentials =
      this.settings.delivery === 'local_sink'
        ? { username: 'dyna-local', password: localSmtpPassword() }
        : smtpCredentials.parse(credentials);
  }
  async transport() {
    const s = this.settings,
      local = s.delivery === 'local_sink';
    ensure(
      local || process.env.DYNA_ALLOW_EXTERNAL_EMAIL === 'true',
      423,
      'Zewnętrzny SMTP wymaga autoryzacji operatora i DYNA_ALLOW_EXTERNAL_EMAIL=true',
    );
    const ip = local ? { address: '127.0.0.1', family: 4 } : (await publicAddresses(s.host))[0];
    const options: SMTPTransport.Options = {
      host: s.host,
      port: s.port,
      secure: s.port === 465,
      requireTLS: !local && s.port === 587,
      ignoreTLS: local,
      auth: { user: this.credentials.username, pass: this.credentials.password },
      pool: false,
      logger: false,
      debug: false,
      connectionTimeout: 12000,
      greetingTimeout: 12000,
      socketTimeout: 12000,
      tls: { servername: s.host, minVersion: 'TLSv1.2', rejectUnauthorized: true },
      disableFileAccess: true,
      disableUrlAccess: true,
      // Connect to the validated address, preventing a second DNS lookup/rebinding.
      getSocket: (_options, callback) => {
        const secure = s.port === 465;
        const socket = secure
          ? tlsConnect({
              host: ip.address,
              port: s.port,
              servername: s.host,
              minVersion: 'TLSv1.2',
              rejectUnauthorized: true,
            })
          : tcpConnect({ host: ip.address, family: ip.family, port: s.port });
        let done = false;
        const finish = (err?: Error) => {
          if (done) return;
          done = true;
          socket.setTimeout(0);
          if (err) {
            socket.destroy();
            callback(err);
          } else callback(null, { connection: socket, secured: secure });
        };
        socket.once(secure ? 'secureConnect' : 'connect', () => finish());
        socket.once('error', finish);
        socket.setTimeout(12000, () => finish(new Error('SMTP timeout')));
      },
    };
    return nodemailer.createTransport(options);
  }
  async test() {
    const t = await this.transport();
    try {
      await t.verify();
      return { smtp_verified: true, delivery: this.settings.delivery, message_sent: false };
    } catch {
      throw new Problem(502, 'SMTP: nie potwierdzono połączenia lub uwierzytelnienia');
    } finally {
      t.close();
    }
  }
  async send(m: EmailEnvelope) {
    const replyHeaders=smtpReplyHeaders.parse({in_reply_to:m.in_reply_to,references:m.references});
    if (m.attachment)
      ensure(
        /^[A-Za-z0-9_-]+\.(pdf|html)$/.test(m.attachment.filename) &&
          ['application/pdf', 'text/html'].includes(m.attachment.content_type) &&
          Buffer.isBuffer(m.attachment.content) &&
          m.attachment.content.length > 0 &&
          m.attachment.content.length <= 2 * 1024 * 1024,
        422,
        'Niepoprawny załącznik SMTP',
      );
    ensure(
      this.settings.delivery !== 'local_sink' || m.recipient.endsWith('.test'),
      422,
      'Lokalny SMTP przyjmuje tylko odbiorców w domenie .test',
    );
    const t = await this.transport();
    try {
      const info = await t.sendMail({
        from: { name: this.settings.from_name, address: this.settings.from_email },
        to: m.recipient,
        subject: m.subject,
        text: m.text,
        html: m.html,
        attachments: m.attachment
          ? [
              {
                filename: m.attachment.filename,
                content: m.attachment.content,
                contentType: m.attachment.content_type,
                contentDisposition: 'attachment',
              },
            ]
          : [],
        messageId: `<${m.id}@dynaminds.local>`,
        ...(replyHeaders.in_reply_to?{inReplyTo:replyHeaders.in_reply_to}:{}),
        ...(replyHeaders.references?.length?{references:replyHeaders.references}:{}),
        headers: { 'X-Dynaminds-Message': m.id },
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      ensure(
        info.accepted.length === 1 &&
          String(info.accepted[0]).toLowerCase() === m.recipient &&
          !info.rejected.length,
        502,
        'SMTP nie potwierdził odbiorcy',
      );
      return {
        accepted_by_smtp: true,
        delivered: false,
        local_sink: this.settings.delivery === 'local_sink',
        message_id: info.messageId,
      };
    } finally {
      t.close();
    }
  }
}
