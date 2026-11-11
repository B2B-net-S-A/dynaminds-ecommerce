CREATE TABLE payment_import_namespaces (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,client_key uuid NOT NULL,request_hash text NOT NULL,
 label text NOT NULL,source_kind text NOT NULL CHECK(source_kind IN ('bank_statement','carrier_report','shared_settlement')),
 version integer NOT NULL DEFAULT 1,enabled boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key)
);
CREATE TABLE payment_import_profiles (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,namespace_id uuid NOT NULL,client_key uuid NOT NULL,request_hash text NOT NULL,
 definition jsonb NOT NULL,version integer NOT NULL DEFAULT 1,approved_by uuid NOT NULL REFERENCES users,deleted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,namespace_id) REFERENCES payment_import_namespaces(tenant_id,id)
);
CREATE TABLE payment_import_profile_revisions (
 tenant_id uuid NOT NULL,profile_id uuid NOT NULL,version integer NOT NULL,definition jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES users,deleted boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,profile_id,version),FOREIGN KEY(tenant_id,profile_id) REFERENCES payment_import_profiles(tenant_id,id)
);
CREATE TABLE payment_import_files (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,file_hash text NOT NULL,byte_count integer NOT NULL CHECK(byte_count BETWEEN 1 AND 5242880),
 encrypted_bytes text NOT NULL,filename text NOT NULL,parser_version text NOT NULL,actor_id uuid NOT NULL REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,file_hash)
);
CREATE TABLE payment_import_upload_requests (
 tenant_id uuid NOT NULL,client_key uuid NOT NULL,request_hash text NOT NULL,file_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,client_key),FOREIGN KEY(tenant_id,file_id) REFERENCES payment_import_files(tenant_id,id)
);
CREATE TABLE payment_import_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,client_key uuid NOT NULL,request_hash text NOT NULL,kind text NOT NULL CHECK(kind IN ('import','correction')),
 file_id uuid,profile_id uuid,profile_version integer,namespace_id uuid,namespace_version integer,profile jsonb,parent_id uuid,
 version integer NOT NULL DEFAULT 1,scope_hash text NOT NULL,summary jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,file_id) REFERENCES payment_import_files(tenant_id,id),
 FOREIGN KEY(tenant_id,profile_id,profile_version) REFERENCES payment_import_profile_revisions(tenant_id,profile_id,version),
 FOREIGN KEY(tenant_id,namespace_id) REFERENCES payment_import_namespaces(tenant_id,id),FOREIGN KEY(tenant_id,parent_id) REFERENCES payment_import_previews(tenant_id,id),
 CHECK((kind='import' AND file_id IS NOT NULL AND profile_id IS NOT NULL AND namespace_id IS NOT NULL AND profile IS NOT NULL) OR kind='correction')
);
CREATE INDEX payment_import_preview_history ON payment_import_previews(tenant_id,created_at DESC,id DESC);
CREATE TABLE payment_import_rows (
 tenant_id uuid NOT NULL,preview_id uuid NOT NULL,row_id uuid NOT NULL,position integer NOT NULL CHECK(position BETWEEN 0 AND 4999),
 classification text NOT NULL CHECK(classification IN ('ready','duplicate','invalid','unmatched','ambiguous','conflict','review')),
 source jsonb NOT NULL,evidence jsonb NOT NULL,issues jsonb NOT NULL,operation text NOT NULL CHECK(operation IN ('apply','link_existing','reverse')),
 allocation jsonb,snapshot jsonb,economic_key text,payload_hash text,linked_receipt_id uuid,
 PRIMARY KEY(tenant_id,preview_id,row_id),UNIQUE(tenant_id,preview_id,position),FOREIGN KEY(tenant_id,preview_id) REFERENCES payment_import_previews(tenant_id,id)
);
CREATE TABLE payment_import_executions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,client_key uuid NOT NULL,request_hash text NOT NULL,preview_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('import','correction')),
 scope_hash text NOT NULL,consent jsonb NOT NULL,selected_count integer NOT NULL CHECK(selected_count BETWEEN 1 AND 100),currency text NOT NULL,total_minor text NOT NULL,fee_minor text NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,job_id uuid NOT NULL,state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','done','conflict','failed','cancelled')),
 error text,result jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,preview_id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,preview_id) REFERENCES payment_import_previews(tenant_id,id),FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),
 CHECK(state='queued' OR finished_at IS NOT NULL)
);
CREATE INDEX payment_import_execution_history ON payment_import_executions(tenant_id,created_at DESC,id DESC);
CREATE INDEX payment_import_execution_active ON payment_import_executions(tenant_id,id) WHERE state='queued';
CREATE TABLE payment_import_execution_rows (
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,preview_id uuid NOT NULL,row_id uuid NOT NULL,position integer NOT NULL CHECK(position BETWEEN 0 AND 99),
 PRIMARY KEY(tenant_id,execution_id,row_id),UNIQUE(tenant_id,execution_id,position),
 FOREIGN KEY(tenant_id,execution_id,preview_id) REFERENCES payment_import_executions(tenant_id,id,preview_id),FOREIGN KEY(tenant_id,preview_id,row_id) REFERENCES payment_import_rows(tenant_id,preview_id,row_id)
);
CREATE TABLE payment_import_claims (
 tenant_id uuid NOT NULL,namespace_id uuid NOT NULL,economic_key text NOT NULL,payload_hash text NOT NULL,execution_id uuid NOT NULL,row_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','applied')),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,namespace_id,economic_key),FOREIGN KEY(tenant_id,namespace_id) REFERENCES payment_import_namespaces(tenant_id,id),
 FOREIGN KEY(tenant_id,execution_id,row_id) REFERENCES payment_import_execution_rows(tenant_id,execution_id,row_id)
);
CREATE INDEX payment_import_claim_execution ON payment_import_claims(tenant_id,execution_id,economic_key);
CREATE TABLE payment_import_receipts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,execution_id uuid NOT NULL,row_id uuid NOT NULL,order_id uuid NOT NULL,entry_id uuid NOT NULL,shipment_id uuid,
 kind text NOT NULL,amount integer NOT NULL,fee integer NOT NULL,currency text NOT NULL,booking_date date NOT NULL,before_balance jsonb NOT NULL,after_balance jsonb NOT NULL,result_version bigint NOT NULL,
 operation text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,execution_id,row_id),
 FOREIGN KEY(tenant_id,execution_id,row_id) REFERENCES payment_import_execution_rows(tenant_id,execution_id,row_id),
 FOREIGN KEY(tenant_id,order_id,entry_id) REFERENCES payment_entries(tenant_id,order_id,id),FOREIGN KEY(tenant_id,order_id,shipment_id) REFERENCES shipments(tenant_id,order_id,id)
);
ALTER TABLE payment_import_rows ADD FOREIGN KEY(tenant_id,linked_receipt_id) REFERENCES payment_import_receipts(tenant_id,id);
CREATE INDEX payment_import_receipt_evidence ON payment_import_receipts(tenant_id,shipment_id,kind,amount,fee,booking_date);
CREATE INDEX payment_import_receipt_order ON payment_import_receipts(tenant_id,order_id,kind,amount,booking_date);
CREATE TABLE order_local_financial_fences (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,order_version bigint NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,order_id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
-- Existing unique order number and channel/external indexes cover order matching.
CREATE INDEX payment_import_tracking_match ON shipments(tenant_id,carrier,tracking_number,order_id);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payment_import_namespaces','payment_import_profiles','payment_import_profile_revisions','payment_import_files','payment_import_upload_requests','payment_import_previews','payment_import_rows','payment_import_executions','payment_import_execution_rows','payment_import_claims','payment_import_receipts','order_local_financial_fences'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
END LOOP;END $$;
GRANT UPDATE ON payment_import_namespaces,payment_import_profiles,payment_import_executions,payment_import_claims,order_local_financial_fences TO dyna_app;
GRANT DELETE ON payment_import_claims TO dyna_app;
-- Restrictive policy applies in addition to tenant isolation. Applied identities never release.
CREATE POLICY claim_release ON payment_import_claims AS RESTRICTIVE FOR DELETE TO dyna_app USING(state='reserved' AND EXISTS(SELECT 1 FROM payment_import_executions e WHERE e.tenant_id=payment_import_claims.tenant_id AND e.id=payment_import_claims.execution_id AND e.state IN ('conflict','failed','cancelled')));
CREATE FUNCTION payment_import_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'Payment import evidence is immutable';END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payment_import_profile_revisions','payment_import_files','payment_import_upload_requests','payment_import_previews','payment_import_rows','payment_import_execution_rows','payment_import_receipts'] LOOP
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION payment_import_immutable()',t);
END LOOP;END $$;
CREATE FUNCTION payment_import_config_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF NEW.version<>OLD.version+1 OR ROW(NEW.id,NEW.tenant_id,NEW.client_key,NEW.request_hash,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.client_key,OLD.request_hash,OLD.created_at) THEN RAISE EXCEPTION 'Payment format requires next version';END IF;
 IF TG_TABLE_NAME='payment_import_namespaces' THEN IF NEW.source_kind IS DISTINCT FROM OLD.source_kind THEN RAISE EXCEPTION 'Payment namespace identity is immutable';END IF;
 ELSE IF NEW.namespace_id IS DISTINCT FROM OLD.namespace_id OR OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Payment profile identity is immutable';END IF;END IF;
 RETURN NEW;END $$;
CREATE TRIGGER config_guard BEFORE UPDATE ON payment_import_namespaces FOR EACH ROW EXECUTE FUNCTION payment_import_config_guard();
CREATE TRIGGER config_guard BEFORE UPDATE ON payment_import_profiles FOR EACH ROW EXECUTE FUNCTION payment_import_config_guard();
CREATE FUNCTION payment_import_execution_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['state','error','result','finished_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','error','result','finished_at']) OR OLD.state<>'queued' THEN RAISE EXCEPTION 'Payment execution scope and terminal result are immutable';END IF;
 IF NEW.state='done' AND (SELECT count(*) FROM payment_import_receipts WHERE tenant_id=NEW.tenant_id AND execution_id=NEW.id)<>NEW.selected_count THEN RAISE EXCEPTION 'Payment success requires every durable receipt';END IF;
 IF NEW.state IN ('conflict','failed','cancelled') AND EXISTS(SELECT 1 FROM payment_import_receipts WHERE tenant_id=NEW.tenant_id AND execution_id=NEW.id) THEN RAISE EXCEPTION 'Applied receipts cannot become failure';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER execution_guard BEFORE UPDATE ON payment_import_executions FOR EACH ROW EXECUTE FUNCTION payment_import_execution_guard();
