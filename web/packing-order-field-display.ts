import type {OrderFieldSet} from '../server/order-fields-schema';
// A view of the existing role-filtered GET. This module neither grants access nor writes fields.
type FieldType=OrderFieldSet['type'];
type Option={id:string;label:string};
export type PackingFieldRow={definition:{id:string;label:string;type:FieldType;enabled:boolean;display:'always'|'edit_only';read_role:'team'|'admin';options:Option[]};value:{type:FieldType;value:string|string[];options_snapshot?:Option[];file?:{filename:string;byte_count:number}|null}|null};
export type PackingOrderFieldDetail={available:boolean;read_only:boolean;current_role:string;order_id:string;order_version:number;data:PackingFieldRow[]};
export type PackingFieldDisplay={id:string;label:string;text:string;unset:boolean};
export function packingFieldRows(detail:PackingOrderFieldDetail,orderId:string):PackingFieldDisplay[]{
 if(!detail.available)return[];
 if(detail.order_id!==orderId||!['admin','operator','viewer'].includes(detail.current_role)||!Array.isArray(detail.data))throw Error('Nie można powiązać pól z bieżącym zamówieniem.');
 const rows=detail.data.filter(x=>x.definition.enabled&&x.definition.display==='always'&&(x.definition.read_role==='team'||detail.current_role==='admin'));
 if(rows.length>100||new Set(rows.map(x=>x.definition.id)).size!==rows.length)throw Error('Nieprawidłowy zakres aktywnych pól zamówienia.');
 return rows.map(({definition:d,value:v})=>{
  if(typeof d.id!=='string'||typeof d.label!=='string'||d.label.length>240)throw Error('Nieprawidłowa definicja pola.');
  if(v===null)return{id:d.id,label:d.label,text:'Nieuzupełnione',unset:true};
  if(v.type!==d.type)throw Error('Typ wartości pola nie zgadza się z definicją.');
  let text:string;
  const choice=(id:string)=>{const o=(v.options_snapshot??[]).find(o=>o.id===id)??d.options.find(o=>o.id===id);if(!o||typeof o.label!=='string')throw Error('Nie można odczytać zapisanej opcji pola.');return o.label;};
  if(d.type==='multi_select'){if(!Array.isArray(v.value)||v.value.length>50||!v.value.every(x=>typeof x==='string'))throw Error('Nieprawidłowa lista wartości.');text=v.value.length?v.value.map(choice).join(', '):'Brak wybranych opcji';}
  else if(d.type==='file'){if(!v.file||typeof v.file.filename!=='string'||!Number.isSafeInteger(v.file.byte_count)||v.file.byte_count<0)throw Error('Nie można odczytać informacji o pliku.');text='Plik prywatny: '+v.file.filename+' ('+v.file.byte_count+' B)';}
  else{if(typeof v.value!=='string'||v.value.length>8000)throw Error('Nieprawidłowa wartość pola.');text=['select','radio'].includes(d.type)?choice(v.value):v.value;}
  return{id:d.id,label:d.label,text,unset:false};
 });
}
