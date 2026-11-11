-- Private purchase-source epoch. Existing source/business rows are untouched.
CREATE TABLE purchasing_source_versions (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
 version bigint NOT NULL CHECK(version>=0),
 created_transaction xid8,created_order_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[]
);
ALTER TABLE purchasing_source_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchasing_source_versions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON purchasing_source_versions FROM PUBLIC,dyna_app;
DO $$ BEGIN
 EXECUTE format('CREATE POLICY source_owner ON public.purchasing_source_versions TO %I USING(true) WITH CHECK(true)',current_user);
END $$;

-- Shared stock writers append independent markers, never hold a shared epoch
-- row while waiting for another physical row. Own MAX is unchanged by a
-- different firm's writes and survives raw stock delete/reinsert ABA.
CREATE TABLE purchasing_stock_changes (
 id bigserial PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id)
);
CREATE INDEX purchasing_stock_changes_scope ON purchasing_stock_changes(tenant_id,id DESC);
ALTER TABLE purchasing_stock_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchasing_stock_changes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON purchasing_stock_changes FROM PUBLIC,dyna_app;
REVOKE ALL ON SEQUENCE purchasing_stock_changes_id_seq FROM PUBLIC,dyna_app;
DO $$ BEGIN
 EXECUTE format('CREATE POLICY stock_change_owner ON public.purchasing_stock_changes TO %I USING(true) WITH CHECK(true)',current_user);
END $$;
CREATE FUNCTION purchasing_stock_change_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 RAISE EXCEPTION 'Purchase stock source marker is immutable' USING ERRCODE='23514';END $$;
REVOKE ALL ON FUNCTION purchasing_stock_change_immutable() FROM PUBLIC,dyna_app;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON purchasing_stock_changes FOR EACH ROW EXECUTE FUNCTION purchasing_stock_change_immutable();