CREATE FUNCTION payment_import_claim_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='INSERT' THEN IF NEW.state<>'reserved' OR NOT EXISTS(SELECT 1 FROM payment_import_execution_rows x JOIN payment_import_rows r ON (r.tenant_id,r.preview_id,r.row_id)=(x.tenant_id,x.preview_id,x.row_id) JOIN payment_import_previews p ON (p.tenant_id,p.id)=(r.tenant_id,r.preview_id) JOIN payment_import_executions e ON (e.tenant_id,e.id)=(x.tenant_id,x.execution_id) WHERE x.tenant_id=NEW.tenant_id AND x.execution_id=NEW.execution_id AND x.row_id=NEW.row_id AND p.namespace_id=NEW.namespace_id AND r.economic_key=NEW.economic_key AND r.payload_hash=NEW.payload_hash AND e.state='queued') THEN RAISE EXCEPTION 'Claim must match frozen execution row';END IF;RETURN NEW;END IF;
 IF TG_OP='DELETE' THEN IF OLD.state<>'reserved' OR EXISTS(SELECT 1 FROM payment_import_receipts WHERE tenant_id=OLD.tenant_id AND execution_id=OLD.execution_id AND row_id=OLD.row_id) OR NOT EXISTS(SELECT 1 FROM payment_import_executions WHERE tenant_id=OLD.tenant_id AND id=OLD.execution_id AND state IN ('conflict','failed','cancelled')) THEN RAISE EXCEPTION 'Applied payment identity is immutable';END IF;RETURN OLD;END IF;
 IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR OLD.state<>'reserved' OR NEW.state<>'applied' OR NOT EXISTS(SELECT 1 FROM payment_import_receipts WHERE tenant_id=NEW.tenant_id AND execution_id=NEW.execution_id AND row_id=NEW.row_id) THEN RAISE EXCEPTION 'Payment claim identity is immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER claim_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_import_claims FOR EACH ROW EXECUTE FUNCTION payment_import_claim_guard();
