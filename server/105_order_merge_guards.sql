-- Claims are inserted LAST by the typed merge transaction. No generic bypass.
CREATE FUNCTION order_merge_operational_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t uuid; oid uuid; previous_oid uuid;
BEGIN
 IF TG_OP='DELETE' THEN t:=OLD.tenant_id;
 ELSE t:=NEW.tenant_id; END IF;
 IF TG_TABLE_NAME='orders' THEN
  IF TG_OP='DELETE' THEN oid:=OLD.id; ELSE oid:=NEW.id; END IF;
 ELSE
  IF TG_OP='DELETE' THEN oid:=OLD.order_id; ELSE oid:=NEW.order_id; END IF;
  IF TG_OP='UPDATE' THEN previous_oid:=OLD.order_id; END IF;
  -- Serialize operational admission with merge's order locks. Existing callers
  -- already hold these locks; direct SQL receives the same protection.
  PERFORM id FROM orders WHERE tenant_id=t AND id=ANY(ARRAY[oid,previous_oid]) ORDER BY id FOR UPDATE;
 END IF;
 IF EXISTS(SELECT 1 FROM order_merge_claims WHERE tenant_id=t
           AND source_order_id=ANY(ARRAY[oid,previous_oid])) THEN
  RAISE EXCEPTION 'Realizacja zamówienia została przeniesiona przez łączenie'
   USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY[
  'orders','order_items','order_pick_items','reservations','reservation_locations',
  'wms_reservation_layers','shipments','shipping_plans','invoice_plans','documents',
  'dpd_shipping_plans','order_status_plans','odoo_invoice_exports',
  'shopify_fulfillment_plans','amazon_fulfillment_plans','ebay_fulfillment_plans',
  'return_cases','order_field_values','picking_wave_orders','packing_sessions'
 ] LOOP
  IF to_regclass('public.'||t) IS NOT NULL AND (t='orders' OR EXISTS(
   SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.'||t)
   AND attname='order_id' AND NOT attisdropped)) THEN
   EXECUTE format('CREATE TRIGGER order_merge_active BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION order_merge_operational_guard()',t);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION order_merge_operational_guard() FROM PUBLIC;
