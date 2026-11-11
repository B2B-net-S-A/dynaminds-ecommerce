import { orderRecipientName } from '../shared/order-invoice-party';
import {registerLocalWooOrderImportRoutes} from './local-woo-order-import-routes';
import type {createLocalWooOrderImport} from './local-woo-order-import';
import {assertOrdinaryConnectorJobExecution,registerOrdinaryConnectorJobs,type OrdinaryConnectorJobExecution} from './ordinary-connector-jobs';
import {parseMiraklCredentials, safeMiraklPublicSettings, miraklChannelConnectionHash, type MiraklReadRepository} from './mirakl-channel';
import {registerMiraklReadRoutes, captureMiraklReadActor, type MiraklReadActor} from './mirakl-read-routes';
import {enlistMiraklSessionAuthorityInTx, assertMiraklSessionAuthorityInTx} from './mirakl-session-authority';
import {stageOrders} from './imports';
import {registerNbpRoutes,type NbpRatesPort} from './nbp-routes';
import { orderStatusInput } from './order-status-input';
import { registerOrderEditRoutes } from './order-edit-routes';
import { registerOrderLookupRoutes } from './order-lookup-routes';
import { cardPayload } from './order-sections';
import {registerAutomaticWorkerControl} from './local-automation-worker-control';
import {startScopedAutomationWorker} from './scoped-automation-worker';
import {registerWorkerSupervisionRoutes} from './worker-supervision-routes';
import { requestLogUrl } from './request-log';
import { createReplyWarningLog } from './reply-warning-log';
import {createScopedProcessorControl} from './scoped-automation-processor';
import {registerReconciliationQueueRoutes} from './reconciliation-queue';
import {registerMessageOutcomeRoutes} from './message-outcome';
import {installOrdinaryRequestLifetime,runOrdinaryRequestError,hasOrdinaryRequestAdmission,inspectOrdinaryRequests,type OrdinaryRequestLifetime} from './ordinary-request-lifetime';
import {validateRecoveredPimBeforeReadonly} from './pim-dictionaries/recovery-gate';
import {createPimService} from './pim-dictionaries/service';
import {registerPimRoutes} from './pim-dictionaries/routes';
import {preflightPim} from './pim-dictionaries/runtime';
import {preflightNestedPim} from './pim-dictionaries/nested-capability';
import {createManualOffService,manualOffAvailable} from './manual-inventory-off';
import {manualOffNativeHooks} from './manual-inventory-off-runtime';
import {registerManualOffRoutes} from './manual-inventory-off-routes';
import { inventoryAdjustInput, inventoryCorrectionPreviewInput } from './inventory-correction-schema';
import { captureInventoryCorrectionActor, previewInventoryCorrection, readInventoryCorrectionPreview, executeInventoryCorrection, enlistInventoryLegacyAdjustmentInTx } from './inventory-correction';
import {preflightPhysicalParcelWz,createPhysicalParcelWzService} from './physical-parcel-wz';
import {registerPhysicalParcelWzRoutes} from './physical-parcel-wz-routes';
import {registerB2bCreditRoutes} from './b2b-credit-routes';
import {registerB2bInvoiceRoutes} from './b2b-invoice-routes';
import {registerFa3DraftRoutes} from './fa3-draft-routes';
import {registerFa3DocumentRoutes} from './fa3-document-routes';
import { registerJpkRoutes } from './jpk-routes';
import {localInvoicesAvailable,localInvoiceRequestActor,localInvoiceDetail} from './local-invoices';
import {registerLocalInvoiceRoutes} from './local-invoice-routes';
import {registerLocalConsumerCreditRoutes} from './local-consumer-credit-routes';
import {registerReturnCredit206Routes} from './return-credit206-routes';
import {localInvoicePrintHtml} from './local-invoice-print';
import { packedLabelPrintAvailable } from './packed-label-print';
import { registerPackedLabelPrintRoutes } from './packed-label-print-routes';
import { registerProductRuleScheduleRoutes } from './product-rule-schedules';
import {
  registerB2bExternalOrderIntentRoutes,
  b2bExternalOrderIntentsAvailable,
} from './b2b-external-order-intents';
import {
  registerB2bExternalOrderImportRoutes,
  b2bExternalOrderImportsAvailable,
} from './b2b-external-order-imports';
import {
  registerB2bDropshippingReturnRoutes,
  b2bDropshippingReturnsAvailable,
} from './b2b-dropshipping-returns';
import { b2bReturnLocalOriginsAvailable } from './b2b-return-local-origins';
import { validateTrustedLocalUiOrigin } from './local-ui-origin';
import { transitionDirectLegacyOnReturnInTx } from './legacy-return-on-command';
import { returnExchangeAvailable, returnExchangeSubstitutionsAvailable } from './return-exchanges';
import { registerSalesReportRoutes } from './sales-report-routes';
import { registerSettlementReportRoutes } from './settlement-report-routes';
import { registerProductRuleRoutes } from './product-rule-routes';
import { registerOrderProductLogisticsRoutes } from './order-product-logistics';
import { productLogisticsAvailable, productLogisticsRequestActor } from './product-logistics';
import { productSkuAvailable } from './product-sku';
import { registerInventoryBulkEditRoutes } from './inventory-bulk-edit-routes';
import { registerPriceBulkEditRoutes } from './price-bulk-edit-routes';
import { registerPriceFileImportRoutes } from './price-file-import-routes';
import { priceFileImportAvailable } from './price-file-import';
import { registerPriceMatrixImportRoutes } from './price-matrix-import-routes';
import { priceMatrixImportAvailable } from './price-matrix-import';
import { registerStockFileImportRoutes } from './stock-file-import-routes';
import { registerLanguageFileImportRoutes } from './language-file-import-routes';
import { languageFileImportAvailable } from './language-file-import';
import { stockFileImportAvailable } from './stock-file-import';
import { registerProductTranslationBulkEditRoutes } from './product-translation-bulk-edit-routes';
import { registerPackingWorkstationRoutes } from './packing-workstation-routes';
import { registerPackingPhotoRoutes } from './packing-photo-routes';
import { assertWmsLegacyQuantityWriteInTx } from './wms-lots';
import { registerWmsLotsRoutes } from './wms-lots-routes';
import { registerWmsStocktakeRoutes } from './wms-stocktake-routes';
import { registerStocktakeScanRoutes } from './stocktake-scan-routes';
import { registerPaymentImportRoutes } from './payment-import-routes';
import { paymentImportAllocationsAvailable } from './payment-import-allocations';
import { proformasAvailable } from './proformas';
import { registerProformaRoutes } from './proforma-routes';
import { proformaBatchesAvailable } from './proforma-batches';
import { registerProformaBatchRoutes } from './proforma-batch-routes';
import { printJobsAvailable } from './print-jobs';
import { registerPrintJobRoutes } from './print-job-routes';
import { shipmentLabelPrintAvailable } from './shipment-label-print';
import { registerShipmentLabelPrintRoutes } from './shipment-label-print-routes';
import { shipmentLabelCacheAvailable } from './shipment-label-cache';
import { registerShipmentLabelCacheRoutes } from './shipment-label-cache-routes';
import { shipmentLabelBatchesAvailable } from './shipment-label-batches';
import { registerShipmentLabelBatchRoutes } from './shipment-label-batch-routes';
import { orderParcelsAvailable } from './order-parcels';
import { registerOrderParcelRoutes } from './order-parcels-routes';
import { orderParcelReleasesAvailable } from './order-parcel-releases';
import { registerOrderParcelReleaseRoutes } from './order-parcel-releases-routes';
import { registerPaymentImportAllocationRoutes } from './payment-import-allocation-routes';
import { registerOrderFieldRoutes } from './order-field-routes';
import { registerOrderFieldBatchRoutes } from './order-field-batch-routes';
import { registerOrderFieldMappingRoutes } from './order-field-mapping-routes';
import { orderFieldFiltersSchema, orderFieldColumnsSchema } from './order-fields-schema';
import { orderFieldListScopeInTx, projectOrderFieldColumnsInTx } from './order-fields';
import {
  OrderListParams,
  OrderListUnavailable,
  orderListConditions,
  orderListFilterOptions,
  orderListPaging,
  orderListQuerySchema,
  orderListSql,
  withPaymentFields,
  type OrderListAvailability,
} from './order-list-query';
import { orderChannelData } from './channel-projection';
import { registerWorkspaceBillingRoutes } from './workspace-billing-routes';
import { registerCatalogAiRoutes, catalogAiExtensionsAvailable } from './catalog-ai-routes';
import { registerDeepLRoutes } from './deepl-catalog-routes';
import { registerDeepLBatchRoutes } from './deepl-batch-routes';
import { deeplSettings, deeplCredentials } from './deepl';
import { registerShopifySubscriptionRoutes } from './shopify-subscription-routes';
import { registerShopifyTranslationRoutes } from './shopify-translation-routes';
import { registerShopifyTranslationBatchRoutes } from './shopify-translation-batch-routes';
import { registerShopifyOAuthRoutes } from './shopify-oauth-routes';
import { registerShopifyWebhookRoutes } from './shopify-webhook-routes';
import { shopifyConnectionCredentials, shopifyRedirect } from './shopify-auth-input';
import { registerShopifyFulfillmentRoutes } from './shopify-fulfillment-routes';
import { registerEmailRoutes } from './email-routes';
import { inboundAvailable } from './email-inbound';
import { registerEmailInboundRoutes } from './email-inbound-routes';
import { smtpSettings, smtpCredentials, localSmtpPort } from './smtp';
import { registerPasswordRecoveryRoutes } from './password-recovery';
import {
  workspaceMfaAvailable,
  mfaSessionColumns,
  mfaSessionJoins,
  requireWorkspaceMfa,
} from './mfa-policy';
import { registerWorkspaceSecurityRoutes } from './workspace-security-routes';
import { LOGIN_LOCKED_MESSAGE, loginAttempt, registerLoginHistoryRoutes } from './login-history';
import { registerAuditRoutes } from './audit-log';
import { registerApiKeyRotationRoutes, touchApiKey } from './api-key-rotation';
import { registerPickingWaveRoutes } from './picking-wave-routes';
import { registerPickingWavePrintRoutes } from './picking-wave-print-routes';
import { amazonSettings, amazonConnectionCredentials } from './amazon';
import { registerIntegrationWorkspaceRoutes } from './integration-workspace';
import {registerLocalWooHttpFixtureRoutes} from './local-woo-http-fixture-routes';
import {registerLocalWooReadLaneRoutes} from './local-woo-read-lane-routes';
import {registerLocalWooStockLaneRoutes} from './local-woo-stock-lane-routes';
import type {createLocalWooReadLane} from './local-woo-read-lane';
import type {createLocalWooStockLane} from './local-woo-stock-lane';
import {startLocalWooReadWorker as startLocalWooStockWorker} from './local-woo-read-worker';
import {startLocalWooReadWorker} from './local-woo-read-worker';
import {assertLocalWooHttpFixture,localWooHttpFixtureChannelId,type LocalWooHttpFixture} from './local-woo-http-fixture';
import {assertLocalWooHttpRegistry,localWooRegistryChannelIds,type LocalWooHttpRegistry} from './local-woo-http-registry';
import { registerIntegrationRecoveryRoutes } from './integration-recovery-routes';
import { registerAmazonOAuthRoutes } from './amazon-oauth-routes';
import { readAmazonOrders, amazonReadPolicy } from './amazon-order-sync';
import { registerAmazonFulfillmentRoutes } from './amazon-fulfillment-routes';
import { registerAmazonMcfReadOnlyRoutes } from './amazon-mcf-readonly-routes';
import {inspectOrdinaryConnectorTransport,ProviderReadError,type OrdinaryConnectorTransport,type AmazonMcfReadTransport} from './provider-read-transport';
import { registerEbayFulfillmentRoutes } from './ebay-fulfillment-routes';
import { readEbayOrders, ebayReadPolicy } from './ebay-order-sync';
import { ebayConnectionCredentials, ebaySettings } from './ebay';
import { registerOdooImageRoutes } from './odoo-image-imports';
import { registerOdooCatalogSyncRoutes } from './odoo-catalog-sync';
import { registerOdooExportRoutes } from './odoo-export-routes';
import { Odoo, odooConfig } from './odoo';
import { demoOdooContext } from './odoo-catalog';
import { registerB2bNetworkRoutes } from './b2b-network';
import {
  registerB2bNetworkDropshippingRoutes,
  b2bNetworkDropshippingAvailable,
} from './b2b-network-dropshipping';
import { registerB2bNetworkOrderRoutes } from './b2b-network-orders';
import { registerB2bNetworkReturnRoutes } from './b2b-network-returns';
import { registerB2bRoutes } from './b2b';
import { registerDpdPickupScheduleRoutes } from './dpd-pickup-schedules';
import {
  inventoryQuery,
  inventorySnapshotQuery,
  movementQuery,
  listInventory,
  inventorySnapshot,
  listMovements,
  adjustLegacyStockInTx,
} from './inventory';
import { Shopify, shopifyStore, shopifyToken } from './shopify';
import { registerStocktakeRoutes } from './stocktake-routes';
import { registerSmsRoutes } from './sms-routes';
import { registerSmsSubmissionRoutes } from './sms-submission-routes';
import { registerStockLocationRoutes } from './stock-location-routes';
import { locationScan } from './stock-locations';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { readRateLimitSetting, registerAddressRateLimit } from './rate-limit-config';
import staticPlugin from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { pool, tenantTx, tenantReadTx, localConfig, preflightOrdinaryConstructionPim } from './db';
import { Problem, ensure } from './errors';
import { checkPassword, tokenHash, encrypt, decrypt } from './security';
import { registerWorkspaceRoutes, loginWorkspace, sessionCookie } from './workspace-routes';
import { registerAccountSecurityRoutes, secureLogin } from './account-security';
import { collectPublicRoutes, authenticateApiKey, authenticateBaseWireApiKey, registerDeveloperRoutes } from './developer-api';
import { registerOutboundRoutes } from './outbound-routes';
import { registerReturnRoutes } from './return-routes';
import { registerReturnAssistantRoutes } from './return-assistant-routes';
import { returnAssistantAvailable } from './return-assistant';
import { returnAssistantQueuesAvailable } from './return-assistant-queues';
import { registerReturnAssistantQueueRoutes } from './return-assistant-queues-routes';
import { registerPaymentRoutes } from './payment-routes';
import { registerSourcePaymentRoutes } from './source-payment-routes';
import { registerPortalRoutes } from './portal-routes';
import { registerPayu242Routes } from './payu242-routes';
import { registerMirakl262Routes } from './mirakl262-routes';
import { configureMirakl262Runtime, createMirakl262SimulatedReadRepository, mirakl262Simulation, mirakl262SimulationTransport } from './mirakl262';
import { registerCustomerMessageRoutes } from './customer-message-routes';
import { registerCrmRoutes } from './crm-routes';
import { registerBaseWireRoutes, observeBaseWireReads } from './base-wire-routes';
import { createBaseWireCrmFamily } from './base-wire-crm-routes';
import { createDefaultBaseWireCrmDispatch } from './base-wire-crm-runtime';
import { createBaseWireInventoryFamily } from './base-wire-inventory';
import { createDefaultBaseWireInventoryService, baseWireCategories224Available, productDeletions225Available } from './base-wire-inventory-runtime';
import { createBaseWireOrdersFamily } from './base-wire-orders';
import { createDefaultBaseWireOrdersService } from './base-wire-orders-runtime';
import { createBaseWireFulfillmentFamily } from './base-wire-fulfillment';
import { createDefaultBaseWireFulfillmentService } from './base-wire-fulfillment-runtime';
import { createBaseWireInvoicesFamily } from './base-wire-invoices';
import { createDefaultBaseWireInvoicesService } from './base-wire-invoices-runtime';
import { createBaseWireJournalFamily } from './base-wire-journal';
import { createDefaultBaseWireJournalService } from './base-wire-journal-runtime';
import { createBaseWireReturnsFamily } from './base-wire-returns';
import { createDefaultBaseWireReturnsService } from './base-wire-returns-runtime';
import { createBaseWireWmsFamily } from './base-wire-wms';
import { createDefaultBaseWireWmsService } from './base-wire-wms-runtime';
import { registerCustomerMessageWorkflowRoutes } from './customer-message-workflow-routes';
import { documentBody } from './portal-view';
import { psId, psStateIds } from './prestashop-orders';
import { registerImportRoutes, genericImportResponseDisposition } from './import-routes';
import type { Transport } from './integrations';
import { createProduct } from './catalog';
import { registerCatalogSourceRoutes } from './catalog-source-routes';
import { registerSupplierCatalogRoutes } from './supplier-catalog-routes';
import { registerSupplierFileSourceRoutes } from './supplier-file-source-routes';
import { supplierFileSourcesAvailable } from './supplier-file-sources';
import { registerSupplierRemoteRoutes } from './supplier-remote-routes';
import { supplierRemoteFeedsAvailable } from './supplier-remote-feeds';
import { registerSupplierBulkRoutes } from './supplier-bulk-routes';
import { registerSupplierScheduleRoutes } from './supplier-schedules';
import { bigbuyToken } from './bigbuy';
import { registerCatalogRoutes } from './catalog-routes';
import { registerProductCatalogRoutes } from './product-catalogs-routes';
import { productCatalogsAvailable } from './product-catalogs';
import { warehouseInventoryPoliciesAvailable } from './warehouse-inventory-policies';
import { registerWarehouseInventoryPolicyRoutes } from './warehouse-inventory-policies-routes';
import { returnDestinationStatusesAvailable } from './return-destination-statuses';
import { registerReturnDestinationStatusRoutes } from './return-destination-statuses-routes';
import { returnDestinationsAvailable } from './return-destinations';
import { registerReturnDestinationsRoutes } from './return-destinations-routes';
import { stocktakeAdjustmentsAvailable } from './stocktake-adjustments';
import { registerStocktakeAdjustmentRoutes } from './stocktake-adjustments-routes';
import { registerWarehouseDocumentRegisterRoutes } from './warehouse-document-register-routes';
import { catalogStockControlAvailabilityInTx } from './catalog-stock-control-transaction';
import { registerCatalogStockControlRoutes } from './catalog-stock-control-routes';
import {claimStockWriterActivation,type StockWriterActivation} from './catalog-stock-writer-coverage';
import { registerCatalogStockCountRoutes } from './catalog-stock-count-routes';
import { warehouseAutomaticWzAvailable } from './warehouse-automatic-wz';
import { registerWarehouseAutomaticWzRoutes } from './warehouse-automatic-wz-routes';
import { registerIssuedWzRoutes } from './warehouse-wz-issued-routes';
import { issuedWzAvailable } from './warehouse-wz-issued';
import { receiveReturnDestinationCoreInTx } from './return-destinations-core';
import { applyReturnDestinationPhysicalInTx } from './return-destinations-stock';
import { b2bCatalogScopeAvailable } from './b2b-catalog-scope';
import { registerB2BCatalogScopeRoutes } from './b2b-catalog-scope-routes';
import { registerCatalogBulkEditRoutes } from './catalog-bulk-edit-routes';
import { registerCatalogExportRoutes } from './catalog-export-routes';
import { registerCatalogExportProfileRoutes } from './catalog-export-profile-routes';
import { registerCatalogFileImportRoutes } from './catalog-file-import-routes';
import { registerWarehouseRoutes } from './warehouse-routes';
import { registerPurchasingRoutes } from './purchasing-routes';
import { registerReplenishmentPlanRoutes } from './replenishment-plan-routes';
import { registerReplenishmentAutomationRoutes } from './replenishment-automation-routes';
import { replenishmentAutomationsAvailable } from './replenishment-automations';
import { orderMergesAvailable } from './order-merges';
import { registerOrderMergeRoutes } from './order-merge-routes';
import { registerOrderSplitRoutes } from './order-split-routes';
import { orderSplit222Available } from './order-split222';
import { registerOrderSplit222Routes } from './order-split222-routes';
import { returnReasons223Available } from './return-reasons223';
import { registerReturnReasons223Routes } from './return-reasons223-routes';
import { tax226Available } from './tax226';
import { registerTax226Routes } from './tax226-routes';
import { nbp227Available } from './nbp227';
import { registerNbp227Routes } from './nbp227-routes';
import { rodo228Available } from './rodo228';
import { registerRodo228Routes } from './rodo228-routes';
import { rodo228CrmAccess, rodo228WireObserver } from './rodo228-hooks';
import { ksef229Available, ksefAcceptsInvoice230, ksefAcceptsInvoice232 } from './ksef229';
import { invoice230Available } from './invoice230';
import { registerInvoice230Routes } from './invoice230-routes';
import { invoice232Available } from './invoice232';
import { registerInvoice232Routes } from './invoice232-routes';
import { receipt233Available } from './receipt233';
import { registerReceipt233Routes } from './receipt233-routes';
import { invoice230Detail } from './invoice230-service';
import { invoice230PrintHtml } from './invoice230-print';
import { taxInvoiceActor } from './tax226-local-invoices';
import { registerLocalInvoiceIssueAlias } from './local-invoice-issue-alias';
import { ksef229Service, registerKsef229Routes } from './ksef229-routes';
import { ksef243Service, registerKsef243Routes } from './ksef243-routes';
import { ksef243Available } from './ksef243';
import {
  replenishmentForecastAvailable,
  replenishmentAppendAvailable,
} from './replenishment-plans';
import { registerShippingRoutes, shipmentLabel } from './shipping-routes';
import {registerLocalCarrierRoutes} from './local-carrier-routes';
import { registerDpdRoutes, cachedDpdLabel } from './dpd-shipping';
import { registerDhlShippingRoutes, cachedDhlLabel } from './dhl-shipping';
import { registerPocztaPolskaShippingRoutes, cachedPocztaPolskaLabel } from './pocztapolska-shipping';
import { registerDhlPickupRoutes } from './dhl-pickups';
import { CARRIER_NAMES } from './carrier-shipping';
import { registerCollectionRoutes } from './dpd-collections';
import { registerInvoiceRoutes, invoicePdf } from './invoice-routes';
import { registerAutomationScheduleRoutes } from './automation-schedule-routes';
import { registerOperationRoutes } from './operation-routes';
import { registerVariantOfferRoutes } from './variant-offer-routes';
import { registerAllegroBatchRoutes } from './allegro-batch-routes';
import { registerShopifyOfferRoutes } from './shopify-offer-routes';
import { registerOfferRoutes } from './offer-routes';
import {registerLocalSimulationOfferRoutes} from './local-simulation-offer-routes';
import {registerLocalWooFlowRoutes} from './local-woo-flow-routes';
import {registerLocalAutomationRoutes} from './local-automation-routes';
import { registerOfferSyncRoutes } from './offer-sync-routes';
import { registerOrderStatusRoutes } from './order-status-routes';
import { registerTrackingRoutes } from './tracking-routes';
import { registerPricingRoutes } from './pricing-routes';
import { registerRepricingRoutes } from './repricing-routes';
import { registerCompetitorObservationRoutes } from './competitor-observations-routes';
import { registerBuyerAddressRoutes } from './buyer-address-routes';
import { effectiveDeliveryInTx } from './buyer-address';
import { registerRepricingScheduleRoutes } from './repricing-schedules';
import { registerSyncRoutes } from './sync-routes';
import { channelRead, withAllegroRequestContext, enlistAllegroContextInTx, type IntegrationContext } from './channel-access';
import {
  createOrder,
  getOrder,
  orderSchema,
  productSchema,
  transition,
  scan,
  shipDemo,
  createDemoLabel,
  issueDocument,
  audit,
  type Actor,
} from './domain';
import {
  registry,
  connector,
  validateRemoteUrl,
  InPost,
  Allegro,
  WooCommerce,
  PrestaShop,
  Fakturownia,
} from './integrations';
declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
    apiScopes?: string[];
    currentUser: {
      api_key_id?: string;
      id: string;
      plan: string;
      name: string;
      email: string;
      tenant_name: string;
      role: string;
      /** The viewer is the accountant "Księgowa" (266); the role itself stays viewer. */
      accountant?: boolean;
      /** An operator with the grant "Automatyzacje: edycja" (267). */
      automation_editor?: boolean;
      tenant_id: string;
      /** Tenant region for formatting amounts and dates (session users; not API keys). */
      locale?: string;
      currency?: string;
      organization_requires_mfa?: boolean;
      mfa_required?: boolean;
      mfa_enrollment_required?: boolean;
    };
  }
}
const idOf = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
const canWrite = (a: Actor, admin = false) =>
  ensure(
    admin ? a.role === 'admin' : a.role !== 'viewer',
    403,
    admin ? 'Wymagana rola administratora' : 'Konto ma uprawnienia tylko do odczytu',
  );
