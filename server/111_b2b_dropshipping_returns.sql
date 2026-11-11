-- Explicit customer-to-supplier RMA. Existing history is never rewritten.
CREATE TABLE b2b_dropship_return_settings (
 tenant_id uuid NOT NULL,account_id uuid NOT NULL,version integer NOT NULL CHECK(version>=1),
 enabled boolean NOT NULL,warehouse_id uuid NOT NULL,return_address jsonb NOT NULL,
 PRIMARY KEY(tenant_id,account_id),FOREIGN KEY(tenant_id,account_id) REFERENCES b2b_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 CHECK(jsonb_typeof(return_address)='object')
);
CREATE TABLE b2b_dropship_return_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,return_id uuid NOT NULL,order_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id),api_key_id uuid,client_key uuid NOT NULL,
 request_hash text NOT NULL,request jsonb NOT NULL,snapshot jsonb NOT NULL,scope_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 byte_count bigint NOT NULL DEFAULT 0,UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK(request_hash~'^[a-f0-9]{64}$' AND scope_hash~'^[a-f0-9]{64}$'),
 CHECK(jsonb_typeof(snapshot)='object' AND jsonb_typeof(request)='object' AND expires_at>created_at)
);
CREATE TABLE b2b_dropship_return_cases (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,preview_id uuid NOT NULL,return_id uuid NOT NULL,
 order_id uuid NOT NULL,dropship_order_id uuid NOT NULL,link_id uuid NOT NULL,
 supplier_tenant_id uuid NOT NULL,supplier_order_id uuid NOT NULL,supplier_return_id uuid NOT NULL,
 snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count bigint NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,preview_id,dropship_order_id),UNIQUE(supplier_tenant_id,supplier_return_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES b2b_dropship_return_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,dropship_order_id,order_id) REFERENCES b2b_dropship_orders(tenant_id,id,customer_order_id),
 FOREIGN KEY(tenant_id,link_id) REFERENCES b2b_links(tenant_id,id),
 FOREIGN KEY(supplier_tenant_id,supplier_order_id,supplier_return_id) REFERENCES return_cases(tenant_id,order_id,id),
 CHECK(tenant_id<>supplier_tenant_id AND jsonb_typeof(snapshot)='object')
);
CREATE TABLE b2b_dropship_return_lines (
 tenant_id uuid NOT NULL,case_id uuid NOT NULL,index integer NOT NULL CHECK(index>=0 AND index<100),
 customer_item_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity>=1 AND quantity<=100000),
 row jsonb NOT NULL,byte_count bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,case_id,index),UNIQUE(tenant_id,case_id,customer_item_id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES b2b_dropship_return_cases(tenant_id,id),
 CHECK(jsonb_typeof(row)='object')
);
CREATE TABLE b2b_dropship_return_supplier_cases (
 tenant_id uuid NOT NULL,return_id uuid NOT NULL,case_id uuid NOT NULL,buyer_tenant_id uuid NOT NULL,
 snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,return_id),UNIQUE(tenant_id,case_id),
 FOREIGN KEY(tenant_id,return_id) REFERENCES return_cases(tenant_id,id),
 FOREIGN KEY(buyer_tenant_id,case_id) REFERENCES b2b_dropship_return_cases(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(tenant_id<>buyer_tenant_id AND jsonb_typeof(snapshot)='object')
);
CREATE TABLE b2b_dropship_return_actions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),api_key_id uuid,
 client_key uuid NOT NULL,kind text NOT NULL CHECK(kind IN('settings','submit','receive','reject','withdraw','reconcile')),
 case_id uuid,preview_id uuid,return_id uuid,request_hash text NOT NULL,request jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count bigint NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK(request_hash~'^[a-f0-9]{64}$' AND jsonb_typeof(request)='object' AND jsonb_typeof(result)='object')
);
CREATE TABLE b2b_dropship_return_proofs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,action_id uuid NOT NULL,actor_tenant_id uuid NOT NULL,
 actor_id uuid NOT NULL,api_key_id uuid,kind text NOT NULL CHECK(kind IN('receive','reject','withdraw','reconcile')),
 return_id uuid NOT NULL,case_id uuid,transaction_id xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,
 request jsonb NOT NULL,before_snapshot jsonb NOT NULL,after_snapshot jsonb,applied boolean NOT NULL DEFAULT false,
 UNIQUE(tenant_id,action_id),FOREIGN KEY(tenant_id,return_id) REFERENCES return_cases(tenant_id,id),
 FOREIGN KEY(actor_tenant_id,action_id) REFERENCES b2b_dropship_return_actions(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE b2b_dropship_return_created_cases (
 tenant_id uuid NOT NULL,return_id uuid NOT NULL,transaction_id xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,
 order_before jsonb NOT NULL,
 PRIMARY KEY(tenant_id,return_id)
);
CREATE FUNCTION b2b_dropship_return_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 RAISE EXCEPTION 'Dowód koordynowanego zwrotu jest niezmienny' USING ERRCODE='23514';END$$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['b2b_dropship_return_settings','b2b_dropship_return_previews','b2b_dropship_return_cases','b2b_dropship_return_lines','b2b_dropship_return_supplier_cases','b2b_dropship_return_actions','b2b_dropship_return_proofs','b2b_dropship_return_created_cases'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
 EXECUTE format('CREATE POLICY return_owner ON %I TO %I USING(true) WITH CHECK(true)',tab,current_user);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',tab);
 IF tab NOT IN('b2b_dropship_return_proofs','b2b_dropship_return_created_cases') THEN
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',tab);
 IF tab<>'b2b_dropship_return_settings' THEN
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION b2b_dropship_return_immutable()',tab);
 EXECUTE format('CREATE TRIGGER bytes BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION b2b_dropship_bytes()',tab);
 END IF;END IF;
 END LOOP;END$$;
GRANT UPDATE ON b2b_dropship_return_settings TO dyna_app;
CREATE INDEX b2b_dropship_return_case_customer ON b2b_dropship_return_cases(tenant_id,return_id,id);
CREATE INDEX b2b_dropship_return_action_case ON b2b_dropship_return_actions(case_id,kind,id);
CREATE INDEX b2b_dropship_return_preview_history ON b2b_dropship_return_previews(tenant_id,return_id,id);

CREATE FUNCTION b2b_dropship_return_pair(cid uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;h b2b_dropship_return_cases%ROWTYPE;BEGIN
 SELECT * INTO h FROM b2b_dropship_return_cases WHERE id=cid;
 IF t IS NULL OR h.id IS NULL OR (t=h.tenant_id OR EXISTS(SELECT 1 FROM b2b_dropship_return_supplier_cases s WHERE s.tenant_id=t AND s.case_id=h.id)) IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('buyer_tenant_id',h.tenant_id,'supplier_tenant_id',h.supplier_tenant_id);END$$;
CREATE FUNCTION b2b_dropship_return_acceptance(rid uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('kind','partner','accepted_at',a.created_at,'case_ids',a.result->'case_ids','action_id',a.id)
 FROM b2b_dropship_return_actions a JOIN b2b_dropship_return_proofs p ON(p.actor_tenant_id,p.action_id,p.return_id)=(a.tenant_id,a.id,a.return_id) AND p.kind='reconcile' AND p.applied AND p.after_snapshot IS NOT NULL WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 AND a.return_id=rid AND a.kind='reconcile' LIMIT 1
$$;
CREATE FUNCTION b2b_dropship_return_installed() RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT 1 FROM migrations WHERE name='111_b2b_dropshipping_returns')$$;
CREATE FUNCTION b2b_dropship_return_snapshot(rid uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('head',to_jsonb(r),'items',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.item_id) FROM return_items i WHERE (i.tenant_id,i.return_id)=(r.tenant_id,r.id)),'[]'::jsonb))
 FROM return_cases r WHERE r.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND r.id=rid
$$;
CREATE FUNCTION b2b_dropship_return_case_state(cid uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;h b2b_dropship_return_cases%ROWTYPE;r return_cases%ROWTYPE;n integer;rec timestamptz;BEGIN
 SELECT * INTO h FROM b2b_dropship_return_cases WHERE id=cid;
 IF b2b_dropship_return_pair(cid) IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO r FROM return_cases WHERE tenant_id=h.supplier_tenant_id AND id=h.supplier_return_id;
 SELECT count(*)::int INTO n FROM b2b_dropship_return_actions WHERE case_id=cid AND kind IN('receive','reject','withdraw');
 SELECT a.created_at INTO rec FROM b2b_dropship_return_actions a JOIN b2b_dropship_return_proofs p ON(p.actor_tenant_id,p.action_id,p.return_id)=(a.tenant_id,a.id,a.return_id) AND p.kind='reconcile' AND p.applied WHERE a.tenant_id=h.tenant_id AND a.return_id=h.return_id AND a.kind='reconcile';
 RETURN jsonb_build_object('version',n+1,'state',CASE WHEN r.state='cancelled' THEN 'withdrawn' WHEN r.state='rejected' THEN 'rejected' WHEN r.received_at IS NOT NULL THEN 'received' ELSE 'requested' END,
 'supplier_return_version',r.version,'received_at',r.received_at,'retail_reconciled_at',rec,
 'supplier_items',coalesce((SELECT jsonb_agg(jsonb_build_object('supplier_item_id',i.item_id,'sku',i.sku,'name',i.name,'requested',i.requested,'accepted',i.accepted,'restocked',i.restocked,'refund_minor',i.refund_amount::text) ORDER BY i.item_id) FROM return_items i WHERE (i.tenant_id,i.return_id)=(r.tenant_id,r.id)),'[]'::jsonb),
 'wholesale_refund_minor',r.refund_amount::text);END$$;

-- INSERT witnesses are captured by a private trigger, never by an app-provided xid.
CREATE FUNCTION b2b_dropship_return_created() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE before_order jsonb;BEGIN
 IF to_regclass('public.b2b_dropship_return_created_cases') IS NOT NULL THEN
 SELECT to_jsonb(o) INTO before_order FROM orders o WHERE(o.tenant_id,o.id)=(NEW.tenant_id,NEW.order_id) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Brak pierwotnego zamówienia zgłoszenia' USING ERRCODE='23514';END IF;
 INSERT INTO b2b_dropship_return_created_cases VALUES(NEW.tenant_id,NEW.id,pg_current_xact_id(),transaction_timestamp(),before_order);END IF;RETURN NEW;END$$;
CREATE FUNCTION b2b_dropship_return_created_cleanup() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 DELETE FROM b2b_dropship_return_created_cases WHERE tenant_id=NEW.tenant_id AND return_id=NEW.return_id;RETURN NULL;END$$;
CREATE TRIGGER b2b_dropship_return_created AFTER INSERT ON return_cases FOR EACH ROW EXECUTE FUNCTION b2b_dropship_return_created();
CREATE CONSTRAINT TRIGGER b2b_dropship_return_created_cleanup AFTER INSERT ON b2b_dropship_return_created_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_dropship_return_created_cleanup();

CREATE FUNCTION b2b_dropship_return_prepare(cid uuid,aid uuid,uid uuid,kid uuid,k text,body jsonb) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;h b2b_dropship_return_cases%ROWTYPE;rid uuid;subject uuid;p uuid:=gen_random_uuid();BEGIN
 SELECT * INTO h FROM b2b_dropship_return_cases WHERE id=cid;
 IF b2b_dropship_return_pair(cid) IS NULL OR k NOT IN('receive','reject','withdraw','reconcile') THEN RAISE EXCEPTION 'Niepowiązany zakres zwrotu' USING ERRCODE='23514';END IF;
 IF b2b_dropship_current_role(uid,false) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Brak aktualnej zgody administratora' USING ERRCODE='23514';END IF;
 IF kid IS NOT NULL THEN IF b2b_dropship_return_key_grant(uid,kid,true,false)='invalid' THEN RAISE EXCEPTION 'Klucz został cofnięty lub wygasł' USING ERRCODE='23514';ELSIF b2b_dropship_return_key_grant(uid,kid,true,false)<>'ok' THEN RAISE EXCEPTION 'Brak bieżących zakresów zwrotu' USING ERRCODE='23514';END IF;END IF;
 IF t IS NULL OR (k IN('receive','reject') AND t IS DISTINCT FROM h.supplier_tenant_id) OR (k IN('withdraw','reconcile') AND t IS DISTINCT FROM h.tenant_id) THEN RAISE EXCEPTION 'Niewłaściwa strona zwrotu' USING ERRCODE='23514';END IF;
 rid:=CASE WHEN k='reconcile' THEN h.return_id ELSE h.supplier_return_id END;
 subject:=CASE WHEN k='reconcile' THEN h.tenant_id ELSE h.supplier_tenant_id END;
 INSERT INTO b2b_dropship_return_proofs(id,tenant_id,action_id,actor_tenant_id,actor_id,api_key_id,kind,return_id,case_id,transaction_id,transaction_started_at,request,before_snapshot)
 SELECT p,subject,aid,t,uid,kid,k,rid,cid,pg_current_xact_id(),transaction_timestamp(),body,
 jsonb_build_object('head',to_jsonb(r),'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.item_id) FROM return_items i WHERE (i.tenant_id,i.return_id)=(r.tenant_id,r.id)),
 'positions',coalesce((SELECT jsonb_agg(to_jsonb(lp) ORDER BY lp.product_id,lp.location,lp.layer_id) FROM wms_layer_positions lp WHERE lp.tenant_id=subject AND lp.warehouse_id=r.warehouse_id AND lp.product_id IN(SELECT (comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(subject,rid))),'[]'::jsonb),
 'bins',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.product_id,b.location) FROM stock_locations b WHERE b.tenant_id=subject AND b.warehouse_id=r.warehouse_id AND b.product_id IN(SELECT (comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(subject,rid))),'[]'::jsonb),
 'movements',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM stock_movements m WHERE(m.tenant_id,m.return_id)=(subject,rid)),'[]'::jsonb),
 'stock',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.warehouse_id,s.product_id) FROM stock s WHERE s.tenant_id=subject AND s.warehouse_id=r.warehouse_id AND s.product_id IN(SELECT (comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE ri.tenant_id=subject AND ri.return_id=rid)),'[]'::jsonb))
 FROM return_cases r WHERE r.tenant_id=subject AND r.id=rid AND r.state='requested' AND r.received_at IS NULL AND r.receipt IS NULL
 AND ((k='reconcile' AND r.version=(body->>'version')::bigint) OR(k IN('receive','reject','withdraw') AND(body->>'version')::int=(b2b_dropship_return_case_state(cid)->>'version')::int AND(k='withdraw' OR r.version=(body->>'supplier_return_version')::bigint))) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Brakuje powiązanej sprawy' USING ERRCODE='23514';END IF;RETURN p;END$$;

