import assert from 'node:assert/strict';
import test from 'node:test';
import {parseOrdinaryLocalCliArgs} from '../server/ordinary-local-cli';
import {validateTrustedLocalUiOrigin} from '../server/local-ui-origin';
import {prepareOrdinaryProviderReads,prepareOrdinaryNbpRates} from '../server/ordinary-provider-reads';
const selected=['/private/selection.json','a'.repeat(64)];
test('automatic local Woo reads require a private store selection and stay off by default',()=>{
 const stores=['--local-woo-stores','/private/stores.json','c'.repeat(64)];
 assert.throws(()=>parseOrdinaryLocalCliArgs([...selected,'4105','--local-woo-reads']),/require-selection/);
 const old=parseOrdinaryLocalCliArgs([...selected,'4105',...stores]);assert.equal(old.options.localWooReadEnabled,undefined);
 const active=parseOrdinaryLocalCliArgs([...selected,'4105',...stores,'--local-woo-reads','--scoped-automation']);
 assert.equal(active.options.localWooReadEnabled,true);assert.equal(active.options.scopedAutomationEnabled,true);
 assert.deepEqual(active.localWooSelection,{file:'/private/stores.json',digest:'c'.repeat(64)});
 assert.throws(()=>parseOrdinaryLocalCliArgs([...selected,'4105',...stores,'--local-woo-reads','--local-woo-reads']),/duplicate-option/);
});
test('legacy positional4100 remains disabled and exact loopback origin is derived',()=>{
 const p=parseOrdinaryLocalCliArgs([...selected,'4100']);assert.equal(p.port,4100);assert.equal(p.nbpEur,false);
 assert.deepEqual(p.options,{trustedLocalUiOrigin:'http://127.0.0.1:4100',scopedAutomationEnabled:false});
});
test('strict unprivileged decimal ports include endpoints and a separate local listener',()=>{
 for(const port of ['1024','41585','65535']){const p=parseOrdinaryLocalCliArgs([...selected,port]);assert.equal(p.port,Number(port));assert.equal(validateTrustedLocalUiOrigin(p.options.trustedLocalUiOrigin),'http://127.0.0.1:'+port);}
 for(const port of ['1023','0','80','65536','99999','04100','+4100','4100.0','4.1e3','0x1004','4100 ',' 4100','4100\n','4100/path','127.0.0.1:4100',''])assert.throws(()=>parseOrdinaryLocalCliArgs([...selected,port]));
});
test('unknown, duplicate or arbitrary provider/origin options refuse',()=>{
 for(const flags of [['--nbp-eur','--nbp-eur'],['--scoped-automation','--scoped-automation'],['--verified-stock-writers','--verified-stock-writers'],['--nbp-usd'],['--origin=http://other.example'],['--provider=https://other.example'],['--nbp-eur','--extra']])assert.throws(()=>parseOrdinaryLocalCliArgs([...selected,'41585',...flags]));
 assert.throws(()=>parseOrdinaryLocalCliArgs(selected));
});
test('EUR option provides only the exact declared manual route, preserving independent local flags',()=>{
 const p=parseOrdinaryLocalCliArgs([...selected,'41585','--nbp-eur','--verified-stock-writers','--scoped-automation']);
 assert.deepEqual(p.options,{trustedLocalUiOrigin:'http://127.0.0.1:41585',scopedAutomationEnabled:true,stockWriterActivation:{mode:'verified_local_physical_writers'},providerReads:{routes:[{origin:'https://api.nbp.pl',path:'/api/exchangerates/rates/a/eur/',methods:['GET'],queryKeys:['format']},{origin:'https://api.nbp.pl',path:'/api/exchangerates/rates/a/eur/:date/',methods:['GET'],queryKeys:['format']},{origin:'https://api.nbp.pl',path:'/api/exchangerates/rates/a/eur/:start/:end/',methods:['GET'],queryKeys:['format']}]},nbpRates:{currencies:['EUR'],maxAgeDays:7}});
 assert.equal('installedLargeImport' in p.options,false);
 const transport=prepareOrdinaryProviderReads(p.options.providerReads,{readOnly:false,localWooFixture:false});
 const rates=prepareOrdinaryNbpRates(p.options.nbpRates,p.options.providerReads,transport,{readOnly:false,localWooFixture:false});assert(rates);assert.deepEqual(rates.currencies,['EUR']);assert.equal(rates.maxAgeDays,7);assert.equal(typeof rates.readTableA,'function');
 // Construction only: never call rates.read. The normal signed-in route owns manual dispatch.
 for(const context of [{readOnly:true,localWooFixture:false},{readOnly:false,localWooFixture:true}])assert.throws(()=>prepareOrdinaryProviderReads(p.options.providerReads,context));
});
test('independent parses cannot mutate another invocation provider policy',()=>{
 const a=parseOrdinaryLocalCliArgs([...selected,'41585','--nbp-eur']),b=parseOrdinaryLocalCliArgs([...selected,'41585','--nbp-eur']);
 a.options.providerReads!.routes[0]!.origin='https://changed.example';assert.equal(b.options.providerReads!.routes[0]!.origin,'https://api.nbp.pl');
});
test('combined importer and connector selections preserve all four ordinary flags at the full argv bound',()=>{
 const digest='b'.repeat(64),importer='/private/importer:selection.json',connector='/private/connector.json';
 const p=parseOrdinaryLocalCliArgs([...selected,'4100','--scoped-automation','--verified-stock-writers','--nbp-eur','--amazon-mcf-sandbox-eu',`--installed-importer-selection=${digest}:${importer}`,'--connector-access',connector,digest]);
 assert.deepEqual(p.options.installedLargeImportSelection,{path:importer,sha256:digest});
 assert.deepEqual(p.connectorAccessSelection,{file:connector,digest});
 assert(p.scopedAutomationEnabled&&p.verifiedStockWriters&&p.nbpEur&&p.amazonMcfSandboxEu);
 assert.equal('connectorAccess' in p.options,false,'private connector data is loaded separately before construction');
});
test('combined parsing rejects ambiguous selections and cannot consume a flag as a private reference',()=>{
 const good=`--installed-importer-selection=${'b'.repeat(64)}:/private/import.json`;
 for(const flags of [[good,good],[good,good.replace('import.json','other.json')],[good,'--connector-access','--nbp-eur','b'.repeat(64)],['--installed-importer-selection='+ 'b'.repeat(64)+':/private/../import.json'],[good,'--connector-access','/private/access.json'],[good,'--connector-access','/private/access.json','NOT_A_SHA']])assert.throws(()=>parseOrdinaryLocalCliArgs([...selected,'4100',...flags]));
});
test('two-store private selection composes with scoped rules and the installed importer',()=>{
 const digest='c'.repeat(64),p=parseOrdinaryLocalCliArgs([...selected,'41601','--local-woo-stores','/private/woo-stores.json',digest,'--scoped-automation','--verified-stock-writers',`--installed-importer-selection=${digest}:/private/import.json`]);
 assert.deepEqual(p.localWooSelection,{file:'/private/woo-stores.json',digest});
 assert.equal(p.scopedAutomationEnabled,true);assert.equal(p.verifiedStockWriters,true);
 assert.equal('localWooFixtures' in p.options,false,'private files are read only in main, after parsing');
});
test('local stores refuse duplicate or noncanonical selections',()=>{
 const flag=['--local-woo-stores','/private/stores.json','c'.repeat(64)];
 for(const flags of [[...flag,...flag],['--local-woo-stores','/private/../stores.json','c'.repeat(64)],['--local-woo-stores','/private/stores.json'],['--local-woo-stores','/private/stores.json','bad']])assert.throws(()=>parseOrdinaryLocalCliArgs([...selected,'4100',...flags]));
});
test('both independent private selections compose within the existing full argv bound',()=>{
 const digest='e'.repeat(64), args=[...selected,'4100','--connector-jobs-sandbox','--scoped-automation','--verified-stock-writers','--nbp-eur','--amazon-mcf-sandbox-eu',`--installed-importer-selection=${digest}:/private/importer.json`,'--connector-access','/private/providers.json',digest,'--local-woo-stores','/private/stores.json',digest];
 assert.equal(args.length,15);const p=parseOrdinaryLocalCliArgs(args);
 assert.deepEqual(p.connectorAccessSelection,{file:'/private/providers.json',digest});
 assert.deepEqual(p.localWooSelection,{file:'/private/stores.json',digest});
 assert.deepEqual(p.options.connectorJobExecution,{mode:'sandbox_manual_once'});
 assert.equal('connectorAccess' in p.options,false);assert.equal('localWooFixtures' in p.options,false);
});
test('explicit Mirakl control-state flag composes with pinned connectors and stores within eighteen args',()=>{
 const digest='f'.repeat(64),args=[...selected,'4100','--scoped-automation','--verified-stock-writers','--amazon-mcf-sandbox-eu',`--installed-importer-selection=${digest}:/private/importer.json`,'--connector-access','/private/providers.json',digest,'--local-woo-stores','/private/stores.json',digest,'--mirakl-read-state=dynaminds_connector_state'];
 const p=parseOrdinaryLocalCliArgs(args);assert.deepEqual(p.options.miraklReadState,{database:'dynaminds_connector_state'});assert(p.connectorAccessSelection&&p.localWooSelection);assert(args.length<=18);
 for(const flags of [['--mirakl-read-state=dynaminds_connector_state'],['--mirakl-read-state=dynaminds_main'],['--mirakl-read-state=postgres://secret@localhost/db'],['--mirakl-read-state=dynaminds_connector_state','--mirakl-read-state=dynaminds_connector_state_test_1234567890123']])assert.throws(()=>parseOrdinaryLocalCliArgs([...selected,'4100',...flags]));
 assert.throws(()=>parseOrdinaryLocalCliArgs([...selected,'4100','--connector-access','/private/providers.json',digest,'--mirakl-read-state=dynaminds_connector_state','--mirakl-read-state=dynaminds_connector_state_test_1234567890123']),/one-mirakl-read-state/);
 assert.throws(()=>parseOrdinaryLocalCliArgs([...args,...Array(19-args.length).fill('--nbp-eur')]),/ordinary-cli-needs/);
});

