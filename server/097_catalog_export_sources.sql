-- Additive source configuration only. Existing profile rows and immutable create
-- receipts are not rewritten; CREATE OR REPLACE keeps their validator binding.
CREATE OR REPLACE FUNCTION catalog_export_profile_definition_valid(d jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE
 k text; v jsonb; effective text; names text[]:=ARRAY[]::text[]; chosen text[];
 source_field text; source_ids jsonb;
BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF NOT d ?& ARRAY['format','columns','headers','spreadsheet_safe']
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(d) x WHERE x NOT IN ('format','columns','headers','spreadsheet_safe','warehouse_ids','price_list_ids'))
 OR jsonb_typeof(d->'format') IS DISTINCT FROM 'string' OR d->>'format' NOT IN ('csv','xml')
 OR jsonb_typeof(d->'spreadsheet_safe') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(d->'columns') IS DISTINCT FROM 'array'
 OR jsonb_typeof(d->'headers') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF jsonb_array_length(d->'columns')<1 OR jsonb_array_length(d->'columns')>22 THEN RETURN false; END IF;
 chosen:=ARRAY(SELECT jsonb_array_elements_text(d->'columns'));
 IF cardinality(chosen)<>(SELECT count(DISTINCT x) FROM unnest(chosen) x) THEN RETURN false; END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(d->'columns') LOOP
  IF jsonb_typeof(v) IS DISTINCT FROM 'string'
  OR NOT (v#>>'{}')=ANY(ARRAY['id','sku','ean','name','description','price_minor','vat_rate','category','active','kind','weight_g','length_mm','width_mm','height_mm','manufacturer','attributes_json','images_json','variants_json','bundle_components_json','translations_json','inventory_json','prices_json']) THEN RETURN false; END IF;
 END LOOP;
 FOR k,v IN SELECT key,value FROM jsonb_each(d->'headers') LOOP
  IF NOT k=ANY(chosen) OR jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  effective:=v#>>'{}';
  IF char_length(effective)<1 OR char_length(effective)>80 OR effective<>btrim(effective)
  OR effective ~ '[[:cntrl:]]' OR effective ~ ('['||chr(127)||'-'||chr(159)||']')
  OR position(chr(65534) IN effective)>0 OR position(chr(65535) IN effective)>0 THEN RETURN false; END IF;
 END LOOP;
 FOREACH k IN ARRAY chosen LOOP
  effective:=coalesce(d->'headers'->>k,k);
  IF lower(effective)=ANY(names) THEN RETURN false; END IF;
  IF d->>'format'='xml' AND (effective !~ '^[A-Za-z_][A-Za-z0-9_.-]*$' OR lower(effective) LIKE 'xml%') THEN RETURN false; END IF;
  names:=array_append(names,lower(effective));
 END LOOP;
 FOREACH k IN ARRAY ARRAY['warehouse_ids','price_list_ids'] LOOP
  source_field:=CASE k WHEN 'warehouse_ids' THEN 'inventory_json' ELSE 'prices_json' END;
  -- Both directions are explicit: no silent all-warehouses/all-price-lists scope.
  IF NOT d ? k THEN
   IF source_field=ANY(chosen) THEN RETURN false; END IF;
   CONTINUE;
  END IF;
  IF NOT source_field=ANY(chosen) THEN RETURN false; END IF;
  source_ids:=d->k;
  IF jsonb_typeof(source_ids) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(source_ids)<1 OR jsonb_array_length(source_ids)>10 THEN RETURN false; END IF;
  IF jsonb_array_length(source_ids)<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(source_ids)) THEN RETURN false; END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(source_ids) LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
   effective:=v#>>'{}';
   -- Canonical lowercase RFC UUID strings, including the nil/max UUIDs also
   -- accepted by the shared UUID input schema. Ownership is checked by service.
   IF effective NOT IN ('00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff')
   AND effective !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;
