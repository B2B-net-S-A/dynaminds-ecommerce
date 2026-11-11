-- Additive proof for physical counting only. No stock, reservation or journal writes.
-- Resolve scoped lots before bin positions; avoid a same-bin many-lot cross product.
CREATE INDEX wms_layer_stocktake_lot ON wms_cost_layers(tenant_id,product_id,lot_id,id);
ALTER TABLE stocktake_lines ADD CONSTRAINT stocktake_lines_scan_parent UNIQUE(tenant_id,stocktake_id,id);
ALTER TABLE stocktake_lines ADD CONSTRAINT stocktake_lines_scan_product UNIQUE(tenant_id,id,product_id);
ALTER TABLE stocktake_measurements ADD CONSTRAINT stocktake_measurements_scan_parent UNIQUE(tenant_id,stocktake_id,id);
CREATE INDEX stocktake_measurements_scan_version ON stocktake_measurements(tenant_id,stocktake_id,((CASE WHEN result->>'version' ~ '^[1-9][0-9]{0,18}$' THEN (result->>'version')::numeric END)));
CREATE INDEX wms_stocktake_measurements_scan_version ON wms_stocktake_measurements(tenant_id,stocktake_id,((CASE WHEN result->>'version' ~ '^[1-9][0-9]{0,18}$' THEN (result->>'version')::numeric END))) WHERE kind='count';
CREATE TABLE stocktake_scan_receipts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,engine text NOT NULL CHECK(engine IN ('wms','quantity')),
 wms_stocktake_id uuid,wms_line_id uuid,wms_measurement_id uuid,
 quantity_stocktake_id uuid,quantity_line_id uuid,quantity_measurement_id uuid,
 stocktake_id uuid GENERATED ALWAYS AS (coalesce(wms_stocktake_id,quantity_stocktake_id)) STORED,
 line_id uuid GENERATED ALWAYS AS (coalesce(wms_line_id,quantity_line_id)) STORED,
 measurement_id uuid GENERATED ALWAYS AS (coalesce(wms_measurement_id,quantity_measurement_id)) STORED,
 product_id uuid NOT NULL,location text NOT NULL CHECK(char_length(location) BETWEEN 1 AND 80 AND location=btrim(location) AND location !~ '[[:cntrl:]]'),
 lot_id uuid,lot_snapshot jsonb,actor_id uuid NOT NULL REFERENCES users,source text NOT NULL CHECK(source IN ('manual','api')),
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 kind text NOT NULL CHECK(kind IN ('start','increment')),generation_id uuid NOT NULL,prior_scan_id uuid,
 code text NOT NULL CHECK(char_length(code) BETWEEN 1 AND 80 AND code=btrim(code) AND code !~ '[[:cntrl:]]'),
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),matched_by jsonb NOT NULL CHECK(jsonb_typeof(matched_by)='array' AND jsonb_array_length(matched_by) BETWEEN 1 AND 4),
 basis_hash text NOT NULL CHECK(basis_hash ~ '^[a-f0-9]{64}$'),previous_count integer CHECK(previous_count>=0),counted integer NOT NULL CHECK(counted>=0),
 before_line_version bigint NOT NULL CHECK(before_line_version>0),after_line_version bigint NOT NULL CHECK(after_line_version>0 AND after_line_version::numeric=before_line_version::numeric+1),
 stocktake_version bigint NOT NULL CHECK(stocktake_version>0),result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),created_at timestamptz NOT NULL,
 UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,engine,stocktake_id,line_id,id),UNIQUE(tenant_id,engine,line_id,after_line_version),
 FOREIGN KEY(tenant_id,wms_stocktake_id,wms_line_id) REFERENCES wms_stocktake_lines(tenant_id,stocktake_id,id),
 FOREIGN KEY(tenant_id,wms_line_id,product_id) REFERENCES wms_stocktake_lines(tenant_id,id,product_id),
 FOREIGN KEY(tenant_id,wms_stocktake_id,wms_measurement_id) REFERENCES wms_stocktake_measurements(tenant_id,stocktake_id,id),
 FOREIGN KEY(tenant_id,quantity_stocktake_id,quantity_line_id) REFERENCES stocktake_lines(tenant_id,stocktake_id,id),
 FOREIGN KEY(tenant_id,quantity_line_id,product_id) REFERENCES stocktake_lines(tenant_id,id,product_id),
 FOREIGN KEY(tenant_id,quantity_stocktake_id,quantity_measurement_id) REFERENCES stocktake_measurements(tenant_id,stocktake_id,id),
 FOREIGN KEY(tenant_id,lot_id,product_id) REFERENCES wms_lots(tenant_id,id,product_id),
 FOREIGN KEY(tenant_id,engine,stocktake_id,line_id,generation_id) REFERENCES stocktake_scan_receipts(tenant_id,engine,stocktake_id,line_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,engine,stocktake_id,line_id,prior_scan_id) REFERENCES stocktake_scan_receipts(tenant_id,engine,stocktake_id,line_id,id),
 CHECK((engine='wms' AND wms_stocktake_id IS NOT NULL AND wms_line_id IS NOT NULL AND wms_measurement_id IS NOT NULL AND quantity_stocktake_id IS NULL AND quantity_line_id IS NULL AND quantity_measurement_id IS NULL)
 OR (engine='quantity' AND quantity_stocktake_id IS NOT NULL AND quantity_line_id IS NOT NULL AND quantity_measurement_id IS NOT NULL AND wms_stocktake_id IS NULL AND wms_line_id IS NULL AND wms_measurement_id IS NULL AND lot_id IS NULL AND lot_snapshot IS NULL AND counted<=1000000)),
 CHECK((kind='start' AND generation_id=id AND prior_scan_id IS NULL AND counted=0) OR (kind='increment' AND generation_id<>id AND prior_scan_id IS NOT NULL AND previous_count IS NOT NULL AND counted::numeric=previous_count::numeric+1)),
 CHECK(octet_length(request::text)+octet_length(result::text)+octet_length(source_snapshot::text)<=16384)
);
CREATE INDEX stocktake_scan_receipts_page ON stocktake_scan_receipts(tenant_id,engine,stocktake_id,created_at DESC,id DESC);
CREATE INDEX stocktake_scan_receipts_line ON stocktake_scan_receipts(tenant_id,engine,stocktake_id,line_id,after_line_version DESC);
ALTER TABLE stocktake_scan_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stocktake_scan_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON stocktake_scan_receipts TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON stocktake_scan_receipts TO dyna_app;
CREATE FUNCTION stocktake_scan_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Dowód skanu jest niezmienny' USING ERRCODE='23514'; END $$;
CREATE TRIGGER stocktake_scan_immutable BEFORE UPDATE OR DELETE ON stocktake_scan_receipts FOR EACH ROW EXECUTE FUNCTION stocktake_scan_immutable();
CREATE FUNCTION stocktake_scan_scope_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h record;l record;m record;p record;g record;product record;f jsonb;expected_result jsonb;matched text;matches text[];parent_id uuid;line_uuid uuid;measurement_uuid uuid;prior_scope text;intervening numeric;internal_hex text;internal_key uuid;
BEGIN
 prior_scope=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
 parent_id=coalesce(NEW.wms_stocktake_id,NEW.quantity_stocktake_id);line_uuid=coalesce(NEW.wms_line_id,NEW.quantity_line_id);measurement_uuid=coalesce(NEW.wms_measurement_id,NEW.quantity_measurement_id);
 IF NEW.engine='wms' THEN
  SELECT * INTO h FROM wms_stocktakes WHERE (tenant_id,id)=(NEW.tenant_id,NEW.wms_stocktake_id);
  SELECT * INTO l FROM wms_stocktake_lines WHERE (tenant_id,id)=(NEW.tenant_id,NEW.wms_line_id);
  SELECT * INTO m FROM wms_stocktake_measurements WHERE (tenant_id,id)=(NEW.tenant_id,NEW.wms_measurement_id);

 ELSE
  SELECT * INTO h FROM stocktakes WHERE (tenant_id,id)=(NEW.tenant_id,NEW.quantity_stocktake_id);
  SELECT * INTO l FROM stocktake_lines WHERE (tenant_id,id)=(NEW.tenant_id,NEW.quantity_line_id);
  SELECT * INTO m FROM stocktake_measurements WHERE (tenant_id,id)=(NEW.tenant_id,NEW.quantity_measurement_id);
 END IF;
 -- Leave missing/foreign parents to genuine composite FK enforcement, not a disguised guard error.
 IF h.id IS NULL OR l.id IS NULL OR m.id IS NULL OR l.stocktake_id IS DISTINCT FROM parent_id OR m.stocktake_id IS DISTINCT FROM parent_id OR l.product_id IS DISTINCT FROM NEW.product_id THEN
  PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NEW;
 END IF;
 IF NEW.engine='wms' THEN
  IF m.kind IS DISTINCT FROM 'count' OR l.lot_id IS DISTINCT FROM NEW.lot_id OR l.lot IS DISTINCT FROM NEW.lot_snapshot THEN RAISE EXCEPTION 'Niezgodna partia lub pomiar skanu' USING ERRCODE='23514';END IF;
 END IF;
 IF h.state IS DISTINCT FROM 'counting' OR l.product_id IS DISTINCT FROM NEW.product_id OR l.location IS DISTINCT FROM NEW.location OR m.actor_id IS DISTINCT FROM NEW.actor_id OR m.client_key::text IS DISTINCT FROM NEW.source_snapshot->>'measurement_client_key' OR m.stocktake_id IS DISTINCT FROM parent_id THEN RAISE EXCEPTION 'Niezgodny zakres skanu' USING ERRCODE='23514';END IF;
 SELECT value INTO f FROM jsonb_array_elements(m.result->'lines') WHERE value->>'line_id'=line_uuid::text;
 IF f IS NULL OR f->>'counted' IS DISTINCT FROM NEW.counted::text OR f->>'before_version' IS DISTINCT FROM NEW.before_line_version::text OR f->>'version' IS DISTINCT FROM NEW.after_line_version::text OR f->>'basis_hash' IS DISTINCT FROM NEW.basis_hash OR (f->>'previous_count')::integer IS DISTINCT FROM NEW.previous_count OR m.result->>'version' IS DISTINCT FROM NEW.stocktake_version::text THEN RAISE EXCEPTION 'Wynik skanu nie odpowiada pomiarowi' USING ERRCODE='23514';END IF;
 -- The internal measurement key cannot be repurposed from an unrelated absolute count.
 internal_hex=encode(sha256(convert_to(format('["stocktake-scan-count","%s","%s","%s","%s"]',NEW.tenant_id,NEW.engine,NEW.kind,NEW.client_key),'UTF8')),'hex');
 internal_key=(substr(internal_hex,1,8)||'-'||substr(internal_hex,9,4)||'-5'||substr(internal_hex,14,3)||'-a'||substr(internal_hex,18,3)||'-'||substr(internal_hex,21,12))::uuid;
 IF m.client_key IS DISTINCT FROM internal_key OR NEW.source_snapshot->>'measurement_created_at' IS NULL OR (NEW.source_snapshot->>'measurement_created_at')::timestamptz IS DISTINCT FROM m.created_at THEN RAISE EXCEPTION 'Niezgodne źródło pomiaru skanu' USING ERRCODE='23514';END IF;
 IF NEW.request->>'line_id' IS DISTINCT FROM line_uuid::text OR NEW.request->>'client_key' IS DISTINCT FROM NEW.client_key::text OR NEW.request->>'version' IS DISTINCT FROM NEW.before_line_version::text OR NEW.request->>'code' IS DISTINCT FROM NEW.code OR NEW.request->>'location' IS DISTINCT FROM NEW.location THEN RAISE EXCEPTION 'Niezgodna zgoda skanu' USING ERRCODE='23514';END IF;
 IF NEW.kind='start' THEN
  IF NEW.request->>'confirmed_zero' IS DISTINCT FROM 'true' OR (NEW.previous_count IS NOT NULL AND NEW.request->>'confirmed_reset' IS DISTINCT FROM 'true') THEN RAISE EXCEPTION 'Brak zgody na zerowanie' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO p FROM stocktake_scan_receipts WHERE (tenant_id,id)=(NEW.tenant_id,NEW.prior_scan_id);
  SELECT * INTO g FROM stocktake_scan_receipts WHERE (tenant_id,id)=(NEW.tenant_id,NEW.generation_id);
  IF p.id IS NULL OR g.id IS NULL OR (p.engine,p.stocktake_id,p.line_id) IS DISTINCT FROM (NEW.engine,parent_id,line_uuid) OR (g.engine,g.stocktake_id,g.line_id) IS DISTINCT FROM (NEW.engine,parent_id,line_uuid) THEN
   PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NEW;
  END IF;
  -- A review/reopen leaves a header-version gap; unrelated genuine counts do not.
  IF NEW.engine='wms' THEN
   SELECT count(DISTINCT result->>'version') INTO intervening FROM wms_stocktake_measurements WHERE tenant_id=NEW.tenant_id AND stocktake_id=parent_id AND kind='count' AND CASE WHEN result->>'version' ~ '^[1-9][0-9]{0,18}$' THEN (result->>'version')::numeric>p.stocktake_version AND (result->>'version')::numeric<NEW.stocktake_version ELSE false END;
  ELSE
   SELECT count(DISTINCT result->>'version') INTO intervening FROM stocktake_measurements WHERE tenant_id=NEW.tenant_id AND stocktake_id=parent_id AND CASE WHEN result->>'version' ~ '^[1-9][0-9]{0,18}$' THEN (result->>'version')::numeric>p.stocktake_version AND (result->>'version')::numeric<NEW.stocktake_version ELSE false END;
  END IF;
  IF NEW.engine='wms' AND EXISTS(SELECT 1 FROM wms_stocktake_measurements WHERE tenant_id=NEW.tenant_id AND stocktake_id=parent_id AND kind='reopen' AND (result->>'version')::numeric>p.stocktake_version) THEN RAISE EXCEPTION 'Generacja została ponownie otwarta' USING ERRCODE='23514';END IF;
  IF intervening IS DISTINCT FROM (NEW.stocktake_version::numeric-p.stocktake_version::numeric-1) THEN RAISE EXCEPTION 'Generacja została zamknięta lub ponownie otwarta' USING ERRCODE='23514';END IF;
  IF p.generation_id IS DISTINCT FROM NEW.generation_id OR g.kind IS DISTINCT FROM 'start' OR p.after_line_version IS DISTINCT FROM NEW.before_line_version OR p.counted IS DISTINCT FROM NEW.previous_count OR p.basis_hash IS DISTINCT FROM NEW.basis_hash OR NEW.request->>'increment' IS DISTINCT FROM '1' OR NEW.request->>'generation_id' IS DISTINCT FROM NEW.generation_id::text THEN RAISE EXCEPTION 'Przerwana generacja skanów' USING ERRCODE='23514';END IF;
 END IF;
 SELECT sku INTO matched FROM product_sku_aliases WHERE (tenant_id,product_id,sku)=(NEW.tenant_id,NEW.product_id,NEW.code);
 SELECT * INTO product FROM products WHERE (tenant_id,id)=(NEW.tenant_id,NEW.product_id);
 matches=array_remove(ARRAY[CASE WHEN NEW.code=l.sku THEN 'frozen_sku' END,CASE WHEN NEW.code=product.sku THEN 'current_sku' END,CASE WHEN matched IS NOT NULL THEN 'sku_alias' END,CASE WHEN product.ean<>'' AND NEW.code=product.ean THEN 'current_ean' END],NULL);
 IF cardinality(matches)=0 OR to_jsonb(matches) IS DISTINCT FROM NEW.matched_by OR NEW.source_snapshot->>'product_id' IS DISTINCT FROM NEW.product_id::text OR NEW.source_snapshot->>'product_version' IS DISTINCT FROM product.version::text OR NEW.source_snapshot->>'current_sku' IS DISTINCT FROM product.sku OR NEW.source_snapshot->>'current_ean' IS DISTINCT FROM product.ean THEN RAISE EXCEPTION 'Kod nie wskazuje pozycji' USING ERRCODE='23514';END IF;
 expected_result=jsonb_build_object('id',NEW.id,'stocktake_id',parent_id,'engine',NEW.engine,'line_id',line_uuid,'product_id',NEW.product_id,'location',NEW.location,'lot',NEW.lot_snapshot,'kind',NEW.kind,'generation_id',NEW.generation_id,'code',NEW.code,'matched_by',NEW.matched_by,'previous_count',NEW.previous_count,'counted',NEW.counted,'increment',CASE WHEN NEW.kind='start' THEN 0 ELSE 1 END,'before_line_version',NEW.before_line_version::text,'after_line_version',NEW.after_line_version::text,'measurement_id',measurement_uuid,'stocktake_version',NEW.stocktake_version::text,'created_at',NEW.result->>'created_at');
 IF NEW.result IS DISTINCT FROM expected_result OR (NEW.result->>'created_at')::timestamptz IS DISTINCT FROM NEW.created_at THEN RAISE EXCEPTION 'Niezgodny immutable wynik skanu' USING ERRCODE='23514';END IF;
 IF (SELECT coalesce(sum(CASE WHEN octet_length(ch)>3 THEN 2 ELSE 1 END),0) FROM regexp_split_to_table(NEW.code,'') ch)>80 THEN RAISE EXCEPTION 'Kod przekracza 80 jednostek UTF-16' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;END $$;