CREATE FUNCTION b2b_dropship_return_write_allowed(rid uuid) RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT NOT(EXISTS(SELECT 1 FROM b2b_dropship_return_cases h WHERE h.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND h.return_id=rid)
 OR EXISTS(SELECT 1 FROM b2b_dropship_return_supplier_cases h WHERE h.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND h.return_id=rid))
 OR EXISTS(SELECT 1 FROM b2b_dropship_return_proofs p WHERE p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND p.return_id=rid AND p.transaction_id=pg_current_xact_id() AND p.transaction_started_at=transaction_timestamp() AND NOT p.applied)
$$;
CREATE FUNCTION b2b_dropship_return_rma_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE rid uuid;t uuid;BEGIN
 IF to_regclass('public.b2b_dropship_return_cases') IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END IF;
 rid:=(CASE WHEN TG_TABLE_NAME='return_cases' THEN to_jsonb(OLD)->>'id' WHEN TG_OP='INSERT' THEN to_jsonb(NEW)->>'return_id' ELSE to_jsonb(OLD)->>'return_id' END)::uuid;t:=CASE WHEN TG_OP='INSERT' THEN NEW.tenant_id ELSE OLD.tenant_id END;
 IF NOT EXISTS(SELECT 1 FROM b2b_dropship_return_cases c WHERE c.tenant_id=t AND c.return_id=rid) AND NOT EXISTS(SELECT 1 FROM b2b_dropship_return_supplier_cases c WHERE c.tenant_id=t AND c.return_id=rid) THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END IF;
 IF EXISTS(SELECT 1 FROM b2b_dropship_return_proofs p WHERE p.tenant_id=t AND p.return_id=rid AND p.transaction_id=pg_current_xact_id() AND p.transaction_started_at=transaction_timestamp() AND p.applied) THEN RAISE EXCEPTION 'Końcowy dowód zwrotu zamknął zapisy w tej transakcji' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='return_cases' AND TG_OP='UPDATE' THEN
 IF OLD.state='refund_pending' AND NEW.state='closed' AND NEW.settlement IS NOT NULL
 AND to_jsonb(NEW)-ARRAY['state','settlement','refunded_at','version','updated_at'] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['state','settlement','refunded_at','version','updated_at'] THEN RETURN NEW;END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM b2b_dropship_return_proofs p WHERE p.tenant_id=t AND p.return_id=rid AND p.transaction_id=pg_current_xact_id() AND p.transaction_started_at=transaction_timestamp() AND NOT p.applied) THEN
 RAISE EXCEPTION 'Powiązany zwrot wymaga koordynowanego przyjęcia lub decyzji' USING ERRCODE='23514';END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END$$;
CREATE TRIGGER b2b_dropship_return_rma_guard BEFORE UPDATE OR DELETE ON return_cases FOR EACH ROW EXECUTE FUNCTION b2b_dropship_return_rma_guard();
CREATE TRIGGER b2b_dropship_return_item_guard BEFORE INSERT OR UPDATE OR DELETE ON return_items FOR EACH ROW EXECUTE FUNCTION b2b_dropship_return_rma_guard();

REVOKE ALL ON FUNCTION b2b_dropship_return_pair(uuid),b2b_dropship_return_acceptance(uuid),b2b_dropship_return_installed(),b2b_dropship_return_snapshot(uuid),b2b_dropship_return_case_state(uuid),b2b_dropship_return_prepare(uuid,uuid,uuid,uuid,text,jsonb),b2b_dropship_return_write_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_dropship_return_pair(uuid),b2b_dropship_return_acceptance(uuid),b2b_dropship_return_installed(),b2b_dropship_return_snapshot(uuid),b2b_dropship_return_case_state(uuid),b2b_dropship_return_prepare(uuid,uuid,uuid,uuid,text,jsonb),b2b_dropship_return_write_allowed(uuid) TO dyna_app;

