CREATE TABLE order_field_batch_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,request_hash text NOT NULL,scope_hash text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('bulk','csv')),policy text NOT NULL CHECK(policy IN ('fill_unset','replace')),source text NOT NULL CHECK(source IN ('manual','api','csv_import')),
 definitions_snapshot jsonb NOT NULL,config jsonb,filename text,encrypted_bytes text,byte_count integer,file_hash text,summary jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,UNIQUE(tenant_id,id),UNIQUE(tenant_id,actor_id,client_key),
 CHECK(request_hash ~ '^[a-f0-9]{64}$' AND scope_hash ~ '^[a-f0-9]{64}$'),
 CHECK((kind='bulk' AND encrypted_bytes IS NULL AND byte_count IS NULL AND file_hash IS NULL AND config IS NULL AND filename IS NULL) OR (kind='csv' AND encrypted_bytes IS NOT NULL AND byte_count IS NOT NULL AND file_hash IS NOT NULL AND byte_count BETWEEN 1 AND 5242880 AND file_hash ~ '^[a-f0-9]{64}$' AND config IS NOT NULL AND filename IS NOT NULL))
);
CREATE INDEX order_field_preview_page ON order_field_batch_previews(tenant_id,created_at DESC,id DESC);
CREATE INDEX order_field_preview_active ON order_field_batch_previews(tenant_id,expires_at);
CREATE TABLE order_field_batch_rows (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,preview_id uuid NOT NULL,position integer NOT NULL CHECK(position BETWEEN 0 AND 4999),order_id uuid,order_version bigint,
 status text NOT NULL CHECK(status IN ('ready','no_op','invalid','conflict')),snapshot jsonb NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,preview_id,id),UNIQUE(tenant_id,preview_id,position),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES order_field_batch_previews(tenant_id,id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 CHECK(status NOT IN ('ready','no_op') OR (order_id IS NOT NULL AND order_version IS NOT NULL AND order_version>0))
);
CREATE INDEX order_field_batch_row_page ON order_field_batch_rows(tenant_id,preview_id,position,id);
CREATE TABLE order_field_batch_executions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,request_hash text NOT NULL,selection_hash text NOT NULL,
 consent jsonb NOT NULL,source text NOT NULL CHECK(source IN ('manual','api','csv_import')),selected_count integer NOT NULL CHECK(selected_count BETWEEN 1 AND 100),job_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','done','conflict','failed','cancelled')),result jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,preview_id),UNIQUE(tenant_id,actor_id,client_key),UNIQUE(tenant_id,job_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES order_field_batch_previews(tenant_id,id),FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),CHECK(request_hash ~ '^[a-f0-9]{64}$' AND selection_hash ~ '^[a-f0-9]{64}$'),
 CHECK((state='queued')=(finished_at IS NULL)),CHECK(state<>'done' OR result IS NOT NULL)
);
CREATE INDEX order_field_execution_page ON order_field_batch_executions(tenant_id,created_at DESC,id DESC);
CREATE INDEX order_field_execution_queued ON order_field_batch_executions(tenant_id,job_id) WHERE state='queued';
CREATE TABLE order_field_batch_execution_rows (
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,preview_id uuid NOT NULL,row_id uuid NOT NULL,PRIMARY KEY(tenant_id,execution_id,row_id),
 FOREIGN KEY(tenant_id,execution_id,preview_id) REFERENCES order_field_batch_executions(tenant_id,id,preview_id),FOREIGN KEY(tenant_id,preview_id,row_id) REFERENCES order_field_batch_rows(tenant_id,preview_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['order_field_batch_previews','order_field_batch_rows','order_field_batch_executions','order_field_batch_execution_rows'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
 END LOOP;END $$;
GRANT UPDATE(state,result,error,finished_at) ON order_field_batch_executions TO dyna_app;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['order_field_batch_previews','order_field_batch_rows','order_field_batch_execution_rows'] LOOP
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION order_field_immutable()',t);END LOOP;END $$;
CREATE FUNCTION order_field_execution_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.state<>'queued' OR NEW.state='queued' OR ROW(NEW.id,NEW.tenant_id,NEW.preview_id,NEW.actor_id,NEW.client_key,NEW.request_hash,NEW.selection_hash,NEW.consent,NEW.source,NEW.selected_count,NEW.job_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.preview_id,OLD.actor_id,OLD.client_key,OLD.request_hash,OLD.selection_hash,OLD.consent,OLD.source,OLD.selected_count,OLD.job_id,OLD.created_at) THEN RAISE EXCEPTION 'Order field execution scope and terminal result are immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER execution_scope BEFORE UPDATE ON order_field_batch_executions FOR EACH ROW EXECUTE FUNCTION order_field_execution_scope();
CREATE TRIGGER immutable_delete BEFORE DELETE ON order_field_batch_executions FOR EACH ROW EXECUTE FUNCTION order_field_immutable();
