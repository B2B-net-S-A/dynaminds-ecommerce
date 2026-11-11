CREATE TABLE amazon_fulfillment_plans (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,shipment_id uuid NOT NULL,channel_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,local_hash text NOT NULL,connection_hash text NOT NULL,
 account_scope jsonb NOT NULL CHECK(jsonb_typeof(account_scope)='array' AND jsonb_array_length(account_scope)=5),
 payload jsonb NOT NULL,remote jsonb NOT NULL,state text NOT NULL DEFAULT 'preview'
 CHECK(state IN ('preview','queued','done','conflict','failed','cancelled')),
 phase text NOT NULL DEFAULT 'ready' CHECK(phase IN ('ready','write_started','verify','done')),
 job_id uuid,remote_id text,result jsonb,error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,shipment_id) REFERENCES shipments(tenant_id,id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE INDEX amazon_fulfillment_order_page ON amazon_fulfillment_plans(tenant_id,order_id,created_at DESC,id DESC);
CREATE INDEX amazon_fulfillment_channel_page ON amazon_fulfillment_plans(tenant_id,channel_id,state);
CREATE UNIQUE INDEX amazon_fulfillment_one_active ON amazon_fulfillment_plans(tenant_id,order_id)
 WHERE state='queued' OR (state IN ('failed','conflict') AND phase IN ('write_started','verify'));
CREATE TABLE amazon_fulfillment_simulations (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,fulfillments jsonb NOT NULL DEFAULT '[]',
 PRIMARY KEY(tenant_id,order_id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['amazon_fulfillment_plans','amazon_fulfillment_simulations'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP;END $$;

ALTER TABLE amazon_api_buckets DROP CONSTRAINT amazon_api_buckets_family_check;
ALTER TABLE amazon_api_buckets ADD CONSTRAINT amazon_api_buckets_family_check CHECK(family IN ('search','order','oauth','listings_search','listings_get','report_create','report_status','report_document','sellers','listing_write','shipment_write'));
CREATE TABLE amazon_fulfillment_scopes (
 scope_hash text PRIMARY KEY CHECK(scope_hash ~ '^[a-f0-9]{64}$'), tenant_id uuid NOT NULL REFERENCES tenants(id),
 plan_id uuid NOT NULL UNIQUE REFERENCES amazon_fulfillment_plans(id), created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON amazon_fulfillment_scopes FROM PUBLIC,dyna_app;
-- Frozen account/order identity permits GET reconciliation of the original account after local edits.
CREATE FUNCTION amazon_fulfillment_scope(p_plan uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(p.account_scope::text,'UTF8')),'hex') FROM public.amazon_fulfillment_plans p
 WHERE p.id=p_plan AND p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
$$;
CREATE FUNCTION amazon_fulfillment_claim(p_plan uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE k text; t uuid;
BEGIN
 k:=public.amazon_fulfillment_scope(p_plan); t:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF k IS NULL THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('amazon-fulfillment-claim:'||k,0));
 DELETE FROM public.amazon_fulfillment_scopes s USING public.amazon_fulfillment_plans p
 WHERE s.scope_hash=k AND s.plan_id=p.id AND s.plan_id<>p_plan AND p.phase='ready' AND p.state IN ('failed','conflict','cancelled');
 INSERT INTO public.amazon_fulfillment_scopes(scope_hash,tenant_id,plan_id) VALUES(k,t,p_plan) ON CONFLICT DO NOTHING;
 RETURN EXISTS(SELECT 1 FROM public.amazon_fulfillment_scopes WHERE scope_hash=k AND tenant_id=t AND plan_id=p_plan);
END $$;
CREATE FUNCTION amazon_fulfillment_release(p_plan uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DELETE FROM public.amazon_fulfillment_scopes s USING public.amazon_fulfillment_plans p
 WHERE s.plan_id=p.id AND p.id=p_plan AND s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 AND p.phase='ready' AND p.state IN ('failed','conflict','cancelled')
$$;
REVOKE ALL ON FUNCTION amazon_fulfillment_scope(uuid),amazon_fulfillment_claim(uuid),amazon_fulfillment_release(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amazon_fulfillment_scope(uuid),amazon_fulfillment_claim(uuid),amazon_fulfillment_release(uuid) TO dyna_app;
