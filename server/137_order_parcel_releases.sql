-- Cancel ALL unissued commercial_v1 parcels. Original quantities/scans are never rewritten.
ALTER TABLE reservations ADD COLUMN released_quantity integer NOT NULL DEFAULT 0 CHECK(released_quantity>=0 AND consumed_quantity+released_quantity<=quantity);
ALTER TABLE reservation_locations ADD COLUMN released_quantity integer NOT NULL DEFAULT 0 CHECK(released_quantity>=0 AND consumed_quantity+released_quantity<=quantity);
ALTER TABLE wms_reservation_layers ADD COLUMN released_quantity integer NOT NULL DEFAULT 0 CHECK(released_quantity>=0 AND consumed_quantity+released_quantity<=quantity);

CREATE TABLE order_parcel_release_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,plan_id uuid NOT NULL,order_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),request jsonb NOT NULL,payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,plan_id,order_id),UNIQUE(tenant_id,client_key),CHECK(expires_at>created_at),
 FOREIGN KEY(tenant_id,plan_id,order_id) REFERENCES order_parcel_plans(tenant_id,id,order_id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE order_parcel_releases (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,preview_id uuid NOT NULL,plan_id uuid NOT NULL,order_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),request jsonb NOT NULL,payload jsonb NOT NULL,before_snapshot jsonb NOT NULL,after_snapshot jsonb NOT NULL,receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,plan_id,order_id),UNIQUE(tenant_id,plan_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,preview_id,plan_id,order_id) REFERENCES order_parcel_release_previews(tenant_id,id,plan_id,order_id),FOREIGN KEY(tenant_id,plan_id,order_id) REFERENCES order_parcel_plans(tenant_id,id,order_id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE order_parcel_release_admissions (
 tenant_id uuid NOT NULL,transaction_id xid8 NOT NULL,opened_at timestamptz NOT NULL DEFAULT transaction_timestamp(),operation_id uuid NOT NULL,preview_id uuid NOT NULL,plan_id uuid NOT NULL,order_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL,scope_hash text NOT NULL,request jsonb NOT NULL,payload jsonb NOT NULL,before_snapshot jsonb NOT NULL,
 PRIMARY KEY(tenant_id,transaction_id,operation_id),UNIQUE(tenant_id,operation_id),
 FOREIGN KEY(tenant_id,preview_id,plan_id,order_id) REFERENCES order_parcel_release_previews(tenant_id,id,plan_id,order_id),
 FOREIGN KEY(tenant_id,operation_id,plan_id,order_id) REFERENCES order_parcel_releases(tenant_id,id,plan_id,order_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX order_parcel_release_preview_page ON order_parcel_release_previews(tenant_id,plan_id,created_at DESC,id DESC);
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['order_parcel_release_previews','order_parcel_releases','order_parcel_release_admissions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',rel);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',rel);
 EXECUTE format('CREATE POLICY owner_scope ON %I TO %I USING(true) WITH CHECK(true)',rel,current_user);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',rel);
 IF rel<>'order_parcel_release_admissions' THEN EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',rel);EXECUTE format('GRANT SELECT ON %I TO dyna_app',rel);END IF;
END LOOP;END $$;

CREATE FUNCTION order_parcel_release_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT 1 FROM migrations WHERE name='137_order_parcel_releases')$$;
CREATE FUNCTION order_parcel_release_snapshot(oid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;result jsonb;name text;data jsonb;BEGIN
 result:=order_parcel_snapshot(oid);
 FOR name IN SELECT unnest(ARRAY['orders','order_items','order_pick_items','shipments','payment_entries','documents','return_cases','return_items','order_parcel_dispatches','order_parcel_commercial_origins']) LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY to_jsonb(q)),''[]'') FROM %I q WHERE tenant_id=$1 AND %I=$2',name,CASE WHEN name='orders' THEN 'id' ELSE 'order_id' END) INTO data USING t,oid;result:=result||jsonb_build_object(name,data);
 END LOOP;
 FOR name IN SELECT unnest(ARRAY['stock_locations','wms_layer_positions','wms_cost_layers','wms_lots','stock_movements','stock_location_movements','wms_layer_movements']) LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY to_jsonb(q)),''[]'') FROM %I q WHERE q.tenant_id=$1 AND q.product_id IN(SELECT product_id FROM reservations WHERE tenant_id=$1 AND order_id=$2)',name) INTO data USING t,oid;result:=result||jsonb_build_object(name,data);
 END LOOP;
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.id),'[]') INTO data FROM wms_operations q WHERE tenant_id=t AND order_id=oid;result:=result||jsonb_build_object('wms_operations',data);
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.id),'[]') INTO data FROM wms_issue_fragments q WHERE tenant_id=t AND order_id=oid;result:=result||jsonb_build_object('wms_issue_fragments',data);
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.id),'[]') INTO data FROM wms_return_fragments q WHERE tenant_id=t AND order_id=oid;result:=result||jsonb_build_object('wms_return_fragments',data);
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.id),'[]') INTO data FROM purchasing_stock_changes q WHERE tenant_id=t;result:=result||jsonb_build_object('purchasing_stock_changes',data);
 FOR name IN SELECT unnest(ARRAY['order_parcel_origin_issues','order_parcel_origin_fragments']) LOOP EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY to_jsonb(q)),''[]'') FROM %I q JOIN order_parcel_commercial_origins o ON(o.tenant_id,o.id)=(q.tenant_id,q.origin_id) WHERE o.tenant_id=$1 AND o.order_id=$2',name) INTO data USING t,oid;result:=result||jsonb_build_object(name,data);END LOOP;
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY to_jsonb(q)),'[]') INTO data FROM wms_policies q WHERE tenant_id=t;RETURN result||jsonb_build_object('wms_policies',data);
END $$;

