import { validateBuyerDeliveryAddress166, type BuyerDeliveryAddress166 } from './buyer-delivery-address';

/** DOM client emitted into the existing portal nonce script. Regenerate browserScript166 with scripts/build-buyer-address-portal.ts. */
type Reason = 'module_unavailable' | 'access_disabled' | 'read_only' | 'fulfillment_started' |
  'shipment_locked' | 'dependent_plan_locked' | 'pickup_point_delivery' | 'delivery_kind_unknown';
type Status = { available: boolean; read_only: boolean; enabled: boolean; can_edit: boolean;
  reason: Reason | null; delivery: BuyerDeliveryAddress166 | null; revision: string | null;
  last_change: { created_at: string } | null };
type Preview = { available: boolean; read_only: boolean; id: string; scope_hash: string;
  expires_at: string; before: BuyerDeliveryAddress166; after: BuyerDeliveryAddress166;
  changed: boolean; state: 'preview'; local_only: true; reused: boolean };
type Attempt = { kind: 'preview' | 'apply'; path: string; wire: string; expected: BuyerDeliveryAddress166;
  before: BuyerDeliveryAddress166; revision: string; preview: Preview | null };
const names = { recipient_name: 'Odbiorca', street: 'Ulica i numer', city: 'Miejscowość',
  postal_code: 'Kod pocztowy', country: 'Kraj', phone: 'Telefon (E.164)' };
const reasons: Record<Reason, string> = {
  module_unavailable: 'Korekta adresu jest niedostępna w tej kopii.',
  access_disabled: 'Sprzedawca nie udostępnił korekty adresu.',
  read_only: 'Podgląd kopii — zmiana adresu jest wyłączona.',
  fulfillment_started: 'Rozpoczęto realizację. Skontaktuj się ze sprzedawcą.',
  shipment_locked: 'Przesyłka wymaga obsługi sprzedawcy. Zmiana adresu jest zablokowana.',
  dependent_plan_locked: 'Trwa inna operacja. Skontaktuj się ze sprzedawcą.',
  pickup_point_delivery: 'Dostawa do punktu odbioru — zmianę uzgodnij ze sprzedawcą.',
  delivery_kind_unknown: 'Rodzaj dostawy wymaga potwierdzenia przez sprzedawcę.',
};
const keys = Object.keys(names) as (keyof BuyerDeliveryAddress166)[];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/;
const opaque = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 512 && !/[\p{Cc}]/u.test(v);
const equal = (a: BuyerDeliveryAddress166, b: BuyerDeliveryAddress166) => keys.every(k => a[k] === b[k]);
function object(v: unknown, fields: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== fields.length ||
      Object.keys(v).some(k => !fields.includes(k))) throw Error('Niepoprawna odpowiedź serwera.');
  return v as Record<string, unknown>;
}
function address(v: unknown): BuyerDeliveryAddress166 {
  const p = object(v, keys);
  for (const k of keys) if (typeof p[k] !== 'string' || (p[k] as string).length > 400 ||
    /[\p{Cc}\uD800-\uDFFF]/u.test(p[k] as string)) throw Error('Niepoprawna odpowiedź serwera.');
  return Object.freeze({ ...p }) as BuyerDeliveryAddress166;
}
function status(v: unknown): Status {
  const p = object(v, ['available', 'read_only', 'enabled', 'can_edit', 'reason', 'delivery', 'revision', 'last_change']);
  for (const k of ['available', 'read_only', 'enabled', 'can_edit'])
    if (typeof p[k] !== 'boolean') throw Error('Niepoprawna odpowiedź serwera.');
  if (p.reason !== null && (typeof p.reason !== 'string' || !Object.hasOwn(reasons, p.reason)))
    throw Error('Niepoprawna odpowiedź serwera.');
  const delivery = p.delivery === null ? null : address(p.delivery);
  if (p.revision !== null && !opaque(p.revision)) throw Error('Niepoprawna odpowiedź serwera.');
  if (p.last_change !== null) {
    const c = object(p.last_change, ['created_at']);
    if (typeof c.created_at !== 'string' || !Number.isFinite(Date.parse(c.created_at)))
      throw Error('Niepoprawna odpowiedź serwera.');
  }
  if ((!p.available || !p.enabled) && (delivery !== null || p.revision !== null || p.last_change !== null || p.can_edit))
    throw Error('Niepoprawna odpowiedź serwera.');
  if (p.can_edit ? (!p.available || !p.enabled || p.read_only || !delivery || !p.revision || p.reason !== null)
    : p.reason === null) throw Error('Niepoprawna odpowiedź serwera.');
  return { ...p, delivery } as Status;
}
class EndpointRefusal extends Error {
  constructor(public readonly status: number) { super('Serwer odmówił operacji.'); }
}