const escape = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const printLayout = (title: string, body: string, nativeProforma = false) =>
  `<!doctype html><html lang="pl"><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:16px system-ui;max-width:850px;margin:50px auto;color:#18263c}h1{font-size:26px}.demo{padding:16px;background:#fff2ce;border:1px solid #c89c23}table{width:100%;border-collapse:collapse;margin:30px 0}td,th{text-align:left;padding:12px;border-bottom:1px solid #ddd}button{padding:12px}@media print{button{display:none}}</style><h1>DYNAMINDS Ecommerce</h1><p class="demo">${nativeProforma ? 'Pro forma — propozycja rozliczenia. Nie jest fakturą księgową ani potwierdzeniem wpłaty.' : 'DEMO — dokument testowy. Nie jest dokumentem księgowym ani etykietą przewoźnika.'}</p>${body}<button onclick="window.print()">Drukuj</button></html>`;
/** Native label source: the shipment with its order recipient; a demo shipment uses
 * the current effective delivery address (GET /api/shipments/:id/label, Base getLabel). */
async function shipmentLabelSourceInTx(c: PoolClient, tenantId: string, id: string) {
  const shipment = (
    await c.query(
      'SELECT s.*,o.customer_name,o.address FROM shipments s JOIN orders o ON (o.tenant_id,o.id)=(s.tenant_id,s.order_id) WHERE s.id=$1',
      [id],
    )
  ).rows[0];
  if (shipment?.mode === 'demo') {
    const current = await effectiveDeliveryInTx(c, tenantId, shipment.order_id, localConfig.encryptionKey);
    if (current.delivery) return { ...shipment, customer_name: current.delivery.recipient_name,
      address: { ...shipment.address, ...current.delivery } };
    // Uwagi v3 §6: the delivery recipient edited on the order card, otherwise the customer.
    return { ...shipment, customer_name: orderRecipientName(shipment) };
  }
  return shipment;
}
const demoShipmentLabelHtml = (s: any) =>
  printLayout(
    s.tracking_number,
    `<h2>ETYKIETA TESTOWA</h2><h3>${escape(s.tracking_number)}</h3><p>${escape(s.customer_name)}</p><p>${escape(s.address.street)}<br>${escape(s.address.postal_code)} ${escape(s.address.city)}</p><p>Przewoźnik: ${escape(s.carrier)}</p>`,
  );
/** The native demo label page bytes, for Base getLabel. */
export async function demoShipmentLabelInTx(c: PoolClient, tenantId: string, id: string) {
  const s = await shipmentLabelSourceInTx(c, tenantId, id);
  ensure(s?.mode === 'demo', 404, 'Nie znaleziono przesyłki');
  return demoShipmentLabelHtml(s);
}
import {createLargeImportApplication,type NativeDrivers as LargeImportNativeDrivers} from './large-import/application';
import {registerBusinessQuotaRecoveryRoutes} from './large-import/business-quota-recovery-routes';
import type {BusinessQuotaRecoveryPort} from './large-import/business-quota-recovery';

import {bindOrdinaryConnectorTransport} from './ordinary-connector-routing';
import {statementCancelResponse} from './statement-cancel';
import {DB_UNAVAILABLE_DETAIL,dbConnectionErrors,isDbConnectionLoss} from './db-connection-errors';
import { orderFulfilmentStageSql } from './order-stage';
import { registerOrderEventRoutes } from './order-event-routes';
import { paymentStateSql } from './order-stage-query';
import { accountantAvailable, accountantColumn } from './accountant';
import { automationEditorColumn, automationEditorsAvailable } from './automation-editors';
import { registerOrderSettingsRoutes } from './order-settings';
export {bindOrdinaryConnectorTransport} from './ordinary-connector-routing';

