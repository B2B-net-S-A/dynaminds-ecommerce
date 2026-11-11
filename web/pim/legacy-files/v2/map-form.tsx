/** Complete retained-source visual v2 form. Only identity/dictionary GET on mount. */
import {useEffect,useMemo,useRef,useState} from 'react';
import type {Dictionary} from '../../dictionaries/contract2';
import type {PimContext,PimTransport} from '../../editor';
import {decodeDictionary} from '../../batch/model';
import {coreRequest,type CoreCustody} from '../handoff';
import {categoryChoices} from '../model';
import {previewCanonicalRows} from './browser-parse';
import {discoverNestedChoices,validateFriendlyDraft} from './selector-model';
import {NestedFieldForm} from './field-form';
import {readableSelectorLabel} from './unmapped-model';
import {selectJson} from '../../../../shared/pim-json';
import type {CatalogFileImportInput} from '../../../../server/catalog-file-import-schema';
import type {MappingV2,Selector} from '../../../../shared/pim-legacy-mapping-v2';
export type NestedFormProps={context:PimContext;custody:CoreCustody;transport:PimTransport;blocked:boolean;available:boolean;onEdit:()=>void;onAccessLost:()=>void;onMapping:(m:MappingV2)=>unknown};
export function NestedMapForm(props:NestedFormProps){
 const latest=useRef(props);latest.current=props;
 const scope=JSON.stringify([props.context,props.custody.context_key,props.custody.execution.id,props.custody.serialized_request]);
 const [read,setRead]=useState<{scope:string;dictionary:Dictionary|null;error:string;busy:boolean}>({scope,dictionary:null,error:'',busy:false});
 const [categoryPath,setCategoryPath]=useState(''),[categoryMap,setCategoryMap]=useState<Record<string,string>>({}),[fields,setFields]=useState<MappingV2['fields']>([]),[error,setError]=useState(''),[reload,setReload]=useState(0);
 const original=useMemo(()=>{try{const q=coreRequest(props.custody.serialized_request);return{q,found:discoverNestedChoices(previewCanonicalRows(q as CatalogFileImportInput)),error:''};}catch(e){return{q:null,found:null,error:(e as Error).message};}},[props.custody.serialized_request]);
 const dictionary=read.scope===scope?read.dictionary:null;
 useEffect(()=>{setCategoryPath('');setCategoryMap({});setFields([]);setError('');},[scope]);
 useEffect(()=>{let active=true;const p=latest.current;
  if(!p.available){setRead({scope,dictionary:null,error:'Mapowanie struktur czeka na zweryfikowaną obsługę struktur.',busy:false});return()=>{active=false;};}
  setRead({scope,dictionary:null,error:'',busy:true});
  const identity=async()=>{const r:any=await p.transport('/auth/me');if(!active)return false;if(r?.user?.id!==p.context.user_id||r?.user?.tenant_id!==p.context.tenant_id||r?.user?.role!==p.context.role||r?.restore_preview!==p.context.restore_preview){p.onAccessLost();throw Error('Tożsamość lub dostęp uległy zmianie.');}return true;};
  void(async()=>{try{if(!await identity())return;const q=coreRequest(p.custody.serialized_request);const raw=await p.transport('/product-catalogs/'+q.catalog_id+'/pim/dictionary');if(!active)return;const d=decodeDictionary(raw,q.catalog_id);if(!await identity())return;setRead({scope,dictionary:d,error:'',busy:false});}catch(e){if(!active)return;if([401,403,404].includes((e as {status?:number}).status??0))p.onAccessLost();setRead({scope,dictionary:null,error:(e as Error).message,busy:false});}})();
  return()=>{active=false;};
 },[scope,props.transport,props.available,reload]);
 const choices=original.found?.fields??[];
 const category=choices.find(c=>c.id===categoryPath);
 const tokens=category?Array.from(new Set(category.values.map(v=>{if(v.state!=='present'||typeof v.value!=='string')return null;return v.value;}))):[];
 const categoryError=tokens.includes(null)?'Każdy wiersz musi zawierać kategorię jako dokładny tekst.':tokens.length>500?'Kategorie przekraczają pełny limit500.':'';
 const blocked=props.blocked||!props.available||read.busy||!dictionary?.available||!!dictionary?.read_only||!dictionary?.can_manage;
 const edit=(fn:()=>void)=>{if(blocked)return;try{latest.current.onEdit();fn();setError('');}catch(e){setError((e as Error).message);}};
 const submit=async()=>{try{const p=latest.current;if(p.blocked||!p.available||blocked)throw Error('Poczekaj na dostęp i zakończenie innych zapisów.');if(!dictionary||!original.q||!category||categoryError)throw Error(categoryError||'Wybierz pełne źródło kategorii.');const entries=tokens.map(source=>{if(source===null||!Object.hasOwn(categoryMap,source)||categoryMap[source]==='')throw Error('Wybierz kategorię dla każdej wartości z pliku.');return{source,category_id:categoryMap[source]==='__none__'?null:categoryMap[source]};});const mapping=validateFriendlyDraft(dictionary,{schema:'legacy-pim-mapping/v2',catalog_id:original.q.catalog_id,product_source:original.q.identity,category:{selector:category.selector,entries},fields});if(latest.current.blocked||!latest.current.available)throw Error('Dostęp lub blokada zapisu uległy zmianie.');await latest.current.onMapping(mapping);}catch(e){setError((e as Error).message);}};
 return <section aria-label="Mapowanie zagnieżdżonych danych z pliku"><h4>Pełne dane JSON z zapisanego importu</h4><p>Klucze i indeksy wybierasz osobno. Obiekty i listy pozostają w źródle; niczego nie spłaszczamy ani nie obcinamy. Zapis parametrów wymaga później osobnego podglądu i zgody.</p>
 {(error||read.error||original.error||categoryError)&&<p role="alert">{error||read.error||original.error||categoryError}</p>}{read.busy&&<p role="status">Odczyt słownika…</p>}
 <button type="button" className="button" disabled={read.busy||props.blocked||!props.available} onClick={()=>setReload(n=>n+1)}>Odśwież słownik mapowania struktur</button>
 <fieldset className="warehouse-fieldset" disabled={blocked||!!original.error}><legend>Kategoria dla całego pliku</legend><label>Ścieżka kategorii w pliku<select value={categoryPath} onChange={e=>edit(()=>{setCategoryPath(e.target.value);setCategoryMap({});})}><option value="" disabled>Wybierz rzeczywiste pole</option>{choices.map(c=><option key={c.id} value={c.id}>{readableSelectorLabel(c.selector)}</option>)}</select></label>
 {!categoryError&&tokens.map(source=>source===null?null:<label key={source}>Kategoria dla {source===''?'pustego tekstu':JSON.stringify(source)}<select value={Object.hasOwn(categoryMap,source)?categoryMap[source]:''} onChange={e=>edit(()=>setCategoryMap(m=>({...m,[source]:e.target.value})))}><option value="" disabled>Wybierz kategorię katalogu</option><option value="__none__">Bez kategorii zarządzanej</option>{dictionary&&categoryChoices(dictionary).map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label>)}
 </fieldset>
 <fieldset className="warehouse-fieldset" disabled={blocked||!!original.error}><legend>Parametry i jawne typy</legend>{dictionary&&fields.map((f,index)=><div key={index}><NestedFieldForm records={original.found?.records??[]} dictionary={dictionary!} value={f} onChange={value=>edit(()=>setFields(rows=>rows.map((r,i)=>i===index?value:r)))}/><button type="button" className="button" onClick={()=>edit(()=>setFields(rows=>rows.filter((_,i)=>i!==index)))}>Usuń parametr {index+1}</button></div>)}<button type="button" className="button" disabled={fields.length>=50||!dictionary} onClick={()=>edit(()=>setFields(rows=>[...rows,{definition_id:'',selector:{source:'',path:[]},codec:{kind:'text'},absence:{missing:'reject',null:'reject'}}]))}>Dodaj parametr ze struktury</button></fieldset>
 <p>Cały plik: {original.found?.records.length??0} wierszy. Ścieżki przekraczające limit mapowania nie są oferowane do wyboru; pełne dane pozostają zachowane i będą widoczne jako nieprzypisane.</p>
 <button type="button" className="button" disabled={blocked||!category||!!categoryError||!!original.error} onClick={()=>void submit()}>Odczytaj zapisany import i sprawdź struktury</button>
 <details><summary>Pełne zachowane źródło JSON</summary><pre>{JSON.stringify(original.found?.records??[],null,2)}</pre></details></section>;
}
