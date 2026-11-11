import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ensure, Problem } from './errors';
import { catalogStockControlAvailable } from './catalog-stock-control';
import { enlistCatalogStockControlActorInTx, registerCatalogStockCountTerminalInTx } from './catalog-stock-control-transaction';
import type { CatalogStockControlActor } from './catalog-stock-control-schema';
import type { locationCount, locationMove } from './stock-locations';

// Trusted count publisher adapter. It records existing native effects and
// numbers PW/RW; it never changes stock, bins, layers or native source parents.
const uuid = z.uuid().transform(v => v.toLowerCase());
export const catalogStockCountSource = z.strictObject({
  protocol: z.enum(['inventory_bulk', 'stock_file']), source_id: uuid,
  request: z.record(z.string(), z.unknown()),
});
export type CatalogStockCountSource = z.infer<typeof catalogStockCountSource>;
const requirements = z.strictObject({ admin_only: z.boolean(), scopes: z.array(z.string().min(1)).min(1) });
const expectedCountDocument = z.strictObject({ warehouse_id: uuid, kind: z.enum(['PW','RW']) });
const prepared = z.strictObject({ id: uuid, tenant_id: uuid,
  protocol: catalogStockCountSource.shape.protocol, source_id: uuid,
  warehouse_ids: z.array(uuid).min(1).max(100), product_ids: z.array(uuid).min(1).max(10000), requirements,
  expected_count_documents: z.array(expectedCountDocument).max(200),
});
export const catalogStockCountProof = z.strictObject({
  inventory_execution_id: uuid.optional(), stock_file_execution_id: uuid.optional(),
}).refine(v => Boolean(v.inventory_execution_id) !== Boolean(v.stock_file_execution_id), 'Wymagany jeden rzeczywisty execution');
export type CatalogStockCountProof = z.infer<typeof catalogStockCountProof>;
export type CatalogStockCountAdmission = Readonly<{
  id: string; tenant_id: string; protocol: CatalogStockCountSource['protocol']; source_id: string;
  warehouse_ids: readonly string[]; product_ids: readonly string[];
  expected_count_documents: readonly Readonly<z.infer<typeof expectedCountDocument>>[];
}>;
export type CatalogStockCountParent = Readonly<{ protocol: CatalogStockCountSource['protocol']; source_id: string }>;
export type CatalogStockCountDocument = {
  id: string; receipt_id: string; source_id: string; protocol: CatalogStockCountSource['protocol'];
  warehouse_id: string; kind: 'PW'|'RW'; number: string; year: number; sequence: string;
  series_id: string; row_count: number; quantity: string; wms_enabled: boolean; created_at: string;
};
const documentHead = z.object({
  id: uuid, receipt_id: uuid, source_id: uuid, protocol: catalogStockCountSource.shape.protocol,
  warehouse_id: uuid, kind: z.enum(['PW','RW']), number: z.string().min(1), year: z.number().int(),
  sequence: z.string().regex(/^[1-9][0-9]*$/), series_id: uuid,
  row_count: z.number().int().positive(), quantity: z.string().regex(/^[1-9][0-9]*$/),
  wms_enabled: z.boolean(), created_at: z.string().transform((value,ctx) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) { ctx.addIssue({code:'custom',message:'Nieprawidłowa data dokumentu pomiaru'}); return z.NEVER; }
    return date.toISOString();
  }),
});
// SQL keeps the complete private frozen series/warehouse head. Expose the
// same minimal quantity-only heading as the native detail/history reader.
// A pure move still has a real private receipt, while its admitted PW/RW
// manifest is empty. An empty reply cannot stand in for expected count heads.
const finished = z.strictObject({ receipt_id: uuid, documents: z.array(documentHead).max(200) });
const documentPair = (d: {warehouse_id: string; kind: 'PW'|'RW'}) => `${d.warehouse_id}:${d.kind}`;
const tables = { stock_movement_ids: 'stock_movements', location_movement_ids: 'stock_location_movements', layer_movement_ids: 'wms_layer_movements' } as const;
type JournalKey = keyof typeof tables;
type State = { client: PoolClient; actor: string; serialized: string; before: Record<JournalKey, Set<string>> };
const custody = new WeakMap<CatalogStockCountAdmission, State>();
const parents = new WeakMap<CatalogStockCountParent, CatalogStockCountAdmission>();
const actorKey = (a: CatalogStockControlActor) => JSON.stringify([a.tenantId, a.userId, a.apiKeyId ?? null, a.source ?? 'manual']);
function check(c: PoolClient, a: CatalogStockControlActor, t: CatalogStockCountAdmission): State {
  const state = custody.get(t);
  ensure(state && state.client === c && state.actor === actorKey(a) && state.serialized === JSON.stringify(t) && t.tenant_id === a.tenantId,
    403, 'Obcy lub zmieniony token pomiaru stanów');
  return state;
}
function mapped(error: unknown): never {
  if (error instanceof Problem) throw error;
  const code = (error as { code?: string }).code;
  if (['55000','42P01','42703','42883'].includes(code ?? '')) throw new Problem(503, 'Niekompletny certyfikowany publisher pomiarów');
  if (code === '28000') throw new Problem(401, 'Klucz został cofnięty lub wygasł');
  if (code === '42501') throw new Problem(403, 'Brak aktualnego uprawnienia pomiaru');
  if (code === 'P0002') throw new Problem(404, 'Nie znaleziono własnego źródła pomiaru');
  if (code === '22023') throw new Problem(422, 'Nieprawidłowy pełny zakres pomiaru');
  if (code === '54000') throw new Problem(413, 'Pełny dowód pomiaru przekracza limit');
  if (['23514','23503','23505','40001','40P01'].includes(code ?? '')) throw new Problem(409, 'Źródło lub dowód pomiaru zmienił się');
  throw error;
}
async function owner<T>(c: PoolClient, a: CatalogStockControlActor, work: () => Promise<T>): Promise<T> {
  const before = (await c.query("SELECT session_user owner,current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];
  ensure(before.owner === 'postgres' && ['postgres','dyna_app'].includes(before.role) && before.tenant === a.tenantId,
    403, 'Nieprawidłowy kontekst pomiaru stanów');
  if (before.role === 'dyna_app') await c.query('RESET ROLE');
  let failed = false;
  try { return await work(); } catch (error) { failed = true; return mapped(error); }
  finally { if (before.role === 'dyna_app') {
    if (failed) await c.query('SET LOCAL ROLE dyna_app').catch(() => {}); else await c.query('SET LOCAL ROLE dyna_app');
  } }
}
async function journals(c: PoolClient, t: CatalogStockCountAdmission): Promise<Record<JournalKey, Set<string>>> {
  const result = {} as Record<JournalKey, Set<string>>;
  for (const key of Object.keys(tables) as JournalKey[]) {
    const rows = (await c.query(`SELECT id FROM public.${tables[key]}
      WHERE tenant_id=$1 AND warehouse_id=ANY($2::uuid[]) AND product_id=ANY($3::uuid[])
        AND public.catalog_stock_control_owns_xmin(xmin) ORDER BY id LIMIT 10001`,
    [t.tenant_id,t.warehouse_ids,t.product_ids])).rows;
    ensure(rows.length <= 10000, 413, 'Pełny journal pomiaru przekracza limit');
    result[key] = new Set(rows.map(row => uuid.parse(row.id)));
  }
  return result;
}
/** BEFORE native quota, preview/header, product, stock and WMS locks. SQL
 * derives the complete source scope; even a NULL historical/nonstrict token
 * enlists native authority for the fresh terminal IAM check after all waits. */
export async function prepareCatalogStockCountInTx(c: PoolClient, a: CatalogStockControlActor,
  input: CatalogStockCountSource): Promise<CatalogStockCountAdmission|null> {
  const b = catalogStockCountSource.parse(input);
  return owner(c,a,async () => {
    if (!await catalogStockControlAvailable(c)) return null;
    registerCatalogStockCountTerminalInTx(c,a,b);
    await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('catalog:'||$1,0))",[a.tenantId]);
    const allowed = requirements.parse((await c.query('SELECT public.catalog_stock_count_access($1,$2,$3::jsonb) requirements',
      [a.userId,a.apiKeyId ?? null,JSON.stringify(b)])).rows[0].requirements);
    enlistCatalogStockControlActorInTx(c,a,{adminOnly:allowed.admin_only,scopes:allowed.scopes});
    const nativeZone = (await c.query("SELECT current_setting('TimeZone') native_timezone")).rows[0].native_timezone;
    ensure(typeof nativeZone === 'string' && nativeZone.length > 0,409,'Brak kontekstu czasu rodzimego pomiaru');
    const raw = (await c.query('SELECT public.catalog_stock_count_prepare($1,$2,$3::jsonb,$4::text) admission',
      [a.userId,a.apiKeyId ?? null,JSON.stringify(b),nativeZone])).rows[0].admission;
    if (raw === null) return null;
    const p = prepared.parse(raw);
    ensure(p.tenant_id === a.tenantId && p.protocol === b.protocol && p.source_id === b.source_id,
      409, 'Przyjęcie pomiaru ma inne źródło');
    ensure(new Set(p.warehouse_ids).size === p.warehouse_ids.length && new Set(p.product_ids).size === p.product_ids.length,
      409, 'Zakres pomiaru zawiera powtórzenia');
    ensure(p.expected_count_documents.every(d => p.warehouse_ids.includes(d.warehouse_id)) &&
      new Set(p.expected_count_documents.map(documentPair)).size === p.expected_count_documents.length,
      409, 'Przyjęty manifest dokumentów pomiaru ma inny zakres');
    enlistCatalogStockControlActorInTx(c,a,{adminOnly:p.requirements.admin_only,scopes:p.requirements.scopes});
    const token: CatalogStockCountAdmission = Object.freeze({id:p.id,tenant_id:p.tenant_id,protocol:p.protocol,source_id:p.source_id,
      warehouse_ids:Object.freeze([...p.warehouse_ids]),product_ids:Object.freeze([...p.product_ids]),
      expected_count_documents:Object.freeze(p.expected_count_documents.map(d => Object.freeze({...d})))});
    custody.set(token,{client:c,actor:actorKey(a),serialized:JSON.stringify(token),before:await journals(c,token)});
    return token;
  });
}
/** AFTER the real native execution and all its rows exist, BEFORE terminal
 * deferred validation/hydration/PIN. This function has no physical writer. */
export async function finishCatalogStockCountInTx(c: PoolClient, a: CatalogStockControlActor,
  token: CatalogStockCountAdmission|null, input: CatalogStockCountProof): Promise<{documents:CatalogStockCountDocument[]}> {
  if (!token) return {documents:[]}; const state = check(c,a,token), proof = catalogStockCountProof.parse(input);
  ensure(token.protocol === 'inventory_bulk' ? Boolean(proof.inventory_execution_id) : Boolean(proof.stock_file_execution_id),
    409, 'Execution ma inny protokół pomiaru');
  const result = await owner(c,a,async () => {
    const current = await journals(c,token), full: Record<string,unknown> = {...proof};
    for (const key of Object.keys(tables) as JournalKey[]) {
      ensure([...state.before[key]].every(id => current[key].has(id)),409,'Historia bieżącej transakcji pomiaru zmieniła się');
      full[key] = [...current[key]].filter(id => !state.before[key].has(id));
    }
    const receipt = finished.parse((await c.query('SELECT public.catalog_stock_count_finish($1,$2,$3,$4::jsonb) receipt',
      [a.userId,a.apiKeyId ?? null,token.id,JSON.stringify(full)])).rows[0].receipt);
    const expected = new Set(token.expected_count_documents.map(documentPair)),
      actual = new Set(receipt.documents.map(documentPair));
    ensure(receipt.documents.every(d => d.source_id === token.source_id && d.protocol === token.protocol &&
      token.warehouse_ids.includes(d.warehouse_id) && d.receipt_id === receipt.receipt_id) &&
      new Set(receipt.documents.map(d => d.id)).size === receipt.documents.length &&
      actual.size === receipt.documents.length && actual.size === expected.size &&
      [...actual].every(pair => expected.has(pair)),
      409,'Zapisane dokumenty pomiaru mają inny zakres');
    return {documents:receipt.documents};
  });
  custody.delete(token); return result;
}
export async function abandonCatalogStockCountInTx(c: PoolClient, a: CatalogStockControlActor, token: CatalogStockCountAdmission|null): Promise<void> {
  if (!token) return; check(c,a,token);
  await owner(c,a,async () => { await c.query('SELECT public.catalog_stock_count_abandon($1,$2,$3)',[a.userId,a.apiKeyId ?? null,token.id]); });
  custody.delete(token);
}
/** A server-only parent capability. Caller-supplied UUIDs/booleans cannot
 * suppress a child admission. Invalidated together with its live token. */
export function retainCatalogStockCountParentInTx(c: PoolClient,a: CatalogStockControlActor,token: CatalogStockCountAdmission|null): CatalogStockCountParent|undefined {
  if (!token) return undefined; check(c,a,token);
  const parent = Object.freeze({protocol:token.protocol,source_id:token.source_id}); parents.set(parent,token); return parent;
}
export async function assertCatalogStockCountChildInTx(c: PoolClient,a: CatalogStockControlActor,parent: CatalogStockCountParent,childPreviewId:string): Promise<void> {
  const token = parents.get(parent); ensure(token,403,'Brak zachowanego parent pomiaru'); check(c,a,token);
  ensure(token.protocol === 'stock_file',403,'Tylko rzeczywisty import może objąć podrzędny pomiar inventory');
  await owner(c,a,async () => {
    const result = (await c.query('SELECT public.catalog_stock_count_child_scope($1,$2) ok',[token.id,uuid.parse(childPreviewId)])).rows[0];
    ensure(result?.ok === true,409,'Podrzędny pomiar nie należy do bieżącego importu');
  });
}
/** Root's location adapter uses the same opaque capability to suppress a
 * second child move publisher; SQL binds actual deterministic operation key. */
export async function assertCatalogStockCountLocationInTx(c: PoolClient,a: CatalogStockControlActor,parent: CatalogStockCountParent,
  input:z.infer<typeof locationCount>|z.infer<typeof locationMove>,kind:'count'|'move'): Promise<void> {
  const token = parents.get(parent); ensure(token,403,'Brak zachowanego parent pomiaru'); check(c,a,token);
  ensure(kind === 'count' || kind === 'move',422,'Nieprawidłowy rodzaj ruchu pomiaru');
  await owner(c,a,async () => {
    const result = (await c.query('SELECT public.catalog_stock_count_location_scope($1,$2,$3,$4,$5,$6::jsonb) ok',
      [token.id,uuid.parse(input.client_key),uuid.parse(input.warehouse_id),uuid.parse(input.product_id),kind,JSON.stringify(input)])).rows[0];
    ensure(result?.ok === true,409,'Ruch lokalizacji nie należy do bieżącego pomiaru');
  });
}
