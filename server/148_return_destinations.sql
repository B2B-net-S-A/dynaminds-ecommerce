-- SOURCE CANDIDATE: not registered until the complete legacy/core integration is verified.
-- No backfill, new cash ledger or second assistant receipt. One immutable139 parent.
CREATE TABLE return_destination_parts (
 tenant_id uuid NOT NULL REFERENCES tenants,id uuid NOT NULL,receipt_id uuid NOT NULL,preview_id uuid NOT NULL,
 session_id uuid NOT NULL,return_id uuid NOT NULL,order_id uuid NOT NULL,item_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100000),status_id uuid NOT NULL,status_version bigint NOT NULL CHECK(status_version>0),
 status_revision_id uuid NOT NULL,decision text NOT NULL CHECK(decision IN('accept','reject')),
 effect text NOT NULL CHECK(effect IN('sale','custody','none')),warehouse_id uuid,warehouse_policy_version bigint,
 refund_minor bigint NOT NULL CHECK(refund_minor>=0),snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 PRIMARY KEY(tenant_id,receipt_id,id),UNIQUE(tenant_id,receipt_id,id,return_id,order_id,item_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES return_assistant_receipts(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,preview_id,session_id,return_id) REFERENCES return_assistant_previews(tenant_id,id,session_id,return_id),
 FOREIGN KEY(tenant_id,return_id,item_id) REFERENCES return_items(tenant_id,return_id,item_id),
 FOREIGN KEY(tenant_id,order_id,item_id) REFERENCES order_items(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,status_id,status_version,status_revision_id) REFERENCES return_destination_status_revisions(tenant_id,status_id,version,id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 CHECK((decision='reject' AND effect='none' AND warehouse_id IS NULL AND warehouse_policy_version IS NULL AND refund_minor=0)
 OR(decision='accept' AND effect IN('sale','custody') AND warehouse_id IS NOT NULL AND warehouse_policy_version IS NOT NULL AND warehouse_policy_version>=0))
);
CREATE TABLE return_destination_arrivals (
 tenant_id uuid NOT NULL,id uuid NOT NULL,receipt_id uuid NOT NULL,part_id uuid NOT NULL,return_id uuid NOT NULL,order_id uuid NOT NULL,item_id uuid NOT NULL,
 product_id uuid NOT NULL,warehouse_id uuid NOT NULL,location text NOT NULL CHECK(length(location) BETWEEN 1 AND 80 AND location=btrim(location) AND location!~'[[:cntrl:]]'),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000000),effect text NOT NULL CHECK(effect IN('sale','custody')),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,receipt_id,part_id,product_id),
 UNIQUE(tenant_id,id,receipt_id,part_id,return_id,order_id,item_id,product_id,warehouse_id,location),
 FOREIGN KEY(tenant_id,receipt_id,part_id,return_id,order_id,item_id) REFERENCES return_destination_parts(tenant_id,receipt_id,id,return_id,order_id,item_id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE TABLE return_destination_fragments (
 tenant_id uuid NOT NULL,receipt_id uuid NOT NULL,arrival_id uuid NOT NULL,part_id uuid NOT NULL,return_id uuid NOT NULL,order_id uuid NOT NULL,item_id uuid NOT NULL,
 product_id uuid NOT NULL,warehouse_id uuid NOT NULL,location text NOT NULL,fragment_id uuid NOT NULL,issue_fragment_id uuid NOT NULL,layer_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000000),effect text NOT NULL CHECK(effect IN('sale','custody')),
 PRIMARY KEY(tenant_id,fragment_id),UNIQUE(tenant_id,receipt_id,part_id,issue_fragment_id,location),
 FOREIGN KEY(tenant_id,arrival_id,receipt_id,part_id,return_id,order_id,item_id,product_id,warehouse_id,location)
 REFERENCES return_destination_arrivals(tenant_id,id,receipt_id,part_id,return_id,order_id,item_id,product_id,warehouse_id,location),
 FOREIGN KEY(tenant_id,fragment_id) REFERENCES wms_return_fragments(tenant_id,id),
 FOREIGN KEY(tenant_id,issue_fragment_id,order_id,product_id,layer_id) REFERENCES wms_issue_fragments(tenant_id,id,order_id,product_id,layer_id)
);
CREATE TABLE return_destination_admissions (
 tenant_id uuid NOT NULL,receipt_id uuid NOT NULL,preview_id uuid NOT NULL,session_id uuid NOT NULL,return_id uuid NOT NULL,order_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,transaction_id xid8 NOT NULL,backend_pid integer NOT NULL,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),request jsonb NOT NULL,
 payload jsonb NOT NULL,before_snapshot jsonb NOT NULL,after_snapshot jsonb,witnesses jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(witnesses)='array'),
 opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,receipt_id),UNIQUE(tenant_id,transaction_id,receipt_id),UNIQUE(tenant_id,return_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES return_assistant_receipts(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,preview_id,session_id,return_id) REFERENCES return_assistant_previews(tenant_id,id,session_id,return_id),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX return_destination_arrival_receipt ON return_destination_arrivals(tenant_id,receipt_id);
CREATE INDEX return_destination_fragment_issue ON return_destination_fragments(tenant_id,issue_fragment_id);
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['return_destination_parts','return_destination_arrivals','return_destination_fragments','return_destination_admissions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',rel);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',rel);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',rel);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',rel);
END LOOP;END $$;

CREATE FUNCTION return_destination_identity(parent uuid,scope text) RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT(substr(h,1,8)||'-'||substr(h,9,4)||'-8'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid
 FROM(SELECT encode(sha256(convert_to('return.destination:'||parent::text||':'||scope,'UTF8')),'hex') h)z
$$;
CREATE FUNCTION return_destination_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.migrations WHERE name='148_return_destinations')
$$;
CREATE FUNCTION return_destination_number(v jsonb,positive boolean DEFAULT false) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN jsonb_typeof(v)='number' AND v::text~'^(0|[1-9][0-9]*)$' AND length(v::text)<=10
 THEN v::text::numeric BETWEEN CASE WHEN positive THEN 1 ELSE 0 END AND 2147483647 ELSE false END
