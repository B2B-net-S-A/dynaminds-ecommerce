-- SOURCE-AUTHORED159; NOT_INSTALLED / NOT_RUN. Must run inside the native migration BEGIN.
-- Exact predecessor source:158 SQL 92381024b61a9c23472857b2cece974b6f848e2f0b414b96ae9dc0c071d849bb.
-- Original158 manifest is never rewritten. Certificate row pins both complete metadata profiles.
DO $$BEGIN
 IF to_regclass('public.fa3_draft_manifest') IS NULL OR to_regprocedure('public.fa3_draft_installed()') IS NULL
 OR to_regprocedure('public.fa3_draft_guards()') IS NULL OR to_regprocedure('public.fa3_draft_fingerprint()') IS NULL
 OR to_regprocedure('public.fa3_draft_invoice_seal()') IS NULL OR to_regprocedure('public.local_invoice_guards()') IS NULL THEN
 RAISE EXCEPTION 'Brak pełnego poprzednika158' USING ERRCODE='55000';END IF;
 IF NOT fa3_draft_installed() OR NOT fa3_draft_guards() OR NOT local_invoice_guards() THEN RAISE EXCEPTION 'Uszkodzony poprzednik158' USING ERRCODE='55000';END IF;
END$$;
CREATE TEMP TABLE b2b_invoice_migration_basis ON COMMIT DROP AS
 SELECT to_jsonb(m) original_manifest,fa3_draft_fingerprint() predecessor_fingerprint,
 encode(sha256(convert_to((SELECT prosrc FROM pg_proc WHERE oid='public.fa3_draft_guards()'::regprocedure),'UTF8')),'hex') guard_body_hash,
 encode(sha256(convert_to((SELECT prosrc FROM pg_proc WHERE oid='public.fa3_draft_invoice_seal()'::regprocedure),'UTF8')),'hex') seal_body_hash
 FROM fa3_draft_manifest m WHERE id;
DO $$BEGIN
 IF NOT fa3_draft_installed() OR NOT fa3_draft_guards() OR NOT local_invoice_guards()
 OR(SELECT count(*) FROM pg_temp.b2b_invoice_migration_basis)<>1
 OR EXISTS(SELECT FROM pg_temp.b2b_invoice_migration_basis WHERE predecessor_fingerprint IS DISTINCT FROM original_manifest->>'fingerprint'
 OR guard_body_hash<>'39e9fb2a2bb8ff79151beec20611bd6c01ad1d935ab779cc0cbcc34e39a882f0' OR seal_body_hash<>'e3d517e4d343f872613212e010592a8aeb8586d7341e67f8b9c6f60c812bb104')
 OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'b2b\_invoice\_%' ESCAPE '\')
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'b2b\_invoice\_%' ESCAPE '\') THEN
 RAISE EXCEPTION '159 wymaga dokładnego niezmienionego poprzednika158, bez pozostałości' USING ERRCODE='55000';END IF;
