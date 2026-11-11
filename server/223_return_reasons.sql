-- Successor to222, registered in db.ts migrate() after222 (23.10.2026).
-- Tenant dictionary of return reasons with a stable numeric identity (Base
-- return_reason_id) and the reason chosen for a native return case. The case's
-- free-text reason (return_cases.reason) stays the native text; a case without a
-- dictionary choice is "other". Only these own tables are added: no trigger,
-- column or constraint is attached to return_cases or any other core table
-- except the internal referential triggers of the foreign key below.
DO $dependency223$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.order_split222_executions') IS NULL
 OR to_regclass('public.return_cases') IS NULL
 THEN RAISE EXCEPTION 'Return reasons require owner-installed222' USING ERRCODE='55000';END IF;
END
$dependency223$;

-- Renames and deactivation keep the row, its UUID and its public ID; rows are
-- never deleted, so an ID once given to a Base client never changes meaning.
CREATE TABLE public.return_reasons223 (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 public_id bigint GENERATED ALWAYS AS IDENTITY (MAXVALUE 2147483647),
 name text NOT NULL CHECK(char_length(name) BETWEEN 3 AND 120 AND name=btrim(name)),
 active boolean NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 0 AND 999),
 version integer NOT NULL CHECK(version>0),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(id),
 UNIQUE(public_id),
 UNIQUE(tenant_id,public_id),
 CHECK(public_id BETWEEN 1 AND 2147483647)
);
CREATE UNIQUE INDEX return_reasons223_name ON public.return_reasons223(tenant_id,lower(name));

-- The dictionary reason chosen when the case was created, with its name at that
-- moment. One per case at most; immutable.
CREATE TABLE public.return_case_reasons223 (
 tenant_id uuid NOT NULL,
 return_id uuid NOT NULL,
 reason_id uuid NOT NULL,
 reason_name text NOT NULL CHECK(char_length(reason_name) BETWEEN 3 AND 120),
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,return_id),
 FOREIGN KEY(tenant_id,return_id) REFERENCES public.return_cases(tenant_id,id),
 FOREIGN KEY(tenant_id,reason_id) REFERENCES public.return_reasons223(tenant_id,id)
);
CREATE INDEX return_case_reasons223_reason ON public.return_case_reasons223(tenant_id,reason_id);

DO $tables223$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['return_reasons223','return_case_reasons223'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON public.%I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',t);
  EXECUTE format('GRANT SELECT,INSERT ON public.%I TO dyna_app',t);
 END LOOP;
 GRANT UPDATE(name,active,position,version,updated_at) ON public.return_reasons223 TO dyna_app;
 REVOKE ALL ON SEQUENCE public.return_reasons223_public_id_seq FROM PUBLIC,dyna_app;
END
$tables223$;

-- Identity columns never change; a reason is never deleted (deactivate instead);
-- the chosen reason of a case is immutable.
CREATE FUNCTION public.return_reasons223_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard223$
BEGIN
 -- Nested: the row fields exist only for a row UPDATE of the dictionary itself.
 IF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='return_reasons223' AND TG_OP='UPDATE' AND TG_LEVEL='ROW' THEN
  IF (NEW.tenant_id,NEW.id,NEW.public_id,NEW.created_by,NEW.created_at) IS NOT DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.public_id,OLD.created_by,OLD.created_at)
  AND NEW.version=OLD.version+1 THEN
   RETURN NEW;
  END IF;
 END IF;
 RAISE EXCEPTION 'Return reason identity is immutable' USING ERRCODE='55000';
END
$guard223$;
REVOKE ALL ON FUNCTION public.return_reasons223_guard() FROM PUBLIC,dyna_app;

DO $triggers223$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['return_reasons223','return_case_reasons223'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.return_reasons223_guard()',t||'_immutable',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.return_reasons223_guard()',t||'_no_truncate',t);
 END LOOP;
END
$triggers223$;
