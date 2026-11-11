-- Ephemeral owner-only provenance. No caller-writable context/GUC can manufacture
-- the pre-write snapshot. This row is deleted only after successful validation;
-- rollback/savepoint restores it together with its deferred constraint event.
CREATE TABLE replenishment_append_preparations (
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL REFERENCES tenants,
 execution_id uuid NOT NULL,preview_id uuid NOT NULL,group_index integer NOT NULL CHECK(group_index>=0 AND group_index<=499),
 purchase_order_id uuid NOT NULL,before_snapshot jsonb NOT NULL CHECK(jsonb_typeof(before_snapshot)='object'),
 PRIMARY KEY(tenant_id,execution_id,group_index),UNIQUE(tenant_id,execution_id,purchase_order_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES replenishment_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES purchase_orders(tenant_id,id)
);
ALTER TABLE replenishment_append_preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE replenishment_append_preparations FORCE ROW LEVEL SECURITY;
DO $$ BEGIN EXECUTE format('CREATE POLICY owner_scope ON replenishment_append_preparations TO %I USING (true) WITH CHECK (true)',current_user);END $$;
REVOKE ALL ON replenishment_append_preparations FROM PUBLIC,dyna_app;

-- Immutable provenance for the transaction source seal. This is bounded by
-- the existing 2000 execution/tenant quota, not an ephemeral context or xmin:
-- savepoint INSERT uses a subxid, whereas this records the actual top xid8.
CREATE TABLE replenishment_append_seals (
 tenant_id uuid NOT NULL REFERENCES tenants,execution_id uuid NOT NULL,transaction_id xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,execution_id),
 FOREIGN KEY(tenant_id,execution_id) REFERENCES replenishment_executions(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX replenishment_append_seals_transaction ON replenishment_append_seals(transaction_id,tenant_id);
ALTER TABLE replenishment_append_seals ENABLE ROW LEVEL SECURITY;
ALTER TABLE replenishment_append_seals FORCE ROW LEVEL SECURITY;
DO $$ BEGIN EXECUTE format('CREATE POLICY owner_scope ON replenishment_append_seals TO %I USING (true) WITH CHECK (true)',current_user);END $$;
REVOKE ALL ON replenishment_append_seals FROM PUBLIC,dyna_app;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON replenishment_append_seals FOR EACH ROW EXECUTE FUNCTION replenishment_immutable();

CREATE FUNCTION replenishment_append_source_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE scope uuid; BEGIN
 scope:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF scope IS NOT NULL AND EXISTS(SELECT 1 FROM public.replenishment_append_seals WHERE tenant_id=scope AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp()) THEN
  RAISE EXCEPTION 'Append execution seals its purchase source until transaction commit' USING ERRCODE='23514';
 END IF; RETURN NULL;
END $$;
CREATE FUNCTION replenishment_append_source_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid;query text;BEGIN
 query:=CASE TG_OP
 WHEN 'INSERT' THEN 'SELECT DISTINCT tenant_id FROM append_new_rows'
 WHEN 'DELETE' THEN 'SELECT DISTINCT tenant_id FROM append_old_rows'
 ELSE 'SELECT tenant_id FROM append_new_rows UNION SELECT tenant_id FROM append_old_rows' END;
 FOR t IN EXECUTE query LOOP
  IF EXISTS(SELECT 1 FROM public.replenishment_append_seals WHERE tenant_id=t AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp()) THEN
   RAISE EXCEPTION 'Append execution seals actual own purchase source until commit' USING ERRCODE='23514';
  END IF;
 END LOOP;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION replenishment_append_source_before(),replenishment_append_source_after() FROM PUBLIC,dyna_app;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['purchase_orders','purchase_order_lines','purchase_receipts','purchase_receipt_lines',
 'b2b_network_orders','b2b_network_order_lines','b2b_network_receipts','b2b_network_receipt_lines',
 'stock','stock_movements','purchasing_source_versions','purchasing_stock_changes'] LOOP
  EXECUTE format('CREATE TRIGGER replenishment_append_seal_before BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION replenishment_append_source_before()',t);
  EXECUTE format('CREATE TRIGGER replenishment_append_seal_insert AFTER INSERT ON public.%I REFERENCING NEW TABLE AS append_new_rows FOR EACH STATEMENT EXECUTE FUNCTION replenishment_append_source_after()',t);
  EXECUTE format('CREATE TRIGGER replenishment_append_seal_update AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS append_old_rows NEW TABLE AS append_new_rows FOR EACH STATEMENT EXECUTE FUNCTION replenishment_append_source_after()',t);
  EXECUTE format('CREATE TRIGGER replenishment_append_seal_delete AFTER DELETE ON public.%I REFERENCING OLD TABLE AS append_old_rows FOR EACH STATEMENT EXECUTE FUNCTION replenishment_append_source_after()',t);
 END LOOP;
END $$;

CREATE FUNCTION replenishment_append_prepare(p_preview uuid,p_execution uuid,p_group integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE scope uuid;invoker text; p record; po record;g jsonb;head jsonb;lines jsonb;original jsonb;BEGIN
 invoker:=coalesce(nullif(current_setting('role',true),'none'),session_user::text);
 IF invoker NOT IN ('dyna_app',current_user::text) THEN RAISE EXCEPTION 'Append preparation caller is not authorized' USING ERRCODE='42501';END IF;
 scope:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF scope IS NULL THEN RAISE EXCEPTION 'Append preparation requires own tenant scope' USING ERRCODE='42501';END IF;
 PERFORM public.purchasing_source_admit();
 SELECT * INTO p FROM public.replenishment_previews WHERE (tenant_id,id)=(scope,p_preview);
 IF p.id IS NULL OR NOT p.ready OR p.expires_at<=clock_timestamp()
  OR public.replenishment_current_role(p.actor_id,false) IS DISTINCT FROM 'admin'
  OR p_group<0 OR p_group>=jsonb_array_length(p.groups) THEN
  RAISE EXCEPTION 'Append preparation requires current own ready preview' USING ERRCODE='23514';END IF;
 g:=p.groups->p_group;
 IF g->'destination'->>'kind' IS DISTINCT FROM 'existing_draft' THEN
  RAISE EXCEPTION 'Append preparation requires approved existing draft' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM replenishment_executions WHERE (tenant_id,id)=(scope,p_execution)) THEN
  RAISE EXCEPTION 'Append execution already exists' USING ERRCODE='23514';END IF;
 SELECT * INTO po FROM public.purchase_orders WHERE (tenant_id,id)=(scope,(g->'destination'->>'purchase_order_id')::uuid) FOR UPDATE;
 IF po.id IS NULL OR po.state IS DISTINCT FROM 'draft' OR po.version IS DISTINCT FROM (g->'destination'->>'version')::integer
  OR ROW(po.supplier_id,po.warehouse_id,po.currency) IS DISTINCT FROM ROW((g->>'supplier_id')::uuid,p.warehouse_id,g->>'currency') THEN
  RAISE EXCEPTION 'Append target changed or is outside approved source' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM public.purchase_order_lines WHERE (tenant_id,order_id)=(scope,po.id) ORDER BY product_id FOR UPDATE;
 SELECT to_jsonb(po),coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.product_id) FROM public.purchase_order_lines l WHERE (l.tenant_id,l.order_id)=(scope,po.id)),'[]'::jsonb) INTO head,lines;
 original:=jsonb_build_object('head',head,'lines',lines);
 IF original IS DISTINCT FROM g->'destination'->'snapshot' OR EXISTS(SELECT 1 FROM public.purchase_receipts WHERE (tenant_id,order_id)=(scope,po.id))
 OR EXISTS(SELECT 1 FROM public.purchase_order_lines WHERE (tenant_id,order_id)=(scope,po.id) AND (received_quantity<>0 OR closed_quantity<>0)) THEN
  RAISE EXCEPTION 'Append source snapshot differs from actual untouched draft' USING ERRCODE='23514';END IF;
 INSERT INTO public.replenishment_append_preparations VALUES(pg_current_xact_id(),scope,p_execution,p_preview,p_group,po.id,original);
