/** Fixed inventory derived from actual source consumers. No glob/path input authority. */
export const RESOURCE_DEFINITIONS=Object.freeze([
  {"id":"sql:server/208_consumer_return_credit_guard_dedup.sql","source":"server/208_consumer_return_credit_guard_dedup.sql","path":"resources/server/208_consumer_return_credit_guard_dedup.sql","consumer":"server/db.ts"},
  {"id":"sql:server/207_consumer_return_credit.sql","source":"server/207_consumer_return_credit.sql","path":"resources/server/207_consumer_return_credit.sql","consumer":"server/db.ts"},
  {"id":"sql:server/206_return_credit_destinations_history.sql","source":"server/206_return_credit_destinations_history.sql","path":"resources/server/206_return_credit_destinations_history.sql","consumer":"server/db.ts"},
  {"id":"sql:server/205_header_metadata_projection.sql","source":"server/205_header_metadata_projection.sql","path":"resources/server/205_header_metadata_projection.sql","consumer":"server/db.ts"},
  {"id":"sql:server/204_partial_commercial_sale_scope.sql","source":"server/204_partial_commercial_sale_scope.sql","path":"resources/server/204_partial_commercial_sale_scope.sql","consumer":"server/db.ts"},
  {"id":"sql:server/203_known_partial_core_quota_renewal.sql","source":"server/203_known_partial_core_quota_renewal.sql","path":"resources/server/203_known_partial_core_quota_renewal.sql","consumer":"server/db.ts"},
  {"id":"sql:server/202_owned_business_quota_expiry_renewal.sql","source":"server/202_owned_business_quota_expiry_renewal.sql","path":"resources/server/202_owned_business_quota_expiry_renewal.sql","consumer":"server/db.ts"},
  {"id":"sql:server/201_complete_history_empty_bootstrap.sql","source":"server/201_complete_history_empty_bootstrap.sql","path":"resources/server/201_complete_history_empty_bootstrap.sql","consumer":"server/db.ts"},
  {"id":"sql:server/189_packing_required_order_fields.sql","source":"server/189_packing_required_order_fields.sql","path":"resources/server/189_packing_required_order_fields.sql","consumer":"server/db.ts"},
  {"id":"sql:server/199_keeper_private_cold.sql","source":"server/199_keeper_private_cold.sql","path":"resources/server/199_keeper_private_cold.sql","consumer":"server/db.ts"},
  {"id":"sql:server/198_original_keeper_resource_context.sql","source":"server/198_original_keeper_resource_context.sql","path":"resources/server/198_original_keeper_resource_context.sql","consumer":"server/db.ts"},
  {"id":"sql:server/188_local_consumer_credit.sql","source":"server/188_local_consumer_credit.sql","path":"resources/server/188_local_consumer_credit.sql","consumer":"server/db.ts"},
  {"id":"sql:server/188_consumer_credit_structure.sql","source":"server/188_consumer_credit_structure.sql","path":"resources/server/188_consumer_credit_structure.sql","consumer":"server/db.ts"},
  {"id":"sql:server/183_original_key_recovery.sql","source":"server/183_original_key_recovery.sql","path":"resources/server/183_original_key_recovery.sql","consumer":"server/db.ts"},
  {
    "id": "sql:server/002_imports.sql",
    "source": "server/002_imports.sql",
    "path": "resources/server/002_imports.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/003_sync.sql",
    "source": "server/003_sync.sql",
    "path": "resources/server/003_sync.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/004_catalog.sql",
    "source": "server/004_catalog.sql",
    "path": "resources/server/004_catalog.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/005_warehouse.sql",
    "source": "server/005_warehouse.sql",
    "path": "resources/server/005_warehouse.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/006_offers.sql",
    "source": "server/006_offers.sql",
    "path": "resources/server/006_offers.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/007_offer_indexes.sql",
    "source": "server/007_offer_indexes.sql",
    "path": "resources/server/007_offer_indexes.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/008_shipping.sql",
    "source": "server/008_shipping.sql",
    "path": "resources/server/008_shipping.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/009_invoices.sql",
    "source": "server/009_invoices.sql",
    "path": "resources/server/009_invoices.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/010_operations.sql",
    "source": "server/010_operations.sql",
    "path": "resources/server/010_operations.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/011_automation_chain_index.sql",
    "source": "server/011_automation_chain_index.sql",
    "path": "resources/server/011_automation_chain_index.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/012_workspaces.sql",
    "source": "server/012_workspaces.sql",
    "path": "resources/server/012_workspaces.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/013_developer_api.sql",
    "source": "server/013_developer_api.sql",
    "path": "resources/server/013_developer_api.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/014_returns.sql",
    "source": "server/014_returns.sql",
    "path": "resources/server/014_returns.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/015_buyer_portal.sql",
    "source": "server/015_buyer_portal.sql",
    "path": "resources/server/015_buyer_portal.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/016_pricing.sql",
    "source": "server/016_pricing.sql",
    "path": "resources/server/016_pricing.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/017_offer_sync.sql",
    "source": "server/017_offer_sync.sql",
    "path": "resources/server/017_offer_sync.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/018_catalog_sources.sql",
    "source": "server/018_catalog_sources.sql",
    "path": "resources/server/018_catalog_sources.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/019_variable_offers.sql",
    "source": "server/019_variable_offers.sql",
    "path": "resources/server/019_variable_offers.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/020_tracking.sql",
    "source": "server/020_tracking.sql",
    "path": "resources/server/020_tracking.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/021_purchasing.sql",
    "source": "server/021_purchasing.sql",
    "path": "resources/server/021_purchasing.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/022_order_status.sql",
    "source": "server/022_order_status.sql",
    "path": "resources/server/022_order_status.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/023_payments.sql",
    "source": "server/023_payments.sql",
    "path": "resources/server/023_payments.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/024_source_payments.sql",
    "source": "server/024_source_payments.sql",
    "path": "resources/server/024_source_payments.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/025_stock_locations.sql",
    "source": "server/025_stock_locations.sql",
    "path": "resources/server/025_stock_locations.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/026_automation_schedules.sql",
    "source": "server/026_automation_schedules.sql",
    "path": "resources/server/026_automation_schedules.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/027_sms.sql",
    "source": "server/027_sms.sql",
    "path": "resources/server/027_sms.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/028_sms_automations.sql",
    "source": "server/028_sms_automations.sql",
    "path": "resources/server/028_sms_automations.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/029_stocktakes.sql",
    "source": "server/029_stocktakes.sql",
    "path": "resources/server/029_stocktakes.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/030_supplier_catalog.sql",
    "source": "server/030_supplier_catalog.sql",
    "path": "resources/server/030_supplier_catalog.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/031_supplier_bulk.sql",
    "source": "server/031_supplier_bulk.sql",
    "path": "resources/server/031_supplier_bulk.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/032_supplier_schedules.sql",
    "source": "server/032_supplier_schedules.sql",
    "path": "resources/server/032_supplier_schedules.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/033_repricing.sql",
    "source": "server/033_repricing.sql",
    "path": "resources/server/033_repricing.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/034_repricing_schedules.sql",
    "source": "server/034_repricing_schedules.sql",
    "path": "resources/server/034_repricing_schedules.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/035_allegro_batches.sql",
    "source": "server/035_allegro_batches.sql",
    "path": "resources/server/035_allegro_batches.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/036_dpd_collections.sql",
    "source": "server/036_dpd_collections.sql",
    "path": "resources/server/036_dpd_collections.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/037_dpd_pickup_schedules.sql",
    "source": "server/037_dpd_pickup_schedules.sql",
    "path": "resources/server/037_dpd_pickup_schedules.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/038_b2b.sql",
    "source": "server/038_b2b.sql",
    "path": "resources/server/038_b2b.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/039_b2b_network.sql",
    "source": "server/039_b2b_network.sql",
    "path": "resources/server/039_b2b_network.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/040_b2b_network_orders.sql",
    "source": "server/040_b2b_network_orders.sql",
    "path": "resources/server/040_b2b_network_orders.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/041_b2b_network_returns.sql",
    "source": "server/041_b2b_network_returns.sql",
    "path": "resources/server/041_b2b_network_returns.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/042_odoo_invoice_exports.sql",
    "source": "server/042_odoo_invoice_exports.sql",
    "path": "resources/server/042_odoo_invoice_exports.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/043_odoo_catalog_sync.sql",
    "source": "server/043_odoo_catalog_sync.sql",
    "path": "resources/server/043_odoo_catalog_sync.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/044_odoo_invoice_files.sql",
    "source": "server/044_odoo_invoice_files.sql",
    "path": "resources/server/044_odoo_invoice_files.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/045_odoo_image_imports.sql",
    "source": "server/045_odoo_image_imports.sql",
    "path": "resources/server/045_odoo_image_imports.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/046_ebay_fulfillment.sql",
    "source": "server/046_ebay_fulfillment.sql",
    "path": "resources/server/046_ebay_fulfillment.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/047_ebay_accounts.sql",
    "source": "server/047_ebay_accounts.sql",
    "path": "resources/server/047_ebay_accounts.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/048_ebay_fulfillment_schedules.sql",
    "source": "server/048_ebay_fulfillment_schedules.sql",
    "path": "resources/server/048_ebay_fulfillment_schedules.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/049_ebay_revision_budget.sql",
    "source": "server/049_ebay_revision_budget.sql",
    "path": "resources/server/049_ebay_revision_budget.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/050_ebay_api_limits.sql",
    "source": "server/050_ebay_api_limits.sql",
    "path": "resources/server/050_ebay_api_limits.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/051_account_security.sql",
    "source": "server/051_account_security.sql",
    "path": "resources/server/051_account_security.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/052_amazon_api_limits.sql",
    "source": "server/052_amazon_api_limits.sql",
    "path": "resources/server/052_amazon_api_limits.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/053_amazon_catalog.sql",
    "source": "server/053_amazon_catalog.sql",
    "path": "resources/server/053_amazon_catalog.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/054_amazon_offers.sql",
    "source": "server/054_amazon_offers.sql",
    "path": "resources/server/054_amazon_offers.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/055_amazon_oauth.sql",
    "source": "server/055_amazon_oauth.sql",
    "path": "resources/server/055_amazon_oauth.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/056_integration_workspace.sql",
    "source": "server/056_integration_workspace.sql",
    "path": "resources/server/056_integration_workspace.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/057_workspace_mfa.sql",
    "source": "server/057_workspace_mfa.sql",
    "path": "resources/server/057_workspace_mfa.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/058_picking_waves.sql",
    "source": "server/058_picking_waves.sql",
    "path": "resources/server/058_picking_waves.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/059_amazon_fulfillment.sql",
    "source": "server/059_amazon_fulfillment.sql",
    "path": "resources/server/059_amazon_fulfillment.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/060_password_recovery.sql",
    "source": "server/060_password_recovery.sql",
    "path": "resources/server/060_password_recovery.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/061_email.sql",
    "source": "server/061_email.sql",
    "path": "resources/server/061_email.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/062_email_actions.sql",
    "source": "server/062_email_actions.sql",
    "path": "resources/server/062_email_actions.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/063_email_attachments.sql",
    "source": "server/063_email_attachments.sql",
    "path": "resources/server/063_email_attachments.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/064_shopify_fulfillment.sql",
    "source": "server/064_shopify_fulfillment.sql",
    "path": "resources/server/064_shopify_fulfillment.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/065_shopify_oauth.sql",
    "source": "server/065_shopify_oauth.sql",
    "path": "resources/server/065_shopify_oauth.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/066_shopify_webhooks.sql",
    "source": "server/066_shopify_webhooks.sql",
    "path": "resources/server/066_shopify_webhooks.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/067_shopify_subscriptions.sql",
    "source": "server/067_shopify_subscriptions.sql",
    "path": "resources/server/067_shopify_subscriptions.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/068_workspace_billing.sql",
    "source": "server/068_workspace_billing.sql",
    "path": "resources/server/068_workspace_billing.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/069_prestashop_status.sql",
    "source": "server/069_prestashop_status.sql",
    "path": "resources/server/069_prestashop_status.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/070_catalog_ai.sql",
    "source": "server/070_catalog_ai.sql",
    "path": "resources/server/070_catalog_ai.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/071_deepl.sql",
    "source": "server/071_deepl.sql",
    "path": "resources/server/071_deepl.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/072_deepl_batches.sql",
    "source": "server/072_deepl_batches.sql",
    "path": "resources/server/072_deepl_batches.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/073_shopify_translations.sql",
    "source": "server/073_shopify_translations.sql",
    "path": "resources/server/073_shopify_translations.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/074_shopify_translation_batches.sql",
    "source": "server/074_shopify_translation_batches.sql",
    "path": "resources/server/074_shopify_translation_batches.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/075_customer_messages.sql",
    "source": "server/075_customer_messages.sql",
    "path": "resources/server/075_customer_messages.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/076_product_rules.sql",
    "source": "server/076_product_rules.sql",
    "path": "resources/server/076_product_rules.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/077_payment_imports.sql",
    "source": "server/077_payment_imports.sql",
    "path": "resources/server/077_payment_imports.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/078_order_fields.sql",
    "source": "server/078_order_fields.sql",
    "path": "resources/server/078_order_fields.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/079_order_field_batches.sql",
    "source": "server/079_order_field_batches.sql",
    "path": "resources/server/079_order_field_batches.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/080_order_field_mappings.sql",
    "source": "server/080_order_field_mappings.sql",
    "path": "resources/server/080_order_field_mappings.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/081_customer_message_workflows.sql",
    "source": "server/081_customer_message_workflows.sql",
    "path": "resources/server/081_customer_message_workflows.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/082_catalog_bulk_edit.sql",
    "source": "server/082_catalog_bulk_edit.sql",
    "path": "resources/server/082_catalog_bulk_edit.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/083_product_logistics.sql",
    "source": "server/083_product_logistics.sql",
    "path": "resources/server/083_product_logistics.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/084_product_logistics_recovery.sql",
    "source": "server/084_product_logistics_recovery.sql",
    "path": "resources/server/084_product_logistics_recovery.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/085_product_sku.sql",
    "source": "server/085_product_sku.sql",
    "path": "resources/server/085_product_sku.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/086_inventory_bulk_edit.sql",
    "source": "server/086_inventory_bulk_edit.sql",
    "path": "resources/server/086_inventory_bulk_edit.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/087_price_bulk_edit.sql",
    "source": "server/087_price_bulk_edit.sql",
    "path": "resources/server/087_price_bulk_edit.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/088_product_translation_bulk_edit.sql",
    "source": "server/088_product_translation_bulk_edit.sql",
    "path": "resources/server/088_product_translation_bulk_edit.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/089_packing_workstation.sql",
    "source": "server/089_packing_workstation.sql",
    "path": "resources/server/089_packing_workstation.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/090_wms_lots.sql",
    "source": "server/090_wms_lots.sql",
    "path": "resources/server/090_wms_lots.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/091_wms_lot_packing.sql",
    "source": "server/091_wms_lot_packing.sql",
    "path": "resources/server/091_wms_lot_packing.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/092_wms_stocktakes.sql",
    "source": "server/092_wms_stocktakes.sql",
    "path": "resources/server/092_wms_stocktakes.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/093_wms_validation_scopes.sql",
    "source": "server/093_wms_validation_scopes.sql",
    "path": "resources/server/093_wms_validation_scopes.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/094_wms_stocktake_scans.sql",
    "source": "server/094_wms_stocktake_scans.sql",
    "path": "resources/server/094_wms_stocktake_scans.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/095_stocktake_scan_recovery.sql",
    "source": "server/095_stocktake_scan_recovery.sql",
    "path": "resources/server/095_stocktake_scan_recovery.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/096_catalog_export_profiles.sql",
    "source": "server/096_catalog_export_profiles.sql",
    "path": "resources/server/096_catalog_export_profiles.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/097_catalog_export_sources.sql",
    "source": "server/097_catalog_export_sources.sql",
    "path": "resources/server/097_catalog_export_sources.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/098_catalog_file_imports.sql",
    "source": "server/098_catalog_file_imports.sql",
    "path": "resources/server/098_catalog_file_imports.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/099_replenishment_plans.sql",
    "source": "server/099_replenishment_plans.sql",
    "path": "resources/server/099_replenishment_plans.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/100_replenishment_forecast.sql",
    "source": "server/100_replenishment_forecast.sql",
    "path": "resources/server/100_replenishment_forecast.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/101_replenishment_append.sql",
    "source": "server/101_replenishment_append.sql",
    "path": "resources/server/101_replenishment_append.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/102_replenishment_automations.sql",
    "source": "server/102_replenishment_automations.sql",
    "path": "resources/server/102_replenishment_automations.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/103_order_merges.sql",
    "source": "server/103_order_merges.sql",
    "path": "resources/server/103_order_merges.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/104_order_merge_custody.sql",
    "source": "server/104_order_merge_custody.sql",
    "path": "resources/server/104_order_merge_custody.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/105_order_merge_guards.sql",
    "source": "server/105_order_merge_guards.sql",
    "path": "resources/server/105_order_merge_guards.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/106_order_source_lines.sql",
    "source": "server/106_order_source_lines.sql",
    "path": "resources/server/106_order_source_lines.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/107_shopify_source_fulfillment.sql",
    "source": "server/107_shopify_source_fulfillment.sql",
    "path": "resources/server/107_shopify_source_fulfillment.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/108_b2b_dropship_dispatch.sql",
    "source": "server/108_b2b_dropship_dispatch.sql",
    "path": "resources/server/108_b2b_dropship_dispatch.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/108_b2b_dropshipping.sql",
    "source": "server/108_b2b_dropshipping.sql",
    "path": "resources/server/108_b2b_dropshipping.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/109_b2b_external_order_intents.sql",
    "source": "server/109_b2b_external_order_intents.sql",
    "path": "resources/server/109_b2b_external_order_intents.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/110_b2b_external_order_imports.sql",
    "source": "server/110_b2b_external_order_imports.sql",
    "path": "resources/server/110_b2b_external_order_imports.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/111_b2b_dropshipping_returns.sql",
    "source": "server/111_b2b_dropshipping_returns.sql",
    "path": "resources/server/111_b2b_dropshipping_returns.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/112_b2b_return_local_origins.sql",
    "source": "server/112_b2b_return_local_origins.sql",
    "path": "resources/server/112_b2b_return_local_origins.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/113_price_file_imports.sql",
    "source": "server/113_price_file_imports.sql",
    "path": "resources/server/113_price_file_imports.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/114_price_matrix_imports.sql",
    "source": "server/114_price_matrix_imports.sql",
    "path": "resources/server/114_price_matrix_imports.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/115_stock_file_imports.sql",
    "source": "server/115_stock_file_imports.sql",
    "path": "resources/server/115_stock_file_imports.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/116_stock_file_import_validation.sql",
    "source": "server/116_stock_file_import_validation.sql",
    "path": "resources/server/116_stock_file_import_validation.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/117_language_file_imports.sql",
    "source": "server/117_language_file_imports.sql",
    "path": "resources/server/117_language_file_imports.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/118_supplier_file_sources.sql",
    "source": "server/118_supplier_file_sources.sql",
    "path": "resources/server/118_supplier_file_sources.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/119_supplier_remote_feeds.sql",
    "source": "server/119_supplier_remote_feeds.sql",
    "path": "resources/server/119_supplier_remote_feeds.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/120_return_exchanges.sql",
    "source": "server/120_return_exchanges.sql",
    "path": "resources/server/120_return_exchanges.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/121_return_exchange_frame_scope.sql",
    "source": "server/121_return_exchange_frame_scope.sql",
    "path": "resources/server/121_return_exchange_frame_scope.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/122_return_exchange_hashes.sql",
    "source": "server/122_return_exchange_hashes.sql",
    "path": "resources/server/122_return_exchange_hashes.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/123_return_exchange_substitutions.sql",
    "source": "server/123_return_exchange_substitutions.sql",
    "path": "resources/server/123_return_exchange_substitutions.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/124_payment_import_allocations.sql",
    "source": "server/124_payment_import_allocations.sql",
    "path": "resources/server/124_payment_import_allocations.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/125_payment_import_allocation_source_projection.sql",
    "source": "server/125_payment_import_allocation_source_projection.sql",
    "path": "resources/server/125_payment_import_allocation_source_projection.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/126_payment_import_allocation_cod_balances.sql",
    "source": "server/126_payment_import_allocation_cod_balances.sql",
    "path": "resources/server/126_payment_import_allocation_cod_balances.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/127_proformas.sql",
    "source": "server/127_proformas.sql",
    "path": "resources/server/127_proformas.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/128_proforma_batches.sql",
    "source": "server/128_proforma_batches.sql",
    "path": "resources/server/128_proforma_batches.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/129_print_jobs.sql",
    "source": "server/129_print_jobs.sql",
    "path": "resources/server/129_print_jobs.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/130_shipment_label_prints.sql",
    "source": "server/130_shipment_label_prints.sql",
    "path": "resources/server/130_shipment_label_prints.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/131_shipment_label_cache.sql",
    "source": "server/131_shipment_label_cache.sql",
    "path": "resources/server/131_shipment_label_cache.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/132_shipment_label_batches.sql",
    "source": "server/132_shipment_label_batches.sql",
    "path": "resources/server/132_shipment_label_batches.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/133_order_shipments.sql",
    "source": "server/133_order_shipments.sql",
    "path": "resources/server/133_order_shipments.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/134_order_parcels.sql",
    "source": "server/134_order_parcels.sql",
    "path": "resources/server/134_order_parcels.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/135_order_parcel_completion_fix.sql",
    "source": "server/135_order_parcel_completion_fix.sql",
    "path": "resources/server/135_order_parcel_completion_fix.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/136_order_parcel_commercial_origins.sql",
    "source": "server/136_order_parcel_commercial_origins.sql",
    "path": "resources/server/136_order_parcel_commercial_origins.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/137_order_parcel_releases.sql",
    "source": "server/137_order_parcel_releases.sql",
    "path": "resources/server/137_order_parcel_releases.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/138_order_parcel_returns.sql",
    "source": "server/138_order_parcel_returns.sql",
    "path": "resources/server/138_order_parcel_returns.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/139_return_assistant.sql",
    "source": "server/139_return_assistant.sql",
    "path": "resources/server/139_return_assistant.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/140_return_assistant_queues.sql",
    "source": "server/140_return_assistant_queues.sql",
    "path": "resources/server/140_return_assistant_queues.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/141_email_inbound.sql",
    "source": "server/141_email_inbound.sql",
    "path": "resources/server/141_email_inbound.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/142_product_catalogs.sql",
    "source": "server/142_product_catalogs.sql",
    "path": "resources/server/142_product_catalogs.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/143_catalog_export_catalogs.sql",
    "source": "server/143_catalog_export_catalogs.sql",
    "path": "resources/server/143_catalog_export_catalogs.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/144_b2b_catalog_scopes.sql",
    "source": "server/144_b2b_catalog_scopes.sql",
    "path": "resources/server/144_b2b_catalog_scopes.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/145_order_merge_counters.sql",
    "source": "server/145_order_merge_counters.sql",
    "path": "resources/server/145_order_merge_counters.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/146_warehouse_inventory_policies.sql",
    "source": "server/146_warehouse_inventory_policies.sql",
    "path": "resources/server/146_warehouse_inventory_policies.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/147_return_destination_statuses.sql",
    "source": "server/147_return_destination_statuses.sql",
    "path": "resources/server/147_return_destination_statuses.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/148_return_destinations.sql",
    "source": "server/148_return_destinations.sql",
    "path": "resources/server/148_return_destinations.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/149_stocktake_adjustments.sql",
    "source": "server/149_stocktake_adjustments.sql",
    "path": "resources/server/149_stocktake_adjustments.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/150_warehouse_automatic_wz.sql",
    "source": "server/150_warehouse_automatic_wz.sql",
    "path": "resources/server/150_warehouse_automatic_wz.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/151_warehouse_wz_issuer.sql",
    "source": "server/151_warehouse_wz_issuer.sql",
    "path": "resources/server/151_warehouse_wz_issuer.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/152_catalog_stock_control.sql",
    "source": "server/152_catalog_stock_control.sql",
    "path": "resources/server/152_catalog_stock_control.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/153_allegro_oauth_recovery.sql",
    "source": "server/153_allegro_oauth_recovery.sql",
    "path": "resources/server/153_allegro_oauth_recovery.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/154_product_rule_price_tags.sql",
    "source": "server/154_product_rule_price_tags.sql",
    "path": "resources/server/154_product_rule_price_tags.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/155_product_rule_schedules.sql",
    "source": "server/155_product_rule_schedules.sql",
    "path": "resources/server/155_product_rule_schedules.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/156_packed_label_print.sql",
    "source": "server/156_packed_label_print.sql",
    "path": "resources/server/156_packed_label_print.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/157_local_invoices.sql",
    "source": "server/157_local_invoices.sql",
    "path": "resources/server/157_local_invoices.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/158_fa3_draft_native.sql",
    "source": "server/158_fa3_draft_native.sql",
    "path": "resources/server/158_fa3_draft_native.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/159_b2b_invoice.sql",
    "source": "server/159_b2b_invoice.sql",
    "path": "resources/server/159_b2b_invoice.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/160_b2b_credit.sql",
    "source": "server/160_b2b_credit.sql",
    "path": "resources/server/160_b2b_credit.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/161_credit_source.sql",
    "source": "server/161_credit_source.sql",
    "path": "resources/server/161_credit_source.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/162_financial_return.sql",
    "source": "server/162_financial_return.sql",
    "path": "resources/server/162_financial_return.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/163_competitor_observations.sql",
    "source": "server/163_competitor_observations.sql",
    "path": "resources/server/163_competitor_observations.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/164_competitor_observation_batch_scale.sql",
    "source": "server/164_competitor_observation_batch_scale.sql",
    "path": "resources/server/164_competitor_observation_batch_scale.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/165_competitor_observation_portability.sql",
    "source": "server/165_competitor_observation_portability.sql",
    "path": "resources/server/165_competitor_observation_portability.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/166_buyer_address_sidecar.sql",
    "source": "server/166_buyer_address_sidecar.sql",
    "path": "resources/server/166_buyer_address_sidecar.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/167_operational_delivery_consumers.sql",
    "source": "server/167_operational_delivery_consumers.sql",
    "path": "resources/server/167_operational_delivery_consumers.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/168_physical_parcel_wz.sql",
    "source": "server/168_physical_parcel_wz.sql",
    "path": "resources/server/168_physical_parcel_wz.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/169_manual_inventory_off.sql",
    "source": "server/169_manual_inventory_off.sql",
    "path": "resources/server/169_manual_inventory_off.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/170_pim_dictionaries.sql",
    "source": "server/170_pim_dictionaries.sql",
    "path": "resources/server/170_pim_dictionaries.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/171_pim_physical_cooperation.sql",
    "source": "server/171_pim_physical_cooperation.sql",
    "path": "resources/server/171_pim_physical_cooperation.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/172_pim_nested_json.sql",
    "source": "server/172_pim_nested_json.sql",
    "path": "resources/server/172_pim_nested_json.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/173_large_catalog_import_birth.sql",
    "source": "server/173_large_catalog_import_birth.sql",
    "path": "resources/server/173_large_catalog_import_birth.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/174_packing_photos.sql",
    "source": "server/174_packing_photos.sql",
    "path": "resources/server/174_packing_photos.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/175_integration_verification_history_index.sql",
    "source": "server/175_integration_verification_history_index.sql",
    "path": "resources/server/175_integration_verification_history_index.sql",
    "consumer": "server/db.ts"
  },

  {
    "id": "sql:server/176_product_image_library_indexes.sql",
    "source": "server/176_product_image_library_indexes.sql",
    "path": "resources/server/176_product_image_library_indexes.sql",
    "consumer": "server/db.ts"
  }, 
  {
    "id": "sql:server/178_large_import_wave_print_compatibility.sql",
    "source": "server/178_large_import_wave_print_compatibility.sql",
    "path": "resources/server/178_large_import_wave_print_compatibility.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/179_shared_manual_guard_dag.sql",
    "source": "server/179_shared_manual_guard_dag.sql",
    "path": "resources/server/179_shared_manual_guard_dag.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/180_consistent_history_guard_dag.sql",
    "source": "server/180_consistent_history_guard_dag.sql",
    "path": "resources/server/180_consistent_history_guard_dag.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/181_same_root_guard_observations.sql",
    "source": "server/181_same_root_guard_observations.sql",
    "path": "resources/server/181_same_root_guard_observations.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/182_cold_schema_runtime_admission.sql",
    "source": "server/182_cold_schema_runtime_admission.sql",
    "path": "resources/server/182_cold_schema_runtime_admission.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/184_ordinary_schema_admission.sql",
    "source": "server/184_ordinary_schema_admission.sql",
    "path": "resources/server/184_ordinary_schema_admission.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/185_private_keeper_generation.sql",
    "source": "server/185_private_keeper_generation.sql",
    "path": "resources/server/185_private_keeper_generation.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/186_core_review_alias_binding.sql",
    "source": "server/186_core_review_alias_binding.sql",
    "path": "resources/server/186_core_review_alias_binding.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/187_durable_original_writer_epoch.sql",
    "source": "server/187_durable_original_writer_epoch.sql",
    "path": "resources/server/187_durable_original_writer_epoch.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/177_picking_wave_print.sql",
    "source": "server/177_picking_wave_print.sql",
    "path": "resources/server/177_picking_wave_print.sql",
    "consumer": "server/db.ts"
  }, {
    "id": "sql:server/schema.sql",
    "source": "server/schema.sql",
    "path": "resources/server/schema.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/wms-stocktake-invariants.sql",
    "source": "server/wms-stocktake-invariants.sql",
    "path": "resources/server/wms-stocktake-invariants.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "sql:server/200_sms_delivery_submission.sql",
    "source": "server/200_sms_delivery_submission.sql",
    "path": "resources/server/200_sms_delivery_submission.sql",
    "consumer": "server/db.ts"
  },
  {
    "id": "font:demo-shipment-label",
    "source": "server/assets/fonts/NotoSans-Regular.ttf",
    "path": "resources/server/assets/fonts/NotoSans-Regular.ttf",
    "consumer": "server/demo-shipment-label-pdf.ts"
  },
  {
    "id": "pdf:odoo-demo-invoice",
    "source": "output/pdf/odoo-demo.pdf",
    "path": "resources/output/pdf/odoo-demo.pdf",
    "consumer": "server/odoo-invoice-files.ts"
  },
  {
    "id": "xsd:manifest.json",
    "source": "schemas/mf/manifest.json",
    "path": "resources/schemas/mf/manifest.json",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:FA/3/schemat.xsd",
    "source": "schemas/mf/FA/3/schemat.xsd",
    "path": "resources/schemas/mf/FA/3/schemat.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:FA/3/StrukturyDanych_v10-0E.xsd",
    "source": "schemas/mf/FA/3/StrukturyDanych_v10-0E.xsd",
    "path": "resources/schemas/mf/FA/3/StrukturyDanych_v10-0E.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:FA/3/ElementarneTypyDanych_v10-0E.xsd",
    "source": "schemas/mf/FA/3/ElementarneTypyDanych_v10-0E.xsd",
    "path": "resources/schemas/mf/FA/3/ElementarneTypyDanych_v10-0E.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:FA/3/KodyKrajow_v10-0E.xsd",
    "source": "schemas/mf/FA/3/KodyKrajow_v10-0E.xsd",
    "path": "resources/schemas/mf/FA/3/KodyKrajow_v10-0E.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:JPK_V7M/3/schemat.xsd",
    "source": "schemas/mf/JPK_V7M/3/schemat.xsd",
    "path": "resources/schemas/mf/JPK_V7M/3/schemat.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:JPK_V7M/3/KodyKrajow_v13-0E.xsd",
    "source": "schemas/mf/JPK_V7M/3/KodyKrajow_v13-0E.xsd",
    "path": "resources/schemas/mf/JPK_V7M/3/KodyKrajow_v13-0E.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:JPK_V7M/3/KodyUrzedowSkarbowych_v8-0E.xsd",
    "source": "schemas/mf/JPK_V7M/3/KodyUrzedowSkarbowych_v8-0E.xsd",
    "path": "resources/schemas/mf/JPK_V7M/3/KodyUrzedowSkarbowych_v8-0E.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:JPK_V7M/3/StrukturyDanych_v12-0E.xsd",
    "source": "schemas/mf/JPK_V7M/3/StrukturyDanych_v12-0E.xsd",
    "path": "resources/schemas/mf/JPK_V7M/3/StrukturyDanych_v12-0E.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:JPK_V7K/3/schemat.xsd",
    "source": "schemas/mf/JPK_V7K/3/schemat.xsd",
    "path": "resources/schemas/mf/JPK_V7K/3/schemat.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:JPK_V7K/3/KodyKrajow_v13-0E.xsd",
    "source": "schemas/mf/JPK_V7K/3/KodyKrajow_v13-0E.xsd",
    "path": "resources/schemas/mf/JPK_V7K/3/KodyKrajow_v13-0E.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:JPK_V7K/3/KodyUrzedowSkarbowych_v8-0E.xsd",
    "source": "schemas/mf/JPK_V7K/3/KodyUrzedowSkarbowych_v8-0E.xsd",
    "path": "resources/schemas/mf/JPK_V7K/3/KodyUrzedowSkarbowych_v8-0E.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:JPK_V7K/3/StrukturyDanych_v12-0E.xsd",
    "source": "schemas/mf/JPK_V7K/3/StrukturyDanych_v12-0E.xsd",
    "path": "resources/schemas/mf/JPK_V7K/3/StrukturyDanych_v12-0E.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:JPK_FA/4/Schemat_JPK_FA(4)_v1-0.xsd",
    "source": "schemas/mf/JPK_FA/4/Schemat_JPK_FA(4)_v1-0.xsd",
    "path": "resources/schemas/mf/JPK_FA/4/Schemat_JPK_FA(4)_v1-0.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:JPK_FA/4/StrukturyDanych_v5-0E.xsd",
    "source": "schemas/mf/JPK_FA/4/StrukturyDanych_v5-0E.xsd",
    "path": "resources/schemas/mf/JPK_FA/4/StrukturyDanych_v5-0E.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:JPK_FA/4/ElementarneTypyDanych_v5-0E.xsd",
    "source": "schemas/mf/JPK_FA/4/ElementarneTypyDanych_v5-0E.xsd",
    "path": "resources/schemas/mf/JPK_FA/4/ElementarneTypyDanych_v5-0E.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:JPK_FA/4/KodyUrzedowSkarbowych_v5-0E.xsd",
    "source": "schemas/mf/JPK_FA/4/KodyUrzedowSkarbowych_v5-0E.xsd",
    "path": "resources/schemas/mf/JPK_FA/4/KodyUrzedowSkarbowych_v5-0E.xsd",
    "consumer": "server/mf-xsd.ts"
  },
  {
    "id": "xsd:JPK_FA/4/KodyKrajow_v5-0E.xsd",
    "source": "schemas/mf/JPK_FA/4/KodyKrajow_v5-0E.xsd",
    "path": "resources/schemas/mf/JPK_FA/4/KodyKrajow_v5-0E.xsd",
    "consumer": "server/mf-xsd.ts"
  }
].map(row=>Object.freeze(row)));
