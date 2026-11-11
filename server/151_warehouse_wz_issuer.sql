-- Additive automatic physical-dispatch documents. No physical UPDATE and no
-- historical backfill. Incoming FK RI triggers do not enter manifest150.
CREATE TABLE warehouse_wz_issuer_admissions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,order_id uuid NOT NULL,shipment_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 source jsonb NOT NULL,frame jsonb NOT NULL,before_snapshot jsonb NOT NULL,after_snapshot jsonb,
 physical jsonb,sealed boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,order_id,shipment_id),UNIQUE(tenant_id,shipment_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,shipment_id) REFERENCES shipments(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE warehouse_wz_issuer_receipts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,shipment_id uuid NOT NULL,
 source jsonb NOT NULL,physical jsonb NOT NULL,commercial_lines jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,shipment_id),
 FOREIGN KEY(tenant_id,id,order_id,shipment_id) REFERENCES warehouse_wz_issuer_admissions(tenant_id,id,order_id,shipment_id)
);
CREATE TABLE warehouse_wz_issuer_counters (
 tenant_id uuid NOT NULL,warehouse_id uuid NOT NULL,series_id uuid NOT NULL,year integer NOT NULL CHECK(year BETWEEN 2000 AND 9999),
 sequence bigint NOT NULL CHECK(sequence>=0),PRIMARY KEY(tenant_id,series_id,year),UNIQUE(tenant_id,warehouse_id,year),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouse_automatic_wz_configurations(tenant_id,warehouse_id)
);
CREATE TABLE warehouse_wz_issuer_documents (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,receipt_id uuid NOT NULL,shipment_id uuid NOT NULL,warehouse_id uuid NOT NULL,
 revision_id uuid NOT NULL,series_id uuid NOT NULL,year integer NOT NULL,sequence bigint NOT NULL CHECK(sequence>0),
 number text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,shipment_id,warehouse_id),UNIQUE(tenant_id,series_id,year,sequence),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES warehouse_wz_issuer_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,shipment_id) REFERENCES shipments(tenant_id,id),
 FOREIGN KEY(tenant_id,revision_id,warehouse_id) REFERENCES warehouse_automatic_wz_revisions(tenant_id,id,warehouse_id)
);
CREATE TABLE warehouse_wz_issuer_rows (
 tenant_id uuid NOT NULL,document_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal>=0),
 product_id uuid NOT NULL,stock_movement_id uuid NOT NULL,location_movement_id uuid NOT NULL,
 operation_id uuid,issue_fragment_id uuid,layer_movement_id uuid,layer_id uuid,lot_id uuid,payload jsonb NOT NULL,
 PRIMARY KEY(tenant_id,document_id,ordinal),
 FOREIGN KEY(tenant_id,document_id) REFERENCES warehouse_wz_issuer_documents(tenant_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 FOREIGN KEY(tenant_id,stock_movement_id) REFERENCES stock_movements(tenant_id,id),
 FOREIGN KEY(tenant_id,location_movement_id) REFERENCES stock_location_movements(tenant_id,id),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES wms_operations(tenant_id,id),
 FOREIGN KEY(tenant_id,issue_fragment_id) REFERENCES wms_issue_fragments(tenant_id,id),
 FOREIGN KEY(tenant_id,layer_movement_id) REFERENCES wms_layer_movements(tenant_id,id),
 FOREIGN KEY(tenant_id,layer_id,product_id,lot_id) REFERENCES wms_cost_layers(tenant_id,id,product_id,lot_id),
 CHECK((operation_id IS NULL AND issue_fragment_id IS NULL AND layer_movement_id IS NULL AND layer_id IS NULL AND lot_id IS NULL)
 OR(operation_id IS NOT NULL AND issue_fragment_id IS NOT NULL AND layer_movement_id IS NOT NULL AND layer_id IS NOT NULL AND lot_id IS NOT NULL))
);
CREATE TABLE warehouse_wz_issuer_manifest(singleton boolean PRIMARY KEY CHECK(singleton),fingerprint text NOT NULL);
CREATE INDEX warehouse_wz_issuer_admission_actor ON warehouse_wz_issuer_admissions(actor_id);
CREATE INDEX warehouse_wz_issuer_admission_key ON warehouse_wz_issuer_admissions(tenant_id,api_key_id);
CREATE INDEX warehouse_wz_issuer_admission_order ON warehouse_wz_issuer_admissions(tenant_id,order_id);
CREATE INDEX warehouse_wz_issuer_document_page ON warehouse_wz_issuer_documents(tenant_id,created_at DESC,id DESC);
CREATE INDEX warehouse_wz_issuer_document_receipt ON warehouse_wz_issuer_documents(tenant_id,receipt_id);
CREATE INDEX warehouse_wz_issuer_document_revision ON warehouse_wz_issuer_documents(tenant_id,revision_id,warehouse_id);
CREATE INDEX warehouse_wz_issuer_row_product ON warehouse_wz_issuer_rows(tenant_id,product_id);
CREATE INDEX warehouse_wz_issuer_row_stock ON warehouse_wz_issuer_rows(tenant_id,stock_movement_id);
CREATE INDEX warehouse_wz_issuer_row_bin ON warehouse_wz_issuer_rows(tenant_id,location_movement_id);
CREATE INDEX warehouse_wz_issuer_row_op ON warehouse_wz_issuer_rows(tenant_id,operation_id);
CREATE INDEX warehouse_wz_issuer_row_fragment ON warehouse_wz_issuer_rows(tenant_id,issue_fragment_id);
CREATE INDEX warehouse_wz_issuer_row_layer_journal ON warehouse_wz_issuer_rows(tenant_id,layer_movement_id);
CREATE INDEX warehouse_wz_issuer_row_layer ON warehouse_wz_issuer_rows(tenant_id,layer_id,product_id,lot_id);
DO $$DECLARE rel text;BEGIN
 FOREACH rel IN ARRAY ARRAY['admissions','receipts','counters','documents','rows','manifest'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY','warehouse_wz_issuer_'||rel);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY','warehouse_wz_issuer_'||rel);
  IF rel<>'manifest' THEN EXECUTE format('CREATE POLICY tenant_scope ON public.%I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)','warehouse_wz_issuer_'||rel);END IF;
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app','warehouse_wz_issuer_'||rel);
 END LOOP;
END $$;

