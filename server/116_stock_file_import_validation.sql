-- Additive capacity repair; installed115 source/evidence/history stays immutable.
-- Local maps avoid repeated whole-array scans while every source/current-fact,
-- actor/CAS, FIFO and derived-summary guard is retained. No limits/timeouts change.
CREATE OR REPLACE FUNCTION stock_file_import_validate_preview(d jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;source jsonb;r jsonb;target jsonb;raw jsonb;prod products%ROWTYPE;actual jsonb;scope jsonb;qty integer;held integer;totalqty bigint;gotqty bigint;identity text;operation text;amount text;basis jsonb;layer jsonb;fragments jsonb;need integer;free integer;take integer;lotid uuid;sumq bigint;target_map jsonb;quantity_map jsonb;stock_map jsonb;coverage_map jsonb;resolution_map jsonb;product_map jsonb;identity_map jsonb;identity_result jsonb;identity_keys text[];identity_uuid_keys uuid[];identity_kind text:=d#>>'{definition,identity}';safe boolean:=d#>>'{definition,format}'='csv' AND(d#>>'{definition,spreadsheet_safe}')::boolean;BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'rows') WITH ORDINALITY indexed_row(value,ordinal) WHERE indexed_row.value->>'index' IS DISTINCT FROM(indexed_row.ordinal-1)::text) THEN RAISE EXCEPTION 'Indeksy wierszy importu stanów są niekanoniczne' USING ERRCODE='23514';END IF;
 IF t IS NULL OR d->>'scope_hash' IS DISTINCT FROM stock_file_import_hash(d-'scope_hash') OR d->>'source_hash' IS DISTINCT FROM encode(sha256(convert_to(d#>>'{request,content}','UTF8')),'hex') OR octet_length(d::text)>33554432 OR jsonb_array_length(d->'rows') NOT BETWEEN 1 AND 4000 OR jsonb_array_length(d->'targets') NOT BETWEEN 1 AND 8 THEN RAISE EXCEPTION 'Niepoprawny pełny podgląd pomiarów' USING ERRCODE='23514';END IF;
 PERFORM stock_file_import_require((d->>'actor_id')::uuid,(d->>'api_key_id')::uuid,false);
 IF d->>'source' NOT IN('manual','api') OR d->>'request_hash' IS DISTINCT FROM stock_file_import_hash(jsonb_build_object('actor_id',d->>'actor_id','api_key_id',d->>'api_key_id','source',d->>'source','kind','preview','parent_id',null,'request',d->'request')) THEN RAISE EXCEPTION 'Hash podglądu nie wiąże aktora i źródła' USING ERRCODE='23514';END IF;
 IF d->'definition' IS DISTINCT FROM d#>'{request,definition}' OR d->>'file_name' IS DISTINCT FROM d#>>'{request,file_name}' OR d->>'note' IS DISTINCT FROM d#>>'{request,note}' THEN RAISE EXCEPTION 'Konfiguracja pomiaru różni się od źródła' USING ERRCODE='23514';END IF;
 IF NOT stock_file_import_configuration(d->'definition',d#>'{request,targets}') THEN RAISE EXCEPTION 'Niepoprawna konfiguracja pomiaru' USING ERRCODE='23514';END IF;source:=stock_file_import_source_cells(d->'request');IF jsonb_array_length(source) NOT BETWEEN 1 AND 500 OR(d#>>'{summary,source_rows}')::integer<>jsonb_array_length(source) OR(d#>>'{summary,positions}')::integer<>jsonb_array_length(d->'rows') THEN RAISE EXCEPTION 'Niepełne wiersze pomiarów' USING ERRCODE='23514';END IF;
 SELECT jsonb_build_object('warehouse_ids',jsonb_agg(x->'warehouse_id'),'product_ids',(SELECT coalesce(jsonb_agg(p->'id'),'[]') FROM jsonb_array_elements(d#>'{snapshot,products}') p)) INTO scope FROM jsonb_array_elements(d->'targets') x;
 actual:=stock_file_import_snapshot(scope);IF actual IS DISTINCT FROM d->'snapshot' THEN RAISE EXCEPTION 'Rzeczywisty zakres pomiarów zmienił się' USING ERRCODE='23514';END IF;
 IF coalesce((actual#>>'{policy,enabled}')::boolean,false) IS DISTINCT FROM(d#>>'{policy,enabled}')::boolean OR coalesce(actual#>>'{policy,version}','0') IS DISTINCT FROM d#>>'{policy,version}' THEN RAISE EXCEPTION 'Polityka pomiarów jest nieaktualna' USING ERRCODE='23514';END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(d->'targets') LOOP
 IF NOT EXISTS(SELECT 1 FROM warehouses WHERE tenant_id=t AND id=(target->>'warehouse_id')::uuid) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d#>'{request,targets}') q WHERE q=target-ARRAY['warehouse_name','summary','valuation','children']) THEN RAISE EXCEPTION 'Obcy magazyn lub mapowanie pomiarów' USING ERRCODE='23514';END IF;
 END LOOP;
 -- Build each immutable lookup once. These are local JSON maps, never caller-
 -- controlled caches or mutable temporary tables; all current facts above remain checked.
 SELECT coalesce(jsonb_object_agg(x->>'warehouse_id',x),'{}') INTO target_map FROM jsonb_array_elements(d->'targets') x;
 SELECT coalesce(jsonb_object_agg(group_key,quantity),'{}') INTO quantity_map FROM (
   SELECT jsonb_build_array(x->>'source_index',x->>'warehouse_id')::text group_key,coalesce(sum((x#>>'{input,quantity}')::bigint),0) quantity
   FROM jsonb_array_elements(d->'rows') x GROUP BY jsonb_build_array(x->>'source_index',x->>'warehouse_id')::text
 ) grouped_quantities;
 SELECT coalesce(jsonb_object_agg(jsonb_build_array(x->>'warehouse_id',x->>'product_id')::text,x),'{}') INTO stock_map FROM jsonb_array_elements(actual->'stock') x;
 SELECT coalesce(jsonb_object_agg(jsonb_build_array(x->>'source_index',x->>'warehouse_id')::text,true),'{}') INTO coverage_map FROM jsonb_array_elements(d->'rows') x;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(d#>'{request,resolutions}') resolution_row GROUP BY resolution_row->>'source_index',resolution_row->>'warehouse_id' HAVING count(*)>1) THEN RAISE EXCEPTION 'Powtórzone rozwiązanie pomiaru' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_object_agg(jsonb_build_array(x->>'source_index',x->>'warehouse_id')::text,x),'{}') INTO resolution_map FROM jsonb_array_elements(d#>'{request,resolutions}') x;
 -- One own-tenant identity scan, including inactive/bundle products. Resolve
 -- current SKU plus historical aliases by DISTINCT product, never by alias count.
 -- Request keys only bound map size; they never restrict ambiguity to payload products.
 SELECT coalesce(array_agg(DISTINCT identity_value) FILTER(WHERE identity_value IS NOT NULL),ARRAY[]::text[]) INTO identity_keys FROM (
   SELECT CASE WHEN identity_kind='uuid' THEN
     CASE WHEN decoded.value~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN lower(decoded.value) ELSE NULL END
     ELSE decoded.value END identity_value
   FROM jsonb_array_elements(source) source_row
   CROSS JOIN LATERAL (SELECT nullif(stock_file_import_cell(source_row->>(d#>>'{definition,identity_field}'),safe,identity_kind IN('uuid','sku','historical_sku','ean')),'') value) decoded
 ) requested_keys;
 IF identity_kind='uuid' THEN identity_uuid_keys:=identity_keys::uuid[];ELSE identity_uuid_keys:=ARRAY[]::uuid[];END IF;
 -- Mutually exclusive indexable branches retain full tenant-wide ambiguity,
 -- but do not materialize an unrelated million-product tenant catalog.
 WITH candidates AS (
   SELECT p.id product_id,p.id::text identity_value FROM products p WHERE identity_kind='uuid' AND p.tenant_id=t AND p.id=ANY(identity_uuid_keys)
   UNION ALL
   SELECT p.id,p.sku FROM products p WHERE identity_kind IN('sku','historical_sku') AND p.tenant_id=t AND p.sku=ANY(identity_keys)
   UNION ALL
   SELECT p.id,p.ean FROM products p WHERE identity_kind='ean' AND p.tenant_id=t AND p.ean<>'' AND p.ean=ANY(identity_keys)
   UNION ALL
   SELECT p.id,p.name FROM products p WHERE identity_kind NOT IN('uuid','sku','historical_sku','ean') AND p.tenant_id=t AND p.name=ANY(identity_keys)
   UNION ALL
   SELECT p.id,a.sku FROM product_sku_aliases a JOIN products p ON(p.tenant_id,p.id)=(a.tenant_id,a.product_id) WHERE identity_kind='historical_sku' AND a.tenant_id=t AND a.sku=ANY(identity_keys)
 ), matched AS (
   SELECT c.identity_value,count(DISTINCT c.product_id) matches,min(c.product_id::text) product_id
   FROM candidates c GROUP BY c.identity_value
 )
 SELECT coalesce(jsonb_object_agg(identity_value,jsonb_build_object('matches',matches,'product_id',product_id)),'{}') INTO identity_map FROM matched;
 SELECT coalesce(jsonb_object_agg(p.id::text,to_jsonb(p)),'{}') INTO product_map FROM products p
 WHERE p.tenant_id=t AND p.id IN(SELECT (snapshot_product->>'id')::uuid FROM jsonb_array_elements(actual->'products') snapshot_product);
 IF (d#>>'{summary,invalid}')::integer=0 AND EXISTS(
   SELECT 1 FROM jsonb_array_elements(d->'rows') physical_row
   WHERE physical_row#>>'{input,operation}'='count'
   GROUP BY physical_row->>'product_id',physical_row->>'warehouse_id',physical_row->>'location',physical_row->'lot'
   HAVING count(*)>1
 ) THEN RAISE EXCEPTION 'Powtórzona fizyczna pozycja pomiaru' USING ERRCODE='23514';END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(d->'rows') LOOP
  raw:=source->(r->>'source_index')::integer;
  IF raw IS NULL OR raw IS DISTINCT FROM r->'raw_cells' THEN RAISE EXCEPTION 'Źródłowy wiersz pomiaru różni się od dowodu' USING ERRCODE='23514';END IF;
  target:=target_map->(r->>'warehouse_id');
  IF target IS NULL THEN RAISE EXCEPTION 'Wiersz poza magazynami' USING ERRCODE='23514';END IF;
  identity:=nullif(stock_file_import_cell(raw->>(d#>>'{definition,identity_field}'),safe,d#>>'{definition,identity}' IN('uuid','sku','historical_sku','ean')),'');IF d#>>'{definition,identity}'='uuid' THEN IF identity~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN identity:=lower(identity);ELSE identity:=NULL;END IF;END IF;
  IF r#>>'{resolution,value}' IS DISTINCT FROM identity THEN RAISE EXCEPTION 'Źródłowy identyfikator różni się od rozwiązania' USING ERRCODE='23514';END IF;
  IF jsonb_typeof(r->'errors') IS DISTINCT FROM 'array' OR r->>'status' NOT IN('invalid','unchanged','changed','skipped','conflict') OR(r->>'status' NOT IN('invalid','conflict') AND jsonb_array_length(r->'errors')<>0) THEN RAISE EXCEPTION 'Niepoprawny stan wiersza pomiaru' USING ERRCODE='23514';END IF;IF r->>'status'='invalid' THEN CONTINUE;END IF;
  prod:=jsonb_populate_record(NULL::products,product_map->(r->>'product_id'));
  IF prod.id IS NULL OR NOT prod.active OR prod.kind NOT IN('simple','variant') OR prod.sku IS DISTINCT FROM r->>'sku' OR prod.name IS DISTINCT FROM r->>'name' THEN RAISE EXCEPTION 'Brak własnego fizycznego produktu' USING ERRCODE='23514';END IF;
  identity_result:=identity_map->identity;
  IF coalesce((identity_result->>'matches')::bigint,0)<>1 OR identity_result->>'product_id' IS DISTINCT FROM prod.id::text THEN RAISE EXCEPTION 'Tożsamość produktu jest niejednoznaczna' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each_text(target->'mapping') m WHERE NOT(raw ? m.value)) THEN RAISE EXCEPTION 'Brak mapowanego pola pomiaru' USING ERRCODE='23514';END IF;operation:=stock_file_import_cell(raw->>(target#>>'{mapping,operation}'),safe);amount:=stock_file_import_cell(raw->>(target#>>'{mapping,quantity}'),safe);
  IF d#>>'{definition,format}'='xml' AND d#>>'{definition,xml_mode}'='catalog' THEN SELECT x->>'on_hand' INTO amount FROM jsonb_array_elements(raw->(target#>>'{mapping,quantity}')) x WHERE x->>'warehouse_id'=r->>'warehouse_id' AND x->>'status'='available' AND x->>'source'='stock';END IF;
  IF r#>>'{input,operation}'='none' THEN IF r->>'status' IS DISTINCT FROM 'skipped' OR r->'before' IS DISTINCT FROM 'null'::jsonb OR r->'after' IS DISTINCT FROM 'null'::jsonb OR r->'valuation' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Pominięty wiersz nie jest pominiętą pozycją' USING ERRCODE='23514';END IF;IF operation IS DISTINCT FROM 'none' AND(amount IS NOT NULL AND amount<>'') THEN RAISE EXCEPTION 'Pominięto rzeczywisty pomiar' USING ERRCODE='23514';END IF;CONTINUE;END IF;
  IF r#>>'{input,operation}' IS DISTINCT FROM 'count' OR operation NOT IN('','count') AND operation IS NOT NULL OR amount IS NULL OR amount!~'^(0|[1-9][0-9]{0,9})$' OR amount::numeric>2147483647 OR(r#>>'{input,quantity}') IS NULL OR(r#>>'{input,quantity}')!~'^(0|[1-9][0-9]{0,6})$' OR(r#>>'{input,quantity}')::integer>1000000 THEN RAISE EXCEPTION 'Źródłowy pomiar różni się od zatwierdzonego' USING ERRCODE='23514';END IF;
  sumq:=(quantity_map->>jsonb_build_array(r->>'source_index',r->>'warehouse_id')::text)::bigint;
  IF sumq<>amount::bigint THEN RAISE EXCEPTION 'Rozkład nie pokrywa źródłowego pomiaru' USING ERRCODE='23514';END IF;
  IF target->>'quantity_scope'='warehouse_total' THEN
   IF NOT(resolution_map ? jsonb_build_array(r->>'source_index',r->>'warehouse_id')::text) THEN RAISE EXCEPTION 'Agregat wymaga jawnego rozkładu' USING ERRCODE='23514';END IF;
   IF(d#>>'{policy,enabled}')::boolean AND EXISTS(SELECT 1 FROM jsonb_array_elements(actual->'layer_positions') lp JOIN jsonb_array_elements(actual->'layers') cl ON cl->>'id'=lp->>'layer_id' WHERE lp->>'product_id'=r->>'product_id' AND lp->>'warehouse_id'=r->>'warehouse_id' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'rows') selected_position WHERE selected_position->>'product_id'=r->>'product_id' AND selected_position->>'warehouse_id'=r->>'warehouse_id' AND selected_position->>'location'=lp->>'location' AND selected_position#>>'{lot,id}'=cl->>'lot_id')) THEN RAISE EXCEPTION 'Rozkład pomija istniejącą partię' USING ERRCODE='23514';END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(actual->'bins') b WHERE b->>'product_id'=r->>'product_id' AND b->>'warehouse_id'=r->>'warehouse_id' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'rows') x WHERE x->>'product_id'=r->>'product_id' AND x->>'warehouse_id'=r->>'warehouse_id' AND x->>'location'=b->>'location')) THEN RAISE EXCEPTION 'Rozkład pomija istniejący bin' USING ERRCODE='23514';END IF;
  END IF;
  basis:=stock_map->jsonb_build_array(r->>'warehouse_id',r->>'product_id')::text;
  IF r#>>'{before,present}' IS DISTINCT FROM (basis IS NOT NULL)::text OR coalesce(basis->>'on_hand','0') IS DISTINCT FROM r#>>'{before,warehouse_on_hand}' OR coalesce(basis->>'reserved','0') IS DISTINCT FROM r#>>'{before,warehouse_reserved}' OR coalesce(basis->>'version',CASE WHEN(d#>>'{policy,enabled}')::boolean THEN '0' ELSE NULL END) IS DISTINCT FROM r#>>'{before,stock_version}' THEN RAISE EXCEPTION 'Stan przed pomiarem nie jest rzeczywisty' USING ERRCODE='23514';END IF;
  qty:=0;held:=0;
  IF(d#>>'{policy,enabled}')::boolean THEN
   IF r->'lot' IS NULL OR r->'lot'='null' THEN RAISE EXCEPTION 'WMS wymaga rzeczywistej partii' USING ERRCODE='23514';END IF;lotid:=(r#>>'{lot,id}')::uuid;
   IF lotid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM wms_lots WHERE tenant_id=t AND id=lotid AND product_id=prod.id) THEN RAISE EXCEPTION 'Obca partia pomiaru' USING ERRCODE='23514';END IF;
   SELECT coalesce(sum(p.quantity),0),coalesce(sum(p.reserved),0) INTO qty,held FROM wms_layer_positions p JOIN wms_cost_layers l ON(l.tenant_id,l.id)=(p.tenant_id,p.layer_id) WHERE p.tenant_id=t AND p.warehouse_id=(r->>'warehouse_id')::uuid AND p.product_id=prod.id AND p.location=r->>'location' AND l.lot_id=lotid;
   need:=(r#>>'{input,quantity}')::integer-qty;fragments:='[]';
   IF need>0 THEN
    IF r#>>'{position,unit_cost_minor}' IS NULL OR r#>>'{position,unit_cost_minor}'!~'^(0|[1-9][0-9]*)$' OR(r#>>'{position,unit_cost_minor}')::numeric>9223372036854775807 OR r#>>'{position,currency}' IS DISTINCT FROM d#>>'{policy,currency}' THEN RAISE EXCEPTION 'Nadwyżka wymaga jawnego kosztu i waluty polityki' USING ERRCODE='23514';END IF;
    fragments:=jsonb_build_array(jsonb_build_object('layer_id',null,'quantity',need,'delta',need,'unit_cost_minor',r#>>'{position,unit_cost_minor}','currency',r#>>'{position,currency}'));
   ELSIF need<0 THEN need:=-need;
    FOR layer IN SELECT stock_file_import_record(to_jsonb(x)) FROM(SELECT p.layer_id,p.quantity,p.reserved,l.unit_cost_minor,l.currency FROM wms_layer_positions p JOIN wms_cost_layers l ON(l.tenant_id,l.id)=(p.tenant_id,p.layer_id) WHERE p.tenant_id=t AND p.warehouse_id=(r->>'warehouse_id')::uuid AND p.product_id=prod.id AND p.location=r->>'location' AND l.lot_id=lotid ORDER BY l.fifo_sequence,l.id) x LOOP
     free:=(layer->>'quantity')::integer-(layer->>'reserved')::integer;take:=least(need,free);IF take>0 THEN fragments:=fragments||jsonb_build_array(jsonb_build_object('layer_id',layer->>'layer_id','quantity',take,'delta',-take,'unit_cost_minor',layer->>'unit_cost_minor','currency',layer->>'currency'));need:=need-take;END IF;EXIT WHEN need=0;
    END LOOP;IF need>0 THEN RAISE EXCEPTION 'Pomiar narusza rezerwacje warstw' USING ERRCODE='23514';END IF;
   END IF;
   IF r->'lot' IS DISTINCT FROM (CASE WHEN r#>>'{position,lot,kind}'='existing' THEN(SELECT jsonb_build_object('id',l.id,'lot_code',l.lot_code,'expiry_date',l.expiry_date::text) FROM wms_lots l WHERE l.tenant_id=t AND l.id=(r#>>'{position,lot,lot_id}')::uuid AND l.product_id=prod.id) ELSE jsonb_build_object('id',null,'lot_code',r#>>'{position,lot,lot_code}','expiry_date',r#>>'{position,lot,expiry_date}') END) THEN RAISE EXCEPTION 'Źródłowa partia różni się od pomiaru' USING ERRCODE='23514';END IF;
   IF r->'valuation' IS DISTINCT FROM(SELECT jsonb_build_object('currency',d#>>'{policy,currency}','known_loss_minor',coalesce(sum((f->>'quantity')::numeric*(f->>'unit_cost_minor')::numeric) FILTER(WHERE(f->>'delta')::integer<0),0)::text,'known_surplus_minor',coalesce(sum((f->>'quantity')::numeric*(f->>'unit_cost_minor')::numeric) FILTER(WHERE(f->>'delta')::integer>0),0)::text,'unknown_loss_quantity',coalesce(sum((f->>'quantity')::integer) FILTER(WHERE f->>'unit_cost_minor' IS NULL),0),'surplus_quantity',greatest((r#>>'{input,quantity}')::integer-qty,0)) FROM jsonb_array_elements(fragments) f) THEN RAISE EXCEPTION 'Wycena pomiaru różni się od rzeczywistych fragmentów' USING ERRCODE='23514';END IF;
   IF fragments IS DISTINCT FROM r->'fragments' THEN RAISE EXCEPTION 'Plan FIFO różni się od rzeczywistych warstw' USING ERRCODE='23514';END IF;
  ELSE
   IF r->'lot' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Wyłączony WMS nie przyjmuje partii' USING ERRCODE='23514';END IF;
   SELECT coalesce((SELECT quantity FROM stock_locations WHERE tenant_id=t AND warehouse_id=(r->>'warehouse_id')::uuid AND product_id=prod.id AND location=r->>'location'),0) INTO qty;
   SELECT coalesce(sum(rl.quantity),0) INTO held FROM reservation_locations rl JOIN reservations rr ON(rr.tenant_id,rr.order_id,rr.product_id,rr.warehouse_id)=(rl.tenant_id,rl.order_id,rl.product_id,rl.warehouse_id) WHERE rl.tenant_id=t AND rl.warehouse_id=(r->>'warehouse_id')::uuid AND rl.product_id=prod.id AND rl.location=r->>'location' AND rr.state='active';
  END IF;
  IF qty IS DISTINCT FROM(r#>>'{before,quantity}')::integer OR held IS DISTINCT FROM(r#>>'{before,reserved}')::integer OR(r#>>'{input,quantity}')::integer<held OR(r#>>'{after,quantity}')::integer IS DISTINCT FROM(r#>>'{input,quantity}')::integer THEN RAISE EXCEPTION 'Fizyczna ilość pomiaru jest nieprawdziwa' USING ERRCODE='23514';END IF;
  IF r->>'status' IS DISTINCT FROM(CASE WHEN qty=(r#>>'{input,quantity}')::integer THEN 'unchanged' ELSE 'changed' END) THEN RAISE EXCEPTION 'Stan wiersza różni się od rzeczywistej zmiany' USING ERRCODE='23514';END IF;
  -- A supplied resolution is bound to every exact position/cost. Otherwise source fields bind it.
  basis:=resolution_map->jsonb_build_array(r->>'source_index',r->>'warehouse_id')::text;
  IF basis IS NOT NULL THEN IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'positions') x WHERE x=r->'position') THEN RAISE EXCEPTION 'Pozycja różni się od jawnego rozkładu' USING ERRCODE='23514';END IF;
  ELSE
   IF r#>>'{position,lot,lot_id}' IS DISTINCT FROM nullif(stock_file_import_cell(raw->>(target#>>'{mapping,lot_id}'),safe),'') OR r#>>'{position,lot,lot_code}' IS DISTINCT FROM nullif(stock_file_import_cell(raw->>(target#>>'{mapping,lot_code}'),safe),'') OR r#>>'{position,lot,expiry_date}' IS DISTINCT FROM nullif(stock_file_import_cell(raw->>(target#>>'{mapping,expiry_date}'),safe),'') THEN RAISE EXCEPTION 'Źródłowa partia różni się od rozwiązania' USING ERRCODE='23514';END IF;
   IF r->>'location' IS DISTINCT FROM coalesce(nullif(stock_file_import_cell(raw->>(target#>>'{mapping,location}'),safe),''),target->>'default_location') OR r#>>'{position,unit_cost_minor}' IS DISTINCT FROM nullif(stock_file_import_cell(raw->>(target#>>'{mapping,unit_cost_minor}'),safe),'') OR r#>>'{position,currency}' IS DISTINCT FROM nullif(stock_file_import_cell(raw->>(target#>>'{mapping,currency}'),safe),'') THEN RAISE EXCEPTION 'Źródłowa lokalizacja lub koszt różni się od dowodu' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
 IF d->'summary' IS DISTINCT FROM (stock_file_import_summary(d->'rows',true)||jsonb_build_object('source_rows',jsonb_array_length(source))) THEN RAISE EXCEPTION 'Podsumowanie pomiarów nie jest pochodne wierszy' USING ERRCODE='23514';END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(d->'targets') LOOP IF target->'valuation' IS DISTINCT FROM (CASE WHEN(d#>>'{policy,enabled}')::boolean THEN (SELECT jsonb_build_object('currency',d#>>'{policy,currency}','known_loss_minor',coalesce(sum((x#>>'{valuation,known_loss_minor}')::numeric),0)::text,'known_surplus_minor',coalesce(sum((x#>>'{valuation,known_surplus_minor}')::numeric),0)::text) FROM jsonb_array_elements(d->'rows') x WHERE x->>'warehouse_id'=target->>'warehouse_id') ELSE 'null'::jsonb END) THEN RAISE EXCEPTION 'Wycena magazynu nie jest pochodna wierszy' USING ERRCODE='23514';END IF;IF target->'summary' IS DISTINCT FROM stock_file_import_summary((SELECT coalesce(jsonb_agg(x),'[]') FROM jsonb_array_elements(d->'rows') x WHERE x->>'warehouse_id'=target->>'warehouse_id'),false) THEN RAISE EXCEPTION 'Podsumowanie magazynu nie jest pochodne wierszy' USING ERRCODE='23514';END IF;END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(source) WITH ORDINALITY src(v,n) CROSS JOIN jsonb_array_elements(d->'targets') coverage_target WHERE NOT(coverage_map ? jsonb_build_array((n-1)::text,coverage_target->>'warehouse_id')::text)) THEN RAISE EXCEPTION 'Pominięto źródłowy wiersz pomiaru' USING ERRCODE='23514';END IF;
END $$;
REVOKE ALL ON FUNCTION stock_file_import_validate_preview(jsonb) FROM PUBLIC,dyna_app;

-- Whole execution validation capacity repair; installed115 stays immutable.
CREATE OR REPLACE FUNCTION stock_file_import_validate_execution(d jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p stock_file_import_previews%ROWTYPE;a stock_file_import_admissions%ROWTYPE;scope jsonb;actual jsonb;link jsonb;target jsonb;child jsonb;r jsonb;stockrow jsonb;binrow jsonb;oldrow jsonb;delta bigint;qty bigint;expected bigint;recorded integer;core inventory_bulk_edit_executions%ROWTYPE;posting wms_stocktake_postings%ROWTYPE;rows_count integer;name text;newrows jsonb;actual_stock_map jsonb;before_stock_map jsonb;actual_bin_map jsonb;before_bin_map jsonb;actual_epoch_map jsonb;before_epoch_map jsonb;warehouse_delta_map jsonb;bin_delta_map jsonb;approved_row_map jsonb;approved_count_map jsonb;changed_product_map jsonb;core_count_map jsonb;link_map jsonb;operation_map jsonb;before_operation_map jsonb;before_movement_map jsonb;lookup_key text;matched_bin jsonb;matched_row jsonb;BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'rows') WITH ORDINALITY indexed_row(value,ordinal) WHERE indexed_row.value->>'index' IS DISTINCT FROM(indexed_row.ordinal-1)::text) THEN RAISE EXCEPTION 'Indeksy wierszy importu stanów są niekanoniczne' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM stock_file_import_previews WHERE tenant_id=t AND id=(d->>'preview_id')::uuid;
 SELECT * INTO a FROM stock_file_import_admissions WHERE tenant_id=t AND execution_id=(d->>'id')::uuid AND top_xid=pg_current_xact_id() AND transaction_started_at=transaction_timestamp();
 IF p.id IS NULL OR a.execution_id IS NULL OR a.before_snapshot IS DISTINCT FROM p.payload->'snapshot' OR d->>'client_key' IS DISTINCT FROM a.request->>'client_key' OR d->>'file_name' IS DISTINCT FROM p.file_name OR a.preview_id IS DISTINCT FROM p.id OR p.actor_id IS DISTINCT FROM a.actor_id OR p.api_key_id IS DISTINCT FROM a.api_key_id OR(d->>'actor_id')::uuid IS DISTINCT FROM a.actor_id OR(d->>'api_key_id')::uuid IS DISTINCT FROM a.api_key_id OR d->'execute_request' IS DISTINCT FROM a.request OR d->>'scope_hash' IS DISTINCT FROM p.scope_hash OR d->'definition' IS DISTINCT FROM p.payload->'definition' OR d->'targets' IS DISTINCT FROM p.payload->'targets' OR d->'summary' IS DISTINCT FROM p.payload->'summary' OR d->>'source_hash' IS DISTINCT FROM p.payload->>'source_hash' THEN RAISE EXCEPTION 'Niepełne powiązanie wykonania importu stanów' USING ERRCODE='23514';END IF;
 PERFORM stock_file_import_require(a.actor_id,a.api_key_id,false);IF d->>'request_hash' IS DISTINCT FROM stock_file_import_hash(jsonb_build_object('actor_id',a.actor_id::text,'api_key_id',a.api_key_id::text,'source',p.payload->>'source','kind','execute','parent_id',p.id::text,'request',a.request)) THEN RAISE EXCEPTION 'Hash wykonania nie wiąże aktora i zgody' USING ERRCODE='23514';END IF;
 SELECT jsonb_build_object('warehouse_ids',jsonb_agg(x->'warehouse_id'),'product_ids',(SELECT coalesce(jsonb_agg(pr->'id'),'[]') FROM jsonb_array_elements(p.payload#>'{snapshot,products}') pr)) INTO scope FROM jsonb_array_elements(p.payload->'targets') x;
 actual:=stock_file_import_snapshot(scope);
 IF actual IS DISTINCT FROM d->'snapshot' OR actual->'products' IS DISTINCT FROM a.before_snapshot->'products' OR actual->'aliases' IS DISTINCT FROM a.before_snapshot->'aliases' OR actual->'warehouses' IS DISTINCT FROM a.before_snapshot->'warehouses' OR actual->'policy' IS DISTINCT FROM a.before_snapshot->'policy' OR actual->'reservations' IS DISTINCT FROM a.before_snapshot->'reservations' OR actual->'reservation_locations' IS DISTINCT FROM a.before_snapshot->'reservation_locations' OR actual->'reservation_layers' IS DISTINCT FROM a.before_snapshot->'reservation_layers' THEN RAISE EXCEPTION 'Wykonanie zmieniło niezatwierdzony zakres' USING ERRCODE='23514';END IF;
 -- Immutable local indexes built once from independently checked before/actual facts.
 -- Composite JSON-array keys keep arbitrary locations collision-free.
 SELECT coalesce(jsonb_object_agg(jsonb_build_array(fact_row->>'warehouse_id',fact_row->>'product_id')::text,fact_row),'{}') INTO actual_stock_map FROM jsonb_array_elements(actual->'stock') fact_row;
 SELECT coalesce(jsonb_object_agg(jsonb_build_array(fact_row->>'warehouse_id',fact_row->>'product_id')::text,fact_row),'{}') INTO before_stock_map FROM jsonb_array_elements(a.before_snapshot->'stock') fact_row;
 SELECT coalesce(jsonb_object_agg(jsonb_build_array(fact_row->>'warehouse_id',fact_row->>'product_id',fact_row->>'location')::text,fact_row),'{}') INTO actual_bin_map FROM jsonb_array_elements(actual->'bins') fact_row;
 SELECT coalesce(jsonb_object_agg(jsonb_build_array(fact_row->>'warehouse_id',fact_row->>'product_id',fact_row->>'location')::text,fact_row),'{}') INTO before_bin_map FROM jsonb_array_elements(a.before_snapshot->'bins') fact_row;
 SELECT coalesce(jsonb_object_agg(jsonb_build_array(fact_row->>'warehouse_id',fact_row->>'product_id')::text,fact_row),'{}') INTO actual_epoch_map FROM jsonb_array_elements(actual->'epochs') fact_row;
 SELECT coalesce(jsonb_object_agg(jsonb_build_array(fact_row->>'warehouse_id',fact_row->>'product_id')::text,fact_row),'{}') INTO before_epoch_map FROM jsonb_array_elements(a.before_snapshot->'epochs') fact_row;
 SELECT coalesce(jsonb_object_agg(group_key,quantity),'{}') INTO warehouse_delta_map FROM (SELECT jsonb_build_array(approved_row->>'warehouse_id',approved_row->>'product_id')::text group_key,coalesce(sum((approved_row#>>'{input,quantity}')::bigint-(approved_row#>>'{before,quantity}')::bigint),0) quantity FROM jsonb_array_elements(p.payload->'rows') approved_row WHERE approved_row#>>'{input,operation}'='count' GROUP BY jsonb_build_array(approved_row->>'warehouse_id',approved_row->>'product_id')::text) grouped_delta;
 SELECT coalesce(jsonb_object_agg(group_key,quantity),'{}') INTO bin_delta_map FROM (SELECT jsonb_build_array(approved_row->>'warehouse_id',approved_row->>'product_id',approved_row->>'location')::text group_key,coalesce(sum((approved_row#>>'{input,quantity}')::bigint-(approved_row#>>'{before,quantity}')::bigint),0) quantity FROM jsonb_array_elements(p.payload->'rows') approved_row WHERE approved_row#>>'{input,operation}'='count' GROUP BY jsonb_build_array(approved_row->>'warehouse_id',approved_row->>'product_id',approved_row->>'location')::text) grouped_delta;
 SELECT coalesce(jsonb_object_agg(encode(sha256(convert_to((approved_row-'after')::text,'UTF8')),'hex'),approved_row-'after'),'{}') INTO approved_row_map FROM jsonb_array_elements(p.payload->'rows') approved_row;
 SELECT coalesce(jsonb_object_agg(jsonb_build_array(approved_row->>'warehouse_id',approved_row->>'product_id',approved_row->>'location',approved_row#>>'{input,quantity}')::text,true),'{}') INTO approved_count_map FROM jsonb_array_elements(p.payload->'rows') approved_row WHERE approved_row#>>'{input,operation}'='count';
 SELECT coalesce(jsonb_object_agg(jsonb_build_array(approved_row->>'warehouse_id',approved_row->>'product_id')::text,true),'{}') INTO changed_product_map FROM jsonb_array_elements(p.payload->'rows') approved_row WHERE approved_row->>'status'='changed';
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'links') receipt_link GROUP BY receipt_link->>'warehouse_id',coalesce(receipt_link->>'core_preview_id',receipt_link->>'stocktake_id') HAVING count(*)>1) THEN RAISE EXCEPTION 'Dodatkowe lub powtórzone child receipts' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_object_agg(jsonb_build_array(receipt_link->>'warehouse_id',coalesce(receipt_link->>'core_preview_id',receipt_link->>'stocktake_id'))::text,receipt_link),'{}') INTO link_map FROM jsonb_array_elements(d->'links') receipt_link;
 SELECT coalesce(jsonb_object_agg(receipt_link->>'operation_id',true) FILTER(WHERE receipt_link->>'operation_id' IS NOT NULL),'{}') INTO operation_map FROM jsonb_array_elements(d->'links') receipt_link;
 SELECT coalesce(jsonb_object_agg(fact_row->>'id',fact_row),'{}') INTO before_operation_map FROM jsonb_array_elements(a.before_snapshot->'wms_operations') fact_row;
 SELECT coalesce(jsonb_object_agg(fact_row->>'id',fact_row),'{}') INTO before_movement_map FROM jsonb_array_elements(a.before_snapshot->'stock_movements') fact_row;
 IF jsonb_array_length(d->'rows')<>jsonb_array_length(p.payload->'rows') OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'rows') rr WHERE approved_row_map->encode(sha256(convert_to((rr-'after')::text,'UTF8')),'hex') IS DISTINCT FROM rr-'after') THEN RAISE EXCEPTION 'Wiersze wykonania nie odpowiadają zgodzie' USING ERRCODE='23514';END IF;
 rows_count:=0;
 FOR target IN SELECT value FROM jsonb_array_elements(p.payload->'targets') LOOP
  FOR child IN SELECT value FROM jsonb_array_elements(target->'children') LOOP
   rows_count:=rows_count+1;
   link:=link_map->jsonb_build_array(target->>'warehouse_id',child->>'id')::text;
   IF link IS NULL THEN RAISE EXCEPTION 'Brak całego child receipt' USING ERRCODE='23514';END IF;
   IF(p.payload#>>'{policy,enabled}')::boolean THEN
    SELECT * INTO posting FROM wms_stocktake_postings WHERE tenant_id=t AND id=(link->>'posting_id')::uuid AND stocktake_id=(child->>'id')::uuid AND actor_id=a.actor_id AND client_key=(child->>'post_key')::uuid;
    IF posting.id IS NULL OR posting.review_id IS DISTINCT FROM(link->>'review_id')::uuid OR posting.operation_id IS DISTINCT FROM(link->>'operation_id')::uuid OR NOT EXISTS(SELECT 1 FROM wms_stocktakes h WHERE h.tenant_id=t AND h.id=posting.stocktake_id AND h.state='posted' AND h.posting_id=posting.id AND h.actor_id=a.actor_id AND h.warehouse_id=(target->>'warehouse_id')::uuid AND h.client_key=(child->>'create_key')::uuid) THEN RAISE EXCEPTION 'Brak rzeczywistego rozliczenia spisu' USING ERRCODE='23514';END IF;
    IF NOT EXISTS(SELECT 1 FROM stock_file_import_core_witnesses w WHERE w.tenant_id=t AND w.kind='wms_stocktake_postings' AND w.id=posting.id AND w.preview_id=p.id AND w.top_xid=pg_current_xact_id() AND w.transaction_started_at=transaction_timestamp()) OR NOT EXISTS(SELECT 1 FROM stock_file_import_core_witnesses w WHERE w.tenant_id=t AND w.kind='wms_stocktakes' AND w.id=posting.stocktake_id AND w.preview_id=p.id AND w.top_xid=pg_current_xact_id() AND w.transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Spis nie powstał w tej transakcji' USING ERRCODE='23514';END IF;
    IF(SELECT count(*) FROM wms_stocktake_lines WHERE tenant_id=t AND stocktake_id=posting.stocktake_id)<>(SELECT count(*) FROM jsonb_array_elements(p.payload->'rows') approved_row WHERE approved_row->>'warehouse_id'=target->>'warehouse_id' AND approved_row#>>'{input,operation}'='count') THEN RAISE EXCEPTION 'Spis rozszerzył zatwierdzone pozycje' USING ERRCODE='23514';END IF;
    FOR r IN SELECT value FROM jsonb_array_elements(p.payload->'rows') rr WHERE rr->>'warehouse_id'=target->>'warehouse_id' AND rr#>>'{input,operation}'='count' LOOP
     IF NOT EXISTS(SELECT 1 FROM wms_stocktake_lines l JOIN wms_stocktake_review_rows rw ON(rw.tenant_id,rw.line_id)=(l.tenant_id,l.id) WHERE l.tenant_id=t AND l.stocktake_id=posting.stocktake_id AND l.id=(r->>'line_id')::uuid AND l.product_id=(r->>'product_id')::uuid AND l.location=r->>'location' AND l.counted=(r#>>'{input,quantity}')::integer AND rw.review_id=posting.review_id AND rw.fragments=r->'fragments' AND rw.before->>'quantity'=r#>>'{before,quantity}' AND rw.after->>'quantity'=r#>>'{input,quantity}') THEN RAISE EXCEPTION 'Spis ma inne ilości, warstwy lub koszty' USING ERRCODE='23514';END IF;
    END LOOP;
   ELSE
    SELECT * INTO core FROM inventory_bulk_edit_executions WHERE tenant_id=t AND id=(link->>'core_execution_id')::uuid AND preview_id=(child->>'id')::uuid AND actor_id=a.actor_id AND client_key=(child->>'execute_key')::uuid;
    IF core.id IS NULL OR NOT EXISTS(SELECT 1 FROM stock_file_import_core_witnesses w WHERE w.tenant_id=t AND w.kind='inventory_bulk_edit_executions' AND w.id=core.id AND w.preview_id=p.id AND w.top_xid=pg_current_xact_id() AND w.transaction_started_at=transaction_timestamp()) OR NOT EXISTS(SELECT 1 FROM stock_file_import_core_witnesses w WHERE w.tenant_id=t AND w.kind='inventory_bulk_edit_previews' AND w.id=core.preview_id AND w.preview_id=p.id AND w.top_xid=pg_current_xact_id() AND w.transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Pomiar nie powstał w tej transakcji' USING ERRCODE='23514';END IF;
    IF EXISTS(SELECT 1 FROM inventory_bulk_edit_rows rr WHERE rr.tenant_id=t AND rr.preview_id=core.preview_id AND (rr.input->>'operation'<>'count' OR NOT(approved_count_map ? jsonb_build_array(target->>'warehouse_id',rr.product_id::text,rr.location,rr.input->>'quantity')::text))) THEN RAISE EXCEPTION 'Child pomiar ma inny produkt lub ilość' USING ERRCODE='23514';END IF;
   END IF;
  END LOOP;
 END LOOP;
 IF jsonb_array_length(d->'links')<>rows_count THEN RAISE EXCEPTION 'Dodatkowe lub powtórzone child receipts' USING ERRCODE='23514';END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(d->'rows') LOOP
  IF r->'before'='null'::jsonb THEN IF r->'after' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Pominięty pomiar nie ma fizycznego after' USING ERRCODE='23514';END IF;CONTINUE;END IF;
  stockrow:=actual_stock_map->jsonb_build_array(r->>'warehouse_id',r->>'product_id')::text;
  IF r->'after' IS DISTINCT FROM jsonb_build_object('present',stockrow IS NOT NULL,'quantity',(r#>>'{input,quantity}')::integer,'reserved',(r#>>'{before,reserved}')::integer,'available',(r#>>'{input,quantity}')::integer-(r#>>'{before,reserved}')::integer,'warehouse_on_hand',coalesce((stockrow->>'on_hand')::integer,0),'warehouse_reserved',coalesce((stockrow->>'reserved')::integer,0),'stock_version',stockrow->>'version') THEN RAISE EXCEPTION 'Projekcja after nie odpowiada fizycznemu wynikowi' USING ERRCODE='23514';END IF;
 END LOOP;
 -- Independent final stock/bin conservation. Includes absent-to-zero and source epochs.
 FOR r IN SELECT DISTINCT jsonb_build_object('warehouse_id',rr->>'warehouse_id','product_id',rr->>'product_id') FROM jsonb_array_elements(p.payload->'rows') rr WHERE rr->>'product_id' IS NOT NULL LOOP
  oldrow:=before_stock_map->jsonb_build_array(r->>'warehouse_id',r->>'product_id')::text;
  stockrow:=actual_stock_map->jsonb_build_array(r->>'warehouse_id',r->>'product_id')::text;
  delta:=coalesce((warehouse_delta_map->>jsonb_build_array(r->>'warehouse_id',r->>'product_id')::text)::bigint,0);
  IF coalesce((stockrow->>'on_hand')::bigint,0) IS DISTINCT FROM coalesce((oldrow->>'on_hand')::bigint,0)+delta OR coalesce((stockrow->>'reserved')::bigint,0) IS DISTINCT FROM coalesce((oldrow->>'reserved')::bigint,0) OR oldrow IS NULL AND delta=0 AND stockrow IS NOT NULL THEN RAISE EXCEPTION 'Fizyczny stan po pomiarze jest nieprawdziwy' USING ERRCODE='23514';END IF;
  lookup_key:=jsonb_build_array(r->>'warehouse_id',r->>'product_id')::text;expected:=coalesce((actual_epoch_map#>>ARRAY[lookup_key,'version'])::bigint,0)-coalesce((before_epoch_map#>>ARRAY[lookup_key,'version'])::bigint,0);
  IF expected IS DISTINCT FROM (CASE WHEN oldrow IS NULL AND stockrow IS NOT NULL THEN 1::bigint ELSE 0::bigint END) THEN RAISE EXCEPTION 'Źródło brakującego stock zmieniło epokę' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR r IN SELECT DISTINCT jsonb_build_object('warehouse_id',rr->>'warehouse_id','product_id',rr->>'product_id','location',rr->>'location') FROM jsonb_array_elements(p.payload->'rows') rr WHERE rr#>>'{input,operation}'='count' LOOP
  oldrow:=before_bin_map->jsonb_build_array(r->>'warehouse_id',r->>'product_id',r->>'location')::text;
  binrow:=actual_bin_map->jsonb_build_array(r->>'warehouse_id',r->>'product_id',r->>'location')::text;
  delta:=coalesce((bin_delta_map->>jsonb_build_array(r->>'warehouse_id',r->>'product_id',r->>'location')::text)::bigint,0);
  IF coalesce((binrow->>'quantity')::bigint,0) IS DISTINCT FROM coalesce((oldrow->>'quantity')::bigint,0)+delta OR oldrow IS NULL AND delta=0 AND binrow IS NOT NULL THEN RAISE EXCEPTION 'Stan binu po pomiarze jest nieprawdziwy' USING ERRCODE='23514';END IF;
 END LOOP;
 -- Preserve the full bin set outside the approved locations, including zero bins.
 FOR r IN SELECT value FROM jsonb_array_elements(a.before_snapshot->'bins') LOOP
  lookup_key:=jsonb_build_array(r->>'warehouse_id',r->>'product_id',r->>'location')::text;matched_bin:=actual_bin_map->lookup_key;
  IF matched_bin IS NULL OR matched_bin-'quantity' IS DISTINCT FROM r-'quantity' OR(matched_bin IS DISTINCT FROM r AND NOT(bin_delta_map ? lookup_key)) THEN RAISE EXCEPTION 'Wykonanie zmieniło niezatwierdzony zbiór binów' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(actual->'bins') LOOP
  lookup_key:=jsonb_build_array(r->>'warehouse_id',r->>'product_id',r->>'location')::text;
  IF NOT(before_bin_map ? lookup_key) AND NOT(bin_delta_map ? lookup_key) THEN
   matched_row:=actual_stock_map->jsonb_build_array(r->>'warehouse_id',r->>'product_id')::text;
   IF ((p.payload#>>'{policy,enabled}')::boolean AND r->>'quantity'='0' AND NOT(before_stock_map ? jsonb_build_array(r->>'warehouse_id',r->>'product_id')::text) AND matched_row->>'location'=r->>'location') IS NOT TRUE THEN RAISE EXCEPTION 'Wykonanie zmieniło niezatwierdzony zbiór binów' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
 -- Group actual linked core rows once; retain exact-one physical coverage.
 IF NOT(p.payload#>>'{policy,enabled}')::boolean THEN
  SELECT coalesce(jsonb_object_agg(group_key,covered),'{}') INTO core_count_map FROM (
   SELECT jsonb_build_array(receipt_link->>'warehouse_id',cr.product_id::text,cr.location)::text group_key,count(*) covered
   FROM jsonb_array_elements(d->'links') receipt_link JOIN inventory_bulk_edit_rows cr ON cr.tenant_id=t AND cr.preview_id=(receipt_link->>'core_preview_id')::uuid
   GROUP BY jsonb_build_array(receipt_link->>'warehouse_id',cr.product_id::text,cr.location)::text
  ) grouped_core_rows;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p.payload->'rows') approved_row WHERE approved_row#>>'{input,operation}'='count' AND coalesce((core_count_map->>jsonb_build_array(approved_row->>'warehouse_id',approved_row->>'product_id',approved_row->>'location')::text)::bigint,0)<>1) THEN RAISE EXCEPTION 'Niepełne fizyczne child rows' USING ERRCODE='23514';END IF;
 END IF;
 IF NOT(p.payload#>>'{policy,enabled}')::boolean THEN
  FOREACH name IN ARRAY ARRAY['lots','layers','layer_positions','wms_operations','wms_layer_movements'] LOOP IF actual->name IS DISTINCT FROM a.before_snapshot->name THEN RAISE EXCEPTION 'Wyłączony WMS nie może tworzyć warstw ani operacji' USING ERRCODE='23514';END IF;END LOOP;
 ELSE
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(actual->'wms_operations') o WHERE before_operation_map->(o->>'id') IS DISTINCT FROM o AND NOT(operation_map ? (o->>'id'))) THEN RAISE EXCEPTION 'WMS ma dodatkowe niezatwierdzone operacje' USING ERRCODE='23514';END IF;
 END IF;
 -- Journals are genuine core witnesses, not arbitrary extra adjustments.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(actual->'stock_movements') m WHERE before_movement_map->(m->>'id') IS DISTINCT FROM m AND (NOT(changed_product_map ? jsonb_build_array(m->>'warehouse_id',m->>'product_id')::text) OR m->>'kind' IS DISTINCT FROM (CASE WHEN(p.payload#>>'{policy,enabled}')::boolean THEN 'wms_stocktake' ELSE 'location_count' END))) THEN RAISE EXCEPTION 'Dodatkowy niezatwierdzony ruch zapasu' USING ERRCODE='23514';END IF;
END $$;
REVOKE ALL ON FUNCTION stock_file_import_validate_execution(jsonb) FROM PUBLIC,dyna_app;

-- A certified private transition replaces repeated full-truth scans during flush.
-- Parent receipt INSERT first seals physical/core facts; the private NULL->after
-- transition performs the sole full validation. No receipt becomes complete without it.
CREATE OR REPLACE FUNCTION stock_file_import_admission_validation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e stock_file_import_executions%ROWTYPE;p stock_file_import_previews%ROWTYPE;BEGIN
 IF current_setting('session_replication_role') IS DISTINCT FROM 'origin' THEN RAISE EXCEPTION 'Walidacja importu stanów wymaga aktywnych zabezpieczeń' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.after_snapshot IS NOT NULL THEN RAISE EXCEPTION 'Dowód wykonania wymaga zatwierdzonej prywatnej walidacji' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.after_snapshot IS NOT NULL OR NEW.after_snapshot IS NULL OR to_jsonb(NEW)-'after_snapshot' IS DISTINCT FROM to_jsonb(OLD)-'after_snapshot' THEN RAISE EXCEPTION 'Dowód wykonania wymaga zatwierdzonej prywatnej walidacji' USING ERRCODE='23514';END IF;
 SELECT * INTO e FROM stock_file_import_executions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.execution_id);
 SELECT * INTO p FROM stock_file_import_previews WHERE(tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
 IF e.id IS NULL OR p.id IS NULL OR NEW.top_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.transaction_started_at IS DISTINCT FROM transaction_timestamp() OR e.top_xid IS DISTINCT FROM NEW.top_xid OR e.transaction_started_at IS DISTINCT FROM NEW.transaction_started_at OR e.preview_id IS DISTINCT FROM NEW.preview_id OR e.actor_id IS DISTINCT FROM NEW.actor_id OR e.api_key_id IS DISTINCT FROM NEW.api_key_id OR e.actor_id IS DISTINCT FROM p.actor_id OR e.api_key_id IS DISTINCT FROM p.api_key_id OR NEW.before_snapshot IS DISTINCT FROM p.payload->'snapshot' OR NEW.after_snapshot IS DISTINCT FROM e.payload->'snapshot' OR NEW.request IS DISTINCT FROM e.payload->'execute_request' OR e.client_key::text IS DISTINCT FROM NEW.request->>'client_key' OR e.scope_hash IS DISTINCT FROM p.scope_hash OR e.id::text IS DISTINCT FROM e.payload->>'id' OR e.preview_id::text IS DISTINCT FROM e.payload->>'preview_id' OR e.actor_id::text IS DISTINCT FROM e.payload->>'actor_id' OR e.api_key_id::text IS DISTINCT FROM e.payload->>'api_key_id' OR e.client_key::text IS DISTINCT FROM e.payload->>'client_key' OR e.request_hash IS DISTINCT FROM e.payload->>'request_hash' OR e.scope_hash IS DISTINCT FROM e.payload->>'scope_hash' OR e.file_name IS DISTINCT FROM e.payload->>'file_name' THEN RAISE EXCEPTION 'Dowód wykonania wymaga zatwierdzonej prywatnej walidacji' USING ERRCODE='23514';END IF;
 PERFORM stock_file_import_validate_execution(e.payload);
 RETURN NEW;
END $$;
CREATE TRIGGER stock_file_validation BEFORE INSERT OR UPDATE OR DELETE ON stock_file_import_admissions FOR EACH ROW EXECUTE FUNCTION stock_file_import_admission_validation();
CREATE TRIGGER stock_file_seal BEFORE INSERT OR UPDATE OR DELETE ON stock_file_import_epochs FOR EACH ROW EXECUTE FUNCTION stock_file_import_seal();
CREATE TRIGGER stock_file_seal BEFORE INSERT OR UPDATE OR DELETE ON stock_file_import_core_witnesses FOR EACH ROW EXECUTE FUNCTION stock_file_import_seal();
CREATE OR REPLACE FUNCTION stock_file_import_store_execution(d jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;BEGIN
 -- Both INSERT and transition roll back if independent full validation rejects.
 INSERT INTO stock_file_import_executions(id,tenant_id,preview_id,actor_id,api_key_id,client_key,request_hash,scope_hash,file_name,payload) VALUES((d->>'id')::uuid,t,(d->>'preview_id')::uuid,(d->>'actor_id')::uuid,(d->>'api_key_id')::uuid,(d->>'client_key')::uuid,d->>'request_hash',d->>'scope_hash',d->>'file_name',d);
 UPDATE stock_file_import_admissions SET after_snapshot=d->'snapshot' WHERE tenant_id=t AND execution_id=(d->>'id')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'Niekompletny cały import pomiarów' USING ERRCODE='23514';END IF;
 PERFORM stock_file_import_budget_check(t);
END $$;
CREATE OR REPLACE FUNCTION stock_file_import_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a stock_file_import_admissions%ROWTYPE;e stock_file_import_executions%ROWTYPE;p stock_file_import_previews%ROWTYPE;BEGIN
 IF TG_TABLE_NAME='stock_file_import_admissions' THEN SELECT * INTO a FROM stock_file_import_admissions WHERE(tenant_id,execution_id)=(NEW.tenant_id,NEW.execution_id);
 ELSE
  IF to_regclass('public.stock_file_import_admissions') IS NULL THEN RETURN NEW;END IF;
  SELECT adm.* INTO a FROM stock_file_import_core_witnesses w JOIN stock_file_import_admissions adm ON(adm.tenant_id,adm.preview_id)=(w.tenant_id,w.preview_id) WHERE w.tenant_id=NEW.tenant_id AND w.kind=TG_TABLE_NAME AND w.id=NEW.id AND w.top_xid=pg_current_xact_id() AND w.transaction_started_at=transaction_timestamp() AND adm.top_xid=w.top_xid AND adm.transaction_started_at=w.transaction_started_at;
  IF a.execution_id IS NULL THEN RETURN NEW;END IF;
 END IF;
 SELECT * INTO e FROM stock_file_import_executions WHERE(tenant_id,id)=(a.tenant_id,a.execution_id);
 SELECT * INTO p FROM stock_file_import_previews WHERE(tenant_id,id)=(a.tenant_id,a.preview_id);
 IF e.id IS NULL OR p.id IS NULL OR a.after_snapshot IS NULL THEN RAISE EXCEPTION 'Niekompletny cały import pomiarów' USING ERRCODE='23514';END IF;
 IF a.top_xid=pg_current_xact_id() AND a.transaction_started_at=transaction_timestamp() THEN
  -- Reuse is permitted only with every mandatory physical/private seal active.
  -- Replica-mode is disallowed even if catalog trigger flags still read O.
  IF current_setting('session_replication_role') IS DISTINCT FROM 'origin' OR EXISTS(
   SELECT 1 FROM unnest(ARRAY['products','product_sku_aliases','warehouses','stock','stock_locations','reservations','reservation_locations','wms_lots','wms_cost_layers','wms_layer_positions','wms_reservation_layers','wms_operations','wms_layer_movements','stock_movements','stock_location_movements','stock_location_operations','wms_stocktakes','wms_stocktake_lines','wms_stocktake_reviews','wms_stocktake_review_rows','wms_stocktake_postings','wms_stocktake_measurements','wms_stocktake_measurement_layers','wms_stocktake_scope_layers','inventory_bulk_edit_previews','inventory_bulk_edit_rows','inventory_bulk_edit_executions','inventory_bulk_edit_execution_rows','wms_policies','stock_file_import_epochs','stock_file_import_core_witnesses']) required_seal(table_name)
   WHERE NOT EXISTS(SELECT 1 FROM pg_trigger guard WHERE guard.tgrelid=to_regclass('public.'||required_seal.table_name) AND guard.tgname='stock_file_seal' AND guard.tgfoid='stock_file_import_seal()'::regprocedure AND guard.tgenabled IN('O','A') AND NOT guard.tgisinternal)
  ) OR NOT EXISTS(SELECT 1 FROM pg_trigger guard WHERE guard.tgrelid='stock_file_import_admissions'::regclass AND guard.tgname='stock_file_validation' AND guard.tgfoid='stock_file_import_admission_validation()'::regprocedure AND guard.tgenabled IN('O','A') AND NOT guard.tgisinternal) OR EXISTS(
   SELECT 1 FROM unnest(ARRAY['stock_file_import_previews','stock_file_import_executions']) required_immutable(table_name) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger guard WHERE guard.tgrelid=to_regclass('public.'||required_immutable.table_name) AND guard.tgname='immutable' AND guard.tgfoid='stock_file_import_immutable()'::regprocedure AND guard.tgenabled IN('O','A') AND NOT guard.tgisinternal)
  ) THEN RAISE EXCEPTION 'Walidacja importu stanów wymaga aktywnych zabezpieczeń' USING ERRCODE='23514';END IF;
  IF a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR a.before_snapshot IS DISTINCT FROM p.payload->'snapshot' OR a.after_snapshot IS DISTINCT FROM e.payload->'snapshot' OR a.request IS DISTINCT FROM e.payload->'execute_request' OR e.top_xid IS DISTINCT FROM a.top_xid OR e.transaction_started_at IS DISTINCT FROM a.transaction_started_at OR e.preview_id IS DISTINCT FROM p.id OR e.actor_id IS DISTINCT FROM a.actor_id OR e.api_key_id IS DISTINCT FROM a.api_key_id OR e.actor_id IS DISTINCT FROM p.actor_id OR e.api_key_id IS DISTINCT FROM p.api_key_id OR e.client_key::text IS DISTINCT FROM a.request->>'client_key' OR e.scope_hash IS DISTINCT FROM p.scope_hash OR e.id::text IS DISTINCT FROM e.payload->>'id' OR e.preview_id::text IS DISTINCT FROM e.payload->>'preview_id' OR e.actor_id::text IS DISTINCT FROM e.payload->>'actor_id' OR e.api_key_id::text IS DISTINCT FROM e.payload->>'api_key_id' OR e.client_key::text IS DISTINCT FROM e.payload->>'client_key' OR e.request_hash IS DISTINCT FROM e.payload->>'request_hash' OR e.scope_hash IS DISTINCT FROM e.payload->>'scope_hash' OR e.file_name IS DISTINCT FROM e.payload->>'file_name' THEN RAISE EXCEPTION 'Dowód wykonania wymaga zatwierdzonej prywatnej walidacji' USING ERRCODE='23514';END IF;
  PERFORM stock_file_import_require(a.actor_id,a.api_key_id,true);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION stock_file_import_admission_validation(),stock_file_import_complete() FROM PUBLIC,dyna_app;
-- CREATE OR REPLACE preserves the installed typed app entry-point grant.
