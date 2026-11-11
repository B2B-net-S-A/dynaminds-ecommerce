import assert from 'node:assert/strict';
import test from 'node:test';
import {recoveryPostgresPort, testPostgresPort} from '../server/test-postgres-port';

function withEnvironment(values:Record<string,string|undefined>,run:()=>void){
 const keys=['DATABASE_URL','DYNA_TEST','DYNA_TEST_PG_PORT'];
 const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{for(const k of keys){const value=values[k];if(value===undefined)delete process.env[k];else process.env[k]=value;}run();}
 finally{for(const k of keys){const value=before[k];if(value===undefined)delete process.env[k];else process.env[k]=value;}}
}

test('operator recovery accepts exact retained Main loopback port without test mode',()=>{
 for(const protocol of ['postgres','postgresql'])for(const host of ['127.0.0.1','localhost','[::1]'])for(const port of [1024,55432,57081,57149,65535])
  assert.equal(recoveryPostgresPort(`${protocol}://postgres:SYNTHETIC_ONLY@${host}:${port}/dynaminds_upgrade186_7173551c`),port);
});
test('recovery refuses remote/ambiguous addresses, wrong protocol or principal and URL overrides',()=>{
 for(const value of ['', 'garbage','https://postgres@127.0.0.1:57081/dynaminds','postgres://postgres@8.8.8.8:57081/dynaminds','postgres://postgres@127.1:57081/dynaminds','postgres://app@127.0.0.1:57081/dynaminds','postgres://postgres@127.0.0.1:57081/dynaminds?sslmode=disable','postgres://postgres@127.0.0.1:57081/dynaminds#fragment','postgres://postgres@127.0.0.1:57081/dynaminds/other','postgres://postgres@127.0.0.1:57081/a%2Fb','postgres://postgres@127.0.0.1:57081/Bad'])
  assert.throws(()=>recoveryPostgresPort(value));
});
test('recovery requires a bounded explicit URL port and database',()=>{
 for(const authority of ['127.0.0.1','127.0.0.1:0','127.0.0.1:1023','127.0.0.1:65536'])assert.throws(()=>recoveryPostgresPort(`postgres://postgres@${authority}/dynaminds`));
 assert.throws(()=>recoveryPostgresPort('postgres://postgres@127.0.0.1:57081/'));
});
test('ordinary default and historical test fallback remain independent',()=>{
 withEnvironment({},()=>assert.equal(recoveryPostgresPort(),55432));
 withEnvironment({DYNA_TEST_PG_PORT:'57149'},()=>assert.equal(recoveryPostgresPort(),55432));
 withEnvironment({DYNA_TEST:'true',DYNA_TEST_PG_PORT:'57149'},()=>assert.equal(recoveryPostgresPort(),57149));
 withEnvironment({DYNA_TEST:'true',DYNA_TEST_PG_PORT:'INVALID'},()=>assert.throws(()=>recoveryPostgresPort()));
});
test('trusted configured database wins fallback without changing test-port parser',()=>{
 withEnvironment({DATABASE_URL:'postgres://postgres:SYNTHETIC_ONLY@127.0.0.1:57081/dynaminds_upgrade186_7173551c',DYNA_TEST:'true',DYNA_TEST_PG_PORT:'INVALID'},()=>assert.equal(recoveryPostgresPort(),57081));
 assert.equal(testPostgresPort(undefined),55432);for(const value of ['0','80','65536','057081','+57081','57081.0','57081\n'])assert.throws(()=>testPostgresPort(value));
});
test('malformed secret-bearing selection never appears in errors',()=>{
 const sentinel='SYNTHETIC_SECRET_DO_NOT_PRINT';
 for(const value of [`postgres://postgres:${sentinel}@remote.invalid:57081/dynaminds`,`not-a-url-${sentinel}`])assert.throws(()=>recoveryPostgresPort(value),e=>e instanceof Error&&!e.message.includes(sentinel)&&!e.message.includes(value));
});
