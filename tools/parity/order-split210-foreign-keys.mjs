/** Source-authored FK/RI basis, NOT PostgreSQL compilation or Native proof.
 * Internal RI names are normalized exactly like RECORDS_SQL; no OID guessing.
 * PG18 naming/RI rules: https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/commands/indexcmds.c
 * (makeObjectName), tablecmds.c (ChooseForeignKeyConstraintNameAddition,
 * CreateFKCheckTrigger/createForeignKeyActionTriggers), catalog/pg_constraint.c
 * (ChooseConstraintName). Restricted ASCII grammar matches this literal source.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const ORDER_SPLIT210_FK_SOURCE_SHA256='fb803220a91c2cefcc6953d1aebd69e173dbc079a94d161bf6bb2d326ed0f4a1';
export const ORDER_SPLIT210_FK_SCHEMA_SHA256='510b924e93a8563f704d8566ef549d4dc7f435349a2f9db98f81e7a9b4eda8e1';
const sha=s=>createHash('sha256').update(s).digest('hex');
const ident=s=>assert(typeof s==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(s),'supported ASCII identifier required');
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const identity=r=>r.kind+'\0'+r.key;
const sorted=rows=>rows.sort((a,b)=>identity(a)<identity(b)?-1:identity(a)>identity(b)?1:0);
function canonical(v){
 assert(v!==undefined&&typeof v!=='function'&&typeof v!=='symbol','JSON basis required');
 if(v===null||typeof v!=='object'){assert(typeof v!=='number'||Number.isFinite(v),'finite JSON required');return v;}
 return Array.isArray(v)?Array.from(v,canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));
}
function columns(value){const result=value.split(',').map(v=>v.trim());result.forEach(ident);assert.equal(new Set(result).size,result.length,'duplicate FK column');return result;}

/** PG18 makeObjectName + ChooseConstraintName for the supported ASCII subset.
 * Occupied names are explicit naming inputs, NOT observed expected metadata.
 * Roster derivation uses authored names only; namespace absence remains an
 * explicit precondition to verify during the future real source compilation. */
export function orderSplit210ForeignKeyName(table,localColumns,occupied=[]){
 ident(table);assert(Array.isArray(localColumns)&&localColumns.length>0&&localColumns.length<=32);localColumns.forEach(ident);
 assert.equal(new Set(localColumns).size,localColumns.length,'duplicate FK column');
 assert(Array.isArray(occupied)&&occupied.length<=10000);occupied.forEach(ident);const used=new Set(occupied);
 // PG concatenates complete attributes and stops once the addition reaches64.
 let addition='';for(const c of localColumns){addition+=(addition?'_':'')+c;if(addition.length>=64)break;}
 for(let pass=0;pass<1000;pass++){
  const label='fkey'+(pass||''),budget=63-2-label.length;let a=table.length,b=addition.length;
  while(a+b>budget){if(a>b)a--;else b--;}
  const name=table.slice(0,a)+'_'+addition.slice(0,b)+'_'+label;
  if(!used.has(name))return name;
 }
 assert.fail('FK name collision budget exceeded');
}

/** Strict actual-source FK grammar. Unsupported actions/match/quoted names,
 * explicit names or partial validation are refused rather than approximated. */
