-- Local draft changes only. No historical tenant or stock row is updated.
CREATE FUNCTION replenishment_automation_definition_valid(d jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE v jsonb; BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT d ?& ARRAY['warehouse_id','product_ids','enabled','destination']
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN ('warehouse_id','product_ids','enabled','destination','forecast')) THEN RETURN false;END IF;
 IF jsonb_typeof(d->'warehouse_id') IS DISTINCT FROM 'string' OR d->>'warehouse_id' !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
 OR jsonb_typeof(d->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(d->'destination') IS DISTINCT FROM 'string'
 OR d->>'destination' NOT IN ('new_drafts','append_matching_draft') OR jsonb_typeof(d->'product_ids') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(d->'product_ids')<1 OR jsonb_array_length(d->'product_ids')>500 THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'product_ids') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR x#>>'{}' !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
 OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(d->'product_ids') x)<>jsonb_array_length(d->'product_ids') THEN RETURN false;END IF;
 IF d ? 'forecast' THEN
  v:=d->'forecast';IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT v ?& ARRAY['lookback_days','coverage_days'] OR (SELECT count(*) FROM jsonb_object_keys(v))<>2
  OR jsonb_typeof(v->'lookback_days') IS DISTINCT FROM 'number' OR v->>'lookback_days' NOT IN ('7','14','30','60','90')
  OR jsonb_typeof(v->'coverage_days') IS DISTINCT FROM 'number' OR v->>'coverage_days' !~ '^[1-9][0-9]*$'
  OR (v->>'coverage_days')::numeric>365 THEN RETURN false;END IF;
 END IF;RETURN true;
