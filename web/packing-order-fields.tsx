import {useEffect,useRef,useState} from 'react';
import {packingFieldRows,type PackingOrderFieldDetail} from './packing-order-field-display';
export type {PackingOrderFieldDetail} from './packing-order-field-display';
type Props={contextKey:string;orderId:string;refresh:number;readFields(path:string):Promise<PackingOrderFieldDetail>};
type State={scope:string;detail:PackingOrderFieldDetail|null;error:string;busy:boolean};
export function PackingOrderFields({contextKey,orderId,refresh,readFields}:Props){
 const scope=contextKey+':'+orderId,request=useRef(readFields),generation=useRef(0),alive=useRef(false);
 request.current=readFields;
 const [state,setState]=useState<State>({scope,detail:null,error:'',busy:false});
 async function load(){const n=++generation.current,current=scope;setState({scope:current,detail:null,error:'',busy:true});try{const detail=await request.current('/orders/'+encodeURIComponent(orderId)+'/fields');packingFieldRows(detail,orderId);if(alive.current&&n===generation.current)setState({scope:current,detail,error:'',busy:false});}catch(e){if(alive.current&&n===generation.current)setState({scope:current,detail:null,error:e instanceof Error?e.message:'Nie udało się odczytać pól zamówienia.',busy:false});}}
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;++generation.current;};},[scope,refresh]);
 const current=state.scope===scope?state:null,rows=current?.detail?packingFieldRows(current.detail,orderId):[];
 return <section className="packing-card" aria-label="Pola dodatkowe do pakowania"><header className="packing-heading"><h4>Pola dodatkowe zamówienia</h4><button type="button" className="button" disabled={!!current?.busy} onClick={()=>void load()}>Odśwież pola</button></header>
 {current?.busy&&<p role="status">Odczytywanie pól zamówienia…</p>}{current?.error&&<p className="error" role="alert">{current.error}</p>}
 {current?.detail&&(!current.detail.available?<p>Pola dodatkowe są niedostępne w tej kopii.</p>:<><p className="packing-help">Aktywne pola dostępne dla Twojej roli · wersja zamówienia {current.detail.order_version}. Zmiany wykonasz na karcie zamówienia.</p>{rows.length?<dl>{rows.map(r=><div key={r.id}><dt>{r.label}</dt><dd style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{r.text}</dd></div>)}</dl>:<p>Brak aktywnych pól do wyświetlenia.</p>}</>)}
 </section>;
}
