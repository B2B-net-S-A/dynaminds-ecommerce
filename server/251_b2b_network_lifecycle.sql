-- Migration 251_b2b_network_lifecycle (prepared as 258, registered after 250_wms_evidence_settle_unlocked; object names
-- keep the b2b258_ prefix). docs/parity/B2B-LIFECYCLE251-20261028.md.
-- B2B-002 link lifecycle: either company disconnects a link (state, date, side, reason, append-only history); the
-- link is paused, so no new quote, purchase or catalogue read, while orders, receipts, returns and their history
-- stay. A new invitation accepted by the same buyer company reconnects the same link row.
-- B2B-003 mapping lifecycle: unbinding and rebinding a supplier offer from the buyer's own product, and the synced
-- supplier purchase price, with an append-only history. The 144 binding proof stays immutable; an unbound offer is
-- an overlay that the quote, checkout and dropshipping mapping reads honour.
-- B2B-004-X supplier decision: every network purchase waits for the supplier's acceptance until decide_by. The
-- supplier order keeps its ordinary reservation (no oversell); a rejection or an expired decision cancels the
-- supplier order, which releases it. The buyer gets an append-only event per decision and per dispatched parcel.
-- B2B-005 dropshipping tracking: the supplier parcel numbers copied to the seller's customer order (mapping table,
-- one row per supplier parcel), each copy also raised as the customer order event order.dropship_tracking.
--
-- No core table is created, altered, referenced by a foreign key or written: links, accounts, orders, shipments and
-- catalogue items are checked by the application under its locks, and the two link tables by the trigger below,
-- so no RI trigger lands on a core table. Personal data: none (reasons are business text, parcel numbers are the
-- carrier's).

CREATE TABLE b2b258_link_states (
 -- The buyer company, which owns b2b_links.
 tenant_id uuid NOT NULL,
 link_id uuid PRIMARY KEY,
 supplier_tenant_id uuid NOT NULL,
 account_id uuid NOT NULL,
 state text NOT NULL CHECK (state IN ('connected','disconnected')),
 disconnected_side text CHECK (disconnected_side IN ('buyer','supplier')),
 reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
 disconnected_at timestamptz,
 reconnected_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (supplier_tenant_id, account_id),
 UNIQUE (tenant_id, link_id),
 CHECK (tenant_id <> supplier_tenant_id),
 CHECK (state <> 'disconnected' OR (disconnected_at IS NOT NULL AND disconnected_side IS NOT NULL))
);

CREATE TABLE b2b258_link_events (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 link_id uuid NOT NULL,
 supplier_tenant_id uuid NOT NULL,
 account_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('disconnected','reconnected')),
 side text NOT NULL CHECK (side IN ('buyer','supplier')),
 actor_id uuid NOT NULL,
 reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (link_id) REFERENCES b2b258_link_states(link_id)
);
CREATE INDEX b2b258_link_events_link ON b2b258_link_events(tenant_id, link_id, created_at DESC, id DESC);

CREATE TABLE b2b258_mappings (
 tenant_id uuid NOT NULL,
 item_id uuid NOT NULL,
 link_id uuid NOT NULL,
 -- The own product the offer is bound to (bound) or was bound to (unbound).
 product_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'bound' CHECK (state IN ('bound','unbound')),
 -- Supplier purchase price in minor units as last synced from the offer snapshot.
 purchase_price_minor bigint CHECK (purchase_price_minor BETWEEN 0 AND 100000000000),
 purchase_currency text CHECK (purchase_currency ~ '^[A-Z]{3}$'),
 price_synced_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, item_id),
 CHECK ((purchase_price_minor IS NULL) = (purchase_currency IS NULL) AND (purchase_price_minor IS NULL) = (price_synced_at IS NULL))
);
CREATE INDEX b2b258_mappings_link ON b2b258_mappings(tenant_id, link_id, item_id);

