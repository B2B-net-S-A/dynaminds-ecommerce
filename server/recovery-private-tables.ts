/** Owner-only same-snapshot checksums. Never return private payloads or protocol tokens. */
import assert from 'node:assert/strict';
import type pg from 'pg';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
const identifier=z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const appSchema=identifier.refine(n=>n!=='public'&&n!=='information_schema'&&!n.startsWith('pg_'));
const unsigned=z.string().regex(/^(0|[1-9][0-9]*)$/),signed=z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const row=z.strictObject({schema:appSchema,table:identifier,owner:z.enum(['postgres','dyna_app']),schema_owner:z.enum(['postgres','dyna_app']),count:unsigned,high:signed,low:signed});
export const privateTablesSnapshotSchema=z.array(row).max(20000).superRefine((rows,ctx)=>{
 const keys=rows.map(r=>r.schema+'.'+r.table);
 if(new Set(keys).size!==keys.length||keys.some((k,i)=>i>0&&keys[i-1]>=k))
  ctx.addIssue({code:'custom',message:'Nieprawidłowy zbiór prywatnych tabel kopii'});
});
export const PRIVATE_TABLES_SQL=`SELECT n.nspname AS "schema",c.relname AS "table",
 pg_get_userbyid(c.relowner) AS owner,pg_get_userbyid(n.nspowner) AS schema_owner
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname<>'public' AND n.nspname<>'information_schema'
 AND left(n.nspname,3)<>'pg_' AND c.relkind IN ('r','p') AND c.relpersistence IN ('p','u')
 ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`;
const SESSION_SQL="SELECT current_user AS role,session_user AS owner,current_setting('role') AS role_setting,current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation,pg_current_snapshot()::text AS snapshot";
export async function privateTableFingerprints(c:pg.Client){
 const session=async()=>{const rows=(await c.query(SESSION_SQL)).rows;assert(rows.length===1);const s=rows[0];assert(s.role==='postgres'&&s.owner==='postgres'&&s.role_setting==='none'&&s.readonly==='on'&&s.isolation==='repeatable read'&&typeof s.snapshot==='string'&&s.snapshot.length>0,'recovery-private-owner-same-RRRO-required');return s;};
 const first=await session();const found=(await c.query(PRIVATE_TABLES_SQL)).rows;
 assert(found.length<=20000,'recovery-private-table-count-bound');
 const definitions=found.map(r=>row.omit({count:true,high:true,low:true}).parse(r));
 const keys=definitions.map(r=>r.schema+'.'+r.table);assert(keys.every((k,i)=>i===0||keys[i-1]<k),'recovery-private-exact-table-membership');
 const result=[];
 for(const r of definitions){
  // Same commutative, fixed-size row aggregate as the established public check.
  // Qualified identifiers are strict ASCII names, never caller-supplied SQL.
  const fingerprint=(await c.query(`SELECT count(*)::text AS count,coalesce(sum(('x'||substr(md5(to_jsonb(t)::text),1,16))::bit(64)::bigint),0)::text AS high,coalesce(sum(('x'||substr(md5(to_jsonb(t)::text),17,16))::bit(64)::bigint),0)::text AS low FROM "${r.schema}"."${r.table}" t`)).rows;
  assert(fingerprint.length===1,'recovery-private-one-aggregate');result.push(row.parse({...r,...fingerprint[0]}));
 }
 assert(isDeepStrictEqual(await session(),first),'recovery-private-owner-snapshot-changed');
 return privateTablesSnapshotSchema.parse(result);
}
export async function verifyPrivateTableFingerprints(c:pg.Client,input:unknown){
 if(input===undefined)return null; // Historical authenticated archives retain their original scope.
 const expected=privateTablesSnapshotSchema.parse(input),actual=await privateTableFingerprints(c);
 assert(isDeepStrictEqual(actual,expected),'recovery-private-table-membership-or-row-fingerprint-mismatch');
 return{tables:actual.length,rows:actual.reduce((n,r)=>n+BigInt(r.count),0n).toString(),fingerprints_match:true as const,private_payloads_returned:false as const};
}
