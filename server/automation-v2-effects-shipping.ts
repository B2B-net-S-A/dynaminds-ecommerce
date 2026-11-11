/**
 * Automation rules v2: effects of lane M (shipping) — see server/automation-v2-effect-types.ts.
 *
 * create_shipment: DEMO (shipDemo, the pre-registry behaviour of empty params) or a carrier plan through the
 * same preview → queue path as the order card (InPost ShipX paczkomat, DPD). The carrier job runs after the
 * rule's transaction commits; an InPost plan created here buys its cheapest PLN offer once quoted
 * (shipping.ts automationBuyInTx). A production connection (not simulation, not sandbox) is used only with
 * buy_without_confirmation; otherwise the effect refuses.
 *
 * print_label: the order's ready shipment label through the shipment-label print queue (print_jobs) on the
 * chosen printer; client keys are stable per run, so a repeated effect in one run never queues twice.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { localConfig } from './db';
import { ensure, Problem } from './errors';
import { shipDemo } from './domain';
import { effectiveDeliveryInTx, deliveryBindingInTx } from './buyer-address';
import { fulfillmentPayment } from './payments';
import { shippingInput, previewShippingInTx, queueShipping } from './shipping';
import { dpdInput, previewDpdInTx, queueDpdInTx } from './dpd-shipping';
import {
  shipmentLabelPrintAvailable,
  createShipmentLabelPrintPreviewInTx,
  queueShipmentLabelPrintInTx,
} from './shipment-label-print';
import { result, type EffectEnv, type EffectModule } from './automation-v2-effect-types';

const uuid = z.uuid();
const optionalNumber = (schema: z.ZodNumber) => schema.optional();

const createShipment = z
  .strictObject({
    carrier: z.enum(['demo', 'inpost', 'dpd']).default('demo'),
    channel_id: uuid.optional(),
    /** InPost paczkomat size (A/B/C). */
    template: z.enum(['small', 'medium', 'large']).optional(),
    /** kg; default 1 (the order card's default). */
    weight: optionalNumber(z.number().positive().max(31.5)),
    /** DPD parcel size in cm; default 20 × 20 × 20 (the order card's default). */
    length: optionalNumber(z.number().int().min(1).max(175)),
    width: optionalNumber(z.number().int().min(1).max(175)),
    height: optionalNumber(z.number().int().min(1).max(175)),
    buy_without_confirmation: z.boolean().default(false),
  })
  .superRefine((p, ctx) => {
    if (p.carrier !== 'demo' && !p.channel_id)
      ctx.addIssue({ code: 'custom', message: 'Wybierz połączenie przewoźnika', path: ['channel_id'] });
    if (p.carrier === 'demo' && (p.channel_id || p.template || p.weight || p.length || p.width || p.height || p.buy_without_confirmation))
      ctx.addIssue({ code: 'custom', message: 'Przesyłka DEMO nie przyjmuje parametrów przewoźnika', path: ['carrier'] });
    if (p.carrier !== 'inpost' && p.template)
      ctx.addIssue({ code: 'custom', message: 'Gabaryt dotyczy paczkomatu InPost', path: ['template'] });
    if (p.carrier !== 'dpd' && (p.length || p.width || p.height))
      ctx.addIssue({ code: 'custom', message: 'Wymiary dotyczą paczki DPD', path: ['length'] });
  });
type CreateShipment = z.infer<typeof createShipment>;

const printLabel = z.strictObject({
  printer_id: uuid,
  copies: z.number().int().min(1).max(10).default(1),
});
type PrintLabel = z.infer<typeof printLabel>;

const CARRIER = { inpost: 'InPost', dpd: 'DPD' } as const;
const TEMPLATE = { small: 'A — mała', medium: 'B — średnia', large: 'C — duża' } as const;
/** Sender used only by a local simulation connection, as in the order card's DPD form. */
const DEMO_SENDER = { name: 'Nadawca DEMO', address: 'Testowa 1', city: 'Warszawa', postalCode: '01-354', phone: '500600700', email: 'qa@example.test' };

