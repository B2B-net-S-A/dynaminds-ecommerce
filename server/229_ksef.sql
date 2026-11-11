-- Successor to228, registered in db.ts migrate() after228 (23.10.2026).
-- KSeF 2.0 (stage 3, step 4): per-NIP connection settings with an encrypted secret,
-- the KSeF sessions opened by the app, one submission per issued document (the exact
-- FA(3) XML sent, its hash, KSeF reference, status, KSeF number, UPO, and the offline
-- data: mode, reason, QR codes and the send deadline) and an append-only event log.
-- Only own tables are added, without any foreign key to a core table: invoices and
-- corrections live in several ledgers, so document ids are plain uuids checked by the
-- application. No trigger, column, constraint or grant is attached to a core table.
DO $dependency229$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.rodo228_access_log') IS NULL
 OR to_regclass('public.documents') IS NULL
 THEN RAISE EXCEPTION 'KSeF requires owner-installed228' USING ERRCODE='55000';END IF;
END
$dependency229$;

-- Connection settings of one seller NIP. The secret (KSeF token, or certificate with its
-- private key, and the optional offline certificate) is the application's AES-256-GCM
-- ciphertext; only a keyed fingerprint is readable. Rows are deactivated, never deleted.
CREATE TABLE public.ksef229_configs (
 tenant_id uuid NOT NULL,
 nip text NOT NULL CHECK(nip ~ '^[0-9]{10}$'),
 environment text NOT NULL CHECK(environment IN ('local_fake','test','demo','prod')),
 base_url text,
 auth_method text NOT NULL CHECK(auth_method IN ('token','certificate')),
 secret_ciphertext text NOT NULL CHECK(length(secret_ciphertext) BETWEEN 40 AND 65536),
 secret_fingerprint text NOT NULL CHECK(secret_fingerprint ~ '^[0-9a-f]{16}$'),
 certificate_serial text CHECK(certificate_serial ~ '^[0-9A-Fa-f]{1,64}$'),
 offline_certificate_serial text CHECK(offline_certificate_serial ~ '^[0-9A-Fa-f]{1,64}$'),
 active boolean NOT NULL DEFAULT true,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,nip),
 CHECK(CASE WHEN environment='local_fake' THEN base_url ~ '^https?://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$' ELSE base_url IS NULL END),
 CHECK((auth_method='certificate')=(certificate_serial IS NOT NULL))
);

-- A KSeF session (online; batch is reserved). The reference is set once; closed and failed are final.
CREATE TABLE public.ksef229_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 nip text NOT NULL CHECK(nip ~ '^[0-9]{10}$'),
 environment text NOT NULL CHECK(environment IN ('local_fake','test','demo','prod')),
 kind text NOT NULL CHECK(kind IN ('online','batch')),
 state text NOT NULL CHECK(state IN ('opening','open','closed','failed')),
 reference_number text CHECK(reference_number ~ '^[A-Za-z0-9-]{1,64}$'),
 valid_until timestamptz,
 error text CHECK(length(error)<=2000),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 opened_at timestamptz,
 closed_at timestamptz,
 UNIQUE(tenant_id,id),
 CHECK(state='opening' OR state='failed' OR reference_number IS NOT NULL),
 CHECK((state IN ('closed','failed'))=(closed_at IS NOT NULL)),
 CHECK((state='failed')=(error IS NOT NULL))
);
CREATE INDEX ksef229_sessions_page ON public.ksef229_sessions(tenant_id,created_at DESC);

