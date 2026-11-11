-- PARTIAL SOURCE PROTOTYPE. NOT_APPLY_READY: required187/198 cold/vector/compiler/Startup recertification is not included.
-- Historical44/native06/07/09 and their ACLs stay literal. Two owner-only release endpoints only.
-- No known-close/absent bridge, no public admission, no migration marker/approval, no claim of actual197 error locus.
ALTER TABLE ordinary187_private.contexts ADD COLUMN keeper_call jsonb;
ALTER TABLE ordinary187_private.contexts ADD CONSTRAINT ordinary198_context_marker_shape CHECK(
 keeper_call IS NULL OR (jsonb_typeof(keeper_call)='object' AND octet_length(keeper_call::text)<=512));

CREATE FUNCTION ordinary187_private.context_bound198() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,ordinary187_private SET TimeZone='UTC' AS $bound198$
BEGIN
 -- Actual whole tuple includes the marker and every inherited column; JSON length alone is insufficient.
 IF pg_column_size(NEW)>1024 THEN RAISE EXCEPTION '198 context exceeds preallocated1024' USING ERRCODE='54000';END IF;
 IF TG_OP='UPDATE' AND to_jsonb(NEW)-'keeper_call' IS DISTINCT FROM to_jsonb(OLD)-'keeper_call' THEN RAISE EXCEPTION '198 marker cannot replace context authority' USING ERRCODE='42501';END IF;
 IF NEW.keeper_call IS NOT NULL AND (jsonb_typeof(NEW.keeper_call) IS DISTINCT FROM 'object' OR octet_length(NEW.keeper_call::text)>512
 OR (SELECT array_agg(k198.value ORDER BY k198.value) FROM jsonb_object_keys(NEW.keeper_call) AS k198(value)) IS DISTINCT FROM ARRAY['a','c','k','q','s','t','w']::text[]
 OR EXISTS(SELECT FROM jsonb_each(NEW.keeper_call) e198 WHERE e198.key<>'s' AND jsonb_typeof(e198.value) IS DISTINCT FROM 'string')
 OR NEW.keeper_call->>'a' IS NULL OR NEW.keeper_call->>'a' NOT IN('u','b','c','d','z') OR NEW.keeper_call->>'t' IS NULL OR NEW.keeper_call->>'t' NOT IN('unused-quarantine','released-lock','known-close','absent-prefix')
 OR NEW.keeper_call->>'w' IS NULL OR NEW.keeper_call->>'w' !~ '^[a-f0-9]{64}$' OR NEW.keeper_call->>'k' IS NULL OR length(NEW.keeper_call->>'k')>100
 OR (NEW.keeper_call->>'a' IN('u','b') AND NEW.keeper_call->>'k' !~ '^blob:fs:(blobs|uploads|witnesses):[a-f0-9-]{36}:(quarantine-json|lock:[a-f0-9-]{36})$')
 OR (NEW.keeper_call->>'a' IN('c','d','z') AND (NEW.keeper_call->>'t' IS DISTINCT FROM (CASE WHEN NEW.keeper_call->>'a'='z' THEN 'absent-prefix' ELSE 'known-close' END) OR NEW.keeper_call->>'k' IS DISTINCT FROM 'event:'||(CASE NEW.keeper_call->>'a' WHEN 'c' THEN 'upload-known-close:' WHEN 'd' THEN 'business-known-close:' ELSE 'upload-absent-close:' END)||(NEW.keeper_call->>'c')))
 OR (NEW.keeper_call->>'a' IN('u','b') AND NEW.keeper_call->>'t' NOT IN('unused-quarantine','released-lock'))
 OR (NEW.keeper_call->>'t'='unused-quarantine' AND (NEW.keeper_call->>'a'<>'u' OR NEW.keeper_call->>'k' !~ '^blob:fs:blobs:[a-f0-9-]{36}:quarantine-json$'))
 OR (NEW.keeper_call->>'t'='released-lock' AND NEW.keeper_call->>'k' !~ '^blob:fs:(blobs|uploads|witnesses):[a-f0-9-]{36}:lock:[a-f0-9-]{36}$')
 OR (NEW.keeper_call->>'a'='b' AND (NEW.keeper_call->>'t'<>'released-lock' OR NEW.keeper_call->>'k' !~ '^blob:fs:witnesses:[a-f0-9-]{36}:lock:[a-f0-9-]{36}$'))
 OR (NEW.keeper_call->>'q')::uuid IS NULL OR (NEW.keeper_call->>'c')::uuid IS NULL
 OR jsonb_typeof(NEW.keeper_call->'s') IS DISTINCT FROM 'number' OR (NEW.keeper_call->>'s')::integer NOT BETWEEN 0 AND 127
 OR (NEW.keeper_call->>'a' IN('u','b') AND (NEW.keeper_call->>'s')::integer>31)
 OR (NEW.keeper_call->>'a' IN('c','d') AND (NEW.keeper_call->>'s')::integer>3)) THEN
  RAISE EXCEPTION '198 exact marker field shape' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $bound198$;
REVOKE ALL ON FUNCTION ordinary187_private.context_bound198() FROM PUBLIC,dyna_app;
CREATE TRIGGER ordinary198_context_bound BEFORE INSERT OR UPDATE ON ordinary187_private.contexts FOR EACH ROW EXECUTE FUNCTION ordinary187_private.context_bound198();

