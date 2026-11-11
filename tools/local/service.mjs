/** Explicit macOS LaunchAgent around the existing local operator. Import is inert.
 * No automatic restart, PG management, kickstart, kill escalation, login installation or cloud action. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {validateProfile,assertSameBirth} from './operator.mjs';
import {validateStackProfile,stackStatus,stopStack} from './stack.mjs';
const exec=promisify(execFile),entry=fileURLToPath(import.meta.url),stackEntry=fileURLToPath(new URL('./stack.mjs',import.meta.url)),operatorEntry=fileURLToPath(new URL('./operator.mjs',import.meta.url));
const isStack=d=>d.schema==='dynaminds-local-macos-service/v2';
const controllerFile=d=>isStack(d)?d.stackStatePath:d.operatorStatePath;
const controllerBirth=(d,s)=>isStack(d)?s.controller:s.operator;
const cleanFlag=(d,s)=>isStack(d)?s.stack_clean_close===true:s.app_clean_close===true;
const sha=b=>createHash('sha256').update(b).digest('hex');
const absolute=p=>{assert(typeof p==='string'&&path.isAbsolute(p)&&path.resolve(p)===p&&!/[\x00-\x1f\x7f]/.test(p),'canonical-absolute-path-required');return p;};
const object=(v,keys)=>assert(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|'),'exact-object-required');
const hash=s=>assert(typeof s==='string'&&/^[a-f0-9]{64}$/.test(s),'sha256-required');
function read(file,privateFile=true,max=1024*1024){
 absolute(file);assert.equal(fs.realpathSync(file),file);const before=fs.lstatSync(file,{bigint:true});
 const cut=s=>[s.dev,s.ino,s.uid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
 assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.uid===BigInt(process.getuid())&&before.size<=BigInt(max),'owned-bounded-file-required');
 if(privateFile)assert.equal(before.mode&0o777n,0o600n,'private-file-required');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(before));const bytes=fs.readFileSync(fd);assert.equal(BigInt(bytes.length),before.size);assert.equal(cut(fs.fstatSync(fd,{bigint:true})),cut(before));assert.equal(cut(fs.lstatSync(file,{bigint:true})),cut(before));return bytes;}finally{fs.closeSync(fd);}
}
function fileHash(file,privateFile){return sha(read(file,privateFile,512*1024*1024));}
const pin=(file,privateFile=false)=>({path:absolute(fs.realpathSync(file)),sha256:fileHash(fs.realpathSync(file),privateFile)});
function verifyPin(ref,privateFile=false){object(ref,['path','sha256']);absolute(ref.path);hash(ref.sha256);assert.equal(fileHash(ref.path,privateFile),ref.sha256,'pinned-file-changed');}
function birth(pid){
 assert(Number.isSafeInteger(pid)&&pid>1);const field=name=>execFileSync('/bin/ps',['-p',String(pid),'-o',name+'='],{encoding:'utf8',timeout:3000,maxBuffer:8192}).trim();
 const uid=Number(field('uid')),started=field('lstart'),command=field('command');assert.equal(uid,process.getuid());assert(started&&command);
 return{pid,uid,started,command_sha256:sha(command)};
}
function live(expected){try{assertSameBirth(expected,birth(expected.pid));return true;}catch(e){
 // A reused PID is not our process. Permission/tool failures remain unconfirmed.
 if(e?.status===1)return false;
 if(e?.code==='ERR_ASSERTION'&&e?.message?.includes('operator-owned-process-birth-mismatch'))return false;
 throw e;
}}
const json=file=>JSON.parse(read(file));
function fresh(file,value){absolute(file);assert.equal(fs.realpathSync(path.dirname(file)),path.dirname(file));fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});}
function replace(file,value){const tmp=file+'.next-'+randomUUID();try{fresh(tmp,value);fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
const xml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export function validateService(value){
 const stack=value?.schema==='dynaminds-local-macos-service/v2';
 object(value,['schema','uid','label','domain','descriptorPath','statePath','claimPath','plist','node','service','operator','profile','stdoutPath','stderrPath','cwd',...(stack?['kind','stack','stackStatePath']:['operatorStatePath'])]);
 const d=structuredClone(value);assert.equal(d.schema,stack?'dynaminds-local-macos-service/v2':'dynaminds-local-macos-service/v1');
 if(stack){assert.equal(d.kind,'stack');assert.equal(d.stack?.path,stackEntry);assert.equal(d.operator?.path,operatorEntry);}assert.equal(d.uid,process.getuid());assert.equal(d.domain,'gui/'+d.uid);
 assert(typeof d.label==='string'&&/^pl\.dynaminds\.ecommerce\.[a-z][a-z0-9-]{0,63}$/.test(d.label),'scoped-launch-label-required');
 for(const k of ['descriptorPath','statePath','claimPath','stdoutPath','stderrPath','cwd',stack?'stackStatePath':'operatorStatePath'])absolute(d[k]);
 for(const k of ['plist','node','service','operator','profile',...(stack?['stack']:[])]){object(d[k],['path','sha256']);absolute(d[k].path);hash(d[k].sha256);}
 const files=[d.descriptorPath,d.statePath,controllerFile(d),d.claimPath,d.stdoutPath,d.stderrPath,...['plist','node','service','operator','profile',...(stack?['stack']:[])].map(k=>d[k].path)];
 assert.equal(new Set(files).size,files.length,'service-paths-must-be-disjoint');return d;
}
export function renderServicePlist(d){
 const args=[d.node.path,d.service.path,'run',d.descriptorPath];
 return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n'+
 `<key>Label</key><string>${xml(d.label)}</string>\n<key>ProgramArguments</key><array>${args.map(v=>'<string>'+xml(v)+'</string>').join('')}</array>\n`+
 `<key>WorkingDirectory</key><string>${xml(d.cwd)}</string>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>\n<key>ExitTimeOut</key><integer>120</integer><key>Umask</key><string>077</string>\n<key>ProcessType</key><string>Standard</string>\n`+
 `<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(os.homedir())}</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>\n`+
 `<key>StandardOutPath</key><string>${xml(d.stdoutPath)}</string><key>StandardErrorPath</key><string>${xml(d.stderrPath)}</string>\n</dict></plist>\n`;
}
function prepareDescriptor(profilePath,directory,label,stack){
 const profile=stack?validateStackProfile(json(profilePath)):validateProfile(json(profilePath));absolute(directory);assert.equal(fs.realpathSync(directory),directory);const st=fs.statSync(directory);assert(st.isDirectory()&&st.uid===process.getuid()&&(st.mode&0o077)===0,'private-owned-directory-required');
 const d={schema:'dynaminds-local-macos-service/v1',uid:process.getuid(),label,domain:'gui/'+process.getuid(),descriptorPath:path.join(directory,'service.private.json'),statePath:path.join(directory,'service-state.private.json'),operatorStatePath:path.join(directory,'operator-state.private.json'),claimPath:path.join(directory,'run-claim.private.json'),plist:{path:path.join(directory,'service.plist'),sha256:'0'.repeat(64)},node:pin(process.execPath),service:pin(entry),operator:pin(fileURLToPath(new URL('./operator.mjs',import.meta.url))),profile:pin(profilePath,true),stdoutPath:path.join(directory,'stdout.private.log'),stderrPath:path.join(directory,'stderr.private.log'),cwd:stack?directory:profile.cwd};
 if(stack){d.schema='dynaminds-local-macos-service/v2';d.kind='stack';d.stack=pin(stackEntry);d.stackStatePath=path.join(directory,'stack-state.private.json');delete d.operatorStatePath;}
 validateService(d);for(const f of [d.descriptorPath,d.statePath,controllerFile(d),d.claimPath,d.plist.path,d.stdoutPath,d.stderrPath])assert(!fs.existsSync(f),'fresh-service-directory-required');
 const plist=renderServicePlist(d);d.plist.sha256=sha(plist);
 fs.writeFileSync(d.plist.path,plist,{mode:0o600,flag:'wx'});fs.writeFileSync(d.stdoutPath,'',{mode:0o600,flag:'wx'});fs.writeFileSync(d.stderrPath,'',{mode:0o600,flag:'wx'});fresh(d.descriptorPath,d);
 return{status:'PREPARED',descriptor:d.descriptorPath,automatic_restart:false,PG_managed:false};
}
export const prepareService=(profile,directory,label)=>prepareDescriptor(profile,directory,label,false);
export const prepareStackService=(profile,directory,label)=>prepareDescriptor(profile,directory,label,true);

function load(descriptorPath){
 const bytes=read(descriptorPath),d=validateService(JSON.parse(bytes));assert.equal(d.descriptorPath,descriptorPath);
 for(const k of ['node','service','operator',...(isStack(d)?['stack']:[])])verifyPin(d[k]);verifyPin(d.profile,true);verifyPin(d.plist,true);
 assert.equal(sha(renderServicePlist(d)),d.plist.sha256,'generated-plist-drift');if(isStack(d))validateStackProfile(json(d.profile.path));else assert.equal(validateProfile(json(d.profile.path)).cwd,d.cwd);
 for(const p of [d.stdoutPath,d.stderrPath]){assert.equal(fs.realpathSync(p),p);const st=fs.lstatSync(p);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o777)===0o600,'private-owned-log-required');}
 return{d,digest:sha(bytes)};
}
function stateFor(d,digest){const s=json(d.statePath);assert.equal(s.schema,isStack(d)?'dynaminds-local-macos-service-state/v2':'dynaminds-local-macos-service-state/v1');if(isStack(d))assert.equal(s.kind,'stack');assert.equal(s.descriptor_sha256,digest);assert.equal(s.PG_managed,false);return s;}
function operatorState(d){const s=json(d.operatorStatePath);assert.equal(s.profile_sha256,d.profile.sha256);assert.equal(s.PG_managed,false);return s;}
function closed(s){return s?.status==='closed'&&s.exit_code===0&&s.signal===null;}
function stackState(d,s){
 const state=JSON.parse(read(d.stackStatePath,true,131072));assert.equal(state.schema,'dynaminds-local-stack-state/v1');assert.equal(state.profile_sha256,d.profile.sha256);assert.equal(state.PG_managed,false);
 assertSameBirth(controllerBirth(d,s),state.supervisor);
 assert(['starting','ready','draining','closed','close-unconfirmed'].includes(state.status),'known-stack-state-required');
 const specs=validateStackProfile(json(d.profile.path)).services;assert(Array.isArray(state.services)&&state.services.length<=specs.length&&Array.isArray(state.cleanup));
 const seen=new Set(),pids=new Set();for(const item of state.services){assert(item&&specs.some(v=>v.id===item.id)&&!seen.has(item.id),'unknown-or-duplicate-stack-service');seen.add(item.id);assert(['starting','ready','closed'].includes(item.status));assert(item.birth===null||item.birth&&Number.isSafeInteger(item.birth.pid)&&item.birth.pid>1&&item.birth.uid===process.getuid()&&typeof item.birth.started==='string'&&item.birth.started.length>0&&/^[a-f0-9]{64}$/.test(item.birth.command_sha256),'stack-child-birth-required');if(item.status!=='closed')assert(item.exit_code===null&&item.signal===null,'active-stack-child-cannot-be-exited');if(item.birth!==null){assert(!pids.has(item.birth.pid)&&item.birth.pid!==state.supervisor.pid&&item.birth.pid!==s.supervisor.pid,'duplicate-or-controller-stack-child-birth');pids.add(item.birth.pid);}}
 return state;
}
const stackClean=s=>s?.status==='closed'&&s.error===null&&Array.isArray(s.cleanup)&&s.cleanup.length===0&&s.services.every(c=>c.status==='closed'&&c.birth!==null&&c.exit_code===0&&c.signal===null);
const stackChildren=s=>s.services.filter(c=>c.birth!==null).map(c=>c.birth);
async function stackServiceStatus(d,s,p){
 const native=fs.existsSync(d.stackStatePath)?stackState(d,s):null;
 if(s.status==='closed'){
  if(!closed(s)||!cleanFlag(d,s)||!native||!stackClean(native))return{status:'CLOSE_UNCONFIRMED',PG_managed:false};
  return{status:[s.supervisor,controllerBirth(d,s),...stackChildren(native)].some(b=>p.live(b))?'CLOSING':'CLOSED',PG_managed:false};
 }
 assert(p.live(s.supervisor)&&p.live(controllerBirth(d,s)),'owned-stack-supervisors-not-live');
 if(!native)return{status:'STARTING',PG_managed:false};
 const observed=await p.stackStatus(d.profile.path,d.stackStatePath);assert.equal(observed.PG_managed,false);
 if(native.status==='closed'||native.status==='close-unconfirmed'||native.error!==null||native.cleanup.length)return{status:'CLOSE_UNCONFIRMED',PG_managed:false};
 const specs=validateStackProfile(json(d.profile.path)).services;
 const complete=native.status==='ready'&&observed.status==='ready'&&native.services.length===specs.length&&native.services.every(c=>c.status==='ready'&&c.birth!==null&&p.live(c.birth));
 const reported=Array.isArray(observed.services)&&observed.services.length===specs.length&&new Set(observed.services.map(c=>c.id)).size===specs.length&&specs.every(v=>observed.services.some(c=>c.id===v.id&&c.status==='ready'&&c.live===true&&c.ready===true));
 if(!complete||!reported)return{status:'STARTING',PG_managed:false};
 const latest=stackState(d,s);assert.equal(JSON.stringify(latest.services.map(c=>[c.id,c.birth,c.status,c.exit_code,c.signal])),JSON.stringify(native.services.map(c=>[c.id,c.birth,c.status,c.exit_code,c.signal])),'stack-readiness-observation-changed');assert.equal(latest.status,'ready');
 return{status:'READY',services:observed.services,PG_managed:false};
}

async function launchctl(args){try{const x=await exec('/bin/launchctl',args,{encoding:'utf8',timeout:10000,maxBuffer:65536,env:{HOME:os.homedir(),PATH:'/usr/bin:/bin:/usr/sbin:/sbin'}});return{code:0,stdout:x.stdout};}catch(e){return{code:Number.isInteger(e?.code)?e.code:null,stdout:typeof e?.stdout==='string'?e.stdout:''};}}
async function invokeOperator(d,mode){await exec(d.node.path,[d.operator.path,mode,d.profile.path,d.operatorStatePath],{encoding:'utf8',timeout:40000,maxBuffer:65536,env:{HOME:os.homedir(),PATH:'/usr/bin:/bin:/usr/sbin:/sbin'}});}
async function probe(profile){
 const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),5000);
 try{const r=await fetch('http://127.0.0.1:'+profile.httpPort+'/api/health',{signal:ac.signal,redirect:'error'});if(r.status!==200)return false;
  const reader=r.body.getReader();let bytes=0,chunks=[];try{for(;;){const{done,value}=await reader.read();if(done)break;bytes+=value.length;assert(bytes<=65536,'bounded-health-response-required');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  const x=JSON.parse(Buffer.concat(chunks).toString('utf8'));assert.equal(x.status,'ok');assert.equal(x.revision,profile.revision,'unexpected-health-revision');return true;
 }catch(e){if(e?.name==='AbortError'||e?.cause?.code==='ECONNREFUSED')return false;throw e;}finally{clearTimeout(timer);}
}
async function settleChild(ended,ms){let timer;try{return await Promise.race([ended,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('owned-operator-close-unconfirmed-no-escalation')),ms);})]);}finally{clearTimeout(timer);}}
export const systemPort={stackStatus,stopStack,spawnStack:d=>spawn(d.node.path,[d.stack.path,'start',d.profile.path,d.stackStatePath],{cwd:d.cwd,env:{HOME:os.homedir(),PATH:'/usr/bin:/bin:/usr/sbin:/sbin'},stdio:['ignore','inherit','inherit']}),settleChild,platform:process.platform,launchctl,birth,live,invokeOperator,probe,selfPid:process.pid,onSignal:(s,f)=>process.on(s,f),offSignal:(s,f)=>process.removeListener(s,f),spawnOperator:d=>spawn(d.node.path,[d.operator.path,'start',d.profile.path,d.operatorStatePath],{cwd:d.cwd,env:{HOME:os.homedir(),PATH:'/usr/bin:/bin:/usr/sbin:/sbin'},stdio:['ignore','inherit','inherit']}),now:()=>Date.now(),wait:ms=>new Promise(r=>setTimeout(r,ms))};
const portFor=port=>({...systemPort,...port});
export async function startService(descriptorPath,port={}){
 const p=portFor(port);assert.equal(p.platform,'darwin','macos-required');const{d,digest}=load(descriptorPath);
 assert(!fs.existsSync(d.statePath)&&!fs.existsSync(controllerFile(d))&&!fs.existsSync(d.claimPath),'fresh-service-state-required');
 fresh(d.statePath,{schema:isStack(d)?'dynaminds-local-macos-service-state/v2':'dynaminds-local-macos-service-state/v1',...(isStack(d)?{kind:'stack',controller:null}:{operator:null}),descriptor_sha256:digest,status:'requested',requested_at:p.now(),supervisor:null,exit_code:null,signal:null,PG_managed:false});
 // The acknowledgement may be lost after launchd accepted the job. Never retry bootstrap.
 const ack=await p.launchctl(['bootstrap',d.domain,d.plist.path]);
 return{status:ack.code===0?'START_REQUESTED':'START_UNCONFIRMED',automatic_restart:false,PG_managed:false};
}
export async function serviceStatus(descriptorPath,port={}){
 const p=portFor(port);assert.equal(p.platform,'darwin','macos-required');const{d,digest}=load(descriptorPath),s=stateFor(d,digest);
 if(!s.supervisor)return{status:'START_UNCONFIRMED',PG_managed:false};
 if(isStack(d))return stackServiceStatus(d,s,p);
 if(s.status==='closed'){const app=fs.existsSync(d.operatorStatePath)?operatorState(d):null;if(!closed(s)||s.app_clean_close!==true||!closed(app))return{status:'CLOSE_UNCONFIRMED',PG_managed:false};return{status:p.live(s.supervisor)||p.live(s.operator)||p.live(app.birth)?'CLOSING':'CLOSED',PG_managed:false};}
 assert(p.live(s.supervisor),'owned-service-supervisor-not-live');assert(s.operator&&p.live(s.operator),'owned-operator-not-live');
 if(!fs.existsSync(d.operatorStatePath))return{status:'STARTING',PG_managed:false};
 const app=operatorState(d);assert(app.status==='starting-or-running','operator-not-running');assert(p.live(app.birth),'owned-app-not-live');
 return{status:await p.probe(validateProfile(json(d.profile.path)))?'READY':'STARTING',revision:validateProfile(json(d.profile.path)).revision,PG_managed:false};
}
/** Supplemental refusal check only. launchctl's human output is never READY or PID authority.
 * A changed/unknown format refuses bootout; absence of an original PID alone is insufficient. */
