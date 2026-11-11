-- SOURCE_DRAFT assembled reserved168; root parser/native gates NOT_RUN.

-- FRAGMENT: certificate-preflight.sql
-- FIRST fragment in the future owner managed migration; not standalone.
SET LOCAL TimeZone='UTC';
DO $$BEGIN
 IF to_regclass('public.warehouse_wz_issuer_manifest') IS NULL OR to_regclass('public.operative_delivery_certificate') IS NULL
 OR to_regprocedure('public.warehouse_wz_issuer_guards()') IS NULL OR to_regprocedure('public.operative_delivery_valid()') IS NULL
 THEN RAISE EXCEPTION 'Physical WZ needs complete151/167 predecessors' USING ERRCODE='55000';END IF;
 IF current_user IS DISTINCT FROM session_user OR current_user IS DISTINCT FROM(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.warehouse_wz_issuer_manifest'::regclass)
 OR current_user IS DISTINCT FROM(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.operative_delivery_certificate'::regclass)
 OR NOT EXISTS(SELECT FROM migrations WHERE name='167_operational_delivery_consumers') OR NOT warehouse_wz_issuer_guards() OR NOT operative_delivery_valid()
 OR EXISTS(SELECT FROM migrations WHERE name='168_physical_parcel_wz')
 OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'parcel_physical_wz_'))
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'parcel_physical_wz_'))
 OR EXISTS(SELECT FROM pg_trigger WHERE starts_with(tgname,'parcel_physical_wz_'))
 THEN RAISE EXCEPTION 'Physical WZ requires genuine exact owner predecessor' USING ERRCODE='55000';END IF;
END $$;
LOCK TABLE warehouse_wz_issuer_manifest IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE parcel_physical_wz_install_basis ON COMMIT DROP AS
 SELECT pg_current_xact_id()::text root_xid,transaction_timestamp() start_at,pg_backend_pid() backend_pid,current_user::text owner_name,
 to_jsonb(m) original151_manifest,warehouse_wz_issuer_fingerprint() predecessor_fingerprint,
 to_jsonb(c) original167_certificate,NULL::jsonb predecessor_functions,NULL::jsonb predecessor_triggers
 FROM warehouse_wz_issuer_manifest m CROSS JOIN operative_delivery_certificate c;
REVOKE ALL ON pg_temp.parcel_physical_wz_install_basis FROM PUBLIC,dyna_app;

-- FRAGMENT: native-kernel.sql
-- SOURCE_DRAFT, NOT_REGISTERED, NOT_APPLY_READY. Max actual ledger/file167;
-- 168 is only the proposed next reservation, root must confirm before installation.
-- This kernel is a real native source/conservation algorithm. Apply ONLY as part
-- of the certified successor/managed producer/terminal described in CONTRACT.md.
-- No parent table DDL/user trigger, no modification of old payloads/receipts.
SET LOCAL TimeZone='UTC';
CREATE FUNCTION parcel_physical_wz_hash(j jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(j::text,'UTF8')),'hex')
$$;

