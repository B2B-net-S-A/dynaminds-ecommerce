-- 166 delivery sidecar. Managed producer and final native terminal.
-- Root migration runner appends 166_buyer_address_sidecar in this same TX.
-- Four new tables (556 -> 560), no parent columns/indexes/user triggers or data.
-- Child FKs DO add parent internal RI triggers. Native157-162 fingerprints
-- exclude those via NOT tgisinternal (158:279/280,159:367/368,160:663/664);
-- parent trigger bags selecting family tgfoid exclude RI_FKey_* functions.
-- Actual full-catalog preservation must declare those RI additions precisely.
-- SQL structural evidence is not an independent buyer/admin actor certificate.
-- Mutation privileges remain private; reviewed SD producers are the only app writers.
--
-- Accepted wire: delivery has exactly recipient_name/street/city/postal_code/
-- country/phone (pure core166 81348a18). Ciphertext uses security.ts encrypt:
-- base64(IV12 || GCMtag16 || UTF8 JSON ciphertext). SQL verifies envelope and
-- ciphertext digest; authenticated decrypt + strict semantics are service gates.
-- Original orders.address/customer_name/email/source snapshots and fiscal buyer
-- remain literal. Changed delivery: one UPDATE orders SET updated_at=... causes
-- existing order_version trigger +1; no-op and policy-only: order UPDATE zero.
-- Current pointer/own CAS is mutable only through a same-TX receipt. Receipts
-- are the complete immutable policy/address history; no separate history copy.
-- State absence means enabled=false, version=delivery_version=0, kind=unknown.
-- No backfill, inferred canonical kind, automatic opt-in or provider delivery.
-- Classification origin is adapter-canonical evidence OR explicit current-admin
-- choice (recorded in encrypted evidence). A nonempty original locker_code
-- always forbids address classification, even after operator confirmation.
--
-- Managed production: order FIRST lock; actual token/policy + order CAS; canonical
-- delivery-kind evidence; all dependent shipping/parcel/picking/packing/financial
-- guards; bounded preview quota; native clock after sibling waits; SAME TX
-- consent/receipt/state/order touch/local PII-free audit. Replays recheck fresh
-- token/admin but never mutate historical receipts or reapply a delivery.
-- DPD uses shipping_plans(input.provider=dpd); do not invent dpd_shipping_plans.
-- order_parcel_plans has no state; active packing_sessions incl expired block;
-- picking-wave guard reads wave under order lock without taking reverse wave lock.
-- New shipping previews must bind effective delivery/version/hash explicitly;
-- old attempted provider payload/reconcile remains frozen. No country/pickup edit.
-- Root owns route readonly423-beforeparse/CSP/rate limits and recovery wiring.
-- Generic dump includes the new tables, but recovery.ts has an explicit AEAD
-- decrypt registry: add all three encrypted evidence/override families there
-- before claiming verified restored address semantics (cipher hash is not AEAD).
SET LOCAL TimeZone='UTC';

CREATE TEMP TABLE buyer_address_install_basis ON COMMIT DROP AS
 SELECT pg_current_xact_id()::text root_xid,transaction_timestamp() start_at,
 pg_backend_pid() backend_pid,current_user::text owner_name,NULL::jsonb predecessors;
REVOKE ALL ON pg_temp.buyer_address_install_basis FROM PUBLIC,dyna_app;
DO $$ BEGIN
 IF current_user IS DISTINCT FROM session_user
  OR NOT EXISTS(SELECT FROM public.migrations WHERE name='165_competitor_observation_portability')
  OR NOT public.competitor_observation_guards()
  OR NOT public.financial_return_guards() OR NOT public.b2b_credit_guards()
  OR NOT public.b2b_invoice_guards() OR NOT public.fa3_draft_guards()
  OR NOT public.local_invoice_guards()
  OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'buyer_address_'))
  OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'buyer_address_'))
  OR EXISTS(SELECT FROM pg_trigger WHERE starts_with(tgname,'buyer_address_'))
  OR EXISTS(SELECT FROM public.migrations WHERE name='166_buyer_address_sidecar')
 THEN RAISE EXCEPTION '166 requires intact165 and no buyer-address remnants' USING ERRCODE='55000';END IF;
END $$;

CREATE FUNCTION buyer_address_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE
 SET search_path=pg_catalog,public AS $$ SELECT encode(sha256(convert_to(v::text,'UTF8')),'hex') $$;
CREATE FUNCTION buyer_address_cipher_valid(v text,bytes integer,digest text) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE decoded bytea;
BEGIN
 IF v IS NULL OR bytes IS NULL OR digest IS NULL OR bytes NOT BETWEEN 2 AND 65536
  OR octet_length(v)>87420 OR v !~ '^[A-Za-z0-9+/]+={0,2}$' OR digest !~ '^[a-f0-9]{64}$' THEN RETURN false;END IF;
 BEGIN decoded:=decode(v,'base64');EXCEPTION WHEN data_exception THEN RETURN false;END;
 RETURN octet_length(decoded)=bytes+28
  AND replace(encode(decoded,'base64'),E'\n','')=v
  AND encode(sha256(convert_to(v,'UTF8')),'hex')=digest;
END $$;
CREATE FUNCTION buyer_address_predecessors() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('fingerprints',jsonb_build_object(
 '157',public.local_invoice_fingerprint(),'158',public.fa3_draft_fingerprint(),
 '159',public.b2b_invoice_fingerprint(),'160',public.b2b_credit_fingerprint(),
 '161',public.credit_source_upgrade_fingerprint(),'162',public.financial_return_fingerprint(),
 '165',public.competitor_observation_fingerprint()),'certificates',jsonb_build_object(
 'local_invoice_manifest',(SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM public.local_invoice_manifest m),
 'fa3_draft_manifest',(SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM public.fa3_draft_manifest m),
 'b2b_invoice_upgrade',(SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM public.b2b_invoice_upgrade m),
 'b2b_credit_upgrade',(SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM public.b2b_credit_upgrade m),
 'credit_source_upgrade_certificate',(SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM public.credit_source_upgrade_certificate m),
 'financial_return_upgrade_certificate',(SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM public.financial_return_upgrade_certificate m),
 'competitor_observation_manifest',(SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM public.competitor_observation_manifest m)))
$$;
UPDATE pg_temp.buyer_address_install_basis SET predecessors=public.buyer_address_predecessors();