CREATE FUNCTION warehouse_wz_issuer_commercial(lines jsonb,effects jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE lefts jsonb:='{}';result jsonb:='[]';l jsonb;c jsonb;f jsonb;alloc jsonb;need bigint;take bigint;BEGIN
 FOR f IN SELECT value FROM jsonb_array_elements(effects) LOOP
  IF lefts ? (f->>'physical_id') THEN RAISE EXCEPTION 'Powtórzony fragment manifestu WZ' USING ERRCODE='23514';END IF;
  lefts:=lefts||jsonb_build_object(f->>'physical_id',(f->>'quantity')::bigint);
 END LOOP;
 FOR l IN SELECT value FROM jsonb_array_elements(lines) ORDER BY value->>'item_id' LOOP
  alloc:='[]';
  FOR c IN SELECT value FROM jsonb_array_elements(l->'components') ORDER BY value->>'product_id' LOOP
   need:=(l->>'quantity')::bigint*(c->>'quantity')::bigint;
   IF need<1 OR need>1000000000 THEN RAISE EXCEPTION 'Niepoprawna receptura WZ' USING ERRCODE='23514';END IF;
   FOR f IN SELECT value FROM jsonb_array_elements(effects) WHERE value->>'product_id'=c->>'product_id' ORDER BY value->>'physical_id' LOOP
    take:=least(need,(lefts->> (f->>'physical_id'))::bigint);
    IF take>0 THEN
     alloc:=alloc||jsonb_build_array(jsonb_build_object('physical_id',f->>'physical_id','product_id',c->>'product_id','warehouse_id',f->>'warehouse_id','quantity',take));
     lefts:=jsonb_set(lefts,ARRAY[f->>'physical_id'],to_jsonb((lefts->>(f->>'physical_id'))::bigint-take));need:=need-take;
    END IF;
    EXIT WHEN need=0;
   END LOOP;
   IF need<>0 THEN RAISE EXCEPTION 'Fragmenty nie pokrywają pozycji komercyjnej WZ' USING ERRCODE='23514';END IF;
  END LOOP;
  result:=result||jsonb_build_array(l||jsonb_build_object('allocations',alloc));
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_each_text(lefts) WHERE value::bigint<>0) THEN RAISE EXCEPTION 'Nadmiarowy fragment komercyjnego WZ' USING ERRCODE='23514';END IF;
 RETURN result;
END $$;

