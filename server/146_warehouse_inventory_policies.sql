-- Additive policy only. No historical rows or quantities are rewritten.
CREATE TABLE warehouse_inventory_policy_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,warehouse_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL CHECK(expires_at>created_at),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,warehouse_id),UNIQUE(tenant_id,actor_id,client_key),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE warehouse_inventory_policy_operations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,warehouse_id uuid NOT NULL,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),before_policy jsonb NOT NULL,after_policy jsonb NOT NULL,revision_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,warehouse_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,actor_id,client_key),
 FOREIGN KEY(tenant_id,preview_id,warehouse_id) REFERENCES warehouse_inventory_policy_previews(tenant_id,id,warehouse_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE warehouse_inventory_policy_revisions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,warehouse_id uuid NOT NULL,operation_id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),
 usage text NOT NULL CHECK(usage IN('sale','custody')),enabled boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,warehouse_id),UNIQUE(tenant_id,id,warehouse_id,version),UNIQUE(tenant_id,warehouse_id,version),UNIQUE(tenant_id,operation_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,operation_id,warehouse_id) REFERENCES warehouse_inventory_policy_operations(tenant_id,id,warehouse_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE warehouse_inventory_policy_operations ADD FOREIGN KEY(tenant_id,revision_id,warehouse_id)
 REFERENCES warehouse_inventory_policy_revisions(tenant_id,id,warehouse_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE warehouse_inventory_policies (
 tenant_id uuid NOT NULL REFERENCES tenants,warehouse_id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),
 usage text NOT NULL CHECK(usage IN('sale','custody')),enabled boolean NOT NULL,revision_id uuid NOT NULL,operation_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,warehouse_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,revision_id,warehouse_id,version) REFERENCES warehouse_inventory_policy_revisions(tenant_id,id,warehouse_id,version) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,operation_id,warehouse_id) REFERENCES warehouse_inventory_policy_operations(tenant_id,id,warehouse_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE warehouse_inventory_policy_admissions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,warehouse_id uuid NOT NULL,preview_id uuid NOT NULL,operation_id uuid NOT NULL,revision_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,txid xid8 NOT NULL DEFAULT pg_current_xact_id(),snapshot jsonb NOT NULL,
 UNIQUE(tenant_id,operation_id),FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,preview_id,warehouse_id) REFERENCES warehouse_inventory_policy_previews(tenant_id,id,warehouse_id),
 FOREIGN KEY(tenant_id,operation_id,warehouse_id) REFERENCES warehouse_inventory_policy_operations(tenant_id,id,warehouse_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,revision_id,warehouse_id) REFERENCES warehouse_inventory_policy_revisions(tenant_id,id,warehouse_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX warehouse_inventory_policy_preview_page ON warehouse_inventory_policy_previews(tenant_id,id);
CREATE INDEX warehouse_inventory_policy_operation_page ON warehouse_inventory_policy_operations(tenant_id,id);
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['warehouse_inventory_policies','warehouse_inventory_policy_revisions','warehouse_inventory_policy_previews','warehouse_inventory_policy_operations','warehouse_inventory_policy_admissions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',rel);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',rel);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',rel);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',rel);
END LOOP;END $$;