-- No caller-supplied source history: owner SD reads actual frozen native rows.
-- Calling native134 lock is required; producer FIRST locks sorted inventory
-- policies for all frozen warehouse IDs, avoiding order->policy inversion.
CREATE FUNCTION parcel_physical_wz_frame(pid uuid,allocation jsonb,lock_source boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;plan_row public.order_parcel_plans;o public.orders;
 items jsonb;reservations jsonb;parcels jsonb;progress jsonb;src jsonb;basis jsonb;projected jsonb:='[]';mapped_parcel jsonb;unused_reservation jsonb;v jsonb;mapped_component jsonb;line jsonb;
 selected jsonb;counts jsonb;lines jsonb;entries integer:=0;
BEGIN
 SELECT * INTO plan_row FROM public.order_parcel_plans WHERE tenant_id=t AND id=pid;
 IF plan_row.id IS NULL THEN RAISE EXCEPTION 'Own physical plan not found' USING ERRCODE='P0002';END IF;
 IF plan_row.payload ? 'protocol' THEN RAISE EXCEPTION 'Mapping is only for physical_v1; commercial_v1 already has origins' USING ERRCODE='23514';END IF;
 IF lock_source THEN PERFORM public.order_parcel_lock(plan_row.order_id);END IF;
 SELECT * INTO o FROM public.orders WHERE(tenant_id,id)=(t,plan_row.order_id);
 --136 normalizes ONLY genuine historical simple empty recipes. No live catalog.
 items:=public.order_parcel_commercial_lines(plan_row.order_id);
 SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'warehouse_id',warehouse_id,'quantity',quantity,'consumed_quantity',consumed_quantity,'state',state) ORDER BY warehouse_id,product_id),'[]')
 INTO reservations FROM public.reservations WHERE tenant_id=t AND order_id=plan_row.order_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('parcel_index',l.index,'shipment_id',l.shipment_id,'products',
   (SELECT jsonb_agg(jsonb_build_object('product_id',z->'product_id','warehouse_id',z->'warehouse_id','quantity',z->'quantity') ORDER BY z->>'warehouse_id',z->>'product_id') FROM jsonb_array_elements(l.payload->'products') z)) ORDER BY l.index),'[]')
 INTO parcels FROM public.order_parcel_allocations l WHERE l.tenant_id=t AND l.plan_id=pid AND l.order_id=plan_row.order_id;
 -- Every prior physical product is re-derived from actual stock movement IDs,
 -- not a client progress flag or only the active reservation remainder.
 IF EXISTS(SELECT FROM public.order_parcel_dispatches d CROSS JOIN LATERAL jsonb_array_elements(d.receipt->'stock_movements') e
 LEFT JOIN public.stock_movements s ON(s.tenant_id,s.order_id,s.id)=(d.tenant_id,d.order_id,(e->>'id')::uuid)
 WHERE d.tenant_id=t AND d.plan_id=pid AND(s.id IS NULL OR s.kind<>'shipment' OR s.delta>=0 OR s.note IS DISTINCT FROM 'parcel:'||d.id::text
 OR(s.product_id,s.warehouse_id,-s.delta) IS DISTINCT FROM((e->>'product_id')::uuid,(e->>'warehouse_id')::uuid,(e->>'quantity')::integer)))
 THEN RAISE EXCEPTION 'Prior parcel receipt is not actual stock movement provenance' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.order_parcel_dispatches d WHERE d.tenant_id=t AND d.plan_id=pid AND d.order_id IS DISTINCT FROM plan_row.order_id)
 OR EXISTS(SELECT FROM public.order_parcel_dispatches d CROSS JOIN LATERAL jsonb_array_elements(d.receipt->'stock_movements') e
 WHERE d.tenant_id=t AND d.plan_id=pid GROUP BY e->>'id' HAVING count(*)<>1)
 THEN RAISE EXCEPTION 'Repeated or foreign-order historical movement' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('parcel_index',l.index,'shipment_id',l.shipment_id,
 'state',CASE WHEN d.id IS NOT NULL THEN 'dispatched' ELSE 'pending' END,'dispatch_id',d.id,
 'issued_products',coalesce((SELECT jsonb_agg(jsonb_build_object('product_id',s.product_id,'warehouse_id',s.warehouse_id,'quantity',-s.delta) ORDER BY s.warehouse_id,s.product_id)
 FROM jsonb_array_elements(d.receipt->'stock_movements') e JOIN public.stock_movements s ON(s.tenant_id,s.order_id,s.id)=(d.tenant_id,d.order_id,(e->>'id')::uuid)),'[]'::jsonb)) ORDER BY l.index),'[]')
 INTO progress FROM public.order_parcel_allocations l LEFT JOIN public.order_parcel_dispatches d ON(d.tenant_id,d.plan_id,d.parcel_index,d.shipment_id)=(l.tenant_id,l.plan_id,l.index,l.shipment_id)
 WHERE l.tenant_id=t AND l.plan_id=pid AND l.order_id=plan_row.order_id;
 IF EXISTS(SELECT FROM public.shipments sh JOIN public.order_parcel_allocations l ON(l.tenant_id,l.order_id,l.shipment_id)=(sh.tenant_id,sh.order_id,sh.id)
 WHERE l.tenant_id=t AND l.plan_id=pid AND (sh.status='cancelled' OR (sh.dispatched_at IS NOT NULL) IS DISTINCT FROM EXISTS(SELECT FROM public.order_parcel_dispatches d WHERE(d.tenant_id,d.plan_id,d.parcel_index)=(t,pid,l.index))))
 THEN RAISE EXCEPTION 'Cancelled or inconsistent physical progress is unsupported' USING ERRCODE='23514';END IF;
 src:=jsonb_build_object('tenant_id',t,'order_id',plan_row.order_id,'order_version',o.version::text,'plan_id',plan_row.id,'plan_scope_hash',plan_row.scope_hash,'protocol','physical_v1','currency',o.currency,'items',items,'reservations',reservations,'parcels',parcels,'progress',progress);
 IF EXISTS(SELECT FROM jsonb_array_elements(items) i WHERE(i->>'quantity')::numeric NOT BETWEEN 1 AND 1000000 OR(i->>'line_total')::numeric NOT BETWEEN 0 AND 9007199254740991 OR(i->>'vat')::numeric NOT BETWEEN 0 AND 100 OR i->>'currency' IS DISTINCT FROM o.currency OR length(i->>'name') NOT BETWEEN 1 AND 1000 OR length(i->>'sku') NOT BETWEEN 1 AND 1000)
 OR EXISTS(SELECT FROM jsonb_array_elements(items) i CROSS JOIN LATERAL jsonb_array_elements(i->'components') c WHERE(c->>'quantity')::numeric NOT BETWEEN 1 AND 1000000)
 THEN RAISE EXCEPTION 'Historical source exceeds supported exact domain' USING ERRCODE='54000';END IF;
 IF jsonb_array_length(parcels) NOT BETWEEN 2 AND 50 OR jsonb_array_length(items) NOT BETWEEN 1 AND 500 OR jsonb_array_length(reservations) NOT BETWEEN 1 AND 500
 OR(SELECT count(*) FROM jsonb_array_elements(parcels) p CROSS JOIN LATERAL jsonb_array_elements(p->'products') z)>500
 THEN RAISE EXCEPTION 'Full source extent budget' USING ERRCODE='54000';END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(items) i CROSS JOIN LATERAL jsonb_array_elements(i->'components') c WHERE(i->>'quantity')::numeric*(c->>'quantity')::numeric>1000000000)
 OR EXISTS(SELECT FROM jsonb_array_elements(parcels) p CROSS JOIN LATERAL jsonb_array_elements(p->'products') z GROUP BY z->>'warehouse_id',z->>'product_id' HAVING sum((z->>'quantity')::numeric)>1000000000)
 OR EXISTS(SELECT FROM jsonb_array_elements(items) i CROSS JOIN LATERAL jsonb_array_elements(i->'components') c GROUP BY c->>'product_id' HAVING sum((i->>'quantity')::numeric*(c->>'quantity')::numeric)>1000000000)
 OR EXISTS(SELECT FROM jsonb_array_elements(reservations) r GROUP BY r->>'product_id' HAVING sum((r->>'quantity')::numeric)>1000000000)
 OR EXISTS(SELECT FROM jsonb_array_elements(reservations) r WHERE(r->>'quantity')::numeric>1000000000)
 OR octet_length(convert_to(src::text,'UTF8'))>4194304
 THEN RAISE EXCEPTION 'Whole native source count/byte budget' USING ERRCODE='54000';END IF;
 IF allocation IS NULL THEN RETURN jsonb_build_object('source',src||jsonb_build_object('revision',parcel_physical_wz_hash(src)));END IF;
 IF jsonb_typeof(allocation) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Mapping must be complete array' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(parcels) NOT BETWEEN 2 AND 50 OR jsonb_array_length(allocation)<>jsonb_array_length(parcels)
 OR jsonb_array_length(items) NOT BETWEEN 1 AND 500 OR jsonb_array_length(reservations) NOT BETWEEN 1 AND 500
 THEN RAISE EXCEPTION 'Incomplete whole native mapping source' USING ERRCODE='23514';END IF;
 -- Procedural shape-before-cast. No unbounded BigInt/uuid coercion on bad JSON.
 FOR mapped_parcel IN SELECT value FROM jsonb_array_elements(allocation) LOOP
 IF jsonb_typeof(mapped_parcel) IS DISTINCT FROM 'object' OR(mapped_parcel-ARRAY['parcel_index','shipment_id','components'])<>'{}'
 OR jsonb_typeof(mapped_parcel->'parcel_index') IS DISTINCT FROM 'number' OR NOT coalesce(mapped_parcel->>'parcel_index'~'^(0|[1-9][0-9]?)$',false)
 OR jsonb_typeof(mapped_parcel->'shipment_id') IS DISTINCT FROM 'string' OR NOT coalesce(mapped_parcel->>'shipment_id'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
 OR jsonb_typeof(mapped_parcel->'components') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid parcel mapping tuple' USING ERRCODE='23514';END IF;
 IF(mapped_parcel->>'parcel_index')::integer>49 OR jsonb_array_length(mapped_parcel->'components') NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'Invalid mapping extent' USING ERRCODE='23514';END IF;
 entries:=entries+jsonb_array_length(mapped_parcel->'components');IF entries>5000 THEN RAISE EXCEPTION 'Mapping entry budget' USING ERRCODE='54000';END IF;
 FOR mapped_component IN SELECT value FROM jsonb_array_elements(mapped_parcel->'components') LOOP
 IF jsonb_typeof(mapped_component) IS DISTINCT FROM 'object' OR(mapped_component-ARRAY['item_id','product_id','quantity'])<>'{}'
 OR NOT coalesce(mapped_component->>'item_id'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
 OR NOT coalesce(mapped_component->>'product_id'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
 OR jsonb_typeof(mapped_component->'quantity') IS DISTINCT FROM 'number' OR NOT coalesce(mapped_component->>'quantity'~'^[1-9][0-9]{0,9}$',false)
 THEN RAISE EXCEPTION 'Invalid item component mapping' USING ERRCODE='23514';END IF;
 IF(mapped_component->>'quantity')::bigint>1000000000 THEN RAISE EXCEPTION 'Physical count budget' USING ERRCODE='54000';END IF;
 END LOOP;
 IF EXISTS(SELECT FROM jsonb_array_elements(mapped_parcel->'components') x GROUP BY x->>'item_id',x->>'product_id' HAVING count(*)<>1)
 THEN RAISE EXCEPTION 'Repeated item component' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(SELECT FROM jsonb_array_elements(allocation) x GROUP BY x->>'parcel_index' HAVING count(*)<>1)
 OR EXISTS(SELECT FROM jsonb_array_elements(parcels) x WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(allocation) m WHERE(m->>'parcel_index',m->>'shipment_id')=(x->>'parcel_index',x->>'shipment_id')))
 OR EXISTS(SELECT FROM jsonb_array_elements(parcels) x WHERE NOT coalesce((x->>'parcel_index')::integer>=0 AND (x->>'parcel_index')::integer<jsonb_array_length(parcels),false))
 THEN RAISE EXCEPTION 'Mapping must cover exact contiguous frozen parcels' USING ERRCODE='23514';END IF;
 -- FULL JOIN detects key substitutions as well as changed sums.
 IF EXISTS(WITH expected AS(SELECT i->>'item_id' iid,c->>'product_id' prod,(i->>'quantity')::bigint*(c->>'quantity')::bigint q FROM jsonb_array_elements(items) i CROSS JOIN LATERAL jsonb_array_elements(i->'components') c),
 actual AS(SELECT c->>'item_id' iid,c->>'product_id' prod,sum((c->>'quantity')::bigint) q FROM jsonb_array_elements(allocation) m CROSS JOIN LATERAL jsonb_array_elements(m->'components') c GROUP BY 1,2)
 SELECT FROM expected e FULL JOIN actual a USING(iid,prod) WHERE e.q IS DISTINCT FROM a.q)
 THEN RAISE EXCEPTION 'Mapping must conserve each historical item/component' USING ERRCODE='23514';END IF;
 IF EXISTS(WITH expected AS(SELECT (p->>'parcel_index')::integer idx,z->>'product_id' prod,sum((z->>'quantity')::bigint) q FROM jsonb_array_elements(parcels) p CROSS JOIN LATERAL jsonb_array_elements(p->'products') z GROUP BY 1,2),
 actual AS(SELECT(m->>'parcel_index')::integer idx,c->>'product_id' prod,sum((c->>'quantity')::bigint) q FROM jsonb_array_elements(allocation) m CROSS JOIN LATERAL jsonb_array_elements(m->'components') c GROUP BY 1,2)
 SELECT FROM expected e FULL JOIN actual a USING(idx,prod) WHERE e.q IS DISTINCT FROM a.q)
 THEN RAISE EXCEPTION 'Mapping must conserve each frozen parcel/product' USING ERRCODE='23514';END IF;
 IF EXISTS(WITH expected AS(SELECT r->>'warehouse_id' wh,r->>'product_id' prod,(r->>'quantity')::bigint q FROM jsonb_array_elements(reservations) r),
 actual AS(SELECT z->>'warehouse_id' wh,z->>'product_id' prod,sum((z->>'quantity')::bigint) q FROM jsonb_array_elements(parcels) p CROSS JOIN LATERAL jsonb_array_elements(p->'products') z GROUP BY 1,2)
 SELECT FROM expected e FULL JOIN actual a USING(wh,prod) WHERE e.q IS DISTINCT FROM a.q)
 THEN RAISE EXCEPTION 'Plan must conserve original warehouse reservations' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(reservations) r WHERE(r->>'consumed_quantity')::bigint NOT BETWEEN 0 AND(r->>'quantity')::bigint
 OR(r->>'state') IS DISTINCT FROM(CASE WHEN(r->>'consumed_quantity')::bigint=(r->>'quantity')::bigint THEN 'consumed' ELSE 'active' END))
 THEN RAISE EXCEPTION 'Invalid reservation progress' USING ERRCODE='23514';END IF;
 IF EXISTS(WITH expected AS(SELECT r->>'warehouse_id' wh,r->>'product_id' prod,(r->>'consumed_quantity')::bigint q FROM jsonb_array_elements(reservations) r WHERE(r->>'consumed_quantity')::bigint>0),
 actual AS(SELECT z->>'warehouse_id' wh,z->>'product_id' prod,sum((z->>'quantity')::bigint) q FROM jsonb_array_elements(progress) p CROSS JOIN LATERAL jsonb_array_elements(p->'issued_products') z GROUP BY 1,2)
 SELECT FROM expected e FULL JOIN actual a USING(wh,prod) WHERE e.q IS DISTINCT FROM a.q)
 THEN RAISE EXCEPTION 'Consumption must equal actual prior dispatches' USING ERRCODE='23514';END IF;
 IF EXISTS(WITH expected AS(SELECT(p->>'parcel_index')::integer idx,z->>'warehouse_id' wh,z->>'product_id' prod,(z->>'quantity')::bigint q FROM jsonb_array_elements(parcels) p CROSS JOIN LATERAL jsonb_array_elements(p->'products') z WHERE EXISTS(SELECT FROM jsonb_array_elements(progress) s WHERE(s->>'parcel_index',s->>'state')=(p->>'parcel_index','dispatched'))),
 actual AS(SELECT(p->>'parcel_index')::integer idx,z->>'warehouse_id' wh,z->>'product_id' prod,(z->>'quantity')::bigint q FROM jsonb_array_elements(progress) p CROSS JOIN LATERAL jsonb_array_elements(p->'issued_products') z)
 SELECT FROM expected e FULL JOIN actual a USING(idx,wh,prod) WHERE e.q IS DISTINCT FROM a.q)
 THEN RAISE EXCEPTION 'Each prior parcel must match frozen quantities' USING ERRCODE='23514';END IF;
 SELECT jsonb_agg(jsonb_build_object('parcel_index',m->'parcel_index','shipment_id',m->'shipment_id','components',
 (SELECT jsonb_agg(c ORDER BY c->>'item_id',c->>'product_id') FROM jsonb_array_elements(m->'components') c)) ORDER BY(m->>'parcel_index')::integer) INTO allocation FROM jsonb_array_elements(allocation) m;
 FOR mapped_parcel IN SELECT value FROM jsonb_array_elements(allocation) LOOP
 lines:='[]';
 FOR line IN SELECT value FROM jsonb_array_elements(items) ORDER BY value->>'item_id' LOOP
 SELECT jsonb_agg(jsonb_build_object('product_id',c->'product_id','quantity',c->'quantity') ORDER BY c->>'product_id') INTO counts FROM jsonb_array_elements(mapped_parcel->'components') c WHERE c->>'item_id'=line->>'item_id';
 IF counts IS NOT NULL THEN lines:=lines||jsonb_build_array((line-'quantity')||jsonb_build_object('lineage_kind','physical_item_components_v1','original_quantity',line->'quantity','component_quantities',counts));END IF;
 END LOOP;
 projected:=projected||jsonb_build_array(jsonb_build_object('parcel_index',mapped_parcel->'parcel_index','shipment_id',mapped_parcel->'shipment_id','commercial_lines',lines));
 END LOOP;
 src:=jsonb_build_object('tenant_id',t,'order_id',plan_row.order_id,'order_version',o.version::text,'plan_id',plan_row.id,'plan_scope_hash',plan_row.scope_hash,'protocol','physical_v1','currency',o.currency,'items',items,'reservations',reservations,'parcels',parcels,'progress',progress);
 basis:=jsonb_build_object('tenant_id',t,'order_id',plan_row.order_id,'plan_id',plan_row.id,'plan_scope_hash',plan_row.scope_hash,'currency',o.currency,'items',items,'parcels',parcels,'allocation',allocation,
 'reservations',(SELECT jsonb_agg(x-ARRAY['consumed_quantity','state'] ORDER BY x->>'warehouse_id',x->>'product_id') FROM jsonb_array_elements(reservations) x));
 IF octet_length(convert_to(jsonb_build_object('source',src,'basis',basis,'projected_parcels',projected)::text,'UTF8'))>4194304 THEN RAISE EXCEPTION 'Full snapshot budget' USING ERRCODE='54000';END IF;
 RETURN jsonb_build_object('source',src||jsonb_build_object('revision',parcel_physical_wz_hash(src)),'basis',basis,'allocation',allocation,'projected_parcels',projected,'projection_hash',parcel_physical_wz_hash(basis));
END $$;
REVOKE ALL ON FUNCTION parcel_physical_wz_hash(jsonb),parcel_physical_wz_frame(uuid,jsonb,boolean) FROM PUBLIC,dyna_app;

-- FRAGMENT: certificate-capture.sql
CREATE FUNCTION parcel_physical_wz_predecessor_functions() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_object_agg(p.proname,jsonb_build_object('definition',pg_get_functiondef(p.oid),'body',p.prosrc,'owner',pg_get_userbyid(p.proowner),'acl',
 (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)
 ORDER BY pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)))
 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'warehouse_wz_issuer_')
