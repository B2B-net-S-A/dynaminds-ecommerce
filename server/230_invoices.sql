-- Successor to229, registered in db.ts migrate() after229 (23.10.2026).
-- Invoices the 157 local invoice cannot express (stage 3, step 5): a B2B buyer (NIP, EU VAT
-- ID), lines exempt (ZW), outside the scope (NP I/NP II), reverse charge (OO), OSS, and EUR
-- invoices with the NBP rate stored at issue. Numbering is an own sub-series of a 157 series
-- definition, FV-S/<prefix>/<year>/<sequence>, continuous within itself (the 157 counter can
-- only move with a 157 receipt). Only own tables are added; the one foreign key to a core
-- table is invoice230_documents -> documents. No trigger, column, constraint or grant is
-- attached to a core table.
DO $dependency230$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.ksef229_submissions') IS NULL
 OR to_regclass('public.local_invoice_series') IS NULL
 OR to_regclass('public.documents') IS NULL
 THEN RAISE EXCEPTION 'Faktury 230 wymagają zainstalowanego229' USING ERRCODE='55000';END IF;
END
$dependency230$;

-- What the user saw and confirmed: the full document snapshot, valid for 15 minutes.
CREATE TABLE public.invoice230_previews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 order_id uuid NOT NULL,
 order_version bigint NOT NULL CHECK(order_version>0),
 series_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 api_key_id uuid,
 client_key uuid NOT NULL,
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object' AND octet_length(request::text)<=65536),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=1048576),
 scope_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,client_key),
 CHECK(scope_hash=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')),
 CHECK(expires_at=created_at+interval '15 minutes')
);
CREATE INDEX invoice230_previews_order ON public.invoice230_previews(tenant_id,order_id,created_at DESC);

-- Last number of the sub-series per 157 series and year; moves by exactly one per issue.
CREATE TABLE public.invoice230_counters (
 tenant_id uuid NOT NULL,
 series_id uuid NOT NULL,
 year integer NOT NULL CHECK(year BETWEEN 2006 AND 2050),
 last_number integer NOT NULL CHECK(last_number BETWEEN 1 AND 999999),
 PRIMARY KEY(tenant_id,series_id,year)
);