CREATE FUNCTION order_parcel_release_validate(a order_parcel_release_admissions,after_data jsonb,receipt_data jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE name text;oldrow jsonb;newrow jsonb;expected jsonb;pr jsonb;part jsonb;delta integer;keyfields text[];oldset jsonb;newset jsonb;qty bigint;BEGIN
 IF receipt_data IS DISTINCT FROM jsonb_build_object('operation_id',a.operation_id,'cancelled',a.payload->'pending','products',a.payload->'products','summary',a.payload->'summary','physical_movement',false) THEN RAISE EXCEPTION 'Wynik zwolnienia nie odpowiada pełnemu zakresowi zgody' USING ERRCODE='23514';END IF;
 IF after_data IS NULL OR jsonb_typeof(after_data)<>'object' OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(after_data) key) IS DISTINCT FROM(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(a.before_snapshot) key) THEN RAISE EXCEPTION 'Zwolnienie ma niepełny stan końcowy' USING ERRCODE='23514';END IF;
 FOR name IN SELECT jsonb_object_keys(a.before_snapshot) LOOP
  oldset:=a.before_snapshot->name;newset:=after_data->name;
  IF name='purchasing_stock_changes' THEN
   IF jsonb_array_length(newset)<>jsonb_array_length(oldset)+jsonb_array_length(a.payload->'products') OR NOT newset @> oldset OR EXISTS(SELECT 1 FROM jsonb_array_elements(newset) x WHERE x->>'tenant_id' IS DISTINCT FROM a.tenant_id::text) THEN RAISE EXCEPTION 'Zwolnienie zmieniło niewłaściwy dziennik wersji zapasu' USING ERRCODE='23514';END IF;
   CONTINUE;
  END IF;
  IF name NOT IN('stock','reservations','locations','holds','positions','wms_layer_positions','orders') THEN IF newset IS DISTINCT FROM oldset THEN RAISE EXCEPTION 'Zwolnienie zmieniło towar, historię lub finanse' USING ERRCODE='23514';END IF;CONTINUE;END IF;
  IF jsonb_array_length(newset)<>jsonb_array_length(oldset) THEN RAISE EXCEPTION 'Zwolnienie zmieniło zestaw istniejących stanów' USING ERRCODE='23514';END IF;
  FOR oldrow IN SELECT value FROM jsonb_array_elements(oldset) LOOP
   IF name='orders' THEN
    SELECT value INTO newrow FROM jsonb_array_elements(newset) WHERE value->>'id'=oldrow->>'id';
    expected:=oldrow||jsonb_build_object('status',CASE WHEN(a.payload->'summary'->>'issued_parcels')::int>0 THEN 'shipped' ELSE 'cancelled' END,'workflow_status_id',NULL,'version',(oldrow->>'version')::bigint+1,'updated_at',transaction_timestamp());
   ELSE
    keyfields:=CASE name WHEN 'stock' THEN ARRAY['tenant_id','warehouse_id','product_id'] WHEN 'reservations' THEN ARRAY['tenant_id','order_id','warehouse_id','product_id'] WHEN 'locations' THEN ARRAY['tenant_id','order_id','warehouse_id','product_id','location'] WHEN 'holds' THEN ARRAY['tenant_id','order_id','warehouse_id','product_id','location','layer_id'] ELSE ARRAY['tenant_id','warehouse_id','product_id','location','layer_id'] END;
    SELECT value INTO newrow FROM jsonb_array_elements(newset) candidate WHERE NOT EXISTS(SELECT 1 FROM unnest(keyfields) k WHERE candidate.value->k IS DISTINCT FROM oldrow->k);
    SELECT value INTO pr FROM jsonb_array_elements(a.payload->'products') WHERE value->>'product_id'=oldrow->>'product_id' AND value->>'warehouse_id'=oldrow->>'warehouse_id';delta:=coalesce((pr->>'quantity')::int,0);
    IF name='locations' THEN SELECT coalesce(sum((value->>'quantity')::int),0) INTO delta FROM jsonb_array_elements(pr->'locations') WHERE value->>'location'=oldrow->>'location';
    ELSIF name IN('holds','positions','wms_layer_positions') THEN SELECT coalesce(sum((value->>'quantity')::int),0) INTO delta FROM jsonb_array_elements(pr->'lot_holds') WHERE value->>'location'=oldrow->>'location' AND value->>'layer_id'=oldrow->>'layer_id';END IF;
    expected:=oldrow;
    IF delta>0 THEN
     IF name='stock' THEN expected:=oldrow||jsonb_build_object('reserved',(oldrow->>'reserved')::int-delta,'available',(oldrow->>'available')::int+delta,'version',(oldrow->>'version')::bigint+1);
     ELSIF name IN('positions','wms_layer_positions') THEN expected:=oldrow||jsonb_build_object('reserved',(oldrow->>'reserved')::int-delta,'version',(oldrow->>'version')::bigint+1);
     ELSE
      IF (oldrow->>'quantity')::int-(oldrow->>'consumed_quantity')::int-(oldrow->>'released_quantity')::int<>delta THEN RAISE EXCEPTION 'Zwolnienie nie zamyka całej pozostałej rezerwacji' USING ERRCODE='23514';END IF;
      expected:=oldrow||jsonb_build_object('released_quantity',(oldrow->>'released_quantity')::int+delta);IF name IN('reservations','holds') THEN expected:=expected||jsonb_build_object('state','released');END IF;
     END IF;
    END IF;
   END IF;
   IF newrow IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Zwolnienie nie odpowiada rzeczywistej zmianie pozostałej rezerwacji' USING ERRCODE='23514';END IF;
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(after_data->'reservations') r WHERE (r->>'quantity')::int<>(r->>'consumed_quantity')::int+(r->>'released_quantity')::int) THEN RAISE EXCEPTION 'Zwolnienie pozostawiło niewydaną rezerwację' USING ERRCODE='23514';END IF;
END $$;

