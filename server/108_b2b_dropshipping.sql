-- Customer retail custody and supplier wholesale custody remain separate ledgers.
-- No historical purchase/order is adopted and no buyer PZ or payment is generated.
CREATE TABLE b2b_dropship_quotes (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,link_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),request jsonb NOT NULL,snapshot jsonb NOT NULL,
 scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),customer_order_id uuid NOT NULL,supplier_tenant_id uuid NOT NULL,source_quote_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 byte_count bigint NOT NULL DEFAULT 0,UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,id,customer_order_id),
 FOREIGN KEY(tenant_id,link_id) REFERENCES b2b_links(tenant_id,id),FOREIGN KEY(tenant_id,customer_order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(supplier_tenant_id,source_quote_id) REFERENCES b2b_quotes(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK(jsonb_typeof(request)='object' AND jsonb_typeof(snapshot)='object' AND expires_at>created_at)
);
CREATE TABLE b2b_dropship_orders (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,link_id uuid NOT NULL,quote_id uuid NOT NULL,customer_order_id uuid NOT NULL,
 supplier_tenant_id uuid NOT NULL,supplier_order_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),request jsonb NOT NULL,
 state text NOT NULL DEFAULT 'ordered' CHECK(state IN ('ordered','cancelled')),version integer NOT NULL DEFAULT 1 CHECK(version>=1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),cancelled_at timestamptz,byte_count bigint NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,quote_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,id,customer_order_id),UNIQUE(supplier_tenant_id,supplier_order_id),
 FOREIGN KEY(tenant_id,quote_id,customer_order_id) REFERENCES b2b_dropship_quotes(tenant_id,id,customer_order_id),
 FOREIGN KEY(tenant_id,link_id) REFERENCES b2b_links(tenant_id,id),FOREIGN KEY(supplier_tenant_id,supplier_order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),CHECK((state='cancelled')=(cancelled_at IS NOT NULL))
);
CREATE TABLE b2b_dropship_lines (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,customer_order_id uuid NOT NULL,customer_item_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity>=1 AND quantity<=100000),
 mappings jsonb NOT NULL CHECK(jsonb_typeof(mappings)='array' AND jsonb_array_length(mappings)>=1 AND jsonb_array_length(mappings)<=100),
 byte_count bigint NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,order_id,customer_item_id),
 FOREIGN KEY(tenant_id,order_id,customer_order_id) REFERENCES b2b_dropship_orders(tenant_id,id,customer_order_id),
 FOREIGN KEY(tenant_id,customer_order_id,customer_item_id) REFERENCES order_items(tenant_id,order_id,id)
);
CREATE TABLE b2b_dropship_actions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),api_key_id uuid,
 client_key uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('cancel','reconcile')),request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),request jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count bigint NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,order_id) REFERENCES b2b_dropship_orders(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE UNIQUE INDEX b2b_dropship_one_action ON b2b_dropship_actions(tenant_id,order_id,kind);
CREATE TABLE b2b_dropship_supplier_orders (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,buyer_tenant_id uuid NOT NULL,dropship_order_id uuid NOT NULL,
 bill_to jsonb NOT NULL,receiver jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,order_id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(buyer_tenant_id,dropship_order_id) REFERENCES b2b_dropship_orders(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(tenant_id<>buyer_tenant_id AND jsonb_typeof(bill_to)='object' AND jsonb_typeof(receiver)='object')
);
CREATE TABLE b2b_dropship_custody_transfers (
 tenant_id uuid NOT NULL,id uuid PRIMARY KEY,order_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('release','restore')),
 action_id uuid,transaction_id xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,
 applied boolean NOT NULL DEFAULT false,before_snapshot jsonb NOT NULL,after_snapshot jsonb NOT NULL,pieces jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count bigint NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,order_id,kind),FOREIGN KEY(tenant_id,order_id) REFERENCES b2b_dropship_orders(tenant_id,id),
 FOREIGN KEY(tenant_id,action_id) REFERENCES b2b_dropship_actions(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((kind='restore')=(action_id IS NOT NULL))
);
CREATE INDEX b2b_dropship_quote_page ON b2b_dropship_quotes(tenant_id,link_id,id);
CREATE INDEX b2b_dropship_order_page ON b2b_dropship_orders(tenant_id,link_id,id);
CREATE INDEX b2b_dropship_order_customer ON b2b_dropship_orders(tenant_id,customer_order_id,state);
CREATE INDEX b2b_dropship_line_customer ON b2b_dropship_lines(tenant_id,customer_order_id,customer_item_id);

CREATE FUNCTION b2b_dropship_current_role(uid uuid,pin boolean DEFAULT false) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;answer text;BEGIN
 IF pin THEN SELECT role INTO answer FROM memberships WHERE tenant_id=t AND user_id=uid FOR SHARE;
 ELSE SELECT role INTO answer FROM memberships WHERE tenant_id=t AND user_id=uid;END IF;RETURN answer;END $$;
CREATE FUNCTION b2b_dropship_key_grant(uid uuid,kid uuid,writing boolean,pin boolean DEFAULT false) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;k record;BEGIN
 IF pin THEN SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid FOR SHARE;
 ELSE SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid;END IF;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR (k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN RETURN 'invalid';END IF;
 IF NOT k.scopes @> ARRAY['products:read','inventory:read','orders:read','purchasing:read']::text[] THEN RETURN 'insufficient';END IF;
 IF writing AND NOT k.scopes @> ARRAY['inventory:write','orders:write','purchasing:write']::text[] THEN RETURN 'insufficient';END IF;
 RETURN 'ok';END $$;
REVOKE ALL ON FUNCTION b2b_dropship_current_role(uuid,boolean),b2b_dropship_key_grant(uuid,uuid,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_dropship_current_role(uuid,boolean),b2b_dropship_key_grant(uuid,uuid,boolean,boolean) TO dyna_app;

CREATE FUNCTION b2b_dropship_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='b2b_dropship_custody_transfers' AND TG_OP='UPDATE' THEN
 IF NOT OLD.applied AND NEW.applied AND to_jsonb(NEW)-ARRAY['applied','byte_count'] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['applied','byte_count'] THEN RETURN NEW;END IF;END IF;
 RAISE EXCEPTION 'Dowód dropshippingu jest niezmienny' USING ERRCODE='23514';END $$;
CREATE FUNCTION b2b_dropship_bytes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint;BEGIN
 NEW.byte_count:=0;LOOP n:=octet_length(to_jsonb(NEW)::text);EXIT WHEN NEW.byte_count=n;NEW.byte_count:=n;END LOOP;RETURN NEW;END $$;
CREATE FUNCTION b2b_dropship_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid;v bigint;BEGIN
 FOR t IN SELECT DISTINCT tenant_id FROM inserted_rows ORDER BY tenant_id LOOP
 PERFORM pg_advisory_xact_lock(hashtextextended('b2b.dropship.proof:'||t::text,0));
 IF (SELECT count(*) FROM b2b_dropship_quotes WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM b2b_dropship_orders WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit historii dropshippingu';END IF;
 SELECT (SELECT coalesce(sum(byte_count),0) FROM b2b_dropship_quotes WHERE tenant_id=t)+(SELECT coalesce(sum(byte_count),0) FROM b2b_dropship_orders WHERE tenant_id=t)+
 (SELECT coalesce(sum(byte_count),0) FROM b2b_dropship_lines WHERE tenant_id=t)+(SELECT coalesce(sum(byte_count),0) FROM b2b_dropship_actions WHERE tenant_id=t)+
 (SELECT coalesce(sum(byte_count),0) FROM b2b_dropship_custody_transfers WHERE tenant_id=t) INTO v;
 IF v>134217728 THEN RAISE EXCEPTION 'Limit rozmiaru historii dropshippingu';END IF;END LOOP;RETURN NULL;END $$;
DO $$ DECLARE tbl text;BEGIN
 FOREACH tbl IN ARRAY ARRAY['b2b_dropship_quotes','b2b_dropship_orders','b2b_dropship_lines','b2b_dropship_actions','b2b_dropship_supplier_orders','b2b_dropship_custody_transfers'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('CREATE POLICY dropship_owner ON %I TO %I USING(true) WITH CHECK(true)',tbl,current_user);
 EXECUTE format('CREATE TRIGGER bytes BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION b2b_dropship_bytes()',tbl);
 IF tbl<>'b2b_dropship_orders' THEN EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION b2b_dropship_immutable()',tbl);END IF;
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',tbl);
 IF tbl<>'b2b_dropship_custody_transfers' THEN EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',tbl);END IF;
 IF tbl NOT IN ('b2b_dropship_supplier_orders') THEN EXECUTE format('CREATE TRIGGER budget AFTER INSERT ON %I REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION b2b_dropship_budget()',tbl);END IF;
 END LOOP;END $$;
GRANT UPDATE ON b2b_dropship_orders TO dyna_app;
CREATE TRIGGER budget_update AFTER UPDATE ON b2b_dropship_orders REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION b2b_dropship_budget();
CREATE TRIGGER budget_update AFTER UPDATE ON b2b_dropship_custody_transfers REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION b2b_dropship_budget();

CREATE FUNCTION b2b_dropship_custody_snapshot(oid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;result jsonb;BEGIN
 IF NOT EXISTS(SELECT 1 FROM orders WHERE tenant_id=t AND id=oid) THEN RAISE EXCEPTION 'Brak własnego zamówienia' USING ERRCODE='23514';END IF;
 WITH products_scope AS MATERIALIZED (
 SELECT DISTINCT (x->>'product_id')::uuid product_id,o.warehouse_id FROM orders o JOIN order_items i ON(i.tenant_id,i.order_id)=(o.tenant_id,o.id)
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_array_length(i.components)>0 THEN i.components ELSE jsonb_build_array(jsonb_build_object('product_id',i.product_id,'quantity',1)) END) x WHERE o.tenant_id=t AND o.id=oid
 ) SELECT jsonb_build_object(
 'reservations',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.product_id) FROM reservations r WHERE r.tenant_id=t AND r.order_id=oid),'[]'::jsonb),
 'locations',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.product_id,r.location) FROM reservation_locations r WHERE r.tenant_id=t AND r.order_id=oid),'[]'::jsonb),
 'layers',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.product_id,r.location,r.layer_id) FROM wms_reservation_layers r WHERE r.tenant_id=t AND r.order_id=oid),'[]'::jsonb),
 'picks',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.product_id) FROM order_pick_items r WHERE r.tenant_id=t AND r.order_id=oid),'[]'::jsonb),
 'stock',coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('version',r.version::text) ORDER BY r.product_id) FROM stock r JOIN products_scope p USING(warehouse_id,product_id) WHERE r.tenant_id=t),'[]'::jsonb),
 'bins',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.product_id,r.location) FROM stock_locations r JOIN products_scope p USING(warehouse_id,product_id) WHERE r.tenant_id=t),'[]'::jsonb),
 'positions',coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('version',r.version::text) ORDER BY r.product_id,r.location,r.layer_id) FROM wms_layer_positions r JOIN products_scope p USING(warehouse_id,product_id) WHERE r.tenant_id=t),'[]'::jsonb)
 ) INTO result;RETURN result;END $$;
