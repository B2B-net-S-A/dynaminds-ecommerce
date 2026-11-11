-- Successor to219, registered in db.ts migrate() after219 (23.10.2026).
-- Numeric Base API identities for the non-CRM families, as sidecars of the
-- existing native rows. Every namespace is separate (warehouse 1 and product 1
-- are different resources); variants and bundles are products rows. Existing
-- table definitions stay untouched. Earlier validators pin the user triggers of
-- orders, documents and local_invoice_series, so those three namespaces are
-- allocated by base_wire220_allocate_pending() inside the Base API transaction;
-- the others get AFTER INSERT allocation triggers. Only the sidecar FKs'
-- internal referential triggers are attached to the pinned tables.
DO $dependency220$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.base_wire219_group_ids') IS NULL
 THEN RAISE EXCEPTION 'Base wire identities require owner-installed219' USING ERRCODE='55000';END IF;
END
$dependency220$;

-- sidecar, native parent, backfill order. Invoices are documents of kind
-- invoice/correction only; proformas keep no Base invoice identity.
DO $sidecars220$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('base_wire220_warehouse_ids','warehouses','tenant_id,id',NULL),
  ('base_wire220_catalog_ids','product_catalogs','tenant_id,created_at,id',NULL),
  ('base_wire220_product_ids','products','tenant_id,created_at,id',NULL),
  ('base_wire220_price_group_ids','price_lists','tenant_id,created_at,id',NULL),
  ('base_wire220_order_status_ids','workflow_statuses','tenant_id,created_at,id',NULL),
  ('base_wire220_order_ids','orders','tenant_id,created_at,id',NULL),
  ('base_wire220_package_ids','shipments','tenant_id,created_at,id',NULL),
  ('base_wire220_invoice_ids','documents','tenant_id,created_at,id','kind IN(''invoice'',''correction'')'),
  ('base_wire220_invoice_series_ids','local_invoice_series','tenant_id,created_at,id',NULL)
 ) v(sidecar,parent,ordering,filter) LOOP
  EXECUTE format('CREATE TABLE public.%I (
 tenant_id uuid NOT NULL,
 resource_id uuid NOT NULL,
 local_id uuid,
 public_id bigint GENERATED ALWAYS AS IDENTITY (MAXVALUE 9007199254740991),
 PRIMARY KEY(tenant_id,resource_id),
 UNIQUE(public_id),
 UNIQUE(tenant_id,public_id),
 CHECK(public_id BETWEEN 1 AND 9007199254740991),
 CHECK(local_id IS NULL OR local_id=resource_id),
 FOREIGN KEY(tenant_id,local_id) REFERENCES public.%I(tenant_id,id) ON DELETE SET NULL(local_id)
)',r.sidecar,r.parent);
  EXECUTE format('CREATE INDEX %I ON public.%I(tenant_id,local_id) WHERE local_id IS NOT NULL',r.sidecar||'_live_fk',r.sidecar);
  -- Never ON CONFLICT: a collision must fail, not revive or hide a tombstone.
  EXECUTE format('INSERT INTO public.%I(tenant_id,resource_id,local_id) SELECT tenant_id,id,id FROM public.%I%s ORDER BY %s',
   r.sidecar,r.parent,coalesce(' WHERE '||r.filter,''),r.ordering);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',r.sidecar);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',r.sidecar);
  EXECUTE format('CREATE POLICY tenant_scope ON public.%I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',r.sidecar);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',r.sidecar);
  EXECUTE format('GRANT SELECT ON public.%I TO dyna_app',r.sidecar);
  EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM PUBLIC,dyna_app',r.sidecar||'_public_id_seq');
 END LOOP;
END
$sidecars220$;

-- Preserve public identity and resource UUID permanently. The only permitted
-- row update is the typed FK's live->tombstone transition after the exact parent
-- has disappeared; resurrection/rekey/delete/truncate all refuse.
CREATE FUNCTION public.base_wire220_identity_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $identity220$
DECLARE parent text:=CASE TG_TABLE_NAME
 WHEN 'base_wire220_warehouse_ids' THEN 'warehouses' WHEN 'base_wire220_catalog_ids' THEN 'product_catalogs'
 WHEN 'base_wire220_product_ids' THEN 'products' WHEN 'base_wire220_price_group_ids' THEN 'price_lists'
 WHEN 'base_wire220_order_status_ids' THEN 'workflow_statuses' WHEN 'base_wire220_order_ids' THEN 'orders'
 WHEN 'base_wire220_package_ids' THEN 'shipments' WHEN 'base_wire220_invoice_ids' THEN 'documents'
 WHEN 'base_wire220_invoice_series_ids' THEN 'local_invoice_series' END;
 present boolean;
BEGIN
 IF TG_TABLE_SCHEMA='public' AND parent IS NOT NULL AND TG_OP='UPDATE' AND TG_LEVEL='ROW' THEN
  IF (NEW.tenant_id,NEW.resource_id,NEW.public_id) IS NOT DISTINCT FROM (OLD.tenant_id,OLD.resource_id,OLD.public_id)
  AND OLD.local_id IS NOT NULL AND NEW.local_id IS NULL THEN
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE (tenant_id,id)=($1,$2))',parent) INTO present USING OLD.tenant_id,OLD.local_id;
   IF NOT present THEN RETURN NEW;END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'Base wire numeric identity is immutable' USING ERRCODE='55000';
