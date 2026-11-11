-- Successor to218, registered in db.ts migrate() after218 (23.10.2026).
-- Group identity is a separate namespace from218 status/client/field identities.
-- A normal migration transaction must own the schema lock and validate its full
-- predecessor/successor catalogue; this file does not create migration markers.
DO $dependency219$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.base_wire218_client_ids') IS NULL
 OR to_regclass('public.base_wire218_status_ids') IS NULL
 OR to_regclass('public.base_wire218_field_ids') IS NULL
 OR to_regprocedure('public.base_wire218_authority(uuid,uuid,boolean)') IS NULL
 THEN RAISE EXCEPTION 'CRM group identities require owner-installed218' USING ERRCODE='55000';END IF;
END
$dependency219$;

CREATE TABLE public.base_wire219_group_ids (
 tenant_id uuid NOT NULL,
 resource_id uuid NOT NULL,
 local_id uuid,
 public_id bigint GENERATED ALWAYS AS IDENTITY (MAXVALUE 9007199254740991),
 PRIMARY KEY(tenant_id,resource_id),
 UNIQUE(public_id),
 UNIQUE(tenant_id,public_id),
 CHECK(public_id BETWEEN 1 AND 9007199254740991),
 CHECK(local_id IS NULL OR local_id=resource_id),
 FOREIGN KEY(tenant_id,local_id) REFERENCES public.crm_status_groups(tenant_id,id)
  ON DELETE SET NULL(local_id)
);
-- Bound live-map lookup and the parent's FK action without scanning tombstones.
CREATE INDEX base_wire219_group_live_fk ON public.base_wire219_group_ids(tenant_id,local_id)
 WHERE local_id IS NOT NULL;

-- Backfill every current group, including the protected main group. Never use
-- ON CONFLICT to overwrite/revive an older tombstone or silently hide collision.
INSERT INTO public.base_wire219_group_ids(tenant_id,resource_id,local_id)
 SELECT tenant_id,id,id FROM public.crm_status_groups ORDER BY tenant_id,id;

ALTER TABLE public.base_wire219_group_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.base_wire219_group_ids FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.base_wire219_group_ids TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.base_wire219_group_ids FROM PUBLIC,dyna_app;
GRANT SELECT ON public.base_wire219_group_ids TO dyna_app;
REVOKE ALL ON SEQUENCE public.base_wire219_group_ids_public_id_seq FROM PUBLIC,dyna_app;

-- Preserve the original public identity and resource UUID permanently. The only
-- permitted row update is the typed FK's live->tombstone transition after the
-- exact parent has disappeared; resurrection/rekey/delete/truncate all refuse.
CREATE FUNCTION public.base_wire219_group_identity_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $identity219$
BEGIN
 IF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='base_wire219_group_ids' AND TG_OP='UPDATE' AND TG_LEVEL='ROW' THEN
  IF (NEW.tenant_id,NEW.resource_id,NEW.public_id) IS NOT DISTINCT FROM (OLD.tenant_id,OLD.resource_id,OLD.public_id)
  AND OLD.local_id IS NOT NULL AND NEW.local_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM public.crm_status_groups g WHERE (g.tenant_id,g.id)=(OLD.tenant_id,OLD.local_id))
  THEN RETURN NEW;END IF;
 END IF;
 RAISE EXCEPTION 'CRM group numeric identity is immutable' USING ERRCODE='55000';
END
$identity219$;
REVOKE ALL ON FUNCTION public.base_wire219_group_identity_guard() FROM PUBLIC,dyna_app;
CREATE TRIGGER base_wire219_group_identity_immutable BEFORE UPDATE OR DELETE ON public.base_wire219_group_ids
 FOR EACH ROW EXECUTE FUNCTION public.base_wire219_group_identity_guard();
CREATE TRIGGER base_wire219_group_identity_no_truncate BEFORE TRUNCATE ON public.base_wire219_group_ids
 FOR EACH STATEMENT EXECUTE FUNCTION public.base_wire219_group_identity_guard();

CREATE FUNCTION public.base_wire219_allocate_group() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $allocate219$
BEGIN
 IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME<>'crm_status_groups'
 OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'Invalid CRM group identity source' USING ERRCODE='55000';END IF;
 INSERT INTO public.base_wire219_group_ids(tenant_id,resource_id,local_id)
  VALUES(NEW.tenant_id,NEW.id,NEW.id);
 RETURN NEW;
END
$allocate219$;
REVOKE ALL ON FUNCTION public.base_wire219_allocate_group() FROM PUBLIC,dyna_app;
CREATE TRIGGER base_wire219_group AFTER INSERT ON public.crm_status_groups
 FOR EACH ROW EXECUTE FUNCTION public.base_wire219_allocate_group();
