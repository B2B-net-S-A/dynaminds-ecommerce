/** Pure public response contract. No application/config/PG/provider imports.
 * Metadata documentation only: native guarded producers remain the authority. */
type Schema=Record<string,unknown>;
const uuid={type:'string',format:'uuid'},stamp={type:'string',format:'date-time'},hash={type:'string',pattern:'^[a-f0-9]{64}$'},text={type:'string'},natural={type:'string',pattern:'^(0|[1-9][0-9]*)$'};
const nullable=(s:Schema)=>({anyOf:[s,{type:'null'}]});
const object=(properties:Record<string,Schema>,required=Object.keys(properties)):Schema=>({type:'object',properties,required,additionalProperties:false});
const index={type:'integer',minimum:1,maximum:1000},year={type:'integer',minimum:2006,maximum:2050},sequence={type:'integer',minimum:1,maximum:999999};
const fiscalBody=(schema:string):Schema=>({type:'object',required:['schema'],properties:{schema:{const:schema}},additionalProperties:true,description:'Pełny immutable snapshot jest zwracany bez obcięcia. Zagnieżdżony kontrakt finansowy pozostaje walidowany przez natywny moduł; ten schemat nie jest pełnym SDK kalkulacji ani źródłem uprawnień.'});
const originalDocument=object({id:uuid,order_id:uuid,kind:{const:'invoice'},mode:{const:'b2b_invoice'},number:text,data:fiscalBody('b2b-local-invoice/v1'),created_at:stamp});
const originalReceipt=object({id:uuid,document_id:uuid,preview_id:uuid,project_id:uuid,project_receipt_id:uuid,client_key:uuid,scope_hash:hash,year,sequence,number:text,issued_at:stamp});
const creditDocument=object({id:uuid,order_id:uuid,return_id:uuid,kind:{const:'correction'},mode:{const:'b2b_correction'},number:text,data:fiscalBody('b2b-local-correction/v1'),created_at:stamp});
export const b2bCreditReceiptResponseSchema=object({id:uuid,document_id:uuid,preview_id:uuid,original_document_id:uuid,original_receipt_id:uuid,return_id:uuid,
 return_receipt_id:{...uuid,description:'UUID rzeczywistego immutable rodzica przyjęcia: physical169 albo financial162 po instalacji certyfikowanego162. Publiczny DTO koalescuje dokładnie jeden typed parent; samo UUID nie dowodzi typu ani PZ. Prywatny financial_return_receipt_id nie jest publikowany.'},
 receipt_sequence:index,previous_receipt_id:nullable(uuid),client_key:uuid,scope_hash:hash,calculation_hash:hash,year,sequence,number:text,issued_at:stamp});
const detail=object({document:creditDocument,receipt:b2bCreditReceiptResponseSchema});
const original=object({document:originalDocument,receipt:originalReceipt});
const acceptedProperties={return_id:uuid,number:text,receipt_sequence:index,received_at:stamp,refund_amount_minor:natural,refunded_shipping_minor:natural,receipt_id:uuid,credited_document_id:nullable(uuid),
 acceptance_kind:{type:'string',enum:['physical','financial_no_restock'],description:'Opcjonalny jawny typ z pełnego certyfikowanego producenta. Stary literalny physical160/161 wire pomija pole; brak nie oznacza financial.162 emituje financial_no_restock wyłącznie dla rzeczywistego immutable162 rodzica. Nie jest ręczną flagą wejściową ani dowodem przelewu.'}};
const accepted=object(acceptedProperties,Object.keys(acceptedProperties).filter(k=>k!=='acceptance_kind'));
export const b2bCreditSourceResponseSchema:Schema={...object({original,accepted_returns:{type:'array',items:accepted,maxItems:1000},previous_credits:{type:'array',items:detail,maxItems:1000},next_return_id:nullable(uuid),eligible:{type:'boolean'},eligibility_reason:{enum:['no_accepted_returns','all_received_returns_credited',null]}}),
 oneOf:[
  {properties:{accepted_returns:{maxItems:0},previous_credits:{maxItems:0},next_return_id:{type:'null'},eligible:{const:false},eligibility_reason:{const:'no_accepted_returns'}}},
  {properties:{accepted_returns:{minItems:1},next_return_id:{type:'null'},eligible:{const:false},eligibility_reason:{const:'all_received_returns_credited'}}},
  {properties:{accepted_returns:{minItems:1},next_return_id:uuid,eligible:{const:true},eligibility_reason:{type:'null'}}},
 ],description:'Dokładne sześć pól publicznego source161. eligible opisuje wyłącznie historyczną możliwość wyboru kolejnego przyjęcia; nie przyznaje roli/scopes, nie zastępuje options.can_preview/can_issue i może być true także w kopii read-only. NULL selected return jest wyłącznie prywatnym native odczytem; POST nadal wymaga UUID.'};
