-- Migration 249_catalog_ai (prepared as placeholder 255, registered after 248; docs/parity/CATALOG-AI249-20261028.md): track S8
-- „AI katalogu” (docs/parity/STAGE4-NONINTEGRATION-GAP-20261025.md, section 4). Four own families, each the
-- review-before-change record of one AI process with its audit trail in audit_log:
--   catalog_ai_batch_*      DOM-AI-003 batch generation with a result per item (drafts stay ai_catalog_drafts, 070)
--   catalog_ai_attribute_*  DOM-AI-002 typed PIM parameter proposals, applied through the PIM preview/apply path
--   catalog_ai_image_*      DOM-AI-004 background removal into a new image version (lineage, original kept)
--   catalog_ai_match_*      DOM-AI-005 channel category and parameter match proposals with a consent state
-- DOM-AI-001 (style) needs no DDL: the style is frozen inside ai_catalog_drafts.source (jsonb).
--
-- No core table is altered, referenced by a foreign key (no RI trigger lands on products, product_images,
-- ai_catalog_drafts, jobs or PIM tables) or given a new grant; the only foreign key joins two own tables. No object
-- name contains the number. Inference and image processing are local (loopback only); nothing here stores provider
-- credentials or personal data.

-- BEGIN catalog_ai_batch (DOM-AI-003: masowa generacja z wynikiem każdej pozycji)
-- One batch = one administrator request for up to 50 products with one model, destination, language and style.
-- Each item waits until the AI lane has room in the per-firm queue, then becomes one ordinary ai_catalog_drafts row
-- (070) through the same queue code as a single product; generation, review and apply stay the draft's own. The
-- item keeps the per-product result: conflict when the product changed before its draft was made, and the outcome
-- of a bulk approval (applied / failed with a safe message). No core table is altered or referenced by a foreign
-- key (no RI trigger lands on products or ai_catalog_drafts); ids are checked by the application under RLS.
-- Personal data: none (product ids and versions only).
CREATE TABLE catalog_ai_batches (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 client_key uuid NOT NULL,
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 destination text NOT NULL CHECK (destination IN ('catalog','translation')),
 locale text NOT NULL CHECK (locale IN ('pl','en','de','fr','es','cs')),
 style jsonb NOT NULL CHECK (jsonb_typeof(style) = 'object'),
 model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 100),
 model_digest text NOT NULL CHECK (model_digest ~ '^[a-f0-9]{64}$'),
 item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 50),
 state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id),
 UNIQUE (tenant_id, client_key)
);
CREATE INDEX catalog_ai_batches_history ON catalog_ai_batches(tenant_id, created_at DESC, id DESC);
CREATE TABLE catalog_ai_batch_items (
 tenant_id uuid NOT NULL,
 batch_id uuid NOT NULL,
 product_id uuid NOT NULL,
 position integer NOT NULL CHECK (position BETWEEN 1 AND 50),
 source_version integer NOT NULL CHECK (source_version > 0),
 state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','drafted','conflict','failed','cancelled')),
 draft_id uuid UNIQUE,
 -- Outcome of the bulk approval of this item; a draft applied one by one is read from the draft itself.
 outcome text CHECK (outcome IN ('applied','failed')),
 -- Safe Polish message written by the application.
 error text CHECK (char_length(error) <= 300),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, batch_id, product_id),
 UNIQUE (tenant_id, batch_id, position),
 FOREIGN KEY (tenant_id, batch_id) REFERENCES catalog_ai_batches(tenant_id, id),
 CHECK ((state = 'drafted') = (draft_id IS NOT NULL)),
 CHECK (state IN ('waiting','drafted') OR error IS NOT NULL OR state = 'cancelled'),
 CHECK (outcome IS NULL OR state = 'drafted'),
 CHECK (outcome IS DISTINCT FROM 'failed' OR error IS NOT NULL)
);
CREATE INDEX catalog_ai_batch_items_waiting ON catalog_ai_batch_items(tenant_id, batch_id, position) WHERE state = 'waiting';
-- Items move forward only: waiting -> drafted / conflict / failed / cancelled; a drafted item only records its outcome.
CREATE FUNCTION catalog_ai_batch_items_forward() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.tenant_id,NEW.batch_id,NEW.product_id,NEW.position,NEW.source_version) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.batch_id,OLD.product_id,OLD.position,OLD.source_version)
 OR (OLD.state <> 'waiting' AND NEW.state IS DISTINCT FROM OLD.state)
 OR (OLD.draft_id IS NOT NULL AND NEW.draft_id IS DISTINCT FROM OLD.draft_id)
 OR (OLD.outcome = 'applied' AND NEW.outcome IS DISTINCT FROM OLD.outcome) THEN
  RAISE EXCEPTION 'catalog_ai_batch_items: items move forward only';
 END IF;
 RETURN NEW; END $$;