REVOKE ALL ON FUNCTION b2b_dropship_custody_snapshot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_dropship_custody_snapshot(uuid) TO dyna_app;

-- Pure derived row arithmetic. Receives only server-derived snapshots inside the
-- private SECURITY DEFINER transfer; it is not an application write capability.
CREATE FUNCTION b2b_dropship_adjust_rows(rows_json jsonb,original_json jsonb,k text,amounts jsonb,pieces jsonb,direction integer) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r jsonb;oldr jsonb;result jsonb:='[]';n bigint;q bigint;field text;seen text[]:='{}';identity text;BEGIN
 FOR r IN SELECT value FROM jsonb_array_elements(rows_json||CASE WHEN direction=1 THEN original_json ELSE '[]'::jsonb END) LOOP
 identity:=(r->>'product_id')||coalesce(':'||(r->>'location'),'')||coalesce(':'||(r->>'layer_id'),'');
 IF identity=ANY(seen) THEN CONTINUE;END IF;seen:=array_append(seen,identity);
 IF k IN ('stock','reservations','picks') THEN
 SELECT coalesce(sum((value->>'quantity')::bigint),0) INTO q FROM jsonb_array_elements(amounts) WHERE value->>'product_id'=r->>'product_id';
 ELSE
 SELECT coalesce(sum((value->>'quantity')::bigint),0) INTO q FROM jsonb_array_elements(pieces) WHERE value->>'product_id'=r->>'product_id' AND value->>'location'=r->>'location' AND (k='locations' OR value->>'layer_id'=r->>'layer_id');END IF;
 IF q=0 THEN result:=result||jsonb_build_array(r);CONTINUE;END IF;
 SELECT value INTO oldr FROM jsonb_array_elements(rows_json) WHERE value->>'product_id'=r->>'product_id' AND coalesce(value->>'location','')=coalesce(r->>'location','') AND coalesce(value->>'layer_id','')=coalesce(r->>'layer_id','');
 field:=CASE WHEN k IN ('stock','positions') THEN 'reserved' ELSE 'quantity' END;
 n:=CASE WHEN oldr IS NULL THEN 0 ELSE (oldr->>field)::bigint END+direction*q;
 IF n<0 OR n>2147483647 OR (k NOT IN ('stock','positions') AND n<coalesce((r->>'scanned')::bigint,0)) THEN RAISE EXCEPTION 'Zmiana narusza zeskanowany lub dostępny zapas' USING ERRCODE='23514';END IF;
 IF k NOT IN ('stock','positions') AND n=0 THEN CONTINUE;END IF;
 r:=jsonb_set(r,ARRAY[field],to_jsonb(n));
 IF k IN ('stock','positions') THEN
 IF n>(r->>(CASE WHEN k='stock' THEN 'on_hand' ELSE 'quantity' END))::bigint THEN RAISE EXCEPTION 'Nie można przywrócić rezerwacji w pierwotnym miejscu' USING ERRCODE='23514';END IF;
 r:=jsonb_set(r,'{version}',to_jsonb(((r->>'version')::bigint+1)::text));
 IF k='stock' THEN r:=jsonb_set(r,'{available}',to_jsonb((r->>'on_hand')::bigint-n));END IF;
 ELSIF k IN ('reservations','layers') THEN r:=jsonb_set(r,'{state}','"active"');END IF;
 result:=result||jsonb_build_array(r);
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'product_id',value->>'location',value->>'layer_id'),'[]'::jsonb) INTO result FROM jsonb_array_elements(result);
 RETURN result;END $$;
