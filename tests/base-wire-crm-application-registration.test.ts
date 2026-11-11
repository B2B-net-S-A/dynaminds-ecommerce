/** Actual buildApp registration source, kept with the future app/auth/SQL
 * integration package. Unlike the standalone lifecycle component, this test
 * requires the connector.php family registry to be wired into app.ts; it must not be
 * included in a source-component commit that deliberately leaves app unchanged.
 * This evaluates the original registration statement, not a running application.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOrdinaryRequestLifetime } from '../server/ordinary-request-lifetime';
import { createBaseWireCrmFamily } from '../server/base-wire-crm-routes';
import { BASE_WIRE_CRM_DISPATCH_METHODS } from '../server/base-wire-crm-dispatch';
import { BASE_WIRE_CRM_DICTIONARY_METHODS } from '../server/base-wire-crm-dictionaries';
import { createBaseWireInventoryFamily, BASE_WIRE_INVENTORY_METHODS } from '../server/base-wire-inventory';
import { createBaseWireOrdersFamily, BASE_WIRE_ORDERS_METHODS } from '../server/base-wire-orders';
import { createBaseWireFulfillmentFamily, BASE_WIRE_FULFILLMENT_METHODS } from '../server/base-wire-fulfillment';
import { createBaseWireInvoicesFamily, BASE_WIRE_INVOICES_METHODS } from '../server/base-wire-invoices';
import { createBaseWireJournalFamily, BASE_WIRE_JOURNAL_METHODS } from '../server/base-wire-journal';
import { createBaseWireReturnsFamily, BASE_WIRE_RETURNS_METHODS } from '../server/base-wire-returns';
import { createBaseWireWmsFamily, BASE_WIRE_WMS_METHODS } from '../server/base-wire-wms';
import { createBaseWireFamilyRegistry } from '../server/base-wire-routes';

const source=readFileSync(new URL('../server/app.ts',import.meta.url),'utf8');
function evaluate(dictionaryAvailable:boolean,inventoryAvailable=true,ordersAvailable=true,readOnly=false,mergeClaims=true,fulfillmentAvailable=true,pickingWaves=true,invoicesAvailable=true,journalAvailable=true,categoriesAvailable=true,deletionsAvailable=true) {
  const start=source.indexOf('  registerBaseWireRoutes(app, {');
  assert(start>0);const end=source.indexOf(' });',start);assert(end>start);
  const code=source.slice(start,end+4);
  const lifetime=createOrdinaryRequestLifetime(),service={},inventoryService={execute:async()=>({})},ordersService={execute:async()=>({})},fulfillmentService={execute:async()=>({})},demoLabel=async()=>'',invoicesService={execute:async()=>({})},journalService={execute:async()=>({})},returnsService={execute:async()=>({})},wmsService={execute:async()=>({})},authenticated:unknown[][]=[],touched:unknown[][]=[];let selected:any,capabilities:any,inventoryOptions:any,ordersOptions:any,fulfillmentOptions:any,invoicesOptions:any,journalOptions:any,returnsOptions:any,wmsOptions:unknown[]|undefined;
  new Function('registerBaseWireRoutes','app','createBaseWireCrmFamily','createDefaultBaseWireCrmDispatch','baseWireCrmAvailable','baseWireDictionaryAvailable','readOnly','ordinaryRequestLifetime','authenticateBaseWireApiKey','workspaceMfaPolicyAvailable','createBaseWireInventoryFamily','createDefaultBaseWireInventoryService','baseWireInventoryAvailable','createBaseWireOrdersFamily','createDefaultBaseWireOrdersService','baseWireOrdersAvailable','orderMergeClaimsAvailable','createBaseWireFulfillmentFamily','createDefaultBaseWireFulfillmentService','baseWireFulfillmentAvailable','pickingWavesAvailable','demoShipmentLabelInTx','createBaseWireInvoicesFamily','createDefaultBaseWireInvoicesService','baseWireInvoicesAvailable','createBaseWireJournalFamily','createDefaultBaseWireJournalService','baseWireJournalAvailable','createBaseWireReturnsFamily','createDefaultBaseWireReturnsService','createBaseWireWmsFamily','createDefaultBaseWireWmsService','orderMergesIsAvailable','orderSplit222IsAvailable','returnReasons223IsAvailable','sessionName','baseWireCategoriesAvailable','productDeletionsAvailable','authSecurity237Available','touchApiKey',code)(
    (_app:any,opts:any)=>{selected=opts;},{},createBaseWireCrmFamily,(c:any)=>{capabilities=c;return service;},true,dictionaryAvailable,readOnly,lifetime,
    (...args:unknown[])=>{authenticated.push(args);return {};},true,createBaseWireInventoryFamily,(o:any)=>{inventoryOptions=o;return inventoryService;},inventoryAvailable,
    createBaseWireOrdersFamily,(o:any)=>{ordersOptions=o;return ordersService;},ordersAvailable,mergeClaims,
    createBaseWireFulfillmentFamily,(o:any)=>{fulfillmentOptions=o;return fulfillmentService;},fulfillmentAvailable,pickingWaves,demoLabel,
    createBaseWireInvoicesFamily,(o:any)=>{invoicesOptions=o;return invoicesService;},invoicesAvailable,
    createBaseWireJournalFamily,(o:any)=>{journalOptions=o;return journalService;},journalAvailable,
    createBaseWireReturnsFamily,(o:any)=>{returnsOptions=o;return returnsService;},
    createBaseWireWmsFamily,(...o:unknown[])=>{wmsOptions=o;return wmsService;},mergeClaims,mergeClaims,mergeClaims,'dyna_session',categoriesAvailable,deletionsAvailable,
    true,async(...args:unknown[])=>{touched.push(args);});
  return {selected,capabilities,lifetime,service,inventoryService,inventoryOptions,ordersService,ordersOptions,fulfillmentService,fulfillmentOptions,demoLabel,invoicesService,invoicesOptions,journalService,journalOptions,returnsService,returnsOptions,wmsService,wmsOptions,authenticated,touched};
}
test('actual buildApp registration supplies the authentic lifetime handle and CRM family to the registry',async()=>{
  const r=evaluate(true);
  assert.equal(r.selected.requestLifetime,r.lifetime);assert.equal(r.selected.readOnly,false);
  // Both CRM method lanes are dispatched; 219 dictionaries follow the startup table check.
  assert.deepEqual(r.capabilities,{crm218Verified:true,dictionary219Verified:true,readOnly:false});
  assert.equal(r.selected.families.length,8);const [crm,inventory,orders,fulfillment,invoices,journal,returns,wms]=r.selected.families;
  assert.equal(crm.service,r.service);assert.equal(crm.available,true);assert.equal(crm.label,'CRM');
  assert.deepEqual([...crm.methods],[...BASE_WIRE_CRM_DISPATCH_METHODS]);
  for(const method of BASE_WIRE_CRM_DICTIONARY_METHODS)crm.admit(method);
  // The registry's authenticate forwards any server-selected scope and the MFA capability.
  await r.selected.authenticate('closed-token','orders:read','10.0.0.7');assert.deepEqual(r.authenticated,[['closed-token','orders:read',true]]);
  // 237: the authenticated key's last use is stamped with the caller address (at most once a minute, in touchApiKey).
  assert.deepEqual(r.touched,[[{},'10.0.0.7']]);
  // Second family: 220 inventory, inventory:* scopes (products:write for PIM writes), native credential custody.
  assert.equal(inventory.service,r.inventoryService);assert.equal(inventory.available,true);assert.equal(inventory.nativeCredentialCustody,true);
  assert.deepEqual([...inventory.methods],[...BASE_WIRE_INVENTORY_METHODS]);
  // 224 categories follow their own startup check; read-only copies never allocate category IDs.
  assert.deepEqual(r.inventoryOptions,{readOnly:false,categories:true,deletions:true});
  assert.deepEqual(evaluate(true,true,true,true,true,true,true,true,true,false).inventoryOptions,{readOnly:true,categories:false,deletions:true});
  // 225 deleted state (deleteInventoryProduct, hidden in reads) follows its own startup check.
  assert.deepEqual(evaluate(true,true,true,false,true,true,true,true,true,true,false).inventoryOptions,{readOnly:false,categories:true,deletions:false});
  assert.deepEqual(inventory.methods.map((m:string)=>[inventory.scope(m),inventory.isWrite(m)]),[['inventory:read',false],['inventory:read',false],['inventory:read',false],['inventory:read',false],['inventory:write',true],
    ['inventory:read',false],['inventory:read',false],['inventory:read',false],['inventory:read',false],['products:write',true],['products:write',true],['products:write',true]]);
  // Third family: 220 orders, orders:*/order-fields:* scopes, credential custody for the native order merge and 222 split;
  // read-only copies never allocate on read.
  assert.equal(orders.service,r.ordersService);assert.equal(orders.available,true);assert.equal(orders.nativeCredentialCustody,true);
  assert.deepEqual(r.ordersOptions,{readOnly:false,mergeClaims:true,orderMerges:true,orderSplits:true,sessionName:'dyna_session'});
  assert.deepEqual([...orders.methods],[...BASE_WIRE_ORDERS_METHODS]);
  assert.deepEqual(orders.methods.map((m:string)=>[orders.scope(m),orders.isWrite(m)]),[['orders:read',false],['orders:write',true],['orders:read',false],['orders:write',true],
    ['orders:read',false],['orders:read',false],['order-fields:read',false],['order-fields:write',true],['orders:write',true],['orders:read',false],['orders:write',true],['orders:write',true]]);
  // Fourth family: fulfillment, orders:* scopes, the native demo label page from app.ts.
  assert.equal(fulfillment.service,r.fulfillmentService);assert.equal(fulfillment.available,true);assert.equal(fulfillment.nativeCredentialCustody,undefined);
  assert.deepEqual(r.fulfillmentOptions,{demoLabel:r.demoLabel,mergeClaims:true});
  assert.deepEqual([...fulfillment.methods],[...BASE_WIRE_FULFILLMENT_METHODS]);
  assert.deepEqual(fulfillment.methods.map((m:string)=>[fulfillment.scope(m),fulfillment.isWrite(m)]),[['orders:read',false],['orders:write',true],['orders:write',true],['orders:read',false],
    ['orders:read',false],['orders:read',false],['orders:read',false],['orders:read',false]]);
  for(const method of BASE_WIRE_FULFILLMENT_METHODS)fulfillment.admit(method);
  // Fifth family: native local invoices, documents:* scopes, credential custody for the native invoice identity frame.
  assert.equal(invoices.service,r.invoicesService);assert.equal(invoices.available,true);assert.equal(invoices.nativeCredentialCustody,true);
  assert.deepEqual(r.invoicesOptions,{readOnly:false});
  assert.deepEqual([...invoices.methods],[...BASE_WIRE_INVOICES_METHODS]);
  assert.deepEqual(invoices.methods.map((m:string)=>[invoices.scope(m),invoices.isWrite(m)]),[['documents:read',false],['documents:write',true],['documents:read',false],['documents:read',false]]);
  // Sixth family: 221 journal, orders:read only, no credential custody; read-only copies never allocate log IDs.
  assert.equal(journal.service,r.journalService);assert.equal(journal.available,true);assert.equal(journal.nativeCredentialCustody,undefined);
  assert.deepEqual(r.journalOptions,{readOnly:false});
  assert.deepEqual([...journal.methods],[...BASE_WIRE_JOURNAL_METHODS]);
  assert.deepEqual(journal.methods.map((m:string)=>[journal.scope(m),journal.isWrite(m)]),[['orders:read',false]]);
  // Seventh family: native RMA returns, orders:* scopes, no credential custody; available with the 220 orders family.
  assert.equal(returns.service,r.returnsService);assert.equal(returns.available,true);assert.equal(returns.nativeCredentialCustody,undefined);
  assert.equal(returns.label,'zwrotów');assert.deepEqual(r.returnsOptions,{readOnly:false,reasons:true});
  assert.deepEqual([...returns.methods],[...BASE_WIRE_RETURNS_METHODS]);
  assert.deepEqual(returns.methods.map((m:string)=>[m,returns.scope(m),returns.isWrite(m)]),[['getOrderReturnStatusList','orders:read',false],['addOrderReturn','orders:write',true],
    ['getOrderReturns','orders:read',false],['setOrderReturnStatus','orders:write',true],['setOrderReturnRefund','orders:write',true],['getOrderReturnPaymentsHistory','orders:read',false],['getOrderReturnReasonsList','orders:read',false]]);
  // Eighth family: native WMS (documents, purchasing, stocktakes), inventory:*/purchasing:* scopes, no credential custody,
  // no startup options; available with the 220 inventory family (warehouse/product identities).
  assert.equal(wms.service,r.wmsService);assert.equal(wms.available,true);assert.equal(wms.nativeCredentialCustody,undefined);
  assert.equal(wms.label,'WMS');assert.deepEqual(r.wmsOptions,[]);
  assert.deepEqual([...wms.methods],[...BASE_WIRE_WMS_METHODS]);
  assert.deepEqual(wms.methods.map((m:string)=>[m,wms.scope(m),wms.isWrite(m)]),[['getInventoryDocuments','inventory:read',false],['getInventoryDocumentItems','inventory:read',false],
    ['addInventoryDocument','inventory:write',true],['addInventoryDocumentItems','inventory:write',true],['setInventoryDocumentStatusConfirmed','inventory:write',true],
    ['getInventoryPurchaseOrders','purchasing:read',false],['getInventoryPurchaseOrderItems','purchasing:read',false],['addInventoryPurchaseOrder','purchasing:write',true],
    ['addInventoryPurchaseOrderItems','purchasing:write',true],['setInventoryPurchaseOrderStatus','purchasing:write',true],['getInventorySuppliers','purchasing:read',false],
    ['addInventorySupplier','purchasing:write',true],['getInventoryStocktakes','inventory:read',false],['getInventoryStocktakeItems','inventory:read',false]]);
  // One registry owns every method exactly once.
  assert.deepEqual([...createBaseWireFamilyRegistry(r.selected.families).methods],[...BASE_WIRE_CRM_DISPATCH_METHODS,...BASE_WIRE_INVENTORY_METHODS,...BASE_WIRE_ORDERS_METHODS,...BASE_WIRE_FULFILLMENT_METHODS,...BASE_WIRE_INVOICES_METHODS,...BASE_WIRE_JOURNAL_METHODS,...BASE_WIRE_RETURNS_METHODS,...BASE_WIRE_WMS_METHODS]);
});
test('actual buildApp registration follows the 220 package check and the picking-wave capability',()=>{
  const r=evaluate(true,true,true,false,true,false,false);const [,,,fulfillment]=r.selected.families;
  assert.equal(fulfillment.available,false);
  assert.throws(()=>fulfillment.admit('addOrderPickList'),(e:any)=>e.status===503);
  for(const method of ['getOrderSources','createPackage','getLabel'])fulfillment.admit(method);
});
test('actual buildApp registration follows the local-invoice/220 invoice check and passes readOnly',()=>{
  const r=evaluate(true,true,true,true,true,true,true,false);const [,,,,invoices]=r.selected.families;
  assert.equal(invoices.available,false);assert.deepEqual(r.invoicesOptions,{readOnly:true});
});
test('actual buildApp registration follows the 220 order checks and passes readOnly/merge capabilities',()=>{
  const r=evaluate(true,true,false,true,false);const [,,orders,,,,returns]=r.selected.families;
  assert.equal(orders.available,false);assert.deepEqual(r.ordersOptions,{readOnly:true,mergeClaims:false,orderMerges:false,orderSplits:false,sessionName:'dyna_session'});
  // Returns follow the same 220 order check and receive readOnly (no identity allocation on read-only copies).
  assert.equal(returns.available,false);assert.deepEqual(r.returnsOptions,{readOnly:true,reasons:false});
});
test('actual buildApp registration follows the 221 journal check and passes readOnly',()=>{
  const r=evaluate(true,true,true,true,true,true,true,true,false);const [,,,,,journal]=r.selected.families;
  assert.equal(journal.available,false);assert.deepEqual(r.journalOptions,{readOnly:true});
});
test('actual buildApp registration follows the 220 startup check for the inventory family',()=>{
  const [,inventory,,,,,,wms]=evaluate(true,false).selected.families;assert.equal(inventory.available,false);
  // The WMS family needs the same 220 warehouse/product identities.
  assert.equal(wms.available,false);
});
test('actual buildApp registration keeps a missing 219 table closed for dictionaries only',()=>{
  const r=evaluate(false);const [crm]=r.selected.families;
  assert.deepEqual(r.capabilities,{crm218Verified:true,dictionary219Verified:false,readOnly:false});
  for(const method of BASE_WIRE_CRM_DICTIONARY_METHODS)assert.throws(()=>crm.admit(method),(e:any)=>e.status===503);
  crm.admit('getCrmClients');
});