CREATE TRIGGER catalog_ai_batch_items_forward BEFORE UPDATE ON catalog_ai_batch_items FOR EACH ROW EXECUTE FUNCTION catalog_ai_batch_items_forward();
CREATE FUNCTION catalog_ai_batches_frozen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.actor_id,NEW.client_key,NEW.request_hash,NEW.destination,NEW.locale,NEW.style,NEW.model,NEW.model_digest,NEW.item_count,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.actor_id,OLD.client_key,OLD.request_hash,OLD.destination,OLD.locale,OLD.style,OLD.model,OLD.model_digest,OLD.item_count,OLD.created_at)
 OR OLD.state = 'cancelled' AND NEW.state IS DISTINCT FROM OLD.state THEN
  RAISE EXCEPTION 'catalog_ai_batches: the request is immutable';
 END IF;
 RETURN NEW; END $$;
CREATE TRIGGER catalog_ai_batches_frozen BEFORE UPDATE ON catalog_ai_batches FOR EACH ROW EXECUTE FUNCTION catalog_ai_batches_frozen();
ALTER TABLE catalog_ai_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_ai_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog_ai_batch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_ai_batch_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON catalog_ai_batches TO dyna_app USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON catalog_ai_batch_items TO dyna_app USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON TABLE catalog_ai_batches, catalog_ai_batch_items FROM PUBLIC,dyna_app;
GRANT SELECT,INSERT,UPDATE ON TABLE catalog_ai_batches, catalog_ai_batch_items TO dyna_app;
-- END catalog_ai_batch
-- BEGIN catalog_ai_attribute (DOM-AI-002: generowanie parametrów respektuje typy i język)
-- One row = one request for typed PIM parameter values of one product. At request time the server freezes the
-- product's PIM frame (revision, product/state version, source hash, category, current values) and the active
-- definitions bound to its category (snapshot). The local model (AI lane, server/catalog-ai-attributes.ts) proposes
-- values for those definition ids only; each value is validated against its definition (text length, decimal
-- scale and bounds, boolean, active enum option). An administrator accepts values one by one; the accepted set is
-- written through the PIM preview/apply path (its own CAS on the frozen revision and source hash, its own history),
-- and the operation id is kept here. The row is also the queue entry of the AI lane (lease, one attempt).
-- 'applying' is the committed claim of one accepted set (accepted, decided_by) while PIM writes it; cancel refuses it.
-- No core or PIM table is altered or referenced by a foreign key; ids are checked by the application and by PIM.
-- Personal data: none (product name, description, category and attributes; definition names and options).
CREATE TABLE catalog_ai_attribute_proposals (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 product_id uuid NOT NULL,
 catalog_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 client_key uuid NOT NULL,
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 locale text NOT NULL CHECK (locale IN ('pl','en','de','fr','es','cs')),
 model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 100),
 model_digest text NOT NULL CHECK (model_digest ~ '^[a-f0-9]{64}$'),
 source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object' AND octet_length(source::text) <= 16384),
 pim_source jsonb NOT NULL CHECK (jsonb_typeof(pim_source) = 'object'),
 definitions jsonb NOT NULL CHECK (jsonb_typeof(definitions) = 'array' AND jsonb_array_length(definitions) BETWEEN 1 AND 50 AND octet_length(definitions::text) <= 262144),
 state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','ready','applying','failed','conflict','cancelled','applied')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1),
 lease_token uuid,
 locked_at timestamptz,
 -- Validated proposals [{definition_id, kind, value|option_id}] and refused model entries [{definition_id, reason}].
 output jsonb CHECK (jsonb_typeof(output) = 'array'),
 refused jsonb CHECK (jsonb_typeof(refused) = 'array'),
 usage jsonb,
 accepted jsonb CHECK (jsonb_typeof(accepted) = 'array'),
 pim_operation_id uuid,
 -- Safe Polish message written by the application.
 error text CHECK (char_length(error) <= 300),
 decided_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 decided_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
 UNIQUE (tenant_id, id),
 UNIQUE (tenant_id, client_key),
 CHECK ((state = 'running') = (lease_token IS NOT NULL AND locked_at IS NOT NULL)),
 CHECK (state NOT IN ('ready','applying','applied') OR (output IS NOT NULL AND refused IS NOT NULL)),
 CHECK (state <> 'applying' OR (accepted IS NOT NULL AND decided_by IS NOT NULL AND pim_operation_id IS NULL)),
 CHECK ((state = 'applied') = (accepted IS NOT NULL AND pim_operation_id IS NOT NULL AND decided_at IS NOT NULL)),
 CHECK (state NOT IN ('failed','conflict') OR error IS NOT NULL)
);
CREATE INDEX catalog_ai_attribute_history ON catalog_ai_attribute_proposals(tenant_id, product_id, created_at DESC, id DESC);
CREATE INDEX catalog_ai_attribute_queue ON catalog_ai_attribute_proposals(created_at, id) WHERE state = 'queued';
CREATE FUNCTION catalog_ai_attribute_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.product_id,NEW.catalog_id,NEW.actor_id,NEW.client_key,NEW.request_hash,NEW.locale,NEW.model,NEW.model_digest,NEW.source,NEW.pim_source,NEW.definitions,NEW.created_at,NEW.expires_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.product_id,OLD.catalog_id,OLD.actor_id,OLD.client_key,OLD.request_hash,OLD.locale,OLD.model,OLD.model_digest,OLD.source,OLD.pim_source,OLD.definitions,OLD.created_at,OLD.expires_at)
 OR (OLD.output IS NOT NULL AND ROW(NEW.output,NEW.refused) IS DISTINCT FROM ROW(OLD.output,OLD.refused))
 OR (OLD.state IN ('failed','conflict','cancelled','applied') AND NEW IS DISTINCT FROM OLD) THEN
  RAISE EXCEPTION 'catalog_ai_attribute_proposals: request, source and generated output are immutable';
 END IF;
 RETURN NEW; END $$;
