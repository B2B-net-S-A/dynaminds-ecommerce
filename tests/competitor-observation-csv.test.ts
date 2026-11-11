import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCompetitorObservationCsv as parse, CompetitorObservationCsvError as CsvError,
 COMPETITOR_OBSERVATION_COLUMNS as columns, COMPETITOR_OBSERVATION_LIMITS as limits} from '../web/competitor-observation-csv';
const header=columns.join(',');
const row=['product-a','shop-a','offer-a','seller-a','PLN','10001','499','true','2026-10-08T12:01:02.123456Z'];
const csv=(cells=row)=>header+'\n'+cells.join(',');
const bad=(value:string|Uint8Array,column:number,code= 'value')=>assert.throws(()=>parse(value),(e:unknown)=>e instanceof CsvError&&e.column===column&&e.code===code);

test('BOM, UTF8, quoted commas/quotes/newlines and CRLF retain exact IDs and minor-unit bigint',()=>{
 const r=[...row];r[2]='"oferta, ""żółta"""';r[3]='"seller\r\nsecond"';r[7]='false';r[8]='2026-10-08T12:01:02.123456+00:00';
 const parsed=parse(new TextEncoder().encode('\uFEFF'+header+'\r\n'+r.join(',')+'\r\n'));
 assert.equal(parsed.length,1);assert.equal(parsed[0].offer_id,'oferta, "żółta"');assert.equal(parsed[0].seller_id,'seller\r\nsecond');
 assert.equal(parsed[0].price_gross_minor,10001n);assert.equal(parsed[0].delivery_gross_minor,499n);assert.equal(parsed[0].available,false);assert.equal(parsed[0].observed_at,row[8]);
});
test('exact header and malformed quoting/record shapes fail atomically without leaking field values',()=>{
 bad(header.replace('product_id','product')+'\n'+row.join(','),1,'header');
 bad(header+'\n'+row.join(',')+'\n"secret-data',1,'syntax');
 bad(csv([...row.slice(0,8)]),9,'syntax');assert.equal(parse(csv()+'\n').length,1);bad(csv()+'\n\n',2,'syntax');
});
test('money canonical integer domain, explicit availability and real UTC calendar are required',()=>{
 for(const p of ['1.0','1e2','01','-1','+1','100000001',' 1']){const r=[...row];r[5]=p;bad(csv(r),6);}
 for(const a of ['1','0','TRUE','yes','']){const r=[...row];r[7]=a;bad(csv(r),8);}
 for(const stamp of ['2026-02-29T00:00:00Z','2024-02-30T00:00:00Z','2026-10-08T24:00:00Z','2026-10-08T12:00:00+02:00','2026-10-08T12:00:00.1234567Z']){const r=[...row];r[8]=stamp;bad(csv(r),9);}
 const r=[...row];r[5]='0';r[6]='100000000';r[8]='2024-02-29T23:59:59Z';assert.equal(parse(csv(r))[0].observed_at,'2024-02-29T23:59:59.000000Z');
});
test('duplicates use namespace+offer+canonical microsecond time+product, never seller or formatting',()=>{
 const r=[...row];r[3]='other-seller';r[8]='2026-10-08T12:01:02.123456+00:00';bad(csv()+'\n'+r.join(','),3,'duplicate');
 for(const i of [0,1,8]){const changed=[...row];changed[i]=i===8?'2026-10-08T12:01:02.123457Z':'other';assert.equal(parse(csv()+'\n'+changed.join(',')).length,2);}
});
test('full-file row and UTF8 byte budgets, encoding failures and row/column-only diagnostics',()=>{
 const many=Array.from({length:1000},(_,i)=>[row[0],row[1],'offer-'+i,...row.slice(3)].join(','));assert.equal(parse(header+'\n'+many.join('\n')).length,1000);
 bad(header+'\n'+many.join('\n')+'\n'+row.join(','),1,'rows');
 bad('x'.repeat(limits.bytes+1),1,'size');bad('ą'.repeat(limits.bytes/2+1),1,'size');bad(new Uint8Array([0xc3,0x28]),1,'encoding');bad(csv().replace('seller-a','\ud800'),1,'encoding');
 const secret='do-not-print-this-secret';const broken=[...row];broken[5]=secret;
 try{parse(csv(broken));assert.fail('must refuse');}catch(e){assert(e instanceof CsvError);assert.equal(e.row,2);assert.equal(e.column,6);assert(!e.message.includes(secret));assert.deepEqual(Object.keys(e).sort(),['code','column','name','row']);}
});
