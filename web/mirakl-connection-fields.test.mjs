import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';

test('Mirakl form submits the three actual provider settings, with explicit currency and no implicit account claim',async()=>{
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 try{
  const {MiraklConnectionFields}=await vite.ssrLoadModule(path.resolve('web/mirakl-connection-fields.tsx'));
  const dom=new JSDOM(renderToStaticMarkup(React.createElement('form',null,React.createElement(MiraklConnectionFields))));
  try{
   const form=dom.window.document.querySelector('form'),instance=form.elements.namedItem('instance_url'),shop=form.elements.namedItem('shop_id'),currency=form.elements.namedItem('currency');
   assert.equal(instance.type,'url');assert.equal(shop.type,'text');assert.equal(currency.tagName,'SELECT');
   assert.equal(form.checkValidity(),false,'the operator must choose a currency');
   instance.value='https://operator.mirakl.net';shop.value='2000';currency.value='EUR';
   assert.equal(form.checkValidity(),true,'a currency must not be validated as a URL');
   assert.deepEqual(Object.fromEntries(new dom.window.FormData(form)),{instance_url:'https://operator.mirakl.net',shop_id:'2000',currency:'EUR'});
   shop.value='2000x';assert.equal(form.checkValidity(),false);
   assert.match(form.textContent,/Zapis konfiguracji nie potwierdza dostępu/);
   assert.equal(form.querySelectorAll('input[type=password]').length,0,'credentials stay in the existing encrypted credential flow');
  }finally{dom.window.close()}
 }finally{await vite.close()}
});