$$;
CREATE FUNCTION return_destination_request_valid(b jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE r jsonb;BEGIN
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR b-ARRAY['protocol','client_key','return_version','session_id','session_version','lease_token','note','parts','locations','stock_versions','wms_lots','shipping_refund']<>'{}'
 OR NOT b ?& ARRAY['protocol','client_key','return_version','session_id','session_version','lease_token','note','parts','locations','stock_versions','shipping_refund']
 OR b->>'protocol' IS DISTINCT FROM 'destinations_v1' OR jsonb_typeof(b->'note') IS DISTINCT FROM 'string' OR length(b->>'note') NOT BETWEEN 3 AND 2000
 OR jsonb_typeof(b->'parts') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'parts') NOT BETWEEN 1 AND 200
 OR jsonb_typeof(b->'locations') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'locations')>500
 OR jsonb_typeof(b->'stock_versions') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'stock_versions')>500
 OR NOT public.return_destination_number(b->'shipping_refund') OR(b->>'shipping_refund')::numeric>1000000 THEN RETURN false;END IF;
 FOREACH r IN ARRAY ARRAY[b->'client_key',b->'session_id',b->'lease_token'] LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'string' OR r#>>'{}' !~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false;END IF;
 END LOOP;
 FOREACH r IN ARRAY ARRAY[b->'return_version',b->'session_version'] LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'string' OR r#>>'{}' !~'^[1-9][0-9]{0,18}$' OR(r#>>'{}')::numeric>=9223372036854775807 THEN RETURN false;END IF;
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(b->'parts') LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r-ARRAY['part_id','item_id','quantity','status_id','status_version']<>'{}' OR NOT r ?& ARRAY['part_id','item_id','quantity','status_id','status_version']
  OR NOT public.return_destination_number(r->'quantity',true) OR(r->>'quantity')::numeric>100000
  OR coalesce(r->>'part_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR coalesce(r->>'item_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR coalesce(r->>'status_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR jsonb_typeof(r->'status_version') IS DISTINCT FROM 'string' OR coalesce(r->>'status_version','')!~'^[1-9][0-9]{0,18}$' OR(r->>'status_version')::numeric>9223372036854775807 THEN RETURN false;END IF;
 END LOOP;
 IF(SELECT count(DISTINCT x->>'part_id') FROM jsonb_array_elements(b->'parts')x)<>jsonb_array_length(b->'parts') THEN RETURN false;END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(b->'locations') LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r-ARRAY['part_id','product_id','location','confirmed']<>'{}' OR NOT r ?& ARRAY['part_id','product_id','location','confirmed'] OR r->'confirmed' IS DISTINCT FROM 'true'::jsonb
  OR coalesce(r->>'part_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR coalesce(r->>'product_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR jsonb_typeof(r->'location') IS DISTINCT FROM 'string' OR length(r->>'location') NOT BETWEEN 1 AND 80 OR r->>'location'<>btrim(r->>'location') OR r->>'location'~'[[:cntrl:]]' THEN RETURN false;END IF;
 END LOOP;
 IF(SELECT count(DISTINCT(x->>'part_id',x->>'product_id')) FROM jsonb_array_elements(b->'locations')x)<>jsonb_array_length(b->'locations') THEN RETURN false;END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(b->'stock_versions') LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r-ARRAY['warehouse_id','product_id','version']<>'{}' OR NOT r ?& ARRAY['warehouse_id','product_id','version']
  OR coalesce(r->>'warehouse_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR coalesce(r->>'product_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR jsonb_typeof(r->'version') IS DISTINCT FROM 'string' OR coalesce(r->>'version','')!~'^(0|[1-9][0-9]{0,18})$' OR(r->>'version')::numeric>9223372036854775807 THEN RETURN false;END IF;
 END LOOP;
 IF(SELECT count(DISTINCT(x->>'warehouse_id',x->>'product_id')) FROM jsonb_array_elements(b->'stock_versions')x)<>jsonb_array_length(b->'stock_versions') THEN RETURN false;END IF;
 IF b ? 'wms_lots' THEN
  IF jsonb_typeof(b->'wms_lots') IS DISTINCT FROM 'object' OR(b->'wms_lots')-ARRAY['policy_version','picks']<>'{}' OR NOT(b->'wms_lots')?&ARRAY['policy_version','picks']
  OR jsonb_typeof(b->'wms_lots'->'policy_version') IS DISTINCT FROM 'string' OR coalesce(b->'wms_lots'->>'policy_version','')!~'^[1-9][0-9]{0,18}$' OR(b->'wms_lots'->>'policy_version')::numeric>9223372036854775807
  OR jsonb_typeof(b->'wms_lots'->'picks') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'wms_lots'->'picks')>500 THEN RETURN false;END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(b->'wms_lots'->'picks') LOOP
   IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r-ARRAY['part_id','issue_fragment_id','quantity','location']<>'{}' OR NOT r?&ARRAY['part_id','issue_fragment_id','quantity','location']
   OR NOT public.return_destination_number(r->'quantity',true) OR coalesce(r->>'part_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR coalesce(r->>'issue_fragment_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(r->'location') IS DISTINCT FROM 'string' OR length(r->>'location') NOT BETWEEN 1 AND 80 OR r->>'location'<>btrim(r->>'location') OR r->>'location'~'[[:cntrl:]]' THEN RETURN false;END IF;
  END LOOP;
  IF(SELECT count(DISTINCT(x->>'part_id',x->>'issue_fragment_id',x->>'location')) FROM jsonb_array_elements(b->'wms_lots'->'picks')x)<>jsonb_array_length(b->'wms_lots'->'picks') THEN RETURN false;END IF;
 END IF;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN false;
END $$;

CREATE FUNCTION return_destination_physical_validate(eid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;a public.return_destination_admissions;cur jsonb;nm text;old_rows jsonb;new_rows jsonb;expected jsonb;actual jsonb;wr jsonb;live jsonb;cell jsonb;rec record;want_qty bigint;want_updates bigint;before_row jsonb;after_row jsonb;op public.wms_operations;expected_request jsonb;rc public.return_cases;all_accepted boolean;BEGIN
 SELECT * INTO a FROM public.return_destination_admissions WHERE(tenant_id,receipt_id,transaction_id,backend_pid)=(t,eid,pg_current_xact_id(),pg_backend_pid());
 IF a.receipt_id IS NULL OR a.before_snapshot='{}' THEN RAISE EXCEPTION 'Fizyka wymaga rzeczywistej bieżącej zgody' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.wms_issue_fragments f WHERE(f.tenant_id,f.operation_id)=(t,eid)) THEN RAISE EXCEPTION 'Przyjęcie do celów nie może tworzyć fragmentu wydania' USING ERRCODE='23514';END IF;
 cur:=public.return_destination_snapshot(eid);
 SELECT * INTO rc FROM public.return_cases WHERE(tenant_id,id)=(t,a.return_id);
 IF rc.id IS NULL OR rc.version IS DISTINCT FROM(a.payload->'receive_input'->>'version')::bigint+1 OR rc.decision_note IS DISTINCT FROM a.payload->'receive_input'->>'note' THEN RAISE EXCEPTION 'Przyjęcie nie ma rzeczywistego wyniku core' USING ERRCODE='23514';END IF;
 IF a.payload->>'action'='receive' THEN
  IF rc.state IS DISTINCT FROM 'refund_pending' OR rc.receipt IS DISTINCT FROM a.payload->'receive_input' OR rc.received_at IS NULL OR rc.received_at<transaction_timestamp() OR rc.refund_amount IS DISTINCT FROM(a.payload->'plan'->'summary'->>'commercial_credit_minor')::bigint OR rc.refunded_shipping IS DISTINCT FROM(a.payload->'plan'->'summary'->>'shipping_refund_minor')::bigint OR rc.receipt_sequence IS DISTINCT FROM(a.payload->'snapshot'->'source'->>'next_receipt_sequence')::int THEN RAISE EXCEPTION 'Core ma inne ilości lub finansowy wynik przyjęcia' USING ERRCODE='23514';END IF;
 ELSE IF rc.state IS DISTINCT FROM 'rejected' OR rc.receipt IS NOT NULL OR rc.received_at IS NOT NULL OR rc.refund_amount<>0 OR rc.refunded_shipping<>0 THEN RAISE EXCEPTION 'Odrzucenie nie może przyjmować ani zwracać pieniędzy' USING ERRCODE='23514';END IF;END IF;
 FOR rec IN SELECT b,c FROM jsonb_array_elements(a.before_snapshot->'return_cases')b FULL JOIN jsonb_array_elements(cur->'return_cases')c ON b->>'id'=c->>'id' LOOP
  IF rec.b IS NULL OR rec.c IS NULL OR(rec.b->>'id'<>a.return_id::text AND rec.b IS DISTINCT FROM rec.c) OR(rec.b->>'id'=a.return_id::text AND rec.b-ARRAY['state','received_at','receipt','receipt_sequence','refunded_shipping','refund_amount','decision_note','version','updated_at'] IS DISTINCT FROM rec.c-ARRAY['state','received_at','receipt','receipt_sequence','refunded_shipping','refund_amount','decision_note','version','updated_at']) THEN RAISE EXCEPTION 'Przyjęcie zmieniło niezatwierdzony nagłówek RMA' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR rec IN SELECT b,c FROM jsonb_array_elements(a.before_snapshot->'return_items')b FULL JOIN jsonb_array_elements(cur->'return_items')c ON(b->>'return_id',b->>'item_id')=(c->>'return_id',c->>'item_id') LOOP
  IF rec.b IS NULL OR rec.c IS NULL OR(rec.b->>'return_id'<>a.return_id::text AND rec.b IS DISTINCT FROM rec.c) OR(rec.b->>'return_id'=a.return_id::text AND rec.b-ARRAY['accepted','restocked','refund_amount'] IS DISTINCT FROM rec.c-ARRAY['accepted','restocked','refund_amount']) THEN RAISE EXCEPTION 'Historyczna pozycja lub receptura RMA zmieniła się' USING ERRCODE='23514';END IF;
  IF rec.b->>'return_id'=a.return_id::text THEN
   SELECT x INTO expected FROM jsonb_array_elements(a.payload->'plan'->'decisions')x WHERE x->>'item_id'=rec.b->>'item_id';
   IF expected IS NULL OR(rec.c->>'accepted',rec.c->>'restocked',rec.c->>'refund_amount') IS DISTINCT FROM(expected->>'accepted',expected->>'restocked',expected->>'refund_minor') THEN RAISE EXCEPTION 'Ilości lub skumulowany kredyt nie odpowiadają pozycji' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
 SELECT bool_and(oi.quantity=(SELECT coalesce(sum(ri.accepted),0) FROM public.return_items ri JOIN public.return_cases rr ON(rr.tenant_id,rr.id)=(ri.tenant_id,ri.return_id) WHERE(ri.tenant_id,ri.order_id,ri.item_id)=(oi.tenant_id,oi.order_id,oi.id) AND rr.state IN('refund_pending','closed'))) INTO all_accepted FROM public.order_items oi WHERE(oi.tenant_id,oi.order_id)=(t,a.order_id);
 before_row:=a.before_snapshot->'orders'->0;after_row:=cur->'orders'->0;
 IF before_row IS NULL OR after_row IS NULL OR before_row-ARRAY['status','workflow_status_id','version','updated_at'] IS DISTINCT FROM after_row-ARRAY['status','workflow_status_id','version','updated_at']
 OR after_row->>'status' IS DISTINCT FROM(CASE WHEN a.payload->>'action'='receive' AND all_accepted THEN 'return_received' ELSE before_row->>'status' END)
 OR after_row->'workflow_status_id' IS DISTINCT FROM(CASE WHEN a.payload->>'action'='receive' AND all_accepted THEN 'null'::jsonb ELSE before_row->'workflow_status_id' END)
 OR(after_row->>'version')::bigint IS DISTINCT FROM(before_row->>'version')::bigint+(CASE WHEN a.payload->>'action'='receive' AND all_accepted THEN 2 ELSE 1 END) THEN RAISE EXCEPTION 'Przyjęcie zmieniło niezatwierdzone dane zamówienia' USING ERRCODE='23514';END IF;
 FOR cell IN SELECT value FROM jsonb_array_elements(a.payload->'plan'->'parts') LOOP
  IF NOT EXISTS(SELECT 1 FROM public.return_destination_statuses h JOIN public.return_destination_status_revisions v ON(v.tenant_id,v.status_id,v.id,v.version)=(h.tenant_id,h.id,h.revision_id,h.version) WHERE(h.tenant_id,h.id,h.version,h.revision_id)=(t,(cell->'status'->>'status_id')::uuid,(cell->'status'->>'version')::bigint,(cell->'status'->>'revision_id')::uuid)) THEN RAISE EXCEPTION 'Status części zmienił się po zgodzie' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR cell IN SELECT value FROM jsonb_array_elements(a.payload->'plan'->'stock_effects') LOOP
  expected:=public.warehouse_inventory_policy(t,(cell->>'warehouse_id')::uuid);
  IF expected->'enabled' IS DISTINCT FROM 'true'::jsonb OR expected->>'usage' IS DISTINCT FROM cell->>'effect' OR expected->>'version' IS DISTINCT FROM(SELECT x->'status'->>'warehouse_policy_version' FROM jsonb_array_elements(a.payload->'plan'->'parts')x WHERE x->'status'->>'warehouse_id'=cell->>'warehouse_id' LIMIT 1)
  OR NOT EXISTS(SELECT 1 FROM public.products p JOIN public.product_catalog_warehouses cw ON(cw.tenant_id,cw.catalog_id)=(p.tenant_id,p.catalog_id) WHERE(p.tenant_id,p.id,cw.warehouse_id)=(t,(cell->>'product_id')::uuid,(cell->>'warehouse_id')::uuid)) THEN RAISE EXCEPTION 'Polityka lub katalog docelowego składnika zmienił się' USING ERRCODE='23514';END IF;
 END LOOP;
 -- Exact prior rows survive, then every new journal row is a genuine witness.
 FOREACH nm IN ARRAY ARRAY['stock_movements','stock_location_movements','wms_layer_movements','wms_return_fragments','wms_operations'] LOOP
  old_rows:=a.before_snapshot->nm;new_rows:=cur->nm;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(old_rows)x WHERE NOT(new_rows @> jsonb_build_array(x))) THEN RAISE EXCEPTION 'Przyjęcie zmieniło wcześniejszy dziennik' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'id'),'[]') INTO actual FROM jsonb_array_elements(new_rows)x WHERE NOT(old_rows @> jsonb_build_array(x));
  SELECT coalesce(jsonb_agg(w->'row' ORDER BY w->'row'->>'id'),'[]') INTO expected FROM jsonb_array_elements(a.witnesses)w WHERE w->>'table'=nm;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Przyjęcie wymaga bijekcji rzeczywistych dzienników' USING ERRCODE='23514';END IF;
 END LOOP;
 FOREACH nm IN ARRAY ARRAY['order_items','payment_entries','documents','reservations','reservation_locations','wms_reservation_layers','shipments','order_parcel_dispatches','order_parcel_releases','wms_cost_layers','wms_lots','wms_issue_fragments'] LOOP
  IF cur->nm IS DISTINCT FROM a.before_snapshot->nm THEN RAISE EXCEPTION 'Przyjęcie zmieniło wydanie, kasę, dokument lub oryginalny koszt' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR wr IN SELECT value FROM jsonb_array_elements(a.witnesses) LOOP
  IF wr->>'table' NOT IN('stock_movements','stock_location_movements','wms_return_fragments','wms_layer_movements','wms_operations') THEN RAISE EXCEPTION 'Obcy typ świadka przyjęcia' USING ERRCODE='23514';END IF;
  EXECUTE format('SELECT to_jsonb(x) FROM public.%I x WHERE (tenant_id,id)=($1,$2)',wr->>'table') INTO live USING t,(wr->'row'->>'id')::uuid;
  IF live IS DISTINCT FROM wr->'row' THEN RAISE EXCEPTION 'Rzeczywisty świadek przyjęcia zmienił treść' USING ERRCODE='23514';END IF;
 END LOOP;
 -- Writer updates once per immutable arrival. Preserve original source stock,
 -- reserved quantities and unrelated bins/positions, including zero rows.
 FOR rec IN SELECT coalesce(b->>'warehouse_id',c->>'warehouse_id') warehouse_id,coalesce(b->>'product_id',c->>'product_id') product_id,b,c FROM jsonb_array_elements(a.before_snapshot->'stock')b FULL JOIN jsonb_array_elements(cur->'stock')c ON(b->>'warehouse_id',b->>'product_id')=(c->>'warehouse_id',c->>'product_id') LOOP
  cell:=NULL;SELECT value INTO cell FROM jsonb_array_elements(a.payload->'plan'->'stock_effects')x WHERE(x->>'warehouse_id',x->>'product_id')=(rec.warehouse_id,rec.product_id);
  IF cell IS NULL THEN IF rec.b IS DISTINCT FROM rec.c THEN RAISE EXCEPTION 'Zmienił się stan poza docelową unią' USING ERRCODE='23514';END IF;CONTINUE;END IF;
  SELECT count(*) INTO want_updates FROM jsonb_array_elements(a.payload->'plan'->'arrivals')x WHERE(x->>'warehouse_id',x->>'product_id')=(rec.warehouse_id,rec.product_id);
  IF rec.c IS NULL OR(rec.c->>'on_hand')::bigint IS DISTINCT FROM(cell->'after'->>'on_hand')::bigint OR(rec.c->>'reserved')::bigint IS DISTINCT FROM(cell->'after'->>'reserved')::bigint
  OR(rec.b IS NOT NULL AND rec.b-ARRAY['on_hand','available','version'] IS DISTINCT FROM rec.c-ARRAY['on_hand','available','version'])
  OR(rec.b IS NULL AND((rec.c->>'reserved')::bigint<>0 OR rec.c->>'location' IS DISTINCT FROM(SELECT x->>'location' FROM jsonb_array_elements(a.payload->'plan'->'arrivals') WITH ORDINALITY z(x,seq) WHERE(x->>'warehouse_id',x->>'product_id')=(rec.warehouse_id,rec.product_id) ORDER BY seq LIMIT 1)))
  OR(rec.c->>'version')::bigint IS DISTINCT FROM coalesce((rec.b->>'version')::bigint,0)+want_updates THEN RAISE EXCEPTION 'Zmiana docelowego zapasu nie odpowiada przyjęciu' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(a.payload->'plan'->'stock_effects')z WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(cur->'stock')x WHERE(x->>'warehouse_id',x->>'product_id')=(z->>'warehouse_id',z->>'product_id'))) THEN RAISE EXCEPTION 'Brak przyjętego stanu' USING ERRCODE='23514';END IF;
 FOR rec IN SELECT coalesce(b->>'warehouse_id',c->>'warehouse_id') warehouse_id,coalesce(b->>'product_id',c->>'product_id') product_id,coalesce(b->>'location',c->>'location') location,b,c FROM jsonb_array_elements(a.before_snapshot->'stock_locations')b FULL JOIN jsonb_array_elements(cur->'stock_locations')c ON(b->>'warehouse_id',b->>'product_id',b->>'location')=(c->>'warehouse_id',c->>'product_id',c->>'location') LOOP
  SELECT coalesce(sum((x->>'quantity')::bigint),0) INTO want_qty FROM jsonb_array_elements(a.payload->'plan'->'arrivals')x WHERE(x->>'warehouse_id',x->>'product_id',x->>'location')=(rec.warehouse_id,rec.product_id,rec.location);
  IF rec.c IS NULL OR(rec.b IS NULL AND want_qty=0) OR(rec.b IS NOT NULL AND rec.b-'quantity' IS DISTINCT FROM rec.c-'quantity') OR(rec.c->>'quantity')::bigint-coalesce((rec.b->>'quantity')::bigint,0) IS DISTINCT FROM want_qty THEN RAISE EXCEPTION 'Lokalizacje nie zachowują dokładnego przyjęcia' USING ERRCODE='23514';END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse_id',x->'warehouse_id','product_id',x->'product_id','quantity',x->'quantity') ORDER BY x->>'warehouse_id',x->>'product_id',x->>'quantity'),'[]') INTO expected FROM jsonb_array_elements(a.payload->'plan'->'arrivals')x;
 SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse_id',w->'row'->'warehouse_id','product_id',w->'row'->'product_id','quantity',w->'row'->'delta') ORDER BY w->'row'->>'warehouse_id',w->'row'->>'product_id',w->'row'->>'delta'),'[]') INTO actual FROM jsonb_array_elements(a.witnesses)w WHERE w->>'table'='stock_movements';
 IF actual IS DISTINCT FROM expected OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.witnesses)w WHERE w->>'table'='stock_movements' AND(w->'row'->>'kind' IS DISTINCT FROM 'return' OR(w->'row'->>'order_id',w->'row'->>'return_id') IS DISTINCT FROM(a.order_id::text,a.return_id::text) OR(w->'row'->>'delta')::bigint<=0)) THEN RAISE EXCEPTION 'Wymagany dokładny dziennik zwrotu każdej części' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse_id',x->'warehouse_id','product_id',x->'product_id','location',x->'location','quantity',x->'quantity') ORDER BY x->>'warehouse_id',x->>'product_id',x->>'location',x->>'quantity'),'[]') INTO expected FROM jsonb_array_elements(a.payload->'plan'->'arrivals')x;
 SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse_id',w->'row'->'warehouse_id','product_id',w->'row'->'product_id','location',w->'row'->'location','quantity',w->'row'->'delta') ORDER BY w->'row'->>'warehouse_id',w->'row'->>'product_id',w->'row'->>'location',w->'row'->>'delta'),'[]') INTO actual FROM jsonb_array_elements(a.witnesses)w WHERE w->>'table'='stock_location_movements';
 IF actual IS DISTINCT FROM expected OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.witnesses)w WHERE w->>'table'='stock_location_movements' AND(w->'row'->>'kind' IS DISTINCT FROM 'stock_in' OR(w->'row'->>'delta')::bigint<=0 OR w->'row'->'order_id' IS DISTINCT FROM 'null'::jsonb OR w->'row'->'operation_id' IS DISTINCT FROM 'null'::jsonb)) THEN RAISE EXCEPTION 'Wymagany dokładny naturalny dziennik lokalizacji' USING ERRCODE='23514';END IF;
 IF a.payload->'planner_source'->'wms'->'enabled'='true'::jsonb AND jsonb_array_length(a.payload->'plan'->'arrivals')>0 THEN
  SELECT * INTO op FROM public.wms_operations WHERE(tenant_id,id)=(t,eid);
  expected_request:=jsonb_build_object('protocol','destinations_v1','admission_id',eid,'preview_id',a.preview_id,'return_id',a.return_id,'order_id',a.order_id,'parts',(SELECT jsonb_agg(x->'part_id' ORDER BY x->>'part_id' COLLATE "C") FROM jsonb_array_elements(a.payload->'plan'->'parts')x));
  IF op.id IS NULL OR(op.kind,op.actor_id,op.client_key,op.order_id,op.return_id,op.policy_version) IS DISTINCT FROM('return',a.actor_id,eid,a.order_id,a.return_id,(a.payload->'planner_source'->'wms'->>'policy_version')::bigint) OR op.request IS DISTINCT FROM expected_request OR op.request_hash IS DISTINCT FROM public.return_assistant_hash(expected_request)
  OR op.warehouse_document_id IS NOT NULL OR op.purchase_receipt_id IS NOT NULL
  OR(SELECT count(*) FROM jsonb_array_elements(a.witnesses)w WHERE w->>'table'='wms_operations')<>1 THEN RAISE EXCEPTION 'Zwrot wymaga jednej własnej operacji WMS' USING ERRCODE='23514';END IF;
  IF jsonb_typeof(op.result) IS DISTINCT FROM 'object' OR op.result-ARRAY['fragments','legacy_unknown_layers','valuation']<>'{}' OR NOT op.result?&ARRAY['fragments','legacy_unknown_layers','valuation']
  OR jsonb_typeof(op.result->'fragments') IS DISTINCT FROM 'array' OR op.result->'legacy_unknown_layers' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'Operacja WMS wymaga dokładnego wyniku fragmentów' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(x-'id' ORDER BY x->>'part_id',x->>'issue_fragment_id',x->>'location'),'[]') INTO actual FROM jsonb_array_elements(op.result->'fragments')x;
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'part_id',x->>'issue_fragment_id',x->>'location'),'[]') INTO expected FROM jsonb_array_elements(a.payload->'plan'->'private_fragment_effects')x;
  IF actual IS DISTINCT FROM expected OR(SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(op.result->'fragments')x)<>jsonb_array_length(op.result->'fragments')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(op.result->'fragments')x WHERE NOT EXISTS(SELECT 1 FROM public.wms_return_fragments f WHERE(f.tenant_id,f.operation_id,f.id,f.issue_fragment_id,f.product_id,f.layer_id,f.warehouse_id,f.location,f.quantity)=(t,eid,(x->>'id')::uuid,(x->>'issue_fragment_id')::uuid,(x->>'product_id')::uuid,(x->>'layer_id')::uuid,(x->>'warehouse_id')::uuid,x->>'location',(x->>'quantity')::int) AND f.value_minor IS NOT DISTINCT FROM(x->>'value_minor')::bigint)) THEN RAISE EXCEPTION 'Wynik WMS ma inne rzeczywiste fragmenty lub pochodzenie' USING ERRCODE='23514';END IF;
  SELECT jsonb_build_object('currency',a.payload->'plan'->'currency','quantity',coalesce(sum((x->>'quantity')::numeric),0)::text,'known_minor',coalesce(sum((x->>'value_minor')::numeric),0)::text,'unknown_quantity',coalesce(sum((x->>'unknown_quantity')::numeric),0)::text,'known_quantity',(coalesce(sum((x->>'quantity')::numeric),0)-coalesce(sum((x->>'unknown_quantity')::numeric),0))::text) INTO expected FROM jsonb_array_elements(a.payload->'plan'->'private_fragment_effects')x;
  IF op.result->'valuation' IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Wynik WMS ma inną oryginalną wycenę' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('issue_fragment_id',x->'issue_fragment_id','layer_id',x->'layer_id','product_id',x->'product_id','warehouse_id',x->'warehouse_id','location',x->'location','quantity',x->'quantity','value_minor',x->'value_minor') ORDER BY x->>'issue_fragment_id',x->>'warehouse_id',x->>'location',x->>'quantity'),'[]') INTO expected FROM jsonb_array_elements(a.payload->'plan'->'private_fragment_effects')x;
  SELECT coalesce(jsonb_agg(jsonb_build_object('issue_fragment_id',w->'row'->'issue_fragment_id','layer_id',w->'row'->'layer_id','product_id',w->'row'->'product_id','warehouse_id',w->'row'->'warehouse_id','location',w->'row'->'location','quantity',w->'row'->'quantity','value_minor',CASE WHEN w->'row'->'value_minor'='null'::jsonb THEN 'null'::jsonb ELSE to_jsonb(w->'row'->>'value_minor') END) ORDER BY w->'row'->>'issue_fragment_id',w->'row'->>'warehouse_id',w->'row'->>'location',w->'row'->>'quantity'),'[]') INTO actual FROM jsonb_array_elements(a.witnesses)w WHERE w->>'table'='wms_return_fragments';
  IF actual IS DISTINCT FROM expected OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.witnesses)w WHERE w->>'table'='wms_return_fragments' AND(w->'row'->>'operation_id',w->'row'->>'return_id',w->'row'->>'order_id') IS DISTINCT FROM(eid::text,a.return_id::text,a.order_id::text)) THEN RAISE EXCEPTION 'Fragmenty nie odpowiadają dokładnej zgodzie SALE i CUSTODY' USING ERRCODE='23514';END IF;
  FOR rec IN SELECT coalesce(b->>'warehouse_id',c->>'warehouse_id') warehouse_id,coalesce(b->>'product_id',c->>'product_id') product_id,coalesce(b->>'location',c->>'location') location,coalesce(b->>'layer_id',c->>'layer_id') layer_id,b,c FROM jsonb_array_elements(a.before_snapshot->'wms_layer_positions')b FULL JOIN jsonb_array_elements(cur->'wms_layer_positions')c ON(b->>'warehouse_id',b->>'product_id',b->>'location',b->>'layer_id')=(c->>'warehouse_id',c->>'product_id',c->>'location',c->>'layer_id') LOOP
   SELECT coalesce(sum((x->>'quantity')::bigint),0),count(*) INTO want_qty,want_updates FROM jsonb_array_elements(a.payload->'plan'->'private_fragment_effects')x WHERE(x->>'warehouse_id',x->>'product_id',x->>'location',x->>'layer_id')=(rec.warehouse_id,rec.product_id,rec.location,rec.layer_id);
   IF rec.c IS NULL OR(rec.b IS NULL AND want_qty=0) OR(rec.b IS NOT NULL AND rec.b-ARRAY['quantity','version'] IS DISTINCT FROM rec.c-ARRAY['quantity','version']) OR(rec.c->>'quantity')::bigint-coalesce((rec.b->>'quantity')::bigint,0) IS DISTINCT FROM want_qty OR(rec.c->>'version')::bigint IS DISTINCT FROM coalesce((rec.b->>'version')::bigint,0)+want_updates OR(rec.b IS NULL AND(rec.c->>'reserved')::bigint<>0) THEN RAISE EXCEPTION 'Pozycja warstwy nie zachowuje ilości lub rezerwacji' USING ERRCODE='23514';END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse_id',x->'warehouse_id','product_id',x->'product_id','location',x->'location','layer_id',x->'layer_id','quantity',x->'quantity','value_minor',x->'value_minor') ORDER BY x->>'warehouse_id',x->>'product_id',x->>'location',x->>'layer_id',x->>'quantity'),'[]') INTO expected FROM jsonb_array_elements(a.payload->'plan'->'private_fragment_effects')x;
  SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse_id',w->'row'->'warehouse_id','product_id',w->'row'->'product_id','location',w->'row'->'location','layer_id',w->'row'->'layer_id','quantity',w->'row'->'delta','value_minor',CASE WHEN w->'row'->'value_delta'='null'::jsonb THEN 'null'::jsonb ELSE to_jsonb(w->'row'->>'value_delta') END) ORDER BY w->'row'->>'warehouse_id',w->'row'->>'product_id',w->'row'->>'location',w->'row'->>'layer_id',w->'row'->>'delta'),'[]') INTO actual FROM jsonb_array_elements(a.witnesses)w WHERE w->>'table'='wms_layer_movements';
  IF actual IS DISTINCT FROM expected OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.witnesses)w WHERE w->>'table'='wms_layer_movements' AND(w->'row'->>'operation_id' IS DISTINCT FROM eid::text OR w->'row'->>'kind' IS DISTINCT FROM 'return' OR(w->'row'->>'delta')::bigint<=0)) THEN RAISE EXCEPTION 'Warstwy nie mają dokładnego dziennika przyjęcia' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM public.wms_issue_fragments f WHERE(f.tenant_id,f.order_id)=(t,a.order_id) AND(SELECT coalesce(sum(r.quantity),0) FROM public.wms_return_fragments r WHERE(r.tenant_id,r.issue_fragment_id)=(t,f.id))>f.quantity) THEN RAISE EXCEPTION 'SALE i CUSTODY przekraczają wspólny fragment wydania' USING ERRCODE='23514';END IF;
 ELSE
  IF cur->'wms_layer_positions' IS DISTINCT FROM a.before_snapshot->'wms_layer_positions' OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.witnesses)w WHERE w->>'table' IN('wms_operations','wms_return_fragments','wms_layer_movements')) THEN RAISE EXCEPTION 'Zwrot bez fizycznego WMS nie tworzy warstw ani kosztu' USING ERRCODE='23514';END IF;
 END IF;