export function parseOrderSplit210ForeignKeyDeclaration({table,declaration,primaryKeys={}}){
 ident(table);assert.equal(typeof declaration,'string');const sql=declaration.trim().replace(/\s+/g,' ');
 let m=/^FOREIGN KEY\(([^()]+)\) REFERENCES public\.([a-z][a-z0-9_]*)(?:\(([^()]+)\))?( DEFERRABLE INITIALLY DEFERRED)?$/.exec(sql),local,ref,remote,deferred;
 if(m){local=columns(m[1]);ref=m[2];remote=m[3];deferred=!!m[4];}
 else{
  m=/^([a-z][a-z0-9_]*) uuid NOT NULL REFERENCES public\.([a-z][a-z0-9_]*)(?:\(([^()]+)\))?( DEFERRABLE INITIALLY DEFERRED)?$/.exec(sql);
  assert(m,'unsupported FK grammar: no guessed columns/actions');local=[m[1]];ref=m[2];remote=m[3];deferred=!!m[4];
 }
 ident(ref);const referenced=remote?columns(remote):primaryKeys[ref];
 assert(Array.isArray(referenced)&&referenced.length>0,'omitted referenced columns require a source primary key');referenced.forEach(ident);
 assert.equal(local.length,referenced.length,'FK column cardinality');
 return freeze({schema:'public',table,columns:local,referenced_schema:'public',referenced_table:ref,
  referenced_columns:[...referenced],referenced_columns_implicit:!remote,match:'SIMPLE',on_update:'NO ACTION',on_delete:'NO ACTION',
  update_action:'a',delete_action:'a',deferrable:deferred,deferred,validated:true,local:true,inheritance_count:0,no_inherit:true});
}

// Split ONLY top-level table entries; commas/parentheses in quoted CHECK data
// cannot create phantom FK declarations. This is deliberately not generic SQL.
function entries(body){
 const out=[];let depth=0,quote=false,start=0;
 for(let i=0;i<body.length;i++){
  const c=body[i];if(c==="'"){if(quote&&body[i+1]==="'"){i++;continue;}quote=!quote;continue;}
  if(quote)continue;
  assert(c!=='"'&&c!=='$'&&!(c==='-'&&body[i+1]==='-')&&!(c==='/'&&body[i+1]==='*'),'unsupported table grammar');
  if(c==='(')depth++;else if(c===')'){depth--;assert(depth>=0,'unbalanced table grammar');}
  else if(c===','&&depth===0){out.push(body.slice(start,i).trim());start=i+1;}
 }
 assert(!quote&&depth===0,'unbalanced table grammar');out.push(body.slice(start).trim());assert(out.every(Boolean),'empty table entry');return out;
}
function ri(fk,name,check,event){
 const table=check?fk.table:fk.referenced_table,opposite=check?fk.referenced_table:fk.table;
 const fn='"RI_FKey_'+(check?'check_'+(event==='INSERT'?'ins':'upd'):'noaction_'+(event==='DELETE'?'del':'upd'))+'"()',type=event==='INSERT'?5:event==='DELETE'?9:17;
 return {kind:'trigger',key:`public.${table}.internal:${name}:${fn}:${type}:`,value:{internal:true,name:null,enabled:'O',type,function:fn,
  attributes:[],arguments:'',constraint:name,constraint_relation:opposite,deferrable:fk.deferrable,deferred:fk.deferred,
  has_when:false,old_table:null,new_table:null,definition:null}};
}

