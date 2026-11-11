-- One economic claim is shared with 077. Historical entries/receipts remain untouched.
CREATE TABLE payment_import_allocation_sources (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,namespace_id uuid NOT NULL,economic_key text NOT NULL,payload_hash text NOT NULL,
 source_preview_id uuid NOT NULL,source_row_id uuid NOT NULL,basis jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,namespace_id,economic_key),
 FOREIGN KEY(tenant_id,namespace_id) REFERENCES payment_import_namespaces(tenant_id,id),
 FOREIGN KEY(tenant_id,source_preview_id,source_row_id) REFERENCES payment_import_rows(tenant_id,preview_id,row_id)
);
CREATE TABLE payment_import_allocation_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,
 request_hash text NOT NULL,scope_hash text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),CHECK(request_hash~'^[a-f0-9]{64}$' AND scope_hash~'^[a-f0-9]{64}$')
);
CREATE TABLE payment_import_allocation_executions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,preview_id uuid NOT NULL,source_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,scope_hash text NOT NULL,
 payload jsonb NOT NULL,top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,preview_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,source_id,source_version),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES payment_import_allocation_previews(tenant_id,id),FOREIGN KEY(tenant_id,source_id) REFERENCES payment_import_allocation_sources(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),CHECK(request_hash~'^[a-f0-9]{64}$' AND scope_hash~'^[a-f0-9]{64}$')
);
CREATE TABLE payment_import_allocation_rows (
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 99),order_id uuid NOT NULL,entry_id uuid NOT NULL,shipment_id uuid,payload jsonb NOT NULL,
 PRIMARY KEY(tenant_id,execution_id,index),UNIQUE(tenant_id,entry_id),FOREIGN KEY(tenant_id,execution_id) REFERENCES payment_import_allocation_executions(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,entry_id) REFERENCES payment_entries(tenant_id,order_id,id),FOREIGN KEY(tenant_id,order_id,shipment_id) REFERENCES shipments(tenant_id,order_id,id)
);
CREATE TABLE payment_import_allocation_admissions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,preview_id uuid NOT NULL,source_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,preview_id) REFERENCES payment_import_allocation_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,id) REFERENCES payment_import_allocation_executions(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,source_id) REFERENCES payment_import_allocation_sources(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE payment_import_allocation_witnesses (
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,index integer NOT NULL,entry_id uuid NOT NULL,top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(tenant_id,execution_id,index),UNIQUE(tenant_id,entry_id),FOREIGN KEY(tenant_id,execution_id) REFERENCES payment_import_allocation_executions(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE payment_import_claims ADD COLUMN allocation_source_id uuid;
ALTER TABLE payment_import_claims ALTER COLUMN execution_id DROP NOT NULL;
ALTER TABLE payment_import_claims ALTER COLUMN row_id DROP NOT NULL;
ALTER TABLE payment_import_claims ADD CHECK((allocation_source_id IS NULL AND execution_id IS NOT NULL AND row_id IS NOT NULL) OR(allocation_source_id IS NOT NULL AND execution_id IS NULL AND row_id IS NULL AND state='applied'));
ALTER TABLE payment_import_claims ADD FOREIGN KEY(tenant_id,allocation_source_id) REFERENCES payment_import_allocation_sources(tenant_id,id);
CREATE INDEX payment_allocation_preview_history ON payment_import_allocation_previews(tenant_id,created_at DESC,id DESC);
CREATE INDEX payment_allocation_execution_history ON payment_import_allocation_executions(tenant_id,created_at DESC,id DESC);
CREATE INDEX payment_allocation_current_tx ON payment_import_allocation_executions(tenant_id,top_xid,transaction_started_at);
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['payment_import_allocation_sources','payment_import_allocation_previews','payment_import_allocation_executions','payment_import_allocation_rows','payment_import_allocation_admissions','payment_import_allocation_witnesses'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY owner ON %I TO CURRENT_USER USING(true) WITH CHECK(true)',tab);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',tab);
 IF tab NOT IN('payment_import_allocation_admissions','payment_import_allocation_witnesses') THEN EXECUTE format('GRANT SELECT ON %I TO dyna_app',tab);END IF;
 END LOOP;
END$$;
CREATE FUNCTION payment_allocation_frame(body jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;src jsonb;rowval jsonb;snap jsonb;rows_json jsonb:='[]';projected jsonb:='[]';afterbal jsonb;aftership jsonb;delta bigint;owners uuid[];originals uuid[];ships uuid[];idx integer:=0;amt bigint:=0;fees bigint:=0;pr payment_import_profiles%ROWTYPE;ns payment_import_namespaces%ROWTYPE;p payment_import_previews%ROWTYPE;grp record;BEGIN
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
 FOR rowval IN SELECT value FROM jsonb_array_elements(rows_json) LOOP
 afterbal:=rowval->'before'->'balance';aftership:=rowval->'before'->'shipment_sums';
 IF src->>'ledger_kind' IN('receipt','courier_collection') THEN
 SELECT coalesce(sum((rr->>'amount_minor')::bigint),0) INTO delta FROM jsonb_array_elements(rows_json) rr WHERE rr->'before'->'owner'->>'id'=rowval->'before'->'owner'->>'id';
 afterbal:=afterbal||jsonb_build_object('received',((afterbal->>'received')::bigint+delta)::text,'amount_due',greatest((afterbal->>'amount_due')::bigint-delta,0)::text);END IF;
 IF src->>'ledger_kind'='courier_collection' THEN aftership:=aftership||jsonb_build_object('collected',((aftership->>'collected')::bigint+(rowval->>'amount_minor')::bigint)::text);END IF;
 IF src->>'ledger_kind'='courier_remittance' THEN aftership:=aftership||jsonb_build_object('settled',((aftership->>'settled')::bigint+(rowval->>'amount_minor')::bigint+(rowval->>'fee_minor')::bigint)::text);END IF;
 projected:=projected||jsonb_build_array(rowval||jsonb_build_object('after',jsonb_build_object('balance',afterbal,'shipment_sums',aftership)));END LOOP;rows_json:=projected;
 PERFORM payment_allocation_require(pr.approved_by,NULL,false);PERFORM payment_allocation_require(uid,kid,false);
 RETURN jsonb_build_object('request',body,'source',src,'allocations',rows_json,'summary',jsonb_build_object('count',idx,'amount_minor',amt,'fee_minor',fees,'unallocated_minor',(body->>'unallocated_minor')::bigint,'unallocated_fee_minor',(body->>'unallocated_fee_minor')::bigint,'currency',src->>'currency'),'profile_state',jsonb_build_object('profile_id',pr.id,'profile_version',pr.version,'approved_by',pr.approved_by,'namespace_id',ns.id,'namespace_version',ns.version));
END$$;
CREATE FUNCTION payment_allocation_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$BEGIN RAISE EXCEPTION 'Dowód podziału wpłaty jest niezmienny' USING ERRCODE='23514';END$$;
CREATE FUNCTION payment_allocation_budget(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE n bigint;BEGIN
 PERFORM payment_allocation_locks();IF(SELECT count(*) FROM payment_import_allocation_previews WHERE tenant_id=t)>2000 OR(SELECT count(*) FROM payment_import_allocation_executions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit historii podziału wpłat' USING ERRCODE='P0001';END IF;
 SELECT coalesce(sum(b),0) INTO n FROM(SELECT octet_length(to_jsonb(p)::text) b FROM payment_import_allocation_previews p WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(e)::text) FROM payment_import_allocation_executions e WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(s)::text) FROM payment_import_allocation_sources s WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(r)::text) FROM payment_import_allocation_rows r WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(a)::text) FROM payment_import_allocation_admissions a WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(w)::text) FROM payment_import_allocation_witnesses w WHERE tenant_id=t) counts;
 IF n>134217728 THEN RAISE EXCEPTION 'Limit bajtów historii podziału wpłat' USING ERRCODE='P0001';END IF;END$$;
CREATE FUNCTION payment_allocation_store_preview(v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;f jsonb;p payment_import_allocation_previews%ROWTYPE;BEGIN
 f:=payment_allocation_frame(v->'request',uid,kid);IF v->'frame' IS DISTINCT FROM f OR octet_length(v::text)>8388608 THEN RAISE EXCEPTION 'Niepoprawny pełny podgląd podziału' USING ERRCODE='23514';END IF;
 INSERT INTO payment_import_allocation_previews(id,tenant_id,actor_id,api_key_id,client_key,request_hash,scope_hash,payload) VALUES((v->>'id')::uuid,t,uid,kid,(v->'request'->>'client_key')::uuid,v->>'request_hash',payment_allocation_hash(f),f) RETURNING * INTO p;
 PERFORM payment_allocation_budget(t);RETURN to_jsonb(p);END$$;
CREATE FUNCTION payment_allocation_prepare(pid uuid,eid uuid,uid uuid,kid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p payment_import_allocation_previews%ROWTYPE;f jsonb;sid uuid;BEGIN
 PERFORM payment_allocation_require(uid,kid,false);PERFORM payment_allocation_locks();SELECT * INTO p FROM payment_import_allocation_previews WHERE(tenant_id,id)=(t,pid);
 IF p.id IS NULL OR(p.actor_id,p.api_key_id) IS DISTINCT FROM(uid,kid) OR p.expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM payment_import_allocation_executions WHERE tenant_id=t AND preview_id=pid) THEN RAISE EXCEPTION 'Podgląd podziału nie jest dostępny' USING ERRCODE='23514';END IF;
 f:=payment_allocation_frame(p.payload->'request',uid,kid);IF f IS DISTINCT FROM p.payload OR payment_allocation_hash(f)<>p.scope_hash THEN RAISE EXCEPTION 'Zmienił się zatwierdzony zakres podziału' USING ERRCODE='23514';END IF;
 sid:=(f->'source'->>'source_id')::uuid;IF sid IS NULL THEN sid:=gen_random_uuid();END IF;
 INSERT INTO payment_import_allocation_admissions(tenant_id,id,preview_id,source_id,actor_id,api_key_id) VALUES(t,eid,pid,sid,uid,kid);
 IF f->'source'->>'source_id' IS NULL THEN
 INSERT INTO payment_import_allocation_sources(id,tenant_id,namespace_id,economic_key,payload_hash,source_preview_id,source_row_id,basis) VALUES(sid,t,(f->'source'->>'namespace_id')::uuid,f->'source'->>'economic_key',f->'source'->>'payload_hash',(f->'source'->>'source_preview_id')::uuid,(f->'source'->>'source_row_id')::uuid,jsonb_build_object('normalized',f->'source'->'normalized'));
 INSERT INTO payment_import_claims(tenant_id,namespace_id,economic_key,payload_hash,execution_id,row_id,state,allocation_source_id) VALUES(t,(f->'source'->>'namespace_id')::uuid,f->'source'->>'economic_key',f->'source'->>'payload_hash',NULL,NULL,'applied',sid);END IF;
END$$;
-- Preserve the OID and every legacy branch: old triggers continue calling this function.
CREATE OR REPLACE FUNCTION payment_import_claim_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_OP='DELETE' THEN
 IF OLD.allocation_source_id IS NOT NULL THEN RAISE EXCEPTION 'Claim podziału jest niezmienny' USING ERRCODE='23514';END IF;
 IF OLD.state<>'reserved' OR EXISTS(SELECT 1 FROM payment_import_receipts r WHERE r.tenant_id=OLD.tenant_id AND r.execution_id=OLD.execution_id) OR NOT EXISTS(SELECT 1 FROM payment_import_executions e WHERE e.tenant_id=OLD.tenant_id AND e.id=OLD.execution_id AND e.state IN('failed','conflict','cancelled')) THEN RAISE EXCEPTION 'Cannot release a durable or active claim';END IF;RETURN OLD;END IF;
 IF NEW.allocation_source_id IS NOT NULL OR(TG_OP='UPDATE' AND OLD.allocation_source_id IS NOT NULL) THEN
 IF TG_OP<>'INSERT' OR NEW.state<>'applied' OR NOT EXISTS(SELECT 1 FROM payment_import_allocation_sources s JOIN payment_import_allocation_admissions a ON(a.tenant_id,a.source_id)=(s.tenant_id,s.id) WHERE(s.tenant_id,s.id,s.namespace_id,s.economic_key,s.payload_hash)=(NEW.tenant_id,NEW.allocation_source_id,NEW.namespace_id,NEW.economic_key,NEW.payload_hash) AND a.top_xid=pg_current_xact_id() AND a.transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Niepoprawny wspólny claim podziału' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 IF TG_OP='INSERT' THEN IF NEW.state<>'reserved' OR NOT EXISTS(SELECT 1 FROM payment_import_execution_rows x JOIN payment_import_rows r ON(r.tenant_id,r.preview_id,r.row_id)=(x.tenant_id,x.preview_id,x.row_id) JOIN payment_import_previews p ON(p.tenant_id,p.id)=(r.tenant_id,r.preview_id) JOIN payment_import_executions e ON(e.tenant_id,e.id)=(x.tenant_id,x.execution_id) WHERE x.tenant_id=NEW.tenant_id AND x.execution_id=NEW.execution_id AND x.row_id=NEW.row_id AND p.namespace_id=NEW.namespace_id AND r.economic_key=NEW.economic_key AND r.payload_hash=NEW.payload_hash AND e.state='queued') THEN RAISE EXCEPTION 'Claim must match an approved execution row';END IF;RETURN NEW;END IF;
 IF OLD.state<>'reserved' OR NEW.state<>'applied' OR(to_jsonb(NEW)-'state') IS DISTINCT FROM(to_jsonb(OLD)-'state') OR NOT EXISTS(SELECT 1 FROM payment_import_receipts r WHERE r.tenant_id=NEW.tenant_id AND r.execution_id=NEW.execution_id AND r.row_id=NEW.row_id) THEN RAISE EXCEPTION 'Claim can only become applied with its receipt';END IF;RETURN NEW;END$$;
CREATE FUNCTION payment_allocation_admission_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE p payment_import_allocation_previews%ROWTYPE;f jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Admission podziału jest niezmienny' USING ERRCODE='23514';END IF;
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR NEW.top_xid<>pg_current_xact_id() OR NEW.transaction_started_at<>transaction_timestamp() THEN RAISE EXCEPTION 'Niepoprawny kontekst admission podziału' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM payment_import_allocation_previews WHERE(tenant_id,id)=(NEW.tenant_id,NEW.preview_id);IF p.id IS NULL OR(p.actor_id,p.api_key_id) IS DISTINCT FROM(NEW.actor_id,NEW.api_key_id) OR p.expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM payment_import_allocation_executions WHERE tenant_id=NEW.tenant_id AND preview_id=p.id) THEN RAISE EXCEPTION 'Podgląd podziału nie jest dostępny' USING ERRCODE='23514';END IF;
 f:=payment_allocation_frame(p.payload->'request',NEW.actor_id,NEW.api_key_id);IF f IS DISTINCT FROM p.payload OR payment_allocation_hash(f)<>p.scope_hash OR(f->'source'->>'source_id' IS NOT NULL AND(f->'source'->>'source_id')::uuid<>NEW.source_id) THEN RAISE EXCEPTION 'Zmienił się zatwierdzony zakres podziału' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER payment_allocation_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_import_allocation_admissions FOR EACH ROW EXECUTE FUNCTION payment_allocation_admission_guard();
CREATE FUNCTION payment_allocation_source_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE p payment_import_allocation_previews%ROWTYPE;BEGIN
 SELECT pr.* INTO p FROM payment_import_allocation_admissions a JOIN payment_import_allocation_previews pr ON(pr.tenant_id,pr.id)=(a.tenant_id,a.preview_id) WHERE(a.tenant_id,a.source_id)=(NEW.tenant_id,NEW.id) AND a.top_xid=pg_current_xact_id() AND a.transaction_started_at=transaction_timestamp();
 IF p.id IS NULL OR(NEW.namespace_id,NEW.economic_key,NEW.payload_hash,NEW.source_preview_id,NEW.source_row_id) IS DISTINCT FROM((p.payload->'source'->>'namespace_id')::uuid,p.payload->'source'->>'economic_key',p.payload->'source'->>'payload_hash',(p.payload->'source'->>'source_preview_id')::uuid,(p.payload->'source'->>'source_row_id')::uuid) OR NEW.basis IS DISTINCT FROM jsonb_build_object('normalized',p.payload->'source'->'normalized') THEN RAISE EXCEPTION 'Źródło wymaga prawdziwego admission' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER payment_allocation_source_guard BEFORE INSERT ON payment_import_allocation_sources FOR EACH ROW EXECUTE FUNCTION payment_allocation_source_guard();
CREATE FUNCTION payment_allocation_payment_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a payment_import_allocation_admissions%ROWTYPE;p payment_import_allocation_previews%ROWTYPE;idx integer;rowval jsonb;n jsonb;expected jsonb;BEGIN
 IF NEW.client_key NOT LIKE 'payment-allocation:%' THEN RETURN NEW;END IF;
 SELECT * INTO a FROM payment_import_allocation_admissions WHERE tenant_id=NEW.tenant_id AND id=split_part(NEW.client_key,':',2)::uuid AND top_xid=pg_current_xact_id() AND transaction_started_at=transaction_timestamp();
 SELECT * INTO p FROM payment_import_allocation_previews WHERE(tenant_id,id)=(a.tenant_id,a.preview_id);idx:=split_part(NEW.client_key,':',3)::integer;rowval:=p.payload->'allocations'->idx;n:=p.payload->'source'->'normalized';
 expected:=jsonb_build_object('kind',n->>'ledger_kind','amount',(rowval->>'amount_minor')::integer,'fee',(rowval->>'fee_minor')::integer,'currency',n->>'currency','method',n->>'method','reference',left('CSV '||(n->>'transaction_id'),200),'note',p.payload->'request'->>'reason');
 IF rowval->>'shipment_id' IS NOT NULL THEN expected:=expected||jsonb_build_object('shipment_id',rowval->>'shipment_id');END IF;
 IF a.id IS NULL OR rowval IS NULL OR idx NOT BETWEEN 0 AND 99 OR NEW.client_key IS DISTINCT FROM 'payment-allocation:'||a.id::text||':'||idx::text
 OR(NEW.order_id,NEW.kind,NEW.amount,NEW.fee,NEW.currency,NEW.method,NEW.shipment_id,NEW.actor_id) IS DISTINCT FROM((rowval->>'order_id')::uuid,n->>'ledger_kind',(rowval->>'amount_minor')::integer,(rowval->>'fee_minor')::integer,n->>'currency',n->>'method',(rowval->>'shipment_id')::uuid,a.actor_id)
 OR NEW.return_id IS NOT NULL OR NEW.reversal_of IS NOT NULL OR NEW.request IS DISTINCT FROM jsonb_build_object('entry',expected,'context',jsonb_build_object('effects','local_financial_only','provenance',jsonb_build_object('execution_id',a.id,'row_id',(p.payload->'source'->>'source_row_id')::uuid,'preview_id',p.id)),'request',jsonb_build_object('scope_hash',p.scope_hash,'economic_key',p.payload->'source'->>'economic_key'))
 THEN RAISE EXCEPTION 'Wpłata nie odpowiada zatwierdzonemu przydziałowi' USING ERRCODE='23514';END IF;
 PERFORM payment_allocation_require(a.actor_id,a.api_key_id,false);RETURN NEW;END$$;
CREATE TRIGGER payment_allocation_payment_guard BEFORE INSERT ON payment_entries FOR EACH ROW EXECUTE FUNCTION payment_allocation_payment_guard();
CREATE FUNCTION payment_allocation_witness() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF NEW.client_key LIKE 'payment-allocation:%' THEN INSERT INTO payment_import_allocation_witnesses(tenant_id,execution_id,index,entry_id) VALUES(NEW.tenant_id,split_part(NEW.client_key,':',2)::uuid,split_part(NEW.client_key,':',3)::integer,NEW.id);END IF;RETURN NEW;END$$;
CREATE TRIGGER payment_allocation_witness AFTER INSERT ON payment_entries FOR EACH ROW EXECUTE FUNCTION payment_allocation_witness();
CREATE FUNCTION payment_allocation_witness_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$BEGIN
 IF pg_trigger_depth()<2 OR NEW.top_xid<>pg_current_xact_id() OR NEW.transaction_started_at<>transaction_timestamp() THEN RAISE EXCEPTION 'Witness wymaga rzeczywistej wpłaty' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER payment_allocation_witness_guard BEFORE INSERT ON payment_import_allocation_witnesses FOR EACH ROW EXECUTE FUNCTION payment_allocation_witness_guard();
CREATE FUNCTION payment_allocation_store_execution(v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p payment_import_allocation_previews%ROWTYPE;a payment_import_allocation_admissions%ROWTYPE;e payment_import_allocation_executions%ROWTYPE;rowval jsonb;approved jsonb;pay payment_entries%ROWTYPE;idx integer:=0;actual jsonb;BEGIN
 PERFORM payment_allocation_require(uid,kid,false);SELECT * INTO a FROM payment_import_allocation_admissions WHERE(tenant_id,id)=(t,(v->>'id')::uuid) AND top_xid=pg_current_xact_id() AND transaction_started_at=transaction_timestamp();SELECT * INTO p FROM payment_import_allocation_previews WHERE(tenant_id,id)=(t,a.preview_id);
 IF a.id IS NULL OR(a.actor_id,a.api_key_id) IS DISTINCT FROM(uid,kid) OR v->>'scope_hash' IS DISTINCT FROM p.scope_hash OR(v->>'preview_id')::uuid IS DISTINCT FROM p.id OR jsonb_typeof(v->'allocations')<>'array' OR jsonb_array_length(v->'allocations')<>jsonb_array_length(p.payload->'allocations') OR v->'request' IS DISTINCT FROM jsonb_build_object('client_key',v->>'client_key','version',1,'scope_hash',p.scope_hash,'confirmed',true,'local_ledger_only',true) THEN RAISE EXCEPTION 'Niepełny receipt podziału' USING ERRCODE='23514';END IF;
 FOR rowval IN SELECT value FROM jsonb_array_elements(v->'allocations') LOOP
 approved:=p.payload->'allocations'->idx;
 IF(rowval-ARRAY['entry_id','before_balance','after_balance']) IS DISTINCT FROM approved OR(rowval->>'index')::integer<>idx OR rowval->'before_balance' IS DISTINCT FROM approved->'before'->'balance' THEN RAISE EXCEPTION 'Receipt zmienia zatwierdzony przydział' USING ERRCODE='23514';END IF;
 SELECT pe.* INTO pay FROM payment_entries pe JOIN payment_import_allocation_witnesses w ON(w.tenant_id,w.entry_id)=(pe.tenant_id,pe.id) WHERE(w.tenant_id,w.execution_id,w.index)=(t,a.id,idx) AND w.top_xid=pg_current_xact_id() AND w.transaction_started_at=transaction_timestamp() AND pe.id=(rowval->>'entry_id')::uuid;
 IF pay.id IS NULL OR(pay.order_id,pay.shipment_id,pay.amount,pay.fee,pay.kind,pay.currency) IS DISTINCT FROM((approved->>'order_id')::uuid,(approved->>'shipment_id')::uuid,(approved->>'amount_minor')::integer,(approved->>'fee_minor')::integer,p.payload->'source'->>'ledger_kind',p.payload->'source'->>'currency') THEN RAISE EXCEPTION 'Receipt nie ma dokładnej wpłaty' USING ERRCODE='23514';END IF;
 actual:=payment_allocation_snapshot((approved->>'order_id')::uuid,(approved->>'shipment_id')::uuid);
 IF rowval->'after_balance' IS DISTINCT FROM actual->'balance' THEN RAISE EXCEPTION 'Receipt ma nieprawdziwe saldo końcowe' USING ERRCODE='23514';END IF;idx:=idx+1;END LOOP;
 IF(SELECT count(*) FROM payment_import_allocation_witnesses WHERE tenant_id=t AND execution_id=a.id)<>idx THEN RAISE EXCEPTION 'Nadmiar wpłat podziału' USING ERRCODE='23514';END IF;
 INSERT INTO payment_import_allocation_executions(id,tenant_id,preview_id,source_id,source_version,actor_id,api_key_id,client_key,request_hash,scope_hash,payload) VALUES(a.id,t,p.id,a.source_id,(p.payload->'source'->>'source_version')::integer+1,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',p.scope_hash,jsonb_build_object('request',v->'request','source',p.payload->'source','summary',p.payload->'summary','allocations',v->'allocations','profile_state',p.payload->'profile_state')) RETURNING * INTO e;
 FOR rowval IN SELECT value FROM jsonb_array_elements(v->'allocations') LOOP INSERT INTO payment_import_allocation_rows(tenant_id,execution_id,index,order_id,shipment_id,entry_id,payload) VALUES(t,e.id,(rowval->>'index')::integer,(rowval->>'order_id')::uuid,(rowval->>'shipment_id')::uuid,(rowval->>'entry_id')::uuid,rowval);END LOOP;
 PERFORM payment_allocation_budget(t);RETURN to_jsonb(e);END$$;
CREATE FUNCTION payment_allocation_installed() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT EXISTS(SELECT 1 FROM migrations WHERE name='124_payment_import_allocations') $$;
CREATE FUNCTION payment_allocation_access(uid uuid,kid uuid,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r text;k api_keys%ROWTYPE;valid boolean:=true;ok boolean;BEGIN
 IF pin THEN SELECT role INTO r FROM memberships WHERE tenant_id=t AND user_id=uid FOR SHARE;ELSE SELECT role INTO r FROM memberships WHERE tenant_id=t AND user_id=uid;END IF;
 ok:=r IS NOT DISTINCT FROM 'admin';IF kid IS NOT NULL THEN
 IF pin THEN SELECT * INTO k FROM api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid) FOR SHARE;ELSE SELECT * INTO k FROM api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid);END IF;
 valid:=k.id IS NOT NULL AND k.revoked_at IS NULL AND(k.expires_at IS NULL OR k.expires_at>clock_timestamp());ok:=ok AND valid AND coalesce(k.scopes @> ARRAY['orders:read','orders:write']::text[],false);END IF;
 RETURN jsonb_build_object('role',r,'key_valid',valid,'allowed',coalesce(ok,false));END$$;
CREATE FUNCTION payment_allocation_require(uid uuid,kid uuid,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE g jsonb;BEGIN
 g:=payment_allocation_access(uid,kid,pin);IF g->>'key_valid' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Klucz podziału wpłaty jest wycofany lub wygasł' USING ERRCODE='23514';END IF;IF g->>'allowed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Brak aktualnej zgody na podział wpłaty' USING ERRCODE='23514';END IF;END$$;
CREATE FUNCTION payment_allocation_locks() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE t text:=current_setting('app.tenant_id',true);BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('payment.import.admission:'||t,0));PERFORM pg_advisory_xact_lock(hashtextextended('order.merge.proof:'||t,0));END$$;
CREATE FUNCTION payment_allocation_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$ SELECT encode(sha256(convert_to(v::text,'UTF8')),'hex') $$;
CREATE FUNCTION payment_allocation_source(pid uuid,rid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p payment_import_previews%ROWTYPE;r payment_import_rows%ROWTYPE;n jsonb;s payment_import_allocation_sources%ROWTYPE;e payment_import_allocation_executions%ROWTYPE;c payment_import_claims%ROWTYPE;amount bigint;fee bigint;BEGIN
 SELECT * INTO p FROM payment_import_previews WHERE(tenant_id,id)=(t,pid);SELECT * INTO r FROM payment_import_rows WHERE(tenant_id,preview_id,row_id)=(t,pid,rid);n:=r.source->'normalized';
 IF p.id IS NULL OR r.row_id IS NULL OR p.kind<>'import' OR r.operation<>'apply' OR n IS NULL OR n='null' OR r.economic_key IS NULL
 OR r.source->'raw'->>'status'='invalid' OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(r.source->'raw'->'issues','[]')) issue WHERE issue->>'code' NOT IN('missing_tracking_number','missing_reference','ambiguous_reference'))
 OR n->>'ledger_kind' NOT IN('receipt','courier_collection','courier_remittance') OR n->>'currency' NOT IN('PLN','EUR','USD','GBP','CZK') OR coalesce(n->>'transaction_id','')='' THEN RAISE EXCEPTION 'Źródło nie ma poprawnych danych finansowych' USING ERRCODE='23514';END IF;
 amount:=(n->>'amount_minor')::bigint;fee:=(n->>'fee_minor')::bigint;
 IF coalesce(n->>'amount_minor','')!~'^[0-9]+$' OR coalesce(n->>'fee_minor','')!~'^[0-9]+$' OR coalesce(n->>'gross_minor','')!~'^[0-9]+$' OR coalesce(n->>'ledger_amount','')!~'^[0-9]+$' OR coalesce(n->>'ledger_fee','')!~'^[0-9]+$'
 OR amount NOT BETWEEN 0 AND 2147483647 OR fee NOT BETWEEN 0 AND 2147483647 OR amount+fee<=0 OR amount+fee IS DISTINCT FROM(n->>'gross_minor')::bigint OR amount IS DISTINCT FROM(n->>'ledger_amount')::bigint OR fee IS DISTINCT FROM(n->>'ledger_fee')::bigint OR(n->>'ledger_kind'<>'courier_remittance' AND fee<>0)
 OR n->>'ledger_kind' IS DISTINCT FROM (CASE p.profile->>'mode' WHEN 'bank_receipt' THEN 'receipt' WHEN 'cod_collection' THEN 'courier_collection' WHEN 'cod_remittance' THEN 'courier_remittance' ELSE NULL END)
 OR n->>'method' IS DISTINCT FROM (CASE WHEN p.profile->>'mode'='bank_receipt' THEN 'bank_csv' WHEN p.profile->>'source_kind'='carrier_report' THEN 'courier_csv' ELSE 'bank_csv_cod' END)
 THEN RAISE EXCEPTION 'Źródło nie ma poprawnych danych finansowych' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM payment_import_claims WHERE(tenant_id,namespace_id,economic_key)=(t,p.namespace_id,r.economic_key);
 IF c.economic_key IS NOT NULL AND c.allocation_source_id IS NULL THEN RAISE EXCEPTION 'Transakcja źródłowa jest już zajęta' USING ERRCODE='23514';END IF;
 SELECT * INTO s FROM payment_import_allocation_sources WHERE(tenant_id,namespace_id,economic_key)=(t,p.namespace_id,r.economic_key);
 IF s.id IS NOT NULL THEN
 IF s.basis->'normalized'-ARRAY['reference','match_identifiers','tracking_number'] IS DISTINCT FROM n-ARRAY['reference','match_identifiers','tracking_number'] THEN RAISE EXCEPTION 'Zmieniły się pieniężne dane źródła' USING ERRCODE='23514';END IF;
 SELECT * INTO e FROM payment_import_allocation_executions WHERE tenant_id=t AND source_id=s.id ORDER BY source_version DESC LIMIT 1;
 IF e.id IS NULL OR c.allocation_source_id IS DISTINCT FROM s.id THEN RAISE EXCEPTION 'Niepełny wspólny claim źródła' USING ERRCODE='23514';END IF;
 amount:=(e.payload->'summary'->>'unallocated_minor')::bigint;fee:=(e.payload->'summary'->>'unallocated_fee_minor')::bigint;END IF;
 RETURN jsonb_build_object('source_preview_id',pid,'source_row_id',rid,'source_id',s.id,'namespace_id',p.namespace_id,'economic_key',r.economic_key,'payload_hash',coalesce(r.payload_hash,r.source->'raw'->>'identity_payload_hash',payment_allocation_hash(n)),
 'source_version',coalesce(e.source_version,0),'normalized',n,'transaction_id',n->>'transaction_id','ledger_kind',n->>'ledger_kind','currency',n->>'currency','gross_minor',n->>'gross_minor','fee_minor',n->>'fee_minor',
 'available_minor',(amount+fee)::text,'remaining_minor',(amount+fee)::text,'remaining_amount_minor',amount::text,'remaining_fee_minor',fee::text,'can_allocate',amount+fee>0);
END$$;
CREATE FUNCTION payment_allocation_snapshot(oid uuid,sid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;o orders%ROWTYPE;own orders%ROWTYPE;ownerid uuid;ids uuid[];entries jsonb;ret jsonb;checks jsonb;guards jsonb;sh jsonb;coll bigint;settled bigint;received bigint;refund bigint;credit bigint;nominal bigint;BEGIN
 WITH RECURSIVE chain AS(SELECT oid id,ARRAY[oid] path,false cycle UNION ALL SELECT m.target_order_id,chain.path||m.target_order_id,m.target_order_id=ANY(chain.path) FROM chain JOIN order_merge_claims m ON m.tenant_id=t AND m.source_order_id=chain.id WHERE cardinality(chain.path)<=1000 AND NOT chain.cycle) SELECT CASE WHEN cycle OR cardinality(path)>1000 THEN NULL ELSE id END INTO ownerid FROM chain ORDER BY cardinality(path) DESC LIMIT 1;
 IF ownerid IS NULL THEN RAISE EXCEPTION 'Nieprawidłowy łańcuch scalania' USING ERRCODE='23514';END IF;
 SELECT * INTO o FROM orders WHERE(tenant_id,id)=(t,oid);SELECT * INTO own FROM orders WHERE(tenant_id,id)=(t,ownerid);IF o.id IS NULL OR own.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego zamówienia' USING ERRCODE='P0002';END IF;
 WITH RECURSIVE incoming AS(SELECT ownerid id UNION SELECT m.source_order_id FROM incoming JOIN order_merge_claims m ON m.tenant_id=t AND m.target_order_id=incoming.id) SELECT array_agg(id ORDER BY id) INTO ids FROM incoming;
 IF cardinality(ids)>10000 THEN RAISE EXCEPTION 'Zbyt duża historia scalania' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'),coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind) IN('receipt','courier_collection')),0),coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind)='refund'),0)
 INTO entries,received,refund FROM payment_entries p LEFT JOIN payment_entries r ON(r.tenant_id,r.order_id,r.id)=(p.tenant_id,p.order_id,p.reversal_of) WHERE p.tenant_id=t AND p.order_id=ANY(ids);
 SELECT coalesce(jsonb_agg(to_jsonb(rc) ORDER BY rc.id),'[]'),coalesce(sum(refund_amount) FILTER(WHERE state IN('refund_pending','closed')),0) INTO ret,credit FROM return_cases rc WHERE tenant_id=t AND order_id=ANY(ids);
 SELECT coalesce(jsonb_agg(to_jsonb(sc)||jsonb_build_object('order_version',sc.order_version::text) ORDER BY sc.id),'[]') INTO checks FROM source_payment_checks sc WHERE tenant_id=t AND order_id=ANY(ids);
 SELECT coalesce(jsonb_agg(to_jsonb(sp) ORDER BY sp.id),'[]') INTO guards FROM shipping_plans sp WHERE tenant_id=t AND order_id=ANY(ids) AND state NOT IN('cancelled','dispatched') AND phase IN('create_started','numbers_ready','buy_started','refresh_started');
 SELECT to_jsonb(ship) INTO sh FROM shipments ship WHERE(tenant_id,order_id,id)=(t,oid,sid);IF sid IS NOT NULL AND sh IS NULL THEN RAISE EXCEPTION 'Przesyłka nie należy do zamówienia' USING ERRCODE='P0002';END IF;
 SELECT coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind)='courier_collection'),0),coalesce(sum(p.amount::bigint+p.fee) FILTER(WHERE coalesce(r.kind,p.kind)='courier_remittance'),0) INTO coll,settled FROM payment_entries p LEFT JOIN payment_entries r ON(r.tenant_id,r.order_id,r.id)=(p.tenant_id,p.order_id,p.reversal_of) WHERE(p.tenant_id,p.order_id,p.shipment_id)=(t,oid,sid);
 nominal:=CASE WHEN own.status='cancelled' THEN 0 ELSE greatest(own.total::bigint-credit,0) END;
 RETURN jsonb_build_object('order',to_jsonb(o)||jsonb_build_object('version',o.version::text),'owner',to_jsonb(own)||jsonb_build_object('version',own.version::text),'source_ids',ids,
 'balance',jsonb_build_object('amount_due',greatest(nominal-received+refund,0)::text,'received',received::text,'refunded',refund::text,'credit',credit::text,'currency',own.currency),
 'entries',entries,'returns',ret,'source_checks',checks,'shipping_guards',guards,'shipment',sh,'shipment_sums',jsonb_build_object('collected',coll::text,'settled',settled::text),
 'merge_claims',coalesce((SELECT jsonb_agg(to_jsonb(mc) ORDER BY source_order_id) FROM order_merge_claims mc WHERE tenant_id=t AND(source_order_id=ANY(ids) OR target_order_id=ANY(ids))),'[]'));
