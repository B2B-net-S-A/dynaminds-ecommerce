-- Dedicated external intent; migration108 and all its historical proofs remain unchanged.
CREATE TABLE b2b_external_order_intents(
 tenant_id uuid NOT NULL,id uuid PRIMARY KEY,order_id uuid NOT NULL,actor_id uuid NOT NULL,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),initial_request jsonb NOT NULL,
 original_items jsonb NOT NULL CHECK(jsonb_typeof(original_items)='array' AND jsonb_array_length(original_items)>=1 AND jsonb_array_length(original_items)<=100),
 allocations jsonb NOT NULL CHECK(jsonb_typeof(allocations)='array' AND jsonb_array_length(allocations)>=1 AND jsonb_array_length(allocations)<=100),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),state text NOT NULL DEFAULT 'open' CHECK(state IN('open','closed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count bigint NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,order_id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(actor_id) REFERENCES users(id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE b2b_external_order_intent_revisions(
 tenant_id uuid NOT NULL,id uuid PRIMARY KEY,intent_id uuid NOT NULL,actor_id uuid NOT NULL,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),request jsonb NOT NULL,
 kind text NOT NULL CHECK(kind IN('create','allocate','close','reopen','commit','uncommit')),
 version integer NOT NULL CHECK(version>0),before_snapshot jsonb,after_snapshot jsonb NOT NULL,
 dropship_order_id uuid,action_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count bigint NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,intent_id,version),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,dropship_order_id,kind),
 FOREIGN KEY(tenant_id,intent_id) REFERENCES b2b_external_order_intents(tenant_id,id),FOREIGN KEY(actor_id) REFERENCES users(id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 FOREIGN KEY(tenant_id,dropship_order_id) REFERENCES b2b_dropship_orders(tenant_id,id),FOREIGN KEY(tenant_id,action_id) REFERENCES b2b_dropship_actions(tenant_id,id)
);
CREATE TABLE b2b_external_order_allocation_proofs(
 tenant_id uuid NOT NULL,revision_id uuid PRIMARY KEY,order_id uuid NOT NULL,transaction_id xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,
 before_snapshot jsonb NOT NULL,after_snapshot jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),kind text NOT NULL CHECK(kind IN('create','allocate','reopen')),before_intent_snapshot jsonb,allocation_snapshot jsonb NOT NULL,applied boolean NOT NULL DEFAULT false,byte_count bigint NOT NULL DEFAULT 0,
 FOREIGN KEY(tenant_id,revision_id) REFERENCES b2b_external_order_intent_revisions(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
CREATE TABLE b2b_external_order_created_orders(
 tenant_id uuid NOT NULL,order_id uuid PRIMARY KEY,transaction_id xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX b2b_external_order_intent_page ON b2b_external_order_intents(tenant_id,order_id);
CREATE INDEX b2b_external_order_revision_page ON b2b_external_order_intent_revisions(tenant_id,intent_id,version);
DO $$DECLARE n text;BEGIN FOREACH n IN ARRAY ARRAY['b2b_external_order_intents','b2b_external_order_intent_revisions','b2b_external_order_allocation_proofs','b2b_external_order_created_orders'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',n);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY owner ON %I TO CURRENT_USER USING(true) WITH CHECK(true)',n);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',n);
 IF n IN('b2b_external_order_intents','b2b_external_order_intent_revisions') THEN
 EXECUTE format('CREATE POLICY own ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',n);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',n);END IF;
 IF n='b2b_external_order_intents' THEN EXECUTE format('GRANT UPDATE ON %I TO dyna_app',n);END IF;
 IF n<>'b2b_external_order_created_orders' THEN EXECUTE format('CREATE TRIGGER bytes BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION b2b_dropship_bytes()',n);END IF;
 END LOOP;END $$;
CREATE FUNCTION b2b_external_order_created() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF NEW.source IN('manual','demo') THEN INSERT INTO b2b_external_order_created_orders VALUES(NEW.tenant_id,NEW.id,pg_current_xact_id(),transaction_timestamp());END IF;RETURN NEW;END $$;
CREATE TRIGGER external_order_created AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION b2b_external_order_created();
CREATE FUNCTION b2b_external_order_created_cleanup() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 DELETE FROM b2b_external_order_created_orders WHERE order_id=NEW.order_id;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER created_cleanup AFTER INSERT ON b2b_external_order_created_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_external_order_created_cleanup();
REVOKE ALL ON FUNCTION b2b_external_order_created(),b2b_external_order_created_cleanup() FROM PUBLIC,dyna_app;
CREATE FUNCTION b2b_external_intent_snapshot(i b2b_external_order_intents) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$SELECT jsonb_build_object('version',i.version,'state',i.state,'allocations',i.allocations)$$;
REVOKE ALL ON FUNCTION b2b_external_intent_snapshot(b2b_external_order_intents) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_external_intent_snapshot(b2b_external_order_intents) TO dyna_app;
CREATE FUNCTION b2b_external_intent_scope() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a jsonb;i record;h b2b_external_order_intents%ROWTYPE;l record;before_doc jsonb;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Historia intencji jest niezmienna' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='b2b_external_order_intents' THEN
 IF TG_OP='UPDATE' THEN
 IF to_jsonb(NEW)-ARRAY['version','state','allocations','updated_at','byte_count'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['version','state','allocations','updated_at','byte_count'] OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Nieprawidłowa rewizja intencji' USING ERRCODE='23514';END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM b2b_external_order_created_orders WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Intencja wymaga nowego własnego zamówienia' USING ERRCODE='23514';END IF;
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
CREATE TRIGGER scope BEFORE INSERT OR UPDATE OR DELETE ON b2b_external_order_intents FOR EACH ROW EXECUTE FUNCTION b2b_external_intent_scope();
CREATE TRIGGER scope BEFORE INSERT OR UPDATE OR DELETE ON b2b_external_order_intent_revisions FOR EACH ROW EXECUTE FUNCTION b2b_external_intent_scope();
REVOKE ALL ON FUNCTION b2b_external_intent_scope() FROM PUBLIC,dyna_app;
CREATE FUNCTION b2b_external_intent_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h b2b_external_order_intents%ROWTYPE;r record;expected jsonb;actual jsonb;BEGIN
 SELECT * INTO h FROM b2b_external_order_intents WHERE (tenant_id,id)=(NEW.tenant_id,NEW.id);
 SELECT * INTO r FROM b2b_external_order_intent_revisions WHERE tenant_id=h.tenant_id AND intent_id=h.id AND version=h.version;
 IF NOT FOUND OR r.after_snapshot IS DISTINCT FROM b2b_external_intent_snapshot(h) THEN RAISE EXCEPTION 'Brak trwałej rewizji intencji' USING ERRCODE='23514';END IF;
 IF h.state='open' AND NOT EXISTS(SELECT 1 FROM shipments WHERE tenant_id=h.tenant_id AND order_id=h.order_id AND dispatched_at IS NOT NULL) THEN
 SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'quantity',quantity) ORDER BY product_id),'[]') INTO expected FROM(
 SELECT (c->>'product_id')::uuid product_id,sum((c->>'quantity')::bigint*(a->>'local_quantity')::bigint)::bigint quantity FROM jsonb_array_elements(h.original_items) oi JOIN jsonb_array_elements(h.allocations) a ON a->>'customer_item_id'=oi->>'id' CROSS JOIN LATERAL jsonb_array_elements(oi->'components') c GROUP BY (c->>'product_id')::uuid HAVING sum((c->>'quantity')::bigint*(a->>'local_quantity')::bigint)>0) x;
 SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'quantity',quantity) ORDER BY product_id),'[]') INTO actual FROM reservations WHERE tenant_id=h.tenant_id AND order_id=h.order_id AND state='active';
 IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'Fizyczna rezerwacja nie odpowiada lokalnemu przydziałowi' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER complete AFTER INSERT OR UPDATE ON b2b_external_order_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_external_intent_complete();
