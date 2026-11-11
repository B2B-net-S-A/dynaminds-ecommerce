/** SOURCE_AUTHORED / NOT_RUN. Independent159 oracle; no DB, renderer/service,
 * auth, numbering or actual native validator imports. Caller supplies native rows
 * from genuine approved158/issued159 API fixtures and independently fixed budgets. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export type Row159=Record<string,any>;
export type Rows159=Record<string,{row:Row159}[]>;
export function canonical159(value:unknown):unknown{
 return Array.isArray(value)?value.map(canonical159):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical159(v)])):value;
}
export const hash159=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical159(value))).digest('hex');
function keys(row:Row159,expected:string[]){assert.deepEqual(Object.keys(row).sort(),expected.sort());}
function minor(value:unknown):bigint{assert(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value));return BigInt(value);}
function one(rows:Row159[]):Row159{assert.equal(rows.length,1);return rows[0];}

/** Complete ordered commercial lines, including zero shipping; no unit cost
 * inference and no quantity/cost redaction substituted for invoice money. */
export function assertFiscalMoney159(draft:Row159){
 assert.equal(draft.schema,'b2b-fa3-draft/v1');assert.equal(draft.state,'draft');assert.equal(draft.currency,'PLN');
 assert.equal(draft.tax_method,'gross_line_half_up');assert(Array.isArray(draft.lines)&&draft.lines.length>=2&&draft.lines.length<=101);
 const lineIds=new Set<string>(),itemIds:string[]=[];let net=0n,vat=0n,gross=0n;
 const buckets=new Map<string,{net:bigint;vat:bigint;gross:bigint}>();
 for(const [i,line]of draft.lines.entries()){
  keys(line,['ordinal','line_id','kind','source_item_id','name','unit','quantity','unit_gross_minor','discount_gross_minor','rounding_gross_minor','gross_minor','net_minor','vat_minor','vat_code','zero_domestic_basis']);
  assert.equal(line.ordinal,i+1);assert(!lineIds.has(line.line_id));lineIds.add(line.line_id);
  const last:boolean=i===draft.lines.length-1;assert.equal(line.kind,last?'shipping':'item');
  if(last){assert.equal(line.source_item_id,null);assert.equal(line.quantity,'1');}else{assert.equal(line.source_item_id,line.line_id);itemIds.push(line.source_item_id);}
  const q=minor(line.quantity);assert(q>0n);const unit=minor(line.unit_gross_minor),discount=minor(line.discount_gross_minor);
  assert.equal(line.rounding_gross_minor,'0','First159 excludes unsupported positive native rounding');
  const g=minor(line.gross_minor);assert.equal(g,q*unit-discount);assert(['0 KR','5','8','23'].includes(line.vat_code));
  const rate=line.vat_code==='0 KR'?0n:BigInt(line.vat_code),den=100n+rate;
  const n=(g*100n+den/2n)/den,v=g-n;assert.equal(line.net_minor,n.toString());assert.equal(line.vat_minor,v.toString());
  if(rate===0n)assert(typeof line.zero_domestic_basis==='string'&&line.zero_domestic_basis.length>0);else assert.equal(line.zero_domestic_basis,null);
  net+=n;vat+=v;gross+=g;const b=buckets.get(line.vat_code)??{net:0n,vat:0n,gross:0n};b.net+=n;b.vat+=v;b.gross+=g;buckets.set(line.vat_code,b);
 }
 assert.deepEqual(draft.source.item_ids,itemIds);assert.equal(new Set(itemIds).size,itemIds.length);
 assert.deepEqual(draft.totals,{gross_minor:gross.toString(),net_minor:net.toString(),vat_minor:vat.toString()});
 assert.equal(minor(draft.source.order_total_minor),gross);assert.equal(minor(draft.source.shipping_gross_minor),minor(draft.lines.at(-1).gross_minor));
 return [...buckets.entries()].sort(([a],[b])=>(a==='0 KR'?0:Number(a))-(b==='0 KR'?0:Number(b))).map(([vat_code,b])=>({vat_code,net_minor:b.net.toString(),vat_minor:b.vat.toString(),gross_minor:b.gross.toString()}));
}

export type IssuedBasis159={tenant:string;actor:string;apiKey:string|null;project:Row159;projectReceipt:Row159;originalPreview:Row159;series:Row159;seriesCommand:Row159;
 previewRequest:Row159;issueRequest:Row159;sequence:number;issueDate:string;paymentMode:'prepaid'|'cod'};

/** Caller resolves each private row by its actual own compound PK. Sequence is
 * a fixed expected input, never read from the produced counter to set the oracle. */
