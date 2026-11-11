import { SaxesParser } from 'saxes';
import { setTimeout } from 'node:timers/promises';
import { ensure, Problem } from './errors';
import { safeFetch, type Transport } from './integrations';
export const DPD_INFO_ENDPOINT =
  'https://dpdinfoservices.dpd.com.pl/DPDInfoServicesObjEventsService/DPDInfoServicesObjEvents';
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const NS = 'http://events.dpdinfoservices.dpd.com.pl/';
const MAX_BYTES = 2 * 1024 * 1024;
const waybillOK = (v: string) => /^[A-Za-z0-9]{8,32}$/.test(v);
const escapeXml = (v: string) =>
  v.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
type XmlNode = { name: string; uri: string; text: string; children: XmlNode[] };
type DpdEvent = {
  code: string;
  datetime: string;
  waybill: string;
  object_id: string;
  status: string | null;
  next_waybill?: string;
};
function invalid(): never {
  throw new Problem(502, 'Nieprawidłowa odpowiedź trackingu DPD');
}
function parse(xml: string) {
  if (Buffer.byteLength(xml) > MAX_BYTES) invalid();
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined,
    count = 0;
  parser.on('doctype', invalid);
  parser.on('error', invalid);
  parser.on('opentag', (tag) => {
    if (++count > 50000 || stack.length >= 20) invalid();
    const node: XmlNode = { name: tag.local, uri: tag.uri, text: '', children: [] };
    if (stack.length) stack.at(-1)!.children.push(node);
    else root = node;
    stack.push(node);
  });
  const text = (v: string) => {
    const node = stack.at(-1);
    if (node) {
      node.text += v;
      if (node.text.length > 20000) invalid();
    }
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    stack.pop();
  });
  try {
    parser.write(xml).close();
  } catch {
    invalid();
  }
  if (!root || root.name !== 'Envelope' || root.uri !== SOAP) invalid();
  const bodies = root.children.filter((n) => n.name === 'Body' && n.uri === SOAP);
  if (bodies.length !== 1 || bodies[0].children.length !== 1) invalid();
  const response = bodies[0].children[0];
  if (response.name === 'Fault' && response.uri === SOAP)
    throw new Problem(502, 'DPD InfoServices odrzucił odczyt; sprawdź konto i uprawnienia');
  if (response.name !== 'getEventsForWaybillV1Response' || response.uri !== NS) invalid();
  const returns = response.children.filter((n) => n.name === 'return' && n.uri === '');
  if (returns.length !== 1) invalid();
  return returns[0];
}
const children = (n: XmlNode, name: string) =>
  n.children.filter((c) => c.name === name && c.uri === '');
