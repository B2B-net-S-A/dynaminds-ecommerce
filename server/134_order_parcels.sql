-- Explicit physical parcel coverage. Original reservation quantities/history stay intact.
ALTER TABLE reservations ADD COLUMN consumed_quantity integer NOT NULL DEFAULT 0 CHECK(consumed_quantity BETWEEN 0 AND quantity);
ALTER TABLE reservation_locations ADD COLUMN consumed_quantity integer NOT NULL DEFAULT 0 CHECK(consumed_quantity BETWEEN 0 AND quantity);
ALTER TABLE wms_reservation_layers ADD COLUMN consumed_quantity integer NOT NULL DEFAULT 0 CHECK(consumed_quantity BETWEEN 0 AND quantity);

CREATE TABLE order_parcel_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,order_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),request jsonb NOT NULL,payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,order_id),UNIQUE(tenant_id,client_key),CHECK(expires_at>created_at),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE order_parcel_plans (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,order_id uuid NOT NULL,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),request jsonb NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,order_id),UNIQUE(tenant_id,order_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,preview_id),
 FOREIGN KEY(tenant_id,preview_id,order_id) REFERENCES order_parcel_previews(tenant_id,id,order_id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE order_parcel_allocations (
 tenant_id uuid NOT NULL,plan_id uuid NOT NULL,order_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 49),shipment_id uuid NOT NULL,payload jsonb NOT NULL,
 PRIMARY KEY(tenant_id,plan_id,index),UNIQUE(tenant_id,shipment_id),UNIQUE(tenant_id,plan_id,index,shipment_id),
 FOREIGN KEY(tenant_id,plan_id,order_id) REFERENCES order_parcel_plans(tenant_id,id,order_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,order_id,shipment_id) REFERENCES shipments(tenant_id,order_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE order_parcel_dispatches (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,plan_id uuid NOT NULL,order_id uuid NOT NULL,parcel_index integer NOT NULL,shipment_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),request jsonb NOT NULL,receipt jsonb NOT NULL,before_snapshot jsonb NOT NULL,after_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,plan_id,parcel_index),
 FOREIGN KEY(tenant_id,plan_id,order_id) REFERENCES order_parcel_plans(tenant_id,id,order_id),FOREIGN KEY(tenant_id,plan_id,parcel_index,shipment_id) REFERENCES order_parcel_allocations(tenant_id,plan_id,index,shipment_id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE order_parcel_admissions (
 tenant_id uuid NOT NULL,transaction_id xid8 NOT NULL,operation_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('apply','dispatch')),order_id uuid NOT NULL,plan_id uuid NOT NULL,parcel_index integer,actor_id uuid NOT NULL,api_key_id uuid,
 scope_hash text NOT NULL,payload jsonb NOT NULL,before_snapshot jsonb NOT NULL,opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,transaction_id,operation_id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,plan_id) REFERENCES order_parcel_plans(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX order_parcel_preview_page ON order_parcel_previews(tenant_id,order_id,created_at DESC,id DESC);
CREATE INDEX order_parcel_plan_page ON order_parcel_plans(tenant_id,order_id,created_at DESC,id DESC);
CREATE INDEX order_parcel_dispatch_order ON order_parcel_dispatches(tenant_id,order_id,parcel_index);
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['order_parcel_previews','order_parcel_plans','order_parcel_allocations','order_parcel_dispatches','order_parcel_admissions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',rel);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',rel);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',rel);
 EXECUTE format('CREATE POLICY owner_scope ON %I TO %I USING(true) WITH CHECK(true)',rel,current_user);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',rel);
 IF rel<>'order_parcel_admissions' THEN EXECUTE format('GRANT SELECT ON %I TO dyna_app',rel);END IF;
END LOOP;END $$;

CREATE FUNCTION order_parcel_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$SELECT encode(sha256(convert_to(v::text,'UTF8')),'hex')$$;
CREATE FUNCTION order_parcel_identity(parent uuid,n integer) RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT (substr(h,1,8)||'-'||substr(h,9,4)||'-8'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid FROM(SELECT encode(sha256(convert_to('order.parcel:'||parent::text||':'||n::text,'UTF8')),'hex') h)x
$$;
CREATE FUNCTION order_parcel_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$SELECT EXISTS(SELECT 1 FROM migrations WHERE name='134_order_parcels')$$;
CREATE FUNCTION order_parcel_access(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r text;k api_keys;valid boolean:=true;scoped boolean:=true;
BEGIN
 IF pin THEN SELECT role INTO r FROM memberships WHERE tenant_id=t AND user_id=uid FOR SHARE;ELSE SELECT role INTO r FROM memberships WHERE tenant_id=t AND user_id=uid;END IF;
 IF kid IS NOT NULL THEN
  IF pin THEN SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid FOR SHARE;ELSE SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid;END IF;
  valid:=k.id IS NOT NULL AND k.revoked_at IS NULL AND(k.expires_at IS NULL OR k.expires_at>clock_timestamp());scoped:=valid AND 'orders:read'=ANY(k.scopes) AND(NOT writing OR 'orders:write'=ANY(k.scopes));
 END IF;
 RETURN jsonb_build_object('role',r,'key_valid',valid,'allowed',r IN('admin','operator','viewer') AND scoped AND(NOT writing OR r IN('admin','operator')));
END $$;

CREATE FUNCTION order_parcel_budget() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;bytes bigint;BEGIN
 IF(SELECT count(*) FROM order_parcel_previews WHERE tenant_id=t)>2000 OR(SELECT count(*) FROM order_parcel_plans WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit historii paczek' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(n),0) INTO bytes FROM(SELECT octet_length(to_jsonb(p)::text) n FROM order_parcel_previews p WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(p)::text) FROM order_parcel_plans p WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(p)::text) FROM order_parcel_allocations p WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(p)::text) FROM order_parcel_dispatches p WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(p)::text) FROM order_parcel_admissions p WHERE tenant_id=t)x;
 IF bytes>67108864 THEN RAISE EXCEPTION 'Limit danych paczek' USING ERRCODE='23514';END IF;
END $$;

CREATE FUNCTION order_parcel_store_preview(pid uuid,oid uuid,b jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p order_parcel_previews;h text;f jsonb;BEGIN
 PERFORM order_parcel_require(uid,kid,true,false);PERFORM order_parcel_lock(oid);
 h:=order_parcel_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'kind','preview','order_id',oid,'request',b));
 SELECT * INTO p FROM order_parcel_previews WHERE tenant_id=t AND client_key=(b->>'client_key')::uuid;
 IF p.id IS NOT NULL THEN IF(p.order_id,p.actor_id,p.api_key_id,p.request_hash) IS DISTINCT FROM(oid,uid,kid,h) THEN RAISE EXCEPTION 'Klucz podglądu ma inny zakres' USING ERRCODE='23514';END IF;RETURN p.id;END IF;
 f:=order_parcel_frame(pid,oid,b,uid,kid);IF octet_length(f::text)>4194304 THEN RAISE EXCEPTION 'Podgląd paczek jest zbyt duży' USING ERRCODE='23514';END IF;
 INSERT INTO order_parcel_previews(id,tenant_id,order_id,actor_id,api_key_id,client_key,request_hash,scope_hash,request,payload,expires_at) VALUES(pid,t,oid,uid,kid,(b->>'client_key')::uuid,h,order_parcel_hash(f),b,f,clock_timestamp()+interval '15 minutes');PERFORM order_parcel_budget();RETURN pid;
END $$;
CREATE FUNCTION order_parcel_apply(pid uuid,eid uuid,b jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p order_parcel_previews;e order_parcel_plans;f jsonb;x jsonb;h text;BEGIN
 PERFORM order_parcel_require(uid,kid,true,false);SELECT * INTO p FROM order_parcel_previews WHERE tenant_id=t AND id=pid;IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono podglądu' USING ERRCODE='P0002';END IF;PERFORM order_parcel_lock(p.order_id);
 h:=order_parcel_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'kind','apply','preview_id',pid,'request',b));
 SELECT * INTO e FROM order_parcel_plans WHERE tenant_id=t AND client_key=(b->>'client_key')::uuid;
 IF e.id IS NOT NULL THEN IF(e.preview_id,e.actor_id,e.api_key_id,e.request_hash) IS DISTINCT FROM(pid,uid,kid,h) THEN RAISE EXCEPTION 'Klucz planu ma inny zakres' USING ERRCODE='23514';END IF;RETURN e.id;END IF;
 IF(p.actor_id,p.api_key_id) IS DISTINCT FROM(uid,kid) OR p.expires_at<=clock_timestamp() OR b->>'scope_hash' IS DISTINCT FROM p.scope_hash OR b->'confirmed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Podgląd paczek wymaga świeżej własnej zgody' USING ERRCODE='23514';END IF;
 f:=order_parcel_frame(p.id,p.order_id,p.request,uid,kid);IF f IS DISTINCT FROM p.payload THEN RAISE EXCEPTION 'Zakres paczek zmienił się' USING ERRCODE='23514';END IF;
 INSERT INTO order_parcel_admissions(tenant_id,transaction_id,operation_id,kind,order_id,plan_id,actor_id,api_key_id,scope_hash,payload,before_snapshot) VALUES(t,pg_current_xact_id(),eid,'apply',p.order_id,eid,uid,kid,p.scope_hash,p.payload,p.payload->'snapshot');
 FOR x IN SELECT value FROM jsonb_array_elements(p.payload->'parcels') LOOP
  IF x->>'source_kind'='demo' THEN INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode,cod_expected) VALUES((x->>'shipment_id')::uuid,t,p.order_id,x->>'carrier',x->>'tracking_number','demo',(x->>'cod_minor')::integer);END IF;
  INSERT INTO order_parcel_allocations(tenant_id,plan_id,order_id,index,shipment_id,payload) VALUES(t,eid,p.order_id,(x->>'index')::integer,(x->>'shipment_id')::uuid,x);
 END LOOP;
 INSERT INTO order_parcel_plans(id,tenant_id,order_id,preview_id,actor_id,api_key_id,client_key,request_hash,scope_hash,request,payload) VALUES(eid,t,p.order_id,pid,uid,kid,(b->>'client_key')::uuid,h,p.scope_hash,b,p.payload);
 PERFORM order_parcel_require(uid,kid,true,false);PERFORM order_parcel_budget();RETURN eid;
END $$;

CREATE FUNCTION order_parcel_prepare_dispatch(pid uuid,n integer,eid uuid,b jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p order_parcel_plans;e order_parcel_dispatches;x jsonb;h text;sh shipments;r record;pr jsonb;current_source jsonb;collected bigint;BEGIN
 PERFORM order_parcel_require(uid,kid,true,false);SELECT * INTO p FROM order_parcel_plans WHERE tenant_id=t AND id=pid;IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono planu' USING ERRCODE='P0002';END IF;PERFORM order_parcel_lock(p.order_id);
 h:=order_parcel_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'kind','dispatch','plan_id',pid,'index',n,'request',b));
 SELECT * INTO e FROM order_parcel_dispatches WHERE tenant_id=t AND client_key=(b->>'client_key')::uuid;
 IF e.id IS NOT NULL THEN IF(e.plan_id,e.parcel_index,e.actor_id,e.api_key_id,e.request_hash) IS DISTINCT FROM(pid,n,uid,kid,h) THEN RAISE EXCEPTION 'Klucz wydania ma inny zakres' USING ERRCODE='23514';END IF;RETURN e.id;END IF;
 IF b->>'scope_hash' IS DISTINCT FROM p.scope_hash OR b->'confirmed' IS DISTINCT FROM 'true'::jsonb OR EXISTS(SELECT 1 FROM order_parcel_dispatches WHERE tenant_id=t AND plan_id=pid AND parcel_index=n) OR NOT EXISTS(SELECT 1 FROM orders WHERE tenant_id=t AND id=p.order_id AND status='packed') THEN RAISE EXCEPTION 'Paczka nie jest gotowa do wydania' USING ERRCODE='23514';END IF;
 SELECT payload INTO x FROM order_parcel_allocations WHERE tenant_id=t AND plan_id=pid AND index=n;IF x IS NULL THEN RAISE EXCEPTION 'Nie znaleziono paczki' USING ERRCODE='P0002';END IF;
 current_source:=order_parcel_source(p.order_id);
 IF((current_source->'order')-ARRAY['version','status']) IS DISTINCT FROM((p.payload->'source'->'order')-ARRAY['version','status']) OR current_source->'receiver' IS DISTINCT FROM p.payload->'source'->'receiver' THEN RAISE EXCEPTION 'Odbiorca lub zamówienie zmieniło się po przydziale' USING ERRCODE='23514';END IF;
 IF current_source->'order'->>'payment_mode'='cod' THEN
  SELECT coalesce(sum(pe.amount) FILTER(WHERE coalesce(original.kind,pe.kind)='courier_collection'),0) INTO collected FROM payment_entries pe LEFT JOIN payment_entries original ON(original.tenant_id,original.order_id,original.id)=(pe.tenant_id,pe.order_id,pe.reversal_of) WHERE pe.tenant_id=t AND pe.order_id=p.order_id AND pe.shipment_id IN(SELECT shipment_id FROM order_parcel_dispatches WHERE tenant_id=t AND plan_id=pid);
  IF(current_source->>'cod_due')::bigint IS DISTINCT FROM(p.payload->'source'->>'cod_due')::bigint-collected THEN RAISE EXCEPTION 'Aktualne pobranie nie odpowiada planowi paczek' USING ERRCODE='23514';END IF;
 ELSIF(current_source->>'payment_due')::bigint IS DISTINCT FROM 0::bigint THEN RAISE EXCEPTION 'Przedpłata paczki jest nieaktualna' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM payment_entries WHERE tenant_id=t AND order_id=p.order_id AND currency IS DISTINCT FROM current_source->'order'->>'currency') THEN RAISE EXCEPTION 'Waluta płatności paczki zmieniła się' USING ERRCODE='23514';END IF;
 SELECT * INTO sh FROM shipments WHERE tenant_id=t AND order_id=p.order_id AND id=(x->>'shipment_id')::uuid;
 IF sh.id IS NULL OR sh.dispatched_at IS NOT NULL OR(sh.carrier,sh.mode,sh.tracking_number,sh.cod_expected) IS DISTINCT FROM(x->>'carrier',x->>'mode',x->>'tracking_number',(x->>'cod_minor')::integer) OR sh.channel_id IS NOT NULL THEN RAISE EXCEPTION 'Źródło paczki zmieniło się' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM shipping_plans WHERE tenant_id=t AND order_id=p.order_id AND state NOT IN('preview','cancelled')) THEN RAISE EXCEPTION 'Plan przewoźnika blokuje lokalne wydanie' USING ERRCODE='23514';END IF;
 IF (p.payload->'source'->>'wms_enabled')::boolean IS DISTINCT FROM EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=t AND enabled) THEN RAISE EXCEPTION 'Polityka WMS zmieniła się' USING ERRCODE='23514';END IF;
  FOR pr IN SELECT value FROM jsonb_array_elements(x->'products') LOOP
  SELECT * INTO r FROM reservations WHERE tenant_id=t AND order_id=p.order_id AND product_id=(pr->>'product_id')::uuid;
  IF r.state<>'active' OR r.quantity-r.consumed_quantity<(pr->>'quantity')::integer OR r.warehouse_id IS DISTINCT FROM(pr->>'warehouse_id')::uuid THEN RAISE EXCEPTION 'Rezerwacja nie pokrywa paczki' USING ERRCODE='23514';END IF;
 END LOOP;
 PERFORM order_parcel_require(uid,kid,true,false);
 INSERT INTO order_parcel_admissions(tenant_id,transaction_id,operation_id,kind,order_id,plan_id,parcel_index,actor_id,api_key_id,scope_hash,payload,before_snapshot) VALUES(t,pg_current_xact_id(),eid,'dispatch',p.order_id,pid,n,uid,kid,p.scope_hash,jsonb_build_object('parcel',x,'request',b,'request_hash',h),order_parcel_snapshot(p.order_id));RETURN eid;