test('stock executor requires a separate explicit capability and preserves read-only capability separation',()=>{
 const stores=['--local-woo-stores','/private/stores.json','c'.repeat(64)];
 assert.throws(()=>parseOrdinaryLocalCliArgs([...selected,'4105','--local-woo-stock']),/stock-requires-selection/);
 const off=parseOrdinaryLocalCliArgs([...selected,'4105',...stores,'--local-woo-reads']);assert.equal(off.options.localWooStockEnabled,undefined);
 const stock=parseOrdinaryLocalCliArgs([...selected,'4105',...stores,'--local-woo-stock']);assert.equal(stock.options.localWooStockEnabled,true);assert.equal(stock.options.localWooReadEnabled,undefined);
 const both=parseOrdinaryLocalCliArgs([...selected,'4105',...stores,'--local-woo-stock','--local-woo-reads']);assert.equal(both.options.localWooStockEnabled,true);assert.equal(both.options.localWooReadEnabled,true);
 assert.throws(()=>parseOrdinaryLocalCliArgs([...selected,'4105',...stores,'--local-woo-stock','--local-woo-stock']),/duplicate-option/);
});
test('a failed start prints the MIG-3 backup cause and code, never credentials; other failures only their name',async()=>{
 const {ordinaryLocalStartFailure}=await import('../server/ordinary-local-cli');
 const {MigrationBackupError}=await import('../server/migration-backup');
 const e=new MigrationBackupError(['218_a'],new Error('connect postgres://postgres:sekret@127.0.0.1:57084/x: ENOENT lstat /img/1'));
 const d=ordinaryLocalStartFailure(e);
 assert.deepEqual(Object.keys(d),['status','name','code','message']);assert.equal(d.status,'ORDINARY_LOCAL_START_FAILED');assert.equal(d.name,'MigrationBackupError');assert.equal(d.code,'MIGRATION_BACKUP_FAILED');
 assert.match(String(d.message),/218_a.*Przyczyna: connect postgres:\/\/\*\*\*@127\.0\.0\.1:57084\/x: ENOENT lstat \/img\/1$/);assert.doesNotMatch(String(d.message),/sekret/);
 assert.deepEqual(ordinaryLocalStartFailure(Object.assign(new Error('postgres://postgres:sekret@h/x'),{code:'OTHER'})),{status:'ORDINARY_LOCAL_START_FAILED',name:'Error'});
 assert.deepEqual(ordinaryLocalStartFailure('x'),{status:'ORDINARY_LOCAL_START_FAILED',name:'string'});
});
// MIG-1/4/6: every refusal of migrate() the operator acts on during an upgrade or a rollback prints its code and message.
test('a failed start prints the code and message of every migrate() refusal (failed migration, fence timeout, newer ledger, checksum)',async()=>{
 const {ordinaryLocalStartFailure}=await import('../server/ordinary-local-cli');
 const B=await import('../server/migration-bootstrap');
 for(const[e,code,re]of[
  [new B.MigrationFailedError('248_x','248_x.sql',['244_a','248_x'],new Error('at postgres://postgres:sekret@127.0.0.1/x: relation exists')),'MIGRATION_FAILED',/^Migracja 248_x .*postgres:\/\/\*\*\*@127\.0\.0\.1\/x: relation exists$/],
  [new B.MigrationLockTimeoutError(600000),'MIGRATION_LOCK_TIMEOUT',/inna instancja aplikacji .* 600 s/],
  [new B.NewerDatabaseError(['249_future']),'MIGRATION_LEDGER_NEWER_THAN_RELEASE',/nieznane tej wersji: 249_future/],
  [new B.MigrationChecksumError([{name:'015_a',file:'015_a.sql'}]),'MIGRATION_CHECKSUM_MISMATCH',/015_a \(015_a\.sql\)/],
 ]as const){
  const d=ordinaryLocalStartFailure(e);
  assert.deepEqual([d.status,d.name,d.code],['ORDINARY_LOCAL_START_FAILED',e.name,code]);assert.match(String(d.message),re);assert.doesNotMatch(String(d.message),/sekret/);
 }
});
