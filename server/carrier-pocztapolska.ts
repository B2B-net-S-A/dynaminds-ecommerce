import { setTimeout as sleep } from 'node:timers/promises';
import { ensure, Problem } from './errors';
import { safeFetch, type Transport } from './integrations';
import {
  el,
  escapeXml,
  kids,
  parseSoap,
  providerText,
  readLimited,
  textOf,
  type XmlNode,
} from './carrier-pocztapolska-xml';
import {
  PP_GUID,
  PP_TRACKING_NUMBER,
  pocztaPolskaPdf,
  type PocztaPolskaAddressPayload,
  type PocztaPolskaShipment,
} from './carrier-pocztapolska-values';

// eNadawca (Envelo) SOAP client. Shape follows Dpd in server/integrations.ts:
// constructor(mode, settings, credentials, transport), test(), create(), labels().
// Element names follow the public en.wsdl as documented; every one of them must be
// confirmed against the sandbox WSDL (see docs/parity/CARRIER-POCZTAPOLSKA-20261025.md).

export const PP_ENADAWCA_ENDPOINTS = {
  sandbox: 'https://en-testwebapi.poczta-polska.pl/websrv/en.php',
  live: 'https://e-nadawca.poczta-polska.pl/websrv/en.php',
} as const;
export const PP_NS = 'http://e-nadawca.poczta-polska.pl';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const MAX_BYTES = 10 * 1024 * 1024;
export const PP_UNCERTAIN = 'PP_OUTCOME_UNCERTAIN';
export const PP_DUPLICATE = 'PP_DUPLICATE_GUID';

export type PocztaPolskaOptions = {
  /** Per-request timeout; safeFetch additionally enforces its own 12 s. */
  timeoutMs?: number;
  /** Backoff hook (tests pass a no-op). */
  sleep?: (ms: number) => Promise<unknown>;
};
export type PocztaPolskaOffice = { id: string; description: string; name: string };
export type PocztaPolskaCreated = { guid: string; tracking_number: string };
export type PocztaPolskaLabel = { guid: string; label_base64: string; pdf: Buffer };
export type PocztaPolskaPoint = {
  id: string;
  name: string;
  street: string;
  house_number: string;
  postal_code: string;
  city: string;
  hours: { day: string; hours: string }[];
  pickup: boolean;
};
type CallOptions = { idempotent: boolean; maxBytes?: number };

export function invalidPocztaPolska(): never {
  throw new Problem(502, 'Nieprawidłowa odpowiedź Poczty Polskiej');
}
const invalid: () => never = invalidPocztaPolska;

/** SOAP Fault → Problem. Faults are a definite answer: the request was processed and refused. */
export function pocztaPolskaFault(code: string, message: string): Problem {
  const local = code.split(':').pop() ?? '';
  const text = providerText(message);
  if (/^(FailedAuthentication|InvalidSecurity|InvalidSecurityToken|Unauthorized)$/i.test(local))
    return new Problem(401, 'Poczta Polska odrzuciła login lub hasło', 'PROVIDER_HTTP_UNAUTHORIZED');
  if (/^(Client|Sender)$/i.test(local))
    return new Problem(
      422,
      'Poczta Polska odrzuciła żądanie' + (text ? ': ' + text : ''),
      'PP_SOAP_FAULT_CLIENT',
    );
  return new Problem(
    502,
    'Błąd usługi Poczty Polskiej' + (text ? ': ' + text : ''),
    'PP_SOAP_FAULT_SERVER',
  );
}

/** eNadawca errorType list → one Problem with the provider descriptions (Polish already). */
export function pocztaPolskaErrors(nodes: XmlNode[]): Problem | null {
  const errors = nodes.map((n) => ({
    number: textOf(n, 'errorNumber', invalid, false),
    desc: providerText(textOf(n, 'errorDesc', invalid, false)),
  }));
  if (!errors.length) return null;
  const text = errors
    .map((e) => (e.number ? `[${e.number}] ` : '') + e.desc)
    .join('; ')
    .slice(0, 400);
  // Duplicate guid: the shipment already exists in the buffer; reconcile by reading it (unverified wording).
  if (errors.some((e) => /guid/i.test(e.desc) && /istnieje|exists|duplik/i.test(e.desc)))
    return new Problem(409, 'Przesyłka o tym identyfikatorze już istnieje w eNadawcy', PP_DUPLICATE);
  return new Problem(422, 'Poczta Polska odrzuciła dane przesyłki: ' + text, 'PP_REJECTED');
}

