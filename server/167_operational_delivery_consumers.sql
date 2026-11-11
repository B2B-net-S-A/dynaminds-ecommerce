-- 167 managed operational receiver consumers; no registration/execution by author.
-- Two disjoint own tables. Preserve original156 manifest/fingerprint function,
-- original166 state/evidence/manifest and every historical payload/PDF byte.
-- SQL verifies typed source/ciphertext; semantic GCM decrypt + HTTP identity are
-- trusted managed-service boundaries, not independently certified SQL credentials.
SET LOCAL TimeZone='UTC';
DO $$ BEGIN
 IF to_regclass('public.packed_label_print_manifest') IS NULL OR to_regclass('public.buyer_address_manifest') IS NULL
 OR to_regprocedure('public.packed_label_print_guards()') IS NULL OR to_regprocedure('public.buyer_address_guards()') IS NULL
 THEN RAISE EXCEPTION '167 requires complete156 and166' USING ERRCODE='55000';END IF;
 IF current_user IS DISTINCT FROM session_user
 OR current_user IS DISTINCT FROM(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.packed_label_print_manifest'::regclass)
 OR current_user IS DISTINCT FROM(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.buyer_address_manifest'::regclass)
 THEN RAISE EXCEPTION '167 requires genuine predecessor owner transaction' USING ERRCODE='42501';END IF;
END $$;
CREATE TEMP TABLE operative_delivery_install_basis ON COMMIT DROP AS
 SELECT pg_current_xact_id()::text root_xid,transaction_timestamp() start_at,
 pg_backend_pid() backend_pid,current_user::text owner_name,
 to_jsonb(m) original156_manifest,packed_label_print_fingerprint() original156_fingerprint,
 to_jsonb(b) original166_manifest,NULL::jsonb predecessor_functions
 FROM packed_label_print_manifest m CROSS JOIN buyer_address_manifest b;
REVOKE ALL ON pg_temp.operative_delivery_install_basis FROM PUBLIC,dyna_app;
DO $$ DECLARE expected jsonb:='{"label_print_frame":"d191d4c1280acb4f6c5dec86c23ce72dfce2a5781ad0b0264ed544372454d0c4","order_parcel_source":"5d1ec193a5a147ca758682a3f15ca86c977797717642b833d657397bc4b80fec","packed_label_print_guards":"899a7420b798208ec7350370eb732b98984de00089ec534d7a73f83e1ffcfe0f"}'::jsonb;n text;BEGIN
 IF current_user IS DISTINCT FROM session_user OR NOT EXISTS(SELECT FROM migrations WHERE name='166_buyer_address_sidecar')
 OR NOT buyer_address_guards() OR NOT packed_label_print_guards() OR NOT order_parcel_guards()
 OR (SELECT count(*) FROM pg_temp.operative_delivery_install_basis)<>1
 OR EXISTS(SELECT FROM pg_temp.operative_delivery_install_basis WHERE original156_fingerprint IS DISTINCT FROM original156_manifest->>'fingerprint')
 OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'operative_delivery_'))
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'operative_delivery_'))
 OR EXISTS(SELECT FROM pg_trigger WHERE starts_with(tgname,'operative_delivery_'))
 OR EXISTS(SELECT FROM migrations WHERE name='167_operational_delivery_consumers')
 THEN RAISE EXCEPTION '167 requires exact intact156/166 predecessors' USING ERRCODE='55000';END IF;
 FOR n IN SELECT jsonb_object_keys(expected) LOOP
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=n) IS DISTINCT FROM expected->>n
 THEN RAISE EXCEPTION '167 predecessor body mismatch' USING ERRCODE='55000';END IF;END LOOP;