CREATE INDEX b2b_dropship_return_acceptance_index ON b2b_dropship_return_actions(tenant_id,return_id,kind);
CREATE FUNCTION b2b_dropship_return_key_grant(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE k api_keys%ROWTYPE;t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;BEGIN
 IF t IS NULL THEN RETURN 'invalid';END IF;
 IF pin THEN SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid FOR SHARE;
 ELSE SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid;END IF;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR (k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN RETURN 'invalid';END IF;
 IF NOT k.scopes @> ARRAY['orders:read','inventory:read']::text[] OR (writing AND NOT k.scopes @> ARRAY['orders:write','inventory:write','purchasing:write']::text[]) THEN RETURN 'insufficient';END IF;RETURN 'ok';END$$;
CREATE FUNCTION b2b_dropship_return_value_grant(uid uuid,kid uuid) RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM api_keys k WHERE k.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND k.id=kid AND k.user_id=uid AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp()) AND k.scopes @> ARRAY['purchasing:read']::text[])
$$;
-- All public case rows are derived by this definer; callers cannot invent either party or a price line.
REVOKE INSERT ON b2b_dropship_return_cases,b2b_dropship_return_lines,b2b_dropship_return_supplier_cases FROM dyna_app;
CREATE FUNCTION b2b_dropship_return_preview_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r return_cases%ROWTYPE;row_json jsonb;part jsonb;g jsonb;d b2b_dropship_orders%ROWTYPE;si order_items%ROWTYPE;ri return_items%ROWTYPE;actual jsonb;prior integer;used integer;n integer;commercial order_items%ROWTYPE;wholesale bigint;credit bigint;BEGIN
 SELECT * INTO r FROM return_cases WHERE tenant_id=NEW.tenant_id AND id=NEW.return_id FOR UPDATE;
 IF NOT FOUND OR r.order_id<>NEW.order_id OR r.state<>'requested' OR r.received_at IS NOT NULL OR r.receipt IS NOT NULL
 OR to_jsonb(r) IS DISTINCT FROM NEW.snapshot->'rma'->'head' OR to_jsonb(r)->'version' IS DISTINCT FROM NEW.request->'version'
 OR (SELECT to_jsonb(o) FROM orders o WHERE o.tenant_id=r.tenant_id AND o.id=r.order_id) IS DISTINCT FROM NEW.snapshot->'order'
 OR jsonb_array_length(NEW.snapshot->'rows') NOT BETWEEN 1 AND 100 OR jsonb_array_length(NEW.snapshot->'groups') NOT BETWEEN 1 AND 100
 OR b2b_dropship_current_role(NEW.actor_id,false) IS DISTINCT FROM 'admin'
 OR (NEW.api_key_id IS NOT NULL AND b2b_dropship_return_key_grant(NEW.actor_id,NEW.api_key_id,true,false) IS DISTINCT FROM 'ok')
 THEN RAISE EXCEPTION 'Nieautentyczny podgląd koordynowanego zwrotu' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(NEW.request->'supplier_shipping_refunds') IS DISTINCT FROM 'array'
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.request->'supplier_shipping_refunds') sr WHERE jsonb_typeof(sr) IS DISTINCT FROM 'object' OR NOT(sr ?& ARRAY['dropship_order_id','amount_minor']) OR jsonb_typeof(sr->'amount_minor') IS DISTINCT FROM 'number' OR (sr->>'amount_minor') !~ '^[0-9]+$' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.snapshot->'groups') grp WHERE grp->>'dropship_order_id'=sr->>'dropship_order_id'))
 OR (SELECT count(DISTINCT sr->>'dropship_order_id') FROM jsonb_array_elements(NEW.request->'supplier_shipping_refunds') sr)<>jsonb_array_length(NEW.request->'supplier_shipping_refunds')
 THEN RAISE EXCEPTION 'Nieprawidłowy zatwierdzony zakres dostawy hurtowej' USING ERRCODE='23514';END IF;
 FOR ri IN SELECT * FROM return_items WHERE tenant_id=r.tenant_id AND return_id=r.id LOOP
 SELECT coalesce(sum((v->>'quantity')::int),0)::int INTO n FROM jsonb_array_elements(NEW.snapshot->'rows') v WHERE v->>'customer_item_id'=ri.item_id::text;
 IF n<>ri.requested OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.snapshot->'rma'->'items') v WHERE v->'row'=to_jsonb(ri) AND v->'commercial'=(SELECT to_jsonb(oi) FROM order_items oi WHERE(oi.tenant_id,oi.id)=(ri.tenant_id,ri.item_id))) THEN RAISE EXCEPTION 'Podgląd nie pokrywa oryginalnego RMA' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR row_json IN SELECT value FROM jsonb_array_elements(NEW.snapshot->'rows') LOOP
 SELECT * INTO d FROM b2b_dropship_orders WHERE tenant_id=NEW.tenant_id AND id=(row_json->>'dropship_order_id')::uuid AND customer_order_id=NEW.order_id AND state='ordered';
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM b2b_dropship_lines l WHERE(l.tenant_id,l.order_id,l.customer_item_id)=(d.tenant_id,d.id,(row_json->>'customer_item_id')::uuid) AND l.quantity>=(row_json->>'quantity')::int) THEN RAISE EXCEPTION 'Obcy lub nadmierny zakres przekazania' USING ERRCODE='23514';END IF;
 SELECT * INTO ri FROM return_items WHERE tenant_id=NEW.tenant_id AND return_id=r.id AND item_id=(row_json->>'customer_item_id')::uuid;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.request->'items') req WHERE req->>'customer_item_id'=ri.item_id::text AND req->>'dropship_order_id'=d.id::text AND req->'quantity'=row_json->'quantity' AND (SELECT jsonb_agg(pp-ARRAY['product_id','sku','name','quantity_available','quantity_per_unit'] ORDER BY ord) FROM jsonb_array_elements(row_json->'physical_sources') WITH ORDINALITY x(pp,ord))=req->'physical_sources') THEN RAISE EXCEPTION 'Zakres podglądu odbiega od żądania' USING ERRCODE='23514';END IF;
 SELECT * INTO commercial FROM order_items WHERE(tenant_id,id)=(NEW.tenant_id,ri.item_id);
 SELECT coalesce(sum(li.accepted),0)::int INTO prior FROM return_items li JOIN return_cases rc ON(rc.tenant_id,rc.id)=(li.tenant_id,li.return_id) WHERE li.tenant_id=NEW.tenant_id AND li.order_id=r.order_id AND li.item_id=ri.item_id AND rc.state IN('refund_pending','closed');
 prior:=prior+coalesce((SELECT sum((prev->>'quantity')::int)::int FROM jsonb_array_elements(NEW.snapshot->'rows') prev WHERE prev->>'customer_item_id'=ri.item_id::text AND(prev->>'index')::int<(row_json->>'index')::int),0);
 credit:=floor(commercial.line_total::numeric*(prior+(row_json->>'quantity')::int)/commercial.quantity)-floor(commercial.line_total::numeric*prior/commercial.quantity);
 IF row_json->>'retail_refund_minor' IS DISTINCT FROM credit::text THEN RAISE EXCEPTION 'Nieprawidłowy historyczny kredyt detaliczny' USING ERRCODE='23514';END IF;
 IF NOT FOUND OR (row_json->>'quantity')::int<1 THEN RAISE EXCEPTION 'Obca pozycja detaliczna' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(l.quantity),0)::int INTO used FROM b2b_dropship_return_lines l JOIN b2b_dropship_return_cases h ON(h.tenant_id,h.id)=(l.tenant_id,l.case_id) WHERE h.dropship_order_id=d.id AND l.customer_item_id=ri.item_id AND (b2b_dropship_return_case_state(h.id)->>'state') IS DISTINCT FROM 'withdrawn' AND (b2b_dropship_return_case_state(h.id)->>'state') IS DISTINCT FROM 'rejected';
 IF used+(row_json->>'quantity')::int>(SELECT l.quantity FROM b2b_dropship_lines l WHERE(l.tenant_id,l.order_id,l.customer_item_id)=(d.tenant_id,d.id,ri.item_id)) THEN RAISE EXCEPTION 'Zużyty zakres przekazania' USING ERRCODE='23514';END IF;
 SELECT value INTO g FROM jsonb_array_elements(NEW.snapshot->'groups') WHERE value->>'dropship_order_id'=d.id::text;
 IF g IS NULL OR g->>'supplier_tenant_id'<>d.supplier_tenant_id::text OR g->>'supplier_order_id'<>d.supplier_order_id::text
 OR g->'settings' IS DISTINCT FROM (SELECT to_jsonb(s) FROM b2b_dropship_return_settings s JOIN b2b_links l ON(l.supplier_tenant_id,l.account_id)=(s.tenant_id,s.account_id) JOIN b2b_accounts ac ON(ac.tenant_id,ac.id)=(s.tenant_id,s.account_id) AND ac.active WHERE(l.tenant_id,l.id)=(d.tenant_id,d.link_id) AND s.enabled AND NOT l.paused)
 OR g->'supplier' IS DISTINCT FROM (SELECT to_jsonb(o) FROM orders o WHERE(o.tenant_id,o.id)=(d.supplier_tenant_id,d.supplier_order_id)) THEN RAISE EXCEPTION 'Nieautentyczna polityka lub kontrahent' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM orders o WHERE(o.tenant_id,o.id)=(d.supplier_tenant_id,d.supplier_order_id) FOR UPDATE;
 IF (g->>'wms_lots_enabled')::boolean IS DISTINCT FROM EXISTS(SELECT 1 FROM wms_policies wp WHERE wp.tenant_id=d.supplier_tenant_id AND wp.enabled)
 THEN RAISE EXCEPTION 'Podgląd nie odpowiada rzeczywistej polityce WMS dostawcy' USING ERRCODE='23514';END IF;
 IF (g->>'shipping_refund')::bigint IS DISTINCT FROM coalesce((SELECT (sr->>'amount_minor')::bigint FROM jsonb_array_elements(NEW.request->'supplier_shipping_refunds') sr WHERE sr->>'dropship_order_id'=d.id::text),0)
 OR (g->>'shipping_refund')::bigint<0
 OR (g->>'shipping_refund')::bigint>(SELECT o.shipping_cost-coalesce((SELECT sum(CASE WHEN rc.state='requested' THEN rc.requested_shipping WHEN rc.state IN('refund_pending','closed') THEN rc.refunded_shipping ELSE 0 END) FROM return_cases rc WHERE(rc.tenant_id,rc.order_id)=(o.tenant_id,o.id)),0) FROM orders o WHERE(o.tenant_id,o.id)=(d.supplier_tenant_id,d.supplier_order_id))
 THEN RAISE EXCEPTION 'Przekazanie przekracza bieżący koszt dostawy dostawcy' USING ERRCODE='23514';END IF;
 wholesale:=0;
 FOR part IN SELECT value FROM jsonb_array_elements(row_json->'physical_sources') LOOP
 SELECT * INTO si FROM order_items WHERE tenant_id=d.supplier_tenant_id AND order_id=d.supplier_order_id AND id=(part->>'supplier_item_id')::uuid;
 IF NOT FOUND OR si.product_id::text<>part->>'product_id' OR (part->>'quantity')::int<1
 OR NOT EXISTS(SELECT 1 FROM shopify_dispatch_evidence e JOIN shipments sh ON(sh.tenant_id,sh.id)=(e.tenant_id,e.shipment_id) JOIN b2b_dropship_supplier_orders b ON(b.tenant_id,b.order_id)=(e.tenant_id,e.order_id),LATERAL jsonb_array_elements(e.items) item WHERE e.tenant_id=d.supplier_tenant_id AND e.order_id=d.supplier_order_id AND e.shipment_id=(part->>'shipment_id')::uuid AND sh.dispatched_at IS NOT NULL AND e.receiver=b.receiver AND item->>'id'=si.id::text AND (item->>'quantity')::int>=(part->>'quantity')::int)
 THEN RAISE EXCEPTION 'Brak rzeczywistego wydania fizycznego' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM wms_policies wp WHERE wp.tenant_id=d.supplier_tenant_id AND wp.enabled) AND NOT(part ? 'issue_fragment_id') THEN RAISE EXCEPTION 'WMS wymaga fragmentu rzeczywistego wydania' USING ERRCODE='23514';END IF;
 IF part ? 'issue_fragment_id' AND NOT EXISTS(SELECT 1 FROM wms_issue_fragments f WHERE f.tenant_id=d.supplier_tenant_id AND f.order_id=d.supplier_order_id AND f.product_id=si.product_id AND f.id=(part->>'issue_fragment_id')::uuid AND f.quantity-coalesce((SELECT sum(x.quantity) FROM wms_return_fragments x WHERE(x.tenant_id,x.issue_fragment_id)=(f.tenant_id,f.id)),0)>=(part->>'quantity')::int) THEN RAISE EXCEPTION 'Obcy lub zużyty fragment kosztowy' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM b2b_dropship_quotes q,LATERAL jsonb_array_elements(q.snapshot->'mapping_snapshot') m WHERE(q.tenant_id,q.id)=(d.tenant_id,d.quote_id) AND m->>'customer_item_id'=ri.item_id::text AND m->'catalog_item'->>'source_product_id'=si.product_id::text AND (m->'labels'->>'quantity')::int=(part->>'quantity_per_unit')::int) THEN RAISE EXCEPTION 'Fragment nie odpowiada oryginalnej recepturze' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR part IN SELECT jsonb_build_object('item_id',pp->>'supplier_item_id','quantity',sum((pp->>'quantity')::int)) FROM jsonb_array_elements(row_json->'physical_sources') pp GROUP BY pp->>'supplier_item_id' LOOP
 SELECT * INTO si FROM order_items WHERE(tenant_id,id)=(d.supplier_tenant_id,(part->>'item_id')::uuid);
 SELECT coalesce(sum(li.accepted),0)::int INTO prior FROM return_items li JOIN return_cases rc ON(rc.tenant_id,rc.id)=(li.tenant_id,li.return_id) WHERE li.tenant_id=d.supplier_tenant_id AND li.order_id=d.supplier_order_id AND li.item_id=si.id AND rc.state IN('refund_pending','closed');
 prior:=prior+coalesce((SELECT sum((ps->>'quantity')::int)::int FROM jsonb_array_elements(NEW.snapshot->'rows') prev CROSS JOIN LATERAL jsonb_array_elements(prev->'physical_sources') ps WHERE prev->>'dropship_order_id'=d.id::text AND(prev->>'index')::int<(row_json->>'index')::int AND ps->>'supplier_item_id'=si.id::text),0);
 wholesale:=wholesale+floor(si.line_total::numeric*(prior+(part->>'quantity')::int)/si.quantity)-floor(si.line_total::numeric*prior/si.quantity);
 END LOOP;
 IF row_json->>'wholesale_refund_minor' IS DISTINCT FROM wholesale::text THEN RAISE EXCEPTION 'Nieprawidłowy historyczny kredyt hurtowy podglądu' USING ERRCODE='23514';END IF;
 -- Each recipe component must be covered exactly once in physical units.
 FOR part IN SELECT m FROM b2b_dropship_quotes q,LATERAL jsonb_array_elements(q.snapshot->'mapping_snapshot') m WHERE(q.tenant_id,q.id)=(d.tenant_id,d.quote_id) AND m->>'customer_item_id'=ri.item_id::text LOOP
 SELECT coalesce(sum((p->>'quantity')::int),0)::int INTO n FROM jsonb_array_elements(row_json->'physical_sources') p WHERE p->>'product_id'=part->'catalog_item'->>'source_product_id';
 IF n<>(row_json->>'quantity')::int*(part->'labels'->>'quantity')::int THEN RAISE EXCEPTION 'Niepełna receptura przekazania' USING ERRCODE='23514';END IF;
 END LOOP;
 END LOOP;IF EXISTS(
 WITH shares AS (
 SELECT (rr->>'dropship_order_id')::uuid dropship_id,(pp->>'issue_fragment_id')::uuid issue_id,sum((pp->>'quantity')::int) quantity
 FROM jsonb_array_elements(NEW.snapshot->'rows') rr CROSS JOIN LATERAL jsonb_array_elements(rr->'physical_sources') pp
 WHERE pp->>'issue_fragment_id' IS NOT NULL GROUP BY (rr->>'dropship_order_id')::uuid,(pp->>'issue_fragment_id')::uuid
 ) SELECT 1 FROM shares s JOIN b2b_dropship_orders b ON(b.tenant_id,b.id)=(NEW.tenant_id,s.dropship_id)
 JOIN wms_issue_fragments f ON(f.tenant_id,f.order_id,f.id)=(b.supplier_tenant_id,b.supplier_order_id,s.issue_id)
 WHERE s.quantity>f.quantity-coalesce((SELECT sum(x.quantity) FROM wms_return_fragments x WHERE(x.tenant_id,x.issue_fragment_id)=(f.tenant_id,f.id)),0)
 ) THEN RAISE EXCEPTION 'Powielony fragment wydania' USING ERRCODE='23514';END IF;
 RETURN NEW;END$$;
