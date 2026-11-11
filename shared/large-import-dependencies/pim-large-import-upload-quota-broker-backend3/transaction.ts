import {runBoundDurableMetadataTransaction187} from '../../../server/large-import/durable-original-epoch';
import type {Client} from '../pim-large-import173-composed-runtime-backend/storage';
const active=new WeakSet<Client>();
/** Dedicated quota clients only: never share this c with metadata/sidecar. Explicit isolation does not inherit a session's RR default. */
export async function quotaTransaction<T>(c:Client,work:()=>Promise<T>,cleanupFailure:(error:unknown)=>void=()=>{}):Promise<T>{const durable=runBoundDurableMetadataTransaction187(c,work,cleanupFailure);if(durable)return durable;
 if(active.has(c))throw Error('quota-overlapping-transaction');active.add(c);let failed=false,first:unknown,value:T|undefined;
 try{await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');value=await work();await c.query('COMMIT');}
 catch(e){failed=true;first=e;try{await c.query('ROLLBACK');}catch(e){try{cleanupFailure(e);}catch{}}}
 finally{active.delete(c);}if(failed)throw first;return value as T;
}