$$;
CREATE FUNCTION parcel_physical_wz_predecessor_triggers() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid,true)) ORDER BY c.relname,t.tgname)
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal AND starts_with(t.tgname,'warehouse_wz_issuer_')
$$;
DO $$DECLARE n text;saved jsonb;expected jsonb:='{"warehouse_wz_issuer_commercial":"ff3a360178eca1e85c623678290a79ca0daf06e0c4d0b6ddff95b2eb5089ab5e","warehouse_wz_issuer_effects":"9d1970aad9edaf4e7fcee867bf59df85184a494ecdfe5478940f7ffd08f660e6","warehouse_wz_issuer_finish":"8197d0956d44b0d1062f1072668a35a76b70b32fda15b5b8ebdc383f94b6d7dc","warehouse_wz_issuer_access":"8a94cd8ce10a17f7fcee6f57209f89619d604f31e31dd57896816b262ab7e1b4","warehouse_wz_issuer_snapshot":"9f07289798db9788263b03e884218faed506b38d127861328815731bae6a0365","warehouse_wz_issuer_prepare":"76ece3a21d4df401cf534ab79b5b14aa037cf30d6bb81fd99d9467a50f0fdd06","warehouse_wz_issuer_record_guard":"22fe527363c170f2fb1527db5193de620ba7be2db1cf9fe067f88c5d11e5d034","warehouse_wz_issuer_complete":"a5956e31f27adf662949905701153bbf4c2729b68b4a1caef8c8499712b5c4ad","warehouse_wz_issuer_source_seal":"3cde51f5df2b882f26474378974b64ed8daac1c6db8dcb0a900f69e35839eb52","warehouse_wz_issuer_hash":"68ce179ff3c4500519f3b13abd83717d93dd70b35bf57195a26e105b3763e013","warehouse_wz_issuer_installed":"813e2ffeefda8491a8ee4f56b43953894d82a0edba20f4803db1b5c0599e1785","warehouse_wz_issuer_fingerprint":"fb6ad23cafc0fc41f0889757bbf892fe4d8f008b00fadba86da411eebb3de663","warehouse_wz_issuer_guards":"d863e8454d576cd10559495dd55cf90eecbd9b58d68c952e443d1cc33ec7deaa","warehouse_wz_issuer_require":"38df95080d4dfded515349e8621b2f9ffae49f10070c9ebbc979478b788ac47e"}'::jsonb;BEGIN
 IF(SELECT count(*) FROM pg_temp.parcel_physical_wz_install_basis)<>1 OR EXISTS(SELECT FROM pg_temp.parcel_physical_wz_install_basis WHERE original151_manifest->>'fingerprint' IS DISTINCT FROM predecessor_fingerprint)
 THEN RAISE EXCEPTION 'Original151 manifest mismatch' USING ERRCODE='55000';END IF;
 saved:=parcel_physical_wz_predecessor_functions();
 IF(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(saved) k(key)) IS DISTINCT FROM(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(expected) k(key)) THEN RAISE EXCEPTION 'Original151 function set mismatch' USING ERRCODE='55000';END IF;
 FOR n IN SELECT jsonb_object_keys(expected) LOOP
 IF encode(sha256(convert_to(saved->n->>'body','UTF8')),'hex') IS DISTINCT FROM expected->>n THEN RAISE EXCEPTION 'Original151 body mismatch' USING ERRCODE='55000';END IF;END LOOP;
 UPDATE pg_temp.parcel_physical_wz_install_basis SET predecessor_functions=saved,predecessor_triggers=parcel_physical_wz_predecessor_triggers();
END $$;

-- FRAGMENT: schema-producer.sql
-- SOURCE_DRAFT ONLY. Execute after native-kernel inside a future genuine managed
-- successor transaction; certificate assembly must be completed first. No dyna_app
-- table DML; only scoped native APIs. Existing151/134/136/167 data never rewritten.
CREATE TABLE parcel_physical_wz_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,plan_id uuid NOT NULL,order_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,
 request jsonb NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 revision text NOT NULL CHECK(revision~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),
 frame jsonb NOT NULL,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,plan_id,order_id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,plan_id,order_id) REFERENCES order_parcel_plans(tenant_id,id,order_id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),CHECK(expires_at=created_at+interval '15 minutes')
);
CREATE TABLE parcel_physical_wz_mappings (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,preview_id uuid NOT NULL,plan_id uuid NOT NULL,order_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,
 request jsonb NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL,
 frame jsonb NOT NULL,created_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,plan_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,preview_id,plan_id,order_id) REFERENCES parcel_physical_wz_previews(tenant_id,id,plan_id,order_id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE parcel_physical_wz_bindings (
 tenant_id uuid NOT NULL,admission_id uuid NOT NULL,mapping_id uuid NOT NULL,plan_id uuid NOT NULL,order_id uuid NOT NULL,
 parcel_index integer NOT NULL CHECK(parcel_index BETWEEN 0 AND 49),shipment_id uuid NOT NULL,dispatch_id uuid NOT NULL,
 projected_lines jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,admission_id),UNIQUE(tenant_id,dispatch_id),
 FOREIGN KEY(tenant_id,mapping_id) REFERENCES parcel_physical_wz_mappings(tenant_id,id),
 FOREIGN KEY(tenant_id,admission_id,order_id,shipment_id) REFERENCES warehouse_wz_issuer_admissions(tenant_id,id,order_id,shipment_id),
 FOREIGN KEY(tenant_id,plan_id,parcel_index,shipment_id) REFERENCES order_parcel_allocations(tenant_id,plan_id,index,shipment_id),
 FOREIGN KEY(tenant_id,dispatch_id) REFERENCES order_parcel_dispatches(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX parcel_physical_wz_preview_quota ON parcel_physical_wz_previews(tenant_id,created_at,id);
CREATE INDEX parcel_physical_wz_mapping_history ON parcel_physical_wz_mappings(tenant_id,order_id,created_at DESC,id DESC);
DO $policy$ DECLARE rel text;BEGIN
 FOREACH rel IN ARRAY ARRAY['parcel_physical_wz_previews','parcel_physical_wz_mappings','parcel_physical_wz_bindings'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',rel);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',rel);
 EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,rel);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',rel);
 END LOOP;
END $policy$;
CREATE FUNCTION parcel_physical_wz_context_owned() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r oid;BEGIN
 r:=to_regclass('pg_temp.parcel_physical_wz_context');IF r IS NULL THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT FROM pg_class WHERE oid=r AND relpersistence='t' AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
 OR EXISTS(SELECT FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=r AND a.grantee<>c.relowner)
 THEN RAISE EXCEPTION 'Physical WZ context owner changed' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT FROM pg_temp.parcel_physical_wz_context WHERE root_xid<>pg_current_xact_id() OR backend_pid<>pg_backend_pid())
 THEN RAISE EXCEPTION 'Physical WZ transaction changed' USING ERRCODE='42501';END IF;RETURN true;