function addressXml(tag: string, a: PocztaPolskaAddressPayload) {
  return `<${tag}>${el('nazwa', a.nazwa)}${el('ulica', a.ulica)}${el('numerDomu', a.numerDomu)}${el('numerLokalu', a.numerLokalu)}${el('miejscowosc', a.miejscowosc)}${el('kodPocztowy', a.kodPocztowy)}${el('kraj', a.kraj)}${el('mobile', a.telefon)}${el('email', a.email)}</${tag}>`;
}

/** One przesylki element of addShipment. Exported for contract tests. */
export function shipmentXml(s: PocztaPolskaShipment): string {
  ensure(PP_GUID.test(s.guid), 422, 'Nieprawidłowy identyfikator przesyłki');
  const cod = s.pobranie
    ? `<pobranie>${el('sposobPobrania', s.pobranie.sposobPobrania)}${el('kwotaPobrania', s.pobranie.kwotaPobrania)}${el('nrb', s.pobranie.nrb)}${el('tytulem', s.pobranie.tytulem)}</pobranie>`
    : '';
  const point = s.punktOdbioru
    ? `<odbiorWPunkcie>true</odbiorWPunkcie>${el('idPunktuOdbioru', s.punktOdbioru)}`
    : '';
  return (
    `<przesylki xsi:type="en:${s.xsiType}" guid="${escapeXml(s.guid)}">` +
    addressXml('adres', s.adres) +
    addressXml('adresDlaZwrotu', s.adresDlaZwrotu) +
    el('masa', s.masa) +
    el('format', s.format) +
    el('gabaryt', s.gabaryt) +
    el('kategoria', s.kategoria) +
    el('wartosc', s.wartosc) +
    el('opis', s.opis) +
    cod +
    point +
    `</przesylki>`
  );
}

export class PocztaPolska {
  readonly endpoint: string;
  readonly office: string;
  private auth: string;
  private timeoutMs: number;
  private pause: (ms: number) => Promise<unknown>;
  constructor(
    public mode: string,
    settings: Record<string, string>,
    credentials: Record<string, string>,
    private transport: Transport = safeFetch,
    options: PocztaPolskaOptions = {},
  ) {
    ensure(['sandbox', 'live'].includes(mode), 422, 'Nieprawidłowe środowisko Poczty Polskiej');
    ensure(
      /^[1-9]\d{0,9}$/.test(settings.urzad_nadania ?? ''),
      422,
      'Wymagany identyfikator urzędu nadania eNadawcy',
    );
    ensure(
      credentials.username &&
        credentials.username.length <= 200 &&
        !/[:\r\n]/.test(credentials.username) &&
        credentials.password &&
        credentials.password.length <= 200 &&
        !/[\r\n]/.test(credentials.password),
      422,
      'Wymagany login i hasło eNadawcy',
    );
    this.endpoint = PP_ENADAWCA_ENDPOINTS[mode as 'sandbox' | 'live'];
    this.office = settings.urzad_nadania;
    this.auth =
      'Basic ' + Buffer.from(credentials.username + ':' + credentials.password).toString('base64');
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.pause = options.sleep ?? sleep;
  }

