ALTER TABLE inbound_orders ADD CONSTRAINT inbound_tenant_id UNIQUE(tenant_id,id);
ALTER TABLE inbound_orders ADD CONSTRAINT inbound_tenant_channel UNIQUE(tenant_id,id,channel_id);
ALTER TABLE order_field_value_events ADD COLUMN provenance jsonb NOT NULL DEFAULT '{}';
CREATE TABLE order_field_mapping_profiles (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,provider text NOT NULL CHECK(provider IN ('woocommerce','allegro','shopify')),
 label text NOT NULL,enabled boolean NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),mappings jsonb NOT NULL CHECK(jsonb_typeof(mappings)='array' AND jsonb_array_length(mappings) BETWEEN 1 AND 20),
 connection_hash text NOT NULL CHECK(connection_hash ~ '^[a-f0-9]{64}$'),approved_by uuid NOT NULL REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,channel_id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE TABLE order_field_mapping_revisions (
 tenant_id uuid NOT NULL,profile_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),actor_id uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,profile_id,version),UNIQUE(tenant_id,actor_id,client_key),FOREIGN KEY(tenant_id,profile_id) REFERENCES order_field_mapping_profiles(tenant_id,id)
);
CREATE TABLE order_field_source_observations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,inbound_id uuid NOT NULL,channel_id uuid NOT NULL,profile_id uuid NOT NULL,profile_version integer NOT NULL,
 provider text NOT NULL CHECK(provider IN ('woocommerce','allegro','shopify')),external_id text NOT NULL,source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),connection_hash text NOT NULL CHECK(connection_hash ~ '^[a-f0-9]{64}$'),
 source_epoch timestamptz NOT NULL,encrypted_bytes text NOT NULL,byte_count integer NOT NULL CHECK(byte_count BETWEEN 1 AND 5242880),file_hash text NOT NULL CHECK(file_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,profile_id,profile_version,inbound_id),UNIQUE(tenant_id,inbound_id,profile_id,profile_version,source_hash,connection_hash,source_epoch),
 FOREIGN KEY(tenant_id,inbound_id,channel_id) REFERENCES inbound_orders(tenant_id,id,channel_id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),FOREIGN KEY(tenant_id,profile_id,profile_version) REFERENCES order_field_mapping_revisions(tenant_id,profile_id,version)
);
CREATE INDEX order_field_observation_latest ON order_field_source_observations(tenant_id,inbound_id,created_at DESC,id DESC);
CREATE INDEX order_field_observation_page ON order_field_source_observations(tenant_id,channel_id,created_at DESC,id DESC);
CREATE TABLE order_field_mapping_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK(kind IN ('initial','reconcile')),policy text NOT NULL CHECK(policy IN ('fill_unset','replace')),origin text NOT NULL CHECK(origin IN ('manual','api')),
 profile_id uuid NOT NULL,profile_version integer NOT NULL,profile_snapshot jsonb NOT NULL,definitions_snapshot jsonb NOT NULL,warehouse_id uuid,summary jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,kind),UNIQUE(tenant_id,id,profile_id,profile_version),UNIQUE(tenant_id,actor_id,client_key),
 FOREIGN KEY(tenant_id,profile_id,profile_version) REFERENCES order_field_mapping_revisions(tenant_id,profile_id,version),FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 CHECK((kind='initial')=(warehouse_id IS NOT NULL)),CHECK(kind<>'initial' OR policy='fill_unset')
);
CREATE INDEX order_field_mapping_preview_page ON order_field_mapping_previews(tenant_id,created_at DESC,id DESC);
CREATE INDEX order_field_mapping_preview_active ON order_field_mapping_previews(tenant_id,expires_at);
CREATE TABLE order_field_mapping_rows (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,preview_id uuid NOT NULL,profile_id uuid NOT NULL,profile_version integer NOT NULL,position integer NOT NULL CHECK(position BETWEEN 0 AND 99),inbound_id uuid NOT NULL,observation_id uuid NOT NULL,order_id uuid,order_version bigint,
 status text NOT NULL CHECK(status IN ('ready','no_op','invalid','conflict')),snapshot jsonb NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,preview_id,id),UNIQUE(tenant_id,preview_id,position),
 FOREIGN KEY(tenant_id,preview_id,profile_id,profile_version) REFERENCES order_field_mapping_previews(tenant_id,id,profile_id,profile_version),
 FOREIGN KEY(tenant_id,observation_id,profile_id,profile_version,inbound_id) REFERENCES order_field_source_observations(tenant_id,id,profile_id,profile_version,inbound_id),
 FOREIGN KEY(tenant_id,inbound_id) REFERENCES inbound_orders(tenant_id,id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),CHECK(order_id IS NULL OR (order_version IS NOT NULL AND order_version>0))
);
CREATE INDEX order_field_mapping_row_page ON order_field_mapping_rows(tenant_id,preview_id,position,id);
CREATE TABLE order_field_mapping_executions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,preview_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('initial','reconcile')),actor_id uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 selection_hash text NOT NULL CHECK(selection_hash ~ '^[a-f0-9]{64}$'),selected_count integer NOT NULL CHECK(selected_count BETWEEN 1 AND 100),consent jsonb NOT NULL,origin text NOT NULL CHECK(origin IN ('manual','api')),job_id uuid,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','done','conflict','failed','cancelled')),result jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,preview_id),UNIQUE(tenant_id,actor_id,client_key),UNIQUE(tenant_id,job_id),
 FOREIGN KEY(tenant_id,preview_id,kind) REFERENCES order_field_mapping_previews(tenant_id,id,kind),FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),
 CHECK((kind='reconcile')=(job_id IS NOT NULL)),CHECK(kind<>'initial' OR selected_count=1),CHECK((state='queued')=(finished_at IS NULL)),CHECK(state<>'done' OR result IS NOT NULL)
);
CREATE INDEX order_field_mapping_execution_page ON order_field_mapping_executions(tenant_id,created_at DESC,id DESC);
CREATE INDEX order_field_mapping_execution_queued ON order_field_mapping_executions(tenant_id,job_id) WHERE state='queued';
CREATE TABLE order_field_mapping_execution_rows (
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,preview_id uuid NOT NULL,row_id uuid NOT NULL,PRIMARY KEY(tenant_id,execution_id,row_id),
 FOREIGN KEY(tenant_id,execution_id,preview_id) REFERENCES order_field_mapping_executions(tenant_id,id,preview_id),FOREIGN KEY(tenant_id,preview_id,row_id) REFERENCES order_field_mapping_rows(tenant_id,preview_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['order_field_mapping_profiles','order_field_mapping_revisions','order_field_source_observations','order_field_mapping_previews','order_field_mapping_rows','order_field_mapping_executions','order_field_mapping_execution_rows'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);END LOOP;END $$;
GRANT UPDATE(label,enabled,version,mappings,connection_hash,approved_by,updated_at) ON order_field_mapping_profiles TO dyna_app;
GRANT UPDATE(state,result,error,finished_at) ON order_field_mapping_executions TO dyna_app;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['order_field_mapping_revisions','order_field_source_observations','order_field_mapping_previews','order_field_mapping_rows','order_field_mapping_execution_rows'] LOOP
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION order_field_immutable()',t);END LOOP;END $$;
CREATE FUNCTION order_field_mapping_profile_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.channel_id,NEW.provider,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.channel_id,OLD.provider,OLD.created_at) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Mapping profile identity/version immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER profile_scope BEFORE UPDATE ON order_field_mapping_profiles FOR EACH ROW EXECUTE FUNCTION order_field_mapping_profile_scope();
CREATE TRIGGER profile_delete BEFORE DELETE ON order_field_mapping_profiles FOR EACH ROW EXECUTE FUNCTION order_field_immutable();
CREATE FUNCTION order_field_mapping_execution_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.state<>'queued' OR NEW.state='queued' OR ROW(NEW.id,NEW.tenant_id,NEW.preview_id,NEW.kind,NEW.actor_id,NEW.client_key,NEW.request_hash,NEW.selection_hash,NEW.selected_count,NEW.consent,NEW.origin,NEW.job_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.preview_id,OLD.kind,OLD.actor_id,OLD.client_key,OLD.request_hash,OLD.selection_hash,OLD.selected_count,OLD.consent,OLD.origin,OLD.job_id,OLD.created_at) THEN RAISE EXCEPTION 'Mapping execution identity/terminal immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER execution_scope BEFORE UPDATE ON order_field_mapping_executions FOR EACH ROW EXECUTE FUNCTION order_field_mapping_execution_scope();
CREATE TRIGGER execution_delete BEFORE DELETE ON order_field_mapping_executions FOR EACH ROW EXECUTE FUNCTION order_field_immutable();
