ALTER TABLE amazon_api_buckets DROP CONSTRAINT amazon_api_buckets_family_check;
ALTER TABLE amazon_api_buckets ADD CONSTRAINT amazon_api_buckets_family_check
 CHECK(family IN ('search','order','oauth','listings_search','listings_get','report_create','report_status','report_document'));
CREATE INDEX catalog_source_amazon_pending ON catalog_source_items(tenant_id,run_id,external_id)
 WHERE source->>'amazon_pending'='true';