REVOKE ALL ON FUNCTION b2b_dropship_adjust_rows(jsonb,jsonb,text,jsonb,jsonb,integer) FROM PUBLIC,dyna_app;

CREATE FUNCTION b2b_dropship_wms_change_allowed(old_row jsonb,new_row jsonb,operation text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM b2b_dropship_custody_transfers p JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(p.tenant_id,p.order_id)
 WHERE p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND p.tenant_id=(coalesce(new_row,old_row)->>'tenant_id')::uuid AND d.customer_order_id=(coalesce(new_row,old_row)->>'order_id')::uuid
 AND NOT p.applied AND p.transaction_id=pg_current_xact_id() AND p.transaction_started_at=transaction_timestamp()
 AND (operation='INSERT' OR p.before_snapshot->'layers' @> jsonb_build_array(old_row))
 AND CASE WHEN operation='DELETE' THEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.after_snapshot->'layers') r WHERE
 (r->>'order_id',r->>'product_id',r->>'location',r->>'layer_id')=(old_row->>'order_id',old_row->>'product_id',old_row->>'location',old_row->>'layer_id'))
 ELSE p.after_snapshot->'layers' @> jsonb_build_array(new_row) END)
$$;
REVOKE ALL ON FUNCTION b2b_dropship_wms_change_allowed(jsonb,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_dropship_wms_change_allowed(jsonb,jsonb,text) TO dyna_app;
-- Keep the entire installed 104 row guard byte-for-byte except a derived branch
-- before its immutable DELETE check. No caller supplied GUC/cache can authorize it.
DO $$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('public.wms_row_guard()'::regprocedure);
 IF position('DECLARE l record;op record;f record;p record;BEGIN' IN definition)=0 THEN RAISE EXCEPTION 'Nieznany wariant ochrony WMS';END IF;
 definition:=replace(definition,'DECLARE l record;op record;f record;p record;BEGIN',
 'DECLARE l record;op record;f record;p record;BEGIN
 IF TG_TABLE_NAME=''wms_reservation_layers'' AND b2b_dropship_wms_change_allowed(to_jsonb(OLD),to_jsonb(NEW),TG_OP) THEN
 IF TG_OP=''DELETE'' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;');
 EXECUTE definition;END $$;

CREATE FUNCTION b2b_dropship_transfer_custody(did uuid,restore_action uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;d record;q record;o record;r record;a record;
 before_doc jsonb;after_doc jsonb;original_doc jsonb;pieces jsonb:='[]';amounts jsonb;k text;remaining bigint;take integer;direction integer;pid uuid;BEGIN
 SELECT * INTO d FROM b2b_dropship_orders WHERE (tenant_id,id)=(t,did);
 IF NOT FOUND THEN RAISE EXCEPTION 'Brak własnego dropshippingu' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM b2b_dropship_quotes WHERE (tenant_id,id)=(t,d.quote_id);
 IF restore_action IS NULL AND NOT EXISTS(SELECT 1 FROM b2b_dropship_created_orders WHERE tenant_id=d.supplier_tenant_id AND order_id=d.supplier_order_id AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Brak nowego zamówienia dostawcy' USING ERRCODE='23514';END IF;
 IF restore_action IS NULL AND b2b_dropship_current_role(d.actor_id,false) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Brak aktualnej zgody administratora' USING ERRCODE='23514';END IF;
 direction:=CASE WHEN restore_action IS NULL THEN -1 ELSE 1 END;k:=CASE WHEN direction=-1 THEN 'release' ELSE 'restore' END;
 IF EXISTS(SELECT 1 FROM b2b_dropship_custody_transfers WHERE tenant_id=t AND order_id=did AND kind=k) THEN RETURN;END IF;
 IF direction=1 THEN
 SELECT * INTO a FROM b2b_dropship_actions WHERE (tenant_id,id,order_id,kind)=(t,restore_action,did,'cancel');
 IF NOT FOUND OR b2b_dropship_current_role(a.actor_id,false) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Brak zatwierdzonego anulowania' USING ERRCODE='23514';END IF;
 SELECT p.after_snapshot,p.before_snapshot,p.pieces INTO after_doc,original_doc,pieces FROM b2b_dropship_custody_transfers p WHERE p.tenant_id=t AND p.order_id=did AND p.kind='release';
 IF NOT FOUND THEN RAISE EXCEPTION 'Brak przeniesionej rezerwacji' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO o FROM orders WHERE tenant_id=t AND id=d.customer_order_id FOR UPDATE;
 IF o.status NOT IN ('new','paid','picking','packed') OR EXISTS(SELECT 1 FROM order_merge_claims WHERE tenant_id=t AND source_order_id=o.id) OR EXISTS(SELECT 1 FROM shipments WHERE tenant_id=t AND order_id=o.id AND dispatched_at IS NOT NULL) THEN RAISE EXCEPTION 'Zamówienie klienta zostało wydane lub przeniesione' USING ERRCODE='23514';END IF;
 SELECT jsonb_agg(jsonb_build_object('product_id',product_id,'quantity',quantity) ORDER BY product_id) INTO amounts FROM (
 SELECT (x->>'product_id')::uuid product_id,sum((i->>'quantity')::bigint*(x->>'quantity')::bigint)::bigint quantity FROM jsonb_array_elements(q.snapshot->'items') i CROSS JOIN LATERAL jsonb_array_elements(i->'components') x GROUP BY (x->>'product_id')::uuid) products_scope;
 PERFORM product_id FROM stock WHERE tenant_id=t AND warehouse_id=o.warehouse_id AND product_id IN(SELECT (value->>'product_id')::uuid FROM jsonb_array_elements(amounts)) ORDER BY product_id FOR UPDATE;
 PERFORM product_id FROM reservations WHERE tenant_id=t AND order_id=o.id ORDER BY product_id FOR UPDATE;
 PERFORM product_id FROM reservation_locations WHERE tenant_id=t AND order_id=o.id ORDER BY product_id,location FOR UPDATE;
 PERFORM product_id FROM wms_reservation_layers WHERE tenant_id=t AND order_id=o.id ORDER BY product_id,location,layer_id FOR UPDATE;
 PERFORM product_id FROM order_pick_items WHERE tenant_id=t AND order_id=o.id ORDER BY product_id FOR UPDATE;
 PERFORM product_id FROM wms_layer_positions WHERE tenant_id=t AND warehouse_id=o.warehouse_id AND product_id IN(SELECT (value->>'product_id')::uuid FROM jsonb_array_elements(amounts)) ORDER BY product_id,location,layer_id FOR UPDATE;
 before_doc:=b2b_dropship_custody_snapshot(o.id);
 IF direction=-1 THEN
 IF before_doc IS DISTINCT FROM q.snapshot->'custody' THEN RAISE EXCEPTION 'Rezerwacje zmieniły się od wyceny' USING ERRCODE='23514';END IF;
 original_doc:=before_doc;
 FOR r IN SELECT * FROM jsonb_to_recordset(amounts) AS x(product_id uuid,quantity bigint) ORDER BY product_id LOOP
 remaining:=r.quantity;
 IF EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=t AND enabled) THEN
 FOR a IN SELECT w.* FROM wms_reservation_layers w JOIN wms_cost_layers l ON(l.tenant_id,l.id)=(w.tenant_id,w.layer_id) WHERE w.tenant_id=t AND w.order_id=o.id AND w.product_id=r.product_id AND w.state='active' ORDER BY l.fifo_sequence DESC,w.layer_id DESC,w.location COLLATE "C" DESC LOOP
 take:=least(remaining,a.quantity-a.scanned);IF take>0 THEN pieces:=pieces||jsonb_build_array(jsonb_build_object('product_id',a.product_id,'location',a.location,'layer_id',a.layer_id,'quantity',take));remaining:=remaining-take;END IF;EXIT WHEN remaining=0;END LOOP;
 ELSE
 FOR a IN SELECT * FROM reservation_locations WHERE tenant_id=t AND order_id=o.id AND product_id=r.product_id ORDER BY location COLLATE "C" DESC LOOP
 take:=least(remaining,a.quantity-a.scanned);IF take>0 THEN pieces:=pieces||jsonb_build_array(jsonb_build_object('product_id',a.product_id,'location',a.location,'quantity',take));remaining:=remaining-take;END IF;EXIT WHEN remaining=0;END LOOP;
 END IF;
 IF remaining<>0 THEN RAISE EXCEPTION 'Dropshipping przekracza nieskompletowaną rezerwację' USING ERRCODE='23514';END IF;
 END LOOP;
 END IF;
 after_doc:=before_doc;
 FOREACH k IN ARRAY ARRAY['stock','reservations','picks','locations','layers','positions'] LOOP
 after_doc:=jsonb_set(after_doc,ARRAY[k],b2b_dropship_adjust_rows(before_doc->k,original_doc->k,k,amounts,pieces,direction));END LOOP;
 INSERT INTO b2b_dropship_custody_transfers(tenant_id,id,order_id,kind,action_id,transaction_id,transaction_started_at,before_snapshot,after_snapshot,pieces)
 VALUES(t,gen_random_uuid(),did,CASE WHEN direction=-1 THEN 'release' ELSE 'restore' END,restore_action,pg_current_xact_id(),transaction_timestamp(),before_doc,after_doc,pieces);
 -- The derived proof above is present before immutable allocation links change.
 DELETE FROM wms_reservation_layers w WHERE w.tenant_id=t AND w.order_id=o.id AND NOT EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::wms_reservation_layers,after_doc->'layers') x WHERE (x.order_id,x.product_id,x.location,x.layer_id)=(w.order_id,w.product_id,w.location,w.layer_id));
 DELETE FROM reservation_locations w WHERE w.tenant_id=t AND w.order_id=o.id AND NOT EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::reservation_locations,after_doc->'locations') x WHERE (x.order_id,x.product_id,x.location)=(w.order_id,w.product_id,w.location));
 DELETE FROM reservations w WHERE w.tenant_id=t AND w.order_id=o.id AND NOT EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::reservations,after_doc->'reservations') x WHERE (x.order_id,x.product_id)=(w.order_id,w.product_id));
 DELETE FROM order_pick_items w WHERE w.tenant_id=t AND w.order_id=o.id AND NOT EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::order_pick_items,after_doc->'picks') x WHERE (x.order_id,x.product_id)=(w.order_id,w.product_id));
 INSERT INTO reservations SELECT * FROM jsonb_populate_recordset(NULL::reservations,after_doc->'reservations') ON CONFLICT(tenant_id,order_id,product_id) DO UPDATE SET quantity=excluded.quantity,state=excluded.state;
 INSERT INTO reservation_locations SELECT * FROM jsonb_populate_recordset(NULL::reservation_locations,after_doc->'locations') ON CONFLICT(tenant_id,order_id,product_id,location) DO UPDATE SET quantity=excluded.quantity,scanned=excluded.scanned;
 INSERT INTO wms_reservation_layers SELECT * FROM jsonb_populate_recordset(NULL::wms_reservation_layers,after_doc->'layers') ON CONFLICT(tenant_id,order_id,product_id,warehouse_id,location,layer_id) DO UPDATE SET quantity=excluded.quantity,scanned=excluded.scanned,state=excluded.state;
 INSERT INTO order_pick_items SELECT * FROM jsonb_populate_recordset(NULL::order_pick_items,after_doc->'picks') ON CONFLICT(tenant_id,order_id,product_id) DO UPDATE SET quantity=excluded.quantity,scanned=excluded.scanned;
 UPDATE stock s SET reserved=x.reserved FROM jsonb_populate_recordset(NULL::stock,after_doc->'stock') x WHERE (s.tenant_id,s.warehouse_id,s.product_id)=(x.tenant_id,x.warehouse_id,x.product_id) AND s.reserved<>x.reserved;
 UPDATE wms_layer_positions p SET reserved=x.reserved,version=x.version FROM jsonb_populate_recordset(NULL::wms_layer_positions,after_doc->'positions') x WHERE (p.tenant_id,p.warehouse_id,p.product_id,p.location,p.layer_id)=(x.tenant_id,x.warehouse_id,x.product_id,x.location,x.layer_id) AND p.reserved<>x.reserved;
 IF b2b_dropship_custody_snapshot(o.id) IS DISTINCT FROM after_doc THEN RAISE EXCEPTION 'Zmiana rezerwacji nie odpowiada planowi' USING ERRCODE='23514';END IF;
 UPDATE b2b_dropship_custody_transfers SET applied=true WHERE tenant_id=t AND order_id=did AND kind=CASE WHEN direction=-1 THEN 'release' ELSE 'restore' END;
