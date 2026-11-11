/** Concrete central public-operation descriptors. No registration/native authority on import. */
import {z} from 'zod';
import {catalogFileImportPreviewInput} from '../../../server/catalog-file-import-schema';
const uuid=z.uuid(),hex=z.string().regex(/^[a-f0-9]{64}$/),yes=z.literal(true),empty=z.strictObject({}),index=z.number().int().min(0).max(99999);
const scope=z.strictObject({scope_hash:hex,confirmed:yes}),previewScope=z.strictObject({preview_id:uuid,scope_hash:hex,confirmed:yes});
const command=z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('prepare'),sourcePlanHash:hex}),z.strictObject({kind:z.literal('revalidate'),scopeHash:hex}),z.strictObject({kind:z.literal('approve'),scopeHash:hex}),z.strictObject({kind:z.literal('execute'),scopeHash:hex,batch:index,previewId:uuid,nativeScope:hex}),z.strictObject({kind:z.literal('retry_durable'),attempt:z.strictObject({id:uuid,batch:index,preview_id:uuid,scope_hash:hex,client_key:uuid})})]);
const {client_key:_clientKey,format:_format,content:_content,...coreConfigShape}=catalogFileImportPreviewInput.shape;
export const largeImportCoreConfig=z.strictObject(coreConfigShape).refine(v=>new Set(Object.values(v.mapping).map(x=>x?.toLowerCase())).size===Object.keys(v.mapping).length,'Powtórzona nazwa źródła w mapowaniu').refine(v=>!v.xml_mapping||Object.keys(v.mapping).length===0,'Mapowany XML wymaga pustego zwykłego mapowania');
const root='/product-catalogs/:catalog_id/large-import';
const descriptor=(method:'GET'|'POST',suffix:string,input?:z.ZodType,query: z.ZodType=empty)=>({method,path:root+suffix,scope:method==='POST'?'products:write':'products:read',input,query,scopes:['products:read','products:write'] as const});
export const largeImportPublicOperations=[
 descriptor('GET','/availability'),descriptor('GET','/uploads/:key'),descriptor('POST','/uploads',undefined,z.strictObject({upload_key:uuid,spec:z.string().max(8192)})),
 descriptor('POST','/jobs',z.strictObject({blob_id:uuid,job_id:uuid,config:largeImportCoreConfig})),
 descriptor('GET','/jobs/:id'),descriptor('GET','/jobs/:id/frames',undefined,z.strictObject({cursor:z.string().regex(/^(0|[1-9][0-9]{0,6})$/),token:z.string().max(2048)})),
 descriptor('GET','/jobs/:id/core/:batch/rows',undefined,z.strictObject({phase:z.enum(['preview','execution']),cursor:z.string().regex(/^[1-9][0-9]{0,2}$/).optional(),token:z.string().max(2048)})),
 descriptor('POST','/jobs/:id/file-consent',z.strictObject({plan_hash:hex,confirmed:yes})),descriptor('POST','/jobs/:id/core-review/refresh',empty),descriptor('POST','/jobs/:id/core-review/consent',scope),
 descriptor('POST','/jobs/:id/finalize',z.strictObject({revision:z.number().int().min(0),plan_hash:hex,pim_batches:z.array(index).max(100000),confirmed:yes})),
 descriptor('POST','/jobs/:id/recover',z.strictObject({command,confirmed:yes})),descriptor('POST','/jobs/:id/core/:batch/preview',empty),descriptor('POST','/jobs/:id/core/:batch/consent',previewScope),descriptor('POST','/jobs/:id/core/:batch/execute',z.strictObject({confirmed:yes})),
 descriptor('POST','/jobs/:id/pim/:batch/attempt',z.strictObject({mapping:z.unknown()})),descriptor('POST','/jobs/:id/pim/:batch/stage',empty),descriptor('POST','/jobs/:id/pim/:batch/preview',empty),descriptor('POST','/jobs/:id/pim/:batch/consent',previewScope),descriptor('POST','/jobs/:id/pim/:batch/apply',z.strictObject({confirmed:yes})),
];
export const LARGE_IMPORT_SAME_PARSER_ALIAS='largeImportSameParserAlias';
export function applyLargeImportOpenApiContract(document:any,method:string,path:string){const d=largeImportPublicOperations.find(x=>x.method===method&&x.path===path);if(!d)return;
 document.description='Duży import własnego katalogu: pełne zachowane źródło, osobna zgoda pliku/CORE/PIM, trwałe dokładne ponowienie. Wymagany certyfikowany moduł i aktualny administrator. Odczyt bez lease wyłącznie z osobnym adapterem SELECT; fallback inspect mutuje lease. Nie zapewnia globalnej atomowości.';
 document['x-required-scopes']=d.scopes;document['x-required-role']='admin';document['x-maximum-response-bytes']=4_194_304;document['x-full-file-native-review-required']=true;
 for(const p of document.parameters??[])if(p.in==='path'&&p.name==='batch')p.schema={type:'integer',minimum:0,maximum:99999};
 const query=z.toJSONSchema(d.query,{io:'input',unrepresentable:'any'});for(const [name,schema]of Object.entries(query.properties??{}))document.parameters.push({in:'query',name,required:query.required?.includes(name)??false,schema});
 if(d.method==='POST'&&d.path.endsWith('/uploads'))document.requestBody={required:true,description:'Dokładne oryginalne bajty CSV do5,000,000 lub XML do30,000,000; Spec w bounded query. Nie JSON/base64.',content:{'application/octet-stream':{schema:{type:'string',format:'binary',maxLength:30_000_000}}}};
 document.responses['413']={description:'Limit pliku/parsy/pełnego rekordu lub odpowiedzi; nie oznacza cofnięcia wcześniej trwale zapisanej fazy.'};document.responses['503']={description:'Brak kompletnego certyfikowanego modułu/portów.'};document.responses['423']={description:d.method==='POST'?'Kopia odczytu: odmowa przed parsowaniem.':'Brak bezpiecznego adaptera odczytu bez lease w kopii odczytu.'};
}