CREATE FUNCTION warehouse_wz_issuer_effects(eid uuid,physical jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.warehouse_wz_issuer_admissions;t uuid:=current_setting('app.tenant_id')::uuid;actual jsonb;expected jsonb;result jsonb;sn jsonb;p jsonb;b jsonb;n bigint;k text;BEGIN
 SELECT * INTO a FROM public.warehouse_wz_issuer_admissions WHERE tenant_id=t AND id=eid;
 IF a.id IS NULL OR a.txid<>pg_current_xact_id() THEN RAISE EXCEPTION 'Brak bieżącego zakresu fizycznego WZ' USING ERRCODE='23514';END IF;
 sn:=public.warehouse_wz_issuer_snapshot(t,a.order_id);
 IF sn->'items' IS DISTINCT FROM a.before_snapshot->'items' OR(sn->'order')-ARRAY['status','version','updated_at'] IS DISTINCT FROM(a.before_snapshot->'order')-ARRAY['status','version','updated_at'] THEN RAISE EXCEPTION 'Historyczne zamówienie WZ zmieniło się' USING ERRCODE='23514';END IF;
 FOREACH k IN ARRAY ARRAY['stock_journals','bin_journals','fragments','operations','layer_journals'] LOOP
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(a.before_snapshot->k) old WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sn->k) now WHERE now=old)) THEN RAISE EXCEPTION 'Historia rozchodu WZ zmieniła się' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.stock_movements s WHERE s.tenant_id=t AND s.order_id=a.order_id AND s.kind<>'shipment' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.before_snapshot->'stock_journals') j WHERE j->>'id'=s.id::text)) THEN RAISE EXCEPTION 'Nadmiarowy journal źródła WZ' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'product_id',s.product_id,'warehouse_id',s.warehouse_id,'quantity',-s.delta) ORDER BY s.id),'[]') INTO actual FROM public.stock_movements s WHERE s.tenant_id=t AND s.order_id=a.order_id AND s.kind='shipment' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.before_snapshot->'stock_journals') j WHERE j->>'id'=s.id::text);
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'id'),'[]') INTO expected FROM jsonb_array_elements(physical->'stock_movements');
 IF actual IS DISTINCT FROM expected OR jsonb_array_length(actual)<>jsonb_array_length(a.frame->'products') THEN RAISE EXCEPTION 'Niepełne rzeczywiste ruchy WZ' USING ERRCODE='23514';END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(a.frame->'products') LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(actual) m WHERE(m->>'product_id',m->>'warehouse_id',m->'quantity')=(p->>'product_id',p->>'warehouse_id',p->'quantity')) THEN RAISE EXCEPTION 'Ruch nie odpowiada produktowi WZ' USING ERRCODE='23514';END IF;
  SELECT value INTO b FROM jsonb_array_elements(a.before_snapshot->'stock') WHERE value->>'warehouse_id'=p->>'warehouse_id' AND value->>'product_id'=p->>'product_id';
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sn->'stock') s WHERE(s->>'warehouse_id',s->>'product_id')=(p->>'warehouse_id',p->>'product_id') AND
    (s->>'on_hand')::bigint=(b->>'on_hand')::bigint-(p->>'quantity')::bigint AND(s->>'reserved')::bigint=(b->>'reserved')::bigint-(p->>'quantity')::bigint
    AND s-ARRAY['on_hand','reserved','version'] IS NOT DISTINCT FROM b-ARRAY['on_hand','reserved','version']) THEN RAISE EXCEPTION 'Stan nie odpowiada pojedynczemu rozchodowi WZ' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.stock_location_movements s WHERE s.tenant_id=t AND s.order_id=a.order_id AND s.kind<>'shipment' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.before_snapshot->'bin_journals') j WHERE j->>'id'=s.id::text)) THEN RAISE EXCEPTION 'Nadmiarowy journal lokalizacji WZ' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'product_id',s.product_id,'warehouse_id',s.warehouse_id,'location',s.location,'quantity',-s.delta) ORDER BY s.id),'[]') INTO actual FROM public.stock_location_movements s WHERE s.tenant_id=t AND s.order_id=a.order_id AND s.kind='shipment' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.before_snapshot->'bin_journals') j WHERE j->>'id'=s.id::text);
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'id'),'[]') INTO expected FROM jsonb_array_elements(physical->'location_movements');
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Niepełne rzeczywiste lokalizacje WZ' USING ERRCODE='23514';END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(a.frame->'products') LOOP
  IF (SELECT sum((m->>'quantity')::bigint) FROM jsonb_array_elements(actual) m WHERE(m->>'product_id',m->>'warehouse_id')=(p->>'product_id',p->>'warehouse_id')) IS DISTINCT FROM(p->>'quantity')::bigint THEN RAISE EXCEPTION 'Lokalizacje nie pokrywają WZ' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR p IN SELECT value FROM jsonb_array_elements(actual) LOOP
  SELECT value INTO b FROM jsonb_array_elements(a.before_snapshot->'locations') WHERE(value->>'warehouse_id',value->>'product_id',value->>'location')=(p->>'warehouse_id',p->>'product_id',p->>'location');
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sn->'locations') s WHERE(s->>'warehouse_id',s->>'product_id',s->>'location')=(p->>'warehouse_id',p->>'product_id',p->>'location') AND(s->>'quantity')::bigint=(b->>'quantity')::bigint-(p->>'quantity')::bigint AND s-ARRAY['quantity','version'] IS NOT DISTINCT FROM b-ARRAY['quantity','version']) THEN RAISE EXCEPTION 'Stan lokalizacji nie odpowiada WZ' USING ERRCODE='23514';END IF;
 END LOOP;
 IF a.frame->'policy' IS NOT NULL AND a.frame->'policy'<>'null'::jsonb THEN
  SELECT coalesce(jsonb_agg(f.id::text ORDER BY f.id),'[]') INTO actual FROM public.wms_issue_fragments f WHERE f.tenant_id=t AND f.order_id=a.order_id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.before_snapshot->'fragments') j WHERE j->>'id'=f.id::text);
  SELECT coalesce(jsonb_agg(f ORDER BY f#>>'{}'),'[]') INTO expected FROM jsonb_array_elements(physical->'wms') o CROSS JOIN LATERAL jsonb_array_elements(o->'fragment_ids') f;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Niepełne własne fragmenty WZ' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(m.id::text ORDER BY m.id),'[]') INTO actual FROM public.wms_layer_movements m JOIN public.wms_operations o ON(o.tenant_id,o.id)=(m.tenant_id,m.operation_id) WHERE o.tenant_id=t AND o.order_id=a.order_id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.before_snapshot->'layer_journals') j WHERE j->>'id'=m.id::text);
  SELECT coalesce(jsonb_agg(f ORDER BY f#>>'{}'),'[]') INTO expected FROM jsonb_array_elements(physical->'wms') o CROSS JOIN LATERAL jsonb_array_elements(o->'layer_movement_ids') f;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Niepełne własne ruchy warstw WZ' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('physical_id',f.id,'product_id',f.product_id,'warehouse_id',f.warehouse_id,'location',f.location,'quantity',f.quantity,
   'stock_movement_id',sm.id,'location_movement_id',bm.id,'operation_id',f.operation_id,'issue_fragment_id',f.id,'layer_movement_id',lm.id,'layer_id',f.layer_id,'lot_id',l.lot_id,
   'sku',p.sku,'name',p.name,'unit_cost_minor',f.unit_cost_minor::text,'value_minor',f.value_minor::text,'currency',f.currency,'exponent',l.exponent) ORDER BY f.id),'[]') INTO result
  FROM public.wms_issue_fragments f JOIN public.wms_operations o ON(o.tenant_id,o.id)=(f.tenant_id,f.operation_id)
  JOIN public.wms_cost_layers l ON(l.tenant_id,l.id,l.product_id)=(f.tenant_id,f.layer_id,f.product_id)
  JOIN public.products p ON(p.tenant_id,p.id)=(f.tenant_id,f.product_id)
  JOIN public.stock_movements sm ON(sm.tenant_id,sm.order_id,sm.product_id,sm.warehouse_id,sm.kind)=(t,a.order_id,f.product_id,f.warehouse_id,'shipment') AND EXISTS(SELECT 1 FROM jsonb_array_elements(physical->'stock_movements') j WHERE j->>'id'=sm.id::text)
  JOIN public.stock_location_movements bm ON(bm.tenant_id,bm.order_id,bm.product_id,bm.warehouse_id,bm.location,bm.kind)=(t,a.order_id,f.product_id,f.warehouse_id,f.location,'shipment') AND EXISTS(SELECT 1 FROM jsonb_array_elements(physical->'location_movements') j WHERE j->>'id'=bm.id::text)
  JOIN public.wms_layer_movements lm ON(lm.tenant_id,lm.operation_id,lm.product_id,lm.warehouse_id,lm.location,lm.layer_id,lm.delta,lm.kind)=(f.tenant_id,f.operation_id,f.product_id,f.warehouse_id,f.location,f.layer_id,-f.quantity,'dispatch')
  WHERE f.tenant_id=t AND f.order_id=a.order_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(physical->'wms') w WHERE w->>'operation_id'=f.operation_id::text AND w->'fragment_ids' ? f.id::text AND w->'layer_movement_ids' ? lm.id::text)
   AND o.kind='dispatch' AND o.warehouse_document_id IS NULL AND o.purchase_receipt_id IS NULL AND o.return_id IS NULL
   AND(f.unit_cost_minor,f.currency) IS NOT DISTINCT FROM(l.unit_cost_minor,l.currency)
   AND f.value_minor IS NOT DISTINCT FROM f.quantity::bigint*l.unit_cost_minor;
  IF jsonb_array_length(result)<>(SELECT count(*) FROM jsonb_array_elements(expected)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(result) x GROUP BY x->>'physical_id' HAVING count(*)<>1) THEN RAISE EXCEPTION 'Fragment nie ma dokładnie jednego rozchodu WZ' USING ERRCODE='23514';END IF;
 ELSE
  IF physical->'wms' IS DISTINCT FROM 'null'::jsonb OR EXISTS(SELECT 1 FROM jsonb_array_elements(sn->'fragments') x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.before_snapshot->'fragments') y WHERE x=y)) THEN RAISE EXCEPTION 'OFF WZ nie może tworzyć partii' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('physical_id',bm.id,'product_id',bm.product_id,'warehouse_id',bm.warehouse_id,'location',bm.location,'quantity',-bm.delta,'sku',p.sku,'name',p.name,
   'stock_movement_id',sm.id,'location_movement_id',bm.id,'operation_id',NULL,'issue_fragment_id',NULL,'layer_movement_id',NULL,'layer_id',NULL,'lot_id',NULL) ORDER BY bm.id),'[]') INTO result
  FROM public.stock_location_movements bm JOIN public.products p ON(p.tenant_id,p.id)=(bm.tenant_id,bm.product_id)
  JOIN public.stock_movements sm ON(sm.tenant_id,sm.order_id,sm.product_id,sm.warehouse_id,sm.kind)=(t,a.order_id,bm.product_id,bm.warehouse_id,'shipment')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(physical->'stock_movements') j WHERE j->>'id'=sm.id::text)
  WHERE bm.tenant_id=t AND bm.order_id=a.order_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(physical->'location_movements') j WHERE j->>'id'=bm.id::text);
 END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(a.frame->'products') LOOP
  SELECT sum((r->>'quantity')::bigint) INTO n FROM jsonb_array_elements(result) r WHERE(r->>'product_id',r->>'warehouse_id')=(p->>'product_id',p->>'warehouse_id');
  IF n IS DISTINCT FROM(p->>'quantity')::bigint THEN RAISE EXCEPTION 'Pełne wiersze nie pokrywają WZ' USING ERRCODE='23514';END IF;
 END LOOP;
 IF jsonb_array_length(result)>10000 THEN RAISE EXCEPTION 'Limit pełnych fragmentów WZ' USING ERRCODE='54000';END IF;
 RETURN result;
END $$;