END $$;

-- Private reads are owner infrastructure only; all principal values still come
-- from authenticated server context. This does not close the shared-role160 gap.
CREATE FUNCTION return_destination_require(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE g jsonb;k public.api_keys;t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;BEGIN
 IF NOT public.return_destination_guards() THEN RAISE EXCEPTION 'Niekompletny protokół celów zwrotu' USING ERRCODE='55000';END IF;
 g:=public.return_assistant_require(uid,kid,writing,pin);
 IF kid IS NOT NULL THEN
  IF pin THEN SELECT * INTO k FROM public.api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid) FOR SHARE;ELSE SELECT * INTO k FROM public.api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid);END IF;
  IF k.id IS NULL OR k.revoked_at IS NOT NULL OR(k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Klucz przyjęcia został cofnięty lub wygasł' USING ERRCODE='28000';END IF;
  IF NOT(k.scopes @> ARRAY['orders:read','inventory:read']::text[]) OR(writing AND NOT k.scopes @> ARRAY['orders:write','inventory:write']::text[]) THEN RAISE EXCEPTION 'Brak aktualnego zakresu przyjęcia' USING ERRCODE='42501';END IF;
 END IF;
 IF writing AND g->'can_write' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Brak aktualnego uprawnienia do przyjęcia' USING ERRCODE='42501';END IF;
 RETURN g;
END $$;

CREATE FUNCTION return_destination_source(rid uuid,sid uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;s public.return_assistant_sessions;f jsonb;ps jsonb;BEGIN
 PERFORM public.return_destination_require(uid,kid,false,false);
 SELECT * INTO s FROM public.return_assistant_sessions WHERE(tenant_id,id,return_id)=(t,sid,rid);
 IF s.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnej sesji RMA' USING ERRCODE='P0002';END IF;
 f:=public.return_assistant_source(rid);
 SELECT jsonb_build_object('order_id',s.order_id,'return_id',rid,'currency',f->'order'->>'currency','requested_shipping_refund',f->'return_case'->'requested_shipping',
 'lines',(SELECT coalesce(jsonb_agg(jsonb_build_object('item_id',l->>'item_id','ordinal',(l->>'ordinal')::int-1,'ordered_quantity',l->'original_quantity','requested',l->'requested',
 'prior_accepted',(SELECT(b->>'prior')::bigint FROM jsonb_array_elements(f->'refund_basis')b WHERE b->>'item_id'=l->>'item_id'),
 'scanned_quantity',coalesce((SELECT sum((z->>'quantity')::int) FROM jsonb_array_elements(s.scanned)z WHERE z->>'item_id'=l->>'item_id'),0),
 'line_total_minor',l->'line_total','components',l->'components') ORDER BY(l->>'ordinal')::int),'[]') FROM jsonb_array_elements(f->'lines')l),
 'statuses',(SELECT coalesce(jsonb_agg(jsonb_build_object('status_id',h.id,'version',h.version::text,'revision_id',h.revision_id,'active',v.settings->'active','name',v.settings->'name','color',v.settings->'color','decision',v.settings->'decision','inventory_effect',v.settings->'inventory_effect','warehouse_id',v.settings->'warehouse_id','warehouse_policy_version',v.settings->'warehouse_policy_version','default_location',v.settings->'default_location') ORDER BY h.id),'[]') FROM public.return_destination_statuses h JOIN public.return_destination_status_revisions v ON(v.tenant_id,v.status_id,v.id,v.version)=(h.tenant_id,h.id,h.revision_id,h.version) WHERE h.tenant_id=t),
 'warehouse_policies',(SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse_id',w.id)||public.warehouse_inventory_policy(t,w.id) ORDER BY w.id),'[]') FROM public.warehouses w WHERE w.tenant_id=t),
 'catalog_assignments',(SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',p.id,'warehouse_ids',(SELECT coalesce(jsonb_agg(cw.warehouse_id ORDER BY cw.warehouse_id),'[]') FROM public.product_catalog_warehouses cw WHERE(cw.tenant_id,cw.catalog_id)=(p.tenant_id,p.catalog_id))) ORDER BY p.id),'[]') FROM public.products p WHERE p.tenant_id=t AND p.id IN(SELECT(c->>'product_id')::uuid FROM jsonb_array_elements(f->'lines')l CROSS JOIN LATERAL jsonb_array_elements(l->'components')c)),
 'stocks',(SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse_id',cell.warehouse_id,'product_id',cell.product_id,'exists',sk.product_id IS NOT NULL,'version',coalesce(sk.version::text,'0'),'on_hand',coalesce(sk.on_hand,0),'reserved',coalesce(sk.reserved,0)) ORDER BY cell.warehouse_id,cell.product_id),'[]')
 FROM(SELECT DISTINCT(v.settings->>'warehouse_id')::uuid warehouse_id,(c->>'product_id')::uuid product_id FROM public.return_destination_statuses h JOIN public.return_destination_status_revisions v ON(v.tenant_id,v.status_id,v.id,v.version)=(h.tenant_id,h.id,h.revision_id,h.version) CROSS JOIN LATERAL jsonb_array_elements(f->'lines')l CROSS JOIN LATERAL jsonb_array_elements(l->'components')c WHERE h.tenant_id=t AND v.settings->>'decision'='accept')cell LEFT JOIN public.stock sk ON(sk.tenant_id,sk.warehouse_id,sk.product_id)=(t,cell.warehouse_id,cell.product_id)),
 'wms',jsonb_build_object('enabled',coalesce((f->'wms_policy'->>'enabled')::boolean,false),'policy_version',coalesce(f->'wms_policy'->>'version','0'),
 'issue_fragments',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'product_id',i.product_id,'layer_id',i.layer_id,'order_id',i.order_id,
 'eligible_item_ids',(SELECT coalesce(jsonb_agg(DISTINCT ri.item_id ORDER BY ri.item_id),'[]') FROM public.return_items ri WHERE(ri.tenant_id,ri.return_id)=(t,rid) AND EXISTS(SELECT 1 FROM jsonb_array_elements(ri.components)c WHERE c->>'product_id'=i.product_id::text)
 AND(NOT EXISTS(SELECT 1 FROM public.order_parcel_return_claims cl WHERE(cl.tenant_id,cl.return_id)=(t,rid)) OR EXISTS(SELECT 1 FROM public.order_parcel_return_claims cl JOIN public.order_parcel_origin_fragments m ON(m.tenant_id,m.origin_id,m.dispatch_id)=(cl.tenant_id,cl.origin_id,cl.dispatch_id) WHERE(cl.tenant_id,cl.return_id,cl.item_id,m.fragment_id,m.product_id)=(t,rid,ri.item_id,i.id,i.product_id)))),
 'quantity',i.quantity,'returned_quantity',(SELECT coalesce(sum(r.quantity),0) FROM public.wms_return_fragments r WHERE(r.tenant_id,r.issue_fragment_id)=(t,i.id)),
 'unit_cost_minor',i.unit_cost_minor::text,'currency',i.currency) ORDER BY i.id),'[]') FROM public.wms_issue_fragments i WHERE(i.tenant_id,i.order_id)=(t,s.order_id)))) INTO ps;
 ps:=jsonb_set(ps,'{wms,issue_fragments}',coalesce((SELECT jsonb_agg(x ORDER BY x->>'id') FROM jsonb_array_elements(ps->'wms'->'issue_fragments')x WHERE jsonb_array_length(x->'eligible_item_ids')>0),'[]'));
 IF jsonb_array_length(ps->'lines')>100 OR jsonb_array_length(ps->'statuses')>200 OR jsonb_array_length(ps->'warehouse_policies')>100 OR jsonb_array_length(ps->'catalog_assignments')>500 OR jsonb_array_length(ps->'stocks')>500 OR jsonb_array_length(ps->'wms'->'issue_fragments')>10000 THEN RAISE EXCEPTION 'Zakres celów zwrotu przekracza limit' USING ERRCODE='54000';END IF;
 RETURN jsonb_build_object('planner_source',ps,'session',jsonb_build_object('id',s.id,'version',s.version::text,'station_id',s.station_id,'station',s.station,'state',s.state,'return_id',s.return_id,'order_id',s.order_id,'actor_id',s.actor_id,'api_key_id',s.api_key_id,'lease_generation',s.lease_generation,'lease_expires_at',s.lease_expires_at),'return_case',f->'return_case','order',f->'order','lines',f->'lines','station',s.station,'scanned',s.scanned,
 'photos',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',ph.id,'item_id',ph.item_id,'part_id',ph.part_id,'mime',ph.mime,'byte_count',ph.byte_count,'sha256',ph.sha256,'width',ph.width,'height',ph.height,'created_at',ph.created_at) ORDER BY ph.id),'[]') FROM public.return_assistant_photos ph WHERE(ph.tenant_id,ph.session_id)=(t,sid)),
 'source',f-ARRAY['return_case','order','lines'],'warehouses',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'code',w.code) ORDER BY w.id),'[]') FROM public.warehouses w WHERE w.tenant_id=t),
 'origins',(SELECT coalesce(jsonb_agg(jsonb_build_object('origin_id',cl.origin_id,'item_id',cl.item_id,'dispatch_id',cl.dispatch_id,'parcel_index',o.parcel_index,'shipment_id',o.shipment_id,'quantity',cl.quantity,
 'fragments',(SELECT coalesce(jsonb_agg(jsonb_build_object('fragment_id',m.fragment_id,'product_id',m.product_id,'quantity',m.quantity,'available',m.quantity-coalesce((SELECT sum((x->>'quantity')::bigint) FROM public.order_parcel_return_receipts rr CROSS JOIN LATERAL jsonb_array_elements(rr.payload->'fragments')x WHERE rr.tenant_id=t AND(x->>'origin_id',x->>'fragment_id')=(cl.origin_id::text,m.fragment_id::text)),0)) ORDER BY m.fragment_id),'[]') FROM public.order_parcel_origin_fragments m WHERE(m.tenant_id,m.origin_id,m.dispatch_id)=(cl.tenant_id,cl.origin_id,cl.dispatch_id))) ORDER BY cl.ordinal),'[]') FROM public.order_parcel_return_claims cl JOIN public.order_parcel_commercial_origins o ON(o.tenant_id,o.id,o.order_id,o.item_id)=(cl.tenant_id,cl.origin_id,cl.order_id,cl.item_id) WHERE(cl.tenant_id,cl.return_id)=(t,rid)));
END $$;

CREATE FUNCTION return_destination_frame(sid uuid,b jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;s public.return_assistant_sessions;src jsonb;ps jsonb;plan jsonb;core jsonb;wh uuid;st public.packing_stations;action_kind text;BEGIN
 PERFORM public.return_destination_require(uid,kid,true,false);
 IF NOT public.return_destination_request_valid(b) OR b->>'session_id' IS DISTINCT FROM sid::text THEN RAISE EXCEPTION 'Niepoprawny podgląd celów zwrotu' USING ERRCODE='23514';END IF;
 SELECT * INTO s FROM public.return_assistant_sessions WHERE(tenant_id,id)=(t,sid);
 IF s.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono sesji' USING ERRCODE='P0002';END IF;
 -- Catalog/policy before quota/order/session/resource rows, including the source WH.
 FOR wh IN SELECT x FROM(SELECT(s.source->'return_case'->>'warehouse_id')::uuid x UNION SELECT(v.settings->>'warehouse_id')::uuid FROM public.return_destination_statuses h JOIN public.return_destination_status_revisions v ON(v.tenant_id,v.status_id,v.id,v.version)=(h.tenant_id,h.id,h.revision_id,h.version) WHERE h.tenant_id=t AND h.id IN(SELECT(p->>'status_id')::uuid FROM jsonb_array_elements(b->'parts')p) AND v.settings->>'warehouse_id' IS NOT NULL)u ORDER BY x LOOP PERFORM public.warehouse_inventory_policy_lock(t,wh);END LOOP;
 PERFORM 1 FROM public.return_destination_statuses h WHERE h.tenant_id=t AND h.id IN(SELECT(p->>'status_id')::uuid FROM jsonb_array_elements(b->'parts')p) ORDER BY h.id FOR SHARE;
 PERFORM public.return_destination_lock(s.order_id,s.return_id,b,uid,kid);
 s:=public.return_assistant_session(sid,uid,kid,jsonb_build_object('version',b->'session_version','lease_token',b->'lease_token'));
 PERFORM 1 FROM public.return_cases WHERE(tenant_id,id)=(t,s.return_id) FOR UPDATE;
 -- Existing source stock is already locked by order_parcel_lock; selected union
 -- is sorted and rechecked. Root's outer coordinator must acquire this same union.
 PERFORM 1 FROM public.stock sk WHERE sk.tenant_id=t AND EXISTS(SELECT 1 FROM jsonb_array_elements(b->'stock_versions')v WHERE(sk.warehouse_id::text,sk.product_id::text)=(v->>'warehouse_id',v->>'product_id')) ORDER BY sk.warehouse_id,sk.product_id FOR UPDATE;
 PERFORM 1 FROM public.stock_locations sk WHERE sk.tenant_id=t AND EXISTS(SELECT 1 FROM jsonb_array_elements(b->'stock_versions')v WHERE(sk.warehouse_id::text,sk.product_id::text)=(v->>'warehouse_id',v->>'product_id')) ORDER BY sk.warehouse_id,sk.product_id,sk.location COLLATE "C" FOR UPDATE;
 PERFORM 1 FROM public.wms_layer_positions sk WHERE sk.tenant_id=t AND EXISTS(SELECT 1 FROM jsonb_array_elements(b->'stock_versions')v WHERE(sk.warehouse_id::text,sk.product_id::text)=(v->>'warehouse_id',v->>'product_id')) ORDER BY sk.warehouse_id,sk.product_id,sk.location COLLATE "C",sk.layer_id FOR UPDATE;
 SELECT * INTO st FROM public.packing_stations WHERE(tenant_id,id)=(t,s.station_id) FOR SHARE;
 IF st.id IS NULL OR NOT st.enabled OR st.version::text IS DISTINCT FROM s.station->>'version' THEN RAISE EXCEPTION 'Stanowisko kontroli zmieniło się' USING ERRCODE='23514';END IF;
 src:=public.return_destination_source(s.return_id,sid,uid,kid);
 IF src->'return_case'->>'version' IS DISTINCT FROM b->>'return_version' OR src->'return_case'->>'state' IS DISTINCT FROM 'requested' OR src->'return_case'->'receipt' IS DISTINCT FROM 'null'::jsonb
 OR(src->'return_case'->>'legacy')::boolean IS TRUE OR coalesce(src->'return_case'->>'remedy','refund')<>'refund'
 OR(SELECT jsonb_agg(x-'codes' ORDER BY x->>'item_id') FROM jsonb_array_elements(src->'lines')x) IS DISTINCT FROM(SELECT jsonb_agg(x-'codes' ORDER BY x->>'item_id') FROM jsonb_array_elements(s.source->'lines')x) THEN RAISE EXCEPTION 'Historyczne źródło RMA zmieniło się' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(src->'photos')ph WHERE ph->'part_id'<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'parts')pt WHERE(pt->'part_id',pt->'item_id')=(ph->'part_id',ph->'item_id'))) THEN RAISE EXCEPTION 'Zdjęcie nie odpowiada trwałej części kontroli' USING ERRCODE='23514';END IF;
 ps:=src->'planner_source';ps:=jsonb_set(ps,'{stocks}',coalesce((SELECT jsonb_agg(x ORDER BY x->>'warehouse_id',x->>'product_id') FROM jsonb_array_elements(ps->'stocks')x WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(b->'stock_versions')v WHERE(v->>'warehouse_id',v->>'product_id')=(x->>'warehouse_id',x->>'product_id'))),'[]'));
 plan:=public.return_destination_plan(ps,b);action_kind:=CASE WHEN(plan->'summary'->>'accepted')::bigint=0 THEN 'reject' ELSE 'receive' END;
 IF action_kind='reject' THEN
  IF(b->>'shipping_refund')::bigint<>0 THEN RAISE EXCEPTION 'Odrzucenie nie zwraca dostawy' USING ERRCODE='23514';END IF;
  core:=jsonb_build_object('version',(b->>'return_version')::bigint,'decision','reject','note',b->>'note');
 ELSE
  PERFORM public.order_parcel_return_shipping_limit(s.order_id,s.return_id,(b->>'shipping_refund')::bigint);
  core:=jsonb_build_object('version',(b->>'return_version')::bigint,'note',b->>'note','shipping_refund',b->'shipping_refund','items',(SELECT jsonb_agg(x-ARRAY['custody','rejected','refund_minor'] ORDER BY x->>'item_id') FROM jsonb_array_elements(plan->'decisions')x));
  IF EXISTS(SELECT 1 FROM public.b2b_return_local_origins lo WHERE(lo.tenant_id,lo.return_id)=(t,s.return_id)) THEN core:=core||jsonb_build_object('origin_id',(SELECT lo.id FROM public.b2b_return_local_origins lo WHERE(lo.tenant_id,lo.return_id)=(t,s.return_id)));END IF;
 END IF;
 PERFORM public.return_destination_require(uid,kid,true,false);
 RETURN jsonb_build_object('action',action_kind,'receive_input',core,'summary',(plan->'summary')||jsonb_build_object('refund_minor',plan->'summary'->'commercial_credit_minor','shipping_refund',plan->'summary'->'shipping_refund_minor'),'planner_source',ps,'plan',plan,
 'snapshot',jsonb_build_object('protocol','destinations_v1','session',src->'session','return_case',src->'return_case','order',src->'order','lines',src->'lines','station',src->'station','scanned',src->'scanned','photos',src->'photos','warehouses',src->'warehouses','origins',src->'origins','source',src->'source','request',b-ARRAY['lease_token','client_key'],'plan',plan));