CREATE TRIGGER catalog_ai_attribute_immutable BEFORE UPDATE ON catalog_ai_attribute_proposals FOR EACH ROW EXECUTE FUNCTION catalog_ai_attribute_immutable();
ALTER TABLE catalog_ai_attribute_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_ai_attribute_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON catalog_ai_attribute_proposals TO dyna_app USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON TABLE catalog_ai_attribute_proposals FROM PUBLIC,dyna_app;
GRANT SELECT,INSERT,UPDATE ON TABLE catalog_ai_attribute_proposals TO dyna_app;
-- END catalog_ai_attribute
-- BEGIN catalog_ai_image (DOM-AI-004: usuwanie tła tworzy nową wersję zdjęcia)
-- One row = one background-removal request for one product image and, once processed, the lineage of its result:
-- source_image_id (parent) -> result_image_id (a new ordinary product_images row), origin kind in `operation`.
-- The row is also the queue entry of the local processor (lease columns, claimed with FOR UPDATE SKIP LOCKED,
-- one automatic attempt). The original product_images row and file are never deleted or modified; products.images
-- changes only when an administrator accepts the result (CAS on products.version, server/image-background.ts).
-- No core table is altered or referenced by a foreign key (no RI trigger lands on products or product_images);
-- the application checks product and image ids under RLS. Product images hold no personal data.
CREATE TABLE catalog_ai_image_jobs (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 product_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 client_key uuid NOT NULL,
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 source_image_id uuid NOT NULL,
 source_version integer NOT NULL CHECK (source_version > 0),
 operation text NOT NULL DEFAULT 'background_removed' CHECK (operation IN ('background_removed')),
 state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','ready','failed','applied','rejected','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1),
 lease_token uuid,
 locked_at timestamptz,
 result_image_id uuid UNIQUE,
 result_sha256 text CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
 result_size integer CHECK (result_size BETWEEN 1 AND 524288),
 -- Safe Polish message written by the application; never the processor's own text.
 error text CHECK (char_length(error) <= 300),
 applied_version integer,
 decided_by uuid,
 decided_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
 UNIQUE (tenant_id, id),
 UNIQUE (tenant_id, client_key),
 CHECK ((state = 'running') = (lease_token IS NOT NULL AND locked_at IS NOT NULL)),
 CHECK ((state IN ('ready','applied','rejected')) = (result_image_id IS NOT NULL AND result_sha256 IS NOT NULL AND result_size IS NOT NULL)),
 CHECK ((state = 'failed') = (error IS NOT NULL)),
 CHECK ((state = 'applied') = (applied_version IS NOT NULL)),
 CHECK (result_image_id IS DISTINCT FROM source_image_id)
);
-- At most one open request per source image.
CREATE UNIQUE INDEX catalog_ai_image_jobs_open ON catalog_ai_image_jobs(tenant_id, source_image_id) WHERE state IN ('queued','running');
CREATE INDEX catalog_ai_image_jobs_history ON catalog_ai_image_jobs(tenant_id, product_id, created_at DESC, id DESC);
CREATE INDEX catalog_ai_image_jobs_queue ON catalog_ai_image_jobs(created_at, id) WHERE state = 'queued';
CREATE INDEX catalog_ai_image_jobs_running ON catalog_ai_image_jobs(locked_at) WHERE state = 'running';

