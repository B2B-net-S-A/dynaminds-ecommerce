import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { ensure, Problem } from './errors';
import { safeFetch, type Transport } from './integrations';
import { el, escapeXml, kids, parseSoap, providerText, readLimited, textOf } from './carrier-pocztapolska-xml';
import { pocztaPolskaFault } from './carrier-pocztapolska';
import { PP_TRACKING_NUMBER } from './carrier-pocztapolska-values';

// Poczta Polska "Sledzenie" web service (WS-Security UsernameToken). Result shape is
// identical to DpdInfo.tracking() in server/dpd-info.ts so tracking.ts can branch on
// provider without a new normaliser.

export const PP_TRACKING_ENDPOINT = 'https://tt.poczta-polska.pl/Sledzenie/services/Sledzenie';
export const PP_TRACKING_NS = 'http://sledzenie.pocztapolska.pl';
const WSSE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const PASSWORD_TEXT =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText';
const MAX_BYTES = 2 * 1024 * 1024;

export type PocztaPolskaEvent = {
  code: string;
  name: string;
  datetime: string;
  waybill: string;
  object_id: string;
  unit: string;
  final: boolean;
  status: string | null;
};
export type PocztaPolskaTrackingResult = {
  tracking_number: string;
  current_waybill: string;
  return_leg: boolean;
  lineage: { waybill: string; return_leg: boolean }[];
  status: string;
  tracking_details: PocztaPolskaEvent[];
  provider_updated_at: string | null;
  provider_created_at: null;
  scope: 'external_api_verified';
  empty_history: boolean;
};

function invalid(): never {
  throw new Problem(502, 'Nieprawidłowa odpowiedź śledzenia Poczty Polskiej');
}

/**
 * Event code → app tracking status (values from BASE_WIRE_TRACKING_STATUS in
 * server/base-wire-fulfillment.ts). Working table from public descriptions of the
 * Sledzenie service; confirm on sandbox data. Unknown codes return null and do not
 * change the physical status, as in dpdStatus().
 */
const STATUS: Record<string, string> = {
  P_NAD: 'collected_from_sender',
  P_PZL: 'in_transit',
  P_WZL: 'in_transit',
  P_PRZ: 'in_transit',
  P_WD: 'out_for_delivery',
  P_A: 'avizo',
  P_KWD: 'avizo',
  P_PWP: 'ready_to_pickup',
  P_D: 'delivered',
  P_DOR: 'delivered',
  P_ND: 'delivery_failed',
  P_ZWR: 'return_in_transit',
};
const RETURN_START = new Set(['P_ZWR']);
export function pocztaPolskaStatus(code: string, returning = false): string | null {
  const status = STATUS[code] ?? null;
  if (status === 'delivered' && returning) return 'returned_to_sender';
  if (returning && (status === 'in_transit' || status === 'out_for_delivery')) return 'return_in_transit';
  return status;
}

/** "2026-10-20 12:34[:56]" in Polish local time → ISO; spring gap rejected, autumn overlap → later. */
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
export function pocztaPolskaEventTime(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v.trim());
  if (!m) invalid();
  const [, y, mo, d, h, mi, se = '00'] = m;
  const local = `${y}-${mo}-${d}T${h}:${mi}:${se}`;
  const base = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (new Date(base).toISOString().slice(0, 19) !== local) invalid();
  const matches = [120, 60]
    .map((offset) => base - offset * 60000)
    .filter((t) => warsaw.format(new Date(t)).replace(' ', 'T') === local);
  if (!matches.length) invalid();
  return new Date(Math.max(...matches)).toISOString();
}

/** sprawdzPrzesylke response → events (sorted). Status -1 (unknown number yet) → []. */
export function parsePocztaPolskaEvents(xml: string, number: string): PocztaPolskaEvent[] {
  const soap = parseSoap(xml, invalid, { maxBytes: MAX_BYTES });
  if (soap.kind === 'fault') throw pocztaPolskaFault(soap.code, soap.message);
  const response = soap.node;
  if (response.name !== 'sprawdzPrzesylkeResponse' || response.uri !== PP_TRACKING_NS) invalid();
  const returns = kids(response, 'return');
  if (returns.length !== 1) invalid();
  const r = returns[0];
  const status = textOf(r, 'status', invalid);
  if (status === '-1') return [];
  if (status === '-2') throw new Problem(422, 'Poczta Polska uznała numer przesyłki za nieprawidłowy', 'PP_TRACKING_BAD_NUMBER');
  if (status === '1')
    throw new Problem(502, 'Poczta Polska zwróciła kilka przesyłek o tym numerze; sprawdź numer', 'PP_TRACKING_AMBIGUOUS');
  if (status !== '0') throw new Problem(502, 'Usługa śledzenia Poczty Polskiej zwróciła błąd', 'PP_TRACKING_ERROR');
  if (textOf(r, 'numer', invalid) !== number) invalid();
  const data = kids(r, 'danePrzesylki');
  if (data.length !== 1) invalid();
  const list = kids(data[0], 'zdarzenia').flatMap((z) => kids(z, 'zdarzenie'));
  if (list.length > 1000) invalid();
  let returning = false;
  return list
    .map((n) => {
      const code = textOf(n, 'kod', invalid);
      if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(code)) invalid();
      const units = kids(n, 'jednostka');
      if (units.length > 1) invalid();
      const unit = units[0] ? providerText(textOf(units[0], 'nazwa', invalid, false), 100) : '';
      const datetime = pocztaPolskaEventTime(textOf(n, 'czas', invalid));
      return {
        code,
        name: providerText(textOf(n, 'nazwa', invalid, false), 150),
        datetime,
        waybill: number,
        // Sledzenie has no event id; a digest of the stable fields deduplicates re-reads.
        object_id: createHash('sha256').update([code, datetime, unit].join('\n')).digest('hex').slice(0, 20),
        unit,
        final: textOf(n, 'konczace', invalid, false) === 'true',
        status: null as string | null,
      };
    })
    .sort((a, b) => a.datetime.localeCompare(b.datetime) || a.object_id.localeCompare(b.object_id))
    .map((e) => {
      if (RETURN_START.has(e.code)) returning = true;
      return { ...e, status: pocztaPolskaStatus(e.code, returning) };
    });
}

