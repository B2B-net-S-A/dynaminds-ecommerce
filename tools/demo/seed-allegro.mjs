// Allegro orders of the demo company (lane L): channel data the automation conditions and the order card read —
// Allegro Smart, a company order with an invoice, allegro.cz, ship-by dates, buyer comments, PayU / Allegro Finanse and a
// cash on delivery parcel locker. Fictional buyers and addresses only (example.com), written through the ordinary HTTP
// routes of a local simulated Allegro channel (stage → map offers → commit): no SQL writes, no provider call.
import { nipFrom, prng } from './lib.mjs';

const zl = (grosze) => (grosze / 100).toFixed(2);
const DAY = 86400000;

/** Fictional Allegro checkout forms; `lines` are [sku, quantity]. */
export function allegroDemoOrders(nowMs) {
  const shipBy = (days) => new Date(Math.floor((nowMs + days * DAY) / DAY) * DAY + 15 * 3600000).toISOString();
  const companyNip = nipFrom(prng(20261110));
  return [
    {
      id: 'ps-alg-0001', login: 'kawosz_marta', name: ['Marta', 'Zielińska'], email: 'marta.zielinska.allegro@example.com',
      address: { street: 'ul. Piotrkowska 120/4', city: 'Łódź', zipCode: '90-006', countryCode: 'PL', phoneNumber: '+48 501 222 333' },
      marketplace: 'allegro-pl', smart: true, payment: { type: 'ONLINE', provider: 'PAYU' },
      method: 'Allegro Paczkomaty InPost', pickupPoint: 'LOD05M', shipBy: shipBy(1),
      messageToSeller: 'Proszę o staranne zapakowanie — to prezent dla taty.', lines: [['PS-KAW-001', 1], ['PS-AKC-004', 1]], cost: 0,
    },
    {
      id: 'ps-alg-0002', login: 'kawiarnia_pod_lipa', name: ['Tomasz', 'Wrona'], email: 'zakupy.podlipa@example.com',
      address: { street: 'ul. Rynek 7', city: 'Sieradz', zipCode: '98-200', countryCode: 'PL', phoneNumber: '+48 602 111 444' },
      marketplace: 'allegro-pl', smart: false, payment: { type: 'ONLINE', provider: 'AF' },
      company: { name: 'Kawiarnia Pod Lipą s.c.', taxId: companyNip },
      method: 'Allegro Kurier DPD', shipBy: shipBy(2),
      messageToSeller: 'Faktura VAT na firmę, dane w formularzu. Dostawa w godzinach 8–14.', lines: [['PS-KAW-002', 4], ['PS-HER-001', 2]], cost: 1499,
    },
    {
      id: 'ps-alg-0003', login: 'pavel_chutna', name: ['Pavel', 'Novák'], email: 'pavel.novak.allegro@example.com',
      address: { street: 'Vinohradská 48', city: 'Praha', zipCode: '120 00', countryCode: 'CZ', phoneNumber: '+420 601 123 456' },
      marketplace: 'allegro-cz', smart: false, payment: { type: 'ONLINE', provider: 'AF_PAYU' },
      method: 'Allegro Kurier DPD', shipBy: shipBy(2),
      messageToSeller: 'Prosím o doručení po 17. hodině.', lines: [['PS-MIO-002', 1], ['PS-PRZ-002', 2]], cost: 2499,
    },
    {
      id: 'ps-alg-0004', login: 'ola_gotuje', name: ['Aleksandra', 'Mazur'], email: 'ola.mazur.allegro@example.com',
      address: { street: 'ul. Narutowicza 33/2', city: 'Łódź', zipCode: '90-135', countryCode: 'PL', phoneNumber: '+48 503 444 555' },
      marketplace: 'allegro-pl', smart: true, payment: { type: 'CASH_ON_DELIVERY' },
      method: 'Allegro Paczkomaty InPost pobranie', pickupPoint: 'LOD12M', shipBy: shipBy(1),
      messageToSeller: 'Odbiorę z paczkomatu w sobotę rano.', lines: [['PS-PRY-001', 2], ['PS-OLI-001', 1]], cost: 0,
    },
  ];
}

/** The Allegro checkout form of one fictional order, priced from the demo catalogue. */
export function allegroCheckoutForm(o, priceOf) {
  const goods = o.lines.reduce((s, [sku, q]) => s + priceOf(sku) * q, 0), total = goods + o.cost;
  return {
    id: o.id,
    revision: 'demo-1',
    status: 'READY_FOR_PROCESSING',
    fulfillment: { status: 'NEW' },
    marketplace: { id: o.marketplace },
    messageToSeller: o.messageToSeller,
    buyer: { email: o.email, login: o.login, firstName: o.name[0], lastName: o.name[1], guest: false, ...(o.company ? { companyName: o.company.name } : {}) },
    payment: { ...o.payment, ...(o.payment.type === 'ONLINE' ? { paidAmount: { amount: zl(total), currency: 'PLN' } } : {}) },
    delivery: {
      address: { firstName: o.name[0], lastName: o.name[1], ...o.address },
      method: { id: 'demo-' + o.method.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: o.method },
      ...(o.pickupPoint ? { pickupPoint: { id: o.pickupPoint, name: 'Paczkomat ' + o.pickupPoint } } : {}),
      cost: { amount: zl(o.cost), currency: 'PLN' },
      smart: o.smart,
      time: { dispatch: { from: new Date(Date.parse(o.shipBy) - DAY).toISOString(), to: o.shipBy } },
    },
    invoice: o.company
      ? { required: true, address: { street: o.address.street, city: o.address.city, zipCode: o.address.zipCode, countryCode: o.address.countryCode, company: o.company } }
      : { required: false },
    summary: { totalToPay: { amount: zl(total), currency: 'PLN' } },
    lineItems: o.lines.map(([sku, q]) => ({
      id: `${o.id}-${sku}`,
      offer: { id: 'ps-oferta-' + sku.toLowerCase(), name: sku, external: { id: sku } },
      quantity: q,
      price: { amount: zl(priceOf(sku)), currency: 'PLN' },
    })),
  };
}

/**
 * Imports the fictional Allegro orders through `client` (an admin of the demo company, tools/demo/lib.mjs Client).
 * `prices` maps the SKU to its price in grosze; the products must exist. Returns the imported order numbers.
 */
export async function seedAllegroOrders(client, { warehouseId, prices, nowMs = Date.now() }) {
  const priceOf = (sku) => {
    if (!prices.has(sku)) throw new Error('demo Allegro: no product ' + sku);
    return prices.get(sku);
  };
  const channelId = (await client.post('/api/integrations/allegro-example', {})).channel_id;
  const orders = allegroDemoOrders(nowMs);
  for (const sku of new Set(orders.flatMap((o) => o.lines.map(([s]) => s))))
    await client.post(`/api/integrations/${channelId}/mappings`, { external_id: 'ps-oferta-' + sku.toLowerCase(), sku });
  const staged = (await client.post(`/api/integrations/${channelId}/stage-orders`, { data: orders.map((o) => allegroCheckoutForm(o, priceOf)) })).data;
  const numbers = [];
  for (const s of staged) {
    if (s.state !== 'staged') throw new Error('demo Allegro: order not ready to import (' + s.state + ')');
    const r = await client.post(`/api/imports/${s.id}/commit`, { warehouse_id: warehouseId });
    numbers.push((r.order ?? r).number);
  }
  return { channel_id: channelId, numbers };
}