REVOKE ALL ON FUNCTION b2b_external_intent_complete() FROM PUBLIC,dyna_app;
CREATE FUNCTION b2b_external_array_upsert(doc jsonb,row_json jsonb,identity_keys text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'product_id',value->>'location',value->>'layer_id'),'[]') FROM (
 SELECT value FROM jsonb_array_elements(doc) old WHERE EXISTS(SELECT 1 FROM unnest(identity_keys) k WHERE old.value->k IS DISTINCT FROM row_json->k)
 UNION ALL SELECT row_json) x
$$;
REVOKE ALL ON FUNCTION b2b_external_array_upsert(jsonb,jsonb,text[]) FROM PUBLIC,dyna_app;
CREATE FUNCTION b2b_external_allocate(oid uuid,rid uuid,uid uuid,alloc jsonb,reopening boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;h b2b_external_order_intents%ROWTYPE;o record;r record;a record;p record;b record;
 before_doc jsonb;after_doc jsonb;new_layers jsonb:='[]';new_locations jsonb:='[]';new_picks jsonb:='[]';new_reservations jsonb:='[]';row_json jsonb;old_json jsonb;
 desired jsonb;remaining bigint;take int;old_quantity int;scanned_count int;old_piece int;new_piece int;delta int;wms boolean;BEGIN
 IF b2b_dropship_current_role(uid,false) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Brak aktualnej zgody administratora' USING ERRCODE='23514';END IF;
 SELECT * INTO o FROM orders WHERE tenant_id=t AND id=oid FOR UPDATE;
 SELECT * INTO h FROM b2b_external_order_intents WHERE tenant_id=t AND order_id=oid FOR UPDATE;
 IF h.id IS NULL OR o.status NOT IN('new','paid','picking','packed','cancelled') OR EXISTS(SELECT 1 FROM shipments WHERE tenant_id=t AND order_id=oid) OR EXISTS(SELECT 1 FROM return_cases WHERE tenant_id=t AND order_id=oid) OR EXISTS(SELECT 1 FROM order_merge_claims WHERE tenant_id=t AND source_order_id=oid) THEN RAISE EXCEPTION 'Przydział wymaga niewydanego własnego zamówienia' USING ERRCODE='23514';END IF;
 IF reopening IS DISTINCT FROM (h.state='closed' AND o.status='cancelled') THEN RAISE EXCEPTION 'Stan otwarcia intencji zmienił się' USING ERRCODE='23514';END IF;
 PERFORM id FROM products WHERE tenant_id=t AND id IN(SELECT (c->>'product_id')::uuid FROM jsonb_array_elements(h.original_items) i CROSS JOIN LATERAL jsonb_array_elements(i->'components') c) ORDER BY id FOR SHARE;
 PERFORM product_id FROM stock WHERE tenant_id=t AND warehouse_id=o.warehouse_id AND product_id IN(SELECT (c->>'product_id')::uuid FROM jsonb_array_elements(h.original_items) i CROSS JOIN LATERAL jsonb_array_elements(i->'components') c) ORDER BY product_id FOR UPDATE;
 PERFORM product_id FROM stock_locations WHERE tenant_id=t AND warehouse_id=o.warehouse_id AND product_id IN(SELECT (c->>'product_id')::uuid FROM jsonb_array_elements(h.original_items) i CROSS JOIN LATERAL jsonb_array_elements(i->'components') c) ORDER BY product_id,location FOR UPDATE;
 PERFORM product_id FROM reservations WHERE tenant_id=t AND order_id=oid ORDER BY product_id FOR UPDATE;
 PERFORM product_id FROM order_pick_items WHERE tenant_id=t AND order_id=oid ORDER BY product_id FOR UPDATE;
 PERFORM product_id FROM reservation_locations WHERE tenant_id=t AND order_id=oid ORDER BY product_id,location FOR UPDATE;
 PERFORM product_id FROM wms_reservation_layers WHERE tenant_id=t AND order_id=oid ORDER BY product_id,location,layer_id FOR UPDATE;
 PERFORM product_id FROM wms_layer_positions WHERE tenant_id=t AND warehouse_id=o.warehouse_id AND product_id IN(SELECT (c->>'product_id')::uuid FROM jsonb_array_elements(h.original_items) i CROSS JOIN LATERAL jsonb_array_elements(i->'components') c) ORDER BY product_id,location,layer_id FOR UPDATE;
 before_doc:=b2b_dropship_custody_snapshot(oid);after_doc:=before_doc;
 SELECT coalesce(enabled,false) INTO wms FROM wms_policies WHERE tenant_id=t;
 SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'quantity',quantity) ORDER BY product_id),'[]') INTO desired FROM (
 SELECT (c->>'product_id')::uuid product_id,sum((c->>'quantity')::bigint*(v->>'local_quantity')::bigint) quantity FROM jsonb_array_elements(h.original_items) i JOIN jsonb_array_elements(alloc) v ON v->>'customer_item_id'=i->>'id' CROSS JOIN LATERAL jsonb_array_elements(i->'components') c GROUP BY (c->>'product_id')::uuid) x;
 FOR r IN SELECT * FROM jsonb_to_recordset(desired) x(product_id uuid,quantity bigint) ORDER BY product_id LOOP
 SELECT * INTO p FROM products WHERE tenant_id=t AND id=r.product_id;
 SELECT coalesce(sum(quantity),0)::int INTO old_quantity FROM reservations WHERE tenant_id=t AND order_id=oid AND product_id=r.product_id AND state='active';
 SELECT coalesce(sum(scanned),0)::int INTO scanned_count FROM order_pick_items WHERE tenant_id=t AND order_id=oid AND product_id=r.product_id;
 IF reopening THEN scanned_count:=0;END IF;
 IF r.quantity<scanned_count OR r.quantity>10000000 OR NOT p.active OR p.kind NOT IN('simple','variant') THEN RAISE EXCEPTION 'Przydział narusza zeskanowaną lub fizyczną ilość' USING ERRCODE='23514';END IF;
 SELECT * INTO b FROM stock WHERE tenant_id=t AND warehouse_id=o.warehouse_id AND product_id=r.product_id;
 IF r.quantity>old_quantity AND (b.product_id IS NULL OR b.available<r.quantity-old_quantity) THEN RAISE EXCEPTION 'Za mało własnego towaru dla lokalnego przydziału' USING ERRCODE='23514';END IF;
 IF r.quantity>0 THEN
 old_json:=(SELECT value FROM jsonb_array_elements(before_doc->'picks') WHERE value->>'product_id'=r.product_id::text);
 row_json:=coalesce(old_json,jsonb_build_object('id',gen_random_uuid(),'tenant_id',t,'order_id',oid,'product_id',r.product_id,'sku',p.sku,'name',p.name,'ean',coalesce(p.ean,'')))||jsonb_build_object('quantity',r.quantity,'scanned',scanned_count);
 new_picks:=new_picks||jsonb_build_array(row_json);
 new_reservations:=new_reservations||jsonb_build_array(jsonb_build_object('tenant_id',t,'order_id',oid,'product_id',r.product_id,'warehouse_id',o.warehouse_id,'quantity',r.quantity,'state','active'));
 END IF;
 remaining:=r.quantity;
 IF wms THEN
 -- Retain original oldest allocation identities; remove only unscanned tail.
 FOR a IN SELECT l.* FROM wms_reservation_layers l JOIN wms_cost_layers cost ON(cost.tenant_id,cost.id)=(l.tenant_id,l.layer_id) WHERE l.tenant_id=t AND l.order_id=oid AND l.product_id=r.product_id AND l.state='active' ORDER BY cost.fifo_sequence,l.layer_id,l.location COLLATE "C" LOOP
 take:=least(remaining,a.quantity);IF take<a.scanned THEN RAISE EXCEPTION 'Przydział narusza zeskanowaną warstwę' USING ERRCODE='23514';END IF;
 IF take>0 THEN new_layers:=new_layers||jsonb_build_array(to_jsonb(a)||jsonb_build_object('quantity',take));remaining:=remaining-take;END IF;
 END LOOP;
 FOR a IN SELECT pos.*,cost.fifo_sequence FROM wms_layer_positions pos JOIN wms_cost_layers cost ON(cost.tenant_id,cost.id)=(pos.tenant_id,pos.layer_id) WHERE pos.tenant_id=t AND pos.warehouse_id=o.warehouse_id AND pos.product_id=r.product_id ORDER BY cost.fifo_sequence,pos.layer_id,pos.location COLLATE "C" LOOP
 EXIT WHEN remaining=0;take:=least(remaining,a.quantity-a.reserved);IF take>0 THEN
 old_json:=(SELECT value FROM jsonb_array_elements(new_layers) WHERE value->>'product_id'=r.product_id::text AND value->>'location'=a.location AND value->>'layer_id'=a.layer_id::text);
 row_json:=coalesce(old_json,jsonb_build_object('tenant_id',t,'order_id',oid,'product_id',r.product_id,'warehouse_id',o.warehouse_id,'location',a.location,'layer_id',a.layer_id,'quantity',0,'scanned',0,'state','active'));
 row_json:=row_json||jsonb_build_object('quantity',(row_json->>'quantity')::int+take);
 new_layers:=b2b_external_array_upsert(new_layers,row_json,ARRAY['product_id','location','layer_id']);remaining:=remaining-take;
 END IF;END LOOP;
 ELSE
 FOR a IN SELECT * FROM reservation_locations WHERE tenant_id=t AND order_id=oid AND product_id=r.product_id AND NOT reopening ORDER BY location COLLATE "C" LOOP
 take:=least(remaining,a.quantity);IF take<a.scanned THEN RAISE EXCEPTION 'Przydział narusza zeskanowany pojemnik' USING ERRCODE='23514';END IF;
 IF take>0 THEN new_locations:=new_locations||jsonb_build_array(to_jsonb(a)||jsonb_build_object('quantity',take));remaining:=remaining-take;END IF;END LOOP;
 FOR a IN SELECT bins.*,bins.quantity-coalesce((SELECT sum(q.quantity) FROM reservation_locations q JOIN reservations rv USING(tenant_id,order_id,product_id,warehouse_id) WHERE (q.tenant_id,q.warehouse_id,q.product_id,q.location)=(bins.tenant_id,bins.warehouse_id,bins.product_id,bins.location) AND rv.state='active'),0) free FROM stock_locations bins WHERE bins.tenant_id=t AND bins.warehouse_id=o.warehouse_id AND bins.product_id=r.product_id ORDER BY bins.location COLLATE "C" LOOP
 EXIT WHEN remaining=0;take:=least(remaining,a.free);IF take>0 THEN
 old_json:=(SELECT value FROM jsonb_array_elements(new_locations) WHERE value->>'product_id'=r.product_id::text AND value->>'location'=a.location);
 row_json:=coalesce(old_json,jsonb_build_object('tenant_id',t,'order_id',oid,'product_id',r.product_id,'warehouse_id',o.warehouse_id,'location',a.location,'quantity',0,'scanned',0));
 row_json:=row_json||jsonb_build_object('quantity',(row_json->>'quantity')::int+take);
 new_locations:=b2b_external_array_upsert(new_locations,row_json,ARRAY['product_id','location']);remaining:=remaining-take;
 END IF;END LOOP;
 END IF;
 IF remaining<>0 THEN RAISE EXCEPTION 'Brak dostępnych pojemników lub warstw dla przydziału' USING ERRCODE='23514';END IF;
 IF b.product_id IS NOT NULL AND r.quantity<>old_quantity THEN
 row_json:=to_jsonb(b)||jsonb_build_object('reserved',b.reserved+r.quantity-old_quantity,'available',b.on_hand-b.reserved-r.quantity+old_quantity,'version',(b.version+1)::text);
 after_doc:=jsonb_set(after_doc,'{stock}',b2b_external_array_upsert(after_doc->'stock',row_json,ARRAY['product_id']));END IF;
 END LOOP;
 IF wms THEN
 SELECT coalesce(jsonb_agg(jsonb_build_object('tenant_id',t,'order_id',oid,'product_id',product_id,'warehouse_id',o.warehouse_id,'location',location,'quantity',quantity,'scanned',scanned) ORDER BY product_id,location),'[]') INTO new_locations FROM(SELECT (x->>'product_id')::uuid product_id,x->>'location' location,sum((x->>'quantity')::int)::int quantity,sum((x->>'scanned')::int)::int scanned FROM jsonb_array_elements(new_layers) x GROUP BY (x->>'product_id')::uuid,x->>'location') grouped_bins;
 FOR a IN SELECT * FROM wms_layer_positions WHERE tenant_id=t AND warehouse_id=o.warehouse_id AND product_id IN(SELECT (value->>'product_id')::uuid FROM jsonb_array_elements(desired)) ORDER BY product_id,location,layer_id LOOP
 SELECT coalesce(sum((value->>'quantity')::int),0)::int INTO old_piece FROM jsonb_array_elements(before_doc->'layers') WHERE value->>'product_id'=a.product_id::text AND value->>'location'=a.location AND value->>'layer_id'=a.layer_id::text AND value->>'state'='active';
 SELECT coalesce(sum((value->>'quantity')::int),0)::int INTO new_piece FROM jsonb_array_elements(new_layers) WHERE value->>'product_id'=a.product_id::text AND value->>'location'=a.location AND value->>'layer_id'=a.layer_id::text;
 IF old_piece<>new_piece THEN after_doc:=jsonb_set(after_doc,'{positions}',b2b_external_array_upsert(after_doc->'positions',to_jsonb(a)||jsonb_build_object('reserved',a.reserved+new_piece-old_piece,'version',(a.version+1)::text),ARRAY['product_id','location','layer_id']));END IF;
 END LOOP;
 END IF;
 after_doc:=after_doc||jsonb_build_object('reservations',new_reservations,'picks',new_picks,'locations',new_locations,'layers',new_layers);
 INSERT INTO b2b_external_order_allocation_proofs(tenant_id,revision_id,order_id,transaction_id,transaction_started_at,before_snapshot,after_snapshot,actor_id,kind,before_intent_snapshot,allocation_snapshot) VALUES(t,rid,oid,pg_current_xact_id(),transaction_timestamp(),before_doc,after_doc,uid,CASE WHEN reopening THEN 'reopen' ELSE 'allocate' END,b2b_external_intent_snapshot(h),alloc);
 -- All target rows were derived while stock/bin/layer locks were held.
 DELETE FROM wms_reservation_layers WHERE tenant_id=t AND order_id=oid AND NOT EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::wms_reservation_layers,new_layers) x WHERE x.product_id=wms_reservation_layers.product_id AND x.location=wms_reservation_layers.location AND x.layer_id=wms_reservation_layers.layer_id);
 DELETE FROM reservation_locations WHERE tenant_id=t AND order_id=oid AND NOT EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::reservation_locations,new_locations) x WHERE x.product_id=reservation_locations.product_id AND x.location=reservation_locations.location);
 DELETE FROM reservations WHERE tenant_id=t AND order_id=oid AND NOT EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::reservations,new_reservations) x WHERE x.product_id=reservations.product_id);
 DELETE FROM order_pick_items WHERE tenant_id=t AND order_id=oid AND NOT EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::order_pick_items,new_picks) x WHERE x.product_id=order_pick_items.product_id);
 INSERT INTO reservations SELECT * FROM jsonb_populate_recordset(NULL::reservations,new_reservations) ON CONFLICT(tenant_id,order_id,product_id) DO UPDATE SET quantity=excluded.quantity,state=excluded.state;
 INSERT INTO reservation_locations SELECT * FROM jsonb_populate_recordset(NULL::reservation_locations,new_locations) ON CONFLICT(tenant_id,order_id,product_id,location) DO UPDATE SET quantity=excluded.quantity,scanned=excluded.scanned;
 INSERT INTO wms_reservation_layers SELECT * FROM jsonb_populate_recordset(NULL::wms_reservation_layers,new_layers) ON CONFLICT(tenant_id,order_id,product_id,warehouse_id,location,layer_id) DO UPDATE SET quantity=excluded.quantity,scanned=excluded.scanned,state=excluded.state;
 INSERT INTO order_pick_items SELECT * FROM jsonb_populate_recordset(NULL::order_pick_items,new_picks) ON CONFLICT(tenant_id,order_id,product_id) DO UPDATE SET quantity=excluded.quantity,scanned=excluded.scanned;
 UPDATE stock s SET reserved=x.reserved FROM jsonb_populate_recordset(NULL::stock,after_doc->'stock') x WHERE (s.tenant_id,s.warehouse_id,s.product_id)=(x.tenant_id,x.warehouse_id,x.product_id) AND s.reserved<>x.reserved;
 UPDATE wms_layer_positions pos SET reserved=x.reserved,version=x.version FROM jsonb_populate_recordset(NULL::wms_layer_positions,after_doc->'positions') x WHERE (pos.tenant_id,pos.warehouse_id,pos.product_id,pos.location,pos.layer_id)=(x.tenant_id,x.warehouse_id,x.product_id,x.location,x.layer_id) AND pos.reserved<>x.reserved;
 IF b2b_dropship_custody_snapshot(oid) IS DISTINCT FROM after_doc THEN RAISE EXCEPTION 'Niepełny fizyczny przydział intencji' USING ERRCODE='23514';END IF;
 UPDATE b2b_external_order_allocation_proofs SET applied=true WHERE revision_id=rid;