CREATE FUNCTION buyer_address_state_shape(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE
 SET search_path=pg_catalog,public AS $$
DECLARE n bigint;d bigint;
BEGIN
 IF v IS NULL OR jsonb_typeof(v)<>'object' THEN RETURN false;END IF;
 IF(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v) keys(key)) IS DISTINCT FROM
  ARRAY['classification_origin','delivery_kind','delivery_override_encrypted','delivery_version','enabled','last_receipt_id','override_byte_count','override_sha256','version']::text[]
  OR jsonb_typeof(v->'version') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'delivery_version') IS DISTINCT FROM 'string'
  OR NOT coalesce(v->>'version' ~ '^(0|[1-9][0-9]{0,18})$',false)
  OR NOT coalesce(v->>'delivery_version' ~ '^(0|[1-9][0-9]{0,18})$',false)
  OR jsonb_typeof(v->'enabled') IS DISTINCT FROM 'boolean'
  OR NOT coalesce(v->>'delivery_kind' IN('address','pickup_point','unknown'),false)
  OR NOT coalesce(v->>'classification_origin' IN('unknown','operator_confirmed','adapter'),false)
 THEN RETURN false;END IF;
 BEGIN n:=(v->>'version')::bigint;d:=(v->>'delivery_version')::bigint;EXCEPTION WHEN numeric_value_out_of_range THEN RETURN false;END;
 IF d>n OR((v->>'delivery_kind'='unknown') IS DISTINCT FROM(v->>'classification_origin'='unknown')) THEN RETURN false;END IF;
 IF n=0 THEN RETURN v=jsonb_build_object('version','0','delivery_version','0','enabled',false,'delivery_kind','unknown','classification_origin','unknown','delivery_override_encrypted',NULL,'override_byte_count',NULL,'override_sha256',NULL,'last_receipt_id',NULL);END IF;
 IF jsonb_typeof(v->'last_receipt_id') IS DISTINCT FROM 'string' OR NOT coalesce(v->>'last_receipt_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) THEN RETURN false;END IF;
 IF d=0 THEN RETURN v->'delivery_override_encrypted'='null'::jsonb AND v->'override_byte_count'='null'::jsonb AND v->'override_sha256'='null'::jsonb;END IF;
 IF v->>'delivery_kind'<>'address' OR jsonb_typeof(v->'delivery_override_encrypted') IS DISTINCT FROM 'string'
  OR jsonb_typeof(v->'override_byte_count') IS DISTINCT FROM 'number' OR NOT coalesce(v->>'override_byte_count' ~ '^[1-9][0-9]{0,4}$',false)
  OR jsonb_typeof(v->'override_sha256') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
 RETURN public.buyer_address_cipher_valid(v->>'delivery_override_encrypted',(v->>'override_byte_count')::integer,v->>'override_sha256');
END $$;
CREATE TABLE buyer_address_state(
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,
 version bigint NOT NULL CHECK(version>0),delivery_version bigint NOT NULL CHECK(delivery_version>=0),
 enabled boolean NOT NULL,delivery_kind text NOT NULL DEFAULT 'unknown' CHECK(delivery_kind IN('address','pickup_point','unknown')),
 classification_origin text NOT NULL DEFAULT 'unknown' CHECK(classification_origin IN('unknown','operator_confirmed','adapter')),
 CHECK((delivery_kind='unknown' AND classification_origin='unknown') OR(delivery_kind<>'unknown' AND classification_origin<>'unknown')),
 delivery_override_encrypted text,override_byte_count integer,override_sha256 text,
 last_receipt_id uuid NOT NULL,updated_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,order_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES public.orders(tenant_id,id),
 CHECK((delivery_override_encrypted IS NULL AND override_byte_count IS NULL AND override_sha256 IS NULL)
  OR(delivery_override_encrypted IS NOT NULL AND delivery_kind='address'
   AND buyer_address_cipher_valid(delivery_override_encrypted,override_byte_count,override_sha256))),
 CHECK((delivery_version=0 AND delivery_override_encrypted IS NULL)
  OR(delivery_version>0 AND delivery_override_encrypted IS NOT NULL))
);
CREATE TABLE buyer_address_previews(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,client_key uuid NOT NULL,reserved_receipt_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('access','delivery')),actor_id uuid REFERENCES public.users(id),api_key_id uuid,token_digest text,
 expected_order_version bigint NOT NULL CHECK(expected_order_version>0),
 before_state jsonb NOT NULL CHECK(buyer_address_state_shape(before_state)),after_state jsonb NOT NULL CHECK(buyer_address_state_shape(after_state)),
 buyer_basis_hash text NOT NULL CHECK(buyer_basis_hash ~ '^[a-f0-9]{64}$'),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 evidence_encrypted text NOT NULL,evidence_byte_count integer NOT NULL,evidence_sha256 text NOT NULL,
 changed boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,order_id,id),UNIQUE(tenant_id,order_id,client_key),UNIQUE(tenant_id,reserved_receipt_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES public.orders(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id),
 CHECK((kind='access' AND actor_id IS NOT NULL AND token_digest IS NULL)
  OR(kind='delivery' AND actor_id IS NULL AND api_key_id IS NULL AND token_digest IS NOT NULL AND token_digest ~ '^[a-f0-9]{64}$')),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes'),
 CHECK(buyer_address_cipher_valid(evidence_encrypted,evidence_byte_count,evidence_sha256))
);
CREATE TABLE buyer_address_receipts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,preview_id uuid NOT NULL,client_key uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('access','delivery')),actor_id uuid REFERENCES public.users(id),api_key_id uuid,token_digest text,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 buyer_basis_hash text NOT NULL CHECK(buyer_basis_hash ~ '^[a-f0-9]{64}$'),
 before_order_version bigint NOT NULL CHECK(before_order_version>0),after_order_version bigint NOT NULL,
 before_state jsonb NOT NULL CHECK(buyer_address_state_shape(before_state)),after_state jsonb NOT NULL CHECK(buyer_address_state_shape(after_state)),
 evidence_encrypted text NOT NULL,evidence_byte_count integer NOT NULL,evidence_sha256 text NOT NULL,
 changed boolean NOT NULL,top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,order_id,id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,order_id,client_key),
 FOREIGN KEY(tenant_id,order_id,preview_id) REFERENCES buyer_address_previews(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES public.orders(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id),
 CHECK((kind='access' AND actor_id IS NOT NULL AND token_digest IS NULL)
  OR(kind='delivery' AND actor_id IS NULL AND api_key_id IS NULL AND token_digest IS NOT NULL AND token_digest ~ '^[a-f0-9]{64}$')),
 CHECK(after_order_version=before_order_version+CASE WHEN kind='delivery' AND changed THEN 1 ELSE 0 END),
 CHECK(buyer_address_cipher_valid(evidence_encrypted,evidence_byte_count,evidence_sha256))
);
ALTER TABLE buyer_address_state ADD FOREIGN KEY(tenant_id,order_id,last_receipt_id)
 REFERENCES buyer_address_receipts(tenant_id,order_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX buyer_address_preview_page ON buyer_address_previews(tenant_id,order_id,created_at DESC,id DESC);
CREATE INDEX buyer_address_preview_actor ON buyer_address_previews(actor_id);
CREATE INDEX buyer_address_preview_api_key ON buyer_address_previews(tenant_id,api_key_id);
CREATE INDEX buyer_address_history_page ON buyer_address_receipts(tenant_id,order_id,created_at DESC,id DESC);
CREATE INDEX buyer_address_receipt_actor ON buyer_address_receipts(actor_id);
CREATE INDEX buyer_address_receipt_api_key ON buyer_address_receipts(tenant_id,api_key_id);
CREATE TABLE buyer_address_manifest(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 profile text NOT NULL CHECK(profile='delivery-sidecar-managed/v1'),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 predecessor_certificates jsonb NOT NULL CHECK(jsonb_typeof(predecessor_certificates)='object'),
 installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $$ DECLARE relation_name text; BEGIN
 FOREACH relation_name IN ARRAY ARRAY['buyer_address_state','buyer_address_previews','buyer_address_receipts'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',relation_name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON public.%I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))$policy$,relation_name);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',relation_name);
  EXECUTE format('GRANT SELECT ON public.%I TO dyna_app',relation_name);
 END LOOP;
END $$;
REVOKE ALL ON buyer_address_manifest FROM PUBLIC,dyna_app;
CREATE FUNCTION buyer_address_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Buyer address evidence is immutable' USING ERRCODE='23514';END $$;
CREATE TRIGGER buyer_address_preview_immutable BEFORE UPDATE OR DELETE ON buyer_address_previews FOR EACH ROW EXECUTE FUNCTION buyer_address_immutable();
CREATE TRIGGER buyer_address_receipt_immutable BEFORE UPDATE OR DELETE ON buyer_address_receipts FOR EACH ROW EXECUTE FUNCTION buyer_address_immutable();
CREATE TRIGGER buyer_address_manifest_immutable BEFORE UPDATE OR DELETE ON buyer_address_manifest FOR EACH ROW EXECUTE FUNCTION buyer_address_immutable();

-- Exact private pointer projection; contains ciphertext, never plaintext address.
CREATE FUNCTION buyer_address_state_projection(s buyer_address_state) RETURNS jsonb LANGUAGE sql IMMUTABLE
 SET search_path=pg_catalog,public AS $$ SELECT jsonb_build_object(
 'version',s.version::text,'delivery_version',s.delivery_version::text,'enabled',s.enabled,
 'delivery_kind',s.delivery_kind,'classification_origin',s.classification_origin,'delivery_override_encrypted',s.delivery_override_encrypted,
 'override_byte_count',s.override_byte_count,'override_sha256',s.override_sha256,'last_receipt_id',s.last_receipt_id) $$;
CREATE FUNCTION buyer_address_current_state(t uuid,o uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT public.buyer_address_state_projection(s) FROM public.buyer_address_state s WHERE(s.tenant_id,s.order_id)=(t,o) AND t=nullif(current_setting('app.tenant_id',true),'')::uuid),
 jsonb_build_object('version','0','delivery_version','0','enabled',false,'delivery_kind','unknown','classification_origin','unknown',
 'delivery_override_encrypted',NULL,'override_byte_count',NULL,'override_sha256',NULL,'last_receipt_id',NULL))
$$;
CREATE FUNCTION buyer_address_buyer_basis(t uuid,oid uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
 SELECT public.buyer_address_hash(jsonb_build_object('tenant_id',o.tenant_id,'order_id',o.id,
 'customer_name',o.customer_name,'email',o.email,'address',o.address))
 FROM public.orders o WHERE(o.tenant_id,o.id)=(t,oid) AND t=nullif(current_setting('app.tenant_id',true),'')::uuid
$$;
-- Producer must take order FIRST; this insertion also serializes the public
-- per-order preview quota. It never acquires a wave/channel/job lock afterward.
CREATE FUNCTION buyer_address_preview_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE ord public.orders%ROWTYPE;state jsonb;active integer;
BEGIN
 SELECT * INTO ord FROM public.orders WHERE(tenant_id,id)=(NEW.tenant_id,NEW.order_id) FOR UPDATE;
 state:=public.buyer_address_current_state(NEW.tenant_id,NEW.order_id);
 IF NOT public.buyer_address_state_shape(NEW.before_state) OR NOT public.buyer_address_state_shape(NEW.after_state) THEN RAISE EXCEPTION 'Invalid frozen sidecar projection' USING ERRCODE='23514';END IF;
 IF ord.id IS NULL OR ord.version IS DISTINCT FROM NEW.expected_order_version
  OR NEW.before_state IS DISTINCT FROM state OR NEW.buyer_basis_hash IS DISTINCT FROM public.buyer_address_buyer_basis(NEW.tenant_id,NEW.order_id)
  OR NEW.created_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp()
  OR NEW.changed IS DISTINCT FROM(NEW.before_state IS DISTINCT FROM NEW.after_state)
  OR(NEW.changed AND NEW.after_state->>'last_receipt_id' IS DISTINCT FROM NEW.reserved_receipt_id::text)
  OR(NEW.after_state->>'version')::bigint<>(state->>'version')::bigint+(CASE WHEN NEW.changed THEN 1 ELSE 0 END)
  OR(NEW.after_state->>'delivery_version')::bigint<>(state->>'delivery_version')::bigint+(CASE WHEN NEW.kind='delivery' AND NEW.changed THEN 1 ELSE 0 END)
  OR(NOT NEW.changed AND NEW.after_state IS DISTINCT FROM state)
  OR(NEW.after_state->>'delivery_kind'='address' AND coalesce(ord.address->>'locker_code','')<>'')
 THEN RAISE EXCEPTION 'Invalid current buyer address preview or canonical-kind contradiction' USING ERRCODE='23514';END IF;
 IF NEW.kind='access' THEN
  IF(NEW.after_state->'enabled'='true'::jsonb AND NEW.after_state->>'delivery_kind'='unknown')
   OR(NEW.after_state-ARRAY['version','enabled','delivery_kind','classification_origin','last_receipt_id'])
    IS DISTINCT FROM(state-ARRAY['version','enabled','delivery_kind','classification_origin','last_receipt_id'])
   THEN RAISE EXCEPTION 'Access policy cannot change delivery bytes' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT ord.portal_enabled OR(ord.portal_expires_at IS NOT NULL AND ord.portal_expires_at<=clock_timestamp())
   OR NEW.token_digest IS DISTINCT FROM encode(sha256(convert_to(ord.portal_token,'UTF8')),'hex')
   OR state->'enabled' IS DISTINCT FROM 'true'::jsonb OR state->>'delivery_kind'<>'address'
   OR ord.status NOT IN('new','paid')
   OR(NEW.after_state->'enabled',NEW.after_state->'delivery_kind',NEW.after_state->'classification_origin')
    IS DISTINCT FROM(state->'enabled',state->'delivery_kind',state->'classification_origin')
   THEN RAISE EXCEPTION 'Current buyer token, policy or delivery eligibility refused' USING ERRCODE='23514';END IF;
  SELECT count(*) INTO active FROM public.buyer_address_previews p WHERE(p.tenant_id,p.order_id,p.kind)=(NEW.tenant_id,NEW.order_id,'delivery')
   AND p.expires_at>clock_timestamp() AND NOT EXISTS(SELECT FROM public.buyer_address_receipts r WHERE(r.tenant_id,r.preview_id)=(p.tenant_id,p.id));
  IF active>=5 THEN RAISE EXCEPTION 'Too many current buyer delivery previews' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.scope_hash IS DISTINCT FROM public.buyer_address_hash(jsonb_build_object('id',NEW.id,'reserved_receipt_id',NEW.reserved_receipt_id,
  'kind',NEW.kind,'tenant_id',NEW.tenant_id,'order_id',NEW.order_id,'request_hash',NEW.request_hash,'token_digest',NEW.token_digest,
  'actor_id',NEW.actor_id,'api_key_id',NEW.api_key_id,'buyer_basis_hash',NEW.buyer_basis_hash,'order_version',NEW.expected_order_version::text,
  'before_state',NEW.before_state,'after_state',NEW.after_state,'evidence_sha256',NEW.evidence_sha256))
  THEN RAISE EXCEPTION 'Buyer address preview scope differs from native frozen frame' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER buyer_address_preview_guard BEFORE INSERT ON buyer_address_previews FOR EACH ROW EXECUTE FUNCTION buyer_address_preview_guard();
CREATE FUNCTION buyer_address_receipt_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE preview buyer_address_previews%ROWTYPE;
BEGIN
 SELECT * INTO preview FROM public.buyer_address_previews WHERE(tenant_id,order_id,id)=(NEW.tenant_id,NEW.order_id,NEW.preview_id);
 IF preview.id IS NULL OR NEW.id IS DISTINCT FROM preview.reserved_receipt_id OR(NEW.kind,NEW.actor_id,NEW.api_key_id,NEW.token_digest,NEW.scope_hash,NEW.buyer_basis_hash,
  NEW.before_order_version,NEW.before_state,NEW.after_state,NEW.evidence_encrypted,NEW.evidence_byte_count,NEW.evidence_sha256,NEW.changed)
  IS DISTINCT FROM(preview.kind,preview.actor_id,preview.api_key_id,preview.token_digest,preview.scope_hash,preview.buyer_basis_hash,
  preview.expected_order_version,preview.before_state,preview.after_state,preview.evidence_encrypted,preview.evidence_byte_count,preview.evidence_sha256,preview.changed)
  OR NOT EXISTS(SELECT FROM public.orders o WHERE(o.tenant_id,o.id,o.version)=(NEW.tenant_id,NEW.order_id,NEW.before_order_version))
  OR NEW.top_xid<>pg_current_xact_id() OR NEW.transaction_started_at<>transaction_timestamp()
  OR preview.expires_at<=clock_timestamp()
  OR NEW.changed IS DISTINCT FROM (NEW.before_state IS DISTINCT FROM NEW.after_state)
  OR (NEW.changed AND NEW.after_state->>'last_receipt_id' IS DISTINCT FROM NEW.id::text)
  OR NEW.before_state IS DISTINCT FROM public.buyer_address_current_state(NEW.tenant_id,NEW.order_id)
  OR NEW.buyer_basis_hash IS DISTINCT FROM public.buyer_address_buyer_basis(NEW.tenant_id,NEW.order_id)
 THEN RAISE EXCEPTION 'Buyer address receipt does not match exact current preview' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER buyer_address_receipt_guard BEFORE INSERT ON buyer_address_receipts FOR EACH ROW EXECUTE FUNCTION buyer_address_receipt_guard();
CREATE FUNCTION buyer_address_state_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE receipt buyer_address_receipts%ROWTYPE;before_projection jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Current delivery cannot be deleted without evidence' USING ERRCODE='23514';END IF;
 SELECT * INTO receipt FROM public.buyer_address_receipts WHERE(tenant_id,order_id,id)=(NEW.tenant_id,NEW.order_id,NEW.last_receipt_id);
 before_projection:=CASE WHEN TG_OP='INSERT' THEN public.buyer_address_current_state(NEW.tenant_id,NEW.order_id) ELSE public.buyer_address_state_projection(OLD) END;
 IF receipt.id IS NULL OR NOT receipt.changed OR receipt.top_xid<>pg_current_xact_id()
  OR receipt.transaction_started_at<>transaction_timestamp() OR receipt.before_state IS DISTINCT FROM before_projection
  OR receipt.after_state IS DISTINCT FROM public.buyer_address_state_projection(NEW)
  OR NEW.version<>(before_projection->>'version')::bigint+1
  OR NEW.delivery_version<>(before_projection->>'delivery_version')::bigint+(CASE WHEN receipt.kind='delivery' THEN 1 ELSE 0 END)
  OR NEW.updated_at IS DISTINCT FROM receipt.created_at
  OR(TG_OP='UPDATE' AND(NEW.tenant_id,NEW.order_id) IS DISTINCT FROM(OLD.tenant_id,OLD.order_id))
  OR(receipt.kind='access' AND(public.buyer_address_state_projection(NEW)-ARRAY['version','enabled','delivery_kind','classification_origin','last_receipt_id'])
   IS DISTINCT FROM(before_projection-ARRAY['version','enabled','delivery_kind','classification_origin','last_receipt_id']))
  OR(receipt.kind='delivery' AND(NEW.enabled,NEW.delivery_kind,NEW.classification_origin) IS DISTINCT FROM((before_projection->>'enabled')::boolean,before_projection->>'delivery_kind',before_projection->>'classification_origin'))
 THEN RAISE EXCEPTION 'Current sidecar requires exact own changed receipt and CAS' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER buyer_address_state_guard BEFORE INSERT OR UPDATE OR DELETE ON buyer_address_state FOR EACH ROW EXECUTE FUNCTION buyer_address_state_guard();
CREATE FUNCTION buyer_address_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE order_version bigint;
BEGIN
 SELECT version INTO order_version FROM public.orders WHERE(tenant_id,id)=(NEW.tenant_id,NEW.order_id);
 IF order_version IS DISTINCT FROM NEW.after_order_version
  OR NEW.buyer_basis_hash IS DISTINCT FROM public.buyer_address_buyer_basis(NEW.tenant_id,NEW.order_id)
  OR public.buyer_address_current_state(NEW.tenant_id,NEW.order_id) IS DISTINCT FROM NEW.after_state
  OR(NOT NEW.changed AND NEW.before_state IS DISTINCT FROM NEW.after_state)
 THEN RAISE EXCEPTION 'Incomplete sidecar, original buyer or order version transition' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER buyer_address_complete AFTER INSERT ON buyer_address_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION buyer_address_complete();


-- Only reviewed SECURITY DEFINER producers mutate this family. dyna_app has
-- SELECT and these explicit calls, never INSERT/UPDATE/DELETE privileges.
CREATE FUNCTION buyer_address_available() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$ BEGIN
 IF NOT public.buyer_address_guards() THEN RAISE EXCEPTION 'Incomplete buyer address module' USING ERRCODE='55000';END IF;
 RETURN true;END $$;
CREATE FUNCTION buyer_address_identity(t uuid,u uuid,k uuid,h text,r text,w boolean,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE x record;
BEGIN
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Tenant context mismatch' USING ERRCODE='42501';END IF;
 IF pin THEN PERFORM 1 FROM public.users WHERE id=u FOR SHARE;PERFORM 1 FROM public.tenants WHERE id=t FOR SHARE;PERFORM 1 FROM public.account_security WHERE user_id=u FOR SHARE;PERFORM 1 FROM public.workspace_security_policies WHERE tenant_id=t FOR SHARE;PERFORM 1 FROM public.memberships WHERE(user_id,tenant_id)=(u,t) FOR SHARE;
  IF k IS NULL THEN PERFORM 1 FROM public.sessions WHERE(token_hash,user_id,tenant_id)=(h,u,t) FOR SHARE;ELSE PERFORM 1 FROM public.api_keys WHERE(id,user_id,tenant_id)=(k,u,t) FOR SHARE;END IF;
 END IF;
 IF k IS NULL THEN
  SELECT m.role,coalesce(a.version,0)::text account_version,to_jsonb(p) policy,true scope_ok,
   coalesce(p.require_mfa,false) AND NOT(coalesce(a.enabled_at IS NOT NULL AND s.mfa_verified_at IS NOT NULL AND s.mfa_verified_at>clock_timestamp()-interval '8 hours',false)) mfa_required INTO x
  FROM public.sessions s JOIN public.users z ON z.id=s.user_id JOIN public.tenants n ON n.id=s.tenant_id JOIN public.memberships m ON(m.user_id,m.tenant_id)=(z.id,n.id) LEFT JOIN public.account_security a ON a.user_id=z.id LEFT JOIN public.workspace_security_policies p ON p.tenant_id=n.id
  WHERE(s.token_hash,s.user_id,s.tenant_id)=(h,u,t) AND s.expires_at>clock_timestamp() AND s.account_version=coalesce(a.version,0);
 ELSE
  SELECT m.role,coalesce(a.version,0)::text account_version,to_jsonb(p) policy,k0.scopes,
   k0.scopes@>CASE WHEN w THEN ARRAY['orders:read','orders:write']::text[] ELSE ARRAY['orders:read']::text[] END scope_ok,coalesce(p.require_mfa,false) AND a.enabled_at IS NULL mfa_required INTO x
  FROM public.api_keys k0 JOIN public.users z ON z.id=k0.user_id JOIN public.tenants n ON n.id=k0.tenant_id JOIN public.memberships m ON(m.user_id,m.tenant_id)=(z.id,n.id) LEFT JOIN public.account_security a ON a.user_id=z.id LEFT JOIN public.workspace_security_policies p ON p.tenant_id=n.id
  WHERE(k0.id,k0.token_hash,k0.user_id,k0.tenant_id)=(k,h,u,t) AND k0.revoked_at IS NULL AND k0.expires_at>clock_timestamp();
 END IF;
 IF x.role IS NULL THEN RAISE EXCEPTION 'Expired local authority' USING ERRCODE='28000';END IF;
 IF x.role<>r THEN RAISE EXCEPTION 'Local role changed' USING ERRCODE='40001';END IF;
 IF NOT coalesce(x.scope_ok,false) OR coalesce(x.mfa_required,true) OR(w AND x.role<>'admin') THEN RAISE EXCEPTION 'Missing current local authority' USING ERRCODE='42501';END IF;
 RETURN to_jsonb(x);
END $$;

CREATE FUNCTION buyer_address_public_identity(t uuid,oid uuid,h text,policy boolean,pin boolean) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.orders%ROWTYPE;
BEGIN
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Tenant context mismatch' USING ERRCODE='42501';END IF;
 IF pin THEN SELECT * INTO o FROM public.orders WHERE(tenant_id,id)=(t,oid) FOR SHARE;
 ELSE SELECT * INTO o FROM public.orders WHERE(tenant_id,id)=(t,oid);END IF;
 IF o.id IS NULL OR NOT o.portal_enabled OR(o.portal_expires_at IS NOT NULL AND o.portal_expires_at<=clock_timestamp())
  OR h IS DISTINCT FROM encode(sha256(convert_to(o.portal_token,'UTF8')),'hex')
  THEN RAISE EXCEPTION 'Inactive buyer link' USING ERRCODE='P0002';END IF;
 IF policy AND(public.buyer_address_current_state(t,oid)->'enabled') IS DISTINCT FROM 'true'::jsonb
  THEN RAISE EXCEPTION 'Buyer address access disabled' USING ERRCODE='P0002';END IF;
 RETURN true;
END $$;
-- Read memberships/waves without acquiring reverse wave->order locks.
-- Every accepted parcel plan blocks; historical shipping attempts stay frozen.
CREATE FUNCTION buyer_address_block_reason(t uuid,oid uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
DECLARE status text;r text;blocked boolean;
BEGIN
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Tenant context mismatch' USING ERRCODE='42501';END IF;
 SELECT o.status INTO status FROM public.orders o WHERE(o.tenant_id,o.id)=(t,oid);
 IF status IS NULL THEN RAISE EXCEPTION 'Unknown own order' USING ERRCODE='P0002';END IF;
 IF status NOT IN('new','paid') THEN RETURN 'fulfillment_started';END IF;
 IF EXISTS(SELECT FROM public.orders WHERE(tenant_id,id)=(t,oid) AND fulfillment_kind<>'sale')
  OR EXISTS(SELECT FROM public.order_merge_claims WHERE tenant_id=t AND(source_order_id=oid OR target_order_id=oid))
  OR EXISTS(SELECT FROM public.b2b_external_order_intents WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.b2b_dropship_lines WHERE(tenant_id,customer_order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.b2b_dropship_supplier_orders WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.return_cases WHERE(tenant_id,order_id)=(t,oid) AND state NOT IN('cancelled','rejected'))
  THEN RETURN 'dependent_plan_locked';END IF;
 IF EXISTS(SELECT FROM public.order_pick_items WHERE(tenant_id,order_id)=(t,oid) AND scanned>0)
  OR EXISTS(SELECT FROM public.reservation_locations WHERE(tenant_id,order_id)=(t,oid) AND(scanned>0 OR consumed_quantity>0))
  OR EXISTS(SELECT FROM public.reservations WHERE(tenant_id,order_id)=(t,oid) AND consumed_quantity>0)
  OR EXISTS(SELECT FROM public.picking_wave_scans WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.packing_receipts WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.order_packing_profiles WHERE(tenant_id,order_id)=(t,oid))
  THEN RETURN 'fulfillment_started';END IF;
 IF EXISTS(SELECT FROM public.shipments WHERE(tenant_id,order_id)=(t,oid)) THEN RETURN 'shipment_locked';END IF;
 IF EXISTS(SELECT FROM public.shipping_plans WHERE(tenant_id,order_id)=(t,oid)
  AND(state NOT IN('preview','cancelled') OR phase<>'ready' OR remote_id IS NOT NULL OR shipment_id IS NOT NULL))
  THEN RETURN 'shipment_locked';END IF;
 IF EXISTS(SELECT FROM public.picking_wave_orders p JOIN public.picking_waves w ON(w.tenant_id,w.id)=(p.tenant_id,p.wave_id)
  WHERE(p.tenant_id,p.order_id)=(t,oid) AND p.active)
  OR EXISTS(SELECT FROM public.packing_sessions WHERE(tenant_id,order_id)=(t,oid) AND state='active')
  THEN RETURN 'fulfillment_started';END IF;
 IF EXISTS(SELECT FROM public.order_parcel_plans WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.invoice_plans WHERE(tenant_id,order_id)=(t,oid) AND(state NOT IN('preview','cancelled','done') OR(state='cancelled' AND phase<>'ready')))
  OR EXISTS(SELECT FROM public.odoo_invoice_exports WHERE(tenant_id,order_id)=(t,oid) AND(state NOT IN('preview','cancelled','done') OR(state='cancelled' AND phase<>'ready')))
  THEN RETURN 'dependent_plan_locked';END IF;
 -- Additional availability-aware integrations use the same exact own-order
 -- predicate. No provider response/payload is exposed to the buyer.
 FOREACH r IN ARRAY ARRAY['order_status_plans','shopify_fulfillment_plans','amazon_fulfillment_plans','ebay_fulfillment_plans'] LOOP
  IF to_regclass('public.'||r) IS NOT NULL THEN
   EXECUTE format('SELECT EXISTS(SELECT FROM public.%I WHERE(tenant_id,order_id)=($1,$2) AND(state IN(''queued'',''failed'',''conflict'') OR phase IN(''write_started'',''verify'')))',r) INTO blocked USING t,oid;
   IF blocked THEN RETURN 'dependent_plan_locked';END IF;
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE FUNCTION buyer_address_prepare(t uuid,oid uuid,u uuid,k uuid,h text,r text,v jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE p public.buyer_address_previews%ROWTYPE;o public.orders%ROWTYPE;stamp timestamptz;scope text;
BEGIN
 PERFORM public.buyer_address_available();
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Tenant context mismatch' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM public.orders WHERE(tenant_id,id)=(t,oid) FOR UPDATE;
 IF o.id IS NULL THEN RAISE EXCEPTION 'Unknown own order' USING ERRCODE='P0002';END IF;
 IF jsonb_typeof(v)<>'object' OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(v) key)
  IS DISTINCT FROM ARRAY['after_state','before_state','buyer_basis_hash','changed','client_key','evidence_byte_count','evidence_encrypted','evidence_sha256','expected_order_version','id','kind','request_hash','reserved_receipt_id']::text[]
  THEN RAISE EXCEPTION 'Invalid native preview fields' USING ERRCODE='23514';END IF;
 IF v->>'kind'='access' THEN PERFORM public.buyer_address_identity(t,u,k,h,r,true,false);
 ELSIF v->>'kind'='delivery' THEN
  IF u IS NOT NULL OR k IS NOT NULL THEN RAISE EXCEPTION 'Buyer is not an admin actor' USING ERRCODE='42501';END IF;
  PERFORM public.buyer_address_public_identity(t,oid,h,true,false);
  IF public.buyer_address_block_reason(t,oid) IS NOT NULL THEN RAISE EXCEPTION 'Dependent delivery state changed' USING ERRCODE='40001';END IF;
 ELSE RAISE EXCEPTION 'Invalid preview kind' USING ERRCODE='23514';END IF;
 stamp:=clock_timestamp();
 scope:=public.buyer_address_hash(jsonb_build_object('id',(v->>'id')::uuid,'reserved_receipt_id',(v->>'reserved_receipt_id')::uuid,
  'kind',v->>'kind','tenant_id',t,'order_id',oid,'request_hash',v->>'request_hash','token_digest',CASE WHEN v->>'kind'='delivery' THEN h ELSE NULL END,
  'actor_id',u,'api_key_id',k,'buyer_basis_hash',v->>'buyer_basis_hash','order_version',v->>'expected_order_version',
  'before_state',v->'before_state','after_state',v->'after_state','evidence_sha256',v->>'evidence_sha256'));
 INSERT INTO public.buyer_address_previews(id,tenant_id,order_id,client_key,reserved_receipt_id,kind,actor_id,api_key_id,token_digest,
 expected_order_version,before_state,after_state,buyer_basis_hash,request_hash,scope_hash,evidence_encrypted,evidence_byte_count,evidence_sha256,changed,created_at,expires_at)
 VALUES((v->>'id')::uuid,t,oid,(v->>'client_key')::uuid,(v->>'reserved_receipt_id')::uuid,v->>'kind',u,k,CASE WHEN v->>'kind'='delivery' THEN h ELSE NULL END,
 (v->>'expected_order_version')::bigint,v->'before_state',v->'after_state',v->>'buyer_basis_hash',v->>'request_hash',scope,v->>'evidence_encrypted',
 (v->>'evidence_byte_count')::integer,v->>'evidence_sha256',(v->>'changed')::boolean,stamp,stamp+interval '15 minutes') RETURNING * INTO p;
 RETURN to_jsonb(p);
END $$;
CREATE FUNCTION buyer_address_apply(t uuid,oid uuid,pid uuid,ck uuid,requesthash text,u uuid,k uuid,h text,r text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE p public.buyer_address_previews%ROWTYPE;rc public.buyer_address_receipts%ROWTYPE;a jsonb;stamp timestamptz;
BEGIN
 PERFORM public.buyer_address_available();
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Tenant context mismatch' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.orders WHERE(tenant_id,id)=(t,oid) FOR UPDATE;
 SELECT * INTO p FROM public.buyer_address_previews WHERE(tenant_id,order_id,id)=(t,oid,pid);
 IF p.id IS NULL THEN RAISE EXCEPTION 'Unknown own preview' USING ERRCODE='P0002';END IF;
 IF p.kind='access' THEN
  PERFORM public.buyer_address_identity(t,u,k,h,r,true,false);
  IF(p.actor_id,p.api_key_id) IS DISTINCT FROM(u,k) THEN RAISE EXCEPTION 'Preview admin differs' USING ERRCODE='42501';END IF;
 ELSE
  PERFORM public.buyer_address_public_identity(t,oid,h,true,false);
  IF p.token_digest IS DISTINCT FROM h OR u IS NOT NULL OR k IS NOT NULL THEN RAISE EXCEPTION 'Buyer link changed' USING ERRCODE='P0002';END IF;
 END IF;
 SELECT * INTO rc FROM public.buyer_address_receipts WHERE(tenant_id,order_id,preview_id)=(t,oid,pid);
 IF rc.id IS NOT NULL THEN
  IF(rc.client_key,rc.request_hash) IS DISTINCT FROM(ck,requesthash) THEN RAISE EXCEPTION 'Apply idempotency differs' USING ERRCODE='40001';END IF;
  RETURN to_jsonb(rc);
 END IF;
 IF p.kind='delivery' AND public.buyer_address_block_reason(t,oid) IS NOT NULL THEN RAISE EXCEPTION 'Dependent delivery state changed' USING ERRCODE='40001';END IF;
 stamp:=clock_timestamp();
 INSERT INTO public.buyer_address_receipts(id,tenant_id,order_id,preview_id,client_key,kind,actor_id,api_key_id,token_digest,request_hash,scope_hash,buyer_basis_hash,
 before_order_version,after_order_version,before_state,after_state,evidence_encrypted,evidence_byte_count,evidence_sha256,changed,created_at)
 VALUES(p.reserved_receipt_id,t,oid,p.id,ck,p.kind,p.actor_id,p.api_key_id,p.token_digest,requesthash,p.scope_hash,p.buyer_basis_hash,
 p.expected_order_version,p.expected_order_version+CASE WHEN p.kind='delivery' AND p.changed THEN 1 ELSE 0 END,p.before_state,p.after_state,
 p.evidence_encrypted,p.evidence_byte_count,p.evidence_sha256,p.changed,stamp) RETURNING * INTO rc;
 a:=p.after_state;
 IF p.changed THEN
  INSERT INTO public.buyer_address_state(tenant_id,order_id,version,delivery_version,enabled,delivery_kind,classification_origin,delivery_override_encrypted,override_byte_count,override_sha256,last_receipt_id,updated_at)
  VALUES(t,oid,(a->>'version')::bigint,(a->>'delivery_version')::bigint,(a->>'enabled')::boolean,a->>'delivery_kind',a->>'classification_origin',a->>'delivery_override_encrypted',
   (a->>'override_byte_count')::integer,a->>'override_sha256',(a->>'last_receipt_id')::uuid,stamp)
  ON CONFLICT(tenant_id,order_id) DO UPDATE SET version=EXCLUDED.version,delivery_version=EXCLUDED.delivery_version,enabled=EXCLUDED.enabled,
   delivery_kind=EXCLUDED.delivery_kind,classification_origin=EXCLUDED.classification_origin,delivery_override_encrypted=EXCLUDED.delivery_override_encrypted,
   override_byte_count=EXCLUDED.override_byte_count,override_sha256=EXCLUDED.override_sha256,last_receipt_id=EXCLUDED.last_receipt_id,updated_at=EXCLUDED.updated_at;
  IF p.kind='delivery' THEN UPDATE public.orders SET updated_at=stamp WHERE(tenant_id,id)=(t,oid);END IF;
 END IF;
 RETURN to_jsonb(rc);
END $$;
-- Terminal duties are registered only by the genuine managed request service.
-- All graph mutations/constraint waits and identity PINs precede final clock.
CREATE FUNCTION buyer_address_terminal(t uuid,u uuid,k uuid,h text,r text,w boolean,duties jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE d jsonb;o public.orders%ROWTYPE;
BEGIN
 IF u IS NOT NULL THEN PERFORM public.buyer_address_identity(t,u,k,h,r,w,true);END IF;
 FOR d IN SELECT value FROM jsonb_array_elements(duties) LOOP
  SELECT * INTO o FROM public.orders WHERE(tenant_id,id)=(t,(d->>'order_id')::uuid) FOR SHARE;
  IF o.id IS NULL OR o.version::text IS DISTINCT FROM d->>'order_version'
   OR public.buyer_address_current_state(t,o.id) IS DISTINCT FROM d->'state'
   OR public.buyer_address_buyer_basis(t,o.id) IS DISTINCT FROM d->>'buyer_basis_hash'
   THEN RAISE EXCEPTION 'Buyer delivery basis changed' USING ERRCODE='40001';END IF;
  IF u IS NULL THEN PERFORM public.buyer_address_public_identity(t,o.id,h,(d->>'require_policy')::boolean,false);END IF;
  IF(d->>'eligibility')::boolean AND public.buyer_address_block_reason(t,o.id) IS NOT NULL
   THEN RAISE EXCEPTION 'Dependent delivery state changed' USING ERRCODE='40001';END IF;
 END LOOP;
 PERFORM public.buyer_address_available();
 IF u IS NOT NULL THEN PERFORM public.buyer_address_identity(t,u,k,h,r,w,false);END IF;
 FOR d IN SELECT value FROM jsonb_array_elements(duties) LOOP
  IF u IS NULL THEN PERFORM public.buyer_address_public_identity(t,(d->>'order_id')::uuid,h,(d->>'require_policy')::boolean,false);END IF;
  IF d->>'expires_at' IS NOT NULL AND clock_timestamp()>=(d->>'expires_at')::timestamptz
   THEN RAISE EXCEPTION 'Buyer preview expired during transaction' USING ERRCODE='40001';END IF;
 END LOOP;
 RETURN true;
END $$;

-- Own fingerprint is portable: canonical constraint defs, named roles and full
-- effective ACLs; no OIDs or encrypted/private DATA is included. Prefix captures
-- unexpected own objects/triggers as tampering, including outside own tables.
CREATE FUNCTION buyer_address_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',pg_get_userbyid(c.relowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'buyer_address_') AND c.relkind IN('r','p')),
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'number',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'collation',(SELECT collname FROM pg_collation WHERE oid=a.attcollation)) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum) WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'buyer_address_') AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',c.conname,'def',pg_get_constraintdef(c.oid,true),'validated',c.convalidated) ORDER BY t.relname,c.conname) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relnamespace='public'::regnamespace AND starts_with(t.relname,'buyer_address_')),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',idx.relname,'def',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) ORDER BY t.relname,idx.relname) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid WHERE t.relnamespace='public'::regnamespace AND starts_with(t.relname,'buyer_address_')),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',t.tgname,'def',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY n.nspname,c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND(starts_with(t.tgname,'buyer_address_') OR(c.relnamespace='public'::regnamespace AND starts_with(c.relname,'buyer_address_')))),
 'policies',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END) FROM unnest(p.polroles) r),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname,p.polname) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'buyer_address_')),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'def',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x),'app_execute',has_function_privilege('dyna_app',p.oid,'EXECUTE')) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'buyer_address_')),
 'app_role',(SELECT jsonb_build_object('superuser',r.rolsuper,'inherit',r.rolinherit,'bypass_rls',r.rolbypassrls,'create_role',r.rolcreaterole,'create_db',r.rolcreatedb,'login',r.rolcanlogin) FROM pg_roles r WHERE rolname='dyna_app'),
 'app_acl',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'select',has_table_privilege('dyna_app',c.oid,'SELECT'),'insert',has_table_privilege('dyna_app',c.oid,'INSERT'),'update',has_table_privilege('dyna_app',c.oid,'UPDATE'),'delete',has_table_privilege('dyna_app',c.oid,'DELETE')) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'buyer_address_') AND c.relkind IN('r','p'))
 )::text,'UTF8')),'hex')
