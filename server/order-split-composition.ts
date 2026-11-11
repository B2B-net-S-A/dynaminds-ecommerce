/** Temporary first-service boundary: split may not share a transaction with
 * another managed business duty. Its full finalizer can wait, so placing it
 * after a sibling's last clock would invalidate that sibling's deadline cut.
 * This is presence-based REFUSAL only, not IAM, Native or lease admission.
 * The actual manager calls it after the callback, BEFORE any prepare/finalize,
 * while every sibling ledger still exists (including original187 callbacks).
 * Full composition requires a future coordinated prepare/clock protocol. */
import type {PoolClient} from 'pg';
import {ensure} from './errors';
import {hasOrderSplitTransactionDuty} from './order-split-transaction';
import {hasPimTransactionDuty} from './pim-dictionaries/runtime';
import {hasMiraklSessionTransactionDuty} from './mirakl-session-authority';
import {hasPhysicalParcelWzTransactionDuty} from './physical-parcel-wz';
import {hasInventoryCorrectionTransactionDuty} from './inventory-correction';
import {hasFinancialReturn162TransactionDuty} from './financial-return-completion';
import {hasBuyerAddressTransactionDuty} from './buyer-address';
import {hasOperationalDeliveryTransactionDuty} from './operational-delivery-consumers';
import {hasCompetitorObservationTransactionDuty} from './competitor-observations';
import {hasAllegroAuthorityTransactionDuty} from './allegro-oauth-authority';
import {hasWmsTransactionDuty} from './wms-lots-transaction';
import {hasDispatchTransactionDuty} from './dispatch-transaction';
import {hasCatalogStockControlTransactionDuty} from './catalog-stock-control-transaction';

export function assertOrderSplitCompositionInTx(c:PoolClient):void{
 if(!hasOrderSplitTransactionDuty(c))return;
 ensure(!hasPimTransactionDuty(c)&&!hasMiraklSessionTransactionDuty(c)&&
  !hasPhysicalParcelWzTransactionDuty(c)&&!hasInventoryCorrectionTransactionDuty(c)&&
  !hasFinancialReturn162TransactionDuty(c)&&!hasBuyerAddressTransactionDuty(c)&&
  !hasOperationalDeliveryTransactionDuty(c)&&!hasCompetitorObservationTransactionDuty(c)&&
  !hasAllegroAuthorityTransactionDuty(c)&&!hasWmsTransactionDuty(c)&&
  !hasDispatchTransactionDuty(c)&&!hasCatalogStockControlTransactionDuty(c),409,
  'Podział i inne operacje biznesowe wymagają odrębnych transakcji');
}