CREATE FUNCTION order_parcel_release_finish(eid uuid,b jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;a order_parcel_release_admissions;after_data jsonb;BEGIN
 PERFORM order_parcel_require(uid,kid,true,false);PERFORM order_parcel_release_require();SELECT * INTO a FROM order_parcel_release_admissions WHERE tenant_id=t AND transaction_id=pg_current_xact_id() AND operation_id=eid AND opened_at=transaction_timestamp();
 IF a.operation_id IS NULL OR(a.actor_id,a.api_key_id) IS DISTINCT FROM(uid,kid) OR EXISTS(SELECT 1 FROM order_parcel_releases WHERE tenant_id=t AND id=eid) THEN RAISE EXCEPTION 'Brak bieżącej zgody zwolnienia' USING ERRCODE='23514';END IF;
 UPDATE orders SET status=CASE WHEN(a.payload->'summary'->>'issued_parcels')::int>0 THEN 'shipped' ELSE 'cancelled' END,workflow_status_id=NULL,updated_at=now() WHERE tenant_id=t AND id=a.order_id;
 after_data:=order_parcel_release_snapshot(a.order_id);PERFORM order_parcel_release_validate(a,after_data,b);
 INSERT INTO order_parcel_releases(id,tenant_id,preview_id,plan_id,order_id,actor_id,api_key_id,client_key,request_hash,scope_hash,request,payload,before_snapshot,after_snapshot,receipt) VALUES(eid,t,a.preview_id,a.plan_id,a.order_id,uid,kid,a.client_key,a.request_hash,a.scope_hash,a.request,a.payload,a.before_snapshot,after_data,b);PERFORM order_parcel_require(uid,kid,true,false);PERFORM order_parcel_release_budget();RETURN eid;
END $$;
CREATE FUNCTION order_parcel_release_budget() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;bytes bigint;rel text;part bigint;BEGIN
 IF(SELECT count(*) FROM order_parcel_release_previews WHERE tenant_id=t)>2000 OR(SELECT count(*) FROM order_parcel_releases WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit historii zwolnień paczek' USING ERRCODE='23514';END IF;
 bytes:=0;FOR rel IN SELECT unnest(ARRAY['order_parcel_previews','order_parcel_plans','order_parcel_allocations','order_parcel_dispatches','order_parcel_admissions','order_parcel_commercial_origins','order_parcel_origin_issues','order_parcel_origin_fragments','order_parcel_release_previews','order_parcel_releases','order_parcel_release_admissions']) LOOP EXECUTE format('SELECT coalesce(sum(octet_length(to_jsonb(q)::text)),0) FROM %I q WHERE tenant_id=$1',rel) INTO part USING t;bytes:=bytes+part;END LOOP;
 IF bytes>67108864 THEN RAISE EXCEPTION 'Limit danych zwolnień paczek' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION order_parcel_release_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a order_parcel_release_admissions;p order_parcel_release_previews;f jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Dowód zwolnienia paczek jest niezmienny' USING ERRCODE='23514';END IF;
 PERFORM order_parcel_require(NEW.actor_id,NEW.api_key_id,true,false);PERFORM order_parcel_release_require();PERFORM order_parcel_lock(NEW.order_id);
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Zwolnienie przekracza firmę transakcji' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='order_parcel_release_previews' THEN
  f:=order_parcel_release_frame(NEW.plan_id,NEW.request,NEW.actor_id,NEW.api_key_id);
  IF NEW.payload IS DISTINCT FROM f OR NEW.scope_hash IS DISTINCT FROM order_parcel_hash(f) OR NEW.order_id IS DISTINCT FROM(f->>'order_id')::uuid OR NEW.client_key IS DISTINCT FROM(NEW.request->>'client_key')::uuid OR NEW.request_hash IS DISTINCT FROM order_parcel_hash(jsonb_build_object('tenant_id',NEW.tenant_id,'actor_id',NEW.actor_id,'api_key_id',NEW.api_key_id,'kind','release_preview','plan_id',NEW.plan_id,'request',NEW.request)) OR NEW.expires_at-NEW.created_at NOT BETWEEN interval '14 minutes 59 seconds' AND interval '15 minutes 1 second' THEN RAISE EXCEPTION 'Podgląd zwolnienia nie odpowiada rzeczywistemu planowi' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='order_parcel_release_admissions' THEN
  SELECT * INTO p FROM order_parcel_release_previews WHERE tenant_id=NEW.tenant_id AND id=NEW.preview_id;
  IF p.id IS NULL OR jsonb_typeof(NEW.request) IS DISTINCT FROM 'object' OR (NEW.request-ARRAY['client_key','scope_hash','confirmed'])<>'{}' OR NOT NEW.request?&ARRAY['client_key','scope_hash','confirmed'] OR NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() OR NEW.opened_at IS DISTINCT FROM transaction_timestamp() OR(NEW.plan_id,NEW.order_id,NEW.actor_id,NEW.api_key_id,NEW.scope_hash,NEW.payload,NEW.before_snapshot) IS DISTINCT FROM(p.plan_id,p.order_id,p.actor_id,p.api_key_id,p.scope_hash,p.payload,p.payload->'snapshot') OR p.expires_at<=clock_timestamp() OR NEW.payload IS DISTINCT FROM order_parcel_release_frame(p.plan_id,p.request,NEW.actor_id,NEW.api_key_id) OR NEW.request->'confirmed' IS DISTINCT FROM 'true'::jsonb OR NEW.request->>'scope_hash' IS DISTINCT FROM p.scope_hash OR NEW.client_key IS DISTINCT FROM(NEW.request->>'client_key')::uuid OR NEW.request_hash IS DISTINCT FROM order_parcel_hash(jsonb_build_object('tenant_id',NEW.tenant_id,'actor_id',NEW.actor_id,'api_key_id',NEW.api_key_id,'kind','release','preview_id',NEW.preview_id,'request',NEW.request)) THEN RAISE EXCEPTION 'Zgoda zwolnienia wymaga świeżego pełnego podglądu' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO a FROM order_parcel_release_admissions WHERE tenant_id=NEW.tenant_id AND transaction_id=pg_current_xact_id() AND opened_at=transaction_timestamp() AND operation_id=NEW.id;
  IF a.operation_id IS NULL OR(NEW.preview_id,NEW.plan_id,NEW.order_id,NEW.actor_id,NEW.api_key_id,NEW.client_key,NEW.request_hash,NEW.scope_hash,NEW.request,NEW.payload,NEW.before_snapshot) IS DISTINCT FROM(a.preview_id,a.plan_id,a.order_id,a.actor_id,a.api_key_id,a.client_key,a.request_hash,a.scope_hash,a.request,a.payload,a.before_snapshot) OR NEW.after_snapshot IS DISTINCT FROM order_parcel_release_snapshot(a.order_id) THEN RAISE EXCEPTION 'Wynik zwolnienia wymaga bieżącej prywatnej zgody' USING ERRCODE='23514';END IF;
  PERFORM order_parcel_release_validate(a,NEW.after_snapshot,NEW.receipt);
 END IF;RETURN NEW;
END $$;
CREATE FUNCTION order_parcel_release_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a order_parcel_release_admissions;e order_parcel_releases;BEGIN
 PERFORM order_parcel_release_require();
 IF TG_TABLE_NAME='order_parcel_release_previews' THEN PERFORM order_parcel_require(NEW.actor_id,NEW.api_key_id,true,false);PERFORM order_parcel_release_budget();RETURN NULL;END IF;
 SELECT * INTO e FROM order_parcel_releases WHERE tenant_id=NEW.tenant_id AND id=(to_jsonb(NEW)->>CASE WHEN TG_TABLE_NAME='order_parcel_releases' THEN 'id' ELSE 'operation_id' END)::uuid;
 SELECT * INTO a FROM order_parcel_release_admissions WHERE tenant_id=NEW.tenant_id AND transaction_id=pg_current_xact_id() AND opened_at=transaction_timestamp() AND operation_id=e.id;
 IF e.id IS NULL OR a.operation_id IS NULL OR e.after_snapshot IS DISTINCT FROM order_parcel_release_snapshot(e.order_id) THEN RAISE EXCEPTION 'Niekompletny trwały wynik zwolnienia' USING ERRCODE='23514';END IF;
 PERFORM order_parcel_release_validate(a,e.after_snapshot,e.receipt);PERFORM order_parcel_release_terminal(e.plan_id);PERFORM order_parcel_require(e.actor_id,e.api_key_id,true,false);PERFORM order_parcel_release_budget();RETURN NULL;
END $$;
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['order_parcel_release_previews','order_parcel_releases','order_parcel_release_admissions'] LOOP EXECUTE format('CREATE TRIGGER order_parcel_release_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION order_parcel_release_guard()',rel);EXECUTE format('CREATE CONSTRAINT TRIGGER order_parcel_release_complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_parcel_release_complete()',rel);END LOOP;END $$;

CREATE FUNCTION order_parcel_release_frame(pid uuid,b jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p order_parcel_plans;o orders;x jsonb;pending jsonb:='[]';products jsonb;commercial integer:=0;physical bigint;issued integer;BEGIN
 PERFORM order_parcel_require(uid,kid,true,false);PERFORM order_parcel_release_require();
 SELECT * INTO p FROM order_parcel_plans WHERE tenant_id=t AND id=pid;IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono planu paczek' USING ERRCODE='P0002';END IF;PERFORM order_parcel_lock(p.order_id);
 SELECT * INTO o FROM orders WHERE tenant_id=t AND id=p.order_id;
 IF p.payload->>'protocol' IS DISTINCT FROM 'commercial_v1' OR NOT EXISTS(SELECT 1 FROM order_parcel_previews WHERE tenant_id=t AND id=p.preview_id AND request->>'protocol'='commercial_v1') OR o.source NOT IN('manual','demo') OR o.channel_id IS NOT NULL OR o.fulfillment_kind IS DISTINCT FROM 'sale' OR o.payment_mode='cod' OR o.status<>'packed' OR EXISTS(SELECT 1 FROM order_parcel_releases WHERE tenant_id=t AND plan_id=pid) THEN RAISE EXCEPTION 'Zwolnienie wymaga lokalnego przedpłaconego planu komercyjnego' USING ERRCODE='23514';END IF;
 IF b IS NULL OR jsonb_typeof(b)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(b))<>2 OR NOT b?&ARRAY['client_key','order_version'] OR b->>'order_version' IS DISTINCT FROM o.version::text OR b->>'client_key'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'Zwolnienie wymaga bieżącej wersji zamówienia' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM order_merge_claims WHERE tenant_id=t AND(source_order_id=o.id OR target_order_id=o.id)) OR EXISTS(SELECT 1 FROM b2b_external_order_intents WHERE tenant_id=t AND order_id=o.id) OR EXISTS(SELECT 1 FROM b2b_dropship_lines WHERE tenant_id=t AND customer_order_id=o.id) OR EXISTS(SELECT 1 FROM shipping_plans WHERE tenant_id=t AND order_id=o.id AND state NOT IN('preview','cancelled')) THEN RAISE EXCEPTION 'Zwolnienie nie obejmuje realizacji partnera lub przewoźnika' USING ERRCODE='23514';END IF;
 IF(order_parcel_source(o.id)->>'payment_due')::bigint IS DISTINCT FROM 0::bigint OR EXISTS(SELECT 1 FROM payment_entries WHERE tenant_id=t AND order_id=o.id AND currency IS DISTINCT FROM o.currency) THEN RAISE EXCEPTION 'Przedpłata zwolnienia jest nieaktualna' USING ERRCODE='23514';END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p.payload->'parcels') ORDER BY(value->>'index')::int LOOP
  IF NOT EXISTS(SELECT 1 FROM order_parcel_dispatches WHERE tenant_id=t AND plan_id=pid AND parcel_index=(x->>'index')::int) THEN
   IF NOT EXISTS(SELECT 1 FROM shipments s WHERE s.tenant_id=t AND s.id=(x->>'shipment_id')::uuid AND s.order_id=o.id AND s.dispatched_at IS NULL AND s.cod_expected=0 AND s.mode='demo' AND s.channel_id IS NULL) THEN RAISE EXCEPTION 'Niewydana paczka zmieniła źródło' USING ERRCODE='23514';END IF;
   IF (SELECT coalesce(jsonb_agg(c.snapshot ORDER BY c.item_id),'[]') FROM order_parcel_commercial_origins c WHERE c.tenant_id=t AND c.plan_id=pid AND c.parcel_index=(x->>'index')::int AND c.order_id=o.id AND c.shipment_id=(x->>'shipment_id')::uuid AND c.item_id=(c.snapshot->>'item_id')::uuid AND c.quantity=(c.snapshot->>'quantity')::int) IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value ORDER BY value->>'item_id'),'[]') FROM jsonb_array_elements(x->'items')) OR EXISTS(SELECT 1 FROM order_parcel_commercial_origins c JOIN order_parcel_origin_issues i ON(i.tenant_id,i.origin_id)=(c.tenant_id,c.id) WHERE c.tenant_id=t AND c.plan_id=pid AND c.parcel_index=(x->>'index')::int) THEN RAISE EXCEPTION 'Niewydana paczka nie ma pełnego pochodzenia komercyjnego' USING ERRCODE='23514';END IF;
   pending:=pending||jsonb_build_array(x);SELECT commercial+coalesce(sum((it->>'quantity')::int),0) INTO commercial FROM jsonb_array_elements(x->'items') it;
  END IF;
 END LOOP;
 IF jsonb_array_length(pending)=0 THEN RAISE EXCEPTION 'Brak niewydanych paczek do zwolnienia' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',r.product_id,'warehouse_id',r.warehouse_id,'quantity',r.quantity-r.consumed_quantity-r.released_quantity,
  'locations',(SELECT coalesce(jsonb_agg(jsonb_build_object('location',l.location,'quantity',l.quantity-l.consumed_quantity-l.released_quantity) ORDER BY l.location COLLATE "C"),'[]') FROM reservation_locations l WHERE(l.tenant_id,l.order_id,l.product_id,l.warehouse_id)=(r.tenant_id,r.order_id,r.product_id,r.warehouse_id) AND l.quantity>l.consumed_quantity+l.released_quantity),
  'lot_holds',(SELECT coalesce(jsonb_agg(jsonb_build_object('layer_id',h.layer_id,'location',h.location,'quantity',h.quantity-h.consumed_quantity-h.released_quantity) ORDER BY h.layer_id,h.location COLLATE "C"),'[]') FROM wms_reservation_layers h WHERE(h.tenant_id,h.order_id,h.product_id,h.warehouse_id)=(r.tenant_id,r.order_id,r.product_id,r.warehouse_id) AND h.quantity>h.consumed_quantity+h.released_quantity)) ORDER BY r.warehouse_id,r.product_id),'[]') INTO products FROM reservations r WHERE tenant_id=t AND order_id=o.id AND quantity>consumed_quantity+released_quantity;
 IF jsonb_array_length(products)=0 OR EXISTS(SELECT 1 FROM reservations r WHERE tenant_id=t AND order_id=o.id AND r.released_quantity<>0) THEN RAISE EXCEPTION 'Pozostała rezerwacja zwolnienia jest niespójna' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM reservations r WHERE tenant_id=t AND order_id=o.id AND quantity>consumed_quantity+released_quantity AND state<>'active') OR EXISTS(SELECT 1 FROM reservation_locations WHERE tenant_id=t AND order_id=o.id AND scanned<>quantity) OR EXISTS(SELECT 1 FROM wms_reservation_layers WHERE tenant_id=t AND order_id=o.id AND (scanned<>quantity OR quantity>consumed_quantity+released_quantity AND state<>'active')) THEN RAISE EXCEPTION 'Zwolnienie wymaga pierwotnych pełnych skanów i aktywnej pozostałości' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(products) pr WHERE(pr->>'quantity')::bigint IS DISTINCT FROM(SELECT coalesce(sum((v->>'quantity')::bigint),0) FROM jsonb_array_elements(pending) pa CROSS JOIN LATERAL jsonb_array_elements(pa->'products') v WHERE v->>'product_id'=pr->>'product_id' AND v->>'warehouse_id'=pr->>'warehouse_id')) OR EXISTS(SELECT 1 FROM jsonb_array_elements(pending) pa CROSS JOIN LATERAL jsonb_array_elements(pa->'products') v WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(products) pr WHERE pr->>'product_id'=v->>'product_id' AND pr->>'warehouse_id'=v->>'warehouse_id')) THEN RAISE EXCEPTION 'Zwolnienie nie pokrywa całych niewydanych paczek' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(products) pr WHERE (pr->>'quantity')::bigint IS DISTINCT FROM (SELECT coalesce(sum((value->>'quantity')::bigint),0) FROM jsonb_array_elements(pr->'locations')) OR (EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=t AND enabled) AND (pr->>'quantity')::bigint IS DISTINCT FROM (SELECT coalesce(sum((value->>'quantity')::bigint),0) FROM jsonb_array_elements(pr->'lot_holds'))) OR (NOT EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=t AND enabled) AND jsonb_array_length(pr->'lot_holds')<>0)) THEN RAISE EXCEPTION 'Pozostałe lokalizacje i warstwy nie pokrywają zwolnienia' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(products) pr CROSS JOIN LATERAL jsonb_array_elements(pr->'locations') loc WHERE (loc->>'quantity')::bigint IS DISTINCT FROM (SELECT coalesce(sum((l->>'quantity')::bigint),0) FROM jsonb_array_elements(pending) pa CROSS JOIN LATERAL jsonb_array_elements(pa->'products') v CROSS JOIN LATERAL jsonb_array_elements(v->'locations') l WHERE v->>'product_id'=pr->>'product_id' AND v->>'warehouse_id'=pr->>'warehouse_id' AND l->>'location'=loc->>'location')) OR EXISTS(SELECT 1 FROM jsonb_array_elements(products) pr CROSS JOIN LATERAL jsonb_array_elements(pr->'lot_holds') hold WHERE (hold->>'quantity')::bigint IS DISTINCT FROM (SELECT coalesce(sum((l->>'quantity')::bigint),0) FROM jsonb_array_elements(pending) pa CROSS JOIN LATERAL jsonb_array_elements(pa->'products') v CROSS JOIN LATERAL jsonb_array_elements(v->'lot_holds') l WHERE v->>'product_id'=pr->>'product_id' AND v->>'warehouse_id'=pr->>'warehouse_id' AND l->>'location'=hold->>'location' AND l->>'layer_id'=hold->>'layer_id')) THEN RAISE EXCEPTION 'Zwolnienie zmieniło zamrożone lokalizacje lub warstwy niewydanych paczek' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum((pr->>'quantity')::bigint),0) INTO physical FROM jsonb_array_elements(products) pr;SELECT count(*) INTO issued FROM order_parcel_dispatches WHERE tenant_id=t AND plan_id=pid;
 RETURN jsonb_build_object('plan_id',pid,'order_id',o.id,'order_version',o.version::text,'pending',pending,'products',products,'wms_enabled',EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=t AND enabled),'summary',jsonb_build_object('pending_parcels',jsonb_array_length(pending),'commercial_quantity',commercial,'physical_quantity',physical,'issued_parcels',issued),'snapshot',order_parcel_release_snapshot(o.id));