END
$identity220$;
REVOKE ALL ON FUNCTION public.base_wire220_identity_guard() FROM PUBLIC,dyna_app;

CREATE FUNCTION public.base_wire220_allocate() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $allocate220$
BEGIN
 IF TG_TABLE_SCHEMA<>'public' OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'Invalid Base wire identity source' USING ERRCODE='55000';END IF;
 CASE TG_TABLE_NAME
  WHEN 'warehouses' THEN INSERT INTO public.base_wire220_warehouse_ids(tenant_id,resource_id,local_id) VALUES(NEW.tenant_id,NEW.id,NEW.id);
  WHEN 'product_catalogs' THEN INSERT INTO public.base_wire220_catalog_ids(tenant_id,resource_id,local_id) VALUES(NEW.tenant_id,NEW.id,NEW.id);
  WHEN 'products' THEN INSERT INTO public.base_wire220_product_ids(tenant_id,resource_id,local_id) VALUES(NEW.tenant_id,NEW.id,NEW.id);
  WHEN 'price_lists' THEN INSERT INTO public.base_wire220_price_group_ids(tenant_id,resource_id,local_id) VALUES(NEW.tenant_id,NEW.id,NEW.id);
  WHEN 'workflow_statuses' THEN INSERT INTO public.base_wire220_order_status_ids(tenant_id,resource_id,local_id) VALUES(NEW.tenant_id,NEW.id,NEW.id);
  WHEN 'shipments' THEN INSERT INTO public.base_wire220_package_ids(tenant_id,resource_id,local_id) VALUES(NEW.tenant_id,NEW.id,NEW.id);
 END CASE;
 RETURN NEW;
END
$allocate220$;
REVOKE ALL ON FUNCTION public.base_wire220_allocate() FROM PUBLIC,dyna_app;

-- Current tenant only, in native creation order, never reviving a tombstone.
-- Requires a writable transaction; returns nothing about other tenants.
CREATE FUNCTION public.base_wire220_allocate_pending(kind text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $pending220$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
 IF t IS NULL OR kind IS NULL OR kind NOT IN('order','invoice','invoice_series')
 THEN RAISE EXCEPTION 'Invalid Base wire identity allocation' USING ERRCODE='55000';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('base_wire220:'||kind||':'||t::text,0));
 IF kind='order' THEN
  INSERT INTO public.base_wire220_order_ids(tenant_id,resource_id,local_id)
   SELECT o.tenant_id,o.id,o.id FROM public.orders o WHERE o.tenant_id=t
   AND NOT EXISTS(SELECT 1 FROM public.base_wire220_order_ids s WHERE (s.tenant_id,s.resource_id)=(t,o.id)) ORDER BY o.created_at,o.id;
 ELSIF kind='invoice' THEN
  INSERT INTO public.base_wire220_invoice_ids(tenant_id,resource_id,local_id)
   SELECT d.tenant_id,d.id,d.id FROM public.documents d WHERE d.tenant_id=t AND d.kind IN('invoice','correction')
   AND NOT EXISTS(SELECT 1 FROM public.base_wire220_invoice_ids s WHERE (s.tenant_id,s.resource_id)=(t,d.id)) ORDER BY d.created_at,d.id;
 ELSE
  INSERT INTO public.base_wire220_invoice_series_ids(tenant_id,resource_id,local_id)
   SELECT l.tenant_id,l.id,l.id FROM public.local_invoice_series l WHERE l.tenant_id=t
   AND NOT EXISTS(SELECT 1 FROM public.base_wire220_invoice_series_ids s WHERE (s.tenant_id,s.resource_id)=(t,l.id)) ORDER BY l.created_at,l.id;
 END IF;
END
$pending220$;
REVOKE ALL ON FUNCTION public.base_wire220_allocate_pending(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.base_wire220_allocate_pending(text) TO dyna_app;

DO $triggers220$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('base_wire220_warehouse_ids','warehouses'),('base_wire220_catalog_ids','product_catalogs'),
  ('base_wire220_product_ids','products'),('base_wire220_price_group_ids','price_lists'),
  ('base_wire220_order_status_ids','workflow_statuses'),('base_wire220_order_ids','orders'),
  ('base_wire220_package_ids','shipments'),('base_wire220_invoice_ids','documents'),
  ('base_wire220_invoice_series_ids','local_invoice_series')
 ) v(sidecar,parent) LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.base_wire220_identity_guard()',r.sidecar||'_immutable',r.sidecar);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.base_wire220_identity_guard()',r.sidecar||'_no_truncate',r.sidecar);
  IF r.parent NOT IN('orders','documents','local_invoice_series') THEN
   EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.base_wire220_allocate()',
    left(r.sidecar,-4),r.parent);
  END IF;
 END LOOP;
END
$triggers220$;