-- The issued document: buyer, procedure, totals, MPP, exemption basis and, for EUR, the NBP
-- rate of the tax point with the PLN totals. `snapshot` equals documents.data of the document.
CREATE TABLE public.invoice230_documents (
 document_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 preview_id uuid NOT NULL,
 order_id uuid NOT NULL,
 series_id uuid NOT NULL,
 year integer NOT NULL CHECK(year BETWEEN 2006 AND 2050),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 999999),
 number text NOT NULL CHECK(number ~ '^FV-S/[A-Z0-9][A-Z0-9-]{0,11}/[0-9]{4}/[0-9]{6}$'),
 buyer_kind text NOT NULL CHECK(buyer_kind IN ('consumer','business')),
 buyer_country text NOT NULL CHECK(buyer_country ~ '^[A-Z]{2}$'),
 buyer_tax_id_kind text NOT NULL CHECK(buyer_tax_id_kind IN ('nip','eu_vat','none')),
 buyer_tax_id text NOT NULL CHECK(buyer_tax_id ~ '^[A-Z0-9+*]{0,16}$'),
 pl_vat_payer boolean NOT NULL,
 currency text NOT NULL CHECK(currency IN ('PLN','EUR')),
 procedure text NOT NULL CHECK(procedure IN ('domestic','oss')),
 net_minor bigint NOT NULL CHECK(net_minor>=0),
 vat_minor bigint NOT NULL CHECK(vat_minor>=0),
 gross_minor bigint NOT NULL,
 annex15_gross_minor bigint NOT NULL CHECK(annex15_gross_minor>=0),
 mpp_required boolean NOT NULL,
 reverse_charge boolean NOT NULL,
 exemption_kind text CHECK(exemption_kind IN ('P_19A','P_19B','P_19C')),
 exemption_basis text CHECK(length(exemption_basis) BETWEEN 1 AND 256),
 tax_point date,
 tax_point_basis text CHECK(tax_point_basis IN ('sell_date','issue_date')),
 rate_date date,
 table_no text CHECK(table_no ~ '^[0-9]{1,3}/A/NBP/[0-9]{4}$'),
 mid numeric(10,4) CHECK(mid>0),
 rate_source text CHECK(rate_source IN ('fetched','manual')),
 net_pln_minor bigint CHECK(net_pln_minor>=0),
 vat_pln_minor bigint CHECK(vat_pln_minor>=0),
 gross_pln_minor bigint,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=1048576),
 scope_hash text NOT NULL CHECK(scope_hash ~ '^[0-9a-f]{64}$'),
 actor_id uuid NOT NULL,
 api_key_id uuid,
 client_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,document_id),
 UNIQUE(tenant_id,document_id,mid),
 UNIQUE(tenant_id,number),
 UNIQUE(tenant_id,series_id,year,sequence),
 UNIQUE(tenant_id,order_id),
 UNIQUE(tenant_id,preview_id),
 UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.documents(tenant_id,id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES public.invoice230_previews(tenant_id,id),
 CHECK(gross_minor=net_minor+vat_minor AND annex15_gross_minor<=gross_minor),
 CHECK((exemption_kind IS NULL)=(exemption_basis IS NULL)),
 CHECK((currency='PLN')=(mid IS NULL)),
 CHECK((mid IS NULL)=(tax_point IS NULL) AND (mid IS NULL)=(tax_point_basis IS NULL) AND (mid IS NULL)=(rate_date IS NULL) AND (mid IS NULL)=(table_no IS NULL)
  AND (mid IS NULL)=(rate_source IS NULL) AND (mid IS NULL)=(net_pln_minor IS NULL) AND (mid IS NULL)=(vat_pln_minor IS NULL) AND (mid IS NULL)=(gross_pln_minor IS NULL)),
 CHECK(mid IS NULL OR (rate_date<tax_point AND gross_pln_minor=net_pln_minor+vat_pln_minor AND substr(table_no,length(table_no)-3)=to_char(rate_date,'YYYY'))),
 CHECK(procedure<>'oss' OR (currency='PLN' AND buyer_kind='consumer')),
 CHECK(NOT mpp_required OR (buyer_kind='business' AND annex15_gross_minor>0 AND coalesce(gross_pln_minor,gross_minor)>1500000)),
 CHECK(buyer_kind='business' OR (buyer_tax_id_kind='none' AND NOT pl_vat_payer)),
 CHECK(buyer_tax_id_kind<>'nip' OR (buyer_country='PL' AND buyer_tax_id ~ '^[0-9]{10}$')),
 CHECK(buyer_tax_id_kind<>'eu_vat' OR (buyer_country<>'PL' AND buyer_tax_id ~ '^[A-Z]{2}[A-Z0-9+*]{2,14}$')),
 CHECK((buyer_tax_id_kind='none')=(buyer_tax_id='')),
 CHECK(NOT pl_vat_payer OR buyer_tax_id_kind='nip'),
 CHECK(number=split_part(number,'/',1)||'/'||split_part(number,'/',2)||'/'||year::text||'/'||lpad(sequence::text,6,'0'))
);
CREATE INDEX invoice230_documents_page ON public.invoice230_documents(tenant_id,created_at DESC,document_id DESC);

