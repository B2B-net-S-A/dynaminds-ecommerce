import { useEffect, useRef, useState } from 'react';
import { api } from './api';
type Metadata = { order_id:string;order_version:number;items:{id:string;name:string;sku:string;quantity:number}[];channels:{id:string;name:string;mode:string}[];external_read_available:boolean;external_read_reason?:string|null };
export function AmazonMcfReadOnlyPanel({ order,readOnly=false }:{order:{id:string;version:number};readOnly?:boolean}) {
  const [data,setData]=useState<Metadata|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),
    [channel,setChannel]=useState(''),[origin,setOrigin]=useState(''),[service,setService]=useState(''),
    [skus,setSkus]=useState<Record<string,string>>({}),[tier,setTier]=useState('STANDARD'),
    [externalId,setExternalId]=useState(''),[result,setResult]=useState<any>(null);
  const generation=useRef(0),pending=useRef(false),controller=useRef<AbortController|null>(null);
  useEffect(()=>{
    const current=++generation.current,abort=new AbortController();controller.current=abort;
    pending.current=false;setBusy(false);setData(null);setError('');setResult(null);setChannel('');setOrigin('');setService('');setExternalId('');setSkus({});
    api<Metadata>(`/orders/${order.id}/amazon-mcf`,'GET',undefined,{},abort.signal).then(v=>{
      if(current!==generation.current)return;
      setData(v);setSkus(Object.fromEntries(v.items.map(i=>[i.id,i.sku])));
    }).catch(e=>{if(current===generation.current&&!abort.signal.aborted)setError(e.message);});
    return ()=>{++generation.current;controller.current?.abort();};
  },[order.id,order.version,readOnly]);
  function edit(change:()=>void){++generation.current;setResult(null);setError('');change();}
  async function read(kind:'preview'|'order') {
    if(pending.current||!data||data.order_id!==order.id||data.order_version!==order.version)return;
    const current=++generation.current,abort=new AbortController();controller.current=abort;
    pending.current=true;setBusy(true);setError('');setResult(null);
    const scope={channel_id:channel,order_version:order.version,origin_country:origin,
      ...(service?{fulfillment_service_id:service}:{})};
    try {
      const value=kind==='preview'
        ? await api(`/orders/${order.id}/amazon-mcf/preview`,'POST',{...scope,service_tiers:[tier],sku_map:data.items.map(i=>({item_id:i.id,amazon_sku:skus[i.id]??''}))},{},abort.signal)
        : await api(`/orders/${order.id}/amazon-mcf/order?`+new URLSearchParams({...scope,order_version:String(scope.order_version),order_id:externalId}),'GET',undefined,{},abort.signal);
      if(current===generation.current)setResult({kind,...value});
    } catch(e){if(current===generation.current&&!abort.signal.aborted)setError((e as Error).message);}
    finally{if(current===generation.current){pending.current=false;setBusy(false);}}
  }
  const current=data?.order_id===order.id&&data.order_version===order.version;
  if(!data&&!error)return null;
  const enabled=current&&!readOnly&&data?.external_read_available&&!busy;
  const scoped=!!channel&&/^[A-Z]{2}$/.test(origin);
  const visible=result&&current&&result.order_id===order.id&&result.order_version===order.version;
  return <section className="panel amazon-mcf-readonly-panel">
    <div className="panel-heading"><div><h2>Realizacja przez Amazon MCF — podgląd</h2><p>Sprawdź propozycje dostawy lub odczytaj istniejącą realizację. Ten panel nie tworzy przesyłki i nie rezerwuje towaru.</p></div></div>
    <div className="info-body">
      {error&&<p role="alert" className="error-block">{error}</p>}
      {current&&data&&<>
        {readOnly&&<p>Połączenia z dostawcami są wyłączone w podglądzie kopii.</p>}
        {!readOnly&&!data.external_read_available&&<p>Połączenie MCF jest wyłączone w tym uruchomieniu. Skontaktuj się z administratorem.</p>}
        {data.external_read_available&&!data.channels.length&&<p>Najpierw dodaj i zweryfikuj konto Amazon w Integracjach. Odczyt wymaga roli Amazon Fulfillment na koncie dostawcy.</p>}
        <fieldset disabled={!enabled}><legend>Konto i zakres odczytu</legend>
          <label>Konto Amazon<select value={channel} onChange={e=>edit(()=>setChannel(e.target.value))}><option value="">Wybierz konto</option>{data.channels.map(c=><option key={c.id} value={c.id}>{c.name} · {c.mode==='sandbox'?'sandbox':'konto rzeczywiste'}</option>)}</select></label>
          <label>Kraj zapasu Amazon (kod, np. DE)<input value={origin} maxLength={2} onChange={e=>edit(()=>setOrigin(e.target.value.toUpperCase()))}/></label>
          <label>ID usługi realizacji (opcjonalne)<input value={service} maxLength={40} onChange={e=>edit(()=>setService(e.target.value))}/></label>
          <p>Kraj zapasu wybierz jawnie. Bez ID usługi odczyt dotyczy domyślnego zakresu autoryzacji konta.</p>
          <label>Usługa dostawy<select value={tier} onChange={e=>edit(()=>setTier(e.target.value))}>{['STANDARD','EXPEDITED','PRIORITY','SCHEDULED'].map(t=><option key={t}>{t}</option>)}</select></label>
          <p>Zweryfikuj SKU Amazon dla każdej pozycji. Pola początkowo zawierają lokalne SKU; podgląd użyje ilości i aktualnego adresu z zamówienia. Pobranie i punkty odbioru nie są obsługiwane w tym podglądzie.</p>
          {data.items.map(i=><label key={i.id}>{i.name} · {i.quantity} szt. — SKU Amazon<input value={skus[i.id]??''} maxLength={50} onChange={e=>edit(()=>setSkus(old=>({...old,[i.id]:e.target.value})))}/></label>)}
          <button type="button" className="button" disabled={!scoped||!data.items.length||data.items.some(i=>!skus[i.id])} onClick={()=>read('preview')}>Sprawdź opcje i szacowane koszty MCF</button>
          <label>ID istniejącej realizacji Amazon<input value={externalId} maxLength={40} onChange={e=>edit(()=>setExternalId(e.target.value))}/></label>
          <button type="button" className="button" disabled={!scoped||!externalId} onClick={()=>read('order')}>Odczytaj realizację i śledzenie</button>
          <p>Wyszukiwanie dotyczy autoryzowanego konta Amazon. Nie potwierdza przypisania realizacji do tego lokalnego zamówienia ani kraju jej zapasu.</p>
        </fieldset>
      </>}
      {busy&&<p role="status">Trwa pojedynczy odczyt Amazon…</p>}
      {visible&&<div aria-live="polite"><p>Odczyt: {new Date(result.observed_at).toLocaleString('pl-PL')} · {result.mode==='sandbox'?'sandbox Amazon':'konto Amazon'}. Wynik jest chwilowym podglądem.</p>
        {result.kind==='preview'?<>
          <p>Pełna ilość: {result.result.completeQuantityCoverage?'tak':'nie'} · ograniczenia: {result.result.hasConstraints?'tak':'nie'} · oferty dla każdej przesyłki: {result.result.hasOffersForEveryShipment?'tak':'nie'} · wyceny wszystkich ofert: {result.result.hasPricesForEveryOffer?'tak':'nie'}</p>
          <p>Szacowane koszty nie są końcową należnością. Brak wyceny nie oznacza bezpłatnej dostawy. Podgląd nie potwierdza gotowości do nadania.</p>
          {(result.result.constraints??[]).map((c:any,n:number)=><p key={n}>{c.code}: {c.message}</p>)}
          {result.result.plannedShipments.map((s:any,n:number)=><article key={n} className="status-plan"><h3>Proponowana przesyłka {n+1}</h3><p>{s.items.map((i:any)=>`${i.productIdentifier.amazonSku}: ${i.amount.value}`).join(' · ')}</p>{(s.offers??[]).map((o:any,k:number)=><p key={k}>{o.fulfillmentConfiguration?.serviceLevel?.serviceTier??'Usługa niepodana'} · {o.estimatedPrice?`${o.estimatedPrice.totalPrice.amount} ${o.estimatedPrice.totalPrice.currencyCode}`:'Brak wyceny'}{o.fulfillmentConfiguration?.serviceLevel?.deliveryInterval&&` · szacowana dostawa ${o.fulfillmentConfiguration.serviceLevel.deliveryInterval.startTime} – ${o.fulfillmentConfiguration.serviceLevel.deliveryInterval.endTime}`}</p>)}</article>)}
        </>:<><h3>Amazon: {result.result.external_order_id}</h3><p>Status realizacji: {result.result.status??'niepodany'}. Nie oznacza to doręczenia każdej paczki.</p>{!result.result.tracking.length&&<p>Brak paczek w odpowiedzi.</p>}{result.result.tracking.map((p:any,n:number)=><article key={n} className="status-plan"><strong>Paczka {p.packageId}</strong><p>Przesyłka: {p.shipmentStatus} · paczka: {p.packageStatus??'stan niepodany'}</p>{p.tracking&&<p>{p.tracking.carrier?.trackingNumber??p.tracking.amazon?.trackingNumber??''} {p.tracking.carrier?.trackingUrl&&<a href={p.tracking.carrier.trackingUrl} target="_blank" rel="noopener noreferrer">Śledź paczkę u przewoźnika</a>}</p>}</article>)}</>}
      </div>}
    </div>
  </section>;
}