export function mountBuyerAddressPortal166(host: HTMLElement, deps: {
  fetch?: typeof globalThis.fetch; now?: () => number; newKey?: () => string;
} = {}): { ready: Promise<void>; destroy(): void } {
  const doc = host.ownerDocument, win = doc.defaultView;
  if (!win || !/^\/api\/public\/orders\/[a-f0-9]{48}$/.test(win.location.pathname))
    throw Error('Niepoprawna strona zamówienia.');
  const page = win.location.href, base = win.location.pathname + '/address';
  const fetcher = deps.fetch ?? win.fetch.bind(win), now = deps.now ?? Date.now;
  const newKey = deps.newKey ?? (() => win.crypto.randomUUID());
  let state: Status | null = null, preview: Preview | null = null, pending: Attempt | null = null;
  let busy = false, dead = false, generation = 0;
  let historicalReceipt: { delivery: BuyerDeliveryAddress166; created_at: string } | null = null;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text: string, parent: HTMLElement) => {
    const el = doc.createElement(tag); el.textContent = text; parent.append(el); return el;
  };
  host.replaceChildren();
  node('h2', 'Adres dostawy', host);
  const notice = node('p', '', host), result = node('p', '', host), error = node('p', '', host);
  notice.setAttribute('role', 'status'); result.setAttribute('role', 'status'); error.setAttribute('role', 'alert');
  const saved = node('div', '', host), history = node('div', '', host), form = node('form', '', host);
  saved.setAttribute('data-buyer-address-current', '');
  history.setAttribute('data-buyer-address-history', '');
  const inputs = {} as Record<keyof BuyerDeliveryAddress166, HTMLInputElement>;
  for (const k of keys) {
    const label = node('label', names[k], form), field = node('input', '', label);
    field.name = k; field.type = k === 'phone' ? 'tel' : 'text';
    field.maxLength = { recipient_name: 400, street: 400, city: 200, postal_code: 20, country: 2, phone: 30 }[k];
    field.setAttribute('aria-label', names[k]); inputs[k] = field;
    field.addEventListener('input', () => { preview = null; consent.checked = false; result.textContent = ''; render(); });
  }
  const check = node('button', 'Sprawdź zmianę', form); check.type = 'submit';
  const comparison = node('div', '', host);
  const consentLabel = node('label', 'Potwierdzam pokazany adres dostawy i lokalną zmianę.', host);
  const consent = doc.createElement('input'); consent.type = 'checkbox'; consentLabel.prepend(consent);
  consent.setAttribute('aria-label', 'Potwierdzam pokazany adres dostawy i lokalną zmianę');
  const apply = node('button', 'Zapisz adres dostawy', host); apply.type = 'button';
  const retry = node('button', 'Ponów ten sam zapis', host); retry.type = 'button';
  const refresh = node('button', 'Odśwież adres dostawy', host); refresh.type = 'button';
  consent.addEventListener('change', render);
  function active(g = generation): boolean {
    if (dead) return false;
    if (win!.location.href !== page) { purge(); dead = true; return false; }
    return g === generation;
  }
  function purge() {
    state = null; preview = null; pending = null; historicalReceipt = null; consent.checked = false;
    for (const k of keys) inputs[k].value = '';
    saved.replaceChildren(); comparison.replaceChildren(); result.textContent = ''; render();
  }
  function render() {
    const editable = !!state?.can_edit && !dead;
    form.hidden = !editable; notice.textContent = state?.reason ? reasons[state.reason] :
      state ? 'Sprawdź adres, a następnie osobno zatwierdź zmianę.' : 'Adres dostawy jest niedostępny.';
    saved.replaceChildren();
    if (state?.delivery) {
      node('h3', 'Aktualny adres dostawy — ostatni odczyt', saved);
      for (const k of keys) node('p', `${names[k]}: ${state.delivery[k]}`, saved);
    }
    history.replaceChildren();
    if (historicalReceipt) {
      node('h3', 'Potwierdzenie wcześniejszej korekty — historia, nie aktualny adres', history);
      node('p', 'Zapisano: ' + historicalReceipt.created_at, history);
      for (const k of keys) node('p', `${names[k]}: ${historicalReceipt.delivery[k]}`, history);
    }
    for (const k of keys) inputs[k].disabled = busy || !!pending || !editable;
    check.disabled = busy || !!pending || !editable;
    comparison.replaceChildren();
    if (preview) {
      const table = node('table', '', comparison), head = node('tr', '', table);
      for (const text of ['Pole', 'Dotychczasowy adres', 'Nowy adres']) node('th', text, head);
      for (const k of keys) { const tr = node('tr', '', table);
        for (const text of [names[k], preview.before[k], preview.after[k]]) node('td', text, tr); }
    }
    const validPreview = !!preview && Date.parse(preview.expires_at) > now();
    consentLabel.hidden = !preview; consent.disabled = busy || !!pending || !editable || !validPreview;
    apply.hidden = !preview; apply.disabled = busy || !!pending || !editable || !validPreview || !consent.checked;
    retry.hidden = !pending; retry.disabled = busy || dead || state?.read_only === true;
    refresh.disabled = busy || !!pending || dead;
  }
  async function request(path: string, wire?: string): Promise<unknown> {
    const response = await fetcher(base + path, { method: wire === undefined ? 'GET' : 'POST',
      credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: wire === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(wire === undefined ? {} : { body: wire }) });
    if (!response.ok) throw new EndpointRefusal(response.status);
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? ''))
      throw Error('Niepoprawna odpowiedź serwera.');
    return response.json();
  }
  async function load() {
    if (dead || busy || pending) return;
    const g = ++generation; busy = true; consent.checked = false; preview = null; error.textContent = ''; render();
    try { const next = status(await request('')); if (!active(g)) return;
      state = next;
      if (!next.available || !next.enabled) historicalReceipt = null;
      for (const k of keys) inputs[k].value = next.delivery?.[k] ?? '';
    } catch (e) { if (active(g)) { purge(); error.textContent = e instanceof EndpointRefusal && e.status === 404
      ? 'Link jest niedostępny. Skontaktuj się ze sprzedawcą.' : 'Nie udało się odczytać adresu dostawy.'; } }
    finally { if (active(g)) { busy = false; render(); } }
  }
  async function send(attempt: Attempt, g: number) {
    // Fresh native public token/policy status, never a cached availability decision.
    const fresh = status(await request('')); if (!active(g)) return;
    state = fresh;
    if (fresh.read_only) throw new EndpointRefusal(423);
    if (!fresh.available || !fresh.enabled) throw new EndpointRefusal(404);
    // A replayed apply may already have committed. Allow its exact recovery body through native
    // replay authority even if the latest revision/fulfillment changed. Fresh attempts stay bound.
    if (attempt.kind === 'preview' || !pending) {
      if (!fresh.can_edit || fresh.revision !== attempt.revision || !fresh.delivery ||
          !equal(fresh.delivery, attempt.before)) throw new EndpointRefusal(409);
    }
    if (!active(g)) return;
    pending = attempt; render();
    const raw = await request(attempt.path, attempt.wire); if (!active(g)) return;
    if (attempt.kind === 'preview') {
      const p = object(raw, ['available', 'read_only', 'id', 'scope_hash', 'expires_at', 'before', 'after', 'changed', 'state', 'local_only', 'reused']);
      const before = address(p.before), after = address(p.after);
      if (p.available !== true || p.read_only !== false || typeof p.id !== 'string' || !uuid.test(p.id) ||
          typeof p.scope_hash !== 'string' || !hash.test(p.scope_hash) || typeof p.expires_at !== 'string' ||
          !Number.isFinite(Date.parse(p.expires_at)) || Date.parse(p.expires_at) <= now() ||
          p.state !== 'preview' || p.local_only !== true || typeof p.reused !== 'boolean' ||
          p.changed !== !equal(before, after) || !equal(before, attempt.before) || !equal(after, attempt.expected))
        throw Error('Niepoprawna odpowiedź serwera.');
      preview = { ...p, before, after } as Preview; consent.checked = false;
    } else {
      const p = object(raw, ['available', 'read_only', 'id', 'state', 'changed', 'delivery', 'revision', 'created_at', 'reused']);
      const delivery = address(p.delivery);
      if (p.available !== true || p.read_only !== false || typeof p.id !== 'string' || !uuid.test(p.id) ||
          p.state !== 'applied' || p.changed !== attempt.preview?.changed || typeof p.reused !== 'boolean' ||
          !opaque(p.revision) || typeof p.created_at !== 'string' || !Number.isFinite(Date.parse(p.created_at)) ||
          !equal(delivery, attempt.expected)) throw Error('Niepoprawna odpowiedź serwera.');
      // Native exact replay returns its original terminal result, even after a later correction.
      // Its opaque revision cannot be ordered against the latest GET. Keep that read separate.
      if (p.reused) {
        state = fresh; historicalReceipt = { delivery, created_at: p.created_at };
        result.textContent = 'Wcześniejszy adres został zapisany. Potwierdzenie jest historyczne; aktualny adres pochodzi z ostatniego odczytu.';
      } else {
        state = { ...fresh, delivery, revision: p.revision }; historicalReceipt = null;
        result.textContent = 'Adres dostawy został zapisany. Dane nabywcy faktury pozostają bez zmian.';
      }
      preview = null; consent.checked = false;
      for (const k of keys) inputs[k].value = state.delivery?.[k] ?? '';
    }
    pending = null;
  }
  async function mutate(attempt: Attempt) {
    if (busy || !active()) return;
    busy = true; error.textContent = ''; render(); const g = generation;
    try { await send(attempt, g); }
    catch (e) {
      if (!active(g)) return;
      if (e instanceof EndpointRefusal && [404, 423, 409, 422].includes(e.status)) {
        pending = null; preview = null; consent.checked = false;
        if (e.status === 404) { purge(); error.textContent = 'Link jest niedostępny. Skontaktuj się ze sprzedawcą.'; }
        if (e.status === 423) { state = state ? { ...state, read_only: true, can_edit: false, reason: 'read_only' } : null;
          error.textContent = 'Podgląd kopii — zmiana adresu jest wyłączona.'; }
        if (e.status === 422) error.textContent = 'Sprawdź pola adresu i przygotuj nowy podgląd.';
        if (e.status === 409) { busy = false; await load(); if (active()) error.textContent = 'Adres lub realizacja zmieniły się. Sprawdź nowy podgląd.'; }
      } else error.textContent = pending ? 'Wynik zapisu jest niepewny. Ponów wyłącznie ten sam zapis.' : 'Nie udało się sprawdzić dostępu.';
    } finally { if (active()) { busy = false; render(); } }
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (busy || pending || !state?.can_edit || !state.delivery || !state.revision || !active()) return;
    try {
      const delivery = validateBuyerDeliveryAddress166(Object.fromEntries(keys.map(k => [k, inputs[k].value])),
        { originalCountry: state.delivery.country, deliveryKind: 'address' });
      preview = null; consent.checked = false; result.textContent = '';
      void mutate({ kind: 'preview', path: '/previews', wire: JSON.stringify({ client_key: newKey(), revision: state.revision, delivery }),
        expected: delivery, before: state.delivery, revision: state.revision, preview: null });
    } catch { error.textContent = 'Sprawdź adres, kod pocztowy i telefon w formacie E.164.'; render(); }
  });
  apply.addEventListener('click', () => {
    if (busy || pending || !state?.can_edit || !preview || !consent.checked || Date.parse(preview.expires_at) <= now() || !active()) return;
    void mutate({ kind: 'apply', path: '/previews/' + preview.id + '/apply',
      wire: JSON.stringify({ client_key: newKey(), scope_hash: preview.scope_hash, confirmed: true, local_only: true }),
      expected: preview.after, before: preview.before, revision: state.revision!, preview });
  });
  retry.addEventListener('click', () => { if (pending) void mutate(pending); });
  refresh.addEventListener('click', () => { void load(); });
  render(); return { ready: load(), destroy() { ++generation; dead = true; purge(); host.replaceChildren(); } };
}