-- Net/VAT per FA(3) category (P_13_x/P_14_x) and, for EUR, each converted with the header's mid
-- (net and VAT rounded half up to a grosz, gross = their sum).
CREATE TABLE public.invoice230_categories (
 tenant_id uuid NOT NULL,
 document_id uuid NOT NULL,
 key text NOT NULL CHECK(key ~ '^(23|8|5|0 KR|zw|np I|np II|oo|oss [0-9]{1,2}\.[0-9]{2})$'),
 rate_code text NOT NULL CHECK(rate_code IN ('23','8','5','oss','0 KR','zw','np I','np II','oo')),
 rate numeric(5,2) CHECK(rate BETWEEN 0 AND 30),
 net_minor bigint NOT NULL CHECK(net_minor>=0),
 vat_minor bigint NOT NULL CHECK(vat_minor>=0),
 gross_minor bigint NOT NULL,
 mid numeric(10,4),
 net_pln_minor bigint,
 vat_pln_minor bigint,
 gross_pln_minor bigint,
 PRIMARY KEY(tenant_id,document_id,key),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.invoice230_documents(tenant_id,document_id),
 FOREIGN KEY(tenant_id,document_id,mid) REFERENCES public.invoice230_documents(tenant_id,document_id,mid),
 CHECK(gross_minor=net_minor+vat_minor),
 CHECK(CASE WHEN rate_code='oss' THEN key='oss '||rate::text ELSE key=rate_code END),
 CHECK(CASE WHEN rate_code IN ('zw','np I','np II','oo') THEN rate IS NULL AND vat_minor=0 WHEN rate_code='0 KR' THEN rate=0 AND vat_minor=0
  WHEN rate_code IN ('23','8','5') THEN rate=rate_code::numeric ELSE rate IS NOT NULL END),
 CHECK((mid IS NULL)=(net_pln_minor IS NULL) AND (mid IS NULL)=(vat_pln_minor IS NULL) AND (mid IS NULL)=(gross_pln_minor IS NULL)),
 CHECK(mid IS NULL OR (net_pln_minor=round(net_minor*mid) AND vat_pln_minor=round(vat_minor*mid) AND gross_pln_minor=net_pln_minor+vat_pln_minor))
);

DO $table230$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['invoice230_previews','invoice230_counters','invoice230_documents','invoice230_categories'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',t);
 END LOOP;
 GRANT SELECT,INSERT ON public.invoice230_previews,public.invoice230_counters,public.invoice230_documents,public.invoice230_categories TO dyna_app;
 GRANT UPDATE(last_number) ON public.invoice230_counters TO dyna_app;
END
$table230$;

-- Previews, documents and categories are append-only, also for the owner.
CREATE FUNCTION public.invoice230_record_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard230$
BEGIN
 RAISE EXCEPTION 'Zapis faktury 230 jest nienaruszalny' USING ERRCODE='55000';
END
$guard230$;
-- The counter starts at 1 and moves by exactly one; it is never deleted.
CREATE FUNCTION public.invoice230_counter_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard230$
BEGIN
 IF TG_OP='INSERT' AND NEW.last_number=1 THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.series_id,NEW.year)=(OLD.tenant_id,OLD.series_id,OLD.year) AND NEW.last_number=OLD.last_number+1 THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'Numeracja faktur 230 przesuwa się tylko o jeden przy wystawieniu' USING ERRCODE='55000';
END
$guard230$;
-- A document row matches its 230 document, preview and the counter already moved to its number.
CREATE FUNCTION public.invoice230_document_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard230$
DECLARE d record;p record;
BEGIN
 SELECT kind,mode,order_id,number,data,channel_id,external_id,return_id INTO d FROM public.documents WHERE (tenant_id,id)=(NEW.tenant_id,NEW.document_id);
 SELECT order_id,series_id,snapshot,scope_hash,actor_id,api_key_id INTO p FROM public.invoice230_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
 IF d.kind IS DISTINCT FROM 'invoice' OR d.mode IS DISTINCT FROM 'invoice230' OR d.channel_id IS NOT NULL OR d.external_id IS NOT NULL OR d.return_id IS NOT NULL
 OR d.order_id IS DISTINCT FROM NEW.order_id OR d.number IS DISTINCT FROM NEW.number OR d.data IS DISTINCT FROM NEW.snapshot
 OR (p.order_id,p.series_id,p.scope_hash,p.actor_id) IS DISTINCT FROM (NEW.order_id,NEW.series_id,NEW.scope_hash,NEW.actor_id) OR p.api_key_id IS DISTINCT FROM NEW.api_key_id
 OR NEW.snapshot IS DISTINCT FROM p.snapshot||jsonb_build_object('number',NEW.number,'preview_id',NEW.preview_id,'scope_hash',NEW.scope_hash)
 OR NOT EXISTS(SELECT 1 FROM public.invoice230_counters c WHERE (c.tenant_id,c.series_id,c.year,c.last_number)=(NEW.tenant_id,NEW.series_id,NEW.year,NEW.sequence))
 THEN RAISE EXCEPTION 'Faktura 230 nie odpowiada dokumentowi, podglądowi lub numeracji' USING ERRCODE='55000';END IF;
 RETURN NEW;
