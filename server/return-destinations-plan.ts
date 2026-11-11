/** Pure destinations_v1 conservation. This is a private server-side plan, not
 * an authorization/admission or stock writer. A transaction must rederive it
 * from locked historical RMA/origin/status/resource rows before applying it.
 */
import { z } from 'zod';
import { ensure } from './errors';
import { wmsCostValue, WMS_INT64_MAX } from './wms-lots-values';

const uuid = z.uuid().transform(v => v.toLowerCase());
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(v => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= WMS_INT64_MAX);
const version = decimal.refine(v => v !== '0');
const positive = z.number().int().min(1).max(100000);
const qty = z.number().int().min(0).max(2147483647);
const location = z.string().min(1).max(80).refine(v =>
  v === v.trim() && !/[\u0000-\u001f\u007f\p{Cs}]/u.test(v));
const part = z.strictObject({ part_id: uuid, item_id: uuid, quantity: positive,
  status_id: uuid, status_version: version });
export const returnDestinationDraft = z.strictObject({
  protocol: z.literal('destinations_v1'),
  parts: z.array(part).min(1).max(200),
  locations: z.array(z.strictObject({ part_id: uuid, product_id: uuid,
    location, confirmed: z.literal(true) })).max(500),
  stock_versions: z.array(z.strictObject({ warehouse_id: uuid, product_id: uuid,
    version: decimal })).max(500),
  wms_lots: z.strictObject({ policy_version: version,
    picks: z.array(z.strictObject({ part_id: uuid, issue_fragment_id: uuid,
      quantity: qty.refine(v => v > 0), location })).max(500) }).optional(),
  shipping_refund: z.number().int().min(0).max(1000000),
});
const status = z.strictObject({ status_id: uuid, version, revision_id: uuid,
  active: z.boolean(), name: z.string().min(1).max(120),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  decision: z.enum(['accept', 'reject']), inventory_effect: z.enum(['sale', 'custody', 'none']),
  warehouse_id: uuid.nullable(), warehouse_policy_version: decimal.nullable(),
  default_location: location.nullable() });
const line = z.strictObject({ item_id: uuid, ordinal: z.number().int().min(0).max(99),
  ordered_quantity: positive, requested: positive, prior_accepted: qty,
  scanned_quantity: qty, line_total_minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  // Frozen commercial recipe; current PIM must never supply these coefficients.
  components: z.array(z.strictObject({ product_id: uuid, quantity: positive })).min(1).max(100),
});
const source = z.strictObject({
  order_id: uuid, return_id: uuid, currency: z.string().regex(/^[A-Z]{3}$/),
  requested_shipping_refund: z.number().int().min(0).max(1000000),
  lines: z.array(line).min(1).max(100),
  statuses: z.array(status).min(1).max(200),
  warehouse_policies: z.array(z.strictObject({ warehouse_id: uuid,
    usage: z.enum(['sale', 'custody']), enabled: z.boolean(), version: decimal })).max(100),
  catalog_assignments: z.array(z.strictObject({ product_id: uuid,
    warehouse_ids: z.array(uuid).max(100) })).max(500),
  stocks: z.array(z.strictObject({ warehouse_id: uuid, product_id: uuid,
    exists: z.boolean(), version: decimal, on_hand: qty, reserved: qty })).max(500),
  wms: z.strictObject({ enabled: z.boolean(), policy_version: decimal,
    // Eligibility comes from original line/origin proof, not a SKU join.
    issue_fragments: z.array(z.strictObject({ id: uuid, product_id: uuid, layer_id: uuid,
      order_id: uuid, eligible_item_ids: z.array(uuid).min(1).max(100),
      quantity: qty.refine(v => v > 0), returned_quantity: qty,
      unit_cost_minor: decimal.nullable(), currency: z.string().regex(/^[A-Z]{3}$/),
    })).max(10000) }).refine(w => !w.enabled || w.policy_version !== '0',
    'Aktywna polityka WMS wymaga zapisanej dodatniej wersji'),
});
export type ReturnDestinationDraft = z.infer<typeof returnDestinationDraft>;
export type ReturnDestinationSource = z.infer<typeof source>;
type Arrival = { part_id: string; item_id: string; product_id: string;
  warehouse_id: string; location: string; quantity: number; effect: 'sale' | 'custody' };
