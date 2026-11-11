CREATE TABLE b2b_accounts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,name text NOT NULL,email text NOT NULL,tax_id text NOT NULL DEFAULT '',
 active boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,
 warehouse_id uuid NOT NULL,price_list_id uuid NOT NULL,address jsonb NOT NULL,
 min_total integer NOT NULL DEFAULT 0 CHECK(min_total BETWEEN 0 AND 2147483647),
 min_quantity integer NOT NULL DEFAULT 1 CHECK(min_quantity BETWEEN 1 AND 100000),
 quantity_step integer NOT NULL DEFAULT 1 CHECK(quantity_step BETWEEN 1 AND 100000),
 shipping_cost integer NOT NULL DEFAULT 0 CHECK(shipping_cost BETWEEN 0 AND 1000000),
 payment_mode text NOT NULL CHECK(payment_mode IN ('prepaid','cod')),
 password_hash text,invite_hash text UNIQUE,invite_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,email),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,price_list_id) REFERENCES price_lists(tenant_id,id)
);
CREATE INDEX b2b_account_page ON b2b_accounts(tenant_id,id);
CREATE TABLE b2b_sessions (
 token_hash text PRIMARY KEY,tenant_id uuid NOT NULL,account_id uuid NOT NULL,expires_at timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,account_id) REFERENCES b2b_accounts(tenant_id,id)
);
CREATE INDEX b2b_session_account ON b2b_sessions(tenant_id,account_id);
CREATE INDEX b2b_session_expiry ON b2b_sessions(expires_at);
CREATE TABLE b2b_quotes (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,account_id uuid NOT NULL,client_key uuid NOT NULL,
 fingerprint text NOT NULL,account_version integer NOT NULL,input jsonb NOT NULL,pricing jsonb NOT NULL,total integer NOT NULL,
 order_id uuid,expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,account_id,client_key),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES b2b_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
ALTER TABLE orders ADD COLUMN b2b_account_id uuid,ADD COLUMN b2b_snapshot jsonb;
ALTER TABLE orders ADD FOREIGN KEY(tenant_id,b2b_account_id) REFERENCES b2b_accounts(tenant_id,id);
CREATE INDEX b2b_order_history ON orders(tenant_id,b2b_account_id,created_at DESC,id DESC) WHERE b2b_account_id IS NOT NULL;
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['b2b_accounts','b2b_sessions','b2b_quotes'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
 END LOOP;
END $$;
