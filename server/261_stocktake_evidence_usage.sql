-- Migration 261_stocktake_evidence_usage (prepared as 277, registered after 260_automation_runs_queued_job; docs/parity/STOCKTAKE-USAGE-P277-20261029.md).
-- Two usage counters kept in the writing transaction by statement triggers with transition tables, like the
-- 235 counters on the non-fingerprinted WMS tables, so that two lifetime budgets stop growing with history:
--  1. stocktake_adjustment_budget() (149) counted series/previews/receipts/series commands and summed
--     pg_column_size over the nine 149 tables of the tenant on every adjustment transaction, reads included,
--     with one cap set for every plan. Its body now reads one counter row and the tenant's plan
--     (starter/business keep 5000/5000/100/5000 and 128 MiB; enterprise 500 000 previews and receipts and
--     16 GiB). Signature, owner, SECURITY INVOKER and search_path stay. The counter measures the stored row
--     exactly as the old sum did (pg_column_size of the row read back from the table, not of the transition
--     tuple, which is not yet compressed). stocktake_adjustment_manifest() is regenerated exactly as the
--     last DO block of 149 does, so stocktake_adjustment_guards() seals the new body, functions and triggers.
--  2. The shared scan budget (server/stocktake-limits.ts) summed octet_length(to_jsonb(row)::text) over
--     stocktake_scan_receipts and stocktake_measurements of the tenant on every scan and counted the receipts
--     up to the plan cap. stocktake_scan_usage keeps both per tenant in 32 slots (SKIP LOCKED, as 235);
--     the TS check reads it when it exists and keeps the exact scan as the fallback.
-- Rows written with triggers disabled (session_replication_role=replica) are not counted, as for 235.
-- No table of 149, 029 or 094 gains or loses a column, constraint, index, policy or grant.
-- Relations inside the new SECURITY DEFINER functions are schema-qualified: their search_path does not name pg_temp,
-- so pg_temp would otherwise be searched first and a session's temp table could stand in for a counter.

-- The manifest is regenerated below from the live catalogue, so it is sealed only over an intact 149 module.
DO $$ BEGIN IF NOT public.stocktake_adjustment_guards() THEN
 RAISE EXCEPTION '277 requires intact stocktake adjustments (stocktake_adjustment_guards() is false)' USING ERRCODE='55000';END IF;END $$;

-- 1. Stocktake adjustments (149): one row per tenant; every 149 writer holds stocktake_adjustment_lock().
CREATE TABLE stocktake_adjustment_usage (
 tenant_id uuid PRIMARY KEY REFERENCES tenants,
 series bigint NOT NULL DEFAULT 0 CHECK(series>=0),series_commands bigint NOT NULL DEFAULT 0 CHECK(series_commands>=0),
 previews bigint NOT NULL DEFAULT 0 CHECK(previews>=0),receipts bigint NOT NULL DEFAULT 0 CHECK(receipts>=0),
 bytes bigint NOT NULL DEFAULT 0
);
ALTER TABLE public.stocktake_adjustment_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stocktake_adjustment_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY stocktake_adjustment_tenant ON public.stocktake_adjustment_usage USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.stocktake_adjustment_usage FROM PUBLIC,dyna_app;
-- INSERT: counts and the stored size of the new rows. The size is read back by key from the table after the
-- statement, in a scalar subquery over the table itself (one row per key): the transition tuple is not yet
-- compressed, and a small whole row (<127 B) read in another plan shape can come out 3 bytes shorter, so the old
-- 149 sum over a scan may be lower than the counter by at most 3 bytes per row.
CREATE FUNCTION stocktake_adjustment_usage_track() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;k text[]:=CASE TG_TABLE_NAME WHEN 'stocktake_adjustment_counters' THEN '{tenant_id,series_id,year}'::text[]
 WHEN 'stocktake_adjustment_preview_rows' THEN '{tenant_id,preview_id,ordinal}' WHEN 'stocktake_adjustment_document_rows' THEN '{tenant_id,document_id,ordinal}' ELSE '{tenant_id,id}' END;BEGIN
 FOR r IN EXECUTE format('SELECT tenant_id,count(*) n,sum((SELECT pg_column_size(s) FROM public.%I s WHERE (s.%s)=(n.%s))) b FROM stocktake_adjustment_new n GROUP BY tenant_id ORDER BY tenant_id',
  TG_TABLE_NAME,array_to_string(k,',s.'),array_to_string(k,',n.'))
 LOOP
  INSERT INTO public.stocktake_adjustment_usage AS u(tenant_id,series,series_commands,previews,receipts,bytes)
  VALUES(r.tenant_id,CASE WHEN TG_TABLE_NAME='stocktake_adjustment_series' THEN r.n ELSE 0 END,CASE WHEN TG_TABLE_NAME='stocktake_adjustment_series_commands' THEN r.n ELSE 0 END,
   CASE WHEN TG_TABLE_NAME='stocktake_adjustment_previews' THEN r.n ELSE 0 END,CASE WHEN TG_TABLE_NAME='stocktake_adjustment_receipts' THEN r.n ELSE 0 END,r.b)
  ON CONFLICT(tenant_id) DO UPDATE SET series=u.series+excluded.series,series_commands=u.series_commands+excluded.series_commands,
   previews=u.previews+excluded.previews,receipts=u.receipts+excluded.receipts,bytes=u.bytes+excluded.bytes;
 END LOOP;RETURN NULL;
