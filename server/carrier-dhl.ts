import { setTimeout as sleepFor } from 'node:timers/promises';
import { ensure, Problem } from './errors';
import type { Transport } from './integrations';
import {
  DHL_NS,
  DHL_MAX_RESPONSE_BYTES,
  invalidDhl,
  items,
  kids,
  one,
  parseSoapResponse,
  soapRequest,
  text,
  type SoapFault,
  type XmlNode,
  type XmlValue,
} from './carrier-dhl-xml';
import {
  dhlEventTime,
  dhlFingerprint,
  dhlPdf,
  dhlPickupWindow,
  dhlReference,
  dhlStatus,
  dhlTime,
  parseDhlInput,
  splitStreet,
  validNrb,
  warsawNow,
  type DhlInput,
  type DhlPickupWindow,
} from './carrier-dhl-values';
export * from './carrier-dhl-values';
// DHL Parcel Polska WebAPI2 (DHL24) SOAP client. Pure module: the caller supplies the transport
// (later the policy-guarded safeFetch, in tests the local fake from carrier-dhl-fake.ts).
export const DHL_ENDPOINTS = {
  sandbox: 'https://sandbox.dhl24.com.pl/webapi2',
  live: 'https://dhl24.com.pl/webapi2',
} as const;
export type DhlMode = keyof typeof DHL_ENDPOINTS;
export interface DhlSettings {
  sap_account?: string;
  endpoint?: string;
  simulation?: boolean;
}
export interface DhlCredentials {
  username?: string;
  password?: string;
}
export interface DhlOptions {
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => Date;
  store?: DhlIdempotencyStore;
}
// Creation and courier booking are claimed under a caller key before any network call.
// Wiring replaces the in-memory store with shipping_plans / pickup rows (phase create_started).
export type DhlClaim = { state: 'new' } | { state: 'started' } | { state: 'done'; result: unknown };
export interface DhlIdempotencyStore {
  claim(key: string, fingerprint: string): Promise<DhlClaim>;
  finish(key: string, result: unknown): Promise<void>;
  release(key: string): Promise<void>;
}
export function memoryDhlStore(): DhlIdempotencyStore {
  const rows = new Map<string, { fingerprint: string; done: boolean; result?: unknown }>();
  return {
    async claim(key, fingerprint) {
      const row = rows.get(key);
      if (!row) {
        rows.set(key, { fingerprint, done: false });
        return { state: 'new' };
      }
      ensure(row.fingerprint === fingerprint, 409, 'Klucz idempotencji DHL użyto z innymi danymi');
      return row.done ? { state: 'done', result: row.result } : { state: 'started' };
    },
    async finish(key, result) {
      const row = rows.get(key);
      if (row) rows.set(key, { ...row, done: true, result });
    },
    async release(key) {
      rows.delete(key);
    },
  };
}
export interface DhlCreated {
  waybill: string;
  reference: string;
  trace_id: string | null;
  cod: { amount: number; currency: 'PLN'; bank_account: string } | null;
  replayed: boolean;
}
export type DhlLabelType = 'LP' | 'BLP' | 'LBLP' | 'ZBLP';
export interface DhlLabel {
  waybill: string;
  label_type: DhlLabelType;
  label_base64: string;
  mime: string;
  trace_id: string | null;
}
export interface DhlEvent {
  code: string;
  datetime: string;
  waybill: string;
  object_id: string;
  status: string | null;
  description: string;
  terminal: string;
}
export interface DhlTracking {
  tracking_number: string;
  current_waybill: string;
  return_leg: boolean;
  lineage: { waybill: string; return_leg: boolean }[];
  status: string;
  tracking_details: DhlEvent[];
  provider_updated_at: string | null;
  provider_created_at: string | null;
  scope: 'external_api_verified' | 'external_sandbox_verified';
  empty_history: boolean;
  received_by: string | null;
}
export interface DhlPoint {
  id: string;
  name: string;
  type: string;
  address: { street: string; postalCode: string; city: string };
  location: { lat: number; lng: number } | null;
  hours: { day: string; open: string; close: string }[];
  description: string;
}
export interface DhlPostcodeServices extends DhlPickupWindow {
  postcode: string;
  express9: boolean;
  express12: boolean;
  evening: boolean;
}
export interface DhlPickupInput {
  date: string;
  from: string;
  to: string;
  waybills: string[];
  postcode?: string;
  info?: string;
}
export interface DhlPickupBooked {
  order_ids: string[];
  date: string;
  from: string;
  to: string;
  waybills: string[];
  replayed: boolean;
}
const waybillOK = (v: string) => /^\d{8,20}$/.test(v);
const pln = (grosze: number) => (grosze / 100).toFixed(2);
const yes = (v: string) => v === 'true' || v === '1';
const retryable = new Set([429, 502, 503, 504]);
// Faults carry provider text; only a classified Polish message and a sanitized fault code leave this module.
export function dhlFaultProblem(fault: SoapFault): Problem {
  const s = `${fault.code} ${fault.message}`.toLowerCase();
  const code = /^[A-Za-z0-9_.:-]{1,40}$/.test(fault.code) ? fault.code : 'unknown';
  const p = (status: number, message: string, kind: string) =>
    new Problem(status, message, `${kind}:${code}`);
  if (/autoryz|authori|authent|login|has[łl]o|password|credential|unauthori/.test(s))
    return p(401, 'DHL24 odrzucił login lub hasło WebAPI2; sprawdź dane konta', 'DHL_AUTH');
  if (/uprawnie|permission|access denied|forbidden|sap|numer klienta/.test(s))
    return p(403, 'Konto DHL24 nie ma uprawnień do tej operacji lub numeru SAP', 'DHL_FORBIDDEN');
  if (/kod pocztow|postal|postcode|post code/.test(s))
    return p(422, 'DHL24 odrzucił kod pocztowy nadawcy lub odbiorcy', 'DHL_VALIDATION');
  if (/wag|weight|wymiar|dimension/.test(s))
    return p(422, 'DHL24 odrzucił wagę lub wymiary paczki', 'DHL_VALIDATION');
  if (/pobrani|collectondelivery|cod|rachun|account/.test(s))
    return p(422, 'DHL24 odrzucił pobranie (kwotę lub rachunek)', 'DHL_VALIDATION');
  if (/ubezpiecz|insurance/.test(s))
    return p(422, 'DHL24 odrzucił wartość ubezpieczenia', 'DHL_VALIDATION');
  if (/kurier|courier|odbi[oó]r|pickup|godzin|termin/.test(s))
    return p(422, 'DHL24 odrzucił termin lub godziny odbioru', 'DHL_VALIDATION');
  if (/nie znalez|not found|nie istnie|brak przesy/.test(s))
    return p(404, 'DHL24 nie zna tej przesyłki lub zlecenia', 'DHL_NOT_FOUND');
  if (/limit|too many|przekrocz/.test(s))
    return p(429, 'DHL24 ograniczył liczbę zapytań; spróbuj później', 'DHL_RATE_LIMIT');
  if (/^(soap-env:|soap:)?client/.test(fault.code.toLowerCase()))
    return p(422, 'DHL24 odrzucił dane żądania', 'DHL_VALIDATION');
  return p(502, 'DHL24 zwrócił błąd usługi', 'DHL_FAULT');
}
export class Dhl {
  readonly endpoint: string;
  readonly mode: DhlMode;
  private readonly sap: string;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<unknown>;
  private readonly now: () => Date;
  private readonly store: DhlIdempotencyStore;
  constructor(
    mode: string,
    private readonly settings: DhlSettings,
    private readonly credentials: DhlCredentials,
    private readonly transport: Transport,
    options: DhlOptions = {},
  ) {
    ensure(mode === 'sandbox' || mode === 'live', 422, 'Nieprawidłowe środowisko DHL');
    this.mode = mode;
    this.endpoint = settings.endpoint ?? DHL_ENDPOINTS[mode];
    const u = new URL(this.endpoint);
    ensure(
      u.protocol === 'https:' &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        (!u.port || u.port === '443') &&
        (u.hostname === 'dhl24.com.pl' || u.hostname.endsWith('.dhl24.com.pl')) &&
        (mode === 'sandbox') === u.hostname.startsWith('sandbox.'),
      422,
      'Adres DHL24 musi być oficjalnym adresem HTTPS zgodnym ze środowiskiem',
    );
    ensure(/^\d{4,10}$/.test(settings.sap_account ?? ''), 422, 'Wymagany numer klienta SAP DHL');
    this.sap = settings.sap_account!;
    ensure(
      credentials.username &&
        credentials.password &&
        credentials.username.length <= 100 &&
        credentials.password.length <= 200 &&
        [credentials.username, credentials.password].every((v) => !/[\x00-\x1f]/.test(v)),
      422,
      'Wymagany login i hasło DHL24 WebAPI2',
    );
    this.timeoutMs = options.timeoutMs ?? 12000;
    this.sleep = options.sleep ?? ((ms) => sleepFor(ms));
    this.now = options.now ?? (() => new Date());
    this.store = options.store ?? memoryDhlStore();
  }
  /** The same client with another idempotency store (wiring: the shipping plan or pickup row). */
  withStore(store: DhlIdempotencyStore): Dhl {
    return new Dhl(this.mode, this.settings, this.credentials, this.transport, {
      timeoutMs: this.timeoutMs,
      sleep: this.sleep,
      now: this.now,
      store,
    });
  }
  private async send(url: string, init: RequestInit): Promise<Response> {
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = globalThis.setTimeout(() => {
        abort.abort();
        reject(new Problem(504, 'timeout', 'DHL_TIMEOUT'));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.transport(url, { ...init, signal: abort.signal }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async read(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) invalidDhl();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > DHL_MAX_RESPONSE_BYTES) invalidDhl();
        chunks.push(value);
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch (e) {
      if (e instanceof Problem) throw e;
      invalidDhl();
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  // Only idempotent reads are retried (429/502/503/504, timeouts, network errors). Mutations get one
  // attempt; a lost response becomes DHL_UNCERTAIN and is reconciled by reference, never resent.
  async call(method: string, params: Record<string, XmlValue>, idempotent: boolean): Promise<XmlNode> {
    const body = soapRequest(method, {
      authData: { username: this.credentials.username!, password: this.credentials.password! },
      ...params,
    });
    const attempts = idempotent ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const last = attempt === attempts - 1;
      let res: Response;
      try {
        res = await this.send(this.endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction: `"${DHL_NS}#${method}"`,
            Accept: 'text/xml',
          },
          body,
        });
      } catch {
        if (!last) {
          await this.sleep(250 * 2 ** attempt);
          continue;
        }
        if (!idempotent)
          throw new Problem(
            504,
            'Brak odpowiedzi DHL24 po wysłaniu zlecenia; wynik niepewny — uzgodnij przed ponowieniem',
            'DHL_UNCERTAIN',
          );
        throw new Problem(504, 'DHL24 nie odpowiedział w wyznaczonym czasie', 'DHL_TIMEOUT');
      }
      if (retryable.has(res.status) && !last) {
        await res.body?.cancel().catch(() => {});
        const retry = Number(res.headers.get('retry-after'));
        await this.sleep(Math.min(5000, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 250 * 2 ** attempt));
        continue;
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        throw new Problem(502, 'DHL24 odpowiedział przekierowaniem; połączenie odrzucone', 'DHL_REDIRECT');
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => {});
        throw new Problem(401, 'DHL24 odrzucił login lub hasło WebAPI2; sprawdź dane konta', 'DHL_AUTH:http');
      }
      if (!res.ok && res.status !== 500) {
        await res.body?.cancel().catch(() => {});
        if (!idempotent && res.status >= 500)
          throw new Problem(504, 'DHL24 zwrócił błąd po wysłaniu zlecenia; wynik niepewny — uzgodnij przed ponowieniem', 'DHL_UNCERTAIN');
        throw new Problem(
          res.status === 429 ? 429 : 502,
          res.status === 429 ? 'DHL24 ograniczył liczbę zapytań; spróbuj później' : `DHL24 niedostępny (HTTP ${res.status})`,
          res.status === 429 ? 'DHL_RATE_LIMIT' : 'DHL_UNAVAILABLE',
        );
      }
      // SOAP faults arrive as HTTP 500 with a Fault body; any other 500 body on a mutation is uncertain.
      let parsed;
      try {
        parsed = parseSoapResponse(await this.read(res), method);
      } catch (e) {
        if (!idempotent && res.status === 500)
          throw new Problem(504, 'DHL24 zwrócił błąd po wysłaniu zlecenia; wynik niepewny — uzgodnij przed ponowieniem', 'DHL_UNCERTAIN');
        throw e;
      }
      if (parsed.fault) throw dhlFaultProblem(parsed.fault);
      if (!res.ok) invalidDhl();
      return parsed.result;
    }
    throw new Problem(502, 'DHL24 niedostępny po ponowieniach', 'DHL_UNAVAILABLE');
  }
  async postcodeServices(postcode: string, date = warsawNow(this.now()).date): Promise<DhlPostcodeServices> {
    ensure(/^\d{5}$/.test(postcode) && /^\d{4}-\d{2}-\d{2}$/.test(date), 422, 'Wymagany polski kod pocztowy i data');
    const r = await this.call('getPostalCodeServices', { postCode: postcode, pickupDate: date }, true);
    const from = text(r, 'drPickupFrom', false),
      to = text(r, 'drPickupTo', false);
    if ((from && !dhlTime.safeParse(from).success) || (to && !dhlTime.safeParse(to).success)) invalidDhl();
    return {
      postcode,
      from: from || '00:00',
      to: to || '23:59',
      saturday: yes(text(r, 'pickupOnSaturday', false)),
      express9: yes(text(r, 'domesticExpress9', false)),
      express12: yes(text(r, 'domesticExpress12', false)),
      evening: yes(text(r, 'deliveryEvening', false)),
    };
  }
  // connection: authenticated bounded read. WebAPI2 has no account-identity method known to us,
  // so the SAP number is the configured one; createShipments uses it as payment.accountNumber.
  async test() {
    const services = await this.postcodeServices('00909');
    return { mode: this.mode, endpoint: this.endpoint, sap_account: this.sap, auth: 'verified', services };
  }
  shipmentPayload(input: DhlInput, reference: string): Record<string, XmlValue> {
    const party = (a: DhlInput['sender']) => ({
      name: a.name,
      postalCode: a.postalCode,
      city: a.city,
      ...splitStreet(a),
      contactPerson: a.name,
      contactPhone: a.phone,
      contactEmail: a.email,
    });
    const { length, width, height } = input.dimensions;
    const cod = input.cod > 0;
    return {
      shipments: [
        {
          shipper: party(input.sender),
          receiver: { country: 'PL', addressType: 'B', ...party(input.receiver) },
          pieceList: [
            {
              type: 'PACKAGE',
              width,
              height,
              length,
              weight: Math.ceil(input.weight),
              quantity: 1,
              nonStandard: length > 120 || width > 60 || height > 60,
            },
          ],
          payment: { paymentMethod: 'BANK_TRANSFER', payerType: 'SHIPPER', accountNumber: this.sap },
          service: {
            product: 'AH',
            collectOnDelivery: cod,
            ...(cod
              ? {
                  collectOnDeliveryValue: pln(input.cod),
                  collectOnDeliveryForm: 'BANK_TRANSFER',
                  collectOnDeliveryReference: reference,
                }
              : {}),
            insurance: input.insurance > 0,
            ...(input.insurance > 0 ? { insuranceValue: pln(input.insurance) } : {}),
          },
          shipmentDate: input.shipment_date ?? warsawNow(this.now()).date,
          content: input.content,
          comment: input.comment,
          reference,
          skipRestrictionCheck: false,
        },
      ],
    };
  }
  async create(body: unknown, idempotencyKey: string): Promise<DhlCreated> {
    const input = parseDhlInput(body);
    const reference = dhlReference(idempotencyKey);
    const payload = this.shipmentPayload(input, reference);
    const cod = input.cod
      ? { amount: input.cod, currency: 'PLN' as const, bank_account: input.cod_bank_account!.replace(/[\s-]/g, '').replace(/^PL/i, '') }
      : null;
    ensure(!cod || validNrb(cod.bank_account), 422, 'Pobranie wymaga poprawnego rachunku bankowego (NRB)');
    const key = 'shipment:' + idempotencyKey;
    const claim = await this.store.claim(key, dhlFingerprint({ input, sap: this.sap }));
    if (claim.state === 'done') return { ...(claim.result as DhlCreated), replayed: true };
    if (claim.state === 'started') {
      const found = await this.findByReference(reference, input.shipment_date);
      ensure(found.length <= 1, 409, 'DHL24 ma kilka przesyłek z tą referencją; uzgodnij ręcznie');
      ensure(
        found.length === 1,
        409,
        'Poprzednia próba utworzenia przesyłki DHL ma niepewny wynik i nie ma jej w DHL24; sprawdź panel DHL24 przed ponowieniem',
      );
      const result: DhlCreated = { waybill: found[0], reference, trace_id: null, cod, replayed: false };
      await this.store.finish(key, result);
      return { ...result, replayed: true };
    }
    let r: XmlNode;
    try {
      r = await this.call('createShipments', payload, false);
    } catch (e) {
      // Definite rejection: nothing was created, the key may be reused. Uncertain outcome keeps the claim.
      if (e instanceof Problem && !e.code?.startsWith('DHL_UNCERTAIN') && e.code !== 'DHL_INVALID_RESPONSE')
        await this.store.release(key);
      throw e;
    }
    const created = items(r);
    if (created.length !== 1) invalidDhl();
    const waybill = text(created[0], 'shipmentId');
    if (!waybillOK(waybill)) invalidDhl();
    const result: DhlCreated = { waybill, reference, trace_id: null, cod, replayed: false };
    await this.store.finish(key, result);
    return result;
  }
  // Reconciliation read for a lost createShipments response: own shipments created around the shipment date.
  async findByReference(reference: string, shipmentDate?: string): Promise<string[]> {
    ensure(/^DY[0-9A-F]{20}$/.test(reference), 422, 'Nieprawidłowa referencja DHL');
    const day = shipmentDate ?? warsawNow(this.now()).date;
    const shift = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    const found: string[] = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const r = await this.call('getMyShipments', { createdFrom: shift(day, -1), createdTo: shift(day, 1), offset }, true);
      const page = items(r);
      for (const n of page)
        if (text(n, 'reference', false) === reference) {
          const id = text(n, 'shipmentId');
          if (!waybillOK(id)) invalidDhl();
          found.push(id);
        }
      if (page.length < 100) break;
    }
    return [...new Set(found)];
  }
  async labels(waybill: string, type: DhlLabelType = 'BLP'): Promise<DhlLabel> {
    ensure(waybillOK(waybill), 422, 'Nieprawidłowy numer przesyłki DHL');
    ensure(['LP', 'BLP', 'LBLP', 'ZBLP'].includes(type), 422, 'Nieprawidłowy typ etykiety DHL');
    const r = await this.call('getLabels', { itemsToPrint: [{ labelType: type, shipmentId: waybill }] }, true);
    const list = items(r);
    ensure(
      list.length === 1 &&
        text(list[0], 'shipmentId') === waybill &&
        ['', type].includes(text(list[0], 'labelType', false)),
      502,
      'Brak jednoznacznej etykiety DHL dla tej przesyłki; sprawdź wynik u dostawcy',
    );
    const data = text(list[0], 'labelData').replace(/\s+/g, '');
    const mime = text(list[0], 'labelMimeType', false) || (type === 'ZBLP' ? 'text/plain' : 'application/pdf');
    if (type === 'ZBLP') {
      const zpl = Buffer.from(data, 'base64');
      ensure(zpl.length > 0 && zpl.length <= 1024 * 1024 && zpl.toString('latin1').includes('^XA'), 502, 'Nieprawidłowa etykieta ZPL DHL');
    } else {
      ensure(mime === 'application/pdf', 502, 'Nieprawidłowa etykieta PDF DHL');
      dhlPdf(data);
    }
    return { waybill, label_type: type, label_base64: data, mime, trace_id: null };
  }
  async events(waybill: string): Promise<{ events: DhlEvent[]; receivedBy: string | null }> {
    ensure(waybillOK(waybill), 422, 'Nieprawidłowy numer przesyłki DHL');
    const r = await this.call('getTrackAndTraceInfo', { shipmentId: waybill }, true);
    // A foreign number in the answer must never touch the local shipment.
    if (text(r, 'shipmentId') !== waybill) invalidDhl();
    const list = items(kids(r, 'events')[0]);
    if (kids(r, 'events').length > 1 || list.length > 1000) invalidDhl();
    const events = list.map((n, i) => {
      const code = text(n, 'status');
      if (!/^[A-Z0-9_]{1,20}$/.test(code)) invalidDhl();
      return {
        code,
        datetime: dhlEventTime(text(n, 'timestamp')),
        waybill,
        object_id: String(i),
        status: dhlStatus(code),
        description: text(n, 'description', false).slice(0, 300),
        terminal: text(n, 'terminal', false).slice(0, 100),
      };
    });
    return { events, receivedBy: text(r, 'receivedBy', false).slice(0, 100) || null };
  }
  // Same result shape as DpdInfo.tracking (server/dpd-info.ts) so tracking.ts can store it unchanged.
  async tracking(s: { tracking_number: string; tracking_data?: Partial<DhlTracking> | null }): Promise<DhlTracking> {
    const previous = s.tracking_data;
    const { events, receivedBy } = await this.events(s.tracking_number);
    const key = (e: DhlEvent) => [e.waybill, e.code, e.datetime].join(':');
    const details = new Map<string, DhlEvent>();
    for (const e of previous?.tracking_details ?? []) if (e?.code && e.waybill === s.tracking_number) details.set(key(e), e);
    for (const e of events) details.set(key(e), e);
    const all = [...details.values()].sort((a, b) => a.datetime.localeCompare(b.datetime) || a.code.localeCompare(b.code));
    if (all.length > 5000) invalidDhl();
    const known = all.filter((e) => e.status);
    const status = known.at(-1)?.status ?? previous?.status ?? 'unknown';
    return {
      tracking_number: s.tracking_number,
      current_waybill: s.tracking_number,
      return_leg: status === 'return_in_transit' || status === 'returned_to_sender',
      lineage: [{ waybill: s.tracking_number, return_leg: false }],
      status,
      tracking_details: all,
      provider_updated_at: all.at(-1)?.datetime ?? previous?.provider_updated_at ?? null,
      provider_created_at: null,
      scope: this.mode === 'sandbox' ? 'external_sandbox_verified' : 'external_api_verified',
      empty_history: events.length === 0,
      received_by: receivedBy ?? previous?.received_by ?? null,
    };
  }
  async bookPickup(b: DhlPickupInput, idempotencyKey: string): Promise<DhlPickupBooked> {
    ensure(
      Array.isArray(b.waybills) &&
        b.waybills.length >= 1 &&
        b.waybills.length <= 200 &&
        b.waybills.every(waybillOK) &&
        new Set(b.waybills).size === b.waybills.length,
      422,
      'Wybierz od 1 do 200 różnych przesyłek DHL do odbioru',
    );
    ensure(b.info === undefined || (b.info.length <= 50 && !/[\x00-\x1f]/.test(b.info)), 422, 'Uwagi dla kuriera do 50 znaków');
    ensure(/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey), 422, 'Nieprawidłowy klucz idempotencji DHL');
    dhlPickupWindow(b.date, b.from, b.to, undefined, this.now());
    const waybills = [...b.waybills].sort();
    const key = 'pickup:' + idempotencyKey;
    const claim = await this.store.claim(key, dhlFingerprint({ date: b.date, from: b.from, to: b.to, waybills }));
    if (claim.state === 'done') return { ...(claim.result as DhlPickupBooked), replayed: true };
    ensure(
      claim.state === 'new',
      409,
      'Poprzednie zamówienie kuriera DHL ma niepewny wynik; sprawdź zlecenie w DHL24 przed ponowieniem',
    );
    let r: XmlNode;
    try {
      if (b.postcode) {
        const allowed = await this.postcodeServices(b.postcode, b.date);
        dhlPickupWindow(b.date, b.from, b.to, allowed, this.now());
      }
      r = await this.call(
        'bookCourier',
        { pickupDate: b.date, pickupTimeFrom: b.from, pickupTimeTo: b.to, additionalInfo: b.info, shipmentIdList: waybills },
        false,
      );
    } catch (e) {
      if (e instanceof Problem && !e.code?.startsWith('DHL_UNCERTAIN') && e.code !== 'DHL_INVALID_RESPONSE')
        await this.store.release(key);
      throw e;
    }
    const ids = items(r).map((n) => {
      if (n.children.length || !/^[A-Za-z0-9-]{1,40}$/.test(n.text.trim())) invalidDhl();
      return n.text.trim();
    });
    if (!ids.length) invalidDhl();
    const result: DhlPickupBooked = { order_ids: ids, date: b.date, from: b.from, to: b.to, waybills, replayed: false };
    await this.store.finish(key, result);
    return result;
  }
  async cancelPickup(orderId: string): Promise<{ order_id: string; cancelled: true }> {
    ensure(/^[A-Za-z0-9-]{1,40}$/.test(orderId), 422, 'Nieprawidłowy numer zlecenia odbioru DHL');
    const r = await this.call('cancelCourierBooking', { orders: [orderId] }, false);
    const list = items(r);
    if (list.length !== 1 || text(list[0], 'id') !== orderId) invalidDhl();
    ensure(yes(text(list[0], 'result')), 409, 'DHL24 nie anulował zlecenia odbioru (mogło już zostać zrealizowane)');
    return { order_id: orderId, cancelled: true };
  }
  async points(q: { postcode: string; city?: string; radius?: number }): Promise<DhlPoint[]> {
    ensure(/^\d{2}-?\d{3}$/.test(q.postcode), 422, 'Wymagany polski kod pocztowy');
    const radius = q.radius ?? 5;
    ensure(Number.isInteger(radius) && radius >= 1 && radius <= 50, 422, 'Promień wyszukiwania 1–50 km');
    ensure(q.city === undefined || (q.city.length <= 50 && !/[\x00-\x1f]/.test(q.city)), 422, 'Nieprawidłowe miasto');
    const r = await this.call(
      'getNearestServicepoints',
      { structure: { postcode: q.postcode.replace('-', ''), city: q.city, radius } },
      true,
    );
    const list = items(kids(r, 'points')[0]);
    if (kids(r, 'points').length > 1 || list.length > 500) invalidDhl();
    return list.map((n) => {
      const id = text(n, 'sap'),
        a = one(n, 'address');
      const postalCode = text(a, 'postcode');
      if (!/^[A-Za-z0-9-]{1,20}$/.test(id) || !/^\d{2}-?\d{3}$/.test(postalCode)) invalidDhl();
      const lat = Number(text(n, 'latitude', false)),
        lng = Number(text(n, 'longitude', false));
      const hours = items(kids(n, 'workingHours')[0]).map((h) => {
        const open = text(h, 'open'),
          close = text(h, 'close');
        if (!dhlTime.safeParse(open).success || !dhlTime.safeParse(close).success) invalidDhl();
        return { day: text(h, 'day').slice(0, 10), open, close };
      });
      return {
        id,
        name: text(n, 'name').slice(0, 100),
        type: text(n, 'type', false).slice(0, 30) || 'POP',
        address: {
          street: [text(a, 'street', false), text(a, 'houseNumber', false)].filter(Boolean).join(' ').slice(0, 100),
          postalCode: postalCode.replace('-', ''),
          city: text(a, 'city').slice(0, 50),
        },
        location:
          Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng)
            ? { lat, lng }
            : null,
        hours,
        description: text(n, 'description', false).slice(0, 300),
      };
    });
  }
}
