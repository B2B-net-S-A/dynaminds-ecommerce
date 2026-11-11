-- New commercial manifests only. No historic physical plans or recipes are backfilled.
CREATE TABLE order_parcel_commercial_origins (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,plan_id uuid NOT NULL,order_id uuid NOT NULL,
 parcel_index integer NOT NULL CHECK(parcel_index BETWEEN 0 AND 49),shipment_id uuid NOT NULL,item_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 1000000),snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,order_id),UNIQUE(tenant_id,plan_id,parcel_index,item_id),
 FOREIGN KEY(tenant_id,plan_id,order_id) REFERENCES order_parcel_plans(tenant_id,id,order_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,plan_id,parcel_index,shipment_id) REFERENCES order_parcel_allocations(tenant_id,plan_id,index,shipment_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,order_id,item_id) REFERENCES order_items(tenant_id,order_id,id)
);
CREATE TABLE order_parcel_origin_issues (
 tenant_id uuid NOT NULL,origin_id uuid NOT NULL,dispatch_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity>0),
 PRIMARY KEY(tenant_id,origin_id,dispatch_id),UNIQUE(tenant_id,origin_id),
 FOREIGN KEY(tenant_id,origin_id) REFERENCES order_parcel_commercial_origins(tenant_id,id),
 FOREIGN KEY(tenant_id,dispatch_id) REFERENCES order_parcel_dispatches(tenant_id,id)
);
CREATE TABLE order_parcel_origin_fragments (
 tenant_id uuid NOT NULL,origin_id uuid NOT NULL,dispatch_id uuid NOT NULL,fragment_id uuid NOT NULL,product_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity>0),
 PRIMARY KEY(tenant_id,origin_id,dispatch_id,fragment_id),
 FOREIGN KEY(tenant_id,origin_id,dispatch_id) REFERENCES order_parcel_origin_issues(tenant_id,origin_id,dispatch_id),
 FOREIGN KEY(tenant_id,fragment_id) REFERENCES wms_issue_fragments(tenant_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE INDEX order_parcel_commercial_order ON order_parcel_commercial_origins(tenant_id,order_id,item_id,parcel_index);
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['order_parcel_commercial_origins','order_parcel_origin_issues','order_parcel_origin_fragments'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',rel);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',rel);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',rel);
 EXECUTE format('CREATE POLICY owner_scope ON %I TO %I USING(true) WITH CHECK(true)',rel,current_user);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',rel);EXECUTE format('GRANT SELECT ON %I TO dyna_app',rel);
END LOOP;END $$;

CREATE FUNCTION order_parcel_commercial_identity(pid uuid,n integer,iid uuid) RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT(substr(h,1,8)||'-'||substr(h,9,4)||'-8'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid FROM(SELECT encode(sha256(convert_to('order.parcel.commercial:'||pid::text||':'||n::text||':'||iid::text,'UTF8')),'hex') h) hashes
$$;
CREATE FUNCTION order_parcel_commercial_recipe(v jsonb,pid uuid) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE result jsonb;BEGIN
 -- Only a historical simple empty recipe has the original product as its one component.
 IF v IS NULL OR v='null'::jsonb OR v='[]'::jsonb THEN RETURN jsonb_build_array(jsonb_build_object('product_id',pid,'quantity',1));END IF;
 IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Niepoprawna historyczna receptura pozycji' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v) part WHERE (jsonb_typeof(part)='object' AND (part->>'product_id')~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' AND jsonb_typeof(part->'quantity')='number' AND (part->>'quantity')~'^[1-9][0-9]{0,6}$' AND (part->>'quantity')::bigint<=1000000) IS NOT TRUE) THEN RAISE EXCEPTION 'Niepoprawna historyczna receptura pozycji' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v) part GROUP BY (part->>'product_id')::uuid HAVING count(*)<>1) THEN RAISE EXCEPTION 'Powtórzony składnik historycznej receptury' USING ERRCODE='23514';END IF;
 SELECT jsonb_agg(jsonb_build_object('product_id',(part->>'product_id')::uuid,'quantity',(part->>'quantity')::integer) ORDER BY (part->>'product_id')::uuid) INTO result FROM jsonb_array_elements(v) part;RETURN result;