END $$;
REVOKE ALL ON FUNCTION b2b_dropship_transfer_custody(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_dropship_transfer_custody(uuid,uuid) TO dyna_app;

CREATE FUNCTION b2b_dropship_scope_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE q record;d record;o record;l record;partner record;source_quote record;item record;input_item jsonb;bridge record;BEGIN
 IF TG_TABLE_NAME='b2b_dropship_quotes' THEN
 SELECT * INTO o FROM orders WHERE (tenant_id,id)=(NEW.tenant_id,NEW.customer_order_id);
 SELECT * INTO l FROM b2b_links WHERE (tenant_id,id)=(NEW.tenant_id,NEW.link_id);
 SELECT * INTO source_quote FROM b2b_quotes WHERE (tenant_id,id)=(NEW.supplier_tenant_id,NEW.source_quote_id);
 IF o.id IS NULL OR l.id IS NULL OR source_quote.id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO partner FROM b2b_accounts WHERE (tenant_id,id)=(l.supplier_tenant_id,l.account_id);
 IF l.paused OR NOT partner.active OR partner.payment_mode<>'prepaid' OR l.supplier_tenant_id<>NEW.supplier_tenant_id OR source_quote.account_id<>l.account_id
 OR NEW.snapshot->'customer_header' IS DISTINCT FROM to_jsonb(o)
 OR NEW.snapshot->'receiver' IS DISTINCT FROM jsonb_build_object('customer_name',o.customer_name,'email',o.email,'address',o.address)
 OR NEW.snapshot->'link_version' IS DISTINCT FROM to_jsonb(l.version)
 OR NEW.snapshot->'account_version' IS DISTINCT FROM to_jsonb(partner.version)
 OR NEW.snapshot->'supplier_quote' IS DISTINCT FROM to_jsonb(source_quote)
 OR o.status NOT IN ('new','paid','picking','packed') OR EXISTS(SELECT 1 FROM order_merge_claims WHERE tenant_id=o.tenant_id AND source_order_id=o.id)
 OR jsonb_typeof(NEW.snapshot->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.snapshot->'items')<>jsonb_array_length(NEW.request->'items')
 THEN RAISE EXCEPTION 'Wycena nie odpowiada źródłu klienta lub dostawcy' USING ERRCODE='23514';END IF;
 FOR input_item IN SELECT value FROM jsonb_array_elements(NEW.snapshot->'items') LOOP
 SELECT * INTO item FROM order_items WHERE (tenant_id,order_id,id)=(NEW.tenant_id,NEW.customer_order_id,(input_item->>'customer_item_id')::uuid);
 IF NOT FOUND OR jsonb_array_length(item.components)=0 OR input_item->'components' IS DISTINCT FROM item.components
 OR (input_item->>'quantity')::int<1 OR (input_item->>'quantity')::int>item.quantity-item.scanned
 OR input_item->>'sku' IS DISTINCT FROM item.sku OR input_item->>'name' IS DISTINCT FROM item.name
 OR input_item->'line_total_minor' IS DISTINCT FROM to_jsonb(item.line_total::text)
 OR input_item->'unit_price_minor' IS DISTINCT FROM to_jsonb(item.price::text)
 OR input_item->'vat' IS DISTINCT FROM to_jsonb(item.vat)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.request->'items') req WHERE req->>'customer_item_id'=input_item->>'customer_item_id' AND req->'quantity'=input_item->'quantity' AND req->'mappings'=input_item->'mappings')
 THEN RAISE EXCEPTION 'Pozycja wyceny nie odpowiada historycznej pozycji klienta' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(item.components) component WHERE NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(input_item->'mappings') m JOIN b2b_catalog_items ci ON ci.tenant_id=NEW.tenant_id AND ci.link_id=NEW.link_id AND ci.id=(m->>'catalog_item_id')::uuid
 WHERE ci.published AND ci.product_id=(component->>'product_id')::uuid AND m->>'product_id'=component->>'product_id'))
 OR jsonb_array_length(input_item->'mappings')<>jsonb_array_length(item.components) THEN
 RAISE EXCEPTION 'Mapowanie nie odpowiada całemu zamrożonemu przepisowi' USING ERRCODE='23514';END IF;
 END LOOP;
 ELSIF TG_TABLE_NAME='b2b_dropship_orders' THEN
 IF TG_OP='UPDATE' THEN
 IF to_jsonb(NEW)-ARRAY['state','version','cancelled_at','byte_count'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['state','version','cancelled_at','byte_count'] OR NEW.version<>OLD.version+1 OR OLD.state<>'ordered' OR NEW.state<>'cancelled'
 OR NOT EXISTS(SELECT 1 FROM b2b_dropship_actions WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id AND kind='cancel') THEN RAISE EXCEPTION 'Nieprawidłowa zmiana dropshippingu' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 SELECT * INTO q FROM b2b_dropship_quotes WHERE (tenant_id,id)=(NEW.tenant_id,NEW.quote_id);
 IF q.id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO o FROM orders WHERE (tenant_id,id)=(NEW.tenant_id,NEW.customer_order_id);
 IF q.snapshot->'customer_header' IS DISTINCT FROM to_jsonb(o) OR q.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Zamówienie klienta lub termin wyceny zmieniły się' USING ERRCODE='23514';END IF;
 FOR input_item IN SELECT value FROM jsonb_array_elements(q.snapshot->'items') LOOP
 SELECT * INTO item FROM order_items WHERE (tenant_id,order_id,id)=(NEW.tenant_id,NEW.customer_order_id,(input_item->>'customer_item_id')::uuid);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(input_item->'components') component LEFT JOIN products physical ON physical.tenant_id=NEW.tenant_id AND physical.id=(component->>'product_id')::uuid WHERE physical.id IS NULL OR NOT physical.active OR physical.kind NOT IN('simple','variant')) THEN RAISE EXCEPTION 'Składnik fizyczny kupującego został wyłączony lub zmieniony' USING ERRCODE='23514';END IF;
 IF item.id IS NULL OR item.components IS DISTINCT FROM input_item->'components' OR item.sku IS DISTINCT FROM input_item->>'sku' OR item.name IS DISTINCT FROM input_item->>'name'
 OR item.price::text IS DISTINCT FROM input_item->>'unit_price_minor' OR item.line_total::text IS DISTINCT FROM input_item->>'line_total_minor'
 OR item.vat IS DISTINCT FROM (input_item->>'vat')::int OR (input_item->>'quantity')::int>item.quantity-item.scanned THEN RAISE EXCEPTION 'Historyczna pozycja klienta zmieniła się' USING ERRCODE='23514';END IF;
 END LOOP;

 IF (NEW.link_id,NEW.customer_order_id,NEW.supplier_tenant_id,NEW.actor_id,NEW.api_key_id) IS DISTINCT FROM(q.link_id,q.customer_order_id,q.supplier_tenant_id,q.actor_id,q.api_key_id)
 OR NEW.state<>'ordered' OR NEW.version<>1 OR NEW.request->>'scope_hash' IS DISTINCT FROM q.scope_hash OR NEW.request->'confirmed' IS DISTINCT FROM 'true' OR NEW.request->'confirmed_receiver' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'Checkout nie odpowiada zatwierdzonej wycenie' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='b2b_dropship_lines' THEN
 SELECT * INTO d FROM b2b_dropship_orders WHERE (tenant_id,id)=(NEW.tenant_id,NEW.order_id);IF d.id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO q FROM b2b_dropship_quotes WHERE (tenant_id,id)=(d.tenant_id,d.quote_id);
 IF NEW.customer_order_id<>q.customer_order_id OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.snapshot->'items') x WHERE x->>'customer_item_id'=NEW.customer_item_id::text AND x->'quantity'=to_jsonb(NEW.quantity) AND x->'mappings'=NEW.mappings)
 THEN RAISE EXCEPTION 'Ilość dropshippingu nie odpowiada wycenie' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER scope BEFORE INSERT ON b2b_dropship_quotes FOR EACH ROW EXECUTE FUNCTION b2b_dropship_scope_guard();