END $$;
CREATE FUNCTION order_parcel_dispatch_scope(pid uuid,n integer,eid uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;a order_parcel_admissions;BEGIN
 PERFORM order_parcel_require(uid,kid,true,false);SELECT * INTO a FROM order_parcel_admissions WHERE tenant_id=t AND transaction_id=pg_current_xact_id() AND operation_id=eid AND kind='dispatch' AND plan_id=pid AND parcel_index=n;
 IF a.operation_id IS NULL OR(a.actor_id,a.api_key_id) IS DISTINCT FROM(uid,kid) OR a.opened_at>clock_timestamp() OR EXISTS(SELECT 1 FROM order_parcel_dispatches WHERE tenant_id=t AND id=eid) THEN RAISE EXCEPTION 'Brak bieżącej zgody wydania paczki' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('order_id',a.order_id,'parcel',a.payload->'parcel','receipt_id',a.operation_id);
END $$;

CREATE FUNCTION order_parcel_validate_dispatch(a order_parcel_admissions,after_data jsonb,receipt_data jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE name text;oldrow jsonb;newrow jsonb;pr jsonb;part jsonb;keyfields text[];delta integer;v integer;qty integer;expected jsonb;actual jsonb;t uuid:=a.tenant_id;BEGIN
 IF receipt_data->>'operation_id' IS DISTINCT FROM a.operation_id::text THEN RAISE EXCEPTION 'Wydanie paczki nie ma właściwej operacji' USING ERRCODE='23514';END IF;
 FOREACH name IN ARRAY ARRAY['reservations','locations','holds','stock','bins','positions'] LOOP
  IF jsonb_array_length(a.before_snapshot->name) IS DISTINCT FROM jsonb_array_length(after_data->name) THEN RAISE EXCEPTION 'Wydanie zmieniło fizyczny zakres rezerwacji' USING ERRCODE='23514';END IF;
  FOR oldrow IN SELECT value FROM jsonb_array_elements(a.before_snapshot->name) LOOP
   keyfields:=CASE name WHEN 'reservations' THEN ARRAY['product_id'] WHEN 'stock' THEN ARRAY['product_id'] WHEN 'locations' THEN ARRAY['product_id','location'] WHEN 'bins' THEN ARRAY['product_id','location'] ELSE ARRAY['product_id','location','layer_id'] END;
   SELECT value INTO newrow FROM jsonb_array_elements(after_data->name) WHERE NOT EXISTS(SELECT 1 FROM unnest(keyfields) k WHERE value->k IS DISTINCT FROM oldrow->k);
   IF newrow IS NULL THEN RAISE EXCEPTION 'Brak fizycznego zakresu po wydaniu' USING ERRCODE='23514';END IF;
   SELECT value INTO pr FROM jsonb_array_elements(a.payload->'parcel'->'products') WHERE value->>'product_id'=oldrow->>'product_id';delta:=0;
   IF pr IS NOT NULL THEN
    IF name IN('reservations','stock') THEN delta:=(pr->>'quantity')::integer;
    ELSIF name IN('locations','bins') THEN SELECT coalesce(sum((value->>'quantity')::integer),0) INTO delta FROM jsonb_array_elements(pr->'locations') WHERE value->>'location'=oldrow->>'location';
    ELSE SELECT coalesce(sum((value->>'quantity')::integer),0) INTO delta FROM jsonb_array_elements(pr->'lot_holds') WHERE value->>'location'=oldrow->>'location' AND value->>'layer_id'=oldrow->>'layer_id';END IF;
   END IF;
   IF name IN('reservations','locations','holds') THEN
    expected:=oldrow||jsonb_build_object('consumed_quantity',(oldrow->>'consumed_quantity')::integer+delta);
    IF name IN('reservations','holds') AND delta>0 THEN expected:=expected||jsonb_build_object('state',CASE WHEN(oldrow->>'consumed_quantity')::integer+delta=(oldrow->>'quantity')::integer THEN 'consumed' ELSE 'active' END);END IF;
   ELSIF name='stock' THEN expected:=oldrow||jsonb_build_object('on_hand',(oldrow->>'on_hand')::integer-delta,'reserved',(oldrow->>'reserved')::integer-delta,'available',(oldrow->>'available')::integer,'version',(oldrow->>'version')::bigint+CASE WHEN delta>0 THEN 1 ELSE 0 END);
   ELSIF name='bins' THEN expected:=oldrow||jsonb_build_object('quantity',(oldrow->>'quantity')::integer-delta);
   ELSE expected:=oldrow||jsonb_build_object('quantity',(oldrow->>'quantity')::integer-delta,'reserved',(oldrow->>'reserved')::integer-delta,'version',(oldrow->>'version')::bigint+CASE WHEN delta>0 THEN 1 ELSE 0 END);END IF;
   IF expected IS DISTINCT FROM newrow THEN RAISE EXCEPTION 'Rzeczywiste wydanie nie odpowiada przydziałowi paczki' USING ERRCODE='23514';END IF;
  END LOOP;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'product_id',m.product_id,'warehouse_id',m.warehouse_id,'quantity',-m.delta) ORDER BY m.product_id),'[]') INTO actual FROM stock_movements m WHERE m.tenant_id=t AND m.order_id=a.order_id AND m.kind='shipment' AND m.id IN(SELECT(value->>'id')::uuid FROM jsonb_array_elements(receipt_data->'stock_movements'));
 IF actual IS DISTINCT FROM receipt_data->'stock_movements' OR jsonb_array_length(actual)<>jsonb_array_length(a.payload->'parcel'->'products') THEN RAISE EXCEPTION 'Brak pełnych ruchów magazynowych paczki' USING ERRCODE='23514';END IF;
 FOR pr IN SELECT value FROM jsonb_array_elements(a.payload->'parcel'->'products') LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(actual) m WHERE m->>'product_id'=pr->>'product_id' AND m->>'warehouse_id'=pr->>'warehouse_id' AND m->'quantity'=pr->'quantity') THEN RAISE EXCEPTION 'Ruch magazynowy nie odpowiada paczce' USING ERRCODE='23514';END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'product_id',m.product_id,'warehouse_id',m.warehouse_id,'location',m.location,'quantity',-m.delta) ORDER BY m.product_id,m.location COLLATE "C"),'[]') INTO actual FROM stock_location_movements m WHERE m.tenant_id=t AND m.order_id=a.order_id AND m.kind='shipment' AND m.id IN(SELECT(value->>'id')::uuid FROM jsonb_array_elements(receipt_data->'location_movements'));
 IF actual IS DISTINCT FROM receipt_data->'location_movements' OR jsonb_array_length(actual)<>(SELECT count(*) FROM jsonb_array_elements(a.payload->'parcel'->'products') p CROSS JOIN LATERAL jsonb_array_elements(p->'locations')) THEN RAISE EXCEPTION 'Brak pełnego wydania lokalizacji paczki' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(a.payload->'parcel'->'products') p CROSS JOIN LATERAL jsonb_array_elements(p->'locations') l WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(actual) m WHERE m->>'product_id'=p->>'product_id' AND m->>'location'=l->>'location' AND m->'quantity'=l->'quantity')) THEN RAISE EXCEPTION 'Ruch lokalizacji nie odpowiada paczce' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(a.before_snapshot->'holds')>0 THEN
  IF receipt_data->'wms'->>'operation_id' IS DISTINCT FROM a.operation_id::text OR NOT EXISTS(SELECT 1 FROM wms_operations WHERE tenant_id=t AND id=a.operation_id AND kind='dispatch' AND order_id=a.order_id) THEN RAISE EXCEPTION 'Brak operacji WMS paczki' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(f.id::text ORDER BY f.id),'[]') INTO actual FROM wms_issue_fragments f WHERE f.tenant_id=t AND f.operation_id=a.operation_id AND f.order_id=a.order_id;
  SELECT coalesce(jsonb_agg(value ORDER BY value#>>'{}'),'[]') INTO expected FROM jsonb_array_elements(receipt_data->'wms'->'fragment_ids');
  IF actual IS DISTINCT FROM expected OR jsonb_array_length(actual)<>(SELECT count(*) FROM jsonb_array_elements(a.payload->'parcel'->'products') p CROSS JOIN LATERAL jsonb_array_elements(p->'lot_holds')) OR(receipt_data->'wms'->>'physical_quantity')::bigint IS DISTINCT FROM(SELECT sum((p->>'quantity')::integer) FROM jsonb_array_elements(a.payload->'parcel'->'products') p) OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.payload->'parcel'->'products') p CROSS JOIN LATERAL jsonb_array_elements(p->'lot_holds') h LEFT JOIN LATERAL(SELECT sum(quantity) q FROM wms_issue_fragments WHERE tenant_id=t AND operation_id=a.operation_id AND product_id=(p->>'product_id')::uuid AND warehouse_id=(p->>'warehouse_id')::uuid AND layer_id=(h->>'layer_id')::uuid AND location=h->>'location') f ON true WHERE f.q IS DISTINCT FROM(h->>'quantity')::bigint) THEN RAISE EXCEPTION 'Fragmenty WMS nie pokrywają paczki' USING ERRCODE='23514';END IF;
 ELSE IF receipt_data->'wms' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Tryb OFF nie tworzy WMS' USING ERRCODE='23514';END IF;END IF;
