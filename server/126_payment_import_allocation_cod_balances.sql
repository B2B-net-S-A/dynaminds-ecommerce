-- Add full COD cash/fee balances without rewriting 124/125 or historical receipts.
-- CREATE OR REPLACE preserves existing function identities, security settings and grants.
-- Reversals retain signed amount/fee while their original kind determines the ledger bucket.

CREATE OR REPLACE FUNCTION payment_allocation_snapshot(oid uuid,sid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;o orders%ROWTYPE;own orders%ROWTYPE;ownerid uuid;ids uuid[];entries jsonb;ret jsonb;checks jsonb;guards jsonb;sh jsonb;coll bigint;settled bigint;ship_remitted bigint;ship_fees bigint;owner_collected bigint;owner_remitted bigint;owner_fees bigint;received bigint;refund bigint;credit bigint;nominal bigint;BEGIN
 WITH RECURSIVE chain AS(SELECT oid id,ARRAY[oid] path,false cycle UNION ALL SELECT m.target_order_id,chain.path||m.target_order_id,m.target_order_id=ANY(chain.path) FROM chain JOIN order_merge_claims m ON m.tenant_id=t AND m.source_order_id=chain.id WHERE cardinality(chain.path)<=1000 AND NOT chain.cycle) SELECT CASE WHEN cycle OR cardinality(path)>1000 THEN NULL ELSE id END INTO ownerid FROM chain ORDER BY cardinality(path) DESC LIMIT 1;
 IF ownerid IS NULL THEN RAISE EXCEPTION 'Nieprawidłowy łańcuch scalania' USING ERRCODE='23514';END IF;
 SELECT * INTO o FROM orders WHERE(tenant_id,id)=(t,oid);SELECT * INTO own FROM orders WHERE(tenant_id,id)=(t,ownerid);IF o.id IS NULL OR own.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego zamówienia' USING ERRCODE='P0002';END IF;
 WITH RECURSIVE incoming AS(SELECT ownerid id UNION SELECT m.source_order_id FROM incoming JOIN order_merge_claims m ON m.tenant_id=t AND m.target_order_id=incoming.id) SELECT array_agg(id ORDER BY id) INTO ids FROM incoming;
 IF cardinality(ids)>10000 THEN RAISE EXCEPTION 'Zbyt duża historia scalania' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'),coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind) IN('receipt','courier_collection')),0),coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind)='refund'),0),
 coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind)='courier_collection'),0),coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind)='courier_remittance'),0),coalesce(sum(p.fee) FILTER(WHERE coalesce(r.kind,p.kind)='courier_remittance'),0)
 INTO entries,received,refund,owner_collected,owner_remitted,owner_fees FROM payment_entries p LEFT JOIN payment_entries r ON(r.tenant_id,r.order_id,r.id)=(p.tenant_id,p.order_id,p.reversal_of) WHERE p.tenant_id=t AND p.order_id=ANY(ids);
 SELECT coalesce(jsonb_agg(to_jsonb(rc) ORDER BY rc.id),'[]'),coalesce(sum(refund_amount) FILTER(WHERE state IN('refund_pending','closed')),0) INTO ret,credit FROM return_cases rc WHERE tenant_id=t AND order_id=ANY(ids);
 SELECT coalesce(jsonb_agg(to_jsonb(sc)||jsonb_build_object('order_version',sc.order_version::text) ORDER BY sc.id),'[]') INTO checks FROM source_payment_checks sc WHERE tenant_id=t AND order_id=ANY(ids);
 SELECT coalesce(jsonb_agg(to_jsonb(sp) ORDER BY sp.id),'[]') INTO guards FROM shipping_plans sp WHERE tenant_id=t AND order_id=ANY(ids) AND state NOT IN('cancelled','dispatched') AND phase IN('create_started','numbers_ready','buy_started','refresh_started');
 SELECT to_jsonb(ship) INTO sh FROM shipments ship WHERE(tenant_id,order_id,id)=(t,oid,sid);IF sid IS NOT NULL AND sh IS NULL THEN RAISE EXCEPTION 'Przesyłka nie należy do zamówienia' USING ERRCODE='P0002';END IF;
 SELECT coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind)='courier_collection'),0),coalesce(sum(p.amount::bigint+p.fee) FILTER(WHERE coalesce(r.kind,p.kind)='courier_remittance'),0),coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind)='courier_remittance'),0),coalesce(sum(p.fee) FILTER(WHERE coalesce(r.kind,p.kind)='courier_remittance'),0) INTO coll,settled,ship_remitted,ship_fees FROM payment_entries p LEFT JOIN payment_entries r ON(r.tenant_id,r.order_id,r.id)=(p.tenant_id,p.order_id,p.reversal_of) WHERE(p.tenant_id,p.order_id,p.shipment_id)=(t,oid,sid);
 nominal:=CASE WHEN own.status='cancelled' THEN 0 ELSE greatest(own.total::bigint-credit,0) END;
 RETURN jsonb_build_object('order',to_jsonb(o)||jsonb_build_object('version',o.version::text),'owner',to_jsonb(own)||jsonb_build_object('version',own.version::text),'source_ids',ids,
 'balance',jsonb_build_object('amount_due',greatest(nominal-received+refund,0)::text,'received',received::text,'refunded',refund::text,'credit',credit::text,'currency',own.currency,
 'overpayment',greatest(received-refund-nominal,0)::text,'collected',owner_collected::text,'remitted',owner_remitted::text,'fees',owner_fees::text,'courier_due',(owner_collected-owner_remitted-owner_fees)::text),
 'entries',entries,'returns',ret,'source_checks',checks,'shipping_guards',guards,'shipment',sh,'shipment_sums',jsonb_build_object('collected',coll::text,'settled',settled::text,'remitted',ship_remitted::text,'fees',ship_fees::text,'courier_due',(coll-ship_remitted-ship_fees)::text),
 'merge_claims',coalesce((SELECT jsonb_agg(to_jsonb(mc) ORDER BY source_order_id) FROM order_merge_claims mc WHERE tenant_id=t AND(source_order_id=ANY(ids) OR target_order_id=ANY(ids))),'[]'));
