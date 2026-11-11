/** Source-only addition roster and structural checks. No catalogue adoption,
 * SQL dispatch, seal, inverse, or Native admission. A successful check leaves
 * every listed unresolved deparser/catalogue field UNREVIEWED. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assembleOrderSplit210Source} from './order-split210-source.mjs';
import {orderSplit210ObserverSpans} from './order-split210-predecessor.mjs';
import {deriveOrderSplit210TriggerRoster,parseOrderSplit210TriggerDeclaration} from './order-split210-external-triggers.mjs';
import {deriveOrderSplit210ForeignKeyRoster,parseOrderSplit210ForeignKeyDeclaration} from './order-split210-foreign-keys.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const identity=r=>r.kind+'\0'+r.key;
const kinds=['relation','column','constraint','index','policy','trigger','function','type'];
// These are the complete canonical RECORDS_SQL shapes, not a permitted subset
// of a caller's object. Unknown/new reader fields require a deliberate review.
const fields={
 relation:['owner','kind','persistence','access_method','row_security','force_row_security','replica_identity','partition','partition_bound','partition_key','options','tablespace','acl_null','acl','view'],
 column:['position','type','not_null','generated','identity','storage','compression','statistics','options','foreign_options','collation','default','acl_null','acl'],
 constraint:['kind','deferrable','deferred','validated','local','inheritance_count','no_inherit','definition'],
 index:['table','unique','primary','exclusion','immediate','clustered','valid','ready','live','replica_identity','nulls_not_distinct','definition'],
 policy:['command','permissive','roles','using','check'],
 trigger:['internal','name','enabled','type','function','attributes','arguments','constraint','constraint_relation','deferrable','deferred','has_when','old_table','new_table','definition'],
 function:['owner','language','kind','cost','rows','security_definer','leakproof','strict','returns_set','volatility','parallel','support','variadic','argument_names','argument_modes','arguments','result','defaults','source','binary','config','definition','acl_null','acl'],
 type:['owner','kind','category','defined','not_null','base','element','default','default_expression','length','by_value','preferred','delimiter','relation','subscript','array','input','output','receive','send','modifier_input','modifier_output','analyze','alignment','storage','modifier','dimensions','collation','enum_labels','acl_null','acl'],
};
const mask=s=>orderSplit210ObserverSpans(s).map(p=>p.executable?p.text:' '.repeat(p.text.length)).join('');
const type=s=>s.replaceAll('public.order_split210_','order_split210_').replace(/\btimestamptz\b/g,'timestamp with time zone');
const ownerExecute=[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}];
const ownerTable=['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'].map(privilege=>({grantor:'postgres',grantee:'postgres',privilege,grantable:false}));
const dependentTypeAcl=[{grantor:'postgres',grantee:'PUBLIC',privilege:'USAGE',grantable:false},{grantor:'postgres',grantee:'postgres',privilege:'USAGE',grantable:false}];
const readerContext=freeze({postgres_major:18,search_path:['pg_catalog','public'],timezone:'UTC',database_collation:'C.UTF-8',locale_provider:'c',
 acl_grantee_order:['PUBLIC','postgres']});
export const ORDER_SPLIT210_PG18_CATALOG_SOURCE=freeze({tag:'REL_18_4',version:'18.4',
 base_url:'https://raw.githubusercontent.com/postgres/postgres/REL_18_4/',
 files:{
  'src/include/catalog/pg_type.dat':'5f5887b75677cba2d4a1a0cfeb355df5ed91f85d385fac88bd8d7c605b3578f9',
  'src/include/catalog/pg_type.h':'8fb198749fd82b6c1818a3c18455f226f66116fcfeb3d4959c65ce3fda22802e',
  'src/include/catalog/pg_attribute.h':'e70d4e4a55c3f154048e3eef2d25f4aa2ac100e1bbb23e62c85b2ddb1d3b8098',
  'src/include/catalog/pg_proc.dat':'1f934ce80d460159dda137714374a35f9896315ea2476709cbb4da13b38ef95a',
  'src/include/catalog/pg_collation.dat':'ebb74520876d87f8ccff3bfb1f160cc44eac4843c1b894bfbdefa25bb0efe34a',
  'src/backend/access/common/tupdesc.c':'b90c111446ef3d5a7303ff7a458827ef66c2e1e79d8e8177b097baa7eaac129c',
  'src/backend/catalog/heap.c':'6334da99d1272f6099fa1129a8c39b72e8711651f74acbc1c6be13c2d6450d2c',
  'src/backend/catalog/index.c':'aa5729b26c1274b6f14ecbc24a55e097527dd51827e04e110d73605e06281844',
  'src/backend/catalog/pg_type.c':'07afe97c7d0a402c05a55b8af98980f571147d598164bf31c8160792355b2442',
  'src/backend/utils/adt/regproc.c':'20d6d3908b0642f1f9081183893d9e23c2b8d56e26ef3a180a052ee08c318095',
  'src/backend/utils/adt/ruleutils.c':'a6a616102bc6d77e303472db766639c100b88d03035560d0be974350be8a6fc1',
  'src/backend/utils/adt/acl.c':'e2d27105df25c156028c148fdfab1c968922ac045f5c992b7c36793160fd6a71',
 }});
// pg_type.dat + pg_type.h BKI defaults; TupleDescInitEntry copies these two
// properties. No source table/index declares STORAGE, COMPRESSION, COLLATE or
// STATISTICS overrides. PG18 nullable attstattarget is deliberately null.
const scalarProperties=freeze(Object.fromEntries(['uuid','text','jsonb','bigint','integer','boolean','xid8','timestamp with time zone'].map(t=>[t,
 {storage:['text','jsonb'].includes(t)?'x':'p',compression:'',statistics:null,collation:t==='text'?'"default"':null}])));
function columnProperties(t){assert(Object.hasOwn(scalarProperties,t),'literal builtin type only');return scalarProperties[t];}
const defaultBuiltins=freeze({pg_current_xact_id:'xid8',transaction_timestamp:'timestamp with time zone',clock_timestamp:'timestamp with time zone',gen_random_uuid:'uuid'});
function columnDefault(column){
 const m=/\bDEFAULT ([a-z_][a-z_0-9]*)\(\)/.exec(mask(column.tail));
 if(!m)return null;
 assert(Object.hasOwn(defaultBuiltins,m[1])&&defaultBuiltins[m[1]]===column.type,'source pg_proc zero-argument default/result binding');
 return m[1]+'()';
}
function dependentTypeProperties(array){
 // heap.c AddNewRelationType + array TypeCreate call, pg_type.c's dependent
 // type branch. IO names/signatures come from pg_proc.dat and regprocedureout.
 return {length:-1,by_value:false,preferred:false,delimiter:',',
  subscript:array?'array_subscript_handler(internal)':null,
  input:(array?'array':'record')+'_in(cstring,oid,integer)',
  output:array?'array_out(anyarray)':'record_out(record)',
  receive:(array?'array':'record')+'_recv(internal,oid,integer)',
  send:array?'array_send(anyarray)':'record_send(record)',
  modifier_input:null,modifier_output:null,analyze:array?'array_typanalyze(internal)':null,
  alignment:'d',storage:'x',modifier:-1,dimensions:0,collation:null,acl_null:true,acl:dependentTypeAcl};
}
// Restricted PG18 ruleutils.c pg_get_functiondef/pg_get_constraintdef/
// pg_get_indexdef/pg_get_triggerdef formats. These are source-derived expected
// strings, NOT an independent successful PostgreSQL compiler comparison.
// https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/utils/adt/ruleutils.c
/** Formatting primitive only; this does not authenticate an expectation. The
 * oracle calls it exclusively with independently parsed pinned declarations. */
