CREATE TABLE wms_stocktakes (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,warehouse_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,request_hash text NOT NULL,
 request jsonb NOT NULL,scope_hash text NOT NULL,policy_version bigint NOT NULL CHECK(policy_version>0),currency text NOT NULL,
 name text NOT NULL,blind boolean NOT NULL,state text NOT NULL DEFAULT 'counting' CHECK(state IN ('counting','review','posted','cancelled')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),last_review_id uuid,posting_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE UNIQUE INDEX wms_stocktake_active ON wms_stocktakes(tenant_id,warehouse_id) WHERE state IN ('counting','review');
CREATE INDEX wms_stocktakes_page ON wms_stocktakes(tenant_id,created_at DESC,id DESC);
CREATE TABLE wms_stocktake_lines (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,stocktake_id uuid NOT NULL,product_id uuid NOT NULL,location text NOT NULL,
 lot_id uuid,lot jsonb NOT NULL,sku text NOT NULL,name text NOT NULL,original jsonb NOT NULL,
 counted integer CHECK(counted>=0),version bigint NOT NULL DEFAULT 1 CHECK(version>0),latest_measurement_id uuid,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,product_id),UNIQUE(tenant_id,stocktake_id,id),
 FOREIGN KEY(tenant_id,stocktake_id) REFERENCES wms_stocktakes(tenant_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 FOREIGN KEY(tenant_id,lot_id,product_id) REFERENCES wms_lots(tenant_id,id,product_id),
 CHECK((counted IS NULL)=(latest_measurement_id IS NULL))
);
CREATE UNIQUE INDEX wms_stocktake_physical ON wms_stocktake_lines(tenant_id,stocktake_id,product_id,location,lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX wms_stocktake_lines_page ON wms_stocktake_lines(tenant_id,stocktake_id,id);
CREATE TABLE wms_stocktake_scope_layers (
 tenant_id uuid NOT NULL,stocktake_id uuid NOT NULL,line_id uuid NOT NULL,product_id uuid NOT NULL,layer_id uuid NOT NULL,original jsonb NOT NULL,
 PRIMARY KEY(tenant_id,stocktake_id,line_id,layer_id),
 FOREIGN KEY(tenant_id,stocktake_id,line_id) REFERENCES wms_stocktake_lines(tenant_id,stocktake_id,id),
 FOREIGN KEY(tenant_id,line_id,product_id) REFERENCES wms_stocktake_lines(tenant_id,id,product_id),
 FOREIGN KEY(tenant_id,layer_id,product_id) REFERENCES wms_cost_layers(tenant_id,id,product_id)
);
CREATE TABLE wms_stocktake_measurements (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,stocktake_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 client_key uuid NOT NULL,request_hash text NOT NULL,kind text NOT NULL CHECK(kind IN ('count','reopen','cancel')),
 request jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,stocktake_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,stocktake_id) REFERENCES wms_stocktakes(tenant_id,id)
);
ALTER TABLE wms_stocktake_lines ADD FOREIGN KEY(tenant_id,stocktake_id,latest_measurement_id) REFERENCES wms_stocktake_measurements(tenant_id,stocktake_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE wms_stocktake_measurement_layers (
 tenant_id uuid NOT NULL,measurement_id uuid NOT NULL,stocktake_id uuid NOT NULL,line_id uuid NOT NULL,product_id uuid NOT NULL,layer_id uuid NOT NULL,basis jsonb NOT NULL,
 PRIMARY KEY(tenant_id,measurement_id,line_id,layer_id),
 FOREIGN KEY(tenant_id,stocktake_id,measurement_id) REFERENCES wms_stocktake_measurements(tenant_id,stocktake_id,id),
 FOREIGN KEY(tenant_id,stocktake_id,line_id) REFERENCES wms_stocktake_lines(tenant_id,stocktake_id,id),
 FOREIGN KEY(tenant_id,line_id,product_id) REFERENCES wms_stocktake_lines(tenant_id,id,product_id),
 FOREIGN KEY(tenant_id,layer_id,product_id) REFERENCES wms_cost_layers(tenant_id,id,product_id)
);
CREATE TABLE wms_stocktake_reviews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,stocktake_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,stocktake_version bigint NOT NULL CHECK(stocktake_version>0),
 scope_hash text NOT NULL,summary jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,stocktake_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,stocktake_id) REFERENCES wms_stocktakes(tenant_id,id)
);
CREATE TABLE wms_stocktake_review_rows (
 tenant_id uuid NOT NULL,review_id uuid NOT NULL,stocktake_id uuid NOT NULL,line_id uuid NOT NULL,product_id uuid NOT NULL,
 before jsonb NOT NULL,after jsonb NOT NULL,fragments jsonb NOT NULL,basis_hash text NOT NULL,
 PRIMARY KEY(tenant_id,review_id,line_id),
 FOREIGN KEY(tenant_id,stocktake_id,review_id) REFERENCES wms_stocktake_reviews(tenant_id,stocktake_id,id),
 FOREIGN KEY(tenant_id,stocktake_id,line_id) REFERENCES wms_stocktake_lines(tenant_id,stocktake_id,id),
 FOREIGN KEY(tenant_id,line_id,product_id) REFERENCES wms_stocktake_lines(tenant_id,id,product_id)
);
CREATE TABLE wms_stocktake_postings (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,stocktake_id uuid NOT NULL,review_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,operation_id uuid NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,stocktake_id,id),UNIQUE(tenant_id,stocktake_id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,stocktake_id,review_id) REFERENCES wms_stocktake_reviews(tenant_id,stocktake_id,id),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES wms_operations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE wms_stocktakes ADD FOREIGN KEY(tenant_id,id,last_review_id) REFERENCES wms_stocktake_reviews(tenant_id,stocktake_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE wms_stocktakes ADD FOREIGN KEY(tenant_id,id,posting_id) REFERENCES wms_stocktake_postings(tenant_id,stocktake_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE wms_operations ADD COLUMN stocktake_id uuid,ADD COLUMN stocktake_posting_id uuid,ADD COLUMN stocktake_review_id uuid;
ALTER TABLE wms_operations ADD FOREIGN KEY(tenant_id,stocktake_id) REFERENCES wms_stocktakes(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE wms_operations ADD FOREIGN KEY(tenant_id,stocktake_id,stocktake_posting_id) REFERENCES wms_stocktake_postings(tenant_id,stocktake_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE wms_operations ADD FOREIGN KEY(tenant_id,stocktake_id,stocktake_review_id) REFERENCES wms_stocktake_reviews(tenant_id,stocktake_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE wms_cost_layers ADD COLUMN stocktake_line_id uuid;
ALTER TABLE wms_cost_layers ADD FOREIGN KEY(tenant_id,stocktake_line_id,product_id) REFERENCES wms_stocktake_lines(tenant_id,id,product_id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION wms_stocktake_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Dowód spisu jest niezmienny' USING ERRCODE='23514'; END $$;
CREATE FUNCTION wms_stocktake_mutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h record;m record;f jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Nie można usuwać spisu' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='wms_stocktakes' THEN
  IF TG_OP='UPDATE' THEN
   IF OLD.state IN ('posted','cancelled') OR NEW.version<>OLD.version+1 OR
    (to_jsonb(NEW)-ARRAY['version','state','last_review_id','posting_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','state','last_review_id','posting_id']) THEN RAISE EXCEPTION 'Niezgodna zmiana spisu' USING ERRCODE='23514'; END IF;
   IF (NEW.state='posted')<>(NEW.posting_id IS NOT NULL) THEN RAISE EXCEPTION 'Brak dowodu rozliczenia' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  SELECT state INTO h FROM wms_stocktakes WHERE (tenant_id,id)=(NEW.tenant_id,NEW.stocktake_id) FOR SHARE;
  IF h.state IS DISTINCT FROM 'counting' THEN RAISE EXCEPTION 'Pomiar wymaga otwartego spisu' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
   SELECT * INTO m FROM wms_stocktake_measurements WHERE (tenant_id,id,stocktake_id)=(NEW.tenant_id,NEW.latest_measurement_id,NEW.stocktake_id);
   IF NOT FOUND OR m.kind<>'count' THEN RAISE EXCEPTION 'Brak dowodu pomiaru' USING ERRCODE='23514'; END IF;
   SELECT value INTO f FROM jsonb_array_elements(m.result->'lines') WHERE value->>'line_id'=NEW.id::text;
   IF NOT FOUND OR f->>'version' IS DISTINCT FROM NEW.version::text OR f->>'counted' IS DISTINCT FROM NEW.counted::text THEN RAISE EXCEPTION 'Wynik nie odpowiada pomiarowi' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.version<>OLD.version+1 OR
   (to_jsonb(NEW)-ARRAY['counted','version','latest_measurement_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['counted','version','latest_measurement_id'])) THEN RAISE EXCEPTION 'Zakres spisu jest niezmienny' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wms_stocktake_head_guard BEFORE UPDATE OR DELETE ON wms_stocktakes FOR EACH ROW EXECUTE FUNCTION wms_stocktake_mutable_guard();
CREATE TRIGGER wms_stocktake_line_guard BEFORE INSERT OR UPDATE OR DELETE ON wms_stocktake_lines FOR EACH ROW EXECUTE FUNCTION wms_stocktake_mutable_guard();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['wms_stocktakes','wms_stocktake_lines','wms_stocktake_scope_layers','wms_stocktake_measurements','wms_stocktake_measurement_layers','wms_stocktake_reviews','wms_stocktake_review_rows','wms_stocktake_postings'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
  IF t NOT IN ('wms_stocktakes','wms_stocktake_lines') THEN EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION wms_stocktake_immutable()',t); END IF;
 END LOOP;
END $$;
GRANT UPDATE ON wms_stocktakes,wms_stocktake_lines TO dyna_app;
CREATE INDEX wms_stocktake_measurements_page ON wms_stocktake_measurements(tenant_id,stocktake_id,created_at DESC,id DESC);
CREATE INDEX wms_stocktake_reviews_page ON wms_stocktake_reviews(tenant_id,stocktake_id,created_at DESC,id DESC);
CREATE FUNCTION wms_stocktake_evidence_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ln record;hd record;ly record;parent record;fragment jsonb;total numeric:=0;delta numeric;pos record;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid AND current_setting('role',true)='dyna_app' THEN RAISE EXCEPTION 'Obcy zakres spisu' USING ERRCODE='23514'; END IF;
 SELECT * INTO ln FROM wms_stocktake_lines WHERE (tenant_id,id)=(NEW.tenant_id,NEW.line_id);
 IF NOT FOUND THEN RAISE EXCEPTION 'Brak własnej pozycji spisu' USING ERRCODE='23514'; END IF;
 SELECT * INTO hd FROM wms_stocktakes WHERE (tenant_id,id)=(NEW.tenant_id,ln.stocktake_id);
 IF NEW.stocktake_id IS DISTINCT FROM ln.stocktake_id OR NEW.product_id IS DISTINCT FROM ln.product_id THEN RAISE EXCEPTION 'Niezgodna pozycja spisu' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME IN ('wms_stocktake_scope_layers','wms_stocktake_measurement_layers') THEN
  SELECT * INTO ly FROM wms_cost_layers WHERE (tenant_id,id,product_id)=(NEW.tenant_id,NEW.layer_id,ln.product_id);
  IF NOT FOUND OR ly.lot_id IS DISTINCT FROM ln.lot_id OR NOT EXISTS(SELECT 1 FROM wms_layer_positions p WHERE
   (p.tenant_id,p.warehouse_id,p.product_id,p.location,p.layer_id)=(NEW.tenant_id,hd.warehouse_id,ln.product_id,ln.location,NEW.layer_id)) THEN RAISE EXCEPTION 'Warstwa nie należy do policzonej partii i lokalizacji' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='wms_stocktake_scope_layers' THEN
   IF NOT (ln.original->'layer_ids' ? NEW.layer_id::text) OR NEW.original->>'layer_id' IS DISTINCT FROM NEW.layer_id::text THEN RAISE EXCEPTION 'Warstwa poza immutable scope' USING ERRCODE='23514'; END IF;
  ELSE
   SELECT * INTO parent FROM wms_stocktake_measurements WHERE (tenant_id,id,stocktake_id)=(NEW.tenant_id,NEW.measurement_id,ln.stocktake_id);
   IF NOT FOUND OR parent.kind<>'count' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(parent.result->'lines') f WHERE f->>'line_id'=ln.id::text)
    OR NEW.basis->>'layer_id' IS DISTINCT FROM NEW.layer_id::text OR NEW.basis->>'lot_id' IS DISTINCT FROM ln.lot_id::text
    OR NEW.basis->>'product_id' IS DISTINCT FROM ln.product_id::text OR NEW.basis->>'location' IS DISTINCT FROM ln.location
    OR NEW.basis->>'unit_cost_minor' IS DISTINCT FROM ly.unit_cost_minor::text OR NEW.basis->>'currency' IS DISTINCT FROM ly.currency THEN RAISE EXCEPTION 'Niezgodny dowód pomiaru warstwy' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  SELECT * INTO parent FROM wms_stocktake_reviews WHERE (tenant_id,id,stocktake_id)=(NEW.tenant_id,NEW.review_id,ln.stocktake_id);
  IF NOT FOUND OR NEW.basis_hash IS DISTINCT FROM NEW.before->>'basis_hash' OR jsonb_typeof(NEW.fragments) IS DISTINCT FROM 'array'
   OR jsonb_typeof(NEW.after->'quantity') IS DISTINCT FROM 'number' OR jsonb_typeof(NEW.before->'quantity') IS DISTINCT FROM 'number'
   OR jsonb_typeof(NEW.before->'reserved') IS DISTINCT FROM 'number'
   OR (NEW.after->>'quantity')::numeric IS DISTINCT FROM ln.counted::numeric
   OR (NEW.before->>'quantity')::numeric<0 OR (NEW.before->>'reserved')::numeric<0
   OR (NEW.before->>'quantity')::numeric<>trunc((NEW.before->>'quantity')::numeric)
   OR (NEW.before->>'reserved')::numeric<>trunc((NEW.before->>'reserved')::numeric) THEN RAISE EXCEPTION 'Niezgodny plan spisu' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(p.quantity),0) quantity,coalesce(sum(p.reserved),0) reserved INTO pos FROM wms_layer_positions p JOIN wms_cost_layers l ON (l.tenant_id,l.id,l.product_id)=(p.tenant_id,p.layer_id,p.product_id)
   WHERE (p.tenant_id,p.warehouse_id,p.product_id,p.location,l.lot_id)=(NEW.tenant_id,hd.warehouse_id,ln.product_id,ln.location,ln.lot_id);
  IF pos.quantity IS DISTINCT FROM (NEW.before->>'quantity')::numeric OR pos.reserved IS DISTINCT FROM (NEW.before->>'reserved')::numeric THEN RAISE EXCEPTION 'Plan nie odpowiada źródłowej ilości' USING ERRCODE='23514'; END IF;
  delta:=(NEW.after->>'quantity')::numeric-(NEW.before->>'quantity')::numeric;
  FOR fragment IN SELECT value FROM jsonb_array_elements(NEW.fragments) LOOP
   IF jsonb_typeof(fragment->'quantity') IS DISTINCT FROM 'number' OR jsonb_typeof(fragment->'delta') IS DISTINCT FROM 'number' OR (fragment->>'quantity')::numeric<=0 OR (fragment->>'quantity')::numeric<>trunc((fragment->>'quantity')::numeric)
    OR abs((fragment->>'delta')::numeric)<>(fragment->>'quantity')::numeric OR (fragment->>'currency') IS DISTINCT FROM hd.currency
    OR ((fragment->>'delta')::numeric>0) IS DISTINCT FROM (delta>0) THEN RAISE EXCEPTION 'Niezgodny fragment korekty' USING ERRCODE='23514'; END IF;
   total:=total+(fragment->>'delta')::numeric;
   IF fragment->>'layer_id' IS NULL THEN
    IF delta<=0 OR fragment->>'unit_cost_minor' IS NULL OR NOT ((fragment->>'unit_cost_minor') ~ '^(0|[1-9][0-9]{0,18})$')
     OR (fragment->>'unit_cost_minor')::numeric>9223372036854775807 THEN RAISE EXCEPTION 'Nadwyżka wymaga dokładnego kosztu' USING ERRCODE='23514'; END IF;
   ELSE
    SELECT * INTO ly FROM wms_cost_layers WHERE (tenant_id,id,product_id)=(NEW.tenant_id,(fragment->>'layer_id')::uuid,ln.product_id);
    IF NOT FOUND OR delta>=0 OR ly.lot_id IS DISTINCT FROM ln.lot_id OR fragment->>'unit_cost_minor' IS DISTINCT FROM ly.unit_cost_minor::text
     OR NOT (ln.original->'layer_ids' ? ly.id::text) THEN RAISE EXCEPTION 'Fragment poza partią lub kosztem źródłowym' USING ERRCODE='23514'; END IF;
    SELECT * INTO pos FROM wms_layer_positions WHERE (tenant_id,warehouse_id,product_id,location,layer_id)=(NEW.tenant_id,hd.warehouse_id,ln.product_id,ln.location,ly.id);
    IF NOT FOUND OR (fragment->>'quantity')::numeric>pos.quantity-pos.reserved THEN RAISE EXCEPTION 'Korekta narusza rezerwację warstwy' USING ERRCODE='23514'; END IF;
   END IF;
  END LOOP;
  IF total<>delta THEN RAISE EXCEPTION 'Fragmenty nie pokrywają różnicy spisu' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wms_stocktake_scope_bind BEFORE INSERT ON wms_stocktake_scope_layers FOR EACH ROW EXECUTE FUNCTION wms_stocktake_evidence_scope();
CREATE TRIGGER wms_stocktake_measurement_bind BEFORE INSERT ON wms_stocktake_measurement_layers FOR EACH ROW EXECUTE FUNCTION wms_stocktake_evidence_scope();
CREATE TRIGGER wms_stocktake_review_bind BEFORE INSERT ON wms_stocktake_review_rows FOR EACH ROW EXECUTE FUNCTION wms_stocktake_evidence_scope();
