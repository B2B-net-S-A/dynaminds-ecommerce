import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool } from '../server/db';
import { returnAssistantFixture } from './return-assistant-fixture';
import { withoutApiKeyLastUse } from './api-key-last-use';
/** Reuse the real test commerce/RMA fixture, no parallel seed or fixture-side core writes. */
export async function returnAssistantQueueFixture(app:FastifyInstance){
 const f=await returnAssistantFixture(app);
 const expensive=f.order.items.find((i:any)=>i.line_total===3401);assert(expensive);
 const rma2=await f.ok('/orders/'+f.order.id+'/returns','POST',{client_key:randomUUID(),reason:'Own second selected commercial return',shipping_refund:0,items:[{item_id:expensive.id,quantity:2}]},201);
 return {...f,rmas:[f.rma,rma2],return_ids:[f.rma.id,rma2.id]};
}
export const queueModuleTables=new Set(['return_assistant_settings','return_assistant_queues','return_assistant_queue_items','return_assistant_queue_operations','return_assistant_queue_admissions']);
/** Every own business table: statements use one UTC repeatable-read snapshot. */
export async function returnAssistantQueueFacts(tenant:string){
 const c=await pool.connect();try{
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");
 const names=(await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id') ORDER BY 1")).rows;
 const facts:Record<string,any[]>={};for(const {table_name}of names){assert.match(table_name,/^[a-z][a-z0-9_]*$/);facts[table_name]=(await c.query(`SELECT to_jsonb(x) row FROM "${table_name}" x WHERE tenant_id=$1 ORDER BY 1`,[tenant])).rows;}
 await c.query('COMMIT');return withoutApiKeyLastUse(facts);
 }finally{await c.query('ROLLBACK').catch(()=>undefined);c.release();}
}
export function returnAssistantQueueBusiness(facts:Record<string,any[]>){return Object.fromEntries(Object.entries(facts).filter(([name])=>!queueModuleTables.has(name)&&name!=='audit_events'));}
