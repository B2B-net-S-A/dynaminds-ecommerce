-- Applied together with 092, before its migration receipt; no existing source function is rewritten.
ALTER TABLE wms_operations ADD CONSTRAINT wms_stocktake_typed_source CHECK (
 (kind='stocktake_post' AND stocktake_id IS NOT NULL AND stocktake_posting_id IS NOT NULL AND stocktake_review_id IS NOT NULL)
 OR (kind<>'stocktake_post' AND stocktake_id IS NULL AND stocktake_posting_id IS NULL AND stocktake_review_id IS NULL)
);
CREATE UNIQUE INDEX wms_stocktake_surplus_source ON wms_cost_layers(tenant_id,operation_id,stocktake_line_id)
 WHERE stocktake_line_id IS NOT NULL;
DROP TRIGGER wms_source_consistency ON wms_cost_layers;
CREATE CONSTRAINT TRIGGER wms_source_consistency AFTER INSERT ON wms_cost_layers
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.stocktake_line_id IS NULL)
 EXECUTE FUNCTION wms_source_consistency();

CREATE FUNCTION wms_stocktake_layer_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op record;h record;p record;r record;l record;lot record;f jsonb;prior_scope text;
BEGIN
 prior_scope:=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
 SELECT * INTO op FROM wms_operations WHERE (tenant_id,id)=(NEW.tenant_id,NEW.operation_id);
 SELECT * INTO h FROM wms_stocktakes WHERE (tenant_id,id)=(NEW.tenant_id,op.stocktake_id);
 SELECT * INTO p FROM wms_stocktake_postings WHERE (tenant_id,id,stocktake_id,review_id,operation_id)=
  (NEW.tenant_id,op.stocktake_posting_id,op.stocktake_id,op.stocktake_review_id,op.id);
 SELECT * INTO l FROM wms_stocktake_lines WHERE (tenant_id,id,stocktake_id,product_id)=
  (NEW.tenant_id,NEW.stocktake_line_id,op.stocktake_id,NEW.product_id);
 SELECT * INTO r FROM wms_stocktake_review_rows WHERE (tenant_id,review_id,stocktake_id,line_id,product_id)=
  (NEW.tenant_id,op.stocktake_review_id,op.stocktake_id,NEW.stocktake_line_id,NEW.product_id);
 SELECT * INTO lot FROM wms_lots WHERE (tenant_id,id,product_id)=(NEW.tenant_id,NEW.lot_id,NEW.product_id);
 IF op.kind IS DISTINCT FROM 'stocktake_post' OR h.id IS NULL OR p.id IS NULL OR l.id IS NULL OR r.line_id IS NULL OR lot.id IS NULL
  OR NEW.unit_cost_minor IS NULL OR NEW.currency<>h.currency OR op.policy_version<>h.policy_version
  OR NEW.purchase_receipt_id IS NOT NULL OR NEW.warehouse_document_id IS NOT NULL
  OR jsonb_array_length(r.fragments)<>1 OR (r.after->>'quantity')::numeric<=(r.before->>'quantity')::numeric
 THEN RAISE EXCEPTION 'Warstwa korekty nie ma własnego typed spisu i nadwyżki' USING ERRCODE='23514';END IF;
 f:=r.fragments->0;
 IF f->>'layer_id' IS NOT NULL OR (f->>'delta')::numeric<>NEW.quantity_received OR
  (f->>'quantity')::numeric<>NEW.quantity_received OR
  (r.after->>'quantity')::numeric-(r.before->>'quantity')::numeric<>NEW.quantity_received OR
  f->>'unit_cost_minor' IS NULL OR (f->>'unit_cost_minor')::numeric<>NEW.unit_cost_minor OR f->>'currency'<>NEW.currency
  OR (l.lot_id IS NOT NULL AND l.lot_id<>NEW.lot_id)
  OR (l.lot_id IS NULL AND (lot.operation_id<>op.id OR lot.origin<>'adjustment'))
  OR lot.lot_code IS DISTINCT FROM l.lot->>'lot_code'
  OR lot.expiry_date IS DISTINCT FROM (l.lot->>'expiry_date')::date
 THEN RAISE EXCEPTION 'Warstwa nie odpowiada partii i dokładnemu kosztowi nadwyżki' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM wms_cost_layers WHERE (tenant_id,operation_id,stocktake_line_id)=
  (NEW.tenant_id,NEW.operation_id,NEW.stocktake_line_id))<>1
 THEN RAISE EXCEPTION 'Nadwyżka ma więcej niż jedną nową warstwę' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;