// Generated browser IIFE; regenerate with scripts/build-buyer-address-portal.ts.
export const browserScript166 = "var BuyerAddressPortal166 = (() => {\n  var __defProp = Object.defineProperty;\n  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;\n  var __getOwnPropNames = Object.getOwnPropertyNames;\n  var __hasOwnProp = Object.prototype.hasOwnProperty;\n  var __export = (target, all) => {\n    for (var name in all)\n      __defProp(target, name, { get: all[name], enumerable: true });\n  };\n  var __copyProps = (to, from, except, desc) => {\n    if (from && typeof from === \"object\" || typeof from === \"function\") {\n      for (let key of __getOwnPropNames(from))\n        if (!__hasOwnProp.call(to, key) && key !== except)\n          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });\n    }\n    return to;\n  };\n  var __toCommonJS = (mod) => __copyProps(__defProp({}, \"__esModule\", { value: true }), mod);\n\n  // server/buyer-address-portal.ts\n  var buyer_address_portal_exports = {};\n  __export(buyer_address_portal_exports, {\n    mountBuyerAddressPortal166: () => mountBuyerAddressPortal166\n  });\n\n  // server/buyer-delivery-address.ts\n  var BuyerDeliveryAddressError166 = class extends Error {\n    constructor(code, field = null) {\n      super(`Niepoprawny adres dostawy: ${code}${field ? ` (${field})` : \"\"}`);\n      this.code = code;\n      this.field = field;\n      this.name = \"BuyerDeliveryAddressError166\";\n    }\n    code;\n    field;\n  };\n  var fail = (code, field = null) => {\n    throw new BuyerDeliveryAddressError166(code, field);\n  };\n  var fields = [\"recipient_name\", \"street\", \"city\", \"postal_code\", \"country\", \"phone\"];\n  var countries = new Set(\"AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW\".split(\" \"));\n  function kind(input) {\n    if (input !== \"address\" && input !== \"pickup_point\" && input !== \"unknown\")\n      return fail(\"delivery_kind_invalid\");\n    return input;\n  }\n  function record(input, field) {\n    if (!input || typeof input !== \"object\" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))\n      return fail(\"object_required\", field);\n    for (const key of Reflect.ownKeys(input)) {\n      const descriptor = Object.getOwnPropertyDescriptor(input, key);\n      if (typeof key !== \"string\" || !(\"value\" in descriptor) || !descriptor.enumerable)\n        return fail(\"plain_data_required\", field);\n    }\n    return input;\n  }\n  function text(input, field, min, max, trim) {\n    if (typeof input !== \"string\") return fail(\"text_required\", field);\n    if (/[\\p{Cc}\\p{Zl}\\p{Zp}\\uD800-\\uDFFF]/u.test(input))\n      return fail(\"invalid_unicode_or_control\", field);\n    const value = trim ? input.trim() : input;\n    const length = Array.from(value).length;\n    if (length < min || length > max) return fail(\"text_length\", field);\n    return value;\n  }\n  function country(input, field) {\n    const value = text(input, field, 2, 2, false);\n    if (!countries.has(value)) return fail(\"country_invalid\", field);\n    return value;\n  }\n  function validateBuyerDeliveryAddress166(input, basis) {\n    const deliveryKind = kind(basis.deliveryKind);\n    if (deliveryKind !== \"address\")\n      return fail(deliveryKind === \"pickup_point\" ? \"pickup_point_delivery\" : \"delivery_kind_unknown\");\n    const originalCountry = country(basis.originalCountry, \"original_country\");\n    const value = record(input, \"delivery\");\n    if (Object.keys(value).length !== fields.length || fields.some((f) => !(f in value)) || Object.keys(value).some((f) => !fields.includes(f)))\n      return fail(\"delivery_fields\");\n    const result = {\n      recipient_name: text(value.recipient_name, \"recipient_name\", 2, 200, true),\n      street: text(value.street, \"street\", 3, 200, true),\n      city: text(value.city, \"city\", 2, 100, true),\n      postal_code: text(value.postal_code, \"postal_code\", 1, 20, true),\n      country: country(value.country, \"country\"),\n      phone: text(value.phone, \"phone\", 9, 16, true)\n    };\n    if (result.country !== originalCountry) return fail(\"country_change_not_supported\", \"country\");\n    if (result.country === \"PL\" && !/^[0-9]{2}-[0-9]{3}$/.test(result.postal_code))\n      return fail(\"postal_code_invalid\", \"postal_code\");\n    if (!/^\\+[1-9][0-9]{7,14}$/.test(result.phone)) return fail(\"phone_e164_required\", \"phone\");\n    return Object.freeze(result);\n  }\n\n  // server/buyer-address-portal.ts\n  var names = {\n    recipient_name: \"Odbiorca\",\n    street: \"Ulica i numer\",\n    city: \"Miejscowo\\u015B\\u0107\",\n    postal_code: \"Kod pocztowy\",\n    country: \"Kraj\",\n    phone: \"Telefon (E.164)\"\n  };\n  var reasons = {\n    module_unavailable: \"Korekta adresu jest niedost\\u0119pna w tej kopii.\",\n    access_disabled: \"Sprzedawca nie udost\\u0119pni\\u0142 korekty adresu.\",\n    read_only: \"Podgl\\u0105d kopii \\u2014 zmiana adresu jest wy\\u0142\\u0105czona.\",\n    fulfillment_started: \"Rozpocz\\u0119to realizacj\\u0119. Skontaktuj si\\u0119 ze sprzedawc\\u0105.\",\n    shipment_locked: \"Przesy\\u0142ka wymaga obs\\u0142ugi sprzedawcy. Zmiana adresu jest zablokowana.\",\n    dependent_plan_locked: \"Trwa inna operacja. Skontaktuj si\\u0119 ze sprzedawc\\u0105.\",\n    pickup_point_delivery: \"Dostawa do punktu odbioru \\u2014 zmian\\u0119 uzgodnij ze sprzedawc\\u0105.\",\n    delivery_kind_unknown: \"Rodzaj dostawy wymaga potwierdzenia przez sprzedawc\\u0119.\"\n  };\n  var keys = Object.keys(names);\n  var uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;\n  var hash = /^[0-9a-f]{64}$/;\n  var opaque = (v) => typeof v === \"string\" && v.length >= 1 && v.length <= 512 && !/[\\p{Cc}]/u.test(v);\n  var equal = (a, b) => keys.every((k) => a[k] === b[k]);\n  function object(v, fields2) {\n    if (!v || typeof v !== \"object\" || Array.isArray(v) || Object.keys(v).length !== fields2.length || Object.keys(v).some((k) => !fields2.includes(k))) throw Error(\"Niepoprawna odpowied\\u017A serwera.\");\n    return v;\n  }\n  function address(v) {\n    const p = object(v, keys);\n    for (const k of keys) if (typeof p[k] !== \"string\" || p[k].length > 400 || /[\\p{Cc}\\uD800-\\uDFFF]/u.test(p[k])) throw Error(\"Niepoprawna odpowied\\u017A serwera.\");\n    return Object.freeze({ ...p });\n  }\n  function status(v) {\n    const p = object(v, [\"available\", \"read_only\", \"enabled\", \"can_edit\", \"reason\", \"delivery\", \"revision\", \"last_change\"]);\n    for (const k of [\"available\", \"read_only\", \"enabled\", \"can_edit\"])\n      if (typeof p[k] !== \"boolean\") throw Error(\"Niepoprawna odpowied\\u017A serwera.\");\n    if (p.reason !== null && (typeof p.reason !== \"string\" || !Object.hasOwn(reasons, p.reason)))\n      throw Error(\"Niepoprawna odpowied\\u017A serwera.\");\n    const delivery = p.delivery === null ? null : address(p.delivery);\n    if (p.revision !== null && !opaque(p.revision)) throw Error(\"Niepoprawna odpowied\\u017A serwera.\");\n    if (p.last_change !== null) {\n      const c = object(p.last_change, [\"created_at\"]);\n      if (typeof c.created_at !== \"string\" || !Number.isFinite(Date.parse(c.created_at)))\n        throw Error(\"Niepoprawna odpowied\\u017A serwera.\");\n    }\n    if ((!p.available || !p.enabled) && (delivery !== null || p.revision !== null || p.last_change !== null || p.can_edit))\n      throw Error(\"Niepoprawna odpowied\\u017A serwera.\");\n    if (p.can_edit ? !p.available || !p.enabled || p.read_only || !delivery || !p.revision || p.reason !== null : p.reason === null) throw Error(\"Niepoprawna odpowied\\u017A serwera.\");\n    return { ...p, delivery };\n  }\n  var EndpointRefusal = class extends Error {\n    constructor(status2) {\n      super(\"Serwer odm\\xF3wi\\u0142 operacji.\");\n      this.status = status2;\n    }\n    status;\n  };\n  function mountBuyerAddressPortal166(host, deps = {}) {\n    const doc = host.ownerDocument, win = doc.defaultView;\n    if (!win || !/^\\/api\\/public\\/orders\\/[a-f0-9]{48}$/.test(win.location.pathname))\n      throw Error(\"Niepoprawna strona zam\\xF3wienia.\");\n    const page = win.location.href, base = win.location.pathname + \"/address\";\n    const fetcher = deps.fetch ?? win.fetch.bind(win), now = deps.now ?? Date.now;\n    const newKey = deps.newKey ?? (() => win.crypto.randomUUID());\n    let state = null, preview = null, pending = null;\n    let busy = false, dead = false, generation = 0;\n    let historicalReceipt = null;\n    const node = (tag, text2, parent) => {\n      const el = doc.createElement(tag);\n      el.textContent = text2;\n      parent.append(el);\n      return el;\n    };\n    host.replaceChildren();\n    node(\"h2\", \"Adres dostawy\", host);\n    const notice = node(\"p\", \"\", host), result = node(\"p\", \"\", host), error = node(\"p\", \"\", host);\n    notice.setAttribute(\"role\", \"status\");\n    result.setAttribute(\"role\", \"status\");\n    error.setAttribute(\"role\", \"alert\");\n    const saved = node(\"div\", \"\", host), history = node(\"div\", \"\", host), form = node(\"form\", \"\", host);\n    saved.setAttribute(\"data-buyer-address-current\", \"\");\n    history.setAttribute(\"data-buyer-address-history\", \"\");\n    const inputs = {};\n    for (const k of keys) {\n      const label = node(\"label\", names[k], form), field = node(\"input\", \"\", label);\n      field.name = k;\n      field.type = k === \"phone\" ? \"tel\" : \"text\";\n      field.maxLength = { recipient_name: 400, street: 400, city: 200, postal_code: 20, country: 2, phone: 30 }[k];\n      field.setAttribute(\"aria-label\", names[k]);\n      inputs[k] = field;\n      field.addEventListener(\"input\", () => {\n        preview = null;\n        consent.checked = false;\n        result.textContent = \"\";\n        render();\n      });\n    }\n    const check = node(\"button\", \"Sprawd\\u017A zmian\\u0119\", form);\n    check.type = \"submit\";\n    const comparison = node(\"div\", \"\", host);\n    const consentLabel = node(\"label\", \"Potwierdzam pokazany adres dostawy i lokaln\\u0105 zmian\\u0119.\", host);\n    const consent = doc.createElement(\"input\");\n    consent.type = \"checkbox\";\n    consentLabel.prepend(consent);\n    consent.setAttribute(\"aria-label\", \"Potwierdzam pokazany adres dostawy i lokaln\\u0105 zmian\\u0119\");\n    const apply = node(\"button\", \"Zapisz adres dostawy\", host);\n    apply.type = \"button\";\n    const retry = node(\"button\", \"Pon\\xF3w ten sam zapis\", host);\n    retry.type = \"button\";\n    const refresh = node(\"button\", \"Od\\u015Bwie\\u017C adres dostawy\", host);\n    refresh.type = \"button\";\n    consent.addEventListener(\"change\", render);\n    function active(g = generation) {\n      if (dead) return false;\n      if (win.location.href !== page) {\n        purge();\n        dead = true;\n        return false;\n      }\n      return g === generation;\n    }\n    function purge() {\n      state = null;\n      preview = null;\n      pending = null;\n      historicalReceipt = null;\n      consent.checked = false;\n      for (const k of keys) inputs[k].value = \"\";\n      saved.replaceChildren();\n      comparison.replaceChildren();\n      result.textContent = \"\";\n      render();\n    }\n    function render() {\n      const editable = !!state?.can_edit && !dead;\n      form.hidden = !editable;\n      notice.textContent = state?.reason ? reasons[state.reason] : state ? \"Sprawd\\u017A adres, a nast\\u0119pnie osobno zatwierd\\u017A zmian\\u0119.\" : \"Adres dostawy jest niedost\\u0119pny.\";\n      saved.replaceChildren();\n      if (state?.delivery) {\n        node(\"h3\", \"Aktualny adres dostawy \\u2014 ostatni odczyt\", saved);\n        for (const k of keys) node(\"p\", `${names[k]}: ${state.delivery[k]}`, saved);\n      }\n      history.replaceChildren();\n      if (historicalReceipt) {\n        node(\"h3\", \"Potwierdzenie wcze\\u015Bniejszej korekty \\u2014 historia, nie aktualny adres\", history);\n        node(\"p\", \"Zapisano: \" + historicalReceipt.created_at, history);\n        for (const k of keys) node(\"p\", `${names[k]}: ${historicalReceipt.delivery[k]}`, history);\n      }\n      for (const k of keys) inputs[k].disabled = busy || !!pending || !editable;\n      check.disabled = busy || !!pending || !editable;\n      comparison.replaceChildren();\n      if (preview) {\n        const table = node(\"table\", \"\", comparison), head = node(\"tr\", \"\", table);\n        for (const text2 of [\"Pole\", \"Dotychczasowy adres\", \"Nowy adres\"]) node(\"th\", text2, head);\n        for (const k of keys) {\n          const tr = node(\"tr\", \"\", table);\n          for (const text2 of [names[k], preview.before[k], preview.after[k]]) node(\"td\", text2, tr);\n        }\n      }\n      const validPreview = !!preview && Date.parse(preview.expires_at) > now();\n      consentLabel.hidden = !preview;\n      consent.disabled = busy || !!pending || !editable || !validPreview;\n      apply.hidden = !preview;\n      apply.disabled = busy || !!pending || !editable || !validPreview || !consent.checked;\n      retry.hidden = !pending;\n      retry.disabled = busy || dead || state?.read_only === true;\n      refresh.disabled = busy || !!pending || dead;\n    }\n    async function request(path, wire) {\n      const response = await fetcher(base + path, {\n        method: wire === void 0 ? \"GET\" : \"POST\",\n        credentials: \"omit\",\n        cache: \"no-store\",\n        redirect: \"error\",\n        headers: wire === void 0 ? { Accept: \"application/json\" } : { Accept: \"application/json\", \"Content-Type\": \"application/json\" },\n        ...wire === void 0 ? {} : { body: wire }\n      });\n      if (!response.ok) throw new EndpointRefusal(response.status);\n      if (!/^application\\/json(?:;|$)/i.test(response.headers.get(\"content-type\") ?? \"\"))\n        throw Error(\"Niepoprawna odpowied\\u017A serwera.\");\n      return response.json();\n    }\n    async function load() {\n      if (dead || busy || pending) return;\n      const g = ++generation;\n      busy = true;\n      consent.checked = false;\n      preview = null;\n      error.textContent = \"\";\n      render();\n      try {\n        const next = status(await request(\"\"));\n        if (!active(g)) return;\n        state = next;\n        if (!next.available || !next.enabled) historicalReceipt = null;\n        for (const k of keys) inputs[k].value = next.delivery?.[k] ?? \"\";\n      } catch (e) {\n        if (active(g)) {\n          purge();\n          error.textContent = e instanceof EndpointRefusal && e.status === 404 ? \"Link jest niedost\\u0119pny. Skontaktuj si\\u0119 ze sprzedawc\\u0105.\" : \"Nie uda\\u0142o si\\u0119 odczyta\\u0107 adresu dostawy.\";\n        }\n      } finally {\n        if (active(g)) {\n          busy = false;\n          render();\n        }\n      }\n    }\n    async function send(attempt, g) {\n      const fresh = status(await request(\"\"));\n      if (!active(g)) return;\n      state = fresh;\n      if (fresh.read_only) throw new EndpointRefusal(423);\n      if (!fresh.available || !fresh.enabled) throw new EndpointRefusal(404);\n      if (attempt.kind === \"preview\" || !pending) {\n        if (!fresh.can_edit || fresh.revision !== attempt.revision || !fresh.delivery || !equal(fresh.delivery, attempt.before)) throw new EndpointRefusal(409);\n      }\n      if (!active(g)) return;\n      pending = attempt;\n      render();\n      const raw = await request(attempt.path, attempt.wire);\n      if (!active(g)) return;\n      if (attempt.kind === \"preview\") {\n        const p = object(raw, [\"available\", \"read_only\", \"id\", \"scope_hash\", \"expires_at\", \"before\", \"after\", \"changed\", \"state\", \"local_only\", \"reused\"]);\n        const before = address(p.before), after = address(p.after);\n        if (p.available !== true || p.read_only !== false || typeof p.id !== \"string\" || !uuid.test(p.id) || typeof p.scope_hash !== \"string\" || !hash.test(p.scope_hash) || typeof p.expires_at !== \"string\" || !Number.isFinite(Date.parse(p.expires_at)) || Date.parse(p.expires_at) <= now() || p.state !== \"preview\" || p.local_only !== true || typeof p.reused !== \"boolean\" || p.changed !== !equal(before, after) || !equal(before, attempt.before) || !equal(after, attempt.expected))\n          throw Error(\"Niepoprawna odpowied\\u017A serwera.\");\n        preview = { ...p, before, after };\n        consent.checked = false;\n      } else {\n        const p = object(raw, [\"available\", \"read_only\", \"id\", \"state\", \"changed\", \"delivery\", \"revision\", \"created_at\", \"reused\"]);\n        const delivery = address(p.delivery);\n        if (p.available !== true || p.read_only !== false || typeof p.id !== \"string\" || !uuid.test(p.id) || p.state !== \"applied\" || p.changed !== attempt.preview?.changed || typeof p.reused !== \"boolean\" || !opaque(p.revision) || typeof p.created_at !== \"string\" || !Number.isFinite(Date.parse(p.created_at)) || !equal(delivery, attempt.expected)) throw Error(\"Niepoprawna odpowied\\u017A serwera.\");\n        if (p.reused) {\n          state = fresh;\n          historicalReceipt = { delivery, created_at: p.created_at };\n          result.textContent = \"Wcze\\u015Bniejszy adres zosta\\u0142 zapisany. Potwierdzenie jest historyczne; aktualny adres pochodzi z ostatniego odczytu.\";\n        } else {\n          state = { ...fresh, delivery, revision: p.revision };\n          historicalReceipt = null;\n          result.textContent = \"Adres dostawy zosta\\u0142 zapisany. Dane nabywcy faktury pozostaj\\u0105 bez zmian.\";\n        }\n        preview = null;\n        consent.checked = false;\n        for (const k of keys) inputs[k].value = state.delivery?.[k] ?? \"\";\n      }\n      pending = null;\n    }\n    async function mutate(attempt) {\n      if (busy || !active()) return;\n      busy = true;\n      error.textContent = \"\";\n      render();\n      const g = generation;\n      try {\n        await send(attempt, g);\n      } catch (e) {\n        if (!active(g)) return;\n        if (e instanceof EndpointRefusal && [404, 423, 409, 422].includes(e.status)) {\n          pending = null;\n          preview = null;\n          consent.checked = false;\n          if (e.status === 404) {\n            purge();\n            error.textContent = \"Link jest niedost\\u0119pny. Skontaktuj si\\u0119 ze sprzedawc\\u0105.\";\n          }\n          if (e.status === 423) {\n            state = state ? { ...state, read_only: true, can_edit: false, reason: \"read_only\" } : null;\n            error.textContent = \"Podgl\\u0105d kopii \\u2014 zmiana adresu jest wy\\u0142\\u0105czona.\";\n          }\n          if (e.status === 422) error.textContent = \"Sprawd\\u017A pola adresu i przygotuj nowy podgl\\u0105d.\";\n          if (e.status === 409) {\n            busy = false;\n            await load();\n            if (active()) error.textContent = \"Adres lub realizacja zmieni\\u0142y si\\u0119. Sprawd\\u017A nowy podgl\\u0105d.\";\n          }\n        } else error.textContent = pending ? \"Wynik zapisu jest niepewny. Pon\\xF3w wy\\u0142\\u0105cznie ten sam zapis.\" : \"Nie uda\\u0142o si\\u0119 sprawdzi\\u0107 dost\\u0119pu.\";\n      } finally {\n        if (active()) {\n          busy = false;\n          render();\n        }\n      }\n    }\n    form.addEventListener(\"submit\", (event) => {\n      event.preventDefault();\n      if (busy || pending || !state?.can_edit || !state.delivery || !state.revision || !active()) return;\n      try {\n        const delivery = validateBuyerDeliveryAddress166(\n          Object.fromEntries(keys.map((k) => [k, inputs[k].value])),\n          { originalCountry: state.delivery.country, deliveryKind: \"address\" }\n        );\n        preview = null;\n        consent.checked = false;\n        result.textContent = \"\";\n        void mutate({\n          kind: \"preview\",\n          path: \"/previews\",\n          wire: JSON.stringify({ client_key: newKey(), revision: state.revision, delivery }),\n          expected: delivery,\n          before: state.delivery,\n          revision: state.revision,\n          preview: null\n        });\n      } catch {\n        error.textContent = \"Sprawd\\u017A adres, kod pocztowy i telefon w formacie E.164.\";\n        render();\n      }\n    });\n    apply.addEventListener(\"click\", () => {\n      if (busy || pending || !state?.can_edit || !preview || !consent.checked || Date.parse(preview.expires_at) <= now() || !active()) return;\n      void mutate({\n        kind: \"apply\",\n        path: \"/previews/\" + preview.id + \"/apply\",\n        wire: JSON.stringify({ client_key: newKey(), scope_hash: preview.scope_hash, confirmed: true, local_only: true }),\n        expected: preview.after,\n        before: preview.before,\n        revision: state.revision,\n        preview\n      });\n    });\n    retry.addEventListener(\"click\", () => {\n      if (pending) void mutate(pending);\n    });\n    refresh.addEventListener(\"click\", () => {\n      void load();\n    });\n    render();\n    return { ready: load(), destroy() {\n      ++generation;\n      dead = true;\n      purge();\n      host.replaceChildren();\n    } };\n  }\n  return __toCommonJS(buyer_address_portal_exports);\n})();\n";