END $$;
CREATE TABLE operative_delivery_evidence(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,consumer text NOT NULL CHECK(consumer IN('label','parcel')),
 client_key uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),api_key_id uuid,worker_intent_id uuid,worker_basis_hash text,
 CHECK((worker_intent_id IS NULL)=(worker_basis_hash IS NULL)),CHECK(worker_intent_id IS NULL OR(consumer='label' AND api_key_id IS NULL AND worker_basis_hash ~ '^[a-f0-9]{64}$')),
 delivery_version bigint NOT NULL CHECK(delivery_version>0),delivery_hash text NOT NULL CHECK(delivery_hash ~ '^[a-f0-9]{64}$'),
 receipt_id uuid NOT NULL,buyer_basis_hash text NOT NULL CHECK(buyer_basis_hash ~ '^[a-f0-9]{64}$'),
 override_sha256 text NOT NULL CHECK(override_sha256 ~ '^[a-f0-9]{64}$'),
 evidence_encrypted text NOT NULL,evidence_bytes integer NOT NULL,evidence_sha256 text NOT NULL,
 root_xid xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,created_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,order_id,consumer,client_key),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 FOREIGN KEY(tenant_id,worker_intent_id) REFERENCES packed_label_print_intents(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,receipt_id) REFERENCES buyer_address_receipts(tenant_id,order_id,id),
 CHECK(buyer_address_cipher_valid(evidence_encrypted,evidence_bytes,evidence_sha256))
);
CREATE TABLE operative_delivery_certificate(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 profile text NOT NULL CHECK(profile='156-original-to167-operational-receiver/v1'),
 original156_manifest jsonb NOT NULL,original156_fingerprint text NOT NULL,
 original166_manifest jsonb NOT NULL,predecessor_functions jsonb NOT NULL,
 successor156_fingerprint text NOT NULL,successor_functions jsonb NOT NULL,
 own_fingerprint text NOT NULL,installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE operative_delivery_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE operative_delivery_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON operative_delivery_evidence TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON operative_delivery_evidence,operative_delivery_certificate FROM PUBLIC,dyna_app;
CREATE FUNCTION operative_delivery_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 RAISE EXCEPTION 'Operational receiver evidence is immutable' USING ERRCODE='23514';END $$;
CREATE TRIGGER operative_delivery_evidence_immutable BEFORE UPDATE OR DELETE ON operative_delivery_evidence FOR EACH ROW EXECUTE FUNCTION operative_delivery_immutable();
CREATE TRIGGER operative_delivery_certificate_immutable BEFORE UPDATE OR DELETE ON operative_delivery_certificate FOR EACH ROW EXECUTE FUNCTION operative_delivery_immutable();
-- Own deferred closure binds each NEW managed write proof to the real immutable
-- native consumer operation. No trigger is added to any sealed parent table.
CREATE FUNCTION operative_delivery_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE matched boolean;BEGIN
 IF NEW.root_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.transaction_started_at IS DISTINCT FROM transaction_timestamp() THEN RAISE EXCEPTION 'Operational evidence requires its actual root transaction' USING ERRCODE='23514';END IF;
 IF NEW.consumer='label' THEN
 SELECT EXISTS(SELECT FROM print_label_previews p JOIN print_label_assets a ON(a.tenant_id,a.id)=(p.tenant_id,p.asset_id)
 WHERE(p.tenant_id,p.order_id,p.client_key,p.actor_id,p.api_key_id) IS NOT DISTINCT FROM(NEW.tenant_id,NEW.order_id,NEW.client_key,NEW.actor_id,NEW.api_key_id)
 AND p.created_at>=NEW.transaction_started_at AND a.source_kind='demo_generated'
 AND a.source_frame->'operative_delivery'->>'version'=NEW.delivery_version::text AND a.source_frame->'operative_delivery'->>'hash'=NEW.delivery_hash)
 OR EXISTS(SELECT FROM print_job_label_sources l JOIN print_label_assets a ON(a.tenant_id,a.id)=(l.tenant_id,l.asset_id)
 WHERE(l.tenant_id,l.order_id,l.client_key,l.actor_id,l.api_key_id,l.top_xid,l.transaction_started_at) IS NOT DISTINCT FROM(NEW.tenant_id,NEW.order_id,NEW.client_key,NEW.actor_id,NEW.api_key_id,NEW.root_xid,NEW.transaction_started_at)
 AND a.source_kind='demo_generated' AND a.source_frame->'operative_delivery'->>'version'=NEW.delivery_version::text AND a.source_frame->'operative_delivery'->>'hash'=NEW.delivery_hash) INTO matched;
 ELSE
 SELECT EXISTS(SELECT FROM order_parcel_previews p WHERE(p.tenant_id,p.order_id,p.client_key,p.actor_id,p.api_key_id) IS NOT DISTINCT FROM(NEW.tenant_id,NEW.order_id,NEW.client_key,NEW.actor_id,NEW.api_key_id)
 AND p.created_at>=NEW.transaction_started_at AND p.payload->'source'->'operative_delivery'->>'version'=NEW.delivery_version::text AND p.payload->'source'->'operative_delivery'->>'hash'=NEW.delivery_hash)
 OR EXISTS(SELECT FROM order_parcel_plans p WHERE(p.tenant_id,p.order_id,p.client_key,p.actor_id,p.api_key_id) IS NOT DISTINCT FROM(NEW.tenant_id,NEW.order_id,NEW.client_key,NEW.actor_id,NEW.api_key_id)
 AND p.created_at>=NEW.transaction_started_at AND p.payload->'source'->'operative_delivery'->>'version'=NEW.delivery_version::text AND p.payload->'source'->'operative_delivery'->>'hash'=NEW.delivery_hash)
 OR EXISTS(SELECT FROM order_parcel_dispatches d JOIN order_parcel_plans p ON(p.tenant_id,p.id)=(d.tenant_id,d.plan_id)
 WHERE(d.tenant_id,d.order_id,d.client_key,d.actor_id,d.api_key_id) IS NOT DISTINCT FROM(NEW.tenant_id,NEW.order_id,NEW.client_key,NEW.actor_id,NEW.api_key_id)
 AND d.created_at>=NEW.transaction_started_at AND p.payload->'source'->'operative_delivery'->>'version'=NEW.delivery_version::text AND p.payload->'source'->'operative_delivery'->>'hash'=NEW.delivery_hash) INTO matched;
 END IF;
 IF NOT coalesce(matched,false) THEN RAISE EXCEPTION 'Operational proof lacks its typed native operation' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER operative_delivery_complete AFTER INSERT ON operative_delivery_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION operative_delivery_complete();
CREATE FUNCTION operative_delivery_functions() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_object_agg(p.proname,jsonb_build_object('definition',pg_get_functiondef(p.oid),'body',p.prosrc,'owner',pg_get_userbyid(p.proowner),'acl',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a))) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN('label_print_frame','order_parcel_source','packed_label_print_guards','packed_label_print_fingerprint')
$$;
UPDATE pg_temp.operative_delivery_install_basis SET predecessor_functions=operative_delivery_functions();
CREATE FUNCTION operative_delivery_plain_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to('{'||(SELECT string_agg(to_jsonb(key)::text||':'||value::text,',' ORDER BY key COLLATE "C") FROM jsonb_each(v))||'}','UTF8')),'hex')
$$;
CREATE FUNCTION operative_delivery_context_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT relowner=(SELECT proowner FROM pg_proc WHERE oid='public.operative_delivery_context_owner()'::regprocedure) AND relkind='r' AND relpersistence='t' FROM pg_class WHERE oid=to_regclass('pg_temp.operative_delivery_context')),false)
$$;
-- Persisted156 consent is a separate worker authority, never a synthetic session.
CREATE FUNCTION operative_delivery_worker_basis(t uuid,iid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('tenant_id',i.tenant_id,'intent_id',i.id,'order_id',i.order_id,'actor_id',i.approved_by,'configuration_id',i.configuration_id,'station_id',i.station_id,'receipt_id',i.receipt_id,'preview_key',i.preview_key,'queue_key',i.queue_key,'configuration_hash',buyer_address_hash(to_jsonb(cfg)),'packing_receipt_hash',buyer_address_hash(to_jsonb(r)))
 FROM packed_label_print_intents i JOIN packed_label_print_configurations cfg ON(cfg.tenant_id,cfg.id,cfg.approved_by,cfg.station_id)=(i.tenant_id,i.configuration_id,i.approved_by,i.station_id)
 JOIN packing_receipts r ON(r.tenant_id,r.id,r.order_id)=(i.tenant_id,i.receipt_id,i.order_id) WHERE(i.tenant_id,i.id)=(t,iid)
$$;
CREATE FUNCTION operative_delivery_worker_require(t uuid,iid uuid,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE i packed_label_print_intents;cfg packed_label_print_configurations;r packing_receipts;x record;b jsonb;current_frame jsonb;BEGIN
 IF NOT operative_delivery_valid() THEN RAISE EXCEPTION 'Incomplete operational worker' USING ERRCODE='55000';END IF;
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Worker tenant changed' USING ERRCODE='42501';END IF;
 PERFORM print_job_lock();
 SELECT * INTO i FROM packed_label_print_intents WHERE(tenant_id,id)=(t,iid);
 IF i.id IS NULL OR i.state NOT IN('waiting','queued') THEN RAISE EXCEPTION 'Worker requires actual waiting or completed intention' USING ERRCODE='23514';END IF;
 IF pin THEN PERFORM 1 FROM users WHERE id=i.approved_by FOR SHARE;PERFORM 1 FROM tenants WHERE id=t FOR SHARE;PERFORM 1 FROM account_security WHERE user_id=i.approved_by FOR SHARE;PERFORM 1 FROM workspace_security_policies WHERE tenant_id=t FOR SHARE;PERFORM 1 FROM memberships WHERE(user_id,tenant_id)=(i.approved_by,t) FOR SHARE;END IF;
 SELECT m.role,coalesce(p.require_mfa,false) requires_mfa,a.enabled_at INTO x FROM memberships m JOIN users u ON u.id=m.user_id JOIN tenants n ON n.id=m.tenant_id LEFT JOIN account_security a ON a.user_id=u.id LEFT JOIN workspace_security_policies p ON p.tenant_id=n.id WHERE(m.user_id,m.tenant_id)=(i.approved_by,t);
 IF x.role IS DISTINCT FROM 'admin' OR(coalesce(x.requires_mfa,false) AND x.enabled_at IS NULL) THEN RAISE EXCEPTION 'Stored approving administrator lost current authority' USING ERRCODE='42501';END IF;
 PERFORM packed_label_print_require(i.approved_by,true,pin);
 SELECT * INTO cfg FROM packed_label_print_configurations WHERE(tenant_id,id)=(t,i.configuration_id);
 SELECT * INTO r FROM packing_receipts WHERE(tenant_id,id,order_id)=(t,i.receipt_id,i.order_id);
 IF cfg.id IS NULL OR cfg.id IS DISTINCT FROM(SELECT id FROM packed_label_print_configurations WHERE tenant_id=t AND station_id=i.station_id ORDER BY version DESC LIMIT 1) OR NOT cfg.enabled
 OR r.id IS NULL OR r.kind<>'finish' OR r.full_snapshot->'station'->>'id' IS DISTINCT FROM i.station_id::text
 OR NOT EXISTS(SELECT FROM packing_sessions ps WHERE(ps.tenant_id,ps.id,ps.order_id,ps.owner_id)=(t,(r.result->>'session_id')::uuid,i.order_id,r.actor_id) AND ps.state='finished')

 THEN RAISE EXCEPTION 'Stored worker consent or packing provenance changed' USING ERRCODE='23514';END IF;
 --156's immutable printer snapshot keeps its original timestamp strings. Compare
 --those two typed instants exactly, all other keys/values byte-for-byte as JSONB;
 --do not normalize or replace the stored consent/configuration/history/hash.
 current_frame:=packed_label_print_configuration_frame(cfg.settings);
 IF (current_frame||jsonb_build_object('printer',(current_frame->'printer')-ARRAY['created_at','updated_at'])) IS DISTINCT FROM(cfg.snapshot||jsonb_build_object('printer',(cfg.snapshot->'printer')-ARRAY['created_at','updated_at']))
 OR(current_frame->'printer'->>'created_at')::timestamptz IS DISTINCT FROM(cfg.snapshot->'printer'->>'created_at')::timestamptz
 OR(current_frame->'printer'->>'updated_at')::timestamptz IS DISTINCT FROM(cfg.snapshot->'printer'->>'updated_at')::timestamptz
 THEN RAISE EXCEPTION 'Current worker station or printer changed' USING ERRCODE='23514';END IF;
 IF i.state='queued' AND NOT EXISTS(SELECT FROM print_job_label_sources l JOIN packed_label_print_admissions a ON(a.tenant_id,a.preview_id)=(l.tenant_id,l.preview_id) WHERE(a.tenant_id,a.intent_id,l.job_id,l.order_id,l.actor_id,l.api_key_id,l.client_key) IS NOT DISTINCT FROM(t,i.id,i.job_id,i.order_id,i.approved_by,NULL::uuid,i.queue_key)) THEN RAISE EXCEPTION 'Completed worker lacks native admitted job' USING ERRCODE='23514';END IF;
 b:=operative_delivery_worker_basis(t,iid);IF b IS NULL THEN RAISE EXCEPTION 'Missing immutable worker provenance' USING ERRCODE='23514';END IF;RETURN b;
END $$;
CREATE FUNCTION operative_delivery_worker_head(t uuid,iid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b jsonb;BEGIN b:=operative_delivery_worker_require(t,iid,false);RETURN jsonb_build_object('basis',b,'hash',buyer_address_hash(b));END $$;
-- The plaintext is transient, owner-created private temp data, never persisted.
CREATE FUNCTION operative_delivery_admit_internal(t uuid,oid uuid,uid uuid,kid uuid,h text,rname text,writing boolean,kind text,ck uuid,v jsonb,enc text,bytes integer,digest text,persist boolean,worker_iid uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE s buyer_address_state;r buyer_address_receipts;e operative_delivery_evidence;binding jsonb;stamp timestamptz;wb jsonb;wh text;BEGIN
 IF NOT operative_delivery_valid() THEN RAISE EXCEPTION 'Incomplete operational delivery consumers' USING ERRCODE='55000';END IF;
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR kind NOT IN('label','parcel') THEN RAISE EXCEPTION 'Operational tenant/consumer mismatch' USING ERRCODE='42501';END IF;
 IF worker_iid IS NULL THEN PERFORM buyer_address_identity(t,uid,kid,h,rname,false,false);
 ELSE wb:=operative_delivery_worker_require(t,worker_iid,false);wh:=buyer_address_hash(wb);
 IF(kind,uid,kid,rname,writing,oid) IS DISTINCT FROM('label', (wb->>'actor_id')::uuid,NULL::uuid,'admin',true,(wb->>'order_id')::uuid) OR ck NOT IN((wb->>'preview_key')::uuid,(wb->>'queue_key')::uuid) THEN RAISE EXCEPTION 'Worker receiver not bound to its exact intent' USING ERRCODE='42501';END IF;END IF;
 IF writing AND NOT persist THEN RAISE EXCEPTION 'Write requires persistent operational evidence' USING ERRCODE='23514';END IF;
 IF kind='label' THEN PERFORM label_print_require(uid,kid,writing);PERFORM print_job_lock();
 ELSE PERFORM order_parcel_require(uid,kid,writing,false);PERFORM order_parcel_lock(oid);END IF;
 PERFORM 1 FROM orders WHERE(tenant_id,id)=(t,oid) FOR UPDATE;
 SELECT * INTO s FROM buyer_address_state WHERE(tenant_id,order_id)=(t,oid);
 IF s.delivery_override_encrypted IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO r FROM buyer_address_receipts WHERE(tenant_id,order_id,id)=(t,oid,s.last_receipt_id);
 IF r.id IS NULL OR r.after_state IS DISTINCT FROM buyer_address_state_projection(s) OR s.delivery_kind<>'address'
 OR (SELECT coalesce(address->>'locker_code','')<>'' FROM orders WHERE(tenant_id,id)=(t,oid))
 OR jsonb_typeof(v) IS DISTINCT FROM 'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v) keys(key)) IS DISTINCT FROM ARRAY['city','country','phone','postal_code','recipient_name','street']::text[]
 OR EXISTS(SELECT FROM jsonb_each(v) WHERE jsonb_typeof(value)<>'string' OR length(value#>>'{}')=0)
 OR NOT buyer_address_cipher_valid(enc,bytes,digest)
 THEN RAISE EXCEPTION 'Invalid current operational receiver proof' USING ERRCODE='23514';END IF;
 binding:=jsonb_build_object('version',s.delivery_version::text,'hash',operative_delivery_plain_hash(v),'delivery',v);
 SELECT * INTO e FROM operative_delivery_evidence WHERE(tenant_id,order_id,consumer,client_key)=(t,oid,kind,ck);
 IF e.id IS NOT NULL AND (e.actor_id,e.api_key_id,e.delivery_version,e.delivery_hash,e.receipt_id,e.buyer_basis_hash,e.override_sha256,e.worker_intent_id,e.worker_basis_hash)
 IS DISTINCT FROM(uid,kid,s.delivery_version,binding->>'hash',s.last_receipt_id,buyer_address_buyer_basis(t,oid),s.override_sha256,worker_iid,wh)
 THEN RAISE EXCEPTION 'Operational evidence key differs' USING ERRCODE='40001';END IF;
 IF e.id IS NULL AND persist THEN
 stamp:=clock_timestamp();INSERT INTO operative_delivery_evidence(id,tenant_id,order_id,consumer,client_key,actor_id,api_key_id,worker_intent_id,worker_basis_hash,delivery_version,delivery_hash,receipt_id,buyer_basis_hash,override_sha256,evidence_encrypted,evidence_bytes,evidence_sha256,root_xid,transaction_started_at,created_at)
 VALUES(gen_random_uuid(),t,oid,kind,ck,uid,kid,worker_iid,wh,s.delivery_version,binding->>'hash',s.last_receipt_id,buyer_address_buyer_basis(t,oid),s.override_sha256,enc,bytes,digest,pg_current_xact_id(),transaction_timestamp(),stamp) RETURNING * INTO e;END IF;
 IF to_regclass('pg_temp.operative_delivery_context') IS NULL THEN
 CREATE TEMP TABLE operative_delivery_context(tenant_id uuid,order_id uuid,consumer text,actor_id uuid,api_key_id uuid,credential_hash text,role_name text,writing boolean,root_xid text,start_at timestamptz,binding jsonb,receipt_id uuid,buyer_basis_hash text,override_sha256 text,evidence_id uuid,worker_intent_id uuid,worker_basis_hash text,PRIMARY KEY(tenant_id,order_id,consumer)) ON COMMIT DROP;
 REVOKE ALL ON pg_temp.operative_delivery_context FROM PUBLIC,dyna_app;
 ELSIF NOT operative_delivery_context_owner() THEN RAISE EXCEPTION 'Untrusted operational receiver temp owner' USING ERRCODE='42501';END IF;
 INSERT INTO pg_temp.operative_delivery_context VALUES(t,oid,kind,uid,kid,h,rname,writing,pg_current_xact_id()::text,transaction_timestamp(),binding,s.last_receipt_id,buyer_address_buyer_basis(t,oid),s.override_sha256,e.id,worker_iid,wh)
 ON CONFLICT(tenant_id,order_id,consumer) DO UPDATE SET actor_id=EXCLUDED.actor_id,api_key_id=EXCLUDED.api_key_id,credential_hash=EXCLUDED.credential_hash,role_name=EXCLUDED.role_name,writing=EXCLUDED.writing,binding=EXCLUDED.binding,receipt_id=EXCLUDED.receipt_id,buyer_basis_hash=EXCLUDED.buyer_basis_hash,override_sha256=EXCLUDED.override_sha256,evidence_id=EXCLUDED.evidence_id,worker_intent_id=EXCLUDED.worker_intent_id,worker_basis_hash=EXCLUDED.worker_basis_hash;
 RETURN binding;
END $$;
-- HTTP and worker wrappers cannot choose each other's provenance branch.
CREATE FUNCTION operative_delivery_admit(t uuid,oid uuid,uid uuid,kid uuid,h text,rname text,writing boolean,kind text,ck uuid,v jsonb,enc text,bytes integer,digest text,persist boolean) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT operative_delivery_admit_internal(t,oid,uid,kid,h,rname,writing,kind,ck,v,enc,bytes,digest,persist,NULL)
$$;
CREATE FUNCTION operative_delivery_worker_admit(t uuid,iid uuid,ck uuid,v jsonb,enc text,bytes integer,digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b jsonb;BEGIN b:=operative_delivery_worker_require(t,iid,false);
 RETURN operative_delivery_admit_internal(t,(b->>'order_id')::uuid,(b->>'actor_id')::uuid,NULL,NULL,'admin',true,'label',ck,v,enc,bytes,digest,true,iid);END $$;
CREATE FUNCTION operative_delivery_receiver(t uuid,oid uuid,kind text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s buyer_address_state;x record;p order_parcel_plans;BEGIN
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Operational tenant mismatch' USING ERRCODE='42501';END IF;
 IF NOT operative_delivery_valid() THEN RAISE EXCEPTION 'Incomplete operational consumers' USING ERRCODE='55000';END IF;
 IF kind='parcel' THEN SELECT * INTO p FROM order_parcel_plans WHERE(tenant_id,order_id)=(t,oid);
 IF p.id IS NOT NULL AND NOT (p.payload->'source' ? 'operative_delivery') THEN RETURN NULL;END IF;END IF;
 SELECT * INTO s FROM buyer_address_state WHERE(tenant_id,order_id)=(t,oid);
 IF s.delivery_override_encrypted IS NULL THEN RETURN NULL;END IF;
 IF NOT operative_delivery_context_owner() THEN RAISE EXCEPTION 'Current receiver needs managed decrypt admission' USING ERRCODE='23514';END IF;
 SELECT * INTO x FROM pg_temp.operative_delivery_context WHERE(tenant_id,order_id,consumer)=(t,oid,kind);
 IF x.order_id IS NULL OR (x.root_xid,x.start_at,x.receipt_id,x.override_sha256,x.buyer_basis_hash,x.binding->>'version')
 IS DISTINCT FROM(pg_current_xact_id()::text,transaction_timestamp(),s.last_receipt_id,s.override_sha256,buyer_address_buyer_basis(t,oid),s.delivery_version::text)
 OR x.binding->>'hash' IS DISTINCT FROM operative_delivery_plain_hash(x.binding->'delivery')
 OR(p.id IS NOT NULL AND p.payload->'source'->'operative_delivery' IS DISTINCT FROM x.binding)
 THEN RAISE EXCEPTION 'Current operational receiver changed' USING ERRCODE='40001';END IF;
 RETURN x.binding;
END $$;
CREATE OR REPLACE FUNCTION label_print_frame(sid uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; s shipments; o orders; p shipping_plans; src jsonb; renderer jsonb; b64 text; kind text; n integer; delivery jsonb;
BEGIN
 PERFORM label_print_require(uid,kid,true); PERFORM print_job_lock();
 SELECT * INTO s FROM shipments WHERE tenant_id=t AND id=sid;
 IF s.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono przesyłki do drukowania' USING ERRCODE='P0002'; END IF;
 SELECT * INTO o FROM orders WHERE tenant_id=t AND id=s.order_id FOR UPDATE;
 SELECT * INTO s FROM shipments WHERE tenant_id=t AND id=sid FOR UPDATE;
 IF o.id IS NULL OR s.order_id IS DISTINCT FROM o.id OR s.status IN('cancelled','voided') THEN RAISE EXCEPTION 'Przesyłka nie ma aktualnego źródła etykiety' USING ERRCODE='23514'; END IF;
 IF s.mode='demo' THEN
  delivery:=operative_delivery_receiver(t,o.id,'label');
  kind:='demo_generated'; renderer:=jsonb_build_object('order_number',o.number,'tracking_number',s.tracking_number,'carrier',s.carrier,'recipient',jsonb_build_object('name',CASE WHEN delivery IS NULL THEN o.customer_name ELSE delivery->'delivery'->>'recipient_name' END,'address',jsonb_build_object('street',CASE WHEN delivery IS NULL THEN o.address->>'street' ELSE delivery->'delivery'->>'street' END,'postal_code',CASE WHEN delivery IS NULL THEN o.address->>'postal_code' ELSE delivery->'delivery'->>'postal_code' END,'city',CASE WHEN delivery IS NULL THEN o.address->>'city' ELSE delivery->'delivery'->>'city' END,'country',CASE WHEN delivery IS NULL THEN o.address->>'country' ELSE delivery->'delivery'->>'country' END)));
 ELSIF s.carrier='DPD Polska' THEN
  SELECT count(*) INTO n FROM shipping_plans WHERE tenant_id=t AND shipment_id=sid AND input->>'provider'='dpd' AND state IN('ready','dispatched') AND result->>'tracking_number'=s.tracking_number;
  IF n<>1 THEN RAISE EXCEPTION 'Brak jednoznacznej lokalnej etykiety DPD' USING ERRCODE='23514'; END IF;
  SELECT * INTO p FROM shipping_plans WHERE tenant_id=t AND shipment_id=sid AND input->>'provider'='dpd' AND state IN('ready','dispatched') AND result->>'tracking_number'=s.tracking_number FOR UPDATE;
  IF p.order_id IS DISTINCT FROM o.id OR p.channel_id IS DISTINCT FROM s.channel_id OR p.remote_id IS DISTINCT FROM s.external_id OR p.result->>'waybill' IS DISTINCT FROM s.tracking_number OR p.result->>'label_base64' IS NULL THEN RAISE EXCEPTION 'Brak zapisanych lokalnie bajtów etykiety' USING ERRCODE='23514'; END IF;
  b64:=p.result->>'label_base64'; kind:='dpd_cached';
  IF print_job_content_valid(b64,'pdf') IS NOT TRUE THEN RAISE EXCEPTION 'Zapisana etykieta nie spełnia limitu bezpiecznego PDF' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'Brak zapisanych lokalnie bajtów etykiety; pobieranie dostawcy jest wyłączone' USING ERRCODE='23514'; END IF;
 src:=jsonb_build_object('source_kind',kind,'shipment',jsonb_build_object('id',s.id,'order_id',s.order_id,'carrier',s.carrier,'tracking_number',s.tracking_number,'mode',s.mode,'status',s.status,'channel_id',s.channel_id,'external_id',s.external_id,'dispatched_at',s.dispatched_at),'plan',CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id',p.id,'order_id',p.order_id,'shipment_id',p.shipment_id,'channel_id',p.channel_id,'state',p.state,'phase',p.phase,'remote_id',p.remote_id,'updated_at',p.updated_at,'content_sha256',encode(sha256(decode(b64,'base64')),'hex')) END,'renderer_input',renderer);
 IF delivery IS NOT NULL THEN src:=src||jsonb_build_object('operative_delivery',delivery);END IF;
 PERFORM label_print_require(uid,kid,true);
 RETURN jsonb_build_object('source_frame',src,'source_hash',print_job_hash(src),'source_kind',kind,'shipping_plan_id',p.id,'order_snapshot',jsonb_build_object('id',o.id,'number',o.number,'version',o.version::text,'status',o.status,'warehouse_id',o.warehouse_id),'renderer_input',renderer,'content_base64',b64);
END $$;
CREATE OR REPLACE FUNCTION order_parcel_source(oid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;o orders;due bigint;enabled boolean;why text;delivery jsonb;BEGIN
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
 delivery:=operative_delivery_receiver(t,oid,'parcel');
 RETURN jsonb_build_object('order',jsonb_build_object('id',o.id,'number',o.number,'version',o.version::text,'status',o.status,'warehouse_id',o.warehouse_id,'payment_mode',o.payment_mode,'currency',o.currency),
 'receiver',CASE WHEN delivery IS NULL THEN jsonb_build_object('name',o.customer_name,'email',o.email,'address',o.address) ELSE jsonb_build_object('name',delivery->'delivery'->>'recipient_name','email',o.email,'address',(o.address-ARRAY['street','city','postal_code','country','phone','locker_code'])||((delivery->'delivery')-'recipient_name')) END,
 'products',coalesce((SELECT jsonb_agg(jsonb_build_object('product_id',r.product_id,'sku',p.sku,'name',p.name,'quantity',r.quantity,'consumed_quantity',r.consumed_quantity,'remaining',r.quantity-r.consumed_quantity,'scanned',(SELECT coalesce(sum(scanned),0) FROM reservation_locations WHERE tenant_id=t AND order_id=oid AND product_id=r.product_id),'locations',coalesce((SELECT jsonb_agg(jsonb_build_object('location',l.location,'quantity',l.quantity,'scanned',l.scanned,'consumed_quantity',l.consumed_quantity) ORDER BY l.location) FROM reservation_locations l WHERE tenant_id=t AND order_id=oid AND product_id=r.product_id),'[]'::jsonb),'layers',coalesce((SELECT jsonb_agg(jsonb_build_object('layer_id',h.layer_id,'location',h.location,'quantity',h.quantity,'scanned',h.scanned,'consumed_quantity',h.consumed_quantity) ORDER BY h.layer_id,h.location) FROM wms_reservation_layers h WHERE tenant_id=t AND order_id=oid AND product_id=r.product_id),'[]'::jsonb)) ORDER BY r.product_id) FROM reservations r JOIN products p ON(p.tenant_id,p.id)=(r.tenant_id,r.product_id) WHERE r.tenant_id=t AND r.order_id=oid),'[]'::jsonb),
 'shipments',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'carrier',s.carrier,'mode',s.mode,'tracking_number',s.tracking_number,'cod_expected',s.cod_expected,'dispatched_at',s.dispatched_at) ORDER BY s.id) FROM shipments s WHERE tenant_id=t AND order_id=oid),'[]'::jsonb),'cod_due',CASE WHEN o.payment_mode='cod' THEN due ELSE 0 END,
 'payment_due',due,'active_plan_id',(SELECT id FROM order_parcel_plans WHERE tenant_id=t AND order_id=oid),'wms_enabled',enabled,'can_preview',why IS NULL,'unavailable_reason',why)||CASE WHEN delivery IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('operative_delivery',delivery) END;
END $$;
CREATE FUNCTION operative_delivery_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',pg_get_userbyid(c.relowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'operative_delivery_') AND c.relkind IN('r','p')),
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'number',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'collation',(SELECT collname FROM pg_collation WHERE oid=a.attcollation)) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum) WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'operative_delivery_') AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',c.conname,'def',pg_get_constraintdef(c.oid,true),'validated',c.convalidated) ORDER BY t.relname,c.conname) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relnamespace='public'::regnamespace AND starts_with(t.relname,'operative_delivery_')),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',idx.relname,'def',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) ORDER BY t.relname,idx.relname) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid WHERE t.relnamespace='public'::regnamespace AND starts_with(t.relname,'operative_delivery_')),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',t.tgname,'def',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY n.nspname,c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND(starts_with(t.tgname,'operative_delivery_') OR(c.relnamespace='public'::regnamespace AND starts_with(c.relname,'operative_delivery_')))),
 'policies',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END) FROM unnest(p.polroles) r),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname,p.polname) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'operative_delivery_')),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'def',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x),'app_execute',has_function_privilege('dyna_app',p.oid,'EXECUTE')) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'operative_delivery_')),
 'app_role',(SELECT jsonb_build_object('superuser',r.rolsuper,'inherit',r.rolinherit,'bypass_rls',r.rolbypassrls,'create_role',r.rolcreaterole,'create_db',r.rolcreatedb,'login',r.rolcanlogin) FROM pg_roles r WHERE rolname='dyna_app'),
 'app_acl',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'select',has_table_privilege('dyna_app',c.oid,'SELECT'),'insert',has_table_privilege('dyna_app',c.oid,'INSERT'),'update',has_table_privilege('dyna_app',c.oid,'UPDATE'),'delete',has_table_privilege('dyna_app',c.oid,'DELETE')) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'operative_delivery_') AND c.relkind IN('r','p'))
 )::text,'UTF8')),'hex')
