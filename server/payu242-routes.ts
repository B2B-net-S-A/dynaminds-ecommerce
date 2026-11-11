/** Routes of the PayU payment sessions (migration 242, docs/parity/PAYU242-20261027.md).
 * - /api/payu/config (admin session), /api/orders/:id/payu-sessions (list, „Sprawdź w PayU”, refund),
 * - /api/public/orders/:token/payments/payu (portal „Zapłać”), /payu/return/:session (buyer's landing page),
 * - /callbacks/payu/:config/:token (PayU notifications: peer allow-list, secret path, OpenPayu-Signature),
 * - /payu-fake/pay/:orderId (SYMULACJA pay page, only with DYNA_PAYU_FAKE=local). */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Problem } from './errors';
import { htmlEscape } from './portal-view';
import {
  handlePayu242Notification,
  listPayu242Sessions,
  payu242FakeNotification,
  payu242FakePayment,
  payu242FakePageKey,
  payu242FakeReturnPath,
  payu242ReturnState,
  payu242Simulation,
  readPayu242Config,
  reconcilePayu242ForOrder,
  savePayu242Config,
  startPayu242PortalPayment,
  startPayu242Refund,
} from './payu242';
import { PAYU_MAX_NOTIFICATION_BYTES } from './payment-payu-values';

const ids = (params: unknown) => z.object({ id: z.uuid(), session: z.uuid().optional() }).parse(params);
const page = (nonce: string, title: string, body: string, script = '') =>
  `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#f5f6fb;color:#17213a;font:16px system-ui}header{background:#17213a;color:#fff;padding:22px 24px}main{max-width:640px;margin:auto;padding:24px}section{background:#fff;border:1px solid #e2e6f0;border-radius:16px;padding:24px;margin:18px 0}h1{font-size:24px;margin:0 0 8px}.money{font-size:26px;font-weight:700}.badge{display:inline-block;border-radius:30px;padding:8px 12px;background:#edf0ff;color:#3445be;font-weight:600}.ok{background:#e6f6ec;color:#17603a}.bad{background:#fdecee;color:#9c1c2b}.muted{color:#63708a}.sim{padding:12px;border-radius:10px;background:#fff4d6;color:#6b4a00;font-weight:600}button,a.button{font:inherit;border-radius:8px;border:1px solid #cfd6e5;background:#fff;padding:11px 18px;cursor:pointer;text-decoration:none;color:#17213a;display:inline-block;margin:6px 8px 0 0}button.primary{background:#3548cc;color:#fff;border:0}form{display:inline}</style></head>
<body><header><strong>${htmlEscape(title)}</strong></header><main>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
const csp = (nonce: string) =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
const statusText: Record<string, [string, string]> = {
  NEW: ['Czekamy na potwierdzenie płatności z PayU', ''],
  PENDING: ['PayU przetwarza płatność', ''],
  WAITING_FOR_CONFIRMATION: ['PayU czeka na potwierdzenie płatności', ''],
  COMPLETED: ['Płatność potwierdzona przez PayU', 'ok'],
  CANCELED: ['Płatność anulowana — możesz spróbować ponownie z linku zamówienia', 'bad'],
  REJECTED: ['Płatność nie doszła do skutku — możesz spróbować ponownie z linku zamówienia', 'bad'],
};
const money = (minor: number, currency: string) => new Intl.NumberFormat('pl-PL', { style: 'currency', currency }).format(minor / 100);

export function registerPayu242Routes(app: FastifyInstance, { readOnly }: { readOnly: boolean }) {
  app.get('/api/payu/config', (req) => readPayu242Config(req.actor));
  app.put('/api/payu/config', (req) => savePayu242Config(req.actor, req.body));
  app.get('/api/orders/:id/payu-sessions', (req) => listPayu242Sessions(req.actor, ids(req.params).id));
  app.post('/api/orders/:id/payu-sessions/:session/reconcile', (req) => {
    const p = ids(req.params);
    return reconcilePayu242ForOrder(req.actor, p.id, p.session!);
  });
  app.post('/api/orders/:id/payu-sessions/:session/refunds', async (req, reply) => {
    const p = ids(req.params);
    const r = await startPayu242Refund(req.actor, p.id, p.session!, req.body);
    return reply.code(r.reused ? 200 : 201).send(r);
  });
  app.post(
    '/api/public/orders/:token/payments/payu',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (readOnly) throw new Problem(423, 'Podgląd kopii — płatności są wyłączone');
      const { token } = z.object({ token: z.string().regex(/^[a-f0-9]{48}$/) }).parse(req.params);
      // The buyer's address for PayU's fraud checks: the actual TCP peer, as every public route here.
      const r = await startPayu242PortalPayment(token, req.body, req.raw.socket.remoteAddress);
      return reply.code(r.reused ? 200 : 201).send(r);
    },
  );
  const returnPage = async (sessionId: string, secret: unknown) => {
    try {
      return await payu242ReturnState(sessionId, secret);
    } catch (e) {
      if (e instanceof Problem && e.status === 404) return null;
      throw e;
    }
  };
  app.get('/payu/return/:session', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { session } = z.object({ session: z.string().max(64) }).parse(req.params);
    const { s } = z.object({ s: z.string().max(64).optional() }).parse(req.query);
    const state = await returnPage(session, s);
    const nonce = randomBytes(18).toString('base64');
    reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow').header('Content-Security-Policy', csp(nonce)).type('text/html');
    if (!state) return reply.code(404).send(page(nonce, 'Płatność', '<section><h1>Nie znaleziono płatności</h1><p>Link powrotu jest nieprawidłowy. Wróć do strony zamówienia z otrzymanej wiadomości.</p></section>'));
    const [label, tone] = statusText[state.status];
    const body = `<section><p class="muted">ZAMÓWIENIE ${htmlEscape(state.number)}</p><h1>Płatność PayU</h1><p class="money">${htmlEscape(money(state.amount, state.currency))}</p>