CREATE TRIGGER scope BEFORE INSERT OR UPDATE ON b2b_dropship_orders FOR EACH ROW EXECUTE FUNCTION b2b_dropship_scope_guard();
CREATE TRIGGER no_delete BEFORE DELETE ON b2b_dropship_orders FOR EACH ROW EXECUTE FUNCTION b2b_dropship_immutable();
CREATE TRIGGER scope BEFORE INSERT ON b2b_dropship_lines FOR EACH ROW EXECUTE FUNCTION b2b_dropship_scope_guard();
REVOKE ALL ON FUNCTION b2b_dropship_scope_guard() FROM PUBLIC,dyna_app;

CREATE FUNCTION b2b_dropship_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE q record;s record;bridge record;prior_scope text;expected jsonb;actual jsonb;custody record;source_quote record;BEGIN
 prior_scope:=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
 SELECT * INTO q FROM b2b_dropship_quotes WHERE (tenant_id,id)=(NEW.tenant_id,NEW.quote_id);
 SELECT * INTO s FROM orders WHERE (tenant_id,id)=(NEW.supplier_tenant_id,NEW.supplier_order_id);
 SELECT * INTO bridge FROM b2b_dropship_supplier_orders WHERE (tenant_id,order_id,buyer_tenant_id,dropship_order_id)=(NEW.supplier_tenant_id,NEW.supplier_order_id,NEW.tenant_id,NEW.id);
 IF s.id IS NULL OR bridge.order_id IS NULL OR s.b2b_account_id IS DISTINCT FROM (SELECT account_id FROM b2b_links WHERE tenant_id=NEW.tenant_id AND id=NEW.link_id)
 OR (s.customer_name,s.email,s.address) IS DISTINCT FROM(q.snapshot->'receiver'->>'customer_name',q.snapshot->'receiver'->>'email',q.snapshot->'receiver'->'address')
 OR bridge.receiver IS DISTINCT FROM q.snapshot->'receiver' OR bridge.bill_to IS DISTINCT FROM q.snapshot->'wholesale'->'bill_to'
 OR s.payment_mode<>'prepaid' OR s.total::text IS DISTINCT FROM q.snapshot->'wholesale'->>'total_minor' OR s.currency IS DISTINCT FROM q.snapshot->'wholesale'->>'currency'
 THEN RAISE EXCEPTION 'Zamówienie dostawcy nie odpowiada zatwierdzonemu odbiorcy i zobowiązaniu' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('customer_item_id',customer_item_id,'quantity',quantity,'mappings',mappings) ORDER BY customer_item_id),'[]') INTO actual FROM b2b_dropship_lines WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('customer_item_id',value->'customer_item_id','quantity',value->'quantity','mappings',value->'mappings') ORDER BY value->>'customer_item_id'),'[]') INTO expected FROM jsonb_array_elements(q.snapshot->'items');
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Niepełne pozycje checkout' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM b2b_dropship_lines l JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(l.tenant_id,l.order_id) JOIN order_items i ON(i.tenant_id,i.order_id,i.id)=(l.tenant_id,l.customer_order_id,l.customer_item_id)
 WHERE l.tenant_id=NEW.tenant_id AND l.customer_order_id=NEW.customer_order_id AND d.state='ordered' GROUP BY i.id,i.quantity HAVING sum(l.quantity)>i.quantity) THEN RAISE EXCEPTION 'Przekroczona ilość pozycji klienta' USING ERRCODE='23514';END IF;
 SELECT * INTO source_quote FROM b2b_quotes WHERE tenant_id=NEW.supplier_tenant_id AND id=q.source_quote_id;
 IF source_quote.order_id IS DISTINCT FROM NEW.supplier_order_id OR NOT EXISTS(SELECT 1 FROM b2b_dropship_created_orders
 WHERE tenant_id=NEW.supplier_tenant_id AND order_id=NEW.supplier_order_id AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp()) THEN
 RAISE EXCEPTION 'Dropshipping wymaga nowego zamówienia z tej wyceny' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('source_product_id',product_id,'sku',sku,'name',name,'quantity',quantity,'vat',vat,'unit_gross_minor',price::text,'line_total_minor',line_total::text) ORDER BY product_id),'[]') INTO actual
 FROM order_items WHERE tenant_id=NEW.supplier_tenant_id AND order_id=NEW.supplier_order_id;
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'source_product_id'),'[]') INTO expected FROM jsonb_array_elements(q.snapshot->'wholesale'->'items');
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Pozycje dostawcy nie odpowiadają zatwierdzonej wycenie' USING ERRCODE='23514';END IF;
 DELETE FROM b2b_dropship_created_orders WHERE tenant_id=NEW.supplier_tenant_id AND order_id=NEW.supplier_order_id;
 SELECT * INTO custody FROM b2b_dropship_custody_transfers WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id AND kind='release';
 IF NOT FOUND OR NOT custody.applied THEN RAISE EXCEPTION 'Checkout wymaga rzeczywistego przeniesienia rezerwacji' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;END $$;