$$;
CREATE FUNCTION operative_delivery_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE cert operative_delivery_certificate;basis record;o oid;n text;expected jsonb:='{"label_print_frame":"d191d4c1280acb4f6c5dec86c23ce72dfce2a5781ad0b0264ed544372454d0c4","order_parcel_source":"5d1ec193a5a147ca758682a3f15ca86c977797717642b833d657397bc4b80fec","packed_label_print_guards":"899a7420b798208ec7350370eb732b98984de00089ec534d7a73f83e1ffcfe0f"}'::jsonb;BEGIN
 IF current_setting('session_replication_role')<>'origin' OR to_regclass('public.operative_delivery_certificate') IS NULL OR to_regclass('public.operative_delivery_evidence') IS NULL
 OR to_regclass('public.buyer_address_manifest') IS NULL OR to_regclass('public.packed_label_print_manifest') IS NULL
 OR to_regclass('public.migrations') IS NULL
 OR to_regprocedure('public.operative_delivery_fingerprint()') IS NULL OR to_regprocedure('public.operative_delivery_functions()') IS NULL
 OR to_regprocedure('public.packed_label_print_fingerprint()') IS NULL
 OR to_regprocedure('public.buyer_address_fingerprint()') IS NULL OR to_regprocedure('public.buyer_address_predecessors()') IS NULL
 OR NOT EXISTS(SELECT FROM migrations WHERE name='156_packed_label_print') OR NOT EXISTS(SELECT FROM migrations WHERE name='166_buyer_address_sidecar')
 OR (SELECT array_agg(relname::text ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'operative_delivery_') AND relkind IN('r','p')) IS DISTINCT FROM ARRAY['operative_delivery_certificate','operative_delivery_evidence']::text[]
 OR (SELECT count(*) FROM operative_delivery_certificate)<>1 THEN RETURN false;END IF;
 SELECT * INTO cert FROM operative_delivery_certificate;
 IF jsonb_typeof(cert.predecessor_functions) IS DISTINCT FROM 'object' OR jsonb_typeof(cert.successor_functions) IS DISTINCT FROM 'object'
 OR jsonb_typeof(cert.original156_manifest) IS DISTINCT FROM 'object' OR jsonb_typeof(cert.original166_manifest) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF cert.profile IS DISTINCT FROM '156-original-to167-operational-receiver/v1'
 OR cert.original156_manifest IS DISTINCT FROM(SELECT to_jsonb(m) FROM packed_label_print_manifest m)
 OR cert.original166_manifest IS DISTINCT FROM(SELECT to_jsonb(m) FROM buyer_address_manifest m)
 OR cert.original166_manifest->>'fingerprint' IS DISTINCT FROM buyer_address_fingerprint()
 OR cert.original166_manifest->'predecessor_certificates' IS DISTINCT FROM buyer_address_predecessors()
 OR cert.original156_fingerprint IS DISTINCT FROM cert.original156_manifest->>'fingerprint'
 OR cert.successor156_fingerprint IS DISTINCT FROM packed_label_print_fingerprint()
 OR cert.successor_functions IS DISTINCT FROM operative_delivery_functions()
 OR cert.own_fingerprint IS DISTINCT FROM operative_delivery_fingerprint()
 OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(cert.predecessor_functions) keys(key)) IS DISTINCT FROM ARRAY['label_print_frame','order_parcel_source','packed_label_print_fingerprint','packed_label_print_guards']::text[]
 THEN RETURN false;END IF;
 FOR n IN SELECT jsonb_object_keys(expected) LOOP
 IF encode(sha256(convert_to(cert.predecessor_functions->n->>'body','UTF8')),'hex') IS DISTINCT FROM expected->>n
 OR ((cert.predecessor_functions->n)-'definition'-'body') IS DISTINCT FROM((cert.successor_functions->n)-'definition'-'body')
 THEN RETURN false;END IF;END LOOP;
 IF cert.predecessor_functions->'packed_label_print_fingerprint' IS DISTINCT FROM cert.successor_functions->'packed_label_print_fingerprint' THEN RETURN false;END IF;
 IF EXISTS(SELECT FROM migrations WHERE name='167_operational_delivery_consumers') THEN RETURN true;END IF;
 o:=to_regclass('pg_temp.operative_delivery_install_basis');IF o IS NULL THEN RETURN false;END IF;
 IF (SELECT relowner FROM pg_class WHERE oid=o) IS DISTINCT FROM(SELECT relowner FROM pg_class WHERE oid='public.operative_delivery_certificate'::regclass)
 OR current_user IS DISTINCT FROM session_user OR session_user IS DISTINCT FROM(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=o)
 THEN RETURN false;END IF;
 IF(SELECT count(*) FROM pg_temp.operative_delivery_install_basis)<>1 THEN RETURN false;END IF;
 SELECT * INTO basis FROM pg_temp.operative_delivery_install_basis;
 RETURN(basis.root_xid,basis.start_at,basis.backend_pid,basis.owner_name,basis.original156_manifest,basis.original166_manifest,basis.predecessor_functions)
 IS NOT DISTINCT FROM(pg_current_xact_id()::text,transaction_timestamp(),pg_backend_pid(),session_user::text,cert.original156_manifest,cert.original166_manifest,cert.predecessor_functions);