export async function buildApp({
  logging = false,
  integrationTransport,
  amazonMcfReadTransport,
  ordinaryConnectorTransport,
  miraklReadRepository,
  connectorJobExecution,
  nbpRates,
  oauthConfig,
  readOnly = false,
  previewPort = 4101,
  backgroundWorkersEnabled = false,
  scopedAutomationEnabled = false,
  trustedLocalUiOrigin,
  largeImportDrivers,
  largeImportRecovery,
  ordinaryRequestLifetime,
  localWooFixture,
  localWooRegistry,
  localWooReadLane,
  localWooStockLane,
  localWooOrderImport,
  stockWriterActivation,
  staticRoot,
}: {
  logging?: boolean;
  integrationTransport?: Transport;
  amazonMcfReadTransport?: AmazonMcfReadTransport;
  ordinaryConnectorTransport?: OrdinaryConnectorTransport;
  miraklReadRepository?: MiraklReadRepository;
  connectorJobExecution?: OrdinaryConnectorJobExecution;
  nbpRates?: NbpRatesPort;
  oauthConfig?: IntegrationContext['oauthConfig'];
  readOnly?: boolean;
  previewPort?: number;
  backgroundWorkersEnabled?: boolean;
  scopedAutomationEnabled?: boolean;
  trustedLocalUiOrigin?: string;
  largeImportDrivers?: LargeImportNativeDrivers;
  largeImportRecovery?: BusinessQuotaRecoveryPort;
  ordinaryRequestLifetime?: OrdinaryRequestLifetime;
  localWooFixture?: LocalWooHttpFixture;
  localWooRegistry?: LocalWooHttpRegistry;
  localWooReadLane?: ReturnType<typeof createLocalWooReadLane>;
  localWooStockLane?: ReturnType<typeof createLocalWooStockLane>;
  localWooOrderImport?: ReturnType<typeof createLocalWooOrderImport>;
  stockWriterActivation?: StockWriterActivation;
  staticRoot?: string;
} = {}) {
  // Validate trusted construction input before any database work. Requests are
  // still compared literally; there is no wildcard or Origin normalization.
  const addressRateLimit = readRateLimitSetting(process.env);
  ensure(!(localWooFixture&&localWooRegistry),500,'one-local-Woo-construction-required');
  if(localWooFixture)assertLocalWooHttpFixture(localWooFixture);if(localWooRegistry)assertLocalWooHttpRegistry(localWooRegistry);
  const hasLocalWoo=!!(localWooFixture||localWooRegistry);
  ensure(!localWooOrderImport||(localWooReadLane&&localWooRegistry&&!backgroundWorkersEnabled&&!readOnly),423,'local-Woo-import-requires-selected-reader');
  ensure(!localWooStockLane||(localWooRegistry&&!backgroundWorkersEnabled&&!readOnly),423,'local-Woo-stock-requires-exclusive-selected-local-worker');
  ensure(!localWooReadLane||(localWooRegistry&&!backgroundWorkersEnabled&&!readOnly),423,'local-Woo-reads-require-exclusive-selected-local-worker');
  const localWooChannelIds=localWooRegistry?localWooRegistryChannelIds(localWooRegistry):localWooFixture?Object.freeze([localWooHttpFixtureChannelId(localWooFixture)]):Object.freeze([] as string[]);
  const localWooTransport=localWooRegistry?.transport??localWooFixture?.transport;
  if(localWooTransport){ensure(integrationTransport===undefined||integrationTransport===localWooTransport,500,'local-Woo-transport-must-match-owned-registry');integrationTransport=localWooTransport;}
  if(ordinaryConnectorTransport!==undefined)ensure(!readOnly,423,'connector-access-readonly-conflict');
  if(miraklReadRepository!==undefined)ensure(!readOnly&&ordinaryConnectorTransport&&inspectOrdinaryConnectorTransport(ordinaryConnectorTransport).providers.some(p=>p.provider==='mirakl'),423,'mirakl-read-state-requires-explicit-connector-access');
  assertOrdinaryConnectorJobExecution(connectorJobExecution,ordinaryConnectorTransport,readOnly,hasLocalWoo);
  ensure(!connectorJobExecution||!backgroundWorkersEnabled,423,'manual-connector-jobs-no-background-worker');
  integrationTransport=bindOrdinaryConnectorTransport(integrationTransport,ordinaryConnectorTransport);
  if(stockWriterActivation!==undefined)ensure(!readOnly,423,'stock-writer-readonly-construction');
  const stockWriterInstallation=stockWriterActivation===undefined?undefined:await claimStockWriterActivation(stockWriterActivation);
  const extraLocalUiOrigin = trustedLocalUiOrigin === undefined
    ? [] : [validateTrustedLocalUiOrigin(trustedLocalUiOrigin)];
  const accountSecurityAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.account_security') present")).rows[0].present,
  );
  // 266: the accountant grant (absent in a restored older copy: nobody is an accountant).
  const accountant266Available = await accountantAvailable(pool);
  // 267: the grant "Automatyzacje: edycja" (absent in a restored older copy: only administrators edit automations).
  const automationEditors267Available = await automationEditorsAvailable(pool);
  // 237: login history, durable login lock and API key state (absent in a restored older copy).
  const authSecurity237Available = (await pool.query("SELECT to_regprocedure('public.auth237_login_attempt(text)') IS NOT NULL AND to_regclass('public.auth237_api_key_state') IS NOT NULL AS present")).rows[0].present === true;
  const emailAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.email_messages') present")).rows[0].present,
  );
  const emailInboundAvailable = await inboundAvailable(pool);
  const productCatalogsIsAvailable = await productCatalogsAvailable(pool);
  if (readOnly) await validateRecoveredPimBeforeReadonly(pool);
  const constructionPim = await preflightOrdinaryConstructionPim();
  // Only the genuine startup-owned READ ONLY Native check can publish split.
  // Legacy hosts without that reviewed cold/construction lease stay inactive.
  const orderSplitsIsAvailable = constructionPim?.orderSplitsAvailable === true;
  const pimDictionariesIsAvailable = constructionPim === undefined ? await preflightPim(pool) : constructionPim.pimAvailable;
  const pimNestedMappingIsAvailable = constructionPim === undefined ? await preflightNestedPim(pool,pimDictionariesIsAvailable) : constructionPim.nestedAvailable;
  const largeImports = await createLargeImportApplication(largeImportDrivers,readOnly);
  const b2bCatalogScopeIsAvailable = await b2bCatalogScopeAvailable(pool);
  const emailAttachmentsAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.email_message_files') present")).rows[0].present,
  );
  const emailActionsAvailable = (
    await pool.query(
      "SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.email_batches') AND attname='automation_run_id' AND NOT attisdropped) available",
    )
  ).rows[0].available;
  const passwordRecoveryAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.account_password_resets') present")).rows[0]
      .present,
  );
  const workspaceMfaPolicyAvailable = await workspaceMfaAvailable(pool);
  const shopifyFulfillmentAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.shopify_fulfillment_plans') present")).rows[0]
      .present,
  );
  const workspaceBillingAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.workspace_billing_accounts') present")).rows[0]
      .present,
  );
  const catalogAiAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.ai_catalog_drafts') present")).rows[0].present,
  );
  const deeplAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.deepl_catalog_drafts') present")).rows[0].present,
  );
  const deeplBatchAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.deepl_catalog_batches') present")).rows[0]
      .present,
  );
  const shopifySubscriptionsAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.shopify_subscription_plans') present")).rows[0]
      .present,
  );
  const shopifyTranslationsAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.shopify_translation_plans') present")).rows[0]
      .present,
  );
  const shopifyTranslationBatchesAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.shopify_translation_batches') present")).rows[0]
      .present,
  );
  const productRulesAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.product_rules') present")).rows[0].present,
  );
  const catalogBulkEditAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.catalog_bulk_edit_previews') present")).rows[0]
      .present,
  );
  const productLogisticsIsAvailable = await productLogisticsAvailable(pool as any);
  const productSkuIsAvailable = await productSkuAvailable(pool as any);
  const inventoryBulkEditAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.inventory_bulk_edit_previews') present")).rows[0]
      .present,
  );
  const paymentImportsAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.payment_import_executions') present")).rows[0]
      .present,
  );
  const paymentImportAllocationsIsAvailable = await paymentImportAllocationsAvailable(pool);
  const proformasIsAvailable = await proformasAvailable(pool);
  const proformaBatchesIsAvailable = await proformaBatchesAvailable(pool);
  const priceBulkEditAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.price_bulk_edit_previews') present")).rows[0]
      .present,
  );
  const priceFileImportsAvailable = await priceFileImportAvailable(pool);
  const priceMatrixImportsAvailable = await priceMatrixImportAvailable(pool);
  const stockFileImportsAvailable = await stockFileImportAvailable(pool);
  const languageFileImportsAvailable = await languageFileImportAvailable(pool);
  const supplierFileFunctionPresent = Boolean(
    (await pool.query("SELECT to_regprocedure('public.supplier_file_installed()') present")).rows[0]
      .present,
  );
  const supplierFileSourcesIsAvailable =
    supplierFileFunctionPresent && (await supplierFileSourcesAvailable(pool));
  const supplierRemoteFeedsIsAvailable = await supplierRemoteFeedsAvailable(pool);
  const returnExchangesIsAvailable = await returnExchangeAvailable(pool);
  const returnExchangeSubstitutionsIsAvailable =
    returnExchangesIsAvailable && (await returnExchangeSubstitutionsAvailable(pool));
  const productTranslationBulkEditAvailable = Boolean(
    (
      await pool.query(
        "SELECT to_regclass('public.product_translation_bulk_edit_previews') present",
      )
    ).rows[0].present,
  );
  const packingWorkstationAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.packing_receipts') present")).rows[0].present,
  );
  const returnAssistantIsAvailable = await returnAssistantAvailable(pool);
  const returnAssistantQueuesIsAvailable = await returnAssistantQueuesAvailable(pool);
  const warehouseInventoryPoliciesIsAvailable = await warehouseInventoryPoliciesAvailable(pool);
  const returnDestinationStatusesIsAvailable = await returnDestinationStatusesAvailable(pool);
  const returnDestinationsIsAvailable = await returnDestinationsAvailable(pool);
  const stocktakeAdjustmentsIsAvailable = await stocktakeAdjustmentsAvailable(pool);
  const warehouseAutomaticWzIsAvailable = await warehouseAutomaticWzAvailable(pool);
  const warehouseWzIssuerIsAvailable = await issuedWzAvailable(pool);
  const catalogStockControlStatus = await catalogStockControlAvailabilityInTx(pool);
  const catalogStockControlIsAvailable = catalogStockControlStatus === 'available';
  const printJobsIsAvailable = await printJobsAvailable(pool);
  const packedLabelPrintIsAvailable = await packedLabelPrintAvailable(pool);
  const localInvoicesIsAvailable = await localInvoicesAvailable(pool);
  const shipmentLabelPrintIsAvailable = await shipmentLabelPrintAvailable(pool);
  const shipmentLabelCacheIsAvailable = await shipmentLabelCacheAvailable(pool);
  const shipmentLabelBatchesIsAvailable = await shipmentLabelBatchesAvailable(pool);
  const physicalParcelWzIsAvailable = await preflightPhysicalParcelWz(pool);
  const orderParcelsIsAvailable = await orderParcelsAvailable(pool);
  const orderParcelReleasesIsAvailable = await orderParcelReleasesAvailable(pool);
  const wmsLotsAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.wms_policies') present")).rows[0].present,
  );
  const wmsStocktakesAvailable = Boolean(
    (
      await pool.query(`SELECT bool_and(to_regclass('public.'||name) IS NOT NULL) present
      FROM unnest(ARRAY['wms_stocktakes','wms_stocktake_lines','wms_stocktake_scope_layers',
      'wms_stocktake_measurements','wms_stocktake_measurement_layers','wms_stocktake_reviews',
      'wms_stocktake_review_rows','wms_stocktake_postings']) name`)
    ).rows[0].present,
  );
  const stocktakeScansAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.stocktake_scan_receipts') present")).rows[0]
      .present,
  );
  const catalogExportProfilesAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.catalog_export_profiles') present")).rows[0]
      .present,
  );
  const catalogFileImportsAvailable = Boolean(
    (
      await pool.query(`SELECT bool_and(to_regclass('public.' || name) IS NOT NULL) present
      FROM unnest(ARRAY['catalog_file_import_previews','catalog_file_import_rows',
      'catalog_file_import_executions','catalog_file_import_execution_rows']) name`)
    ).rows[0].present,
  );
  const orderFieldsAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.order_field_definitions') present")).rows[0]
      .present,
  );
  const replenishmentPlansAvailable = Boolean(
    (
      await pool.query(`SELECT
      (SELECT bool_and(to_regclass('public.'||name) IS NOT NULL)
       FROM unnest(ARRAY['replenishment_policies','purchasing_source_versions','purchasing_stock_changes',
        'replenishment_previews','replenishment_rows','replenishment_executions',
        'replenishment_execution_rows']) name)
      AND to_regprocedure('public.purchasing_source_admit()') IS NOT NULL
      AND to_regprocedure('public.purchasing_source_version()') IS NOT NULL
      AND to_regprocedure('public.purchasing_stock_admit()') IS NOT NULL
      AND (SELECT count(*)=2 FROM pg_attribute
       WHERE attrelid=to_regclass('public.purchase_orders') AND NOT attisdropped
       AND attname IN ('replenishment_execution_id','replenishment_group_index')) available`)
    ).rows[0].available,
  );
  const replenishmentForecastIsAvailable = await replenishmentForecastAvailable(pool);
  const replenishmentAppendIsAvailable = await replenishmentAppendAvailable(pool);
  const replenishmentAutomationsIsAvailable = await replenishmentAutomationsAvailable(pool);
  const orderMergesIsAvailable = await orderMergesAvailable(pool);
  const orderSplit222IsAvailable = await orderSplit222Available(pool);
  const returnReasons223IsAvailable = await returnReasons223Available(pool);
  const tax226IsAvailable = await tax226Available(pool);
  const nbp227IsAvailable = await nbp227Available(pool);
  const rodo228IsAvailable = await rodo228Available(pool);
  const ksef229IsAvailable = await ksef229Available(pool);
  const ksefInvoice230IsAvailable = await ksefAcceptsInvoice230(pool);
  const invoice230IsAvailable = await invoice230Available(pool);
  const invoice232IsAvailable = await invoice232Available(pool), ksefInvoice232IsAvailable = await ksefAcceptsInvoice232(pool);
  const receipt233IsAvailable = await receipt233Available(pool);
  const b2bDropshippingIsAvailable = await b2bNetworkDropshippingAvailable(pool);
  const b2bExternalOrderIntentsIsAvailable = await b2bExternalOrderIntentsAvailable(pool);
  const b2bExternalOrderImportsIsAvailable = await b2bExternalOrderImportsAvailable(pool);
  const b2bDropshippingReturnsIsAvailable = await b2bDropshippingReturnsAvailable(pool);
  const b2bReturnLocalOriginsIsAvailable = await b2bReturnLocalOriginsAvailable(pool);
  const orderMergeClaimsAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.order_merge_claims') IS NOT NULL AS available"))
      .rows[0].available,
  );
  const operationalOrderPredicate = orderMergeClaimsAvailable
    ? 'NOT EXISTS(SELECT 1 FROM order_merge_claims m WHERE m.tenant_id=o.tenant_id AND m.source_order_id=o.id)'
    : 'TRUE';
  // Order list payment summary in one correlated subquery (no per-row round trips): the same
  // ledger sums and return credit as paymentBalance, over the order and its merged sources.
  const orderListPaymentIds = orderMergeClaimsAvailable
    ? 'ARRAY(WITH RECURSIVE s(id) AS (SELECT o.id UNION SELECT m.source_order_id FROM s JOIN order_merge_claims m ON m.tenant_id=o.tenant_id AND m.target_order_id=s.id) SELECT id FROM s)'
    : 'ARRAY[o.id]';
  const orderListPaymentSql = `(SELECT json_build_object('net',(SELECT coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind) IN ('receipt','courier_collection')),0)-coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind)='refund'),0) FROM payment_entries p LEFT JOIN payment_entries r ON (r.tenant_id,r.order_id,r.id)=(p.tenant_id,p.order_id,p.reversal_of) WHERE p.tenant_id=o.tenant_id AND p.order_id=ANY(x.ids)),'credit',(SELECT coalesce(sum(refund_amount),0) FROM return_cases WHERE tenant_id=o.tenant_id AND order_id=ANY(x.ids) AND state IN ('refund_pending','closed'))) FROM (SELECT ${orderListPaymentIds} AS ids) x)`;
  const orderFieldBatchesAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.order_field_batch_previews') present")).rows[0]
      .present,
  );
  const orderFieldMappingsAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.order_field_mapping_profiles') present")).rows[0]
      .present,
  );
  const customerMessagesAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.customer_message_threads') present")).rows[0]
      .present,
  );
  const customerMessageWorkflowsAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.customer_message_workflow_receipts') present"))
      .rows[0].present,
  );
  const shopifyWebhooksAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.shopify_webhook_configs') present")).rows[0]
      .present,
  );
  const amazonFulfillmentAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.amazon_fulfillment_plans') present")).rows[0]
      .present,
  );
  const pickingWavesAvailable = Boolean(
    (await pool.query("SELECT to_regclass('public.picking_waves') present")).rows[0].present,
  );
  const sessionName = readOnly ? `dyna_session_preview_${previewPort}` : 'dyna_session';
  const context: IntegrationContext = {
    transport: readOnly
      ? async () => {
          throw new Problem(423, 'Połączenia z dostawcami są wyłączone w podglądzie kopii');
        }
      : integrationTransport,
    oauthConfig,
    sessionName,
    allegroSecurity: { accountSecurityAvailable, workspaceMfaPolicyAvailable, readOnly },
    miraklImportAuthority:async(c,actor)=>{
      await assertMiraklSessionAuthorityInTx(c,actor,{accountSecurityAvailable,workspaceMfaPolicyAvailable,readOnly});
      enlistMiraklSessionAuthorityInTx(c,actor,{accountSecurityAvailable,workspaceMfaPolicyAvailable,readOnly});
    },
  };
  let connectorJobsAvailable=false;
  // The release process (ordinary lifetime, no request log) still reports second replies of a request.
  const replyWarnings = !logging && ordinaryRequestLifetime ? createReplyWarningLog() : undefined;
  const app = Fastify({
    ...(replyWarnings ? { loggerInstance: replyWarnings.loggerInstance, childLoggerFactory: replyWarnings.childLoggerFactory } : {}),
    logger: logging
      ? {
          serializers: {
            req: (req: any) => ({
              method: req.method,
              url: requestLogUrl(req.url),
              remoteAddress: req.ip,
            }),
          },
        }
      : false,
    bodyLimit: 1048576,
  });
  try {
  if (ordinaryRequestLifetime) installOrdinaryRequestLifetime(app,ordinaryRequestLifetime);
  const bindPublicRoutes = collectPublicRoutes(app);
  await app.register(cookie);
  await registerAddressRateLimit(app, addressRateLimit);
  app.decorateRequest('actor');
  app.decorateRequest('apiScopes');
  app.decorateRequest('currentUser');
  app.setErrorHandler((err, req, reply) => {
    const respond = () => {
    let status = 500,
      detail = 'Nieoczekiwany błąd serwera';
    if (err instanceof Problem) {
      status = err.status;
      detail = err.message;
    } else if (err instanceof z.ZodError) {
      status = 422;
      detail = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    } else if (statementCancelResponse(err)) {
      const canceled = statementCancelResponse(err)!;
      status = canceled.status;
      detail = canceled.detail;
      app.log.warn({ code: '57014', reason: canceled.reason, message: (err as Error).message,
        where: (err as { where?: unknown }).where, requestId: req.id }, 'Statement canceled');
    } else if (isDbConnectionLoss(err)) {
      // The session died under the request (database restart, terminated backend) or no connection could be
      // opened: its transaction did not commit, the pool replaces the client and the client may retry.
      status = 503;
      detail = DB_UNAVAILABLE_DETAIL;
      app.log.warn({ code: (err as { code?: unknown }).code ?? null, requestId: req.id }, 'Database connection lost');
    } else if (
      (err as any).code === 'P0001' &&
      [
        'Replenishment proof count quota exceeded',
        'Replenishment proof storage quota exceeded',
        'Replenishment preview exceeds eight MiB',
      ].includes((err as Error).message)
    ) {
      const message = (err as Error).message;
      status = message === 'Replenishment preview exceeds eight MiB' ? 413 : 429;
      detail =
        status === 413
          ? 'Podgląd przekracza dopuszczalny rozmiar. Zmniejsz wybór produktów.'
          : message === 'Replenishment proof count quota exceeded'
            ? 'Osiągnięto limit trwałych planów'
            : 'Przekroczono limit przechowywania planów tej organizacji';
    } else if (
      (err as any).code === 'P0001' &&
      [
        'Replenishment automation history limit',
        'Replenishment automation pending limit',
        'Replenishment automation byte limit',
        'Replenishment automation rule limit',
      ].includes((err as Error).message)
    ) {
      status = 429;
      detail =
        'Kolejka lub historia automatycznego uzupełniania jest pełna. Zmiana zapasu została wycofana; sprawdź reguły i oczekujące zadania.';
    } else if ((err as any).code === 'P0001' || (err as any).code === 'P0002') {
      status = 409;
      detail = (err as Error).message.replace(
        /\b(products|orders|channels|warehouses|memberships)\b/g,
        (resource) =>
          ({
            products: 'produkty',
            orders: 'zamówienia',
            channels: 'połączenia',
            warehouses: 'magazyny',
            memberships: 'miejsca w zespole',
          })[resource]!,
      );
    } else if (
      (err as any).code === '23514' &&
      [
        'Realizacja zamówienia została przeniesiona przez łączenie',
        'Realizacja źródłowego zamówienia została przejęta',
        'Przeniesiona rezerwacja jest niezmienna',
      ].includes((err as Error).message)
    ) {
      status = 409;
      detail =
        'Realizacja tego zamówienia została przeniesiona przez łączenie. Otwórz zamówienie wynikowe.';
    } else if (
      (err as any).code === '23514' &&
      [
        'Przekazanie przekracza bieżącą dostępną ilość dostawcy',
        'Przekazanie przekracza bieżący wolny fragment wydania WMS',
        'Przekazanie przekracza bieżący koszt dostawy dostawcy',
      ].includes((err as Error).message)
    ) {
      status = 409;
      detail =
        'Zakres zwrotu koliduje z inną sprawą. Odczytaj aktualne ilości i fragmenty wydania.';
    } else if ((err as any).code === '23505') {
      status = 409;
      detail = 'Rekord już istnieje';
    } else if ((err as any).code === '23503') {
      status = 422;
      detail = 'Nieprawidłowe powiązanie danych';
    } else if ((err as any).statusCode === 429) {
      status = 429;
      detail = 'Przekroczono limit żądań';
    } else if ((err as any).statusCode >= 400 && (err as any).statusCode < 500) {
      status = (err as any).statusCode;
      detail = 'Nieprawidłowe żądanie';
    } else app.log.error({ message: (err as Error).message, requestId: req.id }, 'Request failed');
    reply
      .code(status)
      .type('application/problem+json')
      .send({
        type: 'about:blank',
        title: status < 500 ? 'Nie można wykonać operacji' : 'Błąd serwera',
        status,
        detail,
        ...(err instanceof Problem && err.code ? { code: err.code } : {}),
        ...(err instanceof Problem && err.status >= 400 && err.status < 500 && genericImportResponseDisposition(err, req) ? {commit_disposition: genericImportResponseDisposition(err, req)} : {}),
        request_id: req.id,
      });
    };
    // A refused new request has no admitted async work; its original error response is synchronous.
    // The tracked Promise resolves to the reply (Fastify then waits for the response it already started):
    // resolving to undefined while an async preSerialization hook still runs made Fastify send a second,
    // empty reply of the same request (ERR_HTTP_HEADERS_SENT, load run full-20261029-02).
    return hasOrdinaryRequestAdmission(ordinaryRequestLifetime,req)
      ? runOrdinaryRequestError(ordinaryRequestLifetime,req,respond).then(() => reply) : respond();
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (readOnly && req.url.startsWith('/api/oauth/'))
      throw new Problem(423, 'OAuth jest wyłączony w podglądzie kopii');
    if (
      readOnly &&
      (req.url.split('?')[0] === '/api/inpost/points' ||
        /^\/api\/integrations\/[^/]+\/preview(?:\?|$)/.test(req.url))
    )
      throw new Problem(423, 'Połączenia z dostawcami są wyłączone w podglądzie kopii');
    if (readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(req.method))
      ensure(
        req.method === 'POST' &&
          ([
            '/api/auth/login',
            '/api/auth/logout',
            '/api/workspaces/switch',
            '/api/crm/commands/observe',
            '/api/catalog/exports/file',
            '/api/v1/catalog/exports/file',
            '/api/catalog/exports/preview',
            '/api/v1/catalog/exports/preview',
          ].includes(req.url.split('?')[0]) ||
            /^\/api\/local-fixtures\/woocommerce\/channels\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/order-import\/commands\/observe$/i.test(req.url.split('?')[0]) ||
            /^\/api\/integrations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/offer-sync\/commands\/observe$/i.test(req.url.split('?')[0]) ||
            /^\/api\/public\/b2b\/[0-9a-f-]+\/(login|logout)$/.test(req.url.split('?')[0])),
        423,
        'Podgląd odtworzonej kopii jest tylko do odczytu. Operacja nie została wykonana.',
      );
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      ensure(
        [
          'http://127.0.0.1:5173',
          'http://localhost:5173',
          'http://127.0.0.1:4100',
          'http://localhost:4100',
          ...extraLocalUiOrigin,
          ...(readOnly
            ? [`http://localhost:${previewPort}`, `http://127.0.0.1:${previewPort}`]
            : []),
        ].includes(req.headers.origin),
        403,
        'Niedozwolone pochodzenie żądania',
      );
    }
    if (
      [
        '/api/auth/login',
        '/api/auth/signup',
        '/api/auth/password/request',
        '/api/auth/password/reset',
      ].includes(req.url.split('?')[0]) ||
      req.url === '/api/health' ||
      req.url.split('?')[0] === '/api/v1/openapi' ||
      req.url.startsWith('/api/local-webhooks/') ||
      req.url.startsWith('/api/webhooks/woocommerce/') ||
      req.url.startsWith('/api/webhooks/shopify/') ||
      req.url.startsWith('/api/public/orders/') ||
      req.url.startsWith('/api/public/b2b/')
    )
      return;
    const apiToken = req.headers.authorization?.startsWith('Bearer dyna_api_')
      ? req.headers.authorization.slice(7)
      : undefined;
    const token =
      apiToken ??
      req.cookies[sessionName] ??
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : undefined);
    if (!token) throw new Problem(401, 'Zaloguj się do systemu',
      req.headers.authorization ? undefined : 'AUTH_SESSION_EXPIRED');
    const user = apiToken
      ? await authenticateApiKey(req, apiToken, workspaceMfaPolicyAvailable).then(async (key) => {
          if (authSecurity237Available) await touchApiKey(key, req.ip);
          return key;
        })
      : (
          await pool.query(
            `SELECT u.id,u.name,u.email,s.tenant_id,m.role${accountantColumn(accountant266Available)}${automationEditorColumn(automationEditors267Available)},t.plan,t.name AS tenant_name,t.locale,t.currency${workspaceMfaPolicyAvailable ? mfaSessionColumns : ''} FROM sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=u.id AND m.tenant_id=s.tenant_id JOIN tenants t ON t.id=s.tenant_id ${accountSecurityAvailable ? 'LEFT JOIN account_security a ON a.user_id=u.id' : ''} ${workspaceMfaPolicyAvailable ? mfaSessionJoins : ''} WHERE s.token_hash=$1 AND s.expires_at>now() ${accountSecurityAvailable ? 'AND s.account_version=coalesce(a.version,0)' : ''}`,
            [tokenHash(token)],
          )
        ).rows[0];
    if (!user) throw new Problem(401, 'Sesja wygasła',
      req.headers.authorization ? undefined : 'AUTH_SESSION_EXPIRED');
    ensure(
      !req.headers['x-workspace-id'] || req.headers['x-workspace-id'] === user.tenant_id,
      409,
      'Organizacja została zmieniona. Odśwież widok przed wykonaniem operacji.',
    );
    const accountant = !apiToken && user.accountant === true;
    const automationEditor = !apiToken && user.automation_editor === true;
    req.actor = {
      tenantId: user.tenant_id,
      userId: user.id,
      role: user.role,
      ...(apiToken ? { apiKeyId: user.api_key_id, source: 'api' as const } : {}),
      ...(accountant ? { accountant: true } : {}),
      ...(automationEditor ? { automationEditor: true } : {}),
    };
    req.apiScopes = apiToken ? user.scopes : undefined;
    req.currentUser = { ...user, accountant, automation_editor: automationEditor };
    const routePath = req.url.split('?')[0];
    const recoveryRoute =
      ['/api/auth/me', '/api/auth/logout'].includes(routePath) ||
      (routePath === '/api/workspaces' && req.method === 'GET') ||
      (routePath === '/api/workspaces/switch' && req.method === 'POST') ||
      /^\/api\/auth\/security(?:\/(?:enroll|confirm|verify|disable|recovery|password|sessions\/[a-f0-9-]+))?$/.test(
        routePath,
      );
    if (!apiToken && !recoveryRoute) requireWorkspaceMfa(user);
  });
  app.get('/api/health', async () => {
    const schema = await pool.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1');
    return {
      status: 'ok',
      database: 'postgresql',
      mode: 'local',
      revision: process.env.APP_REVISION ?? 'local-development',
      schema_revision: schema.rows[0]?.name,
      restore_preview: readOnly,
      // Admission counters of this process (diagnostics for the 503 pending-limit refusal).
      ...(ordinaryRequestLifetime ? { ordinary_requests: (({ active_requests, active_requests_limit, active_tasks, refused_admissions, late_hook_failures }) =>
        ({ active_requests, active_requests_limit, active_tasks, refused_admissions, late_hook_failures }))(inspectOrdinaryRequests(ordinaryRequestLifetime)) } : {}),
      // Second replies of one request and late hook failures since start (reply-warning-log.ts).
      ...(replyWarnings ? { reply_warnings: replyWarnings.counts() } : {}),
      // PostgreSQL connections this process lost since start (db-connection-errors.ts), total and per pool/client.
      db_connection_errors: dbConnectionErrors().total,
      db_connection_errors_by_source: dbConnectionErrors().by_source,
      // Effective per-address limit (DYNA_RATE_LIMIT_PER_MIN or the default 600); the load driver records it.
      rate_limit: addressRateLimit,
      warehouse_automatic_wz_configuration_available: warehouseAutomaticWzIsAvailable,
      warehouse_automatic_wz_issuer_available: warehouseWzIssuerIsAvailable,
      catalog_stock_control_available: catalogStockControlIsAvailable,
      catalog_stock_control_status: catalogStockControlStatus,
      background_workers_enabled: backgroundWorkersEnabled,
      ordinary_connector_jobs_available: connectorJobsAvailable,
      mirakl_reads_available: miraklReadRepository!==undefined,
      scoped_automation_enabled: scopedAutomationEnabled&&!readOnly,
      local_woo_order_import_available: !!localWooOrderImport,
      local_woo_stock_enabled: !!localWooStockLane,
      local_woo_stock_processor_running: localWooStockWorker?.inspect().running===true,
      local_woo_stock_blocked_channels: localWooStockLane?.inspect().blocked??0,
      local_woo_reads_enabled: !!localWooReadLane,
      local_woo_read_processor_running: localWooReadWorker?.inspect().running===true,
      local_woo_flow_available: true,
      b2b_dropshipping_available: b2bDropshippingIsAvailable,
      b2b_external_order_intents_available: b2bExternalOrderIntentsIsAvailable,
      b2b_external_order_imports_available: b2bExternalOrderImportsIsAvailable,
      b2b_dropshipping_returns_available: b2bDropshippingReturnsIsAvailable,
      b2b_local_return_origins_available: b2bReturnLocalOriginsIsAvailable,
      email_available: emailAvailable,
      email_inbound_available: emailInboundAvailable,
      product_catalogs_available: productCatalogsIsAvailable,
      pim_dictionaries_available: pimDictionariesIsAvailable,
      pim_nested_mapping_available: pimNestedMappingIsAvailable,
      large_import_available: largeImports.available,
      large_import_quota_recovery_available: !!largeImportRecovery&&!readOnly,
      large_import_independent_creates_available: largeImports.available && largeImports.independentCreates,
      b2b_catalog_scope_available: b2bCatalogScopeIsAvailable,
      email_actions_available: emailActionsAvailable,
      email_attachments_available: emailAttachmentsAvailable,
      password_recovery_available: passwordRecoveryAvailable,
      workspace_mfa_available: workspaceMfaPolicyAvailable,
      picking_waves_available: pickingWavesAvailable,
      amazon_fulfillment_available: amazonFulfillmentAvailable,
      shopify_fulfillment_available: shopifyFulfillmentAvailable,
      shopify_webhooks_available: shopifyWebhooksAvailable,
      shopify_subscriptions_available: shopifySubscriptionsAvailable,
      shopify_translations_available: shopifyTranslationsAvailable,
      shopify_translation_batches_available: shopifyTranslationBatchesAvailable,
      customer_messages_available: customerMessagesAvailable,
      customer_message_workflows_available: customerMessageWorkflowsAvailable,
      product_rules_available: productRulesAvailable,
      catalog_bulk_edit_available: catalogBulkEditAvailable,
      catalog_file_imports_available: catalogFileImportsAvailable,
      replenishment_plans_available: replenishmentPlansAvailable,
      replenishment_forecast_available: replenishmentForecastIsAvailable,
      replenishment_append_available: replenishmentAppendIsAvailable,
      replenishment_automations_available: replenishmentAutomationsIsAvailable,
      order_merges_available: orderMergesIsAvailable,
      order_splits_available: orderSplitsIsAvailable,
      order_split222_available: orderSplit222IsAvailable,
      return_reasons223_available: returnReasons223IsAvailable,
      tax226_available: tax226IsAvailable,
      nbp227_available: nbp227IsAvailable,
      rodo228_available: rodo228IsAvailable,
      ksef229_available: ksef229IsAvailable,
      ksef_invoice230_available: ksefInvoice230IsAvailable,
      invoice230_available: invoice230IsAvailable,
      invoice232_available: invoice232IsAvailable,
      ksef_invoice232_available: ksefInvoice232IsAvailable,
      receipt233_available: receipt233IsAvailable,
      product_logistics_available: productLogisticsIsAvailable,
      product_sku_edit_available: productSkuIsAvailable,
      inventory_bulk_edit_available: inventoryBulkEditAvailable,
      price_bulk_edit_available: priceBulkEditAvailable,
      price_file_import_available: priceFileImportsAvailable,
      price_matrix_import_available: priceMatrixImportsAvailable,
      stock_file_import_available: stockFileImportsAvailable,
      language_file_import_available: languageFileImportsAvailable,
      supplier_file_sources_available: supplierFileSourcesIsAvailable,
      supplier_remote_feeds_available: supplierRemoteFeedsIsAvailable,
      return_exchanges_available: returnExchangesIsAvailable,
      return_exchange_substitutions_available: returnExchangeSubstitutionsIsAvailable,
      product_translation_bulk_edit_available: productTranslationBulkEditAvailable,
      packing_workstation_available: packingWorkstationAvailable,
      return_assistant_available: returnAssistantIsAvailable,
      return_assistant_queues_available: returnAssistantQueuesIsAvailable,
      warehouse_inventory_policies_available: warehouseInventoryPoliciesIsAvailable,
      return_destination_statuses_available: returnDestinationStatusesIsAvailable,
      return_destinations_available: returnDestinationsIsAvailable,
      stocktake_adjustments_available: stocktakeAdjustmentsIsAvailable,
      print_jobs_available: printJobsIsAvailable,
      packed_label_print_available: packedLabelPrintIsAvailable,
      local_invoices_available: localInvoicesIsAvailable,
      shipment_label_print_available: shipmentLabelPrintIsAvailable,
      shipment_label_cache_available: shipmentLabelCacheIsAvailable,
      shipment_label_batches_available: shipmentLabelBatchesIsAvailable,
      order_parcels_available: orderParcelsIsAvailable,
      order_parcel_releases_available: orderParcelReleasesIsAvailable,
      manual_order_lines_available: true,
      wms_lots_available: wmsLotsAvailable,
      wms_stocktakes_available: wmsStocktakesAvailable,
      stocktake_scans_available: stocktakeScansAvailable,
      payment_imports_available: paymentImportsAvailable,
      payment_import_allocations_available: paymentImportAllocationsIsAvailable,
      proformas_available: proformasIsAvailable,
      proforma_batches_available: proformaBatchesIsAvailable,
      order_fields_available: orderFieldsAvailable,
      order_field_batches_available: orderFieldBatchesAvailable,
      order_field_mappings_available: orderFieldMappingsAvailable,
      workspace_billing_available: workspaceBillingAvailable,
      catalog_ai_available: catalogAiAvailable,
      deepl_available: deeplAvailable,
      deepl_batches_available: deeplBatchAvailable,
    };
  });
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = z
        .object({
          email: z.email(),
          password: z.string().min(1).max(200),
          code: z.string().max(80).optional(),
          invitation_token: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .parse(req.body);
      const user = (
        await pool.query('SELECT * FROM users WHERE email=$1', [input.email.toLowerCase()])
      ).rows[0];
      // 237: every outcome is recorded and a durable per-login counter locks guessing; an unknown
      // address takes exactly the same path (keyed hash, same queries, same answers).
      const attempt = authSecurity237Available ? loginAttempt(req, input.email) : undefined;
      if (attempt && !(await attempt.reserve())) {
        await attempt.record(pool, 'password_locked', 429, user?.id);
        throw new Problem(429, LOGIN_LOCKED_MESSAGE);
      }
      const valid = checkPassword(
        input.password,
        user?.password_hash ??
          '00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      );
      if (attempt && !(user && valid)) await attempt.record(pool, 'password_failed', 401, user?.id);
      ensure(user && valid, 401, 'Nieprawidłowy email lub hasło');
      await attempt?.passed();
      try {
        const result = accountSecurityAvailable
          ? await secureLogin(user, user.password_hash, input.invitation_token, input.code, readOnly,
            attempt && ((c, outcome) => attempt.record(c, outcome, outcome === 'mfa_locked' ? 429 : 401, user.id)))
          : await loginWorkspace(user, input.invitation_token, readOnly);
        if ('mfa_required' in result) return result;
        await attempt?.record(pool, 'success', 200, user.id, result.user.tenant_id);
        sessionCookie(reply, result.token, sessionName);
        return { user: result.user };
      } catch (e) {
        if (attempt && !attempt.recorded && e instanceof Problem) await attempt.record(pool, 'refused', e.status, user.id);
        throw e;
      }
    },
  );
  app.get('/api/auth/me', async (req) => {
    const scoped: { available: boolean; reason?: string } = largeImports.tenantAvailability(req);
    const available = largeImports.available && scoped.available;
    return { user: req.currentUser, restore_preview: readOnly,
      large_import_availability: { available,
        independent_creates: available && largeImports.independentCreates,
        ...(scoped.reason ? { reason: scoped.reason } : {}),
      },
    };
  });
  registerPasswordRecoveryRoutes(app, passwordRecoveryAvailable);
  registerWorkspaceRoutes(app, sessionName, workspaceBillingAvailable);
  if (workspaceBillingAvailable) registerWorkspaceBillingRoutes(app);
  if (workspaceMfaPolicyAvailable) registerWorkspaceSecurityRoutes(app, sessionName);
  registerPickingWaveRoutes(app, pickingWavesAvailable);
  registerNbpRoutes(app,{readOnly,port:nbpRates});
  registerPickingWavePrintRoutes(app, {available:pickingWavesAvailable,readOnly});
  if (accountSecurityAvailable) registerAccountSecurityRoutes(app, sessionName);
  if (authSecurity237Available) registerLoginHistoryRoutes(app, sessionName);
  const crmKeyScopesAvailable = (await pool.query("SELECT to_regclass('public.base_wire218_key_scopes') IS NOT NULL AS present")).rows[0]?.present === true;
  registerDeveloperRoutes(app, { readOnly, port: previewPort, crmKeyScopesAvailable });
  if (authSecurity237Available) registerApiKeyRotationRoutes(app, { crmKeyScopes: crmKeyScopesAvailable });
  registerOutboundRoutes(app);
  registerReturnRoutes(app,{sessionName});
  registerReturnAssistantRoutes(app, { available: returnAssistantIsAvailable, readOnly });
  registerReturnAssistantQueueRoutes(app, { available: returnAssistantQueuesIsAvailable, readOnly });
  registerWarehouseInventoryPolicyRoutes(app, { available: warehouseInventoryPoliciesIsAvailable, readOnly });
  registerReturnDestinationStatusRoutes(app, { available: returnDestinationStatusesIsAvailable, readOnly,
    intakeAvailable: returnDestinationsIsAvailable });
  registerReturnDestinationsRoutes(app, { available: returnDestinationsIsAvailable, readOnly,
    receiveCore: receiveReturnDestinationCoreInTx, applyPhysical: applyReturnDestinationPhysicalInTx });
  registerStocktakeAdjustmentRoutes(app, { available: stocktakeAdjustmentsIsAvailable, readOnly });
  registerWarehouseDocumentRegisterRoutes(app, { available: stocktakeAdjustmentsIsAvailable, readOnly });
  registerWarehouseAutomaticWzRoutes(app, { available: warehouseAutomaticWzIsAvailable, readOnly });
  registerIssuedWzRoutes(app, { readOnly });
  // Only the genuine normal factory capability enables BO activation; each
  // physical effect and actor still passes the unchanged native transaction gates.
  registerCatalogStockControlRoutes(app, { available: catalogStockControlIsAvailable, readOnly, stockWriterInstallation });
  registerCatalogStockCountRoutes(app, { readOnly });
  registerPaymentRoutes(app);
  registerSourcePaymentRoutes(app);
  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[sessionName] ?? req.headers.authorization?.slice(7) ?? '';
    await pool.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(token)]);
    reply.clearCookie(sessionName, { path: '/' });
    return { ok: true };
  });
  registerSalesReportRoutes(app, { readOnly });
  registerSettlementReportRoutes(app, { readOnly });
  app.get('/api/dashboard', async (req) =>
    tenantReadTx(req.actor.tenantId, async (c) => {
      const salePredicate =
        operationalOrderPredicate +
        (returnExchangesIsAvailable ? " AND o.fulfillment_kind='sale'" : '');
      const orders = await c.query(
        `SELECT o.status,o.currency,count(*)::int AS count,sum(o.total)::bigint AS total,coalesce(sum(r.refund_total),0)::bigint AS refund_total FROM orders o LEFT JOIN (SELECT order_id,sum(refund_amount)::bigint AS refund_total FROM return_cases WHERE received_at IS NOT NULL GROUP BY order_id) r ON r.order_id=o.id WHERE ${salePredicate} GROUP BY o.status,o.currency ORDER BY o.status,o.currency`,
      );
      const stock = await c.query(
        'SELECT count(*)::int AS products,coalesce(sum(on_hand),0)::bigint AS on_hand,coalesce(sum(reserved),0)::bigint AS reserved FROM stock',
      );
      const sources = await c.query(
        `SELECT o.source,o.currency,count(*)::int AS count,sum(o.total)::bigint AS total FROM orders o WHERE ${salePredicate} GROUP BY o.source,o.currency ORDER BY o.source,o.currency`,
      );
      const recent = await c.query(
        `SELECT o.id,o.number,o.customer_name,o.total,o.currency,o.status,o.source,o.created_at FROM orders o WHERE ${salePredicate} ORDER BY o.created_at DESC,o.id DESC LIMIT 6`,
      );
      const jobs = await c.query('SELECT state,count(*)::int AS count FROM jobs GROUP BY state');
      return {
        orders: orders.rows,
        stock: stock.rows[0],
        sources: sources.rows,
        recent: recent.rows,
        jobs: jobs.rows,
        currency: (await c.query('SELECT currency FROM tenants WHERE id=$1', [req.actor.tenantId]))
          .rows[0].currency,
      };
    }),
  );
  app.get('/api/warehouses', async (req) =>
    tenantReadTx(req.actor.tenantId, async (c) => ({
      data: (await c.query('SELECT * FROM warehouses ORDER BY name')).rows,
    })),
  );
  app.post('/api/warehouses', async (req) => {
    canWrite(req.actor, true);
    const b = z
      .object({ name: z.string().min(2).max(120), code: z.string().min(1).max(30) })
      .parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const w = (
        await c.query(
          'INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,$4) RETURNING *',
          [randomUUID(), req.actor.tenantId, b.name, b.code],
        )
      ).rows[0];
      await audit(c, req.actor, 'warehouse.create', w.id);
      return w;
    });
  });
  registerCatalogSourceRoutes(app);
  registerOdooCatalogSyncRoutes(app);
  registerSupplierCatalogRoutes(app, { fileSourcesAvailable: supplierFileSourcesIsAvailable });
  registerSupplierFileSourceRoutes(app, { available: supplierFileSourcesIsAvailable, readOnly });
  registerSupplierRemoteRoutes(app, { available: supplierRemoteFeedsIsAvailable, readOnly });
  registerSupplierBulkRoutes(app);
  registerSupplierScheduleRoutes(app);
  registerCatalogRoutes(app, tenantReadTx);
  registerProductCatalogRoutes(app, { available: productCatalogsIsAvailable, readOnly });
  const pimService = createPimService({sessionName,readOnly,cursorKey:localConfig.encryptionKey,transaction:(actor,_write,work)=>tenantTx(actor.tenantId,work)});
  registerPimRoutes(app,{service:pimService,captureActor:request=>pimService.captureActor(request),available:pimDictionariesIsAvailable,nestedAvailable:pimNestedMappingIsAvailable,readOnly});
  registerB2BCatalogScopeRoutes(app, { available: b2bCatalogScopeIsAvailable, readOnly });
  registerCatalogExportRoutes(app, { readOnly });
  registerCatalogExportProfileRoutes(app, { readOnly, available: catalogExportProfilesAvailable });
  registerCatalogFileImportRoutes(app, { readOnly, available: catalogFileImportsAvailable });
  registerOrderProductLogisticsRoutes(app);
  registerCatalogBulkEditRoutes(app, { available: catalogBulkEditAvailable, readOnly });
  registerInventoryBulkEditRoutes(app, { available: inventoryBulkEditAvailable, readOnly });
  registerPriceBulkEditRoutes(app, { available: priceBulkEditAvailable, readOnly });
  registerPriceFileImportRoutes(app, { available: priceFileImportsAvailable, readOnly });
  registerPriceMatrixImportRoutes(app, { available: priceMatrixImportsAvailable, readOnly });
  registerStockFileImportRoutes(app, { available: stockFileImportsAvailable, readOnly });
  registerLanguageFileImportRoutes(app, { available: languageFileImportsAvailable, readOnly });
  registerProductTranslationBulkEditRoutes(app, {
    available: productTranslationBulkEditAvailable,
    readOnly,
  });
  registerPackingWorkstationRoutes(app, { available: packingWorkstationAvailable, readOnly });
  registerPackingPhotoRoutes(app, { readOnly });
  registerPrintJobRoutes(app, { available: printJobsIsAvailable, readOnly });
  registerPackedLabelPrintRoutes(app,{available:packedLabelPrintIsAvailable,readOnly});
  registerShipmentLabelPrintRoutes(app, { available: shipmentLabelPrintIsAvailable, readOnly, sessionName });
  registerShipmentLabelCacheRoutes(app, { available: shipmentLabelCacheIsAvailable, readOnly }, context);
  registerShipmentLabelBatchRoutes(app, { available: shipmentLabelBatchesIsAvailable, readOnly });
  registerOrderParcelRoutes(app, { available: orderParcelsIsAvailable, readOnly, sessionName });
  registerManualOffRoutes(app,{available:await manualOffAvailable(pool),readOnly,sessionName},createManualOffService({pool,hooks:manualOffNativeHooks,cursorKey:localConfig.encryptionKey,readOnly}));
  registerPhysicalParcelWzRoutes(app,{available:physicalParcelWzIsAvailable,readOnly,sessionName},createPhysicalParcelWzService({tenantTx}));
  registerOrderParcelReleaseRoutes(app, { available: orderParcelReleasesIsAvailable, readOnly, sessionName });
  registerWmsLotsRoutes(app, { available: wmsLotsAvailable, readOnly });
  registerWmsStocktakeRoutes(app, { available: wmsStocktakesAvailable, readOnly });
  registerStocktakeScanRoutes(app, { available: stocktakeScansAvailable, readOnly });
  registerProductRuleRoutes(app, { available: productRulesAvailable, readOnly });
  registerProductRuleScheduleRoutes(app,{readOnly});
  registerPaymentImportRoutes(app, { available: paymentImportsAvailable, readOnly });
  registerPaymentImportAllocationRoutes(app, {
    available: paymentImportAllocationsIsAvailable,
    readOnly,
  });
  // The pinned native /issue is an alias of tax-issue (226 snapshot, 230 check); the guard runs before it.
  registerLocalInvoiceIssueAlias(app, { tax226Available: tax226IsAvailable, readOnly, sessionName });
  registerLocalInvoiceRoutes(app,{readOnly,sessionName});
  registerLocalConsumerCreditRoutes(app,{readOnly,sessionName});
  await registerReturnCredit206Routes(app,{readOnly,sessionName});
  registerFa3DraftRoutes(app,{readOnly,sessionName});
  registerFa3DocumentRoutes(app,{sessionName});
  registerJpkRoutes(app, { sessionName });
  registerB2bCreditRoutes(app,{readOnly,sessionName});
  registerB2bInvoiceRoutes(app,{readOnly,sessionName});
  registerProformaRoutes(app, {
    available: proformasIsAvailable,
    readOnly,
    batchesAvailable: proformaBatchesIsAvailable,
  });
  registerProformaBatchRoutes(app, { available: proformaBatchesIsAvailable, readOnly });
  registerOrderFieldRoutes(app, { available: orderFieldsAvailable, readOnly });
  registerOrderFieldBatchRoutes(app, { available: orderFieldBatchesAvailable, readOnly });
  registerOrderFieldMappingRoutes(app, {
    available: orderFieldMappingsAvailable,
    readOnly,
    context,
  });
  registerCatalogAiRoutes(app, {
    available: catalogAiAvailable,
    readOnly,
    transport: integrationTransport,
    // S8 (migration 249): batches, PIM parameters, background removal, channel matches (each only when its table exists).
    extensions: catalogAiAvailable ? await catalogAiExtensionsAvailable(pool) : undefined,
    pim: pimService,
    pimAvailable: pimDictionariesIsAvailable,
    context,
  });
  registerDeepLRoutes(app, context, {
    available: deeplAvailable,
    readOnly,
    batchesAvailable: deeplBatchAvailable,
  });
  registerDeepLBatchRoutes(app, context, { available: deeplBatchAvailable, readOnly });
  registerWarehouseRoutes(app);
  registerPurchasingRoutes(app);
  registerReplenishmentPlanRoutes(app, { available: replenishmentPlansAvailable, readOnly });
  registerReplenishmentAutomationRoutes(app, {
    available: replenishmentAutomationsIsAvailable,
    readOnly,
  });
  registerOrderMergeRoutes(app, { available: orderMergesIsAvailable, readOnly, sessionName });
  if (orderSplitsIsAvailable) registerOrderSplitRoutes(app, { readOnly, sessionName });
  registerOrderSplit222Routes(app, { available: orderSplit222IsAvailable, readOnly });
  registerReturnReasons223Routes(app, { available: returnReasons223IsAvailable, readOnly });
  registerTax226Routes(app, { available: tax226IsAvailable, readOnly, sessionName });
  registerNbp227Routes(app, { available: nbp227IsAvailable, readOnly, sessionName, port: nbpRates });
  registerRodo228Routes(app, { available: rodo228IsAvailable, readOnly, pool, key: localConfig.encryptionKey });
  registerInvoice230Routes(app, { available: invoice230IsAvailable, readOnly, sessionName });
  registerInvoice232Routes(app, { available: invoice230IsAvailable && invoice232IsAvailable, readOnly, sessionName });
  registerReceipt233Routes(app, { available: invoice230IsAvailable && receipt233IsAvailable, readOnly, sessionName });
  registerKsef229Routes(app, { available: ksef229IsAvailable, readOnly, service: ksef229Service({ key: localConfig.encryptionKey, sessionName }) });
  registerKsef243Routes(app, { available: await ksef243Available(pool), readOnly, service: ksef243Service() });
  registerStockLocationRoutes(app, tenantReadTx);
  registerStocktakeRoutes(app);
  app.post('/api/products', async (req, reply) => {
    canWrite(req.actor, true);
    const b = productSchema.parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const p = await createProduct(c, productLogisticsRequestActor(req), b);
      reply.code(201);
      return p;
    });
  });
  app.get('/api/inventory', (req) => {
    const q = inventoryQuery.parse(req.query);
    return tenantTx(req.actor.tenantId, (c) => listInventory(c, q));
  });
  app.get('/api/inventory/snapshot', (req) => {
    const q = inventorySnapshotQuery.parse(req.query);
    return tenantReadTx(req.actor.tenantId, (c) => inventorySnapshot(c, q));
  });
  app.post('/api/inventory/adjust/previews', { onRequest: async () => ensure(!readOnly,423,'Kopia jest tylko do odczytu'), bodyLimit:2*1024*1024 }, async (req,reply) => {
    ensure(wmsLotsAvailable,503,'Kopia nie zawiera WMS partii');
    const actor=captureInventoryCorrectionActor(req,sessionName);
    const result=await previewInventoryCorrection(actor,inventoryCorrectionPreviewInput.parse(req.body));
    reply.header('Cache-Control','no-store').code(result.reused?200:201);
    return result;
  });
  app.get('/api/inventory/adjust/previews/:id',async(req,reply)=>{
    ensure(wmsLotsAvailable,503,'Kopia nie zawiera WMS partii');
    const id=z.uuid().parse((req.params as {id:string}).id);
    const result=await readInventoryCorrectionPreview(captureInventoryCorrectionActor(req,sessionName),id);
    reply.header('Cache-Control','no-store');return result;
  });
  app.post('/api/inventory/adjust', { onRequest: async () => ensure(!readOnly,423,'Kopia jest tylko do odczytu') }, async (req,reply) => {
    canWrite(req.actor,true);
    const b=inventoryAdjustInput.parse(req.body);
    if(b.protocol==='wms_adjustment090'){
      ensure(wmsLotsAvailable,503,'Kopia nie zawiera WMS partii');
      const result=await executeInventoryCorrection(captureInventoryCorrectionActor(req,sessionName),b);
      reply.header('Cache-Control','no-store').code(result.reused?200:201);return result;
    }
    const correctionActor=captureInventoryCorrectionActor(req,sessionName,true);
    return tenantTx(req.actor.tenantId, async (c) => {
      await assertWmsLegacyQuantityWriteInTx(c, req.actor);
      await enlistInventoryLegacyAdjustmentInTx(c, correctionActor, b.product_id);
      await adjustLegacyStockInTx(c, req.actor, b);
      return { ok: true };
    });
  });
  app.get('/api/inventory/movements', (req) => {
    const q = movementQuery.parse(req.query);
    return tenantTx(req.actor.tenantId, (c) => listMovements(c, q));
  });
  // Order list (Uwagi v3 §3): filters and SQL in server/order-list-query.ts.
  let orderListAvailable: OrderListAvailability | undefined;
  const orderListAvailability = async (): Promise<OrderListAvailability> =>
    (orderListAvailable ??= {
      salesDimensions: Boolean(
        (await pool.query("SELECT to_regclass('public.order_sales_dimensions') IS NOT NULL AS ok")).rows[0].ok,
      ),
      receipts: receipt233IsAvailable,
    });
  app.get('/api/orders/filter-options', async (req) => {
    const available = await orderListAvailability();
    return tenantReadTx(req.actor.tenantId, (c) => orderListFilterOptions(c, available));
  });
  app.get('/api/orders', async (req) => {
    const q = orderListQuerySchema.parse(req.query);
    const wantsFields = q.field_filters !== undefined || q.field_columns !== undefined;
    ensure(
      !wantsFields || !req.apiScopes || req.apiScopes.includes('order-fields:read'),
      403,
      'Klucz wymaga zakresu order-fields:read',
    );
    ensure(!wantsFields || orderFieldsAvailable, 503, 'Kopia nie zawiera pól dodatkowych');
    let fieldFilters: ReturnType<typeof orderFieldFiltersSchema.parse> = [];
    let fieldColumns: ReturnType<typeof orderFieldColumnsSchema.parse> = [];
    try {
      fieldFilters = orderFieldFiltersSchema.parse(
        q.field_filters ? JSON.parse(q.field_filters) : [],
      );
      fieldColumns = orderFieldColumnsSchema.parse(
        q.field_columns ? JSON.parse(q.field_columns) : [],
      );
    } catch {
      throw new Problem(422, 'Nieprawidłowe filtry lub kolumny pól dodatkowych');
    }
    let cursor: { date: string; id: string } | null = null;
    if (q.after) {
      try {
        cursor = z
          .object({ date: z.iso.datetime(), id: z.uuid() })
          .parse(JSON.parse(Buffer.from(q.after, 'base64url').toString()));
      } catch {
        throw new Problem(422, 'Nieprawidłowy kursor');
      }
    }
    const params = new OrderListParams();
    let conditions: string;
    try {
      conditions = orderListConditions(q, params, await orderListAvailability());
    } catch (e) {
      if (e instanceof OrderListUnavailable) throw new Problem(503, e.message);
      throw e;
    }
    const paging = orderListPaging(params, cursor, q.limit);
    const readOrders = wantsFields ? tenantTx : tenantReadTx;
    return readOrders(req.actor.tenantId, async (c) => {
      const fieldScope = wantsFields
        ? await orderFieldListScopeInTx(c, req.actor, fieldFilters, fieldColumns, {
            alias: 'o',
            paramOffset: params.values.length,
          })
        : { sql: '', params: [], columns: [] };
      const rows = (
        await c.query(
          orderListSql({
            conditions,
            paging,
            paymentSummarySql: orderListPaymentSql,
            operationalPredicate: operationalOrderPredicate,
            extraSql: fieldScope.sql,
          }),
          [...params.values, ...fieldScope.params],
        )
      ).rows;
      const more = rows.length > q.limit;
      const data: any[] = rows.slice(0, q.limit).map(withPaymentFields);
      if (fieldColumns.length) {
        const projected = await projectOrderFieldColumnsInTx(
          c,
          req.actor,
          data.map((row) => row.id),
          fieldScope.columns,
        );
        for (const row of data) row.extra_fields = projected.get(row.id) ?? [];
      }
      const last = data.at(-1);
      const nextCursor =
        more && last
          ? Buffer.from(JSON.stringify({ date: last.cursor_time, id: last.id })).toString(
              'base64url',
            )
          : null;
      for (const row of data) delete row.cursor_time;
      return {
        data,
        meta: {
          has_more: more,
          cursor: nextCursor,
        },
      };
    });
  });
  // Counters for the status panel next to the order list: same rows as GET /api/orders.
  app.get('/api/orders/status-counts', async (req) =>
    tenantReadTx(req.actor.tenantId, async (c) => {
      // Fulfilment stage, not the raw code: packed orders with an undispatched label count as
      // ready_to_ship (server/order-stage-query.ts), so statuses.packed excludes them.
      const statuses = (
        await c.query(
          `SELECT ${orderFulfilmentStageSql('o')} AS status,count(*)::int AS count FROM orders o WHERE ${operationalOrderPredicate} GROUP BY 1`,
        )
      ).rows;
      const payments = (
        await c.query(
          `SELECT ${paymentStateSql('o', orderListPaymentSql)} AS state,count(*)::int AS count FROM orders o WHERE ${operationalOrderPredicate} GROUP BY 1`,
        )
      ).rows;
      const paymentCount = (state: string) => payments.find((r) => r.state === state)?.count ?? 0;
      const workflow = (
        await c.query(
          `SELECT o.workflow_status_id AS id,count(*)::int AS count FROM orders o JOIN workflow_statuses w ON w.id=o.workflow_status_id AND w.active WHERE ${operationalOrderPredicate} GROUP BY o.workflow_status_id`,
        )
      ).rows;
      return {
        statuses: Object.fromEntries(statuses.map((r) => [r.status, r.count])),
        workflow: Object.fromEntries(workflow.map((r) => [r.id, r.count])),
        payment: { unpaid: paymentCount('unpaid'), partial: paymentCount('partial'), overpaid: paymentCount('overpaid'), cod: paymentCount('cod') },
        total: statuses.reduce((sum, r) => sum + r.count, 0),
      };
    }),
  );
  app.get('/api/orders/:id', async (req) =>
    tenantReadTx(req.actor.tenantId, (c) => cardPayload(c, req.actor, idOf(req.params), req.apiScopes)),
  );
  // Channel data of the order card (tab "Kanał sprzedaży"): the projection the rule conditions read.
  app.get('/api/orders/:id/channel-data', async (req) => {
    const id = idOf(req.params);
    const data = await tenantReadTx(req.actor.tenantId, (c) => orderChannelData(c, id));
    ensure(data, 404, 'Nie znaleziono zamówienia');
    return data;
  });
  app.post('/api/orders', async (req, reply) => {
    canWrite(req.actor);
    const b = orderSchema.parse(req.body),
      key = req.headers['idempotency-key'];
    ensure(
      !b.initial_fields?.length || !req.apiScopes || req.apiScopes.includes('order-fields:write'),
      403,
      'Klucz wymaga zakresu order-fields:write',
    );
    if (key)
      ensure(typeof key === 'string' && key.length <= 128, 422, 'Nieprawidłowy klucz idempotencji');
    return tenantTx(req.actor.tenantId, async (c) => {
      if (key) {
        const hash = createHash('sha256').update(JSON.stringify(b)).digest('hex');
        await c.query(
          'INSERT INTO idempotency_keys(tenant_id,key,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [req.actor.tenantId, key, hash],
        );
        const prior = (
          await c.query('SELECT * FROM idempotency_keys WHERE key=$1 FOR UPDATE', [key])
        ).rows[0];
        ensure(prior.request_hash === hash, 409, 'Klucz idempotencji użyty z innymi danymi');
        if (prior.response) return prior.response;
        const order = await createOrder(c, req.actor, b, undefined, {
          fieldSource: req.apiScopes ? 'api' : 'manual',
          fieldWritesAllowed: !req.apiScopes || req.apiScopes.includes('order-fields:write'),
        });
        await c.query('UPDATE idempotency_keys SET response=$1 WHERE key=$2', [
          JSON.stringify(order),
          key,
        ]);
        reply.code(201);
        return order;
      }
      reply.code(201);
      return createOrder(c, req.actor, b, undefined, {
        fieldSource: req.apiScopes ? 'api' : 'manual',
        fieldWritesAllowed: !req.apiScopes || req.apiScopes.includes('order-fields:write'),
      });
    });
  });
  app.patch('/api/orders/:id/status', async (req) => {
    canWrite(req.actor);
    const { status, expected_version } = orderStatusInput.parse(req.body);
    return tenantTx(req.actor.tenantId, (c) => transitionDirectLegacyOnReturnInTx(c, req.actor, idOf(req.params), status, expected_version));
  });
  registerOrderEditRoutes(app);
  registerOrderLookupRoutes(app);
  app.post('/api/orders/:id/scan', async (req) => {
    canWrite(req.actor);
    const { code, location, layer_id, client_key } = locationScan.parse(req.body);
    return tenantTx(req.actor.tenantId, (c) =>
      scan(c, req.actor, idOf(req.params), code, location, undefined, { layer_id, client_key }),
    );
  });
  app.post('/api/orders/:id/ship-demo', async (req) => {
    canWrite(req.actor);
    return tenantTx(req.actor.tenantId, (c) => shipDemo(c, req.actor, idOf(req.params)));
  });
  // Uwagi v3 §7: demo label first (Gotowe do nadania), then ship-demo hands it to the carrier.
  app.post('/api/orders/:id/demo-label', async (req) => {
    canWrite(req.actor);
    return tenantTx(req.actor.tenantId, (c) => createDemoLabel(c, req.actor, idOf(req.params)));
  });
  // uwaga klienta §7 (266): "Drukuj etykietę przy pakowaniu" (the DEMO label right after packing).
  registerOrderSettingsRoutes(app, { readOnly });
  // Automation rules v2 events: "Zgłoś brak", "Anuluj etykietę", "Symuluj status przewoźnika (DEMO)".
  registerOrderEventRoutes(app, { readOnly });
  app.post('/api/orders/:id/documents', async (req) => {
    canWrite(req.actor);
    const { kind } = z.object({ kind: z.enum(['invoice', 'correction']) }).parse(req.body);
    return tenantTx(req.actor.tenantId, (c) => issueDocument(c, req.actor, idOf(req.params), kind));
  });
  app.get('/api/documents', async (req) =>
    tenantReadTx(req.actor.tenantId, async (c) => ({
      data: (
        await c.query(
          'SELECT d.*,o.number AS order_number FROM documents d JOIN orders o ON o.id=d.order_id AND o.tenant_id=d.tenant_id ORDER BY d.created_at DESC LIMIT 100',
        )
      ).rows,
    })),
  );
  app.get('/api/documents/:id/print', async (req, reply) => {
    const mode = await tenantTx(
      req.actor.tenantId,
      async (c) =>
        (await c.query('SELECT mode FROM documents WHERE id=$1', [idOf(req.params)])).rows[0]?.mode,
    );
    if (mode === 'local_invoice') {
      const value=await localInvoiceDetail(localInvoiceRequestActor(req,sessionName),idOf(req.params));
      return reply.type('text/html; charset=utf-8').header('Cache-Control','no-store').send(localInvoicePrintHtml(value.document));
    }
    if (mode === 'invoice230') {
      const value = await invoice230Detail(taxInvoiceActor(req as never, sessionName), idOf(req.params));
      return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(invoice230PrintHtml(value.document, value.receipt));
    }
    if (mode === 'external') {
      ensure(!readOnly, 423, 'Pobieranie dokumentu od dostawcy jest wyłączone w podglądzie kopii');
      return reply
        .type('application/pdf')
        .header('Cache-Control', 'no-store')
        .header('Content-Disposition', 'inline; filename=invoice.pdf')
        .send(await invoicePdf(req.actor.tenantId, idOf(req.params), context));
    }
    return tenantTx(req.actor.tenantId, async (c) => {
      const d = (await c.query('SELECT * FROM documents WHERE id=$1', [idOf(req.params)])).rows[0];
      ensure(d, 404, 'Nie znaleziono dokumentu');
      return reply
        .type('text/html')
        .header('Cache-Control', 'no-store')
        .send(printLayout(d.number, documentBody(d), d.kind === 'proforma' && d.mode === 'local'));
    });
  });
  app.get('/api/shipments/:id/label', async (req, reply) => {
    const s = await tenantTx(req.actor.tenantId, (c) => shipmentLabelSourceInTx(c, req.actor.tenantId, idOf(req.params)));
    ensure(s, 404, 'Nie znaleziono przesyłki');
    reply.header('Cache-Control', 'no-store');
    if (s.mode !== 'demo' && s.carrier === 'DPD Polska')
      return reply.type('application/pdf').send(await cachedDpdLabel(req.actor.tenantId, s.id));
    // DHL and Poczta Polska labels are stored with the plan at creation: no provider request.
    if (s.mode !== 'demo' && s.carrier === CARRIER_NAMES.dhl)
      return reply.type('application/pdf').send(await cachedDhlLabel(req.actor.tenantId, s.id));
    if (s.mode !== 'demo' && s.carrier === CARRIER_NAMES.pocztapolska)
      return reply.type('application/pdf').send(await cachedPocztaPolskaLabel(req.actor.tenantId, s.id));
    if (s.mode !== 'demo') {
      ensure(!readOnly, 423, 'Pobieranie etykiety od dostawcy jest wyłączone w podglądzie kopii');
      return reply
        .type('application/pdf')
        .send(await shipmentLabel(req.actor.tenantId, s.id, context));
    }
    return reply.type('text/html').send(demoShipmentLabelHtml(s));
  });
  registerAuditRoutes(app, { readOnly });
  registerSmsRoutes(app,sessionName);
  registerSmsSubmissionRoutes(app,{readOnly,sessionName,auth:pool,tenantTx,encrypt});
  registerEmailRoutes(app, emailAvailable, emailAttachmentsAvailable, context);
  registerEmailInboundRoutes(app, { available: emailInboundAvailable, readOnly });
  registerOperationRoutes(app);
  registerAutomationScheduleRoutes(app);
  app.get('/api/settings', async (req) =>
    tenantReadTx(req.actor.tenantId, async (c) => ({
      tenant: (await c.query('SELECT * FROM tenants')).rows[0],
      warehouses: (await c.query('SELECT * FROM warehouses ORDER BY name')).rows,
      capabilities: {
        sessions: '8h',
        roles: ['admin', 'operator', 'viewer'],
        documents: 'demo',
        external_writes: 'explicit_confirmation',
      },
    })),
  );
  registerImportRoutes(app, context);
  registerOfferRoutes(app, context);
  registerLocalSimulationOfferRoutes(app, {readOnly});
  registerLocalWooFlowRoutes(app, {readOnly,sessionName});
  registerLocalAutomationRoutes(app, {readOnly});
  // A process with the global loop already runs automation jobs itself, so only the ordinary shape lets an admin start it.
  const scopedProcessor=createScopedProcessorControl(readOnly?'UNAVAILABLE':scopedAutomationEnabled?'INSTALLATION':backgroundWorkersEnabled?'UNAVAILABLE':'WORKSPACE',
    tenants=>startScopedAutomationWorker(localWooTransport?{transport:localWooTransport,localWooChannelIds}:{},tenants?{tenants}:{}));
  registerAutomaticWorkerControl(app,{readOnly,available:scopedProcessor.mode==='INSTALLATION'||(tenant=>scopedProcessor.running(tenant)),localWooChannelIds});
  registerWorkerSupervisionRoutes(app,{backgroundWorkersEnabled,scopedAutomationEnabled:scopedAutomationEnabled&&!readOnly,readOnly,scopedProcessor});
  registerReconciliationQueueRoutes(app);
  registerMessageOutcomeRoutes(app,{readOnly,sessionName});
  if(scopedProcessor.mode==='INSTALLATION')app.addHook('onListen',async()=>{scopedProcessor.startInstallation();});
  if(scopedProcessor.mode!=='UNAVAILABLE')app.addHook('onClose',async()=>{await scopedProcessor.close();});
  registerShopifyOfferRoutes(app, context);
  registerVariantOfferRoutes(app);
  registerAllegroBatchRoutes(app);
  registerOfferSyncRoutes(app, {readOnly, sessionName});
  registerOrderStatusRoutes(app, context);
  registerEbayFulfillmentRoutes(app, context);
  registerAmazonFulfillmentRoutes(app, context, amazonFulfillmentAvailable);
  registerAmazonMcfReadOnlyRoutes(app, context, readOnly, amazonMcfReadTransport);
  registerShopifyFulfillmentRoutes(app, context, shopifyFulfillmentAvailable, readOnly);
  registerPricingRoutes(app);
  registerRepricingRoutes(app, { sessionName, readOnly });
  registerCompetitorObservationRoutes(app, { pool, cursorKey: localConfig.encryptionKey, sessionName, readOnly });
  registerBuyerAddressRoutes(app, { pool, encryptionKey: localConfig.encryptionKey, sessionName, readOnly });
  registerRepricingScheduleRoutes(app);
  registerShippingRoutes(app, context);
  registerLocalCarrierRoutes(app, {readOnly});
  registerDpdRoutes(app);
  registerDhlShippingRoutes(app);
  registerPocztaPolskaShippingRoutes(app);
  registerDhlPickupRoutes(app);
  registerCollectionRoutes(app, context, readOnly);
  registerDpdPickupScheduleRoutes(app);
  registerB2bRoutes(app, { readOnly, previewPort, printLayout });
  registerB2bNetworkRoutes(app);
  registerB2bNetworkOrderRoutes(app, printLayout);
  registerB2bNetworkDropshippingRoutes(app, { available: b2bDropshippingIsAvailable, readOnly });
  registerB2bExternalOrderIntentRoutes(app, {
    available: b2bExternalOrderIntentsIsAvailable,
    readOnly,
  });
  registerB2bExternalOrderImportRoutes(
    app,
    { available: b2bExternalOrderImportsIsAvailable, readOnly },
    context,
  );
  registerB2bNetworkReturnRoutes(app);
  registerB2bDropshippingReturnRoutes(app, {
    available: b2bDropshippingReturnsIsAvailable,
    readOnly,
  });
  registerTrackingRoutes(app);
  registerInvoiceRoutes(app, context);
  registerOdooExportRoutes(app, context);
  registerOdooImageRoutes(app, context);
  registerSyncRoutes(
    app,
    context,
    sessionName,
    shopifyWebhooksAvailable,
    shopifySubscriptionsAvailable,
  );
  if (
    (await pool.query("SELECT to_regclass('public.amazon_oauth_states') present")).rows[0].present
  )
    registerAmazonOAuthRoutes(app, context, sessionName);
  if (
    (await pool.query("SELECT to_regclass('public.shopify_oauth_states') present")).rows[0].present
  )
    registerShopifyOAuthRoutes(app, context, sessionName, readOnly);
  if (shopifyWebhooksAvailable) registerShopifyWebhookRoutes(app);
  if (shopifySubscriptionsAvailable) registerShopifySubscriptionRoutes(app, context);
  registerShopifyTranslationRoutes(app, context, {
    available: shopifyTranslationsAvailable,
    readOnly,
  });
  registerShopifyTranslationBatchRoutes(app, context, {
    available: shopifyTranslationBatchesAvailable,
    readOnly,
  });
  app.post('/api/integrations/odoo-example', async (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
    return tenantTx(req.actor.tenantId, async (c) => {
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [req.actor.tenantId]);
      let ch = (
        await c.query(
          "SELECT id FROM channels WHERE provider='odoo' AND settings->>'simulation'='true' ORDER BY created_at LIMIT 1",
        )
      ).rows[0];
      if (!ch)
        ch = (
          await c.query(
            "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,'odoo','Odoo — przykład lokalny','sandbox',$3,$4,'simulation') RETURNING id",
            [
              randomUUID(),
              req.actor.tenantId,
              encrypt({}),
              JSON.stringify({
                simulation: true,
                company_id: '1',
                warehouse_id: '1',
                unit_id: '1',
                price_mode: 'net',
              }),
            ],
          )
        ).rows[0];
      return { channel_id: ch.id, scope: 'local_simulation', context: demoOdooContext };
    });
  });
  app.post('/api/integrations/smtp-example', async (req) => {
    ensure(emailAvailable, 404, 'Email nie jest dostępny w tym schemacie');
    canWrite(req.actor, true);
    const port = localSmtpPort();
    return tenantTx(req.actor.tenantId, async (c) => {
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [req.actor.tenantId]);
      let ch = (
        await c.query(
          "SELECT id FROM channels WHERE tenant_id=$1 AND provider='smtp' AND mode='sandbox' AND settings->>'delivery'='local_sink' AND settings->>'host'='127.0.0.1' AND settings->>'port'=$2 AND settings->>'from_email' LIKE '%.test' ORDER BY created_at LIMIT 1",
          [req.actor.tenantId, String(port)],
        )
      ).rows[0];
      if (!ch)
        ch = (
          await c.query(
            "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,'smtp','Lokalny SMTP — bez wysyłki zewnętrznej','sandbox',$3,$4,'local') RETURNING id",
            [
              randomUUID(),
              req.actor.tenantId,
              encrypt({}),
              JSON.stringify({
                delivery: 'local_sink',
                host: '127.0.0.1',
                port,
                from_email: 'orders@dynaminds.example.test',
                from_name: 'DYNAMINDS QA',
              }),
            ],
          )
        ).rows[0];
      return { channel_id: ch.id, delivery: 'local_sink' };
    });
  });
  app.get('/api/integrations', async (req) =>
    tenantTx(req.actor.tenantId, async (c) => ({
      registry,
      channels: (
        await c.query(
          'SELECT id,provider,name,mode,settings,status,created_at,sync_enabled,last_sync_at,oauth_scopes FROM channels ORDER BY created_at DESC',
        )
      ).rows,
      runs: (await c.query('SELECT * FROM integration_runs ORDER BY created_at DESC LIMIT 30'))
        .rows,
    })),
  );
  registerLocalWooHttpFixtureRoutes(app,{fixture:localWooFixture,registry:localWooRegistry,readOnly,sessionName});
  // Worker is assigned onListen below; the route only reads it at request time.
  registerLocalWooStockLaneRoutes(app,{lane:localWooStockLane,readOnly,sessionName,processorRunning:()=>localWooStockWorker?.inspect().running===true});
  let localWooStockWorker:ReturnType<typeof startLocalWooStockWorker>|undefined;
  if(localWooStockLane){
    app.addHook('onListen',async()=>{localWooStockWorker=startLocalWooStockWorker(localWooStockLane);});
    app.addHook('onClose',async()=>{if(localWooStockWorker)await localWooStockWorker.close();else await localWooStockLane.close();});
  }
  let localWooReadWorker:ReturnType<typeof startLocalWooReadWorker>|undefined;
  registerLocalWooOrderImportRoutes(app,{lane:localWooOrderImport,readOnly,sessionName,running:()=>localWooReadWorker?.inspect().running===true});
  registerLocalWooReadLaneRoutes(app,{lane:localWooReadLane,readOnly,sessionName,processorRunning:()=>localWooReadWorker?.inspect().running===true});
  if(localWooReadLane){
    app.addHook('onListen',async()=>{localWooReadWorker=startLocalWooReadWorker(localWooReadLane);});
    app.addHook('onClose',async()=>{if(localWooReadWorker)await localWooReadWorker.close();else await localWooReadLane.close();});
  }
  connectorJobsAvailable=await registerOrdinaryConnectorJobs(app,{mode:connectorJobExecution,transport:ordinaryConnectorTransport,context,readOnly,localFixture:hasLocalWoo,sessionName});
  registerIntegrationWorkspaceRoutes(app);
  registerIntegrationRecoveryRoutes(app, { pool, cursorKey: localConfig.encryptionKey, sessionName, readOnly });
  // Identity reads use the same current-session/MFA policy as ordinary middleware.
  // Only tenant metadata is read inside the native read transaction; HTTP runs after it closes.
  const currentMiraklChannel=async(actor:MiraklReadActor,channelId:string)=>{
    return tenantReadTx(actor.tenantId,async c=>{
      const security={accountSecurityAvailable,workspaceMfaPolicyAvailable,readOnly};
      await assertMiraklSessionAuthorityInTx(c,actor,security);
      const channel=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2',[actor.tenantId,channelId])).rows[0]??null;
      await assertMiraklSessionAuthorityInTx(c,actor,security);return channel;
    });
  };
  const miraklReads=registerMiraklReadRoutes(app,{sessionName,readOnly,
    externalReadsEnabled:miraklReadRepository!==undefined,repository:miraklReadRepository,
    transport:ordinaryConnectorTransport,currentChannel:currentMiraklChannel,decryptCredentials:decrypt,
    stageOrders:async(actor,channelId,connectionHash,rows)=>tenantTx(actor.tenantId,async c=>{
      await context.miraklImportAuthority!(c,actor,channelId);
      const channel=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2 FOR SHARE',[actor.tenantId,channelId])).rows[0];
      ensure(channel&&miraklChannelConnectionHash(channel)===connectionHash,409,'Mirakl: połączenie zmieniło się przed zapisem kolejki');
      const data=rows.length?await stageOrders(c,{tenantId:actor.tenantId,userId:actor.userId,role:'admin'},channel,[...rows]):[];
      await audit(c,{tenantId:actor.tenantId,userId:actor.userId,role:'admin'},'integration.mirakl.orders.stage',channelId,{count:data.length,connection_hash:connectionHash});
      return {data};
    })});
  app.post('/api/integrations', async (req) => {
    canWrite(req.actor, true);
    const b = z
      .object({
        provider: z.enum([
          'allegro',
          'woocommerce',
          'prestashop',
          'shopify',
          'inpost',
          'dpd',
          'dhl',
          'pocztapolska',
          'fakturownia',
          'smsapi',
          'smtp',
          'bigbuy',
          'odoo',
          'ebay',
          'amazon',
          'deepl',
          'mirakl',
        ]),
        name: z.string().min(2).max(120),
        mode: z.enum(['sandbox', 'live']),
        credentials: z.record(z.string(), z.string().max(10000)),
        settings: z.record(z.string(), z.string().max(2000)).default({}),
      })
      .parse(req.body);
    const p = registry.find((p) => p.id === b.provider)!;
    for (const field of p.fields) {
      if (b.provider === 'shopify') continue;
      if (b.provider === 'ebay' && ['refresh_token', 'ru_name'].includes(field)) continue;
      if (b.provider === 'amazon' && field === 'refresh_token') continue;
      if (b.provider === 'allegro' && field !== 'access_token') continue;
      if (b.provider === 'pocztapolska' && field.startsWith('tracking_')) continue;
      ensure(b.credentials[field]?.trim(), 422, `Brak pola: ${field}`);
    }
    for (const key of p.settings) {
      if (['ebay', 'amazon', 'smtp', 'shopify', 'deepl', 'mirakl'].includes(b.provider)) continue;
      ensure(b.settings[key], 422, `Brak pola: ${key}`);
      if (b.provider === 'odoo' && key !== 'server_url') continue;
      b.settings[key] =
        key === 'sender'
          ? z
              .string()
              .regex(/^[A-Za-z0-9 ._-]{1,11}$/)
              .parse(b.settings[key])
          : key === 'sap_account'
            ? z.string().regex(/^\d{4,10}$/, 'Numer klienta SAP DHL to 4–10 cyfr').parse(b.settings[key])
          : key === 'urzad_nadania'
            ? z.string().regex(/^[1-9]\d{0,9}$/, 'ID urzędu nadania eNadawcy to liczba').parse(b.settings[key])
          : key === 'master_fid'
            ? z
                .string()
                .regex(/^[1-9]\d{0,9}$/)
                .refine((v) => Number(v) <= 2147483647)
                .parse(b.settings[key])
            : key === 'shop_id'
              ? psId(b.settings[key])
              : key === 'order_state_ids'
                ? psStateIds(b.settings[key]).join(',')
                : key === 'organization_id'
                  ? z
                      .string()
                      .regex(/^[1-9]\d{0,17}$/)
                      .parse(b.settings[key])
                  : await validateRemoteUrl(b.settings[key]);
    }
    if (b.provider === 'smtp') {
      const settings = smtpSettings.parse(b.settings);
      ensure(
        settings.delivery === 'external',
        422,
        'Użyj osobnej konfiguracji lokalnego odbiornika',
      );
      b.settings = settings as any;
      b.credentials = smtpCredentials.parse(b.credentials);
    }
    if (b.provider === 'mirakl') {
      b.settings = safeMiraklPublicSettings(b.settings);
      b.credentials = parseMiraklCredentials(b.credentials);
    }
    if (b.provider === 'deepl') {
      ensure(b.mode === 'live', 422, 'DeepL Free i Pro są rzeczywistymi API; brak sandboxu');
      b.settings = deeplSettings.parse(b.settings);
      b.credentials = deeplCredentials.parse(b.credentials);
      ensure(
        b.credentials.api_key.endsWith(':fx') === (b.settings.api_plan === 'free'),
        422,
        'Klucz :fx wymaga API Free',
      );
    }
    if (b.provider === 'smsapi') {
      ensure(b.mode === 'sandbox', 422, 'SMSAPI obsługuje obecnie wyłącznie test=1');
      b.settings = { sender: b.settings.sender };
      b.credentials = { access_token: b.credentials.access_token };
    }
    if (b.provider === 'dpd') {
      b.settings = { master_fid: b.settings.master_fid };
      b.credentials = {
        username: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[^:\r\n]+$/)
          .parse(b.credentials.username),
        password: z
          .string()
          .min(1)
          .max(1000)
          .regex(/^[^\r\n]+$/)
          .parse(b.credentials.password),
      };
    }
    if (b.provider === 'dhl' || b.provider === 'pocztapolska') {
      // Login and password per tenant; the endpoint follows the mode only (no URL override).
      const login = z.string().trim().min(1).max(100).regex(/^[^:\r\n\x00-\x1f]+$/);
      const secret = z.string().min(1).max(200).regex(/^[^\r\n\x00-\x1f]+$/);
      const tracking = b.provider === 'pocztapolska' && Boolean(b.credentials.tracking_login?.trim() || b.credentials.tracking_password);
      b.settings = b.provider === 'dhl' ? { sap_account: b.settings.sap_account } : { urzad_nadania: b.settings.urzad_nadania };
      b.credentials = {
        username: login.parse(b.credentials.username),
        password: secret.parse(b.credentials.password),
        ...(tracking
          ? { tracking_login: login.parse(b.credentials.tracking_login), tracking_password: secret.parse(b.credentials.tracking_password) }
          : {}),
      };
    }
    if (b.provider === 'bigbuy') {
      b.settings = {};
      b.credentials = { api_key: bigbuyToken.parse(b.credentials.api_key) };
    }
    if (b.provider === 'odoo') {
      odooConfig(b.settings, b.credentials);
      b.settings = Object.fromEntries(p.settings.map((key) => [key, b.settings[key]]));
      b.credentials = { api_key: b.credentials.api_key };
    }
    if (b.provider === 'amazon') {
      b.settings = amazonSettings.parse(b.settings) as any;
      b.credentials = amazonConnectionCredentials.parse(b.credentials);
    }
    if (b.provider === 'ebay') {
      b.settings = ebaySettings.parse(b.settings) as any;
      b.credentials = ebayConnectionCredentials(b.credentials);
    }
    if (b.provider === 'shopify') {
      z.object({ store_url: z.string(), oauth_redirect_uri: z.string().optional() })
        .strict()
        .parse(b.settings);
      b.settings = {
        store_url: shopifyStore(b.settings.store_url),
        ...(b.settings.oauth_redirect_uri
          ? { oauth_redirect_uri: shopifyRedirect(b.settings.oauth_redirect_uri) }
          : {}),
      };
      b.credentials = Object.fromEntries(
        Object.entries(
          shopifyConnectionCredentials.parse(
            Object.fromEntries(Object.entries(b.credentials).filter(([, v]) => v !== '')),
          ),
        ).filter(([, v]) => v !== undefined),
      ) as Record<string, string>;
    }
    if (b.provider === 'prestashop') {
      ensure(
        /^[A-Za-z0-9]{32}$/.test(b.credentials.api_key),
        422,
        'Klucz Webservice PrestaShop musi mieć 32 znaki',
      );
      // Reject synthetic flags submitted as strings; examples are separate authenticated routes.
      b.settings = {
        store_url: b.settings.store_url,
        shop_id: b.settings.shop_id,
        order_state_ids: b.settings.order_state_ids,
      };
    }
    if (b.provider === 'fakturownia')
      ensure(
        new URL(b.settings.account_url).hostname.endsWith('.fakturownia.pl'),
        422,
        'Wymagana domena konta Fakturownia',
      );
    return tenantTx(req.actor.tenantId, async (c) => {
      const id = randomUUID();
      await c.query(
        'INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          req.actor.tenantId,
          b.provider,
          b.name,
          b.mode,
          encrypt(b.credentials),
          JSON.stringify(b.settings),
        ],
      );
      await audit(c, req.actor, 'integration.create', id, { provider: b.provider, mode: b.mode });
      const pendingOAuth =
        b.provider === 'allegro' ||
        (b.provider === 'shopify' && !b.credentials.access_token) ||
        (['ebay', 'amazon'].includes(b.provider) && !b.credentials.refresh_token);
      if (pendingOAuth)
        await c.query("UPDATE channels SET status='awaiting_oauth' WHERE id=$1", [id]);
      return { id, status: pendingOAuth ? 'awaiting_oauth' : 'not_verified' };
    });
  });
  app.post('/api/integrations/:id/test', async (req) => {
    canWrite(req.actor, true);
    const id = idOf(req.params);
    const ch = await tenantTx(
      req.actor.tenantId,
      async (c) => (await c.query('SELECT * FROM channels WHERE id=$1', [id])).rows[0],
    );
    ensure(ch, 404, 'Nie znaleziono integracji');
    ensure(!ch.settings.simulation, 422, 'To połączenie zawiera wyłącznie lokalny przykład');
    const requestContext = withAllegroRequestContext(context, req, sessionName);
    let result: string = 'verified_read',
      failure: unknown;
    try {
      if (ch.provider === 'mirakl') await miraklReads.readAccount(req);
      else if (ch.provider === 'amazon') await readAmazonOrders(req.actor, ch, undefined, context);
      else if (ch.provider === 'ebay') await readEbayOrders(req.actor, ch, undefined, context);
      else await channelRead(req.actor.tenantId, id, (client) => client.test(), requestContext);
    } catch (e) {
      result = 'error';
      failure = e;
    }
    if(ch.provider==='mirakl'){
      const latest=await currentMiraklChannel(captureMiraklReadActor(req,sessionName),id);
      ensure(latest&&miraklChannelConnectionHash(latest)===miraklChannelConnectionHash(ch),409,'Mirakl: połączenie zmieniło się podczas testu');
    }
    await tenantTx(req.actor.tenantId, async (c) => {
      if(ch.provider==='mirakl'){
        const actor=captureMiraklReadActor(req,sessionName);
        await context.miraklImportAuthority!(c,actor,id);
        ensure((await c.query('SELECT public.offer_sync_is_admin($1) AS ok',[actor.userId])).rows[0]?.ok===true,403,'Mirakl: administrator utracił uprawnienia');
        const latest=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[actor.tenantId,id])).rows[0];
        ensure(latest&&miraklChannelConnectionHash(latest)===miraklChannelConnectionHash(ch),409,'Mirakl: połączenie zmieniło się przed zapisem wyniku testu');
      }
      if (ch.provider === 'allegro')
        await enlistAllegroContextInTx(c, requestContext, req.actor.tenantId, id, req.actor.userId);
      if (ch.provider === 'amazon') await amazonReadPolicy(c, req.actor, ch);
      if (ch.provider === 'ebay') await ebayReadPolicy(c, req.actor, ch);
      await c.query('UPDATE channels SET status=$1 WHERE id=$2', [result, id]);
      await c.query(
        'INSERT INTO integration_runs(id,tenant_id,channel_id,operation,status,detail) VALUES($1,$2,$3,$4,$5,$6)',
        [
          randomUUID(),
          req.actor.tenantId,
          id,
          'connection',
          result,
          JSON.stringify(
            failure
              ? { error: failure instanceof Problem ? failure.message : 'Brak odpowiedzi dostawcy' }
              : { scope: 'read_only' },
          ),
        ],
      );
      await audit(c, req.actor, 'integration.test', id, { status: result });
    });
    if (failure) throw failure;
    return { ok: true, status: result, scope: 'read_only' };
  });
  app.get('/api/integrations/:id/preview', async (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
    const q = z
        .object({
          cursor: z.string().min(1).max(2048).optional(),
          resource: z.enum(['orders', 'products', 'invoices']).default('orders'),
          page: z.coerce.number().int().min(1).max(1000).default(1),
        })
        .parse(req.query),
      id = idOf(req.params);
    const ch = await tenantTx(
      req.actor.tenantId,
      async (c) => (await c.query('SELECT * FROM channels WHERE id=$1', [id])).rows[0],
    );
    ensure(ch, 404, 'Nie znaleziono integracji');
    ensure(!ch.settings.simulation, 422, 'To połączenie zawiera wyłącznie lokalny przykład');
    if (ch.provider === 'ebay') {
      ensure(
        q.resource === 'orders' && q.page === 1,
        422,
        'eBay: podgląd zamówień korzysta z cursora',
      );
      return readEbayOrders(req.actor, ch, q.cursor, context);
    }
    return channelRead(
      req.actor.tenantId,
      id,
      async (client) => {
        if (client instanceof Odoo) {
          ensure(
            q.resource === 'products' && q.page === 1,
            422,
            'Odoo: podgląd katalogu używa cursora liczbowego; zamówienia i faktury wymagają osobnej integracji',
          );
          ensure(
            q.cursor === undefined || /^[1-9]\d{0,9}$/.test(q.cursor),
            422,
            'Nieprawidłowy cursor Odoo',
          );
          return client.catalogPage(q.cursor ? Number(q.cursor) : 0);
        }
        if (client instanceof Shopify) {
          ensure(
            q.page === 1 && q.resource !== 'invoices',
            422,
            'Shopify używa cursora, podgląd faktur niedostępny',
          );
          return q.resource === 'orders' ? client.orders(q.cursor) : client.products(q.cursor);
        }
        if (client instanceof PrestaShop) {
          ensure(
            q.resource !== 'invoices',
            422,
            'Podgląd faktur nie jest dostępny dla tego kanału',
          );
          return q.resource === 'orders' ? client.orders(q.page) : client.products(q.page);
        }
        if (client instanceof WooCommerce)
          return q.resource === 'orders' ? client.orders(q.page) : client.products(q.page);
        if (client instanceof Allegro)
          return q.resource === 'orders'
            ? client.orders((q.page - 1) * 50)
            : client.offers((q.page - 1) * 50);
        if (client instanceof Fakturownia) return { data: await client.invoices(q.page) };
        throw new Problem(422, 'Ta integracja nie oferuje tego podglądu');
      },
      withAllegroRequestContext(context, req, sessionName),
    );
  });
  app.get('/api/inpost/points', async (req) => {
    const { city, page } = z
      .object({
        city: z.string().trim().min(2).max(100),
        page: z.coerce.number().int().min(1).max(100).default(1),
      })
      .parse(req.query);
    const result = await new InPost('live', {}, integrationTransport).points(city, page);
    return {
      data: result.items.map((p: any) => ({
        name: p.name,
        type: p.type,
        address: p.address,
        status: p.status,
        location: p.location,
      })),
      page: result.page,
      count: result.count,
    };
  });
  registerPortalRoutes(app, { readOnly, printLayout });
  // 242: PayU payment sessions of the portal (COM-PORTAL-6); routes refuse on a copy older than 242.
  registerPayu242Routes(app, { readOnly });
  // 252 (L4 Mirakl): OR11 schedule, offer/fulfilment writes and webhooks. Writes run only in the local simulation
  // (DYNA_MIRAKL_FAKE=local); a real instance gets reads through the selected connector and control database only.
  configureMirakl262Runtime(mirakl262Simulation() && !readOnly
    ? { transport: mirakl262SimulationTransport, readRepository: createMirakl262SimulatedReadRepository(), writes: true, simulation: true }
    : { transport: miraklReadRepository ? ordinaryConnectorTransport : undefined, readRepository: miraklReadRepository, writes: false, simulation: false });
  registerMirakl262Routes(app, { readOnly });
  const crmAvailable = (await pool.query("SELECT bool_and(to_regclass('public.'||name) IS NOT NULL) present FROM unnest(ARRAY['crm_clients','crm_statuses','crm_status_groups','crm_extra_fields','crm_values','crm_files','crm_order_links','crm_commands']) name")).rows[0]?.present === true;
  // 228: reads of the customer card and of Base CRM clients are written to the access register.
  const rodo228Logs = rodo228IsAvailable && !readOnly;
  registerCrmRoutes(app, { available: crmAvailable, readOnly, ...(rodo228Logs ? { access: rodo228CrmAccess(pool, localConfig.encryptionKey) } : {}) });
  observeBaseWireReads(rodo228Logs ? rodo228WireObserver(pool, localConfig.encryptionKey, () => rodo228Available(pool)) : null);
  const baseWireCrmAvailable = crmAvailable && (await pool.query("SELECT bool_and(to_regclass('public.'||name) IS NOT NULL) AND to_regprocedure('public.base_wire218_authority(uuid,uuid,boolean)') IS NOT NULL AS present FROM unnest(ARRAY['base_wire218_client_ids','base_wire218_status_ids','base_wire218_field_ids','base_wire218_key_scopes']) name")).rows[0]?.present === true;
  const baseWireDictionaryAvailable = baseWireCrmAvailable && (await pool.query("SELECT to_regclass('public.base_wire219_group_ids') IS NOT NULL AS present")).rows[0]?.present === true;
  const baseWireInventoryAvailable = productCatalogsIsAvailable && (await pool.query("SELECT bool_and(to_regclass('public.'||name) IS NOT NULL) AS present FROM unnest(ARRAY['base_wire220_warehouse_ids','base_wire220_catalog_ids','base_wire220_product_ids']) name")).rows[0]?.present === true;
  const baseWireCategoriesAvailable = baseWireInventoryAvailable && await baseWireCategories224Available(pool);
  const productDeletionsAvailable = baseWireInventoryAvailable && await productDeletions225Available(pool);
  const baseWireOrdersAvailable = baseWireInventoryAvailable && (await pool.query("SELECT bool_and(to_regclass('public.'||name) IS NOT NULL) AND to_regprocedure('public.base_wire220_allocate_pending(text)') IS NOT NULL AS present FROM unnest(ARRAY['base_wire220_order_ids','base_wire220_order_status_ids']) name")).rows[0]?.present === true;
  const baseWireFulfillmentAvailable = baseWireOrdersAvailable && (await pool.query("SELECT to_regclass('public.base_wire220_package_ids') IS NOT NULL AS present")).rows[0]?.present === true;
  const baseWireInvoicesAvailable = baseWireOrdersAvailable && localInvoicesIsAvailable && (await pool.query("SELECT bool_and(to_regclass('public.'||name) IS NOT NULL) AS present FROM unnest(ARRAY['base_wire220_invoice_ids','base_wire220_invoice_series_ids']) name")).rows[0]?.present === true;
  const baseWireJournalAvailable = baseWireOrdersAvailable && (await pool.query("SELECT to_regclass('public.base_wire221_journal_ids') IS NOT NULL AND to_regprocedure('public.base_wire221_allocate_journal()') IS NOT NULL AS present")).rows[0]?.present === true;
  registerBaseWireRoutes(app, { readOnly, requestLifetime: ordinaryRequestLifetime,
    authenticate: async (token, scope, ip) => {
      const key = await authenticateBaseWireApiKey(token, scope, workspaceMfaPolicyAvailable);
      if (authSecurity237Available) await touchApiKey(key, ip);
      return key;
    },
    families: [createBaseWireCrmFamily({ service: createDefaultBaseWireCrmDispatch({ crm218Verified: baseWireCrmAvailable, dictionary219Verified: baseWireDictionaryAvailable, readOnly }),
      available: baseWireCrmAvailable, dictionaryAvailable: baseWireDictionaryAvailable }),
      createBaseWireInventoryFamily({ service: createDefaultBaseWireInventoryService({ readOnly, categories: baseWireCategoriesAvailable, deletions: productDeletionsAvailable }), available: baseWireInventoryAvailable }),
      createBaseWireOrdersFamily({ service: createDefaultBaseWireOrdersService({ readOnly, mergeClaims: orderMergeClaimsAvailable, orderMerges: orderMergesIsAvailable, orderSplits: orderSplit222IsAvailable, sessionName }), available: baseWireOrdersAvailable }),
      createBaseWireFulfillmentFamily({ service: createDefaultBaseWireFulfillmentService({ demoLabel: demoShipmentLabelInTx, mergeClaims: orderMergeClaimsAvailable }), available: baseWireFulfillmentAvailable, pickListsAvailable: pickingWavesAvailable }),
      createBaseWireInvoicesFamily({ service: createDefaultBaseWireInvoicesService({ readOnly }), available: baseWireInvoicesAvailable }),
      createBaseWireJournalFamily({ service: createDefaultBaseWireJournalService({ readOnly }), available: baseWireJournalAvailable }),
      createBaseWireReturnsFamily({ service: createDefaultBaseWireReturnsService({ readOnly, reasons: returnReasons223IsAvailable }), available: baseWireOrdersAvailable }),
      createBaseWireWmsFamily({ service: createDefaultBaseWireWmsService(), available: baseWireInventoryAvailable })] });
  registerCustomerMessageRoutes(app, {
    available: customerMessagesAvailable,
    workflowAvailable: customerMessageWorkflowsAvailable,
    readOnly,
  });
  registerCustomerMessageWorkflowRoutes(app, {
    available: customerMessageWorkflowsAvailable,
    readOnly,
  });
  // Same authenticated child/parser handles normal and public v1. Global auth is already installed.
  await largeImports.register(app);
  await registerBusinessQuotaRecoveryRoutes(app,{readOnly,port:largeImportRecovery});
  bindPublicRoutes();
  const dist = staticRoot === undefined ? resolve('dist') : staticRoot;
  if (staticRoot !== undefined && resolve(staticRoot) !== staticRoot)
    throw new Error('Application static root must be an absolute normalized path');
  if (staticRoot !== undefined && !existsSync(resolve(staticRoot, 'index.html')))
    throw new Error('Application static index missing');
  if (existsSync(dist)) {
    await app.register(staticPlugin, { root: dist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api'))
        return reply.code(404).send({ status: 404, detail: 'Nie znaleziono endpointu' });
      return reply.sendFile('index.html');
    });
  }
  return app;
  } catch (first) {
    try { await app.close(); } catch { /* Construction cause remains authoritative. */ }
    throw first;
  }
}
