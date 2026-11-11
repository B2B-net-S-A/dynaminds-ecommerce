-- Additive export configuration. No profile/product/history row rewrite.
-- Same validator OID/ACL keeps existing CHECK bindings and legacy definitions.
CREATE OR REPLACE FUNCTION catalog_export_profile_definition_valid(d jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE k text;v jsonb;effective text;names text[]:=ARRAY[]::text[];chosen text[];source_field text;source_ids jsonb;
BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF NOT d ?& ARRAY['format','columns','headers','spreadsheet_safe']
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(d)x WHERE x NOT IN('format','columns','headers','spreadsheet_safe','warehouse_ids','price_list_ids','catalog_id'))
 OR jsonb_typeof(d->'format') IS DISTINCT FROM 'string' OR d->>'format' NOT IN('csv','xml')
 OR jsonb_typeof(d->'spreadsheet_safe') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(d->'columns') IS DISTINCT FROM 'array' OR jsonb_typeof(d->'headers') IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF d ? 'catalog_id' THEN
  IF jsonb_typeof(d->'catalog_id') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
  effective:=d->>'catalog_id';
  IF effective NOT IN('00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff') AND effective !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false;END IF;
 END IF;
 IF jsonb_array_length(d->'columns')<1 OR jsonb_array_length(d->'columns')>22 THEN RETURN false;END IF;
 chosen:=ARRAY(SELECT jsonb_array_elements_text(d->'columns'));
 IF cardinality(chosen)<>(SELECT count(DISTINCT x) FROM unnest(chosen)x) THEN RETURN false;END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(d->'columns') LOOP
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR NOT(v#>>'{}')=ANY(ARRAY['id','sku','ean','name','description','price_minor','vat_rate','category','active','kind','weight_g','length_mm','width_mm','height_mm','manufacturer','attributes_json','images_json','variants_json','bundle_components_json','translations_json','inventory_json','prices_json']) THEN RETURN false;END IF;
 END LOOP;
 FOR k,v IN SELECT key,value FROM jsonb_each(d->'headers') LOOP
  IF NOT k=ANY(chosen) OR jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN false;END IF;
  effective:=v#>>'{}';
  IF char_length(effective)<1 OR char_length(effective)>80 OR effective<>btrim(effective) OR effective ~ '[[:cntrl:]]' OR effective ~ ('['||chr(127)||'-'||chr(159)||']') OR position(chr(65534) IN effective)>0 OR position(chr(65535) IN effective)>0 THEN RETURN false;END IF;
 END LOOP;
 FOREACH k IN ARRAY chosen LOOP
  effective:=coalesce(d->'headers'->>k,k);
  IF lower(effective)=ANY(names) THEN RETURN false;END IF;
  IF d->>'format'='xml' AND(effective !~ '^[A-Za-z_][A-Za-z0-9_.-]*$' OR lower(effective) LIKE 'xml%') THEN RETURN false;END IF;
  names:=array_append(names,lower(effective));
 END LOOP;
 FOREACH k IN ARRAY ARRAY['warehouse_ids','price_list_ids'] LOOP
  source_field:=CASE k WHEN 'warehouse_ids' THEN 'inventory_json' ELSE 'prices_json' END;
  IF NOT d ? k THEN IF source_field=ANY(chosen) THEN RETURN false;END IF;CONTINUE;END IF;
  IF NOT source_field=ANY(chosen) THEN RETURN false;END IF;
  source_ids:=d->k;
  IF jsonb_typeof(source_ids) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(source_ids)<1 OR jsonb_array_length(source_ids)>10 OR jsonb_array_length(source_ids)<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(source_ids)) THEN RETURN false;END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(source_ids) LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN false;END IF;
   effective:=v#>>'{}';
   IF effective NOT IN('00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff') AND effective !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false;END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;

CREATE FUNCTION catalog_export_catalogs_installed() RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
CREATE FUNCTION catalog_export_catalogs_guards() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF to_regprocedure('public.product_catalog_guards()') IS NULL OR to_regclass('public.catalog_export_profiles') IS NULL
 OR to_regprocedure('public.catalog_export_catalogs_installed()') IS NULL OR to_regprocedure('public.catalog_export_catalogs_profile_guard()') IS NULL
 OR to_regprocedure('public.catalog_export_profile_definition_valid(jsonb)') IS NULL THEN RETURN false;END IF;
 IF NOT public.product_catalog_guards() THEN RETURN false;END IF;
 IF NOT public.catalog_export_profile_definition_valid('{"format":"csv","columns":["sku"],"headers":{},"spreadsheet_safe":true,"catalog_id":"00000000-0000-0000-0000-000000000000"}'::jsonb) THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.catalog_export_profiles'::regclass AND tgname='catalog_export_catalogs_profile_guard' AND tgenabled='O' AND NOT tgisinternal AND tgfoid='public.catalog_export_catalogs_profile_guard()'::regprocedure) THEN RETURN false;END IF;
 RETURN true;
END $$;
CREATE FUNCTION catalog_export_catalogs_profile_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE catalog jsonb;source_id text;kind text;
BEGIN
 IF TG_OP='UPDATE' THEN IF NEW.definition IS NOT DISTINCT FROM OLD.definition THEN RETURN NEW;END IF;END IF;
 IF NOT NEW.definition ? 'catalog_id' THEN RETURN NEW;END IF;
 IF NOT public.catalog_export_catalogs_guards() THEN RAISE EXCEPTION 'Niekompletny zakres katalogów eksportu' USING ERRCODE='55000';END IF;
 IF public.catalog_export_profile_definition_valid(NEW.definition) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Niepoprawna definicja katalogu eksportu' USING ERRCODE='23514';END IF;
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Obcy katalog eksportu' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog:'||NEW.tenant_id::text,0));
 catalog:=public.product_catalog_resolve((NEW.definition->>'catalog_id')::uuid);
 IF catalog->'active' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Katalog eksportu jest nieaktywny' USING ERRCODE='23514';END IF;
 FOREACH kind IN ARRAY ARRAY['warehouse','price_list'] LOOP
  FOR source_id IN SELECT jsonb_array_elements_text(coalesce(NEW.definition->(CASE kind WHEN 'warehouse' THEN 'warehouse_ids' ELSE 'price_list_ids' END),'[]'::jsonb)) LOOP
   PERFORM public.product_catalog_assert_resource((catalog->>'id')::uuid,kind,source_id);
  END LOOP;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_export_catalogs_profile_guard BEFORE INSERT OR UPDATE ON catalog_export_profiles FOR EACH ROW EXECUTE FUNCTION catalog_export_catalogs_profile_guard();
REVOKE ALL ON FUNCTION catalog_export_catalogs_installed(),catalog_export_catalogs_guards(),catalog_export_catalogs_profile_guard() FROM PUBLIC,dyna_app;
GRANT EXECUTE ON FUNCTION catalog_export_catalogs_installed(),catalog_export_catalogs_guards() TO dyna_app;
