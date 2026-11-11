-- First independent CRM identities. Historical orders remain immutable buyer snapshots.
CREATE TABLE crm_status_groups(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants,
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 15),is_main_group boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),UNIQUE(tenant_id,id));
CREATE UNIQUE INDEX crm_one_main_group ON crm_status_groups(tenant_id) WHERE is_main_group;
CREATE TABLE crm_statuses(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants,group_id uuid NOT NULL,
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 30),color text NOT NULL CHECK(color~'^#[0-9A-Fa-f]{6}$'),
 is_primary boolean NOT NULL DEFAULT false,position bigint NOT NULL CHECK(position>=0),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,group_id) REFERENCES crm_status_groups(tenant_id,id));
CREATE UNIQUE INDEX crm_one_primary_status ON crm_statuses(tenant_id) WHERE is_primary;
CREATE INDEX crm_status_group_order ON crm_statuses(tenant_id,group_id,position,id);
CREATE TABLE crm_clients(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants,status_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object' AND octet_length(profile::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),deleted_at timestamptz,
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,status_id) REFERENCES crm_statuses(tenant_id,id));
CREATE INDEX crm_client_page ON crm_clients(tenant_id,created_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX crm_client_status ON crm_clients(tenant_id,status_id,id);
CREATE TABLE crm_extra_fields(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants,name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 120),
 editor_type text NOT NULL CHECK(editor_type IN('text','number','select','checkbox','radio','date','file')),
 options jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(options)='array'),position integer NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,editor_type));
CREATE TABLE crm_files(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,client_id uuid NOT NULL,field_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 40),
 mime_type text NOT NULL CHECK(mime_type IN('application/pdf','image/png','image/jpeg','application/octet-stream')),
 byte_count integer NOT NULL CHECK(byte_count BETWEEN 1 AND 2000000),content_sha256 text NOT NULL CHECK(content_sha256~'^[a-f0-9]{64}$'),
 encrypted_bytes text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_id,field_id,id),
 FOREIGN KEY(tenant_id,client_id) REFERENCES crm_clients(tenant_id,id),FOREIGN KEY(tenant_id,field_id) REFERENCES crm_extra_fields(tenant_id,id));
CREATE TABLE crm_values(
 tenant_id uuid NOT NULL,client_id uuid NOT NULL,field_id uuid NOT NULL,editor_type text NOT NULL,value jsonb NOT NULL,file_id uuid,
 PRIMARY KEY(tenant_id,client_id,field_id),FOREIGN KEY(tenant_id,client_id) REFERENCES crm_clients(tenant_id,id),
 FOREIGN KEY(tenant_id,field_id,editor_type) REFERENCES crm_extra_fields(tenant_id,id,editor_type),
 FOREIGN KEY(tenant_id,client_id,field_id,file_id) REFERENCES crm_files(tenant_id,client_id,field_id,id),
 CHECK((editor_type='file')=(file_id IS NOT NULL)),CHECK(
 (editor_type='text' AND jsonb_typeof(value)='string') OR (editor_type='number' AND jsonb_typeof(value)='number') OR
 (editor_type IN('select','radio','date') AND jsonb_typeof(value)='string') OR (editor_type='checkbox' AND jsonb_typeof(value)='array') OR
 (editor_type='file' AND jsonb_typeof(value)='object')));
CREATE TABLE crm_order_links(
 tenant_id uuid NOT NULL,client_id uuid NOT NULL,order_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,client_id,order_id),UNIQUE(tenant_id,order_id),
 FOREIGN KEY(tenant_id,client_id) REFERENCES crm_clients(tenant_id,id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id));
CREATE TABLE crm_commands(
 tenant_id uuid NOT NULL REFERENCES tenants,client_key uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),request jsonb NOT NULL CHECK(jsonb_typeof(request)='object' AND octet_length(request::text)<=3000000),
 response jsonb NOT NULL CHECK(jsonb_typeof(response)='object' AND octet_length(response::text)<=131072),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,client_key));
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['crm_status_groups','crm_statuses','crm_clients','crm_extra_fields','crm_files','crm_values','crm_order_links','crm_commands'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);EXECUTE format('GRANT SELECT ON %I TO dyna_app',t);
 END LOOP;END$$;
GRANT INSERT,DELETE ON crm_status_groups,crm_statuses TO dyna_app;
GRANT UPDATE(name,version) ON crm_status_groups TO dyna_app;
GRANT UPDATE(group_id,name,color,position,version) ON crm_statuses TO dyna_app;
GRANT INSERT,UPDATE ON crm_clients TO dyna_app;
REVOKE UPDATE,DELETE,TRUNCATE ON crm_files,crm_order_links,crm_commands FROM dyna_app;
GRANT INSERT ON crm_files,crm_order_links,crm_commands TO dyna_app;
GRANT INSERT,UPDATE,DELETE ON crm_values TO dyna_app;
CREATE FUNCTION crm215_protected() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$BEGIN
 IF (to_jsonb(OLD)->>'is_main_group')::boolean IS TRUE OR (to_jsonb(OLD)->>'is_primary')::boolean IS TRUE
 THEN RAISE EXCEPTION 'Main CRM dictionary entry is protected';END IF;RETURN OLD;END$$;
CREATE TRIGGER crm_main_group BEFORE DELETE ON crm_status_groups FOR EACH ROW EXECUTE FUNCTION crm215_protected();
CREATE TRIGGER crm_primary_status BEFORE DELETE ON crm_statuses FOR EACH ROW EXECUTE FUNCTION crm215_protected();
CREATE FUNCTION crm215_seed(p_tenant uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE g uuid;BEGIN
 INSERT INTO public.crm_status_groups(tenant_id,name,is_main_group) VALUES(p_tenant,'Główna',true) RETURNING id INTO g;
 INSERT INTO public.crm_statuses(tenant_id,group_id,name,color,is_primary,position) VALUES(p_tenant,g,'Nowy','#64748b',true,0);
 INSERT INTO public.crm_extra_fields(tenant_id,name,editor_type,options,position) VALUES
 (p_tenant,'Tekst','text','[]',0),(p_tenant,'Liczba','number','[]',1),
 (p_tenant,'Kategoria','select','["Standard","Premium"]',2),(p_tenant,'Zgody','checkbox','["E-mail","Telefon"]',3),
 (p_tenant,'Kontakt','radio','["E-mail","Telefon"]',4),(p_tenant,'Data','date','[]',5),(p_tenant,'Załącznik','file','[]',6);
END$$;
REVOKE ALL ON FUNCTION crm215_seed(uuid) FROM PUBLIC;
DO $$DECLARE t uuid;BEGIN FOR t IN SELECT id FROM tenants LOOP PERFORM crm215_seed(t);END LOOP;END$$;
