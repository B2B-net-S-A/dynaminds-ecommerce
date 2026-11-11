import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {fulfilmentLabel} from './order-stage';
type Props={tenantId:string;userId:string;admin:boolean;readOnly:boolean;externalWriteBlocked:boolean;refresh:number;onOpenOrder?:(id:string)=>void};
type Attempt={v:1;context:string;orderId:string;requestId:string;phase:'prepare-sent'|'prepared'|'dispatch-sent'|'unknown'|'confirmed';lastSent:'prepare'|'dispatch';ruleId?:string;workflowId?:string;eventId?:string;runId?:string;jobIds?:string[]};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const key=(ctx:string)=>'dyna:local-automation:v1:'+ctx;
function load(ctx:string):Attempt|null{const raw=sessionStorage.getItem(key(ctx));if(!raw)return null;const a=JSON.parse(raw);if(a.v!==1||a.context!==ctx||![a.orderId,a.requestId].every(uuid)||!['prepare-sent','prepared','dispatch-sent','unknown','confirmed'].includes(a.phase)||!['prepare','dispatch'].includes(a.lastSent))throw Error('Niepełny zapis próby; nie ponawiaj.');return a;}
function save(a:Attempt){sessionStorage.setItem(key(a.context),JSON.stringify(a));}
type ArchivedAttempt={v:1;context:string;archivedAt:string;attempt:Attempt;activeBytes:string;readback:any};
const archivePrefix=(ctx:string)=>key(ctx)+':archive:';
function confirmedReceipt(a:Attempt,next:Attempt,v:any){return v.confirmed_receipt_verified===true&&uuid(v.finished_audit_id)&&v.expected_note==='Lokalna automatyzacja DEMO '+a.requestId&&v.order?.note===v.expected_note&&v.order?.id===a.orderId&&v.rule?.id===next.ruleId&&v.rule.enabled===false&&v.runs?.length===1&&v.runs[0].state==='done'&&v.run_id===v.runs[0].id&&v.event_id===v.runs[0].event_id&&v.runs[0].job_id===v.jobs?.find((j:any)=>j.kind==='automation.run')?.id&&v.jobs?.find((j:any)=>j.kind==='automation')?.event_id===v.event_id&&v.jobs?.length===2&&v.jobs.every((j:any)=>j.state==='done'&&Number(j.attempts)===1&&Number(j.max_attempts)===1&&j.lease_released===true&&j.lock_released===true)&&v.order?.status==='paid'&&v.order.workflow_status_id===next.workflowId;}
function loadArchives(ctx:string):ArchivedAttempt[]{
  const records:ArchivedAttempt[]=[];
  for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i);if(!k?.startsWith(archivePrefix(ctx)))continue;
    const raw=sessionStorage.getItem(k);if(!raw)throw Error('Niepełne archiwum próby; zachowano aktywną próbę.');const r=JSON.parse(raw);
    if(r.v!==1||r.context!==ctx||r.attempt?.context!==ctx||r.attempt?.phase!=='confirmed'||r.attempt?.lastSent!=='dispatch'||r.attempt?.v!==1||![r.attempt?.requestId,r.attempt?.orderId,r.attempt?.ruleId,r.attempt?.workflowId,r.attempt?.eventId,r.attempt?.runId].every(uuid)||!Array.isArray(r.attempt.jobIds)||r.attempt.jobIds.length!==2||!r.attempt.jobIds.every(uuid)||new Set(r.attempt.jobIds).size!==2||r.readback?.scope!=='local_demo'||r.readback?.request_id!==r.attempt.requestId||r.readback?.order_id!==r.attempt.orderId||r.readback?.event_id!==r.attempt.eventId||r.readback?.run_id!==r.attempt.runId||!Array.isArray(r.readback?.jobs)||r.readback.jobs.length!==2||r.readback.jobs.some((j:any)=>!r.attempt.jobIds.includes(j.id))||k!==archivePrefix(ctx)+r.attempt.requestId||typeof r.activeBytes!=='string'||JSON.stringify(JSON.parse(r.activeBytes))!==JSON.stringify(r.attempt)||typeof r.archivedAt!=='string'||!Number.isFinite(Date.parse(r.archivedAt))||!confirmedReceipt(r.attempt,r.attempt,r.readback))throw Error('Nie można potwierdzić archiwum; nie usunięto jego danych.');
    records.push(r);
  }
  return records.sort((a,b)=>b.archivedAt.localeCompare(a.archivedAt));
}
export function LocalAutomationDemo(p:Props){
  const context=p.tenantId+':'+p.userId;
  const [orderId,setOrderId]=useState(''),[attempt,setAttempt]=useState<Attempt|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[result,setResult]=useState<any>(null),[loaded,setLoaded]=useState(false),[orders,setOrders]=useState<any[]>([]),[listBusy,setListBusy]=useState(false),[listError,setListError]=useState(''),[archives,setArchives]=useState<ArchivedAttempt[]>([]);
  const rotated=useRef<string|null>(null),listFlight=useRef<number|null>(null),flight=useRef(false),current=useRef(context),generation=useRef(0),alive=useRef(true);current.current=context;
  const visible=(epoch:number)=>alive.current&&current.current===context&&generation.current===epoch;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++}},[]);
  useEffect(()=>{generation.current++;flight.current=false;listFlight.current=null;setLoaded(false);setAttempt(null);setResult(null);setOrderId('');setBusy(false);setError('');setOrders([]);setListBusy(false);setListError('');setArchives([]);rotated.current=null;try{const storedArchives=loadArchives(context);setArchives(storedArchives);const a=load(context);setAttempt(a);if(a)setOrderId(a.orderId);setLoaded(true)}catch(e){setError(e instanceof Error?e.message:'Nie można odczytać próby.')}},[context]);
  const locked=busy||listBusy||!loaded||!p.admin||p.readOnly||p.externalWriteBlocked;
  async function actor(epoch:number){if(!visible(epoch))throw Error('Widok próby zmienił się.');const me=await api('/auth/me');if(!visible(epoch)||me.restore_preview||me.user?.id!==p.userId||me.user?.tenant_id!==p.tenantId||me.user?.role!=='admin')throw Error('Sesja lub firma zmieniła się. Zachowano próbę.');}
  function remember(a:Attempt,v:any){
    if(v.request_id!==a.requestId||v.order_id!==a.orderId)throw Error('Wynik dotyczy innej próby.');
    for(const [field,target] of [['rule_id','ruleId'],['workflow_id','workflowId'],['event_id','eventId'],['run_id','runId']] as const){
      if(v[field]!==undefined&&v[field]!==null){if(!uuid(v[field])||(a[target]&&a[target]!==v[field]))throw Error('Zapamiętane IDs zmieniły się; nie nadpisano próby.');}
    }
    const next={...a};for(const [field,target] of [['rule_id','ruleId'],['workflow_id','workflowId'],['event_id','eventId'],['run_id','runId']] as const)if(uuid(v[field]))next[target]=v[field];
    if(v.jobs!==undefined||v.job_ids!==undefined){const ids=v.jobs!==undefined?(Array.isArray(v.jobs)?v.jobs.map((j:any)=>j.id):null):v.job_ids;
      if(!Array.isArray(ids)||ids.length>2||ids.some(id=>!uuid(id))||new Set(ids).size!==ids.length)throw Error('Niepełne IDs zadań.');
      if(a.jobIds&&a.jobIds.some(id=>!ids.includes(id)))throw Error('Zmieniły się zapamiętane zadania.');next.jobIds=[...ids].sort();}
    return next;
  }
  async function read(a:Attempt,epoch:number){await actor(epoch);const v=await api('/orders/'+a.orderId+'/local-automation/'+a.requestId);let next=remember(a,v);
    const done=confirmedReceipt(a,next,v);
    // A read never resumes a mutation or authorizes retry of an uncertain POST.
    next={...next,phase:done?'confirmed':a.lastSent==='prepare'&&v.prepared_receipt_confirmed===true&&v.dispatch_started===false?'prepared':'unknown'};await actor(epoch);save(next);if(visible(epoch)){setAttempt(next);setResult(v);}
  }
  async function mutate(kind:'prepare'|'dispatch'){
    if(locked||flight.current||listFlight.current!==null||(kind==='prepare'&&(attempt||listError))||(kind==='dispatch'&&attempt?.phase!=='prepared'))return;
    const epoch=generation.current;if(!visible(epoch))return;flight.current=true;setBusy(true);setError('');let a=attempt;
    try{await actor(epoch);if(kind==='prepare'){if(!uuid(orderId)||load(context))throw Error('Podaj nowe zamówienie; poprzednia próba blokuje zapis.');a={v:1,context,orderId,requestId:crypto.randomUUID(),phase:'prepare-sent',lastSent:'prepare'};}
      else{if(!a||load(context)?.phase!=='prepared')throw Error('Brak potwierdzonego przygotowania.');a={...a,phase:'dispatch-sent',lastSent:'dispatch'};}
      save(a!);if(visible(epoch))setAttempt(a); // storage succeeds before the only POST; reload does not resend.
      const url='/api/orders/'+a!.orderId+'/local-automation/'+(kind==='prepare'?'prepare':a!.requestId+'/dispatch');
      const response=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'X-Workspace-ID':p.tenantId,'Content-Type':'application/json'},body:JSON.stringify(kind==='prepare'?{request_id:a!.requestId}:{})});
      const v=await response.json();if(v?.request_id===a!.requestId&&v?.order_id===a!.orderId)a=remember(a!,v);a={...a!,phase:'unknown'};save(a);if(visible(epoch))setAttempt(a);
      if(!response.ok)throw Error('Odebrano HTTP '+response.status+'. Skutki mogą istnieć; użyj odczytu bez ponawiania.');
      a=remember(a,v);await actor(epoch);if(kind==='prepare'){if(v.status!=='PREPARED'||v.scope!=='local_demo'||!a.ruleId||!a.workflowId)throw Error('Niepotwierdzone przygotowanie.');a={...a,phase:'prepared'};save(a);if(visible(epoch))setAttempt(a);if(visible(epoch))setResult(v);}
      else{if(v.status!=='OWNED_LOCAL_AUTOMATION_DONE'||v.scope!=='local_demo'||v.external_message_sent!==false||v.preexisting_jobs_executed!==false)throw Error('Niepotwierdzony wynik lokalny.');await read(a,epoch);}
    }catch(e){if(a){a={...a,phase:'unknown'};try{save(a)}catch{}if(visible(epoch))setAttempt(a);}if(visible(epoch))setError(e instanceof Error?e.message:'Niepewny wynik; nie ponawiaj.');}
    finally{if(visible(epoch)){flight.current=false;setBusy(false);}}
  }
  async function loadNewOrders(){
    if(locked||listFlight.current!==null||attempt)return;const epoch=generation.current;listFlight.current=epoch;setListBusy(true);setListError('');
    try{await actor(epoch);const response=await api('/orders?status=new&limit=50');await actor(epoch);
      if(!Array.isArray(response.data)||response.data.length>50||new Set(response.data.map((o:any)=>o?.id)).size!==response.data.length||response.data.some((o:any)=>!o||!uuid(o.id)||o.tenant_id!==p.tenantId||typeof o.number!=='string'||typeof o.customer_name!=='string'||typeof o.note!=='string'||typeof o.created_at!=='string'||!Number.isFinite(Date.parse(o.created_at))||o.status!=='new'))throw Error('Nie można potwierdzić listy zamówień tej firmy. Wczytaj ją ponownie przed przygotowaniem.');
      const recent=response.data.filter((o:any)=>uuid(o.id)&&o.status==='new'&&o.note===''&&typeof o.created_at==='string'&&Number.isFinite(Date.parse(o.created_at))&&Date.now()-Date.parse(o.created_at)>=0&&Date.now()-Date.parse(o.created_at)<15*60*1000);
      if(visible(epoch)){setOrders(recent);if(!recent.some((o:any)=>o.id===orderId))setOrderId('');}
    }catch(e){if(visible(epoch))setListError(e instanceof Error?e.message:'Nie można odczytać listy.');}
    finally{if(listFlight.current===epoch)listFlight.current=null;if(visible(epoch))setListBusy(false);}
  }
  function beginNewAttempt(){
    if(!attempt||rotated.current===attempt.requestId||locked||flight.current||listFlight.current!==null||attempt.phase!=='confirmed'||attempt.lastSent!=='dispatch'||!result||!confirmedReceipt(attempt,attempt,result))return;
    const epoch=generation.current;if(!visible(epoch))return;flight.current=true;setError('');
    try{
      const activeBytes=sessionStorage.getItem(key(context));if(activeBytes===null||JSON.stringify(JSON.parse(activeBytes))!==JSON.stringify(attempt))throw Error('Aktywna próba zmieniła się; nie rozpoczęto nowej.');
      const archiveKey=archivePrefix(context)+attempt.requestId,existing=sessionStorage.getItem(archiveKey);
      const record:ArchivedAttempt={v:1,context,archivedAt:new Date().toISOString(),attempt:structuredClone(attempt),activeBytes,readback:JSON.parse(JSON.stringify(result))};
      let archiveBytes=JSON.stringify(record);
      if(existing!==null){const prior=JSON.parse(existing);if(prior.context!==context||JSON.stringify(prior.attempt)!==JSON.stringify(record.attempt)||prior.activeBytes!==activeBytes||JSON.stringify(prior.readback)!==JSON.stringify(record.readback))throw Error('Istniejące archiwum różni się; nie nadpisano oryginału.');archiveBytes=existing;}
      else sessionStorage.setItem(archiveKey,archiveBytes);
      if(sessionStorage.getItem(archiveKey)!==archiveBytes)throw Error('Nie potwierdzono zapisu archiwum; aktywna próba pozostaje.');
      const records=loadArchives(context);
      if(!visible(epoch)||sessionStorage.getItem(key(context))!==activeBytes)throw Error('Kontekst lub próba zmieniły się; nie usunięto aktywnego wskaźnika.');
      sessionStorage.removeItem(key(context));if(sessionStorage.getItem(key(context))!==null)throw Error('Nie usunięto aktywnego wskaźnika; zachowano archiwum i próbę.');
      if(visible(epoch)){rotated.current=attempt.requestId;generation.current++;setArchives(records);setAttempt(null);setResult(null);setOrderId('');setOrders([]);setListError('');}
    }catch(e){if(visible(epoch))setError(e instanceof Error?e.message:'Archiwizacja niepotwierdzona; nie rozpoczęto nowej próby.');}
    finally{flight.current=false;}
  }
  async function reconcile(){if(!attempt||flight.current||locked)return;const epoch=generation.current;if(!visible(epoch))return;flight.current=true;setBusy(true);setError('');try{await read(attempt,epoch)}catch(e){if(visible(epoch))setError(e instanceof Error?e.message:'Nie potwierdzono wyniku.')}finally{if(visible(epoch)){flight.current=false;setBusy(false);}}}
  return <section className="panel ops-panel"><div className="panel-heading"><div><h2>Automatyzacja lokalna DEMO</h2>
    <p>Sprawdź automatyczne ustawienie statusu i dopisanie notatki po ręcznej wpłacie. To lokalne DEMO; nie wysyła email ani SMS do klienta.</p></div></div>
    <ol className="muted"><li>Wybierz własne zamówienie utworzone przed chwilą, jeszcze bez wpłaty i notatki. Przygotuj regułę.</li><li>Otwórz to zamówienie i w sekcji Płatności zarejestruj ręczną wpłatę. Wróć do Automatyzacji i sprawdź tę samą próbę.</li><li>Po potwierdzeniu wpłaty uruchom regułę jeden raz. Sprawdź status i notatkę.</li></ol>
    {!p.admin&&<p className="notice" role="status">Ten test może wykonać administrator firmy.</p>}
    {p.readOnly&&<p className="notice" role="status">Podgląd tylko do odczytu — zmiany są wyłączone.</p>}
    {p.externalWriteBlocked&&<p className="notice" role="status">Najpierw uzgodnij wynik trwającego importu.</p>}
    {!attempt&&<><button type="button" className="button" disabled={locked||listBusy} onClick={()=>void loadNewOrders()}>{listBusy?'Wczytywanie…':'Wczytaj nowe zamówienia'}</button>
      <div className="form-grid"><label>Własne nowe zamówienie<select value={orderId} disabled={locked||listBusy} onChange={e=>setOrderId(e.target.value)}><option value="">Wybierz zamówienie z listy</option>{orders.map(o=><option key={o.id} value={o.id}>{o.number??'Nowe zamówienie'} · {o.customer_name} · {new Date(o.created_at).toLocaleTimeString('pl-PL')}</option>)}</select></label></div>
      <p>Lista pokazuje do 50 ostatnich nieopłaconych zamówień, utworzonych w ostatnich 15 minutach i bez notatki. Przygotowanie sprawdzi, czy wybrane zamówienie zostało utworzone przez Ciebie. Nie zmienia istniejących reguł.</p>
      {listError&&<p className="notice import-error" role="alert">{listError}</p>}</>}
    <div className="ops-buttons"><button type="button" className="button" disabled={locked||listBusy||!!attempt||!!listError||!uuid(orderId)} onClick={()=>void mutate('prepare')}>Przygotuj regułę dla tego zamówienia</button>
    {p.onOpenOrder&&uuid(attempt?.orderId??orderId)&&<button type="button" className="button" disabled={busy||listBusy||p.externalWriteBlocked} onClick={()=>p.onOpenOrder?.(attempt?.orderId??orderId)}>Otwórz zamówienie i Płatności</button>}
    <button type="button" className="button primary" disabled={locked||attempt?.phase!=='prepared'||result?.order?.status!=='paid'} onClick={()=>void mutate('dispatch')}>Uruchom raz po potwierdzeniu wpłaty</button>
    <button type="button" className="button" disabled={locked||!attempt} onClick={()=>void reconcile()}>Sprawdź wynik tej samej próby</button>
    {attempt?.phase==='confirmed'&&<button type="button" className="button" disabled={locked||!result||!confirmedReceipt(attempt,attempt,result)} onClick={beginNewAttempt}>Nowa próba</button>}</div>
    {attempt?.phase==='confirmed'&&<p className="muted">Nowa próba zachowa oryginalne dane w archiwum. Po odświeżeniu najpierw sprawdź wynik tej samej próby. Wysłanej lub niepotwierdzonej próby nie można usunąć.</p>}
    {attempt&&<p className="notice" role="status">{attempt.phase==='confirmed'?'Potwierdzono status i lokalną notatkę.':attempt.phase==='prepared'?'Reguła przygotowana. Potwierdź wpłatę w zamówieniu, a następnie sprawdź tę próbę.':attempt.phase==='unknown'?'Wynik jeszcze niepotwierdzony. Nie wysyłaj ponownie.':'Żądanie wysłane; sprawdź wynik bez ponawiania.'}</p>}
    {attempt?.phase==='unknown'&&<p>Odświeżenie nie ponawia zapisu. Brak potwierdzenia wymaga uzgodnienia skutków.</p>}
    {result?.order&&<p>Zamówienie: {fulfilmentLabel(String(result.order.status))}; własny status: {result.order.workflow_status_id===attempt?.workflowId?'potwierdzony':'niepotwierdzony'}; notatka: {result.order.note||'jeszcze brak'}.</p>}
    {attempt&&<details><summary>Dane próby do wsparcia</summary><p>Próba: <code>{attempt.requestId}</code> · zamówienie: <code>{attempt.orderId}</code>{attempt.ruleId&&<> · reguła: <code>{attempt.ruleId}</code></>}{attempt.eventId&&<> · zdarzenie: <code>{attempt.eventId}</code></>}{attempt.runId&&<> · wykonanie: <code>{attempt.runId}</code></>}{attempt.jobIds?.map(id=><span key={id}> · zadanie: <code>{id}</code></span>)}</p></details>}
    {archives.length>0&&<details><summary>Archiwum potwierdzonych prób ({archives.length})</summary>{archives.map(r=><details key={r.attempt.requestId}><summary>Próba {r.attempt.requestId} · {new Date(r.archivedAt).toLocaleString('pl-PL')}</summary><p>Zamówienie: <code>{r.attempt.orderId}</code> · reguła: <code>{r.attempt.ruleId}</code> · zdarzenie: <code>{r.attempt.eventId}</code> · wykonanie: <code>{r.attempt.runId}</code>{r.attempt.jobIds?.map(id=><span key={id}> · zadanie: <code>{id}</code></span>)}</p><p>Zachowany wynik: {fulfilmentLabel(String(r.readback.order?.status??''))}; notatka: {r.readback.order?.note}.</p><p className="muted">Zapis potwierdzenia z tej karty. Nie ponawia operacji ani nie sprawdza bieżącego stanu.</p><details><summary>Pełny zapis potwierdzenia</summary><pre>{JSON.stringify(r.readback,null,2)}</pre></details></details>)}</details>}
    {error&&<p className="notice import-error" role="alert">{error}</p>}
  </section>;
}