${state.simulated ? '<p class="sim">SYMULACJA lokalna PayU — bez prawdziwej płatności</p>' : ''}<p id="state" class="badge ${tone}" role="status">${htmlEscape(label)}</p>
<p class="muted" id="note">${state.status === 'COMPLETED' ? (state.booked ? 'Wpłata jest zapisana na zamówieniu.' : 'PayU potwierdził płatność; sprzedawca zapisze ją na zamówieniu. Nie płać ponownie.') : 'Ta strona tylko pokazuje stan płatności i odświeża się sama. Nie zamykaj jej, jeśli płatność jest w toku.'}</p>
<p><a class="button" id="back" hidden>Wróć do zamówienia</a></p></section>`;
    // The portal stored its own link in this tab before leaving for PayU; PayU never sees the portal token.
    const script = `const labels=${JSON.stringify(statusText)};const back=sessionStorage.getItem('payu-return:${state.session_id}');if(back&&back.startsWith(location.origin+'/api/public/orders/')){const a=document.getElementById('back');a.href=back;a.hidden=false;}
let n=0;async function poll(){if(++n>40)return;try{const r=await fetch(location.pathname+'/status'+location.search,{credentials:'omit'});if(r.ok){const d=await r.json();const[l,t]=labels[d.status];const el=document.getElementById('state');el.textContent=l;el.className='badge '+t;if(d.status==='COMPLETED')document.getElementById('note').textContent=d.booked?'Wpłata jest zapisana na zamówieniu.':'PayU potwierdził płatność; sprzedawca zapisze ją na zamówieniu. Nie płać ponownie.';if(['COMPLETED','CANCELED','REJECTED'].includes(d.status))return;}}catch{}setTimeout(poll,3000);}
${['COMPLETED', 'CANCELED', 'REJECTED'].includes(state.status) ? '' : 'setTimeout(poll,2000);'}`;
    return reply.send(page(nonce, 'Płatność za zamówienie', body, script));
  });
  app.get('/payu/return/:session/status', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { session } = z.object({ session: z.string().max(64) }).parse(req.params);
    const { s } = z.object({ s: z.string().max(64).optional() }).parse(req.query);
    const state = await returnPage(session, s);
    reply.header('Cache-Control', 'no-store');
    if (!state) return reply.code(404).send({ detail: 'Nie znaleziono płatności' });
    return { status: state.status, booked: state.booked };
  });

  app.register(async (callback) => {
    // Exact bytes for the signature: the body is kept as a Buffer, parsed only after verification.
    callback.removeContentTypeParser('application/json');
    callback.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: PAYU_MAX_NOTIFICATION_BYTES }, (_req, body, done) => done(null, body));
    callback.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: PAYU_MAX_NOTIFICATION_BYTES }, (_req, body, done) => done(null, body));
    callback.route({
      method: 'POST',
      url: '/callbacks/payu/:config/:token',
      bodyLimit: PAYU_MAX_NOTIFICATION_BYTES,
      logLevel: 'silent',
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      handler: async (req, reply) => {
        const { config, token } = req.params as { config: string; token: string };
        let code: number;
        try {
          code = await handlePayu242Notification({
            configId: String(config), token: String(token),
            peer: req.raw.socket.remoteAddress, // never X-Forwarded-For or req.ip
            contentType: req.headers['content-type'], raw: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), headers: req.headers,
          }, readOnly);
        } catch (e) {
          // No body, provider data or database detail in the answer; PayU repeats a non-200.
          code = e instanceof Problem && e.status < 500 ? 409 : 503;
        }
        return reply.code(code).header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send(code === 200 ? 'OK' : 'Notification not acknowledged');
      },
    });
  });

  if (!payu242Simulation()) return;
  // ---- SYMULACJA: PayU's pay page as a local stand-in. Never registered without DYNA_PAYU_FAKE=local. ----
  app.register(async (fake) => {
  // The page's buttons are plain HTML forms; their (empty) form body carries nothing the fake reads.
  fake.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 }, (_req, _body, done) => done(null, {}));
  fake.get('/payu-fake/pay/:orderId', async (req, reply) => {
    const { orderId } = z.object({ orderId: z.string().regex(/^[A-Za-z0-9]{6,64}$/) }).parse(req.params);
    const { k } = z.object({ k: z.string().max(64).optional() }).parse(req.query);
    const found = k === payu242FakePageKey(orderId) ? payu242FakePayment(orderId) : null;
    const nonce = randomBytes(18).toString('base64');
    reply.header('Cache-Control', 'no-store').header('Content-Security-Policy', csp(nonce)).type('text/html');
    if (!found) return reply.code(404).send(page(nonce, 'PayU — SYMULACJA', '<section><h1>Nie znaleziono płatności</h1></section>'));
    const o = found.order;
    const done = ['COMPLETED', 'CANCELED'].includes(o.status);
    return reply.send(page(nonce, 'PayU — SYMULACJA', `<section><p class="sim">SYMULACJA lokalna PayU (sandbox). Żadne pieniądze nie są pobierane.</p>