CREATE FUNCTION warehouse_wz_issuer_finish(uid uuid,kid uuid,eid uuid,physical jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=current_setting('app.tenant_id')::uuid;a public.warehouse_wz_issuer_admissions;effects jsonb;commercial jsonb;cfg jsonb;e jsonb;docs jsonb:='[]';payload jsonb;sumry jsonb;did uuid;seq bigint;ord integer;stamp timestamptz:=clock_timestamp();BEGIN
 PERFORM public.warehouse_wz_issuer_require();SELECT * INTO a FROM public.warehouse_wz_issuer_admissions WHERE tenant_id=t AND id=eid;
 IF a.id IS NULL OR a.txid<>pg_current_xact_id() OR a.sealed OR(a.actor_id,a.api_key_id) IS DISTINCT FROM(uid,kid) THEN RAISE EXCEPTION 'Brak bieżącej zgody automatycznego WZ' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.shipments WHERE tenant_id=t AND order_id=a.order_id AND id=a.shipment_id AND dispatched_at IS NOT NULL) THEN RAISE EXCEPTION 'WZ wymaga rzeczywistego fizycznego nadania' USING ERRCODE='23514';END IF;
 IF a.source->>'kind'='parcel' AND NOT EXISTS(SELECT 1 FROM public.order_parcel_dispatches WHERE tenant_id=t AND id=(a.source->>'dispatch_id')::uuid AND plan_id=(a.source->>'plan_id')::uuid AND order_id=a.order_id AND shipment_id=a.shipment_id AND parcel_index=(a.source->>'parcel_index')::integer) THEN RAISE EXCEPTION 'Brak rzeczywistego potwierdzenia paczki WZ' USING ERRCODE='23514';END IF;
 effects:=public.warehouse_wz_issuer_effects(eid,physical);commercial:=public.warehouse_wz_issuer_commercial(a.frame->'commercial_lines',effects);
 INSERT INTO public.warehouse_wz_issuer_receipts(id,tenant_id,order_id,shipment_id,source,physical,commercial_lines,created_at) VALUES(eid,t,a.order_id,a.shipment_id,a.source,physical,commercial,stamp);
 FOR cfg IN SELECT value FROM jsonb_array_elements(a.frame->'configurations') ORDER BY value->'warehouse'->>'id' LOOP
  SELECT sequence+1 INTO seq FROM public.warehouse_wz_issuer_counters WHERE tenant_id=t AND series_id=(cfg->'configuration'->>'series_id')::uuid AND year=(a.frame->>'year')::integer;
  IF seq IS NULL OR seq>9223372036854775806 THEN RAISE EXCEPTION 'Wyczerpano numerację WZ' USING ERRCODE='54000';END IF;
  SELECT jsonb_build_object('physical_quantity',sum((r->>'quantity')::bigint))||CASE WHEN a.frame->'policy' IS NOT NULL AND a.frame->'policy'<>'null'::jsonb THEN
   jsonb_build_object('known_value_minor',coalesce(sum((r->>'value_minor')::numeric),0)::text,'unknown_quantity',coalesce(sum((r->>'quantity')::bigint) FILTER(WHERE r->'unit_cost_minor'='null'::jsonb),0),'currency',a.frame->'policy'->>'currency','exponent',a.frame->'policy'->'exponent') ELSE '{}'::jsonb END INTO sumry
   FROM jsonb_array_elements(effects) r WHERE r->>'warehouse_id'=cfg->'warehouse'->>'id';
  did:=gen_random_uuid();payload:=jsonb_build_object('id',did,'kind','WZ','receipt_id',eid,'number',(cfg->'configuration'->'settings'->>'prefix')||'/'||(a.frame->>'year')||'/'||CASE WHEN length(seq::text)<6 THEN lpad(seq::text,6,'0') ELSE seq::text END,
   'series_id',cfg->'configuration'->>'series_id','year',(a.frame->>'year')::integer,'sequence',seq::text,'warehouse',cfg->'warehouse','source',a.source,'created_at',stamp,'row_count',(SELECT count(*) FROM jsonb_array_elements(effects) r WHERE r->>'warehouse_id'=cfg->'warehouse'->>'id'),'summary',sumry,'commercial_lines',commercial);
  INSERT INTO public.warehouse_wz_issuer_documents(id,tenant_id,receipt_id,shipment_id,warehouse_id,revision_id,series_id,year,sequence,number,payload,created_at)
  VALUES(did,t,eid,a.shipment_id,(cfg->'warehouse'->>'id')::uuid,(cfg->'configuration'->>'revision_id')::uuid,(cfg->'configuration'->>'series_id')::uuid,(a.frame->>'year')::integer,seq,payload->>'number',payload,stamp);
  ord:=0;
  FOR e IN SELECT value FROM jsonb_array_elements(effects) WHERE value->>'warehouse_id'=cfg->'warehouse'->>'id' ORDER BY value->>'physical_id' LOOP
   INSERT INTO public.warehouse_wz_issuer_rows VALUES(t,did,ord,(e->>'product_id')::uuid,(e->>'stock_movement_id')::uuid,(e->>'location_movement_id')::uuid,(e->>'operation_id')::uuid,(e->>'issue_fragment_id')::uuid,(e->>'layer_movement_id')::uuid,(e->>'layer_id')::uuid,(e->>'lot_id')::uuid,e||jsonb_build_object('ordinal',ord));ord:=ord+1;
  END LOOP;
  UPDATE public.warehouse_wz_issuer_counters SET sequence=seq WHERE tenant_id=t AND series_id=(cfg->'configuration'->>'series_id')::uuid AND year=(a.frame->>'year')::integer;
  docs:=docs||jsonb_build_array(payload);
 END LOOP;
 UPDATE public.warehouse_wz_issuer_admissions SET physical=warehouse_wz_issuer_finish.physical,after_snapshot=public.warehouse_wz_issuer_snapshot(t,a.order_id) WHERE tenant_id=t AND id=eid;
 IF(SELECT count(*) FROM public.warehouse_wz_issuer_documents WHERE tenant_id=t)>5000 OR(SELECT coalesce(sum(octet_length(to_jsonb(d)::text)),0) FROM public.warehouse_wz_issuer_documents d WHERE tenant_id=t)+(SELECT coalesce(sum(octet_length(to_jsonb(r)::text)),0) FROM public.warehouse_wz_issuer_rows r WHERE tenant_id=t)+(SELECT coalesce(sum(octet_length(to_jsonb(r)::text)),0) FROM public.warehouse_wz_issuer_admissions r WHERE tenant_id=t)>134217728 THEN RAISE EXCEPTION 'Limit historii WZ' USING ERRCODE='54000';END IF;
 RETURN docs;
END $$;