END $$;
REVOKE ALL ON FUNCTION replenishment_automation_definition_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replenishment_automation_definition_valid(jsonb) TO dyna_app;
CREATE TABLE replenishment_automation_rules (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),name text NOT NULL CHECK(length(name)>=1 AND length(name)<=120 AND name=btrim(name) AND name!~'[[:cntrl:]]'),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),definition jsonb NOT NULL CHECK(replenishment_automation_definition_valid(definition)),
 warehouse_id uuid GENERATED ALWAYS AS ((definition->>'warehouse_id')::uuid) STORED,
 actor_id uuid NOT NULL REFERENCES users(id),api_key_id uuid,source text NOT NULL CHECK(source IN ('manual','api')),
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),initial_request jsonb NOT NULL CHECK(jsonb_typeof(initial_request)='object' AND octet_length(initial_request::text)<=262144),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX replenishment_automation_rules_scope ON replenishment_automation_rules(tenant_id,warehouse_id,id);
CREATE TABLE replenishment_automation_rule_items (
 tenant_id uuid NOT NULL,rule_id uuid NOT NULL,product_id uuid NOT NULL,policy_id uuid NOT NULL,policy_version integer NOT NULL CHECK(policy_version>0),product_version integer NOT NULL CHECK(product_version>0),
 PRIMARY KEY(tenant_id,rule_id,product_id),
 FOREIGN KEY(tenant_id,rule_id) REFERENCES replenishment_automation_rules(tenant_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),FOREIGN KEY(tenant_id,policy_id) REFERENCES replenishment_policies(tenant_id,id)
);
CREATE INDEX replenishment_automation_items_product ON replenishment_automation_rule_items(tenant_id,product_id,rule_id);
CREATE TABLE replenishment_automation_runs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),rule_id uuid NOT NULL,rule_version integer NOT NULL CHECK(rule_version>0),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','done','nop','skipped','error','cancelled')),
 name text NOT NULL,definition jsonb NOT NULL CHECK(replenishment_automation_definition_valid(definition)),actor_id uuid NOT NULL REFERENCES users(id),api_key_id uuid,source text NOT NULL CHECK(source IN ('manual','api')),
 policy_items jsonb NOT NULL CHECK(jsonb_typeof(policy_items)='array' AND jsonb_array_length(policy_items)>=1 AND jsonb_array_length(policy_items)<=500),
 crossings jsonb NOT NULL CHECK(jsonb_typeof(crossings)='array' AND jsonb_array_length(crossings)>=1 AND jsonb_array_length(crossings)<=500),job_id uuid NOT NULL,result jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=5242880),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,cancel_key uuid,cancel_actor_id uuid REFERENCES users(id),cancel_request_hash text CHECK(cancel_request_hash~'^[a-f0-9]{64}$'),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,job_id),UNIQUE(tenant_id,cancel_key),
 FOREIGN KEY(tenant_id,rule_id) REFERENCES replenishment_automation_rules(tenant_id,id),FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),CHECK((state='queued')=(finished_at IS NULL))
);
CREATE INDEX replenishment_automation_runs_history ON replenishment_automation_runs(tenant_id,id);
CREATE INDEX replenishment_automation_runs_pending ON replenishment_automation_runs(tenant_id,rule_id) WHERE state='queued';
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['replenishment_automation_rules','replenishment_automation_rule_items','replenishment_automation_runs'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON public.%I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('CREATE POLICY owner_scope ON public.%I TO %I USING(true) WITH CHECK(true)',t,current_user);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON replenishment_automation_rules TO dyna_app;
GRANT SELECT,INSERT,DELETE ON replenishment_automation_rule_items TO dyna_app;
GRANT SELECT,UPDATE ON replenishment_automation_runs TO dyna_app;

CREATE FUNCTION replenishment_automation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p public.replenishment_policies;e public.replenishment_executions;h public.replenishment_previews;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Replenishment automation history is retained' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='replenishment_automation_rules' THEN
  IF TG_OP='UPDATE' AND ((NEW.id,NEW.tenant_id,NEW.client_key,NEW.request_hash,NEW.initial_request,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.client_key,OLD.request_hash,OLD.initial_request,OLD.created_at) OR NEW.version::bigint<>OLD.version::bigint+1) THEN RAISE EXCEPTION 'Invalid automation rule revision' USING ERRCODE='23514';END IF;
  IF NEW.definition->>'enabled'='true' AND NEW.initial_request IS NULL THEN RAISE EXCEPTION 'Missing authorization' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='replenishment_automation_rule_items' THEN
  SELECT * INTO p FROM public.replenishment_policies WHERE tenant_id=NEW.tenant_id AND id=NEW.policy_id;
  IF FOUND AND (p.product_id IS DISTINCT FROM NEW.product_id OR p.version IS DISTINCT FROM NEW.policy_version OR NOT (p.definition->>'enabled')::boolean
  OR p.warehouse_id IS DISTINCT FROM (SELECT warehouse_id FROM public.replenishment_automation_rules WHERE tenant_id=NEW.tenant_id AND id=NEW.rule_id)) THEN RAISE EXCEPTION 'Invalid automation policy binding' USING ERRCODE='23514';END IF;
 ELSIF TG_OP='UPDATE' THEN
  IF OLD.state<>'queued' OR NEW.state='queued' OR NEW.version::bigint<>OLD.version::bigint+1
  OR (to_jsonb(NEW)-ARRAY['version','state','result','finished_at','cancel_key','cancel_actor_id','cancel_request_hash']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','state','result','finished_at','cancel_key','cancel_actor_id','cancel_request_hash']) THEN RAISE EXCEPTION 'Automation run is immutable after completion' USING ERRCODE='23514';END IF;
  IF NEW.state='cancelled' AND (NEW.cancel_key IS NULL OR NEW.cancel_actor_id IS NULL OR NEW.cancel_request_hash IS NULL) THEN RAISE EXCEPTION 'Missing cancellation receipt' USING ERRCODE='23514';END IF;
  IF NEW.state<>'cancelled' AND (NEW.cancel_key IS NOT NULL OR NEW.cancel_actor_id IS NOT NULL OR NEW.cancel_request_hash IS NOT NULL) THEN RAISE EXCEPTION 'Unexpected cancellation receipt' USING ERRCODE='23514';END IF;
  IF NEW.state IN ('done','nop') THEN
   SELECT * INTO e FROM public.replenishment_executions WHERE tenant_id=NEW.tenant_id AND id=(NEW.result->>'execution_id')::uuid;
   SELECT * INTO h FROM public.replenishment_previews WHERE tenant_id=NEW.tenant_id AND id=(NEW.result->>'preview_id')::uuid;
   IF e.id IS NULL OR h.id IS NULL OR e.preview_id IS DISTINCT FROM h.id OR e.actor_id IS DISTINCT FROM NEW.actor_id OR h.actor_id IS DISTINCT FROM NEW.actor_id
   OR e.source IS DISTINCT FROM NEW.source OR h.source IS DISTINCT FROM NEW.source OR e.client_key IS DISTINCT FROM NEW.id OR h.client_key IS DISTINCT FROM NEW.id
   OR h.warehouse_id IS DISTINCT FROM (NEW.definition->>'warehouse_id')::uuid OR (NEW.state='nop') IS DISTINCT FROM (jsonb_array_length(e.groups)=0)
   OR (h.config->'forecast') IS DISTINCT FROM (NEW.definition->'forecast')
   OR (SELECT jsonb_agg(v->>'product_id' ORDER BY v->>'product_id') FROM jsonb_array_elements(h.config->'items') v) IS DISTINCT FROM (SELECT jsonb_agg(v->>'product_id' ORDER BY v->>'product_id') FROM jsonb_array_elements(NEW.crossings) v)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(h.config->'items') it WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.policy_items) pi WHERE pi->>'product_id'=it->>'product_id' AND pi->>'policy_version'=it->>'policy_version'))
   OR EXISTS(SELECT 1 FROM public.replenishment_rows rw WHERE rw.tenant_id=NEW.tenant_id AND rw.preview_id=h.id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.policy_items) pi WHERE pi->>'product_id'=rw.product_id::text AND pi->>'policy_id'=rw.policy_id::text AND pi->>'policy_version'=rw.policy_version::text))
   OR (NEW.definition->>'destination'='new_drafts' AND h.config ? 'draft_targets')
   OR (NEW.result->'purchase_order_ids') IS DISTINCT FROM (SELECT coalesce(jsonb_agg(v->>'purchase_order_id' ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements(e.groups) WITH ORDINALITY gg(v,ord)) THEN RAISE EXCEPTION 'Invalid automation execution evidence' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION replenishment_automation_guard() FROM PUBLIC,dyna_app;
CREATE TRIGGER automation_rule_guard BEFORE INSERT OR UPDATE OR DELETE ON replenishment_automation_rules FOR EACH ROW EXECUTE FUNCTION replenishment_automation_guard();
CREATE TRIGGER automation_item_guard BEFORE INSERT ON replenishment_automation_rule_items FOR EACH ROW EXECUTE FUNCTION replenishment_automation_guard();
CREATE TRIGGER automation_run_guard BEFORE UPDATE OR DELETE ON replenishment_automation_runs FOR EACH ROW EXECUTE FUNCTION replenishment_automation_guard();

CREATE FUNCTION replenishment_automation_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid;r uuid;d jsonb;ids jsonb;BEGIN
 t:=NEW.tenant_id;IF TG_TABLE_NAME='replenishment_automation_rules' THEN r:=NEW.id;ELSE r:=NEW.rule_id;END IF;
 SELECT definition INTO d FROM public.replenishment_automation_rules WHERE tenant_id=t AND id=r;
 SELECT coalesce(jsonb_agg(product_id::text ORDER BY product_id), '[]'::jsonb) INTO ids FROM public.replenishment_automation_rule_items WHERE tenant_id=t AND rule_id=r;
 IF ids IS DISTINCT FROM (SELECT jsonb_agg(x ORDER BY x) FROM jsonb_array_elements(d->'product_ids') x) THEN RAISE EXCEPTION 'Incomplete automation scope' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION replenishment_automation_complete() FROM PUBLIC,dyna_app;
CREATE CONSTRAINT TRIGGER automation_complete AFTER INSERT OR UPDATE ON replenishment_automation_rules DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION replenishment_automation_complete();
-- DELETE uses OLD through a separate function, including delete/reinsert of the complete current scope.
CREATE FUNCTION replenishment_automation_item_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rr public.replenishment_automation_rules;ids jsonb;BEGIN
 IF TG_OP='DELETE' THEN SELECT * INTO rr FROM public.replenishment_automation_rules WHERE tenant_id=OLD.tenant_id AND id=OLD.rule_id;ELSE SELECT * INTO rr FROM public.replenishment_automation_rules WHERE tenant_id=NEW.tenant_id AND id=NEW.rule_id;END IF;
 SELECT coalesce(jsonb_agg(product_id::text ORDER BY product_id),'[]'::jsonb) INTO ids FROM public.replenishment_automation_rule_items WHERE tenant_id=rr.tenant_id AND rule_id=rr.id;
 IF ids IS DISTINCT FROM (SELECT jsonb_agg(x ORDER BY x) FROM jsonb_array_elements(rr.definition->'product_ids') x) THEN RAISE EXCEPTION 'Incomplete automation scope' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION replenishment_automation_item_complete() FROM PUBLIC,dyna_app;
CREATE CONSTRAINT TRIGGER automation_item_complete AFTER INSERT OR DELETE ON replenishment_automation_rule_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION replenishment_automation_item_complete();

CREATE FUNCTION replenishment_automation_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE candidate record;run_id uuid;job_id uuid;n integer;bytes numeric;BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.replenishment_automation_rules WHERE (definition->>'enabled')::boolean) THEN RETURN NULL;END IF;
 -- Source gate is held before stock locks. Configuration writers/processor take
 -- EXCLUSIVE at transaction entry, so capture reads rules without row locks.
 FOR candidate IN
  SELECT r.*,jsonb_agg(jsonb_build_object('product_id',nn.product_id,'before_available',oo.available,'after_available',nn.available,'minimum_quantity',(p.definition->>'minimum_quantity')::integer) ORDER BY nn.product_id) AS crossings,
   (SELECT jsonb_agg(jsonb_build_object('product_id',i.product_id,'policy_id',i.policy_id,'policy_version',i.policy_version,'product_version',i.product_version) ORDER BY i.product_id) FROM public.replenishment_automation_rule_items i WHERE i.tenant_id=r.tenant_id AND i.rule_id=r.id) AS policy_items
  FROM new_stock nn JOIN old_stock oo USING(tenant_id,warehouse_id,product_id)
  JOIN public.replenishment_automation_rule_items ri ON ri.tenant_id=nn.tenant_id AND ri.product_id=nn.product_id
  JOIN public.replenishment_automation_rules r ON r.tenant_id=ri.tenant_id AND r.id=ri.rule_id AND r.warehouse_id=nn.warehouse_id AND (r.definition->>'enabled')::boolean
  JOIN public.replenishment_policies p ON p.tenant_id=ri.tenant_id AND p.id=ri.policy_id AND (p.definition->>'enabled')::boolean
  WHERE nn.available<>oo.available AND oo.available>=(p.definition->>'minimum_quantity')::integer AND nn.available<(p.definition->>'minimum_quantity')::integer
  GROUP BY r.id ORDER BY r.tenant_id,r.id
 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('replenishment.automation.queue:'||candidate.tenant_id,0));
  SELECT count(*) INTO n FROM public.replenishment_automation_runs WHERE tenant_id=candidate.tenant_id;
  IF n>=2000 THEN RAISE EXCEPTION 'Replenishment automation history limit' USING ERRCODE='P0001';END IF;
  SELECT count(*) INTO n FROM public.replenishment_automation_runs WHERE tenant_id=candidate.tenant_id AND state='queued';
  IF n>=200 THEN RAISE EXCEPTION 'Replenishment automation pending limit' USING ERRCODE='P0001';END IF;
  SELECT coalesce(sum(octet_length(to_jsonb(x)::text)),0) INTO bytes FROM public.replenishment_automation_runs x WHERE tenant_id=candidate.tenant_id;
  IF bytes+octet_length(to_jsonb(candidate)::text)>134217728 THEN RAISE EXCEPTION 'Replenishment automation byte limit' USING ERRCODE='P0001';END IF;
  run_id:=gen_random_uuid();job_id:=gen_random_uuid();
  INSERT INTO public.jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES(job_id,candidate.tenant_id,'replenishment.automation',jsonb_build_object('run_id',run_id),'replenishment.automation:'||run_id,3);
  INSERT INTO public.replenishment_automation_runs(id,tenant_id,rule_id,rule_version,name,definition,actor_id,api_key_id,source,policy_items,crossings,job_id)
  VALUES(run_id,candidate.tenant_id,candidate.id,candidate.version,candidate.name,candidate.definition,candidate.actor_id,candidate.api_key_id,candidate.source,candidate.policy_items,candidate.crossings,job_id);
 END LOOP;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION replenishment_automation_capture() FROM PUBLIC,dyna_app;
