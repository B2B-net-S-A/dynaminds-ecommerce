import type { Transport } from './integrations';
import { DHL_NS, SOAP_NS, escapeXml, kids, parseXml, xmlElement, type XmlNode, type XmlValue } from './carrier-dhl-xml';
// Local, stateful stand-in for DHL24 WebAPI2. SYNTHETIC: response shapes are authored from the public
// documentation, not recorded from DHL. No network; used by tests and later by the "przykład lokalny" channel.
export const DHL_FAKE_USER = 'synthetic-dhl-user';
export const DHL_FAKE_PASSWORD = 'synthetic-dhl-pass';
export type DhlFakeFailure =
  | { kind: 'hang' }
  | { kind: 'throw' }
  | { kind: 'http'; status: number; retryAfter?: string }
  | { kind: 'fault'; code: string; message: string }
  | { kind: 'raw'; status: number; body: string }
  // ACK loss: the fake commits the mutation, then the response never arrives.
  | { kind: 'commit_then_hang' };
export interface DhlFakeShipment {
  waybill: string;
  reference: string;
  created: string;
  request: XmlNode;
}
export interface DhlFakeEvent {
  status: string;
  timestamp: string;
  description?: string;
  terminal?: string;
}
const tinyPdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 283 425]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const tinyZpl = Buffer.from('^XA^FO50,50^ADN,36,20^FDSYNTHETIC DHL^FS^XZ');
const child = (n: XmlNode | undefined, name: string) => n?.children.find((c) => c.name === name);
const val = (n: XmlNode | undefined, name: string) => child(n, name)?.text.trim() ?? '';
const list = (n: XmlNode | undefined) => (n ? kids(n, 'item') : []);
export function soapResponse(method: string, result: XmlValue): string {
  return `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="${SOAP_NS}" xmlns:ns1="${DHL_NS}"><SOAP-ENV:Body><ns1:${method}Response>${xmlElement(method + 'Result', result)}</ns1:${method}Response></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}
export function soapFault(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="${SOAP_NS}"><SOAP-ENV:Body><SOAP-ENV:Fault><faultcode>${escapeXml(code)}</faultcode><faultstring>${escapeXml(message)}</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}
export function createDhlFake(opts: { endpoint?: string; username?: string; password?: string } = {}) {
  const endpoint = opts.endpoint ?? 'https://sandbox.dhl24.com.pl/webapi2';
  const shipments = new Map<string, DhlFakeShipment>();
  const events = new Map<string, DhlFakeEvent[]>();
  const bookings = new Map<string, { waybills: string[]; cancelled: boolean }>();
  const failures: DhlFakeFailure[] = [];
  const calls: { method: string; body: string; soapAction: string | null }[] = [];
  let seq = 0;
  const reply = (status: number, body: string) =>
    new Response(body, { status, headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
  const fault = (code: string, message: string) => reply(500, soapFault(code, message));
  const hang = (signal?: AbortSignal | null) =>
    new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  function handle(method: string, req: XmlNode): Response {
    switch (method) {
      case 'getPostalCodeServices': {
        const pc = val(req, 'postCode');
        if (!/^\d{5}$/.test(pc)) return fault('103', 'Nieprawidłowy kod pocztowy');
        return reply(
          200,
          soapResponse(method, {
            domesticExpress9: pc.startsWith('0'),
            domesticExpress12: true,
            deliveryEvening: pc.startsWith('0'),
            pickupOnSaturday: false,
            drPickupFrom: '09:00',
            drPickupTo: '17:00',
          }),
        );
      }
      case 'createShipments': {
        const items = list(child(req, 'shipments'));
        if (items.length !== 1) return fault('104', 'Wymagana jedna przesyłka');
        const s = items[0];
        for (const party of ['shipper', 'receiver'])
          if (!/^\d{5}$/.test(val(child(s, party), 'postalCode')))
            return fault('103', `Nieprawidłowy kod pocztowy (${party})`);
        const piece = list(child(s, 'pieceList'))[0];
        const weight = Number(val(piece, 'weight'));
        if (!Number.isInteger(weight) || weight < 1 || weight > 31) return fault('105', 'Nieprawidłowa waga paczki');
        const service = child(s, 'service');
        if (val(service, 'collectOnDelivery') === 'true') {
          const amount = Number(val(service, 'collectOnDeliveryValue'));
          if (!(amount > 0) || amount > 11000) return fault('106', 'Nieprawidłowa kwota pobrania');
        }
        const waybill = String(90000000000 + ++seq);
        const reference = val(s, 'reference');
        shipments.set(waybill, { waybill, reference, created: val(s, 'shipmentDate'), request: s });
        events.set(waybill, [{ status: 'PNO', timestamp: val(s, 'shipmentDate') + ' 08:00:00', description: 'Przesyłka zarejestrowana' }]);
        return reply(200, soapResponse(method, [{ shipmentId: waybill, orderStatus: 'OK' }]));
      }
      case 'getMyShipments': {
        const offset = Number(val(req, 'offset') || 0);
        const page = [...shipments.values()]
          .filter((s) => s.created >= val(req, 'createdFrom') && s.created <= val(req, 'createdTo'))
          .slice(offset, offset + 100)
          .map((s) => ({ shipmentId: s.waybill, created: s.created, reference: s.reference }));
        return reply(200, soapResponse(method, page));
      }
      case 'getLabels': {
        const item = list(child(req, 'itemsToPrint'))[0];
        const waybill = val(item, 'shipmentId'),
          type = val(item, 'labelType');
        if (!shipments.has(waybill)) return fault('201', 'Nie znaleziono przesyłki');
        const zpl = type === 'ZBLP';
        return reply(
          200,
          soapResponse(method, [
            {
              shipmentId: waybill,
              labelType: type,
              labelName: `${waybill}.${zpl ? 'zpl' : 'pdf'}`,
              labelData: (zpl ? tinyZpl : tinyPdf).toString('base64'),
              labelMimeType: zpl ? 'text/plain' : 'application/pdf',
            },
          ]),
        );
      }
      case 'getTrackAndTraceInfo': {
        const waybill = val(req, 'shipmentId');
        const history = events.get(waybill);
        if (!history) return fault('201', 'Nie znaleziono przesyłki');
        return reply(
          200,
          soapResponse(method, {
            shipmentId: waybill,
            receivedBy: history.some((e) => e.status === 'DOR') ? 'J. Kowalski' : '',
            events: history.map((e) => ({ status: e.status, description: e.description ?? '', terminal: e.terminal ?? 'Warszawa', timestamp: e.timestamp })),
          }),
        );
      }
      case 'bookCourier': {
        const waybills = list(child(req, 'shipmentIdList')).map((n) => n.text.trim());
        if (waybills.some((w) => !shipments.has(w))) return fault('201', 'Nie znaleziono przesyłki');
        if (val(req, 'pickupTimeFrom') >= val(req, 'pickupTimeTo')) return fault('301', 'Nieprawidłowe godziny odbioru');
        const id = 'K' + String(700000 + ++seq);
        bookings.set(id, { waybills, cancelled: false });
        return reply(200, soapResponse(method, [id]));
      }
      case 'cancelCourierBooking': {
        const ids = list(child(req, 'orders')).map((n) => n.text.trim());
        return reply(
          200,
          soapResponse(
            method,
            ids.map((id) => {
              const b = bookings.get(id);
              const ok = Boolean(b && !b.cancelled);
              if (b) bookings.set(id, { ...b, cancelled: true });
              return { id, result: ok, error: ok ? '' : 'Zlecenie nie istnieje lub anulowane' };
            }),
          ),
        );
      }
      case 'getNearestServicepoints': {
        const pc = val(child(req, 'structure'), 'postcode');
        if (!/^\d{5}$/.test(pc)) return fault('103', 'Nieprawidłowy kod pocztowy');
        return reply(
          200,
          soapResponse(method, {
            points: [
              {
                sap: '1000' + pc,
                name: 'DHL POP Kiosk (syntetyczny)',
                type: 'POP',
                address: { street: 'Marszałkowska', houseNumber: '1', postcode: pc, city: 'Warszawa' },
                description: 'Punkt syntetyczny',
                latitude: '52.2297',
                longitude: '21.0122',
                workingHours: [
                  { day: 'MON', open: '08:00', close: '20:00' },
                  { day: 'SAT', open: '09:00', close: '14:00' },
                ],
              },
            ],
          }),
        );
      }
      default:
        return fault('SOAP-ENV:Client', 'Nieznana metoda');
    }
  }
  const transport: Transport = async (url, init) => {
    if (url !== endpoint || init.method !== 'POST') return reply(404, 'not found');
    const body = String(init.body);
    const root = parseXml(body);
    const op = child(root, 'Body')?.children[0];
    const method = op?.name ?? '';
    const soapAction = new Headers(init.headers).get('soapaction');
    calls.push({ method, body, soapAction });
    const failure = failures.shift();
    if (failure?.kind === 'hang') return hang(init.signal);
    if (failure?.kind === 'throw') throw new TypeError('fetch failed');
    if (failure?.kind === 'http')
      return new Response('PRIVATE_PROVIDER_ERROR', {
        status: failure.status,
        headers: failure.retryAfter ? { 'Retry-After': failure.retryAfter } : {},
      });
    if (failure?.kind === 'fault') return fault(failure.code, failure.message);
    if (failure?.kind === 'raw') return reply(failure.status, failure.body);
    const auth = child(op, 'authData');
    if (val(auth, 'username') !== (opts.username ?? DHL_FAKE_USER) || val(auth, 'password') !== (opts.password ?? DHL_FAKE_PASSWORD))
      return fault('100', 'Błąd autoryzacji: nieprawidłowy login lub hasło');
    const res = handle(method, op!);
    if (failure?.kind === 'commit_then_hang') return hang(init.signal);
    return res;
  };
  return {
    transport,
    endpoint,
    calls,
    shipments,
    bookings,
    fail: (...f: DhlFakeFailure[]) => failures.push(...f),
    setEvents: (waybill: string, e: DhlFakeEvent[]) => events.set(waybill, e),
  };
}
export type DhlFake = ReturnType<typeof createDhlFake>;
