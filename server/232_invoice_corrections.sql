-- Successor to231, registered in db.ts migrate() after231 (24.10.2026).
-- Value corrections (KOR-S) of FV-S invoices (230): quantity/value per line, from a return case, or a
-- cancellation to zero. Numbering is an own sub-series of the 157 series of the corrected invoice,
-- KOR-S/<prefix>/<year>/<sequence>, continuous within itself. A correction is kept in its own
-- append-only ledger (as 188/206 do), not as a documents row. The only foreign keys leave the own
-- tables for invoice230_documents. The 229 CHECK of document kinds (own table ksef229_submissions)
-- is widened by 'invoice232_correction', keeping its name. Nothing is attached to a core table.
DO $dependency232$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.invoice230_documents') IS NULL
 OR to_regclass('public.invoice230_categories') IS NULL
 OR to_regclass('public.ksef229_submissions') IS NULL
 OR NOT EXISTS(SELECT FROM pg_constraint WHERE conrelid='public.ksef229_submissions'::regclass AND conname='ksef229_submissions_document_kind_check'
  AND contype='c' AND pg_get_constraintdef(oid) LIKE '%''invoice230''%')
 THEN RAISE EXCEPTION 'Korekty faktur FV-S (232) wymagają zainstalowanych 230 i 231' USING ERRCODE='55000';END IF;
END
$dependency232$;

ALTER TABLE public.ksef229_submissions DROP CONSTRAINT ksef229_submissions_document_kind_check;
ALTER TABLE public.ksef229_submissions ADD CONSTRAINT ksef229_submissions_document_kind_check
 CHECK(document_kind IN ('local_invoice','b2b_invoice','local_consumer_credit','consumer_return_credit','b2b_correction','invoice230','invoice232_correction'));

-- What the user saw and confirmed: the full correction snapshot, valid for 15 minutes.
CREATE TABLE public.invoice232_previews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 original_document_id uuid NOT NULL,
 order_id uuid NOT NULL,
 return_id uuid,
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
 FOREIGN KEY(tenant_id,original_document_id) REFERENCES public.invoice230_documents(tenant_id,document_id),
 CHECK(scope_hash=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')),
 CHECK(expires_at=created_at+interval '15 minutes')
);
CREATE INDEX invoice232_previews_original ON public.invoice232_previews(tenant_id,original_document_id,created_at DESC);

-- Last number of the KOR-S sub-series per 157 series and year; moves by exactly one per issue.
CREATE TABLE public.invoice232_counters (
 tenant_id uuid NOT NULL,
 series_id uuid NOT NULL,
 year integer NOT NULL CHECK(year BETWEEN 2006 AND 2050),
 last_number integer NOT NULL CHECK(last_number BETWEEN 1 AND 999999),
 PRIMARY KEY(tenant_id,series_id,year)
);