CREATE FUNCTION replenishment_definition_valid(d jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE k text;v jsonb; BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT d ?& ARRAY['enabled','minimum_quantity','target_quantity','supplier_id','supplier_sku','currency','minimum_order_quantity','order_multiple','unit_cost_minor','cost_valid_until','cost_confirmed_at','expected_date']
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(d) x WHERE x NOT IN ('enabled','minimum_quantity','target_quantity','supplier_id','supplier_sku','currency','minimum_order_quantity','order_multiple','unit_cost_minor','cost_valid_until','cost_confirmed_at','expected_date')) THEN RETURN false;END IF;
 IF jsonb_typeof(d->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(d->'supplier_id') IS DISTINCT FROM 'string'
 OR d->>'supplier_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(d->'supplier_sku') IS DISTINCT FROM 'string' OR char_length(d->>'supplier_sku')>80 OR d->>'supplier_sku'<>btrim(d->>'supplier_sku')
 OR jsonb_typeof(d->'currency') IS DISTINCT FROM 'string' OR d->>'currency' NOT IN ('PLN','EUR','USD','GBP','CZK') THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['minimum_quantity','target_quantity','minimum_order_quantity','order_multiple'] LOOP
  v:=d->k;IF jsonb_typeof(v) IS DISTINCT FROM 'number' OR v::text !~ '^(0|[1-9][0-9]*)$' THEN RETURN false;END IF;
  IF (v::text)::numeric>(CASE WHEN k IN ('minimum_quantity','target_quantity') THEN 2147483647 ELSE 1000000 END)
  OR (v::text)::numeric<(CASE WHEN k IN ('minimum_quantity','target_quantity') THEN 0 ELSE 1 END) THEN RETURN false;END IF;
 END LOOP;
 IF (d->>'target_quantity')::numeric<(d->>'minimum_quantity')::numeric THEN RETURN false;END IF;
 IF d->'unit_cost_minor'='null'::jsonb THEN
  IF d->'cost_valid_until' IS DISTINCT FROM 'null'::jsonb OR d->'cost_confirmed_at' IS DISTINCT FROM 'null'::jsonb THEN RETURN false;END IF;
 ELSE
  IF jsonb_typeof(d->'unit_cost_minor') IS DISTINCT FROM 'number' OR (d->'unit_cost_minor')::text !~ '^(0|[1-9][0-9]*)$'
  OR (d->>'unit_cost_minor')::numeric>1000000000 OR jsonb_typeof(d->'cost_valid_until') IS DISTINCT FROM 'string'
  OR jsonb_typeof(d->'cost_confirmed_at') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
  IF (d->>'cost_valid_until')::timestamptz<=(d->>'cost_confirmed_at')::timestamptz
  OR (d->>'cost_valid_until')::timestamptz>(d->>'cost_confirmed_at')::timestamptz+interval '30 days' THEN RETURN false;END IF;
 END IF;
 IF d->'expected_date'<>'null'::jsonb AND (jsonb_typeof(d->'expected_date') IS DISTINCT FROM 'string' OR d->>'expected_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN RETURN false;
END $$;
CREATE FUNCTION replenishment_summary_valid(d jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$ DECLARE k text;n numeric:=0;BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT d ?& ARRAY['total','purchase','unchanged','invalid','conflicts']
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(d) x WHERE x NOT IN ('total','purchase','unchanged','invalid','conflicts')) THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['total','purchase','unchanged','invalid','conflicts'] LOOP
  IF jsonb_typeof(d->k) IS DISTINCT FROM 'number' OR (d->k)::text !~ '^(0|[1-9][0-9]*)$' OR (d->>k)::numeric>500 THEN RETURN false;END IF;
  IF k<>'total' THEN n:=n+(d->>k)::numeric;END IF;
 END LOOP;RETURN (d->>'total')::numeric>=1 AND n=(d->>'total')::numeric;
END $$;
REVOKE ALL ON FUNCTION replenishment_definition_valid(jsonb),replenishment_summary_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replenishment_definition_valid(jsonb),replenishment_summary_valid(jsonb) TO dyna_app;

CREATE TABLE replenishment_policies (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,warehouse_id uuid NOT NULL,product_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),definition jsonb NOT NULL CHECK(replenishment_definition_valid(definition)),
 supplier_id uuid GENERATED ALWAYS AS ((definition->>'supplier_id')::uuid) STORED,
 actor_id uuid NOT NULL REFERENCES users,source text NOT NULL CHECK(source IN ('manual','api')),client_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),initial_request jsonb NOT NULL CHECK(jsonb_typeof(initial_request)='object' AND octet_length(initial_request::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,warehouse_id,product_id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 FOREIGN KEY(tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id)
);
CREATE TABLE replenishment_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,
 source text NOT NULL CHECK(source IN ('manual','api')),client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 warehouse_id uuid NOT NULL,scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),source_version bigint NOT NULL CHECK(source_version>=0),
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),summary jsonb NOT NULL CHECK(replenishment_summary_valid(summary)),
 groups jsonb NOT NULL CHECK(jsonb_typeof(groups)='array' AND jsonb_array_length(groups)<=500),warnings jsonb NOT NULL CHECK(jsonb_typeof(warnings)='array'),ready boolean NOT NULL,
 byte_count bigint NOT NULL DEFAULT 0 CHECK(byte_count>0),created_at timestamptz NOT NULL DEFAULT statement_timestamp(),expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '15 minutes',
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 CHECK(ready=((summary->>'invalid')::integer=0 AND (summary->>'conflicts')::integer=0)),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes')
);
CREATE INDEX replenishment_previews_history ON replenishment_previews(tenant_id,created_at DESC,id DESC);
CREATE TABLE replenishment_rows (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index>=0 AND index<=499),
 product_id uuid,policy_id uuid,product_version integer CHECK(product_version>0),policy_version integer CHECK(policy_version>0),
 status text NOT NULL CHECK(status IN ('purchase','unchanged','invalid','conflict')),input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 errors jsonb NOT NULL CHECK(jsonb_typeof(errors)='array'),warnings jsonb NOT NULL CHECK(jsonb_typeof(warnings)='array'),byte_count bigint NOT NULL DEFAULT 0 CHECK(byte_count>0),
 UNIQUE(tenant_id,preview_id,index),UNIQUE(tenant_id,preview_id,id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES replenishment_previews(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 FOREIGN KEY(tenant_id,policy_id) REFERENCES replenishment_policies(tenant_id,id),
 CHECK(status NOT IN ('purchase','unchanged') OR (product_id IS NOT NULL AND policy_id IS NOT NULL AND product_version IS NOT NULL AND policy_version IS NOT NULL AND jsonb_array_length(errors)=0))
);
CREATE TABLE replenishment_executions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 source text NOT NULL CHECK(source IN ('manual','api')),client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 warehouse_id uuid NOT NULL,scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),before_source_version bigint NOT NULL CHECK(before_source_version>=0),
 after_source_version bigint NOT NULL CHECK(after_source_version>=before_source_version),summary jsonb NOT NULL CHECK(replenishment_summary_valid(summary)),
 groups jsonb NOT NULL CHECK(jsonb_typeof(groups)='array' AND jsonb_array_length(groups)<=500),state text NOT NULL DEFAULT 'done' CHECK(state='done'),
 byte_count bigint NOT NULL DEFAULT 0 CHECK(byte_count>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,preview_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES replenishment_previews(tenant_id,id),FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 CHECK((summary->>'invalid')::integer=0 AND (summary->>'conflicts')::integer=0)
);
CREATE INDEX replenishment_executions_history ON replenishment_executions(tenant_id,created_at DESC,id DESC);
CREATE TABLE replenishment_execution_rows (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,execution_id uuid NOT NULL,preview_id uuid NOT NULL,preview_row_id uuid NOT NULL,index integer NOT NULL CHECK(index>=0 AND index<=499),
 product_id uuid NOT NULL,policy_id uuid NOT NULL,status text NOT NULL CHECK(status IN ('purchase','unchanged')),
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 errors jsonb NOT NULL CHECK(jsonb_typeof(errors)='array' AND jsonb_array_length(errors)=0),warnings jsonb NOT NULL CHECK(jsonb_typeof(warnings)='array'),purchase_order_id uuid,
 byte_count bigint NOT NULL DEFAULT 0 CHECK(byte_count>0),UNIQUE(tenant_id,execution_id,index),UNIQUE(tenant_id,execution_id,product_id),
 FOREIGN KEY(tenant_id,execution_id,preview_id) REFERENCES replenishment_executions(tenant_id,id,preview_id),
 FOREIGN KEY(tenant_id,preview_id,preview_row_id) REFERENCES replenishment_rows(tenant_id,preview_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),FOREIGN KEY(tenant_id,policy_id) REFERENCES replenishment_policies(tenant_id,id),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES purchase_orders(tenant_id,id),CHECK((status='purchase')=(purchase_order_id IS NOT NULL))
);

