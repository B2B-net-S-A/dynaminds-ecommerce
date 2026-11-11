-- Migration 243_ksef_purchase (docs/parity/KSEF-PURCHASE243-20261027.md): purchase (cost) invoices received
-- in KSeF by the company's NIP (Subject2), stage 4 "KSeF bezpośrednio". Successor to242; requires 229 and 228.
-- Own tables only: the per-NIP fetch state with the resumable checkpoint and its lease, the invoice header with
-- the exact FA(3) file as KSeF stored it (bytes, SHA-256 and the KSeF invoiceHash checked here), totals per VAT
-- rate, KOR references with their link to the corrected invoice, refused files without any file content, and
-- an append-only event log. Personal data of counterparties (sole-trader sellers) is kept for the tax retention
-- only: retain_until is 31.12 of (issue year + 6) or later; ksef243_purchase_purge() is the only way to delete.
--
-- No core table is altered, referenced by a foreign key or written, and nothing references the 229 tables (the
-- NIP's KSeF settings are checked by the application), so no existing catalogue record, guard or fingerprint
-- moves. Foreign keys exist only between the own ksef243_ tables.
DO $dependency243$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.ksef229_configs') IS NULL
 OR to_regclass('public.rodo228_retained') IS NULL
 THEN RAISE EXCEPTION 'KSeF purchase invoices require owner-installed229' USING ERRCODE='55000';END IF;
END
$dependency243$;

-- One row per buyer NIP: the fetch settings and the only progress of the fetch (the checkpoint JSON, validated
-- by the application with parsePurchaseCheckpoint). A run holds the lease; the checkpoint is written only under
-- the exact lease token. Rows are disabled, never deleted.
CREATE TABLE public.ksef243_purchase_sync (
 tenant_id uuid NOT NULL,
 nip text NOT NULL CHECK(nip ~ '^[0-9]{10}$'),
 enabled boolean NOT NULL DEFAULT true,
 date_type text NOT NULL CHECK(date_type IN ('PermanentStorage','Invoicing','Issue')),
 start_from timestamptz NOT NULL,
 checkpoint jsonb NOT NULL CHECK(jsonb_typeof(checkpoint)='object' AND checkpoint->>'version'='1' AND checkpoint->>'nip'=nip
  AND checkpoint->>'dateType'=date_type AND octet_length(checkpoint::text)<=1048576),
 lease_token uuid,
 leased_until timestamptz,
 last_run_at timestamptz,
 last_ok_at timestamptz,
 last_error text CHECK(length(last_error) BETWEEN 1 AND 2000),
 rate_limited_until timestamptz,
 runs integer NOT NULL DEFAULT 0 CHECK(runs>=0),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,nip),
 CHECK((lease_token IS NULL)=(leased_until IS NULL))
);

