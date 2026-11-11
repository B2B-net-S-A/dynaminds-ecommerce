-- Native local proformas. Existing invoice/correction rows are not rewritten.
ALTER TABLE documents DROP CONSTRAINT documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check CHECK(kind IN('invoice','correction','proforma'));
ALTER TABLE documents ADD CONSTRAINT documents_proforma_local CHECK((kind='proforma')=(mode='local') AND(kind<>'proforma' OR(channel_id IS NULL AND external_id IS NULL AND return_id IS NULL)));

CREATE TABLE proforma_series(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,
 name text NOT NULL,prefix text NOT NULL,definition jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,prefix),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),CHECK(request_hash~'^[a-f0-9]{64}$')
);
CREATE TABLE proforma_series_commands(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants,series_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,series_id),
 FOREIGN KEY(tenant_id,series_id) REFERENCES proforma_series(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE proforma_previews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants,order_id uuid NOT NULL,series_id uuid NOT NULL,
 order_version bigint NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,
 request jsonb NOT NULL,scope_hash text NOT NULL,snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,series_id) REFERENCES proforma_series(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK(request_hash~'^[a-f0-9]{64}$' AND scope_hash~'^[a-f0-9]{64}$'),CHECK(octet_length(snapshot::text)<=1048576)
);
CREATE TABLE proforma_counters(
 tenant_id uuid NOT NULL,series_id uuid NOT NULL,year integer NOT NULL CHECK(year BETWEEN 1900 AND 9999),
 last_number integer NOT NULL CHECK(last_number BETWEEN 0 AND 999999),PRIMARY KEY(tenant_id,series_id,year),
 FOREIGN KEY(tenant_id,series_id) REFERENCES proforma_series(tenant_id,id)
);
CREATE TABLE proforma_receipts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,document_id uuid NOT NULL,preview_id uuid NOT NULL,order_id uuid NOT NULL,series_id uuid NOT NULL,
 year integer NOT NULL CHECK(year BETWEEN 1900 AND 9999),sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 999999),number text NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,scope_hash text NOT NULL,snapshot jsonb NOT NULL,
 top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,order_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,number),UNIQUE(tenant_id,series_id,year,sequence),
 FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id),FOREIGN KEY(tenant_id,preview_id) REFERENCES proforma_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,series_id) REFERENCES proforma_series(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE proforma_admissions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,document_id uuid NOT NULL,preview_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,
 year integer NOT NULL,sequence integer NOT NULL,top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id),FOREIGN KEY(tenant_id,preview_id) REFERENCES proforma_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,id) REFERENCES proforma_receipts(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX proforma_series_page ON proforma_series(tenant_id,created_at DESC,id DESC);
CREATE INDEX proforma_previews_order ON proforma_previews(tenant_id,order_id,created_at DESC,id DESC);
CREATE INDEX proforma_receipts_order ON proforma_receipts(tenant_id,order_id);
CREATE INDEX proforma_admissions_tx ON proforma_admissions(tenant_id,top_xid,transaction_started_at);
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['proforma_series','proforma_series_commands','proforma_previews','proforma_counters','proforma_receipts','proforma_admissions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY owner ON %I TO CURRENT_USER USING(true) WITH CHECK(true)',tab);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',tab);
 IF tab<>'proforma_admissions' THEN EXECUTE format('GRANT SELECT ON %I TO dyna_app',tab);END IF;
 END LOOP;
END$$;

CREATE FUNCTION proforma_installed() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT 1 FROM migrations WHERE name='127_proformas')$$;
CREATE FUNCTION proforma_access(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;member_role text;k api_keys%ROWTYPE;key_valid boolean:=true;allowed boolean;BEGIN
 IF pin THEN SELECT role INTO member_role FROM memberships WHERE(tenant_id,user_id)=(t,uid) FOR SHARE;
 ELSE SELECT role INTO member_role FROM memberships WHERE(tenant_id,user_id)=(t,uid);END IF;
 allowed:=member_role IN('admin','operator','viewer') AND(NOT writing OR member_role IN('admin','operator'));
 IF kid IS NOT NULL THEN
 IF pin THEN SELECT * INTO k FROM api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid) FOR SHARE;
 ELSE SELECT * INTO k FROM api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid);END IF;
 key_valid:=k.id IS NOT NULL AND k.revoked_at IS NULL AND(k.expires_at IS NULL OR k.expires_at>clock_timestamp());
 allowed:=allowed AND key_valid AND coalesce(k.scopes@>ARRAY['documents:read','orders:read']::text[],false)
 AND(NOT writing OR coalesce(k.scopes@>ARRAY['documents:write']::text[],false));
 END IF;
 RETURN jsonb_build_object('role',member_role,'key_valid',key_valid,'allowed',coalesce(allowed,false));