export function registrationIsInactive(output,expectedPlist){
 if(typeof output!=='string'||typeof expectedPlist!=='string')return false;
 const paths=output.split('\n').map(l=>l.trim()).filter(l=>l.startsWith('path = '));
 return paths.length===1&&paths[0]==='path = '+expectedPlist&&/^\s*state = not running\s*$/m.test(output)&&!/^\s*pid = /m.test(output);
}
async function stopStackService(d,digest,s,p){
 assert(s.supervisor&&controllerBirth(d,s),'owned-stack-birth-not-confirmed');let native=stackState(d,s);
 if(!stackClean(native))assert(p.live(s.supervisor)&&p.live(controllerBirth(d,s)),'owned-stack-supervisors-not-live');
 await p.stopStack(d.profile.path,d.stackStatePath);native=stackState(d,s);assert(stackClean(native),'stack-clean-close-not-confirmed');
 const deadline=p.now()+10000;
 while(p.live(s.supervisor)||p.live(controllerBirth(d,s))){assert(p.now()<deadline,'service-close-unconfirmed-no-bootout');await p.wait(100);s=stateFor(d,digest);}
 s=stateFor(d,digest);assert(closed(s)&&cleanFlag(d,s),'stack-wrapper-clean-close-not-confirmed');assert(stackChildren(native).every(b=>!p.live(b)),'original-stack-child-still-live');
 const observed=await p.launchctl(['print',d.domain+'/'+d.label]);assert(observed.code===0&&registrationIsInactive(observed.stdout,d.plist.path),'registration-not-proven-inactive-no-bootout');
 const removed=await p.launchctl(['bootout',d.domain+'/'+d.label]);assert.equal(removed.code,0,'registration-removal-unconfirmed');return{status:'CLOSED_AND_UNREGISTERED',PG_managed:false,automatic_restart:false};
}

