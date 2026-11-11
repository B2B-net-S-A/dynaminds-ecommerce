import { z } from 'zod';
import { ensure } from './errors';

export const parcelReturnOrigins = z.array(z.strictObject({
  item_id: z.uuid().transform(v => v.toLowerCase()),
  dispatch_id: z.uuid().transform(v => v.toLowerCase()),
  quantity: z.number().int().min(1).max(100000),
})).min(1).max(500).refine(rows => new Set(rows.map(r => r.item_id + ':' + r.dispatch_id)).size === rows.length, 'Powtórzone źródło zwrotu');

export type ParcelReturnClaim = { origin_id: string; item_id: string; dispatch_id: string; quantity: number; components: { product_id: string; quantity: number }[]; fragments: { fragment_id: string; product_id: string; available: number }[] };
export type ParcelReturnDecision = { origin_id: string; item_id: string; dispatch_id: string; requested: number; accepted: number; restocked: number };
export type ParcelReturnFragment = { origin_id: string; fragment_id: string; product_id: string; quantity: number };

/** Receipt quantities use the immutable request order, never SKU or current product recipes. */
export function decideParcelReturnClaims(claims: ParcelReturnClaim[], items: { item_id: string; accepted: number; restocked: number }[]): ParcelReturnDecision[] {
  ensure(new Set(items.map(i => i.item_id)).size === items.length, 422, 'Powtórzona pozycja przyjęcia');
  ensure(new Set(claims.map(c => c.item_id + ':' + c.dispatch_id)).size === claims.length, 409, 'Powtórzone pochodzenie zgłoszenia');
  const left = new Map(items.map(i => {
    ensure(Number.isSafeInteger(i.accepted) && Number.isSafeInteger(i.restocked) && i.restocked >= 0 && i.accepted >= i.restocked, 422, 'Nieprawidłowa ilość przyjęcia');
    return [i.item_id, { accepted: i.accepted, restocked: i.restocked }];
  }));
  ensure(new Set(claims.map(c => c.item_id)).size === left.size && claims.every(c => left.has(c.item_id)), 422, 'Rozpatrz dokładnie zgłoszone pozycje');
  const decisions = claims.map(c => {
    ensure(Number.isSafeInteger(c.quantity) && c.quantity > 0, 409, 'Nieprawidłowa ilość źródła');
    const l = left.get(c.item_id)!;
    const accepted = Math.min(c.quantity, l.accepted), restocked = Math.min(accepted, l.restocked);
    l.accepted -= accepted; l.restocked -= restocked;
    return { origin_id: c.origin_id, item_id: c.item_id, dispatch_id: c.dispatch_id, requested: c.quantity, accepted, restocked };
  });
  ensure([...left.values()].every(i => i.accepted === 0 && i.restocked === 0), 409, 'Przyjęcie przekracza wydane źródła');
  return decisions;
}

/** Exact capacitated matching avoids greedy theft of a fragment shared by two sales lines. */
export function allocateParcelReturnFragments(claims: ParcelReturnClaim[], decisions: ParcelReturnDecision[], picks: { issue_fragment_id: string; quantity: number }[]): ParcelReturnFragment[] {
  ensure(new Set(picks.map(p => p.issue_fragment_id)).size === picks.length, 422, 'Powtórzony fragment zwrotu');
  ensure(picks.every(p => Number.isSafeInteger(p.quantity) && p.quantity > 0), 422, 'Nieprawidłowa ilość fragmentu');
  const result: ParcelReturnFragment[] = [];
  const products = new Set(claims.flatMap(c => c.components.map(p => p.product_id)));
  const known = new Map<string, string>();
  for (const claim of claims) for (const f of claim.fragments) {
    ensure(!known.has(f.fragment_id) || known.get(f.fragment_id) === f.product_id, 409, 'Niejednoznaczny produkt fragmentu');
    known.set(f.fragment_id, f.product_id);
  }
  ensure(picks.every(p => known.has(p.issue_fragment_id)), 409, 'Fragment nie pochodzi z wybranego wydania');
  for (const product_id of [...products].sort()) {
    const needs = claims.map(c => {
      const decision = decisions.find(d => d.origin_id === c.origin_id);
      ensure(decision, 409, 'Brak decyzji dla źródła');
      const recipe = c.components.filter(p => p.product_id === product_id).reduce((n, p) => n + p.quantity, 0);
      const quantity = decision.restocked * recipe;
      ensure(Number.isSafeInteger(quantity) && quantity >= 0 && quantity <= 10000000, 422, 'Za duża ilość składnika');
      return { claim: c, quantity };
    }).filter(n => n.quantity > 0);
    const selected = picks.filter(p => known.get(p.issue_fragment_id) === product_id).sort((a, b) => a.issue_fragment_id.localeCompare(b.issue_fragment_id));
    const required = needs.reduce((n, c) => n + c.quantity, 0);
    ensure(selected.reduce((n, p) => n + p.quantity, 0) === required, 422, 'Fragmenty muszą pokrywać całe jednostki wybranego źródła');
    const sink = 1 + needs.length + selected.length, size = sink + 1;
    const capacity = Array.from({ length: size }, () => Array<number>(size).fill(0));
    for (let i = 0; i < needs.length; i++) {
      capacity[0][1 + i] = needs[i].quantity;
      for (let j = 0; j < selected.length; j++) {
        const available = needs[i].claim.fragments.filter(f => f.fragment_id === selected[j].issue_fragment_id && f.product_id === product_id).reduce((n, f) => n + f.available, 0);
        ensure(Number.isSafeInteger(available) && available >= 0, 409, 'Nieprawidłowa zdolność fragmentu');
        capacity[1 + i][1 + needs.length + j] = Math.min(available, required);
      }
    }
    for (let j = 0; j < selected.length; j++) capacity[1 + needs.length + j][sink] = selected[j].quantity;
    const residual = capacity.map(row => [...row]);
    let flow = 0;
    while (flow < required) {
      const parent = Array<number>(size).fill(-1), queue = [0]; parent[0] = 0;
      for (let q = 0; q < queue.length && parent[sink] < 0; q++) for (let next = 1; next < size; next++) {
        if (parent[next] < 0 && residual[queue[q]][next] > 0) { parent[next] = queue[q]; queue.push(next); }
      }
      ensure(parent[sink] >= 0, 409, 'Wybrane partie nie pokrywają pochodzenia każdej pozycji');
      let amount = required - flow;
      for (let n = sink; n !== 0; n = parent[n]) amount = Math.min(amount, residual[parent[n]][n]);
      for (let n = sink; n !== 0; n = parent[n]) { residual[parent[n]][n] -= amount; residual[n][parent[n]] += amount; }
      flow += amount;
    }
    for (let i = 0; i < needs.length; i++) for (let j = 0; j < selected.length; j++) {
      const from = 1 + i, to = 1 + needs.length + j, quantity = capacity[from][to] - residual[from][to];
      if (quantity > 0) result.push({ origin_id: needs[i].claim.origin_id, fragment_id: selected[j].issue_fragment_id, product_id, quantity });
    }
  }
  return result;
}
