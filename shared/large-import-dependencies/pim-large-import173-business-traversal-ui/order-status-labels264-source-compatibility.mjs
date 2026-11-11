/** Exact independently compiled264 inverse. 264 is data only (cash-on-delivery and trade-credit orders in new move to paid); the compiled delta is empty (0 additions, 0 changes, 0 removals; after264 = after263), so the inverse is the identity. The catalogue cannot show whether 264 ran: its activity is that of the complete263 catalogue (every 263 addition and changed body present), which keeps the marker parity of the cold inspection on every database this release migrated (migrate() applies 263 and 264 together) and refuses, through that parity, a database at 263 without the 264 ledger row. Metadata only; no installation or business authority. */
import assert from 'node:assert/strict';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
import {canonical212,freeze212} from './local-woo-read212-source-contract.mjs';
import {ORDER_STATUS_LABELS264_SOURCE_CONTRACT as E} from './order-status-labels264-source-contract.mjs';
import {MANUAL_OFF_VERDICT263_SOURCE_CONTRACT as E263} from './manual-off-verdict263-source-contract.mjs';
const identity=r=>r.kind+'\0'+r.key;
const same=(a,b)=>JSON.stringify(canonical212(a))===JSON.stringify(canonical212(b));
assert.deepEqual([E.additions.length,E.changes.length,E.removed.length],[0,0,0],'264 has no catalogue record');
export function projectCompiledOrderStatusLabels264Catalogue(input){
 assert.equal(arguments.length,1);
 const original=validateRecoverySchema(input),rows=new Map(original.records.map(r=>[identity(r),r]));
 const active=E263.additions.every(r=>rows.has(identity(r))&&same(rows.get(identity(r)),r))&&E263.changes.every(c=>rows.has(identity(c.after))&&same(rows.get(identity(c.after)),c.after));
 return freeze212({catalogue:original,active,removed_records:0,changed_records:0,mode:active?'SOURCE_COMPILED_EXACT264_TO263_IDENTITY':'SOURCE264_ABSENT_PREDECESSOR_IDENTITY',source_compilation_proven:true,native_certification:false,application_activation:false,business_acceptance:false,authority:false});
}