CREATE CONSTRAINT TRIGGER complete AFTER INSERT ON b2b_dropship_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_dropship_complete();
CREATE FUNCTION b2b_dropship_custody_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d record;prior_scope text;actual jsonb;k text;BEGIN
 prior_scope:=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
 SELECT * INTO d FROM b2b_dropship_orders WHERE (tenant_id,id)=(NEW.tenant_id,NEW.order_id);
 actual:=b2b_dropship_custody_snapshot(d.customer_order_id);
 FOREACH k IN ARRAY ARRAY['reservations','locations','layers','picks','stock','bins','positions'] LOOP
 IF actual->k IS DISTINCT FROM NEW.after_snapshot->k THEN RAISE EXCEPTION 'Niepełna zmiana rezerwacji dropshippingu' USING ERRCODE='23514';END IF;END LOOP;
 PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;END $$;
CREATE CONSTRAINT TRIGGER custody_complete AFTER INSERT ON b2b_dropship_custody_transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_dropship_custody_complete();
REVOKE ALL ON FUNCTION b2b_dropship_complete(),b2b_dropship_custody_complete() FROM PUBLIC,dyna_app;

-- Actual INSERT provenance is private and savepoint-safe; xmin alone is not a
-- transaction certificate (subtransactions have distinct tuple xmins).
CREATE TABLE b2b_dropship_created_orders (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,transaction_id xid8 NOT NULL,
 transaction_started_at timestamptz NOT NULL,PRIMARY KEY(tenant_id,order_id)
);
ALTER TABLE b2b_dropship_created_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_dropship_created_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY certificate_owner ON b2b_dropship_created_orders TO CURRENT_USER USING(true) WITH CHECK(true);
REVOKE ALL ON b2b_dropship_created_orders FROM PUBLIC,dyna_app;
CREATE FUNCTION b2b_dropship_order_created() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF NEW.source='b2b' THEN INSERT INTO b2b_dropship_created_orders VALUES(NEW.tenant_id,NEW.id,pg_current_xact_id(),transaction_timestamp());END IF;RETURN NEW;END $$;
CREATE TRIGGER dropship_created AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION b2b_dropship_order_created();
CREATE FUNCTION b2b_dropship_certificate_cleanup() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM b2b_dropship_supplier_orders WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id) THEN
 DELETE FROM b2b_dropship_created_orders WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id;END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER certificate_cleanup AFTER INSERT ON b2b_dropship_created_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_dropship_certificate_cleanup();