END $$;
CREATE FUNCTION order_parcel_commercial_lines(oid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('item_id',i.id,'product_id',i.product_id,'name',i.name,'sku',i.sku,'quantity',i.quantity,'line_total',i.line_total,'vat',i.vat,'currency',o.currency,'components',order_parcel_commercial_recipe(i.components,i.product_id)) ORDER BY i.id),'[]') FROM order_items i JOIN orders o ON(o.tenant_id,o.id)=(i.tenant_id,i.order_id) WHERE i.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND i.order_id=oid
$$;
ALTER FUNCTION order_parcel_frame(uuid,uuid,jsonb,uuid,uuid) RENAME TO order_parcel_frame_physical_v1;
CREATE FUNCTION order_parcel_frame(pid uuid,oid uuid,b jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE lines jsonb;draft jsonb;item_input jsonb;line jsonb;items jsonb;products_data jsonb;physical_request jsonb;drafts jsonb:='[]';item_sets jsonb:='[]';frame_data jsonb;out_parcels jsonb:='[]';entry_count integer:=0;parcel_idx integer:=0;
BEGIN
 IF NOT b?'protocol' THEN RETURN order_parcel_frame_physical_v1(pid,oid,b,uid,kid);END IF;
 PERFORM order_parcel_require(uid,kid,true,false);PERFORM order_parcel_lock(oid);
 IF b->>'protocol' IS DISTINCT FROM 'commercial_v1' OR (b-ARRAY['client_key','order_version','protocol','parcels'])<>'{}' OR jsonb_typeof(b->'parcels') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Niepoprawny protokół handlowy paczek' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(b->'parcels') NOT BETWEEN 2 AND 50 THEN RAISE EXCEPTION 'Niepoprawna liczba paczek' USING ERRCODE='23514';END IF;
 lines:=order_parcel_commercial_lines(oid);IF jsonb_array_length(lines)=0 THEN RAISE EXCEPTION 'Brak historycznych pozycji zamówienia' USING ERRCODE='23514';END IF;
 FOR draft IN SELECT value FROM jsonb_array_elements(b->'parcels') LOOP
  IF (draft-ARRAY['source_kind','shipment_id','cod_minor','items'])<>'{}' OR jsonb_typeof(draft->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Niepoprawny przydział handlowy paczki' USING ERRCODE='23514';END IF;
  IF jsonb_array_length(draft->'items') NOT BETWEEN 1 AND 500 OR EXISTS(SELECT 1 FROM jsonb_array_elements(draft->'items') input_item GROUP BY (input_item->>'item_id')::uuid HAVING count(*)<>1) THEN RAISE EXCEPTION 'Paczka wymaga unikalnych pozycji handlowych' USING ERRCODE='23514';END IF;
  items:='[]';entry_count:=entry_count+jsonb_array_length(draft->'items');IF entry_count>500 THEN RAISE EXCEPTION 'Zbyt wiele pozycji handlowych' USING ERRCODE='23514';END IF;
  FOR item_input IN SELECT value FROM jsonb_array_elements(draft->'items') ORDER BY value->>'item_id' LOOP
   IF (jsonb_typeof(item_input)='object' AND (item_input-ARRAY['item_id','quantity'])='{}' AND jsonb_typeof(item_input->'quantity')='number' AND (item_input->>'quantity')~'^[1-9][0-9]{0,6}$' AND (item_input->>'quantity')::bigint<=1000000) IS NOT TRUE THEN RAISE EXCEPTION 'Niepoprawna ilość handlowa paczki' USING ERRCODE='23514';END IF;
   SELECT value INTO line FROM jsonb_array_elements(lines) WHERE value->>'item_id'=(item_input->>'item_id')::uuid::text;
   IF line IS NULL THEN RAISE EXCEPTION 'Pozycja nie należy do zamówienia' USING ERRCODE='23514';END IF;
   items:=items||jsonb_build_array((line-'quantity')||jsonb_build_object('original_quantity',line->'quantity','quantity',item_input->'quantity'));
  END LOOP;
  SELECT jsonb_agg(jsonb_build_object('product_id',part_id,'quantity',part_qty) ORDER BY part_id) INTO products_data FROM(SELECT (component->>'product_id')::uuid part_id,sum((component->>'quantity')::bigint*(it->>'quantity')::bigint) part_qty FROM jsonb_array_elements(items) it CROSS JOIN LATERAL jsonb_array_elements(it->'components') component GROUP BY (component->>'product_id')::uuid) physical;
  drafts:=drafts||jsonb_build_array((draft-'items')||jsonb_build_object('products',products_data));item_sets:=item_sets||jsonb_build_array(items);
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(lines) source_line WHERE (source_line->>'quantity')::bigint IS DISTINCT FROM (SELECT sum((item_value->>'quantity')::bigint) FROM jsonb_array_elements(item_sets) parcel_items CROSS JOIN LATERAL jsonb_array_elements(parcel_items) item_value WHERE item_value->>'item_id'=source_line->>'item_id')) THEN RAISE EXCEPTION 'Paczki muszą dokładnie pokrywać każdą pozycję handlową' USING ERRCODE='23514';END IF;
 physical_request:=(b-ARRAY['protocol','parcels'])||jsonb_build_object('parcels',drafts);frame_data:=order_parcel_frame_physical_v1(pid,oid,physical_request,uid,kid);
 FOR draft IN SELECT value FROM jsonb_array_elements(frame_data->'parcels') LOOP
  out_parcels:=out_parcels||jsonb_build_array(draft||jsonb_build_object('items',item_sets->parcel_idx));parcel_idx:=parcel_idx+1;
 END LOOP;
 RETURN frame_data||jsonb_build_object('protocol','commercial_v1','source',(frame_data->'source')||jsonb_build_object('commercial_lines',lines),'parcels',out_parcels,'summary',(frame_data->'summary')||jsonb_build_object('commercial_quantity',(SELECT sum((value->>'quantity')::bigint) FROM jsonb_array_elements(lines)),'commercial_entries',entry_count));
END $$;

CREATE FUNCTION order_parcel_commercial_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE admission order_parcel_admissions;it jsonb;parent order_parcel_plans;
BEGIN
 IF TG_TABLE_NAME='order_parcel_allocations' THEN
  SELECT * INTO admission FROM order_parcel_admissions WHERE tenant_id=NEW.tenant_id AND transaction_id=pg_current_xact_id() AND kind='apply' AND plan_id=NEW.plan_id;
  IF admission.payload->>'protocol' IS DISTINCT FROM 'commercial_v1' THEN RETURN NEW;END IF;
  FOR it IN SELECT value FROM jsonb_array_elements(NEW.payload->'items') LOOP
   INSERT INTO order_parcel_commercial_origins(id,tenant_id,plan_id,order_id,parcel_index,shipment_id,item_id,quantity,snapshot) VALUES(order_parcel_commercial_identity(NEW.plan_id,NEW.index,(it->>'item_id')::uuid),NEW.tenant_id,NEW.plan_id,NEW.order_id,NEW.index,NEW.shipment_id,(it->>'item_id')::uuid,(it->>'quantity')::integer,it);
  END LOOP;
 ELSE
  SELECT * INTO parent FROM order_parcel_plans WHERE tenant_id=NEW.tenant_id AND id=NEW.plan_id;
  IF parent.payload->>'protocol' IS DISTINCT FROM 'commercial_v1' THEN RETURN NEW;END IF;
  INSERT INTO order_parcel_origin_issues(tenant_id,origin_id,dispatch_id,quantity) SELECT tenant_id,id,NEW.id,quantity FROM order_parcel_commercial_origins WHERE tenant_id=NEW.tenant_id AND plan_id=NEW.plan_id AND parcel_index=NEW.parcel_index ORDER BY item_id;
  -- Intersect two cumulative quantity intervals for each product. This splits a
  -- genuinely shared FIFO fragment once, at dispatch, with an exact partition.
  INSERT INTO order_parcel_origin_fragments(tenant_id,origin_id,dispatch_id,fragment_id,product_id,quantity)
  WITH demands AS(SELECT o.id origin_id,o.item_id,(part->>'product_id')::uuid product_id,o.quantity::bigint*(part->>'quantity')::bigint q FROM order_parcel_commercial_origins o CROSS JOIN LATERAL jsonb_array_elements(o.snapshot->'components') part WHERE o.tenant_id=NEW.tenant_id AND o.plan_id=NEW.plan_id AND o.parcel_index=NEW.parcel_index),
  demand_ranges AS(SELECT *,sum(q) OVER(PARTITION BY product_id ORDER BY item_id,origin_id)-q lo,sum(q) OVER(PARTITION BY product_id ORDER BY item_id,origin_id) hi FROM demands),
  fragment_ranges AS(SELECT f.id fragment_id,f.product_id,f.quantity,sum(f.quantity::bigint) OVER(PARTITION BY f.product_id ORDER BY f.id)-f.quantity lo,sum(f.quantity::bigint) OVER(PARTITION BY f.product_id ORDER BY f.id) hi FROM wms_issue_fragments f WHERE f.tenant_id=NEW.tenant_id AND f.operation_id=NEW.id AND f.order_id=NEW.order_id)
  SELECT NEW.tenant_id,d.origin_id,NEW.id,f.fragment_id,d.product_id,(least(d.hi,f.hi)-greatest(d.lo,f.lo))::integer FROM demand_ranges d JOIN fragment_ranges f ON f.product_id=d.product_id AND least(d.hi,f.hi)>greatest(d.lo,f.lo);
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER order_parcel_commercial_record AFTER INSERT ON order_parcel_allocations FOR EACH ROW EXECUTE FUNCTION order_parcel_commercial_record();
CREATE TRIGGER order_parcel_commercial_record AFTER INSERT ON order_parcel_dispatches FOR EACH ROW EXECUTE FUNCTION order_parcel_commercial_record();

CREATE FUNCTION order_parcel_commercial_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE origin_row order_parcel_commercial_origins;admission order_parcel_admissions;dispatch_row order_parcel_dispatches;fragment_row wms_issue_fragments;BEGIN
 IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Pochodzenie handlowe paczki jest niezmienne i wymaga rzeczywistej operacji' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='order_parcel_commercial_origins' THEN
  SELECT * INTO admission FROM order_parcel_admissions WHERE tenant_id=NEW.tenant_id AND transaction_id=pg_current_xact_id() AND kind='apply' AND plan_id=NEW.plan_id AND order_id=NEW.order_id;
  IF admission.operation_id IS NULL OR admission.payload->>'protocol' IS DISTINCT FROM 'commercial_v1' OR NEW.id IS DISTINCT FROM order_parcel_commercial_identity(NEW.plan_id,NEW.parcel_index,NEW.item_id) OR NEW.shipment_id IS DISTINCT FROM(admission.payload->'parcels'->NEW.parcel_index->>'shipment_id')::uuid OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(admission.payload->'parcels'->NEW.parcel_index->'items') it WHERE it=NEW.snapshot AND it->>'item_id'=NEW.item_id::text AND (it->>'quantity')::integer=NEW.quantity) THEN RAISE EXCEPTION 'Origin nie odpowiada świeżej zgodzie handlowej' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO origin_row FROM order_parcel_commercial_origins WHERE tenant_id=NEW.tenant_id AND id=NEW.origin_id;
  SELECT * INTO dispatch_row FROM order_parcel_dispatches WHERE tenant_id=NEW.tenant_id AND id=NEW.dispatch_id;
  SELECT * INTO admission FROM order_parcel_admissions WHERE tenant_id=NEW.tenant_id AND transaction_id=pg_current_xact_id() AND kind='dispatch' AND operation_id=NEW.dispatch_id;
  IF origin_row.id IS NULL OR admission.operation_id IS NULL OR (origin_row.plan_id,origin_row.order_id,origin_row.parcel_index,origin_row.shipment_id) IS DISTINCT FROM(dispatch_row.plan_id,dispatch_row.order_id,dispatch_row.parcel_index,dispatch_row.shipment_id) THEN RAISE EXCEPTION 'Wydany origin wymaga rzeczywistego bieżącego dispatchu' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='order_parcel_origin_issues' THEN
   IF NEW.quantity IS DISTINCT FROM origin_row.quantity THEN RAISE EXCEPTION 'Wydano niepełną jednostkę handlową' USING ERRCODE='23514';END IF;
  ELSE
   SELECT * INTO fragment_row FROM wms_issue_fragments WHERE tenant_id=NEW.tenant_id AND id=NEW.fragment_id;
   IF (fragment_row.operation_id,fragment_row.order_id,fragment_row.product_id) IS DISTINCT FROM(NEW.dispatch_id,origin_row.order_id,NEW.product_id) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(origin_row.snapshot->'components') part WHERE part->>'product_id'=NEW.product_id::text) THEN RAISE EXCEPTION 'Fragment nie jest rzeczywistym wydaniem składnika originu' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;

