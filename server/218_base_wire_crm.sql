-- Numeric public identities are sidecars of the existing CRM, never a second
-- customer store. Deleted dictionaries retain their numeric identity tombstone.
CREATE TABLE base_wire218_client_ids (
 tenant_id uuid NOT NULL,resource_id uuid NOT NULL,local_id uuid,
 public_id bigint GENERATED ALWAYS AS IDENTITY (MAXVALUE 9007199254740991),
 PRIMARY KEY(tenant_id,resource_id),UNIQUE(public_id),UNIQUE(tenant_id,public_id),
 CHECK(public_id>0),CHECK(local_id IS NULL OR local_id=resource_id),
 FOREIGN KEY(tenant_id,local_id) REFERENCES crm_clients(tenant_id,id) ON DELETE SET NULL(local_id)
);
CREATE TABLE base_wire218_status_ids (
 tenant_id uuid NOT NULL,resource_id uuid NOT NULL,local_id uuid,
 public_id bigint GENERATED ALWAYS AS IDENTITY (MAXVALUE 9007199254740991),
 PRIMARY KEY(tenant_id,resource_id),UNIQUE(public_id),UNIQUE(tenant_id,public_id),
 CHECK(public_id>0),CHECK(local_id IS NULL OR local_id=resource_id),
 FOREIGN KEY(tenant_id,local_id) REFERENCES crm_statuses(tenant_id,id) ON DELETE SET NULL(local_id)
);
CREATE TABLE base_wire218_field_ids (
 tenant_id uuid NOT NULL,resource_id uuid NOT NULL,local_id uuid,
 public_id bigint GENERATED ALWAYS AS IDENTITY (MAXVALUE 9007199254740991),
 PRIMARY KEY(tenant_id,resource_id),UNIQUE(public_id),UNIQUE(tenant_id,public_id),
 CHECK(public_id>0),CHECK(local_id IS NULL OR local_id=resource_id),
 FOREIGN KEY(tenant_id,local_id) REFERENCES crm_extra_fields(tenant_id,id) ON DELETE SET NULL(local_id)
);
INSERT INTO base_wire218_client_ids(tenant_id,resource_id,local_id) SELECT tenant_id,id,id FROM crm_clients ORDER BY tenant_id,created_at,id;
INSERT INTO base_wire218_status_ids(tenant_id,resource_id,local_id) SELECT tenant_id,id,id FROM crm_statuses ORDER BY tenant_id,id;
INSERT INTO base_wire218_field_ids(tenant_id,resource_id,local_id) SELECT tenant_id,id,id FROM crm_extra_fields ORDER BY tenant_id,id;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['base_wire218_client_ids','base_wire218_status_ids','base_wire218_field_ids'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',t);
 EXECUTE format('GRANT SELECT ON %I TO dyna_app',t);
END LOOP;END$$;
CREATE FUNCTION base_wire218_allocate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_TABLE_SCHEMA<>'public' THEN RAISE EXCEPTION 'Invalid CRM identity source';END IF;
 IF TG_TABLE_NAME='crm_clients' THEN INSERT INTO public.base_wire218_client_ids(tenant_id,resource_id,local_id) VALUES(NEW.tenant_id,NEW.id,NEW.id);
 ELSIF TG_TABLE_NAME='crm_statuses' THEN INSERT INTO public.base_wire218_status_ids(tenant_id,resource_id,local_id) VALUES(NEW.tenant_id,NEW.id,NEW.id);
 ELSIF TG_TABLE_NAME='crm_extra_fields' THEN INSERT INTO public.base_wire218_field_ids(tenant_id,resource_id,local_id) VALUES(NEW.tenant_id,NEW.id,NEW.id);
 ELSE RAISE EXCEPTION 'Invalid CRM identity source';END IF;RETURN NEW;
END$$;
REVOKE ALL ON FUNCTION base_wire218_allocate() FROM PUBLIC,dyna_app;
CREATE TRIGGER base_wire218_client AFTER INSERT ON crm_clients FOR EACH ROW EXECUTE FUNCTION base_wire218_allocate();
CREATE TRIGGER base_wire218_status AFTER INSERT ON crm_statuses FOR EACH ROW EXECUTE FUNCTION base_wire218_allocate();
CREATE TRIGGER base_wire218_field AFTER INSERT ON crm_extra_fields FOR EACH ROW EXECUTE FUNCTION base_wire218_allocate();
-- CRM key capabilities live beside api_keys. The api_keys definition (and its
-- scope CHECK pinned by earlier validators) stays untouched; no FK, because an
-- FK would add RI triggers to api_keys. Authority always joins the live key row.
CREATE TABLE base_wire218_key_scopes (
 tenant_id uuid NOT NULL,key_id uuid NOT NULL,
 scope text NOT NULL CHECK(scope IN('crm:read','crm:write')),
 PRIMARY KEY(tenant_id,key_id,scope)
);
ALTER TABLE base_wire218_key_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE base_wire218_key_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON base_wire218_key_scopes TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON base_wire218_key_scopes FROM PUBLIC,dyna_app;
GRANT SELECT ON base_wire218_key_scopes TO dyna_app;
CREATE FUNCTION base_wire218_authority(uid uuid,kid uuid,writing boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r text;k public.api_keys;required boolean;enabled timestamptz;
BEGIN
 IF writing THEN PERFORM 1 FROM public.tenants WHERE id=t FOR SHARE;END IF;
 IF writing THEN SELECT role INTO r FROM public.memberships WHERE tenant_id=t AND user_id=uid FOR SHARE;
 ELSE SELECT role INTO r FROM public.memberships WHERE tenant_id=t AND user_id=uid;END IF;
 IF r IS NULL OR r NOT IN('admin','operator','viewer') OR (writing AND r<>'admin') THEN RETURN NULL;END IF;
 IF writing THEN SELECT * INTO k FROM public.api_keys WHERE tenant_id=t AND id=kid AND user_id=uid FOR SHARE;
 ELSE SELECT * INTO k FROM public.api_keys WHERE tenant_id=t AND id=kid AND user_id=uid;END IF;
 IF k.id IS NULL OR k.revoked_at IS NOT NULL OR k.expires_at<=clock_timestamp()
 OR NOT EXISTS(SELECT 1 FROM public.base_wire218_key_scopes s WHERE s.tenant_id=t AND s.key_id=kid AND s.scope='crm:read')
 OR (writing AND NOT EXISTS(SELECT 1 FROM public.base_wire218_key_scopes s WHERE s.tenant_id=t AND s.key_id=kid AND s.scope='crm:write')) THEN RETURN NULL;END IF;
 IF writing THEN
  SELECT require_mfa INTO required FROM public.workspace_security_policies WHERE tenant_id=t FOR SHARE;
  SELECT enabled_at INTO enabled FROM public.account_security WHERE user_id=uid FOR SHARE;
 ELSE
  SELECT require_mfa INTO required FROM public.workspace_security_policies WHERE tenant_id=t;
  SELECT enabled_at INTO enabled FROM public.account_security WHERE user_id=uid;
 END IF;
 IF required IS TRUE AND enabled IS NULL THEN RETURN NULL;END IF;
 RETURN r;
END$$;
REVOKE ALL ON FUNCTION base_wire218_authority(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION base_wire218_authority(uuid,uuid,boolean) TO dyna_app;