CREATE FUNCTION ordinary187_private.keeper_context198() RETURNS ordinary187_private.contexts
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,ordinary187_private SET TimeZone='UTC' AS $context198$
DECLARE x ordinary187_private.contexts%ROWTYPE;e ordinary187_private.journal%ROWTYPE;o ordinary187_private.journal%ROWTYPE;m ordinary187_private.journal%ROWTYPE;s timestamptz;
BEGIN
 PERFORM public.ordinary187_owner_context();
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION '198 keeper exact worker isolation' USING ERRCODE='25000';END IF;
 SELECT backend_start INTO STRICT s FROM pg_stat_activity WHERE pid=pg_backend_pid() AND datname=current_database() AND usename='postgres';
 SELECT * INTO STRICT x FROM ordinary187_private.contexts WHERE(backend_pid,backend_start,xid)=(pg_backend_pid(),s,pg_current_xact_id());
 IF x.mode<>'terminal' OR nullif(current_setting('app.tenant_id',true),'')::uuid IS DISTINCT FROM x.tenant_id THEN RAISE EXCEPTION '198 same terminal context tenant' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT e FROM ordinary187_private.journal WHERE(root_key,epoch,kind)=(x.root_key,x.epoch,'epoch') FOR SHARE;
 SELECT * INTO STRICT o FROM ordinary187_private.journal WHERE(root_key,epoch,id,kind)=(x.root_key,x.epoch,x.original_id,'original');
 SELECT * INTO STRICT m FROM ordinary187_private.journal WHERE(root_key,epoch,id,kind)=(x.root_key,x.epoch,x.member_id,'member');
 -- Healthy original only in this first prototype. POISONED/revoked cleanup remains unavailable, not invented authority.
 IF e.payload_text::jsonb->>'state'<>'OPEN' OR o.payload_text::jsonb->>'state'<>'OPEN'
 OR (o.tenant_id,o.actor_id,o.api_key_id) IS DISTINCT FROM (x.tenant_id,x.actor_id,x.api_key_id)
 OR (m.tenant_id,m.actor_id,m.api_key_id) IS DISTINCT FROM (x.tenant_id,x.actor_id,x.api_key_id)
 OR m.payload_text::jsonb->>'state'<>'ACTIVE' OR m.payload_text::jsonb->>'mode'<>'terminal'
 OR (m.payload_text::jsonb->>'original_id')::uuid IS DISTINCT FROM x.original_id
 OR (m.payload_text::jsonb->>'backend_pid')::integer IS DISTINCT FROM x.backend_pid
 OR (m.payload_text::jsonb->>'backend_start')::timestamptz IS DISTINCT FROM x.backend_start
 OR (m.payload_text::jsonb->>'xid')::xid8 IS DISTINCT FROM x.xid
 OR pg_xact_status(x.xid) IS DISTINCT FROM 'in progress'
 OR NOT EXISTS(SELECT FROM pg_stat_activity p WHERE p.pid=(o.payload_text::jsonb->>'parent_pid')::integer AND p.backend_start=(o.payload_text::jsonb->>'parent_start')::timestamptz AND p.datname=current_database() AND p.usename='postgres') THEN
  RAISE EXCEPTION '198 genuine current original member only' USING ERRCODE='42501';
 END IF;
 RETURN x;
END $context198$;
REVOKE ALL ON FUNCTION ordinary187_private.keeper_context198() FROM PUBLIC,dyna_app;

CREATE FUNCTION ordinary187_private.keeper_release_effect198(table0 text,op0 text,old0 jsonb,new0 jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,ordinary187_private SET TimeZone='UTC' AS $effect198$
DECLARE x ordinary187_private.contexts%ROWTYPE;p jsonb;r public.large_import_quota_resources173%ROWTYPE;receipt0 public.large_import_quota_terminal_receipts173%ROWTYPE;b jsonb;bit0 integer;seen0 integer;
BEGIN
 IF pg_trigger_depth()<>1 THEN RAISE EXCEPTION '198 actual resource trigger only' USING ERRCODE='42501';END IF;
 x:=ordinary187_private.keeper_context198();p:=x.keeper_call;
 IF p IS NULL OR op0 NOT IN('INSERT','UPDATE') OR new0 IS NULL OR (new0->>'tenant_id')::uuid IS DISTINCT FROM x.tenant_id
 OR (new0->>'reservation_id')::uuid IS DISTINCT FROM (p->>'q')::uuid THEN RAISE EXCEPTION '198 exact marked release row' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT r FROM public.large_import_quota_resources173 WHERE tenant_id=x.tenant_id AND reservation_id=(p->>'q')::uuid AND resource_key=p->>'k';
 IF NOT EXISTS(SELECT FROM public.large_import_quota_reservations173 q198 WHERE q198.tenant_id=x.tenant_id AND q198.id=(p->>'q')::uuid AND q198.actor_id=x.actor_id AND q198.api_key_id IS NOT DISTINCT FROM x.api_key_id AND q198.kind=(CASE WHEN p->>'a'='u' THEN 'upload' ELSE q198.kind END) AND (p->>'a'='u' OR q198.kind IN('job','review')) AND q198.state IN('open','unknown')) THEN RAISE EXCEPTION '198 exact reservation principal kind state' USING ERRCODE='42501';END IF;
 seen0:=(p->>'s')::integer;
 IF table0='large_import_quota_terminal_witnesses173' AND op0='INSERT' THEN
  bit0:=1;
  IF new0->>'resource_key' IS DISTINCT FROM p->>'k' OR (new0->>'client_key')::uuid IS DISTINCT FROM (p->>'c')::uuid OR new0->>'classification' IS DISTINCT FROM p->>'t'
  OR new0->>'original_state' IS DISTINCT FROM r.state OR new0->>'original_sha256' IS DISTINCT FROM r.sha256 OR (new0->>'original_bytes')::bigint IS DISTINCT FROM r.byte_count
  OR new0->>'witness_sha256' IS DISTINCT FROM p->>'w' OR encode(sha256(convert_to(new0->>'witness_text','UTF8')),'hex') IS DISTINCT FROM p->>'w' THEN RAISE EXCEPTION '198 exact native witness' USING ERRCODE='23514';END IF;
 ELSIF table0='large_import_quota_terminal_receipts173' AND op0='INSERT' THEN
  bit0:=2;b:=(new0->>'receipt_text')::jsonb;
  IF (seen0&1)<>1 OR new0->>'resource_key' IS DISTINCT FROM p->>'k' OR (new0->>'client_key')::uuid IS DISTINCT FROM (p->>'c')::uuid
  OR encode(sha256(convert_to(new0->>'receipt_text','UTF8')),'hex') IS DISTINCT FROM new0->>'receipt_sha256'
  OR jsonb_typeof(b) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(b))<>11 OR b->>'schema' IS DISTINCT FROM 'quota-terminal-receipt/v1'
  OR (b->>'tenant_id')::uuid IS DISTINCT FROM x.tenant_id OR (b->>'reservation_id')::uuid IS DISTINCT FROM (p->>'q')::uuid OR b->>'resource_key' IS DISTINCT FROM p->>'k'
  OR (b->>'client_key')::uuid IS DISTINCT FROM (p->>'c')::uuid OR b->>'classification' IS DISTINCT FROM p->>'t' OR b->>'old_state' IS DISTINCT FROM r.state
  OR b->>'original_sha256' IS DISTINCT FROM r.sha256 OR (b->>'original_bytes')::bigint IS DISTINCT FROM r.byte_count OR b->>'witness_sha256' IS DISTINCT FROM p->>'w'
  OR b->>'native_time' IS NULL OR NOT isfinite((b->>'native_time')::timestamptz) OR (b->>'native_time')::timestamptz NOT BETWEEN transaction_timestamp() AND clock_timestamp() THEN RAISE EXCEPTION '198 exact native receipt' USING ERRCODE='23514';END IF;
 ELSIF table0='large_import_quota_resources173' AND op0='INSERT' THEN
  IF (seen0&3)<>3 OR new0->>'kind'<>'event' OR new0->>'state'<>'settled' OR (new0->>'byte_count')::bigint IS DISTINCT FROM octet_length(new0->>'payload_text') OR new0->>'sha256' IS DISTINCT FROM encode(sha256(convert_to(new0->>'payload_text','UTF8')),'hex') THEN RAISE EXCEPTION '198 exact native release evidence bytes' USING ERRCODE='23514';END IF;
  IF new0->>'resource_key'='event:quota-terminal-witness:'||(p->>'c') THEN bit0:=4;IF new0->>'sha256' IS DISTINCT FROM p->>'w' THEN RAISE EXCEPTION '198 witness event hash' USING ERRCODE='23514';END IF;
  ELSIF new0->>'resource_key'='event:quota-terminal-receipt:'||(p->>'c') THEN bit0:=8;SELECT * INTO STRICT receipt0 FROM public.large_import_quota_terminal_receipts173 WHERE tenant_id=x.tenant_id AND reservation_id=(p->>'q')::uuid AND resource_key=p->>'k';IF new0->>'payload_text' IS DISTINCT FROM receipt0.receipt_text OR new0->>'sha256' IS DISTINCT FROM receipt0.receipt_sha256 OR receipt0.client_key IS DISTINCT FROM (p->>'c')::uuid THEN RAISE EXCEPTION '198 saved receipt event' USING ERRCODE='23514';END IF;
  ELSE RAISE EXCEPTION '198 unrelated event refused' USING ERRCODE='42501';END IF;
 ELSIF table0='large_import_quota_resources173' AND op0='UPDATE' THEN
  bit0:=16;
  IF (seen0&15)<>15 OR old0 IS NULL OR old0->>'resource_key' IS DISTINCT FROM p->>'k' OR new0-'state' IS DISTINCT FROM old0-'state' OR new0->>'state'<>'released'
  OR old0->>'kind'<>'blob' OR old0->>'state' NOT IN('intent','settled') OR (p->>'t'='unused-quarantine' AND old0->>'state'<>'intent') THEN RAISE EXCEPTION '198 exact marked unused lock release' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION '198 unrelated keeper effect refused' USING ERRCODE='42501';END IF;
 IF (seen0&bit0)<>0 THEN RAISE EXCEPTION '198 keeper effect cannot repeat' USING ERRCODE='23505';END IF;
 UPDATE ordinary187_private.contexts SET keeper_call=jsonb_set(p,'{s}',to_jsonb(seen0|bit0)) WHERE(backend_pid,backend_start,xid,root_key,epoch,original_id,member_id)=(x.backend_pid,x.backend_start,x.xid,x.root_key,x.epoch,x.original_id,x.member_id);