END$$;
CREATE FUNCTION payment_allocation_canonical(v jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$DECLARE outval text;BEGIN
 IF jsonb_typeof(v)='object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||payment_allocation_canonical(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO outval FROM jsonb_each(v);
 ELSIF jsonb_typeof(v)='array' THEN SELECT '['||coalesce(string_agg(payment_allocation_canonical(value),',' ORDER BY ord),'')||']' INTO outval FROM jsonb_array_elements(v) WITH ORDINALITY vals(value,ord);ELSE outval:=v::text;END IF;RETURN outval;END$$;
CREATE FUNCTION payment_allocation_request_hash(kind text,parent uuid,body jsonb,uid uuid,kid uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(payment_allocation_canonical(jsonb_build_object('tenant_id',nullif(current_setting('app.tenant_id',true),''),'actor_id',uid,'api_key_id',kid,'kind',kind,'parent_id',parent,'request',body)),'UTF8')),'hex') $$;
CREATE FUNCTION payment_allocation_preview_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE f jsonb;BEGIN
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR NEW.client_key IS DISTINCT FROM(NEW.payload->'request'->>'client_key')::uuid OR NEW.request_hash<>payment_allocation_request_hash('preview',NULL,NEW.payload->'request',NEW.actor_id,NEW.api_key_id) THEN RAISE EXCEPTION 'Niepoprawna tożsamość podglądu podziału' USING ERRCODE='23514';END IF;
 f:=payment_allocation_frame(NEW.payload->'request',NEW.actor_id,NEW.api_key_id);IF NEW.payload IS DISTINCT FROM f OR NEW.scope_hash<>payment_allocation_hash(f) OR octet_length(NEW.payload::text)>8388608 THEN RAISE EXCEPTION 'Niepoprawny pełny podgląd podziału' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER payment_allocation_preview_guard BEFORE INSERT ON payment_import_allocation_previews FOR EACH ROW EXECUTE FUNCTION payment_allocation_preview_guard();
