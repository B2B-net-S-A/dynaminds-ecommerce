-- Memberships are authentication data and deliberately have no dyna_app table grant.
-- Expose only a locked admin check within the current tenant, never membership rows.
CREATE FUNCTION b2b_network_admin(uid uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tid uuid=nullif(current_setting('app.tenant_id',true),'')::uuid; member_role text;
BEGIN
 PERFORM 1 FROM public.tenants WHERE id=tid FOR SHARE;
 SELECT role INTO member_role FROM public.memberships WHERE tenant_id=tid AND user_id=uid FOR SHARE;
 RETURN coalesce(member_role='admin',false);
END $$;
REVOKE ALL ON FUNCTION b2b_network_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_network_admin(uuid) TO dyna_app;
CREATE TABLE b2b_link_invitations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,account_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 recipient_email text NOT NULL,token_hash text UNIQUE NOT NULL,account_version integer NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','revoked')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,account_id) REFERENCES b2b_accounts(tenant_id,id)
);
CREATE INDEX b2b_link_invites_account ON b2b_link_invitations(tenant_id,account_id,created_at DESC,id DESC);
CREATE TABLE b2b_links (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,supplier_tenant_id uuid NOT NULL,account_id uuid NOT NULL,invitation_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,supplier_name text NOT NULL,paused boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 schedule_minutes integer NOT NULL DEFAULT 0 CHECK(schedule_minutes=0 OR schedule_minutes BETWEEN 5 AND 1440),
 next_at timestamptz,last_at timestamptz,last_run_id uuid,error text,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(tenant_id<>supplier_tenant_id),UNIQUE(supplier_tenant_id,account_id),UNIQUE(tenant_id,id),
 FOREIGN KEY(supplier_tenant_id,account_id) REFERENCES b2b_accounts(tenant_id,id),
 FOREIGN KEY(supplier_tenant_id,invitation_id) REFERENCES b2b_link_invitations(tenant_id,id)
);
CREATE INDEX b2b_links_page ON b2b_links(tenant_id,id);
CREATE INDEX b2b_links_due ON b2b_links(next_at,id) WHERE NOT paused AND schedule_minutes>0;
CREATE TABLE b2b_catalog_runs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,link_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,
 link_version integer NOT NULL,account_version integer NOT NULL,list_version integer NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','done','failed','cancelled')),
 cursor uuid,fetched integer NOT NULL DEFAULT 0 CHECK(fetched BETWEEN 0 AND 100000),job_id uuid REFERENCES jobs,error text,
 created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,link_id,client_key),FOREIGN KEY(tenant_id,link_id) REFERENCES b2b_links(tenant_id,id)
);
CREATE UNIQUE INDEX b2b_catalog_one_run ON b2b_catalog_runs(tenant_id,link_id) WHERE state='queued';
CREATE INDEX b2b_catalog_runs_page ON b2b_catalog_runs(tenant_id,link_id,created_at DESC,id DESC);
CREATE TABLE b2b_catalog_staging (
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,source_product_id uuid NOT NULL,snapshot jsonb NOT NULL,fingerprint text NOT NULL,
 PRIMARY KEY(tenant_id,run_id,source_product_id),FOREIGN KEY(tenant_id,run_id) REFERENCES b2b_catalog_runs(tenant_id,id)
);
CREATE TABLE b2b_catalog_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,link_id uuid NOT NULL,source_product_id uuid NOT NULL,
 snapshot jsonb NOT NULL,fingerprint text NOT NULL,published boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,
 product_id uuid,refreshed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,link_id,source_product_id),
 FOREIGN KEY(tenant_id,link_id) REFERENCES b2b_links(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE INDEX b2b_catalog_item_page ON b2b_catalog_items(tenant_id,link_id,id);
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['b2b_link_invitations','b2b_links','b2b_catalog_runs','b2b_catalog_staging','b2b_catalog_items'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
 END LOOP;
END $$;
