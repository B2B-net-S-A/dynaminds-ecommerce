/** SOURCE_ONLY / NOT_RUN. Root supplies actual accepted159 documents, genuine
 * sessions/API keys, installed routes and the whole source/copy capture oracle.
 * No signup, issued-document seed, app/database imports or provider requests. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SaxesParser } from 'saxes';
import type { FastifyInstance } from 'fastify';

type Headers = Record<string, string>;
export async function assertNativeFa3Download(args: {
  app: FastifyInstance; readonlyApp: FastifyInstance;
  documentId: string; foreignDocumentId: string;
  ownerHeaders: Headers; readonlyHeaders: Headers; readKeyHeaders: Headers;
  missingOrdersReadHeaders: Headers; foreignTenantHeaders: Headers; revokedHeaders: Headers;
  captureWhole: () => Promise<unknown>;
}) {
  const before = await args.captureWhole(), receipts: Array<{path:string;status:number;sha256:string}> = [];
  const detail = await args.app.inject({url:'/api/b2b-invoices/documents/'+args.documentId,headers:args.ownerHeaders});
  assert.equal(detail.statusCode,200,'Genuine native document/receipt read');
  const { document, receipt } = detail.json();
  assert.equal(document.id,args.documentId); assert.equal(receipt.document_id,args.documentId);
  assert.equal(document.mode,'b2b_invoice'); assert.equal(document.data.ksef_state,'not_submitted');
  assert.equal(document.data.number,receipt.number);
  const generation = document.created_at.replace(/\+00:00$/,'Z');
  const base='/b2b-invoices/documents/'+args.documentId+'/fa3.xml';
  let exact: string | undefined;
  for (const [app, headers, namespace] of [
    [args.app,args.ownerHeaders,'/api'],[args.app,args.ownerHeaders,'/api/v1'],
    [args.app,args.readKeyHeaders,'/api/v1'],
    [args.readonlyApp,args.readonlyHeaders,'/api'],[args.readonlyApp,args.readonlyHeaders,'/api/v1'],
  ] as const) {
    const path=namespace+base, response=await app.inject({url:path,headers});
    assert.equal(response.statusCode,200,'Actual authenticated XML download');
    assert.match(String(response.headers['content-type']),/^application\/xml;\s*charset=utf-8$/i);
    assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['x-content-type-options'],'nosniff');
    assert.equal(response.headers['content-disposition'],`attachment; filename="${document.number.replace(/\//g,'-')}.fa3.xml"`);
    if(exact===undefined)exact=response.body;else assert.ok(response.body===exact,'Identical normal/v1/API-key/readonly XML bytes');
    const fields:Record<string,string[]>={},stack:string[]=[],texts:string[]=[];
    const parser=new SaxesParser({xmlns:true});
    parser.on('doctype',()=>{throw Error('DTD forbidden');});
    parser.on('opentag',t=>{stack.push(t.local);texts.push('');});
    parser.on('text',t=>{texts[texts.length-1]+=t;});
    parser.on('closetag',()=>{const name=stack.pop()!,value=texts.pop()!;(fields[name]??=[]).push(value);});
    parser.write(response.body).close();
    const minor=(s:string)=>{const n=BigInt(s);return `${n/100n}.${String(n%100n).padStart(2,'0')}`;};
    assert.ok(fields.P_2[0]===document.number&&fields.DataWytworzeniaFa[0]===generation,'Persisted number/time retained');
    assert.ok(fields.P_15[0]===minor(document.data.fiscal_snapshot.totals.gross_minor),'Exact native total');
    const lines=document.data.fiscal_snapshot.lines;
    assert.ok(JSON.stringify(fields.UU_ID)===JSON.stringify(lines.map((r:any)=>r.line_id)),'Complete native line identities');
    assert.ok(JSON.stringify(fields.P_11A)===JSON.stringify(lines.map((r:any)=>minor(r.gross_minor))),'Complete native gross rows');
    assert.ok(JSON.stringify(fields.P_12)===JSON.stringify(lines.map((r:any)=>r.vat_code)),'Complete native tax categories');
    const validated=spawnSync('python3',[fileURLToPath(new URL('./fa3-xml-xsd-oracle.py',import.meta.url))],{input:response.body,encoding:'utf8',timeout:10000,maxBuffer:4096});
    assert.equal(validated.error,undefined);assert.equal(validated.signal,null);assert.equal(validated.status,0,'Independent official offline XSD');
    assert.equal(JSON.parse(validated.stdout).valid,true);
    receipts.push({path,status:response.statusCode,sha256:createHash('sha256').update(response.body).digest('hex')});
  }
  for(const [path,headers,status] of [
    ['/api'+base+'?generated_at=caller',args.ownerHeaders,422],
    ['/api'+base,{},401],
    ['/api/v1'+base,args.missingOrdersReadHeaders,403],
    ['/api/v1'+base,args.revokedHeaders,401],
    ['/api'+base,args.foreignTenantHeaders,404],
    ['/api/b2b-invoices/documents/'+args.foreignDocumentId+'/fa3.xml',args.ownerHeaders,404],
    ['/api/b2b-invoices/documents/not-uuid/fa3.xml',args.ownerHeaders,422],
  ] as const) {
    const response=await args.app.inject({url:path,headers});assert.equal(response.statusCode,status,'Exact native refusal');
    assert.equal(response.headers['cache-control'],'no-store');
    receipts.push({path,status:response.statusCode,sha256:createHash('sha256').update(response.body).digest('hex')});
  }
  assert.deepEqual(await args.captureWhole(),before,'Whole source/copy rows, metadata and sequences literal across GETs/refusals');
  return {status:'ROOT_NATIVE159_FA3_DOWNLOAD_READONLY_PASS',requests:receipts,xml_sha256:receipts[0].sha256,
    whole_capture_literal:true,ksef_submission_executed:false,caller_app_and_reader_closure_required:true};
}