CREATE FUNCTION payment_allocation_execution_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE a payment_import_allocation_admissions%ROWTYPE;p payment_import_allocation_previews%ROWTYPE;rowval jsonb;pay payment_entries%ROWTYPE;idx integer:=0;BEGIN
 SELECT * INTO a FROM payment_import_allocation_admissions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id) AND top_xid=pg_current_xact_id() AND transaction_started_at=transaction_timestamp();SELECT * INTO p FROM payment_import_allocation_previews WHERE(tenant_id,id)=(a.tenant_id,a.preview_id);
 IF a.id IS NULL OR(NEW.preview_id,NEW.source_id,NEW.actor_id,NEW.api_key_id,NEW.source_version,NEW.top_xid,NEW.transaction_started_at) IS DISTINCT FROM(a.preview_id,a.source_id,a.actor_id,a.api_key_id,(p.payload->'source'->>'source_version')::integer+1,pg_current_xact_id(),transaction_timestamp())
 OR NEW.request_hash<>payment_allocation_request_hash('execute',p.id,NEW.payload->'request',NEW.actor_id,NEW.api_key_id) OR NEW.scope_hash<>p.scope_hash OR(NEW.payload-ARRAY['request','allocations']) IS DISTINCT FROM(p.payload-'request'-'allocations') OR NEW.payload->'request' IS DISTINCT FROM jsonb_build_object('client_key',NEW.client_key,'version',1,'scope_hash',p.scope_hash,'confirmed',true,'local_ledger_only',true)
 OR jsonb_array_length(NEW.payload->'allocations')<>jsonb_array_length(p.payload->'allocations') THEN RAISE EXCEPTION 'Niepełny receipt podziału' USING ERRCODE='23514';END IF;
 FOR rowval IN SELECT value FROM jsonb_array_elements(NEW.payload->'allocations') LOOP
 IF rowval-ARRAY['entry_id','before_balance','after_balance'] IS DISTINCT FROM p.payload->'allocations'->idx OR rowval->'before_balance' IS DISTINCT FROM p.payload->'allocations'->idx->'before'->'balance' THEN RAISE EXCEPTION 'Receipt zmienia zatwierdzony przydział' USING ERRCODE='23514';END IF;
 SELECT pe.* INTO pay FROM payment_entries pe JOIN payment_import_allocation_witnesses w ON(w.tenant_id,w.entry_id)=(pe.tenant_id,pe.id) WHERE(w.tenant_id,w.execution_id,w.index)=(NEW.tenant_id,NEW.id,idx) AND w.top_xid=pg_current_xact_id() AND w.transaction_started_at=transaction_timestamp() AND pe.id=(rowval->>'entry_id')::uuid;
 IF pay.id IS NULL OR rowval->'after_balance' IS DISTINCT FROM payment_allocation_snapshot(pay.order_id,pay.shipment_id)->'balance' THEN RAISE EXCEPTION 'Receipt nie ma rzeczywistego salda i wpłaty' USING ERRCODE='23514';END IF;idx:=idx+1;END LOOP;
 IF(SELECT count(*) FROM payment_import_allocation_witnesses WHERE tenant_id=NEW.tenant_id AND execution_id=NEW.id)<>idx THEN RAISE EXCEPTION 'Nadmiar wpłat podziału' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER payment_allocation_execution_guard BEFORE INSERT ON payment_import_allocation_executions FOR EACH ROW EXECUTE FUNCTION payment_allocation_execution_guard();
