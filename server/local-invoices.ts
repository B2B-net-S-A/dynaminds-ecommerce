import { assertNoPartialCommercialInvoiceInTx, type CommercialSaleScope } from './commercial-sale-scope';
import {assertNoFa3DraftProjectInTx,fa3DraftOwnerInTx} from './fa3-draft-access';
import type { Pool, PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { tokenHash } from './security';
import { isDeepStrictEqual } from 'node:util';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import {
  LOCAL_INVOICE_LIMITS,
  localInvoiceSeriesInput,
  localInvoicePreviewInput,
  localInvoiceIssueInput,
  localInvoicePageQuery,
  type LocalInvoiceActor,
  type LocalInvoiceSeriesInput,
  type LocalInvoicePreviewInput,
  type LocalInvoiceIssueInput,
} from './local-invoice-values';

export const LOCAL_INVOICE_SCOPE = {countries:['PL'],currencies:['PLN'],vat_rates:[0,5,8,23],buyer_kinds:['consumer'],source_statuses:['shipped','delivered'],b2b_state:'not_supported',ksef_state:'not_submitted',fiscalized:false} as const;
export { LOCAL_INVOICE_LIMITS } from './local-invoice-values';
export type LocalInvoiceLine = {
  item_id: string | null;
  product_id: string | null;
  kind: 'item' | 'shipping';
  sku: string;
  name: string;
  quantity: number;
  unit: 'szt.' | 'usł.';
  unit_gross_minor: string;
  discount_gross_minor: string;
  rounding_gross_minor: string;
  vat_rate: number;
  gross_minor: string;
  net_minor: string;
  vat_minor: string;
};
export type LocalInvoiceSnapshot = {
  commercial_scope?: CommercialSaleScope;
  order: {
    id: string;
    number: string;
    version: string;
    status: string;
    currency: string;
    total_minor: string;
    shipping_cost_minor: string;
    payment_mode: string;
  };
  seller: LocalInvoiceSeriesInput['seller'];
  buyer: {
    kind: 'consumer';
    tax_id: '';
    name: string;
    email: string;
    address: { street: string; postal_code: string; city: string; country: string };
  };
  series: {
    id: string;
    name: string;
    prefix: string;
    payment_terms_days: number;
    payment_instructions: string;
    notes: string;
  };
  currency: string;
  lines: LocalInvoiceLine[];
  totals: { gross_minor: string; net_minor: string; vat_minor: string };
  vat_totals: ({vat_rate:number} & {gross_minor:string;net_minor:string;vat_minor:string})[];
  rounding_method: 'gross_line_half_up';
  tax_regime: 'ordinary_domestic';
  consumer_sale_confirmed: true;
  no_special_tax_procedure_confirmed: true;
  not_fiscal_receipt_confirmed: true;
  sell_date: string;
  issue_date: string;
  due_date: string;
  year: number;
};
export type LocalInvoiceSeries = Omit<LocalInvoiceSeriesInput, 'client_key'> & {
  id: string;
  version: 1;
  created_at: string;
};
export type LocalInvoicePreview = {
  id: string;
  order_id: string;
  order_version: string;
  series_id: string;
  scope_hash: string;
  snapshot: LocalInvoiceSnapshot;
  expires_at: string;
  created_at: string;
  can_issue: boolean;
  issued_document_id: string | null;
};
export type LocalInvoiceDocument = {
  id: string;
  order_id: string;
  number: string;
  kind: 'invoice';
  mode: 'local_invoice';
  data: LocalInvoiceSnapshot & {
    number: string;
    preview_id: string;
    scope_hash: string;
    local_only: true;
    ksef_state: 'not_submitted';
    fiscalized: false;
  };
  created_at: string;
};
export type LocalInvoiceReceipt = {
  id: string;
  document_id: string;
  preview_id: string;
  series_id: string;
  year: number;
  sequence: number;
  number: string;
  scope_hash: string;
  created_at: string;
};

/** Same-client metadata bridge; private ledger ACL remains unchanged. */
export async function localInvoicesAvailable(c: Pool | PoolClient): Promise<boolean> {
 const client='release' in c?c as PoolClient:undefined;
 let restore=false,failed=false;
 if(client){const role=(await client.query('SELECT current_user role,session_user owner')).rows[0];ensure(role.owner!=='dyna_app'&&(role.role==='dyna_app'||role.role===role.owner),503,'Brak zaufanego właściciela metadanych FV');restore=role.role==='dyna_app';if(restore)await client.query('RESET ROLE');}
 try {
  const probe=(await c.query("SELECT to_regprocedure('public.local_invoice_guards()') fn,EXISTS(SELECT FROM migrations WHERE name='157_local_invoices') installed,(EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'local\\_invoice\\_%' ESCAPE '\\') OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'local\\_invoice\\_%' ESCAPE '\\')) artifacts")).rows[0];
  if(!probe.installed&&!probe.fn&&!probe.artifacts)return false;
  ensure(probe.installed&&probe.fn,503,'Niekompletny moduł lokalnej FV');
  ensure((await c.query('SELECT public.local_invoice_guards() ok')).rows[0].ok===true,503,'Niekompletny moduł lokalnej FV');
  return true;
 }catch(error){failed=true;throw error;}
 finally{if(restore)try{await client!.query('SET LOCAL ROLE dyna_app');}catch(error){if(!failed)throw error;}}
}
/** Caller already holds the genuine order lock. Prevent second external invoice
 * before provider HTTP; no mutation, token, broad invoice-kind rewrite or adoption. */
export async function assertNoLocalInvoiceForExternalInTx(c:PoolClient,orderId:string){
 await assertNoPartialCommercialInvoiceInTx(c,orderId);
 await assertNoFa3DraftProjectInTx(c,orderId);
 if(!await localInvoicesAvailable(c))return;
 ensure(!(await c.query("SELECT 1 FROM documents WHERE order_id=$1 AND kind='invoice' AND mode='local_invoice'",[orderId])).rowCount,409,'Zamówienie ma już lokalną FV; drugi dokument zewnętrzny wymaga odrębnego procesu');
}
const requestFrames = new WeakMap<LocalInvoiceActor,string>();
export function localInvoiceRequestActor(req: {actor:Actor;apiKeyId?:string;currentUser?:{id:string;tenant_id:string};headers:{authorization?:string};cookies:Record<string,string|undefined>},sessionName:string):LocalInvoiceActor {
 ensure(req.currentUser?.id===req.actor.userId&&req.currentUser.tenant_id===req.actor.tenantId,401,'Brak natywnej tożsamości żądania FV');
 const key=req.apiKeyId??(req.actor as LocalInvoiceActor).apiKeyId;
 const raw=key ? req.headers.authorization?.replace(/^Bearer /,'') : req.cookies[sessionName]??req.headers.authorization?.replace(/^Bearer /,'');
 ensure(raw,401,'Brak sesji lub klucza FV');
 const actor=Object.freeze({...req.actor,...(key?{apiKeyId:key}:{})});requestFrames.set(actor,tokenHash(raw));return actor;
}
async function identity(c:PoolClient,a:LocalInvoiceActor,writing:boolean,pin:boolean){
 const hash=requestFrames.get(a);ensure(hash,401,'Brak zaufanego kontekstu żądania FV');
 await c.query('SELECT public.local_invoice_identity($1,$2,$3,$4,$5)',[a.userId,a.apiKeyId??null,hash,writing,pin]);
}
type Grant = { role: Actor['role']; key_valid: boolean; allowed: boolean };
async function access(
  c: PoolClient,
  a: LocalInvoiceActor,
  writing: boolean,
  pin: boolean,
): Promise<Grant> {
  const g = (
    await c.query('SELECT local_invoice_access($1,$2,$3,$4) g', [
      a.userId,
      a.apiKeyId ?? null,
      writing,
      pin,
    ])
  ).rows[0].g;
  ensure(g.key_valid, 401, 'Klucz faktury jest wycofany lub wygasł');
  ensure(g.allowed, 403, 'Brak aktualnych uprawnień do faktury');
  return g;
}
async function flags(c: PoolClient, a: LocalInvoiceActor, writing: boolean, admin = false) {
  await identity(c,a,writing,true);
  await localInvoicesAvailable(c);
  const g = await access(c, a, writing, false);
  if (admin) ensure(g.role === 'admin', 403, 'Serią faktur zarządza administrator');
  const w = (
    await c.query('SELECT local_invoice_access($1,$2,true,false) g', [a.userId, a.apiKeyId ?? null])
  ).rows[0].g as Grant;
  await identity(c,a,writing,false); // Last DB clock, after schema work and every identity lock wait.
  return {
    available: true,
    read_only: false,
    current_role: g.role,
    can_read: true,
    can_write: Boolean(w.allowed),
    can_create_series: Boolean(w.allowed && g.role === 'admin'),
  };
}
async function transaction<T>(
  a: LocalInvoiceActor,
  writing: boolean,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  ensure(await localInvoicesAvailable(pool), 503, 'Lokalne faktury nie są dostępne');
  try {
    return await tenantTx(a.tenantId, async (c) => {
      await localInvoicesAvailable(c);
      const h=requestFrames.get(a);ensure(h,401,'Brak zaufanego kontekstu żądania FV');
      await c.query("SELECT set_config('local_invoice.identity_hash',$1,true)",[h]);
      await identity(c,a,writing,false);
      await access(c, a, writing, false);
      return fn(c);
    });
  } catch (error) {
    if (error instanceof Problem) throw error;
    const e = error as { code?: string; message?: string };
    if (e.code === '23514' && e.message === 'Klucz faktury jest wycofany lub wygasł')
      throw new Problem(401, e.message);
    if (
      e.code === '23514' &&
      ['Brak aktualnych uprawnień do faktury', 'Serią faktur zarządza administrator'].includes(
        e.message ?? '',
      )
    )
      throw new Problem(403, e.message!);
    if(e.code==='55000')throw new Problem(503,'Niekompletny moduł lokalnej FV');
    if(e.code==='28000')throw new Problem(401,e.message??'Sesja lub klucz FV wygasły');
    if(e.code==='42501')throw new Problem(403,e.message??'Brak dostępu do FV');
    if(e.code==='22023')throw new Problem(422,e.message??'Niepoprawne dane FV');
    if (e.code === 'P0002') throw new Problem(404, e.message ?? 'Nie znaleziono faktury');
    if (e.code === '23514') throw new Problem(409, e.message ?? 'Zakres faktury zmienił się');
    if (e.code === '23505')
      throw new Problem(409, 'Seria, numer lub faktura zamówienia już istnieje');
    throw error;
  }
}
const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);
function seriesView(s: Record<string, any>): LocalInvoiceSeries {
  return {
    id: s.id,
    version: 1,
    name: s.name,
    prefix: s.prefix,
    seller: s.definition.seller,
    payment_terms_days: s.definition.payment_terms_days,
    payment_instructions: s.definition.payment_instructions,
    notes: s.definition.notes,
    seller_vat_status: s.definition.seller_vat_status,
    created_at: iso(s.created_at),
  };
}
async function previewView(c: PoolClient, a: LocalInvoiceActor, id: string): Promise<LocalInvoicePreview> {
  const p = (await c.query('SELECT * FROM local_invoice_previews WHERE id=$1', [id])).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu faktury');
  const d = (
    await c.query("SELECT id FROM documents WHERE order_id=$1 AND kind='invoice' AND mode='local_invoice'", [p.order_id])
  ).rows[0];
  return {
    id: p.id,
    order_id: p.order_id,
    order_version: String(p.order_version),
    series_id: p.series_id,
    scope_hash: p.scope_hash,
    snapshot: p.snapshot,
    expires_at: iso(p.expires_at),
    created_at: iso(p.created_at),
    issued_document_id: d?.id ?? null,
    can_issue:
      !d &&
      p.actor_id === a.userId &&
      p.api_key_id === (a.apiKeyId ?? null) &&
      new Date(p.expires_at).getTime() > Date.now(),
  };
}
async function documentView(
  c: PoolClient,
  id: string,
): Promise<{ document: LocalInvoiceDocument; receipt: LocalInvoiceReceipt }> {
  const d = (
    await c.query("SELECT * FROM documents WHERE id=$1 AND kind='invoice' AND mode='local_invoice'", [id])
  ).rows[0];
  ensure(d, 404, 'Nie znaleziono własnej faktury');
  const r = (await c.query('SELECT * FROM local_invoice_receipts WHERE document_id=$1', [id])).rows[0];
  ensure(
    r &&
      r.order_id === d.order_id &&
      r.number === d.number &&
      d.data.preview_id === r.preview_id &&
      d.data.scope_hash === r.scope_hash && isDeepStrictEqual(d.data,{...r.snapshot,number:r.number,preview_id:r.preview_id,scope_hash:r.scope_hash,local_only:true,ksef_state:'not_submitted',fiscalized:false}),
    503,
    'Niepełny trwały dowód faktury',
  );
  return {
    document: {
      id: d.id,
      order_id: d.order_id,
      number: d.number,
      kind: 'invoice',
      mode: 'local_invoice',
      data: d.data,
      created_at: iso(d.created_at),
    },
    receipt: {
      id: r.id,
      document_id: r.document_id,
      preview_id: r.preview_id,
      series_id: r.series_id,
      year: r.year,
      sequence: r.sequence,
      number: r.number,
      scope_hash: r.scope_hash,
      created_at: iso(r.created_at),
    },
  };
}
export async function localInvoiceOptions(a: LocalInvoiceActor) {
  if (!(await localInvoicesAvailable(pool)))
    return {
      available: false,
      read_only: false,
      current_role: a.role,
      can_read: false,
      can_write: false,
      can_create_series: false,
      limits: LOCAL_INVOICE_LIMITS,
      scope: LOCAL_INVOICE_SCOPE,
    };
  return transaction(a, false, async (c) => ({
    ...(await flags(c, a, false)),
    limits: LOCAL_INVOICE_LIMITS,
      scope: LOCAL_INVOICE_SCOPE,
  }));
}
export async function listLocalInvoiceSeries(a: LocalInvoiceActor, page: unknown = {}) {
  const q = localInvoicePageQuery.parse(page);
  return transaction(a, false, async (c) => {
    if (q.cursor)
      ensure(
        (await c.query('SELECT id FROM local_invoice_series WHERE id=$1', [q.cursor])).rowCount,
        404,
        'Nie znaleziono kursora własnych serii',
      );
    const data = (
      await c.query(
        `SELECT * FROM local_invoice_series WHERE
      ($1::uuid IS NULL OR(created_at,id)<(SELECT created_at,id FROM local_invoice_series WHERE id=$1))
      ORDER BY created_at DESC,id DESC LIMIT 51`,
        [q.cursor ?? null],
      )
    ).rows;
    const more = data.length > 50;
    const rows = data.slice(0, 50).map(seriesView);
    return {
      ...(await flags(c, a, false)),
      data: rows,
      next_cursor: more ? rows.at(-1)!.id : null,
    };
  });
}
export async function createLocalInvoiceSeries(a: LocalInvoiceActor, input: LocalInvoiceSeriesInput) {
  const b = localInvoiceSeriesInput.parse(input);
  return transaction(a, true, async (c) => {
    const s = (
      await c.query('SELECT local_invoice_create_series($1::jsonb,$2,$3) s', [
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].s;
    if (!s.reused) await audit(c, a, 'local_invoice.series.create', s.id, { prefix: s.prefix });
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const view = seriesView(s);
    return { ...(await flags(c, a, true, true)), series: view, reused: Boolean(s.reused) };
  });
}
export async function previewLocalInvoice(
  a: LocalInvoiceActor,
  orderId: string,
  input: LocalInvoicePreviewInput,
) {
  const b = localInvoicePreviewInput.parse(input);
  return transaction(a, true, async (c) => {
    await fa3DraftOwnerInTx(c,()=>c.query('SELECT public.local_invoice_locks()'));
    await assertNoFa3DraftProjectInTx(c,orderId);
    const p = (
      await c.query('SELECT local_invoice_store_preview($1,$2::jsonb,$3,$4) p', [
        orderId,
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].p;
    if (!p.reused)
      await audit(c, a, 'local_invoice.preview', p.id, {
        order_id: orderId,
        series_id: b.series_id,
        scope_hash: p.scope_hash,
      });
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const preview = await previewView(c, a, p.id);
    const f = await flags(c, a, true);
    preview.can_issue &&= f.can_write;
    return { ...f, preview, reused: Boolean(p.reused) };
  });
}
export async function issueLocalInvoice(
  a: LocalInvoiceActor,
  previewId: string,
  input: LocalInvoiceIssueInput,
) {
  const b = localInvoiceIssueInput.parse(input);
  return transaction(a, true, async (c) => {
    await fa3DraftOwnerInTx(c,()=>c.query('SELECT public.local_invoice_locks()'));
    const sourceOrder=(await c.query('SELECT order_id FROM local_invoice_previews WHERE id=$1',[previewId])).rows[0];
    ensure(sourceOrder,404,'Brak własnego podglądu FV');
    await assertNoFa3DraftProjectInTx(c,sourceOrder.order_id);
    const r = (
      await c.query('SELECT local_invoice_issue($1,$2::jsonb,$3,$4) r', [
        previewId,
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].r;
    if (!r.reused)
      await audit(c, a, 'local_invoice.issue', r.document_id, {
        order_id: r.order_id,
        preview_id: previewId,
        number: r.number,
        scope_hash: r.scope_hash,
      });
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const result = await documentView(c, r.document_id);
    return { ...(await flags(c, a, true)), ...result, reused: Boolean(r.reused) };
  });
}
export async function localInvoicePreviewDetail(a: LocalInvoiceActor, id: string) {
  return transaction(a, false, async (c) => {
    const preview = await previewView(c, a, id);
    const f = await flags(c, a, false);
    preview.can_issue &&= f.can_write;
    return { ...f, preview };
  });
}
export async function localInvoiceDetail(a: LocalInvoiceActor, documentId: string) {
  return transaction(a, false, async (c) => {
    const result = await documentView(c, documentId);
    return { ...(await flags(c, a, false)), ...result };
  });
}

export async function localInvoiceRegister(a:LocalInvoiceActor,page:unknown={}) {
 const q=localInvoicePageQuery.parse(page);
 return transaction(a,false,async c=>{
  if(q.cursor)ensure((await c.query("SELECT id FROM documents WHERE id=$1 AND kind='invoice' AND mode='local_invoice'",[q.cursor])).rowCount,404,'Nie znaleziono własnego kursora FV');
  const rows=(await c.query(`SELECT id FROM documents WHERE kind='invoice' AND mode='local_invoice'
   AND ($1::uuid IS NULL OR(created_at,id)<(SELECT created_at,id FROM documents WHERE id=$1)) ORDER BY created_at DESC,id DESC LIMIT 51`,[q.cursor??null])).rows;
  const ids=rows.slice(0,50);const data=[];for(const row of ids)data.push((await documentView(c,row.id)).document);
  const result={data,next_cursor:rows.length>50?ids.at(-1)!.id:null};return{...result,...await flags(c,a,false)};
 });
}
