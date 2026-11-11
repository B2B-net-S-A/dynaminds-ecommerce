import { readRuntimeResource } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-resources.mjs';
import type { PoolClient } from 'pg';
import { tenantTx } from './db';
import { audit, lockedOrder, type Actor } from './domain';
import { ensure } from './errors';
import { encrypt, decrypt } from './security';
import { sourceHash } from './catalog-source-normalize';
import { connectionHash } from './offer-sync-policy';
import { exportSource } from './odoo-exports';
import { OdooAccounting, verifyOdooInvoice } from './odoo-accounting';
import { odooId } from './odoo';
import { odooPdf, pdfSha256 } from './odoo-pdf-format';
import { safeFetch } from './integrations';
import type { IntegrationContext } from './channel-access';

export const invoiceFileMetadata = (f: any) => ({
  filename: f.filename,
  size: f.size,
  sha256: f.sha256,
  created_at: f.created_at,
  mode: f.mode,
});
const pinConnection = (ch: any) =>
  sourceHash({ connection: connectionHash(ch), credentials: ch.credentials });
const pinExport = (p: any) =>
  sourceHash({
    remote_id: p.remote_id,
    reference: p.reference,
    snapshot: p.snapshot,
    input: p.input,
    source_hash: p.source_hash,
    result: p.result,
  });
async function authorized(c: PoolClient, actor: Actor, writing: boolean) {
  const membership = (
    await c.query('SELECT odoo_pdf_authorized($1,$2) ok', [actor.userId, writing])
  ).rows[0];
  ensure(membership?.ok, 403, 'Brak prawa dostępu do PDF Odoo');
}
async function policy(
  c: PoolClient,
  actor: Actor,
  id: string,
  pinned?: { connection: string; export: string },
) {
  const base = (await c.query('SELECT order_id FROM odoo_invoice_exports WHERE id=$1', [id]))
    .rows[0];
  ensure(base, 404, 'Nie znaleziono eksportu faktury');
  await lockedOrder(c, base.order_id);
  const p = (await c.query('SELECT * FROM odoo_invoice_exports WHERE id=$1 FOR SHARE', [id]))
    .rows[0];
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [p.channel_id]))
    .rows[0];
  await authorized(c, actor, true);
  ensure(
    p.state === 'done' && p.phase === 'verified' && p.remote_id && p.result?.id === p.remote_id,
    409,
    'PDF wymaga zakończonego i zweryfikowanego eksportu faktury',
  );
  ensure(
    ch?.provider === 'odoo' &&
      connectionHash(ch) === p.connection_hash &&
      p.mode === (ch.settings.simulation ? 'simulation' : 'external'),
    409,
    'Konto lub konfiguracja Odoo zmieniły się od eksportu',
  );
  const d = (await c.query('SELECT * FROM documents WHERE id=$1', [p.document_id])).rows[0];
  ensure(
    d && d.order_id === p.order_id && sourceHash(exportSource(d, p.input)) === p.source_hash,
    409,
    'Źródłowa faktura zmieniła się od eksportu',
  );
  ensure(
    !pinned || (pinned.connection === pinConnection(ch) && pinned.export === pinExport(p)),
    409,
    'Połączenie, klucz lub eksport Odoo zmieniły się podczas pobierania PDF',
  );
  return { p, ch };
}
export async function fetchOdooInvoiceFile(actor: Actor, id: string, ctx: IntegrationContext = {}) {
  const initial = await tenantTx(actor.tenantId, async (c) => {
    await authorized(c, actor, true);
    const cached = (await c.query('SELECT * FROM odoo_invoice_files WHERE export_id=$1', [id]))
      .rows[0];
    if (cached) return { cached, p: null, ch: null };
    return { cached: null, ...(await policy(c, actor, id)) };
  });
  if (initial.cached) return { ...invoiceFileMetadata(initial.cached), replayed: true };
  const { p, ch } = initial;
  const pinned = { connection: pinConnection(ch), export: pinExport(p) };
  const fence = async () => {
    await tenantTx(actor.tenantId, (c) => policy(c, actor, id, pinned));
  };
  let data: { pdf: Buffer; attachment_id: string; write_date: string };
  if (p.mode === 'simulation') {
    await fence();
    const pdf = await readRuntimeResource('pdf:odoo-demo-invoice', import.meta.url);
    data = {
      pdf: odooPdf(pdf.toString('base64')),
      attachment_id: 'DEMO-' + p.remote_id,
      write_date: 'local_simulation',
    };
  } else {
    const client = new OdooAccounting(
      ch.settings,
      decrypt(ch.credentials),
      ctx.transport ?? safeFetch,
    );
    const before = await client.invoice(odooId(p.remote_id), fence);
    verifyOdooInvoice(p, before, true);
    ensure(before.name === p.result.number, 409, 'Numer faktury Odoo zmienił się od eksportu');
    const file = await client.invoicePdf(odooId(p.remote_id), fence);
    const after = await client.invoice(odooId(p.remote_id), fence);
    verifyOdooInvoice(p, after, true);
    ensure(
      after.name === before.name &&
        before.write_date === after.write_date &&
        file.move_header.write_date === after.write_date,
      409,
      'Faktura Odoo zmieniła się podczas pobierania PDF',
    );
    data = file;
  }
  const sha = pdfSha256(data.pdf);
  return tenantTx(actor.tenantId, async (c) => {
    await policy(c, actor, id, pinned);
    const prior = (await c.query('SELECT * FROM odoo_invoice_files WHERE export_id=$1', [id]))
      .rows[0];
    if (prior) {
      ensure(
        prior.sha256 === sha,
        409,
        'Inny PDF został już zapisany dla tego eksportu; zachowano wcześniejszą kopię',
      );
      return { ...invoiceFileMetadata(prior), replayed: true };
    }
    const row = (
      await c.query(
        'INSERT INTO odoo_invoice_files(tenant_id,export_id,actor_id,filename,size,sha256,content_encrypted,remote_attachment_id,remote_write_date,mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [
          actor.tenantId,
          id,
          actor.userId,
          (p.mode === 'simulation' ? 'DEMO-' : '') + 'odoo-' + id + '.pdf',
          data.pdf.length,
          sha,
          encrypt({ pdf_base64: data.pdf.toString('base64') }),
          data.attachment_id,
          data.write_date,
          p.mode,
        ],
      )
    ).rows[0];
    await audit(c, actor, 'odoo.invoice.pdf.saved', id, {
      size: row.size,
      sha256: sha,
      mode: row.mode,
      attachment_id: row.remote_attachment_id,
    });
    return invoiceFileMetadata(row);
  });
}
export async function cachedOdooInvoiceFile(actor: Actor, id: string) {
  return tenantTx(actor.tenantId, async (c) => {
    await authorized(c, actor, false);
    const f = (await c.query('SELECT * FROM odoo_invoice_files WHERE export_id=$1', [id])).rows[0];
    ensure(f, 404, 'PDF nie jest jeszcze zapisany lokalnie');
    const pdf = odooPdf(decrypt(f.content_encrypted).pdf_base64);
    ensure(
      pdf.length === f.size && pdfSha256(pdf) === f.sha256,
      502,
      'Lokalna kopia PDF nie przeszła kontroli integralności',
    );
    return { ...invoiceFileMetadata(f), pdf };
  });
}
