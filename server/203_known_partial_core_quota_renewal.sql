-- Additive Source203: old202 and all173/187 expiry/auth/accounting functions are unchanged.
-- Run only in the normal Root-owned migration transaction; never standalone autocommit.
DO $pre203$ BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR current_setting('role',true)<>'none'
 OR current_setting('session_replication_role')<>'origin' OR current_setting('transaction_read_only')<>'off'
 OR NOT EXISTS(SELECT FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND mode='ExclusiveLock' AND granted AND objsubid=1 AND classid=0 AND objid=982376)
 THEN RAISE EXCEPTION '203 exact owner migration transaction and schema exclusion' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT FROM public.migrations WHERE name='202_owned_business_quota_expiry_renewal') OR NOT public.ordinary187_valid() OR NOT public.large_import173_valid()
 OR EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND starts_with(p.proname,'ordinary203_'))
 THEN RAISE EXCEPTION '203 full exact202 predecessor required' USING ERRCODE='55000';END IF;
END $pre203$;

CREATE FUNCTION public.ordinary203_quota_renew_preview(u uuid,t uuid,k uuid,r text,h text,root0 text,job0 uuid,catalog0 uuid,jq uuid,jrequest uuid,jtoken text,rq uuid,rrequest uuid,rtoken text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,ordinary187_private SET TimeZone='UTC' AS $inspect203$
DECLARE j public.large_import_jobs173%ROWTYPE;b public.large_import_quota_reservations173%ROWTYPE;v public.large_import_quota_reservations173%ROWTYPE;n jsonb;now0 timestamptz;ttl integer;reason0 text:='eligible';q0 uuid;
BEGIN
 PERFORM public.ordinary182_require_generation();
 IF public.ordinary203_quota_renew_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '203 exact reviewed renewal descriptors required' USING ERRCODE='55000';END IF;
 IF k IS NOT NULL OR r IS DISTINCT FROM 'admin' OR root0 IS NULL OR root0 !~ '^[a-f0-9]{64}$'
 OR job0 IS NULL OR catalog0 IS NULL OR jq IS NULL OR rq IS NULL OR jq=rq OR jrequest IS NULL OR rrequest IS NULL OR jrequest=rrequest
 OR jtoken IS NULL OR rtoken IS NULL OR jtoken !~ '^[a-f0-9]{64}$' OR rtoken !~ '^[a-f0-9]{64}$' OR jtoken=rtoken
 THEN RAISE EXCEPTION '202 normal admin exact distinct pair shape' USING ERRCODE='42501';END IF;
 PERFORM public.large_import_quota_authorize173(u,t,k,r,h);
 -- Global -> tenant -> rows. Both policy rows stay pinned through Source FS check.
 SELECT lease_seconds INTO STRICT ttl FROM public.large_import_quota_policies173 WHERE scope='tenant:'||t::text;
 IF ttl NOT BETWEEN 30 AND 86400 THEN RAISE EXCEPTION '202 current bounded policy TTL' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM public.large_import_quota_reservations173 WHERE tenant_id=t AND id IN(jq,rq) ORDER BY id FOR UPDATE;
 SELECT * INTO STRICT b FROM public.large_import_quota_reservations173 WHERE tenant_id=t AND id=jq;
 SELECT * INTO STRICT v FROM public.large_import_quota_reservations173 WHERE tenant_id=t AND id=rq;
 IF(b.actor_id,b.api_key_id,b.request_id,b.token_hash,b.kind,b.raw_ceiling) IS DISTINCT FROM(u,NULL::uuid,jrequest,jtoken,'job'::text,0::bigint)
 OR(v.actor_id,v.api_key_id,v.request_id,v.token_hash,v.kind,v.raw_ceiling) IS DISTINCT FROM(u,NULL::uuid,rrequest,rtoken,'review'::text,0::bigint)
 THEN RAISE EXCEPTION '202 exact original pair ownership token request kind' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT j FROM public.large_import_jobs173 WHERE tenant_id=t AND id=job0 AND actor_id=u AND api_key_id IS NULL FOR SHARE;
 n:=j.state_text::jsonb;
 IF n->>'schema' IS DISTINCT FROM 'large-import-job/v1' OR(n->>'id')::uuid IS DISTINCT FROM job0
 OR(n#>>'{principal,tenantId}')::uuid IS DISTINCT FROM t OR(n#>>'{principal,userId}')::uuid IS DISTINCT FROM u OR n#>>'{principal,apiKeyId}' IS NOT NULL
 OR encode(sha256(convert_to(j.state_text,'UTF8')),'hex') IS DISTINCT FROM j.state_sha256
 OR jsonb_typeof(n->'core') IS DISTINCT FROM 'array' OR jsonb_array_length(n->'core') NOT BETWEEN 1 AND 100000
 OR EXISTS(SELECT FROM jsonb_array_elements(n->'core') c WHERE(c#>>'{request,catalog_id}')::uuid IS DISTINCT FROM catalog0)
 THEN RAISE EXCEPTION '202 exact current job and catalog' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.large_import_quota_resources173 WHERE tenant_id=t AND reservation_id IN(jq,rq) ORDER BY reservation_id,resource_key COLLATE "C" FOR SHARE;
 IF NOT EXISTS(SELECT FROM public.large_import_quota_resources173 WHERE tenant_id=t AND reservation_id=jq AND resource_key='job:'||job0::text||':initial' AND kind='job')
 OR NOT EXISTS(SELECT FROM public.large_import_quota_resources173 WHERE tenant_id=t AND reservation_id=rq AND resource_key ~ ('^review:'||job0::text||':[0-9]+$') AND kind='review') AND(
 EXISTS(SELECT FROM public.large_import_quota_resources173 WHERE tenant_id=t AND reservation_id=rq)
 OR(v.raw_charge,v.metadata_charge,v.objects_charge) IS DISTINCT FROM(0::bigint,0::bigint,0::bigint)
 OR EXISTS(SELECT FROM public.large_import_core_reviews173 WHERE tenant_id=t AND job_id=job0))
 THEN RAISE EXCEPTION '202 exact Native job review pair custody' USING ERRCODE='42501';END IF;
 now0:=clock_timestamp();
 IF b.state<>'open' OR v.state<>'open' OR b.outcome IS NOT NULL OR v.outcome IS NOT NULL THEN reason0:='pair_not_open';
 ELSIF b.expires_at>now0 OR v.expires_at>now0 THEN reason0:='pair_not_expired';
 ELSIF j.lease_token IS NOT NULL OR j.leased_at IS NOT NULL THEN reason0:='job_lease_active';
 ELSIF (jsonb_typeof(n->'events') IS DISTINCT FROM 'array' OR EXISTS(
 SELECT FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n->'events')='array' THEN n->'events' ELSE '[]'::jsonb END) e
 CROSS JOIN LATERAL(SELECT CASE WHEN jsonb_typeof(e->'batch')='number' THEN CASE
 WHEN (e->>'batch')::numeric BETWEEN 0 AND 99999 AND (e->>'batch')::numeric=trunc((e->>'batch')::numeric)
 THEN (e->>'batch')::integer ELSE -1 END ELSE -1 END AS batch0) z
 WHERE e->>'kind' IN('core-preview-attempt','core-execute-attempt')
 AND CASE WHEN z.batch0<0 OR z.batch0>=jsonb_array_length(n->'core') THEN true
 WHEN e->>'kind'='core-preview-attempt' THEN n->'core'->z.batch0->'preview' IS NULL OR n->'core'->z.batch0->'preview'='null'::jsonb
 ELSE n->'core'->z.batch0->'execution' IS NULL OR n->'core'->z.batch0->'execution'='null'::jsonb END))
 OR EXISTS(SELECT FROM jsonb_each(n->'pim') z CROSS JOIN LATERAL jsonb_array_elements(z.value) p
 WHERE(p->>'previewAttempted'='true' AND(p->'preview' IS NULL OR p->'preview'='null'::jsonb))
 OR(p->>'applyAttempted'='true' AND(p->'applied' IS NULL OR p->'applied'='null'::jsonb))) THEN reason0:='business_outcome_unknown';
 ELSIF EXISTS(SELECT FROM public.large_import_quota_resources173 WHERE tenant_id=t AND reservation_id IN(jq,rq) AND(state NOT IN('settled','released') OR kind='raw')) THEN reason0:='resource_not_drained';
 ELSIF EXISTS(SELECT FROM ordinary187_private.journal x WHERE x.root_key=root0 AND x.kind='io'
 AND(x.payload_text::jsonb->>'reservation_id')::uuid IN(jq,rq)
 AND((x.tenant_id,x.actor_id,x.api_key_id) IS DISTINCT FROM(t,u,NULL::uuid) OR x.payload_text::jsonb->>'state' IS DISTINCT FROM 'DRAINED')) THEN reason0:='io_not_drained';
 END IF;
 RETURN jsonb_build_object('schema','quota-expired-open-pair-preview/v1','eligible',reason0='eligible','reason',reason0,
 'native_time',to_char(now0 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'policy_lease_seconds',ttl,'current_job_sha256',j.state_sha256,
 'job',(to_jsonb(b)-'token_hash')||jsonb_build_object('expires_at',to_char(b.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
 'review',(to_jsonb(v)-'token_hash')||jsonb_build_object('expires_at',to_char(v.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
END $inspect203$;
REVOKE ALL ON FUNCTION public.ordinary203_quota_renew_preview(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,text,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ordinary203_quota_renew_preview(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,text,uuid,uuid,text) TO dyna_app;

CREATE FUNCTION public.ordinary203_quota_renew_pair(u uuid,t uuid,k uuid,r text,h text,root0 text,job0 uuid,catalog0 uuid,jq uuid,jrequest uuid,jtoken text,rq uuid,rrequest uuid,rtoken text,expected_job_expires_at text,expected_review_expires_at text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,ordinary187_private SET TimeZone='UTC' AS $renew203$
DECLARE x ordinary187_private.contexts%ROWTYPE;fact jsonb;j0 jsonb;r0 jsonb;j1 jsonb;r1 jsonb;p jsonb;now0 timestamptz;deadline0 timestamptz;deadline_text text;ttl integer;sha0 text;
BEGIN
 PERFORM public.ordinary182_require_generation();
 IF public.ordinary203_quota_renew_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '203 exact reviewed renewal descriptors required' USING ERRCODE='55000';END IF;
 x:=ordinary187_private.renewal_context202(root0,t,u);
 IF x.keeper_call IS NOT NULL THEN RAISE EXCEPTION '202 no nested unfinished renewal marker' USING ERRCODE='42501';END IF;
 IF expected_job_expires_at IS NULL OR expected_review_expires_at IS NULL
 OR expected_job_expires_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
 OR expected_review_expires_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
 THEN RAISE EXCEPTION '202 microsecond expiry CAS shape' USING ERRCODE='22023';END IF;
 fact:=public.ordinary203_quota_renew_preview(u,t,k,r,h,root0,job0,catalog0,jq,jrequest,jtoken,rq,rrequest,rtoken);
 IF fact->'eligible' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION '202 current pair refused: %',fact->>'reason' USING ERRCODE='55000';END IF;
 j0:=fact->'job';r0:=fact->'review';
 IF j0->>'expires_at' IS DISTINCT FROM expected_job_expires_at OR r0->>'expires_at' IS DISTINCT FROM expected_review_expires_at
 THEN RAISE EXCEPTION '202 stale exact pair expiry CAS' USING ERRCODE='40001';END IF;
 now0:=clock_timestamp();ttl:=(fact->>'policy_lease_seconds')::integer;deadline0:=now0+ttl*interval '1 second';deadline_text:=to_char(deadline0 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
 SELECT encode(sha256(convert_to(jsonb_build_array(to_jsonb(j)-'expires_at',to_jsonb(v)-'expires_at')::text,'UTF8')),'hex') INTO STRICT sha0
 FROM public.large_import_quota_reservations173 j CROSS JOIN public.large_import_quota_reservations173 v WHERE j.tenant_id=t AND j.id=jq AND v.tenant_id=t AND v.id=rq;
 p:=jsonb_build_object('a','n','q',jq::text,'c',rq::text,'k',job0::text,'t',deadline_text,'w',sha0,'s',0);
 UPDATE ordinary187_private.contexts SET keeper_call=p WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 UPDATE public.large_import_quota_reservations173 SET expires_at=deadline0 WHERE tenant_id=t AND id=jq;
 UPDATE public.large_import_quota_reservations173 SET expires_at=deadline0 WHERE tenant_id=t AND id=rq;
 SELECT keeper_call INTO STRICT p FROM ordinary187_private.contexts WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 IF p->>'a' IS DISTINCT FROM 'n' OR p->>'s' IS DISTINCT FROM '3' THEN RAISE EXCEPTION '202 both exact expiry updates required' USING ERRCODE='42501';END IF;
 UPDATE ordinary187_private.contexts SET keeper_call=NULL WHERE(backend_pid,backend_start,xid)=(x.backend_pid,x.backend_start,x.xid);
 SELECT(to_jsonb(b)-'token_hash')||jsonb_build_object('expires_at',deadline_text) INTO STRICT j1 FROM public.large_import_quota_reservations173 b WHERE tenant_id=t AND id=jq;
 SELECT(to_jsonb(b)-'token_hash')||jsonb_build_object('expires_at',deadline_text) INTO STRICT r1 FROM public.large_import_quota_reservations173 b WHERE tenant_id=t AND id=rq;
 IF j1-'expires_at' IS DISTINCT FROM j0-'expires_at' OR r1-'expires_at' IS DISTINCT FROM r0-'expires_at'
 THEN RAISE EXCEPTION '202 all non-expiry fields unchanged' USING ERRCODE='23514';END IF;
 PERFORM public.large_import173_admit(u,t,k,r,h,true);
 RETURN jsonb_build_object('schema','quota-open-pair-renewal-receipt/v1','renewed',true,'identity_preserved',true,'accounting_preserved',true,
 'native_time',to_char(now0 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'lease_seconds',ttl,
 'job',jsonb_build_object('before',j0,'after',j1),'review',jsonb_build_object('before',r0,'after',r1));
END $renew203$;
REVOKE ALL ON FUNCTION public.ordinary203_quota_renew_pair(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,text,uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ordinary203_quota_renew_pair(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,text,uuid,uuid,text,text,text) TO dyna_app;

CREATE FUNCTION public.ordinary203_quota_renew_valid() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,ordinary187_private SET TimeZone='UTC' AS $valid203$
DECLARE expected0 jsonb:='[{"name":"ordinary203_quota_renew_pair","arguments":"u uuid, t uuid, k uuid, r text, h text, root0 text, job0 uuid, catalog0 uuid, jq uuid, jrequest uuid, jtoken text, rq uuid, rrequest uuid, rtoken text, expected_job_expires_at text, expected_review_expires_at text","result":"jsonb","source_sha256":"17c2ba104c89c41d29d7f6ab0bef81104a2210d427d9c358fef53ea1d4555ea7","definition_sha256":"d6ded966a253abb4529874276ba948557622db0872e658f06cb85a955ede093b","argument_names":["u","t","k","r","h","root0","job0","catalog0","jq","jrequest","jtoken","rq","rrequest","rtoken","expected_job_expires_at","expected_review_expires_at"]},{"name":"ordinary203_quota_renew_preview","arguments":"u uuid, t uuid, k uuid, r text, h text, root0 text, job0 uuid, catalog0 uuid, jq uuid, jrequest uuid, jtoken text, rq uuid, rrequest uuid, rtoken text","result":"jsonb","source_sha256":"9ede3d860b765cb779d4b4f5a442b65e558503857039a208eca0b7728fe1e784","definition_sha256":"a0cb95e8fc46de6212a385377d53b927d4de189a40dba757eb34c6c41a8388d3","argument_names":["u","t","k","r","h","root0","job0","catalog0","jq","jrequest","jtoken","rq","rrequest","rtoken"]}]'::jsonb;actual0 jsonb;
BEGIN
 IF current_setting('session_replication_role')<>'origin' THEN RETURN false;END IF;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND starts_with(p.proname,'ordinary203_'))<>3 THEN RETURN false;END IF;
 IF EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
 WHERE n.nspname='public' AND starts_with(p.proname,'ordinary203_') AND(
 pg_get_userbyid(p.proowner)<>'postgres' OR l.lanname<>'plpgsql' OR p.prokind<>'f' OR NOT p.prosecdef OR p.proleakproof OR p.proisstrict OR p.proretset
 OR p.procost<>100 OR p.prorows<>0 OR p.proparallel<>'u' OR p.prosupport<>0 OR p.provariadic<>0 OR p.probin IS NOT NULL OR p.proargmodes IS NOT NULL OR p.proallargtypes IS NOT NULL OR p.protrftypes IS NOT NULL OR p.prosqlbody IS NOT NULL
 OR p.pronargdefaults<>0 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, ordinary187_private','TimeZone=UTC']::text[]
 OR p.proacl IS NULL OR (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END COLLATE "C") FROM aclexplode(p.proacl) a)
 IS DISTINCT FROM '[["postgres","dyna_app","EXECUTE",false],["postgres","postgres","EXECUTE",false]]'::jsonb)) THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='ordinary203_quota_renew_valid' AND p.pronargs=0 AND p.prorettype='boolean'::regtype AND p.provolatile='s') THEN RETURN false;END IF;
 SELECT jsonb_agg(jsonb_build_object('name',p.proname,'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid),'source_sha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'definition_sha256',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),'argument_names',to_jsonb(p.proargnames)) ORDER BY p.proname COLLATE "C") INTO actual0
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN('ordinary203_quota_renew_pair','ordinary203_quota_renew_preview') AND p.provolatile='v';
 RETURN actual0 IS NOT DISTINCT FROM expected0;
END $valid203$;
REVOKE ALL ON FUNCTION public.ordinary203_quota_renew_valid() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ordinary203_quota_renew_valid() TO dyna_app;

DO $post203$ BEGIN IF public.ordinary203_quota_renew_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '203 exact new descriptors refused' USING ERRCODE='55000';END IF;END $post203$;
