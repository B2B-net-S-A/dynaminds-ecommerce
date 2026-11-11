import type { Transport } from './integrations';
import { escapeXml, kids, parseSoap, type XmlNode } from './carrier-pocztapolska-xml';
import { PP_ENADAWCA_ENDPOINTS, PP_NS } from './carrier-pocztapolska';
import { PP_TRACKING_ENDPOINT, PP_TRACKING_NS } from './carrier-pocztapolska-tracking';

// Local fake of eNadawca and Sledzenie. SYNTHETIC: responses are authored from the public
// documentation, not recorded from Poczta Polska. No network. Used by contract tests
// and, after wiring, by a local simulation channel.

export type FakeFailure =
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'hang' }
  | { kind: 'network' }
  /** Commit the operation, then lose the answer (ACK loss). */
  | { kind: 'lose_answer' }
  | { kind: 'raw'; status: number; body: string };
export type FakeParcel = { guid: string; number: string; xml: string };
export type FakeOptions = {
  username?: string;
  password?: string;
  tracking_login?: string;
  tracking_password?: string;
  offices?: { id: string; opis: string }[];
  /** Validation hook: return error descriptions to refuse addShipment. */
  reject?: (przesylka: XmlNode) => string[];
};

/** Minimal valid one-page PDF (synthetic label). */
export function fakeLabelPdf(text = 'SYNTETYCZNA ETYKIETA'): Buffer {
  const stream = `BT /F1 12 Tf 20 200 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 283 425] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const envelope = (inner: string, ns = PP_NS) =>
  `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${ns}"><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
export const fakeFault = (code: string, message: string) =>
  envelope(`<soapenv:Fault><faultcode>${escapeXml(code)}</faultcode><faultstring>${escapeXml(message)}</faultstring></soapenv:Fault>`);
const xmlResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
const error = (desc: string, n = 1000) =>
  `<error><errorNumber>${n}</errorNumber><errorDesc>${escapeXml(desc)}</errorDesc></error>`;

export function pocztaPolskaFake(o: FakeOptions = {}) {
  const creds = { username: o.username ?? 'fixture-user', password: o.password ?? 'fixture-pass' };
  const tracking = {
    login: o.tracking_login ?? 'fixture-tt',
    password: o.tracking_password ?? 'fixture-tt-pass',
  };
  const offices = o.offices ?? [{ id: '123456', opis: 'UP Warszawa 1 (syntetyczny)' }];
  const buffer = new Map<string, FakeParcel>();
  const sent: { id: string; guids: string[] }[] = [];
  const trackingXml = new Map<string, string>();
  const failures: FakeFailure[] = [];
  const calls: string[] = [];
  let seq = 0,
    envelopeSeq = 1000;
  const points = new Map<string, string>();

  function handleEnadawca(op: string, req: XmlNode): string {
    const v = (name: string) => kids(req, name)[0]?.text.trim() ?? '';
    switch (op) {
      case 'hello':
        return `<ns:helloResponse><out>${escapeXml(v('in'))}</out></ns:helloResponse>`;
      case 'getUrzedyNadania':
        return `<ns:getUrzedyNadaniaResponse>${offices
          .map((x) => `<urzedyNadania><idUrzeduNadania>${x.id}</idUrzeduNadania><opis>${escapeXml(x.opis)}</opis><nazwaWydruku>${escapeXml(x.opis)}</nazwaWydruku></urzedyNadania>`)
          .join('')}</ns:getUrzedyNadaniaResponse>`;
      case 'addShipment': {
        const items = kids(req, 'przesylki').map((p) => {
          const guid = p.attrs.guid ?? '';
          const errors = o.reject?.(p) ?? [];
          if (buffer.has(guid)) errors.push(`Przesyłka o podanym guid ${guid} już istnieje`);
          if (errors.length) return `<retval><guid>${escapeXml(guid)}</guid>${errors.map((e) => error(e)).join('')}</retval>`;
          const number = 'FAKEPP' + String(++seq).padStart(10, '0');
          buffer.set(guid, { guid, number, xml: JSON.stringify(p) });
          return `<retval><guid>${guid}</guid><numerNadania>${number}</numerNadania></retval>`;
        });
        return `<ns:addShipmentResponse>${items.join('')}</ns:addShipmentResponse>`;
      }
      case 'getEnvelopeBufor':
        return `<ns:getEnvelopeBuforResponse>${[...buffer.values()]
          .map((p) => `<przesylka guid="${p.guid}"><numerNadania>${p.number}</numerNadania></przesylka>`)
          .join('')}</ns:getEnvelopeBuforResponse>`;
      case 'getPrintForParcel': {
        const guid = v('guid');
        const p = buffer.get(guid) ?? sent.flatMap((s) => s.guids).includes(guid);
        if (!p) return `<ns:getPrintForParcelResponse>${error('Brak przesyłki o podanym guid', 2001)}</ns:getPrintForParcelResponse>`;
        return `<ns:getPrintForParcelResponse><printResult><guid>${guid}</guid><print>${fakeLabelPdf('PP ' + guid.slice(0, 8)).toString('base64')}</print></printResult></ns:getPrintForParcelResponse>`;
      }
      case 'sendEnvelope': {
        if (!offices.some((x) => x.id === v('urzadNadania')))
          return `<ns:sendEnvelopeResponse>${error('Nieprawidłowy urząd nadania', 3001)}</ns:sendEnvelopeResponse>`;
        const id = String(++envelopeSeq);
        sent.push({ id, guids: [...buffer.keys()] });
        buffer.clear();
        return `<ns:sendEnvelopeResponse><idEnvelope>${id}</idEnvelope><envelopeStatus>WYSLANY</envelopeStatus></ns:sendEnvelopeResponse>`;
      }
      case 'getEnvelopeStatus':
        return `<ns:getEnvelopeStatusResponse><envelopeStatus>${sent.some((s) => s.id === v('idEnvelope')) ? 'PRZYJETY' : 'BLEDNY'}</envelopeStatus></ns:getEnvelopeStatusResponse>`;
      case 'clearEnvelopeByGuids': {
        const missing = kids(req, 'guid').map((g) => g.text.trim()).filter((g) => !buffer.delete(g));
        return `<ns:clearEnvelopeByGuidsResponse>${missing.map((g) => error('Brak przesyłki ' + g, 2001)).join('')}</ns:clearEnvelopeByGuidsResponse>`;
      }
      case 'clearEnvelope':
        buffer.clear();
        return `<ns:clearEnvelopeResponse><retval>true</retval></ns:clearEnvelopeResponse>`;
      case 'getPlacowkiPocztowe':
        return `<ns:getPlacowkiPocztoweResponse>${points.get(v('idWojewodztwo')) ?? ''}</ns:getPlacowkiPocztoweResponse>`;
      default:
        return '';
    }
  }

  const transport: Transport = async (url, init) => {
    const failure = failures.shift();
    const body = String(init.body ?? '');
    if (failure?.kind === 'hang')
      return new Promise<Response>((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    if (failure?.kind === 'network') throw new TypeError('fetch failed');
    if (failure?.kind === 'status') return xmlResponse(failure.body ?? 'PRIVATE_PROVIDER_ERROR', failure.status);
    if (failure?.kind === 'raw') return xmlResponse(failure.body, failure.status);
    const invalid = (): never => {
      throw new Error('fake: invalid request XML');
    };
    const soap = parseSoap(body, invalid, { maxBytes: 1024 * 1024 });
    if (soap.kind !== 'body') invalid();
    const req = soap.kind === 'body' ? soap.node : invalid();
    calls.push(req.name);
    if (url === PP_TRACKING_ENDPOINT) {
      const user = body.match(/<wsse:Username>([^<]*)<\/wsse:Username>/)?.[1];
      const pass = body.match(/<wsse:Password[^>]*>([^<]*)<\/wsse:Password>/)?.[1];
      if (user !== tracking.login || pass !== tracking.password)
        return xmlResponse(fakeFault('wsse:FailedAuthentication', 'The security token could not be authenticated'), 500);
      const number = kids(req, 'numer')[0]?.text ?? '';
      const answer =
        trackingXml.get(number) ??
        `<ns:sprawdzPrzesylkeResponse><return><numer>${escapeXml(number)}</numer><status>-1</status></return></ns:sprawdzPrzesylkeResponse>`;
      return xmlResponse(envelope(answer, PP_TRACKING_NS));
    }
    if (url !== PP_ENADAWCA_ENDPOINTS.sandbox && url !== PP_ENADAWCA_ENDPOINTS.live)
      throw new Error('fake: unexpected URL ' + url);
    const auth = new Headers(init.headers).get('authorization');
    if (auth !== 'Basic ' + Buffer.from(creds.username + ':' + creds.password).toString('base64'))
      return new Response('Unauthorized', { status: 401 });
    if (req.uri !== PP_NS) invalid();
    const inner = handleEnadawca(req.name, req);
    if (!inner) return xmlResponse(fakeFault('soapenv:Client', 'Nieznana operacja ' + req.name), 500);
    if (failure?.kind === 'lose_answer') throw new TypeError('fetch failed after commit');
    return xmlResponse(envelope(inner));
  };

  return {
    transport,
    buffer,
    sent,
    calls,
    /** Queue failures for the next requests, in order. */
    fail(...f: FakeFailure[]) {
      failures.push(...f);
    },
    setTracking(number: string, responseInner: string) {
      trackingXml.set(number, responseInner);
    },
    setPoints(voivodeship: string, placowkiXml: string) {
      points.set(voivodeship, placowkiXml);
    },
    settings: { urzad_nadania: offices[0].id },
    credentials: { ...creds, tracking_login: tracking.login, tracking_password: tracking.password },
  };
}
