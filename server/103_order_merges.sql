-- Commercial fragments retain independent prices/VAT and frozen recipes.
-- No FK references the removed (tenant,order,product) key; returns reference item UUID.
DO $$ DECLARE n text;BEGIN
 SELECT conname INTO n FROM pg_constraint WHERE conrelid='order_items'::regclass AND contype='u'
 AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='order_items'::regclass AND attname='tenant_id'),(SELECT attnum FROM pg_attribute WHERE attrelid='order_items'::regclass AND attname='order_id'),(SELECT attnum FROM pg_attribute WHERE attrelid='order_items'::regclass AND attname='product_id')]::smallint[];
 IF n IS NOT NULL THEN EXECUTE format('ALTER TABLE order_items DROP CONSTRAINT %I',n);END IF;
END $$;
CREATE INDEX order_items_product_fragments ON order_items(tenant_id,order_id,product_id,id);
ALTER TABLE order_items ADD UNIQUE(tenant_id,id);
CREATE TABLE order_merge_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),actor_id uuid NOT NULL REFERENCES users(id),api_key_id uuid,
 source text NOT NULL CHECK(source IN ('manual','api')),client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),request jsonb NOT NULL,
 scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),snapshot jsonb NOT NULL,source_ids uuid[] NOT NULL,
 main_order_id uuid NOT NULL,target_order_id uuid NOT NULL,merge_mode text NOT NULL CHECK(merge_mode IN ('technical_merge','into_main_order')),sum_delivery_costs boolean NOT NULL,
 total integer NOT NULL CHECK(total>0 AND total<=10000),source_count integer NOT NULL CHECK(source_count>=2 AND source_count<=100),
 ready boolean NOT NULL,receiver_conflict boolean NOT NULL,conflicts jsonb NOT NULL CHECK(jsonb_typeof(conflicts)='array'),
 total_minor integer NOT NULL CHECK(total_minor>=0),shipping_cost integer NOT NULL CHECK(shipping_cost>=0),target_status text NOT NULL CHECK(target_status IN ('new','paid','picking')),
 payment_balance jsonb NOT NULL,physical_count integer NOT NULL CHECK(physical_count>=0 AND physical_count<=10000),physical_quantity bigint NOT NULL CHECK(physical_quantity>=0),physical_scanned bigint NOT NULL CHECK(physical_scanned>=0 AND physical_scanned<=physical_quantity),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,byte_count bigint NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,main_order_id) REFERENCES orders(tenant_id,id),
 CHECK(source_count=cardinality(source_ids) AND main_order_id=ANY(source_ids)),CHECK(expires_at>created_at),CHECK(NOT ready OR jsonb_array_length(conflicts)=0)
);
CREATE TABLE order_merge_preview_rows (
 tenant_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index>=0 AND index<10000),row jsonb NOT NULL,byte_count bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,preview_id,index),FOREIGN KEY(tenant_id,preview_id) REFERENCES order_merge_previews(tenant_id,id)
);
CREATE TABLE order_merge_executions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),api_key_id uuid,
 source text NOT NULL CHECK(source IN ('manual','api')),client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),request jsonb NOT NULL,
 scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),source_ids uuid[] NOT NULL,main_order_id uuid NOT NULL,target_order_id uuid NOT NULL,
 merge_mode text NOT NULL CHECK(merge_mode IN ('technical_merge','into_main_order')),sum_delivery_costs boolean NOT NULL,
 total integer NOT NULL CHECK(total>0 AND total<=10000),source_count integer NOT NULL CHECK(source_count>=2 AND source_count<=100),
 state text NOT NULL DEFAULT 'done' CHECK(state='done'),receiver_conflict boolean NOT NULL,total_minor integer NOT NULL CHECK(total_minor>=0),shipping_cost integer NOT NULL CHECK(shipping_cost>=0),
 target_status text NOT NULL CHECK(target_status IN ('new','paid','picking')),payment_balance jsonb NOT NULL,
 physical_count integer NOT NULL CHECK(physical_count>=0 AND physical_count<=10000),physical_quantity bigint NOT NULL CHECK(physical_quantity>=0),physical_scanned bigint NOT NULL CHECK(physical_scanned>=0 AND physical_scanned<=physical_quantity),
 before_snapshot jsonb NOT NULL,after_snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count bigint NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,preview_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,preview_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES order_merge_previews(tenant_id,id),FOREIGN KEY(tenant_id,target_order_id) REFERENCES orders(tenant_id,id),
 CHECK(cardinality(source_ids)=source_count AND main_order_id=ANY(source_ids))
);
CREATE TABLE order_merge_execution_rows (
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index>=0 AND index<10000),row jsonb NOT NULL,target_item_id uuid NOT NULL,byte_count bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,execution_id,index),
 FOREIGN KEY(tenant_id,execution_id,preview_id) REFERENCES order_merge_executions(tenant_id,id,preview_id),
 FOREIGN KEY(tenant_id,preview_id,index) REFERENCES order_merge_preview_rows(tenant_id,preview_id,index),FOREIGN KEY(tenant_id,target_item_id) REFERENCES order_items(tenant_id,id)
);
CREATE INDEX order_merge_target_item_history ON order_merge_execution_rows(tenant_id,target_item_id,execution_id);
CREATE TABLE order_merge_claims (
 tenant_id uuid NOT NULL,source_order_id uuid NOT NULL,target_order_id uuid NOT NULL,execution_id uuid NOT NULL,
 merge_mode text NOT NULL CHECK(merge_mode IN ('technical_merge','into_main_order')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,source_order_id),CHECK(source_order_id<>target_order_id),
 FOREIGN KEY(tenant_id,source_order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,target_order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,execution_id) REFERENCES order_merge_executions(tenant_id,id)
);
CREATE INDEX order_merge_claim_target ON order_merge_claims(tenant_id,target_order_id,source_order_id);
CREATE TABLE order_merge_origins (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,header jsonb NOT NULL,items jsonb NOT NULL CHECK(jsonb_typeof(items)='array'),execution_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count bigint NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,order_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,execution_id) REFERENCES order_merge_executions(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION order_merge_current_role(p_user uuid,p_lock boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE v text;BEGIN
 IF p_lock THEN SELECT role INTO v FROM public.memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user FOR SHARE;
 ELSE SELECT role INTO v FROM public.memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user;END IF;RETURN v;END $$;
CREATE FUNCTION order_merge_key_grant(p_user uuid,p_key uuid,p_write boolean) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE k record;BEGIN
 SELECT revoked_at,expires_at,scopes INTO k FROM public.api_keys WHERE (tenant_id,user_id,id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,p_user,p_key) FOR SHARE;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR k.expires_at<=clock_timestamp() THEN RETURN 'invalid';END IF;
 IF NOT k.scopes @> ARRAY['orders:read','inventory:read']::text[] OR (p_write AND NOT k.scopes @> ARRAY['orders:write','inventory:write']::text[]) THEN RETURN 'insufficient';END IF;
 IF NOT k.scopes @> ARRAY['orders:write','inventory:write']::text[] THEN RETURN 'read_only';END IF;RETURN 'ok';END $$;
REVOKE ALL ON FUNCTION order_merge_current_role(uuid,boolean),order_merge_key_grant(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION order_merge_current_role(uuid,boolean),order_merge_key_grant(uuid,uuid,boolean) TO dyna_app;
CREATE FUNCTION order_merge_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Historia łączenia zamówień jest niezmienna' USING ERRCODE='23514';END $$;
CREATE FUNCTION order_merge_bytes() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE v bigint;BEGIN
 NEW.byte_count:=0;LOOP v:=octet_length(to_jsonb(NEW)::text);EXIT WHEN NEW.byte_count=v;NEW.byte_count:=v;END LOOP;RETURN NEW;END $$;
CREATE FUNCTION order_merge_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE p record;e record;i record;BEGIN
 IF TG_TABLE_NAME='order_merge_preview_rows' THEN
  SELECT * INTO p FROM order_merge_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
  IF FOUND AND (NEW.index>=p.total OR NOT((NEW.row->>'source_order_id')::uuid=ANY(p.source_ids))) THEN RAISE EXCEPTION 'Pozycja poza zakresem podglądu' USING ERRCODE='23514';END IF;
  SELECT * INTO i FROM order_items WHERE (tenant_id,order_id,id)=(NEW.tenant_id,(NEW.row->>'source_order_id')::uuid,(NEW.row->>'source_item_id')::uuid);
  IF NOT FOUND OR (i.product_id,i.sku,i.name,i.quantity,i.scanned,i.price,i.vat,i.line_total,i.components) IS DISTINCT FROM
    ((NEW.row->>'product_id')::uuid,NEW.row->>'sku',NEW.row->>'name',(NEW.row->>'quantity')::integer,(NEW.row->>'scanned')::integer,(NEW.row->>'price')::integer,(NEW.row->>'vat')::integer,(NEW.row->>'line_total')::integer,NEW.row->'components')
  THEN RAISE EXCEPTION 'Podgląd musi zachować rzeczywistą źródłową pozycję' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='order_merge_executions' THEN
  SELECT * INTO p FROM order_merge_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
  IF FOUND AND (NOT p.ready OR (NEW.actor_id,NEW.api_key_id,NEW.source,NEW.scope_hash,NEW.source_ids,NEW.main_order_id,NEW.target_order_id,NEW.merge_mode,NEW.sum_delivery_costs,NEW.total,NEW.source_count,NEW.total_minor,NEW.shipping_cost,NEW.target_status,NEW.payment_balance,NEW.before_snapshot) IS DISTINCT FROM
    (p.actor_id,p.api_key_id,p.source,p.scope_hash,p.source_ids,p.main_order_id,p.target_order_id,p.merge_mode,p.sum_delivery_costs,p.total,p.source_count,p.total_minor,p.shipping_cost,p.target_status,p.payment_balance,p.snapshot)) THEN RAISE EXCEPTION 'Wykonanie nie odpowiada zatwierdzonemu podglądowi' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='order_merge_execution_rows' THEN
  SELECT * INTO p FROM order_merge_preview_rows WHERE (tenant_id,preview_id,index)=(NEW.tenant_id,NEW.preview_id,NEW.index);
  IF FOUND AND NEW.row IS DISTINCT FROM p.row THEN RAISE EXCEPTION 'Dowód pozycji różni się od podglądu' USING ERRCODE='23514';END IF;
  SELECT * INTO e FROM order_merge_executions WHERE (tenant_id,id)=(NEW.tenant_id,NEW.execution_id);
  SELECT * INTO i FROM order_items WHERE (tenant_id,id)=(NEW.tenant_id,NEW.target_item_id);
  IF e.id IS NOT NULL AND i.id IS NOT NULL AND ((i.order_id,i.product_id,i.sku,i.name,i.quantity,i.price,i.vat,i.line_total,i.components) IS DISTINCT FROM
    (e.target_order_id,(NEW.row->>'product_id')::uuid,NEW.row->>'sku',NEW.row->>'name',(NEW.row->>'quantity')::integer,(NEW.row->>'price')::integer,(NEW.row->>'vat')::integer,(NEW.row->>'line_total')::integer,NEW.row->'components')) THEN RAISE EXCEPTION 'Pozycja docelowa nie odpowiada źródłu' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='order_merge_claims' THEN
  SELECT * INTO e FROM order_merge_executions WHERE (tenant_id,id)=(NEW.tenant_id,NEW.execution_id);
  IF FOUND AND (NEW.target_order_id<>e.target_order_id OR NEW.merge_mode<>e.merge_mode OR NOT NEW.source_order_id=ANY(e.source_ids)) THEN RAISE EXCEPTION 'Nieprawidłowy właściciel realizacji' USING ERRCODE='23514';END IF;
  IF EXISTS(WITH RECURSIVE chain(id) AS (SELECT NEW.target_order_id UNION SELECT c.target_order_id FROM order_merge_claims c JOIN chain x ON c.source_order_id=x.id WHERE c.tenant_id=NEW.tenant_id) SELECT 1 FROM chain WHERE id=NEW.source_order_id) THEN RAISE EXCEPTION 'Cykl właścicieli zamówień' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='order_merge_origins' THEN
  SELECT * INTO i FROM orders WHERE (tenant_id,id)=(NEW.tenant_id,NEW.order_id);
  IF FOUND AND NEW.header IS DISTINCT FROM (to_jsonb(i)||jsonb_build_object('version',i.version::text)) THEN RAISE EXCEPTION 'Pierwotny nagłówek musi odpowiadać zamówieniu' USING ERRCODE='23514';END IF;
  IF NEW.items IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]'::jsonb) FROM order_items x WHERE (tenant_id,order_id)=(NEW.tenant_id,NEW.order_id)) THEN RAISE EXCEPTION 'Pierwotne pozycje muszą odpowiadać zamówieniu' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END $$;
CREATE FUNCTION order_merge_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE n bigint;BEGIN
 IF TG_TABLE_NAME='order_merge_previews' THEN
  SELECT count(*) INTO n FROM order_merge_preview_rows WHERE (tenant_id,preview_id)=(NEW.tenant_id,NEW.id);
 ELSE SELECT count(*) INTO n FROM order_merge_execution_rows WHERE (tenant_id,execution_id)=(NEW.tenant_id,NEW.id);
  IF (SELECT count(*) FROM order_merge_claims WHERE (tenant_id,execution_id)=(NEW.tenant_id,NEW.id))<>(NEW.source_count-(CASE WHEN NEW.target_order_id=ANY(NEW.source_ids) THEN 1 ELSE 0 END)) THEN RAISE EXCEPTION 'Niepełne przejęcie realizacji' USING ERRCODE='23514';END IF;
 END IF;
 IF n<>NEW.total THEN RAISE EXCEPTION 'Niepełny dowód pozycji zamówień' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE FUNCTION order_merge_budget() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE t uuid;v bigint;n bigint;p record;BEGIN
 t:=nullif(current_setting('app.tenant_id',true),'')::uuid;PERFORM pg_advisory_xact_lock(hashtextextended('order.merge.proof:'||t::text,0));
 SELECT (SELECT coalesce(sum(byte_count),0) FROM order_merge_previews)+(SELECT coalesce(sum(byte_count),0) FROM order_merge_preview_rows)+(SELECT coalesce(sum(byte_count),0) FROM order_merge_executions)+(SELECT coalesce(sum(byte_count),0) FROM order_merge_execution_rows)+(SELECT coalesce(sum(byte_count),0) FROM order_merge_claims)+(SELECT coalesce(sum(byte_count),0) FROM order_merge_origins) INTO v;
 IF v>134217728 THEN RAISE EXCEPTION 'Limit historii łączenia zamówień';END IF;
 SELECT count(*) INTO n FROM order_merge_previews;IF n>2000 THEN RAISE EXCEPTION 'Limit podglądów łączenia zamówień';END IF;
 SELECT count(*) INTO n FROM order_merge_executions;IF n>2000 THEN RAISE EXCEPTION 'Limit wykonań łączenia zamówień';END IF;
 IF TG_TABLE_NAME IN ('order_merge_previews','order_merge_preview_rows') THEN
  FOR p IN SELECT h.id,h.byte_count+coalesce(sum(r.byte_count),0) bytes FROM order_merge_previews h LEFT JOIN order_merge_preview_rows r ON(r.tenant_id,r.preview_id)=(h.tenant_id,h.id) GROUP BY h.id LOOP
   IF p.bytes>8388608 THEN RAISE EXCEPTION 'Limit rozmiaru podglądu łączenia zamówień';END IF;
  END LOOP;
 END IF;RETURN NULL;END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['order_merge_previews','order_merge_preview_rows','order_merge_executions','order_merge_execution_rows','order_merge_claims','order_merge_origins'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION order_merge_immutable()',t);
 EXECUTE format('CREATE TRIGGER bytes BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION order_merge_bytes()',t);
 EXECUTE format('CREATE TRIGGER scope BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION order_merge_scope()',t);
 EXECUTE format('CREATE TRIGGER budget AFTER INSERT ON %I FOR EACH STATEMENT EXECUTE FUNCTION order_merge_budget()',t);
 END LOOP;END $$;
CREATE CONSTRAINT TRIGGER complete AFTER INSERT ON order_merge_previews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_merge_complete();
CREATE CONSTRAINT TRIGGER complete AFTER INSERT ON order_merge_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_merge_complete();
REVOKE ALL ON FUNCTION order_merge_immutable(),order_merge_bytes(),order_merge_scope(),order_merge_complete(),order_merge_budget() FROM PUBLIC;
