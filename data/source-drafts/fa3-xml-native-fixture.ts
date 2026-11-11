/** SOURCE_ONLY / NOT_RUN. Root invokes on its quiet numeric167 database after
 * genuine app/config/bootstrap and XML route adoption. No top-level app/DB,
 * provider, environment, seed, migration or credential fabrication. */
import assert from 'node:assert/strict';
import { createHash, randomUUID as cryptoRandomUuid } from 'node:crypto';
import { mkdir, open, lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { ordinaryShippedFixture, type NativeDependencies, type Row } from './b2b-fa3-native-acceptance-fixtures2';
import { issuedPrivateGraph159 } from './b2b-fa3-invoice159-issued-reader166';
import { assertFiscalMoney159, assertIssuedGraph159, hash159, type IssuedBasis159 } from './b2b-fa3-invoice159-native-acceptance-oracles166';
import { renderNativeB2bInvoiceFa3 } from '../../server/fa3-xml';

type Artifact = {path:string;sha256:string};
type ActualSignup = {email:string;password:string;cookie:string;user_id:string;tenant_id:string};
const hashBytes=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
async function save(directory:string,name:string,value:unknown):Promise<Artifact> {
  const path=resolve(directory,name),text=JSON.stringify(value,null,2)+'\n';
  assert(Buffer.byteLength(text)<=8*1024*1024,'Private fixture artifact bounded8MiB');
  const f=await open(path,'wx',0o600);try{await f.writeFile(text);await f.sync();}finally{await f.close();}
  const st=await lstat(path);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&(st.mode&0o777)===0o600);
  assert.equal(hashBytes(await readFile(path)),hashBytes(text));return{path,sha256:hashBytes(text)};
}

/** Captures only the actual ordinarySignup pass-through request/response. The
 * original fixture's actor remains its own real private cookie closure. */
function signupObserver(app:FastifyInstance,onSignup:(value:ActualSignup)=>Promise<void>):FastifyInstance {
  return {inject:async(options:InjectOptions)=>{
    const r=await app.inject(options);
    if(options.url==='/api/auth/signup'&&options.method==='POST') {
      assert.equal(r.statusCode,201,'Actual normal signup succeeds');
      const b=options.payload as Row,d=r.json();
      assert(typeof b.email==='string'&&typeof b.password==='string');
      assert(typeof r.headers['set-cookie']==='string');
      const cookie=String(r.headers['set-cookie']).split(';')[0];
      assert.ok(cookie.startsWith('dyna_session=')&&cookie.length>20,'Actual normal cookie captured');
      assert(typeof d.user.id==='string'&&typeof d.user.tenant_id==='string'&&d.user.role==='admin');
      await onSignup({email:b.email,password:b.password,cookie,user_id:d.user.id,tenant_id:d.user.tenant_id});
    }
    return r;
  }} as unknown as FastifyInstance;
}

