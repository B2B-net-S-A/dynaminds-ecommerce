-- Migration 263_manual_off_verdict (prepared as 281, registered after 262_revoke_public_temporary; no object name contains
-- the number). docs/parity/MANUAL-OFF-GEN281-20261030.md "Integracja jako 263".
-- A new owner-only generation of the manual OFF PW/RW correction functions (169) whose sealed bodies run the full
-- manual_inventory_off_valid() (~0.25 s idle on the full dataset) through manual_inventory_off_require(): source 1,
-- preview 3, apply 2 plus one catalog_stock_control_guards() in catalog_stock_control_effect_prepare, on top of the
-- three TS calls of every request (profile: 14 full guards per load-driver stock_operation of tenants without WMS lots).
--   manual_off_verdict_valid()                 the guard: READ COMMITTED and catalog_stock_control_guards() still the sealed
--                                              body (prosrc sha256 pinned below) whose only true exit is
--                                              RETURN public.manual_inventory_off_valid(): true when
--                                              guard_verdict('catalog_stock_control_guards') (248) is true; otherwise,
--                                              and always outside READ COMMITTED, manual_inventory_off_valid() itself;
--   manual_off_verdict_require()               = manual_inventory_off_require(), asking manual_off_verdict_valid();
--   manual_off_verdict_frame(...)              = manual_inventory_off_frame(...), with manual_off_verdict_require();
--   manual_off_verdict_preview(...)            = manual_inventory_off_preview(...), with the require and frame copies;
--   manual_off_verdict_preview_can_apply(...)  = manual_inventory_off_preview_can_apply(...), with the frame copy;
--   manual_off_verdict_apply(...)              = manual_inventory_off_apply(...), with the require and frame copies and the
--                                              255 copies stock_verdict_effect_prepare/_finish of the catalog adapters.
-- Each copy body is the sealed original's prosrc (pg_get_functiondef on a clone at 262) with only those calls swapped; the
-- declarations (arguments, result, SECURITY DEFINER, search_path, TimeZone, owner, owner-only EXECUTE) are the same.
-- The sealed functions are not replaced, altered or granted, and stay for every other caller and before 263. No name
-- falls in a sealed family (starts_with(proname,'manual_inventory_off_') and the LIKE scans of catalog_stock_*, return_*,
-- ...), so no fingerprint, certificate or guard pin moves; the copies are covered by the cold catalogue contract at
-- startup and the ordinary184 generation check per transaction, like the 236/239/248/255/256 functions.
CREATE FUNCTION public.manual_off_verdict_valid()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 -- catalog_stock_control_guards() returns false from every other branch and true only as manual_inventory_off_valid(), so a
 -- true verdict for it (248: the full guard's value at this committed generation and basis, whose 16 tables include
 -- manual_inventory_off_certificate) is a true manual_inventory_off_valid(). Any other body, language, isolation or answer:
 -- the full manual OFF guard answers (the same value or error). An error of the full catalog guard on a verdict miss is
 -- raised as it is (a refusal where manual_inventory_off_valid() alone might have answered; never a true).
 IF pg_catalog.current_setting('transaction_isolation')='read committed'
  AND (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex') FROM pg_catalog.pg_proc p
   WHERE p.oid=pg_catalog.to_regprocedure('public.catalog_stock_control_guards()')
    AND p.prolang=(SELECT l.oid FROM pg_catalog.pg_language l WHERE l.lanname='plpgsql'))
   ='ef9c31fbabca36776256efe76dcd16265c9f742ce4a64cbd7cc000c056baf225' THEN
  IF public.guard_verdict('catalog_stock_control_guards') IS TRUE THEN RETURN true;END IF;
 END IF;
 RETURN public.manual_inventory_off_valid();
END $function$;
REVOKE ALL ON FUNCTION public.manual_off_verdict_valid() FROM PUBLIC,dyna_app;

CREATE FUNCTION public.manual_off_verdict_require()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$BEGIN IF NOT manual_off_verdict_valid() THEN RAISE EXCEPTION 'Incomplete manual OFF family' USING ERRCODE='55000';END IF;END$function$;
REVOKE ALL ON FUNCTION public.manual_off_verdict_require() FROM PUBLIC,dyna_app;