CREATE TRIGGER source_guard BEFORE INSERT ON b2b_dropship_return_previews FOR EACH ROW EXECUTE FUNCTION b2b_dropship_return_preview_guard();
CREATE FUNCTION b2b_dropship_return_bind(pid uuid,cid uuid,rid uuid,uid uuid,kid uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p b2b_dropship_return_previews%ROWTYPE;r return_cases%ROWTYPE;g jsonb;rows_json jsonb;dropid uuid;pub jsonb;sn jsonb;BEGIN
 SELECT * INTO p FROM b2b_dropship_return_previews WHERE tenant_id=t AND id=pid;
 IF NOT FOUND OR p.actor_id<>uid OR p.api_key_id IS DISTINCT FROM kid OR p.expires_at<=clock_timestamp() OR b2b_dropship_current_role(uid,false) IS DISTINCT FROM 'admin' OR (kid IS NOT NULL AND b2b_dropship_return_key_grant(uid,kid,true,false) IS DISTINCT FROM 'ok') THEN RAISE EXCEPTION 'Brak aktualnej zgody administratora' USING ERRCODE='23514';END IF;
 SELECT * INTO r FROM return_cases WHERE id=rid;
 SELECT value INTO g FROM jsonb_array_elements(p.snapshot->'groups') WHERE value->>'supplier_order_id'=r.order_id::text AND value->>'supplier_tenant_id'=r.tenant_id::text;
 IF g IS NULL OR r.id IS NULL OR r.state IS DISTINCT FROM 'requested' OR r.submitted_by IS DISTINCT FROM 'buyer' OR r.warehouse_id::text IS DISTINCT FROM g->'settings'->>'warehouse_id'
 OR r.version IS DISTINCT FROM 1 OR r.receipt_sequence IS DISTINCT FROM 0 OR r.legacy IS DISTINCT FROM false
 OR r.received_at IS NOT NULL OR r.receipt IS NOT NULL OR r.settlement IS NOT NULL OR r.refunded_at IS NOT NULL
 OR r.refund_amount IS DISTINCT FROM 0 OR r.refunded_shipping IS DISTINCT FROM 0 OR r.decision_note IS DISTINCT FROM ''
 OR r.requested_shipping<>(g->>'shipping_refund')::int
 OR NOT EXISTS(SELECT 1 FROM b2b_dropship_return_created_cases w WHERE(w.tenant_id,w.return_id)=(r.tenant_id,r.id) AND w.transaction_id=pg_current_xact_id() AND w.transaction_started_at=transaction_timestamp())
 THEN RAISE EXCEPTION 'Nieautentyczne zgłoszenie dostawcy' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM b2b_dropship_return_created_cases w WHERE(w.tenant_id,w.return_id)=(r.tenant_id,r.id) AND w.transaction_id=pg_current_xact_id() AND w.transaction_started_at=transaction_timestamp() AND w.order_before=g->'supplier')
 OR (SELECT to_jsonb(rc) FROM return_cases rc WHERE(rc.tenant_id,rc.id)=(p.tenant_id,p.return_id)) IS DISTINCT FROM p.snapshot->'rma'->'head'
 OR (SELECT to_jsonb(ro) FROM orders ro WHERE(ro.tenant_id,ro.id)=(p.tenant_id,p.order_id)) IS DISTINCT FROM p.snapshot->'order'
 OR (SELECT count(*) FROM return_items ri WHERE(ri.tenant_id,ri.return_id)=(p.tenant_id,p.return_id))<>jsonb_array_length(p.snapshot->'rma'->'items')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.snapshot->'rma'->'items') approved WHERE NOT EXISTS(SELECT 1 FROM return_items ri JOIN order_items oi ON(oi.tenant_id,oi.order_id,oi.id)=(ri.tenant_id,ri.order_id,ri.item_id) WHERE(ri.tenant_id,ri.return_id)=(p.tenant_id,p.return_id) AND to_jsonb(ri)=approved->'row' AND to_jsonb(oi)=approved->'commercial'))
 OR (SELECT to_jsonb(s) FROM b2b_dropship_return_settings s WHERE(s.tenant_id,s.account_id)=(r.tenant_id,(g->'settings'->>'account_id')::uuid)) IS DISTINCT FROM g->'settings'
 OR (SELECT to_jsonb(o)-ARRAY['updated_at','version'] FROM orders o WHERE(o.tenant_id,o.id)=(r.tenant_id,r.order_id)) IS DISTINCT FROM (g->'supplier')-ARRAY['updated_at','version']
 OR (SELECT o.version FROM orders o WHERE(o.tenant_id,o.id)=(r.tenant_id,r.order_id)) IS DISTINCT FROM (g->'supplier'->>'version')::bigint+1
 OR (g->>'wms_lots_enabled')::boolean IS DISTINCT FROM EXISTS(SELECT 1 FROM wms_policies wp WHERE wp.tenant_id=r.tenant_id AND wp.enabled)
 THEN RAISE EXCEPTION 'Zmienił się zatwierdzony zakres przekazania' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM b2b_links l JOIN b2b_accounts ac ON(ac.tenant_id,ac.id)=(l.supplier_tenant_id,l.account_id) WHERE(l.tenant_id,l.id)=(t,(g->>'link_id')::uuid) AND NOT l.paused AND ac.active) THEN RAISE EXCEPTION 'Kontrahent nie przyjmuje przekazania' USING ERRCODE='23514';END IF;
 dropid:=(g->>'dropship_order_id')::uuid;
 IF EXISTS(SELECT 1 FROM b2b_dropship_return_cases h WHERE h.tenant_id=t AND h.return_id=p.return_id AND h.dropship_order_id=dropid AND (b2b_dropship_return_case_state(h.id)->>'state') IS DISTINCT FROM 'withdrawn' AND (b2b_dropship_return_case_state(h.id)->>'state') IS DISTINCT FROM 'rejected') THEN RAISE EXCEPTION 'Zużyty zakres przekazania' USING ERRCODE='23514';END IF;
 SELECT jsonb_agg(v ORDER BY (v->>'index')::int) INTO rows_json FROM jsonb_array_elements(p.snapshot->'rows') v WHERE v->>'dropship_order_id'=dropid::text;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(rows_json) rr CROSS JOIN LATERAL jsonb_array_elements(rr->'physical_sources') ps WHERE NOT EXISTS(SELECT 1 FROM shopify_dispatch_evidence e JOIN shipments sh ON(sh.tenant_id,sh.id)=(e.tenant_id,e.shipment_id) JOIN b2b_dropship_supplier_orders b ON(b.tenant_id,b.order_id)=(e.tenant_id,e.order_id) WHERE(e.tenant_id,e.order_id,e.shipment_id)=(r.tenant_id,r.order_id,(ps->>'shipment_id')::uuid) AND sh.dispatched_at IS NOT NULL AND e.receiver=b.receiver)) THEN RAISE EXCEPTION 'Zmieniło się rzeczywiste wydanie partnera' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM return_items i WHERE(i.tenant_id,i.return_id)=(r.tenant_id,r.id) AND i.requested IS DISTINCT FROM(SELECT sum((part->>'quantity')::int)::int FROM jsonb_array_elements(rows_json) rr CROSS JOIN LATERAL jsonb_array_elements(rr->'physical_sources') part WHERE part->>'supplier_item_id'=i.item_id::text))
 OR EXISTS(SELECT 1 FROM return_items ri JOIN order_items oi ON(oi.tenant_id,oi.id)=(ri.tenant_id,ri.item_id) WHERE(ri.tenant_id,ri.return_id)=(r.tenant_id,r.id) AND (ri.order_id<>r.order_id OR oi.order_id<>r.order_id OR ri.sku<>oi.sku OR ri.name<>oi.name OR ri.components IS DISTINCT FROM (CASE WHEN jsonb_array_length(oi.components)>0 THEN oi.components ELSE jsonb_build_array(jsonb_build_object('product_id',oi.product_id,'quantity',1)) END) OR ri.accepted<>0 OR ri.restocked<>0 OR ri.refund_amount<>0))
 OR (SELECT count(*) FROM return_items i WHERE(i.tenant_id,i.return_id)=(r.tenant_id,r.id))<>(SELECT count(DISTINCT part->>'supplier_item_id') FROM jsonb_array_elements(rows_json) rr CROSS JOIN LATERAL jsonb_array_elements(rr->'physical_sources') part)
 THEN RAISE EXCEPTION 'Niepełny zakres fizycznych pozycji dostawcy' USING ERRCODE='23514';END IF;
 pub:=jsonb_build_object('link_id',g->>'link_id','supplier_name',g->>'supplier_name','supplier_order_id',r.order_id,'supplier_order_number',g->>'supplier_order_number','supplier_return_id',r.id,'number',r.number,'warehouse_id',r.warehouse_id,'wms_lots_enabled',g->'wms_lots_enabled','retail_currency',p.snapshot->'order'->>'currency','wholesale_currency',g->'supplier'->>'currency','return_address',g->'settings'->'return_address');
 sn:=jsonb_build_object('public',pub,'rows',rows_json,'preview_id',p.id,'dropship_order_id',dropid,'buyer_tenant_id',t,'buyer_return_id',p.return_id,'buyer_order_id',p.order_id,'supplier_tenant_id',r.tenant_id,'supplier_order_id',r.order_id,'supplier_return_id',r.id,'created_at',clock_timestamp());
 INSERT INTO b2b_dropship_return_cases(id,tenant_id,preview_id,return_id,order_id,dropship_order_id,link_id,supplier_tenant_id,supplier_order_id,supplier_return_id,snapshot)
 VALUES(cid,t,p.id,p.return_id,p.order_id,dropid,(g->>'link_id')::uuid,r.tenant_id,r.order_id,r.id,sn);
 INSERT INTO b2b_dropship_return_lines(tenant_id,case_id,index,customer_item_id,quantity,row)
 SELECT t,cid,(v->>'index')::int,(v->>'customer_item_id')::uuid,(v->>'quantity')::int,v FROM jsonb_array_elements(rows_json) v;
 INSERT INTO b2b_dropship_return_supplier_cases(tenant_id,return_id,case_id,buyer_tenant_id,snapshot) VALUES(r.tenant_id,r.id,cid,t,sn);
 PERFORM b2b_dropship_return_capacity(cid);
END$$;