END $$;
REVOKE ALL ON FUNCTION b2b_external_allocate(uuid,uuid,uuid,jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_external_allocate(uuid,uuid,uuid,jsonb,boolean) TO dyna_app;
-- Extend only the typed immutable-layer admission. The complete108 branch remains intact.
DO $$DECLARE f text;BEGIN f:=pg_get_functiondef('public.b2b_dropship_wms_change_allowed(jsonb,jsonb,text)'::regprocedure);
 -- SQL body ends after the old EXISTS expression; add a disjoint own derived proof.
 f:=replace(f,E' ELSE p.after_snapshot->''layers'' @> jsonb_build_array(new_row) END)', E' ELSE p.after_snapshot->''layers'' @> jsonb_build_array(new_row) END) OR EXISTS(SELECT 1 FROM public.b2b_external_order_allocation_proofs proof WHERE proof.tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid AND proof.order_id=(coalesce(new_row,old_row)->>''order_id'')::uuid AND proof.tenant_id=(coalesce(new_row,old_row)->>''tenant_id'')::uuid AND NOT proof.applied AND proof.transaction_id=pg_current_xact_id() AND proof.transaction_started_at=transaction_timestamp() AND (operation=''INSERT'' OR proof.before_snapshot->''layers'' @> jsonb_build_array(old_row)) AND CASE WHEN operation=''DELETE'' THEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(proof.after_snapshot->''layers'') x WHERE (x->>''product_id'',x->>''location'',x->>''layer_id'')=(old_row->>''product_id'',old_row->>''location'',old_row->>''layer_id'')) ELSE proof.after_snapshot->''layers'' @> jsonb_build_array(new_row) END)');
 IF position('b2b_external_order_allocation_proofs' IN f)=0 THEN RAISE EXCEPTION 'Nieznany wariant ochrony108';END IF;EXECUTE f;END $$;
CREATE FUNCTION b2b_external_proof_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_OP='UPDATE' AND NOT OLD.applied AND NEW.applied AND to_jsonb(NEW)-ARRAY['applied','byte_count'] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['applied','byte_count'] THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'Dowód przydziału jest niezmienny' USING ERRCODE='23514';END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON b2b_external_order_allocation_proofs FOR EACH ROW EXECUTE FUNCTION b2b_external_proof_immutable();
CREATE FUNCTION b2b_external_proof_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;h b2b_external_order_intents%ROWTYPE;prior_scope text;BEGIN
 SELECT * INTO r FROM b2b_external_order_intent_revisions WHERE (tenant_id,id)=(NEW.tenant_id,NEW.revision_id);
 SELECT * INTO h FROM b2b_external_order_intents WHERE (tenant_id,id)=(r.tenant_id,r.intent_id);
 IF r.id IS NULL OR h.order_id IS DISTINCT FROM NEW.order_id OR r.kind IS DISTINCT FROM NEW.kind OR r.actor_id IS DISTINCT FROM NEW.actor_id OR r.before_snapshot IS DISTINCT FROM NEW.before_intent_snapshot OR r.after_snapshot->'allocations' IS DISTINCT FROM NEW.allocation_snapshot OR NEW.transaction_id<>pg_current_xact_id() OR NEW.transaction_started_at<>transaction_timestamp()
 OR NOT EXISTS(SELECT 1 FROM b2b_external_order_allocation_proofs p WHERE p.revision_id=NEW.revision_id AND p.applied) THEN RAISE EXCEPTION 'Dowód wymaga pełnej aktualnej rewizji przydziału' USING ERRCODE='23514';END IF;
 prior_scope:=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
 IF b2b_dropship_custody_snapshot(NEW.order_id) IS DISTINCT FROM NEW.after_snapshot THEN RAISE EXCEPTION 'Zmiana fizyczna nie odpowiada trwałemu przydziałowi' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;END $$;
CREATE CONSTRAINT TRIGGER complete AFTER INSERT ON b2b_external_order_allocation_proofs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_external_proof_complete();
CREATE FUNCTION b2b_external_create_proof(oid uuid,rid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;h b2b_external_order_intents%ROWTYPE;r record;physical jsonb;BEGIN
 SELECT * INTO h FROM b2b_external_order_intents WHERE tenant_id=t AND order_id=oid;
 SELECT * INTO r FROM b2b_external_order_intent_revisions WHERE tenant_id=t AND id=rid AND intent_id=h.id AND kind='create';
 IF r.id IS NULL OR b2b_dropship_current_role(r.actor_id,false) IS DISTINCT FROM 'admin' OR NOT EXISTS(SELECT 1 FROM b2b_external_order_created_orders WHERE tenant_id=t AND order_id=oid AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Brak nowej typowanej intencji' USING ERRCODE='23514';END IF;
 physical:=b2b_dropship_custody_snapshot(oid);
 INSERT INTO b2b_external_order_allocation_proofs(tenant_id,revision_id,order_id,transaction_id,transaction_started_at,before_snapshot,after_snapshot,actor_id,kind,before_intent_snapshot,allocation_snapshot,applied) VALUES(t,rid,oid,pg_current_xact_id(),transaction_timestamp(),physical,physical,r.actor_id,'create',NULL,h.allocations,true);
 END $$;
GRANT EXECUTE ON FUNCTION b2b_external_create_proof(uuid,uuid) TO dyna_app;
REVOKE ALL ON FUNCTION b2b_external_create_proof(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION b2b_external_physical_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;BEGIN
 IF EXISTS(SELECT 1 FROM b2b_external_order_allocation_proofs p WHERE p.tenant_id=t AND p.applied AND p.transaction_id=pg_current_xact_id() AND p.transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Zapas po trwałym przydziale nie może zmienić się w tej transakcji' USING ERRCODE='23514';END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END $$;
DO $$DECLARE n text;BEGIN FOREACH n IN ARRAY ARRAY['stock','stock_locations','reservations','reservation_locations','order_pick_items','wms_reservation_layers','wms_layer_positions'] LOOP EXECUTE format('CREATE TRIGGER external_intent_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION b2b_external_physical_seal()',n);END LOOP;END $$;
REVOKE ALL ON FUNCTION b2b_external_physical_seal(),b2b_external_proof_complete(),b2b_external_proof_immutable() FROM PUBLIC,dyna_app;
-- An external commitment updates only the durable plan. It never pretends to
-- release or restore a local reservation that did not exist.
ALTER FUNCTION b2b_dropship_transfer_custody(uuid,uuid) RENAME TO b2b_dropship_transfer_custody_108;
REVOKE ALL ON FUNCTION b2b_dropship_transfer_custody_108(uuid,uuid) FROM PUBLIC,dyna_app;
CREATE FUNCTION b2b_dropship_transfer_custody(did uuid,restore_action uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;d record;q record;h b2b_external_order_intents%ROWTYPE;a b2b_dropship_actions%ROWTYPE;before_doc jsonb;uid uuid;keyid uuid;client uuid;request_digest text;request_doc jsonb;kind_name text;BEGIN
 SELECT * INTO d FROM b2b_dropship_orders WHERE tenant_id=t AND id=did;
 SELECT * INTO q FROM b2b_dropship_quotes WHERE (tenant_id,id)=(d.tenant_id,d.quote_id);
 IF q.snapshot->>'fulfillment_basis' IS DISTINCT FROM 'external_intent' THEN PERFORM b2b_dropship_transfer_custody_108(did,restore_action);RETURN;END IF;
 PERFORM id FROM orders WHERE tenant_id=t AND id=d.customer_order_id FOR UPDATE;
 SELECT * INTO h FROM b2b_external_order_intents WHERE tenant_id=t AND order_id=d.customer_order_id FOR UPDATE;
 kind_name:=CASE WHEN restore_action IS NULL THEN 'commit' ELSE 'uncommit' END;
 IF EXISTS(SELECT 1 FROM b2b_external_order_intent_revisions WHERE tenant_id=t AND dropship_order_id=did AND kind=kind_name) THEN RETURN;END IF;
 IF h.id IS NULL OR h.state<>'open' THEN RAISE EXCEPTION 'Brak otwartej intencji realizacji' USING ERRCODE='23514';END IF;
 IF restore_action IS NULL THEN
 uid:=d.actor_id;keyid:=d.api_key_id;client:=d.client_key;request_digest:=d.request_hash;request_doc:=d.request;
 IF q.snapshot->'intent_snapshot' IS DISTINCT FROM b2b_external_intent_snapshot(h) OR NOT EXISTS(SELECT 1 FROM b2b_dropship_created_orders WHERE tenant_id=d.supplier_tenant_id AND order_id=d.supplier_order_id AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Intencja lub nowe zamówienie zmieniły się' USING ERRCODE='23514';END IF;
 ELSE
 SELECT * INTO a FROM b2b_dropship_actions WHERE tenant_id=t AND id=restore_action AND order_id=did AND kind='cancel';
 IF a.id IS NULL THEN RAISE EXCEPTION 'Brak zatwierdzonego anulowania' USING ERRCODE='23514';END IF;uid:=a.actor_id;keyid:=a.api_key_id;client:=a.client_key;request_digest:=a.request_hash;request_doc:=a.request;
 END IF;
 IF b2b_dropship_current_role(uid,false) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Brak aktualnej zgody administratora' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(q.snapshot->'items') item LEFT JOIN jsonb_array_elements(h.allocations) alloc ON alloc->>'customer_item_id'=item->>'customer_item_id' WHERE alloc IS NULL OR alloc->>'link_id' IS DISTINCT FROM d.link_id::text OR (alloc->>'external_quantity')::int<(item->>'quantity')::int) THEN RAISE EXCEPTION 'Zlecenie nie odpowiada zewnętrznej intencji' USING ERRCODE='23514';END IF;
 before_doc:=b2b_external_intent_snapshot(h);
 UPDATE b2b_external_order_intents SET version=version+1,updated_at=clock_timestamp() WHERE tenant_id=t AND id=h.id RETURNING * INTO h;
 INSERT INTO b2b_external_order_intent_revisions(tenant_id,id,intent_id,actor_id,api_key_id,client_key,request_hash,request,kind,version,before_snapshot,after_snapshot,dropship_order_id,action_id)
 VALUES(t,gen_random_uuid(),h.id,uid,keyid,client,request_digest,request_doc,kind_name,h.version,before_doc,b2b_external_intent_snapshot(h),did,restore_action);
END $$;
REVOKE ALL ON FUNCTION b2b_dropship_transfer_custody(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_dropship_transfer_custody(uuid,uuid) TO dyna_app;
CREATE OR REPLACE FUNCTION b2b_dropship_complete() RETURNS trigger
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
 IF q.snapshot->>'fulfillment_basis'='external_intent' THEN
 IF NOT EXISTS(SELECT 1 FROM b2b_external_order_intent_revisions rev WHERE rev.tenant_id=NEW.tenant_id AND rev.dropship_order_id=NEW.id AND rev.kind='commit' AND rev.before_snapshot=q.snapshot->'intent_snapshot' AND rev.actor_id=NEW.actor_id AND rev.request_hash=NEW.request_hash) THEN RAISE EXCEPTION 'Checkout wymaga typowanego potwierdzenia intencji' USING ERRCODE='23514';END IF;
 ELSE
 IF NOT FOUND OR NOT custody.applied THEN RAISE EXCEPTION 'Checkout wymaga rzeczywistego przeniesienia rezerwacji' USING ERRCODE='23514';END IF;
 END IF;
 PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;END $$;

CREATE OR REPLACE FUNCTION b2b_dropship_action_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
 OR (CASE WHEN EXISTS(SELECT 1 FROM b2b_dropship_quotes q WHERE q.tenant_id=d.tenant_id AND q.id=d.quote_id AND q.snapshot->>'fulfillment_basis'='external_intent') THEN NOT EXISTS(SELECT 1 FROM b2b_external_order_intent_revisions rev WHERE rev.tenant_id=d.tenant_id AND rev.dropship_order_id=d.id AND rev.action_id=NEW.id AND rev.kind='uncommit' AND rev.actor_id=NEW.actor_id AND rev.request_hash=NEW.request_hash) ELSE NOT EXISTS(SELECT 1 FROM b2b_dropship_custody_transfers WHERE tenant_id=d.tenant_id AND order_id=d.id AND kind='restore' AND action_id=NEW.id AND applied) END)
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

CREATE FUNCTION b2b_external_intent_quote_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h b2b_external_order_intents%ROWTYPE;a jsonb;item jsonb;used bigint;BEGIN
 SELECT * INTO h FROM b2b_external_order_intents WHERE tenant_id=NEW.tenant_id AND order_id=NEW.customer_order_id;
 IF h.id IS NULL THEN
 IF NEW.request->>'fulfillment_basis'='external_intent' THEN RAISE EXCEPTION 'Brak własnej intencji źródłowej' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 IF h.state<>'open' OR NEW.request->>'fulfillment_basis' IS DISTINCT FROM 'external_intent' OR (NEW.request->>'intent_version')::int IS DISTINCT FROM h.version OR NEW.snapshot->'intent_snapshot' IS DISTINCT FROM b2b_external_intent_snapshot(h) OR NEW.snapshot->>'fulfillment_basis' IS DISTINCT FROM 'external_intent' THEN RAISE EXCEPTION 'Wycena wymaga dokładnej otwartej intencji' USING ERRCODE='23514';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.snapshot->'items') LOOP
 SELECT value INTO a FROM jsonb_array_elements(h.allocations) WHERE value->>'customer_item_id'=item->>'customer_item_id';
 SELECT coalesce(sum(li.quantity),0) INTO used FROM b2b_dropship_lines li JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(li.tenant_id,li.order_id) WHERE li.tenant_id=NEW.tenant_id AND li.customer_item_id=(item->>'customer_item_id')::uuid AND d.state='ordered';
 IF a IS NULL OR a->>'link_id' IS DISTINCT FROM NEW.link_id::text OR (item->>'quantity')::int>(a->>'external_quantity')::int-used THEN RAISE EXCEPTION 'Przekroczona zewnętrzna intencja pozycji' USING ERRCODE='23514';END IF;
 END LOOP;RETURN NEW;END $$;
CREATE TRIGGER external_intent_scope BEFORE INSERT ON b2b_dropship_quotes FOR EACH ROW EXECUTE FUNCTION b2b_external_intent_quote_guard();
CREATE FUNCTION b2b_external_intent_capacity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h b2b_external_order_intents%ROWTYPE;a jsonb;used bigint;BEGIN
 SELECT * INTO h FROM b2b_external_order_intents WHERE tenant_id=NEW.tenant_id AND order_id=NEW.customer_order_id;
 IF h.id IS NULL THEN RETURN NULL;END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(h.allocations) LOOP
 SELECT coalesce(sum(l.quantity),0) INTO used FROM b2b_dropship_lines l JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(l.tenant_id,l.order_id) WHERE l.tenant_id=NEW.tenant_id AND l.customer_item_id=(a->>'customer_item_id')::uuid AND d.state='ordered';
 IF used>(a->>'external_quantity')::int THEN RAISE EXCEPTION 'Przekroczona zewnętrzna intencja pozycji' USING ERRCODE='23514';END IF;
 END LOOP;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER external_capacity AFTER INSERT ON b2b_dropship_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_external_intent_capacity();
CREATE FUNCTION b2b_external_intent_item_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h b2b_external_order_intents%ROWTYPE;frozen jsonb;BEGIN
 IF TG_OP='INSERT' THEN
 IF EXISTS(SELECT 1 FROM b2b_external_order_intents WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id) THEN RAISE EXCEPTION 'Pozycje intencji są zamrożone' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 SELECT * INTO h FROM b2b_external_order_intents WHERE tenant_id=OLD.tenant_id AND order_id=OLD.order_id;
 IF h.id IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END IF;
 SELECT value INTO frozen FROM jsonb_array_elements(h.original_items) WHERE value->>'id'=OLD.id::text;
 IF TG_OP='DELETE' OR to_jsonb(NEW)-'scanned' IS DISTINCT FROM frozen-'scanned' THEN RAISE EXCEPTION 'Pozycja i receptura intencji są zamrożone' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER external_intent_item BEFORE INSERT OR UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION b2b_external_intent_item_guard();
CREATE FUNCTION b2b_external_intent_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid;n bigint;BEGIN
 FOR t IN SELECT DISTINCT tenant_id FROM inserted_rows ORDER BY tenant_id LOOP
 PERFORM pg_advisory_xact_lock(hashtextextended('b2b.external.intent.proof:'||t,0));
 IF (SELECT count(*) FROM b2b_external_order_intents WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM b2b_external_order_intent_revisions WHERE tenant_id=t)>10000 THEN RAISE EXCEPTION 'Limit historii intencji realizacji' USING ERRCODE='P0001';END IF;
 SELECT coalesce(sum(byte_count),0) INTO n FROM(SELECT byte_count FROM b2b_external_order_intents WHERE tenant_id=t UNION ALL SELECT byte_count FROM b2b_external_order_intent_revisions WHERE tenant_id=t UNION ALL SELECT byte_count FROM b2b_external_order_allocation_proofs WHERE tenant_id=t) x;
 IF n>134217728 THEN RAISE EXCEPTION 'Limit rozmiaru historii intencji realizacji' USING ERRCODE='P0001';END IF;
 END LOOP;RETURN NULL;END $$;
DO $$DECLARE n text;BEGIN FOREACH n IN ARRAY ARRAY['b2b_external_order_intents','b2b_external_order_intent_revisions','b2b_external_order_allocation_proofs'] LOOP EXECUTE format('CREATE TRIGGER budget_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION b2b_external_intent_budget()',n);EXECUTE format('CREATE TRIGGER budget_update AFTER UPDATE ON %I REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION b2b_external_intent_budget()',n);END LOOP;END $$;
CREATE FUNCTION b2b_external_intent_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT 1 FROM public.migrations WHERE name='109_b2b_external_order_intents')$$;
REVOKE ALL ON FUNCTION b2b_external_intent_installed() FROM PUBLIC;GRANT EXECUTE ON FUNCTION b2b_external_intent_installed() TO dyna_app;
REVOKE ALL ON FUNCTION b2b_external_intent_quote_guard(),b2b_external_intent_capacity(),b2b_external_intent_item_guard(),b2b_external_intent_budget() FROM PUBLIC,dyna_app;
-- Whole-intent closure is independent of the nonempty supplier-order list.
CREATE FUNCTION b2b_external_intent_fulfilled(oid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT NOT EXISTS(SELECT 1 FROM b2b_external_order_intents h WHERE h.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND h.order_id=oid AND (
 h.state<>'open' OR EXISTS(SELECT 1 FROM jsonb_array_elements(h.allocations) a WHERE (a->>'unassigned_quantity')::int<>0 OR (a->>'external_quantity')::int<>(SELECT coalesce(sum(l.quantity),0) FROM b2b_dropship_lines l JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(l.tenant_id,l.order_id) JOIN LATERAL jsonb_array_elements(b2b_dropship_fulfillment(oid)) f ON f->>'id'=d.id::text WHERE l.tenant_id=h.tenant_id AND l.customer_item_id=(a->>'customer_item_id')::uuid AND d.state='ordered' AND f->'dispatched'='true'))))
$$;
REVOKE ALL ON FUNCTION b2b_external_intent_fulfilled(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION b2b_external_intent_fulfilled(uuid) TO dyna_app;
DO $$DECLARE f text;BEGIN f:=pg_get_functiondef('public.b2b_dropship_action_complete()'::regprocedure);
 f:=replace(f,' IF d.state<>''ordered'' OR (NEW.request->>''version'')::int<>d.version',' IF NOT b2b_external_intent_fulfilled(d.customer_order_id) OR d.state<>''ordered'' OR (NEW.request->>''version'')::int<>d.version');
 IF position('b2b_external_intent_fulfilled' IN f)=0 THEN RAISE EXCEPTION 'Nieznany wariant zamknięcia108';END IF;EXECUTE f;END $$;
-- Validate immutable revision chains and genuine close/reopen/commit actions.
CREATE FUNCTION b2b_external_revision_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h b2b_external_order_intents%ROWTYPE;previous record;d record;expected jsonb;BEGIN
 SELECT * INTO h FROM b2b_external_order_intents WHERE (tenant_id,id)=(NEW.tenant_id,NEW.intent_id);
 IF NEW.kind<>'create' THEN
 SELECT * INTO previous FROM b2b_external_order_intent_revisions WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id AND version=NEW.version-1;
 IF previous.id IS NULL OR NEW.before_snapshot IS DISTINCT FROM previous.after_snapshot THEN RAISE EXCEPTION 'Rewizja nie odpowiada poprzedniemu przydziałowi' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.kind IN('allocate','close','reopen') AND ((NEW.request->>'version')::int IS DISTINCT FROM NEW.version-1 OR NEW.request->'confirmed' IS DISTINCT FROM 'true') THEN RAISE EXCEPTION 'Rewizja wymaga zatwierdzonego CAS' USING ERRCODE='23514';END IF;
 IF NEW.kind IN('allocate','reopen') AND NOT EXISTS(SELECT 1 FROM b2b_external_order_allocation_proofs p WHERE p.tenant_id=NEW.tenant_id AND p.revision_id=NEW.id AND p.order_id=h.order_id AND p.applied) THEN RAISE EXCEPTION 'Rewizja wymaga rzeczywistego przydziału fizycznego' USING ERRCODE='23514';END IF;
 IF NEW.kind='allocate' AND (NEW.before_snapshot->>'state'<>'open' OR NEW.after_snapshot->>'state'<>'open' OR NEW.after_snapshot->'allocations' IS DISTINCT FROM NEW.request->'allocations') THEN RAISE EXCEPTION 'Przydział nie odpowiada zatwierdzonemu żądaniu' USING ERRCODE='23514';END IF;
 IF NEW.kind='close' AND (NEW.after_snapshot->>'state'<>'closed' OR NOT EXISTS(SELECT 1 FROM orders WHERE tenant_id=NEW.tenant_id AND id=h.order_id AND status='cancelled') OR EXISTS(SELECT 1 FROM b2b_dropship_orders WHERE tenant_id=NEW.tenant_id AND customer_order_id=h.order_id AND state='ordered') OR EXISTS(SELECT 1 FROM reservations WHERE tenant_id=NEW.tenant_id AND order_id=h.order_id AND state='active')) THEN RAISE EXCEPTION 'Zamknięcie wymaga anulowania prawdziwego zamówienia' USING ERRCODE='23514';END IF;
 IF NEW.kind='reopen' AND (NEW.before_snapshot->>'state'<>'closed' OR NEW.after_snapshot->>'state'<>'open' OR NEW.after_snapshot->'allocations' IS DISTINCT FROM NEW.before_snapshot->'allocations' OR NOT EXISTS(SELECT 1 FROM orders WHERE tenant_id=NEW.tenant_id AND id=h.order_id AND status IN('new','paid'))) THEN RAISE EXCEPTION 'Nieprawidłowe ponowne otwarcie intencji' USING ERRCODE='23514';END IF;
 IF NEW.kind IN('commit','uncommit') THEN
 SELECT * INTO d FROM b2b_dropship_orders WHERE (tenant_id,id)=(NEW.tenant_id,NEW.dropship_order_id);
 IF d.id IS NULL OR d.customer_order_id<>h.order_id OR NEW.after_snapshot->'allocations' IS DISTINCT FROM NEW.before_snapshot->'allocations' OR NEW.before_snapshot->>'state'<>'open' OR NEW.after_snapshot->>'state'<>'open'
 OR (NEW.kind='commit' AND (NEW.actor_id<>d.actor_id OR NEW.api_key_id IS DISTINCT FROM d.api_key_id OR NEW.request_hash<>d.request_hash OR NEW.request IS DISTINCT FROM d.request))
 OR (NEW.kind='uncommit' AND NOT EXISTS(SELECT 1 FROM b2b_dropship_actions a WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.action_id AND a.order_id=d.id AND a.kind='cancel' AND a.actor_id=NEW.actor_id AND a.api_key_id IS NOT DISTINCT FROM NEW.api_key_id AND a.request_hash=NEW.request_hash AND a.request=NEW.request)) THEN RAISE EXCEPTION 'Potwierdzenie nie odpowiada typowanemu zleceniu' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER complete AFTER INSERT ON b2b_external_order_intent_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_external_revision_complete();
REVOKE ALL ON FUNCTION b2b_external_revision_complete() FROM PUBLIC,dyna_app;
CREATE FUNCTION b2b_external_order_status_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h b2b_external_order_intents%ROWTYPE;o orders%ROWTYPE;prior_scope text;BEGIN
 SELECT * INTO h FROM b2b_external_order_intents WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id;
 IF h.id IS NULL THEN RETURN NULL;END IF;SELECT * INTO o FROM orders WHERE (tenant_id,id)=(NEW.tenant_id,NEW.id);
 IF (o.status='cancelled')<>(h.state='closed') THEN RAISE EXCEPTION 'Anulowanie wymaga trwałego zamknięcia intencji' USING ERRCODE='23514';END IF;
 prior_scope:=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
 IF o.status IN('shipped','delivered','completed') AND NOT b2b_external_intent_fulfilled(o.id) THEN RAISE EXCEPTION 'Zewnętrzna intencja nie została rzeczywiście wydana' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;END $$;
CREATE CONSTRAINT TRIGGER external_order_status AFTER UPDATE ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_external_order_status_complete();
REVOKE ALL ON FUNCTION b2b_external_order_status_complete() FROM PUBLIC,dyna_app;

-- Only this admitted key's fresh conditional initial-field scope; no table ACL expansion.
CREATE FUNCTION b2b_external_fields_write_allowed(uid uuid,kid uuid,pin boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;k record;BEGIN
 IF pin THEN SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid FOR SHARE;
 ELSE SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid;END IF;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR (k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN RETURN false;END IF;
 RETURN 'order-fields:write'=ANY(k.scopes);END $$;
REVOKE ALL ON FUNCTION b2b_external_fields_write_allowed(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_external_fields_write_allowed(uuid,uuid,boolean) TO dyna_app;