-- One received invoice, deduplicated by its KSeF number. Everything taken from KSeF is immutable; only the
-- workflow (status, accounting reference, note), the legal hold and a later retention end change.
CREATE TABLE public.ksef243_purchase_invoices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 buyer_nip text NOT NULL CHECK(buyer_nip ~ '^[0-9]{10}$'),
 ksef_number text NOT NULL CHECK(ksef_number ~ '^[0-9]{10}-[0-9]{8}-[0-9A-F]{12}-[0-9A-F]{2}$'),
 seller_nip text NOT NULL CHECK(seller_nip ~ '^[0-9]{10}$'),
 seller_name text NOT NULL CHECK(length(seller_name) BETWEEN 1 AND 512),
 invoice_number text NOT NULL CHECK(length(invoice_number) BETWEEN 1 AND 256),
 invoice_type text NOT NULL CHECK(invoice_type IN ('Vat','Zal','Kor','Roz','Upr','KorZal','KorRoz')),
 fa3_kind text NOT NULL CHECK(fa3_kind IN ('VAT','KOR','ZAL','ROZ','UPR','KOR_ZAL','KOR_ROZ')),
 issue_date date NOT NULL,
 sale_date date,
 sale_period_from date,
 sale_period_to date,
 invoicing_date timestamptz NOT NULL,
 acquisition_date timestamptz,
 permanent_storage_date timestamptz,
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 -- Totals in minor units (grosze); a correction may be negative.
 net_total bigint NOT NULL,
 vat_total bigint NOT NULL,
 gross_total bigint NOT NULL,
 split_payment boolean NOT NULL,
 cash_method boolean NOT NULL,
 self_invoicing boolean NOT NULL,
 reverse_charge boolean NOT NULL,
 has_attachment boolean NOT NULL,
 invoicing_mode text CHECK(invoicing_mode IN ('Online','Offline')),
 payment_due_date date,
 correction_reason text CHECK(length(correction_reason) BETWEEN 1 AND 1000),
 correction_type smallint CHECK(correction_type IN (1,2,3)),
 -- The FA(3) file exactly as KSeF stored it; its SHA-256 is KSeF's invoiceHash (base64) and our hex digest.
 xml bytea NOT NULL,
 xml_bytes integer NOT NULL CHECK(xml_bytes BETWEEN 1 AND 3145728),
 xml_sha256 text NOT NULL CHECK(xml_sha256 ~ '^[0-9a-f]{64}$'),
 invoice_hash text NOT NULL CHECK(invoice_hash ~ '^[A-Za-z0-9+/]{43}=$'),
 source text NOT NULL CHECK(source IN ('query','retry')),
 fetched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','accepted','booked','ignored')),
 status_by uuid,
 status_at timestamptz,
 accounting_ref text CHECK(length(accounting_ref) BETWEEN 1 AND 120),
 note text CHECK(length(note) BETWEEN 1 AND 2000),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 -- Tax retention: 31.12 of (issue year + 6) at the earliest (art. 112 VAT, art. 70 OP, art. 74 UoR); a hold keeps it.
 retain_until date NOT NULL,
 legal_hold boolean NOT NULL DEFAULT false,
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,ksef_number),
 FOREIGN KEY(tenant_id,buyer_nip) REFERENCES public.ksef243_purchase_sync(tenant_id,nip),
 CHECK(xml_bytes=octet_length(xml) AND xml_sha256=encode(sha256(xml),'hex') AND invoice_hash=encode(sha256(xml),'base64')),
 CHECK(retain_until>=make_date(extract(year FROM issue_date)::integer+6,12,31)),
 CHECK((status_by IS NULL)=(status_at IS NULL)),
 CHECK((sale_period_from IS NULL)=(sale_period_to IS NULL)),
 CHECK((fa3_kind IN ('KOR','KOR_ZAL','KOR_ROZ')) OR (correction_reason IS NULL AND correction_type IS NULL))
);
CREATE INDEX ksef243_purchase_invoices_page ON public.ksef243_purchase_invoices(tenant_id,buyer_nip,issue_date DESC,id DESC);
CREATE INDEX ksef243_purchase_invoices_seller ON public.ksef243_purchase_invoices(tenant_id,seller_nip,invoice_number,issue_date);
CREATE INDEX ksef243_purchase_invoices_status ON public.ksef243_purchase_invoices(tenant_id,status);
CREATE INDEX ksef243_purchase_invoices_retention ON public.ksef243_purchase_invoices(tenant_id,retain_until) WHERE NOT legal_hold;

-- Totals per rate of one invoice, written with it (insert-only).
CREATE TABLE public.ksef243_purchase_rates (
 tenant_id uuid NOT NULL,
 invoice_id uuid NOT NULL,
 rate_code text NOT NULL CHECK(rate_code IN ('23','8','5','4','oss','0_kr','0_wdt','0_ex','zw','np_i','np_ii','oo','marza')),
 net bigint NOT NULL,
 vat bigint,
 vat_pln bigint,
 PRIMARY KEY(tenant_id,invoice_id,rate_code),
 FOREIGN KEY(tenant_id,invoice_id) REFERENCES public.ksef243_purchase_invoices(tenant_id,id) ON DELETE CASCADE
);