END $$;
CREATE FUNCTION order_parcel_finish_dispatch(eid uuid,r jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;a order_parcel_admissions;after_data jsonb;BEGIN
 SELECT * INTO a FROM order_parcel_admissions WHERE tenant_id=t AND transaction_id=pg_current_xact_id() AND operation_id=eid AND kind='dispatch';
 IF a.operation_id IS NULL OR(a.actor_id,a.api_key_id) IS DISTINCT FROM(uid,kid) THEN RAISE EXCEPTION 'Brak bieżącej zgody wydania paczki' USING ERRCODE='23514';END IF;
 PERFORM order_parcel_require(uid,kid,true,false);after_data:=order_parcel_snapshot(a.order_id);
 INSERT INTO order_parcel_dispatches(id,tenant_id,plan_id,order_id,parcel_index,shipment_id,actor_id,api_key_id,client_key,request_hash,scope_hash,request,receipt,before_snapshot,after_snapshot) VALUES(eid,t,a.plan_id,a.order_id,a.parcel_index,(a.payload->'parcel'->>'shipment_id')::uuid,uid,kid,(a.payload->'request'->>'client_key')::uuid,a.payload->>'request_hash',a.scope_hash,a.payload->'request',r,a.before_snapshot,after_data);
 UPDATE shipments SET dispatched_at=clock_timestamp() WHERE tenant_id=t AND id=(a.payload->'parcel'->>'shipment_id')::uuid AND dispatched_at IS NULL;IF NOT FOUND THEN RAISE EXCEPTION 'Paczka została już wydana' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM order_parcel_allocations l WHERE l.tenant_id=t AND l.plan_id=a.plan_id AND NOT EXISTS(SELECT 1 FROM order_parcel_dispatches d WHERE(d.tenant_id,d.plan_id,d.parcel_index)=(l.tenant_id,l.plan_id,l.index))) THEN UPDATE orders SET status='shipped',updated_at=now() WHERE tenant_id=t AND id=a.order_id AND status='packed';END IF;
 PERFORM order_parcel_budget();RETURN eid;
END $$;
CREATE FUNCTION order_parcel_require(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g jsonb;BEGIN
 IF order_parcel_guards() IS NOT TRUE THEN RAISE EXCEPTION 'Moduł paczek jest niekompletny' USING ERRCODE='55000';END IF;
 g:=order_parcel_access(uid,kid,writing,pin);
 IF(g->>'key_valid')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'Klucz paczek jest nieaktualny' USING ERRCODE='23514';END IF;
 IF(g->>'allowed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'Brak aktualnego uprawnienia do paczek' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION order_parcel_lock(oid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('order.parcels.quota:'||t::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('order.parcels:'||t::text||':'||oid::text,0));
 PERFORM id FROM orders WHERE tenant_id=t AND id=oid FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Nie znaleziono zamówienia' USING ERRCODE='P0002';END IF;
 PERFORM id FROM shipments WHERE tenant_id=t AND order_id=oid ORDER BY id FOR UPDATE;
 PERFORM product_id FROM stock WHERE tenant_id=t AND(warehouse_id,product_id) IN(SELECT warehouse_id,product_id FROM reservations WHERE tenant_id=t AND order_id=oid) ORDER BY warehouse_id,product_id FOR UPDATE;
 PERFORM product_id FROM reservations WHERE tenant_id=t AND order_id=oid ORDER BY product_id FOR UPDATE;
 PERFORM product_id FROM reservation_locations WHERE tenant_id=t AND order_id=oid ORDER BY product_id,location FOR UPDATE;
 PERFORM layer_id FROM wms_reservation_layers WHERE tenant_id=t AND order_id=oid ORDER BY product_id,layer_id,location FOR UPDATE;
END $$;
CREATE FUNCTION order_parcel_snapshot(oid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object(
 'reservations',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY product_id) FROM reservations r WHERE r.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND order_id=oid),'[]'::jsonb),
 'locations',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY product_id,location) FROM reservation_locations r WHERE r.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND order_id=oid),'[]'::jsonb),
 'holds',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY product_id,layer_id,location) FROM wms_reservation_layers r WHERE r.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND order_id=oid),'[]'::jsonb),
 'stock',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.product_id) FROM stock s JOIN reservations r USING(tenant_id,warehouse_id,product_id) WHERE r.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND r.order_id=oid),'[]'::jsonb),
 'bins',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.product_id,s.location) FROM stock_locations s JOIN reservation_locations r USING(tenant_id,warehouse_id,product_id,location) WHERE r.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND r.order_id=oid),'[]'::jsonb),
 'positions',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.product_id,s.layer_id,s.location) FROM wms_layer_positions s JOIN wms_reservation_layers r USING(tenant_id,warehouse_id,product_id,location,layer_id) WHERE r.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND r.order_id=oid),'[]'::jsonb))