const key = (...v: string[]) => v.join('/');
function unique<T>(rows: T[], identity: (row: T) => string, label: string) {
  const m = new Map(rows.map(r => [identity(r), r]));
  ensure(m.size === rows.length, 422, 'Powtórzony zakres: ' + label); return m;
}
function sum(a: number, b: number) {
  const v = a + b; ensure(Number.isSafeInteger(v) && v <= 2147483647, 422,
    'Suma ilości przekracza zakres zapasu'); return v;
}
const allocation = (total: number, quantity: number, prior: number, n: number) =>
  Number(BigInt(total) * BigInt(prior + n) / BigInt(quantity) -
    BigInt(total) * BigInt(prior) / BigInt(quantity));
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export function deriveReturnDestinationPlan(sourceInput: ReturnDestinationSource, draftInput: ReturnDestinationDraft) {
  // Parsing creates independent snapshots; no input object is retained or mutated.
  const s = source.parse(sourceInput), d = returnDestinationDraft.parse(draftInput);
  const lines = unique(s.lines, r => r.item_id, 'pozycje');
  unique(s.lines, r => String(r.ordinal), 'kolejność pozycji');
  const statuses = unique(s.statuses, r => r.status_id, 'statusy');
  const policies = unique(s.warehouse_policies, r => r.warehouse_id, 'magazyny');
  const catalogs = unique(s.catalog_assignments, r => r.product_id, 'przypisania katalogów');
  const stock = unique(s.stocks, r => key(r.warehouse_id, r.product_id), 'zapas');
  const versions = unique(d.stock_versions, r => key(r.warehouse_id, r.product_id), 'wersje zapasu');
  const locations = unique(d.locations, r => key(r.part_id, r.product_id), 'lokalizacje');
  const parts = unique(d.parts, r => r.part_id, 'części');
  ensure(d.shipping_refund <= s.requested_shipping_refund, 422, 'Kwota dostawy przekracza zgłoszenie');
  ensure(d.wms_lots !== undefined ? s.wms.enabled : !s.wms.enabled || d.parts.every(p =>
    statuses.get(p.status_id)?.decision === 'reject'), 409, 'Wybór partii nie odpowiada polityce WMS');
  if (d.wms_lots) ensure(d.wms_lots.policy_version === s.wms.policy_version, 409, 'Polityka WMS zmieniła się');
  for (const p of parts.values()) ensure(lines.has(p.item_id), 422, 'Część nie należy do pozycji tego RMA');

  const arrivals: Arrival[] = [];
  const decisions: { item_id: string; accepted: number; restocked: number; custody: number;
    rejected: number; refund_minor: number }[] = [];
  const frozenParts: { part_id: string; item_id: string; quantity: number;
    status: z.infer<typeof status>; refund_minor: number; components: z.infer<typeof line>['components'] }[] = [];
  for (const l of [...lines.values()].sort((a, b) => a.ordinal - b.ordinal)) {
    ensure(l.requested <= l.ordered_quantity && l.prior_accepted <= l.ordered_quantity &&
      l.scanned_quantity <= l.requested, 422, 'Nieprawidłowa ilość historycznej pozycji');
    const selected = [...parts.values()].filter(p => p.item_id === l.item_id)
      .sort((a, b) => compare(a.part_id, b.part_id));
    ensure(selected.reduce((n, p) => sum(n, p.quantity), 0) === l.requested, 422,
      'Części muszą pokrywać dokładnie zgłoszoną ilość każdej pozycji');
    let accepted = 0, restocked = 0, custody = 0, rejected = 0;
    const recipe = new Map<string, number>();
    for (const c of l.components) recipe.set(c.product_id, sum(recipe.get(c.product_id) ?? 0, c.quantity));
    for (const p of selected) {
      const st = statuses.get(p.status_id);
      ensure(st && st.active && st.version === p.status_version, 409, 'Status pozycji zmienił się');
      const previousAccepted = accepted;
      if (st.decision === 'reject') {
        ensure(st.inventory_effect === 'none' && st.warehouse_id === null &&
          st.warehouse_policy_version === null && st.default_location === null, 422,
        'Odrzucenie nie może przyjmować zapasu');
        rejected = sum(rejected, p.quantity);
      } else {
        ensure(st.inventory_effect !== 'none' && st.warehouse_id && st.warehouse_policy_version !== null,
          422, 'Przyjęcie wymaga rzeczywistego magazynu');
        const policy = policies.get(st.warehouse_id);
        ensure(policy && policy.enabled && policy.version === st.warehouse_policy_version &&
          policy.usage === st.inventory_effect, 409, 'Przeznaczenie magazynu zmieniło się');
        accepted = sum(accepted, p.quantity);
        if (st.inventory_effect === 'sale') restocked = sum(restocked, p.quantity);
        else custody = sum(custody, p.quantity);
        ensure(accepted <= l.scanned_quantity && accepted + l.prior_accepted <= l.ordered_quantity,
          409, 'Przyjęcie przekracza kontrolę lub pozostałą ilość sprzedaży');
        for (const [product, coefficient] of [...recipe].sort(([a], [b]) => compare(a, b))) {
          const loc = locations.get(key(p.part_id, product));
          ensure(loc, 422, 'Potwierdź lokalizację każdego fizycznego składnika');
          const assignment = catalogs.get(product);
          ensure(assignment && new Set(assignment.warehouse_ids).size === assignment.warehouse_ids.length &&
            assignment.warehouse_ids.includes(st.warehouse_id), 409, 'Magazyn nie jest przypisany do katalogu składnika');
          const n = p.quantity * coefficient;
          ensure(Number.isSafeInteger(n) && n <= 10000000, 422, 'Za duża ilość składnika');
          arrivals.push({ part_id: p.part_id, item_id: p.item_id, product_id: product,
            warehouse_id: st.warehouse_id, location: loc.location, quantity: n, effect: st.inventory_effect });
          ensure(arrivals.length <= 500, 413, 'Za dużo fizycznych części zwrotu');
        }
      }
      frozenParts.push({ ...p, status: st, refund_minor: st.decision === 'reject' ? 0 :
        allocation(l.line_total_minor, l.ordered_quantity, l.prior_accepted + previousAccepted, p.quantity),
      components: l.components });
    }
    decisions.push({ item_id: l.item_id, accepted, restocked, custody, rejected,
      refund_minor: allocation(l.line_total_minor, l.ordered_quantity, l.prior_accepted, accepted) });
  }
  ensure(locations.size === arrivals.length && arrivals.every(a => locations.has(key(a.part_id, a.product_id))),
    422, 'Lokalizacje zawierają obcą lub odrzuconą część');

  const cells = new Map<string, { warehouse_id: string; product_id: string; quantity: number; effect: 'sale' | 'custody' }>();
  for (const a of arrivals) {
    const k = key(a.warehouse_id, a.product_id), prior = cells.get(k);
    if (prior) ensure(prior.effect === a.effect, 409, 'Sprzeczne przeznaczenie tego magazynu');
    cells.set(k, { warehouse_id: a.warehouse_id, product_id: a.product_id,
      quantity: sum(prior?.quantity ?? 0, a.quantity), effect: a.effect });
  }
  ensure(versions.size === cells.size && stock.size === cells.size, 422, 'Podaj dokładnie całą unię docelowego zapasu');
  const stockEffects = [...cells].sort(([a], [b]) => compare(a, b)).map(([k, c]) => {
    const old = stock.get(k), cas = versions.get(k);
    ensure(old && cas, 422, 'Brak pary docelowego zapasu');
    ensure(old.reserved <= old.on_hand && (old.exists ||
      old.version === '0' && old.on_hand === 0 && old.reserved === 0), 422, 'Nieprawidłowy snapshot zapasu');
    ensure(cas.version === old.version, 409, 'Zapas zmienił wersję');
    if (c.effect === 'custody') ensure(old.reserved === 0, 409, 'Magazyn kontroli zawiera rezerwację sprzedaży');
    const onHand = sum(old.on_hand, c.quantity);
    return { ...c, before: { exists: old.exists, version: old.version, on_hand: old.on_hand,
      reserved: old.reserved, physical_available: old.on_hand - old.reserved,
      sellable_available: c.effect === 'sale' ? old.on_hand - old.reserved : 0 },
    after: { on_hand: onHand, reserved: old.reserved, physical_available: onHand - old.reserved,
      sellable_available: c.effect === 'sale' ? onHand - old.reserved : 0 } };
  });

  const issue = unique(s.wms.issue_fragments, r => r.id, 'fragmenty pierwotnego wydania');
  const picks = d.wms_lots?.picks ?? [];
  unique(picks, r => key(r.part_id, r.issue_fragment_id, r.location), 'wybór fragmentu');
  const used = new Map<string, number>(), byArrival = new Map<string, number>();
  const fragmentEffects = [...picks].sort((a, b) => compare(key(a.part_id, a.issue_fragment_id, a.location),
    key(b.part_id, b.issue_fragment_id, b.location))).map(p => {
    const f = issue.get(p.issue_fragment_id), partRow = parts.get(p.part_id);
    ensure(f && partRow && f.order_id === s.order_id && f.currency === s.currency &&
      new Set(f.eligible_item_ids).size === f.eligible_item_ids.length &&
      f.eligible_item_ids.includes(partRow.item_id), 422, 'Fragment nie ma pochodzenia z tej pozycji');
    const a = arrivals.find(a => a.part_id === p.part_id && a.product_id === f.product_id && a.location === p.location);
    ensure(a, 422, 'Fragment nie odpowiada przyjmowanej części i lokalizacji');
    const taken = sum(used.get(f.id) ?? 0, p.quantity);
    ensure(f.returned_quantity <= f.quantity && taken <= f.quantity - f.returned_quantity,
      409, 'Przekroczono wspólny pozostały fragment wydania');
    used.set(f.id, taken);
    const ak = key(a.part_id, a.product_id); byArrival.set(ak, sum(byArrival.get(ak) ?? 0, p.quantity));
    const cost = wmsCostValue(p.quantity, f.unit_cost_minor);
    return { ...a, issue_fragment_id: f.id, layer_id: f.layer_id, quantity: p.quantity,
      unit_cost_minor: f.unit_cost_minor, value_minor: f.unit_cost_minor === null ? null : cost.known_minor,
      unknown_quantity: cost.unknown_quantity, currency: f.currency };
  });
  if (s.wms.enabled) ensure(arrivals.every(a => byArrival.get(key(a.part_id, a.product_id)) === a.quantity),
    422, 'Fragmenty muszą pokrywać całe przyjęcie do sprzedaży i kontroli');
  else ensure(picks.length === 0, 422, 'Wyłączony WMS nie może tworzyć znanych warstw');
  ensure(decisions.some(line => line.accepted > 0) || d.shipping_refund === 0,
    422, 'Odrzucenie nie zwraca dostawy');
  const commercialCredit = decisions.reduce((n, d) => n + BigInt(d.refund_minor), BigInt(d.shipping_refund));
  ensure(commercialCredit <= BigInt(Number.MAX_SAFE_INTEGER), 422, 'Kwota kredytu przekracza dokładny zakres');
  return { protocol: 'destinations_v1' as const, order_id: s.order_id, return_id: s.return_id,
    currency: s.currency, parts: frozenParts, decisions, arrivals, stock_effects: stockEffects,
    // Cost-bearing fragmentEffects is PRIVATE. Public UI must project it under existing cost IAM.
    private_fragment_effects: fragmentEffects,
    summary: { accepted: decisions.reduce((n, d) => sum(n, d.accepted), 0),
      restocked_to_sale: decisions.reduce((n, d) => sum(n, d.restocked), 0),
      received_into_custody: decisions.reduce((n, d) => sum(n, d.custody), 0),
      rejected: decisions.reduce((n, d) => sum(n, d.rejected), 0),
      commercial_credit_minor: Number(commercialCredit), shipping_refund_minor: d.shipping_refund } };
}
