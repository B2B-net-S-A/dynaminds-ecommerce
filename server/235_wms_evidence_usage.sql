-- Migration 235_wms_evidence_usage: per-tenant usage of undeletable WMS history in O(1)
-- (docs/parity/WMS-LIMITS-20261026.md). Read by server/wms-lots-limits.ts when the table exists.
-- No trigger or column touches wms_operations, wms_cost_layers, wms_layer_movements,
-- wms_issue_fragments or wms_return_fragments: their catalog is fingerprinted by
-- buyer_address_guards/ordinary187_valid/pim_dictionary_valid (one trigger there turns
-- 10 guards false). Rows of those five tables are settled per operation instead.
CREATE TABLE wms_evidence_usage (
 tenant_id uuid NOT NULL REFERENCES tenants,slot smallint NOT NULL CHECK(slot BETWEEN 0 AND 31),
 operations bigint NOT NULL DEFAULT 0 CHECK(operations>=0),layers bigint NOT NULL DEFAULT 0 CHECK(layers>=0),
 previews bigint NOT NULL DEFAULT 0 CHECK(previews>=0),bytes bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,slot)
);
-- One row per settled operation: its bytes (row + lots-free children) and layer count.
CREATE TABLE wms_evidence_settled (
 tenant_id uuid NOT NULL,operation_id uuid NOT NULL,layers bigint NOT NULL CHECK(layers>=0),
 bytes bigint NOT NULL CHECK(bytes>0),PRIMARY KEY(tenant_id,operation_id),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES wms_operations(tenant_id,id)
);
ALTER TABLE wms_evidence_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_evidence_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON wms_evidence_usage TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE wms_evidence_settled ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_evidence_settled FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON wms_evidence_settled TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON wms_evidence_usage,wms_evidence_settled TO dyna_app;
-- A writer takes a free slot (SKIP LOCKED) instead of queueing behind one hot row.
CREATE FUNCTION wms_evidence_usage_add(t uuid,ops bigint,lay bigint,pre bigint,b bigint) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s smallint;BEGIN
 IF ops=0 AND lay=0 AND pre=0 AND b=0 THEN RETURN;END IF;
 SELECT slot INTO s FROM wms_evidence_usage WHERE tenant_id=t ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1;
 IF s IS NULL THEN
  INSERT INTO wms_evidence_usage(tenant_id,slot) SELECT t,g FROM generate_series(0,31) g ON CONFLICT DO NOTHING;
  SELECT slot INTO s FROM wms_evidence_usage WHERE tenant_id=t ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1;
 END IF;
 s:=coalesce(s,(pg_current_xact_id()::text::bigint%32)::smallint); -- all slots busy: wait, never skip
 UPDATE wms_evidence_usage SET operations=operations+ops,layers=layers+lay,previews=previews+pre,bytes=bytes+b
 WHERE tenant_id=t AND slot=s;
END $$;
-- Settles every visible operation of the tenant created since this transaction began (own ones,
-- and any committed one whose writer did not settle). Re-settling adds only the difference, so a
-- child row inserted after an earlier settle in the same transaction is still counted.
CREATE FUNCTION wms_evidence_usage_settle() RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;r record;old record;
 dops bigint=0;dlay bigint=0;db bigint=0;BEGIN
 IF t IS NULL THEN RETURN;END IF;
 FOR r IN SELECT o.id,
  octet_length(to_jsonb(o)::text)
  +(SELECT coalesce(sum(octet_length(to_jsonb(x)::text)),0) FROM wms_cost_layers x WHERE (x.tenant_id,x.operation_id)=(t,o.id))
  +(SELECT coalesce(sum(octet_length(to_jsonb(x)::text)),0) FROM wms_layer_movements x WHERE (x.tenant_id,x.operation_id)=(t,o.id))
  +(SELECT coalesce(sum(octet_length(to_jsonb(x)::text)),0) FROM wms_issue_fragments x WHERE (x.tenant_id,x.operation_id)=(t,o.id))
  +(SELECT coalesce(sum(octet_length(to_jsonb(x)::text)),0) FROM wms_return_fragments x WHERE (x.tenant_id,x.operation_id)=(t,o.id)) b,
  (SELECT count(*) FROM wms_cost_layers x WHERE (x.tenant_id,x.operation_id)=(t,o.id)) layers
  FROM wms_operations o WHERE o.tenant_id=t AND o.created_at>=transaction_timestamp() ORDER BY o.id
 LOOP
  SELECT * INTO old FROM wms_evidence_settled WHERE (tenant_id,operation_id)=(t,r.id) FOR UPDATE;
  IF NOT FOUND THEN
   INSERT INTO wms_evidence_settled VALUES(t,r.id,r.layers,r.b) ON CONFLICT DO NOTHING;
   IF FOUND THEN dops:=dops+1;dlay:=dlay+r.layers;db:=db+r.b;END IF;
  ELSIF (old.layers,old.bytes)<>(r.layers,r.b) THEN
   UPDATE wms_evidence_settled SET layers=r.layers,bytes=r.b WHERE (tenant_id,operation_id)=(t,r.id);
   dlay:=dlay+r.layers-old.layers;db:=db+r.b-old.bytes;
  END IF;
 END LOOP;
 PERFORM wms_evidence_usage_add(t,dops,dlay,0,db);