$$;

CREATE FUNCTION buyer_address_guards() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE seal buyer_address_manifest%ROWTYPE; basis record; basis_oid oid;owner_name text;
BEGIN
 IF to_regclass('public.buyer_address_manifest') IS NULL
  OR to_regclass('public.buyer_address_state') IS NULL OR to_regclass('public.buyer_address_previews') IS NULL
  OR to_regclass('public.buyer_address_receipts') IS NULL
  OR(SELECT array_agg(relname::text ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'buyer_address_') AND relkind IN('r','p'))
   IS DISTINCT FROM ARRAY['buyer_address_manifest','buyer_address_previews','buyer_address_receipts','buyer_address_state']::text[]
  OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'buyer_address_') AND relkind IN('v','m','S','f'))
  OR(SELECT count(*) FROM public.buyer_address_manifest)<>1 THEN RETURN false;END IF;
 SELECT * INTO seal FROM public.buyer_address_manifest;
 IF seal.profile IS DISTINCT FROM 'delivery-sidecar-managed/v1'
  OR seal.fingerprint IS DISTINCT FROM public.buyer_address_fingerprint()
  OR seal.predecessor_certificates IS DISTINCT FROM public.buyer_address_predecessors() THEN RETURN false;END IF;
 IF EXISTS(SELECT FROM public.migrations WHERE name='166_buyer_address_sidecar') THEN RETURN true;END IF;
 -- Metadata-only bootstrap limited to this exact owner TX. No global flag.
 basis_oid:=to_regclass('pg_temp.buyer_address_install_basis');IF basis_oid IS NULL THEN RETURN false;END IF;
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid='public.buyer_address_manifest'::regclass;
 IF current_user IS DISTINCT FROM owner_name OR session_user IS DISTINCT FROM owner_name
  OR(SELECT relowner FROM pg_class WHERE oid=basis_oid) IS DISTINCT FROM(SELECT relowner FROM pg_class WHERE oid='public.buyer_address_manifest'::regclass)
  THEN RETURN false;END IF;
 IF(SELECT count(*) FROM pg_temp.buyer_address_install_basis)<>1 THEN RETURN false;END IF;
 SELECT * INTO basis FROM pg_temp.buyer_address_install_basis;
 RETURN(basis.root_xid,basis.start_at,basis.backend_pid,basis.owner_name)
  IS NOT DISTINCT FROM(pg_current_xact_id()::text,transaction_timestamp(),pg_backend_pid(),session_user::text)
  AND basis.predecessors IS NOT DISTINCT FROM seal.predecessor_certificates;