END $$;
REVOKE ALL ON FUNCTION replenishment_append_prepare(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replenishment_append_prepare(uuid,uuid,integer) TO dyna_app;

CREATE FUNCTION replenishment_append_admitted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE g jsonb;prepared record; BEGIN
 FOR g IN SELECT value FROM jsonb_array_elements(NEW.groups) LOOP
  IF g->'destination'->>'kind'='existing_draft' THEN
   SELECT * INTO prepared FROM public.replenishment_append_preparations WHERE (tenant_id,execution_id,group_index)=(NEW.tenant_id,NEW.id,(g->>'index')::integer);
   IF prepared.execution_id IS NULL OR prepared.transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR prepared.preview_id IS DISTINCT FROM NEW.preview_id
    OR prepared.purchase_order_id IS DISTINCT FROM (g->>'purchase_order_id')::uuid
    OR prepared.before_snapshot IS DISTINCT FROM g->'destination'->'snapshot' THEN
    RAISE EXCEPTION 'Append execution has no genuine same-transaction preparation' USING ERRCODE='23514';END IF;
  ELSIF g ? 'destination' THEN
   RAISE EXCEPTION 'Unknown replenishment destination' USING ERRCODE='23514';
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.groups) AS group_json(value) WHERE group_json.value->'destination'->>'kind'='existing_draft') THEN
  INSERT INTO public.replenishment_append_seals VALUES(NEW.tenant_id,NEW.id,pg_current_xact_id(),transaction_timestamp());
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION replenishment_append_admitted() FROM PUBLIC,dyna_app;
CREATE TRIGGER append_prepared BEFORE INSERT ON replenishment_executions FOR EACH ROW EXECUTE FUNCTION replenishment_append_admitted();