export function formatOrderSplit210FunctionDefinition(key,v){
 assert(/^public\.order_split210_[a-z_0-9]+\([^()]*\)$/.test(key));assert.equal(typeof v.source,'string');
 assert(['sql','plpgsql'].includes(v.language));assert(['i','s','v'].includes(v.volatility));
 let header='CREATE OR REPLACE FUNCTION '+key+'\n RETURNS '+v.result+'\n LANGUAGE '+v.language+'\n';
 const flags=[v.volatility==='i'?'IMMUTABLE':v.volatility==='s'?'STABLE':null,v.security_definer?'SECURITY DEFINER':null].filter(Boolean);
 if(flags.length)header+=' '+flags.join(' ')+'\n';
 for(const config of v.config||[]){
  assert(['search_path=pg_catalog, public','TimeZone=UTC'].includes(config),'fixed source configuration only');
  header+=config.startsWith('search_path=')?" SET search_path TO 'pg_catalog', 'public'\n":" SET \"TimeZone\" TO 'UTC'\n";
 }
 // ruleutils tests the PREFIX before appending the final dollar, not just a
 // complete delimiter. A body containing $functionality also extends the tag.
 let prefix='$function';while(v.source.includes(prefix))prefix+='x';const tag=prefix+'$';
 return header+'AS '+tag+v.source+tag+'\n';
}
function triggerDefinition(semantic){
 const s=semantic;assert.equal(s.when,null);assert.equal(s.old_table,null);assert.equal(s.new_table,null);assert.deepEqual(s.function_arguments,[]);
 return 'CREATE '+(s.constraint?'CONSTRAINT ':'')+'TRIGGER '+s.name+' '+s.timing+' '+s.events.join(' OR ')+
  ' ON public.'+s.table+' '+(s.constraint?(s.deferrable?'':'NOT ')+'DEFERRABLE INITIALLY '+(s.deferred?'DEFERRED':'IMMEDIATE')+' ':'')+
  'FOR EACH '+s.level+' EXECUTE FUNCTION '+s.function_name+'()';
}
function constraintDefinition(kind,authored){
 if(kind==='n')return 'NOT NULL '+authored.column;
 if(kind==='p'||kind==='u')return(kind==='p'?'PRIMARY KEY':'UNIQUE')+' ('+authored.columns.join(', ')+')';
 const s=authored.definition?.semantic_ast;
 if(kind==='f'){
  assert(s&&s.match==='SIMPLE'&&s.on_update==='NO ACTION'&&s.on_delete==='NO ACTION');
  return 'FOREIGN KEY ('+s.columns.join(', ')+') REFERENCES '+s.referenced_table+'('+s.referenced_columns.join(', ')+')'+(s.deferrable?' DEFERRABLE':'')+(s.deferred?' INITIALLY DEFERRED':'');
 }
 if(kind==='t'){assert(s&&s.kind==='trigger');return 'TRIGGER'+(s.deferrable?' DEFERRABLE':'')+(s.deferred?' INITIALLY DEFERRED':'');}
 assert.equal(kind,'c');return null;
}

