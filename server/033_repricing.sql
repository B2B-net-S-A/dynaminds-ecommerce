CREATE TABLE repricing_rules (
 tenant_id uuid NOT NULL, price_list_id uuid NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,price_list_id), FOREIGN KEY(tenant_id,price_list_id) REFERENCES price_lists(tenant_id,id)
);
CREATE TABLE repricing_inputs (
 tenant_id uuid NOT NULL,price_list_id uuid NOT NULL,product_id uuid NOT NULL,
 net_cost integer NOT NULL CHECK(net_cost BETWEEN 0 AND 100000000),
 competitor_price integer CHECK(competitor_price BETWEEN 0 AND 100000000), observed_at timestamptz,
 source text NOT NULL CHECK(length(source) BETWEEN 2 AND 200),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((competitor_price IS NULL)=(observed_at IS NULL)),
 PRIMARY KEY(tenant_id,price_list_id,product_id),
 FOREIGN KEY(tenant_id,price_list_id) REFERENCES repricing_rules(tenant_id,price_list_id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE TABLE repricing_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,price_list_id uuid NOT NULL,client_key uuid NOT NULL,
 product_ids uuid[] NOT NULL CHECK(cardinality(product_ids) BETWEEN 1 AND 500),
 rule_version integer NOT NULL,list_version integer NOT NULL,currency text NOT NULL,
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='array'),
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','applied')),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 applied_at timestamptz,applied_list_version integer,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,price_list_id) REFERENCES repricing_rules(tenant_id,price_list_id)
);
CREATE INDEX repricing_previews_page ON repricing_previews(tenant_id,price_list_id,id);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['repricing_rules','repricing_inputs','repricing_previews'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP; END $$;