export function assertIssuedGraph159(b:IssuedBasis159,privateRows:{preview:Row159;admission:Row159;receipt:Row159;document:Row159;counter:Row159;namespace:Row159},reply:Row159){
 const {preview:p,admission:a,receipt:r,document:d,counter:c,namespace:ns}=privateRows;
 assert.equal(b.project.state,'approved_project');assert.equal(b.project.issued,false);assert.equal(b.project.ksef_state,'not_submitted');
 assert.equal(b.projectReceipt.project_id,b.project.id);assert.equal(b.projectReceipt.preview_id,b.project.preview_id);
 assert.equal(b.originalPreview.id,b.project.preview_id);assert.equal(b.originalPreview.tenant_id,b.tenant);
 assert.equal(b.originalPreview.order_id,b.project.order_id);assert.equal(b.originalPreview.series_id,b.series.id);
 assert.deepEqual(b.originalPreview.draft,b.project.draft);assert.equal(b.originalPreview.draft_hash,b.project.draft_hash);
 assert.equal(b.originalPreview.scope_hash,b.project.scope_hash);assert.equal(b.projectReceipt.scope_hash,b.project.scope_hash);
 assertFiscalMoney159(b.project.draft);assert.equal(b.project.draft_hash,hash159(b.project.draft));
 for(const x of [p,a,r,d,c,ns])assert.equal(x.tenant_id,b.tenant);
 assert.equal(p.project_id,b.project.id);assert.equal(p.project_receipt_id,b.projectReceipt.id);assert.equal(p.order_id,b.project.order_id);assert.equal(p.series_id,b.series.id);
 assert.equal(p.actor_id,b.actor);assert.equal(p.api_key_id,b.apiKey);assert.deepEqual(p.request,b.previewRequest);
 assert.equal(p.client_key,b.previewRequest.client_key);assert.equal(p.request_hash,hash159({request:b.previewRequest,actor:b.actor,key:b.apiKey}));
 assert.deepEqual(p.source,b.originalPreview.source);
 assert.deepEqual(p.source.series,b.series);assert.deepEqual(p.source.command,b.seriesCommand);assert.equal(b.seriesCommand.request_hash,b.series.request_hash);
 assert.equal(p.source.order.id,b.project.order_id);assert.equal(p.source.order.tenant_id,b.tenant);assert.equal(p.source.order.payment_mode,b.paymentMode);
 assert.deepEqual(p.source.items.map((x:Row159)=>x.id),b.project.draft.source.item_ids);
 assert.equal(b.project.draft.source.tenant_id,b.tenant);assert.equal(b.project.draft.source.order_id,b.project.order_id);
 assert.equal(b.project.draft.source.order_version,String(p.source.order.version));
 assert.equal(b.project.draft.source.order_total_minor,String(p.source.order.total));
 assert.equal(b.project.draft.source.shipping_gross_minor,String(p.source.order.shipping_cost));
 for(const [i,item]of p.source.items.entries()){
  const line=b.project.draft.lines[i];assert.equal(line.source_item_id,item.id);assert.equal(line.name,item.name);
  assert.equal(line.quantity,String(item.quantity));assert.equal(line.unit_gross_minor,String(item.price));
  assert.equal(line.gross_minor,String(item.line_total));assert.equal(line.vat_code,item.vat===0?'0 KR':String(item.vat));
 }
 const date=new Date(b.issueDate+'T12:00:00Z');assert.equal(date.toISOString().slice(0,10),b.issueDate);date.setUTCDate(date.getUTCDate()+b.series.definition.payment_terms_days);
 const snapshot={schema:'b2b-local-invoice/v1',project_id:b.project.id,project_receipt_id:b.projectReceipt.id,project_hash:b.project.draft_hash,
 project_scope_hash:b.project.scope_hash,fiscal_snapshot:b.project.draft,order_number:p.source.order.number,series_id:b.series.id,series_definition:b.series.definition,
 series_command_hash:b.seriesCommand.request_hash,issue_date:b.issueDate,sale_date:b.project.draft.sale_date,due_date:date.toISOString().slice(0,10),
 payment_mode:b.paymentMode,local_only:true,ksef_state:'not_submitted',fiscalized:false};
 assert.deepEqual(p.snapshot,snapshot);assert.equal(p.scope_hash,hash159({request:b.previewRequest,source:p.source,snapshot}));
 assert(Date.parse(p.expires_at)-Date.parse(p.created_at)>=899000);assert(Date.parse(p.expires_at)-Date.parse(p.created_at)<=901000);
 assert.deepEqual(b.issueRequest,{client_key:b.issueRequest.client_key,scope_hash:p.scope_hash,confirmed:true,local_only:true});
 const year=Number(b.issueDate.slice(0,4)),number=`FV-B2B/${b.series.prefix}/${year}/${String(b.sequence).padStart(6,'0')}`;
 const data={...snapshot,number,year,sequence:b.sequence,preview_id:p.id,scope_hash:p.scope_hash};
 for(const x of [a,r]){
  assert.equal(x.preview_id,p.id);assert.equal(x.project_id,b.project.id);assert.equal(x.actor_id,b.actor);assert.equal(x.api_key_id,b.apiKey);
  assert.deepEqual(x.request,b.issueRequest);assert.equal(x.client_key,b.issueRequest.client_key);assert.equal(x.request_hash,hash159({preview:p.id,request:b.issueRequest,actor:b.actor,key:b.apiKey}));
  assert.equal(x.number,number);assert.equal(x.year,year);assert.equal(x.sequence,b.sequence);assert(/^[1-9][0-9]*$/.test(String(x.root_xid)));assert(x.transaction_started_at);
 }
 assert.equal(a.id,r.id);assert.equal(a.document_id,d.id);assert.equal(r.document_id,d.id);assert.equal(a.root_xid,r.root_xid);assert.equal(a.transaction_started_at,r.transaction_started_at);
 assert.equal(r.project_receipt_id,b.projectReceipt.id);assert.equal(r.order_id,b.project.order_id);assert.equal(r.series_id,b.series.id);assert.equal(r.scope_hash,p.scope_hash);assert.deepEqual(r.snapshot,data);
 assert.equal(d.order_id,b.project.order_id);assert.equal(d.kind,'invoice');assert.equal(d.mode,'b2b_invoice');assert.equal(d.number,number);assert.equal(d.channel_id,null);assert.equal(d.external_id,null);assert.equal(d.return_id,null);assert.deepEqual(d.data,data);
 assert.equal(c.series_id,b.series.id);assert.equal(c.year,year);assert.equal(c.last_number,b.sequence);
 keys(ns,['seller_tax_id','prefix','tenant_id','series_id','claimed_at']);assert.equal(ns.series_id,b.series.id);
 assert.equal(ns.seller_tax_id,b.series.definition.seller.tax_id);assert.equal(ns.prefix,b.series.prefix);
 keys(reply,['document','receipt','reused']);assert.equal(reply.reused,false);
 assert.deepEqual(reply.document,{id:d.id,order_id:d.order_id,kind:'invoice',mode:'b2b_invoice',number,data,created_at:d.created_at});
 assert.deepEqual(reply.receipt,{id:r.id,document_id:d.id,preview_id:p.id,project_id:b.project.id,project_receipt_id:b.projectReceipt.id,
 client_key:b.issueRequest.client_key,scope_hash:p.scope_hash,year,sequence:b.sequence,number,issued_at:r.issued_at});
 return {number,data,vat_buckets:assertFiscalMoney159(data.fiscal_snapshot)};
}

