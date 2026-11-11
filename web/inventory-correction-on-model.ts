/** Browser-only manual ON correction request validation. No server/runtime imports. */
export type CorrectionPosition={warehouse_id:string;product_id:string;location:string;layer_id:string;available:number};
export type CorrectionScope={currency:string|null;exponent:number;positions:CorrectionPosition[]};
export type CorrectionRequest={client_key:string;policy_version:string;kind:'adjustment';product_id:string;warehouse_id:string;location:string;quantity:number;stock_versions:{warehouse_id:string;product_id:string;version:string}[];note:string;layer_ids?:string[];unit_cost_minor?:string;currency?:'PLN'|'EUR'|'USD'|'GBP'|'CZK';lot_code?:string};
const maximum=9223372036854775807n;
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Niepełny zakres korekty. Odczytaj dane ponownie.');return v as Record<string,unknown>;};
const uuid=(v:unknown):string=>{if(typeof v!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v))throw Error('Brak rzeczywistej tożsamości produktu, magazynu lub warstwy.');return v;};
const decimal=(v:unknown,positive=false):string=>{if(typeof v!=='string'||! /^(0|[1-9][0-9]{0,18})$/.test(v)||BigInt(v)>maximum||(positive&&BigInt(v)===0n))throw Error('Wersja lub kwota wymaga dokładnej kanonicznej liczby.');return v;};
function text(v:unknown,min:number,max:number,label:string,controls=false){if(typeof v!=='string'||v.trim().length<min||v.trim().length>max||v.includes('\0')||(controls&&/[\u0000-\u001f\u007f]/.test(v)))throw Error(label);return v.trim();}
/** Uses native-read stock_versions and explicitly selected real layers; never invents a cost. */
export function inventoryCorrectionRequest(raw:unknown,scope:CorrectionScope):CorrectionRequest{
 const b=object(raw),allowed=['client_key','policy_version','kind','product_id','warehouse_id','location','quantity','stock_versions','note','layer_ids','unit_cost_minor','currency','lot_code'];
 if(Object.keys(b).some(k=>!allowed.includes(k))||b.kind!=='adjustment')throw Error('Korekta ON wymaga własnego protokołu adjustment.');
 if(!['PLN','EUR','USD','GBP','CZK'].includes(scope.currency??'')||!Number.isSafeInteger(scope.exponent)||scope.exponent<0||scope.exponent>6)throw Error('Odczytaj obsługiwaną walutę i precyzję polityki. Formularz nie przelicza walut.');
 if(typeof b.quantity!=='number'||!Number.isSafeInteger(b.quantity)||b.quantity===0||Math.abs(b.quantity)>1000000)throw Error('Podaj niezerową całkowitą zmianę od -1000000 do +1000000 sztuk.');
 const product_id=uuid(b.product_id),warehouse_id=uuid(b.warehouse_id),location=text(b.location,1,80,'Podaj lokalizację korekty.',true);
 if(!Array.isArray(b.stock_versions))throw Error('Korekta wymaga odczytanych wersji stanu.');
 const matches=b.stock_versions.map(object).filter(v=>v.product_id===product_id&&v.warehouse_id===warehouse_id);
 if(matches.length!==1)throw Error('Brak jednej dokładnej wersji wybranego produktu i magazynu. Odczytaj stan ponownie.');
 const v=matches[0];
 if(Object.keys(v).sort().join(',')!=='product_id,version,warehouse_id'||v.product_id!==product_id||v.warehouse_id!==warehouse_id)throw Error('Wersja stanu dotyczy innego produktu lub magazynu.');
 const request:CorrectionRequest={client_key:uuid(b.client_key),policy_version:decimal(b.policy_version,true),kind:'adjustment',product_id,warehouse_id,location,quantity:b.quantity,stock_versions:[{warehouse_id,product_id,version:decimal(v.version)}],note:text(b.note,3,1000,'Podaj uzasadnienie korekty (3–1000 znaków).')};
 if(b.quantity>0){
  if(b.layer_ids!==undefined||b.currency!==scope.currency)throw Error('Przyrost tworzy nową partię i wymaga kosztu w walucie odczytanej polityki, bez FX.');
  request.unit_cost_minor=decimal(b.unit_cost_minor);request.currency=b.currency as CorrectionRequest['currency'];request.lot_code=text(b.lot_code,1,100,'Podaj kod nowej partii.');
 }else{
  if(b.unit_cost_minor!==undefined||b.currency!==undefined||b.lot_code!==undefined)throw Error('Ubytek zachowuje rzeczywisty koszt i partię warstw.');
  if(!Array.isArray(b.layer_ids)||b.layer_ids.length===0||b.layer_ids.length>10000)throw Error('Zaznacz rzeczywiste wolne warstwy.');
  const layer_ids=b.layer_ids.map(uuid);if(new Set(layer_ids).size!==layer_ids.length)throw Error('Warstwa została wybrana więcej niż raz.');
  let available=0n;
  for(const id of layer_ids){const matches=scope.positions.filter(p=>p.layer_id===id&&p.warehouse_id===warehouse_id&&p.product_id===product_id&&p.location===location);if(matches.length!==1||!Number.isSafeInteger(matches[0].available)||matches[0].available<=0)throw Error('Wybrana warstwa nie jest rzeczywistym wolnym zapasem tej lokalizacji.');available+=BigInt(matches[0].available);}
  if(available<BigInt(-b.quantity))throw Error('Wybrane warstwy nie pokrywają całego ubytku. Nie używaj zarezerwowanych sztuk.');
  request.layer_ids=[...layer_ids].sort();
 }
 return request;
}
export function inventoryCorrectionApply(id:string,scopeHash:string,clientKey:string,confirmed:boolean){
 if(!confirmed||! /^[a-f0-9]{64}$/.test(scopeHash))throw Error('Potwierdź osobno cały zamrożony podgląd korekty.');
 return{protocol:'wms_adjustment090' as const,preview_id:uuid(id),client_key:uuid(clientKey),scope_hash:scopeHash,confirmed:true as const};
}
/** Marker comes from the native correction adapter, never from the sign alone. */
export function inventoryCorrectionDocumentLabel(raw:unknown):string|null{
 const b=object(raw);if(b.correction_protocol===undefined&&b.document_protocol===undefined)return null;
 const operation=object(b.operation);
 if(b.correction_protocol!=='wms_adjustment090'||operation.kind!=='adjustment')throw Error('Niezgodny zapisany protokół korekty.');
 uuid(operation.id);uuid(operation.warehouse_document_id);
 if(b.document_protocol==='native_wms090'&&b.correction_document===null)return 'Dokument przyjęcia/wydania magazynowego';
 if(b.document_protocol==='strict152_pw_rw'){
  const d=object(b.correction_document);if(d.protocol==='wms_adjustment'&&d.operation_id===operation.id&&d.warehouse_document_id===operation.warehouse_document_id&&['PW','RW'].includes(String(d.kind))&&typeof d.number==='string'&&d.number.length>0)return 'Korekta '+d.kind+' · '+d.number;
 }
 throw Error('Nie można potwierdzić rodzaju zapisanego dokumentu korekty. Otwórz natywną historię.');
}
