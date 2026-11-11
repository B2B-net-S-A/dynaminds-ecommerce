-- Migration 255_stock_verdict (prepared as 270, registered after 254_carrier_returns). No object name
-- contains the number. docs/parity/CATALOG-STOCK-GEN270-20261029.md.
-- A new owner-only generation of the catalog stock control adapters whose sealed bodies run the full
-- catalog_stock_control_guards() through catalog_stock_control_require() on every call (~0.3 s idle, 1.3-1.6 s under
-- load; 2 213 of the 5 488 full guards of the 248+250 load run bypassed the 248 verdict this way):
--   stock_verdict_require()             = catalog_stock_control_require(), asking guard_verdict('catalog_stock_control_guards');
--   stock_verdict_return_require()      = catalog_stock_return_require(), with stock_verdict_require();
--   stock_verdict_return_frame(...)     = catalog_stock_return_frame(...), with stock_verdict_require();
--   stock_verdict_effect_prepare(...)   = catalog_stock_control_effect_prepare(...), with stock_verdict_require();
--   stock_verdict_effect_finish(...)    = catalog_stock_control_effect_finish(...), with stock_verdict_require();
--   stock_verdict_return_prepare(...)   = catalog_stock_return_prepare(...), with the three copies above.
-- Each body is the sealed original's prosrc (pg_get_functiondef on a clone at 253) with only those calls swapped; the
-- declarations (arguments, result, SECURITY DEFINER, search_path, TimeZone, owner, owner-only EXECUTE) are the same.
-- guard_verdict() (248) answers with the full guard (same value or error) unless the call is READ COMMITTED, the 182
-- generation is cold-approved and fenced, the 182 machinery is intact (239/240/241), the session has no TEMP object and
-- the recorded basis is unchanged; so each copy accepts exactly the states its sealed original accepts.
-- The sealed functions are not replaced, altered or granted, and stay for every other caller (count, manual OFF, return
-- finish/abandon/complete, b2b credit, legacy return) and before 255. No name falls in a sealed family (LIKE or
-- starts_with scans of catalog_stock_*, return_*, manual_inventory_off_*, ...), so no fingerprint or guard pin moves;
-- the copies are covered by the cold catalogue contract at startup and the ordinary184 generation check per transaction,
-- like the 236/239/248 functions.
CREATE FUNCTION public.stock_verdict_require()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$ BEGIN IF NOT public.guard_verdict('catalog_stock_control_guards') THEN RAISE EXCEPTION 'Niekompletny moduł ścisłej kontroli katalogu' USING ERRCODE='55000';END IF;END $function$;
REVOKE ALL ON FUNCTION public.stock_verdict_require() FROM PUBLIC,dyna_app;

CREATE FUNCTION public.stock_verdict_return_require()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN PERFORM public.stock_verdict_require();IF NOT public.catalog_stock_return_guards() THEN RAISE EXCEPTION 'Niekompletny certyfikowany adapter PZ zwrotu' USING ERRCODE='55000';END IF;END $function$;
REVOKE ALL ON FUNCTION public.stock_verdict_return_require() FROM PUBLIC,dyna_app;