END $$;
-- UPDATE (only admissions and counters are updatable): stored size after (read back as above) minus the old
-- version (the OLD transition tuple is the stored one).
CREATE FUNCTION stocktake_adjustment_usage_track_update() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;k text[]:=CASE TG_TABLE_NAME WHEN 'stocktake_adjustment_counters' THEN '{tenant_id,series_id,year}'::text[] ELSE '{tenant_id,id}' END;BEGIN
 FOR r IN EXECUTE format('SELECT tenant_id,sum(b) b FROM (SELECT tenant_id,(SELECT pg_column_size(s) FROM public.%I s WHERE (s.%s)=(n.%s)) b FROM stocktake_adjustment_new n
  UNION ALL SELECT tenant_id,-pg_column_size(o) FROM stocktake_adjustment_old o) d GROUP BY tenant_id HAVING sum(b)<>0 ORDER BY tenant_id',
  TG_TABLE_NAME,array_to_string(k,',s.'),array_to_string(k,',n.'))
 LOOP
  INSERT INTO public.stocktake_adjustment_usage AS u(tenant_id,bytes) VALUES(r.tenant_id,r.b)
  ON CONFLICT(tenant_id) DO UPDATE SET bytes=u.bytes+r.b;
 END LOOP;RETURN NULL;
END $$;
DO $$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['series','series_commands','counters','previews','preview_rows','admissions','receipts','documents','document_rows'] LOOP
 EXECUTE format('CREATE TRIGGER stocktake_adjustment_usage_insert AFTER INSERT ON public.%I REFERENCING NEW TABLE AS stocktake_adjustment_new FOR EACH STATEMENT EXECUTE FUNCTION public.stocktake_adjustment_usage_track()','stocktake_adjustment_'||n);
 END LOOP;
 -- Every other 149 table rejects UPDATE and DELETE (stocktake_adjustment_immutable); counters and admissions reject DELETE.
 FOREACH n IN ARRAY ARRAY['counters','admissions'] LOOP
 EXECUTE format('CREATE TRIGGER stocktake_adjustment_usage_update AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS stocktake_adjustment_old NEW TABLE AS stocktake_adjustment_new FOR EACH STATEMENT EXECUTE FUNCTION public.stocktake_adjustment_usage_track_update()','stocktake_adjustment_'||n);
 END LOOP;
END $$;
-- Backfill with the nine tables locked against writers, so no row lands between the sum and the counter.
LOCK TABLE public.stocktake_adjustment_series,public.stocktake_adjustment_series_commands,public.stocktake_adjustment_counters,
 public.stocktake_adjustment_previews,public.stocktake_adjustment_preview_rows,public.stocktake_adjustment_admissions,
 public.stocktake_adjustment_receipts,public.stocktake_adjustment_documents,public.stocktake_adjustment_document_rows IN SHARE MODE;