END $$;
CREATE OR REPLACE FUNCTION packed_label_print_guards() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF current_setting('session_replication_role')<>'origin' OR NOT EXISTS(SELECT 1 FROM migrations WHERE name='156_packed_label_print') OR EXISTS(SELECT 1 FROM unnest(ARRAY['packed_label_print_previews','packed_label_print_configurations','packed_label_print_intents','packed_label_print_admissions','packed_label_print_manifest','print_printers','print_jobs','print_job_events','print_label_assets','print_label_previews','print_job_label_sources','packing_stations','packing_cartons','packing_policies','packing_sessions','packing_operations','packing_previews','packing_receipts','order_packing_profiles']) n WHERE to_regclass(n) IS NULL) OR EXISTS(SELECT 1 FROM unnest(ARRAY['packed_label_print_require', 'packed_label_print_configuration_frame', 'packed_label_print_preview', 'packed_label_print_approve', 'packed_label_print_capture', 'packed_label_print_resolve_frame', 'packed_label_print_admit', 'packed_label_print_queue_allowed', 'packed_label_print_finish', 'packed_label_print_complete', 'packed_label_print_immutable', 'label_print_queue', 'label_print_guard', 'packed_label_print_capture_trigger', 'print_job_installed', 'print_job_access', 'print_job_require', 'print_job_hash', 'print_job_head', 'print_job_printer_head', 'print_job_lock', 'print_job_budget', 'print_job_content_valid', 'print_job_replay', 'print_job_event', 'print_job_printer_write', 'print_job_create', 'print_job_command', 'print_job_content', 'print_job_immutable', 'print_job_guard', 'print_job_complete', 'print_job_guards', 'label_print_installed', 'label_print_require', 'label_print_frame', 'label_print_configuration', 'label_print_preview_replay', 'label_print_store_preview', 'label_print_asset', 'label_print_queue_replay', 'label_print_budget', 'label_print_immutable', 'label_print_budget_trigger', 'label_print_seal', 'label_print_guards', 'packing_current_role', 'packing_key_grant', 'packing_operator_names', 'packing_fulfillment_snapshot', 'packing_fulfillment_hash', 'packing_row_guard', 'packing_budget_guard', 'packing_receipt_after_guard', 'packing_insert_admission', 'packing_scope_guard', 'packing_update_admission','packed_label_print_fingerprint','packed_label_print_guards']) n WHERE NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=n)) THEN RETURN false;END IF;
 RETURN label_print_guards() AND print_job_guards() AND operative_delivery_valid();END $$;
