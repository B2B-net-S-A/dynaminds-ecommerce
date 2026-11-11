-- Local estimates only; no provider, tax invoice or payment is implied.
CREATE TABLE workspace_plan_rates (
 plan text PRIMARY KEY REFERENCES service_plans(code),version integer NOT NULL DEFAULT 1,
 currency text NOT NULL CHECK(currency='PLN'),monthly_amount integer NOT NULL CHECK(monthly_amount>=0)
);
INSERT INTO workspace_plan_rates(plan,currency,monthly_amount) VALUES('starter','PLN',0),('business','PLN',19900),('enterprise','PLN',99900);
CREATE TABLE workspace_billing_accounts (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 plan text NOT NULL REFERENCES service_plans(code),currency text NOT NULL CHECK(currency='PLN'),monthly_amount integer NOT NULL CHECK(monthly_amount>=0),
 period_start timestamptz NOT NULL,period_end timestamptz NOT NULL CHECK(period_end>period_start),
 current_terms jsonb NOT NULL,auto_renew boolean NOT NULL DEFAULT false,next_terms jsonb,next_error text,retry_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_billing_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),actor_id uuid NOT NULL REFERENCES users(id),
 version integer NOT NULL,kind text NOT NULL CHECK(kind IN ('activate','change','schedule','renew')),
 terms jsonb NOT NULL,before_plan text NOT NULL,before_terms jsonb NOT NULL,usage jsonb NOT NULL,
 effective_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','committed')),
 result jsonb,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
CREATE TABLE workspace_billing_entries (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),key text NOT NULL,kind text NOT NULL,
 plan text NOT NULL,currency text NOT NULL CHECK(currency='PLN'),amount integer NOT NULL,
 period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,terms jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,key)
);
CREATE INDEX workspace_billing_history ON workspace_billing_entries(tenant_id,created_at DESC,id DESC);
CREATE INDEX workspace_billing_due ON workspace_billing_accounts(period_end,tenant_id) WHERE auto_renew;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['workspace_billing_accounts','workspace_billing_previews','workspace_billing_entries'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON %I TO dyna_app',t);
END LOOP;END $$;
GRANT SELECT ON workspace_plan_rates TO dyna_app;
CREATE FUNCTION workspace_billing_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_TABLE_NAME='workspace_billing_entries' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'Billing history is immutable'; END IF;
 IF (NEW.id,NEW.tenant_id,NEW.actor_id,NEW.version,NEW.kind,NEW.terms,NEW.before_plan,NEW.before_terms,NEW.usage,NEW.effective_at,NEW.expires_at,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.actor_id,OLD.version,OLD.kind,OLD.terms,OLD.before_plan,OLD.before_terms,OLD.usage,OLD.effective_at,OLD.expires_at,OLD.created_at)
 OR OLD.state='committed' THEN RAISE EXCEPTION 'Billing preview is immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER workspace_billing_entry_immutable BEFORE UPDATE OR DELETE ON workspace_billing_entries FOR EACH ROW EXECUTE FUNCTION workspace_billing_immutable();
CREATE TRIGGER workspace_billing_preview_immutable BEFORE UPDATE OR DELETE ON workspace_billing_previews FOR EACH ROW EXECUTE FUNCTION workspace_billing_immutable();
