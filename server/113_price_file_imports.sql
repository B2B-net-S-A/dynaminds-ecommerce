-- File evidence is distinct from 087 price edit evidence. No historical rows or hashes change.
CREATE TABLE price_file_import_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),
 price_list_id uuid NOT NULL,file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 120),source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),source text NOT NULL CHECK(source IN('manual','api')),
 definition jsonb NOT NULL,list_snapshot jsonb NOT NULL,warnings jsonb NOT NULL,summary jsonb NOT NULL,rows jsonb NOT NULL CHECK(jsonb_typeof(rows)='array' AND jsonb_array_length(rows)>=1 AND jsonb_array_length(rows)<=500),core_preview_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,core_preview_id),
 FOREIGN KEY(tenant_id,price_list_id) REFERENCES price_lists(tenant_id,id),FOREIGN KEY(tenant_id,core_preview_id) REFERENCES price_bulk_edit_previews(tenant_id,id)
);
CREATE TABLE price_file_import_executions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),core_execution_id uuid NOT NULL,ack_missing_prices boolean NOT NULL,top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,core_execution_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES price_file_import_previews(tenant_id,id),FOREIGN KEY(tenant_id,core_execution_id) REFERENCES price_bulk_edit_executions(tenant_id,id)
);
CREATE TABLE price_file_import_profiles (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),version integer NOT NULL CHECK(version>0),price_list_id uuid,definition jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,price_list_id) REFERENCES price_lists(tenant_id,id)
);
CREATE TABLE price_file_import_profile_revisions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,profile_id uuid NOT NULL,version integer NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,profile_id,version),FOREIGN KEY(tenant_id,profile_id) REFERENCES price_file_import_profiles(tenant_id,id)
);
CREATE TABLE price_file_import_core_witnesses (
 tenant_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('preview','execution')),id uuid NOT NULL,top_xid xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,kind,id)
);
CREATE INDEX price_file_import_preview_history ON price_file_import_previews(tenant_id,created_at DESC,id DESC);
CREATE INDEX price_file_import_execution_history ON price_file_import_executions(tenant_id,created_at DESC,id DESC);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['price_file_import_previews','price_file_import_executions','price_file_import_profiles','price_file_import_profile_revisions','price_file_import_core_witnesses'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 IF t<>'price_file_import_core_witnesses' THEN EXECUTE format('GRANT SELECT ON %I TO dyna_app',t);END IF;
END LOOP;END $$;
CREATE FUNCTION price_file_import_access(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r text;k record;valid boolean:=true;allowed boolean;canwrite boolean;
BEGIN
 IF t IS NULL OR uid IS NULL THEN RETURN jsonb_build_object('role',null,'allowed',false);END IF;
 IF pin THEN SELECT role INTO r FROM memberships WHERE tenant_id=t AND user_id=uid FOR SHARE;ELSE SELECT role INTO r FROM memberships WHERE tenant_id=t AND user_id=uid;END IF;
 allowed:=coalesce(r IN('admin','operator','viewer'),false);canwrite:=r='admin';
 IF kid IS NOT NULL THEN
  IF pin THEN SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid FOR SHARE;ELSE SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid;END IF;
  valid:=FOUND AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp());
  allowed:=allowed AND valid AND coalesce(k.scopes @> ARRAY['products:read']::text[],false);canwrite:=canwrite AND allowed AND coalesce(k.scopes @> ARRAY['products:write']::text[],false);
 END IF;
 RETURN jsonb_build_object('role',r,'key_valid',valid,'allowed',allowed AND (NOT writing OR canwrite),'can_write',canwrite);
END $$;
CREATE FUNCTION price_file_import_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT EXISTS(SELECT 1 FROM migrations WHERE name='113_price_file_imports') $$;
CREATE FUNCTION price_file_import_require(uid uuid,kid uuid,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF (price_file_import_access(uid,kid,true,pin)->>'key_valid')::boolean IS FALSE THEN RAISE EXCEPTION 'Wycofany klucz importu cen' USING ERRCODE='23514';END IF;
 IF (price_file_import_access(uid,kid,true,pin)->>'allowed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'Brak aktualnej zgody na import cen' USING ERRCODE='23514';END IF;END $$;
CREATE FUNCTION price_file_import_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'Historia importu cen jest niezmienna' USING ERRCODE='23514';END $$;
CREATE FUNCTION price_file_import_core_witness() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF to_regclass('public.price_file_import_core_witnesses') IS NULL THEN RETURN NEW;END IF;
 IF TG_WHEN='AFTER' AND TG_ARGV[0]='cleanup' THEN
  DELETE FROM price_file_import_core_witnesses WHERE (tenant_id,kind,id)=(NEW.tenant_id,CASE WHEN TG_TABLE_NAME='price_bulk_edit_previews' THEN 'preview' ELSE 'execution' END,NEW.id);RETURN NEW;
 END IF;
 INSERT INTO price_file_import_core_witnesses VALUES(NEW.tenant_id,CASE WHEN TG_TABLE_NAME='price_bulk_edit_previews' THEN 'preview' ELSE 'execution' END,NEW.id,pg_current_xact_id(),transaction_timestamp());RETURN NEW;
END $$;
CREATE TRIGGER price_file_witness AFTER INSERT ON price_bulk_edit_previews FOR EACH ROW EXECUTE FUNCTION price_file_import_core_witness();
CREATE TRIGGER price_file_witness AFTER INSERT ON price_bulk_edit_executions FOR EACH ROW EXECUTE FUNCTION price_file_import_core_witness();
CREATE CONSTRAINT TRIGGER price_file_witness_cleanup AFTER INSERT ON price_bulk_edit_previews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION price_file_import_core_witness('cleanup');
CREATE CONSTRAINT TRIGGER price_file_witness_cleanup AFTER INSERT ON price_bulk_edit_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION price_file_import_core_witness('cleanup');
CREATE FUNCTION price_file_import_definition(d jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
SELECT coalesce(jsonb_typeof(d)='object' AND (SELECT count(*)=10 FROM jsonb_object_keys(d)) AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN('format','delimiter','identity','mapping','amount_mode','decimal_separator','basis','empty_policy','spreadsheet_safe','native_price_mode')) AND d->>'format' IN('csv','xml') AND d->>'delimiter' IN(';',',',E'\t') AND d->>'identity' IN('uuid','sku','historical_sku','ean','name') AND jsonb_typeof(d->'mapping')='object' AND NOT EXISTS(SELECT 1 FROM jsonb_each(d->'mapping') m WHERE m.key NOT IN('identity','price','operation','currency') OR jsonb_typeof(m.value)<>'string' OR length(m.value#>>'{}') NOT BETWEEN 1 AND 80) AND (SELECT count(DISTINCT value)=count(*) FROM jsonb_each(d->'mapping')) AND length(d->'mapping'->>'identity')>0 AND length(d->'mapping'->>'price')>0 AND d->>'amount_mode' IN('minor','decimal') AND d->>'decimal_separator' IN('.',',') AND d->>'basis' IN('gross','net') AND d->>'empty_policy' IN('skip','remove') AND jsonb_typeof(d->'spreadsheet_safe')='boolean' AND d->>'native_price_mode' IN('mapped','own_entries') AND (d->>'native_price_mode'<>'own_entries' OR (d->>'format'='xml' AND d->'mapping'->>'price'='prices_json')),false)
$$;
CREATE FUNCTION price_file_import_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n bigint;b bigint;t uuid:=NEW.tenant_id;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('price.file:'||t,0));
 SELECT count(*),coalesce(sum(octet_length(to_jsonb(p)::text)),0) INTO n,b FROM price_file_import_previews p WHERE tenant_id=t;
 IF n>2000 THEN RAISE EXCEPTION 'Limit historii importu cen' USING ERRCODE='P0001';END IF;
 SELECT b+coalesce(sum(octet_length(to_jsonb(e)::text)),0) INTO b FROM price_file_import_executions e WHERE tenant_id=t;
 SELECT b+coalesce(sum(octet_length(to_jsonb(r)::text)),0) INTO b FROM price_file_import_profile_revisions r WHERE tenant_id=t;
 IF (SELECT count(*) FROM price_file_import_profile_revisions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit rewizji profili importu cen' USING ERRCODE='P0001';END IF;
 IF b>134217728 THEN RAISE EXCEPTION 'Limit bajtów historii importu cen' USING ERRCODE='P0001';END IF;
 IF (SELECT count(*) FROM price_file_import_profiles WHERE tenant_id=t)>100 THEN RAISE EXCEPTION 'Limit profili importu cen' USING ERRCODE='P0001';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION price_file_import_cell(v jsonb,safe boolean,identity text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE txt text;original text;BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR NOT safe THEN RETURN v;END IF;txt:=v#>>'{}';
 IF left(txt,1)<>chr(39) THEN RETURN v;END IF;original:=substr(txt,2);
 IF identity IN('uuid','sku','historical_sku','ean') OR original ~ '^[[:space:]]*[=+@-]' OR original ~ E'^[\\t\\r\\n]' OR original ~ '^[[:space:]]*[+-]?[0-9]+([.,][0-9]+)?([eE][+-]?[0-9]+)?[[:space:]]*$' THEN RETURN to_jsonb(original);END IF;RETURN v;
END $$;
CREATE FUNCTION price_file_import_snapshot(l jsonb,p jsonb,present boolean,override_price integer) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE effective bigint:=NULL;src text:='missing';issue text:=NULL;BEGIN
 IF p->>'kind'='group' THEN issue:='non_sellable_group';
 ELSIF present THEN src:='override';effective:=override_price;
 ELSIF NOT (l->>'fallback')::boolean OR l->>'currency' IS DISTINCT FROM l->>'catalog_currency' THEN issue:='missing_override';
 ELSE effective:=((p->>'price')::bigint*(10000+(l->>'adjustment_bps')::bigint)+5000)/10000+(l->>'adjustment_amount')::bigint;
  IF effective<0 OR effective>100000000 THEN effective:=NULL;issue:='invalid_fallback';ELSE src:='rule';END IF;
 END IF;
 RETURN jsonb_build_object('currency',l->>'currency','vat',(p->>'vat')::integer,'catalog_price',(p->>'price')::integer,'override_present',present,'override_price',CASE WHEN present THEN override_price ELSE NULL END,'effective_price',effective,'source',src,'issue',issue);
END $$;
CREATE FUNCTION price_file_import_store_preview(v jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p price_bulk_edit_previews%ROWTYPE; r jsonb;cr price_bulk_edit_rows%ROWTYPE;prod products%ROWTYPE;amount numeric;raw_amount jsonb;raw_operation jsonb;entry jsonb;raw_identity jsonb;raw_currency jsonb;safe boolean;present boolean;override_value integer;after_present boolean;after_value integer;live_list jsonb;value text;ident text;matches integer;candidate uuid;op text;i integer:=0;clean integer:=0;invalid integer:=0;changed integer:=0;unchanged integer:=0;conflicts integer:=0;missing integer:=0;
BEGIN
 PERFORM price_file_import_require(uid,kid,false);PERFORM pg_advisory_xact_lock(hashtextextended('price.file:'||t,0));
 IF octet_length(v::text)>8388608 OR NOT price_file_import_definition(v->'definition') OR jsonb_typeof(v->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'rows') NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Niepoprawny pełny podgląd pliku' USING ERRCODE='23514';END IF;
 IF v->>'core_preview_id' IS NOT NULL THEN
  SELECT * INTO p FROM price_bulk_edit_previews WHERE (tenant_id,id)=(t,(v->>'core_preview_id')::uuid);
  IF p.id IS NULL OR p.actor_id IS DISTINCT FROM uid OR p.client_key IS DISTINCT FROM (v->>'id')::uuid OR p.price_list_id IS DISTINCT FROM (v->>'price_list_id')::uuid OR p.source IS DISTINCT FROM v->>'source' OR p.list_snapshot IS DISTINCT FROM v->'list_snapshot' OR p.warnings IS DISTINCT FROM v->'warnings' OR NOT EXISTS(SELECT 1 FROM price_file_import_core_witnesses w WHERE (w.tenant_id,w.kind,w.id,w.top_xid,w.transaction_started_at)=(t,'preview',p.id,pg_current_xact_id(),transaction_timestamp())) THEN RAISE EXCEPTION 'Podgląd pliku nie ma własnego nowego zakresu cen' USING ERRCODE='23514';END IF;
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
 INSERT INTO price_file_import_previews(id,tenant_id,actor_id,api_key_id,client_key,request_hash,scope_hash,price_list_id,file_name,source_hash,source,definition,list_snapshot,warnings,summary,rows,core_preview_id) VALUES((v->>'id')::uuid,t,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',v->>'scope_hash',(v->>'price_list_id')::uuid,v->>'file_name',v->>'source_hash',v->>'source',v->'definition',v->'list_snapshot',v->'warnings',v->'summary',v->'rows',(v->>'core_preview_id')::uuid);
 RETURN (v->>'id')::uuid;
END $$;
CREATE FUNCTION price_file_import_execution_valid(eid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e price_file_import_executions%ROWTYPE;p price_file_import_previews%ROWTYPE;ce price_bulk_edit_executions%ROWTYPE;r jsonb;prod products%ROWTYPE;l jsonb;present boolean;override_value integer;BEGIN
 SELECT * INTO e FROM price_file_import_executions WHERE id=eid AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 SELECT * INTO p FROM price_file_import_previews WHERE (tenant_id,id)=(e.tenant_id,e.preview_id);
 SELECT * INTO ce FROM price_bulk_edit_executions WHERE (tenant_id,id)=(e.tenant_id,e.core_execution_id);
 IF e.id IS NULL OR p.id IS NULL OR ce.id IS NULL OR ROW(ce.preview_id,ce.actor_id,ce.price_list_id,ce.total,ce.changed,ce.unchanged,ce.missing_after_count,ce.ack_missing_prices) IS DISTINCT FROM ROW(p.core_preview_id,p.actor_id,p.price_list_id,(p.summary->>'total')::integer,(p.summary->>'changed')::integer,(p.summary->>'unchanged')::integer,(p.summary->>'missing_after_count')::integer,e.ack_missing_prices) OR (SELECT count(*) FROM price_bulk_edit_execution_rows WHERE (tenant_id,execution_id)=(e.tenant_id,ce.id))<>ce.total THEN RAISE EXCEPTION 'Niepełny rzeczywisty wynik importu cen' USING ERRCODE='23514';END IF;
 SELECT to_jsonb(pl)||jsonb_build_object('catalog_currency',tt.currency) INTO l FROM price_lists pl JOIN tenants tt ON tt.id=pl.tenant_id WHERE (pl.tenant_id,pl.id)=(e.tenant_id,p.price_list_id);
 IF (l->>'version')::integer IS DISTINCT FROM ce.after_list_version THEN RAISE EXCEPTION 'Zmieniona końcowa wersja importu cen' USING ERRCODE='23514';END IF;
 FOR r IN SELECT source_row.element FROM jsonb_array_elements(p.rows) AS source_row(element) LOOP
  SELECT * INTO prod FROM products WHERE (tenant_id,id)=(e.tenant_id,(r->>'product_id')::uuid);
  SELECT price INTO override_value FROM price_list_items WHERE (tenant_id,price_list_id,product_id)=(e.tenant_id,p.price_list_id,prod.id);present:=FOUND;
  IF prod.id IS NULL OR prod.version IS DISTINCT FROM (r->'input'->>'product_version')::integer OR r->'after' IS DISTINCT FROM price_file_import_snapshot(l,to_jsonb(prod),present,override_value) THEN RAISE EXCEPTION 'Rzeczywista cena odbiega od pełnej zgody pliku' USING ERRCODE='23514';END IF;
 END LOOP;
END $$;
CREATE FUNCTION price_file_import_store_execution(v jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p price_file_import_previews%ROWTYPE;e price_bulk_edit_executions%ROWTYPE;BEGIN
 PERFORM price_file_import_require(uid,kid,false);SELECT * INTO p FROM price_file_import_previews WHERE (tenant_id,id)=(t,(v->>'preview_id')::uuid);
 SELECT * INTO e FROM price_bulk_edit_executions WHERE (tenant_id,id)=(t,(v->>'core_execution_id')::uuid);
 IF p.id IS NULL OR (p.summary->>'ready')::boolean IS NOT TRUE OR p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid OR p.scope_hash IS DISTINCT FROM v->>'scope_hash' OR ROW(e.preview_id,e.actor_id,e.price_list_id,e.ack_missing_prices) IS DISTINCT FROM ROW(p.core_preview_id,uid,p.price_list_id,(v->>'ack_missing_prices')::boolean) OR NOT EXISTS(SELECT 1 FROM price_file_import_core_witnesses w WHERE (w.tenant_id,w.kind,w.id,w.top_xid,w.transaction_started_at)=(t,'execution',e.id,pg_current_xact_id(),transaction_timestamp())) THEN RAISE EXCEPTION 'Wykonanie pliku nie ma zatwierdzonego wyniku cen' USING ERRCODE='23514';END IF;
 INSERT INTO price_file_import_executions(id,tenant_id,preview_id,actor_id,api_key_id,client_key,request_hash,scope_hash,core_execution_id,ack_missing_prices) VALUES((v->>'id')::uuid,t,p.id,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',p.scope_hash,e.id,e.ack_missing_prices);PERFORM price_file_import_execution_valid((v->>'id')::uuid);RETURN (v->>'id')::uuid;
END $$;
CREATE FUNCTION price_file_import_store_profile(v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p price_file_import_profiles%ROWTYPE;r price_file_import_profile_revisions%ROWTYPE;pid uuid;BEGIN
 PERFORM price_file_import_require(uid,kid,false);PERFORM pg_advisory_xact_lock(hashtextextended('price.file:'||t,0));
 SELECT * INTO r FROM price_file_import_profile_revisions WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid;
 IF FOUND THEN IF r.actor_id IS DISTINCT FROM uid OR r.api_key_id IS DISTINCT FROM kid OR r.request_hash IS DISTINCT FROM v->>'request_hash' THEN RETURN jsonb_build_object('state','conflict');END IF;RETURN jsonb_build_object('profile',r.snapshot,'reused',true);END IF;
 IF NOT price_file_import_definition(v->'definition') THEN RAISE EXCEPTION 'Niepoprawny profil cen' USING ERRCODE='23514';END IF;pid:=(v->>'id')::uuid;
 SELECT * INTO p FROM price_file_import_profiles WHERE (tenant_id,id)=(t,pid) FOR UPDATE;
 IF v ? 'version' THEN IF p.id IS NULL OR p.version IS DISTINCT FROM (v->>'version')::integer OR p.version>=2147483647 THEN RETURN jsonb_build_object('state','conflict');END IF;
  UPDATE price_file_import_profiles SET name=v->>'name',definition=v->'definition',price_list_id=(v->>'price_list_id')::uuid,version=version+1,updated_at=clock_timestamp() WHERE (tenant_id,id)=(t,pid) RETURNING * INTO p;
 ELSE IF p.id IS NOT NULL THEN RETURN jsonb_build_object('state','conflict');END IF;
  INSERT INTO price_file_import_profiles(id,tenant_id,name,version,price_list_id,definition) VALUES(pid,t,v->>'name',1,(v->>'price_list_id')::uuid,v->'definition') RETURNING * INTO p;
 END IF;
 INSERT INTO price_file_import_profile_revisions(id,tenant_id,profile_id,version,actor_id,api_key_id,client_key,request_hash,snapshot) VALUES(gen_random_uuid(),t,p.id,p.version,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',to_jsonb(p)-'tenant_id');
 RETURN jsonb_build_object('profile',to_jsonb(p)-'tenant_id','reused',false);
END $$;
CREATE FUNCTION price_file_import_receipt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p record;BEGIN
 IF to_regclass('public.price_file_import_previews') IS NULL THEN IF price_file_import_installed() THEN RAISE EXCEPTION 'Niekompletny moduł importu pliku cen' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 SELECT * INTO p FROM price_file_import_previews WHERE (tenant_id,core_preview_id)=(NEW.tenant_id,NEW.preview_id);
 IF p.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM price_file_import_executions e WHERE (e.tenant_id,e.preview_id,e.core_execution_id,e.actor_id,e.scope_hash)=(NEW.tenant_id,p.id,NEW.id,NEW.actor_id,p.scope_hash)) THEN RAISE EXCEPTION 'Wykonanie cen wymaga pełnej zgody na plik' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER price_file_receipt AFTER INSERT ON price_bulk_edit_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION price_file_import_receipt();
CREATE FUNCTION price_file_import_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;BEGIN
 IF TG_TABLE_NAME='price_file_import_profiles' THEN
  IF NOT EXISTS(SELECT 1 FROM price_file_import_profile_revisions x JOIN price_file_import_profiles p ON (p.tenant_id,p.id,p.version)=(x.tenant_id,x.profile_id,x.version) WHERE (p.tenant_id,p.id)=(NEW.tenant_id,NEW.id) AND x.snapshot=to_jsonb(p)-'tenant_id') THEN RAISE EXCEPTION 'Profil bez pełnej rewizji' USING ERRCODE='23514';END IF;
 ELSE
  IF TG_TABLE_NAME='price_file_import_previews' THEN SELECT actor_id,api_key_id INTO r FROM price_file_import_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.id);
  ELSIF TG_TABLE_NAME='price_file_import_executions' THEN SELECT actor_id,api_key_id INTO r FROM price_file_import_executions WHERE (tenant_id,id)=(NEW.tenant_id,NEW.id);PERFORM price_file_import_execution_valid(NEW.id);
  ELSE SELECT actor_id,api_key_id INTO r FROM price_file_import_profile_revisions WHERE (tenant_id,id)=(NEW.tenant_id,NEW.id);END IF;
  IF nullif(current_setting('app.tenant_id',true),'')::uuid IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Obcy zakres importu cen' USING ERRCODE='23514';END IF;PERFORM price_file_import_require(r.actor_id,r.api_key_id,true);
 END IF;RETURN NEW;
END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['price_file_import_previews','price_file_import_executions','price_file_import_profile_revisions'] LOOP
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION price_file_import_immutable()',t);
 EXECUTE format('CREATE TRIGGER budget AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION price_file_import_budget()',t);
 EXECUTE format('CREATE CONSTRAINT TRIGGER complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION price_file_import_complete()',t);
 END LOOP;
END $$;
CREATE TRIGGER no_delete BEFORE DELETE ON price_file_import_profiles FOR EACH ROW EXECUTE FUNCTION price_file_import_immutable();
CREATE CONSTRAINT TRIGGER complete AFTER INSERT OR UPDATE ON price_file_import_profiles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION price_file_import_complete();
CREATE FUNCTION price_file_import_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE row_value jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;t uuid;BEGIN
 IF to_regclass('public.price_file_import_executions') IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END IF;
 t:=CASE WHEN TG_TABLE_NAME='tenants' THEN (row_value->>'id')::uuid ELSE (row_value->>'tenant_id')::uuid END;
 IF EXISTS(SELECT 1 FROM price_file_import_executions e WHERE e.tenant_id=t AND e.top_xid=pg_current_xact_id() AND e.transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Nie można zmienić źródeł cen po zatwierdzonym wykonaniu pliku w tej transakcji' USING ERRCODE='23514';END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['products','product_sku_aliases','price_lists','price_list_items','tenants','repricing_rules','repricing_schedules','repricing_runs'] LOOP
 IF to_regclass('public.'||t) IS NOT NULL THEN EXECUTE format('CREATE TRIGGER price_file_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION price_file_import_seal()',t);END IF;
END LOOP;END $$;
-- Only typed writers are callable; no app INSERT/UPDATE permission is granted.
DO $$ DECLARE r record;BEGIN FOR r IN SELECT oid::regprocedure p FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'price_file_import_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',r.p);END LOOP;END $$;
GRANT EXECUTE ON FUNCTION price_file_import_installed(),price_file_import_access(uuid,uuid,boolean,boolean),price_file_import_store_preview(jsonb,uuid,uuid),price_file_import_store_execution(jsonb,uuid,uuid),price_file_import_store_profile(jsonb,uuid,uuid) TO dyna_app;
