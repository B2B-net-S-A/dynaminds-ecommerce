/** Browser-only proposal. Values belong to this listing, never mutate product attributes. */
export type AspectSource={id:string;label:string;values:string[]};
type Aspect={localizedAspectName:string;aspectConstraint:{aspectMode:string;itemToAspectCardinality:string;aspectMaxLength?:number;aspectDataType?:string;aspectFormat?:string};aspectValues?:{localizedValue:string;valueConstraints?:{applicableForLocalizedAspectName:string;applicableForLocalizedAspectValues:string[]}[]}[]};
const own=(value:unknown,key:string):unknown=>{if(!value||typeof value!=='object')return undefined;const d=Object.getOwnPropertyDescriptor(value,key);return d&&'value'in d?d.value:undefined;};
export function ownAspectValues(aspects:unknown,name:string):string[]{const v=own(aspects,name);return Array.isArray(v)&&v.every(x=>typeof x==='string')?[...v]:[];}
function scalar(value:unknown):string|undefined{if(typeof value==='string')return value.trim();if(typeof value==='boolean')return value?'true':'false';if(typeof value==='number'&&Number.isFinite(value))return String(value);return undefined;}
function values(value:unknown):string[]|undefined{
 if(!Array.isArray(value)){const s=scalar(value);return s===undefined?undefined:[s];}
 if(value.length>30)return undefined;const out:string[]=[];for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d))return undefined;const s=scalar(d.value);if(s===undefined)return undefined;out.push(s);}return out;
}
export function aspectSourceProblem(a:Aspect,v:string[],current:unknown):string|undefined{
 const c=a.aspectConstraint;
 if(!a.localizedAspectName||a.localizedAspectName.length>40)return 'Nieprawidłowa nazwa parametru kategorii.';
 if(!v.length||v.some(x=>!x.length))return 'Źródło jest puste; wpisz lub wybierz wartość.';
 if(v.length>30||new Set(v).size!==v.length)return 'Źródło ma za dużo wartości lub duplikaty.';
 if(c.itemToAspectCardinality!=='MULTI'&&v.length>1)return 'Ten parametr przyjmuje jedną wartość.';
 if(v.some(x=>x.length>Math.min(50,c.aspectMaxLength??50)))return 'Wartość przekracza długość parametru.';
 if(c.aspectDataType==='NUMBER'&&v.some(x=>! /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(x)||!Number.isFinite(Number(x))||(c.aspectFormat==='int32'&&(!/^-?[0-9]+$/.test(x)||Number(x)<-2147483648||Number(x)>2147483647))||(c.aspectFormat!==undefined&&!['int32','double'].includes(c.aspectFormat))))return 'Źródło nie ma formatu liczbowego eBay.';
 if(c.aspectDataType==='DATE'&&v.some(x=>{const f=c.aspectFormat;if(!['YYYY','YYYYMM','YYYYMMDD'].includes(f??''))return true;if(!new RegExp('^[0-9]{'+f!.length+'}$').test(x)||Number(x.slice(0,4))===0)return true;if(f==='YYYY')return false;const month=Number(x.slice(4,6));if(month<1||month>12)return true;if(f==='YYYYMM')return false;const date=new Date(x.slice(0,4)+'-'+x.slice(4,6)+'-'+x.slice(6,8)+'T00:00:00Z');return !Number.isFinite(date.getTime())||date.getUTCDate()!==Number(x.slice(6,8));}))return 'Źródło nie ma formatu daty eBay.';
 for(const x of v){const selected=a.aspectValues?.find(y=>y.localizedValue===x);if(c.aspectMode==='SELECTION_ONLY'&&!selected)return 'Wybierz wartość ze słownika eBay.';
  if(selected?.valueConstraints?.length&&!selected.valueConstraints.some(d=>ownAspectValues(current,d.applicableForLocalizedAspectName).some(y=>d.applicableForLocalizedAspectValues.includes(y))))return 'Najpierw ustaw zależny parametr eBay.';
 }
 if(!Object.hasOwn(current??{},a.localizedAspectName)&&Object.keys(current??{}).length>=50)return 'Oferta ma już 50 parametrów.';
}
export function prefillAspectSources(attributes:unknown,metadata:{aspects:Aspect[]}){
 const aspects:Record<string,string[]>=Object.create(null),issues:string[]=[];
 for(const a of metadata.aspects){const d=attributes&&typeof attributes==='object'?Object.getOwnPropertyDescriptor(attributes,a.localizedAspectName):undefined;if(!d)continue;
  const v='value'in d?values(d.value):undefined;
  if(!v){issues.push(a.localizedAspectName+': wybierz pojedyncze pole z produktu albo wpisz wartość ręcznie.');continue;}
  // First collect unrestricted values so dependency evaluation is independent of metadata order.
  aspects[a.localizedAspectName]=v;
 }
 if(Object.keys(aspects).length>50)return{aspects:Object.create(null) as Record<string,string[]>,issues:[...issues,'Źródło pasuje do ponad 50 parametrów; wybierz parametry ręcznie.']};
 const candidate=Object.fromEntries(Object.entries(aspects));
 for(const a of metadata.aspects){if(!Object.hasOwn(aspects,a.localizedAspectName))continue;const issue=aspectSourceProblem(a,aspects[a.localizedAspectName],candidate);if(issue){delete aspects[a.localizedAspectName];issues.push(a.localizedAspectName+': '+issue);}}
 // Reject dependants when their prerequisite was removed by another constraint.
 let changed=true;while(changed){changed=false;for(const a of metadata.aspects){if(!Object.hasOwn(aspects,a.localizedAspectName))continue;const issue=aspectSourceProblem(a,aspects[a.localizedAspectName],aspects);if(issue){delete aspects[a.localizedAspectName];issues.push(a.localizedAspectName+': '+issue);changed=true;}}}
 return{aspects,issues};
}
/** Paths retain key/index distinction. No eval, getter call, wildcard, object JSON coercion or slicing. */
export function collectAspectSources(attributes:unknown):{fields:AspectSource[];issue?:string}{
 const fields:AspectSource[]=[];let nodes=0;const active=new Set<object>();
 type Step={key:string}|{index:number};
 const walk=(v:unknown,path:Step[],depth:number)=>{
  if(++nodes>100000||depth>16)throw new Error('Drzewo źródła przekracza zakres wyboru.');
  const list=values(v);if(path.length&&list){fields.push({id:JSON.stringify(path),label:'attributes'+path.map(s=>'key'in s?'['+JSON.stringify(s.key)+']':'['+s.index+']').join(''),values:list});if(fields.length>500)throw new Error('Źródło ma ponad 500 pól do wyboru; wpisz parametr ręcznie.');}
  if(!v||typeof v!=='object')return;if(active.has(v))throw new Error('Źródło zawiera cykl.');active.add(v);
  try{for(const [key,d]of Object.entries(Object.getOwnPropertyDescriptors(v))){if(!d.enumerable)continue;if(!('value'in d))throw new Error('Źródło zawiera getter; wpisz parametr ręcznie.');const step:Step=Array.isArray(v)?{index:Number(key)}:{key};if(Array.isArray(v)&&(!Number.isSafeInteger((step as {index:number}).index)||(step as {index:number}).index<0||String((step as {index:number}).index)!==key))throw new Error('Nieprawidłowe pole tablicy.');walk(d.value,[...path,step],depth+1);}}finally{active.delete(v);}
 };
 try{walk(attributes,[],0);return{fields};}catch(e){return{fields:[],issue:(e as Error).message};}
}
