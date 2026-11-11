ALTER TABLE email_batches ADD COLUMN automation_run_id uuid;
ALTER TABLE email_batches ADD COLUMN automation_schedule_run_id uuid;
ALTER TABLE email_batches ADD COLUMN order_batch_id uuid;
ALTER TABLE email_batches ADD COLUMN order_guard text NOT NULL DEFAULT 'version' CHECK(order_guard IN ('version','content'));
ALTER TABLE email_batches ADD COLUMN external_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE email_batches ADD FOREIGN KEY(tenant_id,automation_run_id) REFERENCES automation_runs(tenant_id,id);
ALTER TABLE email_batches ADD FOREIGN KEY(tenant_id,automation_schedule_run_id) REFERENCES automation_schedule_runs(tenant_id,id);
ALTER TABLE email_batches ADD FOREIGN KEY(tenant_id,order_batch_id) REFERENCES order_batches(tenant_id,id);
ALTER TABLE email_batches ADD CHECK(num_nonnulls(automation_run_id,automation_schedule_run_id,order_batch_id)<=1);
CREATE INDEX email_batches_rule_run ON email_batches(tenant_id,automation_run_id) WHERE automation_run_id IS NOT NULL;
CREATE INDEX email_batches_schedule_run ON email_batches(tenant_id,automation_schedule_run_id) WHERE automation_schedule_run_id IS NOT NULL;
CREATE INDEX email_batches_order_batch ON email_batches(tenant_id,order_batch_id) WHERE order_batch_id IS NOT NULL;
CREATE FUNCTION email_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.state<>'preview' AND ROW(NEW.actor_id,NEW.template_id,NEW.template_version,NEW.mode,NEW.channel_id,NEW.channel_hash,NEW.client_key,NEW.request_hash,NEW.automation_run_id,NEW.automation_schedule_run_id,NEW.order_batch_id,NEW.order_guard,NEW.external_allowed)
 IS DISTINCT FROM ROW(OLD.actor_id,OLD.template_id,OLD.template_version,OLD.mode,OLD.channel_id,OLD.channel_hash,OLD.client_key,OLD.request_hash,OLD.automation_run_id,OLD.automation_schedule_run_id,OLD.order_batch_id,OLD.order_guard,OLD.external_allowed)
 THEN RAISE EXCEPTION 'Źródło i zgoda kolejki email są niezmienne'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER email_origin_immutable BEFORE UPDATE ON email_batches FOR EACH ROW EXECUTE FUNCTION email_origin_immutable();
