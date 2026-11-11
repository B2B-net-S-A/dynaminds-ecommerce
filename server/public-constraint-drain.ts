/** Import-safe trusted catalog drain. Run after all public effects exist and
 * before the cooperative no-wait clock tail. Private temporary commit markers
 * retain their DEFERRED mode. No pool borrowing, actor input or table mutation. */
import type {Client,PoolClient} from 'pg';
export type ConstraintReader=Pick<Client|PoolClient,'query'>;
const catalogSql=`SELECT DISTINCT ns.nspname::text AS schema_name,con.conname::text AS constraint_name
 FROM pg_catalog.pg_constraint con
 JOIN pg_catalog.pg_namespace ns ON ns.oid=con.connamespace
 WHERE ns.nspname='public' AND con.condeferrable
 ORDER BY schema_name,constraint_name`;
const quoteIdentifier=(name:string)=>'"'+name.replaceAll('"','""')+'"';
export async function drainPublicConstraintsInTx(c:ConstraintReader):Promise<number>{
 const {rows}=await c.query(catalogSql);
 const names=new Set<string>();
 for(const row of rows){
  // This input is PostgreSQL metadata, never a request-supplied constraint list.
  if(row.schema_name!=='public'||typeof row.constraint_name!=='string'||row.constraint_name.length===0||row.constraint_name.includes('\0'))throw new Error('Unexpected public constraint catalog row');
  names.add(quoteIdentifier(row.schema_name)+'.'+quoteIdentifier(row.constraint_name));
 }
 const constraints=[...names].sort();
 if(constraints.length)await c.query('SET CONSTRAINTS '+constraints.join(',')+' IMMEDIATE');
 return constraints.length;
}