CREATE FUNCTION b2b_dropship_return_retail_caps(rid uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;ri return_items%ROWTYPE;h b2b_dropship_return_cases%ROWTYPE;line jsonb;part jsonb;allowed integer;remaining integer;units integer;total integer;case_caps jsonb;out_json jsonb:='[]';requested integer;accepted integer;pool_qty integer;used_qty integer;BEGIN
 IF t IS NULL OR NOT EXISTS(SELECT 1 FROM return_cases WHERE tenant_id=t AND id=rid) THEN RETURN NULL;END IF;
 FOR ri IN SELECT * FROM return_items WHERE tenant_id=t AND return_id=rid ORDER BY item_id LOOP
 total:=0;case_caps:='[]';
 FOR h IN SELECT bc.* FROM b2b_dropship_return_cases bc JOIN return_cases rc ON(rc.tenant_id,rc.id)=(bc.supplier_tenant_id,bc.supplier_return_id) WHERE bc.tenant_id=t AND bc.return_id=rid AND rc.state IS DISTINCT FROM 'cancelled' ORDER BY bc.id LOOP
 SELECT l.row INTO line FROM b2b_dropship_return_lines l WHERE(l.tenant_id,l.case_id,l.customer_item_id)=(t,h.id,ri.item_id);
 IF line IS NULL THEN CONTINUE;END IF;
 units:=(line->>'quantity')::int;
 FOR part IN SELECT value FROM jsonb_array_elements(line->'physical_sources') LOOP
 SELECT i.accepted INTO pool_qty FROM return_items i JOIN return_cases r ON(r.tenant_id,r.id)=(i.tenant_id,i.return_id) WHERE(i.tenant_id,i.return_id,i.item_id)=(h.supplier_tenant_id,h.supplier_return_id,(part->>'supplier_item_id')::uuid) AND r.received_at IS NOT NULL;
 -- A physical supplier row may cover several commercial price lines. Caps are individual;
 -- apply_partner also checks their shared aggregate before granting any credit.
 units:=least(units,coalesce(pool_qty,0)/(part->>'quantity_per_unit')::int);
 END LOOP;
 total:=total+units;case_caps:=case_caps||jsonb_build_array(jsonb_build_object('id',h.id,'quantity',units));
 END LOOP;
 out_json:=out_json||jsonb_build_array(jsonb_build_object('customer_item_id',ri.item_id,'accepted_available',least(ri.requested,total),'case_caps',case_caps));
 END LOOP;RETURN out_json;END$$;
CREATE FUNCTION b2b_dropship_return_apply_partner(pid uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p b2b_dropship_return_proofs%ROWTYPE;r return_cases%ROWTYPE;i return_items%ROWTYPE;o order_items%ROWTYPE;v jsonb;part jsonb;h b2b_dropship_return_cases%ROWTYPE;caps jsonb;qty integer;prior integer;refund bigint;amount bigint;sum_qty integer;accepted_qty integer;BEGIN
 SELECT * INTO p FROM b2b_dropship_return_proofs WHERE id=pid AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp() AND NOT applied AND kind='reconcile' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Brak prywatnego dowodu decyzji detalicznej' USING ERRCODE='23514';END IF;
 SELECT * INTO r FROM return_cases WHERE(tenant_id,id)=(p.tenant_id,p.return_id) FOR UPDATE;
 IF r.state<>'requested' OR r.received_at IS NOT NULL OR r.version<>(p.request->>'version')::bigint OR r.receipt IS NOT NULL THEN RAISE EXCEPTION 'RMA zmieniło się przed decyzją detaliczną' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(p.request->'items')<>(SELECT count(*) FROM return_items WHERE tenant_id=p.tenant_id AND return_id=r.id)
 OR (SELECT count(DISTINCT request_item.value->>'customer_item_id') FROM jsonb_array_elements(p.request->'items') request_item(value))<>jsonb_array_length(p.request->'items')
 OR jsonb_array_length(p.request->'case_versions')<>(SELECT count(*) FROM b2b_dropship_return_cases bc JOIN return_cases rc ON(rc.tenant_id,rc.id)=(bc.supplier_tenant_id,bc.supplier_return_id) WHERE bc.tenant_id=p.tenant_id AND bc.return_id=r.id AND rc.state IS DISTINCT FROM 'cancelled')
 THEN RAISE EXCEPTION 'Niepełna decyzja detaliczna' USING ERRCODE='23514';END IF;
 caps:=b2b_dropship_return_retail_caps(r.id);
 FOR h IN SELECT bc.* FROM b2b_dropship_return_cases bc JOIN return_cases rc ON(rc.tenant_id,rc.id)=(bc.supplier_tenant_id,bc.supplier_return_id) WHERE bc.tenant_id=p.tenant_id AND bc.return_id=r.id AND rc.state IS DISTINCT FROM 'cancelled' LOOP
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.request->'case_versions') cv WHERE cv->>'id'=h.id::text AND (cv->>'version')::int=(b2b_dropship_return_case_state(h.id)->>'version')::int)
 OR (b2b_dropship_return_case_state(h.id)->>'state') NOT IN('received','rejected') THEN RAISE EXCEPTION 'Dostawca nie rozpatrzył aktualnego zakresu' USING ERRCODE='23514';END IF;
 -- Shared supplier-item capacity across all retail line decisions.
 FOR part IN SELECT DISTINCT jsonb_build_object('supplier_item_id',value->>'supplier_item_id') FROM b2b_dropship_return_lines l CROSS JOIN LATERAL jsonb_array_elements(l.row->'physical_sources') WHERE(l.tenant_id,l.case_id)=(p.tenant_id,h.id) LOOP
 SELECT coalesce(sum(least((l.row->>'quantity')::int,coalesce((SELECT (cc->>'quantity')::int FROM jsonb_array_elements(caps) cap CROSS JOIN LATERAL jsonb_array_elements(cap->'case_caps') cc WHERE cap->>'customer_item_id'=l.customer_item_id::text AND cc->>'id'=h.id::text),0),greatest(0,(decision->>'accepted')::int-coalesce((SELECT sum((cc->>'quantity')::int)::int FROM jsonb_array_elements(caps) cap CROSS JOIN LATERAL jsonb_array_elements(cap->'case_caps') cc WHERE cap->>'customer_item_id'=l.customer_item_id::text AND(cc->>'id')::uuid<h.id),0)))*(physical->>'quantity_per_unit')::int),0)::int INTO sum_qty
 FROM b2b_dropship_return_lines l CROSS JOIN LATERAL jsonb_array_elements(p.request->'items') decision
 CROSS JOIN LATERAL (SELECT DISTINCT ps->>'supplier_item_id' supplier_item_id,ps->>'quantity_per_unit' quantity_per_unit FROM jsonb_array_elements(l.row->'physical_sources') ps) ps
 CROSS JOIN LATERAL (SELECT jsonb_build_object('supplier_item_id',ps.supplier_item_id,'quantity_per_unit',ps.quantity_per_unit) physical) ph
 WHERE(l.tenant_id,l.case_id)=(p.tenant_id,h.id) AND decision->>'customer_item_id'=l.customer_item_id::text AND physical->>'supplier_item_id'=part->>'supplier_item_id';
 SELECT coalesce(accepted,0) INTO accepted_qty FROM return_items WHERE(tenant_id,return_id,item_id)=(h.supplier_tenant_id,h.supplier_return_id,(part->>'supplier_item_id')::uuid);
 IF sum_qty>coalesce(accepted_qty,0) THEN RAISE EXCEPTION 'Decyzja detaliczna przekracza rzeczywiste przyjęcie partnera' USING ERRCODE='23514';END IF;
 END LOOP;
 END LOOP;
 caps:=b2b_dropship_return_retail_caps(r.id);amount:=(p.request->>'shipping_refund_minor')::bigint;
 IF amount IS NULL OR amount<0 OR amount>r.requested_shipping THEN RAISE EXCEPTION 'Nadmierny zwrot dostawy detalicznej' USING ERRCODE='23514';END IF;
 FOR i IN SELECT * FROM return_items WHERE(tenant_id,return_id)=(p.tenant_id,r.id) ORDER BY item_id FOR UPDATE LOOP
 SELECT value INTO v FROM jsonb_array_elements(p.request->'items') WHERE value->>'customer_item_id'=i.item_id::text;
 qty:=(v->>'accepted')::int;
 IF qty IS NULL OR qty<0 OR qty>i.requested OR qty>coalesce((SELECT (cc->>'accepted_available')::int FROM jsonb_array_elements(caps) cc WHERE cc->>'customer_item_id'=i.item_id::text),0) THEN RAISE EXCEPTION 'Nadmierna detaliczna ilość przyjęta' USING ERRCODE='23514';END IF;
 SELECT * INTO o FROM order_items WHERE(tenant_id,id)=(p.tenant_id,i.item_id);
 SELECT coalesce(sum(ri.accepted),0)::int INTO prior FROM return_items ri JOIN return_cases rc ON(rc.tenant_id,rc.id)=(ri.tenant_id,ri.return_id) WHERE ri.tenant_id=p.tenant_id AND ri.order_id=r.order_id AND ri.item_id=i.item_id AND rc.state IN('refund_pending','closed');
 IF prior+qty>o.quantity THEN RAISE EXCEPTION 'Zużyty zakres detaliczny' USING ERRCODE='23514';END IF;
 refund:=floor(o.line_total::numeric*(prior+qty)/o.quantity)-floor(o.line_total::numeric*prior/o.quantity);amount:=amount+refund;
 UPDATE return_items SET accepted=qty,restocked=0,refund_amount=refund WHERE(tenant_id,return_id,item_id)=(p.tenant_id,r.id,i.item_id);
 END LOOP;
 UPDATE return_cases SET receipt_sequence=(SELECT coalesce(max(rc.receipt_sequence),0)+1 FROM return_cases rc WHERE(rc.tenant_id,rc.order_id)=(p.tenant_id,r.order_id)),state=CASE WHEN amount=0 THEN 'rejected' ELSE 'refund_pending' END,refunded_shipping=(p.request->>'shipping_refund_minor')::int,refund_amount=amount,decision_note=p.request->>'note',version=version+1,updated_at=clock_timestamp() WHERE(tenant_id,id)=(p.tenant_id,r.id);
 UPDATE b2b_dropship_return_proofs SET after_snapshot=b2b_dropship_return_snapshot(r.id)||jsonb_build_object('stock',p.before_snapshot->'stock') WHERE id=p.id;
END$$;

