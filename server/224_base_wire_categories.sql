-- Successor to223, registered in db.ts migrate() after223 (23.10.2026).
-- Numeric Base API identities (Base category_id) of the native PIM categories
-- (pim_dictionary_categories: UUID per catalog; a rename or a move keeps the UUID).
-- Read-only variant: nothing is attached to any PIM table. A foreign key to
-- pim_dictionary_categories would change the catalogues pinned by the ordinary,
-- large-import and PIM validators, so the sidecar references only product_catalogs
-- and reads the PIM rows through the owner functions below. New categories get
-- their ID from base_wire224_allocate_categories() in a short writing transaction
-- before a Base read; an ID is never reused or renumbered.
DO $dependency224$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.return_reasons223') IS NULL
 OR to_regclass('public.base_wire220_catalog_ids') IS NULL
 OR to_regclass('public.pim_dictionary_categories') IS NULL
 OR to_regclass('public.pim_dictionary_product_states') IS NULL
 THEN RAISE EXCEPTION 'Base wire categories require owner-installed223' USING ERRCODE='55000';END IF;
END
$dependency224$;

CREATE TABLE public.base_wire224_category_ids (
 tenant_id uuid NOT NULL,
 catalog_id uuid NOT NULL,
 category_id uuid NOT NULL,
 public_id bigint GENERATED ALWAYS AS IDENTITY (MAXVALUE 9007199254740991),
 PRIMARY KEY(tenant_id,catalog_id,category_id),
 UNIQUE(public_id),
 UNIQUE(tenant_id,public_id),
 CHECK(public_id BETWEEN 1 AND 9007199254740991),
 FOREIGN KEY(tenant_id,catalog_id) REFERENCES public.product_catalogs(tenant_id,id)
);
-- Never ON CONFLICT: a collision must fail. Parents are not ordered before children
-- (the PIM keeps no creation time); the order is only deterministic.
INSERT INTO public.base_wire224_category_ids(tenant_id,catalog_id,category_id)
 SELECT tenant_id,catalog_id,id FROM public.pim_dictionary_categories ORDER BY tenant_id,catalog_id,id;

DO $table224$
BEGIN
 ALTER TABLE public.base_wire224_category_ids ENABLE ROW LEVEL SECURITY;
 ALTER TABLE public.base_wire224_category_ids FORCE ROW LEVEL SECURITY;
 CREATE POLICY tenant_scope ON public.base_wire224_category_ids TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
 REVOKE ALL ON public.base_wire224_category_ids FROM PUBLIC,dyna_app;
 GRANT SELECT ON public.base_wire224_category_ids TO dyna_app;
 REVOKE ALL ON SEQUENCE public.base_wire224_category_ids_public_id_seq FROM PUBLIC,dyna_app;
END
$table224$;

-- An identity once given to a Base client never changes meaning: no update,
-- delete or truncate, also for the owner.
CREATE FUNCTION public.base_wire224_identity_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard224$
BEGIN
 RAISE EXCEPTION 'Base wire category identity is immutable' USING ERRCODE='55000';
END
$guard224$;
REVOKE ALL ON FUNCTION public.base_wire224_identity_guard() FROM PUBLIC,dyna_app;
CREATE TRIGGER base_wire224_category_ids_immutable BEFORE UPDATE OR DELETE ON public.base_wire224_category_ids FOR EACH ROW EXECUTE FUNCTION public.base_wire224_identity_guard();
CREATE TRIGGER base_wire224_category_ids_no_truncate BEFORE TRUNCATE ON public.base_wire224_category_ids FOR EACH STATEMENT EXECUTE FUNCTION public.base_wire224_identity_guard();

-- Current tenant only; requires a writable transaction. Categories committed
-- after this call get their ID at the next call.
CREATE FUNCTION public.base_wire224_allocate_categories() RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $allocate224$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'Invalid Base wire category allocation' USING ERRCODE='55000';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('base_wire224:category:'||t::text,0));
 INSERT INTO public.base_wire224_category_ids(tenant_id,catalog_id,category_id)
  SELECT c.tenant_id,c.catalog_id,c.id FROM public.pim_dictionary_categories c WHERE c.tenant_id=t
  AND NOT EXISTS(SELECT 1 FROM public.base_wire224_category_ids s WHERE (s.tenant_id,s.catalog_id,s.category_id)=(t,c.catalog_id,c.id))
  ORDER BY c.catalog_id,c.id;
END
$allocate224$;
REVOKE ALL ON FUNCTION public.base_wire224_allocate_categories() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.base_wire224_allocate_categories() TO dyna_app;

-- The current tenant's categories of one catalog that already have an ID, with the
-- parent's ID (NULL for a root or a parent without an ID yet) and the current name.
CREATE FUNCTION public.base_wire224_categories(cid uuid)
 RETURNS TABLE(public_id bigint,category_id uuid,parent_id uuid,parent_public_id bigint,name text,active boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $categories224$
 SELECT s.public_id,c.id,c.parent_id,ps.public_id,c.name,c.active
 FROM public.pim_dictionary_categories c
 JOIN public.base_wire224_category_ids s ON(s.tenant_id,s.catalog_id,s.category_id)=(c.tenant_id,c.catalog_id,c.id)
 LEFT JOIN public.base_wire224_category_ids ps ON(ps.tenant_id,ps.catalog_id,ps.category_id)=(c.tenant_id,c.catalog_id,c.parent_id)
 WHERE c.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND c.catalog_id=cid
 ORDER BY s.public_id
$categories224$;
REVOKE ALL ON FUNCTION public.base_wire224_categories(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.base_wire224_categories(uuid) TO dyna_app;

-- The current native category (pim_dictionary_product_states.category_id) of the
-- current tenant's products in one catalog, for categories that have an ID.
CREATE FUNCTION public.base_wire224_product_categories(cid uuid)
 RETURNS TABLE(product_id uuid,category_public_id bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $products224$
 SELECT p.product_id,s.public_id
 FROM public.pim_dictionary_product_states p
 JOIN public.base_wire224_category_ids s ON(s.tenant_id,s.catalog_id,s.category_id)=(p.tenant_id,p.catalog_id,p.category_id)
 WHERE p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND p.catalog_id=cid
$products224$;
REVOKE ALL ON FUNCTION public.base_wire224_product_categories(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.base_wire224_product_categories(uuid) TO dyna_app;