CREATE FUNCTION warehouse_wz_issuer_access(uid uuid,kid uuid,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=current_setting('app.tenant_id')::uuid;r text;k public.api_keys;v boolean:=true;s boolean:=true;BEGIN
 IF pin THEN SELECT role INTO r FROM public.memberships WHERE tenant_id=t AND user_id=uid FOR SHARE;ELSE SELECT role INTO r FROM public.memberships WHERE tenant_id=t AND user_id=uid;END IF;
 IF kid IS NOT NULL THEN
  IF pin THEN SELECT * INTO k FROM public.api_keys WHERE tenant_id=t AND id=kid AND user_id=uid FOR SHARE;ELSE SELECT * INTO k FROM public.api_keys WHERE tenant_id=t AND id=kid AND user_id=uid;END IF;
  v:=k.id IS NOT NULL AND k.revoked_at IS NULL AND(k.expires_at IS NULL OR k.expires_at>clock_timestamp());s:=v AND 'orders:write'=ANY(k.scopes);
 END IF;
 RETURN jsonb_build_object('key_valid',v,'allowed',r IN('admin','operator') AND s,'role',r);
END $$;

CREATE FUNCTION warehouse_wz_issuer_snapshot(t uuid,oid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('order',(SELECT to_jsonb(o) FROM public.orders o WHERE tenant_id=t AND id=oid),
 'items',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.order_items r WHERE tenant_id=t AND order_id=oid),
 'reservations',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY product_id),'[]') FROM public.reservations r WHERE tenant_id=t AND order_id=oid),
 'bins',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY warehouse_id,product_id,location COLLATE "C"),'[]') FROM public.reservation_locations r WHERE tenant_id=t AND order_id=oid),
 'holds',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY warehouse_id,product_id,location COLLATE "C",layer_id),'[]') FROM public.wms_reservation_layers r WHERE tenant_id=t AND order_id=oid),
 'stock',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.warehouse_id,s.product_id),'[]') FROM public.stock s WHERE s.tenant_id=t AND EXISTS(SELECT 1 FROM public.reservations r WHERE r.tenant_id=t AND r.order_id=oid AND(r.warehouse_id,r.product_id)=(s.warehouse_id,s.product_id))),
 'locations',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.warehouse_id,s.product_id,s.location COLLATE "C"),'[]') FROM public.stock_locations s WHERE s.tenant_id=t AND EXISTS(SELECT 1 FROM public.reservation_locations r WHERE r.tenant_id=t AND r.order_id=oid AND(r.warehouse_id,r.product_id,r.location)=(s.warehouse_id,s.product_id,s.location))),
 'positions',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.warehouse_id,s.product_id,s.location COLLATE "C",s.layer_id),'[]') FROM public.wms_layer_positions s WHERE s.tenant_id=t AND EXISTS(SELECT 1 FROM public.wms_reservation_layers r WHERE r.tenant_id=t AND r.order_id=oid AND(r.warehouse_id,r.product_id,r.location,r.layer_id)=(s.warehouse_id,s.product_id,s.location,s.layer_id))),
 'shipments',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM public.shipments s WHERE tenant_id=t AND order_id=oid),
 'stock_journals',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM public.stock_movements s WHERE tenant_id=t AND order_id=oid),
 'bin_journals',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM public.stock_location_movements s WHERE tenant_id=t AND order_id=oid),
 'fragments',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM public.wms_issue_fragments s WHERE tenant_id=t AND order_id=oid),
 'operations',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM public.wms_operations s WHERE tenant_id=t AND order_id=oid),
 'layer_journals',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') FROM public.wms_layer_movements s JOIN public.wms_operations o ON(o.tenant_id,o.id)=(s.tenant_id,s.operation_id) WHERE o.tenant_id=t AND o.order_id=oid));
$$;

CREATE FUNCTION warehouse_wz_issuer_prepare(uid uuid,kid uuid,src jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=current_setting('app.tenant_id')::uuid;oid uuid:=(src->>'order_id')::uuid;sid uuid:=(src->>'shipment_id')::uuid;
 eid uuid:=gen_random_uuid();sn jsonb;products jsonb;commercial jsonb;cfg jsonb;pol jsonb;cb jsonb;r record;y integer:=extract(year FROM clock_timestamp());g jsonb;BEGIN
 PERFORM public.warehouse_wz_issuer_require();g:=public.warehouse_wz_issuer_access(uid,kid,false);
 IF g->'key_valid' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Klucz wydania WZ został cofnięty lub wygasł' USING ERRCODE='28000';END IF;
 IF g->'allowed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Brak aktualnego prawa wydania WZ' USING ERRCODE='42501';END IF;
 IF src->>'kind' NOT IN('demo','shipping_plan','parcel') OR oid IS NULL OR sid IS NULL THEN RAISE EXCEPTION 'Niepoprawne źródło WZ' USING ERRCODE='23514';END IF;
 -- Existing historical dispatch has its original caller receipt; no retrofit.
 IF EXISTS(SELECT 1 FROM public.shipments WHERE tenant_id=t AND id=sid AND order_id=oid AND dispatched_at IS NOT NULL) THEN RETURN NULL;END IF;
 IF src->>'kind'='parcel' THEN
  SELECT payload->'products',payload->'items' INTO products,commercial FROM public.order_parcel_allocations
   WHERE tenant_id=t AND plan_id=(src->>'plan_id')::uuid AND order_id=oid AND index=(src->>'parcel_index')::integer AND shipment_id=sid;
 ELSE
  SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'warehouse_id',warehouse_id,'quantity',quantity) ORDER BY product_id),'[]') INTO products FROM public.reservations WHERE tenant_id=t AND order_id=oid AND state='active';
 END IF;
 IF products IS NULL THEN RAISE EXCEPTION 'Brak własnego fizycznego źródła WZ' USING ERRCODE='P0002';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.warehouse_automatic_wz_configurations c WHERE c.tenant_id=t AND c.settings->>'enabled'='true' AND EXISTS(SELECT 1 FROM jsonb_array_elements(products) p WHERE p->>'warehouse_id'=c.warehouse_id::text)) THEN RETURN NULL;END IF;
 FOR r IN SELECT DISTINCT(value->>'warehouse_id')::uuid id FROM jsonb_array_elements(products) ORDER BY 1 LOOP
  PERFORM public.warehouse_inventory_policy_lock(t,r.id);
  PERFORM warehouse_id FROM public.warehouse_automatic_wz_configurations WHERE tenant_id=t AND warehouse_id=r.id FOR SHARE;
 END LOOP;
 PERFORM pg_advisory_xact_lock(hashtextextended('wz.issuer.quota:'||t::text,0));
 -- A concurrent dispatch may have committed while this call waited for quota.
 -- Let the original caller resolve its exact receipt before allocating numbers
 -- or requiring a still-packed order; do not create a second admission.
 IF EXISTS(SELECT 1 FROM public.shipments WHERE tenant_id=t AND id=sid AND order_id=oid AND dispatched_at IS NOT NULL) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse',jsonb_build_object('id',w.id,'name',w.name,'code',w.code),'configuration',to_jsonb(c)) ORDER BY c.warehouse_id),'[]') INTO cfg
 FROM public.warehouse_automatic_wz_configurations c JOIN public.warehouses w ON(w.tenant_id,w.id)=(c.tenant_id,c.warehouse_id)
 WHERE c.tenant_id=t AND c.settings->>'enabled'='true' AND EXISTS(SELECT 1 FROM jsonb_array_elements(products) p WHERE p->>'warehouse_id'=c.warehouse_id::text);
 -- Configuration may have been disabled while the warehouse/configuration
 -- SHARE lock waited. Disabled dispatch must allocate no issuer sidecars.
 IF jsonb_array_length(cfg)=0 THEN RETURN NULL;END IF;
 FOR r IN SELECT value v FROM jsonb_array_elements(cfg) ORDER BY value->'warehouse'->>'id' LOOP
  INSERT INTO public.warehouse_wz_issuer_counters(tenant_id,warehouse_id,series_id,year,sequence) VALUES(t,(r.v->'warehouse'->>'id')::uuid,(r.v->'configuration'->>'series_id')::uuid,y,0) ON CONFLICT DO NOTHING;
  PERFORM sequence FROM public.warehouse_wz_issuer_counters WHERE tenant_id=t AND series_id=(r.v->'configuration'->>'series_id')::uuid AND year=y FOR UPDATE;
 END LOOP;
 PERFORM id FROM public.orders WHERE tenant_id=t AND id=oid AND status='packed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Zamówienie nie jest gotowe do automatycznego WZ' USING ERRCODE='23514';END IF;
 IF src->>'kind'='shipping_plan' AND NOT EXISTS(SELECT 1 FROM public.shipping_plans WHERE tenant_id=t AND id=(src->>'plan_id')::uuid AND order_id=oid AND shipment_id=sid AND state='ready') THEN RAISE EXCEPTION 'Brak gotowego planu nadania WZ' USING ERRCODE='23514';END IF;
 IF src->>'kind'='demo' AND EXISTS(SELECT 1 FROM public.shipments WHERE tenant_id=t AND order_id=oid) THEN RAISE EXCEPTION 'Demo WZ wymaga nowego własnego nadania' USING ERRCODE='23514';END IF;
 sn:=public.warehouse_wz_issuer_snapshot(t,oid);
 IF src->>'kind'<>'parcel' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('item_id',i.id,'product_id',i.product_id,'name',i.name,'sku',i.sku,'quantity',i.quantity,'original_quantity',i.quantity,'line_total',i.line_total,'vat',i.vat,'currency',sn->'order'->>'currency','components',CASE WHEN jsonb_array_length(i.components)>0 THEN i.components ELSE jsonb_build_array(jsonb_build_object('product_id',i.product_id,'quantity',1)) END) ORDER BY i.id),'[]') INTO commercial FROM public.order_items i WHERE tenant_id=t AND order_id=oid;
 END IF;
 IF commercial IS NULL OR jsonb_array_length(commercial)=0 THEN RAISE EXCEPTION 'WZ wymaga rzeczywistej historycznej tożsamości pozycji' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(commercial) l LEFT JOIN public.order_items i ON(i.tenant_id,i.order_id,i.id)=(t,oid,(l->>'item_id')::uuid)
  WHERE i.id IS NULL OR(i.product_id,i.name,i.sku,i.line_total,i.vat) IS DISTINCT FROM((l->>'product_id')::uuid,l->>'name',l->>'sku',(l->>'line_total')::bigint,(l->>'vat')::integer) OR(l->>'quantity')::integer<1 OR(l->>'quantity')::integer>i.quantity
  OR l->'components' IS DISTINCT FROM CASE WHEN jsonb_array_length(i.components)>0 THEN i.components ELSE jsonb_build_array(jsonb_build_object('product_id',i.product_id,'quantity',1)) END)
 THEN RAISE EXCEPTION 'Niepełne historyczne pozycje WZ' USING ERRCODE='23514';END IF;
 IF (SELECT coalesce(jsonb_object_agg(product_id,q),'{}') FROM(SELECT p->>'product_id' product_id,sum((p->>'quantity')::bigint) q FROM jsonb_array_elements(products) p GROUP BY 1)x)
 IS DISTINCT FROM(SELECT coalesce(jsonb_object_agg(product_id,q),'{}') FROM(SELECT c->>'product_id' product_id,sum((l->>'quantity')::bigint*(c->>'quantity')::bigint) q FROM jsonb_array_elements(commercial) l CROSS JOIN LATERAL jsonb_array_elements(l->'components') c GROUP BY 1)x)
 THEN RAISE EXCEPTION 'Receptury nie pokrywają fizycznego WZ' USING ERRCODE='23514';END IF;
 SELECT to_jsonb(p) INTO pol FROM public.wms_policies p WHERE tenant_id=t AND enabled;
 SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.series_id),'[]') INTO cb FROM public.warehouse_wz_issuer_counters c WHERE c.tenant_id=t AND c.year=y AND EXISTS(SELECT 1 FROM jsonb_array_elements(cfg) x WHERE x->'configuration'->>'series_id'=c.series_id::text);
 INSERT INTO public.warehouse_wz_issuer_admissions(id,tenant_id,order_id,shipment_id,actor_id,api_key_id,source,frame,before_snapshot)
 VALUES(eid,t,oid,sid,uid,kid,src,jsonb_build_object('products',products,'commercial_lines',commercial,'configurations',cfg,'policy',pol,'year',y,'counters_before',cb),sn);
 RETURN eid;
