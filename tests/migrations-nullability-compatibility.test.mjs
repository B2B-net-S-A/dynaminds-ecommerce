import assert from 'node:assert/strict';
import test from 'node:test';
import {projectMigrationsNullability} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migrations-nullability-compatibility.mjs';
const column={kind:'column',key:'public.migrations.applied_at',value:{acl:[],acl_null:true,collation:null,compression:'',default:'now()',foreign_options:null,generated:'',identity:'',not_null:true,options:null,position:2,statistics:null,storage:'p',type:'timestamp with time zone'}};
const constraint={kind:'constraint',key:'public.migrations.migrations_applied_at_not_null',value:{deferrable:false,deferred:false,definition:'NOT NULL applied_at',inheritance_count:0,kind:'n',local:true,no_inherit:false,validated:true}};
test('accepts exact historical nullable and stronger NOT NULL metadata without mutating either input',()=>{
 const legacy={...column,value:{...column.value,not_null:false}},unrelated={kind:'column',key:'public.other.id',value:{not_null:true}},source=[column,constraint,unrelated],before=structuredClone(source);
 const old=projectMigrationsNullability([legacy,unrelated]);assert.equal(old.removed_constraints,0);
 const next=projectMigrationsNullability(source);assert.equal(next.removed_constraints,1);assert.deepEqual(next.records,[legacy,unrelated]);assert.deepEqual(source,before);assert.strictEqual(next.records[1],unrelated);
});
test('refuses missing, duplicate, renamed or unpaired administrative metadata',()=>{
 for(const records of [[],[column],[column,column,constraint],[column,constraint,constraint],[column,{...constraint,key:'public.migrations.renamed'}],[{...column,value:{...column.value,not_null:false}},constraint]])assert.throws(()=>projectMigrationsNullability(records));
});
test('every changed column or constraint field remains visible and refuses projection',()=>{
 for(const [key,value]of [['default','clock_timestamp()'],['type','timestamp without time zone'],['position',3],['acl_null',false],['identity','a'],['statistics',10]])assert.throws(()=>projectMigrationsNullability([{...column,value:{...column.value,[key]:value}},constraint]));
 for(const [key,value]of [['deferrable',true],['deferred',true],['validated',false],['definition','NOT NULL another_column'],['inheritance_count',1],['local',false],['no_inherit',true]])assert.throws(()=>projectMigrationsNullability([column,{...constraint,value:{...constraint.value,[key]:value}}]));
});