END $$;
CREATE FUNCTION parcel_physical_wz_open(t uuid,u uuid,k uuid,h text,r text,w boolean,op text,subject uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT parcel_physical_wz_valid() THEN RAISE EXCEPTION 'Physical WZ metadata refused' USING ERRCODE='55000';END IF;
 IF op NOT IN('source','preview','preview_detail','apply','mapping_detail','dispatch') OR subject IS NULL
 OR w IS DISTINCT FROM(op IN('preview','apply','dispatch')) THEN RAISE EXCEPTION 'Unknown operation authority' USING ERRCODE='42501';END IF;
 PERFORM buyer_address_identity(t,u,k,h,r,false,false);PERFORM order_parcel_require(u,k,w,false);
 IF to_regclass('pg_temp.parcel_physical_wz_context') IS NULL THEN
 CREATE TEMP TABLE parcel_physical_wz_context(tenant_id uuid,actor_id uuid,api_key_id uuid,credential_hash text,role_name text,
 writing boolean,operation text,subject_id uuid,root_xid xid8,backend_pid integer,
 expected_basis jsonb,expected_revision text,deadline timestamptz,mapping_id uuid,parcel_index integer,client_key uuid,admission_id uuid) ON COMMIT DROP;
 REVOKE ALL ON pg_temp.parcel_physical_wz_context FROM PUBLIC,dyna_app;
 END IF;
 PERFORM parcel_physical_wz_context_owned();
 IF EXISTS(SELECT FROM pg_temp.parcel_physical_wz_context WHERE(tenant_id,actor_id,api_key_id,credential_hash,role_name) IS DISTINCT FROM(t,u,k,h,r))
 THEN RAISE EXCEPTION 'Physical WZ principal rebind refused' USING ERRCODE='42501';END IF;
 INSERT INTO pg_temp.parcel_physical_wz_context(tenant_id,actor_id,api_key_id,credential_hash,role_name,writing,operation,subject_id,root_xid,backend_pid)
 VALUES(t,u,k,h,r,w,op,subject,pg_current_xact_id(),pg_backend_pid());
END $$;
CREATE FUNCTION parcel_physical_wz_context(op text,subject uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE x record;BEGIN
 IF NOT parcel_physical_wz_context_owned() THEN RAISE EXCEPTION 'Physical WZ requires admitted authority' USING ERRCODE='42501';END IF;
 SELECT * INTO x FROM pg_temp.parcel_physical_wz_context WHERE operation=op AND subject_id=subject ORDER BY ctid DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'Physical WZ operation was not admitted' USING ERRCODE='42501';END IF;RETURN to_jsonb(x);
END $$;
CREATE FUNCTION parcel_physical_wz_lock(pid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=current_setting('app.tenant_id')::uuid;p order_parcel_plans;x uuid;BEGIN
 SELECT * INTO p FROM order_parcel_plans WHERE tenant_id=t AND id=pid;IF p.id IS NULL THEN RAISE EXCEPTION 'Own plan missing' USING ERRCODE='P0002';END IF;
 FOR x IN SELECT DISTINCT(z->>'warehouse_id')::uuid FROM order_parcel_allocations l CROSS JOIN LATERAL jsonb_array_elements(l.payload->'products') z WHERE l.tenant_id=t AND l.plan_id=pid ORDER BY 1 LOOP PERFORM warehouse_inventory_policy_lock(t,x);END LOOP;
 PERFORM order_parcel_lock(p.order_id);RETURN p.order_id;
END $$;
-- Policy/warehouse/configuration custody is acquired before the order lock.
-- The 150 configuration writer locks the same warehouse before inserting or
-- updating configuration, so an absent/OFF configuration cannot flip after this
-- false result and cause a new mapping requirement within the same dispatch.
CREATE FUNCTION parcel_physical_wz_dispatch_required(pid uuid,n integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=current_setting('app.tenant_id')::uuid;p order_parcel_plans;l order_parcel_allocations;x uuid;BEGIN
 IF NOT parcel_physical_wz_valid() OR NOT warehouse_automatic_wz_guards() THEN RAISE EXCEPTION 'Physical WZ configuration metadata refused' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM order_parcel_plans WHERE tenant_id=t AND id=pid;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Own parcel plan missing' USING ERRCODE='P0002';END IF;
 IF p.payload->>'protocol'='commercial_v1' THEN RETURN false;END IF;
 SELECT * INTO l FROM order_parcel_allocations WHERE(tenant_id,plan_id,index,order_id)=(t,pid,n,p.order_id);
 IF l.shipment_id IS NULL THEN RAISE EXCEPTION 'Own selected parcel missing' USING ERRCODE='P0002';END IF;
 FOR x IN SELECT DISTINCT(z->>'warehouse_id')::uuid FROM jsonb_array_elements(l.payload->'products') z ORDER BY 1 LOOP
 PERFORM warehouse_inventory_policy_lock(t,x);
 PERFORM id FROM warehouses WHERE(tenant_id,id)=(t,x) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Own physical warehouse missing' USING ERRCODE='P0002';END IF;
 PERFORM warehouse_id FROM warehouse_automatic_wz_configurations WHERE(tenant_id,warehouse_id)=(t,x) FOR SHARE;
 END LOOP;
 PERFORM order_parcel_lock(p.order_id);
 RETURN EXISTS(SELECT FROM warehouse_automatic_wz_configurations c WHERE c.tenant_id=t AND c.settings->>'enabled'='true'
 AND EXISTS(SELECT FROM jsonb_array_elements(l.payload->'products') z WHERE z->>'warehouse_id'=c.warehouse_id::text));
END $$;
CREATE FUNCTION parcel_physical_wz_source(pid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE f jsonb;m parcel_physical_wz_mappings;BEGIN
 PERFORM parcel_physical_wz_context('source',pid);PERFORM parcel_physical_wz_lock(pid);
 f:=parcel_physical_wz_frame(pid,NULL);SELECT * INTO m FROM parcel_physical_wz_mappings WHERE tenant_id=current_setting('app.tenant_id')::uuid AND plan_id=pid;
 RETURN f->'source'||jsonb_build_object('approved_mapping_id',m.id,'approved_at',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
END $$;
CREATE FUNCTION parcel_physical_wz_preview_view(pid uuid,read_current boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE p parcel_physical_wz_previews;m uuid;valid boolean:=false;cur jsonb;BEGIN
 SELECT * INTO p FROM parcel_physical_wz_previews WHERE tenant_id=current_setting('app.tenant_id')::uuid AND id=pid;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Own preview missing' USING ERRCODE='P0002';END IF;
 SELECT id INTO m FROM parcel_physical_wz_mappings WHERE tenant_id=p.tenant_id AND preview_id=p.id;
 IF read_current AND m IS NULL AND p.expires_at>clock_timestamp() THEN
 PERFORM parcel_physical_wz_lock(p.plan_id);cur:=parcel_physical_wz_frame(p.plan_id,p.request->'parcels');valid:=cur->'source'->>'revision'=p.revision;
 END IF;
 RETURN jsonb_build_object('id',p.id,'plan_id',p.plan_id,'order_id',p.order_id,'client_key',p.client_key,'revision',p.revision,'scope_hash',p.scope_hash,'created_at',to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'expires_at',to_char(p.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'allocation',p.frame->'allocation','projected_parcels',p.frame->'projected_parcels','applied_mapping_id',m,'can_apply',valid);
END $$;
CREATE FUNCTION parcel_physical_wz_mapping_view(mid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE m parcel_physical_wz_mappings;BEGIN
 SELECT * INTO m FROM parcel_physical_wz_mappings WHERE tenant_id=current_setting('app.tenant_id')::uuid AND id=mid;
 IF m.id IS NULL THEN RAISE EXCEPTION 'Own mapping missing' USING ERRCODE='P0002';END IF;
 RETURN jsonb_build_object('id',m.id,'preview_id',m.preview_id,'plan_id',m.plan_id,'order_id',m.order_id,'scope_hash',m.scope_hash,'projection_hash',m.frame->>'projection_hash','created_at',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'allocation',m.frame->'allocation','projected_parcels',m.frame->'projected_parcels','classification_origin','operator_confirmed');
END $$;
CREATE FUNCTION parcel_physical_wz_preview(pid uuid,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE ctx jsonb;p parcel_physical_wz_previews;h text;f jsonb;eid uuid:=gen_random_uuid();stamp timestamptz;nonce uuid:=gen_random_uuid();BEGIN
 ctx:=parcel_physical_wz_context('preview',pid);
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR(b-ARRAY['client_key','revision','parcels'])<>'{}'
 OR NOT coalesce(b->>'client_key'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
 OR NOT coalesce(b->>'revision'~'^[a-f0-9]{64}$',false) OR jsonb_typeof(b->'parcels') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'Invalid physical WZ preview request' USING ERRCODE='23514';END IF;
 h:=parcel_physical_wz_hash(jsonb_build_object('tenant',ctx->'tenant_id','actor',ctx->'actor_id','key',ctx->'api_key_id','plan',pid,'request',b));
 PERFORM pg_advisory_xact_lock(hashtextextended('parcel.physical.wz.quota:'||(ctx->>'tenant_id'),0));
 SELECT * INTO p FROM parcel_physical_wz_previews WHERE tenant_id=(ctx->>'tenant_id')::uuid AND client_key=(b->>'client_key')::uuid;
 IF p.id IS NOT NULL THEN IF p.request_hash<>h THEN RAISE EXCEPTION 'Preview client key changed body' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('preview',parcel_physical_wz_preview_view(p.id,false),'reused',true);END IF;
 PERFORM parcel_physical_wz_lock(pid);f:=parcel_physical_wz_frame(pid,b->'parcels');
 IF f->'source'->>'revision' IS DISTINCT FROM b->>'revision' OR EXISTS(SELECT FROM parcel_physical_wz_mappings WHERE tenant_id=(ctx->>'tenant_id')::uuid AND plan_id=pid)
 THEN RAISE EXCEPTION 'Revision or existing immutable mapping changed' USING ERRCODE='40001';END IF;
 IF(SELECT count(*) FROM parcel_physical_wz_previews WHERE tenant_id=(ctx->>'tenant_id')::uuid)>=2000 THEN RAISE EXCEPTION 'Native preview quota' USING ERRCODE='54000';END IF;
 stamp:=clock_timestamp();
 INSERT INTO parcel_physical_wz_previews(id,tenant_id,plan_id,order_id,actor_id,api_key_id,client_key,request,request_hash,revision,scope_hash,frame,created_at,expires_at)
 VALUES(eid,(ctx->>'tenant_id')::uuid,pid,(f->'source'->>'order_id')::uuid,(ctx->>'actor_id')::uuid,(ctx->>'api_key_id')::uuid,(b->>'client_key')::uuid,b,h,b->>'revision',parcel_physical_wz_hash(jsonb_build_object('frame',f,'nonce',nonce)),f,stamp,stamp+interval '15 minutes');
 UPDATE pg_temp.parcel_physical_wz_context SET expected_basis=f->'basis',expected_revision=b->>'revision',deadline=stamp+interval '15 minutes' WHERE operation='preview' AND subject_id=pid;
 RETURN jsonb_build_object('preview',parcel_physical_wz_preview_view(eid,true),'reused',false);
END $$;
CREATE FUNCTION parcel_physical_wz_apply(preview_id uuid,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE ctx jsonb;p parcel_physical_wz_previews;m parcel_physical_wz_mappings;h text;f jsonb;eid uuid:=gen_random_uuid();BEGIN
 ctx:=parcel_physical_wz_context('apply',preview_id);
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR(b-ARRAY['client_key','scope_hash','confirmed'])<>'{}' OR b->'confirmed' IS DISTINCT FROM 'true'::jsonb
 OR NOT coalesce(b->>'client_key'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) OR NOT coalesce(b->>'scope_hash'~'^[a-f0-9]{64}$',false)
 THEN RAISE EXCEPTION 'Separate mapping consent required' USING ERRCODE='23514';END IF;
 h:=parcel_physical_wz_hash(jsonb_build_object('tenant',ctx->'tenant_id','actor',ctx->'actor_id','key',ctx->'api_key_id','preview',preview_id,'request',b));
 SELECT * INTO m FROM parcel_physical_wz_mappings WHERE tenant_id=(ctx->>'tenant_id')::uuid AND client_key=(b->>'client_key')::uuid;
 IF m.id IS NOT NULL THEN IF m.request_hash<>h THEN RAISE EXCEPTION 'Mapping client key changed scope' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('mapping',parcel_physical_wz_mapping_view(m.id),'reused',true);END IF;
 SELECT * INTO p FROM parcel_physical_wz_previews WHERE tenant_id=(ctx->>'tenant_id')::uuid AND id=preview_id;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Own preview not found' USING ERRCODE='P0002';END IF;
 PERFORM parcel_physical_wz_lock(p.plan_id);
 IF(p.actor_id,p.api_key_id,p.scope_hash) IS DISTINCT FROM((ctx->>'actor_id')::uuid,(ctx->>'api_key_id')::uuid,b->>'scope_hash')
 OR p.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Mapping preview scope or actor expired' USING ERRCODE='40001';END IF;
 f:=parcel_physical_wz_frame(p.plan_id,p.request->'parcels');
 IF f IS DISTINCT FROM p.frame THEN RAISE EXCEPTION 'Full mapping source changed before consent' USING ERRCODE='40001';END IF;
 INSERT INTO parcel_physical_wz_mappings(id,tenant_id,preview_id,plan_id,order_id,actor_id,api_key_id,client_key,request,request_hash,scope_hash,frame,created_at)
 VALUES(eid,p.tenant_id,p.id,p.plan_id,p.order_id,p.actor_id,p.api_key_id,(b->>'client_key')::uuid,b,h,p.scope_hash,f,clock_timestamp());
 UPDATE pg_temp.parcel_physical_wz_context SET mapping_id=eid,expected_basis=f->'basis',expected_revision=p.revision,deadline=p.expires_at WHERE operation='apply' AND subject_id=preview_id;
 RETURN jsonb_build_object('mapping',parcel_physical_wz_mapping_view(eid),'reused',false);
END $$;
CREATE FUNCTION parcel_physical_wz_preview_detail(id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ctx jsonb;p parcel_physical_wz_previews;v jsonb;BEGIN
 ctx:=parcel_physical_wz_context('preview_detail',id);v:=parcel_physical_wz_preview_view(id,true);
 SELECT pv.* INTO p FROM parcel_physical_wz_previews pv WHERE(pv.tenant_id,pv.id)=((ctx->>'tenant_id')::uuid,parcel_physical_wz_preview_detail.id);
 RETURN v||jsonb_build_object('can_apply',v->'can_apply'='true'::jsonb AND(p.actor_id,p.api_key_id) IS NOT DISTINCT FROM((ctx->>'actor_id')::uuid,(ctx->>'api_key_id')::uuid));
END $$;
CREATE FUNCTION parcel_physical_wz_mapping_detail(id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM parcel_physical_wz_context('mapping_detail',id);RETURN parcel_physical_wz_mapping_view(id);END $$;
CREATE FUNCTION parcel_physical_wz_flags(u uuid,k uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE g jsonb;BEGIN
 g:=order_parcel_access(u,k,true,false);RETURN jsonb_build_object('role',g->'role','can_write',g->'allowed'='true'::jsonb AND g->'key_valid'='true'::jsonb);
END $$;
CREATE FUNCTION parcel_physical_wz_enlist_dispatch(pid uuid,n integer,client_key uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ctx jsonb;m parcel_physical_wz_mappings;f jsonb;BEGIN
 ctx:=parcel_physical_wz_context('dispatch',pid);PERFORM parcel_physical_wz_lock(pid);
 SELECT * INTO m FROM parcel_physical_wz_mappings WHERE tenant_id=(ctx->>'tenant_id')::uuid AND plan_id=pid;
 IF m.id IS NULL THEN RAISE EXCEPTION 'Physical dispatch requires explicit approved component map' USING ERRCODE='23514';END IF;
 f:=parcel_physical_wz_frame(pid,m.frame->'allocation');IF f->'basis' IS DISTINCT FROM m.frame->'basis' THEN RAISE EXCEPTION 'Immutable source changed after mapping' USING ERRCODE='40001';END IF;
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(f->'source'->'progress') p WHERE(p->>'parcel_index',p->>'state')=(n::text,'pending')) THEN RAISE EXCEPTION 'Replay must precede new mapping admission' USING ERRCODE='23514';END IF;
 UPDATE pg_temp.parcel_physical_wz_context SET mapping_id=m.id,parcel_index=n,client_key=parcel_physical_wz_enlist_dispatch.client_key,expected_basis=f->'basis' WHERE operation='dispatch' AND subject_id=pid;
END $$;
CREATE FUNCTION parcel_physical_wz_lines_for_dispatch(u uuid,k uuid,src jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ctx jsonb;m parcel_physical_wz_mappings;f jsonb;lines jsonb;BEGIN
 ctx:=parcel_physical_wz_context('dispatch',(src->>'plan_id')::uuid);
 IF(ctx->>'actor_id',ctx->>'api_key_id',ctx->>'parcel_index') IS DISTINCT FROM(u::text,k::text,src->>'parcel_index') THEN RAISE EXCEPTION 'Typed WZ actor/source context mismatch' USING ERRCODE='42501';END IF;
 SELECT * INTO m FROM parcel_physical_wz_mappings WHERE tenant_id=(ctx->>'tenant_id')::uuid AND id=(ctx->>'mapping_id')::uuid;
 f:=parcel_physical_wz_frame(m.plan_id,m.frame->'allocation');
 IF f->'basis' IS DISTINCT FROM m.frame->'basis' OR m.order_id IS DISTINCT FROM(src->>'order_id')::uuid THEN RAISE EXCEPTION 'Typed WZ mapping history changed' USING ERRCODE='40001';END IF;
 SELECT p->'commercial_lines' INTO lines FROM jsonb_array_elements(f->'projected_parcels') p WHERE(p->>'parcel_index',p->>'shipment_id')=(src->>'parcel_index',src->>'shipment_id');
 IF lines IS NULL OR jsonb_array_length(lines)=0 THEN RAISE EXCEPTION 'No genuine selected component provenance' USING ERRCODE='23514';END IF;RETURN lines;
END $$;
CREATE FUNCTION parcel_physical_wz_bind_admission(eid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a warehouse_wz_issuer_admissions;ctx jsonb;lines jsonb;BEGIN
 SELECT * INTO a FROM warehouse_wz_issuer_admissions WHERE tenant_id=current_setting('app.tenant_id')::uuid AND id=eid;
 ctx:=parcel_physical_wz_context('dispatch',(a.source->>'plan_id')::uuid);
 lines:=parcel_physical_wz_lines_for_dispatch(a.actor_id,a.api_key_id,a.source);
 IF a.txid<>pg_current_xact_id() OR a.frame->'commercial_lines' IS DISTINCT FROM lines THEN RAISE EXCEPTION 'Typed WZ admission mismatch' USING ERRCODE='23514';END IF;
 INSERT INTO parcel_physical_wz_bindings(tenant_id,admission_id,mapping_id,plan_id,order_id,parcel_index,shipment_id,dispatch_id,projected_lines)
 VALUES(a.tenant_id,a.id,(ctx->>'mapping_id')::uuid,(a.source->>'plan_id')::uuid,a.order_id,(a.source->>'parcel_index')::integer,a.shipment_id,(a.source->>'dispatch_id')::uuid,lines);
 UPDATE pg_temp.parcel_physical_wz_context SET admission_id=eid WHERE operation='dispatch' AND subject_id=(a.source->>'plan_id')::uuid;
END $$;
CREATE FUNCTION parcel_physical_wz_validate_admission(eid uuid,historical boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a warehouse_wz_issuer_admissions;b parcel_physical_wz_bindings;m parcel_physical_wz_mappings;f jsonb;lines jsonb;BEGIN
 SELECT * INTO a FROM warehouse_wz_issuer_admissions WHERE tenant_id=current_setting('app.tenant_id')::uuid AND id=eid;
 SELECT * INTO b FROM parcel_physical_wz_bindings WHERE(tenant_id,admission_id)=(a.tenant_id,a.id);
 SELECT * INTO m FROM parcel_physical_wz_mappings WHERE(tenant_id,id)=(b.tenant_id,b.mapping_id);
 IF b.admission_id IS NULL OR m.id IS NULL OR(NOT historical AND a.txid<>pg_current_xact_id())
 OR(b.plan_id,b.order_id,b.parcel_index,b.shipment_id,b.dispatch_id) IS DISTINCT FROM((a.source->>'plan_id')::uuid,a.order_id,(a.source->>'parcel_index')::integer,a.shipment_id,(a.source->>'dispatch_id')::uuid)
 OR NOT EXISTS(SELECT FROM order_parcel_dispatches d WHERE(d.tenant_id,d.id,d.plan_id,d.order_id,d.parcel_index,d.shipment_id)=(b.tenant_id,b.dispatch_id,b.plan_id,b.order_id,b.parcel_index,b.shipment_id))
 THEN RAISE EXCEPTION 'Typed physical WZ must finish genuine native parcel' USING ERRCODE='23514';END IF;
 f:=parcel_physical_wz_frame(m.plan_id,m.frame->'allocation',NOT historical);
 SELECT p->'commercial_lines' INTO lines FROM jsonb_array_elements(f->'projected_parcels') p WHERE(p->>'parcel_index',p->>'shipment_id')=(b.parcel_index::text,b.shipment_id::text);
 IF f->'basis' IS DISTINCT FROM m.frame->'basis' OR lines IS DISTINCT FROM b.projected_lines OR a.frame->'commercial_lines' IS DISTINCT FROM lines
 THEN RAISE EXCEPTION 'Typed source must retain exact approved item components' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION parcel_physical_wz_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Physical WZ history is immutable' USING ERRCODE='23514';END IF;
 IF NOT parcel_physical_wz_context_owned() THEN RAISE EXCEPTION 'Physical WZ insert requires native admitted custody' USING ERRCODE='42501';END IF;
 IF NEW.tenant_id IS DISTINCT FROM current_setting('app.tenant_id')::uuid THEN RAISE EXCEPTION 'Foreign physical WZ insert' USING ERRCODE='42501';END IF;
 -- Generic application role has no DML. The native producer additionally proves
 -- source/CAS/exact request; context is not a claim of independent SQL plaintext IAM.
 RETURN NEW;
END $$;
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['parcel_physical_wz_previews','parcel_physical_wz_mappings','parcel_physical_wz_bindings'] LOOP
 EXECUTE format('CREATE TRIGGER parcel_physical_wz_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION parcel_physical_wz_immutable()',rel);
END LOOP;END $$;
CREATE FUNCTION parcel_physical_wz_terminal_prepare() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE x record;m parcel_physical_wz_mappings;f jsonb;BEGIN
 IF NOT parcel_physical_wz_context_owned() THEN RETURN true;END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
 FOR x IN SELECT * FROM pg_temp.parcel_physical_wz_context LOOP
 PERFORM buyer_address_identity(x.tenant_id,x.actor_id,x.api_key_id,x.credential_hash,x.role_name,false,true);PERFORM order_parcel_require(x.actor_id,x.api_key_id,x.writing,true);
 END LOOP;
 IF NOT parcel_physical_wz_valid() OR NOT warehouse_wz_issuer_guards() OR NOT operative_delivery_valid() THEN RAISE EXCEPTION 'Final typed WZ metadata changed' USING ERRCODE='55000';END IF;
 FOR x IN SELECT * FROM pg_temp.parcel_physical_wz_context LOOP
 IF x.expected_basis IS NOT NULL THEN
 IF x.mapping_id IS NOT NULL THEN SELECT * INTO m FROM parcel_physical_wz_mappings WHERE(tenant_id,id)=(x.tenant_id,x.mapping_id);f:=parcel_physical_wz_frame(m.plan_id,m.frame->'allocation');
 ELSE SELECT p.frame INTO f FROM parcel_physical_wz_previews p WHERE p.tenant_id=x.tenant_id AND p.plan_id=x.subject_id AND p.frame->'basis'=x.expected_basis ORDER BY p.created_at DESC,p.id LIMIT 1;f:=parcel_physical_wz_frame((f->'source'->>'plan_id')::uuid,f->'allocation');END IF;
 IF f->'basis' IS DISTINCT FROM x.expected_basis OR(x.expected_revision IS NOT NULL AND f->'source'->>'revision' IS DISTINCT FROM x.expected_revision) THEN RAISE EXCEPTION 'Physical WZ source changed after waits' USING ERRCODE='40001';END IF;
 END IF;
 IF x.admission_id IS NOT NULL THEN PERFORM parcel_physical_wz_validate_admission(x.admission_id);END IF;
 END LOOP;
 RETURN true;
END $$;
-- Called after every sibling's finalizer and every prepare/metadata/source wait.
-- Identity rows are already pinned by terminal_prepare; this stage acquires no
-- source/config/order lock and performs no new schema fingerprint scan.
CREATE FUNCTION parcel_physical_wz_terminal_clock() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE x record;BEGIN
 IF NOT parcel_physical_wz_context_owned() THEN RETURN true;END IF;
 FOR x IN SELECT * FROM pg_temp.parcel_physical_wz_context LOOP
 IF x.deadline IS NOT NULL AND x.deadline<=clock_timestamp() THEN RAISE EXCEPTION 'Mapping preview expired at terminal' USING ERRCODE='40001';END IF;
 PERFORM buyer_address_identity(x.tenant_id,x.actor_id,x.api_key_id,x.credential_hash,x.role_name,false,false);
 END LOOP;RETURN true;
END $$;
DO $$DECLARE p record;BEGIN FOR p IN SELECT oid::regprocedure sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'parcel_physical_wz_') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',p.sig);END LOOP;END $$;
GRANT EXECUTE ON FUNCTION parcel_physical_wz_open(uuid,uuid,uuid,text,text,boolean,text,uuid),parcel_physical_wz_source(uuid),parcel_physical_wz_preview(uuid,jsonb),parcel_physical_wz_preview_detail(uuid),parcel_physical_wz_apply(uuid,jsonb),parcel_physical_wz_mapping_detail(uuid),parcel_physical_wz_flags(uuid,uuid),parcel_physical_wz_enlist_dispatch(uuid,integer,uuid),parcel_physical_wz_terminal_prepare(),parcel_physical_wz_terminal_clock(),parcel_physical_wz_dispatch_required(uuid,integer) TO dyna_app;

-- FRAGMENT: allocator.sql
-- Pure SQL typed component allocator. Parent commercial() keeps its old whole-
-- unit branch byte-literal and dispatches only exact typed rows here.
CREATE FUNCTION parcel_physical_wz_allocate(lines jsonb,effects jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE remaining jsonb:='{}';result jsonb:='[]';l jsonb;c jsonb;f jsonb;alloc jsonb;need bigint;take bigint;BEGIN
 IF jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_typeof(effects) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid typed allocation arrays' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(lines) NOT BETWEEN 1 AND 500 OR jsonb_array_length(effects)>10000 THEN RAISE EXCEPTION 'Typed WZ extent budget' USING ERRCODE='54000';END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(lines) x GROUP BY x->>'item_id' HAVING count(*)<>1) THEN RAISE EXCEPTION 'Repeated historical item' USING ERRCODE='23514';END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(effects) LOOP
 IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR f->>'physical_id' IS NULL OR f->>'product_id' IS NULL OR f->>'warehouse_id' IS NULL
 OR jsonb_typeof(f->'quantity') IS DISTINCT FROM 'number' OR NOT coalesce(f->>'quantity'~'^[1-9][0-9]{0,9}$',false) THEN RAISE EXCEPTION 'Invalid native physical effect' USING ERRCODE='23514';END IF;
 IF (f->>'quantity')::bigint>1000000000 THEN RAISE EXCEPTION 'Physical effect quantity budget' USING ERRCODE='54000';END IF;
 IF remaining ? (f->>'physical_id') THEN RAISE EXCEPTION 'Repeated physical effect identity' USING ERRCODE='23514';END IF;
 remaining:=remaining||jsonb_build_object(f->>'physical_id',(f->>'quantity')::bigint);
 END LOOP;
 FOR l IN SELECT value FROM jsonb_array_elements(lines) ORDER BY value->>'item_id' LOOP
 IF l->>'lineage_kind' IS DISTINCT FROM 'physical_item_components_v1' OR l ? 'quantity'
 OR jsonb_typeof(l->'component_quantities') IS DISTINCT FROM 'array' OR jsonb_typeof(l->'components') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'No fake commercial quantity or mixed untyped rows' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(l->'component_quantities') NOT BETWEEN 1 AND 500 OR EXISTS(SELECT FROM jsonb_array_elements(l->'component_quantities') x GROUP BY x->>'product_id' HAVING count(*)<>1)
 THEN RAISE EXCEPTION 'Invalid component count set' USING ERRCODE='23514';END IF;
 alloc:='[]';
 FOR c IN SELECT value FROM jsonb_array_elements(l->'component_quantities') ORDER BY value->>'product_id' LOOP
 IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR(c-ARRAY['product_id','quantity'])<>'{}' OR jsonb_typeof(c->'quantity') IS DISTINCT FROM 'number'
 OR NOT coalesce(c->>'quantity'~'^[1-9][0-9]{0,9}$',false) OR NOT EXISTS(SELECT FROM jsonb_array_elements(l->'components') r WHERE r->>'product_id'=c->>'product_id')
 THEN RAISE EXCEPTION 'Invalid emitted source component' USING ERRCODE='23514';END IF;
 need:=(c->>'quantity')::bigint;IF need>1000000000 THEN RAISE EXCEPTION 'Component budget' USING ERRCODE='54000';END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(effects) WHERE value->>'product_id'=c->>'product_id' ORDER BY value->>'physical_id' LOOP
 take:=least(need,(remaining->>(f->>'physical_id'))::bigint);
 IF take>0 THEN
 alloc:=alloc||jsonb_build_array(jsonb_build_object('physical_id',f->>'physical_id','product_id',c->>'product_id','warehouse_id',f->>'warehouse_id','quantity',take));
 remaining:=jsonb_set(remaining,ARRAY[f->>'physical_id'],to_jsonb((remaining->>(f->>'physical_id'))::bigint-take));need:=need-take;
 END IF;
 EXIT WHEN need=0;
 END LOOP;
 IF need<>0 THEN RAISE EXCEPTION 'Actual physical effects do not cover mapped component' USING ERRCODE='23514';END IF;
 END LOOP;
 result:=result||jsonb_build_array(l||jsonb_build_object('allocations',alloc));
 END LOOP;
 IF EXISTS(SELECT FROM jsonb_each_text(remaining) WHERE value::bigint<>0) THEN RAISE EXCEPTION 'Unconsumed physical fragment' USING ERRCODE='23514';END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION parcel_physical_wz_allocate(jsonb,jsonb) FROM PUBLIC,dyna_app;

-- FRAGMENT: issuer-successors.sql
-- SOURCE_DRAFT: execute only inside a complete certified migration assembled per CONTRACT.md.
-- Old151 signatures/OIDs/ACL unchanged; finish/effects/record_guard/source_seal/fingerprint remain literal.
CREATE OR REPLACE FUNCTION warehouse_wz_issuer_prepare(uid uuid,kid uuid,src jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
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
 IF src->>'kind'='parcel' AND commercial IS NULL THEN commercial:=public.parcel_physical_wz_lines_for_dispatch(uid,kid,src);END IF;
 IF commercial IS NULL OR jsonb_array_length(commercial)=0 THEN RAISE EXCEPTION 'WZ wymaga rzeczywistej historycznej tożsamości pozycji' USING ERRCODE='23514';END IF;
 IF commercial->0->>'lineage_kind'='physical_item_components_v1' THEN
  IF src->>'kind'<>'parcel' OR commercial IS DISTINCT FROM public.parcel_physical_wz_lines_for_dispatch(uid,kid,src) THEN RAISE EXCEPTION 'Typed physical source differs from native approved map' USING ERRCODE='23514';END IF;
 ELSE
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(commercial) l LEFT JOIN public.order_items i ON(i.tenant_id,i.order_id,i.id)=(t,oid,(l->>'item_id')::uuid)
  WHERE i.id IS NULL OR(i.product_id,i.name,i.sku,i.line_total,i.vat) IS DISTINCT FROM((l->>'product_id')::uuid,l->>'name',l->>'sku',(l->>'line_total')::bigint,(l->>'vat')::integer) OR(l->>'quantity')::integer<1 OR(l->>'quantity')::integer>i.quantity
  OR l->'components' IS DISTINCT FROM CASE WHEN jsonb_array_length(i.components)>0 THEN i.components ELSE jsonb_build_array(jsonb_build_object('product_id',i.product_id,'quantity',1)) END)
 THEN RAISE EXCEPTION 'Niepełne historyczne pozycje WZ' USING ERRCODE='23514';END IF;
 IF (SELECT coalesce(jsonb_object_agg(product_id,q),'{}') FROM(SELECT p->>'product_id' product_id,sum((p->>'quantity')::bigint) q FROM jsonb_array_elements(products) p GROUP BY 1)x)
 IS DISTINCT FROM(SELECT coalesce(jsonb_object_agg(product_id,q),'{}') FROM(SELECT c->>'product_id' product_id,sum((l->>'quantity')::bigint*(c->>'quantity')::bigint) q FROM jsonb_array_elements(commercial) l CROSS JOIN LATERAL jsonb_array_elements(l->'components') c GROUP BY 1)x)
 THEN RAISE EXCEPTION 'Receptury nie pokrywają fizycznego WZ' USING ERRCODE='23514';END IF;
 END IF;
 SELECT to_jsonb(p) INTO pol FROM public.wms_policies p WHERE tenant_id=t AND enabled;
 SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.series_id),'[]') INTO cb FROM public.warehouse_wz_issuer_counters c WHERE c.tenant_id=t AND c.year=y AND EXISTS(SELECT 1 FROM jsonb_array_elements(cfg) x WHERE x->'configuration'->>'series_id'=c.series_id::text);
 INSERT INTO public.warehouse_wz_issuer_admissions(id,tenant_id,order_id,shipment_id,actor_id,api_key_id,source,frame,before_snapshot)
 VALUES(eid,t,oid,sid,uid,kid,src,jsonb_build_object('products',products,'commercial_lines',commercial,'configurations',cfg,'policy',pol,'year',y,'counters_before',cb),sn);
 IF commercial->0->>'lineage_kind'='physical_item_components_v1' THEN PERFORM public.parcel_physical_wz_bind_admission(eid);END IF;
 RETURN eid;
END $$;

CREATE OR REPLACE FUNCTION warehouse_wz_issuer_commercial(lines jsonb,effects jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE lefts jsonb:='{}';result jsonb:='[]';l jsonb;c jsonb;f jsonb;alloc jsonb;need bigint;take bigint;BEGIN
 IF lines->0->>'lineage_kind'='physical_item_components_v1' THEN RETURN public.parcel_physical_wz_allocate(lines,effects);END IF;
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

CREATE OR REPLACE FUNCTION warehouse_wz_issuer_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.warehouse_wz_issuer_admissions;r public.warehouse_wz_issuer_receipts;d public.warehouse_wz_issuer_documents;e jsonb;cfg jsonb;actual jsonb;expected jsonb;sumry jsonb;seq bigint;BEGIN
 SELECT * INTO a FROM public.warehouse_wz_issuer_admissions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id);
 IF a.txid<>pg_current_xact_id() OR a.after_snapshot IS NULL OR a.physical IS NULL THEN RAISE EXCEPTION 'Niepełny automatyczny WZ' USING ERRCODE='23514';END IF;
 IF a.after_snapshot IS DISTINCT FROM public.warehouse_wz_issuer_snapshot(a.tenant_id,a.order_id) THEN RAISE EXCEPTION 'Źródło zmieniło się po wystawieniu WZ' USING ERRCODE='23514';END IF;
 IF a.frame->'commercial_lines'->0->>'lineage_kind'='physical_item_components_v1' THEN PERFORM public.parcel_physical_wz_validate_admission(a.id);END IF;
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

CREATE OR REPLACE FUNCTION warehouse_wz_issuer_guards() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expected text;BEGIN
 IF NOT public.warehouse_wz_issuer_installed() THEN RETURN false;END IF;
 IF to_regprocedure('public.warehouse_automatic_wz_guards()') IS NULL OR NOT public.warehouse_automatic_wz_guards() THEN RETURN false;END IF;
 IF(SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['orders','order_items','shipments','reservations','reservation_locations','stock','stock_locations','wms_reservation_layers','wms_layer_positions','stock_movements','stock_location_movements','wms_operations','wms_issue_fragments','wms_layer_movements'])
  AND t.tgname='warehouse_wz_issuer_source_seal' AND t.tgfoid='public.warehouse_wz_issuer_source_seal()'::regprocedure AND t.tgtype=31 AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgargs='\x'::bytea AND t.tgattr::text='')<>14 THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname LIKE 'warehouse_wz_issuer_%' AND a.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_attribute b ON b.attrelid=c.oid CROSS JOIN LATERAL aclexplode(b.attacl) a WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'warehouse_wz_issuer_%' AND a.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'warehouse_wz_issuer_%' AND a.grantee<>p.proowner) THEN RETURN false;END IF;
 SELECT fingerprint INTO expected FROM public.warehouse_wz_issuer_manifest WHERE singleton;
 RETURN expected IS NOT NULL AND public.parcel_physical_wz_valid();
EXCEPTION WHEN undefined_table OR undefined_function OR undefined_column THEN RETURN false;
END $$;

-- FRAGMENT: certificate-seal.sql
-- LAST fragment. Complete certificate data is private/immutable, parent row stays literal.
CREATE TABLE parcel_physical_wz_certificate(
 singleton boolean PRIMARY KEY CHECK(singleton),profile text NOT NULL CHECK(profile='151-original-physical-component-successor/v1'),
 original151_manifest jsonb NOT NULL,predecessor_fingerprint text NOT NULL,predecessor_functions jsonb NOT NULL,predecessor_triggers jsonb NOT NULL,
 original167_certificate jsonb NOT NULL,successor151_fingerprint text NOT NULL,successor_functions jsonb NOT NULL,own_fingerprint text NOT NULL,
 installed_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON parcel_physical_wz_certificate FROM PUBLIC,dyna_app;
CREATE FUNCTION parcel_physical_wz_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',pg_get_userbyid(c.relowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'parcel_physical_wz_') AND c.relkind IN('r','p')),
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'number',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(a.attacl) x),'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'collation',(SELECT collname FROM pg_collation WHERE oid=a.attcollation)) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum) WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'parcel_physical_wz_') AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',c.conname,'def',pg_get_constraintdef(c.oid,true),'validated',c.convalidated) ORDER BY t.relname,c.conname) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relnamespace='public'::regnamespace AND starts_with(t.relname,'parcel_physical_wz_')),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',idx.relname,'def',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) ORDER BY t.relname,idx.relname) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid WHERE t.relnamespace='public'::regnamespace AND starts_with(t.relname,'parcel_physical_wz_')),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',t.tgname,'def',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY n.nspname,c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND(starts_with(t.tgname,'parcel_physical_wz_') OR(c.relnamespace='public'::regnamespace AND starts_with(c.relname,'parcel_physical_wz_')))),
 'policies',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END) FROM unnest(p.polroles) r),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname,p.polname) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'parcel_physical_wz_')),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'def',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x),'app_execute',has_function_privilege('dyna_app',p.oid,'EXECUTE')) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'parcel_physical_wz_')),
 'app_role',(SELECT jsonb_build_object('superuser',r.rolsuper,'inherit',r.rolinherit,'bypass_rls',r.rolbypassrls,'create_role',r.rolcreaterole,'create_db',r.rolcreatedb,'login',r.rolcanlogin) FROM pg_roles r WHERE rolname='dyna_app'),
 'app_acl',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'select',has_table_privilege('dyna_app',c.oid,'SELECT'),'insert',has_table_privilege('dyna_app',c.oid,'INSERT'),'update',has_table_privilege('dyna_app',c.oid,'UPDATE'),'delete',has_table_privilege('dyna_app',c.oid,'DELETE')) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'parcel_physical_wz_') AND c.relkind IN('r','p'))
 )::text,'UTF8')),'hex')