CREATE FUNCTION payment_allocation_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE t uuid:=NEW.tenant_id;eid uuid;e payment_import_allocation_executions%ROWTYPE;p payment_import_allocation_previews%ROWTYPE;a payment_import_allocation_admissions%ROWTYPE;s payment_import_allocation_sources%ROWTYPE;BEGIN
 eid:=CASE WHEN TG_TABLE_NAME='payment_import_allocation_rows' THEN(to_jsonb(NEW)->>'execution_id')::uuid ELSE(to_jsonb(NEW)->>'id')::uuid END;
 SELECT * INTO e FROM payment_import_allocation_executions WHERE(tenant_id,id)=(t,eid);SELECT * INTO a FROM payment_import_allocation_admissions WHERE(tenant_id,id)=(t,eid);SELECT * INTO p FROM payment_import_allocation_previews WHERE(tenant_id,id)=(t,e.preview_id);SELECT * INTO s FROM payment_import_allocation_sources WHERE(tenant_id,id)=(t,e.source_id);
 IF e.id IS NULL OR a.id IS NULL OR s.id IS NULL OR e.top_xid<>pg_current_xact_id() OR e.transaction_started_at<>transaction_timestamp() OR(a.preview_id,a.source_id,a.actor_id,a.api_key_id) IS DISTINCT FROM(e.preview_id,e.source_id,e.actor_id,e.api_key_id)
 OR NOT EXISTS(SELECT 1 FROM payment_import_claims c WHERE(c.tenant_id,c.namespace_id,c.economic_key,c.allocation_source_id,c.state)=(t,s.namespace_id,s.economic_key,s.id,'applied'))
 OR(SELECT count(*) FROM payment_import_allocation_rows WHERE tenant_id=t AND execution_id=eid)<>jsonb_array_length(e.payload->'allocations')
 OR EXISTS(SELECT 1 FROM payment_import_allocation_rows rr WHERE rr.tenant_id=t AND rr.execution_id=eid AND(rr.payload IS DISTINCT FROM e.payload->'allocations'->rr.index OR(rr.payload->>'entry_id')::uuid IS DISTINCT FROM rr.entry_id OR(rr.payload->>'order_id')::uuid IS DISTINCT FROM rr.order_id OR(rr.payload->>'shipment_id')::uuid IS DISTINCT FROM rr.shipment_id)) THEN RAISE EXCEPTION 'Niekompletny graf podziału wpłaty' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME<>'payment_import_allocation_rows' THEN PERFORM payment_allocation_budget(t);END IF;PERFORM payment_allocation_require((p.payload->'profile_state'->>'approved_by')::uuid,NULL,false);PERFORM payment_allocation_require(e.actor_id,e.api_key_id,false);RETURN NEW;END$$;
