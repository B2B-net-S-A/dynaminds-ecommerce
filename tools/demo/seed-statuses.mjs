// Custom statuses of the demo company (Uwagi v3 §0 "Statusy"): the five Sellasist categories, two-level names nested in
// the order panel ("Pakowanie / Do zebrania DPD"), colours from the meaning palette and the red "Problem". A few orders
// are put into them so the panel shows counts. Ordinary HTTP routes only; fictional data.

/** name, stage (fulfilment axis), category (shared/order-categories.ts), colour (web/order-stage.ts palette). */
export const DEMO_CUSTOM_STATUSES = [
  { name: 'Problem', stage: 'paid', category: 'not_completed', color: '#D23B3B', assign: { status: 'paid', count: 1 } },
  { name: 'Pakowanie / Do zebrania DPD', stage: 'packed', category: 'in_progress', color: '#E0661B', assign: { status: 'packed', count: 1 } },
  { name: 'Pakowanie / Do zebrania InPost', stage: 'packed', category: 'in_progress', color: '#D98C00' },
  { name: 'Wysyłka dok / Wysłane-Allegro', stage: 'shipped', category: 'completed', color: '#0F8B8D' },
];

/** Creates the statuses (skips names that exist) and assigns sample orders; returns the created names. */
export async function seedCustomStatuses(client) {
  const existing = new Set(((await client.get('/api/workflow-statuses')).data ?? []).map((s) => s.name));
  const created = [];
  for (const d of DEMO_CUSTOM_STATUSES) {
    if (existing.has(d.name)) continue;
    const s = await client.post('/api/workflow-statuses', { name: d.name, stage: d.stage, color: d.color, active: true, category: d.category }, [200, 201]);
    created.push(d.name);
    if (!d.assign) continue;
    const orders = (await client.get(`/api/orders?status=${d.assign.status}&limit=${d.assign.count}`)).data ?? [];
    for (const o of orders.slice(0, d.assign.count))
      await client.post(`/api/orders/${o.id}/operations`, { type: 'set_workflow', status_id: s.id }, [200, 201]);
  }
  return created;
}
