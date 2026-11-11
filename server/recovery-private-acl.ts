/** Authenticated private schema/relation ACL representation, never importer authority. */
import assert from 'node:assert/strict';
import type pg from 'pg';
import {isDeepStrictEqual as equal} from 'node:util';
import {z} from 'zod';
const identifier=z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const schema=identifier.refine(n=>n!=='public'&&n!=='information_schema'&&!n.startsWith('pg_'));
const record=z.strictObject({type:z.enum(['schema','relation']),schema,name:identifier.nullable(),relation_kind:z.enum(['r','p','v','m','S']).nullable(),owner:z.enum(['postgres','dyna_app']),explicit:z.boolean(),rls:z.boolean(),force_rls:z.boolean(),acl:z.array(z.string().min(1).max(1024)).max(1024)}).superRefine((r,c)=>{if(r.type==='schema'?(r.name!==null||r.relation_kind!==null||r.rls||r.force_rls):(r.name===null||r.relation_kind===null))c.addIssue({code:'custom',message:'Nieprawidłowy obiekt prywatnego ACL'});});
const key=(r:{schema:string;name:string|null})=>r.schema+'\0'+(r.name??'');
export const privateAclSnapshotSchema=z.array(record).max(20000).superRefine((rs,c)=>{if(rs.some((r,i)=>i>0&&key(rs[i-1])>=key(r)))c.addIssue({code:'custom',message:'Nieprawidłowy zbiór prywatnych ACL'});});
type Snapshot=z.infer<typeof privateAclSnapshotSchema>;
const SESSION_SQL="SELECT current_user AS role,session_user AS owner,current_setting('role') AS role_setting,current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation,pg_current_snapshot()::text AS snapshot";
export const PRIVATE_ACL_SQL=`WITH objects AS (
 SELECT 'schema'::text AS type,n.nspname::text AS "schema",NULL::text AS name,NULL::text AS relation_kind,n.nspowner AS owner_id,n.nspacl AS physical_acl,false AS rls,false AS force_rls,acldefault('n'::"char",n.nspowner) AS default_acl
 FROM pg_namespace n WHERE n.nspname<>'public' AND n.nspname<>'information_schema' AND left(n.nspname,3)<>'pg_'
 UNION ALL
 SELECT 'relation',n.nspname,c.relname,c.relkind::text,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>'public' AND n.nspname<>'information_schema' AND left(n.nspname,3)<>'pg_' AND c.relkind IN ('r','p','v','m','S') AND c.relpersistence IN ('p','u')
) SELECT type,"schema",name,relation_kind,pg_get_userbyid(owner_id) AS owner,physical_acl IS NOT NULL AS explicit,rls,force_rls,
 ARRAY(SELECT a::text FROM unnest(coalesce(physical_acl,default_acl)) a ORDER BY a::text) AS acl,
 ARRAY(SELECT a::text FROM unnest(default_acl) a ORDER BY a::text) AS default_acl,
 NOT EXISTS(SELECT FROM aclexplode(default_acl) a WHERE a.grantee<>owner_id OR a.grantor<>owner_id OR a.is_grantable) AS default_owner_only
 FROM objects ORDER BY "schema" COLLATE "C",name COLLATE "C" NULLS FIRST`;
async function observe(c:pg.Client,readonly:'on'|'off'){
 const session=async()=>{const rs=(await c.query(SESSION_SQL)).rows;assert(rs.length===1);const s=rs[0];assert(s.role==='postgres'&&s.owner==='postgres'&&s.role_setting==='none'&&s.readonly===readonly&&s.isolation==='repeatable read'&&typeof s.snapshot==='string'&&s.snapshot.length>0,'recovery-private-ACL-owner-snapshot');return s;};
 const opening=await session(),rows=(await c.query(PRIVATE_ACL_SQL)).rows;assert(rows.length<=20000);const auxiliary=new Map<string,{default_acl:string[];default_owner_only:boolean}>();const snapshot=privateAclSnapshotSchema.parse(rows.map(({default_acl,default_owner_only,...r})=>{assert(Array.isArray(default_acl)&&default_acl.every(a=>typeof a==='string')&&typeof default_owner_only==='boolean');const parsed=record.parse(r);auxiliary.set(key(parsed),{default_acl,default_owner_only});return parsed;}));assert(equal(await session(),opening),'recovery-private-ACL-snapshot-changed');return{snapshot,auxiliary};
}
export async function capturePrivateAclSnapshot(c:pg.Client):Promise<Snapshot>{return(await observe(c,'on')).snapshot;}
const quoted=(s:string)=>'"'+s.replaceAll('"','""')+'"';
/** Caller owns an isolated restore RRW transaction before event triggers return. */
export async function restorePrivateAclSnapshot(c:pg.Client,input:unknown){
 if(input===undefined)return null;
 const expected=privateAclSnapshotSchema.parse(input),database=(await c.query('SELECT current_database() AS name')).rows[0]?.name;assert(/^dynaminds_restore_[a-f0-9]{16}$/.test(database??''),'recovery-private-ACL-isolated-restore-only');
 const current=await observe(c,'off'),found=new Map(current.snapshot.map(r=>[key(r),r]));assert.equal(found.size,expected.length,'recovery-private-ACL-membership');const materialize:Snapshot=[];
 // Validate ALL objects and effective privileges before the first GRANT.
 for(const r of expected){const actual=found.get(key(r)),defaults=current.auxiliary.get(key(r));assert(actual&&defaults);assert(equal({...actual,explicit:r.explicit},r),'recovery-private-ACL-effective-owner-RLS-drift');if(actual.explicit===r.explicit)continue;assert(r.explicit&&!actual.explicit&&r.owner==='postgres'&&defaults.default_owner_only&&equal(r.acl,defaults.default_acl),'recovery-private-ACL-owner-default-only');materialize.push(r);}
 for(const r of materialize){if(r.type==='schema')await c.query(`GRANT ALL ON SCHEMA ${quoted(r.schema)} TO postgres`);else await c.query(`GRANT ALL PRIVILEGES ON ${r.relation_kind==='S'?'SEQUENCE':'TABLE'} ${quoted(r.schema)}.${quoted(r.name!)} TO postgres`);}
 assert(equal((await observe(c,'off')).snapshot,expected),'recovery-private-ACL-final-representation-drift');return{schemas:materialize.filter(r=>r.type==='schema').length,relations:materialize.filter(r=>r.type==='relation').length};
}
export async function verifyPrivateAclSnapshot(c:pg.Client,input:unknown){if(input===undefined)return null;const expected=privateAclSnapshotSchema.parse(input),actual=await capturePrivateAclSnapshot(c);assert(equal(actual,expected),'recovery-private-ACL-RRRO-preservation-mismatch');return{schemas:actual.filter(r=>r.type==='schema').length,relations:actual.filter(r=>r.type==='relation').length,representation_and_effective_grants_match:true as const,restored_importer_authority:false as const};}
