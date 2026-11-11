import {useEffect,useRef,useState} from 'react';
import {api} from './api';
type Rate={provider:'NBP';table:'A';table_number:string;currency_code:'EUR';currency_name:string;publication_date:string;effective_date:string;publication_date_source:'NBP effectiveDate';source_decimal:string;mid_decimal:string;mid_scaled:string;scale:number;source_age_days:number;max_age_days:number;observed_at:string;mode:'public_read_only'};
const rateKeys=['provider','table','table_number','currency_code','currency_name','publication_date','effective_date','publication_date_source','source_decimal','mid_decimal','mid_scaled','scale','source_age_days','max_age_days','observed_at','mode'].sort().join(',');
function rateReply(value:unknown,maxAgeDays:number):Rate{
 const r=value as Rate;
 if(!r||typeof r!=='object'||Array.isArray(r)||typeof r.source_decimal!=='string'||typeof r.publication_date!=='string'||typeof r.observed_at!=='string'||typeof r.table_number!=='string')throw Error('Niepełna lub niezgodna odpowiedź kursu NBP');
 const decimal=/^(0|[1-9]\d{0,17})(?:\.(\d{1,8}))?$/.exec(r.source_decimal);
 const publication=Date.parse(r?.publication_date+'T00:00:00.000Z'),observed=Date.parse(r?.observed_at);
 if(!Number.isFinite(publication)||new Date(publication).toISOString().slice(0,10)!==r?.publication_date||!Number.isFinite(observed)||new Date(observed).toISOString()!==r?.observed_at||r?.table_number?.slice(-4)!==r?.publication_date?.slice(0,4)||Math.floor(observed/86400000)-publication/86400000!==r?.source_age_days)throw Error('Niepełna lub niezgodna data kursu NBP');
 if(!r||Object.keys(r).sort().join(',')!==rateKeys||r.provider!=='NBP'||r.table!=='A'||r.currency_code!=='EUR'||r.mode!=='public_read_only'||typeof r.currency_name!=='string'||!r.currency_name.trim()||r.currency_name.length>120||!/^\d{3}\/A\/NBP\/\d{4}$/.test(r.table_number)||r.publication_date_source!=='NBP effectiveDate'||!/^\d{4}-\d{2}-\d{2}$/.test(r.publication_date)||r.publication_date!==r.effective_date||!Number.isFinite(Date.parse(r.observed_at))||r.max_age_days!==maxAgeDays||!Number.isSafeInteger(r.source_age_days)||r.source_age_days<0||r.source_age_days>maxAgeDays||!decimal||r.mid_decimal!==r.source_decimal||r.scale!==(decimal[2]??'').length||typeof r.mid_scaled!=='string'||!/^[1-9]\d*$/.test(r.mid_scaled)||BigInt(decimal[1]!+(decimal[2]??''))!==BigInt(r.mid_scaled))throw Error('Niepełna lub niezgodna odpowiedź kursu NBP');
 return r;
}
/** One user action reads public NBP data. Mount/navigation never calls a provider. */
export function NbpRates({contextKey,readOnly,read=api}:{contextKey:string;readOnly:boolean;read?:typeof api}){
 const [result,setResult]=useState<{context:string;rate:Rate}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(false),epoch=useRef(0),flight=useRef<AbortController|null>(null),live=useRef({contextKey,readOnly});live.current={contextKey,readOnly};
 useEffect(()=>{alive.current=true;epoch.current++;flight.current?.abort();flight.current=null;setResult(null);setError('');setBusy(false);return()=>{alive.current=false;epoch.current++;flight.current?.abort();flight.current=null;};},[contextKey,readOnly]);
 async function load(){
  if(readOnly||flight.current)return;
  const expected={...live.current},generation=++epoch.current,controller=new AbortController();flight.current=controller;setBusy(true);setResult(null);setError('');
  const current=()=>alive.current&&!controller.signal.aborted&&epoch.current===generation&&live.current.contextKey===expected.contextKey&&live.current.readOnly===expected.readOnly;
  const get=(path:string)=>read(path,'GET',undefined,{},controller.signal);
  const auth=async()=>{const m=await get('/auth/me');if(!current())return false;const u=m?.user;if(!u||[u.tenant_id,u.id,u.role,expected.readOnly].join(':')!==expected.contextKey||m.restore_preview!==expected.readOnly)throw Error('Kontekst użytkownika zmienił się. Odczytaj kurs ponownie');return true;};
  try{
   if(!await auth()||!current())return;
   const capability=await get('/nbp');if(!current())return;
   if(!capability||capability.available!==true||capability.read_only!==false||JSON.stringify(capability.currencies)!=='["EUR"]'||!Number.isSafeInteger(capability.max_age_days)||capability.max_age_days<0||capability.max_age_days>31)throw Error('Odczyt NBP nie został włączony w tym środowisku');
   const reply=await get('/nbp/rate?currency=EUR');if(!current())return;
   const rate=rateReply(reply,capability.max_age_days);
   if(!await auth()||!current())return;setResult({context:expected.contextKey,rate});
  }catch(e){if(current()){setResult(null);setError(e instanceof Error?e.message:'Nie udało się odczytać kursu NBP');}}
  finally{if(flight.current===controller){flight.current=null;if(current())setBusy(false);}}
 }
 const rate=result?.context===contextKey&&!readOnly?result.rate:null;
 return <section className="panel" aria-label="Kurs NBP">
  <div className="panel-heading"><div><h2>Kurs NBP</h2><p>Średni kurs EUR z ostatniej opublikowanej tabeli A. Odczyt ręczny.</p></div></div>
  <div className="form-body">
   <p className="notice">Kurs informacyjny. Odczyt nie przelicza cen, faktur ani reguł repricing.</p>
   {readOnly&&<p className="notice" role="status">Połączenia z dostawcami są wyłączone w podglądzie kopii.</p>}
   <div className="inline-actions" style={{alignItems:'flex-end',flexWrap:'wrap',marginBottom:20}}>
    <label style={{width:260,maxWidth:'100%'}}>Waluta <select value="EUR" disabled><option value="EUR">EUR — euro</option></select></label>
    <button className="button" type="button" disabled={readOnly||busy} onClick={()=>void load()}>Odczytaj kurs NBP</button>
   </div>
   {busy&&<p className="notice" role="status">Pobieranie kursu NBP…</p>}
   {error&&<p className="notice" role="alert">{error}</p>}
   {rate&&<div className="catalog-section" role="status" style={{display:'grid',gap:8,lineHeight:1.6}}>
    <p><strong>1 EUR = {rate.source_decimal.replace('.',',')} PLN</strong></p>
    <p>Tabela {rate.table_number} · data publikacji: {rate.publication_date}</p>
    <p>Odczytano: {rate.observed_at}</p>
    <p>Wiek publikacji: {rate.source_age_days} {rate.source_age_days===1?'dzień':'dni'} · dopuszczalny wiek: {rate.max_age_days} {rate.max_age_days===1?'dzień':'dni'}</p>
   </div>}
  </div>
 </section>;
}