END $$;

CREATE FUNCTION return_destination_lock(oid uuid,rid uuid,b jsonb,uid uuid,kid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;cells jsonb;nm text;BEGIN
 PERFORM public.return_destination_require(uid,kid,true,false);PERFORM public.return_assistant_lock();
 PERFORM pg_advisory_xact_lock(hashtextextended('b2b.return.local:'||t::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('order.parcels.quota:'||t::text,0));PERFORM pg_advisory_xact_lock(hashtextextended('order.parcels:'||t::text||':'||oid::text,0));
 PERFORM 1 FROM public.orders WHERE(tenant_id,id)=(t,oid) FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Nie znaleziono własnego zamówienia przyjęcia' USING ERRCODE='P0002';END IF;
 PERFORM 1 FROM public.shipments WHERE(tenant_id,order_id)=(t,oid) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.return_cases WHERE(tenant_id,order_id,id)=(t,oid,rid) FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Nie znaleziono własnego RMA zamówienia' USING ERRCODE='P0002';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse_id',warehouse_id,'product_id',product_id) ORDER BY warehouse_id,product_id),'[]') INTO cells FROM(
 SELECT(v->>'warehouse_id')::uuid warehouse_id,(v->>'product_id')::uuid product_id FROM jsonb_array_elements(b->'stock_versions')v
 UNION SELECT r.warehouse_id,r.product_id FROM public.reservations r WHERE(r.tenant_id,r.order_id)=(t,oid)
 UNION SELECT rc.warehouse_id,(c->>'product_id')::uuid FROM public.return_cases rc JOIN public.return_items ri ON(ri.tenant_id,ri.return_id)=(rc.tenant_id,rc.id) CROSS JOIN LATERAL jsonb_array_elements(ri.components)c WHERE(rc.tenant_id,rc.id)=(t,rid))z;
 IF jsonb_array_length(cells)>1000 THEN RAISE EXCEPTION 'Unia blokad przyjęcia przekracza limit' USING ERRCODE='54000';END IF;
 FOREACH nm IN ARRAY ARRAY['stock','stock_locations','wms_layer_positions'] LOOP
  EXECUTE format('SELECT 1 FROM public.%I x WHERE x.tenant_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements($2)v WHERE(x.warehouse_id::text,x.product_id::text)=(v->>''warehouse_id'',v->>''product_id'')) ORDER BY x.warehouse_id,x.product_id%s FOR UPDATE',nm,CASE nm WHEN 'stock' THEN '' WHEN 'stock_locations' THEN ',x.location COLLATE "C"' ELSE ',x.location COLLATE "C",x.layer_id' END) USING t,cells;
 END LOOP;
 PERFORM public.order_parcel_return_lock(oid,uid,kid);PERFORM public.return_destination_require(uid,kid,true,false);
END $$;

CREATE FUNCTION return_destination_extra_budget(old_bytes bigint,t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n bigint;BEGIN
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Obcy budżet przyjęcia' USING ERRCODE='42501';END IF;
 SELECT coalesce(sum(bytes),0) INTO n FROM(SELECT octet_length(to_jsonb(x)::text) bytes FROM public.return_destination_parts x WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM public.return_destination_arrivals x WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM public.return_destination_fragments x WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM public.return_destination_admissions x WHERE tenant_id=t)z;
 IF old_bytes+n>67108864 OR(SELECT count(*) FROM public.return_destination_admissions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Wspólny limit danych asystenta i celów' USING ERRCODE='54000';END IF;
END $$;
CREATE FUNCTION return_destination_budget() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN PERFORM public.return_assistant_budget();END $$;

CREATE FUNCTION return_destination_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j jsonb;k jsonb;a public.return_destination_admissions;protected boolean;BEGIN
 IF TG_OP<>'INSERT' THEN j:=to_jsonb(OLD);END IF;IF TG_OP<>'DELETE' THEN k:=to_jsonb(NEW);END IF;
 FOR a IN SELECT ad.* FROM public.return_destination_admissions ad WHERE ad.transaction_id=pg_current_xact_id() AND ad.backend_pid=pg_backend_pid() AND ad.tenant_id IN((j->>'tenant_id')::uuid,(k->>'tenant_id')::uuid) AND EXISTS(SELECT 1 FROM public.return_assistant_receipts r WHERE(r.tenant_id,r.id)=(ad.tenant_id,ad.receipt_id)) LOOP
  protected:=CASE
   WHEN TG_TABLE_NAME='return_assistant_sessions' THEN a.session_id::text IN(j->>'id',k->>'id')
   WHEN TG_TABLE_NAME='return_assistant_photos' THEN a.session_id::text IN(j->>'session_id',k->>'session_id')
   WHEN TG_TABLE_NAME='return_cases' THEN a.return_id::text IN(j->>'id',k->>'id')
   WHEN TG_TABLE_NAME='orders' THEN a.order_id::text IN(j->>'id',k->>'id')
   WHEN TG_TABLE_NAME='packing_stations' THEN a.payload->'snapshot'->'session'->>'station_id' IN(j->>'id',k->>'id')
   WHEN TG_TABLE_NAME IN('return_destination_statuses','return_destination_status_revisions') THEN EXISTS(SELECT 1 FROM jsonb_array_elements(a.payload->'plan'->'parts')p WHERE p->'status'->>'status_id' IN(j->>'id',k->>'id',j->>'status_id',k->>'status_id'))
   WHEN TG_TABLE_NAME IN('warehouse_inventory_policies','warehouses') THEN EXISTS(SELECT 1 FROM jsonb_array_elements(a.payload->'plan'->'stock_effects')x WHERE x->>'warehouse_id' IN(j->>'warehouse_id',k->>'warehouse_id',j->>'id',k->>'id'))
   WHEN TG_TABLE_NAME='wms_policies' THEN true
   WHEN TG_TABLE_NAME='products' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(a.payload->'snapshot'->'lines')l CROSS JOIN LATERAL jsonb_array_elements(l->'components')c WHERE c->>'product_id' IN(j->>'id',k->>'id'))
   WHEN TG_TABLE_NAME='product_catalog_warehouses' THEN EXISTS(SELECT 1 FROM public.products p WHERE p.tenant_id=a.tenant_id AND p.catalog_id::text IN(j->>'catalog_id',k->>'catalog_id') AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.payload->'snapshot'->'lines')l CROSS JOIN LATERAL jsonb_array_elements(l->'components')c WHERE c->>'product_id'=p.id::text))
   ELSE a.receipt_id::text IN(j->>'operation_id',k->>'operation_id') OR a.order_id::text IN(j->>'order_id',k->>'order_id') OR a.return_id::text IN(j->>'return_id',k->>'return_id') OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.payload->'snapshot'->'lines')l CROSS JOIN LATERAL jsonb_array_elements(l->'components')c WHERE c->>'product_id' IN(j->>'product_id',k->>'product_id') AND(TG_TABLE_NAME IN('wms_lots','wms_cost_layers','wms_issue_fragments') OR j->>'warehouse_id'=a.payload->'snapshot'->'return_case'->>'warehouse_id' OR k->>'warehouse_id'=a.payload->'snapshot'->'return_case'->>'warehouse_id' OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.payload->'plan'->'stock_effects')x WHERE x->>'warehouse_id' IN(j->>'warehouse_id',k->>'warehouse_id')))) END;
  IF protected THEN RAISE EXCEPTION 'Zatwierdzone przyjęcie do celów jest zamknięte' USING ERRCODE='23514';END IF;
 END LOOP;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;

-- Amend the existing function bodies without replacing their identity or ACL.
-- Every anchor is unique and fail-closed. Legacy branches retain their original
-- text; only a genuine current-TX148 certificate can enter an added branch.
DO $migration$
DECLARE patch record;fn record;definition text;changed text;at integer;closing_anchor text:=' PERFORM return_assistant_physical_validate(a);';
BEGIN
 FOR patch IN SELECT * FROM(VALUES
 ('public.return_assistant_budget()',
  ' IF n>67108864 THEN',
  ' PERFORM public.return_destination_extra_budget(n,t); /* destinations_v1 */'||chr(10)||' IF n>67108864 THEN'),
 ('public.return_assistant_prepare(uuid,uuid,jsonb,uuid,uuid)',
  ' h:=return_assistant_hash(jsonb_build_object(''tenant_id'',t,''preview_id'',pid,''kind'',''receive'',',
  ' IF p.payload->''snapshot''->>''protocol''=''destinations_v1'' THEN RAISE EXCEPTION ''Podgląd wymaga protokołu celów przyjęcia'' USING ERRCODE=''23514'';END IF; /* destinations_v1 */'||chr(10)||' h:=return_assistant_hash(jsonb_build_object(''tenant_id'',t,''preview_id'',pid,''kind'',''receive'','),
 ('public.return_assistant_physical_validate(return_assistant_admissions)',
  ' cur:=return_assistant_source(a.return_id);',
  ' IF public.return_destination_certificate(a.return_id) IS NOT NULL THEN /* destinations_v1 */'||chr(10)||'  IF public.return_destination_certificate(a.return_id) IS DISTINCT FROM a.receipt_id OR public.return_destination_legacy_scope(a.return_id,a.actor_id,a.api_key_id,a.payload->''receive_input'') IS DISTINCT FROM a.receipt_id THEN RAISE EXCEPTION ''Obcy dowód przyjęcia celów'' USING ERRCODE=''23514'';END IF;'||chr(10)||'  PERFORM public.return_destination_physical_validate(a.receipt_id);RETURN;'||chr(10)||' END IF;'||chr(10)||' cur:=return_assistant_source(a.return_id);'),
 ('public.return_assistant_complete()',
  ' FOR phys IN SELECT',
  ' IF public.return_destination_certificate(r.return_id) IS NULL THEN /* destinations_v1 */'||chr(10)||' FOR phys IN SELECT'),
 ('public.return_assistant_finish(uuid,uuid,uuid)',
  '''receipt'',rc.receipt,''decision_note'',rc.decision_note));',
  '''receipt'',rc.receipt,''decision_note'',rc.decision_note)||CASE WHEN p.payload->''snapshot''->>''protocol''=''destinations_v1'' THEN jsonb_build_object(''id'',rc.id,''number'',rc.number,''receipt_sequence'',rc.receipt_sequence) ELSE ''{}''::jsonb END); /* destinations_v1 */'),
 ('public.wms_fragment_consistency()',
  ' IF op.kind IN (''transfer'',''bin_move'')',
  ' IF op.kind=''return'' AND public.return_destination_certificate(op.return_id)=op.id THEN /* destinations_v1 */'||chr(10)||'  PERFORM public.return_destination_physical_validate(op.id);PERFORM set_config(''app.tenant_id'',coalesce(prior_scope,''''),true);RETURN NULL;'||chr(10)||' END IF;'||chr(10)||' IF op.kind IN (''transfer'',''bin_move'')'),
 ('public.wms_validate_operation_scope(uuid,uuid)',
  ' IF op.kind=''return'' THEN',
  ' IF op.kind=''return'' AND public.return_destination_certificate(op.return_id)=op.id THEN /* destinations_v1: active093, cumulative ceiling and no-issue check above retained */'||chr(10)||'  PERFORM public.return_destination_physical_validate(op.id);PERFORM set_config(''app.tenant_id'',coalesce(prior_scope,''''),true);RETURN;'||chr(10)||' END IF;'||chr(10)||' IF op.kind=''return'' THEN'),
 ('public.b2b_return_local_finish(uuid)',
  ' IF EXISTS(SELECT 1 FROM stock_movements m WHERE(m.tenant_id,m.return_id)=(p.tenant_id,r.id) AND',
  ' IF public.return_destination_certificate(r.id) IS NOT NULL THEN /* destinations_v1: original head/items/credit checks retained */'||chr(10)||'  PERFORM public.return_destination_physical_validate(public.return_destination_legacy_scope(r.id,p.actor_id,p.api_key_id,p.request));'||chr(10)||'  UPDATE b2b_return_local_proofs SET applied=true,after_snapshot=b2b_return_local_snapshot(r.id) WHERE id=pid;RETURN;'||chr(10)||' END IF;'||chr(10)||' IF EXISTS(SELECT 1 FROM stock_movements m WHERE(m.tenant_id,m.return_id)=(p.tenant_id,r.id) AND'),
 ('public.order_parcel_return_validate_receive(uuid,uuid,uuid,jsonb,jsonb)',
  ' PERFORM order_parcel_require(uid,kid,true,false);SELECT * INTO r',
  ' IF public.return_destination_certificate(rid) IS NOT NULL THEN /* destinations_v1 */'||chr(10)||'  PERFORM public.return_destination_validate_parcel(rid,uid,kid,b,p);RETURN;'||chr(10)||' END IF;'||chr(10)||' PERFORM order_parcel_require(uid,kid,true,false);SELECT * INTO r'),
 ('public.order_parcel_return_validate_physical(order_parcel_return_admissions)',
  ' SELECT a.tenant_id tenant_id,a.return_id return_id',
  ' IF public.return_destination_certificate(a.return_id) IS NOT NULL THEN /* destinations_v1 */'||chr(10)||'  IF a.payload IS DISTINCT FROM public.return_destination_parcel_payload(a.return_id,(SELECT da.payload->''plan'' FROM public.return_destination_admissions da WHERE(da.tenant_id,da.receipt_id)=(a.tenant_id,public.return_destination_certificate(a.return_id)))) THEN RAISE EXCEPTION ''Pochodzenie ma inny plan celów'' USING ERRCODE=''23514'';END IF;'||chr(10)||'  PERFORM public.return_destination_physical_validate(public.return_destination_legacy_scope(a.return_id,a.actor_id,a.api_key_id,a.body));RETURN;'||chr(10)||' END IF;'||chr(10)||' SELECT a.tenant_id tenant_id,a.return_id return_id')
 )v(signature,needle,replacement) LOOP
  SELECT p.* INTO fn FROM pg_proc p WHERE p.oid=to_regprocedure(patch.signature);
  IF fn.oid IS NULL OR fn.prolang IS DISTINCT FROM(SELECT oid FROM pg_language WHERE lanname='plpgsql') THEN RAISE EXCEPTION 'Brak oczekiwanej funkcji poprzedniego protokołu: %',patch.signature;END IF;
  at:=strpos(fn.prosrc,patch.needle);
  IF at=0 OR strpos(substr(fn.prosrc,at+length(patch.needle)),patch.needle)>0 THEN RAISE EXCEPTION 'Niejednoznaczny poprzedni protokół: %',patch.signature;END IF;
  changed:=replace(fn.prosrc,patch.needle,patch.replacement);
  IF patch.signature='public.return_assistant_complete()' THEN
   -- Opening and closing the conditional are ONE replacement transaction.
   -- Compiling its opening before its closing would create invalid PL/pgSQL.
   at:=strpos(changed,closing_anchor);
   IF at=0 OR strpos(substr(changed,at+length(closing_anchor)),closing_anchor)>0 THEN RAISE EXCEPTION 'Niejednoznaczne zamknięcie fizycznej gałęzi asystenta';END IF;
   changed:=replace(changed,closing_anchor,' END IF; /* destinations_v1: common financial checks above remain mandatory */'||chr(10)||closing_anchor);
   IF strpos(changed,'END IF; /* destinations_v1: common financial checks above remain mandatory */')<=strpos(changed,'IF public.return_destination_certificate(r.return_id) IS NULL THEN') THEN RAISE EXCEPTION 'Niepełna para warunku fizycznego asystenta';END IF;
  END IF;
  definition:=pg_get_functiondef(fn.oid);definition:=replace(definition,fn.prosrc,changed);EXECUTE definition;
  IF(SELECT prosrc FROM pg_proc WHERE oid=fn.oid) IS DISTINCT FROM changed THEN RAISE EXCEPTION 'Podmiana nie zachowała dokładnej treści poprzedniego protokołu';END IF;
  IF to_regprocedure(patch.signature)::oid IS DISTINCT FROM fn.oid OR(SELECT (proowner,proacl) FROM pg_proc WHERE oid=fn.oid) IS DISTINCT FROM ROW(fn.proowner,fn.proacl) THEN RAISE EXCEPTION 'Zmieniła się tożsamość lub ACL poprzedniego protokołu';END IF;
 END LOOP;
