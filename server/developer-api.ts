import { orderStatusInput } from './order-status-input';
import {stagedImportQuery,stageOrdersInput,publicImportCommitInput} from './import-routes';
import {registeredLargeImportPublicOperations as largeImportPublicOperations,applyRegisteredLargeImportOpenApiContract as applyLargeImportOpenApiContract,LARGE_IMPORT_SAME_PARSER_ALIAS} from './large-import/registered-public-contract';
import {pimRouteDescriptors} from './pim-dictionaries/routes';
import {pimPreviewInput,pimLegacyStageInput} from './pim-dictionaries/service';
import {pimApplyInput,applyPimOpenApiContract} from './pim-dictionaries/openapi';
import {manualOffPreviewInput,manualOffApplyInput} from './manual-inventory-off';
import { inventoryAdjustInput, inventoryCorrectionPreviewInput } from './inventory-correction-schema';
import * as physicalParcelWzSchemas from './physical-parcel-wz';
import {applyB2bCreditOpenApiContract} from './b2b-credit-openapi';
import { buyerAddressAccessInput } from './buyer-address';
import * as b2bCreditSchemas from './b2b-credits';
import * as b2bInvoiceSchemas from './b2b-invoices';
import * as fa3DraftSchemas from './fa3-drafts';
import * as localInvoiceSchemas from './local-invoice-values';
import * as consumerCreditSchemas from './local-consumer-credit-values';
import * as b2bIntentSchemas from './b2b-external-order-intents-schema';
import * as b2bImportSchemas from './b2b-external-order-imports-schema';
import * as b2bDropshipSchemas from './b2b-network-dropshipping-schema';
import * as b2bReturnSchemas from './b2b-dropshipping-returns-schema';
import * as returnAssistantSchemas from './return-assistant-schema';
import * as returnDestinationsSchemas from './return-destinations-schema';
import * as stocktakeAdjustmentSchemas from './stocktake-adjustments-schema';
import * as warehouseDocumentRegisterSchemas from './warehouse-document-register-schema';
import * as warehouseAutomaticWzSchemas from './warehouse-automatic-wz-schema';
import * as catalogStockControlSchemas from './catalog-stock-control-schema';
import { catalogStockCountQuery, catalogStockCountRowsQuery, catalogStockCountValueRowsQuery,
  catalogStockCountExportQuery } from './catalog-stock-count-query';
import * as returnDestinationStatusSchemas from './return-destination-statuses-schema';
import * as warehouseInventoryPolicySchemas from './warehouse-inventory-policies-schema';
import * as returnAssistantQueueSchemas from './return-assistant-queues-schema';
import * as inboundEmailSchemas from './email-inbound-schema';
import { productCatalogPreviewInput, productCatalogCommitInput, productCatalogListQuery, productCatalogHistoryQuery } from './product-catalogs-schema';
import * as b2bCatalogScopeSchemas from './b2b-catalog-scope-schema';
import { b2bReturnLocalOriginInput } from './b2b-return-local-origins';
import {
  salesReportQuery,
  salesReportPageQuery,
  salesReportFileQuery,
  SALES_REPORT_LIMITS,
} from './sales-reports';
import * as orderMergeSchemas from './order-merges-schema';
import * as orderSplit222Schemas from './order-split222-schema';
import * as languageFileImportSchemas from './language-file-import-schema';
import * as supplierFileSchemas from './supplier-file-source-schema';
import * as supplierRemoteSchemas from './supplier-remote-schema';
import * as paymentAllocationSchemas from './payment-import-allocation-values';
import * as proformaSchemas from './proforma-values';
import * as proformaBatchSchemas from './proforma-batch-values';
import * as printJobSchemas from './print-job-values';
import * as shipmentLabelPrintSchemas from './shipment-label-print-values';
import * as shipmentLabelCacheSchemas from './shipment-label-cache-values';
import * as shipmentLabelBatchSchemas from './shipment-label-batch-values';
import * as orderParcelSchemas from './order-parcels-values';
import * as orderParcelReleaseSchemas from './order-parcel-release-stock';
import {
  catalogBulkEditPreviewInput,
  catalogBulkEditExecuteInput,
} from './catalog-bulk-edit-routes';
import * as replenishmentAutomationSchemas from './replenishment-automations-schema';
import {
  catalogExportFileInput,
  catalogExportFileQuery,
  catalogExportOptionsQuery,
  CATALOG_EXPORT_COLUMNS,
  CATALOG_EXPORT_LIMITS,
} from './catalog-export';
import {
  catalogExportProfileCreateInput,
  catalogExportProfilePatchInput,
  catalogExportProfileVersionInput,
} from './catalog-export-profile-routes';
import {
  CATALOG_FILE_IMPORT_LIMITS,
  catalogFileImportPreviewInput,
  catalogFileImportExecuteInput,
  catalogFileImportRowsQuery,
  catalogFileImportHistoryQuery,
} from './catalog-file-import-schema';
import * as wmsLotSchemas from './wms-lots-schema';
import * as wmsStocktakeSchemas from './wms-stocktakes-schema';
import * as stocktakeScanSchemas from './stocktake-scans-schema';
import * as replenishmentSchemas from './replenishment-plans-schema';
import { shopifyFulfillmentInput } from './shopify-fulfillment';
import {
  customerMessageWorkflowRuleInput,
  customerMessageWorkflowRulePatch,
  customerMessageWorkflowPreview,
} from './customer-message-workflow-routes';
import { customerMessageAssignment } from './customer-message-workflow-schema';
import {
  orderFieldMappingProfileSchema,
  orderFieldMappingProfilePatchSchema,
  orderFieldMappingPreviewSchema,
  orderFieldMappingImportSchema,
  orderFieldMappingQueueSchema,
  orderFieldMappingCancelSchema,
} from './order-field-mappings-schema';
import {
  orderFieldBatchPreviewSchema,
  orderFieldBatchQueueSchema,
  orderFieldBatchCancelSchema,
} from './order-field-batches-schema';
import {
  orderFieldDefinitionSchema,
  orderFieldDefinitionPatchSchema,
  orderFieldDisableSchema,
  orderFieldPatchSchema,
  orderFieldFileSchema,
} from './order-fields-schema';
import { emailTemplate, emailPreview, emailConfirmation } from './email';
import { amazonFulfillmentInput } from './amazon-fulfillment';
import { waveSelection, waveCreateInput, waveScanInput, waveVersion } from './picking-waves';
import * as packingSchema from './packing-workstation-schema';
import { shippingInput } from './shipping';
import { dpdInput } from './dpd-shipping';
import { imagePreviewInput, imageApplyInput } from './odoo-image-imports';
import {
  repricingScheduleInput,
  repricingScheduleRunInput,
  repricingRunCancelInput,
} from './repricing-schedules';
import { stocktakeInput, stocktakeVersion, stocktakePost, stocktakeCount } from './stocktakes';
import { offerInput } from './offers';
import {
  allegroBatchInput,
  allegroBatchActionInput,
  allegroBatchApproveInput,
} from './allegro-batches';
import { smsTemplate, smsPreview } from './sms';
import { bulkInput } from './supplier-bulk';
import { bulkCancelInput } from './supplier-bulk-routes';
import { supplierScheduleInput, supplierScheduleRunInput } from './supplier-schedules';
import {
  supplierSourceInput,
  supplierReadInput,
  supplierPurchaseInput,
  supplierStateInput,
  supplierLinkInput,
  supplierProductInput,
} from './supplier-catalog';
import { scheduleCreate, scheduleEdit, scheduleQueue } from './automation-schedule-schema';
import { locationMove, locationCount, locationScan } from './stock-locations';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import { z } from 'zod';
import { pool } from './db';
import { ensure } from './errors';
import { tokenHash } from './security';
import { audit, orderSchema, productSchema } from './domain';
import { editSchema } from './catalog';
import { warehouseSchema, versionSchema } from './warehouse';
import {
  inventoryBulkEditPreviewInput,
  inventoryBulkEditExecuteInput,
} from './inventory-bulk-edit-schema';
import { priceBulkEditPreviewInput, priceBulkEditExecuteInput } from './price-bulk-edit-schema';
import * as priceFileImportSchemas from './price-file-import-schema';
import * as priceMatrixImportSchemas from './price-matrix-import-schema';
import * as stockFileImportSchemas from './stock-file-import-schema';
import {
  productTranslationBulkEditPreviewInput,
  productTranslationBulkEditExecuteInput,
} from './product-translation-bulk-edit-schema';
import { orderAction } from './operation-schema';
import { customEventRaiseInput } from './custom-events';
import { authTx, lockAdmin } from './workspace-routes';
import { returnInput, receiveInput, decisionInput, refundInput } from './returns';
import { returnReasonCreateInput, returnReasonUpdateInput } from './return-reasons223';
import { returnExchangePreviewInput, returnExchangeInput } from './return-exchanges-schema';
import { paymentInput, reversalInput } from './payments';
import { sourceApplyInput } from './source-payment-routes';
import { priceListInput, priceListEdit, priceItemsInput, quoteInput } from './pricing';
import {
  repricingRuleInput,
  repricingInputsInput,
  repricingPreviewInput,
  repricingApplyInput,
} from './repricing';
import { competitorProfileInput, competitorBatchInput } from './competitor-observations-schema';
import {
  supplierInput,
  purchaseInput,
  purchaseVersion,
  purchaseFinish,
  purchaseReceive,
} from './purchasing';

