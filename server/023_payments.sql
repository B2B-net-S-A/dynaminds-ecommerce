ALTER TABLE orders ADD COLUMN payment_mode text NOT NULL DEFAULT 'prepaid' CHECK(payment_mode IN ('prepaid','cod'));
ALTER TABLE shipments ADD COLUMN cod_expected integer NOT NULL DEFAULT 0 CHECK(cod_expected>=0);
ALTER TABLE shipments ADD UNIQUE(tenant_id,order_id,id);
-- Preserve the actual COD requested on historical labels; do not infer a payment mode or collection.
UPDATE shipments s SET cod_expected=coalesce((p.input->>'cod')::integer,0) FROM shipping_plans p WHERE p.tenant_id=s.tenant_id AND p.order_id=s.order_id AND p.shipment_id=s.id AND s.cod_expected IS DISTINCT FROM coalesce((p.input->>'cod')::integer,0);
CREATE TABLE payment_entries (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,client_key text NOT NULL,request jsonb NOT NULL,
 kind text NOT NULL CHECK(kind IN ('receipt','courier_collection','courier_remittance','refund','reversal')),
 amount integer NOT NULL,fee integer NOT NULL DEFAULT 0,currency text NOT NULL,
 method text NOT NULL,reference text NOT NULL,note text NOT NULL DEFAULT '',
 actor_id uuid REFERENCES users,shipment_id uuid,return_id uuid,reversal_of uuid,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,order_id,id),UNIQUE(tenant_id,order_id,client_key),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,shipment_id) REFERENCES shipments(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,order_id,reversal_of) REFERENCES payment_entries(tenant_id,order_id,id),
 CHECK((kind='reversal' AND reversal_of IS NOT NULL AND amount<=0 AND fee<=0 AND amount::bigint+fee<0) OR
 (kind<>'reversal' AND reversal_of IS NULL AND amount>=0 AND fee>=0 AND amount::bigint+fee>0)),
 CHECK(fee=0 OR kind IN ('courier_remittance','reversal')),
 CHECK(kind NOT IN ('courier_collection','courier_remittance') OR shipment_id IS NOT NULL)
);
CREATE UNIQUE INDEX payment_one_reversal ON payment_entries(tenant_id,order_id,reversal_of) WHERE reversal_of IS NOT NULL;
CREATE INDEX payment_order_history ON payment_entries(tenant_id,order_id,created_at DESC,id DESC);
CREATE INDEX payment_shipment ON payment_entries(tenant_id,order_id,shipment_id) WHERE shipment_id IS NOT NULL;
-- Historical status is a declaration, not verified bank evidence. Never changes orders/stock.
INSERT INTO payment_entries(id,tenant_id,order_id,client_key,request,kind,amount,currency,method,reference)
 SELECT gen_random_uuid(),o.tenant_id,o.id,'historical-paid','{}','receipt',o.total,o.currency,'historical_status','Historyczna deklaracja opłacenia'
 FROM orders o WHERE o.total>0 AND (o.status IN ('paid','picking','packed','shipped','delivered','completed','return_initiated','return_received','return_completed') OR EXISTS(SELECT 1 FROM order_events e WHERE e.tenant_id=o.tenant_id AND e.order_id=o.id AND e.kind='order.paid'));
INSERT INTO payment_entries(id,tenant_id,order_id,client_key,request,kind,amount,currency,method,reference,return_id)
 SELECT gen_random_uuid(),r.tenant_id,r.order_id,'historical-refund:'||r.id,'{}','refund',(r.settlement->>'amount')::integer,o.currency,'historical_confirmation',r.settlement->>'reference',r.id
 FROM return_cases r JOIN orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id) WHERE r.settlement IS NOT NULL AND (r.settlement->>'amount')::integer>0;
ALTER TABLE payment_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON payment_entries TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON payment_entries TO dyna_app;