CREATE FUNCTION b2b_dropship_return_finish(pid uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p b2b_dropship_return_proofs%ROWTYPE;r return_cases%ROWTYPE;i return_items%ROWTYPE;old_i jsonb;v jsonb;expected integer;old_qty integer;stock_json jsonb;after_json jsonb;product uuid;delta integer;old_stock jsonb;current_stock jsonb;old_bin integer;current_bin integer;credit bigint;prior integer;commercial order_items%ROWTYPE;total_credit bigint;BEGIN
 SELECT * INTO p FROM b2b_dropship_return_proofs WHERE id=pid AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp() AND NOT applied FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Brak prywatnego dowodu przyjęcia zwrotu' USING ERRCODE='23514';END IF;
 SELECT * INTO r FROM return_cases WHERE(tenant_id,id)=(p.tenant_id,p.return_id);
 IF r.version<>(p.before_snapshot->'head'->>'version')::bigint+1 OR to_jsonb(r)-ARRAY['state','received_at','receipt','receipt_sequence','refunded_shipping','refund_amount','decision_note','version','updated_at'] IS DISTINCT FROM (p.before_snapshot->'head')-ARRAY['state','received_at','receipt','receipt_sequence','refunded_shipping','refund_amount','decision_note','version','updated_at']
 THEN RAISE EXCEPTION 'Zmieniła się oryginalna tożsamość RMA' USING ERRCODE='23514';END IF;
 IF (p.kind='receive' AND (r.state<>'refund_pending' OR r.received_at IS NULL)) OR (p.kind='reject' AND r.state<>'rejected') OR (p.kind='withdraw' AND r.state<>'cancelled') OR (p.kind='reconcile' AND (r.received_at IS NOT NULL OR r.receipt IS NOT NULL OR r.state NOT IN('refund_pending','rejected'))) THEN RAISE EXCEPTION 'Niewłaściwy wynik działania na RMA' USING ERRCODE='23514';END IF;
 FOR i IN SELECT * FROM return_items WHERE(tenant_id,return_id)=(p.tenant_id,r.id) LOOP
 SELECT value INTO old_i FROM jsonb_array_elements(p.before_snapshot->'items') WHERE value->>'item_id'=i.item_id::text;
 IF old_i IS NULL OR to_jsonb(i)-ARRAY['accepted','restocked','refund_amount'] IS DISTINCT FROM old_i-ARRAY['accepted','restocked','refund_amount'] THEN RAISE EXCEPTION 'Zmieniły się pierwotne pozycje RMA' USING ERRCODE='23514';END IF;
 IF p.kind='receive' THEN SELECT value INTO v FROM jsonb_array_elements(p.request->'items') WHERE value->>'supplier_item_id'=i.item_id::text;
 IF v IS NULL OR i.accepted IS DISTINCT FROM (v->>'accepted')::int OR i.restocked IS DISTINCT FROM (v->>'restocked')::int OR i.accepted>i.requested OR i.restocked>i.accepted THEN RAISE EXCEPTION 'Ilości przyjęcia nie odpowiadają zgodzie' USING ERRCODE='23514';END IF;
 ELSIF p.kind='reconcile' THEN IF i.restocked<>0 THEN RAISE EXCEPTION 'Partnerowa decyzja nie przywraca towaru kupującego' USING ERRCODE='23514';END IF;
 ELSE IF to_jsonb(i) IS DISTINCT FROM old_i THEN RAISE EXCEPTION 'Decyzja bez przyjęcia zmieniła pozycje' USING ERRCODE='23514';END IF;END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.warehouse_id,s.product_id),'[]'::jsonb) INTO stock_json FROM stock s WHERE s.tenant_id=p.tenant_id AND s.warehouse_id=r.warehouse_id AND s.product_id IN(SELECT (comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(p.tenant_id,r.id));
 IF p.kind<>'receive' AND (stock_json IS DISTINCT FROM p.before_snapshot->'stock' OR (SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.product_id,b.location),'[]'::jsonb) FROM stock_locations b WHERE b.tenant_id=p.tenant_id AND b.warehouse_id=r.warehouse_id AND b.product_id IN(SELECT (comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(p.tenant_id,r.id))) IS DISTINCT FROM p.before_snapshot->'bins' OR (SELECT coalesce(jsonb_agg(to_jsonb(lp) ORDER BY lp.product_id,lp.location,lp.layer_id),'[]'::jsonb) FROM wms_layer_positions lp WHERE lp.tenant_id=p.tenant_id AND lp.warehouse_id=r.warehouse_id AND lp.product_id IN(SELECT (comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(p.tenant_id,r.id))) IS DISTINCT FROM p.before_snapshot->'positions' OR (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM stock_movements m WHERE(m.tenant_id,m.return_id)=(p.tenant_id,r.id)) IS DISTINCT FROM p.before_snapshot->'movements') THEN RAISE EXCEPTION 'Decyzja niephysical zmieniła magazyn' USING ERRCODE='23514';END IF;
 IF p.kind IN('receive','reconcile') AND r.receipt_sequence IS DISTINCT FROM (SELECT coalesce(max(rc.receipt_sequence),0)+1 FROM return_cases rc WHERE(rc.tenant_id,rc.order_id)=(p.tenant_id,r.order_id) AND rc.id<>r.id) THEN RAISE EXCEPTION 'Nieprawidłowa kolejność uznania RMA' USING ERRCODE='23514';END IF;
 IF p.kind='receive' THEN
 IF r.refunded_shipping IS DISTINCT FROM (p.request->>'shipping_refund_minor')::int OR r.decision_note IS DISTINCT FROM p.request->>'note' OR r.receipt IS DISTINCT FROM (jsonb_build_object('version',(p.request->>'supplier_return_version')::int,'shipping_refund',(p.request->>'shipping_refund_minor')::int,'note',p.request->>'note','items',(SELECT jsonb_agg(jsonb_build_object('item_id',x.v->>'supplier_item_id','accepted',x.v->'accepted','restocked',x.v->'restocked') ORDER BY x.ord) FROM jsonb_array_elements(p.request->'items') WITH ORDINALITY x(v,ord)))||CASE WHEN p.request ? 'wms_lots' THEN jsonb_build_object('wms_lots',p.request->'wms_lots') ELSE '{}'::jsonb END)
 THEN RAISE EXCEPTION 'Przyjęcie nie odpowiada zatwierdzonej zgodzie' USING ERRCODE='23514';END IF;
 total_credit:=r.refunded_shipping;
 FOR i IN SELECT * FROM return_items WHERE(tenant_id,return_id)=(p.tenant_id,r.id) LOOP
 SELECT * INTO commercial FROM order_items WHERE(tenant_id,id)=(p.tenant_id,i.item_id);
 SELECT coalesce(sum(ri.accepted),0)::int INTO prior FROM return_items ri JOIN return_cases rc ON(rc.tenant_id,rc.id)=(ri.tenant_id,ri.return_id) WHERE ri.tenant_id=p.tenant_id AND ri.order_id=r.order_id AND ri.item_id=i.item_id AND rc.id<>r.id AND rc.state IN('refund_pending','closed');
 credit:=floor(commercial.line_total::numeric*(prior+i.accepted)/commercial.quantity)-floor(commercial.line_total::numeric*prior/commercial.quantity);
 IF i.refund_amount<>credit THEN RAISE EXCEPTION 'Nieprawidłowy historyczny kredyt hurtowy' USING ERRCODE='23514';END IF;total_credit:=total_credit+credit;
 END LOOP;
 IF r.refund_amount<>total_credit THEN RAISE EXCEPTION 'Nieprawidłowa suma kredytu hurtowego' USING ERRCODE='23514';END IF;
 FOR product IN SELECT DISTINCT (comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(p.tenant_id,r.id) LOOP
 SELECT coalesce(sum(ri.restocked*(comp->>'quantity')::int),0)::int INTO delta FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(p.tenant_id,r.id) AND comp->>'product_id'=product::text;
 SELECT value INTO old_stock FROM jsonb_array_elements(p.before_snapshot->'stock') WHERE value->>'product_id'=product::text;
 SELECT to_jsonb(st) INTO current_stock FROM stock st WHERE(st.tenant_id,st.warehouse_id,st.product_id)=(p.tenant_id,r.warehouse_id,product);
 IF coalesce((current_stock->>'on_hand')::bigint,0)<>coalesce((old_stock->>'on_hand')::bigint,0)+delta OR coalesce((current_stock->>'reserved')::bigint,0)<>coalesce((old_stock->>'reserved')::bigint,0) THEN RAISE EXCEPTION 'Brak rzeczywistego przywrócenia stanu dostawcy' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum((b->>'quantity')::int),0)::int INTO old_bin FROM jsonb_array_elements(p.before_snapshot->'bins') b WHERE b->>'product_id'=product::text;
 SELECT coalesce(sum(quantity),0)::int INTO current_bin FROM stock_locations WHERE(tenant_id,warehouse_id,product_id)=(p.tenant_id,r.warehouse_id,product);
 IF current_bin<>old_bin+delta OR (SELECT coalesce(sum(m.delta),0)::int FROM stock_movements m WHERE(m.tenant_id,m.return_id,m.product_id)=(p.tenant_id,r.id,product) AND m.kind='return')<>delta THEN RAISE EXCEPTION 'Brak rzeczywistego przyjęcia w lokacjach lub dzienniku' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=p.tenant_id AND enabled) THEN
 FOR product IN SELECT DISTINCT (comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(p.tenant_id,r.id) LOOP
 SELECT coalesce(sum(ri.restocked*(comp->>'quantity')::int),0)::int INTO delta FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(p.tenant_id,r.id) AND comp->>'product_id'=product::text;
 IF delta>0 AND NOT(p.request ? 'wms_lots') THEN RAISE EXCEPTION 'Przyjęcie WMS wymaga rzeczywistej operacji partii' USING ERRCODE='23514';END IF;
 IF (SELECT coalesce(sum(quantity),0)::int FROM wms_return_fragments WHERE(tenant_id,return_id,product_id)=(p.tenant_id,r.id,product))<>delta THEN RAISE EXCEPTION 'Brak rzeczywistych fragmentów przyjęcia WMS' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum((lp->>'quantity')::int),0)::int INTO old_bin FROM jsonb_array_elements(p.before_snapshot->'positions') lp WHERE lp->>'product_id'=product::text;
 SELECT coalesce(sum(quantity),0)::int INTO current_bin FROM wms_layer_positions WHERE(tenant_id,warehouse_id,product_id)=(p.tenant_id,r.warehouse_id,product);
 IF current_bin<>old_bin+delta THEN RAISE EXCEPTION 'Brak rzeczywistego przywrócenia pozycji kosztowych' USING ERRCODE='23514';END IF;
 END LOOP;
 IF p.request ? 'wms_lots' AND EXISTS(SELECT 1 FROM wms_return_fragments f JOIN wms_operations op ON(op.tenant_id,op.id)=(f.tenant_id,f.operation_id) WHERE(f.tenant_id,f.return_id)=(p.tenant_id,r.id) AND (op.client_key IS DISTINCT FROM(p.request->'wms_lots'->>'client_key')::uuid OR op.policy_version IS DISTINCT FROM(p.request->'wms_lots'->>'policy_version')::bigint OR op.actor_id IS DISTINCT FROM p.actor_id OR op.request IS DISTINCT FROM r.receipt OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.request->'wms_lots'->'picks') pick WHERE pick->>'issue_fragment_id'=f.issue_fragment_id::text AND pick->>'location'=f.location AND(pick->>'quantity')::int=f.quantity))) THEN RAISE EXCEPTION 'Fragment WMS odbiega od zatwierdzonego wyboru przyjęcia' USING ERRCODE='23514';END IF;
 IF p.request ? 'wms_lots' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.request->'wms_lots'->'picks') pick WHERE NOT EXISTS(SELECT 1 FROM wms_return_fragments f WHERE(f.tenant_id,f.return_id,f.issue_fragment_id,f.location,f.quantity)=(p.tenant_id,r.id,(pick->>'issue_fragment_id')::uuid,pick->>'location',(pick->>'quantity')::int))) THEN RAISE EXCEPTION 'Brakuje zatwierdzonego fragmentu WMS' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM wms_return_fragments f JOIN wms_issue_fragments iss ON(iss.tenant_id,iss.id)=(f.tenant_id,f.issue_fragment_id) JOIN wms_operations op ON(op.tenant_id,op.id)=(f.tenant_id,f.operation_id) WHERE(f.tenant_id,f.return_id)=(p.tenant_id,r.id) AND (op.kind<>'return' OR op.return_id IS DISTINCT FROM r.id OR op.order_id IS DISTINCT FROM r.order_id OR f.layer_id<>iss.layer_id OR f.product_id<>iss.product_id OR f.value_minor IS DISTINCT FROM iss.unit_cost_minor*f.quantity OR NOT EXISTS(SELECT 1 FROM wms_layer_movements lm WHERE(lm.tenant_id,lm.operation_id,lm.layer_id,lm.location,lm.product_id)=(f.tenant_id,f.operation_id,f.layer_id,f.location,f.product_id) AND lm.delta=f.quantity AND lm.value_delta IS NOT DISTINCT FROM f.value_minor))) THEN RAISE EXCEPTION 'Nieautentyczne odtworzenie kosztu pierwotnego wydania' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM wms_return_fragments f WHERE(f.tenant_id,f.return_id)=(p.tenant_id,r.id) GROUP BY f.issue_fragment_id HAVING sum(f.quantity)>coalesce((SELECT sum((ps->>'quantity')::int) FROM b2b_dropship_return_lines l CROSS JOIN LATERAL jsonb_array_elements(l.row->'physical_sources') ps WHERE l.case_id=p.case_id AND ps->>'issue_fragment_id'=f.issue_fragment_id::text),0)) THEN RAISE EXCEPTION 'Przyjęcie przekracza zatwierdzony udział fragmentu' USING ERRCODE='23514';END IF;
 END IF;
 IF p.request ? 'wms_lots' AND EXISTS(SELECT 1 FROM wms_return_fragments f WHERE(f.tenant_id,f.return_id)=(p.tenant_id,r.id) AND NOT EXISTS(SELECT 1 FROM b2b_dropship_return_lines l CROSS JOIN LATERAL jsonb_array_elements(l.row->'physical_sources') ps WHERE l.case_id=p.case_id AND ps->>'issue_fragment_id'=f.issue_fragment_id::text)) THEN RAISE EXCEPTION 'Przyjęto obcy fragment kosztowy' USING ERRCODE='23514';END IF;
 END IF;
 after_json:=b2b_dropship_return_snapshot(r.id)||jsonb_build_object('stock',stock_json);
 IF p.kind='reconcile' AND (p.after_snapshot IS NULL OR after_json IS DISTINCT FROM p.after_snapshot) THEN RAISE EXCEPTION 'Brak wyprowadzonej decyzji partnerowej' USING ERRCODE='23514';END IF;
 UPDATE b2b_dropship_return_proofs SET after_snapshot=after_json,applied=true WHERE id=p.id;
