/** Business intent only; no identity credentials or customer data are persisted. */
export type MergeIntent = {schema: 'order-merge-custody/v1'; actor: string; kind: 'preview' | 'execute'; serialized: string; sourceIds: string[]};
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const need = (v: unknown) => {if (!v) throw Error('Nie można potwierdzić zachowanej próby łączenia. Nowe zapisy są zablokowane.');};
const exact = (v: any, keys: string[]) => need(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join('|') === keys.sort().join('|'));
export function mergeActor(context: string) {const [tenant, user] = context.split(':'); need(uuid(tenant) && uuid(user)); return tenant + ':' + user;}
export const mergeIntentKey = (actor: string) => 'dyna:order-merge-custody:v1:' + mergeActor(actor);
/** Serializes cooperating tabs of this release. No fallback, queued click or automatic retry. */
export async function withMergeCustodyLock<T>(actor: string, run: () => Promise<T>, locks: Pick<LockManager, 'request'> | undefined = globalThis.navigator?.locks): Promise<T> {
  need(locks && typeof locks.request === 'function');
  return locks!.request(mergeIntentKey(actor) + ':exclusive', {mode: 'exclusive', ifAvailable: true}, async lock => {
    if (!lock) throw Error('Inna karta rozlicza próbę łączenia. Nie wysłano nowej operacji.');
    return run();
  });
}
export function validateMergeIntent(value: unknown, actor: string): MergeIntent {
  const v: any = value; exact(v, ['schema','actor','kind','serialized','sourceIds']);
  need(v.schema === 'order-merge-custody/v1' && v.actor === mergeActor(actor) && ['preview','execute'].includes(v.kind));
  need(typeof v.serialized === 'string' && new TextEncoder().encode(v.serialized).length <= 65536);
  need(Array.isArray(v.sourceIds) && v.sourceIds.length >= 2 && v.sourceIds.length <= 100 && v.sourceIds.every(uuid) && new Set(v.sourceIds).size === v.sourceIds.length);
  const b = JSON.parse(v.serialized);
  if (v.kind === 'preview') {
    exact(b, ['client_key','main_order_id','order_ids_to_merge','merge_mode','sum_delivery_costs']);
    need(uuid(b.main_order_id) && Array.isArray(b.order_ids_to_merge) && b.order_ids_to_merge.every(uuid) && ['technical_merge','into_main_order'].includes(b.merge_mode) && typeof b.sum_delivery_costs === 'boolean');
    need(JSON.stringify([b.main_order_id,...b.order_ids_to_merge].sort()) === JSON.stringify([...v.sourceIds].sort()));
  } else {
    exact(b, ['client_key','preview_id','scope_hash','confirmed', ...(Object.hasOwn(b,'confirmed_receiver_selection') ? ['confirmed_receiver_selection'] : [])]);
    need(uuid(b.preview_id) && typeof b.scope_hash === 'string' && /^[a-f0-9]{64}$/.test(b.scope_hash) && b.confirmed === true && (!Object.hasOwn(b,'confirmed_receiver_selection') || typeof b.confirmed_receiver_selection === 'boolean'));
  }
  need(uuid(b.client_key)); return structuredClone(v);
}
export function readMergeIntent(store: Store, actor: string) {
  const raw = store.getItem(mergeIntentKey(actor)); if (raw === null) return null;
  need(raw.length <= 75000); return validateMergeIntent(JSON.parse(raw), actor);
}
export function retainMergeIntent(store: Store, value: MergeIntent) {
  const v = validateMergeIntent(value, value.actor); need(readMergeIntent(store, v.actor) === null);
  const raw = JSON.stringify(v); store.setItem(mergeIntentKey(v.actor), raw); need(store.getItem(mergeIntentKey(v.actor)) === raw); return v;
}
export function assertHeldMergeIntent(store: Store, v: MergeIntent) {need(JSON.stringify(readMergeIntent(store,v.actor)) === JSON.stringify(v));}
export function clearMergeIntent(store: Store, v: MergeIntent) {assertHeldMergeIntent(store,v); store.removeItem(mergeIntentKey(v.actor)); need(readMergeIntent(store,v.actor) === null);}
const canonical = (v: any): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+canonical(v[k])).join(',') + '}' : JSON.stringify(v);
export function verifyMergeCommand(value: any, intent: MergeIntent) {
  const b = JSON.parse(intent.serialized);
  need(value?.operation === intent.kind && value.client_key === b.client_key && value.actor_id === intent.actor.split(':')[1] && value.api_key_id === null && canonical(value.request) === canonical(b));
  const h = intent.kind === 'preview' ? value.preview : value.execution;
  need(h && uuid(h.id) && uuid(h.target_order_id));
  if (intent.kind === 'execute') need(h.preview_id === b.preview_id && h.scope_hash === b.scope_hash && h.state === 'done');
  else need(h.main_order_id === b.main_order_id && h.merge_mode === b.merge_mode && h.sum_delivery_costs === b.sum_delivery_costs);
  return h as {id: string};
}
