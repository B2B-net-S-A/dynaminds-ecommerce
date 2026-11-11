CREATE TABLE email_templates (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,name text NOT NULL,subject text NOT NULL,body text NOT NULL,html text NOT NULL DEFAULT '',
 active boolean NOT NULL DEFAULT true,version bigint NOT NULL DEFAULT 1,client_key uuid NOT NULL,creation_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key)
);
CREATE TABLE email_batches (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,
 template_id uuid NOT NULL,template_version bigint NOT NULL,channel_id uuid,channel_hash text,
 mode text NOT NULL CHECK(mode IN ('local','smtp')),client_key uuid NOT NULL,request_hash text NOT NULL,
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','queued','done','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,template_id) REFERENCES email_templates(tenant_id,id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),
 CHECK((mode='local' AND channel_id IS NULL AND channel_hash IS NULL) OR (mode='smtp' AND channel_id IS NOT NULL AND channel_hash IS NOT NULL))
);
CREATE TABLE email_messages (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,batch_id uuid NOT NULL,order_id uuid NOT NULL,number text NOT NULL,
 snapshot jsonb NOT NULL,payload jsonb,sender jsonb,
 state text NOT NULL CHECK(state IN ('draft','invalid','queued','simulated','smtp_accepted','uncertain','failed','cancelled')),
 job_id uuid,attempted_at timestamptz,result jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,batch_id,order_id),
 FOREIGN KEY(tenant_id,batch_id) REFERENCES email_batches(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE INDEX email_messages_page ON email_messages(tenant_id,created_at DESC,id DESC);
CREATE INDEX email_messages_batch ON email_messages(tenant_id,batch_id,id);
CREATE INDEX email_messages_job ON email_messages(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX email_batches_queued ON email_batches(id) WHERE state='queued';
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['email_templates','email_batches','email_messages'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dyna_app',tbl);
END LOOP; END $$;
CREATE FUNCTION email_payload_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.batch_id,NEW.order_id,NEW.number,NEW.snapshot,NEW.payload,NEW.sender,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.batch_id,OLD.order_id,OLD.number,OLD.snapshot,OLD.payload,OLD.sender,OLD.created_at)
 THEN RAISE EXCEPTION 'Treść i odbiorca podglądu email są niezmienne'; END IF;
 IF OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at THEN RAISE EXCEPTION 'Nie można usunąć rozpoczętej próby email'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER email_payload_immutable BEFORE UPDATE ON email_messages FOR EACH ROW EXECUTE FUNCTION email_payload_immutable();
