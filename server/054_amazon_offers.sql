ALTER TABLE amazon_api_buckets DROP CONSTRAINT amazon_api_buckets_family_check;
ALTER TABLE amazon_api_buckets ADD CONSTRAINT amazon_api_buckets_family_check
 CHECK(family IN ('search','order','oauth','listings_search','listings_get','report_create','report_status','report_document','sellers','listing_write'));
-- Regional FBM inventory belongs to the seller/SKU, including connections in different local tenants.
-- The table is service-only. Tenant callers receive only their opaque scope and a conflict boolean.
CREATE TABLE amazon_offer_scopes (
 scope_hash text PRIMARY KEY CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 plan_id uuid NOT NULL UNIQUE REFERENCES offer_plans(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON amazon_offer_scopes FROM PUBLIC,dyna_app;
CREATE FUNCTION amazon_offer_scope(p_plan uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(ch.mode,ch.settings->>'region',ch.settings->>'selling_partner_id',p.remote_id,
 CASE WHEN ch.settings->>'simulation'='true' THEN p.tenant_id::text ELSE '' END)::text,'UTF8')),'hex')
 FROM public.offer_plans p JOIN public.channels ch ON ch.id=p.channel_id
 WHERE p.id=p_plan AND p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND ch.provider='amazon'
$$;
CREATE FUNCTION amazon_offer_claim(p_plan uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
DECLARE k text; t uuid; current_plan uuid;
BEGIN
 k := public.amazon_offer_scope(p_plan);
 t := nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF k IS NULL THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('amazon-claim:'||k,0));
 SELECT plan_id INTO current_plan FROM public.amazon_offer_scopes WHERE scope_hash=k FOR UPDATE;
 -- A stopped task that never dispatched can be replaced. An uncertain mutation cannot.
 DELETE FROM public.amazon_offer_scopes s USING public.offer_plans p
 WHERE s.scope_hash=k AND s.plan_id=p.id AND s.plan_id<>p_plan
 AND (p.state='done' OR (p.phase='ready' AND p.state IN ('failed','conflict')));
 INSERT INTO public.amazon_offer_scopes(scope_hash,tenant_id,plan_id) VALUES(k,t,p_plan) ON CONFLICT DO NOTHING;
 RETURN EXISTS(SELECT 1 FROM public.amazon_offer_scopes WHERE scope_hash=k AND tenant_id=t AND plan_id=p_plan);
END $$;
CREATE FUNCTION amazon_offer_release(p_plan uuid) RETURNS void LANGUAGE sql SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
 DELETE FROM public.amazon_offer_scopes s USING public.offer_plans p WHERE s.plan_id=p.id AND p.id=p_plan
 AND s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 AND (p.state='done' OR (p.phase='ready' AND p.state IN ('failed','conflict')))
$$;
REVOKE ALL ON FUNCTION amazon_offer_scope(uuid),amazon_offer_claim(uuid),amazon_offer_release(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amazon_offer_scope(uuid),amazon_offer_claim(uuid),amazon_offer_release(uuid) TO dyna_app;
