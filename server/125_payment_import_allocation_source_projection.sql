-- Preserve 124 and its function OID/ACL. Group JSON extraction before key deletion.
CREATE OR REPLACE FUNCTION payment_allocation_source(pid uuid,rid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
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
 IF ((s.basis->'normalized')-ARRAY['reference','match_identifiers','tracking_number']) IS DISTINCT FROM (n-ARRAY['reference','match_identifiers','tracking_number']) THEN RAISE EXCEPTION 'Zmieniły się pieniężne dane źródła' USING ERRCODE='23514';END IF;
 SELECT * INTO e FROM payment_import_allocation_executions WHERE tenant_id=t AND source_id=s.id ORDER BY source_version DESC LIMIT 1;
 IF e.id IS NULL OR c.allocation_source_id IS DISTINCT FROM s.id THEN RAISE EXCEPTION 'Niepełny wspólny claim źródła' USING ERRCODE='23514';END IF;
 amount:=(e.payload->'summary'->>'unallocated_minor')::bigint;fee:=(e.payload->'summary'->>'unallocated_fee_minor')::bigint;END IF;
 RETURN jsonb_build_object('source_preview_id',pid,'source_row_id',rid,'source_id',s.id,'namespace_id',p.namespace_id,'economic_key',r.economic_key,'payload_hash',coalesce(r.payload_hash,r.source->'raw'->>'identity_payload_hash',payment_allocation_hash(n)),
 'source_version',coalesce(e.source_version,0),'normalized',n,'transaction_id',n->>'transaction_id','ledger_kind',n->>'ledger_kind','currency',n->>'currency','gross_minor',n->>'gross_minor','fee_minor',n->>'fee_minor',
 'available_minor',(amount+fee)::text,'remaining_minor',(amount+fee)::text,'remaining_amount_minor',amount::text,'remaining_fee_minor',fee::text,'can_allocate',amount+fee>0);
END$$;
