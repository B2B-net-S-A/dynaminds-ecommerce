/** Proposed parent mount. Native /health capability remains false until actual adoption. */
import {useEffect,useState} from 'react';
import {PimDictionaryEditor,pimEditorLocked,subscribePimEditorLock,type PimContext,type PimTransport} from './editor';
import {PimBatchEditor,type CatalogChoice} from './batch/panel';
import {PimFilePanel} from './file-panel';
export {pimEditorLocked,subscribePimEditorLock};export type {PimContext};
const tabs=new Map<string,string>();
export function usePimParentLock(context:PimContext|null){const[,update]=useState(0);useEffect(()=>subscribePimEditorLock(()=>update(n=>n+1)),[]);return!!context&&pimEditorLocked(context);}
export function PimCatalogTools({enabled,context,catalogId,products,transport,externalWriteBlocked,onChanged}:{enabled:boolean;context:PimContext;catalogId:string;products:readonly CatalogChoice[];transport:PimTransport;externalWriteBlocked:boolean;onChanged:()=>void}){
 const scope=JSON.stringify([context,catalogId]),[choice,setChoice]=useState({scope,tab:tabs.get(scope)??'dictionary'}),tab=choice.scope===scope?choice.tab:(tabs.get(scope)??'dictionary');const locked=usePimParentLock(context);
 // Pending original controls survive a temporarily unavailable capability read; native reads still decide authority.
 if(!enabled&&!locked)return null;if(!catalogId)return <p className="notice">Wybierz jeden katalog, aby odczytać jego parametry zarządzane.</p>;
 return <section className="panel" aria-label="Zarządzane parametry katalogu"><header className="panel-heading"><div><h2>Kategorie i parametry</h2><p>Parametry zarządzane mają osobny podgląd i zgodę. Dotychczasowa kategoria i atrybuty produktu pozostają oddzielne.</p></div></header><div className="toolbar">{[['dictionary','Słownik kategorii i parametrów'],['sheet','Arkusz parametrów'],['files','Plik parametrów CSV / XML']].map(([id,label])=><button type="button" className="button" key={id} disabled={locked||externalWriteBlocked} onClick={()=>{if(!pimEditorLocked(context)&&!externalWriteBlocked){tabs.set(scope,id);setChoice({scope,tab:id});}}}>{label}</button>)}</div>
 {tab==='dictionary'?<PimDictionaryEditor key={scope} context={context} catalogId={catalogId} transport={transport} externalWriteBlocked={externalWriteBlocked} onChanged={onChanged}/>:tab==='sheet'?<PimBatchEditor key={scope} context={context} catalogId={catalogId} products={products} transport={transport} externalWriteBlocked={externalWriteBlocked} onChanged={onChanged}/>:<PimFilePanel key={scope} context={context} catalogId={catalogId} products={products} transport={transport} externalWriteBlocked={externalWriteBlocked} onChanged={onChanged}/>}
 </section>;
}
