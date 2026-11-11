/** Actual loopback HTTPS and pagination. These are TLS contract tests, not official Woo acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpsRequest,type Server} from 'node:https';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createLocalWooHttpTransport,localWooOrigin,LOCAL_WOO_ORIGINS} from '../server/local-woo-http-transport';
import {readLocalWooOrders} from '../server/local-woo-orders-read';
import {LOCAL_WOO_SCALE_ORIGINS} from '../shared/local-woo-origins';

test('both store transports keep TLS, credentials, destination and pagination isolated',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dyna-woo-tls-'));
 const servers:Server[]=[],ports=new Map<number,number>(),seen:{store:string;host:string|undefined;url:string|undefined}[]=[];
 try{
  const config=path.join(directory,'cert.cnf'),keyFile=path.join(directory,'key.pem'),certFile=path.join(directory,'cert.pem');
  await writeFile(config,'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=localhost\n[v3]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=DNS:localhost\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n',{mode:0o600});
  execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',config,'-keyout',keyFile,'-out',certFile],{stdio:'ignore'});
  const ca=await readFile(certFile),key=await readFile(keyFile),caSha256=createHash('sha256').update(ca).digest('hex');
  for(const [index,origin] of LOCAL_WOO_ORIGINS.slice(0,2).entries()){
   const store=index===0?'A':'B',authorization='Basic '+Buffer.from(store+':secret').toString('base64');
   const server=createServer({key,cert:ca},(req,res)=>{
    seen.push({store,host:req.headers.host,url:req.url});
    if(req.headers.authorization!==authorization){res.writeHead(401,{'content-type':'application/json'});res.end('{}');return;}
    const orders=req.url?.startsWith('/wp-json/wc/v3/orders?');
    res.writeHead(200,{'content-type':'application/json',...(orders?{'x-wp-totalpages':'1','x-wp-total':'1'}:{})});
    res.end(JSON.stringify(orders?[{id:18,store}]:{id:17,sku:store}));
   });
   servers.push(server);await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
   const address=server.address();assert(address&&typeof address==='object');ports.set(Number(new URL(origin).port),address.port);
  }
  // The existing requester seam redirects only the test socket to owned ephemeral
  // ports. Real TLS/SNI/CA/auth/Host and production destination checks stay intact.
  const requester:NonNullable<Parameters<typeof createLocalWooHttpTransport>[1]>=(options,receive)=>{
   const port=ports.get(Number(options.port));assert(port);return httpsRequest({...options,port},receive);
  };
  const a=createLocalWooHttpTransport({ca,caSha256},requester),b=createLocalWooHttpTransport({ca,caSha256,origin:LOCAL_WOO_ORIGINS[1]},requester);
  const init=(store:string)=>({method:'GET',headers:{authorization:'Basic '+Buffer.from(store+':secret').toString('base64')},redirect:'error' as const,credentials:'omit' as const});
  assert.deepEqual(await(await a(LOCAL_WOO_ORIGINS[0]+'/wp-json/wc/v3/products/17',init('A'))).json(),{id:17,sku:'A'});
  assert.deepEqual(await(await b(LOCAL_WOO_ORIGINS[1]+'/wp-json/wc/v3/products/17',init('B'))).json(),{id:17,sku:'B'});
  const before=seen.length;
  await assert.rejects(a(LOCAL_WOO_ORIGINS[1]+'/wp-json/wc/v3/products/17',init('A')),/destination refused/);
  await assert.rejects(b(LOCAL_WOO_ORIGINS[0]+'/wp-json/wc/v3/products/17',init('B')),/destination refused/);
  await assert.rejects(b('https://example.com/wp-json/wc/v3/products/17',init('B')),/destination refused/);
  assert.equal(seen.length,before,'refused origins did not reach either server');
  assert.equal((await a(LOCAL_WOO_ORIGINS[0]+'/wp-json/wc/v3/products/17',init('B'))).status,401);
  const orders=await readLocalWooOrders(b,init('B').headers.authorization,LOCAL_WOO_ORIGINS[1]);
  assert.deepEqual(orders.data,[{id:18,store:'B'}]);assert.equal(orders.pagination.complete,true);
  assert(seen.filter(s=>s.store==='A').every(s=>s.host==='localhost:8443'));
  assert(seen.filter(s=>s.store==='B').every(s=>s.host==='localhost:8444'));
  assert.throws(()=>createLocalWooHttpTransport({ca,caSha256:'0'.repeat(64)}),/CA pin refused/);
  key.fill(0);
 }finally{
  for(const server of servers)if(server.listening)await new Promise<void>((yes,no)=>server.close(e=>e?no(e):yes()));
  await rm(directory,{recursive:true,force:true});
 }
});
test('five new store origins preserve actual TLS, Host, credentials and foreign-destination refusal',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dyna-woo-five-tls-')),servers:Server[]=[],ports=new Map<number,number>(),seen:string[]=[];
 try{
  const config=path.join(directory,'cert.cnf'),keyFile=path.join(directory,'key.pem'),certFile=path.join(directory,'cert.pem');
  await writeFile(config,'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=localhost\n[v3]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=DNS:localhost\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n',{mode:0o600});
  execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',config,'-keyout',keyFile,'-out',certFile],{stdio:'ignore'});
  const ca=await readFile(certFile),key=await readFile(keyFile),caSha256=createHash('sha256').update(ca).digest('hex');
  const authorization=(index:number)=>'Basic '+Buffer.from(`OWN-${index}:secret-${index}`).toString('base64');
  for(const [index,origin] of LOCAL_WOO_SCALE_ORIGINS.entries()){
   const server=createServer({key,cert:ca},(req,res)=>{
    seen.push(origin);assert.equal(req.headers.host,new URL(origin).host);
    const own=req.headers.authorization===authorization(index);res.writeHead(own?200:401,{'content-type':'application/json'});res.end(JSON.stringify(own?{id:17,store:index}:{}));
   });servers.push(server);await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
   const address=server.address();assert(address&&typeof address==='object');ports.set(Number(new URL(origin).port),address.port);
  }
  const requester:NonNullable<Parameters<typeof createLocalWooHttpTransport>[1]>=(options,receive)=>{const port=ports.get(Number(options.port));assert(port);return httpsRequest({...options,port},receive);};
  for(const [index,origin] of LOCAL_WOO_SCALE_ORIGINS.entries()){
   const wire=createLocalWooHttpTransport({ca,caSha256,origin},requester),init={headers:{authorization:authorization(index)},redirect:'error' as const,credentials:'omit' as const};
   assert.deepEqual(await(await wire(origin+'/wp-json/wc/v3/products/17',init)).json(),{id:17,store:index});
   assert.equal((await wire(origin+'/wp-json/wc/v3/products/17',{...init,headers:{authorization:authorization((index+1)%5)}})).status,401);
   const before=seen.length;
   for(const foreign of LOCAL_WOO_ORIGINS.filter(candidate=>candidate!==origin))await assert.rejects(wire(foreign+'/wp-json/wc/v3/products/17',init),/destination refused/);
   for(const bad of [origin.replace('https:','http:'),origin.replace('localhost','127.0.0.1'),origin.replace('localhost','user:secret@localhost'),origin+'/../wp-json/wc/v3/products/17'])await assert.rejects(wire(bad,init));
   assert.equal(seen.length,before,'all refused destinations fail before any server receives a request');
  }
  key.fill(0);
 }finally{for(const server of servers)if(server.listening)await new Promise<void>((yes,no)=>server.close(e=>e?no(e):yes()));await rm(directory,{recursive:true,force:true});}
});
test('origin selection has no arbitrary host, port, path, alias or credential capability',()=>{
 assert.equal(localWooOrigin(),LOCAL_WOO_ORIGINS[0]);assert.equal(localWooOrigin(LOCAL_WOO_ORIGINS[1]),LOCAL_WOO_ORIGINS[1]);
 for(const origin of ['https://localhost:8445','http://localhost:8444','https://127.0.0.1:8444','https://localhost:8444/','https://localhost:8444/path','https://user:password@localhost:8444','https://example.com:8444',null,{},42])assert.throws(()=>localWooOrigin(origin),/origin refused/);
});
test('orders snapshot bound is admitted only as an exact GMT second on the orders collection',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'dyna-woo-bound-')),seen:string[]=[];let server:Server|undefined;
 try{
  const config=path.join(directory,'cert.cnf'),keyFile=path.join(directory,'key.pem'),certFile=path.join(directory,'cert.pem');
  await writeFile(config,'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=localhost\n[v3]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=DNS:localhost\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n',{mode:0o600});
  execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',config,'-keyout',keyFile,'-out',certFile],{stdio:'ignore'});
  const ca=await readFile(certFile),key=await readFile(keyFile),caSha256=createHash('sha256').update(ca).digest('hex');
  server=createServer({key,cert:ca},(req,res)=>{seen.push(req.url??'');res.writeHead(200,{'content-type':'application/json','x-wp-totalpages':'1','x-wp-total':'1'});res.end(JSON.stringify([{id:5}]));});
  await new Promise<void>((yes,no)=>{server!.once('error',no);server!.listen(0,'127.0.0.1',yes);});const address=server.address();assert(address&&typeof address==='object');
  const requester:NonNullable<Parameters<typeof createLocalWooHttpTransport>[1]>=(options,receive)=>httpsRequest({...options,port:address.port},receive);
  const wire=createLocalWooHttpTransport({ca,caSha256},requester),origin=LOCAL_WOO_ORIGINS[0],init={method:'GET',headers:{authorization:'Basic '+Buffer.from('ck:cs').toString('base64')},redirect:'error' as const,credentials:'omit' as const};
  const read=await readLocalWooOrders(wire,init.headers.authorization,origin,{now:()=>Date.parse('2026-10-30T10:00:07.900Z')});
  assert.deepEqual(read.data,[{id:5}]);assert.equal(seen.length,1);
  const sent=new URL(seen[0],origin).searchParams;assert.equal(sent.get('before'),'2026-10-30 10:00:02');assert.equal(sent.get('dates_are_gmt'),'true');
  const q=(params:Record<string,string>)=>origin+'/wp-json/wc/v3/orders?'+new URLSearchParams({page:'1',per_page:'50',...params});
  const before=seen.length;
  for(const params of <Record<string,string>[]>[{before:'2026-10-30T10:00:02',dates_are_gmt:'true'},{before:'2026-10-30 10:00:02Z',dates_are_gmt:'true'},{before:'2026-10-30 10:00:02+01:00',dates_are_gmt:'true'},{before:'2026-02-30 10:00:02',dates_are_gmt:'true'},{before:'2026-10-30 24:00:00',dates_are_gmt:'true'},{before:'2026-10-30 10:00',dates_are_gmt:'true'},{before:'2026-10-30 10:00:02'},{dates_are_gmt:'true'},{before:'2026-10-30 10:00:02',dates_are_gmt:'1'},{before:'2026-10-30 10:00:02',dates_are_gmt:'false'},{after:'2026-10-30 10:00:02',dates_are_gmt:'true'},{modified_before:'2026-10-30 10:00:02',dates_are_gmt:'true'}])
   await assert.rejects(wire(q(params),init),/refused/);
  await assert.rejects(wire(q({before:'2026-10-30 10:00:02',dates_are_gmt:'true'})+'&before=2026-10-30+10%3A00%3A03',init),/refused/);
  for(const p of ['/wp-json/wc/v3/orders/5','/wp-json/wc/v3/products'])await assert.rejects(wire(origin+p+'?before=2026-10-30+10%3A00%3A02&dates_are_gmt=true',init),/refused/);
  await assert.rejects(wire(origin+'/wp-json/wc/v3/orders/5?before=2026-10-30+10%3A00%3A02&dates_are_gmt=true',{...init,method:'PUT',body:'{}'}),/refused/);
  assert.equal(seen.length,before,'refused bounds never reach the store');
  key.fill(0);
 }finally{if(server?.listening)await new Promise<void>((yes,no)=>server!.close(e=>e?no(e):yes()));await rm(directory,{recursive:true,force:true});}
});