END$$;
CREATE TABLE b2b_invoice_upgrade(
 id boolean PRIMARY KEY CHECK(id),profile text NOT NULL CHECK(profile='158-original-to159-local-issued/v1'),
 original_manifest jsonb NOT NULL,predecessor_fingerprint text NOT NULL,guard_body_hash text NOT NULL,seal_body_hash text NOT NULL,
 successor158_fingerprint text NOT NULL,successor159_fingerprint text NOT NULL,
 installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(guard_body_hash='39e9fb2a2bb8ff79151beec20611bd6c01ad1d935ab779cc0cbcc34e39a882f0' AND seal_body_hash='e3d517e4d343f872613212e010592a8aeb8586d7341e67f8b9c6f60c812bb104'),
 CHECK(predecessor_fingerprint=original_manifest->>'fingerprint')
);
CREATE TABLE b2b_invoice_previews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants,
 project_id uuid NOT NULL,project_receipt_id uuid NOT NULL,order_id uuid NOT NULL,series_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,
 source jsonb NOT NULL,snapshot jsonb NOT NULL,scope_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,project_id) REFERENCES fa3_draft_projects(tenant_id,id),
 FOREIGN KEY(tenant_id,project_receipt_id) REFERENCES fa3_draft_receipts(tenant_id,id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,series_id) REFERENCES local_invoice_series(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK(request_hash~'^[a-f0-9]{64}$' AND scope_hash~'^[a-f0-9]{64}$'),
 CHECK(octet_length(source::text)+octet_length(snapshot::text)+octet_length(request::text)<=1048576)
);
CREATE TABLE b2b_invoice_admissions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,document_id uuid NOT NULL,preview_id uuid NOT NULL,
 project_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,
 request_hash text NOT NULL,request jsonb NOT NULL,year integer NOT NULL CHECK(year BETWEEN 2006 AND 2050),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 999999),number text NOT NULL,
 root_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id),UNIQUE(tenant_id,project_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES b2b_invoice_previews(tenant_id,id),FOREIGN KEY(tenant_id,project_id) REFERENCES fa3_draft_projects(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE b2b_invoice_receipts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,document_id uuid NOT NULL,preview_id uuid NOT NULL,project_id uuid NOT NULL,
 project_receipt_id uuid NOT NULL,order_id uuid NOT NULL,series_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,
 scope_hash text NOT NULL,snapshot jsonb NOT NULL,year integer NOT NULL CHECK(year BETWEEN 2006 AND 2050),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 999999),number text NOT NULL,
 root_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,project_id),UNIQUE(tenant_id,order_id),
 UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,number),UNIQUE(tenant_id,series_id,year,sequence),
 FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id),FOREIGN KEY(tenant_id,preview_id) REFERENCES b2b_invoice_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,project_id) REFERENCES fa3_draft_projects(tenant_id,id),FOREIGN KEY(tenant_id,project_receipt_id) REFERENCES fa3_draft_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,series_id) REFERENCES local_invoice_series(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),CHECK(octet_length(snapshot::text)<=1048576)
);
ALTER TABLE b2b_invoice_admissions ADD FOREIGN KEY(tenant_id,id) REFERENCES b2b_invoice_receipts(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE b2b_invoice_counters(
 tenant_id uuid NOT NULL,series_id uuid NOT NULL,year integer NOT NULL CHECK(year BETWEEN 2006 AND 2050),last_number integer NOT NULL CHECK(last_number BETWEEN 0 AND 999999),
 PRIMARY KEY(tenant_id,series_id,year),FOREIGN KEY(tenant_id,series_id) REFERENCES local_invoice_series(tenant_id,id)
);
-- Exclusive local namespace ownership across ALL workspaces for the same sellerNIP/prefix.
-- Actual KSeF P_2 duplicate identity is sellerNIP+invoice type+number, not tenant.
CREATE TABLE b2b_invoice_namespaces(
 seller_tax_id text NOT NULL CHECK(seller_tax_id~'^[0-9]{10}$'),prefix text NOT NULL CHECK(prefix~'^[A-Z0-9][A-Z0-9-]{0,11}$'),
 tenant_id uuid NOT NULL REFERENCES tenants,series_id uuid NOT NULL,claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(seller_tax_id,prefix),UNIQUE(tenant_id,series_id),FOREIGN KEY(tenant_id,series_id) REFERENCES local_invoice_series(tenant_id,id)
);
CREATE INDEX b2b_invoice_preview_page ON b2b_invoice_previews(tenant_id,created_at DESC,id DESC);
CREATE INDEX b2b_invoice_receipt_page ON b2b_invoice_receipts(tenant_id,issued_at DESC,id DESC);
CREATE INDEX b2b_invoice_admission_root ON b2b_invoice_admissions(tenant_id,root_xid,transaction_started_at);
ALTER TABLE documents ADD CONSTRAINT documents_b2b_native_invoice CHECK(mode<>'b2b_invoice' OR(kind='invoice' AND channel_id IS NULL AND external_id IS NULL AND return_id IS NULL));
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['b2b_invoice_upgrade','b2b_invoice_previews','b2b_invoice_admissions','b2b_invoice_receipts','b2b_invoice_counters','b2b_invoice_namespaces'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY owner ON %I TO CURRENT_USER USING(true) WITH CHECK(true)',tab);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',tab);
 END LOOP;
END$$;
CREATE FUNCTION b2b_invoice_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT FROM migrations WHERE name='159_b2b_invoice')$$;
CREATE FUNCTION b2b_invoice_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN RAISE EXCEPTION 'Niezmienny dokument/receipt/zgoda159' USING ERRCODE='23514';END$$;
CREATE FUNCTION b2b_invoice_require(uid uuid,kid uuid,h text,writing boolean,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF NOT b2b_invoice_guards() OR NOT local_invoice_guards() OR NOT fa3_draft_guards() THEN RAISE EXCEPTION 'Niepełny profil wystawienia159' USING ERRCODE='55000';END IF;
 PERFORM local_invoice_identity(uid,kid,h,writing,pin);
END$$;
CREATE FUNCTION b2b_invoice_locks(project uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p fa3_draft_previews%ROWTYPE;s local_invoice_series%ROWTYPE;buyer uuid;BEGIN
 SELECT * INTO p FROM fa3_draft_previews WHERE(tenant_id,id)=(t,(SELECT preview_id FROM fa3_draft_projects WHERE(tenant_id,id)=(t,project)));
 SELECT * INTO s FROM local_invoice_series WHERE(tenant_id,id)=(t,p.series_id);
 IF p.id IS NULL OR s.id IS NULL THEN RAISE EXCEPTION 'Brak własnego rzeczywistego projektu/serii' USING ERRCODE='P0002';END IF;
 SELECT buyer_tenant_id INTO buyer FROM b2b_dropship_supplier_orders WHERE(tenant_id,order_id)=(t,p.order_id);
 -- Same genuine upstream-proof order as108/158, then seller namespace, then native invoice/merge/source locks.
 IF buyer IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('b2b.dropship.proof:'||buyer,0));END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('b2b-invoice-namespace:'||(s.definition#>>'{seller,tax_id}')||':'||s.prefix,0));
 PERFORM fa3_draft_locks(p.request);
 IF EXISTS(SELECT FROM b2b_invoice_namespaces ns WHERE(ns.seller_tax_id,ns.prefix)=(s.definition#>>'{seller,tax_id}',s.prefix)
 AND(ns.tenant_id,ns.series_id) IS DISTINCT FROM(t,s.id)) THEN RAISE EXCEPTION 'Namespace sprzedawcy wymaga odrębnej koordynacji' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION b2b_invoice_source(b jsonb,locking boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
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
 OR EXISTS(SELECT FROM documents WHERE(tenant_id,order_id)=(t,oid) AND kind IN('invoice','correction') AND NOT EXISTS(SELECT FROM b2b_invoice_admissions own_admission WHERE (own_admission.tenant_id,own_admission.document_id)=(documents.tenant_id,documents.id) AND (own_admission.root_xid,own_admission.transaction_started_at)=(pg_current_xact_id(),transaction_timestamp()) AND documents.mode='b2b_invoice' AND documents.kind='invoice' AND documents.number=own_admission.number))
 OR EXISTS(SELECT FROM invoice_plans WHERE(tenant_id,order_id)=(t,oid) AND kind='invoice' AND mode='external' AND state NOT IN('preview','cancelled'))
 OR EXISTS(SELECT FROM odoo_invoice_exports WHERE(tenant_id,order_id)=(t,oid) AND mode='external' AND state NOT IN('preview','cancelled')) THEN RAISE EXCEPTION 'Źródło ma odrębny proces lub zatwierdzoną fakturę' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('order',o,'items',items,'series',s,'command',cmd,'bridge',sb,'dropship',parent,'quote',qt);
END$$;

CREATE FUNCTION b2b_invoice_snapshot(project uuid,b jsonb,locking boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;d fa3_draft_projects%ROWTYPE;p fa3_draft_previews%ROWTYPE;r fa3_draft_receipts%ROWTYPE;src jsonb;BEGIN
 SELECT * INTO d FROM fa3_draft_projects WHERE(tenant_id,id)=(t,project);
 IF d.id IS NULL THEN RAISE EXCEPTION 'Brak własnego zatwierdzonego projektu' USING ERRCODE='P0002';END IF;
 SELECT * INTO p FROM fa3_draft_previews WHERE(tenant_id,id)=(t,d.preview_id);SELECT * INTO r FROM fa3_draft_receipts WHERE(tenant_id,project_id)=(t,d.id);
 IF p.id IS NULL OR r.id IS NULL OR(d.draft,d.draft_hash,d.scope_hash,d.order_id,r.preview_id,r.scope_hash) IS DISTINCT FROM(p.draft,p.draft_hash,p.scope_hash,p.order_id,p.id,p.scope_hash)
 OR fa3_draft_hash(d.draft)<>d.draft_hash THEN RAISE EXCEPTION 'Niepełny historyczny graf projektu' USING ERRCODE='23514';END IF;
 IF b IS DISTINCT FROM jsonb_build_object('client_key',b->'client_key','project_id',project,'issue_date',b->'issue_date','local_only',true,'confirmed_project_snapshot',true)
 OR b->>'issue_date'!~'^\d{4}-\d{2}-\d{2}$' OR(b->>'issue_date')::date NOT BETWEEN '2006-01-01'::date AND '2050-01-01'::date
 OR(b->>'issue_date')::date<(d.draft->>'sale_date')::date OR(b->>'issue_date')::date>(clock_timestamp() AT TIME ZONE 'UTC')::date
 OR EXISTS(SELECT FROM jsonb_array_elements(d.draft->'lines') ln WHERE ln->>'rounding_gross_minor'<>'0') THEN RAISE EXCEPTION 'Wymagane obsługiwane daty i zerowe różnice mapowaniaFA3' USING ERRCODE='22023';END IF;
 src:=b2b_invoice_source(p.request,locking);
 IF ((b->>'issue_date')::date+(src#>>'{series,definition,payment_terms_days}')::integer)>'2050-01-01'::date THEN RAISE EXCEPTION 'Termin wymaga odrębnego zakresu datFA3' USING ERRCODE='22023';END IF;
 IF src IS DISTINCT FROM p.source OR fa3_draft_build(src,p.request,p.shipping_id) IS DISTINCT FROM d.draft THEN RAISE EXCEPTION 'Źródło zmieniło się od zatwierdzenia projektu' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('schema','b2b-local-invoice/v1','project_id',d.id,'project_receipt_id',r.id,'project_hash',d.draft_hash,'project_scope_hash',d.scope_hash,
 'fiscal_snapshot',d.draft,'order_number',src#>'{order,number}','series_id',p.series_id,'series_definition',src#>'{series,definition}',
 'series_command_hash',src#>'{command,request_hash}','issue_date',b->'issue_date','sale_date',d.draft->'sale_date',
 'due_date',((b->>'issue_date')::date+(src#>>'{series,definition,payment_terms_days}')::integer)::text,
 'payment_mode',src#>'{order,payment_mode}','local_only',true,'ksef_state','not_submitted','fiscalized',false);
END$$;
CREATE FUNCTION b2b_invoice_preview(project uuid,b jsonb,uid uuid,kid uuid,h text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p b2b_invoice_previews%ROWTYPE;oldp fa3_draft_previews%ROWTYPE;d fa3_draft_projects%ROWTYPE;src jsonb;snap jsonb;
 rh text:=fa3_draft_hash(jsonb_build_object('request',b,'actor',uid,'key',kid));BEGIN
 PERFORM b2b_invoice_require(uid,kid,h,true,false);
 SELECT * INTO d FROM fa3_draft_projects WHERE(tenant_id,id)=(t,project);IF d.id IS NULL THEN RAISE EXCEPTION 'Brak własnego projektu' USING ERRCODE='P0002';END IF;
 SELECT * INTO oldp FROM fa3_draft_previews WHERE(tenant_id,id)=(t,d.preview_id);PERFORM b2b_invoice_locks(project);
 SELECT * INTO p FROM b2b_invoice_previews WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF p.id IS NOT NULL THEN IF(p.actor_id,p.api_key_id,p.request_hash,p.request,p.project_id) IS DISTINCT FROM(uid,kid,rh,b,project) THEN RAISE EXCEPTION 'Klucz podglądu z inną zgodą' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('id',p.id,'reused',true);END IF;
 IF EXISTS(SELECT FROM b2b_invoice_receipts WHERE(tenant_id,project_id)=(t,project)) THEN RAISE EXCEPTION 'Projekt już zużyty' USING ERRCODE='23514';END IF;
 snap:=b2b_invoice_snapshot(project,b,true);src:=b2b_invoice_source(oldp.request,false);
 INSERT INTO b2b_invoice_previews(tenant_id,project_id,project_receipt_id,order_id,series_id,actor_id,api_key_id,client_key,request_hash,request,source,snapshot,scope_hash)
 VALUES(t,project,(snap->>'project_receipt_id')::uuid,d.order_id,oldp.series_id,uid,kid,(b->>'client_key')::uuid,rh,b,src,snap,fa3_draft_hash(jsonb_build_object('request',b,'source',src,'snapshot',snap))) RETURNING * INTO p;
 PERFORM b2b_invoice_budget(t);RETURN jsonb_build_object('id',p.id,'reused',false);
END$$;
CREATE FUNCTION b2b_invoice_issue(pid uuid,b jsonb,uid uuid,kid uuid,h text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p b2b_invoice_previews%ROWTYPE;r b2b_invoice_receipts%ROWTYPE;oldp fa3_draft_previews%ROWTYPE;
 did uuid:=gen_random_uuid();rid uuid:=gen_random_uuid();rh text:=fa3_draft_hash(jsonb_build_object('preview',pid,'request',b,'actor',uid,'key',kid));yr integer;seq integer;num text;prefix text;snap jsonb;BEGIN
 PERFORM b2b_invoice_require(uid,kid,h,true,false);SELECT * INTO p FROM b2b_invoice_previews WHERE(tenant_id,id)=(t,pid);
 IF p.id IS NULL THEN RAISE EXCEPTION 'Brak podglądu FV' USING ERRCODE='P0002';END IF;
 SELECT * INTO oldp FROM fa3_draft_previews WHERE(tenant_id,id)=(t,(SELECT preview_id FROM fa3_draft_projects WHERE(tenant_id,id)=(t,p.project_id)));
 PERFORM b2b_invoice_locks(p.project_id);
 SELECT * INTO r FROM b2b_invoice_receipts WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF r.id IS NOT NULL THEN IF(r.preview_id,r.actor_id,r.api_key_id,r.request_hash,r.request) IS DISTINCT FROM(pid,uid,kid,rh,b) THEN RAISE EXCEPTION 'Klucz wystawienia z inną zgodą' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('document_id',r.document_id,'receipt_id',r.id,'reused',true);END IF;
 IF(p.actor_id,p.api_key_id) IS DISTINCT FROM(uid,kid) OR p.expires_at<=clock_timestamp()
 OR b IS DISTINCT FROM jsonb_build_object('client_key',b->'client_key','scope_hash',p.scope_hash,'confirmed',true,'local_only',true) THEN RAISE EXCEPTION 'Brak osobnej aktualnej zgody FV' USING ERRCODE='23514';END IF;
 snap:=b2b_invoice_snapshot(p.project_id,p.request,true);
 IF snap IS DISTINCT FROM p.snapshot OR p.source IS DISTINCT FROM b2b_invoice_source(oldp.request,false)
 OR EXISTS(SELECT FROM b2b_invoice_receipts WHERE(tenant_id,project_id)=(t,p.project_id)) THEN RAISE EXCEPTION 'Projekt lub źródło już zmienione/zużyte' USING ERRCODE='23514';END IF;
 yr:=extract(year FROM(p.snapshot->>'issue_date')::date)::integer;SELECT last_number+1 INTO seq FROM b2b_invoice_counters WHERE(tenant_id,series_id,year)=(t,p.series_id,yr) FOR UPDATE;seq:=coalesce(seq,1);
 IF seq>999999 THEN RAISE EXCEPTION 'Numeracja wyczerpana' USING ERRCODE='23514';END IF;
 SELECT series.prefix INTO prefix FROM local_invoice_series series WHERE(series.tenant_id,series.id)=(t,p.series_id);
 num:='FV-B2B/'||prefix||'/'||yr::text||'/'||lpad(seq::text,6,'0');
 IF EXISTS(SELECT FROM documents WHERE tenant_id=t AND number=num) THEN RAISE EXCEPTION 'Rzeczywisty numer już istnieje' USING ERRCODE='23514';END IF;
 INSERT INTO b2b_invoice_admissions(id,tenant_id,document_id,preview_id,project_id,actor_id,api_key_id,client_key,request_hash,request,year,sequence,number)
 VALUES(rid,t,did,pid,p.project_id,uid,kid,(b->>'client_key')::uuid,rh,b,yr,seq,num);
 IF NOT EXISTS(SELECT FROM b2b_invoice_namespaces ns WHERE(ns.tenant_id,ns.series_id)=(t,p.series_id)) THEN
  INSERT INTO b2b_invoice_namespaces(seller_tax_id,prefix,tenant_id,series_id) SELECT native_series.definition#>>'{seller,tax_id}',native_series.prefix,t,native_series.id FROM local_invoice_series native_series WHERE(native_series.tenant_id,native_series.id)=(t,p.series_id);
 END IF;
 IF NOT EXISTS(SELECT FROM b2b_invoice_counters WHERE(tenant_id,series_id,year)=(t,p.series_id,yr)) THEN INSERT INTO b2b_invoice_counters VALUES(t,p.series_id,yr,0);END IF;
 snap:=snap||jsonb_build_object('number',num,'year',yr,'sequence',seq,'preview_id',pid,'scope_hash',p.scope_hash);
 INSERT INTO documents(id,tenant_id,order_id,kind,mode,number,data) VALUES(did,t,p.order_id,'invoice','b2b_invoice',num,snap);
 INSERT INTO b2b_invoice_receipts(id,tenant_id,document_id,preview_id,project_id,project_receipt_id,order_id,series_id,actor_id,api_key_id,client_key,request_hash,request,scope_hash,snapshot,year,sequence,number)
 VALUES(rid,t,did,pid,p.project_id,p.project_receipt_id,p.order_id,p.series_id,uid,kid,(b->>'client_key')::uuid,rh,b,p.scope_hash,snap,yr,seq,num);
 UPDATE b2b_invoice_counters SET last_number=seq WHERE(tenant_id,series_id,year)=(t,p.series_id,yr);
 RETURN jsonb_build_object('document_id',did,'receipt_id',rid,'reused',false);
END$$;
CREATE FUNCTION b2b_invoice_budget(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF(SELECT count(*) FROM b2b_invoice_previews WHERE tenant_id=t)>10000 OR(SELECT coalesce(sum(octet_length(snapshot::text)+octet_length(source::text)+octet_length(request::text)),0) FROM b2b_invoice_previews WHERE tenant_id=t)>33554432 THEN RAISE EXCEPTION 'Budżet pełnych FV przekroczony' USING ERRCODE='54000';END IF;
END$$;
CREATE FUNCTION b2b_invoice_record_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p b2b_invoice_previews%ROWTYPE;a b2b_invoice_admissions%ROWTYPE;raw jsonb:=to_jsonb(NEW);prev fa3_draft_previews%ROWTYPE;n integer;prefix text;BEGIN
 IF NOT b2b_invoice_guards() OR NEW.tenant_id IS DISTINCT FROM t THEN RAISE EXCEPTION 'Brak prawdziwego kontekstu159' USING ERRCODE='55000';END IF;
 IF TG_TABLE_NAME='b2b_invoice_previews' THEN
  SELECT * INTO prev FROM fa3_draft_previews WHERE(tenant_id,id)=(t,(SELECT preview_id FROM fa3_draft_projects WHERE(tenant_id,id)=(t,NEW.project_id)));
  IF NEW.snapshot IS DISTINCT FROM b2b_invoice_snapshot(NEW.project_id,NEW.request,false)
  OR NEW.source IS DISTINCT FROM b2b_invoice_source(prev.request,false)
  OR(NEW.order_id,NEW.series_id,NEW.project_receipt_id) IS DISTINCT FROM(prev.order_id,prev.series_id,(NEW.snapshot->>'project_receipt_id')::uuid)
  OR NEW.request_hash<>fa3_draft_hash(jsonb_build_object('request',NEW.request,'actor',NEW.actor_id,'key',NEW.api_key_id))
  OR NEW.scope_hash<>fa3_draft_hash(jsonb_build_object('request',NEW.request,'source',NEW.source,'snapshot',NEW.snapshot))
  OR NEW.created_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp() OR NEW.expires_at>NEW.created_at+interval '15 minutes 1 second' THEN RAISE EXCEPTION 'Niepełny prawdziwy podgląd159' USING ERRCODE='23514';END IF;
  PERFORM b2b_invoice_require(NEW.actor_id,NEW.api_key_id,current_setting('b2b_invoice.identity_hash',true),true,false);
 ELSE
  SELECT * INTO p FROM b2b_invoice_previews WHERE(tenant_id,id)=(t,(raw->>'preview_id')::uuid);IF p.id IS NULL THEN RAISE EXCEPTION 'Brak rzeczywistego podglądu159' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='b2b_invoice_admissions' THEN
   SELECT last_number+1 INTO n FROM b2b_invoice_counters WHERE(tenant_id,series_id,year)=(t,p.series_id,NEW.year);n:=coalesce(n,1);
   SELECT native_series.prefix INTO prefix FROM local_invoice_series native_series WHERE(native_series.tenant_id,native_series.id)=(t,p.series_id);
   IF(NEW.root_xid,NEW.transaction_started_at) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp())
   OR(NEW.actor_id,NEW.api_key_id,NEW.project_id) IS DISTINCT FROM(p.actor_id,p.api_key_id,p.project_id)
   OR NEW.request IS DISTINCT FROM jsonb_build_object('client_key',NEW.client_key,'scope_hash',p.scope_hash,'confirmed',true,'local_only',true)
   OR NEW.request_hash<>fa3_draft_hash(jsonb_build_object('preview',p.id,'request',NEW.request,'actor',NEW.actor_id,'key',NEW.api_key_id))
   OR NEW.year<>extract(year FROM(p.snapshot->>'issue_date')::date)::integer OR NEW.sequence<>n
   OR NEW.number IS DISTINCT FROM 'FV-B2B/'||prefix||'/'||NEW.year::text||'/'||lpad(NEW.sequence::text,6,'0')
   OR p.expires_at<=clock_timestamp() OR p.snapshot IS DISTINCT FROM b2b_invoice_snapshot(p.project_id,p.request,false) THEN RAISE EXCEPTION 'Obca/historyczna zgoda wystawienia159' USING ERRCODE='23514';END IF;
   PERFORM b2b_invoice_require(NEW.actor_id,NEW.api_key_id,current_setting('b2b_invoice.identity_hash',true),true,false);
  ELSE
   SELECT * INTO a FROM b2b_invoice_admissions WHERE(tenant_id,document_id)=(t,NEW.document_id);
   IF a.id IS NULL OR(a.root_xid,a.transaction_started_at) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp())
   OR(NEW.id,NEW.preview_id,NEW.project_id,NEW.actor_id,NEW.api_key_id,NEW.client_key,NEW.request_hash,NEW.request,NEW.root_xid,NEW.transaction_started_at,NEW.year,NEW.sequence,NEW.number)
    IS DISTINCT FROM(a.id,a.preview_id,a.project_id,a.actor_id,a.api_key_id,a.client_key,a.request_hash,a.request,a.root_xid,a.transaction_started_at,a.year,a.sequence,a.number)
   OR(NEW.order_id,NEW.series_id,NEW.project_receipt_id,NEW.scope_hash) IS DISTINCT FROM(p.order_id,p.series_id,p.project_receipt_id,p.scope_hash)
   OR NEW.snapshot IS DISTINCT FROM(p.snapshot||jsonb_build_object('number',a.number,'year',a.year,'sequence',a.sequence,'preview_id',p.id,'scope_hash',p.scope_hash))
   THEN RAISE EXCEPTION 'Receipt zużycia nie odpowiada aktualnemu wystawieniu' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;
END$$;
CREATE FUNCTION b2b_invoice_document_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE p b2b_invoice_previews%ROWTYPE;a b2b_invoice_admissions%ROWTYPE;BEGIN
 IF TG_OP<>'INSERT' AND OLD.mode='b2b_invoice' THEN RAISE EXCEPTION 'Niezmienny natywny dokument159' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;IF NEW.mode<>'b2b_invoice' THEN RETURN NEW;END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Nie wolno przepisać dokumentu na FV159' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM b2b_invoice_admissions WHERE(tenant_id,document_id)=(NEW.tenant_id,NEW.id);
 SELECT * INTO p FROM b2b_invoice_previews WHERE(tenant_id,id)=(NEW.tenant_id,a.preview_id);
 IF a.id IS NULL OR p.id IS NULL OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
 OR(a.root_xid,a.transaction_started_at) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp())
 OR(NEW.kind,NEW.mode,NEW.order_id,NEW.number,NEW.channel_id,NEW.external_id,NEW.return_id) IS DISTINCT FROM('invoice'::text,'b2b_invoice'::text,p.order_id,a.number,NULL::uuid,NULL::text,NULL::uuid)
 OR NEW.data IS DISTINCT FROM(p.snapshot||jsonb_build_object('number',a.number,'year',a.year,'sequence',a.sequence,'preview_id',p.id,'scope_hash',p.scope_hash)) THEN RAISE EXCEPTION 'Dokument159 bez prawdziwej bieżącej zgody' USING ERRCODE='23514';END IF;
 PERFORM b2b_invoice_require(a.actor_id,a.api_key_id,current_setting('b2b_invoice.identity_hash',true),true,false);RETURN NEW;
END$$;
CREATE FUNCTION b2b_invoice_namespace_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Niezmienna własność namespace sprzedawcy' USING ERRCODE='23514';END IF;
 IF NOT b2b_invoice_guards() OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
 OR NOT EXISTS(SELECT FROM local_invoice_series native_series JOIN b2b_invoice_previews p ON(p.tenant_id,p.series_id)=(native_series.tenant_id,native_series.id)
 JOIN b2b_invoice_admissions a ON(a.tenant_id,a.preview_id)=(p.tenant_id,p.id)
 WHERE(native_series.tenant_id,native_series.id,native_series.prefix,native_series.definition#>>'{seller,tax_id}')=(NEW.tenant_id,NEW.series_id,NEW.prefix,NEW.seller_tax_id)
 AND(a.root_xid,a.transaction_started_at)=(pg_current_xact_id(),transaction_timestamp())) THEN RAISE EXCEPTION 'Namespace bez własnej rzeczywistej zgody' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE FUNCTION b2b_invoice_counter_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Nie wolno usunąć numeracji159' USING ERRCODE='23514';END IF;
 IF NOT b2b_invoice_guards() OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Brak kontekstu numeracji159' USING ERRCODE='55000';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.last_number<>0 OR NOT EXISTS(SELECT FROM b2b_invoice_admissions a JOIN b2b_invoice_previews p ON(p.tenant_id,p.id)=(a.tenant_id,a.preview_id)
   WHERE(a.tenant_id,p.series_id,a.year,a.sequence)=(NEW.tenant_id,NEW.series_id,NEW.year,1) AND(a.root_xid,a.transaction_started_at)=(pg_current_xact_id(),transaction_timestamp())) THEN RAISE EXCEPTION 'Licznik bez bieżącej pierwszej zgody' USING ERRCODE='23514';END IF;
 ELSE
  IF(NEW.tenant_id,NEW.series_id,NEW.year) IS DISTINCT FROM(OLD.tenant_id,OLD.series_id,OLD.year) OR NEW.last_number<>OLD.last_number+1
  OR NOT EXISTS(SELECT FROM b2b_invoice_receipts r WHERE(r.tenant_id,r.series_id,r.year,r.sequence)=(NEW.tenant_id,NEW.series_id,NEW.year,NEW.last_number)
  AND(r.root_xid,r.transaction_started_at)=(pg_current_xact_id(),transaction_timestamp())) THEN RAISE EXCEPTION 'Licznik nie odpowiada własnemu receipt' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END$$;
CREATE FUNCTION b2b_invoice_validate(did uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p b2b_invoice_previews%ROWTYPE;a b2b_invoice_admissions%ROWTYPE;r b2b_invoice_receipts%ROWTYPE;d documents%ROWTYPE;n integer;BEGIN
 SELECT * INTO d FROM documents WHERE(tenant_id,id)=(t,did);SELECT * INTO a FROM b2b_invoice_admissions WHERE(tenant_id,document_id)=(t,did);
 SELECT * INTO r FROM b2b_invoice_receipts WHERE(tenant_id,document_id)=(t,did);SELECT * INTO p FROM b2b_invoice_previews WHERE(tenant_id,id)=(t,a.preview_id);
 SELECT last_number INTO n FROM b2b_invoice_counters WHERE(tenant_id,series_id,year)=(t,p.series_id,a.year);
 IF a.id IS NULL OR r.id IS NULL OR p.id IS NULL OR d.id IS NULL OR(a.root_xid,a.transaction_started_at) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp())
 OR(a.id,a.preview_id,a.project_id,a.actor_id,a.api_key_id,a.client_key,a.request_hash,a.request,a.root_xid,a.transaction_started_at,a.number,a.year,a.sequence)
 IS DISTINCT FROM(r.id,r.preview_id,r.project_id,r.actor_id,r.api_key_id,r.client_key,r.request_hash,r.request,r.root_xid,r.transaction_started_at,r.number,r.year,r.sequence)
 OR(r.project_receipt_id,r.order_id,r.series_id,r.scope_hash) IS DISTINCT FROM(p.project_receipt_id,p.order_id,p.series_id,p.scope_hash)
 OR(d.kind,d.mode,d.order_id,d.number,d.channel_id,d.external_id,d.return_id) IS DISTINCT FROM('invoice'::text,'b2b_invoice'::text,p.order_id,a.number,NULL::uuid,NULL::text,NULL::uuid)
 OR r.snapshot IS DISTINCT FROM(p.snapshot||jsonb_build_object('number',a.number,'year',a.year,'sequence',a.sequence,'preview_id',p.id,'scope_hash',p.scope_hash))
 OR d.data IS DISTINCT FROM r.snapshot OR n IS DISTINCT FROM a.sequence
 OR NOT EXISTS(SELECT FROM b2b_invoice_namespaces ns WHERE(ns.tenant_id,ns.series_id,ns.seller_tax_id,ns.prefix)=(t,p.series_id,p.snapshot#>>'{fiscal_snapshot,seller,tax_id}',p.snapshot#>>'{series_definition,prefix}')) OR p.snapshot IS DISTINCT FROM b2b_invoice_snapshot(p.project_id,p.request,false)
 THEN RAISE EXCEPTION 'Niepełny bieżący graf FV159/zużycia projektu' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION b2b_invoice_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_TABLE_NAME<>'b2b_invoice_previews' THEN PERFORM b2b_invoice_validate(NEW.document_id);END IF;
 PERFORM b2b_invoice_budget(NEW.tenant_id);RETURN NEW;
END$$;
CREATE FUNCTION b2b_invoice_source_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE raw jsonb;before jsonb;after jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN before:=to_jsonb(OLD);END IF;IF TG_OP<>'DELETE' THEN after:=to_jsonb(NEW);END IF;
 FOR raw IN SELECT before UNION ALL SELECT after LOOP
  IF raw IS NULL THEN CONTINUE;END IF;
  IF EXISTS(SELECT FROM b2b_invoice_admissions a JOIN b2b_invoice_previews p ON(p.tenant_id,p.id)=(a.tenant_id,a.preview_id)
    WHERE(a.root_xid,a.transaction_started_at)=(pg_current_xact_id(),transaction_timestamp()) AND(
    (raw->>'tenant_id'=p.tenant_id::text AND CASE WHEN TG_TABLE_NAME='orders' THEN raw->>'id'=p.order_id::text
     WHEN TG_TABLE_NAME='order_merge_claims' THEN raw->>'source_order_id'=p.order_id::text
     WHEN TG_TABLE_NAME IN('local_invoice_series','local_invoice_series_commands') THEN coalesce(raw->>'series_id',raw->>'id')=p.series_id::text
     ELSE raw->>'order_id'=p.order_id::text END)
    OR(TG_TABLE_NAME='b2b_dropship_orders' AND(raw->>'tenant_id',raw->>'id')=(p.source#>>'{dropship,tenant_id}',p.source#>>'{dropship,id}'))
    OR(TG_TABLE_NAME='b2b_dropship_quotes' AND(raw->>'tenant_id',raw->>'id')=(p.source#>>'{quote,tenant_id}',p.source#>>'{quote,id}')))) THEN
   IF TG_TABLE_NAME='documents' AND TG_OP='INSERT' AND raw->>'mode'='b2b_invoice' AND EXISTS(SELECT FROM b2b_invoice_admissions own
    WHERE(own.tenant_id,own.document_id,own.number)=((raw->>'tenant_id')::uuid,(raw->>'id')::uuid,raw->>'number')
    AND(own.root_xid,own.transaction_started_at)=(pg_current_xact_id(),transaction_timestamp())) THEN CONTINUE;END IF;
   RAISE EXCEPTION 'Źródło wystawienia159 zapieczętowane do końca transakcji' USING ERRCODE='23514';
  END IF;
 END LOOP;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
CREATE FUNCTION b2b_invoice_terminal(uid uuid,kid uuid,h text,writing boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v record;g jsonb;stamp timestamptz;BEGIN
 PERFORM local_invoice_identity(uid,kid,h,writing,true);
 IF NOT b2b_invoice_guards() OR NOT fa3_draft_guards() OR NOT local_invoice_guards() THEN RAISE EXCEPTION 'Metadane159 zmieniły się po oczekiwaniu' USING ERRCODE='55000';END IF;
 FOR v IN SELECT document_id FROM b2b_invoice_admissions WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND(root_xid,transaction_started_at)=(pg_current_xact_id(),transaction_timestamp()) LOOP PERFORM b2b_invoice_validate(v.document_id);END LOOP;
 IF EXISTS(SELECT FROM b2b_invoice_admissions a JOIN b2b_invoice_previews p ON(p.tenant_id,p.id)=(a.tenant_id,a.preview_id)
 WHERE(a.root_xid,a.transaction_started_at)=(pg_current_xact_id(),transaction_timestamp()) AND p.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Zgoda159 wygasła podczas oczekiwania' USING ERRCODE='23514';END IF;
 g:=local_invoice_access(uid,kid,true,false);stamp:=clock_timestamp();PERFORM local_invoice_identity(uid,kid,h,writing,false);
 RETURN g||jsonb_build_object('stamp',stamp);
END$$;
CREATE FUNCTION b2b_invoice_upgrade_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_OP<>'INSERT' OR to_regclass('pg_temp.b2b_invoice_migration_basis') IS NULL THEN RAISE EXCEPTION 'Niezmienny certyfikat upgrade159' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT FROM pg_temp.b2b_invoice_migration_basis basis WHERE(NEW.original_manifest,NEW.predecessor_fingerprint,NEW.guard_body_hash,NEW.seal_body_hash) IS NOT DISTINCT FROM(basis.original_manifest,basis.predecessor_fingerprint,basis.guard_body_hash,basis.seal_body_hash))
 OR NEW.original_manifest IS DISTINCT FROM(SELECT to_jsonb(m) FROM fa3_draft_manifest m WHERE id)
 OR NEW.successor158_fingerprint IS DISTINCT FROM fa3_draft_fingerprint() OR NEW.successor159_fingerprint IS DISTINCT FROM b2b_invoice_fingerprint()
 THEN RAISE EXCEPTION 'Certyfikat nie odpowiada dokładnemu upgrade159' USING ERRCODE='55000';END IF;RETURN NEW;
END$$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['b2b_invoice_previews','b2b_invoice_admissions','b2b_invoice_receipts'] LOOP
 EXECUTE format('CREATE TRIGGER b2b_invoice_record_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION b2b_invoice_record_guard()',tab);
 EXECUTE format('CREATE TRIGGER b2b_invoice_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION b2b_invoice_immutable()',tab);
 EXECUTE format('CREATE CONSTRAINT TRIGGER b2b_invoice_complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_invoice_complete()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['orders','order_items','return_cases','order_merge_claims','documents','invoice_plans','odoo_invoice_exports','b2b_dropship_supplier_orders','b2b_dropship_orders','b2b_dropship_quotes'] LOOP
 EXECUTE format('CREATE TRIGGER b2b_invoice_source_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION b2b_invoice_source_seal()',tab);END LOOP;
END$$;
CREATE TRIGGER b2b_invoice_document_guard BEFORE INSERT OR UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION b2b_invoice_document_guard();
CREATE TRIGGER b2b_invoice_namespace_guard BEFORE INSERT OR UPDATE OR DELETE ON b2b_invoice_namespaces FOR EACH ROW EXECUTE FUNCTION b2b_invoice_namespace_guard();
CREATE TRIGGER b2b_invoice_counter_guard BEFORE INSERT OR UPDATE OR DELETE ON b2b_invoice_counters FOR EACH ROW EXECUTE FUNCTION b2b_invoice_counter_guard();
CREATE TRIGGER b2b_invoice_upgrade_guard BEFORE INSERT OR UPDATE OR DELETE ON b2b_invoice_upgrade FOR EACH ROW EXECUTE FUNCTION b2b_invoice_upgrade_guard();
CREATE FUNCTION public.b2b_invoice_fingerprint() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT md5(jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
 'acl',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a),
 'cols',(SELECT jsonb_agg(jsonb_build_array(x.attname,format_type(x.atttypid,x.atttypmod),x.attnotnull,x.attgenerated,x.attidentity,(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(ca.grantor),CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,ca.is_grantable) ORDER BY CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,pg_get_userbyid(ca.grantor)::text,ca.is_grantable) FROM aclexplode(x.attacl)ca),pg_get_expr(d.adbin,d.adrelid)) ORDER BY x.attnum) FROM pg_attribute x LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(x.attrelid,x.attnum) WHERE x.attrelid=c.oid AND x.attnum>0 AND NOT x.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid,true)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'policies',(SELECT jsonb_agg(jsonb_build_array(po.polname,(SELECT array_agg(CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END ORDER BY CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END) FROM unnest(po.polroles)x),po.polcmd,pg_get_expr(po.polqual,po.polrelid),pg_get_expr(po.polwithcheck,po.polrelid)) ORDER BY po.polname) FROM pg_policy po WHERE po.polrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(tr.tgname,tr.tgenabled,pg_get_triggerdef(tr.oid,true)) ORDER BY tr.tgname) FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND (c.relname LIKE 'b2b\_invoice\_%' ESCAPE '\' OR c.relname LIKE 'fa3\_draft\_%' ESCAPE '\' OR c.relname LIKE 'b2b\_dropship\_%' ESCAPE '\' OR c.relname IN('local_invoice_series','local_invoice_series_commands','orders','order_items','order_merge_claims','return_cases','documents','invoice_plans','odoo_invoice_exports','users','sessions','memberships','api_keys','account_security','workspace_security_policies','tenants')) AND c.relkind IN('r','p')),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.provolatile,p.proisstrict,p.proleakproof,p.proparallel,p.prokind,p.proretset,p.prorettype,pg_get_function_identity_arguments(p.oid),pg_get_function_result(p.oid),p.proargmodes,p.proargnames,pg_get_expr(p.proargdefaults,0),(SELECT lanname FROM pg_language WHERE oid=p.prolang),(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND ((p.proname LIKE 'b2b\_invoice\_%' ESCAPE '\' OR p.proname LIKE 'fa3\_draft\_%' ESCAPE '\' OR p.proname LIKE 'local\_invoice\_%' ESCAPE '\' OR p.proname LIKE 'b2b\_dropship\_%' ESCAPE '\') OR p.oid IN(SELECT tr.tgfoid FROM pg_trigger tr JOIN pg_class rel ON rel.oid=tr.tgrelid WHERE rel.relnamespace='public'::regnamespace AND NOT tr.tgisinternal AND rel.relname IN('orders','order_items','order_merge_claims','return_cases','documents','invoice_plans','odoo_invoice_exports','users','sessions','memberships','api_keys','account_security','workspace_security_policies','tenants')))),
 'documents_checks',(SELECT jsonb_agg(jsonb_build_array(conname,convalidated,pg_get_constraintdef(oid,true)) ORDER BY conname) FROM pg_constraint WHERE conrelid='public.documents'::regclass AND conname IN('documents_kind_check','documents_proforma_local','documents_native_invoice')),
 'document_indexes',(SELECT jsonb_agg(jsonb_build_array(c.relname,i.indisvalid,pg_get_indexdef(i.indexrelid)) ORDER BY c.relname) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN('document_order_mode','document_demo_number')),
 'parent_triggers',(SELECT jsonb_agg(jsonb_build_array(tgname,tgenabled,pg_get_triggerdef(oid,true)) ORDER BY tgrelid::regclass::text,tgname) FROM pg_trigger WHERE tgfoid IN(SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND(proname LIKE 'b2b\_invoice\_%' ESCAPE '\' OR proname LIKE 'fa3\_draft\_%' ESCAPE '\' OR proname LIKE 'b2b\_dropship\_%' ESCAPE '\')))
 )::text) $$;
CREATE FUNCTION b2b_invoice_upgrade_valid() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE sig text;c record;BEGIN
 IF current_setting('session_replication_role')<>'origin' OR to_regclass('public.b2b_invoice_upgrade') IS NULL OR to_regclass('public.fa3_draft_manifest') IS NULL OR to_regprocedure('public.fa3_draft_fingerprint()') IS NULL THEN RETURN false;END IF;
 FOREACH sig IN ARRAY ARRAY['b2b_invoice_locks(uuid)','b2b_invoice_namespace_guard()','b2b_invoice_installed()','b2b_invoice_immutable()','b2b_invoice_require(uuid,uuid,text,boolean,boolean)','b2b_invoice_source(jsonb,boolean)','b2b_invoice_snapshot(uuid,jsonb,boolean)','b2b_invoice_preview(uuid,jsonb,uuid,uuid,text)','b2b_invoice_issue(uuid,jsonb,uuid,uuid,text)','b2b_invoice_budget(uuid)','b2b_invoice_record_guard()','b2b_invoice_document_guard()','b2b_invoice_counter_guard()','b2b_invoice_validate(uuid)','b2b_invoice_complete()','b2b_invoice_source_seal()','b2b_invoice_terminal(uuid,uuid,text,boolean)','b2b_invoice_upgrade_guard()','b2b_invoice_fingerprint()','b2b_invoice_upgrade_valid()','b2b_invoice_guards()'] LOOP IF to_regprocedure('public.'||sig) IS NULL THEN RETURN false;END IF;END LOOP;
 IF(SELECT count(*) FROM b2b_invoice_upgrade)<>1 OR(SELECT count(*) FROM fa3_draft_manifest)<>1 THEN RETURN false;END IF;
 SELECT * INTO c FROM b2b_invoice_upgrade WHERE id;
 RETURN coalesce(c.profile='158-original-to159-local-issued/v1' AND c.original_manifest=(SELECT to_jsonb(m) FROM fa3_draft_manifest m WHERE id)
 AND c.predecessor_fingerprint=c.original_manifest->>'fingerprint' AND c.successor158_fingerprint=fa3_draft_fingerprint()
 AND c.successor159_fingerprint=b2b_invoice_fingerprint(),false);
END$$;
CREATE FUNCTION b2b_invoice_guards() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF to_regprocedure('public.b2b_invoice_installed()') IS NULL OR to_regprocedure('public.b2b_invoice_upgrade_valid()') IS NULL THEN RETURN false;END IF;
 IF NOT b2b_invoice_installed() OR(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'b2b\_invoice\_%' ESCAPE '\' AND relkind IN('r','p') AND relrowsecurity AND relforcerowsecurity)<>6 THEN RETURN false;END IF;
 RETURN b2b_invoice_upgrade_valid();
END$$;
CREATE OR REPLACE FUNCTION fa3_draft_guards() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE sig text;BEGIN
 IF current_setting('session_replication_role')<>'origin' THEN RETURN false;END IF;
 FOREACH sig IN ARRAY ARRAY['fa3_draft_hash(jsonb)','fa3_draft_require(uuid,uuid,text,boolean,boolean)','fa3_draft_locks(jsonb)','fa3_draft_source(jsonb,boolean)','fa3_draft_build(jsonb,jsonb,uuid)','fa3_draft_budget(uuid)','fa3_draft_store_preview(jsonb,uuid,jsonb,uuid,uuid,text)','fa3_draft_approve(uuid,jsonb,uuid,uuid,text)','fa3_draft_immutable()','fa3_draft_record_guard()','fa3_draft_validate(uuid)','fa3_draft_complete()','fa3_draft_source_seal()','fa3_draft_invoice_seal()','fa3_draft_terminal(uuid,uuid,text,boolean)','fa3_draft_fingerprint()','fa3_draft_installed()','fa3_draft_guards()','local_invoice_guards()','local_invoice_identity(uuid,uuid,text,boolean,boolean)','b2b_dropship_installed()'] LOOP
 IF to_regprocedure('public.'||sig) IS NULL THEN RETURN false;END IF;END LOOP;
 IF(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'fa3\_draft\_%' ESCAPE '\' AND relkind IN('r','p') AND relrowsecurity AND relforcerowsecurity)<>5 THEN RETURN false;END IF;
 IF to_regclass('public.fa3_draft_manifest') IS NULL THEN RETURN false;END IF;
 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'b2b\_invoice\_%' ESCAPE '\')
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'b2b\_invoice\_%' ESCAPE '\') THEN
  IF to_regprocedure('public.b2b_invoice_upgrade_valid()') IS NULL OR to_regprocedure('public.b2b_invoice_installed()') IS NULL THEN RETURN false;END IF;
  RETURN b2b_invoice_installed() AND b2b_invoice_upgrade_valid();
 END IF;
 RETURN coalesce((SELECT fingerprint=fa3_draft_fingerprint() FROM fa3_draft_manifest WHERE id),false);
END$$;
CREATE OR REPLACE FUNCTION fa3_draft_invoice_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE rowdata jsonb;BEGIN
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;rowdata:=to_jsonb(NEW);
 -- One certified new native command, no general mode/protocol exception.
 IF TG_TABLE_NAME='documents' AND TG_OP='INSERT' AND rowdata->>'mode'='b2b_invoice' AND rowdata->>'kind'='invoice'
 AND b2b_invoice_guards() AND EXISTS(SELECT FROM b2b_invoice_admissions own JOIN b2b_invoice_previews p ON(p.tenant_id,p.id)=(own.tenant_id,own.preview_id)
 WHERE(own.tenant_id,own.document_id,own.number)=((rowdata->>'tenant_id')::uuid,(rowdata->>'id')::uuid,rowdata->>'number') AND p.order_id=(rowdata->>'order_id')::uuid
 AND(own.root_xid,own.transaction_started_at)=(pg_current_xact_id(),transaction_timestamp())
 AND rowdata->'data'=(p.snapshot||jsonb_build_object('number',own.number,'year',own.year,'sequence',own.sequence,'preview_id',p.id,'scope_hash',p.scope_hash))) THEN RETURN NEW;END IF;
 IF((TG_TABLE_NAME='documents' AND rowdata->>'kind' IN('invoice','correction')) OR TG_TABLE_NAME='local_invoice_previews'
 OR(TG_TABLE_NAME='invoice_plans' AND rowdata->>'kind'='invoice' AND rowdata->>'mode'='external' AND rowdata->>'state' NOT IN('preview','cancelled'))
 OR(TG_TABLE_NAME='odoo_invoice_exports' AND rowdata->>'mode'='external' AND rowdata->>'state' NOT IN('preview','cancelled')))
 AND EXISTS(SELECT FROM fa3_draft_projects WHERE(tenant_id,order_id)=((rowdata->>'tenant_id')::uuid,(rowdata->>'order_id')::uuid)) THEN RAISE EXCEPTION 'Zamówienie ma zatwierdzony projekt B2B; wymagany odrębny proces wystawienia' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
DO $$DECLARE fn record;BEGIN FOR fn IN SELECT p.oid::regprocedure sig FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'b2b\_invoice\_%' ESCAPE '\' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',fn.sig);END LOOP;END$$;
GRANT EXECUTE ON FUNCTION b2b_invoice_installed(),b2b_invoice_guards(),b2b_invoice_terminal(uuid,uuid,text,boolean) TO dyna_app;
INSERT INTO b2b_invoice_upgrade(id,profile,original_manifest,predecessor_fingerprint,guard_body_hash,seal_body_hash,successor158_fingerprint,successor159_fingerprint)
 SELECT true,'158-original-to159-local-issued/v1',original_manifest,predecessor_fingerprint,guard_body_hash,seal_body_hash,fa3_draft_fingerprint(),b2b_invoice_fingerprint() FROM pg_temp.b2b_invoice_migration_basis;
-- No manifest reseed, ALTER of157 named checks/functions, grant to private evidence, or legacy row rewrite.
DO $$BEGIN
 IF NOT b2b_invoice_upgrade_valid() OR NOT local_invoice_guards()
 OR(SELECT to_jsonb(m) FROM fa3_draft_manifest m WHERE id) IS DISTINCT FROM(SELECT original_manifest FROM pg_temp.b2b_invoice_migration_basis)
 THEN RAISE EXCEPTION 'Upgrade159 nie zachował kompletnego profilu157/158' USING ERRCODE='55000';END IF;
END$$;