-- Lineage and request are immutable; a result is written once; terminal states are final.
CREATE FUNCTION catalog_ai_image_jobs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.product_id,NEW.actor_id,NEW.client_key,NEW.request_hash,NEW.source_image_id,NEW.source_version,NEW.operation,NEW.created_at,NEW.expires_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.product_id,OLD.actor_id,OLD.client_key,OLD.request_hash,OLD.source_image_id,OLD.source_version,OLD.operation,OLD.created_at,OLD.expires_at)
 OR (OLD.result_image_id IS NOT NULL AND ROW(NEW.result_image_id,NEW.result_sha256,NEW.result_size) IS DISTINCT FROM ROW(OLD.result_image_id,OLD.result_sha256,OLD.result_size))
 OR (OLD.state IN ('failed','applied','rejected','cancelled') AND NEW IS DISTINCT FROM OLD)
 OR (NEW.state IS DISTINCT FROM OLD.state AND NOT (
   (OLD.state = 'queued' AND NEW.state IN ('running','failed','cancelled'))
   OR (OLD.state = 'running' AND NEW.state IN ('ready','failed'))
   OR (OLD.state = 'ready' AND NEW.state IN ('applied','rejected')))) THEN
  RAISE EXCEPTION 'catalog_ai_image_jobs: lineage is immutable and states move forward only';
 END IF;
 RETURN NEW; END $$;
CREATE TRIGGER catalog_ai_image_jobs_immutable BEFORE UPDATE ON catalog_ai_image_jobs FOR EACH ROW EXECUTE FUNCTION catalog_ai_image_jobs_immutable();

ALTER TABLE catalog_ai_image_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_ai_image_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON catalog_ai_image_jobs TO dyna_app USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON TABLE catalog_ai_image_jobs FROM PUBLIC,dyna_app;
GRANT SELECT,INSERT,UPDATE ON TABLE catalog_ai_image_jobs TO dyna_app;
-- END catalog_ai_image
-- DOM-AI-005: durable category and parameter match proposals for an offer channel (Allegro), with a consent state.
-- The server reads candidate catalog products/categories and parameter definitions from the channel at request time
-- and freezes them here (snapshot); the local model (AI lane, server/catalog-ai-matching.ts) only picks among the
-- frozen candidate ids and maps product attributes to the frozen definitions. Accepting records the reviewed match
-- (category + parameter values) for the offer form; it never creates or publishes an offer.
--
-- Own table only: no core table is altered or referenced by a foreign key (no RI trigger lands on products or
-- channels); product and channel identifiers are checked by the application in the tenant transaction.
-- Personal data: none. Only product name, description, category and attributes are frozen (source); no customer
-- data, prices or channel credentials. Rows are never deleted by the application role.