END $$;
CREATE CONSTRAINT TRIGGER wms_stocktake_layer_source AFTER INSERT ON wms_cost_layers
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.stocktake_line_id IS NOT NULL)
 EXECUTE FUNCTION wms_stocktake_layer_source();

-- A completed, immutable posting cannot receive additional journal entries in a later transaction.
CREATE FUNCTION wms_stocktake_journal_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op record;
BEGIN
 SELECT * INTO op FROM wms_operations WHERE (tenant_id,id)=(NEW.tenant_id,NEW.operation_id);
 IF op.kind='stocktake_post' AND EXISTS(SELECT 1 FROM wms_stocktake_postings WHERE
  (tenant_id,operation_id)=(NEW.tenant_id,NEW.operation_id))
 THEN RAISE EXCEPTION 'Rozliczony spis nie przyjmuje nowych ruchów' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wms_stocktake_journal_open BEFORE INSERT ON wms_layer_movements
 FOR EACH ROW EXECUTE FUNCTION wms_stocktake_journal_open();

CREATE FUNCTION wms_stocktake_post_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op record;p record;h record;r record;expected_summary jsonb;prior_scope text;n bigint;
BEGIN
 prior_scope:=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
 IF TG_TABLE_NAME='wms_operations' THEN
  IF NEW.kind<>'stocktake_post' THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;END IF;
  SELECT * INTO op FROM wms_operations WHERE (tenant_id,id)=(NEW.tenant_id,NEW.id);
 ELSE
  SELECT * INTO op FROM wms_operations WHERE (tenant_id,id)=(NEW.tenant_id,NEW.operation_id);
 END IF;
 SELECT * INTO p FROM wms_stocktake_postings WHERE (tenant_id,id,stocktake_id,review_id,operation_id)=
  (NEW.tenant_id,op.stocktake_posting_id,op.stocktake_id,op.stocktake_review_id,op.id);
 SELECT * INTO h FROM wms_stocktakes WHERE (tenant_id,id)=(NEW.tenant_id,op.stocktake_id);
 SELECT * INTO r FROM wms_stocktake_reviews WHERE (tenant_id,stocktake_id,id)=
  (NEW.tenant_id,op.stocktake_id,op.stocktake_review_id);
 IF op.kind IS DISTINCT FROM 'stocktake_post' OR p.id IS NULL OR h.id IS NULL OR r.id IS NULL
  OR op.actor_id IS NULL OR op.source='system' OR op.actor_id<>p.actor_id OR op.client_key<>p.client_key
  OR h.state<>'posted' OR h.posting_id<>p.id OR h.last_review_id<>r.id
  OR h.version::numeric<>r.stocktake_version::numeric+1 OR op.policy_version<>h.policy_version
  OR op.order_id IS NOT NULL OR op.warehouse_document_id IS NOT NULL OR op.purchase_receipt_id IS NOT NULL OR op.return_id IS NOT NULL
  OR op.request IS DISTINCT FROM jsonb_build_object('stocktake_id',h.id,'posting_id',p.id,'review_id',r.id,'body',p.request)
  OR p.request->>'scope_hash' IS DISTINCT FROM r.scope_hash OR p.request->>'version' IS DISTINCT FROM r.stocktake_version::text
  OR p.request->>'review_id' IS DISTINCT FROM r.id::text OR p.request->>'client_key' IS DISTINCT FROM p.client_key::text
  OR p.request->'confirmed' IS DISTINCT FROM 'true'::jsonb
  OR p.result->'summary' IS DISTINCT FROM r.summary
 THEN RAISE EXCEPTION 'Rozliczenie nie odpowiada własnemu spisowi i zgodzie' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO n FROM wms_stocktake_lines WHERE (tenant_id,stocktake_id)=(NEW.tenant_id,h.id);
 IF n<>(SELECT count(*) FROM wms_stocktake_review_rows WHERE (tenant_id,review_id)=(NEW.tenant_id,r.id))
 THEN RAISE EXCEPTION 'Rozliczenie pomija pozycje spisu' USING ERRCODE='23514';END IF;
 SELECT jsonb_build_object('total',n,'changed',count(*) FILTER(WHERE before->'quantity' IS DISTINCT FROM after->'quantity'),
  'shortage_quantity',coalesce(sum(greatest(0,(before->>'quantity')::numeric-(after->>'quantity')::numeric)),0),
  'surplus_quantity',coalesce(sum(greatest(0,(after->>'quantity')::numeric-(before->>'quantity')::numeric)),0),
  'known_loss_minor',coalesce((SELECT sum(-(f->>'delta')::numeric*(f->>'unit_cost_minor')::numeric)
   FROM wms_stocktake_review_rows z CROSS JOIN LATERAL jsonb_array_elements(z.fragments) f
   WHERE (z.tenant_id,z.review_id)=(NEW.tenant_id,r.id) AND (f->>'delta')::numeric<0),0)::text,
  'known_surplus_minor',coalesce((SELECT sum((f->>'delta')::numeric*(f->>'unit_cost_minor')::numeric)
   FROM wms_stocktake_review_rows z CROSS JOIN LATERAL jsonb_array_elements(z.fragments) f
   WHERE (z.tenant_id,z.review_id)=(NEW.tenant_id,r.id) AND (f->>'delta')::numeric>0),0)::text,
  'unknown_loss_quantity',coalesce((SELECT sum(-(f->>'delta')::numeric)
   FROM wms_stocktake_review_rows z CROSS JOIN LATERAL jsonb_array_elements(z.fragments) f
   WHERE (z.tenant_id,z.review_id)=(NEW.tenant_id,r.id) AND (f->>'delta')::numeric<0 AND f->>'unit_cost_minor' IS NULL),0))
 INTO expected_summary FROM wms_stocktake_review_rows WHERE (tenant_id,review_id)=(NEW.tenant_id,r.id);
 IF expected_summary IS DISTINCT FROM r.summary OR p.result->'changed' IS DISTINCT FROM
  to_jsonb((expected_summary->>'changed')::bigint>0)
 THEN RAISE EXCEPTION 'Podsumowanie spisu różni się od fizycznego planu' USING ERRCODE='23514';END IF;
 IF EXISTS(WITH expected AS (
  SELECT h.warehouse_id,l.product_id,l.location,
    coalesce((f->>'layer_id')::uuid,c.id) layer_id,(f->>'delta')::numeric delta,
    CASE WHEN f->>'unit_cost_minor' IS NULL THEN NULL ELSE (f->>'delta')::numeric*(f->>'unit_cost_minor')::numeric END value_delta
  FROM wms_stocktake_review_rows z JOIN wms_stocktake_lines l ON
   (l.tenant_id,l.stocktake_id,l.id)=(z.tenant_id,z.stocktake_id,z.line_id)
  CROSS JOIN LATERAL jsonb_array_elements(z.fragments) f
  LEFT JOIN wms_cost_layers c ON (c.tenant_id,c.operation_id,c.stocktake_line_id)=(z.tenant_id,op.id,z.line_id)
    AND f->>'layer_id' IS NULL
  WHERE (z.tenant_id,z.review_id)=(NEW.tenant_id,r.id)
 ), actual AS (
  SELECT warehouse_id,product_id,location,layer_id,sum(delta::numeric) delta,sum(value_delta::numeric) value_delta,count(*) n
  FROM wms_layer_movements WHERE (tenant_id,operation_id)=(NEW.tenant_id,op.id)
  GROUP BY warehouse_id,product_id,location,layer_id
 ) SELECT 1 FROM expected e FULL JOIN actual a USING(warehouse_id,product_id,location,layer_id)
  WHERE e.layer_id IS NULL OR e.delta IS DISTINCT FROM a.delta OR e.value_delta IS DISTINCT FROM a.value_delta OR a.n<>1)
 THEN RAISE EXCEPTION 'Dziennik korekty nie odpowiada dokładnemu planowi partii' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM wms_issue_fragments WHERE (tenant_id,operation_id)=(NEW.tenant_id,op.id)) OR
  EXISTS(SELECT 1 FROM wms_return_fragments WHERE (tenant_id,operation_id)=(NEW.tenant_id,op.id))
 THEN RAISE EXCEPTION 'Inwentaryzacja nie jest sprzedażą lub zwrotem' USING ERRCODE='23514';END IF;
 IF op.result->>'stocktake_id' IS DISTINCT FROM h.id::text OR op.result->>'posting_id' IS DISTINCT FROM p.id::text
  OR op.result->>'review_id' IS DISTINCT FROM r.id::text OR (op.result->>'changed')::bigint IS DISTINCT FROM (expected_summary->>'changed')::bigint
  OR jsonb_typeof(op.result->'rows') IS DISTINCT FROM 'array'
  OR op.result->'summary' IS DISTINCT FROM jsonb_build_object('currency',h.currency,
    'known_delta_minor',((expected_summary->>'known_surplus_minor')::numeric-(expected_summary->>'known_loss_minor')::numeric)::text,
    'unknown_delta_quantity',(-(expected_summary->>'unknown_loss_quantity')::numeric)::text,
    'incoming_quantity',(expected_summary->>'surplus_quantity'),'outgoing_quantity',(expected_summary->>'shortage_quantity'))
  OR jsonb_array_length(op.result->'rows')<>n OR
  (SELECT count(DISTINCT x->>'line_id') FROM jsonb_array_elements(op.result->'rows') x)<>n
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(op.result->'rows') x
   LEFT JOIN wms_stocktake_lines l ON (l.tenant_id,l.stocktake_id,l.id)=(NEW.tenant_id,h.id,(x->>'line_id')::uuid)
   LEFT JOIN wms_stocktake_review_rows z ON (z.tenant_id,z.review_id,z.line_id)=(l.tenant_id,r.id,l.id)
   WHERE l.id IS NULL OR x->>'product_id' IS DISTINCT FROM l.product_id::text OR x->>'location' IS DISTINCT FROM l.location
    OR x->>'lot_id' IS DISTINCT FROM coalesce(l.lot_id::text,(SELECT cl.lot_id::text FROM wms_cost_layers cl
      WHERE (cl.tenant_id,cl.operation_id,cl.stocktake_line_id)=(NEW.tenant_id,op.id,l.id)))
    OR (x->>'delta')::numeric IS DISTINCT FROM (z.after->>'quantity')::numeric-(z.before->>'quantity')::numeric)
 THEN RAISE EXCEPTION 'Wynik operacji ma inny zakres niż rozliczenie' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(op.result->'rows') x CROSS JOIN LATERAL jsonb_array_elements(x->'fragments') f)
   <>(SELECT count(*) FROM wms_layer_movements WHERE (tenant_id,operation_id)=(NEW.tenant_id,op.id))
  OR (SELECT count(DISTINCT f->>'id') FROM jsonb_array_elements(op.result->'rows') x CROSS JOIN LATERAL jsonb_array_elements(x->'fragments') f)
   <>(SELECT count(*) FROM wms_layer_movements WHERE (tenant_id,operation_id)=(NEW.tenant_id,op.id))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(op.result->'rows') x CROSS JOIN LATERAL jsonb_array_elements(x->'fragments') f
    LEFT JOIN wms_stocktake_lines ln ON (ln.tenant_id,ln.stocktake_id,ln.id)=(NEW.tenant_id,h.id,(x->>'line_id')::uuid)
    LEFT JOIN wms_layer_movements m ON (m.tenant_id,m.operation_id,m.id)=(NEW.tenant_id,op.id,(f->>'id')::uuid)
    LEFT JOIN wms_cost_layers cl ON (cl.tenant_id,cl.id)=(m.tenant_id,m.layer_id)
    WHERE m.id IS NULL OR f->>'line_id' IS DISTINCT FROM x->>'line_id' OR f->>'product_id' IS DISTINCT FROM m.product_id::text
      OR m.product_id IS DISTINCT FROM ln.product_id OR m.location IS DISTINCT FROM ln.location
      OR cl.lot_id::text IS DISTINCT FROM x->>'lot_id'
      OR f->>'location' IS DISTINCT FROM m.location OR f->>'layer_id' IS DISTINCT FROM m.layer_id::text
      OR f->>'lot_id' IS DISTINCT FROM cl.lot_id::text OR (f->>'delta')::numeric IS DISTINCT FROM m.delta::numeric
      OR (f->>'quantity')::numeric IS DISTINCT FROM abs(m.delta::numeric)
      OR (f->>'unit_cost_minor')::numeric IS DISTINCT FROM cl.unit_cost_minor::numeric
      OR f->>'currency' IS DISTINCT FROM cl.currency OR (f->>'value_delta')::numeric IS DISTINCT FROM m.value_delta::numeric)
 THEN RAISE EXCEPTION 'Wynik operacji różni się od rzeczywistego dziennika' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;
END $$;
CREATE CONSTRAINT TRIGGER wms_stocktake_post_operation AFTER INSERT ON wms_operations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind='stocktake_post')
 EXECUTE FUNCTION wms_stocktake_post_consistency();
CREATE CONSTRAINT TRIGGER wms_stocktake_post_receipt AFTER INSERT ON wms_stocktake_postings
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wms_stocktake_post_consistency();
