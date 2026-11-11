/** Authored trigger metadata basis only. Definition ASTs are NOT cold catalogue records. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const ORDER_SPLIT210_TRIGGER_SOURCE_SHA256='fb803220a91c2cefcc6953d1aebd69e173dbc079a94d161bf6bb2d326ed0f4a1';
const sha=s=>createHash('sha256').update(s).digest('hex');
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const canonical=v=>{
  assert(v!==undefined&&typeof v!=='function'&&typeof v!=='symbol','JSON basis required');
  return Array.isArray(v)?Array.from(v,canonical):v&&typeof v==='object'
    ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
};
const id=r=>r.kind+'\0'+r.key;
const sorted=rows=>rows.sort((a,b)=>id(a)<id(b)?-1:id(a)>id(b)?1:0);
const eventBits={INSERT:4,DELETE:8,UPDATE:16,TRUNCATE:32};

/** Restricted grammar of the actual pinned source, not a permissive SQL parser. */
export function parseOrderSplit210TriggerDeclaration(sql){
  assert.equal(typeof sql,'string');
  const normalized=sql.trim().replace(/;$/,'').replace(/\s+/g,' ');
  const m=/^CREATE (CONSTRAINT )?TRIGGER ([a-z][a-z0-9_]*) (BEFORE|AFTER) ((?:INSERT|DELETE|UPDATE|TRUNCATE)(?: OR (?:INSERT|DELETE|UPDATE|TRUNCATE))*) ON public\.([a-z][a-z0-9_]*)( DEFERRABLE INITIALLY DEFERRED)? FOR EACH (ROW|STATEMENT) EXECUTE FUNCTION public\.([a-z][a-z0-9_]*)\(\)$/.exec(normalized);
  assert(m,'unsupported trigger declaration: no guessed metadata');
  const [,constraint,name,timing,eventsText,table,deferral,level,fn]=m;
  const events=eventsText.split(' OR ');
  assert.equal(new Set(events).size,events.length,'duplicate trigger event');
  assert(!events.includes('TRUNCATE')||level==='STATEMENT','TRUNCATE must be statement level');
  if(constraint)assert(timing==='AFTER'&&level==='ROW'&&!events.includes('TRUNCATE')&&deferral,
    'supported constraint trigger must be deferred AFTER ROW');
  else assert(!deferral,'ordinary trigger cannot carry constraint deferral');
  const deferred=Boolean(deferral),type=(level==='ROW'?1:0)+(timing==='BEFORE'?2:0)+events.reduce((n,e)=>n+eventBits[e],0);
  const semantic={schema:'public',table,name,timing,events:[...events].sort((a,b)=>eventBits[a]-eventBits[b]),
    level,function_schema:'public',function_name:fn,function_arguments:[],constraint:Boolean(constraint),
    deferrable:deferred,deferred,when:null,old_table:null,new_table:null};
  // regprocedure's text is unqualified in the explicit pg_catalog,public reader
  // context. The compiler must retain this context and verify the full fields.
  const trigger={kind:'trigger',key:`public.${table}.${name}`,value:{internal:false,name,enabled:'O',type,
    function:fn+'()',attributes:[],arguments:'',constraint:constraint?name:null,constraint_relation:null,
    deferrable:deferred,deferred,has_when:false,old_table:null,new_table:null,
    definition:{schema:'uncompiled-pg-trigger-definition/v1',semantic_ast:semantic}}};
  const pair=constraint?{kind:'constraint',key:trigger.key,value:{kind:'t',deferrable:deferred,deferred,
    validated:true,local:true,inheritance_count:0,no_inherit:true,
    definition:{schema:'uncompiled-pg-trigger-constraint-definition/v1',semantic_ast:{kind:'trigger',deferrable:deferred,deferred}}}}:null;
  return freeze({semantic,trigger,constraint:pair,compiled_descriptor:false,unresolved_pg_fields:['definition']});
}

