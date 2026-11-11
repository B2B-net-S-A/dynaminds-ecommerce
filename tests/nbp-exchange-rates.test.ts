import assert from 'node:assert/strict';
import test from 'node:test';
import {readLatestNbpTableARate,nbpLatestTableAReadPolicy,NbpExchangeRateError,type NbpLatestRateInput} from '../server/nbp-exchange-rates';
const now=new Date('2026-10-14T12:00:00Z');
const raw=(mid='4.2573',extra:Record<string,unknown>={})=>JSON.stringify({table:'A',currency:'euro',code:'EUR',rates:[{no:'198/A/NBP/2026',effectiveDate:'2026-10-13',mid:'__RATE__'}],...extra}).replace('"__RATE__"',mid);
function model(body=raw(),status=200,contentType='application/json'){
 const calls:Array<{url:string;init:RequestInit}>=[];const transport=async(url:string,init:RequestInit)=>{calls.push({url,init});return new Response(body,{status,headers:{'content-type':contentType}});};return{calls,transport};
}
const input=(transport:NbpLatestRateInput['transport']):NbpLatestRateInput=>({currency:'EUR',mode:'public_read_only',maxAgeDays:7,observedAt:now,transport});
const error=(code:string)=>(e:unknown)=>{assert(e instanceof NbpExchangeRateError);assert.equal(e.code,code);assert.equal(e.message,'NBP exchange rate: '+code);assert(!('cause'in e));return true;};

test('one exact public GET, table/code/date and exact decimal strings; no credentials/body',async()=>{
 const m=model(),rate=await readLatestNbpTableARate(input(m.transport));assert.equal(m.calls.length,1);assert.equal(m.calls[0]!.url,'https://api.nbp.pl/api/exchangerates/rates/a/eur/?format=json');assert.equal(m.calls[0]!.init.method,'GET');assert.equal(m.calls[0]!.init.body,undefined);assert.equal(new Headers(m.calls[0]!.init.headers).has('Authorization'),false);assert.equal(new Headers(m.calls[0]!.init.headers).get('Accept'),'application/json');
 assert.equal(rate.table,'A');assert.equal(rate.table_number,'198/A/NBP/2026');assert.equal(rate.currency_code,'EUR');assert.equal(rate.currency_name,'euro');assert.equal(rate.mid_decimal,'4.2573');assert.equal(rate.mid_scaled,'42573');assert.equal(rate.source_decimal,'4.2573');assert.equal(rate.publication_date,'2026-10-13');assert.equal(rate.effective_date,rate.publication_date);assert.equal(rate.source_age_days,1);assert(Object.isFrozen(rate));
 assert.deepEqual(nbpLatestTableAReadPolicy('USD'),{routes:[{origin:'https://api.nbp.pl',path:'/api/exchangerates/rates/a/usd/',methods:['GET'],queryKeys:['format']}]});
});
test('exact source decimal and dynamic scale up to8dp survive without float math or rounding',async()=>{
 for(const [token,decimal,scaled]of [['0.0100','0.0100','100'],['123.4','123.4','1234'],['10','10','10'],['1.2345','1.2345','12345'],['0.00001234','0.00001234','1234'],['9007199254740993.12345678','9007199254740993.12345678','900719925474099312345678']]){const m=model(raw(token));const q=await readLatestNbpTableARate(input(m.transport));assert.equal(q.source_decimal,token);assert.equal(q.mid_decimal,decimal);assert.equal(q.mid_scaled,scaled);assert.equal(q.scale,(token.split('.')[1]??'').length);}
 for(const token of ['0','-1','1.234567891','1e-4','1000000000000000000'])await assert.rejects(readLatestNbpTableARate(input(model(raw(token)).transport)),error('RATE_PRECISION'));
});
test('explicit read mode, currency shape and freshness policy refuse before dispatch',async()=>{
 const m=model();for(const change of [{mode:'write'},...['eur','EURX','E/R',''].map(currency=>({currency})),{maxAgeDays:-1},{maxAgeDays:32},{maxAgeDays:NaN},{observedAt:new Date(NaN)}])await assert.rejects(readLatestNbpTableARate({...input(m.transport),...change} as NbpLatestRateInput),error('REQUEST'));assert.equal(m.calls.length,0);
});
test('strict response identity/shape and duplicate or escaped keys reject; numeric-looking label is not a rate',async()=>{
 const bad=[raw('4.2',{code:'USD'}),raw('4.2',{table:'B'}),raw('4.2',{extra:1}),raw().replace('"mid":4.2573','"mid":"4.2573"'),raw().replace('2026-10-13','2026-02-30'),raw().replace('198/A/NBP/2026','198/A/NBP/2025'),raw().replace('"code":"EUR"','"code":"USD","code":"EUR"'),raw().replace('"mid":4.2573','"mid":1,"mi\\u0064":4.2573'),'{}','{broken'];
 for(const body of bad)await assert.rejects(readLatestNbpTableARate(input(model(body).transport)),error('RESPONSE_SCHEMA'));
 const body=raw('1.25',{currency:'label 999.9 "mid":123'});const rate=await readLatestNbpTableARate(input(model(body).transport));assert.equal(rate.mid_scaled,'125');
});
test('publication freshness is explicit, includes weekends, and never accepts future publication',async()=>{
 const friday=raw().replace('2026-10-13','2026-10-09');const q=await readLatestNbpTableARate(input(model(friday).transport));assert.equal(q.source_age_days,5);
 await assert.rejects(readLatestNbpTableARate({...input(model().transport),maxAgeDays:0}),error('SOURCE_EXPIRED'));
 await assert.rejects(readLatestNbpTableARate(input(model(raw().replace('2026-10-13','2026-10-15')).transport)),error('FUTURE_PUBLICATION'));
});
test('404/429/500 and transport exceptions are fixed safe errors, one call and never retry',async()=>{
 for(const [status,c]of [[404,'NOT_AVAILABLE'],[429,'RATE_LIMITED'],[500,'HTTP']]as const){const m=model('private upstream body',status);await assert.rejects(readLatestNbpTableARate(input(m.transport)),error(c));assert.equal(m.calls.length,1);}
 let calls=0;await assert.rejects(readLatestNbpTableARate(input(async()=>{calls++;throw Error('Bearer private https://host/?token=secret');})),error('TRANSPORT'));assert.equal(calls,1);
});
test('bounded body and JSON media type reject; caller abort signal is passed through',async()=>{
 await assert.rejects(readLatestNbpTableARate(input(model('x'.repeat(32769)).transport)),error('RESPONSE_LIMIT'));
 await assert.rejects(readLatestNbpTableARate(input(model(raw(),200,'text/html').transport)),error('RESPONSE_SCHEMA'));
 const m=model(),controller=new AbortController();await readLatestNbpTableARate({...input(m.transport),signal:controller.signal});assert.equal(m.calls[0]!.init.signal,controller.signal);
});