END $$;

CREATE FUNCTION warehouse_wz_issuer_record_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid;v jsonb;BEGIN
 IF TG_TABLE_NAME='warehouse_wz_issuer_manifest' THEN RAISE EXCEPTION 'Manifest WZ jest niezmienny' USING ERRCODE='23514';END IF;
 v:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;t:=(v->>'tenant_id')::uuid;
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Obcy zakres automatycznego WZ' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='warehouse_wz_issuer_admissions' THEN
  IF TG_OP='DELETE' OR(TG_OP='UPDATE' AND(OLD.sealed OR NEW.txid<>pg_current_xact_id() OR
   to_jsonb(NEW)-ARRAY['physical','after_snapshot','sealed'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['physical','after_snapshot','sealed'])) THEN RAISE EXCEPTION 'Zgoda WZ jest zapieczętowana' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='warehouse_wz_issuer_counters' THEN
  IF TG_OP='DELETE' OR(TG_OP='UPDATE' AND NOT EXISTS(SELECT 1 FROM public.warehouse_wz_issuer_admissions a WHERE a.tenant_id=t AND a.txid=pg_current_xact_id() AND NOT a.sealed
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.frame->'configurations') c WHERE c->'configuration'->>'series_id'=NEW.series_id::text AND c->'warehouse'->>'id'=NEW.warehouse_id::text)
    AND NEW.year=(a.frame->>'year')::integer AND NEW.sequence=OLD.sequence+1 AND(to_jsonb(NEW)-'sequence')=(to_jsonb(OLD)-'sequence')))
   OR(TG_OP='INSERT' AND NEW.sequence<>0) THEN RAISE EXCEPTION 'Numeracja WZ wymaga bieżącej zgody' USING ERRCODE='23514';END IF;
 ELSE
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Dokument i dowód WZ są niezmienne' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.warehouse_wz_issuer_admissions a WHERE a.tenant_id=t AND a.txid=pg_current_xact_id() AND NOT a.sealed AND a.id=
   (CASE WHEN TG_TABLE_NAME='warehouse_wz_issuer_receipts' THEN (v->>'id')::uuid WHEN TG_TABLE_NAME='warehouse_wz_issuer_documents' THEN(v->>'receipt_id')::uuid
    ELSE(SELECT receipt_id FROM public.warehouse_wz_issuer_documents WHERE tenant_id=t AND id=(v->>'document_id')::uuid) END))
  THEN RAISE EXCEPTION 'Dokument WZ wymaga bieżącej zgody' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION warehouse_wz_issuer_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.warehouse_wz_issuer_admissions;r public.warehouse_wz_issuer_receipts;d public.warehouse_wz_issuer_documents;e jsonb;cfg jsonb;actual jsonb;expected jsonb;sumry jsonb;seq bigint;BEGIN
 SELECT * INTO a FROM public.warehouse_wz_issuer_admissions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id);
 IF a.txid<>pg_current_xact_id() OR a.after_snapshot IS NULL OR a.physical IS NULL THEN RAISE EXCEPTION 'Niepełny automatyczny WZ' USING ERRCODE='23514';END IF;
 IF a.after_snapshot IS DISTINCT FROM public.warehouse_wz_issuer_snapshot(a.tenant_id,a.order_id) THEN RAISE EXCEPTION 'Źródło zmieniło się po wystawieniu WZ' USING ERRCODE='23514';END IF;
 -- Re-derive all identities and conservation from actual source tables.
 e:=public.warehouse_wz_issuer_effects(a.id,a.physical);
 SELECT * INTO r FROM public.warehouse_wz_issuer_receipts WHERE(tenant_id,id)=(a.tenant_id,a.id);
 IF r.id IS NULL OR(r.order_id,r.shipment_id,r.source,r.physical,r.commercial_lines) IS DISTINCT FROM(a.order_id,a.shipment_id,a.source,a.physical,public.warehouse_wz_issuer_commercial(a.frame->'commercial_lines',e)) THEN RAISE EXCEPTION 'Niepełny własny receipt WZ' USING ERRCODE='23514';END IF;
 IF(SELECT count(*) FROM public.warehouse_wz_issuer_documents WHERE tenant_id=a.tenant_id AND receipt_id=a.id)<>jsonb_array_length(a.frame->'configurations') THEN RAISE EXCEPTION 'Brak pełnych dokumentów WZ' USING ERRCODE='23514';END IF;
 FOR cfg IN SELECT value FROM jsonb_array_elements(a.frame->'configurations') LOOP
  SELECT * INTO d FROM public.warehouse_wz_issuer_documents WHERE tenant_id=a.tenant_id AND receipt_id=a.id AND warehouse_id=(cfg->'warehouse'->>'id')::uuid;
  SELECT(value->>'sequence')::bigint+1 INTO seq FROM jsonb_array_elements(a.frame->'counters_before') WHERE value->>'series_id'=cfg->'configuration'->>'series_id';
  IF d.id IS NULL OR(d.shipment_id,d.revision_id,d.series_id,d.year,d.sequence) IS DISTINCT FROM(a.shipment_id,(cfg->'configuration'->>'revision_id')::uuid,(cfg->'configuration'->>'series_id')::uuid,(a.frame->>'year')::integer,seq)
   OR d.number IS DISTINCT FROM((cfg->'configuration'->'settings'->>'prefix')||'/'||(a.frame->>'year')||'/'||(CASE WHEN length(seq::text)<6 THEN lpad(seq::text,6,'0') ELSE seq::text END))
   OR NOT EXISTS(SELECT 1 FROM public.warehouse_wz_issuer_counters WHERE tenant_id=a.tenant_id AND series_id=d.series_id AND year=d.year AND sequence=seq)
   OR(d.payload->>'id',d.payload->>'receipt_id',d.payload->>'number',d.payload->>'sequence',d.payload->'source',d.payload->'warehouse',d.payload->'commercial_lines') IS DISTINCT FROM(d.id::text,a.id::text,d.number,d.sequence::text,a.source,cfg->'warehouse',r.commercial_lines)
  THEN RAISE EXCEPTION 'Dokument lub numer WZ nie odpowiada zgodzie' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(payload-'ordinal' ORDER BY payload->>'physical_id'),'[]') INTO actual FROM public.warehouse_wz_issuer_rows WHERE tenant_id=a.tenant_id AND document_id=d.id;
  SELECT coalesce(jsonb_agg(value ORDER BY value->>'physical_id'),'[]') INTO expected FROM jsonb_array_elements(e) WHERE value->>'warehouse_id'=d.warehouse_id::text;
  SELECT jsonb_build_object('physical_quantity',sum((x->>'quantity')::bigint))||CASE WHEN a.frame->'policy' IS NOT NULL AND a.frame->'policy'<>'null'::jsonb THEN
   jsonb_build_object('known_value_minor',coalesce(sum((x->>'value_minor')::numeric),0)::text,'unknown_quantity',coalesce(sum((x->>'quantity')::bigint) FILTER(WHERE x->'unit_cost_minor'='null'::jsonb),0),'currency',a.frame->'policy'->>'currency','exponent',a.frame->'policy'->'exponent') ELSE '{}'::jsonb END INTO sumry FROM jsonb_array_elements(expected) x;
  IF d.payload IS DISTINCT FROM jsonb_build_object('id',d.id,'kind','WZ','receipt_id',a.id,'number',d.number,'series_id',d.series_id,'year',d.year,'sequence',d.sequence::text,'warehouse',cfg->'warehouse','source',a.source,'created_at',d.created_at,'row_count',jsonb_array_length(expected),'summary',sumry,'commercial_lines',r.commercial_lines)
   OR d.created_at IS DISTINCT FROM r.created_at
   OR EXISTS(SELECT 1 FROM public.warehouse_wz_issuer_rows x WHERE x.tenant_id=a.tenant_id AND x.document_id=d.id HAVING min(x.ordinal)<>0 OR max(x.ordinal)<>count(*)-1)
  THEN RAISE EXCEPTION 'Pełny nagłówek i manifest WZ nie odpowiadają źródłu' USING ERRCODE='23514';END IF;
  IF actual IS DISTINCT FROM expected OR jsonb_array_length(actual)<>(d.payload->>'row_count')::integer OR EXISTS(SELECT 1 FROM public.warehouse_wz_issuer_rows x WHERE x.tenant_id=a.tenant_id AND x.document_id=d.id AND
   (x.product_id,x.stock_movement_id,x.location_movement_id,x.operation_id,x.issue_fragment_id,x.layer_movement_id,x.layer_id,x.lot_id,x.ordinal) IS DISTINCT FROM((x.payload->>'product_id')::uuid,(x.payload->>'stock_movement_id')::uuid,(x.payload->>'location_movement_id')::uuid,(x.payload->>'operation_id')::uuid,(x.payload->>'issue_fragment_id')::uuid,(x.payload->>'layer_movement_id')::uuid,(x.payload->>'layer_id')::uuid,(x.payload->>'lot_id')::uuid,(x.payload->>'ordinal')::integer))
  THEN RAISE EXCEPTION 'Wiersze WZ nie odpowiadają rzeczywistym ruchom' USING ERRCODE='23514';END IF;
 END LOOP;
 UPDATE public.warehouse_wz_issuer_admissions SET sealed=true WHERE(tenant_id,id)=(a.tenant_id,a.id);RETURN NULL;
