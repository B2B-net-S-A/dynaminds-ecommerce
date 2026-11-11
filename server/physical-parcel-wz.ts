/** SOURCE_DRAFT: native producer/terminal and certificate integration are required
 * before adoption. No db/app import or runtime initialization. Relative imports
 * below are explicitly rebased to ./... upon future server-module adoption. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from './domain';
import type { BuyerAddressRequest } from './buyer-address';
import { ensure, Problem } from './errors';
import { physicalParcelWzInput, projectPhysicalParcelWz, type PhysicalWzLine } from './physical-parcel-wz-projection';
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const physicalWzLimits = Object.freeze({ parcels: 50, mapping_entries: 5000, physical_entries: 500, source_items: 500, snapshot_bytes: 4194304, preview_ttl_seconds: 900, previews_per_tenant: 2000 });
export const physicalWzPreviewInput = z.strictObject({ client_key: uuid, revision: hash, parcels: physicalParcelWzInput.shape.allocation });
export const physicalWzApplyInput = z.strictObject({ client_key: uuid, scope_hash: hash, confirmed: z.literal(true) });
export type PhysicalWzSource = Omit<z.infer<typeof physicalParcelWzInput>, 'allocation'> & {
  order_version: string; protocol: 'physical_v1'; revision: string;
  approved_mapping_id: string | null; approved_at: string | null;
};
export type ProjectedPhysicalParcel = { parcel_index: number; shipment_id: string; commercial_lines: PhysicalWzLine[] };
export type PhysicalWzPreview = { id: string; plan_id: string; order_id: string; client_key: string; revision: string; scope_hash: string;
  created_at: string; expires_at: string; allocation: z.infer<typeof physicalWzPreviewInput>['parcels']; projected_parcels: ProjectedPhysicalParcel[];
  applied_mapping_id: string | null; can_apply: boolean };
export type PhysicalWzMapping = { id: string; preview_id: string; plan_id: string; order_id: string; scope_hash: string;
  projection_hash: string; created_at: string; allocation: z.infer<typeof physicalWzPreviewInput>['parcels']; projected_parcels: ProjectedPhysicalParcel[];
  classification_origin: 'operator_confirmed' };
export type PhysicalWzFlags = { available: boolean; read_only: boolean; current_role: Actor['role']; can_read: boolean; can_write: boolean };
type Principal = { actor: Actor; digest: string };
const principals = new WeakMap<Actor, Principal>();
const transactions = new WeakMap<PoolClient, { available: boolean; duty: boolean; prepared:boolean }>();
/** Presence only; never authorization, admission or transaction readiness. */
export function hasPhysicalParcelWzTransactionDuty(c:PoolClient){return Boolean(transactions.get(c)?.duty);}
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
export function capturePhysicalParcelWzAuthority(req: BuyerAddressRequest, sessionName: string, boundActor?:Actor): Actor {
  ensure(req.currentUser?.id === req.actor.userId && req.currentUser.tenant_id === req.actor.tenantId, 401, 'Physical WZ identity changed');
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const raw = req.actor.apiKeyId ? bearer : (req.cookies[sessionName] ?? bearer);
  ensure(typeof raw === 'string' && raw.length > 0 && raw.length <= 4096, 401, 'Missing physical WZ credential');
  if(boundActor)ensure(boundActor.tenantId===req.actor.tenantId&&boundActor.userId===req.actor.userId&&boundActor.role===req.actor.role&&(boundActor.apiKeyId??null)===(req.actor.apiKeyId??null),401,'Physical WZ bound request actor changed');
  const actor: Actor = boundActor??Object.freeze({ ...req.actor }); principals.set(actor, { actor, digest: sha(raw) }); return actor;
}
export function beginPhysicalParcelWzTransaction(c: PoolClient, available: boolean) {
  ensure(!transactions.has(c), 500, 'Physical WZ transaction already started');transactions.set(c, { available, duty: false,prepared:false });
}
export function endPhysicalParcelWzTransaction(c: PoolClient) { transactions.delete(c); }
/** MUST be owner metadata call before borrowing the managed tenant connection. */
export async function preflightPhysicalParcelWz(c: Pick<Pool,'query'>): Promise<boolean> {
  const p = (await c.query(`SELECT current_user role,
    EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'parcel_physical_wz_'))
      OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'parcel_physical_wz_')) partial,
    EXISTS(SELECT FROM migrations WHERE name='168_physical_parcel_wz') installed,
    to_regprocedure('public.parcel_physical_wz_valid()') guard`)).rows[0];
  ensure(p.role !== 'dyna_app', 500, 'Physical WZ metadata preflight requires owner reader');
  if (!p.partial && !p.installed) return false;
  ensure(p.partial && p.installed && p.guard && (await c.query('SELECT parcel_physical_wz_valid() ok')).rows[0].ok, 503, 'Torn physical WZ module');return true;
}
async function open(c: PoolClient, a: Actor, write: boolean, operation: string, subject: string | null) {
  const tx = transactions.get(c), principal = principals.get(a);
  ensure(tx?.available && principal?.actor === a, 503, 'Physical WZ requires available managed custody');
  await c.query('SELECT parcel_physical_wz_open($1,$2,$3,$4,$5,$6,$7,$8)',[a.tenantId,a.userId,a.apiKeyId??null,principal.digest,a.role,write,operation,subject]);
  tx.duty=true;tx.prepared=false;
}
/** The native terminal drains constraints, pins credential/member/account/policy,
 * then revalidates immutable mapping sources after all waits and reads DB clock.
 * Root must place it with the final cooperative terminal phase; no later sibling
 * lock may invalidate a deadline before commit (see CONTRACT.md). */