END$$;

CREATE OR REPLACE FUNCTION payment_allocation_frame(body jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;src jsonb;rowval jsonb;snap jsonb;rows_json jsonb:='[]';projected jsonb:='[]';afterbal jsonb;aftership jsonb;delta bigint;fee_delta bigint;owners uuid[];originals uuid[];ships uuid[];idx integer:=0;amt bigint:=0;fees bigint:=0;pr payment_import_profiles%ROWTYPE;ns payment_import_namespaces%ROWTYPE;p payment_import_previews%ROWTYPE;grp record;BEGIN
 PERFORM payment_allocation_require(uid,kid,false);PERFORM payment_allocation_locks();
 IF jsonb_typeof(body)<>'object' OR body-ARRAY['client_key','source_preview_id','source_row_id','source_version','allocations','unallocated_minor','unallocated_fee_minor','reason']<>'{}' OR jsonb_typeof(body->'allocations')<>'array' OR jsonb_array_length(body->'allocations') NOT BETWEEN 1 AND 100
 OR length(body->>'reason') NOT BETWEEN 3 AND 2000 OR jsonb_typeof(body->'unallocated_minor') IS DISTINCT FROM 'number' OR jsonb_typeof(body->'unallocated_fee_minor') IS DISTINCT FROM 'number' OR jsonb_typeof(body->'source_version') IS DISTINCT FROM 'number' OR(body->>'source_version')!~'^[0-9]+$' OR(body->>'unallocated_minor')!~'^[0-9]+$' OR(body->>'unallocated_fee_minor')!~'^[0-9]+$' OR(body->>'unallocated_minor')::bigint NOT BETWEEN 0 AND 2147483647 OR(body->>'unallocated_fee_minor')::bigint NOT BETWEEN 0 AND 2147483647 THEN RAISE EXCEPTION 'Niepoprawny plan podziału' USING ERRCODE='23514';END IF;
 src:=payment_allocation_source((body->>'source_preview_id')::uuid,(body->>'source_row_id')::uuid);
 IF(src->>'source_version')::integer IS DISTINCT FROM(body->>'source_version')::integer OR src->>'can_allocate' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Zmieniło się pozostałe saldo źródła' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM payment_import_previews WHERE(tenant_id,id)=(t,(body->>'source_preview_id')::uuid);
 SELECT * INTO pr FROM payment_import_profiles WHERE(tenant_id,id)=(t,p.profile_id) FOR SHARE;SELECT * INTO ns FROM payment_import_namespaces WHERE(tenant_id,id)=(t,p.namespace_id) FOR SHARE;
 IF pr.version IS DISTINCT FROM p.profile_version OR pr.deleted_at IS NOT NULL OR ns.version IS DISTINCT FROM p.namespace_version OR NOT ns.enabled OR pr.definition IS DISTINCT FROM p.profile THEN RAISE EXCEPTION 'Format lub domena zmieniły się' USING ERRCODE='23514';END IF;
 PERFORM payment_allocation_require(pr.approved_by,NULL,false);
 FOR rowval IN SELECT value FROM jsonb_array_elements(body->'allocations') LOOP
 IF jsonb_typeof(rowval) IS DISTINCT FROM 'object' OR rowval-ARRAY['order_id','shipment_id','amount_minor','fee_minor']<>'{}' OR jsonb_typeof(rowval->'amount_minor') IS DISTINCT FROM 'number' OR jsonb_typeof(rowval->'fee_minor') IS DISTINCT FROM 'number' OR(rowval->>'amount_minor')!~'^[0-9]+$' OR(rowval->>'fee_minor')!~'^[0-9]+$' OR(rowval->>'amount_minor')::bigint NOT BETWEEN 0 AND 2147483647 OR(rowval->>'fee_minor')::bigint NOT BETWEEN 0 AND 2147483647 OR(rowval->>'amount_minor')::bigint+(rowval->>'fee_minor')::bigint<=0 THEN RAISE EXCEPTION 'Niepoprawny przydział' USING ERRCODE='23514';END IF;
 snap:=payment_allocation_snapshot((rowval->>'order_id')::uuid,(rowval->>'shipment_id')::uuid);owners:=array_append(owners,(snap->'owner'->>'id')::uuid);originals:=array_append(originals,(rowval->>'order_id')::uuid);IF rowval->>'shipment_id' IS NOT NULL THEN ships:=array_append(ships,(rowval->>'shipment_id')::uuid);END IF;
 END LOOP;
 PERFORM id FROM orders WHERE tenant_id=t AND id=ANY(owners) ORDER BY id FOR UPDATE;
 PERFORM id FROM orders WHERE tenant_id=t AND id=ANY(originals) AND NOT id=ANY(owners) ORDER BY id FOR KEY SHARE;
 PERFORM id FROM shipments WHERE tenant_id=t AND id=ANY(ships) ORDER BY id FOR SHARE;
 FOR rowval IN SELECT value FROM jsonb_array_elements(body->'allocations') LOOP
 snap:=payment_allocation_snapshot((rowval->>'order_id')::uuid,(rowval->>'shipment_id')::uuid);
 IF(snap->'owner'->>'id')::uuid IS DISTINCT FROM owners[idx+1] THEN RAISE EXCEPTION 'Właściciel płatności zmienił się' USING ERRCODE='23514';END IF;
 IF snap->'order'->>'fulfillment_kind'<>'sale' OR snap->'owner'->>'fulfillment_kind'<>'sale' OR snap->'owner'->>'status'='cancelled' OR snap->'owner'->>'status' LIKE 'return_%' OR jsonb_array_length(snap->'returns')>0 OR jsonb_array_length(snap->'shipping_guards')>0 OR snap->'order'->>'currency' IS DISTINCT FROM src->>'currency' OR snap->'owner'->>'currency' IS DISTINCT FROM src->>'currency'
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(snap->'entries') ent WHERE ent->>'currency' IS DISTINCT FROM src->>'currency') THEN RAISE EXCEPTION 'Cel wymaga uzgodnienia finansowego' USING ERRCODE='23514';END IF;
 IF src->>'ledger_kind'='receipt' THEN
 IF rowval->>'shipment_id' IS NOT NULL OR(rowval->>'fee_minor')::bigint<>0 OR snap->'order'->>'payment_mode'<>'prepaid' OR snap->'owner'->>'payment_mode'<>'prepaid' THEN RAISE EXCEPTION 'Wpłata bankowa wymaga przedpłaty' USING ERRCODE='23514';END IF;
 ELSE
 IF snap->'order'->>'payment_mode'<>'cod' OR snap->'owner'->>'payment_mode'<>'cod' OR snap->'shipment'->>'dispatched_at' IS NULL OR snap->'shipment'->>'carrier' IS DISTINCT FROM pr.definition->'match'->>'carrier' THEN RAISE EXCEPTION 'COD wymaga przekazanej przesyłki zgodnego przewoźnika' USING ERRCODE='23514';END IF;
 IF src->>'ledger_kind'='courier_collection' AND((rowval->>'fee_minor')::bigint<>0 OR(rowval->>'amount_minor')::bigint>(snap->'shipment'->>'cod_expected')::bigint-(snap->'shipment_sums'->>'collected')::bigint) THEN RAISE EXCEPTION 'Pobranie przekracza pozostały limit' USING ERRCODE='23514';END IF;
 IF src->>'ledger_kind'='courier_remittance' AND(rowval->>'amount_minor')::bigint+(rowval->>'fee_minor')::bigint>(snap->'shipment_sums'->>'collected')::bigint-(snap->'shipment_sums'->>'settled')::bigint THEN RAISE EXCEPTION 'Rozliczenie nie ma wystarczającego pobrania' USING ERRCODE='23514';END IF;
 END IF;
 amt:=amt+(rowval->>'amount_minor')::bigint;fees:=fees+(rowval->>'fee_minor')::bigint;
 rows_json:=rows_json||jsonb_build_array(rowval||jsonb_build_object('shipment_id',rowval->'shipment_id','index',idx,'before',snap,'after',NULL));idx:=idx+1;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(rows_json) rr GROUP BY rr->>'order_id',rr->>'shipment_id' HAVING count(*)>1) THEN RAISE EXCEPTION 'Powtórzony cel przydziału' USING ERRCODE='23514';END IF;
 IF amt+(body->>'unallocated_minor')::bigint<>(src->>'remaining_amount_minor')::bigint OR fees+(body->>'unallocated_fee_minor')::bigint<>(src->>'remaining_fee_minor')::bigint THEN RAISE EXCEPTION 'Podział nie zachowuje kwoty i opłat źródła' USING ERRCODE='23514';END IF;
 IF src->>'ledger_kind'='receipt' THEN FOR grp IN SELECT rr->'before'->'owner'->>'id' owner_id,sum((rr->>'amount_minor')::bigint) total,min((rr->'before'->'balance'->>'amount_due')::bigint) due FROM jsonb_array_elements(rows_json) rr GROUP BY rr->'before'->'owner'->>'id' LOOP
 IF grp.total>grp.due THEN RAISE EXCEPTION 'Wpłata przekracza bieżącą należność' USING ERRCODE='23514';END IF;END LOOP;END IF;
 -- Owner totals include the whole approved plan; parcel totals belong only to its own original order/shipment.
 FOR rowval IN SELECT value FROM jsonb_array_elements(rows_json) LOOP
 afterbal:=rowval->'before'->'balance';aftership:=rowval->'before'->'shipment_sums';
 SELECT coalesce(sum((rr->>'amount_minor')::bigint),0),coalesce(sum((rr->>'fee_minor')::bigint),0) INTO delta,fee_delta
 FROM jsonb_array_elements(rows_json) rr WHERE rr->'before'->'owner'->>'id'=rowval->'before'->'owner'->>'id';
 IF src->>'ledger_kind' IN('receipt','courier_collection') THEN
 afterbal:=afterbal||jsonb_build_object('received',((afterbal->>'received')::bigint+delta)::text,'amount_due',greatest((afterbal->>'amount_due')::bigint-delta,0)::text,
 'overpayment',greatest((afterbal->>'overpayment')::bigint+delta-(afterbal->>'amount_due')::bigint,0)::text);
 END IF;
 IF src->>'ledger_kind'='courier_collection' THEN
 afterbal:=afterbal||jsonb_build_object('collected',((afterbal->>'collected')::bigint+delta)::text,'courier_due',((afterbal->>'courier_due')::bigint+delta)::text);
 aftership:=aftership||jsonb_build_object('collected',((aftership->>'collected')::bigint+(rowval->>'amount_minor')::bigint)::text,
 'courier_due',((aftership->>'courier_due')::bigint+(rowval->>'amount_minor')::bigint)::text);
 END IF;
 IF src->>'ledger_kind'='courier_remittance' THEN
 afterbal:=afterbal||jsonb_build_object('remitted',((afterbal->>'remitted')::bigint+delta)::text,'fees',((afterbal->>'fees')::bigint+fee_delta)::text,
 'courier_due',((afterbal->>'courier_due')::bigint-delta-fee_delta)::text);
 aftership:=aftership||jsonb_build_object('settled',((aftership->>'settled')::bigint+(rowval->>'amount_minor')::bigint+(rowval->>'fee_minor')::bigint)::text,
 'remitted',((aftership->>'remitted')::bigint+(rowval->>'amount_minor')::bigint)::text,'fees',((aftership->>'fees')::bigint+(rowval->>'fee_minor')::bigint)::text,
 'courier_due',((aftership->>'courier_due')::bigint-(rowval->>'amount_minor')::bigint-(rowval->>'fee_minor')::bigint)::text);
 END IF;
 projected:=projected||jsonb_build_array(rowval||jsonb_build_object('after',jsonb_build_object('balance',afterbal,'shipment_sums',aftership)));END LOOP;rows_json:=projected;
 PERFORM payment_allocation_require(pr.approved_by,NULL,false);PERFORM payment_allocation_require(uid,kid,false);
 RETURN jsonb_build_object('request',body,'source',src,'allocations',rows_json,'summary',jsonb_build_object('count',idx,'amount_minor',amt,'fee_minor',fees,'unallocated_minor',(body->>'unallocated_minor')::bigint,'unallocated_fee_minor',(body->>'unallocated_fee_minor')::bigint,'currency',src->>'currency'),'profile_state',jsonb_build_object('profile_id',pr.id,'profile_version',pr.version,'approved_by',pr.approved_by,'namespace_id',ns.id,'namespace_version',ns.version));
