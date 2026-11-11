import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveReturnDestinationPlan as derive, type ReturnDestinationDraft as Draft,
  type ReturnDestinationSource as Source } from '../server/return-destinations-plan';

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const [order, rma, itemA, itemB, productA, productB, sale, custody, saleStatus, custodyStatus, rejectStatus,
  fragmentA, fragmentB, partA, partC, partR, partB] = Array.from({ length: 17 }, (_, i) => id(i + 1));
function fixture(on = false): { source: Source; draft: Draft } {
  const source: Source = { order_id: order, return_id: rma, currency: 'PLN', requested_shipping_refund: 80,
    lines: [{ item_id: itemA, ordinal: 0, ordered_quantity: 3, requested: 3, prior_accepted: 0,
      scanned_quantity: 2, line_total_minor: 1001, components: [{ product_id: productA, quantity: 1 },
        { product_id: productB, quantity: 2 }] },
    { item_id: itemB, ordinal: 1, ordered_quantity: 1, requested: 1, prior_accepted: 0,
      scanned_quantity: 1, line_total_minor: 401, components: [{ product_id: productA, quantity: 1 }] }],
    statuses: [{ status_id: saleStatus, version: '1', revision_id: id(100), active: true,
      name: 'Sprzedaż', color: '#224488', decision: 'accept', inventory_effect: 'sale',
      warehouse_id: sale, warehouse_policy_version: '0', default_location: 'RET' },
    { status_id: custodyStatus, version: '2', revision_id: id(101), active: true,
      name: 'Kontrola', color: '#884422', decision: 'accept', inventory_effect: 'custody',
      warehouse_id: custody, warehouse_policy_version: '1', default_location: 'QC' },
    { status_id: rejectStatus, version: '1', revision_id: id(102), active: true,
      name: 'Odrzucony', color: '#444444', decision: 'reject', inventory_effect: 'none',
      warehouse_id: null, warehouse_policy_version: null, default_location: null }],
    warehouse_policies: [{ warehouse_id: sale, usage: 'sale', enabled: true, version: '0' },
      { warehouse_id: custody, usage: 'custody', enabled: true, version: '1' }],
    catalog_assignments: [productA, productB].map(product_id => ({ product_id, warehouse_ids: [sale, custody] })),
    stocks: [{ warehouse_id: sale, product_id: productA, exists: true, version: '3', on_hand: 5, reserved: 1 },
      { warehouse_id: sale, product_id: productB, exists: false, version: '0', on_hand: 0, reserved: 0 },
      ...[productA, productB].map(product_id => ({ warehouse_id: custody, product_id,
        exists: false, version: '0', on_hand: 0, reserved: 0 }))],
    wms: { enabled: on, policy_version: on ? '1' : '0', issue_fragments: on ? [
      { id: fragmentA, product_id: productA, layer_id: id(200), order_id: order,
        eligible_item_ids: [itemA, itemB], quantity: 3, returned_quantity: 0,
        unit_cost_minor: '0', currency: 'PLN' },
      { id: fragmentB, product_id: productB, layer_id: id(201), order_id: order,
        eligible_item_ids: [itemA], quantity: 4, returned_quantity: 0,
        unit_cost_minor: null, currency: 'PLN' }] : [] },
  };
  const parts = [{ part_id: partA, item_id: itemA, quantity: 1, status_id: saleStatus, status_version: '1' },
    { part_id: partC, item_id: itemA, quantity: 1, status_id: custodyStatus, status_version: '2' },
    { part_id: partR, item_id: itemA, quantity: 1, status_id: rejectStatus, status_version: '1' },
    { part_id: partB, item_id: itemB, quantity: 1, status_id: saleStatus, status_version: '1' }];
  const draft: Draft = { protocol: 'destinations_v1', parts, shipping_refund: 70,
    locations: [{ part_id: partA, product_id: productA, location: 'RET-A', confirmed: true },
      { part_id: partA, product_id: productB, location: 'RET-B', confirmed: true },
      { part_id: partC, product_id: productA, location: 'QC-A', confirmed: true },
      { part_id: partC, product_id: productB, location: 'QC-B', confirmed: true },
      { part_id: partB, product_id: productA, location: 'RET-A', confirmed: true }],
    stock_versions: source.stocks.map(({ warehouse_id, product_id, version }) => ({ warehouse_id, product_id, version })),
    ...(on ? { wms_lots: { policy_version: '1', picks: [
      { part_id: partA, issue_fragment_id: fragmentA, quantity: 1, location: 'RET-A' },
      { part_id: partC, issue_fragment_id: fragmentA, quantity: 1, location: 'QC-A' },
      { part_id: partB, issue_fragment_id: fragmentA, quantity: 1, location: 'RET-A' },
      { part_id: partA, issue_fragment_id: fragmentB, quantity: 2, location: 'RET-B' },
      { part_id: partC, issue_fragment_id: fragmentB, quantity: 2, location: 'QC-B' },
    ] } } : {}) };
  return { source, draft };
}
for (const on of [false, true]) test(`${on ? 'ON' : 'OFF'} bundle and shared component: two real destinations, one commercial credit, exact pennies`, () => {
  const f = fixture(on), before = structuredClone(f), p = derive(f.source, f.draft);
  assert.deepEqual(f, before, 'planner never mutates source/draft');
  assert.deepEqual(p.summary, { accepted: 3, restocked_to_sale: 2, received_into_custody: 1,
    rejected: 1, commercial_credit_minor: 1138, shipping_refund_minor: 70 });
  assert.deepEqual(p.parts.map(p => p.refund_minor), [333, 334, 0, 401]);
  assert.equal(p.decisions[0].refund_minor, 667);
  assert.deepEqual(p.arrivals.map(a => [a.part_id, a.product_id, a.warehouse_id, a.quantity]), [
    [partA, productA, sale, 1], [partA, productB, sale, 2],
    [partC, productA, custody, 1], [partC, productB, custody, 2], [partB, productA, sale, 1] ]);
  assert.equal(p.stock_effects.length, 4);
  const physicalA = p.stock_effects.filter(e => e.product_id === productA);
  assert.equal(physicalA.reduce((n, c) => n + c.quantity, 0), 3);
  for (const c of p.stock_effects) {
    assert.equal(c.after.reserved, c.before.reserved);
    assert.equal(c.after.on_hand, c.before.on_hand + c.quantity);
    if (c.effect === 'custody') assert.equal(c.after.sellable_available, 0);
  }
  if (on) {
    const zero = p.private_fragment_effects.filter(e => e.issue_fragment_id === fragmentA);
    assert.equal(zero.length, 3); assert(zero.every(e => e.value_minor === '0' && e.unknown_quantity === 0));
    const unknown = p.private_fragment_effects.filter(e => e.issue_fragment_id === fragmentB);
    assert(unknown.every(e => e.value_minor === null && e.unknown_quantity === 2));
    assert.equal(new Set(zero.map(e => e.layer_id)).size, 1);
  } else assert.deepEqual(p.private_fragment_effects, []);
  f.draft.parts.reverse(); f.draft.locations.reverse(); f.draft.stock_versions.reverse();
  f.draft.wms_lots?.picks.reverse(); f.source.lines.reverse(); f.source.stocks.reverse();
  assert.deepEqual(derive(f.source, f.draft), p, 'canonical parts retain penny allocation across request reordering');
  f.source.statuses[0].name = 'Later edit';
  assert.equal(p.parts[0].status.name, 'Sprzedaż', 'saved snapshot is independent');
});

