ALTER TABLE variant_offer_batches ADD COLUMN kind text NOT NULL DEFAULT 'woocommerce_variants'
 CHECK (kind IN ('woocommerce_variants','allegro_catalog'));
ALTER TABLE variant_offer_batches ALTER COLUMN group_id DROP NOT NULL;
ALTER TABLE variant_offer_batches ADD CONSTRAINT offer_batch_group_kind CHECK (
 (kind='woocommerce_variants' AND group_id IS NOT NULL) OR (kind='allegro_catalog' AND group_id IS NULL)
);
ALTER TABLE variant_offer_batch_items ADD COLUMN creation_input jsonb NOT NULL DEFAULT '{}';
CREATE INDEX offer_batch_work_items ON variant_offer_batch_items(tenant_id,batch_id,state,id);