CREATE FUNCTION warehouse_inventory_policy_installed() RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT true$$;
CREATE FUNCTION warehouse_inventory_policy_hash(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT encode(sha256(convert_to(j::text,'UTF8')),'hex')$$;
CREATE FUNCTION warehouse_inventory_policy_require() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN IF NOT public.warehouse_inventory_policy_guards() THEN RAISE EXCEPTION 'Niekompletna polityka magazynów' USING ERRCODE='55000';END IF;END $$;
CREATE FUNCTION warehouse_inventory_policy(t uuid,wh uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.warehouse_inventory_policies;
BEGIN PERFORM public.warehouse_inventory_policy_require();
 IF t IS NULL OR t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Obca firma polityki magazynu' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.warehouses WHERE(tenant_id,id)=(t,wh)) THEN RAISE EXCEPTION 'Nie znaleziono własnego magazynu' USING ERRCODE='P0002';END IF;
 SELECT * INTO p FROM public.warehouse_inventory_policies WHERE(tenant_id,warehouse_id)=(t,wh);
 RETURN jsonb_build_object('usage',coalesce(p.usage,'sale'),'enabled',coalesce(p.enabled,true),'version',coalesce(p.version,0)::text);
END $$;
CREATE FUNCTION warehouse_inventory_policy_record_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j jsonb:=to_jsonb(NEW);a public.warehouse_inventory_policy_admissions;p public.warehouse_inventory_policy_previews;bp jsonb;
BEGIN
 IF TG_OP='DELETE' OR(TG_OP='UPDATE' AND TG_TABLE_NAME<>'warehouse_inventory_policies') THEN RAISE EXCEPTION 'Dowód polityki magazynu jest niezmienny' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='warehouse_inventory_policy_previews' THEN
  PERFORM public.warehouse_inventory_policy_access(NEW.actor_id,NEW.api_key_id,true,false);
  IF NOT public.warehouse_inventory_policy_request_valid(NEW.request,false) OR NEW.request_hash IS DISTINCT FROM public.warehouse_inventory_policy_hash(jsonb_build_object('actor',NEW.actor_id,'key',NEW.api_key_id,'warehouse',NEW.warehouse_id,'request',NEW.request))
  OR NEW.snapshot IS DISTINCT FROM public.warehouse_inventory_policy_frame(NEW.tenant_id,NEW.warehouse_id,NEW.request) OR NEW.scope_hash IS DISTINCT FROM public.warehouse_inventory_policy_hash(NEW.snapshot)
  OR NEW.expires_at IS DISTINCT FROM NEW.created_at+interval '900 seconds' OR NEW.created_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Niepoprawny dowód podglądu polityki' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='warehouse_inventory_policy_admissions' THEN
  SELECT * INTO p FROM public.warehouse_inventory_policy_previews WHERE(tenant_id,id,warehouse_id)=(NEW.tenant_id,NEW.preview_id,NEW.warehouse_id);
  PERFORM public.warehouse_inventory_policy_access(NEW.actor_id,NEW.api_key_id,true,false);
  IF NEW.txid IS DISTINCT FROM pg_current_xact_id() OR p.id IS NULL OR p.actor_id IS DISTINCT FROM NEW.actor_id OR p.api_key_id IS DISTINCT FROM NEW.api_key_id
  OR p.snapshot IS DISTINCT FROM NEW.snapshot OR p.snapshot IS DISTINCT FROM public.warehouse_inventory_policy_frame(NEW.tenant_id,NEW.warehouse_id,p.request)
  OR p.expires_at<=clock_timestamp() OR jsonb_array_length(p.snapshot->'blockers')<>0
  OR EXISTS(SELECT 1 FROM public.warehouse_inventory_policy_admissions x WHERE x.tenant_id=NEW.tenant_id AND x.warehouse_id=NEW.warehouse_id AND x.txid=pg_current_xact_id()) THEN RAISE EXCEPTION 'Niepoprawna zgoda polityki magazynu' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 SELECT * INTO a FROM public.warehouse_inventory_policy_admissions WHERE(tenant_id,operation_id,warehouse_id)=((j->>'tenant_id')::uuid,(j->>'operation_id')::uuid,(j->>'warehouse_id')::uuid) AND txid=pg_current_xact_id();
 IF TG_TABLE_NAME='warehouse_inventory_policy_operations' THEN SELECT * INTO a FROM public.warehouse_inventory_policy_admissions WHERE(tenant_id,operation_id)=(NEW.tenant_id,NEW.id) AND txid=pg_current_xact_id();END IF;
 IF a.id IS NULL THEN RAISE EXCEPTION 'Zmiana polityki wymaga rzeczywistej zgody' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM public.warehouse_inventory_policy_previews WHERE(tenant_id,id)=(a.tenant_id,a.preview_id);
 IF TG_TABLE_NAME='warehouse_inventory_policy_operations' THEN
  IF NEW.preview_id IS DISTINCT FROM a.preview_id OR NEW.warehouse_id IS DISTINCT FROM a.warehouse_id OR NEW.actor_id IS DISTINCT FROM a.actor_id OR NEW.api_key_id IS DISTINCT FROM a.api_key_id OR NEW.revision_id IS DISTINCT FROM a.revision_id
  OR NOT public.warehouse_inventory_policy_request_valid(NEW.request,true) OR NEW.client_key IS DISTINCT FROM(NEW.request->>'client_key')::uuid OR NEW.request->>'scope_hash' IS DISTINCT FROM p.scope_hash OR NEW.scope_hash IS DISTINCT FROM p.scope_hash
  OR NEW.request_hash IS DISTINCT FROM public.warehouse_inventory_policy_hash(jsonb_build_object('actor',a.actor_id,'key',a.api_key_id,'preview',a.preview_id,'request',NEW.request))
  OR NEW.before_policy IS DISTINCT FROM a.snapshot->'before' OR NEW.after_policy IS DISTINCT FROM jsonb_build_object('usage',p.request->>'usage','enabled',p.request->'enabled','version',((p.request->>'version')::bigint+1)::text) THEN RAISE EXCEPTION 'Wynik polityki nie odpowiada zgodzie' USING ERRCODE='23514';END IF;
 ELSE
  IF j->>'usage' IS DISTINCT FROM p.request->>'usage' OR j->'enabled' IS DISTINCT FROM p.request->'enabled' OR(j->>'version')::bigint IS DISTINCT FROM(p.request->>'version')::bigint+1
  OR(TG_TABLE_NAME='warehouse_inventory_policy_revisions' AND(j->>'id')::uuid IS DISTINCT FROM a.revision_id)
  OR(TG_TABLE_NAME='warehouse_inventory_policies' AND(j->>'revision_id')::uuid IS DISTINCT FROM a.revision_id) THEN RAISE EXCEPTION 'Bieżąca polityka nie odpowiada zgodzie' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='warehouse_inventory_policies' THEN
   -- The upsert fires BEFORE INSERT even when an existing row will enter
   -- ON CONFLICT UPDATE. Its base is the actual pinned policy, not version0.
   bp:=CASE WHEN TG_OP='INSERT' THEN public.warehouse_inventory_policy(NEW.tenant_id,NEW.warehouse_id) ELSE jsonb_build_object('usage',OLD.usage,'enabled',OLD.enabled,'version',OLD.version::text) END;
   IF bp IS DISTINCT FROM a.snapshot->'before' OR(TG_OP='UPDATE' AND(NEW.tenant_id,NEW.warehouse_id) IS DISTINCT FROM(OLD.tenant_id,OLD.warehouse_id)) THEN RAISE EXCEPTION 'Niepoprawna wersja bazowa polityki' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE FUNCTION warehouse_inventory_policy_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.warehouse_inventory_policy_admissions;o public.warehouse_inventory_policy_operations;r public.warehouse_inventory_policy_revisions;p public.warehouse_inventory_policies;pr public.warehouse_inventory_policy_previews;
BEGIN SELECT * INTO a FROM public.warehouse_inventory_policy_admissions WHERE(tenant_id,operation_id)=(NEW.tenant_id,NEW.id) AND txid=pg_current_xact_id();
 SELECT * INTO o FROM public.warehouse_inventory_policy_operations WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id);
 SELECT * INTO r FROM public.warehouse_inventory_policy_revisions WHERE(tenant_id,id)=(o.tenant_id,o.revision_id);
 SELECT * INTO p FROM public.warehouse_inventory_policies WHERE(tenant_id,warehouse_id)=(o.tenant_id,o.warehouse_id);
 SELECT * INTO pr FROM public.warehouse_inventory_policy_previews WHERE(tenant_id,id)=(o.tenant_id,o.preview_id);
 IF a.id IS NULL OR r.id IS NULL OR p.revision_id IS DISTINCT FROM r.id OR p.operation_id IS DISTINCT FROM o.id OR r.operation_id IS DISTINCT FROM o.id
 OR(p.usage,p.enabled,p.version) IS DISTINCT FROM(r.usage,r.enabled,r.version) OR o.before_policy IS DISTINCT FROM a.snapshot->'before'
 OR o.after_policy IS DISTINCT FROM jsonb_build_object('usage',r.usage,'enabled',r.enabled,'version',r.version::text)
 OR EXISTS(SELECT 1 FROM public.warehouses w WHERE(w.tenant_id,w.id)=(o.tenant_id,o.warehouse_id) AND jsonb_build_object('id',w.id,'name',w.name,'code',w.code) IS DISTINCT FROM a.snapshot->'warehouse')
 OR((o.before_policy-'version') IS DISTINCT FROM(o.after_policy-'version') AND jsonb_array_length(public.warehouse_inventory_policy_blockers(o.tenant_id,o.warehouse_id))<>0)
 THEN RAISE EXCEPTION 'Niepełny wynik polityki magazynu' USING ERRCODE='23514';END IF;
 PERFORM public.warehouse_inventory_policy_access(a.actor_id,a.api_key_id,true,false);PERFORM public.warehouse_inventory_policy_budget(a.tenant_id);RETURN NULL;
END $$;
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['warehouse_inventory_policies','warehouse_inventory_policy_revisions','warehouse_inventory_policy_previews','warehouse_inventory_policy_operations','warehouse_inventory_policy_admissions'] LOOP
 EXECUTE format('CREATE TRIGGER warehouse_inventory_policy_record_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION warehouse_inventory_policy_record_guard()',rel);
END LOOP;END $$;
CREATE CONSTRAINT TRIGGER warehouse_inventory_policy_complete AFTER INSERT ON warehouse_inventory_policy_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION warehouse_inventory_policy_complete();

-- Source fences apply even when a caller bypasses the HTTP reservation path.
-- A custody warehouse permits physical intake and genuine warehouse transfers;
-- the deferred decrease proof below requires the actual posted MM journal.
CREATE FUNCTION warehouse_inventory_policy_source_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;t uuid:=(j->>'tenant_id')::uuid;wh uuid:=(j->>'warehouse_id')::uuid;policy jsonb;need_sale boolean:=false;prior_tenant text:=current_setting('app.tenant_id',true);owner_context boolean:=false;
BEGIN
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN('stock','stock_locations','reservations','reservation_locations','wms_layer_positions','wms_reservation_layers','wms_issue_fragments','stock_movements','stock_location_movements')
 AND((to_jsonb(OLD)->>'tenant_id') IS DISTINCT FROM j->>'tenant_id' OR(to_jsonb(OLD)->>'warehouse_id') IS DISTINCT FROM j->>'warehouse_id' OR(to_jsonb(OLD)->>'product_id') IS DISTINCT FROM j->>'product_id') THEN RAISE EXCEPTION 'Tożsamość fizycznego stanu magazynu jest stała' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='warehouses' THEN
  IF TG_OP='INSERT' THEN PERFORM public.warehouse_inventory_policy_require();RETURN NEW;END IF;wh:=(j->>'id')::uuid;
 END IF;
 -- Owner maintenance/fixtures may have no caller GUC; shared app-role writes
 -- must still be bound to their supplied own tenant. Never grant this bridge.
 IF nullif(prior_tenant,'') IS NULL AND current_setting('role')='none' AND session_user='postgres' THEN
  PERFORM set_config('app.tenant_id',t::text,true);owner_context:=true;
 END IF;
 policy:=public.warehouse_inventory_policy_lock(t,wh);
 IF EXISTS(SELECT 1 FROM public.warehouse_inventory_policy_admissions WHERE tenant_id=t AND warehouse_id=wh AND txid=pg_current_xact_id()) THEN RAISE EXCEPTION 'Zatwierdzona polityka magazynu jest zamknięta' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='warehouses' THEN
  IF owner_context THEN PERFORM set_config('app.tenant_id',coalesce(prior_tenant,''),true);END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
 ELSIF TG_TABLE_NAME='orders' THEN need_sale:=TG_OP='INSERT' OR(TG_OP='UPDATE' AND NEW.status IN('new','paid','picking','packed') AND(NEW.status IS DISTINCT FROM OLD.status OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id));
 ELSIF TG_TABLE_NAME='return_cases' THEN need_sale:=TG_OP='INSERT' OR(TG_OP='UPDATE' AND NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id);
 ELSIF TG_TABLE_NAME IN('reservations','reservation_locations','wms_reservation_layers') THEN
  need_sale:=TG_OP<>'DELETE' AND coalesce(j->>'state','active')='active' AND(j->>'quantity')::integer-coalesce((j->>'consumed_quantity')::integer,0)-coalesce((j->>'released_quantity')::integer,0)>0;
 ELSIF TG_TABLE_NAME='stock' THEN need_sale:=TG_OP<>'DELETE' AND NEW.reserved>CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD.reserved END;
 ELSIF TG_TABLE_NAME='wms_layer_positions' THEN need_sale:=TG_OP<>'DELETE' AND NEW.reserved>CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD.reserved END;
 ELSIF TG_TABLE_NAME='stock_movements' THEN need_sale:=TG_OP<>'DELETE' AND NEW.delta<0 AND(NEW.order_id IS NOT NULL OR NEW.kind IN('shipment','issue'));
 ELSIF TG_TABLE_NAME='stock_location_movements' THEN need_sale:=TG_OP<>'DELETE' AND NEW.delta<0 AND NEW.order_id IS NOT NULL;
 ELSIF TG_TABLE_NAME='wms_issue_fragments' THEN need_sale:=TG_OP<>'DELETE';
 END IF;
 IF need_sale AND(policy->>'usage' IS DISTINCT FROM 'sale' OR policy->'enabled' IS DISTINCT FROM 'true'::jsonb) THEN RAISE EXCEPTION 'Magazyn CUSTODY lub wyłączony nie jest źródłem sprzedaży' USING ERRCODE='23514';END IF;
 IF owner_context THEN PERFORM set_config('app.tenant_id',coalesce(prior_tenant,''),true);END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE FUNCTION warehouse_inventory_policy_decrease_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE policy jsonb;n bigint;prior_tenant text:=current_setting('app.tenant_id',true);owner_context boolean:=false;
BEGIN
 IF NEW.on_hand>=OLD.on_hand THEN RETURN NULL;END IF;
 IF nullif(prior_tenant,'') IS NULL AND current_setting('role')='none' AND session_user='postgres' THEN PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);owner_context:=true;END IF;
 policy:=public.warehouse_inventory_policy_lock(NEW.tenant_id,NEW.warehouse_id);
 IF policy->>'usage'='sale' AND policy->'enabled'='true'::jsonb THEN IF owner_context THEN PERFORM set_config('app.tenant_id',coalesce(prior_tenant,''),true);END IF;RETURN NULL;END IF;
 SELECT coalesce(sum(-m.delta),0) INTO n FROM public.stock_movements m JOIN public.warehouse_documents d ON(d.tenant_id,d.id)=(m.tenant_id,m.warehouse_document_id)
 WHERE(m.tenant_id,m.warehouse_id,m.product_id)=(NEW.tenant_id,NEW.warehouse_id,NEW.product_id) AND m.xmin::text=pg_current_xact_id()::text AND m.delta<0 AND m.order_id IS NULL
 AND d.kind='transfer' AND d.status='posted' AND d.warehouse_id=NEW.warehouse_id AND d.xmin::text=pg_current_xact_id()::text
 AND EXISTS(SELECT 1 FROM public.warehouse_document_lines l WHERE(l.tenant_id,l.document_id,l.product_id)=(d.tenant_id,d.id,NEW.product_id) AND l.quantity=-m.delta)
 AND((m.kind='transfer_out' AND EXISTS(SELECT 1 FROM public.stock_movements mi WHERE(mi.tenant_id,mi.warehouse_document_id,mi.warehouse_id,mi.product_id)=(d.tenant_id,d.id,d.destination_id,NEW.product_id) AND mi.kind='transfer_in' AND mi.delta=-m.delta AND mi.order_id IS NULL AND mi.xmin::text=pg_current_xact_id()::text))
 OR(m.kind='wms_transfer' AND EXISTS(
  SELECT 1 FROM public.wms_operations op JOIN public.wms_previews pv ON(pv.tenant_id,pv.id::text)=(op.tenant_id,op.request->>'preview_id')
  WHERE(op.tenant_id,op.warehouse_document_id)=(d.tenant_id,d.id) AND op.kind='transfer' AND op.order_id IS NULL AND op.return_id IS NULL
  AND op.xmin::text=pg_current_xact_id()::text AND pv.kind='transfer' AND pv.ready
  AND op.policy_version=pv.policy_version AND op.actor_id=pv.actor_id AND op.request->>'scope_hash'=pv.scope_hash AND op.request->'confirmed'='true'::jsonb
  AND pv.request->>'warehouse_id'=d.warehouse_id::text AND pv.request->>'destination_warehouse_id'=d.destination_id::text
  AND pv.request->>'product_id'=NEW.product_id::text AND(pv.request->>'quantity')::bigint=-m.delta::bigint
  AND op.result->>'source_warehouse_id'=d.warehouse_id::text AND op.result->>'destination_warehouse_id'=d.destination_id::text
  AND op.result->>'destination_location'=pv.request->>'destination_location'
  AND(SELECT count(*) FROM public.warehouse_document_lines dl WHERE(dl.tenant_id,dl.document_id)=(d.tenant_id,d.id))=1
  AND(SELECT count(*) FROM public.stock_movements sm WHERE(sm.tenant_id,sm.warehouse_document_id)=(d.tenant_id,d.id))=2
  AND EXISTS(SELECT 1 FROM public.stock_movements mi WHERE(mi.tenant_id,mi.warehouse_document_id,mi.warehouse_id,mi.product_id)=(d.tenant_id,d.id,d.destination_id,NEW.product_id) AND mi.kind='wms_transfer' AND mi.delta=-m.delta AND mi.order_id IS NULL AND mi.xmin::text=pg_current_xact_id()::text)
  AND(SELECT count(*) FROM public.stock_location_movements bm WHERE(bm.tenant_id,bm.operation_id)=(op.tenant_id,op.id))=2
  AND EXISTS(SELECT 1 FROM public.stock_location_movements bm WHERE(bm.tenant_id,bm.operation_id,bm.warehouse_id,bm.product_id)=(op.tenant_id,op.id,d.warehouse_id,NEW.product_id) AND bm.location=pv.request->>'location' AND bm.delta=m.delta AND bm.kind='wms_transfer' AND bm.order_id IS NULL AND bm.xmin::text=pg_current_xact_id()::text)
  AND EXISTS(SELECT 1 FROM public.stock_location_movements bm WHERE(bm.tenant_id,bm.operation_id,bm.warehouse_id,bm.product_id)=(op.tenant_id,op.id,d.destination_id,NEW.product_id) AND bm.location=pv.request->>'destination_location' AND bm.delta=-m.delta AND bm.kind='wms_transfer' AND bm.order_id IS NULL AND bm.xmin::text=pg_current_xact_id()::text)
  AND EXISTS(SELECT 1 FROM public.wms_layer_movements lm WHERE(lm.tenant_id,lm.operation_id)=(op.tenant_id,op.id))
  AND NOT EXISTS(SELECT 1 FROM public.wms_layer_movements lm JOIN public.wms_cost_layers cl ON(cl.tenant_id,cl.id,cl.product_id)=(lm.tenant_id,lm.layer_id,lm.product_id)
   WHERE(lm.tenant_id,lm.operation_id)=(op.tenant_id,op.id) AND(lm.kind IS DISTINCT FROM 'transfer' OR lm.product_id IS DISTINCT FROM NEW.product_id
    OR lm.xmin::text IS DISTINCT FROM pg_current_xact_id()::text
    OR NOT((lm.warehouse_id=d.warehouse_id AND lm.location=pv.request->>'location' AND lm.delta<0)
     OR(lm.warehouse_id=d.destination_id AND lm.location=pv.request->>'destination_location' AND lm.delta>0))
    OR lm.value_delta IS DISTINCT FROM CASE WHEN cl.unit_cost_minor IS NULL THEN NULL ELSE lm.delta::numeric*cl.unit_cost_minor END))
  AND(SELECT sum(-lm.delta::bigint) FROM public.wms_layer_movements lm WHERE(lm.tenant_id,lm.operation_id)=(op.tenant_id,op.id) AND lm.delta<0)=-m.delta::bigint
  AND(SELECT sum(lm.delta::bigint) FROM public.wms_layer_movements lm WHERE(lm.tenant_id,lm.operation_id)=(op.tenant_id,op.id) AND lm.delta>0)=-m.delta::bigint
  AND NOT EXISTS(SELECT 1 FROM public.wms_layer_movements lm WHERE(lm.tenant_id,lm.operation_id)=(op.tenant_id,op.id) GROUP BY lm.product_id,lm.layer_id
   HAVING sum(lm.delta::bigint)<>0 OR sum(lm.value_delta::numeric) IS DISTINCT FROM CASE WHEN bool_or(lm.value_delta IS NULL) THEN NULL ELSE 0::numeric END)
 )));
 IF n IS DISTINCT FROM(OLD.on_hand-NEW.on_hand)::bigint THEN RAISE EXCEPTION 'Wyjście z CUSTODY wymaga dokładnego fizycznego transferu' USING ERRCODE='23514';END IF;
 IF owner_context THEN PERFORM set_config('app.tenant_id',coalesce(prior_tenant,''),true);END IF;RETURN NULL;