export const apiScopes = [
  'crm:read',
  'crm:write',
  'integrations:read',
  'integrations:write',
  'communications:read',
  'communications:write',
  'automations:read',
  'automations:write',
  'orders:read',
  'orders:write',
  'returns:configure',
  'order-fields:read',
  'order-fields:write',
  'order-fields:admin',
  'products:read',
  'products:write',
  'inventory:read',
  'inventory:write',
  'documents:read',
  'documents:write',
  'purchasing:read',
  'purchasing:write',
] as const;
export type ApiScope = (typeof apiScopes)[number];
const scope = z.enum(apiScopes);
/** CRM scopes are stored in base_wire218_key_scopes; api_keys.scopes keeps its pinned CHECK. */
const crmScopes = ['crm:read', 'crm:write'] as const;
type CrmScope = (typeof crmScopes)[number];
const isCrmScope = (value: string): value is CrmScope => (crmScopes as readonly string[]).includes(value);
export const developerKeyCreateInput = z.object({
  name: z.string().trim().min(2).max(100),
  scopes: z.array(scope).min(1).max(apiScopes.length)
    .transform((values) => [...new Set(values)])
    .refine((values) => !values.includes('crm:write') || values.includes('crm:read'),
      'Zapis CRM wymaga również zakresu odczytu CRM')
    .refine((values) => values.some((value) => !isCrmScope(value)),
      'Klucz API wymaga co najmniej jednego zakresu poza CRM'),
  expires_days: z.number().int().min(1).max(90).default(30),
});
// Both routes currently share the accepted parser. Only opening a file requires
// a reviewed catalogue version/hash; that runtime condition is documented below.
const catalogExportPreviewInput = catalogExportFileInput;
const op = (method: string, path: string, scope: string, input?: z.ZodType) => ({
  method,
  path,
  scope,
  input,
});
export const publicOperations = [
  ...largeImportPublicOperations,
  ...pimRouteDescriptors.map(d=>op(d.method,d.path,d.method==='POST'?'products:write':'products:read',d.method==='POST'?(d.path.endsWith('/apply')?pimApplyInput:d.path.endsWith('/legacy-file-stage')?pimLegacyStageInput:pimPreviewInput):undefined)),
  op('GET', '/orders/:id/buyer-address-access', 'orders:read'),
  op('PATCH', '/orders/:id/buyer-address-access', 'orders:write', buyerAddressAccessInput),
  op('GET', '/orders/:id/buyer-address-history', 'orders:read'),
  op('GET', '/integrations/recovery-queue', 'orders:read'),
  op('GET', '/integrations/recovery-queue/identity', 'orders:read'),
  op('GET', '/integrations/:id/verification-history', 'integrations:read'),
  op('GET', '/integrations/:id/imports', 'integrations:read'),
  op('GET', '/imports/:id', 'integrations:read'),
  op('POST', '/integrations/:id/stage-orders', 'integrations:write', stageOrdersInput),
  op('POST', '/imports/:id/commit', 'orders:write', publicImportCommitInput),
  ...[
    '/options',
    '/settings/:account_id',
    '/returns/:id/context',
    '/returns/:id/sources',
    '/previews/:id',
    '/previews/:id/rows',
    '/cases',
    '/cases/:id',
    '/cases/:id/rows',
    '/cases/:id/events',
  ].map((suffix) => op('GET', '/b2b/dropshipping-returns' + suffix, 'orders:read')),
  op(
    'PATCH',
    '/b2b/dropshipping-returns/settings/:account_id',
    'purchasing:write',
    b2bReturnSchemas.b2bDropshipReturnSettingsInput,
  ),
  op(
    'POST',
    '/b2b/dropshipping-returns/returns/:id/previews',
    'orders:write',
    b2bReturnSchemas.b2bDropshipReturnPreviewInput,
  ),
  op(
    'POST',
    '/b2b/dropshipping-returns/previews/:id/submit',
    'orders:write',
    b2bReturnSchemas.b2bDropshipReturnSubmitInput,
  ),
  op(
    'POST',
    '/b2b/dropshipping-returns/cases/:id/withdraw',
    'orders:write',
    b2bReturnSchemas.b2bDropshipReturnWithdrawInput,
  ),
  op(
    'POST',
    '/b2b/dropshipping-returns/cases/:id/receive',
    'inventory:write',
    b2bReturnSchemas.b2bDropshipReturnReceiveInput,
  ),
  op(
    'POST',
    '/b2b/dropshipping-returns/cases/:id/decision',
    'orders:write',
    b2bReturnSchemas.b2bDropshipReturnDecisionInput,
  ),
  op(
    'POST',
    '/b2b/dropshipping-returns/returns/:id/reconcile',
    'orders:write',
    b2bReturnSchemas.b2bDropshipReturnReconcileInput,
  ),
  op(
    'POST',
    '/b2b/dropshipping-returns/returns/:id/local-origin',
    'orders:write',
    b2bReturnLocalOriginInput,
  ),
  op('GET', '/imports/:id/external-intent-source', 'integrations:read'),
  op(
    'POST',
    '/imports/:id/external-intent-previews',
    'integrations:write',
    b2bImportSchemas.b2bExternalImportPreviewInput,
  ),
  op('GET', '/import-external-intent-previews', 'integrations:read'),
  op('GET', '/import-external-intent-previews/:id', 'integrations:read'),
  op(
    'POST',
    '/import-external-intent-previews/:id/execute',
    'integrations:write',
    b2bImportSchemas.b2bExternalImportExecuteInput,
  ),
  ...['/options', '/orders', '/orders/:id'].map((suffix) =>
    op('GET', '/b2b/external-order-intents' + suffix, 'orders:read'),
  ),
  op(
    'POST',
    '/b2b/external-order-intents/orders',
    'orders:write',
    b2bIntentSchemas.b2bExternalOrderIntentCreateInput,
  ),
  op(
    'POST',
    '/b2b/external-order-intents/orders/:id/allocate',
    'orders:write',
    b2bIntentSchemas.b2bExternalOrderIntentAllocateInput,
  ),
  ...['cancel', 'reopen'].map((action) =>
    op(
      'POST',
      '/b2b/external-order-intents/orders/:id/' + action,
      'orders:write',
      b2bIntentSchemas.b2bExternalOrderIntentActionInput,
    ),
  ),
  ...[
    '/options',
    '/sources',
    '/sources/:id',
    '/quotes',
    '/quotes/:id',
    '/orders',
    '/orders/:id',
  ].map((suffix) =>
    op('GET', '/b2b/network/links/:link_id/dropshipping' + suffix, 'purchasing:read'),
  ),
  op(
    'POST',
    '/b2b/network/links/:link_id/dropshipping/quotes',
    'purchasing:write',
    b2bDropshipSchemas.b2bDropshipQuoteInput,
  ),
  op(
    'POST',
    '/b2b/network/links/:link_id/dropshipping/quotes/:id/checkout',
    'purchasing:write',
    b2bDropshipSchemas.b2bDropshipCheckoutInput,
  ),
  op(
    'POST',
    '/b2b/network/links/:link_id/dropshipping/orders/:id/cancel',
    'purchasing:write',
    b2bDropshipSchemas.b2bDropshipCancelInput,
  ),
  op(
    'POST',
    '/b2b/network/links/:link_id/dropshipping/orders/:id/reconcile',
    'purchasing:write',
    b2bDropshipSchemas.b2bDropshipReconcileInput,
  ),
  ...[
    '/reports/sales/options',
    '/reports/sales/summary',
    '/reports/sales/orders',
    '/reports/sales/orders/:id',
    '/reports/sales/returns',
    '/reports/sales/file',
  ].map((path) => op('GET', path, 'orders:read')),
  ...['/b2b-corrections/options','/b2b-corrections/documents/:id/source','/b2b-corrections/previews/:id','/b2b-corrections/documents','/b2b-corrections/documents/:id','/b2b-corrections/documents/:id/print'].map(path=>op('GET',path,'documents:read')),
  op('POST','/b2b-corrections/previews','documents:write',b2bCreditSchemas.b2bCreditPreviewInput),
  op('POST','/b2b-corrections/previews/:id/issue','documents:write',b2bCreditSchemas.b2bCreditIssueInput),
  ...['/b2b-invoices/options','/b2b-invoices/previews/:id','/b2b-invoices/documents','/b2b-invoices/documents/:id','/b2b-invoices/documents/:id/print','/b2b-invoices/documents/:id/fa3.xml'].map(path=>op('GET',path,'documents:read')),
  op('POST','/b2b-invoices/projects/:id/previews','documents:write',b2bInvoiceSchemas.b2bInvoicePreviewInput),
  op('POST','/b2b-invoices/previews/:id/issue','documents:write',b2bInvoiceSchemas.b2bInvoiceIssueInput),
  ...['/b2b-fa3/options','/b2b-fa3/orders/:id/source','/b2b-fa3/previews/:id','/b2b-fa3/projects','/b2b-fa3/projects/:id'].map(path=>op('GET',path,'documents:read')),
  op('POST','/b2b-fa3/orders/:id/previews','documents:write',fa3DraftSchemas.fa3DraftPreviewInput),
  op('POST','/b2b-fa3/previews/:id/approve','documents:write',fa3DraftSchemas.fa3DraftApproveInput),
  ...['/local-invoices/options','/local-invoices/series','/local-invoices/previews/:id','/local-invoices/documents','/local-invoices/documents/:id','/local-invoices/documents/:id/print'].map(path=>op('GET',path,'documents:read')),
  op('POST','/local-invoices/series','documents:write',localInvoiceSchemas.localInvoiceSeriesInput),
  op('POST','/local-invoices/orders/:id/previews','documents:write',localInvoiceSchemas.localInvoicePreviewInput),
  op('POST','/local-invoices/previews/:id/issue','documents:write',localInvoiceSchemas.localInvoiceIssueInput),
  ...['/local-consumer-credits/options','/local-consumer-credits/orders/:id/source','/local-consumer-credits/previews/:id','/local-consumer-credits/commands/:id','/local-consumer-credits/documents','/local-consumer-credits/documents/:id','/local-consumer-credits/documents/:id/print'].map(path=>op('GET',path,'documents:read')),
  op('POST','/local-consumer-credits/previews','documents:write',consumerCreditSchemas.localConsumerCreditPreviewInput),
  op('POST','/local-consumer-credits/previews/:id/issue','documents:write',consumerCreditSchemas.localConsumerCreditIssueInput),
  ...[
    '/proformas/options',
    '/proformas/series',
    '/proformas/previews/:id',
    '/proformas/documents/:id',
  ].map((path) => op('GET', path, 'documents:read')),
  op('POST', '/proformas/series', 'documents:write', proformaSchemas.proformaSeriesInput),
  ...[
    '/proformas/batches/previews/:id',
    '/proformas/batches/executions/:id',
    '/proformas/batches/history',
  ].map((path) => op('GET', path, 'documents:read')),
  op(
    'POST',
    '/proformas/batches/previews',
    'documents:write',
    proformaBatchSchemas.proformaBatchPreviewInput,
  ),
  op(
    'POST',
    '/proformas/batches/previews/:id/issue',
    'documents:write',
    proformaBatchSchemas.proformaBatchIssueInput,
  ),
  op(
    'POST',
    '/proformas/orders/:id/previews',
    'documents:write',
    proformaSchemas.proformaPreviewInput,
  ),
  op(
    'POST',
    '/proformas/previews/:id/issue',
    'documents:write',
    proformaSchemas.proformaIssueInput,
  ),
  ...[
    '/payment-import-allocations/options',
    '/payment-import-allocations/previews/:id',
    '/payment-import-allocations/executions/:id',
    '/payment-import-allocations/history',
  ].map((path) => op('GET', path, 'orders:read')),
  op(
    'POST',
    '/payment-import-allocations/previews',
    'orders:write',
    paymentAllocationSchemas.allocationPreviewInput,
  ),
  op(
    'POST',
    '/payment-import-allocations/previews/:id/execute',
    'orders:write',
    paymentAllocationSchemas.allocationExecuteInput,
  ),
  ...['/wms-lots/stocktakes', '/stocktakes'].flatMap((prefix) => [
    op('GET', `${prefix}/:id/scan-metadata`, 'inventory:read'),
    op('GET', `${prefix}/:id/scan-candidates`, 'inventory:read'),
    op('GET', `${prefix}/:id/scans`, 'inventory:read'),
    op('GET', `${prefix}/:id/scans/:scan_id`, 'inventory:read'),
    op(
      'POST',
      `${prefix}/:id/scan-start`,
      'inventory:write',
      stocktakeScanSchemas.stocktakeScanStartInput,
    ),
    op(
      'POST',
      `${prefix}/:id/scans`,
      'inventory:write',
      stocktakeScanSchemas.stocktakeScanIncrementInput,
    ),
  ]),
  op('GET', '/wms-lots/stocktakes/metadata', 'inventory:read'),
  op('GET', '/wms-lots/stocktakes', 'inventory:read'),
  op(
    'POST',
    '/wms-lots/stocktakes',
    'inventory:write',
    wmsStocktakeSchemas.wmsStocktakeCreateInput,
  ),
  op('GET', '/wms-lots/stocktakes/:id', 'inventory:read'),
  op('GET', '/wms-lots/stocktakes/:id/lines', 'inventory:read'),
  op('GET', '/wms-lots/stocktakes/:id/measurements', 'inventory:read'),
  op(
    'POST',
    '/wms-lots/stocktakes/:id/counts',
    'inventory:write',
    wmsStocktakeSchemas.wmsStocktakeCountInput,
  ),
  op('GET', '/wms-lots/stocktakes/:id/reviews', 'inventory:read'),
  op(
    'POST',
    '/wms-lots/stocktakes/:id/reviews',
    'purchasing:write',
    wmsStocktakeSchemas.wmsStocktakeReviewInput,
  ),
  op('GET', '/wms-lots/stocktakes/:id/reviews/:review_id', 'inventory:read'),
  op('GET', '/wms-lots/stocktakes/:id/reviews/:review_id/rows', 'inventory:read'),
  op(
    'POST',
    '/wms-lots/stocktakes/:id/post',
    'purchasing:write',
    wmsStocktakeSchemas.wmsStocktakePostInput,
  ),
  op(
    'POST',
    '/wms-lots/stocktakes/:id/reopen',
    'inventory:write',
    wmsStocktakeSchemas.wmsStocktakeCommandInput,
  ),
  op(
    'POST',
    '/wms-lots/stocktakes/:id/cancel',
    'inventory:write',
    wmsStocktakeSchemas.wmsStocktakeCommandInput,
  ),
  op('GET', '/wms-lots/stocktakes/:id/posting', 'inventory:read'),
  op('GET', '/wms-lots', 'inventory:read'),
  op('GET', '/wms-lots/opening-scope', 'inventory:read'),
  op('POST', '/wms-lots/opening-previews', 'inventory:write', wmsLotSchemas.wmsOpeningInput),
  op('GET', '/wms-lots/opening-previews/:id', 'inventory:read'),
  op('GET', '/wms-lots/opening-previews/:id/rows', 'inventory:read'),
  op(
    'POST',
    '/wms-lots/opening-previews/:id/activate',
    'inventory:write',
    wmsLotSchemas.wmsActivateInput,
  ),
  op('POST', '/wms-lots/receipts', 'inventory:write', wmsLotSchemas.wmsReceiveInput),
  op('POST', '/wms-lots/movement-previews', 'inventory:write', wmsLotSchemas.wmsMovementInput),
  op('GET', '/wms-lots/movement-previews/:id', 'inventory:read'),
  op('GET', '/wms-lots/movement-previews/:id/rows', 'inventory:read'),
  op(
    'POST',
    '/wms-lots/movement-previews/:id/execute',
    'inventory:write',
    wmsLotSchemas.wmsExecuteInput,
  ),
  op('GET', '/wms-lots/positions', 'inventory:read'),
  op('GET', '/wms-lots/lots/:id/trace', 'inventory:read'),
  op('GET', '/wms-lots/valuation', 'purchasing:read'),
  op('GET', '/wms-lots/operations', 'inventory:read'),
  op('GET', '/wms-lots/operations/:id', 'inventory:read'),
  op('GET', '/wms-lots/orders/:id/allocations', 'orders:read'),
  op('GET', '/wms-lots/orders/:id/return-fragments', 'orders:read'),
  op('GET', '/packing', 'orders:read'),
  ...['/options', '/printers', '/jobs', '/jobs/:id'].map(path => op('GET', '/print-jobs' + path, 'orders:read')),
  op('GET', '/print-jobs/jobs/:id/content', 'orders:write'),
  op('POST', '/print-jobs/printers', 'orders:write', printJobSchemas.printPrinterCreateInput),
  op('PATCH', '/print-jobs/printers/:id', 'orders:write', printJobSchemas.printPrinterUpdateInput),
  op('POST', '/print-jobs/jobs', 'orders:write', printJobSchemas.printJobCreateInput),
  op('POST', '/print-jobs/jobs/:id/claim', 'orders:write', printJobSchemas.printJobClaimInput),
  op('POST', '/print-jobs/jobs/:id/ack', 'orders:write', printJobSchemas.printJobAckInput),
  op('POST', '/print-jobs/jobs/:id/reconcile', 'orders:write', printJobSchemas.printJobReconcileInput),
  op('GET', '/print-jobs/shipment-labels/options', 'orders:read'),
  op('POST', '/print-jobs/shipments/:id/label-previews', 'orders:write', shipmentLabelPrintSchemas.shipmentLabelPrintPreviewInput),
  op('GET', '/print-jobs/label-previews/:id', 'orders:read'),
  op('GET', '/print-jobs/label-previews/:id/content', 'orders:write'),
  op('GET', '/print-jobs/label-previews/:id/pdf', 'orders:write'),
  op('POST', '/print-jobs/label-previews/:id/queue', 'orders:write', shipmentLabelPrintSchemas.shipmentLabelPrintQueueInput),
  op('GET', '/print-jobs/shipments/:id/label-cache', 'orders:read'),
  op('POST', '/print-jobs/shipments/:id/label-cache', 'orders:write', shipmentLabelCacheSchemas.shipmentLabelCacheAcquireInput),
  op('GET', '/print-jobs/shipments/:id/label-cache/history', 'orders:read'),
  op('GET', '/print-jobs/label-cache/:id', 'orders:read'),
  op('GET', '/print-jobs/label-cache/:id/content', 'orders:write'),
  op('GET', '/print-jobs/label-cache/:id/pdf', 'orders:write'),
  op('POST', '/print-jobs/label-cache/acquisitions/:id/reconcile', 'orders:write', shipmentLabelCacheSchemas.shipmentLabelCacheReconcileInput),
  op('GET', '/print-jobs/label-batches/options', 'orders:read'),
  op('POST', '/print-jobs/label-batches/previews', 'orders:write', shipmentLabelBatchSchemas.shipmentLabelBatchPreviewInput),
  op('GET', '/print-jobs/label-batches/previews/:id', 'orders:read'),
  op('GET', '/print-jobs/label-batches/previews/:id/content', 'orders:write'),
  op('GET', '/print-jobs/label-batches/previews/:id/pdf', 'orders:write'),
  op('POST', '/print-jobs/label-batches/previews/:id/queue', 'orders:write', shipmentLabelBatchSchemas.shipmentLabelBatchQueueInput),
  op('GET', '/print-jobs/label-batches/executions/:id', 'orders:read'),
  op('GET', '/print-jobs/label-batches/history', 'orders:read'),
  op('GET', '/order-parcels/plans/:id/physical-wz/source', 'orders:read'),
  op('POST', '/order-parcels/plans/:id/physical-wz/previews', 'orders:write', physicalParcelWzSchemas.physicalWzPreviewInput),
  op('GET', '/order-parcels/physical-wz/previews/:id', 'orders:read'),
  op('POST', '/order-parcels/physical-wz/previews/:id/apply', 'orders:write', physicalParcelWzSchemas.physicalWzApplyInput),
  op('GET', '/order-parcels/physical-wz/mappings/:id', 'orders:read'),
  op('GET', '/order-parcels/orders/:id/source', 'orders:read'),
  op('POST', '/order-parcels/orders/:id/previews', 'orders:write', orderParcelSchemas.orderParcelPreviewInput),
  op('GET', '/order-parcels/previews/:id', 'orders:read'),
  op('POST', '/order-parcels/previews/:id/apply', 'orders:write', orderParcelSchemas.orderParcelApplyInput),
  op('GET', '/order-parcels/plans/:id', 'orders:read'),
  op('POST', '/order-parcels/plans/:id/parcels/:index/dispatch', 'orders:write', orderParcelSchemas.orderParcelDispatchInput),
  op('GET', '/order-parcels/orders/:id/history', 'orders:read'),
  op('GET', '/order-parcel-releases/plans/:id/source', 'orders:read'),
  op('POST', '/order-parcel-releases/plans/:id/previews', 'orders:write', orderParcelReleaseSchemas.orderParcelReleasePreviewInput),
  op('GET', '/order-parcel-releases/previews/:id', 'orders:read'),
  op('POST', '/order-parcel-releases/previews/:id/release', 'orders:write', orderParcelReleaseSchemas.orderParcelReleaseInput),
  op('GET', '/order-parcel-releases/releases/:id', 'orders:read'),
  op('GET', '/packing/stations', 'orders:read'),
  op('POST', '/packing/stations', 'orders:write', packingSchema.packingStationCreateInput),
  op('PATCH', '/packing/stations/:id', 'orders:write', packingSchema.packingStationPatchInput),
  op('GET', '/packing/cartons', 'orders:read'),
  op('POST', '/packing/cartons', 'orders:write', packingSchema.packingCartonCreateInput),
  op('PATCH', '/packing/cartons/:id', 'orders:write', packingSchema.packingCartonPatchInput),
  op('PATCH', '/packing/policy', 'orders:write', packingSchema.packingPolicyInput),
  op('GET', '/packing/candidates', 'orders:read'),
  op('POST', '/packing/sessions', 'orders:write', packingSchema.packingSessionCreateInput),
  op('GET', '/packing/sessions/:id', 'orders:read'),
  op('GET', '/packing/sessions/:id/items', 'orders:read'),
  op('GET', '/packing/sessions/:id/allocations', 'orders:read'),
  op('POST', '/packing/sessions/:id/renew', 'orders:write', packingSchema.packingLeaseRenewInput),
  op('POST', '/packing/sessions/:id/takeover', 'orders:write', packingSchema.packingTakeoverInput),
  op('POST', '/packing/sessions/:id/cancel', 'orders:write', packingSchema.packingCancelInput),
  op('POST', '/packing/sessions/:id/scans', 'orders:write', packingSchema.packingScanInput),
  op('GET', '/packing/operations/:id', 'orders:read'),
  op('POST', '/packing/previews', 'orders:write', packingSchema.packingPreviewInput),
  op('GET', '/packing/previews/:id', 'orders:read'),
  op('GET', '/packing/previews/:id/items', 'orders:read'),
  op('GET', '/packing/previews/:id/allocations', 'orders:read'),
  op('POST', '/packing/previews/:id/finish', 'orders:write', packingSchema.packingFinishInput),
  op('GET', '/packing/receipts', 'orders:read'),
  op('GET', '/packing/receipts/:id', 'orders:read'),
  op('GET', '/packing/receipts/:id/items', 'orders:read'),
  op('GET', '/packing/receipts/:id/allocations', 'orders:read'),
  op('GET', '/packing/orders/:id/profile', 'orders:read'),
  op('POST', '/orders/:id/shipping/preview', 'orders:write', shippingInput),
  op(
    'POST',
    '/shipping-plans/:id/queue',
    'orders:write',
    z.object({ confirm_live: z.boolean().default(false) }),
  ),
  op('POST', '/orders/:id/dpd-shipping/preview', 'orders:write', dpdInput),
  op(
    'POST',
    '/dpd-shipping/:id/queue',
    'orders:write',
    z.object({
      confirm_external: z.boolean().default(false),
      ack_contract_rate: z.boolean().default(false),
    }),
  ),
  op('GET', '/customer-messages', 'communications:read'),
  op('GET', '/customer-messages/assignees', 'communications:read'),
  op('GET', '/customer-messages/:id', 'communications:read'),
  op(
    'PATCH',
    '/customer-messages/:id/assignment',
    'communications:write',
    customerMessageAssignment,
  ),
  op('GET', '/customer-message-workflows', 'automations:read'),
  op('GET', '/customer-message-workflows/rules', 'automations:read'),
  op(
    'POST',
    '/customer-message-workflows/rules',
    'automations:write',
    customerMessageWorkflowRuleInput,
  ),
  op(
    'PATCH',
    '/customer-message-workflows/rules/:id',
    'automations:write',
    customerMessageWorkflowRulePatch,
  ),
  op(
    'POST',
    '/customer-message-workflows/rules/:id/preview',
    'automations:write',
    customerMessageWorkflowPreview,
  ),
  op('GET', '/customer-message-workflows/runs', 'automations:read'),
  op('GET', '/customer-message-workflows/runs/:id', 'automations:read'),
  op('GET', '/order-field-mappings/metadata', 'order-fields:read'),
  op('GET', '/order-field-mappings/profiles', 'order-fields:read'),
  op(
    'POST',
    '/order-field-mappings/profiles',
    'order-fields:admin',
    orderFieldMappingProfileSchema,
  ),
  op('GET', '/order-field-mappings/profiles/:id', 'order-fields:read'),
  op(
    'PATCH',
    '/order-field-mappings/profiles/:id',
    'order-fields:admin',
    orderFieldMappingProfilePatchSchema,
  ),
  op('GET', '/order-field-mappings/profiles/:id/revisions', 'order-fields:read'),
  op('GET', '/order-field-mappings/sources', 'order-fields:read'),
  op('GET', '/order-field-mappings/sources/:id', 'order-fields:read'),
  op('GET', '/order-field-mappings/previews', 'order-fields:read'),
  op(
    'POST',
    '/order-field-mappings/previews',
    'order-fields:write',
    orderFieldMappingPreviewSchema,
  ),
  op('GET', '/order-field-mappings/previews/:id', 'order-fields:read'),
  op(
    'POST',
    '/order-field-mappings/previews/:id/import',
    'order-fields:write',
    orderFieldMappingImportSchema,
  ),
  op(
    'POST',
    '/order-field-mappings/previews/:id/queue',
    'order-fields:write',
    orderFieldMappingQueueSchema,
  ),
  op('GET', '/order-field-mappings/executions', 'order-fields:read'),
  op('GET', '/order-field-mappings/executions/:id', 'order-fields:read'),
  op(
    'POST',
    '/order-field-mappings/executions/:id/cancel',
    'order-fields:write',
    orderFieldMappingCancelSchema,
  ),
  op('GET', '/order-field-batches', 'order-fields:read'),
  op('GET', '/order-field-batches/previews', 'order-fields:read'),
  op('POST', '/order-field-batches/previews', 'order-fields:write', orderFieldBatchPreviewSchema),
  op('GET', '/order-field-batches/previews/:id', 'order-fields:read'),
  op(
    'POST',
    '/order-field-batches/previews/:id/queue',
    'order-fields:write',
    orderFieldBatchQueueSchema,
  ),
  op('GET', '/order-field-batches/executions', 'order-fields:read'),
  op('GET', '/order-field-batches/executions/:id', 'order-fields:read'),
  op(
    'POST',
    '/order-field-batches/executions/:id/cancel',
    'order-fields:write',
    orderFieldBatchCancelSchema,
  ),
  op('GET', '/order-field-batches/export', 'order-fields:read'),
  op('GET', '/order-fields', 'order-fields:read'),
  op('POST', '/order-fields', 'order-fields:admin', orderFieldDefinitionSchema),
  op('PATCH', '/order-fields/:id', 'order-fields:admin', orderFieldDefinitionPatchSchema),
  op('DELETE', '/order-fields/:id', 'order-fields:admin', orderFieldDisableSchema),
  op('GET', '/orders/:id/fields', 'order-fields:read'),
  op('PATCH', '/orders/:id/fields', 'order-fields:write', orderFieldPatchSchema),
  op('GET', '/orders/:id/fields/history', 'order-fields:read'),
  op('POST', '/order-field-files', 'order-fields:write', orderFieldFileSchema),
  op('GET', '/order-field-files/:id/download', 'order-fields:read'),
  op('GET', '/orders/:id/amazon-fulfillment', 'orders:read'),
  op('POST', '/orders/:id/amazon-fulfillment/preview', 'orders:write', amazonFulfillmentInput),
  op(
    'POST',
    '/amazon-fulfillment-plans/:id/queue',
    'orders:write',
    z.object({ confirm_external: z.boolean().default(false) }).strict(),
  ),
  op('POST', '/amazon-fulfillment-plans/:id/cancel', 'orders:write'),
  op(
    'POST',
    '/amazon-fulfillment-plans/:id/reconcile',
    'orders:write',
    z.object({ acknowledge_mismatch: z.boolean().default(false) }).strict(),
  ),
  op('GET', '/orders/:id/shopify-fulfillment', 'orders:read'),
  op('GET', '/orders/:id/shopify-fulfillment/sources', 'orders:read'),
  op('GET', '/shopify-fulfillment-plans/:id', 'orders:read'),
  op('POST', '/orders/:id/shopify-fulfillment/preview', 'orders:write', shopifyFulfillmentInput),
  op(
    'POST',
    '/shopify-fulfillment-plans/:id/queue',
    'orders:write',
    z.object({ confirm_external: z.boolean().default(false) }).strict(),
  ),
  op('POST', '/shopify-fulfillment-plans/:id/cancel', 'orders:write'),
  op(
    'POST',
    '/shopify-fulfillment-plans/:id/reconcile',
    'orders:write',
    z.object({ acknowledge_mismatch: z.boolean().default(false) }).strict(),
  ),
  op('GET', '/picking-waves', 'orders:read'),
  op('GET', '/picking-waves/candidates', 'orders:read'),
  op('POST', '/picking-waves/preview', 'orders:write', waveSelection),
  op('POST', '/picking-waves', 'orders:write', waveCreateInput),
  op('GET', '/picking-waves/:id', 'orders:read'),
  op('GET', '/picking-waves/:id/scan-result', 'orders:read'),
  op('POST', '/picking-waves/:id/scans', 'orders:write', waveScanInput),
  op('POST', '/picking-waves/:id/complete', 'orders:write', waveVersion),
  op('POST', '/picking-waves/:id/cancel', 'orders:write', waveVersion),
  op('GET', '/integrations/:id/allegro-batches', 'products:read'),
  op('POST', '/integrations/:id/allegro-batches', 'products:write', allegroBatchInput),
  op('GET', '/allegro-batches/:id', 'products:read'),
  op('POST', '/allegro-batches/:id/queue', 'products:write', allegroBatchApproveInput),
  op('POST', '/allegro-batches/:id/cancel', 'products:write', allegroBatchActionInput),
  op('POST', '/allegro-batches/:id/retry', 'products:write', allegroBatchActionInput),
  op('POST', '/allegro-batches/:id/recheck', 'products:write', allegroBatchActionInput),
  op('GET', '/integrations/:id/offers', 'products:read'),
  op('GET', '/integrations/:id/offer-listings', 'products:read'),
  op('POST', '/integrations/:id/offers/preview', 'products:write', offerInput),
  op(
    'POST',
    '/offer-plans/:id/queue',
    'products:write',
    z.object({ confirm_live: z.boolean().default(false) }),
  ),
  op(
    'POST',
    '/offer-plans/:id/reconcile',
    'products:write',
    z.object({ accept_observed: z.boolean().default(false) }),
  ),
  op('GET', '/integrations/:id/allegro/catalog', 'products:read'),
  op('GET', '/integrations/:id/allegro/offer-parameters', 'products:read'),
  op('GET', '/integrations/:id/allegro/creation-options', 'products:read'),
  op('GET', '/stocktakes', 'inventory:read'),
  op('GET', '/price-bulk-edit', 'products:read'),
  op('GET', '/product-translation-bulk-edit', 'products:read'),
  op('GET', '/product-translation-bulk-edit/selection', 'products:read'),
  op(
    'POST',
    '/product-translation-bulk-edit/previews',
    'products:write',
    productTranslationBulkEditPreviewInput,
  ),
  op('GET', '/product-translation-bulk-edit/previews/:id', 'products:read'),
  op('GET', '/product-translation-bulk-edit/previews/:id/rows', 'products:read'),
  op(
    'POST',
    '/product-translation-bulk-edit/previews/:id/execute',
    'products:write',
    productTranslationBulkEditExecuteInput,
  ),
  op('GET', '/product-translation-bulk-edit/executions', 'products:read'),
  op('GET', '/product-translation-bulk-edit/executions/:id', 'products:read'),
  op('GET', '/product-translation-bulk-edit/executions/:id/rows', 'products:read'),
  op('GET', '/price-bulk-edit/selection', 'products:read'),
  op('POST', '/price-bulk-edit/previews', 'products:write', priceBulkEditPreviewInput),
  op('GET', '/price-bulk-edit/previews/:id', 'products:read'),
  op('GET', '/price-bulk-edit/previews/:id/rows', 'products:read'),
  op('POST', '/price-bulk-edit/previews/:id/execute', 'products:write', priceBulkEditExecuteInput),
  op('GET', '/price-bulk-edit/executions', 'products:read'),
  op('GET', '/price-bulk-edit/executions/:id', 'products:read'),
  op('GET', '/price-bulk-edit/executions/:id/rows', 'products:read'),
  op('GET', '/price-file-imports/options', 'products:read'),
  op('GET', '/price-file-imports/profiles', 'products:read'),
  op(
    'POST',
    '/price-file-imports/profiles',
    'products:write',
    priceFileImportSchemas.priceFileImportProfileInput,
  ),
  op('GET', '/price-file-imports/profiles/:id', 'products:read'),
  op(
    'PATCH',
    '/price-file-imports/profiles/:id',
    'products:write',
    priceFileImportSchemas.priceFileImportProfileUpdateInput,
  ),
  op(
    'POST',
    '/price-file-imports/previews',
    'products:write',
    priceFileImportSchemas.priceFileImportPreviewInput,
  ),
  op('GET', '/price-file-imports/previews', 'products:read'),
  op('GET', '/price-file-imports/previews/:id', 'products:read'),
  op('GET', '/price-file-imports/previews/:id/rows', 'products:read'),
  op(
    'POST',
    '/price-file-imports/previews/:id/execute',
    'products:write',
    priceFileImportSchemas.priceFileImportExecuteInput,
  ),
  op('GET', '/price-file-imports/executions', 'products:read'),
  op('GET', '/price-file-imports/executions/:id', 'products:read'),
  op('GET', '/price-file-imports/executions/:id/rows', 'products:read'),
  op('GET', '/price-matrix-imports/options', 'products:read'),
  op('GET', '/price-matrix-imports/profiles', 'products:read'),
  op(
    'POST',
    '/price-matrix-imports/profiles',
    'products:write',
    priceMatrixImportSchemas.priceMatrixImportProfileInput,
  ),
  op('GET', '/price-matrix-imports/profiles/:id', 'products:read'),
  op(
    'PATCH',
    '/price-matrix-imports/profiles/:id',
    'products:write',
    priceMatrixImportSchemas.priceMatrixImportProfileUpdateInput,
  ),
  op(
    'POST',
    '/price-matrix-imports/previews',
    'products:write',
    priceMatrixImportSchemas.priceMatrixImportPreviewInput,
  ),
  op('GET', '/price-matrix-imports/previews', 'products:read'),
  op('GET', '/price-matrix-imports/previews/:id', 'products:read'),
  op('GET', '/price-matrix-imports/previews/:id/rows', 'products:read'),
  op(
    'POST',
    '/price-matrix-imports/previews/:id/execute',
    'products:write',
    priceMatrixImportSchemas.priceMatrixImportExecuteInput,
  ),
  op('GET', '/price-matrix-imports/executions', 'products:read'),
  op('GET', '/price-matrix-imports/executions/:id', 'products:read'),
  op('GET', '/price-matrix-imports/executions/:id/rows', 'products:read'),
  op('GET', '/language-file-imports/options', 'products:read'),
  op('GET', '/language-file-imports/profiles', 'products:read'),
  op(
    'POST',
    '/language-file-imports/profiles',
    'products:write',
    languageFileImportSchemas.languageFileImportProfileInput,
  ),
  op('GET', '/language-file-imports/profiles/:id', 'products:read'),
  op(
    'PATCH',
    '/language-file-imports/profiles/:id',
    'products:write',
    languageFileImportSchemas.languageFileImportProfileUpdateInput,
  ),
  op(
    'POST',
    '/language-file-imports/previews',
    'products:write',
    languageFileImportSchemas.languageFileImportPreviewInput,
  ),
  op('GET', '/language-file-imports/previews', 'products:read'),
  op('GET', '/language-file-imports/previews/:id', 'products:read'),
  op('GET', '/language-file-imports/previews/:id/rows', 'products:read'),
  op(
    'POST',
    '/language-file-imports/previews/:id/execute',
    'products:write',
    languageFileImportSchemas.languageFileImportExecuteInput,
  ),
  op('GET', '/language-file-imports/executions', 'products:read'),
  op('GET', '/language-file-imports/executions/:id', 'products:read'),
  op('GET', '/language-file-imports/executions/:id/rows', 'products:read'),
  op('GET', '/stock-file-imports/options', 'inventory:read'),
  op('GET', '/stock-file-imports/profiles', 'inventory:read'),
  op(
    'POST',
    '/stock-file-imports/profiles',
    'inventory:write',
    stockFileImportSchemas.stockFileImportProfileInput,
  ),
  op('GET', '/stock-file-imports/profiles/:id', 'inventory:read'),
  op(
    'PATCH',
    '/stock-file-imports/profiles/:id',
    'inventory:write',
    stockFileImportSchemas.stockFileImportProfileUpdateInput,
  ),
  op(
    'POST',
    '/stock-file-imports/previews',
    'inventory:write',
    stockFileImportSchemas.stockFileImportPreviewInput,
  ),
  op('GET', '/stock-file-imports/previews', 'inventory:read'),
  op('GET', '/stock-file-imports/previews/:id', 'inventory:read'),
  op('GET', '/stock-file-imports/previews/:id/rows', 'inventory:read'),
  op(
    'POST',
    '/stock-file-imports/previews/:id/execute',
    'inventory:write',
    stockFileImportSchemas.stockFileImportExecuteInput,
  ),
  op('GET', '/stock-file-imports/executions', 'inventory:read'),
  op('GET', '/stock-file-imports/executions/:id', 'inventory:read'),
  op('GET', '/stock-file-imports/executions/:id/rows', 'inventory:read'),
  op('GET', '/inventory-bulk-edit', 'inventory:read'),
  op('GET', '/inventory-bulk-edit/selection', 'inventory:read'),
  op('POST', '/inventory-bulk-edit/previews', 'inventory:write', inventoryBulkEditPreviewInput),
  op('GET', '/inventory-bulk-edit/previews/:id', 'inventory:read'),
  op('GET', '/inventory-bulk-edit/previews/:id/rows', 'inventory:read'),
  op(
    'POST',
    '/inventory-bulk-edit/previews/:id/execute',
    'inventory:write',
    inventoryBulkEditExecuteInput,
  ),
  op('GET', '/inventory-bulk-edit/executions', 'inventory:read'),
  op('GET', '/inventory-bulk-edit/executions/:id', 'inventory:read'),
  op('GET', '/inventory-bulk-edit/executions/:id/rows', 'inventory:read'),
  op('POST', '/stocktakes', 'inventory:write', stocktakeInput),
  op('GET', '/stocktakes/:id', 'inventory:read'),
  op('GET', '/stocktakes/:id/measurements', 'inventory:read'),
  op('POST', '/stocktakes/:id/counts', 'inventory:write', stocktakeCount),
  ...(['review', 'reopen', 'cancel'] as const).map((a) =>
    op('POST', '/stocktakes/:id/' + a, 'inventory:write', stocktakeVersion),
  ),
  op('POST', '/stocktakes/:id/post', 'inventory:write', stocktakePost),
  op('POST', '/orders/:id/operations/preview', 'orders:write', orderAction),
  // AUTO-07: own events (migration 244). Raising needs the caller's client_key; the same key = the same call.
  op('GET', '/custom-events', 'orders:read'),
  op('POST', '/custom-events/:key/raise', 'orders:write', customEventRaiseInput),
  op('GET', '/custom-events/:id/calls', 'orders:read'),
  op('GET', '/email/templates', 'communications:read'),
  op('GET', '/email-inbound/options', 'communications:read'),
  op('GET', '/email-inbound/accounts', 'communications:read'),
  op('POST', '/email-inbound/accounts', 'integrations:write', inboundEmailSchemas.inboundAccountCreateInput),
  op('PATCH', '/email-inbound/accounts/:id', 'integrations:write', inboundEmailSchemas.inboundAccountUpdateInput),
  op('POST', '/email-inbound/accounts/:id/previews', 'communications:write', inboundEmailSchemas.inboundFetchInput),
  op('GET', '/email-inbound/previews', 'communications:read'),
  op('GET', '/email-inbound/previews/:id', 'communications:read'),
  op('POST', '/email-inbound/previews/:id/import', 'communications:write', inboundEmailSchemas.inboundImportInput),
  op('GET', '/email-inbound/imports/:id', 'communications:read'),
  op('GET', '/email-inbound/acquisitions', 'communications:read'),
  op('GET', '/email-inbound/acquisitions/:id', 'communications:read'),
  op('POST', '/email-inbound/acquisitions/:id/reconcile', 'communications:write', inboundEmailSchemas.inboundReconcileInput),
  op('GET', '/email-inbound/messages', 'communications:read'),
  op('GET', '/email-inbound/messages/:id', 'communications:read'),
  op('GET', '/email-inbound/messages/:id/attachments/:index/content', 'communications:read'),
  op('POST', '/email-inbound/messages/:id/bind', 'communications:write', inboundEmailSchemas.inboundBindInput),
  op('POST', '/email-inbound/messages/:id/reply-previews', 'communications:write', inboundEmailSchemas.inboundReplyPreviewInput),
  op('GET', '/email-inbound/reply-previews/:id', 'communications:read'),
  op('POST', '/email-inbound/reply-previews/:id/queue', 'communications:write', inboundEmailSchemas.inboundReplyQueueInput),
  op('GET', '/email-inbound/replies', 'communications:read'),
  op('GET', '/email-inbound/replies/:id', 'communications:read'),
  op(
    'POST',
    '/email/templates',
    'communications:write',
    emailTemplate.extend({ client_key: z.uuid() }),
  ),
  op(
    'PATCH',
    '/email/templates/:id',
    'communications:write',
    emailTemplate.extend({ version: z.string().regex(/^\d+$/) }),
  ),
  op('POST', '/email/preview', 'communications:write', emailPreview),
  op('GET', '/email/batches/:id', 'communications:read'),
  op('POST', '/email/batches/:id/queue', 'communications:write', emailConfirmation),
  op(
    'POST',
    '/email/batches/:id/cancel',
    'communications:write',
    z.object({ confirmed: z.literal(true) }).strict(),
  ),
  op('GET', '/email/messages', 'communications:read'),
  op('GET', '/email/messages/:id/attachment', 'communications:read'),
  op('GET', '/sms/templates', 'communications:read'),
  op(
    'POST',
    '/sms/templates',
    'communications:write',
    smsTemplate.extend({ client_key: z.uuid() }),
  ),
  op(
    'PATCH',
    '/sms/templates/:id',
    'communications:write',
    smsTemplate.extend({ version: z.string().regex(/^\d+$/) }),
  ),
  op('POST', '/sms/preview', 'communications:write', smsPreview),
  op('GET', '/sms/batches/:id', 'communications:read'),
  op(
    'POST',
    '/sms/batches/:id/queue',
    'communications:write',
    z.object({ confirmed: z.literal(true) }).strict(),
  ),
  op(
    'POST',
    '/sms/batches/:id/cancel',
    'communications:write',
    z.object({ confirmed: z.literal(true) }).strict(),
  ),
  op('GET', '/sms/messages', 'communications:read'),
  op('GET', '/automation-schedules', 'automations:read'),
  op('POST', '/automation-schedules', 'automations:write', scheduleCreate),
  op(
    'PATCH',
    '/automation-schedules/:id',
    'automations:write',
    z.union([
      scheduleEdit,
      z.object({ version: z.string().regex(/^\d+$/), enabled: z.boolean() }).strict(),
    ]),
  ),
  op('POST', '/automation-schedules/:id/preview', 'automations:write', z.object({}).strict()),
  op('POST', '/automation-schedules/:id/run', 'automations:write', scheduleQueue),
  op('GET', '/automation-schedules/:id/runs', 'automations:read'),
  op('GET', '/automation-schedule-runs/:id', 'automations:read'),
  op('GET', '/stock-locations', 'inventory:read'),
  op('GET', '/stock-location-movements', 'inventory:read'),
  op('POST', '/stock-location-moves', 'inventory:write', locationMove),
  op('POST', '/stock-location-counts', 'inventory:write', locationCount),
  op('GET', '/suppliers', 'purchasing:read'),
  op('GET', '/supplier-sources', 'purchasing:read'),
  op('GET', '/supplier-sources/:id', 'purchasing:read'),
  op('GET', '/supplier-file-sources/options', 'purchasing:read'),
  op('POST', '/supplier-file-sources', 'purchasing:write', supplierFileSchemas.sourceCreateInput),
  op('GET', '/supplier-file-sources/:id', 'purchasing:read'),
  op(
    'PATCH',
    '/supplier-file-sources/:id',
    'purchasing:write',
    supplierFileSchemas.configUpdateInput,
  ),
  op(
    'POST',
    '/supplier-file-sources/:id/previews',
    'purchasing:write',
    supplierFileSchemas.previewInput,
  ),
  op('GET', '/supplier-file-previews/:id', 'purchasing:read'),
  op(
    'POST',
    '/supplier-file-previews/:id/apply',
    'purchasing:write',
    supplierFileSchemas.applyInput,
  ),
  op('GET', '/supplier-file-sources/:id/history', 'purchasing:read'),
  op('GET', '/supplier-file-sources/:id/remote', 'purchasing:read'),
  op(
    'PATCH',
    '/supplier-file-sources/:id/remote',
    'purchasing:write',
    supplierRemoteSchemas.supplierRemoteUpdateInput,
  ),
  op(
    'POST',
    '/supplier-file-sources/:id/fetches',
    'purchasing:write',
    supplierRemoteSchemas.supplierRemoteFetchInput,
  ),
  op('GET', '/supplier-file-sources/:id/fetches', 'purchasing:read'),
  op('GET', '/supplier-file-fetches/:id', 'purchasing:read'),
  op('GET', '/supplier-file-sources/:id/feed-schedule', 'purchasing:read'),
  op(
    'PATCH',
    '/supplier-file-sources/:id/feed-schedule',
    'purchasing:write',
    supplierRemoteSchemas.supplierFeedScheduleInput,
  ),
  op('POST', '/supplier-sources', 'purchasing:write', supplierSourceInput),
  op('PATCH', '/supplier-sources/:id/state', 'purchasing:write', supplierStateInput),
  op('POST', '/supplier-sources/:id/reads', 'purchasing:write', supplierReadInput),
  op('GET', '/supplier-reads', 'purchasing:read'),
  op('GET', '/supplier-catalog', 'purchasing:read'),
  op('PATCH', '/supplier-catalog/:id/link', 'purchasing:write', supplierLinkInput),
  op('POST', '/supplier-catalog/:id/product', 'purchasing:write', supplierProductInput),
  op('POST', '/supplier-sources/:id/purchase', 'purchasing:write', supplierPurchaseInput),
  op('POST', '/supplier-sources/:id/bulk-runs', 'purchasing:write', bulkInput),
  op('GET', '/supplier-bulk-runs', 'purchasing:read'),
  op('GET', '/supplier-bulk-runs/:id', 'purchasing:read'),
  op('POST', '/supplier-bulk-runs/:id/cancel', 'purchasing:write', bulkCancelInput),
  op('GET', '/supplier-sources/:id/schedule', 'purchasing:read'),
  op('PUT', '/supplier-sources/:id/schedule', 'purchasing:write', supplierScheduleInput),
  op('POST', '/supplier-sources/:id/schedule/run', 'purchasing:write', supplierScheduleRunInput),
  op('POST', '/suppliers', 'purchasing:write', supplierInput),
  op('PATCH', '/suppliers/:id', 'purchasing:write', supplierInput.extend(purchaseVersion.shape)),
  op('GET', '/purchase-orders', 'purchasing:read'),
  op('GET', '/purchase-orders/:id', 'purchasing:read'),
  op('POST', '/purchase-orders', 'purchasing:write', purchaseInput),
  op(
    'PATCH',
    '/purchase-orders/:id',
    'purchasing:write',
    purchaseInput.extend(purchaseVersion.shape),
  ),
  op('POST', '/purchase-orders/:id/place', 'purchasing:write', purchaseVersion),
  op('POST', '/purchase-orders/:id/close', 'purchasing:write', purchaseFinish),
  op('POST', '/purchase-orders/:id/cancel', 'purchasing:write', purchaseFinish),
  op('POST', '/purchase-orders/:id/receive', 'purchasing:write', purchaseReceive),
  op('GET', '/price-lists', 'products:read'),
  op('POST', '/price-lists', 'products:write', priceListInput),
  op('PATCH', '/price-lists/:id', 'products:write', priceListEdit),
  op('GET', '/price-lists/:id/items', 'products:read'),
  op('PUT', '/price-lists/:id/items', 'products:write', priceItemsInput),
  op('POST', '/pricing/quote', 'products:read', quoteInput),
  op('GET', '/price-lists/:id/repricing/schedule', 'products:read'),
  op('PUT', '/price-lists/:id/repricing/schedule', 'products:write', repricingScheduleInput),
  op(
    'POST',
    '/price-lists/:id/repricing/schedule/run',
    'products:write',
    repricingScheduleRunInput,
  ),
  op('GET', '/price-lists/:id/repricing/runs', 'products:read'),
  op('GET', '/repricing-runs/:id', 'products:read'),
  op('POST', '/repricing-runs/:id/cancel', 'products:write', repricingRunCancelInput),
  op('GET', '/price-lists/:id/repricing', 'products:read'),
  op('PUT', '/price-lists/:id/repricing', 'products:write', repricingRuleInput),
  op('GET', '/price-lists/:id/repricing/inputs', 'products:read'),
  op('PUT', '/price-lists/:id/repricing/inputs', 'products:write', repricingInputsInput),
  op('POST', '/price-lists/:id/repricing/previews', 'products:write', repricingPreviewInput),
  op('GET', '/price-lists/:id/repricing/previews', 'products:read'),
  op('GET', '/repricing-previews/:id', 'products:read'),
  op('POST', '/repricing-previews/:id/apply', 'products:write', repricingApplyInput),
  op('GET', '/price-lists/:id/competitor-observations/options', 'products:read'),
  op('GET', '/price-lists/:id/competitor-observations/profile', 'products:read'),
  op('PUT', '/price-lists/:id/competitor-observations/profile', 'products:write', competitorProfileInput),
  op('GET', '/price-lists/:id/competitor-observations/observations', 'products:read'),
  op('GET', '/price-lists/:id/competitor-observations/batches', 'products:read'),
  op('GET', '/price-lists/:id/competitor-observations/batches/:batch_id', 'products:read'),
  op('POST', '/price-lists/:id/competitor-observations/batches', 'products:write', competitorBatchInput),
  op('GET', '/orders', 'orders:read'),
  op('GET', '/orders/:id', 'orders:read'),
  op('GET', '/orders/:id/product-logistics', 'orders:read'),
  op('GET', '/orders/:id/payments', 'orders:read'),
  op('POST', '/orders/:id/payments', 'orders:write', paymentInput),
  op('POST', '/orders/:id/payments/reverse', 'orders:write', reversalInput),
  op('GET', '/orders/:id/source-payments', 'orders:read'),
  op('POST', '/orders/:id/source-payments/read', 'orders:write', z.object({}).strict()),
  op('POST', '/source-payment-checks/:id/apply', 'orders:write', sourceApplyInput),
  op('GET', '/returns', 'orders:read'),
  ...['/options', '/sources/:source_kind/:id', '/previews/:id', '/previews/:id/rows',
    '/receipts/:id', '/documents', '/documents/:id', '/documents/:id/rows',
    '/register', '/documents/:id/export']
    .map(path => op('GET', '/stocktake-adjustments' + path, 'inventory:read')),
  op('POST', '/stocktake-adjustments/series', 'inventory:write', stocktakeAdjustmentSchemas.adjustmentSeriesInput),
  op('POST', '/stocktake-adjustments/previews', 'inventory:write', stocktakeAdjustmentSchemas.adjustmentPreviewInput),
  op('POST', '/stocktake-adjustments/previews/:id/post', 'inventory:write', stocktakeAdjustmentSchemas.adjustmentPostInput),
  ...['', '/:origin/:id', '/:origin/:id/export']
    .map(path => op('GET', '/warehouse-document-register' + path, 'inventory:read')),
  ...['/options', '/previews/:id', '/operations/:id', '/history']
    .map(path => op('GET', '/warehouse-automatic-wz' + path, 'inventory:read')),
  op('POST', '/warehouse-automatic-wz/warehouses/:id/previews', 'inventory:write', warehouseAutomaticWzSchemas.automaticWzPreviewInput),
  op('POST', '/warehouse-automatic-wz/previews/:id/commit', 'inventory:write', warehouseAutomaticWzSchemas.automaticWzCommitInput),
  ...['/options', '/documents', '/documents/:id', '/documents/:id/export']
    .map(path => op('GET', '/warehouse-wz-issued' + path, 'inventory:read')),
  ...['/catalogs/:id/source', '/previews/:id', '/previews/:id/rows', '/operations/:id',
    '/documents/:id', '/documents/:id/rows', '/documents/:id/export', '/history']
    .map(path => op('GET', '/catalog-stock-control' + path, 'inventory:read')),
  op('POST', '/catalog-stock-control/catalogs/:id/previews', 'inventory:write', catalogStockControlSchemas.catalogStockControlPreviewInput),
  op('POST', '/catalog-stock-control/previews/:id/commit', 'inventory:write', catalogStockControlSchemas.catalogStockControlCommitInput),
  op('GET', '/catalog-stock-control/count-documents', 'inventory:read'),
  op('GET', '/catalog-stock-control/count-documents/:id', 'inventory:read'),
  op('GET', '/catalog-stock-control/count-documents/:id/value', 'inventory:read'),
  op('GET', '/catalog-stock-control/count-documents/:id/export', 'inventory:read'),
  ...['/options', '/returns/:id/source', '/returns/:id/history', '/previews/:id', '/operations/:id']
    .map(path => op('GET', '/return-destinations' + path, 'orders:read')),
  op('POST', '/return-destinations/returns/:id/previews', 'orders:write', returnDestinationsSchemas.returnDestinationsPreviewInput),
  op('POST', '/return-destinations/previews/:id/receive', 'orders:write', returnDestinationsSchemas.returnDestinationsReceiveInput),
  op('GET', '/return-assistant/options', 'orders:read'),
  ...['', '/options', '/:id', '/:id/history', '/previews/:id', '/operations/:id']
    .map(path => op('GET', '/return-assistant/statuses' + path, 'orders:read')),
  op('POST', '/return-assistant/statuses/previews', 'returns:configure', returnDestinationStatusSchemas.returnDestinationStatusPreviewInput),
  op('POST', '/return-assistant/statuses/previews/:id/commit', 'returns:configure', returnDestinationStatusSchemas.returnDestinationStatusCommitInput),
  ...['/options', '/previews/:id', '/operations/:id', '/history']
    .map(path => op('GET', '/warehouse-inventory-policies' + path, 'inventory:read')),
  op('POST', '/warehouse-inventory-policies/warehouses/:id/previews', 'inventory:write', warehouseInventoryPolicySchemas.warehouseInventoryPolicyPreviewInput),
  op('POST', '/warehouse-inventory-policies/previews/:id/commit', 'inventory:write', warehouseInventoryPolicySchemas.warehouseInventoryPolicyCommitInput),
  op('GET', '/return-assistant/settings', 'orders:read'),
  op('PATCH', '/return-assistant/settings', 'orders:write', returnAssistantQueueSchemas.settingsInput),
  op('POST', '/return-assistant/queues', 'orders:write', returnAssistantQueueSchemas.createQueueInput),
  op('GET', '/return-assistant/queues', 'orders:read'),
  op('GET', '/return-assistant/queues/:id', 'orders:read'),
  op('PATCH', '/return-assistant/queues/:id', 'orders:write', returnAssistantQueueSchemas.updateQueueInput),
  op('GET', '/return-assistant/queues/:id/items', 'orders:read'),
  op('POST', '/return-assistant/sessions', 'orders:write', returnAssistantSchemas.returnAssistantStartInput),
  op('GET', '/return-assistant/sessions/:id', 'orders:read'),
  op('POST', '/return-assistant/sessions/:id/scans', 'orders:write', returnAssistantSchemas.returnAssistantScanInput),
  op('PATCH', '/return-assistant/sessions/:id/draft', 'orders:write', returnAssistantSchemas.returnAssistantDraftInput),
  op('POST', '/return-assistant/sessions/:id/photos', 'orders:write', returnAssistantSchemas.returnAssistantPhotoInput),
  op('GET', '/return-assistant/photos/:id/content', 'orders:read'),
  op('POST', '/return-assistant/sessions/:id/renew', 'orders:write', returnAssistantSchemas.returnAssistantLeaseInput),
  op('POST', '/return-assistant/sessions/:id/takeover', 'orders:write', returnAssistantSchemas.returnAssistantLeaseInput),
  op('POST', '/return-assistant/sessions/:id/cancel', 'orders:write', returnAssistantSchemas.returnAssistantLeaseInput),
  op('POST', '/return-assistant/sessions/:id/previews', 'orders:write', returnAssistantSchemas.returnAssistantPreviewInput),
  op('GET', '/return-assistant/previews/:id', 'orders:read'),
  op('POST', '/return-assistant/previews/:id/receive', 'orders:write', returnAssistantSchemas.returnAssistantReceiveInput),
  op('GET', '/return-assistant/receipts/:id', 'orders:read'),
  op('GET', '/return-assistant/history', 'orders:read'),
  op('GET', '/orders/:id/returns', 'orders:read'),
  op('GET', '/returns/:id', 'orders:read'),
  op('POST', '/orders/:id/returns', 'orders:write', returnInput),
  op('GET', '/return-reasons', 'orders:read'),
  op('POST', '/return-reasons', 'returns:configure', returnReasonCreateInput),
  op('PATCH', '/return-reasons/:id', 'returns:configure', returnReasonUpdateInput),
  op('POST', '/returns/:id/receive', 'orders:write', receiveInput),
  op('POST', '/returns/:id/exchange-preview', 'orders:write', returnExchangePreviewInput),
  op('POST', '/returns/:id/exchange', 'orders:write', returnExchangeInput),
  op('POST', '/returns/:id/decision', 'orders:write', decisionInput),
  op('POST', '/returns/:id/refund', 'orders:write', refundInput),
  op('POST', '/returns/:id/document', 'documents:write'),
  op('POST', '/orders', 'orders:write', orderSchema),
  op('PATCH', '/orders/:id/status', 'orders:write', orderStatusInput),
  op('POST', '/orders/:id/scan', 'orders:write', locationScan),
  op('POST', '/orders/:id/ship-demo', 'orders:write'),
  op('POST', '/orders/:id/operations', 'orders:write', orderAction),
  op(
    'POST',
    '/orders/:id/documents',
    'documents:write',
    z.object({ kind: z.enum(['invoice', 'correction']) }),
  ),
  op('GET', '/catalog-bulk-edit', 'products:read'),
  op('GET', '/catalog-bulk-edit/selection', 'products:read'),
  op('POST', '/catalog-bulk-edit/previews', 'products:write', catalogBulkEditPreviewInput),
  op('GET', '/catalog-bulk-edit/previews/:id', 'products:read'),
  op('GET', '/catalog-bulk-edit/previews/:id/rows', 'products:read'),
  op(
    'POST',
    '/catalog-bulk-edit/previews/:id/execute',
    'products:write',
    catalogBulkEditExecuteInput,
  ),
  op('GET', '/catalog-bulk-edit/executions', 'products:read'),
  op('GET', '/catalog-bulk-edit/executions/:id', 'products:read'),
  op('GET', '/catalog-bulk-edit/executions/:id/rows', 'products:read'),
  op('GET', '/catalog/exports/options', 'products:read'),
  op('GET', '/catalog/exports/file', 'products:read'),
  op('POST', '/catalog/exports/file', 'products:read', catalogExportFileInput),
  op('POST', '/catalog/exports/preview', 'products:read', catalogExportPreviewInput),
  op('GET', '/catalog/export-profiles', 'products:read'),
  op('GET', '/catalog/export-profiles/:id', 'products:read'),
  op('POST', '/catalog/export-profiles', 'products:write', catalogExportProfileCreateInput),
  op('PATCH', '/catalog/export-profiles/:id', 'products:write', catalogExportProfilePatchInput),
  op(
    'POST',
    '/catalog/export-profiles/:id/archive',
    'products:write',
    catalogExportProfileVersionInput,
  ),
  op(
    'POST',
    '/catalog/export-profiles/:id/restore',
    'products:write',
    catalogExportProfileVersionInput,
  ),
  op('GET', '/products', 'products:read'),
  op('GET', '/product-catalogs/options', 'products:read'),
  op('GET', '/product-catalogs', 'products:read'),
  op('GET', '/product-catalogs/:id', 'products:read'),
  op('GET', '/product-catalogs/previews', 'products:read'),
  op('POST', '/product-catalogs/previews', 'products:write', productCatalogPreviewInput),
  op('GET', '/product-catalogs/previews/:id', 'products:read'),
  op('POST', '/product-catalogs/previews/:id/commit', 'products:write', productCatalogCommitInput),
  op('GET', '/product-catalogs/operations/:id', 'products:read'),
  op('GET', '/b2b/accounts/:account_id/catalog-scope', 'products:read'),
  op('POST', '/b2b/accounts/:account_id/catalog-scope/previews', 'products:write', b2bCatalogScopeSchemas.b2bSupplierCatalogScopePreviewInput),
  op('GET', '/b2b/accounts/:account_id/catalog-scope/history', 'products:read'),
  op('GET', '/b2b/network/links/:link_id/catalog-scope', 'products:read'),
  op('POST', '/b2b/network/links/:link_id/catalog-scope/previews', 'products:write', b2bCatalogScopeSchemas.b2bBuyerCatalogScopePreviewInput),
  op('GET', '/b2b/network/links/:link_id/catalog-scope/history', 'products:read'),
  op('GET', '/b2b/catalog-scope/previews/:id', 'products:read'),
  op('POST', '/b2b/catalog-scope/previews/:id/commit', 'products:write', b2bCatalogScopeSchemas.b2bCatalogScopeCommitInput),
  op('GET', '/b2b/catalog-scope/operations/:id', 'products:read'),
  op('POST', '/b2b/network/links/:id/catalog/:item/bind', 'purchasing:write', b2bCatalogScopeSchemas.b2bCatalogBindInput),
  op('GET', '/products/:id', 'products:read'),
  op('POST', '/products', 'products:write', productSchema),
  op('PATCH', '/products/:id', 'products:write', editSchema),
  op('GET', '/product-images/:id', 'products:read'),
  op(
    'POST',
    '/product-images',
    'products:write',
    z.object({ data: z.string().min(1).max(699052) }),
  ),
  op(
    'POST',
    '/catalog/imports/preview',
    'products:write',
    z.object({ warehouse_id: z.uuid(), catalog_id: z.uuid().optional(), csv: z.string().min(1).max(500000) }),
  ),
  op('POST', '/catalog/imports/:id/apply', 'products:write'),
  op('GET', '/catalog/file-imports/options', 'products:read'),
  op('POST', '/catalog/file-imports/preview', 'products:write', catalogFileImportPreviewInput),
  op('GET', '/catalog/file-imports/previews/:id', 'products:read'),
  op(
    'POST',
    '/catalog/file-imports/previews/:id/execute',
    'products:write',
    catalogFileImportExecuteInput,
  ),
  op('GET', '/catalog/file-imports/executions/:id', 'products:read'),
  op('GET', '/catalog/file-imports/history', 'products:read'),
  op('GET', '/order-merges/options', 'orders:read'),
  op('POST', '/order-merges/previews', 'orders:write', orderMergeSchemas.orderMergePreviewInput),
  op('GET', '/order-merges/previews/:id', 'orders:read'),
  op('GET', '/order-merges/previews/:id/rows', 'orders:read'),
  op('GET', '/order-merges/previews/:id/sources', 'orders:read'),
  op('GET', '/order-merges/previews/:id/physical', 'orders:read'),
  op('POST', '/order-merges/execute', 'orders:write', orderMergeSchemas.orderMergeExecuteInput),
  op('GET', '/order-merges/executions/:id', 'orders:read'),
  op('GET', '/order-merges/executions/:id/rows', 'orders:read'),
  op('GET', '/order-merges/executions/:id/sources', 'orders:read'),
  op('GET', '/order-merges/executions/:id/physical', 'orders:read'),
  op('GET', '/order-merges/history', 'orders:read'),
  op('GET', '/order-merges/orders/:id/lineage', 'orders:read'),
  op('POST', '/orders/:id/splits/previews', 'orders:write', orderSplit222Schemas.orderSplit222PreviewInput),
  op('POST', '/order-splits/:id/execute', 'orders:write', orderSplit222Schemas.orderSplit222ExecuteInput),
  op('GET', '/order-splits/previews/:id', 'orders:read'),
  op('GET', '/order-splits/executions/:id', 'orders:read'),
  op('GET', '/orders/:id/splits', 'orders:read'),
  op('GET', '/replenishment/options', 'purchasing:read'),
  op('GET', '/replenishment/automations/options', 'purchasing:read'),
  op('GET', '/replenishment/automations/rules', 'purchasing:read'),
  op('GET', '/replenishment/automations/rules/:id', 'purchasing:read'),
  op(
    'POST',
    '/replenishment/automations/rules',
    'purchasing:write',
    replenishmentAutomationSchemas.replenishmentAutomationCreateInput,
  ),
  op(
    'PATCH',
    '/replenishment/automations/rules/:id',
    'purchasing:write',
    replenishmentAutomationSchemas.replenishmentAutomationPatchInput,
  ),
  op('GET', '/replenishment/automations/runs', 'purchasing:read'),
  op('GET', '/replenishment/automations/runs/:id', 'purchasing:read'),
  op(
    'POST',
    '/replenishment/automations/runs/:id/cancel',
    'purchasing:write',
    replenishmentAutomationSchemas.replenishmentAutomationCancelInput,
  ),
  op('GET', '/replenishment/selection', 'purchasing:read'),
  op('GET', '/replenishment/drafts', 'purchasing:read'),
  op('GET', '/replenishment/policies', 'purchasing:read'),
  op('GET', '/replenishment/policies/:id', 'purchasing:read'),
  op(
    'POST',
    '/replenishment/policies',
    'purchasing:write',
    replenishmentSchemas.replenishmentPolicyCreateInput,
  ),
  op(
    'PATCH',
    '/replenishment/policies/:id',
    'purchasing:write',
    replenishmentSchemas.replenishmentPolicyPatchInput,
  ),
  op(
    'POST',
    '/replenishment/previews',
    'purchasing:write',
    replenishmentSchemas.replenishmentPreviewInput,
  ),
  op('GET', '/replenishment/previews/:id', 'purchasing:read'),
  op('GET', '/replenishment/previews/:id/rows', 'purchasing:read'),
  op('GET', '/replenishment/previews/:id/rows/:row_id/contributors', 'purchasing:read'),
  op(
    'POST',
    '/replenishment/previews/:id/execute',
    'purchasing:write',
    replenishmentSchemas.replenishmentExecuteInput,
  ),
  op('GET', '/replenishment/executions', 'purchasing:read'),
  op('GET', '/replenishment/executions/:id', 'purchasing:read'),
  op('GET', '/replenishment/executions/:id/rows', 'purchasing:read'),
  op('GET', '/warehouses', 'inventory:read'),
  op('GET', '/inventory', 'inventory:read'),
  ...['/source','/previews/:id','/receipts','/receipts/:id'].map(path=>op('GET','/inventory/manual-corrections'+path,'inventory:read')),
  op('POST','/inventory/manual-corrections/previews','inventory:write',manualOffPreviewInput),
  op('POST','/inventory/manual-corrections/previews/:id/apply','inventory:write',manualOffApplyInput),
  op('GET', '/inventory/snapshot', 'inventory:read'),
  op('GET', '/inventory/movements', 'inventory:read'),
    op('POST','/inventory/adjust/previews','inventory:write',inventoryCorrectionPreviewInput),
    op('GET','/inventory/adjust/previews/:id','inventory:read'),
    op('POST','/inventory/adjust','inventory:write',inventoryAdjustInput),
  op('GET', '/warehouse-documents', 'inventory:read'),
  op('GET', '/warehouse-documents/:id', 'inventory:read'),
  op('POST', '/warehouse-documents', 'inventory:write', warehouseSchema),
  op(
    'PATCH',
    '/warehouse-documents/:id',
    'inventory:write',
    warehouseSchema.extend(versionSchema.shape),
  ),
  op('POST', '/warehouse-documents/:id/post', 'inventory:write', versionSchema),
  op('POST', '/warehouse-documents/:id/cancel', 'inventory:write', versionSchema),
  op('GET', '/products/:id/odoo-images', 'products:read'),
  op('POST', '/products/:id/odoo-images/preview', 'products:write', imagePreviewInput),
  op('POST', '/odoo-image-imports/:id/apply', 'products:write', imageApplyInput),
  op('GET', '/documents', 'documents:read'),
  op('GET', '/documents/:id/print', 'documents:read'),
  op(
    'POST',
    '/documents/:id/email-file',
    'documents:write',
    z.object({ confirmed: z.literal(true) }).strict(),
  ),
  op('GET', '/odoo-invoice-exports/:id/pdf', 'documents:read'),
  op('POST', '/odoo-invoice-exports/:id/pdf', 'documents:write', z.object({}).strict()),
  op('GET', '/shipments/:id/label', 'documents:read'),
];
function operation(req: FastifyRequest) {
  const path = req.url.split('?')[0];
  return publicOperations.find(
    (o) =>
      (o.method === req.method || (req.method === 'HEAD' && o.method === 'GET')) &&
      new RegExp('^/api/v1' + o.path.replace(/:[a-z_]+/g, '[^/]+') + '$').test(path),
  );
}
async function loadDeveloperApiCredential(token: string, mfaPolicyAvailable: boolean) {
  ensure(/^dyna_api_[a-f0-9]{64}$/.test(token), 401, 'Nieprawidłowy klucz API');
  const current = (
    await pool.query(
      `SELECT u.id,u.name,u.email,k.id AS api_key_id,k.tenant_id,k.scopes,m.role,t.name AS tenant_name,t.plan${mfaPolicyAvailable ? ',coalesce(p.require_mfa,false) AND a.enabled_at IS NULL AS mfa_required' : ''}
    FROM api_keys k JOIN users u ON u.id=k.user_id JOIN memberships m ON m.user_id=k.user_id AND m.tenant_id=k.tenant_id
    JOIN tenants t ON t.id=k.tenant_id ${mfaPolicyAvailable ? 'LEFT JOIN workspace_security_policies p ON p.tenant_id=t.id LEFT JOIN account_security a ON a.user_id=u.id' : ''} WHERE k.token_hash=$1 AND k.revoked_at IS NULL AND k.expires_at>now()`,
      [tokenHash(token)],
    )
  ).rows[0];
  ensure(current, 401, 'Klucz API wygasł lub został unieważniony');
  ensure(
    !current.mfa_required,
    403,
    'Firma wymaga aktywnego MFA na koncie właściciela klucza API.',
  );
  return current;
}
/** Base wire has an explicit server-owned dispatch scope, separate from /api/v1.
 * Ordinary scopes are checked in api_keys.scopes; only crm:* reads base_wire218_key_scopes,
 * so families without CRM never depend on the 218 table. */
