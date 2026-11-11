/** Actual DeveloperPanel with closed local fetch. No API server, database or provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {transformSync} from 'esbuild';
import {z} from 'zod';
import React, {act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';

const tenant = '10000000-1000-4000-8000-000000000001';
const defaults = ['purchasing:read', 'orders:read', 'products:read', 'inventory:read', 'documents:read'];
const labels = ['Zakupy · odczyt', 'Zamówienia · odczyt', 'Produkty · odczyt', 'Magazyn · odczyt', 'Dokumenty · odczyt'];
const sorted = values => [...values].sort();
const reactProps = element => element[Object.keys(element).find(key => key.startsWith('__reactProps'))];
const button = (el, text) => [...el.querySelectorAll('button')].find(e => e.textContent.trim() === text);
const webhookFixture = () => ({
  subscriptions: [false,true].map((enabled,i) => ({id:'hook-'+i,name:'Własny webhook '+i,mode:'local',enabled,revoked_at:null,events:['order.created']})),
  deliveries: Array.from({length:12},(_,i) => ({id:'delivery-'+i,event_type:'order.created',name:'Własny webhook',state:'failed',attempts:1,created_at:'2026-10-01T00:00:00Z'})),
  inbox: Array.from({length:6},(_,i) => ({delivery_id:'inbox-'+i,received_at:'2026-10-01T00:00:00Z',payload:{type:'order.created',order:{id:'existing-order-'+i,status:'paid'}}})),
});

test('the actual create-key validator rejects write-only CRM, accepts22 scopes and preserves original defaults',()=>{
  const source=fs.readFileSync('server/developer-api.ts','utf8');
  const from=source.indexOf('export const apiScopes ='),to=source.indexOf('// Both routes currently share the accepted parser.',from);
  assert(from>=0&&to>from);
  // Execute the actual exported Zod declarations, with no DB/auth/provider imports.
  const code=transformSync(source.slice(from,to),{loader:'ts',format:'cjs',target:'es2022'}).code;
  const module={exports:{}};new Function('module','exports','z',code)(module,module.exports,z);
  const {apiScopes,developerKeyCreateInput:input}=module.exports;
  assert.equal(apiScopes.length,22);
  assert.deepEqual(input.parse({name:'  Własny CRM ',scopes:[...apiScopes]}),{name:'Własny CRM',scopes:apiScopes,expires_days:30});
  assert.deepEqual(input.parse({name:'Odczyt',scopes:defaults}),{name:'Odczyt',scopes:defaults,expires_days:30});
  assert.deepEqual(input.parse({name:'CRM',scopes:['orders:read','crm:read','crm:write','crm:read']}).scopes,['orders:read','crm:read','crm:write']);
  assert.deepEqual(input.parse({name:'CRM',scopes:['orders:read','crm:read']}).scopes,['orders:read','crm:read']);
  assert.throws(()=>input.parse({name:'CRM',scopes:['orders:read','crm:write']}),z.ZodError);
  // CRM scopes live beside api_keys, whose pinned CHECK needs one ordinary scope.
  assert.throws(()=>input.parse({name:'CRM',scopes:['crm:read','crm:write']}),z.ZodError);
  assert.throws(()=>input.parse({name:'CRM',scopes:[...apiScopes,'crm:read']}),z.ZodError);
  const actualRoute=source.slice(source.indexOf("app.post('/api/developer/keys'"),source.indexOf("app.delete('/api/developer/keys/:id'"));
  assert(actualRoute.includes('developerKeyCreateInput.parse(req.body)'),'The actual route consumes the tested validator');
  assert(actualRoute.includes('ensure(count < 20'),'The separate active-key quota remains20');
});

test('DeveloperPanel exposes explicit CRM scopes without changing existing defaults', async t => {
  const dom = new JSDOM('<body/>', {url: 'http://127.0.0.1:4105'});
  const saved = new Map(), oldFetch = globalThis.fetch, roots = new Set();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    location: dom.window.location, HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event, FormData: dom.window.FormData, CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
  }
  let vite;
  try {
    vite = await createServer({
      server: {middlewareMode: true, hmr: false, ws: false, watch: null},
      appType: 'custom', logLevel: 'error',
    });
    const {DeveloperPanel} = await vite.ssrLoadModule(path.resolve('web/developer.tsx'));
    const {setWorkspace} = await vite.ssrLoadModule(path.resolve('web/api.ts'));
    const {createRoot} = await import('react-dom/client');
    setWorkspace(tenant);

    async function mount(admin = true, options = {}) {
      const deferCreate=options.deferCreate;
      const requests = [], notices = [], keys = options.existing ? [{id:'existing-key',name:'Istniejący klucz',prefix:'existing',scopes:['crm:read'],expires_at:'2099-01-01T00:00:00Z',revoked_at:null}] : [];
      const hooks=options.existing?webhookFixture():{subscriptions: [], deliveries: [], inbox: []};
      globalThis.fetch = async (url, options = {}) => {
        const request = {url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null};
        requests.push(request);
        assert.equal(options.credentials, 'same-origin');
        assert.equal(options.headers['X-Workspace-ID'], tenant);
        if (request.method === 'GET' && url === '/api/developer/keys') return Response.json({data: keys});
        // 237 key state (rotation lineage, last use); none recorded in this fixture.
        if (request.method === 'GET' && url === '/api/developer/keys/state') return Response.json({data: []});
        if (request.method === 'GET' && url === '/api/developer/webhooks')
          return Response.json(hooks);
        if (request.method === 'POST' && url === '/api/developer/keys') {
          const key = {
            id: '20000000-1000-4000-8000-000000000001', name: request.body.name,
            scopes: [...request.body.scopes], prefix: 'test-key', expires_at: '2099-01-01T00:00:00Z', revoked_at: null,
          };
          keys.push(key);
          const response=Response.json({...key, token: 'TEST_ONLY_NEVER_SENT_TO_PROVIDER'});
          return deferCreate?deferCreate(response):response;
        }
        if(request.method==='DELETE'&&url==='/api/developer/keys/existing-key')return Response.json({ok:true});
        if(request.method==='POST'&&url==='/api/developer/webhooks')return Response.json({id:'new-local-hook',secret:'TEST_ONLY_HOOK_SECRET'});
        if(request.method==='POST'&&/^\/api\/developer\/(?:webhooks\/hook-[01]\/(?:enable|disable|revoke)|deliveries\/delivery-\d+\/retry)$/.test(url))return Response.json({ok:true});
        assert.fail('Unexpected closed request: ' + request.method + ' ' + url);
      };
      const el = document.createElement('div'); document.body.append(el);
      const root = createRoot(el); roots.add(root);
      let properties={admin,refresh:0,readOnly:options.readOnly??false,contextKey:'own-actor-A',notify:(...args)=>notices.push(args)};
      const render=async(next={})=>{properties={...properties,...next};await act(async()=>root.render(React.createElement(DeveloperPanel,properties)));};
      await render();
      const checkbox = label => {
        const entry = [...el.querySelectorAll('.developer-checks label')].find(e => e.textContent.trim() === label);
        assert(entry, 'Rendered scope label ' + label);
        return entry.querySelector('input[type=checkbox]');
      };
      return {
        el, requests, notices, checkbox, render,
        async click(label) {await act(async () => checkbox(label).click());},
        async submit() {
          const form = el.querySelector('form');
          assert(form); form.elements.namedItem('name').value = 'Własny CRM';
          await act(async () => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
          assert.equal(notices.length, 1); assert.notEqual(notices[0][1], true);
          const writes = requests.filter(r => r.method !== 'GET');
          assert.equal(writes.length, 1); assert.equal(writes[0].url, '/api/developer/keys');
          return writes[0].body;
        },
        async close() {if(roots.has(root)){await act(async () => root.unmount()); roots.delete(root); el.remove();}},
      };
    }

    await t.test('CRM defaults off; write adds read; removing write retains read; removing read clears both', async () => {
      const h = await mount();
      try {
        assert.equal(h.checkbox('CRM · odczyt').checked, false);
        assert.equal(h.checkbox('CRM · zapis').checked, false);
        for (const label of labels) assert.equal(h.checkbox(label).checked, true);
        await h.click('CRM · zapis');
        assert.equal(h.checkbox('CRM · zapis').checked, true);
        assert.equal(h.checkbox('CRM · odczyt').checked, true);
        await h.click('CRM · zapis');
        assert.equal(h.checkbox('CRM · zapis').checked, false);
        assert.equal(h.checkbox('CRM · odczyt').checked, true);
        await h.click('CRM · zapis'); await h.click('CRM · odczyt');
        assert.equal(h.checkbox('CRM · zapis').checked, false);
        assert.equal(h.checkbox('CRM · odczyt').checked, false);
        const body = await h.submit();
        assert.deepEqual(body, {name: 'Własny CRM', scopes: defaults, expires_days: 30});
      } finally {await h.close();}
    });

    await t.test('real form submits both CRM capabilities and renders returned key labels', async () => {
      const h = await mount();
      try {
        await h.click('CRM · zapis');
        const body = await h.submit();
        assert.deepEqual(Object.keys(body).sort(), ['expires_days', 'name', 'scopes']);
        assert.deepEqual(sorted(body.scopes), sorted([...defaults, 'crm:read', 'crm:write']));
        assert.equal(new Set(body.scopes).size, body.scopes.length);
        assert.equal(body.expires_days, 30); assert.equal(body.name, 'Własny CRM');
        const row = h.el.querySelector('.developer-item'); assert(row);
        assert.match(row.textContent, /Własny CRM/);
        assert.match(row.textContent, /CRM · odczyt · CRM · zapis/);
        assert.doesNotMatch(row.textContent, /undefined|crm:read|crm:write/);
        assert(h.requests.filter(r => r.method === 'GET' && r.url === '/api/developer/keys').length >= 2);
      } finally {await h.close();}
    });

    await t.test('disabling CRM write submits only read, preserving all original default scopes', async () => {
      const h = await mount();
      try {
        await h.click('CRM · zapis'); await h.click('CRM · zapis');
        assert.deepEqual(sorted((await h.submit()).scopes), sorted([...defaults, 'crm:read']));
      } finally {await h.close();}
    });

    await t.test('non-admin cannot render or submit the key form', async () => {
      const h = await mount(false);
      try {
        assert.match(h.el.textContent, /Wymagana rola administratora/);
        assert.equal(h.el.querySelector('form'), null);
        assert.deepEqual(h.requests, []);
      } finally {await h.close();}
    });

    await t.test('readonly disables every write control but preserves local refresh, delivery pagination and inbox history',async()=>{
      const h=await mount(true,{readOnly:true,existing:true});
      try{
        assert.match(h.el.textContent,/Podgląd kopii jest tylko do odczytu/);
        for(const form of h.el.querySelectorAll('form')){
          for(const element of form.querySelectorAll('input,select,button'))assert(element.matches(':disabled'),'Readonly form control '+element.tagName);
          await act(async()=>reactProps(form).onSubmit({preventDefault(){},currentTarget:form}));
        }
        const mutations=[...h.el.querySelectorAll('.developer-list button,tbody button')];assert(mutations.length>=5);
        for(const element of mutations){
          assert.equal(element.disabled,true);
          await act(async()=>reactProps(element).onClick());
        }
        const refresh=button(h.el,'Odśwież dostawy');assert.equal(refresh.disabled,false);
        const reads=h.requests.length;await act(async()=>refresh.click());assert(h.requests.length>reads);
        const history=button(h.el,'Pokaż wszystkie dostawy (12)');assert(history&&!history.disabled);
        await act(async()=>history.click());assert.equal(h.el.querySelectorAll('tbody tr').length,12);
        const inbox=button(h.el,'Pokaż wszystkie odbiory (6)');assert(inbox&&!inbox.disabled);
        await act(async()=>inbox.click());assert.equal(h.el.querySelectorAll('.developer-inbox details').length,6);
        await act(async()=>h.el.querySelector('.developer-inbox summary').click());
        assert.equal(h.requests.filter(r=>r.method!=='GET').length,0);
        assert.deepEqual(h.notices,[]);
      }finally{await h.close();}
    });

    await t.test('old forms and write callbacks refuse after readonly, actor changes, role loss and unmount',async()=>{
      const h=await mount(true,{existing:true});
      const forms=[...h.el.querySelectorAll('form')].map(form=>({form,submit:reactProps(form).onSubmit}));
      const callbacks=[...h.el.querySelectorAll('.developer-list button,tbody button')].map(el=>reactProps(el).onClick);
      const forced=async()=>{for(const {form,submit}of forms)await act(async()=>submit({preventDefault(){},currentTarget:form}));for(const run of callbacks)await act(async()=>run());};
      try{
        await h.render({readOnly:true});await forced();
        await h.render({readOnly:false,contextKey:'another-actor'});await forced();
        await h.render({contextKey:'own-actor-A',admin:false});await forced();
        await h.render({admin:true,readOnly:false});await h.close();await forced();
        assert.equal(h.requests.filter(r=>r.method!=='GET').length,0);
        assert.deepEqual(h.notices,[]);
      }finally{await h.close();}
    });

    await t.test('an already-sent key response cannot reveal its secret or notify after the panel becomes readonly',async()=>{
      let release,response;
      const h=await mount(true,{deferCreate:r=>{response=r;return new Promise(resolve=>{release=resolve;});}});
      try{
        const form=h.el.querySelector('form');form.elements.namedItem('name').value='Pending own key';
        await act(async()=>reactProps(form).onSubmit({preventDefault(){},currentTarget:form}));
        assert.equal(h.requests.filter(r=>r.method==='POST').length,1);assert(release);
        await h.render({readOnly:true});
        await act(async()=>release(response));
        assert.equal(h.el.querySelector('[aria-label="Nowy klucz API"]'),null);
        assert.deepEqual(h.notices,[]);
        assert.equal(h.requests.filter(r=>r.method!=='GET').length,1,'No replay or new write after late ACK');
        await h.render({readOnly:false});assert.equal(button(h.el,'Utwórz klucz API').disabled,false,'The old pending request cannot leave the panel busy');
      }finally{await h.close();}
    });

    await t.test('normal key revoke and local webhook create/enable/disable/revoke/retry still dispatch exact writes',async()=>{
      const h=await mount(true,{existing:true});
      try{
        const click=async element=>{assert(element&&!element.disabled);await act(async()=>element.click());};
        await click(h.el.querySelector('[aria-label="Unieważnij klucz Istniejący klucz"]'));
        await click(button(h.el,'Włącz skrzynkę lokalną'));
        await click(button(h.el,'Wyłącz webhook'));
        await click(h.el.querySelector('[aria-label="Unieważnij webhook Własny webhook 0"]'));
        await click(button(h.el,'Ponów'));
        const form=h.el.querySelectorAll('form')[1];form.elements.namedItem('name').value='Lokalny odbiorca';
        await act(async()=>reactProps(form).onSubmit({preventDefault(){},currentTarget:form}));
        assert.deepEqual(h.requests.filter(r=>r.method!=='GET').map(r=>[r.method,r.url]),[
          ['DELETE','/api/developer/keys/existing-key'],['POST','/api/developer/webhooks/hook-0/enable'],
          ['POST','/api/developer/webhooks/hook-1/disable'],['POST','/api/developer/webhooks/hook-0/revoke'],
          ['POST','/api/developer/deliveries/delivery-0/retry'],['POST','/api/developer/webhooks'],
        ]);
        assert.deepEqual(h.requests.find(r=>r.url==='/api/developer/webhooks'&&r.method==='POST').body,{name:'Lokalny odbiorca',mode:'local',events:['order.created','order.status_changed']});
        assert.equal(h.notices.length,6);assert(h.notices.every(n=>n[1]!==true));
        assert.equal(h.el.querySelector('[aria-label="Sekret podpisu webhooka"]').value,'TEST_ONLY_HOOK_SECRET');
      }finally{await h.close();}
    });

    await t.test('main passes preview and principal key to the real DeveloperPanel',()=>{
      const source=fs.readFileSync('web/main.tsx','utf8');const start=source.indexOf('<DeveloperPanel');assert(start>0);
      const call=source.slice(start,source.indexOf('/>',start));
      assert(call.includes('readOnly={restorePreview}'));
      assert(call.includes("key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}"));
      assert(call.includes("contextKey={user.tenant_id + ':' + user.id + ':' + user.role}"));
    });
  } finally {
    for (const root of roots) await act(async () => root.unmount());
    if (vite) await vite.close();
    globalThis.fetch = oldFetch;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
