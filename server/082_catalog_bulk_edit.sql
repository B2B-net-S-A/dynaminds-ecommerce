CREATE TABLE catalog_bulk_edit_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),source text NOT NULL CHECK(source IN ('manual','api')),
 rules_snapshot jsonb NOT NULL CHECK(jsonb_typeof(rules_snapshot)='array' AND jsonb_array_length(rules_snapshot)<=100),
 total integer NOT NULL CHECK(total BETWEEN 1 AND 500),changed integer NOT NULL CHECK(changed>=0),
 unchanged integer NOT NULL CHECK(unchanged>=0),invalid integer NOT NULL CHECK(invalid>=0),
 conflicts integer NOT NULL CHECK(conflicts>=0),ready boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),CHECK(changed+unchanged+invalid+conflicts=total),
 CHECK(ready=(invalid=0 AND conflicts=0))
);
CREATE INDEX catalog_bulk_edit_preview_history ON catalog_bulk_edit_previews(tenant_id,created_at DESC,id DESC);
CREATE TABLE catalog_bulk_edit_rows (
 tenant_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 499),
 product_id uuid NOT NULL,resolved_product_id uuid,sku text,expected_version integer NOT NULL CHECK(expected_version>0),
 current_version integer CHECK(current_version>0),status text NOT NULL CHECK(status IN ('changed','unchanged','invalid','conflict','missing')),
 changes jsonb NOT NULL CHECK(jsonb_typeof(changes)='object'),before jsonb,after jsonb,
 changed_fields jsonb NOT NULL CHECK(jsonb_typeof(changed_fields)='array' AND jsonb_array_length(changed_fields)<=9),
 errors jsonb NOT NULL CHECK(jsonb_typeof(errors)='array'),
 PRIMARY KEY(tenant_id,preview_id,index),UNIQUE(tenant_id,preview_id,index,product_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES catalog_bulk_edit_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,resolved_product_id) REFERENCES products(tenant_id,id),
 CHECK(resolved_product_id IS NULL OR resolved_product_id=product_id),
 CHECK((status='missing' AND resolved_product_id IS NULL AND current_version IS NULL AND before IS NULL AND after IS NULL AND sku IS NULL)
 OR (status<>'missing' AND resolved_product_id IS NOT NULL AND current_version IS NOT NULL AND before IS NOT NULL AND jsonb_typeof(before)='object')),
 CHECK(status NOT IN ('changed','unchanged') OR (after IS NOT NULL AND jsonb_typeof(after)='object' AND current_version=expected_version))
);
CREATE TABLE catalog_bulk_edit_executions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),state text NOT NULL DEFAULT 'done' CHECK(state='done'),
 total integer NOT NULL CHECK(total BETWEEN 1 AND 500),changed integer NOT NULL CHECK(changed>=0),unchanged integer NOT NULL CHECK(unchanged>=0),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,preview_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,preview_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES catalog_bulk_edit_previews(tenant_id,id),CHECK(changed+unchanged=total)
);
CREATE INDEX catalog_bulk_edit_execution_history ON catalog_bulk_edit_executions(tenant_id,created_at DESC,id DESC);
CREATE TABLE catalog_bulk_edit_execution_rows (
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 499),
 product_id uuid NOT NULL,sku text NOT NULL,status text NOT NULL CHECK(status IN ('changed','unchanged')),
 before_version integer NOT NULL CHECK(before_version>0),after_version integer NOT NULL CHECK(after_version>0),
 changed_fields jsonb NOT NULL CHECK(jsonb_typeof(changed_fields)='array' AND jsonb_array_length(changed_fields)<=9),
 PRIMARY KEY(tenant_id,execution_id,index),
 FOREIGN KEY(tenant_id,execution_id,preview_id) REFERENCES catalog_bulk_edit_executions(tenant_id,id,preview_id),
 FOREIGN KEY(tenant_id,preview_id,index,product_id) REFERENCES catalog_bulk_edit_rows(tenant_id,preview_id,index,product_id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 CHECK((status='changed' AND after_version=before_version+1) OR (status='unchanged' AND after_version=before_version))
);
CREATE FUNCTION catalog_bulk_edit_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'Catalog bulk edit evidence is immutable';END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['catalog_bulk_edit_previews','catalog_bulk_edit_rows','catalog_bulk_edit_executions','catalog_bulk_edit_execution_rows'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION catalog_bulk_edit_immutable()',t);
END LOOP;END $$;
CREATE FUNCTION catalog_bulk_edit_current_role(p_user uuid) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE r text;BEGIN
 SELECT role INTO r FROM public.memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user FOR SHARE;
 RETURN r;END $$;
REVOKE ALL ON FUNCTION catalog_bulk_edit_current_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog_bulk_edit_current_role(uuid) TO dyna_app;
CREATE FUNCTION catalog_bulk_edit_row_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE n integer;BEGIN
 SELECT total INTO n FROM public.catalog_bulk_edit_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
 IF n IS NULL OR NEW.index>=n THEN RAISE EXCEPTION 'Catalog preview row outside frozen scope';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER catalog_bulk_edit_row_scope BEFORE INSERT ON catalog_bulk_edit_rows FOR EACH ROW EXECUTE FUNCTION catalog_bulk_edit_row_scope();

-- Rechecked only after the actor membership lock; role withdrawal uses member -> key.
CREATE FUNCTION catalog_bulk_edit_key_grant(p_user uuid,p_key uuid) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE k record;BEGIN
 SELECT revoked_at,expires_at,scopes INTO k FROM public.api_keys
 WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user AND id=p_key FOR SHARE;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR k.expires_at<=clock_timestamp() THEN RETURN 'invalid';END IF;
 IF NOT k.scopes @> ARRAY['products:read','products:write']::text[] THEN RETURN 'insufficient';END IF;
 RETURN 'ok';END $$;
REVOKE ALL ON FUNCTION catalog_bulk_edit_key_grant(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog_bulk_edit_key_grant(uuid,uuid) TO dyna_app;
CREATE FUNCTION catalog_bulk_edit_execution_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE p record;BEGIN
 SELECT actor_id,scope_hash,total,changed,unchanged,ready INTO p FROM public.catalog_bulk_edit_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
 IF NOT FOUND OR NOT p.ready OR ROW(NEW.actor_id,NEW.scope_hash,NEW.total,NEW.changed,NEW.unchanged) IS DISTINCT FROM ROW(p.actor_id,p.scope_hash,p.total,p.changed,p.unchanged)
 THEN RAISE EXCEPTION 'Catalog execution must match the ready frozen preview';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER catalog_bulk_edit_execution_scope BEFORE INSERT ON catalog_bulk_edit_executions FOR EACH ROW EXECUTE FUNCTION catalog_bulk_edit_execution_scope();