/** A Base write never runs on a key that cannot read the same family:
 * `<family>:write` also requires `<family>:read` whenever that scope exists. */
export function baseWireRequiredScopes(requiredScope: ApiScope): ApiScope[] {
  ensure((apiScopes as readonly string[]).includes(requiredScope), 403, 'Nieprawidłowy zakres Base API');
  const read = requiredScope.endsWith(':write') ? requiredScope.slice(0, -':write'.length) + ':read' : undefined;
  return read && (apiScopes as readonly string[]).includes(read) ? [read as ApiScope, requiredScope] : [requiredScope];
}
export async function authenticateBaseWireApiKey(token: string, requiredScope: ApiScope, mfaPolicyAvailable = true) {
  const required = baseWireRequiredScopes(requiredScope);
  const current = await loadDeveloperApiCredential(token, mfaPolicyAvailable);
  if (!isCrmScope(requiredScope)) {
    ensure(Array.isArray(current.scopes) && required.every((s) => current.scopes.includes(s)), 403, 'Klucz API nie ma wymaganego zakresu');
    return current;
  }
  const granted = (
    await pool.query(
      'SELECT scope FROM base_wire218_key_scopes WHERE tenant_id=$1 AND key_id=$2',
      [current.tenant_id, current.api_key_id],
    )
  ).rows.map((row: { scope: string }) => row.scope);
  ensure(granted.includes('crm:read') && (requiredScope !== 'crm:write' || granted.includes('crm:write')), 403, 'Klucz API nie ma zakresu CRM');
  return { ...current, scopes: [...current.scopes, ...granted] };
}
export async function authenticateApiKey(
  req: FastifyRequest,
  token: string,
  mfaPolicyAvailable = false,
) {
  const current = await loadDeveloperApiCredential(token, mfaPolicyAvailable);
  const allowed = operation(req);
  ensure(
    allowed && current.scopes.includes(allowed.scope),
    403,
    'Klucz API nie ma dostępu do tej operacji',
  );
  if (['/integrations/:id/imports', '/imports/:id'].includes(allowed.path))
    ensure(current.scopes.includes('orders:read'),403,'Odczyt stagingu wymaga zakresu orders:read');
  if (allowed.path === '/integrations/:id/stage-orders' || allowed.path === '/imports/:id/commit')
    ensure(['integrations:write','orders:write'].every(s=>current.scopes.includes(s)),
      403,'Import wymaga zakresów integrations:write i orders:write');
  if (req.method === 'POST' && allowed.path === '/orders')
    ensure(
      typeof req.headers['idempotency-key'] === 'string' &&
        req.headers['idempotency-key'].length > 0,
      422,
      'Publiczne API wymaga Idempotency-Key dla tworzenia zamówień',
    );
  return current;
}
export function publicApiDocument(options: { readOnly?: boolean; port?: number } = {}) {
  const paths: Record<string, any> = {};
  for (const o of publicOperations.filter(
    (o) =>
      !options.readOnly ||
      o.method === 'GET' ||
      (o.method === 'POST' &&
        ['/catalog/exports/file', '/catalog/exports/preview'].includes(o.path)),
  )) {
    const path = o.path.replace(/:([a-z_]+)/g, '{$1}');
    const parameters: any[] = [...o.path.matchAll(/:([a-z_]+)/g)].map((match) => ({
      in: 'path',
      name: match[1],
      required: true,
      schema: match[1] === 'origin' && o.path.startsWith('/warehouse-document-register/')
        ? { type: 'string', enum: warehouseDocumentRegisterSchemas.warehouseRegisterOrigin.options }
        : match[1] === 'source_kind' && o.path.startsWith('/stocktake-adjustments/')
        ? { type: 'string', enum: ['quantity', 'wms'] }
        : { type: 'string', format: 'uuid' },
    }));
    if (o.method === 'GET' && ['/product-catalogs', '/product-catalogs/previews'].includes(o.path)) {
      const query = z.toJSONSchema(o.path.endsWith('/previews') ? productCatalogHistoryQuery : productCatalogListQuery, { io: 'input', unrepresentable: 'any' });
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: (query.required ?? []).includes(name), schema });
    }
    if (o.method === 'GET' && o.path.startsWith('/price-lists/:id/competitor-observations/') &&
        ['/observations', '/batches'].some(suffix => o.path.endsWith(suffix))) {
      parameters.push({ in: 'query', name: 'limit', required: false, schema: { type: 'integer', enum: [50], default: 50 } });
      parameters.push({ in: 'query', name: 'after', required: false, schema: { type: 'string', maxLength: 2048 },
        description: 'Podpisany kursor związany z bieżącą osobą, firmą, cennikiem, uprawnieniami i filtrem. Nie jest identyfikatorem rekordu.' });
      if (o.path.endsWith('/observations')) parameters.push({ in: 'query', name: 'product_id', required: false,
        schema: { type: 'string', format: 'uuid' } });
    }
    if (o.method === 'GET' && o.path.startsWith('/catalog-stock-control/count-documents')) {
      const schema = o.path.endsWith('/export') ? catalogStockCountExportQuery
        : o.path.endsWith('/value') ? catalogStockCountValueRowsQuery
        : o.path.endsWith('/:id') ? catalogStockCountRowsQuery : catalogStockCountQuery;
      const query = z.toJSONSchema(schema,
        { io: 'input', unrepresentable: 'any' });
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: (query.required ?? []).includes(name), schema });
    }
    if (o.method === 'GET' && o.path === '/products')
      parameters.push({ in: 'query', name: 'catalog_id', required: false, schema: { type: 'string', format: 'uuid' }, description: 'Jawny katalog produktów bieżącej firmy; brak parametru odczytuje wszystkie katalogi.' });
    if (o.method === 'GET' && o.path === '/return-assistant/history') {
      const query = z.toJSONSchema(returnAssistantSchemas.returnAssistantHistoryInput, { io: 'input', unrepresentable: 'any' });
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: (query.required ?? []).includes(name), schema });
    }
    if (o.method === 'GET' && (o.path === '/stocktake-adjustments/documents' || /^\/stocktake-adjustments\/(previews|documents)\/:id\/rows$/.test(o.path))) {
      const query = z.toJSONSchema(o.path.endsWith('/rows') ? stocktakeAdjustmentSchemas.adjustmentRowsQuery : stocktakeAdjustmentSchemas.adjustmentHistoryQuery, { io: 'input', unrepresentable: 'any' });
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: (query.required ?? []).includes(name), schema });
    }
    if (o.method === 'GET' && (o.path === '/stocktake-adjustments/register' || o.path === '/stocktake-adjustments/documents/:id/export')) {
      const query = z.toJSONSchema(o.path.endsWith('/export') ? stocktakeAdjustmentSchemas.adjustmentExportQuery : stocktakeAdjustmentSchemas.adjustmentRegisterQuery, { io: 'input', unrepresentable: 'any' });
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: (query.required ?? []).includes(name), schema });
    }
    if (o.method === 'GET' && (o.path === '/warehouse-document-register' || o.path === '/warehouse-document-register/:origin/:id/export')) {
      const query = z.toJSONSchema(o.path.endsWith('/export') ? warehouseDocumentRegisterSchemas.warehouseRegisterExportQuery : warehouseDocumentRegisterSchemas.warehouseRegisterQuery, { io: 'input', unrepresentable: 'any' });
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: (query.required ?? []).includes(name), schema });
    }
    if (o.method === 'GET' && ['/warehouse-automatic-wz/options', '/warehouse-automatic-wz/history'].includes(o.path)) {
      const query = z.toJSONSchema(o.path.endsWith('/options') ? warehouseAutomaticWzSchemas.automaticWzPageQuery : warehouseAutomaticWzSchemas.automaticWzHistoryQuery, { io: 'input', unrepresentable: 'any' });
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: (query.required ?? []).includes(name), schema });
    }
    if (o.method === 'GET' && ['/return-destinations/returns/:id/source', '/return-destinations/returns/:id/history'].includes(o.path)) {
      const query = z.toJSONSchema(o.path.endsWith('/source') ? returnDestinationsSchemas.returnDestinationsSourceQuery : returnDestinationsSchemas.returnDestinationsHistoryQuery, { io: 'input', unrepresentable: 'any' });
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: (query.required ?? []).includes(name), schema });
    }
    if (o.method === 'GET' && ['/email-inbound/messages', '/email-inbound/previews', '/email-inbound/acquisitions', '/email-inbound/replies'].includes(o.path)) {
      const query = z.toJSONSchema(o.path.endsWith('/messages') ? inboundEmailSchemas.inboundListInput : o.path.endsWith('/replies') ? inboundEmailSchemas.inboundRepliesInput : inboundEmailSchemas.inboundHistoryInput, { io: 'input', unrepresentable: 'any' });
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: (query.required ?? []).includes(name), schema });
    }
    if (o.method === 'GET' && o.path.startsWith('/email-inbound/') && o.path.endsWith('/content'))
      parameters.push({ in: 'query', name: 'workspace_id', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Jawna firma zgodna z bieżącą sesją lub kluczem API.' });
    if (o.method === 'GET' && ['/return-assistant/queues', '/return-assistant/queues/:id/items'].includes(o.path)) {
      const query = z.toJSONSchema(o.path.endsWith('/items') ? returnAssistantQueueSchemas.itemsQuery : returnAssistantQueueSchemas.listQuery, { io: 'input', unrepresentable: 'any' });
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: (query.required ?? []).includes(name), schema });
    }
    const catalogExport = [
      '/catalog/exports/options',
      '/catalog/exports/file',
      '/catalog/exports/preview',
    ].includes(o.path);
    const catalogFileImport = o.path.startsWith('/catalog/file-imports/');
    const priceFileImport = o.path.startsWith('/price-file-imports/');
    if (o.method === 'GET' && ['/print-jobs/printers', '/print-jobs/jobs'].includes(o.path)) {
      const schema = z.toJSONSchema(o.path.endsWith('/printers') ? printJobSchemas.printPrinterQuery : printJobSchemas.printJobQuery, { io: 'input', unrepresentable: 'any' }) as any;
      for (const [name, value] of Object.entries(schema.properties ?? {})) parameters.push({ in: 'query', name, required: false, schema: value });
    }
    if (o.method === 'GET' && ['/print-jobs/label-previews/:id/pdf', '/print-jobs/label-cache/:id/pdf', '/print-jobs/label-batches/previews/:id/pdf'].includes(o.path)) parameters.push({
      in: 'query', name: 'workspace_id', required: true, schema: { type: 'string', format: 'uuid' },
      description: 'Jawny identyfikator firmy musi odpowiadać bieżącej sesji lub kluczowi API. Nie jest tokenem autoryzacji.',
    });
    if (o.method === 'GET' && o.path === '/print-jobs/shipments/:id/label-cache/history') {
      const query = z.toJSONSchema(shipmentLabelCacheSchemas.shipmentLabelCachePageInput, { io: 'input', unrepresentable: 'any' }) as any;
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: false, schema });
    }
    if (o.method === 'GET' && o.path === '/print-jobs/label-batches/history') {
      const query = z.toJSONSchema(shipmentLabelBatchSchemas.shipmentLabelBatchHistoryInput, { io: 'input', unrepresentable: 'any' }) as any;
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: (query.required ?? []).includes(name), schema });
    }
    if (o.method === 'GET' && o.path === '/order-parcels/orders/:id/history') {
      const query = z.toJSONSchema(orderParcelSchemas.orderParcelHistoryInput, { io: 'input', unrepresentable: 'any' }) as any;
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: false, schema });
    }
    if (o.path === '/order-parcels/plans/:id/parcels/:index/dispatch') {
      const indexParameter = parameters.find((p: any) => p.in === 'path' && p.name === 'index');
      if (indexParameter) indexParameter.schema = { type: 'integer', minimum: 0, maximum: 49 };
    }
    if (o.method === 'GET' && o.path === '/print-jobs/jobs/:id/content') parameters.push({
      in: 'header', name: 'X-Print-Lease', required: true, schema: { type: 'string', format: 'uuid' },
      description: 'Token bieżącego przejęcia zadania przez tego samego użytkownika i klucz. Historia nigdy nie zwraca tokenu ani pliku.',
    });
    if (
      ['/proformas/series', '/proformas/batches/history'].includes(o.path) &&
      o.method === 'GET'
    ) {
      const query = z.toJSONSchema(
        o.path.endsWith('/history')
          ? proformaBatchSchemas.proformaBatchHistoryQuery
          : proformaSchemas.proformaPageQuery,
        {
          io: 'input',
          unrepresentable: 'any',
        },
      );
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: false, schema });
    }
    const paymentAllocation = o.path.startsWith('/payment-import-allocations/');
    if (paymentAllocation && o.method === 'GET') {
      const schema = o.path.endsWith('/options')
        ? paymentAllocationSchemas.allocationOptionsQuery
        : o.path.endsWith('/history')
          ? paymentAllocationSchemas.allocationPageQuery
          : z.strictObject({});
      const query = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: false, schema });
    }
    if (priceFileImport && o.method === 'GET') {
      const schema = o.path.endsWith('/options')
        ? priceFileImportSchemas.priceFileImportOptionsQuery
        : o.path.endsWith('/rows')
          ? priceFileImportSchemas.priceFileImportRowsQuery
          : [
                '/price-file-imports/profiles',
                '/price-file-imports/previews',
                '/price-file-imports/executions',
              ].includes(o.path)
            ? priceFileImportSchemas.priceFileImportPageQuery
            : z.strictObject({});
      const query = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: false, schema });
    }
    const priceMatrixImport = o.path.startsWith('/price-matrix-imports/');
    if (priceMatrixImport && o.method === 'GET') {
      const schema = o.path.endsWith('/options')
        ? priceMatrixImportSchemas.priceMatrixImportOptionsQuery
        : o.path.endsWith('/rows')
          ? priceMatrixImportSchemas.priceMatrixImportRowsQuery
          : [
                '/price-matrix-imports/profiles',
                '/price-matrix-imports/previews',
                '/price-matrix-imports/executions',
              ].includes(o.path)
            ? priceMatrixImportSchemas.priceMatrixImportPageQuery
            : z.strictObject({});
      const query = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: false, schema });
    }
    const languageFileImport = o.path.startsWith('/language-file-imports/');
    const supplierRemoteFeed =
      o.path.startsWith('/supplier-file-fetches/') ||
      /^\/supplier-file-sources\/:id\/(remote|fetches|feed-schedule)$/.test(o.path);
    const supplierFileSource =
      !supplierRemoteFeed &&
      (o.path.startsWith('/supplier-file-sources') ||
        o.path.startsWith('/supplier-file-previews/'));
    if (supplierRemoteFeed && o.method === 'GET') {
      const query = z.toJSONSchema(
        o.path.endsWith('/fetches')
          ? supplierRemoteSchemas.supplierRemotePageInput
          : z.strictObject({}),
        { io: 'input', unrepresentable: 'any' },
      );
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: false, schema });
    }
    if (supplierFileSource && o.method === 'GET') {
      const query = z.toJSONSchema(
        o.path.endsWith('/history') ? supplierFileSchemas.pageInput : z.strictObject({}),
        { io: 'input', unrepresentable: 'any' },
      );
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: false, schema });
    }
    if (languageFileImport && o.method === 'GET') {
      const schema = o.path.endsWith('/options')
        ? languageFileImportSchemas.languageFileImportOptionsQuery
        : o.path.endsWith('/rows')
          ? languageFileImportSchemas.languageFileImportRowsQuery
          : [
                '/language-file-imports/profiles',
                '/language-file-imports/previews',
                '/language-file-imports/executions',
              ].includes(o.path)
            ? languageFileImportSchemas.languageFileImportPageQuery
            : z.strictObject({});
      const query = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: false, schema });
    }
    const stockFileImport = o.path.startsWith('/stock-file-imports/');
    if (stockFileImport && o.method === 'GET') {
      const schema = o.path.endsWith('/options')
        ? stockFileImportSchemas.stockFileImportOptionsQuery
        : o.path.endsWith('/rows')
          ? stockFileImportSchemas.stockFileImportRowsQuery
          : [
                '/stock-file-imports/profiles',
                '/stock-file-imports/previews',
                '/stock-file-imports/executions',
              ].includes(o.path)
            ? stockFileImportSchemas.stockFileImportPageQuery
            : z.strictObject({});
      const query = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: false, schema });
    }
    const salesReport = o.path.startsWith('/reports/sales/');
    const b2bIntent = o.path.startsWith('/b2b/external-order-intents/');
    const b2bReturn = o.path.startsWith('/b2b/dropshipping-returns/');
    if (b2bReturn && o.method === 'GET') {
      const querySchema = o.path.endsWith('/cases')
        ? b2bReturnSchemas.b2bDropshipReturnHistoryQuery
        : /\/(sources|rows|events)$/.test(o.path)
          ? b2bReturnSchemas.b2bDropshipReturnPageQuery
          : z.strictObject({});
      const query = z.toJSONSchema(querySchema, { io: 'input', unrepresentable: 'any' });
      for (const [name, property] of Object.entries(query.properties ?? {}))
        parameters.push({
          in: 'query',
          name,
          required: (query.required ?? []).includes(name),
          schema: property,
        });
    }
    if (b2bIntent && o.method === 'GET') {
      const querySchema = o.path.endsWith('/orders')
        ? b2bIntentSchemas.b2bExternalOrderIntentPageQuery
        : z.strictObject({});
      const query = z.toJSONSchema(querySchema, { io: 'input', unrepresentable: 'any' });
      for (const [name, property] of Object.entries(query.properties ?? {}))
        parameters.push({
          in: 'query',
          name,
          required: (query.required ?? []).includes(name),
          schema: property,
        });
    }
    const b2bDropship =
      o.path.startsWith('/b2b/network/links/') && o.path.includes('/dropshipping/');
    if (b2bDropship && o.method === 'GET') {
      const querySchema = o.path.endsWith('/sources')
        ? b2bDropshipSchemas.b2bDropshipSourceQuery
        : /\/(quotes|orders)$/.test(o.path)
          ? b2bDropshipSchemas.b2bDropshipPageQuery
          : z.strictObject({});
      const query = z.toJSONSchema(querySchema, { io: 'input', unrepresentable: 'any' });
      for (const [name, property] of Object.entries(query.properties ?? {}))
        parameters.push({
          in: 'query',
          name,
          required: (query.required ?? []).includes(name),
          schema: property,
        });
    }
    if (salesReport) {
      const schema = o.path.endsWith('/options')
        ? z.strictObject({})
        : o.path.endsWith('/file')
          ? salesReportFileQuery
          : ['/reports/sales/orders', '/reports/sales/returns'].includes(o.path)
            ? salesReportPageQuery
            : salesReportQuery;
      const query = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
      for (const [name, property] of Object.entries(query.properties ?? {}))
        parameters.push({
          in: 'query',
          name,
          required: (query.required ?? []).includes(name),
          schema: property,
        });
    }

    if (o.path.startsWith('/order-merges/') && o.method === 'GET') {
      const schema = o.path.endsWith('/history')
        ? orderMergeSchemas.orderMergeHistoryQuery
        : /\/(rows|sources|physical)$/.test(o.path)
          ? orderMergeSchemas.orderMergePageQuery
          : z.strictObject({});
      const query = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
      for (const [name, property] of Object.entries(query.properties ?? {}))
        parameters.push({
          in: 'query',
          name,
          required: (query.required ?? []).includes(name),
          schema: property,
        });
    }
    const replenishment = o.path.startsWith('/replenishment/');
    const replenishmentAutomation = o.path.startsWith('/replenishment/automations/');
    if (replenishment && o.method === 'GET') {
      const schema = replenishmentAutomation
        ? o.path === '/replenishment/automations/rules'
          ? replenishmentAutomationSchemas.replenishmentAutomationPageQuery
          : o.path === '/replenishment/automations/runs'
            ? replenishmentAutomationSchemas.replenishmentAutomationRunsQuery
            : z.strictObject({})
        : o.path === '/replenishment/selection'
          ? replenishmentSchemas.replenishmentSelectionQuery
          : o.path === '/replenishment/drafts'
            ? replenishmentSchemas.replenishmentDraftsQuery
            : o.path === '/replenishment/policies'
              ? replenishmentSchemas.replenishmentPoliciesQuery
              : o.path === '/replenishment/executions'
                ? replenishmentSchemas.replenishmentExecutionsQuery
                : o.path.endsWith('/rows') || o.path.endsWith('/contributors')
                  ? replenishmentSchemas.replenishmentPageQuery
                  : z.strictObject({});
      const query = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
      for (const [name, property] of Object.entries(query.properties ?? {}))
        parameters.push({
          in: 'query',
          name,
          required: (query.required ?? []).includes(name),
          schema: property,
        });
    }
    if (catalogFileImport && o.method === 'GET' && !o.path.endsWith('/options')) {
      const query = z.toJSONSchema(
        o.path.endsWith('/history') ? catalogFileImportHistoryQuery : catalogFileImportRowsQuery,
        { io: 'input', unrepresentable: 'any' },
      );
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({ in: 'query', name, required: false, schema });
    }
    if (catalogExport && o.method === 'GET') {
      const query = z.toJSONSchema(
        o.path.endsWith('/options') ? catalogExportOptionsQuery : catalogExportFileQuery,
        { io: 'input', unrepresentable: 'any' },
      );
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({
          in: 'query',
          name,
          required: false,
          schema,
          ...(name === 'ids'
            ? {
                description:
                  'Jawne UUID rozdzielone przecinkami, 1–500 unikalnych produktów tylko dla selection=selected. Duży wybór przekaż w JSON przez POST /catalog/exports/file; GET podlega limitowi długości żądania HTTP.',
              }
            : name === 'columns'
              ? {
                  description:
                    'Unikalne klucze wspieranych kolumn rozdzielone przecinkami, w kolejności eksportu.',
                }
              : name === 'spreadsheet_safe'
                ? {
                    description:
                      'Domyślnie true: tekstowa reprezentacja CSV z ochronnym apostrofem dla identyfikatorów/formuł; false zachowuje surowe wartości. XML zawsze zachowuje wartości.',
                  }
                : name === 'headers'
                  ? {
                      description:
                        'Mapa JSON wybranych kluczy pól do własnych nazw, do 8192 znaków. Domyślnie klucze pól; nazwy unikalne bez rozróżniania wielkości liter. XML: nazwy elementów ASCII bez colon i prefiksu xml; CSV: do 80 znaków, nagłówki chronione w trybie arkusza.',
                    }
                  : name === 'catalog_id'
                    ? { description: 'Jawny aktywny katalog firmy; magazyny i cenniki muszą należeć do jego przypisań. Brak parametru zachowuje eksport wszystkich katalogów firmy. Katalog zarchiwizowany odmawia 409.' }
                    : name === 'catalog_version'
                      ? { description: 'Wersja konfiguracji katalogu z aktualnego POST preview. Wymagana razem ze scope_hash przy jawnym catalog_id; nie zamraża produktów ani ich liczby.' }
                      : name === 'scope_hash'
                        ? { description: 'Hash katalogu, konfiguracji eksportu, filtrów i wybranych źródeł z POST preview. Wymagany razem z catalog_version przy catalog_id; nie jest receipt ani hashem zamrożonych wierszy produktu.' }
                  : name === 'selection'
                    ? {
                        description:
                          'filtered obejmuje wszystkie wyniki search/active, do 100000 produktów; selected eksportuje dokładne UUID i nie stosuje filtrów search/active.',
                      }
                    : {}),
        });
    }
    if (o.path.startsWith('/packing') && o.method === 'GET') {
      if (
        [
          '/packing/stations',
          '/packing/cartons',
          '/packing/candidates',
          '/packing/receipts',
        ].includes(o.path) ||
        /\/(items|allocations)$/.test(o.path)
      )
        parameters.push({
          in: 'query',
          name: 'cursor',
          required: false,
          schema: { type: 'string', maxLength: 1500 },
          description: 'Kursor poprzedniej strony tego samego zakresu.',
        });
      if (o.path === '/packing/candidates')
        parameters.push({
          in: 'query',
          name: 'warehouse_id',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        });
    }
    if (
      o.path.startsWith('/wms-lots') &&
      !o.path.startsWith('/wms-lots/stocktakes') &&
      o.method === 'GET' &&
      ![
        '/wms-lots',
        '/wms-lots/valuation',
        '/wms-lots/operations/:id',
        '/wms-lots/opening-previews/:id',
        '/wms-lots/movement-previews/:id',
      ].includes(o.path)
    )
      parameters.push({
        in: 'query',
        name: 'cursor',
        required: false,
        schema: { type: 'string', maxLength: 2000 },
        description:
          'Kursor poprzedniej strony tego samego zakresu WMS; maksymalnie 50 wierszy na stronę.',
      });
    if (
      o.method === 'GET' &&
      o.path.startsWith('/wms-lots/stocktakes') &&
      (o.path === '/wms-lots/stocktakes' || /\/(lines|measurements|reviews|rows)$/.test(o.path))
    ) {
      parameters.push(
        {
          in: 'query',
          name: 'cursor',
          required: false,
          schema: { type: 'string', maxLength: 2000 },
          description: 'Kursor poprzedniej strony tego samego spisu i projekcji uprawnień.',
        },
        {
          in: 'query',
          name: 'limit',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
      );
      if (o.path === '/wms-lots/stocktakes')
        parameters.push({
          in: 'query',
          name: 'warehouse_id',
          required: false,
          schema: { type: 'string', format: 'uuid' },
        });
    }
    if (
      o.path.startsWith('/packing') &&
      (o.path === '/packing/sessions/:id' ||
        /\/(renew|cancel|scans|finish)$/.test(o.path) ||
        o.path === '/packing/previews')
    )
      parameters.push({
        in: 'header',
        name: 'X-Packing-Lease',
        required: false,
        schema: { type: 'string', format: 'uuid' },
        description:
          'Token własnej aktywnej sesji. Wymagany dla jej skanów, odnowienia oraz podglądu i zakończenia pakowania; ponowny pomiar nie używa lease.',
      });
    if (o.method === 'GET' && o.path === '/price-bulk-edit/selection')
      parameters.push(
        {
          in: 'query',
          name: 'price_list_id',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        {
          in: 'query',
          name: 'ids',
          required: true,
          schema: {
            type: 'string',
            maxLength: 2000,
            description:
              'Od 1 do 50 jawnych UUID produktów; większy wybór odczytaj w porcjach do 50, a zatwierdź jeden podgląd do 500 produktów.',
          },
        },
      );
    if (o.method === 'GET' && o.path === '/product-translation-bulk-edit/selection')
      parameters.push(
        {
          in: 'query',
          name: 'ids',
          required: true,
          schema: {
            type: 'string',
            maxLength: 2000,
            description:
              'Od1 do50 jawnych UUID produktów rozdzielonych przecinkami; wszystkie strony każdej porcji.',
          },
        },
        {
          in: 'query',
          name: 'locales',
          required: true,
          schema: {
            type: 'string',
            maxLength: 245,
            description: 'Od1 do6 unikalnych kodów języka rozdzielonych przecinkami, np. en-us,de.',
          },
        },
      );
    if (
      o.method === 'GET' &&
      ([
        '/product-translation-bulk-edit',
        '/product-translation-bulk-edit/selection',
        '/product-translation-bulk-edit/executions',
      ].includes(o.path) ||
        /^\/product-translation-bulk-edit\/(previews|executions)\/:id\/rows$/.test(o.path))
    )
      parameters.push({
        in: 'query',
        name: 'cursor',
        required: false,
        schema: {
          type: 'string',
          description: 'meta.cursor poprzedniej strony tego samego wyboru produktów i języków.',
        },
      });
    if (o.method === 'GET' && o.path === '/price-bulk-edit')
      parameters.push({
        in: 'query',
        name: 'search',
        required: false,
        schema: { type: 'string', maxLength: 100 },
      });
    if (
      o.method === 'GET' &&
      (['/price-bulk-edit', '/price-bulk-edit/selection', '/price-bulk-edit/executions'].includes(
        o.path,
      ) ||
        /^\/price-bulk-edit\/(previews|executions)\/:id\/rows$/.test(o.path))
    )
      parameters.push({
        in: 'query',
        name: 'cursor',
        required: false,
        schema: {
          type: 'string',
          description: 'Kursor meta.cursor poprzedniej strony tego samego zakresu.',
        },
      });
    if (o.method === 'GET' && o.path === '/inventory-bulk-edit/selection')
      parameters.push(
        {
          in: 'query',
          name: 'warehouse_id',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        {
          in: 'query',
          name: 'ids',
          required: true,
          schema: {
            type: 'string',
            maxLength: 2000,
            description:
              'Od1do50 jawnych UUID produktów. Większy wybór odczytaj w chunkach≤50, następnie zatwierdź jeden pełny podgląd do500 wierszy.',
          },
        },
      );
    if (
      o.method === 'GET' &&
      (o.path === '/inventory-bulk-edit/selection' ||
        o.path === '/inventory-bulk-edit/executions' ||
        /^\/inventory-bulk-edit\/(previews|executions)\/:id\/rows$/.test(o.path))
    )
      parameters.push({
        in: 'query',
        name: 'cursor',
        required: false,
        schema: {
          type: 'string',
          description: 'Kursor meta.cursor poprzedniej strony, przypisany do pełnego zakresu.',
        },
      });
    if (o.method === 'GET' && o.path === '/catalog-bulk-edit/selection')
      parameters.push({
        in: 'query',
        name: 'ids',
        required: true,
        schema: {
          type: 'string',
          maxLength: 2000,
          description: 'Jawny wybór od1do50UUID produktów, rozdzielonych przecinkami.',
        },
      });
    if (
      o.method === 'GET' &&
      (o.path === '/catalog-bulk-edit/executions' ||
        /^\/catalog-bulk-edit\/(previews|executions)\/:id\/rows$/.test(o.path))
    )
      parameters.push({
        in: 'query',
        name: 'cursor',
        schema: {
          type: 'string',
          description: 'Kursor z meta.cursor poprzedniej strony; brak oznacza pierwszą stronę.',
        },
      });
    if (o.method === 'GET' && o.path === '/orders')
      parameters.push(
        {
          in: 'query',
          name: 'field_filters',
          required: false,
          schema: { type: 'string', maxLength: 10000 },
          description:
            'JSON array of up to five typed AND filters; requires order-fields:read in addition to orders:read.',
        },
        {
          in: 'query',
          name: 'field_columns',
          required: false,
          schema: { type: 'string', maxLength: 1000 },
          description:
            'JSON array of up to ten field UUIDs; requires order-fields:read in addition to orders:read.',
        },
      );
    if (o.method === 'GET' && o.path === '/orders/:id/fields/history')
      parameters.push({
        in: 'query',
        name: 'cursor',
        required: false,
        schema: { type: 'string', maxLength: 300 },
      });
    if (o.method === 'GET' && o.path.startsWith('/order-field-mappings/')) {
      if (o.path === '/order-field-mappings/sources')
        parameters.push({
          in: 'query',
          name: 'channel_id',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        });
      if (
        [
          '/order-field-mappings/profiles',
          '/order-field-mappings/profiles/:id/revisions',
          '/order-field-mappings/sources',
          '/order-field-mappings/previews',
          '/order-field-mappings/previews/:id',
          '/order-field-mappings/executions',
        ].includes(o.path)
      )
        parameters.push({
          in: 'query',
          name: 'cursor',
          required: false,
          schema: { type: 'string', maxLength: 300 },
        });
    }
    if (o.method === 'GET' && o.path.startsWith('/order-field-batches/')) {
      if (o.path === '/order-field-batches/export')
        parameters.push(
          {
            in: 'query',
            name: 'field_ids',
            required: true,
            schema: { type: 'string', maxLength: 1500 },
            description: 'JSON array of up to twenty own field UUIDs.',
          },
          {
            in: 'query',
            name: 'order_ids',
            required: false,
            schema: { type: 'string', maxLength: 5000 },
            description:
              'Optional JSON array of up to one hundred explicit own order UUIDs; otherwise keyset pagination of own orders.',
          },
          {
            in: 'query',
            name: 'mode',
            required: false,
            schema: {
              type: 'string',
              enum: ['csv_exact', 'csv_sheet', 'json'],
              default: 'csv_exact',
            },
          },
          {
            in: 'query',
            name: 'limit',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          },
        );
      if (o.path !== '/order-field-batches/executions/:id')
        parameters.push({
          in: 'query',
          name: 'cursor',
          required: false,
          schema: { type: 'string', maxLength: 300 },
        });
    }
    if (o.method === 'GET' && ['/inventory', '/inventory/movements'].includes(o.path)) {
      parameters.push(
        ...[
          { name: 'warehouse_id', schema: { type: 'string', format: 'uuid' } },
          { name: 'product_id', schema: { type: 'string', format: 'uuid' } },
          { name: 'search', schema: { type: 'string', maxLength: 100 } },
          { name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          {
            name: 'after',
            schema: {
              type: 'string',
              maxLength: 300,
              description: 'Nieprzezroczysty kursor z meta.cursor',
            },
          },
          ...(o.path.endsWith('/movements')
            ? [{ name: 'kind', schema: { type: 'string', maxLength: 50 } }]
            : []),
        ].map((p) => ({ ...p, in: 'query', required: false })),
      );
    }
    if (o.method === 'GET' && o.path === '/inventory/snapshot')
      parameters.push(
        {
          in: 'query',
          name: 'warehouse_id',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        {
          in: 'query',
          name: 'product_ids',
          required: true,
          schema: {
            type: 'string',
            maxLength: 7400,
            description:
              '1–200 UUID produktów rozdzielonych przecinkami; brakujące lub obce stany pomijane',
          },
        },
      );
    if (o.method === 'GET' && ['/picking-waves', '/picking-waves/candidates'].includes(o.path)) {
      parameters.push(
        {
          in: 'query',
          name: 'warehouse_id',
          required: o.path.endsWith('/candidates'),
          schema: { type: 'string', format: 'uuid' },
        },
        {
          in: 'query',
          name: 'limit',
          required: false,
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: o.path.endsWith('/candidates') ? 50 : 25,
          },
        },
        {
          in: 'query',
          name: 'after',
          required: false,
          schema: {
            type: 'string',
            maxLength: 500,
            description: 'Nieprzezroczysty kursor next; przypisany do firmy i filtrów',
          },
        },
        ...(o.path === '/picking-waves'
          ? [
              {
                in: 'query',
                name: 'state',
                required: false,
                schema: {
                  type: 'string',
                  enum: ['picking', 'completed', 'cancelled', 'all'],
                  default: 'picking',
                },
              },
            ]
          : []),
      );
    }
    if (o.method === 'GET' && o.path === '/picking-waves/:id/scan-result')
      parameters.push({
        in: 'query',
        name: 'client_key',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      });
    if (o.method === 'GET' && o.path.startsWith('/stocktakes')) {
      parameters.push(
        { in: 'query', name: 'after', required: false, schema: { type: 'string', format: 'uuid' } },
        {
          in: 'query',
          name: 'limit',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        },
      );
      if (o.path === '/stocktakes')
        parameters.push({
          in: 'query',
          name: 'warehouse_id',
          required: false,
          schema: { type: 'string', format: 'uuid' },
        });
      if (o.path === '/stocktakes/:id')
        parameters.push({
          in: 'query',
          name: 'q',
          required: false,
          schema: { type: 'string', maxLength: 80, description: 'Początek SKU lub lokalizacji' },
        });
    }
    if (o.method === 'GET' && ['/sms/messages', '/email/messages'].includes(o.path))
      parameters.push(
        ...['after', 'order_id'].map((name) => ({
          in: 'query',
          name,
          required: false,
          schema: { type: 'string', format: 'uuid' },
        })),
      );
    if (o.method === 'GET' && o.path === '/email/messages')
      parameters.push({
        in: 'query',
        name: 'limit',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      });
    if (o.method === 'POST' && o.path === '/orders')
      parameters.push({
        in: 'header',
        name: 'Idempotency-Key',
        required: true,
        schema: { type: 'string', minLength: 1, maxLength: 160 },
      });
    if (
      o.method === 'GET' &&
      [
        '/orders',
        '/products',
        '/warehouse-documents',
        '/returns',
        '/orders/:id/returns',
        '/price-lists',
        '/price-lists/:id/items',
        '/suppliers',
        '/purchase-orders',
      ].includes(o.path)
    )
      parameters.push(
        {
          in: 'query',
          name: 'limit',
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: [
              '/warehouse-documents',
              '/returns',
              '/orders/:id/returns',
              '/price-lists',
              '/price-lists/:id/items',
              '/suppliers',
              '/purchase-orders',
            ].includes(o.path)
              ? 100
              : 200,
          },
        },
        {
          in: 'query',
          name: 'after',
          schema: ['/orders', '/returns', '/orders/:id/returns'].includes(o.path)
            ? {
                type: 'string',
                maxLength:
                  o.path === '/orders'
                    ? 300
                    : o.path === '/returns' || o.path === '/orders/:id/returns'
                      ? 1600
                      : 400,
                description: 'Nieprzezroczysty kursor z meta.cursor',
              }
            : { type: 'string', format: 'uuid' },
        },
      );
    if (o.method === 'GET' && o.path === '/orders/:id/payments')
      parameters.push({
        in: 'query',
        name: 'before',
        schema: {
          type: 'string',
          format: 'uuid',
          description: 'ID ostatniego wpisu z poprzedniej strony; maksymalnie 50 wpisów',
        },
      });
    if (o.method === 'GET' && ['/price-lists', '/price-lists/:id/items'].includes(o.path))
      parameters.push({ in: 'query', name: 'search', schema: { type: 'string', maxLength: 100 } });
    if (o.method === 'GET' && ['/suppliers', '/purchase-orders'].includes(o.path)) {
      parameters.push({ in: 'query', name: 'search', schema: { type: 'string', maxLength: 200 } });
      parameters.push(
        o.path === '/suppliers'
          ? { in: 'query', name: 'active', schema: { type: 'string', enum: ['true', 'false'] } }
          : {
              in: 'query',
              name: 'state',
              schema: {
                type: 'string',
                enum: ['draft', 'ordered', 'partial', 'received', 'closed', 'cancelled'],
              },
            },
      );
    }
    if (
      o.method === 'GET' &&
      [
        '/supplier-sources',
        '/supplier-reads',
        '/supplier-catalog',
        '/supplier-bulk-runs',
        '/supplier-bulk-runs/:id',
      ].includes(o.path)
    ) {
      parameters.push(
        { in: 'query', name: 'after', schema: { type: 'string', format: 'uuid' } },
        {
          in: 'query',
          name: 'limit',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        },
      );
      if (o.path !== '/supplier-sources')
        parameters.push({
          in: 'query',
          name: 'source_id',
          schema: { type: 'string', format: 'uuid' },
        });
      if (o.path === '/supplier-catalog')
        parameters.push({
          in: 'query',
          name: 'search',
          schema: { type: 'string', maxLength: 100 },
        });
    }
    if (o.method === 'GET' && o.path === '/price-lists')
      parameters.push({
        in: 'query',
        name: 'active',
        schema: { type: 'string', enum: ['true', 'false'] },
      });
    if (o.method === 'GET' && ['/returns', '/orders/:id/returns'].includes(o.path))
      parameters.push(
        ...[
          {
            name: 'state',
            values: ['requested', 'refund_pending', 'closed', 'rejected', 'cancelled'],
          },
          { name: 'kind', values: ['return', 'complaint'] },
          { name: 'submitted_by', values: ['operator', 'buyer'] },
        ].map((p) => ({ in: 'query', name: p.name, schema: { type: 'string', enum: p.values } })),
        { in: 'query', name: 'search', schema: { type: 'string', maxLength: 100 } },
      );
    paths[path] ??= {};
    paths[path][o.method.toLowerCase()] = {
      operationId: o.method.toLowerCase() + o.path.replace(/[^a-z0-9]/g, '_'),
      summary: o.scope,
      description:
        (options.readOnly ? 'Podgląd odtworzonej kopii. Dostęp wyłącznie do odczytu. ' : '') +
        (o.path.includes('ship-demo') || (o.path.endsWith('/documents') && o.method === 'POST')
          ? 'Operacja tworzy wyłącznie przesyłkę lub dokument DEMO.'
          : 'Zakres klucza: ' +
            (['POST', 'PATCH'].includes(o.method) && o.path.startsWith('/order-field-mappings/')
              ? o.path.includes('/profiles')
                ? 'order-fields:read i order-fields:admin'
                : o.path.endsWith('/import')
                  ? 'order-fields:read, order-fields:write i orders:write'
                  : 'order-fields:read i order-fields:write'
              : o.path.startsWith('/product-translation-bulk-edit')
                ? o.method === 'POST'
                  ? 'products:read i products:write; aktualny administrator. Atomowy zapis nazw i opisów do500 produktów ×6 języków, bez generowania ani publikacji u dostawcy. Brak wersji po operacji wymaga osobnej zgody.'
                  : 'products:read; bieżące wersje językowe i niezmienna historia zatwierdzonych partii'
                : o.path.startsWith('/price-bulk-edit')
                  ? o.method === 'POST'
                    ? 'products:read i products:write; aktualny administrator. Atomowy zapis lokalnego cennika, ceny brutto/netto z zamrożonym VAT, bez FX i bez publikacji. Brak ceny wynikowej wymaga jawnej zgody.'
                    : 'products:read; niezmienna historia i odczyt cen własnych oraz wynikowych'
                  : o.path.startsWith('/inventory-bulk-edit')
                    ? o.method === 'POST'
                      ? 'products:read, inventory:read i inventory:write; aktualny administrator. Pomiar lub przesunięcie zapisuje ruchy magazynowe, bez zmiany PIM/ofert.'
                      : 'products:read i inventory:read'
                    : o.path.startsWith('/catalog-bulk-edit')
                      ? o.method === 'POST'
                        ? 'products:read i products:write; aktualny administrator'
                        : 'products:read'
                      : o.path.startsWith('/customer-message-workflows')
                        ? ['POST', 'PATCH'].includes(o.method)
                          ? 'automations:read, automations:write, communications:read i communications:write'
                          : 'automations:read i communications:read'
                        : o.path === '/customer-messages/:id/assignment'
                          ? 'communications:read i communications:write'
                          : o.method === 'POST' && o.path.startsWith('/order-field-batches/')
                            ? 'order-fields:read i order-fields:write'
                            : o.path === '/orders/:id/product-logistics'
                              ? 'orders:read i products:read; masa fizycznych składników z aktualnego katalogu, skład zamówienia historyczny'
                              : ['/products', '/products/:id'].includes(o.path) &&
                                  ['POST', 'PATCH'].includes(o.method)
                                ? o.scope +
                                  '; jawne pola logistyczne oraz SKU w PATCH wymagają także products:read i aktualnego administratora po oczekiwaniu na blokady; zmiana SKU zachowuje UUID oraz wcześniejsze kody przypisane do produktu, nie zmienia identyfikatorów kanałów'
                                : o.scope)),
      security: [{ bearerAuth: [] }],
      parameters,
      ...(o.input
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: z.toJSONSchema(o.input, { io: 'input', unrepresentable: 'any' }),
                },
              },
            },
          }
        : {}),
      responses: {
        [o.method === 'POST' &&
        [
          '/orders',
          '/products',
          '/warehouse-documents',
          '/product-images',
          '/orders/:id/returns',
          '/return-assistant/sessions',
          '/return-assistant/sessions/:id/photos',
          '/return-assistant/sessions/:id/previews',
          '/return-assistant/previews/:id/receive',
          '/return-destinations/returns/:id/previews',
          '/return-destinations/previews/:id/receive',
          '/stocktake-adjustments/series',
          '/stocktake-adjustments/previews',
          '/stocktake-adjustments/previews/:id/post',
          '/return-assistant/queues',
          '/price-lists',
          '/suppliers',
          '/purchase-orders',
          '/print-jobs/shipments/:id/label-previews',
          '/print-jobs/label-previews/:id/queue',
          '/print-jobs/shipments/:id/label-cache',
          '/print-jobs/label-batches/previews',
          '/print-jobs/label-batches/previews/:id/queue',
        ].includes(o.path)
          ? '201'
          : '200']: {
          description: 'Sukces; odpowiedź zgodna z kontraktem operacji',
          ...(['/print-jobs/label-previews/:id/pdf', '/print-jobs/label-cache/:id/pdf', '/print-jobs/label-batches/previews/:id/pdf'].includes(o.path)
            ? { content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }
            : o.path === '/email/messages/:id/attachment'
            ? {
                content: Object.fromEntries(
                  ['application/pdf', 'text/html'].map((type) => [
                    type,
                    { schema: { type: 'string', format: 'binary' } },
                  ]),
                ),
              }
            : {}),
        },
        '401': { description: 'Klucz nieważny' },
        '403': { description: 'Brak zakresu lub roli' },
        '409': { description: 'Konflikt wersji, stanu, limitu lub klucza idempotencji' },
        '422': { description: 'Błędne dane' },
      },
    };
    applyPimOpenApiContract(paths[path][o.method.toLowerCase()],o.method,o.path);
    applyLargeImportOpenApiContract(paths[path][o.method.toLowerCase()],o.method,o.path);
    if (o.path === '/packing/previews' || o.path === '/packing/previews/:id/finish') {
      const document=paths[path][o.method.toLowerCase()];
      document.description += ' Wymagane aktywne pola zamówienia są częścią całego scope podglądu. ORDER_FIELDS_REQUIRED oznacza ready=false. Zmiana definicji lub wartości po podglądzie wymaga nowej zgody; ostateczne zakończenie sprawdza aktualne własne wartości i IAM, bez ujawniania prywatnych pól.';
      document.responses['409'] = {description:'Nieaktualny scope, wersja, lease lub wymagane pola. Odczytaj aktualne dane i przygotuj nowy podgląd; nie ponawiaj UNKNOWN automatycznie.'};
    }
    if (o.path === '/order-fields' || o.path === '/orders/:id/fields')
      paths[path][o.method.toLowerCase()].description += ' Opcjonalne pack_complete_requirements_available jest wyłącznie metadanymi dostępności kompletnej instalacji; brak/false nie uprawnia do konfiguracji pack_complete. Odczyt wartości i edycja zachowują oryginalne role i scopes.';
    if (o.path.includes('/competitor-observations/')) {
      const document = paths[path][o.method.toLowerCase()];
      document.description = 'Jawne lokalne obserwacje operatora/CSV, bez pobierania cen marketplace. ' +
        'Profil wskazuje przestrzeń źródła, własnego sprzedawcę, miejsce oferty, dostawę i ważność. ' +
        'Partia jest niezmienna, atomowa i związana z client_key, pełnym żądaniem oraz autorem. ' +
        'Dokładne ponowienie zwraca tę samą partię; zmienione żądanie daje409. ' +
        'Zapis obserwacji nie zmienia cen. Zmiana profilu lub danych unieważnia stare podglądy repricingu.';
      document['x-required-scopes'] = o.method === 'GET' ? ['products:read'] : ['products:read', 'products:write'];
      document['x-current-admin-required'] = o.method !== 'GET';
      document['x-observation-origin'] = 'manual_local';
      document['x-limits'] = { batch_rows: 1000, batch_bytes: 1000000, page: 50 };
      document['x-strict-query'] = true;
      document.responses['413'] = { description: 'Przekroczony limit partii.' };
      document.responses['503'] = { description: 'Moduł obserwacji niedostępny lub uszkodzony; rzeczywisty brak instalacji daje options.available=false.' };
      if (o.method !== 'GET') document.responses['423'] = { description: 'Kopia tylko do odczytu; odmowa przed parsowaniem żądania.' };
      if (o.method === 'POST') {
        document.responses['201'] = { description: 'Nowa niezmienna partia, reused=false.' };
        document.responses['200'] = { description: 'Dokładne ponowienie istniejącej partii, reused=true.' };
      }
    }
    if (o.path.includes('/repricing') || o.path.startsWith('/repricing-previews/')) {
      const document = paths[path][o.method.toLowerCase()];
      document.description += ' Strategia competitor_rank korzysta z najnowszych jawnych obserwacji wielu ofert: ' +
        'cena brutto+dostawa, wykluczenie własnego sprzedawcy, ofert niedostępnych i nieaktualnych. ' +
        'Miejsce oznacza ofertę; cena produktu odejmuje różnicę i własną dostawę, następnie stosuje koszt, marżę, prowizję, min/max, kierunek i końcówkę. ' +
        'Wynik zawiera rank_basis ze wszystkimi zakwalifikowanymi/wykluczonymi ofertami, selected i raw_target_gross_minor. ' +
        'Podgląd i zastosowanie są osobne; zapis wymaga aktualnego administratora i products:read+products:write dla klucza API. ' +
        'Zmiana profilu, danych, kosztu, produktu, cennika lub ważności po podglądzie daje409.';
      document['x-ranking-preview-limits'] = { products: 500, offers_per_product: 1000, offers_total: 5000, basis_bytes: 2000000 };
      document.responses['413'] = { description: 'Podgląd rankingu zbyt duży; ogranicz liczbę produktów.' };
    }
    if (o.path === '/imports/:id') {
      const document = paths[path][o.method.toLowerCase()];
      const uuid = {type: 'string', format: 'uuid'}, text = {type: 'string'};
      document['x-required-scopes'] = ['integrations:read', 'orders:read'];
      document['x-current-role'] = 'admin';
      document['x-read-only'] = true;
      document.description = 'Aktualny odczyt jednego własnego źródła importu, także po zmianie jego strony w kolejce. Ten sam handler co zwykły GET /api/imports/:id; bez dostawcy, workera lub zapisu. normalized zawiera dane zamówienia i klienta, dlatego oba zakresy integrations:read i orders:read są wymagane. Raw payload, credentials i settings są wyłączone. imported_hash, state, order_id i current source_hash służą uzgodnieniu oryginalnego wyniku; source_changed=false samo nie potwierdza importu. Odczyt nie pozwala ponowić niepewnego commitu.';
      document.responses['200'] = {description: 'Jedno źródło, nie strona ani tablica. Cache-Control: no-store.',
        content: {'application/json': {schema: {type: 'object', additionalProperties: false,
          required: ['channel', 'data'], properties: {
            channel: {type: 'object', additionalProperties: false,
              required: ['id', 'name', 'provider', 'mode', 'status', 'simulation'],
              properties: {id: uuid, name: text, provider: text, mode: text, status: text, simulation: {type: 'boolean'}}},
            data: {type: 'object', additionalProperties: false,
              required: ['id', 'external_id', 'normalized', 'state', 'issues', 'order_id', 'updated_at', 'source_hash', 'imported_hash', 'source_changed'],
              properties: {id: uuid, external_id: text, normalized: {}, issues: {},
                state: {type: 'string', enum: ['staged', 'imported', 'error']},
                order_id: {type: ['string', 'null'], format: 'uuid'},
                updated_at: {type: 'string', format: 'date-time'}, source_hash: text,
                imported_hash: {type: ['string', 'null']}, source_changed: {type: 'boolean'}}},
          }}}}};
      document.responses['403'] = {description: 'Brak jednego z zakresów odczytu lub aktualnej roli administratora.'};
      document.responses['404'] = {description: 'Źródło lub jego połączenie nie istnieje w bieżącej firmie.'};
      document.responses['422'] = {description: 'Nieprawidłowy UUID lub kanał nieobsługujący importów.'};
    }
    if (['/integrations/:id/imports','/integrations/:id/stage-orders','/imports/:id/commit'].includes(o.path)) {
      const document=paths[path][o.method.toLowerCase()];
      document['x-required-scopes']=o.method==='GET'?['integrations:read','orders:read']:['integrations:write','orders:write'];
      document['x-current-role']='admin';
      document.description='Normalny import własnego źródła: staging nie tworzy zamówienia; commit używa oryginalnego aktora, magazynu i aktualnego expected_hash pod blokadą źródła. Ręczny staging nie wywołuje dostawcy ani workera; genericzny commit Woo zachowuje lokalny zapis, a specjalne ścieżki Amazon/eBay/Odoo/Shopify zachowują oryginalną weryfikację źródła i połączenia. Zachowaj istniejące mapowanie; po niepewnym wyniku odczytaj ten sam import zamiast wysyłać nowe źródło.';
      if(o.method==='GET') {
        const query=z.toJSONSchema(stagedImportQuery,{io:'input',unrepresentable:'any'});
        for(const [name,schema] of Object.entries(query.properties??{})) document.parameters.push({in:'query',name,required:false,schema});
        document.description+=' Odpowiedź zawiera oryginalny normalized (dane zamówienia), issues, source_hash, stan i order_id; wymaga orders:read. Strona zwraca do51 rekordów dla istniejącego interfejsu 50+1, nie zamrożony snapshot.';
      }
      document.responses['403']={description:'Brak wymaganych zakresów lub aktualnej roli administratora'};
      document.responses['409']={description:'Źródło lub stan importu zmienił się; odczytaj oryginalny import'};
      document.responses['422']={description:'Nieprawidłowe dane, brak oczekiwanego hasha lub niedostępny magazyn/mapowanie'};
    }
    if (o.path === '/integrations/:id/verification-history') {
      const document = paths[path][o.method.toLowerCase()];
      document.description = 'Stronicowana historia weryfikacji własnego połączenia. Zakres integrations:read. Bez testu dostawcy, ponowienia zadania lub zmiany połączenia; historyczny status nie potwierdza bieżącego konta.';
      document.parameters.push(
        {in: 'query', name: 'limit', required: false, schema: {type: 'integer', minimum: 1, maximum: 100, default: 25}},
        {in: 'query', name: 'after', required: false, schema: {type: 'string', minLength: 1, maxLength: 500},
          description: 'Nieprzezroczysty kursor tej samej firmy, połączenia i rozmiaru strony; zmiana zakresu wymaga pierwszej strony. Kursor nie nadaje uprawnień.'},
      );
      const uuid = {type: 'string', format: 'uuid'}, text = {type: 'string'};
      document.responses['200'] = {description: 'Bez surowego detail, błędów dostawcy i poświadczeń. next=null oznacza koniec bieżącej historii.',
        content: {'application/json': {schema: {type: 'object', additionalProperties: false,
          required: ['channel', 'data', 'next'], properties: {
            channel: {type: 'object', additionalProperties: false, required: ['id', 'name', 'provider'], properties: {id: uuid, name: text, provider: text}},
            data: {type: 'array', maxItems: 100, items: {type: 'object', additionalProperties: false,
              required: ['id', 'operation', 'status', 'created_at', 'scope'],
              properties: {id: uuid, operation: text, status: text, created_at: {type: 'string', format: 'date-time'}, scope: {type: ['string', 'null'], enum: ['read_only', null]}}}},
            next: {type: ['string', 'null'], maxLength: 500},
          }}}}};
      document['x-required-scopes'] = ['integrations:read'];
      document['x-strict-query'] = true;
      document['x-read-only'] = true;
      document.responses['404'] = {description: 'Połączenie nie istnieje w bieżącej firmie.'};
      document.responses['422'] = {description: 'Nieprawidłowy parametr lub kursor innej firmy, połączenia lub rozmiaru strony.'};
    }
    if (o.path === '/integrations/recovery-queue' || o.path === '/integrations/recovery-queue/identity') {
      const document = paths[path][o.method.toLowerCase()];
      const scopeSchema = {
        type: 'object', additionalProperties: false,
        required: ['tenant_id', 'user_id', 'role', 'restore_preview'],
        properties: {
          tenant_id: { type: 'string', format: 'uuid' }, user_id: { type: 'string', format: 'uuid' },
          role: { type: 'string', enum: ['admin', 'operator', 'viewer'] }, restore_preview: { type: 'boolean' },
        },
      };
      document.description = 'Bieżący odczyt problemów realizacji Shopify, Amazon i eBay. Scope orders:read. Bez ponawiania, uzgadniania ani kontaktu z dostawcą; także na sprawnych połączeniach. Tożsamość i uprawnienia są sprawdzane przed odczytem i przed odpowiedzią.';
      if (o.path === '/integrations/recovery-queue') {
        document.parameters.push(
          { in: 'query', name: 'provider', schema: { type: 'string', enum: ['shopify', 'amazon', 'ebay'] } },
          { in: 'query', name: 'execution', schema: { type: 'string', enum: ['all', 'live', 'simulation'], default: 'all' }, description: 'Nieznane pochodzenie eBay widoczne wyłącznie przy all.' },
          { in: 'query', name: 'limit', schema: { type: 'integer', const: 50, default: 50 } },
          { in: 'query', name: 'after', schema: { type: 'string', minLength: 1, maxLength: 2048 }, description: 'Podpisany kursor tej samej firmy, osoby, sesji, roli i filtrów. Zmiana wiersza granicznego wymaga rozpoczęcia od pierwszej strony.' },
        );
      }
      const text = { type: 'string' }, uuid = { type: 'string', format: 'uuid' };
      const rowProperties = {
        provider: { type: 'string', enum: ['shopify', 'amazon', 'ebay'] },
        plan_id: uuid, order_id: uuid, order_number: text, shipment_id: uuid, channel_id: uuid,
        channel_name: text, channel_status: text, channel_mode: { type: 'string', enum: ['sandbox', 'live'] },
        simulation: { type: ['boolean', 'null'] }, state: { type: 'string', enum: ['failed', 'conflict', 'queued'] },
        phase: { type: 'string', enum: ['ready', 'write_started', 'verify', 'done'] }, job_id: { type: ['string', 'null'], format: 'uuid' },
        job_disposition: { type: 'string', enum: ['pending', 'active', 'stale', 'exhausted', 'failed', 'done', 'missing_or_mismatched'] },
        updated_at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z$' },
        issue: { type: 'string', enum: ['failed_before_send', 'source_conflict', 'write_outcome_unknown', 'verification_incomplete', 'result_requires_review'] },
        reconcile_availability: { type: 'string', enum: ['in_detail', 'read_only', 'admin_required', 'credentials_missing', 'connection_changed', 'not_applicable', 'not_verified', 'queued_inspection_only'] },
      };
      document.responses['200'] = {
        description: 'Wyłącznie bezpieczna projekcja; bez sekretów i surowych błędów dostawcy. stale oznacza wiek odnowienia zadania, nie zgodę na ponowienie.',
        content: { 'application/json': { schema: o.path.endsWith('/identity') ? scopeSchema : {
          type: 'object', additionalProperties: false, required: ['scope', 'items', 'next_cursor'],
          properties: { scope: scopeSchema, items: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false, required: Object.keys(rowProperties), properties: rowProperties } }, next_cursor: { type: ['string', 'null'], maxLength: 2048 } },
        } } },
      };
      document.responses['409'] = { description: 'Zmiana tożsamości, uprawnień, filtrów lub wiersza granicznego kursora.' };
      document.responses['413'] = { description: 'Odczyt wymaga weryfikacji ponad 1000 połączeń eBay.' };
      document.responses['503'] = { description: 'Niekompletny rejestr lub uszkodzone zamrożone pochodzenie realizacji.' };
    }
    if (o.path.startsWith('/email-inbound/')) {
      const document = paths[path][o.method.toLowerCase()];
      const attachmentIndex = document.parameters.find((p: any) => p.name === 'index');
      if (attachmentIndex) attachmentIndex.schema = { type: 'integer', minimum: 0, maximum: 9 };
      const writing = o.method !== 'GET';
      const manage = writing && ['/email-inbound/accounts', '/email-inbound/accounts/:id'].includes(o.path);
      const order = writing && (o.path.endsWith('/bind') || o.path.endsWith('/reply-previews') || o.path.endsWith('/queue'));
      document['x-required-scopes'] = ['communications:read', ...(writing ? ['communications:write'] : []), ...(manage ? ['integrations:write'] : []), ...(order ? ['orders:read'] : [])];
      document['x-email-inbound-limits'] = inboundEmailSchemas.EMAIL_INBOUND_LIMITS;
      document.description = 'Własna skrzynka IMAP TLS: jawny odczyt, pełny podgląd, import i ręczne powiązanie. Email pozostaje źródłem wewnętrznym; nie jest wiadomością portalu. Odpowiedź SMTP wymaga odrębnej zgody. Akceptacja SMTP nie potwierdza doręczenia. Zakresy: ' + document['x-required-scopes'].join(', ') + (manage ? '; aktualny administrator.' : '.');
      document.responses['503'] = { description: 'Moduł odbioru poczty jest niekompletny lub nieobecny w kopii.' };
      if (writing) document.responses['423'] = { description: 'Kopia jest tylko do odczytu; zapis odrzucony przed parsowaniem.' };
      if (o.method === 'POST' && !o.path.endsWith('/reconcile')) {
        document.responses['201'] = document.responses['200'];
        document.responses['200'] = { description: 'Dokładne ponowienie: istniejący wynik i reused=true, bez ponownego odczytu lub wysyłki.' };
      }
      if (o.path.endsWith('/content')) document.responses['200'].content = { 'application/json': { schema: {
        type: 'object', required: ['message_id', 'index', 'filename', 'mime', 'bytes', 'sha256', 'content_base64'],
        properties: {
          message_id: { type: 'string', format: 'uuid' }, index: { type: 'integer', minimum: 0, maximum: 9 },
          filename: { type: 'string', maxLength: 200 }, mime: { type: 'string', maxLength: 200 },
          bytes: { type: 'integer', minimum: 0, maximum: inboundEmailSchemas.EMAIL_INBOUND_LIMITS.attachment_bytes },
          sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, content_base64: { type: 'string', contentEncoding: 'base64', maxLength: 2796204 },
        },
      } } };
    }
    if (o.method === 'POST' && ['/print-jobs/shipments/:id/label-previews', '/print-jobs/label-previews/:id/queue', '/print-jobs/shipments/:id/label-cache', '/print-jobs/label-batches/previews', '/print-jobs/label-batches/previews/:id/queue'].includes(o.path)) {
      paths[path][o.method.toLowerCase()].responses['200'] = { description: 'Dokładne ponowienie: istniejący podgląd lub zadanie, reused=true' };
    }
    if (o.path.startsWith('/return-assistant/')) {
      const document = paths[path][o.method.toLowerCase()];
      document['x-required-scopes'] = ['orders:read', ...(o.method === 'GET' ? [] : ['orders:write'])];
      document.responses['503'] = { description: 'Brak kompletnego modułu asystenta lub osobistych kolejek w kopii.' };
      if (o.method !== 'GET') document.responses['423'] = { description: 'Kopia jest tylko do odczytu; zapis odrzucony przed parsowaniem.' };
      if (document.responses['201']) document.responses['200'] = { description: 'Dokładne ponowienie: istniejący wynik, reused=true; bez drugiej operacji.' };
      if (o.path === '/return-assistant/settings' || o.path.startsWith('/return-assistant/queues')) {
        document['x-return-assistant-queue-limits'] = returnAssistantQueueSchemas.RETURN_ASSISTANT_QUEUE_LIMITS;
        document.description = 'Osobiste ustawienia i uporządkowany manifest własnych RMA. Nawigacja nie rozpoczyna kontroli ani nie przyjmuje towaru. Bieżąca rola, właściciel i klucz API są sprawdzane przy każdej operacji.';
      }
    }
    if (o.path.startsWith('/stocktake-adjustments/')) {
      const document = paths[path][o.method.toLowerCase()];
      document['x-required-scopes'] = ['inventory:read', ...(o.method === 'GET' ? [] : ['inventory:write'])];
      document['x-value-required-scopes'] = ['purchasing:read'];
      document['x-value-required-role'] = 'admin';
      if (o.path.startsWith('/stocktake-adjustments/sources/') || o.path.startsWith('/stocktake-adjustments/previews/'))
        document['x-active-preview-required-role'] = 'admin';
      if (o.method !== 'GET' && o.path !== '/stocktake-adjustments/series')
        document['x-source-required-scopes'] = { quantity: [], wms: ['purchasing:read', 'purchasing:write'] };
      document['x-stocktake-adjustment-limits'] = stocktakeAdjustmentSchemas.STOCKTAKE_ADJUSTMENT_LIMITS;
      document.description = 'Numerowane PW/RW dokumentują korekty rzeczywistego spisu OFF lub ON w tej samej transakcji. Pełny zamrożony podgląd i jawna zgoda poprzedzają pojedynczy zapis. Numery przydzielane przy rozliczeniu; brak drugiego ruchu magazynowego i wstecznego dokumentowania dawnej historii. Koszty ON wymagają bieżącego purchasing:read; OFF nie posiada źródłowej wyceny.';
      if (o.path === '/stocktake-adjustments/register') {
        document.description = 'Globalny odczyt zapisanych PW/RW wszystkich spisów bieżącej firmy. Filtry rodzaju, źródła, magazynu, literalnego prefiksu numeru i dat UTC. Opaque cursor przypięty do aktora, uprawnień i filtrów; brak globalnego total. Odczyt nie nadaje numerów ani nie zmienia zapasu.';
        document.responses['409'] = { description: 'Kursor dotyczy innego aktora, dostępu lub zakresu filtrów.' };
        document.responses['422'] = { description: 'Nieprawidłowy filtr albo zmieniony kursor.' };
      }
      if (o.path === '/stocktake-adjustments/documents/:id/export') {
        document.description = 'Pełny, niezmienny dokument PW/RW z wszystkimi historycznymi fragmentami jako UTF-8 CSV lub XML w JSON envelope. Jawne include_values wymaga aktualnej roli admin i purchasing:read przy zwróceniu pliku. Koszt zero i NULL pozostają odrębne; brak wyceny OFF. Limity odrzucają cały plik bez obcinania. Odczyt bez stock/number mutation; nie jest potwierdzeniem pobrania ani fizycznego wydruku.';
        document.responses['413'] = { description: 'Pełny eksport przekracza budżet; nie zwrócono uciętego pliku.' };
      }
      document.responses['503'] = { description: 'Brak kompletnego modułu lub uszkodzony graf zabezpieczeń.' };
      if (o.method !== 'GET') {
        document.responses['423'] = { description: 'Odtworzona kopia jest tylko do odczytu; odmowa przed parsowaniem.' };
        document.responses['200'] = { description: 'Dokładne ponowienie z bieżącym dostępem zwraca pierwszy wynik bez nowych numerów lub ruchów.' };
      }
    }
    if (o.path === '/warehouse-document-register' || o.path.startsWith('/warehouse-document-register/')) {
      const document = paths[path][o.method.toLowerCase()];
      document['x-required-scopes'] = ['inventory:read'];
      document['x-value-required-scopes'] = ['purchasing:read'];
      document['x-value-required-role'] = 'admin';
      document['x-warehouse-document-register-limits'] = warehouseDocumentRegisterSchemas.WAREHOUSE_DOCUMENT_REGISTER_LIMITS;
      document.description = 'Wspólny odczyt rzeczywistych PZ/MM/WZ/inwentaryzacji, niezmiennych PW/RW149 oraz zapisanych PW/RW korekt WMS152. Origin: warehouse, stocktake_adjustment, wms_correction. Lista pokazuje korektę raz; tylko jej rzeczywisty zapieczętowany źródłowy PZ/WZ jest pomijany w liście, zachowując jawny detail/export origin=warehouse. Pozostałe dokumenty magazynowe pozostają widoczne. Serwerowe UNION ALL i opaque cursor związany z aktorem, grantem, filtrami, kopią i obecnością publikatora. Legacy nazwy magazynów są bieżące, zapisane pozycje pozostają źródłowe;149 i korekty WMS mają historyczne nazwy i wycenę. MM obejmuje magazyn źródłowy lub docelowy. Odczyt bez nowych numerów, ruchów, audit lub sesji; wymaga kompletnego149, a korekty kompletnego publikatora152.';
      document.responses['409'] = { description: 'Kursor dotyczy innego aktora/grantu/filtrów albo manifest dokumentu jest niepełny.' };
      document.responses['422'] = { description: 'Nieprawidłowy filtr, origin, UUID albo zmieniony kursor.' };
      document.responses['413'] = { description: 'Pełny dokument lub eksport przekracza limit; brak obcięcia wierszy.' };
      document.responses['503'] = { description: 'Brak kompletnego149 lub uszkodzone źródło/publikator152; nie zwrócono fałszywego pustego wyniku. Rzeczywisty brak152/publikatora zachowuje wcześniejsze dwa źródła.' };
      if (o.path.endsWith('/export')) document.description = 'Pełny typed dokument i wszystkie zapisane pozycje oraz oddzielne rzeczywiste legacy stock movements jako UTF-8 CSV/XML w JSON envelope. Origin=warehouse, stocktake_adjustment lub wms_correction; jawny eksport źródłowego PZ/WZ korekty pozostaje dostępny. include_values=true wymaga inventory:read oraz świeżego admin/purchasing:read przed bytes; false usuwa koszty i klasyfikację wyceny także z treści. Koszt0 i NULL pozostają odrębne w149WMS i korektach WMS; RW zachowuje ujemną zmianę znanej wartości, a legacy nie ma wymyślonej wyceny. Korekta zawiera zapisany dowód rzeczywistego rodzica i warstw/journali, bez fake spisu. Jeden RR snapshot, końcowy świeży RC IAM PIN, pełne limity10000 wierszy/5MiB escaped JSON bez truncation; nie potwierdza zapisania ani wydrukowania pliku.';
    }
    if (o.path.startsWith('/warehouse-wz-issued/')) {
      const document = paths[path][o.method.toLowerCase()];
      document['x-required-scopes'] = ['inventory:read'];
      document['x-value-required-scopes'] = ['purchasing:read'];
      document['x-value-required-role'] = 'admin';
      if (o.path === '/warehouse-wz-issued/documents') document.parameters.push(
        { in: 'query', name: 'warehouse_id', schema: { type: 'string', format: 'uuid' } },
        { in: 'query', name: 'order_id', schema: { type: 'string', format: 'uuid' } },
        { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 50, default: 50 } },
        { in: 'query', name: 'cursor', schema: { type: 'string', maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$' } });
      if (o.path.endsWith('/export')) document.parameters.push(
        { in: 'query', name: 'format', schema: { type: 'string', enum: ['csv','xml'], default: 'csv' } },
        { in: 'query', name: 'include_values', schema: { type: 'string', enum: ['true','false'], default: 'false' } });
      document.description = 'Odczyt zapisanych automatycznych WZ z rzeczywistych wydań. Pełne pozycje oraz pochodzenie item UUID i receptur zestawów; bez drugiego ruchu towaru lub odtwarzania historii. Wycena i kwoty wymagają bieżącego admin oraz purchasing:read. Zamrożony RR snapshot i osobny świeży RC PIN przed odpowiedzią, CSV/XML wszystkich wierszy bez obcięcia; kopia historyczna bez151 zwraca available=false w options.';
      document.responses['401'] = { description: 'Klucz API został cofnięty lub wygasł także podczas odczytu.' };
      document.responses['403'] = { description: 'Brak bieżącego uprawnienia odczytu lub żądanej wyceny.' };
      document.responses['404'] = { description: 'Dokument lub kursor nie należą do własnego zakresu.' };
      document.responses['413'] = { description: 'Pełny dokument lub plik przekracza limit; wiersze nie są obcinane.' };
      document.responses['422'] = { description: 'Niepoprawne filtry, UUID, parametry eksportu lub kursor innego filtra.' };
      document.responses['503'] = { description: 'Brak kompletnego wystawcy151 lub niespójny zapis dokumentu.' };
    }
    if (o.path.startsWith('/catalog-stock-control/count-documents')) {
      const document = paths[path][o.method.toLowerCase()];
      document['x-required-scopes'] = ['products:read', 'inventory:read'];
      const value = o.path.endsWith('/value'), exporting = o.path.endsWith('/export');
      document['x-count-quantity-only'] = !value && !exporting;
      if (value || exporting) {
        document['x-value-required-scopes'] = ['purchasing:read'];
        document['x-value-required-role'] = 'admin';
      }
      document.description = 'Odczyt zapisanych PW/RW z pomiarów lokalizacji i pliku. Lista oraz pełne wiersze używają nieprzezroczystych kursorów związanych z aktualnym użytkownikiem, kluczem i filtrami; limit 1–50. Zachowane SKU, nazwa i lokalizacja opisują zapis dokumentu. Wycena oraz eksport nie są jeszcze udostępnione przez te dwa odczyty. Odczyt nie zmienia stanów ani nie aktywuje ścisłej kontroli.';
      if (value) document.description = 'Historyczna wycena pozycji PW/RW z rzeczywistych zapisanych warstw. Limit1–50 i kursor związany z dokumentem, użytkownikiem, kluczem, rolą i aktualnym dostępem do kosztów. Koszt0 pozostaje znany, NULL nieznany; wartości i sumy są dokładnymi ciągami całkowitymi według waluty i exponent. Pełna suma dokumentu jest niezależna od bieżącej strony. OFF nie ma wymyślonej wyceny. Aktualny admin i purchasing:read są sprawdzane ponownie przed odpowiedzią.';
      if (exporting) document.description = 'Pełny zapisany PW/RW i wszystkie pozycje jako deterministyczny UTF-8 CSV/XML w JSON envelope. Domyślne include_values=false usuwa pola kosztowe także z pliku. Jawne true wymaga aktualnego admin i purchasing:read; OFF pozostaje bez wyceny. Cały manifest do10000 pozycji i końcowa escaped odpowiedź do8MiB, bez obcinania. Odczyt nie zmienia stanów ani numeracji; sam GET nie dowodzi pobrania lub wydrukowania pliku.';
      for (const [code, description] of Object.entries({
        '401': 'Użytkownik lub klucz API nie jest aktualny.',
        '403': 'Brak bieżącej roli lub zakresów products:read i inventory:read; wycena wymaga admin i purchasing:read.',
        '404': 'Dokument lub kursor nie należy do bieżącego zakresu.',
        '409': 'Kursor ma innego użytkownika, klucz, rolę, filtr lub limit strony.',
        '413': 'Zapis dokumentu przekracza limit bezpiecznej projekcji 8 MiB; odpowiedź nie jest obcinana.',
        '422': 'Niepoprawny UUID, filtr lub kursor.',
        '503': 'Moduł COUNT jest uszkodzony lub zapis dokumentu jest niespójny.',
      })) document.responses[code] = { description };
    }
    if (o.path.startsWith('/catalog-stock-control/') && !o.path.startsWith('/catalog-stock-control/count-documents')) {
      const document = paths[path][o.method.toLowerCase()];
      document['x-required-scopes'] = ['inventory:read', ...(o.method === 'GET' ? [] : ['inventory:write'])];
      document['x-value-required-scopes'] = ['purchasing:read'];
      document['x-value-required-role'] = 'admin';
      document['x-catalog-stock-control-limits'] = catalogStockControlSchemas.CATALOG_STOCK_CONTROL_LIMITS;
      document.description = 'Ścisła kontrola wybranego katalogu: pełny podgląd istniejących stanów i osobna zgoda administratora tworzą niezmienne BO dla przypisanych magazynów, bez ponownego przyjęcia towaru. Aktywacja wymaga potwierdzonej dostępności adapterów ruchów fizycznych. Wersje katalogu, polityk i serii oraz pełny zakres są sprawdzane ponownie przy zapisie. Historia i wszystkie pozycje są dostępne z inventory:read; koszty wymagają aktualnego admin i purchasing:read. Koszt zero i brak kosztu pozostają odrębne. Eksport CSV/XML jest pełnym plikiem w JSON envelope, bez obcinania wierszy.';
      for (const [code, description] of Object.entries({
        '401': 'Klucz API został cofnięty lub wygasł.',
        '403': 'Brak aktualnej roli, zakresów odczytu/zapisu lub uprawnienia wyceny.',
        '404': 'Źródło, podgląd, dokument lub kursor nie należą do własnego zakresu.',
        '409': 'Źródło lub pełny zakres zmieniły się albo klucz ma inne żądanie.',
        '413': 'Pełny podgląd, dokument lub eksport przekracza limit; wiersze nie są obcinane.',
        '422': 'Niepoprawny UUID, wersja, parametr, zgoda lub dodatkowe pole żądania.',
        '503': 'Brak kompletnego modułu lub potwierdzonych adapterów fizycznych.',
      })) document.responses[code] = { description };
      if (o.method !== 'GET') {
        document.responses['201'] = { description: 'Nowy podgląd lub zatwierdzony BO, reused=false.' };
        document.responses['200'] = { description: 'Dokładne ponowienie zwraca pierwszy wynik bez kolejnego BO.' };
        document.responses['423'] = { description: 'Odtworzona kopia jest tylko do odczytu; odmowa przed parsowaniem.' };
      }
      if (o.path.endsWith('/rows')) document.parameters.push(
        { in: 'query', name: 'cursor', schema: { type: 'integer', minimum: 0, maximum: 10000 } },
        { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 } });
      if (o.path.endsWith('/export')) document.parameters.push(
        { in: 'query', name: 'format', schema: { type: 'string', enum: ['csv', 'xml'] } },
        { in: 'query', name: 'include_values', schema: { type: 'string', enum: ['true', 'false'], default: 'false' } });
      if (o.path.endsWith('/history')) document.parameters.push(
        ...['catalog_id', 'warehouse_id', 'cursor'].map(name => ({ in: 'query', name, schema: { type: 'string', format: 'uuid' } })),
        { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 50, default: 50 } });
    }
    if (o.path.startsWith('/warehouse-automatic-wz/')) {
      const document = paths[path][o.method.toLowerCase()];
      document['x-required-scopes'] = ['inventory:read', ...(o.method === 'GET' ? [] : ['inventory:write'])];
      document['x-issuer-availability-path'] = '/warehouse-automatic-wz/options';
      document.description = 'Wersjonowana konfiguracja jednej systemowej serii WZ na magazyn. Pełny podgląd i osobna zgoda zapisują ustawienia, bez ruchów towaru, nadania numeru lub wystawienia WZ. Pole issuer_available odpowiedzi odzwierciedla obecność kompletnego wystawcy w bieżącej bazie; ustawienie enabled nie instaluje wystawcy. Zapisy wymagają aktualnej roli admin i inventory:read+inventory:write; dokładne ponowienie zachowuje pierwszy wynik przy bieżącym dostępie.';
      document.responses['409'] = { description: 'Konfiguracja zmieniła wersję lub klucz ponowienia ma inne żądanie.' };
      document.responses['503'] = { description: 'Moduł konfiguracji150 jest niekompletny lub zabezpieczenia niespójne.' };
      if (o.method !== 'GET') {
        document.responses['423'] = { description: 'Odtworzona kopia jest tylko do odczytu; odmowa przed parsowaniem.' };
        document.responses['201'] = { description: 'Nowy podgląd lub potwierdzony zapis konfiguracji, reused=false.' };
        document.responses['200'] = { description: 'Dokładne ponowienie zwraca pierwszy wynik, reused=true; bez kolejnego zapisu.' };
      }
    }
    if (o.path.startsWith('/return-destinations/')) {
      const document = paths[path][o.method.toLowerCase()];
      document['x-required-scopes'] = ['orders:read', 'inventory:read', ...(o.method === 'GET' ? [] : ['orders:write', 'inventory:write'])];
      document['x-return-destinations-limits'] = returnDestinationsSchemas.RETURN_DESTINATIONS_LIMITS;
      document.description = 'Przyjęcie części zwrotu do własnych magazynów sprzedaży lub kontroli. Wymaga prawdziwej sesji asystenta, trwałych skanów, oryginalnego pochodzenia oraz osobnej zgody na zamrożony podgląd. Lease jest wyłącznie w ciele zapisu; odczyty nie zawierają prywatnych kosztów ani tokenu.';
      document.responses['503'] = { description: 'Brak kompletnego protokołu przyjęcia lub niespójne zabezpieczenia w kopii.' };
      if (o.method !== 'GET') {
        document.responses['423'] = { description: 'Odtworzona kopia jest tylko do odczytu; odmowa przed parsowaniem.' };
        document.responses['200'] = { description: 'Dokładne ponowienie z bieżącym dostępem: istniejący podgląd lub odbiór, reused=true; bez drugiego przyjęcia.' };
      }
    }
    if (o.path.startsWith('/return-assistant/statuses')) {
      const document = paths[path][o.method.toLowerCase()];
      document['x-required-scopes'] = ['orders:read', 'inventory:read', ...(o.method === 'GET' ? [] : ['returns:configure'])];
      document.description = 'Wersjonowana konfiguracja statusów pozycji zwrotu: własny magazyn, podgląd i osobna zgoda administratora. Konfiguracja nie przyjmuje towaru; intake_available wskazuje dostępność osobnego protokołu destinations_v1 w tej kopii.';
      document['x-return-destination-status-limits'] = returnDestinationStatusSchemas.RETURN_DESTINATION_STATUS_LIMITS;
    }
    if (o.path.startsWith('/warehouse-inventory-policies')) {
      const document = paths[path][o.method.toLowerCase()];
      document['x-required-scopes'] = ['inventory:read', ...(o.method === 'GET' ? [] : ['inventory:write'])];
      document.description = 'Przeznaczenie własnego magazynu: sprzedaż lub kontrola. Jawny podgląd i osobna zgoda administratora; zmiana przeznaczenia wymaga pustego magazynu i braku aktywnych zobowiązań.';
      document.responses['503'] = { description: 'Niekompletny moduł polityki magazynów.' };
      if (o.method !== 'GET') document.responses['423'] = { description: 'Kopia jest tylko do odczytu; zapis odrzucony przed parsowaniem.' };
    }
    if (o.path.includes('/label-cache')) {
      const document = paths[path][o.method.toLowerCase()];
      const custody = o.method !== 'GET' || /\/(content|pdf)$/.test(o.path);
      document.description = 'Cache istniejącej etykiety: InPost jawny GET PDF A6, DPD przyjęcie lokalnych bajtów. Metadata, historia, odczyt cache i reconcile nie kontaktują dostawcy. Cache nie nadaje przesyłki, nie kupuje etykiety ani nie kolejkuje druku. Nieznana próba wymaga jawnego zamknięcia przed nowym pobraniem.';
      document['x-required-scopes'] = ['orders:read', ...(custody ? ['orders:write', 'documents:read'] : [])];
      document['x-shipment-label-cache-limits'] = shipmentLabelCacheSchemas.SHIPMENT_LABEL_CACHE_LIMITS;
      document.responses['503'] = { description: 'Brak kompletnego schematu szyfrowanego cache etykiet' };
      if (custody) document.responses['423'] = { description: 'Kopia jest tylko do odczytu' };
      if (o.method === 'POST' && o.path.endsWith('/label-cache'))
        document.responses['200'] = { description: 'Dokładne ponowienie zapisanej próby, reused=true; bez ponownego GET dostawcy. Nowy klucz tworzy odpowiedź 201 również przy wykorzystaniu istniejącego cache.' };
    }
    if (o.path.startsWith('/print-jobs/label-batches/')) {
      const document = paths[path][o.method.toLowerCase()];
      const custody = o.method !== 'GET' || /\/(content|pdf)$/.test(o.path);
      document.description = 'Partia istniejących szyfrowanych etykiet PDF: pełny połączony artefakt przeglądu, osobna zgoda i atomowe utworzenie zadań z oryginalnych plików. Brak ukrytego pobrania, zakupu lub nadania u przewoźnika. Wyniki pliku/CUPS pozostają osobne dla każdego zadania; nie gwarantują kolejności fizycznego wydruku ani papieru.';
      document['x-required-scopes'] = ['orders:read', ...(custody ? ['orders:write', 'documents:read'] : [])];
      document['x-shipment-label-batch-limits'] = shipmentLabelBatchSchemas.SHIPMENT_LABEL_BATCH_LIMITS;
      document.responses['503'] = { description: 'Brak kompletnego schematu partii etykiet' };
      if (custody) document.responses['423'] = { description: 'Kopia jest tylko do odczytu' };
      if (o.method === 'POST') document.responses['200'] = { description: 'Dokładne ponowienie: istniejący podgląd lub execution, reused=true; bez nowych zadań i kopii' };
    }
    if (o.path.startsWith('/order-parcels/')) {
      const document = paths[path][o.method.toLowerCase()];
      document.description = 'Podgląd, osobne zatwierdzenie planu i osobne wydanie każdej paczki. Protokół commercial_v1 przydziela konkretne historyczne pozycje sprzedaży i całe jednostki zestawów; serwer wyprowadza fizyczne składniki. Starszy protokół products pozostaje fizyczny. Plan nie zużywa zapasu. Zamówienie pozostaje spakowane, dopóki istnieją oczekujące paczki. Źródła DEMO są lokalne; integracje przewoźników wymagają osobnego potwierdzenia zakresu.';
      document['x-required-scopes'] = ['orders:read', ...(o.method === 'GET' ? [] : ['orders:write'])];
      document['x-order-parcel-limits'] = orderParcelSchemas.ORDER_PARCEL_LIMITS;
      document.responses['503'] = { description: 'Brak kompletnego schematu przydziałów paczek' };
      if (o.method === 'POST') {
        document.responses['423'] = { description: 'Kopia jest tylko do odczytu' };
        document.responses['200'] = { description: 'Dokładne ponowienie: istniejący wynik bez kolejnego rozchodu' };
      }
    }
    if (o.path.startsWith('/order-parcel-releases/')) {
      const document = paths[path][o.method.toLowerCase()];
      document.description = 'Osobny podgląd i zgoda na anulowanie wszystkich niewydanych paczek commercial_v1. Zwolnienie zmniejsza wyłącznie rezerwację; nie wykonuje ruchu fizycznego, refundacji ani korekty dokumentu.';
      document['x-required-scopes'] = ['orders:read', ...(o.method === 'GET' ? [] : ['orders:write'])];
      document['x-order-parcel-release-limits'] = orderParcelReleaseSchemas.ORDER_PARCEL_RELEASE_LIMITS;
      document.responses['503'] = { description: 'Niekompletny schemat zwolnień paczek' };
      if (o.method === 'POST') { document.responses['423'] = { description: 'Kopia jest tylko do odczytu' }; document.responses['200'] = { description: 'Dokładne ponowienie zwraca istniejący wynik bez nowego zwolnienia' }; }
    }
    if (b2bIntent) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Jawne zamówienie handlowe z podziałem lokalnym, zewnętrznym i nieprzydzielonym. Tylko część lokalna tworzy rezerwacje. Zewnętrzna intencja wymaga osobnej wyceny i zatwierdzenia dostawcy; nie tworzy własnego PZ, skanów, przesyłki ani wpłaty. Zmiany przydziału używają aktualnej wersji i rzeczywistego zapasu. Exact replay zachowuje aktora i treść próby. Anulowanie oraz ponowne otwarcie są osobnymi audytowanymi operacjami.';
      document['x-required-scopes'] = [
        'products:read',
        'inventory:read',
        'orders:read',
        'purchasing:read',
        ...(o.method === 'GET' ? [] : ['inventory:write', 'orders:write', 'purchasing:write']),
      ];
      document['x-b2b-external-order-intent-limits'] =
        b2bIntentSchemas.B2B_EXTERNAL_ORDER_INTENT_LIMITS;
      document.responses['503'] = {
        description: 'Brak kompletnego schematu zewnętrznych intencji realizacji.',
      };
      if (o.method === 'POST' && o.path.endsWith('/orders')) {
        document.responses['201'] = {
          description: 'Utworzono zamówienie i intencję; exact replay zwraca 200.',
        };
        document['x-conditional-scopes'] = { initial_fields: ['order-fields:write'] };
      }
      if (o.method !== 'GET')
        document.responses['423'] = { description: 'Kopia tylko do odczytu.' };
    }
    if (b2bDropship) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Dostawa z własnej sieci B2B do klienta konkretnego zamówienia. Dokładne pozycje i receptury, zamrożony odbiorca, osobne ceny i przedpłata hurtowa. Potwierdzenie tworzy rzeczywistą rezerwację dostawcy. Podstawa local_reservation oddaje nieskompletowaną rezerwację sprzedawcy, a external_intent zatwierdza wcześniejszy zamiar bez ruchu własnego zapasu. Anulowanie przed wydaniem odpowiednio odtwarza lokalną rezerwację albo niezleconą intencję zewnętrzną. Brak PZ i kopiowania wpłat. Uzgodnienie wymaga rzeczywistego wydania wszystkich części. Aktualna rola i pełne zakresy są sprawdzane po oczekiwaniu. Nie potwierdza dostępu do Base Connect ani zewnętrznego kuriera.';
      document['x-required-scopes'] = [
        'products:read',
        'inventory:read',
        'orders:read',
        'purchasing:read',
        ...(o.method === 'GET' ? [] : ['inventory:write', 'orders:write', 'purchasing:write']),
      ];
      document['x-b2b-dropshipping-limits'] = b2bDropshipSchemas.B2B_DROPSHIP_LIMITS;
      document.responses['503'] = { description: 'Brak kompletnego schematu dropshippingu.' };
      if (o.method === 'POST' && /\/(quotes|checkout)$/.test(o.path))
        document.responses['201'] = {
          description: 'Utworzona wycena lub dostawa; ponowienie tej samej próby zwraca 200.',
        };
      if (o.method !== 'GET')
        document.responses['423'] = { description: 'Kopia tylko do odczytu.' };
    }
    if (b2bReturn) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Koordynowany zwrot klienta bezpośrednio do pierwotnego dostawcy dropshipping. Pełny podgląd zamraża oryginalne pozycje handlowe, rzeczywiste wydania, receptury, adres i odrębne kwoty obu firm. Zatwierdzenie tworzy powiązane RMA. Dostawca jawnie przyjmuje towar w swoim magazynie, a sprzedawca osobno uznaje zwrot na podstawie dowodu partnera bez fikcyjnego lokalnego przyjęcia. Korekty i deklaracje rozliczeń są odrębnymi działaniami. Aktualne role i klucze sprawdza się po oczekiwaniu; dokładne ponowienie wiąże aktora, klucz i treść żądania.';
      document['x-required-scopes'] = [
        'orders:read',
        'inventory:read',
        ...(o.method === 'GET' ? [] : ['orders:write', 'inventory:write', 'purchasing:write']),
      ];
      document['x-conditional-scopes'] = { financial_values: ['purchasing:read'] };
      document['x-b2b-dropshipping-return-limits'] = b2bReturnSchemas.B2B_DROPSHIP_RETURN_LIMITS;
      document.responses['503'] = {
        description: 'Brak kompletnego schematu koordynowanych zwrotów.',
      };
      if (o.method !== 'GET')
        document.responses['423'] = {
          description: 'Kopia tylko do odczytu; odmowa przed parsowaniem.',
        };
      if (o.method === 'POST' && /\/(previews|submit)$/.test(o.path))
        document.responses['201'] = {
          description:
            'Utworzony podgląd lub komplet spraw partnerów; dokładne ponowienie zwraca 200.',
        };
    }
    if (o.path.startsWith('/order-merges/')) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Łączenie 2–100 własnych zamówień przed wydaniem w jednym magazynie, walucie i sposobie płatności. Podgląd pełnego zakresu, odrębne pozycje z historycznymi cenami/recepturami, dodatkowa zgoda na odbiorcę. Wykonanie scope_hash/confirmed atomowo przenosi realizację i rezerwacje bez zmiany fizycznego zapasu lub kopiowania wpłat. Źródła pozostają w historii i nie mogą być ponownie realizowane. Dokładne ponowienie wymaga tego samego aktora, klucza i żądania. Kopia tylko do odczytu odmawia zapisu przed parsowaniem.';
      document['x-required-scopes'] = [
        'orders:read',
        'inventory:read',
        ...(o.method === 'GET' ? [] : ['orders:write', 'inventory:write']),
      ];
      document['x-order-merge-limits'] = orderMergeSchemas.ORDER_MERGE_LIMITS;
      document.responses['503'] = { description: 'Brak kompletnego schematu łączenia zamówień.' };
      if (o.method !== 'GET')
        document.responses['423'] = { description: 'Kopia tylko do odczytu.' };
    }
    if (replenishment) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Polityki uzupełniania jednego magazynu oraz jawny wybór do 500 produktów. ' +
        'Podgląd uwzględnia dostępność po rezerwacjach, ręczne szkice zakupów, pozostałe ilości PO oraz własnych zakupów B2B. ' +
        'Opcjonalne forecast {lookback_days:7|14|30|60|90,coverage_days:1..365} wymaga capability forecast_available migracji100. ' +
        'Popyt to fizyczne wydania z własnego magazynu zapisane w dzienniku (także DEMO/sandbox); zwroty przyjęte na stan pokazuje się osobno, bez pomniejszania wydań. ' +
        'Okno [from,to) ustala serwer i zamraża; klient nie podaje dat lub ilości historycznych. Cel=max(minimum polityki,ceil(wydania*dni pokrycia/dni okna)); ręczny cel polityki nie jest używany w prognozie. ' +
        'Brak wydań w lokalnych danych nie dowodzi braku sprzedaży poza systemem. Bez forecast obowiązuje dotychczasowy rachunek minimum/celu. ' +
        'Opcjonalne draft_targets [{supplier_id,currency,purchase_order_id,version}] wskazuje istniejące szkice do uzupełnienia i wymaga capability append_available migracji101. ' +
        'GET /replenishment/drafts udostępnia paginowane szkice danego magazynu, dostawcy i waluty. ' +
        'Podgląd zamraża cały wskazany dokument; dopisanie zachowuje metadane i pozostałe pozycje, zwiększa ilość istniejącego SKU przy zgodnym koszcie/kodzie dostawcy albo dodaje nowy SKU. ' +
        'Zgoda scope_hash/confirmed atomowo tworzy nowe szkice lub uzupełnia jawnie wskazane istniejące, do 200 końcowych pozycji na dokument; nie wysyła ich do dostawcy. ' +
        'Koszt netto jest całkowitą liczbą najmniejszych jednostek: null oznacza brak kosztu, zero jest prawdziwą ceną. ' +
        'Koszty są widoczne tylko dla bieżącego administratora; kwoty sumuje się osobno dla walut, bez konwersji. ' +
        'Podgląd ważny 15 minut. Exact retry client_key podglądu lub wykonania zwraca niezmienny wynik przed dawnym CAS/TTL, po aktualnej autoryzacji. Retry utworzenia polityki zwraca jej bieżącą wersję z reused=true. ' +
        'Zmiana któregokolwiek źródła wymaga nowego podglądu. Historia i wszystkie strony wymagają aktualnych uprawnień.';
      document['x-required-scopes'] = [
        'products:read',
        'inventory:read',
        'purchasing:read',
        ...(o.method === 'GET' ? [] : ['purchasing:write']),
      ];
      document['x-replenishment-limits'] = replenishmentSchemas.REPLENISHMENT_LIMITS;
      document.responses['503'] = {
        description: 'Kopia nie zawiera kompletnego schematu planowania zakupów.',
      };
      if (o.method !== 'GET') {
        document.responses['423'] = {
          description: 'Kopia wyłącznie do odczytu; odmowa przed parsowaniem żądania.',
        };
        document.responses['429'] = {
          description: 'Limit trwałych dowodów, rozmiaru źródeł lub częstości żądań.',
        };
        document.responses['409'] = {
          description:
            'Konflikt wersji, źródeł, zakresu zgody albo client_key; utwórz nowy podgląd.',
        };
        if (o.method === 'POST')
          document.responses['201'] = {
            description:
              'Nowa polityka, podgląd lub wykonanie. Dokładne retry zwraca 200 z reused=true.',
          };
      }
    }

    if (salesReport) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Raport lokalnych zdarzeń: sprzedaż według created_at aktywnego właściciela, uznane zwroty według accepted_at (fizyczny odbiór lub trwały dowód partnera), fizyczne koszty według czasu fragmentu. received_at pozostaje datą rzeczywistego przyjęcia do własnego magazynu; partnerowe uznanie nie tworzy lokalnego przyjęcia, kosztu ani wpłaty. Bieżąca marża towarowa kohorty jest odrębna od trzech osi okresu. Netto według historycznego VAT pozycji, bez VAT dostawy i bez FX; wpłaty nie są obrotem. Każdy odczyt ma własny RR snapshot i świeże uprawnienia przed odpowiedzią. Daty są włączne Europe/Warsaw, maksymalnie366. Ilości i kwoty to decimal strings. Brak pełnego kosztu albo różne waluty dają nullmargin i jawne przyczyny.';
      document['x-required-scopes'] = ['orders:read', 'inventory:read'];
      document['x-financial-projection'] =
        'Bieżący administrator; dla API dodatkowo purchasing:read. Pozostali otrzymują projekcję bez kwot, kosztów i pochodnych.';
      document['x-sales-report-limits'] = SALES_REPORT_LIMITS;
      document.responses['422'] = {
        description: 'Niepoprawne daty, zakres przekraczający 366 dni lub niepoprawne filtry.',
      };
      document.responses['413'] = {
        description: 'Zakres przekracza 100000 rekordów lub 64MiB pliku. Brak cichego obcięcia.',
      };
      document.responses['409'] = {
        description:
          'Cursor należy do innego zakresu lub uprawnienia zmieniły się podczas pagedodczytu.',
      };
      if (o.path.endsWith('/file'))
        document.responses['200'] = {
          description:
            'Pełny, zweryfikowany UTF-8 CSV. Prywatny spool i końcowa autoryzacja przednagłówkami.',
          headers: {
            'Content-Length': { schema: { type: 'integer' } },
            'X-Sales-Report-Count': { schema: { type: 'integer', maximum: 100000 } },
            'Content-Disposition': { schema: { type: 'string' } },
          },
          content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
        };
    }
    if (replenishmentAutomation) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Automatyczne lokalne szkice zakupów po rzeczywistym przejściu dostępności SKU ' +
        'z wartości co najmniej minimum polityki do wartości poniżej minimum. ' +
        'Wyłączona domyślnie reguła obejmuje jeden magazyn i do 500 jawnych fizycznych produktów; ' +
        'włączenie wymaga confirmed_future_drafts=true i aktualnego administratora. ' +
        'Nie działa wstecz dla już niskiego zapasu ani nowego zerowego wiersza stock. ' +
        'Trwały zapis źródła zamraża zgodę i wersje polityk. Worker w jednej transakcji ' +
        'tworzy pełny podgląd, wykonanie i szkice, po ponownej kontroli bieżących uprawnień i zgody. ' +
        'destination=new_drafts tworzy nowe dokumenty; append_matching_draft wybiera najstarszy ' +
        'pasujący własny niezatwierdzony szkic albo tworzy nowy przy braku pasującego dokumentu. ' +
        'Konflikt wybranego dokumentu blokuje całą partię, bez cichego fallback lub podziału. ' +
        'Plan uwzględnia rezerwacje i wszystkie incoming; brak niedoboru kończy się NOP. ' +
        'Opcjonalna prognoza zachowuje kontrakt zapisanych wydań. ' +
        'Zmiana lub wyłączenie reguły, zmiana polityki i utrata roli unieważniają oczekującą zgodę. ' +
        'Anulowanie wymaga wersji i client_key. Pełna kolejka lub historia cofa wywołującą zmianę stock, ' +
        'aby nie zgubić zdarzenia. Koszty widzi tylko bieżący administrator; ' +
        'brak zatwierdzania PO, wysyłki do dostawcy, PZ lub płatności. Capability wymaga migracji102.';
      document['x-replenishment-automation-limits'] =
        replenishmentAutomationSchemas.REPLENISHMENT_AUTOMATION_LIMITS;
      document.responses['503'] = {
        description: 'Kopia nie zawiera kompletnego schematu automatycznego uzupełniania102.',
      };
      if (o.method !== 'GET') {
        document.responses['409'] = {
          description: 'Konflikt wersji, zmieniona zgoda, stan zadania lub client_key.',
        };
        if (o.path.endsWith('/cancel')) delete document.responses['201'];
        else if (o.method === 'POST')
          document.responses['201'] = {
            description: 'Utworzono regułę; dokładne ponowienie zwraca 200 i bieżącą regułę.',
          };
      }
    }
    if (o.path.startsWith('/product-catalogs') && !o.path.startsWith('/product-catalogs/:catalog_id/pim/')) {
      const document = paths[path][o.method.toLowerCase()];
      document['x-required-scopes'] = o.method === 'GET' ? ['products:read'] : ['products:read', 'products:write'];
      document.description = 'Niezależne katalogi jednej firmy z przypisanymi magazynami, cennikami i językami. Produkt ma stałą przynależność; SKU i aliasy pozostają unikalne w firmie, a polityka WMS jest wspólna. Zapis konfiguracji wymaga bieżącego administratora, osobnej zgody, scope_hash i trwałego client_key. Dokładne retry nie powiela zapisu. Kopia tylko do odczytu odmawia zapisów; częściowo zainstalowany moduł odmawia operacji.';
      document.responses['503'] = { description: 'Moduł nie jest dostępny lub jego schemat jest niekompletny.' };
      if (o.method === 'POST') {
        document.responses['201'] = { description: 'Nowy podgląd lub wynik; dokładne retry zwraca 200 z reused=true.' };
        document.responses['423'] = { description: 'Kopia wyłącznie do odczytu.' };
        document.responses['409'] = { description: 'Konflikt wersji, przypisań lub niezmiennej próby.' };
      }
    }
    if (/^\/b2b\/network\/links\/[^/]+\/catalog\/[^/]+\/bind$/.test(o.path)) {
      const document = paths[path][o.method.toLowerCase()];
      document['x-required-scopes'] = ['products:read','products:write','purchasing:read','purchasing:write'];
      document.description = 'Jawne powiązanie istniejącego aktywnego produktu prostego lub wariantu we własnym docelowym katalogu B2B. client_key trwale wiąże aktora, klucz API, ścieżkę i pełną treść; dokładne ponowienie zwraca ten sam wynik przed kontrolą bieżącej oferty lub CAS. Nie tworzy zapasu ani zamówienia. Serwis po flush i odczycie wyniku blokuje bieżący IAM przed COMMIT.';
      document.responses['201'] = { description: 'Nowe trwałe powiązanie; reused=false.' };
      document.responses['200'] = { description: 'Dokładne ponowienie; reused=true.' };
      document.responses['409'] = { description: 'Nieaktualna oferta, wersja lub inna treść/zleceniodawca zachowanej próby.' };
      document.responses['423'] = { description: 'Kopia tylko do odczytu odmawia przed parsowaniem body.' };
      document.responses['503'] = { description: 'Niepełny lub nieobecny moduł zakresów B2B.' };
    }
    if (/^\/b2b\/(?:accounts\/[^/]+\/catalog-scope|network\/links\/[^/]+\/catalog-scope|catalog-scope\/)/.test(o.path)) {
      const document = paths[path][o.method.toLowerCase()];
      const writing = o.method !== 'GET', supplier = o.path.startsWith('/b2b/accounts/'), buyer = o.path.startsWith('/b2b/network/links/');
      document['x-required-scopes'] = ['products:read', ...(writing ? ['products:write'] : []),
        ...(supplier && writing ? ['inventory:read'] : []), ...(buyer ? ['purchasing:read', ...(writing ? ['purchasing:write'] : [])] : [])];
      if (!supplier && !buyer) document['x-kind-required-scopes'] = { supplier: writing ? ['inventory:read'] : [], buyer: ['purchasing:read', ...(writing ? ['purchasing:write'] : [])] };
      document['x-b2b-catalog-scope-limits'] = b2bCatalogScopeSchemas.B2B_CATALOG_SCOPE_LIMITS;
      document.description = 'Pierwsza jawna konfiguracja własnego katalogu B2B. Dostawca wybiera przypisany magazyn, cennik i język; odbiorca wybiera własny katalog docelowy, a tożsamość dostawcy pochodzi z persisted linku. Nie uruchamia publikacji, odświeżenia, importu, zamówienia ani providera. Zapis wymaga bieżącego administratora, osobnego preview/confirmed i actor/API-key/body-bound client_key; przed COMMIT serwis ponownie blokuje aktualny IAM. Dla preview/operation rodzaj dowodu określa dodatkowe wymagane scopes. SKU pozostaje unikalne w firmie; per-catalog polityki i pełne Base Connect pozostają OPEN.';
      document.responses['404'] = { description: 'Brak własnego źródła lub dowodu.' };
      document.responses['503'] = { description: 'Zakres B2B nie jest zainstalowany lub jego bounded manifest jest niekompletny.' };
      if (writing) {
        document.responses['201'] = { description: 'Nowy preview lub atomic operation; dokładne ponowienie zwraca200 i reused=true.' };
        document.responses['200'] = { description: 'Dokładne ponowienie zapisanej operacji po bieżącej autoryzacji.' };
        document.responses['423'] = { description: 'Odtworzona kopia odmawia zapisu przed parsowaniem body.' };
      }
      if (o.path.endsWith('/history')) {
        document.parameters.push({ in: 'query', name: 'kind', schema: { type: 'string', enum: ['preview', 'operation'], default: 'preview' } },
          { in: 'query', name: 'cursor', schema: { type: 'string', format: 'uuid' } },
          { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 50, default: 50 } });
      }
    }
    if (catalogFileImport) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Import CSV z mapowaniem kolumn, strukturalnego XML eksportu DYNAMINDS lub XML z jawnym xml_mapping. ' +
        'xml_mapping określa absolutny record_path oraz względne ścieżki pól, w tym końcowe @attribute; ' +
        'ścieżki używają dosłownych nazw i prefiksów, bez wyrażeń XPath, wildcardów ani pobierania adresu feedu. ' +
        'Typy wartości: text, integer, decimal_money (dokładna kwota z kropką i do dwóch cyfr ułamkowych → minor units), boolean (true/false). ' +
        'Pominięte pola XML pozostają bez zmian; wieloznaczna ścieżka odrzuca plik. ' +
        'Mapowany XML nie dopuszcza inventory_json/prices_json/variants_json/translations_json, także przy ignore_readonly_fields. ' +
        'Aktualna waluta firmy, bez konwersji; price_minor jest całkowitą liczbą najmniejszych jednostek. ' +
        'Identyfikacja id/sku/ean/name, tryb create/update/upsert, pominięte pola pozostają bez zmian. ' +
        'Puste wartości wymagają jawnej polityki skip/clear. Podgląd zapisuje niezmienny zakres, ' +
        'wyniki before/after i błędy, do 100 wierszy na stronę. Wykonanie wymaga scope_hash i confirmed=true, ' +
        'jest atomowe oraz kontroluje aktualne wersje, zależności, reguły i uprawnienia. ' +
        'client_key identyfikuje niezmienne żądanie aktora; retry nie powiela zapisu. ' +
        'Stany, cenniki, wersje językowe i lista wariantów wymagają odrębnych procesów; ' +
        'obecność tych pól wymaga jawnego ignore_readonly_fields. Nowe produkty mają stan zero. ' +
        'Odczyt historii jest dostępny dla admin/operator/viewer z products:read. ' +
        'Podgląd i wykonanie wymagają aktualnego admina oraz products:read/products:write; ' +
        'obie operacje są zablokowane w kopii tylko do odczytu.';
      document['x-required-scopes'] =
        o.method === 'GET' ? ['products:read'] : ['products:read', 'products:write'];
      document['x-catalog-file-import-limits'] = CATALOG_FILE_IMPORT_LIMITS;
      document.responses['503'] = { description: 'Kopia nie zawiera schematu importów CSV/XML.' };
      if (o.method === 'POST') {
        document.responses['201'] = {
          description: 'Nowy podgląd lub wynik; dokładne retry zwraca 200 z reused=true.',
        };
        document.responses['423'] = { description: 'Kopia wyłącznie do odczytu.' };
        document.responses['429'] = {
          description: 'Limit częstości żądań importu.',
        };
        document.responses['409'] = {
          description:
            'Zmiana danych, zależności lub reguł po podglądzie; konflikt klucza próby albo limit trwałej historii firmy.',
        };
      }
    }
    if(o.path.startsWith('/b2b-invoices/')) {
      const document=paths[path][o.method.toLowerCase()];
      document.description='Pełna lokalna numerowana FV B2B PL/PLN ze zużyciem autentycznego approved_project158. Osobna zgoda, wspólny namespace sprzedawcyNIP/prefix i immutable receipt; nie jest potwierdzeniem wysyłki/akceptacji KSeF ani UPO. Wyłącznie zwykłe stawki0/5/8/23 i zerowe różnice mapowania XML. Korekty/szczególne procedury wymagają odrębnego procesu.';
      document['x-required-scopes']=o.method==='GET'?['documents:read','orders:read']:['documents:read','documents:write','orders:read'];
      document['x-ksef-state']='not_submitted';document['x-strict-query']=true;
      document.responses['503']={description:'Niepełny moduł lub certyfikat dokładnego upgrade158→159.'};
      document.responses['409']={description:'Zmiana źródła, zgody, namespace, wyczerpanie numeracji lub już zużyty projekt.'};
      if(o.method!=='GET')document.responses['423']={description:'Kopia tylko do odczytu — odmowa przed parse.'};
      if(o.method==='GET'){const query=z.toJSONSchema(o.path==='/b2b-invoices/documents'?b2bInvoiceSchemas.b2bInvoicePageQuery:z.strictObject({}),{io:'input',unrepresentable:'any'}) as any;for(const[name,schema]of Object.entries(query.properties??{}))parameters.push({in:'query',name,required:false,schema});}
    }
    if(o.path==='/b2b-invoices/documents/:id/fa3.xml') {
      const document=paths[path][o.method.toLowerCase()];
      document.description='Pobranie XML FA (3)/1-0E z autentycznej numerowanej FV159 i niezmiennego fiscal_snapshot. Zachowuje historyczny numer/kwoty, a DataWytworzeniaFa pochodzi z utrwalonego created_at (UTC, pełna precyzja). documents:read i orders:read oraz aktualna natywna tożsamość są wymagane także w kopii read-only. Bez wystawienia, nowej numeracji, wysyłki KSeF lub UPO.';
      document.responses['200']={description:'Dokładny deterministyczny XML FA(3); pobranie bez zapisu.',content:{'application/xml':{schema:{type:'string'}}},headers:{'Content-Disposition':{schema:{type:'string'},description:'attachment; bezpieczna nazwa z natywnego numeru FV'},'Cache-Control':{schema:{type:'string',enum:['no-store']}},'X-Content-Type-Options':{schema:{type:'string',enum:['nosniff']}}}};
      document.responses['422']={description:'Niepełna lub nieobsługiwana migawka albo utrwalony czas poza zakresem FA(3).'};
      document.responses['413']={description:'Pełny XML przekracza1000000 bajtów UTF8; brak obcięcia.'};
      document['x-fa3-schema']='FA (3)/1-0E';document['x-fa3-generated-at']='immutable document.created_at';document['x-read-only-compatible']=true;
    }
    if(o.path.startsWith('/b2b-corrections/')) {
      const document=paths[path][o.method.toLowerCase()];
      document.description='Lokalna numerowana korekta B2B PL/PLN do autentycznej FV159 i pełnego fizycznego przyjęcia169. Osobna zgoda, immutable receipt i narastający łańcuch własnych korekt160; nie jest potwierdzeniem przelewu, wysyłki/akceptacji KSeF ani UPO. Brak fizycznego receipt, exchange, partner i procedury szczególne wymagają odrębnego procesu.';
      document['x-required-scopes']=o.method==='GET'?['documents:read','orders:read']:['documents:read','documents:write','orders:read'];
      document['x-ksef-state']='not_submitted';document['x-strict-query']=true;
      document.responses['503']={description:'Niepełny moduł lub certyfikat dokładnego upgrade157/158/159→160.'};
      document.responses['409']={description:'Zmiana pełnej historii, zgody, kolejności korekt lub namespace/numeracji.'};
      if(o.method!=='GET')document.responses['423']={description:'Kopia tylko do odczytu — odmowa przed parse.'};
      if(o.method==='GET'){const query=z.toJSONSchema(o.path==='/b2b-corrections/documents'?b2bCreditSchemas.b2bCreditPageQuery:z.strictObject({}),{io:'input',unrepresentable:'any'}) as any;for(const[name,schema]of Object.entries(query.properties??{}))parameters.push({in:'query',name,required:false,schema});}
      applyB2bCreditOpenApiContract(document,o.method,o.path);
    }
    if(o.path.startsWith('/b2b-fa3/')) {
      const document=paths[path][o.method.toLowerCase()];
      document.description='Niezmienny zatwierdzony projekt B2B PL/PLN, zwykłe stawki0/5/8/23; jawny ordinary bill-to albo prawdziwy supplier108 snapshot. Nie jest wystawioną FV, nie nadaje numeru FV, nie wysyła KSeF/UPO. Portal checkout i szczególne procedury wymagają odrębnego procesu.';
      document['x-required-scopes']=o.method==='GET'?['documents:read','orders:read']:['documents:read','documents:write','orders:read'];
      document['x-project-only']=true;document['x-strict-query']=true;
      document.responses['503']={description:'Brak lub uszkodzony moduł/native metadata; genuine absence options available=false.'};
      document.responses['409']={description:'Źródło, zgoda, cursor lub próba zmieniły się; istniejący dokument/projekt.'};
      if(o.method!=='GET')document.responses['423']={description:'Kopia tylko do odczytu — odmowa przed parsowaniem.'};
      if(o.method==='GET'){const query=z.toJSONSchema(o.path==='/b2b-fa3/projects'?fa3DraftSchemas.fa3DraftPageQuery:z.strictObject({}),{io:'input',unrepresentable:'any'}) as any;
       for(const[name,schema]of Object.entries(query.properties??{}))parameters.push({in:'query',name,required:false,schema});}
    }
    if (o.path.startsWith('/local-consumer-credits/')) {
      const document=paths[path][o.method.toLowerCase()];
      document.description='Lokalna numerowana korekta konsumencka PL/PLN zwykły VAT, immutable FV157 i pełny oryginalny ciąg fizycznych przyjęć RMA/Asystenta. Podgląd bez numeru, osobna zgoda, oryginalny client_key, atomowy licznik i linked receipt. Ilościowa korekta 0 zł jest obsługiwana. Bez KSeF, fiskalizacji lub wykonania refundu. Wymiany i zwroty wyłącznie finansowe poza zakresem.';
      document['x-required-scopes']=o.method==='GET'?['documents:read','orders:read']:['documents:read','documents:write','orders:read'];
      document['x-local-consumer-credit-limits']=consumerCreditSchemas.LOCAL_CONSUMER_CREDIT_LIMITS;
      if(o.method!=='GET')document.responses['423']={description:'Kopia tylko do odczytu; odmowa przed parsowaniem.'};
      if(o.method==='GET'){const query=o.path.endsWith('/source')?z.strictObject({return_id:consumerCreditSchemas.creditUuid.optional()}):o.path.includes('/commands/')?z.strictObject({operation:z.enum(['preview','issue'])}):o.path==='/local-consumer-credits/documents'?consumerCreditSchemas.localConsumerCreditPageQuery:z.strictObject({});const schema=z.toJSONSchema(query,{io:'input',unrepresentable:'any'}) as any;for(const[name,property]of Object.entries(schema.properties??{}))parameters.push({in:'query',name,required:(schema.required??[]).includes(name),schema:property});document['x-strict-query']=true;}
    }
    if (o.path.startsWith('/local-invoices/')) {
      const document=paths[path][o.method.toLowerCase()];
      document.description='Lokalna numerowana FV dla jawnie potwierdzonego konsumenta PL/PLN, zwykła krajowa sprzedaż VAT0/5/8/23 z wysłanego/dostarczonego zamówienia. Pełny historyczny podgląd bez numeru, osobna zgoda i immutable receipt. B2B, szczególne procedury, faktury zaliczkowe, korekty i fiskalny paragon nie są obsługiwane. Brak wysyłki KSeF, numeru KSeF/UPO lub fiskalizacji. Osobne jawne dane nabywcy i data sprzedaży; źródłowe grosze i zaokrąglenie pozycji są zachowane.';
      document['x-required-scopes']=o.method==='GET'?['documents:read','orders:read']:['documents:read','documents:write','orders:read'];
      document['x-local-invoice-limits']=localInvoiceSchemas.LOCAL_INVOICE_LIMITS;
      document.responses['503']={description:'Nieobecny lub uszkodzony moduł FV; genuine absence options available=false.'};
      document.responses['409']={description:'Zmiana źródła, konflikt zgody/próby, istniejąca faktura lub wyczerpanie numeracji.'};
      if(o.method!=='GET')document.responses['423']={description:'Kopia tylko do odczytu — odmowa przed parsowaniem.'};
      if(o.method==='GET') {
        const query=z.toJSONSchema(['/local-invoices/series','/local-invoices/documents'].includes(o.path)?localInvoiceSchemas.localInvoicePageQuery:z.strictObject({}),{io:'input',unrepresentable:'any'}) as any;
        for(const[name,schema]of Object.entries(query.properties??{}))parameters.push({in:'query',name,required:false,schema});
        document['x-strict-query']=true;
      }
    }
    if (o.path.startsWith('/proformas/')) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Lokalne proformy ze stałymi danymi sprzedawcy i historycznymi pozycjami zamówienia. Podgląd nie rezerwuje numeru. Wystawienie wymaga aktualnego scope_hash, confirmed=true, local_only=true i trwałego client_key. Numer PREFIX/YYYY/000001 nadawany atomowo przy zapisie; dokładne ponowienie nie tworzy drugiego dokumentu. Serię dodaje administrator; proformę wystawia administrator lub operator. Nie zapisuje wpłaty ani wydania towaru. B2B wymaga osobnego procesu bill-to i nie jest obsługiwane przez ten kontrakt.';
      document['x-required-scopes'] =
        o.method === 'GET'
          ? ['documents:read', 'orders:read']
          : ['documents:read', 'documents:write', 'orders:read'];
      document['x-proforma-limits'] = proformaSchemas.PROFORMA_LIMITS;
      if (o.path.startsWith('/proformas/batches/')) {
        document.description =
          'Masowe lokalne proformy dla 1–50 jawnie wskazanych zamówień i ich wersji. Jedna seria i stawka VAT dostawy, pełne historyczne pozycje oraz sumy osobno dla każdej waluty. Podgląd nie zużywa numerów. Osobna zgoda wystawia całą partię w jednej transakcji; zmiana jednego zamówienia cofa wszystkie dokumenty i numery. Dokładne ponowienie zachowanego żądania zwraca tę samą partię. Podglądy dzieci nie mogą być wystawiane osobno. Historia i wyniki są trwałe, bez automatycznego ponawiania lub wysyłki.';
        document['x-proforma-batch-limits'] = proformaBatchSchemas.PROFORMA_BATCH_LIMITS;
      }
      document.responses['503'] = { description: 'Moduł proform niedostępny w kopii.' };
      if (o.method !== 'GET') {
        document.responses['423'] = { description: 'Kopia wyłącznie do odczytu.' };
        document.responses['409'] = {
          description:
            'Podgląd wygasł, zmieniło się zamówienie, dokument już istnieje albo klucz próby jest użyty z innymi danymi.',
        };
      }
    }
    if (supplierRemoteFeed) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Feed hurtowni HTTPS: zaszyfrowana konfiguracja URL i write-only danych dostępu, wersjonowanie CAS i dokładne retry client_key. ' +
        'Pobranie jest trwałym zadaniem GET z przypiętym publicznym adresem IP, kontrolą TLS i limitami pliku; bez przekierowań. ' +
        'Ręczne pobranie tworzy pełny podgląd CSV/XML, publikacja wymaga osobnego potwierdzenia. ' +
        'Harmonogram zachowuje aktualne prawa autora i klucza API, domyślnie nie publikuje. ' +
        'Publikacja pełnego snapshotu wymaga polityki wycofania i spełnienia progów; przekroczenie pozostawia podgląd do zgody. ' +
        'Kopia tylko do odczytu blokuje konfigurację, kolejkę i harmonogram przed parsowaniem żądania.';
      document['x-required-scopes'] =
        o.method === 'GET' ? ['purchasing:read'] : ['purchasing:read', 'purchasing:write'];
      document['x-supplier-remote-feed-limits'] = supplierRemoteSchemas.SUPPLIER_REMOTE_FEED_LIMITS;
      document.responses['503'] = { description: 'Moduł feedów niedostępny lub niekompletny.' };
      if (o.method !== 'GET') {
        document.responses['423'] = { description: 'Kopia wyłącznie do odczytu.' };
        document.responses['409'] = {
          description: 'Konflikt wersji/klucza próby lub aktywne pobranie źródła.',
        };
        document.responses['429'] = { description: 'Limit kolejki, historii lub dowodów.' };
      }
    }
    if (/^\/returns\/:id\/exchange(?:-preview)?$/.test(o.path)) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Bezpłatna wymiana tego samego produktu po lokalnej reklamacji. Pełny podgląd jest osobnym krokiem; wykonanie wymaga aktualnego scope_hash, confirmed=true i trwałego client_key. ' +
        'Przyjęcie i rezerwacja zamiennika są atomowe. Zamiennik ma fulfillment_kind=replacement, zerowe kwoty i osobny proces kompletacji/wysyłki; nie tworzy nowej sprzedaży, płatności ani faktury. ' +
        'Wymagany aktualny administrator. Zewnętrzne/B2B powiązania, zwrot kosztu dostawy i zmieniona receptura wymagają odrębnego procesu.';
      document['x-required-scopes'] = [
        'orders:read',
        'orders:write',
        'inventory:read',
        'inventory:write',
        'purchasing:write',
      ];
      document.responses['409'] = {
        description:
          'Zmiana zakresu lub zapasu, niedozwolony proces albo konflikt klucza; cały zapis wycofany.',
      };
      document.responses['503'] = { description: 'Moduł wymiany niedostępny lub niekompletny.' };
      document.responses['423'] = { description: 'Kopia wyłącznie do odczytu.' };
    }
    if (supplierFileSource) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Trwałe ręczne źródło hurtowni CSV lub mapowanego XML: wersjonowany profil, zaszyfrowany plik UTF-8 i SHA256, pełny podgląd dostępności i kosztu NET w walucie źródła. ' +
        'Do500 wierszy/2MiB, literalne ścieżki XML bez XPath, dokładne kwoty; brak lub niepoprawna wartość blokuje całą partię. ' +
        'Delta zachowuje pominięte pozycje. Pełny snapshot może wycofać brakujące pozycje wyłącznie po confirm_missing=true. ' +
        'Zapis wymaga confirm_rows i aktualnych wersji źródła oraz pozycji. client_key wiąże dokładne żądanie i aktora; retry nie powiela zapisu. ' +
        'Dostępność hurtowni nie zmienia własnych zapasów, produktów ani cen sprzedaży; powiązanie produktu i zakup/PZ są osobnymi procesami. ' +
        'Brak pobierania URL, uwierzytelnienia dostawcy lub harmonogramu w tym kontrakcie. Bieżące scopes zakupów oraz administrator dla zapisu, odczyt także operator/viewer; kopia readonly blokuje zapis.';
      document['x-required-scopes'] =
        o.method === 'GET' ? ['purchasing:read'] : ['purchasing:read', 'purchasing:write'];
      document['x-supplier-file-source-limits'] = supplierFileSchemas.SUPPLIER_FILE_SOURCE_LIMITS;
      document.responses['503'] = { description: 'Brak schematu źródeł plikowych w kopii.' };
      if (o.method !== 'GET') {
        document.responses['423'] = { description: 'Kopia wyłącznie do odczytu.' };
        document.responses['409'] = {
          description:
            'Zmiana profilu/pozycji, konflikt klucza próby albo limit historii; całość wycofana.',
        };
        document.responses['413'] = {
          description: 'Przekroczony pełny limit pliku lub zakresu źródła.',
        };
      }
    }
    if (priceFileImport) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Import cen CSV z mapowaniem kolumn lub natywnego XML do jednego jawnie wybranego cennika. ' +
        'Identyfikacja istniejącego produktu przez UUID, SKU, historyczne SKU, EAN lub nazwę; brak, wieloznaczność i duplikaty blokują całą partię. ' +
        'Kwoty minor lub dziesiętne są parsowane dokładnie; netto przelicza zamrożony VAT, bez FX. ' +
        'Puste wartości wymagają polityki skip/remove. Natywne own_entries odtwarza własne wpisy wybranej listy, a nie jej ceny efektywne. ' +
        'Pełny trwały podgląd obejmuje źródło, dopasowanie i before/after; strony po50 wierszy. ' +
        'Zapis atomowy wymaga confirmed=true i scope_hash; brak ceny po zapisie wymaga ack_missing_prices. ' +
        'Zmiana wersji produktu/listy, VAT, cen lub repricingu po podglądzie daje409. ' +
        'Dokładne retry client_key nie powiela efektów. Profile mapowania wymagają jawnego zastosowania i version CAS przy edycji. ' +
        'Odczyt wymaga products:read; wszystkie zapisy wymagają products:read/products:write i aktualnego administratora, także po oczekiwaniu na blokady. ' +
        'Kopia tylko do odczytu odmawia zapisów przed parsowaniem. Import nie publikuje cen ani nie zmienia stanów, cen bazowych lub istniejących zamówień.';
      document['x-required-scopes'] =
        o.method === 'GET' ? ['products:read'] : ['products:read', 'products:write'];
      document['x-price-file-import-limits'] = priceFileImportSchemas.PRICE_FILE_IMPORT_LIMITS;
      document.responses['503'] = { description: 'Brak kompletnego schematu importu cen z pliku.' };
      if (o.method !== 'GET') {
        document.responses['423'] = { description: 'Kopia wyłącznie do odczytu.' };
        document.responses['413'] = {
          description: 'Przekroczony limit rozmiaru pliku, żądania lub dowodów.',
        };
        document.responses['409'] = {
          description:
            'Nieaktualny podgląd/version, konflikt klucza retry, niepoprawna partia lub limit historii.',
        };
        if (o.method === 'POST')
          document.responses['201'] = {
            description: 'Nowy podgląd, profil lub wynik; dokładne retry zwraca200 z reused=true.',
          };
      }
    }
    if (languageFileImport) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Import nazw i opisów istniejących produktów z CSV lub natywnego XML do 1–6 jawnie wybranych języków. ' +
        'Pełny podgląd do500 produktów/3000 par, strony po50; jeden atomowy zapis z bieżącą kontrolą wersji i uprawnień. ' +
        'confirmed=true, scope_hash i dokładne ack_missing_locale_codes wiążą zgodę. ' +
        'Klucz retry jest przypisany do firmy, aktora, klucza API, treści i rodzica; replay nie powiela zmian. ' +
        'Profile mają wersje CAS. Zapis wymaga administratora oraz products:read/products:write; restore odmawia przed parserem.';
      document['x-required-scopes'] =
        o.method === 'GET' ? ['products:read'] : ['products:read', 'products:write'];
      document['x-language-file-import-limits'] =
        languageFileImportSchemas.LANGUAGE_FILE_IMPORT_LIMITS;
      document.responses['403'] = { description: 'Brak aktualnych uprawnień.' };
      document.responses['503'] = { description: 'Niekompletny moduł importu tłumaczeń.' };
      if (o.method !== 'GET') {
        document.responses['423'] = { description: 'Kopia wyłącznie do odczytu.' };
        document.responses['413'] = {
          description: 'Przekroczony limit rozmiaru pliku lub dowodów.',
        };
        document.responses['409'] = {
          description: 'Konflikt wersji, zakresu lub klucza retry; całość wycofana.',
        };
        document.responses['422'] = {
          description: 'Niepoprawne mapowanie lub zestaw potwierdzeń.',
        };
      }
    }
    if (stockFileImport) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Import absolutnych stanów fizycznych CSV/natywny XML do 1–8 własnych magazynów w jednej transakcji. ' +
        'Mapowania pozycji lub pełnych sum magazynowych wymagają jawnego rozdzielenia lokalizacji i partii. ' +
        'Podgląd bez ruchów zapasu; confirmed=true i scope_hash wiążą wszystkie magazyny. ' +
        'ACK obejmują dokładnie magazyny z ubytkiem nieznanej wartości i nadwyżką. ' +
        'Bieżące produkty, rezerwacje, partie, polityka wyceny i IAM są sprawdzane przed zatwierdzeniem. ' +
        'ON rozlicza rzeczywiste spisy partii, OFF operacje ilościowe; dokładne retry nie powiela efektów. ' +
        'Odczyt ilościowy usuwa koszty i surowe komórki. Zapis wymaga administratora; restore odmawia przed parserem.';
      document['x-required-scopes'] =
        o.method === 'GET'
          ? ['products:read', 'inventory:read']
          : ['products:read', 'inventory:read', 'inventory:write'];
      document['x-conditional-scopes'] = {
        valuation_enabled: ['purchasing:read', 'purchasing:write'],
      };
      document['x-stock-file-import-limits'] = stockFileImportSchemas.STOCK_FILE_IMPORT_LIMITS;
      document.responses['403'] = { description: 'Brak bieżącej roli lub wymaganych uprawnień.' };
      document.responses['503'] = { description: 'Brak kompletnego schematu importu stanów.' };
      if (o.method !== 'GET') {
        document.responses['423'] = { description: 'Kopia wyłącznie do odczytu.' };
        document.responses['413'] = {
          description: 'Przekroczony limit pliku, żądania lub dowodów.',
        };
        document.responses['409'] = {
          description:
            'Nieaktualny podgląd, konflikt zakresu/wersji/klucza wykonania; całość wycofana.',
        };
        document.responses['422'] = {
          description: 'Niepoprawne mapowanie, dane lub zestaw potwierdzeń.',
        };
      }
    }
    if (paymentAllocation) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Jawny lokalny podział jednego wiersza importu bankowego lub COD na wiele własnych zamówień/przesyłek. ' +
        'Oddzielny zamrożony podgląd i potwierdzenie scope_hash. Kwota i prowizja nieprzydzielona pozostają dostępne dla kolejnej rundy z source_version CAS. ' +
        'Wspólna tożsamość ekonomiczna ze zwykłym importem chroni przed ponownym księgowaniem. ' +
        'Aktualny administrator oraz obydwa scopes orders:read/orders:write także przy odczycie dowodów. ' +
        'Nie wykonuje operacji bankowej ani nie potwierdza autentyczności pliku u banku lub przewoźnika.';
      document['x-required-scopes'] = ['orders:read', 'orders:write'];
      document['x-payment-allocation-limits'] =
        paymentAllocationSchemas.PAYMENT_IMPORT_ALLOCATION_LIMITS;
      document.responses['503'] = { description: 'Brak kompletnego schematu podziału wpłat.' };
      document.responses['409'] = {
        description:
          'Źródło, saldo, podgląd lub zakres zgody zmieniły się; brak częściowego księgowania.',
      };
      if (o.method !== 'GET')
        document.responses['423'] = { description: 'Kopia wyłącznie do odczytu.' };
    }
    if (priceMatrixImport) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Atomowy import macierzy cen do 2–8 jawnie wybranych własnych cenników z CSV lub natywnego XML. ' +
        'Wspólna identyfikacja istniejących produktów i osobne mapowania/waluty/netto/brutto/puste wartości dla każdej listy. ' +
        'Jeden pełny podgląd produktów i komórek wszystkich list; strony po50produktów. ' +
        'confirmed=true i scope_hash wiążą całą macierz, ack_missing_price_list_ids potwierdza dokładnie listy bez ceny po zmianie. ' +
        'Zmiana choć jednej listy/produktu/VAT/repricingu lub cofnięcie dostępu wycofuje wszystkie zapisy i dowody. ' +
        'Dokładne retry nie powiela efektów; mapowania profili wymagają jawnego zastosowania i CAS. ' +
        'Każdy zapis wymaga bieżącego administratora oraz products:read/products:write także po blokadach. ' +
        'Kopia tylko do odczytu odmawia zapisu przed parserem. Import nie zmienia stanów, cen bazowych, zamówień ani nie publikuje cen.';
      document['x-required-scopes'] =
        o.method === 'GET' ? ['products:read'] : ['products:read', 'products:write'];
      document['x-price-matrix-import-limits'] =
        priceMatrixImportSchemas.PRICE_MATRIX_IMPORT_LIMITS;
      document.responses['503'] = {
        description: 'Brak kompletnego schematu importu macierzy cen.',
      };
      if (o.method !== 'GET') {
        document.responses['423'] = { description: 'Kopia wyłącznie do odczytu.' };
        document.responses['413'] = {
          description: 'Przekroczony limit rozmiaru pliku, żądania lub dowodów.',
        };
        document.responses['409'] = {
          description:
            'Nieaktualny podgląd/version, konflikt klucza retry lub niepoprawna cała macierz.',
        };
        document.responses['429'] = {
          description: 'Limit częstości żądań, profili lub trwałej historii macierzy.',
        };
        if (o.method === 'POST')
          document.responses['201'] = {
            description: 'Nowy podgląd, profil lub wynik; dokładne retry zwraca200 z reused=true.',
          };
      }
    }
    if (o.path.startsWith('/catalog/export-profiles')) {
      const document = paths[path][o.method.toLowerCase()];
      document.description =
        'Zapisana konfiguracja eksportu firmy: format CSV/XML, uporządkowane klucze columns, headers i spreadsheet_safe oraz opcjonalny definition.catalog_id. Bez zaznaczenia produktów, filtrów ani dostępu do dostawców. Profil nie zapisuje catalog_version ani scope_hash; po skopiowaniu definicji trzeba odczytać świeży podgląd. Odczyt: products:read i admin/operator/viewer. Zapis: aktualny admin i obydwa scope products:read/products:write, niedostępny w readonly. Limit 200 obejmuje archiwum. Create client_key jest niezmiennym receipt aktora i początkowego żądania: retry zwraca bieżący profil z reused=true, także po edycji/archiwizacji, bez nowego zapisu. PATCH/archive/restore wymagają version CAS. Zastosowanie w interfejsie jest jawną kopią definicji; kolejne zmiany profilu nie zmieniają pobieranego pliku.';
      document['x-required-scopes'] =
        o.method === 'GET' ? ['products:read'] : ['products:read', 'products:write'];
      document.responses['409'] = {
        description:
          'Nieaktualna version, konflikt aktywnej nazwy lub client_key z innym żądaniem/aktorem.',
      };
      document.responses['503'] = {
        description: 'Ta kopia nie obsługuje migration096 i profili eksportu.',
      };
      if (o.method !== 'GET')
        document.responses['429'] = { description: 'Limit 200 profili, wliczając archiwum.' };
      if (o.method === 'POST' && o.path === '/catalog/export-profiles')
        document.responses['201'] = {
          description:
            'Nowy profil firmy. Retry istniejącego receipt zwraca200 zreused=true i bieżącą wersją profilu.',
        };
    }
    if (catalogExport) {
      const document = paths[path][o.method.toLowerCase()];
      const catalogSchema = {
        type: 'object', required: ['id', 'name', 'active', 'is_default', 'version', 'warehouse_ids', 'price_list_ids'],
        properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, active: { type: 'boolean' }, is_default: { type: 'boolean' }, version: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }, warehouse_ids: { type: 'array', items: { type: 'string', format: 'uuid' } }, price_list_ids: { type: 'array', items: { type: 'string', format: 'uuid' } } },
        additionalProperties: false,
      };
      document.description =
        (options.readOnly ? 'Dostępne także w kopii tylko do odczytu. ' : '') +
        'Wymagany aktualny scope products:read i własne członkostwo admin/operator/viewer. ' +
        'Lokalny odczyt bez zapisów biznesowych ani wywołań dostawców. Opcjonalny catalog_id wybiera aktywną pulę produktów i jej przypisania; brak zachowuje legacy odczyt wszystkich katalogów firmy. Zarchiwizowany katalog odmawia 409, częściowo zainstalowany moduł 503 bez przejścia do legacy. Cena bazowa brutto p.price w minor units, VAT p.vat w procentach i rzeczywista waluta firmy; Pole price_minor zachowuje cenę bazową; prices_json zawiera jawnie wybrane cenniki, ceny własne i reguły z walutą/źródłem/status, bez FX. inventory_json wymaga dodatkowego aktualnego inventory:read oraz jawnych warehouse_ids. Obie listy źródeł mają1–10 unikalnych UUID i są wymagane tylko dla odpowiadających pól. ' +
        (o.path.endsWith('/file')
          ? 'Jawny catalog_id wymaga catalog_version i scope_hash otrzymanych z POST preview; ich zgodność wiąże konfigurację katalogu, eksportu, filtrów i źródeł, nie zamraża wierszy ani count. Plik jest nowym snapshotem RR i może zawierać inną liczbę produktów niż próbka. Kompletny snapshot RR kodowany do prywatnego pliku przed świeżą kontrolą dostępu i wysłaniem danych. UTF-8 CSV lub strukturalny XML 1.0; nielegalne znaki XML odrzucane bez zamiany. Wszystkie wybrane wiersze, bez cichego obcięcia. Maksymalnie 100000 produktów, 500 zaznaczonych UUID, 64 MiB rzeczywistych bajtów pliku. Partie odczytu 100 produktów; równolegle do 3 eksportów i 1 na firmę. POST przyjmuje ten sam ścisły config z columns/ids jako tablicami i jest wyłącznie odczytem; body do 65536 bajtów. Błąd lub przerwanie pobierania nie stanowi gotowego eksportu.'
          : o.path.endsWith('/preview')
            ? 'catalog_id nie wymaga uprzedniej version/hash: podgląd zwraca bieżące catalog, catalog_version i scope_hash do osobnego żądania file. Próbka do3 produktów i dokładny zakres w jednym RR snapshot; brak zmian. Próbka i późniejszy plik są osobnymi aktualnymi odczytami; nie zamrażają wierszy/liczby produktów ani nie rezerwują zapasu lub cen.'
            : 'Opcje zawierają wspierane kolumny i ich jednostki, rzeczywistą catalog_currency, price_source=catalog, limity oraz bounded count. count.capped=true przy ponad 100000 wyników; matched_products jest wtedy wyłącznie dolnym ograniczeniem 100001. Nieznane pola query są odrzucane, ids wymagane wyłącznie dla selection=selected.');
      document['x-read-only-operation'] = true;
      document['x-catalog-export-limits'] = CATALOG_EXPORT_LIMITS;
      if (o.method === 'GET')
        document['x-query-schema'] = z.toJSONSchema(
          o.path.endsWith('/options') ? catalogExportOptionsQuery : catalogExportFileQuery,
          { io: 'input', unrepresentable: 'any' },
        );
      const exportRequestSchema = o.method === 'GET' ? document['x-query-schema'] : document.requestBody.content['application/json'].schema;
      if (o.path.endsWith('/file') || o.path.endsWith('/preview')) {
        exportRequestSchema.dependentRequired = { catalog_version: ['catalog_id', 'scope_hash'], scope_hash: ['catalog_id', 'catalog_version'] };
        if (o.path.endsWith('/file')) exportRequestSchema.allOf = [...(exportRequestSchema.allOf ?? []), { if: { required: ['catalog_id'] }, then: { required: ['catalog_version', 'scope_hash'] } }];
      }
      document.responses['409'] = { description: 'Katalog zarchiwizowany, nieaktualna wersja lub hash konfiguracji/źródeł/filtrów albo wybrany produkt lub źródło innego katalogu. Wymagany nowy podgląd; count i wiersze nie są zamrożone.' };
      document.responses['503'] = { description: 'Wybrany zakres katalogów lub źródeł nie jest obsługiwany albo instalacja jest niekompletna; brak fallback do innej puli.' };
      if (o.path.endsWith('/file')) {
        document.responses['200'] = {
          description:
            'Kompletny plik UTF-8; zawartość zależna od jawnej listy kolumn. CSV safe może dodać BOM/ochronne apostrofy; raw zachowuje tekst. XML obiekty/tablice jako entry/item, null jako nil=true.',
          headers: {
            'Content-Disposition': {
              description: 'Pobierz plik, bez ścieżki tymczasowej.',
              schema: {
                type: 'string',
                enum: ['attachment; filename="catalog.csv"', 'attachment; filename="catalog.xml"'],
              },
            },
            'Content-Length': {
              description: 'Dokładny rozmiar gotowego pliku w bajtach UTF-8.',
              schema: { type: 'integer', minimum: 1, maximum: CATALOG_EXPORT_LIMITS.file_bytes },
            },
            'X-Catalog-Export-Count': {
              schema: { type: 'integer', minimum: 0, maximum: CATALOG_EXPORT_LIMITS.products },
            },
            'X-Catalog-Currency': {
              description: 'Rzeczywista waluta firmy dla bazowej ceny p.price; bez konwersji.',
              schema: { type: 'string' },
            },
            'X-Product-Catalog-ID': { description: 'Obecny wyłącznie dla jawnego catalog_id, równy wybranemu katalogowi.', schema: { type: 'string', format: 'uuid' } },
            'X-Product-Catalog-Version': { description: 'Wersja konfiguracji potwierdzona przy pobraniu; równa catalog_version z podglądu.', schema: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' } },
            'X-Catalog-Export-Scope-Hash': { description: 'Potwierdzony hash konfiguracji katalogu, eksportu, filtrów i źródeł. Nie zamraża wierszy ani count.', schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
            'Cache-Control': { schema: { type: 'string', const: 'no-store' } },
            'X-Content-Type-Options': { schema: { type: 'string', const: 'nosniff' } },
          },
          content: {
            'text/csv': { schema: { type: 'string', format: 'binary' } },
            'application/xml': { schema: { type: 'string', format: 'binary' } },
          },
        };
        document.responses['400'] = { description: 'Nieprawidłowy JSON lub żądanie HTTP.' };
        document.responses['413'] = {
          description:
            'Body przekracza 65536 bajtów lub kompletny kodowany plik przekracza 64 MiB; brak gotowego pliku.',
        };
        document.responses['429'] = {
          description:
            'Równoległy eksport tej firmy lub wykorzystane 3 globalne sloty. Ponów po zakończeniu.',
        };
        document.responses['503'] = {
          description:
            'Prywatny katalog/pliki eksportu są niedostępne lub nie mają wymaganych praw; jawny katalog/źródła nieobsługiwane lub niekompletnie zainstalowane.',
        };
        document.responses['422'] = {
          description:
            'Nieznane/powtórzone kolumny lub UUID, niepełny selected scope (obcy/brakujący produkt), ponad 100000 produktów, nielegalny znak XML albo struktura głębsza niż 64 poziomy.',
        };
        if (o.method === 'POST')
          document.requestBody.description =
            'Ścisły JSON, bez dodatkowych kluczy. columns i ids są tablicami; selected wymaga ids, filtered nie przyjmuje ids. Jawny catalog_id wymaga catalog_version i scope_hash z POST preview. Bez products:write i bez skutków zapisu; dostępny także w readonly preview.';
      } else if (o.path.endsWith('/preview')) {
        document.requestBody.description = 'Ścisły config odczytu. catalog_id jest opcjonalny; pierwsza próbka nie wymaga catalog_version ani scope_hash. Zwrócone version/hash służą wyłącznie do późniejszego file i wiążą konfigurację, nie produkty.';
        document.responses['200'] = {
          description: 'Aktualna próbka do 3 produktów i count z jednego RR; dla jawnego katalogu także bieżące catalog/version/hash. Nie jest trwałym receipt ani rezerwacją wierszy.',
          content: { 'application/json': { schema: {
            type: 'object', required: ['count', 'catalog_currency', 'sample', 'sample_limit', 'read_only'],
            properties: {
              count: { type: 'object', required: ['matched_products', 'capped'], properties: { matched_products: { type: 'integer', minimum: 0, maximum: CATALOG_EXPORT_LIMITS.products }, capped: { const: false } }, additionalProperties: false },
              catalog_currency: { type: 'string' }, sample_limit: { const: 3 }, read_only: { const: true },
              sample: { type: 'array', maxItems: 3, items: { type: 'object', required: ['product_id', 'sku', 'name'], properties: { product_id: { type: 'string', format: 'uuid' }, sku: { type: 'string' }, name: { type: 'string' }, inventory_json: { type: 'array', items: { type: 'object' } }, prices_json: { type: 'array', items: { type: 'object' } } }, additionalProperties: false } },
              catalog: catalogSchema, catalog_version: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }, scope_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            }, dependentRequired: { catalog: ['catalog_version', 'scope_hash'], catalog_version: ['catalog', 'scope_hash'], scope_hash: ['catalog', 'catalog_version'] }, additionalProperties: false,
          } } },
        };
      } else
        document.responses['200'] = {
          description:
            'Opcje bieżącego własnego katalogu i bounded count; bez przygotowania pliku.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: [
                  'available',
                  'read_only',
                  'current_role',
                  'can_read',
                  'formats',
                  'columns',
                  'default_columns',
                  'defaults',
                  'limits',
                  'count',
                  'catalog_currency',
                  'price_source',
                  'product_logistics_available',
                  'product_translations_available',
                  'catalog_available',
                  'catalogs',
                  'catalog',
                  'sources',
                ],
                properties: {
                  available: { type: 'boolean', const: true },
                  read_only: { type: 'boolean' },
                  current_role: { type: 'string', enum: ['admin', 'operator', 'viewer'] },
                  can_read: { type: 'boolean', const: true },
                  formats: { type: 'array', items: { type: 'string', enum: ['csv', 'xml'] } },
                  columns: {
                    type: 'array',
                    maxItems: CATALOG_EXPORT_COLUMNS.length,
                    items: {
                      type: 'object',
                      required: ['key', 'label', 'type'],
                      properties: {
                        key: { type: 'string', enum: CATALOG_EXPORT_COLUMNS.map((c) => c.key) },
                        label: { type: 'string' },
                        type: { type: 'string', enum: ['text', 'integer', 'boolean', 'json'] },
                        unit: { type: 'string' },
                      },
                      additionalProperties: false,
                    },
                  },
                  default_columns: {
                    type: 'array',
                    items: { type: 'string', enum: CATALOG_EXPORT_COLUMNS.map((c) => c.key) },
                  },
                  defaults: {
                    type: 'object',
                    properties: {
                      format: { const: 'csv' },
                      selection: { const: 'filtered' },
                      active: { const: 'all' },
                      spreadsheet_safe: { const: true },
                    },
                  },
                  limits: {
                    type: 'object',
                    properties: Object.fromEntries(
                      Object.entries(CATALOG_EXPORT_LIMITS).map(([name, value]) => [
                        name,
                        { type: 'integer', const: value },
                      ]),
                    ),
                  },
                  count: {
                    type: 'object',
                    required: ['matched_products', 'capped'],
                    properties: {
                      matched_products: {
                        type: 'integer',
                        minimum: 0,
                        maximum: CATALOG_EXPORT_LIMITS.products + 1,
                      },
                      capped: { type: 'boolean' },
                    },
                    additionalProperties: false,
                  },
                  catalog_currency: { type: 'string' },
                  price_source: { type: 'string', const: 'catalog' },
                  product_logistics_available: { type: 'boolean' },
                  product_translations_available: { type: 'boolean' },
                  catalog_available: { type: 'boolean' },
                  catalogs: { type: 'array', maxItems: 100, items: catalogSchema },
                  catalog: { anyOf: [catalogSchema, { type: 'null' }] },
                  sources: { type: 'object' },
                },
                additionalProperties: false,
              },
            },
          },
        };
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'DYNAMINDS Ecommerce API',
      version: '1.0.0',
      description:
        'Lokalny kontrakt OMS/PIM/WMS. Kwoty w groszach; scope klucza jest przecięciem z bieżącą rolą jego właściciela. Dostawy webhooków: co najmniej raz, deduplikacja po delivery_id.',
    },
    servers: [
      {
        url: options.readOnly
          ? `http://localhost:${options.port ?? 4101}/api/v1`
          : 'http://127.0.0.1:4100/api/v1',
      },
    ],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    paths,
  };
}
export function collectPublicRoutes(app: FastifyInstance) {
  const collected = new Map<string, RouteOptions>();
  const childAliases = new Map<string, RouteOptions>();
  // onRoute plugins may mutate live options after this hook (rate-limit adds per-route hooks).
  // Keep the declared domain/parser identity before those inherited plugin transformations.
  const parserFacts = new Map<string, {
    child: FastifyInstance; handler: RouteOptions['handler']; hooks: unknown[];
    bodyLimit: number | undefined; declaredAlias: boolean;
  }>();
  app.addHook('onRoute', function (route) {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (publicOperations.some((o) => o.method === method && '/api' + o.path === route.url))
        collected.set(method + ' ' + route.url, route as RouteOptions);
      if (largeImportPublicOperations.some(o=>o.method===method&&'/api/v1'+o.path===route.url))
        childAliases.set(method+' '+route.url,route as RouteOptions);
      if (largeImportPublicOperations.some(o=>o.method===method&&
          ('/api'+o.path===route.url||'/api/v1'+o.path===route.url))) {
        parserFacts.set(method+' '+route.url,{
          child:this,handler:route.handler,
          hooks:Array.isArray(route.onRequest)?[...route.onRequest]:route.onRequest?[route.onRequest]:[],
          bodyLimit:route.bodyLimit,
          declaredAlias:(route.config as Record<string,unknown>|undefined)?.[LARGE_IMPORT_SAME_PARSER_ALIAS]===true,
        });
      }
    }
  });
  return () => {
    for (const o of publicOperations) {
      const route = collected.get(o.method + ' /api' + o.path);
      ensure(route, 500, 'Brak implementacji publicznej operacji ' + o.path);
      if(largeImportPublicOperations.some(d=>d.method===o.method&&d.path===o.path)){
        const alias=childAliases.get(o.method+' /api/v1'+o.path);
        const normalFact=parserFacts.get(o.method+' /api'+o.path),aliasFact=parserFacts.get(o.method+' /api/v1'+o.path);
        ensure(alias&&normalFact&&aliasFact&&normalFact.declaredAlias&&aliasFact.declaredAlias&&
          normalFact.child===aliasFact.child&&normalFact.handler===aliasFact.handler&&
          normalFact.bodyLimit===aliasFact.bodyLimit&&normalFact.hooks.length===aliasFact.hooks.length&&
          normalFact.hooks.every((hook,index)=>hook===aliasFact.hooks[index]),
          500,'Brak publicznego aliasu w tym samym parserze dużego importu');
        continue;
      }
      // Reuse the actual domain handler and hooks; no internal HTTP request or second auth context.
      app.route({ ...route, method: o.method as any, url: '/api/v1' + o.path });
    }
  };
}
export function registerDeveloperRoutes(
  app: FastifyInstance,
  options: { readOnly?: boolean; port?: number; crmKeyScopesAvailable?: boolean } = {},
) {
  const crmKeyScopes = options.crmKeyScopesAvailable === true;
  app.get('/api/v1/openapi', async () => publicApiDocument(options));
  app.get('/api/developer/openapi', async () => publicApiDocument(options));
  app.get('/api/developer/keys', async (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
    const data = (
      await pool.query(
        crmKeyScopes
          ? "SELECT k.id,k.name,k.prefix,k.scopes||coalesce((SELECT array_agg(s.scope ORDER BY s.scope) FROM base_wire218_key_scopes s WHERE s.tenant_id=k.tenant_id AND s.key_id=k.id),'{}'::text[]) AS scopes,k.expires_at,k.revoked_at,k.created_at,k.user_id FROM api_keys k WHERE k.tenant_id=$1 ORDER BY k.created_at DESC,k.id DESC LIMIT 100"
          : 'SELECT id,name,prefix,scopes,expires_at,revoked_at,created_at,user_id FROM api_keys WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',
        [req.actor.tenantId],
      )
    ).rows;
    return { data, scopes: crmKeyScopes ? apiScopes : apiScopes.filter((value) => !isCrmScope(value)) };
  });
  app.post('/api/developer/keys', async (req, reply) => {
    const b = developerKeyCreateInput.parse(req.body);
    const baseScopes = b.scopes.filter((value) => !isCrmScope(value)),
      crmGranted = b.scopes.filter(isCrmScope);
    ensure(crmKeyScopes || !crmGranted.length, 409, 'Base API CRM nie jest zainstalowane w tej bazie');
    const token = 'dyna_api_' + randomBytes(32).toString('hex'),
      id = randomUUID();
    const row = await authTx(async (c) => {
      await lockAdmin(c, req.actor);
      const count = Number(
        (
          await c.query(
            'SELECT count(*) FROM api_keys WHERE tenant_id=$1 AND revoked_at IS NULL AND expires_at>now()',
            [req.actor.tenantId],
          )
        ).rows[0].count,
      );
      ensure(count < 20, 409, 'Organizacja może mieć maksymalnie 20 aktywnych kluczy API');
      const r = (
        await c.query(
          'INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+make_interval(days=>$8)) RETURNING id,name,prefix,scopes,expires_at',
          [
            id,
            req.actor.tenantId,
            req.actor.userId,
            b.name,
            tokenHash(token),
            token.slice(0, 16),
            baseScopes,
            b.expires_days,
          ],
        )
      ).rows[0];
      if (crmGranted.length)
        await c.query(
          'INSERT INTO base_wire218_key_scopes(tenant_id,key_id,scope) SELECT $1,$2,unnest($3::text[])',
          [req.actor.tenantId, id, crmGranted],
        );
      r.scopes = [...r.scopes, ...crmGranted];
      await audit(c, req.actor, 'api_key.created', id, {
        name: b.name,
        scopes: b.scopes,
        expires_days: b.expires_days,
      });
      return r;
    });
    return reply.code(201).send({ ...row, token });
  });
  app.delete('/api/developer/keys/:id', async (req) => {
    const id = z.object({ id: z.uuid() }).parse(req.params).id;
    return authTx(async (c) => {
      await lockAdmin(c, req.actor);
      const r = await c.query(
        'UPDATE api_keys SET revoked_at=coalesce(revoked_at,now()) WHERE tenant_id=$1 AND id=$2 RETURNING id',
        [req.actor.tenantId, id],
      );
      ensure(r.rowCount, 404, 'Nie znaleziono klucza API');
      await audit(c, req.actor, 'api_key.revoked', id);
      return { ok: true };
    });
  });
}