test('hostile JSON shape and escaped duplicates cannot hide a replacement quote',async()=>{
 const bodies=[
  raw().replace('"table":"A"','"table":"B","ta\\u0062le":"A"'),
  raw().replace('"no":"198/A/NBP/2026"','"no":"197/A/NBP/2026","n\\u006f":"198/A/NBP/2026"'),
  raw().replace('"rates":[{','"rates":[{}, {'),
  raw().replace('"currency":"euro"','"currency":{"mid":4.2573}'),
  raw().replace('2026-10-13','2026-04-31'),
  raw().replace('2026-10-13','2025-02-29'),
  raw().replace('"mid":4.2573','"mid":null')
 ];
 for(const body of bodies)await assert.rejects(readLatestNbpTableARate(input(model(body).transport)),error('RESPONSE_SCHEMA'));
 const special=raw('0.00000001',{currency:'euro \\ "mid":999.9 ta\\u0062le 😀'});
 const rate=await readLatestNbpTableARate(input(model(special).transport));assert.equal(rate.mid_scaled,'1');assert.equal(rate.scale,8);
});
test('32KiB is an exact decoded byte boundary across chunks, not a character count',async()=>{
 const base=raw('4.3806',{currency:'euro €'}),size=Buffer.byteLength(base),exact=base+' '.repeat(32768-size);
 const encoder=new TextEncoder();
 const transportFor=(text:string)=>async()=>new Response(new ReadableStream<Uint8Array>({start(controller){const bytes=encoder.encode(text);for(let i=0;i<bytes.length;i+=17)controller.enqueue(bytes.slice(i,i+17));controller.close();}}),{headers:{'content-type':'application/json'}});
 const rate=await readLatestNbpTableARate(input(transportFor(exact)));assert.equal(rate.mid_scaled,'43806');
 await assert.rejects(readLatestNbpTableARate(input(transportFor(exact+' '))),error('RESPONSE_LIMIT'));
 const invalid=Uint8Array.from([...encoder.encode(base.slice(0,-1)),255,125]);
 await assert.rejects(readLatestNbpTableARate(input(async()=>new Response(invalid,{headers:{'content-type':'application/json'}}))),error('RESPONSE_SCHEMA'));
});
test('unavailable or failed response reader remains sanitized and never steals an existing lock',async()=>{
 const response=new Response(raw(),{headers:{'content-type':'application/json'}}),owner=response.body!.getReader();let calls=0;
 try{await assert.rejects(readLatestNbpTableARate(input(async()=>{calls++;return response;})),error('RESPONSE_SCHEMA'));assert.equal(calls,1);assert(response.body!.locked);const first=await owner.read();assert.equal(new TextDecoder().decode(first.value),raw());}finally{await owner.cancel();}
 const responseWithError=new Response(new ReadableStream<Uint8Array>({pull(controller){controller.error(Error('private upstream stack/token'));}}),{headers:{'content-type':'application/json'}});
 await assert.rejects(readLatestNbpTableARate(input(async()=>responseWithError)),error('RESPONSE_SCHEMA'));
});
