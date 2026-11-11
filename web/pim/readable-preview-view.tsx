import type {Dictionary,Preview} from './dictionaries/contract2';
import {fieldErrorLabel,readableDictionary,readableProducts,type ReadableRow} from './readable-preview';
function Rows({rows,label}:{rows:ReadableRow[];label:string}){return <div className="table-scroll"><table aria-label={label}><thead><tr><th>Pozycja</th><th>Przed</th><th>Po</th></tr></thead><tbody>{rows.map(x=><tr key={x.id}><th scope="row">{x.name}</th><td>{x.before}</td><td>{x.after}</td></tr>)}</tbody></table>{rows.length===0&&<p>Brak pozycji.</p>}</div>;}
export function PimReadablePreview({preview:p,dictionary:d}:{preview:Preview;dictionary:Dictionary|null}){
 let presentationError='';let dictionary:ReturnType<typeof readableDictionary>|null=null,products:ReturnType<typeof readableProducts>=[];
 try{dictionary=p.kind==='dictionary'&&p.dictionary_before&&p.dictionary_after?readableDictionary(p.dictionary_before,p.dictionary_after):null;
 products=p.kind==='product_values'&&d?readableProducts(p,d):[];}catch{presentationError='Nie można przedstawić kompletnego odczytu w tabeli. Pełna odpowiedź jest poniżej w szczegółach technicznych.';}
 return <div aria-label="Pełny podgląd przed i po">{presentationError&&<p className="error-block" role="alert">{presentationError}</p>}{p.errors.length>0&&<ul className="error-block" role="alert">{p.errors.map((e,i)=><li key={i}>Wiersz {e.row+1} · {d?fieldErrorLabel(e,d):`Sprawdź ${e.field}: ${e.code}`}</li>)}</ul>}
 {dictionary&&<><h4>Kategorie · {dictionary.categories.length}</h4><Rows rows={dictionary.categories} label="Kategorie przed i po"/><h4>Parametry słownika · {dictionary.definitions.length}</h4><Rows rows={dictionary.definitions} label="Parametry słownika przed i po"/></>}
 {products.length>0&&<p>Nazwy kategorii, parametrów i opcji pochodzą z odczytanego słownika. Pełne identyfikatory i dane historyczne są w szczegółach technicznych.</p>}
 {products.map(x=><section key={x.id} aria-label={'Zmiany produktu '+x.name}><h4>{x.name} · {x.changed?'Zmieniono':'Bez zmian'}</h4><Rows rows={[x.category,...x.values]} label={'Parametry przed i po · '+x.name}/></section>)}
 {!p.ready&&p.product_rows.length===0&&p.kind==='product_values'&&<p className="notice">Cała próba została odrzucona. Żadna pozycja produktu nie została przyjęta.</p>}
 <details open={presentationError?true:undefined}><summary>Szczegóły techniczne</summary><div className="table-scroll"><pre>{JSON.stringify(p,null,2)}</pre></div></details></div>;
}