-- The issued correction: its place in the chain of corrections of the invoice (position), the state
-- before and after (gross), the signed differences and, for EUR, the rate of the corrected invoice
-- with the PLN differences. `data` is the document as FA(3), print, JPK and KSeF read it.
CREATE TABLE public.invoice232_corrections (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind='correction'),
 mode text NOT NULL CHECK(mode='invoice232_correction'),
 preview_id uuid NOT NULL,
 original_document_id uuid NOT NULL,
 order_id uuid NOT NULL,
 return_id uuid,
 position integer NOT NULL CHECK(position BETWEEN 1 AND 1000),
 series_id uuid NOT NULL,
 year integer NOT NULL CHECK(year BETWEEN 2006 AND 2050),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 999999),
 number text NOT NULL CHECK(number ~ '^KOR-S/[A-Z0-9][A-Z0-9-]{0,11}/[0-9]{4}/[0-9]{6}$'),
 correction_kind text NOT NULL CHECK(correction_kind IN ('return','quantity','price','mixed','cancellation')),
 direction text NOT NULL CHECK(direction IN ('decrease','increase')),
 reason_code text NOT NULL CHECK(reason_code IN ('zwrot','rabat','obnizka_ceny','blad_ilosci','blad_ceny','anulowanie','podwyzka_ceny','cofniecie_korekty','inna')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 256),
 currency text NOT NULL CHECK(currency IN ('PLN','EUR')),
 mid numeric(10,4) CHECK(mid>0),
 mpp_required boolean NOT NULL,
 gross_before_minor bigint NOT NULL CHECK(gross_before_minor>=0),
 net_delta_minor bigint NOT NULL,
 vat_delta_minor bigint NOT NULL,
 gross_delta_minor bigint NOT NULL,
 gross_after_minor bigint NOT NULL CHECK(gross_after_minor>=0),
 net_pln_delta_minor bigint,
 vat_pln_delta_minor bigint,
 gross_pln_delta_minor bigint,
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=1048576),
 scope_hash text NOT NULL CHECK(scope_hash ~ '^[0-9a-f]{64}$'),
 actor_id uuid NOT NULL,
 api_key_id uuid,
 client_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,id,mid),
 UNIQUE(tenant_id,number),
 UNIQUE(tenant_id,series_id,year,sequence),
 UNIQUE(tenant_id,original_document_id,position),
 UNIQUE(tenant_id,preview_id),
 UNIQUE(tenant_id,client_key),
 UNIQUE(tenant_id,return_id),
 FOREIGN KEY(tenant_id,original_document_id) REFERENCES public.invoice230_documents(tenant_id,document_id),
 FOREIGN KEY(tenant_id,original_document_id,mid) REFERENCES public.invoice230_documents(tenant_id,document_id,mid),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES public.invoice232_previews(tenant_id,id),
 CHECK(gross_delta_minor=net_delta_minor+vat_delta_minor AND gross_after_minor=gross_before_minor+gross_delta_minor AND gross_delta_minor<>0),
 CHECK(CASE direction WHEN 'decrease' THEN gross_delta_minor<0 ELSE gross_delta_minor>0 END),
 CHECK(direction='decrease' OR reason_code IN ('podwyzka_ceny','cofniecie_korekty')),
 CHECK(direction='increase' OR reason_code NOT IN ('podwyzka_ceny','cofniecie_korekty')),
 CHECK(correction_kind<>'cancellation' OR (gross_after_minor=0 AND reason_code='anulowanie')),
 CHECK((correction_kind='return')=(return_id IS NOT NULL) AND (correction_kind<>'return' OR reason_code='zwrot')),
 CHECK((currency='PLN')=(mid IS NULL)),
 CHECK((mid IS NULL)=(net_pln_delta_minor IS NULL) AND (mid IS NULL)=(vat_pln_delta_minor IS NULL) AND (mid IS NULL)=(gross_pln_delta_minor IS NULL)),
 CHECK(mid IS NULL OR gross_pln_delta_minor=net_pln_delta_minor+vat_pln_delta_minor),
 CHECK(number=split_part(number,'/',1)||'/'||split_part(number,'/',2)||'/'||year::text||'/'||lpad(sequence::text,6,'0'))
);
CREATE INDEX invoice232_corrections_page ON public.invoice232_corrections(tenant_id,created_at DESC,id DESC);
CREATE INDEX invoice232_corrections_order ON public.invoice232_corrections(tenant_id,order_id,position);

