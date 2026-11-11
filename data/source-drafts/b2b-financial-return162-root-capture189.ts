/** SOURCE_ONLY_NOT_RUN. Import-safe read-only capturer. Body copied literally
 * from frozen runner3; no app, test runner, connection or query at import time. */
import assert from 'node:assert/strict';
import pg from 'pg';
type Row=Record<string,any>;
const one=(xs:Row[])=>{assert.equal(xs.length,1);return xs[0];};
export const guardNames=['catalog_stock_control_guards','catalog_stock_return_guards','catalog_stock_count_guards','catalog_stock_legacy_group_guards','stocktake_adjustment_guards','warehouse_automatic_wz_guards','warehouse_wz_issuer_guards','allegro_oauth_recovery_guards','product_rule_price_tags_guards','product_rule_schedule_guards','packed_label_print_guards','label_print_guards','print_job_guards','local_invoice_guards','fa3_draft_guards','b2b_invoice_guards','b2b_credit_guards','credit_source_upgrade_valid','financial_return_guards'] as const;
export async function captureDatabase(c:pg.Client,require552=false){
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{await c.query("SET LOCAL TimeZone='UTC'");
  const graph=await(await import('../../scripts/stocktake-adjustments-native164-preservation')).captureStocktakeAdjustmentPreservation(c);
  const present=(await c.query("SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND pronargs=0 AND proname=ANY($1::text[]) ORDER BY proname",[[...guardNames,'financial_return_upgrade_valid']])).rows.map(r=>r.proname as string);
  const guards=present.length?one((await c.query('SELECT '+present.map(n=>'public.'+n+'() '+n).join(','))).rows):{};
  if(require552){assert.equal(Object.keys(graph.rows).length,552);assert.equal(graph.rows.migrations.length,162);assert.equal(graph.rows.credit_source_upgrade_certificate.length,1);assert.equal(graph.rows.financial_return_upgrade_certificate.length,1);assert.equal(graph.rows.financial_return_upgrade_certificate[0].row.profile,'161-original-to162-financial-return/v1');assert.deepEqual(present.sort(),[...guardNames,'financial_return_upgrade_valid'].sort());assert(Object.values(guards).every(v=>v===true));assert.equal(graph.rows.financial_return_receipts.length,2);assert.equal(graph.rows.financial_return_admissions.length,2);}
  const primary_keys=(await c.query("SELECT t.relname,array_agg(a.attname::text ORDER BY k.ordinality) fields FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_index i ON i.indrelid=t.oid AND i.indisprimary CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_attribute a ON(a.attrelid,a.attnum)=(t.oid,k.attnum) WHERE n.nspname='public' GROUP BY t.relname ORDER BY t.relname")).rows;assert.deepEqual(primary_keys.map(r=>r.relname).sort(),Object.keys(graph.rows).sort());
  const sequences:Row[]=[];for(const{sequencename}of(await c.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY 1")).rows){assert(/^[a-z][a-z0-9_]*$/.test(sequencename));sequences.push({name:sequencename,...one((await c.query('SELECT last_value::text,is_called FROM public."'+sequencename+'"')).rows),options:one((await c.query('SELECT seqtypid,seqstart::text,seqincrement::text,seqmax::text,seqmin::text,seqcache::text,seqcycle FROM pg_sequence WHERE seqrelid=$1::regclass',['public.'+sequencename])).rows)});}
  const views=(await c.query("SELECT viewname,definition FROM pg_views WHERE schemaname='public' ORDER BY viewname")).rows;await c.query('COMMIT');return{graph,guards,primary_keys,sequences,views};
 }catch(e){await c.query('ROLLBACK');throw e;}
}
