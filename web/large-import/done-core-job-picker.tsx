/** Owned metadata list, explicit user reads only. Select ID then existing full inspect binds revision/pages before mapper. */
import React,{useLayoutEffect,useRef,useState} from 'react';
import {createDoneCoreJobListClient} from '../../shared/large-import-dependencies/pim-large-import-native-pim-driver-ui/list-client';
import type {Scope,FetchPort} from '../../shared/large-import-dependencies/pim-large-import-http-binding-ui/browser';
import type {DoneCoreJob,DoneCorePage} from '../../shared/large-import-dependencies/pim-large-import-native-pim-driver-ui/list-contract';
const key=(s:Scope)=>JSON.stringify([s.context.tenantId,s.context.userId,s.context.apiKeyId,s.catalogId]);
export function DoneCoreJobPicker(props:{scope:Scope;fetchPort?:FetchPort;onSelect:(job:DoneCoreJob)=>void}){
 const latest=useRef(props);latest.current=props;const client=useRef<ReturnType<typeof createDoneCoreJobListClient>|null>(null),generation=useRef(0);
 const [view,setView]=useState<{scope:string;page:DoneCorePage|null;busy:boolean;error:string}>({scope:key(props.scope),page:null,busy:false,error:''});const currentKey=key(props.scope);
 useLayoutEffect(()=>{const c=createDoneCoreJobListClient(()=>latest.current.scope,props.fetchPort);client.current=c;generation.current++;setView({scope:currentKey,page:null,busy:false,error:''});return()=>{generation.current++;c.destroy();if(client.current===c)client.current=null;};},[currentKey,props.scope.available,props.scope.canManage,props.fetchPort]);
 const visible=view.scope===currentKey&&props.scope.available&&props.scope.canManage?view:null;
 const load=async(cursor?:string)=>{const c=client.current,g=generation.current;if(!c||visible?.busy)return;setView(v=>({...v,scope:currentKey,busy:true,error:''}));try{const page=await c.list(20,cursor);if(client.current===c&&generation.current===g)setView({scope:currentKey,page,busy:false,error:''});}catch(e){if(client.current===c&&generation.current===g)setView({scope:currentKey,page:null,busy:false,error:e instanceof Error?e.message:'Nie można potwierdzić listy'});}};
 return <section aria-label="Zadania z zapisanymi produktami"><h3>Zadania z zapisanymi produktami</h3><p>Lista własnych zakończonych zapisów Core. Wybór wczyta pełne potwierdzenia przed mapowaniem parametrów.</p>
 <button disabled={!props.scope.available||!props.scope.canManage||visible?.busy} onClick={()=>void load()}>Odczytaj własne zadania</button>
 {visible?.error&&<p role="alert">{visible.error}</p>}{visible?.page&&<><ul>{visible.page.items.map(j=><li key={j.id}><button disabled={visible.busy} onClick={()=>{if(key(latest.current.scope)===currentKey&&latest.current.scope.available&&latest.current.scope.canManage)latest.current.onSelect(structuredClone(j));}}>Zadanie {j.id.slice(0,8)} · {j.records} produktów · {j.batches} partii</button><details><summary>Szczegóły zadania</summary><span>{j.id} · rewizja {j.revision} · {j.created_at}</span></details></li>)}</ul>{!visible.page.items.length&&<p>Brak własnych zakończonych zapisów Core w tym katalogu.</p>}{visible.page.next&&<button disabled={visible.busy} onClick={()=>void load(visible.page!.next!)}>Następna strona</button>}</>}
 </section>;
}