test('default OFF WMS version0 and saved disabled version both retain physical arrivals without WMS fragments', () => {
  const f = fixture(false), p = derive(f.source, f.draft);
  assert.equal(f.source.wms.policy_version, '0');
  assert.equal(p.arrivals.length, 5);
  assert.equal(p.summary.received_into_custody, 1);
  assert.deepEqual(p.private_fragment_effects, []);
  f.source.wms.policy_version = '7';
  assert.deepEqual(derive(f.source, f.draft), p);
});

test('active WMS cannot manufacture an unversioned default policy, including an all-rejected case', () => {
  const f = fixture(true);
  f.source.wms.policy_version = '0';
  f.draft.parts = f.source.lines.map((l, i) => ({ part_id: id(900 + i), item_id: l.item_id,
    quantity: l.requested, status_id: rejectStatus, status_version: '1' }));
  f.draft.locations = []; f.draft.stock_versions = []; delete f.draft.wms_lots;
  assert.throws(() => derive(f.source, f.draft));
});

test('OFF WMS version0 never admits a caller-created lot picker version0 or positive', () => {
  const off = fixture(false), on = fixture(true);
  off.draft.wms_lots = on.draft.wms_lots;
  assert.throws(() => derive(off.source, off.draft));
  off.draft.wms_lots!.policy_version = '0';
  assert.throws(() => derive(off.source, off.draft));
});

for (const on of [false, true]) test(`${on ? 'ON' : 'OFF'} all rejected parts create no credit or physical effect, including shipping`, () => {
  const f = fixture(on);
  f.draft.parts = f.source.lines.map((l, i) => ({ part_id: id(950 + i), item_id: l.item_id,
    quantity: l.requested, status_id: rejectStatus, status_version: '1' }));
  f.draft.locations = []; f.draft.stock_versions = []; f.source.stocks = [];
  delete f.draft.wms_lots; f.draft.shipping_refund = 0;
  const p = derive(f.source, f.draft);
  assert.deepEqual(p.arrivals, []); assert.deepEqual(p.stock_effects, []);
  assert.deepEqual(p.private_fragment_effects, []);
  assert.equal(p.summary.accepted, 0); assert.equal(p.summary.rejected, 4);
  assert.equal(p.summary.commercial_credit_minor, 0);
  f.draft.shipping_refund = 1;
  assert.throws(() => derive(f.source, f.draft), (e: any) => e.status === 422);
});