CREATE FUNCTION replenishment_append_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e record;p record;po record;g jsonb;before_head jsonb;before_line jsonb;actual_line jsonb;row_input record;
 n integer;before_total numeric;after_total numeric;delta_total numeric;BEGIN
 IF NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'Append provenance transaction differs' USING ERRCODE='23514';END IF;
 SELECT * INTO e FROM public.replenishment_executions WHERE (tenant_id,id,preview_id)=(NEW.tenant_id,NEW.execution_id,NEW.preview_id);
 IF e.id IS NULL THEN RAISE EXCEPTION 'Prepared append requires immutable execution' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM public.replenishment_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
 g:=e.groups->NEW.group_index;
 IF g IS NULL OR (g->>'index')::integer IS DISTINCT FROM NEW.group_index
 OR (g->>'purchase_order_id')::uuid IS DISTINCT FROM NEW.purchase_order_id
 OR g->'destination'->>'kind' IS DISTINCT FROM 'existing_draft'
 OR g->'destination'->'snapshot' IS DISTINCT FROM NEW.before_snapshot
 OR (g-'purchase_order_id'-'number'-'version') IS DISTINCT FROM p.groups->NEW.group_index THEN
  RAISE EXCEPTION 'Append execution changed approved destination' USING ERRCODE='23514';END IF;
 SELECT * INTO po FROM public.purchase_orders WHERE (tenant_id,id)=(NEW.tenant_id,NEW.purchase_order_id);
 before_head:=NEW.before_snapshot->'head';
 IF po.id IS NULL OR (to_jsonb(po)-'version'-'updated_at') IS DISTINCT FROM (before_head-'version'-'updated_at')
 OR po.version::bigint IS DISTINCT FROM (before_head->>'version')::bigint+1
 OR (g->>'version')::integer IS DISTINCT FROM po.version OR g->>'number' IS DISTINCT FROM po.number
 OR po.state IS DISTINCT FROM 'draft' OR po.updated_at IS NULL OR po.updated_at<(before_head->>'updated_at')::timestamptz
 OR EXISTS(SELECT 1 FROM public.purchase_receipts WHERE (tenant_id,order_id)=(NEW.tenant_id,po.id)) THEN
  RAISE EXCEPTION 'Append changed original purchase metadata or version' USING ERRCODE='23514';END IF;
 -- Existing physical identities and all snapshots survive; only approved qty rises.
 FOR before_line IN SELECT value FROM jsonb_array_elements(NEW.before_snapshot->'lines') LOOP
  SELECT to_jsonb(l) INTO actual_line FROM public.purchase_order_lines l WHERE (l.tenant_id,l.order_id,l.product_id)=(NEW.tenant_id,po.id,(before_line->>'product_id')::uuid);
  SELECT * INTO row_input FROM public.replenishment_execution_rows r WHERE (r.tenant_id,r.execution_id,r.product_id)=(NEW.tenant_id,e.id,(before_line->>'product_id')::uuid)
   AND r.status='purchase' AND (r.result->>'group_index')::integer=NEW.group_index;
  IF actual_line IS NULL OR (actual_line-'quantity') IS DISTINCT FROM (before_line-'quantity')
   OR (actual_line->>'quantity')::bigint IS DISTINCT FROM (before_line->>'quantity')::bigint+coalesce((row_input.result->>'recommended_quantity')::bigint,0) THEN
   RAISE EXCEPTION 'Append changed untouched line identity or quantity' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR row_input IN SELECT * FROM public.replenishment_execution_rows r WHERE (r.tenant_id,r.execution_id)=(NEW.tenant_id,e.id)
  AND r.status='purchase' AND (r.result->>'group_index')::integer=NEW.group_index LOOP
  SELECT to_jsonb(l) INTO actual_line FROM public.purchase_order_lines l WHERE (l.tenant_id,l.order_id,l.product_id)=(NEW.tenant_id,po.id,row_input.product_id);
  SELECT value INTO before_line FROM jsonb_array_elements(NEW.before_snapshot->'lines') WHERE (value->>'product_id')::uuid=row_input.product_id;
  IF row_input.purchase_order_id IS DISTINCT FROM po.id OR actual_line IS NULL
   OR (actual_line->>'unit_cost')::integer IS DISTINCT FROM (row_input.result->>'unit_cost_minor')::integer
   OR actual_line->>'supplier_sku' IS DISTINCT FROM row_input.snapshot->'policy'->>'supplier_sku'
   OR (actual_line->>'quantity')::bigint IS DISTINCT FROM coalesce((before_line->>'quantity')::bigint,0)+(row_input.result->>'recommended_quantity')::bigint
   OR (actual_line->>'received_quantity')::integer IS DISTINCT FROM 0 OR (actual_line->>'closed_quantity')::integer IS DISTINCT FROM 0
   OR (before_line IS NULL AND (actual_line->>'sku' IS DISTINCT FROM row_input.snapshot->'product'->>'sku' OR actual_line->>'name' IS DISTINCT FROM row_input.snapshot->'product'->>'name')) THEN
   RAISE EXCEPTION 'Append line differs from approved quantity cost or source snapshot' USING ERRCODE='23514';END IF;
 END LOOP;
 SELECT count(*),sum(quantity::numeric*unit_cost) INTO n,after_total FROM public.purchase_order_lines WHERE (tenant_id,order_id)=(NEW.tenant_id,po.id);
 SELECT coalesce(sum((value->>'quantity')::numeric*(value->>'unit_cost')::numeric),0) INTO before_total FROM jsonb_array_elements(NEW.before_snapshot->'lines');
 SELECT count(*),coalesce(sum((result->>'line_total_minor')::numeric),0) INTO n,delta_total FROM public.replenishment_execution_rows
  WHERE (tenant_id,execution_id)=(NEW.tenant_id,e.id) AND status='purchase' AND (result->>'group_index')::integer=NEW.group_index;
 IF n IS DISTINCT FROM (g->>'line_count')::integer OR n<1 OR n>200
 OR jsonb_array_length(NEW.before_snapshot->'lines') IS DISTINCT FROM (g->'destination'->>'line_count_before')::integer
 OR (SELECT count(*) FROM public.purchase_order_lines WHERE (tenant_id,order_id)=(NEW.tenant_id,po.id)) IS DISTINCT FROM (g->'destination'->>'line_count_after')::bigint
 OR (g->'destination'->>'line_count_after')::integer>200
 OR after_total IS DISTINCT FROM before_total+delta_total OR after_total>9007199254740991
 OR before_total::text IS DISTINCT FROM g->'destination'->>'total_before_minor'
 OR after_total::text IS DISTINCT FROM g->'destination'->>'total_after_minor'
 OR delta_total::text IS DISTINCT FROM g->>'total_minor'
 OR EXISTS(SELECT 1 FROM public.purchase_order_lines l WHERE (l.tenant_id,l.order_id)=(NEW.tenant_id,po.id)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.before_snapshot->'lines') b WHERE (b.value->>'product_id')::uuid=l.product_id)
   AND NOT EXISTS(SELECT 1 FROM public.replenishment_execution_rows r WHERE (r.tenant_id,r.execution_id,r.product_id)=(NEW.tenant_id,e.id,l.product_id) AND r.status='purchase' AND (r.result->>'group_index')::integer=NEW.group_index)) THEN
  RAISE EXCEPTION 'Append full line set totals or capacity differ from approved result' USING ERRCODE='23514';END IF;
 DELETE FROM public.replenishment_append_preparations WHERE (tenant_id,execution_id,group_index)=(NEW.tenant_id,NEW.execution_id,NEW.group_index);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION replenishment_append_validate() FROM PUBLIC,dyna_app;