<p class="muted">${htmlEscape(o.request.description)}</p><p class="money">${htmlEscape(money(o.totalAmount, o.currencyCode))}</p><p>Status w PayU: <strong>${htmlEscape(o.status)}</strong></p>
${done ? '' : `<form method="post" action="/payu-fake/pay/${htmlEscape(orderId)}/complete?k=${htmlEscape(k)}"><button class="primary">Zapłać (symulacja)</button></form><form method="post" action="/payu-fake/pay/${htmlEscape(orderId)}/cancel?k=${htmlEscape(k)}"><button>Anuluj płatność</button></form>`}</section>`));
  });
  fake.post('/payu-fake/pay/:orderId/:action', async (req, reply) => {
    const { orderId, action } = z.object({ orderId: z.string().regex(/^[A-Za-z0-9]{6,64}$/), action: z.enum(['complete', 'cancel']) }).parse(req.params);
    const { k } = z.object({ k: z.string().max(64).optional() }).parse(req.query);
    const found = k === payu242FakePageKey(orderId) ? payu242FakePayment(orderId) : null;
    if (!found) return reply.code(404).send({ detail: 'Nie znaleziono płatności' });
    // PayU's sequence: PENDING, then COMPLETED (or CANCELED); each status is notified and signed.
    for (const status of action === 'complete' ? (['PENDING', 'COMPLETED'] as const) : (['CANCELED'] as const)) {
      found.fake.setStatus(orderId, status);
      const n = payu242FakeNotification(orderId)!;
      await app.inject({ method: 'POST', url: n.path, payload: n.body, headers: { 'content-type': 'application/json', ...n.headers }, remoteAddress: n.peer });
    }
    return reply.code(303).header('Location', payu242FakeReturnPath(orderId) ?? '/').send();
  });
  });
}