REVOKE ALL ON FUNCTION b2b_dropship_order_created(),b2b_dropship_certificate_cleanup() FROM PUBLIC,dyna_app;

-- Preserve a completed typed transfer through an early constraint flush. A
-- later write in the same transaction cannot invalidate its terminal proof.
-- Future transactions (including restored xid counters) are unaffected.
CREATE FUNCTION b2b_dropship_custody_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid;BEGIN
 t:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
 IF EXISTS(SELECT 1 FROM b2b_dropship_custody_transfers WHERE tenant_id=t AND applied
 AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp()) THEN
 RAISE EXCEPTION 'Zakończonego przeniesienia rezerwacji nie można zmienić w tej transakcji' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END $$;
DO $$ DECLARE tbl text;BEGIN
 FOREACH tbl IN ARRAY ARRAY['stock','stock_locations','wms_layer_positions','reservations','reservation_locations','wms_reservation_layers','order_pick_items'] LOOP
 EXECUTE format('CREATE TRIGGER dropship_custody_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION b2b_dropship_custody_seal()',tbl);
 END LOOP;END $$;
REVOKE ALL ON FUNCTION b2b_dropship_custody_seal() FROM PUBLIC,dyna_app;

-- A supplier may edit ordinary metadata, but the approved consumer receiver is
-- immutable for this wholesale fulfillment. Never infer dispatch from a marker
-- whose actual OMS address has subsequently changed.
CREATE FUNCTION b2b_dropship_receiver_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE binding record;BEGIN
 SELECT * INTO binding FROM b2b_dropship_supplier_orders WHERE tenant_id=OLD.tenant_id AND order_id=OLD.id;
 IF FOUND AND (NEW.customer_name,NEW.email,NEW.address) IS DISTINCT FROM (binding.receiver->>'customer_name',binding.receiver->>'email',binding.receiver->'address') THEN
 RAISE EXCEPTION 'Odbiorca dostawy dropshippingowej jest zamrożony' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM b2b_dropship_orders d JOIN b2b_dropship_quotes q ON(q.tenant_id,q.id)=(d.tenant_id,d.quote_id)
 WHERE d.tenant_id=OLD.tenant_id AND d.customer_order_id=OLD.id AND d.state='ordered'
 AND (NEW.customer_name,NEW.email,NEW.address) IS DISTINCT FROM(q.snapshot#>>'{receiver,customer_name}',q.snapshot#>>'{receiver,email}',q.snapshot#>'{receiver,address}')) THEN
 RAISE EXCEPTION 'Odbiorca dostawy dropshippingowej jest zamrożony' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER dropship_receiver BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION b2b_dropship_receiver_guard();
REVOKE ALL ON FUNCTION b2b_dropship_receiver_guard() FROM PUBLIC,dyna_app;
CREATE FUNCTION b2b_dropship_fulfillment(oid uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'link_id',d.link_id,'supplier_number',o.number,'state',d.state,'supplier_status',o.status,
 'dispatched',EXISTS(SELECT 1 FROM shipments sh JOIN shopify_dispatch_evidence e ON(e.tenant_id,e.shipment_id,e.order_id)=(sh.tenant_id,sh.id,sh.order_id)
 WHERE sh.tenant_id=o.tenant_id AND sh.order_id=o.id AND sh.dispatched_at IS NOT NULL AND e.receiver IS NOT NULL AND e.receiver=b.receiver)
 AND (o.customer_name,o.email,o.address) IS NOT DISTINCT FROM(b.receiver->>'customer_name',b.receiver->>'email',b.receiver->'address'),
 'shipments',coalesce((SELECT jsonb_agg(jsonb_build_object('carrier',sh.carrier,'tracking_number',sh.tracking_number,'status',sh.status,'mode',sh.mode,'dispatched_at',sh.dispatched_at) ORDER BY sh.id) FROM shipments sh WHERE sh.tenant_id=o.tenant_id AND sh.order_id=o.id),'[]'::jsonb)) ORDER BY d.id),'[]'::jsonb)
 FROM b2b_dropship_orders d JOIN orders o ON(o.tenant_id,o.id)=(d.supplier_tenant_id,d.supplier_order_id)
 JOIN b2b_dropship_supplier_orders b ON(b.tenant_id,b.order_id)=(o.tenant_id,o.id)
 WHERE d.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND d.customer_order_id=oid