CREATE FUNCTION public.manual_off_verdict_frame(pid uuid, wh uuid, locking boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p public.products;w public.warehouses;s public.stock;policy jsonb;bins jsonb;holds jsonb;raw jsonb;src jsonb;series jsonb;
BEGIN
 PERFORM manual_off_verdict_require();
 IF locking THEN policy:=warehouse_inventory_policy_lock(t,wh);ELSE policy:=warehouse_inventory_policy(t,wh);END IF;
 IF policy->>'usage'<>'sale' OR policy->'enabled'<>'true'::jsonb THEN RAISE EXCEPTION 'Manual correction requires active sale warehouse' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM wms_policies WHERE tenant_id=t AND enabled) THEN RAISE EXCEPTION 'Use genuine WMS correction parent' USING ERRCODE='23514';END IF;
 IF locking THEN SELECT * INTO p FROM products WHERE(tenant_id,id)=(t,pid) FOR SHARE;SELECT * INTO w FROM warehouses WHERE(tenant_id,id)=(t,wh) FOR SHARE;
 SELECT * INTO s FROM stock WHERE(tenant_id,warehouse_id,product_id)=(t,wh,pid) FOR UPDATE;
 PERFORM 1 FROM stock_locations WHERE(tenant_id,warehouse_id,product_id)=(t,wh,pid) ORDER BY location COLLATE "C" FOR UPDATE;
 -- Freeze actual allocation scan/state fields through the final IAM waits. Native parcel writers use stock -> reservation -> location order.
 PERFORM 1 FROM reservations r WHERE(r.tenant_id,r.warehouse_id,r.product_id)=(t,wh,pid) ORDER BY r.order_id FOR SHARE;
 PERFORM 1 FROM reservation_locations q WHERE(q.tenant_id,q.warehouse_id,q.product_id)=(t,wh,pid) ORDER BY q.order_id,q.location COLLATE "C" FOR SHARE;
 ELSE SELECT * INTO p FROM products WHERE(tenant_id,id)=(t,pid);SELECT * INTO w FROM warehouses WHERE(tenant_id,id)=(t,wh);SELECT * INTO s FROM stock WHERE(tenant_id,warehouse_id,product_id)=(t,wh,pid);END IF;
 IF p.id IS NULL OR w.id IS NULL OR s.product_id IS NULL THEN RAISE EXCEPTION 'Own physical cell missing' USING ERRCODE='P0002';END IF;
 IF p.kind<>'simple' OR EXISTS(SELECT FROM bundle_components WHERE tenant_id=t AND bundle_id=pid) THEN RAISE EXCEPTION 'Manual correction supports genuine simple physical product' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT FROM stock_locations WHERE(tenant_id,warehouse_id,product_id,location)=(t,wh,pid,s.location)) THEN RAISE EXCEPTION 'Existing default bin required' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.order_id,a.location),'[]') INTO holds FROM reservation_locations a JOIN reservations z USING(tenant_id,order_id,product_id,warehouse_id) WHERE(a.tenant_id,a.warehouse_id,a.product_id)=(t,wh,pid) AND z.state='active';
 SELECT coalesce(jsonb_agg(jsonb_build_object('location',b.location,'quantity',b.quantity,'reserved',coalesce(q.n,0),'available',b.quantity-coalesce(q.n,0)) ORDER BY b.location COLLATE "C"),'[]') INTO bins FROM stock_locations b
 LEFT JOIN LATERAL(SELECT sum(a.quantity-coalesce(a.consumed_quantity,0)) n FROM reservation_locations a JOIN reservations z USING(tenant_id,order_id,product_id,warehouse_id) WHERE(a.tenant_id,a.warehouse_id,a.product_id,a.location)=(t,wh,pid,b.location) AND z.state='active') q ON true WHERE(b.tenant_id,b.warehouse_id,b.product_id)=(t,wh,pid);
 IF jsonb_array_length(bins)>1000 OR jsonb_array_length(holds)>10000 THEN RAISE EXCEPTION 'Whole manual source budget' USING ERRCODE='54000';END IF;
 SELECT jsonb_build_object('PW',(SELECT jsonb_build_object('series_id',id,'version',version::text) FROM manual_inventory_off_series WHERE(tenant_id,warehouse_id,kind)=(t,wh,'PW')),
 'RW',(SELECT jsonb_build_object('series_id',id,'version',version::text) FROM manual_inventory_off_series WHERE(tenant_id,warehouse_id,kind)=(t,wh,'RW'))) INTO series;
 src:=jsonb_build_object('protocol','manual_off_pw_rw_v1','product',jsonb_build_object('id',pid,'sku',p.sku,'name',p.name,'catalog_id',p.catalog_id),
 'warehouse',jsonb_build_object('id',wh,'name',w.name,'code',w.code,'inventory_policy_version',policy->'version'),
 'wms_policy',jsonb_build_object('enabled',false,'version',coalesce((SELECT version::text FROM wms_policies WHERE tenant_id=t),'0')),
 'stock',jsonb_build_object('version',s.version::text,'on_hand',s.on_hand,'reserved',s.reserved,'available',s.available,'default_location',s.location),'bins',bins,'numbering',series);
 raw:=jsonb_build_object('product',to_jsonb(p),'warehouse',to_jsonb(w),'stock',to_jsonb(s),'bins',(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.location COLLATE "C") FROM stock_locations b WHERE(b.tenant_id,b.warehouse_id,b.product_id)=(t,wh,pid)),
 'allocations',holds,'warehouse_policy',policy,'wms_policy',(SELECT to_jsonb(h) FROM wms_policies h WHERE h.tenant_id=t),'numbering',series);
 IF octet_length(raw::text)>4194304 THEN RAISE EXCEPTION 'Whole manual source byte budget' USING ERRCODE='54000';END IF;
 RETURN jsonb_build_object('raw',raw,'source',src||jsonb_build_object('revision',manual_inventory_off_hash(raw)));END$function$;
