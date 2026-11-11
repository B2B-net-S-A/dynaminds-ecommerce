CREATE TABLE customer_message_threads (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,order_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 message_count integer NOT NULL DEFAULT 0 CHECK(message_count BETWEEN 0 AND 1000),public_message_count integer NOT NULL DEFAULT 0 CHECK(public_message_count BETWEEN 0 AND message_count),
 last_message_at timestamptz NOT NULL DEFAULT now(),last_public_message_at timestamptz,status_changed_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,order_id),UNIQUE(tenant_id,order_id,id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
CREATE INDEX customer_message_inbox ON customer_message_threads(tenant_id,last_message_at DESC,id DESC);
CREATE INDEX customer_message_status_inbox ON customer_message_threads(tenant_id,status,last_message_at DESC,id DESC);
CREATE TABLE customer_messages (
 id uuid PRIMARY KEY,public_id uuid NOT NULL UNIQUE,tenant_id uuid NOT NULL,order_id uuid NOT NULL,thread_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('buyer','reply','note')),actor_id uuid REFERENCES users,
 client_key uuid NOT NULL,request_hash text NOT NULL,body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 4000),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,thread_id,client_key),FOREIGN KEY(tenant_id,order_id,thread_id) REFERENCES customer_message_threads(tenant_id,order_id,id),
 CHECK((kind='buyer')=(actor_id IS NULL)),CHECK(request_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX customer_messages_thread_page ON customer_messages(tenant_id,thread_id,created_at DESC,id DESC);
CREATE INDEX customer_messages_public_page ON customer_messages(tenant_id,thread_id,created_at DESC,public_id DESC) WHERE kind IN ('buyer','reply');
CREATE INDEX customer_messages_recent ON customer_messages(tenant_id,thread_id,kind,created_at DESC);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['customer_message_threads','customer_messages'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
END LOOP;END $$;
GRANT UPDATE ON customer_message_threads TO dyna_app;
CREATE FUNCTION customer_message_thread_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.order_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.order_id,OLD.created_at)
 OR NEW.version<>OLD.version+1 OR NEW.message_count<OLD.message_count OR NEW.public_message_count<OLD.public_message_count
 THEN RAISE EXCEPTION 'Customer message thread scope and revisions are immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER customer_message_thread_scope BEFORE UPDATE ON customer_message_threads FOR EACH ROW EXECUTE FUNCTION customer_message_thread_scope();
-- Auth tables remain private. Resolve a display name only through own membership.
CREATE FUNCTION customer_message_actor_name(p_user uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT u.name FROM public.users u JOIN public.memberships m ON m.user_id=u.id
 WHERE u.id=p_user AND m.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
$$;
REVOKE ALL ON FUNCTION customer_message_actor_name(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_message_actor_name(uuid) TO dyna_app;
CREATE INDEX customer_message_viewer_inbox ON customer_message_threads(tenant_id,(greatest(created_at,status_changed_at,coalesce(last_public_message_at,created_at))) DESC,id DESC) WHERE public_message_count>0;
CREATE INDEX customer_message_viewer_status ON customer_message_threads(tenant_id,status,(greatest(created_at,status_changed_at,coalesce(last_public_message_at,created_at))) DESC,id DESC) WHERE public_message_count>0;
CREATE FUNCTION customer_message_role(p_user uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT role FROM public.memberships WHERE user_id=p_user AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
$$;
REVOKE ALL ON FUNCTION customer_message_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_message_role(uuid) TO dyna_app;