INSERT INTO public.stocktake_adjustment_usage(tenant_id,series,series_commands,previews,receipts,bytes)
SELECT tenant_id,sum(s),sum(c),sum(p),sum(r),sum(b) FROM (
 SELECT tenant_id,1 s,0 c,0 p,0 r,pg_column_size(x) b FROM public.stocktake_adjustment_series x
 UNION ALL SELECT tenant_id,0,1,0,0,pg_column_size(x) FROM public.stocktake_adjustment_series_commands x
 UNION ALL SELECT tenant_id,0,0,0,0,pg_column_size(x) FROM public.stocktake_adjustment_counters x
 UNION ALL SELECT tenant_id,0,0,1,0,pg_column_size(x) FROM public.stocktake_adjustment_previews x
 UNION ALL SELECT tenant_id,0,0,0,0,pg_column_size(x) FROM public.stocktake_adjustment_preview_rows x
 UNION ALL SELECT tenant_id,0,0,0,0,pg_column_size(x) FROM public.stocktake_adjustment_admissions x
 UNION ALL SELECT tenant_id,0,0,0,1,pg_column_size(x) FROM public.stocktake_adjustment_receipts x
 UNION ALL SELECT tenant_id,0,0,0,0,pg_column_size(x) FROM public.stocktake_adjustment_documents x
 UNION ALL SELECT tenant_id,0,0,0,0,pg_column_size(x) FROM public.stocktake_adjustment_document_rows x
) e GROUP BY tenant_id;
-- Same limits, messages and SQLSTATE as 149 for starter/business; enterprise sized as STOCKTAKE_ADJUSTMENT_PLAN_LIMITS
-- (server/stocktake-limits.ts). Unknown or missing plan gets the small limits.
CREATE OR REPLACE FUNCTION stocktake_adjustment_budget() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=current_setting('app.tenant_id')::uuid;u public.stocktake_adjustment_usage;records bigint:=5000;bytes bigint:=134217728;BEGIN
 IF EXISTS(SELECT 1 FROM public.tenants WHERE id=t AND plan='enterprise') THEN records:=500000;bytes:=17179869184;END IF;
 SELECT * INTO u FROM public.stocktake_adjustment_usage WHERE tenant_id=t;
 IF coalesce(u.series,0)>100 OR coalesce(u.previews,0)>records OR coalesce(u.receipts,0)>records OR coalesce(u.series_commands,0)>5000
 THEN RAISE EXCEPTION 'Limit dowodów spisu' USING ERRCODE='54000';END IF;
 IF coalesce(u.bytes,0)>bytes THEN RAISE EXCEPTION 'Limit bajtów dowodów spisu' USING ERRCODE='54000';END IF;
END $$;
-- The sealed manifest, regenerated as the last DO blocks of 149 do (same statement, CREATE OR REPLACE keeps the
-- function's identity and its revoked ACL), then every stocktake_adjustment_% function stays private.
DO $$ DECLARE expected jsonb;BEGIN
 expected:=public.stocktake_adjustment_metadata();
 EXECUTE format('CREATE OR REPLACE FUNCTION public.stocktake_adjustment_manifest() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS %L', 'SELECT '||quote_literal(expected::text)||'::jsonb');
END $$;
DO $$ DECLARE p record;BEGIN FOR p IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'stocktake_adjustment_%' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',p.signature);END LOOP;END $$;

-- 2. Stocktake scans (094) and quantity measurements (029): 32 slots per tenant, as wms_evidence_usage (235).
CREATE TABLE stocktake_scan_usage (
 tenant_id uuid NOT NULL REFERENCES tenants,slot smallint NOT NULL CHECK(slot BETWEEN 0 AND 31),
 receipts bigint NOT NULL DEFAULT 0 CHECK(receipts>=0),bytes bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,slot)
);
ALTER TABLE stocktake_scan_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE stocktake_scan_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON stocktake_scan_usage TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON stocktake_scan_usage TO dyna_app;
-- A writer takes a free slot (SKIP LOCKED) instead of queueing behind one hot row.
CREATE FUNCTION stocktake_scan_usage_add(t uuid,n bigint,b bigint) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s smallint;BEGIN
 IF n=0 AND b=0 THEN RETURN;END IF;
 SELECT slot INTO s FROM public.stocktake_scan_usage WHERE tenant_id=t ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1;
 IF s IS NULL THEN
  INSERT INTO public.stocktake_scan_usage(tenant_id,slot) SELECT t,g FROM generate_series(0,31) g ON CONFLICT DO NOTHING;
  SELECT slot INTO s FROM public.stocktake_scan_usage WHERE tenant_id=t ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1;
 END IF;
 s:=coalesce(s,(pg_current_xact_id()::text::bigint%32)::smallint); -- all slots busy: wait, never skip
 UPDATE public.stocktake_scan_usage SET receipts=receipts+n,bytes=bytes+b WHERE tenant_id=t AND slot=s;
