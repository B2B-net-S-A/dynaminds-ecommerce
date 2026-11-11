-- Successor to224, registered in db.ts migrate() after224 (23.10.2026).
-- Native "deleted" state of a product (variant A of the product deletion gap).
-- A real DELETE FROM products is impossible: the immutable SKU alias of every
-- product (product_sku_aliases) keeps a historic SKU from ever being given to
-- another product, and orders, documents and stock history reference the row.
-- A deleted product therefore keeps its row with active=false (set by the native
-- editor) and gets one row here; ordinary reads hide it, history keeps it.
-- Only this own table is added: no trigger, column or constraint is attached to
-- products or any other core table except the internal referential triggers of
-- the foreign key below.
DO $dependency225$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.base_wire224_category_ids') IS NULL
 OR to_regclass('public.products') IS NULL
 THEN RAISE EXCEPTION 'Product deletions require owner-installed224' USING ERRCODE='55000';END IF;
END
$dependency225$;

-- One row per deleted product; a deletion is permanent (no restore).
CREATE TABLE public.product_deletions225 (
 tenant_id uuid NOT NULL,
 product_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 api_key_id uuid,
 reason text CHECK(reason IS NULL OR (char_length(reason) BETWEEN 1 AND 500 AND reason=btrim(reason))),
 product_version integer NOT NULL CHECK(product_version>0),
 deleted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,product_id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES public.products(tenant_id,id)
);

DO $table225$
BEGIN
 ALTER TABLE public.product_deletions225 ENABLE ROW LEVEL SECURITY;
 ALTER TABLE public.product_deletions225 FORCE ROW LEVEL SECURITY;
 CREATE POLICY tenant_scope ON public.product_deletions225 TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
 REVOKE ALL ON public.product_deletions225 FROM PUBLIC,dyna_app;
 GRANT SELECT,INSERT ON public.product_deletions225 TO dyna_app;
END
$table225$;

-- Append-only: no update, delete or truncate, also for the owner.
CREATE FUNCTION public.product_deletions225_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard225$
BEGIN
 RAISE EXCEPTION 'Product deletion is permanent' USING ERRCODE='55000';
END
$guard225$;
REVOKE ALL ON FUNCTION public.product_deletions225_guard() FROM PUBLIC,dyna_app;
CREATE TRIGGER product_deletions225_append_only BEFORE UPDATE OR DELETE ON public.product_deletions225 FOR EACH ROW EXECUTE FUNCTION public.product_deletions225_guard();
CREATE TRIGGER product_deletions225_no_truncate BEFORE TRUNCATE ON public.product_deletions225 FOR EACH STATEMENT EXECUTE FUNCTION public.product_deletions225_guard();
