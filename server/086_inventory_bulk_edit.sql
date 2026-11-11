CREATE TABLE inventory_bulk_edit_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,warehouse_id uuid NOT NULL,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 source text NOT NULL CHECK(source IN ('manual','api')),note text NOT NULL CHECK(char_length(note) BETWEEN 3 AND 500),
 total integer NOT NULL CHECK(total BETWEEN 1 AND 500),changed integer NOT NULL CHECK(changed>=0),unchanged integer NOT NULL CHECK(unchanged>=0),invalid integer NOT NULL CHECK(invalid>=0),conflicts integer NOT NULL CHECK(conflicts>=0),ready boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),CHECK(changed+unchanged+invalid+conflicts=total),CHECK(ready=(invalid=0 AND conflicts=0))
);
CREATE INDEX inventory_bulk_edit_preview_history ON inventory_bulk_edit_previews(tenant_id,created_at DESC,id DESC);
CREATE TABLE inventory_bulk_edit_rows (
 tenant_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 499),product_id uuid NOT NULL,location text NOT NULL,sku text NOT NULL,
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),status text NOT NULL CHECK(status IN ('changed','unchanged','invalid','conflict','missing')),
 before jsonb NOT NULL CHECK(jsonb_typeof(before)='object'),after jsonb,errors jsonb NOT NULL CHECK(jsonb_typeof(errors)='array'),
 PRIMARY KEY(tenant_id,preview_id,index),UNIQUE(tenant_id,preview_id,product_id,location),UNIQUE(tenant_id,preview_id,index,product_id,location),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES inventory_bulk_edit_previews(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 CHECK(status NOT IN ('changed','unchanged') OR (after IS NOT NULL AND jsonb_typeof(after)='object'))
);
CREATE TABLE inventory_bulk_edit_executions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),state text NOT NULL DEFAULT 'done' CHECK(state='done'),
 total integer NOT NULL CHECK(total BETWEEN 1 AND 500),changed integer NOT NULL CHECK(changed>=0),unchanged integer NOT NULL CHECK(unchanged>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,preview_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,preview_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES inventory_bulk_edit_previews(tenant_id,id),CHECK(changed+unchanged=total)
);
CREATE INDEX inventory_bulk_edit_execution_history ON inventory_bulk_edit_executions(tenant_id,created_at DESC,id DESC);
CREATE TABLE inventory_bulk_edit_execution_rows (
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 499),product_id uuid NOT NULL,location text NOT NULL,sku text NOT NULL,
 operation text NOT NULL CHECK(operation IN ('none','count','move')),status text NOT NULL CHECK(status IN ('changed','unchanged')),
 before jsonb NOT NULL CHECK(jsonb_typeof(before)='object'),after jsonb NOT NULL CHECK(jsonb_typeof(after)='object'),before_stock_version bigint CHECK(before_stock_version>=0),after_stock_version bigint CHECK(after_stock_version>=0),operation_ids uuid[] NOT NULL,
 PRIMARY KEY(tenant_id,execution_id,index),FOREIGN KEY(tenant_id,execution_id,preview_id) REFERENCES inventory_bulk_edit_executions(tenant_id,id,preview_id),
 FOREIGN KEY(tenant_id,preview_id,index,product_id,location) REFERENCES inventory_bulk_edit_rows(tenant_id,preview_id,index,product_id,location),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 CHECK((status='unchanged' AND cardinality(operation_ids)=0) OR (status='changed' AND cardinality(operation_ids)=1 AND after_stock_version IS NOT NULL))
);
CREATE FUNCTION inventory_bulk_edit_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'Inventory bulk evidence is immutable';END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['inventory_bulk_edit_previews','inventory_bulk_edit_rows','inventory_bulk_edit_executions','inventory_bulk_edit_execution_rows'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION inventory_bulk_edit_immutable()',t);
 END LOOP;END $$;
CREATE FUNCTION inventory_bulk_edit_key_grant(p_user uuid,p_key uuid) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE k record;BEGIN
 SELECT revoked_at,expires_at,scopes INTO k FROM public.api_keys WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user AND id=p_key FOR SHARE;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR k.expires_at<=clock_timestamp() THEN RETURN 'invalid';END IF;
 IF NOT k.scopes @> ARRAY['products:read','inventory:read','inventory:write']::text[] THEN RETURN 'insufficient';END IF;RETURN 'ok';END $$;
REVOKE ALL ON FUNCTION inventory_bulk_edit_key_grant(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_bulk_edit_key_grant(uuid,uuid) TO dyna_app;
CREATE FUNCTION inventory_bulk_edit_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE p record;BEGIN
 SELECT * INTO p FROM inventory_bulk_edit_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
 IF TG_TABLE_NAME='inventory_bulk_edit_rows' THEN
 IF p.id IS NULL OR NEW.index>=p.total THEN RAISE EXCEPTION 'Inventory row outside frozen scope';END IF;
 ELSE
 IF p.id IS NULL OR NOT p.ready OR ROW(NEW.actor_id,NEW.scope_hash,NEW.total,NEW.changed,NEW.unchanged) IS DISTINCT FROM ROW(p.actor_id,p.scope_hash,p.total,p.changed,p.unchanged) THEN RAISE EXCEPTION 'Inventory execution differs from frozen scope';END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER inventory_bulk_edit_row_scope BEFORE INSERT ON inventory_bulk_edit_rows FOR EACH ROW EXECUTE FUNCTION inventory_bulk_edit_scope();
CREATE TRIGGER inventory_bulk_edit_execution_scope BEFORE INSERT ON inventory_bulk_edit_executions FOR EACH ROW EXECUTE FUNCTION inventory_bulk_edit_scope();