END $migration$;
-- This trigger must call private148 validators without granting their EXECUTE
-- to app callers. Its existing legacy queries remain scoped to NEW.tenant_id.
-- Qualify every persisted relation in the whole legacy body before elevating
-- it: an implicit pg_temp path must never substitute a proof relation.
DO $qualification$
DECLARE fn record;changed text;definition text;signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.wms_fragment_consistency()','public.wms_validate_operation_scope(uuid,uuid)'] LOOP
 SELECT p.* INTO fn FROM pg_proc p WHERE p.oid=to_regprocedure(signature);
 changed:=regexp_replace(fn.prosrc,'(\m(?:FROM|JOIN)[[:space:]]+)(wms_issue_fragments|wms_return_fragments|wms_operations|wms_layer_movements|return_cases|return_items|wms_cost_layers|wms_lots)\M','\1public.\2','gi');
 IF changed=fn.prosrc OR changed~*'\m(?:FROM|JOIN)[[:space:]]+(?:wms_issue_fragments|wms_return_fragments|wms_operations|wms_layer_movements|return_cases|return_items|wms_cost_layers|wms_lots)\M' THEN RAISE EXCEPTION 'Niepełna kwalifikacja relacji WMS';END IF;
 definition:=replace(pg_get_functiondef(fn.oid),fn.prosrc,changed);EXECUTE definition;
 IF to_regprocedure(signature)::oid IS DISTINCT FROM fn.oid OR(SELECT(proowner,proacl) FROM pg_proc WHERE oid=fn.oid) IS DISTINCT FROM ROW(fn.proowner,fn.proacl) OR(SELECT prosrc FROM pg_proc WHERE oid=fn.oid) IS DISTINCT FROM changed THEN RAISE EXCEPTION 'Zmieniła się tożsamość, treść lub ACL funkcji WMS';END IF;
 END LOOP;
END $qualification$;
ALTER FUNCTION public.wms_fragment_consistency() SECURITY DEFINER;
ALTER FUNCTION public.wms_fragment_consistency() SET search_path=pg_catalog,public,pg_temp;

-- Actual complete target/source union, including prior journals. No generated
-- witness can replace these genuine rows and no prior row may be overwritten.
CREATE FUNCTION return_destination_snapshot(eid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;a public.return_destination_admissions;out_rows jsonb:='{}';nm text;rows_json jsonb;BEGIN
 SELECT * INTO a FROM public.return_destination_admissions WHERE(tenant_id,receipt_id)=(t,eid);
 IF a.receipt_id IS NULL THEN RAISE EXCEPTION 'Brak własnego zakresu przyjęcia' USING ERRCODE='23514';END IF;
 FOREACH nm IN ARRAY ARRAY['stock','stock_locations','stock_location_movements','wms_layer_positions','wms_layer_movements'] LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),''[]''::jsonb) FROM public.%I x WHERE x.tenant_id=$1 AND ((EXISTS(SELECT 1 FROM jsonb_array_elements($2->''snapshot''->''lines'')l CROSS JOIN LATERAL jsonb_array_elements(l->''components'')c WHERE c->>''product_id''=x.product_id::text) AND (x.warehouse_id=($2->''snapshot''->''return_case''->>''warehouse_id'')::uuid OR EXISTS(SELECT 1 FROM jsonb_array_elements($2->''plan''->''stock_effects'')z WHERE z->>''warehouse_id''=x.warehouse_id::text)))%s)',nm,CASE WHEN nm='wms_layer_movements' THEN ' OR x.operation_id=$3' ELSE '' END) INTO rows_json USING t,a.payload,eid;
  out_rows:=out_rows||jsonb_build_object(nm,rows_json);
 END LOOP;
 FOREACH nm IN ARRAY ARRAY['wms_cost_layers','wms_lots'] LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),''[]''::jsonb) FROM public.%I x WHERE x.tenant_id=$1 AND (x.operation_id=$3 OR EXISTS(SELECT 1 FROM jsonb_array_elements($2->''snapshot''->''lines'')l CROSS JOIN LATERAL jsonb_array_elements(l->''components'')c WHERE c->>''product_id''=x.product_id::text))',nm) INTO rows_json USING t,a.payload,eid;
  out_rows:=out_rows||jsonb_build_object(nm,rows_json);
 END LOOP;
 FOREACH nm IN ARRAY ARRAY['order_items','return_cases','return_items','stock_movements','wms_return_fragments','wms_issue_fragments','wms_operations','payment_entries','documents','reservations','reservation_locations','wms_reservation_layers','shipments','order_parcel_dispatches','order_parcel_releases'] LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),''[]''::jsonb) FROM public.%I x WHERE x.tenant_id=$1 AND (x.order_id=$2%s)',nm,CASE WHEN nm IN('wms_return_fragments','wms_issue_fragments') THEN ' OR x.operation_id=$3' WHEN nm='wms_operations' THEN ' OR x.id=$3' ELSE '' END) INTO rows_json USING t,a.order_id,eid;
  out_rows:=out_rows||jsonb_build_object(nm,rows_json);
 END LOOP;
 out_rows:=out_rows||jsonb_build_object('orders',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.id),'[]') FROM public.orders o WHERE(o.tenant_id,o.id)=(t,a.order_id)));
 IF octet_length(out_rows::text)>8388608 THEN RAISE EXCEPTION 'Zbyt duży fizyczny zakres przyjęcia' USING ERRCODE='54000';END IF;
 RETURN out_rows;
END $$;