const preview=object({id:uuid,original_document_id:uuid,return_id:uuid,scope_hash:hash,expires_at:stamp,snapshot:fiscalBody('b2b-local-correction/v1'),can_issue:{type:'boolean'}});
const issue=object({document:creditDocument,receipt:b2bCreditReceiptResponseSchema,reused:{type:'boolean'}});
const json=(schema:Schema,description:string)=>({description,content:{'application/json':{schema}},headers:{'Cache-Control':{schema:{const:'no-store'}}}});
export function applyB2bCreditOpenApiContract(document:Record<string,any>,method:string,path:string):void{
 if(!path.startsWith('/b2b-corrections/'))return;
 const writing=method==='POST';document['x-required-scopes']=writing?['documents:read','documents:write','orders:read']:['documents:read','orders:read'];
 document['x-strict-query']=true;document['x-ksef-state']='not_submitted';
 document.description='Lokalna numerowana korekta PL/PLN do rzeczywistej FV159 i pełnej certyfikowanej historii przyjęć. Physical160/161 wymaga immutable169 PZ; financial_no_restock jest dostępne dopiero po certyfikowanym162, bez wymyślonego PZ i bez retrobackfill. Osobna zgoda i immutable receipt. Exchange, partner i szczególne adaptery wymagają odrębnych procesów. Nie jest potwierdzeniem przelewu, bankowego zwrotu, KSeF ani UPO.';
 document.responses??={};
 Object.assign(document.responses,{
  '401':{description:'Bieżąca sesja/klucz wygasły lub zostały cofnięte, również po oczekiwaniu na finalny PIN.'},
  '403':{description:'Brak bieżącej roli lub pełnych wymaganych scopes.'},
  '404':{description:'Oryginał, RMA, preview lub dokument nie należą do własnego widocznego zakresu; nieznany UUID RMA nie ujawnia obcych danych.'},
  '409':{description:'Znane własne RMA nie ma zatwierdzonego przyjęcia; zmiana pełnej historii, kolejności, scope, zgody, klucza próby lub namespace/numeracji. Nieobsługiwany/niekompletny historyczny protokół jest odmową, nie pustą historią.'},
  '413':{description:'Pełny graph/odpowiedź przekracza budżet albo historia ponad1000; brak obcięcia. Pusta historia nie jest przekroczeniem limitu.'},
  '422':{description:'Niepoprawny UUID, parametr/query, zgoda, niekanoniczna treść lub dodatkowe pole. return_id:null w POST nie jest neutralnym odczytem.'},
  '503':{description:'Niepełny/torn native moduł, manifest lub certyfikowany successor157–161/162, brak pełnego typed dowodu.'},
 });
 if(writing)document.responses['423']={description:'Kopia tylko do odczytu — odmowa przed parserem JSON/walidacją body, również /api/v1.'};
 if(method==='GET'&&path==='/b2b-corrections/documents/:id/source')document.responses['200']=json(b2bCreditSourceResponseSchema,'Pełny zweryfikowany oryginał i historia; brak accepted history to200 z eligible=false/no_accepted_returns. Nie tworzy preview ani numeru.');
 else if(path==='/b2b-corrections/previews'||path==='/b2b-corrections/previews/:id'){
  document.responses['200']=json(preview,writing?'Dokładny preview retry: bare preview, bez pola reused.':'Pełny bare preview; read-only zawsze can_issue=false.');
  if(writing)document.responses['201']=json(preview,'Nowy bare preview, bez pola reused; nie jest jeszcze wystawioną korektą.');
 }else if(writing&&path==='/b2b-corrections/previews/:id/issue'){
  document.responses['200']=json(issue,'Dokładne retry: immutable document+receipt oraz reused=true; bez nowego numeru.');
  document.responses['201']=json(issue,'Nowa numerowana korekta: document+receipt oraz reused=false.');
 }else if(method==='GET'&&path==='/b2b-corrections/documents/:id')document.responses['200']=json(detail,'Pełny immutable document+receipt, bez prywatnych danych admission/actor/root.');
 else if(method==='GET'&&path==='/b2b-corrections/documents')document.responses['200']=json(object({documents:{type:'array',maxItems:50,items:creditDocument},next_cursor:nullable(text)}),'Pełne nagłówki strony; kursor związany z aktualnym aktorem/kluczem i limitem1–50.');
 else if(method==='GET'&&path==='/b2b-corrections/documents/:id/print')document.responses['200']={description:'Pełny historyczny HTML ze wszystkimi before/after/delta, VAT i sumami; GET nie dowodzi papierowego wydruku.',content:{'text/html':{schema:{type:'string'}}},headers:{'Cache-Control':{schema:{const:'no-store'}},'Content-Security-Policy':{schema:{type:'string'}}}};
}
