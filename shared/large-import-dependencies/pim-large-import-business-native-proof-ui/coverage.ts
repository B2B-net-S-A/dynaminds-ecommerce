/** Source inventory is not a positive native proof. Only actual complete invocation/readback artifacts cover a hook. */
import assert from 'node:assert/strict';
import {OPERATIONS,type Operation} from '../pim-large-import-write-hook-registry-backend/inventory';
export type Artifact={path:string;sha256:string};
export type Invocation={operation:Operation;phase:'physical'|'business'|'negative';site:string;outcome:'settled'|'released';request_id:string;reservation_id:string;native:Artifact;readback:Artifact};
export function coverageMatrix(observed:readonly Invocation[]){
 const rows=structuredClone(observed),refs=(r:Artifact)=>assert(r&&r.path.startsWith('/')&&/^[a-f0-9]{64}$/.test(r.sha256),'coverage-real-saved-ref-shape');for(const x of rows){assert(Object.hasOwn(OPERATIONS,x.operation)&&typeof x.site==='string'&&x.site.length>0&&['physical','business','negative'].includes(x.phase)&&['settled','released'].includes(x.outcome));refs(x.native);refs(x.readback);}
 const coverage=Object.keys(OPERATIONS).map(operation=>({operation:operation as Operation,invocations:rows.filter(x=>x.operation===operation),status:rows.some(x=>x.operation===operation)?'OBSERVED_INVOCATION_REQUIRES_INDEPENDENT_SAVED_VERIFICATION':'OPEN_NOT_INVOKED'}));
 // Never mints a registry/native readiness token. Even all18 observed must be artifact-admitted independently.
 return{schema:'internal-business173-hook-observations/v1',coverage,all18_proof:'OPEN_INDEPENDENT_ARTIFACT_VERIFICATION_REQUIRED',public_application_ready:false,full_goal:'ACTIVE_OPEN'};
}
export const BUSINESS_SITES={
 'job-create':'storage.createIfAbsent actual INSERT/readback',
 'job-lease-claim':'storage.withLease actual owned token+fence claim/readback',
 'job-lease-release':'storage.withLease finally exact preallocated cleanup/readback',
 'job-checkpoint-event':'storage.lease.save same-client state+event transaction/readback',
 'review-append-bindings':'review-store.review.save exact native bindings+scope/readback',
 'private-witness-append':'createPrivateWitnessStore.save actual quota publication+readback',
 'fs-lock':'private witness publisher exact owned writer.lock',
} as const;
