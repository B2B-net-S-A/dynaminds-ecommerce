-- Optional photos attach to immutable packing receipts; they never replace one.
CREATE TABLE packing_photos (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants,
 receipt_id uuid NOT NULL, order_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users,
 client_key uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 filename text NOT NULL CHECK(char_length(filename) BETWEEN 1 AND 120 AND filename !~ '[[:cntrl:]/\\]'),
 mime_type text NOT NULL CHECK(mime_type='image/png'),
 byte_count integer NOT NULL CHECK(byte_count BETWEEN 1 AND 524288),
 file_hash text NOT NULL CHECK(file_hash ~ '^[a-f0-9]{64}$'),
 encrypted_bytes text NOT NULL CHECK(octet_length(encrypted_bytes) BETWEEN 1 AND 1000000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,receipt_id,order_id,actor_id,file_hash),
 UNIQUE(tenant_id,actor_id,client_key),
 FOREIGN KEY(tenant_id,receipt_id,order_id) REFERENCES packing_receipts(tenant_id,id,order_id)
);
CREATE INDEX packing_photos_receipt ON packing_photos(tenant_id,receipt_id,created_at,id);
CREATE TABLE packing_photo_confirmations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants,
 photo_id uuid NOT NULL, receipt_id uuid NOT NULL, order_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users, client_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 file_hash text NOT NULL CHECK(file_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,photo_id), UNIQUE(tenant_id,actor_id,client_key),
 FOREIGN KEY(tenant_id,photo_id,receipt_id,order_id,actor_id,file_hash)
 REFERENCES packing_photos(tenant_id,id,receipt_id,order_id,actor_id,file_hash)
);
CREATE FUNCTION packing_photo_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Zdjęcia i potwierdzenia pakowania są niezmienne' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('packing.photos:'||NEW.tenant_id,0));
 r:=public.packing_current_role(NEW.actor_id,true);
 IF r IS DISTINCT FROM 'admin' AND r IS DISTINCT FROM 'operator'
 THEN RAISE EXCEPTION 'Brak uprawnień do zdjęć pakowania' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION packing_photo_budget_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT count(*) FROM packing_photos WHERE tenant_id=NEW.tenant_id)>1000
 OR (SELECT coalesce(sum(octet_length(encrypted_bytes)),0) FROM packing_photos WHERE tenant_id=NEW.tenant_id)>104857600
 OR (SELECT count(*) FROM packing_photos WHERE tenant_id=NEW.tenant_id AND receipt_id=NEW.receipt_id)>20
 THEN RAISE EXCEPTION 'Limit zdjęć: 20 na dowód, 1000 / 100 MiB zaszyfrowanych danych na firmę' USING ERRCODE='P0001'; END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['packing_photos','packing_photo_confirmations'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
 EXECUTE format('CREATE TRIGGER packing_photo_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION packing_photo_guard()',t);
END LOOP; END $$;
CREATE TRIGGER packing_photo_budget_guard AFTER INSERT ON packing_photos FOR EACH ROW EXECUTE FUNCTION packing_photo_budget_guard();
REVOKE ALL ON FUNCTION packing_photo_guard(),packing_photo_budget_guard() FROM PUBLIC;
