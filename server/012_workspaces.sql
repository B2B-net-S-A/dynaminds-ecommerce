-- Operational plans only: no billing, charges or external subscription is created.
CREATE TABLE service_plans (
  code text PRIMARY KEY,
  name text NOT NULL,
  limits jsonb NOT NULL
);
INSERT INTO service_plans VALUES
('starter','Starter','{"products":1000,"orders":1000,"channels":3,"warehouses":1,"memberships":3}'),
('business','Business','{"products":50000,"orders":50000,"channels":50,"warehouses":10,"memberships":30}'),
('enterprise','Enterprise','{"products":500000,"orders":1000000,"channels":500,"warehouses":100,"memberships":500}');
ALTER TABLE tenants ADD CONSTRAINT tenant_service_plan FOREIGN KEY(plan) REFERENCES service_plans(code);
ALTER TABLE memberships ALTER COLUMN role SET NOT NULL;
CREATE INDEX memberships_tenant_user ON memberships(tenant_id,user_id);
CREATE INDEX sessions_user_tenant ON sessions(user_id,tenant_id);
CREATE UNIQUE INDEX users_email_normalized ON users(lower(email));

CREATE TABLE workspace_invitations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants,
  email text NOT NULL CHECK(email=lower(email)),
  role text NOT NULL CHECK(role IN ('admin','operator','viewer')),
  token_hash text UNIQUE NOT NULL,
  invited_by uuid NOT NULL REFERENCES users,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_by uuid REFERENCES users
);
CREATE UNIQUE INDEX invitations_pending_email ON workspace_invitations(tenant_id,email) WHERE status='pending';
CREATE INDEX invitations_seats ON workspace_invitations(tenant_id,expires_at) WHERE status='pending';
ALTER TABLE workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workspace_invitations TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
-- Auth operations use explicit, audited privileged transactions. No account data grant to dyna_app.

CREATE TABLE workspace_usage (
 tenant_id uuid NOT NULL REFERENCES tenants,
 resource text NOT NULL CHECK(resource IN ('products','orders','channels','warehouses','memberships')),
 period date NOT NULL,
 used bigint NOT NULL DEFAULT 0 CHECK(used>=0),
 PRIMARY KEY(tenant_id,resource,period)
);
ALTER TABLE workspace_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workspace_usage TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON workspace_usage,service_plans TO dyna_app;

-- Backfill existing organizations; subsequent changes share the transaction of their source record.
INSERT INTO workspace_usage SELECT tenant_id,'products','2000-01-01',count(*) FROM products GROUP BY tenant_id;
INSERT INTO workspace_usage SELECT tenant_id,'warehouses','2000-01-01',count(*) FROM warehouses GROUP BY tenant_id;
INSERT INTO workspace_usage SELECT tenant_id,'channels','2000-01-01',count(*) FROM channels GROUP BY tenant_id;
INSERT INTO workspace_usage SELECT tenant_id,'memberships','2000-01-01',count(*) FROM memberships GROUP BY tenant_id;
INSERT INTO workspace_usage SELECT tenant_id,'orders',date_trunc('month',created_at AT TIME ZONE 'UTC')::date,count(*) FROM orders GROUP BY tenant_id,date_trunc('month',created_at AT TIME ZONE 'UTC')::date;

CREATE FUNCTION enforce_workspace_quota() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tid uuid; bucket date='2000-01-01'; maximum bigint; current_used bigint; held_seats bigint=0;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
     (TG_TABLE_NAME='orders' AND to_jsonb(NEW)->>'created_at' IS DISTINCT FROM to_jsonb(OLD)->>'created_at') THEN
   RAISE EXCEPTION 'Nie można zmienić organizacji ani okresu rozliczeniowego rekordu' USING ERRCODE='P0002';
  END IF;
  RETURN NEW;
 END IF;
 tid=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
 IF TG_TABLE_NAME='orders' THEN
  bucket=date_trunc('month',((CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'created_at')::timestamptz AT TIME ZONE 'UTC')::date;
 END IF;
 -- Shared plan lock prevents a downgrade racing with consumption. Resource counters serialize
 -- inserts without rescanning the catalog or order history on each request.
 PERFORM 1 FROM public.tenants WHERE id=tid FOR SHARE;
 SELECT (p.limits->>TG_TABLE_NAME)::bigint INTO maximum FROM public.tenants t
 JOIN public.service_plans p ON p.code=t.plan WHERE t.id=tid;
 INSERT INTO public.workspace_usage(tenant_id,resource,period) VALUES(tid,TG_TABLE_NAME,bucket) ON CONFLICT DO NOTHING;
 SELECT used INTO current_used FROM public.workspace_usage WHERE tenant_id=tid AND resource=TG_TABLE_NAME AND period=bucket FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF TG_TABLE_NAME='memberships' THEN
   SELECT count(*) INTO held_seats FROM public.workspace_invitations WHERE tenant_id=tid AND status='pending' AND expires_at>now();
  END IF;
  IF current_used+held_seats>=maximum THEN
   RAISE EXCEPTION 'Limit planu: %. Wykorzystano %, limit %.',TG_TABLE_NAME,current_used+held_seats,maximum USING ERRCODE='P0001';
  END IF;
  UPDATE public.workspace_usage SET used=used+1 WHERE tenant_id=tid AND resource=TG_TABLE_NAME AND period=bucket;
 ELSE
  UPDATE public.workspace_usage SET used=used-1 WHERE tenant_id=tid AND resource=TG_TABLE_NAME AND period=bucket;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION enforce_workspace_quota() FROM PUBLIC;
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['products','orders','channels','warehouses','memberships'] LOOP
  EXECUTE format('CREATE TRIGGER workspace_quota AFTER INSERT OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION enforce_workspace_quota()',tbl);
  EXECUTE format('CREATE TRIGGER workspace_scope BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION enforce_workspace_quota()',tbl);
 END LOOP;
END $$;
