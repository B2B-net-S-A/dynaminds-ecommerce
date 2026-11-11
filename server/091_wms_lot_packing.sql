-- Preserve every pre-WMS fulfillment hash. Only enabled workspaces add lot assignments.
CREATE FUNCTION packing_fulfillment_snapshot_without_lots(p_order uuid,p_status text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('order_id',o.id,'warehouse_id',o.warehouse_id,'status',coalesce(p_status,o.status),
 'order_items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'product_id',i.product_id,'quantity',i.quantity,'components',i.components) ORDER BY i.id) FROM order_items i WHERE (i.tenant_id,i.order_id)=(o.tenant_id,o.id)),'[]'::jsonb),
 'physical',coalesce((SELECT jsonb_agg(jsonb_build_object('product_id',i.product_id,'order_sku',i.sku,'order_ean',i.ean,'name',i.name,'quantity',i.quantity,'scanned',i.scanned) ORDER BY i.product_id) FROM order_pick_items i WHERE (i.tenant_id,i.order_id)=(o.tenant_id,o.id)),'[]'::jsonb),
 'reservations',coalesce((SELECT jsonb_agg(jsonb_build_object('product_id',r.product_id,'warehouse_id',r.warehouse_id,'quantity',r.quantity,'state',r.state) ORDER BY r.product_id) FROM reservations r WHERE (r.tenant_id,r.order_id)=(o.tenant_id,o.id)),'[]'::jsonb),
 'allocations',coalesce((SELECT jsonb_agg(jsonb_build_object('product_id',r.product_id,'warehouse_id',r.warehouse_id,'location',r.location,'quantity',r.quantity,'scanned',r.scanned) ORDER BY r.product_id,r.location) FROM reservation_locations r WHERE (r.tenant_id,r.order_id)=(o.tenant_id,o.id)),'[]'::jsonb))
 FROM orders o WHERE o.id=p_order AND o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
$$;
CREATE OR REPLACE FUNCTION packing_fulfillment_snapshot(p_order uuid,p_status text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE snapshot jsonb; BEGIN
 snapshot:=packing_fulfillment_snapshot_without_lots(p_order,p_status);
 IF snapshot IS NULL OR NOT EXISTS(SELECT 1 FROM wms_policies
   WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND enabled) THEN
   RETURN snapshot;
 END IF;
 RETURN snapshot || jsonb_build_object('wms_lot_allocations',coalesce((
   SELECT jsonb_agg(jsonb_build_object('product_id',product_id,'warehouse_id',warehouse_id,
     'location',location,'layer_id',layer_id,'quantity',quantity,'scanned',scanned,'state',state)
     ORDER BY product_id,warehouse_id,layer_id,location COLLATE "C")
   FROM wms_reservation_layers WHERE order_id=p_order
     AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 ),'[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION packing_fulfillment_snapshot_without_lots(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION packing_fulfillment_snapshot_without_lots(uuid,text) TO dyna_app;

CREATE FUNCTION wms_key_order_grant(p_user uuid,p_key uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k record; BEGIN
 SELECT * INTO k FROM api_keys WHERE (tenant_id,user_id,id)=
   (nullif(current_setting('app.tenant_id',true),'')::uuid,p_user,p_key) FOR SHARE;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR
   (k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN RETURN 'invalid';END IF;
 IF NOT k.scopes @> ARRAY['inventory:read','inventory:write','orders:read','orders:write']::text[]
   THEN RETURN 'insufficient';END IF;
 RETURN 'ok';
END $$;
REVOKE ALL ON FUNCTION wms_key_order_grant(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wms_key_order_grant(uuid,uuid) TO dyna_app;