-- Lightweight resource fence is safe for a completed exact replay: it does not
-- validate an expired lease or changed business frame. Resource locks must
-- precede the shared quota even when this private factory is called directly.
CREATE FUNCTION return_destination_resources(sid uuid,b jsonb,uid uuid,kid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;s public.return_assistant_sessions;wh uuid;BEGIN
 PERFORM public.return_destination_require(uid,kid,true,false);
 SELECT * INTO s FROM public.return_assistant_sessions WHERE(tenant_id,id)=(t,sid);
 IF s.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnej sesji' USING ERRCODE='P0002';END IF;
 IF NOT public.return_destination_request_valid(b) THEN RAISE EXCEPTION 'Niepoprawny zakres celów' USING ERRCODE='23514';END IF;
 FOR wh IN SELECT x FROM(SELECT(s.source->'return_case'->>'warehouse_id')::uuid x UNION SELECT(v.settings->>'warehouse_id')::uuid FROM public.return_destination_statuses h JOIN public.return_destination_status_revisions v ON(v.tenant_id,v.status_id,v.id,v.version)=(h.tenant_id,h.id,h.revision_id,h.version) WHERE h.tenant_id=t AND h.id IN(SELECT(p->>'status_id')::uuid FROM jsonb_array_elements(b->'parts')p) AND v.settings->>'warehouse_id' IS NOT NULL)u ORDER BY x LOOP PERFORM public.warehouse_inventory_policy_lock(t,wh);END LOOP;
 PERFORM 1 FROM public.return_destination_statuses h WHERE h.tenant_id=t AND h.id IN(SELECT(p->>'status_id')::uuid FROM jsonb_array_elements(b->'parts')p) ORDER BY h.id FOR SHARE;
 PERFORM public.return_assistant_lock();
END $$;

CREATE FUNCTION return_destination_preview(pid uuid,sid uuid,b jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p public.return_assistant_previews;f jsonb;h text;nonce uuid:=gen_random_uuid();stamp timestamptz:=clock_timestamp();BEGIN
 PERFORM public.return_destination_require(uid,kid,true,false);
 IF NOT public.return_destination_request_valid(b) THEN RAISE EXCEPTION 'Niepoprawny zakres podglądu' USING ERRCODE='23514';END IF;
 h:=public.return_assistant_hash(jsonb_build_object('tenant_id',t,'session_id',sid,'kind','destinations_preview','actor_id',uid,'api_key_id',kid,'request',b));
 SELECT * INTO p FROM public.return_assistant_previews WHERE tenant_id=t AND client_key=(b->>'client_key')::uuid;
 IF p.id IS NOT NULL THEN IF(p.session_id,p.actor_id,p.api_key_id,p.request_hash,p.payload->'snapshot'->>'protocol') IS DISTINCT FROM(sid,uid,kid,h,'destinations_v1') THEN RAISE EXCEPTION 'Klucz podglądu ma inny zakres' USING ERRCODE='23514';END IF;RETURN p.id;END IF;
 PERFORM public.return_destination_resources(sid,b,uid,kid);
 SELECT * INTO p FROM public.return_assistant_previews WHERE tenant_id=t AND client_key=(b->>'client_key')::uuid;
 IF p.id IS NOT NULL THEN IF(p.session_id,p.actor_id,p.api_key_id,p.request_hash,p.payload->'snapshot'->>'protocol') IS DISTINCT FROM(sid,uid,kid,h,'destinations_v1') THEN RAISE EXCEPTION 'Klucz podglądu ma inny zakres' USING ERRCODE='23514';END IF;RETURN p.id;END IF;
 f:=public.return_destination_frame(sid,b,uid,kid);
 IF octet_length(f::text)>4194304 THEN RAISE EXCEPTION 'Podgląd przekracza limit' USING ERRCODE='54000';END IF;
 INSERT INTO public.return_assistant_previews(id,tenant_id,session_id,return_id,order_id,actor_id,api_key_id,client_key,request_hash,scope_hash,private_scope_nonce,payload,created_at,expires_at)
 VALUES(pid,t,sid,(f->'planner_source'->>'return_id')::uuid,(f->'planner_source'->>'order_id')::uuid,uid,kid,(b->>'client_key')::uuid,h,public.return_assistant_hash(f||jsonb_build_object('private_scope_nonce',nonce)),nonce,f,stamp,stamp+interval '15 minutes');
 PERFORM public.return_destination_budget();RETURN pid;
END $$;

CREATE FUNCTION return_destination_prepare(pid uuid,eid uuid,b jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p public.return_assistant_previews;r public.return_assistant_receipts;f jsonb;h text;req jsonb;BEGIN
 PERFORM public.return_destination_require(uid,kid,true,false);
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR b-ARRAY['client_key','scope_hash','confirmed','lease_token']<>'{}' OR NOT b?&ARRAY['client_key','scope_hash','confirmed','lease_token'] OR b->'confirmed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Wymagana oddzielna dokładna zgoda' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(b->'client_key') IS DISTINCT FROM 'string' OR coalesce(b->>'client_key','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(b->'lease_token') IS DISTINCT FROM 'string' OR coalesce(b->>'lease_token','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(b->'scope_hash') IS DISTINCT FROM 'string' OR coalesce(b->>'scope_hash','')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Zgoda wymaga kanonicznego klucza, zakresu i dzierżawy' USING ERRCODE='23514';END IF;
 h:=public.return_assistant_hash(jsonb_build_object('tenant_id',t,'preview_id',pid,'kind','destinations_receive','request',b,'actor_id',uid,'api_key_id',kid));
 SELECT * INTO r FROM public.return_assistant_receipts WHERE tenant_id=t AND client_key=(b->>'client_key')::uuid;
 IF r.id IS NOT NULL THEN IF(r.preview_id,r.actor_id,r.api_key_id,r.request_hash,r.payload->'snapshot'->>'protocol') IS DISTINCT FROM(pid,uid,kid,h,'destinations_v1') THEN RAISE EXCEPTION 'Klucz przyjęcia ma inny zakres' USING ERRCODE='23514';END IF;RETURN r.id;END IF;
 SELECT * INTO p FROM public.return_assistant_previews WHERE(tenant_id,id)=(t,pid);
 IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono podglądu' USING ERRCODE='P0002';END IF;
 req:=p.payload->'snapshot'->'request'||jsonb_build_object('client_key',p.client_key,'lease_token',b->'lease_token');
 PERFORM public.return_destination_resources(p.session_id,req,uid,kid);
 SELECT * INTO r FROM public.return_assistant_receipts WHERE tenant_id=t AND client_key=(b->>'client_key')::uuid;
 IF r.id IS NOT NULL THEN IF(r.preview_id,r.actor_id,r.api_key_id,r.request_hash,r.payload->'snapshot'->>'protocol') IS DISTINCT FROM(pid,uid,kid,h,'destinations_v1') THEN RAISE EXCEPTION 'Klucz przyjęcia ma inny zakres' USING ERRCODE='23514';END IF;RETURN r.id;END IF;
 IF(p.actor_id,p.api_key_id) IS DISTINCT FROM(uid,kid) OR p.payload->'snapshot'->>'protocol' IS DISTINCT FROM 'destinations_v1' OR p.expires_at<=clock_timestamp() OR b->>'scope_hash' IS DISTINCT FROM p.scope_hash THEN RAISE EXCEPTION 'Zgoda wymaga świeżego własnego podglądu' USING ERRCODE='23514';END IF;
 req:=p.payload->'snapshot'->'request'||jsonb_build_object('client_key',p.client_key,'lease_token',b->'lease_token');f:=public.return_destination_frame(p.session_id,req,uid,kid);
 IF f IS DISTINCT FROM p.payload OR p.scope_hash IS DISTINCT FROM public.return_assistant_hash(f||jsonb_build_object('private_scope_nonce',p.private_scope_nonce)) THEN RAISE EXCEPTION 'Źródło kontroli zmieniło się' USING ERRCODE='23514';END IF;
 INSERT INTO public.return_assistant_admissions(tenant_id,transaction_id,receipt_id,preview_id,session_id,return_id,actor_id,api_key_id,client_key,request_hash,payload) VALUES(t,pg_current_xact_id(),eid,p.id,p.session_id,p.return_id,uid,kid,(b->>'client_key')::uuid,h,f);
 INSERT INTO public.return_destination_admissions(tenant_id,receipt_id,preview_id,session_id,return_id,order_id,actor_id,api_key_id,transaction_id,backend_pid,client_key,request_hash,request,payload,before_snapshot)
 VALUES(t,eid,p.id,p.session_id,p.return_id,p.order_id,uid,kid,pg_current_xact_id(),pg_backend_pid(),(b->>'client_key')::uuid,h,b,f,'{}');
 -- Factory-only initial snapshot initialization is checked by record_guard.
 UPDATE public.return_destination_admissions SET before_snapshot=public.return_destination_snapshot(eid) WHERE(tenant_id,receipt_id)=(t,eid);
 PERFORM public.return_destination_budget();RETURN eid;
END $$;

CREATE FUNCTION return_destination_admission_scope(eid uuid,rid uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.return_destination_admissions;t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;BEGIN
 PERFORM public.return_destination_require(uid,kid,true,false);
 SELECT * INTO a FROM public.return_destination_admissions WHERE(tenant_id,receipt_id,return_id,actor_id,transaction_id,backend_pid)=(t,eid,rid,uid,pg_current_xact_id(),pg_backend_pid()) AND api_key_id IS NOT DISTINCT FROM kid;
 IF a.receipt_id IS NULL OR a.before_snapshot='{}' OR EXISTS(SELECT 1 FROM public.return_assistant_receipts WHERE(tenant_id,id)=(t,eid)) THEN RAISE EXCEPTION 'Brak świeżej zgody fizycznego przyjęcia' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('action',a.payload->'action','plan',a.payload->'plan','receive_input',a.payload->'receive_input','preview_id',a.preview_id,'wms_enabled',a.payload->'planner_source'->'wms'->'enabled','wms_policy_version',a.payload->'planner_source'->'wms'->'policy_version','wms_operation_id',eid,'parcel_payload',public.return_destination_parcel_payload(rid,a.payload->'plan'));
END $$;

CREATE FUNCTION return_destination_certificate(rid uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT a.receipt_id FROM public.return_destination_admissions a WHERE(a.tenant_id,a.return_id,a.transaction_id,a.backend_pid)=(nullif(current_setting('app.tenant_id',true),'')::uuid,rid,pg_current_xact_id(),pg_backend_pid()) AND a.before_snapshot<>'{}'
$$;

CREATE FUNCTION return_destination_parcel_payload(rid uuid,plan jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;d jsonb;cl public.order_parcel_return_claims;co record;mp record;decisions jsonb:='[]';fragments jsonb:='[]';accepted_left bigint;sale_left bigint;accepted_qty bigint;sale_qty bigint;needed bigint;taken bigint;remaining jsonb:='{}';prior bigint;BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.order_parcel_return_claims WHERE(tenant_id,return_id)=(t,rid)) THEN RETURN NULL;END IF;
 FOR d IN SELECT value FROM jsonb_array_elements(plan->'decisions') LOOP
  accepted_left:=(d->>'accepted')::bigint;sale_left:=(d->>'restocked')::bigint;
  FOR cl IN SELECT * FROM public.order_parcel_return_claims WHERE(tenant_id,return_id,item_id)=(t,rid,(d->>'item_id')::uuid) ORDER BY ordinal LOOP
   accepted_qty:=least(cl.quantity,accepted_left);sale_qty:=least(accepted_qty,sale_left);accepted_left:=accepted_left-accepted_qty;sale_left:=sale_left-sale_qty;
   decisions:=decisions||jsonb_build_array(jsonb_build_object('origin_id',cl.origin_id,'item_id',cl.item_id,'dispatch_id',cl.dispatch_id,'requested',cl.quantity,'accepted',accepted_qty,'restocked',sale_qty,'custody',accepted_qty-sale_qty));
  END LOOP;
  IF accepted_left<>0 OR sale_left<>0 THEN RAISE EXCEPTION 'Przyjęcie przekracza wydane źródło pozycji' USING ERRCODE='23514';END IF;
 END LOOP;
 SELECT coalesce(jsonb_object_agg(id,to_jsonb(qty)),'{}') INTO remaining FROM(SELECT x->>'issue_fragment_id' id,sum((x->>'quantity')::bigint) qty FROM jsonb_array_elements(plan->'private_fragment_effects')x GROUP BY 1)z;
 IF EXISTS(SELECT 1 FROM public.wms_policies WHERE tenant_id=t AND enabled) THEN
  FOR d IN SELECT value FROM jsonb_array_elements(decisions) ORDER BY value->>'origin_id' LOOP
   FOR co IN SELECT c->>'product_id' product_id,sum((c->>'quantity')::bigint) coefficient FROM public.order_parcel_commercial_origins o CROSS JOIN LATERAL jsonb_array_elements(o.snapshot->'components')c WHERE(o.tenant_id,o.id)=(t,(d->>'origin_id')::uuid) GROUP BY c->>'product_id' ORDER BY c->>'product_id' LOOP
    needed:=(d->>'accepted')::bigint*co.coefficient;
    FOR mp IN SELECT m.* FROM public.order_parcel_origin_fragments m WHERE(m.tenant_id,m.origin_id,m.dispatch_id,m.product_id)=(t,(d->>'origin_id')::uuid,(d->>'dispatch_id')::uuid,co.product_id::uuid) ORDER BY m.fragment_id LOOP
     SELECT coalesce(sum((x->>'quantity')::bigint),0) INTO prior FROM public.order_parcel_return_receipts rr CROSS JOIN LATERAL jsonb_array_elements(rr.payload->'fragments')x WHERE rr.tenant_id=t AND rr.return_id<>rid AND(x->>'origin_id',x->>'fragment_id')=(d->>'origin_id',mp.fragment_id::text);
     IF prior>mp.quantity THEN RAISE EXCEPTION 'Historyczny fragment źródła przekroczył pojemność' USING ERRCODE='23514';END IF;
     taken:=least(needed,mp.quantity-prior,coalesce((remaining->>mp.fragment_id::text)::bigint,0));
     IF taken>0 THEN fragments:=fragments||jsonb_build_array(jsonb_build_object('origin_id',d->>'origin_id','fragment_id',mp.fragment_id,'product_id',co.product_id,'quantity',taken));remaining:=jsonb_set(remaining,ARRAY[mp.fragment_id::text],to_jsonb((remaining->>mp.fragment_id::text)::bigint-taken));needed:=needed-taken;END IF;
     EXIT WHEN needed=0;
    END LOOP;
    IF needed<>0 THEN RAISE EXCEPTION 'SALE i CUSTODY nie pokrywają własnych wydanych jednostek handlowych' USING ERRCODE='23514';END IF;
   END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_each(remaining)x WHERE(x.value#>>'{}')::bigint<>0) THEN RAISE EXCEPTION 'Fragment nie ma dokładnego źródła handlowego' USING ERRCODE='23514';END IF;
 ELSIF jsonb_array_length(plan->'private_fragment_effects')>0 THEN RAISE EXCEPTION 'OFF nie tworzy fragmentów źródła' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('protocol','destinations_v1','decisions',decisions,'fragments',fragments);
END $$;

CREATE FUNCTION return_destination_legacy_scope(rid uuid,uid uuid,kid uuid,b jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE eid uuid:=public.return_destination_certificate(rid);a public.return_destination_admissions;t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;BEGIN
 IF eid IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO a FROM public.return_destination_admissions WHERE(tenant_id,receipt_id)=(t,eid);
 IF(a.actor_id,a.api_key_id,a.payload->'receive_input') IS DISTINCT FROM(uid,kid,b) THEN RAISE EXCEPTION 'Core wymaga dokładnej zgody celów przyjęcia' USING ERRCODE='23514';END IF;
 PERFORM public.return_destination_require(uid,kid,true,false);RETURN eid;
END $$;

CREATE FUNCTION return_destination_validate_parcel(rid uuid,uid uuid,kid uuid,b jsonb,p jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE eid uuid:=public.return_destination_legacy_scope(rid,uid,kid,b);a public.return_destination_admissions;r public.return_cases;BEGIN
 IF eid IS NULL THEN RAISE EXCEPTION 'Brak certyfikowanej zgody przyjęcia pochodzenia' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM public.return_destination_admissions WHERE receipt_id=eid AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 SELECT * INTO r FROM public.return_cases WHERE(tenant_id,id)=(a.tenant_id,rid);
 IF r.state IS DISTINCT FROM 'requested' OR r.receipt IS NOT NULL OR r.version IS DISTINCT FROM(b->>'version')::bigint OR p IS DISTINCT FROM public.return_destination_parcel_payload(rid,a.payload->'plan') OR p IS NULL THEN RAISE EXCEPTION 'Pochodzenie przyjęcia ma inny zakres zgody' USING ERRCODE='23514';END IF;
 PERFORM public.order_parcel_return_shipping_limit(a.order_id,rid,(b->>'shipping_refund')::bigint);
END $$;

CREATE FUNCTION return_destination_finish(eid uuid,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;a public.return_destination_admissions;pt jsonb;ar jsonb;ff jsonb;fid uuid;arrival_id uuid;BEGIN
 PERFORM public.return_destination_require(uid,kid,true,false);
 SELECT * INTO a FROM public.return_destination_admissions WHERE(tenant_id,receipt_id,transaction_id,backend_pid,actor_id)=(t,eid,pg_current_xact_id(),pg_backend_pid(),uid) AND api_key_id IS NOT DISTINCT FROM kid;
 IF a.receipt_id IS NULL OR a.after_snapshot IS NOT NULL OR EXISTS(SELECT 1 FROM public.return_assistant_receipts WHERE(tenant_id,id)=(t,eid)) THEN RAISE EXCEPTION 'Brak niezakończonej zgody bieżącego przyjęcia' USING ERRCODE='23514';END IF;
 PERFORM public.return_destination_physical_validate(eid);
 FOR pt IN SELECT value FROM jsonb_array_elements(a.payload->'plan'->'parts') LOOP
  INSERT INTO public.return_destination_parts(tenant_id,id,receipt_id,preview_id,session_id,return_id,order_id,item_id,quantity,status_id,status_version,status_revision_id,decision,effect,warehouse_id,warehouse_policy_version,refund_minor,snapshot)
  VALUES(t,(pt->>'part_id')::uuid,eid,a.preview_id,a.session_id,a.return_id,a.order_id,(pt->>'item_id')::uuid,(pt->>'quantity')::int,(pt->'status'->>'status_id')::uuid,(pt->'status'->>'version')::bigint,(pt->'status'->>'revision_id')::uuid,pt->'status'->>'decision',pt->'status'->>'inventory_effect',(pt->'status'->>'warehouse_id')::uuid,(pt->'status'->>'warehouse_policy_version')::bigint,(pt->>'refund_minor')::bigint,pt);
 END LOOP;
 FOR ar IN SELECT value FROM jsonb_array_elements(a.payload->'plan'->'arrivals') LOOP
  arrival_id:=public.return_destination_identity(eid,'arrival:'||(ar->>'part_id')||':'||(ar->>'product_id'));
  INSERT INTO public.return_destination_arrivals(tenant_id,id,receipt_id,part_id,return_id,order_id,item_id,product_id,warehouse_id,location,quantity,effect)
  VALUES(t,arrival_id,eid,(ar->>'part_id')::uuid,a.return_id,a.order_id,(ar->>'item_id')::uuid,(ar->>'product_id')::uuid,(ar->>'warehouse_id')::uuid,ar->>'location',(ar->>'quantity')::int,ar->>'effect');
 END LOOP;
 FOR ff IN SELECT value FROM jsonb_array_elements(a.payload->'plan'->'private_fragment_effects') LOOP
  SELECT f.id INTO fid FROM public.wms_return_fragments f WHERE(f.tenant_id,f.operation_id,f.return_id,f.order_id,f.issue_fragment_id,f.product_id,f.layer_id,f.warehouse_id,f.location,f.quantity)=(t,eid,a.return_id,a.order_id,(ff->>'issue_fragment_id')::uuid,(ff->>'product_id')::uuid,(ff->>'layer_id')::uuid,(ff->>'warehouse_id')::uuid,ff->>'location',(ff->>'quantity')::int)
  AND f.value_minor IS NOT DISTINCT FROM(ff->>'value_minor')::bigint AND NOT EXISTS(SELECT 1 FROM public.return_destination_fragments df WHERE(df.tenant_id,df.fragment_id)=(t,f.id)) ORDER BY f.id LIMIT 1;
  IF fid IS NULL THEN RAISE EXCEPTION 'Nie istnieje rzeczywisty sklasyfikowany fragment przyjęcia' USING ERRCODE='23514';END IF;
  INSERT INTO public.return_destination_fragments(tenant_id,receipt_id,arrival_id,part_id,return_id,order_id,item_id,product_id,warehouse_id,location,fragment_id,issue_fragment_id,layer_id,quantity,effect)
  VALUES(t,eid,public.return_destination_identity(eid,'arrival:'||(ff->>'part_id')||':'||(ff->>'product_id')),(ff->>'part_id')::uuid,a.return_id,a.order_id,(ff->>'item_id')::uuid,(ff->>'product_id')::uuid,(ff->>'warehouse_id')::uuid,ff->>'location',fid,(ff->>'issue_fragment_id')::uuid,(ff->>'layer_id')::uuid,(ff->>'quantity')::int,ff->>'effect');
 END LOOP;
 UPDATE public.return_destination_admissions SET after_snapshot=public.return_destination_snapshot(eid) WHERE(tenant_id,receipt_id)=(t,eid);
 PERFORM public.return_assistant_finish(eid,uid,kid);PERFORM public.return_destination_budget();RETURN eid;
END $$;

CREATE FUNCTION return_destination_record_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;t uuid:=(j->>'tenant_id')::uuid;eid uuid:=(j->>'receipt_id')::uuid;a public.return_destination_admissions;p public.return_assistant_previews;wanted jsonb;f public.wms_return_fragments;BEGIN
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Obca firma trwałego dowodu przyjęcia' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Dowód celu przyjęcia jest niezmienny' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='return_destination_admissions' THEN
  IF OLD.transaction_id=pg_current_xact_id() AND OLD.backend_pid=pg_backend_pid() AND NOT EXISTS(SELECT 1 FROM public.return_assistant_receipts WHERE(tenant_id,id)=(t,eid)) THEN
   IF OLD.before_snapshot='{}' AND NEW.before_snapshot IS NOT DISTINCT FROM public.return_destination_snapshot(eid) AND(to_jsonb(OLD)-'before_snapshot') IS NOT DISTINCT FROM(to_jsonb(NEW)-'before_snapshot') THEN RETURN NEW;END IF;
   IF OLD.before_snapshot<>'{}' AND OLD.after_snapshot IS NULL AND NEW.after_snapshot IS NOT DISTINCT FROM public.return_destination_snapshot(eid) AND(to_jsonb(OLD)-'after_snapshot') IS NOT DISTINCT FROM(to_jsonb(NEW)-'after_snapshot') THEN PERFORM public.return_destination_physical_validate(eid);RETURN NEW;END IF;
   IF pg_trigger_depth()>=2 AND OLD.after_snapshot IS NULL AND(to_jsonb(OLD)-'witnesses') IS NOT DISTINCT FROM(to_jsonb(NEW)-'witnesses') AND jsonb_typeof(NEW.witnesses)='array' AND jsonb_array_length(NEW.witnesses)=jsonb_array_length(OLD.witnesses)+1 AND NEW.witnesses->jsonb_array_length(OLD.witnesses) IS NOT NULL AND NEW.witnesses- (jsonb_array_length(NEW.witnesses)-1) IS NOT DISTINCT FROM OLD.witnesses AND jsonb_array_length(NEW.witnesses)<=10000 THEN RETURN NEW;END IF;
  END IF;
  END IF;
  RAISE EXCEPTION 'Dowód celu przyjęcia jest niezmienny' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='return_destination_admissions' THEN
  SELECT * INTO p FROM public.return_assistant_previews WHERE(tenant_id,id)=(t,NEW.preview_id);
  IF NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() OR NEW.backend_pid IS DISTINCT FROM pg_backend_pid() OR NEW.before_snapshot<>'{}' OR NEW.after_snapshot IS NOT NULL OR NEW.witnesses<>'[]'
  OR p.id IS NULL OR(NEW.session_id,NEW.return_id,NEW.order_id,NEW.actor_id,NEW.api_key_id,NEW.payload) IS DISTINCT FROM(p.session_id,p.return_id,p.order_id,p.actor_id,p.api_key_id,p.payload)
  OR p.payload->'snapshot'->>'protocol' IS DISTINCT FROM 'destinations_v1' OR NOT EXISTS(SELECT 1 FROM public.return_assistant_admissions ad WHERE(ad.tenant_id,ad.transaction_id,ad.receipt_id,ad.preview_id,ad.session_id,ad.return_id,ad.actor_id,ad.client_key,ad.request_hash,ad.payload)=(t,NEW.transaction_id,eid,p.id,p.session_id,p.return_id,NEW.actor_id,NEW.client_key,NEW.request_hash,p.payload) AND ad.api_key_id IS NOT DISTINCT FROM NEW.api_key_id)
  OR NEW.request_hash IS DISTINCT FROM public.return_assistant_hash(jsonb_build_object('tenant_id',t,'preview_id',p.id,'kind','destinations_receive','request',NEW.request,'actor_id',NEW.actor_id,'api_key_id',NEW.api_key_id)) THEN RAISE EXCEPTION 'Dopuszczenie nie odpowiada bieżącej zgodzie podglądu' USING ERRCODE='23514';END IF;
  PERFORM public.return_destination_require(NEW.actor_id,NEW.api_key_id,true,false);RETURN NEW;
 END IF;
 SELECT * INTO a FROM public.return_destination_admissions WHERE(tenant_id,receipt_id,transaction_id,backend_pid)=(t,eid,pg_current_xact_id(),pg_backend_pid());
 IF a.receipt_id IS NULL OR a.before_snapshot='{}' OR a.after_snapshot IS NOT NULL OR EXISTS(SELECT 1 FROM public.return_assistant_receipts WHERE(tenant_id,id)=(t,eid)) THEN RAISE EXCEPTION 'Trwały wiersz wymaga bieżącej świeżej zgody' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='return_destination_parts' THEN
  SELECT x INTO wanted FROM jsonb_array_elements(a.payload->'plan'->'parts')x WHERE x->>'part_id'=NEW.id::text;
  IF wanted IS NULL OR(NEW.preview_id,NEW.session_id,NEW.return_id,NEW.order_id,NEW.item_id,NEW.quantity,NEW.status_id,NEW.status_version,NEW.status_revision_id,NEW.decision,NEW.effect,NEW.warehouse_id,NEW.warehouse_policy_version,NEW.refund_minor,NEW.snapshot) IS DISTINCT FROM(a.preview_id,a.session_id,a.return_id,a.order_id,(wanted->>'item_id')::uuid,(wanted->>'quantity')::int,(wanted->'status'->>'status_id')::uuid,(wanted->'status'->>'version')::bigint,(wanted->'status'->>'revision_id')::uuid,wanted->'status'->>'decision',wanted->'status'->>'inventory_effect',(wanted->'status'->>'warehouse_id')::uuid,(wanted->'status'->>'warehouse_policy_version')::bigint,(wanted->>'refund_minor')::bigint,wanted) THEN RAISE EXCEPTION 'Część nie odpowiada podglądowi' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='return_destination_arrivals' THEN
  SELECT x INTO wanted FROM jsonb_array_elements(a.payload->'plan'->'arrivals')x WHERE(x->>'part_id',x->>'product_id')=(NEW.part_id::text,NEW.product_id::text);
  IF wanted IS NULL OR NEW.id IS DISTINCT FROM public.return_destination_identity(eid,'arrival:'||(wanted->>'part_id')||':'||(wanted->>'product_id')) OR(NEW.return_id,NEW.order_id,NEW.item_id,NEW.warehouse_id,NEW.location,NEW.quantity,NEW.effect) IS DISTINCT FROM(a.return_id,a.order_id,(wanted->>'item_id')::uuid,(wanted->>'warehouse_id')::uuid,wanted->>'location',(wanted->>'quantity')::int,wanted->>'effect') THEN RAISE EXCEPTION 'Przyjęcie składnika nie odpowiada części' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='return_destination_fragments' THEN
  SELECT x INTO wanted FROM jsonb_array_elements(a.payload->'plan'->'private_fragment_effects')x WHERE(x->>'part_id',x->>'issue_fragment_id',x->>'location')=(NEW.part_id::text,NEW.issue_fragment_id::text,NEW.location);
  SELECT * INTO f FROM public.wms_return_fragments WHERE(tenant_id,id)=(t,NEW.fragment_id);
  IF wanted IS NULL OR f.id IS NULL OR(NEW.arrival_id,NEW.return_id,NEW.order_id,NEW.item_id,NEW.product_id,NEW.layer_id,NEW.warehouse_id,NEW.quantity,NEW.effect) IS DISTINCT FROM(public.return_destination_identity(eid,'arrival:'||(wanted->>'part_id')||':'||(wanted->>'product_id')),a.return_id,a.order_id,(wanted->>'item_id')::uuid,(wanted->>'product_id')::uuid,(wanted->>'layer_id')::uuid,(wanted->>'warehouse_id')::uuid,(wanted->>'quantity')::int,wanted->>'effect')
  OR(f.operation_id,f.return_id,f.order_id,f.issue_fragment_id,f.product_id,f.layer_id,f.warehouse_id,f.location,f.quantity,f.value_minor) IS DISTINCT FROM(eid,a.return_id,a.order_id,NEW.issue_fragment_id,NEW.product_id,NEW.layer_id,NEW.warehouse_id,NEW.location,NEW.quantity,(wanted->>'value_minor')::bigint) THEN RAISE EXCEPTION 'Klasyfikacja nie ma rzeczywistego fragmentu i kosztu' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'Nieznany trwały wiersz przyjęcia' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION return_destination_witness() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE j jsonb:=to_jsonb(NEW);a public.return_destination_admissions;match_scope boolean;BEGIN
 FOR a IN SELECT ad.* FROM public.return_destination_admissions ad WHERE(ad.tenant_id,ad.transaction_id,ad.backend_pid)=((j->>'tenant_id')::uuid,pg_current_xact_id(),pg_backend_pid()) AND ad.before_snapshot<>'{}' LOOP
  match_scope:=j->>'operation_id'=a.receipt_id::text OR(TG_TABLE_NAME='wms_operations' AND j->>'id'=a.receipt_id::text) OR(CASE WHEN TG_TABLE_NAME IN('stock_movements','wms_return_fragments','wms_operations') THEN j->>'order_id'=a.order_id::text OR j->>'return_id'=a.return_id::text ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(a.payload->'snapshot'->'lines')l CROSS JOIN LATERAL jsonb_array_elements(l->'components')c WHERE c->>'product_id'=j->>'product_id') AND(j->>'warehouse_id'=a.payload->'snapshot'->'return_case'->>'warehouse_id' OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.payload->'plan'->'stock_effects')x WHERE x->>'warehouse_id'=j->>'warehouse_id')) END);
  IF match_scope THEN
   IF a.after_snapshot IS NOT NULL OR EXISTS(SELECT 1 FROM public.return_assistant_receipts WHERE(tenant_id,id)=(a.tenant_id,a.receipt_id)) THEN RAISE EXCEPTION 'Zatwierdzone przyjęcie jest zamknięte' USING ERRCODE='23514';END IF;
   UPDATE public.return_destination_admissions SET witnesses=witnesses||jsonb_build_array(jsonb_build_object('table',TG_TABLE_NAME,'row',j)) WHERE(tenant_id,receipt_id)=(a.tenant_id,a.receipt_id);
  END IF;
 END LOOP;RETURN NEW;
END $$;

CREATE FUNCTION return_destination_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE j jsonb:=to_jsonb(NEW);t uuid:=(j->>'tenant_id')::uuid;eid uuid; a public.return_destination_admissions;r public.return_assistant_receipts;ps jsonb;actual jsonb;BEGIN
 eid:=(CASE WHEN TG_TABLE_NAME='return_assistant_receipts' THEN j->>'id' ELSE j->>'receipt_id' END)::uuid;
 IF TG_TABLE_NAME='return_assistant_receipts' AND j->'payload'->'snapshot'->>'protocol' IS DISTINCT FROM 'destinations_v1' THEN RETURN NULL;END IF;
 SELECT * INTO a FROM public.return_destination_admissions WHERE(tenant_id,receipt_id,transaction_id,backend_pid)=(t,eid,pg_current_xact_id(),pg_backend_pid());SELECT * INTO r FROM public.return_assistant_receipts WHERE(tenant_id,id)=(t,eid);
 IF a.receipt_id IS NULL OR r.id IS NULL OR a.after_snapshot IS NULL OR(r.preview_id,r.session_id,r.return_id,r.order_id,r.actor_id,r.api_key_id,r.client_key,r.request_hash,r.payload) IS DISTINCT FROM(a.preview_id,a.session_id,a.return_id,a.order_id,a.actor_id,a.api_key_id,a.client_key,a.request_hash,a.payload)
 OR a.after_snapshot IS DISTINCT FROM public.return_destination_snapshot(eid) THEN RAISE EXCEPTION 'Niekompletny świeży graf przyjęcia do celów' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(p.snapshot ORDER BY p.item_id,p.id),'[]') INTO actual FROM public.return_destination_parts p WHERE(p.tenant_id,p.receipt_id)=(t,eid);
 SELECT coalesce(jsonb_agg(x ORDER BY x->>'item_id',x->>'part_id'),'[]') INTO ps FROM jsonb_array_elements(a.payload->'plan'->'parts')x;
 IF actual IS DISTINCT FROM ps OR(SELECT count(*) FROM public.return_destination_arrivals WHERE(tenant_id,receipt_id)=(t,eid))<>jsonb_array_length(a.payload->'plan'->'arrivals') OR(SELECT count(*) FROM public.return_destination_fragments WHERE(tenant_id,receipt_id)=(t,eid))<>jsonb_array_length(a.payload->'plan'->'private_fragment_effects')
 OR EXISTS(SELECT 1 FROM public.wms_return_fragments f WHERE(f.tenant_id,f.return_id)=(t,a.return_id) AND NOT EXISTS(SELECT 1 FROM public.return_destination_fragments df WHERE(df.tenant_id,df.fragment_id,df.receipt_id)=(t,f.id,eid))) THEN RAISE EXCEPTION 'Przyjęcie wymaga pełnej bijekcji części, składników i fragmentów' USING ERRCODE='23514';END IF;
 PERFORM public.return_destination_physical_validate(eid);PERFORM public.return_destination_require(a.actor_id,a.api_key_id,true,false);PERFORM public.return_destination_budget();RETURN NULL;
END $$;

-- Independent exact arithmetic; never accept a browser's derived plan or cost.
CREATE FUNCTION return_destination_plan(s jsonb,b jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE li jsonb;pt jsonb;st jsonb;pol jsonb;cat jsonb;loc jsonb;cell jsonb;old jsonb;cas jsonb;pick jsonb;iss jsonb;ar jsonb;co record;
 accepted bigint;restocked bigint;custody bigint;rejected bigint;previous bigint;n bigint;credit numeric;prior bigint;ordered bigint;total numeric;cost numeric;
 parts jsonb:='[]';decisions jsonb:='[]';arrivals jsonb:='[]';stocks jsonb:='[]';fragments jsonb:='[]';used jsonb:='{}';key text;
BEGIN
 IF NOT public.return_destination_request_valid(b) OR jsonb_typeof(s) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Niepoprawny zakres części zwrotu' USING ERRCODE='23514';END IF;
 IF (b->>'shipping_refund')::int>(s->>'requested_shipping_refund')::int OR EXISTS(SELECT 1 FROM jsonb_array_elements(b->'parts')p WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'lines')l WHERE l->>'item_id'=p->>'item_id')) THEN RAISE EXCEPTION 'Część lub dostawa nie należy do tego RMA' USING ERRCODE='23514';END IF;
 IF (b ? 'wms_lots') AND (s->'wms'->>'enabled')::boolean IS NOT TRUE OR (b ? 'wms_lots') AND b->'wms_lots'->>'policy_version' IS DISTINCT FROM s->'wms'->>'policy_version' THEN RAISE EXCEPTION 'Wybór partii ma inną politykę' USING ERRCODE='23514';END IF;
 FOR li IN SELECT value FROM jsonb_array_elements(s->'lines') ORDER BY(value->>'ordinal')::int LOOP
  ordered:=(li->>'ordered_quantity')::bigint;prior:=(li->>'prior_accepted')::bigint;total:=(li->>'line_total_minor')::numeric;
  IF ordered<=0 OR(li->>'requested')::bigint>ordered OR prior>ordered OR(li->>'scanned_quantity')::bigint>(li->>'requested')::bigint
  OR(SELECT coalesce(sum((x->>'quantity')::bigint),0) FROM jsonb_array_elements(b->'parts')x WHERE x->>'item_id'=li->>'item_id') IS DISTINCT FROM(li->>'requested')::bigint THEN RAISE EXCEPTION 'Części nie pokrywają historycznej pozycji' USING ERRCODE='23514';END IF;
  accepted:=0;restocked:=0;custody:=0;rejected:=0;
  FOR pt IN SELECT value FROM jsonb_array_elements(b->'parts') WHERE value->>'item_id'=li->>'item_id' ORDER BY(value->>'part_id') COLLATE "C" LOOP
   st:=NULL;SELECT value INTO st FROM jsonb_array_elements(s->'statuses') WHERE value->>'status_id'=pt->>'status_id';
   IF st IS NULL OR st->'active' IS DISTINCT FROM 'true'::jsonb OR st->>'version' IS DISTINCT FROM pt->>'status_version' THEN RAISE EXCEPTION 'Status części zmienił się' USING ERRCODE='23514';END IF;
   n:=(pt->>'quantity')::bigint;previous:=accepted;credit:=0;
   IF st->>'decision'='reject' THEN
    IF st->>'inventory_effect' IS DISTINCT FROM 'none' OR st->'warehouse_id' IS DISTINCT FROM 'null'::jsonb OR st->'warehouse_policy_version' IS DISTINCT FROM 'null'::jsonb OR st->'default_location' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Odrzucenie nie przyjmuje zapasu' USING ERRCODE='23514';END IF;
    rejected:=rejected+n;
   ELSIF st->>'decision'='accept' THEN
    pol:=NULL;SELECT value INTO pol FROM jsonb_array_elements(s->'warehouse_policies') WHERE value->>'warehouse_id'=st->>'warehouse_id';
    IF st->>'inventory_effect' NOT IN('sale','custody') OR pol IS NULL OR pol->'enabled' IS DISTINCT FROM 'true'::jsonb OR pol->>'version' IS DISTINCT FROM st->>'warehouse_policy_version' OR pol->>'usage' IS DISTINCT FROM st->>'inventory_effect' THEN RAISE EXCEPTION 'Magazyn części zmienił przeznaczenie' USING ERRCODE='23514';END IF;
    accepted:=accepted+n;IF st->>'inventory_effect'='sale' THEN restocked:=restocked+n;ELSE custody:=custody+n;END IF;
    IF accepted>(li->>'scanned_quantity')::bigint OR accepted+prior>ordered THEN RAISE EXCEPTION 'Przyjęcie przekracza skan lub historyczną ilość' USING ERRCODE='23514';END IF;
    credit:=floor(total*(prior+accepted)/ordered)-floor(total*(prior+previous)/ordered);
    FOR co IN SELECT x->>'product_id' product_id,sum((x->>'quantity')::bigint) quantity FROM jsonb_array_elements(li->'components')x GROUP BY x->>'product_id' ORDER BY(x->>'product_id') COLLATE "C" LOOP
     loc:=NULL;cat:=NULL;SELECT value INTO loc FROM jsonb_array_elements(b->'locations') WHERE(value->>'part_id',value->>'product_id')=(pt->>'part_id',co.product_id);
     SELECT value INTO cat FROM jsonb_array_elements(s->'catalog_assignments') WHERE value->>'product_id'=co.product_id;
     IF loc IS NULL OR cat IS NULL OR NOT(cat->'warehouse_ids' @> jsonb_build_array(st->>'warehouse_id')) OR n*co.quantity>10000000 THEN RAISE EXCEPTION 'Niepoprawne przypisanie lub lokalizacja składnika' USING ERRCODE='23514';END IF;
     arrivals:=arrivals||jsonb_build_array(jsonb_build_object('part_id',pt->>'part_id','item_id',pt->>'item_id','product_id',co.product_id,'warehouse_id',st->>'warehouse_id','location',loc->>'location','quantity',n*co.quantity,'effect',st->>'inventory_effect'));
    END LOOP;
   ELSE RAISE EXCEPTION 'Niepoprawna decyzja statusu' USING ERRCODE='23514';END IF;
   parts:=parts||jsonb_build_array(pt||jsonb_build_object('status',st,'refund_minor',credit,'components',li->'components'));
  END LOOP;
  decisions:=decisions||jsonb_build_array(jsonb_build_object('item_id',li->>'item_id','accepted',accepted,'restocked',restocked,'custody',custody,'rejected',rejected,'refund_minor',floor(total*(prior+accepted)/ordered)-floor(total*prior/ordered)));
 END LOOP;
 IF jsonb_array_length(arrivals)>500 OR jsonb_array_length(b->'locations')<>jsonb_array_length(arrivals) OR EXISTS(SELECT 1 FROM jsonb_array_elements(b->'locations')x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(arrivals)a WHERE(a->>'part_id',a->>'product_id')=(x->>'part_id',x->>'product_id'))) THEN RAISE EXCEPTION 'Lokalizacje mają inny zakres przyjęcia' USING ERRCODE='23514';END IF;
 FOR cell IN SELECT jsonb_build_object('warehouse_id',a->>'warehouse_id','product_id',a->>'product_id','quantity',sum((a->>'quantity')::bigint),'effect',min(a->>'effect')) FROM jsonb_array_elements(arrivals)a GROUP BY a->>'warehouse_id',a->>'product_id' ORDER BY(a->>'warehouse_id') COLLATE "C",(a->>'product_id') COLLATE "C" LOOP
  old:=NULL;cas:=NULL;SELECT value INTO old FROM jsonb_array_elements(s->'stocks') WHERE(value->>'warehouse_id',value->>'product_id')=(cell->>'warehouse_id',cell->>'product_id');
  SELECT value INTO cas FROM jsonb_array_elements(b->'stock_versions') WHERE(value->>'warehouse_id',value->>'product_id')=(cell->>'warehouse_id',cell->>'product_id');
  IF old IS NULL OR cas IS NULL OR cas->>'version' IS DISTINCT FROM old->>'version' OR(old->>'reserved')::bigint>(old->>'on_hand')::bigint OR(cell->>'effect'='custody' AND(old->>'reserved')::bigint<>0)
  OR(old->'exists'='false'::jsonb AND(old->>'version',old->>'on_hand',old->>'reserved') IS DISTINCT FROM('0','0','0')) THEN RAISE EXCEPTION 'Zapas zmienił zakres lub wersję' USING ERRCODE='23514';END IF;
  n:=(old->>'on_hand')::bigint+(cell->>'quantity')::bigint;IF n>2147483647 THEN RAISE EXCEPTION 'Ilość zapasu przekracza limit' USING ERRCODE='23514';END IF;
  stocks:=stocks||jsonb_build_array(cell||jsonb_build_object('before',jsonb_build_object('exists',old->'exists','version',old->'version','on_hand',old->'on_hand','reserved',old->'reserved','physical_available',(old->>'on_hand')::bigint-(old->>'reserved')::bigint,'sellable_available',CASE WHEN cell->>'effect'='sale' THEN(old->>'on_hand')::bigint-(old->>'reserved')::bigint ELSE 0 END),'after',jsonb_build_object('on_hand',n,'reserved',old->'reserved','physical_available',n-(old->>'reserved')::bigint,'sellable_available',CASE WHEN cell->>'effect'='sale' THEN n-(old->>'reserved')::bigint ELSE 0 END)));
 END LOOP;
 IF jsonb_array_length(stocks)<>jsonb_array_length(s->'stocks') OR jsonb_array_length(stocks)<>jsonb_array_length(b->'stock_versions') THEN RAISE EXCEPTION 'Wymagana dokładna unia zapasu' USING ERRCODE='23514';END IF;
 FOR pick IN SELECT value FROM jsonb_array_elements(coalesce(b->'wms_lots'->'picks','[]')) ORDER BY(value->>'part_id') COLLATE "C",(value->>'issue_fragment_id') COLLATE "C",(value->>'location') COLLATE "C" LOOP
  iss:=NULL;ar:=NULL;pt:=NULL;SELECT value INTO iss FROM jsonb_array_elements(s->'wms'->'issue_fragments') WHERE value->>'id'=pick->>'issue_fragment_id';SELECT value INTO pt FROM jsonb_array_elements(b->'parts') WHERE value->>'part_id'=pick->>'part_id';
  SELECT value INTO ar FROM jsonb_array_elements(arrivals) WHERE(value->>'part_id',value->>'product_id',value->>'location')=(pick->>'part_id',iss->>'product_id',pick->>'location');
  IF iss IS NULL OR pt IS NULL OR ar IS NULL OR iss->>'order_id' IS DISTINCT FROM s->>'order_id' OR iss->>'currency' IS DISTINCT FROM s->>'currency' OR NOT(iss->'eligible_item_ids' @> jsonb_build_array(pt->>'item_id')) THEN RAISE EXCEPTION 'Fragment nie ma dokładnego pochodzenia części' USING ERRCODE='23514';END IF;
  key:=iss->>'id';n:=coalesce((used->>key)::bigint,0)+(pick->>'quantity')::bigint;
  IF n>(iss->>'quantity')::bigint-(iss->>'returned_quantity')::bigint THEN RAISE EXCEPTION 'Wspólna pojemność fragmentu wydania przekroczona' USING ERRCODE='23514';END IF;
  used:=jsonb_set(used,ARRAY[key],to_jsonb(n));cost:=CASE WHEN iss->'unit_cost_minor'='null'::jsonb THEN NULL ELSE(iss->>'unit_cost_minor')::numeric*(pick->>'quantity')::bigint END;
  IF cost>9223372036854775807 THEN RAISE EXCEPTION 'Wartość warstwy przekracza zakres' USING ERRCODE='23514';END IF;
  fragments:=fragments||jsonb_build_array(ar||jsonb_build_object('issue_fragment_id',iss->'id','layer_id',iss->'layer_id','quantity',pick->'quantity','unit_cost_minor',iss->'unit_cost_minor','value_minor',CASE WHEN cost IS NULL THEN NULL ELSE cost::text END,'unknown_quantity',CASE WHEN cost IS NULL THEN(pick->>'quantity')::int ELSE 0 END,'currency',iss->'currency'));
 END LOOP;
 IF(s->'wms'->>'enabled')::boolean THEN
  IF NOT(b ? 'wms_lots') AND jsonb_array_length(arrivals)>0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(arrivals)a WHERE(a->>'quantity')::bigint IS DISTINCT FROM(SELECT coalesce(sum((x->>'quantity')::bigint),0) FROM jsonb_array_elements(fragments)x WHERE(x->>'part_id',x->>'product_id')=(a->>'part_id',a->>'product_id'))) THEN RAISE EXCEPTION 'Fragmenty nie pokrywają przyjęcia SALE i CUSTODY' USING ERRCODE='23514';END IF;
 ELSIF jsonb_array_length(fragments)>0 THEN RAISE EXCEPTION 'Wyłączony WMS nie tworzy fragmentów' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum((x->>'refund_minor')::numeric),0)+(b->>'shipping_refund')::int INTO credit FROM jsonb_array_elements(decisions)x;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(decisions)x WHERE(x->>'accepted')::bigint>0) AND(b->>'shipping_refund')::int<>0 THEN RAISE EXCEPTION 'Odrzucenie nie zwraca kosztu dostawy' USING ERRCODE='23514';END IF;
 IF credit>9007199254740991 THEN RAISE EXCEPTION 'Kredyt przekracza dokładny zakres' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('protocol','destinations_v1','order_id',s->'order_id','return_id',s->'return_id','currency',s->'currency','parts',parts,'decisions',decisions,'arrivals',arrivals,'stock_effects',stocks,'private_fragment_effects',fragments,'summary',jsonb_build_object('accepted',(SELECT sum((x->>'accepted')::bigint) FROM jsonb_array_elements(decisions)x),'restocked_to_sale',(SELECT sum((x->>'restocked')::bigint) FROM jsonb_array_elements(decisions)x),'received_into_custody',(SELECT sum((x->>'custody')::bigint) FROM jsonb_array_elements(decisions)x),'rejected',(SELECT sum((x->>'rejected')::bigint) FROM jsonb_array_elements(decisions)x),'commercial_credit_minor',credit,'shipping_refund_minor',b->'shipping_refund'));
END $$;

-- Register only after every referenced trigger function exists.
DO $$DECLARE nm text;BEGIN
 FOREACH nm IN ARRAY ARRAY['return_destination_parts','return_destination_arrivals','return_destination_fragments','return_destination_admissions'] LOOP
  EXECUTE format('CREATE TRIGGER return_destination_record_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.return_destination_record_guard()',nm);
  EXECUTE format('CREATE CONSTRAINT TRIGGER return_destination_complete AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.return_destination_complete()',nm);
 END LOOP;
 FOREACH nm IN ARRAY ARRAY['stock_movements','stock_location_movements','wms_return_fragments','wms_layer_movements','wms_operations'] LOOP EXECUTE format('CREATE TRIGGER return_destination_witness AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.return_destination_witness()',nm);END LOOP;
 FOREACH nm IN ARRAY ARRAY['return_cases','return_items','return_assistant_sessions','return_assistant_photos','orders','order_items','payment_entries','documents','packing_stations','wms_policies','stock_movements','wms_return_fragments','stock','stock_locations','stock_location_movements','wms_layer_positions','wms_layer_movements','wms_cost_layers','wms_lots','wms_issue_fragments','wms_operations','reservations','reservation_locations','wms_reservation_layers','shipments','order_parcel_dispatches','order_parcel_releases','order_parcel_return_claims','order_parcel_commercial_origins','order_parcel_origin_fragments','return_destination_statuses','return_destination_status_revisions','warehouse_inventory_policies','warehouses','products','product_catalog_warehouses'] LOOP EXECUTE format('CREATE TRIGGER return_destination_seal BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.return_destination_seal()',nm);END LOOP;
END $$;
CREATE CONSTRAINT TRIGGER return_destination_parent_complete AFTER INSERT ON public.return_assistant_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.return_destination_complete();

CREATE FUNCTION return_destination_guards() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rel text;nm text;fn record;fk record;cols text[];r record;
BEGIN
 IF NOT public.return_destination_installed() OR NOT public.return_assistant_guards() OR NOT public.warehouse_inventory_policy_guards() OR NOT public.return_destination_status_guards()
 OR NOT EXISTS(SELECT 1 FROM public.migrations WHERE name='147_return_destination_statuses')
 OR NOT public.order_parcel_return_installed() OR to_regprocedure('public.b2b_return_local_snapshot(uuid)') IS NULL THEN RETURN false;END IF;
 FOREACH rel IN ARRAY ARRAY['return_destination_parts','return_destination_arrivals','return_destination_fragments','return_destination_admissions'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.'||rel) AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)=session_user)
  OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a WHERE c.oid=to_regclass('public.'||rel) AND a.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid CROSS JOIN LATERAL aclexplode(a.attacl)x WHERE c.oid=to_regclass('public.'||rel) AND x.grantee<>c.relowner)
  OR(SELECT count(*) FROM pg_policy WHERE polrelid=to_regclass('public.'||rel))<>1
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass('public.'||rel) AND p.polname='tenant_scope' AND p.polcmd='*' AND p.polpermissive AND p.polroles=ARRAY[0::oid]
   AND lower(regexp_replace(pg_get_expr(p.polqual,p.polrelid),'[[:space:]()]','','g'))='tenant_id=nullifcurrent_setting''app.tenant_id''::text,true,''''::text::uuid'
   AND pg_get_expr(p.polqual,p.polrelid)=pg_get_expr(p.polwithcheck,p.polrelid))
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.'||rel) AND tgname='return_destination_record_guard' AND tgfoid=to_regprocedure('public.return_destination_record_guard()') AND tgtype=31 AND tgenabled='O' AND NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.'||rel) AND tgname='return_destination_complete' AND tgfoid=to_regprocedure('public.return_destination_complete()') AND tgtype=5 AND tgenabled='O' AND tgdeferrable AND tginitdeferred AND NOT tgisinternal) THEN RETURN false;END IF;
  cols:=CASE rel
   WHEN 'return_destination_parts' THEN ARRAY['tenant_id','id','receipt_id','preview_id','session_id','return_id','order_id','item_id','quantity','status_id','status_version','status_revision_id','decision','effect','refund_minor','snapshot']
   WHEN 'return_destination_arrivals' THEN ARRAY['tenant_id','id','receipt_id','part_id','return_id','order_id','item_id','product_id','warehouse_id','location','quantity','effect']
   WHEN 'return_destination_fragments' THEN ARRAY['tenant_id','receipt_id','arrival_id','part_id','return_id','order_id','item_id','product_id','warehouse_id','location','fragment_id','issue_fragment_id','layer_id','quantity','effect']
   ELSE ARRAY['tenant_id','receipt_id','preview_id','session_id','return_id','order_id','actor_id','transaction_id','backend_pid','client_key','request_hash','request','payload','before_snapshot','witnesses','opened_at'] END;
  IF EXISTS(SELECT 1 FROM unnest(cols)x WHERE NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.'||rel) AND attname=x AND attnotnull AND NOT attisdropped)) THEN RETURN false;END IF;
  IF rel='return_destination_parts' AND EXISTS(SELECT 1 FROM unnest(ARRAY['warehouse_id','warehouse_policy_version'])x WHERE NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.'||rel) AND attname=x AND NOT attnotnull AND NOT attisdropped))
  OR rel='return_destination_admissions' AND EXISTS(SELECT 1 FROM unnest(ARRAY['api_key_id','after_snapshot'])x WHERE NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.'||rel) AND attname=x AND NOT attnotnull AND NOT attisdropped)) THEN RETURN false;END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.'||rel) AND a.attnum>0 AND NOT a.attisdropped
   AND a.atttypid IS DISTINCT FROM(CASE WHEN a.attname IN('quantity','backend_pid') THEN 'integer'::regtype WHEN a.attname IN('status_version','warehouse_policy_version','refund_minor') THEN 'bigint'::regtype
    WHEN a.attname='transaction_id' THEN 'xid8'::regtype WHEN a.attname='opened_at' THEN 'timestamptz'::regtype
    WHEN a.attname IN('request','payload','before_snapshot','after_snapshot','witnesses','snapshot') THEN 'jsonb'::regtype
    WHEN a.attname IN('request_hash','decision','effect','location') THEN 'text'::regtype ELSE 'uuid'::regtype END)) THEN RETURN false;END IF;
  IF(SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('public.'||rel) AND contype IN('p','u') AND convalidated)<>(CASE rel WHEN 'return_destination_parts' THEN 2 WHEN 'return_destination_arrivals' THEN 3 WHEN 'return_destination_fragments' THEN 2 ELSE 3 END)
  OR(SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('public.'||rel) AND contype='c' AND convalidated)<>(CASE rel WHEN 'return_destination_parts' THEN 7 WHEN 'return_destination_arrivals' THEN 3 ELSE 2 END) THEN RETURN false;END IF;
 END LOOP;
 IF(SELECT count(*) FROM pg_constraint WHERE conrelid IN(to_regclass('public.return_destination_parts'),to_regclass('public.return_destination_arrivals'),to_regclass('public.return_destination_fragments'),to_regclass('public.return_destination_admissions')) AND contype='f' AND convalidated)<>18 THEN RETURN false;END IF;
 FOR fk IN SELECT * FROM(VALUES
  ('return_destination_parts','tenant_id','tenants','id',false),
  ('return_destination_parts','tenant_id,receipt_id','return_assistant_receipts','tenant_id,id',true),
  ('return_destination_parts','tenant_id,preview_id,session_id,return_id','return_assistant_previews','tenant_id,id,session_id,return_id',false),
  ('return_destination_parts','tenant_id,return_id,item_id','return_items','tenant_id,return_id,item_id',false),
  ('return_destination_parts','tenant_id,order_id,item_id','order_items','tenant_id,order_id,id',false),
  ('return_destination_parts','tenant_id,status_id,status_version,status_revision_id','return_destination_status_revisions','tenant_id,status_id,version,id',false),
  ('return_destination_parts','tenant_id,warehouse_id','warehouses','tenant_id,id',false),
  ('return_destination_arrivals','tenant_id,receipt_id,part_id,return_id,order_id,item_id','return_destination_parts','tenant_id,receipt_id,id,return_id,order_id,item_id',false),
  ('return_destination_arrivals','tenant_id,product_id','products','tenant_id,id',false),
  ('return_destination_arrivals','tenant_id,warehouse_id','warehouses','tenant_id,id',false),
  ('return_destination_fragments','tenant_id,arrival_id,receipt_id,part_id,return_id,order_id,item_id,product_id,warehouse_id,location','return_destination_arrivals','tenant_id,id,receipt_id,part_id,return_id,order_id,item_id,product_id,warehouse_id,location',false),
  ('return_destination_fragments','tenant_id,fragment_id','wms_return_fragments','tenant_id,id',false),
  ('return_destination_fragments','tenant_id,issue_fragment_id,order_id,product_id,layer_id','wms_issue_fragments','tenant_id,id,order_id,product_id,layer_id',false),
  ('return_destination_admissions','actor_id','users','id',false),
  ('return_destination_admissions','tenant_id,receipt_id','return_assistant_receipts','tenant_id,id',true),
  ('return_destination_admissions','tenant_id,preview_id,session_id,return_id','return_assistant_previews','tenant_id,id,session_id,return_id',false),
  ('return_destination_admissions','tenant_id,order_id,return_id','return_cases','tenant_id,order_id,id',false),
  ('return_destination_admissions','tenant_id,api_key_id','api_keys','tenant_id,id',false)
 )v(source_table,source_columns,target_table,target_columns,deferred) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.contype='f' AND c.conrelid=to_regclass('public.'||fk.source_table) AND c.confrelid=to_regclass('public.'||fk.target_table) AND c.convalidated AND c.condeferrable=fk.deferred AND c.condeferred=fk.deferred
   AND(SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(num,ordinality) JOIN pg_attribute a ON(a.attrelid,a.attnum)=(c.conrelid,k.num))=fk.source_columns
   AND(SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.confkey) WITH ORDINALITY k(num,ordinality) JOIN pg_attribute a ON(a.attrelid,a.attnum)=(c.confrelid,k.num))=fk.target_columns) THEN RETURN false;END IF;
 END LOOP;
 FOREACH nm IN ARRAY ARRAY['identity(uuid,text)','installed()','number(jsonb,boolean)','request_valid(jsonb)','physical_validate(uuid)','require(uuid,uuid,boolean,boolean)','source(uuid,uuid,uuid,uuid)','frame(uuid,jsonb,uuid,uuid)','lock(uuid,uuid,jsonb,uuid,uuid)','extra_budget(bigint,uuid)','budget()','seal()','snapshot(uuid)','resources(uuid,jsonb,uuid,uuid)','preview(uuid,uuid,jsonb,uuid,uuid)','prepare(uuid,uuid,jsonb,uuid,uuid)','admission_scope(uuid,uuid,uuid,uuid)','certificate(uuid)','parcel_payload(uuid,jsonb)','legacy_scope(uuid,uuid,uuid,jsonb)','validate_parcel(uuid,uuid,uuid,jsonb,jsonb)','finish(uuid,uuid,uuid)','record_guard()','witness()','complete()','plan(jsonb,jsonb)','guards()'] LOOP
  SELECT p.* INTO fn FROM pg_proc p WHERE p.oid=to_regprocedure('public.return_destination_'||nm);
  IF fn.oid IS NULL OR pg_get_userbyid(fn.proowner)<>session_user OR(nm NOT IN('identity(uuid,text)','number(jsonb,boolean)','request_valid(jsonb)','plan(jsonb,jsonb)') AND NOT fn.prosecdef)
  OR NOT('search_path=pg_catalog, public'=ANY(coalesce(fn.proconfig,ARRAY[]::text[])))
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(fn.proacl,acldefault('f',fn.proowner)))a WHERE a.grantee<>fn.proowner) THEN RETURN false;END IF;
 END LOOP;
 FOREACH rel IN ARRAY ARRAY['stock_movements','stock_location_movements','wms_return_fragments','wms_layer_movements','wms_operations'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.'||rel) AND tgname='return_destination_witness' AND tgfoid=to_regprocedure('public.return_destination_witness()') AND tgtype=5 AND tgenabled='O' AND NOT tgisinternal) THEN RETURN false;END IF;
 END LOOP;
 FOREACH rel IN ARRAY ARRAY['return_cases','return_items','return_assistant_sessions','return_assistant_photos','orders','order_items','payment_entries','documents','packing_stations','wms_policies','stock_movements','wms_return_fragments','stock','stock_locations','stock_location_movements','wms_layer_positions','wms_layer_movements','wms_cost_layers','wms_lots','wms_issue_fragments','wms_operations','reservations','reservation_locations','wms_reservation_layers','shipments','order_parcel_dispatches','order_parcel_releases','order_parcel_return_claims','order_parcel_commercial_origins','order_parcel_origin_fragments','return_destination_statuses','return_destination_status_revisions','warehouse_inventory_policies','warehouses','products','product_catalog_warehouses'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.'||rel) AND tgname='return_destination_seal' AND tgfoid=to_regprocedure('public.return_destination_seal()') AND tgtype=31 AND tgenabled='O' AND NOT tgisinternal) THEN RETURN false;END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.return_assistant_receipts') AND tgname='return_destination_parent_complete' AND tgfoid=to_regprocedure('public.return_destination_complete()') AND tgtype=5 AND tgenabled='O' AND tgdeferrable AND tginitdeferred AND NOT tgisinternal) THEN RETURN false;END IF;
 FOREACH nm IN ARRAY ARRAY['return_assistant_budget()','return_assistant_prepare(uuid,uuid,jsonb,uuid,uuid)','return_assistant_physical_validate(return_assistant_admissions)','return_assistant_complete()','return_assistant_finish(uuid,uuid,uuid)','wms_fragment_consistency()','wms_validate_operation_scope(uuid,uuid)','b2b_return_local_finish(uuid)','order_parcel_return_validate_receive(uuid,uuid,uuid,jsonb,jsonb)','order_parcel_return_validate_physical(order_parcel_return_admissions)'] LOOP
  SELECT p.* INTO fn FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||nm);
  IF fn.oid IS NULL OR strpos(fn.prosrc,'destinations_v1')=0 THEN RETURN false;END IF;
 END LOOP;
 FOREACH nm IN ARRAY ARRAY['wms_fragment_consistency()','wms_validate_operation_scope(uuid,uuid)'] LOOP
 SELECT p.* INTO fn FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||nm);
 IF NOT fn.prosecdef OR pg_get_userbyid(fn.proowner)<>session_user OR NOT('search_path=pg_catalog, public, pg_temp'=ANY(coalesce(fn.proconfig,ARRAY[]::text[])))
 OR fn.prosrc~*'\m(?:FROM|JOIN)[[:space:]]+(?:wms_issue_fragments|wms_return_fragments|wms_operations|wms_layer_movements|return_cases|return_items|wms_cost_layers|wms_lots)\M' THEN RETURN false;END IF;
 END LOOP;
 -- Active scheduling is093; it replaced all three historical090 triggers.
 FOREACH nm IN ARRAY ARRAY['wms_validate_operation_scope(uuid,uuid)','wms_validate_quantity_scope(uuid,uuid,uuid,boolean)','wms_enqueue_validation_scopes()','wms_flush_validation_scope()'] LOOP
  SELECT p.* INTO fn FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||nm);
  IF fn.oid IS NULL OR NOT fn.prosecdef OR pg_get_userbyid(fn.proowner)<>session_user OR NOT('search_path=pg_catalog, public, pg_temp'=ANY(coalesce(fn.proconfig,ARRAY[]::text[])))
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(fn.proacl,acldefault('f',fn.proowner)))a WHERE a.grantee<>fn.proowner) THEN RETURN false;END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.wms_validation_scopes') AND c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)=session_user)
 OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a WHERE c.oid=to_regclass('public.wms_validation_scopes') AND a.grantee<>c.relowner)
 OR EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid CROSS JOIN LATERAL aclexplode(a.attacl)x WHERE c.oid=to_regclass('public.wms_validation_scopes') AND x.grantee<>c.relowner)
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.wms_validation_scopes') AND tgname='wms_validation_flush' AND tgfoid=to_regprocedure('public.wms_flush_validation_scope()') AND tgtype=5 AND tgenabled='O' AND tgdeferrable AND tginitdeferred AND NOT tgisinternal) THEN RETURN false;END IF;
 FOREACH rel IN ARRAY ARRAY['stock','stock_locations','reservations','reservation_locations','wms_layer_positions','wms_reservation_layers','wms_layer_movements','wms_issue_fragments','wms_return_fragments'] LOOP
  FOR r IN SELECT * FROM(VALUES('wms_scope_insert',4::int,NULL::text,'wms_new_rows'::text),('wms_scope_update',16::int,'wms_old_rows'::text,'wms_new_rows'::text),('wms_scope_delete',8::int,'wms_old_rows'::text,NULL::text))v(name,event,old_rows,new_rows) LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_trigger tr WHERE tr.tgrelid=to_regclass('public.'||rel) AND tr.tgname=r.name AND tr.tgfoid=to_regprocedure('public.wms_enqueue_validation_scopes()') AND tr.tgtype=r.event AND tr.tgenabled='O' AND NOT tr.tgisinternal AND tr.tgoldtable IS NOT DISTINCT FROM r.old_rows AND tr.tgnewtable IS NOT DISTINCT FROM r.new_rows) THEN RETURN false;END IF;
  END LOOP;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.wms_policies') AND tgname='wms_scope_policy_insert' AND tgfoid=to_regprocedure('public.wms_enqueue_validation_scopes()') AND tgtype=4 AND tgenabled='O' AND tgnewtable='wms_new_rows' AND tgoldtable IS NULL AND NOT tgisinternal)
 OR strpos((SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.wms_flush_validation_scope()')),'public.wms_validate_operation_scope(pending.tenant_id,pending.operation_id)')=0
 OR strpos((SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.wms_enqueue_validation_scopes()')),'public.wms_validation_scopes')=0 THEN RETURN false;END IF;
 RETURN true;
END $$;

-- Last statement after ALL helper definitions: no new raw EXECUTE authority.
DO $$DECLARE f regprocedure;BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'return_destination_%' AND p.proname NOT LIKE 'return_destination_status_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f);
 END LOOP;
END $$;