function value(n: XmlNode, name: string, required = true) {
  const nodes = children(n, name);
  if (nodes.length > 1 || (required && nodes.length !== 1) || nodes.some((n) => n.children.length))
    invalid();
  return nodes[0]?.text.trim() ?? '';
}
const warsaw = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
// DPD emits Polish local times without an offset. Reject the spring gap; in the autumn overlap use the later occurrence.
export function dpdEventTime(v: string) {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(v);
  if (!m) invalid();
  const [, y, mo, d, h, mi, se, ms, zone] = m;
  const base = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se, Math.round(Number(ms ?? 0) * 1000));
  if (new Date(base).toISOString().slice(0, 19) !== `${y}-${mo}-${d}T${h}:${mi}:${se}`) invalid();
  if (zone) {
    if (
      zone !== 'Z' &&
      (+zone.slice(1, 3) > 14 ||
        +zone.slice(4) > 59 ||
        (+zone.slice(1, 3) === 14 && +zone.slice(4) !== 0))
    )
      invalid();
    const instant = new Date(v);
    if (!Number.isFinite(instant.getTime())) invalid();
    return instant.toISOString();
  }
  const matches = [120, 60]
    .map((offset) => base - offset * 60000)
    .filter((t) => warsaw.format(new Date(t)).replace(' ', 'T') === v.slice(0, 19));
  if (!matches.length) invalid();
  return new Date(Math.max(...matches)).toISOString();
}
const delivered = new Set([
  '190101',
  '190102',
  '190103',
  '190104',
  '190105',
  '190201',
  '190202',
  '190203',
  '190204',
  '501300',
  '501304',
  '501340',
  '511901',
  '511902',
  '511903',
  '600103',
  '600104',
  '701901',
  '701902',
]);
const redirects = new Set(['230402', '230403', '230408']);
export function dpdStatus(code: string, returning = false): string | null {
  if (delivered.has(code)) return returning ? 'returned_to_sender' : 'delivered';
  if (code === '030103') return 'confirmed';
  if (['040101', '040102'].includes(code)) return 'collected_from_sender';
  if (['170101', '170102', '170501', '500300'].includes(code)) return 'out_for_delivery';
  if (['511201', '612001', '701201'].includes(code)) return 'ready_to_pickup';
  if (code === '230309') return 'lost';
  if (code === '230403' || code === '230408') return 'return_in_transit';
  if (code === '230402') return 'redirected';
  if (/^(05010[12]|12010[0-4]|160501|500200|500900|501000)$/.test(code))
    return returning ? 'return_in_transit' : 'in_transit';
  if (/^(200|210|5004|6005)/.test(code)) return 'delivery_failed';
  return null; // Notifications and unknown codes do not change the physical status.
}
export function parseDpdEvents(xml: string, waybill: string, returning = false): DpdEvent[] {
  const result = parse(xml);
  const events = children(result, 'eventsList');
  if (events.length > 1000) invalid();
  return events
    .map((n) => {
      const code = value(n, 'businessCode'),
        original = value(n, 'waybill'),
        object_id = value(n, 'objectId');
      if (original !== waybill || !/^\d{6}$/.test(code) || !/^-?\d{1,20}$/.test(object_id))
        invalid();
      const event: DpdEvent = {
        code,
        datetime: dpdEventTime(value(n, 'eventTime')),
        waybill,
        object_id,
        status: dpdStatus(code, returning),
      };
      if (redirects.has(code)) {
        const targets = children(n, 'eventDataList')
          .map((n) => value(n, 'value', false))
          .filter(waybillOK);
        if (new Set(targets).size !== 1 || targets[0] === waybill) invalid();
        event.next_waybill = targets[0];
      }
      return event;
    })
    .sort((a, b) => a.datetime.localeCompare(b.datetime) || a.object_id.localeCompare(b.object_id));
}
export class DpdInfo {
  constructor(
    private credentials: Record<string, string>,
    private transport: Transport = safeFetch,
  ) {
    ensure(
      credentials.info_login &&
        credentials.info_password &&
        [credentials.info_login, credentials.info_password, credentials.info_channel ?? ''].every(
          (v) => v.length <= 500 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v),
        ),
      422,
      'Skonfiguruj oddzielny login i hasło DPD InfoServices',
    );
  }
  async events(waybill: string, returning = false) {
    ensure(waybillOK(waybill), 422, 'Nieprawidłowy numer przesyłki DPD');
    const body = `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="${SOAP}" xmlns:dpd="${NS}"><soap:Body><dpd:getEventsForWaybillV1><waybill>${escapeXml(waybill)}</waybill><eventsSelectType>ALL</eventsSelectType><language>PL</language><authDataV1><channel>${escapeXml(this.credentials.info_channel ?? '')}</channel><login>${escapeXml(this.credentials.info_login)}</login><password>${escapeXml(this.credentials.info_password)}</password></authDataV1></dpd:getEventsForWaybillV1></soap:Body></soap:Envelope>`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.transport(DPD_INFO_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: '""',
          Accept: 'text/xml',
        },
        body,
      });
      // The SOAP POST only reads history. Each retry passes through the supplied policy guard.
      if (
        (res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504) &&
        attempt < 2
      ) {
        await res.body?.cancel();
        const retry = Number(res.headers.get('retry-after'));
        await setTimeout(
          Math.min(5000, retry > 0 && Number.isFinite(retry) ? retry * 1000 : 200 * 2 ** attempt),
        );
        continue;
      }
      ensure(
        res.ok || res.status === 500,
        res.status === 401 || res.status === 403 ? 422 : 502,
        `Tracking DPD: HTTP ${res.status}`,
      );
      const reader = res.body?.getReader();
      if (!reader) invalid();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_BYTES) invalid();
          chunks.push(value);
        }
        const events = parseDpdEvents(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
          waybill,
          returning,
        );
        ensure(res.ok, 502, 'DPD InfoServices odrzucił odczyt');
        return events;
      } catch (e) {
        if (e instanceof Problem) throw e;
        invalid();
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    invalid();
  }
  async tracking(s: any) {
    const previous = s.tracking_data;
    let current = s.tracking_number,
      returning = false;
    const visited = new Set<string>();
    const lineage: { waybill: string; return_leg: boolean }[] = [];
    const events: DpdEvent[] = [];
    for (let hop = 0; hop < 8; hop++) {
      ensure(!visited.has(current), 502, 'DPD: cykl zmian numeru przesyłki');
      visited.add(current);
      lineage.push({ waybill: current, return_leg: returning });
      const page = await this.events(current, returning);
      events.push(...page);
      // Closed original waybills may later return no events. Retain the previously verified renumbering chain.
      const known = new Map<string, DpdEvent>();
      for (const e of previous?.tracking_details ?? [])
        if (e.waybill === current && e.next_waybill && waybillOK(e.next_waybill))
          known.set([e.object_id, e.code, e.datetime].join(':'), e);
      for (const e of page) known.set([e.object_id, e.code, e.datetime].join(':'), e);
      const changes = [...known.values()]
        .filter((e) => e.next_waybill)
        .sort((a, b) => a.datetime.localeCompare(b.datetime));
      if (!changes.length) break;
      const change = changes.at(-1)!;
      ensure(
        new Set(changes.map((e) => e.next_waybill)).size === 1,
        502,
        'DPD: niejednoznaczna zmiana numeru przesyłki',
      );
      returning ||= change.code !== '230402';
      current = change.next_waybill!;
      ensure(hop < 7, 502, 'DPD: przekroczono limit zmian numeru przesyłki');
    }
    const details = new Map<string, any>();
    for (const e of previous?.tracking_details ?? [])
      if (e.code && e.waybill && e.object_id)
        details.set([e.waybill, e.object_id, e.code, e.datetime].join(':'), e);
    for (const e of events) details.set([e.waybill, e.object_id, e.code, e.datetime].join(':'), e);
    ensure(details.size <= 5000, 502, 'DPD: historia przekracza limit 5000 zdarzeń');
    const all = [...details.values()].sort(
      (a, b) => a.datetime.localeCompare(b.datetime) || a.object_id.localeCompare(b.object_id),
    );
    // Current leg is authoritative; an old original-waybill delivery cannot complete a return leg.
    const leg = all.filter((e) => e.waybill === current && e.status);
    const status =
      leg.at(-1)?.status ??
      (lineage.length > 1
        ? returning
          ? 'return_in_transit'
          : 'redirected'
        : (previous?.status ?? 'unknown'));
    return {
      tracking_number: s.tracking_number,
      current_waybill: current,
      return_leg: returning,
      lineage,
      status,
      tracking_details: all,
      provider_updated_at: all.at(-1)?.datetime ?? previous?.provider_updated_at ?? null,
      provider_created_at: null,
      scope: 'external_api_verified',
      empty_history: events.length === 0,
    };
  }
}