function capture(value,depth=0,budget={nodes:0,bytes:0}){
 assert(++budget.nodes<=1000000&&depth<=64,'bounded plain JSON required');
 if(value===null||typeof value==='boolean')return value;
 if(typeof value==='number'){assert(Number.isFinite(value),'finite JSON number required');return value;}
 if(typeof value==='string'){
  const bytes=Buffer.byteLength(value);assert(bytes<=8388608,'8MiB string cap');budget.bytes+=bytes;
  assert(budget.bytes<=67108864,'64MiB JSON text-work cap');assert.equal(Buffer.from(value,'utf8').toString('utf8'),value,'valid UTF8 required');return value;
 }
 assert(value&&typeof value==='object'&&[Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(value)),'plain JSON data only');
 const array=Array.isArray(value),descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
 assert(keys.every(k=>typeof k==='string'),'no symbol JSON properties');
 if(array)assert(keys.length===value.length+1&&value.length<=1000000,'dense bounded JSON array required');
 const result=array?[]:{};
 for(const key of keys){
  if(array&&key==='length')continue;
  if(array)assert(/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<value.length,'plain array index required');
  assert(Object.hasOwn(descriptors[key],'value')&&descriptors[key].enumerable,'data properties only; never invoke accessors');
  budget.bytes+=Buffer.byteLength(key)+3;assert(budget.bytes<=67108864,'64MiB JSON text-work cap');
  Object.defineProperty(result,key,{value:capture(descriptors[key].value,depth+1,budget),enumerable:true,writable:true,configurable:true});
 }
 return result;
}

