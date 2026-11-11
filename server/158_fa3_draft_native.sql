-- SOURCE-DRAFT ONLY. Fresh additive install after157. Approved PROJECT, never FV/KSeF issuance.
CREATE TABLE fa3_draft_previews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants,
 order_id uuid NOT NULL,series_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,shipping_id uuid NOT NULL,
 source jsonb NOT NULL,draft jsonb NOT NULL,draft_hash text NOT NULL,scope_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,series_id) REFERENCES local_invoice_series(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK(request_hash~'^[a-f0-9]{64}$' AND draft_hash~'^[a-f0-9]{64}$' AND scope_hash~'^[a-f0-9]{64}$'),
 CHECK(octet_length(source::text)+octet_length(draft::text)+octet_length(request::text)<=1048576)
);
CREATE TABLE fa3_draft_projects(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,preview_id uuid NOT NULL,order_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'approved_project' CHECK(state='approved_project'),draft jsonb NOT NULL,
 draft_hash text NOT NULL,scope_hash text NOT NULL,issued boolean NOT NULL DEFAULT false CHECK(NOT issued),
 ksef_state text NOT NULL DEFAULT 'not_submitted' CHECK(ksef_state='not_submitted'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,order_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES fa3_draft_previews(tenant_id,id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 CHECK(draft_hash~'^[a-f0-9]{64}$' AND scope_hash~'^[a-f0-9]{64}$'),CHECK(octet_length(draft::text)<=1048576)
);
CREATE TABLE fa3_draft_receipts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,project_id uuid NOT NULL,preview_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,scope_hash text NOT NULL,
 root_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,project_id),UNIQUE(tenant_id,preview_id),
 FOREIGN KEY(tenant_id,project_id) REFERENCES fa3_draft_projects(tenant_id,id),FOREIGN KEY(tenant_id,preview_id) REFERENCES fa3_draft_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),CHECK(request_hash~'^[a-f0-9]{64}$' AND scope_hash~'^[a-f0-9]{64}$')
);
CREATE TABLE fa3_draft_admissions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,project_id uuid NOT NULL,preview_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,request_hash text NOT NULL,request jsonb NOT NULL,
 root_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,project_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES fa3_draft_previews(tenant_id,id),FOREIGN KEY(tenant_id,project_id) REFERENCES fa3_draft_projects(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,id) REFERENCES fa3_draft_receipts(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX fa3_draft_preview_page ON fa3_draft_previews(tenant_id,created_at DESC,id DESC);
CREATE INDEX fa3_draft_project_page ON fa3_draft_projects(tenant_id,created_at DESC,id DESC);
CREATE INDEX fa3_draft_admission_root ON fa3_draft_admissions(tenant_id,root_xid,transaction_started_at);
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['fa3_draft_previews','fa3_draft_projects','fa3_draft_receipts','fa3_draft_admissions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY owner ON %I TO CURRENT_USER USING(true) WITH CHECK(true)',tab);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',tab);
 END LOOP;
END$$;

CREATE FUNCTION fa3_draft_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT encode(sha256(convert_to(local_invoice_canonical(v),'UTF8')),'hex')$$;
CREATE FUNCTION fa3_draft_require(uid uuid,kid uuid,h text,writing boolean,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF NOT fa3_draft_guards() OR NOT local_invoice_guards() OR NOT b2b_dropship_installed() THEN RAISE EXCEPTION 'Niekompletne metadane projektu B2B' USING ERRCODE='55000';END IF;
 PERFORM local_invoice_identity(uid,kid,h,writing,pin);
END$$;
CREATE FUNCTION fa3_draft_locks(b jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;buyer uuid;BEGIN
 IF NOT EXISTS(SELECT FROM orders WHERE(tenant_id,id)=(t,(b->>'order_id')::uuid)) THEN RAISE EXCEPTION 'Brak własnego źródła B2B' USING ERRCODE='P0002';END IF;
 SELECT buyer_tenant_id INTO buyer FROM b2b_dropship_supplier_orders WHERE(tenant_id,order_id)=(t,(b->>'order_id')::uuid);
 IF buyer IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('b2b.dropship.proof:'||buyer,0));END IF;
 PERFORM local_invoice_locks();
END$$;
CREATE FUNCTION fa3_draft_source(b jsonb,locking boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;oid uuid:=(b->>'order_id')::uuid;
 o jsonb;s jsonb;cmd jsonb;items jsonb;sb jsonb;parent jsonb;qt jsonb;ref record;BEGIN
 -- Mandatory own supplier/source tuple BEFORE qualified cross-tenant native bridge.
 IF NOT EXISTS(SELECT FROM orders WHERE(tenant_id,id)=(t,oid)) THEN RAISE EXCEPTION 'Brak własnego źródła B2B' USING ERRCODE='P0002';END IF;
 SELECT buyer_tenant_id,dropship_order_id INTO ref FROM b2b_dropship_supplier_orders WHERE(tenant_id,order_id)=(t,oid);
 IF locking THEN
  IF ref.buyer_tenant_id IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('b2b.dropship.proof:'||ref.buyer_tenant_id,0));END IF;
  PERFORM local_invoice_locks();
  PERFORM id FROM orders WHERE(tenant_id,id)=(t,oid) FOR UPDATE;
  PERFORM id FROM local_invoice_series WHERE(tenant_id,id)=(t,(b->>'seller_series_id')::uuid) FOR SHARE;
  PERFORM id FROM local_invoice_series_commands WHERE(tenant_id,series_id)=(t,(b->>'seller_series_id')::uuid) FOR SHARE;
  PERFORM id FROM order_items WHERE(tenant_id,order_id)=(t,oid) ORDER BY id FOR SHARE;
  PERFORM order_id FROM b2b_dropship_supplier_orders WHERE(tenant_id,order_id)=(t,oid) FOR SHARE;
 END IF;
 SELECT to_jsonb(native_order)||jsonb_build_object('version',native_order.version::text) INTO o FROM orders native_order WHERE(tenant_id,id)=(t,oid);
 SELECT to_jsonb(native_series) INTO s FROM local_invoice_series native_series WHERE(tenant_id,id)=(t,(b->>'seller_series_id')::uuid);
 SELECT to_jsonb(native_command) INTO cmd FROM local_invoice_series_commands native_command WHERE(tenant_id,series_id)=(t,(b->>'seller_series_id')::uuid);
 IF s IS NULL OR cmd IS NULL THEN RAISE EXCEPTION 'Brak własnej serii sprzedawcy' USING ERRCODE='P0002';END IF;
 IF cmd->>'request_hash' IS DISTINCT FROM s->>'request_hash' THEN RAISE EXCEPTION 'Niepełny rzeczywisty sprzedawca' USING ERRCODE='55000';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(native_item) ORDER BY native_item.id),'[]') INTO items FROM order_items native_item WHERE(tenant_id,order_id)=(t,oid);
 IF jsonb_array_length(items) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Wymagane pełne 1–100 pozycji' USING ERRCODE='22023';END IF;
 SELECT to_jsonb(native_bridge) INTO sb FROM b2b_dropship_supplier_orders native_bridge WHERE(tenant_id,order_id)=(t,oid);
 IF(sb->>'buyer_tenant_id',sb->>'dropship_order_id') IS DISTINCT FROM(ref.buyer_tenant_id::text,ref.dropship_order_id::text) THEN RAISE EXCEPTION 'Źródło dostawcy zmieniło się' USING ERRCODE='23514';END IF;
 IF sb IS NOT NULL THEN
  IF locking THEN PERFORM id FROM b2b_dropship_orders WHERE(tenant_id,id,supplier_tenant_id,supplier_order_id)=((sb->>'buyer_tenant_id')::uuid,(sb->>'dropship_order_id')::uuid,t,oid) FOR SHARE;END IF;
  SELECT jsonb_build_object('id',d.id,'tenant_id',d.tenant_id,'version',d.version::text,'state',d.state,'link_id',d.link_id,'quote_id',d.quote_id,'customer_order_id',d.customer_order_id,'supplier_tenant_id',d.supplier_tenant_id,'supplier_order_id',d.supplier_order_id) INTO parent FROM b2b_dropship_orders d
   WHERE(d.tenant_id,d.id,d.supplier_tenant_id,d.supplier_order_id)=((sb->>'buyer_tenant_id')::uuid,(sb->>'dropship_order_id')::uuid,t,oid);
  IF parent IS NULL OR parent->>'state'<>'ordered' THEN RAISE EXCEPTION 'Brak aktualnego rodzica dropshippingu' USING ERRCODE='23514';END IF;
  IF locking THEN PERFORM id FROM b2b_dropship_quotes WHERE(tenant_id,id,customer_order_id,supplier_tenant_id)=((parent->>'tenant_id')::uuid,(parent->>'quote_id')::uuid,(parent->>'customer_order_id')::uuid,t) FOR SHARE;END IF;
  SELECT jsonb_build_object('id',q.id,'tenant_id',q.tenant_id,'customer_order_id',q.customer_order_id,'supplier_tenant_id',q.supplier_tenant_id,'scope_hash',q.scope_hash,'bill_to',q.snapshot#>'{wholesale,bill_to}') INTO qt FROM b2b_dropship_quotes q
   WHERE(q.tenant_id,q.id,q.customer_order_id,q.supplier_tenant_id)=((parent->>'tenant_id')::uuid,(parent->>'quote_id')::uuid,(parent->>'customer_order_id')::uuid,t);
  IF qt IS NULL OR fa3_draft_hash(qt->'bill_to')<>fa3_draft_hash(sb->'bill_to') THEN RAISE EXCEPTION 'Bill-to nie odpowiada wycenie' USING ERRCODE='55000';END IF;
 END IF;
 IF EXISTS(SELECT FROM order_merge_claims WHERE(tenant_id,source_order_id)=(t,oid)) OR EXISTS(SELECT FROM return_cases WHERE(tenant_id,order_id)=(t,oid))
 OR EXISTS(SELECT FROM documents WHERE(tenant_id,order_id)=(t,oid) AND kind IN('invoice','correction'))
 OR EXISTS(SELECT FROM invoice_plans WHERE(tenant_id,order_id)=(t,oid) AND kind='invoice' AND mode='external' AND state NOT IN('preview','cancelled'))
 OR EXISTS(SELECT FROM odoo_invoice_exports WHERE(tenant_id,order_id)=(t,oid) AND mode='external' AND state NOT IN('preview','cancelled')) THEN RAISE EXCEPTION 'Źródło ma odrębny proces lub zatwierdzoną fakturę' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('order',o,'items',items,'series',s,'command',cmd,'bridge',sb,'dropship',parent,'quote',qt);
END$$;

CREATE FUNCTION fa3_draft_build(src jsonb,b jsonb,shipping uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE o jsonb:=src->'order';s jsonb:=src->'series';buyer jsonb;basis jsonb;lines jsonb:='[]';item jsonb;z jsonb;
 q numeric;p numeric;g numeric;v numeric;r integer;n integer:=0;delta numeric;gross numeric:=0;net numeric:=0;vat numeric:=0;zero text;sid text;
 declaration jsonb:='{"cash_method":false,"self_billing":false,"reverse_charge":false,"split_payment":false,"exemption":false,"new_transport":false,"triangular":false,"margin":false,"jst":false,"vat_group":false,"advance":false}';BEGIN
 IF b IS DISTINCT FROM jsonb_build_object('client_key',b->'client_key','order_id',b->'order_id','order_version',b->'order_version','seller_series_id',b->'seller_series_id','sale_date',b->'sale_date','buyer',b->'buyer','shipping_vat',b->'shipping_vat','zero_basis',b->'zero_basis','ordinary_scope',declaration,'confirmed_ordinary_domestic_business_sale',true)
 OR(o->>'version',o->>'fulfillment_kind',o->>'currency',o#>>'{address,country}') IS DISTINCT FROM(b->>'order_version','sale','PLN','PL')
 OR o->>'status' NOT IN('shipped','delivered') OR s#>>'{definition,seller_vat_status}' IS DISTINCT FROM 'active_domestic'
 OR b->>'sale_date'!~'^\d{4}-\d{2}-\d{2}$' OR(b->>'sale_date')::date NOT BETWEEN '2006-01-01'::date AND '2050-01-01'::date
 OR(b->>'sale_date')::date>(clock_timestamp() AT TIME ZONE 'UTC')::date OR(b->>'sale_date')::date<(o->>'created_at')::timestamptz::date
 OR jsonb_typeof(b->'zero_basis') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Niepełny obsługiwany projekt PL/PLN' USING ERRCODE='22023';END IF;
 IF src->'bridge' IS DISTINCT FROM 'null'::jsonb THEN
  IF b->'buyer' IS DISTINCT FROM '{"kind":"dropship_frozen"}'::jsonb THEN RAISE EXCEPTION 'Wymagane natywne bill-to dostawcy' USING ERRCODE='22023';END IF;
  buyer:=jsonb_build_object('kind','business','name',src#>'{bridge,bill_to,name}','tax_id',src#>'{bridge,bill_to,tax_id}','address',jsonb_build_object('country',src#>'{bridge,bill_to,address,country}','line1',src#>'{bridge,bill_to,address,street}','line2',(src#>>'{bridge,bill_to,address,postal_code}')||' '||(src#>>'{bridge,bill_to,address,city}')));
  basis:=jsonb_build_object('kind','native_b2b_bill_to','binding_id',src#>'{dropship,id}','binding_version',src#>'{dropship,version}','snapshot_hash',fa3_draft_hash(jsonb_build_object('bridge',src->'bridge','parent',src->'dropship','quote',src->'quote')));
 ELSE
  IF b#>>'{buyer,kind}' IS DISTINCT FROM 'ordinary_explicit' OR b#>'{buyer,confirmed}' IS DISTINCT FROM 'true'::jsonb OR b->'buyer' IS DISTINCT FROM jsonb_build_object('kind','ordinary_explicit','party',b#>'{buyer,party}','confirmed',true)
  OR o->>'source' IS DISTINCT FROM 'manual' OR o->'b2b_account_id' IS DISTINCT FROM 'null'::jsonb OR o->'b2b_snapshot' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Portal/import B2B wymaga osobnego źródła bill-to' USING ERRCODE='22023';END IF;
  buyer:=b#>'{buyer,party}';basis:=jsonb_build_object('kind','ordinary_explicit','confirmed_bill_to_hash',fa3_draft_hash(b->'buyer'));
 END IF;
 IF buyer->>'kind' IS DISTINCT FROM 'business' OR buyer#>>'{address,country}' IS DISTINCT FROM 'PL' OR local_invoice_nip(buyer->>'tax_id') IS DISTINCT FROM true OR local_invoice_nip(s#>>'{definition,seller,tax_id}') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Niepełna krajowa strona B2B/NIP' USING ERRCODE='22023';END IF;
 IF local_invoice_text(buyer->'name',1,512) IS DISTINCT FROM true OR local_invoice_text(buyer#>'{address,line1}',1,512) IS DISTINCT FROM true OR(buyer#>'{address,line2}' IS NOT NULL AND local_invoice_text(buyer#>'{address,line2}',1,512) IS DISTINCT FROM true) THEN RAISE EXCEPTION 'Niepełne literalne dane nabywcy' USING ERRCODE='22023';END IF;
 IF buyer IS DISTINCT FROM jsonb_build_object('kind','business','name',buyer->'name','tax_id',buyer->'tax_id','address',buyer->'address')
 OR buyer->'address' IS DISTINCT FROM (jsonb_build_object('country','PL','line1',buyer#>'{address,line1}')||CASE WHEN buyer#>'{address,line2}' IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('line2',buyer#>'{address,line2}') END) THEN RAISE EXCEPTION 'Nadmiarowe pola strony B2B' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(b->'zero_basis') e GROUP BY coalesce(e->>'item_id','shipping') HAVING count(*)<>1) THEN RAISE EXCEPTION 'Powtórzona podstawa0' USING ERRCODE='22023';END IF;
 FOR item IN SELECT rowvalue FROM (SELECT value rowvalue,ord FROM jsonb_array_elements(src->'items') WITH ORDINALITY native_rows(value,ord) UNION ALL SELECT jsonb_build_object('id',null,'name','Dostawa','quantity',1,'price',o->'shipping_cost','line_total',o->'shipping_cost','vat',b->'shipping_vat'),101) full_rows ORDER BY ord LOOP
  n:=n+1;q:=(item->>'quantity')::numeric;p:=(item->>'price')::numeric;g:=(item->>'line_total')::numeric;r:=(item->>'vat')::integer;sid:=coalesce(item->>'id','shipping');
  IF q NOT BETWEEN 1 AND 9999999999 OR q<>trunc(q) OR p NOT BETWEEN 0 AND 9999999999999999 OR g NOT BETWEEN 0 AND 999999999999999999 OR r NOT IN(0,5,8,23) THEN RAISE EXCEPTION 'Niepełna historyczna kwota/stawka' USING ERRCODE='22023';END IF;
  delta:=p*q-g;IF greatest(-delta,0)>=q OR greatest(delta,0)>9999999999999999 THEN RAISE EXCEPTION 'Zaokrąglenie wymaga innego mapowania' USING ERRCODE='22023';END IF;
  SELECT e->>'basis' INTO zero FROM jsonb_array_elements(b->'zero_basis') e WHERE coalesce(e->>'item_id','shipping')=sid;
  IF r=0 THEN IF zero IS NULL THEN RAISE EXCEPTION 'Stawka0 wymaga jawnej podstawy' USING ERRCODE='22023';END IF;IF local_invoice_text(to_jsonb(zero),1,512) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Niepełna literalna podstawa0' USING ERRCODE='22023';END IF;
  ELSIF zero IS NOT NULL THEN RAISE EXCEPTION 'Podstawa0 dla niezerowej stawki' USING ERRCODE='22023';END IF;
  v:=trunc((2*g*r+100+r)/(2*(100+r)));gross:=gross+g;net:=net+g-v;vat:=vat+v;
  lines:=lines||jsonb_build_array(jsonb_build_object('ordinal',n,'line_id',coalesce((item->>'id')::uuid,shipping),'kind',CASE WHEN sid='shipping' THEN 'shipping' ELSE 'item' END,'source_item_id',item->'id','name',item->'name','unit',CASE WHEN sid='shipping' THEN 'usł.' ELSE 'szt.' END,'quantity',q::text,'unit_gross_minor',p::text,'discount_gross_minor',greatest(delta,0)::text,'rounding_gross_minor',greatest(-delta,0)::text,'vat_code',CASE WHEN r=0 THEN '0 KR' ELSE r::text END,'zero_domestic_basis',CASE WHEN r=0 THEN zero ELSE NULL END,'gross_minor',g::text,'net_minor',(g-v)::text,'vat_minor',v::text));
 END LOOP;
 IF EXISTS(SELECT FROM jsonb_array_elements(b->'zero_basis') e WHERE e IS DISTINCT FROM jsonb_build_object('item_id',e->'item_id','basis',e->'basis') OR NOT EXISTS(SELECT FROM jsonb_array_elements(lines) ln WHERE coalesce(ln->>'source_item_id','shipping')=coalesce(e->>'item_id','shipping') AND ln->>'vat_code'='0 KR'))
 OR gross<>(o->>'total')::numeric OR greatest(gross,net,vat)>999999999999999999 THEN RAISE EXCEPTION 'Niepełna suma całego zamówienia' USING ERRCODE='22023';END IF;
 RETURN jsonb_build_object('schema','b2b-fa3-draft/v1','state','draft','currency','PLN','invoice_kind','VAT','tax_method','gross_line_half_up','seller',jsonb_build_object('kind','business','name',s#>'{definition,seller,name}','tax_id',s#>'{definition,seller,tax_id}','address',jsonb_build_object('country',s#>'{definition,seller,country}','line1',s#>'{definition,seller,street}','line2',(s#>>'{definition,seller,postal_code}')||' '||(s#>>'{definition,seller,city}'))),'buyer',buyer,
 'source',jsonb_build_object('tenant_id',o->'tenant_id','order_id',o->'id','order_version',o->'version','item_ids',(SELECT jsonb_agg(e->'id' ORDER BY ord) FROM jsonb_array_elements(src->'items') WITH ORDINALITY it(e,ord)),'order_total_minor',gross::text,'shipping_gross_minor',(o->>'shipping_cost')::numeric::text,'buyer_basis',basis),'sale_date',b->'sale_date','ordinary_scope',declaration,'lines',lines,'totals',jsonb_build_object('gross_minor',gross::text,'net_minor',net::text,'vat_minor',vat::text));
END$$;

CREATE FUNCTION fa3_draft_budget(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF(SELECT count(*) FROM fa3_draft_previews WHERE tenant_id=t)>10000 OR(SELECT coalesce(sum(octet_length(source::text)+octet_length(draft::text)+octet_length(request::text)),0) FROM fa3_draft_previews WHERE tenant_id=t)>33554432 THEN RAISE EXCEPTION 'Budżet pełnych projektów B2B przekroczony' USING ERRCODE='54000';END IF;
END$$;
CREATE FUNCTION fa3_draft_store_preview(b jsonb,shipping uuid,candidate jsonb,uid uuid,kid uuid,h text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p fa3_draft_previews%ROWTYPE;src jsonb;d jsonb;rh text:=fa3_draft_hash(jsonb_build_object('request',b,'actor',uid,'key',kid));BEGIN
 PERFORM fa3_draft_require(uid,kid,h,true,false);
 -- Same native invoice lock serializes identical replay before source locks.
 PERFORM fa3_draft_locks(b);SELECT * INTO p FROM fa3_draft_previews WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF p.id IS NOT NULL THEN IF(p.actor_id,p.api_key_id,p.request_hash,p.request) IS DISTINCT FROM(uid,kid,rh,b) THEN RAISE EXCEPTION 'Klucz podglądu użyty z inną zgodą' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('id',p.id,'reused',true);END IF;
 src:=fa3_draft_source(b,true);d:=fa3_draft_build(src,b,shipping);
 IF octet_length(src::text)+octet_length(d::text)+octet_length(b::text)>1048576 THEN RAISE EXCEPTION 'Pełny projekt przekracza1MiB' USING ERRCODE='54000';END IF;
 IF candidate IS DISTINCT FROM d THEN RAISE EXCEPTION 'Projekt nie odpowiada prawdziwemu źródłu' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM fa3_draft_projects WHERE(tenant_id,order_id)=(t,(b->>'order_id')::uuid)) THEN RAISE EXCEPTION 'Zamówienie ma zatwierdzony projekt' USING ERRCODE='23514';END IF;
 INSERT INTO fa3_draft_previews(tenant_id,order_id,series_id,actor_id,api_key_id,client_key,request_hash,request,shipping_id,source,draft,draft_hash,scope_hash)
 VALUES(t,(b->>'order_id')::uuid,(b->>'seller_series_id')::uuid,uid,kid,(b->>'client_key')::uuid,rh,b,shipping,src,d,fa3_draft_hash(d),fa3_draft_hash(jsonb_build_object('request',b,'source',src,'draft',d))) RETURNING * INTO p;
 PERFORM fa3_draft_budget(t);RETURN jsonb_build_object('id',p.id,'reused',false);
END$$;
CREATE FUNCTION fa3_draft_approve(pid uuid,b jsonb,uid uuid,kid uuid,h text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p fa3_draft_previews%ROWTYPE;r fa3_draft_receipts%ROWTYPE;src jsonb;rh text:=fa3_draft_hash(jsonb_build_object('preview',pid,'request',b,'actor',uid,'key',kid));eid uuid:=gen_random_uuid();did uuid:=gen_random_uuid();BEGIN
 PERFORM fa3_draft_require(uid,kid,h,true,false);
 SELECT * INTO p FROM fa3_draft_previews WHERE(tenant_id,id)=(t,pid);IF p.id IS NULL THEN RAISE EXCEPTION 'Brak podglądu B2B' USING ERRCODE='P0002';END IF;
 PERFORM fa3_draft_locks(p.request);
 SELECT * INTO r FROM fa3_draft_receipts WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF r.id IS NOT NULL THEN IF(r.preview_id,r.actor_id,r.api_key_id,r.request_hash,r.request) IS DISTINCT FROM(pid,uid,kid,rh,b) THEN RAISE EXCEPTION 'Klucz zgody użyty z innym projektem' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('project_id',r.project_id,'receipt_id',r.id,'reused',true);END IF;
 SELECT * INTO p FROM fa3_draft_previews WHERE(tenant_id,id)=(t,pid);IF p.id IS NULL THEN RAISE EXCEPTION 'Brak podglądu B2B' USING ERRCODE='P0002';END IF;
 IF(p.actor_id,p.api_key_id) IS DISTINCT FROM(uid,kid) OR p.expires_at<=clock_timestamp() OR b IS DISTINCT FROM jsonb_build_object('client_key',b->'client_key','scope_hash',p.scope_hash,'confirmed',true,'project_only',true) THEN RAISE EXCEPTION 'Podgląd nie odpowiada bieżącej osobnej zgodzie' USING ERRCODE='23514';END IF;
 src:=fa3_draft_source(p.request,true);
 IF src IS DISTINCT FROM p.source OR fa3_draft_build(src,p.request,p.shipping_id) IS DISTINCT FROM p.draft THEN RAISE EXCEPTION 'Źródło projektu zmieniło się' USING ERRCODE='23514';END IF;
 INSERT INTO fa3_draft_admissions(id,tenant_id,project_id,preview_id,actor_id,api_key_id,request_hash,request) VALUES(eid,t,did,pid,uid,kid,rh,b);
 INSERT INTO fa3_draft_projects(id,tenant_id,preview_id,order_id,draft,draft_hash,scope_hash) VALUES(did,t,pid,p.order_id,p.draft,p.draft_hash,p.scope_hash);
 INSERT INTO fa3_draft_receipts(id,tenant_id,project_id,preview_id,actor_id,api_key_id,client_key,request_hash,request,scope_hash) VALUES(eid,t,did,pid,uid,kid,(b->>'client_key')::uuid,rh,b,p.scope_hash);
 RETURN jsonb_build_object('project_id',did,'receipt_id',eid,'reused',false);
END$$;
CREATE FUNCTION fa3_draft_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN RAISE EXCEPTION 'Niezmienny projekt/zgoda B2B' USING ERRCODE='23514';END$$;
CREATE FUNCTION fa3_draft_record_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p fa3_draft_previews%ROWTYPE;a fa3_draft_admissions%ROWTYPE;rowdata jsonb:=to_jsonb(NEW);BEGIN
 IF NOT fa3_draft_guards() OR NEW.tenant_id IS DISTINCT FROM t THEN RAISE EXCEPTION 'Brak prawdziwego kontekstu projektu' USING ERRCODE='55000';END IF;
 IF TG_TABLE_NAME='fa3_draft_previews' THEN
  IF NEW.source IS DISTINCT FROM fa3_draft_source(NEW.request,false) OR NEW.draft IS DISTINCT FROM fa3_draft_build(NEW.source,NEW.request,NEW.shipping_id)
  OR NEW.request_hash<>fa3_draft_hash(jsonb_build_object('request',NEW.request,'actor',NEW.actor_id,'key',NEW.api_key_id))
  OR NEW.draft_hash<>fa3_draft_hash(NEW.draft) OR NEW.scope_hash<>fa3_draft_hash(jsonb_build_object('request',NEW.request,'source',NEW.source,'draft',NEW.draft)) THEN RAISE EXCEPTION 'Podgląd bez prawdziwego źródła' USING ERRCODE='23514';END IF;
  PERFORM fa3_draft_require(NEW.actor_id,NEW.api_key_id,current_setting('fa3_draft.identity_hash',true),true,false);
 ELSE
  SELECT * INTO p FROM fa3_draft_previews WHERE(tenant_id,id)=(t,(rowdata->>'preview_id')::uuid);
  IF p.id IS NULL THEN RAISE EXCEPTION 'Brak rodzica projektu' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='fa3_draft_admissions' THEN
   IF(NEW.root_xid,NEW.transaction_started_at) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp()) OR(NEW.actor_id,NEW.api_key_id) IS DISTINCT FROM(p.actor_id,p.api_key_id)
   OR NEW.request_hash<>fa3_draft_hash(jsonb_build_object('preview',p.id,'request',NEW.request,'actor',NEW.actor_id,'key',NEW.api_key_id))
   OR NEW.request IS DISTINCT FROM jsonb_build_object('client_key',NEW.request->'client_key','scope_hash',p.scope_hash,'confirmed',true,'project_only',true)
   OR p.expires_at<=clock_timestamp() OR p.source IS DISTINCT FROM fa3_draft_source(p.request,false) THEN RAISE EXCEPTION 'Obca/historyczna zgoda projektu' USING ERRCODE='23514';END IF;
   PERFORM fa3_draft_require(NEW.actor_id,NEW.api_key_id,current_setting('fa3_draft.identity_hash',true),true,false);
  ELSE
   SELECT * INTO a FROM fa3_draft_admissions WHERE(tenant_id,project_id,preview_id)=(t,(CASE WHEN TG_TABLE_NAME='fa3_draft_projects' THEN rowdata->>'id' ELSE rowdata->>'project_id' END)::uuid,p.id);
   IF a.id IS NULL OR(a.root_xid,a.transaction_started_at) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp()) THEN RAISE EXCEPTION 'Projekt bez własnej bieżącej zgody' USING ERRCODE='23514';END IF;
   IF TG_TABLE_NAME='fa3_draft_projects' THEN
    IF(NEW.order_id,NEW.draft,NEW.draft_hash,NEW.scope_hash) IS DISTINCT FROM(p.order_id,p.draft,p.draft_hash,p.scope_hash) THEN RAISE EXCEPTION 'Projekt zmienił zamrożony podgląd' USING ERRCODE='23514';END IF;
   ELSE
    IF(NEW.id,NEW.actor_id,NEW.api_key_id,NEW.request_hash,NEW.request,NEW.root_xid,NEW.transaction_started_at,NEW.scope_hash) IS DISTINCT FROM(a.id,a.actor_id,a.api_key_id,a.request_hash,a.request,a.root_xid,a.transaction_started_at,p.scope_hash) THEN RAISE EXCEPTION 'Receipt bez właściwej zgody' USING ERRCODE='23514';END IF;
   END IF;
  END IF;
 END IF;RETURN NEW;
END$$;
CREATE FUNCTION fa3_draft_validate(pid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p fa3_draft_previews%ROWTYPE;a fa3_draft_admissions%ROWTYPE;d fa3_draft_projects%ROWTYPE;r fa3_draft_receipts%ROWTYPE;BEGIN
 SELECT * INTO d FROM fa3_draft_projects WHERE(tenant_id,id)=(t,pid);SELECT * INTO p FROM fa3_draft_previews WHERE(tenant_id,id)=(t,d.preview_id);
 SELECT * INTO a FROM fa3_draft_admissions WHERE(tenant_id,project_id)=(t,pid);SELECT * INTO r FROM fa3_draft_receipts WHERE(tenant_id,project_id)=(t,pid);
 IF d.id IS NULL OR p.id IS NULL OR a.id IS NULL OR r.id IS NULL
 OR(a.id,a.preview_id,a.actor_id,a.api_key_id,a.request_hash,a.request,a.root_xid,a.transaction_started_at) IS DISTINCT FROM(r.id,r.preview_id,r.actor_id,r.api_key_id,r.request_hash,r.request,r.root_xid,r.transaction_started_at)
 OR(a.root_xid,a.transaction_started_at) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp())
 OR(d.order_id,d.draft,d.draft_hash,d.scope_hash,r.scope_hash) IS DISTINCT FROM(p.order_id,p.draft,p.draft_hash,p.scope_hash,p.scope_hash)
 OR p.source IS DISTINCT FROM fa3_draft_source(p.request,false) OR p.draft IS DISTINCT FROM fa3_draft_build(p.source,p.request,p.shipping_id) THEN RAISE EXCEPTION 'Niepełny bieżący graf zatwierdzenia B2B' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION fa3_draft_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE rowdata jsonb:=to_jsonb(NEW);BEGIN
 IF TG_TABLE_NAME<>'fa3_draft_previews' THEN PERFORM fa3_draft_validate((CASE WHEN TG_TABLE_NAME='fa3_draft_projects' THEN rowdata->>'id' ELSE rowdata->>'project_id' END)::uuid);END IF;
 PERFORM fa3_draft_budget(NEW.tenant_id);RETURN NEW;
END$$;
CREATE FUNCTION fa3_draft_source_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE oldrow jsonb;newrow jsonb;rowdata jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN oldrow:=to_jsonb(OLD);END IF;IF TG_OP<>'DELETE' THEN newrow:=to_jsonb(NEW);END IF;
 FOR rowdata IN SELECT oldrow UNION ALL SELECT newrow LOOP
  IF rowdata IS NULL THEN CONTINUE;END IF;
  IF EXISTS(SELECT FROM fa3_draft_admissions a JOIN fa3_draft_previews p ON(p.tenant_id,p.id)=(a.tenant_id,a.preview_id)
   WHERE(a.root_xid,a.transaction_started_at)=(pg_current_xact_id(),transaction_timestamp()) AND(
    (rowdata->>'tenant_id'=p.tenant_id::text AND CASE
      WHEN TG_TABLE_NAME='orders' THEN rowdata->>'id'=p.order_id::text
      WHEN TG_TABLE_NAME='order_merge_claims' THEN rowdata->>'source_order_id'=p.order_id::text
      WHEN TG_TABLE_NAME IN('local_invoice_series','local_invoice_series_commands') THEN coalesce(rowdata->>'series_id',rowdata->>'id')=p.series_id::text
      ELSE rowdata->>'order_id'=p.order_id::text END)
    OR(TG_TABLE_NAME='b2b_dropship_orders' AND(rowdata->>'tenant_id',rowdata->>'id')=(p.source#>>'{dropship,tenant_id}',p.source#>>'{dropship,id}'))
    OR(TG_TABLE_NAME='b2b_dropship_quotes' AND(rowdata->>'tenant_id',rowdata->>'id')=(p.source#>>'{quote,tenant_id}',p.source#>>'{quote,id}')))) THEN RAISE EXCEPTION 'Zatwierdzone źródło projektu zapieczętowane' USING ERRCODE='23514';END IF;
 END LOOP;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
-- Persistent reciprocal reservation. Other invoice flow must also preflight before HTTP.
CREATE FUNCTION fa3_draft_invoice_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE rowdata jsonb;BEGIN
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;rowdata:=to_jsonb(NEW);
 IF((TG_TABLE_NAME='documents' AND rowdata->>'kind' IN('invoice','correction')) OR TG_TABLE_NAME='local_invoice_previews'
 OR(TG_TABLE_NAME='invoice_plans' AND rowdata->>'kind'='invoice' AND rowdata->>'mode'='external' AND rowdata->>'state' NOT IN('preview','cancelled'))
 OR(TG_TABLE_NAME='odoo_invoice_exports' AND rowdata->>'mode'='external' AND rowdata->>'state' NOT IN('preview','cancelled')))
 AND EXISTS(SELECT FROM fa3_draft_projects WHERE(tenant_id,order_id)=((rowdata->>'tenant_id')::uuid,(rowdata->>'order_id')::uuid)) THEN RAISE EXCEPTION 'Zamówienie ma zatwierdzony projekt B2B; wymagany odrębny proces wystawienia' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE FUNCTION fa3_draft_terminal(uid uuid,kid uuid,h text,writing boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE x record;g jsonb;stamp timestamptz;BEGIN
 -- Called AFTER ALL deferred FK/hydration/sibling blockers. Locks first, schema+source second, native clock LAST.
 PERFORM local_invoice_identity(uid,kid,h,writing,true);
 IF NOT fa3_draft_guards() OR NOT local_invoice_guards() THEN RAISE EXCEPTION 'Metadane zmieniły się po oczekiwaniu' USING ERRCODE='55000';END IF;
 FOR x IN SELECT project_id FROM fa3_draft_admissions WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND(root_xid,transaction_started_at)=(pg_current_xact_id(),transaction_timestamp()) LOOP PERFORM fa3_draft_validate(x.project_id);END LOOP;
 IF EXISTS(SELECT FROM fa3_draft_admissions a JOIN fa3_draft_previews p ON(p.tenant_id,p.id)=(a.tenant_id,a.preview_id) WHERE(a.root_xid,a.transaction_started_at)=(pg_current_xact_id(),transaction_timestamp()) AND p.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Zgoda wygasła podczas oczekiwania' USING ERRCODE='23514';END IF;
 g:=local_invoice_access(uid,kid,true,false);stamp:=clock_timestamp();
 -- No I/O, hydration, DML or further managed finalizer after this native clock.
 PERFORM local_invoice_identity(uid,kid,h,writing,false);RETURN g||jsonb_build_object('stamp',stamp);
END$$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['fa3_draft_previews','fa3_draft_projects','fa3_draft_admissions','fa3_draft_receipts'] LOOP
 EXECUTE format('CREATE TRIGGER fa3_draft_record_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION fa3_draft_record_guard()',tab);
 EXECUTE format('CREATE TRIGGER fa3_draft_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fa3_draft_immutable()',tab);
 EXECUTE format('CREATE CONSTRAINT TRIGGER fa3_draft_complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fa3_draft_complete()',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['orders','order_items','return_cases','order_merge_claims','documents','invoice_plans','odoo_invoice_exports','b2b_dropship_supplier_orders','b2b_dropship_orders','b2b_dropship_quotes'] LOOP
 EXECUTE format('CREATE TRIGGER fa3_draft_source_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fa3_draft_source_seal()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['documents','invoice_plans','odoo_invoice_exports'] LOOP
 EXECUTE format('CREATE TRIGGER fa3_draft_invoice_seal BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION fa3_draft_invoice_seal()',tab);END LOOP;
END$$;
CREATE TABLE fa3_draft_manifest(id boolean PRIMARY KEY DEFAULT true CHECK(id),fingerprint text NOT NULL);
ALTER TABLE fa3_draft_manifest ENABLE ROW LEVEL SECURITY;ALTER TABLE fa3_draft_manifest FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON fa3_draft_manifest TO CURRENT_USER USING(true) WITH CHECK(true);
REVOKE ALL ON fa3_draft_manifest FROM PUBLIC,dyna_app;
CREATE TRIGGER fa3_draft_manifest_immutable BEFORE UPDATE OR DELETE ON fa3_draft_manifest FOR EACH ROW EXECUTE FUNCTION fa3_draft_immutable();

CREATE FUNCTION public.fa3_draft_fingerprint() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT md5(jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
 'acl',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a),
 'cols',(SELECT jsonb_agg(jsonb_build_array(x.attname,format_type(x.atttypid,x.atttypmod),x.attnotnull,x.attgenerated,x.attidentity,(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(ca.grantor),CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,ca.is_grantable) ORDER BY CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,pg_get_userbyid(ca.grantor)::text,ca.is_grantable) FROM aclexplode(x.attacl)ca),pg_get_expr(d.adbin,d.adrelid)) ORDER BY x.attnum) FROM pg_attribute x LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(x.attrelid,x.attnum) WHERE x.attrelid=c.oid AND x.attnum>0 AND NOT x.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid,true)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'policies',(SELECT jsonb_agg(jsonb_build_array(po.polname,(SELECT array_agg(CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END ORDER BY CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END) FROM unnest(po.polroles)x),po.polcmd,pg_get_expr(po.polqual,po.polrelid),pg_get_expr(po.polwithcheck,po.polrelid)) ORDER BY po.polname) FROM pg_policy po WHERE po.polrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(tr.tgname,tr.tgenabled,pg_get_triggerdef(tr.oid,true)) ORDER BY tr.tgname) FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND (c.relname LIKE 'fa3\_draft\_%' ESCAPE '\' OR c.relname LIKE 'b2b\_dropship\_%' ESCAPE '\' OR c.relname IN('local_invoice_series','local_invoice_series_commands','orders','order_items','order_merge_claims','return_cases','documents','invoice_plans','odoo_invoice_exports','users','sessions','memberships','api_keys','account_security','workspace_security_policies','tenants')) AND c.relkind IN('r','p')),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.provolatile,p.proisstrict,p.proleakproof,p.proparallel,p.prokind,p.proretset,p.prorettype,pg_get_function_identity_arguments(p.oid),pg_get_function_result(p.oid),p.proargmodes,p.proargnames,pg_get_expr(p.proargdefaults,0),(SELECT lanname FROM pg_language WHERE oid=p.prolang),(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND ((p.proname LIKE 'fa3\_draft\_%' ESCAPE '\' OR p.proname LIKE 'local\_invoice\_%' ESCAPE '\' OR p.proname LIKE 'b2b\_dropship\_%' ESCAPE '\') OR p.oid IN(SELECT tr.tgfoid FROM pg_trigger tr JOIN pg_class rel ON rel.oid=tr.tgrelid WHERE rel.relnamespace='public'::regnamespace AND NOT tr.tgisinternal AND rel.relname IN('orders','order_items','order_merge_claims','return_cases','documents','invoice_plans','odoo_invoice_exports','users','sessions','memberships','api_keys','account_security','workspace_security_policies','tenants')))),
 'documents_checks',(SELECT jsonb_agg(jsonb_build_array(conname,convalidated,pg_get_constraintdef(oid,true)) ORDER BY conname) FROM pg_constraint WHERE conrelid='public.documents'::regclass AND conname IN('documents_kind_check','documents_proforma_local','documents_native_invoice')),
 'document_indexes',(SELECT jsonb_agg(jsonb_build_array(c.relname,i.indisvalid,pg_get_indexdef(i.indexrelid)) ORDER BY c.relname) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN('document_order_mode','document_demo_number')),
 'parent_triggers',(SELECT jsonb_agg(jsonb_build_array(tgname,tgenabled,pg_get_triggerdef(oid,true)) ORDER BY tgrelid::regclass::text,tgname) FROM pg_trigger WHERE tgfoid IN(SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND(proname LIKE 'fa3\_draft\_%' ESCAPE '\' OR proname LIKE 'b2b\_dropship\_%' ESCAPE '\')))
 )::text) $$;
CREATE FUNCTION fa3_draft_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT FROM migrations WHERE name='158_fa3_draft_native')$$;
CREATE FUNCTION fa3_draft_guards() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE sig text;BEGIN
 IF current_setting('session_replication_role')<>'origin' THEN RETURN false;END IF;
 FOREACH sig IN ARRAY ARRAY['fa3_draft_hash(jsonb)','fa3_draft_require(uuid,uuid,text,boolean,boolean)','fa3_draft_locks(jsonb)','fa3_draft_source(jsonb,boolean)','fa3_draft_build(jsonb,jsonb,uuid)','fa3_draft_budget(uuid)','fa3_draft_store_preview(jsonb,uuid,jsonb,uuid,uuid,text)','fa3_draft_approve(uuid,jsonb,uuid,uuid,text)','fa3_draft_immutable()','fa3_draft_record_guard()','fa3_draft_validate(uuid)','fa3_draft_complete()','fa3_draft_source_seal()','fa3_draft_invoice_seal()','fa3_draft_terminal(uuid,uuid,text,boolean)','fa3_draft_fingerprint()','fa3_draft_installed()','fa3_draft_guards()','local_invoice_guards()','local_invoice_identity(uuid,uuid,text,boolean,boolean)','b2b_dropship_installed()'] LOOP
 IF to_regprocedure('public.'||sig) IS NULL THEN RETURN false;END IF;END LOOP;
 IF(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'fa3\_draft\_%' ESCAPE '\' AND relkind IN('r','p') AND relrowsecurity AND relforcerowsecurity)<>5 THEN RETURN false;END IF;
 IF to_regclass('public.fa3_draft_manifest') IS NULL THEN RETURN false;END IF;
 RETURN coalesce((SELECT fingerprint=fa3_draft_fingerprint() FROM fa3_draft_manifest WHERE id),false);
END$$;
DO $$DECLARE fn record;BEGIN FOR fn IN SELECT p.oid::regprocedure sig FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'fa3\_draft\_%' ESCAPE '\' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',fn.sig);END LOOP;END$$;
-- Owner-only writes/source/proof; application role may ask ONLY installed/guard status.
GRANT EXECUTE ON FUNCTION fa3_draft_installed(),fa3_draft_guards(),fa3_draft_terminal(uuid,uuid,text,boolean) TO dyna_app;
INSERT INTO fa3_draft_manifest VALUES(true,fa3_draft_fingerprint());
