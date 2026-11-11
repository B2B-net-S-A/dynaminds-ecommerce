/** Exact independently compiled262 inverse. 262 changes only pg_database.datacl (TEMPORARY revoked from PUBLIC, granted to the database owner); the cold catalogue reads relation, function and default ACLs but not the database ACL, and the compiled delta is empty (0 additions, 0 changes, 0 removals; after262 = after261), so the inverse is the identity. The catalogue cannot show whether 262 ran: its activity is that of the complete261 catalogue (every 261 addition and changed body present), which keeps the marker parity of the cold inspection on every database this release migrated (migrate() applies 261 and 262 together) and refuses, through that parity, a database at 261 without the 262 ledger row. The database ACL itself is checked at start (server/database-temp-privilege.ts). Metadata only; no installation or business authority. */
import assert from 'node:assert/strict';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
import {canonical212,freeze212} from './local-woo-read212-source-contract.mjs';
import {REVOKE_PUBLIC_TEMPORARY262_SOURCE_CONTRACT as E} from './revoke-public-temporary262-source-contract.mjs';
import {STOCKTAKE_EVIDENCE_USAGE261_SOURCE_CONTRACT as E261} from './stocktake-evidence-usage261-source-contract.mjs';
const identity=r=>r.kind+'\0'+r.key;
const same=(a,b)=>JSON.stringify(canonical212(a))===JSON.stringify(canonical212(b));
assert.deepEqual([E.additions.length,E.changes.length,E.removed.length],[0,0,0],'262 has no catalogue record');
export function projectCompiledRevokePublicTemporary262Catalogue(input){
 assert.equal(arguments.length,1);
 const original=validateRecoverySchema(input),rows=new Map(original.records.map(r=>[identity(r),r]));
 const active=E261.additions.every(r=>rows.has(identity(r))&&same(rows.get(identity(r)),r))&&E261.changes.every(c=>rows.has(identity(c.after))&&same(rows.get(identity(c.after)),c.after));
 return freeze212({catalogue:original,active,removed_records:0,changed_records:0,mode:active?'SOURCE_COMPILED_EXACT262_TO261_IDENTITY':'SOURCE262_ABSENT_PREDECESSOR_IDENTITY',source_compilation_proven:true,native_certification:false,application_activation:false,business_acceptance:false,authority:false});
}