-- One live submission per issued document (rejected ones stay as history). The XML is the
-- exact FA(3) file sent or to be sent: an offline invoice keeps the bytes its QR code hashes.
CREATE TABLE public.ksef229_submissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 document_id uuid NOT NULL,
 document_kind text NOT NULL CHECK(document_kind IN ('local_invoice','b2b_invoice','local_consumer_credit','consumer_return_credit','b2b_correction')),
 document_number text NOT NULL CHECK(length(document_number) BETWEEN 1 AND 256),
 nip text NOT NULL CHECK(nip ~ '^[0-9]{10}$'),
 environment text NOT NULL CHECK(environment IN ('local_fake','test','demo','prod')),
 issue_date date NOT NULL,
 xml text NOT NULL,
 xml_sha256 text NOT NULL CHECK(xml_sha256 ~ '^[0-9a-f]{64}$'),
 xml_bytes integer NOT NULL CHECK(xml_bytes BETWEEN 1 AND 3145728),
 issue_mode text NOT NULL CHECK(issue_mode IN ('online','offline24','offline','awaryjny')),
 offline_reason text CHECK(length(offline_reason) BETWEEN 1 AND 500),
 offline_at timestamptz,
 send_deadline date,
 qr_invoice_url text CHECK(length(qr_invoice_url)<=1000),
 qr_certificate_url text CHECK(length(qr_certificate_url)<=2000),
 state text NOT NULL CHECK(state IN ('queued','sent','accepted','rejected')),
 session_id uuid,
 reference_number text CHECK(reference_number ~ '^[A-Za-z0-9-]{1,64}$'),
 status_code integer CHECK(status_code BETWEEN 100 AND 999),
 status_description text CHECK(length(status_description)<=1000),
 status_details jsonb CHECK(status_details IS NULL OR jsonb_typeof(status_details)='array'),
 ksef_number text CHECK(ksef_number ~ '^[0-9]{10}-[0-9]{8}-[0-9A-F]{12}-[0-9A-F]{2}$'),
 acquisition_at timestamptz,
 upo_xml text CHECK(length(upo_xml)<=1048576),
 upo_sha256 text CHECK(upo_sha256 ~ '^[0-9a-f]{64}$'),
 upo_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10000),
 last_error text CHECK(length(last_error)<=2000),
 last_attempt_at timestamptz,
 lease_until timestamptz,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,ksef_number),
 FOREIGN KEY(tenant_id,session_id) REFERENCES public.ksef229_sessions(tenant_id,id),
 CHECK(xml_sha256=encode(sha256(convert_to(xml,'UTF8')),'hex') AND xml_bytes=octet_length(convert_to(xml,'UTF8'))),
 CHECK((state='accepted')=(ksef_number IS NOT NULL) AND (ksef_number IS NULL)=(acquisition_at IS NULL)),
 CHECK(state NOT IN ('sent','accepted') OR (reference_number IS NOT NULL AND session_id IS NOT NULL)),
 CHECK(state<>'rejected' OR status_code IS NOT NULL),
 CHECK((issue_mode='online')=(offline_reason IS NULL) AND (offline_reason IS NULL)=(offline_at IS NULL) AND (offline_reason IS NULL)=(qr_invoice_url IS NULL)),
 CHECK(issue_mode<>'online' OR (send_deadline IS NULL AND qr_certificate_url IS NULL)),
 CHECK(issue_mode='awaryjny' OR (issue_mode='online')=(send_deadline IS NULL)),
 CHECK((upo_xml IS NULL)=(upo_sha256 IS NULL) AND (upo_xml IS NULL)=(upo_at IS NULL)),
 CHECK(upo_xml IS NULL OR (state='accepted' AND upo_sha256=encode(sha256(convert_to(upo_xml,'UTF8')),'hex')))
);
CREATE UNIQUE INDEX ksef229_submissions_live ON public.ksef229_submissions(tenant_id,document_id) WHERE state<>'rejected';
CREATE INDEX ksef229_submissions_queue ON public.ksef229_submissions(tenant_id,send_deadline,created_at) WHERE state IN ('queued','sent');
CREATE INDEX ksef229_submissions_document ON public.ksef229_submissions(tenant_id,document_id,created_at DESC);

-- What happened to a submission or session, without any secret or token (append-only).
CREATE TABLE public.ksef229_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 submission_id uuid,
 session_id uuid,
 nip text NOT NULL CHECK(nip ~ '^[0-9]{10}$'),
 at timestamptz NOT NULL DEFAULT clock_timestamp(),
 kind text NOT NULL CHECK(kind IN ('config','check','session_open','session_close','send','status','upo','offline','unavailable','refused','error')),
 code integer CHECK(code BETWEEN 100 AND 999),
 message text NOT NULL CHECK(length(message) BETWEEN 1 AND 2000),
 actor_id uuid,
 FOREIGN KEY(tenant_id,submission_id) REFERENCES public.ksef229_submissions(tenant_id,id),
 FOREIGN KEY(tenant_id,session_id) REFERENCES public.ksef229_sessions(tenant_id,id)
);
CREATE INDEX ksef229_events_submission ON public.ksef229_events(tenant_id,submission_id,at);

