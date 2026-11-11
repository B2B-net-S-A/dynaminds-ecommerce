import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { publicApiDocument, publicOperations } from '../server/developer-api';
import * as V from '../server/order-parcels-values';

test('parcel inputs reject duplicate products, source identities and missing consent', () => {
  const product_id = randomUUID(), shipment_id = randomUUID();
  const parcel = { source_kind:'demo',products:[{product_id,quantity:1}],cod_minor:0 };
  const draft = { client_key:randomUUID(),order_version:'1',parcels:[parcel,parcel] };
  assert(V.orderParcelPreviewInput.safeParse(draft).success);
  assert(!V.orderParcelPreviewInput.safeParse({...draft,parcels:[parcel]}).success);
  assert(!V.orderParcelPreviewInput.safeParse({...draft,parcels:[{...parcel,products:[...parcel.products,...parcel.products]},parcel]}).success);
  assert(!V.orderParcelPreviewInput.safeParse({...draft,parcels:Array(51).fill(parcel)}).success);
  const existing = {...parcel,source_kind:'existing',shipment_id};
  assert(!V.orderParcelPreviewInput.safeParse({...draft,parcels:[existing,existing]}).success);
  assert(!V.orderParcelDraft.safeParse({...parcel,shipment_id}).success);
  assert(!V.orderParcelDraft.safeParse({...parcel,source_kind:'existing'}).success);
  assert(!V.orderParcelApplyInput.safeParse({client_key:randomUUID(),scope_hash:'a'.repeat(64),confirmed:false}).success);
  assert(!V.orderParcelDispatchInput.safeParse({client_key:randomUUID(),scope_hash:'a'.repeat(64)}).success);
});

test('parcel public API documents exact paths, dispatch index and restore read-only surface', () => {
  const operations = publicOperations.filter(o=>o.path.startsWith('/order-parcels/'));
  // The seven parcel-plan operations plus the five physical parcel WZ operations that share the
  // /order-parcels prefix (server/physical-parcel-wz-routes.ts, already in the 3f1003d baseline).
  assert.deepEqual(operations.map(o=>o.method+' '+o.path),[
    'GET /order-parcels/plans/:id/physical-wz/source','POST /order-parcels/plans/:id/physical-wz/previews',
    'GET /order-parcels/physical-wz/previews/:id','POST /order-parcels/physical-wz/previews/:id/apply',
    'GET /order-parcels/physical-wz/mappings/:id',
    'GET /order-parcels/orders/:id/source','POST /order-parcels/orders/:id/previews','GET /order-parcels/previews/:id',
    'POST /order-parcels/previews/:id/apply','GET /order-parcels/plans/:id',
    'POST /order-parcels/plans/:id/parcels/:index/dispatch','GET /order-parcels/orders/:id/history',
  ]);
  const doc:any = publicApiDocument();
  const dispatch = doc.paths['/order-parcels/plans/{id}/parcels/{index}/dispatch'].post;
  assert.deepEqual(dispatch.parameters.find((p:any)=>p.name==='index').schema,
    {type:'integer',minimum:0,maximum:49});
  assert.deepEqual(dispatch['x-required-scopes'],['orders:read','orders:write']);
  assert(dispatch.responses['423'] && dispatch.responses['503']);
  const history = doc.paths['/order-parcels/orders/{id}/history'].get;
  assert(history.parameters.some((p:any)=>p.in==='query' && p.name==='cursor'));
  const readOnly:any = publicApiDocument({readOnly:true});
  for(const o of operations) {
    const path = o.path.replace(/:([a-z_]+)/g,'{$1}');
    assert.equal(Boolean(readOnly.paths[path]?.[o.method.toLowerCase()]),o.method==='GET');
  }
});