$$;
CREATE FUNCTION order_parcel_source(oid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;o orders;due bigint;enabled boolean;why text;BEGIN
 SELECT * INTO o FROM orders WHERE tenant_id=t AND id=oid;IF o.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono zamówienia' USING ERRCODE='P0002';END IF;
 SELECT greatest(0,greatest(0,o.total-coalesce((SELECT sum(refund_amount) FROM return_cases WHERE tenant_id=t AND order_id=oid AND state IN('refund_pending','closed')),0))-coalesce(sum(p.amount) FILTER(WHERE coalesce(q.kind,p.kind) IN('receipt','courier_collection')),0)+coalesce(sum(p.amount) FILTER(WHERE coalesce(q.kind,p.kind)='refund'),0)) INTO due FROM payment_entries p LEFT JOIN payment_entries q ON(q.tenant_id,q.order_id,q.id)=(p.tenant_id,p.order_id,p.reversal_of) WHERE p.tenant_id=t AND p.order_id=oid;
 enabled:=EXISTS(SELECT 1 FROM wms_policies policy WHERE policy.tenant_id=t AND policy.enabled);
 IF o.status<>'packed' THEN why:='ORDER_NOT_PACKED';
 ELSIF EXISTS(SELECT 1 FROM order_parcel_plans WHERE tenant_id=t AND order_id=oid) THEN why:='PLAN_EXISTS';
 ELSIF o.channel_id IS NOT NULL OR o.source NOT IN('manual','demo') OR EXISTS(SELECT 1 FROM order_merge_claims WHERE tenant_id=t AND(source_order_id=oid OR target_order_id=oid)) THEN why:='EXTERNAL_OR_MERGED_ORDER';
 ELSIF EXISTS(SELECT 1 FROM b2b_external_order_intents WHERE tenant_id=t AND order_id=oid) OR EXISTS(SELECT 1 FROM b2b_dropship_lines WHERE tenant_id=t AND customer_order_id=oid) THEN why:='B2B_PARTNER_FULFILLMENT';
 ELSIF EXISTS(SELECT 1 FROM shipping_plans WHERE tenant_id=t AND order_id=oid AND state NOT IN('preview','cancelled')) OR EXISTS(SELECT 1 FROM shipments WHERE tenant_id=t AND order_id=oid AND dispatched_at IS NOT NULL) THEN why:='SHIPPING_ALREADY_STARTED';
 ELSIF NOT EXISTS(SELECT 1 FROM reservations WHERE tenant_id=t AND order_id=oid AND state='active') OR EXISTS(SELECT 1 FROM reservations WHERE tenant_id=t AND order_id=oid AND(state<>'active' OR consumed_quantity<>0)) THEN why:='RESERVATIONS_NOT_PRISTINE';
 ELSIF EXISTS(SELECT 1 FROM reservation_locations WHERE tenant_id=t AND order_id=oid AND(scanned<>quantity OR consumed_quantity<>0)) THEN why:='SCANS_INCOMPLETE';
 ELSIF o.payment_mode<>'cod' AND due<>0 THEN why:='PREPAYMENT_INCOMPLETE';END IF;
 IF EXISTS(SELECT 1 FROM payment_entries WHERE tenant_id=t AND order_id=oid AND currency<>o.currency) THEN why:='PAYMENT_CURRENCY_MISMATCH';END IF;
 RETURN jsonb_build_object('order',jsonb_build_object('id',o.id,'number',o.number,'version',o.version::text,'status',o.status,'warehouse_id',o.warehouse_id,'payment_mode',o.payment_mode,'currency',o.currency),
 'receiver',jsonb_build_object('name',o.customer_name,'email',o.email,'address',o.address),
 'products',coalesce((SELECT jsonb_agg(jsonb_build_object('product_id',r.product_id,'sku',p.sku,'name',p.name,'quantity',r.quantity,'consumed_quantity',r.consumed_quantity,'remaining',r.quantity-r.consumed_quantity,'scanned',(SELECT coalesce(sum(scanned),0) FROM reservation_locations WHERE tenant_id=t AND order_id=oid AND product_id=r.product_id),'locations',coalesce((SELECT jsonb_agg(jsonb_build_object('location',l.location,'quantity',l.quantity,'scanned',l.scanned,'consumed_quantity',l.consumed_quantity) ORDER BY l.location) FROM reservation_locations l WHERE tenant_id=t AND order_id=oid AND product_id=r.product_id),'[]'::jsonb),'layers',coalesce((SELECT jsonb_agg(jsonb_build_object('layer_id',h.layer_id,'location',h.location,'quantity',h.quantity,'scanned',h.scanned,'consumed_quantity',h.consumed_quantity) ORDER BY h.layer_id,h.location) FROM wms_reservation_layers h WHERE tenant_id=t AND order_id=oid AND product_id=r.product_id),'[]'::jsonb)) ORDER BY r.product_id) FROM reservations r JOIN products p ON(p.tenant_id,p.id)=(r.tenant_id,r.product_id) WHERE r.tenant_id=t AND r.order_id=oid),'[]'::jsonb),
 'shipments',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'carrier',s.carrier,'mode',s.mode,'tracking_number',s.tracking_number,'cod_expected',s.cod_expected,'dispatched_at',s.dispatched_at) ORDER BY s.id) FROM shipments s WHERE tenant_id=t AND order_id=oid),'[]'::jsonb),'cod_due',CASE WHEN o.payment_mode='cod' THEN due ELSE 0 END,
 'payment_due',due,'active_plan_id',(SELECT id FROM order_parcel_plans WHERE tenant_id=t AND order_id=oid),'wms_enabled',enabled,'can_preview',why IS NULL,'unavailable_reason',why);
END $$;

CREATE FUNCTION order_parcel_frame(pid uuid,oid uuid,b jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;s jsonb;d jsonb;pr jsonb;pp jsonb;allparcels jsonb:='[]';alloc jsonb;locations jsonb;holds jsonb;remaining integer;take integer;used integer;idx integer:=0;sid uuid;sh shipments;r record;lr record;cod bigint:=0;pc integer:=0;qty bigint:=0;
BEGIN
 PERFORM order_parcel_require(uid,kid,true,false);PERFORM order_parcel_lock(oid);s:=order_parcel_source(oid);
 IF(s->>'can_preview')::boolean IS NOT TRUE OR s->'order'->>'version' IS DISTINCT FROM b->>'order_version' OR jsonb_typeof(b->'parcels') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'parcels') NOT BETWEEN 2 AND 50 THEN RAISE EXCEPTION 'Zamówienie lub zakres paczek jest nieaktualny' USING ERRCODE='23514';END IF;
 FOR d IN SELECT value FROM jsonb_array_elements(b->'parcels') LOOP
  IF (jsonb_typeof(d->'products')='array' AND jsonb_array_length(d->'products') BETWEEN 1 AND 500 AND jsonb_typeof(d->'cod_minor')='number' AND (d->>'cod_minor')~'^(0|[1-9][0-9]{0,9})$' AND (d->>'cod_minor')::bigint<=2147483647 AND d->>'source_kind' IN('demo','existing')) IS NOT TRUE THEN RAISE EXCEPTION 'Niepoprawny przydział paczki' USING ERRCODE='23514';END IF;
  IF d->>'source_kind'='demo' THEN
   IF d?'shipment_id' THEN RAISE EXCEPTION 'DEMO nie przyjmuje obcego identyfikatora' USING ERRCODE='23514';END IF;
   sid:=order_parcel_identity(pid,idx);sh:=NULL;sh.carrier:='Symulator lokalny';sh.mode:='demo';sh.tracking_number:='DEMO-PARCEL-'||upper(sid::text);
  ELSE
   sid:=(d->>'shipment_id')::uuid;SELECT * INTO sh FROM shipments WHERE tenant_id=t AND order_id=oid AND id=sid;
   IF sh.id IS NULL OR sh.dispatched_at IS NOT NULL OR sh.cod_expected IS DISTINCT FROM (d->>'cod_minor')::integer OR sh.channel_id IS NOT NULL OR sh.mode<>'demo' THEN RAISE EXCEPTION 'Istniejąca paczka nie jest gotowym lokalnym źródłem' USING ERRCODE='23514';END IF;
  END IF;
  alloc:='[]';
  FOR pr IN SELECT value FROM jsonb_array_elements(d->'products') ORDER BY value->>'product_id' LOOP
   IF (jsonb_typeof(pr->'quantity')='number' AND (pr->>'quantity')~'^[1-9][0-9]{0,6}$' AND (pr->>'quantity')::bigint<=1000000 AND nullif(pr->>'product_id','') IS NOT NULL) IS NOT TRUE THEN RAISE EXCEPTION 'Niepoprawna ilość paczki' USING ERRCODE='23514';END IF;
   SELECT * INTO r FROM reservations WHERE tenant_id=t AND order_id=oid AND product_id=(pr->>'product_id')::uuid AND state='active';
   IF r.product_id IS NULL THEN RAISE EXCEPTION 'Paczka wskazuje produkt spoza rezerwacji' USING ERRCODE='23514';END IF;
   remaining:=(pr->>'quantity')::integer;locations:='[]';holds:='[]';
   FOR lr IN SELECT * FROM reservation_locations WHERE tenant_id=t AND order_id=oid AND product_id=r.product_id ORDER BY location LOOP
    SELECT coalesce(sum((l->>'quantity')::integer),0) INTO used FROM jsonb_array_elements(allparcels) x CROSS JOIN LATERAL jsonb_array_elements(x->'products') p CROSS JOIN LATERAL jsonb_array_elements(p->'locations') l WHERE p->>'product_id'=r.product_id::text AND l->>'location'=lr.location;
    take:=least(remaining,lr.quantity-used);IF take>0 THEN locations:=locations||jsonb_build_array(jsonb_build_object('location',lr.location,'quantity',take));remaining:=remaining-take;END IF;
   END LOOP;
   IF remaining<>0 THEN RAISE EXCEPTION 'Ilość paczek przekracza kompletację' USING ERRCODE='23514';END IF;
   IF(s->>'wms_enabled')::boolean THEN
    FOR pp IN SELECT value FROM jsonb_array_elements(locations) LOOP
     remaining:=(pp->>'quantity')::integer;
     FOR lr IN SELECT * FROM wms_reservation_layers WHERE tenant_id=t AND order_id=oid AND product_id=r.product_id AND location=pp->>'location' ORDER BY layer_id LOOP
      IF lr.state<>'active' OR lr.scanned<>lr.quantity OR lr.consumed_quantity<>0 THEN RAISE EXCEPTION 'Brak kompletnych skanów warstw paczki' USING ERRCODE='23514';END IF;
      SELECT coalesce(sum((l->>'quantity')::integer),0) INTO used FROM jsonb_array_elements(allparcels) x CROSS JOIN LATERAL jsonb_array_elements(x->'products') p CROSS JOIN LATERAL jsonb_array_elements(p->'lot_holds') l WHERE p->>'product_id'=r.product_id::text AND l->>'location'=lr.location AND l->>'layer_id'=lr.layer_id::text;
      take:=least(remaining,lr.quantity-used);IF take>0 THEN holds:=holds||jsonb_build_array(jsonb_build_object('location',lr.location,'layer_id',lr.layer_id,'quantity',take));remaining:=remaining-take;END IF;
     END LOOP;
     IF remaining<>0 THEN RAISE EXCEPTION 'Warstwy nie pokrywają paczki' USING ERRCODE='23514';END IF;
    END LOOP;
   END IF;
   alloc:=alloc||jsonb_build_array(jsonb_build_object('product_id',r.product_id,'warehouse_id',r.warehouse_id,'quantity',(pr->>'quantity')::integer,'locations',locations,'lot_holds',holds));pc:=pc+1;qty:=qty+(pr->>'quantity')::integer;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(alloc) a GROUP BY a->>'product_id' HAVING count(*)>1) THEN RAISE EXCEPTION 'Powtórzony produkt paczki' USING ERRCODE='23514';END IF;
  allparcels:=allparcels||jsonb_build_array(jsonb_build_object('index',idx,'source_kind',d->>'source_kind','shipment_id',sid,'carrier',sh.carrier,'mode',sh.mode,'tracking_number',sh.tracking_number,'cod_minor',(d->>'cod_minor')::integer,'products',alloc));cod:=cod+(d->>'cod_minor')::integer;idx:=idx+1;
 END LOOP;
 IF pc>500 OR cod IS DISTINCT FROM (s->>'cod_due')::bigint OR EXISTS(SELECT 1 FROM jsonb_array_elements(allparcels) x GROUP BY x->>'shipment_id' HAVING count(*)>1) OR EXISTS(SELECT 1 FROM reservations rr LEFT JOIN LATERAL(SELECT sum((p->>'quantity')::bigint) q FROM jsonb_array_elements(allparcels) x CROSS JOIN LATERAL jsonb_array_elements(x->'products') p WHERE p->>'product_id'=rr.product_id::text) n ON true WHERE rr.tenant_id=t AND rr.order_id=oid AND n.q IS DISTINCT FROM rr.quantity::bigint) THEN RAISE EXCEPTION 'Przydział nie pokrywa dokładnie rezerwacji i pobrania' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM shipments ss WHERE ss.tenant_id=t AND ss.order_id=oid AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(allparcels) x WHERE x->>'shipment_id'=ss.id::text)) THEN RAISE EXCEPTION 'Wszystkie istniejące źródła muszą należeć do planu' USING ERRCODE='23514';END IF;
 PERFORM order_parcel_require(uid,kid,true,false);
 RETURN jsonb_build_object('source',s,'parcels',allparcels,'summary',jsonb_build_object('parcels',idx,'products',pc,'physical_quantity',qty,'cod_minor',cod),'snapshot',order_parcel_snapshot(oid));
