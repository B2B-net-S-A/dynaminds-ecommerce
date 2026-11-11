import { resolvePackedLabelsDue } from './packed-label-print';
import { scheduleProductRuleOccurrencesDue } from './product-rule-schedules';
import { stopAllegroOAuthCommitRefusal } from './channel-access';
import { processProductRuleJob, reapProductRuleJobs } from './product-rules';
import {
  REPLENISHMENT_AUTOMATION_JOB,
  processReplenishmentAutomation,
  failReplenishmentAutomation,
  reapReplenishmentAutomations,
} from './replenishment-automations';
import {
  ORDER_FIELD_MAPPING_JOB,
  processOrderFieldMappingJob,
  reapOrderFieldMappingJobs,
} from './order-field-mappings';
import {
  ORDER_FIELD_BATCH_JOB,
  processOrderFieldBatchJob,
  reapOrderFieldBatchJobs,
} from './order-field-batches';
import {
  PAYMENT_IMPORT_JOB,
  processPaymentImportJob,
  reapPaymentImportJobs,
} from './payment-imports';
import { renewBillingDue } from './workspace-billing';
import { processShopifySubscription, failShopifySubscription } from './shopify-subscriptions';
import { processTranslation, failTranslation } from './shopify-translations';
import { processShopifyFulfillment, failShopifyFulfillment } from './shopify-fulfillment';
import { processShopifyWebhook, failShopifyWebhook } from './shopify-webhooks';
import { processEmail, failEmail } from './email';
import { processAmazonFulfillment, failAmazonFulfillment } from './amazon-fulfillment';
import { deferAmazonApiJob } from './amazon-api-limits';
import { deferEbayApiJob } from './ebay-api-limits';
import {
  processEbayFulfillmentScan,
  failEbayFulfillmentScan,
  scheduleEbayFulfillmentsDue,
} from './ebay-fulfillment-schedules';
import { processEbayFulfillment, failEbayFulfillment } from './ebay-fulfillment';
import {
  processOdooCatalogSync,
  failOdooCatalogSync,
  scheduleOdooCatalogDue,
} from './odoo-catalog-sync';
import { processOdooExport, failOdooExport } from './odoo-exports';
import { processB2bCatalog, failB2bCatalog, scheduleB2bNetworkDue } from './b2b-network';
import { sweepB2bNetworkLifecycleDue } from './b2b-network-decisions';
import { scheduleDpdPickupsDue } from './dpd-pickup-schedules';
import { processRepricing, failRepricing, scheduleRepricingDue } from './repricing-schedules';
import { processSms, failSms } from './sms';
import { processSupplierRead, failSupplierRead } from './supplier-catalog';
import { processSupplierBulk, failSupplierBulk } from './supplier-bulk';
import { scheduleSuppliersDue } from './supplier-schedules';
import {
  SUPPLIER_REMOTE_FETCH_JOB,
  processSupplierRemoteFetch,
  failSupplierRemoteFetch,
  scheduleSupplierRemoteFeedsDue,
  reapSupplierRemoteFetches,
} from './supplier-remote-feeds';
import { processSchedule, failSchedule, scheduleAutomationsDue } from './automation-schedules';
import {
  processStatusWrite,
  processStatusScan,
  failStatusJob,
  scheduleStatusesDue,
} from './order-status';
import { dispatchAutomation, processAutomation, failAutomation } from './automations';
import { dispatchV2, processV2Run, failV2, scheduleV2TimeChecks } from './automation-v2';
import { scheduleV2StockChecks } from './automation-v2-stock';
import { SUPPLIER_ORDER_JOB, processSupplierOrderJob, failSupplierOrderJob } from './automation-v2-effects-supply';
import { processSourceRead, failSourceRead, scheduleSourcePaymentsDue } from './source-payments';
import { processBatch, failBatch } from './order-operations';
import { KSEF_STATUS_JOB, processKsefStatusJob } from './ksef229-jobs';
import { KSEF_PURCHASE_FETCH_JOB, processKsefPurchaseFetchJob } from './ksef243-jobs';
import { randomUUID } from 'node:crypto';
import { pool, tenantTx } from './db';
import { processIntegrationJob, scheduleDue } from './sync';
import { processInvoice, failInvoice } from './invoices';
import { processShipping, failShipping } from './shipping';
import { processDpd } from './dpd-shipping';
import { processDhl } from './dhl-shipping';
import { processPocztaPolska } from './pocztapolska-shipping';
import { DHL_PICKUP_JOB, processDhlPickup, failDhlPickup } from './dhl-pickups';
import { MIRAKL262_ORDERS_JOB, MIRAKL262_WRITE_JOB, processMirakl262Job, failMirakl262Job, sweepMirakl262Due } from './mirakl262';
import { CARRIER_RETURN_JOB, processCarrierReturn, failCarrierReturn } from './carrier-returns';
import { processCollection, failCollection } from './dpd-collections';
import { processTracking, failTracking, scheduleTrackingDue } from './tracking';
import { processVariantBatch, failVariantBatch } from './variant-offer-batches';
import { processOfferJob, failOffer } from './offers';
import { processCatalogSource, failCatalogSource } from './catalog-source';
import { processOfferSync, failOfferSync, scheduleOffersDue } from './offer-sync';
import type { IntegrationContext } from './channel-access';
import { Problem,ensure } from './errors';
import { processOutbound, failOutbound } from './outbound-webhooks';
import { scheduleInboundPollsDue } from './inbound-auto253';
import { createWorkerSupervisor, registerWorkerRuntime, type WorkerStep, type WorkerSupervisorOptions } from './worker-supervisor';
export type WorkerSelection={kind:'pricing.reprice'};
export async function tick(ctx: IntegrationContext = {},selection?:WorkerSelection) {
  const pricingOnly=selection!==undefined;
  ensure(!pricingOnly||(selection&&Object.keys(selection).join(',')==='kind'&&selection.kind==='pricing.reprice'),422,'Nieprawidłowy zakres lokalnego workera');
  if(!pricingOnly){
  await renewBillingDue();
  if (
    (await pool.query("SELECT to_regclass('public.replenishment_automation_runs') present")).rows[0]
      .present
  )
    await reapReplenishmentAutomations();
  // Reap before claiming: a failed recovery pass must not consume another job lease.
  if ((await pool.query("SELECT to_regclass('public.product_rule_runs') present")).rows[0].present)
    await reapProductRuleJobs();
  if (
    (await pool.query("SELECT to_regclass('public.payment_import_executions') present")).rows[0]
      .present
  )
    await reapPaymentImportJobs();
  if (
    (await pool.query("SELECT to_regclass('public.order_field_batch_executions') present")).rows[0]
      .present
  )
    await reapOrderFieldBatchJobs();
  if (
    (await pool.query("SELECT to_regclass('public.order_field_mapping_executions') present"))
      .rows[0].present
  )
    await reapOrderFieldMappingJobs();

  await reapSupplierRemoteFetches();
  }
  const c = await pool.connect();
  let job: any;
  let scopedClaimFailed=false,scopedRollbackFailed=false;
  try {
    await c.query('BEGIN');
    await c.query(
      "UPDATE jobs SET state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,lease_token=NULL,locked_at=NULL,run_at=now() WHERE state='running' AND kind NOT IN ('catalog.deepl','catalog.deepl.batch') AND locked_at<now()-interval '2 minutes'"+(pricingOnly?" AND kind='pricing.reprice'":''),
    );
    if(!pricingOnly){
    if ((await c.query("SELECT to_regclass('public.ai_catalog_drafts') present")).rows[0].present)
      await c.query(
        "UPDATE ai_catalog_drafts d SET state='failed',error='Dzierżawa generowania AI wygasła; utwórz nowy szkic',finished_at=now() FROM jobs j WHERE (j.tenant_id,j.id)=(d.tenant_id,d.job_id) AND j.state='failed' AND d.state='queued'",
      );
    await c.query(
      "UPDATE odoo_catalog_sync_runs r SET state='failed',error='Dzierżawa odczytu wygasła po ostatniej próbie',finished_at=now() FROM jobs j WHERE j.id=r.job_id AND j.state='failed' AND r.state='queued'",
    );
    await c.query(
      "UPDATE odoo_invoice_exports p SET state='failed',error='Dzierżawa eksportu wygasła; uzgodnij wynik w ERP',updated_at=now() FROM jobs j WHERE j.id=p.job_id AND j.state='failed' AND p.state='queued'",
    );
    await c.query(
      "UPDATE shopify_fulfillment_plans p SET state='failed',error='Dzierżawa realizacji wygasła; odczytaj wynik',updated_at=now() FROM jobs j WHERE j.id=p.job_id AND j.state='failed' AND p.state='queued'",
    );
    await c.query(
      "UPDATE shopify_subscription_plans p SET state=CASE WHEN p.phase='fresh' THEN 'failed' ELSE 'uncertain' END,error='Dzierżawa zadania subskrypcji wygasła',updated_at=now() FROM jobs j WHERE j.id=p.job_id AND j.state='failed' AND p.state='queued'",
    );
    if (
      (await c.query("SELECT to_regclass('public.shopify_translation_plans') present")).rows[0]
        .present
    ) {
      await c.query(
        "UPDATE shopify_translation_plans p SET state=CASE WHEN p.phase='fresh' THEN 'failed' ELSE 'uncertain' END,error='Dzierżawa publikacji wygasła; nie ponowiono zapisu',updated_at=now() FROM jobs j WHERE (j.tenant_id,j.id)=(p.tenant_id,p.job_id) AND j.state='failed' AND p.state='queued'",
      );
      await c.query(
        "DELETE FROM shopify_translation_claims c USING shopify_translation_plans p WHERE p.id=c.plan_id AND p.phase='fresh' AND p.state IN ('failed','conflict','cancelled')",
      );
    }
    await c.query(
      "UPDATE shopify_webhook_deliveries d SET outcome='failed',processed_at=now(),result='{\"reason\":\"Dzierżawa odczytu wygasła po ostatniej próbie\"}' FROM jobs j WHERE j.id=d.job_id AND j.state='failed' AND d.outcome='queued'",
    );
    await c.query(
      "UPDATE amazon_fulfillment_plans p SET state='failed',error='Dzierżawa wysyłki wygasła; odczytaj wynik',updated_at=now() FROM jobs j WHERE j.id=p.job_id AND j.state='failed' AND p.state='queued'",
    );
    await c.query(
      "UPDATE ebay_fulfillment_plans p SET state='failed',error='Dzierżawa wysyłki wygasła; odczytaj wynik',updated_at=now() FROM jobs j WHERE j.id=p.job_id AND j.state='failed' AND p.state='queued'",
    );
    await c.query(
      "UPDATE order_status_plans p SET state='failed',error='Dzierżawa zapisu wygasła; sprawdź wynik odczytem' FROM jobs j WHERE j.id=p.job_id AND j.state='failed' AND p.state='queued'",
    );
    await c.query(
      "UPDATE offer_plans p SET state='failed',error='Dzierżawa zadania wygasła po ostatniej próbie; uzgodnij wynik' FROM jobs j WHERE j.id=p.job_id AND j.state='failed' AND p.state='queued'",
    );
    await c.query(
      "UPDATE shipping_plans p SET state='failed',error='Dzierżawa zadania wygasła; uzgodnij wynik' FROM jobs j WHERE j.id=p.job_id AND j.state='failed' AND p.state IN ('queued','buy_queued','cancel_queued')",
    );
    await c.query(
      "UPDATE dpd_collections r SET state=CASE WHEN phase IN ('create_started','cancel_started') THEN 'uncertain' ELSE 'failed' END,error='Dzierżawa DPD wygasła; sprawdź wynik',updated_at=now() FROM jobs j WHERE j.id=r.job_id AND j.state='failed' AND r.state IN ('queued','cancel_queued')",
    );
    // Migration 254 (prepared as 261) creates the table; the presence check stays cheap for a database not yet migrated.
    if ((await c.query("SELECT to_regclass('public.carrier261_returns') present")).rows[0].present)
      await c.query(
        "UPDATE carrier261_returns r SET state=CASE WHEN phase IN ('create_started','buy_started','numbers_ready') THEN 'uncertain' ELSE 'failed' END,error='Dzierżawa etykiety zwrotnej wygasła; uzgodnij wynik',updated_at=now() FROM jobs j WHERE j.id=r.job_id AND j.state='failed' AND r.state='queued'",
      );
    await c.query(
      "UPDATE dhl234_pickups r SET state=CASE WHEN phase IN ('book_started','cancel_started') THEN 'uncertain' WHEN phase='booked' THEN 'booked' ELSE 'failed' END,error='Dzierżawa zlecenia DHL wygasła; sprawdź wynik w DHL24',updated_at=now() FROM jobs j WHERE j.id=r.job_id AND j.state='failed' AND r.state IN ('queued','cancel_queued')",
    );
    await c.query(
      "UPDATE shipments s SET tracking_error='Dzierżawa trackingu wygasła po ostatniej próbie',tracking_next_at=now()+interval '1 hour' FROM jobs j WHERE j.id=s.tracking_job_id AND j.kind='shipping.tracking' AND j.state='failed' AND j.attempts>=j.max_attempts AND s.tracking_error IS NULL",
    );
    await c.query(
      "UPDATE invoice_plans p SET state='failed',error='Dzierżawa zadania wygasła; uzgodnij dokument',updated_at=now() FROM jobs j WHERE j.id=p.job_id AND j.state='failed' AND p.state='queued'",
    );
    await c.query(
      "UPDATE automation_runs r SET state='failed',error='Dzierżawa zadania wygasła',finished_at=now() FROM jobs j WHERE j.id=r.job_id AND j.state='failed' AND r.state='queued'",
    );
    await c.query(
      "UPDATE order_batches b SET state='failed',updated_at=now() FROM jobs j WHERE j.id=b.job_id AND j.state='failed' AND b.state='queued'",
    );
    await c.query(
      "UPDATE outbound_deliveries d SET state='failed',error='Dzierżawa dostawy wygasła po ostatniej próbie' FROM jobs j WHERE j.id=d.job_id AND j.state='failed' AND d.state='queued'",
    );
    await c.query(
      "UPDATE order_batch_items i SET state='skipped',error='Przerwano operację masową' FROM order_batches b WHERE (b.tenant_id,b.id)=(i.tenant_id,i.batch_id) AND b.state='failed' AND i.state='pending'",
    );
    await c.query(
      "UPDATE catalog_source_runs r SET state='failed',error='Dzierżawa pobierania wygasła po ostatniej próbie',updated_at=now() FROM jobs j WHERE j.id=r.job_id AND j.state='failed' AND r.state='queued'",
    );
    await c.query(
      "UPDATE supplier_catalog_reads r SET state='failed',error='Dzierżawa odczytu dostawcy wygasła',finished_at=now() FROM jobs j WHERE j.id=r.job_id AND j.state='failed' AND r.state='queued'",
    );
    await c.query(
      "UPDATE supplier_bulk_runs r SET state='failed',error='Dzierżawa masowego odczytu wygasła',finished_at=now(),version=version+1 FROM jobs j WHERE j.id=r.job_id AND j.state='failed' AND r.state='queued'",
    );
    await c.query(
      "UPDATE variant_offer_batches b SET state='failed',version=version+1,error='Dzierżawa operacji wariantów wygasła',updated_at=now() FROM jobs j WHERE j.id=b.job_id AND j.state='failed' AND b.state IN ('preparing','queued')",
    );
    await c.query(
      "UPDATE automation_schedule_runs r SET state='failed',error='Dzierżawa harmonogramu wygasła',finished_at=now() FROM jobs j WHERE j.id=r.job_id AND j.state='failed' AND r.state='queued'",
    );
    await c.query(
      "UPDATE sms_messages m SET state=CASE WHEN attempted_at IS NULL THEN 'failed' ELSE 'uncertain' END,error='Dzierżawa SMS wygasła; sprawdź wynik',updated_at=now() FROM jobs j WHERE j.id=m.job_id AND j.state='failed' AND m.state='queued'",
    );
    await c.query(
      "UPDATE sms_batches b SET state='done' WHERE b.state='queued' AND NOT EXISTS(SELECT 1 FROM sms_messages m WHERE (m.tenant_id,m.batch_id)=(b.tenant_id,b.id) AND m.state='queued')",
    );
    if ((await c.query("SELECT to_regclass('public.email_messages') present")).rows[0].present) {
      await c.query(
        "UPDATE email_messages m SET state=CASE WHEN attempted_at IS NULL THEN 'failed' ELSE 'uncertain' END,error='Dzierżawa email wygasła',updated_at=now() FROM jobs j WHERE (j.tenant_id,j.id)=(m.tenant_id,m.job_id) AND j.state='failed' AND m.state='queued'",
      );
      await c.query(
        "UPDATE email_batches b SET state='done' WHERE b.state='queued' AND NOT EXISTS(SELECT 1 FROM email_messages m WHERE (m.tenant_id,m.batch_id)=(b.tenant_id,b.id) AND m.state='queued')",
      );
    }
    }
    job = (
      await c.query(
        // Kinds of own loops: AI/DeepL workers, and automation.local_stock of the scoped rule worker (it claims
        // attempts=0 only; tick() has no processor for it and would fail it as unsupported, losing the effect).
        "SELECT * FROM jobs WHERE state='pending' AND kind NOT IN ('catalog.ai','catalog.deepl','catalog.deepl.batch','automation.local_stock') AND run_at<=now()"+(pricingOnly?" AND kind='pricing.reprice'":"")+" ORDER BY run_at,priority,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (job)
      job = (
        await c.query(
          "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2,provider_wait_until=NULL,provider_wait_reason=NULL WHERE id=$1 RETURNING *",
          [job.id, randomUUID()],
        )
      ).rows[0];
    if(pricingOnly&&job)ensure(job.kind==='pricing.reprice',409,'Zmieniono zakres przejętego zadania');
    await c.query('COMMIT');
  } catch (e) {
    if(pricingOnly){scopedClaimFailed=true;try{await c.query('ROLLBACK');}catch{scopedRollbackFailed=true;}}
    else await c.query('ROLLBACK');
    throw e;
  } finally {
    if(pricingOnly){try{c.release(scopedRollbackFailed?true:undefined);}catch(e){if(!scopedClaimFailed)throw e;}}
    else c.release();
  }
  if (!job) return false;
  try {
    if (job.kind === ORDER_FIELD_MAPPING_JOB) {
      await processOrderFieldMappingJob(job);
      return true;
    }
    if (job.kind === ORDER_FIELD_BATCH_JOB) {
      await processOrderFieldBatchJob(job);
      return true;
    }
    if (job.kind === PAYMENT_IMPORT_JOB) {
      await processPaymentImportJob(job);
      return true;
    }
    if (job.kind === 'product.rules') {
      await processProductRuleJob(job);
      return true;
    }
    if (job.kind === REPLENISHMENT_AUTOMATION_JOB) {
      await processReplenishmentAutomation(job);
      return true;
    }
    if (job.kind === 'odoo.catalog.sync') {
      await processOdooCatalogSync(job, ctx);
      return true;
    }
    if (job.kind === 'b2b.catalog') {
      await processB2bCatalog(job);
      return true;
    }
    if (job.kind === 'pricing.reprice') {
      await processRepricing(job);
      return true;
    }
    if (job.kind === 'supplier.bulk') {
      await processSupplierBulk(job, ctx);
      return true;
    }
    if (job.kind === SUPPLIER_REMOTE_FETCH_JOB) {
      await processSupplierRemoteFetch(job);
      return true;
    }
    if (job.kind === 'supplier.read') {
      await processSupplierRead(job, ctx);
      return true;
    }
    if (job.kind === 'email.send') {
      await processEmail(job);
      return true;
    }
    if ((job.kind === 'sms.test' || job.kind === 'sms.send')) {
      await processSms(job, ctx);
      return true;
    }
    if (job.kind === 'payment.source.read') {
      await processSourceRead(job, ctx);
      return true;
    }
    if (job.kind === 'ebay.fulfillment.scan') {
      await processEbayFulfillmentScan(job, ctx);
      return true;
    }
    if (job.kind === 'shopify.fulfillment') {
      await processShopifyFulfillment(job, ctx);
      return true;
    }
    if (job.kind === 'amazon.fulfillment') {
      await processAmazonFulfillment(job, ctx);
      return true;
    }
    if (job.kind === 'ebay.fulfillment') {
      await processEbayFulfillment(job, ctx);
      return true;
    }
    if (job.kind === 'order.status.write') {
      await processStatusWrite(job, ctx);
      return true;
    }
    if (job.kind === 'order.status.scan') {
      await processStatusScan(job, ctx);
      return true;
    }
    if (job.kind === 'shipping.tracking') {
      await processTracking(job, ctx);
      return true;
    }
    if (job.kind === 'outbound.webhook') {
      await processOutbound(job, ctx);
      return true;
    }
    if (job.kind === 'odoo.invoice') {
      await processOdooExport(job, ctx);
      return true;
    }
    if (job.kind === 'invoice.write') {
      await processInvoice(job, ctx);
      return true;
    }
    if (job.kind === 'dpd.collection') {
      await processCollection(job, ctx);
      return true;
    }
    if (job.kind === 'shipping.dpd') {
      await processDpd(job, ctx);
      return true;
    }
    if (job.kind === 'shipping.dhl') {
      await processDhl(job, ctx);
      return true;
    }
    if (job.kind === 'shipping.pocztapolska') {
      await processPocztaPolska(job, ctx);
      return true;
    }
    if (job.kind === MIRAKL262_ORDERS_JOB || job.kind === MIRAKL262_WRITE_JOB) {
      await processMirakl262Job(job);
      return true;
    }
    if (job.kind === DHL_PICKUP_JOB) {
      await processDhlPickup(job, ctx);
      return true;
    }
    if (job.kind === CARRIER_RETURN_JOB) {
      await processCarrierReturn(job, ctx);
      return true;
    }
    if (job.kind === 'shipping') {
      await processShipping(job, ctx);
      return true;
    }
    if (job.kind === 'catalog.fetch') {
      await processCatalogSource(job, ctx);
      return true;
    }
    if (job.kind === 'offer.sync') {
      await processOfferSync(job, ctx);
      return true;
    }
    if (job.kind === 'offer.variants') {
      await processVariantBatch(job, ctx);
      return true;
    }
    if (job.kind === 'offer.write') {
      await processOfferJob(job, ctx);
      return true;
    }
    if (job.kind === 'shopify.subscription') {
      await processShopifySubscription(job, ctx);
      return true;
    }
    if (job.kind === 'shopify.translation') {
      await processTranslation(job, ctx);
      return true;
    }
    if (job.kind === 'shopify.webhook') {
      await processShopifyWebhook(job, ctx);
      return true;
    }
    if (['orders.sync', 'webhook.stage'].includes(job.kind)) {
      await processIntegrationJob(job, ctx);
      return true;
    }
    if (job.kind === 'automation') {
      await dispatchAutomation(job);
      return true;
    }
    if (job.kind === 'automation.schedule') {
      await processSchedule(job);
      return true;
    }
    if (job.kind === 'automation.run') {
      await processAutomation(job);
      return true;
    }
    if (job.kind === 'automation.v2') {
      await dispatchV2(job);
      return true;
    }
    if (job.kind === 'automation.v2.run') {
      await processV2Run(job);
      return true;
    }
    if (job.kind === SUPPLIER_ORDER_JOB) {
      await processSupplierOrderJob(job);
      return true;
    }
    if (job.kind === 'orders.batch') {
      await processBatch(job);
      return true;
    }
    // KSeF status read only (never sends); while KSeF still processes, the generic retry reads again.
    if (job.kind === KSEF_STATUS_JOB) {
      await processKsefStatusJob(job);
      return true;
    }
    // 243: purchase invoices from KSeF (read only); the job queues its own next run.
    if (job.kind === KSEF_PURCHASE_FETCH_JOB) {
      await processKsefPurchaseFetchJob(job);
      return true;
    }
    throw new Error(`Nieobsługiwane zadanie: ${job.kind}`);
  } catch (e) {
    if (await stopAllegroOAuthCommitRefusal(job, e)) return true;
    if (await deferEbayApiJob(job, e)) return true;
    if (await deferAmazonApiJob(job, e)) return true;
    if (job.kind === REPLENISHMENT_AUTOMATION_JOB) {
      await failReplenishmentAutomation(job, e);
      return true;
    }
    if (job.kind === 'ebay.fulfillment.scan') {
      await failEbayFulfillmentScan(job, e);
      return true;
    }
    if (job.kind === 'shopify.fulfillment') {
      await failShopifyFulfillment(job, e);
      return true;
    }
    if (job.kind === 'amazon.fulfillment') {
      await failAmazonFulfillment(job, e);
      return true;
    }
    if (job.kind === 'ebay.fulfillment') {
      await failEbayFulfillment(job, e);
      return true;
    }
    if (job.kind === 'odoo.catalog.sync') {
      await failOdooCatalogSync(job, e);
      return true;
    }
    if (job.kind === 'b2b.catalog') {
      await failB2bCatalog(job, e);
      return true;
    }
    if (job.kind === 'pricing.reprice') {
      await failRepricing(job, e);
      return true;
    }
    if (job.kind === 'supplier.bulk') {
      await failSupplierBulk(job, e);
      return true;
    }
    if (job.kind === SUPPLIER_REMOTE_FETCH_JOB) {
      await failSupplierRemoteFetch(job, e);
      return true;
    }
    if (job.kind === 'supplier.read') {
      await failSupplierRead(job, e);
      return true;
    }
    if (job.kind === 'email.send') {
      await failEmail(job, e);
      return true;
    }
    if ((job.kind === 'sms.test' || job.kind === 'sms.send')) {
      await failSms(job, e);
      return true;
    }
    if (job.kind === 'payment.source.read') {
      await failSourceRead(job, e);
      return true;
    }
    if (['order.status.write', 'order.status.scan'].includes(job.kind)) {
      await failStatusJob(job, e);
      return true;
    }
    if (job.kind === 'shipping.tracking') {
      await failTracking(job, e);
      return true;
    }
    if (job.kind === 'outbound.webhook') {
      await failOutbound(job, e);
      return true;
    }
    if (job.kind === 'automation.schedule') {
      await failSchedule(job, e);
      return true;
    }
    if (job.kind === 'automation.run') {
      await failAutomation(job, e);
      return true;
    }
    if (job.kind === 'automation.v2' || job.kind === 'automation.v2.run') {
      await failV2(job, e);
      return true;
    }
    if (job.kind === SUPPLIER_ORDER_JOB) {
      await failSupplierOrderJob(job, e);
      return true;
    }
    if (job.kind === 'orders.batch') {
      await failBatch(job, e);
      return true;
    }
    if (job.kind === 'odoo.invoice') {
      await failOdooExport(job, e);
      return true;
    }
    if (job.kind === 'invoice.write') {
      await failInvoice(job, e);
      return true;
    }
    if (job.kind === 'dpd.collection') {
      await failCollection(job, e);
      return true;
    }
    if (['shipping', 'shipping.dpd', 'shipping.dhl', 'shipping.pocztapolska'].includes(job.kind)) {
      await failShipping(job, e);
      return true;
    }
    if (job.kind === MIRAKL262_ORDERS_JOB || job.kind === MIRAKL262_WRITE_JOB) {
      await failMirakl262Job(job, e);
      return true;
    }
    if (job.kind === DHL_PICKUP_JOB) {
      await failDhlPickup(job, e);
      return true;
    }
    if (job.kind === CARRIER_RETURN_JOB) {
      await failCarrierReturn(job, e);
      return true;
    }
    if (job.kind === 'catalog.fetch') {
      await failCatalogSource(job, e);
      return true;
    }
    if (job.kind === 'offer.sync') {
      await failOfferSync(job, e);
      return true;
    }
    if (job.kind === 'offer.variants') {
      await failVariantBatch(job, e);
      return true;
    }
    if (job.kind === 'offer.write') {
      await failOffer(job, e);
      return true;
    }
    if (job.kind === 'shopify.subscription') {
      await failShopifySubscription(job, e);
      return true;
    }
    if (job.kind === 'shopify.translation') {
      await failTranslation(job, e);
      return true;
    }
    if (job.kind === 'shopify.webhook') {
      await failShopifyWebhook(job, e);
      return true;
    }
    const message =
      e instanceof Problem
        ? e.message
        : job.kind === 'automation'
          ? 'Błąd automatyzacji'
          : job.kind === PAYMENT_IMPORT_JOB
            ? 'Błąd lokalnego importu płatności; zmiany wycofano'
            : job.kind === ORDER_FIELD_MAPPING_JOB
              ? 'Błąd lokalnego mapowania pól; zmiany wycofano'
              : job.kind === ORDER_FIELD_BATCH_JOB
                ? 'Błąd lokalnej edycji pól; zmiany wycofano'
                : job.kind === 'product.rules'
                  ? 'Błąd lokalnej automatyzacji produktów; zmiany wycofano'
                  : job.kind === 'orders.sync' || job.kind === 'webhook.stage'
                    ? 'Błąd przetwarzania integracji'
                    : `Nieobsługiwane zadanie: ${job.kind}`;
    await tenantTx(job.tenant_id, async (db) => {
      const changed = await db.query(
        "UPDATE jobs SET state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,error=$2,lease_token=NULL,locked_at=NULL,run_at=now()+ make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1 AND lease_token=$3 RETURNING id",
        [job.id, message, job.lease_token],
      );
      if (changed.rowCount && job.kind === 'orders.sync')
        await db.query(
          'INSERT INTO integration_runs(id,tenant_id,channel_id,operation,status,detail) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            job.tenant_id,
            job.payload.channel_id,
            'orders.sync',
            'error',
            JSON.stringify({ error: message, page: job.payload.page, attempt: job.attempts }),
          ],
        );
    });
  }
  return true;
}
/** Global loop steps, in cycle order. Each one is isolated by the supervisor (own catch and backoff).
 * The job tick has its own lane: a slow job must not hold the schedulers for the length of its run. */
export function workerSteps(ctx: IntegrationContext = {}): readonly WorkerStep[] {
  return [
    { name: 'ebay.fulfillment', label: 'eBay: realizacje', run: scheduleEbayFulfillmentsDue },
    { name: 'integrations.sync', label: 'Synchronizacja integracji', run: scheduleDue },
    { name: 'offers.sync', label: 'Synchronizacja ofert', run: scheduleOffersDue },
    { name: 'shipping.tracking', label: 'Śledzenie przesyłek', run: scheduleTrackingDue },
    { name: 'dpd.pickups', label: 'DPD: podjazdy kuriera', run: scheduleDpdPickupsDue },
    { name: 'orders.statuses', label: 'Statusy zamówień w kanałach', run: scheduleStatusesDue },
    { name: 'payments.sources', label: 'Płatności ze źródeł', run: scheduleSourcePaymentsDue },
    { name: 'automations.schedules', label: 'Harmonogramy automatyzacji', run: scheduleAutomationsDue },
    // The same once-a-minute step also checks stock changes for the v2 trigger stock.changed (automation-v2-stock.ts).
    { name: 'automations.v2.time', label: 'Reguły automatyzacji: upływ czasu', run: async () => { await scheduleV2TimeChecks(); await scheduleV2StockChecks(); } },
    { name: 'labels.packed', label: 'Etykiety spakowanych paczek', run: resolvePackedLabelsDue },
    { name: 'suppliers.schedules', label: 'Harmonogramy dostawców', run: scheduleSuppliersDue },
    { name: 'suppliers.remote_feeds', label: 'Zdalne pliki dostawców', run: scheduleSupplierRemoteFeedsDue },
    { name: 'odoo.catalog', label: 'Odoo: katalog', run: scheduleOdooCatalogDue },
    { name: 'pricing.repricing', label: 'Repricing', run: scheduleRepricingDue },
    { name: 'products.rule_schedules', label: 'Harmonogramy reguł produktów', run: scheduleProductRuleOccurrencesDue },
    { name: 'b2b.network', label: 'Sieć B2B', run: scheduleB2bNetworkDue },
    // 251 (B2B-004-X, B2B-005): supplier decisions, dispatch events, dropshipping tracking; a no-op before 251.
    { name: 'b2b.network.lifecycle', label: 'Sieć B2B: decyzje dostawców i śledzenie', run: sweepB2bNetworkLifecycleDue },
    // 245 (COM-005): IMAP schedules; a no-op on a copy without the 245 tables.
    { name: 'email.inbound_schedules', label: 'Odbiór IMAP', run: () => scheduleInboundPollsDue() },
    // 252 (L4 Mirakl): OR11 schedules and open offer/fulfilment writes; a no-op before 252.
    { name: 'mirakl.operations', label: 'Mirakl: harmonogram zamówień i zapisy', run: sweepMirakl262Due },
    {
      name: 'jobs.tick',
      label: 'Przetwarzanie kolejki zadań',
      lane: 'jobs',
      // Up to 10 jobs; one automation job takes about a minute on a PG04 clone. Schedulers keep the 120 s default.
      timeoutMs: 900_000,
      run: async () => {
        for (let n = 0; n < 10; n++) if (!(await tick(ctx))) break;
      },
    },
  ];
}
export type StartWorkerOptions = { steps?: readonly WorkerStep[]; intervalMs?: number; supervisor?: WorkerSupervisorOptions };
export function startWorker(ctx: IntegrationContext = {}, options: StartWorkerOptions = {}) {
  const intervalMs = options.intervalMs ?? 1000;
  const supervisor = createWorkerSupervisor(options.steps ?? workerSteps(ctx), { ...options.supervisor, intervalMs });
  const unregister = registerWorkerRuntime(supervisor);
  const running = new Map<string, Promise<void>>();
  const timers = supervisor.lanes().map((lane) =>
    setInterval(() => {
      if (running.has(lane)) return;
      running.set(
        lane,
        supervisor.runCycle(lane).finally(() => running.delete(lane)),
      );
    }, intervalMs),
  );
  return async () => {
    for (const t of timers) clearInterval(t);
    supervisor.stopping();
    try {
      await Promise.all(running.values());
    } finally {
      unregister();
    }
  };
}