CREATE TRIGGER stocktake_scan_scope_guard BEFORE INSERT ON stocktake_scan_receipts FOR EACH ROW EXECUTE FUNCTION stocktake_scan_scope_guard();
CREATE FUNCTION stocktake_scan_final_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE l record;h record;product record;prior_scope text;
BEGIN
 prior_scope=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
 IF NEW.engine='wms' THEN
  SELECT * INTO l FROM wms_stocktake_lines WHERE (tenant_id,id)=(NEW.tenant_id,NEW.wms_line_id);
  SELECT * INTO h FROM wms_stocktakes WHERE (tenant_id,id)=(NEW.tenant_id,NEW.wms_stocktake_id);
  IF l.latest_measurement_id IS DISTINCT FROM NEW.measurement_id THEN RAISE EXCEPTION 'Brak końcowego pomiaru skanu' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO l FROM stocktake_lines WHERE (tenant_id,id)=(NEW.tenant_id,NEW.quantity_line_id);
  SELECT * INTO h FROM stocktakes WHERE (tenant_id,id)=(NEW.tenant_id,NEW.quantity_stocktake_id);
 END IF;
 SELECT * INTO product FROM products WHERE (tenant_id,id)=(NEW.tenant_id,NEW.product_id);
 IF NEW.source_snapshot->>'product_version' IS DISTINCT FROM product.version::text OR NEW.source_snapshot->>'current_sku' IS DISTINCT FROM product.sku OR NEW.source_snapshot->>'current_ean' IS DISTINCT FROM product.ean THEN RAISE EXCEPTION 'Kod zmienił się przed zatwierdzeniem skanu' USING ERRCODE='23514';END IF;
 IF h.state IS DISTINCT FROM 'counting' OR h.version IS DISTINCT FROM NEW.stocktake_version OR l.version IS DISTINCT FROM NEW.after_line_version OR l.counted IS DISTINCT FROM NEW.counted THEN RAISE EXCEPTION 'Skan nie odpowiada końcowemu stanowi pomiaru' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;END $$;
CREATE CONSTRAINT TRIGGER stocktake_scan_final_guard AFTER INSERT ON stocktake_scan_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stocktake_scan_final_guard();
-- Old quantity measurements keep their layout; only scan-linked evidence gains immutable protection.
CREATE FUNCTION stocktake_scan_measurement_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prior_scope text;
BEGIN
 prior_scope=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',OLD.tenant_id::text,true);
 IF EXISTS(SELECT 1 FROM stocktake_scan_receipts WHERE tenant_id=OLD.tenant_id AND quantity_measurement_id=OLD.id) THEN RAISE EXCEPTION 'Pomiar skanu jest niezmienny' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN OLD;END IF;PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NEW;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;END $$;
CREATE TRIGGER stocktake_scan_measurement_guard BEFORE UPDATE OR DELETE ON stocktake_measurements FOR EACH ROW EXECUTE FUNCTION stocktake_scan_measurement_guard();
REVOKE ALL ON FUNCTION stocktake_scan_immutable(),stocktake_scan_scope_guard(),stocktake_scan_final_guard(),stocktake_scan_measurement_guard() FROM PUBLIC;
