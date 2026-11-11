/** Local native preview, never seed/migrate/reset. CLI: input.private.json.
 * Stops only the two listeners this process owns; old local previews stay live. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const input=JSON.parse(await readFile(resolve(process.argv[2]),'utf8'));
assert.match(input.database,/^dynaminds_test_[0-9]{13}$/);
const cfg=await readFile(input.configuration.path);assert.equal(createHash('sha256').update(cfg).digest('hex'),input.configuration.sha256);
Object.assign(process.env,input.environment,{DYNA_IMAGE_DIR:input.images,DYNA_PG_TOOLS:input.pg_tools,DYNA_WORKER_DISABLED:'true'});
const {pool}=await import('../server/db');
const facts=(await pool.query("SELECT current_database() db,buyer_address_guards() ok,EXISTS(SELECT FROM migrations WHERE name='166_buyer_address_sidecar') installed")).rows[0];
assert.equal(facts.db,input.database);assert.equal(facts.ok,true);assert.equal(facts.installed,true);
const {buildApp}=await import('../server/app');
const app=await buildApp({logging:false,backgroundWorkersEnabled:false,trustedLocalUiOrigin:'http://127.0.0.1:5197'});
await app.listen({host:'127.0.0.1',port:4195});
const {createServer}=await import('vite');
const web=await createServer({server:{host:'127.0.0.1',port:5197,strictPort:true,proxy:{'/api/':'http://127.0.0.1:4195'}}});
await web.listen();
console.log(JSON.stringify({status:'BUYER_ADDRESS166_LOCAL_NATIVE_PREVIEW_READY',database:input.database,api:'http://127.0.0.1:4195',web:'http://127.0.0.1:5197',workers:false,seed:false,migrate:false}));
let closing=false;async function close(){if(closing)return;closing=true;await web.close();await app.close();await pool.end();console.log(JSON.stringify({status:'BUYER_ADDRESS166_OWN_LISTENERS_CLOSED'}));process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
