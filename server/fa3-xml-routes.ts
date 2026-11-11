/** XML download uses the existing native159 current identity/receipt read path.
 * No numbering, issuance, current product lookup or KSeF submission. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Problem } from './errors';
import { b2bInvoiceDetail, b2bInvoiceRequestActor } from './b2b-invoices';
import { Fa3XmlError, renderNativeB2bInvoiceFa3 } from './fa3-xml';

/** Native detail is serialized by to_jsonb under SET LOCAL TimeZone='UTC'.
 * Replace only its UTC suffix; Date would discard persisted microseconds. */
export function nativeInvoiceFa3GenerationTime(createdAt: unknown): string {
  if (typeof createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.[0-9]+)?(?:Z|\+00:00)$/.test(createdAt))
    throw new Problem(422, 'Nieobsługiwany utrwalony czas faktury FA(3)');
  return createdAt.replace(/\+00:00$/, 'Z');
}

export function registerNativeB2bInvoiceFa3Routes(app: FastifyInstance, opts: {sessionName: string}) {
  app.get('/api/b2b-invoices/documents/:id/fa3.xml', async (request, reply) => {
    z.strictObject({}).parse(request.query);
    const { id } = z.strictObject({id: z.uuid().transform(s => s.toLowerCase())}).parse(request.params);
    // Includes native own-document RLS, immutable receipt graph and last fresh
    // current identity/role/scopes clock. No owner or raw document shortcut.
    const { document } = await b2bInvoiceDetail(b2bInvoiceRequestActor(request, opts.sessionName), id);
    try {
      const result = renderNativeB2bInvoiceFa3(document, {
        generated_at: nativeInvoiceFa3GenerationTime(document.created_at),
      });
      // Exporter validates the native number against its frozen prefix/year/sequence.
      const filename = result.number.replace(/\//g, '-') + '.fa3.xml';
      return reply.type('application/xml; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(result.xml);
    } catch (error) {
      if (error instanceof Fa3XmlError)
        throw new Problem(error.code === 'XML_BYTES_EXCEEDED' ? 413 : 422, 'Niepełna lub nieobsługiwana migawka faktury FA(3)');
      throw error;
    }
  });
}
