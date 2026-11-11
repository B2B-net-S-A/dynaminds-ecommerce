-- Successor to 232, registered in db.ts migrate() after 232 (25.10.2026).
-- Fiscal receipts (paragony) printed on a local fiscal printer: the printer configuration per tenant,
-- receipt jobs of orders (queued → sent → printed | failed, failed → queued on a retry), the daily
-- reports and the links of invoices issued to a receipt (faktura do paragonu). Own tables only; the
-- foreign keys leave them for the core orders and documents. Nothing is attached to a core table.
DO $dependency233$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.orders') IS NULL OR to_regclass('public.documents') IS NULL
 OR to_regclass('public.invoice230_documents') IS NULL
 OR to_regclass('public.invoice232_corrections') IS NULL
 THEN RAISE EXCEPTION 'Paragony fiskalne (233) wymagają zainstalowanych 230 i 232' USING ERRCODE='55000';END IF;
END
$dependency233$;

-- The fiscal printer of the tenant: model family, loopback connection, unique number (numer unikatowy)
-- and the PTU table it is programmed with. At most one active printer per tenant; a printer is never
-- deleted (its receipts point to it); a new device is a new row.
CREATE TABLE public.receipt233_printers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 model_family text NOT NULL CHECK(model_family IN ('posnet','elzab','novitus')),
 host text NOT NULL CHECK(host IN ('127.0.0.1','::1','localhost')),
 port integer NOT NULL CHECK(port BETWEEN 1024 AND 65535),
 unique_number text NOT NULL CHECK(unique_number ~ '^[A-Z]{3}[0-9]{8}$'),
 ptu jsonb NOT NULL CHECK(jsonb_typeof(ptu)='object' AND ptu ?& ARRAY['A','B','C','D','E','F','G'] AND ptu-ARRAY['A','B','C','D','E','F','G']='{}'::jsonb
  AND ptu->'A' IN ('"23"','"8"','"5"','"0"','"zw"','null') AND ptu->'B' IN ('"23"','"8"','"5"','"0"','"zw"','null') AND ptu->'C' IN ('"23"','"8"','"5"','"0"','"zw"','null')
  AND ptu->'D' IN ('"23"','"8"','"5"','"0"','"zw"','null') AND ptu->'E' IN ('"23"','"8"','"5"','"0"','"zw"','null') AND ptu->'F' IN ('"23"','"8"','"5"','"0"','"zw"','null')
  AND ptu->'G' IN ('"23"','"8"','"5"','"0"','"zw"','null')),
 active boolean NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 1000000),
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,unique_number)
);
CREATE UNIQUE INDEX receipt233_printers_active ON public.receipt233_printers(tenant_id) WHERE active;