END $$;

CREATE FUNCTION warehouse_wz_issuer_source_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v jsonb;a public.warehouse_wz_issuer_admissions;k text;BEGIN
 FOR v IN SELECT x FROM(VALUES(CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END),(CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END)) z(x) WHERE x IS NOT NULL LOOP
  FOR a IN SELECT * FROM public.warehouse_wz_issuer_admissions WHERE tenant_id=(v->>'tenant_id')::uuid AND txid=pg_current_xact_id() AND sealed LOOP
   IF TG_TABLE_NAME='orders' AND v->>'id'=a.order_id::text
    OR TG_TABLE_NAME IN('order_items','shipments','reservations','reservation_locations','wms_reservation_layers','stock_movements','stock_location_movements','wms_operations','wms_issue_fragments') AND v->>'order_id'=a.order_id::text
    OR TG_TABLE_NAME IN('stock','stock_locations','wms_layer_positions') AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.frame->'products') p WHERE(p->>'product_id',p->>'warehouse_id')=(v->>'product_id',v->>'warehouse_id'))
    OR TG_TABLE_NAME='wms_layer_movements' AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.after_snapshot->'operations') p WHERE p->>'id'=v->>'operation_id')
   THEN RAISE EXCEPTION 'Źródło automatycznego WZ jest zapieczętowane' USING ERRCODE='23514';END IF;
  END LOOP;
  IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM public.warehouse_wz_issuer_rows r WHERE r.tenant_id=(v->>'tenant_id')::uuid AND
   (TG_TABLE_NAME='stock_movements' AND r.stock_movement_id=(v->>'id')::uuid
    OR TG_TABLE_NAME='stock_location_movements' AND r.location_movement_id=(v->>'id')::uuid
    OR TG_TABLE_NAME='wms_issue_fragments' AND r.issue_fragment_id=(v->>'id')::uuid
    OR TG_TABLE_NAME='wms_layer_movements' AND r.layer_movement_id=(v->>'id')::uuid
    OR TG_TABLE_NAME='wms_operations' AND r.operation_id=(v->>'id')::uuid)) THEN RAISE EXCEPTION 'Pochodzenie dokumentu WZ jest niezmienne' USING ERRCODE='23514';END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;

