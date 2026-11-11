-- Successor to221, registered in db.ts migrate() after221 (23.10.2026).
-- Native order split (one child order per execution): validated preview, then one
-- execution transaction that moves the selected line quantities, pick quantities,
-- reservations and reservation locations from the parent to a new child order.
-- Only these own evidence tables are added. No trigger, column or constraint is
-- attached to orders, order_items, order_pick_items, reservations,
-- reservation_locations or stock (earlier validators pin their user triggers), and
-- there is no foreign key to any core table. The immutability guards below are
-- attached only to the three own tables.
DO $dependency222$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.base_wire220_order_ids') IS NULL
 OR to_regprocedure('public.base_wire220_allocate_pending(text)') IS NULL
 OR to_regclass('public.base_wire221_journal_ids') IS NULL
 THEN RAISE EXCEPTION 'Order split requires owner-installed221' USING ERRCODE='55000';END IF;
END
$dependency222$;

-- One validated plan: parent snapshot (header, lines, picks, reservations,
-- locations) and the exact parent/child line quantities and totals in grosze.
CREATE TABLE public.order_split222_previews (
 id uuid NOT NULL,
 tenant_id uuid NOT NULL,
 parent_order_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 api_key_id uuid,
 source text NOT NULL CHECK(source IN('manual','api')),
 client_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),
 parent_total_before integer NOT NULL CHECK(parent_total_before>=0),
 parent_total_after integer NOT NULL CHECK(parent_total_after>=0),
 child_total integer NOT NULL CHECK(child_total>=0),
 child_shipping_cost integer NOT NULL CHECK(child_shipping_cost>=0),
 moved_lines integer NOT NULL CHECK(moved_lines BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(id),
 UNIQUE(tenant_id,client_key),
 CHECK((source='api')=(api_key_id IS NOT NULL)),
 CHECK(parent_total_after::bigint+child_total::bigint=parent_total_before::bigint),
 CHECK(expires_at>created_at)
);
CREATE INDEX order_split222_previews_parent ON public.order_split222_previews(tenant_id,parent_order_id);

-- Committed split: exactly one per preview; the child is a new native order.
CREATE TABLE public.order_split222_executions (
 id uuid NOT NULL,
 tenant_id uuid NOT NULL,
 preview_id uuid NOT NULL,
 parent_order_id uuid NOT NULL,
 child_order_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 api_key_id uuid,
 source text NOT NULL CHECK(source IN('manual','api')),
 client_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 before_snapshot jsonb NOT NULL CHECK(jsonb_typeof(before_snapshot)='object'),
 after_snapshot jsonb NOT NULL CHECK(jsonb_typeof(after_snapshot)='object'),
 parent_total_before integer NOT NULL CHECK(parent_total_before>=0),
 parent_total_after integer NOT NULL CHECK(parent_total_after>=0),
 child_total integer NOT NULL CHECK(child_total>=0),
 child_shipping_cost integer NOT NULL CHECK(child_shipping_cost>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(id),
 UNIQUE(tenant_id,client_key),
 UNIQUE(tenant_id,preview_id),
 UNIQUE(tenant_id,child_order_id),
 CHECK(child_order_id<>parent_order_id),
 CHECK((source='api')=(api_key_id IS NOT NULL)),
 CHECK(parent_total_after::bigint+child_total::bigint=parent_total_before::bigint),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES public.order_split222_previews(tenant_id,id)
);
CREATE INDEX order_split222_executions_parent ON public.order_split222_executions(tenant_id,parent_order_id);

-- Line lineage: parent item -> child item with the moved quantity and value.
CREATE TABLE public.order_split222_targets (
 tenant_id uuid NOT NULL,
 execution_id uuid NOT NULL,
 index integer NOT NULL CHECK(index BETWEEN 0 AND 99),
 source_item_id uuid NOT NULL,
 target_item_id uuid NOT NULL,
 product_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity>0),
 line_total integer NOT NULL CHECK(line_total>=0),
 parent_quantity_after integer NOT NULL CHECK(parent_quantity_after>=0),
 parent_line_total_after integer NOT NULL CHECK(parent_line_total_after>=0),
 PRIMARY KEY(tenant_id,execution_id,index),
 UNIQUE(tenant_id,target_item_id),
 UNIQUE(tenant_id,execution_id,source_item_id),
 CHECK(target_item_id<>source_item_id),
 CHECK(parent_quantity_after>0 OR parent_line_total_after=0),
 FOREIGN KEY(tenant_id,execution_id) REFERENCES public.order_split222_executions(tenant_id,id)
);

DO $tables222$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['order_split222_previews','order_split222_executions','order_split222_targets'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON public.%I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',t);
  EXECUTE format('GRANT SELECT,INSERT ON public.%I TO dyna_app',t);
 END LOOP;
END
$tables222$;

-- Split evidence is append-only: no update, delete or truncate.
CREATE FUNCTION public.order_split222_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $immutable222$
BEGIN
 RAISE EXCEPTION 'Order split evidence is immutable' USING ERRCODE='55000';
END
$immutable222$;
REVOKE ALL ON FUNCTION public.order_split222_immutable() FROM PUBLIC,dyna_app;

DO $triggers222$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['order_split222_previews','order_split222_executions','order_split222_targets'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.order_split222_immutable()',t||'_immutable',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.order_split222_immutable()',t||'_no_truncate',t);
 END LOOP;
END
$triggers222$;