-- A receipt job of one order: what the user confirmed (snapshot: order, lines with their PTU letters,
-- PTU totals with the invoice math, payment form, buyer NIP) and the printer's answer.
CREATE TABLE public.receipt233_receipts (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 order_id uuid NOT NULL,
 printer_id uuid NOT NULL,
 printer_unique_number text NOT NULL CHECK(printer_unique_number ~ '^[A-Z]{3}[0-9]{8}$'),
 client_key uuid NOT NULL,
 actor_id uuid NOT NULL,
 api_key_id uuid,
 state text NOT NULL CHECK(state IN ('queued','sent','printed','failed')),
 payment_form text NOT NULL CHECK(payment_form IN ('gotowka','karta','przelew','mobilna','pobranie')),
 buyer_nip text CHECK(buyer_nip ~ '^[0-9]{10}$'),
 simplified_invoice boolean NOT NULL,
 net_minor bigint NOT NULL CHECK(net_minor>=0),
 vat_minor bigint NOT NULL CHECK(vat_minor>=0),
 gross_minor bigint NOT NULL CHECK(gross_minor>0),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=262144),
 scope_hash text NOT NULL,
 attempts integer NOT NULL CHECK(attempts BETWEEN 0 AND 1000),
 printer_receipt_number text CHECK(printer_receipt_number ~ '^[0-9]{1,8}$'),
 fiscal_date date,
 error_code text CHECK(error_code IN ('PAPER_OUT','OFFLINE','PTU_MISMATCH','TOTAL_MISMATCH','PROTOCOL','PRINTER_ERROR')),
 error_message text CHECK(length(error_message) BETWEEN 1 AND 300),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 sent_at timestamptz,
 printed_at timestamptz,
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,order_id),
 UNIQUE(tenant_id,client_key),
 UNIQUE(tenant_id,printer_unique_number,fiscal_date,printer_receipt_number),
 FOREIGN KEY(tenant_id,order_id) REFERENCES public.orders(tenant_id,id),
 FOREIGN KEY(tenant_id,printer_id) REFERENCES public.receipt233_printers(tenant_id,id),
 CHECK(gross_minor=net_minor+vat_minor),
 CHECK(simplified_invoice=(buyer_nip IS NOT NULL AND gross_minor<=45000)),
 CHECK(scope_hash=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')),
 CHECK(snapshot->>'format'='receipt233/v1' AND (snapshot#>>'{totals,gross_minor}')=gross_minor::text AND (snapshot#>>'{totals,net_minor}')=net_minor::text
  AND (snapshot#>>'{totals,vat_minor}')=vat_minor::text AND (snapshot->>'payment_form')=payment_form AND (snapshot->>'buyer_nip') IS NOT DISTINCT FROM buyer_nip
  AND (snapshot->>'order_id')=order_id::text AND jsonb_typeof(snapshot->'lines')='array' AND jsonb_array_length(snapshot->'lines') BETWEEN 1 AND 101),
 CHECK((state='printed')=(printer_receipt_number IS NOT NULL AND fiscal_date IS NOT NULL AND printed_at IS NOT NULL)),
 CHECK((state='failed')=(error_code IS NOT NULL AND error_message IS NOT NULL)),
 CHECK((state='queued' AND attempts>=0) OR (state<>'queued' AND attempts>=1 AND sent_at IS NOT NULL))
);
CREATE INDEX receipt233_receipts_page ON public.receipt233_receipts(tenant_id,created_at DESC,id DESC);
CREATE INDEX receipt233_receipts_day ON public.receipt233_receipts(tenant_id,printer_id,fiscal_date) WHERE state='printed';

-- The daily fiscal report (raport fiskalny dobowy) read from the printer, with the app's own sums of the
-- receipts printed on that printer that day: `matches` tells whether the gross per PTU agrees.
CREATE TABLE public.receipt233_daily_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 printer_id uuid NOT NULL,
 printer_unique_number text NOT NULL CHECK(printer_unique_number ~ '^[A-Z]{3}[0-9]{8}$'),
 fiscal_date date NOT NULL,
 report_number text NOT NULL CHECK(report_number ~ '^[0-9]{1,8}$'),
 printer_receipts integer NOT NULL CHECK(printer_receipts>=0),
 printer_totals jsonb NOT NULL CHECK(jsonb_typeof(printer_totals)='array'),
 app_receipts integer NOT NULL CHECK(app_receipts>=0),
 app_totals jsonb NOT NULL CHECK(jsonb_typeof(app_totals)='array'),
 matches boolean NOT NULL,
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,printer_id,fiscal_date),
 FOREIGN KEY(tenant_id,printer_id) REFERENCES public.receipt233_printers(tenant_id,id)
);

-- An invoice issued to a printed receipt (faktura do paragonu, art. 106b ust. 1 pkt 4 / ust. 5): one invoice
-- per receipt, written in the issuing transaction of the 157 or 230 invoice.
CREATE TABLE public.receipt233_invoice_links (
 tenant_id uuid NOT NULL,
 receipt_id uuid NOT NULL,
 document_id uuid NOT NULL,
 document_mode text NOT NULL CHECK(document_mode IN ('local_invoice','invoice230')),
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,receipt_id),
 UNIQUE(tenant_id,document_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES public.receipt233_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.documents(tenant_id,id)
);

