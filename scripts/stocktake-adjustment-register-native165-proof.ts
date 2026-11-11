/** ROOT ONLY. GET and RR READ ONLY custody; never posts, logs in or repairs.
 * QA165_SCOPE=primary|copy, QA165_PHASE=before|after,
 * QA165_CONFIRM=READ_ONLY_REGISTER_165, DYNA_WORKER_DISABLED=true.
 * After also requires QA_EXPECTED_REVISION and QA165_BEFORE_SHA256 plus
 * QA165_ADDED_SESSIONS_JSON={off:[sha256],on:[sha256]} (<=1 own login each).
 * New exclusive checkpoints retain the entire prior464-table history.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { SaxesParser } from 'saxes';
import { captureStocktakeAdjustmentReadback, validateStocktakeAdjustmentReceipt, type StocktakeAdjustmentCapture } from './stocktake-adjustments-native164-readback';
type Row=Record<string,any>;
const ROOT='<workspace>/app', SCHEMA='149_stocktake_adjustments';
const HASH=/^[a-f0-9]{64}$/, REV=/^[a-f0-9]{40}$/;
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const pins={config:'9a2c81811d1ffdb6c52aabdd77dddf3ac1975bd8cc2c2d2957882b338dd7b660',
  setup:'78617b72b5a5564402705bf1e6d9309e5d84d947f0a8cd3b52dac82abb1a7ad8',
  sql:'a4ec349804e0bddddbe595669b3a87f432a72cc9f1b19af2eb80aabf6b902264',
  primary:'185a5d3d83fd562acae61dbd4b9020867725bb2487a0c55e579eb25113e3eb40',
  copy:'634887fd29cdc432314a1dd8c4cf43ab9ad158e2b6a236046ed46a4b4937432e',
  result:'c03e271483a77dad4448b7325b2f6b7cb13e14e80ca6fa87fce423d1e10aeb5c'};
const baselinePaths={primary:'data/stocktake-adjustments-native164-restart-readback.json',copy:'data/stocktake-adjustments-native164-restored-ui-api.json'};
const oldRevisions={primary:'44d60f8f8fd2cd7fe3fc50eb4557c9e84b23621c',copy:'39baa5a6a7ebdeba00e7ca59e7669c0982bdb8ec'};
const resultPath=resolve(ROOT,'data/stocktake-adjustments-backup164-1a8a5ffe-dd27-4a8e-8d7b-239a93684af0/restore/7add0957b206bbc5/result.json');
async function bytes(p:string,privateFile=true){
  const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(await realpath(p),p);
  assert(s.size>0&&s.size<=512*1024*1024);if(privateFile)assert.equal(s.mode&0o777,0o600);
  const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const same=(n:typeof s)=>{for(const k of ['dev','ino','mode','size','mtimeMs']as const)assert.equal(n[k],s[k]);};
    same(await f.stat());const b=await f.readFile();same(await f.stat());same(await lstat(p));assert.equal(b.length,s.size);return b;
  }finally{await f.close();}
}
async function absent(p:string){try{await lstat(p);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Exclusive evidence exists');}
async function wx(p:string,b:Buffer|string,mode:number){
  const d=await lstat(dirname(p));assert(d.isDirectory()&&!d.isSymbolicLink());assert.equal(await realpath(dirname(p)),dirname(p));
  const f=await open(p,'wx',mode);try{await f.writeFile(b);await f.sync();}finally{await f.close();}
  const fd=await open(dirname(p),'r');try{await fd.sync();}finally{await fd.close();}return sha(b);
}
const json=(v:unknown)=>JSON.stringify(v,null,2)+'\n';
const moneyKeys=new Set(['currency','exponent','unit_cost_minor','value_minor','known_pw_minor','known_rw_minor','unknown_pw_quantity','unknown_rw_quantity','rows_sha256','_exponent']);
function quantityOnly(v:any):any {if(Array.isArray(v))return v.map(quantityOnly);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!moneyKeys.has(k)).map(([k,x])=>[k,quantityOnly(x)]));return v;}
type XmlNode={name:string;attrs:Record<string,string>;text:string;children:XmlNode[]};
function xml(content:string){let root:XmlNode|undefined;const stack:XmlNode[]=[];const p=new SaxesParser();
  p.on('doctype',()=>assert.fail('No DTD in export'));
  p.on('opentag',n=>{const node:XmlNode={name:n.name,attrs:Object.fromEntries(Object.entries(n.attributes)) as Record<string,string>,text:'',children:[]};if(stack.length)stack.at(-1)!.children.push(node);else{assert.equal(root,undefined);root=node;}stack.push(node);});
  p.on('text',t=>{if(stack.length)stack.at(-1)!.text+=t;else assert.equal(t.trim(),'');});
  p.on('closetag',()=>{assert(stack.length);stack.pop();});p.write(content).close();assert(root);assert.equal(stack.length,0);return root;
}
function xmlExact(n:XmlNode,v:any){
  if(v===null||v===undefined){assert.deepEqual(n.attrs,{nil:'true'});assert.equal(n.text,'');assert.equal(n.children.length,0);return;}
  assert.deepEqual(n.attrs,{});
  if(typeof v==='object'){assert(!Array.isArray(v));assert.equal(n.text,'');assert.deepEqual(n.children.map(x=>x.name).sort(),Object.keys(v).sort());for(const x of n.children)xmlExact(x,v[x.name]);}
  else{assert.equal(n.children.length,0);assert.equal(n.text,String(v));}
}
function csvText(v:any){if(v===null||v===undefined)return '';return typeof v==='string'&&/^[\s]*[=+\-@\t\r\n]/u.test(v)?"'"+v:String(v);}
function csv(content:string){
  const records:string[][]=[],row:string[]=[];let field='',quoted=false;
  for(let i=0;i<content.length;i++){const ch=content[i];
    if(ch==='"'){if(quoted&&content[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(ch===','&&!quoted){row.push(field);field='';}
    else if(ch==='\r'&&!quoted&&content[i+1]==='\n'){row.push(field);records.push([...row]);row.length=0;field='';i++;}
    else field+=ch;
  }assert.equal(quoted,false);assert.equal(field,'');assert.equal(row.length,0);
  const columns=records.shift()!;assert.equal(new Set(columns).size,columns.length);
  return records.map(r=>{assert.equal(r.length,columns.length);return Object.fromEntries(columns.map((c,i)=>[c,r[i]]));});
}
async function main(){
  let step='preflight',c:pg.Client|undefined,gets=0;
  try{
    assert.equal(process.cwd(),ROOT);assert.equal(await realpath(process.cwd()),ROOT);
    assert.equal(process.env.QA165_CONFIRM,'READ_ONLY_REGISTER_165');assert.equal(process.env.DYNA_WORKER_DISABLED,'true');
    for(const k of ['DATABASE_URL','DYNA_TEST'])assert.equal(process.env[k],undefined);
    const scope=process.env.QA165_SCOPE,phase=process.env.QA165_PHASE;assert(scope==='primary'||scope==='copy');assert(phase==='before'||phase==='after');
    const attempt=process.env.QA165_ATTEMPT??'1';assert(/^[1-9]$/.test(attempt));if(phase==='before')assert.equal(attempt,'1');const suffix=attempt==='1'?'':`-attempt${attempt}`;
    const revision=phase==='before'?oldRevisions[scope]:process.env.QA_EXPECTED_REVISION??'';assert.match(revision,REV);
    const output=resolve(ROOT,`data/stocktake-adjustment-register-native165-${scope}-${phase}${suffix}.json`),publicOutput=resolve(ROOT,`docs/stocktake-adjustment-register-native165-${scope}-${phase}${suffix}.json`);
    await absent(output);await absent(publicOutput);await absent(output+'.intent.json');
    const retained=new Map<string,{hash:string,privateFile:boolean}>();
    async function pin(p:string,h:string,priv=true){assert.match(h,HASH);const b=await bytes(p,priv);assert.equal(sha(b),h);retained.set(p,{hash:h,privateFile:priv});return b;}
    const config=JSON.parse((await pin(resolve(ROOT,'.local.json'),pins.config)).toString())as Row;
    const setup=JSON.parse((await pin(resolve(ROOT,'data/stocktake-adjustments-native164-setup.json'),pins.setup)).toString())as Row;
    assert.equal(setup.stage,164);assert.equal(setup.schema,SCHEMA);assert.deepEqual(setup.actors.map((a:Row)=>[a.label,a.on]),[['OFF',false],['ON',true]]);
    await pin(resolve(ROOT,'server/149_stocktake_adjustments.sql'),pins.sql,false);
    const original=JSON.parse((await pin(resolve(ROOT,baselinePaths[scope]),pins[scope])).toString())as Row;
    assert.equal(original.schema,SCHEMA);assert.equal(original.runtime_revision,oldRevisions[scope]);
    let database='dynaminds',dbConfig=config;
    if(scope==='copy'){
      const result=JSON.parse((await pin(resultPath,pins.result)).toString())as Row;
      assert.equal(result.database,'dynaminds_restore_7add0957b206bbc5');assert.equal(result.status,'verified');assert.equal(result.preview_only,true);assert.equal(result.worker_enabled,false);
      assert.equal(result.config,resolve(dirname(resultPath),'local-config.json'));database=result.database;
      const b=await bytes(result.config);retained.set(result.config,{hash:sha(b),privateFile:true});dbConfig=JSON.parse(b.toString());
    }
    let baseline=original;
    if(phase==='after'){
      const b=process.env.QA165_BEFORE_SHA256??'';assert.match(b,HASH);
      baseline=JSON.parse((await pin(resolve(ROOT,`data/stocktake-adjustment-register-native165-${scope}-before.json`),b)).toString())as Row;
      assert.equal(baseline.stage,165);assert.equal(baseline.phase,'before');assert.equal(baseline.scope,scope);assert.deepEqual(baseline.capture,original.capture);assert.deepEqual(baseline.proof,original.proof);
    }
    async function custody(){for(const[p,v]of retained)assert.equal(sha(await bytes(p,v.privateFile)),v.hash);}
    async function get(a:Row|null,path:string,status=200){
      assert(path==='/health'||path==='/auth/me'||/^\/stocktake-adjustments\//.test(path));assert(!path.includes('#'));
      const cookie=a?.cookie?.replace(/^dyna_session=/,scope==='copy'?'dyna_session_preview_4198=':'dyna_session=');
      gets++;const r=await fetch(`http://127.0.0.1:${scope==='copy'?4198:4100}/api`+path,{method:'GET',headers:a?{cookie,'X-Workspace-ID':a.tenant_id}:{},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});
      assert.equal(r.status,status);const b=Buffer.from(await r.arrayBuffer());assert(b.length<=8*1024*1024);return JSON.parse(b.toString())as Row;
    }
    async function health(){const h=await get(null,'/health');assert.equal(h.status,'ok');assert.equal(h.mode,'local');assert.equal(h.revision,revision);assert.equal(h.schema_revision,SCHEMA);assert.equal(h.restore_preview,scope==='copy');assert.equal(h.background_workers_enabled,false);assert.equal(h.stocktake_adjustments_available,true);}
    await custody();await health();await wx(output+'.intent.json',json({stage:165,scope,phase,revision,baseline_sha256:phase==='before'?pins[scope]:process.env.QA165_BEFORE_SHA256,action:'READ_ONLY_NO_REPAIR'}),0o600);
    c=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:dbConfig.dbPassword,database,connectionTimeoutMillis:5000,options:'-c default_transaction_read_only=on -c TimeZone=UTC'});c.on('error',()=>{});await c.connect();
    async function capture(){assert(c);await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");
      try{assert.deepEqual((await c.query("SELECT current_database() db,current_user role,host(inet_server_addr()) host,inet_server_port() port")).rows[0],{db:database,role:'postgres',host:'127.0.0.1',port:55432});const cap=await captureStocktakeAdjustmentReadback(c);await c.query('COMMIT');return cap;}catch(e){await c.query('ROLLBACK');throw e;}}
    step='capture';const cap=await capture();assert.deepEqual(cap.portable_metadata,baseline.capture.portable_metadata);assert.deepEqual(cap.proof_hashes,baseline.capture.proof_hashes);
    const sessionDeltas:Row={off:0,on:0};
    if(phase==='before')assert.deepEqual(cap,baseline.capture,'Exact previous immutable checkpoint including sessions');
    else{
      const expected=JSON.parse(process.env.QA165_ADDED_SESSIONS_JSON??'null')as Row;assert(expected);assert.deepEqual(Object.keys(expected).sort(),['off','on']);
      for(const name of Object.keys(cap.rows)){if(name!=='sessions'){assert.deepEqual(cap.rows[name],baseline.capture.rows[name],name);assert.deepEqual(cap.fingerprints[name],baseline.capture.fingerprints[name],name);}}
      const old=baseline.capture.rows.sessions.map((x:Row)=>x.row),now=cap.rows.sessions.map(x=>x.row);
      for(const r of old)assert.deepEqual(now.filter(x=>x.token_hash===r.token_hash),[r],'Every old session retained exactly');
      const added=now.filter(x=>!old.some((o:Row)=>o.token_hash===x.token_hash));const allowed:string[]=[];
      for(const a of setup.actors){const k=a.on?'on':'off';assert(Array.isArray(expected[k])&&expected[k].length<=1);for(const h of expected[k])assert.match(h,HASH);
        const own=added.filter(x=>x.user_id===a.user_id&&x.tenant_id===a.tenant_id);assert.deepEqual(own.map(x=>x.token_hash).sort(),[...expected[k]].sort());allowed.push(...expected[k]);sessionDeltas[k]=own.length;
      }assert.deepEqual(added.map(x=>x.token_hash).sort(),allowed.sort());assert.equal(new Set(allowed).size,allowed.length);
    }
    const proof:Row={},exports:Row[]=[];
    for(const a of setup.actors){const k=a.on?'on':'off';const g=validateStocktakeAdjustmentReceipt(cap,a,original.proof[k].receipt_id);assert.deepEqual(g,original.proof[k]);proof[k]=g;
      if(phase==='before')continue;step=k+':api';const me=await get(a,'/auth/me');assert.equal(me.user.id,a.user_id);assert.equal(me.user.tenant_id,a.tenant_id);assert.equal(me.user.role,'admin');
      const flags=await get(a,'/stocktake-adjustments/options');assert.equal(flags.can_read,true);assert.equal(flags.can_read_value,true);assert.equal(flags.read_only,scope==='copy');assert.equal(flags.can_write,scope==='primary');
      const data:Row[]=[];let cursor:string|null=null;
      do{const r=await get(a,'/stocktake-adjustments/register?'+new URLSearchParams({limit:'1',...(cursor?{cursor}:{})}));assert.equal(r.meta.limit,1);assert.equal(r.data.length,1);data.push(...r.data);cursor=r.meta.cursor;assert(cursor===null||typeof cursor==='string');assert(data.length<=2);}while(cursor);
      assert.deepEqual(data.map(d=>d.id).sort(),g.documents.map(d=>d.id).sort());
      const from=new Date(Math.min(...g.documents.map(d=>Date.parse(d.created_at)))-1000).toISOString(),to=new Date(Math.max(...g.documents.map(d=>Date.parse(d.created_at)))+1000).toISOString();
      for(const d of g.documents){
        const filtered=await get(a,'/stocktake-adjustments/register?'+new URLSearchParams({kind:d.kind,source_kind:g.source_kind,warehouse_id:a.warehouse.id,number_prefix:d.number,from,to,limit:'50'}));
        assert.deepEqual(filtered.data.map((x:Row)=>x.id),[d.id]);assert.equal(filtered.meta.cursor,null);
        const receipt=await get(a,'/stocktake-adjustments/receipts/'+g.receipt_id);assert.equal(receipt.receipt.id,g.receipt_id);assert.equal(receipt.documents.length,2);
        const rows=await get(a,'/stocktake-adjustments/documents/'+d.id+'/rows?limit=100');const expectedRows=g.document_rows.filter(x=>x.document_id===d.id).sort((x,y)=>x.ordinal-y.ordinal).map(x=>Object.fromEntries(Object.entries(x.payload).filter(([key])=>key!=='_exponent')));
        assert.deepEqual(rows.data,expectedRows);assert.deepEqual(rows.meta,{cursor:null,total:3});
        for(const format of ['csv','xml']as const)for(const valued of [false,true]){
          const e=await get(a,`/stocktake-adjustments/documents/${d.id}/export?format=${format}&include_values=${valued}`);assert.equal(e.row_count,3);assert.equal(e.document.id,d.id);assert.equal(e.document.number,d.number);assert.equal(e.values_included,valued&&a.on);assert.equal(e.format,format);
          const expectedHead={id:d.id,receipt_id:g.receipt_id,kind:d.kind,number:d.number,series_id:d.series_id,year:d.year,sequence:String(d.sequence),
            source_kind:g.source_kind,stocktake_id:g.stocktake_id,warehouse:g.preview.frame.source.warehouse,row_count:3,summary:d.summary,created_at:d.created_at};
          assert.deepEqual(e.document,e.values_included?expectedHead:quantityOnly(expectedHead),'Full frozen header, not self-echoed envelope');
          assert.equal(e.filename,`${d.kind}-${d.id}.${format}`);assert.equal(typeof e.content,'string');
          if(format==='csv'){const rec=csv(e.content);assert.equal(rec.length,4);assert.equal(rec[0].record_type,'document');assert.equal(rec[0].document_id,d.id);
            const columns=['record_type','document_id','receipt_id','number','kind','source_kind','stocktake_id','series_id','year','sequence','created_at','warehouse_id','warehouse_name','warehouse_code','row_count','pw_quantity','rw_quantity','ordinal','source_ordinal','line_id','product_id','sku','name','location','quantity','delta','lot_id','lot_code','expiry_date','layer_id','movement_id','stock_movement_id'];
            if(e.values_included)columns.push('currency','exponent','known_pw_minor','known_rw_minor','unknown_pw_quantity','unknown_rw_quantity','unit_cost_minor','value_minor','cost_state');assert.deepEqual(Object.keys(rec[0]),columns);
            const common={document_id:d.id,receipt_id:g.receipt_id,number:d.number,kind:d.kind,source_kind:g.source_kind,stocktake_id:g.stocktake_id,series_id:d.series_id,year:d.year,sequence:String(d.sequence),created_at:d.created_at,warehouse_id:a.warehouse.id};
            for(const r of rec)for(const[key,value]of Object.entries(common))assert.equal(r[key],csvText(value),key);
            const detail=rec.slice(1);assert.deepEqual(detail.map(x=>Number(x.ordinal)),[0,1,2]);assert.deepEqual(detail.map(x=>x.product_id),expectedRows.map(x=>x.product_id));
            assert.equal(rec[0].warehouse_name,csvText(expectedHead.warehouse.name));assert.equal(rec[0].warehouse_code,csvText(expectedHead.warehouse.code));for(const key of ['ordinal','source_ordinal','line_id','product_id','sku','name','location','quantity','delta','lot_id','lot_code','expiry_date','layer_id','movement_id','stock_movement_id'])assert.equal(rec[0][key],'',key);
            for(const r of detail){assert.equal(r.record_type,'row');for(const key of ['warehouse_name','warehouse_code','row_count','pw_quantity','rw_quantity'])assert.equal(r[key],'',key);}
            assert.deepEqual(detail.map(x=>x.movement_id),expectedRows.map(x=>x.movement_id));
            for(let i=0;i<detail.length;i++)for(const key of ['source_ordinal','line_id','product_id','sku','name','location','quantity','delta','lot_id','lot_code','expiry_date','layer_id','movement_id','stock_movement_id'])assert.equal(detail[i][key],csvText(expectedRows[i][key]),key);
            assert.equal(rec[0].number,d.number);assert.equal(rec[0].row_count,'3');assert.equal(rec[0].warehouse_id,a.warehouse.id);assert.equal(rec[0].source_kind,g.source_kind);assert.equal(rec[0].stocktake_id,g.stocktake_id);
            for(const key of ['pw_quantity','rw_quantity'])assert.equal(rec[0][key],csvText(d.summary[key]));
            if(!e.values_included){for(const key of moneyKeys)assert(!Object.hasOwn(rec[0],key),key);assert.deepEqual(e.document,quantityOnly(e.document));}
            else{assert.deepEqual(detail.map(x=>x.unit_cost_minor),expectedRows.map(x=>x.unit_cost_minor===null?'':String(x.unit_cost_minor)));assert.deepEqual(detail.map(x=>x.cost_state),expectedRows.map(x=>x.unit_cost_minor===null?'unknown':'known'));}
            if(e.values_included){for(const key of ['currency','exponent','known_pw_minor','known_rw_minor','unknown_pw_quantity','unknown_rw_quantity'])assert.equal(rec[0][key],csvText(d.summary[key]),key);for(const key of ['unit_cost_minor','value_minor','cost_state'])assert.equal(rec[0][key],'',key);for(let i=0;i<detail.length;i++){for(const key of ['unit_cost_minor','value_minor','currency'])assert.equal(detail[i][key],csvText(expectedRows[i][key]),key);assert.equal(detail[i].exponent,csvText(d.summary.exponent));for(const key of ['known_pw_minor','known_rw_minor','unknown_pw_quantity','unknown_rw_quantity'])assert.equal(detail[i][key],'',key);}}
          }else{const root=xml(e.content);assert.equal(root.name,'stocktake_adjustment');assert.deepEqual(root.attrs,{version:'1'});assert.deepEqual(root.children.map(n=>n.name),['document','rows']);assert.equal(root.text,'');xmlExact(root.children[0],e.document);
            const nodes=root.children[1].children;assert.equal(nodes.length,3);assert.equal(root.children[1].text,'');assert.deepEqual(root.children[1].attrs,{});
            for(let i=0;i<nodes.length;i++){assert.equal(nodes[i].name,'row');xmlExact(nodes[i],e.values_included?expectedRows[i]:quantityOnly(expectedRows[i]));}
            if(!e.values_included){assert.deepEqual(e.document,quantityOnly(e.document));const visit=(n:XmlNode)=>{assert(!moneyKeys.has(n.name),n.name);n.children.forEach(visit);};visit(root);}
          }
          const file=resolve(ROOT,`data/stocktake-adjustment-register-native165-${scope}-${k}-${d.kind}-${valued?'values':'quantity'}${suffix}.${format}`);await absent(file);const h=await wx(file,e.content,0o600);
          exports.push({actor:k,kind:d.kind,document_id:d.id,format,requested_values:valued,values_included:e.values_included,rows:3,bytes:Buffer.byteLength(e.content),sha256:h,filename:e.filename,artifact:file});
        }
      }
    }
    step='purity';assert.deepEqual(await capture(),cap,'All464 global tables unchanged by every GET');await health();await custody();
    const status=phase==='before'?'REGISTER165_BEFORE_EXACT_PASS':'REGISTER165_AFTER_READ_ONLY_PASS';
    const privateSha=await wx(output,json({stage:165,scope,phase,attempt,status,schema:SCHEMA,runtime_revision:revision,baseline_sha256:phase==='before'?pins[scope]:process.env.QA165_BEFORE_SHA256,config_sha256:pins.config,setup_sha256:pins.setup,capture:cap,proof,exports,session_deltas:sessionDeltas,created_at:new Date().toISOString()}),0o600);
    const report={stage:165,scope,phase,attempt,status,schema:SCHEMA,runtime_revision:revision,private_sha256:privateSha,tables:464,old_rows_exact:true,old_sessions_exact:true,only_explicit_own_new_sessions:sessionDeltas,metadata_exact:true,receipt_graph_exact:true,register_full_pages_verified:phase==='after',exports,exports_complete:phase==='after',gets,mutations:0,login_calls:0,worker_calls:0,provider_verified:false,chrome_verified_here:false,historical_files_verified_here:false,full_goal_complete:false};
    await wx(publicOutput,json(report),0o644);console.log(json({...report,exports:exports.length}));
  }catch(e){const line=e instanceof Error?e.stack?.match(/stocktake-adjustment-register-native165-proof\.ts:(\d+)/):undefined;console.error(json({stage:165,status:'FAILED_NO_REPAIR',step,source_line:line?Number(line[1]):null,private_details_withheld:true,automatic_resume:false}));process.exitCode=1;}
  finally{await c?.end().catch(()=>undefined);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)void main();