END
$guard230$;
-- At commit: every counter value has its document and every document its categories with exact sums.
CREATE FUNCTION public.invoice230_complete() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard230$
DECLARE h record;s record;
BEGIN
 IF TG_TABLE_NAME='invoice230_counters' THEN
  IF NOT EXISTS(SELECT 1 FROM public.invoice230_documents x WHERE (x.tenant_id,x.series_id,x.year,x.sequence)=(NEW.tenant_id,NEW.series_id,NEW.year,NEW.last_number)) THEN
   RAISE EXCEPTION 'Numer faktury 230 bez dokumentu' USING ERRCODE='55000';END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO h FROM public.invoice230_documents WHERE (tenant_id,document_id)=(NEW.tenant_id,NEW.document_id);
 SELECT count(*) n,sum(net_minor) net,sum(vat_minor) vat,sum(net_pln_minor) net_pln,sum(vat_pln_minor) vat_pln,count(*) FILTER(WHERE mid IS NULL) no_mid
  INTO s FROM public.invoice230_categories WHERE (tenant_id,document_id)=(NEW.tenant_id,NEW.document_id);
 IF s.n=0 OR s.net IS DISTINCT FROM h.net_minor OR s.vat IS DISTINCT FROM h.vat_minor
 OR (h.mid IS NULL AND s.no_mid<>s.n) OR (h.mid IS NOT NULL AND (s.no_mid<>0 OR s.net_pln IS DISTINCT FROM h.net_pln_minor OR s.vat_pln IS DISTINCT FROM h.vat_pln_minor)) THEN
  RAISE EXCEPTION 'Podsumowanie kategorii nie odpowiada fakturze 230' USING ERRCODE='55000';END IF;
 RETURN NULL;
END
$guard230$;
CREATE FUNCTION public.invoice230_truncate_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard230$
BEGIN
 RAISE EXCEPTION 'Zapisów faktur 230 nie można usunąć' USING ERRCODE='55000';
END
$guard230$;

CREATE TRIGGER invoice230_previews_keep BEFORE UPDATE OR DELETE ON public.invoice230_previews FOR EACH ROW EXECUTE FUNCTION public.invoice230_record_guard();
CREATE TRIGGER invoice230_documents_keep BEFORE UPDATE OR DELETE ON public.invoice230_documents FOR EACH ROW EXECUTE FUNCTION public.invoice230_record_guard();
CREATE TRIGGER invoice230_categories_keep BEFORE UPDATE OR DELETE ON public.invoice230_categories FOR EACH ROW EXECUTE FUNCTION public.invoice230_record_guard();
CREATE TRIGGER invoice230_counters_guard BEFORE INSERT OR UPDATE OR DELETE ON public.invoice230_counters FOR EACH ROW EXECUTE FUNCTION public.invoice230_counter_guard();
CREATE TRIGGER invoice230_documents_guard BEFORE INSERT ON public.invoice230_documents FOR EACH ROW EXECUTE FUNCTION public.invoice230_document_guard();
CREATE CONSTRAINT TRIGGER invoice230_counters_complete AFTER INSERT OR UPDATE ON public.invoice230_counters DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.invoice230_complete();
CREATE CONSTRAINT TRIGGER invoice230_documents_complete AFTER INSERT ON public.invoice230_documents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.invoice230_complete();
CREATE TRIGGER invoice230_previews_truncate BEFORE TRUNCATE ON public.invoice230_previews FOR EACH STATEMENT EXECUTE FUNCTION public.invoice230_truncate_guard();
CREATE TRIGGER invoice230_counters_truncate BEFORE TRUNCATE ON public.invoice230_counters FOR EACH STATEMENT EXECUTE FUNCTION public.invoice230_truncate_guard();
CREATE TRIGGER invoice230_documents_truncate BEFORE TRUNCATE ON public.invoice230_documents FOR EACH STATEMENT EXECUTE FUNCTION public.invoice230_truncate_guard();
CREATE TRIGGER invoice230_categories_truncate BEFORE TRUNCATE ON public.invoice230_categories FOR EACH STATEMENT EXECUTE FUNCTION public.invoice230_truncate_guard();
REVOKE ALL ON FUNCTION public.invoice230_record_guard(),public.invoice230_counter_guard(),public.invoice230_document_guard(),public.invoice230_complete(),public.invoice230_truncate_guard() FROM PUBLIC;