CREATE FUNCTION public.stock_verdict_return_frame(uid uuid, kid uuid, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r public.return_cases;p public.return_assistant_previews;
 q jsonb:=b->'request';items jsonb;cells jsonb;f jsonb;products_json jsonb;protocol text:=b->>'protocol';g jsonb;
 prior public.catalog_stock_return_admissions;saved public.catalog_stock_return_receipts;
BEGIN
 PERFORM public.stock_verdict_require();
 g:=public.catalog_stock_return_access(uid,kid,(b->>'return_id')::uuid,protocol);
 SELECT * INTO r FROM public.return_cases WHERE(tenant_id,id)=(t,(b->>'return_id')::uuid);
 IF r.id IS NULL THEN RAISE EXCEPTION 'Brak własnego RMA' USING ERRCODE='P0002';END IF;
 IF protocol NOT IN('rma','legacy_status','assistant_v1','destinations_v1','exchange','dropship_supplier') THEN RAISE EXCEPTION 'Nieznany protokół RMA' USING ERRCODE='23514';END IF;
 IF protocol IN('assistant_v1','destinations_v1') THEN
  SELECT * INTO p FROM public.return_assistant_previews WHERE(tenant_id,id,return_id,actor_id)=(t,(b->>'preview_id')::uuid,r.id,uid);
  IF p.id IS NULL OR p.api_key_id IS DISTINCT FROM kid OR(protocol='destinations_v1') IS DISTINCT FROM coalesce(p.payload->'snapshot'->>'protocol'='destinations_v1',false) THEN RAISE EXCEPTION 'Obcy protokół podglądu RMA' USING ERRCODE='23514';END IF;
  q:=p.payload->'receive_input';
  IF q IS DISTINCT FROM b->'request' THEN RAISE EXCEPTION 'Podgląd ma inny kanoniczny input core' USING ERRCODE='23514';END IF;
 END IF;
 -- Genuine historical replay never allocates numbers or invents a receipt.
 -- A saved169 command retains its original author/key/protocol/body binding;
 -- pre169 history has no new receipt to retrofit or new authority to impose.
 IF r.state<>'requested' THEN
  SELECT * INTO prior FROM public.catalog_stock_return_admissions WHERE(tenant_id,return_id)=(t,r.id);
  SELECT * INTO saved FROM public.catalog_stock_return_receipts WHERE(tenant_id,return_id)=(t,r.id);
  IF prior.id IS NOT NULL OR saved.id IS NOT NULL THEN
   IF prior.id IS NULL OR saved.id IS NULL OR NOT prior.sealed OR saved.id IS DISTINCT FROM prior.id
    OR prior.actor_id IS DISTINCT FROM uid OR prior.api_key_id IS DISTINCT FROM kid
    OR prior.protocol IS DISTINCT FROM protocol OR prior.preview_id IS DISTINCT FROM p.id
    OR prior.frame->'request' IS DISTINCT FROM q THEN
    RAISE EXCEPTION 'Replay PZ zwrotu ma innego autora, klucz lub treść' USING ERRCODE='23514';END IF;
  END IF;
  RETURN jsonb_build_object('historical',true,'return_id',r.id);
 END IF;
 IF protocol IN('assistant_v1','destinations_v1') AND p.payload->>'action'='reject' THEN
  RETURN jsonb_build_object('return_case',to_jsonb(r),'cells','[]'::jsonb);END IF;
 -- Native receiveReturn permits a legacy-origin RMA through its ordinary
 -- receive endpoint only with explicit WMS picks and this tenant's enabled
 -- policy. This does not authorize OFF or another legacy protocol.
 IF protocol='legacy_status' AND NOT r.legacy OR
   protocol<>'legacy_status' AND r.legacy AND NOT (
    protocol='rma' AND jsonb_typeof(q->'wms_lots') IS NOT DISTINCT FROM 'object' AND
    EXISTS(SELECT FROM public.wms_policies wp WHERE wp.tenant_id=t AND wp.enabled)) OR
   (q->>'version')::bigint<>r.version OR jsonb_typeof(q->'items') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'Nieaktualny stan lub wersja RMA' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY item_id),'[]') INTO items FROM public.return_items i WHERE(tenant_id,return_id)=(t,r.id);
 IF jsonb_array_length(items)>500 OR jsonb_array_length(q->'items')<>jsonb_array_length(items) OR
  EXISTS(SELECT FROM jsonb_array_elements(q->'items')i GROUP BY i->>'item_id' HAVING count(*)<>1) OR
  EXISTS(SELECT FROM jsonb_array_elements(items)i WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(q->'items')x
   WHERE x->>'item_id'=i->>'item_id' AND(x->>'accepted')::numeric BETWEEN 0 AND(i->>'requested')::numeric
   AND(x->>'restocked')::numeric BETWEEN 0 AND(x->>'accepted')::numeric)) THEN
  RAISE EXCEPTION 'Decyzje nie odpowiadają pełnym pozycjom RMA' USING ERRCODE='22023';END IF;
 IF protocol='destinations_v1' THEN
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'warehouse_id',x->>'product_id',x->>'location',x->>'part_id'),'[]') INTO cells
  FROM jsonb_array_elements(p.payload->'plan'->'arrivals')x;
 ELSE
  SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse_id',r.warehouse_id,'product_id',v.product_id,'quantity',v.quantity) ORDER BY v.product_id),'[]') INTO cells
  FROM(SELECT comp->>'product_id' product_id,sum((x->>'restocked')::bigint*(comp->>'quantity')::bigint) quantity
   FROM jsonb_array_elements(items)i JOIN jsonb_array_elements(q->'items')x ON x->>'item_id'=i->>'item_id'
   CROSS JOIN LATERAL jsonb_array_elements(i->'components')comp GROUP BY comp->>'product_id'
   HAVING sum((x->>'restocked')::bigint*(comp->>'quantity')::bigint)>0)v;
 END IF;
 IF jsonb_array_length(cells)>10000 OR octet_length((items||cells)::text)>16777216 THEN RAISE EXCEPTION 'Limit pełnego źródła zwrotu' USING ERRCODE='54000';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',pr.id,'sku',pr.sku,'name',pr.name) ORDER BY pr.id),'[]') INTO products_json
 FROM public.products pr WHERE pr.tenant_id=t AND pr.id IN(SELECT(x->>'product_id')::uuid FROM jsonb_array_elements(cells)x);
 f:=jsonb_build_object('return_case',to_jsonb(r),'items',items,'products',products_json,'request',q,'cells',cells,'preview_id',p.id,
  'plan',CASE WHEN protocol='destinations_v1' THEN p.payload->'plan' ELSE NULL END,'protocol',protocol,'requirements',g);
 RETURN f;