-- Per FA(3) category touched by the correction: before, after, signed difference and, for EUR, the
-- PLN of both states at the header's (= the invoice's) mid, half up to a grosz, and their difference.
CREATE TABLE public.invoice232_categories (
 tenant_id uuid NOT NULL,
 correction_id uuid NOT NULL,
 key text NOT NULL CHECK(key ~ '^(23|8|5|0 KR|zw|np I|np II|oo|oss [0-9]{1,2}\.[0-9]{2})$'),
 rate_code text NOT NULL CHECK(rate_code IN ('23','8','5','oss','0 KR','zw','np I','np II','oo')),
 net_before_minor bigint NOT NULL CHECK(net_before_minor>=0),
 vat_before_minor bigint NOT NULL CHECK(vat_before_minor>=0),
 net_after_minor bigint NOT NULL CHECK(net_after_minor>=0),
 vat_after_minor bigint NOT NULL CHECK(vat_after_minor>=0),
 net_delta_minor bigint NOT NULL,
 vat_delta_minor bigint NOT NULL,
 gross_delta_minor bigint NOT NULL,
 mid numeric(10,4),
 net_pln_before_minor bigint,
 vat_pln_before_minor bigint,
 net_pln_after_minor bigint,
 vat_pln_after_minor bigint,
 net_pln_delta_minor bigint,
 vat_pln_delta_minor bigint,
 PRIMARY KEY(tenant_id,correction_id,key),
 FOREIGN KEY(tenant_id,correction_id) REFERENCES public.invoice232_corrections(tenant_id,id),
 FOREIGN KEY(tenant_id,correction_id,mid) REFERENCES public.invoice232_corrections(tenant_id,id,mid),
 CHECK(net_delta_minor=net_after_minor-net_before_minor AND vat_delta_minor=vat_after_minor-vat_before_minor AND gross_delta_minor=net_delta_minor+vat_delta_minor),
 CHECK(CASE WHEN rate_code='oss' THEN key LIKE 'oss %' ELSE key=rate_code END),
 CHECK(rate_code NOT IN ('zw','np I','np II','oo','0 KR') OR (vat_before_minor=0 AND vat_after_minor=0)),
 CHECK((mid IS NULL)=(net_pln_before_minor IS NULL) AND (mid IS NULL)=(vat_pln_before_minor IS NULL) AND (mid IS NULL)=(net_pln_after_minor IS NULL)
  AND (mid IS NULL)=(vat_pln_after_minor IS NULL) AND (mid IS NULL)=(net_pln_delta_minor IS NULL) AND (mid IS NULL)=(vat_pln_delta_minor IS NULL)),
 CHECK(mid IS NULL OR (net_pln_before_minor=round(net_before_minor*mid) AND vat_pln_before_minor=round(vat_before_minor*mid)
  AND net_pln_after_minor=round(net_after_minor*mid) AND vat_pln_after_minor=round(vat_after_minor*mid)
  AND net_pln_delta_minor=net_pln_after_minor-net_pln_before_minor AND vat_pln_delta_minor=vat_pln_after_minor-vat_pln_before_minor))
);

DO $table232$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['invoice232_previews','invoice232_counters','invoice232_corrections','invoice232_categories'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',t);
 END LOOP;
 GRANT SELECT,INSERT ON public.invoice232_previews,public.invoice232_counters,public.invoice232_corrections,public.invoice232_categories TO dyna_app;
 GRANT UPDATE(last_number) ON public.invoice232_counters TO dyna_app;
END
$table232$;

-- Previews, corrections and categories are append-only, also for the owner.
CREATE FUNCTION public.invoice232_record_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard232$
BEGIN
 RAISE EXCEPTION 'Zapis korekty 232 jest nienaruszalny' USING ERRCODE='55000';
END
$guard232$;
-- The counter starts at 1 and moves by exactly one; it is never deleted.
CREATE FUNCTION public.invoice232_counter_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard232$
BEGIN
 IF TG_OP='INSERT' AND NEW.last_number=1 THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.series_id,NEW.year)=(OLD.tenant_id,OLD.series_id,OLD.year) AND NEW.last_number=OLD.last_number+1 THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'Numeracja korekt 232 przesuwa się tylko o jeden przy wystawieniu' USING ERRCODE='55000';