export async function preparePhysicalParcelWzFinalizationInTx(c: PoolClient) {
  const tx=transactions.get(c);ensure(tx,500,'Missing physical WZ managed transaction');
  if(tx.duty){await c.query('SELECT parcel_physical_wz_terminal_prepare()');tx.prepared=true;}
}
/** LAST clock-only check after all sibling terminal/prepare calls. No later DB
 * statement may introduce a new lock wait before COMMIT. */
export async function finalizePhysicalParcelWzInTx(c: PoolClient) {
  const tx=transactions.get(c);ensure(tx,500,'Missing physical WZ managed transaction');
  if(tx.duty){ensure(tx.prepared,500,'Physical WZ source preparation missing');await c.query('SELECT parcel_physical_wz_terminal_clock()');}
}
function controlled(e: unknown): never {
  if(e instanceof Problem)throw e;
  const code=(e as {code?:string})?.code;
  const status=code==='28000'?401:code==='42501'?403:code==='55000'?503:code==='54000'?413:code==='P0002'?404:['23514','23505','23503','40001'].includes(code??'')?409:null;
  if(status)throw new Problem(status,'Physical WZ native scope or authority refused');throw e;
}
export function createPhysicalParcelWzService(deps: { tenantTx: <T>(tenantId: string, fn: (c: PoolClient) => Promise<T>) => Promise<T> }) {
  async function run<T>(a: Actor, write: boolean, op: string, subject: string, body: (c: PoolClient) => Promise<T>) {
    try{return await deps.tenantTx(a.tenantId,async c=>{await open(c,a,write,op,subject);const result=await body(c);ensure(Buffer.byteLength(JSON.stringify(result),'utf8')<=physicalWzLimits.snapshot_bytes,413,'Whole physical WZ response budget');return result;});}catch(e){controlled(e);}
  }
  async function flags(c: PoolClient,a:Actor,readOnly:boolean):Promise<PhysicalWzFlags>{
    const g=(await c.query('SELECT parcel_physical_wz_flags($1,$2) g',[a.userId,a.apiKeyId??null])).rows[0].g;
    return {available:true,read_only:readOnly,current_role:g.role,can_read:true,can_write:!readOnly&&g.can_write};
  }
  return {
    source(a:Actor,planId:string,readOnly=false){uuid.parse(planId);return run(a,false,'source',planId,async c=>({source:(await c.query('SELECT parcel_physical_wz_source($1) source',[planId])).rows[0].source as PhysicalWzSource,limits:physicalWzLimits,...await flags(c,a,readOnly)}));},
    preview(a:Actor,planId:string,raw:unknown){uuid.parse(planId);const b=physicalWzPreviewInput.parse(raw);return run(a,true,'preview',planId,async c=>{
      // Native producer must check same client-key replay BEFORE frame/projection.
      const r=(await c.query('SELECT parcel_physical_wz_preview($1,$2::jsonb) r',[planId,JSON.stringify(b)])).rows[0].r;
      const f=await flags(c,a,false),p=r.preview as PhysicalWzPreview;
      return {preview:{...p,can_apply:f.can_write&&p.can_apply},reused:r.reused as boolean,...f};
    });},
    previewDetail(a:Actor,id:string,readOnly=false){uuid.parse(id);return run(a,false,'preview_detail',id,async c=>{const p=(await c.query('SELECT parcel_physical_wz_preview_detail($1) preview',[id])).rows[0].preview as PhysicalWzPreview,f=await flags(c,a,readOnly);return {preview:{...p,can_apply:f.can_write&&p.can_apply},...f};});},
    apply(a:Actor,id:string,raw:unknown){uuid.parse(id);const b=physicalWzApplyInput.parse(raw);return run(a,true,'apply',id,async c=>{
      const r=(await c.query('SELECT parcel_physical_wz_apply($1,$2::jsonb) r',[id,JSON.stringify(b)])).rows[0].r;
      return {mapping:r.mapping as PhysicalWzMapping,reused:r.reused as boolean,...await flags(c,a,false)};
    });},
    mappingDetail(a:Actor,id:string,readOnly=false){uuid.parse(id);return run(a,false,'mapping_detail',id,async c=>({mapping:(await c.query('SELECT parcel_physical_wz_mapping_detail($1) mapping',[id])).rows[0].mapping as PhysicalWzMapping,...await flags(c,a,readOnly)}));},
  };
}
/** Parent route captures original request actor. Parent native dispatch validates
 * committed client-key receipt BEFORE calling this; call before WMS actor clone.
 * Does not manufacture a replay or mutate a native134/136 receipt. */