CREATE TABLE b2b258_mapping_events (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 item_id uuid NOT NULL,
 link_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('unbound','rebound','price_synced')),
 product_before uuid,
 product_after uuid,
 price_before_minor bigint,
 price_after_minor bigint,
 currency text CHECK (currency ~ '^[A-Z]{3}$'),
 reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, item_id) REFERENCES b2b258_mappings(tenant_id, item_id),
 CHECK (kind <> 'price_synced' OR (price_after_minor IS NOT NULL AND currency IS NOT NULL)),
 CHECK (kind = 'price_synced' OR product_before IS NOT NULL)
);
CREATE INDEX b2b258_mapping_events_item ON b2b258_mapping_events(tenant_id, item_id, created_at DESC, id DESC);

CREATE TABLE b2b258_order_decisions (
 -- The supplier company, which owns the order.
 tenant_id uuid NOT NULL,
 order_id uuid NOT NULL,
 buyer_tenant_id uuid NOT NULL,
 network_order_id uuid NOT NULL UNIQUE,
 link_id uuid NOT NULL,
 account_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','rejected','expired','withdrawn')),
 decide_by timestamptz NOT NULL,
 decided_at timestamptz,
 decided_by uuid,
 -- Who closed the decision: the supplier, its dispatch (an implicit acceptance), the deadline or the buyer's cancel.
 decided_via text CHECK (decided_via IN ('supplier','dispatch','expiry','buyer')),
 reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
 -- The sweep could not close a due decision (for example the supplier order may not be cancelled any more): the
 -- refusal is kept and the row waits until sweep_after, so it never starves the other due decisions.
 sweep_error text CHECK (char_length(sweep_error) <= 500),
 sweep_after timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, order_id),
 CHECK (tenant_id <> buyer_tenant_id),
 CHECK (decide_by > created_at),
 CHECK ((state = 'pending') = (decided_at IS NULL) AND (state = 'pending') = (decided_via IS NULL))
);
CREATE INDEX b2b258_order_decisions_due ON b2b258_order_decisions(decide_by, tenant_id, order_id) WHERE state = 'pending';
CREATE INDEX b2b258_order_decisions_inbox ON b2b258_order_decisions(tenant_id, state, created_at DESC, order_id);
CREATE INDEX b2b258_order_decisions_buyer ON b2b258_order_decisions(buyer_tenant_id, network_order_id);

CREATE TABLE b2b258_order_events (
 id uuid PRIMARY KEY,
 -- The buyer company.
 tenant_id uuid NOT NULL,
 network_order_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('accepted','rejected','expired','withdrawn','dispatched')),
 -- One event per decision and per supplier parcel.
 dedup_key text NOT NULL CHECK (char_length(dedup_key) BETWEEN 1 AND 100),
 detail jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, network_order_id, dedup_key)
);
CREATE INDEX b2b258_order_events_order ON b2b258_order_events(tenant_id, network_order_id, created_at, id);

CREATE TABLE b2b258_tracking_copies (
 -- The seller company, which owns the customer order.
 tenant_id uuid NOT NULL,
 dropship_order_id uuid NOT NULL,
 customer_order_id uuid NOT NULL,
 supplier_tenant_id uuid NOT NULL,
 supplier_order_id uuid NOT NULL,
 source_shipment_id uuid NOT NULL,
 carrier text NOT NULL CHECK (char_length(carrier) BETWEEN 1 AND 100),
 tracking_number text NOT NULL CHECK (char_length(tracking_number) BETWEEN 1 AND 200),
 dispatched_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, dropship_order_id, source_shipment_id),
 CHECK (tenant_id <> supplier_tenant_id)
);
CREATE INDEX b2b258_tracking_copies_customer ON b2b258_tracking_copies(tenant_id, customer_order_id, dispatched_at, source_shipment_id);