DO $table229$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['ksef229_configs','ksef229_sessions','ksef229_submissions','ksef229_events'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',t);
 END LOOP;
 GRANT SELECT,INSERT ON public.ksef229_configs,public.ksef229_sessions,public.ksef229_submissions,public.ksef229_events TO dyna_app;
 GRANT UPDATE(environment,base_url,auth_method,secret_ciphertext,secret_fingerprint,certificate_serial,offline_certificate_serial,active,updated_by,updated_at) ON public.ksef229_configs TO dyna_app;
 GRANT UPDATE(state,reference_number,valid_until,error,opened_at,closed_at) ON public.ksef229_sessions TO dyna_app;
 GRANT UPDATE(issue_mode,offline_reason,offline_at,send_deadline,qr_invoice_url,qr_certificate_url,state,session_id,reference_number,status_code,status_description,status_details,
  ksef_number,acquisition_at,upo_xml,upo_sha256,upo_at,attempts,last_error,last_attempt_at,lease_until,updated_at) ON public.ksef229_submissions TO dyna_app;
END
$table229$;

-- Settings rows and events are never deleted or truncated, also by the owner.
CREATE FUNCTION public.ksef229_keep_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard229$
BEGIN
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='ksef229_configs' THEN
  IF (NEW.tenant_id,NEW.nip,NEW.created_by,NEW.created_at) IS NOT DISTINCT FROM (OLD.tenant_id,OLD.nip,OLD.created_by,OLD.created_at) THEN RETURN NEW;END IF;
 END IF;
 RAISE EXCEPTION 'Zapis KSeF jest nienaruszalny' USING ERRCODE='55000';
END
$guard229$;
-- opening -> open|failed, open -> closed|failed; the reference is set once.
CREATE FUNCTION public.ksef229_session_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard229$
BEGIN
 IF TG_OP='UPDATE'
 AND (to_jsonb(NEW)-'state'-'reference_number'-'valid_until'-'error'-'opened_at'-'closed_at')=(to_jsonb(OLD)-'state'-'reference_number'-'valid_until'-'error'-'opened_at'-'closed_at')
 AND (OLD.reference_number IS NULL OR NEW.reference_number IS NOT DISTINCT FROM OLD.reference_number)
 AND ((OLD.state='opening' AND NEW.state IN ('open','failed')) OR (OLD.state='open' AND NEW.state IN ('closed','failed') AND NEW.opened_at IS NOT DISTINCT FROM OLD.opened_at))
 THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'Sesja KSeF: niedozwolona zmiana stanu' USING ERRCODE='55000';
END
$guard229$;
-- The document, its XML and hash never change. queued -> queued|sent|accepted|rejected,
-- sent -> sent|accepted|rejected, accepted keeps everything except the UPO (set once),
-- rejected is final. Offline data is set once (online -> offline only while queued);
-- the emergency send deadline may be added once. The KSeF reference and number are set once.
CREATE FUNCTION public.ksef229_submission_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard229$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Wysyłka KSeF jest nienaruszalna' USING ERRCODE='55000';END IF;
 IF (NEW.id,NEW.tenant_id,NEW.document_id,NEW.document_kind,NEW.document_number,NEW.nip,NEW.environment,NEW.issue_date,NEW.xml,NEW.xml_sha256,NEW.xml_bytes,NEW.created_by,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.document_id,OLD.document_kind,OLD.document_number,OLD.nip,OLD.environment,OLD.issue_date,OLD.xml,OLD.xml_sha256,OLD.xml_bytes,OLD.created_by,OLD.created_at) THEN
  RAISE EXCEPTION 'Wysyłka KSeF: dokument i jego XML są nienaruszalne' USING ERRCODE='55000';END IF;
 IF OLD.state='rejected'
 OR (OLD.state='sent' AND NEW.state NOT IN ('sent','accepted','rejected'))
 OR (OLD.state='accepted' AND ((to_jsonb(NEW)-'upo_xml'-'upo_sha256'-'upo_at'-'updated_at'-'lease_until')<>(to_jsonb(OLD)-'upo_xml'-'upo_sha256'-'upo_at'-'updated_at'-'lease_until') OR OLD.upo_xml IS NOT NULL AND NEW.upo_xml IS DISTINCT FROM OLD.upo_xml))
 THEN RAISE EXCEPTION 'Wysyłka KSeF: niedozwolona zmiana stanu %->%',OLD.state,NEW.state USING ERRCODE='55000';END IF;
 IF OLD.issue_mode<>'online' AND ((NEW.issue_mode,NEW.offline_reason,NEW.offline_at,NEW.qr_invoice_url,NEW.qr_certificate_url) IS DISTINCT FROM (OLD.issue_mode,OLD.offline_reason,OLD.offline_at,OLD.qr_invoice_url,OLD.qr_certificate_url)
  OR (OLD.send_deadline IS NOT NULL AND NEW.send_deadline IS DISTINCT FROM OLD.send_deadline))
 OR (OLD.issue_mode='online' AND NEW.issue_mode<>'online' AND NOT (OLD.state='queued' AND NEW.state='queued'))
 THEN RAISE EXCEPTION 'Wysyłka KSeF: dane trybu offline są nienaruszalne' USING ERRCODE='55000';END IF;
 IF (OLD.reference_number IS NOT NULL AND NEW.reference_number IS DISTINCT FROM OLD.reference_number)
 OR (OLD.session_id IS NOT NULL AND OLD.state<>'queued' AND NEW.session_id IS DISTINCT FROM OLD.session_id)
 OR (OLD.ksef_number IS NOT NULL AND NEW.ksef_number IS DISTINCT FROM OLD.ksef_number)
 THEN RAISE EXCEPTION 'Wysyłka KSeF: numer referencyjny i numer KSeF nadaje się raz' USING ERRCODE='55000';END IF;
 RETURN NEW;
END
$guard229$;
REVOKE ALL ON FUNCTION public.ksef229_keep_guard(),public.ksef229_session_guard(),public.ksef229_submission_guard() FROM PUBLIC,dyna_app;
CREATE TRIGGER ksef229_configs_keep BEFORE UPDATE OR DELETE ON public.ksef229_configs FOR EACH ROW EXECUTE FUNCTION public.ksef229_keep_guard();
CREATE TRIGGER ksef229_configs_no_truncate BEFORE TRUNCATE ON public.ksef229_configs FOR EACH STATEMENT EXECUTE FUNCTION public.ksef229_keep_guard();
CREATE TRIGGER ksef229_sessions_guard BEFORE UPDATE OR DELETE ON public.ksef229_sessions FOR EACH ROW EXECUTE FUNCTION public.ksef229_session_guard();
CREATE TRIGGER ksef229_sessions_no_truncate BEFORE TRUNCATE ON public.ksef229_sessions FOR EACH STATEMENT EXECUTE FUNCTION public.ksef229_session_guard();
CREATE TRIGGER ksef229_submissions_guard BEFORE UPDATE OR DELETE ON public.ksef229_submissions FOR EACH ROW EXECUTE FUNCTION public.ksef229_submission_guard();
CREATE TRIGGER ksef229_submissions_no_truncate BEFORE TRUNCATE ON public.ksef229_submissions FOR EACH STATEMENT EXECUTE FUNCTION public.ksef229_submission_guard();
CREATE TRIGGER ksef229_events_append_only BEFORE UPDATE OR DELETE ON public.ksef229_events FOR EACH ROW EXECUTE FUNCTION public.ksef229_keep_guard();
CREATE TRIGGER ksef229_events_no_truncate BEFORE TRUNCATE ON public.ksef229_events FOR EACH STATEMENT EXECUTE FUNCTION public.ksef229_keep_guard();
