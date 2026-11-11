import {useEffect, useRef, useState} from 'react';
import {api, money} from './api';
import {ProductPicker} from './catalog';

type Props = {tenantId:string; userId:string; admin:boolean; readOnly:boolean; externalWriteBlocked:boolean; refresh:number};
type Attempt = {v:1; context:string; requestId:string; productId:string; catalogId:string; warehouseId:string;
  state:'sent'|'unknown'|'confirmed'; channelId?:string; planId?:string; jobId?:string; listingId?:string};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const storageKey=(context:string,productId:string)=>'dyna:local-woo-offer:v1:'+context+':'+productId;
function load(context:string,productId:string):Attempt|null {
  const raw=sessionStorage.getItem(storageKey(context,productId));if(raw===null)return null;
  const a=JSON.parse(raw);
  if(a.v!==1||a.context!==context||a.productId!==productId||![a.requestId,a.productId,a.catalogId,a.warehouseId].every(uuid)
    ||!['sent','unknown','confirmed'].includes(a.state)||['channelId','planId','jobId','listingId'].some(k=>a[k]!==undefined&&!uuid(a[k])))
    throw Error('Zapis próby jest niepełny. Nie ponawiaj oferty; uzgodnij jej wynik.');
  return a;
}
function save(a:Attempt){sessionStorage.setItem(storageKey(a.context,a.productId),JSON.stringify(a));}
export function mergeLocalOfferAttempt(original:Attempt, next:Attempt):Attempt {
  if(['v','context','requestId','productId','catalogId','warehouseId'].some(k=>original[k as keyof Attempt]!==next[k as keyof Attempt]))
    throw Error('Oryginalna próba zmieniła się. Zachowano poprzedni zapis.');
  const merged={...original,...next};
  for(const field of ['channelId','planId','jobId','listingId'] as const){
    if(next[field]!==undefined&&!uuid(next[field])||original[field]!==undefined&&next[field]!==undefined&&original[field]!==next[field])
      throw Error('Zapamiętane IDs nie odpowiadają zapisanej próbie.');
    if(next[field]===undefined&&original[field]!==undefined)merged[field]=original[field];
  }
  merged.state=original.state==='confirmed'?'confirmed':next.state==='confirmed'?'confirmed':
    original.state==='unknown'||next.state==='unknown'?'unknown':'sent';
  return merged;
}
export function LocalSimulationOffer(props:Props) {
  const context=props.tenantId+':'+props.userId;
  const [catalogs,setCatalogs]=useState<any[]>([]),[warehouses,setWarehouses]=useState<any[]>([]);
  const [catalogId,setCatalogId]=useState(''),[product,setProduct]=useState<any>(null),[warehouseId,setWarehouseId]=useState('');
  const [attempt,setAttempt]=useState<Attempt|null>(null),[loadedProduct,setLoadedProduct]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[listing,setListing]=useState<any>(null);
  const [open,setOpen]=useState(false),[optionsReady,setOptionsReady]=useState(false);
  const inFlight=useRef(false),alive=useRef(true),current=useRef(''),generation=useRef(0);
  current.current=context+':'+(product?.id??'');
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++}},[]);
  useEffect(()=>{
    let active=true;setOptionsReady(false);
    void Promise.all([api('/product-catalogs/options'),api('/warehouses')]).then(([o,w])=>{
      if(!active)return;
      if(!o.available||!o.can_read||o.read_only||o.current_role!=='admin'||!Array.isArray(o.catalogs)||!Array.isArray(w.data))throw Error('Brak aktualnego dostępu administratora do katalogów.');
      const own=o.catalogs.filter((c:any)=>c.active&&Array.isArray(c.settings?.warehouse_ids));
      setCatalogs(own);setWarehouses(w.data);setCatalogId(old=>own.some((c:any)=>c.id===old)?old:(own.find((c:any)=>c.is_default)?.id??own[0]?.id??''));
      setOptionsReady(true);
    }).catch(e=>active&&setError(e instanceof Error?e.message:'Nie udało się odczytać katalogów.'));
    return()=>{active=false};
  },[context,props.refresh]);
  useEffect(()=>{
    generation.current++;
    setAttempt(null);setListing(null);setLoadedProduct('');setError('');
    if(!product?.id)return;
    try {const stored=load(context,product.id);setAttempt(stored);if(stored)setWarehouseId(stored.warehouseId);setLoadedProduct(product.id);}
    catch(e){setError(e instanceof Error?e.message:'Nie można odczytać zapisanej próby.');}
  },[context,product?.id]);
  const permitted=warehouses.filter(w=>catalogs.find(c=>c.id===catalogId)?.settings.warehouse_ids.includes(w.id));
  const locked=busy||inFlight.current||Boolean(attempt)||!props.admin||props.readOnly||props.externalWriteBlocked||!optionsReady||loadedProduct!==product?.id;
  const visible=(a:Attempt,epoch:number)=>alive.current&&generation.current===epoch&&current.current===a.context+':'+a.productId;
  const freshActor=async(epoch:number)=>{
    if(!alive.current||generation.current!==epoch)throw Error('Widok zmienił się. Zachowano poprzednią próbę.');
    const m=await api('/auth/me');
    if(!alive.current||generation.current!==epoch||m.restore_preview||m.user?.tenant_id!==props.tenantId||m.user?.id!==props.userId||m.user?.role!=='admin')
      throw Error('Użytkownik lub firma zmienili się. Zachowano poprzednią próbę.');
  };
  async function persist(a:Attempt,epoch:number,initial=false){
    await freshActor(epoch);
    if(!visible(a,epoch))throw Error('Widok produktu zmienił się. Zachowano poprzedni zapis.');
    const stored=load(a.context,a.productId);
    if(initial?stored!==null:stored===null)throw Error('Zapis oryginalnej próby zmienił się. Nie ponawiaj oferty.');
    const next=stored?mergeLocalOfferAttempt(stored,a):a;
    save(next);setAttempt(next);return next;
  }
  async function readback(a:Attempt,epoch:number) {
    await freshActor(epoch);let channelId=a.channelId;
    if(!channelId){
      const channels=await api('/integrations');
      const found=channels.channels?.filter((c:any)=>c.settings?.local_offer_request_id===a.requestId&&c.settings.local_offer_actor_id===props.userId);
      if(!found||found.length!==1)throw Error('Brak jednoznacznego zapisanego kanału. Nie ponawiaj tej próby.');
      const ch=found[0];
      if(!uuid(ch.id)||ch.provider!=='woocommerce'||ch.mode!=='sandbox'||ch.settings.simulation!==true
        ||ch.settings.local_offer_source!=='scoped-woocommerce-offer/v1'||ch.sync_enabled!==false)
        throw Error('Kanał nie odpowiada tej lokalnej próbie.');
      channelId=ch.id;a=await persist({...a,state:'unknown',channelId},epoch);
    }
    const p=await api('/integrations/'+channelId+'/offers');
    if(p.channel?.id!==channelId||p.channel.provider!=='woocommerce'||p.channel.mode!=='sandbox'||p.channel.settings?.simulation!==true
      ||p.channel.settings.local_offer_source!=='scoped-woocommerce-offer/v1'||p.channel.settings.local_offer_request_id!==a.requestId||p.channel.settings.local_offer_actor_id!==props.userId)
      throw Error('Kanał nie odpowiada tej lokalnej próbie.');
    a=await persist({...a,state:'unknown',channelId},epoch);
    if(!Array.isArray(p.data)||p.meta?.cursor)throw Error('Odczyt planów jest niepełny. Zachowano kanał; nie ponawiaj oferty.');
    const plans=p.data.filter((v:any)=>v.product_id===a.productId&&v.warehouse_id===a.warehouseId&&v.actor_id===props.userId&&v.channel_id===channelId&&v.operation==='create_draft');
    if(plans.length!==1)throw Error('Brak jednoznacznego planu. Zachowano kanał; nie ponawiaj oferty.');
    const plan=plans[0];
    if(!uuid(plan.id)||plan.job_id!==null&&!uuid(plan.job_id))throw Error('Niepełne tożsamości zapisanego planu.');
    if(a.planId&&a.planId!==plan.id||a.jobId&&a.jobId!==plan.job_id)throw Error('Zapamiętane IDs nie odpowiadają zapisanej próbie.');
    a=await persist({...a,state:'unknown',planId:plan.id,...(plan.job_id?{jobId:plan.job_id}:{})},epoch);
    if(!plan.job_id||plan.state!=='done'||plan.phase!=='done'||plan.job_state!=='done'||Number(plan.attempts)!==1||plan.result?.scope!=='local_simulation'||plan.result.desired_applied!==true)
      throw Error('Plan nie potwierdza zakończenia. Odczyt nie zezwala na ponowny zapis.');
    const ls=await api('/integrations/'+channelId+'/offer-listings');
    const matches=Array.isArray(ls.data)?ls.data.filter((v:any)=>v.id===plan.listing_id):[];const l=matches[0];
    if(matches.length!==1||!l||!uuid(l.id)||l.channel_id!==channelId||l.product_id!==a.productId||l.warehouse_id!==a.warehouseId||l.status!=='simulation'||l.external_id!=='DEMO-'+plan.id||plan.remote_id!==l.external_id)
      throw Error('Brak dokładnego listingu DEMO. Nie ponawiaj zapisu.');
    const done=await persist({...a,state:'confirmed',listingId:l.id},epoch);
    if(visible(done,epoch))setListing({id:l.id,external_id:l.external_id,status:l.status,price:l.price,price_currency:l.price_currency});
  }
  async function submit(){
    if(locked||inFlight.current||!product?.id||product.catalog_id!==catalogId||!permitted.some(w=>w.id===warehouseId))return;
    inFlight.current=true;setBusy(true);setError('');
    let a:Attempt|null=null;const epoch=generation.current;
    try {
      await freshActor(epoch);const p=await api('/products/'+product.id);
      const o=await api('/product-catalogs/options');
      if(p.id!==product.id||p.catalog_id!==catalogId||!o.available||o.read_only||o.current_role!=='admin'||!o.catalogs.some((c:any)=>c.id===catalogId&&c.active&&c.settings?.warehouse_ids.includes(warehouseId)))
        throw Error('Produkt lub dozwolony magazyn zmienił się.');
      if(current.current!==context+':'+product.id)throw Error('Widok produktu zmienił się.');
      if(load(context,product.id))throw Error('Istnieje zapisana próba. Najpierw odczytaj jej wynik.');
      a={v:1,context,requestId:crypto.randomUUID(),productId:product.id,catalogId,warehouseId,state:'sent'};
      a=await persist(a,epoch,true); // durable before POST; no automatic resend after reopen/reload.
      const response=await fetch('/api/products/'+a.productId+'/local-simulation-offer',{method:'POST',credentials:'same-origin',
        headers:{'X-Workspace-ID':props.tenantId,'Content-Type':'application/json'},body:JSON.stringify({request_id:a.requestId,warehouse_id:a.warehouseId})});
      const value=await response.json();
      if(value?.request_id===a.requestId&&['OWNED_WOO_LOCAL_SIMULATION_OFFER_DONE','OWNED_WOO_LOCAL_SIMULATION_OFFER_FAILED'].includes(value.status)){
        for(const [key,field] of [['channelId','channel_id'],['planId','plan_id'],['jobId','job_id']] as const){
          if(value[field]!==null&&value[field]!==undefined&&!uuid(value[field]))throw Error('Niepełne IDs oryginalnej odpowiedzi. Nie ponawiaj próby.');
          if(uuid(value[field]))a={...a,[key]:value[field]};
        }
      }else if(response.ok)throw Error('Odpowiedź nie odpowiada oryginalnej próbie. Nie ponawiaj zapisu.');
      a=await persist({...a,state:'unknown'},epoch);
      if(!response.ok){
        const quota=value?.status==='OWNED_WOO_LOCAL_SIMULATION_OFFER_FAILED'&&value.request_id===a.requestId
          &&response.status===409&&value.quota_code==='WORKSPACE_CHANNEL_LIMIT'&&typeof value.detail==='string'
          &&value.detail.length<=160&&/^Limit planu: połączenia\. Wykorzystano (?:0|[1-9][0-9]{0,18}), limit (?:0|[1-9][0-9]{0,18})\.$/.test(value.detail)
          ? ' '+value.detail : '';
        throw Error('Odebrano HTTP'+response.status+'.'+quota+' Wynik może być zapisany. Odczytaj go bez ponawiania.');
      }
      if(response.status!==201||value.status!=='OWNED_WOO_LOCAL_SIMULATION_OFFER_DONE'||value.scope!=='local_simulation'||value.request_id!==a.requestId||value.provider_verified!==false||value.preexisting_jobs_executed!==false)
        throw Error('Odpowiedź nie potwierdza dokładnej symulacji. Nie ponawiaj próby.');
      await readback(a,epoch);
    }catch(e){if(a)try{a=await persist({...a,state:'unknown'},epoch)}catch{}if(alive.current&&generation.current===epoch)setError(e instanceof Error?e.message:'Niepewny wynik. Nie ponawiaj zapisu.');}
    finally{inFlight.current=false;if(alive.current)setBusy(false);}
  }
  async function reconcile(){if(!attempt||inFlight.current)return;const epoch=generation.current;inFlight.current=true;setBusy(true);setError('');try{await readback(attempt,epoch)}catch(e){if(alive.current&&generation.current===epoch)setError(e instanceof Error?e.message:'Nie potwierdzono wyniku.')}finally{inFlight.current=false;if(alive.current&&generation.current===epoch)setBusy(false)}}
  return <section className="panel local-demo-offer"><h2>Oferta DEMO WooCommerce</h2><p>Jedna własna oferta w lokalnej symulacji. Nie publikuje produktu u dostawcy.</p>
    <button className="button" type="button" onClick={()=>setOpen(v=>!v)}>{open?'Ukryj formularz':'Oferta DEMO WooCommerce'}</button>
    {open&&<div>
      <label>Katalog<select value={catalogId} disabled={busy} onChange={e=>{setCatalogId(e.target.value);setProduct(null);setWarehouseId('')}}>{catalogs.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <ProductPicker label="Produkt do oferty DEMO" value={product?.id??''} initial={product} contextKey={context} catalogId={catalogId} disabled={busy||!catalogId} filter={p=>p.active&&p.kind!=='group'} select={p=>{setProduct(p??null);setWarehouseId('')}}/>
      <label>Dozwolony magazyn<select value={warehouseId} disabled={busy||Boolean(attempt)} onChange={e=>setWarehouseId(e.target.value)}><option value="">Wybierz magazyn</option>{permitted.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
      <button type="button" className="button primary" disabled={locked||!warehouseId} onClick={()=>void submit()}>Utwórz jedną ofertę DEMO</button>
      {attempt&&<p role="status">Próba: {attempt.requestId}. {attempt.state==='confirmed'?'Plan, job i listing DEMO potwierdzone.':'Wynik wymaga odczytu; ponowny zapis jest zablokowany.'}</p>}
      {attempt&&<button type="button" className="button" disabled={busy} onClick={()=>void reconcile()}>Odczytaj wynik bez ponawiania</button>}
      {attempt?.channelId&&<><a href="#local-demo-offer-result">Szczegóły zapisanego wyniku</a><details id="local-demo-offer-result"><summary>Własna próba DEMO</summary><p>Kanał {attempt.channelId} · plan {attempt.planId??'niepotwierdzony'} · job {attempt.jobId??'niepotwierdzony'}</p>{listing&&<p>Listing {listing.id} · {listing.external_id} · {listing.status} · {money(Number(listing.price),listing.price_currency)}</p>}</details></>}
    </div>}
    {error&&<p className="notice" role="alert">{error}</p>}
  </section>;
}