$$;

CREATE FUNCTION parcel_physical_wz_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE cert parcel_physical_wz_certificate;saved jsonb;actual jsonb;n text;expected jsonb:='{"warehouse_wz_issuer_commercial":"ff3a360178eca1e85c623678290a79ca0daf06e0c4d0b6ddff95b2eb5089ab5e","warehouse_wz_issuer_effects":"9d1970aad9edaf4e7fcee867bf59df85184a494ecdfe5478940f7ffd08f660e6","warehouse_wz_issuer_finish":"8197d0956d44b0d1062f1072668a35a76b70b32fda15b5b8ebdc383f94b6d7dc","warehouse_wz_issuer_access":"8a94cd8ce10a17f7fcee6f57209f89619d604f31e31dd57896816b262ab7e1b4","warehouse_wz_issuer_snapshot":"9f07289798db9788263b03e884218faed506b38d127861328815731bae6a0365","warehouse_wz_issuer_prepare":"76ece3a21d4df401cf534ab79b5b14aa037cf30d6bb81fd99d9467a50f0fdd06","warehouse_wz_issuer_record_guard":"22fe527363c170f2fb1527db5193de620ba7be2db1cf9fe067f88c5d11e5d034","warehouse_wz_issuer_complete":"a5956e31f27adf662949905701153bbf4c2729b68b4a1caef8c8499712b5c4ad","warehouse_wz_issuer_source_seal":"3cde51f5df2b882f26474378974b64ed8daac1c6db8dcb0a900f69e35839eb52","warehouse_wz_issuer_hash":"68ce179ff3c4500519f3b13abd83717d93dd70b35bf57195a26e105b3763e013","warehouse_wz_issuer_installed":"813e2ffeefda8491a8ee4f56b43953894d82a0edba20f4803db1b5c0599e1785","warehouse_wz_issuer_fingerprint":"fb6ad23cafc0fc41f0889757bbf892fe4d8f008b00fadba86da411eebb3de663","warehouse_wz_issuer_guards":"d863e8454d576cd10559495dd55cf90eecbd9b58d68c952e443d1cc33ec7deaa","warehouse_wz_issuer_require":"38df95080d4dfded515349e8621b2f9ffae49f10070c9ebbc979478b788ac47e"}'::jsonb;r oid;BEGIN
 IF current_setting('session_replication_role')<>'origin' OR to_regclass('public.parcel_physical_wz_certificate') IS NULL
 OR to_regclass('public.warehouse_wz_issuer_manifest') IS NULL OR to_regclass('public.operative_delivery_certificate') IS NULL
 OR to_regprocedure('public.warehouse_wz_issuer_fingerprint()') IS NULL OR to_regprocedure('public.parcel_physical_wz_fingerprint()') IS NULL
 OR (SELECT count(*) FROM parcel_physical_wz_certificate)<>1
 OR (SELECT array_agg(relname::text ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'parcel_physical_wz_') AND relkind IN('r','p'))
 IS DISTINCT FROM ARRAY['parcel_physical_wz_bindings','parcel_physical_wz_certificate','parcel_physical_wz_mappings','parcel_physical_wz_previews']::text[] THEN RETURN false;END IF;
 SELECT * INTO cert FROM parcel_physical_wz_certificate;
 IF jsonb_typeof(cert.original151_manifest) IS DISTINCT FROM 'object' OR jsonb_typeof(cert.original167_certificate) IS DISTINCT FROM 'object'
 OR jsonb_typeof(cert.predecessor_functions) IS DISTINCT FROM 'object' OR jsonb_typeof(cert.successor_functions) IS DISTINCT FROM 'object'
 OR jsonb_typeof(cert.predecessor_triggers) IS DISTINCT FROM 'array'
 THEN RETURN false;END IF;
 IF cert.profile<>'151-original-physical-component-successor/v1'
 OR cert.original151_manifest IS DISTINCT FROM(SELECT to_jsonb(m) FROM warehouse_wz_issuer_manifest m)
 OR cert.original167_certificate IS DISTINCT FROM(SELECT to_jsonb(c) FROM operative_delivery_certificate c)
 OR cert.predecessor_fingerprint IS DISTINCT FROM cert.original151_manifest->>'fingerprint'
 OR cert.successor151_fingerprint IS DISTINCT FROM warehouse_wz_issuer_fingerprint()
 OR cert.own_fingerprint IS DISTINCT FROM parcel_physical_wz_fingerprint()
 OR cert.predecessor_triggers IS DISTINCT FROM parcel_physical_wz_predecessor_triggers()
 OR cert.successor_functions IS DISTINCT FROM parcel_physical_wz_predecessor_functions()
 THEN RETURN false;END IF;
 IF(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(cert.predecessor_functions) k(key)) IS DISTINCT FROM(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(expected) k(key))
 OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(cert.successor_functions) k(key)) IS DISTINCT FROM(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(expected) k(key)) THEN RETURN false;END IF;
 FOR n IN SELECT jsonb_object_keys(expected) LOOP
 saved:=cert.predecessor_functions->n;actual:=cert.successor_functions->n;
 IF jsonb_typeof(saved) IS DISTINCT FROM 'object' OR jsonb_typeof(actual) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF encode(sha256(convert_to(saved->>'body','UTF8')),'hex') IS DISTINCT FROM expected->>n THEN RETURN false;END IF;
 IF n=ANY(ARRAY['warehouse_wz_issuer_prepare','warehouse_wz_issuer_commercial','warehouse_wz_issuer_complete','warehouse_wz_issuer_guards']) THEN
 IF(saved-'body'-'definition') IS DISTINCT FROM(actual-'body'-'definition')
 OR replace(actual->>'definition',actual->>'body',saved->>'body') IS DISTINCT FROM saved->>'definition' THEN RETURN false;END IF;
 ELSE IF saved IS DISTINCT FROM actual THEN RETURN false;END IF;END IF;
 END LOOP;
 -- Metadata-only leaf: no ancestor/full guard calls; guarded parent151 invokes it.
 IF EXISTS(SELECT FROM migrations WHERE name='168_physical_parcel_wz') THEN RETURN true;END IF;
 r:=to_regclass('pg_temp.parcel_physical_wz_install_basis');IF r IS NULL THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT FROM pg_class WHERE oid=r AND relpersistence='t' AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) OR EXISTS(SELECT FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=r AND a.grantee<>c.relowner) OR(SELECT count(*) FROM pg_temp.parcel_physical_wz_install_basis)<>1 THEN RETURN false;END IF;
 RETURN current_user=session_user AND EXISTS(SELECT FROM pg_temp.parcel_physical_wz_install_basis b WHERE b.root_xid=pg_current_xact_id()::text AND b.start_at=transaction_timestamp() AND b.backend_pid=pg_backend_pid() AND b.owner_name=current_user
 AND b.original151_manifest=cert.original151_manifest AND b.predecessor_functions=cert.predecessor_functions AND b.predecessor_triggers=cert.predecessor_triggers AND b.original167_certificate=cert.original167_certificate);