/** Every table defaults to zero append. Exact actual PK retention protects own,
 * foreign/global/auth/physical/payment histories without wildcard exceptions.
 * Deliberate migration metadata differences belong to a separate typed oracle. */
export function assertLiteralAppend159(before:Rows159,after:Rows159,primaryKeys:Record<string,string[]>,fixedCounts:Record<string,number>){
 assert.deepEqual(Object.keys(after).sort(),Object.keys(before).sort());assert.equal(Object.keys(after).length,542);
 for(const table of Object.keys(fixedCounts)){assert(table in before);assert(Number.isInteger(fixedCounts[table])&&fixedCounts[table]>=0);}
 const additions:Record<string,Row159[]>={};
 for(const table of Object.keys(before)){
  const pk=primaryKeys[table];assert(pk&&pk.length>0);const key=(r:Row159)=>JSON.stringify(pk.map(k=>{assert(k in r);return r[k];}));
  const old=new Map(before[table].map(x=>[key(x.row),x.row])),current=new Map(after[table].map(x=>[key(x.row),x.row]));
  assert.equal(old.size,before[table].length);assert.equal(current.size,after[table].length);
  for(const [id,row]of old)assert.deepEqual(current.get(id),row,'Old literal row retained: '+table);
  additions[table]=[...current].filter(([id])=>!old.has(id)).map(([,row])=>row);
  assert.equal(additions[table].length,fixedCounts[table]??0,'Fixed append budget: '+table);
 }
 return additions;
}
