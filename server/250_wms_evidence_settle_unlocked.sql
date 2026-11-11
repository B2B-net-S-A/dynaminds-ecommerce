-- Migration 250_wms_evidence_settle_unlocked (prepared as 257, registered after 249_catalog_ai; no object name
-- contains the number). docs/parity/WMS-LOCK250-20261028.md.
-- The 235 settle without row locks on other transactions' settled rows.
-- Since 250 ordinary WMS writers of one tenant share the operations fence (server/wms-lots-transaction.ts),
-- so operations of other writers commit while a transaction is open. The 235 body locked the settled row
-- (SELECT ... FOR UPDATE, held to COMMIT) of every visible operation created since the transaction began,
-- including ones already committed and settled by their writer; two open writers that each saw a different
-- subset of such rows deadlocked (40P01). A committed operation is settled by its own writer in the same
-- transaction and its rows are immutable, so its settled row is read without a lock. Only a row that differs
-- (this transaction's own operation after a later child row) is updated, and only if it still holds the
-- values read (no double count under a concurrent catch-up). Missing rows are inserted as before.
-- Same signature, owner, SECURITY DEFINER and EXECUTE grant (CREATE OR REPLACE keeps them); no table,
-- trigger, column or index changes, so the catalogue fingerprints of the five operation tables stay as they are.
CREATE OR REPLACE FUNCTION wms_evidence_usage_settle() RETURNS void
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
  SELECT * INTO old FROM wms_evidence_settled WHERE (tenant_id,operation_id)=(t,r.id);
  IF NOT FOUND THEN
   INSERT INTO wms_evidence_settled VALUES(t,r.id,r.layers,r.b) ON CONFLICT DO NOTHING;
   IF FOUND THEN dops:=dops+1;dlay:=dlay+r.layers;db:=db+r.b;END IF;
  ELSIF (old.layers,old.bytes)<>(r.layers,r.b) THEN
   UPDATE wms_evidence_settled SET layers=r.layers,bytes=r.b
    WHERE (tenant_id,operation_id)=(t,r.id) AND (layers,bytes)=(old.layers,old.bytes);
   IF FOUND THEN dlay:=dlay+r.layers-old.layers;db:=db+r.b-old.bytes;END IF;
  END IF;
 END LOOP;
 PERFORM wms_evidence_usage_add(t,dops,dlay,0,db);
END $$;