export function deriveOrderSplit210ForeignKeyRoster({source210,sourceSchema}){
 assert.equal(typeof source210,'string');assert.equal(sha(source210),ORDER_SPLIT210_FK_SOURCE_SHA256,'literal frozen210 source required');
 assert.equal(typeof sourceSchema,'string');assert.equal(sha(sourceSchema),ORDER_SPLIT210_FK_SCHEMA_SHA256,'literal base schema source required');
 const primaryKeys={};for(const table of ['tenants','users']){
  const matches=[...sourceSchema.matchAll(new RegExp('^CREATE TABLE '+table+' \\(id uuid PRIMARY KEY,','gm'))];
  assert.equal(matches.length,1,'literal source primary key '+table);primaryKeys[table]=['id'];
 }
 const blocks=[...source210.matchAll(/^CREATE TABLE public\.(order_split210_[a-z0-9_]+)\(\n([\s\S]*?)^\);/gm)];
 assert.equal(blocks.length,6,'all six own source tables');assert.equal(new Set(blocks.map(b=>b[1])).size,6,'duplicate source table');
 assert.equal((source210.match(/^CREATE TABLE /gm)||[]).length,6,'all CREATE TABLE declarations accounted for');
 const names=[],foreignKeys=[],constraints=[],triggers=[];
 for(const [,table,body]of blocks){
  const fields=entries(body),localColumns=new Set(fields.filter(s=>/^[a-z][a-z0-9_]* /.test(s)).map(s=>s.split(' ')[0]));
  const declarations=fields.filter(s=>/\bREFERENCES\b|\bFOREIGN KEY\b/.test(s));
  for(const declaration of declarations){
   const fk=parseOrderSplit210ForeignKeyDeclaration({table,declaration,primaryKeys});assert(fk.columns.every(c=>localColumns.has(c)),'FK refers to absent local column');
   const name=orderSplit210ForeignKeyName(table,fk.columns,names);names.push(name);
   foreignKeys.push({...fk,name,constraint_key:`public.${table}.${name}`});
   constraints.push({kind:'constraint',key:`public.${table}.${name}`,value:{kind:'f',deferrable:fk.deferrable,deferred:fk.deferred,
    validated:true,local:true,inheritance_count:0,no_inherit:true,
    definition:{schema:'uncompiled-pg-foreign-key-definition/v1',semantic_ast:{...fk,name}}}});
   triggers.push(ri(fk,name,true,'INSERT'),ri(fk,name,true,'UPDATE'),ri(fk,name,false,'DELETE'),ri(fk,name,false,'UPDATE'));
  }
 }
 assert.equal(foreignKeys.length,18,'closed source18 FK roster');
 assert.equal((blocks.map(b=>b[2]).join('\n').match(/\bREFERENCES\b/g)||[]).length,18,'all source references accounted for');
 const own=new Set(blocks.map(b=>b[1]));
 for(const fk of foreignKeys){if(own.has(fk.referenced_table)){
  const target=blocks.find(b=>b[1]===fk.referenced_table),cols=new Set(entries(target[2]).filter(s=>/^[a-z][a-z0-9_]* /.test(s)).map(s=>s.split(' ')[0]));
  assert(fk.referenced_columns.every(c=>cols.has(c)),'FK references absent own column');
 }}
 assert.equal(new Set(constraints.map(identity)).size,constraints.length,'duplicate FK record');
 assert.equal(new Set(triggers.map(identity)).size,triggers.length,'duplicate RI record');
 const ownTriggers=triggers.filter(t=>own.has(t.key.split('.')[1])).length;
 return freeze({schema:'order-split210-authored-foreign-key-roster/v1',source_sha256:ORDER_SPLIT210_FK_SOURCE_SHA256,
  schema_source_sha256:ORDER_SPLIT210_FK_SCHEMA_SHA256,reader_context:{postgres_major:18,search_path:['pg_catalog','public'],max_identifier_bytes:63},
  foreign_keys:foreignKeys,constraints:sorted(constraints),ri_triggers:sorted(triggers),
  counts:{foreign_keys:foreignKeys.length,ri_triggers:triggers.length,own_ri_triggers:ownTriggers,external_ri_triggers:triggers.length-ownTriggers},
  unresolved_pg_fields:['constraint.definition'],namespace_precondition:{generated_fk_names_unoccupied:true,verified:false},
  compiled_catalogue_records:false,source_compilation_performed:false,native_certification:false,application_activation:false});
}

/** Exact authored semantic basis only. Actual FK deparser text requires future
 * compilation; do not feed this check a catalogue and call it certification. */
export function assertOrderSplit210ForeignKeyBasisRoster(records,sources){
 const expected=deriveOrderSplit210ForeignKeyRoster(sources);assert(Array.isArray(records),'basis array required');
 for(const r of records)assert(r&&(r.kind==='constraint'||r.kind==='trigger'),'explicit catalogue kind required');
 assert.equal(new Set(records.map(identity)).size,records.length,'duplicate FK/RI record');
 assert.deepEqual(canonical(sorted([...records])),canonical(sorted([...expected.constraints,...expected.ri_triggers])),'exact source-authored FK/RI basis required');
 return freeze({authored_basis_equal:true,compiled_catalogue_records:false,native_certification:false});
}