CREATE FUNCTION order_parcel_commercial_validate(pid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;parent order_parcel_plans;BEGIN
 SELECT * INTO parent FROM order_parcel_plans WHERE tenant_id=t AND id=pid;
 IF parent.payload->>'protocol' IS DISTINCT FROM 'commercial_v1' THEN
  IF EXISTS(SELECT 1 FROM order_parcel_commercial_origins WHERE tenant_id=t AND plan_id=pid) THEN RAISE EXCEPTION 'Stary plan nie ma dopisanego pochodzenia handlowego' USING ERRCODE='23514';END IF;RETURN;
 END IF;
 IF (SELECT count(*) FROM order_parcel_commercial_origins WHERE tenant_id=t AND plan_id=pid) IS DISTINCT FROM(SELECT count(*) FROM jsonb_array_elements(parent.payload->'parcels') parcel CROSS JOIN LATERAL jsonb_array_elements(parcel->'items')) OR EXISTS(SELECT 1 FROM order_parcel_commercial_origins o WHERE o.tenant_id=t AND o.plan_id=pid AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(parent.payload->'parcels'->o.parcel_index->'items') it WHERE it=o.snapshot AND (it->>'quantity')::integer=o.quantity AND it->>'item_id'=o.item_id::text)) THEN RAISE EXCEPTION 'Plan nie ma dokładnej bijekcji originów handlowych' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM order_parcel_commercial_origins o LEFT JOIN order_parcel_dispatches d ON(d.tenant_id,d.plan_id,d.parcel_index)=(o.tenant_id,o.plan_id,o.parcel_index) LEFT JOIN order_parcel_origin_issues issue ON(issue.tenant_id,issue.origin_id)=(o.tenant_id,o.id) WHERE o.tenant_id=t AND o.plan_id=pid AND((d.id IS NULL) IS DISTINCT FROM(issue.dispatch_id IS NULL) OR issue.dispatch_id IS DISTINCT FROM d.id OR (d.id IS NOT NULL AND issue.quantity IS DISTINCT FROM o.quantity))) THEN RAISE EXCEPTION 'Handlowe wydania nie odpowiadają rzeczywistym dispatchom' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM order_parcel_dispatches d JOIN order_parcel_commercial_origins o ON(o.tenant_id,o.plan_id,o.parcel_index)=(d.tenant_id,d.plan_id,d.parcel_index) CROSS JOIN LATERAL jsonb_array_elements(o.snapshot->'components') part WHERE d.tenant_id=t AND d.plan_id=pid AND d.receipt->'wms' IS NOT NULL AND d.receipt->'wms'<>'null'::jsonb AND o.quantity::bigint*(part->>'quantity')::bigint IS DISTINCT FROM(SELECT coalesce(sum(m.quantity),0) FROM order_parcel_origin_fragments m WHERE m.tenant_id=t AND m.origin_id=o.id AND m.dispatch_id=d.id AND m.product_id=(part->>'product_id')::uuid)) OR EXISTS(SELECT 1 FROM order_parcel_dispatches d JOIN wms_issue_fragments f ON(f.tenant_id,f.operation_id)=(d.tenant_id,d.id) WHERE d.tenant_id=t AND d.plan_id=pid AND f.quantity::bigint IS DISTINCT FROM(SELECT coalesce(sum(m.quantity),0) FROM order_parcel_origin_fragments m WHERE m.tenant_id=t AND m.dispatch_id=d.id AND m.fragment_id=f.id)) OR EXISTS(SELECT 1 FROM order_parcel_origin_fragments m JOIN order_parcel_dispatches d ON(d.tenant_id,d.id)=(m.tenant_id,m.dispatch_id) WHERE d.tenant_id=t AND d.plan_id=pid AND (d.receipt->'wms' IS NULL OR d.receipt->'wms'='null'::jsonb)) THEN RAISE EXCEPTION 'Mapy fragmentów muszą dokładnie partycjonować rzeczywiste wydanie' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION order_parcel_commercial_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pid uuid;BEGIN
 IF TG_TABLE_NAME IN('order_parcel_plans','order_parcel_dispatches','order_parcel_commercial_origins') THEN
  IF TG_TABLE_NAME='order_parcel_plans' THEN pid:=NEW.id;ELSE pid:=NEW.plan_id;END IF;
 ELSE SELECT plan_id INTO pid FROM order_parcel_commercial_origins WHERE tenant_id=NEW.tenant_id AND id=NEW.origin_id;END IF;
 PERFORM order_parcel_commercial_validate(pid);PERFORM order_parcel_budget();RETURN NULL;