CREATE FUNCTION replenishment_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 RAISE EXCEPTION 'Replenishment evidence is immutable' USING ERRCODE='23514';END $$;
CREATE FUNCTION replenishment_bytes() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE n bigint;BEGIN
 LOOP n:=octet_length(to_jsonb(NEW)::text);EXIT WHEN NEW.byte_count=n;NEW.byte_count:=n;END LOOP;RETURN NEW;
END $$;
CREATE FUNCTION replenishment_policy_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Replenishment policy identity cannot be deleted' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR (NEW.initial_request->>'warehouse_id')::uuid IS DISTINCT FROM NEW.warehouse_id
  OR (NEW.initial_request->>'product_id')::uuid IS DISTINCT FROM NEW.product_id
  OR (NEW.initial_request->>'client_key')::uuid IS DISTINCT FROM NEW.client_key
  OR ((NEW.initial_request->'definition')-'confirm_cost') IS DISTINCT FROM (NEW.definition-'cost_confirmed_at')
  THEN RAISE EXCEPTION 'Replenishment policy initial request mismatch' USING ERRCODE='23514';END IF;
 ELSE
  IF ROW(NEW.id,NEW.tenant_id,NEW.warehouse_id,NEW.product_id,NEW.actor_id,NEW.source,NEW.client_key,NEW.request_hash,NEW.initial_request,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.warehouse_id,OLD.product_id,OLD.actor_id,OLD.source,OLD.client_key,OLD.request_hash,OLD.initial_request,OLD.created_at)
   OR NEW.version::bigint<>OLD.version::bigint+1 OR NEW.updated_at<OLD.updated_at THEN RAISE EXCEPTION 'Replenishment policy identity or revision mismatch' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION replenishment_immutable(),replenishment_bytes(),replenishment_policy_scope() FROM PUBLIC;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['replenishment_policies','replenishment_previews','replenishment_rows','replenishment_executions','replenishment_execution_rows'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
  IF t='replenishment_policies' THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dyna_app',t);
   EXECUTE format('CREATE TRIGGER policy_scope BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION replenishment_policy_scope()',t);
  ELSE
   EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
   EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION replenishment_immutable()',t);
   EXECUTE format('CREATE TRIGGER serialized_bytes BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION replenishment_bytes()',t);
  END IF;
 END LOOP;
END $$;

CREATE FUNCTION replenishment_current_role(p_user uuid,p_lock boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE result text;BEGIN
 IF p_lock THEN SELECT role INTO result FROM public.memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user FOR SHARE;
 ELSE SELECT role INTO result FROM public.memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user;END IF;
 RETURN result;
END $$;
CREATE FUNCTION replenishment_key_grant(p_user uuid,p_key uuid,p_write boolean) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE k record;BEGIN
 SELECT revoked_at,expires_at,scopes INTO k FROM public.api_keys WHERE (tenant_id,user_id,id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,p_user,p_key) FOR SHARE;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR k.expires_at<=clock_timestamp() THEN RETURN 'invalid';END IF;
 IF NOT k.scopes @> ARRAY['products:read','inventory:read','purchasing:read']::text[] OR (p_write AND NOT k.scopes @> ARRAY['purchasing:write']::text[]) THEN RETURN 'insufficient';END IF;
 IF NOT k.scopes @> ARRAY['purchasing:write']::text[] THEN RETURN 'read_only';END IF;RETURN 'ok';
END $$;
REVOKE ALL ON FUNCTION replenishment_current_role(uuid,boolean),replenishment_key_grant(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replenishment_current_role(uuid,boolean),replenishment_key_grant(uuid,uuid,boolean) TO dyna_app;

-- A typed, immutable identity link, never a FK to editable purchase line values.
ALTER TABLE purchase_orders ADD COLUMN replenishment_execution_id uuid,ADD COLUMN replenishment_group_index integer;
ALTER TABLE purchase_orders ADD CONSTRAINT replenishment_po_pair CHECK((replenishment_execution_id IS NULL)=(replenishment_group_index IS NULL));
ALTER TABLE purchase_orders ADD CONSTRAINT replenishment_po_group_range CHECK(replenishment_group_index>=0 AND replenishment_group_index<=499);
ALTER TABLE purchase_orders ADD CONSTRAINT replenishment_po_execution_fk FOREIGN KEY(tenant_id,replenishment_execution_id)
 REFERENCES replenishment_executions(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX replenishment_po_group ON purchase_orders(tenant_id,replenishment_execution_id,replenishment_group_index) WHERE replenishment_execution_id IS NOT NULL;
CREATE FUNCTION replenishment_po_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='UPDATE' AND OLD.replenishment_execution_id IS NULL AND NEW.replenishment_execution_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM public.purchasing_source_versions v WHERE v.tenant_id=OLD.tenant_id
  AND v.created_transaction=pg_current_xact_id() AND OLD.id=ANY(v.created_order_ids)) THEN
  RAISE EXCEPTION 'Replenishment cannot adopt a previously committed purchase' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND OLD.replenishment_execution_id IS NOT NULL
 AND ROW(NEW.replenishment_execution_id,NEW.replenishment_group_index,NEW.tenant_id,NEW.id)
 IS DISTINCT FROM ROW(OLD.replenishment_execution_id,OLD.replenishment_group_index,OLD.tenant_id,OLD.id) THEN
  RAISE EXCEPTION 'Replenishment purchase identity is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION replenishment_po_identity() FROM PUBLIC,dyna_app;
CREATE TRIGGER replenishment_identity BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION replenishment_po_identity();

CREATE FUNCTION replenishment_po_bound() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e record;g jsonb;BEGIN
 IF NEW.replenishment_execution_id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO e FROM replenishment_executions WHERE (tenant_id,id)=(NEW.tenant_id,NEW.replenishment_execution_id);
 IF e.id IS NULL THEN RETURN NULL;END IF; -- Genuine deferred FK handles absent execution.
 g:=e.groups->NEW.replenishment_group_index;
 IF g IS NULL OR (g->>'index')::integer IS DISTINCT FROM NEW.replenishment_group_index
 OR (g->>'purchase_order_id')::uuid IS DISTINCT FROM NEW.id THEN
  RAISE EXCEPTION 'Replenishment purchase is outside the execution group' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION replenishment_po_bound() FROM PUBLIC,dyna_app;
CREATE CONSTRAINT TRIGGER replenishment_bound AFTER INSERT OR UPDATE OF replenishment_execution_id,replenishment_group_index ON purchase_orders
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION replenishment_po_bound();

CREATE FUNCTION replenishment_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p record;e record;r record; BEGIN
 SELECT * INTO p FROM public.replenishment_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
 IF p.id IS NULL THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='replenishment_rows' THEN
  IF NEW.index>=(p.summary->>'total')::integer THEN RAISE EXCEPTION 'Replenishment row outside preview' USING ERRCODE='23514';END IF;
  IF NEW.product_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM products WHERE (tenant_id,id)=(NEW.tenant_id,NEW.product_id)) THEN RETURN NEW;END IF;
  IF NEW.policy_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM replenishment_policies WHERE (tenant_id,id)=(NEW.tenant_id,NEW.policy_id)) THEN RETURN NEW;END IF;
  IF NEW.status IN ('purchase','unchanged') AND (
   (NEW.input->>'product_id')::uuid IS DISTINCT FROM NEW.product_id OR
   (NEW.snapshot->'product'->>'id')::uuid IS DISTINCT FROM NEW.product_id OR
   (NEW.snapshot->'product'->>'version')::integer IS DISTINCT FROM NEW.product_version OR
   (NEW.snapshot->'policy'->>'id')::uuid IS DISTINCT FROM NEW.policy_id OR
   (NEW.snapshot->'policy'->>'version')::integer IS DISTINCT FROM NEW.policy_version OR
   NOT EXISTS(SELECT 1 FROM replenishment_policies WHERE (tenant_id,id,warehouse_id,product_id)=(NEW.tenant_id,NEW.policy_id,p.warehouse_id,NEW.product_id))
  ) THEN RAISE EXCEPTION 'Replenishment row source differs from typed scope' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='replenishment_executions' THEN
  IF NOT p.ready OR ROW(NEW.actor_id,NEW.source,NEW.warehouse_id,NEW.scope_hash,NEW.before_source_version,NEW.summary)
   IS DISTINCT FROM ROW(p.actor_id,p.source,p.warehouse_id,p.scope_hash,p.source_version,p.summary) THEN
   RAISE EXCEPTION 'Replenishment execution differs from approved preview' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO e FROM replenishment_executions WHERE (tenant_id,id,preview_id)=(NEW.tenant_id,NEW.execution_id,NEW.preview_id);
  SELECT * INTO r FROM replenishment_rows WHERE (tenant_id,preview_id,id)=(NEW.tenant_id,NEW.preview_id,NEW.preview_row_id);
  IF e.id IS NULL OR r.id IS NULL THEN RETURN NEW;END IF;
  IF ROW(NEW.index,NEW.product_id,NEW.policy_id,NEW.status,NEW.input,NEW.snapshot,NEW.result,NEW.errors,NEW.warnings)
   IS DISTINCT FROM ROW(r.index,r.product_id,r.policy_id,r.status,r.input,r.snapshot,r.result,r.errors,r.warnings) THEN
   RAISE EXCEPTION 'Replenishment receipt differs from approved row' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION replenishment_scope() FROM PUBLIC;
CREATE TRIGGER scope BEFORE INSERT ON replenishment_rows FOR EACH ROW EXECUTE FUNCTION replenishment_scope();
CREATE TRIGGER scope BEFORE INSERT ON replenishment_executions FOR EACH ROW EXECUTE FUNCTION replenishment_scope();
CREATE TRIGGER scope BEFORE INSERT ON replenishment_execution_rows FOR EACH ROW EXECUTE FUNCTION replenishment_scope();

-- Only INSERT of a new immutable head validates original PO lines. Later normal
-- edits/receipts never revalidate those frozen quantities or costs.
CREATE FUNCTION replenishment_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n integer;buy integer;noop integer;bad integer;conf integer;p record;g jsonb;approved jsonb;po record;r record;line record;items jsonb;total numeric;epoch bigint;group_no integer:=0;
BEGIN
 IF TG_TABLE_NAME='replenishment_previews' THEN
  SELECT count(*),count(*) FILTER(WHERE status='purchase'),count(*) FILTER(WHERE status='unchanged'),count(*) FILTER(WHERE status='invalid'),count(*) FILTER(WHERE status='conflict')
   INTO n,buy,noop,bad,conf FROM replenishment_rows WHERE (tenant_id,preview_id)=(NEW.tenant_id,NEW.id);
  IF ROW(n,buy,noop,bad,conf) IS DISTINCT FROM ROW((NEW.summary->>'total')::integer,(NEW.summary->>'purchase')::integer,(NEW.summary->>'unchanged')::integer,(NEW.summary->>'invalid')::integer,(NEW.summary->>'conflicts')::integer)
  THEN RAISE EXCEPTION 'Replenishment preview is incomplete' USING ERRCODE='23514';END IF;
  IF NEW.ready AND (SELECT count(DISTINCT product_id) FROM replenishment_rows WHERE (tenant_id,preview_id)=(NEW.tenant_id,NEW.id))<>n THEN
   RAISE EXCEPTION 'Replenishment ready preview repeats product identity' USING ERRCODE='23514';END IF;
  FOR g IN SELECT value FROM jsonb_array_elements(NEW.groups) WITH ORDINALITY a(value,ordinal) ORDER BY ordinal LOOP
   IF (g->>'index')::integer IS DISTINCT FROM group_no OR jsonb_typeof(g->'product_ids') IS DISTINCT FROM 'array'
    OR (g->>'line_count')::integer IS NULL OR (g->>'line_count')::integer<1 OR (g->>'line_count')::integer>200 THEN
    RAISE EXCEPTION 'Replenishment group index or size is invalid' USING ERRCODE='23514';END IF;
   SELECT jsonb_agg(product_id::text ORDER BY product_id),sum((result->>'line_total_minor')::numeric) INTO items,total
    FROM replenishment_rows WHERE (tenant_id,preview_id)=(NEW.tenant_id,NEW.id) AND status='purchase' AND (result->>'group_index')::integer=(g->>'index')::integer;
   IF items IS DISTINCT FROM g->'product_ids' OR jsonb_array_length(items) IS DISTINCT FROM (g->>'line_count')::integer
   OR total::text IS DISTINCT FROM g->>'total_minor' THEN RAISE EXCEPTION 'Replenishment group differs from frozen rows' USING ERRCODE='23514';END IF;
   group_no:=group_no+1;
  END LOOP;
  IF EXISTS(SELECT 1 FROM replenishment_rows rr WHERE (rr.tenant_id,rr.preview_id)=(NEW.tenant_id,NEW.id) AND rr.status='purchase'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.groups) group_json WHERE (group_json->>'index')::integer=(rr.result->>'group_index')::integer)) THEN
   RAISE EXCEPTION 'Replenishment purchase row has no approved group' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO p FROM replenishment_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
  SELECT count(*),count(*) FILTER(WHERE status='purchase'),count(*) FILTER(WHERE status='unchanged') INTO n,buy,noop
   FROM replenishment_execution_rows WHERE (tenant_id,execution_id)=(NEW.tenant_id,NEW.id);
  IF ROW(n,buy,noop) IS DISTINCT FROM ROW((NEW.summary->>'total')::integer,(NEW.summary->>'purchase')::integer,(NEW.summary->>'unchanged')::integer) THEN
   RAISE EXCEPTION 'Replenishment execution is incomplete' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(value-'purchase_order_id'-'number'-'version' ORDER BY ordinal),'[]'::jsonb) INTO approved
   FROM jsonb_array_elements(NEW.groups) WITH ORDINALITY a(value,ordinal);
  IF approved IS DISTINCT FROM p.groups THEN RAISE EXCEPTION 'Replenishment execution groups differ from preview' USING ERRCODE='23514';END IF;
  SELECT coalesce((SELECT version FROM purchasing_source_versions WHERE tenant_id=NEW.tenant_id),0)
   +coalesce((SELECT max(id) FROM purchasing_stock_changes WHERE tenant_id=NEW.tenant_id),0) INTO epoch;
  IF NEW.after_source_version IS DISTINCT FROM coalesce(epoch,0) OR (buy=0 AND NEW.after_source_version<>NEW.before_source_version)
   OR (buy>0 AND NEW.after_source_version<=NEW.before_source_version) THEN
   RAISE EXCEPTION 'Replenishment execution source epoch is not actual' USING ERRCODE='23514';END IF;
  FOR g IN SELECT value FROM jsonb_array_elements(NEW.groups) LOOP
   SELECT * INTO po FROM purchase_orders WHERE (tenant_id,id)=(NEW.tenant_id,(g->>'purchase_order_id')::uuid);
   IF po.id IS NULL OR ROW(po.replenishment_execution_id,po.replenishment_group_index,po.warehouse_id,po.supplier_id,po.currency,po.number,po.version,po.state,po.created_by,po.expected_date::text)
   IS DISTINCT FROM ROW(NEW.id,(g->>'index')::integer,NEW.warehouse_id,(g->>'supplier_id')::uuid,g->>'currency',g->>'number',1,'draft'::text,NEW.actor_id,g->>'expected_date')
   OR (g->>'version')::integer IS DISTINCT FROM 1 OR po.supplier_snapshot->>'name' IS DISTINCT FROM g->>'supplier_name' THEN
    RAISE EXCEPTION 'Replenishment group does not bind genuine initial draft' USING ERRCODE='23514';END IF;
   IF (SELECT count(*) FROM purchase_order_lines WHERE (tenant_id,order_id)=(NEW.tenant_id,po.id))<>(g->>'line_count')::integer THEN
    RAISE EXCEPTION 'Replenishment draft has unexpected line set' USING ERRCODE='23514';END IF;
   FOR r IN SELECT * FROM replenishment_execution_rows WHERE (tenant_id,execution_id)=(NEW.tenant_id,NEW.id)
    AND (result->>'group_index')::integer=(g->>'index')::integer AND status='purchase' LOOP
    SELECT * INTO line FROM purchase_order_lines WHERE (tenant_id,order_id,product_id)=(NEW.tenant_id,po.id,r.product_id);
    IF r.purchase_order_id IS DISTINCT FROM po.id OR line.product_id IS NULL OR
     ROW(line.quantity,line.unit_cost,line.supplier_sku,line.received_quantity,line.closed_quantity,line.sku,line.name)
     IS DISTINCT FROM ROW((r.result->>'recommended_quantity')::integer,(r.result->>'unit_cost_minor')::integer,r.snapshot->'policy'->>'supplier_sku',0,0,r.snapshot->'product'->>'sku',r.snapshot->'product'->>'name') THEN
     RAISE EXCEPTION 'Replenishment draft line differs from approved row' USING ERRCODE='23514';END IF;
   END LOOP;
  END LOOP;
 END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION replenishment_complete() FROM PUBLIC,dyna_app;