END$$;
CREATE FUNCTION b2b_dropship_return_proof_complete() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE p b2b_dropship_return_proofs%ROWTYPE;a b2b_dropship_return_actions%ROWTYPE;actual jsonb;BEGIN
 SELECT * INTO p FROM b2b_dropship_return_proofs WHERE id=NEW.id;
 SELECT * INTO a FROM b2b_dropship_return_actions WHERE(tenant_id,id)=(p.actor_tenant_id,p.action_id);
 IF NOT p.applied OR p.after_snapshot IS NULL OR a.id IS NULL OR a.actor_id<>p.actor_id OR a.api_key_id IS DISTINCT FROM p.api_key_id OR a.kind<>p.kind OR a.request IS DISTINCT FROM p.request OR a.return_id IS DISTINCT FROM (CASE WHEN p.kind='reconcile' THEN p.return_id ELSE(SELECT return_id FROM b2b_dropship_return_cases WHERE id=p.case_id) END)
 THEN RAISE EXCEPTION 'Niekompletny dowód działania na koordynowanym zwrocie' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.tenant_id',p.tenant_id::text,true);actual:=b2b_dropship_return_snapshot(p.return_id);
 IF actual IS DISTINCT FROM p.after_snapshot-'stock' THEN RAISE EXCEPTION 'Końcowy stan RMA odbiega od dowodu' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.tenant_id',p.actor_tenant_id::text,true);
 IF b2b_dropship_current_role(p.actor_id,false) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Brak aktualnej zgody administratora' USING ERRCODE='23514';END IF;
 IF p.api_key_id IS NOT NULL THEN IF b2b_dropship_return_key_grant(p.actor_id,p.api_key_id,true,false)='invalid' THEN RAISE EXCEPTION 'Klucz został cofnięty lub wygasł' USING ERRCODE='23514';ELSIF b2b_dropship_return_key_grant(p.actor_id,p.api_key_id,true,false)<>'ok' THEN RAISE EXCEPTION 'Brak bieżących zakresów zwrotu' USING ERRCODE='23514';END IF;END IF;
 RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER proof_complete AFTER INSERT ON b2b_dropship_return_proofs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_dropship_return_proof_complete();
CREATE FUNCTION b2b_dropship_return_action_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF NEW.kind IN('receive','reject','withdraw','reconcile') AND NOT EXISTS(SELECT 1 FROM b2b_dropship_return_proofs p WHERE(p.actor_tenant_id,p.action_id,p.actor_id)=(NEW.tenant_id,NEW.id,NEW.actor_id) AND p.api_key_id IS NOT DISTINCT FROM NEW.api_key_id AND p.kind=NEW.kind AND p.request=NEW.request AND p.applied AND ((p.kind='reconcile' AND NEW.case_id IS NULL AND NEW.return_id=p.return_id AND NEW.result->'case_ids'=(SELECT jsonb_agg(h.id ORDER BY h.id) FROM b2b_dropship_return_cases h JOIN return_cases rc ON(rc.tenant_id,rc.id)=(h.supplier_tenant_id,h.supplier_return_id) WHERE(h.tenant_id,h.return_id)=(p.tenant_id,p.return_id) AND rc.state IS DISTINCT FROM 'cancelled')) OR(p.kind<>'reconcile' AND NEW.case_id=p.case_id AND NEW.return_id=(SELECT h.return_id FROM b2b_dropship_return_cases h WHERE h.id=p.case_id) AND NEW.result->>'case_id'=p.case_id::text))) THEN RAISE EXCEPTION 'Brak prywatnego dowodu działania' USING ERRCODE='23514';END IF;
 IF NEW.kind='submit' AND (NOT EXISTS(SELECT 1 FROM b2b_dropship_return_previews p WHERE(p.tenant_id,p.id,p.return_id)=(NEW.tenant_id,NEW.preview_id,NEW.return_id) AND p.actor_id=NEW.actor_id AND p.api_key_id IS NOT DISTINCT FROM NEW.api_key_id)
 OR jsonb_array_length(NEW.result->'case_ids')<>(SELECT count(*) FROM b2b_dropship_return_cases h WHERE(h.tenant_id,h.preview_id)=(NEW.tenant_id,NEW.preview_id))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.result->'case_ids') cid WHERE NOT EXISTS(SELECT 1 FROM b2b_dropship_return_cases h WHERE(h.tenant_id,h.preview_id,h.id)=(NEW.tenant_id,NEW.preview_id,cid::uuid)))) THEN RAISE EXCEPTION 'Niepełne potwierdzenie przekazania' USING ERRCODE='23514';END IF;
 RETURN NEW;END$$;
CREATE CONSTRAINT TRIGGER action_guard AFTER INSERT ON b2b_dropship_return_actions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_dropship_return_action_guard();
CREATE FUNCTION b2b_dropship_return_events(cid uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN b2b_dropship_return_pair(cid) IS NULL THEN NULL ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'kind',a.kind,'created_at',a.created_at,'actor_name',u.name,'note',coalesce(a.request->>'note',a.request->>'reason'),'result',jsonb_build_object('case_ids',CASE WHEN nullif(current_setting('app.tenant_id',true),'')::uuid=(SELECT tenant_id FROM b2b_dropship_return_cases WHERE id=cid) THEN a.result->'case_ids' ELSE jsonb_build_array(cid) END)) ORDER BY a.created_at,a.id) FROM b2b_dropship_return_actions a JOIN users u ON u.id=a.actor_id WHERE a.case_id=cid OR a.preview_id=(SELECT preview_id FROM b2b_dropship_return_cases WHERE id=cid) OR(a.kind='reconcile' AND(a.tenant_id,a.return_id)=(SELECT tenant_id,return_id FROM b2b_dropship_return_cases WHERE id=cid))),'[]'::jsonb) END
$$;

CREATE FUNCTION b2b_dropship_return_private_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_OP='DELETE' OR OLD.applied OR (NOT NEW.applied AND (OLD.after_snapshot IS NOT NULL OR NEW.kind<>'reconcile')) OR NEW.after_snapshot IS NULL OR to_jsonb(NEW)-ARRAY['applied','after_snapshot'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['applied','after_snapshot'] THEN RAISE EXCEPTION 'Prywatny dowód jest niezmienny' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON b2b_dropship_return_proofs FOR EACH ROW EXECUTE FUNCTION b2b_dropship_return_private_guard();
-- Applied proof seals the RMA even after SET CONSTRAINTS IMMEDIATE; future transactions
-- may perform the separately authorized monetary settlement, but not rewrite acceptance.
CREATE FUNCTION b2b_dropship_return_budget() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE t uuid:=NEW.tenant_id;bytes bigint;n integer;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('b2b.dropship.returns:'||t::text,0));
 SELECT count(*)::int INTO n FROM b2b_dropship_return_previews WHERE tenant_id=t;
 IF n>2000 THEN RAISE EXCEPTION 'Limit koordynowanych zwrotów: 2000 podglądów' USING ERRCODE='P0001';END IF;
 SELECT count(*)::int INTO n FROM b2b_dropship_return_cases WHERE tenant_id=t;
 IF n>2000 THEN RAISE EXCEPTION 'Limit koordynowanych zwrotów: 2000 spraw' USING ERRCODE='P0001';END IF;
 SELECT coalesce(sum(byte_count),0) INTO bytes FROM(
 SELECT byte_count FROM b2b_dropship_return_previews WHERE tenant_id=t UNION ALL SELECT byte_count FROM b2b_dropship_return_cases WHERE tenant_id=t UNION ALL SELECT byte_count FROM b2b_dropship_return_lines WHERE tenant_id=t UNION ALL SELECT byte_count FROM b2b_dropship_return_supplier_cases WHERE tenant_id=t UNION ALL SELECT byte_count FROM b2b_dropship_return_actions WHERE tenant_id=t
 UNION ALL SELECT octet_length(to_jsonb(p)::text)::bigint FROM b2b_dropship_return_proofs p WHERE tenant_id=t) ownbytes;
 IF bytes>134217728 THEN RAISE EXCEPTION 'Limit koordynowanych zwrotów: 128 MiB dowodów' USING ERRCODE='P0001';END IF;
 IF TG_TABLE_NAME='b2b_dropship_return_previews' THEN
 IF NEW.byte_count>8388608 THEN RAISE EXCEPTION 'Limit koordynowanych zwrotów: 8 MiB podglądu' USING ERRCODE='P0001';END IF;
 END IF;
 RETURN NULL;END$$;
DO $$DECLARE tab text;BEGIN FOREACH tab IN ARRAY ARRAY['b2b_dropship_return_previews','b2b_dropship_return_cases','b2b_dropship_return_lines','b2b_dropship_return_supplier_cases','b2b_dropship_return_actions','b2b_dropship_return_proofs'] LOOP EXECUTE format('CREATE TRIGGER budget AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION b2b_dropship_return_budget()',tab);END LOOP;END$$;
DO $$DECLARE p record;BEGIN FOR p IN SELECT oid::regprocedure proc FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'b2b_dropship_return_%' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',p.proc);
 IF p.proc::text ~ '^b2b_dropship_return_(pair|acceptance|installed|snapshot|case_state|prepare|write_allowed|key_grant|value_grant|bind|retail_caps|apply_partner|finish|events)\(' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO dyna_app',p.proc);END IF;
 END LOOP;END$$;

CREATE TRIGGER proof_budget AFTER UPDATE ON b2b_dropship_return_proofs FOR EACH ROW EXECUTE FUNCTION b2b_dropship_return_budget();
CREATE FUNCTION b2b_dropship_return_source_seal() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE t uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;BEGIN
 IF to_regclass('public.b2b_dropship_return_proofs') IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END IF;
 IF EXISTS(SELECT 1 FROM b2b_dropship_return_proofs p WHERE p.tenant_id=t AND p.transaction_id=pg_current_xact_id() AND p.transaction_started_at=transaction_timestamp() AND p.applied) THEN RAISE EXCEPTION 'Końcowy dowód zwrotu zamknął zmiany fizyczne w tej transakcji' USING ERRCODE='23514';END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END$$;