END $$;
-- All own functions, including trigger helpers, have a private effective ACL.
-- Sign only after explicit live producer ACLs are complete.
DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'buyer_address_') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION buyer_address_available(),buyer_address_identity(uuid,uuid,uuid,text,text,boolean,boolean),
 buyer_address_public_identity(uuid,uuid,text,boolean,boolean),buyer_address_block_reason(uuid,uuid),
 buyer_address_prepare(uuid,uuid,uuid,uuid,text,text,jsonb),buyer_address_apply(uuid,uuid,uuid,uuid,text,uuid,uuid,text,text),
 buyer_address_terminal(uuid,uuid,uuid,text,text,boolean,jsonb),buyer_address_current_state(uuid,uuid),buyer_address_buyer_basis(uuid,uuid) TO dyna_app;
INSERT INTO buyer_address_manifest(singleton,profile,fingerprint,predecessor_certificates)
 SELECT true,'delivery-sidecar-managed/v1',public.buyer_address_fingerprint(),predecessors
 FROM pg_temp.buyer_address_install_basis;
DO $$ BEGIN
 IF NOT public.buyer_address_guards()
  OR public.buyer_address_predecessors() IS DISTINCT FROM(SELECT predecessors FROM pg_temp.buyer_address_install_basis)
 THEN RAISE EXCEPTION '166 own seal or predecessor preservation failed' USING ERRCODE='55000';END IF;
END $$;
-- Root managed migration appends 166_buyer_address_sidecar in the same transaction.
-- Registration and execution are separately reviewed, not performed by this SQL author.
-- Acceptance still requires real all-prior21guards/fingerprints/certificate rows
-- before/after, exact parent RI delta, ownhistory/no-op/CAS/semantic tampering,
-- token/admin late waits and zero providers/automation, restart and encrypted
-- fresh560 restore with canonical ownfingerprint/all encryptedrecord discovery.
