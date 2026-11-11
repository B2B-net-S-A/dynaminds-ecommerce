-- Migration 253_mirakl_webhook_retention (prepared as 263, registered after 252_mirakl_operations; object names keep the
-- mirakl263_ prefix; docs/parity/MIRAKL252-20261028.md):
-- retention of the Mirakl webhook event log mirakl262_webhook_events of 252 (docs/parity/MIRAKL252-20261028.md,
-- „Retencja”). The pattern of the other event logs (rodo228_access_log, ksef243_purchase_events): the log is
-- append-only, also for the owner, and a row leaves only through the SECURITY DEFINER purge of the caller's tenant,
-- once it is older than the retention. 90 days, as the login events of 237: the row keeps no personal data (event
-- id, type, body hash, outcome) and serves only deduplication and the per-minute/per-day limits, which look back one
-- day. At most 1000 rows per call, so no call does unbounded work; the worker step mirakl.operations calls it for
-- every tenant with expired events (server/mirakl262.ts sweepMirakl262Due).
--
-- No table is created or altered and no grant changes: dyna_app keeps SELECT, INSERT on the log and gets EXECUTE on
-- the purge only. The objects are new names (mirakl263_); the triggers and the index sit on the 252 table.

CREATE INDEX mirakl263_webhook_events_received ON public.mirakl262_webhook_events(received_at);

-- No update and no truncate; a delete only inside mirakl263_purge_webhook_events() of the row's tenant, after 90 days.
CREATE FUNCTION public.mirakl263_webhook_events_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard263$
BEGIN
 IF TG_OP='DELETE' AND coalesce(current_setting('mirakl263.purge',true),'')=OLD.tenant_id::text
 AND OLD.received_at<clock_timestamp()-interval '90 days' THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'Dziennik powiadomień Mirakl jest nienaruszalny' USING ERRCODE='55000';
END
$guard263$;

CREATE FUNCTION public.mirakl263_purge_webhook_events() RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $purge263$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;n integer;
BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'Tenant scope required' USING ERRCODE='42501';END IF;
 PERFORM set_config('mirakl263.purge',t::text,true);
 DELETE FROM public.mirakl262_webhook_events WHERE id IN(SELECT e.id FROM public.mirakl262_webhook_events e
  WHERE e.tenant_id=t AND e.received_at<clock_timestamp()-interval '90 days' ORDER BY e.received_at LIMIT 1000);
 GET DIAGNOSTICS n=ROW_COUNT;
 PERFORM set_config('mirakl263.purge','',true);
 RETURN n;
END
$purge263$;

REVOKE ALL ON FUNCTION public.mirakl263_webhook_events_guard() FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION public.mirakl263_purge_webhook_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mirakl263_purge_webhook_events() TO dyna_app;
CREATE TRIGGER mirakl263_webhook_events_append_only BEFORE UPDATE OR DELETE ON public.mirakl262_webhook_events FOR EACH ROW EXECUTE FUNCTION public.mirakl263_webhook_events_guard();
CREATE TRIGGER mirakl263_webhook_events_no_truncate BEFORE TRUNCATE ON public.mirakl262_webhook_events FOR EACH STATEMENT EXECUTE FUNCTION public.mirakl263_webhook_events_guard();
