import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React,{act} from 'react';
import * as jsx from 'react/jsx-runtime';
import {createRoot} from 'react-dom/client';
import {createRequire} from 'node:module';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
import {z} from 'zod';
import {shopifyCompetitorSource} from '../server/competitor-shopify-collector';
const product='ffffffff-ffff-4fff-8fff-ffffffffffff',list='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const source={product_id:product,source_namespace:'shopify:competitors',shop_root:'https://competitor.example/pl/',handle:'coat',remote_product_id:'10',variant_id:'20',currency:'PLN',delivery_gross_minor:'499',gross_prices_confirmed:true,fixed_delivery_confirmed:true};
function component(){const code=transformSync(readFileSync(new URL('../web/competitor-shopify-configuration.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs',jsx:'automatic',target:'es2022'}).code;
 const m={exports:{}};new Function('module','require',code)(m,(k:string)=>({react:React,zod:{z},'react/jsx-runtime':jsx,'./catalog':{ProductPicker:({select,disabled}:any)=>React.createElement('button',{type:'button',disabled,onClick:()=>select({id:product,sku:'TEST',name:'Test product'})},'Test product picker')}}[k]));return m.exports as any;}
const module=component();
test('client configured sources retain exact supported server DTO and consent constraints',()=>{
 assert.deepEqual(module.shopifyUiSource.parse(source),shopifyCompetitorSource.parse(source));
 for(const patch of [{shop_root:'http://competitor.example/'},{shop_root:'https://localhost/'},{shop_root:'https://user:password@competitor.example/'},{shop_root:'https://competitor.example/?token=private'},{remote_product_id:'001'},{variant_id:'1e3'},{gross_prices_confirmed:false},{fixed_delivery_confirmed:false},{currency:'JPY'},{delivery_gross_minor:'100000001'}])assert.throws(()=>module.shopifyUiSource.parse({...source,...patch}));
 assert.throws(()=>module.shopifyUiSources.parse([source,source]));assert.throws(()=>module.shopifyUiSources.parse([]));assert.throws(()=>module.shopifyUiSources.parse(Array(11).fill(source)));
});
test('same cadence DTO keeps independent collection-only and price consent plus current CAS versions',()=>{
 const state={schedule:{version:3,enabled:false,interval_minutes:30,purpose:'repricing'},profileVersion:7,ruleConfigVersion:6,mode:'collection_only',enabled:true,minutes:5,confirmed:true,priceConfirmed:false};
 const body=module.buildShopifyScheduleBody([source],state);assert.deepEqual(body,{version:3,profile_version:7,rule_config_version:6,enabled:true,interval_minutes:5,sources:[source],mode:'collection_only',local_observations_confirmed:true,collection_confirmed:true,price_changes_confirmed:false});
 assert.throws(()=>module.buildShopifyScheduleBody([source],{...state,mode:'collect_then_reprice'}));assert.throws(()=>module.buildShopifyScheduleBody([source],{...state,confirmed:false}));
 assert.equal(module.buildShopifyScheduleBody([source],{...state,mode:'collect_then_reprice',priceConfirmed:true}).price_changes_confirmed,true);
 for(const patch of [{minutes:4},{profileVersion:0},{ruleConfigVersion:0},{schedule:{...state.schedule,version:-1}}])assert.throws(()=>module.buildShopifyScheduleBody([source],{...state,...patch}));
});
async function mount(writable=true,rankEnabled=true){
 const dom=new JSDOM('<div id="root"></div>',{url:'https://local.example/'});
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true});
 const target=dom.window.document.getElementById('root')!,root=createRoot(target),calls:{kind:string;body:any}[]=[];
 const props={scopeKey:'tenant/user/list',writable,namespace:source.source_namespace,currency:'PLN',profileVersion:7,ruleConfigVersion:6,rankEnabled,schedule:{version:3,enabled:false,interval_minutes:30,purpose:'repricing'},onCollect:(body:any)=>calls.push({kind:'collect',body}),onSchedule:(body:any)=>calls.push({kind:'schedule',body})};
 await act(async()=>root.render(React.createElement(module.ShopifyCompetitorConfiguration,props)));
 const button=(text:string)=>[...target.querySelectorAll('button')].find(b=>b.textContent===text)!;
 const click=async(el:HTMLElement)=>act(async()=>el.click());
 const checkbox=(text:string)=>[...target.querySelectorAll('label')].find(l=>l.textContent?.includes(text))!.querySelector('input')!;
 const add=async()=>{await click(button('Test product picker'));for(const [name,value] of Object.entries({shop_root:source.shop_root,handle:source.handle,remote_product_id:source.remote_product_id,variant_id:source.variant_id,delivery_gross_minor:source.delivery_gross_minor}))(target.querySelector(`[name="${name}"]`)as HTMLInputElement).value=value;
  await click(checkbox('ceny sklepu'));await click(checkbox('stały koszt'));await act(async()=>target.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));};
 return{dom,target,root,calls,props,button,click,checkbox,add,close:async()=>{await act(async()=>root.unmount());dom.window.close();}};
}
test('actual React collection form requires assumptions/local consent, collects exact public source only once',async()=>{
 const t=await mount();try{assert.equal(t.button('Pobierz ceny i zapisz obserwacje').disabled,true);await t.add();assert.equal(t.target.querySelectorAll('li').length,1);assert.equal(t.calls.length,0);await t.click(t.checkbox('odczyt skonfigurowanych'));await t.click(t.button('Pobierz ceny i zapisz obserwacje'));assert.deepEqual(t.calls,[{kind:'collect',body:[source]}]);assert.match(t.target.textContent!,/nie zweryfikowana tożsamość marketplace/);}finally{await t.close();}
});
test('actual React cadence collection-only never invents price consent; field changes clear consent',async()=>{
 const t=await mount();try{await t.add();await t.click(t.checkbox('odczyt skonfigurowanych'));await t.click(t.button('Zapisz harmonogram zbierania'));assert.equal(t.calls[0].body.mode,'collection_only');assert.equal(t.calls[0].body.price_changes_confirmed,false);assert.equal(t.calls[0].body.profile_version,7);assert.equal(t.calls[0].body.rule_config_version,6);await t.click(t.checkbox('Włącz cykliczne'));assert.equal(t.checkbox('odczyt skonfigurowanych').checked,false);assert.equal(t.button('Zapisz harmonogram zbierania').disabled,true);}finally{await t.close();}
});
test('actual React collect-then-reprice requires separate price consent and available ranking strategy',async()=>{
 const t=await mount();try{await t.add();const select=t.target.querySelector('select')!;await act(async()=>{select.value='collect_then_reprice';select.dispatchEvent(new t.dom.window.Event('change',{bubbles:true}));});await t.click(t.checkbox('odczyt skonfigurowanych'));assert.equal(t.button('Zapisz harmonogram zbierania').disabled,true);await t.click(t.checkbox('automatyczne lokalne'));await t.click(t.button('Zapisz harmonogram zbierania'));assert.equal(t.calls[0].body.mode,'collect_then_reprice');assert.equal(t.calls[0].body.price_changes_confirmed,true);}finally{await t.close();}
 const noRank=await mount(true,false);try{assert.equal(noRank.target.querySelector('option[value="collect_then_reprice"]')!.hasAttribute('disabled'),true);}finally{await noRank.close();}
});
test('actual React readonly disables writes and keyed tenant replacement purges source details',async()=>{
 const t=await mount();try{await t.add();await act(async()=>t.root.render(React.createElement(module.ShopifyCompetitorConfiguration,{...t.props,writable:false})));assert.equal(t.button('Pobierz ceny i zapisz obserwacje').disabled,true);await t.click(t.button('Pobierz ceny i zapisz obserwacje'));assert.equal(t.calls.length,0);await act(async()=>t.root.render(React.createElement(module.ShopifyCompetitorConfiguration,{...t.props,key:'foreign-tenant',scopeKey:'foreign-tenant/user/list'})));assert.equal(t.target.querySelectorAll('li').length,0);assert.doesNotMatch(t.target.textContent!,/competitor\.example\/pl\//);}finally{await t.close();}
});
test('actual parent preserves current auth/custody path and uncertain collector/schedule never retries POST',()=>{
 const source=readFileSync(new URL('../web/competitor-observations.tsx',import.meta.url),'utf8');
 assert(source.includes("await access(g, true);"));assert(source.includes("attempts.set(key, p);"));assert(source.includes("pending.kind==='shopify_batch'||pending.kind==='shopify_schedule' ? load(g)"));assert(source.includes("setCollectionState(null)"));assert(source.includes("key={key+':'+b.profile.version+':'+collectionState.ruleConfigVersion+':'+collectionState.schedule.version}"));
 assert(source.includes("root+'/collect/shopify'"));assert(source.includes("root+'/collection-schedule'"));assert(source.includes("exact(outer.batch,['batch','profile','rule_version','reused'])"));assert(source.includes("cfg.actor_id===context.user_id"));assert(source.includes('Odczyt stanu nie zwalnia blokady'));assert.equal(list.length,36);
});
test('actual React restores saved sources/mode without restoring any action consent; edits require renewed assumptions',async()=>{
 const t=await mount();try{await act(async()=>t.root.render(React.createElement(module.ShopifyCompetitorConfiguration,{...t.props,key:'saved-profile',initial:{profile_config_version:2,sources:[source],mode:'collect_then_reprice',local_observations_confirmed:true,collection_confirmed:true,price_changes_confirmed:true}})));assert.equal(t.target.querySelectorAll('li').length,1);assert.equal(t.target.querySelector('select')!.value,'collect_then_reprice');assert.equal(t.checkbox('odczyt skonfigurowanych').checked,false);assert.equal(t.checkbox('automatyczne lokalne').checked,false);assert.equal(t.button('Zapisz harmonogram zbierania').disabled,true);
 await t.click(t.checkbox('ceny sklepu'));await t.click(t.checkbox('stały koszt'));await act(async()=>{const input=t.target.querySelector('[name="shop_root"]')!;input.dispatchEvent(new t.dom.window.Event('input',{bubbles:true}));});assert.equal(t.checkbox('ceny sklepu').checked,false);assert.equal(t.checkbox('stały koszt').checked,false);}finally{await t.close();}
});
function parentFunction(name:string,end:string,definitions:string){const s=readFileSync(new URL('../web/competitor-observations.tsx',import.meta.url),'utf8'),start=s.indexOf('  async function '+name+'('),finish=s.indexOf(end,start);assert(start>0&&finish>start);const code=transformSync(definitions+'\n'+s.slice(start,finish)+'\nmodule.exports='+name+';',{loader:'ts',format:'cjs',target:'es2022'}).code;const m={exports:{}};return {code,m};}
test('actual parent write function preserves UNKNOWN custody, exact endpoint and single dispatch, releases known denial only',async()=>{
 const definitions=`const key='scope',listId='${list}',context={user_id:'actor',restore_preview:false},revision={current:1},live={current:{externalWriteBlocked:false,rankEnabled:true}},attempts=env.attempts,check=()=>{},access=async()=>({available:true,can_read:true}),need=(v,m)=>{if(!v)throw Error(m)},notify=()=>{},api=env.api,ApiError=env.ApiError;const profile=v=>v,batch=v=>v,pricePreview=v=>v,exact=v=>v,object=v=>v,positive=v=>Number.isInteger(v)&&v>0,same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),basis={profile:{version:7}},clearReview=()=>{},setProfileConsent=()=>{},load=async()=>{},setSaved=()=>{},setPrice=()=>{},setPriceConsent=()=>{},callbacks={current:{onApplied:()=>{}}};`;
 for(const status of [500,423]){let dispatched=0;const env={attempts:new Map(),api:async()=>{dispatched++;throw Object.assign(new Error('refusal'),{status});},ApiError:Error};const {code,m}=parentFunction('mutate','  async function inspectProfile',definitions);new Function('module','env',code)(m,env);const p={context:'scope',listId:list,path:'/price-lists/'+list+'/competitor-observations/collect/shopify',method:'POST',kind:'shopify_batch',body:JSON.stringify({client_key:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',profile_version:7,sources:[source],local_observations_confirmed:true})};await assert.rejects(()=> (m.exports as any)(p,0));assert.equal(dispatched,1);assert.equal(env.attempts.has('scope'),status===500);}
});
test('actual parent current-auth task purges displayed source state on 401/403 without dropping unknown intent map',async()=>{
 for(const status of [401,403]){let purged=0;const definitions=`const epoch={current:0},flight={current:null},alive={current:true},key='scope',live={current:{key}},setBusy=()=>{},setError=()=>{},purge=()=>env.purge(),ApiError=Error;`;
 const {code,m}=parentFunction('task','  useEffect(() => {',definitions);new Function('module','env',code)(m,{purge:()=>{purged++;}});await(m.exports as any)(async()=>{throw Object.assign(new Error('denied'),{status});});assert.equal(purged,1);}
});