END $$;

CREATE FUNCTION order_parcel_release_store_preview(pid uuid,plan uuid,b jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p order_parcel_release_previews;f jsonb;h text;BEGIN
 PERFORM order_parcel_require(uid,kid,true,false);PERFORM order_parcel_release_require();PERFORM order_parcel_lock((SELECT order_id FROM order_parcel_plans WHERE tenant_id=t AND id=plan));
 h:=order_parcel_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'kind','release_preview','plan_id',plan,'request',b));SELECT * INTO p FROM order_parcel_release_previews WHERE tenant_id=t AND client_key=(b->>'client_key')::uuid;
 IF p.id IS NOT NULL THEN IF(p.plan_id,p.actor_id,p.api_key_id,p.request_hash) IS DISTINCT FROM(plan,uid,kid,h) THEN RAISE EXCEPTION 'Klucz zwolnienia ma inny zakres' USING ERRCODE='23514';END IF;RETURN p.id;END IF;
 f:=order_parcel_release_frame(plan,b,uid,kid);IF octet_length(f::text)>4194304 THEN RAISE EXCEPTION 'Podgląd zwolnienia jest zbyt duży' USING ERRCODE='23514';END IF;
 INSERT INTO order_parcel_release_previews(id,tenant_id,plan_id,order_id,actor_id,api_key_id,client_key,request_hash,scope_hash,request,payload,expires_at) VALUES(pid,t,plan,(f->>'order_id')::uuid,uid,kid,(b->>'client_key')::uuid,h,order_parcel_hash(f),b,f,clock_timestamp()+interval '15 minutes');PERFORM order_parcel_release_budget();RETURN pid;