CREATE FUNCTION payment_allocation_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE oldj jsonb;newj jsonb;oldids uuid[];newids uuid[];proof record;BEGIN
 IF TG_OP<>'INSERT' THEN oldj:=to_jsonb(OLD);END IF;IF TG_OP<>'DELETE' THEN newj:=to_jsonb(NEW);END IF;
 oldids:=CASE WHEN TG_TABLE_NAME='orders' THEN ARRAY[(oldj->>'id')::uuid] WHEN TG_TABLE_NAME='order_merge_claims' THEN ARRAY[(oldj->>'source_order_id')::uuid,(oldj->>'target_order_id')::uuid] ELSE ARRAY[(oldj->>'order_id')::uuid] END;
 newids:=CASE WHEN TG_TABLE_NAME='orders' THEN ARRAY[(newj->>'id')::uuid] WHEN TG_TABLE_NAME='order_merge_claims' THEN ARRAY[(newj->>'source_order_id')::uuid,(newj->>'target_order_id')::uuid] ELSE ARRAY[(newj->>'order_id')::uuid] END;
 IF EXISTS(SELECT 1 FROM payment_import_allocation_executions e CROSS JOIN LATERAL jsonb_array_elements(e.payload->'allocations') ar WHERE e.top_xid=pg_current_xact_id() AND e.transaction_started_at=transaction_timestamp()
 AND((e.tenant_id=(oldj->>'tenant_id')::uuid AND oldids&&ARRAY(SELECT(value#>>'{}')::uuid FROM jsonb_array_elements(ar->'before'->'source_ids')))
 OR(e.tenant_id=(newj->>'tenant_id')::uuid AND newids&&ARRAY(SELECT(value#>>'{}')::uuid FROM jsonb_array_elements(ar->'before'->'source_ids'))))) THEN RAISE EXCEPTION 'Zatwierdzone saldo podziału jest zapieczętowane' USING ERRCODE='23514';END IF;
 FOR proof IN SELECT a.id FROM payment_import_allocation_admissions a JOIN payment_import_allocation_previews p ON(p.tenant_id,p.id)=(a.tenant_id,a.preview_id) CROSS JOIN LATERAL jsonb_array_elements(p.payload->'allocations') ar
 WHERE a.top_xid=pg_current_xact_id() AND a.transaction_started_at=transaction_timestamp() AND((a.tenant_id=(oldj->>'tenant_id')::uuid AND oldids&&ARRAY(SELECT(value#>>'{}')::uuid FROM jsonb_array_elements(ar->'before'->'source_ids'))) OR(a.tenant_id=(newj->>'tenant_id')::uuid AND newids&&ARRAY(SELECT(value#>>'{}')::uuid FROM jsonb_array_elements(ar->'before'->'source_ids')))) LOOP
 IF TG_TABLE_NAME='orders' AND TG_OP='UPDATE' AND(
 ((newj-ARRAY['updated_at','version','workflow_error']) IS NOT DISTINCT FROM(oldj-ARRAY['updated_at','version','workflow_error']))
 OR(oldj->>'status'='new' AND newj->>'status'='paid' AND newj->>'workflow_status_id' IS NULL AND(newj-ARRAY['updated_at','version','status','workflow_status_id','workflow_error']) IS NOT DISTINCT FROM(oldj-ARRAY['updated_at','version','status','workflow_status_id','workflow_error']))) THEN CONTINUE;END IF;
 IF TG_TABLE_NAME='payment_entries' AND TG_OP='INSERT' AND newj->>'client_key' LIKE 'payment-allocation:'||proof.id::text||':%' THEN CONTINUE;END IF;
 RAISE EXCEPTION 'Admission podziału chroni zamrożone fakty finansowe' USING ERRCODE='23514';END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END$$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['payment_import_allocation_sources','payment_import_allocation_previews','payment_import_allocation_executions','payment_import_allocation_rows','payment_import_allocation_witnesses'] LOOP EXECUTE format('CREATE TRIGGER payment_allocation_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION payment_allocation_immutable()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['payment_import_allocation_executions','payment_import_allocation_rows','payment_import_allocation_admissions'] LOOP EXECUTE format('CREATE CONSTRAINT TRIGGER payment_allocation_complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payment_allocation_complete()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['orders','payment_entries','shipments','return_cases','source_payment_checks','shipping_plans','order_merge_claims'] LOOP EXECUTE format('CREATE TRIGGER payment_allocation_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION payment_allocation_seal()',tab);END LOOP;
END$$;
REVOKE ALL ON FUNCTION payment_allocation_installed(),payment_allocation_access(uuid,uuid,boolean),payment_allocation_require(uuid,uuid,boolean),payment_allocation_locks(),payment_allocation_hash(jsonb),payment_allocation_source(uuid,uuid),payment_allocation_snapshot(uuid,uuid),payment_allocation_frame(jsonb,uuid,uuid),payment_allocation_immutable(),payment_allocation_budget(uuid),payment_allocation_store_preview(jsonb,uuid,uuid),payment_allocation_prepare(uuid,uuid,uuid,uuid),payment_allocation_admission_guard(),payment_allocation_source_guard(),payment_allocation_payment_guard(),payment_allocation_witness(),payment_allocation_witness_guard(),payment_allocation_store_execution(jsonb,uuid,uuid),payment_allocation_canonical(jsonb),payment_allocation_request_hash(text,uuid,jsonb,uuid,uuid),payment_allocation_preview_guard(),payment_allocation_execution_guard(),payment_allocation_complete(),payment_allocation_seal() FROM PUBLIC,dyna_app;
GRANT EXECUTE ON FUNCTION payment_allocation_installed(),payment_allocation_access(uuid,uuid,boolean),payment_allocation_source(uuid,uuid),payment_allocation_snapshot(uuid,uuid),payment_allocation_frame(jsonb,uuid,uuid),payment_allocation_store_preview(jsonb,uuid,uuid),payment_allocation_prepare(uuid,uuid,uuid,uuid),payment_allocation_store_execution(jsonb,uuid,uuid) TO dyna_app;
