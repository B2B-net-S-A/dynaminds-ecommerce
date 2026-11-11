-- Migration 256_return_receipt_verdicts (prepared as 272; the object name keeps the return_receipt272_ prefix).
-- docs/parity/RETURN-RECEIPT-GEN272-20261029.md. Composes with p270 (stock_verdict_ generation, which takes over
-- catalog_stock_return_prepare on the same route); 272 touches only the financial side.
-- The ordinary return receipt (POST /api/returns/:id/receive) asks the sealed financial_return_capture() (162) before any
-- row lock. It runs financial_return_guards() twice (itself and through financial_return_frame(), ~0.25-0.5 s each even
-- idle) and in the common case answers NULL: the 162 protocol covers only an accepted no-restock refund receive of a
-- requested RMA against a B2B invoice. The sealed body cannot change (its fingerprint pins it), so this adds one
-- owner-only front door that keeps the sealed function as the only producer:
--  * it asks guard_verdict() (248) for financial_return_guards; anything but a cached or freshly verified true sends the
--    call to the sealed function, which then raises exactly as before;
--  * it then reads, in the sealed order, only what decides the NULL answer, and calls the same sealed helper
--    (financial_return_identity) the sealed body calls, at the same points;
--  * NULL is returned only where the sealed function would return NULL without raising; every other case (a replay, an
--    unknown RMA, a check the sealed body would refuse, a B2B invoice) returns the sealed function's own result, by
--    calling it.
-- No catalog_stock_, financial_return_, b2b_credit_, fa3_draft_, local_invoice_ or other sealed object is created or
-- changed, so no fingerprint or guard pin moves. No table, no write, no trigger, no dynamic SQL, nothing granted.

-- financial_return_capture(uid,kid,h,rid,q). Sealed order: financial_return_guards(), financial_return_identity(),
-- an existing admission = replay, financial_return_frame() (guards again, own RMA, identity again, then NULL unless an
-- accepted no-restock refund receive of a non-legacy requested RMA without WMS/local origin/parcel plan against a B2B
-- invoice).
CREATE FUNCTION return_receipt272_financial_capture(uid uuid,kid uuid,h text,rid uuid,q jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET "TimeZone"='UTC' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;rc public.return_cases;
BEGIN
 IF tenant IS NULL OR rid IS NULL OR jsonb_typeof(q) IS DISTINCT FROM 'object' OR jsonb_typeof(q->'items') IS DISTINCT FROM 'array'
  OR EXISTS(SELECT FROM jsonb_array_elements(q->'items')v WHERE jsonb_typeof(v)<>'object' OR jsonb_typeof(v->'accepted')<>'number'
   OR (v->>'accepted')!~'^[0-9]{1,9}$' OR jsonb_typeof(v->'restocked')<>'number' OR (v->>'restocked')!~'^[0-9]{1,9}$')
  OR public.guard_verdict('financial_return_guards') IS DISTINCT FROM true THEN
  RETURN public.financial_return_capture(uid,kid,h,rid,q);END IF;
 PERFORM public.financial_return_identity(uid,kid,h,rid,false);
 IF EXISTS(SELECT FROM public.financial_return_admissions WHERE(tenant_id,return_id)=(tenant,rid)) THEN
  RETURN public.financial_return_capture(uid,kid,h,rid,q);END IF;
 SELECT * INTO rc FROM public.return_cases WHERE(tenant_id,id)=(tenant,rid);
 IF rc.id IS NULL THEN RETURN public.financial_return_capture(uid,kid,h,rid,q);END IF;
 PERFORM public.financial_return_identity(uid,kid,h,rid,false);
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(q->'items')v WHERE(v->>'accepted')::bigint>0) THEN RETURN NULL;END IF;
 IF rc.legacy OR rc.remedy<>'refund' OR rc.state<>'requested' OR rc.receipt IS NOT NULL OR rc.received_at IS NOT NULL OR rc.receipt_sequence<>0
 OR EXISTS(SELECT FROM jsonb_array_elements(q->'items')v WHERE(v->>'restocked')::integer<>0)
 OR q ? 'wms_lots' OR q ? 'origin_id'
 OR EXISTS(SELECT FROM public.b2b_return_local_origins WHERE(tenant_id,return_id)=(tenant,rid))
 OR EXISTS(SELECT FROM public.order_parcel_plans WHERE(tenant_id,order_id)=(tenant,rc.order_id)) THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT FROM public.documents WHERE(tenant_id,order_id)=(tenant,rc.order_id) AND kind='invoice' AND mode='b2b_invoice') THEN RETURN NULL;END IF;
 RETURN public.financial_return_capture(uid,kid,h,rid,q);
END$$;

REVOKE ALL ON FUNCTION return_receipt272_financial_capture(uuid,uuid,text,uuid,jsonb) FROM PUBLIC,dyna_app;
