-- SOURCE_AUTHORED173. Additive native invoice family; no legacy row rewrite.
ALTER TABLE documents ADD CONSTRAINT documents_native_invoice CHECK(mode<>'local_invoice' OR(kind='invoice' AND channel_id IS NULL AND external_id IS NULL AND return_id IS NULL));
CREATE TABLE local_invoice_series(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,
 name text NOT NULL,prefix text NOT NULL,definition jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,prefix),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),CHECK(request_hash~'^[a-f0-9]{64}$')
);
CREATE TABLE local_invoice_series_commands(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants,series_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,series_id),
 FOREIGN KEY(tenant_id,series_id) REFERENCES local_invoice_series(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE local_invoice_previews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants,order_id uuid NOT NULL,series_id uuid NOT NULL,
 order_version bigint NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,
 request jsonb NOT NULL,scope_hash text NOT NULL,snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,series_id) REFERENCES local_invoice_series(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK(request_hash~'^[a-f0-9]{64}$' AND scope_hash~'^[a-f0-9]{64}$'),CHECK(octet_length(snapshot::text)<=1048576)
);
CREATE TABLE local_invoice_counters(
 tenant_id uuid NOT NULL,series_id uuid NOT NULL,year integer NOT NULL CHECK(year BETWEEN 1900 AND 9999),
 last_number integer NOT NULL CHECK(last_number BETWEEN 0 AND 999999),PRIMARY KEY(tenant_id,series_id,year),
 FOREIGN KEY(tenant_id,series_id) REFERENCES local_invoice_series(tenant_id,id)
);
CREATE TABLE local_invoice_receipts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,document_id uuid NOT NULL,preview_id uuid NOT NULL,order_id uuid NOT NULL,series_id uuid NOT NULL,
 year integer NOT NULL CHECK(year BETWEEN 1900 AND 9999),sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 999999),number text NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,scope_hash text NOT NULL,snapshot jsonb NOT NULL,
 top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,order_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,number),UNIQUE(tenant_id,series_id,year,sequence),
 FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id),FOREIGN KEY(tenant_id,preview_id) REFERENCES local_invoice_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,series_id) REFERENCES local_invoice_series(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE local_invoice_admissions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,document_id uuid NOT NULL,preview_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,
 year integer NOT NULL,sequence integer NOT NULL,top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id),FOREIGN KEY(tenant_id,preview_id) REFERENCES local_invoice_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,id) REFERENCES local_invoice_receipts(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX local_invoice_series_page ON local_invoice_series(tenant_id,created_at DESC,id DESC);
CREATE INDEX local_invoice_previews_order ON local_invoice_previews(tenant_id,order_id,created_at DESC,id DESC);
CREATE INDEX local_invoice_receipts_order ON local_invoice_receipts(tenant_id,order_id);
CREATE INDEX local_invoice_admissions_tx ON local_invoice_admissions(tenant_id,top_xid,transaction_started_at);
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['local_invoice_series','local_invoice_series_commands','local_invoice_previews','local_invoice_counters','local_invoice_receipts','local_invoice_admissions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY owner ON %I TO CURRENT_USER USING(true) WITH CHECK(true)',tab);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',tab);
 IF tab<>'local_invoice_admissions' THEN EXECUTE format('GRANT SELECT ON %I TO dyna_app',tab);END IF;
 END LOOP;
END$$;

CREATE FUNCTION local_invoice_installed() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT 1 FROM migrations WHERE name='157_local_invoices')$$;
CREATE FUNCTION local_invoice_access(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
CREATE FUNCTION local_invoice_identity(uid uuid,kid uuid,h text,writing boolean,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;stamp timestamptz;v record;BEGIN
 IF h IS NULL OR h!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Brak tożsamości żądania FV' USING ERRCODE='28000';END IF;
 IF pin THEN
  PERFORM id FROM users WHERE id=uid FOR SHARE;
  IF kid IS NULL THEN PERFORM token_hash FROM sessions WHERE(token_hash,user_id,tenant_id)=(h,uid,t) FOR SHARE;END IF;
  PERFORM id FROM tenants WHERE id=t FOR SHARE;
  PERFORM user_id FROM account_security WHERE user_id=uid FOR SHARE;
  PERFORM tenant_id FROM workspace_security_policies WHERE tenant_id=t FOR SHARE;
  PERFORM role FROM memberships WHERE(tenant_id,user_id)=(t,uid) FOR SHARE;
  IF kid IS NOT NULL THEN PERFORM id FROM api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid) FOR SHARE;END IF;
 END IF;
 stamp:=clock_timestamp();
 IF kid IS NULL THEN
  SELECT m.role,true scope_ok,coalesce(p.require_mfa,false) AND NOT(coalesce(a.enabled_at IS NOT NULL AND s.mfa_verified_at IS NOT NULL AND s.mfa_verified_at>stamp-interval '8 hours',false)) mfa_required INTO v
  FROM sessions s JOIN users u ON u.id=s.user_id JOIN tenants tt ON tt.id=s.tenant_id
  LEFT JOIN memberships m ON(m.tenant_id,m.user_id)=(s.tenant_id,s.user_id)
  LEFT JOIN account_security a ON a.user_id=u.id LEFT JOIN workspace_security_policies p ON p.tenant_id=tt.id
  WHERE(s.token_hash,s.user_id,s.tenant_id)=(h,uid,t) AND s.expires_at>stamp AND s.account_version=coalesce(a.version,0);
 ELSE
  SELECT m.role,coalesce(k.scopes@>ARRAY['documents:read','orders:read']::text[] AND(NOT writing OR k.scopes@>ARRAY['documents:write']::text[]),false) scope_ok,coalesce(p.require_mfa,false) AND a.enabled_at IS NULL mfa_required INTO v
  FROM api_keys k JOIN users u ON u.id=k.user_id JOIN tenants tt ON tt.id=k.tenant_id
  LEFT JOIN memberships m ON(m.tenant_id,m.user_id)=(k.tenant_id,k.user_id)
  LEFT JOIN account_security a ON a.user_id=u.id LEFT JOIN workspace_security_policies p ON p.tenant_id=tt.id
  WHERE(k.id,k.token_hash,k.user_id,k.tenant_id)=(kid,h,uid,t) AND k.revoked_at IS NULL AND(k.expires_at IS NULL OR k.expires_at>stamp);
 END IF;
 IF v IS NULL THEN RAISE EXCEPTION 'Sesja lub klucz FV wygasły albo utraciły zakres' USING ERRCODE='28000';END IF;
 IF v.role IS NULL OR v.role NOT IN('admin','operator','viewer') OR(writing AND v.role='viewer') OR v.mfa_required OR v.scope_ok IS NOT TRUE THEN RAISE EXCEPTION 'Brak aktualnej tożsamości lub MFA dla FV' USING ERRCODE='42501';END IF;
END$$;
CREATE FUNCTION local_invoice_require(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE g jsonb;BEGIN
 IF NOT local_invoice_guards() THEN RAISE EXCEPTION 'Niekompletny moduł lokalnej FV' USING ERRCODE='55000';END IF;
 PERFORM local_invoice_identity(uid,kid,current_setting('local_invoice.identity_hash',true),writing,pin);
 g:=local_invoice_access(uid,kid,writing,pin);
 IF g->>'key_valid' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Klucz faktury jest wycofany lub wygasł' USING ERRCODE='23514';END IF;
 IF g->>'allowed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Brak aktualnych uprawnień do faktury' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION local_invoice_locks() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('local-invoice:'||current_setting('app.tenant_id',true),0));
 PERFORM pg_advisory_xact_lock(hashtextextended('order.merge.proof:'||current_setting('app.tenant_id',true),0));
END$$;
CREATE FUNCTION local_invoice_canonical(v jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$DECLARE result text;BEGIN
 IF jsonb_typeof(v)='object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(k)::text||':'||local_invoice_canonical(val),',' ORDER BY k COLLATE "C"),'')||'}' INTO result FROM jsonb_each(v) obj(k,val);
 ELSIF jsonb_typeof(v)='array' THEN SELECT '['||coalesce(string_agg(local_invoice_canonical(val),',' ORDER BY n),'')||']' INTO result FROM jsonb_array_elements(v) WITH ORDINALITY arr(val,n);
 ELSE result:=v::text;END IF;RETURN result;
END$$;
CREATE FUNCTION local_invoice_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT encode(sha256(convert_to(v::text,'UTF8')),'hex')$$;
CREATE FUNCTION local_invoice_request_hash(kind text,parent uuid,body jsonb,uid uuid,kid uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(local_invoice_canonical(jsonb_build_object('tenant_id',nullif(current_setting('app.tenant_id',true),''),'actor_id',uid,'api_key_id',kid,'kind',kind,'parent_id',parent,'request',body)),'UTF8')),'hex')
$$;
CREATE FUNCTION local_invoice_text(v jsonb,minlen integer,maxlen integer) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_typeof(v)='string' AND length(v#>>'{}') BETWEEN minlen AND maxlen AND(v#>>'{}')=btrim(v#>>'{}') AND(v#>>'{}')!~'[[:cntrl:]]' AND(v#>>'{}')!~U&'[\0080-\009f]'
$$;
CREATE FUNCTION local_invoice_nip(v text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT CASE WHEN v~'^[0-9]{10}$' AND v<>'0000000000' THEN (SELECT sum(w*substring(v FROM n::integer FOR 1)::integer)%11 FROM unnest(ARRAY[6,5,7,2,3,4,5,6,7]) WITH ORDINALITY a(w,n))=substring(v FROM 10 FOR 1)::integer ELSE false END$$;
CREATE FUNCTION local_invoice_definition(body jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$DECLARE s jsonb;BEGIN
 s:=body->'seller';RETURN (jsonb_typeof(body)='object' AND body-ARRAY['client_key','name','prefix','seller','payment_terms_days','payment_instructions','notes','seller_vat_status']='{}'
 AND local_invoice_text(body->'name',1,120) AND jsonb_typeof(body->'prefix')='string' AND body->>'prefix'~'^[A-Z0-9][A-Z0-9-]{0,11}$'
 AND jsonb_typeof(body->'payment_terms_days')='number' AND body->>'payment_terms_days'~'^[0-9]+$' AND(body->>'payment_terms_days')::bigint BETWEEN 0 AND 365
 AND body->>'seller_vat_status'='active_domestic' AND local_invoice_text(body->'payment_instructions',0,2000) AND local_invoice_text(body->'notes',0,2000)
 AND jsonb_typeof(s)='object' AND s-ARRAY['name','street','postal_code','city','country','tax_id']='{}'
 AND local_invoice_text(s->'name',1,200) AND local_invoice_text(s->'street',1,200) AND local_invoice_text(s->'postal_code',1,30) AND local_invoice_text(s->'city',1,100)
 AND jsonb_typeof(s->'country')='string' AND s->>'country'='PL' AND local_invoice_nip(s->>'tax_id')) IS TRUE;
END$$;
CREATE FUNCTION local_invoice_budget(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE bytes bigint;BEGIN
 IF(SELECT count(*) FROM local_invoice_series WHERE tenant_id=t)>100 OR(SELECT count(*) FROM local_invoice_previews WHERE tenant_id=t)>2000 OR(SELECT count(*) FROM local_invoice_receipts WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit historii faktur' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(octet_length(r::text)),0) INTO bytes FROM(
 SELECT to_jsonb(x) r FROM local_invoice_series x WHERE tenant_id=t UNION ALL SELECT to_jsonb(x) FROM local_invoice_series_commands x WHERE tenant_id=t
 UNION ALL SELECT to_jsonb(x) FROM local_invoice_previews x WHERE tenant_id=t UNION ALL SELECT to_jsonb(x) FROM local_invoice_receipts x WHERE tenant_id=t
 UNION ALL SELECT to_jsonb(x) FROM local_invoice_admissions x WHERE tenant_id=t UNION ALL SELECT d.data FROM documents d WHERE tenant_id=t AND mode='local_invoice') history;
 IF bytes>67108864 THEN RAISE EXCEPTION 'Limit historii faktur' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION local_invoice_frame(oid uuid,sid uuid,shipping_vat integer,bill_to jsonb,sale_date text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;o orders%ROWTYPE;s local_invoice_series%ROWTYPE;i record;lines jsonb:='[]';gross bigint;net bigint;sumgross bigint:=0;sumnet bigint:=0;issuedate date:=(clock_timestamp() AT TIME ZONE 'UTC')::date;buyer_address jsonb;taxes jsonb;vat bigint;BEGIN
 SELECT * INTO o FROM orders WHERE(tenant_id,id)=(t,oid) FOR UPDATE;
 IF o.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego zamówienia' USING ERRCODE='P0002';END IF;
 SELECT * INTO s FROM local_invoice_series WHERE(tenant_id,id)=(t,sid) FOR UPDATE;
 IF s.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnej serii faktur' USING ERRCODE='P0002';END IF;
 IF o.fulfillment_kind IS DISTINCT FROM 'sale' OR o.status NOT IN('shipped','delivered')
 OR EXISTS(SELECT 1 FROM order_merge_claims mc WHERE(mc.tenant_id,mc.source_order_id)=(t,oid))
 OR EXISTS(SELECT 1 FROM return_cases rc WHERE(rc.tenant_id,rc.order_id)=(t,oid))
 OR EXISTS(SELECT 1 FROM documents d WHERE(d.tenant_id,d.order_id,d.kind)=(t,oid,'correction')) THEN RAISE EXCEPTION 'Zamówienie nie jest obsługiwaną sprzedażą dla faktury' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM invoice_plans ip WHERE(ip.tenant_id,ip.order_id)=(t,oid) AND ip.kind='invoice' AND ip.mode='external' AND ip.state NOT IN('preview','cancelled')) OR EXISTS(SELECT 1 FROM odoo_invoice_exports ox WHERE(ox.tenant_id,ox.order_id)=(t,oid) AND ox.mode='external' AND ox.state NOT IN('preview','cancelled')) OR EXISTS(SELECT 1 FROM documents dx WHERE(dx.tenant_id,dx.order_id,dx.kind)=(t,oid,'invoice') AND dx.mode='external') THEN RAISE EXCEPTION 'Zamówienie ma zewnętrzną fakturę lub zatwierdzony plan' USING ERRCODE='23514';END IF;
 IF o.source='b2b' OR EXISTS(SELECT 1 FROM b2b_dropship_orders b WHERE(b.tenant_id,b.customer_order_id)=(t,oid) OR(b.supplier_tenant_id,b.supplier_order_id)=(t,oid)) THEN RAISE EXCEPTION 'Faktura B2B wymaga osobnego potwierdzenia bill-to' USING ERRCODE='23514';END IF;
 IF o.currency<>'PLN' OR shipping_vat IS NULL OR shipping_vat NOT IN(0,5,8,23) OR o.shipping_cost<0 OR o.total<0 THEN RAISE EXCEPTION 'Niepoprawne pieniądze faktury' USING ERRCODE='23514';END IF;
 IF (jsonb_typeof(bill_to)='object' AND bill_to-ARRAY['kind','name','street','postal_code','city','country']='{}' AND bill_to->>'kind'='consumer'
 AND local_invoice_text(bill_to->'name',1,200) AND local_invoice_text(bill_to->'street',1,200) AND local_invoice_text(bill_to->'postal_code',1,30) AND local_invoice_text(bill_to->'city',1,100) AND bill_to->>'country'='PL') IS NOT TRUE
 OR o.address->>'country' IS DISTINCT FROM 'PL' OR sale_date IS NULL OR sale_date!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'Obsługujemy wyłącznie pełne dane konsumenta i sprzedaż krajową PL' USING ERRCODE='22023';END IF;
 IF sale_date::date>issuedate OR sale_date::date<(o.created_at AT TIME ZONE 'UTC')::date THEN RAISE EXCEPTION 'Potwierdź rzeczywistą datę sprzedaży między zamówieniem a wystawieniem' USING ERRCODE='22023';END IF;
 buyer_address:=bill_to-ARRAY['kind','name'];
 IF(SELECT count(*) FROM order_items WHERE(tenant_id,order_id)=(t,oid)) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Niepełne pozycje faktury' USING ERRCODE='23514';END IF;
 PERFORM id FROM order_items WHERE(tenant_id,order_id)=(t,oid) ORDER BY id FOR SHARE;
 FOR i IN SELECT * FROM order_items WHERE(tenant_id,order_id)=(t,oid) ORDER BY id LOOP
 IF i.quantity<=0 OR i.price<0 OR i.vat NOT IN(0,5,8,23) OR i.line_total IS NULL OR i.line_total<0 OR i.line_total::bigint-i.price::bigint*i.quantity::bigint>=i.quantity::bigint THEN RAISE EXCEPTION 'Historyczna pozycja ma niespójne kwoty' USING ERRCODE='23514';END IF;
 gross:=i.line_total;vat:=floor((2::numeric*gross*i.vat+(100+i.vat))/(2*(100+i.vat)))::bigint;net:=gross-vat;
 lines:=lines||jsonb_build_array(jsonb_build_object('kind','item','item_id',i.id,'product_id',i.product_id,'sku',i.sku,'name',i.name,'quantity',i.quantity,'unit','szt.','unit_gross_minor',i.price::text,'discount_gross_minor',greatest(i.price::bigint*i.quantity::bigint-gross,0)::text,'rounding_gross_minor',greatest(gross-i.price::bigint*i.quantity::bigint,0)::text,'vat_rate',i.vat,'gross_minor',gross::text,'net_minor',net::text,'vat_minor',(gross-net)::text));
 sumgross:=sumgross+gross;sumnet:=sumnet+net;
 END LOOP;
 gross:=o.shipping_cost;vat:=floor((2::numeric*gross*shipping_vat+(100+shipping_vat))/(2*(100+shipping_vat)))::bigint;net:=gross-vat;
 lines:=lines||jsonb_build_array(jsonb_build_object('kind','shipping','item_id',NULL,'product_id',NULL,'sku','','name','Dostawa','quantity',1,'unit','usł.','unit_gross_minor',gross::text,'discount_gross_minor','0','rounding_gross_minor','0','vat_rate',shipping_vat,'gross_minor',gross::text,'net_minor',net::text,'vat_minor',(gross-net)::text));
 sumgross:=sumgross+gross;sumnet:=sumnet+net;
 IF sumgross IS DISTINCT FROM o.total::bigint THEN RAISE EXCEPTION 'Pozycje faktury nie sumują się do zamówienia' USING ERRCODE='23514';END IF;
 SELECT jsonb_agg(jsonb_build_object('vat_rate',rate,'gross_minor',g::text,'net_minor',n::text,'vat_minor',v::text) ORDER BY rate) INTO taxes FROM(SELECT (val->>'vat_rate')::integer rate,sum((val->>'gross_minor')::bigint) g,sum((val->>'net_minor')::bigint) n,sum((val->>'vat_minor')::bigint) v FROM jsonb_array_elements(lines) a(val) GROUP BY (val->>'vat_rate')::integer) totals;
 RETURN jsonb_build_object('order',jsonb_build_object('id',o.id,'number',o.number,'version',o.version::text,'status',o.status,'currency',o.currency,'total_minor',o.total::text,'shipping_cost_minor',o.shipping_cost::text,'payment_mode',o.payment_mode),
 'seller',s.definition->'seller','buyer',jsonb_build_object('kind','consumer','tax_id','','name',bill_to->>'name','email',o.email,'address',buyer_address),
 'series',jsonb_build_object('id',s.id,'name',s.name,'prefix',s.prefix,'payment_terms_days',s.definition->'payment_terms_days','payment_instructions',s.definition->'payment_instructions','notes',s.definition->'notes'),
 'currency',o.currency,'lines',lines,'totals',jsonb_build_object('gross_minor',sumgross::text,'net_minor',sumnet::text,'vat_minor',(sumgross-sumnet)::text),
 'vat_totals',taxes,'rounding_method','gross_line_half_up','tax_regime','ordinary_domestic','consumer_sale_confirmed',true,'no_special_tax_procedure_confirmed',true,'not_fiscal_receipt_confirmed',true,'sell_date',sale_date,'issue_date',issuedate::text,'due_date',(issuedate+(s.definition->>'payment_terms_days')::integer)::text,'year',extract(year FROM issuedate)::integer);
END$$;
CREATE FUNCTION local_invoice_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$BEGIN RAISE EXCEPTION 'Dowód faktury jest niezmienny' USING ERRCODE='23514';END$$;
CREATE FUNCTION local_invoice_series_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 PERFORM local_invoice_require(NEW.actor_id,NEW.api_key_id,true,false);PERFORM local_invoice_locks();
 IF(SELECT local_invoice_access(NEW.actor_id,NEW.api_key_id,true,false)->>'role') IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Serią faktur zarządza administrator' USING ERRCODE='23514';END IF;
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR NOT local_invoice_definition(NEW.definition||jsonb_build_object('client_key',NEW.client_key))
 OR(NEW.name,NEW.prefix) IS DISTINCT FROM(NEW.definition->>'name',NEW.definition->>'prefix')
 OR NEW.request_hash<>local_invoice_request_hash('series',NULL,NEW.definition||jsonb_build_object('client_key',NEW.client_key),NEW.actor_id,NEW.api_key_id) THEN RAISE EXCEPTION 'Niepoprawna seria faktur' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION local_invoice_command_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE s local_invoice_series%ROWTYPE;BEGIN
 SELECT * INTO s FROM local_invoice_series WHERE(tenant_id,id)=(NEW.tenant_id,NEW.series_id);
 IF s.id IS NULL OR(NEW.actor_id,NEW.api_key_id,NEW.client_key,NEW.request_hash) IS DISTINCT FROM(s.actor_id,s.api_key_id,s.client_key,s.request_hash) OR NEW.request IS DISTINCT FROM(s.definition||jsonb_build_object('client_key',s.client_key)) THEN RAISE EXCEPTION 'Polecenie serii nie ma dokładnego dowodu' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION local_invoice_create_series(body jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;s local_invoice_series%ROWTYPE;h text;BEGIN
 PERFORM local_invoice_require(uid,kid,true,false);PERFORM local_invoice_locks();h:=local_invoice_request_hash('series',NULL,body,uid,kid);
 IF(SELECT local_invoice_access(uid,kid,true,false)->>'role') IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Serią faktur zarządza administrator' USING ERRCODE='23514';END IF;
 SELECT * INTO s FROM local_invoice_series WHERE(tenant_id,client_key)=(t,(body->>'client_key')::uuid);
 IF s.id IS NOT NULL THEN IF(s.actor_id,s.api_key_id,s.request_hash) IS DISTINCT FROM(uid,kid,h) THEN RAISE EXCEPTION 'Klucz serii użyty z innymi danymi' USING ERRCODE='23514';END IF;RETURN to_jsonb(s)||jsonb_build_object('reused',true);END IF;
 IF EXISTS(SELECT 1 FROM proforma_series ps WHERE ps.tenant_id=t AND ps.prefix=body->>'prefix') THEN RAISE EXCEPTION 'Prefiks jest już używany przez proformy' USING ERRCODE='23514';END IF;
 IF NOT local_invoice_definition(body) THEN RAISE EXCEPTION 'Niepoprawna seria faktur' USING ERRCODE='23514';END IF;
 INSERT INTO local_invoice_series(tenant_id,actor_id,api_key_id,client_key,request_hash,name,prefix,definition) VALUES(t,uid,kid,(body->>'client_key')::uuid,h,body->>'name',body->>'prefix',body-'client_key') RETURNING * INTO s;
 INSERT INTO local_invoice_series_commands(tenant_id,series_id,actor_id,api_key_id,client_key,request_hash,request) VALUES(t,s.id,uid,kid,s.client_key,h,body);
 PERFORM local_invoice_budget(t);RETURN to_jsonb(s)||jsonb_build_object('reused',false);
END$$;
CREATE FUNCTION local_invoice_preview_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE f jsonb;BEGIN
 PERFORM local_invoice_require(NEW.actor_id,NEW.api_key_id,true,false);PERFORM local_invoice_locks();
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR jsonb_typeof(NEW.request) IS DISTINCT FROM 'object' OR NEW.request-ARRAY['client_key','series_id','order_version','shipping_vat','buyer','sell_date','tax_regime','consumer_sale_confirmed','no_special_tax_procedure_confirmed','not_fiscal_receipt_confirmed']<>'{}'
 OR(NEW.request->>'client_key')::uuid IS DISTINCT FROM NEW.client_key OR(NEW.request->>'series_id')::uuid IS DISTINCT FROM NEW.series_id OR NEW.request->>'order_version' IS DISTINCT FROM NEW.order_version::text
 OR NEW.request_hash<>local_invoice_request_hash('preview',NEW.order_id,NEW.request,NEW.actor_id,NEW.api_key_id) OR jsonb_typeof(NEW.request->'shipping_vat') IS DISTINCT FROM 'number' OR NEW.request->>'shipping_vat'!~'^[0-9]+$'
 OR NEW.request->>'tax_regime' IS DISTINCT FROM 'ordinary_domestic' OR NEW.request->'consumer_sale_confirmed' IS DISTINCT FROM 'true'::jsonb OR NEW.request->'no_special_tax_procedure_confirmed' IS DISTINCT FROM 'true'::jsonb OR NEW.request->'not_fiscal_receipt_confirmed' IS DISTINCT FROM 'true'::jsonb
 OR NEW.created_at>clock_timestamp() OR NEW.expires_at IS DISTINCT FROM NEW.created_at+interval '15 minutes' THEN RAISE EXCEPTION 'Niepoprawny podgląd faktury' USING ERRCODE='23514';END IF;
 f:=local_invoice_frame(NEW.order_id,NEW.series_id,(NEW.request->>'shipping_vat')::integer,NEW.request->'buyer',NEW.request->>'sell_date');
 IF NEW.snapshot IS DISTINCT FROM f OR NEW.order_version::text IS DISTINCT FROM f->'order'->>'version' OR NEW.scope_hash<>local_invoice_hash(f) THEN RAISE EXCEPTION 'Podgląd faktury nie ma dokładnego zakresu' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION local_invoice_store_preview(oid uuid,body jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p local_invoice_previews%ROWTYPE;f jsonb;h text;stamp timestamptz;BEGIN
 PERFORM local_invoice_require(uid,kid,true,false);PERFORM local_invoice_locks();h:=local_invoice_request_hash('preview',oid,body,uid,kid);
 SELECT * INTO p FROM local_invoice_previews WHERE(tenant_id,client_key)=(t,(body->>'client_key')::uuid);
 IF p.id IS NOT NULL THEN IF(p.order_id,p.actor_id,p.api_key_id,p.request_hash) IS DISTINCT FROM(oid,uid,kid,h) THEN RAISE EXCEPTION 'Klucz podglądu użyty z innymi danymi' USING ERRCODE='23514';END IF;RETURN to_jsonb(p)||jsonb_build_object('reused',true);END IF;
 f:=local_invoice_frame(oid,(body->>'series_id')::uuid,(body->>'shipping_vat')::integer,body->'buyer',body->>'sell_date');
 IF f->'order'->>'version' IS DISTINCT FROM body->>'order_version' THEN RAISE EXCEPTION 'Zamówienie zmieniło się' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM documents WHERE(tenant_id,order_id,kind,mode)=(t,oid,'invoice','local_invoice')) THEN RAISE EXCEPTION 'Zamówienie ma już fakturę' USING ERRCODE='23514';END IF;
 stamp:=clock_timestamp();
 INSERT INTO local_invoice_previews(tenant_id,order_id,series_id,order_version,actor_id,api_key_id,client_key,request_hash,request,scope_hash,snapshot,created_at,expires_at)
 VALUES(t,oid,(body->>'series_id')::uuid,(body->>'order_version')::bigint,uid,kid,(body->>'client_key')::uuid,h,body,local_invoice_hash(f),f,stamp,stamp+interval '15 minutes') RETURNING * INTO p;
 PERFORM local_invoice_budget(t);RETURN to_jsonb(p)||jsonb_build_object('reused',false);
END$$;
CREATE FUNCTION local_invoice_admission_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$DECLARE p local_invoice_previews%ROWTYPE;f jsonb;lastval integer;BEGIN
 SELECT * INTO p FROM local_invoice_previews WHERE(tenant_id,id)=(NEW.tenant_id,NEW.preview_id);PERFORM local_invoice_require(NEW.actor_id,NEW.api_key_id,true,false);
 IF p.id IS NULL OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR(NEW.actor_id,NEW.api_key_id) IS DISTINCT FROM(p.actor_id,p.api_key_id)
 OR(NEW.top_xid,NEW.transaction_started_at) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp()) OR p.expires_at<=clock_timestamp()
 OR NEW.request IS DISTINCT FROM jsonb_build_object('client_key',NEW.client_key,'scope_hash',p.scope_hash,'confirmed',true,'local_only',true)
 OR NEW.request_hash<>local_invoice_request_hash('issue',p.id,NEW.request,NEW.actor_id,NEW.api_key_id) THEN RAISE EXCEPTION 'Niepoprawna zgoda na fakturę' USING ERRCODE='23514';END IF;
 f:=local_invoice_frame(p.order_id,p.series_id,(p.request->>'shipping_vat')::integer,p.request->'buyer',p.request->>'sell_date');
 SELECT last_number INTO lastval FROM local_invoice_counters WHERE(tenant_id,series_id,year)=(NEW.tenant_id,p.series_id,NEW.year) FOR UPDATE;
 IF f IS DISTINCT FROM p.snapshot OR local_invoice_hash(f)<>p.scope_hash OR NEW.year IS DISTINCT FROM(f->>'year')::integer OR NEW.sequence IS DISTINCT FROM coalesce(lastval,0)+1
 OR EXISTS(SELECT 1 FROM documents WHERE(tenant_id,order_id,kind,mode)=(NEW.tenant_id,p.order_id,'invoice','local_invoice')) THEN RAISE EXCEPTION 'Zamówienie lub numeracja faktury zmieniły się' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION local_invoice_document_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE a local_invoice_admissions%ROWTYPE;p local_invoice_previews%ROWTYPE;s local_invoice_series%ROWTYPE;num text;BEGIN
 IF TG_OP<>'INSERT' THEN IF OLD.mode='local_invoice' OR(TG_OP='UPDATE' AND NEW.mode='local_invoice') THEN RAISE EXCEPTION 'Dokument local_invoice jest niezmienny' USING ERRCODE='23514';END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
 IF NEW.mode<>'local_invoice' THEN RETURN NEW;END IF;
 SELECT * INTO a FROM local_invoice_admissions WHERE(tenant_id,document_id)=(NEW.tenant_id,NEW.id) AND top_xid=pg_current_xact_id() AND transaction_started_at=transaction_timestamp();
 SELECT * INTO p FROM local_invoice_previews WHERE(tenant_id,id)=(a.tenant_id,a.preview_id);SELECT * INTO s FROM local_invoice_series WHERE(tenant_id,id)=(p.tenant_id,p.series_id);
 num:=s.prefix||'/'||a.year::text||'/'||lpad(a.sequence::text,6,'0');
 IF a.id IS NULL OR(NEW.order_id,NEW.kind,NEW.mode,NEW.number) IS DISTINCT FROM(p.order_id,'invoice','local_invoice',num) OR NEW.channel_id IS NOT NULL OR NEW.external_id IS NOT NULL OR NEW.return_id IS NOT NULL
 OR NEW.data IS DISTINCT FROM(p.snapshot||jsonb_build_object('number',num,'preview_id',p.id,'scope_hash',p.scope_hash,'local_only',true,'ksef_state','not_submitted','fiscalized',false)) THEN RAISE EXCEPTION 'Faktura wymaga dokładnego własnego receipt' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION local_invoice_receipt_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE a local_invoice_admissions%ROWTYPE;p local_invoice_previews%ROWTYPE;d documents%ROWTYPE;s local_invoice_series%ROWTYPE;BEGIN
 SELECT * INTO a FROM local_invoice_admissions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id);SELECT * INTO p FROM local_invoice_previews WHERE(tenant_id,id)=(a.tenant_id,a.preview_id);
 SELECT * INTO d FROM documents WHERE(tenant_id,id)=(NEW.tenant_id,NEW.document_id);SELECT * INTO s FROM local_invoice_series WHERE(tenant_id,id)=(p.tenant_id,p.series_id);
 IF a.id IS NULL OR d.id IS NULL OR(NEW.document_id,NEW.preview_id,NEW.order_id,NEW.series_id,NEW.actor_id,NEW.api_key_id,NEW.client_key,NEW.request_hash,NEW.year,NEW.sequence,NEW.top_xid,NEW.transaction_started_at)
 IS DISTINCT FROM(a.document_id,a.preview_id,p.order_id,p.series_id,a.actor_id,a.api_key_id,a.client_key,a.request_hash,a.year,a.sequence,pg_current_xact_id(),transaction_timestamp())
 OR NEW.request IS DISTINCT FROM a.request OR NEW.scope_hash<>p.scope_hash OR NEW.snapshot IS DISTINCT FROM p.snapshot OR NEW.number IS DISTINCT FROM(s.prefix||'/'||NEW.year::text||'/'||lpad(NEW.sequence::text,6,'0'))
 OR(d.order_id,d.kind,d.mode,d.number) IS DISTINCT FROM(p.order_id,'invoice','local_invoice',NEW.number)
 OR d.data IS DISTINCT FROM(p.snapshot||jsonb_build_object('number',NEW.number,'preview_id',p.id,'scope_hash',p.scope_hash,'local_only',true,'ksef_state','not_submitted','fiscalized',false)) THEN RAISE EXCEPTION 'Niepełny receipt faktury' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION local_invoice_counter_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Numeracji faktur nie można usunąć' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
 IF NEW.last_number<>0 OR NOT EXISTS(SELECT 1 FROM local_invoice_admissions a JOIN local_invoice_previews p ON(p.tenant_id,p.id)=(a.tenant_id,a.preview_id) WHERE(a.tenant_id,p.series_id,a.year,a.sequence)=(NEW.tenant_id,NEW.series_id,NEW.year,1) AND a.top_xid=pg_current_xact_id() AND a.transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Numeracja wymaga rzeczywistego wystawienia' USING ERRCODE='23514';END IF;
 ELSE
 IF(NEW.tenant_id,NEW.series_id,NEW.year,NEW.last_number) IS DISTINCT FROM(OLD.tenant_id,OLD.series_id,OLD.year,OLD.last_number+1)
 OR NOT EXISTS(SELECT 1 FROM local_invoice_receipts r WHERE(r.tenant_id,r.series_id,r.year,r.sequence)=(NEW.tenant_id,NEW.series_id,NEW.year,NEW.last_number) AND r.top_xid=pg_current_xact_id() AND r.transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Numeracja wymaga rzeczywistego wystawienia' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END$$;
CREATE FUNCTION local_invoice_issue(pid uuid,body jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p local_invoice_previews%ROWTYPE;s local_invoice_series%ROWTYPE;r local_invoice_receipts%ROWTYPE;h text;f jsonb;seq integer;yr integer;eid uuid:=gen_random_uuid();did uuid:=gen_random_uuid();num text;BEGIN
 PERFORM local_invoice_require(uid,kid,true,false);PERFORM local_invoice_locks();h:=local_invoice_request_hash('issue',pid,body,uid,kid);
 SELECT * INTO r FROM local_invoice_receipts WHERE(tenant_id,client_key)=(t,(body->>'client_key')::uuid);
 IF r.id IS NOT NULL THEN IF(r.preview_id,r.actor_id,r.api_key_id,r.request_hash) IS DISTINCT FROM(pid,uid,kid,h) THEN RAISE EXCEPTION 'Klucz wystawienia użyty z innymi danymi' USING ERRCODE='23514';END IF;RETURN to_jsonb(r)||jsonb_build_object('reused',true);END IF;
 SELECT * INTO p FROM local_invoice_previews WHERE(tenant_id,id)=(t,pid);
 IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono podglądu faktury' USING ERRCODE='P0002';END IF;
 IF(p.actor_id,p.api_key_id) IS DISTINCT FROM(uid,kid) OR p.expires_at<=clock_timestamp() OR body IS DISTINCT FROM jsonb_build_object('client_key',body->>'client_key','scope_hash',p.scope_hash,'confirmed',true,'local_only',true) THEN RAISE EXCEPTION 'Podgląd faktury nie jest aktualną zgodą' USING ERRCODE='23514';END IF;
 f:=local_invoice_frame(p.order_id,p.series_id,(p.request->>'shipping_vat')::integer,p.request->'buyer',p.request->>'sell_date');
 IF f IS DISTINCT FROM p.snapshot OR local_invoice_hash(f)<>p.scope_hash THEN RAISE EXCEPTION 'Zamówienie zmieniło się po podglądzie faktury' USING ERRCODE='23514';END IF;
 SELECT * INTO s FROM local_invoice_series WHERE(tenant_id,id)=(t,p.series_id);yr:=(f->>'year')::integer;
 SELECT last_number INTO seq FROM local_invoice_counters WHERE(tenant_id,series_id,year)=(t,s.id,yr) FOR UPDATE;seq:=coalesce(seq,0)+1;
 IF seq>999999 THEN RAISE EXCEPTION 'Roczna numeracja serii jest wyczerpana' USING ERRCODE='23514';END IF;
 INSERT INTO local_invoice_admissions(id,tenant_id,document_id,preview_id,actor_id,api_key_id,client_key,request_hash,request,year,sequence) VALUES(eid,t,did,p.id,uid,kid,(body->>'client_key')::uuid,h,body,yr,seq);
 IF NOT EXISTS(SELECT 1 FROM local_invoice_counters WHERE(tenant_id,series_id,year)=(t,s.id,yr)) THEN
 INSERT INTO local_invoice_counters(tenant_id,series_id,year,last_number) VALUES(t,s.id,yr,0);END IF;
 num:=s.prefix||'/'||yr::text||'/'||lpad(seq::text,6,'0');
 INSERT INTO documents(id,tenant_id,order_id,number,kind,mode,data) VALUES(did,t,p.order_id,num,'invoice','local_invoice',p.snapshot||jsonb_build_object('number',num,'preview_id',p.id,'scope_hash',p.scope_hash,'local_only',true,'ksef_state','not_submitted','fiscalized',false));
 INSERT INTO local_invoice_receipts(id,tenant_id,document_id,preview_id,order_id,series_id,year,sequence,number,actor_id,api_key_id,client_key,request_hash,request,scope_hash,snapshot)
 VALUES(eid,t,did,p.id,p.order_id,s.id,yr,seq,num,uid,kid,(body->>'client_key')::uuid,h,body,p.scope_hash,p.snapshot) RETURNING * INTO r;
 UPDATE local_invoice_counters SET last_number=seq WHERE(tenant_id,series_id,year)=(t,s.id,yr);
 PERFORM local_invoice_require(uid,kid,true,false);PERFORM local_invoice_budget(t);RETURN to_jsonb(r)||jsonb_build_object('reused',false);
END$$;
CREATE FUNCTION local_invoice_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE t uuid:=NEW.tenant_id;r local_invoice_receipts%ROWTYPE;p local_invoice_previews%ROWTYPE;BEGIN
 IF TG_TABLE_NAME='local_invoice_series' OR TG_TABLE_NAME='local_invoice_series_commands' THEN
 IF NOT EXISTS(SELECT 1 FROM local_invoice_series s JOIN local_invoice_series_commands cmd ON(cmd.tenant_id,cmd.series_id)=(s.tenant_id,s.id) WHERE s.tenant_id=t AND s.id=(CASE WHEN TG_TABLE_NAME='local_invoice_series' THEN(to_jsonb(NEW)->>'id')::uuid ELSE(to_jsonb(NEW)->>'series_id')::uuid END)) THEN RAISE EXCEPTION 'Seria nie ma trwałego polecenia' USING ERRCODE='23514';END IF;
 PERFORM local_invoice_require((to_jsonb(NEW)->>'actor_id')::uuid,(to_jsonb(NEW)->>'api_key_id')::uuid,true,false);
 IF(local_invoice_access((to_jsonb(NEW)->>'actor_id')::uuid,(to_jsonb(NEW)->>'api_key_id')::uuid,true,false)->>'role') IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Serią faktur zarządza administrator' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='local_invoice_previews' THEN PERFORM local_invoice_require((to_jsonb(NEW)->>'actor_id')::uuid,(to_jsonb(NEW)->>'api_key_id')::uuid,true,false);
 ELSE
 SELECT * INTO r FROM local_invoice_receipts WHERE(tenant_id,id)=(t,(to_jsonb(NEW)->>'id')::uuid);SELECT * INTO p FROM local_invoice_previews WHERE(tenant_id,id)=(t,r.preview_id);
 IF r.id IS NULL OR NOT EXISTS(SELECT 1 FROM local_invoice_admissions a WHERE(a.tenant_id,a.id,a.document_id,a.preview_id,a.actor_id,a.api_key_id) IS NOT DISTINCT FROM(r.tenant_id,r.id,r.document_id,r.preview_id,r.actor_id,r.api_key_id))
 OR NOT EXISTS(SELECT 1 FROM local_invoice_counters c JOIN local_invoice_receipts lastreceipt ON(lastreceipt.tenant_id,lastreceipt.series_id,lastreceipt.year,lastreceipt.sequence)=(c.tenant_id,c.series_id,c.year,c.last_number)
 WHERE(c.tenant_id,c.series_id,c.year)=(t,r.series_id,r.year) AND c.last_number>=r.sequence AND lastreceipt.top_xid=pg_current_xact_id() AND lastreceipt.transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Niekompletny graf faktury' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM documents d WHERE(d.tenant_id,d.id,d.order_id,d.kind,d.mode,d.number)=(r.tenant_id,r.document_id,r.order_id,'invoice','local_invoice',r.number) AND d.data=r.snapshot||jsonb_build_object('number',r.number,'preview_id',r.preview_id,'scope_hash',r.scope_hash,'local_only',true,'ksef_state','not_submitted','fiscalized',false)) THEN RAISE EXCEPTION 'Trwały dokument FV nie odpowiada receipt' USING ERRCODE='23514';END IF;
 PERFORM local_invoice_require(r.actor_id,r.api_key_id,true,false);
 END IF;PERFORM local_invoice_budget(t);RETURN NEW;
END$$;
CREATE FUNCTION local_invoice_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE oldrow jsonb;newrow jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN oldrow:=to_jsonb(OLD);END IF;IF TG_OP<>'DELETE' THEN newrow:=to_jsonb(NEW);END IF;
 IF EXISTS(SELECT 1 FROM local_invoice_admissions a JOIN local_invoice_previews p ON(p.tenant_id,p.id)=(a.tenant_id,a.preview_id)
 WHERE a.top_xid=pg_current_xact_id() AND a.transaction_started_at=transaction_timestamp()
 AND((p.tenant_id=(oldrow->>'tenant_id')::uuid AND p.order_id=(CASE WHEN TG_TABLE_NAME='orders' THEN(oldrow->>'id')::uuid ELSE(oldrow->>'order_id')::uuid END))
 OR(p.tenant_id=(newrow->>'tenant_id')::uuid AND p.order_id=(CASE WHEN TG_TABLE_NAME='orders' THEN(newrow->>'id')::uuid ELSE(newrow->>'order_id')::uuid END)))) THEN RAISE EXCEPTION 'Zatwierdzony snapshot faktury jest zapieczętowany' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
CREATE TRIGGER local_invoice_series_guard BEFORE INSERT ON local_invoice_series FOR EACH ROW EXECUTE FUNCTION local_invoice_series_guard();
CREATE TRIGGER local_invoice_command_guard BEFORE INSERT ON local_invoice_series_commands FOR EACH ROW EXECUTE FUNCTION local_invoice_command_guard();
CREATE TRIGGER local_invoice_preview_guard BEFORE INSERT ON local_invoice_previews FOR EACH ROW EXECUTE FUNCTION local_invoice_preview_guard();
CREATE TRIGGER local_invoice_admission_guard BEFORE INSERT ON local_invoice_admissions FOR EACH ROW EXECUTE FUNCTION local_invoice_admission_guard();
CREATE TRIGGER local_invoice_receipt_guard BEFORE INSERT ON local_invoice_receipts FOR EACH ROW EXECUTE FUNCTION local_invoice_receipt_guard();
CREATE TRIGGER local_invoice_counter_guard BEFORE INSERT OR UPDATE OR DELETE ON local_invoice_counters FOR EACH ROW EXECUTE FUNCTION local_invoice_counter_guard();
CREATE TRIGGER local_invoice_document_guard BEFORE INSERT OR UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION local_invoice_document_guard();
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['local_invoice_series','local_invoice_series_commands','local_invoice_previews','local_invoice_receipts','local_invoice_admissions'] LOOP
 EXECUTE format('CREATE TRIGGER local_invoice_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION local_invoice_immutable()',tab);
 EXECUTE format('CREATE CONSTRAINT TRIGGER local_invoice_complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION local_invoice_complete()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['orders','order_items','return_cases'] LOOP EXECUTE format('CREATE TRIGGER local_invoice_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION local_invoice_seal()',tab);END LOOP;
END$$;
CREATE TABLE local_invoice_manifest(id boolean PRIMARY KEY DEFAULT true CHECK(id),fingerprint text NOT NULL);
ALTER TABLE local_invoice_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_invoice_manifest FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON local_invoice_manifest TO CURRENT_USER USING(true) WITH CHECK(true);
REVOKE ALL ON local_invoice_manifest FROM PUBLIC,dyna_app;
CREATE TRIGGER local_invoice_manifest_immutable BEFORE UPDATE OR DELETE ON local_invoice_manifest FOR EACH ROW EXECUTE FUNCTION local_invoice_immutable();
CREATE FUNCTION public.local_invoice_fingerprint() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT md5(jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
 'acl',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a),
 'cols',(SELECT jsonb_agg(jsonb_build_array(x.attname,format_type(x.atttypid,x.atttypmod),x.attnotnull,x.attgenerated,x.attidentity,(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(ca.grantor),CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,ca.is_grantable) ORDER BY CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,pg_get_userbyid(ca.grantor)::text,ca.is_grantable) FROM aclexplode(x.attacl)ca),pg_get_expr(d.adbin,d.adrelid)) ORDER BY x.attnum) FROM pg_attribute x LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(x.attrelid,x.attnum) WHERE x.attrelid=c.oid AND x.attnum>0 AND NOT x.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid,true)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'policies',(SELECT jsonb_agg(jsonb_build_array(po.polname,(SELECT array_agg(CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END ORDER BY CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END) FROM unnest(po.polroles)x),po.polcmd,pg_get_expr(po.polqual,po.polrelid),pg_get_expr(po.polwithcheck,po.polrelid)) ORDER BY po.polname) FROM pg_policy po WHERE po.polrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(tr.tgname,tr.tgenabled,pg_get_triggerdef(tr.oid,true)) ORDER BY tr.tgname) FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'local\_invoice\_%' ESCAPE '\' AND c.relkind IN('r','p')),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.provolatile,p.proisstrict,p.proleakproof,p.proparallel,p.prokind,p.proretset,p.prorettype,pg_get_function_identity_arguments(p.oid),pg_get_function_result(p.oid),p.proargmodes,p.proargnames,pg_get_expr(p.proargdefaults,0),(SELECT lanname FROM pg_language WHERE oid=p.prolang),(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'local\_invoice\_%' ESCAPE '\'),
 'documents_checks',(SELECT jsonb_agg(jsonb_build_array(conname,convalidated,pg_get_constraintdef(oid,true)) ORDER BY conname) FROM pg_constraint WHERE conrelid='public.documents'::regclass AND conname IN('documents_kind_check','documents_proforma_local','documents_native_invoice')),
 'document_indexes',(SELECT jsonb_agg(jsonb_build_array(c.relname,i.indisvalid,pg_get_indexdef(i.indexrelid)) ORDER BY c.relname) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN('document_order_mode','document_demo_number')),
 'parent_triggers',(SELECT jsonb_agg(jsonb_build_array(tgname,tgenabled,pg_get_triggerdef(oid,true)) ORDER BY tgrelid::regclass::text,tgname) FROM pg_trigger WHERE tgname IN('local_invoice_document_guard','local_invoice_seal'))
 )::text) $$;
CREATE FUNCTION public.local_invoice_guards() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE sig text;BEGIN
 FOREACH sig IN ARRAY ARRAY['public.local_invoice_installed()','public.local_invoice_access(uuid,uuid,boolean,boolean)','public.local_invoice_identity(uuid,uuid,text,boolean,boolean)','public.local_invoice_require(uuid,uuid,boolean,boolean)','public.local_invoice_locks()','public.local_invoice_canonical(jsonb)','public.local_invoice_hash(jsonb)','public.local_invoice_request_hash(text,uuid,jsonb,uuid,uuid)','public.local_invoice_text(jsonb,integer,integer)','public.local_invoice_nip(text)','public.local_invoice_definition(jsonb)','public.local_invoice_budget(uuid)','public.local_invoice_frame(uuid,uuid,integer,jsonb,text)','public.local_invoice_immutable()','public.local_invoice_series_guard()','public.local_invoice_command_guard()','public.local_invoice_create_series(jsonb,uuid,uuid)','public.local_invoice_preview_guard()','public.local_invoice_store_preview(uuid,jsonb,uuid,uuid)','public.local_invoice_admission_guard()','public.local_invoice_document_guard()','public.local_invoice_receipt_guard()','public.local_invoice_counter_guard()','public.local_invoice_issue(uuid,jsonb,uuid,uuid)','public.local_invoice_complete()','public.local_invoice_seal()','public.local_invoice_fingerprint()','public.local_invoice_guards()'] LOOP IF to_regprocedure(sig) IS NULL THEN RETURN false;END IF;END LOOP;
 IF(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'local\_invoice\_%' ESCAPE '\' AND relkind IN('r','p') AND relrowsecurity AND relforcerowsecurity)<>7 THEN RETURN false;END IF;
 RETURN coalesce((SELECT fingerprint=public.local_invoice_fingerprint() FROM public.local_invoice_manifest WHERE id),false) AND current_setting('session_replication_role')='origin';END$$;
DO $$DECLARE fn record;BEGIN
 FOR fn IN SELECT p.oid::regprocedure sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'local\_invoice\_%' ESCAPE '\' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',fn.sig);END LOOP;
END$$;
GRANT EXECUTE ON FUNCTION local_invoice_installed(),local_invoice_access(uuid,uuid,boolean,boolean),local_invoice_create_series(jsonb,uuid,uuid),local_invoice_store_preview(uuid,jsonb,uuid,uuid),local_invoice_issue(uuid,jsonb,uuid,uuid) TO dyna_app;

GRANT EXECUTE ON FUNCTION local_invoice_guards(),local_invoice_identity(uuid,uuid,text,boolean,boolean) TO dyna_app;
INSERT INTO local_invoice_manifest VALUES(true,local_invoice_fingerprint());
