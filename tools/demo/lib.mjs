// Ordinary HTTP client of the demo tools: the same routes and bodies the UI uses, with the session cookie.
// Transport: fetch against the running demo app, or app.inject of a release app in the same process (seed.mjs).
import { randomUUID } from 'node:crypto';

const SESSION = 'dyna_session';

export function fetchTransport(base) {
  return async ({ method, url, body, cookie, headers = {} }) => {
    const r = await fetch(base + url, { method, headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie: `${SESSION}=${cookie}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await r.text();
    return { status: r.status, text, headers: Object.fromEntries(r.headers), setCookie: r.headers.getSetCookie?.() ?? [] };
  };
}
export function injectTransport(app) {
  return async ({ method, url, body, cookie, headers = {} }) => {
    const r = await app.inject({ method, url, headers: { accept: 'application/json', ...headers }, ...(cookie ? { cookies: { [SESSION]: cookie } } : {}),
      ...(body !== undefined ? { payload: body } : {}) });
    return { status: r.statusCode, text: r.body, headers: r.headers, setCookie: [r.headers['set-cookie']].flat().filter(Boolean) };
  };
}
const sessionOf = (res) => {
  const raw = res.setCookie.find((v) => v.startsWith(SESSION + '='));
  return raw ? raw.split(';')[0].slice(SESSION.length + 1) : null;
};
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return t; } };

export class Client {
  constructor(transport, cookie = null) { this.t = transport; this.cookie = cookie; }
  async raw(method, url, body, headers) {
    const r = await this.t({ method, url, body, cookie: this.cookie, headers });
    const s = sessionOf(r); if (s) this.cookie = s;
    return { ...r, json: parse(r.text) };
  }
  async req(method, url, body, codes = [200, 201]) {
    const r = await this.raw(method, url, body);
    if (!codes.includes(r.status)) throw new Error(`${method} ${url} → ${r.status} ${r.text.slice(0, 600)}`);
    return r.json;
  }
  get(url, codes) { return this.req('GET', url, undefined, codes); }
  post(url, body = {}, codes) { return this.req('POST', url, body, codes); }
  put(url, body, codes) { return this.req('PUT', url, body, codes); }
  patch(url, body, codes) { return this.req('PATCH', url, body, codes); }
  async login(email, password) {
    const r = await this.raw('POST', '/api/auth/login', { email, password });
    if (r.status !== 200 || !this.cookie) throw new Error(`login ${email} → ${r.status} ${r.text.slice(0, 300)}`);
    return r.json;
  }
}

export const key = () => randomUUID();
/** Valid Polish NIP (checksum) from a deterministic digit source. */
export function nipFrom(rand) {
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  for (;;) {
    const d = [1 + Math.floor(rand() * 9), ...Array.from({ length: 8 }, () => Math.floor(rand() * 10))];
    const s = d.reduce((t, x, i) => t + x * w[i], 0) % 11;
    if (s !== 10) return d.join('') + s;
  }
}
/** EAN-13 with check digit (prefix 590 = GS1 Polska numbering space; demo numbers, not registered). */
export function ean13(body12) {
  const d = body12.split('').map(Number), s = d.reduce((t, x, i) => t + x * (i % 2 ? 3 : 1), 0);
  return body12 + ((10 - (s % 10)) % 10);
}
/** Small deterministic PRNG (mulberry32). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
