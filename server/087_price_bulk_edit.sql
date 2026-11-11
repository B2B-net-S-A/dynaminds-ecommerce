CREATE TABLE price_bulk_edit_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,price_list_id uuid NOT NULL,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),source text NOT NULL CHECK(source IN ('manual','api')),
 list_snapshot jsonb NOT NULL CHECK(jsonb_typeof(list_snapshot)='object'),repricing_snapshot jsonb NOT NULL CHECK(jsonb_typeof(repricing_snapshot)='object'),warnings jsonb NOT NULL CHECK(jsonb_typeof(warnings)='array'),
 total integer NOT NULL CHECK(total BETWEEN 1 AND 500),changed integer NOT NULL CHECK(changed>=0),unchanged integer NOT NULL CHECK(unchanged>=0),invalid integer NOT NULL CHECK(invalid>=0),conflicts integer NOT NULL CHECK(conflicts>=0),missing_after_count integer NOT NULL CHECK(missing_after_count BETWEEN 0 AND total),ready boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,price_list_id) REFERENCES price_lists(tenant_id,id),CHECK(changed+unchanged+invalid+conflicts=total),CHECK(ready=(invalid=0 AND conflicts=0))
);
CREATE INDEX price_bulk_edit_preview_history ON price_bulk_edit_previews(tenant_id,created_at DESC,id DESC);
CREATE TABLE price_bulk_edit_rows (
 tenant_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 499),product_id uuid NOT NULL,sku text NOT NULL,name text NOT NULL,kind text NOT NULL,product_version integer NOT NULL CHECK(product_version>0),
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),status text NOT NULL CHECK(status IN ('changed','unchanged','invalid','conflict')),
 before jsonb NOT NULL CHECK(jsonb_typeof(before)='object'),after jsonb,errors jsonb NOT NULL CHECK(jsonb_typeof(errors)='array'),
 PRIMARY KEY(tenant_id,preview_id,index),UNIQUE(tenant_id,preview_id,product_id),UNIQUE(tenant_id,preview_id,index,product_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES price_bulk_edit_previews(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),CHECK(status NOT IN ('changed','unchanged') OR (after IS NOT NULL AND jsonb_typeof(after)='object'))
);
CREATE TABLE price_bulk_edit_executions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,price_list_id uuid NOT NULL,client_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),state text NOT NULL DEFAULT 'done' CHECK(state='done'),
 list_snapshot jsonb NOT NULL CHECK(jsonb_typeof(list_snapshot)='object'),repricing_snapshot jsonb NOT NULL CHECK(jsonb_typeof(repricing_snapshot)='object'),warnings jsonb NOT NULL CHECK(jsonb_typeof(warnings)='array'),
 total integer NOT NULL CHECK(total BETWEEN 1 AND 500),changed integer NOT NULL CHECK(changed>=0),unchanged integer NOT NULL CHECK(unchanged>=0),missing_after_count integer NOT NULL CHECK(missing_after_count BETWEEN 0 AND total),ack_missing_prices boolean NOT NULL,
 before_list_version integer NOT NULL CHECK(before_list_version>0),after_list_version integer NOT NULL CHECK(after_list_version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,preview_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,preview_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES price_bulk_edit_previews(tenant_id,id),FOREIGN KEY(tenant_id,price_list_id) REFERENCES price_lists(tenant_id,id),
 CHECK(changed+unchanged=total),CHECK(missing_after_count=0 OR ack_missing_prices),CHECK(after_list_version=before_list_version+CASE WHEN changed>0 THEN 1 ELSE 0 END)
);
CREATE INDEX price_bulk_edit_execution_history ON price_bulk_edit_executions(tenant_id,created_at DESC,id DESC);
CREATE TABLE price_bulk_edit_execution_rows (
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 499),product_id uuid NOT NULL,sku text NOT NULL,name text NOT NULL,
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),operation text NOT NULL CHECK(operation IN ('none','set','remove')),status text NOT NULL CHECK(status IN ('changed','unchanged')),
 before jsonb NOT NULL CHECK(jsonb_typeof(before)='object'),after jsonb NOT NULL CHECK(jsonb_typeof(after)='object'),before_list_version integer NOT NULL CHECK(before_list_version>0),after_list_version integer NOT NULL CHECK(after_list_version>0),
 PRIMARY KEY(tenant_id,execution_id,index),FOREIGN KEY(tenant_id,execution_id,preview_id) REFERENCES price_bulk_edit_executions(tenant_id,id,preview_id),FOREIGN KEY(tenant_id,preview_id,index,product_id) REFERENCES price_bulk_edit_rows(tenant_id,preview_id,index,product_id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE FUNCTION price_bulk_edit_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'Price bulk evidence is immutable';END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['price_bulk_edit_previews','price_bulk_edit_rows','price_bulk_edit_executions','price_bulk_edit_execution_rows'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION price_bulk_edit_immutable()',t);
 END LOOP;END $$;
CREATE FUNCTION price_bulk_edit_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE p record;e record;r record;BEGIN
 SELECT * INTO p FROM price_bulk_edit_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
 IF TG_TABLE_NAME='price_bulk_edit_rows' THEN
 IF p.id IS NULL OR NEW.index>=p.total THEN RAISE EXCEPTION 'Price row outside frozen scope';END IF;
 ELSIF TG_TABLE_NAME='price_bulk_edit_executions' THEN
 IF p.id IS NULL OR NOT p.ready OR ROW(NEW.actor_id,NEW.price_list_id,NEW.scope_hash,NEW.total,NEW.changed,NEW.unchanged,NEW.missing_after_count,NEW.list_snapshot,NEW.repricing_snapshot,NEW.warnings,NEW.before_list_version)
 IS DISTINCT FROM ROW(p.actor_id,p.price_list_id,p.scope_hash,p.total,p.changed,p.unchanged,p.missing_after_count,p.list_snapshot,p.repricing_snapshot,p.warnings,(p.list_snapshot->>'version')::integer) THEN RAISE EXCEPTION 'Price execution differs from frozen scope';END IF;
 ELSIF TG_TABLE_NAME='price_bulk_edit_execution_rows' THEN
 SELECT * INTO e FROM price_bulk_edit_executions WHERE (tenant_id,id,preview_id)=(NEW.tenant_id,NEW.execution_id,NEW.preview_id);
 SELECT * INTO r FROM price_bulk_edit_rows WHERE (tenant_id,preview_id,index,product_id)=(NEW.tenant_id,NEW.preview_id,NEW.index,NEW.product_id);
 IF e.id IS NULL OR r.product_id IS NULL OR ROW(NEW.sku,NEW.name,NEW.input,NEW.operation,NEW.status,NEW.before,NEW.after,NEW.before_list_version,NEW.after_list_version) IS DISTINCT FROM ROW(r.sku,r.name,r.input,r.input->>'operation',r.status,r.before,r.after,e.before_list_version,e.after_list_version) THEN RAISE EXCEPTION 'Price execution row differs from approved row';END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER price_bulk_edit_row_scope BEFORE INSERT ON price_bulk_edit_rows FOR EACH ROW EXECUTE FUNCTION price_bulk_edit_scope();
CREATE TRIGGER price_bulk_edit_execution_scope BEFORE INSERT ON price_bulk_edit_executions FOR EACH ROW EXECUTE FUNCTION price_bulk_edit_scope();

CREATE TRIGGER price_bulk_edit_execution_row_scope BEFORE INSERT ON price_bulk_edit_execution_rows FOR EACH ROW EXECUTE FUNCTION price_bulk_edit_scope();
