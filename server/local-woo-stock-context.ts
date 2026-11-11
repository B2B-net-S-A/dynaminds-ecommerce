/** Optional construction-owned ports; ordinary provider paths have no callback. */
import type {PoolClient} from 'pg';
import type {IntegrationContext} from './channel-access';
export type LocalWooStockContext = IntegrationContext & {
  localWooStockFence?: (c:PoolClient,job:any)=>Promise<void>;
  localWooStockQueued?: (c:PoolClient,parent:any,queued:{id:string;job_id:string;state:string})=>Promise<void>;
};
