/** GET /api/fa3/documents/:id/fa3.xml — FA(3) XML of any issued document by id. The file is checked
 * against the official FA(3) schema first: a file that does not conform is refused (422, Polish
 * message); header X-Walidacja-XSD says `zgodny` or `pominieta` (source/dev tree without schemas/mf; a release
 * refuses to start without them). The B2B 159 button has the same check: its route (fa3-xml-routes.ts) and
 * registrar (b2b-invoice-routes.ts) are hash-pinned, so it is an onSend hook of that one route, added here. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fa3DocumentXml } from './fa3-documents';
import { ensureFa3Conforms } from './fa3-xsd';
import type { XsdResult } from './mf-xsd';

export const NATIVE_B2B_FA3_ROUTE = '/api/b2b-invoices/documents/:id/fa3.xml';

export function registerFa3DocumentRoutes(app: FastifyInstance, opts: { sessionName: string; xsd?: (xml: string) => Promise<XsdResult> }): void {
  // onRoute: registered before registerB2bInvoiceRoutes (buildApp), only this route gets the hook.
  app.addHook('onRoute', route => {
    if (route.url !== NATIVE_B2B_FA3_ROUTE || route.method !== 'GET') return;
    route.onSend = [...[route.onSend ?? []].flat(), async (request, reply, payload) => {
      if (reply.statusCode !== 200 || typeof payload !== 'string') return payload;
      const number = /<P_2>([^<]*)<\/P_2>/.exec(payload)?.[1] ?? 'faktury B2B';
      let checked: XsdResult;
      try { checked = await ensureFa3Conforms(payload, number, opts.xsd); }
      catch (e) { reply.removeHeader('Content-Disposition'); throw e; }
      if (checked.status === 'skipped') request.log.warn({ reason: checked.reason }, 'FA(3) bez walidacji XSD');
      reply.header('X-Walidacja-XSD', checked.status === 'valid' ? 'zgodny' : 'pominieta');
      return payload;
    }];
  });
  app.get('/api/fa3/documents/:id/fa3.xml', async (request, reply) => {
    z.strictObject({}).parse(request.query);
    const { id } = z.strictObject({ id: z.uuid().transform(s => s.toLowerCase()) }).parse(request.params);
    const result = await fa3DocumentXml(request as never, id, opts.sessionName);
    const checked = await ensureFa3Conforms(result.xml, result.number, opts.xsd);
    if (checked.status === 'skipped') request.log.warn({ reason: checked.reason }, 'FA(3) bez walidacji XSD');
    return reply.type('application/xml; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="${result.filename}"`)
      .header('X-Walidacja-XSD', checked.status === 'valid' ? 'zgodny' : 'pominieta')
      .send(result.xml);
  });
}
