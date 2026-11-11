import type {PoolClient} from 'pg';
import {ensure} from './errors';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const cursorPattern=/^(stock|email):([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const rowKeys=['type','run_id','job_id','created_at','outcome','parent_acknowledged','reconciliation_required','effect_plan_id','effect_job_id','message_id','batch_id'];
// Same conservative predicate as the complete warning in automation-local-effects.
// No recent-run limit, current activation or source-version restriction belongs here.
const stockUnknown=`j.state<>'pending'
    AND (p.state='done' AND p.phase='done' AND q.state='done' AND p.result->'desired_applied'='true'::jsonb
     AND CASE WHEN jsonb_typeof(p.payload->'stock_quantity')='number'
      THEN (p.payload->>'stock_quantity')::numeric BETWEEN 0 AND 9007199254740991
       AND trunc((p.payload->>'stock_quantity')::numeric)=(p.payload->>'stock_quantity')::numeric ELSE false END) IS DISTINCT FROM true`;

function parseQuery(input:unknown){
 ensure(input!==null&&typeof input==='object'&&!Array.isArray(input),422,'Niepoprawny kursor uzgodnienia');
 ensure([null,Object.prototype].includes(Object.getPrototypeOf(input)),422,'Niepoprawny kursor uzgodnienia');
 const descriptors=Object.getOwnPropertyDescriptors(input),fields=Reflect.ownKeys(descriptors);ensure(fields.length<=1&&fields.every(k=>k==='reconciliation_after'),422,'Niepoprawny kursor uzgodnienia');
 const field=descriptors.reconciliation_after;ensure(!field||field.enumerable&&Object.hasOwn(field,'value'),422,'Niepoprawny kursor uzgodnienia');const value=field?.value;
 if(value===undefined){ensure(fields.length===0,422,'Niepoprawny kursor uzgodnienia');return null;}
 ensure(typeof value==='string',422,'Niepoprawny kursor uzgodnienia');const match=cursorPattern.exec(value);
 ensure(match,422,'Niepoprawny kursor uzgodnienia');return{rank:match[1]==='stock'?0:1,id:match[2]!};
}

/** Called only after the existing route's current-admin/own-rule authorization.
 * The anchor is resolved inside this one SQL statement. Its actual timestamptz
 * stays in PostgreSQL, including microseconds and even after an effect resolves.
 * No claims, repairs, remote read, retry or authority are created by this page. */
export async function readUnresolvedAutomaticEffects(c:PoolClient,tenant:string,ruleId:string,input:unknown={}){
 const cursor=parseQuery(input);
 const row=(await c.query(`WITH stock_rows AS NOT MATERIALIZED (
  SELECT j.id AS page_id,0 AS type_rank,j.created_at,'sync_local_woo_stock'::text AS type,r.id AS run_id,j.id AS job_id,
   CASE WHEN j.state='failed' AND (coalesce(j.payload->>'effect_job_id','')='' OR p.phase='ready' AND p.state IN('failed','conflict') AND q.state='failed') THEN 'FAILED_BEFORE_DISPATCH'
    WHEN coalesce(j.payload->>'effect_job_id','')='' OR p.phase='ready' AND p.state IN('failed','conflict') AND q.state='failed' THEN 'ATTEMPTED_RECONCILIATION_REQUIRED'
    ELSE 'UNKNOWN_WRITE_OR_ACK' END AS outcome,
   j.state='done' AS parent_acknowledged,(${stockUnknown}) AS unresolved,
   p.id AS effect_plan_id,q.id AS effect_job_id,NULL::uuid AS message_id,NULL::uuid AS batch_id
  FROM automation_runs r JOIN jobs j ON j.tenant_id=r.tenant_id AND j.payload->>'run_id'=r.id::text
   LEFT JOIN offer_plans p ON(p.tenant_id,p.id)=(j.tenant_id,(j.payload->>'effect_plan_id')::uuid)
    AND p.job_id::text=j.payload->>'effect_job_id' AND p.actor_id::text=j.payload->>'owner_id'
    AND p.channel_id::text=j.payload->'action'->>'channel_id' AND p.listing_id::text=j.payload->>'listing_id'
    AND p.product_id::text=j.payload->>'product_id' AND p.operation='sync' AND p.input->>'stock'='true' AND p.input->>'price'='false'
   LEFT JOIN jobs q ON(q.tenant_id,q.id)=(p.tenant_id,p.job_id)
  WHERE r.tenant_id=$1 AND r.rule_id=$2 AND j.kind='automation.local_stock'
 ),email_rows AS NOT MATERIALIZED (
  SELECT m.id AS page_id,1 AS type_rank,m.created_at,'email'::text AS type,r.id AS run_id,j.id AS job_id,
   CASE WHEN m.state='smtp_accepted' THEN 'SMTP_ACCEPTED_NOT_DELIVERED' WHEN m.state='uncertain' THEN 'UNKNOWN_WRITE_OR_ACK'
    WHEN m.state='failed' THEN 'FAILED_BEFORE_DISPATCH' ELSE 'ATTEMPTED_RECONCILIATION_REQUIRED' END AS outcome,
   coalesce(j.state='done',false) AS parent_acknowledged,(m.state='uncertain' OR j.state='running') IS TRUE AS unresolved,
   NULL::uuid AS effect_plan_id,NULL::uuid AS effect_job_id,m.id AS message_id,b.id AS batch_id
  FROM automation_runs r JOIN email_batches b ON(b.tenant_id,b.automation_run_id)=(r.tenant_id,r.id)
   JOIN email_messages m ON(m.tenant_id,m.batch_id)=(b.tenant_id,b.id)
   LEFT JOIN jobs j ON(j.tenant_id,j.id)=(m.tenant_id,m.job_id)
  WHERE r.tenant_id=$1 AND r.rule_id=$2
 ),own_effects AS NOT MATERIALIZED (SELECT * FROM stock_rows UNION ALL SELECT * FROM email_rows),
 anchor AS MATERIALIZED (SELECT created_at,type_rank,page_id FROM own_effects WHERE type_rank=$3::int AND page_id=$4::uuid),
 page AS (
  SELECT e.* FROM own_effects e WHERE e.unresolved AND ($4::uuid IS NULL OR EXISTS(
   SELECT 1 FROM anchor a WHERE e.created_at<a.created_at OR e.created_at=a.created_at AND
    (e.type_rank>a.type_rank OR e.type_rank=a.type_rank AND e.page_id<a.page_id)))
  ORDER BY e.created_at DESC,e.type_rank ASC,e.page_id DESC LIMIT 26
 ) SELECT (SELECT count(*)::int FROM anchor) AS anchor_count,
  coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at DESC,p.type_rank ASC,p.page_id DESC) FROM page p),'[]'::jsonb) AS data`,[tenant,ruleId,cursor?.rank??null,cursor?.id??null])).rows[0];
 ensure(row&&Number.isInteger(row.anchor_count)&&Array.isArray(row.data)&&row.data.length<=26,503,'Niepotwierdzona historia uzgodnienia');
 ensure(cursor?row.anchor_count===1:row.anchor_count===0,422,'Kursor nie wskazuje skutku własnej reguły');
 const seen=new Set<string>();
 const safeRows=row.data.map((value:any)=>{
  ensure(value&&uuid.test(value.page_id)&&uuid.test(value.run_id)&&value.unresolved===true&&typeof value.parent_acknowledged==='boolean',503,'Niepotwierdzony skutek reguły');
  const stock=value.type==='sync_local_woo_stock';ensure(stock||value.type==='email',503,'Niepotwierdzony rodzaj skutku');
  const identity=(stock?'stock:':'email:')+value.page_id;ensure(!seen.has(identity),503,'Powtórzony skutek reguły');seen.add(identity);
  ensure(value.type_rank===(stock?0:1)&&(!stock||value.job_id===value.page_id)&&
   (stock?value.message_id===null&&value.batch_id===null:value.message_id===value.page_id&&uuid.test(value.batch_id)),503,'Niepotwierdzony zakres skutku');
  for(const key of ['job_id','effect_plan_id','effect_job_id'])ensure(value[key]===null||typeof value[key]==='string'&&uuid.test(value[key]),503,'Niepotwierdzony identyfikator skutku');
  ensure(stock||value.effect_plan_id===null&&value.effect_job_id===null,503,'Niepotwierdzony zakres email');
  ensure((stock?['FAILED_BEFORE_DISPATCH','ATTEMPTED_RECONCILIATION_REQUIRED','UNKNOWN_WRITE_OR_ACK']:['SMTP_ACCEPTED_NOT_DELIVERED','FAILED_BEFORE_DISPATCH','ATTEMPTED_RECONCILIATION_REQUIRED','UNKNOWN_WRITE_OR_ACK']).includes(value.outcome),503,'Niepotwierdzony stan skutku');
  ensure(typeof value.created_at==='string'&&Number.isFinite(Date.parse(value.created_at)),503,'Niepotwierdzony czas skutku');
  const safe=Object.fromEntries(rowKeys.map(key=>[key,value[key]]));safe.created_at=new Date(value.created_at).toISOString();safe.reconciliation_required=true;
  return safe;
 });
 const data=safeRows.slice(0,25),last=row.data[Math.min(row.data.length,25)-1],hasMore=row.data.length>25;
 return{scope:'ALL_OWN_RULE_RUNS' as const,data,has_more:hasMore,next_cursor:hasMore?`${last.type_rank===0?'stock':'email'}:${last.page_id}`:null};
}