END $$;

CREATE FUNCTION order_parcel_witness() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a order_parcel_admissions;oid uuid;BEGIN
 IF TG_TABLE_NAME IN('stock_movements','stock_location_movements') THEN IF NEW.kind<>'shipment' THEN RETURN NEW;END IF;END IF;
 oid:=NEW.order_id;IF oid IS NULL OR NOT EXISTS(SELECT 1 FROM order_parcel_plans WHERE tenant_id=NEW.tenant_id AND order_id=oid) THEN RETURN NEW;END IF;
 SELECT * INTO a FROM order_parcel_admissions WHERE tenant_id=NEW.tenant_id AND transaction_id=pg_current_xact_id() AND order_id=oid AND kind='dispatch' AND NOT EXISTS(SELECT 1 FROM order_parcel_dispatches d WHERE d.tenant_id=NEW.tenant_id AND d.id=operation_id);
 IF a.operation_id IS NULL THEN RAISE EXCEPTION 'Wydanie planowanej paczki wymaga bieżącej zgody' USING ERRCODE='23514';END IF;
 UPDATE order_parcel_admissions SET payload=jsonb_set(payload,ARRAY['witnesses'],coalesce(payload->'witnesses','[]')||jsonb_build_array(jsonb_build_object('table',TG_TABLE_NAME,'id',NEW.id))) WHERE tenant_id=a.tenant_id AND transaction_id=a.transaction_id AND operation_id=a.operation_id;
 RETURN NEW;
END $$;
CREATE TRIGGER order_parcel_witness AFTER INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION order_parcel_witness();
CREATE TRIGGER order_parcel_witness AFTER INSERT ON stock_location_movements FOR EACH ROW EXECUTE FUNCTION order_parcel_witness();
CREATE TRIGGER order_parcel_witness AFTER INSERT ON wms_issue_fragments FOR EACH ROW EXECUTE FUNCTION order_parcel_witness();