CREATE FUNCTION warehouse_wz_issuer_hash(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT encode(sha256(convert_to(j::text,'UTF8')),'hex')$$;
CREATE FUNCTION warehouse_wz_issuer_installed() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT 1 FROM public.migrations WHERE name='151_warehouse_wz_issuer')$$;
CREATE FUNCTION warehouse_wz_issuer_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.warehouse_wz_issuer_hash(jsonb_build_object(
 'tables',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
  'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(coalesce(pg_get_userbyid(a.grantee),'PUBLIC'),pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a),
  'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',attname,'type',format_type(atttypid,atttypmod),'notnull',attnotnull,'generated',attgenerated,'identity',attidentity,'acl',attacl::text,'default',pg_get_expr(d.adbin,d.adrelid,true)) ORDER BY attnum),'[]'::jsonb) FROM pg_attribute b LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(b.attrelid,b.attnum) WHERE b.attrelid=c.oid AND b.attnum>0 AND NOT b.attisdropped),
  'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_array(conname,contype,convalidated,pg_get_constraintdef(oid,true)) ORDER BY conname),'[]'::jsonb) FROM pg_constraint WHERE conrelid=c.oid),
  'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_array(i.relname,x.indisvalid,x.indisready,pg_get_indexdef(i.oid)) ORDER BY i.relname),'[]'::jsonb) FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid),
  'policies',(SELECT coalesce(jsonb_agg(jsonb_build_array(polname,polcmd,polpermissive,polroles::text,pg_get_expr(polqual,polrelid,true),pg_get_expr(polwithcheck,polrelid,true)) ORDER BY polname),'[]'::jsonb) FROM pg_policy WHERE polrelid=c.oid),
  'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_array(tgname,tgenabled,pg_get_triggerdef(oid,true)) ORDER BY tgname),'[]'::jsonb) FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal)
 ) ORDER BY c.relname),'[]'::jsonb) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname LIKE 'warehouse_wz_issuer_%'),
 'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'returns',pg_get_function_result(p.oid),'language',(SELECT lanname FROM pg_language WHERE oid=p.prolang),'kind',p.prokind,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'owner',pg_get_userbyid(p.proowner),'security',p.prosecdef,'volatile',p.provolatile,'config',p.proconfig,'body',p.prosrc,
  'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(coalesce(pg_get_userbyid(a.grantee),'PUBLIC'),pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)
 ) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)),'[]'::jsonb) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'warehouse_wz_issuer_%')
 ))
$$;

CREATE FUNCTION warehouse_wz_issuer_guards() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expected text;BEGIN
 IF NOT public.warehouse_wz_issuer_installed() THEN RETURN false;END IF;
 IF to_regprocedure('public.warehouse_automatic_wz_guards()') IS NULL OR NOT public.warehouse_automatic_wz_guards() THEN RETURN false;END IF;
 IF(SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['orders','order_items','shipments','reservations','reservation_locations','stock','stock_locations','wms_reservation_layers','wms_layer_positions','stock_movements','stock_location_movements','wms_operations','wms_issue_fragments','wms_layer_movements'])
  AND t.tgname='warehouse_wz_issuer_source_seal' AND t.tgfoid='public.warehouse_wz_issuer_source_seal()'::regprocedure AND t.tgtype=31 AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgargs='\x'::bytea AND t.tgattr::text='')<>14 THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname LIKE 'warehouse_wz_issuer_%' AND a.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_attribute b ON b.attrelid=c.oid CROSS JOIN LATERAL aclexplode(b.attacl) a WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'warehouse_wz_issuer_%' AND a.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'warehouse_wz_issuer_%' AND a.grantee<>p.proowner) THEN RETURN false;END IF;
 SELECT fingerprint INTO expected FROM public.warehouse_wz_issuer_manifest WHERE singleton;
 RETURN expected IS NOT NULL AND expected=public.warehouse_wz_issuer_fingerprint();
EXCEPTION WHEN undefined_table OR undefined_function OR undefined_column THEN RETURN false;
END $$;
CREATE FUNCTION warehouse_wz_issuer_require() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN IF NOT public.warehouse_wz_issuer_guards() THEN RAISE EXCEPTION 'Niekompletny wystawca automatycznego WZ' USING ERRCODE='55000';END IF;END $$;

DO $$DECLARE rel text;BEGIN
 FOREACH rel IN ARRAY ARRAY['admissions','receipts','counters','documents','rows'] LOOP
  EXECUTE format('CREATE TRIGGER warehouse_wz_issuer_record_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.warehouse_wz_issuer_record_guard()','warehouse_wz_issuer_'||rel);
 END LOOP;
 FOREACH rel IN ARRAY ARRAY['orders','order_items','shipments','reservations','reservation_locations','stock','stock_locations','wms_reservation_layers','wms_layer_positions','stock_movements','stock_location_movements','wms_operations','wms_issue_fragments','wms_layer_movements'] LOOP
  EXECUTE format('CREATE TRIGGER warehouse_wz_issuer_source_seal BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.warehouse_wz_issuer_source_seal()',rel);
 END LOOP;
END $$;
CREATE CONSTRAINT TRIGGER warehouse_wz_issuer_complete AFTER INSERT ON warehouse_wz_issuer_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION warehouse_wz_issuer_complete();
CREATE TRIGGER warehouse_wz_issuer_manifest_guard BEFORE UPDATE OR DELETE ON warehouse_wz_issuer_manifest FOR EACH ROW EXECUTE FUNCTION warehouse_wz_issuer_record_guard();
DO $$DECLARE f record;BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'warehouse_wz_issuer_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.signature);
 END LOOP;
END $$;
INSERT INTO warehouse_wz_issuer_manifest(singleton,fingerprint) VALUES(true,warehouse_wz_issuer_fingerprint());
