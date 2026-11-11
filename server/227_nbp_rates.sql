-- Successor to226, registered in db.ts migrate() after226 (23.10.2026).
-- NBP exchange rates for foreign-currency documents (stage 3, step 2): the table A
-- mid rates known to the tenant (read from api.nbp.pl or entered manually) and the
-- rate record of an issued document (art. 31a ust. 1 ustawy o VAT: mid rate of the
-- last NBP table published before the tax point) with its VAT and totals in PLN.
-- Only own tables are added: no trigger, column or constraint is attached to
-- documents or any other core table except the internal referential triggers of
-- the foreign key below. Invoice math is unchanged.
DO $dependency227$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.tax226_document_snapshots') IS NULL
 OR to_regclass('public.documents') IS NULL
 THEN RAISE EXCEPTION 'NBP rates require owner-installed226' USING ERRCODE='55000';END IF;
END
$dependency227$;

-- Table A mid rate of a currency on its publication date. covered_through is the last
-- day without a later table A publication: proven by an NBP range read, or declared by
-- the person entering a manual rate. A rate serves tax points in (effective_date, covered_through+1].
CREATE TABLE public.nbp227_rates (
 tenant_id uuid NOT NULL,
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$' AND currency<>'PLN'),
 effective_date date NOT NULL,
 table_no text NOT NULL CHECK(table_no ~ '^[0-9]{3}/A/NBP/[0-9]{4}$'),
 mid numeric(10,4) NOT NULL CHECK(mid>0),
 covered_through date NOT NULL,
 source text NOT NULL CHECK(source IN ('fetched','manual')),
 fetched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor_id uuid NOT NULL,
 api_key_id uuid,
 PRIMARY KEY(tenant_id,currency,effective_date),
 UNIQUE(tenant_id,currency,table_no),
 CHECK(extract(year FROM effective_date)::integer=substr(table_no,11,4)::integer),
 CHECK(covered_through>=effective_date AND covered_through<=effective_date+31)
);

-- Rate of an issued foreign-currency document, captured once with the issue (append-only).
CREATE TABLE public.nbp227_document_rates (
 tenant_id uuid NOT NULL,
 document_id uuid NOT NULL,
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$' AND currency<>'PLN'),
 tax_point date NOT NULL,
 tax_point_basis text NOT NULL CHECK(tax_point_basis IN ('sell_date','issue_date')),
 rate_date date NOT NULL,
 table_no text NOT NULL CHECK(table_no ~ '^[0-9]{3}/A/NBP/[0-9]{4}$'),
 mid numeric(10,4) NOT NULL CHECK(mid>0),
 rate_source text NOT NULL CHECK(rate_source IN ('fetched','manual')),
 net_minor bigint NOT NULL CHECK(net_minor>=0),
 vat_minor bigint NOT NULL CHECK(vat_minor>=0),
 gross_minor bigint NOT NULL,
 net_pln_minor bigint NOT NULL CHECK(net_pln_minor>=0),
 vat_pln_minor bigint NOT NULL CHECK(vat_pln_minor>=0),
 gross_pln_minor bigint NOT NULL,
 captured_with_issue boolean NOT NULL,
 actor_id uuid NOT NULL,
 api_key_id uuid,
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,document_id),
 UNIQUE(tenant_id,document_id,mid),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.documents(tenant_id,id),
 CHECK(rate_date<tax_point AND rate_date>=tax_point-31),
 CHECK(extract(year FROM rate_date)::integer=substr(table_no,11,4)::integer),
 CHECK(gross_minor=net_minor+vat_minor AND gross_pln_minor=net_pln_minor+vat_pln_minor)
);
-- Per VAT rate amounts of that document in its currency and in PLN, each rounded half up to a grosz.
CREATE TABLE public.nbp227_document_rate_vat (
 tenant_id uuid NOT NULL,
 document_id uuid NOT NULL,
 vat_rate integer NOT NULL CHECK(vat_rate IN (0,5,8,23)),
 mid numeric(10,4) NOT NULL,
 net_minor bigint NOT NULL CHECK(net_minor>=0),
 vat_minor bigint NOT NULL CHECK(vat_minor>=0),
 gross_minor bigint NOT NULL,
 net_pln_minor bigint NOT NULL,
 vat_pln_minor bigint NOT NULL,
 gross_pln_minor bigint NOT NULL,
 PRIMARY KEY(tenant_id,document_id,vat_rate),
 FOREIGN KEY(tenant_id,document_id,mid) REFERENCES public.nbp227_document_rates(tenant_id,document_id,mid),
 CHECK(gross_minor=net_minor+vat_minor),
 CHECK(net_pln_minor=round(net_minor*mid) AND vat_pln_minor=round(vat_minor*mid) AND gross_pln_minor=net_pln_minor+vat_pln_minor)
);

DO $table227$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['nbp227_rates','nbp227_document_rates','nbp227_document_rate_vat'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',t);
 END LOOP;
 GRANT SELECT,INSERT,UPDATE,DELETE ON public.nbp227_rates TO dyna_app;
 GRANT SELECT,INSERT ON public.nbp227_document_rates,public.nbp227_document_rate_vat TO dyna_app;
END
$table227$;

-- Document rate records are permanent: no update, delete or truncate, also for the owner.
CREATE FUNCTION public.nbp227_record_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard227$
BEGIN
 RAISE EXCEPTION 'Document NBP rate record is permanent' USING ERRCODE='55000';
END
$guard227$;
REVOKE ALL ON FUNCTION public.nbp227_record_guard() FROM PUBLIC,dyna_app;
CREATE TRIGGER nbp227_document_rates_append_only BEFORE UPDATE OR DELETE ON public.nbp227_document_rates FOR EACH ROW EXECUTE FUNCTION public.nbp227_record_guard();
CREATE TRIGGER nbp227_document_rates_no_truncate BEFORE TRUNCATE ON public.nbp227_document_rates FOR EACH STATEMENT EXECUTE FUNCTION public.nbp227_record_guard();
CREATE TRIGGER nbp227_document_rate_vat_append_only BEFORE UPDATE OR DELETE ON public.nbp227_document_rate_vat FOR EACH ROW EXECUTE FUNCTION public.nbp227_record_guard();
CREATE TRIGGER nbp227_document_rate_vat_no_truncate BEFORE TRUNCATE ON public.nbp227_document_rate_vat FOR EACH STATEMENT EXECUTE FUNCTION public.nbp227_record_guard();
