CREATE TABLE workflow_statuses (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,name text NOT NULL,color text NOT NULL DEFAULT '#3455db',
 stage text NOT NULL,active boolean NOT NULL DEFAULT true,version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,name),
 CHECK(stage IN ('new','paid','picking','packed','shipped','delivered','completed','cancelled','return_initiated','return_received','return_completed'))
);
ALTER TABLE orders ADD COLUMN workflow_status_id uuid;
ALTER TABLE orders ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE orders ADD COLUMN version bigint NOT NULL DEFAULT 1;
ALTER TABLE orders ADD FOREIGN KEY(tenant_id,workflow_status_id) REFERENCES workflow_statuses(tenant_id,id);
ALTER TABLE orders ADD CHECK(cardinality(tags)<=20);
CREATE FUNCTION order_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.status<>OLD.status AND NEW.workflow_status_id IS NOT DISTINCT FROM OLD.workflow_status_id THEN NEW.workflow_status_id=NULL; END IF;
 NEW.version=OLD.version+1; RETURN NEW; END $$;
CREATE TRIGGER order_revision BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION order_revision();
CREATE INDEX orders_workflow_page ON orders(tenant_id,workflow_status_id,created_at DESC,id DESC);
CREATE INDEX orders_tags ON orders USING gin(tags);
ALTER TABLE automation_rules ADD UNIQUE(tenant_id,id);
ALTER TABLE automation_rules ADD COLUMN version bigint NOT NULL DEFAULT 1;
ALTER TABLE automation_rules ADD COLUMN actor_id uuid REFERENCES users;
ALTER TABLE automation_rules ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE automation_rules ADD COLUMN priority integer NOT NULL DEFAULT 50 CHECK(priority BETWEEN 0 AND 100);
ALTER TABLE automation_rules ADD COLUMN delay_seconds integer NOT NULL DEFAULT 0 CHECK(delay_seconds BETWEEN 0 AND 604800);
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_action_check;
ALTER TABLE automation_rules ADD CHECK(action IN ('add_note','actions'));
CREATE INDEX automation_trigger ON automation_rules(tenant_id,trigger,priority,id) WHERE enabled;
ALTER TABLE jobs ADD UNIQUE(tenant_id,id);
ALTER TABLE jobs ADD COLUMN priority integer NOT NULL DEFAULT 100 CHECK(priority BETWEEN 0 AND 100);
DROP INDEX jobs_claim;
CREATE INDEX jobs_claim ON jobs(run_at,priority,created_at,id) WHERE state='pending';
ALTER TABLE order_events ADD UNIQUE(tenant_id,id);
CREATE TABLE automation_runs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,rule_id uuid NOT NULL,rule_version bigint NOT NULL,event_id uuid NOT NULL,order_id uuid NOT NULL,
 job_id uuid NOT NULL,definition jsonb NOT NULL,snapshot jsonb NOT NULL,context jsonb NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','done','skipped','failed')),
 result jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(tenant_id,event_id,rule_id,rule_version),
 FOREIGN KEY(tenant_id,rule_id) REFERENCES automation_rules(tenant_id,id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES order_events(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE INDEX automation_runs_page ON automation_runs(tenant_id,created_at DESC,id DESC);
CREATE TABLE order_batches (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,action jsonb NOT NULL,
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','queued','done','failed','cancelled')),
 job_id uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE INDEX order_batches_page ON order_batches(tenant_id,created_at DESC,id DESC);
CREATE TABLE order_batch_items (
 tenant_id uuid NOT NULL,batch_id uuid NOT NULL,order_id uuid NOT NULL,number text NOT NULL,snapshot jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','failed','skipped')),preview jsonb NOT NULL,result jsonb,error text,
 PRIMARY KEY(tenant_id,batch_id,order_id),
 FOREIGN KEY(tenant_id,batch_id) REFERENCES order_batches(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['workflow_statuses','automation_runs','order_batches','order_batch_items'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP; END $$;
