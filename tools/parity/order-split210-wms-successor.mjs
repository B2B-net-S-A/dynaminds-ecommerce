/** Pure Source210 foundation. No database access, registration, or Native certification. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const ORDER_SPLIT210_WMS_SOURCE = Object.freeze({
  source104_sha256:'36a6b4f02be93ac4e35e06680dd08e59b096ec5cd00b08feb25af068e83d41d3',
  source108_sha256:'cf91b76079c8841413925384a307e71a3e84f6ab100741d9ed5257d88587e62a',
  // Independently compiled SOURCE208; this routine was not changed by Source209.
  source208_catalogue_gzip_sha256:'320ba526496c79605630b7b1c98128bd3039251d72365ceedc75798e2650987d',
  source208_catalogue_bytes:62402967,
  source208_catalogue_bytes_sha256:'c59a648f054433ae469126b4cf47b824572f8813fbdf3b2a7aca515c69d7867d',
  source208_catalogue_sha256:'6dcfbee75e72045bc7f2791baeffc87c76ea89b1dc41ee5b8553cc022c50ecc3',
  source208_root_review_sha256:'bb8f0c73f18281c941f8a378323016ada241e49e7d106586dbaa09ba7fb816f4',
  // Also matches PACKING189_CONTRACT.dependency_compilation.object_hashes.
  before_record_sha256:'c2b12caaf79c2347e1a06557ac62dae1963647edb9527d8fa313e96c85d07669',
  before_body_sha256:'d3470c4726c70f07e302e978efddca31ecc545a55106b14122141ec6333345c1',
});
const sha=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>{
  assert(v!==undefined&&typeof v!=='function'&&typeof v!=='symbol','JSON descriptor required');
  if(typeof v==='number')assert(Number.isFinite(v),'finite descriptor number required');
  return Array.isArray(v)?Array.from(v,canonical):v&&typeof v==='object'
    ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
};
const digest=v=>sha(JSON.stringify(canonical(v)));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const declaration='DECLARE l record;op record;f record;p record;BEGIN';
const key='public.wms_row_guard()';

/** Compiler-facing check of the complete literal predecessor, not only its body. */
export function assertOrderSplit210WmsPredecessor(record){
  assert.equal(record?.kind,'function');assert.equal(record?.key,key);
  assert.equal(digest(record),ORDER_SPLIT210_WMS_SOURCE.before_record_sha256,
    'exact complete WMS predecessor descriptor required');
  return record;
}

export const ORDER_SPLIT210_WMS_BRANCH=`
 -- Only the owner-executed Native producer may call the private proof port.
 -- Ownership alone is not admission: the exact current-TX row proof must hold.
 IF current_user='postgres' AND TG_TABLE_NAME='wms_reservation_layers' THEN
  IF public.order_split210_row_admission(TG_TABLE_NAME,TG_OP,
   CASE WHEN TG_OP='INSERT' THEN NULL::jsonb ELSE to_jsonb(OLD) END,
   CASE WHEN TG_OP='DELETE' THEN NULL::jsonb ELSE to_jsonb(NEW) END) IS TRUE THEN
   IF TG_OP='DELETE' THEN RETURN OLD;END IF;
   RETURN NEW;
  END IF;
 END IF;`;

/** Anchored insertion only; quoted legacy source and every suffix byte survive. */
export function addOrderSplit210WmsBranch(source){
  assert.equal(typeof source,'string');
  const prefix='\n'+declaration;
  assert(source.startsWith(prefix+'\n'),'exact top-level WMS declaration required');
  assert(!source.includes('public.order_split210_row_admission('),'successor already present');
  return prefix+ORDER_SPLIT210_WMS_BRANCH+source.slice(prefix.length);
}

function functionDefinition(body){
  return 'CREATE OR REPLACE FUNCTION public.wms_row_guard()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$'+body+'$function$\n';
}

/** Literal104 body followed by the exact source-authored108 transformation. */
function predecessorBody(source104,source108){
  const needle='CREATE OR REPLACE FUNCTION wms_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$';
  assert.equal(source104.split(needle).length,2,'one literal104 WMS definition');
  const start=source104.indexOf(needle)+needle.length,end=source104.indexOf('$$;',start);
  assert(end>start,'literal104 dollar terminator');
  let body=source104.slice(start,end);
  // Read the actual quoted replacement, not an invented B2B allowance. Both
  // complete input files are pinned before this narrowly addressed extraction.
  const marker="definition:=replace(definition,'"+declaration+"',\n '";
  assert.equal(source108.split(marker).length,2,'one literal108 WMS transformation');
  const from=source108.indexOf(marker)+marker.length,to=source108.indexOf("');\n EXECUTE definition;",from);
  assert(to>from,'literal108 replacement terminator');
  const replacement=source108.slice(from,to).replaceAll("''", "'");
  assert(body.startsWith('\n'+declaration+'\n'),'literal104 top-level declaration');
  body='\n'+replacement+body.slice(1+declaration.length);
  assert.equal(sha(body),ORDER_SPLIT210_WMS_SOURCE.before_body_sha256,'complete SOURCE208 predecessor body');
  return body;
}

/** Full descriptor pin includes owner, invoker mode, all headers, ACL and definition. */
export function deriveOrderSplit210WmsSuccessor({source104,source108}){
  assert.equal(typeof source104,'string');assert.equal(typeof source108,'string');
  assert.equal(sha(source104),ORDER_SPLIT210_WMS_SOURCE.source104_sha256,'literal Source104 required');
  assert.equal(sha(source108),ORDER_SPLIT210_WMS_SOURCE.source108_sha256,'literal Source108 required');
  const source=predecessorBody(source104,source108);
  const before={owner:'postgres',language:'plpgsql',kind:'f',cost:100,rows:0,security_definer:false,
    leakproof:false,strict:false,returns_set:false,volatility:'v',parallel:'u',support:null,variadic:null,
    argument_names:null,argument_modes:null,arguments:'',result:'trigger',defaults:null,source,binary:null,
    config:null,definition:functionDefinition(source),acl_null:true,
    acl:[{grantor:'postgres',grantee:'PUBLIC',privilege:'EXECUTE',grantable:false},
      {grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]};
  assertOrderSplit210WmsPredecessor({kind:'function',key,value:before});
  const afterSource=addOrderSplit210WmsBranch(source);
  const after={...before,source:afterSource,definition:functionDefinition(afterSource)};
  return freeze({schema:'order-split210-wms-successor-candidate/v1',source_inputs:{...ORDER_SPLIT210_WMS_SOURCE},
    changes:[{kind:'function',key,before,after}],
    before_record_sha256:digest({kind:'function',key,value:before}),
    after_record_sha256:digest({kind:'function',key,value:after}),
    sql:after.definition+';\n',
    source_compilation_performed:false,native_certification:false,application_activation:false,
    remaining_source_blockers:['Native210 complete closed metadata and predecessor166/205 closure',
      'source compiler, actual Native integrity/business and ordinary HTTP/UI acceptance']});
}