export async function stopService(descriptorPath,port={}){
 const p=portFor(port);assert.equal(p.platform,'darwin','macos-required');const{d,digest}=load(descriptorPath);let s=stateFor(d,digest);
 if(isStack(d))return stopStackService(d,digest,s,p);
 assert(s.supervisor&&s.operator,'owned-service-birth-not-confirmed');let app=operatorState(d);
 if(!closed(app)){assert(p.live(s.supervisor)&&p.live(s.operator)&&p.live(app.birth),'owned-service-process-not-live');await p.invokeOperator(d,'stop');}
 app=operatorState(d);assert(closed(app),'owned-app-clean-close-not-confirmed');
 const deadline=p.now()+10000;
 while(p.live(s.supervisor)||p.live(s.operator)){assert(p.now()<deadline,'service-close-unconfirmed-no-bootout');await p.wait(100);s=stateFor(d,digest);}
 s=stateFor(d,digest);assert(closed(s)&&s.app_clean_close===true,'service-clean-close-not-confirmed');assert(!p.live(app.birth),'original-app-still-live');
 const observed=await p.launchctl(['print',d.domain+'/'+d.label]);
 assert(observed.code===0&&registrationIsInactive(observed.stdout,d.plist.path),'registration-not-proven-inactive-no-bootout');
 // All owned processes are already closed. Never bootout a live job to stop it.
 const removed=await p.launchctl(['bootout',d.domain+'/'+d.label]);assert.equal(removed.code,0,'registration-removal-unconfirmed');
 return{status:'CLOSED_AND_UNREGISTERED',PG_managed:false,automatic_restart:false};
}
export async function runService(descriptorPath,port={}){
 const p=portFor(port);assert.equal(p.platform,'darwin','macos-required');const{d,digest}=load(descriptorPath),requested=stateFor(d,digest);assert.equal(requested.status,'requested');assert.equal(requested.supervisor,null);
 fresh(d.claimPath,{schema:'dynaminds-local-macos-service-run-claim/v1',descriptor_sha256:digest});
 let child,ended,forwarded=false,requestedStop=false;
 const forward=()=>{requestedStop=true;if(child&&!forwarded){forwarded=true;child.kill('SIGTERM');}};
 for(const sig of ['SIGINT','SIGTERM'])p.onSignal(sig,forward);
 try{
  assert(!fs.existsSync(controllerFile(d)),'fresh-controller-state-required');
  if(requestedStop)throw Error('service-stop-before-spawn');
  child=isStack(d)?p.spawnStack(d):p.spawnOperator(d);
  ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(exit_code,signal)=>resolve({exit_code,signal}));});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  const s={...requested,status:'starting',supervisor:p.birth(p.selfPid),...(isStack(d)?{controller:p.birth(child.pid)}:{operator:p.birth(child.pid)})};replace(d.statePath,s);if(requestedStop)forward();
  const exit=await ended;const app=fs.existsSync(controllerFile(d))?(isStack(d)?stackState(d,s):operatorState(d)):null;
  const clean=isStack(d)?app!==null&&stackClean(app)&&stackChildren(app).every(b=>!p.live(b)):closed(app);
  replace(d.statePath,{...s,status:'closed',exit_code:exit.exit_code,signal:exit.signal,...(isStack(d)?{stack_clean_close:clean}:{app_clean_close:clean})});
  if(!clean||exit.exit_code!==0||exit.signal!==null)process.exitCode=1;
  return{status:clean&&exit.exit_code===0&&exit.signal===null?'CLOSED':'CLOSE_UNCONFIRMED',PG_managed:false};
 }catch(first){if(child&&child.exitCode===null&&child.signalCode===null){try{forward();if(ended)await p.settleChild(ended,isStack(d)?70000:40000);}catch{}}throw first;}finally{for(const sig of ['SIGINT','SIGTERM'])p.offSignal(sig,forward);}
}
const safeFailure=e=>({status:'LOCAL_SERVICE_FAILED',code:typeof e?.code==='string'?e.code:null,message_sha256:sha(String(e?.message??''))});
export async function main(args){
 const[mode,...rest]=args;
 if(mode==='prepare'||mode==='prepare-stack'){assert.equal(rest.length,3,'usage-prepare-profile-private-directory-label');return mode==='prepare'?prepareService(...rest):prepareStackService(...rest);}
 assert.equal(rest.length,1,'usage-start-status-stop-descriptor');
 if(mode==='start')return startService(rest[0]);if(mode==='status')return serviceStatus(rest[0]);if(mode==='stop')return stopService(rest[0]);if(mode==='run')return runService(rest[0]);throw Error('unknown-service-command');
}
if(process.argv[1]&&path.resolve(process.argv[1])===entry)main(process.argv.slice(2)).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(JSON.stringify(safeFailure(e)));process.exitCode=1;});