EXCEPTION WHEN undefined_table OR undefined_function OR undefined_column THEN RETURN false;
END $$;
CREATE FUNCTION parcel_physical_wz_certificate_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r oid;BEGIN
 IF TG_OP<>'INSERT' OR current_user<>session_user THEN RAISE EXCEPTION 'Physical WZ certificate is immutable' USING ERRCODE='42501';END IF;
 r:=to_regclass('pg_temp.parcel_physical_wz_install_basis');IF r IS NULL THEN RAISE EXCEPTION 'No root migration basis' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT FROM pg_class WHERE oid=r AND relpersistence='t' AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) OR EXISTS(SELECT FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=r AND a.grantee<>c.relowner) OR(SELECT count(*) FROM pg_temp.parcel_physical_wz_install_basis)<>1
 OR EXISTS(SELECT FROM migrations WHERE name='168_physical_parcel_wz')
 OR NOT EXISTS(SELECT FROM pg_temp.parcel_physical_wz_install_basis b WHERE b.root_xid=pg_current_xact_id()::text AND b.start_at=transaction_timestamp() AND b.backend_pid=pg_backend_pid() AND b.owner_name=current_user
 AND NEW.original151_manifest=b.original151_manifest AND NEW.predecessor_functions=b.predecessor_functions AND NEW.predecessor_triggers=b.predecessor_triggers AND NEW.original167_certificate=b.original167_certificate)
 OR NEW.successor151_fingerprint IS DISTINCT FROM warehouse_wz_issuer_fingerprint() OR NEW.successor_functions IS DISTINCT FROM parcel_physical_wz_predecessor_functions() OR NEW.own_fingerprint IS DISTINCT FROM parcel_physical_wz_fingerprint()
 THEN RAISE EXCEPTION 'Root-certified physical WZ migration basis changed' USING ERRCODE='55000';END IF;RETURN NEW;
