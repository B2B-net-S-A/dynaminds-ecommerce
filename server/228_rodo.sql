-- Successor to227, registered in db.ts migrate() after227 (23.10.2026).
-- RODO (stage 3, step 3): the register of access to customers' personal data
-- (who read or exported whose data, when and why; append-only, purged only after
-- the tenant's configured retention), anonymisation requests with their preview and
-- result, and the fields kept for a legal retention period with their due date.
-- Only own tables are added, without any foreign key to a core table: no trigger,
-- column, constraint or grant is attached to orders, documents, CRM or any other core
-- table. Anonymisation itself is done by the application through ordinary UPDATEs.
DO $dependency228$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.nbp227_document_rates') IS NULL
 OR to_regclass('public.crm_clients') IS NULL
 OR to_regclass('public.orders') IS NULL
 THEN RAISE EXCEPTION 'RODO register requires owner-installed227' USING ERRCODE='55000';END IF;
END
$dependency228$;

-- Retention of the access register per tenant (default 5 years).
CREATE TABLE public.rodo228_settings (
 tenant_id uuid PRIMARY KEY,
 access_log_retention_days integer NOT NULL DEFAULT 1825 CHECK(access_log_retention_days BETWEEN 180 AND 3650),
 actor_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- One row per customer whose personal data was read, listed, exported or anonymised.
-- subject_hash is a keyed hash of the customer's e-mail or phone, never the value itself.
CREATE TABLE public.rodo228_access_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 accessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor_id uuid NOT NULL,
 api_key_id uuid,
 channel text NOT NULL CHECK(channel IN ('session','api')),
 action text NOT NULL CHECK(action IN ('read','list','export','anonymisation_preview','anonymisation')),
 purpose text NOT NULL CHECK(char_length(purpose) BETWEEN 1 AND 200),
 resource text NOT NULL CHECK(char_length(resource) BETWEEN 1 AND 120),
 crm_client_id uuid,
 subject_hash text CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 order_count integer NOT NULL DEFAULT 0 CHECK(order_count>=0),
 detail jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(detail)='object' AND octet_length(detail::text)<=4096),
 CHECK(crm_client_id IS NOT NULL OR subject_hash IS NOT NULL),
 CHECK((channel='api')=(api_key_id IS NOT NULL))
);
CREATE INDEX rodo228_access_log_page ON public.rodo228_access_log(tenant_id,accessed_at DESC,id);
CREATE INDEX rodo228_access_log_client ON public.rodo228_access_log(tenant_id,crm_client_id,accessed_at DESC) WHERE crm_client_id IS NOT NULL;
CREATE INDEX rodo228_access_log_subject ON public.rodo228_access_log(tenant_id,subject_hash,accessed_at DESC) WHERE subject_hash IS NOT NULL;

-- Anonymisation request: the preview plan (tables, rows, fields, legal basis and
-- retention end; no personal values) and, once confirmed, its result.
CREATE TABLE public.rodo228_requests (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 crm_client_ids uuid[] NOT NULL,
 order_ids uuid[] NOT NULL,
 state text NOT NULL CHECK(state IN ('previewed','completed')),
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object' AND octet_length(plan::text)<=1048576),
 plan_sha256 text NOT NULL CHECK(plan_sha256 ~ '^[a-f0-9]{64}$'),
 result jsonb CHECK(result IS NULL OR jsonb_typeof(result)='object' AND octet_length(result::text)<=1048576),
 requested_by uuid NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_by uuid,
 completed_at timestamptz,
 UNIQUE(tenant_id,id),
 CHECK(cardinality(crm_client_ids)+cardinality(order_ids)>0),
 CHECK((state='completed')=(completed_by IS NOT NULL AND completed_at IS NOT NULL AND result IS NOT NULL))
);
CREATE INDEX rodo228_requests_page ON public.rodo228_requests(tenant_id,requested_at DESC,id);

-- Fields kept by a completed anonymisation: legal basis, retention end and the due date
-- (day after the retention end) from which they are to be anonymised as well.
CREATE TABLE public.rodo228_retained (
 tenant_id uuid NOT NULL,
 request_id uuid NOT NULL,
 item_no integer NOT NULL CHECK(item_no>0),
 source_table text NOT NULL CHECK(source_table ~ '^[a-z][a-z0-9_]{0,62}$'),
 row_ref text NOT NULL CHECK(char_length(row_ref) BETWEEN 1 AND 200),
 order_id uuid,
 fields text[] NOT NULL CHECK(cardinality(fields) BETWEEN 1 AND 40),
 basis text NOT NULL CHECK(basis IN ('tax_retention','immutable_evidence')),
 legal_basis text NOT NULL CHECK(char_length(legal_basis) BETWEEN 1 AND 400),
 retention_end date NOT NULL,
 due_on date NOT NULL,
 completed_at timestamptz,
 completed_by uuid,
 completion_note text CHECK(completion_note IS NULL OR char_length(completion_note) BETWEEN 1 AND 400),
 PRIMARY KEY(tenant_id,request_id,item_no),
 FOREIGN KEY(tenant_id,request_id) REFERENCES public.rodo228_requests(tenant_id,id),
 CHECK(due_on=retention_end+1),
 CHECK((completed_at IS NULL)=(completed_by IS NULL) AND (completed_at IS NULL)=(completion_note IS NULL))
);
CREATE INDEX rodo228_retained_due ON public.rodo228_retained(tenant_id,due_on) WHERE completed_at IS NULL;

