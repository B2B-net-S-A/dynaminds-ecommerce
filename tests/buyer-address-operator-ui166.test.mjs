// Actual React component; synthetic native transport only. No app/db/provider imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const owner = { tenant_id: '11111111-1111-4111-8111-111111111111', id: '22222222-2222-4222-8222-222222222222', role: 'admin' };
const orderId = '33333333-3333-4333-8333-333333333333';
const delivery = { recipient_name: 'Łucja Żółć', street: 'Nowa 5', city: 'Łódź', postal_code: '90-001', country: 'PL', phone: '+48123456789' };
const descriptor = extra => ({ available:true,read_only:false,can_manage:true,order_version:'4',policy_version:'0',enabled:false,delivery_kind:'unknown',classification_origin:'unknown',delivery_version:'0',effective_delivery:null,reason:'delivery_kind_unknown',last_change:null,...extra });
const receipt = extra => ({ ...descriptor({policy_version:'1',enabled:true,delivery_kind:'address',classification_origin:'operator_confirmed',effective_delivery:delivery,reason:null}),changed:true,receipt_id:'44444444-4444-4444-8444-444444444444',...extra });
const entry = n => ({id:`${String(n).padStart(8,'0')}-5555-4555-8555-555555555555`,kind:'delivery',changed:true,created_at:'2026-10-08T12:00:00Z',before:delivery,after:{...delivery,street:'Zmiana '+n},before_policy:{enabled:true,delivery_kind:'address',classification_origin:'adapter'},after_policy:{enabled:true,delivery_kind:'address',classification_origin:'adapter'}});
test('actual buyer address operator controlled flow', async t => {
  const dom = new JSDOM('<body></body>', { url:'http://operator-controlled.localhost' });
  const saved = new Map(); let vite, root, box, ui, net = 0;
  for (const [k,v] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true,fetch:async()=>{net++;throw Error('Unexpected native fetch');}})) {
    saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,writable:true,configurable:true});
  }
  const flush = () => act(async()=>{await new Promise(r=>setImmediate(r));});
  const until = async f => {for(let i=0;i<100;i++){if(f())return;await flush();}assert(f(),'Controlled UI failed to settle');};
  let props, calls, reply, actual, changed, held;
  const button = text => {const b=[...box.querySelectorAll('button')].find(b=>b.textContent===text);assert(b,text);return b;};
  const click = async b => {assert(!b.disabled,'Button enabled');await act(async()=>b.dispatchEvent(new MouseEvent('click',{bubbles:true})));await flush();};
  const check = async text => {const l=[...box.querySelectorAll('label')].find(l=>l.textContent===text);assert(l,text);await click(l.querySelector('input'));};
  const choose = async value => {const el=box.querySelector('select');await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('change',{bubbles:true}));});await flush();};
  const writes = () => calls.filter(c=>c.method==='PATCH');
  const render = async()=>{await act(async()=>root.render(React.createElement(ui.BuyerAddressPanel,props)));await flush();};
  async function mount(extra={}) {
    calls=[];actual={...owner};changed=0;reply=descriptor();held=null;
    const transport=async(path,method='GET',body)=>{calls.push({path,method,body:structuredClone(body)});if(path==='/auth/me'){if(held){const h=held;held=null;return h;}return {user:{...actual},restore_preview:props.readOnly};}
      if(path.includes('/buyer-address-history'))return {data:[],next_cursor:null};if(method==='PATCH')return receipt();return structuredClone(reply);};
    props={orderId,contextKey:`${owner.tenant_id}:${owner.id}:admin:false`,readOnly:false,admin:true,refresh:0,externalWriteBlocked:false,onChanged:()=>changed++,transport,...extra};
    box=document.createElement('div');document.body.append(box);root=(await import('react-dom/client')).createRoot(box);await render();await until(()=>box.textContent.includes('Potwierdź rzeczywisty'));
  }
  async function unmount(){if(root){await act(async()=>root.unmount());box.remove();root=null;}}
  try {
    vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error',plugins:[{name:'deny-native-runtime',enforce:'pre',resolveId(s){if(s==='pg'||s==='fastify'||s.includes('server/buyer-address'))assert.fail('Runtime import '+s);}}]});
    ui=await vite.ssrLoadModule(path.resolve('web/buyer-address.tsx'));
    await t.test('unknown kind requires both independent confirmations and exact dual-CAS body',async()=>{
      await mount();try{await check(' Udostępnij adres i jego korektę posiadaczowi prywatnego linku');await check(' Potwierdzam ustawienie dostępu dla posiadacza tego linku');assert(button('Zapisz ustawienie dostępu').disabled);
        await choose('address');await check(' Sprawdziłem rzeczywisty rodzaj dostawy; nie wnioskuję z nazwy metody');assert(button('Zapisz ustawienie dostępu').disabled);await check(' Potwierdzam ustawienie dostępu dla posiadacza tego linku');await click(button('Zapisz ustawienie dostępu'));await until(()=>changed===1);
        assert.deepEqual(writes().map(c=>c.body),[{enabled:true,version:'4',policy_version:'0',delivery_kind:'address',confirmed_delivery_kind:true}]);assert(box.textContent.includes('Nowa 5'));assert.equal([...box.querySelectorAll('input[type=checkbox]')].at(-1).checked,false);
      }finally{await unmount();}
    });
    await t.test('newer policy after consent refuses send and resets consent',async()=>{
      await mount();try{await choose('address');await check(' Sprawdziłem rzeczywisty rodzaj dostawy; nie wnioskuję z nazwy metody');await check(' Potwierdzam ustawienie dostępu dla posiadacza tego linku');reply=descriptor({policy_version:'1'});await click(button('Zapisz ustawienie dostępu'));await until(()=>box.textContent.includes('potwierdź ponownie'));assert.equal(writes().length,0);assert(button('Zapisz ustawienie dostępu').disabled);
      }finally{await unmount();}
    });
    await t.test('readonly viewer reads full private history and twenty-row cursor, no PATCH',async()=>{
      await mount();try{actual.role='viewer';props={...props,admin:false,readOnly:true,contextKey:`${owner.tenant_id}:${owner.id}:viewer:true`};reply=descriptor({read_only:true,can_manage:false});const base=props.transport;props.transport=async(p,m,b)=>p.includes('/buyer-address-history')?{data:p.includes('?')?[entry(21)]:Array.from({length:20},(_,i)=>entry(i+1)),next_cursor:p.includes('?')?null:'signed+cursor/='}:base(p,m,b);await render();await until(()=>box.querySelectorAll('article').length===20);assert(button('Zapisz ustawienie dostępu').disabled);await click(button('Starsze zmiany adresu'));await until(()=>box.querySelectorAll('article').length===21);assert.equal(box.querySelectorAll('td').length,21*18);assert.equal(writes().length,0);
      }finally{await unmount();}
    });
    await t.test('lost policy ACK survives refresh/remount; explicit GET readback never repeats CAS',async()=>{
      await mount();try{const base=props.transport;props.transport=async(p,m,b)=>{if(m==='PATCH'){calls.push({path:p,method:m,body:structuredClone(b)});throw Error('ACK lost');}return base(p,m,b);};await render();await until(()=>box.textContent.includes('Potwierdź rzeczywisty'));await choose('address');await check(' Sprawdziłem rzeczywisty rodzaj dostawy; nie wnioskuję z nazwy metody');await check(' Potwierdzam ustawienie dostępu dla posiadacza tego linku');await click(button('Zapisz ustawienie dostępu'));await until(()=>box.textContent.includes('niepewny'));assert.equal(writes().length,1);reply=descriptor({policy_version:'1',delivery_kind:'address',classification_origin:'operator_confirmed',effective_delivery:delivery,reason:'access_disabled'});props.refresh++;await render();await until(()=>box.textContent.includes('Nowa 5'));assert(box.textContent.includes('niepewny'));
        await unmount();box=document.createElement('div');document.body.append(box);root=(await import('react-dom/client')).createRoot(box);await render();await until(()=>box.textContent.includes('Nowa 5'));assert(box.textContent.includes('niepewny'));await click(button('Sprawdź wynik ustawienia'));await until(()=>box.textContent.includes('nie potwierdza autorstwa'));assert.equal(writes().length,1);assert.equal(changed,1);
      }finally{await unmount();}
    });
    await t.test('late parent write block and actor replacement purge prevent post-await PATCH',async()=>{
      await mount();try{await choose('address');await check(' Sprawdziłem rzeczywisty rodzaj dostawy; nie wnioskuję z nazwy metody');await check(' Potwierdzam ustawienie dostępu dla posiadacza tego linku');let release;held=new Promise(r=>release=r);await click(button('Zapisz ustawienie dostępu'));props.externalWriteBlocked=true;await render();await act(async()=>release({user:owner,restore_preview:false}));await until(()=>!button('Odśwież adres i historię').disabled);assert.equal(writes().length,0);
        reply=descriptor({effective_delivery:delivery});props.refresh++;await render();await until(()=>box.textContent.includes('Nowa 5'));
        actual={...owner,id:'66666666-6666-4666-8666-666666666666'};await click(button('Odśwież adres i historię'));await until(()=>!button('Odśwież adres i historię').disabled);assert(!box.textContent.includes('Nowa 5'),'Actual identity mismatch purges previously read address');
        reply=descriptor();props={...props,contextKey:`${owner.tenant_id}:${actual.id}:admin:false`};await render();await until(()=>!button('Odśwież adres i historię').disabled);assert(!box.textContent.includes('Nowa 5'));assert.equal(writes().length,0);
      }finally{await unmount();}
    });
    await t.test('inherited delivery history shows its actual address and provenance without claiming a buyer edit',async()=>{
      await mount();try{const base=props.transport;props.transport=async(p,m,b)=>p.includes('/buyer-address-history')?{data:[{...entry(22),kind:'merge_inherit',before:null,after:delivery,before_policy:{enabled:false,delivery_kind:'unknown',classification_origin:'unknown'},after_policy:{enabled:false,delivery_kind:'address',classification_origin:'operator_confirmed'}}],next_cursor:null}:base(p,m,b);await render();await until(()=>box.querySelectorAll('article').length===1);const article=box.querySelector('article');assert.match(article.textContent,/Adres odziedziczony po połączeniu zamówień/);assert.match(article.textContent,/Nowa 5/);assert.match(article.textContent,/Edycja adresu w portalu pozostała wyłączona/);assert.doesNotMatch(article.textContent,/Korekta adresu przez kupującego|Ustawienie dostępu/);assert.equal(writes().length,0);
      }finally{await unmount();}
    });
    await t.test('inheritance history cannot silently grant address-edit policy or substitute an unknown receipt kind',async()=>{
      for(const patch of [{after_policy:{enabled:true,delivery_kind:'address',classification_origin:'adapter'}},{kind:'other_inheritance'}]){await mount();try{const base=props.transport;props.transport=async(p,m,b)=>p.includes('/buyer-address-history')?{data:[{...entry(23),kind:'merge_inherit',before:null,before_policy:{enabled:false,delivery_kind:'unknown',classification_origin:'unknown'},after_policy:{enabled:false,delivery_kind:'address',classification_origin:'adapter'},...patch}],next_cursor:null}:base(p,m,b);await render();await until(()=>box.textContent.includes('Nie udało się potwierdzić operacji.'));assert.equal(box.querySelectorAll('article').length,0);assert.equal(writes().length,0);}finally{await unmount();}}
    });
    assert.equal(net,0,'Real HTTP attempts');
  } finally {await unmount();if(vite)await vite.close();for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
