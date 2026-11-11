import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SaxesParser} from 'saxes';
import {buildApp} from '../server/app';
import {pool} from '../server/db';
import {publicApiDocument} from '../server/developer-api';
import {catalogStockControlPreviewInput,catalogStockControlCommitInput,catalogStockControlPageQuery,catalogStockControlExportQuery} from '../server/catalog-stock-control-schema';
import {seed} from './fixtures';
import {adjustmentActor} from './stocktake-adjustments-fixture';
import {bootstrap151169,install152169,fixture169,prepare169,allRows169,facts169,physicalExact169,prefix169,own169,type Row} from './catalog-stock-control169-fixture';

// Real buildApp/PG requests, without an authentication shim. Root runs later.
let app:Awaited<ReturnType<typeof buildApp>>,providers=0;
before(async()=>{await bootstrap151169();await seed();await install152169();app=await buildApp({integrationTransport:async()=>{providers++;throw Error('No external providers');}});});
after(async()=>{try{assert.equal(providers,0);await app?.close();}finally{await pool.end();}});
const money=new Set(['unit_cost_minor','value_minor','known_value_minor','known_quantity','zero_cost_quantity','unknown_quantity','currency','exponent','rows_sha256','frame','raw','nonce']);
function noMoney(value:unknown) {
  if(Array.isArray(value))return value.forEach(noMoney);
  if(value&&typeof value==='object')for(const[k,v]of Object.entries(value)){assert.equal(money.has(k),false,'No private value/frame/hash field: '+k);noMoney(v);}
}
async function issued(on=true) {
  const f=await fixture169(app,on),p=await prepare169(f);
  const operation=(await f.ok(prefix169+'/previews/'+p.preview.id+'/commit','POST',p.commit,201)).operation;
  assert.equal(operation.after.strict,true);assert.equal(operation.documents.length,2);
  const document=operation.documents.find((d:Row)=>d.warehouse.id===f.warehouse.id);assert(document);
  const rows=await allRows169(f,prefix169+'/documents/'+document.id+'/rows');assert.equal(rows.length,on?3:1);
  return {...f,p,operation,document,rows};
}

const csvColumns=['ordinal','source_ordinal','warehouse_id','product_id','sku','name','location','quantity','reserved','stock_version','bin_basis_hash','layer_id','lot_id','position_version'];
const costColumns=['unit_cost_minor','value_minor','currency','exponent'];
function csv169(text:string):string[][] {
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++) {
    const x=text[i];if(quoted){if(x==='"'){if(text[i+1]==='"'){cell+='"';i++;}else quoted=false;}else cell+=x;}
    else if(x==='"'){assert.equal(cell,'');quoted=true;}
    else if(x===','){row.push(cell);cell='';}
    else if(x==='\r'){assert.equal(text[++i],'\n');row.push(cell);rows.push(row);row=[];cell='';}
    else{assert.notEqual(x,'\n');cell+=x;}
  }
  assert.equal(quoted,false);if(row.length||cell){row.push(cell);rows.push(row);}return rows;
}
type Xml169={name:string;attrs:Record<string,string>;text:string;children:Xml169[]};
function xml169(content:string):Xml169 {
  const parser=new SaxesParser({xmlns:false}),stack:Xml169[]=[],roots:Xml169[]=[];
  parser.on('doctype',()=>assert.fail('No export DTD'));parser.on('error',e=>{throw e;});
  parser.on('opentag',tag=>{const n:Xml169={name:tag.name,attrs:Object.fromEntries(Object.entries(tag.attributes)) as Record<string,string>,text:'',children:[]};if(stack.length)stack.at(-1)!.children.push(n);else roots.push(n);stack.push(n);});
  parser.on('text',text=>{if(stack.length)stack.at(-1)!.text+=text;else assert.equal(text.trim(),'');});parser.on('closetag',()=>{assert(stack.pop());});parser.write(content).close();
  assert.equal(stack.length,0);assert.equal(roots.length,1);return roots[0];
}
function stripped169<T>(value:T,values:boolean):T {
  if(values)return value;
  if(Array.isArray(value))return value.map(x=>stripped169(x,false)) as T;
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!money.has(k)).map(([k,v])=>[k,stripped169(v,false)])) as T;
  return value;
}
function scalar169(v:unknown,formula=false) {
  const s=typeof v==='object'&&v!==null?JSON.stringify(v):String(v??'');return formula&&/^[=+@\-\t\r]/.test(s)?"'"+s:s;
}
function export169(reply:Row,document:Row,rows:Row[],values:boolean) {
  const expected=stripped169(document,values),keys=[...csvColumns,...(values?costColumns:[])];
  assert.deepEqual(reply.document,expected);assert.equal(reply.row_count,rows.length);assert.equal(reply.values_included,values);assert.equal(reply.filename,'BO-'+document.id+'.'+reply.format);
  if(reply.format==='csv') {
    assert.equal(reply.content_type,'text/csv; charset=utf-8');const parsed=csv169(reply.content),head=Object.entries(expected);
    assert.deepEqual(parsed[0],['record','key','value']);
    assert.deepEqual(parsed.slice(1,1+head.length),head.map(([k,v])=>['document',k,scalar169(v,true)]),'Every frozen BO header including full system number/warehouse/catalog/summary');
    assert.deepEqual(parsed[head.length+1],keys);
    assert.deepEqual(parsed.slice(head.length+2),rows.map(r=>keys.map(k=>scalar169(r[k],true))),'Entire independently saved physical/provenance/cost manifest and formula neutralization');
  }else{
    assert.equal(reply.content_type,'application/xml; charset=utf-8');const root=xml169(reply.content);assert.equal(root.name,'bo');assert.deepEqual(root.attrs,{});assert.deepEqual(root.children.map(n=>n.name),['header','rows']);
    const [head,body]=root.children;assert.deepEqual(head.children.map(n=>n.name),Object.keys(expected));
    for(const node of head.children){assert.deepEqual(node.attrs,{});assert.equal(node.text,scalar169(expected[node.name]));assert.equal(node.children.length,0);}
    assert.equal(body.children.length,rows.length);
    body.children.forEach((node,i)=>{assert.equal(node.name,'row');assert.deepEqual(node.attrs,{});assert.deepEqual(node.children.map(n=>n.name),keys);node.children.forEach((n,j)=>{const v=rows[i][keys[j]];assert.deepEqual(n.attrs,v===null?{nil:'true'}:{});assert.equal(n.text,scalar169(v));assert.equal(n.children.length,0);});});
  }
}

