/** The FA(3) download of FV B2B 159 goes through the same XSD check as every other FA(3) file.
 * Its route and registrar stay hash-pinned (scripts/fa3-xml-*): the check is an onSend hook of that one route. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { Problem } from '../server/errors';
import { registerFa3DocumentRoutes, NATIVE_B2B_FA3_ROUTE } from '../server/fa3-document-routes';

async function b2bApp(xml: string, xsd: Parameters<typeof registerFa3DocumentRoutes>[1]['xsd']) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err: Error, _q, reply) => reply.code(err instanceof Problem ? err.status : 500).send({ detail: err.message }));
  registerFa3DocumentRoutes(app, { sessionName: 's', xsd });
  app.get(NATIVE_B2B_FA3_ROUTE, async (_r, reply) => reply.type('application/xml; charset=utf-8')
    .header('Content-Disposition', 'attachment; filename="FV-1.fa3.xml"').send(xml));
  app.get('/api/other', async (_r, reply) => reply.type('application/xml').send('<zly/>'));
  await app.ready();
  return app;
}
const url = '/api/b2b-invoices/documents/00000000-0000-4000-8000-000000000001/fa3.xml';

test('B2B FA(3) button: a conforming file carries X-Walidacja-XSD: zgodny, a non-conforming one is a Polish 422 without the attachment', async () => {
  const good = await b2bApp('<Faktura><P_2>FV/1</P_2></Faktura>', async () => ({ status: 'valid' }));
  const r = await good.inject({ method: 'GET', url });
  assert.equal(r.statusCode, 200); assert.equal(r.headers['x-walidacja-xsd'], 'zgodny'); assert.match(String(r.headers['content-disposition']), /FV-1/);
  await good.close();

  const bad = await b2bApp('<Faktura><P_2>FV/1</P_2></Faktura>', async () => ({ status: 'invalid', errors: 'Element P_15 is missing' }));
  const refusal = await bad.inject({ method: 'GET', url });
  assert.equal(refusal.statusCode, 422);
  assert.match(refusal.body, /Plik FA\(3\) FV\/1 nie jest zgodny ze schematem FA\(3\) Ministerstwa Finansów: Element P_15 is missing/);
  assert.equal(refusal.headers['content-disposition'], undefined); assert.equal(refusal.headers['x-walidacja-xsd'], undefined);
  assert.equal((await bad.inject({ method: 'GET', url: '/api/other' })).statusCode, 200, 'other routes are untouched');
  await bad.close();

  const skipped = await b2bApp('<Faktura/>', async () => ({ status: 'skipped', reason: 'brak' }));
  const dev = await skipped.inject({ method: 'GET', url });
  assert.equal(dev.statusCode, 200); assert.equal(dev.headers['x-walidacja-xsd'], 'pominieta');
  await skipped.close();
});

test('the B2B route and registrar keep their pinned bytes', () => {
  const pins = readFileSync(new URL('../scripts/fa3-xml-native-run.ts', import.meta.url), 'utf8');
  for (const f of ['server/fa3-xml-routes.ts', 'server/b2b-invoice-routes.ts']) {
    const h = createHashHex(readFileSync(new URL('../' + f, import.meta.url)));
    assert.ok(pins.includes(`'${f}':'${h}'`), f);
  }
});
function createHashHex(b: Buffer) { return createHash('sha256').update(b).digest('hex'); }
