/** Source/inverse and real pure-calculator checks only. No PG/HTTP/app/build install. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {deriveReturnCredit211FrozenPhysical,deriveReturnCredit211BusinessPorts,deriveReturnCredit211ForwardPlan,deriveReturnCredit211MetadataProjection,assembleReturnCredit211SourceCandidate,RETURN_CREDIT211_PREDECESSORS,RETURN_CREDIT211_PHYSICAL_FK} from '../tools/parity/return-credit211-source.mjs';
import {RETURN_CREDIT207_SOURCE_CONTRACT as E207} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit207-source-contract.mjs';
import {sourceDdlMigrationPlan} from '../tools/build/source-ddl-migration-plan.mjs';
const root=new URL('../',import.meta.url),read=p=>fs.readFile(new URL(p,root),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
const [source148,source206,source207,native,db,resources]=await Promise.all(['server/148_return_destinations.sql','server/206_return_credit_destinations_history.sql','server/207_consumer_return_credit.sql','server/211_return_credit148_acceptance.sql','server/db.ts','tools/build/resource-definitions.mjs'].map(read));
const physical=deriveReturnCredit211FrozenPhysical(source148),ports=deriveReturnCredit211BusinessPorts(source207),plan=deriveReturnCredit211ForwardPlan(source207);
const inverse=port=>{let value=port.after??port.sql;for(const e of [...port.edits].reverse()){assert.equal(value.slice(e.afterStart,e.afterStart+e.after.length),e.after);value=value.slice(0,e.afterStart)+e.before+value.slice(e.afterStart+e.after.length);}return value;};
const named=(sql,name)=>{const at=sql.indexOf('CREATE FUNCTION public.'+name+'(');assert(at>=0);const body=sql.indexOf(' AS ',at);const m=/AS (\$[a-z0-9]*\$)/i.exec(sql.slice(body));assert(m);const token=m[1],start=body+m.index+m[0].length,end=sql.indexOf(token+';',start);assert(end>start);return sql.slice(at,end+token.length+1);};

test('all three exact predecessor cuts and whole physical/source/issue inverses remain source-owned',()=>{
 for(const [key,s]of Object.entries({source148,source206,source207})){assert.equal(Buffer.byteLength(s),RETURN_CREDIT211_PREDECESSORS[key].bytes);assert.equal(hash(s),RETURN_CREDIT211_PREDECESSORS[key].sha256);}
 assert.equal(hash(inverse(physical)),physical.original.sha256);
 assert(native.includes(physical.sql));assert.equal(physical.edits.length,8);
 for(const port of ports.changes){assert.equal(inverse(port),port.before);assert.equal(hash(port.after),port.after_sha256);}
 assert.equal(named(native,'return_credit211_source'),ports.changes[0].after.replace('CREATE FUNCTION public.return_credit206_source(','CREATE FUNCTION public.return_credit211_source('));
 assert.equal(ports.changes[1].edits.length,1);
});

test('mutations anywhere in either whole source refuse before generation, including unused old branches',()=>{
 for(const [source,derive]of [[source148,deriveReturnCredit211FrozenPhysical],[source207,deriveReturnCredit211BusinessPorts],[source207,deriveReturnCredit211ForwardPlan]]){
  for(const value of [source+'\n',source.replace('CREATE FUNCTION','CREATE  FUNCTION'),source.slice(0,-1),source.slice(0,100)+'!'+source.slice(101)])assert.throws(()=>derive(value));
  for(const value of [null,undefined,{},Buffer.from(source)])assert.throws(()=>derive(value));
  assert.throws(()=>derive(source,{}));
 }
 assert(Object.isFrozen(plan));assert(Object.isFrozen(plan.function_changes[0].edits));assert(Object.isFrozen(RETURN_CREDIT211_PHYSICAL_FK.before));
});

test('frozen physical replay keeps whole old proof but reads captured birth, never current mutable stock/status/policy',()=>{
 assert.equal(physical.edits.filter(e=>e.before.includes('return_destination_snapshot(eid)')).length,1);
 for(const forbidden of ['return_destination_snapshot(eid)','public.warehouse_inventory_policy(','public.return_destination_statuses ','FROM public.order_items oi','FROM public.return_cases WHERE'])assert(!physical.sql.includes(forbidden),forbidden);
 for(const retained of ['bijekcji rzeczywistych dzienników','Lokalizacje nie zachowują dokładnego przyjęcia','Fragmenty nie odpowiadają dokładnej zgodzie SALE i CUSTODY','Pozycja warstwy nie zachowuje ilości lub rezerwacji','Wymagany dokładny dziennik zwrotu każdej części'])assert(physical.sql.includes(retained),retained);
 assert(physical.sql.includes('cur:=a.after_snapshot;'));
 assert(physical.sql.includes("FROM jsonb_array_elements(cur->'wms_return_fragments')"));
 assert(!physical.sql.includes('rc.received_at<a.opened_at'),'now() birth can precede clock_timestamp admission');
});

test('received148 binds full native lineage/typed source and original journal bags, without169 or PZ invention',()=>{
 const history=named(native,'return_credit211_history148');
 for(const atom of ['assistant_admission.receipt_id IS NULL','preview.private_scope_nonce','receipt.scope_hash IS DISTINCT FROM','preview.request_hash IS DISTINCT FROM','admission.request_hash IS DISTINCT FROM',"session_row.state)","'completed'::text",'native_plan:=public.return_destination_plan(',"admission.payload#>'{snapshot,return_case}' IS DISTINCT FROM before_header",'jsonb_populate_recordset(NULL::public.%I','211 before snapshot full typed fields differ','211 after snapshot full typed fields differ','211 full typed arrivals differ','211 full native WMS fragment bijection differs','211 complete immutable birth journal differs','public.return_credit211_frozen_physical(eid)','current_return.state NOT IN','birth_items:=actual'])assert(history.includes(atom),atom);
 assert(!/\b(?:INSERT INTO|UPDATE public|DELETE FROM|TRUNCATE|nextval)\b/i.test(history));
 assert(!history.includes('PERFORM public.return_destination_physical_validate'));
 assert(history.includes('211148-only cannot borrow or bypass169/152 lineage'));
});

test('concrete169 takes precedence and any partial169 is refused before148-only, without caller family selection',()=>{
 const resolver=named(native,'return_credit211_acceptance');
 const partial=resolver.indexOf('IF rr.id IS NOT NULL OR ca.id IS NOT NULL THEN'),refusal=resolver.indexOf('211 partial or foreign169 cannot fall back to148'),historical=resolver.indexOf('PERFORM public.return_credit206_physical_history(rr.id)'),fallback=resolver.indexOf('RETURN public.return_credit211_history148');
 assert(partial<refusal&&refusal<historical&&historical<fallback);
 assert(resolver.includes("protocol NOT IN('rma','assistant_v1','destinations_v1')"));
 assert(!resolver.includes('INSERT INTO'));assert(!/family\s+(?:text|jsonb)/.test(resolver.split('RETURNS')[0]));
});

test('typed immutable parents have two concrete FKs and are only born from an exact current issue admission',()=>{
 const table=native.slice(native.indexOf('CREATE TABLE public.return_credit211_acceptances('),native.indexOf('-- READ ONLY: choose'));
 assert(table.includes('REFERENCES public.catalog_stock_return_receipts(tenant_id,id)'));
 assert(table.includes('REFERENCES public.return_destination_admissions(tenant_id,receipt_id)'));
 assert(table.includes("family='catalog169' AND catalog_receipt_id IS NOT NULL AND id=catalog_receipt_id AND destination_receipt_id IS NULL"));
 assert(table.includes("family='destinations148' AND destination_receipt_id IS NOT NULL AND id=destination_receipt_id AND catalog_receipt_id IS NULL"));
 assert(table.includes('UNIQUE(tenant_id,return_id)'));assert(table.includes('FORCE ROW LEVEL SECURITY'));
 assert(!/GRANT\s+(?:ALL|INSERT|UPDATE|DELETE|TRUNCATE)/i.test(native));
 for(const name of ['return_credit211_parent_guard','return_credit211_ensure_parent']){
  const code=named(native,name);assert(code.includes('pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()'));
  assert(code.includes('public.return_credit206_require(ca.actor_id,ca.api_key_id,true,false)'));
  assert(code.includes('public.return_credit211_acceptance(p.order_id,p.return_id)'));
 }
 assert(native.includes('DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.return_credit211_parent_complete()'));
 assert(named(native,'return_credit211_parent_complete').includes('r.id IS NULL'));
 assert(native.includes('211 acceptance parents cannot be truncated'));
});

test('historical206 seed is a finite pre-trigger phase and preserves every old business row and number',()=>{
 const begin=native.indexOf('DO $seed211$'),end=native.indexOf('END $seed211$;',begin),seed=native.slice(begin,end);
 assert(begin>native.indexOf('CREATE FUNCTION public.return_credit211_source('));
 assert(end<native.indexOf('CREATE TRIGGER return_credit211_parent_guard'));
 for(const atom of ["EXISTS(SELECT FROM public.return_credit211_acceptances)",'pg_trigger',"FOR credit_row IN SELECT * FROM public.return_credit206_receipts ORDER BY tenant_id,original_document_id,receipt_sequence,id",'public.return_credit206_calculate(frame211)',"decision211->>'status' IS DISTINCT FROM 'already_credited'", "acceptance211->>'family' IS DISTINCT FROM 'catalog169'",'credit_row.root_xid,credit_row.transaction_started_at,credit_row.backend_pid',"set_config('app.tenant_id',coalesce(old_tenant,''),true)",'211 complete historical seed cardinality differs'])assert(seed.includes(atom),atom);
 const targets=[...seed.matchAll(/INSERT INTO public\.(\w+)/g)].map(m=>m[1]);assert.deepEqual(targets,['return_credit211_acceptances']);
 assert(!/\b(?:UPDATE|DELETE|TRUNCATE|nextval)\b/.test(seed));
});

test('source/issue use the same unchanged v2 calculator, mixed chain and exact replay before the one parent hook',()=>{
 const source=ports.changes[0],issue=ports.changes[1];
 for(const atom of ["'schema','consumer-return-credit-source/v2'","'legacy' family FROM public.local_consumer_credit_receipts","'destinations' family FROM public.return_credit206_receipts",'cr.previous_receipt_id IS DISTINCT FROM prev','ORDER BY receipt_sequence,id LOOP','public.return_credit206_rejected_history(inspection_row.id)','receipt_sequence<>seq'])assert(source.after.includes(atom),atom);
 assert(source.after.includes('public.return_credit211_acceptance(o.id,rc.id)'));
 assert(source.after.includes("da.payload->>'action' IN('receive','reject')"));
 assert(source.after.includes('public.return_credit211_acceptances parent211'));
 const hook=issue.after.indexOf('PERFORM public.return_credit211_ensure_parent(eid)');
 assert(hook>issue.after.indexOf('INSERT INTO return_credit206_admissions'));
 assert(hook<issue.after.indexOf('INSERT INTO return_credit206_documents'));
 assert(hook<issue.after.indexOf('INSERT INTO return_credit206_receipts'));
 assert.deepEqual(issue.after.slice(0,issue.edits[0].afterStart),issue.before.slice(0,issue.edits[0].beforeStart));
 assert(issue.after.indexOf("jsonb_build_object('reused',true)")<hook);
});

test('forward FK is exactly source-authored207; explicit full211 install follows209 without188 or split210 activation',()=>{
 const old=E207.additions.find(r=>r.kind==='constraint'&&r.key===RETURN_CREDIT211_PHYSICAL_FK.key);assert(old);assert.deepEqual(old.value,RETURN_CREDIT211_PHYSICAL_FK.before);
 assert.deepEqual({...RETURN_CREDIT211_PHYSICAL_FK.after,definition:old.value.definition},old.value);
 assert.equal(RETURN_CREDIT211_PHYSICAL_FK.after.definition,'FOREIGN KEY (tenant_id, return_receipt_id) REFERENCES return_credit211_acceptances(tenant_id, id)');
 const altered=[...plan.forward_sql.matchAll(/ALTER TABLE public\.(\w+)/g)].map(m=>m[1]);assert.deepEqual(altered,['return_credit206_receipts','return_credit206_receipts']);
 const migrations=sourceDdlMigrationPlan(db),at=migrations.findIndex(r=>r.name==='211_return_credit148_acceptance');
 assert(at>0);assert.deepEqual(migrations[at],{name:'211_return_credit148_acceptance',file:'211_return_credit148_acceptance_install.sql'});
 assert.equal(migrations[at-1].name,'209_order_merge_delivery_inheritance');
 // 20542a9 and later append 212+ (append-only): the 211 program stays the exact 201-entry prefix ending with 211.
 const program211=migrations.slice(0,at+1);assert.equal(program211.length,201);assert.equal(hash(JSON.stringify(program211)),'92690602a1bbdea841b893d422ba07bd06bd251c901cfc39fb729124ca54a6d8');
 assert(!migrations.some(r=>r.name.startsWith('210_')));assert(!resources.includes('211_return_credit148_acceptance.sql'),'the185318B core is not a full migration resource');
 for(const k of ['installation_ready','native_acceptance','application_activation','business_acceptance'])assert.equal(plan[k],false);
 assert.equal(plan.migration.installs_split210,false);
 assert(!/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:public\.)?(?:stock|catalog_stock_return_|return_destination_)/i.test(native));
});

// Reuse the existing small synthetic constructor without importing its node:test
// module. Execute actual production pure arithmetic via a bundled data module;
// no server/db, factories, HTTP handlers, SQL driver or migrations are imported.
const fixtureTest=await read('tests/return-credit206-arithmetic.test.ts');
const fixtureCode=fixtureTest.slice(fixtureTest.indexOf('function fixture(){'),fixtureTest.indexOf('\nconst code='));assert(fixtureCode.trimEnd().endsWith('}'));
const pure=await build({stdin:{contents:`import {randomUUID} from 'node:crypto';import {localInvoiceLineAmounts} from './server/local-invoice-values';import {consumerCreditHash,calculateLocalConsumerCredit} from './server/local-consumer-credit-arithmetic';import {calculateReturnCredit206} from './server/return-credit206-arithmetic';${fixtureCode}\nexport{fixture,localInvoiceLineAmounts,consumerCreditHash,calculateReturnCredit206,calculateLocalConsumerCredit};`,resolveDir:fileURLToPath(root),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const model=await import('data:text/javascript;base64,'+Buffer.from(pure.outputFiles[0].text).toString('base64'));
const {fixture,localInvoiceLineAmounts,consumerCreditHash,calculateReturnCredit206}=model;
function received4401(){const{source}=fixture(),f=source.original.receipt.snapshot,old=f.lines[0],second=randomUUID();
 f.order.total_minor='4401';f.lines=[{...old,quantity:1,unit_gross_minor:'1000',rounding_gross_minor:'0',...localInvoiceLineAmounts('1000',23)},
 {...old,item_id:second,quantity:2,unit_gross_minor:'1700',rounding_gross_minor:'1',...localInvoiceLineAmounts('3401',23)},f.lines[1]];
 f.totals=localInvoiceLineAmounts('4401',23);f.vat_totals=[{vat_rate:23,...f.totals}];
 const sha=consumerCreditHash(f);source.original.receipt.scope_hash=sha;source.original.document.data={...f,number:source.original.document.number,preview_id:source.original.receipt.preview_id,scope_hash:sha,local_only:true,ksef_state:'not_submitted',fiscalized:false};
 const a={return_id:randomUUID(),receipt_id:randomUUID(),receipt_sequence:1,received_at:'2026-10-02T10:00:00.000000Z',refund_amount_minor:'2700',refunded_shipping_minor:'0',items:[{item_id:old.item_id,accepted:'1',restocked:'1',refund_amount_minor:'1000'},{item_id:second,accepted:'1',restocked:'0',refund_amount_minor:'1700'}]};
 source.acceptances=[{...a,financial_hash:consumerCreditHash(a)}];source.physical_protocols=[{return_id:a.return_id,receipt_id:a.receipt_id,protocol:'destinations_v1'}];source.selected_return_id=a.return_id;return source;
}

test('actual unchanged production calculator supports a synthetic148-ID accepted2 sale1 custody1:4401→2700→1701',()=>{
 const source=received4401(),before=structuredClone(source),out=calculateReturnCredit206(source);assert.equal(out.status,'credit_required');assert.equal(out.calculation.return_receipt_id,source.acceptances[0].receipt_id);
 assert.equal(out.calculation.totals.before.gross_minor,'4401');assert.equal(out.calculation.totals.delta.gross_minor,'-2700');assert.equal(out.calculation.totals.after.gross_minor,'1701');
 for(const k of ['before','after','delta'])assert.equal(BigInt(out.calculation.totals[k].net_minor)+BigInt(out.calculation.totals[k].vat_minor),BigInt(out.calculation.totals[k].gross_minor));assert.deepEqual(source,before);
 const poison=structuredClone(source);poison.acceptances[0].items[1].refund_amount_minor='1701';const{financial_hash,...f}=poison.acceptances[0];poison.acceptances[0].financial_hash=consumerCreditHash(f);assert.throws(()=>calculateReturnCredit206(poison));
});

test('unchanged v2 calculation/hash remains exact across a later synthetic native148 receipt and cannot double-credit',()=>{
 const{source,add}=fixture(),first=add(1,'1133'),calculation=calculateReturnCredit206(source).calculation;
 const pc={document_id:randomUUID(),receipt_id:randomUUID(),return_id:first.return_id,return_receipt_id:first.receipt_id,receipt_sequence:1,calculation,calculation_hash:consumerCreditHash(calculation)};
 source.previous_credits=[pc];source.credit_families=[{document_id:pc.document_id,receipt_id:pc.receipt_id,family:'destinations',created_at:'2026-10-02T11:00:00.000000Z'}];
 assert.equal(calculateReturnCredit206(source).status,'already_credited');
 const before=JSON.stringify(pc);add(1,'1134','destinations_v1',0);const next=calculateReturnCredit206(source);
 assert.equal(next.status,'credit_required');assert.equal(next.calculation.previous_chain_hash,consumerCreditHash(pc));assert.equal(JSON.stringify(pc),before);
 assert.equal(next.calculation.totals.delta.gross_minor,'-1134');
 const duplicate=structuredClone(source);duplicate.acceptances[1].receipt_id=first.receipt_id;assert.throws(()=>calculateReturnCredit206(duplicate));
});

test('literal169 and188 native schema/business sources and188 physical FK are unchanged',async()=>{
 const pins={
  'server/169_manual_inventory_off.sql':'4cbf0d955d5bef53b8385836779d6ec50fb5d12520d5c0def95eee8b0da054ce',
  'server/catalog-stock-return-schema-fragment169.sql':'c4a3f5a9fb014957b689ba46c08b9a2d9bf799714fe058a4740e494dc29aba99',
  'server/188_local_consumer_credit.sql':'cfa89fad3148555c0d91c5293d5e4727ab80d589681724196b70eb8a798cfbc6',
  'server/188_consumer_credit_structure.sql':'a1ab15d6196fe01f4a156a3f0f97d4080811dafe816e3b20ddd0c483ef7527db'
 };
 for(const [path,pin]of Object.entries(pins))assert.equal(hash(await read(path)),pin,path);
 assert((await read('server/188_local_consumer_credit.sql')).includes('FOREIGN KEY(tenant_id,return_receipt_id) REFERENCES catalog_stock_return_receipts(tenant_id,id)'));
 assert(!plan.forward_sql.includes('ALTER TABLE public.local_consumer_credit'));
});

test('real legacy188 calculation stays byte-exact before the later native148 destinations acceptance',()=>{
 const{source,add}=fixture(),first=add(1,'1133','rma');
 const legacy=model.calculateLocalConsumerCredit({original:source.original,acceptances:[source.acceptances[0]],previous_credits:[],selected_return_id:first.return_id});
 const old={document_id:randomUUID(),receipt_id:randomUUID(),return_id:first.return_id,return_receipt_id:first.receipt_id,receipt_sequence:1,calculation:legacy,calculation_hash:consumerCreditHash(legacy)};
 source.previous_credits=[old];source.credit_families=[{document_id:old.document_id,receipt_id:old.receipt_id,family:'legacy',created_at:'2026-10-02T11:00:00.000000Z'}];
 const bytes=JSON.stringify(old);add(1,'1134','destinations_v1',0);
 const next=calculateReturnCredit206(source);assert.equal(next.status,'credit_required');assert.equal(next.calculation.totals.before.gross_minor,'2268');assert.equal(next.calculation.totals.after.gross_minor,'1134');
 assert.equal(next.calculation.previous_chain_hash,consumerCreditHash(old));assert.equal(JSON.stringify(old),bytes);
 const poisoned=structuredClone(source);poisoned.previous_credits[0].calculation.totals.delta.gross_minor='-1132';assert.throws(()=>calculateReturnCredit206(poisoned));
});

test('independent211 raw metadata gate is complete and acyclic; missing compiled seal remains refused',()=>{
 const m=deriveReturnCredit211MetadataProjection(source207);
 assert(native.endsWith(m.sql));assert.equal(m.seal_insert_emitted,false);assert.equal(m.installation_ready,false);
 const gate=named(m.sql,'return_credit211_metadata_valid'),unquoted=gate.replace(/'(?:''|[^'])*'/g,'');
 assert(!/public\.(?:return_credit206_|return_credit208_|order_merge_delivery209_)\w+\(/.test(unquoted),'raw gate cannot execute historical guards/fingerprints');
 assert(!/public\.return_credit211_(?:function_definition|constraint_definition|metadata_valid)\(/.test(unquoted.slice(unquoted.indexOf('BEGIN'))),'raw gate cannot self-authorize or consume its own projection');
 assert(gate.includes("(SELECT count(*) FROM public.return_credit211_metadata)<>1 THEN RETURN false"));
 assert(gate.includes('observed IS DISTINCT FROM m.own_records'));
 assert(gate.includes('observed IS DISTINCT FROM expected'));
 assert(gate.includes("m.original208->'original207' IS DISTINCT FROM m.original206"));
 assert(!/\bUPDATE\s+(?:public\.)?(?:return_credit20[68]_manifest|order_merge_delivery209_manifest)/i.test(native+plan.forward_sql));
 assert(!/INSERT INTO public\.return_credit211_metadata/.test(native+plan.forward_sql),'no observed-catalogue seal is silently manufactured');
 for(const kind of ['relation','column','constraint','index','policy','trigger','function','type'])assert(m.own_records_sql.includes("SELECT '"+kind+"',"),kind);
 assert(m.own_records_sql.includes("starts_with(t.tgname,'return_credit211_')"));
 assert(m.own_records_sql.includes('t.tgconstraint IN(SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid IN(SELECT oid FROM rels))'));
});

test('third fingerprint port has complete source inverse and preserves old SQL header and historical208 comparison',async()=>{
 const m=deriveReturnCredit211MetadataProjection(source207),p=m.fingerprint_change;
 assert.equal(inverse(p),p.before);assert.equal(p.edits.length,4);
 assert.equal(p.before.slice(0,p.before.indexOf(' AS $$')),p.after.slice(0,p.after.indexOf(' AS $$')));
 assert.equal((p.after.match(/return_credit211_metadata_valid\(\)/g)||[]).length,1);
 assert(p.after.includes('WITH admission211 AS MATERIALIZED'));
 assert(p.after.includes('FROM admission211 WHERE admission211.valid'));
 assert(p.after.includes('public.return_credit211_function_definition(p.oid)'));
 assert(p.after.includes('public.return_credit211_constraint_definition(k.oid)'));
 assert(p.after.includes('pg_get_constraintdef(oid,true)'),'unselected documents constraints remain literal');
 const old208=await read('server/208_consumer_return_credit_guard_dedup.sql');assert(old208.includes('s.successor207_fingerprint=public.return_credit206_fingerprint()'));
 assert(!plan.function_changes.some(c=>/return_credit206_(guards|require)|return_credit208_|order_merge_delivery209_/.test(c.key)));
 assert.equal(plan.function_changes.length,3);
});

test('six exact source-authored external AFTER descriptors and two retiredRI records cannot be learned from runtime rows',()=>{
 const m=deriveReturnCredit211MetadataProjection(source207);assert.equal(m.descriptor_changes.length,6);assert.equal(m.removed_records.length,2);
 for(const c of m.descriptor_changes){const before=E207.additions.find(r=>r.kind===c.kind&&r.key===c.key);assert(before);assert.deepEqual(c.before,before.value);
  if(c.kind==='function'){
   const{source:bs,definition:bd,...bh}=c.before,{source:as,definition:ad,...ah}=c.after;
   assert.deepEqual(ah,bh);assert.equal(ad,bd.replace(bs,()=>as));assert.notEqual(bs,as);
  }else if(c.kind==='trigger'){assert.deepEqual({...c.after,constraint_relation:c.before.constraint_relation},c.before);assert.equal(c.after.constraint_relation,'return_credit211_acceptances');}
 }
 const removedExpected=E207.additions.filter(r=>r.kind==='trigger'&&r.key.startsWith('public.catalog_stock_return_receipts.internal:return_credit206_receipts_tenant_id_return_receipt_id_fkey:'));
 assert.deepEqual(m.removed_records,removedExpected);
 assert(m.sql.includes("m.changes IS DISTINCT FROM '"));assert(m.sql.includes("m.removed IS DISTINCT FROM '"));
 for(const name of ['return_credit211_function_definition','return_credit211_constraint_definition']){
  const f=named(m.sql,name);assert(f.includes("live->'value' IS DISTINCT FROM binding->'after'"));assert(f.includes("RETURN binding#>>'{before,definition}'"));
 }
 const raw=named(m.sql,'return_credit211_function_record');assert(raw.includes('pg_catalog.pg_get_functiondef(p.oid)'));assert(!raw.includes('public.return_credit211_function_definition'));
});

test('metadata generation has a closed source input and does not mutate frozen previous plans',()=>{
 const old=JSON.stringify(plan),m=deriveReturnCredit211MetadataProjection(source207);
 assert(Object.isFrozen(m.descriptor_changes[0].after));assert(Object.isFrozen(m.removed_records));
 assert.throws(()=>deriveReturnCredit211MetadataProjection(source207+' '));assert.throws(()=>deriveReturnCredit211MetadataProjection(source207,{}));
 assert.equal(JSON.stringify(plan),old);assert.equal(m.old_206_208_209_manifest_updates,0);assert.equal(m.native_acceptance,false);
});

test('unsealed compilation candidate composes only the exact authored sources and cannot authorize a seal',()=>{
 const input={source148,source206,source207,nativeSql:native},saved=JSON.stringify(input);
 const candidate=assembleReturnCredit211SourceCandidate(input);
 assert.equal(candidate.sql,native+'\n'+plan.forward_sql);assert.equal(candidate.bytes,Buffer.byteLength(candidate.sql));assert.equal(candidate.sha256,hash(candidate.sql));
 assert.equal(candidate.sql.slice(0,-(plan.forward_sql.length+1)),native,'complete native source retained');
 assert.equal(candidate.metadata_authorization,'external-literal-Native-contract-required');
 for(const flag of ['source_compilation_performed','seal_insert_emitted','installation_ready','native_acceptance','application_activation','business_acceptance'])assert.equal(candidate[flag],false,flag);
 assert.equal(candidate.pg_calls,0);assert.equal(candidate.network_requests,0);
 assert.equal(candidate.descriptor_changes.length,6);assert.equal(candidate.removed_records.length,2);
 assert(Object.isFrozen(candidate));assert(Object.isFrozen(candidate.descriptor_changes[0].after));assert.equal(JSON.stringify(input),saved);
 for(const key of Object.keys(input))assert.throws(()=>assembleReturnCredit211SourceCandidate({...input,[key]:input[key]+'\n'}),key+' cannot drift');
 for(const bad of [null,undefined,[],{...input,seal:[]},{...input,source206:undefined}])assert.throws(()=>assembleReturnCredit211SourceCandidate(bad));
 assert.throws(()=>assembleReturnCredit211SourceCandidate(input,{}));
 assert(candidate.sql.includes('separate Native/cold contract must authorize'));
 assert(!/INSERT INTO public\.return_credit211_metadata/.test(candidate.sql));
});