END $$;
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['order_parcel_commercial_origins','order_parcel_origin_issues','order_parcel_origin_fragments'] LOOP
 EXECUTE format('CREATE TRIGGER order_parcel_commercial_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION order_parcel_commercial_guard()',rel);
END LOOP;
FOREACH rel IN ARRAY ARRAY['order_parcel_plans','order_parcel_dispatches','order_parcel_commercial_origins','order_parcel_origin_issues','order_parcel_origin_fragments'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER order_parcel_commercial_complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_parcel_commercial_complete()',rel);
END LOOP;END $$;

ALTER FUNCTION order_parcel_budget() RENAME TO order_parcel_budget_physical_v1;
CREATE FUNCTION order_parcel_budget() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;bytes bigint;BEGIN
 PERFORM order_parcel_budget_physical_v1();
 SELECT coalesce(sum(n),0) INTO bytes FROM(
 SELECT octet_length(to_jsonb(p)::text) n FROM order_parcel_previews p WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(p)::text) FROM order_parcel_plans p WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(p)::text) FROM order_parcel_allocations p WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(p)::text) FROM order_parcel_dispatches p WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(p)::text) FROM order_parcel_admissions p WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(p)::text) FROM order_parcel_commercial_origins p WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(p)::text) FROM order_parcel_origin_issues p WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(p)::text) FROM order_parcel_origin_fragments p WHERE tenant_id=t) evidence;
 IF bytes>67108864 THEN RAISE EXCEPTION 'Limit danych paczek' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION order_parcel_commercial_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$SELECT EXISTS(SELECT 1 FROM migrations WHERE name='136_order_parcel_commercial_origins')$$;
