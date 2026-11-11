/** Presentation only: no validation/authority/CAS mutation, truncation or transport. */
import type {Category,Definition,Dictionary,Preview,RowError,Value} from './dictionaries/contract2';
import {decimalCoefficient,PimValidationError} from './dictionaries/model3';
type DictionaryData=Pick<Dictionary,'categories'|'definitions'|'effective_bindings'>;
export type ReadableRow={id:string;name:string;before:string;after:string};
export type ReadableProduct={id:string;name:string;category:ReadableRow;values:ReadableRow[];changed:boolean};
const unique=(ids:readonly string[])=>[...new Set(ids)];
const absent='Nie podano';
/** Include identity only when distinct IDs share the same displayed label, across both sides. */
function identityLabel(entries:readonly {id:string;name:string}[],id:string,unknown:string):string{
 const own=entries.find(x=>x.id===id);if(!own)return `${unknown} (${id})`;
 return own.name+(entries.some(x=>x.id!==id&&x.name===own.name)?` (${id})`:'');
}
export const categoryLabel=(d:DictionaryData,id:string|null,peer?:DictionaryData)=>id===null?'Nie przypisano':identityLabel([...d.categories,...(peer?.categories??[])],id,'Nieznana kategoria');
const definitionLabel=(d:DictionaryData,id:string,peer?:DictionaryData)=>d.definitions.some(x=>x.id===id)?identityLabel([...d.definitions,...(peer?.definitions??[])],id,'Nieznany parametr'):id;
function optionLabel(definition:Definition,id:string,peer?:Definition):string{
 const own=definition.shape.kind==='enum'?definition.shape.options:[];const other=peer?.shape.kind==='enum'?peer.shape.options:[];
 return identityLabel([...own,...other].map(x=>({id:x.id,name:x.label})),id,'Nieznana opcja');
}
export function valueLabel(v:Value|undefined,definition:Definition|undefined,peer?:Definition):string{
 if(!v)return absent;
 if(v.kind==='boolean')return v.value?'Tak':'Nie';
 if(v.kind==='text')return v.value===''?'Pusty tekst (podano)':JSON.stringify(v.value);
 if(v.kind==='decimal')return v.value+(definition?.shape.kind==='decimal'&&definition.shape.unit?' '+definition.shape.unit:'');
 return definition?.shape.kind==='enum'?optionLabel(definition,v.option_id,peer):`Opcja (${v.option_id})`;
}
export function fieldErrorLabel(e:RowError,d:DictionaryData):string{
 const def=d.definitions.find(x=>x.id===e.definition_id),name=def?definitionLabel(d,def.id):(e.field==='category_id'?'Kategoria':'Parametry');
 if(e.code==='required')return `Uzupełnij wymagany parametr „${name}”.`;
 if(e.code==='decimal_codec'||e.code==='negative_zero'){const shape=def?.shape;return `Parametr „${name}” wymaga liczby z kropką${shape?.kind==='decimal'?` i dokładnie ${shape.scale} miejscami po przecinku`:''}; bez zaokrąglania.`;}
 if(e.code==='decimal_bounds')return `Wartość parametru „${name}” jest poza dozwolonym zakresem${def?.shape.kind==='decimal'?` (${def.shape.minimum??'bez minimum'} – ${def.shape.maximum??'bez maksimum'})`:''}.`;
 if(e.code==='wrong_type')return `Parametr „${name}” ma niewłaściwy typ wartości.`;
 if(e.code==='unknown_or_inactive_option')return `Wybierz aktywną opcję parametru „${name}”.`;
 if(e.code==='text_value')return `Sprawdź tekst parametru „${name}”${def?.shape.kind==='text'?` — limit ${def.shape.max_length} znaków`:''}; znaki sterujące nie są dozwolone.`;
 if(e.code==='unknown_or_inactive_category')return 'Wybierz aktywną kategorię produktu.';
 if(e.code==='unbound_definition')return `Parametr „${name}” nie jest przypisany do wybranej kategorii.`;
 if(e.code==='values_without_category')return 'Najpierw wybierz kategorię dla podanych parametrów.';
 if(e.code==='invalid_typed_values')return 'Sprawdź wszystkie wymagane parametry i ich typy. Serwer odmówił całego zestawu wartości.';
 return `Sprawdź „${name}”: ${e.code} (${e.field}).`;
}
/** Attach only decimal codec errors whose unchanged pure codec identifies the field. */
export function presentationErrors(errors:readonly RowError[],d:DictionaryData,values:readonly Value[]):RowError[]{
 return errors.flatMap(e=>{if(e.definition_id!==null||!['decimal_codec','negative_zero'].includes(e.code))return[{...e}];const matches:RowError[]=[];for(const v of values){const def=d.definitions.find(x=>x.id===v.definition_id);if(v.kind!=='decimal'||def?.shape.kind!=='decimal')continue;try{decimalCoefficient(v.value,def.shape.scale);}catch(err){if(err instanceof PimValidationError&&err.errors.some(x=>x.code===e.code))matches.push({...e,definition_id:v.definition_id});}}return matches.length?matches:[{...e}];});
}
function bindingLabels(c:Category,d:DictionaryData,peer?:DictionaryData){return c.bindings.map(b=>definitionLabel(d,b.definition_id,peer)+(b.required?' — wymagany':' — opcjonalny'));}
function categoryDescription(c:Category|undefined,d:DictionaryData,peer?:DictionaryData){return c?`${c.active?'Aktywna':'Nieaktywna'}; nadrzędna: ${categoryLabel(d,c.parent_id,peer)}; parametry własne: ${bindingLabels(c,d,peer).join(', ')||'brak'}; obowiązujące (z dziedziczeniem): ${(d.effective_bindings.find(x=>x.category_id===c.id)?.definitions??[]).map(b=>definitionLabel(d,b.definition_id,peer)+(b.required?' — wymagany':' — opcjonalny')+'; źródła: '+b.inherited_from.map(id=>categoryLabel(d,id,peer)).join(', ')).join(' | ')||'brak'}`:'Nie istnieje';}
function shapeDescription(x:Definition,peer?:Definition){const s=x.shape;if(s.kind==='boolean')return 'Tak / Nie';if(s.kind==='text')return `Tekst; do ${s.max_length} znaków`;if(s.kind==='decimal')return `Liczba; ${s.scale} miejsc po przecinku; jednostka: ${s.unit??'brak'}; minimum: ${s.minimum??'brak'}; maksimum: ${s.maximum??'brak'}`;return 'Wybór jednej opcji: '+s.options.map(o=>`${optionLabel(x,o.id,peer)} (${o.active?'aktywna':'nieaktywna'})`).join(', ');}
function definitionDescription(d:Definition|undefined,peer?:Definition){return d?`${d.active?'Aktywny':'Nieaktywny'}; ${shapeDescription(d,peer)}`:'Nie istnieje';}
export function readableDictionary(before:Dictionary,after:Dictionary):{categories:ReadableRow[];definitions:ReadableRow[]}{
 return {categories:unique([...before.categories.map(x=>x.id),...after.categories.map(x=>x.id)]).map(id=>{const b=before.categories.find(x=>x.id===id),a=after.categories.find(x=>x.id===id);return{id,name:categoryLabel(a?after:before,id,a?before:after),before:(b?categoryLabel(before,id,after)+' · ':'')+categoryDescription(b,before,after),after:(a?categoryLabel(after,id,before)+' · ':'')+categoryDescription(a,after,before)};}),definitions:unique([...before.definitions.map(x=>x.id),...after.definitions.map(x=>x.id)]).map(id=>{const b=before.definitions.find(x=>x.id===id),a=after.definitions.find(x=>x.id===id);return{id,name:definitionLabel(a?after:before,id,a?before:after),before:(b?definitionLabel(before,id,after)+' · ':'')+definitionDescription(b,a),after:(a?definitionLabel(after,id,before)+' · ':'')+definitionDescription(a,b)};})};
}
export function readableProducts(preview:Preview,d:DictionaryData):ReadableProduct[]{
 return preview.product_rows.map(x=>{const before=x.before,after=x.after,definitionIds=unique([...before.effective_bindings.map(x=>x.definition_id),...(d.effective_bindings.find(x=>x.category_id===after.category_id)?.definitions.map(x=>x.definition_id)??[]),...before.values.map(x=>x.definition_id),...after.values.map(x=>x.definition_id)]);return{id:before.product_id,name:`${before.sku} · ${before.name}`,changed:x.changed,category:{id:before.product_id,name:'Kategoria',before:categoryLabel(d,before.category_id),after:categoryLabel(d,after.category_id)},values:definitionIds.map(id=>{const def=d.definitions.find(x=>x.id===id);return{id,name:def?definitionLabel(d,id):id,before:valueLabel(before.values.find(x=>x.definition_id===id),def),after:valueLabel(after.values.find(x=>x.definition_id===id),def)};})};});
}