CREATE FUNCTION order_parcel_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a order_parcel_admissions;p order_parcel_previews;pl order_parcel_plans;f jsonb;BEGIN
 IF TG_OP='INSERT' THEN PERFORM pg_advisory_xact_lock(hashtextextended('order.parcels.quota:'||NEW.tenant_id::text,0));END IF;
 IF TG_OP<>'INSERT' THEN
  IF TG_TABLE_NAME='order_parcel_admissions' AND TG_OP='UPDATE' AND pg_trigger_depth()>=2 AND OLD.kind='dispatch' AND OLD.transaction_id=pg_current_xact_id() AND NOT EXISTS(SELECT 1 FROM order_parcel_dispatches WHERE tenant_id=OLD.tenant_id AND id=OLD.operation_id) AND(to_jsonb(NEW)-'payload')=(to_jsonb(OLD)-'payload') AND(NEW.payload-'witnesses')=(OLD.payload-'witnesses') AND jsonb_array_length(NEW.payload->'witnesses')=coalesce(jsonb_array_length(OLD.payload->'witnesses'),0)+1 AND NEW.payload->'witnesses' @> coalesce(OLD.payload->'witnesses','[]') THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'Dowód przydziału paczek jest niezmienny' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='order_parcel_previews' THEN
  PERFORM order_parcel_require(NEW.actor_id,NEW.api_key_id,true,false);f:=order_parcel_frame(NEW.id,NEW.order_id,NEW.request,NEW.actor_id,NEW.api_key_id);
  IF NEW.payload IS DISTINCT FROM f OR NEW.scope_hash IS DISTINCT FROM order_parcel_hash(f) OR NEW.client_key IS DISTINCT FROM(NEW.request->>'client_key')::uuid OR NEW.request_hash IS DISTINCT FROM order_parcel_hash(jsonb_build_object('tenant_id',NEW.tenant_id,'actor_id',NEW.actor_id,'api_key_id',NEW.api_key_id,'kind','preview','order_id',NEW.order_id,'request',NEW.request)) THEN RAISE EXCEPTION 'Podgląd nie odpowiada źródłu paczek' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='order_parcel_admissions' THEN
  IF NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() OR NEW.opened_at>clock_timestamp() OR NEW.payload?'witnesses' THEN RAISE EXCEPTION 'Niepoprawna transakcja paczek' USING ERRCODE='23514';END IF;
  PERFORM order_parcel_require(NEW.actor_id,NEW.api_key_id,true,false);
  IF NEW.before_snapshot IS DISTINCT FROM order_parcel_snapshot(NEW.order_id) THEN RAISE EXCEPTION 'Zgoda wymaga rzeczywistych bieżących rezerwacji' USING ERRCODE='23514';END IF;
  IF NEW.kind='apply' THEN
   SELECT * INTO p FROM order_parcel_previews WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND actor_id=NEW.actor_id AND api_key_id IS NOT DISTINCT FROM NEW.api_key_id AND payload=NEW.payload AND scope_hash=NEW.scope_hash AND expires_at>clock_timestamp();
   IF p.id IS NULL OR NEW.operation_id IS DISTINCT FROM NEW.plan_id OR NEW.parcel_index IS NOT NULL OR NEW.payload IS DISTINCT FROM order_parcel_frame(p.id,p.order_id,p.request,NEW.actor_id,NEW.api_key_id) THEN RAISE EXCEPTION 'Zgoda planu wymaga pełnego aktualnego podglądu' USING ERRCODE='23514';END IF;
  ELSE
   SELECT * INTO pl FROM order_parcel_plans WHERE tenant_id=NEW.tenant_id AND id=NEW.plan_id AND order_id=NEW.order_id;
   IF pl.id IS NULL OR NEW.scope_hash IS DISTINCT FROM pl.scope_hash OR NEW.payload->'parcel' IS DISTINCT FROM pl.payload->'parcels'->NEW.parcel_index OR NEW.payload->'request'->>'scope_hash' IS DISTINCT FROM pl.scope_hash OR NEW.payload->'request'->'confirmed' IS DISTINCT FROM 'true'::jsonb OR NEW.payload->>'request_hash' IS DISTINCT FROM order_parcel_hash(jsonb_build_object('tenant_id',NEW.tenant_id,'actor_id',NEW.actor_id,'api_key_id',NEW.api_key_id,'kind','dispatch','plan_id',NEW.plan_id,'index',NEW.parcel_index,'request',NEW.payload->'request')) OR NOT EXISTS(SELECT 1 FROM orders WHERE tenant_id=NEW.tenant_id AND id=NEW.order_id AND status='packed') OR EXISTS(SELECT 1 FROM order_parcel_dispatches WHERE tenant_id=NEW.tenant_id AND plan_id=NEW.plan_id AND parcel_index=NEW.parcel_index) THEN RAISE EXCEPTION 'Zgoda wydania nie odpowiada istniejącej paczce planu' USING ERRCODE='23514';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='order_parcel_plans' THEN
  SELECT * INTO a FROM order_parcel_admissions WHERE tenant_id=NEW.tenant_id AND transaction_id=pg_current_xact_id() AND operation_id=NEW.id AND kind='apply';
  SELECT * INTO p FROM order_parcel_previews WHERE tenant_id=NEW.tenant_id AND id=NEW.preview_id;
  IF a.operation_id IS NULL OR p.id IS NULL OR(NEW.order_id,NEW.actor_id,NEW.api_key_id,NEW.scope_hash,NEW.payload) IS DISTINCT FROM(p.order_id,p.actor_id,p.api_key_id,p.scope_hash,p.payload) OR NEW.payload IS DISTINCT FROM a.payload OR NEW.request->>'scope_hash' IS DISTINCT FROM p.scope_hash OR NEW.request->'confirmed' IS DISTINCT FROM 'true'::jsonb OR NEW.client_key IS DISTINCT FROM(NEW.request->>'client_key')::uuid OR NEW.request_hash IS DISTINCT FROM order_parcel_hash(jsonb_build_object('tenant_id',NEW.tenant_id,'actor_id',NEW.actor_id,'api_key_id',NEW.api_key_id,'kind','apply','preview_id',NEW.preview_id,'request',NEW.request)) THEN RAISE EXCEPTION 'Plan nie odpowiada przyjętej zgodzie' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='order_parcel_allocations' THEN
  SELECT * INTO a FROM order_parcel_admissions WHERE tenant_id=NEW.tenant_id AND transaction_id=pg_current_xact_id() AND plan_id=NEW.plan_id AND kind='apply';
  IF a.operation_id IS NULL OR NEW.order_id IS DISTINCT FROM a.order_id OR NEW.payload IS DISTINCT FROM a.payload->'parcels'->NEW.index OR NEW.shipment_id IS DISTINCT FROM(NEW.payload->>'shipment_id')::uuid THEN RAISE EXCEPTION 'Paczka nie odpowiada planowi' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO a FROM order_parcel_admissions WHERE tenant_id=NEW.tenant_id AND transaction_id=pg_current_xact_id() AND operation_id=NEW.id AND kind='dispatch';
  IF a.operation_id IS NULL OR(NEW.plan_id,NEW.order_id,NEW.parcel_index,NEW.actor_id,NEW.api_key_id,NEW.scope_hash,NEW.request,NEW.before_snapshot) IS DISTINCT FROM(a.plan_id,a.order_id,a.parcel_index,a.actor_id,a.api_key_id,a.scope_hash,a.payload->'request',a.before_snapshot) OR NEW.after_snapshot IS DISTINCT FROM order_parcel_snapshot(a.order_id) OR NEW.request_hash IS DISTINCT FROM a.payload->>'request_hash' OR NEW.shipment_id IS DISTINCT FROM(a.payload->'parcel'->>'shipment_id')::uuid OR NEW.client_key IS DISTINCT FROM(NEW.request->>'client_key')::uuid THEN RAISE EXCEPTION 'Niepoprawny dowód wydania paczki' USING ERRCODE='23514';END IF;
  PERFORM order_parcel_validate_dispatch(a,NEW.after_snapshot,NEW.receipt);
  IF (SELECT coalesce(jsonb_agg(jsonb_build_object('table',facts.tab,'id',facts.id) ORDER BY facts.tab COLLATE "C",facts.id),'[]') FROM(SELECT 'stock_movements' tab,value->>'id' id FROM jsonb_array_elements(NEW.receipt->'stock_movements') UNION ALL SELECT 'stock_location_movements',value->>'id' FROM jsonb_array_elements(NEW.receipt->'location_movements') UNION ALL SELECT 'wms_issue_fragments',value#>>'{}' FROM jsonb_array_elements(coalesce(NEW.receipt->'wms'->'fragment_ids','[]'))) facts) IS DISTINCT FROM(SELECT coalesce(jsonb_agg(value ORDER BY value->>'table' COLLATE "C",value->>'id'),'[]') FROM jsonb_array_elements(a.payload->'witnesses')) THEN RAISE EXCEPTION 'Wydanie wymaga dokładnej bijekcji świeżych rzeczywistych ruchów' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['order_parcel_previews','order_parcel_plans','order_parcel_allocations','order_parcel_dispatches','order_parcel_admissions'] LOOP EXECUTE format('CREATE TRIGGER order_parcel_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION order_parcel_guard()',rel);END LOOP;END $$;

CREATE FUNCTION order_parcel_counter_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a order_parcel_admissions;p jsonb;part jsonb;delta integer:=0;hasplan boolean;BEGIN
 hasplan:=EXISTS(SELECT 1 FROM order_parcel_plans WHERE(tenant_id,order_id) IN((NEW.tenant_id,NEW.order_id),(OLD.tenant_id,OLD.order_id)));
 IF NOT hasplan THEN IF TG_OP='UPDATE' AND NEW.consumed_quantity IS DISTINCT FROM OLD.consumed_quantity OR TG_OP='INSERT' AND NEW.consumed_quantity<>0 THEN RAISE EXCEPTION 'Licznik wydania wymaga planu paczek' USING ERRCODE='23514';END IF;RETURN coalesce(NEW,OLD);END IF;
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Przydział rezerwacji planu jest trwały' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM order_parcel_admissions WHERE tenant_id=OLD.tenant_id AND transaction_id=pg_current_xact_id() AND order_id=OLD.order_id AND kind='dispatch' AND NOT EXISTS(SELECT 1 FROM order_parcel_dispatches d WHERE(d.tenant_id,d.id)=(OLD.tenant_id,operation_id));
 IF a.operation_id IS NULL THEN RAISE EXCEPTION 'Zmiana rezerwacji wymaga bieżącej zgody paczki' USING ERRCODE='23514';END IF;
 SELECT value INTO p FROM jsonb_array_elements(a.payload->'parcel'->'products') WHERE value->>'product_id'=OLD.product_id::text;
 IF TG_TABLE_NAME='reservations' THEN delta:=coalesce((p->>'quantity')::integer,0);
 ELSIF TG_TABLE_NAME='reservation_locations' THEN SELECT coalesce(sum((value->>'quantity')::integer),0) INTO delta FROM jsonb_array_elements(p->'locations') WHERE value->>'location'=OLD.location;
 ELSE SELECT coalesce(sum((value->>'quantity')::integer),0) INTO delta FROM jsonb_array_elements(p->'lot_holds') WHERE value->>'location'=OLD.location AND value->>'layer_id'=OLD.layer_id::text;END IF;
 IF delta<=0 OR NEW.consumed_quantity IS DISTINCT FROM OLD.consumed_quantity+delta OR NEW.consumed_quantity>NEW.quantity OR(to_jsonb(NEW)-ARRAY['consumed_quantity','state']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['consumed_quantity','state']) THEN RAISE EXCEPTION 'Licznik wydania nie odpowiada paczce' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME<>'reservation_locations' THEN
  IF NEW.state IS DISTINCT FROM (CASE WHEN NEW.consumed_quantity=NEW.quantity THEN 'consumed' ELSE 'active' END) THEN RAISE EXCEPTION 'Stan rezerwacji nie odpowiada pozostałej ilości' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['reservations','reservation_locations','wms_reservation_layers'] LOOP EXECUTE format('CREATE TRIGGER order_parcel_counter_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION order_parcel_counter_guard()',rel);END LOOP;END $$;

CREATE FUNCTION order_parcel_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=NEW.tenant_id;oid uuid:=NEW.order_id;p order_parcel_plans;d record;total integer;issued integer;BEGIN
 SELECT * INTO p FROM order_parcel_plans WHERE tenant_id=t AND order_id=oid;
 IF TG_TABLE_NAME='order_parcel_previews' THEN PERFORM order_parcel_require(NEW.actor_id,NEW.api_key_id,true,false);PERFORM order_parcel_budget();RETURN NULL;END IF;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Niekompletny plan paczek' USING ERRCODE='23514';END IF;
 total:=jsonb_array_length(p.payload->'parcels');
 IF(SELECT count(*) FROM order_parcel_allocations WHERE tenant_id=t AND plan_id=p.id)<>total OR EXISTS(SELECT 1 FROM order_parcel_allocations x JOIN shipments s ON(s.tenant_id,s.id,s.order_id)=(x.tenant_id,x.shipment_id,x.order_id) WHERE x.tenant_id=t AND x.plan_id=p.id AND(x.payload IS DISTINCT FROM p.payload->'parcels'->x.index OR(s.carrier,s.mode,s.tracking_number,s.cod_expected) IS DISTINCT FROM(x.payload->>'carrier',x.payload->>'mode',x.payload->>'tracking_number',(x.payload->>'cod_minor')::integer))) THEN RAISE EXCEPTION 'Graf przydziału paczek nie jest kompletny' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO issued FROM order_parcel_dispatches WHERE tenant_id=t AND plan_id=p.id;
 IF NOT EXISTS(SELECT 1 FROM orders WHERE tenant_id=t AND id=oid AND status=CASE WHEN issued=total THEN 'shipped' ELSE 'packed' END) OR EXISTS(SELECT 1 FROM order_parcel_allocations l JOIN shipments s ON(s.tenant_id,s.id)=(l.tenant_id,l.shipment_id) WHERE l.tenant_id=t AND l.plan_id=p.id AND(s.dispatched_at IS NOT NULL) IS DISTINCT FROM EXISTS(SELECT 1 FROM order_parcel_dispatches WHERE tenant_id=t AND plan_id=p.id AND parcel_index=l.index)) THEN RAISE EXCEPTION 'Stan zamówienia nie odpowiada wydanym paczkom' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM reservations r LEFT JOIN LATERAL(SELECT coalesce(sum((pr->>'quantity')::integer),0) q FROM order_parcel_dispatches dd JOIN order_parcel_allocations l ON(l.tenant_id,l.plan_id,l.index)=(dd.tenant_id,dd.plan_id,dd.parcel_index) CROSS JOIN LATERAL jsonb_array_elements(l.payload->'products') pr WHERE dd.tenant_id=t AND dd.plan_id=p.id AND pr->>'product_id'=r.product_id::text) sums ON true WHERE r.tenant_id=t AND r.order_id=oid AND(r.consumed_quantity<>sums.q OR r.state<>CASE WHEN r.quantity=sums.q THEN 'consumed' ELSE 'active' END)) THEN RAISE EXCEPTION 'Rezerwacja nie odpowiada sumie rzeczywistych wydań' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='order_parcel_admissions' AND NEW.kind='dispatch' AND NOT EXISTS(SELECT 1 FROM order_parcel_dispatches WHERE tenant_id=t AND id=NEW.operation_id) THEN RAISE EXCEPTION 'Zgoda wydania nie ma trwałego wyniku' USING ERRCODE='23514';END IF;
 PERFORM order_parcel_require(NEW.actor_id,NEW.api_key_id,true,false);PERFORM order_parcel_budget();RETURN NULL;
END $$;
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['order_parcel_previews','order_parcel_plans','order_parcel_dispatches','order_parcel_admissions'] LOOP EXECUTE format('CREATE CONSTRAINT TRIGGER order_parcel_complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_parcel_complete()',rel);END LOOP;END $$;

-- Preserve trigger OIDs and every standalone 133 branch; only typed parcel admissions relax cardinality.
CREATE OR REPLACE FUNCTION order_shipments_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE parent orders;
BEGIN
 IF TG_OP<>'DELETE' THEN
  IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM order_parcel_admissions a CROSS JOIN LATERAL jsonb_array_elements(a.payload->'parcels') x
   WHERE a.tenant_id=NEW.tenant_id AND a.transaction_id=pg_current_xact_id() AND a.kind='apply' AND a.order_id=NEW.order_id
    AND x->>'source_kind'='demo' AND x->>'shipment_id'=NEW.id::text AND NEW.carrier=x->>'carrier' AND NEW.tracking_number=x->>'tracking_number'
    AND NEW.mode='demo' AND NEW.channel_id IS NULL AND NEW.external_id IS NULL AND NEW.dispatched_at IS NULL AND NEW.cod_expected=(x->>'cod_minor')::integer)
   THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'dispatched_at')=(to_jsonb(OLD)-'dispatched_at') AND OLD.dispatched_at IS NULL AND NEW.dispatched_at IS NOT NULL
   AND EXISTS(SELECT 1 FROM order_parcel_admissions a JOIN order_parcel_dispatches d ON(d.tenant_id,d.id)=(a.tenant_id,a.operation_id)
    WHERE a.tenant_id=NEW.tenant_id AND a.transaction_id=pg_current_xact_id() AND a.kind='dispatch' AND a.order_id=NEW.order_id AND d.shipment_id=NEW.id)
   THEN RETURN NEW;END IF;
 END IF;
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Tożsamość przesyłki jest trwała' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.tenant_id,NEW.order_id,NEW.carrier,NEW.mode,NEW.channel_id,NEW.external_id,NEW.tracking_number,NEW.cod_expected)
   IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.order_id,OLD.carrier,OLD.mode,OLD.channel_id,OLD.external_id,OLD.tracking_number,OLD.cod_expected) THEN
   RAISE EXCEPTION 'Tożsamość i kwota pobrania przesyłki są trwałe' USING ERRCODE='23514';
  END IF;
  IF NEW.dispatched_at IS NOT DISTINCT FROM OLD.dispatched_at THEN RETURN NEW;END IF;
  IF OLD.dispatched_at IS NOT NULL OR NEW.dispatched_at IS NULL THEN
   RAISE EXCEPTION 'Potwierdzone wydanie przesyłki jest trwałe' USING ERRCODE='23514';
  END IF;
 END IF;
 -- INSERT and first dispatch serialize with the existing order-first issue flow.
 -- Tracking/status-only updates return above, without a reverse parent lock.
 SELECT * INTO parent FROM orders WHERE tenant_id=NEW.tenant_id AND id=NEW.order_id FOR UPDATE;
 IF parent.id IS NULL THEN RAISE EXCEPTION 'Przesyłka wymaga własnego zamówienia' USING ERRCODE='23503';END IF;
 IF TG_OP='INSERT' THEN
  IF nullif(btrim(NEW.carrier),'') IS NULL OR nullif(btrim(NEW.tracking_number),'') IS NULL THEN
   RAISE EXCEPTION 'Przesyłka wymaga jawnej tożsamości przewoźnika i trackingu' USING ERRCODE='23514';
  END IF;
  IF parent.status IN('shipped','delivered','completed','return_initiated','return_received','return_completed','cancelled')
   OR EXISTS(SELECT 1 FROM shipments WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND dispatched_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Nowa paczka po wydaniu wymaga osobnego procesu przydziału paczek' USING ERRCODE='23514';
  END IF;
  -- A committed in-flight whole-order plan fences unrelated parcel insertion
  -- while its provider request runs outside a transaction. Do not take the
  -- worker's session advisory lock here: it belongs to another connection.
  IF EXISTS(SELECT 1 FROM shipping_plans WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id
    AND state NOT IN('preview','cancelled','dispatched')) THEN
   IF NOT EXISTS(
    SELECT 1 FROM shipping_plans plan JOIN channels channel
      ON(channel.tenant_id,channel.id)=(plan.tenant_id,plan.channel_id)
    JOIN jobs task ON task.tenant_id=plan.tenant_id AND task.id=plan.job_id
    WHERE plan.tenant_id=NEW.tenant_id AND plan.order_id=NEW.order_id
      AND plan.shipment_id IS NULL AND plan.channel_id=NEW.channel_id
      AND NEW.dispatched_at IS NULL
      AND NEW.cod_expected IS NOT DISTINCT FROM coalesce((plan.input->>'cod')::integer,0)
      AND task.state='running' AND task.lease_token IS NOT NULL
      AND task.payload->>'plan_id'=plan.id::text
      AND task.payload->>'actor_id'=plan.actor_id::text
      AND task.payload->>'channel_id'=plan.channel_id::text
      AND (
       (channel.provider='inpost' AND coalesce(plan.input->>'provider','inpost')='inpost'
        AND NEW.carrier='InPost ShipX' AND plan.state='buy_queued'
        AND plan.phase IN('buy_started','confirmed') AND task.kind='shipping'
        AND task.payload->>'action'='buy'
        AND nullif(plan.remote_id,'') IS NOT NULL AND NEW.external_id IS NOT DISTINCT FROM plan.remote_id
        AND ((channel.settings->>'simulation'='true' AND NEW.mode='demo'
          AND plan.remote_id='DEMO-'||plan.id::text
          AND NEW.tracking_number='DEMO-'||left(plan.id::text,12))
         OR (coalesce(channel.settings->>'simulation','false')<>'true' AND NEW.mode=channel.mode)))
       OR
       (channel.provider='dpd' AND plan.input->>'provider'='dpd'
        AND NEW.carrier='DPD Polska' AND plan.state='queued' AND task.kind='shipping.dpd'
        AND ((channel.settings->>'simulation'='true' AND NEW.mode='demo'
          AND plan.phase='create_started' AND NEW.external_id IS NULL
          AND NEW.tracking_number='DEMO-DPD-'||left(plan.id::text,12))
         OR (coalesce(channel.settings->>'simulation','false')<>'true' AND NEW.mode=channel.mode
          AND plan.phase='numbers_ready' AND nullif(plan.remote_id,'') IS NOT NULL
          AND NEW.external_id IS NOT DISTINCT FROM plan.remote_id
          AND NEW.tracking_number IS NOT DISTINCT FROM plan.remote_id)))
      )
   ) THEN RAISE EXCEPTION 'Aktywny plan nadania blokuje inną paczkę' USING ERRCODE='23514';END IF;
   IF EXISTS(SELECT 1 FROM shipments WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id) THEN
    RAISE EXCEPTION 'Plan całego zamówienia nie może utworzyć dodatkowej paczki' USING ERRCODE='23514';
   END IF;
  END IF;
  IF NEW.dispatched_at IS NOT NULL AND EXISTS(SELECT 1 FROM shipments WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id) THEN
   RAISE EXCEPTION 'Wydanie wielu paczek wymaga jawnego przydziału pozycji' USING ERRCODE='23514';
  END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM shipments WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND id<>NEW.id) THEN
   RAISE EXCEPTION 'Wydanie wielu paczek wymaga jawnego przydziału pozycji' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION order_shipments_dispatch_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.status='shipped' AND NEW.status IS DISTINCT FROM OLD.status AND EXISTS(SELECT 1 FROM order_parcel_plans p WHERE p.tenant_id=NEW.tenant_id AND p.order_id=NEW.id) THEN
  IF NOT EXISTS(SELECT 1 FROM order_parcel_admissions a JOIN order_parcel_dispatches d ON(d.tenant_id,d.id)=(a.tenant_id,a.operation_id) WHERE a.tenant_id=NEW.tenant_id AND a.transaction_id=pg_current_xact_id() AND a.kind='dispatch' AND a.order_id=NEW.id)
   OR EXISTS(SELECT 1 FROM order_parcel_allocations l WHERE l.tenant_id=NEW.tenant_id AND l.order_id=NEW.id AND NOT EXISTS(SELECT 1 FROM order_parcel_dispatches d WHERE(d.tenant_id,d.plan_id,d.parcel_index)=(l.tenant_id,l.plan_id,l.index))) THEN RAISE EXCEPTION 'Wysłanie zamówienia wymaga kompletnych wydań paczek' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF NEW.status='shipped' AND NEW.status IS DISTINCT FROM OLD.status
  AND (SELECT count(*) FROM shipments WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id)>1 THEN
  RAISE EXCEPTION 'Wydanie wielu paczek wymaga jawnego przydziału pozycji' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