DO $table233$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['receipt233_printers','receipt233_receipts','receipt233_daily_reports','receipt233_invoice_links'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',t);
 END LOOP;
 GRANT SELECT,INSERT ON public.receipt233_printers,public.receipt233_receipts,public.receipt233_daily_reports,public.receipt233_invoice_links TO dyna_app;
 GRANT UPDATE(name,model_family,host,port,ptu,active,version,actor_id,updated_at) ON public.receipt233_printers TO dyna_app;
 GRANT UPDATE(state,attempts,printer_receipt_number,fiscal_date,error_code,error_message,updated_at,sent_at,printed_at) ON public.receipt233_receipts TO dyna_app;
END
$table233$;

-- A printer changes only its configuration, one version at a time; its identity and unique number stay.
CREATE FUNCTION public.receipt233_printer_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard233$
BEGIN
 IF TG_OP='INSERT' AND NEW.version=1 THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND (NEW.id,NEW.tenant_id,NEW.unique_number,NEW.created_at)=(OLD.id,OLD.tenant_id,OLD.unique_number,OLD.created_at) AND NEW.version=OLD.version+1 THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'Konfiguracja drukarki fiskalnej 233 zmienia się tylko o jedną wersję; drukarki nie usuwa się' USING ERRCODE='55000';
END
$guard233$;
-- A receipt starts queued on the active printer of its tenant, for an order without an invoice; afterwards
-- only its state moves (queued → sent → printed | failed, failed → queued) and the printer's answer is
-- recorded; a printed receipt never changes.
CREATE FUNCTION public.receipt233_receipt_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard233$
DECLARE p record;
BEGIN
 IF TG_OP='INSERT' THEN
  SELECT active,unique_number INTO p FROM public.receipt233_printers WHERE (tenant_id,id)=(NEW.tenant_id,NEW.printer_id);
  IF NEW.state<>'queued' OR NEW.attempts<>0 OR NEW.sent_at IS NOT NULL OR p.active IS DISTINCT FROM true OR p.unique_number IS DISTINCT FROM NEW.printer_unique_number
  OR EXISTS(SELECT 1 FROM public.documents d WHERE d.tenant_id=NEW.tenant_id AND d.order_id=NEW.order_id AND d.kind='invoice' AND d.mode NOT IN ('demo','simulation','provider_test')) THEN
   RAISE EXCEPTION 'Paragon 233 wymaga aktywnej drukarki i zamówienia bez faktury' USING ERRCODE='55000';END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR (NEW.id,NEW.tenant_id,NEW.order_id,NEW.printer_id,NEW.printer_unique_number,NEW.client_key,NEW.actor_id,NEW.payment_form,NEW.simplified_invoice,NEW.net_minor,NEW.vat_minor,NEW.gross_minor,NEW.snapshot,NEW.scope_hash,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.order_id,OLD.printer_id,OLD.printer_unique_number,OLD.client_key,OLD.actor_id,OLD.payment_form,OLD.simplified_invoice,OLD.net_minor,OLD.vat_minor,OLD.gross_minor,OLD.snapshot,OLD.scope_hash,OLD.created_at)
  OR NEW.api_key_id IS DISTINCT FROM OLD.api_key_id OR NEW.buyer_nip IS DISTINCT FROM OLD.buyer_nip
  OR NOT ((OLD.state,NEW.state) IN (('queued','sent'),('sent','printed'),('sent','failed'),('failed','queued')))
  OR (NEW.state='sent' AND NEW.attempts IS DISTINCT FROM OLD.attempts+1)
  OR (NEW.state<>'sent' AND NEW.attempts IS DISTINCT FROM OLD.attempts)
  OR (NEW.state='printed' AND (NEW.sent_at IS DISTINCT FROM OLD.sent_at OR NEW.error_code IS NOT NULL OR NEW.error_message IS NOT NULL))
  OR (NEW.state IN ('queued','sent') AND (NEW.printer_receipt_number IS NOT NULL OR NEW.fiscal_date IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.error_message IS NOT NULL))
  OR (NEW.state='failed' AND (NEW.sent_at IS DISTINCT FROM OLD.sent_at OR NEW.printer_receipt_number IS NOT NULL)) THEN
  RAISE EXCEPTION 'Paragon 233 zmienia tylko stan druku (kolejka, wysłany, wydrukowany, błąd); wydrukowany paragon jest nienaruszalny' USING ERRCODE='55000';END IF;
 RETURN NEW;
END
$guard233$;
-- An invoice is linked to a printed receipt of the same order and amount; an invoice for a business
-- requires that business's NIP on the receipt (art. 106b ust. 5).
CREATE FUNCTION public.receipt233_link_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard233$
DECLARE r record;d record;
BEGIN
 SELECT order_id,state,buyer_nip,gross_minor INTO r FROM public.receipt233_receipts WHERE (tenant_id,id)=(NEW.tenant_id,NEW.receipt_id);
 SELECT order_id,kind,mode,data INTO d FROM public.documents WHERE (tenant_id,id)=(NEW.tenant_id,NEW.document_id);
 IF r.state IS DISTINCT FROM 'printed' OR d.kind IS DISTINCT FROM 'invoice' OR d.mode IS DISTINCT FROM NEW.document_mode OR d.order_id IS DISTINCT FROM r.order_id
 OR (d.data#>>'{totals,gross_minor}') IS DISTINCT FROM r.gross_minor::text
 OR (coalesce(d.data#>>'{buyer,kind}','consumer')='business' AND (r.buyer_nip IS NULL OR d.data#>>'{buyer,tax_id_kind}' IS DISTINCT FROM 'nip' OR d.data#>>'{buyer,tax_id}' IS DISTINCT FROM r.buyer_nip)) THEN
  RAISE EXCEPTION 'Faktura do paragonu 233 wymaga wydrukowanego paragonu tego zamówienia, tej samej kwoty i NIP nabywcy na paragonie' USING ERRCODE='55000';END IF;
 RETURN NEW;
END
$guard233$;
CREATE FUNCTION public.receipt233_record_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard233$
BEGIN
 RAISE EXCEPTION 'Zapis paragonów 233 jest nienaruszalny' USING ERRCODE='55000';
END
$guard233$;

CREATE TRIGGER receipt233_printers_guard BEFORE INSERT OR UPDATE OR DELETE ON public.receipt233_printers FOR EACH ROW EXECUTE FUNCTION public.receipt233_printer_guard();
CREATE TRIGGER receipt233_receipts_guard BEFORE INSERT OR UPDATE OR DELETE ON public.receipt233_receipts FOR EACH ROW EXECUTE FUNCTION public.receipt233_receipt_guard();
CREATE TRIGGER receipt233_invoice_links_guard BEFORE INSERT ON public.receipt233_invoice_links FOR EACH ROW EXECUTE FUNCTION public.receipt233_link_guard();
CREATE TRIGGER receipt233_invoice_links_keep BEFORE UPDATE OR DELETE ON public.receipt233_invoice_links FOR EACH ROW EXECUTE FUNCTION public.receipt233_record_guard();
CREATE TRIGGER receipt233_daily_reports_keep BEFORE UPDATE OR DELETE ON public.receipt233_daily_reports FOR EACH ROW EXECUTE FUNCTION public.receipt233_record_guard();
CREATE TRIGGER receipt233_printers_truncate BEFORE TRUNCATE ON public.receipt233_printers FOR EACH STATEMENT EXECUTE FUNCTION public.receipt233_record_guard();
CREATE TRIGGER receipt233_receipts_truncate BEFORE TRUNCATE ON public.receipt233_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.receipt233_record_guard();
CREATE TRIGGER receipt233_daily_reports_truncate BEFORE TRUNCATE ON public.receipt233_daily_reports FOR EACH STATEMENT EXECUTE FUNCTION public.receipt233_record_guard();
CREATE TRIGGER receipt233_invoice_links_truncate BEFORE TRUNCATE ON public.receipt233_invoice_links FOR EACH STATEMENT EXECUTE FUNCTION public.receipt233_record_guard();
REVOKE ALL ON FUNCTION public.receipt233_printer_guard(),public.receipt233_receipt_guard(),public.receipt233_link_guard(),public.receipt233_record_guard() FROM PUBLIC;