function block(source,tag){
  const start='DO $'+tag+'$',end='END $'+tag+'$;';
  assert.equal(source.split(start).length,2,'one exact source block '+tag);
  const a=source.indexOf(start)+start.length,b=source.indexOf(end,a);assert(b>a,'source block end '+tag);
  return source.slice(a,b);
}
function expand(source,tag,expectedTemplates){
  const s=block(source,tag),arrays=[...s.matchAll(/FOREACH tab IN ARRAY ARRAY\[([\s\S]*?)\] LOOP/g)];
  assert.equal(arrays.length,1,'one exact table array '+tag);
  assert(/^\s*'[a-z][a-z0-9_]*'(?:\s*,\s*'[a-z][a-z0-9_]*')*\s*$/.test(arrays[0][1]),'literal table identifiers only');
  const tables=[...arrays[0][1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map(m=>m[1]);
  assert.equal(new Set(tables).size,tables.length,'duplicate source table');
  const templates=[...s.matchAll(/EXECUTE format\('((?:[^']|'')*)',tab\);/g)]
    .map(m=>m[1].replaceAll("''", "'")).filter(t=>/^CREATE (?:CONSTRAINT )?TRIGGER /.test(t));
  assert.equal(templates.length,expectedTemplates,'exact trigger template count '+tag);
  return templates.flatMap(t=>{
    assert.equal(t.split('%I').length,2,'one source table placeholder');
    return tables.map(table=>parseOrderSplit210TriggerDeclaration(t.replace('%I',table)));
  });
}

/** Exact closed authored roster. FK-linked RI triggers are a separate future compiler obligation. */
export function deriveOrderSplit210TriggerRoster({source210}){
  assert.equal(typeof source210,'string');
  assert.equal(sha(source210),ORDER_SPLIT210_TRIGGER_SOURCE_SHA256,'literal frozen Native210 source required');
  const ownTables=[...source210.matchAll(/^CREATE TABLE public\.(order_split210_[a-z0-9_]+)\(/gm)].map(m=>m[1]);
  assert.equal(ownTables.length,6);assert.equal(new Set(ownTables).size,6);
  const ownSet=new Set(ownTables);
  const own=expand(source210,'split210_acl',2);
  const externalBound=expand(source210,'split210_bounds',1);
  // Financial/fulfillment history is checked at the REQUIRED genuine managed
  // terminal tail. No new external deferred trigger changes those old families.
  const externalDeferred=[];
  assert(!source210.includes('order_split210_recheck'),'no orphan recheck helper or trigger');
  const direct=[...source210.matchAll(/^CREATE CONSTRAINT TRIGGER [^;]+;/gm)].map(m=>parseOrderSplit210TriggerDeclaration(m[0]));
  assert.equal(direct.length,3,'all three own completion/replay triggers');
  const all=[...own,...direct,...externalBound,...externalDeferred];
  assert.equal((source210.match(/CREATE (?:CONSTRAINT )?TRIGGER /g)||[]).length,6,'all source trigger statements accounted for');
  assert([...own,...direct].every(r=>ownSet.has(r.semantic.table)),'own table trigger bound to actual own table');
  assert([...externalBound,...externalDeferred].every(r=>!ownSet.has(r.semantic.table)),'external tables explicitly separate');
  const triggers=sorted(all.map(r=>r.trigger)),constraints=sorted(all.flatMap(r=>r.constraint?[r.constraint]:[]));
  assert.equal(new Set(triggers.map(id)).size,triggers.length,'unique exact trigger identities');
  assert.equal(new Set(constraints.map(id)).size,constraints.length,'unique exact constraint identities');
  const groups={own_tables:[...ownTables].sort(),own:[...own,...direct].map(r=>r.trigger.key).sort(),
    external_bound:externalBound.map(r=>r.trigger.key).sort(),external_deferred:externalDeferred.map(r=>r.trigger.key).sort()};
  return freeze({schema:'order-split210-authored-trigger-roster/v1',source_sha256:ORDER_SPLIT210_TRIGGER_SOURCE_SHA256,
    reader_context:{postgres_major:18,search_path:['pg_catalog','public']},groups,triggers,constraints,
    constraint_pairs:constraints.map(c=>({trigger_key:c.key,constraint_key:c.key})),
    counts:{own:groups.own.length,external_bound:externalBound.length,external_deferred:externalDeferred.length,
      triggers:triggers.length,constraints:constraints.length},
    unresolved_pg_fields:['trigger.definition','constraint.definition'],
    compiled_catalogue_records:false,source_compilation_performed:false,native_certification:false,
    application_activation:false,foreign_key_ri_roster_complete:false});
}

/** Checks authored basis only; NEVER validates native catalogue deparser output. */
export function assertOrderSplit210TriggerBasisRoster(records,{source210}){
  const expected=deriveOrderSplit210TriggerRoster({source210});
  assert(Array.isArray(records),'basis array required');
  for(const r of records)assert(r&&(r.kind==='trigger'||r.kind==='constraint'),'explicit catalogue kind required; contype t is not a record kind');
  assert.equal(new Set(records.map(id)).size,records.length,'duplicate basis record');
  assert.deepEqual(canonical(sorted([...records])),canonical(sorted([...expected.triggers,...expected.constraints])),
    'exact authored trigger/constraint basis required');
  return freeze({authored_basis_equal:true,compiled_catalogue_records:false,native_certification:false});
}
