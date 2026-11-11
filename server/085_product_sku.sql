CREATE TABLE product_sku_aliases (
 tenant_id uuid NOT NULL,sku text NOT NULL,product_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,sku),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE INDEX product_sku_aliases_product ON product_sku_aliases(tenant_id,product_id,sku);
INSERT INTO product_sku_aliases(tenant_id,sku,product_id) SELECT tenant_id,sku,id FROM products;
ALTER TABLE product_sku_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_sku_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON product_sku_aliases TO dyna_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT ON product_sku_aliases TO dyna_app;
CREATE FUNCTION product_sku_alias_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 RAISE EXCEPTION 'Product SKU aliases are immutable';
END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON product_sku_aliases
 FOR EACH ROW EXECUTE FUNCTION product_sku_alias_immutable();
-- Trigger-only core also supports owner migrations/seeds without an app tenant setting.
CREATE FUNCTION product_sku_claim_core(p_tenant uuid,p_product uuid,p_sku text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE claimed uuid;BEGIN
 INSERT INTO public.product_sku_aliases(tenant_id,sku,product_id)
 VALUES(p_tenant,p_sku,p_product) ON CONFLICT(tenant_id,sku) DO NOTHING;
 SELECT product_id INTO claimed FROM public.product_sku_aliases WHERE tenant_id=p_tenant AND sku=p_sku;
 IF claimed IS DISTINCT FROM p_product THEN
  RAISE EXCEPTION 'SKU is reserved for another product' USING ERRCODE='23505',CONSTRAINT='product_sku_aliases_pkey';
 END IF;
END $$;
REVOKE ALL ON FUNCTION product_sku_claim_core(uuid,uuid,text) FROM PUBLIC;
-- Bulk preclaims wait on every alias before the service's final membership/key pin.
CREATE FUNCTION product_sku_reserve(p_product uuid,p_sku text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE tenant uuid;BEGIN
 tenant:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF tenant IS NULL OR NOT EXISTS(SELECT 1 FROM public.products WHERE tenant_id=tenant AND id=p_product) THEN
  RAISE EXCEPTION 'SKU reservation requires an own existing product' USING ERRCODE='42501';
 END IF;
 IF p_sku IS NULL OR char_length(p_sku)<1 OR char_length(p_sku)>80 OR p_sku<>btrim(p_sku) THEN
  RAISE EXCEPTION 'Invalid SKU reservation' USING ERRCODE='23514';
 END IF;
 PERFORM public.product_sku_claim_core(tenant,p_product,p_sku);
END $$;
REVOKE ALL ON FUNCTION product_sku_reserve(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION product_sku_reserve(uuid,text) TO dyna_app;
-- The row owner claims new codes atomically; no caller can grant a different product a historic SKU.
CREATE FUNCTION product_sku_claim() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF current_setting('role',true)='dyna_app' AND NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'SKU claim requires the current tenant' USING ERRCODE='42501';
 END IF;
 PERFORM public.product_sku_claim_core(NEW.tenant_id,NEW.id,NEW.sku);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION product_sku_claim() FROM PUBLIC;
CREATE TRIGGER product_sku_claim AFTER INSERT OR UPDATE OF sku ON products
 FOR EACH ROW EXECUTE FUNCTION product_sku_claim();
ALTER TABLE catalog_bulk_edit_rows DROP CONSTRAINT catalog_bulk_edit_rows_changed_fields_check;
ALTER TABLE catalog_bulk_edit_rows ADD CONSTRAINT catalog_bulk_edit_rows_changed_fields_check
 CHECK(jsonb_typeof(changed_fields)='array' AND jsonb_array_length(changed_fields)<=15);
ALTER TABLE catalog_bulk_edit_execution_rows DROP CONSTRAINT catalog_bulk_edit_execution_rows_changed_fields_check;
ALTER TABLE catalog_bulk_edit_execution_rows ADD CONSTRAINT catalog_bulk_edit_execution_rows_changed_fields_check
 CHECK(jsonb_typeof(changed_fields)='array' AND jsonb_array_length(changed_fields)<=15);
