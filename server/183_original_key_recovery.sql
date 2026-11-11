-- New SELECT-only owner helper. Migration129 functions and column grants stay literal.
-- The caller must be dyna_app inside the existing tenant transaction.
CREATE FUNCTION public.print_job_original_key_read(ck uuid, op text, entity uuid, uid uuid, kid uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := nullif(current_setting('app.tenant_id',true),'')::uuid; e public.print_job_events; outv jsonb;
BEGIN
 IF current_setting('role') IS DISTINCT FROM 'dyna_app' OR t IS NULL OR uid IS NULL OR ck IS NULL
    OR current_setting('session_replication_role') IS DISTINCT FROM 'origin' THEN
  RAISE EXCEPTION 'Brak oryginalnego kontekstu odczytu' USING ERRCODE='23514';
 END IF;
 IF op IS NULL OR op NOT IN ('job_create','printer_create','printer_update','reconcile','claim','ack')
    OR ((op IN ('job_create','printer_create')) IS DISTINCT FROM (entity IS NULL)) THEN
  RAISE EXCEPTION 'Niepoprawny rodzaj oryginalnej próby' USING ERRCODE='23514';
 END IF;
 -- Re-evaluate native IAM; no inherited cached flags and no write authorization.
 PERFORM public.print_job_require(uid,kid,false,false,false);
 SELECT * INTO e FROM public.print_job_events pe
 WHERE pe.tenant_id=t AND pe.client_key=ck AND pe.actor_id=uid
   AND pe.api_key_id IS NOT DISTINCT FROM kid AND pe.operation=op
   AND (entity IS NULL OR coalesce(pe.job_id,pe.printer_id)=entity);
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF e.job_id IS NOT NULL THEN
  SELECT jsonb_build_object('client_key',ck,'operation',op,'resource_kind','job','resource_id',j.id,
    'related_id',j.order_id,'receipt_id',e.id,'version',j.version::text,
    'receipt_version',e.version_after::text,'content_sha256',j.content_sha256,'state',j.state)
  INTO outv FROM public.print_jobs j WHERE j.tenant_id=t AND j.id=e.job_id AND e.printer_id IS NULL;
 ELSE
  SELECT jsonb_build_object('client_key',ck,'operation',op,'resource_kind','printer','resource_id',p.id,
    'related_id',NULL,'receipt_id',e.id,'version',p.version::text,
    'receipt_version',e.version_after::text,'content_sha256',NULL,'state',NULL)
  INTO outv FROM public.print_printers p WHERE p.tenant_id=t AND p.id=e.printer_id;
 END IF;
 RETURN outv;
END $$;
ALTER FUNCTION public.print_job_original_key_read(uuid,text,uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.print_job_original_key_read(uuid,text,uuid,uuid,uuid) FROM PUBLIC,dyna_app;
GRANT EXECUTE ON FUNCTION public.print_job_original_key_read(uuid,text,uuid,uuid,uuid) TO dyna_app;
