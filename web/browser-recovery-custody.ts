/** Local recovery identifiers, never a saved authorization decision or a write payload. */
export type RecoveryRef = {
  actor: string; slot: string; path: string; key: string | null;
  state: 'unknown' | 'ack'; resource: string | null; related: string | null;
  version: string | null; receipt: string | null; hash: string | null;
};
const uuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const version = (s: unknown): s is string => typeof s === 'string' && /^[1-9][0-9]{0,18}$/.test(s) && BigInt(s) <= 9223372036854775807n;
export function recoveryActor(context: string): string {
  const [tenant, user] = context.split(':');
  if (!uuid(tenant) || !uuid(user)) throw Error('Brak dokładnego kontekstu odzyskiwania.');
  return tenant.toLowerCase() + ':' + user.toLowerCase();
}
function valid(r: RecoveryRef) {
  if (!r || Object.keys(r).sort().join(',') !== 'actor,hash,key,path,receipt,related,resource,slot,state,version' ||
      recoveryActor(r.actor) !== r.actor || !/^(print|intent:(create|[0-9a-f-]{36}))$/.test(r.slot) ||
      !/^\/(print-jobs|b2b\/external-order-intents)\/[a-z0-9/-]{1,160}$/.test(r.path) ||
      !['unknown','ack'].includes(r.state) ||
      [r.key,r.resource,r.related,r.receipt].some(v => v !== null && !uuid(v)) ||
      (r.version !== null && !version(r.version)) ||
      (r.hash !== null && !/^[a-f0-9]{64}$/.test(r.hash))) throw Error('Niepełny zapis odzyskiwania. Nowe zapisy są wstrzymane.');
}
export function createRecoveryStore(storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
  const name = (actor: string) => 'dyna:original-recovery:v1:' + recoveryActor(actor);
  function all(actor: string): RecoveryRef[] {
    const raw = storage().getItem(name(actor));
    if (raw === null) return [];
    if (raw.length > 65536) throw Error('Przekroczony zakres odzyskiwania.');
    const rows: RecoveryRef[] = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > 64) throw Error('Niepełny zapis odzyskiwania.');
    const slots = new Set<string>();
    for (const r of rows) { valid(r); if (r.actor !== actor || slots.has(r.slot)) throw Error('Obcy lub powtórzony zapis odzyskiwania.'); slots.add(r.slot); }
    return rows;
  }
  function commit(actor: string, rows: RecoveryRef[]) {
    const key = name(actor), text = JSON.stringify(rows);
    // Empty records also use setItem/readback: failure must not masquerade as successful deletion.
    storage().setItem(key, text);
    if (storage().getItem(key) !== text) throw Error('Nie potwierdzono zachowania oryginalnej próby. Zapis nie został wysłany.');
  }
  return {
    get(actor: string, slot: string) { return all(actor).find(r => r.slot === slot) ?? null; },
    put(r: RecoveryRef) { valid(r); const rows = all(r.actor); const old = rows.find(x => x.slot === r.slot);
      if (old && (old.path !== r.path || old.key !== r.key)) throw Error('Najpierw rozstrzygnij oryginalną próbę.');
      const next = rows.filter(x => x.slot !== r.slot); next.push(structuredClone(r));
      if (next.length > 64) throw Error('Przekroczony zakres odzyskiwania.'); commit(r.actor, next); },
    clear(expected: RecoveryRef) { const current = all(expected.actor).find(r => r.slot === expected.slot);
      if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw Error('Próba odzyskiwania zmieniła się.');
      commit(expected.actor, all(expected.actor).filter(r => r.slot !== expected.slot)); },
  };
}
export const browserRecovery = createRecoveryStore(() => window.localStorage);
export function recoveryRef(context: string, slot: string, path: string, body: string): RecoveryRef {
  const input = JSON.parse(body);
  const r: RecoveryRef = { actor: recoveryActor(context), slot, path, key: uuid(input.client_key) ? input.client_key : null,
    state: 'unknown', resource: null, related: null, version: null, receipt: null, hash: null };
  valid(r); return r;
}
export function confirmedRecovery(r: RecoveryRef, id: string, v: string, related: string | null = null, receipt: string | null = null, hash: string | null = null): RecoveryRef {
  const next: RecoveryRef = { ...r, state: 'ack', resource: id, version: v, related, receipt, hash }; valid(next); return next;
}
export function matchesRecovery(r: RecoveryRef, id: string, v: string, related: string | null, receipts: string[], hash: string | null = null): boolean {
  return r.state === 'ack' && r.resource === id && version(v) && r.version !== null && BigInt(v) >= BigInt(r.version) &&
    r.related === related && (r.receipt === null || receipts.includes(r.receipt)) && r.hash === hash;
}