export class PocztaPolskaTracking {
  private pause: (ms: number) => Promise<unknown>;
  constructor(
    private credentials: Record<string, string>,
    private transport: Transport = safeFetch,
    options: { sleep?: (ms: number) => Promise<unknown> } = {},
  ) {
    ensure(
      credentials.tracking_login &&
        credentials.tracking_password &&
        [credentials.tracking_login, credentials.tracking_password].every(
          (v) => v.length <= 200 && !/[\x00-\x1f]/.test(v),
        ),
      422,
      'Skonfiguruj login i hasło usługi śledzenia Poczty Polskiej',
    );
    this.pause = options.sleep ?? sleep;
  }
  async events(number: string): Promise<PocztaPolskaEvent[]> {
    ensure(PP_TRACKING_NUMBER.test(number), 422, 'Nieprawidłowy numer przesyłki Poczty Polskiej');
    const body = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sle="${PP_TRACKING_NS}"><soapenv:Header><wsse:Security xmlns:wsse="${WSSE}" soapenv:mustUnderstand="1"><wsse:UsernameToken><wsse:Username>${escapeXml(this.credentials.tracking_login)}</wsse:Username><wsse:Password Type="${PASSWORD_TEXT}">${escapeXml(this.credentials.tracking_password)}</wsse:Password></wsse:UsernameToken></wsse:Security></soapenv:Header><soapenv:Body><sle:sprawdzPrzesylke>${el('sle:numer', number)}</sle:sprawdzPrzesylke></soapenv:Body></soapenv:Envelope>`;
    for (let attempt = 0; attempt < 3; attempt++) {
      let res: Response;
      try {
        res = await this.transport(PP_TRACKING_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""', Accept: 'text/xml' },
          body,
        });
      } catch (e) {
        // Read-only: transport errors and timeouts are retried.
        if (attempt < 2) {
          await this.pause(200 * 2 ** attempt);
          continue;
        }
        throw e instanceof Problem ? e : new Problem(502, 'Brak odpowiedzi usługi śledzenia Poczty Polskiej');
      }
      if ([429, 502, 503, 504].includes(res.status) && attempt < 2) {
        await res.body?.cancel().catch(() => {});
        const retry = Number(res.headers.get('retry-after'));
        await this.pause(Math.min(5000, retry > 0 && Number.isFinite(retry) ? retry * 1000 : 200 * 2 ** attempt));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => {});
        throw new Problem(401, 'Poczta Polska odrzuciła login lub hasło usługi śledzenia', 'PROVIDER_HTTP_UNAUTHORIZED');
      }
      if (!res.ok && res.status !== 500) {
        await res.body?.cancel().catch(() => {});
        throw new Problem(502, `Śledzenie Poczty Polskiej: HTTP ${res.status}`);
      }
      const events = parsePocztaPolskaEvents(await readLimited(res, MAX_BYTES, invalid), number);
      if (!res.ok) invalid();
      return events;
    }
    invalid();
  }
  /** Same contract as DpdInfo.tracking(s): merges previous details, unknown codes keep the status. */
  async tracking(s: {
    tracking_number: string;
    tracking_data?: { status?: string; tracking_details?: PocztaPolskaEvent[]; provider_updated_at?: string } | null;
  }): Promise<PocztaPolskaTrackingResult> {
    const previous = s.tracking_data;
    const events = await this.events(s.tracking_number);
    const details = new Map<string, PocztaPolskaEvent>();
    for (const e of previous?.tracking_details ?? [])
      if (e?.code && e.waybill === s.tracking_number && e.object_id) details.set(e.object_id, e);
    for (const e of events) details.set(e.object_id, e);
    ensure(details.size <= 5000, 502, 'Poczta Polska: historia przekracza limit 5000 zdarzeń');
    const all = [...details.values()].sort(
      (a, b) => a.datetime.localeCompare(b.datetime) || a.object_id.localeCompare(b.object_id),
    );
    const return_leg = all.some((e) => RETURN_START.has(e.code));
    return {
      tracking_number: s.tracking_number,
      current_waybill: s.tracking_number,
      return_leg,
      lineage: [{ waybill: s.tracking_number, return_leg }],
      status: all.filter((e) => e.status).at(-1)?.status ?? previous?.status ?? 'unknown',
      tracking_details: all,
      provider_updated_at: all.at(-1)?.datetime ?? previous?.provider_updated_at ?? null,
      provider_created_at: null,
      scope: 'external_api_verified',
      empty_history: events.length === 0,
    };
  }
}
