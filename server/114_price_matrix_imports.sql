-- Additive matrix receipts. Existing 087 and 113 evidence/hashes are not rewritten.
CREATE TABLE price_matrix_import_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),
 file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 120),source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),source text NOT NULL CHECK(source IN('manual','api')),
 targets jsonb NOT NULL CHECK(jsonb_typeof(targets)='array' AND jsonb_array_length(targets)>=2 AND jsonb_array_length(targets)<=8),warnings jsonb NOT NULL CHECK(jsonb_typeof(warnings)='array'),summary jsonb NOT NULL CHECK(jsonb_typeof(summary)='object'),rows jsonb NOT NULL CHECK(jsonb_typeof(rows)='array' AND jsonb_array_length(rows)>=1 AND jsonb_array_length(rows)<=500),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key)
);
CREATE TABLE price_matrix_import_targets (
 tenant_id uuid NOT NULL,preview_id uuid NOT NULL,price_list_id uuid NOT NULL,core_preview_id uuid,core_client_key uuid NOT NULL,
 PRIMARY KEY(tenant_id,preview_id,price_list_id),UNIQUE(tenant_id,core_preview_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES price_matrix_import_previews(tenant_id,id),FOREIGN KEY(tenant_id,price_list_id) REFERENCES price_lists(tenant_id,id),FOREIGN KEY(tenant_id,core_preview_id) REFERENCES price_bulk_edit_previews(tenant_id,id)
);
CREATE TABLE price_matrix_import_executions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),core_execution_ids jsonb NOT NULL CHECK(jsonb_typeof(core_execution_ids)='array'),ack_missing_price_list_ids jsonb NOT NULL CHECK(jsonb_typeof(ack_missing_price_list_ids)='array'),
 top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,id,preview_id),FOREIGN KEY(tenant_id,preview_id) REFERENCES price_matrix_import_previews(tenant_id,id)
);
CREATE TABLE price_matrix_import_execution_targets (
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,preview_id uuid NOT NULL,price_list_id uuid NOT NULL,core_execution_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,execution_id,price_list_id),UNIQUE(tenant_id,core_execution_id),FOREIGN KEY(tenant_id,execution_id,preview_id) REFERENCES price_matrix_import_executions(tenant_id,id,preview_id),FOREIGN KEY(tenant_id,preview_id,price_list_id) REFERENCES price_matrix_import_targets(tenant_id,preview_id,price_list_id),FOREIGN KEY(tenant_id,core_execution_id) REFERENCES price_bulk_edit_executions(tenant_id,id)
);
CREATE TABLE price_matrix_import_profiles (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),version integer NOT NULL CHECK(version>0),targets jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id)
);
CREATE TABLE price_matrix_import_profile_revisions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,profile_id uuid NOT NULL,version integer NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,profile_id,version),FOREIGN KEY(tenant_id,profile_id) REFERENCES price_matrix_import_profiles(tenant_id,id)
);
CREATE TABLE price_matrix_import_core_witnesses (
 tenant_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('preview','execution')),id uuid NOT NULL,top_xid xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,PRIMARY KEY(tenant_id,kind,id)
);
CREATE TABLE price_matrix_import_execution_admissions (
 tenant_id uuid NOT NULL,preview_id uuid NOT NULL,actor_id uuid NOT NULL,api_key_id uuid,top_xid xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,preview_id,top_xid,transaction_started_at),FOREIGN KEY(tenant_id,preview_id) REFERENCES price_matrix_import_previews(tenant_id,id)
);
CREATE INDEX price_matrix_import_preview_history ON price_matrix_import_previews(tenant_id,created_at DESC,id DESC);
CREATE INDEX price_matrix_import_execution_history ON price_matrix_import_executions(tenant_id,created_at DESC,id DESC);
CREATE INDEX price_matrix_import_target_list ON price_matrix_import_targets(tenant_id,price_list_id);
CREATE INDEX price_matrix_import_execution_preview ON price_matrix_import_execution_targets(tenant_id,preview_id,price_list_id);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['price_matrix_import_previews','price_matrix_import_targets','price_matrix_import_executions','price_matrix_import_execution_targets','price_matrix_import_profiles','price_matrix_import_profile_revisions','price_matrix_import_core_witnesses','price_matrix_import_execution_admissions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 IF t NOT IN('price_matrix_import_core_witnesses','price_matrix_import_execution_admissions') THEN EXECUTE format('GRANT SELECT ON %I TO dyna_app',t);END IF;
END LOOP;END $$;
CREATE FUNCTION price_matrix_import_access(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT price_file_import_access(uid,kid,writing,pin) $$;
CREATE FUNCTION price_matrix_import_require(uid uuid,kid uuid,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF (price_matrix_import_access(uid,kid,true,pin)->>'key_valid')::boolean IS FALSE THEN RAISE EXCEPTION 'Wycofany klucz importu macierzy cen' USING ERRCODE='23514';END IF;
 IF (price_matrix_import_access(uid,kid,true,pin)->>'allowed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'Brak aktualnej zgody na import macierzy cen' USING ERRCODE='23514';END IF;END $$;
CREATE FUNCTION price_matrix_import_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT EXISTS(SELECT 1 FROM migrations WHERE name='114_price_matrix_imports') $$;
CREATE FUNCTION price_matrix_import_targets(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE target jsonb;first_d jsonb;last_id uuid;id uuid;BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v)<2 OR jsonb_array_length(v)>8 THEN RETURN false;END IF;
 FOR target IN SELECT x.element FROM jsonb_array_elements(v)x(element) LOOP
  IF jsonb_typeof(target) IS DISTINCT FROM 'object' OR NOT price_file_import_definition(target->'definition') OR target->>'price_list_id' IS NULL THEN RETURN false;END IF;
  id:=(target->>'price_list_id')::uuid;IF last_id IS NOT NULL AND id<=last_id THEN RETURN false;END IF;last_id:=id;
  IF first_d IS NULL THEN first_d:=target->'definition';
  ELSIF ROW(target->'definition'->>'format',target->'definition'->>'delimiter',target->'definition'->>'identity',target->'definition'->'mapping'->>'identity',target->'definition'->'spreadsheet_safe') IS DISTINCT FROM ROW(first_d->>'format',first_d->>'delimiter',first_d->>'identity',first_d->'mapping'->>'identity',first_d->'spreadsheet_safe') THEN RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
CREATE FUNCTION price_matrix_import_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'Historia importu macierzy cen jest niezmienna' USING ERRCODE='23514';END $$;
CREATE FUNCTION price_matrix_import_core_witness() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF to_regclass('public.price_matrix_import_core_witnesses') IS NULL THEN RETURN NEW;END IF;
 IF TG_WHEN='AFTER' AND TG_ARGV[0]='cleanup' THEN
  DELETE FROM price_matrix_import_core_witnesses WHERE (tenant_id,kind,id)=(NEW.tenant_id,CASE WHEN TG_TABLE_NAME='price_bulk_edit_previews' THEN 'preview' ELSE 'execution' END,NEW.id);RETURN NEW;
 END IF;
 INSERT INTO price_matrix_import_core_witnesses VALUES(NEW.tenant_id,CASE WHEN TG_TABLE_NAME='price_bulk_edit_previews' THEN 'preview' ELSE 'execution' END,NEW.id,pg_current_xact_id(),transaction_timestamp());RETURN NEW;
END $$;
CREATE TRIGGER price_matrix_witness AFTER INSERT ON price_bulk_edit_previews FOR EACH ROW EXECUTE FUNCTION price_matrix_import_core_witness();
CREATE TRIGGER price_matrix_witness AFTER INSERT ON price_bulk_edit_executions FOR EACH ROW EXECUTE FUNCTION price_matrix_import_core_witness();
CREATE CONSTRAINT TRIGGER price_matrix_witness_cleanup AFTER INSERT ON price_bulk_edit_previews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION price_matrix_import_core_witness('cleanup');
CREATE CONSTRAINT TRIGGER price_matrix_witness_cleanup AFTER INSERT ON price_bulk_edit_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION price_matrix_import_core_witness('cleanup');
CREATE FUNCTION price_matrix_import_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n bigint;b bigint;t uuid:=NEW.tenant_id;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('price.matrix:'||t,0));
 SELECT count(*),coalesce(sum(octet_length(to_jsonb(p)::text)),0) INTO n,b FROM price_matrix_import_previews p WHERE tenant_id=t;
 IF n>2000 THEN RAISE EXCEPTION 'Limit historii importu macierzy cen' USING ERRCODE='P0001';END IF;
 SELECT b+coalesce(sum(octet_length(to_jsonb(e)::text)),0) INTO b FROM price_matrix_import_executions e WHERE tenant_id=t;
 SELECT b+coalesce(sum(octet_length(to_jsonb(r)::text)),0) INTO b FROM price_matrix_import_profile_revisions r WHERE tenant_id=t;
 SELECT b+coalesce(sum(octet_length(to_jsonb(r)::text)),0) INTO b FROM price_matrix_import_targets r WHERE tenant_id=t;
 SELECT b+coalesce(sum(octet_length(to_jsonb(r)::text)),0) INTO b FROM price_matrix_import_execution_targets r WHERE tenant_id=t;
 SELECT b+coalesce(sum(octet_length(to_jsonb(r)::text)),0) INTO b FROM price_matrix_import_profiles r WHERE tenant_id=t;
 IF (SELECT count(*) FROM price_matrix_import_profile_revisions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit rewizji profili importu macierzy cen' USING ERRCODE='P0001';END IF;
 IF b>268435456 THEN RAISE EXCEPTION 'Limit bajtów historii importu macierzy cen' USING ERRCODE='P0001';END IF;
 IF (SELECT count(*) FROM price_matrix_import_profiles WHERE tenant_id=t)>100 THEN RAISE EXCEPTION 'Limit profili importu macierzy cen' USING ERRCODE='P0001';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION price_matrix_import_validate_target(v jsonb,uid uuid,kid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p price_bulk_edit_previews%ROWTYPE; r jsonb;cr price_bulk_edit_rows%ROWTYPE;prod products%ROWTYPE;amount numeric;raw_amount jsonb;raw_operation jsonb;entry jsonb;raw_identity jsonb;raw_currency jsonb;safe boolean;present boolean;override_value integer;after_present boolean;after_value integer;live_list jsonb;value text;ident text;matches integer;candidate uuid;op text;i integer:=0;clean integer:=0;invalid integer:=0;changed integer:=0;unchanged integer:=0;conflicts integer:=0;missing integer:=0;
BEGIN
 PERFORM price_matrix_import_require(uid,kid,false);
 IF octet_length(v::text)>33554432 OR NOT price_file_import_definition(v->'definition') OR jsonb_typeof(v->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'rows') NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Niepoprawny pełny podgląd pliku' USING ERRCODE='23514';END IF;
 IF v->>'core_preview_id' IS NOT NULL THEN
  SELECT * INTO p FROM price_bulk_edit_previews WHERE (tenant_id,id)=(t,(v->>'core_preview_id')::uuid);
  IF p.id IS NULL OR p.actor_id IS DISTINCT FROM uid OR p.client_key IS DISTINCT FROM (v->>'id')::uuid OR p.price_list_id IS DISTINCT FROM (v->>'price_list_id')::uuid OR p.source IS DISTINCT FROM v->>'source' OR p.list_snapshot IS DISTINCT FROM v->'list_snapshot' OR p.warnings IS DISTINCT FROM v->'warnings' OR NOT EXISTS(SELECT 1 FROM price_matrix_import_core_witnesses w WHERE (w.tenant_id,w.kind,w.id,w.top_xid,w.transaction_started_at)=(t,'preview',p.id,pg_current_xact_id(),transaction_timestamp())) THEN RAISE EXCEPTION 'Podgląd pliku nie ma własnego nowego zakresu cen' USING ERRCODE='23514';END IF;
 END IF;
 SELECT jsonb_build_object('id',pl.id,'name',pl.name,'currency',pl.currency,'version',pl.version,'active',pl.active,'fallback',pl.fallback,'adjustment_bps',pl.adjustment_bps,'adjustment_amount',pl.adjustment_amount,'catalog_currency',tt.currency) INTO live_list FROM price_lists pl JOIN tenants tt ON tt.id=pl.tenant_id WHERE (pl.tenant_id,pl.id)=(t,(v->>'price_list_id')::uuid);
 IF live_list IS NULL OR (p.id IS NOT NULL AND p.list_snapshot IS DISTINCT FROM live_list) THEN RAISE EXCEPTION 'Cennik pliku nie odpowiada rzeczywistemu zakresowi' USING ERRCODE='23514';END IF;
 FOR r IN SELECT source_row.element FROM jsonb_array_elements(v->'rows') AS source_row(element) LOOP
  IF (r->>'index')::integer IS DISTINCT FROM i OR jsonb_typeof(r->'raw_cells') IS DISTINCT FROM 'object' OR jsonb_typeof(r->'errors') IS DISTINCT FROM 'array' OR (r->>'status' IN('changed','unchanged','invalid','conflict')) IS NOT TRUE OR jsonb_typeof(r->'resolution') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Niepełne wiersze pliku' USING ERRCODE='23514';END IF;i:=i+1;
  IF r->>'status'='invalid' THEN invalid:=invalid+1;ELSIF r->>'status'='conflict' THEN conflicts:=conflicts+1;ELSIF r->>'status'='changed' THEN changed:=changed+1;ELSE unchanged:=unchanged+1;END IF;
  IF r->'after'->>'source'='missing' THEN missing:=missing+1;END IF;
  IF r->>'product_id' IS NOT NULL THEN
   SELECT * INTO prod FROM products WHERE (tenant_id,id)=(t,(r->>'product_id')::uuid);
   IF prod.id IS NULL THEN RAISE EXCEPTION 'Obcy produkt w podglądzie pliku' USING ERRCODE='23514';END IF;
  END IF;
  IF r->>'status' IN('changed','unchanged','conflict') OR (r->'before'<>'null'::jsonb) THEN
   IF p.id IS NULL OR r->>'product_id' IS NULL THEN RAISE EXCEPTION 'Brak dowodu wiersza cen' USING ERRCODE='23514';END IF;
   SELECT * INTO cr FROM price_bulk_edit_rows WHERE (tenant_id,preview_id,product_id)=(t,p.id,(r->>'product_id')::uuid);
   IF cr.product_id IS NULL OR ROW(cr.sku,cr.name,cr.input,cr.before,coalesce(cr.after,'null'::jsonb),cr.status,cr.errors) IS DISTINCT FROM ROW(r->>'sku',r->>'name',r->'input',r->'before',r->'after',r->>'status',r->'errors') THEN RAISE EXCEPTION 'Wiersz pliku różni się od silnika cen' USING ERRCODE='23514';END IF;clean:=clean+1;
   ident:=v->'definition'->>'identity';safe:=v->'definition'->>'format'='csv' AND (v->'definition'->>'spreadsheet_safe')::boolean;
   raw_identity:=price_file_import_cell(r->'raw_cells'->(v->'definition'->'mapping'->>'identity'),safe,ident);
   IF jsonb_typeof(raw_identity) IS DISTINCT FROM 'string' OR r->'resolution'->>'identity' IS DISTINCT FROM ident OR r->'resolution'->'value' IS DISTINCT FROM raw_identity THEN RAISE EXCEPTION 'Źródłowy identyfikator różni się od rozwiązania' USING ERRCODE='23514';END IF;
   value:=raw_identity#>>'{}';
   IF ident='uuid' THEN SELECT count(*),min(id::text)::uuid INTO matches,candidate FROM products WHERE tenant_id=t AND id::text=value;
   ELSIF ident IN('sku','historical_sku') THEN SELECT count(*),min(pp.id::text)::uuid INTO matches,candidate FROM products pp WHERE pp.tenant_id=t AND (pp.sku=value OR EXISTS(SELECT 1 FROM product_sku_aliases a WHERE (a.tenant_id,a.product_id,a.sku)=(t,pp.id,value)));
   ELSIF ident='ean' THEN SELECT count(*),min(id::text)::uuid INTO matches,candidate FROM products WHERE tenant_id=t AND ean<>'' AND ean=value;
   ELSE SELECT count(*),min(id::text)::uuid INTO matches,candidate FROM products WHERE tenant_id=t AND name=value;END IF;
   IF matches<>1 OR candidate IS DISTINCT FROM cr.product_id OR r->'resolution'->'matched_historical_sku' IS DISTINCT FROM to_jsonb(ident IN('sku','historical_sku') AND prod.sku<>value) THEN RAISE EXCEPTION 'Nieprawidłowe powiązanie źródła produktu' USING ERRCODE='23514';END IF;
   raw_currency:=NULL;op:=NULL;raw_amount:=NULL;
   IF v->'definition'->>'native_price_mode'='own_entries' THEN
    IF jsonb_typeof(r->'raw_cells'->'prices_json') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Nieprawidłowa grupa własnych cen' USING ERRCODE='23514';END IF;
    SELECT count(*) INTO matches FROM jsonb_array_elements(r->'raw_cells'->'prices_json') x(entry) WHERE x.entry->>'price_list_id'=p.price_list_id::text;
    IF matches<>1 THEN RAISE EXCEPTION 'Nieprawidłowa grupa własnych cen' USING ERRCODE='23514';END IF;
    SELECT x.entry INTO entry FROM jsonb_array_elements(r->'raw_cells'->'prices_json') x(entry) WHERE x.entry->>'price_list_id'=p.price_list_id::text;
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR entry->>'currency' IS DISTINCT FROM p.list_snapshot->>'currency' THEN RAISE EXCEPTION 'Nieprawidłowa projekcja własnych cen' USING ERRCODE='23514';END IF;
    IF entry->>'source'='override' AND entry->>'status'='available' AND jsonb_typeof(entry->'own_price_minor')='number' THEN op:='set';raw_amount:=entry->'own_price_minor';
    ELSIF ((entry->>'source'='rule' AND entry->>'status'='available') OR (entry->'source'='null'::jsonb AND entry->>'status'='missing')) AND entry->'own_price_minor'='null'::jsonb THEN op:='remove';
    ELSE RAISE EXCEPTION 'Nieprawidłowa projekcja własnych cen' USING ERRCODE='23514';END IF;
    IF (r->>'skipped_price_groups')::integer IS DISTINCT FROM jsonb_array_length(r->'raw_cells'->'prices_json')-1 THEN RAISE EXCEPTION 'Niepełna informacja o pominiętych cennikach' USING ERRCODE='23514';END IF;
   ELSE
    IF (v->'definition'->'mapping' ? 'operation' AND NOT (r->'raw_cells' ? (v->'definition'->'mapping'->>'operation'))) OR (v->'definition'->'mapping' ? 'currency' AND NOT (r->'raw_cells' ? (v->'definition'->'mapping'->>'currency'))) THEN RAISE EXCEPTION 'Brak mapowanego pola pliku cen' USING ERRCODE='23514';END IF;
    raw_amount:=price_file_import_cell(r->'raw_cells'->(v->'definition'->'mapping'->>'price'),safe);
    IF v->'definition'->'mapping' ? 'operation' THEN raw_operation:=price_file_import_cell(r->'raw_cells'->(v->'definition'->'mapping'->>'operation'),safe);op:=raw_operation#>>'{}';END IF;
    IF op IS NULL OR op='' THEN op:=CASE WHEN NOT (r->'raw_cells' ? (v->'definition'->'mapping'->>'price')) THEN 'none' WHEN raw_amount IS NULL OR raw_amount='null'::jsonb OR raw_amount='""'::jsonb THEN CASE WHEN v->'definition'->>'empty_policy'='skip' THEN 'none' ELSE 'remove' END ELSE 'set' END;END IF;
    IF v->'definition'->'mapping' ? 'currency' THEN raw_currency:=price_file_import_cell(r->'raw_cells'->(v->'definition'->'mapping'->>'currency'),safe);
     IF jsonb_typeof(raw_currency) IS DISTINCT FROM 'string' OR raw_currency#>>'{}' IS DISTINCT FROM p.list_snapshot->>'currency' THEN RAISE EXCEPTION 'Waluta wiersza różni się od cennika' USING ERRCODE='23514';END IF;
    END IF;
   END IF;
   IF op NOT IN('none','set','remove') OR op IS DISTINCT FROM cr.input->>'operation' THEN RAISE EXCEPTION 'Źródłowa operacja różni się od zatwierdzonej' USING ERRCODE='23514';END IF;
   IF op='set' THEN
    value:=raw_amount#>>'{}';
    IF v->'definition'->>'native_price_mode'='own_entries' OR v->'definition'->>'amount_mode'='minor' THEN
     IF jsonb_typeof(raw_amount) NOT IN('string','number') OR value IS NULL OR value !~ '^(0|[1-9][0-9]*)$' THEN RAISE EXCEPTION 'Niepoprawna źródłowa kwota minor' USING ERRCODE='23514';END IF;amount:=value::numeric;
    ELSE
     IF jsonb_typeof(raw_amount) IS DISTINCT FROM 'string' OR value IS NULL OR value !~ (CASE WHEN v->'definition'->>'decimal_separator'='.' THEN '^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$' ELSE '^(0|[1-9][0-9]*)(,[0-9]{1,2})?$' END) THEN RAISE EXCEPTION 'Niepoprawna źródłowa cena dziesiętna' USING ERRCODE='23514';END IF;
     amount:=replace(value,',','.')::numeric*100;
    END IF;
    IF amount<0 OR amount>100000000 OR cr.input->'amount_minor' IS DISTINCT FROM to_jsonb(amount::integer) OR cr.input->>'basis' IS DISTINCT FROM (CASE WHEN v->'definition'->>'native_price_mode'='own_entries' THEN 'gross' ELSE v->'definition'->>'basis' END) THEN RAISE EXCEPTION 'Źródłowa cena różni się od zatwierdzonej' USING ERRCODE='23514';END IF;
   END IF;
   IF cr.status IN('changed','unchanged') THEN
    SELECT to_jsonb(l)||jsonb_build_object('catalog_currency',tt.currency) INTO live_list FROM price_lists l JOIN tenants tt ON tt.id=l.tenant_id WHERE (l.tenant_id,l.id)=(t,p.price_list_id);
    SELECT price INTO override_value FROM price_list_items WHERE (tenant_id,price_list_id,product_id)=(t,p.price_list_id,prod.id);present:=FOUND;
    IF cr.product_version IS DISTINCT FROM prod.version OR cr.input->'product_version' IS DISTINCT FROM to_jsonb(prod.version) OR cr.before IS DISTINCT FROM price_file_import_snapshot(live_list,to_jsonb(prod),present,override_value) THEN RAISE EXCEPTION 'Cena początkowa nie odpowiada rzeczywistemu produktowi' USING ERRCODE='23514';END IF;
    after_present:=present;after_value:=override_value;
    IF op='remove' THEN after_present:=false;after_value:=NULL;ELSIF op='set' THEN after_present:=true;after_value:=CASE WHEN cr.input->>'basis'='net' THEN ((amount::bigint*(100+prod.vat)+50)/100)::integer ELSE amount::integer END;END IF;
    IF after_value<0 OR after_value>100000000 OR cr.after IS DISTINCT FROM price_file_import_snapshot(live_list,to_jsonb(prod),after_present,after_value) OR cr.status IS DISTINCT FROM (CASE WHEN after_present IS DISTINCT FROM present OR after_value IS DISTINCT FROM override_value THEN 'changed' ELSE 'unchanged' END) THEN RAISE EXCEPTION 'Cena końcowa nie odpowiada źródłowej operacji' USING ERRCODE='23514';END IF;
   END IF;
  END IF;
 END LOOP;
 IF invalid=0 AND conflicts=0 AND (p.id IS NULL OR clean<>i) THEN RAISE EXCEPTION 'Gotowy plik nie ma pełnego zakresu cen' USING ERRCODE='23514';END IF;
 IF p.id IS NOT NULL AND clean<>p.total THEN RAISE EXCEPTION 'Silnik ma inny pełny zakres pliku' USING ERRCODE='23514';END IF;
 IF v->'summary' IS DISTINCT FROM jsonb_build_object('total',i,'changed',changed,'unchanged',unchanged,'invalid',invalid,'conflicts',conflicts,'missing_after_count',missing,'ready',invalid=0 AND conflicts=0) THEN RAISE EXCEPTION 'Nieprawidłowe podsumowanie pliku' USING ERRCODE='23514';END IF;
 RETURN;
END $$;
CREATE FUNCTION price_matrix_import_store_preview(v jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;target jsonb;source_row jsonb;cell jsonb;target_rows jsonb;part jsonb;prod products%ROWTYPE;definition jsonb;identity jsonb;ident text;value text;matches integer;candidate uuid;cells integer:=0;changed integer:=0;unchanged integer:=0;invalid integer:=0;conflicts integer:=0;missing integer:=0;idx integer:=0;BEGIN
 PERFORM price_matrix_import_require(uid,kid,false);PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog:'||t,0));PERFORM pg_advisory_xact_lock(hashtextextended('price.bulk:'||t,0));PERFORM pg_advisory_xact_lock(hashtextextended('price.matrix:'||t,0));
 IF v->>'source' IS DISTINCT FROM (CASE WHEN kid IS NULL THEN 'manual' ELSE 'api' END) THEN RAISE EXCEPTION 'Źródło macierzy nie odpowiada aktorowi' USING ERRCODE='23514';END IF;
 IF octet_length(v::text)>33554432 OR NOT price_matrix_import_targets(v->'targets') OR jsonb_typeof(v->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'rows')<1 OR jsonb_array_length(v->'rows')>500 OR jsonb_typeof(v->'warnings') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Niepoprawny pełny podgląd macierzy' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v->'rows')r(element) WHERE r.element->>'product_id' IS NOT NULL AND (SELECT count(*) FROM jsonb_array_elements(v->'rows')d(element) WHERE d.element->>'product_id'=r.element->>'product_id')>1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.element->'cells')c(cell) WHERE c.cell->>'status'<>'invalid')) THEN RAISE EXCEPTION 'Powtórzony produkt macierzy' USING ERRCODE='23514';END IF;
 definition:=v->'targets'->0->'definition';ident:=definition->>'identity';
 FOR source_row IN SELECT x.element FROM jsonb_array_elements(v->'rows')x(element) LOOP
  IF (source_row->>'index')::integer IS DISTINCT FROM idx OR jsonb_typeof(source_row->'raw_cells') IS DISTINCT FROM 'object' OR jsonb_typeof(source_row->'errors') IS DISTINCT FROM 'array' OR jsonb_typeof(source_row->'cells') IS DISTINCT FROM 'array' OR jsonb_array_length(source_row->'cells')<>jsonb_array_length(v->'targets') THEN RAISE EXCEPTION 'Niepełne wiersze macierzy' USING ERRCODE='23514';END IF;idx:=idx+1;
  IF (SELECT jsonb_agg(x.element->'price_list_id' ORDER BY x.ord) FROM jsonb_array_elements(source_row->'cells')WITH ORDINALITY x(element,ord)) IS DISTINCT FROM (SELECT jsonb_agg(x.element->'price_list_id' ORDER BY x.ord) FROM jsonb_array_elements(v->'targets')WITH ORDINALITY x(element,ord)) THEN RAISE EXCEPTION 'Niepełne komórki macierzy' USING ERRCODE='23514';END IF;
  IF source_row->>'product_id' IS NOT NULL THEN
   SELECT * INTO prod FROM products WHERE (tenant_id,id)=(t,(source_row->>'product_id')::uuid);
   identity:=price_file_import_cell(source_row->'raw_cells'->(definition->'mapping'->>'identity'),definition->>'format'='csv' AND (definition->>'spreadsheet_safe')::boolean,ident);value:=identity#>>'{}';
   IF jsonb_typeof(identity) IS DISTINCT FROM 'string' OR source_row->'resolution'->>'identity' IS DISTINCT FROM ident OR source_row->'resolution'->'value' IS DISTINCT FROM identity THEN RAISE EXCEPTION 'Źródłowy identyfikator różni się od rozwiązania' USING ERRCODE='23514';END IF;
   IF ident='uuid' THEN SELECT count(*),min(id::text)::uuid INTO matches,candidate FROM products WHERE tenant_id=t AND id::text=value;
   ELSIF ident IN('sku','historical_sku') THEN SELECT count(*),min(pp.id::text)::uuid INTO matches,candidate FROM products pp WHERE pp.tenant_id=t AND (pp.sku=value OR EXISTS(SELECT 1 FROM product_sku_aliases a WHERE (a.tenant_id,a.product_id,a.sku)=(t,pp.id,value)));
   ELSIF ident='ean' THEN SELECT count(*),min(id::text)::uuid INTO matches,candidate FROM products WHERE tenant_id=t AND ean<>'' AND ean=value;
   ELSE SELECT count(*),min(id::text)::uuid INTO matches,candidate FROM products WHERE tenant_id=t AND name=value;END IF;
   IF prod.id IS NULL OR matches<>1 OR candidate IS DISTINCT FROM prod.id OR ROW(source_row->>'sku',source_row->>'name') IS DISTINCT FROM ROW(prod.sku,prod.name) OR source_row->'resolution' IS DISTINCT FROM jsonb_build_object('identity',ident,'value',identity,'matched_historical_sku',ident IN('sku','historical_sku') AND prod.sku<>value) THEN RAISE EXCEPTION 'Nieprawidłowe wspólne rozwiązanie macierzy' USING ERRCODE='23514';END IF;
  END IF;
  FOR cell IN SELECT x.element FROM jsonb_array_elements(source_row->'cells')x(element) LOOP
   cells:=cells+1;IF cell->>'status'='changed' THEN changed:=changed+1;ELSIF cell->>'status'='unchanged' THEN unchanged:=unchanged+1;ELSIF cell->>'status'='invalid' THEN invalid:=invalid+1;ELSIF cell->>'status'='conflict' THEN conflicts:=conflicts+1;ELSE RAISE EXCEPTION 'Niepoprawny status komórki macierzy' USING ERRCODE='23514';END IF;
   IF cell->'after'->>'source'='missing' THEN missing:=missing+1;END IF;
   IF source_row->>'product_id' IS NULL AND cell->>'status'<>'invalid' THEN RAISE EXCEPTION 'Nieznany produkt ma wykonywalną komórkę' USING ERRCODE='23514';END IF;
  END LOOP;
 END LOOP;
 IF cells>4000 OR v->'summary' IS DISTINCT FROM jsonb_build_object('total_products',idx,'total_cells',cells,'changed',changed,'unchanged',unchanged,'invalid',invalid,'conflicts',conflicts,'missing_after_count',missing,'ready',invalid=0 AND conflicts=0) THEN RAISE EXCEPTION 'Nieprawidłowe podsumowanie macierzy' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v->'targets')x(element) WHERE element->>'core_preview_id' IS NOT NULL GROUP BY element->>'core_preview_id' HAVING count(*)>1) THEN RAISE EXCEPTION 'Powtórzony silnik macierzy' USING ERRCODE='23514';END IF;
 FOR target IN SELECT x.element FROM jsonb_array_elements(v->'targets')x(element) LOOP
  SELECT jsonb_agg((x.element-'cells'-'errors')||(SELECT c.element-'price_list_id' FROM jsonb_array_elements(x.element->'cells')c(element) WHERE c.element->>'price_list_id'=target->>'price_list_id') ORDER BY (x.element->>'index')::integer) INTO target_rows FROM jsonb_array_elements(v->'rows')x(element);
  part:=jsonb_build_object('id',target->'core_client_key','definition',target->'definition','rows',target_rows,'price_list_id',target->'price_list_id','core_preview_id',target->'core_preview_id','list_snapshot',target->'list_snapshot','warnings',target->'warnings','summary',target->'summary','source',v->'source');
  PERFORM price_matrix_import_validate_target(part,uid,kid);
  IF target->>'core_preview_id' IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM price_bulk_edit_previews cp WHERE (cp.tenant_id,cp.id)=(t,(target->>'core_preview_id')::uuid) AND cp.repricing_snapshot=target->'repricing_snapshot') OR EXISTS(SELECT 1 FROM price_file_import_previews fp WHERE (fp.tenant_id,fp.core_preview_id)=(t,(target->>'core_preview_id')::uuid)) OR EXISTS(SELECT 1 FROM price_matrix_import_targets mp WHERE (mp.tenant_id,mp.core_preview_id)=(t,(target->>'core_preview_id')::uuid))) THEN RAISE EXCEPTION 'Silnik ma inny zakres macierzy' USING ERRCODE='23514';END IF;
 END LOOP;
 INSERT INTO price_matrix_import_previews(id,tenant_id,actor_id,api_key_id,client_key,request_hash,scope_hash,file_name,source_hash,source,targets,warnings,summary,rows) VALUES((v->>'id')::uuid,t,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',v->>'scope_hash',v->>'file_name',v->>'source_hash',v->>'source',v->'targets',v->'warnings',v->'summary',v->'rows');
 INSERT INTO price_matrix_import_targets(tenant_id,preview_id,price_list_id,core_preview_id,core_client_key) SELECT t,(v->>'id')::uuid,(element->>'price_list_id')::uuid,(element->>'core_preview_id')::uuid,(element->>'core_client_key')::uuid FROM jsonb_array_elements(v->'targets')x(element);
 RETURN (v->>'id')::uuid;
END $$;
CREATE FUNCTION price_matrix_import_execution_valid(eid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;e price_matrix_import_executions%ROWTYPE;p price_matrix_import_previews%ROWTYPE;ce price_bulk_edit_executions%ROWTYPE;target jsonb;link jsonb;source_row jsonb;cell jsonb;prod products%ROWTYPE;l jsonb;present boolean;override_value integer;required jsonb;rule_json jsonb;schedule_json jsonb;run_json jsonb;matches integer;candidate uuid;ident text;value text;BEGIN
 SELECT * INTO e FROM price_matrix_import_executions WHERE (tenant_id,id)=(t,eid);SELECT * INTO p FROM price_matrix_import_previews WHERE (tenant_id,id)=(t,e.preview_id);
 IF e.id IS NULL OR p.id IS NULL OR p.summary->'ready' IS DISTINCT FROM 'true'::jsonb OR e.scope_hash IS DISTINCT FROM p.scope_hash OR e.actor_id IS DISTINCT FROM p.actor_id OR e.api_key_id IS DISTINCT FROM p.api_key_id OR jsonb_array_length(e.core_execution_ids)<>jsonb_array_length(p.targets) OR (SELECT count(*) FROM price_matrix_import_execution_targets WHERE (tenant_id,execution_id)=(t,e.id))<>jsonb_array_length(p.targets) THEN RAISE EXCEPTION 'Niepełny wynik całej macierzy' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(x.element->'price_list_id' ORDER BY x.element->>'price_list_id'),'[]'::jsonb) INTO required FROM jsonb_array_elements(p.targets)x(element) WHERE (x.element->'summary'->>'missing_after_count')::integer>0;
 IF e.ack_missing_price_list_ids IS DISTINCT FROM required OR (SELECT jsonb_agg(x.element->'price_list_id' ORDER BY x.ord) FROM jsonb_array_elements(e.core_execution_ids)WITH ORDINALITY x(element,ord)) IS DISTINCT FROM (SELECT jsonb_agg(x.element->'price_list_id' ORDER BY x.ord) FROM jsonb_array_elements(p.targets)WITH ORDINALITY x(element,ord)) THEN RAISE EXCEPTION 'Zgoda nie obejmuje dokładnie całej macierzy' USING ERRCODE='23514';END IF;
 ident:=p.targets->0->'definition'->>'identity';
 FOR source_row IN SELECT x.element FROM jsonb_array_elements(p.rows)x(element) LOOP
  value:=source_row->'resolution'->>'value';
  IF ident='uuid' THEN SELECT count(*),min(id::text)::uuid INTO matches,candidate FROM products WHERE tenant_id=t AND id::text=value;
  ELSIF ident IN('sku','historical_sku') THEN SELECT count(*),min(pp.id::text)::uuid INTO matches,candidate FROM products pp WHERE pp.tenant_id=t AND (pp.sku=value OR EXISTS(SELECT 1 FROM product_sku_aliases a WHERE (a.tenant_id,a.product_id,a.sku)=(t,pp.id,value)));
  ELSIF ident='ean' THEN SELECT count(*),min(id::text)::uuid INTO matches,candidate FROM products WHERE tenant_id=t AND ean<>'' AND ean=value;
  ELSE SELECT count(*),min(id::text)::uuid INTO matches,candidate FROM products WHERE tenant_id=t AND name=value;END IF;
  IF matches<>1 OR candidate IS DISTINCT FROM (source_row->>'product_id')::uuid THEN RAISE EXCEPTION 'Mapowanie identyfikatora macierzy zmieniło się' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR target IN SELECT x.element FROM jsonb_array_elements(p.targets)x(element) LOOP
  SELECT x.element INTO link FROM jsonb_array_elements(e.core_execution_ids)x(element) WHERE x.element->>'price_list_id'=target->>'price_list_id';
  SELECT * INTO ce FROM price_bulk_edit_executions WHERE (tenant_id,id)=(t,(link->>'core_execution_id')::uuid);
  IF ce.id IS NULL OR ROW(ce.preview_id,ce.actor_id,ce.price_list_id,ce.list_snapshot,ce.repricing_snapshot,ce.warnings,ce.total,ce.changed,ce.unchanged,ce.missing_after_count,ce.ack_missing_prices) IS DISTINCT FROM ROW((target->>'core_preview_id')::uuid,p.actor_id,(target->>'price_list_id')::uuid,target->'list_snapshot',target->'repricing_snapshot',target->'warnings',(target->'summary'->>'total')::integer,(target->'summary'->>'changed')::integer,(target->'summary'->>'unchanged')::integer,(target->'summary'->>'missing_after_count')::integer,(target->'summary'->>'missing_after_count')::integer>0) OR ce.total<>jsonb_array_length(p.rows) OR (SELECT count(*) FROM price_bulk_edit_execution_rows WHERE (tenant_id,execution_id)=(t,ce.id))<>ce.total OR NOT EXISTS(SELECT 1 FROM price_matrix_import_execution_targets et WHERE (et.tenant_id,et.execution_id,et.preview_id,et.price_list_id,et.core_execution_id)=(t,e.id,p.id,ce.price_list_id,ce.id)) THEN RAISE EXCEPTION 'Niepełny rzeczywisty wynik komórek macierzy' USING ERRCODE='23514';END IF;
  SELECT to_jsonb(pl)||jsonb_build_object('catalog_currency',tt.currency) INTO l FROM price_lists pl JOIN tenants tt ON tt.id=pl.tenant_id WHERE (pl.tenant_id,pl.id)=(t,ce.price_list_id);
  SELECT jsonb_build_object('version',rr.version,'config_version',rr.config_version,'config',rr.config) INTO rule_json FROM repricing_rules rr WHERE (rr.tenant_id,rr.price_list_id)=(t,ce.price_list_id);
  SELECT jsonb_build_object('version',rs.version,'enabled',rs.enabled,'actor_id',rs.actor_id,'rule_config_version',rs.rule_config_version,'interval_minutes',rs.interval_minutes,'batch_size',rs.batch_size) INTO schedule_json FROM repricing_schedules rs WHERE (rs.tenant_id,rs.price_list_id)=(t,ce.price_list_id);
  SELECT jsonb_build_object('id',rr.id,'state',rr.state,'rule_version',rr.rule_version,'schedule_version',rr.schedule_version,'expected_list_version',rr.expected_list_version,'cursor',rr.cursor,'scanned',rr.scanned,'changed',rr.changed) INTO run_json FROM repricing_runs rr WHERE (rr.tenant_id,rr.price_list_id)=(t,ce.price_list_id) AND rr.state='queued' ORDER BY rr.id LIMIT 1;
  IF (l->>'version')::integer IS DISTINCT FROM ce.after_list_version OR jsonb_build_object('id',l->'id','name',l->'name','currency',l->'currency','version',to_jsonb(ce.before_list_version),'active',l->'active','fallback',l->'fallback','adjustment_bps',l->'adjustment_bps','adjustment_amount',l->'adjustment_amount','catalog_currency',l->'catalog_currency') IS DISTINCT FROM target->'list_snapshot' OR jsonb_build_object('rule',rule_json,'schedule',schedule_json,'queued_run',run_json) IS DISTINCT FROM target->'repricing_snapshot' THEN RAISE EXCEPTION 'Zmieniona końcowa konfiguracja macierzy' USING ERRCODE='23514';END IF;
  FOR source_row IN SELECT x.element FROM jsonb_array_elements(p.rows)x(element) LOOP
   SELECT x.element INTO cell FROM jsonb_array_elements(source_row->'cells')x(element) WHERE x.element->>'price_list_id'=target->>'price_list_id';
   SELECT * INTO prod FROM products WHERE (tenant_id,id)=(t,(source_row->>'product_id')::uuid);SELECT price INTO override_value FROM price_list_items WHERE (tenant_id,price_list_id,product_id)=(t,ce.price_list_id,prod.id);present:=FOUND;
   IF prod.id IS NULL OR prod.version IS DISTINCT FROM (cell->'input'->>'product_version')::integer OR cell->'after' IS DISTINCT FROM price_file_import_snapshot(l,to_jsonb(prod),present,override_value) OR NOT EXISTS(SELECT 1 FROM price_bulk_edit_execution_rows er WHERE (er.tenant_id,er.execution_id,er.product_id)=(t,ce.id,prod.id) AND er.input=cell->'input' AND er.before=cell->'before' AND er.after=cell->'after' AND er.status=cell->>'status') THEN RAISE EXCEPTION 'Rzeczywista cena odbiega od pełnej zgody macierzy' USING ERRCODE='23514';END IF;
  END LOOP;
 END LOOP;
END $$;
CREATE FUNCTION price_matrix_import_prepare_execution(pid uuid,uid uuid,kid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p price_matrix_import_previews%ROWTYPE;target jsonb;source_row jsonb;cell jsonb;prod products%ROWTYPE;cp price_bulk_edit_previews%ROWTYPE;list_json jsonb;rule_json jsonb;schedule_json jsonb;run_json jsonb;present boolean;override_value integer;matches integer;candidate uuid;ident text;value text;BEGIN
 PERFORM price_matrix_import_require(uid,kid,false);PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog:'||t,0));PERFORM pg_advisory_xact_lock(hashtextextended('price.bulk:'||t,0));PERFORM pg_advisory_xact_lock(hashtextextended('price.matrix:'||t,0));
 SELECT * INTO p FROM price_matrix_import_previews WHERE (tenant_id,id)=(t,pid);
 IF p.id IS NULL OR p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid OR p.summary->'ready' IS DISTINCT FROM 'true'::jsonb OR EXISTS(SELECT 1 FROM price_matrix_import_executions WHERE (tenant_id,preview_id)=(t,pid)) THEN RAISE EXCEPTION 'Macierz nie jest gotowa do wykonania' USING ERRCODE='23514';END IF;
 PERFORM pl.id FROM price_lists pl WHERE pl.tenant_id=t AND pl.id IN(SELECT (x.element->>'price_list_id')::uuid FROM jsonb_array_elements(p.targets)x(element)) ORDER BY pl.id FOR UPDATE;
 PERFORM rr.price_list_id FROM repricing_rules rr WHERE rr.tenant_id=t AND rr.price_list_id IN(SELECT (x.element->>'price_list_id')::uuid FROM jsonb_array_elements(p.targets)x(element)) ORDER BY rr.price_list_id FOR UPDATE;
 PERFORM rs.price_list_id FROM repricing_schedules rs WHERE rs.tenant_id=t AND rs.price_list_id IN(SELECT (x.element->>'price_list_id')::uuid FROM jsonb_array_elements(p.targets)x(element)) ORDER BY rs.price_list_id FOR UPDATE;
 PERFORM rr.id FROM repricing_runs rr WHERE rr.tenant_id=t AND rr.price_list_id IN(SELECT (x.element->>'price_list_id')::uuid FROM jsonb_array_elements(p.targets)x(element)) AND rr.state='queued' ORDER BY rr.price_list_id,rr.id FOR SHARE;
 PERFORM pp.id FROM products pp WHERE pp.tenant_id=t AND pp.id IN(SELECT (x.element->>'product_id')::uuid FROM jsonb_array_elements(p.rows)x(element)) ORDER BY pp.id FOR SHARE;
 PERFORM li.product_id FROM price_list_items li WHERE li.tenant_id=t AND li.price_list_id IN(SELECT (x.element->>'price_list_id')::uuid FROM jsonb_array_elements(p.targets)x(element)) AND li.product_id IN(SELECT (x.element->>'product_id')::uuid FROM jsonb_array_elements(p.rows)x(element)) ORDER BY li.price_list_id,li.product_id FOR UPDATE;
 ident:=p.targets->0->'definition'->>'identity';
 FOR source_row IN SELECT x.element FROM jsonb_array_elements(p.rows)x(element) LOOP
  value:=source_row->'resolution'->>'value';
  IF ident='uuid' THEN SELECT count(*),min(id::text)::uuid INTO matches,candidate FROM products WHERE tenant_id=t AND id::text=value;
  ELSIF ident IN('sku','historical_sku') THEN SELECT count(*),min(pp.id::text)::uuid INTO matches,candidate FROM products pp WHERE pp.tenant_id=t AND (pp.sku=value OR EXISTS(SELECT 1 FROM product_sku_aliases a WHERE (a.tenant_id,a.product_id,a.sku)=(t,pp.id,value)));
  ELSIF ident='ean' THEN SELECT count(*),min(id::text)::uuid INTO matches,candidate FROM products WHERE tenant_id=t AND ean<>'' AND ean=value;
  ELSE SELECT count(*),min(id::text)::uuid INTO matches,candidate FROM products WHERE tenant_id=t AND name=value;END IF;
  IF matches<>1 OR candidate IS DISTINCT FROM (source_row->>'product_id')::uuid THEN RAISE EXCEPTION 'Mapowanie identyfikatora macierzy zmieniło się' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR target IN SELECT x.element FROM jsonb_array_elements(p.targets)x(element) LOOP
  SELECT * INTO cp FROM price_bulk_edit_previews WHERE (tenant_id,id)=(t,(target->>'core_preview_id')::uuid);
  SELECT jsonb_build_object('id',pl.id,'name',pl.name,'currency',pl.currency,'version',pl.version,'active',pl.active,'fallback',pl.fallback,'adjustment_bps',pl.adjustment_bps,'adjustment_amount',pl.adjustment_amount,'catalog_currency',tt.currency) INTO list_json FROM price_lists pl JOIN tenants tt ON tt.id=pl.tenant_id WHERE (pl.tenant_id,pl.id)=(t,(target->>'price_list_id')::uuid);
  SELECT jsonb_build_object('version',rr.version,'config_version',rr.config_version,'config',rr.config) INTO rule_json FROM repricing_rules rr WHERE (rr.tenant_id,rr.price_list_id)=(t,(target->>'price_list_id')::uuid);
  SELECT jsonb_build_object('version',rs.version,'enabled',rs.enabled,'actor_id',rs.actor_id,'rule_config_version',rs.rule_config_version,'interval_minutes',rs.interval_minutes,'batch_size',rs.batch_size) INTO schedule_json FROM repricing_schedules rs WHERE (rs.tenant_id,rs.price_list_id)=(t,(target->>'price_list_id')::uuid);
  SELECT jsonb_build_object('id',rr.id,'state',rr.state,'rule_version',rr.rule_version,'schedule_version',rr.schedule_version,'expected_list_version',rr.expected_list_version,'cursor',rr.cursor,'scanned',rr.scanned,'changed',rr.changed) INTO run_json FROM repricing_runs rr WHERE (rr.tenant_id,rr.price_list_id)=(t,(target->>'price_list_id')::uuid) AND rr.state='queued' ORDER BY rr.id LIMIT 1;
  IF cp.id IS NULL OR NOT cp.ready OR cp.list_snapshot IS DISTINCT FROM list_json OR cp.repricing_snapshot IS DISTINCT FROM jsonb_build_object('rule',rule_json,'schedule',schedule_json,'queued_run',run_json) THEN RAISE EXCEPTION 'Cennik lub repricing macierzy zmienił się' USING ERRCODE='23514';END IF;
  FOR source_row IN SELECT x.element FROM jsonb_array_elements(p.rows)x(element) LOOP
   SELECT x.element INTO cell FROM jsonb_array_elements(source_row->'cells')x(element) WHERE x.element->>'price_list_id'=target->>'price_list_id';
   SELECT * INTO prod FROM products WHERE (tenant_id,id)=(t,(source_row->>'product_id')::uuid);SELECT price INTO override_value FROM price_list_items WHERE (tenant_id,price_list_id,product_id)=(t,cp.price_list_id,prod.id);present:=FOUND;
   IF prod.id IS NULL OR prod.version IS DISTINCT FROM (cell->'input'->>'product_version')::integer OR cell->'before' IS DISTINCT FROM price_file_import_snapshot(list_json,to_jsonb(prod),present,override_value) THEN RAISE EXCEPTION 'Produkt lub cena początkowa macierzy zmieniły się' USING ERRCODE='23514';END IF;
  END LOOP;
 END LOOP;
 INSERT INTO price_matrix_import_execution_admissions VALUES(t,pid,uid,kid,pg_current_xact_id(),transaction_timestamp());
END $$;
CREATE FUNCTION price_matrix_import_store_execution(v jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p price_matrix_import_previews%ROWTYPE;link jsonb;ce price_bulk_edit_executions%ROWTYPE;BEGIN
 PERFORM price_matrix_import_require(uid,kid,false);PERFORM pg_advisory_xact_lock(hashtextextended('price.matrix:'||t,0));
 SELECT * INTO p FROM price_matrix_import_previews WHERE (tenant_id,id)=(t,(v->>'preview_id')::uuid);
 IF p.id IS NULL OR p.summary->'ready' IS DISTINCT FROM 'true'::jsonb OR p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid OR p.scope_hash IS DISTINCT FROM v->>'scope_hash' OR jsonb_typeof(v->'core_execution_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'core_execution_ids')<>jsonb_array_length(p.targets) OR jsonb_typeof(v->'ack_missing_price_list_ids') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Wykonanie nie ma zatwierdzonej całej macierzy' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM price_matrix_import_execution_admissions a WHERE (a.tenant_id,a.preview_id,a.actor_id,a.top_xid,a.transaction_started_at)=(t,p.id,uid,pg_current_xact_id(),transaction_timestamp()) AND a.api_key_id IS NOT DISTINCT FROM kid) THEN RAISE EXCEPTION 'Brak pierwotnej zgody CAS całej macierzy' USING ERRCODE='23514';END IF;
 FOR link IN SELECT x.element FROM jsonb_array_elements(v->'core_execution_ids')x(element) LOOP
  SELECT * INTO ce FROM price_bulk_edit_executions WHERE (tenant_id,id)=(t,(link->>'core_execution_id')::uuid);
  IF ce.id IS NULL OR NOT EXISTS(SELECT 1 FROM price_matrix_import_core_witnesses w WHERE (w.tenant_id,w.kind,w.id,w.top_xid,w.transaction_started_at)=(t,'execution',ce.id,pg_current_xact_id(),transaction_timestamp())) OR NOT EXISTS(SELECT 1 FROM price_matrix_import_targets mt WHERE (mt.tenant_id,mt.preview_id,mt.price_list_id,mt.core_preview_id)=(t,p.id,(link->>'price_list_id')::uuid,ce.preview_id)) OR EXISTS(SELECT 1 FROM price_file_import_executions fe WHERE (fe.tenant_id,fe.core_execution_id)=(t,ce.id)) THEN RAISE EXCEPTION 'Wykonanie macierzy wymaga nowych własnych wyników silnika' USING ERRCODE='23514';END IF;
 END LOOP;
 INSERT INTO price_matrix_import_executions(id,tenant_id,preview_id,actor_id,api_key_id,client_key,request_hash,scope_hash,core_execution_ids,ack_missing_price_list_ids) VALUES((v->>'id')::uuid,t,p.id,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',p.scope_hash,v->'core_execution_ids',v->'ack_missing_price_list_ids');
 INSERT INTO price_matrix_import_execution_targets(tenant_id,execution_id,preview_id,price_list_id,core_execution_id) SELECT t,(v->>'id')::uuid,p.id,(x.element->>'price_list_id')::uuid,(x.element->>'core_execution_id')::uuid FROM jsonb_array_elements(v->'core_execution_ids')x(element);
 PERFORM price_matrix_import_execution_valid((v->>'id')::uuid);RETURN (v->>'id')::uuid;
END $$;
CREATE FUNCTION price_matrix_import_admission_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM price_matrix_import_executions e WHERE (e.tenant_id,e.preview_id,e.actor_id,e.top_xid,e.transaction_started_at)=(NEW.tenant_id,NEW.preview_id,NEW.actor_id,NEW.top_xid,NEW.transaction_started_at) AND e.api_key_id IS NOT DISTINCT FROM NEW.api_key_id) THEN RAISE EXCEPTION 'Zgoda CAS bez całego wyniku macierzy' USING ERRCODE='23514';END IF;
 DELETE FROM price_matrix_import_execution_admissions WHERE (tenant_id,preview_id,top_xid,transaction_started_at)=(NEW.tenant_id,NEW.preview_id,NEW.top_xid,NEW.transaction_started_at);RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER complete AFTER INSERT ON price_matrix_import_execution_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION price_matrix_import_admission_complete();
CREATE FUNCTION price_matrix_import_store_profile(v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p price_matrix_import_profiles%ROWTYPE;r price_matrix_import_profile_revisions%ROWTYPE;pid uuid;BEGIN
 PERFORM price_matrix_import_require(uid,kid,false);PERFORM pg_advisory_xact_lock(hashtextextended('price.matrix:'||t,0));
 SELECT * INTO r FROM price_matrix_import_profile_revisions WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid;
 IF FOUND THEN IF r.actor_id IS DISTINCT FROM uid OR r.api_key_id IS DISTINCT FROM kid OR r.request_hash IS DISTINCT FROM v->>'request_hash' THEN RETURN jsonb_build_object('state','conflict');END IF;RETURN jsonb_build_object('profile',r.snapshot,'reused',true);END IF;
 IF NOT price_matrix_import_targets(v->'targets') OR EXISTS(SELECT 1 FROM jsonb_array_elements(v->'targets')x(element) WHERE (SELECT count(*) FROM jsonb_object_keys(x.element))<>2 OR NOT EXISTS(SELECT 1 FROM price_lists WHERE (tenant_id,id)=(t,(x.element->>'price_list_id')::uuid))) THEN RAISE EXCEPTION 'Niepoprawny profil macierzy' USING ERRCODE='23514';END IF;pid:=(v->>'id')::uuid;
 SELECT * INTO p FROM price_matrix_import_profiles WHERE (tenant_id,id)=(t,pid) FOR UPDATE;
 IF v ? 'version' THEN IF p.id IS NULL OR p.version IS DISTINCT FROM (v->>'version')::integer OR p.version>=2147483647 THEN RETURN jsonb_build_object('state','conflict');END IF;
  UPDATE price_matrix_import_profiles SET name=v->>'name',targets=v->'targets',version=version+1,updated_at=clock_timestamp() WHERE (tenant_id,id)=(t,pid) RETURNING * INTO p;
 ELSE IF p.id IS NOT NULL THEN RETURN jsonb_build_object('state','conflict');END IF;
  INSERT INTO price_matrix_import_profiles(id,tenant_id,name,version,targets) VALUES(pid,t,v->>'name',1,v->'targets') RETURNING * INTO p;
 END IF;
 INSERT INTO price_matrix_import_profile_revisions(id,tenant_id,profile_id,version,actor_id,api_key_id,client_key,request_hash,snapshot) VALUES(gen_random_uuid(),t,p.id,p.version,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',to_jsonb(p)-'tenant_id');RETURN jsonb_build_object('profile',to_jsonb(p)-'tenant_id','reused',false);
END $$;
CREATE FUNCTION price_matrix_import_receipt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE link record;BEGIN
 IF to_regclass('public.price_matrix_import_targets') IS NULL THEN IF price_matrix_import_installed() THEN RAISE EXCEPTION 'Niekompletny moduł importu macierzy cen' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 SELECT * INTO link FROM price_matrix_import_targets WHERE (tenant_id,core_preview_id)=(NEW.tenant_id,NEW.preview_id);
 IF link.preview_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM price_matrix_import_executions e JOIN price_matrix_import_execution_targets et ON (et.tenant_id,et.execution_id,et.preview_id)=(e.tenant_id,e.id,e.preview_id) WHERE (e.tenant_id,e.preview_id,e.actor_id,et.price_list_id,et.core_execution_id)=(NEW.tenant_id,link.preview_id,NEW.actor_id,NEW.price_list_id,NEW.id)) THEN RAISE EXCEPTION 'Wykonanie cen wymaga pełnego wyniku macierzy' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER price_matrix_receipt AFTER INSERT ON price_bulk_edit_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION price_matrix_import_receipt();
CREATE FUNCTION price_matrix_import_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;p record;eid uuid;BEGIN
 IF nullif(current_setting('app.tenant_id',true),'')::uuid IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Obcy zakres macierzy cen' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='price_matrix_import_profiles' THEN
  IF NOT EXISTS(SELECT 1 FROM price_matrix_import_profile_revisions x JOIN price_matrix_import_profiles profile ON (profile.tenant_id,profile.id,profile.version)=(x.tenant_id,x.profile_id,x.version) WHERE (profile.tenant_id,profile.id)=(NEW.tenant_id,NEW.id) AND x.snapshot=to_jsonb(profile)-'tenant_id') THEN RAISE EXCEPTION 'Profil macierzy bez pełnej rewizji' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME IN('price_matrix_import_previews','price_matrix_import_targets') THEN
  SELECT * INTO p FROM price_matrix_import_previews WHERE (tenant_id,id)=(NEW.tenant_id,(to_jsonb(NEW)->>CASE WHEN TG_TABLE_NAME='price_matrix_import_previews' THEN 'id' ELSE 'preview_id' END)::uuid);
  IF (SELECT count(*) FROM price_matrix_import_targets WHERE (tenant_id,preview_id)=(p.tenant_id,p.id))<>jsonb_array_length(p.targets) OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.targets)x(element) WHERE NOT EXISTS(SELECT 1 FROM price_matrix_import_targets mt WHERE (mt.tenant_id,mt.preview_id,mt.price_list_id,mt.core_client_key)=(p.tenant_id,p.id,(x.element->>'price_list_id')::uuid,(x.element->>'core_client_key')::uuid) AND mt.core_preview_id IS NOT DISTINCT FROM (x.element->>'core_preview_id')::uuid)) THEN RAISE EXCEPTION 'Niepełne powiązania macierzy' USING ERRCODE='23514';END IF;
  PERFORM price_matrix_import_require(p.actor_id,p.api_key_id,true);
 ELSIF TG_TABLE_NAME IN('price_matrix_import_executions','price_matrix_import_execution_targets') THEN
  eid:=(to_jsonb(NEW)->>CASE WHEN TG_TABLE_NAME='price_matrix_import_executions' THEN 'id' ELSE 'execution_id' END)::uuid;
  SELECT actor_id,api_key_id INTO r FROM price_matrix_import_executions WHERE (tenant_id,id)=(NEW.tenant_id,eid);PERFORM price_matrix_import_execution_valid(eid);PERFORM price_matrix_import_require(r.actor_id,r.api_key_id,true);
 ELSE SELECT actor_id,api_key_id INTO r FROM price_matrix_import_profile_revisions WHERE (tenant_id,id)=(NEW.tenant_id,NEW.id);PERFORM price_matrix_import_require(r.actor_id,r.api_key_id,true);
 END IF;RETURN NEW;
END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['price_matrix_import_previews','price_matrix_import_targets','price_matrix_import_executions','price_matrix_import_execution_targets','price_matrix_import_profile_revisions'] LOOP
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION price_matrix_import_immutable()',t);
 EXECUTE format('CREATE TRIGGER budget AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION price_matrix_import_budget()',t);
 EXECUTE format('CREATE CONSTRAINT TRIGGER complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION price_matrix_import_complete()',t);
 END LOOP;
END $$;
CREATE TRIGGER no_delete BEFORE DELETE ON price_matrix_import_profiles FOR EACH ROW EXECUTE FUNCTION price_matrix_import_immutable();
CREATE CONSTRAINT TRIGGER complete AFTER INSERT OR UPDATE ON price_matrix_import_profiles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION price_matrix_import_complete();
CREATE FUNCTION price_matrix_import_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE new_value jsonb;old_value jsonb;new_t uuid;old_t uuid;BEGIN
 IF to_regclass('public.price_matrix_import_executions') IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END IF;
 IF TG_OP<>'DELETE' THEN new_value:=to_jsonb(NEW);new_t:=CASE WHEN TG_TABLE_NAME='tenants' THEN (new_value->>'id')::uuid ELSE (new_value->>'tenant_id')::uuid END;END IF;
 IF TG_OP<>'INSERT' THEN old_value:=to_jsonb(OLD);old_t:=CASE WHEN TG_TABLE_NAME='tenants' THEN (old_value->>'id')::uuid ELSE (old_value->>'tenant_id')::uuid END;END IF;
 IF EXISTS(SELECT 1 FROM price_matrix_import_executions e WHERE e.tenant_id IN(new_t,old_t) AND e.top_xid=pg_current_xact_id() AND e.transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Nie można zmienić źródeł cen po zatwierdzonym wykonaniu macierzy w tej transakcji' USING ERRCODE='23514';END IF;RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['products','product_sku_aliases','price_lists','price_list_items','tenants','repricing_rules','repricing_schedules','repricing_runs'] LOOP
 EXECUTE format('CREATE TRIGGER price_matrix_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION price_matrix_import_seal()',t);
END LOOP;END $$;
CREATE FUNCTION price_matrix_import_exclusive() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF to_regclass('public.price_matrix_import_targets') IS NULL OR to_regclass('public.price_matrix_import_execution_targets') IS NULL THEN IF price_matrix_import_installed() THEN RAISE EXCEPTION 'Niekompletny moduł importu macierzy cen' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 IF TG_TABLE_NAME='price_file_import_previews' THEN
  IF EXISTS(SELECT 1 FROM price_matrix_import_targets mt WHERE (mt.tenant_id,mt.core_preview_id)=(NEW.tenant_id,(to_jsonb(NEW)->>'core_preview_id')::uuid)) THEN RAISE EXCEPTION 'Silnik macierzy nie może być podglądem pojedynczego pliku' USING ERRCODE='23514';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM price_matrix_import_execution_targets mt WHERE (mt.tenant_id,mt.core_execution_id)=(NEW.tenant_id,(to_jsonb(NEW)->>'core_execution_id')::uuid)) THEN RAISE EXCEPTION 'Wynik macierzy nie może być wykonaniem pojedynczego pliku' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER price_matrix_exclusive BEFORE INSERT ON price_file_import_previews FOR EACH ROW EXECUTE FUNCTION price_matrix_import_exclusive();
CREATE TRIGGER price_matrix_exclusive BEFORE INSERT ON price_file_import_executions FOR EACH ROW EXECUTE FUNCTION price_matrix_import_exclusive();
DO $$ DECLARE r record;BEGIN FOR r IN SELECT oid::regprocedure p FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'price_matrix_import_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',r.p);END LOOP;END $$;
GRANT EXECUTE ON FUNCTION price_matrix_import_installed(),price_matrix_import_access(uuid,uuid,boolean,boolean),price_matrix_import_store_preview(jsonb,uuid,uuid),price_matrix_import_store_execution(jsonb,uuid,uuid),price_matrix_import_store_profile(jsonb,uuid,uuid),price_matrix_import_prepare_execution(uuid,uuid,uuid) TO dyna_app;
