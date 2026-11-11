import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { tenantTx } from './db';
import type { Actor } from './domain';
import { ensure, Problem } from './errors';
import { encrypt, decrypt } from './security';
import { emailHash, emailChannelHash } from './email-hash';
import { documentBody, htmlEscape } from './portal-view';
import { odooPdf, pdfSha256 } from './odoo-pdf-format';
import type { IntegrationContext } from './channel-access';

export const EMAIL_FILE_LIMIT = 2 * 1024 * 1024;
export const EMAIL_BATCH_FILE_LIMIT = 20 * 1024 * 1024;
const sourceHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const docHash = (d: any, ch: any, plan?: any) =>
  emailHash({ document: d, channel: ch ? emailChannelHash(ch) : null, ...(plan ? { plan } : {}) });
const metadata = (f: any) => ({
  filename: f.filename,
  content_type: f.content_type,
  size: f.size,
  sha256: f.sha256,
});
function attachmentPdf(base64: unknown) {
  try {
    return odooPdf(base64);
  } catch (e) {
    if (e instanceof Problem)
      throw new Problem(e.status, 'Nieprawidłowy PDF załącznika (limit 2 MiB)');
    throw e;
  }
}
export function emailFileBytes(f: any, key?: string) {
  const body = decrypt(f.content_encrypted, key).file_base64;
  ensure(typeof body === 'string' && body.length <= 2796204, 409, 'Brak lub zbyt duży załącznik');
  const bytes = Buffer.from(body, 'base64');
  ensure(
    bytes.length > 0 &&
      bytes.length <= EMAIL_FILE_LIMIT &&
      bytes.toString('base64') === body &&
      bytes.length === f.size &&
      pdfSha256(bytes) === f.sha256,
    409,
    'Załącznik nie odpowiada zapisanej treści',
  );
  if (f.content_type === 'application/pdf' || f.filename.endsWith('.pdf')) attachmentPdf(body);
  return bytes;
}
async function documentSource(c: PoolClient, id: string) {
  const d = (await c.query('SELECT * FROM documents WHERE id=$1', [id])).rows[0];
  ensure(d, 404, 'Brak dokumentu w firmie');
  const ch = d.channel_id
    ? (await c.query('SELECT * FROM channels WHERE id=$1', [d.channel_id])).rows[0]
    : null;
  const plan =
    d.mode === 'external'
      ? (
          await c.query(
            'SELECT id,payload,remote_id,channel_id,state,mode FROM invoice_plans WHERE document_id=$1',
            [id],
          )
        ).rows[0]
      : null;
  return { d, ch, hash: docHash(d, ch, plan) };
}
// Read-only provider fetch runs outside SQL transactions. Re-check the source and account before saving.
export async function cacheInvoiceEmailFile(a: Actor, id: string, ctx: IntegrationContext) {
  const { Fakturownia, safeFetch } = await import('./integrations');
  const { verifiedInvoice } = await import('./invoices');
  const { audit } = await import('./domain');
  ensure(a.role !== 'viewer', 403, 'Brak prawa przygotowania dokumentu');
  const initial = await tenantTx(a.tenantId, async (c) => {
    const s = await documentSource(c, id);
    ensure(
      s.d.mode === 'external' && s.ch?.provider === 'fakturownia' && s.d.external_id,
      422,
      'Wymagana faktura Fakturowni',
    );
    const old = (
      await c.query('SELECT * FROM invoice_email_files WHERE document_id=$1 AND source_hash=$2', [
        id,
        s.hash,
      ])
    ).rows[0];
    if (old) emailFileBytes(old);
    return { ...s, old };
  });
  if (initial.old)
    return { ...metadata({ ...initial.old, content_type: 'application/pdf' }), cached: true };
  const p = await tenantTx(
    a.tenantId,
    async (c) =>
      (
        await c.query(
          "SELECT * FROM invoice_plans WHERE document_id=$1 AND state='done' AND mode='external'",
          [id],
        )
      ).rows[0],
  );
  ensure(
    p && p.remote_id === initial.d.external_id && p.channel_id === initial.ch.id,
    409,
    'Brak ukończonego planu faktury dostawcy',
  );
  const client = new Fakturownia(
    initial.ch.settings,
    decrypt(initial.ch.credentials),
    ctx.transport ?? safeFetch,
  );
  const before = await client.invoice(p.remote_id);
  ensure(
    verifiedInvoice(p, before).number === initial.d.number,
    409,
    'Numer faktury dostawcy różni się od dokumentu',
  );
  const bytes = attachmentPdf((await client.invoicePdf(initial.d.external_id)).toString('base64'));
  const after = await client.invoice(p.remote_id);
  verifiedInvoice(p, after);
  ensure(
    emailHash(before) === emailHash(after),
    409,
    'Faktura dostawcy zmieniła się podczas pobierania PDF',
  );
  return tenantTx(a.tenantId, async (c) => {
    const member = (await c.query('SELECT odoo_pdf_authorized($1,true) allowed', [a.userId]))
      .rows[0];
    ensure(member.allowed, 403, 'Autor utracił prawo przygotowania dokumentu');
    const s = await documentSource(c, id);
    ensure(s.hash === initial.hash, 409, 'Dokument lub konto zmieniły się podczas pobierania');
    const current = (
      await c.query(
        'SELECT payload,remote_id,channel_id,state,mode FROM invoice_plans WHERE id=$1',
        [p.id],
      )
    ).rows[0];
    ensure(
      current?.state === 'done' &&
        current.mode === 'external' &&
        current.remote_id === p.remote_id &&
        current.channel_id === p.channel_id &&
        emailHash(current.payload) === emailHash(p.payload),
      409,
      'Plan faktury zmienił się podczas pobierania',
    );
    const file = {
      filename: 'invoice-' + id + '.pdf',
      content_type: 'application/pdf',
      size: bytes.length,
      sha256: pdfSha256(bytes),
    };
    const inserted = await c.query(
      'INSERT INTO invoice_email_files(tenant_id,document_id,source_hash,filename,size,sha256,content_encrypted) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
      [
        a.tenantId,
        id,
        s.hash,
        file.filename,
        file.size,
        file.sha256,
        encrypt({ file_base64: bytes.toString('base64') }),
      ],
    );
    const saved = (
      await c.query('SELECT * FROM invoice_email_files WHERE document_id=$1 AND source_hash=$2', [
        id,
        s.hash,
      ])
    ).rows[0];
    ensure(saved.sha256 === file.sha256, 409, 'Równoległe pobranie zwróciło inny PDF');
    if (inserted.rowCount)
      await audit(c, a, 'email.invoice.cache', id, { size: file.size, sha256: file.sha256 });
    return { ...metadata(file), cached: !inserted.rowCount };
  });
}
export async function emailAttachment(c: PoolClient, t: any, o: any) {
  if (!t.attachment || t.attachment === 'none') return null;
  ensure(
    (await c.query("SELECT to_regclass('public.email_message_files') present")).rows[0].present,
    404,
    'Załączniki email niedostępne w tym schemacie',
  );
  const docs = (
    await c.query(
      "SELECT * FROM documents WHERE order_id=$1 AND kind='invoice' ORDER BY (mode='external') DESC,created_at DESC,id DESC LIMIT 1",
      [o.id],
    )
  ).rows;
  // Prefer the external invoice when both DEMO and provider documents exist. Never fall back from a missing provider PDF to DEMO.
  const d = docs.find((d) => d.mode === 'external') ?? docs[0];
  ensure(d, 422, 'Wymagany załącznik: zamówienie nie ma faktury');
  let bytes: Buffer, filename: string, content_type: string, identity: any;
  if (t.attachment === 'odoo_invoice') {
    const { exportSource } = await import('./odoo-exports');
    const { connectionHash } = await import('./offer-sync-policy');
    const rows = (
      await c.query(
        "SELECT p.*,f.filename,f.size,f.sha256,f.content_encrypted FROM odoo_invoice_exports p JOIN odoo_invoice_files f ON (f.tenant_id,f.export_id)=(p.tenant_id,p.id) WHERE p.order_id=$1 AND p.state='done' AND p.phase='verified' ORDER BY p.created_at DESC,p.id DESC LIMIT 2",
        [o.id],
      )
    ).rows;
    ensure(rows.length === 1, 422, 'Wymagany jeden gotowy PDF Odoo; pobierz go w panelu Odoo');
    const p = rows[0],
      source = await documentSource(c, p.document_id);
    ensure(
      source.d.order_id === o.id && sourceHash(exportSource(source.d, p.input)) === p.source_hash,
      409,
      'Źródło PDF Odoo zmieniło się',
    );
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [p.channel_id])).rows[0];
    ensure(
      ch?.provider === 'odoo' &&
        connectionHash(ch) === p.connection_hash &&
        sourceHash(ch.credentials) === p.credentials_hash &&
        Boolean(ch.settings.simulation) === (p.mode === 'simulation') &&
        p.result?.id?.toString() === p.remote_id,
      409,
      'PDF Odoo nie odpowiada aktualnemu eksportowi i kontu',
    );
    bytes = odooPdf(decrypt(p.content_encrypted).pdf_base64);
    ensure(
      bytes.length === p.size && pdfSha256(bytes) === p.sha256,
      409,
      'PDF Odoo nie odpowiada metadanym',
    );
    filename = p.filename;
    content_type = 'application/pdf';
    identity = {
      source: 'odoo',
      export_id: p.id,
      document_id: p.document_id,
      source_hash: p.source_hash,
      connection_hash: p.connection_hash,
      credentials_hash: p.credentials_hash,
      mode: p.mode,
    };
  } else if (d.mode === 'external') {
    const s = await documentSource(c, d.id);
    const f = (
      await c.query('SELECT * FROM invoice_email_files WHERE document_id=$1 AND source_hash=$2', [
        d.id,
        s.hash,
      ])
    ).rows[0];
    ensure(f, 422, 'Wymagany PDF faktury: przygotuj załącznik w panelu dokumentów');
    bytes = emailFileBytes(f);
    filename = f.filename;
    content_type = 'application/pdf';
    identity = { source: 'fakturownia', document_id: d.id, source_hash: s.hash, mode: 'external' };
  } else {
    bytes = Buffer.from(
      `<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${htmlEscape(d.number)}</title><style>body{font:16px system-ui;max-width:850px;margin:32px auto;padding:16px;color:#18263c}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}.demo{padding:16px;background:#fff2ce}</style><h1>DYNAMINDS Ecommerce</h1><p class="demo">DEMO - dokument testowy. Nie jest dokumentem księgowym.</p>${documentBody(d)}</html>`,
    );
    filename = 'DEMO-invoice-' + d.id + '.html';
    content_type = 'text/html';
    identity = { source: 'demo', document_id: d.id, source_hash: docHash(d, null), mode: 'demo' };
  }
  ensure(bytes.length <= EMAIL_FILE_LIMIT, 422, 'Załącznik przekracza 2 MiB');
  return {
    meta: { ...identity, filename, content_type, size: bytes.length, sha256: pdfSha256(bytes) },
    bytes,
  };
}
export async function savedEmailFile(c: PoolClient, id: string, expected?: any) {
  const f = (await c.query('SELECT * FROM email_message_files WHERE message_id=$1', [id])).rows[0];
  ensure(f, 404, 'Brak załącznika wiadomości');
  ensure(
    !expected || emailHash(metadata(f)) === emailHash(metadata(expected)),
    409,
    'Załącznik nie odpowiada podglądowi',
  );
  return { ...metadata(f), bytes: emailFileBytes(f) };
}