END $$;
CREATE FUNCTION order_parcel_release_prepare(pid uuid,eid uuid,b jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p order_parcel_release_previews;e order_parcel_releases;f jsonb;h text;BEGIN
 PERFORM order_parcel_require(uid,kid,true,false);PERFORM order_parcel_release_require();SELECT * INTO p FROM order_parcel_release_previews WHERE tenant_id=t AND id=pid;IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono podglądu zwolnienia' USING ERRCODE='P0002';END IF;PERFORM order_parcel_lock(p.order_id);
 h:=order_parcel_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'kind','release','preview_id',pid,'request',b));SELECT * INTO e FROM order_parcel_releases WHERE tenant_id=t AND client_key=(b->>'client_key')::uuid;
 IF e.id IS NOT NULL THEN IF(e.preview_id,e.actor_id,e.api_key_id,e.request_hash) IS DISTINCT FROM(pid,uid,kid,h) THEN RAISE EXCEPTION 'Klucz zwolnienia ma inny zakres' USING ERRCODE='23514';END IF;RETURN e.id;END IF;
 IF(p.actor_id,p.api_key_id) IS DISTINCT FROM(uid,kid) OR p.expires_at<=clock_timestamp() OR jsonb_typeof(b)<>'object' OR(SELECT count(*) FROM jsonb_object_keys(b))<>3 OR NOT b?&ARRAY['client_key','scope_hash','confirmed'] OR b->>'scope_hash' IS DISTINCT FROM p.scope_hash OR b->'confirmed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Zwolnienie wymaga świeżej własnej zgody' USING ERRCODE='23514';END IF;
 f:=order_parcel_release_frame(p.plan_id,p.request,uid,kid);IF f IS DISTINCT FROM p.payload THEN RAISE EXCEPTION 'Zakres zwolnienia zmienił się' USING ERRCODE='23514';END IF;
 INSERT INTO order_parcel_release_admissions(tenant_id,transaction_id,operation_id,preview_id,plan_id,order_id,actor_id,api_key_id,client_key,request_hash,scope_hash,request,payload,before_snapshot) VALUES(t,pg_current_xact_id(),eid,pid,p.plan_id,p.order_id,uid,kid,(b->>'client_key')::uuid,h,p.scope_hash,b,f,f->'snapshot');RETURN eid;