function closeParen(executable,open){
 assert.equal(executable[open],'(');let depth=1;
 for(let i=open+1;i<executable.length;i++){if(executable[i]==='(')depth++;if(executable[i]===')'&&!--depth)return i;}
 assert.fail('complete balanced source parentheses required');
}
function rawEntries(body){
 const e=mask(body),parts=[];let depth=0,start=0;
 for(let i=0;i<e.length;i++){if(e[i]==='(')depth++;else if(e[i]===')')depth--;else if(e[i]===','&&depth===0){parts.push(body.slice(start,i));start=i+1;}assert(depth>=0);}
 assert.equal(depth,0);parts.push(body.slice(start));assert(parts.every(s=>s.trim()));assert.equal(parts.join(','),body);return parts;
}
function parenClauses(source,word){
 const e=mask(source),out=[];
 for(const m of e.matchAll(new RegExp('\\b'+word+'\\s*\\(','g'))){const open=e.indexOf('(',m.index),end=closeParen(e,open);out.push(source.slice(open+1,end));}
 return out;
}
// PG18 heap.c chooses a column CHECK name only if the transformed expression
// references exactly one distinct column. All pinned expressions use simple
// unqualified identifiers; strings/comments cannot contribute a column.
// https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/catalog/heap.c
// AddRelationNewConstraints / AddRelationNotNullConstraints.
function nameObject(a,b,label,occupied){
 for(let pass=0;pass<1000;pass++){
  const suffix=label+(pass||''),budget=63-(b?2:1)-suffix.length;let x=a.length,y=b?.length||0;
  while(x+y>budget){if(x>y)x--;else y--;}
  const result=a.slice(0,x)+(b?'_'+b.slice(0,y):'')+'_'+suffix;
  if(!occupied.has(result)){occupied.add(result);return result;}
 }
 assert.fail('bounded generated-name collision');
}
function sourceTables(sql){
 const e=mask(sql),out=[];
 for(const m of e.matchAll(/\bCREATE TABLE public\.(order_split210_[a-z0-9_]+)\(/g)){
  const open=e.indexOf('(',m.index),end=closeParen(e,open),raw=rawEntries(sql.slice(open+1,end)),entries=raw.map(s=>s.trim());
  assert.equal(sql[end+1],';');
  const columns=entries.flatMap(entry=>{
   const p=/^([a-z_][a-z_0-9]*) (uuid|text|jsonb|bigint|integer|boolean|xid8|timestamptz)\b([\s\S]*)$/.exec(entry);
   return p?[{name:p[1],type:type(p[2]),tail:p[3],declaration:entry}]:[];
  });
  assert(columns.length>0&&new Set(columns.map(c=>c.name)).size===columns.length);
  const primary=[...entries.flatMap(s=>parenClauses(s,'PRIMARY KEY')),
   ...columns.filter(c=>/\bPRIMARY KEY\b/.test(c.tail)).map(c=>c.name)];
  assert.equal(primary.length,1,'one authored primary key per table');
  const primaryColumns=primary[0].split(',').map(v=>v.trim());
  assert(primaryColumns.every(c=>columns.some(v=>v.name===c)));
  out.push({name:m[1],entries,raw_entries:raw,columns,primary:primaryColumns,
   declaration:sql.slice(m.index,end+2),prefix:sql.slice(m.index,open+1),suffix:sql.slice(end,end+2)});
 }
 assert.equal(out.length,8);return out;
}
function sourceFunctions(sql){
 const e=mask(sql),out=[];
 for(const m of e.matchAll(/\bCREATE FUNCTION public\.(order_split210_[a-z0-9_]+)\(/g)){
  const h=/^CREATE FUNCTION public\.([a-z_0-9]+)\(([^()]*)\)\s+RETURNS ([a-z_][a-z_0-9.]*(?:\[\])?)\s+LANGUAGE (sql|plpgsql)\b([\s\S]*?) AS (\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)/.exec(sql.slice(m.index));
  assert(h,'complete supported source function header');
  const [,name,rawArgs,result,language,attributes,tag]=h,end=sql.indexOf(tag,m.index+h[0].length);
  assert(end>m.index+h[0].length);assert.equal(sql[end+tag.length],';');
  const args=rawArgs.split(',').map(v=>v.trim()).filter(Boolean).map(type),config=[];
  let rest=attributes.replace(/\bSET search_path=pg_catalog,public/g,()=>{config.push('search_path=pg_catalog, public');return '';})
   .replace(/\bSET TimeZone='UTC'/g,()=>{config.push('TimeZone=UTC');return '';});
  const security=/\bSECURITY DEFINER\b/.test(rest),volatility=/\bIMMUTABLE\b/.test(rest)?'i':/\bSTABLE\b/.test(rest)?'s':'v';
  rest=rest.replace(/\b(?:SECURITY DEFINER|IMMUTABLE|STABLE|VOLATILE)\b/g,'');assert.equal(rest.trim(),'','all header attributes accounted for');
  const key='public.'+name+'('+args.join(', ')+')',known={owner:'postgres',language,kind:'f',cost:100,rows:0,
   security_definer:security,leakproof:false,strict:false,returns_set:false,volatility,parallel:'u',support:null,variadic:null,
   argument_names:args.length?args.map(a=>a.slice(0,a.indexOf(' '))):null,argument_modes:null,arguments:args.join(', '),result:type(result),defaults:null,
   source:sql.slice(m.index+h[0].length,end),binary:null,config:config.length?config:null,acl_null:false,acl:ownerExecute};
  known.definition=formatOrderSplit210FunctionDefinition(key,known);
  out.push({kind:'function',key,known,authored:{declaration_header:h[0].slice(0,-tag.length)},unresolved_fields:[]});
 }
 assert.equal(out.length,27);return out;
}
function commonConstraint(kind,no_inherit=false){return{kind,deferrable:false,deferred:false,validated:true,local:true,inheritance_count:0,no_inherit};}

/** Re-derives from pinned source inputs; accepts neither an observed catalogue
 * nor caller-supplied expected records. No filesystem or large H imports. */
export function deriveOrderSplit210AdditionOracle(inputs){
 const program=assembleOrderSplit210Source(inputs),tables=sourceTables(program.sql),records=[],usedNames=new Set();
 const add=(kind,key,known,authored={})=>{
  if(kind==='constraint'&&!Object.hasOwn(known,'definition')){const text=constraintDefinition(known.kind,authored);if(text!==null)known={...known,definition:text};}
  if(kind==='trigger'&&!Object.hasOwn(known,'definition'))known={...known,definition:triggerDefinition(authored.definition.semantic_ast)};
  records.push({kind,key,known,authored,unresolved_fields:fields[kind].filter(f=>!Object.hasOwn(known,f))});
 };
 const triggers=deriveOrderSplit210TriggerRoster(inputs),foreign=deriveOrderSplit210ForeignKeyRoster(inputs);
 const tableNames=new Set(tables.map(t=>t.name));
 const indexSpecs=[];
 for(const t of tables){
  add('relation','public.'+t.name,{owner:'postgres',kind:'r',persistence:'p',access_method:'heap',row_security:true,force_row_security:true,
   replica_identity:'d',partition:false,partition_bound:null,partition_key:null,options:null,tablespace:null,acl_null:false,acl:ownerTable,view:null});
  for(let i=0;i<t.columns.length;i++){
   const c=t.columns[i],generated=/\bGENERATED ALWAYS AS\(/.test(c.tail),notNull=/\bNOT NULL\b|\bPRIMARY KEY\b/.test(c.tail)||t.primary.includes(c.name);
   add('column',`public.${t.name}.${c.name}`,{position:i+1,type:c.type,not_null:notNull,generated:generated?'s':'',identity:'',
    ...columnProperties(c.type),options:null,foreign_options:null,acl_null:true,acl:[],...(!generated?{default:columnDefault(c)}:{})},
    {declaration:c.declaration,generated_expression:generated?parenClauses(c.tail,'GENERATED ALWAYS AS')[0]:null});
   if(notNull){const name=nameObject(t.name,c.name,'not_null',usedNames);add('constraint',`public.${t.name}.${name}`,commonConstraint('n'),{column:c.name,declaration:c.declaration});}
  }
  const checkNames=[];
  for(const entry of t.entries){
   for(const expression of parenClauses(entry,'CHECK')){
    const tokens=new Set(mask(expression).match(/\b[a-z_][a-z_0-9]*\b/g)||[]),vars=t.columns.filter(c=>tokens.has(c.name)).map(c=>c.name);
    const name=nameObject(t.name,vars.length===1?vars[0]:null,'check',usedNames);checkNames.push(name);
    add('constraint',`public.${t.name}.${name}`,commonConstraint('c'),{expression,column_references:vars});
   }
  }
  assert(checkNames.length>0);
  for(const [label,lists] of [['pkey',[t.primary]],['key',t.entries.flatMap(s=>parenClauses(s,'UNIQUE')).map(s=>s.split(',').map(v=>v.trim()))]]){
   for(const columns of lists){assert(columns.every(c=>t.columns.some(v=>v.name===c)));const name=nameObject(t.name,label==='pkey'?null:columns.join('_'),label,usedNames);
    add('constraint',`public.${t.name}.${name}`,commonConstraint(label==='pkey'?'p':'u',true),{columns});
    indexSpecs.push({name,table:t.name,columns,primary:label==='pkey',predicate:null});
   }
  }
  add('policy',`public.${t.name}.owner_scope`,{command:'*',permissive:true,roles:['postgres'],using:'true',check:'true'},{using:'true',check:'true'});
  for(const array of [false,true])add('type','public.'+(array?'_':'')+t.name,{owner:'postgres',kind:array?'b':'c',category:array?'A':'C',defined:true,
   not_null:false,base:null,element:array?t.name:null,default:null,default_expression:null,relation:array?null:t.name,
   array:array?null:t.name+'[]',enum_labels:[],...dependentTypeProperties(array)},{table:t.name,array});
 }
 // One literal partial index, in addition to every PK/UNIQUE backing index.
 const explicit=[...mask(inputs.source210).matchAll(/CREATE UNIQUE INDEX ([a-z_0-9]+) ON public\.([a-z_0-9]+)\(([^()]+)\) WHERE ([^;]+);/g)];
 assert.equal(explicit.length,1);for(const [,name,table,cols,predicate]of explicit){assert(tableNames.has(table));assert(!usedNames.has(name));usedNames.add(name);indexSpecs.push({name,table,columns:cols.split(',').map(v=>v.trim()),primary:false,predicate:predicate.trim()});}
 for(const i of indexSpecs){
  const table=tables.find(t=>t.name===i.table);assert(table);assert(i.columns.every(c=>table.columns.some(v=>v.name===c)));
  add('relation','public.'+i.name,{owner:'postgres',kind:'i',persistence:'p',access_method:'btree',row_security:false,force_row_security:false,
   replica_identity:'n',partition:false,partition_bound:null,partition_key:null,options:null,tablespace:null,acl_null:true,acl:ownerTable,view:null});
  assert(i.predicate===null||i.predicate==='slot_id IS NULL','only literal simple source predicate is deparsed');
  add('index','public.'+i.name,{table:i.table,unique:true,primary:i.primary,exclusion:false,immediate:true,clustered:false,valid:true,ready:true,live:true,
   replica_identity:false,nulls_not_distinct:false,
   definition:'CREATE UNIQUE INDEX '+i.name+' ON public.'+i.table+' USING btree ('+i.columns.join(', ')+')'+(i.predicate?' WHERE ('+i.predicate+')':'')},
   {columns:i.columns,predicate:i.predicate});
  for(let n=0;n<i.columns.length;n++){const c=table.columns.find(v=>v.name===i.columns[n]);
   // ConstructTupleDescriptor zero-initializes attnotnull and copies only the
   // parent's type/storage/compression, not its NOT NULL or generated/default.
   add('column',`public.${i.name}.${c.name}`,{position:n+1,type:c.type,not_null:false,generated:'',identity:'',...columnProperties(c.type),
    options:null,foreign_options:null,default:null,acl_null:true,acl:[]},{table:i.table,column:c.name});
  }
 }
 for(const r of [...foreign.constraints,...triggers.constraints]){const{definition,...known}=r.value;add(r.kind,r.key,known,{definition});}
 for(const r of [...foreign.ri_triggers,...triggers.triggers]){const{definition,...known}=r.value;add(r.kind,r.key,definition===null?{...known,definition:null}:known,{definition});}
 // Four statically authored closure triggers on the two DATA tables.
 const closure=program.stages.find(s=>s.id==='closure-data'),text=Buffer.from(program.sql).subarray(closure.offset,closure.offset+closure.bytes).toString('utf8');
 const declared=[...mask(text).matchAll(/CREATE TRIGGER [^;]+;/g)];assert.equal(declared.length,4);
 for(const d of declared){const r=parseOrderSplit210TriggerDeclaration(d[0]).trigger,{definition,...known}=r.value;add(r.kind,r.key,known,{definition});}
 records.push(...sourceFunctions(program.sql));
 records.sort((a,b)=>identity(a)<identity(b)?-1:identity(a)>identity(b)?1:0);
 assert.equal(new Set(records.map(identity)).size,records.length,'source roster cannot hide duplicate object identities');
 assert.deepEqual([...new Set(records.map(r=>r.kind))].sort(),[...kinds].sort(),'all eight kinds covered');
 for(const r of records){assert.deepEqual([...Object.keys(r.known),...r.unresolved_fields].sort(),[...fields[r.kind]].sort(),'every catalogue field is checked or explicitly pending');}
 const counts=Object.fromEntries(kinds.map(k=>[k,records.filter(r=>r.kind===k).length]));
 const grouped=new Map();
 for(const r of records)for(const field of r.unresolved_fields){
  const construct=r.kind==='constraint'?'CHECK-expression':r.kind==='column'?
   (r.authored.generated_expression?'generated-column':r.authored.declaration?(r.known.default===null?'ordinary-column':'defaulted-column'):'index-column'):
   r.kind==='type'?(r.authored.array?'array-type':'table-composite-type'):r.kind;
  const key=[r.kind,construct,field].join('\0');if(!grouped.has(key))grouped.set(key,{kind:r.kind,construct,field,keys:[]});grouped.get(key).keys.push(r.key);
 }
 return freeze({schema:'order-split210-source-addition-oracle/v1',candidate:{sha256:program.sha256,bytes:program.bytes},records,counts,
  roster_sha256:sha(JSON.stringify(records.map(r=>[r.kind,r.key]))),source_basis_sha256:sha(JSON.stringify(canonical(records))),
  naming_preconditions:{postgres_major:18,max_identifier_bytes:63,new_namespace_unoccupied:true,verified:false},
  // This is a required reader context, never a caller-provided verified flag.
  // Independent Root locale/literal-grantee-order proof must be bound by the
  // eventual source-compiler review; this pure module cannot establish it.
  reader_context:readerContext,reader_context_verified:false,catalogue_source:ORDER_SPLIT210_PG18_CATALOG_SOURCE,
  unresolved:records.filter(r=>r.unresolved_fields.length).map(r=>({kind:r.kind,key:r.key,fields:r.unresolved_fields})),
  unresolved_by_construct:[...grouped.values()].map(v=>({...v,count:v.keys.length})),
  deparser_source:'https://github.com/postgres/postgres/blob/REL_18_4/src/backend/utils/adt/ruleutils.c',
  deparser_compiler_verified:false,complete:false,compiled_catalogue_records:false,native_certification:false,application_activation:false});
}

/** Checks every captured addition, not a prefix-selected subset. No result of
 * this function may be used as a seal/full inverse or a runtime verdict. */
export function assertOrderSplit210AdditionSemantics(records,inputs){
 assert(Array.isArray(records)&&records.length<=10000,'bounded addition array required');
 records=capture(records);
 assert(Buffer.byteLength(JSON.stringify(records))<=67108864,'64MiB addition capture cap');
 const expected=deriveOrderSplit210AdditionOracle(inputs),byKey=new Map();
 for(const r of records){
  assert(r&&typeof r==='object'&&!Array.isArray(r));assert.deepEqual(Object.keys(r).sort(),['key','kind','value']);
  assert(kinds.includes(r.kind)&&typeof r.key==='string','fixed addition kind/key');assert(!byKey.has(identity(r)),'duplicate addition');
  assert(r.value&&typeof r.value==='object'&&!Array.isArray(r.value));assert.deepEqual(Object.keys(r.value).sort(),[...fields[r.kind]].sort(),'complete canonical metadata fields required');
  if(['function','constraint','index'].includes(r.kind))assert.equal(typeof r.value.definition,'string','complete deparser text must be retained for independent review');
  assert(Buffer.byteLength(JSON.stringify(r))<=8388608,'8MiB per-record cap');byKey.set(identity(r),r);
 }
 assert.deepEqual([...byKey.keys()].sort(),expected.records.map(identity).sort(),'exact source-derived addition roster (including external edges and implicit objects)');
 for(const e of expected.records){const actual=byKey.get(identity(e));for(const[field,value]of Object.entries(e.known))
  assert.deepEqual(canonical(actual.value[field]),canonical(value),`${e.kind} ${e.key}: source-derived ${field}`);
 }
 return freeze({schema:'order-split210-addition-semantics-review/v1',candidate:expected.candidate,counts:expected.counts,
  checked_source_fields:true,exact_roster:true,unresolved:expected.unresolved,required_reader_context:expected.reader_context,reader_context_verified:false,complete:false,seal_allowed:false,
  source_expression_review_required:true,full_inverse_verified:false,native_certification:false,application_activation:false});
}

export const ORDER_SPLIT210_EXPRESSION_PROBE_SCHEMA='order_split210_expression_probe_v1';
const quote=s=>"'"+s.replaceAll("'","''")+"'";
const builtinExpressions=new Set(['octet_length','jsonb_typeof','encode','sha256','decode','replace','chr','repeat',...Object.keys(defaultBuiltins)]);
function assertBuiltinExpression(expression){
 const e=mask(expression);assert(!/[;]/.test(e)&&!(/\b(?:SELECT|FROM|EXECUTE|CREATE|ALTER|DROP)\b/i.test(e)),'literal scalar expression only');
 for(const m of e.matchAll(/(?<![a-z_0-9.])((?:[a-z_][a-z_0-9]*\.)?[a-z_][a-z_0-9]*)\s*\(/gi)){
  if(['IN','AND','OR','NOT'].includes(m[1].toUpperCase()))continue;
  const parts=m[1].split('.');assert(parts.length===1||parts[0]==='pg_catalog','no nonbuiltin expression namespace');
  assert(builtinExpressions.has(parts.at(-1)),'closed builtin expression function roster: '+m[1]);
 }
}

/** Independent source-compiler input for the remaining44 CHECK+4generated
 * expression leaves. A Root-owned transaction may execute this in a unique
 * temporary schema and MUST roll back. Nothing is executed by this module.
 * Only the exact18 already-authenticated FK clauses are removed; all other
 * table bytes/expressions/PK/UNIQUE/NOT NULL declarations are preserved. */
export function deriveOrderSplit210ExpressionProbe(inputs){
 const program=assembleOrderSplit210Source(inputs),oracle=deriveOrderSplit210AdditionOracle(inputs),tables=sourceTables(program.sql);
 const foreign=deriveOrderSplit210ForeignKeyRoster(inputs),schema=ORDER_SPLIT210_EXPRESSION_PROBE_SCHEMA,seen=new Set(),projections=[];
 for(const table of tables){
  const edits=[],afterEntries=table.raw_entries.map((raw,index)=>{
   if(!/\bREFERENCES\b|\bFOREIGN KEY\b/.test(mask(raw)))return raw;
   const parsed=parseOrderSplit210ForeignKeyDeclaration({table:table.name,declaration:raw.trim(),primaryKeys:{tenants:['id'],users:['id']}});
   const expected=foreign.foreign_keys.find(f=>f.table===table.name&&JSON.stringify(f.columns)===JSON.stringify(parsed.columns));assert(expected,'source-authored FK removal only');
   const{name,constraint_key,...semantics}=expected;assert.deepEqual(canonical(parsed),canonical(semantics));assert(!seen.has(constraint_key),'no duplicate FK removal');seen.add(constraint_key);
   const after=/^\s*FOREIGN KEY\(/.test(raw)?null:raw.replace(/ REFERENCES public\.[a-z_][a-z_0-9]*(?:\([^()]*\))?(?: DEFERRABLE INITIALLY DEFERRED)?(?=\s*$)/,'');
   assert(after!==raw,'one complete source FK clause removed');
   if(after!==null)assert(/^[a-z_][a-z_0-9]* uuid NOT NULL$/.test(after.trim()),'inline FK preserves exact column type/nullability');
   edits.push({index,before:raw,after,constraint_key,name});return after;
  });
  const recovered=[...afterEntries];for(const edit of edits){assert.equal(recovered[edit.index],edit.after);recovered[edit.index]=edit.before;}
  assert.equal(table.prefix+recovered.join(',')+table.suffix,table.declaration,'complete declaration inverse before schema rewrite');
  const projectedPrefix=table.prefix.replace('public.'+table.name,schema+'.'+table.name);assert.notEqual(projectedPrefix,table.prefix);
  const sql=projectedPrefix+afterEntries.filter(s=>s!==null).join(',')+table.suffix;
  assert(!/\bREFERENCES\b|\bFOREIGN KEY\b/.test(mask(sql)),'all and only authenticated external references removed');
  for(const entry of table.entries)for(const expression of parenClauses(entry,'CHECK'))assertBuiltinExpression(expression);
  for(const c of table.columns){const generated=parenClauses(c.tail,'GENERATED ALWAYS AS');generated.forEach(assertBuiltinExpression);const d=columnDefault(c);if(d)assertBuiltinExpression(d);}
  projections.push({table:'public.'+table.name,source_sql:table.declaration,source_sql_sha256:sha(table.declaration),sql,sql_sha256:sha(sql),edits,inverse_verified:true});
 }
 assert.equal(seen.size,18);assert.deepEqual([...seen].sort(),foreign.foreign_keys.map(f=>f.constraint_key).sort());
 const targets=oracle.records.flatMap(r=>r.kind==='constraint'&&r.known.kind==='c'?[{kind:r.kind,key:r.key,field:'definition'}]:
  r.kind==='column'&&r.authored.generated_expression?[{kind:r.kind,key:r.key,field:'default'}]:[]);
 assert.equal(targets.filter(r=>r.kind==='constraint').length,44);
 assert.deepEqual(targets.filter(r=>r.kind==='column').map(r=>r.key),[
  'public.order_split210_projection_basis.payload_jsonb','public.order_split210_projection_basis.payload_octets',
  'public.order_split210_projection_basis.payload_schema','public.order_split210_projection_basis.payload_sha256',
 ],'only the three historical generated leaves and the finite appended schema scalar');
 const scalar=oracle.records.find(r=>r.kind==='column'&&r.key==='public.order_split210_projection_basis.payload_schema');
 assert.equal(scalar.known.position,6);assert.equal(scalar.known.type,'text');assert.equal(scalar.known.not_null,false);assert.equal(scalar.known.generated,'s');
 assert.equal(scalar.authored.generated_expression,"(payload::jsonb)->>'schema'",'new expression comes from raw payload, not another generated column');
 const sql='CREATE SCHEMA '+schema+' AUTHORIZATION postgres;\n'+projections.map(p=>p.sql).join('\n')+'\n';
 const keyList=kind=>targets.filter(t=>t.kind===kind).map(t=>quote(t.key.slice('public.'.length))).join(',');
 const readback_sql=`SELECT 'constraint'::text kind,'public.'||c.relname||'.'||k.conname key,'definition'::text field,pg_catalog.pg_get_constraintdef(k.oid,true) value
 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=${quote(schema)} AND k.contype='c' AND(c.relname||'.'||k.conname)IN(${keyList('constraint')})
 UNION ALL SELECT 'column','public.'||c.relname||'.'||a.attname,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid)
 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_catalog.pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum)
 WHERE n.nspname=${quote(schema)} AND(a.attrelid>0 AND a.attnum>0 AND NOT a.attisdropped)AND(c.relname||'.'||a.attname)IN(${keyList('column')})
 ORDER BY kind,key,field`;
 return freeze({schema:'order-split210-independent-expression-probe/v1',namespace:schema,source_candidate:oracle.candidate,
  required_context:{postgres_major:18,owner:'postgres',session_user:'postgres',server_encoding:'UTF8',timezone:'UTC',search_path:['pg_catalog','public'],
   schema_absent:true,own_transaction:true,unconditional_rollback:true},
  sql,sql_sha256:sha(sql),sql_bytes:Buffer.byteLength(sql),readback_sql,readback_sha256:sha(readback_sql),targets,table_projections:projections,
  counts:{tables:8,removed_foreign_keys:18,check_definitions:44,generated_expressions:4,readback_leaves:48},
  catalogue_source:ORDER_SPLIT210_PG18_CATALOG_SOURCE,source_compilation_performed:false,full_inverse_verified:false,
  seal_allowed:false,native_certification:false,application_activation:false});
}