CREATE FUNCTION operative_delivery_terminal() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE x record;g jsonb;BEGIN
 IF NOT operative_delivery_context_owner() THEN RETURN true;END IF;
 FOR x IN SELECT * FROM pg_temp.operative_delivery_context ORDER BY tenant_id,order_id,consumer LOOP
 IF x.worker_intent_id IS NULL THEN PERFORM buyer_address_identity(x.tenant_id,x.actor_id,x.api_key_id,x.credential_hash,x.role_name,false,true);
 ELSE IF NOT EXISTS(SELECT FROM packed_label_print_intents WHERE(tenant_id,id,state)=(x.tenant_id,x.worker_intent_id,'queued')) THEN RAISE EXCEPTION 'Corrected packed worker must complete admitted queue' USING ERRCODE='23514';END IF;IF buyer_address_hash(operative_delivery_worker_require(x.tenant_id,x.worker_intent_id,true)) IS DISTINCT FROM x.worker_basis_hash THEN RAISE EXCEPTION 'Worker provenance changed' USING ERRCODE='40001';END IF;END IF;
 IF x.consumer='label' THEN g:=print_job_access(x.actor_id,x.api_key_id,x.writing,true);ELSE g:=order_parcel_access(x.actor_id,x.api_key_id,x.writing,true);END IF;
 IF NOT coalesce((g->>'key_valid')::boolean,false) OR NOT coalesce((g->>'allowed')::boolean,false) THEN RAISE EXCEPTION 'Operational consumer authority changed' USING ERRCODE='42501';END IF;
 PERFORM operative_delivery_receiver(x.tenant_id,x.order_id,x.consumer);
 END LOOP;
 IF NOT operative_delivery_valid() OR NOT buyer_address_guards() THEN RAISE EXCEPTION 'Operational metadata changed' USING ERRCODE='55000';END IF;
 FOR x IN SELECT * FROM pg_temp.operative_delivery_context LOOP
 IF x.consumer='label' THEN PERFORM label_print_require(x.actor_id,x.api_key_id,x.writing);ELSE PERFORM order_parcel_require(x.actor_id,x.api_key_id,x.writing,false);END IF;
 IF x.worker_intent_id IS NULL THEN PERFORM buyer_address_identity(x.tenant_id,x.actor_id,x.api_key_id,x.credential_hash,x.role_name,false,false);
 ELSE IF buyer_address_hash(operative_delivery_worker_require(x.tenant_id,x.worker_intent_id,false)) IS DISTINCT FROM x.worker_basis_hash THEN RAISE EXCEPTION 'Worker current authority changed' USING ERRCODE='40001';END IF;END IF;
 END LOOP;RETURN true;
