/** Browser-only visual mapping draft. No native authority, transport, CAS, or label guessing. */
import type {Dictionary} from '../dictionaries/contract2';
import type {MappingTemplate} from './session';
import type {SourceFields} from './source-fields';
export type TokenChoice={kind:'unset'}|{kind:'boolean';value:boolean}|{kind:'enum';option_id:string};
export type FieldDraft={source_key:string;definition_id:string;missing:'reject'|'unset';tokens:Record<string,TokenChoice|undefined>;unset_tokens:string[]};
export type MappingDraft={category_mode?:'field'|'none';category_source:string;categories:Record<string,string|null|undefined>;fields:FieldDraft[]};
export const emptyDraft=():MappingDraft=>({category_mode:'field',category_source:'',categories:Object.create(null),fields:[]});
export const tokenLabel=(s:string)=>s===''?'Pusta wartość w pliku':JSON.stringify(s);
function need(v:unknown,message:string):asserts v{if(!v)throw Error(message);}
function collisionLabels(entries:{id:string;label:string}[]){
 const candidates=entries.map(e=>{const same=entries.filter(x=>x.label===e.label&&x.id!==e.id);if(!same.length)return{...e};let n=8;while(n<36&&same.some(x=>x.id.slice(0,n)===e.id.slice(0,n)))n++;return{...e,label:e.label+' · '+e.id.slice(0,n)};});
 // Labels are legitimate arbitrary text: an original label can equal another row's generated suffix.
 // Escalate only actual collisions to a complete UUID. Distinct complete UUID suffixes cannot collide.
 const full=new Set<string>();for(let pass=0;pass<=entries.length;pass++){
  const shown=candidates.map((e,i)=>({...e,label:full.has(e.id)?entries[i].label+' · '+e.id:e.label})),groups=new Map<string,string[]>();
  for(const e of shown)groups.set(e.label,[...(groups.get(e.label)??[]),e.id]);
  const collisions=[...groups.values()].filter(g=>g.length>1);if(!collisions.length)return shown;
  const before=full.size;for(const group of collisions)for(const id of group)full.add(id);need(full.size>before,'Nie można jednoznacznie przedstawić nazw');
 }
 throw Error('Nie można jednoznacznie przedstawić nazw');
}
export function categoryChoices(d:Dictionary){function path(id:string){const out:string[]=[],seen=new Set<string>();let c=d.categories.find(c=>c.id===id);while(c){need(!seen.has(c.id),'Nieprawidłowe drzewo kategorii');seen.add(c.id);out.unshift(c.name);c=c.parent_id===null?undefined:d.categories.find(p=>p.id===c!.parent_id);}return out.join(' › ');}return collisionLabels(d.categories.filter(c=>c.active).map(c=>({id:c.id,label:path(c.id)})));}
export const definitionChoices=(d:Dictionary)=>collisionLabels(d.definitions.filter(x=>x.active).map(x=>({id:x.id,label:x.name})));
export function optionChoices(d:Dictionary,definitionId:string){const def=d.definitions.find(x=>x.id===definitionId);return def?.shape.kind==='enum'?collisionLabels(def.shape.options.filter(o=>o.active).map(o=>({id:o.id,label:o.label}))):[];}
export function requiredLabels(d:Dictionary,draft:MappingDraft){const ids=new Set(Object.values(draft.category_mode==='none'?{}:draft.categories).filter((id):id is string=>typeof id==='string'));const required=new Set([...ids].flatMap(id=>d.effective_bindings.find(b=>b.category_id===id)?.definitions.filter(b=>b.required).map(b=>b.definition_id)??[]));return definitionChoices(d).filter(x=>required.has(x.id));}
export function compileMapping(d:Dictionary,s:SourceFields,draft:MappingDraft):MappingTemplate{
 need(d.available&&!d.read_only&&d.can_manage&&d.catalog_id===s.catalog_id,'Słownik nie pozwala na mapowanie');need(draft.fields.length<=50,'Nie można mapować więcej niż 50 parametrów');
 need(draft.category_mode===undefined||draft.category_mode==='field'||draft.category_mode==='none','Wybierz sposób przypisania kategorii');const noCategory=draft.category_mode==='none';const category=s.fields.find(f=>(noCategory?f.source===s.product_source:f.key===draft.category_source)&&f.json_key===undefined);need(category&&!category.missing,noCategory?'Tożsamość musi pochodzić z całego zachowanego pliku':'Wybierz pole kategorii obecne we wszystkich wierszach');need(category.tokens.length<=500,'Przekroczono pełny zakres kategorii');
 const categoryIds=new Set(d.categories.filter(c=>c.active).map(c=>c.id));const entries=category.tokens.map(legacy=>{need(legacy.length<=500,'Wartość kategorii przekracza 500 znaków');if(!noCategory)need(Object.hasOwn(draft.categories,legacy)&&draft.categories[legacy]!==undefined,'Wybierz kategorię dla '+tokenLabel(legacy));const category_id=noCategory?null:draft.categories[legacy]!;need(category_id===null||categoryIds.has(category_id),'Kategoria stała się niedostępna');return{legacy,category_id};});
 const defs=new Set<string>(),selectors=new Set<string>();const fields=draft.fields.map(row=>{const f=s.fields.find(f=>f.key===row.source_key),def=d.definitions.find(x=>x.id===row.definition_id&&x.active);need(f&&def,'Wybierz rzeczywiste pole i parametr');need(!defs.has(def.id)&&!selectors.has(f.key),'Parametr lub źródło zostały wybrane dwukrotnie');defs.add(def.id);selectors.add(f.key);need(['reject','unset'].includes(row.missing),'Wybierz zachowanie brakującego pola');
  const base={source:f.source,...(f.json_key===undefined?{}:{json_key:f.json_key}),definition_id:def.id,kind:def.shape.kind,missing:row.missing,unset_tokens:[] as string[]};
  if(def.shape.kind==='text'||def.shape.kind==='decimal'){need(new Set(row.unset_tokens).size===row.unset_tokens.length&&row.unset_tokens.length<=200&&row.unset_tokens.every(t=>t.length<=500&&f.tokens.includes(t)),'Nieprawidłowy jawny brak wartości');base.unset_tokens=[...row.unset_tokens];return base;}
  need(f.tokens.length<=200&&f.tokens.every(t=>t.length<=500),'Źródło '+f.label+' przekracza limit 200 tokenów lub 500 znaków tokenu; nic nie obcięto');const options=new Set(optionChoices(d,def.id).map(o=>o.id)),tokens:unknown[]=[];
  for(const legacy of f.tokens){need(Object.hasOwn(row.tokens,legacy)&&row.tokens[legacy]!==undefined,'Wybierz znaczenie '+tokenLabel(legacy)+' dla '+def.name);const c=row.tokens[legacy]!;if(c.kind==='unset')base.unset_tokens.push(legacy);else if(def.shape.kind==='boolean'){need(c.kind==='boolean'&&typeof c.value==='boolean','Wybierz Tak, Nie lub brak');tokens.push({legacy,value:c.value});}else{need(c.kind==='enum'&&options.has(c.option_id),'Wybierz aktywną opcję lub brak');tokens.push({legacy,option_id:c.option_id});}}
  need(tokens.length>0,'Natywna mapa tego typu wymaga przynajmniej jednego jawnie mapowanego tokenu');return{...base,tokens};
 });
 for(let i=0;i<s.rows;i++){const categoryId=entries.find(e=>e.legacy===category.values[i])?.category_id;const required=d.effective_bindings.find(b=>b.category_id===categoryId)?.definitions.filter(b=>b.required)??[];for(const b of required){const row=draft.fields.find(f=>f.definition_id===b.definition_id),source=row&&s.fields.find(f=>f.key===row.source_key),def=d.definitions.find(x=>x.id===b.definition_id),raw=source?.values[i];const present=row&&raw!==undefined&&(def?.shape.kind==='boolean'||def?.shape.kind==='enum'?row.tokens[raw]?.kind!==undefined&&row.tokens[raw]?.kind!=='unset':!row.unset_tokens.includes(raw));need(present,`Wiersz ${i+1}: uzupełnij wymagany parametr „${def?.name??'Nieznany parametr'}”`);}}
 return{catalog_id:s.catalog_id,catalog_source:null,product_source:s.product_source,category:{encoding:'explicit',source:category.source,entries},fields};
}