END$$;

CREATE OR REPLACE FUNCTION payment_allocation_store_execution(v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p payment_import_allocation_previews%ROWTYPE;a payment_import_allocation_admissions%ROWTYPE;e payment_import_allocation_executions%ROWTYPE;rowval jsonb;approved jsonb;pay payment_entries%ROWTYPE;idx integer:=0;actual jsonb;BEGIN
 PERFORM payment_allocation_require(uid,kid,false);SELECT * INTO a FROM payment_import_allocation_admissions WHERE(tenant_id,id)=(t,(v->>'id')::uuid) AND top_xid=pg_current_xact_id() AND transaction_started_at=transaction_timestamp();SELECT * INTO p FROM payment_import_allocation_previews WHERE(tenant_id,id)=(t,a.preview_id);
 IF a.id IS NULL OR(a.actor_id,a.api_key_id) IS DISTINCT FROM(uid,kid) OR v->>'scope_hash' IS DISTINCT FROM p.scope_hash OR(v->>'preview_id')::uuid IS DISTINCT FROM p.id OR jsonb_typeof(v->'allocations')<>'array' OR jsonb_array_length(v->'allocations')<>jsonb_array_length(p.payload->'allocations') OR v->'request' IS DISTINCT FROM jsonb_build_object('client_key',v->>'client_key','version',1,'scope_hash',p.scope_hash,'confirmed',true,'local_ledger_only',true) THEN RAISE EXCEPTION 'Niepełny receipt podziału' USING ERRCODE='23514';END IF;
 FOR rowval IN SELECT value FROM jsonb_array_elements(v->'allocations') LOOP
 approved:=p.payload->'allocations'->idx;
 IF(rowval-ARRAY['entry_id','before_balance','after_balance','after_shipment_sums']) IS DISTINCT FROM approved OR(rowval->>'index')::integer<>idx OR rowval->'before_balance' IS DISTINCT FROM approved->'before'->'balance' THEN RAISE EXCEPTION 'Receipt zmienia zatwierdzony przydział' USING ERRCODE='23514';END IF;
 SELECT pe.* INTO pay FROM payment_entries pe JOIN payment_import_allocation_witnesses w ON(w.tenant_id,w.entry_id)=(pe.tenant_id,pe.id) WHERE(w.tenant_id,w.execution_id,w.index)=(t,a.id,idx) AND w.top_xid=pg_current_xact_id() AND w.transaction_started_at=transaction_timestamp() AND pe.id=(rowval->>'entry_id')::uuid;
 IF pay.id IS NULL OR(pay.order_id,pay.shipment_id,pay.amount,pay.fee,pay.kind,pay.currency) IS DISTINCT FROM((approved->>'order_id')::uuid,(approved->>'shipment_id')::uuid,(approved->>'amount_minor')::integer,(approved->>'fee_minor')::integer,p.payload->'source'->>'ledger_kind',p.payload->'source'->>'currency') THEN RAISE EXCEPTION 'Receipt nie ma dokładnej wpłaty' USING ERRCODE='23514';END IF;
 actual:=payment_allocation_snapshot((approved->>'order_id')::uuid,(approved->>'shipment_id')::uuid);
 IF rowval->'after_balance' IS DISTINCT FROM actual->'balance' THEN RAISE EXCEPTION 'Receipt ma nieprawdziwe saldo końcowe' USING ERRCODE='23514';END IF;
 IF rowval->'after_shipment_sums' IS DISTINCT FROM actual->'shipment_sums' THEN RAISE EXCEPTION 'Receipt ma nieprawdziwe saldo przesyłki' USING ERRCODE='23514';END IF;idx:=idx+1;END LOOP;
 IF(SELECT count(*) FROM payment_import_allocation_witnesses WHERE tenant_id=t AND execution_id=a.id)<>idx THEN RAISE EXCEPTION 'Nadmiar wpłat podziału' USING ERRCODE='23514';END IF;
 INSERT INTO payment_import_allocation_executions(id,tenant_id,preview_id,source_id,source_version,actor_id,api_key_id,client_key,request_hash,scope_hash,payload) VALUES(a.id,t,p.id,a.source_id,(p.payload->'source'->>'source_version')::integer+1,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',p.scope_hash,jsonb_build_object('request',v->'request','source',p.payload->'source','summary',p.payload->'summary','allocations',v->'allocations','profile_state',p.payload->'profile_state')) RETURNING * INTO e;
 FOR rowval IN SELECT value FROM jsonb_array_elements(v->'allocations') LOOP INSERT INTO payment_import_allocation_rows(tenant_id,execution_id,index,order_id,shipment_id,entry_id,payload) VALUES(t,e.id,(rowval->>'index')::integer,(rowval->>'order_id')::uuid,(rowval->>'shipment_id')::uuid,(rowval->>'entry_id')::uuid,rowval);END LOOP;
 PERFORM payment_allocation_budget(t);RETURN to_jsonb(e);END$$;

CREATE OR REPLACE FUNCTION payment_allocation_execution_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE a payment_import_allocation_admissions%ROWTYPE;p payment_import_allocation_previews%ROWTYPE;rowval jsonb;pay payment_entries%ROWTYPE;idx integer:=0;actual jsonb;BEGIN
 SELECT * INTO a FROM payment_import_allocation_admissions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id) AND top_xid=pg_current_xact_id() AND transaction_started_at=transaction_timestamp();SELECT * INTO p FROM payment_import_allocation_previews WHERE(tenant_id,id)=(a.tenant_id,a.preview_id);
 IF a.id IS NULL OR(NEW.preview_id,NEW.source_id,NEW.actor_id,NEW.api_key_id,NEW.source_version,NEW.top_xid,NEW.transaction_started_at) IS DISTINCT FROM(a.preview_id,a.source_id,a.actor_id,a.api_key_id,(p.payload->'source'->>'source_version')::integer+1,pg_current_xact_id(),transaction_timestamp())
 OR NEW.request_hash<>payment_allocation_request_hash('execute',p.id,NEW.payload->'request',NEW.actor_id,NEW.api_key_id) OR NEW.scope_hash<>p.scope_hash OR(NEW.payload-ARRAY['request','allocations']) IS DISTINCT FROM(p.payload-'request'-'allocations') OR NEW.payload->'request' IS DISTINCT FROM jsonb_build_object('client_key',NEW.client_key,'version',1,'scope_hash',p.scope_hash,'confirmed',true,'local_ledger_only',true)
 OR jsonb_array_length(NEW.payload->'allocations')<>jsonb_array_length(p.payload->'allocations') THEN RAISE EXCEPTION 'Niepełny receipt podziału' USING ERRCODE='23514';END IF;
 FOR rowval IN SELECT value FROM jsonb_array_elements(NEW.payload->'allocations') LOOP
 IF rowval-ARRAY['entry_id','before_balance','after_balance','after_shipment_sums'] IS DISTINCT FROM p.payload->'allocations'->idx OR rowval->'before_balance' IS DISTINCT FROM p.payload->'allocations'->idx->'before'->'balance' THEN RAISE EXCEPTION 'Receipt zmienia zatwierdzony przydział' USING ERRCODE='23514';END IF;
 SELECT pe.* INTO pay FROM payment_entries pe JOIN payment_import_allocation_witnesses w ON(w.tenant_id,w.entry_id)=(pe.tenant_id,pe.id) WHERE(w.tenant_id,w.execution_id,w.index)=(NEW.tenant_id,NEW.id,idx) AND w.top_xid=pg_current_xact_id() AND w.transaction_started_at=transaction_timestamp() AND pe.id=(rowval->>'entry_id')::uuid;
 IF pay.id IS NULL THEN RAISE EXCEPTION 'Receipt nie ma rzeczywistego salda i wpłaty' USING ERRCODE='23514';END IF;
 actual:=payment_allocation_snapshot(pay.order_id,pay.shipment_id);
 IF rowval->'after_balance' IS DISTINCT FROM actual->'balance' THEN RAISE EXCEPTION 'Receipt nie ma rzeczywistego salda i wpłaty' USING ERRCODE='23514';END IF;
 IF rowval->'after_shipment_sums' IS DISTINCT FROM actual->'shipment_sums' THEN RAISE EXCEPTION 'Receipt ma nieprawdziwe saldo przesyłki' USING ERRCODE='23514';END IF;idx:=idx+1;END LOOP;
 IF(SELECT count(*) FROM payment_import_allocation_witnesses WHERE tenant_id=NEW.tenant_id AND execution_id=NEW.id)<>idx THEN RAISE EXCEPTION 'Nadmiar wpłat podziału' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