CREATE FUNCTION order_parcel_commercial_guards() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rel text;BEGIN
 FOREACH rel IN ARRAY ARRAY['order_parcel_commercial_origins','order_parcel_origin_issues','order_parcel_origin_fragments'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(rel) AND relrowsecurity AND relforcerowsecurity) THEN RETURN false;END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(rel) AND tgname='order_parcel_commercial_guard' AND tgfoid=to_regprocedure('order_parcel_commercial_guard()') AND tgenabled='O' AND NOT tgisinternal) OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(rel) AND tgname='order_parcel_commercial_complete' AND tgfoid=to_regprocedure('order_parcel_commercial_complete()') AND tgenabled='O' AND tgdeferrable AND tginitdeferred AND NOT tgisinternal) THEN RETURN false;END IF;
  IF has_table_privilege('dyna_app',rel,'INSERT,UPDATE,DELETE') THEN RETURN false;END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_commercial_identity(uuid,integer,uuid)','order_parcel_commercial_recipe(jsonb,uuid)','order_parcel_commercial_lines(uuid)','order_parcel_commercial_record()','order_parcel_commercial_guard()','order_parcel_commercial_validate(uuid)','order_parcel_commercial_complete()','order_parcel_frame_physical_v1(uuid,uuid,jsonb,uuid,uuid)','order_parcel_budget_physical_v1()','order_parcel_guards_physical_v1()','order_parcel_commercial_installed()']) signature WHERE to_regprocedure(signature) IS NULL) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_allocations','order_parcel_dispatches']) relname WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(relname) AND tgname='order_parcel_commercial_record' AND tgfoid=to_regprocedure('order_parcel_commercial_record()') AND tgenabled='O' AND NOT tgisinternal)) OR EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_plans','order_parcel_dispatches']) relname WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(relname) AND tgname='order_parcel_commercial_complete' AND tgfoid=to_regprocedure('order_parcel_commercial_complete()') AND tgenabled='O' AND tgdeferrable AND tginitdeferred AND NOT tgisinternal)) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM(VALUES('order_parcel_commercial_origins','order_parcel_plans',ARRAY['tenant_id','plan_id','order_id']),('order_parcel_commercial_origins','order_parcel_allocations',ARRAY['tenant_id','plan_id','parcel_index','shipment_id']),('order_parcel_commercial_origins','order_items',ARRAY['tenant_id','order_id','item_id']),('order_parcel_origin_issues','order_parcel_commercial_origins',ARRAY['tenant_id','origin_id']),('order_parcel_origin_issues','order_parcel_dispatches',ARRAY['tenant_id','dispatch_id']),('order_parcel_origin_fragments','order_parcel_origin_issues',ARRAY['tenant_id','origin_id','dispatch_id']),('order_parcel_origin_fragments','wms_issue_fragments',ARRAY['tenant_id','fragment_id']),('order_parcel_origin_fragments','products',ARRAY['tenant_id','product_id'])) required(relname,parent,cols) WHERE NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass(required.relname) AND c.confrelid=to_regclass(required.parent) AND c.contype='f' AND c.convalidated AND(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(att,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.att)=required.cols)) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_frame_physical_v1(uuid,uuid,jsonb,uuid,uuid)','order_parcel_budget_physical_v1()','order_parcel_guards_physical_v1()','order_parcel_commercial_validate(uuid)','order_parcel_commercial_identity(uuid,integer,uuid)','order_parcel_commercial_recipe(jsonb,uuid)']) signature WHERE has_function_privilege('dyna_app',to_regprocedure(signature),'EXECUTE')) THEN RETURN false;END IF;
 RETURN current_setting('session_replication_role')='origin';
END $$;
ALTER FUNCTION order_parcel_guards() RENAME TO order_parcel_guards_physical_v1;
CREATE FUNCTION order_parcel_guards() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$SELECT order_parcel_guards_physical_v1() AND order_parcel_commercial_guards()$$;
DO $$DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND(proname LIKE 'order_parcel_commercial_%' OR proname IN('order_parcel_frame_physical_v1','order_parcel_budget_physical_v1','order_parcel_guards_physical_v1','order_parcel_frame','order_parcel_budget','order_parcel_guards')) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.signature);END LOOP;END $$;
GRANT EXECUTE ON FUNCTION order_parcel_commercial_installed(),order_parcel_commercial_guards(),order_parcel_commercial_lines(uuid),order_parcel_guards() TO dyna_app;