const cases: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ['nondecimal status version', f => { f.draft.parts[0].status_version = 'invalid'; }],
  ['missing commercial part', f => { f.draft.parts.pop(); }],
  ['excess commercial quantity', f => { f.draft.parts[0].quantity++; }],
  ['duplicate part identity', f => { f.draft.parts[1].part_id = partA; }],
  ['other item identity', f => { f.draft.parts[0].item_id = id(999); }],
  ['stale status revision', f => { f.draft.parts[1].status_version = '1'; }],
  ['inactive status', f => { f.source.statuses[1].active = false; }],
  ['stale custody policy', f => { f.source.warehouse_policies[1].version = '2'; }],
  ['wrong sale/custody policy', f => { f.source.warehouse_policies[1].usage = 'sale'; }],
  ['disabled target', f => { f.source.warehouse_policies[1].enabled = false; }],
  ['catalog warehouse mismatch', f => { f.source.catalog_assignments[0].warehouse_ids = [sale]; }],
  ['missing location', f => { f.draft.locations.pop(); }],
  ['location for rejected goods', f => { f.draft.locations.push({ part_id: partR, product_id: productA, location: 'QC', confirmed: true }); }],
  ['unconfirmed location', f => { (f.draft.locations[0] as any).confirmed = false; }],
  ['stale one stock pair', f => { f.draft.stock_versions[2].version = '1'; }],
  ['missing one stock pair', f => { f.draft.stock_versions.pop(); }],
  ['extra stock pair', f => { f.draft.stock_versions.push({ warehouse_id: id(999), product_id: productA, version: '0' }); }],
  ['fake absent stock', f => { f.source.stocks[2].on_hand = 1; }],
  ['stock overflow', f => { f.source.stocks[0].on_hand = 2147483647; }],
  ['custody sale reservation', f => { Object.assign(f.source.stocks[2], { exists: true, version: '1', on_hand: 1, reserved: 1 }); f.draft.stock_versions[2].version = '1'; }],
  ['accepted exceeds scanned', f => { f.source.lines[0].scanned_quantity = 1; }],
  ['accepted elsewhere', f => { f.source.lines[0].prior_accepted = 2; }],
  ['shipping excess', f => { f.draft.shipping_refund = 81; }],
  ['reject with warehouse', f => { f.source.statuses[2].warehouse_id = custody; }],
  ['zero part quantity', f => { f.draft.parts[0].quantity = 0; }],
];
for (const [label, corrupt] of cases) test(`whole plan refuses ${label}`, () => {
  const f = fixture(); corrupt(f); const before = structuredClone(f);
  assert.throws(() => derive(f.source, f.draft)); assert.deepEqual(f, before);
});
const wmsCases: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ['aggregate shared fragment capacity', f => { f.source.wms.issue_fragments[0].returned_quantity = 1; }],
  ['missing custody fragment', f => { f.draft.wms_lots!.picks.splice(1, 1); }],
  ['duplicate tuple', f => { f.draft.wms_lots!.picks.push({ ...f.draft.wms_lots!.picks[0] }); }],
  ['same-SKU wrong item origin', f => { f.source.wms.issue_fragments[0].eligible_item_ids = [itemA]; }],
  ['foreign order', f => { f.source.wms.issue_fragments[0].order_id = id(999); }],
  ['foreign currency', f => { f.source.wms.issue_fragments[0].currency = 'EUR'; }],
  ['wrong location', f => { f.draft.wms_lots!.picks[0].location = 'QC-A'; }],
  ['stale WMS policy', f => { f.draft.wms_lots!.policy_version = '2'; }],
  ['WMS disabled after preview', f => { f.source.wms.enabled = false; }],
];
for (const [label, corrupt] of wmsCases) test(`WMS whole plan refuses ${label}`, () => {
  const f = fixture(true); corrupt(f); assert.throws(() => derive(f.source, f.draft));
});
test('positive cost stays exact bigint with original layer; NULL is never manufactured from a price', () => {
  const f = fixture(true); f.source.wms.issue_fragments[0].unit_cost_minor = '123456789012345';
  const p = derive(f.source, f.draft);
  assert.deepEqual(p.private_fragment_effects.filter(e => e.issue_fragment_id === fragmentA).map(e => e.value_minor),
    ['123456789012345', '123456789012345', '123456789012345']);
  assert(p.private_fragment_effects.filter(e => e.issue_fragment_id === fragmentB).every(e => e.value_minor === null));
});
test('prior cumulative accepted preserves remainder cents once across parts', () => {
  const f = fixture(); f.source.lines[0].ordered_quantity = 4; f.source.lines[0].prior_accepted = 1;
  const p = derive(f.source, f.draft);
  assert.equal(p.decisions[0].refund_minor, 500);
  assert.equal(p.parts[0].refund_minor + p.parts[1].refund_minor, 500);
});
test('precreated empty stock version0 is distinct from an absent stock row', () => {
  const f = fixture();
  f.source.stocks[2].exists = true;
  const p = derive(f.source, f.draft);
  const target = p.stock_effects.find(s => s.warehouse_id === custody && s.product_id === productA);
  assert.equal(target?.before.exists, true);
  assert.equal(target?.before.version, '0');
  assert.equal(target?.after.on_hand, 1);
});