CREATE CONSTRAINT TRIGGER complete AFTER INSERT ON replenishment_previews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION replenishment_complete();
CREATE CONSTRAINT TRIGGER complete AFTER INSERT ON replenishment_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION replenishment_complete();

CREATE FUNCTION replenishment_budget() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t uuid;n bigint;p uuid;BEGIN
 FOR t IN SELECT DISTINCT tenant_id FROM inserted ORDER BY tenant_id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('replenishment.proof:'||t::text,0));
  IF (SELECT count(*) FROM replenishment_previews WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM replenishment_executions WHERE tenant_id=t)>2000 THEN
   RAISE EXCEPTION 'Replenishment proof count quota exceeded' USING ERRCODE='P0001';END IF;
  SELECT coalesce(sum(bytes),0) INTO n FROM (
   SELECT byte_count bytes FROM replenishment_previews WHERE tenant_id=t UNION ALL SELECT byte_count FROM replenishment_rows WHERE tenant_id=t
   UNION ALL SELECT byte_count FROM replenishment_executions WHERE tenant_id=t UNION ALL SELECT byte_count FROM replenishment_execution_rows WHERE tenant_id=t
  ) all_bytes;
  IF n>134217728 THEN RAISE EXCEPTION 'Replenishment proof storage quota exceeded' USING ERRCODE='P0001';END IF;
  IF TG_TABLE_NAME IN ('replenishment_previews','replenishment_rows') THEN
   FOR p IN EXECUTE (CASE WHEN TG_TABLE_NAME='replenishment_previews' THEN 'SELECT id FROM inserted WHERE tenant_id=$1' ELSE 'SELECT DISTINCT preview_id FROM inserted WHERE tenant_id=$1' END) USING t LOOP
    SELECT h.byte_count+coalesce(sum(r.byte_count),0) INTO n FROM replenishment_previews h LEFT JOIN replenishment_rows r
     ON (r.tenant_id,r.preview_id)=(h.tenant_id,h.id) WHERE (h.tenant_id,h.id)=(t,p) GROUP BY h.byte_count;
    IF n>8388608 THEN RAISE EXCEPTION 'Replenishment preview exceeds eight MiB' USING ERRCODE='P0001';END IF;
   END LOOP;
  END IF;
 END LOOP;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION replenishment_budget() FROM PUBLIC;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['replenishment_previews','replenishment_rows','replenishment_executions','replenishment_execution_rows'] LOOP
  EXECUTE format('CREATE TRIGGER budget AFTER INSERT ON %I REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION replenishment_budget()',t);
 END LOOP;