-- Retain all 093 OFF/ON checks, now using exact remaining active holds.
CREATE OR REPLACE FUNCTION wms_validate_quantity_scope(t uuid,w uuid,p uuid,policy_scope boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s record;stock_row record;held bigint;prior_scope text;
BEGIN
 prior_scope:=current_setting('app.tenant_id',true);

 -- Deferred events can originate in several authorized B2B tenants in one TX.
 -- Their INSERT/UPDATE has already passed RLS; never retain this event-local scope.
 PERFORM set_config('app.tenant_id',t::text,true);
 IF NOT policy_scope THEN
  SELECT * INTO s FROM stock WHERE (tenant_id,warehouse_id,product_id)=(t,w,p);
  IF FOUND THEN
 IF (SELECT coalesce(sum(quantity),0) FROM stock_locations WHERE (tenant_id,warehouse_id,product_id)=(t,w,p))<>s.on_hand THEN
  RAISE EXCEPTION 'Suma lokalizacji nie zgadza sie ze stanem magazynu' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(sum(a.quantity-a.consumed_quantity),0) INTO held FROM reservation_locations a JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id) WHERE (a.tenant_id,a.warehouse_id,a.product_id)=(t,w,p) AND r.state='active';
 IF held<>s.reserved OR EXISTS(
  SELECT 1 FROM reservations r LEFT JOIN reservation_locations a USING(tenant_id,order_id,product_id,warehouse_id) WHERE (r.tenant_id,r.warehouse_id,r.product_id)=(t,w,p) AND r.state='active' GROUP BY r.order_id,r.quantity,r.consumed_quantity HAVING coalesce(sum(a.quantity-a.consumed_quantity),0)<>r.quantity-r.consumed_quantity
 ) OR EXISTS(
  SELECT 1 FROM stock_locations l JOIN reservation_locations a USING(tenant_id,warehouse_id,product_id,location) JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id) WHERE (l.tenant_id,l.warehouse_id,l.product_id)=(t,w,p) AND r.state='active' GROUP BY l.location,l.quantity HAVING sum(a.quantity-a.consumed_quantity)>l.quantity
 ) OR EXISTS(
  SELECT 1 FROM reservations r JOIN order_pick_items i USING(tenant_id,order_id,product_id) LEFT JOIN reservation_locations a USING(tenant_id,order_id,product_id,warehouse_id) WHERE (r.tenant_id,r.warehouse_id,r.product_id)=(t,w,p) AND r.state='active' GROUP BY r.order_id,i.scanned,r.consumed_quantity HAVING coalesce(sum(a.scanned-a.consumed_quantity),0)<>i.scanned-r.consumed_quantity
 ) THEN RAISE EXCEPTION 'Rezerwacje lokalizacji nie zgadzaja sie ze stanem' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=t AND enabled) THEN
  PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN;END IF;
 IF policy_scope THEN
  IF EXISTS(SELECT 1 FROM reservations WHERE tenant_id=t AND state='active') OR
     EXISTS(SELECT 1 FROM stock WHERE tenant_id=t AND reserved<>0) OR
     EXISTS(SELECT 1 FROM picking_waves WHERE tenant_id=t AND state='picking') OR
     EXISTS(SELECT 1 FROM packing_sessions WHERE tenant_id=t AND state='active') OR
     EXISTS(SELECT 1 FROM wms_layer_positions WHERE tenant_id=t AND reserved<>0) OR
     EXISTS(SELECT 1 FROM wms_reservation_layers WHERE tenant_id=t AND state='active') OR
     EXISTS(SELECT 1 FROM wms_layer_positions l WHERE l.tenant_id=t AND l.quantity<>
      (SELECT coalesce(sum(delta),0) FROM wms_layer_movements m WHERE
       (m.tenant_id,m.warehouse_id,m.product_id,m.location,m.layer_id)=(l.tenant_id,l.warehouse_id,l.product_id,l.location,l.layer_id)))
  THEN RAISE EXCEPTION 'Otwarcie wymaga uzgodnionej księgi bez aktywnych rezerwacji i realizacji' USING ERRCODE='23514';END IF;
  FOR stock_row IN SELECT warehouse_id,product_id FROM stock WHERE tenant_id=t LOOP
   IF (SELECT on_hand FROM stock WHERE (tenant_id,warehouse_id,product_id)=(t,stock_row.warehouse_id,stock_row.product_id))<>
      (SELECT coalesce(sum(quantity),0) FROM wms_layer_positions WHERE (tenant_id,warehouse_id,product_id)=(t,stock_row.warehouse_id,stock_row.product_id)) OR
      EXISTS(SELECT 1 FROM stock_locations b WHERE (b.tenant_id,b.warehouse_id,b.product_id)=(t,stock_row.warehouse_id,stock_row.product_id)
    AND b.quantity<>(SELECT coalesce(sum(quantity),0) FROM wms_layer_positions l WHERE
     (l.tenant_id,l.warehouse_id,l.product_id,l.location)=(b.tenant_id,b.warehouse_id,b.product_id,b.location)))
   THEN RAISE EXCEPTION 'Otwarcie nie obejmuje całego stanu WMS' USING ERRCODE='23514';END IF;
  END LOOP;PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN;
 END IF;

 SELECT * INTO s FROM stock WHERE (tenant_id,warehouse_id,product_id)=(t,w,p);
 IF NOT FOUND THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN;END IF;
 IF s.on_hand<>(SELECT coalesce(sum(quantity),0) FROM wms_layer_positions WHERE (tenant_id,warehouse_id,product_id)=(t,w,p)) OR
 s.reserved<>(SELECT coalesce(sum(reserved),0) FROM wms_layer_positions WHERE (tenant_id,warehouse_id,product_id)=(t,w,p)) OR
 EXISTS(SELECT 1 FROM stock_locations b WHERE (b.tenant_id,b.warehouse_id,b.product_id)=(t,w,p) AND
  b.quantity<>(SELECT coalesce(sum(quantity),0) FROM wms_layer_positions l WHERE
   (l.tenant_id,l.warehouse_id,l.product_id,l.location)=(b.tenant_id,b.warehouse_id,b.product_id,b.location))) OR
 EXISTS(SELECT 1 FROM wms_layer_positions l WHERE (l.tenant_id,l.warehouse_id,l.product_id)=(t,w,p) AND
  (l.quantity<>(SELECT coalesce(sum(delta),0) FROM wms_layer_movements m WHERE
   (m.tenant_id,m.warehouse_id,m.product_id,m.location,m.layer_id)=(l.tenant_id,l.warehouse_id,l.product_id,l.location,l.layer_id)) OR
   l.reserved<>(SELECT coalesce(sum(quantity-consumed_quantity),0) FROM wms_reservation_layers a WHERE a.state='active' AND
   (a.tenant_id,a.warehouse_id,a.product_id,a.location,a.layer_id)=(l.tenant_id,l.warehouse_id,l.product_id,l.location,l.layer_id)))) OR
 EXISTS(SELECT 1 FROM reservation_locations b JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id)
  WHERE (b.tenant_id,b.warehouse_id,b.product_id)=(t,w,p) AND r.state='active' AND
  (((b.quantity-b.consumed_quantity)::bigint,(b.scanned-b.consumed_quantity)::bigint) IS DISTINCT FROM (SELECT ROW(coalesce(sum(a.quantity-a.consumed_quantity),0),coalesce(sum(a.scanned-a.consumed_quantity),0))
   FROM wms_reservation_layers a WHERE a.state='active' AND
   (a.tenant_id,a.order_id,a.product_id,a.warehouse_id,a.location)=(b.tenant_id,b.order_id,b.product_id,b.warehouse_id,b.location))))
 THEN RAISE EXCEPTION 'WMS nie zgadza się ze stanem, lokalizacjami, rezerwacją lub skanami' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;END $$;