export async function enlistPhysicalParcelWzDispatchInTx(c:PoolClient,a:Actor,planId:string,index:number,clientKey:string){
  uuid.parse(planId);uuid.parse(clientKey);ensure(Number.isSafeInteger(index)&&index>=0&&index<50,422,'Invalid physical parcel index');
  const tx=transactions.get(c);ensure(tx,500,'Missing managed physical WZ transaction');if(!tx.available)return;
  const p=(await c.query('SELECT payload FROM order_parcel_plans WHERE tenant_id=$1 AND id=$2',[a.tenantId,planId])).rows[0];ensure(p,404,'Own parcel plan not found');
  if(p.payload.protocol==='commercial_v1')return;
  // Native OFF gate holds configuration insertion/update locks through commit.
  if(!(await c.query('SELECT parcel_physical_wz_dispatch_required($1,$2) required',[planId,index])).rows[0].required)return;
  await open(c,a,true,'dispatch',planId);
  await c.query('SELECT parcel_physical_wz_enlist_dispatch($1,$2,$3)',[planId,index,clientKey]);
}
/** Independent pure cross-check for a native full frame; NEVER used as SQL proof
 * or a way to trust client-supplied history. Native canonical hash stays native. */
export function crossCheckNativePhysicalWzFrame(frame:{source:PhysicalWzSource;allocation:unknown;projected_parcels:ProjectedPhysicalParcel[]}){
  const {order_version:_v,protocol:_p,revision:_r,approved_mapping_id:_m,approved_at:_a,...source}=frame.source;
  for(const projected of frame.projected_parcels){
    const pure=projectPhysicalParcelWz({...source,allocation:frame.allocation},projected.parcel_index);
    // The immutable native mapping includes historical issued parcels; the pure
    // replay directive intentionally does not regenerate their admission lines.
    if(pure.state==='pending')ensure(isDeepStrictEqual(pure.commercial_lines,projected.commercial_lines),503,'Native physical WZ projection mismatch');
  }
}

/** Owner RR READ ONLY restore validation, no credential/table mutation. Every
 * saved mapping and typed receipt is compared with genuine retained native rows.
 * This does not claim actor certificate or revive expired preview consent. */
export async function validateRecoveredPhysicalParcelWz(c:Pick<PoolClient,'query'>){
  if(!await preflightPhysicalParcelWz(c))return {mappings:0,previews:0,bindings:0};
  const totals={mappings:0,previews:0,bindings:0};
  for(const table of ['parcel_physical_wz_previews','parcel_physical_wz_mappings'] as const){
    let last:string|null=null;
    for(;;){const rows:Array<{id:string;tenant_id:string;plan_id:string;frame:any}>=(await c.query(`SELECT id,tenant_id,plan_id,frame FROM ${table} WHERE($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 50`,[last])).rows;if(!rows.length)break;
      for(const row of rows){await c.query("SELECT set_config('app.tenant_id',$1,true)",[row.tenant_id]);const f=(await c.query('SELECT parcel_physical_wz_frame($1,$2::jsonb,false) f',[row.plan_id,JSON.stringify(row.frame.allocation)])).rows[0].f;
        ensure(isDeepStrictEqual(f.basis,row.frame.basis)&&isDeepStrictEqual(f.projected_parcels,row.frame.projected_parcels),503,'Recovered physical component lineage differs from native source');
        totals[table==='parcel_physical_wz_previews'?'previews':'mappings']++;
      }last=rows.at(-1)!.id;
    }
  }
  let last:string|null=null;
  for(;;){const rows:Array<{admission_id:string;tenant_id:string}>=(await c.query('SELECT admission_id,tenant_id FROM parcel_physical_wz_bindings WHERE($1::uuid IS NULL OR admission_id>$1) ORDER BY admission_id LIMIT 50',[last])).rows;if(!rows.length)break;
    for(const row of rows){await c.query("SELECT set_config('app.tenant_id',$1,true)",[row.tenant_id]);await c.query('SELECT parcel_physical_wz_validate_admission($1,true)',[row.admission_id]);totals.bindings++;}last=rows.at(-1)!.admission_id;
  }return totals;
}
