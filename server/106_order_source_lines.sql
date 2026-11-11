-- Immutable identities for newly imported remote commercial lines; no historical backfill.
ALTER TABLE inbound_orders ADD UNIQUE(tenant_id,id);
ALTER TABLE order_items ADD UNIQUE(tenant_id,order_id,id,product_id);
CREATE TABLE order_source_lines (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,inbound_id uuid NOT NULL,
 source_order_id uuid NOT NULL,source_item_id uuid NOT NULL,remote_line_id text NOT NULL,
 external_product_id text NOT NULL,product_id uuid NOT NULL,listing_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity>=1 AND quantity<=100000),
 line_total integer NOT NULL CHECK(line_total>=0),source_hash text NOT NULL CHECK(source_hash~'^[0-9a-f]{64}$'),
 mapping_evidence jsonb NOT NULL CHECK(jsonb_typeof(mapping_evidence)='object' AND octet_length(mapping_evidence::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(length(remote_line_id)>=1 AND length(remote_line_id)<=200 AND remote_line_id!~'[[:cntrl:]]'),
 CHECK(length(external_product_id)>=1 AND length(external_product_id)<=160 AND external_product_id!~'[[:cntrl:]]'),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,channel_id,inbound_id,remote_line_id),UNIQUE(tenant_id,source_item_id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),
 FOREIGN KEY(tenant_id,inbound_id) REFERENCES inbound_orders(tenant_id,id),
 FOREIGN KEY(tenant_id,source_order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,source_order_id,source_item_id,product_id) REFERENCES order_items(tenant_id,order_id,id,product_id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 FOREIGN KEY(tenant_id,listing_id) REFERENCES listings(tenant_id,id)
);
CREATE INDEX order_source_line_order ON order_source_lines(tenant_id,source_order_id,id);
CREATE INDEX order_source_line_remote ON order_source_lines(tenant_id,channel_id,remote_line_id);
CREATE INDEX order_source_line_inbound ON order_source_lines(tenant_id,inbound_id,id);
CREATE INDEX order_source_line_product ON order_source_lines(tenant_id,product_id,id);
CREATE INDEX order_source_line_listing ON order_source_lines(tenant_id,listing_id,id);

CREATE FUNCTION order_source_line_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE item_row record; source_row record; listing_row record; channel_row record; line_json jsonb; expected jsonb; n integer;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Powiązania pozycji źródłowych są niezmienne' USING ERRCODE='23514'; END IF;
 -- Genuine composite FKs report missing/foreign relations; this guard binds existing own evidence.
 SELECT * INTO item_row FROM order_items WHERE (tenant_id,order_id,id,product_id)=(NEW.tenant_id,NEW.source_order_id,NEW.source_item_id,NEW.product_id);
 SELECT * INTO source_row FROM inbound_orders WHERE (tenant_id,id)=(NEW.tenant_id,NEW.inbound_id);
 SELECT * INTO listing_row FROM listings WHERE (tenant_id,id)=(NEW.tenant_id,NEW.listing_id);
 SELECT * INTO channel_row FROM channels WHERE (tenant_id,id)=(NEW.tenant_id,NEW.channel_id);
 IF item_row.id IS NULL OR source_row.id IS NULL OR listing_row.id IS NULL OR channel_row.id IS NULL THEN RETURN NEW; END IF;
 IF source_row.channel_id IS DISTINCT FROM NEW.channel_id OR source_row.order_id IS DISTINCT FROM NEW.source_order_id
  OR source_row.state IS DISTINCT FROM 'imported' OR source_row.imported_hash IS DISTINCT FROM NEW.source_hash
  OR source_row.source_hash IS DISTINCT FROM NEW.source_hash
  OR listing_row.channel_id IS DISTINCT FROM NEW.channel_id OR listing_row.product_id IS DISTINCT FROM NEW.product_id
  OR listing_row.external_id IS DISTINCT FROM NEW.external_product_id
  OR item_row.quantity IS DISTINCT FROM NEW.quantity OR item_row.line_total IS DISTINCT FROM NEW.line_total THEN
  RAISE EXCEPTION 'Niezgodne źródło, pozycja lub mapowanie importu' USING ERRCODE='23514';
 END IF;
 IF jsonb_typeof(NEW.mapping_evidence->'source_index') IS DISTINCT FROM 'number'
  OR coalesce(NEW.mapping_evidence->>'source_index','')!~'^(0|[1-9][0-9]{0,2})$' THEN
  RAISE EXCEPTION 'Nieprawidłowy indeks źródłowej pozycji' USING ERRCODE='23514';
 END IF;
 n:=(NEW.mapping_evidence->>'source_index')::integer;
 SELECT source_snapshot->'items'->n INTO line_json FROM orders
  WHERE (tenant_id,id,channel_id,external_id)=(NEW.tenant_id,NEW.source_order_id,NEW.channel_id,source_row.external_id);
 IF line_json IS NULL OR jsonb_typeof(line_json) IS DISTINCT FROM 'object'
  OR line_json->>'remote_line_id' IS DISTINCT FROM NEW.remote_line_id
  OR line_json->>'external_id' IS DISTINCT FROM NEW.external_product_id
  OR line_json->'quantity' IS DISTINCT FROM to_jsonb(NEW.quantity)
  OR line_json->'line_total' IS DISTINCT FROM to_jsonb(NEW.line_total) THEN
  RAISE EXCEPTION 'Niezgodna oryginalna pozycja źródłowa' USING ERRCODE='23514';
 END IF;
 expected:=jsonb_build_object('source_index',n,'remote_line_id',NEW.remote_line_id,'external_product_id',NEW.external_product_id,
  'listing',jsonb_build_object('id',NEW.listing_id,'channel_id',NEW.channel_id,'external_id',NEW.external_product_id,'product_id',NEW.product_id),
  'source_line',line_json);
 IF NEW.mapping_evidence IS DISTINCT FROM expected THEN
  RAISE EXCEPTION 'Niezgodny dowód mapowania źródłowej pozycji' USING ERRCODE='23514';
 END IF;
 IF channel_row.provider='shopify' AND (NEW.remote_line_id!~'^gid://shopify/LineItem/[1-9][0-9]*$'
  OR (SELECT count(*) FROM jsonb_array_elements(coalesce(source_row.raw->'lineItems'->'nodes',
   (SELECT jsonb_agg(e->'node') FROM jsonb_array_elements(source_row.raw->'lineItems'->'edges') e),'[]'::jsonb)) remote
   WHERE remote->>'id'=NEW.remote_line_id AND remote->'quantity'=to_jsonb(NEW.quantity)
    AND remote->'variant'->>'id'=NEW.external_product_id)<>1) THEN
  RAISE EXCEPTION 'Brak jednoznacznego ID LineItem Shopify' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_source_line_scope BEFORE INSERT OR UPDATE OR DELETE ON order_source_lines FOR EACH ROW EXECUTE FUNCTION order_source_line_guard();
CREATE FUNCTION order_source_line_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source_items jsonb; expected_count integer; actual_count integer;
BEGIN
 SELECT source_snapshot->'items' INTO source_items FROM orders WHERE (tenant_id,id)=(NEW.tenant_id,NEW.source_order_id);
 IF jsonb_typeof(source_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Brak kompletu źródłowych pozycji' USING ERRCODE='23514'; END IF;
 expected_count:=jsonb_array_length(source_items);
 SELECT count(*) INTO actual_count FROM order_source_lines WHERE (tenant_id,source_order_id,inbound_id)=(NEW.tenant_id,NEW.source_order_id,NEW.inbound_id);
 IF expected_count<1 OR expected_count>100 OR actual_count<>expected_count
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(source_items) WITH ORDINALITY AS s(line,ordinal)
   WHERE NOT EXISTS(SELECT 1 FROM order_source_lines b WHERE b.tenant_id=NEW.tenant_id AND b.source_order_id=NEW.source_order_id
    AND b.inbound_id=NEW.inbound_id AND b.remote_line_id=s.line->>'remote_line_id'
    AND b.mapping_evidence->'source_index'=to_jsonb((s.ordinal-1)::integer)
    AND b.mapping_evidence->'source_line'=s.line
    AND b.quantity::text=s.line->>'quantity' AND b.line_total::text=s.line->>'line_total'))
  OR EXISTS(SELECT 1 FROM order_source_lines b JOIN order_items i ON (i.tenant_id,i.order_id,i.id)=(b.tenant_id,b.source_order_id,b.source_item_id)
   WHERE (b.tenant_id,b.source_order_id)=(NEW.tenant_id,NEW.source_order_id)
    AND (b.product_id IS DISTINCT FROM i.product_id OR b.quantity IS DISTINCT FROM i.quantity OR b.line_total IS DISTINCT FROM i.line_total))
  OR (SELECT count(*) FROM order_items WHERE (tenant_id,order_id)=(NEW.tenant_id,NEW.source_order_id))<>expected_count THEN
  RAISE EXCEPTION 'Niepełne powiązania oryginalnych pozycji importu' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER order_source_line_complete AFTER INSERT ON order_source_lines
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_source_line_complete();
ALTER TABLE order_source_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_source_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON order_source_lines TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON order_source_lines TO dyna_app;
REVOKE ALL ON FUNCTION order_source_line_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION order_source_line_complete() FROM PUBLIC;
