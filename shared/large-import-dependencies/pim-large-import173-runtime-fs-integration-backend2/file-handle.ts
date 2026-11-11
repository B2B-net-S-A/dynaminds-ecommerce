/** Retain exact first failure, including falsy throws; close is always attempted once. */
export async function withOwnedFileHandle<T>(handle:{close():Promise<void>},work:()=>Promise<T>,report:(error:unknown)=>void=()=>{}):Promise<T>{
 let failed=false,first:unknown,value:T|undefined;
 try{value=await work();}catch(error){failed=true;first=error;}
 try{await handle.close();}catch(error){try{report(error);}catch{}if(!failed){failed=true;first=error;}}
 if(failed)throw first;return value as T;
}