REVOKE ALL ON FUNCTION public.manual_off_verdict_frame(pid uuid, wh uuid, locking boolean) FROM PUBLIC,dyna_app;

CREATE FUNCTION public.manual_off_verdict_preview(u uuid, k uuid, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p public.manual_inventory_off_previews;f jsonb;projection jsonb;nowat timestamptz:=clock_timestamp();BEGIN
 PERFORM manual_off_verdict_require();
 PERFORM warehouse_inventory_policy_lock(t,(b->>'warehouse_id')::uuid);
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog.strict.quota:'||t,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('manual.off.quota:'||t,0));
 SELECT * INTO p FROM manual_inventory_off_previews WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF p.id IS NOT NULL THEN IF p.actor_id<>u OR p.api_key_id IS DISTINCT FROM k OR p.request<>b THEN RAISE EXCEPTION 'Manual preview key conflict' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('preview',manual_inventory_off_preview_view(p.id),'reused',true);END IF;
 f:=manual_off_verdict_frame((b->>'product_id')::uuid,(b->>'warehouse_id')::uuid,true);
 IF f#>>'{source,revision}' IS DISTINCT FROM b->>'revision' THEN RAISE EXCEPTION 'Manual source changed' USING ERRCODE='40001';END IF;
 projection:=manual_inventory_off_projection(f,b);
 INSERT INTO manual_inventory_off_previews(id,tenant_id,actor_id,api_key_id,client_key,request,scope_hash,frame,projection,year,created_at,expires_at)
 VALUES(gen_random_uuid(),t,u,k,(b->>'client_key')::uuid,b,manual_inventory_off_hash(jsonb_build_object('request',b,'frame',f,'projection',projection)),f,projection,extract(year FROM nowat),nowat,nowat+interval '15 minutes') RETURNING * INTO p;
 RETURN jsonb_build_object('preview',manual_inventory_off_preview_view(p.id),'reused',false);END$function$;
REVOKE ALL ON FUNCTION public.manual_off_verdict_preview(u uuid, k uuid, b jsonb) FROM PUBLIC,dyna_app;

CREATE FUNCTION public.manual_off_verdict_preview_can_apply(pid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE p public.manual_inventory_off_previews;BEGIN SELECT * INTO p FROM manual_inventory_off_previews WHERE(tenant_id,id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,pid);
 IF p.id IS NULL OR clock_timestamp()>=p.expires_at OR extract(year FROM clock_timestamp())<>p.year OR EXISTS(SELECT FROM manual_inventory_off_receipts WHERE(tenant_id,preview_id)=(p.tenant_id,pid)) THEN RETURN false;END IF;
 RETURN p.frame=manual_off_verdict_frame((p.request->>'product_id')::uuid,(p.request->>'warehouse_id')::uuid,false);
 EXCEPTION WHEN check_violation OR no_data_found THEN RETURN false;END$function$;
REVOKE ALL ON FUNCTION public.manual_off_verdict_preview_can_apply(pid uuid) FROM PUBLIC,dyna_app;

CREATE FUNCTION public.manual_off_verdict_apply(u uuid, k uuid, pid uuid, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p public.manual_inventory_off_previews;a public.manual_inventory_off_admissions;r public.manual_inventory_off_receipts;s public.manual_inventory_off_series;
 f jsonb;rid uuid:=gen_random_uuid();sm uuid:=gen_random_uuid();bm uuid:=gen_random_uuid();effect jsonb;doc jsonb;pay jsonb;n bigint;d integer;nowat timestamptz;BEGIN
 PERFORM manual_off_verdict_require();
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Manual consent must be object' USING ERRCODE='23514';END IF;
 IF b<>jsonb_build_object('client_key',(b->>'client_key')::uuid,'scope_hash',b->>'scope_hash','confirmed',true) THEN RAISE EXCEPTION 'Explicit separate manual consent required' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM manual_inventory_off_previews WHERE(tenant_id,id)=(t,pid);IF p.id IS NULL THEN RAISE EXCEPTION 'Own manual preview missing' USING ERRCODE='P0002';END IF;
 PERFORM warehouse_inventory_policy_lock(t,(p.request->>'warehouse_id')::uuid);
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog.strict.quota:'||t,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('manual.off.quota:'||t,0));
 SELECT * INTO a FROM manual_inventory_off_admissions WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF a.id IS NOT NULL THEN IF(a.preview_id,a.actor_id,a.api_key_id,a.request) IS DISTINCT FROM(pid,u,k,b) THEN RAISE EXCEPTION 'Manual receipt key conflict' USING ERRCODE='23514';END IF;
 PERFORM manual_inventory_off_validate(a.id,false);RETURN jsonb_build_object('receipt',(SELECT payload FROM manual_inventory_off_receipts WHERE(tenant_id,id)=(t,a.id)),'reused',true);END IF;
 SELECT * INTO p FROM manual_inventory_off_previews WHERE(tenant_id,id)=(t,pid) FOR SHARE;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Own manual preview missing' USING ERRCODE='P0002';END IF;
 IF(p.actor_id,p.api_key_id) IS DISTINCT FROM(u,k) OR p.scope_hash<>b->>'scope_hash' OR p.client_key=(b->>'client_key')::uuid
 OR EXISTS(SELECT FROM manual_inventory_off_receipts WHERE(tenant_id,preview_id)=(t,pid)) THEN RAISE EXCEPTION 'Preview custody/consent changed' USING ERRCODE='23514';END IF;
 nowat:=clock_timestamp();IF nowat>=p.expires_at OR extract(year FROM nowat)<>p.year THEN RAISE EXCEPTION 'Manual preview expired/year changed' USING ERRCODE='40001';END IF;
 f:=manual_off_verdict_frame((p.request->>'product_id')::uuid,(p.request->>'warehouse_id')::uuid,true);
 IF f<>p.frame OR manual_inventory_off_projection(f,p.request)<>p.projection THEN RAISE EXCEPTION 'Manual full source changed' USING ERRCODE='40001';END IF;
 INSERT INTO manual_inventory_off_admissions(id,tenant_id,preview_id,actor_id,api_key_id,client_key,request) VALUES(rid,t,pid,u,k,(b->>'client_key')::uuid,b);
 effect:=stock_verdict_effect_prepare(u,k,jsonb_build_object('source_kind','manual_off_correction','source_id',rid,'product_ids',jsonb_build_array(p.request->'product_id'),'warehouse_ids',jsonb_build_array(p.request->'warehouse_id')));
 IF effect IS NOT NULL THEN UPDATE manual_inventory_off_admissions SET strict_effect_id=(effect->>'id')::uuid WHERE id=rid;END IF;
 INSERT INTO manual_inventory_off_series(id,tenant_id,warehouse_id,kind,prefix) VALUES(gen_random_uuid(),t,(p.request->>'warehouse_id')::uuid,p.projection->>'kind',(p.projection->>'kind')||'-M') ON CONFLICT(tenant_id,warehouse_id,kind) DO NOTHING;
 SELECT * INTO s FROM manual_inventory_off_series WHERE(tenant_id,warehouse_id,kind)=(t,(p.request->>'warehouse_id')::uuid,p.projection->>'kind') FOR SHARE;
 INSERT INTO manual_inventory_off_counters VALUES(t,s.id,p.year,1) ON CONFLICT(tenant_id,series_id,year) DO UPDATE SET value=manual_inventory_off_counters.value+1 RETURNING value INTO n;
 d:=(p.request->>'delta')::integer;
 UPDATE stock_locations SET quantity=quantity+d WHERE(tenant_id,warehouse_id,product_id,location)=(t,(p.request->>'warehouse_id')::uuid,(p.request->>'product_id')::uuid,p.request->>'location');
 INSERT INTO stock_location_movements(id,tenant_id,warehouse_id,product_id,location,delta,kind,operation_id,note) VALUES(bm,t,(p.request->>'warehouse_id')::uuid,(p.request->>'product_id')::uuid,p.request->>'location',d,'manual_off_correction',rid,p.request->>'note');
 UPDATE stock SET on_hand=on_hand+d WHERE(tenant_id,warehouse_id,product_id)=(t,(p.request->>'warehouse_id')::uuid,(p.request->>'product_id')::uuid);
 INSERT INTO stock_movements(id,tenant_id,warehouse_id,product_id,delta,kind,note) VALUES(sm,t,(p.request->>'warehouse_id')::uuid,(p.request->>'product_id')::uuid,d,'manual_off_correction',p.request->>'note');
 nowat:=clock_timestamp();doc:=jsonb_build_object('id',rid,'number',s.prefix||'/'||p.year||'/'||CASE WHEN length(n::text)>=6 THEN n::text ELSE lpad(n::text,6,'0') END,'kind',s.kind,'series_id',s.id,'year',p.year,'sequence',n::text,'warehouse_id',s.warehouse_id,
 'rows',jsonb_build_array(jsonb_build_object('ordinal',0,'product_id',p.request->'product_id','sku',f#>'{source,product,sku}','name',f#>'{source,product,name}','location',p.request->'location','delta',d,'quantity',abs(d))),'valuation',p.projection->'valuation');
 pay:=jsonb_build_object('id',rid,'preview_id',pid,'client_key',b->'client_key','protocol','manual_off_pw_rw_v1','request',p.request,'scope_hash',p.scope_hash,'source',p.frame->'source','projection',p.projection,'document',doc,'journals',jsonb_build_object('stock_movement_id',sm,'location_movement_id',bm),'created_at',to_char(nowat AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 INSERT INTO manual_inventory_off_receipts VALUES(rid,t,pid,(b->>'client_key')::uuid,s.id,p.year,n,sm,bm,pay,nowat);
 IF effect IS NOT NULL THEN PERFORM stock_verdict_effect_finish(u,k,(effect->>'id')::uuid,jsonb_build_object('manual_receipt_id',rid,'stock_movement_ids',jsonb_build_array(sm),'location_movement_ids',jsonb_build_array(bm),'layer_movement_ids','[]'::jsonb));END IF;
 PERFORM manual_inventory_off_validate(rid,true);
 INSERT INTO audit_events(id,tenant_id,user_id,action,entity_id,detail) VALUES(gen_random_uuid(),t,u,'inventory.manual_off.post',rid,'{}'::jsonb);
 RETURN jsonb_build_object('receipt',pay,'reused',false);END$function$;
REVOKE ALL ON FUNCTION public.manual_off_verdict_apply(u uuid, k uuid, pid uuid, b jsonb) FROM PUBLIC,dyna_app;
