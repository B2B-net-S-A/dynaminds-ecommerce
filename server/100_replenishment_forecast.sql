-- Aggregate only recorded physical dispatch/restock. No order/status/recipe joins.
CREATE INDEX replenishment_forecast_movements ON public.stock_movements
 (tenant_id,warehouse_id,product_id,created_at,id)
 WHERE order_id IS NOT NULL AND ((kind='shipment' AND delta<0) OR (kind='return' AND delta>0));

CREATE FUNCTION replenishment_forecast_totals(warehouse uuid, products uuid[], window_from timestamptz, window_to timestamptz)
RETURNS TABLE(product_id uuid,shipped_quantity text,restocked_return_quantity text,shipment_movement_count text,return_movement_count text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF cardinality(products) IS NULL OR cardinality(products)<1 OR cardinality(products)>500
  OR window_from IS NULL OR window_to IS NULL OR window_from>=window_to
  OR window_to-window_from>interval '90 days' THEN
  RAISE EXCEPTION 'Invalid replenishment forecast scope' USING ERRCODE='22023';
 END IF;
 RETURN QUERY SELECT m.product_id,
 coalesce(sum(-(m.delta::bigint)) FILTER(WHERE m.kind='shipment' AND m.delta<0),0)::text,
 coalesce(sum(m.delta::bigint) FILTER(WHERE m.kind='return' AND m.delta>0),0)::text,
 count(*) FILTER(WHERE m.kind='shipment' AND m.delta<0)::text,
 count(*) FILTER(WHERE m.kind='return' AND m.delta>0)::text
 FROM public.stock_movements m
 WHERE m.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 AND m.warehouse_id=warehouse AND m.product_id=ANY(products)
 AND m.created_at>=window_from AND m.created_at<window_to AND m.order_id IS NOT NULL
 AND ((m.kind='shipment' AND m.delta<0) OR (m.kind='return' AND m.delta>0))
 GROUP BY m.product_id;
END $$;
REVOKE ALL ON FUNCTION replenishment_forecast_totals(uuid,uuid[],timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replenishment_forecast_totals(uuid,uuid[],timestamptz,timestamptz) TO dyna_app;

-- Same upfront shared stock-source gate used by dispatch. Exclusive preview/
-- execute owns this gate before stock/order locks; no late shared->exclusive upgrade.
CREATE FUNCTION replenishment_forecast_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Forecast journal truncation is not supported' USING ERRCODE='23514';END IF;
 PERFORM public.purchasing_stock_admit(); RETURN NULL;
END $$;
CREATE FUNCTION replenishment_forecast_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE scope uuid; t uuid; query text; BEGIN
 scope:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 query:=CASE TG_OP
 WHEN 'INSERT' THEN 'SELECT DISTINCT tenant_id FROM forecast_new_rows ORDER BY tenant_id'
 WHEN 'DELETE' THEN 'SELECT DISTINCT tenant_id FROM forecast_old_rows ORDER BY tenant_id'
 ELSE 'SELECT tenant_id FROM forecast_new_rows UNION SELECT tenant_id FROM forecast_old_rows ORDER BY tenant_id' END;
 FOR t IN EXECUTE query LOOP
  IF scope IS NOT NULL AND t IS DISTINCT FROM scope THEN
   RAISE EXCEPTION 'Forecast journal statement crosses declared tenant scope' USING ERRCODE='42501';
  END IF;
  -- Private, owner-only append marker; no counter row lock and no cache/GUC proof.
  INSERT INTO public.purchasing_stock_changes(tenant_id) VALUES(t);
 END LOOP; RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION replenishment_forecast_before(),replenishment_forecast_changed() FROM PUBLIC,dyna_app;
CREATE TRIGGER replenishment_forecast_admission BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.stock_movements FOR EACH STATEMENT EXECUTE FUNCTION replenishment_forecast_before();
CREATE TRIGGER replenishment_forecast_insert AFTER INSERT ON public.stock_movements REFERENCING NEW TABLE AS forecast_new_rows FOR EACH STATEMENT EXECUTE FUNCTION replenishment_forecast_changed();
CREATE TRIGGER replenishment_forecast_update AFTER UPDATE ON public.stock_movements REFERENCING OLD TABLE AS forecast_old_rows NEW TABLE AS forecast_new_rows FOR EACH STATEMENT EXECUTE FUNCTION replenishment_forecast_changed();
CREATE TRIGGER replenishment_forecast_delete AFTER DELETE ON public.stock_movements REFERENCING OLD TABLE AS forecast_old_rows FOR EACH STATEMENT EXECUTE FUNCTION replenishment_forecast_changed();
