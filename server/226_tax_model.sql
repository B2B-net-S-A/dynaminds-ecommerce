-- Successor to225, registered in db.ts migrate() after225 (23.10.2026).
-- Tax data model for Polish invoicing (stage 3, step 1): the tax profile of a
-- product (category standard/ZW/NP/OO with the legal basis, GTU 01-13, annex 15
-- for split payment, OSS rate class), the tenant's OSS registration with its
-- destination-country rates, and the per-line tax snapshot of an issued document.
-- Only own tables are added: no trigger, column or constraint is attached to
-- products, documents or any other core table except the internal referential
-- triggers of the foreign keys below. Invoice math and FA(3) XML are unchanged.
DO $dependency226$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.product_deletions225') IS NULL
 OR to_regclass('public.products') IS NULL
 OR to_regclass('public.documents') IS NULL
 THEN RAISE EXCEPTION 'Tax model requires owner-installed225' USING ERRCODE='55000';END IF;
END
$dependency226$;

-- Current tax profile of a product; no row = ordinary rate (products.vat), no GTU.
CREATE TABLE public.tax226_product_profiles (
 tenant_id uuid NOT NULL,
 product_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 category text NOT NULL CHECK(category IN ('standard','zw','np','oo')),
 exemption_basis_kind text CHECK(exemption_basis_kind IN ('P_19A','P_19B','P_19C')),
 exemption_basis text CHECK(exemption_basis IS NULL OR (char_length(exemption_basis) BETWEEN 1 AND 256 AND exemption_basis=btrim(exemption_basis))),
 np_kind text CHECK(np_kind IN ('np_i','np_ii')),
 gtu text CHECK(gtu ~ '^GTU_(0[1-9]|1[0-3])$'),
 annex15 boolean NOT NULL DEFAULT false,
 oss_rate_class text NOT NULL DEFAULT 'standard' CHECK(oss_rate_class IN ('standard','reduced_1','reduced_2','super_reduced','zero')),
 updated_by uuid NOT NULL,
 api_key_id uuid,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,product_id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES public.products(tenant_id,id),
 CHECK((category='zw')=(exemption_basis_kind IS NOT NULL) AND (exemption_basis_kind IS NULL)=(exemption_basis IS NULL)),
 CHECK((category='np')=(np_kind IS NOT NULL))
);

-- OSS (EU distance sales of goods to consumers) registration of the tenant in PL.
CREATE TABLE public.tax226_oss_settings (
 tenant_id uuid PRIMARY KEY,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 registered boolean NOT NULL,
 registered_from date,
 updated_by uuid NOT NULL,
 api_key_id uuid,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(registered=(registered_from IS NOT NULL))
);
-- Destination-country VAT rates per rate class, maintained by the tenant.
CREATE TABLE public.tax226_oss_rates (
 tenant_id uuid NOT NULL,
 country text NOT NULL CHECK(country IN ('AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PT','RO','SE','SI','SK')),
 rate_class text NOT NULL CHECK(rate_class IN ('standard','reduced_1','reduced_2','super_reduced','zero')),
 rate numeric(4,2) NOT NULL CHECK(rate>=0 AND rate<=30),
 PRIMARY KEY(tenant_id,country,rate_class),
 FOREIGN KEY(tenant_id) REFERENCES public.tax226_oss_settings(tenant_id)
);