export type OriginalKeyProof = {
  client_key: string; operation: string; resource_kind: 'job'|'printer'|'external_order';
  resource_id: string; related_id: string|null; receipt_id: string; version: string;
  receipt_version: string; content_sha256: string|null; state: string|null;
};
/** Derive only supported original endpoint semantics; no guessed ID or new key. */
export function originalKeyLocation(r: RecoveryRef) {
  valid(r);
  if (!r.key) throw Error('Brak zachowanego oryginalnego klucza. Nie ponawiaj zapisu.');
  const id = '([0-9a-f-]{36})';
  let operation: string, kind: OriginalKeyProof['resource_kind'], entity: string|null = null, root: string;
  if (r.path === '/print-jobs/jobs') { operation='job_create';kind='job';root='/print-jobs'; }
  else if (r.path === '/print-jobs/printers') { operation='printer_create';kind='printer';root='/print-jobs'; }
  else if (new RegExp('^/print-jobs/printers/'+id+'$').test(r.path)) { entity=r.path.split('/').at(-1)!;operation='printer_update';kind='printer';root='/print-jobs'; }
  else if (new RegExp('^/print-jobs/jobs/'+id+'/(reconcile|claim|ack)$').test(r.path)) { entity=r.path.split('/')[3];operation=r.path.split('/')[4];kind='job';root='/print-jobs'; }
  else if (r.path === '/b2b/external-order-intents/orders') {operation='create';kind='external_order';root='/b2b/external-order-intents';}
  else if (new RegExp('^/b2b/external-order-intents/orders/'+id+'/(allocate|cancel|reopen)$').test(r.path)) {entity=r.path.split('/')[4];operation=r.path.split('/')[5];if(operation==='cancel')operation='close';kind='external_order';root='/b2b/external-order-intents';}
  else throw Error('Ten rodzaj zachowanej próby wymaga własnego odczytu. Nie ponawiaj zapisu.');
  if (entity!==null && !uuid(entity)) throw Error('Brak dokładnego oryginalnego obiektu.');
  return {operation,kind,entity,path:root+'/original-results/'+encodeURIComponent(r.key)+'?operation='+operation+(entity?'&resource_id='+encodeURIComponent(entity):'')};
}
export function confirmOriginalKey(r: RecoveryRef, value: unknown, context: string): {proof: OriginalKeyProof; known: RecoveryRef} {
  const expected=originalKeyLocation(r), p=value as OriginalKeyProof;
  if (recoveryActor(context)!==r.actor || !p || Object.keys(p).sort().join(',')!=='client_key,content_sha256,operation,receipt_id,receipt_version,related_id,resource_id,resource_kind,state,version' ||
    p.client_key!==r.key || p.operation!==expected.operation || p.resource_kind!==expected.kind ||
    !uuid(p.resource_id) || !uuid(p.receipt_id) || (p.related_id!==null&&!uuid(p.related_id)) ||
    (expected.entity!==null&&p.resource_id!==expected.entity) || !version(p.version) || !version(p.receipt_version) || BigInt(p.version)<BigInt(p.receipt_version) ||
    (p.content_sha256!==null&&!/^[a-f0-9]{64}$/.test(p.content_sha256))) throw Error('Odczyt nie potwierdza dokładnej oryginalnej próby.');
  if (p.resource_kind==='printer' ? p.related_id!==null||p.content_sha256!==null||p.state!==null :
      p.resource_kind==='job' ? !uuid(p.related_id)||p.content_sha256===null||!['queued','claimed','file_saved','spool_submitted','failed','unknown','cancelled'].includes(p.state??'') :
      !uuid(p.related_id)||p.content_sha256!==null||!['open','closed'].includes(p.state??'')) throw Error('Niepełny oryginalny wynik.');
  if (r.state==='ack' && (!matchesRecovery(r,p.resource_id,p.version,p.related_id,[p.receipt_id],p.content_sha256))) throw Error('Oryginalne potwierdzenie zmieniło się.');
  return {proof:p,known:confirmedRecovery(r,p.resource_id,p.version,p.related_id,p.receipt_id,p.content_sha256)};
}
