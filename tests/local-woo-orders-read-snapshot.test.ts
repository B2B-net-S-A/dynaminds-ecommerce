/** Snapshot-bounded orders READ against a controlled store model that applies the
 * official wc/v3 `before` + `dates_are_gmt` filter (date_created_gmt < before). No HTTP. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readLocalWooOrders} from '../server/local-woo-orders-read';
import {LOCAL_WOO_ORIGINS} from '../shared/local-woo-origins';

const origin=LOCAL_WOO_ORIGINS[0];
const gmt=(ms:number)=>new Date(ms).toISOString().slice(0,19).replace('T',' ');
function store(initial:number,start:number){
 const orders:{id:number;date_created_gmt:string}[]=[],seen:URL[]=[];let clock=start;
 const add=()=>{clock+=7500;orders.push({id:orders.length+1,date_created_gmt:gmt(clock)});};
 for(let i=0;i<initial;i++)add();
 const transport=async(raw:string,_init:RequestInit)=>{
  const u=new URL(raw);seen.push(u);
  const before=u.searchParams.get('before'),gmtDates=u.searchParams.get('dates_are_gmt')==='true';
  const visible=orders.filter(o=>before===null||gmtDates&&o.date_created_gmt<before);
  const per=Number(u.searchParams.get('per_page')),page=Number(u.searchParams.get('page'));
  const rows=visible.slice((page-1)*per,page*per),pages=Math.ceil(visible.length/per);
  // A producer creates a new order while the paginated read is in flight.
  add();
  return new Response(JSON.stringify(rows),{status:200,headers:{'content-type':'application/json','x-wp-total':String(visible.length),'x-wp-totalpages':String(pages)}});
 };
 return{orders,seen,transport,now:()=>clock};
}

test('multi-page read stays complete while new orders arrive: fixed upper bound from read start',async()=>{
 const s=store(120,Date.parse('2026-10-30T10:00:00.000Z')),startedAt=s.now();
 const read=await readLocalWooOrders(s.transport,'Basic Y2s6Y3M=',origin,{now:()=>startedAt});
 assert.equal(read.pagination.pages,3);assert.equal(read.pagination.complete,true);
 assert.equal(read.data.length,read.pagination.unique_orders);
 const bound=s.seen[0].searchParams.get('before');
 assert.match(bound??'',/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
 assert(s.seen.every(u=>u.searchParams.get('before')===bound&&u.searchParams.get('dates_are_gmt')==='true'),'one bound for every page');
 assert(bound!<=gmt(startedAt),'bound is not after the read start');
 assert(read.data.every((o:any)=>o.date_created_gmt<bound!));
 // Orders created during the read are outside the bound and left for the next read.
 assert(s.orders.length>read.data.length);
 const next=await readLocalWooOrders(s.transport,'Basic Y2s6Y3M=',origin,{now:()=>s.now()+10000});
 assert(next.data.length>read.data.length);
 assert(read.data.every((o:any)=>next.data.some((n:any)=>n.id===o.id)));
});

test('a changed total inside the fixed bound is still refused as an incomplete read',async()=>{
 const s=store(60,Date.parse('2026-10-30T10:00:00.000Z')),startedAt=s.now();let calls=0;
 const late=async(raw:string,init:RequestInit)=>{const r=await s.transport(raw,init);if(++calls===1)s.orders.unshift({id:0,date_created_gmt:gmt(startedAt-60000)});return r;};
 await assert.rejects(readLocalWooOrders(late,'Basic Y2s6Y3M=',origin,{now:()=>startedAt}),(e:any)=>e.status===409);
});