CREATE FUNCTION payment_import_receipt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM payment_import_execution_rows x JOIN payment_import_rows r ON (r.tenant_id,r.preview_id,r.row_id)=(x.tenant_id,x.preview_id,x.row_id) JOIN payment_import_executions e ON (e.tenant_id,e.id)=(x.tenant_id,x.execution_id) JOIN payment_entries p ON (p.tenant_id,p.order_id,p.id)=(NEW.tenant_id,NEW.order_id,NEW.entry_id) WHERE x.tenant_id=NEW.tenant_id AND x.execution_id=NEW.execution_id AND x.row_id=NEW.row_id AND e.state='queued' AND (r.allocation->>'order_id')::uuid=NEW.order_id AND (r.allocation->>'shipment_id')::uuid IS NOT DISTINCT FROM NEW.shipment_id AND r.operation=NEW.operation AND NEW.currency=p.currency AND NEW.kind=r.source->'normalized'->>'ledger_kind' AND (r.source->'normalized'->>'ledger_amount')::integer=NEW.amount AND (r.source->'normalized'->>'ledger_fee')::integer=NEW.fee AND ((NEW.operation='reverse' AND p.kind='reversal' AND p.reversal_of=(r.source->>'entry_id')::uuid AND p.amount=-NEW.amount AND p.fee=-NEW.fee) OR (NEW.operation<>'reverse' AND p.kind=NEW.kind AND p.amount=NEW.amount AND p.fee=NEW.fee))) THEN RAISE EXCEPTION 'Receipt must match frozen allocation and durable entry';END IF;RETURN NEW;END $$;
CREATE TRIGGER receipt_guard BEFORE INSERT ON payment_import_receipts FOR EACH ROW EXECUTE FUNCTION payment_import_receipt_guard();