export async function buildNative159Fa3DownloadFixture(args: {
  deps:NativeDependencies;directory:string;expectedDatabase:string;
  sourcePins:Record<string,string>;getProviderCalls:()=>number;
}) {
  assert.match(args.expectedDatabase,/^dynaminds_test_\d{13}$/);
  assert.equal(args.getProviderCalls(),0,'Caller provider guard starts zero');
  const actual=(await args.deps.pool.query(`SELECT current_database() database,
    EXISTS(SELECT FROM migrations WHERE name='167_operational_delivery_consumers') installed,
    public.operative_delivery_valid() valid`)).rows[0];
  assert.equal(actual.database,args.expectedDatabase);assert.equal(actual.installed,true);assert.equal(actual.valid,true);
  const required=[fileURLToPath(import.meta.url),
    fileURLToPath(new URL('./b2b-fa3-native-acceptance-fixtures2.ts',import.meta.url)),
    fileURLToPath(new URL('./b2b-fa3-invoice159-issued-reader166.ts',import.meta.url)),
    fileURLToPath(new URL('./b2b-fa3-invoice159-native-acceptance-oracles166.ts',import.meta.url)),
    fileURLToPath(new URL('./fa3-xml-download-native.ts',import.meta.url)),
    fileURLToPath(new URL('../../server/fa3-xml.ts',import.meta.url))];
  for(const path of required) {
    const expected=args.sourcePins[path];assert.match(expected??'',/^[a-f0-9]{64}$/,'Root pins every actual executable fixture dependency');
    assert.equal(hashBytes(await readFile(path)),expected,'Source bytes before fixture');
  }
  const directory=resolve(args.directory);await mkdir(directory,{mode:0o700});
  const ds=await lstat(directory);assert(ds.isDirectory()&&!ds.isSymbolicLink()&&(ds.mode&0o777)===0o700);
  const artifacts:Record<string,Artifact>={},credentials:ActualSignup[]=[];
  const app=signupObserver(args.deps.app,async value=>{
    credentials.push(value);assert(credentials.length<=2,'Exactly two genuine own fixture signups');
    artifacts['signup'+credentials.length]=await save(directory,'signup'+credentials.length+'.private.json',value);
  });
  async function issued(label:'own'|'foreign') {
    const fixture=await ordinaryShippedFixture({...args.deps,app});
    const sourcePreview=await fixture.actor.ok('/b2b-fa3/orders/'+fixture.order.id+'/previews','POST',fixture.body,201);
    assert.equal(sourcePreview.can_approve,true);assertFiscalMoney159(sourcePreview.draft);
    assert.equal(sourcePreview.draft_hash,hash159(sourcePreview.draft));
    const approval={client_key:cryptoRandomUuid(),scope_hash:sourcePreview.scope_hash,confirmed:true,project_only:true};
    const projectReply=await fixture.actor.ok('/b2b-fa3/previews/'+sourcePreview.id+'/approve','POST',approval,201);
    assert.equal(projectReply.reused,false);assert.deepEqual(projectReply.project.draft,sourcePreview.draft);
    const c=await args.deps.pool.connect();let saved:Row;
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");
      const rows=(await c.query(`SELECT to_jsonb(d) project,to_jsonb(p) original_preview,to_jsonb(r) project_receipt,
        to_jsonb(s) series,to_jsonb(cmd) series_command FROM fa3_draft_projects d
        JOIN fa3_draft_previews p ON(p.tenant_id,p.id)=(d.tenant_id,d.preview_id)
        JOIN fa3_draft_receipts r ON(r.tenant_id,r.project_id)=(d.tenant_id,d.id)
        JOIN local_invoice_series s ON(s.tenant_id,s.id)=(p.tenant_id,p.series_id)
        JOIN local_invoice_series_commands cmd ON(cmd.tenant_id,cmd.series_id)=(s.tenant_id,s.id)
        WHERE(d.tenant_id,d.id)=($1,$2)`,[fixture.actor.tenant,projectReply.project.id])).rows;
      assert.equal(rows.length,1);saved=rows[0];await c.query('COMMIT');
    } finally {try{await c.query('ROLLBACK');}finally{c.release();}}
    assert.deepEqual(saved.project.draft,sourcePreview.draft);assert.deepEqual(saved.original_preview.request,fixture.body);
    assert.deepEqual(saved.project_receipt.request,approval);
    const a={fixture,actor:fixture.actor,saved,projectReply};
    const auth=await a.actor.ok('/auth/me');assert.equal(auth.restore_preview,false);
    assert.equal(auth.user.id,a.actor.user);assert.equal(auth.user.tenant_id,a.actor.tenant);assert.equal(auth.user.role,'admin');
    assert.equal(credentials.at(-1)!.user_id,a.actor.user);assert.equal(credentials.at(-1)!.tenant_id,a.actor.tenant);
    // Actual paid/picked/scanned/packed/DEMO-dispatched native sale. No shipping
    // label inference, policy bypass or raw native parent creation.
    const order=a.fixture.order;assert.equal(order.status,'shipped');assert.equal(order.fulfillment_kind,'sale');
    assert.equal(order.payment_mode,'prepaid');assert.equal(order.currency,'PLN');assert.equal(order.total,6503);
    assert.equal(order.shipping_cost,999);assert.equal(order.items.length,3);
    assert.equal(a.saved.project.state,'approved_project');assert.equal(a.saved.project.issued,false);
    assert.equal(a.saved.project.draft_hash,hash159(a.saved.project.draft));
    assertFiscalMoney159(a.saved.project.draft);
    assert.deepEqual(a.saved.project.draft.buyer,a.fixture.body.buyer.party);
    assert.equal(a.saved.project.draft.buyer.tax_id,'1234563218');
    assert.equal(a.saved.project.draft.seller.tax_id,'5252445767');
    const issueDate=new Date().toISOString().slice(0,10);
    const previewRequest={client_key:cryptoRandomUuid(),project_id:a.saved.project.id,issue_date:issueDate,local_only:true,confirmed_project_snapshot:true};
    const preview=await a.actor.ok('/b2b-invoices/projects/'+a.saved.project.id+'/previews','POST',previewRequest,201);
    assert.equal(preview.can_issue,true);assert.deepEqual(preview.snapshot.fiscal_snapshot,a.saved.project.draft);
    assert.equal(preview.snapshot.project_hash,a.saved.project.draft_hash);
    const issueRequest={client_key:cryptoRandomUuid(),scope_hash:preview.scope_hash,confirmed:true,local_only:true};
    const basis:IssuedBasis159={tenant:a.actor.tenant,actor:a.actor.user,apiKey:null,project:a.saved.project,
      projectReceipt:a.saved.project_receipt,originalPreview:a.saved.original_preview,series:a.saved.series,
      seriesCommand:a.saved.series_command,previewRequest,issueRequest,sequence:1,issueDate,paymentMode:'prepaid'};
    const p={basis,preview,previewRequest,issueRequest};
    const reply=await a.actor.ok('/b2b-invoices/previews/'+p.preview.id+'/issue','POST',p.issueRequest,201);
    const graph=await issuedPrivateGraph159(args.deps.pool,a.actor.tenant,reply.document.id);
    const expected=assertIssuedGraph159(p.basis,graph,reply);
    assert.equal(expected.number,reply.document.number);assert.equal(expected.data.fiscal_snapshot.totals.gross_minor,'6503');
    assert.equal(reply.document.data.ksef_state,'not_submitted');
    // Exercise the actual export-only NIP/XSD mapping boundary before returning
    // this genuine document as an integration input. This is not the XSD oracle.
    const generation=reply.document.created_at.replace(/\+00:00$/,'Z');
    const xml=renderNativeB2bInvoiceFa3(reply.document,{generated_at:generation});
    assert.equal(xml.number,expected.number);assert.equal(xml.fiscal_snapshot_hash,a.saved.project.draft_hash);
    const current=await a.actor.ok('/b2b-invoices/documents/'+reply.document.id);
    assert.deepEqual(current,{document:reply.document,receipt:reply.receipt});
    const replay=await a.actor.ok('/b2b-invoices/previews/'+p.preview.id+'/issue','POST',p.issueRequest,200);
    assert.equal(replay.reused,true);assert.deepEqual(replay.document,reply.document);assert.deepEqual(replay.receipt,reply.receipt);
    assert.deepEqual(await issuedPrivateGraph159(args.deps.pool,a.actor.tenant,reply.document.id),graph,'Replay leaves the full actual159 graph literal');
    artifacts[label]=await save(directory,label+'-issued159.private.json',{
      basis:p.basis,project:a.saved,projectReply:a.projectReply,order,products:a.fixture.products,
      invoicePreview:p.preview,previewRequest:p.previewRequest,issueRequest:p.issueRequest,reply,graph,
      expected_fiscal_snapshot:expected.data.fiscal_snapshot,expected_fiscal_hash:a.saved.project.draft_hash,
      expected_number:expected.number,expected_xml_sha256:xml.xml_sha256,
    });
    return {actor:a.actor,documentId:reply.document.id,credentials:credentials.at(-1)!};
  }
  const own=await issued('own'),foreign=await issued('foreign');
  assert.notEqual(own.actor.tenant,foreign.actor.tenant);assert.equal(credentials.length,2);
  const readKey=await own.actor.ok('/developer/keys','POST',{name:'Native FA3 exact read scopes',scopes:['documents:read','orders:read'],expires_days:1},201);
  const missingOrders=await own.actor.ok('/developer/keys','POST',{name:'Native FA3 missing orders scope',scopes:['documents:read'],expires_days:1},201);
  const revoked=await own.actor.ok('/developer/keys','POST',{name:'Native FA3 genuine revoked key',scopes:['documents:read','orders:read'],expires_days:1},201);
  assert.deepEqual(await own.actor.ok('/developer/keys/'+revoked.id,'DELETE'),{ok:true});
  for(const key of [readKey,missingOrders,revoked])assert(typeof key.token==='string'&&key.token.startsWith('dyna_api_'));
  // Shape directly matches af199's inputs after the root supplies actual
  // readonlyApp, genuine readonly login headers and whole source/copy capture.
  artifacts.nativeInputs=await save(directory,'download-inputs.private.json',{
    documentId:own.documentId,foreignDocumentId:foreign.documentId,
    ownerHeaders:{cookie:own.credentials.cookie},foreignTenantHeaders:{cookie:foreign.credentials.cookie},
    readKeyHeaders:{authorization:'Bearer '+readKey.token},
    missingOrdersReadHeaders:{authorization:'Bearer '+missingOrders.token},revokedHeaders:{authorization:'Bearer '+revoked.token},
    required_root_additions:['app','readonlyApp','readonlyHeaders','captureWhole'],
  });
  assert.equal(args.getProviderCalls(),0,'Caller guard observed no provider calls');
  for(const path of required)assert.equal(hashBytes(await readFile(path)),args.sourcePins[path],'Source bytes after fixture');
  const result={status:'ROOT_NATIVE159_FA3_FIXTURE_ISSUED_INPUTS_READY',database:args.expectedDatabase,
    own:{tenant_id:own.actor.tenant,user_id:own.actor.user,document_id:own.documentId},
    foreign:{tenant_id:foreign.actor.tenant,user_id:foreign.actor.user,document_id:foreign.documentId},
    actual_signups:2,actual_issued_fv159:2,actual_api_keys_created:3,actual_api_keys_revoked:1,
    artifacts,source_pins:args.sourcePins,provider_calls:0,xml_download_native_test_executed:false,
    readonly_login_and_whole_capture_required:true,caller_app_pool_and_database_closure_required:true};
  const resultArtifact=await save(directory,'result.private.json',result);
  return{...result,result_artifact:resultArtifact};
}