  private async send(op: string, body: string): Promise<Response> {
    const controller = new AbortController();
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = globalThis.setTimeout(() => {
        controller.abort();
        reject(new Problem(504, 'Poczta Polska nie odpowiedziała w wyznaczonym czasie', 'PP_TIMEOUT'));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([
        this.transport(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction: `"${PP_NS}/${op}"`,
            Accept: 'text/xml',
            Authorization: this.auth,
          },
          body,
          signal: controller.signal,
        }),
        timeout,
      ]);
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  /**
   * One SOAP operation. Reads retry 429/502/503/504, timeouts and network errors up
   * to 3 times. Mutations never retry: a lost answer becomes PP_OUTCOME_UNCERTAIN.
   */
  async call(op: string, inner: string, o: CallOptions): Promise<XmlNode> {
    const body = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:en="${PP_NS}" xmlns:xsi="${XSI}"><soapenv:Body><en:${op}>${inner}</en:${op}></soapenv:Body></soapenv:Envelope>`;
    const uncertain = (status = 502) =>
      new Problem(
        status,
        'Nie wiadomo, czy Poczta Polska przyjęła operację; uzgodnij wynik odczytem, nie ponawiaj',
        PP_UNCERTAIN,
      );
    const attempts = o.idempotent ? 3 : 1;
    for (let n = 0; n < attempts; n++) {
      let res: Response;
      try {
        res = await this.send(op, body);
      } catch (e) {
        if (!o.idempotent) throw uncertain(e instanceof Problem && e.status === 504 ? 504 : 502);
        if (n < attempts - 1) {
          await this.pause(200 * 2 ** n);
          continue;
        }
        if (e instanceof Problem) throw e;
        throw new Problem(502, 'Brak odpowiedzi Poczty Polskiej', 'PP_NETWORK');
      }
      if (o.idempotent && [429, 502, 503, 504].includes(res.status) && n < attempts - 1) {
        await res.body?.cancel().catch(() => {});
        const retry = Number(res.headers.get('retry-after'));
        await this.pause(
          Math.min(5000, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 200 * 2 ** n),
        );
        continue;
      }
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        throw new Problem(401, 'Poczta Polska odrzuciła login lub hasło eNadawcy', 'PROVIDER_HTTP_UNAUTHORIZED');
      }
      if (res.status === 403) {
        await res.body?.cancel().catch(() => {});
        throw new Problem(422, 'Konto eNadawcy nie ma uprawnień do tej operacji', 'PP_FORBIDDEN');
      }
      if (!res.ok && res.status !== 500) {
        await res.body?.cancel().catch(() => {});
        if (!o.idempotent && res.status >= 500) throw uncertain(res.status === 504 ? 504 : 502);
        throw new Problem(502, `Poczta Polska: HTTP ${res.status}`, 'PP_HTTP');
      }
      let xml: string;
      try {
        xml = await readLimited(res, o.maxBytes ?? MAX_BYTES, invalid);
      } catch (e) {
        if (!o.idempotent) throw uncertain();
        throw e;
      }
      let soap: ReturnType<typeof parseSoap>;
      try {
        soap = parseSoap(xml, invalid, { maxBytes: o.maxBytes ?? MAX_BYTES, maxText: MAX_BYTES });
      } catch (e) {
        // HTTP 500 without a readable Fault, or garbage after a mutation: outcome unknown.
        if (!o.idempotent) throw uncertain();
        throw e;
      }
      if (soap.kind === 'fault') throw pocztaPolskaFault(soap.code, soap.message);
      if (!res.ok) {
        if (!o.idempotent) throw uncertain();
        invalid();
      }
      if (soap.node.name !== op + 'Response' || soap.node.uri !== PP_NS) {
        if (!o.idempotent) throw uncertain();
        invalid();
      }
      return soap.node;
    }
    return invalid();
  }

  /** Connection check: hello plus the configured posting office among the account's offices. */
  async test() {
    const hello = await this.call('hello', '<in>DYNA</in>', { idempotent: true });
    ensure(textOf(hello, 'out', invalid) !== '', 502, 'eNadawca nie potwierdził połączenia');
    const offices = await this.offices();
    const office = offices.find((o) => o.id === this.office);
    ensure(office, 422, 'Urząd nadania z ustawień nie należy do tego konta eNadawcy');
    return {
      environment: this.mode === 'sandbox' ? 'test' : 'production',
      endpoint: new URL(this.endpoint).host,
      office,
    };
  }

  async offices(): Promise<PocztaPolskaOffice[]> {
    const r = await this.call('getUrzedyNadania', '', { idempotent: true });
    const list = kids(r, 'urzedyNadania');
    ensure(list.length <= 500, 502, 'Zbyt wiele urzędów nadania');
    return list.map((n) => {
      const id = textOf(n, 'idUrzeduNadania', invalid);
      if (!/^\d{1,10}$/.test(id)) invalid();
      return {
        id,
        description: providerText(textOf(n, 'opis', invalid, false)),
        name: providerText(textOf(n, 'nazwaWydruku', invalid, false)),
      };
    });
  }

  /** addShipment for exactly one parcel; verifies guid and the returned posting number. */
  async create(s: PocztaPolskaShipment, bufferId?: string): Promise<PocztaPolskaCreated> {
    ensure(!bufferId || /^\d{1,10}$/.test(bufferId), 422, 'Nieprawidłowy identyfikator bufora');
    const r = await this.call('addShipment', shipmentXml(s) + el('idBufor', bufferId), {
      idempotent: false,
    });
    const items = kids(r, 'retval');
    if (items.length !== 1) throw new Problem(502, 'eNadawca nie potwierdził jednej przesyłki; uzgodnij wynik', PP_UNCERTAIN);
    const item = items[0];
    const guid = textOf(item, 'guid', invalid, false) || item.attrs.guid || '';
    const error = pocztaPolskaErrors(kids(item, 'error'));
    if (error) throw error;
    const number = textOf(item, 'numerNadania', invalid, false);
    if (guid !== s.guid || !PP_TRACKING_NUMBER.test(number))
      throw new Problem(502, 'eNadawca nie potwierdził numeru nadania tej przesyłki; uzgodnij wynik', PP_UNCERTAIN);
    return { guid, tracking_number: number };
  }

  /** Buffer contents (read). Used to reconcile a lost addShipment answer by guid. */
  async buffer(bufferId?: string): Promise<PocztaPolskaCreated[]> {
    ensure(!bufferId || /^\d{1,10}$/.test(bufferId), 422, 'Nieprawidłowy identyfikator bufora');
    const r = await this.call('getEnvelopeBufor', el('idBufor', bufferId), { idempotent: true });
    const list = kids(r, 'przesylka');
    ensure(list.length <= 10000, 502, 'Bufor eNadawcy przekracza limit odczytu');
    return list.map((n) => {
      const guid = n.attrs.guid ?? textOf(n, 'guid', invalid, false);
      const number = textOf(n, 'numerNadania', invalid, false);
      if (!PP_GUID.test(guid) || (number && !PP_TRACKING_NUMBER.test(number))) invalid();
      return { guid, tracking_number: number };
    });
  }

  async findShipment(guid: string, bufferId?: string): Promise<PocztaPolskaCreated | null> {
    ensure(PP_GUID.test(guid), 422, 'Nieprawidłowy identyfikator przesyłki');
    const found = (await this.buffer(bufferId)).filter((s) => s.guid === guid);
    ensure(found.length <= 1, 502, 'eNadawca zwrócił kilka przesyłek o tym identyfikatorze');
    if (found[0] && !found[0].tracking_number) invalid();
    return found[0] ?? null;
  }

  /** getPrintForParcel: address label PDF for one guid (read, retried). */
  async labels(guid: string): Promise<PocztaPolskaLabel> {
    ensure(PP_GUID.test(guid), 422, 'Nieprawidłowy identyfikator przesyłki');
    const r = await this.call(
      'getPrintForParcel',
      `${el('guid', guid)}<type><kind>ADDRESS_LABEL</kind><method>EACH_PARCEL_SEPARATELY</method></type>`,
      { idempotent: true },
    );
    const error = pocztaPolskaErrors(kids(r, 'error'));
    if (error) throw new Problem(404, 'Brak etykiety tej przesyłki w eNadawcy: ' + error.message, 'PP_LABEL_MISSING');
    const prints = kids(r, 'printResult');
    ensure(
      prints.length === 1 && textOf(prints[0], 'guid', invalid) === guid,
      502,
      'Brak jednoznacznej etykiety Poczty Polskiej dla tej przesyłki',
    );
    const label_base64 = textOf(prints[0], 'print', invalid).replace(/\s+/g, '');
    return { guid, label_base64, pdf: pocztaPolskaPdf(label_base64) };
  }

  /** sendEnvelope: hands the buffer to the posting office. Never retried. */
  async sendEnvelope(bufferId?: string): Promise<{ envelope_id: string; status: string }> {
    ensure(!bufferId || /^\d{1,10}$/.test(bufferId), 422, 'Nieprawidłowy identyfikator bufora');
    const r = await this.call('sendEnvelope', el('urzadNadania', this.office) + el('idBufor', bufferId), {
      idempotent: false,
    });
    const error = pocztaPolskaErrors(kids(r, 'error'));
    if (error) throw error;
    const envelope_id = textOf(r, 'idEnvelope', invalid, false);
    const status = textOf(r, 'envelopeStatus', invalid, false);
    if (!/^\d{1,12}$/.test(envelope_id))
      throw new Problem(502, 'eNadawca nie potwierdził wysłania zbioru; sprawdź status zbioru', PP_UNCERTAIN);
    return { envelope_id, status };
  }

  /** getEnvelopeStatus: readback after sendEnvelope (read, retried). */
  async envelopeStatus(envelopeId: string): Promise<string> {
    ensure(/^\d{1,12}$/.test(envelopeId), 422, 'Nieprawidłowy identyfikator zbioru');
    const r = await this.call('getEnvelopeStatus', el('idEnvelope', envelopeId), { idempotent: true });
    const status = textOf(r, 'envelopeStatus', invalid);
    if (!/^[A-Z_]{2,40}$/.test(status)) invalid();
    return status;
  }

  /** clearEnvelopeByGuids: removes only the named parcels from the buffer. Never retried. */
  async cancel(guids: string[]): Promise<void> {
    ensure(
      guids.length >= 1 && guids.length <= 100 && guids.every((g) => PP_GUID.test(g)),
      422,
      'Nieprawidłowe identyfikatory przesyłek',
    );
    const r = await this.call('clearEnvelopeByGuids', guids.map((g) => el('guid', g)).join(''), {
      idempotent: false,
    });
    const error = pocztaPolskaErrors(kids(r, 'error'));
    if (error) throw error;
  }

  /** clearEnvelope empties a whole buffer, including other people's parcels; explicit only. */
  async clearEnvelope(bufferId: string, confirmWholeBuffer: boolean): Promise<void> {
    ensure(confirmWholeBuffer === true, 422, 'Czyszczenie całego bufora wymaga jawnego potwierdzenia');
    ensure(/^\d{1,10}$/.test(bufferId), 422, 'Nieprawidłowy identyfikator bufora');
    const r = await this.call('clearEnvelope', el('idBufor', bufferId), { idempotent: false });
    const error = pocztaPolskaErrors(kids(r, 'error'));
    if (error) throw error;
    if (textOf(r, 'retval', invalid, false) === 'false')
      throw new Problem(502, 'eNadawca nie potwierdził wyczyszczenia bufora', PP_UNCERTAIN);
  }

  /** getPlacowkiPocztowe: posting/pickup offices in one voivodeship (TERYT 02..32, read). */
  async points(voivodeship: string): Promise<PocztaPolskaPoint[]> {
    ensure(/^(0[2468]|1[02468]|2[02468]|3[02])$/.test(voivodeship), 422, 'Nieprawidłowy kod województwa');
    const r = await this.call('getPlacowkiPocztowe', el('idWojewodztwo', voivodeship), {
      idempotent: true,
    });
    const list = kids(r, 'placowka');
    ensure(list.length <= 5000, 502, 'Zbyt wiele placówek w odpowiedzi');
    return list.map((n) => {
      const id = textOf(n, 'id', invalid);
      const postal = textOf(n, 'kodPocztowy', invalid, false).replace('-', '');
      if (!/^\d{1,10}$/.test(id) || (postal && !/^\d{5}$/.test(postal))) invalid();
      const hours = kids(n, 'godzinyPracy').flatMap((g) =>
        g.children.map((d) => ({ day: d.name, hours: providerText(d.text, 60) })),
      );
      const flag = (name: string) => textOf(n, name, invalid, false) === 'true';
      return {
        id,
        name: providerText(textOf(n, 'nazwa', invalid, false)),
        street: providerText(textOf(n, 'ulica', invalid, false)),
        house_number: providerText(textOf(n, 'numerDomu', invalid, false), 20),
        postal_code: postal,
        city: providerText(textOf(n, 'miejscowosc', invalid, false)),
        hours,
        pickup: flag('punktWydaniaEPrzesylki') || flag('punktWydaniaPrzesylkiBiznesowejPlus'),
      };
    });
  }
}

/** A point id goes into a shipment only when the provider listed it as an active pickup point. */
export function assertPickupPoint(points: PocztaPolskaPoint[], id: string): PocztaPolskaPoint {
  const point = points.find((p) => p.id === id);
  ensure(point, 422, 'Wskazany punkt odbioru nie istnieje w Poczcie Polskiej');
  ensure(point.pickup, 422, 'Wskazany punkt nie wydaje przesyłek; wybierz inny punkt');
  return point;
}