CREATE TABLE catalog_ai_match_proposals (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 product_id uuid NOT NULL,
 integration_id uuid NOT NULL,
 provider text NOT NULL CHECK (provider IN ('allegro')),
 actor_id uuid NOT NULL,
 client_key uuid NOT NULL,
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 source_version integer NOT NULL CHECK (source_version > 0),
 source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
 source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
 phrase text NOT NULL CHECK (char_length(phrase) BETWEEN 1 AND 200),
 simulated boolean NOT NULL,
 snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
 snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
 model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 100),
 model_digest text NOT NULL CHECK (model_digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','ready','accepted','rejected','failed','conflict','cancelled','expired')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1),
 lease_token uuid,
 locked_at timestamptz,
 output jsonb CHECK (output IS NULL OR jsonb_typeof(output) = 'object'),
 proposal jsonb CHECK (proposal IS NULL OR jsonb_typeof(proposal) = 'object'),
 usage jsonb,
 error text CHECK (char_length(error) <= 500),
 accepted jsonb CHECK (accepted IS NULL OR jsonb_typeof(accepted) = 'object'),
 decision_hash text CHECK (decision_hash ~ '^[a-f0-9]{64}$'),
 accepted_version integer CHECK (accepted_version > 0),
 decided_by uuid,
 decided_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
 UNIQUE (tenant_id, id),
 UNIQUE (tenant_id, client_key),
 CHECK ((lease_token IS NULL) = (locked_at IS NULL)),
 CHECK ((state = 'running') = (lease_token IS NOT NULL)),
 CHECK (state NOT IN ('ready','accepted','rejected') OR proposal IS NOT NULL),
 CHECK (proposal IS NULL OR state IN ('ready','accepted','rejected','conflict','expired')),
 CHECK ((state = 'accepted') = (accepted IS NOT NULL AND decision_hash IS NOT NULL AND accepted_version IS NOT NULL)),
 CHECK ((state IN ('accepted','rejected')) = (decided_at IS NOT NULL AND decided_by IS NOT NULL))
);
CREATE INDEX catalog_ai_match_history ON catalog_ai_match_proposals(tenant_id, product_id, created_at DESC, id DESC);
CREATE INDEX catalog_ai_match_accepted ON catalog_ai_match_proposals(tenant_id, product_id, integration_id, decided_at DESC) WHERE state = 'accepted';
CREATE INDEX catalog_ai_match_queue ON catalog_ai_match_proposals(created_at, id) WHERE state IN ('queued','running');

-- The request, the frozen product source and channel snapshot, and the model output never change; a decided row
-- (accepted/rejected) and any closed row are immutable as a whole.
CREATE FUNCTION catalog_ai_match_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.product_id,NEW.integration_id,NEW.provider,NEW.actor_id,NEW.client_key,NEW.request_hash,NEW.source_version,NEW.source,NEW.source_hash,NEW.phrase,NEW.simulated,NEW.snapshot,NEW.snapshot_hash,NEW.model,NEW.model_digest,NEW.created_at,NEW.expires_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.product_id,OLD.integration_id,OLD.provider,OLD.actor_id,OLD.client_key,OLD.request_hash,OLD.source_version,OLD.source,OLD.source_hash,OLD.phrase,OLD.simulated,OLD.snapshot,OLD.snapshot_hash,OLD.model,OLD.model_digest,OLD.created_at,OLD.expires_at)
 OR (OLD.output IS NOT NULL AND NEW.output IS DISTINCT FROM OLD.output)
 OR (OLD.proposal IS NOT NULL AND NEW.proposal IS DISTINCT FROM OLD.proposal)
 OR (OLD.state IN ('accepted','rejected','failed','conflict','cancelled','expired') AND NEW IS DISTINCT FROM OLD) THEN
  RAISE EXCEPTION 'AI match request, snapshot and output are immutable';
 END IF;
 RETURN NEW; END $$;
CREATE TRIGGER catalog_ai_match_immutable BEFORE UPDATE ON catalog_ai_match_proposals FOR EACH ROW EXECUTE FUNCTION catalog_ai_match_immutable();

ALTER TABLE catalog_ai_match_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_ai_match_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON catalog_ai_match_proposals TO dyna_app USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON TABLE catalog_ai_match_proposals FROM PUBLIC, dyna_app;
-- No DELETE or TRUNCATE for the application role.
GRANT SELECT,INSERT,UPDATE ON TABLE catalog_ai_match_proposals TO dyna_app;
-- END DOM-AI-005