-- The invoices a KOR corrects (DaneFaKorygowanej, in file order) and, once found, the corrected invoice. A
-- reference without a match stays open (the original may arrive later or predate KSeF); a match is set once.
CREATE TABLE public.ksef243_purchase_corrections (
 tenant_id uuid NOT NULL,
 correction_id uuid NOT NULL,
 ordinal smallint NOT NULL CHECK(ordinal BETWEEN 1 AND 10000),
 ref_invoice_number text NOT NULL CHECK(length(ref_invoice_number) BETWEEN 1 AND 256),
 ref_issue_date date NOT NULL,
 ref_ksef_number text CHECK(ref_ksef_number ~ '^[0-9]{10}-[0-9]{8}-[0-9A-F]{12}-[0-9A-F]{2}$'),
 resolved_invoice_id uuid,
 resolved_by text CHECK(resolved_by IN ('ksef_number','invoice_number')),
 problem text CHECK(problem IN ('seller_mismatch','ambiguous')),
 resolved_at timestamptz,
 PRIMARY KEY(tenant_id,correction_id,ordinal),
 FOREIGN KEY(tenant_id,correction_id) REFERENCES public.ksef243_purchase_invoices(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,resolved_invoice_id) REFERENCES public.ksef243_purchase_invoices(tenant_id,id) ON DELETE SET NULL (resolved_invoice_id),
 CHECK(resolved_invoice_id IS NULL OR (resolved_by IS NOT NULL AND problem IS NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX ksef243_purchase_corrections_resolved ON public.ksef243_purchase_corrections(tenant_id,resolved_invoice_id) WHERE resolved_invoice_id IS NOT NULL;
CREATE INDEX ksef243_purchase_corrections_open ON public.ksef243_purchase_corrections(tenant_id,ref_invoice_number,ref_issue_date) WHERE resolved_invoice_id IS NULL;

-- A listed invoice whose file was refused (malformed, hash or buyer mismatch, too large). No file content is
-- kept: only the KSeF metadata entry, the code and a Polish reason. Resolved when a later download succeeds.
CREATE TABLE public.ksef243_purchase_rejects (
 tenant_id uuid NOT NULL,
 ksef_number text NOT NULL CHECK(ksef_number ~ '^[0-9]{10}-[0-9]{8}-[0-9A-F]{12}-[0-9A-F]{2}$'),
 buyer_nip text NOT NULL CHECK(buyer_nip ~ '^[0-9]{10}$'),
 invoice_hash text NOT NULL CHECK(invoice_hash ~ '^[A-Za-z0-9+/]{43}=$'),
 meta jsonb NOT NULL CHECK(jsonb_typeof(meta)='object' AND octet_length(meta::text)<=16384),
 code text NOT NULL CHECK(code ~ '^[a-z0-9_]{1,40}$'),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 attempts integer NOT NULL DEFAULT 1 CHECK(attempts BETWEEN 1 AND 100000),
 first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 resolved_at timestamptz,
 PRIMARY KEY(tenant_id,ksef_number),
 FOREIGN KEY(tenant_id,buyer_nip) REFERENCES public.ksef243_purchase_sync(tenant_id,nip)
);
CREATE INDEX ksef243_purchase_rejects_open ON public.ksef243_purchase_rejects(tenant_id,buyer_nip,last_seen_at DESC) WHERE resolved_at IS NULL;

-- What a run, a page or a user did: counts and KSeF numbers, never a token, a secret or file content.
CREATE TABLE public.ksef243_purchase_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 nip text NOT NULL CHECK(nip ~ '^[0-9]{10}$'),
 at timestamptz NOT NULL DEFAULT clock_timestamp(),
 kind text NOT NULL CHECK(kind IN ('config','run','page','rejected','rate_limited','unavailable','refused','error','status','retry','export','purge')),
 message text NOT NULL CHECK(length(message) BETWEEN 1 AND 2000),
 detail jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(detail)='object' AND octet_length(detail::text)<=8192),
 actor_id uuid
);
CREATE INDEX ksef243_purchase_events_page ON public.ksef243_purchase_events(tenant_id,nip,at DESC);

DO $table243$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['ksef243_purchase_sync','ksef243_purchase_invoices','ksef243_purchase_rates','ksef243_purchase_corrections','ksef243_purchase_rejects','ksef243_purchase_events'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',t);
 END LOOP;
 -- No DELETE or TRUNCATE for the application role; deletion is ksef243_purchase_purge() only.
 GRANT SELECT,INSERT ON public.ksef243_purchase_sync,public.ksef243_purchase_invoices,public.ksef243_purchase_rates,public.ksef243_purchase_corrections,public.ksef243_purchase_rejects,public.ksef243_purchase_events TO dyna_app;
 GRANT UPDATE(enabled,date_type,start_from,checkpoint,lease_token,leased_until,last_run_at,last_ok_at,last_error,rate_limited_until,runs,updated_by,updated_at) ON public.ksef243_purchase_sync TO dyna_app;
 GRANT UPDATE(status,status_by,status_at,accounting_ref,note,version,legal_hold,retain_until) ON public.ksef243_purchase_invoices TO dyna_app;
 GRANT UPDATE(resolved_invoice_id,resolved_by,problem,resolved_at) ON public.ksef243_purchase_corrections TO dyna_app;
 GRANT UPDATE(invoice_hash,meta,code,reason,attempts,last_seen_at,resolved_at) ON public.ksef243_purchase_rejects TO dyna_app;
END
$table243$;

-- Sync rows keep their identity and are never deleted; rates and events never change; a reject keeps its
-- identity. Rows other than sync rows are deleted only inside ksef243_purchase_purge() of their tenant: the purge
-- flag counts only for the owner (the SECURITY DEFINER purge and the foreign-key actions it causes), never for dyna_app.
-- Nothing is truncated, also by the owner.
CREATE FUNCTION public.ksef243_keep_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard243$
BEGIN
 IF TG_LEVEL='ROW' AND TG_OP='DELETE' AND TG_TABLE_NAME<>'ksef243_purchase_sync' THEN
  IF current_user='postgres' AND current_setting('ksef243.purge',true)=OLD.tenant_id::text THEN RETURN OLD;END IF;
 END IF;
 IF TG_LEVEL='ROW' AND TG_OP='UPDATE' AND TG_TABLE_NAME='ksef243_purchase_sync' THEN
  IF (NEW.tenant_id,NEW.nip,NEW.created_by,NEW.created_at) IS NOT DISTINCT FROM (OLD.tenant_id,OLD.nip,OLD.created_by,OLD.created_at) THEN RETURN NEW;END IF;
 END IF;
 IF TG_LEVEL='ROW' AND TG_OP='UPDATE' AND TG_TABLE_NAME='ksef243_purchase_rejects' THEN
  IF (NEW.tenant_id,NEW.ksef_number,NEW.buyer_nip,NEW.first_seen_at) IS NOT DISTINCT FROM (OLD.tenant_id,OLD.ksef_number,OLD.buyer_nip,OLD.first_seen_at) THEN RETURN NEW;END IF;
 END IF;
 RAISE EXCEPTION 'Zapis faktur zakupowych KSeF jest nienaruszalny' USING ERRCODE='55000';
END
$guard243$;
-- The KSeF data and the file never change; the retention end only moves later; a held invoice is never purged.
CREATE FUNCTION public.ksef243_invoice_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard243$
BEGIN
 IF TG_OP='DELETE' THEN
  IF current_user='postgres' AND current_setting('ksef243.purge',true)=OLD.tenant_id::text AND OLD.retain_until<current_date AND NOT OLD.legal_hold THEN RETURN OLD;END IF;
  RAISE EXCEPTION 'Faktura zakupowa z KSeF jest przechowywana do %',OLD.retain_until USING ERRCODE='55000';
 END IF;
 IF (to_jsonb(NEW)-'status'-'status_by'-'status_at'-'accounting_ref'-'note'-'version'-'legal_hold'-'retain_until')
  =(to_jsonb(OLD)-'status'-'status_by'-'status_at'-'accounting_ref'-'note'-'version'-'legal_hold'-'retain_until')
 AND NEW.retain_until>=OLD.retain_until THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'Faktura zakupowa z KSeF jest nienaruszalna' USING ERRCODE='55000';
END
$guard243$;
-- A reference keeps its data; its link is set while it is open, and cleared only when the purge removes the target.
CREATE FUNCTION public.ksef243_correction_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard243$
BEGIN
 IF TG_OP='DELETE' THEN
  IF current_user='postgres' AND current_setting('ksef243.purge',true)=OLD.tenant_id::text THEN RETURN OLD;END IF;
  RAISE EXCEPTION 'Odwołanie korekty zakupowej jest nienaruszalne' USING ERRCODE='55000';
 END IF;
 IF (to_jsonb(NEW)-'resolved_invoice_id'-'resolved_by'-'problem'-'resolved_at')=(to_jsonb(OLD)-'resolved_invoice_id'-'resolved_by'-'problem'-'resolved_at')
 AND (OLD.resolved_invoice_id IS NULL OR (NEW.resolved_invoice_id IS NULL AND current_user='postgres' AND current_setting('ksef243.purge',true)=OLD.tenant_id::text)) THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'Powiązanie korekty zakupowej ustala się raz' USING ERRCODE='55000';
END
$guard243$;
-- Retention purge of the caller's tenant: invoices past retain_until without a hold (with their rates and
-- references), refused entries and events not seen for a year. Answers the deleted counts.
CREATE FUNCTION public.ksef243_purchase_purge() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $purge243$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;i integer;r integer;e integer;
BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'Tenant scope required' USING ERRCODE='42501';END IF;
 PERFORM set_config('ksef243.purge',t::text,true);
 DELETE FROM public.ksef243_purchase_invoices WHERE tenant_id=t AND retain_until<current_date AND NOT legal_hold;
 GET DIAGNOSTICS i=ROW_COUNT;
 DELETE FROM public.ksef243_purchase_rejects WHERE tenant_id=t AND last_seen_at<clock_timestamp()-interval '1 year';
 GET DIAGNOSTICS r=ROW_COUNT;
 DELETE FROM public.ksef243_purchase_events WHERE tenant_id=t AND at<clock_timestamp()-interval '1 year';
 GET DIAGNOSTICS e=ROW_COUNT;
 PERFORM set_config('ksef243.purge','',true);
 RETURN jsonb_build_object('invoices',i,'rejects',r,'events',e);
END
$purge243$;
REVOKE ALL ON FUNCTION public.ksef243_keep_guard(),public.ksef243_invoice_guard(),public.ksef243_correction_guard() FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION public.ksef243_purchase_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ksef243_purchase_purge() TO dyna_app;
CREATE TRIGGER ksef243_purchase_sync_keep BEFORE UPDATE OR DELETE ON public.ksef243_purchase_sync FOR EACH ROW EXECUTE FUNCTION public.ksef243_keep_guard();
CREATE TRIGGER ksef243_purchase_sync_no_truncate BEFORE TRUNCATE ON public.ksef243_purchase_sync FOR EACH STATEMENT EXECUTE FUNCTION public.ksef243_keep_guard();
CREATE TRIGGER ksef243_purchase_invoices_guard BEFORE UPDATE OR DELETE ON public.ksef243_purchase_invoices FOR EACH ROW EXECUTE FUNCTION public.ksef243_invoice_guard();
CREATE TRIGGER ksef243_purchase_invoices_no_truncate BEFORE TRUNCATE ON public.ksef243_purchase_invoices FOR EACH STATEMENT EXECUTE FUNCTION public.ksef243_keep_guard();
CREATE TRIGGER ksef243_purchase_rates_keep BEFORE UPDATE OR DELETE ON public.ksef243_purchase_rates FOR EACH ROW EXECUTE FUNCTION public.ksef243_keep_guard();
CREATE TRIGGER ksef243_purchase_rates_no_truncate BEFORE TRUNCATE ON public.ksef243_purchase_rates FOR EACH STATEMENT EXECUTE FUNCTION public.ksef243_keep_guard();
CREATE TRIGGER ksef243_purchase_corrections_guard BEFORE UPDATE OR DELETE ON public.ksef243_purchase_corrections FOR EACH ROW EXECUTE FUNCTION public.ksef243_correction_guard();
CREATE TRIGGER ksef243_purchase_corrections_no_truncate BEFORE TRUNCATE ON public.ksef243_purchase_corrections FOR EACH STATEMENT EXECUTE FUNCTION public.ksef243_keep_guard();
CREATE TRIGGER ksef243_purchase_rejects_keep BEFORE UPDATE OR DELETE ON public.ksef243_purchase_rejects FOR EACH ROW EXECUTE FUNCTION public.ksef243_keep_guard();
CREATE TRIGGER ksef243_purchase_rejects_no_truncate BEFORE TRUNCATE ON public.ksef243_purchase_rejects FOR EACH STATEMENT EXECUTE FUNCTION public.ksef243_keep_guard();
CREATE TRIGGER ksef243_purchase_events_append_only BEFORE UPDATE OR DELETE ON public.ksef243_purchase_events FOR EACH ROW EXECUTE FUNCTION public.ksef243_keep_guard();
CREATE TRIGGER ksef243_purchase_events_no_truncate BEFORE TRUNCATE ON public.ksef243_purchase_events FOR EACH STATEMENT EXECUTE FUNCTION public.ksef243_keep_guard();