END $$;
CREATE FUNCTION order_parcel_release_scope(eid uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a order_parcel_release_admissions;t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;BEGIN
 PERFORM order_parcel_require(uid,kid,true,false);PERFORM order_parcel_release_require();SELECT * INTO a FROM order_parcel_release_admissions WHERE tenant_id=t AND transaction_id=pg_current_xact_id() AND operation_id=eid AND opened_at=transaction_timestamp();
 IF a.operation_id IS NULL OR(a.actor_id,a.api_key_id) IS DISTINCT FROM(uid,kid) OR EXISTS(SELECT 1 FROM order_parcel_releases WHERE tenant_id=t AND id=eid) THEN RAISE EXCEPTION 'Brak bieżącej zgody zwolnienia' USING ERRCODE='23514';END IF;
 RETURN(a.payload-ARRAY['snapshot','order_version'])||jsonb_build_object('operation_id',eid);
END $$;

CREATE FUNCTION order_parcel_release_source(pid uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p order_parcel_plans;f jsonb;pending jsonb;rid uuid;g jsonb;o orders;BEGIN
 PERFORM order_parcel_require(uid,kid,false,false);PERFORM order_parcel_release_require();SELECT * INTO p FROM order_parcel_plans WHERE tenant_id=t AND id=pid;IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono planu paczek' USING ERRCODE='P0002';END IF;
 SELECT * INTO o FROM orders WHERE tenant_id=t AND id=p.order_id;SELECT id INTO rid FROM order_parcel_releases WHERE tenant_id=t AND plan_id=pid;
 SELECT coalesce(jsonb_agg(value ORDER BY(value->>'index')::int),'[]') INTO pending FROM jsonb_array_elements(p.payload->'parcels') x WHERE NOT EXISTS(SELECT 1 FROM order_parcel_dispatches d WHERE d.tenant_id=t AND d.plan_id=pid AND d.parcel_index=(x.value->>'index')::int);
 g:=order_parcel_access(uid,kid,true,false);
 IF rid IS NULL AND(g->>'allowed')::boolean AND(g->>'key_valid')::boolean THEN
  BEGIN f:=order_parcel_release_frame(pid,jsonb_build_object('client_key','00000000-0000-4000-8000-000000000000','order_version',o.version::text),uid,kid);EXCEPTION WHEN check_violation THEN f:=NULL;END;
 END IF;
 RETURN jsonb_build_object('plan_id',pid,'order_id',p.order_id,'order_version',o.version::text,'pending',CASE WHEN rid IS NULL THEN pending ELSE '[]'::jsonb END,'products',coalesce(f->'products','[]'),'wms_enabled',EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=t AND enabled),'summary',coalesce(f->'summary',jsonb_build_object('pending_parcels',CASE WHEN rid IS NULL THEN jsonb_array_length(pending) ELSE 0 END,'commercial_quantity',0,'physical_quantity',0,'issued_parcels',(SELECT count(*) FROM order_parcel_dispatches WHERE tenant_id=t AND plan_id=pid))),'released_id',rid,'can_release',f IS NOT NULL AND rid IS NULL);
END $$;

CREATE FUNCTION order_parcel_release_terminal(pid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p order_parcel_plans;e order_parcel_releases;r record;oldrow jsonb;pr jsonb;delta integer;issued integer;BEGIN
 SELECT * INTO p FROM order_parcel_plans WHERE tenant_id=t AND id=pid;SELECT * INTO e FROM order_parcel_releases WHERE tenant_id=t AND plan_id=pid;
 IF e.id IS NULL OR p.id IS NULL OR p.payload->>'protocol' IS DISTINCT FROM 'commercial_v1' OR e.order_id IS DISTINCT FROM p.order_id THEN RAISE EXCEPTION 'Niekompletny zamknięty plan paczek' USING ERRCODE='23514';END IF;
 IF(SELECT count(*) FROM order_parcel_allocations WHERE tenant_id=t AND plan_id=pid)<>jsonb_array_length(p.payload->'parcels') OR EXISTS(SELECT 1 FROM order_parcel_allocations l JOIN shipments s ON(s.tenant_id,s.id,s.order_id)=(l.tenant_id,l.shipment_id,l.order_id) WHERE l.tenant_id=t AND l.plan_id=pid AND(l.payload IS DISTINCT FROM p.payload->'parcels'->l.index OR(s.carrier,s.mode,s.tracking_number,s.cod_expected) IS DISTINCT FROM(l.payload->>'carrier',l.payload->>'mode',l.payload->>'tracking_number',(l.payload->>'cod_minor')::int) OR(s.dispatched_at IS NOT NULL) IS DISTINCT FROM EXISTS(SELECT 1 FROM order_parcel_dispatches d WHERE(d.tenant_id,d.plan_id,d.parcel_index)=(l.tenant_id,l.plan_id,l.index)))) THEN RAISE EXCEPTION 'Zamknięty plan nie odpowiada rzeczywistym przesyłkom' USING ERRCODE='23514';END IF;
 IF e.payload->'pending' IS DISTINCT FROM(SELECT coalesce(jsonb_agg(value ORDER BY(value->>'index')::int),'[]') FROM jsonb_array_elements(p.payload->'parcels') x WHERE NOT EXISTS(SELECT 1 FROM order_parcel_dispatches d WHERE d.tenant_id=t AND d.plan_id=pid AND d.parcel_index=(x.value->>'index')::int)) THEN RAISE EXCEPTION 'Zwolnienie nie odpowiada dokładnie niewydanym paczkom' USING ERRCODE='23514';END IF;
 FOR r IN SELECT * FROM reservations WHERE tenant_id=t AND order_id=p.order_id LOOP
  SELECT value INTO pr FROM jsonb_array_elements(e.payload->'products') WHERE value->>'product_id'=r.product_id::text AND value->>'warehouse_id'=r.warehouse_id::text;
  SELECT coalesce(sum((v->>'quantity')::int),0) INTO issued FROM order_parcel_dispatches d JOIN order_parcel_allocations l ON(l.tenant_id,l.plan_id,l.index)=(d.tenant_id,d.plan_id,d.parcel_index) CROSS JOIN LATERAL jsonb_array_elements(l.payload->'products') v WHERE d.tenant_id=t AND d.plan_id=pid AND v->>'product_id'=r.product_id::text AND v->>'warehouse_id'=r.warehouse_id::text;
  IF r.consumed_quantity<>issued OR r.released_quantity<>coalesce((pr->>'quantity')::int,0) OR r.quantity<>r.consumed_quantity+r.released_quantity OR r.state IS DISTINCT FROM(CASE WHEN r.released_quantity>0 THEN 'released' ELSE 'consumed' END) THEN RAISE EXCEPTION 'Pierwotna ilość nie odpowiada wydaniu i zwolnieniu' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM reservation_locations WHERE tenant_id=t AND order_id=p.order_id AND quantity<>consumed_quantity+released_quantity) OR EXISTS(SELECT 1 FROM wms_reservation_layers WHERE tenant_id=t AND order_id=p.order_id AND(quantity<>consumed_quantity+released_quantity OR state IS DISTINCT FROM(CASE WHEN released_quantity>0 THEN 'released' ELSE 'consumed' END))) THEN RAISE EXCEPTION 'Niewydana lokalizacja lub warstwa nie jest zamknięta' USING ERRCODE='23514';END IF;
END $$;

-- Nest the installed 135/136 bodies verbatim. Trigger OIDs and the ordinary path remain intact.
DO $migration$DECLARE original text;prefix text;BEGIN
 SELECT prosrc INTO original FROM pg_proc WHERE oid='order_parcel_counter_guard()'::regprocedure;
 prefix:=$body$DECLARE release_a order_parcel_release_admissions;release_p jsonb;release_delta integer;BEGIN
 IF TG_OP='INSERT' AND NEW.released_quantity<>0 THEN RAISE EXCEPTION 'Początkowa rezerwacja nie może być zwolniona' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND NEW.released_quantity IS DISTINCT FROM OLD.released_quantity THEN
  PERFORM order_parcel_release_require();SELECT * INTO release_a FROM order_parcel_release_admissions WHERE tenant_id=OLD.tenant_id AND transaction_id=pg_current_xact_id() AND opened_at=transaction_timestamp() AND order_id=OLD.order_id AND NOT EXISTS(SELECT 1 FROM order_parcel_releases e WHERE(e.tenant_id,e.id)=(OLD.tenant_id,operation_id));
  IF release_a.operation_id IS NULL THEN RAISE EXCEPTION 'Zwolnienie rezerwacji wymaga bieżącej prywatnej zgody' USING ERRCODE='23514';END IF;
  SELECT value INTO release_p FROM jsonb_array_elements(release_a.payload->'products') WHERE value->>'product_id'=OLD.product_id::text AND value->>'warehouse_id'=OLD.warehouse_id::text;
  IF TG_TABLE_NAME='reservations' THEN release_delta:=coalesce((release_p->>'quantity')::int,0);
  ELSIF TG_TABLE_NAME='reservation_locations' THEN SELECT coalesce(sum((value->>'quantity')::int),0) INTO release_delta FROM jsonb_array_elements(release_p->'locations') WHERE value->>'location'=OLD.location;
  ELSE SELECT coalesce(sum((value->>'quantity')::int),0) INTO release_delta FROM jsonb_array_elements(release_p->'lot_holds') WHERE value->>'location'=OLD.location AND value->>'layer_id'=OLD.layer_id::text;END IF;
  IF release_delta<=0 OR OLD.quantity-OLD.consumed_quantity-OLD.released_quantity<>release_delta OR NEW.released_quantity<>OLD.released_quantity+release_delta OR(to_jsonb(NEW)-ARRAY['released_quantity','state']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['released_quantity','state']) THEN RAISE EXCEPTION 'Licznik zwolnienia nie odpowiada pełnej pozostałej ilości' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME<>'reservation_locations' THEN IF NEW.state IS DISTINCT FROM 'released' THEN RAISE EXCEPTION 'Zamknięta rezerwacja wymaga jawnego zwolnienia' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND OLD.released_quantity>0 AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'Zwolniona rezerwacja jest trwała' USING ERRCODE='23514';END IF;
$body$;
 EXECUTE 'CREATE OR REPLACE FUNCTION order_parcel_counter_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $wrapped$'||prefix||regexp_replace(original,';[[:space:]]*$','')||';END;$wrapped$';
 SELECT prosrc INTO original FROM pg_proc WHERE oid='order_parcel_complete()'::regprocedure;
 prefix:=$body$BEGIN
 IF TG_TABLE_NAME<>'order_parcel_previews' AND EXISTS(SELECT 1 FROM order_parcel_releases WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id) THEN
  PERFORM order_parcel_release_terminal((SELECT plan_id FROM order_parcel_releases WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id));PERFORM order_parcel_require(NEW.actor_id,NEW.api_key_id,true,false);PERFORM order_parcel_budget();RETURN NULL;
 END IF;
$body$;
 EXECUTE 'CREATE OR REPLACE FUNCTION order_parcel_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $wrapped$'||prefix||regexp_replace(original,';[[:space:]]*$','')||';END;$wrapped$';
 SELECT prosrc INTO original FROM pg_proc WHERE oid='wms_validate_quantity_scope(uuid,uuid,uuid,boolean)'::regprocedure;
 original:=replace(replace(replace(replace(replace(original,'a.quantity-a.consumed_quantity','a.quantity-a.consumed_quantity-a.released_quantity'),'r.quantity-r.consumed_quantity','r.quantity-r.consumed_quantity-r.released_quantity'),'b.quantity-b.consumed_quantity','b.quantity-b.consumed_quantity-b.released_quantity'),'quantity-consumed_quantity','quantity-consumed_quantity-released_quantity'),'a.scanned-a.consumed_quantity','a.scanned-a.consumed_quantity-a.released_quantity');
 original:=replace(replace(replace(original,'b.scanned-b.consumed_quantity','b.scanned-b.consumed_quantity-b.released_quantity'),'i.scanned-r.consumed_quantity','i.scanned-r.consumed_quantity-r.released_quantity'),'r.quantity,r.consumed_quantity','r.quantity,r.consumed_quantity,r.released_quantity');
 original:=replace(original,'i.scanned,r.consumed_quantity','i.scanned,r.consumed_quantity,r.released_quantity');
 EXECUTE 'CREATE OR REPLACE FUNCTION wms_validate_quantity_scope(t uuid,w uuid,p uuid,policy_scope boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $wrapped$'||original||'$wrapped$';
END $migration$;

CREATE OR REPLACE FUNCTION order_parcel_bound_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p order_parcel_plans;oid uuid;t uuid;release_a order_parcel_release_admissions;closed boolean;BEGIN
 IF TG_TABLE_NAME='orders' THEN oid:=coalesce(OLD.id,NEW.id);ELSE oid:=coalesce(OLD.order_id,NEW.order_id);END IF;t:=coalesce(OLD.tenant_id,NEW.tenant_id);
 SELECT * INTO p FROM order_parcel_plans WHERE tenant_id=t AND order_id=oid;IF p.id IS NULL THEN RETURN coalesce(NEW,OLD);END IF;
 IF TG_TABLE_NAME='order_items' THEN RAISE EXCEPTION 'Po przydziale paczek pozycje sprzedaży są trwałe' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='shipments' AND TG_OP IN('INSERT','DELETE') THEN RAISE EXCEPTION 'Plan paczek zawiera zamknięty zestaw źródeł przesyłek' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='orders' THEN
  IF TG_OP<>'UPDATE' OR(NEW.id,NEW.tenant_id,NEW.warehouse_id,NEW.total,NEW.shipping_cost,NEW.currency,NEW.payment_mode,NEW.customer_name,NEW.email,NEW.address,NEW.source,NEW.channel_id,NEW.external_id) IS DISTINCT FROM(OLD.id,OLD.tenant_id,OLD.warehouse_id,OLD.total,OLD.shipping_cost,OLD.currency,OLD.payment_mode,OLD.customer_name,OLD.email,OLD.address,OLD.source,OLD.channel_id,OLD.external_id) THEN RAISE EXCEPTION 'Przydział paczek zamraża odbiorcę i zamówienie' USING ERRCODE='23514';END IF;
  SELECT * INTO release_a FROM order_parcel_release_admissions WHERE tenant_id=t AND transaction_id=pg_current_xact_id() AND opened_at=transaction_timestamp() AND order_id=oid;
  IF release_a.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM order_parcel_releases WHERE tenant_id=t AND id=release_a.operation_id) THEN
   IF NEW.status IS DISTINCT FROM(CASE WHEN(release_a.payload->'summary'->>'issued_parcels')::int>0 THEN 'shipped' ELSE 'cancelled' END) OR(to_jsonb(NEW)-ARRAY['status','version','updated_at','workflow_status_id']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['status','version','updated_at','workflow_status_id']) THEN RAISE EXCEPTION 'Zamknięcie planu nie odpowiada zwolnieniu' USING ERRCODE='23514';END IF;RETURN NEW;
  END IF;
  closed:=EXISTS(SELECT 1 FROM order_parcel_releases WHERE tenant_id=t AND plan_id=p.id);
  IF closed AND NEW.status IS DISTINCT FROM OLD.status AND (EXISTS(SELECT 1 FROM order_parcel_dispatches WHERE tenant_id=t AND plan_id=p.id) AND NEW.status NOT IN('shipped','delivered','completed','return_initiated','return_received','return_completed') OR NOT EXISTS(SELECT 1 FROM order_parcel_dispatches WHERE tenant_id=t AND plan_id=p.id) AND NEW.status<>'cancelled') THEN RAISE EXCEPTION 'Zamkniętego planu nie można ponownie otworzyć do realizacji' USING ERRCODE='23514';END IF;
  IF NEW.status<>'packed' AND NOT closed AND EXISTS(SELECT 1 FROM order_parcel_allocations l WHERE l.tenant_id=t AND l.plan_id=p.id AND NOT EXISTS(SELECT 1 FROM order_parcel_dispatches d WHERE(d.tenant_id,d.plan_id,d.parcel_index)=(l.tenant_id,l.plan_id,l.index))) THEN RAISE EXCEPTION 'Częściowo wydany plan musi pozostać spakowany' USING ERRCODE='23514';END IF;
 END IF;RETURN coalesce(NEW,OLD);