END $$;
-- Tables outside the fingerprinted five keep plain statement triggers. INSERT and UPDATE get separate
-- functions: an INSERT trigger has no OLD transition table, and a query naming it fails at parse time
-- even behind WHERE TG_OP='UPDATE' (found on the clone: every insert into wms_previews raised).
CREATE FUNCTION wms_evidence_usage_track() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;BEGIN
 FOR r IN SELECT tenant_id,count(*) n,sum(octet_length(to_jsonb(x)::text)) b FROM wms_evidence_new x GROUP BY tenant_id ORDER BY tenant_id
 LOOP
  PERFORM wms_evidence_usage_add(r.tenant_id,0,0,CASE WHEN TG_TABLE_NAME='wms_previews' THEN r.n ELSE 0 END,r.b);
 END LOOP;RETURN NULL;
END $$;
-- UPDATE (only the two versioned stocktake heads): the size difference; the row count does not change.
CREATE FUNCTION wms_evidence_usage_track_update() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;BEGIN
 FOR r IN
  SELECT tenant_id,sum(b) b FROM (
   SELECT tenant_id,octet_length(to_jsonb(x)::text) b FROM wms_evidence_new x
   UNION ALL SELECT tenant_id,-octet_length(to_jsonb(x)::text) FROM wms_evidence_old x
  ) d GROUP BY tenant_id ORDER BY tenant_id
 LOOP
  PERFORM wms_evidence_usage_add(r.tenant_id,0,0,0,r.b);
 END LOOP;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION wms_evidence_usage_add(uuid,bigint,bigint,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION wms_evidence_usage_track() FROM PUBLIC;
REVOKE ALL ON FUNCTION wms_evidence_usage_track_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION wms_evidence_usage_settle() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wms_evidence_usage_settle() TO dyna_app;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY[
 'wms_previews','wms_lots','wms_stocktakes','wms_stocktake_lines','wms_stocktake_scope_layers',
 'wms_stocktake_measurements','wms_stocktake_measurement_layers','wms_stocktake_reviews',
 'wms_stocktake_review_rows','wms_stocktake_postings'] LOOP
 EXECUTE format('CREATE TRIGGER wms_evidence_usage_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS wms_evidence_new FOR EACH STATEMENT EXECUTE FUNCTION wms_evidence_usage_track()',t);
 -- Only the two versioned stocktake heads are updatable; every other table rejects UPDATE/DELETE.
 IF t IN ('wms_stocktakes','wms_stocktake_lines') THEN
  EXECUTE format('CREATE TRIGGER wms_evidence_usage_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS wms_evidence_old NEW TABLE AS wms_evidence_new FOR EACH STATEMENT EXECUTE FUNCTION wms_evidence_usage_track_update()',t);
 END IF;
END LOOP;END $$;
-- Backfill inside the migration transaction. The five settled tables are locked against writers
-- first, so no operation lands between the scan and the ledger.
LOCK TABLE wms_operations,wms_cost_layers,wms_layer_movements,wms_issue_fragments,wms_return_fragments IN SHARE MODE;
INSERT INTO wms_evidence_settled(tenant_id,operation_id,layers,bytes)
SELECT o.tenant_id,o.id,coalesce(l.n,0),octet_length(to_jsonb(o)::text)+coalesce(l.b,0)+coalesce(m.b,0)+coalesce(i.b,0)+coalesce(f.b,0)
FROM wms_operations o
LEFT JOIN (SELECT tenant_id,operation_id,count(*) n,sum(octet_length(to_jsonb(x)::text)) b FROM wms_cost_layers x GROUP BY 1,2) l ON (l.tenant_id,l.operation_id)=(o.tenant_id,o.id)
LEFT JOIN (SELECT tenant_id,operation_id,sum(octet_length(to_jsonb(x)::text)) b FROM wms_layer_movements x GROUP BY 1,2) m ON (m.tenant_id,m.operation_id)=(o.tenant_id,o.id)
LEFT JOIN (SELECT tenant_id,operation_id,sum(octet_length(to_jsonb(x)::text)) b FROM wms_issue_fragments x GROUP BY 1,2) i ON (i.tenant_id,i.operation_id)=(o.tenant_id,o.id)
LEFT JOIN (SELECT tenant_id,operation_id,sum(octet_length(to_jsonb(x)::text)) b FROM wms_return_fragments x GROUP BY 1,2) f ON (f.tenant_id,f.operation_id)=(o.tenant_id,o.id);
INSERT INTO wms_evidence_usage(tenant_id,slot,operations,layers,previews,bytes)
SELECT tenant_id,0,sum(o),sum(l),sum(p),sum(b) FROM (
 SELECT tenant_id,1 o,layers l,0 p,bytes b FROM wms_evidence_settled
 UNION ALL SELECT tenant_id,0,0,1,octet_length(to_jsonb(x)::text) FROM wms_previews x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_lots x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktakes x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktake_lines x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktake_scope_layers x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktake_measurements x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktake_measurement_layers x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktake_reviews x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktake_review_rows x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktake_postings x
) e GROUP BY tenant_id;
