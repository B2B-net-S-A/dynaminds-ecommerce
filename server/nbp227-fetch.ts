/** Public NBP table A reads for a day or a date range (api.nbp.pl, read only) through the
 * controlled provider transport: timeout, size limit, strict schema, the exact decimal
 * text of every mid rate. No DB, cache, credentials or retries; caching is nbp227.ts. */
import type { ProviderReadPolicy, ProviderReadTransport } from './provider-read-transport';
import { daysBetween, isDay, validPublication, type NbpPublication } from './nbp227-model';

export type Nbp227FetchCode = 'REQUEST' | 'TRANSPORT' | 'TIMEOUT' | 'RATE_LIMITED' | 'HTTP' | 'RESPONSE_LIMIT' | 'RESPONSE_SCHEMA' | 'RATE_PRECISION';
export class Nbp227FetchError extends Error {
  constructor(public readonly code: Nbp227FetchCode, public readonly HTTP_status: number | null = null) { super('NBP table A read: ' + code); this.name = 'Nbp227FetchError'; }
}
const fail = (code: Nbp227FetchCode, status: number | null = null) => new Nbp227FetchError(code, status);
const MAX_BYTES = 65_536, ORIGIN = 'https://api.nbp.pl';
export const NBP227_TIMEOUT_MS = 8_000;

const code = (currency: string) => { if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || currency === 'PLN') throw fail('REQUEST'); return currency.toLowerCase(); };
/** Routes of the day and range endpoints for one currency (declared provider-read policy). */
export function nbp227ReadPolicy(currency: string): ProviderReadPolicy {
  const c = code(currency), get = ['GET'] as const;
  return { routes: [
    { origin: ORIGIN, path: `/api/exchangerates/rates/a/${c}/:date/`, methods: get, queryKeys: ['format'] },
    { origin: ORIGIN, path: `/api/exchangerates/rates/a/${c}/:start/:end/`, methods: get, queryKeys: ['format'] },
  ] };
}
export function nbp227Url(currency: string, start: string, end?: string): string {
  const c = code(currency);
  if (!isDay(start) || (end !== undefined && (!isDay(end) || end < start || daysBetween(start, end) > 92))) throw fail('REQUEST');
  return `${ORIGIN}/api/exchangerates/rates/a/${c}/${start}/${end === undefined ? '' : end + '/'}?format=json`;
}

async function bodyText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw fail('RESPONSE_SCHEMA');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > MAX_BYTES) throw fail('RESPONSE_LIMIT'); chunks.push(r.value); }
    try { return new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks, size)); } catch { throw fail('RESPONSE_SCHEMA'); }
  } finally { try { await reader.cancel(); } catch { /* keep the first failure */ } }
}
const exactKeys = (v: unknown, keys: string[]) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');

/** Validated NBP reply: table A, the asked currency, 1..93 ascending publications inside the
 * asked dates, mid as its JSON source text (no float math) with at most 4 decimals. */
export function parseNbp227Reply(text: string, currency: string, start: string, end: string): NbpPublication[] {
  let value: any;
  try { value = JSON.parse(text, function (this: any, key, v, context?: { source?: string }) { return key === 'mid' && typeof v === 'number' ? { mid_source: context?.source } : v; }); }
  catch { throw fail('RESPONSE_SCHEMA'); }
  if (!exactKeys(value, ['table', 'currency', 'code', 'rates']) || value.table !== 'A' || value.code !== currency || typeof value.currency !== 'string'
    || !Array.isArray(value.rates) || value.rates.length < 1 || value.rates.length > 93) throw fail('RESPONSE_SCHEMA');
  const out: NbpPublication[] = [];
  for (const r of value.rates) {
    if (!exactKeys(r, ['no', 'effectiveDate', 'mid']) || typeof r.no !== 'string' || typeof r.effectiveDate !== 'string' || !exactKeys(r.mid, ['mid_source']) || typeof r.mid.mid_source !== 'string')
      throw fail('RESPONSE_SCHEMA');
    if (!/^(0|[1-9]\d{0,5})(?:\.\d{1,4})?$/.test(r.mid.mid_source)) throw fail('RATE_PRECISION');
    const p = { effective_date: r.effectiveDate, table_no: r.no, mid: r.mid.mid_source as string };
    if (!validPublication(p) || p.effective_date < start || p.effective_date > end || (out.length && out.at(-1)!.effective_date >= p.effective_date)) throw fail('RESPONSE_SCHEMA');
    out.push(p);
  }
  return out;
}

export type Nbp227ReadInput = { currency: string; start: string; end?: string; transport: ProviderReadTransport; signal?: AbortSignal; timeoutMs?: number };
/** One GET of the day endpoint (end omitted) or the range endpoint. 404 "Brak danych" = no
 * table A publication in those dates, returned as an empty list. */
export async function readNbp227TableA(input: Nbp227ReadInput): Promise<NbpPublication[]> {
  const url = nbp227Url(input.currency, input.start, input.end), timeout = input.timeoutMs ?? NBP227_TIMEOUT_MS;
  if (typeof input.transport !== 'function' || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw fail('REQUEST');
  const timer = AbortSignal.timeout(timeout), signal = input.signal ? AbortSignal.any([input.signal, timer]) : timer;
  let response: Response;
  try { response = await input.transport(url, { method: 'GET', headers: { Accept: 'application/json' }, signal }); }
  catch { throw fail(timer.aborted ? 'TIMEOUT' : 'TRANSPORT'); }
  if (response.status === 404) { try { await response.body?.cancel(); } catch { /* empty */ } return []; }
  if (response.status !== 200) { try { await response.body?.cancel(); } catch { /* empty */ } throw fail(response.status === 429 ? 'RATE_LIMITED' : 'HTTP', response.status); }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { try { await response.body?.cancel(); } catch { /* empty */ } throw fail('RESPONSE_SCHEMA'); }
  let text: string;
  try { text = await bodyText(response); } catch (e) { if (e instanceof Nbp227FetchError) throw e; throw fail(timer.aborted ? 'TIMEOUT' : 'RESPONSE_SCHEMA'); }
  return parseNbp227Reply(text, input.currency, input.start, input.end ?? input.start);
}
/** Polish reason for a failed read. */
export function nbp227FetchProblem(e: unknown): { status: number; message: string } {
  const c = e instanceof Nbp227FetchError ? e.code : 'TRANSPORT';
  return c === 'TIMEOUT' ? { status: 504, message: 'NBP nie odpowiedział w czasie. Spróbuj ponownie albo wpisz kurs ręcznie.' }
    : c === 'RATE_LIMITED' ? { status: 429, message: 'Limit odczytów NBP. Spróbuj później albo wpisz kurs ręcznie.' }
      : c === 'REQUEST' ? { status: 422, message: 'Niepoprawne zapytanie o kurs NBP' }
        : { status: 502, message: 'Nie udało się odczytać poprawnej tabeli A z NBP. Wpisz kurs ręcznie.' };
}
