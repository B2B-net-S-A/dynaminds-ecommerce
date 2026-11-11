CREATE TABLE offer_sync_configs (
 tenant_id uuid NOT NULL,channel_id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES users,
 enabled boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 warehouse_id uuid NOT NULL,price_list_id uuid,stock boolean NOT NULL,price boolean NOT NULL,CHECK(stock OR price),
 interval_seconds integer NOT NULL CHECK(interval_seconds BETWEEN 30 AND 86400),
 verify_seconds integer NOT NULL CHECK(verify_seconds BETWEEN 60 AND 86400),
 external_authorized boolean NOT NULL DEFAULT false,connection_hash text NOT NULL,
 next_run_at timestamptz,last_run_at timestamptz,last_job_id uuid REFERENCES jobs,error text,
 updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,channel_id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,price_list_id) REFERENCES price_lists(tenant_id,id),
 CHECK(price OR price_list_id IS NULL)
);
CREATE INDEX offer_sync_due ON offer_sync_configs(next_run_at,channel_id) WHERE enabled;
ALTER TABLE offer_plans ADD COLUMN sync_version integer CHECK(sync_version>0);
ALTER TABLE offer_plans ADD UNIQUE(tenant_id,id);
CREATE INDEX offer_sync_pending ON offer_plans(tenant_id,channel_id,id) WHERE sync_version IS NOT NULL AND state='queued' AND phase='ready';
CREATE INDEX listings_sync_page ON listings(tenant_id,channel_id,id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX jobs_one_offer_sync ON jobs(tenant_id,(payload->>'channel_id')) WHERE kind='offer.sync' AND state IN ('pending','running');
CREATE TABLE offer_sync_items (
 tenant_id uuid NOT NULL,channel_id uuid NOT NULL,listing_id uuid NOT NULL,
 config_version integer NOT NULL,desired_hash text,verified_hash text,last_checked_at timestamptz,
 plan_id uuid,plan_acknowledged boolean NOT NULL DEFAULT false,
 state text NOT NULL CHECK(state IN ('queued','verified','unchanged','waiting','blocked','error')),
 error text,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,channel_id,listing_id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES offer_sync_configs(tenant_id,channel_id),
 FOREIGN KEY(tenant_id,listing_id) REFERENCES listings(tenant_id,id),
 FOREIGN KEY(tenant_id,plan_id) REFERENCES offer_plans(tenant_id,id)
);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['offer_sync_configs','offer_sync_items'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP;END $$;

-- Memberships remain private to authentication. Expose only the current tenant's admin check.
CREATE FUNCTION offer_sync_is_admin(actor_id uuid) RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT role='admin' FROM public.memberships
 WHERE user_id=actor_id AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 FOR SHARE
$$;
REVOKE ALL ON FUNCTION offer_sync_is_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION offer_sync_is_admin(uuid) TO dyna_app;