DO $$DECLARE tab text;BEGIN FOREACH tab IN ARRAY ARRAY['stock','stock_locations','stock_movements','stock_location_movements','wms_layer_positions','wms_layer_movements','wms_return_fragments'] LOOP EXECUTE format('CREATE TRIGGER dropship_return_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION b2b_dropship_return_source_seal()',tab);END LOOP;END$$;
REVOKE ALL ON FUNCTION b2b_dropship_return_source_seal() FROM PUBLIC;

CREATE FUNCTION b2b_dropship_return_case_complete() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE h b2b_dropship_return_cases%ROWTYPE;p b2b_dropship_return_previews%ROWTYPE;BEGIN
 SELECT * INTO h FROM b2b_dropship_return_cases WHERE id=NEW.id;SELECT * INTO p FROM b2b_dropship_return_previews WHERE(tenant_id,id)=(h.tenant_id,h.preview_id);
 IF NOT EXISTS(SELECT 1 FROM b2b_dropship_return_actions a WHERE(a.tenant_id,a.preview_id,a.return_id)=(h.tenant_id,p.id,p.return_id) AND a.kind='submit' AND a.result->'case_ids' @> jsonb_build_array(h.id))
 OR (SELECT count(*) FROM b2b_dropship_return_cases WHERE(tenant_id,preview_id)=(h.tenant_id,p.id))<>jsonb_array_length(p.snapshot->'groups')
 OR (SELECT coalesce(jsonb_agg(l.row ORDER BY l.index),'[]'::jsonb) FROM b2b_dropship_return_lines l WHERE(l.tenant_id,l.case_id)=(h.tenant_id,h.id)) IS DISTINCT FROM h.snapshot->'rows'
 OR NOT EXISTS(SELECT 1 FROM b2b_dropship_return_supplier_cases s WHERE(s.tenant_id,s.return_id,s.case_id,s.buyer_tenant_id)=(h.supplier_tenant_id,h.supplier_return_id,h.id,h.tenant_id) AND s.snapshot=h.snapshot)
 THEN RAISE EXCEPTION 'Niekompletne przekazanie koordynowanego zwrotu' USING ERRCODE='23514';END IF;PERFORM b2b_dropship_return_capacity(h.id);RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER complete AFTER INSERT ON b2b_dropship_return_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_dropship_return_case_complete();
REVOKE ALL ON FUNCTION b2b_dropship_return_case_complete() FROM PUBLIC;

CREATE FUNCTION b2b_dropship_return_settings_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF jsonb_typeof(NEW.return_address) IS DISTINCT FROM 'object'
 OR NOT(NEW.return_address ?& ARRAY['name','street','city','postal_code','country'])
 OR EXISTS(SELECT 1 FROM jsonb_each(NEW.return_address) e WHERE e.key NOT IN('name','street','city','postal_code','country','phone') OR jsonb_typeof(e.value)<>'string' OR length(btrim(e.value#>>'{}'))=0)
 OR (NEW.return_address->>'country') !~ '^[A-Z]{2}$'
 OR(TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.account_id<>OLD.account_id OR NEW.version<>OLD.version+1))
 OR(TG_OP='INSERT' AND NEW.version<>coalesce((SELECT s.version FROM b2b_dropship_return_settings s WHERE(s.tenant_id,s.account_id)=(NEW.tenant_id,NEW.account_id)),0)+1) THEN RAISE EXCEPTION 'Nieprawidłowa jawna polityka adresu zwrotu' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER settings_guard BEFORE INSERT OR UPDATE ON b2b_dropship_return_settings FOR EACH ROW EXECUTE FUNCTION b2b_dropship_return_settings_guard();
REVOKE ALL ON FUNCTION b2b_dropship_return_settings_guard() FROM PUBLIC;

CREATE FUNCTION b2b_dropship_return_capacity(cid uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h b2b_dropship_return_cases%ROWTYPE;oi order_items%ROWTYPE;current_committed bigint;issued bigint;row_json jsonb;part jsonb;f wms_issue_fragments%ROWTYPE;claimed bigint;restored bigint;shipping_limit bigint;BEGIN
 SELECT * INTO h FROM b2b_dropship_return_cases WHERE id=cid;
 IF NOT FOUND THEN RAISE EXCEPTION 'Brak źródła przekazania' USING ERRCODE='23514';END IF;
 SELECT o.shipping_cost INTO shipping_limit FROM orders o WHERE(o.tenant_id,o.id)=(h.supplier_tenant_id,h.supplier_order_id) FOR UPDATE;
 SELECT coalesce(sum(CASE WHEN rc.state='requested' THEN rc.requested_shipping WHEN rc.state IN('refund_pending','closed') THEN rc.refunded_shipping ELSE 0 END),0) INTO current_committed FROM return_cases rc WHERE(rc.tenant_id,rc.order_id)=(h.supplier_tenant_id,h.supplier_order_id);
 IF current_committed>shipping_limit THEN RAISE EXCEPTION 'Przekazanie przekracza bieżący koszt dostawy dostawcy' USING ERRCODE='23514';END IF;
 FOR oi IN SELECT o.* FROM order_items o JOIN return_items i ON(i.tenant_id,i.item_id)=(o.tenant_id,o.id) WHERE(i.tenant_id,i.return_id)=(h.supplier_tenant_id,h.supplier_return_id) LOOP
 SELECT coalesce(sum(CASE WHEN rc.state='requested' THEN i.requested WHEN rc.state IN('refund_pending','closed') THEN i.accepted ELSE 0 END),0) INTO current_committed FROM return_items i JOIN return_cases rc ON(rc.tenant_id,rc.id)=(i.tenant_id,i.return_id) WHERE(i.tenant_id,i.order_id,i.item_id)=(h.supplier_tenant_id,h.supplier_order_id,oi.id);
 SELECT coalesce(sum((line->>'quantity')::int),0) INTO issued FROM shopify_dispatch_evidence e JOIN shipments sh ON(sh.tenant_id,sh.id)=(e.tenant_id,e.shipment_id) JOIN b2b_dropship_supplier_orders b ON(b.tenant_id,b.order_id)=(e.tenant_id,e.order_id) CROSS JOIN LATERAL jsonb_array_elements(e.items) line WHERE(e.tenant_id,e.order_id)=(h.supplier_tenant_id,h.supplier_order_id) AND sh.dispatched_at IS NOT NULL AND e.receiver=b.receiver AND line->>'id'=oi.id::text;
 IF current_committed>least(oi.quantity,issued) THEN RAISE EXCEPTION 'Przekazanie przekracza bieżącą dostępną ilość dostawcy' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR part IN SELECT DISTINCT jsonb_build_object('issue_fragment_id',ps->>'issue_fragment_id') FROM b2b_dropship_return_lines l CROSS JOIN LATERAL jsonb_array_elements(l.row->'physical_sources') ps WHERE l.case_id=cid AND ps ? 'issue_fragment_id' LOOP
 SELECT * INTO f FROM wms_issue_fragments WHERE tenant_id=h.supplier_tenant_id AND order_id=h.supplier_order_id AND id=(part->>'issue_fragment_id')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'Brak pierwotnego fragmentu wydania' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(quantity),0) INTO restored FROM wms_return_fragments WHERE(tenant_id,issue_fragment_id)=(f.tenant_id,f.id);
 -- Before receipt, every explicitly approved issue share stays reserved. After
 -- receipt, only accepted units not genuinely restocked remain reserved. Their
 -- deterministic issue order is an escrow allocation, never a cost attribution.
 WITH share_rows AS (
 SELECT l.case_id,(ps->>'supplier_item_id')::uuid item_id,(ps->>'issue_fragment_id')::uuid issue_id,sum((ps->>'quantity')::int)::bigint qty
 FROM b2b_dropship_return_lines l JOIN b2b_dropship_return_cases bc ON(bc.tenant_id,bc.id)=(l.tenant_id,l.case_id)
 CROSS JOIN LATERAL jsonb_array_elements(l.row->'physical_sources') ps
 WHERE(bc.supplier_tenant_id,bc.supplier_order_id)=(f.tenant_id,f.order_id) AND ps->>'issue_fragment_id' IS NOT NULL
 GROUP BY l.case_id,(ps->>'supplier_item_id')::uuid,(ps->>'issue_fragment_id')::uuid
 ), remaining_rows AS (
 SELECT sr.*,rc.state,
 greatest(0,sr.qty-coalesce((SELECT sum(wr.quantity) FROM wms_return_fragments wr WHERE(wr.tenant_id,wr.return_id,wr.issue_fragment_id)=(bc.supplier_tenant_id,bc.supplier_return_id,sr.issue_id)),0)) remaining_share,
 greatest(0,ri.accepted-coalesce((SELECT sum(wr.quantity) FROM wms_return_fragments wr WHERE(wr.tenant_id,wr.return_id,wr.product_id)=(bc.supplier_tenant_id,bc.supplier_return_id,bound_item.product_id)),0)) accepted_remaining
 FROM share_rows sr JOIN b2b_dropship_return_cases bc ON bc.id=sr.case_id
 JOIN return_cases rc ON(rc.tenant_id,rc.id)=(bc.supplier_tenant_id,bc.supplier_return_id)
 JOIN return_items ri ON(ri.tenant_id,ri.return_id,ri.item_id)=(rc.tenant_id,rc.id,sr.item_id)
 JOIN order_items bound_item ON(bound_item.tenant_id,bound_item.order_id,bound_item.id)=(ri.tenant_id,ri.order_id,ri.item_id)
 ), allocated_rows AS (
 SELECT rr.*,coalesce(sum(rr.remaining_share) OVER(PARTITION BY rr.case_id,rr.item_id ORDER BY rr.issue_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) preceding_share FROM remaining_rows rr
 ) SELECT coalesce(sum(CASE WHEN ar.state='requested' THEN ar.qty WHEN ar.state IN('refund_pending','closed') THEN least(ar.remaining_share,greatest(0,ar.accepted_remaining-ar.preceding_share)) ELSE 0 END),0) INTO claimed
 FROM allocated_rows ar WHERE ar.issue_id=f.id;
 IF claimed+restored>f.quantity THEN RAISE EXCEPTION 'Przekazanie przekracza bieżący wolny fragment wydania WMS' USING ERRCODE='23514';END IF;
 END LOOP;
END$$;
REVOKE ALL ON FUNCTION b2b_dropship_return_capacity(uuid) FROM PUBLIC;

-- An ordinary supplier receipt must preserve the issue shares already bound to
-- pending partner cases. Check the final transaction state, after receipt rows
-- and the RMA accepted quantities have both been written by the return core.
CREATE FUNCTION b2b_dropship_return_issue_capacity() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE case_id uuid;BEGIN
 FOR case_id IN
 SELECT DISTINCT c.id FROM b2b_dropship_return_cases c JOIN b2b_dropship_return_lines l ON(l.tenant_id,l.case_id)=(c.tenant_id,c.id)
 CROSS JOIN LATERAL jsonb_array_elements(l.row->'physical_sources') part
 WHERE c.supplier_tenant_id=NEW.tenant_id AND c.supplier_order_id=NEW.order_id AND part->>'issue_fragment_id'=NEW.issue_fragment_id::text
 ORDER BY c.id
 LOOP PERFORM b2b_dropship_return_capacity(case_id);END LOOP;
 RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER b2b_dropship_return_issue_capacity AFTER INSERT ON wms_return_fragments
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_dropship_return_issue_capacity();
REVOKE ALL ON FUNCTION b2b_dropship_return_issue_capacity() FROM PUBLIC;