END
$guard232$;
-- A correction matches its preview, the corrected invoice (order, series, currency, MPP, prefix),
-- the counter already moved to its number, the next place in the chain and the state left by the
-- previous correction; a return correction names a received return case of the same order.
CREATE FUNCTION public.invoice232_correction_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard232$
DECLARE p record;o record;prev record;r record;
BEGIN
 SELECT original_document_id,order_id,return_id,snapshot,scope_hash,actor_id,api_key_id INTO p FROM public.invoice232_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
 SELECT order_id,series_id,currency,mid,mpp_required,gross_minor,snapshot INTO o FROM public.invoice230_documents WHERE (tenant_id,document_id)=(NEW.tenant_id,NEW.original_document_id);
 SELECT position,gross_after_minor INTO prev FROM public.invoice232_corrections WHERE (tenant_id,original_document_id)=(NEW.tenant_id,NEW.original_document_id) ORDER BY position DESC LIMIT 1;
 IF (p.original_document_id,p.order_id,p.scope_hash,p.actor_id) IS DISTINCT FROM (NEW.original_document_id,NEW.order_id,NEW.scope_hash,NEW.actor_id)
 OR p.api_key_id IS DISTINCT FROM NEW.api_key_id OR p.return_id IS DISTINCT FROM NEW.return_id
 OR NEW.data IS DISTINCT FROM p.snapshot||jsonb_build_object('number',NEW.number,'preview_id',NEW.preview_id,'scope_hash',NEW.scope_hash)
 OR (o.order_id,o.series_id,o.currency,o.mpp_required) IS DISTINCT FROM (NEW.order_id,NEW.series_id,NEW.currency,NEW.mpp_required) OR o.mid IS DISTINCT FROM NEW.mid
 OR split_part(NEW.number,'/',2) IS DISTINCT FROM o.snapshot#>>'{series,prefix}'
 OR NEW.position IS DISTINCT FROM coalesce(prev.position,0)+1 OR NEW.gross_before_minor IS DISTINCT FROM coalesce(prev.gross_after_minor,o.gross_minor)
 OR (NEW.data->>'issue_date') IS DISTINCT FROM to_char((NEW.created_at AT TIME ZONE 'UTC')::date,'YYYY-MM-DD')
 OR (NEW.data#>>'{totals,delta,gross_minor}')::bigint IS DISTINCT FROM NEW.gross_delta_minor OR (NEW.data#>>'{totals,delta,net_minor}')::bigint IS DISTINCT FROM NEW.net_delta_minor
 OR (NEW.data#>>'{totals,before,gross_minor}')::bigint IS DISTINCT FROM NEW.gross_before_minor
 OR (NEW.data->>'reason_code',NEW.data->>'reason',NEW.data->>'kind',NEW.data->>'direction') IS DISTINCT FROM (NEW.reason_code,NEW.reason,NEW.correction_kind,NEW.direction)
 OR (NEW.data->>'position')::int IS DISTINCT FROM NEW.position
 OR NOT EXISTS(SELECT 1 FROM public.invoice232_counters c WHERE (c.tenant_id,c.series_id,c.year,c.last_number)=(NEW.tenant_id,NEW.series_id,NEW.year,NEW.sequence))
 THEN RAISE EXCEPTION 'Korekta 232 nie odpowiada podglądowi, fakturze, numeracji lub poprzedniej korekcie' USING ERRCODE='55000';END IF;
 IF NEW.return_id IS NOT NULL THEN
  SELECT order_id,state,received_at INTO r FROM public.return_cases WHERE (tenant_id,id)=(NEW.tenant_id,NEW.return_id);
  IF r.order_id IS DISTINCT FROM NEW.order_id OR r.received_at IS NULL OR r.state NOT IN ('refund_pending','closed') THEN
   RAISE EXCEPTION 'Korekta zwrotu wymaga przyjętego zwrotu tego zamówienia' USING ERRCODE='55000';END IF;
 END IF;
 RETURN NEW;
END
$guard232$;
-- At commit: every counter value has its correction; every correction has categories whose before
-- equals the state left by the last earlier correction of that category (or the invoice) and whose
-- sums are the header's differences.
CREATE FUNCTION public.invoice232_complete() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard232$
DECLARE h record;s record;bad boolean;
BEGIN
 IF TG_TABLE_NAME='invoice232_counters' THEN
  IF NOT EXISTS(SELECT 1 FROM public.invoice232_corrections x WHERE (x.tenant_id,x.series_id,x.year,x.sequence)=(NEW.tenant_id,NEW.series_id,NEW.year,NEW.last_number)) THEN
   RAISE EXCEPTION 'Numer korekty 232 bez dokumentu' USING ERRCODE='55000';END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO h FROM public.invoice232_corrections WHERE (tenant_id,id)=(NEW.tenant_id,NEW.id);
 SELECT count(*) n,sum(net_delta_minor) net,sum(vat_delta_minor) vat,sum(net_pln_delta_minor) net_pln,sum(vat_pln_delta_minor) vat_pln,count(*) FILTER(WHERE mid IS NULL) no_mid
  INTO s FROM public.invoice232_categories WHERE (tenant_id,correction_id)=(NEW.tenant_id,NEW.id);
 IF s.n=0 OR s.net IS DISTINCT FROM h.net_delta_minor OR s.vat IS DISTINCT FROM h.vat_delta_minor
 OR (h.mid IS NULL AND s.no_mid<>s.n) OR (h.mid IS NOT NULL AND (s.no_mid<>0 OR s.net_pln IS DISTINCT FROM h.net_pln_delta_minor OR s.vat_pln IS DISTINCT FROM h.vat_pln_delta_minor)) THEN
  RAISE EXCEPTION 'Podsumowanie kategorii nie odpowiada korekcie 232' USING ERRCODE='55000';END IF;
 SELECT EXISTS(
  SELECT 1 FROM public.invoice232_categories k
  LEFT JOIN public.invoice230_categories oc ON (oc.tenant_id,oc.document_id,oc.key)=(k.tenant_id,h.original_document_id,k.key)
  LEFT JOIN LATERAL (SELECT pk.net_after_minor,pk.vat_after_minor FROM public.invoice232_categories pk JOIN public.invoice232_corrections pc ON (pc.tenant_id,pc.id)=(pk.tenant_id,pk.correction_id)
   WHERE pk.tenant_id=k.tenant_id AND pk.key=k.key AND pc.original_document_id=h.original_document_id AND pc.position<h.position ORDER BY pc.position DESC LIMIT 1) pv ON true
  WHERE (k.tenant_id,k.correction_id)=(NEW.tenant_id,NEW.id)
  AND (oc.key IS NULL OR (k.net_before_minor,k.vat_before_minor) IS DISTINCT FROM (coalesce(pv.net_after_minor,oc.net_minor),coalesce(pv.vat_after_minor,oc.vat_minor))
   OR k.rate_code IS DISTINCT FROM oc.rate_code)) INTO bad;
 IF bad THEN RAISE EXCEPTION 'Stan przed korektą 232 nie odpowiada fakturze i poprzednim korektom' USING ERRCODE='55000';END IF;
 RETURN NULL;
END
$guard232$;
CREATE FUNCTION public.invoice232_truncate_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard232$
BEGIN
 RAISE EXCEPTION 'Zapisów korekt 232 nie można usunąć' USING ERRCODE='55000';
END
$guard232$;

CREATE TRIGGER invoice232_previews_keep BEFORE UPDATE OR DELETE ON public.invoice232_previews FOR EACH ROW EXECUTE FUNCTION public.invoice232_record_guard();
CREATE TRIGGER invoice232_corrections_keep BEFORE UPDATE OR DELETE ON public.invoice232_corrections FOR EACH ROW EXECUTE FUNCTION public.invoice232_record_guard();
CREATE TRIGGER invoice232_categories_keep BEFORE UPDATE OR DELETE ON public.invoice232_categories FOR EACH ROW EXECUTE FUNCTION public.invoice232_record_guard();
CREATE TRIGGER invoice232_counters_guard BEFORE INSERT OR UPDATE OR DELETE ON public.invoice232_counters FOR EACH ROW EXECUTE FUNCTION public.invoice232_counter_guard();
CREATE TRIGGER invoice232_corrections_guard BEFORE INSERT ON public.invoice232_corrections FOR EACH ROW EXECUTE FUNCTION public.invoice232_correction_guard();
CREATE CONSTRAINT TRIGGER invoice232_counters_complete AFTER INSERT OR UPDATE ON public.invoice232_counters DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.invoice232_complete();
CREATE CONSTRAINT TRIGGER invoice232_corrections_complete AFTER INSERT ON public.invoice232_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.invoice232_complete();
CREATE TRIGGER invoice232_previews_truncate BEFORE TRUNCATE ON public.invoice232_previews FOR EACH STATEMENT EXECUTE FUNCTION public.invoice232_truncate_guard();
CREATE TRIGGER invoice232_counters_truncate BEFORE TRUNCATE ON public.invoice232_counters FOR EACH STATEMENT EXECUTE FUNCTION public.invoice232_truncate_guard();
CREATE TRIGGER invoice232_corrections_truncate BEFORE TRUNCATE ON public.invoice232_corrections FOR EACH STATEMENT EXECUTE FUNCTION public.invoice232_truncate_guard();
CREATE TRIGGER invoice232_categories_truncate BEFORE TRUNCATE ON public.invoice232_categories FOR EACH STATEMENT EXECUTE FUNCTION public.invoice232_truncate_guard();
REVOKE ALL ON FUNCTION public.invoice232_record_guard(),public.invoice232_counter_guard(),public.invoice232_correction_guard(),public.invoice232_complete(),public.invoice232_truncate_guard() FROM PUBLIC;
