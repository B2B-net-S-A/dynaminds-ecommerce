-- Extend the existing API vocabulary; all17previous scopes remain accepted.
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check1;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check CHECK(cardinality(scopes)>=1 AND cardinality(scopes)<=19);
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check1 CHECK(scopes <@ ARRAY['orders:read','orders:write','products:read','products:write','inventory:read','inventory:write','documents:read','documents:write','purchasing:read','purchasing:write','automations:read','automations:write','communications:read','communications:write','order-fields:read','order-fields:write','order-fields:admin','integrations:read','integrations:write']::text[]);
-- New imports only. Installed106/109 histories and hashes are never rewritten.
CREATE TABLE b2b_external_import_previews(
 tenant_id uuid NOT NULL,id uuid PRIMARY KEY,inbound_id uuid NOT NULL,channel_id uuid NOT NULL,
 actor_id uuid NOT NULL,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'),initial_request jsonb NOT NULL,
 scope_hash text NOT NULL CHECK(scope_hash~'^[0-9a-f]{64}$'),version integer NOT NULL DEFAULT 1 CHECK(version=1),
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 rows jsonb NOT NULL CHECK(jsonb_typeof(rows)='array' AND jsonb_array_length(rows)>=1 AND jsonb_array_length(rows)<=100),
 raw_hash text NOT NULL DEFAULT '' CHECK(raw_hash~'^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT(clock_timestamp()+interval '30 minutes'),
 byte_count bigint NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,inbound_id) REFERENCES inbound_orders(tenant_id,id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),
 FOREIGN KEY(actor_id) REFERENCES users(id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE b2b_external_import_certificates(
 tenant_id uuid NOT NULL,id uuid PRIMARY KEY,preview_id uuid NOT NULL,actor_id uuid NOT NULL,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,
 transaction_id xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,
 actual_order_id uuid,state text NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','certified','complete')),
 intent_id uuid,source_items jsonb,physical_snapshot jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count bigint NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,actual_order_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES b2b_external_import_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,actual_order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,intent_id) REFERENCES b2b_external_order_intents(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(actor_id) REFERENCES users(id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE b2b_external_import_executions(
 tenant_id uuid NOT NULL,id uuid PRIMARY KEY,preview_id uuid NOT NULL,inbound_id uuid NOT NULL,
 certificate_id uuid NOT NULL,order_id uuid NOT NULL,intent_id uuid NOT NULL,actor_id uuid NOT NULL,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'),request jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count bigint NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,order_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES b2b_external_import_previews(tenant_id,id),FOREIGN KEY(tenant_id,inbound_id) REFERENCES inbound_orders(tenant_id,id),
 FOREIGN KEY(tenant_id,certificate_id) REFERENCES b2b_external_import_certificates(tenant_id,id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,intent_id) REFERENCES b2b_external_order_intents(tenant_id,id),FOREIGN KEY(actor_id) REFERENCES users(id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX external_import_preview_history ON b2b_external_import_previews(tenant_id,id);
CREATE INDEX external_import_preview_source ON b2b_external_import_previews(tenant_id,inbound_id,id);
CREATE INDEX external_import_execution_source ON b2b_external_import_executions(tenant_id,inbound_id,id);
CREATE INDEX external_import_certificate_tx ON b2b_external_import_certificates(tenant_id,transaction_id,transaction_started_at,state);
DO $$DECLARE n text;BEGIN FOREACH n IN ARRAY ARRAY['b2b_external_import_previews','b2b_external_import_executions','b2b_external_import_certificates'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',n);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY owner ON %I TO CURRENT_USER USING(true) WITH CHECK(true)',n);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',n);
 EXECUTE format('CREATE TRIGGER bytes BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION b2b_dropship_bytes()',n);
 IF n<>'b2b_external_import_certificates' THEN
 EXECUTE format('CREATE POLICY own ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',n);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',n);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION b2b_dropship_immutable()',n);END IF;
 END LOOP;END $$;
CREATE FUNCTION b2b_external_import_key_grant(uid uuid,kid uuid,writing boolean,pin boolean DEFAULT false) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;k record;BEGIN
 IF kid IS NULL THEN RETURN 'ok';END IF;
 IF pin THEN SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid FOR SHARE;ELSE SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid;END IF;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR (k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN RETURN 'invalid';END IF;
 IF NOT k.scopes @> ARRAY['integrations:read']::text[] OR (writing AND NOT k.scopes @> ARRAY['integrations:write']::text[]) THEN RETURN 'insufficient';END IF;
 RETURN 'ok';END $$;
REVOKE ALL ON FUNCTION b2b_external_import_key_grant(uuid,uuid,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_external_import_key_grant(uuid,uuid,boolean,boolean) TO dyna_app;
CREATE FUNCTION b2b_external_import_preview_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s inbound_orders%ROWTYPE;ch channels%ROWTYPE;r jsonb;line_doc jsonb;item_doc jsonb;p products%ROWTYPE;m listings%ROWTYPE;n integer;remote_id text;expected_components jsonb;BEGIN
 SELECT * INTO s FROM inbound_orders WHERE tenant_id=NEW.tenant_id AND id=NEW.inbound_id;
 SELECT * INTO ch FROM channels WHERE tenant_id=NEW.tenant_id AND id=NEW.channel_id;
 IF s.id IS NULL OR ch.id IS NULL THEN RETURN NEW;END IF;
 IF s.order_id IS NOT NULL OR s.channel_id IS DISTINCT FROM NEW.channel_id OR NEW.snapshot->'source'->>'source_hash' IS DISTINCT FROM s.source_hash
 OR NEW.initial_request->>'expected_source_hash' IS DISTINCT FROM s.source_hash OR NEW.config->'warehouse_id' IS DISTINCT FROM NEW.initial_request->'warehouse_id'
 OR NEW.config->'allocations' IS DISTINCT FROM NEW.initial_request->'allocations'
 OR NEW.snapshot->'source'->>'provider' IS DISTINCT FROM ch.provider OR NEW.snapshot->'canonical'->>'external_id' IS DISTINCT FROM s.external_id
 OR (NEW.snapshot->'canonical')-'items' IS DISTINCT FROM (s.normalized-'items')
 OR jsonb_typeof(s.normalized->'items') IS DISTINCT FROM 'array'
 OR jsonb_array_length(NEW.rows) IS DISTINCT FROM jsonb_array_length(s.normalized->'items')
 OR jsonb_array_length(NEW.rows) IS DISTINCT FROM jsonb_array_length(NEW.snapshot->'canonical'->'items') THEN RAISE EXCEPTION 'Niezgodne źródło podglądu importu' USING ERRCODE='23514';END IF;
 IF b2b_dropship_current_role(NEW.actor_id,false) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Brak aktualnej zgody administratora' USING ERRCODE='23514';END IF;
 NEW.raw_hash:=encode(sha256(convert_to(s.raw::text,'UTF8')),'hex');
 IF (SELECT count(DISTINCT x->>'customer_item_id') FROM jsonb_array_elements(NEW.rows) x)<>jsonb_array_length(NEW.rows)
 OR (SELECT count(DISTINCT x->>'remote_line_id') FROM jsonb_array_elements(NEW.rows) x)<>jsonb_array_length(NEW.rows) THEN RAISE EXCEPTION 'Powtórzone fragmenty importu' USING ERRCODE='23514';END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(NEW.rows) LOOP
 IF jsonb_typeof(r->'source_index') IS DISTINCT FROM 'number' OR coalesce(r->>'source_index','')!~'^(0|[1-9][0-9]{0,2})$'
 OR jsonb_typeof(r->'customer_item_id') IS DISTINCT FROM 'string' OR coalesce(r->>'customer_item_id','')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
 OR jsonb_typeof(r->'local_quantity') IS DISTINCT FROM 'number' OR coalesce(r->>'local_quantity','')!~'^(0|[1-9][0-9]{0,5})$'
 OR jsonb_typeof(r->'external_quantity') IS DISTINCT FROM 'number' OR coalesce(r->>'external_quantity','')!~'^(0|[1-9][0-9]{0,5})$'
 OR jsonb_typeof(r->'unassigned_quantity') IS DISTINCT FROM 'number' OR coalesce(r->>'unassigned_quantity','')!~'^(0|[1-9][0-9]{0,5})$' THEN RAISE EXCEPTION 'Nieprawidłowy przydział źródłowy' USING ERRCODE='23514';END IF;
 SELECT value INTO item_doc FROM jsonb_array_elements(NEW.config->'allocations') WHERE value->>'remote_line_id'=r->>'remote_line_id';
 IF item_doc IS NULL OR item_doc->'local_quantity' IS DISTINCT FROM r->'local_quantity' OR item_doc->'external_quantity' IS DISTINCT FROM r->'external_quantity' OR item_doc->'unassigned_quantity' IS DISTINCT FROM r->'unassigned_quantity' OR item_doc->'link_id' IS DISTINCT FROM r->'link_id' THEN RAISE EXCEPTION 'Przydział różni się od zatwierdzonego żądania' USING ERRCODE='23514';END IF;
 n:=(r->>'source_index')::integer;line_doc:=NEW.snapshot->'canonical'->'items'->n;
 IF (line_doc-'remote_line_id') IS DISTINCT FROM ((s.normalized->'items'->n)-'remote_line_id') THEN RAISE EXCEPTION 'Cena lub ilość różni się od etapowanego źródła' USING ERRCODE='23514';END IF;
 remote_id:=CASE ch.provider WHEN 'shopify' THEN s.raw->'lineItems'->'nodes'->n->>'id'
 WHEN 'woocommerce' THEN s.raw->'line_items'->n->>'id'
 WHEN 'allegro' THEN s.raw->'lineItems'->n->>'id'
 WHEN 'amazon' THEN s.raw->'orderItems'->n->>'orderItemId'
 WHEN 'ebay' THEN s.raw->'lineItems'->n->>'lineItemId'
 WHEN 'prestashop' THEN s.raw->'associations'->'order_rows'->n->>'id'
 WHEN 'odoo' THEN (SELECT item->>'id' FROM jsonb_array_elements(s.raw->'_dyna'->'lines') WITH ORDINALITY AS l(item,ord)
 WHERE coalesce(item->>'display_type','false') IN('false','') AND (coalesce(s.raw->'_dyna'->>'has_delivery_field','false')<>'true' OR coalesce(item->>'is_delivery','false')<>'true') ORDER BY ord LIMIT 1 OFFSET n)
 ELSE NULL END;
 IF remote_id IS NULL OR length(remote_id)=0 OR remote_id IS DISTINCT FROM r->>'remote_line_id' THEN RAISE EXCEPTION 'Brak rzeczywistego ID źródłowej pozycji' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM products WHERE tenant_id=NEW.tenant_id AND id=(r->>'product_id')::uuid;
 SELECT * INTO m FROM listings WHERE tenant_id=NEW.tenant_id AND id=(r->>'listing_id')::uuid;
 IF p.id IS NULL OR m.id IS NULL OR jsonb_typeof(r->'product_version') IS DISTINCT FROM 'string' OR jsonb_typeof(r->'components') IS DISTINCT FROM 'array' OR line_doc IS NULL OR line_doc->>'remote_line_id' IS DISTINCT FROM r->>'remote_line_id' OR line_doc->'quantity' IS DISTINCT FROM r->'quantity' OR line_doc->'line_total' IS DISTINCT FROM r->'line_total'
 OR m.channel_id IS DISTINCT FROM NEW.channel_id OR m.product_id IS DISTINCT FROM p.id OR m.external_id IS DISTINCT FROM line_doc->>'external_id'
 OR to_jsonb((line_doc->>'line_total')::bigint/(line_doc->>'quantity')::bigint) IS DISTINCT FROM r->'price' OR p.name IS DISTINCT FROM r->>'name' OR p.sku IS DISTINCT FROM r->>'sku'
 OR p.version::text IS DISTINCT FROM r->>'product_version' OR to_jsonb(p.vat) IS DISTINCT FROM r->'vat' OR NOT p.active OR p.kind='group'
 OR (r->>'local_quantity')::bigint+(r->>'external_quantity')::bigint+(r->>'unassigned_quantity')::bigint IS DISTINCT FROM (line_doc->>'quantity')::bigint
 OR ((r->>'external_quantity')::int>0) IS DISTINCT FROM (r->>'link_id' IS NOT NULL)
 THEN RAISE EXCEPTION 'Niezgodny fragment źródłowego importu' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',cp.id,'quantity',rq.quantity,'sku',cp.sku,'name',cp.name,'version',cp.version::text) ORDER BY cp.id),'[]') INTO expected_components
 FROM (SELECT product_id,quantity FROM bundle_components WHERE tenant_id=NEW.tenant_id AND bundle_id=p.id AND p.kind='bundle' UNION ALL SELECT p.id,1 WHERE p.kind<>'bundle') rq
 JOIN products cp ON cp.tenant_id=NEW.tenant_id AND cp.id=rq.product_id AND cp.active AND cp.kind IN('simple','variant');
 IF expected_components='[]' OR r->'components' IS DISTINCT FROM expected_components THEN RAISE EXCEPTION 'Receptura nie odpowiada własnym aktywnym składnikom' USING ERRCODE='23514';END IF;
 IF r->>'link_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM b2b_links WHERE tenant_id=NEW.tenant_id AND id=(r->>'link_id')::uuid AND NOT paused) THEN RAISE EXCEPTION 'Brak aktywnego własnego połączenia' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN NEW;END $$;
CREATE TRIGGER a_source_guard BEFORE INSERT ON b2b_external_import_previews FOR EACH ROW EXECUTE FUNCTION b2b_external_import_preview_guard();
CREATE FUNCTION b2b_external_import_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE t uuid;n bigint;BEGIN
 FOR t IN SELECT DISTINCT tenant_id FROM inserted_rows ORDER BY tenant_id LOOP
 PERFORM pg_advisory_xact_lock(hashtextextended('b2b.external.import.proof:'||t::text,0));
 IF (SELECT count(*) FROM b2b_external_import_previews WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM b2b_external_import_executions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit historii źródłowych intencji' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM b2b_external_import_previews WHERE tenant_id=t AND byte_count>8388608) THEN RAISE EXCEPTION 'Limit historii źródłowych intencji: podgląd 8MiB' USING ERRCODE='P0001';END IF;
 SELECT coalesce(sum(byte_count),0) INTO n FROM(SELECT byte_count FROM b2b_external_import_previews WHERE tenant_id=t UNION ALL SELECT byte_count FROM b2b_external_import_executions WHERE tenant_id=t UNION ALL SELECT byte_count FROM b2b_external_import_certificates WHERE tenant_id=t) b;
 IF n>134217728 THEN RAISE EXCEPTION 'Limit historii źródłowych intencji: 128MiB' USING ERRCODE='P0001';END IF;
 END LOOP;RETURN NULL;END $$;
DO $$DECLARE n text;BEGIN FOREACH n IN ARRAY ARRAY['b2b_external_import_previews','b2b_external_import_executions','b2b_external_import_certificates'] LOOP
 EXECUTE format('CREATE TRIGGER budget AFTER INSERT ON %I REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION b2b_external_import_budget()',n);
 EXECUTE format('CREATE TRIGGER budget_update AFTER UPDATE ON %I REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION b2b_external_import_budget()',n);END LOOP;END $$;
CREATE FUNCTION b2b_external_import_prepare(pid uuid,uid uuid,kid uuid,ck uuid,rh text,req jsonb) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p b2b_external_import_previews%ROWTYPE;s inbound_orders%ROWTYPE;cid uuid:=gen_random_uuid();BEGIN
 SELECT * INTO p FROM b2b_external_import_previews WHERE tenant_id=t AND id=pid FOR SHARE;
 SELECT * INTO s FROM inbound_orders WHERE tenant_id=t AND id=p.inbound_id FOR UPDATE;
 IF p.id IS NULL OR p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid OR p.expires_at<=clock_timestamp() OR s.order_id IS NOT NULL
 OR s.source_hash IS DISTINCT FROM p.snapshot->'source'->>'source_hash' OR encode(sha256(convert_to(s.raw::text,'UTF8')),'hex') IS DISTINCT FROM p.raw_hash
 OR req IS DISTINCT FROM jsonb_build_object('client_key',ck,'version',1,'scope_hash',p.scope_hash,'confirmed',true)
 OR rh!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Nieaktualne dopuszczenie źródłowego importu' USING ERRCODE='23514';END IF;
 IF b2b_dropship_current_role(uid,false) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Brak aktualnej zgody administratora' USING ERRCODE='23514';END IF;
 IF b2b_external_import_key_grant(uid,kid,true,false)<>'ok' OR (kid IS NOT NULL AND b2b_dropship_key_grant(uid,kid,true,false)<>'ok') THEN RAISE EXCEPTION 'Brak aktualnej zgody administratora' USING ERRCODE='23514';END IF;
 INSERT INTO b2b_external_import_certificates(tenant_id,id,preview_id,actor_id,api_key_id,client_key,request_hash,request,transaction_id,transaction_started_at) VALUES(t,cid,pid,uid,kid,ck,rh,req,pg_current_xact_id(),transaction_timestamp());RETURN cid;END $$;
CREATE FUNCTION b2b_external_import_admitted(pid uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM b2b_external_import_certificates WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND preview_id=pid AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp() AND state='prepared' AND actual_order_id IS NULL) $$;
CREATE FUNCTION b2b_external_import_created() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE cert record;p record;BEGIN
 IF to_regclass('public.b2b_external_import_certificates') IS NULL OR to_regclass('public.b2b_external_import_previews') IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO cert FROM b2b_external_import_certificates WHERE tenant_id=NEW.tenant_id AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp() AND state='prepared' AND actual_order_id IS NULL;
 IF NOT FOUND THEN RETURN NEW;END IF;
 SELECT * INTO p FROM b2b_external_import_previews WHERE tenant_id=cert.tenant_id AND id=cert.preview_id;
 IF NEW.source IS DISTINCT FROM p.snapshot->'source'->>'provider' OR NEW.warehouse_id IS DISTINCT FROM (p.config->>'warehouse_id')::uuid
 OR NEW.currency IS DISTINCT FROM p.snapshot->'canonical'->>'currency' OR to_jsonb(NEW.total) IS DISTINCT FROM p.snapshot->'canonical'->'total'
 OR NEW.address IS DISTINCT FROM p.snapshot->'canonical'->'address' THEN RAISE EXCEPTION 'Nowe zamówienie nie odpowiada dopuszczeniu importu' USING ERRCODE='23514';END IF;
 UPDATE b2b_external_import_certificates SET actual_order_id=NEW.id WHERE id=cert.id;
 RETURN NEW;END $$;
CREATE TRIGGER external_import_created AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION b2b_external_import_created();
CREATE FUNCTION b2b_external_import_certify(cid uuid,oid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;cert b2b_external_import_certificates%ROWTYPE;p b2b_external_import_previews%ROWTYPE;s inbound_orders%ROWTYPE;o orders%ROWTYPE;r jsonb;i order_items%ROWTYPE;pr products%ROWTYPE;recipe jsonb;BEGIN
 SELECT * INTO cert FROM b2b_external_import_certificates WHERE tenant_id=t AND id=cid FOR UPDATE;
 SELECT * INTO p FROM b2b_external_import_previews WHERE tenant_id=t AND id=cert.preview_id;
 SELECT * INTO s FROM inbound_orders WHERE tenant_id=t AND id=p.inbound_id;
 SELECT * INTO o FROM orders WHERE tenant_id=t AND id=oid;
 IF cert.id IS NULL OR cert.state<>'prepared' OR cert.actual_order_id IS DISTINCT FROM oid OR cert.transaction_id<>pg_current_xact_id() OR cert.transaction_started_at<>transaction_timestamp()
 OR s.order_id IS DISTINCT FROM oid OR s.imported_hash IS DISTINCT FROM p.snapshot->'source'->>'source_hash' OR s.source_hash IS DISTINCT FROM s.imported_hash OR s.state<>'imported'
 OR encode(sha256(convert_to(s.raw::text,'UTF8')),'hex') IS DISTINCT FROM p.raw_hash
 OR o.channel_id IS DISTINCT FROM p.channel_id OR o.external_id IS DISTINCT FROM p.snapshot->'canonical'->>'external_id' OR o.source IS DISTINCT FROM p.snapshot->'source'->>'provider'
 OR o.source_snapshot->'items' IS DISTINCT FROM p.snapshot->'canonical'->'items'
 OR o.customer_name IS DISTINCT FROM p.snapshot->'canonical'->>'customer_name' OR o.email IS DISTINCT FROM p.snapshot->'canonical'->>'email' OR o.address IS DISTINCT FROM p.snapshot->'canonical'->'address'
 OR o.currency IS DISTINCT FROM p.snapshot->'canonical'->>'currency' OR o.payment_mode IS DISTINCT FROM p.snapshot->'canonical'->>'payment_mode'
 OR to_jsonb(o.shipping_cost) IS DISTINCT FROM p.snapshot->'canonical'->'shipping_cost' OR to_jsonb(o.total) IS DISTINCT FROM p.snapshot->'canonical'->'total'
 OR (SELECT count(*) FROM order_items WHERE tenant_id=t AND order_id=oid)<>jsonb_array_length(p.rows)
 OR (SELECT count(*) FROM order_source_lines WHERE tenant_id=t AND source_order_id=oid AND inbound_id=p.inbound_id AND source_hash=s.imported_hash)<>jsonb_array_length(p.rows)
 THEN RAISE EXCEPTION 'Niepełny rzeczywisty certyfikat źródłowego importu' USING ERRCODE='23514';END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p.rows) LOOP
 SELECT * INTO i FROM order_items WHERE tenant_id=t AND order_id=oid AND id=(r->>'customer_item_id')::uuid;
 SELECT * INTO pr FROM products WHERE tenant_id=t AND id=(r->>'product_id')::uuid;
 SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',x->'product_id','quantity',x->'quantity') ORDER BY x->>'product_id'),'[]') INTO recipe FROM jsonb_array_elements(r->'components') x;
 IF i.id IS NULL OR i.product_id IS DISTINCT FROM (r->>'product_id')::uuid OR to_jsonb(i.quantity) IS DISTINCT FROM r->'quantity'
 OR to_jsonb(i.line_total) IS DISTINCT FROM r->'line_total' OR to_jsonb(i.price) IS DISTINCT FROM r->'price' OR to_jsonb(i.vat) IS DISTINCT FROM r->'vat'
 OR i.sku IS DISTINCT FROM r->>'sku' OR i.name IS DISTINCT FROM r->>'name' OR i.components IS DISTINCT FROM recipe
 OR pr.version::text IS DISTINCT FROM r->>'product_version' OR NOT pr.active OR NOT EXISTS(SELECT 1 FROM order_source_lines sl WHERE sl.tenant_id=t AND sl.source_item_id=i.id AND sl.source_order_id=oid AND sl.inbound_id=p.inbound_id AND sl.channel_id=p.channel_id AND sl.remote_line_id=r->>'remote_line_id' AND sl.product_id=i.product_id AND sl.listing_id=(r->>'listing_id')::uuid AND sl.line_total=i.line_total AND sl.quantity=i.quantity)
 THEN RAISE EXCEPTION 'Oryginalny fragment, cena lub receptura zmieniły się' USING ERRCODE='23514';END IF;
 END LOOP;
 UPDATE b2b_external_import_certificates SET state='certified',source_items=(SELECT jsonb_agg(to_jsonb(oi) ORDER BY oi.id) FROM order_items oi WHERE oi.tenant_id=t AND oi.order_id=oid),physical_snapshot=b2b_dropship_custody_snapshot(oid) WHERE id=cid;
 END $$;
CREATE FUNCTION b2b_external_import_execution_request(cid uuid) RETURNS TABLE(client_key uuid,request jsonb) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT c.client_key,c.request FROM b2b_external_import_certificates c WHERE c.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND c.id=cid AND c.transaction_id=pg_current_xact_id() AND c.transaction_started_at=transaction_timestamp() AND c.state='certified' $$;
CREATE FUNCTION b2b_external_import_create_proof(oid uuid,rid uuid,cid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;cert b2b_external_import_certificates%ROWTYPE;h b2b_external_order_intents%ROWTYPE;r b2b_external_order_intent_revisions%ROWTYPE;p b2b_external_import_previews%ROWTYPE;expected_alloc jsonb;BEGIN
 SELECT * INTO cert FROM b2b_external_import_certificates WHERE tenant_id=t AND id=cid;
 SELECT * INTO p FROM b2b_external_import_previews WHERE tenant_id=t AND id=cert.preview_id;
 SELECT * INTO h FROM b2b_external_order_intents WHERE tenant_id=t AND order_id=oid;
 SELECT * INTO r FROM b2b_external_order_intent_revisions WHERE tenant_id=t AND id=rid AND intent_id=h.id AND kind='create';
 SELECT jsonb_agg(jsonb_build_object('customer_item_id',x->'customer_item_id','local_quantity',x->'local_quantity','external_quantity',x->'external_quantity','unassigned_quantity',x->'unassigned_quantity','link_id',x->'link_id') ORDER BY (x->>'source_index')::int) INTO expected_alloc FROM jsonb_array_elements(p.rows) x;
 IF cert.id IS NULL OR cert.state<>'certified' OR cert.actual_order_id IS DISTINCT FROM oid OR cert.transaction_id<>pg_current_xact_id() OR cert.transaction_started_at<>transaction_timestamp()
 OR r.id IS NULL OR r.actor_id IS DISTINCT FROM cert.actor_id OR r.api_key_id IS DISTINCT FROM cert.api_key_id OR r.client_key IS DISTINCT FROM cert.client_key
 OR h.actor_id IS DISTINCT FROM cert.actor_id OR h.api_key_id IS DISTINCT FROM cert.api_key_id OR h.original_items IS DISTINCT FROM cert.source_items OR h.allocations IS DISTINCT FROM expected_alloc
 OR h.initial_request IS DISTINCT FROM cert.request||jsonb_build_object('source_preview_id',cert.preview_id,'source_certificate_id',cid,'allocations',expected_alloc)
 OR b2b_dropship_custody_snapshot(oid) IS DISTINCT FROM cert.physical_snapshot THEN RAISE EXCEPTION 'Niezgodna typowana intencja źródłowa' USING ERRCODE='23514';END IF;
 IF b2b_dropship_current_role(cert.actor_id,false) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Brak aktualnej zgody administratora' USING ERRCODE='23514';END IF;
 INSERT INTO b2b_external_order_allocation_proofs(tenant_id,revision_id,order_id,transaction_id,transaction_started_at,before_snapshot,after_snapshot,actor_id,kind,before_intent_snapshot,allocation_snapshot,applied) VALUES(t,rid,oid,pg_current_xact_id(),transaction_timestamp(),cert.physical_snapshot,cert.physical_snapshot,cert.actor_id,'create',NULL,h.allocations,true);
 END $$;
CREATE FUNCTION b2b_external_import_finish(cid uuid,hid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;cert b2b_external_import_certificates%ROWTYPE;p b2b_external_import_previews%ROWTYPE;h b2b_external_order_intents%ROWTYPE;BEGIN
 SELECT * INTO cert FROM b2b_external_import_certificates WHERE tenant_id=t AND id=cid FOR UPDATE;SELECT * INTO p FROM b2b_external_import_previews WHERE tenant_id=t AND id=cert.preview_id;
 SELECT * INTO h FROM b2b_external_order_intents WHERE tenant_id=t AND id=hid AND order_id=cert.actual_order_id;
 IF cert.id IS NULL OR cert.state<>'certified' OR cert.transaction_id<>pg_current_xact_id() OR cert.transaction_started_at<>transaction_timestamp() OR h.id IS NULL OR NOT EXISTS(SELECT 1 FROM b2b_external_order_allocation_proofs WHERE tenant_id=t AND order_id=h.order_id AND applied AND kind='create' AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Brak ukończonego dowodu importu' USING ERRCODE='23514';END IF;
 UPDATE b2b_external_import_certificates SET state='complete',intent_id=hid WHERE id=cid;
 INSERT INTO b2b_external_import_executions(tenant_id,id,preview_id,inbound_id,certificate_id,order_id,intent_id,actor_id,api_key_id,client_key,request_hash,request) VALUES(t,gen_random_uuid(),cert.preview_id,p.inbound_id,cid,cert.actual_order_id,hid,cert.actor_id,cert.api_key_id,cert.client_key,cert.request_hash,cert.request);
 END $$;
CREATE FUNCTION b2b_external_import_execution_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE cert b2b_external_import_certificates%ROWTYPE;p b2b_external_import_previews%ROWTYPE;BEGIN
 SELECT * INTO cert FROM b2b_external_import_certificates WHERE tenant_id=NEW.tenant_id AND id=NEW.certificate_id;SELECT * INTO p FROM b2b_external_import_previews WHERE tenant_id=NEW.tenant_id AND id=NEW.preview_id;
 IF cert.id IS NULL OR p.id IS NULL THEN RETURN NEW;END IF;
 IF cert.state<>'complete' OR cert.transaction_id<>pg_current_xact_id() OR cert.transaction_started_at<>transaction_timestamp() OR cert.preview_id IS DISTINCT FROM NEW.preview_id OR p.inbound_id IS DISTINCT FROM NEW.inbound_id OR cert.actual_order_id IS DISTINCT FROM NEW.order_id OR cert.intent_id IS DISTINCT FROM NEW.intent_id OR cert.actor_id IS DISTINCT FROM NEW.actor_id OR cert.api_key_id IS DISTINCT FROM NEW.api_key_id OR cert.client_key IS DISTINCT FROM NEW.client_key OR cert.request_hash IS DISTINCT FROM NEW.request_hash OR cert.request IS DISTINCT FROM NEW.request THEN RAISE EXCEPTION 'Niezgodny receipt importu' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER source_guard BEFORE INSERT ON b2b_external_import_executions FOR EACH ROW EXECUTE FUNCTION b2b_external_import_execution_guard();
CREATE FUNCTION b2b_external_import_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE c b2b_external_import_certificates%ROWTYPE;BEGIN
 SELECT * INTO c FROM b2b_external_import_certificates WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
 IF c.state<>'complete' OR c.actual_order_id IS NULL OR c.intent_id IS NULL OR NOT EXISTS(SELECT 1 FROM b2b_external_import_executions WHERE tenant_id=c.tenant_id AND certificate_id=c.id AND intent_id=c.intent_id AND order_id=c.actual_order_id)
 THEN RAISE EXCEPTION 'Dopuszczenie źródłowe wymaga ukończonego importu i intencji' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER complete AFTER INSERT ON b2b_external_import_certificates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_external_import_complete();
DO $$DECLARE sig text;BEGIN FOREACH sig IN ARRAY ARRAY['b2b_external_import_prepare(uuid,uuid,uuid,uuid,text,jsonb)','b2b_external_import_admitted(uuid)','b2b_external_import_certify(uuid,uuid)','b2b_external_import_execution_request(uuid)','b2b_external_import_create_proof(uuid,uuid,uuid)','b2b_external_import_finish(uuid,uuid)'] LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',sig);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO dyna_app',sig);END LOOP;END $$;
REVOKE ALL ON FUNCTION b2b_external_import_preview_guard(),b2b_external_import_budget(),b2b_external_import_created(),b2b_external_import_execution_guard(),b2b_external_import_complete() FROM PUBLIC,dyna_app;

-- All existing109 scope checks retained; only genuine new source admission is additive.
CREATE OR REPLACE FUNCTION b2b_external_intent_scope() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a jsonb;i record;h b2b_external_order_intents%ROWTYPE;l record;before_doc jsonb;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Historia intencji jest niezmienna' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='b2b_external_order_intents' THEN
 IF TG_OP='UPDATE' THEN
 IF to_jsonb(NEW)-ARRAY['version','state','allocations','updated_at','byte_count'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['version','state','allocations','updated_at','byte_count'] OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Nieprawidłowa rewizja intencji' USING ERRCODE='23514';END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM b2b_external_order_created_orders WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp()) THEN
 IF to_regclass('public.b2b_external_import_certificates') IS NULL THEN RAISE EXCEPTION 'Intencja wymaga nowego własnego zamówienia' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM b2b_external_import_certificates cert WHERE cert.tenant_id=NEW.tenant_id AND cert.actual_order_id=NEW.order_id AND cert.state='certified' AND cert.actor_id=NEW.actor_id AND cert.api_key_id IS NOT DISTINCT FROM NEW.api_key_id AND cert.client_key=NEW.client_key AND cert.transaction_id=pg_current_xact_id() AND cert.transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Intencja wymaga nowego własnego zamówienia' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.original_items IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(oi) ORDER BY oi.id),'[]') FROM order_items oi WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id) THEN RAISE EXCEPTION 'Receptura intencji nie odpowiada nowym pozycjom' USING ERRCODE='23514';END IF;
 END IF;
 IF jsonb_array_length(NEW.allocations)<>jsonb_array_length(NEW.original_items) OR (SELECT count(DISTINCT x->>'customer_item_id') FROM jsonb_array_elements(NEW.allocations) x)<>jsonb_array_length(NEW.allocations) THEN RAISE EXCEPTION 'Niepełny przydział intencji' USING ERRCODE='23514';END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(NEW.allocations) LOOP
 IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(a))<>5 OR NOT(a ?& ARRAY['customer_item_id','local_quantity','external_quantity','unassigned_quantity','link_id'])
 OR jsonb_typeof(a->'customer_item_id') IS DISTINCT FROM 'string' OR a->>'customer_item_id' !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
 OR jsonb_typeof(a->'local_quantity') IS DISTINCT FROM 'number' OR a->>'local_quantity' !~ '^(0|[1-9][0-9]{0,5})$'
 OR jsonb_typeof(a->'external_quantity') IS DISTINCT FROM 'number' OR a->>'external_quantity' !~ '^(0|[1-9][0-9]{0,5})$'
 OR jsonb_typeof(a->'unassigned_quantity') IS DISTINCT FROM 'number' OR a->>'unassigned_quantity' !~ '^(0|[1-9][0-9]{0,5})$'
 OR ((a->'link_id')<>'null' AND (jsonb_typeof(a->'link_id') IS DISTINCT FROM 'string' OR a->>'link_id' !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')) THEN RAISE EXCEPTION 'Nieprawidłowe pola przydziału' USING ERRCODE='23514';END IF;
 SELECT * INTO i FROM order_items WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND id=(a->>'customer_item_id')::uuid;
 IF NOT FOUND OR (a->>'local_quantity')::int<0 OR (a->>'external_quantity')::int<0 OR (a->>'unassigned_quantity')::int<0
 OR (a->>'local_quantity')::bigint+(a->>'external_quantity')::bigint+(a->>'unassigned_quantity')::bigint<>i.quantity
 OR (NEW.state='open' AND i.scanned>(a->>'local_quantity')::int)
 OR ((a->>'external_quantity')::int>0)<>(a->>'link_id' IS NOT NULL) THEN RAISE EXCEPTION 'Przydział narusza ilość handlową' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' AND a->>'link_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM b2b_links bl WHERE bl.tenant_id=NEW.tenant_id AND bl.id=(a->>'link_id')::uuid AND NOT bl.paused) THEN RAISE EXCEPTION 'Brak aktywnego połączenia przydziału' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM b2b_dropship_lines dl JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(dl.tenant_id,dl.order_id) WHERE dl.tenant_id=NEW.tenant_id AND dl.customer_item_id=i.id AND d.state='ordered' GROUP BY d.link_id HAVING sum(dl.quantity)>(a->>'external_quantity')::int OR d.link_id IS DISTINCT FROM (a->>'link_id')::uuid) THEN RAISE EXCEPTION 'Przydział nie może odebrać zleconej ilości' USING ERRCODE='23514';END IF;
 END LOOP;
 ELSE
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Rewizja intencji jest niezmienna' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM b2b_external_order_intents WHERE (tenant_id,id)=(NEW.tenant_id,NEW.intent_id);
 IF NOT FOUND THEN RETURN NEW;END IF;
 IF b2b_dropship_current_role(NEW.actor_id,false) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Brak aktualnej zgody administratora' USING ERRCODE='23514';END IF;
 IF NEW.version<>h.version OR NEW.after_snapshot IS DISTINCT FROM b2b_external_intent_snapshot(h) THEN RAISE EXCEPTION 'Rewizja nie odpowiada aktualnemu przydziałowi' USING ERRCODE='23514';END IF;
 IF NEW.kind='create' AND (NEW.version<>1 OR NEW.before_snapshot IS NOT NULL OR NEW.client_key<>h.client_key OR NEW.request_hash<>h.request_hash OR NEW.request IS DISTINCT FROM h.initial_request) THEN RAISE EXCEPTION 'Nieprawidłowy pierwszy zapis intencji' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END $$;
