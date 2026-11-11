CREATE TABLE product_logistics (
 tenant_id uuid NOT NULL,product_id uuid NOT NULL,
 weight_grams integer CHECK(weight_grams BETWEEN 1 AND 100000000),
 length_mm integer CHECK(length_mm BETWEEN 1 AND 100000),
 width_mm integer CHECK(width_mm BETWEEN 1 AND 100000),
 height_mm integer CHECK(height_mm BETWEEN 1 AND 100000),
 manufacturer text CHECK(manufacturer IS NULL OR (char_length(manufacturer) BETWEEN 1 AND 200 AND manufacturer=btrim(manufacturer))),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,product_id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
ALTER TABLE product_logistics ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_logistics FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON product_logistics TO dyna_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE,DELETE ON product_logistics TO dyna_app;
CREATE FUNCTION product_logistics_current_role(p_user uuid) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE r text;BEGIN
 SELECT role INTO r FROM public.memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user FOR SHARE;
 RETURN r;END $$;
REVOKE ALL ON FUNCTION product_logistics_current_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION product_logistics_current_role(uuid) TO dyna_app;
-- Existing nine-field evidence is retained byte-for-byte; only future rows may include five additional fields.
ALTER TABLE catalog_bulk_edit_rows DROP CONSTRAINT catalog_bulk_edit_rows_changed_fields_check;
ALTER TABLE catalog_bulk_edit_rows ADD CONSTRAINT catalog_bulk_edit_rows_changed_fields_check CHECK(jsonb_typeof(changed_fields)='array' AND jsonb_array_length(changed_fields)<=14);
ALTER TABLE catalog_bulk_edit_execution_rows DROP CONSTRAINT catalog_bulk_edit_execution_rows_changed_fields_check;
ALTER TABLE catalog_bulk_edit_execution_rows ADD CONSTRAINT catalog_bulk_edit_execution_rows_changed_fields_check CHECK(jsonb_typeof(changed_fields)='array' AND jsonb_array_length(changed_fields)<=14);
