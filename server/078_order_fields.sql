CREATE TABLE order_field_definitions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,key text NOT NULL CHECK(key ~ '^[a-z][a-z0-9_]{0,63}$'),
 type text NOT NULL CHECK(type IN ('text','number','select','radio','multi_select','date','file')),label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 120),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),enabled boolean NOT NULL DEFAULT true,display text NOT NULL CHECK(display IN ('always','edit_only')),position integer NOT NULL CHECK(position BETWEEN 0 AND 10000),
 read_role text NOT NULL CHECK(read_role IN ('team','admin')),write_role text NOT NULL CHECK(write_role IN ('operator','admin')),required_on text[] NOT NULL DEFAULT '{}',config jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,type),UNIQUE(tenant_id,key),
 CHECK(read_role<>'admin' OR write_role='admin'),CHECK(required_on <@ ARRAY['manual_create','pack_complete']::text[])
);
CREATE TABLE order_field_definition_revisions (
 tenant_id uuid NOT NULL,field_id uuid NOT NULL,version integer NOT NULL,snapshot jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,field_id,version),FOREIGN KEY(tenant_id,field_id) REFERENCES order_field_definitions(tenant_id,id)
);
CREATE TABLE order_field_options (
 tenant_id uuid NOT NULL,field_id uuid NOT NULL,id uuid NOT NULL,label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 120),enabled boolean NOT NULL,
 PRIMARY KEY(tenant_id,field_id,id),FOREIGN KEY(tenant_id,field_id) REFERENCES order_field_definitions(tenant_id,id)
);
CREATE TABLE order_field_files (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,field_id uuid NOT NULL,definition_version integer NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),filename text NOT NULL,mime_type text NOT NULL CHECK(mime_type IN ('application/pdf','image/jpeg','image/png')),
 byte_count integer NOT NULL CHECK(byte_count BETWEEN 1 AND 5242880),file_hash text NOT NULL CHECK(file_hash ~ '^[a-f0-9]{64}$'),encrypted_bytes text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,order_id,field_id,id),UNIQUE(tenant_id,actor_id,client_key),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,field_id,definition_version) REFERENCES order_field_definition_revisions(tenant_id,field_id,version)
);
CREATE TABLE order_field_values (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,field_id uuid NOT NULL,type text NOT NULL,definition_version integer NOT NULL,payload jsonb NOT NULL,
 text_value text,number_value numeric CHECK(abs(number_value)<1000000000000000000 AND scale(number_value)<=6),date_value date,option_values uuid[],file_id uuid,source text NOT NULL CHECK(source IN ('manual','api','channel_import','csv_import','automation','copy')),
 provenance jsonb NOT NULL DEFAULT '{}',updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,order_id,field_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,field_id,type) REFERENCES order_field_definitions(tenant_id,id,type),
 FOREIGN KEY(tenant_id,field_id,definition_version) REFERENCES order_field_definition_revisions(tenant_id,field_id,version),
 FOREIGN KEY(tenant_id,order_id,field_id,file_id) REFERENCES order_field_files(tenant_id,order_id,field_id,id),
 CHECK(jsonb_typeof(payload)='object'),CHECK((type='text')=(text_value IS NOT NULL)),CHECK((type='number')=(number_value IS NOT NULL)),
 CHECK((type='date')=(date_value IS NOT NULL)),CHECK((type IN ('select','radio','multi_select'))=(option_values IS NOT NULL)),CHECK((type='file')=(file_id IS NOT NULL))
);
CREATE INDEX order_field_values_field ON order_field_values(tenant_id,field_id,order_id);
CREATE INDEX order_field_values_number ON order_field_values(tenant_id,field_id,number_value,order_id) WHERE type='number';
CREATE INDEX order_field_values_date ON order_field_values(tenant_id,field_id,date_value,order_id) WHERE type='date';
CREATE INDEX order_field_values_prefix ON order_field_values(tenant_id,field_id,text_value text_pattern_ops) WHERE type='text';
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX order_field_values_contains ON order_field_values USING gin(text_value gin_trgm_ops) WHERE type='text';
CREATE INDEX order_field_values_options ON order_field_values USING gin(option_values) WHERE type IN ('select','radio','multi_select');
CREATE TABLE order_field_value_events (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,field_id uuid NOT NULL,definition_version integer NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 definition_snapshot jsonb NOT NULL,before_payload jsonb,after_payload jsonb,source text NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,field_id,definition_version) REFERENCES order_field_definition_revisions(tenant_id,field_id,version)
);
CREATE INDEX order_field_events_page ON order_field_value_events(tenant_id,order_id,created_at DESC,id DESC);
CREATE TABLE order_field_requests (
 tenant_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,kind text NOT NULL CHECK(kind IN ('definition','values')),client_key uuid NOT NULL,order_id uuid,field_id uuid,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,actor_id,kind,client_key),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,field_id) REFERENCES order_field_definitions(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['order_field_definitions','order_field_definition_revisions','order_field_options','order_field_files','order_field_values','order_field_value_events','order_field_requests'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
 END LOOP;END $$;
GRANT UPDATE ON order_field_definitions,order_field_options,order_field_values TO dyna_app;
GRANT DELETE ON order_field_values TO dyna_app;
CREATE FUNCTION order_field_role(p_user uuid) RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT role FROM public.memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user FOR SHARE
$$;
REVOKE ALL ON FUNCTION order_field_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION order_field_role(uuid) TO dyna_app;
CREATE FUNCTION order_field_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Order field evidence is append-only';END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['order_field_definition_revisions','order_field_files','order_field_value_events','order_field_requests'] LOOP
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION order_field_immutable()',t);END LOOP;END $$;
CREATE FUNCTION order_field_definition_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.tenant_id,NEW.id,NEW.key,NEW.type,NEW.created_at) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.id,OLD.key,OLD.type,OLD.created_at) OR NEW.version<>OLD.version+1
 THEN RAISE EXCEPTION 'Order field definition scope is immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER definition_scope BEFORE UPDATE ON order_field_definitions FOR EACH ROW EXECUTE FUNCTION order_field_definition_scope();
