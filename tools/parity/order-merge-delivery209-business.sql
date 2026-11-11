-- Source209 candidate. The historical SQL103/166 and certificate rows stay literal.
-- Business writer is complete below; closed predecessor-DAG integration is a
-- separate source-derived section appended by the generator before activation.
-- No migration/resource registration is authorized by this source file alone.
SET LOCAL TimeZone='UTC';
DO $pre209$ BEGIN
 IF current_user IS DISTINCT FROM session_user OR current_user<>'postgres'
  OR current_setting('session_replication_role')<>'origin'
  OR NOT EXISTS(SELECT FROM public.migrations WHERE name='208_consumer_return_credit_guard_dedup')
  OR public.return_credit206_guards() IS DISTINCT FROM true
  OR public.buyer_address_guards() IS DISTINCT FROM true
  OR EXISTS(SELECT FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'order_merge_delivery209_'))
  OR EXISTS(SELECT FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'order_merge_delivery209_'))
 THEN RAISE EXCEPTION '209 requires intact208 and no inheritance remnants' USING ERRCODE='55000';END IF;
END $pre209$;

CREATE TABLE public.order_merge_delivery209_receipts(
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,source_order_id uuid NOT NULL,target_order_id uuid NOT NULL,
 merge_preview_id uuid NOT NULL,actor_id uuid NOT NULL,api_key_id uuid,
 credential_hash text NOT NULL CHECK(credential_hash~'^[a-f0-9]{64}$'),actor_role text NOT NULL CHECK(actor_role='admin'),
 preview_id uuid NOT NULL,receipt_id uuid NOT NULL,scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),sidecar_scope_hash text NOT NULL CHECK(sidecar_scope_hash~'^[a-f0-9]{64}$'),
 source_frames jsonb NOT NULL CHECK(jsonb_typeof(source_frames)='array' AND jsonb_array_length(source_frames) BETWEEN 2 AND 100 AND octet_length(source_frames::text)<=8388608),
 source_state jsonb NOT NULL CHECK(public.buyer_address_state_shape(source_state)),
 source_buyer_basis_hash text NOT NULL CHECK(source_buyer_basis_hash~'^[a-f0-9]{64}$'),
 target_buyer_basis_hash text NOT NULL CHECK(target_buyer_basis_hash~'^[a-f0-9]{64}$'),
 before_state jsonb NOT NULL CHECK(public.buyer_address_state_shape(before_state)),
 after_state jsonb NOT NULL CHECK(public.buyer_address_state_shape(after_state)),
 target_order_version bigint NOT NULL CHECK(target_order_version>0),
 evidence_encrypted text NOT NULL,evidence_byte_count integer NOT NULL,evidence_sha256 text NOT NULL,
 CHECK(public.buyer_address_cipher_valid(evidence_encrypted,evidence_byte_count,evidence_sha256)),
 root_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,execution_id),UNIQUE(tenant_id,target_order_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,receipt_id),
 FOREIGN KEY(tenant_id,execution_id) REFERENCES public.order_merge_executions(tenant_id,id),
 FOREIGN KEY(tenant_id,merge_preview_id) REFERENCES public.order_merge_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,source_order_id) REFERENCES public.orders(tenant_id,id),
 FOREIGN KEY(tenant_id,target_order_id) REFERENCES public.orders(tenant_id,id),
 FOREIGN KEY(actor_id) REFERENCES public.users(id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id),
 FOREIGN KEY(tenant_id,target_order_id,preview_id) REFERENCES public.buyer_address_previews(tenant_id,order_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,target_order_id,receipt_id) REFERENCES public.buyer_address_receipts(tenant_id,order_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(source_order_id<>target_order_id),CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes')
);
ALTER TABLE public.order_merge_delivery209_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_merge_delivery209_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON public.order_merge_delivery209_receipts TO postgres USING(true) WITH CHECK(true);
REVOKE ALL ON public.order_merge_delivery209_receipts FROM PUBLIC,dyna_app;

CREATE FUNCTION public.order_merge_delivery209_immutable() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public AS $$BEGIN RAISE EXCEPTION 'Merge delivery inheritance is immutable' USING ERRCODE='23514';END$$;
CREATE TRIGGER order_merge_delivery209_immutable BEFORE UPDATE OR DELETE ON public.order_merge_delivery209_receipts FOR EACH ROW EXECUTE FUNCTION public.order_merge_delivery209_immutable();
CREATE TRIGGER order_merge_delivery209_no_truncate BEFORE TRUNCATE ON public.order_merge_delivery209_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.order_merge_delivery209_immutable();