END $$;

-- All scoped writers take the shared global gate before their sorted tenant
-- gates. Privileged setup without a scope takes the exclusive global gate,
-- before any row locks, so it cannot silently bypass runtime source fencing.
CREATE FUNCTION purchasing_source_admit() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE scope uuid; invoker text; BEGIN
 invoker:=coalesce(nullif(current_setting('role',true),'none'),session_user::text);
 IF invoker NOT IN ('dyna_app',current_user::text) THEN
  RAISE EXCEPTION 'Purchase source admission requires application or migration owner' USING ERRCODE='42501';
 END IF;
 scope:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF scope IS NULL THEN
  IF invoker='dyna_app' THEN RAISE EXCEPTION 'Purchase source requires own tenant scope' USING ERRCODE='42501';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('purchasing.source:global',0));
 ELSE
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('purchasing.source:global',0));
  PERFORM pg_advisory_xact_lock(hashtextextended('purchasing.source:'||scope::text,0));
 END IF;
END $$;
CREATE FUNCTION purchasing_source_version() RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE scope uuid; invoker text; result bigint; BEGIN
 invoker:=coalesce(nullif(current_setting('role',true),'none'),session_user::text);
 IF invoker NOT IN ('dyna_app',current_user::text) THEN RAISE EXCEPTION 'Purchase source reader is not authorized' USING ERRCODE='42501';END IF;
 scope:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF scope IS NULL THEN RAISE EXCEPTION 'Purchase source version requires own tenant scope' USING ERRCODE='42501';END IF;
 SELECT coalesce((SELECT version FROM public.purchasing_source_versions WHERE tenant_id=scope),0)
  +coalesce((SELECT max(id) FROM public.purchasing_stock_changes WHERE tenant_id=scope),0) INTO result;
 RETURN result;
