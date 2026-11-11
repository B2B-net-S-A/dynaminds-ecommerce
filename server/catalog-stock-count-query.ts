import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, localConfig } from './db';
import { ensure, Problem } from './errors';
import { catalogStockControlAvailable } from './catalog-stock-control';
import type { CatalogStockControlActor } from './catalog-stock-control-schema';
import { renderCatalogStockCountExport, type CatalogStockCountExport,
  type CatalogStockCountExportRow, type CatalogStockCountExportValuation } from './catalog-stock-count-export';

const uuid = z.uuid().transform(v => v.toLowerCase());
const protocol = z.enum(['inventory_bulk', 'stock_file']);
const cursor = z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/).optional();
export const catalogStockCountQuery = z.strictObject({
  protocol: protocol.optional(), execution_id: uuid.optional(), warehouse_id: uuid.optional(),
  kind: z.enum(['PW', 'RW']).optional(), cursor,
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
export const catalogStockCountRowsQuery = z.strictObject({ cursor,
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
export const catalogStockCountValueRowsQuery = z.strictObject({ cursor,
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
export const catalogStockCountExportQuery = z.strictObject({ format: z.enum(['csv','xml']),
  include_values: z.enum(['true','false']).default('false').transform(v => v === 'true'),
});
const decimal = z.string().regex(/^[1-9][0-9]*$/);
const timestamp = z.string().max(80).refine(v => Number.isFinite(Date.parse(v)));
export const catalogStockCountPublicDocument = z.strictObject({
  id: uuid, receipt_id: uuid, source_id: uuid, execution_id: uuid, protocol,
  warehouse_id: uuid, warehouse: z.strictObject({ id: uuid, name: z.string(), code: z.string() }),
  kind: z.enum(['PW', 'RW']), number: z.string(), year: z.number().int(), sequence: decimal,
  series_id: uuid, row_count: z.number().int().min(1).max(10000), quantity: decimal,
  wms_enabled: z.boolean(), created_at: timestamp,
});
export const catalogStockCountPublicRow = z.strictObject({
  id: uuid, ordinal: z.number().int().min(0), document_id: uuid,
  warehouse_id: uuid, product_id: uuid, sku: z.string(), name: z.string(), location: z.string(),
  delta: z.number().int().refine(v => v !== 0), quantity: decimal,
  bin_movement_id: uuid.nullable(), layer_movement_id: uuid.nullable(),
  source_index: z.number().int().min(0).nullable(), stocktake_line_id: uuid.nullable(),
  stocktake_posting_id: uuid.nullable(), lot_id: uuid.nullable(), layer_id: uuid.nullable(),
});
export type CatalogStockCountPublicDocument = z.infer<typeof catalogStockCountPublicDocument>;
export type CatalogStockCountPublicRow = z.infer<typeof catalogStockCountPublicRow>;
type Context = { readOnly?: boolean };
type Grant = { role: string; allowed: boolean; key_valid: boolean; can_read_value: boolean };
export type CatalogStockCountValueRow = CatalogStockCountPublicRow & {
  cost_state: 'known'|'unknown'; unit_cost_minor: string|null; value_minor: string|null; currency: string; exponent: number;
};
export type CatalogStockCountValueReply = {
  available: true; read_only: boolean; current_role: string; can_read: true; can_read_value: true;
  value_state: 'complete'|'partial_unknown'|'unavailable_off';
  document: CatalogStockCountPublicDocument;
  valuation: CatalogStockCountExportValuation | {state:'unavailable_off';physical_quantity:string;buckets:[]};
  data: (CatalogStockCountPublicRow|CatalogStockCountValueRow)[];
  meta: {cursor:string|null;limit:number;total:number}; snapshot_at:string;
};
export type CatalogStockCountExportReply = CatalogStockCountExport & {
  available:true; read_only:boolean; current_role:string; can_read:true; can_read_value:boolean; snapshot_at:string;
};
export type CatalogStockCountReadFlags = {
  available: boolean; read_only: boolean; can_read: true; can_read_value: false;
  value_state: 'not_projected'; current_role: string;
};
export type CatalogStockCountListReply = CatalogStockCountReadFlags & {
  data: CatalogStockCountPublicDocument[]; meta: { cursor: string | null; limit: number }; snapshot_at: string;
};
export type CatalogStockCountDetailReply = CatalogStockCountReadFlags & {
  document: CatalogStockCountPublicDocument; data: CatalogStockCountPublicRow[];
  meta: { cursor: string | null; limit: number; total: number }; snapshot_at: string;
};
type Head = { id: string; receipt_id: string; protocol: 'inventory_bulk'|'stock_file'; source_id: string;
  execution_id: string; created_at: string; payload: Record<string, unknown> };
const nativeTables = { inventory_bulk: 'inventory_bulk_edit_executions', stock_file: 'stock_file_import_executions' } as const;
const incomplete = () => new Problem(503, 'Niekompletne dokumenty pomiarów COUNT');
async function owner<T>(c: PoolClient, a: CatalogStockControlActor, work: () => Promise<T>): Promise<T> {
  const ctx = (await c.query("SELECT session_user owner,current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];
  ensure(ctx.owner === 'postgres' && ctx.role === 'dyna_app' && ctx.tenant === a.tenantId,403,'Obcy kontekst odczytu pomiarów');
  await c.query('RESET ROLE'); let failed = false;
  try { return await work(); } catch (e) { failed = true; throw e; }
  finally { if (failed) await c.query('SET LOCAL ROLE dyna_app').catch(() => {}); else await c.query('SET LOCAL ROLE dyna_app'); }
}
async function access(c: PoolClient, a: CatalogStockControlActor, pin: boolean): Promise<Grant> {
  // Native read authority runs as dyna_app before any private owner bridge.
  const present = (await c.query("SELECT to_regprocedure('public.stock_file_import_access(uuid,uuid,boolean,boolean)') present")).rows[0].present;
  ensure(present,503,'Niekompletne źródła odczytu pomiarów');
  const grant: Grant = (await c.query('SELECT public.stock_file_import_access($1,$2,false,$3) result',
    [a.userId,a.apiKeyId ?? null,pin])).rows[0].result;
  ensure(grant.key_valid !== false,401,'Klucz API został cofnięty lub wygasł');
  ensure(grant.allowed === true,403,'Wymagane products:read i inventory:read oraz aktualne członkostwo');
  return grant;
}
async function nativeOwn(c: PoolClient, a: CatalogStockControlActor, head: Pick<Head,'protocol'|'execution_id'>) {
  ensure((await c.query(`SELECT id FROM public.${nativeTables[head.protocol]} WHERE(tenant_id,id)=($1,$2)`,
    [a.tenantId,head.execution_id])).rowCount === 1,404,'Nie znaleziono własnego wykonania pomiaru');
}
const headsSql = `SELECT d.id,d.receipt_id,a.protocol,a.source_id,
  coalesce(r.inventory_execution_id,r.stock_file_execution_id) execution_id,
  to_jsonb(r)->>'created_at' created_at,d.payload
  FROM public.catalog_stock_count_documents d
  JOIN public.catalog_stock_count_receipts r ON(r.tenant_id,r.id)=(d.tenant_id,d.receipt_id)
  JOIN public.catalog_stock_count_admissions a ON(a.tenant_id,a.id)=(r.tenant_id,r.admission_id)
  WHERE d.tenant_id=$1`;
function document(h: Head): CatalogStockCountPublicDocument {
  const p = h.payload, w = z.object({id:uuid,name:z.string(),code:z.string()}).parse(p.warehouse);
  // Literal allowlist: no admission, nonce, request, proof, cost or raw payload.
  return catalogStockCountPublicDocument.parse({id:h.id,receipt_id:h.receipt_id,source_id:h.source_id,
    execution_id:h.execution_id,protocol:h.protocol,warehouse_id:p.warehouse_id,warehouse:w,
    kind:p.kind,number:p.number,year:p.year,sequence:p.sequence,series_id:p.series_id,
    row_count:p.row_count,quantity:p.quantity,wms_enabled:p.wms_enabled,created_at:h.created_at});
}
const domain = Buffer.from('catalog-stock-count-query:v1');
const valueDomain = Buffer.from('catalog-stock-count-value-query:v1');
const key = (aad:Buffer) => createHash('sha256').update(aad).update(localConfig.encryptionKey).digest();
function seal(seek: unknown, binding: unknown, aad:Buffer=domain) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key(aad),iv); cipher.setAAD(aad);
  const bytes = Buffer.concat([cipher.update(JSON.stringify({version:1,seek,binding}),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64url');
}
function open<S>(raw: string|undefined, binding: unknown, schema: z.ZodType<S>, aad:Buffer=domain): S|null {
  if (!raw) return null;
  let decoded: {version:unknown;seek:unknown;binding:unknown};
  try {
    const bytes = Buffer.from(raw,'base64url');
    if (bytes.length < 29 || bytes.toString('base64url') !== raw) throw Error('cursor');
    const cipher = createDecipheriv('aes-256-gcm',key(aad),bytes.subarray(0,12));
    cipher.setAAD(aad); cipher.setAuthTag(bytes.subarray(12,28));
    decoded = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString());
    if (decoded.version !== 1 || !schema.safeParse(decoded.seek).success) throw Error('cursor');
  } catch { throw new Problem(422,'Nieprawidłowy kursor dokumentów pomiaru'); }
  ensure(isDeepStrictEqual(decoded.binding,binding),409,'Kursor dotyczy innego zakresu lub uprawnień');
  return schema.parse(decoded.seek);
}
function binding(a:CatalogStockControlActor,g:Grant,ctx:Context,query:unknown) {
  return {tenant:a.tenantId,user:a.userId,key:a.apiKeyId??null,role:g.role,read_only:!!ctx.readOnly,query};
}
async function read<T extends object>(a: CatalogStockControlActor, ctx: Context,
  work: (c:PoolClient,g:Grant,available:boolean)=>Promise<{value:T;binding:unknown}>, query:unknown):Promise<T & CatalogStockCountReadFlags> {
  uuid.parse(a.tenantId); uuid.parse(a.userId); if(a.apiKeyId)uuid.parse(a.apiKeyId);
  const c = await pool.connect();
  const context = async () => { await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenantId]);
    await c.query("SET LOCAL TimeZone='UTC'"); await c.query("SET LOCAL statement_timeout='8s'"); };
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await context();
    const g=await access(c,a,false), available=await owner(c,a,()=>catalogStockControlAvailable(c));
    const result=await work(c,g,available); await c.query('COMMIT');
    // Writable RC is required solely for native membership/key FOR SHARE PIN.
    // This module executes no DML or physical admissions.
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED'); await context();
    const currentAvailable=await owner(c,a,()=>catalogStockControlAvailable(c));
    ensure(currentAvailable===available,503,'Dostępność dokumentów pomiaru zmieniła się');
    const current=await access(c,a,true);
    ensure(isDeepStrictEqual(result.binding,binding(a,current,ctx,query)),409,'Uprawnienia odczytu zmieniły się');
    const reply={...result.value,available,read_only:!!ctx.readOnly,can_read:true as const,can_read_value:false as const,
      value_state:'not_projected' as const,current_role:current.role};
    ensure(Buffer.byteLength(JSON.stringify(reply))<=8388608,413,'Strona dokumentu pomiaru przekracza limit');
    await c.query('COMMIT'); return reply;
  } catch(e) {
    await c.query('ROLLBACK').catch(()=>{});
    const code=(e as {code?:string}).code;
    if(['55000','42P01','42703','42883'].includes(code??''))throw incomplete();
    throw e;
  } finally {c.release();}
}
async function snapshotAt(c:PoolClient):Promise<string> {
  return (await c.query("SELECT to_jsonb(transaction_timestamp())#>>'{}' AS snapshot_at")).rows[0].snapshot_at;
}
export async function catalogStockCountDocumentList(a:CatalogStockControlActor,raw:unknown,ctx:Context={}):Promise<CatalogStockCountListReply> {
  const q=catalogStockCountQuery.parse(raw);
  const {cursor: _cursor,...query}=q;
  return read<Omit<CatalogStockCountListReply,keyof CatalogStockCountReadFlags>>(a,ctx,async(c,g,available)=>{
    const b=binding(a,g,ctx,query),seek=open(q.cursor,b,z.strictObject({id:uuid,at:timestamp}));
    const snapshot_at=await snapshotAt(c);
    if(!available)return{value:{data:[],meta:{cursor:null,limit:q.limit},snapshot_at},binding:b};
    if(q.execution_id) {
      const matches=await c.query(`SELECT id FROM public.inventory_bulk_edit_executions WHERE(tenant_id,id)=($1,$2)
        AND($3::text IS NULL OR $3='inventory_bulk') UNION ALL SELECT id FROM public.stock_file_import_executions
        WHERE(tenant_id,id)=($1,$2) AND($3::text IS NULL OR $3='stock_file')`,[a.tenantId,q.execution_id,q.protocol??null]);
      ensure(matches.rowCount,404,'Nie znaleziono własnego wykonania');
    }
    if(q.warehouse_id)ensure((await c.query('SELECT id FROM public.warehouses WHERE(tenant_id,id)=($1,$2)',[a.tenantId,q.warehouse_id])).rowCount,404,'Nie znaleziono własnego magazynu');
    const rows:Head[]=await owner(c,a,async()=>{
      const filter=` AND($2::text IS NULL OR a.protocol=$2) AND($3::uuid IS NULL OR coalesce(r.inventory_execution_id,r.stock_file_execution_id)=$3)
        AND($4::uuid IS NULL OR d.warehouse_id=$4) AND($5::text IS NULL OR d.kind=$5)`;
      const params=[a.tenantId,q.protocol??null,q.execution_id??null,q.warehouse_id??null,q.kind??null];
      if(seek)ensure((await c.query(headsSql+filter+' AND(d.id,r.created_at)=($6::uuid,$7::timestamptz)',[...params,seek.id,seek.at])).rowCount,404,'Kursor nie należy do własnego dokumentu');
      return(await c.query(headsSql+filter+` AND($6::timestamptz IS NULL OR(r.created_at,d.id)<($6::timestamptz,$7::uuid))
        ORDER BY r.created_at DESC,d.id DESC LIMIT $8`,[...params,seek?.at??null,seek?.id??null,q.limit+1])).rows;
    });
    for(const h of rows)await nativeOwn(c,a,h);
    const page=rows.slice(0,q.limit),last=page.at(-1);
    return{value:{data:page.map(document),meta:{limit:q.limit,cursor:rows.length>q.limit&&last?seal({id:last.id,at:last.created_at},b):null},snapshot_at},binding:b};
  },query);
}
export async function catalogStockCountDocumentDetail(a:CatalogStockControlActor,id:unknown,raw:unknown={},ctx:Context={}):Promise<CatalogStockCountDetailReply> {
  const did=uuid.parse(id),q=catalogStockCountRowsQuery.parse(raw),query={document_id:did,limit:q.limit};
  return read<Omit<CatalogStockCountDetailReply,keyof CatalogStockCountReadFlags>>(a,ctx,async(c,g,available)=>{
    ensure(available,404,'Nie znaleziono dokumentu pomiaru');
    const b=binding(a,g,ctx,query),seek=open(q.cursor,b,z.strictObject({id:uuid,ordinal:z.number().int().min(0)}));
    // Resolve only the native identity, restore dyna_app and enforce RLS before
    // reading frozen document/row data through the second private bridge.
    const identity:Pick<Head,'protocol'|'execution_id'>|undefined=await owner(c,a,async()=>(await c.query(`SELECT a.protocol,
      coalesce(r.inventory_execution_id,r.stock_file_execution_id) execution_id
      FROM public.catalog_stock_count_documents d JOIN public.catalog_stock_count_receipts r
      ON(r.tenant_id,r.id)=(d.tenant_id,d.receipt_id) JOIN public.catalog_stock_count_admissions a
      ON(a.tenant_id,a.id)=(r.tenant_id,r.admission_id) WHERE(d.tenant_id,d.id)=($1,$2)`,[a.tenantId,did])).rows[0]);
    ensure(identity,404,'Nie znaleziono własnego dokumentu pomiaru'); await nativeOwn(c,a,identity);
    const doc=await owner(c,a,async()=>document((await c.query(headsSql+' AND d.id=$2',[a.tenantId,did])).rows[0]));
    const data=await owner(c,a,async()=>{
      const stats=(await c.query('SELECT count(*)::integer n,min(ordinal) lo,max(ordinal) hi,sum(abs(delta::bigint))::text quantity FROM public.catalog_stock_count_rows WHERE(tenant_id,document_id)=($1,$2)',[a.tenantId,did])).rows[0];
      ensure(stats.n===doc.row_count&&stats.lo===0&&stats.hi===doc.row_count-1&&stats.quantity===doc.quantity,409,'Niepełny manifest pomiaru');
      if(seek)ensure((await c.query('SELECT id FROM public.catalog_stock_count_rows WHERE(tenant_id,document_id,id,ordinal)=($1,$2,$3,$4)',[a.tenantId,did,seek.id,seek.ordinal])).rowCount,404,'Kursor nie należy do dokumentu');
      return(await c.query(`SELECT id,ordinal,document_id,warehouse_id,product_id,location,delta,
        abs(delta::bigint)::text quantity,bin_movement_id,layer_movement_id,source_index,stocktake_line_id,stocktake_posting_id,
        payload->>'sku' sku,payload->>'name' name,payload->>'lot_id' lot_id,payload->>'layer_id' layer_id
        FROM public.catalog_stock_count_rows WHERE(tenant_id,document_id)=($1,$2)
        AND($3::integer IS NULL OR ordinal>$3) ORDER BY ordinal LIMIT $4`,[a.tenantId,did,seek?.ordinal??null,q.limit+1])).rows.map(v=>catalogStockCountPublicRow.parse(v));
    });
    ensure(data.every(v=>v.warehouse_id===doc.warehouse_id&&(doc.kind==='PW'?v.delta>0:v.delta<0)),409,'Wiersze mają inny zakres dokumentu');
    const page=data.slice(0,q.limit),last=page.at(-1);
    return{value:{document:doc,data:page,meta:{limit:q.limit,total:doc.row_count,cursor:data.length>q.limit&&last?seal({id:last.id,ordinal:last.ordinal},b):null},snapshot_at:await snapshotAt(c)},binding:b};
  },query);
}

type FullCount = {document:CatalogStockCountPublicDocument;rows:CatalogStockCountExportRow[];snapshot_at:string};
const money = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v=>BigInt(v)<=9223372036854775807n);
const frozenCost = z.strictObject({unit_cost_minor:money.nullable(),value_minor:money.nullable(),
  currency:z.string().regex(/^[A-Z]{3}$/),exponent:z.number().int().min(0).max(6)});
const manifest = (condition:unknown) => ensure(condition,409,'Niepełny lub niespójny zamrożony manifest COUNT');

/** Full frozen rows and typed physical witnesses, collected before terminal IAM.
 * Costs come from immutable COUNT payloads; layer data is a witness, never a fallback. */
async function fullCount(c:PoolClient,a:CatalogStockControlActor,did:string,values:boolean):Promise<FullCount> {
  const h:Head|undefined=await owner(c,a,async()=>(await c.query(headsSql+' AND d.id=$2',[a.tenantId,did])).rows[0]);
  ensure(h,404,'Nie znaleziono własnego dokumentu pomiaru'); await nativeOwn(c,a,h);
  const doc=document(h);
  ensure(doc.row_count<=10000,413,'Limit pełnego manifestu COUNT');
  const records=await owner(c,a,async()=>(await c.query(`SELECT r.id,r.ordinal,r.document_id,r.warehouse_id,r.product_id,r.location,r.delta,
    abs(r.delta::bigint)::text quantity,r.bin_movement_id,r.layer_movement_id,r.source_index,r.stocktake_line_id,r.stocktake_posting_id,
    r.payload->>'sku' sku,r.payload->>'name' name,r.payload->>'lot_id' lot_id,r.payload->>'layer_id' layer_id,r.payload,
    (SELECT count(*)::integer FROM public.catalog_stock_count_layer_maps n WHERE(n.tenant_id,n.row_id)=(r.tenant_id,r.id)) map_count,
    m.quantity map_quantity,m.payload map_payload,j.id journal_id,j.delta journal_delta,j.value_delta::text journal_value,
    j.warehouse_id journal_warehouse,j.product_id journal_product,j.location journal_location,j.layer_id journal_layer,
    j.operation_id journal_operation,l.lot_id witness_lot,l.unit_cost_minor::text witness_cost,l.currency witness_currency,l.exponent witness_exponent
    FROM public.catalog_stock_count_rows r
    LEFT JOIN public.catalog_stock_count_layer_maps m ON(m.tenant_id,m.row_id,m.layer_movement_id)=(r.tenant_id,r.id,r.layer_movement_id)
    LEFT JOIN public.wms_layer_movements j ON(j.tenant_id,j.id)=(m.tenant_id,m.layer_movement_id)
    LEFT JOIN public.wms_cost_layers l ON(l.tenant_id,l.id)=(j.tenant_id,j.layer_id)
    WHERE(r.tenant_id,r.document_id)=($1,$2) ORDER BY r.ordinal LIMIT 10001`,[a.tenantId,did])).rows);
  ensure(records.length<=10000,413,'Limit pełnego manifestu COUNT');manifest(records.length===doc.row_count);
  const rows:CatalogStockCountExportRow[]=[],ids=new Set<string>(),journals=new Set<string>();let quantity=0n;
  for(const [ordinal,r] of records.entries()) {
    const row=catalogStockCountPublicRow.parse({id:r.id,ordinal:r.ordinal,document_id:r.document_id,warehouse_id:r.warehouse_id,
      product_id:r.product_id,location:r.location,delta:r.delta,quantity:r.quantity,bin_movement_id:r.bin_movement_id,
      layer_movement_id:r.layer_movement_id,source_index:r.source_index,stocktake_line_id:r.stocktake_line_id,
      stocktake_posting_id:r.stocktake_posting_id,sku:r.sku,name:r.name,lot_id:r.lot_id,layer_id:r.layer_id});
    manifest(row.ordinal===ordinal&&row.document_id===did&&row.warehouse_id===doc.warehouse_id&&Number.isSafeInteger(row.delta)
      &&(doc.kind==='PW'?row.delta>0:row.delta<0)&&BigInt(row.quantity)===BigInt(Math.abs(row.delta))&&!ids.has(row.id));
    ids.add(row.id);quantity+=BigInt(row.quantity);
    if(doc.wms_enabled) {
      manifest(row.bin_movement_id===null&&row.layer_movement_id!==null&&row.source_index!==null&&row.stocktake_line_id!==null
        &&row.stocktake_posting_id!==null&&row.lot_id!==null&&row.layer_id!==null&&!journals.has(row.layer_movement_id!));
      journals.add(row.layer_movement_id!);
      if(values) {
        const cost=frozenCost.parse({unit_cost_minor:r.payload.unit_cost_minor,value_minor:r.payload.value_minor,
          currency:r.payload.currency,exponent:r.payload.exponent});
        manifest((cost.unit_cost_minor===null)===(cost.value_minor===null));
        manifest(cost.unit_cost_minor===null||BigInt(cost.value_minor!)===BigInt(row.quantity)*BigInt(cost.unit_cost_minor));
        const map={layer_id:row.layer_id,lot_id:row.lot_id,operation_id:r.journal_operation,...cost};
        manifest(r.map_count===1&&String(r.map_quantity)===row.quantity&&isDeepStrictEqual(r.map_payload,map)
          &&r.journal_id===row.layer_movement_id&&r.journal_layer===row.layer_id&&r.witness_lot===row.lot_id
          &&r.journal_warehouse===row.warehouse_id&&r.journal_product===row.product_id&&r.journal_location===row.location
          &&r.journal_delta===row.delta&&r.payload.operation_id===r.journal_operation
          &&r.witness_cost===cost.unit_cost_minor&&r.witness_currency===cost.currency&&r.witness_exponent===cost.exponent
          &&r.journal_value===(cost.value_minor===null?null:(BigInt(cost.value_minor)*(row.delta<0?-1n:1n)).toString()));
        rows.push({...row,...cost});
      } else rows.push(row);
    } else {
      manifest(row.bin_movement_id!==null&&row.layer_movement_id===null&&row.source_index===null&&row.stocktake_line_id===null
        &&row.stocktake_posting_id===null&&row.lot_id===null&&row.layer_id===null&&r.map_count===0&&!journals.has(row.bin_movement_id!));
      journals.add(row.bin_movement_id!);rows.push(row);
    }
  }
  manifest(quantity.toString()===doc.quantity);
  return{document:doc,rows,snapshot_at:await snapshotAt(c)};
}
function valuation(v:FullCount):CatalogStockCountValueReply['valuation'] {
  if(!v.document.wms_enabled)return{state:'unavailable_off',physical_quantity:v.document.quantity,buckets:[]};
  const groups=new Map<string,{currency:string;exponent:number;known:bigint;zero:bigint;unknown:bigint;value:bigint}>();
  for(const row of v.rows) {
    const cost=frozenCost.parse({unit_cost_minor:row.unit_cost_minor,value_minor:row.value_minor,currency:row.currency,exponent:row.exponent});
    const k=cost.currency+':'+cost.exponent,g=groups.get(k)??{currency:cost.currency,exponent:cost.exponent,known:0n,zero:0n,unknown:0n,value:0n};
    const q=BigInt(row.quantity);if(cost.unit_cost_minor===null)g.unknown+=q;
    else{g.known+=q;g.value+=BigInt(cost.value_minor!);if(cost.unit_cost_minor==='0')g.zero+=q;}groups.set(k,g);
  }
  const buckets=[...groups.values()].sort((a,b)=>a.currency.localeCompare(b.currency)||a.exponent-b.exponent).map(g=>({
    currency:g.currency,exponent:g.exponent,known_quantity:g.known.toString(),zero_cost_quantity:g.zero.toString(),
    unknown_quantity:g.unknown.toString(),known_value_minor:g.value.toString(),signed_known_value_minor:(g.value*(v.document.kind==='RW'?-1n:1n)).toString()}));
  return{state:buckets.some(b=>b.unknown_quantity!=='0')?'partial_unknown':'complete',physical_quantity:v.document.quantity,buckets};
}
/** Initial authority is checked as dyna_app. RR collection then a fresh RC PIN on
 * the same client; projection/rendering is pure and no hydration follows PIN. */
async function valueRead<C,T extends object>(a:CatalogStockControlActor,ctx:Context,requiredValue:boolean,
  collect:(c:PoolClient,g:Grant)=>Promise<C>,project:(collected:C,g:Grant)=>T):Promise<T> {
  uuid.parse(a.tenantId);uuid.parse(a.userId);if(a.apiKeyId)uuid.parse(a.apiKeyId);
  const c=await pool.connect();const context=async()=>{
    await c.query('SET LOCAL ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenantId]);
    await c.query("SET LOCAL TimeZone='UTC'");await c.query("SET LOCAL statement_timeout='8s'");
  };
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await context();
    const initial=await access(c,a,false);
    if(requiredValue)ensure(initial.can_read_value===true,403,'Wymagany aktualny admin i purchasing:read do wyceny COUNT');
    ensure(await owner(c,a,()=>catalogStockControlAvailable(c)),404,'Nie znaleziono dokumentu pomiaru');
    const collected=await collect(c,initial);await c.query('COMMIT');
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');await context();
    ensure(await owner(c,a,()=>catalogStockControlAvailable(c)),503,'Dostępność dokumentów pomiaru zmieniła się');
    const current=await access(c,a,true);
    if(requiredValue)ensure(current.can_read_value===true,403,'Cofnięto dostęp do wyceny COUNT');
    ensure(current.role===initial.role,409,'Uprawnienia odczytu zmieniły się');
    const reply=project(collected,current);
    ensure(Buffer.byteLength(JSON.stringify(reply))<=8388608,413,'Pełna odpowiedź COUNT przekracza limit');
    await c.query('COMMIT');return reply;
  } catch(e) {
    await c.query('ROLLBACK').catch(()=>{});
    if(['55000','42P01','42703','42883'].includes((e as {code?:string}).code??''))throw incomplete();throw e;
  } finally{c.release();}
}
export async function catalogStockCountDocumentValue(a:CatalogStockControlActor,id:unknown,raw:unknown={},ctx:Context={}):Promise<CatalogStockCountValueReply> {
  const did=uuid.parse(id),q=catalogStockCountValueRowsQuery.parse(raw),query={document_id:did,limit:q.limit};
  type Collected={full:FullCount;seek:{id:string;ordinal:number}|null;binding:unknown};
  return valueRead(a,ctx,true,async(c,g):Promise<Collected>=>{
    const b={...binding(a,g,ctx,query),can_read_value:true};
    const seek=open(q.cursor,b,z.strictObject({id:uuid,ordinal:z.number().int().min(0)}),valueDomain);
    const full=await fullCount(c,a,did,true);
    if(seek)ensure(full.rows.some(r=>r.id===seek.id&&r.ordinal===seek.ordinal),404,'Kursor nie należy do dokumentu');
    return{full,seek,binding:b};
  },(v,g)=>{
    const summary=valuation(v.full),start=v.seek?v.seek.ordinal+1:0;
    const page=v.full.rows.slice(start,start+q.limit),last=page.at(-1);
    const data:(CatalogStockCountPublicRow|CatalogStockCountValueRow)[]=page.map(r=>{
      if(!v.full.document.wms_enabled)return catalogStockCountPublicRow.parse(r);
      const cost=frozenCost.parse({unit_cost_minor:r.unit_cost_minor,value_minor:r.value_minor,currency:r.currency,exponent:r.exponent});
      return {...r,...cost,cost_state:cost.unit_cost_minor===null?'unknown' as const:'known' as const};
    });
    return{available:true as const,read_only:!!ctx.readOnly,current_role:g.role,can_read:true as const,can_read_value:true as const,
      value_state:summary.state,document:v.full.document,valuation:summary,data,
      meta:{total:v.full.document.row_count,limit:q.limit,cursor:start+page.length<v.full.rows.length&&last?seal({id:last.id,ordinal:last.ordinal},v.binding,valueDomain):null},snapshot_at:v.full.snapshot_at};
  });
}
export async function catalogStockCountDocumentExport(a:CatalogStockControlActor,id:unknown,raw:unknown,ctx:Context={}):Promise<CatalogStockCountExportReply> {
  const did=uuid.parse(id),q=catalogStockCountExportQuery.parse(raw);
  return valueRead(a,ctx,q.include_values,c=>fullCount(c,a,did,q.include_values),(collected,g)=>{
    return{...renderCatalogStockCountExport(collected.document,collected.rows,{format:q.format,includeValues:q.include_values}),
      available:true as const,read_only:!!ctx.readOnly,current_role:g.role,can_read:true as const,can_read_value:g.can_read_value===true,snapshot_at:collected.snapshot_at};
  });
}
