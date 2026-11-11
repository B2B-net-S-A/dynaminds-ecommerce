-- Applied atomically with migration108; only future parcel evidence changes.
CREATE OR REPLACE FUNCTION shopify_capture_dispatch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.orders%ROWTYPE; p public.shipping_plans%ROWTYPE; receiver jsonb; items jsonb; r jsonb;
BEGIN
 IF NEW.dispatched_at IS NULL OR (TG_OP='UPDATE' AND OLD.dispatched_at IS NOT NULL) THEN RETURN NEW; END IF;
 IF (current_setting('role',true)='dyna_app' OR nullif(current_setting('app.tenant_id',true),'') IS NOT NULL) AND NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Inna firma dowodu paczki';END IF;
 SELECT * INTO o FROM public.orders WHERE tenant_id=NEW.tenant_id AND id=NEW.order_id;
 SELECT * INTO p FROM public.shipping_plans WHERE tenant_id=NEW.tenant_id AND shipment_id=NEW.id AND state IN('ready','dispatched') ORDER BY created_at DESC,id DESC LIMIT 1;
 IF NEW.mode='demo' AND p.id IS NULL THEN receiver:=jsonb_build_object('customer_name',o.customer_name,'email',o.email,'address',o.address);
 ELSIF p.id IS NOT NULL THEN
  IF p.input->>'provider'='dpd' THEN
   r:=p.payload#>'{packages,0,receiver}';
   receiver:=jsonb_build_object('customer_name',r->>'name','email',r->>'email','address',jsonb_build_object('street',r->>'address','city',r->>'city','postal_code',r->>'postalCode','country',r->>'countryCode','phone',r->>'phone'));
  ELSE
   r:=p.payload->'receiver';
   -- Parcel lockers do not prove a street recipient, so cannot confirm source courier delivery.
   IF p.input->>'service'='inpost_courier_standard' THEN
    receiver:=jsonb_build_object('customer_name',concat(r->>'first_name',' ',r->>'last_name'),'email',r->>'email','address',jsonb_build_object('street',concat(r#>>'{address,street}',' ',r#>>'{address,building_number}'),'city',r#>>'{address,city}','postal_code',r#>>'{address,post_code}','country',r#>>'{address,country_code}','phone',r->>'phone'));
   END IF;
  END IF;
 END IF;
 -- A local parcel contains only the local remainder of exact commercial lines.
 -- Historical dispatch records are never rewritten by this new factory.
 SELECT coalesce(jsonb_agg(CASE WHEN x.quantity>0 THEN to_jsonb(i)||jsonb_build_object(
   'quantity',i.quantity-x.quantity,'original_quantity',i.quantity,'external_quantity',x.quantity)
   ELSE to_jsonb(i) END ORDER BY i.id),'[]'::jsonb) INTO items
 FROM public.order_items i LEFT JOIN LATERAL(
  SELECT coalesce(sum(l.quantity),0)::integer quantity FROM public.b2b_dropship_lines l
  JOIN public.b2b_dropship_orders d ON(d.tenant_id,d.id)=(l.tenant_id,l.order_id)
  WHERE l.tenant_id=NEW.tenant_id AND l.customer_order_id=NEW.order_id
   AND l.customer_item_id=i.id AND d.state='ordered'
 ) x ON true WHERE i.tenant_id=NEW.tenant_id AND i.order_id=NEW.order_id
  AND i.quantity>x.quantity;
 -- Preserve the first dispatch witness when a mutable shipment stamp is restored.
 INSERT INTO public.shopify_dispatch_evidence(tenant_id,shipment_id,order_id,receiver,items,dispatched_at)
 VALUES(NEW.tenant_id,NEW.id,NEW.order_id,receiver,items,NEW.dispatched_at)
 ON CONFLICT(tenant_id,shipment_id) DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION shopify_capture_dispatch() FROM PUBLIC,dyna_app;