END $$;
DO $$ DECLARE p record;BEGIN FOR p IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'operative_delivery_') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',p.signature);END LOOP;END $$;
GRANT EXECUTE ON FUNCTION operative_delivery_admit(uuid,uuid,uuid,uuid,text,text,boolean,text,uuid,jsonb,text,integer,text,boolean),operative_delivery_terminal(),operative_delivery_valid(),operative_delivery_worker_head(uuid,uuid),operative_delivery_worker_admit(uuid,uuid,uuid,jsonb,text,integer,text) TO dyna_app;
INSERT INTO operative_delivery_certificate(singleton,profile,original156_manifest,original156_fingerprint,original166_manifest,predecessor_functions,successor156_fingerprint,successor_functions,own_fingerprint)
 SELECT true,'156-original-to167-operational-receiver/v1',original156_manifest,original156_fingerprint,original166_manifest,predecessor_functions,packed_label_print_fingerprint(),operative_delivery_functions(),operative_delivery_fingerprint() FROM pg_temp.operative_delivery_install_basis;
DO $$ BEGIN IF NOT operative_delivery_valid() OR NOT packed_label_print_guards() OR NOT buyer_address_guards() OR NOT order_parcel_guards()
 THEN RAISE EXCEPTION '167 certified consumers or unchanged ancestors refused' USING ERRCODE='55000';END IF;END $$;
-- Managed root appends 167_operational_delivery_consumers in this same owner TX.