test('normal and restored OpenAPI describe actual BO authority, separate consent, bounded fullrows and v1 inventory/value scopes',()=>{
  for(const readOnly of [false,true]) {
    const doc=publicApiDocument(readOnly?{readOnly:true,port:4199}:undefined),paths=doc.paths as Record<string,Row>;
    const reads=['/catalogs/{id}/source','/previews/{id}','/previews/{id}/rows','/operations/{id}','/documents/{id}','/documents/{id}/rows','/documents/{id}/export','/history'];
    for(const path of reads){const op=paths[prefix169+path]?.get;assert(op,path);assert.deepEqual(op['x-required-scopes'],['inventory:read']);for(const code of ['401','403','404','422','503'])assert(op.responses[code]);}
    for(const path of ['/catalogs/{id}/previews','/previews/{id}/commit']) {
      if(readOnly){assert.equal(paths[prefix169+path]?.post,undefined,'Restored public OpenAPI omits write operations');continue;}
      const op=paths[prefix169+path]?.post;assert(op,path);assert.deepEqual(op['x-required-scopes'],['inventory:read','inventory:write']);
      assert(op.responses['409']);assert(op.responses['423']);assert(op.responses['503']);
    }
    for(const path of ['/previews/{id}/rows','/documents/{id}/rows']){
      const q=paths[prefix169+path].get.parameters as Row[];assert.equal(q.find(p=>p.name==='limit')?.schema.maximum,100);assert.equal(q.find(p=>p.name==='cursor')?.schema.maximum,10000);
    }
    const value=paths[prefix169+'/documents/{id}/export'].get;
    assert.deepEqual(value['x-value-required-scopes'],['purchasing:read']);assert.equal(value['x-value-required-role'],'admin');
  }
});
test('strict public parsers reject principal/tenant/rawstock/cost injection and incomplete or noncanonical CAS',()=>{
  const body={client_key:randomUUID(),catalog_version:'1',policy_version:'0',warehouse_policy_versions:[{warehouse_id:randomUUID(),version:'0'}],series_versions:[{warehouse_id:randomUUID(),version:'0'}]};
  assert(catalogStockControlPreviewInput.safeParse(body).success);
  for(const extra of [{actor_id:randomUUID()},{tenant_id:randomUUID()},{strict:true},{stock:[]},{unit_cost_minor:'1'},{skip_validation:true}])assert(!catalogStockControlPreviewInput.safeParse({...body,...extra}).success);
  for(const catalog_version of ['01','-1','1.0','9223372036854775807'])assert(!catalogStockControlPreviewInput.safeParse({...body,catalog_version}).success);
  assert(!catalogStockControlPreviewInput.safeParse({...body,warehouse_policy_versions:[body.warehouse_policy_versions[0],body.warehouse_policy_versions[0]]}).success);
  const consent={client_key:randomUUID(),scope_hash:'a'.repeat(64),confirmed:true};assert(catalogStockControlCommitInput.safeParse(consent).success);
  for(const extra of [{confirmed:false},{actor_id:randomUUID()},{physical_receipt:{}},{nonce:randomUUID()}])assert(!catalogStockControlCommitInput.safeParse({...consent,...extra}).success);
  for(const q of [{limit:'101'},{cursor:'10001'},{cursor:'-1'},{tenant_id:randomUUID()}])assert(!catalogStockControlPageQuery.safeParse(q).success);
  for(const q of [{format:'pdf'},{format:'csv',include_values:true},{format:'xml',include_values:'1'}])assert(!catalogStockControlExportQuery.safeParse(q).success);
});
for(const on of [false,true])test(`${on?'ON known0/1000/NULL':'OFF'} complete v1 CSV/XML bind independently saved BO payload/rows and repeated exact bytes`,async()=>{
  const f=await issued(on),key=await f.ok('/developer/keys','POST',{name:'Own complete BO export169',scopes:['inventory:read','purchasing:read']},201),before=await facts169();
  const stored=own169(before,'catalog_stock_control_documents',f.tenant).find(d=>d.id===f.document.id);assert(stored);
  const savedRows=own169(before,'catalog_stock_control_rows',f.tenant).filter(r=>r.document_id===f.document.id).sort((a,b)=>a.ordinal-b.ordinal).map(r=>({...r.payload,source_ordinal:r.payload.ordinal,ordinal:r.ordinal}));
  assert.equal(savedRows.length,on?3:1);assert.deepEqual(savedRows,f.rows);
  for(const values of [false,...(on?[true]:[])])for(const format of ['csv','xml']){
    const path=prefix169+'/documents/'+f.document.id+'/export?format='+format+'&include_values='+values;
    const first=await f.ok(path,'GET',undefined,200,key),second=await f.ok(path,'GET',undefined,200,key);
    export169(first,stored.payload,savedRows,values);export169(second,stored.payload,savedRows,values);assert.equal(second.content,first.content,'Downloaded bytes never contain transient RR read-time');
  }
  assert.deepEqual(await facts169(),before,'Exports do not change number, stock, layers, counters, session or audit');
});
test('actual inventory-only v1 and viewer read saved BO, never costs/privateframe/hash; active source cannot retain old admin access',async()=>{
  const f=await issued(),key=await f.ok('/developer/keys','POST',{name:'Own BO quantity-only169',scopes:['inventory:read']},201);
  const viewer=await adjustmentActor(app,f.tenant,'viewer@demo.local');await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",[f.tenant,viewer.user]);
  const before=await facts169();
  for(const reader of [{request:(p:string)=>f.request(p,'GET',undefined,key)},{request:(p:string)=>viewer.request(p)}]) {
    for(const path of ['/operations/'+f.operation.id,'/documents/'+f.document.id,'/documents/'+f.document.id+'/rows','/history?limit=1']){
      const r=await reader.request(prefix169+path);assert.equal(r.statusCode,200);assert.equal(r.json().can_read_value,false);noMoney(r.json());
    }
    for(const format of ['csv','xml']){
      const r=await reader.request(prefix169+'/documents/'+f.document.id+'/export?format='+format+'&include_values=false');assert.equal(r.statusCode,200);
      assert.equal(r.json().values_included,false);noMoney(r.json().document);
      for(const k of money)assert.equal(r.json().content.includes(k),false,'No value/hash key in download: '+k);
    }
    assert.equal((await reader.request(prefix169+'/catalogs/'+f.secondary.id+'/source')).statusCode,403,'An active expected-stock snapshot is admin-only');
  }
  assert.equal((await f.request(prefix169+'/documents/'+f.document.id+'/export?format=csv&include_values=true','GET',undefined,key)).statusCode,403);
  assert.deepEqual(await facts169(),before,'All denied/quantity reads preserve every global row and sessions');
});
test('foreign workspace cannot read/replay another catalog BO; unsupported authority and restore normal/v1 malformed writes fail before parse',async()=>{
  const f=await issued(false),other=await fixture169(app),key=await f.ok('/developer/keys','POST',{name:'Own restored BO reader169',scopes:['inventory:read']},201),before=await facts169();
  for(const path of ['/catalogs/'+f.primary.id+'/source','/previews/'+f.p.preview.id,'/operations/'+f.operation.id,'/documents/'+f.document.id,'/documents/'+f.document.id+'/rows'])assert.equal((await other.request(prefix169+path)).statusCode,404,path);
  assert.equal((await other.request(prefix169+'/previews/'+f.p.preview.id+'/commit','POST',f.p.commit)).statusCode,404);
  const copy=await buildApp({readOnly:true});
  try{
    for(const ns of ['/api','/api/v1'])for(const path of ['/catalogs/'+f.primary.id+'/previews','/previews/'+f.p.preview.id+'/commit']){
      const r=await copy.inject({method:'POST',url:ns+prefix169+path,headers:{'content-type':'application/json'},payload:'{'});assert.equal(r.statusCode,423,'Read-only fence precedes malformed parser and login');
    }
    const r=await copy.inject({method:'GET',url:'/api/v1'+prefix169+'/documents/'+f.document.id,headers:{authorization:'Bearer '+key.token}});
    assert.equal(r.statusCode,200);assert.equal(r.json().read_only,true);assert.equal(r.json().document.id,f.document.id);
  }finally{await copy.close();}
  assert.deepEqual(await facts169(),before);physicalExact169(before,await facts169());
});