END $$;
-- The measure of the TS check: octet_length(to_jsonb(row)::text). INSERT, UPDATE and DELETE get separate
-- functions because a trigger without an OLD (or NEW) transition table cannot name it (see 235).
CREATE FUNCTION stocktake_scan_usage_track() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;BEGIN
 FOR r IN SELECT tenant_id,count(*) n,sum(octet_length(to_jsonb(x)::text)) b FROM stocktake_scan_new x GROUP BY tenant_id ORDER BY tenant_id
 LOOP
  PERFORM public.stocktake_scan_usage_add(r.tenant_id,CASE WHEN TG_TABLE_NAME='stocktake_scan_receipts' THEN r.n ELSE 0 END,r.b);
 END LOOP;RETURN NULL;
END $$;
-- Quantity measurements not referenced by a scan stay updatable and deletable by the owner (094).
CREATE FUNCTION stocktake_scan_usage_track_update() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;BEGIN
 FOR r IN
  SELECT tenant_id,sum(b) b FROM (
   SELECT tenant_id,octet_length(to_jsonb(x)::text) b FROM stocktake_scan_new x
   UNION ALL SELECT tenant_id,-octet_length(to_jsonb(x)::text) FROM stocktake_scan_old x
  ) d GROUP BY tenant_id ORDER BY tenant_id
 LOOP
  PERFORM public.stocktake_scan_usage_add(r.tenant_id,0,r.b);
 END LOOP;RETURN NULL;
END $$;
CREATE FUNCTION stocktake_scan_usage_track_delete() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;BEGIN
 FOR r IN SELECT tenant_id,-sum(octet_length(to_jsonb(x)::text)) b FROM stocktake_scan_old x GROUP BY tenant_id ORDER BY tenant_id
 LOOP
  PERFORM public.stocktake_scan_usage_add(r.tenant_id,0,r.b);
 END LOOP;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION stocktake_scan_usage_add(uuid,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION stocktake_scan_usage_track() FROM PUBLIC;
REVOKE ALL ON FUNCTION stocktake_scan_usage_track_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION stocktake_scan_usage_track_delete() FROM PUBLIC;
CREATE TRIGGER stocktake_scan_usage_insert AFTER INSERT ON stocktake_scan_receipts REFERENCING NEW TABLE AS stocktake_scan_new FOR EACH STATEMENT EXECUTE FUNCTION stocktake_scan_usage_track();
CREATE TRIGGER stocktake_scan_usage_insert AFTER INSERT ON stocktake_measurements REFERENCING NEW TABLE AS stocktake_scan_new FOR EACH STATEMENT EXECUTE FUNCTION stocktake_scan_usage_track();
CREATE TRIGGER stocktake_scan_usage_update AFTER UPDATE ON stocktake_measurements REFERENCING OLD TABLE AS stocktake_scan_old NEW TABLE AS stocktake_scan_new FOR EACH STATEMENT EXECUTE FUNCTION stocktake_scan_usage_track_update();
CREATE TRIGGER stocktake_scan_usage_delete AFTER DELETE ON stocktake_measurements REFERENCING OLD TABLE AS stocktake_scan_old FOR EACH STATEMENT EXECUTE FUNCTION stocktake_scan_usage_track_delete();
-- Backfill with both tables locked against writers.
LOCK TABLE stocktake_scan_receipts,stocktake_measurements IN SHARE MODE;
INSERT INTO stocktake_scan_usage(tenant_id,slot,receipts,bytes)
SELECT tenant_id,0,sum(n),sum(b) FROM (
 SELECT tenant_id,1 n,octet_length(to_jsonb(x)::text) b FROM stocktake_scan_receipts x
 UNION ALL SELECT tenant_id,0,octet_length(to_jsonb(x)::text) FROM stocktake_measurements x
) e GROUP BY tenant_id;