CREATE CONSTRAINT TRIGGER append_validated AFTER INSERT ON replenishment_append_preparations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION replenishment_append_validate();

-- Original 099 new-draft completeness retained; only genuine prepared appends branch separately.
CREATE OR REPLACE FUNCTION replenishment_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n integer;buy integer;noop integer;bad integer;conf integer;p record;g jsonb;approved jsonb;po record;r record;line record;items jsonb;total numeric;epoch bigint;group_no integer:=0;
BEGIN
 IF TG_TABLE_NAME='replenishment_previews' THEN
  SELECT count(*),count(*) FILTER(WHERE status='purchase'),count(*) FILTER(WHERE status='unchanged'),count(*) FILTER(WHERE status='invalid'),count(*) FILTER(WHERE status='conflict')
   INTO n,buy,noop,bad,conf FROM replenishment_rows WHERE (tenant_id,preview_id)=(NEW.tenant_id,NEW.id);
  IF ROW(n,buy,noop,bad,conf) IS DISTINCT FROM ROW((NEW.summary->>'total')::integer,(NEW.summary->>'purchase')::integer,(NEW.summary->>'unchanged')::integer,(NEW.summary->>'invalid')::integer,(NEW.summary->>'conflicts')::integer)
  THEN RAISE EXCEPTION 'Replenishment preview is incomplete' USING ERRCODE='23514';END IF;
  IF NEW.ready AND (SELECT count(DISTINCT product_id) FROM replenishment_rows WHERE (tenant_id,preview_id)=(NEW.tenant_id,NEW.id))<>n THEN
   RAISE EXCEPTION 'Replenishment ready preview repeats product identity' USING ERRCODE='23514';END IF;
  FOR g IN SELECT value FROM jsonb_array_elements(NEW.groups) WITH ORDINALITY a(value,ordinal) ORDER BY ordinal LOOP
   IF (g->>'index')::integer IS DISTINCT FROM group_no OR jsonb_typeof(g->'product_ids') IS DISTINCT FROM 'array'
    OR (g->>'line_count')::integer IS NULL OR (g->>'line_count')::integer<1 OR (g->>'line_count')::integer>200 THEN
    RAISE EXCEPTION 'Replenishment group index or size is invalid' USING ERRCODE='23514';END IF;
   SELECT jsonb_agg(product_id::text ORDER BY product_id),sum((result->>'line_total_minor')::numeric) INTO items,total
    FROM replenishment_rows WHERE (tenant_id,preview_id)=(NEW.tenant_id,NEW.id) AND status='purchase' AND (result->>'group_index')::integer=(g->>'index')::integer;
   IF items IS DISTINCT FROM g->'product_ids' OR jsonb_array_length(items) IS DISTINCT FROM (g->>'line_count')::integer
   OR total::text IS DISTINCT FROM g->>'total_minor' THEN RAISE EXCEPTION 'Replenishment group differs from frozen rows' USING ERRCODE='23514';END IF;
   group_no:=group_no+1;
  END LOOP;
  IF EXISTS(SELECT 1 FROM replenishment_rows rr WHERE (rr.tenant_id,rr.preview_id)=(NEW.tenant_id,NEW.id) AND rr.status='purchase'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.groups) group_json WHERE (group_json->>'index')::integer=(rr.result->>'group_index')::integer)) THEN
   RAISE EXCEPTION 'Replenishment purchase row has no approved group' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO p FROM replenishment_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
  SELECT count(*),count(*) FILTER(WHERE status='purchase'),count(*) FILTER(WHERE status='unchanged') INTO n,buy,noop
   FROM replenishment_execution_rows WHERE (tenant_id,execution_id)=(NEW.tenant_id,NEW.id);
  IF ROW(n,buy,noop) IS DISTINCT FROM ROW((NEW.summary->>'total')::integer,(NEW.summary->>'purchase')::integer,(NEW.summary->>'unchanged')::integer) THEN
   RAISE EXCEPTION 'Replenishment execution is incomplete' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(value-'purchase_order_id'-'number'-'version' ORDER BY ordinal),'[]'::jsonb) INTO approved
   FROM jsonb_array_elements(NEW.groups) WITH ORDINALITY a(value,ordinal);
  IF approved IS DISTINCT FROM p.groups THEN RAISE EXCEPTION 'Replenishment execution groups differ from preview' USING ERRCODE='23514';END IF;
  SELECT coalesce((SELECT version FROM purchasing_source_versions WHERE tenant_id=NEW.tenant_id),0)
   +coalesce((SELECT max(id) FROM purchasing_stock_changes WHERE tenant_id=NEW.tenant_id),0) INTO epoch;
  IF NEW.after_source_version IS DISTINCT FROM coalesce(epoch,0) OR (buy=0 AND NEW.after_source_version<>NEW.before_source_version)
   OR (buy>0 AND NEW.after_source_version<=NEW.before_source_version) THEN
   RAISE EXCEPTION 'Replenishment execution source epoch is not actual' USING ERRCODE='23514';END IF;
  FOR g IN SELECT value FROM jsonb_array_elements(NEW.groups) LOOP
   IF g->'destination'->>'kind'='existing_draft' THEN CONTINUE;END IF; -- Genuine private prepared constraint validates full append instead.
   SELECT * INTO po FROM purchase_orders WHERE (tenant_id,id)=(NEW.tenant_id,(g->>'purchase_order_id')::uuid);
   IF po.id IS NULL OR ROW(po.replenishment_execution_id,po.replenishment_group_index,po.warehouse_id,po.supplier_id,po.currency,po.number,po.version,po.state,po.created_by,po.expected_date::text)
   IS DISTINCT FROM ROW(NEW.id,(g->>'index')::integer,NEW.warehouse_id,(g->>'supplier_id')::uuid,g->>'currency',g->>'number',1,'draft'::text,NEW.actor_id,g->>'expected_date')
   OR (g->>'version')::integer IS DISTINCT FROM 1 OR po.supplier_snapshot->>'name' IS DISTINCT FROM g->>'supplier_name' THEN
    RAISE EXCEPTION 'Replenishment group does not bind genuine initial draft' USING ERRCODE='23514';END IF;
   IF (SELECT count(*) FROM purchase_order_lines WHERE (tenant_id,order_id)=(NEW.tenant_id,po.id))<>(g->>'line_count')::integer THEN
    RAISE EXCEPTION 'Replenishment draft has unexpected line set' USING ERRCODE='23514';END IF;
   FOR r IN SELECT * FROM replenishment_execution_rows WHERE (tenant_id,execution_id)=(NEW.tenant_id,NEW.id)
    AND (result->>'group_index')::integer=(g->>'index')::integer AND status='purchase' LOOP
    SELECT * INTO line FROM purchase_order_lines WHERE (tenant_id,order_id,product_id)=(NEW.tenant_id,po.id,r.product_id);
    IF r.purchase_order_id IS DISTINCT FROM po.id OR line.product_id IS NULL OR
     ROW(line.quantity,line.unit_cost,line.supplier_sku,line.received_quantity,line.closed_quantity,line.sku,line.name)
     IS DISTINCT FROM ROW((r.result->>'recommended_quantity')::integer,(r.result->>'unit_cost_minor')::integer,r.snapshot->'policy'->>'supplier_sku',0,0,r.snapshot->'product'->>'sku',r.snapshot->'product'->>'name') THEN
     RAISE EXCEPTION 'Replenishment draft line differs from approved row' USING ERRCODE='23514';END IF;
   END LOOP;
  END LOOP;
 END IF;RETURN NULL;
END $$;