DO $table228$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['rodo228_settings','rodo228_access_log','rodo228_requests','rodo228_retained'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',t);
 END LOOP;
 GRANT SELECT,INSERT,UPDATE ON public.rodo228_settings TO dyna_app;
 GRANT SELECT,INSERT ON public.rodo228_access_log TO dyna_app;
 GRANT SELECT,INSERT ON public.rodo228_requests,public.rodo228_retained TO dyna_app;
 GRANT UPDATE(state,result,completed_by,completed_at) ON public.rodo228_requests TO dyna_app;
 GRANT UPDATE(completed_at,completed_by,completion_note) ON public.rodo228_retained TO dyna_app;
END
$table228$;

-- The access register is append-only. A row leaves it only through rodo228_purge_access_log()
-- and only once it is older than the tenant's retention; no update and no truncate, also for the owner.
CREATE FUNCTION public.rodo228_access_log_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard228$
DECLARE days integer;
BEGIN
 IF TG_OP='DELETE' THEN
  SELECT access_log_retention_days INTO days FROM public.rodo228_settings WHERE tenant_id=OLD.tenant_id;
  IF coalesce(current_setting('rodo228.purge',true),'')=OLD.tenant_id::text
  AND OLD.accessed_at<clock_timestamp()-make_interval(days=>coalesce(days,1825)) THEN RETURN OLD;END IF;
 END IF;
 RAISE EXCEPTION 'Rejestr dostępu do danych osobowych jest nienaruszalny' USING ERRCODE='55000';
END
$guard228$;
-- A request keeps its plan; it may only move once from previewed to completed.
CREATE FUNCTION public.rodo228_request_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard228$
BEGIN
 IF TG_OP='UPDATE' AND OLD.state='previewed' AND NEW.state='completed'
 AND (NEW.id,NEW.tenant_id,NEW.subject_hash,NEW.crm_client_ids,NEW.order_ids,NEW.plan,NEW.plan_sha256,NEW.requested_by,NEW.requested_at)
  IS NOT DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.subject_hash,OLD.crm_client_ids,OLD.order_ids,OLD.plan,OLD.plan_sha256,OLD.requested_by,OLD.requested_at)
 THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'Wniosek RODO jest nienaruszalny' USING ERRCODE='55000';
END
$guard228$;
-- A kept field keeps its basis and dates; it may only be marked done once.
CREATE FUNCTION public.rodo228_retained_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard228$
BEGIN
 IF TG_OP='UPDATE' AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
 AND (to_jsonb(NEW)-'completed_at'-'completed_by'-'completion_note')=(to_jsonb(OLD)-'completed_at'-'completed_by'-'completion_note')
 THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'Zapis zachowanych danych RODO jest nienaruszalny' USING ERRCODE='55000';
END
$guard228$;
CREATE FUNCTION public.rodo228_purge_access_log() RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $purge228$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;days integer;n integer;
BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'Tenant scope required' USING ERRCODE='42501';END IF;
 SELECT access_log_retention_days INTO days FROM public.rodo228_settings WHERE tenant_id=t;
 PERFORM set_config('rodo228.purge',t::text,true);
 DELETE FROM public.rodo228_access_log WHERE tenant_id=t AND accessed_at<clock_timestamp()-make_interval(days=>coalesce(days,1825));
 GET DIAGNOSTICS n=ROW_COUNT;
 PERFORM set_config('rodo228.purge','',true);
 RETURN n;
END
$purge228$;
REVOKE ALL ON FUNCTION public.rodo228_access_log_guard(),public.rodo228_request_guard(),public.rodo228_retained_guard() FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION public.rodo228_purge_access_log() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rodo228_purge_access_log() TO dyna_app;
CREATE TRIGGER rodo228_access_log_append_only BEFORE UPDATE OR DELETE ON public.rodo228_access_log FOR EACH ROW EXECUTE FUNCTION public.rodo228_access_log_guard();
CREATE TRIGGER rodo228_access_log_no_truncate BEFORE TRUNCATE ON public.rodo228_access_log FOR EACH STATEMENT EXECUTE FUNCTION public.rodo228_access_log_guard();
CREATE TRIGGER rodo228_requests_guard BEFORE UPDATE OR DELETE ON public.rodo228_requests FOR EACH ROW EXECUTE FUNCTION public.rodo228_request_guard();
CREATE TRIGGER rodo228_requests_no_truncate BEFORE TRUNCATE ON public.rodo228_requests FOR EACH STATEMENT EXECUTE FUNCTION public.rodo228_request_guard();
CREATE TRIGGER rodo228_retained_guard BEFORE UPDATE OR DELETE ON public.rodo228_retained FOR EACH ROW EXECUTE FUNCTION public.rodo228_retained_guard();
CREATE TRIGGER rodo228_retained_no_truncate BEFORE TRUNCATE ON public.rodo228_retained FOR EACH STATEMENT EXECUTE FUNCTION public.rodo228_retained_guard();
