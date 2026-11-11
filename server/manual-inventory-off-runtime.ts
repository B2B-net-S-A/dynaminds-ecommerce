/** Dedicated owner transaction hooks, no db import/pool acquisition at module load. */
import {beginWmsTransaction,endWmsTransaction,wmsLotsAdmissionInTx,enlistWmsActorInTx,finalizeWmsActorsInTx} from './wms-lots-transaction';
import {beginPurchasingTransaction,endPurchasingTransaction,purchasingStockAdmissionInTx} from './purchasing-transaction';
import {beginCatalogStockControlTransaction,endCatalogStockControlTransaction,catalogStockControlAdmissionInTx,enlistCatalogStockControlActorInTx,finalizeCatalogStockControlActorsInTx,finalizeCatalogStockCountTerminalInTx} from './catalog-stock-control-transaction';
import type {ManualOffHooks} from './manual-inventory-off';
export const manualOffNativeHooks:ManualOffHooks={
 begin(c){beginWmsTransaction(c);beginPurchasingTransaction(c);beginCatalogStockControlTransaction(c);},
 async admit(c,a,writing){
  await wmsLotsAdmissionInTx(c,a,writing?'shared':'read');
  if(writing){await purchasingStockAdmissionInTx(c,a);await catalogStockControlAdmissionInTx(c,a,'shared');enlistWmsActorInTx(c,a,{adminOnly:true});enlistCatalogStockControlActorInTx(c,a,{adminOnly:true,scopes:['inventory:read','inventory:write']});}
 },
 async finalize(c,a){await finalizeWmsActorsInTx(c);await finalizeCatalogStockControlActorsInTx(c);await finalizeCatalogStockCountTerminalInTx(c,[{actor:a,roles:['admin'],scopes:['inventory:read','inventory:write']}]);},
 end(c){endCatalogStockControlTransaction(c);endPurchasingTransaction(c);endWmsTransaction(c);}
};
