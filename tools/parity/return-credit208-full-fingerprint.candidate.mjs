/** Temporary next-candidate derivation. Does not rewrite frozen SQL208. */
import assert from 'node:assert/strict';
export function deriveFull208Fingerprint(scoped207Records){
 const before="'return_credit206_'",array="'_return_credit206_'";
 assert.equal(scoped207Records.split(before).length,4);assert.equal(scoped207Records.split(array).length,2);
 const query=scoped207Records.replaceAll(before,"'return_credit208_'").replaceAll(array,"'_return_credit208_'");
 assert(!query.includes('return_credit206_'));
 return "SELECT encode(sha256(convert_to(coalesce(jsonb_agg(record ORDER BY record->>'kind',record->>'key' COLLATE \"C\"),'[]'::jsonb)::text,'UTF8')),'hex') FROM(\n"+query+"\n) namespace208";
}
