CREATE TABLE sms_templates (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,name text NOT NULL,body text NOT NULL,
 max_parts integer NOT NULL CHECK(max_parts BETWEEN 1 AND 10),active boolean NOT NULL DEFAULT true,version bigint NOT NULL DEFAULT 1,
 client_key uuid NOT NULL,creation_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key)
);
CREATE TABLE sms_batches (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,
 template_id uuid NOT NULL,template_version bigint NOT NULL,channel_id uuid,channel_hash text,
 mode text NOT NULL CHECK(mode IN ('local','provider_test')),client_key uuid NOT NULL,request_hash text NOT NULL,
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','queued','done','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,template_id) REFERENCES sms_templates(tenant_id,id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),
 CHECK((mode='local' AND channel_id IS NULL AND channel_hash IS NULL) OR (mode='provider_test' AND channel_id IS NOT NULL AND channel_hash IS NOT NULL))
);
CREATE TABLE sms_messages (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,batch_id uuid NOT NULL,order_id uuid NOT NULL,number text NOT NULL,
 snapshot jsonb NOT NULL,payload text,recipient text,encoding text,units integer,parts integer,max_parts integer,sender text,
 state text NOT NULL CHECK(state IN ('draft','invalid','queued','simulated','tested','uncertain','failed','cancelled')),
 job_id uuid,attempted_at timestamptz,result jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,batch_id,order_id),
 FOREIGN KEY(tenant_id,batch_id) REFERENCES sms_batches(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE INDEX sms_messages_page ON sms_messages(tenant_id,created_at DESC,id DESC);
CREATE INDEX sms_messages_batch ON sms_messages(tenant_id,batch_id,id);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['sms_templates','sms_batches','sms_messages'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dyna_app',tbl);
END LOOP; END $$;
CREATE INDEX sms_batches_queued ON sms_batches(id) WHERE state='queued';
CREATE INDEX sms_messages_job ON sms_messages(job_id) WHERE job_id IS NOT NULL;
CREATE FUNCTION sms_payload_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.batch_id,NEW.order_id,NEW.number,NEW.snapshot,NEW.payload,NEW.recipient,NEW.encoding,NEW.units,NEW.parts,NEW.max_parts,NEW.sender,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.batch_id,OLD.order_id,OLD.number,OLD.snapshot,OLD.payload,OLD.recipient,OLD.encoding,OLD.units,OLD.parts,OLD.max_parts,OLD.sender,OLD.created_at)
 THEN RAISE EXCEPTION 'Treść i odbiorca podglądu SMS są niezmienne'; END IF;
 IF OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at THEN RAISE EXCEPTION 'Nie można usunąć rozpoczętej próby SMS'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sms_payload_immutable BEFORE UPDATE ON sms_messages FOR EACH ROW EXECUTE FUNCTION sms_payload_immutable();
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check1;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check CHECK(cardinality(scopes)>=1 AND cardinality(scopes)<=14);
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check1 CHECK(scopes <@ ARRAY['orders:read','orders:write','products:read','products:write','inventory:read','inventory:write','documents:read','documents:write','purchasing:read','purchasing:write','automations:read','automations:write','communications:read','communications:write']::text[]);