END $$;
CREATE TRIGGER parcel_physical_wz_certificate_seal BEFORE INSERT OR UPDATE OR DELETE ON parcel_physical_wz_certificate FOR EACH ROW EXECUTE FUNCTION parcel_physical_wz_certificate_seal();
REVOKE ALL ON FUNCTION parcel_physical_wz_valid(),parcel_physical_wz_certificate_seal(),parcel_physical_wz_fingerprint(),parcel_physical_wz_predecessor_functions(),parcel_physical_wz_predecessor_triggers() FROM PUBLIC,dyna_app;
INSERT INTO parcel_physical_wz_certificate(singleton,profile,original151_manifest,predecessor_fingerprint,predecessor_functions,predecessor_triggers,original167_certificate,successor151_fingerprint,successor_functions,own_fingerprint)
 SELECT true,'151-original-physical-component-successor/v1',original151_manifest,predecessor_fingerprint,predecessor_functions,predecessor_triggers,original167_certificate,warehouse_wz_issuer_fingerprint(),parcel_physical_wz_predecessor_functions(),parcel_physical_wz_fingerprint() FROM pg_temp.parcel_physical_wz_install_basis;
DO $$BEGIN IF NOT parcel_physical_wz_valid() OR NOT warehouse_wz_issuer_guards() OR NOT operative_delivery_valid() OR NOT buyer_address_guards() OR NOT catalog_stock_control_guards()
 THEN RAISE EXCEPTION 'Certified physical WZ or unchanged ancestors refused' USING ERRCODE='55000';END IF;END $$;
-- Root appends168_physical_parcel_wz in this SAME owner managed transaction.