CREATE FUNCTION order_parcel_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a order_parcel_admissions;before_row jsonb;after_row jsonb;BEGIN
 FOR a IN SELECT * FROM order_parcel_admissions WHERE transaction_id=pg_current_xact_id() AND tenant_id IN(coalesce(NEW.tenant_id,OLD.tenant_id),coalesce(OLD.tenant_id,NEW.tenant_id)) LOOP
  IF(TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.before_snapshot->'stock') x WHERE x->>'product_id'=OLD.product_id::text AND x->>'warehouse_id'=OLD.warehouse_id::text)) OR(TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.before_snapshot->'stock') x WHERE x->>'product_id'=NEW.product_id::text AND x->>'warehouse_id'=NEW.warehouse_id::text)) THEN
   IF a.kind='apply' OR EXISTS(SELECT 1 FROM order_parcel_dispatches WHERE tenant_id=a.tenant_id AND id=a.operation_id) THEN RAISE EXCEPTION 'Przyjęty dowód paczki zamraża bieżące fakty wydania' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;RETURN coalesce(NEW,OLD);
END $$;
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['stock','stock_locations','wms_layer_positions'] LOOP EXECUTE format('CREATE TRIGGER order_parcel_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION order_parcel_seal()',rel);END LOOP;END $$;

CREATE FUNCTION order_parcel_guards() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND order_shipments_guards() IS TRUE
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['reservations','reservation_locations','wms_reservation_layers']) rel WHERE NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(rel) AND attname='consumed_quantity' AND attnotnull AND atttypid='integer'::regtype AND NOT attisdropped))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_previews','order_parcel_plans','order_parcel_allocations','order_parcel_dispatches','order_parcel_admissions']) rel WHERE NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(rel) AND relrowsecurity AND relforcerowsecurity))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_hash(jsonb)','order_parcel_identity(uuid,integer)','order_parcel_installed()','order_parcel_access(uuid,uuid,boolean,boolean)','order_parcel_require(uuid,uuid,boolean,boolean)','order_parcel_lock(uuid)','order_parcel_snapshot(uuid)','order_parcel_source(uuid)','order_parcel_frame(uuid,uuid,jsonb,uuid,uuid)','order_parcel_budget()','order_parcel_store_preview(uuid,uuid,jsonb,uuid,uuid)','order_parcel_apply(uuid,uuid,jsonb,uuid,uuid)','order_parcel_prepare_dispatch(uuid,integer,uuid,jsonb,uuid,uuid)','order_parcel_dispatch_scope(uuid,integer,uuid,uuid,uuid)','order_parcel_validate_dispatch(order_parcel_admissions,jsonb,jsonb)','order_parcel_finish_dispatch(uuid,jsonb,uuid,uuid)','order_parcel_guard()','order_parcel_counter_guard()','order_parcel_witness()','order_parcel_complete()','order_parcel_seal()','wms_validate_quantity_scope(uuid,uuid,uuid,boolean)']) f WHERE to_regprocedure(f) IS NULL)
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_previews','order_parcel_plans','order_parcel_allocations','order_parcel_dispatches','order_parcel_admissions']) rel WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(rel) AND tgname='order_parcel_guard' AND tgfoid=to_regprocedure('order_parcel_guard()') AND tgenabled='O' AND NOT tgisinternal))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_previews','order_parcel_plans','order_parcel_dispatches','order_parcel_admissions']) rel WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(rel) AND tgname='order_parcel_complete' AND tgfoid=to_regprocedure('order_parcel_complete()') AND tgenabled='O' AND tgdeferrable AND tginitdeferred AND NOT tgisinternal))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['reservations','reservation_locations','wms_reservation_layers']) rel WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(rel) AND tgname='order_parcel_counter_guard' AND tgfoid=to_regprocedure('order_parcel_counter_guard()') AND tgenabled='O' AND NOT tgisinternal))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['stock_movements','stock_location_movements','wms_issue_fragments']) rel WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(rel) AND tgname='order_parcel_witness' AND tgfoid=to_regprocedure('order_parcel_witness()') AND tgenabled='O' AND NOT tgisinternal))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['stock','stock_locations','wms_layer_positions']) rel WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(rel) AND tgname='order_parcel_seal' AND tgfoid=to_regprocedure('order_parcel_seal()') AND tgenabled='O' AND NOT tgisinternal))
 AND to_regprocedure('order_parcel_bound_guard()') IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['orders','order_items','shipments']) rel WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(rel) AND tgname='order_parcel_bound_guard' AND tgfoid=to_regprocedure('order_parcel_bound_guard()') AND tgenabled='O' AND NOT tgisinternal))
 AND NOT EXISTS(SELECT 1 FROM(VALUES('order_parcel_plans','order_parcel_previews',ARRAY['tenant_id','preview_id','order_id']),('order_parcel_allocations','shipments',ARRAY['tenant_id','order_id','shipment_id']),('order_parcel_allocations','order_parcel_plans',ARRAY['tenant_id','plan_id','order_id']),('order_parcel_dispatches','order_parcel_allocations',ARRAY['tenant_id','plan_id','parcel_index','shipment_id']),('order_parcel_dispatches','order_parcel_plans',ARRAY['tenant_id','plan_id','order_id'])) required(rel,parent,cols) WHERE NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass(required.rel) AND c.confrelid=to_regclass(required.parent) AND c.contype='f' AND c.convalidated AND(SELECT array_agg(attname::text ORDER BY ord) FROM unnest(c.conkey) WITH ORDINALITY k(att,ord) JOIN pg_attribute aa ON aa.attrelid=c.conrelid AND aa.attnum=k.att)=required.cols))
 AND NOT has_table_privilege('dyna_app','order_parcel_admissions','SELECT')
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_previews','order_parcel_plans','order_parcel_allocations','order_parcel_dispatches','order_parcel_admissions']) rel WHERE has_table_privilege('dyna_app',rel,'INSERT') OR has_table_privilege('dyna_app',rel,'UPDATE') OR has_table_privilege('dyna_app',rel,'DELETE'))
$$;
CREATE FUNCTION order_parcel_bound_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p order_parcel_plans;oid uuid;t uuid;BEGIN
 IF TG_TABLE_NAME='orders' THEN oid:=coalesce(OLD.id,NEW.id);ELSE oid:=coalesce(OLD.order_id,NEW.order_id);END IF;t:=coalesce(OLD.tenant_id,NEW.tenant_id);
 SELECT * INTO p FROM order_parcel_plans WHERE tenant_id=t AND order_id=oid;IF p.id IS NULL THEN RETURN coalesce(NEW,OLD);END IF;
 IF TG_TABLE_NAME='order_items' THEN RAISE EXCEPTION 'Po przydziale paczek pozycje sprzedaży są trwałe' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='shipments' AND TG_OP IN('INSERT','DELETE') THEN RAISE EXCEPTION 'Plan paczek zawiera zamknięty zestaw źródeł przesyłek' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='orders' THEN
  IF TG_OP<>'UPDATE' OR(NEW.id,NEW.tenant_id,NEW.warehouse_id,NEW.total,NEW.shipping_cost,NEW.currency,NEW.payment_mode,NEW.customer_name,NEW.email,NEW.address,NEW.source,NEW.channel_id,NEW.external_id) IS DISTINCT FROM(OLD.id,OLD.tenant_id,OLD.warehouse_id,OLD.total,OLD.shipping_cost,OLD.currency,OLD.payment_mode,OLD.customer_name,OLD.email,OLD.address,OLD.source,OLD.channel_id,OLD.external_id) THEN RAISE EXCEPTION 'Przydział paczek zamraża odbiorcę i zamówienie' USING ERRCODE='23514';END IF;
  IF NEW.status<>'packed' AND EXISTS(SELECT 1 FROM order_parcel_allocations l WHERE l.tenant_id=t AND l.plan_id=p.id AND NOT EXISTS(SELECT 1 FROM order_parcel_dispatches d WHERE(d.tenant_id,d.plan_id,d.parcel_index)=(l.tenant_id,l.plan_id,l.index))) THEN RAISE EXCEPTION 'Częściowo wydany plan musi pozostać spakowany' USING ERRCODE='23514';END IF;
 END IF;RETURN coalesce(NEW,OLD);
END $$;
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['orders','order_items','shipments'] LOOP EXECUTE format('CREATE TRIGGER order_parcel_bound_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION order_parcel_bound_guard()',rel);END LOOP;END $$;
DO $$DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'order_parcel_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.sig);END LOOP;END $$;
GRANT EXECUTE ON FUNCTION order_parcel_installed(),order_parcel_guards(),order_parcel_access(uuid,uuid,boolean,boolean),order_parcel_source(uuid),order_parcel_store_preview(uuid,uuid,jsonb,uuid,uuid),order_parcel_apply(uuid,uuid,jsonb,uuid,uuid),order_parcel_prepare_dispatch(uuid,integer,uuid,jsonb,uuid,uuid),order_parcel_dispatch_scope(uuid,integer,uuid,uuid,uuid),order_parcel_finish_dispatch(uuid,jsonb,uuid,uuid) TO dyna_app;
