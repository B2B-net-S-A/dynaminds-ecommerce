/** Commercial identity always comes from frozen order_items, never a live catalogue. */
export type CommercialComponent = { product_id:string; quantity:number };
export type CommercialLine = { item_id:string; product_id:string; name:string; sku:string; quantity:number; line_total:number; vat:number; currency:string; components:CommercialComponent[];origin_available?:boolean;issued?:number|null;cancelled?:number|null;pending?:number|null };
export type CommercialParcelItem = Omit<CommercialLine,'quantity'> & { quantity:number; original_quantity:number };
export function deriveCommercialParcelProducts(lines:CommercialLine[], parcels:{items:{item_id:string;quantity:number}[]}[]) {
 const byId=new Map(lines.map(l=>[l.item_id,l]));
 if(byId.size!==lines.length||!lines.length)throw new Error('Niepoprawna tożsamość pozycji');
 const used=new Map<string,number>();
 const result=parcels.map(parcel=>{
  const ids=new Set<string>();const physical=new Map<string,number>();
  const items=parcel.items.map(i=>{
   const line=byId.get(i.item_id);
   if(!line||ids.has(i.item_id)||!Number.isSafeInteger(i.quantity)||i.quantity<1)throw new Error('Niepoprawna pozycja paczki');
   ids.add(i.item_id);used.set(i.item_id,(used.get(i.item_id)??0)+i.quantity);
   if(!Number.isSafeInteger(line.quantity)||line.quantity<1||!line.components.length||new Set(line.components.map(c=>c.product_id)).size!==line.components.length)throw new Error('Niepoprawna historyczna receptura');
   for(const c of line.components){if(!Number.isSafeInteger(c.quantity)||c.quantity<1)throw new Error('Niepoprawna historyczna receptura');const q=(physical.get(c.product_id)??0)+c.quantity*i.quantity;if(!Number.isSafeInteger(q)||q>1000000)throw new Error('Zbyt duża ilość fizyczna');physical.set(c.product_id,q);}
   return {...line,original_quantity:line.quantity,quantity:i.quantity,components:line.components.map(c=>({...c}))};
  });
  return {items,products:[...physical].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([product_id,quantity])=>({product_id,quantity}))};
 });
 if(lines.some(l=>used.get(l.item_id)!==l.quantity))throw new Error('Paczki muszą pokrywać każdą pozycję dokładnie');
 return result;
}
/** At dispatch, split real shared fragments by item UUID then fragment UUID. */
export function mapCommercialIssueFragments(origins:{origin_id:string;item_id:string;quantity:number;components:CommercialComponent[]}[], fragments:{fragment_id:string;product_id:string;quantity:number}[]){
 const left=new Map(fragments.map(f=>[f.fragment_id,f.quantity]));
 if(left.size!==fragments.length||fragments.some(f=>!Number.isSafeInteger(f.quantity)||f.quantity<1))throw new Error('Niepoprawne fragmenty');
 const out:{origin_id:string;fragment_id:string;product_id:string;quantity:number}[]=[];
 for(const o of [...origins].sort((a,b)=>a.item_id<b.item_id?-1:a.item_id>b.item_id?1:0))for(const c of [...o.components].sort((a,b)=>a.product_id<b.product_id?-1:1)){
  let need=o.quantity*c.quantity;
  if(!Number.isSafeInteger(need)||need<1)throw new Error('Niepoprawna ilość originu');
  for(const f of [...fragments].filter(f=>f.product_id===c.product_id).sort((a,b)=>a.fragment_id<b.fragment_id?-1:1)){
   const take=Math.min(need,left.get(f.fragment_id)!);if(take){out.push({origin_id:o.origin_id,fragment_id:f.fragment_id,product_id:c.product_id,quantity:take});left.set(f.fragment_id,left.get(f.fragment_id)!-take);need-=take;}if(!need)break;
  }
  if(need)throw new Error('Fragmenty nie pokrywają pełnej receptury originu');
 }
 if([...left.values()].some(q=>q!==0))throw new Error('Nadmiarowy fragment wydania');
 return out;
}
