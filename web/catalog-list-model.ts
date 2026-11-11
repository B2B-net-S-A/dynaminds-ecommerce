export type CatalogSelection = Record<string, {id:string;version:number;sku:string}>;
export type CatalogListRow = {
  id:string;version:number;sku:string;name:string;catalog_id?:string|null;
  kind:'simple'|'group'|'variant'|'bundle';images:string[];price:number;
  available:number;reserved:number;active:boolean;category:string;ean:string|null;
};
export type CatalogListPage = {data:CatalogListRow[];meta:{has_more:boolean;cursor:string|null}};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
export function catalogListQuery(input:{search:string;catalogId:string;warehouseId:string;page:string}):string{
  const q=new URLSearchParams({limit:'50',search:input.search});
  for(const [key,value] of [['catalog_id',input.catalogId],['warehouse_id',input.warehouseId],['after',input.page]]){
    if(value){if(!uuid(value))throw Error('Nieprawidłowy zakres listy produktów.');q.set(key,value);}
  }
  return '/products?'+q;
}
export function readCatalogList(value:unknown,catalogId:string,page:string):CatalogListPage{
  const v=value as CatalogListPage,ids=new Set<string>();
  if(!v||!Array.isArray(v.data)||v.data.length>50||!v.meta||typeof v.meta.has_more!=='boolean'||
    (v.meta.cursor!==null&&!uuid(v.meta.cursor))||v.meta.has_more!==(v.meta.cursor!==null)||
    (v.meta.has_more&&v.meta.cursor===page))throw Error('Niepełny odczyt strony produktów. Odczytaj listę ponownie.');
  for(const row of v.data){
    if(!row||!uuid(row.id)||ids.has(row.id)||!Number.isSafeInteger(row.version)||row.version<1||
      typeof row.sku!=='string'||!row.sku||typeof row.name!=='string'||typeof row.active!=='boolean'||
      !['simple','group','variant','bundle'].includes(row.kind)||!Array.isArray(row.images)||!row.images.every(x=>typeof x==='string')||
      !Number.isSafeInteger(row.price)||row.price<0||!Number.isSafeInteger(row.available)||!Number.isSafeInteger(row.reserved)||
      (catalogId&&row.catalog_id!==catalogId))throw Error('Strona produktów nie odpowiada wybranemu katalogowi lub zawiera niepełne pozycje.');
    ids.add(row.id);
  }
  if(v.meta.has_more&&v.data.at(-1)?.id!==v.meta.cursor)throw Error('Niezgodny kursor listy produktów.');
  return v;
}
export function readCatalogWarehouses(value:unknown):{id:string;name:string}[]{
  const rows=(value as {data?:unknown})?.data;
  if(!Array.isArray(rows)||rows.length>1000)throw Error('Niepełna lista magazynów.');
  const seen=new Set<string>();
  return rows.map(row=>{
    if(!row||!uuid(row.id)||seen.has(row.id)||typeof row.name!=='string'||!row.name)throw Error('Nieprawidłowy magazyn na liście.');
    seen.add(row.id);return{id:row.id,name:row.name};
  });
}
/** A page selection is atomic: never silently select only the first rows up to the limit. */
export function toggleCatalogPage(selection:CatalogSelection,rows:readonly Pick<CatalogListRow,'id'|'sku'|'version'>[],checked:boolean):CatalogSelection{
  const next={...selection};
  for(const row of rows){
    if(!uuid(row.id)||!Number.isSafeInteger(row.version)||row.version<1||typeof row.sku!=='string')throw Error('Niepełna tożsamość zaznaczonego produktu.');
    if(checked)next[row.id]={id:row.id,version:row.version,sku:row.sku};else delete next[row.id];
  }
  if(Object.keys(next).length>500)throw Error('Wybór przekroczyłby 500 produktów. Nie dodano żadnej pozycji z tej strony; zmniejsz wybór.');
  return next;
}
export function catalogSelectionSummary(selection:CatalogSelection,rows:readonly {id:string}[]){
  const total=Object.keys(selection).length,visible=rows.filter(p=>Object.hasOwn(selection,p.id)).length;
  return{total,visible,otherPages:total-visible};
}
export type ProductDeletion = {id:string;sku:string;deleted:true;deleted_at:string};
/** Body of POST /products/:id/deletion; an empty reason is omitted, never sent as blank text. */
export function productDeletionBody(version:number,reason:string):{version:number;reason?:string}{
  if(!Number.isSafeInteger(version)||version<1)throw Error('Brak wersji produktu. Odśwież kartę.');
  const text=reason.trim();
  if(text.length>500)throw Error('Powód usunięcia może mieć najwyżej 500 znaków.');
  return text?{version,reason:text}:{version};
}
export function readProductDeletion(value:unknown,id:string):ProductDeletion{
  const v=value as ProductDeletion;
  if(!v||v.id!==id||v.deleted!==true||typeof v.sku!=='string'||!v.sku||typeof v.deleted_at!=='string'||!v.deleted_at)
    throw Error('Niepełne potwierdzenie usunięcia produktu. Odśwież listę.');
  return v;
}