CREATE FUNCTION order_field_option_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.tenant_id,NEW.field_id,NEW.id,NEW.label) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.field_id,OLD.id,OLD.label) THEN RAISE EXCEPTION 'Order field option identity/label is immutable; retire and create a new option';END IF;RETURN NEW;END $$;
CREATE TRIGGER option_scope BEFORE UPDATE ON order_field_options FOR EACH ROW EXECUTE FUNCTION order_field_option_scope();
CREATE FUNCTION order_field_value_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.tenant_id,NEW.order_id,NEW.field_id,NEW.type) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.order_id,OLD.field_id,OLD.type) THEN RAISE EXCEPTION 'Order field value scope is immutable';END IF;
 IF NEW.option_values IS NOT NULL AND (cardinality(NEW.option_values)>50 OR (NEW.type IN ('select','radio') AND cardinality(NEW.option_values)<>1) OR cardinality(NEW.option_values)<>(SELECT count(DISTINCT id) FROM unnest(NEW.option_values) id)
 OR EXISTS(SELECT 1 FROM unnest(NEW.option_values) AS selected(option_id) WHERE NOT EXISTS(SELECT 1 FROM public.order_field_options o WHERE (o.tenant_id,o.field_id,o.id)=(NEW.tenant_id,NEW.field_id,selected.option_id)))) THEN RAISE EXCEPTION 'Options must belong to this tenant and field';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER value_scope BEFORE INSERT OR UPDATE ON order_field_values FOR EACH ROW EXECUTE FUNCTION order_field_value_scope();
CREATE FUNCTION order_field_file_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.order_field_definitions d WHERE (d.tenant_id,d.id,d.type)=(NEW.tenant_id,NEW.field_id,'file')) THEN RAISE EXCEPTION 'Attachment must belong to a file field';END IF;RETURN NEW;END $$;
CREATE TRIGGER file_scope BEFORE INSERT ON order_field_files FOR EACH ROW EXECUTE FUNCTION order_field_file_scope();
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check1;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check CHECK(cardinality(scopes) BETWEEN 1 AND 17);
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check1 CHECK(scopes <@ ARRAY['orders:read','orders:write','products:read','products:write','inventory:read','inventory:write','documents:read','documents:write','purchasing:read','purchasing:write','automations:read','automations:write','communications:read','communications:write','order-fields:read','order-fields:write','order-fields:admin']::text[]);
