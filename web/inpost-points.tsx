import {useEffect,useRef,useState} from 'react';
import {Search,Truck} from 'lucide-react';
import {api} from './api';
type Point={name:string;type:string[];address:{line1:string;line2:string};status:string;location:{latitude:number;longitude:number}};
type Page={data:Point[];page:number;count:number};
const malformed=()=>new Error('Odpowiedź Punktów InPost jest niepoprawna. Wyszukaj ponownie.');
function pageReply(value:unknown,requested:number):Page{
 const p=value as Page;
 if(!p||Object.keys(p).sort().join(',')!=='count,data,page'||!Number.isSafeInteger(p.count)||p.count<0||p.page!==requested||!Number.isInteger(p.page)||p.page<1||p.page>100||!Array.isArray(p.data)||p.data.length>20||p.data.length>p.count)throw malformed();
 const names=new Set<string>();
 for(const r of p.data){
  if(!r||Object.keys(r).sort().join(',')!=='address,location,name,status,type'||typeof r.name!=='string'||!r.name||names.has(r.name)||typeof r.status!=='string'||!Array.isArray(r.type)||!r.type.every(x=>typeof x==='string')||!r.address||typeof r.address.line1!=='string'||typeof r.address.line2!=='string'||!r.location||!Number.isFinite(r.location.latitude)||!Number.isFinite(r.location.longitude))throw malformed();
  names.add(r.name);
 }
 return p;
}
/** Read-only provider page view. The native API remains the sole data source. */
export function InPostPoints({contextKey,readOnly,refresh=0}:{contextKey:string;readOnly:boolean;refresh?:number}){
 const [city,setCity]=useState('Warszawa'),[result,setResult]=useState<(Page&{city:string})|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const epoch=useRef(0),alive=useRef(false),flight=useRef<number|null>(null),live=useRef({contextKey,readOnly,refresh});live.current={contextKey,readOnly,refresh};
 function invalidate(){epoch.current++;flight.current=null;setResult(null);setBusy(false);setError('');}
 useEffect(()=>{alive.current=true;invalidate();return()=>{alive.current=false;epoch.current++;flight.current=null;};},[contextKey,readOnly,refresh]);
 async function load(requested:number,scopeCity:string){
  if(flight.current!==null)return;
  const selectedCity=scopeCity.trim();
  if(selectedCity.length<2||selectedCity.length>100||!Number.isInteger(requested)||requested<1||requested>100){setResult(null);setError('Podaj miasto od 2 do 100 znaków.');return;}
  const expected={...live.current},g=++epoch.current;flight.current=g;setBusy(true);setError('');setResult(null);
  const current=()=>alive.current&&epoch.current===g&&live.current.contextKey===expected.contextKey&&live.current.readOnly===expected.readOnly&&live.current.refresh===expected.refresh;
  const auth=async()=>{const m=await api('/auth/me');if(!current())return false;const u=m?.user;if(!u||[u.tenant_id,u.id,u.role,expected.readOnly].join(':')!==expected.contextKey||(typeof m.restore_preview==='boolean'&&m.restore_preview!==expected.readOnly))throw Error('Kontekst użytkownika zmienił się. Wyszukaj punkty ponownie.');return true;};
  try{
   if(!await auth()||!current())return;
   const response=await api('/inpost/points?'+new URLSearchParams({city:selectedCity,page:String(requested)}));
   if(!current())return;
   const page=pageReply(response,requested);
   if(!await auth()||!current())return;
   setResult({...page,city:selectedCity});
  }catch(e){if(current()){setResult(null);setError(e instanceof Error?e.message:'Nie udało się pobrać punktów InPost.');}}
  finally{if(flight.current===g){flight.current=null;if(current())setBusy(false);}}
 }
 const pages=result?Math.min(100,Math.max(1,Math.ceil(result.count/20))):0;
 return <section className="panel" aria-label="Punkty InPost">
  <div className="panel-heading"><div><h2>Punkty InPost</h2><p>Wyszukaj rzeczywiste punkty odbioru w API InPost.</p></div><Truck size={22}/></div>
  <form className="points-search" onSubmit={e=>{e.preventDefault();void load(1,city);}}>
   <input value={city} onChange={e=>{setCity(e.target.value);invalidate();}} aria-label="Miasto punktów InPost" required minLength={2} maxLength={100}/>
   <button className="button" disabled={busy} type="submit"><Search size={16}/>Szukaj punktów</button>
  </form>
  {busy&&<p className="notice" role="status">Pobieranie punktów InPost…</p>}
  {error&&<p className="notice" role="alert">{error}</p>}
  {result&&<>
   <div className="table-footer integration-pagination"><span role="status">{result.city} · strona {result.page} z {pages} · wyświetlono {result.data.length} punktów · łącznie {result.count}</span>
    <nav className="inline-actions" aria-label="Strony punktów InPost">
     <button className="button small-btn" type="button" disabled={busy||result.page<=1} onClick={()=>void load(result.page-1,result.city)}>Poprzednia strona</button>
     <button className="button small-btn" type="button" disabled={busy||result.page>=pages||result.page>=100} onClick={()=>void load(result.page+1,result.city)}>Następna strona</button>
    </nav>
   </div>
   {result.count>2000&&<p className="notice">API udostępnia maksymalnie 100 stron po 20 punktów. Zawęź wyszukiwanie, aby dotrzeć do pozostałych wyników.</p>}
   {!result.data.length&&<p className="notice" role="status">Brak punktów na tej stronie dla miasta {result.city}.</p>}
   <div className="points-grid">{result.data.map(p=><div key={p.name}><strong>{p.name}</strong><p>{p.address.line1}<br/>{p.address.line2}</p><small>{p.status}</small></div>)}</div>
  </>}
 </section>;
}