CREATE TRIGGER replenishment_automation_stock AFTER UPDATE ON stock REFERENCING OLD TABLE AS old_stock NEW TABLE AS new_stock FOR EACH STATEMENT EXECUTE FUNCTION replenishment_automation_capture();

CREATE FUNCTION replenishment_automation_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid;n integer;b numeric;BEGIN
 FOR t IN SELECT DISTINCT tenant_id FROM inserted ORDER BY tenant_id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('replenishment.automation.queue:'||t,0));
  SELECT count(*) INTO n FROM public.replenishment_automation_rules WHERE tenant_id=t;
  IF n>200 THEN RAISE EXCEPTION 'Replenishment automation rule limit' USING ERRCODE='P0001';END IF;
  SELECT count(*) INTO n FROM public.replenishment_automation_runs WHERE tenant_id=t;
  IF n>2000 THEN RAISE EXCEPTION 'Replenishment automation history limit' USING ERRCODE='P0001';END IF;
  SELECT count(*) INTO n FROM public.replenishment_automation_runs WHERE tenant_id=t AND state='queued';
  IF n>200 THEN RAISE EXCEPTION 'Replenishment automation pending limit' USING ERRCODE='P0001';END IF;
  SELECT coalesce(sum(bytes),0) INTO b FROM (
   SELECT octet_length(to_jsonb(r)::text)::numeric bytes FROM public.replenishment_automation_rules r WHERE tenant_id=t
   UNION ALL SELECT octet_length(to_jsonb(i)::text)::numeric FROM public.replenishment_automation_rule_items i WHERE tenant_id=t
   UNION ALL SELECT octet_length(to_jsonb(x)::text)::numeric FROM public.replenishment_automation_runs x WHERE tenant_id=t) all_bytes;
  IF b>134217728 THEN RAISE EXCEPTION 'Replenishment automation byte limit' USING ERRCODE='P0001';END IF;
 END LOOP;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION replenishment_automation_budget() FROM PUBLIC,dyna_app;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['replenishment_automation_rules','replenishment_automation_rule_items','replenishment_automation_runs'] LOOP
  EXECUTE format('CREATE TRIGGER automation_budget_insert AFTER INSERT ON public.%I REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION replenishment_automation_budget()',t);
  IF t<>'replenishment_automation_rule_items' THEN EXECUTE format('CREATE TRIGGER automation_budget_update AFTER UPDATE ON public.%I REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION replenishment_automation_budget()',t);END IF;
 END LOOP;
END $$;