-- Tax facts of an issued document, captured once (append-only).
CREATE TABLE public.tax226_document_snapshots (
 tenant_id uuid NOT NULL,
 document_id uuid NOT NULL,
 source text NOT NULL CHECK(source='local_invoice'),
 captured_with_issue boolean NOT NULL,
 buyer_kind text NOT NULL CHECK(buyer_kind IN ('consumer','business')),
 buyer_country text NOT NULL CHECK(buyer_country ~ '^[A-Z]{2}$'),
 procedure text NOT NULL CHECK(procedure IN ('domestic','oss')),
 oss_country text CHECK(oss_country ~ '^[A-Z]{2}$'),
 gross_minor bigint NOT NULL CHECK(gross_minor>=0),
 annex15_gross_minor bigint NOT NULL CHECK(annex15_gross_minor>=0 AND annex15_gross_minor<=gross_minor),
 mpp_required boolean NOT NULL,
 actor_id uuid NOT NULL,
 api_key_id uuid,
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,document_id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.documents(tenant_id,id),
 CHECK((procedure='oss')=(oss_country IS NOT NULL)),
 CHECK(NOT mpp_required OR (buyer_kind='business' AND annex15_gross_minor>0 AND gross_minor>1500000))
);
-- One row per line of the document (line_no = position in documents.data lines, from 1).
CREATE TABLE public.tax226_document_lines (
 tenant_id uuid NOT NULL,
 document_id uuid NOT NULL,
 line_no integer NOT NULL CHECK(line_no>0),
 kind text NOT NULL CHECK(kind IN ('item','shipping')),
 item_id uuid,
 product_id uuid,
 category text NOT NULL CHECK(category IN ('standard','zw','np','oo')),
 rate numeric(4,2) CHECK(rate>=0 AND rate<=30),
 rate_code text NOT NULL CHECK(rate_code IN ('23','8','5','0 KR','0 WDT','0 EX','oss','zw','np I','np II','oo')),
 exemption_basis_kind text CHECK(exemption_basis_kind IN ('P_19A','P_19B','P_19C')),
 exemption_basis text CHECK(exemption_basis IS NULL OR char_length(exemption_basis) BETWEEN 1 AND 256),
 np_kind text CHECK(np_kind IN ('np_i','np_ii')),
 gtu text CHECK(gtu ~ '^GTU_(0[1-9]|1[0-3])$'),
 annex15 boolean NOT NULL,
 profile_version integer CHECK(profile_version>0),
 PRIMARY KEY(tenant_id,document_id,line_no),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.tax226_document_snapshots(tenant_id,document_id),
 CHECK((kind='item')=(item_id IS NOT NULL AND product_id IS NOT NULL)),
 CHECK(kind='item' OR (gtu IS NULL AND NOT annex15 AND profile_version IS NULL)),
 CHECK((category='standard')=(rate IS NOT NULL)),
 CHECK(CASE category
  WHEN 'standard' THEN rate_code IN ('23','8','5','0 KR','0 WDT','0 EX','oss') AND exemption_basis_kind IS NULL AND exemption_basis IS NULL AND np_kind IS NULL
  WHEN 'zw' THEN rate_code='zw' AND exemption_basis_kind IS NOT NULL AND exemption_basis IS NOT NULL AND np_kind IS NULL
  WHEN 'np' THEN np_kind IS NOT NULL AND rate_code=CASE np_kind WHEN 'np_i' THEN 'np I' WHEN 'np_ii' THEN 'np II' END AND exemption_basis_kind IS NULL AND exemption_basis IS NULL
  ELSE rate_code='oo' AND exemption_basis_kind IS NULL AND exemption_basis IS NULL AND np_kind IS NULL END)
);

DO $table226$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['tax226_product_profiles','tax226_oss_settings','tax226_oss_rates','tax226_document_snapshots','tax226_document_lines'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',t);
 END LOOP;
 GRANT SELECT,INSERT,UPDATE ON public.tax226_product_profiles,public.tax226_oss_settings TO dyna_app;
 GRANT SELECT,INSERT,UPDATE,DELETE ON public.tax226_oss_rates TO dyna_app;
 GRANT SELECT,INSERT ON public.tax226_document_snapshots,public.tax226_document_lines TO dyna_app;
END
$table226$;

-- Document tax snapshots are append-only: no update, delete or truncate, also for the owner.
CREATE FUNCTION public.tax226_snapshot_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard226$
BEGIN
 RAISE EXCEPTION 'Document tax snapshot is permanent' USING ERRCODE='55000';
END
$guard226$;
REVOKE ALL ON FUNCTION public.tax226_snapshot_guard() FROM PUBLIC,dyna_app;
CREATE TRIGGER tax226_document_snapshots_append_only BEFORE UPDATE OR DELETE ON public.tax226_document_snapshots FOR EACH ROW EXECUTE FUNCTION public.tax226_snapshot_guard();
CREATE TRIGGER tax226_document_snapshots_no_truncate BEFORE TRUNCATE ON public.tax226_document_snapshots FOR EACH STATEMENT EXECUTE FUNCTION public.tax226_snapshot_guard();
CREATE TRIGGER tax226_document_lines_append_only BEFORE UPDATE OR DELETE ON public.tax226_document_lines FOR EACH ROW EXECUTE FUNCTION public.tax226_snapshot_guard();
CREATE TRIGGER tax226_document_lines_no_truncate BEFORE TRUNCATE ON public.tax226_document_lines FOR EACH STATEMENT EXECUTE FUNCTION public.tax226_snapshot_guard();