END$$;
CREATE FUNCTION proforma_require(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE g jsonb;BEGIN
 g:=proforma_access(uid,kid,writing,pin);
 IF g->>'key_valid' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Klucz proformy jest wycofany lub wygasł' USING ERRCODE='23514';END IF;
 IF g->>'allowed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Brak aktualnych uprawnień do proformy' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION proforma_locks() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('proforma:'||current_setting('app.tenant_id',true),0));
 PERFORM pg_advisory_xact_lock(hashtextextended('order.merge.proof:'||current_setting('app.tenant_id',true),0));
END$$;
CREATE FUNCTION proforma_canonical(v jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$DECLARE result text;BEGIN
 IF jsonb_typeof(v)='object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(k)::text||':'||proforma_canonical(val),',' ORDER BY k COLLATE "C"),'')||'}' INTO result FROM jsonb_each(v) obj(k,val);
 ELSIF jsonb_typeof(v)='array' THEN SELECT '['||coalesce(string_agg(proforma_canonical(val),',' ORDER BY n),'')||']' INTO result FROM jsonb_array_elements(v) WITH ORDINALITY arr(val,n);
 ELSE result:=v::text;END IF;RETURN result;
END$$;
CREATE FUNCTION proforma_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT encode(sha256(convert_to(v::text,'UTF8')),'hex')$$;
CREATE FUNCTION proforma_request_hash(kind text,parent uuid,body jsonb,uid uuid,kid uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(proforma_canonical(jsonb_build_object('tenant_id',nullif(current_setting('app.tenant_id',true),''),'actor_id',uid,'api_key_id',kid,'kind',kind,'parent_id',parent,'request',body)),'UTF8')),'hex')
$$;
CREATE FUNCTION proforma_text(v jsonb,minlen integer,maxlen integer) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_typeof(v)='string' AND length(v#>>'{}') BETWEEN minlen AND maxlen AND(v#>>'{}')=btrim(v#>>'{}') AND(v#>>'{}')!~'[[:cntrl:]]' AND(v#>>'{}')!~U&'[\0080-\009f]'
$$;
CREATE FUNCTION proforma_definition(body jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$DECLARE s jsonb;BEGIN
 s:=body->'seller';RETURN (jsonb_typeof(body)='object' AND body-ARRAY['client_key','name','prefix','seller','payment_terms_days','payment_instructions','notes']='{}'
 AND proforma_text(body->'name',1,120) AND jsonb_typeof(body->'prefix')='string' AND body->>'prefix'~'^[A-Z0-9][A-Z0-9-]{0,11}$'
 AND jsonb_typeof(body->'payment_terms_days')='number' AND body->>'payment_terms_days'~'^[0-9]+$' AND(body->>'payment_terms_days')::bigint BETWEEN 0 AND 365
 AND proforma_text(body->'payment_instructions',0,2000) AND proforma_text(body->'notes',0,2000)
 AND jsonb_typeof(s)='object' AND s-ARRAY['name','street','postal_code','city','country','tax_id']='{}'
 AND proforma_text(s->'name',1,200) AND proforma_text(s->'street',1,200) AND proforma_text(s->'postal_code',1,30) AND proforma_text(s->'city',1,100)
 AND jsonb_typeof(s->'country')='string' AND s->>'country'~'^[A-Z]{2}$' AND(NOT(s?'tax_id') OR proforma_text(s->'tax_id',1,40))) IS TRUE;
END$$;
CREATE FUNCTION proforma_budget(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE bytes bigint;BEGIN
 IF(SELECT count(*) FROM proforma_series WHERE tenant_id=t)>100 OR(SELECT count(*) FROM proforma_previews WHERE tenant_id=t)>2000 OR(SELECT count(*) FROM proforma_receipts WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit historii proform' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(octet_length(r::text)),0) INTO bytes FROM(
 SELECT to_jsonb(x) r FROM proforma_series x WHERE tenant_id=t UNION ALL SELECT to_jsonb(x) FROM proforma_series_commands x WHERE tenant_id=t
 UNION ALL SELECT to_jsonb(x) FROM proforma_previews x WHERE tenant_id=t UNION ALL SELECT to_jsonb(x) FROM proforma_receipts x WHERE tenant_id=t
 UNION ALL SELECT to_jsonb(x) FROM proforma_admissions x WHERE tenant_id=t UNION ALL SELECT d.data FROM documents d WHERE tenant_id=t AND kind='proforma') history;
 IF bytes>67108864 THEN RAISE EXCEPTION 'Limit historii proform' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION proforma_frame(oid uuid,sid uuid,shipping_vat integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;o orders%ROWTYPE;s proforma_series%ROWTYPE;i record;lines jsonb:='[]';gross bigint;net bigint;sumgross bigint:=0;sumnet bigint:=0;issuedate date:=(clock_timestamp() AT TIME ZONE 'UTC')::date;buyer_address jsonb;BEGIN
 SELECT * INTO o FROM orders WHERE(tenant_id,id)=(t,oid) FOR UPDATE;
 IF o.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego zamówienia' USING ERRCODE='P0002';END IF;
 SELECT * INTO s FROM proforma_series WHERE(tenant_id,id)=(t,sid) FOR UPDATE;
 IF s.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnej serii proform' USING ERRCODE='P0002';END IF;
 IF o.fulfillment_kind IS DISTINCT FROM 'sale' OR o.status IN('cancelled','return_initiated','return_received','return_completed')
 OR EXISTS(SELECT 1 FROM order_merge_claims mc WHERE(mc.tenant_id,mc.source_order_id)=(t,oid))
 OR EXISTS(SELECT 1 FROM return_cases rc WHERE(rc.tenant_id,rc.order_id)=(t,oid))
 OR EXISTS(SELECT 1 FROM documents d WHERE(d.tenant_id,d.order_id,d.kind)=(t,oid,'correction')) THEN RAISE EXCEPTION 'Zamówienie nie jest obsługiwaną sprzedażą dla proformy' USING ERRCODE='23514';END IF;
 IF o.source='b2b' OR EXISTS(SELECT 1 FROM b2b_dropship_orders b WHERE(b.tenant_id,b.customer_order_id)=(t,oid) OR(b.supplier_tenant_id,b.supplier_order_id)=(t,oid)) THEN RAISE EXCEPTION 'Proforma B2B wymaga osobnego potwierdzenia bill-to' USING ERRCODE='23514';END IF;
 IF o.currency NOT IN('PLN','EUR','USD','GBP','CZK') OR shipping_vat IS NULL OR shipping_vat NOT BETWEEN 0 AND 100 OR o.shipping_cost<0 OR o.total<0 THEN RAISE EXCEPTION 'Niepoprawne pieniądze proformy' USING ERRCODE='23514';END IF;
 buyer_address:=jsonb_build_object('street',o.address->>'street','postal_code',o.address->>'postal_code','city',o.address->>'city','country',o.address->>'country');
 IF(proforma_text(to_jsonb(o.customer_name),1,200) AND proforma_text(buyer_address->'street',1,200) AND proforma_text(buyer_address->'postal_code',1,30) AND proforma_text(buyer_address->'city',1,100)
 AND jsonb_typeof(buyer_address->'country')='string' AND buyer_address->>'country'~'^[A-Z]{2}$') IS NOT TRUE THEN RAISE EXCEPTION 'Uzupełnij historyczne dane nabywcy zamówienia' USING ERRCODE='23514';END IF;
 IF(SELECT count(*) FROM order_items WHERE(tenant_id,order_id)=(t,oid)) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Niepełne pozycje proformy' USING ERRCODE='23514';END IF;
 PERFORM id FROM order_items WHERE(tenant_id,order_id)=(t,oid) ORDER BY id FOR SHARE;
 FOR i IN SELECT * FROM order_items WHERE(tenant_id,order_id)=(t,oid) ORDER BY id LOOP
 IF i.quantity<=0 OR i.price<0 OR i.vat NOT BETWEEN 0 AND 100 OR i.line_total IS NULL OR i.line_total<0 THEN RAISE EXCEPTION 'Historyczna pozycja ma niespójne kwoty' USING ERRCODE='23514';END IF;
 gross:=i.line_total;net:=floor((2::numeric*gross*100+(100+i.vat))/(2*(100+i.vat)))::bigint;
 lines:=lines||jsonb_build_array(jsonb_build_object('kind','item','item_id',i.id,'product_id',i.product_id,'sku',i.sku,'name',i.name,'quantity',i.quantity,'unit_gross_minor',i.price::text,'vat_rate',i.vat,'gross_minor',gross::text,'net_minor',net::text,'vat_minor',(gross-net)::text));
 sumgross:=sumgross+gross;sumnet:=sumnet+net;
 END LOOP;
 gross:=o.shipping_cost;net:=floor((2::numeric*gross*100+(100+shipping_vat))/(2*(100+shipping_vat)))::bigint;
 lines:=lines||jsonb_build_array(jsonb_build_object('kind','shipping','item_id',NULL,'product_id',NULL,'sku','','name','Dostawa','quantity',1,'unit_gross_minor',gross::text,'vat_rate',shipping_vat,'gross_minor',gross::text,'net_minor',net::text,'vat_minor',(gross-net)::text));
 sumgross:=sumgross+gross;sumnet:=sumnet+net;
 IF sumgross IS DISTINCT FROM o.total::bigint THEN RAISE EXCEPTION 'Pozycje proformy nie sumują się do zamówienia' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('order',jsonb_build_object('id',o.id,'number',o.number,'version',o.version::text,'status',o.status,'currency',o.currency,'total_minor',o.total::text,'shipping_cost_minor',o.shipping_cost::text,'payment_mode',o.payment_mode),
 'seller',s.definition->'seller','buyer',jsonb_build_object('name',o.customer_name,'email',o.email,'address',buyer_address),
 'series',jsonb_build_object('id',s.id,'name',s.name,'prefix',s.prefix,'payment_terms_days',s.definition->'payment_terms_days','payment_instructions',s.definition->'payment_instructions','notes',s.definition->'notes'),
 'currency',o.currency,'lines',lines,'totals',jsonb_build_object('gross_minor',sumgross::text,'net_minor',sumnet::text,'vat_minor',(sumgross-sumnet)::text),
 'issue_date',issuedate::text,'due_date',(issuedate+(s.definition->>'payment_terms_days')::integer)::text,'year',extract(year FROM issuedate)::integer);
END$$;
CREATE FUNCTION proforma_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$BEGIN RAISE EXCEPTION 'Dowód proformy jest niezmienny' USING ERRCODE='23514';END$$;
CREATE FUNCTION proforma_series_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 PERFORM proforma_require(NEW.actor_id,NEW.api_key_id,true,false);PERFORM proforma_locks();
 IF(SELECT proforma_access(NEW.actor_id,NEW.api_key_id,true,false)->>'role') IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Serią proform zarządza administrator' USING ERRCODE='23514';END IF;
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR NOT proforma_definition(NEW.definition||jsonb_build_object('client_key',NEW.client_key))
 OR(NEW.name,NEW.prefix) IS DISTINCT FROM(NEW.definition->>'name',NEW.definition->>'prefix')
 OR NEW.request_hash<>proforma_request_hash('series',NULL,NEW.definition||jsonb_build_object('client_key',NEW.client_key),NEW.actor_id,NEW.api_key_id) THEN RAISE EXCEPTION 'Niepoprawna seria proform' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION proforma_command_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE s proforma_series%ROWTYPE;BEGIN
 SELECT * INTO s FROM proforma_series WHERE(tenant_id,id)=(NEW.tenant_id,NEW.series_id);
 IF s.id IS NULL OR(NEW.actor_id,NEW.api_key_id,NEW.client_key,NEW.request_hash) IS DISTINCT FROM(s.actor_id,s.api_key_id,s.client_key,s.request_hash) OR NEW.request IS DISTINCT FROM(s.definition||jsonb_build_object('client_key',s.client_key)) THEN RAISE EXCEPTION 'Polecenie serii nie ma dokładnego dowodu' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION proforma_create_series(body jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;s proforma_series%ROWTYPE;h text;BEGIN
 PERFORM proforma_require(uid,kid,true,false);PERFORM proforma_locks();h:=proforma_request_hash('series',NULL,body,uid,kid);
 IF(SELECT proforma_access(uid,kid,true,false)->>'role') IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Serią proform zarządza administrator' USING ERRCODE='23514';END IF;
 SELECT * INTO s FROM proforma_series WHERE(tenant_id,client_key)=(t,(body->>'client_key')::uuid);
 IF s.id IS NOT NULL THEN IF(s.actor_id,s.api_key_id,s.request_hash) IS DISTINCT FROM(uid,kid,h) THEN RAISE EXCEPTION 'Klucz serii użyty z innymi danymi' USING ERRCODE='23514';END IF;RETURN to_jsonb(s)||jsonb_build_object('reused',true);END IF;
 IF NOT proforma_definition(body) THEN RAISE EXCEPTION 'Niepoprawna seria proform' USING ERRCODE='23514';END IF;
 INSERT INTO proforma_series(tenant_id,actor_id,api_key_id,client_key,request_hash,name,prefix,definition) VALUES(t,uid,kid,(body->>'client_key')::uuid,h,body->>'name',body->>'prefix',body-'client_key') RETURNING * INTO s;
 INSERT INTO proforma_series_commands(tenant_id,series_id,actor_id,api_key_id,client_key,request_hash,request) VALUES(t,s.id,uid,kid,s.client_key,h,body);
 PERFORM proforma_budget(t);RETURN to_jsonb(s)||jsonb_build_object('reused',false);
END$$;
CREATE FUNCTION proforma_preview_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE f jsonb;BEGIN
 PERFORM proforma_require(NEW.actor_id,NEW.api_key_id,true,false);PERFORM proforma_locks();
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR jsonb_typeof(NEW.request) IS DISTINCT FROM 'object' OR NEW.request-ARRAY['client_key','series_id','order_version','shipping_vat']<>'{}'
 OR(NEW.request->>'client_key')::uuid IS DISTINCT FROM NEW.client_key OR(NEW.request->>'series_id')::uuid IS DISTINCT FROM NEW.series_id OR NEW.request->>'order_version' IS DISTINCT FROM NEW.order_version::text
 OR NEW.request_hash<>proforma_request_hash('preview',NEW.order_id,NEW.request,NEW.actor_id,NEW.api_key_id) OR jsonb_typeof(NEW.request->'shipping_vat') IS DISTINCT FROM 'number' OR NEW.request->>'shipping_vat'!~'^[0-9]+$'
 OR NEW.created_at>clock_timestamp() OR NEW.expires_at IS DISTINCT FROM NEW.created_at+interval '15 minutes' THEN RAISE EXCEPTION 'Niepoprawny podgląd proformy' USING ERRCODE='23514';END IF;
 f:=proforma_frame(NEW.order_id,NEW.series_id,(NEW.request->>'shipping_vat')::integer);
 IF NEW.snapshot IS DISTINCT FROM f OR NEW.order_version::text IS DISTINCT FROM f->'order'->>'version' OR NEW.scope_hash<>proforma_hash(f) THEN RAISE EXCEPTION 'Podgląd proformy nie ma dokładnego zakresu' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION proforma_store_preview(oid uuid,body jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p proforma_previews%ROWTYPE;f jsonb;h text;stamp timestamptz;BEGIN
 PERFORM proforma_require(uid,kid,true,false);PERFORM proforma_locks();h:=proforma_request_hash('preview',oid,body,uid,kid);
 SELECT * INTO p FROM proforma_previews WHERE(tenant_id,client_key)=(t,(body->>'client_key')::uuid);
 IF p.id IS NOT NULL THEN IF(p.order_id,p.actor_id,p.api_key_id,p.request_hash) IS DISTINCT FROM(oid,uid,kid,h) THEN RAISE EXCEPTION 'Klucz podglądu użyty z innymi danymi' USING ERRCODE='23514';END IF;RETURN to_jsonb(p)||jsonb_build_object('reused',true);END IF;
 f:=proforma_frame(oid,(body->>'series_id')::uuid,(body->>'shipping_vat')::integer);
 IF f->'order'->>'version' IS DISTINCT FROM body->>'order_version' THEN RAISE EXCEPTION 'Zamówienie zmieniło się' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM documents WHERE(tenant_id,order_id,kind)=(t,oid,'proforma')) THEN RAISE EXCEPTION 'Zamówienie ma już proformę' USING ERRCODE='23514';END IF;
 stamp:=clock_timestamp();
 INSERT INTO proforma_previews(tenant_id,order_id,series_id,order_version,actor_id,api_key_id,client_key,request_hash,request,scope_hash,snapshot,created_at,expires_at)
 VALUES(t,oid,(body->>'series_id')::uuid,(body->>'order_version')::bigint,uid,kid,(body->>'client_key')::uuid,h,body,proforma_hash(f),f,stamp,stamp+interval '15 minutes') RETURNING * INTO p;
 PERFORM proforma_budget(t);RETURN to_jsonb(p)||jsonb_build_object('reused',false);
END$$;
CREATE FUNCTION proforma_admission_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$DECLARE p proforma_previews%ROWTYPE;f jsonb;lastval integer;BEGIN
 SELECT * INTO p FROM proforma_previews WHERE(tenant_id,id)=(NEW.tenant_id,NEW.preview_id);PERFORM proforma_require(NEW.actor_id,NEW.api_key_id,true,false);
 IF p.id IS NULL OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR(NEW.actor_id,NEW.api_key_id) IS DISTINCT FROM(p.actor_id,p.api_key_id)
 OR(NEW.top_xid,NEW.transaction_started_at) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp()) OR p.expires_at<=clock_timestamp()
 OR NEW.request IS DISTINCT FROM jsonb_build_object('client_key',NEW.client_key,'scope_hash',p.scope_hash,'confirmed',true,'local_only',true)
 OR NEW.request_hash<>proforma_request_hash('issue',p.id,NEW.request,NEW.actor_id,NEW.api_key_id) THEN RAISE EXCEPTION 'Niepoprawna zgoda na proformę' USING ERRCODE='23514';END IF;
 f:=proforma_frame(p.order_id,p.series_id,(p.request->>'shipping_vat')::integer);
 SELECT last_number INTO lastval FROM proforma_counters WHERE(tenant_id,series_id,year)=(NEW.tenant_id,p.series_id,NEW.year) FOR UPDATE;
 IF f IS DISTINCT FROM p.snapshot OR proforma_hash(f)<>p.scope_hash OR NEW.year IS DISTINCT FROM(f->>'year')::integer OR NEW.sequence IS DISTINCT FROM coalesce(lastval,0)+1
 OR EXISTS(SELECT 1 FROM documents WHERE(tenant_id,order_id,kind)=(NEW.tenant_id,p.order_id,'proforma')) THEN RAISE EXCEPTION 'Zamówienie lub numeracja proformy zmieniły się' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION proforma_document_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE a proforma_admissions%ROWTYPE;p proforma_previews%ROWTYPE;s proforma_series%ROWTYPE;num text;BEGIN
 IF TG_OP<>'INSERT' THEN IF OLD.kind='proforma' OR(TG_OP='UPDATE' AND NEW.kind='proforma') THEN RAISE EXCEPTION 'Dokument proforma jest niezmienny' USING ERRCODE='23514';END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
 IF NEW.kind<>'proforma' THEN RETURN NEW;END IF;
 SELECT * INTO a FROM proforma_admissions WHERE(tenant_id,document_id)=(NEW.tenant_id,NEW.id) AND top_xid=pg_current_xact_id() AND transaction_started_at=transaction_timestamp();
 SELECT * INTO p FROM proforma_previews WHERE(tenant_id,id)=(a.tenant_id,a.preview_id);SELECT * INTO s FROM proforma_series WHERE(tenant_id,id)=(p.tenant_id,p.series_id);
 num:=s.prefix||'/'||a.year::text||'/'||lpad(a.sequence::text,6,'0');
 IF a.id IS NULL OR(NEW.order_id,NEW.kind,NEW.mode,NEW.number) IS DISTINCT FROM(p.order_id,'proforma','local',num) OR NEW.channel_id IS NOT NULL OR NEW.external_id IS NOT NULL OR NEW.return_id IS NOT NULL
 OR NEW.data IS DISTINCT FROM(p.snapshot||jsonb_build_object('number',num,'preview_id',p.id,'scope_hash',p.scope_hash,'local_only',true,'not_tax_invoice',true)) THEN RAISE EXCEPTION 'Proforma wymaga dokładnego własnego receipt' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION proforma_receipt_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE a proforma_admissions%ROWTYPE;p proforma_previews%ROWTYPE;d documents%ROWTYPE;s proforma_series%ROWTYPE;BEGIN
 SELECT * INTO a FROM proforma_admissions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id);SELECT * INTO p FROM proforma_previews WHERE(tenant_id,id)=(a.tenant_id,a.preview_id);
 SELECT * INTO d FROM documents WHERE(tenant_id,id)=(NEW.tenant_id,NEW.document_id);SELECT * INTO s FROM proforma_series WHERE(tenant_id,id)=(p.tenant_id,p.series_id);
 IF a.id IS NULL OR d.id IS NULL OR(NEW.document_id,NEW.preview_id,NEW.order_id,NEW.series_id,NEW.actor_id,NEW.api_key_id,NEW.client_key,NEW.request_hash,NEW.year,NEW.sequence,NEW.top_xid,NEW.transaction_started_at)
 IS DISTINCT FROM(a.document_id,a.preview_id,p.order_id,p.series_id,a.actor_id,a.api_key_id,a.client_key,a.request_hash,a.year,a.sequence,pg_current_xact_id(),transaction_timestamp())
 OR NEW.request IS DISTINCT FROM a.request OR NEW.scope_hash<>p.scope_hash OR NEW.snapshot IS DISTINCT FROM p.snapshot OR NEW.number IS DISTINCT FROM(s.prefix||'/'||NEW.year::text||'/'||lpad(NEW.sequence::text,6,'0'))
 OR(d.order_id,d.kind,d.mode,d.number) IS DISTINCT FROM(p.order_id,'proforma','local',NEW.number)
 OR d.data IS DISTINCT FROM(p.snapshot||jsonb_build_object('number',NEW.number,'preview_id',p.id,'scope_hash',p.scope_hash,'local_only',true,'not_tax_invoice',true)) THEN RAISE EXCEPTION 'Niepełny receipt proformy' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION proforma_counter_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Numeracji proform nie można usunąć' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
 IF NEW.last_number<>0 OR NOT EXISTS(SELECT 1 FROM proforma_admissions a JOIN proforma_previews p ON(p.tenant_id,p.id)=(a.tenant_id,a.preview_id) WHERE(a.tenant_id,p.series_id,a.year,a.sequence)=(NEW.tenant_id,NEW.series_id,NEW.year,1) AND a.top_xid=pg_current_xact_id() AND a.transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Numeracja wymaga rzeczywistego wystawienia' USING ERRCODE='23514';END IF;
 ELSE
 IF(NEW.tenant_id,NEW.series_id,NEW.year,NEW.last_number) IS DISTINCT FROM(OLD.tenant_id,OLD.series_id,OLD.year,OLD.last_number+1)
 OR NOT EXISTS(SELECT 1 FROM proforma_receipts r WHERE(r.tenant_id,r.series_id,r.year,r.sequence)=(NEW.tenant_id,NEW.series_id,NEW.year,NEW.last_number) AND r.top_xid=pg_current_xact_id() AND r.transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Numeracja wymaga rzeczywistego wystawienia' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END$$;
CREATE FUNCTION proforma_issue(pid uuid,body jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p proforma_previews%ROWTYPE;s proforma_series%ROWTYPE;r proforma_receipts%ROWTYPE;h text;f jsonb;seq integer;yr integer;eid uuid:=gen_random_uuid();did uuid:=gen_random_uuid();num text;BEGIN
 PERFORM proforma_require(uid,kid,true,false);PERFORM proforma_locks();h:=proforma_request_hash('issue',pid,body,uid,kid);
 SELECT * INTO r FROM proforma_receipts WHERE(tenant_id,client_key)=(t,(body->>'client_key')::uuid);
 IF r.id IS NOT NULL THEN IF(r.preview_id,r.actor_id,r.api_key_id,r.request_hash) IS DISTINCT FROM(pid,uid,kid,h) THEN RAISE EXCEPTION 'Klucz wystawienia użyty z innymi danymi' USING ERRCODE='23514';END IF;RETURN to_jsonb(r)||jsonb_build_object('reused',true);END IF;
 SELECT * INTO p FROM proforma_previews WHERE(tenant_id,id)=(t,pid);
 IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono podglądu proformy' USING ERRCODE='P0002';END IF;
 IF(p.actor_id,p.api_key_id) IS DISTINCT FROM(uid,kid) OR p.expires_at<=clock_timestamp() OR body IS DISTINCT FROM jsonb_build_object('client_key',body->>'client_key','scope_hash',p.scope_hash,'confirmed',true,'local_only',true) THEN RAISE EXCEPTION 'Podgląd proformy nie jest aktualną zgodą' USING ERRCODE='23514';END IF;
 f:=proforma_frame(p.order_id,p.series_id,(p.request->>'shipping_vat')::integer);
 IF f IS DISTINCT FROM p.snapshot OR proforma_hash(f)<>p.scope_hash THEN RAISE EXCEPTION 'Zamówienie zmieniło się po podglądzie proformy' USING ERRCODE='23514';END IF;
 SELECT * INTO s FROM proforma_series WHERE(tenant_id,id)=(t,p.series_id);yr:=(f->>'year')::integer;
 SELECT last_number INTO seq FROM proforma_counters WHERE(tenant_id,series_id,year)=(t,s.id,yr) FOR UPDATE;seq:=coalesce(seq,0)+1;
 IF seq>999999 THEN RAISE EXCEPTION 'Roczna numeracja serii jest wyczerpana' USING ERRCODE='23514';END IF;
 INSERT INTO proforma_admissions(id,tenant_id,document_id,preview_id,actor_id,api_key_id,client_key,request_hash,request,year,sequence) VALUES(eid,t,did,p.id,uid,kid,(body->>'client_key')::uuid,h,body,yr,seq);
 IF NOT EXISTS(SELECT 1 FROM proforma_counters WHERE(tenant_id,series_id,year)=(t,s.id,yr)) THEN
 INSERT INTO proforma_counters(tenant_id,series_id,year,last_number) VALUES(t,s.id,yr,0);END IF;
 num:=s.prefix||'/'||yr::text||'/'||lpad(seq::text,6,'0');
 INSERT INTO documents(id,tenant_id,order_id,number,kind,mode,data) VALUES(did,t,p.order_id,num,'proforma','local',p.snapshot||jsonb_build_object('number',num,'preview_id',p.id,'scope_hash',p.scope_hash,'local_only',true,'not_tax_invoice',true));
 INSERT INTO proforma_receipts(id,tenant_id,document_id,preview_id,order_id,series_id,year,sequence,number,actor_id,api_key_id,client_key,request_hash,request,scope_hash,snapshot)
 VALUES(eid,t,did,p.id,p.order_id,s.id,yr,seq,num,uid,kid,(body->>'client_key')::uuid,h,body,p.scope_hash,p.snapshot) RETURNING * INTO r;
 UPDATE proforma_counters SET last_number=seq WHERE(tenant_id,series_id,year)=(t,s.id,yr);
 PERFORM proforma_require(uid,kid,true,false);PERFORM proforma_budget(t);RETURN to_jsonb(r)||jsonb_build_object('reused',false);
END$$;
CREATE FUNCTION proforma_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE t uuid:=NEW.tenant_id;r proforma_receipts%ROWTYPE;p proforma_previews%ROWTYPE;BEGIN
 IF TG_TABLE_NAME='proforma_series' OR TG_TABLE_NAME='proforma_series_commands' THEN
 IF NOT EXISTS(SELECT 1 FROM proforma_series s JOIN proforma_series_commands cmd ON(cmd.tenant_id,cmd.series_id)=(s.tenant_id,s.id) WHERE s.tenant_id=t AND s.id=(CASE WHEN TG_TABLE_NAME='proforma_series' THEN(to_jsonb(NEW)->>'id')::uuid ELSE(to_jsonb(NEW)->>'series_id')::uuid END)) THEN RAISE EXCEPTION 'Seria nie ma trwałego polecenia' USING ERRCODE='23514';END IF;
 PERFORM proforma_require((to_jsonb(NEW)->>'actor_id')::uuid,(to_jsonb(NEW)->>'api_key_id')::uuid,true,false);
 IF(proforma_access((to_jsonb(NEW)->>'actor_id')::uuid,(to_jsonb(NEW)->>'api_key_id')::uuid,true,false)->>'role') IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Serią proform zarządza administrator' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='proforma_previews' THEN PERFORM proforma_require((to_jsonb(NEW)->>'actor_id')::uuid,(to_jsonb(NEW)->>'api_key_id')::uuid,true,false);
 ELSE
 SELECT * INTO r FROM proforma_receipts WHERE(tenant_id,id)=(t,(to_jsonb(NEW)->>'id')::uuid);SELECT * INTO p FROM proforma_previews WHERE(tenant_id,id)=(t,r.preview_id);
 IF r.id IS NULL OR NOT EXISTS(SELECT 1 FROM proforma_admissions a WHERE(a.tenant_id,a.id,a.document_id,a.preview_id,a.actor_id,a.api_key_id) IS NOT DISTINCT FROM(r.tenant_id,r.id,r.document_id,r.preview_id,r.actor_id,r.api_key_id))
 OR NOT EXISTS(SELECT 1 FROM proforma_counters c JOIN proforma_receipts lastreceipt ON(lastreceipt.tenant_id,lastreceipt.series_id,lastreceipt.year,lastreceipt.sequence)=(c.tenant_id,c.series_id,c.year,c.last_number)
 WHERE(c.tenant_id,c.series_id,c.year)=(t,r.series_id,r.year) AND c.last_number>=r.sequence AND lastreceipt.top_xid=pg_current_xact_id() AND lastreceipt.transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Niekompletny graf proformy' USING ERRCODE='23514';END IF;
 PERFORM proforma_require(r.actor_id,r.api_key_id,true,false);
 END IF;PERFORM proforma_budget(t);RETURN NEW;
END$$;
CREATE FUNCTION proforma_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE oldrow jsonb;newrow jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN oldrow:=to_jsonb(OLD);END IF;IF TG_OP<>'DELETE' THEN newrow:=to_jsonb(NEW);END IF;
 IF EXISTS(SELECT 1 FROM proforma_admissions a JOIN proforma_previews p ON(p.tenant_id,p.id)=(a.tenant_id,a.preview_id)
 WHERE a.top_xid=pg_current_xact_id() AND a.transaction_started_at=transaction_timestamp()
 AND((p.tenant_id=(oldrow->>'tenant_id')::uuid AND p.order_id=(CASE WHEN TG_TABLE_NAME='orders' THEN(oldrow->>'id')::uuid ELSE(oldrow->>'order_id')::uuid END))
 OR(p.tenant_id=(newrow->>'tenant_id')::uuid AND p.order_id=(CASE WHEN TG_TABLE_NAME='orders' THEN(newrow->>'id')::uuid ELSE(newrow->>'order_id')::uuid END)))) THEN RAISE EXCEPTION 'Zatwierdzony snapshot proformy jest zapieczętowany' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
CREATE TRIGGER proforma_series_guard BEFORE INSERT ON proforma_series FOR EACH ROW EXECUTE FUNCTION proforma_series_guard();
CREATE TRIGGER proforma_command_guard BEFORE INSERT ON proforma_series_commands FOR EACH ROW EXECUTE FUNCTION proforma_command_guard();
CREATE TRIGGER proforma_preview_guard BEFORE INSERT ON proforma_previews FOR EACH ROW EXECUTE FUNCTION proforma_preview_guard();
CREATE TRIGGER proforma_admission_guard BEFORE INSERT ON proforma_admissions FOR EACH ROW EXECUTE FUNCTION proforma_admission_guard();
CREATE TRIGGER proforma_receipt_guard BEFORE INSERT ON proforma_receipts FOR EACH ROW EXECUTE FUNCTION proforma_receipt_guard();
CREATE TRIGGER proforma_counter_guard BEFORE INSERT OR UPDATE OR DELETE ON proforma_counters FOR EACH ROW EXECUTE FUNCTION proforma_counter_guard();
CREATE TRIGGER proforma_document_guard BEFORE INSERT OR UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION proforma_document_guard();
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['proforma_series','proforma_series_commands','proforma_previews','proforma_receipts','proforma_admissions'] LOOP
 EXECUTE format('CREATE TRIGGER proforma_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION proforma_immutable()',tab);
 EXECUTE format('CREATE CONSTRAINT TRIGGER proforma_complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION proforma_complete()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['orders','order_items','return_cases'] LOOP EXECUTE format('CREATE TRIGGER proforma_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION proforma_seal()',tab);END LOOP;
END$$;
DO $$DECLARE fn record;BEGIN
 FOR fn IN SELECT p.oid::regprocedure sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'proforma\_%' ESCAPE '\' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',fn.sig);END LOOP;
END$$;
GRANT EXECUTE ON FUNCTION proforma_installed(),proforma_access(uuid,uuid,boolean,boolean),proforma_create_series(jsonb,uuid,uuid),proforma_store_preview(uuid,jsonb,uuid,uuid),proforma_issue(uuid,jsonb,uuid,uuid) TO dyna_app;
