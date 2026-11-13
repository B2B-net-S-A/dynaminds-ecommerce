import { spawn } from 'node:child_process';
import pg from 'pg';
import { localConfig, pool } from '../server/db';
import { testPostgresPort } from '../server/test-postgres-port';
const testPgPort = testPostgresPort(process.env.DYNA_TEST_PG_PORT);
const name = `dynaminds_test_${process.pid}`;
const admin = new pg.Client({
  host: '127.0.0.1',
  port: testPgPort,
  user: 'postgres',
  password: localConfig.dbPassword,
  database: 'postgres',
});
await admin.connect();
await admin.query(`CREATE DATABASE ${name}`);
let code = 1;
try {
  let files = process.argv.includes('--sms-automations')
    ? [
        'tests/sms-automations.test.ts',
        'tests/sms.test.ts',
        'tests/operations.test.ts',
        'tests/automation-schedules.test.ts',
        'tests/developer.test.ts',
        'tests/backup.test.ts',
      ]
    : process.argv.includes('--sms')
      ? [
          'tests/sms.test.ts',
          'tests/integrations.test.ts',
          'tests/developer.test.ts',
          'tests/backup.test.ts',
        ]
      : process.argv.includes('--schedules')
        ? [
            'tests/automation-schedules.test.ts',
            'tests/operations.test.ts',
            'tests/developer.test.ts',
            'tests/backup.test.ts',
          ]
        : process.argv.includes('--locations')
          ? [
              'tests/stock-locations.test.ts',
              'tests/warehouse.test.ts',
              'tests/domain.test.ts',
              'tests/purchasing.test.ts',
              'tests/returns.test.ts',
              'tests/shipping.test.ts',
            ]
          : process.argv.includes('--source-payments')
            ? [
                'tests/source-payments.test.ts',
                'tests/payments.test.ts',
                'tests/imports.test.ts',
                'tests/prestashop.test.ts',
                'tests/order-status.test.ts',
              ]
            : process.argv.includes('--payments')
              ? [
                  'tests/payments.test.ts',
                  'tests/returns.test.ts',
                  'tests/imports.test.ts',
                  'tests/shipping.test.ts',
                  'tests/order-status.test.ts',
                  'tests/prestashop.test.ts',
                ]
              : process.argv.includes('--order-status')
                ? ['tests/order-status.test.ts', 'tests/imports.test.ts', 'tests/sync.test.ts']
                : process.argv.includes('--purchasing')
                  ? [
                      'tests/purchasing.test.ts',
                      'tests/warehouse.test.ts',
                      'tests/developer.test.ts',
                    ]
                  : process.argv.includes('--tracking')
                    ? [
                        'tests/tracking.test.ts',
                        'tests/dpd-tracking.test.ts',
                        'tests/shipping.test.ts',
                      ]
                    : process.argv.includes('--benchmark')
                      ? ['tests/benchmark.test.ts']
                      : [
                          'tests/warehouse-document-register.test.ts',
                          'tests/warehouse-document-register-contract.test.ts',
                          'tests/warehouse-document-register-component.test.mjs',
                          'tests/stocktake-adjustment-register.test.ts',
                          'tests/stocktake-adjustment-register-contract.test.ts',
                          'tests/stocktake-adjustment-register-component.test.mjs',
                          'tests/stocktake-adjustment-navigation-component165.test.mjs',
                          'tests/stocktake-adjustments.test.ts',
                          'tests/stocktake-adjustments-contract.test.ts',
                          'tests/stocktake-adjustments-migration.test.ts',
                          'tests/stocktake-adjustments-component.test.mjs',
                          'tests/b2b-catalog-scope.test.ts',
                          'tests/b2b-catalog-scope-contract.test.ts',
                          'tests/b2b-catalog-scope-adapters.test.ts',
                          'tests/b2b-catalog-network-scopes.test.ts',
                          'tests/b2b-catalog-commerce-scopes.test.ts',
                          'tests/b2b-catalog-dropshipping-scopes.test.ts',
                          'tests/b2b-catalog-scope-migration.test.ts',
                          'tests/b2b-catalog-bind-key-safety.test.ts',
                          'tests/b2b-catalog-scope-component.test.mjs',
                          'tests/b2b-catalog-bind-component.test.mjs',
                          'tests/b2b-catalog-scope-app-component.test.mjs',
                          'tests/order-merge-counters.test.ts',
                          'tests/product-catalogs.test.ts',
                          'tests/product-catalogs-migration.test.ts',
                          'tests/product-catalog-adapters.test.ts',
                          'tests/product-catalog-integrations.test.ts',
                          'tests/product-catalogs-contract.test.ts',
                          'tests/supplier-file-source-parse.test.ts',
                          'tests/supplier-file-sources.test.ts',
                          'tests/stock-file-import-parse.test.ts',
                          'tests/stock-file-import.test.ts',
                          'tests/stock-file-import-safety.test.ts',
                          'tests/stock-file-import-aba.test.ts',
                          'tests/stock-file-import-capacity.test.ts',
                          'tests/stock-file-import-identity-capacity-safety.test.ts',
                          'tests/b2b-dropshipping-returns.test.ts',
                          'tests/b2b-dropshipping-returns-safety.test.ts',
                          'tests/b2b-dropshipping-returns-fragment-safety.test.ts',
                          'tests/b2b-dropshipping-returns-preview-safety.test.ts',
                          'tests/b2b-return-local-origins.test.ts',
                          'tests/b2b-return-local-origins-api.test.ts',
                          'tests/b2b-return-local-origins-proof-safety.test.ts',
                          'tests/b2b-return-local-origins-preview.test.ts',
                          'tests/sales-reports.test.ts',
                          'tests/sales-reports-safety.test.ts',
                          'tests/b2b-external-order-intent.test.ts',
                          'tests/source-order-intent-fragments.test.ts',
                          'tests/source-order-intents-safety.test.ts',
                          'tests/source-order-intents-shop-engines.test.ts',
                          'tests/source-order-intents-marketplace-engines.test.ts',
                          'tests/source-order-intents-enterprise-engines.test.ts',
                          'tests/b2b-external-order-intent-safety.test.ts',
                          'tests/b2b-network-dropshipping.test.ts',
                          'tests/b2b-network-dropshipping-safety.test.ts',
                          'tests/order-merges.test.ts',
                          'tests/order-merge-custody.test.ts',
                          'tests/order-merge-integration.test.ts',
                          'tests/order-merge-dashboard.test.ts',
                          'tests/order-merge-b2b.test.ts',
                          'tests/workspace-mfa.test.ts',
                          'tests/web-api.test.ts',
                          'tests/replenishment-plans.test.ts',
                          'tests/replenishment-plans-safety.test.ts',
                          'tests/replenishment-wms.test.ts',
                          'tests/integration-workspace.test.ts',
                          'tests/inventory-pages.test.ts',
                          'tests/supplier-catalog.test.ts',
                          'tests/supplier-bulk.test.ts',
                          'tests/supplier-schedules.test.ts',
                          'tests/shopify-catalog.test.ts',
                          'tests/shopify-offers.test.ts',
                          'tests/shopify.test.ts',
                          'tests/shopify-order-read.test.ts',
                          'tests/shopify-webhooks.test.ts',
                          'tests/shopify-subscriptions.test.ts',
                          'tests/shopify-fulfillment.test.ts',
                          'tests/order-source-lines.test.ts',
                          'tests/shopify-source-fulfillment.test.ts',
                          'tests/shopify-source-fulfillment-safety.test.ts',
                          'tests/prestashop-offers.test.ts',
                          'tests/stocktakes.test.ts',
                          'tests/sms-automations.test.ts',
                          'tests/sms.test.ts',
                          'tests/email.test.ts',
                          'tests/email-actions.test.ts',
                          'tests/email-attachments.test.ts',
                          'tests/backup.test.ts',
                          'tests/domain.test.ts',
                          'tests/payments.test.ts',
                          'tests/source-payments.test.ts',
                          'tests/returns.test.ts',
                          'tests/portal.test.ts',
                          'tests/customer-messages.test.ts',
                          'tests/customer-message-workflows.test.ts',
                          'tests/customer-message-workflows-safety.test.ts',
                          'tests/pricing.test.ts',
                          'tests/b2b.test.ts',
                          'tests/b2b-network.test.ts',
                          'tests/b2b-network-orders.test.ts',
                          'tests/b2b-network-returns.test.ts',
                          'tests/repricing.test.ts',
                          'tests/repricing-schedules.test.ts',
                          'tests/integrations.test.ts',
                          'tests/imports.test.ts',
                          'tests/sync.test.ts',
                          'tests/catalog.test.ts',
                          'tests/catalog-export.test.ts',
                          'tests/catalog-export-safety.test.ts',
                          'tests/catalog-bulk-edit.test.ts',
                          'tests/catalog-bulk-edit-safety.test.ts',
                          'tests/catalog-source.test.ts',
                          'tests/warehouse.test.ts',
                          'tests/warehouse-valuation-classification.test.ts',
                          'tests/warehouse-valuation-classification-component.test.mjs',
                          'tests/stock-locations.test.ts',
                          'tests/purchasing.test.ts',
                          'tests/offers.test.ts',
                          'tests/allegro-creation-drafts.test.ts',
                          'tests/allegro-creation-publish.test.ts',
                          'tests/allegro-creation-batch-max.test.ts',
                          'tests/variable-offers.test.ts',
                          'tests/offer-sync.test.ts',
                          'tests/order-status.test.ts',
                          'tests/shipping.test.ts',
                          'tests/dpd.test.ts',
                          'tests/dpd-collections.test.ts',
                          'tests/tracking.test.ts',
                          'tests/dpd-tracking.test.ts',
                          'tests/carrier-dhl.test.ts',
                          'tests/carrier-dhl-values.test.ts',
                          'tests/carrier-dhl-xml.test.ts',
                          'tests/carrier-pocztapolska.test.ts',
                          'tests/carrier-pocztapolska-tracking.test.ts',
                          'tests/carrier-pocztapolska-shipments.test.ts',
                          'tests/ordinary-connector-policy-carriers234.test.ts',
                          'tests/invoices.test.ts',
                          'tests/odoo.test.ts',
                          'tests/odoo-images.test.ts',
                          'tests/amazon.test.ts',
                          'tests/amazon-fulfillment.test.ts',
                          'tests/amazon-catalog.test.ts',
                          'tests/amazon-offers.test.ts',
                          'tests/amazon-oauth.test.ts',
                          'tests/amazon-imports.test.ts',
                          'tests/ebay.test.ts',
                          'tests/ebay-imports.test.ts',
                          'tests/ebay-catalog.test.ts',
                          'tests/ebay-offers-sync-publish.test.ts',
                          'tests/ebay-offers-create.test.ts',
                          'tests/ebay-offers-metadata.test.ts',
                          'tests/ebay-oauth.test.ts',
                          'tests/ebay-fulfillment.test.ts',
                          'tests/odoo-catalog.test.ts',
                          'tests/odoo-accounting.test.ts',
                          'tests/odoo-exports.test.ts',
                          'tests/odoo-invoice-files.test.ts',
                          'tests/odoo-catalog-sync.test.ts',
                          'tests/odoo-orders.test.ts',
                          'tests/odoo-order-imports.test.ts',
                          'tests/operations.test.ts',
                          'tests/automation-schedules.test.ts',
                          'tests/prestashop.test.ts',
                          'tests/workspaces.test.ts',
                          'tests/workspace-billing.test.ts',
                          'tests/prestashop-status.test.ts',
                          'tests/catalog-ai.test.ts',
                          'tests/deepl.test.ts',
                          'tests/deepl-batches.test.ts',
                          'tests/account-security.test.ts',
                          'tests/developer.test.ts',
                        ];
  if (process.argv.includes('--odoo-catalog-sync'))
    files = [
      'tests/odoo-catalog-sync.test.ts',
      'tests/odoo.test.ts',
      'tests/odoo-catalog.test.ts',
      'tests/odoo-orders.test.ts',
      'tests/odoo-order-imports.test.ts',
      'tests/odoo-accounting.test.ts',
      'tests/odoo-exports.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--odoo-orders'))
    files = [
      'tests/odoo-orders.test.ts',
      'tests/odoo-order-imports.test.ts',
      'tests/odoo.test.ts',
      'tests/odoo-catalog.test.ts',
      'tests/odoo-accounting.test.ts',
      'tests/odoo-exports.test.ts',
      'tests/imports.test.ts',
      'tests/sync.test.ts',
      'tests/shopify.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--odoo-invoices'))
    files = [
      'tests/odoo-invoice-files.test.ts',
      'tests/odoo-exports.test.ts',
      'tests/odoo-accounting.test.ts',
      'tests/odoo.test.ts',
      'tests/odoo-catalog.test.ts',
      'tests/invoices.test.ts',
      'tests/returns.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--odoo-images'))
    files = [
      'tests/odoo-images.test.ts',
      'tests/odoo.test.ts',
      'tests/odoo-catalog.test.ts',
      'tests/catalog.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--odoo'))
    files = [
      'tests/odoo.test.ts',
      'tests/odoo-catalog.test.ts',
      'tests/catalog-source.test.ts',
      'tests/shopify-catalog.test.ts',
      'tests/integrations.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--dpd-tracking'))
    files = [
      'tests/dpd-tracking.test.ts',
      'tests/tracking.test.ts',
      'tests/dpd.test.ts',
      'tests/shipping.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--stocktakes'))
    files = [
      'tests/stocktakes.test.ts',
      'tests/stock-locations.test.ts',
      'tests/warehouse.test.ts',
      'tests/developer.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--prestashop-offers'))
    files = [
      'tests/prestashop-offers.test.ts',
      'tests/prestashop.test.ts',
      'tests/offers.test.ts',
      'tests/offer-sync.test.ts',
      'tests/variable-offers.test.ts',
    ];
  if (process.argv.includes('--shopify'))
    files = [
      'tests/shopify.test.ts',
      'tests/imports.test.ts',
      'tests/sync.test.ts',
      'tests/integrations.test.ts',
      'tests/developer.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--shopify-offers'))
    files = [
      'tests/shopify-offers.test.ts',
      'tests/shopify.test.ts',
      'tests/offers.test.ts',
      'tests/offer-sync.test.ts',
      'tests/prestashop-offers.test.ts',
    ];
  if (process.argv.includes('--shopify-catalog'))
    files = [
      'tests/shopify-catalog.test.ts',
      'tests/catalog-source.test.ts',
      'tests/shopify.test.ts',
      'tests/shopify-offers.test.ts',
    ];
  if (process.argv.includes('--catalog-scale'))
    files = [
      'tests/catalog.test.ts',
      'tests/domain.test.ts',
      'tests/warehouse.test.ts',
      'tests/workspaces.test.ts',
    ];
  if (process.argv.includes('--workspace-quota-only')) files = ['tests/workspaces.test.ts'];
  if (process.argv.includes('--automations-v2')) files = ['tests/automation-v2-eval.test.ts', 'tests/automation-v2.database.test.ts'];
  if (process.argv.includes('--inventory-pages'))
    files = [
      'tests/inventory-pages.test.ts',
      'tests/catalog.test.ts',
      'tests/domain.test.ts',
      'tests/warehouse.test.ts',
      'tests/developer.test.ts',
      'tests/stock-locations.test.ts',
      'tests/stocktakes.test.ts',
      'tests/imports.test.ts',
      'tests/invoices.test.ts',
    ];
  if (process.argv.includes('--supplier-catalog'))
    files = [
      'tests/supplier-catalog.test.ts',
      'tests/supplier-bulk.test.ts',
      'tests/supplier-schedules.test.ts',
      'tests/integrations.test.ts',
      'tests/purchasing.test.ts',
      'tests/catalog.test.ts',
      'tests/developer.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--supplier-file-sources-only'))
    files = ['tests/supplier-file-source-parse.test.ts', 'tests/supplier-file-sources.test.ts'];
  if (process.argv.includes('--supplier-file-sources-compatibility'))
    files = [
      'tests/supplier-catalog.test.ts',
      'tests/supplier-bulk.test.ts',
      'tests/supplier-schedules.test.ts',
      'tests/purchasing.test.ts',
      'tests/developer.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--repricing'))
    files = [
      'tests/repricing.test.ts',
      'tests/repricing-schedules.test.ts',
      'tests/pricing.test.ts',
      'tests/offer-sync.test.ts',
      'tests/developer.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--allegro-creation'))
    files = [
      'tests/allegro-creation-drafts.test.ts',
      'tests/allegro-creation-publish.test.ts',
      'tests/allegro-creation-batch-max.test.ts',
      'tests/offers.test.ts',
      'tests/offer-sync.test.ts',
      'tests/variable-offers.test.ts',
      'tests/sync.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--dpd'))
    files = [
      'tests/dpd.test.ts',
      'tests/dpd-collections.test.ts',
      'tests/payments.test.ts',
      'tests/shipping.test.ts',
      'tests/tracking.test.ts',
      'tests/dpd-tracking.test.ts',
      'tests/integrations.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--dpd-collections')) files = ['tests/dpd-collections.test.ts'];
  if (process.argv.includes('--b2b'))
    files = [
      'tests/b2b.test.ts',
      'tests/b2b-network.test.ts',
      'tests/b2b-network-orders.test.ts',
      'tests/b2b-network-returns.test.ts',
      'tests/pricing.test.ts',
      'tests/domain.test.ts',
      'tests/portal.test.ts',
      'tests/returns.test.ts',
      'tests/warehouse.test.ts',
      'tests/workspaces.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--b2b-network')) files = ['tests/b2b-network.test.ts'];
  if (process.argv.includes('--b2b-orders')) files = ['tests/b2b-network-orders.test.ts'];
  if (process.argv.includes('--b2b-external-order-intent-engine-only'))
    files = ['tests/b2b-external-order-intent.test.ts'];
  if (process.argv.includes('--source-order-intent-fragments-only'))
    files = ['tests/source-order-intent-fragments.test.ts'];
  if (process.argv.includes('--source-order-intents-safety-only'))
    files = ['tests/source-order-intents-safety.test.ts'];
  if (process.argv.includes('--source-order-intents-only'))
    files = [
      'tests/source-order-intent-fragments.test.ts',
      'tests/source-order-intents-safety.test.ts',
    ];
  if (process.argv.includes('--source-order-intents-all-providers'))
    files = [
      'tests/source-order-intents-shop-engines.test.ts',
      'tests/source-order-intents-marketplace-engines.test.ts',
      'tests/source-order-intents-enterprise-engines.test.ts',
    ];
  if (process.argv.includes('--source-order-intents-shops-only'))
    files = ['tests/source-order-intents-shop-engines.test.ts'];
  if (process.argv.includes('--source-order-intents-marketplaces-only'))
    files = ['tests/source-order-intents-marketplace-engines.test.ts'];
  if (process.argv.includes('--source-order-intents-enterprise-only'))
    files = ['tests/source-order-intents-enterprise-engines.test.ts'];
  if (process.argv.includes('--source-order-intents-provider-compatibility'))
    files = ['tests/prestashop.test.ts', 'tests/source-payments.test.ts'];
  if (process.argv.includes('--source-order-intents-compatibility'))
    files = [
      'tests/imports.test.ts',
      'tests/order-source-lines.test.ts',
      'tests/b2b-external-order-intent.test.ts',
      'tests/b2b-external-order-intent-safety.test.ts',
    ];
  if (process.argv.includes('--b2b-external-order-intent-safety-only'))
    files = ['tests/b2b-external-order-intent-safety.test.ts'];
  if (process.argv.includes('--b2b-external-order-intent-only'))
    files = [
      'tests/b2b-external-order-intent.test.ts',
      'tests/b2b-external-order-intent-safety.test.ts',
    ];
  if (process.argv.includes('--b2b-external-order-intent-compatibility'))
    files = [
      'tests/b2b-network-dropshipping.test.ts',
      'tests/b2b-network-dropshipping-safety.test.ts',
      'tests/domain.test.ts',
      'tests/order-status.test.ts',
      'tests/returns.test.ts',
    ];
  if (process.argv.includes('--b2b-dropshipping-engine-only'))
    files = ['tests/b2b-network-dropshipping.test.ts'];
  if (process.argv.includes('--b2b-dropshipping-safety-only'))
    files = ['tests/b2b-network-dropshipping-safety.test.ts'];
  if (process.argv.includes('--b2b-dropshipping-only'))
    files = [
      'tests/b2b-network-dropshipping.test.ts',
      'tests/b2b-network-dropshipping-safety.test.ts',
    ];
  if (process.argv.includes('--b2b-return-local-origins-only'))
    files = [
      'tests/b2b-return-local-origins.test.ts',
      'tests/b2b-return-local-origins-api.test.ts',
      'tests/b2b-return-local-origins-proof-safety.test.ts',
      'tests/b2b-return-local-origins-preview.test.ts',
    ];
  if (process.argv.includes('--b2b-return-local-origins-core-only'))
    files = ['tests/b2b-return-local-origins.test.ts'];
  if (process.argv.includes('--b2b-return-local-origins-api-only'))
    files = ['tests/b2b-return-local-origins-api.test.ts'];
  if (process.argv.includes('--b2b-return-local-origins-proof-only'))
    files = ['tests/b2b-return-local-origins-proof-safety.test.ts'];
  if (process.argv.includes('--b2b-return-local-origins-preview-only'))
    files = ['tests/b2b-return-local-origins-preview.test.ts'];
  if (process.argv.includes('--b2b-return-local-origins-compatibility'))
    files = [
      'tests/b2b-dropshipping-returns.test.ts',
      'tests/b2b-dropshipping-returns-safety.test.ts',
      'tests/b2b-dropshipping-returns-fragment-safety.test.ts',
      'tests/b2b-dropshipping-returns-preview-safety.test.ts',
      'tests/b2b-external-order-intent.test.ts',
      'tests/b2b-external-order-intent-safety.test.ts',
      'tests/returns.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--b2b-dropshipping-returns-engine-only'))
    files = ['tests/b2b-dropshipping-returns.test.ts'];
  if (process.argv.includes('--b2b-dropshipping-returns-safety-only'))
    files = [
      'tests/b2b-dropshipping-returns-safety.test.ts',
      'tests/b2b-dropshipping-returns-fragment-safety.test.ts',
      'tests/b2b-dropshipping-returns-preview-safety.test.ts',
    ];
  if (process.argv.includes('--b2b-dropshipping-returns-fragment-only'))
    files = ['tests/b2b-dropshipping-returns-fragment-safety.test.ts'];
  if (process.argv.includes('--b2b-dropshipping-returns-preview-only'))
    files = ['tests/b2b-dropshipping-returns-preview-safety.test.ts'];
  if (process.argv.includes('--b2b-dropshipping-returns-only'))
    files = [
      'tests/b2b-dropshipping-returns.test.ts',
      'tests/b2b-dropshipping-returns-safety.test.ts',
      'tests/b2b-dropshipping-returns-fragment-safety.test.ts',
      'tests/b2b-dropshipping-returns-preview-safety.test.ts',
    ];
  if (process.argv.includes('--b2b-dropshipping-returns-compatibility'))
    files = [
      'tests/returns.test.ts',
      'tests/sales-reports.test.ts',
      'tests/sales-reports-safety.test.ts',
      'tests/portal.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--b2b-dropshipping-compatibility'))
    files = [
      'tests/b2b-network-orders.test.ts',
      'tests/invoices.test.ts',
      'tests/shopify-fulfillment.test.ts',
      'tests/ebay-fulfillment.test.ts',
      'tests/amazon-fulfillment.test.ts',
    ];
  if (process.argv.includes('--b2b-dropshipping-shipping-compatibility'))
    files = ['tests/shipping.test.ts', 'tests/dpd.test.ts'];
  if (process.argv.includes('--b2b-returns'))
    files = [
      'tests/b2b-network-returns.test.ts',
      'tests/warehouse.test.ts',
      'tests/stock-locations.test.ts',
      'tests/returns.test.ts',
    ];
  if (process.argv.includes('--ebay'))
    files = [
      'tests/ebay.test.ts',
      'tests/ebay-imports.test.ts',
      'tests/ebay-catalog.test.ts',
      'tests/imports.test.ts',
      'tests/sync.test.ts',
      'tests/odoo-order-imports.test.ts',
      'tests/integrations.test.ts',
    ];
  if (process.argv.includes('--ebay-catalog'))
    files = [
      'tests/ebay-catalog.test.ts',
      'tests/ebay.test.ts',
      'tests/ebay-imports.test.ts',
      'tests/catalog-source.test.ts',
      'tests/shopify-catalog.test.ts',
      'tests/odoo-catalog.test.ts',
      'tests/sync.test.ts',
      'tests/integrations.test.ts',
    ];
  if (process.argv.includes('--ebay-offers'))
    files = [
      'tests/ebay-offers-sync-publish.test.ts',
      'tests/ebay-offers-create.test.ts',
      'tests/ebay-offers-metadata.test.ts',
      'tests/ebay.test.ts',
      'tests/ebay-catalog.test.ts',
      'tests/offers.test.ts',
      'tests/offer-sync.test.ts',
      'tests/shopify-offers.test.ts',
      'tests/prestashop-offers.test.ts',
    ];
  if (process.argv.includes('--ebay-offers-only')) files = [
      'tests/ebay-offers-sync-publish.test.ts',
      'tests/ebay-offers-create.test.ts',
      'tests/ebay-offers-metadata.test.ts',
    ];
  if (process.argv.includes('--ebay-oauth'))
    files = [
      'tests/ebay-oauth.test.ts',
      'tests/ebay.test.ts',
      'tests/ebay-catalog.test.ts',
      'tests/ebay-offers-sync-publish.test.ts',
      'tests/ebay-offers-create.test.ts',
      'tests/ebay-offers-metadata.test.ts',
      'tests/sync.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--ebay-account'))
    files = [
      'tests/ebay-oauth.test.ts',
      'tests/ebay.test.ts',
      'tests/ebay-catalog.test.ts',
      'tests/ebay-offers-sync-publish.test.ts',
      'tests/ebay-offers-create.test.ts',
      'tests/ebay-offers-metadata.test.ts',
      'tests/ebay-fulfillment.test.ts',
      'tests/sync.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--ebay-oauth-only')) files = ['tests/ebay-oauth.test.ts'];
  if (process.argv.includes('--ebay-fulfillment'))
    files = [
      'tests/ebay-fulfillment.test.ts',
      'tests/ebay.test.ts',
      'tests/ebay-imports.test.ts',
      'tests/ebay-oauth.test.ts',
      'tests/shipping.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--ebay-fulfillment-only')) files = ['tests/ebay-fulfillment.test.ts'];
  if (process.argv.includes('--ebay-api-limits-only')) files = ['tests/ebay-api-limits.test.ts'];
  if (process.argv.includes('--ebay-api-limits'))
    files = [
      'tests/ebay-api-limits.test.ts',
      'tests/ebay-offers-sync-publish.test.ts',
      'tests/ebay-offers-create.test.ts',
      'tests/ebay-offers-metadata.test.ts',
      'tests/ebay-oauth.test.ts',
      'tests/ebay-fulfillment.test.ts',
      'tests/ebay.test.ts',
      'tests/ebay-catalog.test.ts',
      'tests/offer-sync.test.ts',
      'tests/catalog-source.test.ts',
    ];
  if (process.argv.includes('--ebay-api-focused'))
    files = [
      'tests/ebay-api-limits.test.ts',
      'tests/ebay-offers-sync-publish.test.ts',
      'tests/ebay-offers-create.test.ts',
      'tests/ebay-offers-metadata.test.ts',
      'tests/ebay-oauth.test.ts',
    ];
  if (process.argv.includes('--account-security'))
    files = [
      'tests/account-security.test.ts',
      'tests/workspaces.test.ts',
      'tests/developer.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--account-security-only')) files = ['tests/account-security.test.ts'];
  if (process.argv.includes('--workspace-mfa'))
    files = [
      'tests/workspace-mfa.test.ts',
      'tests/web-api.test.ts',
      'tests/account-security.test.ts',
      'tests/workspaces.test.ts',
      'tests/developer.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--workspace-mfa-only')) files = ['tests/workspace-mfa.test.ts'];
  if (process.argv.includes('--amazon-only'))
    files = ['tests/amazon.test.ts', 'tests/amazon-imports.test.ts'];
  if (process.argv.includes('--amazon'))
    files = [
      'tests/amazon.test.ts',
      'tests/amazon-imports.test.ts',
      'tests/imports.test.ts',
      'tests/domain.test.ts',
      'tests/sync.test.ts',
      'tests/developer.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--picking-waves'))
    files = [
      'tests/picking-waves.test.ts',
      'tests/web-api.test.ts',
      'tests/stock-locations.test.ts',
      'tests/domain.test.ts',
      'tests/payments.test.ts',
      'tests/shipping.test.ts',
      'tests/returns.test.ts',
      'tests/developer.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--picking-waves-only')) files = ['tests/picking-waves.test.ts'];
  if (process.argv.includes('--password-recovery-only'))
    files = ['tests/password-recovery.test.ts'];
  if (process.argv.includes('--password-recovery'))
    files = [
      'tests/password-recovery.test.ts',
      'tests/account-security.test.ts',
      'tests/workspace-mfa.test.ts',
      'tests/workspaces.test.ts',
      'tests/web-api.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--email-actions'))
    files = [
      'tests/email-actions.test.ts',
      'tests/email.test.ts',
      'tests/sms-automations.test.ts',
      'tests/operations.test.ts',
      'tests/automation-schedules.test.ts',
      'tests/developer.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--email-actions-only')) files = ['tests/email-actions.test.ts'];
  if (process.argv.includes('--email-only')) files = ['tests/email.test.ts'];
  if (process.argv.includes('--email-attachments'))
    files = [
      'tests/email-attachments.test.ts',
      'tests/email.test.ts',
      'tests/email-actions.test.ts',
      'tests/odoo-invoice-files.test.ts',
      'tests/invoices.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--email-attachments-only'))
    files = ['tests/email-attachments.test.ts'];
  if (process.argv.includes('--email'))
    files = [
      'tests/email.test.ts',
      'tests/integration-workspace.test.ts',
      'tests/developer.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--shopify-fulfillment'))
    files = [
      'tests/shopify-fulfillment.test.ts',
      'tests/shopify.test.ts',
      'tests/shopify-offers.test.ts',
      'tests/shopify-catalog.test.ts',
      'tests/shipping.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--shopify-oauth'))
    files = [
      'tests/shopify-order-read.test.ts',
      'tests/shopify-oauth.test.ts',
      'tests/shopify.test.ts',
      'tests/shopify-offers.test.ts',
      'tests/shopify-catalog.test.ts',
      'tests/shopify-fulfillment.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--shopify-oauth-only')) files = ['tests/shopify-oauth.test.ts'];
  if (process.argv.includes('--shopify-order-read-only'))
    files = ['tests/shopify-order-read.test.ts'];
  if (process.argv.includes('--shopify-subscriptions-only'))
    files = ['tests/shopify-subscriptions.test.ts'];
  if (process.argv.includes('--shopify-subscriptions'))
    files = [
      'tests/shopify-subscriptions.test.ts',
      'tests/shopify-webhooks.test.ts',
      'tests/shopify-order-read.test.ts',
      'tests/shopify.test.ts',
      'tests/shopify-oauth.test.ts',
      'tests/shopify-fulfillment.test.ts',
      'tests/sync.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--shopify-webhooks-only')) files = ['tests/shopify-webhooks.test.ts'];
  if (process.argv.includes('--shopify-webhooks'))
    files = [
      'tests/shopify-webhooks.test.ts',
      'tests/shopify-order-read.test.ts',
      'tests/shopify.test.ts',
      'tests/shopify-oauth.test.ts',
      'tests/shopify-fulfillment.test.ts',
      'tests/sync.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--shopify-order-read'))
    files = [
      'tests/shopify-order-read.test.ts',
      'tests/shopify.test.ts',
      'tests/shopify-oauth.test.ts',
      'tests/shopify-fulfillment.test.ts',
      'tests/imports.test.ts',
      'tests/sync.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--shopify-fulfillment-only'))
    files = ['tests/shopify-fulfillment.test.ts'];
  if (process.argv.includes('--sales-reports-engine-only')) files=['tests/sales-reports.test.ts'];
  if (process.argv.includes('--sales-reports-safety-only')) files=['tests/sales-reports-safety.test.ts'];
  if (process.argv.includes('--sales-reports-only')) files=['tests/sales-reports.test.ts','tests/sales-reports-safety.test.ts'];
  if (process.argv.includes('--order-source-lines-only'))
    files = ['tests/order-source-lines.test.ts'];
  if (process.argv.includes('--order-source-import-regression-only'))
    files = ['tests/shopify.test.ts', 'tests/imports.test.ts'];
  if (process.argv.includes('--shopify-source-fulfillment-only'))
    files = ['tests/shopify-source-fulfillment.test.ts'];
  if (process.argv.includes('--shopify-source-fulfillment-safety-only'))
    files = ['tests/shopify-source-fulfillment-safety.test.ts'];
  if (process.argv.includes('--shopify-source-fulfillment'))
    files = [
      'tests/order-source-lines.test.ts',
      'tests/shopify-source-fulfillment.test.ts',
      'tests/shopify-source-fulfillment-safety.test.ts',
      'tests/shopify-fulfillment.test.ts',
    ];
  if (process.argv.includes('--prestashop-status-only'))
    files = ['tests/prestashop-status.test.ts'];
  if (process.argv.includes('--prestashop-status'))
    files = [
      'tests/prestashop-status.test.ts',
      'tests/order-status.test.ts',
      'tests/prestashop.test.ts',
      'tests/prestashop-offers.test.ts',
      'tests/imports.test.ts',
      'tests/sync.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--workspace-billing-only'))
    files = ['tests/workspace-billing.test.ts'];
  if (process.argv.includes('--workspace-billing'))
    files = [
      'tests/workspace-billing.test.ts',
      'tests/workspaces.test.ts',
      'tests/workspace-mfa.test.ts',
      'tests/domain.test.ts',
      'tests/imports.test.ts',
      'tests/sync.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--backup-only')) files = ['tests/backup.test.ts'];
  if (process.argv.includes('--integration-workspace-only'))
    files = ['tests/integration-workspace.test.ts'];
  if (process.argv.includes('--integration-workspace'))
    files = [
      'tests/integration-workspace.test.ts',
      'tests/integrations.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--amazon-offers-only')) files = ['tests/amazon-offers.test.ts'];
  if (process.argv.includes('--amazon-offers'))
    files = [
      'tests/amazon-offers.test.ts',
      'tests/offer-sync.test.ts',
      'tests/offers.test.ts',
      'tests/amazon-catalog.test.ts',
      'tests/amazon.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--amazon-catalog-only')) files = ['tests/amazon-catalog.test.ts'];
  if (process.argv.includes('--amazon-catalog'))
    files = [
      'tests/amazon-catalog.test.ts',
      'tests/amazon.test.ts',
      'tests/amazon-imports.test.ts',
      'tests/catalog-source.test.ts',
      'tests/ebay-catalog.test.ts',
      'tests/shopify-catalog.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--amazon-oauth-only')) files = ['tests/amazon-oauth.test.ts'];
  if (process.argv.includes('--amazon-oauth'))
    files = [
      'tests/amazon-oauth.test.ts',
      'tests/amazon.test.ts',
      'tests/amazon-imports.test.ts',
      'tests/amazon-catalog.test.ts',
      'tests/amazon-offers.test.ts',
      'tests/ebay-oauth.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--amazon-fulfillment-only'))
    files = ['tests/amazon-fulfillment.test.ts'];
  if (process.argv.includes('--amazon-fulfillment'))
    files = [
      'tests/amazon-fulfillment.test.ts',
      'tests/amazon.test.ts',
      'tests/amazon-imports.test.ts',
      'tests/amazon-oauth.test.ts',
      'tests/amazon-offers.test.ts',
      'tests/shipping.test.ts',
      'tests/backup.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--catalog-ai-only')) files = ['tests/catalog-ai.test.ts'];
  if (process.argv.includes('--catalog-ai'))
    files = [
      'tests/catalog-ai.test.ts',
      'tests/catalog.test.ts',
      'tests/domain.test.ts',
      'tests/workspaces.test.ts',
      'tests/backup.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--deepl-only')) files = ['tests/deepl.test.ts'];
  if (process.argv.includes('--deepl'))
    files = [
      'tests/deepl.test.ts',
      'tests/catalog-ai.test.ts',
      'tests/integration-workspace.test.ts',
      'tests/integrations.test.ts',
      'tests/catalog.test.ts',
      'tests/domain.test.ts',
      'tests/workspaces.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--deepl-batches-only')) files = ['tests/deepl-batches.test.ts'];
  if (process.argv.includes('--deepl-batches'))
    files = [
      'tests/deepl-batches.test.ts',
      'tests/deepl.test.ts',
      'tests/catalog-ai.test.ts',
      'tests/catalog.test.ts',
      'tests/domain.test.ts',
      'tests/workspaces.test.ts',
      'tests/backup.test.ts',
      'tests/integration-workspace.test.ts',
    ];
  if (process.argv.includes('--shopify-translations'))
    files = [
      'tests/shopify-translations.test.ts',
      'tests/shopify-oauth.test.ts',
      'tests/shopify.test.ts',
      'tests/shopify-catalog.test.ts',
      'tests/shopify-offers.test.ts',
    ];
  if (process.argv.includes('--shopify-translation-batches-only'))
    files = ['tests/shopify-translation-batches.test.ts'];
  if (process.argv.includes('--shopify-translation-batches'))
    files = [
      'tests/shopify-translation-batches.test.ts',
      'tests/shopify-translation-publication.test.ts',
      'tests/shopify-translations.test.ts',
      'tests/shopify-oauth.test.ts',
      'tests/shopify-offers.test.ts',
      'tests/deepl-batches.test.ts',
      'tests/catalog-ai.test.ts',
      'tests/catalog.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--shopify-translation-publication-only'))
    files = ['tests/shopify-translation-publication.test.ts'];
  if (process.argv.includes('--shopify-translation-publication'))
    files = [
      'tests/shopify-translation-publication.test.ts',
      'tests/shopify-translations.test.ts',
      'tests/shopify-oauth.test.ts',
      'tests/shopify-offers.test.ts',
      'tests/deepl-batches.test.ts',
      'tests/catalog-ai.test.ts',
      'tests/catalog.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--customer-messages-only'))
    files = ['tests/customer-messages.test.ts'];
  if (process.argv.includes('--customer-message-workflows-only'))
    files = ['tests/customer-message-workflows.test.ts'];
  if (process.argv.includes('--customer-message-workflows-safety-only'))
    files = ['tests/customer-message-workflows-safety.test.ts'];
  if (process.argv.includes('--customer-message-workflows-compatibility'))
    files = [
      'tests/customer-messages.test.ts',
      'tests/operations.test.ts',
      'tests/automation-schedules.test.ts',
      'tests/portal.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--customer-message-workflows'))
    files = [
      'tests/customer-message-workflows.test.ts',
      'tests/customer-message-workflows-safety.test.ts',
      'tests/customer-messages.test.ts',
      'tests/operations.test.ts',
      'tests/automation-schedules.test.ts',
      'tests/portal.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--payment-import-effects-only'))
    files = ['tests/payment-import-effects.test.ts'];
  if (process.argv.includes('--payment-import-policy-only'))
    files = ['tests/payment-import-policy.test.ts'];
  if (process.argv.includes('--payment-import-source-lock-only'))
    files = ['tests/payment-import-source-lock.test.ts'];
  if (process.argv.includes('--payment-import-batches-only'))
    files = ['tests/payment-import-batches.test.ts'];
  if (process.argv.includes('--payment-imports-only')) files = ['tests/payment-imports.test.ts'];
  if (process.argv.includes('--payment-imports'))
    files = [
      'tests/bank-cod-csv.test.ts',
      'tests/payment-import-effects.test.ts',
      'tests/payment-import-policy.test.ts',
      'tests/payment-import-source-lock.test.ts',
      'tests/payment-import-batches.test.ts',
      'tests/payment-imports.test.ts',
      'tests/payments.test.ts',
      'tests/source-payments.test.ts',
      'tests/returns.test.ts',
      'tests/order-status.test.ts',
      'tests/operations.test.ts',
      'tests/automation-schedules.test.ts',
      'tests/portal.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--product-rules-only')) files = ['tests/product-rules.test.ts'];
  if (process.argv.includes('--product-rule-hooks-only'))
    files = ['tests/product-rule-hooks.test.ts'];
  if (process.argv.includes('--product-rule-locks-only'))
    files = ['tests/product-rule-locks.test.ts'];
  if (process.argv.includes('--product-rule-sources-only'))
    files = ['tests/product-rule-sources.test.ts'];
  if (process.argv.includes('--product-rules'))
    files = [
      'tests/product-rules.test.ts',
      'tests/product-rule-hooks.test.ts',
      'tests/product-rule-locks.test.ts',
      'tests/catalog.test.ts',
      'tests/catalog-source.test.ts',
      'tests/catalog-ai.test.ts',
      'tests/deepl.test.ts',
      'tests/deepl-batches.test.ts',
      'tests/odoo-images.test.ts',
      'tests/odoo-catalog-sync.test.ts',
      'tests/b2b-network.test.ts',
      'tests/supplier-catalog.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--customer-messages'))
    files = [
      'tests/customer-messages.test.ts',
      'tests/portal.test.ts',
      'tests/returns.test.ts',
      'tests/account-security.test.ts',
      'tests/developer.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--order-fields-only')) files = ['tests/order-fields.test.ts'];
  if (process.argv.includes('--order-fields-safety-only'))
    files = ['tests/order-fields-safety.test.ts'];
  if (process.argv.includes('--order-fields-public-only'))
    files = ['tests/order-fields-public.test.ts'];
  if (process.argv.includes('--order-field-batches-only'))
    files = ['tests/order-field-batches.test.ts'];
  if (process.argv.includes('--order-field-mappings-only'))
    files = ['tests/order-field-mappings.test.ts'];
  if (process.argv.includes('--order-field-mappings-safety-only'))
    files = ['tests/order-field-mappings-safety.test.ts'];
  if (process.argv.includes('--order-field-mappings'))
    files = [
      'tests/order-field-mappings.test.ts',
      'tests/order-field-mappings-safety.test.ts',
      'tests/order-field-batches.test.ts',
      'tests/order-fields.test.ts',
      'tests/order-fields-safety.test.ts',
      'tests/order-fields-public.test.ts',
      'tests/imports.test.ts',
      'tests/shopify-order-read.test.ts',
      'tests/shopify-webhooks.test.ts',
      'tests/shopify-oauth.test.ts',
      'tests/sync.test.ts',
      'tests/source-payments.test.ts',
      'tests/domain.test.ts',
      'tests/developer.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--order-field-batches-safety-only'))
    files = ['tests/order-field-batches-safety.test.ts'];
  if (process.argv.includes('--order-field-batches-parser-only'))
    files = ['tests/order-field-batches-csv.test.ts'];
  if (process.argv.includes('--order-field-batches'))
    files = [
      'tests/order-field-batches-csv.test.ts',
      'tests/order-field-batches.test.ts',
      'tests/order-field-batches-safety.test.ts',
      'tests/order-fields.test.ts',
      'tests/order-fields-safety.test.ts',
      'tests/order-fields-public.test.ts',
      'tests/domain.test.ts',
      'tests/developer.test.ts',
      'tests/portal.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--order-fields'))
    files = [
      'tests/order-fields.test.ts',
      'tests/order-fields-safety.test.ts',
      'tests/order-fields-public.test.ts',
      'tests/domain.test.ts',
      'tests/developer.test.ts',
      'tests/portal.test.ts',
      'tests/backup.test.ts',
    ];
  if (process.argv.includes('--catalog-bulk-edit-only'))
    files = ['tests/catalog-bulk-edit.test.ts'];
  if (process.argv.includes('--catalog-bulk-edit-safety-only'))
    files = ['tests/catalog-bulk-edit-safety.test.ts'];
  if (process.argv.includes('--catalog-bulk-edit-compatibility'))
    files = ['tests/catalog.test.ts', 'tests/product-rules.test.ts', 'tests/developer.test.ts'];
  if (process.argv.includes('--catalog-bulk-edit'))
    files = [
      'tests/catalog-bulk-edit.test.ts',
      'tests/catalog-bulk-edit-safety.test.ts',
      'tests/catalog.test.ts',
      'tests/product-rules.test.ts',
      'tests/developer.test.ts',
    ];
  const isolateSuites =
    process.argv.includes('--catalog-stock-legacy-receive-close169-on-group-compat-only') ||
    process.argv.includes('--product-rules-price-tags170-compat-only') ||
    process.argv.includes('--catalog-stock-control169-metadata-regression-only') ||
    process.argv.includes('--catalog-stock-control169-physical-regression-only') ||
    process.argv.includes('--catalog-stock-control169-count-native-regression-only') ||
    process.argv.includes('--return-destinations-core-regression-only') ||
    process.argv.includes('--return-destinations-interface-regression-only') ||
    process.argv.includes('--warehouse-policy-locks-only') ||
    process.argv.includes('--warehouse-policy-intake-regression-only') ||
    process.argv.includes('--return-destinations-acceptance-only') ||
    process.argv.includes('--warehouse-policy-regression-only') ||
    process.argv.includes('--product-catalogs-regression-only') ||
    process.argv.includes('--order-parcel-returns-regression-only') ||
    process.argv.some((arg) => arg.startsWith('--language-file-import')) ||
    process.argv.some((arg) => arg.startsWith('--price-file-import')) ||
    process.argv.some((arg) => arg.startsWith('--price-matrix-import')) ||
    process.argv.some((arg) => arg.startsWith('--stock-file-import')) ||
    process.argv.some((arg) => arg.startsWith('--b2b-return-local-origins')) ||
    process.argv.some((arg) => arg.startsWith('--b2b-dropshipping-returns')) ||
    process.argv.some((arg) => arg.startsWith('--source-order-intent')) ||
    process.argv.some((arg) => arg.startsWith('--b2b-external-order-intent')) ||
    process.argv.includes('--b2b-dropshipping-only') ||
    process.argv.includes('--b2b-dropshipping-compatibility') ||
    process.argv.includes('--b2b-dropshipping-shipping-compatibility') ||
    process.argv.some((arg) => arg.startsWith('--sales-reports')) ||
    process.argv.some((arg) => arg.startsWith('--shopify-source-fulfillment')) ||
    process.argv.some((arg) => arg.startsWith('--order-source-lines')) ||
    process.argv.some((arg) => arg.startsWith('--order-merge')) ||
    process.argv.some((arg) => arg.startsWith('--replenishment')) ||
    process.argv.some((arg) => arg.startsWith('--catalog-file-import')) ||
    process.argv.some((arg) => arg.startsWith('--supplier-file-sources')) ||
    process.argv.some((arg) => arg.startsWith('--catalog-export')) ||
    process.argv.some((arg) => arg.startsWith('--stocktake-scans')) ||
    process.argv.some((arg) => arg.startsWith('--stocktake-adjustments')) ||
    process.argv.some((arg) => arg.startsWith('--warehouse-document-register')) ||
    process.argv.some((arg) => arg.startsWith('--wms-lots-')) ||
    process.argv.some((arg) => arg.startsWith('--wms-stocktakes-')) ||
    process.argv.includes('--packing-workstation-compatibility') ||
    process.argv.some((arg) => arg.startsWith('--product-translation-bulk-edit')) ||
    process.argv.includes('--price-bulk-edit') ||
    process.argv.includes('--price-bulk-edit-only') ||
    process.argv.includes('--price-bulk-edit-compatibility') ||
    process.argv.includes('--price-bulk-edit-safety-only') ||
    process.argv.includes('--price-bulk-edit-repricing-only') ||
    process.argv.includes('--inventory-bulk-edit') ||
    process.argv.includes('--inventory-bulk-edit-only') ||
    process.argv.includes('--product-sku') ||
    process.argv.includes('--product-sku-only') ||
    process.argv.includes('--product-logistics') ||
    process.argv.includes('--product-logistics-only') ||
    process.argv.includes('--catalog-bulk-edit') ||
    process.argv.includes('--catalog-bulk-edit-compatibility') ||
    process.argv.includes('--customer-message-workflows') ||
    process.argv.includes('--customer-message-workflows-compatibility') ||
    process.argv.includes('--product-rules') ||
    process.argv.includes('--payment-imports') ||
    process.argv.includes('--order-field-batches') ||
    process.argv.includes('--order-field-mappings') ||
    process.argv.includes('--order-fields');
  if (process.argv.includes('--product-logistics-only'))
    files = ['tests/product-logistics.test.ts', 'tests/product-logistics-safety.test.ts'];
  if (process.argv.includes('--product-logistics'))
    files = [
      'tests/product-logistics.test.ts',
      'tests/product-logistics-safety.test.ts',
      'tests/catalog-bulk-edit.test.ts',
      'tests/catalog-bulk-edit-safety.test.ts',
      'tests/catalog.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--product-sku-only'))
    files = [
      'tests/product-sku.test.ts',
      'tests/product-sku-safety.test.ts',
      'tests/product-sku-flows.test.ts',
    ];
  if (process.argv.includes('--product-sku'))
    files = [
      'tests/product-sku.test.ts',
      'tests/product-sku-safety.test.ts',
      'tests/product-sku-flows.test.ts',
      'tests/catalog-bulk-edit.test.ts',
      'tests/catalog-bulk-edit-safety.test.ts',
      'tests/catalog.test.ts',
      'tests/picking-waves.test.ts',
      'tests/catalog-source.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--inventory-bulk-edit-only'))
    files = [
      'tests/inventory-bulk-edit.test.ts',
      'tests/inventory-bulk-edit-safety.test.ts',
      'tests/inventory-bulk-edit-flows.test.ts',
    ];
  if (process.argv.includes('--inventory-bulk-edit'))
    files = [
      'tests/inventory-bulk-edit.test.ts',
      'tests/inventory-bulk-edit-safety.test.ts',
      'tests/inventory-bulk-edit-flows.test.ts',
      'tests/stock-locations.test.ts',
      'tests/warehouse.test.ts',
      'tests/stocktakes.test.ts',
      'tests/picking-waves.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--price-bulk-edit-only'))
    files = [
      'tests/price-bulk-edit.test.ts',
      'tests/price-bulk-edit-safety.test.ts',
      'tests/price-bulk-edit-flows.test.ts',
    ];
  if (process.argv.includes('--price-bulk-edit-compatibility'))
    files = ['tests/pricing.test.ts', 'tests/repricing.test.ts', 'tests/developer.test.ts'];
  if (process.argv.includes('--price-bulk-edit-safety-only'))
    files = ['tests/price-bulk-edit-safety.test.ts'];
  if (process.argv.includes('--price-bulk-edit-repricing-only'))
    files = ['tests/repricing.test.ts'];
  if (process.argv.includes('--price-bulk-edit'))
    files = [
      'tests/price-bulk-edit.test.ts',
      'tests/price-bulk-edit-safety.test.ts',
      'tests/price-bulk-edit-flows.test.ts',
      'tests/pricing.test.ts',
      'tests/repricing.test.ts',
      'tests/developer.test.ts',
    ];
  const translationBulkSuites = [
    'tests/product-translation-bulk-edit.test.ts',
    'tests/product-translation-bulk-edit-safety.test.ts',
    'tests/product-translation-bulk-edit-flows.test.ts',
  ];
  const translationRelatedSuites = [
    'tests/catalog-ai.test.ts',
    'tests/deepl.test.ts',
    'tests/deepl-batches.test.ts',
    'tests/shopify-translations.test.ts',
    'tests/shopify-translation-publication.test.ts',
    'tests/shopify-translation-batches.test.ts',
    'tests/product-rules.test.ts',
    'tests/product-rule-hooks.test.ts',
    'tests/product-rule-locks.test.ts',
    'tests/developer.test.ts',
  ];
  if (process.argv.includes('--product-translation-bulk-edit'))
    files = [...translationBulkSuites, ...translationRelatedSuites];
  if (process.argv.includes('--product-translation-bulk-edit-only')) files = translationBulkSuites;
  if (process.argv.includes('--product-translation-bulk-edit-compatibility'))
    files = translationRelatedSuites;
  if (process.argv.includes('--product-translation-bulk-edit-main-only'))
    files = [translationBulkSuites[0]];
  if (process.argv.includes('--language-file-import-only'))
    files = ['tests/language-file-import-parse.test.ts', 'tests/language-file-import.test.ts'];
  if (process.argv.includes('--language-file-import-api-only'))
    files = ['tests/language-file-import.test.ts'];
  if (process.argv.includes('--product-translation-bulk-edit-safety-only'))
    files = [translationBulkSuites[1]];
  if (process.argv.includes('--product-translation-bulk-edit-flows-only'))
    files = [translationBulkSuites[2]];
  if (process.argv.includes('--packing-workstation-safety-only'))
    files = ['tests/packing-workstation-safety.test.ts'];
  if (process.argv.includes('--wms-lots-only'))
    files = [
      'tests/wms-lots-values.test.ts',
      'tests/wms-lots-safety.test.ts',
      'tests/wms-lots-flow.test.ts',
    ];
  if (process.argv.includes('--wms-stocktakes-only'))
    files = [
      'tests/wms-stocktakes-values.test.ts',
      'tests/wms-stocktakes-safety.test.ts',
      'tests/wms-stocktakes-flow.test.ts',
      'tests/wms-stocktakes-concurrency.test.ts',
    ];
  if (process.argv.includes('--wms-stocktakes-concurrency-only'))
    files = ['tests/wms-stocktakes-concurrency.test.ts'];
  if (process.argv.includes('--stocktake-scans-only'))
    files = ['tests/stocktake-scans-engine.test.ts', 'tests/stocktake-scans-safety.test.ts'];
  if (process.argv.includes('--catalog-export-only'))
    files = ['tests/catalog-export.test.ts', 'tests/catalog-export-safety.test.ts'];
  if (process.argv.includes('--catalog-export-catalogs-only'))
    files = ['tests/catalog-export-catalogs.test.ts'];
  if (process.argv.includes('--catalog-export-catalogs-migration-only'))
    files = ['tests/catalog-export-catalogs-migration.test.ts'];
  if (process.argv.includes('--catalog-export-catalogs-contract-only'))
    files = ['tests/catalog-export-catalogs-contract.test.ts'];
  if (process.argv.includes('--catalog-export-historical-regression-only'))
    files = ['tests/catalog-export-sources.test.ts', 'tests/catalog-export-sources-safety.test.ts', 'tests/catalog-export-safety.test.ts'];
  if (process.argv.includes('--catalog-file-import-only'))
    files = ['tests/catalog-file-import.test.ts', 'tests/catalog-file-import-safety.test.ts'];
  if (process.argv.includes('--catalog-file-import-mapped-only'))
    files = [
      'tests/catalog-mapped-xml.test.ts',
      'tests/catalog-mapped-xml-import.test.ts',
      'tests/catalog-file-import.test.ts',
      'tests/catalog-file-import-safety.test.ts',
    ];
  if (process.argv.includes('--replenishment-only'))
    files = [
      'tests/replenishment-plans.test.ts',
      'tests/replenishment-plans-safety.test.ts',
      'tests/replenishment-wms.test.ts',
    ];
  if (process.argv.includes('--replenishment-wms-only'))
    files = ['tests/replenishment-wms.test.ts'];
  if (process.argv.includes('--replenishment-engine-only'))
    files = ['tests/replenishment-plans.test.ts'];
  if (process.argv.includes('--replenishment-automations-engine-only'))
    files = ['tests/replenishment-automations.test.ts'];
  if (process.argv.includes('--replenishment-automations-safety-only'))
    files = ['tests/replenishment-automations-safety.test.ts'];
  if (process.argv.includes('--replenishment-automations-only'))
    files = [
      'tests/replenishment-automations.test.ts',
      'tests/replenishment-automations-safety.test.ts',
    ];
  if (process.argv.includes('--replenishment-automations-compatibility'))
    files = [
      'tests/replenishment-plans.test.ts',
      'tests/replenishment-plans-safety.test.ts',
      'tests/replenishment-wms.test.ts',
      'tests/replenishment-forecast.test.ts',
      'tests/replenishment-forecast-safety.test.ts',
      'tests/replenishment-append.test.ts',
      'tests/replenishment-append-safety.test.ts',
      'tests/purchasing.test.ts',
      'tests/domain.test.ts',
      'tests/product-rules.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--replenishment-forecast-engine-only'))
    files = ['tests/replenishment-forecast.test.ts'];
  if (process.argv.includes('--replenishment-forecast-safety-only'))
    files = ['tests/replenishment-forecast-safety.test.ts'];
  if (process.argv.includes('--replenishment-forecast-only'))
    files = ['tests/replenishment-forecast.test.ts', 'tests/replenishment-forecast-safety.test.ts'];
  if (process.argv.includes('--replenishment-append-engine-only'))
    files = ['tests/replenishment-append.test.ts'];
  if (process.argv.includes('--replenishment-append-safety-only'))
    files = ['tests/replenishment-append-safety.test.ts'];
  if (process.argv.includes('--replenishment-append-only'))
    files = ['tests/replenishment-append.test.ts', 'tests/replenishment-append-safety.test.ts'];
  if (process.argv.includes('--replenishment-append-compatibility'))
    files = [
      'tests/replenishment-plans.test.ts',
      'tests/replenishment-plans-safety.test.ts',
      'tests/replenishment-wms.test.ts',
      'tests/replenishment-forecast.test.ts',
      'tests/replenishment-forecast-safety.test.ts',
      'tests/purchasing.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--replenishment-forecast-compatibility'))
    files = [
      'tests/replenishment-plans.test.ts',
      'tests/replenishment-plans-safety.test.ts',
      'tests/replenishment-wms.test.ts',
      'tests/domain.test.ts',
      'tests/shipping.test.ts',
      'tests/returns.test.ts',
      'tests/purchasing.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--replenishment-safety-only'))
    files = ['tests/replenishment-plans-safety.test.ts'];
  if (process.argv.includes('--replenishment-compatibility'))
    files = [
      'tests/purchasing.test.ts',
      'tests/supplier-catalog.test.ts',
      'tests/b2b-network-orders.test.ts',
      'tests/b2b-network-returns.test.ts',
      'tests/developer.test.ts',
      'tests/web-api.test.ts',
    ];
  if (process.argv.includes('--catalog-file-import-engine-only'))
    files = ['tests/catalog-file-import.test.ts'];
  if (process.argv.includes('--catalog-file-import-safety-only'))
    files = ['tests/catalog-file-import-safety.test.ts'];
  if (process.argv.includes('--catalog-file-import-logistics-only'))
    files = ['tests/product-logistics.test.ts'];
  if (process.argv.includes('--catalog-file-import-compatibility'))
    files = [
      'tests/catalog.test.ts',
      'tests/product-rules.test.ts',
      'tests/product-sku-flows.test.ts',
      'tests/product-logistics.test.ts',
      'tests/catalog-export.test.ts',
      'tests/developer.test.ts',
      'tests/web-api.test.ts',
    ];
  if (process.argv.includes('--catalog-export-compatibility'))
    files = ['tests/catalog.test.ts', 'tests/developer.test.ts', 'tests/web-api.test.ts'];
  if (process.argv.includes('--catalog-export-profiles-only'))
    files = [
      'tests/catalog-export-profiles.test.ts',
      'tests/catalog-export-profiles-safety.test.ts',
    ];
  if (process.argv.includes('--catalog-export-profiles-safety-only'))
    files = ['tests/catalog-export-profiles-safety.test.ts'];
  if (process.argv.includes('--catalog-export-profiles-acceptance'))
    files = [
      'tests/catalog-export-profiles.test.ts',
      'tests/catalog-export-profiles-safety.test.ts',
      'tests/catalog-export.test.ts',
      'tests/catalog-export-safety.test.ts',
      'tests/catalog.test.ts',
      'tests/developer.test.ts',
      'tests/web-api.test.ts',
    ];
  if (process.argv.includes('--catalog-export-sources-only'))
    files = ['tests/catalog-export-sources.test.ts', 'tests/catalog-export-sources-safety.test.ts'];
  if (process.argv.includes('--catalog-export-sources-acceptance'))
    files = [
      'tests/catalog-export-sources.test.ts',
      'tests/catalog-export-sources-safety.test.ts',
      'tests/catalog-export-profiles.test.ts',
      'tests/catalog-export-profiles-safety.test.ts',
      'tests/catalog-export.test.ts',
      'tests/catalog-export-safety.test.ts',
      'tests/pricing.test.ts',
      'tests/inventory-pages.test.ts',
      'tests/developer.test.ts',
      'tests/web-api.test.ts',
    ];
  if (process.argv.includes('--stocktake-scans-recovery-only'))
    files = ['tests/stocktake-scans-recovery.test.ts'];
  if (process.argv.includes('--stocktake-scans-engine-only'))
    files = ['tests/stocktake-scans-engine.test.ts'];
  if (process.argv.includes('--stocktake-scans-safety-only'))
    files = ['tests/stocktake-scans-safety.test.ts'];
  if (process.argv.includes('--stocktake-scans-boundary-only'))
    files = ['tests/stocktake-scans-boundary.test.ts'];
  if (process.argv.includes('--stocktake-scans-compatibility'))
    files = [
      'tests/stocktakes.test.ts',
      'tests/wms-stocktakes-values.test.ts',
      'tests/wms-stocktakes-safety.test.ts',
      'tests/wms-stocktakes-flow.test.ts',
      'tests/wms-stocktakes-concurrency.test.ts',
      'tests/wms-lots-flow.test.ts',
      'tests/wms-lots-safety.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--wms-stocktakes-validation-only'))
    files = ['tests/wms-validation-scopes.test.ts', 'tests/wms-validation-scopes-safety.test.ts'];
  if (process.argv.includes('--wms-stocktakes-boundary-only'))
    files = ['tests/wms-stocktakes-boundary.test.ts'];
  if (process.argv.includes('--wms-stocktakes-values-only'))
    files = ['tests/wms-stocktakes-values.test.ts'];
  if (process.argv.includes('--wms-stocktakes-safety-only'))
    files = ['tests/wms-stocktakes-safety.test.ts'];
  if (process.argv.includes('--wms-stocktakes-flow-only'))
    files = ['tests/wms-stocktakes-flow.test.ts'];
  if (process.argv.includes('--wms-stocktakes-compatibility'))
    files = [
      'tests/stocktakes.test.ts',
      'tests/wms-lots-flow.test.ts',
      'tests/wms-lots-safety.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--wms-lots-safety-only')) files = ['tests/wms-lots-safety.test.ts'];
  if (process.argv.includes('--wms-lots-flow-only')) files = ['tests/wms-lots-flow.test.ts'];
  if (process.argv.includes('--wms-lots-valuation-classification-only'))
    files = ['tests/warehouse-valuation-classification.test.ts'];
  if (process.argv.includes('--wms-lots-valuation-classification-regression-only'))
    files = ['tests/wms-lots-values.test.ts', 'tests/wms-lots-safety.test.ts', 'tests/wms-lots-flow.test.ts'];
  if (process.argv.includes('--wms-lots-compatibility'))
    files = [
      'tests/domain.test.ts',
      'tests/stock-locations.test.ts',
      'tests/warehouse.test.ts',
      'tests/purchasing.test.ts',
      'tests/returns.test.ts',
      'tests/shipping.test.ts',
      'tests/picking-waves.test.ts',
      'tests/b2b-network-orders.test.ts',
      'tests/b2b-network-returns.test.ts',
      'tests/packing-workstation-safety.test.ts',
      'tests/packing-shipping-binding.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--packing-shipping-binding-only'))
    files = ['tests/packing-shipping-binding.test.ts'];
  if (process.argv.includes('--packing-workstation-compatibility'))
    files = [
      'tests/domain.test.ts',
      'tests/shipping.test.ts',
      'tests/dpd.test.ts',
      'tests/picking-waves.test.ts',
      'tests/operations.test.ts',
      'tests/developer.test.ts',
    ];
  if (process.argv.includes('--order-merges'))
    files = [
      'tests/order-merge-counters.test.ts',
      'tests/order-merges.test.ts',
      'tests/order-merge-custody.test.ts',
      'tests/order-merge-integration.test.ts',
      'tests/order-merge-dashboard.test.ts',
      'tests/order-merge-b2b.test.ts',
    ];
  if (process.argv.includes('--order-merge-integration-only'))
    files = ['tests/order-merge-integration.test.ts'];
  if (process.argv.includes('--order-merge-counters-only'))
    files = ['tests/order-merge-counters.test.ts'];
  if (process.argv.includes('--b2b-catalog-scopes'))
    files = [
      'tests/b2b-catalog-scope.test.ts',
      'tests/b2b-catalog-scope-contract.test.ts',
      'tests/b2b-catalog-scope-adapters.test.ts',
      'tests/b2b-catalog-network-scopes.test.ts',
      'tests/b2b-catalog-commerce-scopes.test.ts',
      'tests/b2b-catalog-dropshipping-scopes.test.ts',
      'tests/b2b-catalog-scope-migration.test.ts',
      'tests/b2b-catalog-bind-key-safety.test.ts',
      'tests/b2b-catalog-scope-component.test.mjs',
      'tests/b2b-catalog-bind-component.test.mjs',
      'tests/b2b-catalog-scope-app-component.test.mjs',
      'tests/b2b-network.test.ts',
      'tests/b2b-network-orders.test.ts',
    ];
  if (process.argv.includes('--order-merges-b2b-only')) files = ['tests/order-merge-b2b.test.ts'];
  if (process.argv.includes('--order-merges-b2b-compatibility')) files = ['tests/b2b.test.ts'];
  if (process.argv.includes('--order-merges-core-only')) files = ['tests/order-merges.test.ts'];
  if (process.argv.includes('--order-merges-custody-only'))
    files = ['tests/order-merge-custody.test.ts'];
  if (process.argv.includes('--order-merges-portal-only')) files = ['tests/portal.test.ts'];
  if (process.argv.includes('--order-merges-compatibility'))
    files = [
      'tests/domain.test.ts',
      'tests/payments.test.ts',
      'tests/source-payments.test.ts',
      'tests/portal.test.ts',
      'tests/order-status.test.ts',
      'tests/customer-message-workflows.test.ts',
      'tests/returns.test.ts',
    ];
  if (process.argv.includes('--order-merge-dashboard-only'))
    files = ['tests/order-merge-dashboard.test.ts'];
  if (process.argv.includes('--price-file-import-only'))
    files = ['tests/price-file-import.test.ts', 'tests/price-file-import-safety.test.ts'];
  if (process.argv.includes('--price-file-import-compatibility'))
    files = [
      'tests/price-bulk-edit.test.ts',
      'tests/price-bulk-edit-safety.test.ts',
      'tests/price-bulk-edit-flows.test.ts',
      'tests/catalog-file-import.test.ts',
      'tests/catalog-file-import-safety.test.ts',
    ];
  if (process.argv.includes('--price-matrix-import-only'))
    files = ['tests/price-matrix-import.test.ts', 'tests/price-matrix-import-safety.test.ts'];
  if (process.argv.includes('--price-matrix-import-compatibility'))
    files = [
      'tests/price-file-import.test.ts',
      'tests/price-file-import-safety.test.ts',
      'tests/price-bulk-edit.test.ts',
      'tests/price-bulk-edit-safety.test.ts',
      'tests/price-bulk-edit-flows.test.ts',
      'tests/catalog-file-import.test.ts',
      'tests/catalog-file-import-safety.test.ts',
    ];
  if (process.argv.includes('--stock-file-import-only'))
    files = [
      'tests/stock-file-import-parse.test.ts',
      'tests/stock-file-import.test.ts',
      'tests/stock-file-import-safety.test.ts',
      'tests/stock-file-import-aba.test.ts',
      'tests/stock-file-import-capacity.test.ts',
      'tests/stock-file-import-identity-capacity-safety.test.ts',
    ];
  if (process.argv.includes('--stock-file-import-capacity-only'))
    files = ['tests/stock-file-import-capacity.test.ts'];
  if (process.argv.includes('--stock-file-import-identity-only'))
    files = ['tests/stock-file-import-identity-capacity-safety.test.ts'];
  if (process.argv.includes('--stock-file-import-compatibility'))
    files = [
      'tests/inventory-bulk-edit.test.ts',
      'tests/inventory-bulk-edit-safety.test.ts',
      'tests/inventory-bulk-edit-flows.test.ts',
      'tests/wms-stocktakes-flow.test.ts',
      'tests/wms-stocktakes-safety.test.ts',
      'tests/wms-stocktakes-concurrency.test.ts',
      'tests/wms-stocktakes-boundary.test.ts',
      'tests/wms-stocktakes-values.test.ts',
      'tests/catalog-file-import.test.ts',
      'tests/catalog-file-import-safety.test.ts',
    ];
  if (process.argv.includes('--order-parcels-commercial-only'))
    files = ['tests/order-parcel-releases-safety.test.ts'];
  if (process.argv.includes('--return-assistant-only'))
    files = ['tests/return-assistant.test.ts', 'tests/return-assistant-safety.test.ts', 'tests/return-assistant-contract.test.ts'];
  if (process.argv.includes('--return-assistant-contract-only'))
    files = ['tests/return-assistant-contract.test.ts'];
  if (process.argv.includes('--return-destinations-config-only'))
    files = ['tests/warehouse-inventory-policies.test.ts', 'tests/return-destination-statuses.test.ts'];
  if (process.argv.includes('--return-destinations-core-regression-only'))
    files = ['tests/returns.test.ts', 'tests/return-assistant.test.ts', 'tests/return-assistant-safety.test.ts',
      'tests/b2b-return-local-origins-api.test.ts', 'tests/order-parcel-releases-safety.test.ts', 'tests/wms-lots-flow.test.ts'];
  if (process.argv.includes('--return-destinations-interface-regression-only'))
    files = ['tests/return-assistant-contract.test.ts', 'tests/return-assistant-queues.test.ts',
      'tests/return-assistant-queues-safety.test.ts', 'tests/return-assistant-queues-contract.test.ts',
      'tests/stock-locations.test.ts'];
  if (process.argv.includes('--return-destinations-only'))
    files = ['tests/return-destinations.test.ts'];
  if (process.argv.includes('--return-destinations-migration-only'))
    files = ['tests/return-destinations-migration.test.ts'];
  if (process.argv.includes('--warehouse-sellability-only'))
    files = ['tests/warehouse-sellability.test.ts'];
  if (process.argv.includes('--warehouse-parcel-policy-locks-only'))
    files = ['tests/warehouse-parcel-policy-locks.test.ts'];
  if (process.argv.includes('--warehouse-policy-locks-only'))
    files = ['tests/warehouse-parcel-policy-locks.test.ts', 'tests/warehouse-order-policy-locks.test.ts'];
  if (process.argv.includes('--warehouse-policy-intake-regression-only'))
    files = ['tests/warehouse-parcel-policy-locks.test.ts', 'tests/domain.test.ts', 'tests/return-assistant.test.ts',
      'tests/return-assistant-safety.test.ts', 'tests/b2b-return-local-origins-api.test.ts',
      'tests/order-parcel-releases-safety.test.ts'];
  if (process.argv.includes('--warehouse-policy-regression-only'))
    files = ['tests/domain.test.ts', 'tests/warehouse.test.ts', 'tests/returns.test.ts', 'tests/inventory-pages.test.ts', 'tests/offers.test.ts', 'tests/wms-lots-flow.test.ts'];
  if (process.argv.includes('--return-destinations-acceptance-only'))
    files = ['tests/warehouse-inventory-policies.test.ts', 'tests/return-destination-statuses.test.ts',
      'tests/warehouse-sellability.test.ts', 'tests/domain.test.ts', 'tests/warehouse.test.ts',
      'tests/returns.test.ts', 'tests/inventory-pages.test.ts', 'tests/offers.test.ts', 'tests/wms-lots-flow.test.ts'];
  if (process.argv.includes('--return-assistant-queues-only'))
    files = ['tests/return-assistant-queues.test.ts', 'tests/return-assistant-queues-safety.test.ts', 'tests/return-assistant-queues-contract.test.ts'];
  if (process.argv.includes('--product-catalogs-only'))
    files = ['tests/product-catalogs.test.ts', 'tests/product-catalog-adapters.test.ts'];
  if (process.argv.includes('--product-catalogs-migration-only'))
    files = ['tests/product-catalogs-migration.test.ts'];
  if (process.argv.includes('--product-catalogs-integrations-only'))
    files = ['tests/product-catalog-integrations.test.ts'];
  if (process.argv.includes('--product-catalogs-contract-only'))
    files = ['tests/product-catalogs-contract.test.ts'];
  if (process.argv.includes('--product-catalogs-capacity-only'))
    files = ['tests/product-catalogs-capacity.test.ts'];
  if (process.argv.includes('--product-catalogs-sql-safety-only'))
    files = ['tests/product-catalogs-sql-safety.test.ts'];
  if (process.argv.includes('--product-catalogs-catalog-only'))
    files = ['tests/catalog.test.ts'];
  if (process.argv.includes('--product-catalogs-regression-only'))
    files = ['tests/catalog.test.ts', 'tests/catalog-file-import.test.ts', 'tests/catalog-file-import-safety.test.ts', 'tests/pricing.test.ts', 'tests/domain.test.ts', 'tests/returns.test.ts', 'tests/repricing.test.ts', 'tests/repricing-schedules.test.ts'];
  if (process.argv.includes('--email-inbound-only'))
    files = ['tests/email-inbound.test.ts', 'tests/email-inbound-contract.test.ts'];
  if (process.argv.includes('--email-inbound-migration-only'))
    files = ['tests/email-inbound-migration.test.ts'];
  if (process.argv.includes('--email-inbound-protocol-only'))
    files = ['tests/email-inbound-protocol.test.ts'];
  if (process.argv.includes('--email-inbound-backup-only'))
    files = ['tests/email-inbound-backup.test.ts'];
  if (process.argv.includes('--email-inbound-regression-only'))
    files = ['tests/email.test.ts', 'tests/customer-messages.test.ts', 'tests/email-actions.test.ts', 'tests/email-attachments.test.ts'];
  if (process.argv.includes('--order-parcel-returns-regression-only'))
    files = ['tests/returns.test.ts','tests/b2b-return-local-origins-api.test.ts'];
  if (process.argv.includes('--stocktake-adjustments-only'))
    files = ['tests/stocktake-adjustments.test.ts'];
  if (process.argv.includes('--stocktake-adjustment-register-only'))
    files = ['tests/stocktake-adjustment-register.test.ts',
      'tests/stocktake-adjustment-register-contract.test.ts',
      'tests/stocktake-adjustment-register-component.test.mjs', 'tests/stocktake-adjustment-navigation-component165.test.mjs'];
  if (process.argv.includes('--stocktake-adjustment-register-backend-only'))
    files = ['tests/stocktake-adjustment-register.test.ts'];
  if (process.argv.includes('--stocktake-adjustment-register-contract-only'))
    files = ['tests/stocktake-adjustment-register-contract.test.ts'];
  if (process.argv.includes('--stocktake-adjustment-register-component-only'))
    files = ['tests/stocktake-adjustment-register-component.test.mjs', 'tests/stocktake-adjustment-navigation-component165.test.mjs'];
  if (process.argv.includes('--warehouse-document-register-only'))
    files = ['tests/warehouse-document-register.test.ts',
      'tests/warehouse-document-register-contract.test.ts',
      'tests/warehouse-document-register-component.test.mjs'];
  if (process.argv.includes('--warehouse-document-register-backend-only'))
    files = ['tests/warehouse-document-register.test.ts'];
  if (process.argv.includes('--warehouse-document-register-contract-only'))
    files = ['tests/warehouse-document-register-contract.test.ts'];
  if (process.argv.includes('--warehouse-document-register-component-only'))
    files = ['tests/warehouse-document-register-component.test.mjs'];
  if (process.argv.includes('--warehouse-automatic-wz-backend-only'))
    files = ['tests/warehouse-automatic-wz.test.ts'];
  if (process.argv.includes('--warehouse-automatic-wz-dpd-regression-only'))
    files = ['tests/dpd.test.ts'];
  if (process.argv.includes('--warehouse-automatic-wz-component-only'))
    files = ['tests/warehouse-automatic-wz-component.test.mjs'];
  if (process.argv.includes('--warehouse-automatic-wz-app-component-only'))
    files = ['tests/warehouse-automatic-wz-app-component.test.mjs'];
  if (process.argv.includes('--warehouse-automatic-wz-contract-only'))
    files = ['tests/warehouse-automatic-wz-contract.test.ts'];
  if (process.argv.includes('--warehouse-automatic-wz-only'))
    files = ['tests/warehouse-automatic-wz.test.ts', 'tests/warehouse-automatic-wz-contract.test.ts', 'tests/warehouse-automatic-wz-component.test.mjs', 'tests/warehouse-automatic-wz-app-component.test.mjs'];
  if (process.argv.includes('--stocktake-adjustments-component-only'))
    files = ['tests/stocktake-adjustments-component.test.mjs'];
  if (process.argv.includes('--stocktake-adjustments-contract-only'))
    files = ['tests/stocktake-adjustments-contract.test.ts'];
  if (process.argv.includes('--stocktake-adjustments-migration-only'))
    files = ['tests/stocktake-adjustments-migration.test.ts'];
  if (process.argv.includes('--stocktake-adjustments-legacy-safety-only'))
    files = ['tests/wms-stocktakes-safety.test.ts'];
  if (process.argv.includes('--stocktake-adjustments-regression-only'))
    files = ['tests/stocktakes.test.ts', 'tests/wms-stocktakes-flow.test.ts',
      'tests/wms-stocktakes-safety.test.ts', 'tests/wms-stocktakes-concurrency.test.ts'];
  if (process.argv.includes('--warehouse-wz-issuer-concurrency-only')) files = ['tests/warehouse-wz-issuer-concurrency.test.ts'];
  if (process.argv.includes('--warehouse-wz-issuer-safety-only')) files = ['tests/warehouse-wz-issuer-safety.test.ts'];
  if (process.argv.includes('--warehouse-wz-issued-app-component-only')) files = ['tests/warehouse-wz-issued-app-component.test.mjs'];
  if (process.argv.includes('--warehouse-wz-issuer-backend-only')) files = ['tests/warehouse-wz-issuer.test.ts'];
  if (process.argv.includes('--warehouse-wz-issuer-contract-only')) files = ['tests/warehouse-wz-issuer-contract.test.ts'];
  if (process.argv.includes('--warehouse-wz-issued-component-only')) files = ['tests/warehouse-wz-issued-documents-component.test.mjs'];
  if (process.argv.includes('--catalog-stock-control169-metadata-regression-only')) files = [
    'tests/warehouse-inventory-policies.test.ts', 'tests/return-destination-statuses.test.ts',
    'tests/warehouse-automatic-wz.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-physical-regression-only')) files = [
    'tests/warehouse.test.ts', 'tests/purchasing.test.ts', 'tests/stock-locations.test.ts', 'tests/wms-lots-flow.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-backend-only')) files = ['tests/catalog-stock-control169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-contract-only')) files = ['tests/catalog-stock-control-contract169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-safety-only')) files = ['tests/catalog-stock-control-safety169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-custom-lifecycle-only')) files = ['tests/catalog-stock-control-custom-lifecycle169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-product-birth-only')) files = ['tests/catalog-stock-control-product-birth169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-physical-authority-only')) files = ['tests/catalog-stock-control-physical-authority169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-api-authority-only')) files = ['tests/catalog-stock-control-api-authority169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-wms-opening-only')) files = ['tests/catalog-stock-control-wms-opening169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-wms-opening-authority-only')) files = ['tests/catalog-stock-control-wms-opening-authority169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-return-only')) files = ['tests/catalog-stock-control-return169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-return-legacy-wms-only')) files = ['tests/catalog-stock-control-return-legacy-wms169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-acl-restore-only')) files = ['tests/catalog-stock-control-acl-restore169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-encrypted-restore-only')) files = ['tests/catalog-stock-control-encrypted-restore169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-return-coordinator-only')) files = ['tests/catalog-stock-control-return-coordinator169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-return-replay-authority-only')) files = ['tests/catalog-stock-control-return-replay-authority169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-return-network-only')) files = ['tests/catalog-stock-control-return-network169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-return-input-regression-only')) files = ['tests/returns.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-stocktake-adjustment-only')) files = ['tests/catalog-stock-control-stocktake-adjustment169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-count-only')) files = ['tests/catalog-stock-control-count169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-count-lots-only')) files = ['tests/catalog-stock-control-count-lots169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-count-mixed-only')) files = ['tests/catalog-stock-control-count-mixed169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-count-degraded-only')) files = ['tests/catalog-stock-control-count-degraded169.test.ts'];
  if (process.argv.includes('--local-ui-origin-only')) files = ['tests/local-ui-origin.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-count-query-only')) files = ['tests/catalog-stock-count-query169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-count-routes-only')) files = ['tests/catalog-stock-count-routes169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-count-value-only')) files = ['tests/catalog-stock-count-value169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-count-capacity-only')) files = ['tests/catalog-stock-count-capacity169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-count-terminal-only')) files = ['tests/catalog-stock-count-terminal169.test.ts'];
  if (process.argv.includes('--allegro-oauth-recovery-only')) files = ['tests/allegro-oauth-recovery.test.ts'];
  if (process.argv.includes('--allegro-oauth-durable-recovery-only')) files = ['tests/allegro-oauth-durable-recovery.test.ts'];
  if (process.argv.includes('--allegro-oauth-recovery153-preservation-draft-only')) files = ['data/source-drafts/allegro-oauth-recovery153-preservation.test.ts'];
  if (process.argv.includes('--allegro-oauth-recovery153-tamper-draft-only')) files = ['data/source-drafts/allegro-oauth-recovery153-tamper.test.ts'];
  if (process.argv.includes('--allegro-oauth-fresh-iam-draft-only')) files = ['data/source-drafts/allegro-oauth-fresh-iam-regression.test.ts'];
  if (process.argv.includes('--allegro-oauth-native-security-authority-draft-only')) files = ['data/source-drafts/allegro-oauth-native-security-authority169.test.ts'];
  if (process.argv.includes('--allegro-oauth-fetch-orders-authority-draft-only')) files = ['data/source-drafts/allegro-oauth-fetch-orders-authority169.test.ts'];
  if (process.argv.includes('--allegro-provider401-no-replay-draft-only')) files = ['data/source-drafts/allegro-provider401-no-replay169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-full-cycle-draft-only')) files = ['data/source-drafts/catalog-stock-control169-full-cycle.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-wms-adjustment-draft-only')) files = ['data/source-drafts/catalog-stock-control169-wms-adjustment.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-wms-adjustment-authority-draft-only')) files = ['data/source-drafts/catalog-stock-control169-wms-adjustment-authority.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-wms-correction-preservation-draft-only')) files = ['data/source-drafts/catalog-stock-control169-wms-correction-preservation.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-wms-correction-register-draft-only')) files = ['data/source-drafts/catalog-stock-control169-wms-correction-register.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-wms-correction-register-ui-draft-only')) files = ['data/source-drafts/catalog-stock-control169-wms-correction-register-ui.test.mjs'];
  if (process.argv.includes('--catalog-stock-control169-wms-correction-register-fullbytes-draft-only')) files = ['data/source-drafts/catalog-stock-control169-wms-correction-register-fullbytes.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-wms-correction-register-openapi-draft-only')) files = ['data/source-drafts/catalog-stock-control169-wms-correction-register-openapi.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-wms-correction-register-metadata-draft-only')) files = ['data/source-drafts/catalog-stock-control169-wms-correction-register-metadata.test.ts'];
  if (process.argv.includes('--catalog-stock-legacy-group169-native-draft-only')) files = ['data/source-drafts/catalog-stock-legacy-group169-native-regression.test.ts'];
  if (process.argv.includes('--catalog-stock-legacy-group169-native-diagnostic-only')) files = ['data/source-drafts/catalog-stock-legacy-group169-native-diagnostic-query169.test.ts'];
  if (process.argv.includes('--catalog-stock-legacy-receive-close169-phase3-only')) files = ['data/source-drafts/catalog-stock-legacy-receive-close169-phase3.test.ts'];
  if (process.argv.includes('--catalog-stock-legacy-receive-close169-phase3-fixture2-only')) files = ['data/source-drafts/catalog-stock-legacy-receive-close169-phase3-fixture2.test.ts'];
  if (process.argv.includes('--catalog-stock-legacy-receive-close169-phase-negative-only')) files = ['data/source-drafts/catalog-stock-legacy-receive-close169-phase-negative.test.ts'];
  if (process.argv.includes('--catalog-stock-legacy-receive-close169-preservation-only')) files = ['data/source-drafts/catalog-stock-legacy-receive-close169-preservation.test.ts'];
  if (process.argv.includes('--catalog-stock-legacy-receive-close169-metadata-only')) files = ['data/source-drafts/catalog-stock-legacy-receive-close169-metadata.test.ts'];
  if (process.argv.includes('--catalog-stock-legacy-receive-close169-capture-diagnostic-only')) files = ['data/source-drafts/catalog-stock-legacy-receive-close169-capture-diagnostic.test.ts'];
  if (process.argv.includes('--catalog-stock-legacy-group169-preview-diagnostic-only')) files = ['data/source-drafts/catalog-stock-legacy-group169-preview-diagnostic.test.ts'];
  if (process.argv.includes('--subxid-witness169-only')) files = ['data/source-drafts/subxid-witness169.test.ts'];
  if (process.argv.includes('--subxid-copied-restore169-only')) files = ['data/source-drafts/subxid-copied-restore169.test.ts'];
  if (process.argv.includes('--subxid-group-copied-restore169-only')) files = ['data/source-drafts/subxid-group-copied-restore169.test.ts'];
  if (process.argv.includes('--catalog-stock-legacy-return-on-direct169-http-draft-only')) files = ['data/source-drafts/catalog-stock-legacy-return-on-direct169-http.test.ts'];
  if (process.argv.includes('--catalog-stock-legacy-return-on-direct169-http-fixture2-only')) files = ['data/source-drafts/catalog-stock-legacy-return-on-direct169-http-fixture2.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-subxid-only')) files = ['data/source-drafts/catalog-stock-control169-subxid.test.ts'];
  if (process.argv.includes('--catalog-stock-return169-worker-single-receive-only')) files = ['data/source-drafts/catalog-stock-return169-worker-single-receive.test.ts'];
  if (process.argv.includes('--catalog-stock-return169-worker-single-receive-fixture2-only')) files = ['data/source-drafts/catalog-stock-return169-worker-single-receive-fixture2.test.ts'];
  if (process.argv.includes('--wms-history-head169-backend-only')) files = ['data/source-drafts/catalog-stock-control169-wms-history-head-backend.test.ts'];
  if (process.argv.includes('--wms-history-head169-backend-fixture2-only')) files = ['data/source-drafts/catalog-stock-control169-wms-history-head-backend-fixture2.test.ts'];
  if (process.argv.includes('--wms-history-head169-backend-fixture3-only')) files = ['data/source-drafts/catalog-stock-control169-wms-history-head-backend-fixture3.test.ts'];
  if (process.argv.includes('--wms-history-head169-ui-only')) files = ['data/source-drafts/catalog-stock-control169-wms-history-head-ui.test.mjs'];
  if (process.argv.includes('--catalog-stock-control169-restored-api-preview-draft-only')) files = ['data/source-drafts/catalog-stock-control169-restored-api-preview.test.ts'];
  if (process.argv.includes('--allegro-oauth-sync-regression-only')) files = ['tests/sync.test.ts'];
  if (process.argv.includes('--allegro-oauth-offer-regression-only')) files = ['tests/offer-sync.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-count-value-restore-only')) files = ['tests/catalog-stock-count-value-restore169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-count-native-regression-only')) files = ['tests/inventory-bulk-edit.test.ts','tests/inventory-bulk-edit-safety.test.ts','tests/inventory-bulk-edit-flows.test.ts','tests/stock-file-import.test.ts','tests/stock-file-import-safety.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-count-file-child-only')) files = ['tests/stock-file-import-safety.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-count-authority-only')) files = ['tests/catalog-stock-control-count-authority169.test.ts'];
  if (process.argv.includes('--catalog-stock-control169-count-component-only')) files = ['tests/catalog-stock-control-count-component169.test.mjs'];
  if (process.argv.includes('--catalog-stock-control169-count-parent-component-only')) files = ['tests/catalog-stock-control-count-parent-component169.test.mjs'];
  if (process.argv.includes('--catalog-stock-control169-component-only')) files = ['tests/catalog-stock-control-component169.test.mjs'];
  if (process.argv.includes('--dispatch-authorization-only')) files = ['tests/dispatch-transaction.test.ts'];
  if (process.argv.includes('--dispatch-shipping-regression-only')) files = ['tests/shipping.test.ts', 'tests/dpd.test.ts'];
  if (process.argv.includes('--product-rules-price-tags170-only')) files = ['data/source-drafts/product-rules-price-tags170.test.ts'];
  if (process.argv.includes('--product-rules-price-tags170-diagnostic-only')) files = ['data/source-drafts/product-rules-price-tags170-diagnostic.test.ts'];
  if (process.argv.includes('--product-rules-price-tags170-concurrency-only')) files = ['data/source-drafts/product-rules-price-tags170-concurrency.test.ts'];
  if (process.argv.includes('--product-rules-price-tags170-preservation-only')) files = ['data/source-drafts/product-rules-price-tags170-preservation.test.ts'];
  if (process.argv.includes('--product-rules-price-tags170-preservation-fixture2-only')) files = ['data/source-drafts/product-rules-price-tags170-preservation-fixture2.test.ts'];
  if (process.argv.includes('--product-rules-price-tags170-preservation-fixture3-only')) files = ['data/source-drafts/product-rules-price-tags170-preservation-fixture3.test.ts'];
  if (process.argv.includes('--product-rules-price-tags170-preservation-fixture4-only')) files = ['data/source-drafts/product-rules-price-tags170-preservation-fixture4.test.ts'];
  if (process.argv.includes('--product-rules-price-tags170-capacity-only')) files = ['data/source-drafts/product-rules-price-tags170-capacity.test.ts'];
  if (process.argv.includes('--product-rule-schedules171-only')) files = ['data/source-drafts/product-rule-schedules171.test.ts'];
  if (process.argv.includes('--product-rule-schedules171-preservation-only')) files = ['data/source-drafts/product-rule-schedules171-preservation.test.ts'];
  if (process.argv.includes('--product-rule-schedules171-late-iam-only')) files = ['data/source-drafts/product-rule-schedules171-late-iam.test.ts'];
  if (process.argv.includes('--packed-label-print172-only')) files = ['data/source-drafts/packed-label-print172.test.ts'];
  if (process.argv.includes('--packed-label-print172-fixture2-only')) files = ['data/source-drafts/packed-label-print172-fixture2.test.ts'];
  if (process.argv.includes('--packed-label-print172-fixture3-only')) files = ['data/source-drafts/packed-label-print172-fixture3.test.ts'];
  if (process.argv.includes('--packed-label-print172-fixture4-only')) files = ['data/source-drafts/packed-label-print172-fixture4.test.ts'];
  if (process.argv.includes('--local-invoices173-only')) files = ['data/source-drafts/local-invoices173.test.ts'];
  if (process.argv.includes('--local-invoices173-fixture2-only')) files = ['data/source-drafts/local-invoices173-fixture2.test.ts'];
  if (process.argv.includes('--packed-label-print172-queue-diagnostic-only')) files = ['data/source-drafts/packed-label-print172-queue-diagnostic.test.ts'];
  if (process.argv.includes('--packed-label-print172-acl-diagnostic-only')) files = ['data/source-drafts/packed-label-print172-acl-diagnostic.test.ts'];
  if (process.argv.includes('--catalog-stock-legacy-receive-close169-on-group-fixture2-only')) files = ['data/source-drafts/catalog-stock-legacy-receive-close169-on-group-fixture2.test.ts'];
  if (process.argv.includes('--catalog-stock-legacy-receive-close169-on-group-fixture3-only')) files = ['data/source-drafts/catalog-stock-legacy-receive-close169-on-group-fixture3.test.ts'];
  if (process.argv.includes('--product-rules-price-tags170-compat-only')) files = ['tests/product-rules.test.ts', 'tests/price-bulk-edit.test.ts'];
  if (process.argv.includes('--catalog-stock-legacy-receive-close169-on-group-compat-only')) files = ['data/source-drafts/catalog-stock-legacy-receive-close169-phase3-fixture2.test.ts', 'data/source-drafts/catalog-stock-legacy-receive-close169-phase-negative.test.ts', 'data/source-drafts/catalog-stock-legacy-return-on-direct169-http-fixture2.test.ts'];
  const selectedSuites = isolateSuites ? files.map((file) => [file]) : [files];
  code = 0;
  for (let index = 0; index < selectedSuites.length; index++) {
    // Independent fixtures include large synthetic catalogues and queued OMS events.
    // The product-rule integration gate isolates each source suite instead of sharing those fixtures.
    const isolated = isolateSuites;
    const suiteDatabase = isolated ? `${name}${index}` : name;
    if (isolated) await admin.query(`CREATE DATABASE ${suiteDatabase}`);
    try {
      const child = spawn(
        process.execPath,
        [
          'node_modules/tsx/dist/cli.mjs',
          '--test',
          '--test-concurrency=1',
          ...process.argv
            .filter((arg) => arg.startsWith('--pattern='))
            .map((arg) => '--test-name-pattern=' + arg.slice('--pattern='.length)),
          ...selectedSuites[index],
        ],
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            DATABASE_URL: `postgres://postgres:${localConfig.dbPassword}@127.0.0.1:${testPgPort}/${suiteDatabase}`,
            DYNA_TEST: 'true',
          },
        },
      );
      const result = await new Promise<number>((r) => child.on('exit', (n) => r(n ?? 1)));
      if (result) code = result;
    } finally {
      if (isolated) await admin.query(`DROP DATABASE ${suiteDatabase} WITH (FORCE)`);
    }
  }
} finally {
  await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
  await pool.end();
}
process.exit(code);