END $$;
DO $migration$DECLARE original text;prefix text;BEGIN
 SELECT prosrc INTO original FROM pg_proc WHERE oid='order_shipments_dispatch_guard()'::regprocedure;
 prefix:=$body$DECLARE release_a order_parcel_release_admissions;BEGIN
 IF NEW.status='shipped' AND NEW.status IS DISTINCT FROM OLD.status THEN
  SELECT * INTO release_a FROM order_parcel_release_admissions WHERE tenant_id=NEW.tenant_id AND transaction_id=pg_current_xact_id() AND opened_at=transaction_timestamp() AND order_id=NEW.id;
  IF release_a.operation_id IS NOT NULL AND(release_a.payload->'summary'->>'issued_parcels')::int>0 AND NOT EXISTS(SELECT 1 FROM reservations WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id AND quantity<>consumed_quantity+released_quantity) THEN RETURN NEW;END IF;
 END IF;
$body$;
 EXECUTE 'CREATE OR REPLACE FUNCTION order_shipments_dispatch_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $wrapped$'||prefix||regexp_replace(original,';[[:space:]]*$','')||';END;$wrapped$';
 -- A canceled allocation cannot acquire a later ordinary or parcel dispatch admission.
 SELECT prosrc INTO original FROM pg_proc WHERE oid='order_parcel_prepare_dispatch(uuid,integer,uuid,jsonb,uuid,uuid)'::regprocedure;
 prefix:=$body$BEGIN
 IF EXISTS(SELECT 1 FROM order_parcel_releases e WHERE e.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND e.plan_id=pid AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.payload->'pending') x WHERE(value->>'index')::int=n)) THEN RAISE EXCEPTION 'Zwolniona paczka nie może zostać wydana' USING ERRCODE='23514';END IF;
