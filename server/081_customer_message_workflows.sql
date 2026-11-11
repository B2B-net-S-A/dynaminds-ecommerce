ALTER TABLE customer_message_threads ADD COLUMN assigned_user_id uuid REFERENCES users(id);
ALTER TABLE customer_messages ADD UNIQUE(tenant_id,order_id,thread_id,id);
ALTER TABLE order_events ADD UNIQUE(tenant_id,order_id,id);
ALTER TABLE automation_runs ADD UNIQUE(tenant_id,id);
ALTER TABLE automation_runs ADD UNIQUE(tenant_id,order_id,id);
CREATE INDEX customer_message_assignment_inbox ON customer_message_threads(tenant_id,assigned_user_id,last_message_at DESC,id DESC);
CREATE TABLE customer_message_workflow_receipts (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,thread_id uuid NOT NULL,message_id uuid NOT NULL,event_id uuid NOT NULL,
 portal_token_hash text NOT NULL CHECK(portal_token_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,message_id),UNIQUE(tenant_id,event_id),
 FOREIGN KEY(tenant_id,order_id,thread_id,message_id) REFERENCES customer_messages(tenant_id,order_id,thread_id,id),
 FOREIGN KEY(tenant_id,order_id,event_id) REFERENCES order_events(tenant_id,order_id,id)
);
CREATE TABLE customer_message_workflow_requests (
 tenant_id uuid NOT NULL,client_key uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),rule_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,client_key),FOREIGN KEY(tenant_id,rule_id) REFERENCES automation_rules(tenant_id,id)
);
CREATE TABLE customer_message_workflow_actions (
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,action_index integer NOT NULL CHECK(action_index BETWEEN 0 AND 4),
 order_id uuid NOT NULL,thread_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,run_id,action_index),
 FOREIGN KEY(tenant_id,order_id,run_id) REFERENCES automation_runs(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,order_id,thread_id) REFERENCES customer_message_threads(tenant_id,order_id,id)
);
CREATE FUNCTION customer_message_workflow_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Customer message workflow evidence is immutable';END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['customer_message_workflow_receipts','customer_message_workflow_requests','customer_message_workflow_actions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION customer_message_workflow_immutable()',t);
END LOOP; END $$;
CREATE FUNCTION customer_message_workflow_role(p_user uuid) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE r text; BEGIN
 SELECT role INTO r FROM public.memberships WHERE user_id=p_user AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid FOR SHARE;
 RETURN r; END $$;
REVOKE ALL ON FUNCTION customer_message_workflow_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_message_workflow_role(uuid) TO dyna_app;
CREATE FUNCTION customer_message_eligible_assignees(p_after uuid DEFAULT NULL) RETURNS TABLE(user_id uuid,name text,role text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT m.user_id,u.name,m.role FROM public.memberships m JOIN public.users u ON u.id=m.user_id
 WHERE m.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND m.role IN ('admin','operator') AND (p_after IS NULL OR m.user_id>p_after)
 ORDER BY m.user_id LIMIT 101
$$;
REVOKE ALL ON FUNCTION customer_message_eligible_assignees(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_message_eligible_assignees(uuid) TO dyna_app;
CREATE FUNCTION customer_message_assignment_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF NEW.assigned_user_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id)
 AND NOT EXISTS(SELECT 1 FROM public.memberships m WHERE (m.tenant_id,m.user_id)=(NEW.tenant_id,NEW.assigned_user_id) AND m.role IN ('admin','operator'))
 THEN RAISE EXCEPTION 'Assignment target is not an eligible member of this tenant';END IF;RETURN NEW;END $$;
-- Narrow SECURITY DEFINER is required because dyna_app cannot SELECT auth tables.
ALTER FUNCTION customer_message_assignment_scope() SECURITY DEFINER;
REVOKE ALL ON FUNCTION customer_message_assignment_scope() FROM PUBLIC;
CREATE TRIGGER customer_message_assignment_scope BEFORE INSERT OR UPDATE ON customer_message_threads FOR EACH ROW EXECUTE FUNCTION customer_message_assignment_scope();
CREATE FUNCTION customer_message_workflow_run_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF OLD.definition->>'trigger'='customer_message.received' OR EXISTS(SELECT 1 FROM public.customer_message_workflow_receipts r WHERE (r.tenant_id,r.event_id)=(OLD.tenant_id,OLD.event_id)) THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Customer message workflow runs are immutable';END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.rule_id,NEW.rule_version,NEW.event_id,NEW.order_id,NEW.job_id,NEW.definition,NEW.snapshot,NEW.context,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.rule_id,OLD.rule_version,OLD.event_id,OLD.order_id,OLD.job_id,OLD.definition,OLD.snapshot,OLD.context,OLD.created_at)
   OR OLD.state<>'queued' OR NEW.state NOT IN ('done','skipped','failed')
  THEN RAISE EXCEPTION 'Customer message workflow run scope or terminal evidence is immutable';END IF;
 END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END $$;
CREATE TRIGGER customer_message_workflow_run_scope BEFORE UPDATE OR DELETE ON automation_runs FOR EACH ROW EXECUTE FUNCTION customer_message_workflow_run_scope();