-- Keep the MERGE inventory scopes in addition to Native166 current credential IAM.
-- pin=true acquires the existing ordered identity anchors; terminal reads add no locks.
CREATE FUNCTION public.order_merge_delivery209_identity(t uuid,u uuid,k uuid,h text,r text,pin boolean) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 PERFORM public.buyer_address_identity(t,u,k,h,r,true,pin);
 IF k IS NOT NULL AND NOT EXISTS(SELECT FROM public.api_keys a WHERE(a.tenant_id,a.user_id,a.id)=(t,u,k)
  AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
  AND a.scopes @> ARRAY['orders:read','orders:write','inventory:read','inventory:write']::text[])
 THEN RAISE EXCEPTION 'Current MERGE key scopes refused' USING ERRCODE='42501';END IF;
END$$;

-- Caller already locks source order headers in UUID order. This validator reads
-- actual Native166 state/basis, never caller-selected ciphertext or a cached IAM.
CREATE FUNCTION public.order_merge_delivery209_validate_frames(ids uuid[],frames jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;f jsonb;s jsonb;r public.buyer_address_receipts%ROWTYPE;seen uuid[]:=ARRAY[]::uuid[];oid uuid;
BEGIN
 IF public.order_merge_delivery209_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '209 metadata changed' USING ERRCODE='55000';END IF;
 IF t IS NULL OR ids IS NULL OR array_position(ids,NULL) IS NOT NULL
  OR cardinality(ids) NOT BETWEEN 2 AND 100 OR(SELECT count(DISTINCT item) FROM unnest(ids) item)<>cardinality(ids)
  OR jsonb_typeof(frames) IS DISTINCT FROM 'array' OR jsonb_array_length(frames)<>cardinality(ids)
  OR octet_length(frames::text)>8388608 THEN RAISE EXCEPTION 'Invalid complete buyer frame roster' USING ERRCODE='23514';END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(frames) LOOP
  IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(f) keys(key))
   IS DISTINCT FROM ARRAY['buyer_basis_hash','effective_hash','effective_kind','order_id','state']::text[]
   OR jsonb_typeof(f->'order_id') IS DISTINCT FROM 'string' OR NOT coalesce(f->>'order_id'~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$',false)
   THEN RAISE EXCEPTION 'Invalid buyer frame shape' USING ERRCODE='23514';END IF;
  oid:=(f->>'order_id')::uuid;
  IF (oid=ANY(ids)) IS DISTINCT FROM true OR oid=ANY(seen) OR NOT EXISTS(SELECT FROM public.orders WHERE(tenant_id,id)=(t,oid))
   THEN RAISE EXCEPTION 'Missing, duplicate or foreign buyer source' USING ERRCODE='23514';END IF;
  seen:=array_append(seen,oid);s:=public.buyer_address_current_state(t,oid);
  IF public.buyer_address_state_shape(f->'state') IS DISTINCT FROM true OR f->'state' IS DISTINCT FROM s
   OR f->>'buyer_basis_hash' IS DISTINCT FROM public.buyer_address_buyer_basis(t,oid)
   OR f->>'effective_kind' IS DISTINCT FROM s->>'delivery_kind'
   OR jsonb_typeof(f->'effective_kind') IS DISTINCT FROM 'string'
   OR((f->>'effective_kind'='address') AND(jsonb_typeof(f->'effective_hash') IS DISTINCT FROM 'string' OR NOT coalesce(f->>'effective_hash'~'^[a-f0-9]{64}$',false)))
   OR((f->>'effective_kind'<>'address') AND f->'effective_hash' IS DISTINCT FROM 'null'::jsonb)
   THEN RAISE EXCEPTION 'Current buyer source state or classification changed' USING ERRCODE='40001';END IF;
  IF(s->>'version')::bigint>0 THEN
   SELECT * INTO r FROM public.buyer_address_receipts WHERE(tenant_id,order_id,id)=(t,oid,(s->>'last_receipt_id')::uuid);
   IF r.id IS NULL OR NOT r.changed OR r.after_state IS DISTINCT FROM s
    OR r.buyer_basis_hash IS DISTINCT FROM public.buyer_address_buyer_basis(t,oid)
    THEN RAISE EXCEPTION 'Source sidecar lacks its own sealed lineage' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
 RETURN true;
END$$;

CREATE FUNCTION public.order_merge_delivery209_preview_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 PERFORM public.order_merge_delivery209_validate_frames(NEW.source_ids,NEW.snapshot->'buyer_delivery_frames');
 RETURN NEW;
END$$;
CREATE TRIGGER order_merge_delivery209_source_preview BEFORE INSERT ON public.order_merge_previews FOR EACH ROW EXECUTE FUNCTION public.order_merge_delivery209_preview_guard();

-- Current-transaction proof matches the actual parent MERGE, source166 state and
-- fresh target. The credential digest is private, never returned by any reader.
CREATE FUNCTION public.order_merge_delivery209_validate_receipt(eid uuid,terminal boolean DEFAULT false) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r public.order_merge_delivery209_receipts%ROWTYPE;e public.order_merge_executions%ROWTYPE;p public.order_merge_previews%ROWTYPE;o public.orders%ROWTYPE;source public.orders%ROWTYPE;state jsonb;wanted jsonb;f jsonb;
BEGIN
 IF public.order_merge_delivery209_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '209 metadata changed' USING ERRCODE='55000';END IF;
 SELECT * INTO r FROM public.order_merge_delivery209_receipts WHERE(tenant_id,execution_id)=(t,eid);
 SELECT * INTO e FROM public.order_merge_executions WHERE(tenant_id,id)=(t,eid);
 SELECT * INTO p FROM public.order_merge_previews WHERE(tenant_id,id)=(t,e.preview_id);
 SELECT * INTO o FROM public.orders WHERE(tenant_id,id)=(t,r.target_order_id);
 SELECT * INTO source FROM public.orders WHERE(tenant_id,id)=(t,r.source_order_id);
 IF r.execution_id IS NULL OR e.id IS NULL OR p.id IS NULL OR o.id IS NULL OR source.id IS NULL
  OR r.root_xid<>pg_current_xact_id() OR r.transaction_started_at<>transaction_timestamp()
  OR (SELECT z.xmin::text FROM public.order_merge_executions z WHERE(z.tenant_id,z.id)=(t,e.id)) IS DISTINCT FROM mod(pg_current_xact_id()::text::numeric,4294967296)::text
  OR e.merge_mode<>'technical_merge' OR e.state<>'done' OR NOT p.ready
  OR(e.actor_id,e.api_key_id,e.main_order_id,e.target_order_id,e.preview_id,e.scope_hash,e.request_hash)
   IS DISTINCT FROM(r.actor_id,r.api_key_id,r.source_order_id,r.target_order_id,r.merge_preview_id,r.scope_hash,r.request_hash)
  OR(e.actor_id,e.api_key_id,e.main_order_id,e.target_order_id,e.source_ids,e.scope_hash,e.before_snapshot)
   IS DISTINCT FROM(p.actor_id,p.api_key_id,p.main_order_id,p.target_order_id,p.source_ids,p.scope_hash,p.snapshot)
  OR r.source_frames IS DISTINCT FROM p.snapshot->'buyer_delivery_frames'
  OR e.after_snapshot->'target' IS DISTINCT FROM to_jsonb(o)
  OR o.version<>r.target_order_version
  OR (SELECT z.xmin::text FROM public.orders z WHERE(z.tenant_id,z.id)=(t,o.id)) IS DISTINCT FROM mod(pg_current_xact_id()::text::numeric,4294967296)::text
  OR(o.portal_enabled,o.portal_expires_at) IS DISTINCT FROM(source.portal_enabled,source.portal_expires_at)
  OR o.portal_token !~ '^[a-f0-9]{48}$' OR o.portal_token=ANY(SELECT z.portal_token FROM public.orders z WHERE z.tenant_id=t AND z.id=ANY(e.source_ids))
  OR(o.customer_name,o.email,o.address,o.b2b_account_id) IS DISTINCT FROM(source.customer_name,source.email,source.address,source.b2b_account_id)
  OR r.source_buyer_basis_hash IS DISTINCT FROM public.buyer_address_buyer_basis(t,source.id)
  OR r.target_buyer_basis_hash IS DISTINCT FROM public.buyer_address_buyer_basis(t,o.id)
  OR r.created_at>clock_timestamp() OR r.expires_at<=clock_timestamp() OR p.expires_at<=clock_timestamp()
  THEN RAISE EXCEPTION 'Inheritance does not bind current genuine MERGE and fresh target' USING ERRCODE='23514';END IF;
 PERFORM public.order_merge_delivery209_validate_frames(e.source_ids,r.source_frames);
 SELECT value INTO f FROM jsonb_array_elements(r.source_frames) WHERE value->>'order_id'=source.id::text;
 state:=public.buyer_address_current_state(t,source.id);
 IF f IS NULL OR f->'state' IS DISTINCT FROM r.source_state OR state IS DISTINCT FROM r.source_state
  THEN RAISE EXCEPTION 'Selected source delivery differs' USING ERRCODE='40001';END IF;
 wanted:=jsonb_build_object('version','1','delivery_version',CASE WHEN state->'delivery_override_encrypted'='null'::jsonb THEN '0' ELSE '1' END,
  'enabled',false,'delivery_kind',state->>'delivery_kind','classification_origin',state->>'classification_origin',
  'delivery_override_encrypted',state->'delivery_override_encrypted','override_byte_count',state->'override_byte_count',
  'override_sha256',state->'override_sha256','last_receipt_id',r.receipt_id);
 IF r.before_state IS DISTINCT FROM jsonb_build_object('version','0','delivery_version','0','enabled',false,'delivery_kind','unknown','classification_origin','unknown',
  'delivery_override_encrypted',NULL,'override_byte_count',NULL,'override_sha256',NULL,'last_receipt_id',NULL)
  OR r.after_state IS DISTINCT FROM wanted
  OR(terminal AND public.buyer_address_current_state(t,o.id) IS DISTINCT FROM wanted)
  THEN RAISE EXCEPTION 'Target inherited state must use own versions, receipt and disabled opt-in' USING ERRCODE='23514';END IF;
 PERFORM public.order_merge_delivery209_identity(t,r.actor_id,r.api_key_id,r.credential_hash,r.actor_role,false);
 RETURN true;
END$$;

-- Narrow entry for the new kind in the historical guards. Every legacy branch
-- remains literal in the generated successor; direct state/previews DML stays private.
CREATE FUNCTION public.order_merge_delivery209_match(stage text,v jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r public.order_merge_delivery209_receipts%ROWTYPE;
BEGIN
 IF public.order_merge_delivery209_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '209 metadata changed' USING ERRCODE='55000';END IF;
 SELECT * INTO r FROM public.order_merge_delivery209_receipts WHERE tenant_id=t AND target_order_id=(v->>'order_id')::uuid
  AND CASE WHEN stage='preview' THEN preview_id=(v->>'id')::uuid ELSE receipt_id=(v->>'last_receipt_id')::uuid END;
 IF r.execution_id IS NULL THEN RAISE EXCEPTION 'No current inheritance authority' USING ERRCODE='23514';END IF;
 PERFORM public.order_merge_delivery209_validate_receipt(r.execution_id,false);
 IF stage='preview' THEN
  IF(v->>'id',v->>'reserved_receipt_id',v->>'kind',v->>'actor_id',v->>'api_key_id',v->>'token_digest',v->>'expected_order_version',v->>'buyer_basis_hash',v->>'request_hash',v->>'scope_hash',v->>'evidence_encrypted',v->>'evidence_byte_count',v->>'evidence_sha256',v->'before_state',v->'after_state',v->'changed')
   IS DISTINCT FROM(r.preview_id::text,r.receipt_id::text,'merge_inherit',r.actor_id::text,r.api_key_id::text,NULL::text,r.target_order_version::text,r.target_buyer_basis_hash,r.request_hash,r.sidecar_scope_hash,r.evidence_encrypted,r.evidence_byte_count::text,r.evidence_sha256,r.before_state,r.after_state,'true'::jsonb)
   OR(v->>'created_at')::timestamptz<>r.created_at OR(v->>'expires_at')::timestamptz<>r.expires_at
   THEN RAISE EXCEPTION 'Inherited preview differs from exact current producer' USING ERRCODE='23514';END IF;
 ELSIF stage='state' THEN
  IF((v-'tenant_id'-'order_id'-'updated_at')||jsonb_build_object('version',v->>'version','delivery_version',v->>'delivery_version')) IS DISTINCT FROM r.after_state
   OR(v->>'updated_at')::timestamptz<>r.created_at
   THEN RAISE EXCEPTION 'Inherited pointer differs from own receipt' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'Unknown inheritance guard stage' USING ERRCODE='23514';END IF;
 RETURN true;
END$$;

CREATE FUNCTION public.order_merge_delivery209_inherit(eid uuid,uid uuid,kid uuid,credential_hash text,actor_role text,evidence_encrypted text,evidence_byte_count integer,evidence_sha256 text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;e public.order_merge_executions%ROWTYPE;r public.order_merge_delivery209_receipts%ROWTYPE;
 o public.orders%ROWTYPE;s jsonb;before0 jsonb;after0 jsonb;f jsonb;pid uuid:=gen_random_uuid();rid uuid:=gen_random_uuid();stamp timestamptz;target_basis text;scope0 text;
BEGIN
 IF t IS NULL OR current_setting('role')<>'dyna_app' OR uid IS NULL OR credential_hash IS NULL OR credential_hash !~ '^[a-f0-9]{64}$'
  OR public.buyer_address_cipher_valid(evidence_encrypted,evidence_byte_count,evidence_sha256) IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'Current managed inheritance authority or authenticated evidence required' USING ERRCODE='42501';END IF;
 PERFORM public.buyer_address_available();
 PERFORM public.order_merge_delivery209_identity(t,uid,kid,credential_hash,actor_role,true);
 SELECT * INTO e FROM public.order_merge_executions WHERE(tenant_id,id)=(t,eid);
 IF e.id IS NULL OR e.merge_mode<>'technical_merge' OR(e.actor_id,e.api_key_id) IS DISTINCT FROM(uid,kid)
  OR (SELECT z.xmin::text FROM public.order_merge_executions z WHERE(z.tenant_id,z.id)=(t,e.id)) IS DISTINCT FROM mod(pg_current_xact_id()::text::numeric,4294967296)::text
  THEN RAISE EXCEPTION 'Only own current technical MERGE may inherit delivery' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.order_merge_delivery209_receipts WHERE(tenant_id,execution_id)=(t,eid))
  THEN RAISE EXCEPTION 'Inheritance is not a replay entry point; read original MERGE command' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM public.orders WHERE tenant_id=t AND id=ANY(e.source_ids) ORDER BY id FOR UPDATE;
 SELECT * INTO o FROM public.orders WHERE(tenant_id,id)=(t,e.target_order_id) FOR UPDATE;
 s:=public.buyer_address_current_state(t,e.main_order_id);before0:=public.buyer_address_current_state(t,e.target_order_id);
 IF before0->>'version'<>'0' OR EXISTS(SELECT FROM public.buyer_address_previews WHERE(tenant_id,order_id)=(t,o.id))
  OR EXISTS(SELECT FROM public.buyer_address_receipts WHERE(tenant_id,order_id)=(t,o.id))
  THEN RAISE EXCEPTION 'Target delivery has already been used' USING ERRCODE='23514';END IF;
 PERFORM public.order_merge_delivery209_validate_frames(e.source_ids,e.before_snapshot->'buyer_delivery_frames');
 SELECT value INTO f FROM jsonb_array_elements(e.before_snapshot->'buyer_delivery_frames') WHERE value->>'order_id'=e.main_order_id::text;
 stamp:=clock_timestamp();target_basis:=public.buyer_address_buyer_basis(t,o.id);
 after0:=jsonb_build_object('version','1','delivery_version',CASE WHEN s->'delivery_override_encrypted'='null'::jsonb THEN '0' ELSE '1' END,
  'enabled',false,'delivery_kind',s->>'delivery_kind','classification_origin',s->>'classification_origin',
  'delivery_override_encrypted',s->'delivery_override_encrypted','override_byte_count',s->'override_byte_count','override_sha256',s->'override_sha256','last_receipt_id',rid);
 scope0:=public.buyer_address_hash(jsonb_build_object('id',pid,'reserved_receipt_id',rid,'kind','merge_inherit','tenant_id',t,'order_id',o.id,
  'request_hash',e.request_hash,'token_digest',NULL,'actor_id',uid,'api_key_id',kid,'buyer_basis_hash',target_basis,'order_version',o.version::text,
  'before_state',before0,'after_state',after0,'evidence_sha256',evidence_sha256));
 PERFORM pg_advisory_xact_lock(hashtextextended('order.merge.proof:'||t::text,0));
 IF(SELECT count(*) FROM public.order_merge_delivery209_receipts WHERE tenant_id=t)>=2000
  OR(SELECT coalesce(sum(octet_length(to_jsonb(x)::text)),0) FROM public.order_merge_delivery209_receipts x WHERE tenant_id=t)+octet_length((e.before_snapshot->'buyer_delivery_frames')::text)+octet_length(evidence_encrypted)>134217728
  THEN RAISE EXCEPTION 'Bounded inheritance history budget exhausted' USING ERRCODE='54000';END IF;
 INSERT INTO public.order_merge_delivery209_receipts(tenant_id,execution_id,source_order_id,target_order_id,merge_preview_id,actor_id,api_key_id,credential_hash,actor_role,
  preview_id,receipt_id,scope_hash,request_hash,sidecar_scope_hash,source_frames,source_state,source_buyer_basis_hash,target_buyer_basis_hash,before_state,after_state,target_order_version,
  evidence_encrypted,evidence_byte_count,evidence_sha256,created_at,expires_at)
 VALUES(t,eid,e.main_order_id,e.target_order_id,e.preview_id,uid,kid,credential_hash,actor_role,pid,rid,e.scope_hash,e.request_hash,scope0,
  e.before_snapshot->'buyer_delivery_frames',s,f->>'buyer_basis_hash',target_basis,before0,after0,o.version,evidence_encrypted,evidence_byte_count,evidence_sha256,stamp,stamp+interval '15 minutes') RETURNING * INTO r;
 PERFORM public.order_merge_delivery209_validate_receipt(eid,false);
 INSERT INTO public.buyer_address_previews(id,tenant_id,order_id,client_key,reserved_receipt_id,kind,actor_id,api_key_id,token_digest,expected_order_version,before_state,after_state,
  buyer_basis_hash,request_hash,scope_hash,evidence_encrypted,evidence_byte_count,evidence_sha256,changed,created_at,expires_at)
 VALUES(pid,t,o.id,e.client_key,rid,'merge_inherit',uid,kid,NULL,o.version,before0,after0,target_basis,e.request_hash,scope0,evidence_encrypted,evidence_byte_count,evidence_sha256,true,stamp,r.expires_at);
 INSERT INTO public.buyer_address_receipts(id,tenant_id,order_id,preview_id,client_key,kind,actor_id,api_key_id,token_digest,request_hash,scope_hash,buyer_basis_hash,before_order_version,after_order_version,
  before_state,after_state,evidence_encrypted,evidence_byte_count,evidence_sha256,changed,created_at)
 VALUES(rid,t,o.id,pid,e.client_key,'merge_inherit',uid,kid,NULL,e.request_hash,scope0,target_basis,o.version,o.version,before0,after0,evidence_encrypted,evidence_byte_count,evidence_sha256,true,stamp);
 INSERT INTO public.buyer_address_state(tenant_id,order_id,version,delivery_version,enabled,delivery_kind,classification_origin,delivery_override_encrypted,override_byte_count,override_sha256,last_receipt_id,updated_at)
 VALUES(t,o.id,1,(after0->>'delivery_version')::bigint,false,after0->>'delivery_kind',after0->>'classification_origin',after0->>'delivery_override_encrypted',
  (after0->>'override_byte_count')::integer,after0->>'override_sha256',rid,stamp);
 PERFORM public.order_merge_delivery209_validate_receipt(eid,true);
 PERFORM public.order_merge_delivery209_identity(t,uid,kid,credential_hash,actor_role,false);
 RETURN jsonb_build_object('receipt_id',rid,'preview_id',pid,'target_order_id',o.id,'before_state',before0,'after_state',after0,
  'source_order_id',e.main_order_id,'source_state',s,'source_buyer_basis_hash',f->>'buyer_basis_hash');
END$$;

CREATE FUNCTION public.order_merge_delivery209_complete() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_TABLE_NAME='order_merge_executions' THEN
  PERFORM public.order_merge_delivery209_validate_frames(NEW.source_ids,NEW.before_snapshot->'buyer_delivery_frames');
  IF NEW.merge_mode='technical_merge' THEN PERFORM public.order_merge_delivery209_validate_receipt(NEW.id,true);END IF;
 ELSE PERFORM public.order_merge_delivery209_validate_receipt(NEW.execution_id,true);END IF;
 RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER order_merge_delivery209_complete AFTER INSERT ON public.order_merge_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.order_merge_delivery209_complete();
CREATE CONSTRAINT TRIGGER order_merge_delivery209_receipt_complete AFTER INSERT ON public.order_merge_delivery209_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.order_merge_delivery209_complete();

-- New routines default to owner-only, regardless of inherited default grants.
DO $acl209$ DECLARE f record;g record;BEGIN
 FOR f IN SELECT p.oid::regprocedure signature,p.proowner,p.proacl FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'order_merge_delivery209_') LOOP
  FOR g IN SELECT DISTINCT grantee FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) WHERE grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',f.signature,CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);
  END LOOP;
 END LOOP;
END$acl209$;
GRANT EXECUTE ON FUNCTION public.order_merge_delivery209_inherit(uuid,uuid,uuid,text,text,text,integer,text) TO dyna_app;