END $$;
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['warehouses','orders','return_cases','stock','stock_locations','reservations','reservation_locations','stock_movements','stock_location_movements','wms_layer_positions','wms_reservation_layers','wms_issue_fragments','purchase_orders','warehouse_documents'] LOOP
 EXECUTE format('CREATE TRIGGER warehouse_inventory_policy_source_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION warehouse_inventory_policy_source_guard()',rel);
END LOOP;END $$;
CREATE CONSTRAINT TRIGGER warehouse_inventory_policy_decrease_guard AFTER UPDATE ON stock DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION warehouse_inventory_policy_decrease_guard();

CREATE FUNCTION warehouse_inventory_policy_guards() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rel text;fn record;nm text;cols text[];fk record;
BEGIN
 FOREACH rel IN ARRAY ARRAY['warehouse_inventory_policies','warehouse_inventory_policy_revisions','warehouse_inventory_policy_previews','warehouse_inventory_policy_operations','warehouse_inventory_policy_admissions'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.'||rel) AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)=session_user)
  OR EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=to_regclass('public.'||rel) AND a.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid CROSS JOIN LATERAL aclexplode(a.attacl)x WHERE c.oid=to_regclass('public.'||rel) AND x.grantee<>c.relowner)
  OR(SELECT count(*) FROM pg_policy WHERE polrelid=to_regclass('public.'||rel))<>1
  OR NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.'||rel) AND polname='tenant_scope' AND polcmd='*' AND pg_get_expr(polqual,polrelid) LIKE '%app.tenant_id%' AND pg_get_expr(polwithcheck,polrelid) LIKE '%app.tenant_id%')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.'||rel) AND tgname='warehouse_inventory_policy_record_guard' AND tgfoid=to_regprocedure('public.warehouse_inventory_policy_record_guard()') AND tgtype=31 AND tgenabled='O' AND NOT tgisinternal) THEN RETURN false;END IF;
  cols:=CASE rel WHEN 'warehouse_inventory_policies' THEN ARRAY['tenant_id','warehouse_id','version','usage','enabled','revision_id','operation_id']
   WHEN 'warehouse_inventory_policy_revisions' THEN ARRAY['id','tenant_id','warehouse_id','operation_id','version','usage','enabled','created_at']
   WHEN 'warehouse_inventory_policy_previews' THEN ARRAY['id','tenant_id','warehouse_id','actor_id','client_key','request_hash','request','scope_hash','snapshot','created_at','expires_at']
   WHEN 'warehouse_inventory_policy_operations' THEN ARRAY['id','tenant_id','warehouse_id','preview_id','actor_id','client_key','request_hash','request','scope_hash','before_policy','after_policy','revision_id','created_at']
   ELSE ARRAY['id','tenant_id','warehouse_id','preview_id','operation_id','revision_id','actor_id','txid','snapshot'] END;
  IF EXISTS(SELECT 1 FROM unnest(cols)x WHERE NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.'||rel) AND attname=x AND attnotnull AND NOT attisdropped)) THEN RETURN false;END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('public.'||rel) AND c.contype='p' AND c.convalidated
   AND(SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(num,ordinality) JOIN pg_attribute a ON(a.attrelid,a.attnum)=(c.conrelid,k.num))=CASE WHEN rel='warehouse_inventory_policies' THEN 'tenant_id,warehouse_id' ELSE 'id' END) THEN RETURN false;END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_constraint WHERE conrelid=ANY(ARRAY[to_regclass('warehouse_inventory_policies'),to_regclass('warehouse_inventory_policy_revisions'),to_regclass('warehouse_inventory_policy_previews'),to_regclass('warehouse_inventory_policy_operations'),to_regclass('warehouse_inventory_policy_admissions')]) AND contype='f' AND convalidated)<>24 THEN RETURN false;END IF;
 FOR fk IN SELECT * FROM(VALUES
 ('warehouse_inventory_policy_previews','tenant_id','tenants','id',false),('warehouse_inventory_policy_previews','actor_id','users','id',false),
 ('warehouse_inventory_policy_previews','tenant_id,warehouse_id','warehouses','tenant_id,id',false),('warehouse_inventory_policy_previews','tenant_id,api_key_id','api_keys','tenant_id,id',false),
 ('warehouse_inventory_policy_operations','tenant_id','tenants','id',false),('warehouse_inventory_policy_operations','actor_id','users','id',false),
 ('warehouse_inventory_policy_operations','tenant_id,warehouse_id','warehouses','tenant_id,id',false),('warehouse_inventory_policy_operations','tenant_id,api_key_id','api_keys','tenant_id,id',false),
 ('warehouse_inventory_policy_operations','tenant_id,preview_id,warehouse_id','warehouse_inventory_policy_previews','tenant_id,id,warehouse_id',false),
 ('warehouse_inventory_policy_operations','tenant_id,revision_id,warehouse_id','warehouse_inventory_policy_revisions','tenant_id,id,warehouse_id',true),
 ('warehouse_inventory_policy_revisions','tenant_id','tenants','id',false),('warehouse_inventory_policy_revisions','tenant_id,warehouse_id','warehouses','tenant_id,id',false),
 ('warehouse_inventory_policy_revisions','tenant_id,operation_id,warehouse_id','warehouse_inventory_policy_operations','tenant_id,id,warehouse_id',true),
 ('warehouse_inventory_policies','tenant_id','tenants','id',false),('warehouse_inventory_policies','tenant_id,warehouse_id','warehouses','tenant_id,id',false),
 ('warehouse_inventory_policies','tenant_id,revision_id,warehouse_id,version','warehouse_inventory_policy_revisions','tenant_id,id,warehouse_id,version',true),
 ('warehouse_inventory_policies','tenant_id,operation_id,warehouse_id','warehouse_inventory_policy_operations','tenant_id,id,warehouse_id',true),
 ('warehouse_inventory_policy_admissions','tenant_id','tenants','id',false),('warehouse_inventory_policy_admissions','actor_id','users','id',false),
 ('warehouse_inventory_policy_admissions','tenant_id,warehouse_id','warehouses','tenant_id,id',false),('warehouse_inventory_policy_admissions','tenant_id,api_key_id','api_keys','tenant_id,id',false),
 ('warehouse_inventory_policy_admissions','tenant_id,preview_id,warehouse_id','warehouse_inventory_policy_previews','tenant_id,id,warehouse_id',false),
 ('warehouse_inventory_policy_admissions','tenant_id,operation_id,warehouse_id','warehouse_inventory_policy_operations','tenant_id,id,warehouse_id',true),
 ('warehouse_inventory_policy_admissions','tenant_id,revision_id,warehouse_id','warehouse_inventory_policy_revisions','tenant_id,id,warehouse_id',true)
 ) manifest(source_table,source_columns,target_table,target_columns,deferred) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.contype='f' AND c.conrelid=to_regclass('public.'||fk.source_table) AND c.confrelid=to_regclass('public.'||fk.target_table)
  AND c.convalidated AND c.condeferrable=fk.deferred AND c.condeferred=fk.deferred
  AND(SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(num,ordinality) JOIN pg_attribute a ON(a.attrelid,a.attnum)=(c.conrelid,k.num))=fk.source_columns
  AND(SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.confkey) WITH ORDINALITY k(num,ordinality) JOIN pg_attribute a ON(a.attrelid,a.attnum)=(c.confrelid,k.num))=fk.target_columns) THEN RETURN false;END IF;
 END LOOP;
 FOREACH rel IN ARRAY ARRAY['warehouses','orders','return_cases','stock','stock_locations','reservations','reservation_locations','stock_movements','stock_location_movements','wms_layer_positions','wms_reservation_layers','wms_issue_fragments','purchase_orders','warehouse_documents'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.'||rel) AND tgname='warehouse_inventory_policy_source_guard' AND tgfoid=to_regprocedure('public.warehouse_inventory_policy_source_guard()') AND tgtype=31 AND tgenabled='O' AND NOT tgisinternal) THEN RETURN false;END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.stock'::regclass AND tgname='warehouse_inventory_policy_decrease_guard' AND tgfoid=to_regprocedure('public.warehouse_inventory_policy_decrease_guard()') AND tgtype=17 AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.warehouse_inventory_policy_operations'::regclass AND tgname='warehouse_inventory_policy_complete' AND tgfoid=to_regprocedure('public.warehouse_inventory_policy_complete()') AND tgtype=5 AND tgenabled='O' AND tgdeferrable AND tginitdeferred) THEN RETURN false;END IF;
 FOREACH nm IN ARRAY ARRAY['installed()','hash(jsonb)','require()','lock(uuid,uuid)','access(uuid,uuid,boolean,boolean)','blockers(uuid,uuid)','frame(uuid,uuid,jsonb)','budget(uuid)','request_valid(jsonb,boolean)','preview(uuid,uuid,uuid,jsonb)','commit(uuid,uuid,uuid,jsonb)','record_guard()','complete()','source_guard()','decrease_guard()','guards()'] LOOP
  SELECT p.* INTO fn FROM pg_proc p WHERE p.oid=to_regprocedure('public.warehouse_inventory_policy_'||nm);
  IF fn.oid IS NULL OR pg_get_userbyid(fn.proowner)<>session_user OR(nm NOT IN('installed()','hash(jsonb)','request_valid(jsonb,boolean)') AND NOT fn.prosecdef)
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(fn.proacl,acldefault('f',fn.proowner)))a WHERE a.grantee<>fn.proowner) THEN RETURN false;END IF;
 END LOOP;
 SELECT p.* INTO fn FROM pg_proc p WHERE p.oid=to_regprocedure('public.warehouse_inventory_policy(uuid,uuid)');
 IF fn.oid IS NULL OR NOT fn.prosecdef OR pg_get_userbyid(fn.proowner)<>session_user
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(fn.proacl,acldefault('f',fn.proowner)))a WHERE a.grantee<>fn.proowner AND(a.grantee IS DISTINCT FROM(SELECT oid FROM pg_roles WHERE rolname='dyna_app') OR a.privilege_type<>'EXECUTE' OR a.is_grantable))
 OR NOT has_function_privilege('dyna_app',fn.oid,'EXECUTE') THEN RETURN false;END IF;
 RETURN true;