END $effect198$;
REVOKE ALL ON FUNCTION ordinary187_private.keeper_release_effect198(text,text,jsonb,jsonb) FROM PUBLIC,dyna_app;

-- The two fixed wrappers below are emitted from Source-owned templates. There is no generic marker-mint API.

CREATE FUNCTION public.ordinary198_upload_release_finish(u uuid,t uuid,k uuid,r text,h text,q uuid,token text,key0 text,client0 uuid,witness0 text,classification0 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,ordinary187_private SET TimeZone='UTC' AS $wrapper198u$
DECLARE x ordinary187_private.contexts%ROWTYPE;fact jsonb;value0 jsonb;io_count integer;io0 ordinary187_private.journal%ROWTYPE;p jsonb;
BEGIN
 -- Existing real current IAM/owner NONE is the FIRST native admit; no GUC/receipt/Actor tuple substitutes it.
 PERFORM public.large_import_quota_keeper_admit173(u,t,k,r,h,true);
 x:=ordinary187_private.keeper_context198();
 IF (x.tenant_id,x.actor_id,x.api_key_id) IS DISTINCT FROM (t,u,k) OR x.keeper_call IS NOT NULL OR client0 IS NULL THEN RAISE EXCEPTION '198 exact current keeper principal once' USING ERRCODE='42501';END IF;
 fact:=public.large_import_quota_terminal_begin173(u,t,k,r,h,q,token,key0,client0);
 IF fact->'reused'='true'::jsonb THEN RETURN fact;END IF; -- Native replay is lookup-only, no marker/new evidence/credit.
 IF classification0 IS DISTINCT FROM fact->>'classification' OR classification0 NOT IN('unused-quarantine','released-lock') OR witness0 IS NULL OR octet_length(witness0)>8388608 THEN RAISE EXCEPTION '198 exact native release classification' USING ERRCODE='23514';END IF;
 -- Already-armed original IO is a dependency, not new IO ARM under held quota locks. Unique lock/quarantine key.
 SELECT count(*) INTO io_count FROM ordinary187_private.journal j WHERE j.root_key=x.root_key AND j.epoch<=x.epoch AND j.kind='io' AND(j.tenant_id,j.actor_id,j.api_key_id) IS NOT DISTINCT FROM (t,u,k)
 AND (j.payload_text::jsonb->>'reservation_id')::uuid=q AND EXISTS(SELECT FROM jsonb_array_elements(j.payload_text::jsonb->'resources') v WHERE v->>'key'=key0 AND v->>'kind'=fact->'resource'->>'kind' AND (v->>'byte_count')::bigint=(fact->'resource'->>'byte_count')::bigint AND v->>'sha256'=fact->'resource'->>'sha256');
 IF io_count<>1 THEN RAISE EXCEPTION '198 unique genuine IO resource required' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT io0 FROM ordinary187_private.journal j WHERE j.root_key=x.root_key AND j.epoch<=x.epoch AND j.kind='io' AND(j.tenant_id,j.actor_id,j.api_key_id) IS NOT DISTINCT FROM (t,u,k)
 AND (j.payload_text::jsonb->>'reservation_id')::uuid=q AND EXISTS(SELECT FROM jsonb_array_elements(j.payload_text::jsonb->'resources') v WHERE v->>'key'=key0 AND v->>'kind'=fact->'resource'->>'kind' AND (v->>'byte_count')::bigint=(fact->'resource'->>'byte_count')::bigint AND v->>'sha256'=fact->'resource'->>'sha256');
 IF io0.payload_text::jsonb->>'state' NOT IN('ARMED','DRAINED') OR(io0.payload_text::jsonb->>'state'='ARMED' AND (io0.epoch<>x.epoch OR (io0.payload_text::jsonb->>'original_id')::uuid IS DISTINCT FROM x.original_id)) THEN RAISE EXCEPTION '198 foreign in-flight IO refuses terminal mutation' USING ERRCODE='42501';END IF;
 p:=jsonb_build_object('a','u','q',q,'k',key0,'c',client0,'t',classification0,'w',encode(sha256(convert_to(witness0,'UTF8')),'hex'),'s',0);
 UPDATE ordinary187_private.contexts SET keeper_call=p WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 value0:=public.large_import_quota_terminal_finish173(u,t,k,r,h,q,token,key0,client0,witness0,classification0);
 SELECT keeper_call INTO STRICT p FROM ordinary187_private.contexts WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 IF (p->>'s')::integer<>31 OR value0->'reused' IS DISTINCT FROM 'false'::jsonb OR value0->'receipt'->>'client_key' IS DISTINCT FROM client0::text THEN RAISE EXCEPTION '198 complete exact native release effect required' USING ERRCODE='23514';END IF;
 UPDATE ordinary187_private.contexts SET keeper_call=NULL WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 RETURN value0;
END $wrapper198u$;
REVOKE ALL ON FUNCTION public.ordinary198_upload_release_finish(uuid,uuid,uuid,text,text,uuid,text,text,uuid,text,text) FROM PUBLIC,dyna_app;

CREATE FUNCTION public.ordinary198_owned_release_finish(u uuid,t uuid,k uuid,r text,h text,q uuid,token text,key0 text,client0 uuid,witness0 text,classification0 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,ordinary187_private SET TimeZone='UTC' AS $wrapper198b$
DECLARE x ordinary187_private.contexts%ROWTYPE;fact jsonb;value0 jsonb;io_count integer;io0 ordinary187_private.journal%ROWTYPE;p jsonb;
BEGIN
 -- Existing real current IAM/owner NONE is the FIRST native admit; no GUC/receipt/Actor tuple substitutes it.
 PERFORM public.large_import_quota_keeper_admit173(u,t,k,r,h,true);
 x:=ordinary187_private.keeper_context198();
 IF (x.tenant_id,x.actor_id,x.api_key_id) IS DISTINCT FROM (t,u,k) OR x.keeper_call IS NOT NULL OR client0 IS NULL THEN RAISE EXCEPTION '198 exact current keeper principal once' USING ERRCODE='42501';END IF;
 fact:=public.large_import_quota_owned_release_begin173(u,t,k,r,h,q,token,key0,client0);
 IF fact->'reused'='true'::jsonb THEN RETURN fact;END IF; -- Native replay is lookup-only, no marker/new evidence/credit.
 IF classification0 IS DISTINCT FROM fact->>'classification' OR classification0 NOT IN('unused-quarantine','released-lock') OR witness0 IS NULL OR octet_length(witness0)>8388608 THEN RAISE EXCEPTION '198 exact native release classification' USING ERRCODE='23514';END IF;
 -- Already-armed original IO is a dependency, not new IO ARM under held quota locks. Unique lock/quarantine key.
 SELECT count(*) INTO io_count FROM ordinary187_private.journal j WHERE j.root_key=x.root_key AND j.epoch<=x.epoch AND j.kind='io' AND(j.tenant_id,j.actor_id,j.api_key_id) IS NOT DISTINCT FROM (t,u,k)
 AND (j.payload_text::jsonb->>'reservation_id')::uuid=q AND EXISTS(SELECT FROM jsonb_array_elements(j.payload_text::jsonb->'resources') v WHERE v->>'key'=key0 AND v->>'kind'=fact->'resource'->>'kind' AND (v->>'byte_count')::bigint=(fact->'resource'->>'byte_count')::bigint AND v->>'sha256'=fact->'resource'->>'sha256');
 IF io_count<>1 THEN RAISE EXCEPTION '198 unique genuine IO resource required' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT io0 FROM ordinary187_private.journal j WHERE j.root_key=x.root_key AND j.epoch<=x.epoch AND j.kind='io' AND(j.tenant_id,j.actor_id,j.api_key_id) IS NOT DISTINCT FROM (t,u,k)
 AND (j.payload_text::jsonb->>'reservation_id')::uuid=q AND EXISTS(SELECT FROM jsonb_array_elements(j.payload_text::jsonb->'resources') v WHERE v->>'key'=key0 AND v->>'kind'=fact->'resource'->>'kind' AND (v->>'byte_count')::bigint=(fact->'resource'->>'byte_count')::bigint AND v->>'sha256'=fact->'resource'->>'sha256');
 IF io0.payload_text::jsonb->>'state' NOT IN('ARMED','DRAINED') OR(io0.payload_text::jsonb->>'state'='ARMED' AND (io0.epoch<>x.epoch OR (io0.payload_text::jsonb->>'original_id')::uuid IS DISTINCT FROM x.original_id)) THEN RAISE EXCEPTION '198 foreign in-flight IO refuses terminal mutation' USING ERRCODE='42501';END IF;
 p:=jsonb_build_object('a','b','q',q,'k',key0,'c',client0,'t',classification0,'w',encode(sha256(convert_to(witness0,'UTF8')),'hex'),'s',0);
 UPDATE ordinary187_private.contexts SET keeper_call=p WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 value0:=public.large_import_quota_owned_release_finish173(u,t,k,r,h,q,token,key0,client0,witness0,classification0);
 SELECT keeper_call INTO STRICT p FROM ordinary187_private.contexts WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 IF (p->>'s')::integer<>31 OR value0->'reused' IS DISTINCT FROM 'false'::jsonb OR value0->'receipt'->>'client_key' IS DISTINCT FROM client0::text THEN RAISE EXCEPTION '198 complete exact native release effect required' USING ERRCODE='23514';END IF;
 UPDATE ordinary187_private.contexts SET keeper_call=NULL WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 RETURN value0;
END $wrapper198b$;
REVOKE ALL ON FUNCTION public.ordinary198_owned_release_finish(uuid,uuid,uuid,text,text,uuid,text,text,uuid,text,text) FROM PUBLIC,dyna_app;

-- SOURCE-only three fixed close effects. Fold into fresh198 migration after release prototype, not repeat CREATE on partial DB.
CREATE FUNCTION ordinary187_private.keeper_close_effect198(table0 text,op0 text,old0 jsonb,new0 jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,ordinary187_private SET TimeZone='UTC' AS $closeeffect198$
DECLARE x ordinary187_private.contexts%ROWTYPE;p jsonb;q198 public.large_import_quota_reservations173%ROWTYPE;b jsonb;receipt0 jsonb;bit0 integer;seen0 integer;prefix0 text;paths0 text[];path0 text;position0 integer;
BEGIN
 IF pg_trigger_depth()<>1 THEN RAISE EXCEPTION '198 actual close resource trigger only' USING ERRCODE='42501';END IF;
 x:=ordinary187_private.keeper_context198();p:=x.keeper_call;
 IF p IS NULL OR p->>'a' NOT IN('c','d','z') OR op0 NOT IN('INSERT','UPDATE') OR new0 IS NULL OR (new0->>'tenant_id')::uuid IS DISTINCT FROM x.tenant_id THEN RAISE EXCEPTION '198 exact marked close row' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT q198 FROM public.large_import_quota_reservations173 WHERE tenant_id=x.tenant_id AND id=(p->>'q')::uuid;
 IF (q198.actor_id,q198.api_key_id) IS DISTINCT FROM (x.actor_id,x.api_key_id)
 OR (p->>'a' IN('c','z') AND q198.kind<>'upload') OR (p->>'a'='d' AND q198.kind NOT IN('job','review')) THEN RAISE EXCEPTION '198 exact close reservation principal kind' USING ERRCODE='42501';END IF;
 seen0:=(p->>'s')::integer;
 IF table0='large_import_quota_resources173' AND op0='INSERT' THEN
  bit0:=1;b:=(new0->>'payload_text')::jsonb;receipt0:=b->'receipt';
  IF seen0<>0 OR (new0->>'reservation_id')::uuid IS DISTINCT FROM q198.id OR new0->>'resource_key' IS DISTINCT FROM p->>'k'
  OR new0->>'kind' IS DISTINCT FROM 'event' OR new0->>'state' IS DISTINCT FROM 'settled'
  OR (new0->>'byte_count')::bigint IS DISTINCT FROM octet_length(new0->>'payload_text') OR new0->>'sha256' IS DISTINCT FROM encode(sha256(convert_to(new0->>'payload_text','UTF8')),'hex')
  OR jsonb_typeof(b) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(b))<>3
  OR b->>'schema' IS DISTINCT FROM (CASE WHEN p->>'a'='z' THEN 'quota-absent-close-evidence/v1' ELSE 'quota-known-close-evidence/v1' END)
  OR encode(sha256(convert_to(b->>'inventory_text','UTF8')),'hex') IS DISTINCT FROM p->>'w'
  OR jsonb_typeof(receipt0) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(receipt0))<>(CASE WHEN p->>'a'='z' THEN 8 ELSE 7 END)
  OR receipt0->>'schema' IS DISTINCT FROM (CASE WHEN p->>'a'='z' THEN 'quota-absent-close-receipt/v1' ELSE 'quota-known-close-receipt/v1' END)
  OR (receipt0->>'tenant_id')::uuid IS DISTINCT FROM x.tenant_id OR (receipt0->>'reservation_id')::uuid IS DISTINCT FROM q198.id OR (receipt0->>'request_id')::uuid IS DISTINCT FROM q198.request_id
  OR (receipt0->>'client_key')::uuid IS DISTINCT FROM (p->>'c')::uuid OR receipt0->>'inventory_sha256' IS DISTINCT FROM p->>'w'
  OR (p->>'a'='z' AND receipt0->>'released_directory_count' IS DISTINCT FROM '5')
  OR receipt0->>'native_time' IS NULL OR NOT isfinite((receipt0->>'native_time')::timestamptz) OR (receipt0->>'native_time')::timestamptz NOT BETWEEN transaction_timestamp() AND clock_timestamp() THEN RAISE EXCEPTION '198 exact native close evidence' USING ERRCODE='23514';END IF;
 ELSIF table0='large_import_quota_resources173' AND op0='UPDATE' AND p->>'a'='z' THEN
  IF (seen0&1)<>1 OR old0 IS NULL OR (old0->>'reservation_id')::uuid IS DISTINCT FROM q198.id OR old0->>'kind' IS DISTINCT FROM 'blob' OR old0->>'state' IS DISTINCT FROM 'intent'
  OR new0->>'state' IS DISTINCT FROM 'released' OR new0-'state' IS DISTINCT FROM old0-'state' OR q198.state<>'unknown' THEN RAISE EXCEPTION '198 exact absent directory release' USING ERRCODE='23514';END IF;
  prefix0:=x.tenant_id::text||'/'||x.actor_id::text||'/'||CASE WHEN x.api_key_id IS NULL THEN 'sessions' ELSE 'key-'||x.api_key_id::text END;
  paths0:=ARRAY[x.tenant_id::text,x.tenant_id::text||'/'||x.actor_id::text,prefix0,prefix0||'/uploads',prefix0||'/uploads/'||q198.request_id::text];path0:=(old0->>'payload_text')::jsonb->>'path';position0:=array_position(paths0,path0);
  IF position0 IS NULL OR (old0->>'payload_text')::jsonb IS DISTINCT FROM jsonb_build_object('schema','private-directory-allocation/v1','path',path0,'mode',448)
  OR old0->>'resource_key' IS DISTINCT FROM 'blob:fs:directory:'||encode(sha256(convert_to(path0,'UTF8')),'hex') OR (old0->>'byte_count')::bigint IS DISTINCT FROM octet_length(old0->>'payload_text') OR old0->>'sha256' IS DISTINCT FROM encode(sha256(convert_to(old0->>'payload_text','UTF8')),'hex') THEN RAISE EXCEPTION '198 only original five directories' USING ERRCODE='23514';END IF;
  bit0:=1<<position0;
 ELSIF table0='large_import_quota_reservations173' AND op0='UPDATE' THEN
  bit0:=CASE WHEN p->>'a'='z' THEN 64 ELSE 2 END;
  IF seen0<>(CASE WHEN p->>'a'='z' THEN 63 ELSE 1 END) OR old0 IS NULL OR (old0->>'id')::uuid IS DISTINCT FROM q198.id OR (new0->>'id')::uuid IS DISTINCT FROM q198.id
  OR old0->>'state' NOT IN('open','unknown') OR (p->>'a'='z' AND old0->>'state'<>'unknown') OR new0->>'state' IS DISTINCT FROM 'retained'
  OR new0->>'outcome' IS DISTINCT FROM (CASE WHEN p->>'a'='z' THEN 'absent' ELSE 'ready' END)
  OR new0-ARRAY['state','outcome','raw_charge','metadata_charge','objects_charge','closed_at','inventory_sha256']::text[] IS DISTINCT FROM old0-ARRAY['state','outcome','raw_charge','metadata_charge','objects_charge','closed_at','inventory_sha256']::text[]
  OR (new0->>'raw_charge')::bigint NOT BETWEEN 0 AND (old0->>'raw_ceiling')::bigint OR (new0->>'metadata_charge')::bigint NOT BETWEEN 0 AND (old0->>'metadata_ceiling')::bigint OR (new0->>'objects_charge')::bigint NOT BETWEEN 0 AND (old0->>'objects_ceiling')::bigint
  OR new0->>'closed_at' IS NULL OR new0->>'inventory_sha256' IS DISTINCT FROM p->>'w' OR (p->>'a'='z' AND ((new0->>'raw_charge')::bigint<>0 OR (new0->>'objects_charge')::bigint<>2)) THEN RAISE EXCEPTION '198 exact original capacity close' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION '198 unrelated close effect refused' USING ERRCODE='42501';END IF;
 IF (seen0&bit0)<>0 THEN RAISE EXCEPTION '198 close effect cannot repeat' USING ERRCODE='23505';END IF;
 UPDATE ordinary187_private.contexts SET keeper_call=jsonb_set(p,'{s}',to_jsonb(seen0|bit0)) WHERE(backend_pid,backend_start,xid,root_key,epoch,original_id,member_id)=(x.backend_pid,x.backend_start,x.xid,x.root_key,x.epoch,x.original_id,x.member_id);
END $closeeffect198$;
REVOKE ALL ON FUNCTION ordinary187_private.keeper_close_effect198(text,text,jsonb,jsonb) FROM PUBLIC,dyna_app;

CREATE OR REPLACE FUNCTION public.ordinary187_resource_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,ordinary187_private SET TimeZone='UTC' AS $guard187$
DECLARE x ordinary187_private.contexts%ROWTYPE;e ordinary187_private.journal%ROWTYPE;row0 jsonb;old0 jsonb;new0 jsonb;
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION '187 original evidence cannot truncate' USING ERRCODE='42501';END IF;
 IF session_user<>'postgres' OR current_setting('role',true) NOT IN('none','dyna_app') OR current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION '187 original app-role transport' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT x FROM ordinary187_private.contexts WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id();
 SELECT * INTO STRICT e FROM ordinary187_private.journal WHERE root_key=x.root_key AND epoch=x.epoch AND kind='epoch' FOR SHARE;
 IF current_setting('role',true)='none' THEN
  IF x.keeper_call->>'a' IN('c','d','z') THEN
   PERFORM ordinary187_private.keeper_close_effect198(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP IN('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END,CASE WHEN TG_OP IN('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END);
  ELSE
  PERFORM ordinary187_private.keeper_release_effect198(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP IN('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END,CASE WHEN TG_OP IN('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END);
  END IF;
  RETURN NEW;
 END IF;
 row0:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF (row0->>'tenant_id')::uuid IS DISTINCT FROM x.tenant_id OR nullif(current_setting('app.tenant_id',true),'')::uuid IS DISTINCT FROM x.tenant_id THEN RAISE EXCEPTION '187 exact resource tenant' USING ERRCODE='42501';END IF;
 IF row0 ? 'actor_id' AND ((row0->>'actor_id')::uuid IS DISTINCT FROM x.actor_id OR (row0->>'api_key_id')::uuid IS DISTINCT FROM x.api_key_id) THEN RAISE EXCEPTION '187 exact resource principal' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME IN('large_import_parts173','large_import_batches173') AND NOT EXISTS(SELECT FROM public.large_import_blobs173 b187 WHERE b187.tenant_id=x.tenant_id AND b187.id=(row0->>'blob_id')::uuid AND b187.actor_id=x.actor_id AND b187.api_key_id IS NOT DISTINCT FROM x.api_key_id) THEN RAISE EXCEPTION '187 exact blob parent principal' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='large_import_events173' AND NOT EXISTS(SELECT FROM public.large_import_jobs173 j187 WHERE j187.tenant_id=x.tenant_id AND j187.id=(row0->>'job_id')::uuid AND j187.actor_id=x.actor_id AND j187.api_key_id IS NOT DISTINCT FROM x.api_key_id) THEN RAISE EXCEPTION '187 exact job parent principal' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME IN('large_import_quota_resources173','large_import_quota_terminal_witnesses173','large_import_quota_terminal_receipts173') AND NOT EXISTS(SELECT FROM public.large_import_quota_reservations173 q187 WHERE q187.tenant_id=x.tenant_id AND q187.id=(row0->>'reservation_id')::uuid AND q187.actor_id=x.actor_id AND q187.api_key_id IS NOT DISTINCT FROM x.api_key_id) THEN RAISE EXCEPTION '187 exact reservation parent principal' USING ERRCODE='42501';END IF;
 IF x.mode='growth' THEN
  IF e.payload_text::jsonb->>'state'<>'OPEN' THEN RAISE EXCEPTION '187 poisoned growth DML' USING ERRCODE='55000';END IF;
  IF NOT EXISTS(SELECT FROM ordinary187_private.journal o187 JOIN pg_stat_activity p187 ON p187.pid=(o187.payload_text::jsonb->>'parent_pid')::integer AND p187.backend_start=(o187.payload_text::jsonb->>'parent_start')::timestamptz AND p187.datname=current_database() WHERE(o187.root_key,o187.epoch,o187.id)=(x.root_key,x.epoch,x.original_id) AND o187.kind='original' AND o187.payload_text::jsonb->>'state'='OPEN') THEN RAISE EXCEPTION '187 growth requires same live original companion' USING ERRCODE='55000';END IF;
 ELSE
  -- Existing keeper functions remain mandatory and decisive. This is an additional no-growth envelope, not a replacement for native original token/hash/bytes/FS proofs.
  old0:=CASE WHEN TG_OP IN('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END;new0:=CASE WHEN TG_OP IN('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  IF e.payload_text::jsonb->>'state' NOT IN('OPEN','POISONED') OR TG_OP='DELETE' THEN RAISE EXCEPTION '187 terminal exact epoch/no delete' USING ERRCODE='42501';END IF;
  IF TG_TABLE_NAME='large_import_jobs173' AND TG_OP='UPDATE' THEN
   IF new0-'lease_token'-'leased_at' IS DISTINCT FROM old0-'lease_token'-'leased_at' OR NEW.lease_token IS NOT NULL OR NEW.leased_at IS NOT NULL THEN RAISE EXCEPTION '187 terminal job only exact lease release' USING ERRCODE='23514';END IF;
  ELSIF TG_TABLE_NAME='large_import_quota_resources173' AND TG_OP='UPDATE' THEN
   IF new0-'state' IS DISTINCT FROM old0-'state' OR NEW.state<>'released' OR OLD.state NOT IN('settled','quarantined') THEN RAISE EXCEPTION '187 terminal resource only exact no-growth release' USING ERRCODE='23514';END IF;
  ELSIF TG_TABLE_NAME='large_import_quota_resources173' AND TG_OP='INSERT' THEN
   IF NEW.kind<>'event' OR NEW.state<>'settled' OR NEW.resource_key !~ '^event:(quota-terminal-witness|quota-terminal-receipt|upload-known-close|upload-absent-close|business-known-close):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR NEW.payload_text IS NULL OR NEW.byte_count<>octet_length(NEW.payload_text) OR NEW.sha256<>encode(sha256(convert_to(NEW.payload_text,'UTF8')),'hex') OR NEW.payload_text::jsonb->>'schema' NOT IN('private-quota-terminal-witness/v1','private-business-lock-terminal-witness/v1','quota-terminal-receipt/v1','quota-known-close-evidence/v1','quota-absent-close-evidence/v1') THEN RAISE EXCEPTION '187 terminal only native close evidence' USING ERRCODE='23514';END IF;
  ELSIF TG_TABLE_NAME='large_import_quota_reservations173' AND TG_OP='UPDATE' THEN
   IF OLD.state<>'open' OR NEW.state NOT IN('unknown','retained') THEN RAISE EXCEPTION '187 terminal reservation only original open' USING ERRCODE='23514';END IF;
   IF NEW.state='unknown' THEN
    IF new0-'state' IS DISTINCT FROM old0-'state' THEN RAISE EXCEPTION '187 unknown preserves every original charge/field' USING ERRCODE='23514';END IF;
   ELSIF new0-ARRAY['state','outcome','raw_charge','metadata_charge','objects_charge','closed_at','inventory_sha256']::text[] IS DISTINCT FROM old0-ARRAY['state','outcome','raw_charge','metadata_charge','objects_charge','closed_at','inventory_sha256']::text[] OR NEW.outcome IS NULL OR NEW.outcome NOT IN('ready','absent') OR NEW.raw_charge<0 OR NEW.raw_charge>OLD.raw_ceiling OR NEW.metadata_charge<0 OR NEW.metadata_charge>OLD.metadata_ceiling OR NEW.objects_charge<0 OR NEW.objects_charge>OLD.objects_ceiling OR NEW.closed_at IS NULL OR NEW.inventory_sha256 IS NULL THEN
    RAISE EXCEPTION '187 retained original capacity/identity' USING ERRCODE='23514';
   END IF;
  ELSIF TG_TABLE_NAME NOT IN('large_import_quota_terminal_witnesses173','large_import_quota_terminal_receipts173') OR TG_OP<>'INSERT' THEN
   RAISE EXCEPTION '187 terminal growth refused' USING ERRCODE='42501';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $guard187$;

CREATE OR REPLACE FUNCTION public.ordinary187_seal(root0 text,epoch0 bigint,member0 uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,ordinary187_private SET TimeZone='UTC' AS $seal187$
DECLARE x ordinary187_private.contexts%ROWTYPE;e ordinary187_private.journal%ROWTYPE;
BEGIN
 SELECT * INTO STRICT x FROM ordinary187_private.contexts WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id();
 IF x.root_key IS DISTINCT FROM root0 OR x.epoch IS DISTINCT FROM epoch0 OR x.member_id IS DISTINCT FROM member0 THEN RAISE EXCEPTION '187 exact outer context' USING ERRCODE='42501';END IF;
 IF x.keeper_call IS NOT NULL THEN RAISE EXCEPTION '198 seal refuses unfinished keeper call' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT e FROM ordinary187_private.journal WHERE root_key=root0 AND epoch=epoch0 AND kind='epoch' FOR SHARE;
 IF (x.mode='growth' AND e.payload_text::jsonb->>'state'<>'OPEN') OR (x.mode='terminal' AND e.payload_text::jsonb->>'state' NOT IN('OPEN','POISONED')) THEN RAISE EXCEPTION '187 poisoned growth seal' USING ERRCODE='55000';END IF;
 -- No exception/subtransaction or savepoint here. Actual source caller invokes this after work and retains outer entry/DML locks through real COMMIT.
END $seal187$;

CREATE OR REPLACE FUNCTION ordinary187_private.context_final() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,ordinary187_private SET TimeZone='UTC' AS $final187$
DECLARE e ordinary187_private.journal%ROWTYPE;
BEGIN
 IF NEW.backend_pid<>pg_backend_pid() OR NEW.xid<>pg_current_xact_id() THEN RAISE EXCEPTION '187 exact final actual transaction' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT FROM ordinary187_private.contexts c198 WHERE(c198.backend_pid,c198.backend_start,c198.xid,c198.root_key,c198.epoch,c198.original_id,c198.member_id)=(NEW.backend_pid,NEW.backend_start,NEW.xid,NEW.root_key,NEW.epoch,NEW.original_id,NEW.member_id) AND c198.keeper_call IS NULL) THEN RAISE EXCEPTION '198 final refuses missing or unfinished keeper context' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT e FROM ordinary187_private.journal WHERE root_key=NEW.root_key AND epoch=NEW.epoch AND kind='epoch' FOR SHARE;
 IF (NEW.mode='growth' AND e.payload_text::jsonb->>'state'<>'OPEN') OR (NEW.mode='terminal' AND e.payload_text::jsonb->>'state' NOT IN('OPEN','POISONED')) THEN RAISE EXCEPTION '187 final old growth epoch' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $final187$;

CREATE FUNCTION public.ordinary198_upload_close_finish(u uuid,t uuid,k uuid,r text,h text,q uuid,token text,client0 uuid,proof0 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,ordinary187_private SET TimeZone='UTC' AS $closewrapper198c$
DECLARE x ordinary187_private.contexts%ROWTYPE;fact jsonb;value0 jsonb;p jsonb;
BEGIN
 PERFORM public.large_import_quota_keeper_admit173(u,t,k,r,h,true);
 x:=ordinary187_private.keeper_context198();
 IF (x.tenant_id,x.actor_id,x.api_key_id) IS DISTINCT FROM (t,u,k) OR x.keeper_call IS NOT NULL OR client0 IS NULL THEN RAISE EXCEPTION '198 exact current close principal once' USING ERRCODE='42501';END IF;
 fact:=public.large_import_quota_terminal_close_begin173(u,t,k,r,h,q,token,client0);
 IF fact->'reused'='true'::jsonb THEN RETURN fact;END IF;
 IF proof0 IS NULL OR octet_length(proof0)>8388608 OR fact->'reservation'->>'state' NOT IN('open','unknown') OR ('c'='z' AND fact->'reservation'->>'state'<>'unknown') THEN RAISE EXCEPTION '198 bounded original close state proof' USING ERRCODE='23514';END IF;
 -- Closing receipt cannot pretend an unresolved physical IO drained. Existing source-owned drain must precede it.
 IF EXISTS(SELECT FROM ordinary187_private.journal j WHERE j.root_key=x.root_key AND j.epoch<=x.epoch AND j.kind='io' AND(j.payload_text::jsonb->>'reservation_id')::uuid=q AND ((j.tenant_id,j.actor_id,j.api_key_id) IS DISTINCT FROM(t,u,k) OR j.payload_text::jsonb->>'state'<>'DRAINED')) THEN RAISE EXCEPTION '198 close refuses unresolved or foreign IO' USING ERRCODE='42501';END IF;
 p:=jsonb_build_object('a','c','q',q,'k','event:upload-known-close:'||client0::text,'c',client0,'t',CASE WHEN 'c'='z' THEN 'absent-prefix' ELSE 'known-close' END,'w',encode(sha256(convert_to(proof0,'UTF8')),'hex'),'s',0);
 UPDATE ordinary187_private.contexts SET keeper_call=p WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 value0:=public.large_import_quota_terminal_close_finish173(u,t,k,r,h,q,token,client0,proof0);
 SELECT keeper_call INTO STRICT p FROM ordinary187_private.contexts WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 IF (p->>'s')::integer<>3 OR value0->'reused' IS DISTINCT FROM 'false'::jsonb OR value0->'receipt'->>'client_key' IS DISTINCT FROM client0::text OR value0->'receipt'->>'inventory_sha256' IS DISTINCT FROM p->>'w' THEN RAISE EXCEPTION '198 complete exact native close required' USING ERRCODE='23514';END IF;
 UPDATE ordinary187_private.contexts SET keeper_call=NULL WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 RETURN value0;
END $closewrapper198c$;
REVOKE ALL ON FUNCTION public.ordinary198_upload_close_finish(uuid,uuid,uuid,text,text,uuid,text,uuid,text) FROM PUBLIC,dyna_app;

CREATE FUNCTION public.ordinary198_owned_close_finish(u uuid,t uuid,k uuid,r text,h text,q uuid,token text,client0 uuid,proof0 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,ordinary187_private SET TimeZone='UTC' AS $closewrapper198d$
DECLARE x ordinary187_private.contexts%ROWTYPE;fact jsonb;value0 jsonb;p jsonb;
BEGIN
 PERFORM public.large_import_quota_keeper_admit173(u,t,k,r,h,true);
 x:=ordinary187_private.keeper_context198();
 IF (x.tenant_id,x.actor_id,x.api_key_id) IS DISTINCT FROM (t,u,k) OR x.keeper_call IS NOT NULL OR client0 IS NULL THEN RAISE EXCEPTION '198 exact current close principal once' USING ERRCODE='42501';END IF;
 fact:=public.large_import_quota_owned_close_begin173(u,t,k,r,h,q,token,client0);
 IF fact->'reused'='true'::jsonb THEN RETURN fact;END IF;
 IF proof0 IS NULL OR octet_length(proof0)>8388608 OR fact->'reservation'->>'state' NOT IN('open','unknown') OR ('d'='z' AND fact->'reservation'->>'state'<>'unknown') THEN RAISE EXCEPTION '198 bounded original close state proof' USING ERRCODE='23514';END IF;
 -- Closing receipt cannot pretend an unresolved physical IO drained. Existing source-owned drain must precede it.
 IF EXISTS(SELECT FROM ordinary187_private.journal j WHERE j.root_key=x.root_key AND j.epoch<=x.epoch AND j.kind='io' AND(j.payload_text::jsonb->>'reservation_id')::uuid=q AND ((j.tenant_id,j.actor_id,j.api_key_id) IS DISTINCT FROM(t,u,k) OR j.payload_text::jsonb->>'state'<>'DRAINED')) THEN RAISE EXCEPTION '198 close refuses unresolved or foreign IO' USING ERRCODE='42501';END IF;
 p:=jsonb_build_object('a','d','q',q,'k','event:business-known-close:'||client0::text,'c',client0,'t',CASE WHEN 'd'='z' THEN 'absent-prefix' ELSE 'known-close' END,'w',encode(sha256(convert_to(proof0,'UTF8')),'hex'),'s',0);
 UPDATE ordinary187_private.contexts SET keeper_call=p WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 value0:=public.large_import_quota_owned_close_finish173(u,t,k,r,h,q,token,client0,proof0);
 SELECT keeper_call INTO STRICT p FROM ordinary187_private.contexts WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 IF (p->>'s')::integer<>3 OR value0->'reused' IS DISTINCT FROM 'false'::jsonb OR value0->'receipt'->>'client_key' IS DISTINCT FROM client0::text OR value0->'receipt'->>'inventory_sha256' IS DISTINCT FROM p->>'w' THEN RAISE EXCEPTION '198 complete exact native close required' USING ERRCODE='23514';END IF;
 UPDATE ordinary187_private.contexts SET keeper_call=NULL WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 RETURN value0;
END $closewrapper198d$;
REVOKE ALL ON FUNCTION public.ordinary198_owned_close_finish(uuid,uuid,uuid,text,text,uuid,text,uuid,text) FROM PUBLIC,dyna_app;

CREATE FUNCTION public.ordinary198_absent_close_finish(u uuid,t uuid,k uuid,r text,h text,q uuid,token text,client0 uuid,proof0 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,ordinary187_private SET TimeZone='UTC' AS $closewrapper198z$
DECLARE x ordinary187_private.contexts%ROWTYPE;fact jsonb;value0 jsonb;p jsonb;
BEGIN
 PERFORM public.large_import_quota_keeper_admit173(u,t,k,r,h,true);
 x:=ordinary187_private.keeper_context198();
 IF (x.tenant_id,x.actor_id,x.api_key_id) IS DISTINCT FROM (t,u,k) OR x.keeper_call IS NOT NULL OR client0 IS NULL THEN RAISE EXCEPTION '198 exact current close principal once' USING ERRCODE='42501';END IF;
 fact:=public.large_import_quota_absent_begin173(u,t,k,r,h,q,token,client0);
 IF fact->'reused'='true'::jsonb THEN RETURN fact;END IF;
 IF proof0 IS NULL OR octet_length(proof0)>1048576 OR fact->'reservation'->>'state' NOT IN('open','unknown') OR ('z'='z' AND fact->'reservation'->>'state'<>'unknown') THEN RAISE EXCEPTION '198 bounded original close state proof' USING ERRCODE='23514';END IF;
 -- Closing receipt cannot pretend an unresolved physical IO drained. Existing source-owned drain must precede it.
 IF EXISTS(SELECT FROM ordinary187_private.journal j WHERE j.root_key=x.root_key AND j.epoch<=x.epoch AND j.kind='io' AND(j.payload_text::jsonb->>'reservation_id')::uuid=q AND ((j.tenant_id,j.actor_id,j.api_key_id) IS DISTINCT FROM(t,u,k) OR j.payload_text::jsonb->>'state'<>'DRAINED')) THEN RAISE EXCEPTION '198 close refuses unresolved or foreign IO' USING ERRCODE='42501';END IF;
 p:=jsonb_build_object('a','z','q',q,'k','event:upload-absent-close:'||client0::text,'c',client0,'t',CASE WHEN 'z'='z' THEN 'absent-prefix' ELSE 'known-close' END,'w',encode(sha256(convert_to(proof0,'UTF8')),'hex'),'s',0);
 UPDATE ordinary187_private.contexts SET keeper_call=p WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 value0:=public.large_import_quota_absent_finish173(u,t,k,r,h,q,token,client0,proof0);
 SELECT keeper_call INTO STRICT p FROM ordinary187_private.contexts WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 IF (p->>'s')::integer<>127 OR value0->'reused' IS DISTINCT FROM 'false'::jsonb OR value0->'receipt'->>'client_key' IS DISTINCT FROM client0::text OR value0->'receipt'->>'inventory_sha256' IS DISTINCT FROM p->>'w' THEN RAISE EXCEPTION '198 complete exact native close required' USING ERRCODE='23514';END IF;
 UPDATE ordinary187_private.contexts SET keeper_call=NULL WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 RETURN value0;
END $closewrapper198z$;
REVOKE ALL ON FUNCTION public.ordinary198_absent_close_finish(uuid,uuid,uuid,text,text,uuid,text,uuid,text) FROM PUBLIC,dyna_app;