END $function$;
REVOKE ALL ON FUNCTION public.stock_verdict_return_frame(uid uuid, kid uuid, b jsonb) FROM PUBLIC,dyna_app;

CREATE FUNCTION public.stock_verdict_effect_prepare(uid uuid, kid uuid, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;strictids jsonb;eid uuid:=gen_random_uuid();s public.catalog_stock_control_series;d public.warehouse_documents;w uuid;kindj text;yr integer:=extract(year FROM transaction_timestamp());n bigint;num jsonb;f jsonb;old public.catalog_stock_control_effect_admissions;pv public.wms_previews;
BEGIN PERFORM public.stock_verdict_require();
 -- No public activation scopes are imposed on ordinary physical callers; their
 -- actual enclosing source IAM is enlisted by the trusted server adapter.
 IF uid IS NOT NULL AND NOT EXISTS(SELECT FROM public.memberships WHERE(tenant_id,user_id)=(t,uid) AND role IN('admin','operator')) THEN RAISE EXCEPTION 'Brak aktualnego operatora fizycznego efektu' USING ERRCODE='42501';END IF;
 IF b->>'source_kind' NOT IN('warehouse_document','purchase_receipt','dispatch','stocktake','location_operation','wms_movement','wms_receipt','return','wms_opening','catalog_import','inventory_import','manual_off_correction') THEN RAISE EXCEPTION 'Nieznane źródło fizyczne' USING ERRCODE='23514';END IF;

 IF b->>'source_kind'='manual_off_correction' AND NOT EXISTS(SELECT FROM public.manual_inventory_off_admissions ma JOIN public.manual_inventory_off_previews mp ON(mp.tenant_id,mp.id)=(ma.tenant_id,ma.preview_id)
 WHERE(ma.tenant_id,ma.id,ma.actor_id)=(t,(b->>'source_id')::uuid,uid) AND ma.api_key_id IS NOT DISTINCT FROM kid AND ma.root_xid=pg_current_xact_id()
 AND b=jsonb_build_object('source_kind','manual_off_correction','source_id',ma.id,'product_ids',jsonb_build_array(mp.request->'product_id'),'warehouse_ids',jsonb_build_array(mp.request->'warehouse_id')))
 THEN RAISE EXCEPTION 'Manual strict source requires genuine managed parent' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog.strict.lifecycle:'||t,0));
 SELECT coalesce(jsonb_agg(DISTINCT p.catalog_id ORDER BY p.catalog_id),'[]') INTO strictids FROM public.products p JOIN public.catalog_stock_control_policies h ON(h.tenant_id,h.catalog_id)=(p.tenant_id,p.catalog_id) WHERE p.tenant_id=t AND p.id IN(SELECT v::uuid FROM jsonb_array_elements_text(b->'product_ids')v);
 IF jsonb_array_length(strictids)=0 THEN RETURN NULL;END IF;
 FOR w IN SELECT v::uuid FROM jsonb_array_elements_text(b->'warehouse_ids')v ORDER BY v LOOP PERFORM public.warehouse_inventory_policy_lock(t,w);END LOOP;
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog.strict.quota:'||t,0));
 SELECT * INTO old FROM public.catalog_stock_control_effect_admissions WHERE(tenant_id,source_kind,source_id)=(t,b->>'source_kind',(b->>'source_id')::uuid);
 IF old.id IS NOT NULL THEN IF old.sealed THEN RETURN NULL;END IF;IF old.txid<>pg_current_xact_id() OR old.actor_id IS DISTINCT FROM uid OR old.api_key_id IS DISTINCT FROM kid OR old.request<>b THEN RAISE EXCEPTION 'Inne przyjęcie fizycznego źródła' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('id',old.id,'tenant_id',t,'source',b,'strict_catalog_ids',strictids,'number',old.number);END IF;
 IF b->>'source_kind'='warehouse_document' THEN SELECT * INTO d FROM public.warehouse_documents WHERE(tenant_id,id)=(t,(b->>'source_id')::uuid);IF d.id IS NULL OR d.status<>'draft' THEN RAISE EXCEPTION 'Historyczne źródło nie otrzyma nowego numeru' USING ERRCODE='23514';END IF;kindj:=CASE d.kind WHEN 'receipt' THEN 'PZ' WHEN 'transfer' THEN 'MM' WHEN 'issue' THEN 'WZ' END;IF kindj IS NULL THEN RAISE EXCEPTION 'Pomiar strict wymaga PW/RW' USING ERRCODE='23514';END IF;
 INSERT INTO public.catalog_stock_control_series(id,tenant_id,warehouse_id,kind,name,prefix) VALUES(gen_random_uuid(),t,d.warehouse_id,kindj,kindj,kindj) ON CONFLICT(tenant_id,warehouse_id,kind) DO NOTHING;
 SELECT * INTO s FROM public.catalog_stock_control_series WHERE(tenant_id,warehouse_id,kind)=(t,d.warehouse_id,kindj) FOR UPDATE;
 n:=public.catalog_stock_control_next(t,s.id,yr);
 num:=jsonb_build_object('kind',kindj,'number',s.prefix||'/'||yr||'/'||(CASE WHEN length(n::text)>=6 THEN n::text ELSE lpad(n::text,6,'0') END),'series_id',s.id,'year',yr,'sequence',n::text);END IF;
 IF b->>'source_kind' IN('purchase_receipt','wms_receipt') THEN SELECT v::uuid INTO w FROM jsonb_array_elements_text(b->'warehouse_ids')v;IF jsonb_array_length(b->'warehouse_ids')<>1 THEN RAISE EXCEPTION 'Przyjęcie dostawy ma jeden rzeczywisty magazyn' USING ERRCODE='23514';END IF;INSERT INTO public.catalog_stock_control_series(id,tenant_id,warehouse_id,kind,name,prefix) VALUES(gen_random_uuid(),t,w,'PZ','PZ','PZ') ON CONFLICT(tenant_id,warehouse_id,kind) DO NOTHING;SELECT * INTO s FROM public.catalog_stock_control_series WHERE(tenant_id,warehouse_id,kind)=(t,w,'PZ') FOR UPDATE;n:=public.catalog_stock_control_next(t,s.id,yr);num:=jsonb_build_object('kind','PZ','number',s.prefix||'/'||yr||'/'||(CASE WHEN length(n::text)>=6 THEN n::text ELSE lpad(n::text,6,'0') END),'series_id',s.id,'year',yr,'sequence',n::text);END IF;
 IF b->>'source_kind'='wms_movement' THEN SELECT * INTO pv FROM public.wms_previews WHERE(tenant_id,id,actor_id)=(t,(b->>'source_id')::uuid,uid);IF pv.id IS NULL OR NOT pv.ready OR pv.expires_at<=clock_timestamp() OR pv.kind NOT IN('issue','transfer','bin_move','adjustment') OR b->'product_ids'<>jsonb_build_array(pv.request->'product_id') OR b->'warehouse_ids'<>(SELECT jsonb_agg(v ORDER BY v#>>'{}') FROM jsonb_array_elements(jsonb_build_array(pv.request->'warehouse_id')||CASE WHEN pv.kind='transfer' THEN jsonb_build_array(pv.request->'destination_warehouse_id') ELSE '[]'::jsonb END)v) THEN RAISE EXCEPTION 'Brak własnego gotowego źródła ruchu WMS lub strict PW/RW' USING ERRCODE='23514';END IF;kindj:=CASE pv.kind WHEN 'issue' THEN 'WZ' WHEN 'transfer' THEN 'MM' WHEN 'adjustment' THEN CASE WHEN (pv.request->>'quantity')::integer>0 THEN 'PW' ELSE 'RW' END END;IF kindj IS NOT NULL THEN w:=(pv.request->>'warehouse_id')::uuid;INSERT INTO public.catalog_stock_control_series(id,tenant_id,warehouse_id,kind,name,prefix) VALUES(gen_random_uuid(),t,w,kindj,kindj,kindj) ON CONFLICT(tenant_id,warehouse_id,kind) DO NOTHING;SELECT * INTO s FROM public.catalog_stock_control_series WHERE(tenant_id,warehouse_id,kind)=(t,w,kindj) FOR UPDATE;n:=public.catalog_stock_control_next(t,s.id,yr);num:=jsonb_build_object('kind',kindj,'number',s.prefix||'/'||yr||'/'||(CASE WHEN length(n::text)>=6 THEN n::text ELSE lpad(n::text,6,'0') END),'series_id',s.id,'year',yr,'sequence',n::text);END IF;END IF;
 IF b->>'source_kind'='wms_opening' AND EXISTS(SELECT FROM public.wms_operations o JOIN public.wms_policies h
  ON(h.tenant_id,h.opening_operation_id)=(o.tenant_id,o.id) WHERE o.tenant_id=t AND o.kind='opening'
  AND o.request->>'preview_id'=b->>'source_id') THEN RETURN NULL;END IF;
 IF b->>'source_kind'='wms_opening' THEN
  SELECT * INTO pv FROM public.wms_previews WHERE(tenant_id,id,actor_id)=(t,(b->>'source_id')::uuid,uid);
  IF pv.id IS NULL OR pv.kind<>'opening' OR NOT pv.ready OR pv.expires_at<=clock_timestamp() OR pv.policy_version<>0
   OR b->'product_ids' IS DISTINCT FROM(SELECT jsonb_agg(v ORDER BY v) FROM(SELECT DISTINCT r->>'product_id' v FROM jsonb_array_elements(pv.snapshot->'rows')r)x)
   OR b->'warehouse_ids' IS DISTINCT FROM(SELECT jsonb_agg(v ORDER BY v) FROM(SELECT DISTINCT r->>'warehouse_id' v FROM jsonb_array_elements(pv.snapshot->'rows')r)x)
   OR EXISTS(SELECT FROM public.wms_policies WHERE tenant_id=t)
   OR EXISTS(SELECT FROM public.wms_lots WHERE tenant_id=t)
   OR EXISTS(SELECT FROM public.wms_cost_layers WHERE tenant_id=t)
   OR EXISTS(SELECT FROM public.wms_layer_positions WHERE tenant_id=t)
  THEN RAISE EXCEPTION 'Otwarcie strict wymaga własnego pełnego źródła WMS OFF' USING ERRCODE='23514';END IF;
 END IF;
 f:=public.catalog_stock_control_effect_frame(b);
 INSERT INTO public.catalog_stock_control_effect_admissions(id,tenant_id,actor_id,api_key_id,source_kind,source_id,request,before_frame,number) VALUES(eid,t,uid,kid,b->>'source_kind',(b->>'source_id')::uuid,b,f,num);
 RETURN jsonb_build_object('id',eid,'tenant_id',t,'source',b,'strict_catalog_ids',strictids,'number',num);END $function$;
REVOKE ALL ON FUNCTION public.stock_verdict_effect_prepare(uid uuid, kid uuid, b jsonb) FROM PUBLIC,dyna_app;

CREATE FUNCTION public.stock_verdict_effect_finish(uid uuid, kid uuid, eid uuid, b jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET "TimeZone" TO 'UTC'
AS $function$ DECLARE a public.catalog_stock_control_effect_admissions;BEGIN PERFORM public.stock_verdict_require();SELECT * INTO a FROM public.catalog_stock_control_effect_admissions WHERE id=eid FOR UPDATE;IF a.actor_id IS DISTINCT FROM uid OR a.api_key_id IS DISTINCT FROM kid OR a.txid<>pg_current_xact_id() OR a.sealed THEN RAISE EXCEPTION 'Obcy lub zamknięty efekt strict' USING ERRCODE='23514';END IF;IF a.source_kind='wms_movement' AND EXISTS(SELECT FROM public.wms_previews WHERE(tenant_id,id)=(a.tenant_id,a.source_id) AND kind='adjustment') THEN b:=b||jsonb_build_object('correction_document',public.catalog_stock_control_wms_correction_build(eid,b));END IF;INSERT INTO public.catalog_stock_control_effects VALUES(a.tenant_id,a.id,b,public.catalog_stock_control_effect_frame(a.request),(b->>'warehouse_document_id')::uuid,(b->>'operation_id')::uuid,CASE WHEN a.source_kind='purchase_receipt' THEN(b->>'receipt_id')::uuid END,CASE WHEN a.source_kind='dispatch' THEN(b->>'receipt_id')::uuid END,CASE WHEN a.source_kind='stocktake' THEN(b->>'receipt_id')::uuid END,(b->>'location_operation_id')::uuid,CASE WHEN a.source_kind='inventory_import' THEN(b->>'receipt_id')::uuid END);INSERT INTO public.catalog_stock_control_effect_journals SELECT a.tenant_id,a.id,'stock',v::uuid,v::uuid,NULL::uuid,NULL::uuid FROM jsonb_array_elements_text(b->'stock_movement_ids')v UNION ALL SELECT a.tenant_id,a.id,'bin',v::uuid,NULL::uuid,v::uuid,NULL::uuid FROM jsonb_array_elements_text(b->'location_movement_ids')v UNION ALL SELECT a.tenant_id,a.id,'layer',v::uuid,NULL::uuid,NULL::uuid,v::uuid FROM jsonb_array_elements_text(b->'layer_movement_ids')v;PERFORM public.catalog_stock_control_effect_validate(eid);UPDATE public.catalog_stock_control_effect_admissions SET sealed=true WHERE id=eid;END $function$;
REVOKE ALL ON FUNCTION public.stock_verdict_effect_finish(uid uuid, kid uuid, eid uuid, b jsonb) FROM PUBLIC,dyna_app;

CREATE FUNCTION public.stock_verdict_return_prepare(uid uuid, kid uuid, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;f jsonb;fresh jsonb;descriptor jsonb;token jsonb;
 w uuid;s public.catalog_stock_control_series;n bigint;yr integer:=extract(year FROM transaction_timestamp());numbers jsonb:='[]';
BEGIN
 PERFORM public.stock_verdict_return_require();f:=public.stock_verdict_return_frame(uid,kid,b);
 IF f->'historical'='true'::jsonb OR jsonb_array_length(f->'cells')=0 THEN RETURN NULL;END IF;
 descriptor:=jsonb_build_object('source_kind','return','source_id',b->>'return_id',
  'warehouse_ids',(SELECT jsonb_agg(v ORDER BY v) FROM(SELECT DISTINCT x->>'warehouse_id'v FROM jsonb_array_elements(f->'cells')x)a),
  'product_ids',(SELECT jsonb_agg(v ORDER BY v) FROM(SELECT DISTINCT x->>'product_id'v FROM jsonb_array_elements(f->'cells')x)a));
 token:=public.stock_verdict_effect_prepare(uid,kid,descriptor);
 IF token IS NULL THEN RETURN NULL;END IF;
 fresh:=public.stock_verdict_return_frame(uid,kid,b);
 IF f IS DISTINCT FROM fresh THEN RAISE EXCEPTION 'Źródło RMA zmieniło się podczas oczekiwania' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.catalog_stock_return_admissions WHERE(tenant_id,id)=(t,(token->>'id')::uuid)) THEN
  RAISE EXCEPTION 'Powtórne przygotowanie nie jest ponownym przyjęciem' USING ERRCODE='23514';END IF;
 FOR w IN SELECT DISTINCT(x->>'warehouse_id')::uuid FROM jsonb_array_elements(f->'cells')x ORDER BY 1 LOOP
  INSERT INTO public.catalog_stock_control_series(id,tenant_id,warehouse_id,kind,name,prefix)
   VALUES(gen_random_uuid(),t,w,'PZ','PZ','PZ') ON CONFLICT(tenant_id,warehouse_id,kind) DO NOTHING;
  SELECT * INTO s FROM public.catalog_stock_control_series WHERE(tenant_id,warehouse_id,kind)=(t,w,'PZ') FOR UPDATE;
  n:=public.catalog_stock_control_next(t,s.id,yr);
  numbers:=numbers||jsonb_build_array(jsonb_build_object('warehouse_id',w,'series_id',s.id,'series',to_jsonb(s),'year',yr,
   'sequence',n::text,'number',s.prefix||'/'||yr||'/'||(CASE WHEN length(n::text)>=6 THEN n::text ELSE lpad(n::text,6,'0') END)));
 END LOOP;
 INSERT INTO public.catalog_stock_return_admissions(id,tenant_id,return_id,order_id,actor_id,api_key_id,protocol,preview_id,frame,numbers)
 VALUES((token->>'id')::uuid,t,(b->>'return_id')::uuid,(f->'return_case'->>'order_id')::uuid,uid,kid,b->>'protocol',(b->>'preview_id')::uuid,f,numbers);
 RETURN jsonb_build_object('id',token->>'id','tenant_id',t,'return_id',b->>'return_id','protocol',b->>'protocol',
  'requirements',fresh->'requirements');
END $function$;
REVOKE ALL ON FUNCTION public.stock_verdict_return_prepare(uid uuid, kid uuid, b jsonb) FROM PUBLIC,dyna_app;