-- Both companies write the link state and its history (each through its own scope), so the row must name a real
-- link of exactly that buyer, supplier and account. Read as the owner; never trusts the caller's scope.
CREATE FUNCTION b2b258_link_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.b2b_links l WHERE l.id=NEW.link_id AND l.tenant_id=NEW.tenant_id
   AND l.supplier_tenant_id=NEW.supplier_tenant_id AND l.account_id=NEW.account_id) THEN
  RAISE EXCEPTION 'Stan nie odpowiada połączeniu B2B' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.link_id,NEW.supplier_tenant_id,NEW.account_id) IS DISTINCT FROM (OLD.tenant_id,OLD.link_id,OLD.supplier_tenant_id,OLD.account_id) THEN
  RAISE EXCEPTION 'Niezmienna tożsamość stanu połączenia B2B' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION b2b258_link_guard() FROM PUBLIC;
CREATE TRIGGER b2b258_link_states_guard BEFORE INSERT OR UPDATE ON b2b258_link_states FOR EACH ROW EXECUTE FUNCTION b2b258_link_guard();
CREATE TRIGGER b2b258_link_events_guard BEFORE INSERT ON b2b258_link_events FOR EACH ROW EXECUTE FUNCTION b2b258_link_guard();

-- The supplier finds the link of its own account (b2b_links belongs to the buyer). Only the current tenant's account.
CREATE FUNCTION b2b258_supplier_link(account uuid) RETURNS TABLE(link_id uuid, buyer_tenant_id uuid, supplier_name text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT l.id, l.tenant_id, l.supplier_name FROM public.b2b_links l
 WHERE l.supplier_tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND l.account_id=account
$$;
REVOKE ALL ON FUNCTION b2b258_supplier_link(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b258_supplier_link(uuid) TO dyna_app;

-- Whether an own catalogue offer carries the immutable 144 binding proof (b2b_catalog_bindings has no dyna_app grant).
CREATE FUNCTION b2b258_item_has_proof(item uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS (SELECT 1 FROM public.b2b_catalog_bindings b
  WHERE b.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND b.item_id=item)
$$;
REVOKE ALL ON FUNCTION b2b258_item_has_proof(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b258_item_has_proof(uuid) TO dyna_app;

ALTER TABLE b2b258_link_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b258_link_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b258_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b258_mapping_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b258_order_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b258_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b258_tracking_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b258_link_states FORCE ROW LEVEL SECURITY;
ALTER TABLE b2b258_link_events FORCE ROW LEVEL SECURITY;
ALTER TABLE b2b258_mappings FORCE ROW LEVEL SECURITY;
ALTER TABLE b2b258_mapping_events FORCE ROW LEVEL SECURITY;
ALTER TABLE b2b258_order_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE b2b258_order_events FORCE ROW LEVEL SECURITY;
ALTER TABLE b2b258_tracking_copies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON b2b258_link_states USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON b2b258_link_events USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
-- The supplier of the link reads and writes its state and history from its own scope (the guard checks the link).
CREATE POLICY supplier_side ON b2b258_link_states TO dyna_app USING (supplier_tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (supplier_tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY supplier_side ON b2b258_link_events TO dyna_app USING (supplier_tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (supplier_tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON b2b258_mappings USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON b2b258_mapping_events USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON b2b258_order_decisions USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
-- The buyer reads the decision on its own purchase.
CREATE POLICY buyer_read ON b2b258_order_decisions FOR SELECT TO dyna_app USING (buyer_tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON b2b258_order_events USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON b2b258_tracking_copies USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON TABLE b2b258_link_states, b2b258_link_events, b2b258_mappings, b2b258_mapping_events, b2b258_order_decisions, b2b258_order_events, b2b258_tracking_copies FROM PUBLIC,dyna_app;
-- No DELETE or TRUNCATE for the application role; histories, events and copies are append-only.
GRANT SELECT,INSERT,UPDATE ON TABLE b2b258_link_states, b2b258_mappings, b2b258_order_decisions TO dyna_app;
GRANT SELECT,INSERT ON TABLE b2b258_link_events, b2b258_mapping_events, b2b258_order_events, b2b258_tracking_copies TO dyna_app;