END $$;
CREATE FUNCTION purchasing_stock_admit() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE scope uuid;invoker text;BEGIN
 invoker:=coalesce(nullif(current_setting('role',true),'none'),session_user::text);
 IF invoker NOT IN ('dyna_app',current_user::text) THEN RAISE EXCEPTION 'Stock source admission is not authorized' USING ERRCODE='42501';END IF;
 scope:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF scope IS NULL THEN
  IF invoker='dyna_app' THEN RAISE EXCEPTION 'Stock source requires own tenant scope' USING ERRCODE='42501';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('purchasing.source:global',0));
 ELSE
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('purchasing.source:global',0));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('purchasing.source:'||scope::text,0));
 END IF;
END $$;
REVOKE ALL ON FUNCTION purchasing_source_admit(),purchasing_stock_admit(),purchasing_source_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purchasing_source_admit(),purchasing_stock_admit(),purchasing_source_version() TO dyna_app;

CREATE FUNCTION purchasing_source_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Purchase source truncation is not supported' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='stock' THEN PERFORM public.purchasing_stock_admit();
 ELSE PERFORM public.purchasing_source_admit();END IF;RETURN NULL;
END $$;
CREATE FUNCTION purchasing_source_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE scope uuid; t uuid; query text; new_order_ids uuid[]; BEGIN
 scope:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 query:=CASE TG_OP
  WHEN 'INSERT' THEN 'SELECT DISTINCT tenant_id FROM purchasing_new_rows ORDER BY tenant_id'
  WHEN 'DELETE' THEN 'SELECT DISTINCT tenant_id FROM purchasing_old_rows ORDER BY tenant_id'
  ELSE 'SELECT tenant_id FROM purchasing_new_rows UNION SELECT tenant_id FROM purchasing_old_rows ORDER BY tenant_id' END;
 FOR t IN EXECUTE query LOOP
  IF scope IS NOT NULL AND t IS DISTINCT FROM scope THEN
   RAISE EXCEPTION 'Purchase source statement crosses declared tenant scope' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME='stock' THEN
   INSERT INTO public.purchasing_stock_changes(tenant_id) VALUES(t);
  ELSIF TG_TABLE_NAME='purchase_orders' AND TG_OP='INSERT' THEN
   SELECT array_agg(id ORDER BY id) INTO new_order_ids FROM purchasing_new_rows WHERE tenant_id=t;
   INSERT INTO public.purchasing_source_versions(tenant_id,version,created_transaction,created_order_ids)
    VALUES(t,1,pg_current_xact_id(),new_order_ids)
    ON CONFLICT(tenant_id) DO UPDATE SET version=purchasing_source_versions.version+1,
     created_transaction=excluded.created_transaction,
     created_order_ids=CASE WHEN purchasing_source_versions.created_transaction=excluded.created_transaction
      THEN purchasing_source_versions.created_order_ids||excluded.created_order_ids ELSE excluded.created_order_ids END;
  ELSE
   INSERT INTO public.purchasing_source_versions(tenant_id,version) VALUES(t,1)
    ON CONFLICT(tenant_id) DO UPDATE SET version=purchasing_source_versions.version+1;
  END IF;
 END LOOP;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION purchasing_source_before(),purchasing_source_changed() FROM PUBLIC,dyna_app;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['purchase_orders','purchase_order_lines','purchase_receipts','purchase_receipt_lines',
 'b2b_network_orders','b2b_network_order_lines','b2b_network_receipts','b2b_network_receipt_lines','stock'] LOOP
  EXECUTE format('CREATE TRIGGER purchasing_source_admission BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION purchasing_source_before()',t);
  EXECUTE format('CREATE TRIGGER purchasing_source_insert AFTER INSERT ON public.%I REFERENCING NEW TABLE AS purchasing_new_rows FOR EACH STATEMENT EXECUTE FUNCTION purchasing_source_changed()',t);
  EXECUTE format('CREATE TRIGGER purchasing_source_update AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS purchasing_old_rows NEW TABLE AS purchasing_new_rows FOR EACH STATEMENT EXECUTE FUNCTION purchasing_source_changed()',t);
  EXECUTE format('CREATE TRIGGER purchasing_source_delete AFTER DELETE ON public.%I REFERENCING OLD TABLE AS purchasing_old_rows FOR EACH STATEMENT EXECUTE FUNCTION purchasing_source_changed()',t);
 END LOOP;
END $$;