/** A stable UUID for a run's effect (same derivation as stableUuid in automation-v2-effects.ts). */
function stableUuid(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface CarrierChannel {
  id: string;
  name: string;
  provider: string;
  mode: string;
  settings: Record<string, any>;
}
const simulated = (ch: CarrierChannel) => Boolean(ch.settings?.simulation);
const production = (ch: CarrierChannel) => !simulated(ch) && ch.mode !== 'sandbox';
const scopeLabel = (ch: CarrierChannel) => (simulated(ch) ? 'symulacja' : production(ch) ? 'produkcja' : 'sandbox');

async function carrierChannel(c: PoolClient, carrier: 'inpost' | 'dpd', id: string, lock = false): Promise<CarrierChannel> {
  const ch = (await c.query(`SELECT * FROM channels WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [id])).rows[0];
  ensure(ch && ch.provider === carrier, 422, `Połączenie ${CARRIER[carrier]} nie istnieje lub należy do innej organizacji`);
  return ch;
}
function assertProductionConsent(ch: CarrierChannel, p: CreateShipment) {
  ensure(
    !production(ch) || p.buy_without_confirmation,
    422,
    `Połączenie „${ch.name}” jest produkcyjne: zaznacz w regule „Kupuj etykiety bez potwierdzenia” albo wybierz połączenie sandbox lub symulację`,
  );
}

const FIELD_LABELS: Array<[RegExp, string]> = [
  [/target_point/, 'punkt odbioru (paczkomat) w adresie zamówienia'],
  [/first_name|last_name|receiver\.name/, 'imię i nazwisko odbiorcy'],
  [/email/, 'e-mail odbiorcy'],
  [/phone/, 'telefon odbiorcy'],
  [/postalCode/, 'kod pocztowy odbiorcy'],
  [/receiver\.(address|city)/, 'adres odbiorcy'],
  [/sender/, 'dane nadawcy'],
  [/weight/, 'waga paczki'],
  [/cod|insurance/, 'kwota pobrania'],
];
/** Parses the carrier input with the module's own schema; a gap in the order's data is a Polish 422. */
function parsed<T>(carrier: 'inpost' | 'dpd', schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const path = issue.path.join('.');
  const field = FIELD_LABELS.find(([re]) => re.test(path))?.[1] ?? path;
  throw new Problem(422, `Nie można przygotować przesyłki ${CARRIER[carrier]}: uzupełnij ${field}${issue.code === 'custom' ? ` (${issue.message})` : ''}`);
}

/** The order's operational receiver (corrected delivery when present), as shown on the order card. */
async function receiver(c: PoolClient, o: any) {
  const e = await effectiveDeliveryInTx(c, o.tenant_id, o.id, localConfig.encryptionKey);
  const address = o.address ?? {};
  const d: any = e.available && e.delivery
    ? e.delivery
    : { recipient_name: String(address.recipient ?? '').trim() || o.customer_name, street: address.street, city: address.city, postal_code: address.postal_code, phone: address.phone };
  return {
    name: String(d.recipient_name ?? '').trim(),
    street: String(d.street ?? '').trim(),
    city: String(d.city ?? '').trim(),
    postal_code: String(d.postal_code ?? '').trim(),
    phone: String(d.phone ?? '').replace(/[\s()-]/g, ''),
    email: String(o.email ?? '').trim(),
    point: String(address.locker_code ?? address.pickup_point ?? '').trim(),
  };
}

async function dpdSender(c: PoolClient, ch: CarrierChannel) {
  if (ch.settings?.sender) return ch.settings.sender;
  // The operator's last sender on this connection (DPD has no sender in its connection settings).
  const last = (
    await c.query(
      "SELECT input->'sender' AS sender FROM shipping_plans WHERE channel_id=$1 AND input->>'provider'='dpd' AND input ? 'sender' ORDER BY created_at DESC,id DESC LIMIT 1",
      [ch.id],
    )
  ).rows[0]?.sender;
  if (last) return last;
  ensure(
    simulated(ch),
    422,
    'Brak danych nadawcy DPD: utwórz pierwszą przesyłkę tym połączeniem w karcie zamówienia, a reguła użyje tego nadawcy',
  );
  return DEMO_SENDER;
}

async function applyCreateShipment(env: EffectEnv, p: CreateShipment) {
  const { c, actor, orderId } = env;
  if ((await c.query('SELECT 1 FROM shipments WHERE order_id=$1', [orderId])).rowCount)
    return result('create_shipment', false, 'Zamówienie ma już przesyłkę');
  if (p.carrier === 'demo') {
    await shipDemo(c, actor, orderId);
    return result('create_shipment', true, 'Utworzono i wydano przesyłkę DEMO');
  }
  if (
    (await c.query("SELECT 1 FROM shipping_plans WHERE order_id=$1 AND state NOT IN ('preview','cancelled','dispatched')", [orderId]))
      .rowCount
  )
    return result('create_shipment', false, 'Zamówienie ma już zleconą przesyłkę');
  const ch = await carrierChannel(c, p.carrier, p.channel_id!, true);
  assertProductionConsent(ch, p);
  const o = (await c.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  ensure(o.status === 'packed', 409, 'Najpierw skompletuj i spakuj zamówienie');
  // The COD amount is the module's own: the current amount due of a COD order (refuses an unpaid prepaid one).
  const cod = await fulfillmentPayment(c, o);
  const r = await receiver(c, o);
  const weight = p.weight ?? 1;
  const live = production(ch) && p.buy_without_confirmation;
  if (p.carrier === 'inpost') {
    const [first, ...rest] = r.name.split(/\s+/).filter(Boolean);
    const b = parsed('inpost', shippingInput, {
      channel_id: ch.id,
      service: 'inpost_locker_standard',
      receiver: { first_name: first ?? '', last_name: rest.join(' '), email: r.email, phone: r.phone },
      ...(r.point ? { target_point: r.point } : {}),
      template: p.template ?? 'small',
      weight,
      cod,
      insurance: cod,
    });
    const plan = await previewShippingInTx(c, actor, ch, orderId, {
      ...b,
      // Read by processShipping: buy the cheapest PLN offer once quoted (shipping.ts automationBuyInTx).
      automation_buy: { rule_id: env.rule.id, run_id: env.runId, confirm_cost: live },
    } as typeof b);
    await queueShipping(c, actor, plan.id, live);
    return result(
      'create_shipment',
      true,
      `Zlecono wycenę i zakup etykiety InPost (paczkomat ${b.target_point}, gabaryt ${TEMPLATE[b.template]}, ${scopeLabel(ch)})`,
    );
  }
  const b = parsed('dpd', dpdInput, {
    channel_id: ch.id,
    sender: await dpdSender(c, ch),
    receiver: { name: r.name, address: r.street, city: r.city, postalCode: r.postal_code, phone: r.phone, email: r.email },
    weight,
    dimensions: { length: p.length ?? 20, width: p.width ?? 20, height: p.height ?? 20 },
    content: 'Towar ecommerce',
    cod,
    insurance: cod,
  });
  const plan = await previewDpdInTx(c, actor, orderId, b);
  // Simulation needs no consent; sandbox is consented by choosing it in the rule; production by the flag above.
  await queueDpdInTx(c, actor, actor, plan.id, { confirm_external: true, ack_contract_rate: true });
  return result('create_shipment', true, `Zlecono utworzenie etykiety DPD (${scopeLabel(ch)})`);
}

async function printTablesReady(c: PoolClient) {
  return (await c.query("SELECT to_regclass('print_printers') IS NOT NULL ok")).rows[0].ok as boolean;
}
async function printer(c: PoolClient, id: string) {
  ensure(await printTablesReady(c), 409, 'Moduł drukowania nie jest zainstalowany');
  const row = (
    await c.query(
      'SELECT p.id,p.name,p.version::text AS version,p.enabled,p.station_id,s.version::text AS station_version,s.enabled AS station_enabled FROM print_printers p JOIN packing_stations s ON (s.tenant_id,s.id)=(p.tenant_id,p.station_id) WHERE p.id=$1',
      [id],
    )
  ).rows[0];
  ensure(row, 422, 'Drukarka nie istnieje lub należy do innej organizacji');
  return row;
}
/** SQL refusals of the print module, mapped like its own transaction wrapper (shipment-label-print.ts tx). */
function printProblem(e: unknown): unknown {
  if (e instanceof Problem) return e;
  const err = e as { code?: string; message?: string };
  if (err.code === '23514' && err.message === 'Brak aktualnego uprawnienia do drukowania') return new Problem(403, err.message);
  if (err.code === '55000') return new Problem(409, 'Moduł kolejki etykiet jest niekompletny');
  if (err.code === 'P0002') return new Problem(409, 'Zamówienie nie ma gotowej etykiety przesyłki do druku');
  if (['23514', '23503', '23505', '22023'].includes(err.code ?? ''))
    return new Problem(409, `Nie można zlecić druku etykiety: ${err.message ?? 'zakres etykiety zmienił się'}`);
  return e;
}

async function applyPrintLabel(env: EffectEnv, p: PrintLabel) {
  const { c, actor, orderId } = env;
  const shipments = (await c.query('SELECT id,mode,tracking_number FROM shipments WHERE order_id=$1 ORDER BY created_at,id', [orderId])).rows;
  ensure(shipments.length, 409, 'Zamówienie nie ma jeszcze przesyłki z etykietą');
  ensure(shipments.length === 1, 409, 'Zamówienie ma kilka paczek; etykiety wydrukuj z karty zamówienia');
  const s = shipments[0];
  const pr = await printer(c, p.printer_id);
  ensure(pr.enabled, 409, `Drukarka „${pr.name}” jest nieaktywna`);
  ensure(pr.station_enabled, 409, `Stanowisko drukarki „${pr.name}” jest nieaktywne`);
  try {
    ensure(await shipmentLabelPrintAvailable(c), 409, 'Moduł druku etykiet nie jest zainstalowany');
    const access = (await c.query('SELECT print_job_access($1,$2,true,false) g', [actor.userId, actor.apiKeyId ?? null])).rows[0].g;
    ensure(access?.allowed, 403, 'Autor reguły nie ma uprawnienia do drukowania');
    // A DEMO label of a corrected receiver needs the operator's request custody (operational-delivery-consumers).
    if (s.mode === 'demo')
      ensure(
        !(await deliveryBindingInTx(c, actor.tenantId, orderId, localConfig.encryptionKey)),
        409,
        'Adres odbiorcy został poprawiony; etykietę DEMO wydrukuj z karty zamówienia',
      );
    const o = (await c.query('SELECT version::text AS version FROM orders WHERE id=$1', [orderId])).rows[0];
    const key = (kind: string) => stableUuid('v2-print-label', kind, env.runId, s.id, pr.id);
    const h = await createShipmentLabelPrintPreviewInTx(c, actor, s.id, {
      client_key: key('preview'),
      order_version: o.version,
      station_id: pr.station_id,
      station_version: pr.station_version,
      printer_id: pr.id,
      printer_version: pr.version,
      copies: p.copies,
    });
    // As the automatic packed print: deferred constraints while queueing, then the full flush.
    await c.query('SET CONSTRAINTS ALL DEFERRED');
    const q = await queueShipmentLabelPrintInTx(c, actor, h.preview.id, {
      client_key: key('queue'),
      scope_hash: h.preview.scope_hash,
      confirmed: true,
    });
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    // The mode outlives the rule's savepoint: restore it for later effects and orders of this run
    // (stock_location_* guards of 025 must stay deferred). Every deferrable constraint here is
    // INITIALLY DEFERRED, so this is the transaction's default mode.
    await c.query('SET CONSTRAINTS ALL DEFERRED');
    return q.reused
      ? result('print_label', false, `Etykieta ${s.tracking_number} jest już w kolejce druku z tego wykonania`)
      : result('print_label', true, `Zlecono druk etykiety ${s.tracking_number} na drukarce „${pr.name}” (kopie: ${p.copies})`);
  } catch (e) {
    throw printProblem(e);
  }
}

export const effects: EffectModule = {
  handlers: {
    create_shipment: {
      schema: createShipment,
      validate: async (c, p: CreateShipment) => {
        if (p.carrier === 'demo') return;
        const ch = await carrierChannel(c, p.carrier, p.channel_id!);
        if (p.carrier === 'inpost')
          ensure(/^[1-9]\d{0,17}$/.test(String(ch.settings?.organization_id ?? '')), 422, 'Połączenie InPost nie ma numeru organizacji ShipX');
        if (p.carrier === 'dpd')
          ensure(/^[1-9]\d{0,9}$/.test(String(ch.settings?.master_fid ?? '')), 422, 'Połączenie DPD nie ma numeru Master FID');
        assertProductionConsent(ch, p);
      },
      describe: (p: CreateShipment, names) => {
        if (p.carrier === 'demo') return 'Utworzy i wyda przesyłkę DEMO (zamówienie spakowane)';
        const via = names[p.channel_id!] ? ` połączeniem ${names[p.channel_id!]}` : '';
        const buy = p.buy_without_confirmation ? '; na połączeniu produkcyjnym kupi etykietę bez potwierdzenia' : '';
        return p.carrier === 'inpost'
          ? `Zleci etykietę InPost do paczkomatu z zamówienia (gabaryt ${TEMPLATE[p.template ?? 'small']}, ${p.weight ?? 1} kg)${via}${buy}`
          : `Zleci etykietę DPD (${p.weight ?? 1} kg, ${p.length ?? 20}×${p.width ?? 20}×${p.height ?? 20} cm)${via}${buy}`;
      },
      apply: (env, p: CreateShipment) => applyCreateShipment(env, p),
    },
    print_label: {
      schema: printLabel,
      validate: async (c, p: PrintLabel) => {
        const pr = await printer(c, p.printer_id);
        ensure(pr.enabled && pr.station_enabled, 422, `Drukarka „${pr.name}” lub jej stanowisko jest nieaktywne`);
      },
      describe: (p: PrintLabel, names) =>
        `Wydrukuje etykietę przesyłki na drukarce ${names[p.printer_id] ?? p.printer_id}${p.copies > 1 ? ` (kopie: ${p.copies})` : ''}`,
      apply: (env, p: PrintLabel) => applyPrintLabel(env, p),
    },
  },
  catalogParams: async (c) => {
    const channels = (
      await c.query("SELECT id,name,provider,mode,settings->>'simulation' AS simulation FROM channels WHERE provider IN ('inpost','dpd') ORDER BY name,id")
    ).rows;
    const printers = (await printTablesReady(c))
      ? (
          await c.query(
            'SELECT p.id,p.name,s.label FROM print_printers p JOIN packing_stations s ON (s.tenant_id,s.id)=(p.tenant_id,p.station_id) WHERE p.enabled AND s.enabled ORDER BY p.name,p.id LIMIT 100',
          )
        ).rows
      : [];
    const mode = (ch: any) => (ch.simulation === 'true' ? 'symulacja' : ch.mode === 'sandbox' ? 'sandbox' : 'produkcja');
    return {
      create_shipment: [
        {
          key: 'carrier',
          label: 'Przewoźnik',
          kind: 'select',
          options: [
            { value: 'demo', label: 'DEMO (bez przewoźnika)' },
            { value: 'inpost', label: 'InPost — paczkomat' },
            { value: 'dpd', label: 'DPD' },
          ],
          required: true,
        },
        {
          key: 'channel_id',
          label: 'Połączenie przewoźnika (InPost/DPD)',
          kind: 'select',
          options: channels.map((ch) => ({ value: ch.id, label: `${CARRIER[ch.provider as 'inpost' | 'dpd']} · ${ch.name} · ${mode(ch)}` })),
        },
        {
          key: 'template',
          label: 'Gabaryt paczkomatu InPost (domyślnie A)',
          kind: 'select',
          options: Object.entries(TEMPLATE).map(([value, label]) => ({ value, label })),
        },
        { key: 'weight', label: 'Waga paczki w kg (domyślnie 1)', kind: 'number' },
        { key: 'length', label: 'Długość paczki DPD w cm (domyślnie 20)', kind: 'number' },
        { key: 'width', label: 'Szerokość paczki DPD w cm (domyślnie 20)', kind: 'number' },
        { key: 'height', label: 'Wysokość paczki DPD w cm (domyślnie 20)', kind: 'number' },
        { key: 'buy_without_confirmation', label: 'Kupuj etykiety bez potwierdzenia (połączenie produkcyjne)', kind: 'bool' },
      ],
      print_label: [
        {
          key: 'printer_id',
          label: 'Drukarka',
          kind: 'select',
          options: printers.map((p) => ({ value: p.id, label: `${p.name} · ${p.label}` })),
          required: true,
        },
        { key: 'copies', label: 'Liczba kopii (domyślnie 1)', kind: 'number' },
      ],
    };
  },
};
