-- SOURCE-AUTHORED, UNREGISTERED. Assemble AFTER the literal210 business core.
-- This is the actual final-boundary body, not evidence of Native installation.
-- Managed ordinary API must call it AFTER all sibling finalizers AND constraint
-- drains. No later business DML/provider wait may precede COMMIT.
CREATE FUNCTION public.order_split210_finalize(operation_kind text,requested_id uuid,
 uid uuid,kid uuid,supplied_credential text,role_name text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 p public.order_split210_previews;e public.order_split210_executions;
 initial_auth jsonb;closing_auth jsonb;original_request jsonb;stored_hash text;stored_actor uuid;stored_key uuid;
 current_command boolean;expected_hash text;current_source jsonb;current_plan jsonb;
 deadline timestamptz;replay_created timestamptz;
BEGIN
 IF operation_kind IS NULL OR operation_kind NOT IN('preview','execute') OR requested_id IS NULL
  OR t IS NULL OR uid IS NULL OR supplied_credential IS NULL OR supplied_credential!~'^[a-f0-9]{64}$'
  OR role_name IS NULL OR role_name NOT IN('admin','operator')
  OR current_user<>'postgres' OR session_user<>current_user
 THEN RAISE EXCEPTION 'Split final boundary needs an actual operator request' USING ERRCODE='42501';END IF;
 IF public.order_merge_delivery209_valid() IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Split final predecessor changed' USING ERRCODE='55000';END IF;
 initial_auth:=public.order_split210_identity(t,uid,kid,supplied_credential,role_name,false);
 IF operation_kind='preview' THEN
  SELECT * INTO p FROM public.order_split210_previews WHERE(tenant_id,id)=(t,requested_id);
  IF p.id IS NULL THEN RAISE EXCEPTION 'Split original preview unavailable' USING ERRCODE='P0002';END IF;
  stored_actor:=p.actor_id;stored_key:=p.api_key_id;stored_hash:=p.request_hash;original_request:=p.request;
  current_command:=(p.root_xid,p.transaction_started_at) IS NOT DISTINCT FROM(pg_current_xact_id(),transaction_timestamp());
 ELSE
  SELECT * INTO e FROM public.order_split210_executions WHERE(tenant_id,id)=(t,requested_id);
  IF e.id IS NULL THEN RAISE EXCEPTION 'Split original execution unavailable' USING ERRCODE='P0002';END IF;
  stored_actor:=e.actor_id;stored_key:=e.api_key_id;stored_hash:=e.request_hash;original_request:=e.request;
  current_command:=(e.root_xid,e.transaction_started_at) IS NOT DISTINCT FROM(pg_current_xact_id(),transaction_timestamp());
 END IF;
 expected_hash:=public.order_split210_hash(jsonb_build_object('kind',operation_kind,'tenant_id',t,
  'actor_id',uid,'api_key_id',kid,'request',original_request));
 IF stored_actor IS DISTINCT FROM uid OR stored_key IS DISTINCT FROM kid OR stored_hash IS DISTINCT FROM expected_hash
 THEN RAISE EXCEPTION 'Split final boundary has another original actor/key/body' USING ERRCODE='42501';END IF;

 IF current_command THEN
  IF operation_kind='preview' THEN
   IF(p.credential_hash,p.actor_role,p.identity_snapshot) IS DISTINCT FROM(supplied_credential,role_name,initial_auth)
    OR p.created_at>clock_timestamp() OR p.expires_at IS NULL OR p.expires_at<=clock_timestamp()
   THEN RAISE EXCEPTION 'New split preview authority expired or changed' USING ERRCODE='28000';END IF;
   current_source:=public.order_split210_capture(p.source_order_id,p.source_version);
   current_plan:=public.order_split210_plan(current_source,p.request,p.id);
   current_plan:=current_plan||jsonb_build_object('custody',public.order_split210_physical(current_source,current_plan,p.id));
   IF p.snapshot IS DISTINCT FROM current_source OR p.plan IS DISTINCT FROM current_plan
    OR p.scope_hash IS DISTINCT FROM public.order_split210_hash(jsonb_build_object('source',current_source,'request',p.request,'plan',current_plan))
    OR(SELECT count(*) FROM public.order_split210_source_rows WHERE(tenant_id,preview_id)=(t,p.id))<>jsonb_array_length(p.snapshot->'items')
    OR EXISTS(SELECT FROM jsonb_array_elements(p.snapshot->'items') i LEFT JOIN public.order_split210_source_rows s
     ON(s.tenant_id,s.preview_id,s.source_item_id)=(t,p.id,(i->>'id')::uuid)
     WHERE s.row_data IS DISTINCT FROM i OR s.source_order_id IS DISTINCT FROM p.source_order_id)
   THEN RAISE EXCEPTION 'New split preview source/plan/archive changed before COMMIT' USING ERRCODE='40001';END IF;
   deadline:=p.expires_at;
  ELSE
   IF(e.credential_hash,e.actor_role,e.identity_snapshot) IS DISTINCT FROM(supplied_credential,role_name,initial_auth)
   THEN RAISE EXCEPTION 'New split execution request authority changed' USING ERRCODE='28000';END IF;
   -- Exact current headers/items/allocations/custody/physical/no-financial-effect
   -- checks remain in the literal business terminal; no substitute snapshot.
   PERFORM public.order_split210_terminal(e.id);
   deadline:=e.expires_at;
  END IF;
 ELSE
  -- Historical commands keep their ORIGINAL data/old expiry. The Native replay
  -- producer must have created a duty for THIS request and THIS real transaction.
  -- No old terminal/current order/source recapture is valid for this branch.
  SELECT d.created_at INTO replay_created FROM public.order_split210_replay_duties d
   WHERE(d.tenant_id,d.kind,d.command_id,d.actor_id,d.credential_hash,d.actor_role,d.request_hash)=
    (t,operation_kind,requested_id,uid,supplied_credential,role_name,stored_hash)
    AND d.api_key_id IS NOT DISTINCT FROM kid
    AND(d.root_xid,d.transaction_started_at)=(pg_current_xact_id(),transaction_timestamp())
    AND d.identity_snapshot IS NOT DISTINCT FROM initial_auth
    AND d.created_at<=clock_timestamp() AND d.created_at+interval '15 minutes'>clock_timestamp()
   ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
  IF replay_created IS NULL THEN RAISE EXCEPTION 'Split current-request replay duty required' USING ERRCODE='55000';END IF;
  deadline:=replay_created+interval '15 minutes';
 END IF;
 -- Last read uses the supplied CURRENT request credential, never the original
 -- stored command credential. These reads follow every source/constraint wait.
 closing_auth:=public.order_split210_identity(t,uid,kid,supplied_credential,role_name,false);
 IF closing_auth IS DISTINCT FROM initial_auth OR deadline IS NULL OR deadline<=clock_timestamp()
 THEN RAISE EXCEPTION 'Split final request authority or deadline changed' USING ERRCODE='28000';END IF;
END$$;
REVOKE ALL ON FUNCTION public.order_split210_finalize(text,uuid,uuid,uuid,text,text) FROM PUBLIC,dyna_app;