END $$;
CREATE FUNCTION warehouse_inventory_policy_lock(t uuid,wh uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.warehouse_inventory_policy_require();
 IF t IS NULL OR t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Obca firma polityki magazynu' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog:'||t::text,0));
 PERFORM 1 FROM public.warehouses WHERE(tenant_id,id)=(t,wh) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Nie znaleziono własnego magazynu' USING ERRCODE='P0002';END IF;
 PERFORM 1 FROM public.warehouse_inventory_policies WHERE(tenant_id,warehouse_id)=(t,wh) FOR SHARE;
 RETURN public.warehouse_inventory_policy(t,wh);
END $$;
CREATE FUNCTION warehouse_inventory_policy_access(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r text;k public.api_keys;manage boolean;
BEGIN PERFORM public.warehouse_inventory_policy_require();
 IF pin THEN SELECT role INTO r FROM public.memberships WHERE(tenant_id,user_id)=(t,uid) FOR SHARE;ELSE SELECT role INTO r FROM public.memberships WHERE(tenant_id,user_id)=(t,uid);END IF;
 IF r IS NULL THEN RAISE EXCEPTION 'Brak dostępu do polityki magazynów' USING ERRCODE='42501';END IF;
 IF kid IS NOT NULL THEN
  IF pin THEN SELECT * INTO k FROM public.api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid) FOR SHARE;ELSE SELECT * INTO k FROM public.api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid);END IF;
  IF k.id IS NULL OR k.revoked_at IS NOT NULL OR(k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Klucz polityki magazynów jest nieaktualny' USING ERRCODE='28000';END IF;
  IF NOT k.scopes @> ARRAY['inventory:read']::text[] THEN RAISE EXCEPTION 'Brak dostępu do polityki magazynów' USING ERRCODE='42501';END IF;
 END IF;
 manage:=r='admin' AND(kid IS NULL OR k.scopes @> ARRAY['inventory:write']::text[]);
 IF writing AND NOT manage THEN RAISE EXCEPTION 'Wymagana aktualna rola administratora magazynu' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('current_role',r,'can_manage',manage);
END $$;
CREATE FUNCTION warehouse_inventory_policy_blockers(t uuid,wh uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b jsonb:='[]';
BEGIN
 IF EXISTS(SELECT 1 FROM public.stock WHERE tenant_id=t AND warehouse_id=wh AND(on_hand<>0 OR reserved<>0)) THEN b:=b||'"STOCK_NOT_EMPTY"'::jsonb;END IF;
 IF EXISTS(SELECT 1 FROM public.stock_locations WHERE tenant_id=t AND warehouse_id=wh AND quantity<>0) THEN b:=b||'"BINS_NOT_EMPTY"'::jsonb;END IF;
 IF EXISTS(SELECT 1 FROM public.wms_layer_positions WHERE tenant_id=t AND warehouse_id=wh AND(quantity<>0 OR reserved<>0)) THEN b:=b||'"WMS_NOT_EMPTY"'::jsonb;END IF;
 IF EXISTS(SELECT 1 FROM public.reservations WHERE tenant_id=t AND warehouse_id=wh AND state='active' AND quantity-consumed_quantity-released_quantity>0) THEN b:=b||'"ACTIVE_RESERVATIONS"'::jsonb;END IF;
 IF EXISTS(SELECT 1 FROM public.orders WHERE tenant_id=t AND warehouse_id=wh AND status IN('new','paid','picking','packed')) THEN b:=b||'"PENDING_ORDERS"'::jsonb;END IF;
 IF EXISTS(SELECT 1 FROM public.return_cases WHERE tenant_id=t AND warehouse_id=wh AND state='requested') THEN b:=b||'"PENDING_RETURNS"'::jsonb;END IF;
 IF EXISTS(SELECT 1 FROM public.purchase_orders WHERE tenant_id=t AND warehouse_id=wh AND state IN('draft','ordered','partial')) THEN b:=b||'"OPEN_PURCHASES"'::jsonb;END IF;
 IF EXISTS(SELECT 1 FROM public.warehouse_documents WHERE tenant_id=t AND(warehouse_id=wh OR destination_id=wh) AND status='draft') THEN b:=b||'"DRAFT_DOCUMENTS"'::jsonb;END IF;
 RETURN b;
END $$;
CREATE FUNCTION warehouse_inventory_policy_frame(t uuid,wh uuid,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p jsonb;w public.warehouses;blockers jsonb;
BEGIN p:=public.warehouse_inventory_policy(t,wh);SELECT * INTO w FROM public.warehouses WHERE(tenant_id,id)=(t,wh);
 IF b->>'version' IS DISTINCT FROM p->>'version' THEN RAISE EXCEPTION 'Polityka magazynu zmieniła się' USING ERRCODE='23514';END IF;
 blockers:=CASE WHEN b->>'usage' IS DISTINCT FROM p->>'usage' OR b->'enabled' IS DISTINCT FROM p->'enabled' THEN public.warehouse_inventory_policy_blockers(t,wh) ELSE '[]'::jsonb END;
 RETURN jsonb_build_object('warehouse',jsonb_build_object('id',w.id,'name',w.name,'code',w.code),'before',p,'after',jsonb_build_object('usage',b->>'usage','enabled',b->'enabled'),'blockers',blockers);
END $$;
CREATE FUNCTION warehouse_inventory_policy_budget(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n bigint;m bigint;bytes bigint;
BEGIN SELECT count(*) INTO n FROM public.warehouse_inventory_policy_previews WHERE tenant_id=t;SELECT count(*) INTO m FROM public.warehouse_inventory_policy_operations WHERE tenant_id=t;
 SELECT coalesce(sum(octet_length(j::text)),0) INTO bytes FROM(
 SELECT to_jsonb(x) j FROM public.warehouse_inventory_policies x WHERE tenant_id=t UNION ALL SELECT to_jsonb(x) FROM public.warehouse_inventory_policy_previews x WHERE tenant_id=t
 UNION ALL SELECT to_jsonb(x) FROM public.warehouse_inventory_policy_revisions x WHERE tenant_id=t UNION ALL SELECT to_jsonb(x) FROM public.warehouse_inventory_policy_operations x WHERE tenant_id=t
 UNION ALL SELECT to_jsonb(x) FROM public.warehouse_inventory_policy_admissions x WHERE tenant_id=t)x;
 IF n>2000 OR m>2000 OR bytes>67108864 THEN RAISE EXCEPTION 'Limit historii polityki magazynów' USING ERRCODE='54000';END IF;
END $$;
CREATE FUNCTION warehouse_inventory_policy_request_valid(b jsonb,commit boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE ks text[];
BEGIN IF jsonb_typeof(b) IS DISTINCT FROM 'object' THEN RETURN false;END IF;ks:=CASE WHEN commit THEN ARRAY['client_key','scope_hash','confirmed'] ELSE ARRAY['client_key','version','usage','enabled'] END;
 IF NOT b ?& ks OR EXISTS(SELECT 1 FROM jsonb_object_keys(b)x WHERE NOT x=ANY(ks)) OR jsonb_typeof(b->'client_key') IS DISTINCT FROM 'string' OR coalesce(b->>'client_key','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false;END IF;
 IF commit THEN RETURN jsonb_typeof(b->'scope_hash') IS NOT DISTINCT FROM 'string' AND coalesce(b->>'scope_hash','') ~ '^[a-f0-9]{64}$' AND b->'confirmed' IS NOT DISTINCT FROM 'true'::jsonb;END IF;
 IF jsonb_typeof(b->'version') IS DISTINCT FROM 'string' OR coalesce(b->>'version','') !~ '^(0|[1-9][0-9]{0,18})$' THEN RETURN false;END IF;
 RETURN (b->>'version')::numeric<9223372036854775807 AND jsonb_typeof(b->'usage') IS NOT DISTINCT FROM 'string' AND coalesce(b->>'usage','') IN('sale','custody') AND jsonb_typeof(b->'enabled') IS NOT DISTINCT FROM 'boolean';
END $$;
CREATE FUNCTION warehouse_inventory_policy_preview(uid uuid,kid uuid,wh uuid,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p public.warehouse_inventory_policy_previews;rh text;f jsonb;stamp timestamptz:=clock_timestamp();
BEGIN PERFORM public.warehouse_inventory_policy_access(uid,kid,true,false);
 IF NOT public.warehouse_inventory_policy_request_valid(b,false) THEN RAISE EXCEPTION 'Niepoprawny podgląd polityki' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('warehouse.inventory.policy.quota:'||t::text,0));
 PERFORM public.warehouse_inventory_policy_lock(t,wh);
 PERFORM public.warehouse_inventory_policy_access(uid,kid,true,false);
 rh:=public.warehouse_inventory_policy_hash(jsonb_build_object('actor',uid,'key',kid,'warehouse',wh,'request',b));
 SELECT * INTO p FROM public.warehouse_inventory_policy_previews WHERE(tenant_id,actor_id,client_key)=(t,uid,(b->>'client_key')::uuid);
 IF p.id IS NOT NULL THEN IF p.request_hash IS DISTINCT FROM rh OR p.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'Klucz podglądu ma inną treść' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('preview',to_jsonb(p),'reused',true);END IF;
 f:=public.warehouse_inventory_policy_frame(t,wh,b);
 INSERT INTO public.warehouse_inventory_policy_previews(id,tenant_id,warehouse_id,actor_id,api_key_id,client_key,request_hash,request,scope_hash,snapshot,created_at,expires_at)
 VALUES(gen_random_uuid(),t,wh,uid,kid,(b->>'client_key')::uuid,rh,b,public.warehouse_inventory_policy_hash(f),f,stamp,stamp+interval '900 seconds') RETURNING * INTO p;
 PERFORM public.warehouse_inventory_policy_budget(t);RETURN jsonb_build_object('preview',to_jsonb(p),'reused',false);
END $$;
CREATE FUNCTION warehouse_inventory_policy_commit(uid uuid,kid uuid,pid uuid,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p public.warehouse_inventory_policy_previews;o public.warehouse_inventory_policy_operations;rh text;f jsonb;after_doc jsonb;oid uuid:=gen_random_uuid();rid uuid:=gen_random_uuid();v bigint;
BEGIN PERFORM public.warehouse_inventory_policy_access(uid,kid,true,false);
 IF NOT public.warehouse_inventory_policy_request_valid(b,true) THEN RAISE EXCEPTION 'Niepoprawna zgoda polityki' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('warehouse.inventory.policy.quota:'||t::text,0));
 SELECT * INTO p FROM public.warehouse_inventory_policy_previews WHERE(tenant_id,id)=(t,pid);
 IF p.id IS NULL THEN RAISE EXCEPTION 'Brak podglądu polityki' USING ERRCODE='P0002';END IF;
 IF p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'Podgląd należy do innego wykonawcy' USING ERRCODE='23514';END IF;
 rh:=public.warehouse_inventory_policy_hash(jsonb_build_object('actor',uid,'key',kid,'preview',pid,'request',b));
 SELECT * INTO o FROM public.warehouse_inventory_policy_operations WHERE(tenant_id,actor_id,client_key)=(t,uid,(b->>'client_key')::uuid);
 IF o.id IS NOT NULL THEN IF o.request_hash IS DISTINCT FROM rh OR o.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'Klucz zgody ma inną treść' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('operation',to_jsonb(o),'reused',true);END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog:'||t::text,0));
 PERFORM 1 FROM public.warehouses WHERE(tenant_id,id)=(t,p.warehouse_id) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Brak magazynu polityki' USING ERRCODE='P0002';END IF;
 PERFORM 1 FROM public.warehouse_inventory_policies WHERE(tenant_id,warehouse_id)=(t,p.warehouse_id) FOR UPDATE;
 PERFORM public.warehouse_inventory_policy_access(uid,kid,true,false);
 IF p.expires_at<=clock_timestamp() OR b->>'scope_hash' IS DISTINCT FROM p.scope_hash OR EXISTS(SELECT 1 FROM public.warehouse_inventory_policy_operations WHERE(tenant_id,preview_id)=(t,pid)) THEN RAISE EXCEPTION 'Podgląd polityki wygasł lub wykonano zgodę' USING ERRCODE='23514';END IF;
 f:=public.warehouse_inventory_policy_frame(t,p.warehouse_id,p.request);
 IF f IS DISTINCT FROM p.snapshot OR jsonb_array_length(f->'blockers')<>0 THEN RAISE EXCEPTION 'Magazyn zmienił się lub nie jest pusty' USING ERRCODE='23514';END IF;
 v:=(f->'before'->>'version')::bigint+1;after_doc:=jsonb_build_object('usage',p.request->>'usage','enabled',p.request->'enabled','version',v::text);
 INSERT INTO public.warehouse_inventory_policy_admissions(id,tenant_id,warehouse_id,preview_id,operation_id,revision_id,actor_id,api_key_id,snapshot) VALUES(gen_random_uuid(),t,p.warehouse_id,pid,oid,rid,uid,kid,f);
 INSERT INTO public.warehouse_inventory_policy_revisions(id,tenant_id,warehouse_id,operation_id,version,usage,enabled) VALUES(rid,t,p.warehouse_id,oid,v,p.request->>'usage',(p.request->>'enabled')::boolean);
 INSERT INTO public.warehouse_inventory_policies(tenant_id,warehouse_id,version,usage,enabled,revision_id,operation_id) VALUES(t,p.warehouse_id,v,p.request->>'usage',(p.request->>'enabled')::boolean,rid,oid)
 ON CONFLICT(tenant_id,warehouse_id) DO UPDATE SET version=EXCLUDED.version,usage=EXCLUDED.usage,enabled=EXCLUDED.enabled,revision_id=EXCLUDED.revision_id,operation_id=EXCLUDED.operation_id;
 INSERT INTO public.warehouse_inventory_policy_operations(id,tenant_id,warehouse_id,preview_id,actor_id,api_key_id,client_key,request_hash,request,scope_hash,before_policy,after_policy,revision_id)
 VALUES(oid,t,p.warehouse_id,pid,uid,kid,(b->>'client_key')::uuid,rh,b,p.scope_hash,f->'before',after_doc,rid) RETURNING * INTO o;
 PERFORM public.warehouse_inventory_policy_budget(t);RETURN jsonb_build_object('operation',to_jsonb(o),'reused',false);
END $$;
DO $$DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure id FROM pg_proc WHERE pronamespace='public'::regnamespace AND(proname LIKE 'warehouse_inventory_policy_%' OR proname='warehouse_inventory_policy') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.id);
END LOOP;END $$;
GRANT EXECUTE ON FUNCTION warehouse_inventory_policy(uuid,uuid) TO dyna_app;
