/** SQL188 local_consumer_credit_preview inserts expires_at=clock_timestamp()+15 min while the
 * column default created_at=clock_timestamp() is evaluated first; its BEFORE INSERT guard then
 * refuses expires_at>created_at+15 min ('Fałszywy snapshot188', 23514) whenever the two clock
 * reads straddle a microsecond (~1% of inserts), and also when its re-derived frame differs.
 * Historical SQL188 stays literal (207 already uses one stamp), so the whole rolled-back preview
 * is retried once: the fresh attempt re-reads the source and still refuses a real RMA change. */
export function isPreview188GuardRace(error:unknown):boolean{
 return !!error&&typeof error==='object'&&(error as {code?:unknown}).code==='23514'&&
  (error as {message?:unknown}).message==='Fałszywy snapshot188';
}
export async function withPreview188GuardRetry<T>(attempt:()=>Promise<T>,rolledBack:(error:unknown)=>boolean):Promise<T>{
 try{return await attempt();}
 catch(error){if(!isPreview188GuardRace(error)||!rolledBack(error))throw error;}
 return attempt();
}