$$;
REVOKE ALL ON FUNCTION b2b_dropship_fulfillment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_dropship_fulfillment(uuid) TO dyna_app;
CREATE FUNCTION b2b_dropship_action_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d record;s record;scope_before text;receiver jsonb;BEGIN
 scope_before:=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
 SELECT * INTO d FROM b2b_dropship_orders WHERE (tenant_id,id)=(NEW.tenant_id,NEW.order_id);
 IF d.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO s FROM orders WHERE (tenant_id,id)=(d.supplier_tenant_id,d.supplier_order_id);
 IF NEW.request->'confirmed' IS DISTINCT FROM 'true' OR b2b_dropship_current_role(NEW.actor_id,false) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Brak aktualnego zatwierdzenia operacji' USING ERRCODE='23514';END IF;
 IF NEW.kind='cancel' THEN
 IF d.state<>'cancelled' OR s.status<>'cancelled' OR (NEW.request->>'version')::int<>d.version-1
 OR NEW.result IS DISTINCT FROM jsonb_build_object('supplier_order_id',s.id,'customer_order_id',d.customer_order_id)
 OR EXISTS(SELECT 1 FROM shipments WHERE tenant_id=d.supplier_tenant_id AND order_id=s.id AND dispatched_at IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM b2b_dropship_custody_transfers WHERE tenant_id=d.tenant_id AND order_id=d.id AND kind='restore' AND action_id=NEW.id AND applied)
 THEN RAISE EXCEPTION 'Anulowanie wymaga rzeczywistego przywrócenia rezerwacji i anulowania dostawcy' USING ERRCODE='23514';END IF;
 ELSE
 IF d.state<>'ordered' OR (NEW.request->>'version')::int<>d.version
 OR NEW.result->>'customer_order_id' IS DISTINCT FROM d.customer_order_id::text
 OR NOT EXISTS(SELECT 1 FROM orders WHERE tenant_id=d.tenant_id AND id=d.customer_order_id AND status IN('shipped','delivered','completed'))
 OR EXISTS(SELECT 1 FROM reservations WHERE tenant_id=d.tenant_id AND order_id=d.customer_order_id AND state='active')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(b2b_dropship_fulfillment(d.customer_order_id)) f WHERE f->>'state'='ordered' AND f->'dispatched' IS DISTINCT FROM 'true')
 THEN RAISE EXCEPTION 'Uzgodnienie wymaga rzeczywistych wydań wszystkich części' USING ERRCODE='23514';END IF;
 END IF;
 PERFORM set_config('app.tenant_id',coalesce(scope_before,''),true);RETURN NULL;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(scope_before,''),true);RAISE;END $$;
CREATE CONSTRAINT TRIGGER action_complete AFTER INSERT ON b2b_dropship_actions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_dropship_action_complete();
REVOKE ALL ON FUNCTION b2b_dropship_action_complete() FROM PUBLIC,dyna_app;
CREATE FUNCTION b2b_dropship_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM migrations WHERE name='108_b2b_dropshipping')
$$;
REVOKE ALL ON FUNCTION b2b_dropship_installed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_dropship_installed() TO dyna_app;