$body$;
 EXECUTE 'CREATE OR REPLACE FUNCTION order_parcel_prepare_dispatch(pid uuid,n integer,eid uuid,b jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $wrapped$'||prefix||regexp_replace(original,';[[:space:]]*$','')||';END;$wrapped$';
END $migration$;

CREATE FUNCTION order_parcel_release_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d jsonb;e order_parcel_releases;a order_parcel_release_admissions;BEGIN
 FOR d IN SELECT value FROM jsonb_array_elements(CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(to_jsonb(NEW)) WHEN 'DELETE' THEN jsonb_build_array(to_jsonb(OLD)) ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END) LOOP
  FOR e IN SELECT r.* FROM order_parcel_releases r JOIN order_parcel_release_admissions c ON(c.tenant_id,c.operation_id)=(r.tenant_id,r.id) WHERE c.transaction_id=pg_current_xact_id() AND c.opened_at=transaction_timestamp() AND r.tenant_id=(d->>'tenant_id')::uuid LOOP
   IF TG_TABLE_NAME='orders' AND d->>'id'=e.order_id::text OR d->>'order_id'=e.order_id::text OR d->>'product_id' IN(SELECT value->>'product_id' FROM jsonb_array_elements(e.payload->'products')) OR TG_TABLE_NAME IN('wms_policies','purchasing_stock_changes') OR TG_TABLE_NAME IN('order_parcel_origin_issues','order_parcel_origin_fragments') AND EXISTS(SELECT 1 FROM order_parcel_commercial_origins o WHERE o.tenant_id=e.tenant_id AND o.order_id=e.order_id AND o.id=(d->>'origin_id')::uuid) THEN RAISE EXCEPTION 'Zwolnienie zapieczętowało końcowy stan i historię' USING ERRCODE='23514';END IF;
  END LOOP;
 END LOOP;RETURN coalesce(NEW,OLD);
END $$;
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['orders','order_items','order_pick_items','shipments','payment_entries','documents','return_cases','return_items','reservations','reservation_locations','wms_reservation_layers','stock','stock_locations','stock_movements','stock_location_movements','wms_layer_positions','wms_layer_movements','wms_operations','wms_issue_fragments','wms_return_fragments','wms_cost_layers','wms_lots','wms_policies','purchasing_stock_changes','order_parcel_dispatches','order_parcel_commercial_origins','order_parcel_origin_issues','order_parcel_origin_fragments'] LOOP EXECUTE format('CREATE TRIGGER order_parcel_release_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION order_parcel_release_seal()',rel);END LOOP;END $$;

CREATE FUNCTION order_parcel_release_guards() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_release_previews','order_parcel_releases','order_parcel_release_admissions']) rel WHERE NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(rel) AND relrowsecurity AND relforcerowsecurity))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['reservations','reservation_locations','wms_reservation_layers']) rel WHERE NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(rel) AND attname='released_quantity' AND atttypid='int4'::regtype AND attnotnull AND NOT attisdropped))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_release_snapshot(uuid)','order_parcel_release_frame(uuid,jsonb,uuid,uuid)','order_parcel_release_source(uuid,uuid,uuid)','order_parcel_release_store_preview(uuid,uuid,jsonb,uuid,uuid)','order_parcel_release_prepare(uuid,uuid,jsonb,uuid,uuid)','order_parcel_release_scope(uuid,uuid,uuid)','order_parcel_release_finish(uuid,jsonb,uuid,uuid)','order_parcel_release_validate(order_parcel_release_admissions,jsonb,jsonb)','order_parcel_release_terminal(uuid)','order_parcel_release_budget()','order_parcel_release_require()','order_parcel_release_guard()','order_parcel_release_complete()','order_parcel_release_seal()']) f WHERE to_regprocedure(f) IS NULL)
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_release_previews','order_parcel_releases','order_parcel_release_admissions']) rel WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(rel) AND tgname='order_parcel_release_guard' AND tgfoid=to_regprocedure('order_parcel_release_guard()') AND tgenabled='O' AND NOT tgisinternal) OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(rel) AND tgname='order_parcel_release_complete' AND tgfoid=to_regprocedure('order_parcel_release_complete()') AND tgenabled='O' AND tgdeferrable AND tginitdeferred AND NOT tgisinternal))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['orders','order_items','order_pick_items','shipments','payment_entries','documents','return_cases','return_items','reservations','reservation_locations','wms_reservation_layers','stock','stock_locations','stock_movements','stock_location_movements','wms_layer_positions','wms_layer_movements','wms_operations','wms_issue_fragments','wms_return_fragments','wms_cost_layers','wms_lots','wms_policies','purchasing_stock_changes','order_parcel_dispatches','order_parcel_commercial_origins','order_parcel_origin_issues','order_parcel_origin_fragments']) rel WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(rel) AND tgname='order_parcel_release_seal' AND tgfoid=to_regprocedure('order_parcel_release_seal()') AND tgenabled='O' AND NOT tgisinternal))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_release_previews','order_parcel_releases','order_parcel_release_admissions']) rel WHERE EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass(rel) AND contype='f' AND NOT convalidated))
 AND NOT has_table_privilege('dyna_app','order_parcel_release_admissions','SELECT,INSERT,UPDATE,DELETE')
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_release_previews','order_parcel_releases']) rel WHERE has_table_privilege('dyna_app',rel,'INSERT,UPDATE,DELETE'))
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('order_parcel_release_previews') AND contype='f')=4
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('order_parcel_releases') AND contype='f')=5
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('order_parcel_release_admissions') AND contype='f')=4
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('order_parcel_release_admissions') AND confrelid=to_regclass('order_parcel_releases') AND contype='f' AND condeferrable AND condeferred AND convalidated)
$$;
CREATE FUNCTION order_parcel_release_require() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN IF order_parcel_release_guards() IS NOT TRUE THEN RAISE EXCEPTION 'Moduł zwolnień paczek jest niekompletny' USING ERRCODE='55000';END IF;END $$;
-- Both old and new typed writers share the existing tenant quota, never a second lock order.
DO $migration$DECLARE original text;BEGIN
 SELECT prosrc INTO original FROM pg_proc WHERE oid='order_parcel_budget()'::regprocedure;
 EXECUTE 'CREATE OR REPLACE FUNCTION order_parcel_budget() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $wrapped$BEGIN '||regexp_replace(original,';[[:space:]]*$','')||';PERFORM order_parcel_release_budget();END;$wrapped$';
 SELECT prosrc INTO original FROM pg_proc WHERE oid='order_parcel_guards()'::regprocedure;
 EXECUTE 'CREATE OR REPLACE FUNCTION order_parcel_guards() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $wrapped$SELECT ('||regexp_replace(original,'^[[:space:]]*SELECT[[:space:]]|;[[:space:]]*$','','g')||') AND order_parcel_release_guards()$wrapped$';
END $migration$;
DO $$DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'order_parcel_release_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.signature);END LOOP;END $$;
GRANT EXECUTE ON FUNCTION order_parcel_release_installed(),order_parcel_release_guards(),order_parcel_release_source(uuid,uuid,uuid),order_parcel_release_store_preview(uuid,uuid,jsonb,uuid,uuid),order_parcel_release_prepare(uuid,uuid,jsonb,uuid,uuid),order_parcel_release_scope(uuid,uuid,uuid),order_parcel_release_finish(uuid,jsonb,uuid,uuid) TO dyna_app;
