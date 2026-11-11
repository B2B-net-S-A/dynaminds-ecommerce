-- Successor to220, registered in db.ts migrate() after220 (23.10.2026).
-- Lossless numeric Base journal IDs (getJournalList log_id) as a sidecar of
-- native order_events and invoice/correction documents. order_events has UUID
-- keys and created_at=now() (transaction start), so neither is commit ordered.
-- No trigger is attached to order_events or documents (earlier validators pin
-- their user triggers); only the sidecar FKs' internal referential triggers.
-- base_wire221_allocate_journal() assigns log_id under a per-tenant advisory
-- lock in (created_at,source,id) order and the IDs commit before the lock is
-- released, so a reader never sees a lower log_id appear after a higher one.
DO $dependency221$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.base_wire220_order_ids') IS NULL
 OR to_regclass('public.base_wire220_invoice_ids') IS NULL
 OR to_regprocedure('public.base_wire220_allocate_pending(text)') IS NULL
 THEN RAISE EXCEPTION 'Base wire journal requires owner-installed220' USING ERRCODE='55000';END IF;
END
$dependency221$;

-- One row per journaled native row; event_id/document_id are the typed live
-- references (tombstone NULL after the exact parent has disappeared).
CREATE TABLE public.base_wire221_journal_ids (
 tenant_id uuid NOT NULL,
 source text NOT NULL CHECK(source IN('order_event','document')),
 resource_id uuid NOT NULL,
 event_id uuid,
 document_id uuid,
 log_id bigint GENERATED ALWAYS AS IDENTITY (MAXVALUE 9007199254740991),
 PRIMARY KEY(tenant_id,source,resource_id),
 UNIQUE(log_id),
 UNIQUE(tenant_id,log_id),
 CHECK(log_id BETWEEN 1 AND 9007199254740991),
 CHECK(CASE source WHEN 'order_event' THEN document_id IS NULL AND (event_id IS NULL OR event_id=resource_id)
  ELSE event_id IS NULL AND (document_id IS NULL OR document_id=resource_id) END),
 FOREIGN KEY(tenant_id,event_id) REFERENCES public.order_events(tenant_id,id) ON DELETE SET NULL(event_id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.documents(tenant_id,id) ON DELETE SET NULL(document_id)
);
CREATE INDEX base_wire221_journal_ids_event_fk ON public.base_wire221_journal_ids(tenant_id,event_id) WHERE event_id IS NOT NULL;
CREATE INDEX base_wire221_journal_ids_document_fk ON public.base_wire221_journal_ids(tenant_id,document_id) WHERE document_id IS NOT NULL;
ALTER TABLE public.base_wire221_journal_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.base_wire221_journal_ids FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.base_wire221_journal_ids TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.base_wire221_journal_ids FROM PUBLIC,dyna_app;
GRANT SELECT ON public.base_wire221_journal_ids TO dyna_app;
REVOKE ALL ON SEQUENCE public.base_wire221_journal_ids_log_id_seq FROM PUBLIC,dyna_app;

-- Preserve log_id and the journaled resource permanently. The only permitted
-- row update is the typed FK's live->tombstone transition after the exact parent
-- has disappeared; resurrection/rekey/delete/truncate all refuse.
CREATE FUNCTION public.base_wire221_journal_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $guard221$
DECLARE present boolean;
BEGIN
 IF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='base_wire221_journal_ids' AND TG_OP='UPDATE' AND TG_LEVEL='ROW'
 AND (NEW.tenant_id,NEW.source,NEW.resource_id,NEW.log_id) IS NOT DISTINCT FROM (OLD.tenant_id,OLD.source,OLD.resource_id,OLD.log_id) THEN
  IF OLD.event_id IS NOT NULL AND NEW.event_id IS NULL AND NEW.document_id IS NOT DISTINCT FROM OLD.document_id THEN
   SELECT EXISTS(SELECT 1 FROM public.order_events WHERE (tenant_id,id)=(OLD.tenant_id,OLD.event_id)) INTO present;
   IF NOT present THEN RETURN NEW;END IF;
  ELSIF OLD.document_id IS NOT NULL AND NEW.document_id IS NULL AND NEW.event_id IS NOT DISTINCT FROM OLD.event_id THEN
   SELECT EXISTS(SELECT 1 FROM public.documents WHERE (tenant_id,id)=(OLD.tenant_id,OLD.document_id)) INTO present;
   IF NOT present THEN RETURN NEW;END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'Base wire journal identity is immutable' USING ERRCODE='55000';
END
$guard221$;
REVOKE ALL ON FUNCTION public.base_wire221_journal_guard() FROM PUBLIC,dyna_app;
CREATE TRIGGER base_wire221_journal_ids_immutable BEFORE UPDATE OR DELETE ON public.base_wire221_journal_ids FOR EACH ROW EXECUTE FUNCTION public.base_wire221_journal_guard();
CREATE TRIGGER base_wire221_journal_ids_no_truncate BEFORE TRUNCATE ON public.base_wire221_journal_ids FOR EACH STATEMENT EXECUTE FUNCTION public.base_wire221_journal_guard();

-- Current tenant only; requires a writable READ COMMITTED transaction. The 220
-- order/invoice identities are allocated first (220 locks, then the 221 lock),
-- and only rows whose order (and invoice) already has its 220 identity are
-- journaled; the rest follow on a later call with a higher log_id. Base exposes
-- the last 3 days only, so older native rows are never journaled.
CREATE FUNCTION public.base_wire221_allocate_journal() RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $journal221$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'Invalid Base wire journal allocation' USING ERRCODE='55000';END IF;
 PERFORM public.base_wire220_allocate_pending('order');
 PERFORM public.base_wire220_allocate_pending('invoice');
 PERFORM pg_advisory_xact_lock(hashtextextended('base_wire221:journal:'||t::text,0));
 INSERT INTO public.base_wire221_journal_ids(tenant_id,source,resource_id,event_id,document_id)
  SELECT t,j.source,j.id,j.event_id,j.document_id FROM (
   SELECT 'order_event'::text source,e.id,e.id event_id,NULL::uuid document_id,e.created_at FROM public.order_events e
    JOIN public.base_wire220_order_ids o ON(o.tenant_id,o.local_id)=(t,e.order_id)
    WHERE e.tenant_id=t AND e.created_at>=now()-interval '3 days'
   UNION ALL
   SELECT 'document',d.id,NULL,d.id,d.created_at FROM public.documents d
    JOIN public.base_wire220_invoice_ids i ON(i.tenant_id,i.local_id)=(t,d.id)
    JOIN public.base_wire220_order_ids o ON(o.tenant_id,o.local_id)=(t,d.order_id)
    WHERE d.tenant_id=t AND d.created_at>=now()-interval '3 days'
  ) j WHERE NOT EXISTS(SELECT 1 FROM public.base_wire221_journal_ids s WHERE (s.tenant_id,s.source,s.resource_id)=(t,j.source,j.id))
  ORDER BY j.created_at,j.source,j.id;
END
$journal221$;
REVOKE ALL ON FUNCTION public.base_wire221_allocate_journal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.base_wire221_allocate_journal() TO dyna_app;
