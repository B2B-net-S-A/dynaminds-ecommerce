-- Remote GET is a Node transport trust boundary. SQL independently binds current
-- source/principal/lease, immutable 118 preview/run and explicit publish consent.
CREATE TABLE supplier_file_remotes(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,source_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),source_version integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,url_cipher text NOT NULL,auth_cipher text,display_host text NOT NULL,
 auth_kind text NOT NULL CHECK(auth_kind IN('none','basic','bearer','header')),scope text NOT NULL CHECK(scope IN('delta','full')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,source_id),
 CHECK(length(url_cipher) BETWEEN 40 AND 65536),CHECK((auth_kind='none')=(auth_cipher IS NULL)),
 FOREIGN KEY(tenant_id,source_id) REFERENCES supplier_sources(tenant_id,id),FOREIGN KEY(tenant_id,source_id,source_version) REFERENCES supplier_file_source_revisions(tenant_id,source_id,version),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE supplier_file_remote_revisions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,source_id uuid NOT NULL,version integer NOT NULL,source_version integer NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),url_cipher text NOT NULL,auth_cipher text,request_cipher text NOT NULL,payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,source_id,version),UNIQUE(tenant_id,source_id,client_key),
 FOREIGN KEY(tenant_id,source_id) REFERENCES supplier_sources(tenant_id,id),FOREIGN KEY(tenant_id,source_id,source_version) REFERENCES supplier_file_source_revisions(tenant_id,source_id,version),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE supplier_file_feed_schedules(
 tenant_id uuid NOT NULL,source_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),source_version integer NOT NULL,remote_version integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,enabled boolean NOT NULL,interval_minutes integer NOT NULL CHECK(interval_minutes BETWEEN 30 AND 10080),publish jsonb NOT NULL,
 next_at timestamptz,last_fetch_id uuid,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,source_id),FOREIGN KEY(tenant_id,source_id) REFERENCES supplier_sources(tenant_id,id),FOREIGN KEY(tenant_id,source_id,remote_version) REFERENCES supplier_file_remote_revisions(tenant_id,source_id,version),FOREIGN KEY(tenant_id,source_id,source_version) REFERENCES supplier_file_source_revisions(tenant_id,source_id,version),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE supplier_file_feed_schedule_revisions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,source_id uuid NOT NULL,version integer NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,source_id,version),UNIQUE(tenant_id,source_id,client_key),FOREIGN KEY(tenant_id,source_id) REFERENCES supplier_sources(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE supplier_file_fetch_runs(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,source_id uuid NOT NULL,source_version integer NOT NULL,remote_version integer NOT NULL,schedule_version integer,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),job_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','fetching','success','awaiting-consent','failed','conflict','cancelled')),phase text NOT NULL DEFAULT 'queued',attempt integer NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 3),lease_token uuid,
 queued_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,http_status integer,wire_bytes integer,decoded_bytes integer,wire_hash text,raw_hash text,
 preview_id uuid,run_id uuid,summary jsonb,error_code text,request jsonb NOT NULL,policy_snapshot jsonb,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,source_id,client_key),UNIQUE(tenant_id,job_id),
 FOREIGN KEY(tenant_id,source_id) REFERENCES supplier_sources(tenant_id,id),FOREIGN KEY(tenant_id,source_id,source_version) REFERENCES supplier_file_source_revisions(tenant_id,source_id,version),FOREIGN KEY(tenant_id,source_id,remote_version) REFERENCES supplier_file_remote_revisions(tenant_id,source_id,version),FOREIGN KEY(tenant_id,source_id,schedule_version) REFERENCES supplier_file_feed_schedule_revisions(tenant_id,source_id,version),
 FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),FOREIGN KEY(tenant_id,preview_id) REFERENCES supplier_file_previews(tenant_id,id),FOREIGN KEY(tenant_id,run_id) REFERENCES supplier_file_runs(tenant_id,id),
 CHECK((state IN('queued','fetching'))=(finished_at IS NULL)),CHECK(run_id IS NULL OR(state='success' AND preview_id IS NOT NULL)),
 CHECK(wire_bytes IS NULL OR wire_bytes BETWEEN 0 AND 2097152),CHECK(decoded_bytes IS NULL OR decoded_bytes BETWEEN 0 AND 2097152),
 CHECK(wire_hash IS NULL OR wire_hash~'^[a-f0-9]{64}$'),CHECK(raw_hash IS NULL OR raw_hash~'^[a-f0-9]{64}$'),CHECK(error_code IS NULL OR error_code~'^[A-Z_]{1,80}$')
);
ALTER TABLE supplier_file_feed_schedules ADD FOREIGN KEY(tenant_id,last_fetch_id) REFERENCES supplier_file_fetch_runs(tenant_id,id);
CREATE UNIQUE INDEX supplier_file_fetch_one_active ON supplier_file_fetch_runs(tenant_id,source_id) WHERE state IN('queued','fetching');
CREATE INDEX supplier_file_fetch_history ON supplier_file_fetch_runs(tenant_id,source_id,queued_at DESC,id DESC);
CREATE INDEX supplier_file_feed_due ON supplier_file_feed_schedules(next_at,source_id) WHERE enabled AND error_code IS NULL;
DO $$DECLARE tbl text;BEGIN
 FOREACH tbl IN ARRAY ARRAY['supplier_file_remotes','supplier_file_remote_revisions','supplier_file_feed_schedules','supplier_file_feed_schedule_revisions','supplier_file_fetch_runs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 END LOOP;
END$$;
GRANT SELECT(id,tenant_id,source_id,version,source_version,actor_id,api_key_id,display_host,auth_kind,scope,created_at,updated_at) ON supplier_file_remotes TO dyna_app;
GRANT SELECT(id,tenant_id,source_id,version,source_version,actor_id,api_key_id,client_key,payload,created_at) ON supplier_file_remote_revisions TO dyna_app;
GRANT SELECT ON supplier_file_feed_schedules,supplier_file_feed_schedule_revisions TO dyna_app;
GRANT SELECT(id,tenant_id,source_id,source_version,remote_version,schedule_version,actor_id,api_key_id,client_key,request_hash,job_id,state,phase,attempt,queued_at,started_at,finished_at,http_status,wire_bytes,decoded_bytes,wire_hash,raw_hash,preview_id,run_id,summary,error_code,request,policy_snapshot) ON supplier_file_fetch_runs TO dyna_app;

CREATE FUNCTION supplier_remote_installed() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT 1 FROM migrations WHERE name='119_supplier_remote_feeds')$$;
CREATE FUNCTION supplier_remote_access(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT supplier_file_access(uid,kid,writing,pin)$$;
CREATE FUNCTION supplier_remote_require(uid uuid,kid uuid,pin boolean) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT supplier_file_require(uid,kid,pin)$$;
CREATE FUNCTION supplier_remote_lock(sid uuid) RETURNS supplier_sources LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;s supplier_sources%ROWTYPE;BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'Brak kontekstu firmy' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('supplier-file:'||t::text,0));
 SELECT * INTO s FROM supplier_sources WHERE(tenant_id,id)=(t,sid) AND kind='file' FOR UPDATE;
 IF s.id IS NULL THEN RAISE EXCEPTION 'Brak własnego źródła plikowego' USING ERRCODE='P0002';END IF;RETURN s;
END$$;
CREATE FUNCTION supplier_remote_quota(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('supplier-file:'||t::text,0));
 IF(SELECT count(*) FROM supplier_file_fetch_runs WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit 2000 pobrań feedu' USING ERRCODE='P0001';END IF;
 IF(SELECT coalesce(sum(n),0) FROM(
 SELECT octet_length(url_cipher)+coalesce(octet_length(auth_cipher),0) n FROM supplier_file_remotes WHERE tenant_id=t
 UNION ALL SELECT octet_length(url_cipher)+coalesce(octet_length(auth_cipher),0)+octet_length(request_cipher)+octet_length(payload::text) FROM supplier_file_remote_revisions WHERE tenant_id=t
 UNION ALL SELECT octet_length(to_jsonb(f)::text) FROM supplier_file_fetch_runs f WHERE tenant_id=t
 UNION ALL SELECT octet_length(to_jsonb(s)::text) FROM supplier_file_feed_schedules s WHERE tenant_id=t
 UNION ALL SELECT octet_length(payload::text) FROM supplier_file_feed_schedule_revisions WHERE tenant_id=t
 ) x)>33554432 THEN RAISE EXCEPTION 'Limit 32 MiB historii zdalnych feedów' USING ERRCODE='P0001';END IF;
END$$;
CREATE FUNCTION supplier_remote_policy_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$DECLARE w jsonb:=p->'withdrawal';BEGIN
 RETURN (jsonb_typeof(p)='object' AND p ?& ARRAY['enabled','allow_new','withdrawal'] AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p) k(n) WHERE k.n NOT IN('enabled','allow_new','withdrawal'))
 AND jsonb_typeof(p->'enabled')='boolean' AND jsonb_typeof(p->'allow_new')='boolean' AND jsonb_typeof(w)='object' AND w ?& ARRAY['enabled','min_rows','max_missing','max_missing_percent']
 AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(w) k(n) WHERE k.n NOT IN('enabled','min_rows','max_missing','max_missing_percent')) AND jsonb_typeof(w->'enabled')='boolean'
 AND(w->>'min_rows')~'^[0-9]+$' AND(w->>'min_rows')::numeric BETWEEN 1 AND 500 AND(w->>'max_missing')~'^[0-9]+$' AND(w->>'max_missing')::numeric BETWEEN 0 AND 10000 AND(w->>'max_missing_percent')~'^[0-9]+$' AND(w->>'max_missing_percent')::numeric BETWEEN 0 AND 100) IS TRUE;
END$$;
CREATE FUNCTION supplier_remote_cancel(sid uuid,why text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;BEGIN
 WITH stopped AS(UPDATE supplier_file_fetch_runs SET state='cancelled',phase='cancelled',finished_at=clock_timestamp(),error_code=why WHERE tenant_id=t AND source_id=sid AND state IN('queued','fetching') RETURNING job_id)
 UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE tenant_id=t AND id IN(SELECT job_id FROM stopped);
END$$;
CREATE FUNCTION supplier_remote_replay_remote(sid uuid,ck uuid,rh text,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r supplier_file_remote_revisions%ROWTYPE;BEGIN
 PERFORM supplier_remote_require(uid,kid,false);
 SELECT * INTO r FROM supplier_file_remote_revisions WHERE tenant_id=t AND source_id=sid AND client_key=ck;
 IF r.id IS NULL THEN RETURN NULL;END IF;
 IF r.actor_id IS DISTINCT FROM uid OR r.api_key_id IS DISTINCT FROM kid OR r.request_hash IS DISTINCT FROM rh THEN RAISE EXCEPTION 'REMOTE_RETRY_MISMATCH' USING ERRCODE='P0001';END IF;
 RETURN r.payload||'{"reused":true}'::jsonb;
END$$;
CREATE FUNCTION supplier_remote_save_remote(sid uuid,v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s supplier_sources%ROWTYPE;t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;o supplier_file_remotes%ROWTYPE;prior supplier_file_remote_revisions%ROWTYPE;u text;ac text;ak text;outv jsonb;BEGIN
 s:=supplier_remote_lock(sid);PERFORM supplier_remote_require(uid,kid,false);
 SELECT * INTO prior FROM supplier_file_remote_revisions WHERE tenant_id=t AND source_id=sid AND client_key=(v->>'client_key')::uuid;
 IF prior.id IS NOT NULL THEN IF prior.request_hash IS DISTINCT FROM v->>'request_hash' OR prior.actor_id IS DISTINCT FROM uid OR prior.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'REMOTE_RETRY_MISMATCH' USING ERRCODE='P0001';END IF;RETURN prior.payload||'{"reused":true}'::jsonb;END IF;
 SELECT * INTO o FROM supplier_file_remotes WHERE tenant_id=t AND source_id=sid FOR UPDATE;
 IF coalesce(o.version,0)<>(v->>'version')::integer OR s.version<>(v->>'source_version')::integer+1 OR NOT EXISTS(SELECT 1 FROM supplier_file_source_revisions r WHERE(r.tenant_id,r.source_id,r.version,r.actor_id,r.client_key)=(t,sid,s.version,uid,(v->>'client_key')::uuid) AND r.api_key_id IS NOT DISTINCT FROM kid) THEN RAISE EXCEPTION 'REMOTE_VERSION_CONFLICT' USING ERRCODE='P0001';END IF;
 u:=coalesce(v->>'url_cipher',o.url_cipher);IF u IS NULL OR length(u) NOT BETWEEN 40 AND 65536 THEN RAISE EXCEPTION 'REMOTE_URL_REQUIRED' USING ERRCODE='P0001';END IF;
 IF v->>'auth_action'='keep' THEN ac:=o.auth_cipher;ak:=coalesce(o.auth_kind,'none');
 ELSIF v->>'auth_action'='clear' THEN ac:=NULL;ak:='none';
 ELSIF v->>'auth_action'='replace' THEN ac:=v->>'auth_cipher';ak:=v->>'auth_kind';IF ak NOT IN('basic','bearer','header') OR coalesce(length(ac),0) NOT BETWEEN 40 AND 65536 THEN RAISE EXCEPTION 'Nieprawidłowe credentials feedu' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'Nieprawidłowa operacja credentials' USING ERRCODE='23514';END IF;
 IF v->>'scope' NOT IN('delta','full') OR coalesce(length(coalesce(v->>'display_host',o.display_host)),0) NOT BETWEEN 1 AND 253 OR coalesce(v->>'display_host',o.display_host)~'[/@?#[:space:]]' THEN RAISE EXCEPTION 'Nieprawidłowa konfiguracja feedu' USING ERRCODE='23514';END IF;
 outv:=jsonb_build_object('id',coalesce(o.id,(v->>'id')::uuid),'source_id',sid,'version',coalesce(o.version,0)+1,'source_version',s.version,'configured',true,'display_host',coalesce(v->>'display_host',o.display_host),'auth_kind',ak,'has_credentials',ac IS NOT NULL,'scope',v->>'scope');
 INSERT INTO supplier_file_remote_revisions(id,tenant_id,source_id,version,source_version,actor_id,api_key_id,client_key,request_hash,url_cipher,auth_cipher,request_cipher,payload)
 VALUES((v->>'revision_id')::uuid,t,sid,coalesce(o.version,0)+1,s.version,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',u,ac,v->>'request_cipher',outv);
 INSERT INTO supplier_file_remotes(id,tenant_id,source_id,version,source_version,actor_id,api_key_id,url_cipher,auth_cipher,display_host,auth_kind,scope)
 VALUES((outv->>'id')::uuid,t,sid,(outv->>'version')::integer,s.version,uid,kid,u,ac,outv->>'display_host',ak,v->>'scope')
 ON CONFLICT(tenant_id,source_id) DO UPDATE SET version=EXCLUDED.version,source_version=EXCLUDED.source_version,actor_id=uid,api_key_id=kid,url_cipher=u,auth_cipher=ac,display_host=EXCLUDED.display_host,auth_kind=ak,scope=EXCLUDED.scope,updated_at=now();
 PERFORM supplier_remote_cancel(sid,'CONFIG_CHANGED');
 UPDATE supplier_file_feed_schedules SET error_code='CONFIG_CHANGED',next_at=NULL,updated_at=now() WHERE tenant_id=t AND source_id=sid;
 PERFORM supplier_remote_quota(t);RETURN outv||'{"reused":false}'::jsonb;
END$$;
CREATE FUNCTION supplier_remote_save_schedule(sid uuid,v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s supplier_sources%ROWTYPE;t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;o supplier_file_feed_schedules%ROWTYPE;r supplier_file_remotes%ROWTYPE;prior supplier_file_feed_schedule_revisions%ROWTYPE;outv jsonb;BEGIN
 s:=supplier_remote_lock(sid);PERFORM supplier_remote_require(uid,kid,false);
 SELECT * INTO prior FROM supplier_file_feed_schedule_revisions WHERE tenant_id=t AND source_id=sid AND client_key=(v->>'client_key')::uuid;
 IF prior.id IS NOT NULL THEN IF prior.request_hash IS DISTINCT FROM v->>'request_hash' OR prior.actor_id IS DISTINCT FROM uid OR prior.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'REMOTE_RETRY_MISMATCH' USING ERRCODE='P0001';END IF;RETURN prior.payload||'{"reused":true}'::jsonb;END IF;
 SELECT * INTO o FROM supplier_file_feed_schedules WHERE tenant_id=t AND source_id=sid FOR UPDATE;SELECT * INTO r FROM supplier_file_remotes WHERE tenant_id=t AND source_id=sid FOR UPDATE;
 IF coalesce(o.version,0)<>(v->>'version')::integer OR s.version<>(v->>'source_version')::integer OR r.version IS DISTINCT FROM (v->>'remote_version')::integer OR ((v->>'enabled')::boolean AND r.source_version<>s.version) THEN RAISE EXCEPTION 'REMOTE_VERSION_CONFLICT' USING ERRCODE='P0001';END IF;
 IF NOT supplier_remote_policy_valid(v->'publish') OR (v->>'interval_minutes')::integer NOT BETWEEN 30 AND 10080 OR jsonb_typeof(v->'enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Nieprawidłowa zgoda harmonogramu' USING ERRCODE='23514';END IF;
 IF(v->>'enabled')::boolean AND(s.paused OR NOT EXISTS(SELECT 1 FROM suppliers WHERE tenant_id=t AND id=s.supplier_id AND active)) THEN RAISE EXCEPTION 'REMOTE_SOURCE_DISABLED' USING ERRCODE='P0001';END IF;
 outv:=jsonb_build_object('source_id',sid,'version',coalesce(o.version,0)+1,'source_version',s.version,'remote_version',r.version,'enabled',(v->>'enabled')::boolean,'interval_minutes',(v->>'interval_minutes')::integer,'publish',v->'publish');
 INSERT INTO supplier_file_feed_schedule_revisions(id,tenant_id,source_id,version,actor_id,api_key_id,client_key,request_hash,payload) VALUES((v->>'id')::uuid,t,sid,coalesce(o.version,0)+1,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',outv);
 PERFORM supplier_remote_cancel(sid,'SCHEDULE_CHANGED');
 INSERT INTO supplier_file_feed_schedules(tenant_id,source_id,version,source_version,remote_version,actor_id,api_key_id,enabled,interval_minutes,publish,next_at)
 VALUES(t,sid,coalesce(o.version,0)+1,s.version,r.version,uid,kid,(v->>'enabled')::boolean,(v->>'interval_minutes')::integer,v->'publish',CASE WHEN(v->>'enabled')::boolean THEN now()+make_interval(mins=>(v->>'interval_minutes')::integer) END)
 ON CONFLICT(tenant_id,source_id) DO UPDATE SET version=EXCLUDED.version,source_version=s.version,remote_version=r.version,actor_id=uid,api_key_id=kid,enabled=EXCLUDED.enabled,interval_minutes=EXCLUDED.interval_minutes,publish=EXCLUDED.publish,next_at=EXCLUDED.next_at,last_fetch_id=NULL,error_code=NULL,updated_at=now();
 PERFORM supplier_remote_quota(t);RETURN outv||'{"reused":false}'::jsonb;
END$$;
CREATE FUNCTION supplier_remote_queue(sid uuid,v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s supplier_sources%ROWTYPE;t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r supplier_file_remotes%ROWTYPE;cfg supplier_file_feed_schedules%ROWTYPE;old supplier_file_fetch_runs%ROWTYPE;fid uuid:=(v->>'id')::uuid;jid uuid:=(v->>'job_id')::uuid;sv integer:=(v->>'schedule_version')::integer;BEGIN
 s:=supplier_remote_lock(sid);PERFORM supplier_remote_require(uid,kid,false);
 SELECT * INTO old FROM supplier_file_fetch_runs WHERE tenant_id=t AND source_id=sid AND client_key=(v->>'client_key')::uuid;
 IF old.id IS NOT NULL THEN IF old.actor_id IS DISTINCT FROM uid OR old.api_key_id IS DISTINCT FROM kid OR old.request_hash IS DISTINCT FROM v->>'request_hash' THEN RAISE EXCEPTION 'REMOTE_RETRY_MISMATCH' USING ERRCODE='P0001';END IF;RETURN jsonb_build_object('id',old.id,'reused',true);END IF;
 SELECT * INTO r FROM supplier_file_remotes WHERE tenant_id=t AND source_id=sid FOR UPDATE;
 IF s.version<>(v->>'source_version')::integer OR r.version IS DISTINCT FROM(v->>'remote_version')::integer OR r.source_version<>s.version THEN RAISE EXCEPTION 'REMOTE_VERSION_CONFLICT' USING ERRCODE='P0001';END IF;
 IF s.paused OR NOT EXISTS(SELECT 1 FROM suppliers WHERE tenant_id=t AND id=s.supplier_id AND active) THEN RAISE EXCEPTION 'REMOTE_SOURCE_DISABLED' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM supplier_file_fetch_runs WHERE tenant_id=t AND source_id=sid AND state IN('queued','fetching')) THEN RAISE EXCEPTION 'REMOTE_FETCH_ACTIVE' USING ERRCODE='P0001';END IF;
 IF(SELECT count(*) FROM jobs WHERE tenant_id=t AND state IN('pending','running'))>=1000 OR(SELECT count(*) FROM supplier_file_fetch_runs WHERE tenant_id=t)>=2000 THEN RAISE EXCEPTION 'REMOTE_QUEUE_FULL' USING ERRCODE='P0001';END IF;
 IF sv IS NOT NULL THEN SELECT * INTO cfg FROM supplier_file_feed_schedules WHERE tenant_id=t AND source_id=sid FOR UPDATE;
  IF cfg.version IS DISTINCT FROM sv OR NOT cfg.enabled OR cfg.error_code IS NOT NULL OR cfg.source_version<>s.version OR cfg.remote_version<>r.version OR cfg.actor_id IS DISTINCT FROM uid OR cfg.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'REMOTE_SCHEDULE_CONFLICT' USING ERRCODE='P0001';END IF;
 END IF;
 INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES(jid,t,'supplier.file.fetch',jsonb_build_object('fetch_id',fid),'supplier.file.fetch:'||fid::text,3);
 INSERT INTO supplier_file_fetch_runs(id,tenant_id,source_id,source_version,remote_version,schedule_version,actor_id,api_key_id,client_key,request_hash,job_id,request,policy_snapshot)
 VALUES(fid,t,sid,s.version,r.version,sv,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',jid,v->'request',CASE WHEN sv IS NOT NULL THEN cfg.publish END);
 IF sv IS NOT NULL THEN UPDATE supplier_file_feed_schedules SET last_fetch_id=fid,next_at=NULL,error_code=NULL,updated_at=now() WHERE tenant_id=t AND source_id=sid;END IF;
 PERFORM supplier_remote_quota(t);RETURN jsonb_build_object('id',fid,'reused',false);
END$$;
CREATE FUNCTION supplier_remote_start(fid uuid,jid uuid,token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;f supplier_file_fetch_runs%ROWTYPE;s supplier_sources%ROWTYPE;r supplier_file_remotes%ROWTYPE;j jobs%ROWTYPE;BEGIN
 SELECT * INTO f FROM supplier_file_fetch_runs WHERE tenant_id=t AND id=fid;
 IF f.id IS NULL THEN RAISE EXCEPTION 'Brak pobrania' USING ERRCODE='P0002';END IF;
 s:=supplier_remote_lock(f.source_id);SELECT * INTO r FROM supplier_file_remotes WHERE tenant_id=t AND source_id=f.source_id FOR UPDATE;SELECT * INTO f FROM supplier_file_fetch_runs WHERE tenant_id=t AND id=fid FOR UPDATE;SELECT * INTO j FROM jobs WHERE tenant_id=t AND id=jid FOR UPDATE;
 IF f.state NOT IN('queued','fetching') THEN RETURN jsonb_build_object('terminal',true);END IF;
 IF f.job_id IS DISTINCT FROM jid OR j.kind IS DISTINCT FROM 'supplier.file.fetch' OR j.payload->>'fetch_id' IS DISTINCT FROM f.id::text OR j.state IS DISTINCT FROM 'running' OR j.lease_token IS DISTINCT FROM token OR token IS NULL OR j.locked_at IS NULL OR j.locked_at<clock_timestamp()-interval '5 minutes' THEN RAISE EXCEPTION 'REMOTE_LEASE_LOST' USING ERRCODE='P0001';END IF;
 IF f.state='fetching' AND f.lease_token=token THEN RETURN jsonb_build_object('terminal',true,'in_progress',true);END IF;
 PERFORM supplier_remote_require(f.actor_id,f.api_key_id,false);
 IF s.version<>f.source_version OR r.version<>f.remote_version OR r.source_version<>s.version OR s.paused OR NOT EXISTS(SELECT 1 FROM suppliers WHERE tenant_id=t AND id=s.supplier_id AND active) THEN RAISE EXCEPTION 'REMOTE_VERSION_CONFLICT' USING ERRCODE='P0001';END IF;
 IF f.schedule_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM supplier_file_feed_schedules q WHERE(q.tenant_id,q.source_id,q.version,q.source_version,q.remote_version,q.actor_id)=(t,f.source_id,f.schedule_version,f.source_version,f.remote_version,f.actor_id) AND q.api_key_id IS NOT DISTINCT FROM f.api_key_id AND q.enabled AND q.error_code IS NULL AND q.publish=f.policy_snapshot) THEN RAISE EXCEPTION 'REMOTE_SCHEDULE_CONFLICT' USING ERRCODE='P0001';END IF;
 UPDATE supplier_file_fetch_runs SET state='fetching',phase='fetching',started_at=coalesce(started_at,clock_timestamp()),attempt=j.attempts,lease_token=token WHERE tenant_id=t AND id=fid;
 RETURN jsonb_build_object('terminal',false,'source_id',f.source_id,'actor_id',f.actor_id,'api_key_id',f.api_key_id,'source_version',f.source_version,'remote_version',f.remote_version,'scope',r.scope,'schedule_version',f.schedule_version,'policy',f.policy_snapshot);
END$$;
CREATE FUNCTION supplier_remote_finish(fid uuid,jid uuid,token uuid,v jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;f supplier_file_fetch_runs%ROWTYPE;s supplier_sources%ROWTYPE;r supplier_file_remotes%ROWTYPE;j jobs%ROWTYPE;cfg supplier_file_feed_schedules%ROWTYPE;p supplier_file_previews%ROWTYPE;fr supplier_file_runs%ROWTYPE;total integer;missing integer;denominator integer;policy jsonb;BEGIN
 SELECT * INTO f FROM supplier_file_fetch_runs WHERE tenant_id=t AND id=fid;IF f.id IS NULL THEN RAISE EXCEPTION 'Brak pobrania' USING ERRCODE='P0002';END IF;
 s:=supplier_remote_lock(f.source_id);SELECT * INTO r FROM supplier_file_remotes WHERE tenant_id=t AND source_id=f.source_id FOR UPDATE;SELECT * INTO cfg FROM supplier_file_feed_schedules WHERE tenant_id=t AND source_id=f.source_id FOR UPDATE;SELECT * INTO f FROM supplier_file_fetch_runs WHERE tenant_id=t AND id=fid FOR UPDATE;SELECT * INTO j FROM jobs WHERE tenant_id=t AND id=jid FOR UPDATE;
 IF f.state NOT IN('queued','fetching') THEN RETURN;END IF;
 IF f.job_id IS DISTINCT FROM jid OR j.kind IS DISTINCT FROM 'supplier.file.fetch' OR j.payload->>'fetch_id' IS DISTINCT FROM f.id::text OR j.state IS DISTINCT FROM 'running' OR j.lease_token IS DISTINCT FROM token OR token IS NULL OR j.locked_at IS NULL OR j.locked_at<clock_timestamp()-interval '5 minutes' THEN RAISE EXCEPTION 'REMOTE_LEASE_LOST' USING ERRCODE='P0001';END IF;
 IF v->>'state' NOT IN('success','awaiting-consent','failed','conflict','cancelled') THEN RAISE EXCEPTION 'Nieprawidłowy wynik pobrania' USING ERRCODE='23514';END IF;
 IF v->>'state' IN('success','awaiting-consent') THEN
  PERFORM supplier_remote_require(f.actor_id,f.api_key_id,false);
  IF s.version<>f.source_version OR r.version<>f.remote_version OR r.source_version<>s.version OR s.paused OR NOT EXISTS(SELECT 1 FROM suppliers WHERE tenant_id=t AND id=s.supplier_id AND active) THEN RAISE EXCEPTION 'REMOTE_VERSION_CONFLICT' USING ERRCODE='P0001';END IF;
  IF f.schedule_version IS NOT NULL AND(cfg.version IS DISTINCT FROM f.schedule_version OR cfg.actor_id IS DISTINCT FROM f.actor_id OR cfg.api_key_id IS DISTINCT FROM f.api_key_id OR NOT cfg.enabled OR cfg.error_code IS NOT NULL OR cfg.publish IS DISTINCT FROM f.policy_snapshot) THEN RAISE EXCEPTION 'REMOTE_SCHEDULE_CONFLICT' USING ERRCODE='P0001';END IF;
  SELECT * INTO p FROM supplier_file_previews WHERE(tenant_id,id)=(t,(v->>'preview_id')::uuid);
  IF p.id IS NULL OR (p.source_id,p.source_version,p.actor_id,p.client_key) IS DISTINCT FROM(f.source_id,f.source_version,f.actor_id,f.id) OR p.api_key_id IS DISTINCT FROM f.api_key_id OR p.raw_hash IS DISTINCT FROM v->>'raw_hash' OR p.raw_bytes IS DISTINCT FROM(v->>'decoded_bytes')::integer OR p.payload->>'scope' IS DISTINCT FROM r.scope OR(v->>'http_status')::integer IS DISTINCT FROM 200 THEN RAISE EXCEPTION 'Niepełny dowód odebranego feedu' USING ERRCODE='23514';END IF;
  IF v->>'run_id' IS NOT NULL THEN
   SELECT * INTO fr FROM supplier_file_runs WHERE(tenant_id,id)=(t,(v->>'run_id')::uuid);
   IF f.schedule_version IS NULL OR cfg.publish->'enabled' IS DISTINCT FROM 'true'::jsonb OR fr.id IS NULL OR(fr.source_id,fr.preview_id,fr.actor_id,fr.client_key) IS DISTINCT FROM(f.source_id,p.id,f.actor_id,f.id) OR fr.api_key_id IS DISTINCT FROM f.api_key_id OR fr.top_xid<>pg_current_xact_id() OR fr.transaction_started_at<>transaction_timestamp() THEN RAISE EXCEPTION 'Brak zatwierdzonej publikacji harmonogramu' USING ERRCODE='23514';END IF;
   policy:=cfg.publish;total:=jsonb_array_length(p.payload->'rows');missing:=jsonb_array_length(p.payload->'missing');denominator:=jsonb_array_length(p.payload->'expected_items');
   IF(p.payload->'summary'->>'invalid')::integer<>0 OR ((policy->>'allow_new')::boolean IS NOT TRUE AND(p.payload->'summary'->>'new')::integer>0) OR(p.payload->>'scope'='full' AND missing>0 AND((policy->'withdrawal'->>'enabled')::boolean IS NOT TRUE OR total<(policy->'withdrawal'->>'min_rows')::integer OR missing>(policy->'withdrawal'->>'max_missing')::integer OR missing::numeric*100>greatest(denominator,1)::numeric*(policy->'withdrawal'->>'max_missing_percent')::integer)) THEN RAISE EXCEPTION 'Publikacja przekracza zgodę harmonogramu' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 UPDATE supplier_file_fetch_runs SET state=v->>'state',phase=v->>'state',finished_at=clock_timestamp(),http_status=(v->>'http_status')::integer,wire_bytes=(v->>'wire_bytes')::integer,decoded_bytes=(v->>'decoded_bytes')::integer,wire_hash=v->>'wire_hash',raw_hash=v->>'raw_hash',preview_id=(v->>'preview_id')::uuid,run_id=(v->>'run_id')::uuid,summary=CASE WHEN p.id IS NOT NULL THEN p.payload->'summary' END,error_code=v->>'error_code' WHERE tenant_id=t AND id=fid;
 UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE tenant_id=t AND id=jid;
 IF f.schedule_version IS NOT NULL AND cfg.version=f.schedule_version THEN UPDATE supplier_file_feed_schedules SET next_at=CASE WHEN v->>'state'='success' THEN clock_timestamp()+make_interval(mins=>interval_minutes) END,error_code=CASE WHEN v->>'state'='success' THEN NULL ELSE coalesce(v->>'error_code','AWAITING_CONSENT') END,updated_at=now() WHERE tenant_id=t AND source_id=f.source_id;END IF;
END$$;
CREATE FUNCTION supplier_remote_defer(sid uuid,why text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE s supplier_sources%ROWTYPE;t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;BEGIN
 s:=supplier_remote_lock(sid);
 IF why NOT IN('IAM_REVOKED','CONFIG_CHANGED','QUOTA','QUEUE_FULL') THEN RAISE EXCEPTION 'Nieprawidłowy powód wstrzymania' USING ERRCODE='23514';END IF;
 UPDATE supplier_file_feed_schedules SET next_at=CASE WHEN why='QUEUE_FULL' THEN now()+interval '1 minute' END,error_code=CASE WHEN why='QUEUE_FULL' THEN NULL ELSE why END,updated_at=now() WHERE tenant_id=t AND source_id=sid;
END$$;

-- Maintenance never accepts a caller-invented revocation/conflict condition.
CREATE FUNCTION supplier_remote_sweep(sid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s supplier_sources%ROWTYPE;t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;cfg supplier_file_feed_schedules%ROWTYPE;r supplier_file_remotes%ROWTYPE;g jsonb;why text;BEGIN
 s:=supplier_remote_lock(sid);SELECT * INTO cfg FROM supplier_file_feed_schedules WHERE tenant_id=t AND source_id=sid FOR UPDATE;IF cfg.source_id IS NULL OR NOT cfg.enabled THEN RETURN;END IF;
 SELECT * INTO r FROM supplier_file_remotes WHERE tenant_id=t AND source_id=sid;g:=supplier_remote_access(cfg.actor_id,cfg.api_key_id,true,false);
 IF(g->>'allowed')::boolean IS NOT TRUE THEN why:='IAM_REVOKED';
 ELSIF s.version<>cfg.source_version OR r.version IS DISTINCT FROM cfg.remote_version OR r.source_version<>s.version OR s.paused OR NOT EXISTS(SELECT 1 FROM suppliers WHERE tenant_id=t AND id=s.supplier_id AND active) THEN why:='CONFIG_CHANGED';
 ELSIF(SELECT count(*) FROM supplier_file_fetch_runs WHERE tenant_id=t)>=2000 OR(SELECT count(*) FROM supplier_file_previews WHERE tenant_id=t)>=200 THEN why:='QUOTA';
 ELSIF(SELECT count(*) FROM jobs WHERE tenant_id=t AND state IN('pending','running'))>=1000 THEN why:='QUEUE_FULL';END IF;
 IF why IS NOT NULL THEN PERFORM supplier_remote_defer(sid,why);END IF;
END$$;
CREATE FUNCTION supplier_remote_retry(fid uuid,jid uuid,token uuid,why text,status integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;f supplier_file_fetch_runs%ROWTYPE;s supplier_sources%ROWTYPE;j jobs%ROWTYPE;g jsonb;BEGIN
 SELECT * INTO f FROM supplier_file_fetch_runs WHERE tenant_id=t AND id=fid;IF f.id IS NULL THEN RETURN false;END IF;s:=supplier_remote_lock(f.source_id);
 SELECT * INTO f FROM supplier_file_fetch_runs WHERE tenant_id=t AND id=fid FOR UPDATE;SELECT * INTO j FROM jobs WHERE tenant_id=t AND id=jid FOR UPDATE;
 IF f.state NOT IN('queued','fetching') OR f.job_id IS DISTINCT FROM jid OR j.kind IS DISTINCT FROM 'supplier.file.fetch' OR j.payload->>'fetch_id' IS DISTINCT FROM f.id::text OR j.state IS DISTINCT FROM 'running' OR j.lease_token IS DISTINCT FROM token OR token IS NULL THEN RETURN false;END IF;
 IF j.attempts>=j.max_attempts OR NOT(why IN('NETWORK_FAILED','DEADLINE','CONNECT_TIMEOUT','IDLE_TIMEOUT','DNS_FAILED') OR status IN(429,503)) THEN RETURN false;END IF;
 g:=supplier_remote_access(f.actor_id,f.api_key_id,true,false);IF(g->>'allowed')::boolean IS NOT TRUE THEN RETURN false;END IF;
 UPDATE supplier_file_fetch_runs SET state='queued',phase='queued',lease_token=NULL,error_code=why,http_status=status WHERE tenant_id=t AND id=fid;
 UPDATE jobs SET state='pending',lease_token=NULL,locked_at=NULL,error=NULL,run_at=clock_timestamp()+make_interval(secs=>least(300,power(2,j.attempts)::integer)) WHERE tenant_id=t AND id=jid;
 RETURN true;
END$$;
CREATE FUNCTION supplier_remote_reap(fid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;f supplier_file_fetch_runs%ROWTYPE;s supplier_sources%ROWTYPE;j jobs%ROWTYPE;BEGIN
 SELECT * INTO f FROM supplier_file_fetch_runs WHERE tenant_id=t AND id=fid;IF f.id IS NULL THEN RETURN;END IF;s:=supplier_remote_lock(f.source_id);
 SELECT * INTO f FROM supplier_file_fetch_runs WHERE tenant_id=t AND id=fid FOR UPDATE;SELECT * INTO j FROM jobs WHERE tenant_id=t AND id=f.job_id FOR UPDATE;
 IF f.state NOT IN('queued','fetching') OR j.kind IS DISTINCT FROM 'supplier.file.fetch' OR j.payload->>'fetch_id' IS DISTINCT FROM f.id::text THEN RETURN;END IF;
 IF j.state='failed' OR(j.state='running' AND j.locked_at<clock_timestamp()-interval '5 minutes' AND j.attempts>=j.max_attempts) THEN
  UPDATE supplier_file_fetch_runs SET state='failed',phase='failed',error_code='LEASE_EXPIRED',finished_at=clock_timestamp() WHERE tenant_id=t AND id=fid;
  IF j.state='running' THEN UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error=NULL WHERE tenant_id=t AND id=j.id;END IF;
  UPDATE supplier_file_feed_schedules SET next_at=NULL,error_code='LEASE_EXPIRED',updated_at=now() WHERE tenant_id=t AND source_id=f.source_id AND version=f.schedule_version;
 END IF;
END$$;
CREATE FUNCTION supplier_remote_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN RAISE EXCEPTION 'Historia zdalnego feedu jest niezmienna' USING ERRCODE='23514';END$$;
CREATE FUNCTION supplier_remote_scope() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE data jsonb:=to_jsonb(NEW);t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;BEGIN
 IF t IS NULL OR(data->>'tenant_id')::uuid IS DISTINCT FROM t THEN RAISE EXCEPTION 'Niezgodny zakres zdalnego feedu' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='supplier_file_fetch_runs' THEN
   IF OLD.state NOT IN('queued','fetching') OR (data-ARRAY['state','phase','attempt','lease_token','started_at','finished_at','http_status','wire_bytes','decoded_bytes','wire_hash','raw_hash','preview_id','run_id','summary','error_code']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','phase','attempt','lease_token','started_at','finished_at','http_status','wire_bytes','decoded_bytes','wire_hash','raw_hash','preview_id','run_id','summary','error_code']) THEN RAISE EXCEPTION 'Wynik pobrania jest niezmienny' USING ERRCODE='23514';END IF;
  ELSIF TG_TABLE_NAME='supplier_file_remotes' THEN
   IF(NEW.id,NEW.tenant_id,NEW.source_id,NEW.created_at) IS DISTINCT FROM(OLD.id,OLD.tenant_id,OLD.source_id,OLD.created_at) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Nieprawidłowa rewizja remote' USING ERRCODE='23514';END IF;
  ELSIF TG_TABLE_NAME='supplier_file_feed_schedules' THEN
   IF(NEW.tenant_id,NEW.source_id,NEW.created_at) IS DISTINCT FROM(OLD.tenant_id,OLD.source_id,OLD.created_at) OR NEW.version NOT IN(OLD.version,OLD.version+1) OR(NEW.version=OLD.version AND(data-ARRAY['next_at','last_fetch_id','error_code','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['next_at','last_fetch_id','error_code','updated_at'])) THEN RAISE EXCEPTION 'Nieprawidłowa rewizja harmonogramu' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;
END$$;
CREATE FUNCTION supplier_remote_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE data jsonb:=to_jsonb(NEW);t uuid:=(data->>'tenant_id')::uuid;f supplier_file_fetch_runs%ROWTYPE;p supplier_file_previews%ROWTYPE;fr supplier_file_runs%ROWTYPE;BEGIN
 IF TG_TABLE_NAME='supplier_file_remotes' THEN
  IF NOT EXISTS(SELECT 1 FROM supplier_file_remote_revisions r WHERE(r.tenant_id,r.source_id,r.version,r.source_version,r.actor_id)=(t,NEW.source_id,NEW.version,NEW.source_version,NEW.actor_id) AND r.api_key_id IS NOT DISTINCT FROM NEW.api_key_id AND r.url_cipher=NEW.url_cipher AND r.auth_cipher IS NOT DISTINCT FROM NEW.auth_cipher AND r.payload->>'display_host'=NEW.display_host AND r.payload->>'auth_kind'=NEW.auth_kind AND r.payload->>'scope'=NEW.scope) THEN RAISE EXCEPTION 'Remote wymaga niezmiennej rewizji' USING ERRCODE='23514';END IF;
  PERFORM supplier_remote_require(NEW.actor_id,NEW.api_key_id,false);
 ELSIF TG_TABLE_NAME='supplier_file_feed_schedules' THEN
  IF NOT EXISTS(SELECT 1 FROM supplier_file_feed_schedule_revisions r WHERE(r.tenant_id,r.source_id,r.version,r.actor_id)=(t,NEW.source_id,NEW.version,NEW.actor_id) AND r.api_key_id IS NOT DISTINCT FROM NEW.api_key_id AND(r.payload->>'source_version')::integer=NEW.source_version AND(r.payload->>'remote_version')::integer=NEW.remote_version AND(r.payload->>'enabled')::boolean=NEW.enabled AND(r.payload->>'interval_minutes')::integer=NEW.interval_minutes AND r.payload->'publish'=NEW.publish) THEN RAISE EXCEPTION 'Harmonogram wymaga niezmiennej zgody' USING ERRCODE='23514';END IF;
  -- Operational suspension/reaping must remain possible after author revocation.
  IF TG_OP='INSERT' OR NEW.version<>OLD.version THEN PERFORM supplier_remote_require(NEW.actor_id,NEW.api_key_id,false);END IF;
 ELSIF TG_TABLE_NAME='supplier_file_remote_revisions' THEN
  IF NOT EXISTS(SELECT 1 FROM supplier_file_remotes r WHERE(r.tenant_id,r.source_id,r.version,r.source_version,r.actor_id)=(t,NEW.source_id,NEW.version,NEW.source_version,NEW.actor_id) AND r.api_key_id IS NOT DISTINCT FROM NEW.api_key_id AND r.url_cipher=NEW.url_cipher AND r.auth_cipher IS NOT DISTINCT FROM NEW.auth_cipher AND NEW.payload->>'display_host'=r.display_host AND NEW.payload->>'scope'=r.scope) OR NEW.top_xid<>pg_current_xact_id() OR NEW.transaction_started_at<>transaction_timestamp() THEN RAISE EXCEPTION 'Niepełna rewizja remote' USING ERRCODE='23514';END IF;
  PERFORM supplier_remote_require(NEW.actor_id,NEW.api_key_id,false);
 ELSIF TG_TABLE_NAME='supplier_file_feed_schedule_revisions' THEN
  IF NOT EXISTS(SELECT 1 FROM supplier_file_feed_schedules s WHERE(s.tenant_id,s.source_id,s.version,s.actor_id)=(t,NEW.source_id,NEW.version,NEW.actor_id) AND s.api_key_id IS NOT DISTINCT FROM NEW.api_key_id AND(s.source_version,s.remote_version,s.enabled,s.interval_minutes,s.publish)=((NEW.payload->>'source_version')::integer,(NEW.payload->>'remote_version')::integer,(NEW.payload->>'enabled')::boolean,(NEW.payload->>'interval_minutes')::integer,NEW.payload->'publish')) OR NEW.top_xid<>pg_current_xact_id() OR NEW.transaction_started_at<>transaction_timestamp() THEN RAISE EXCEPTION 'Niepełna zgoda harmonogramu' USING ERRCODE='23514';END IF;
  PERFORM supplier_remote_require(NEW.actor_id,NEW.api_key_id,false);
 ELSIF TG_TABLE_NAME='supplier_file_fetch_runs' THEN
  SELECT * INTO f FROM supplier_file_fetch_runs WHERE tenant_id=t AND id=NEW.id;
  IF f.state IN('success','awaiting-consent') THEN
   SELECT * INTO p FROM supplier_file_previews WHERE tenant_id=t AND id=f.preview_id;
   IF p.id IS NULL OR(p.source_id,p.source_version,p.actor_id,p.client_key,p.raw_hash,p.raw_bytes) IS DISTINCT FROM(f.source_id,f.source_version,f.actor_id,f.id,f.raw_hash,f.decoded_bytes) OR p.api_key_id IS DISTINCT FROM f.api_key_id OR f.summary IS DISTINCT FROM p.payload->'summary' OR f.http_status<>200 THEN RAISE EXCEPTION 'Niepełny trwały dowód pobrania' USING ERRCODE='23514';END IF;
   IF f.run_id IS NOT NULL THEN SELECT * INTO fr FROM supplier_file_runs WHERE tenant_id=t AND id=f.run_id;
    IF fr.preview_id IS DISTINCT FROM p.id OR fr.actor_id IS DISTINCT FROM f.actor_id OR fr.api_key_id IS DISTINCT FROM f.api_key_id OR fr.client_key IS DISTINCT FROM f.id OR f.schedule_version IS NULL THEN RAISE EXCEPTION 'Niepełny trwały dowód publikacji' USING ERRCODE='23514';END IF;
   END IF;
   PERFORM supplier_remote_require(f.actor_id,f.api_key_id,false);
  ELSIF f.state IN('queued','fetching') THEN PERFORM supplier_remote_require(f.actor_id,f.api_key_id,false);END IF;
 END IF;
 PERFORM supplier_remote_quota(t);RETURN NEW;
END$$;
DO $$DECLARE tbl text;BEGIN
 FOREACH tbl IN ARRAY ARRAY['supplier_file_remotes','supplier_file_remote_revisions','supplier_file_feed_schedules','supplier_file_feed_schedule_revisions','supplier_file_fetch_runs'] LOOP
  EXECUTE format('CREATE TRIGGER supplier_remote_scope BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION supplier_remote_scope()',tbl);
  EXECUTE format('CREATE TRIGGER supplier_remote_no_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION supplier_remote_immutable()',tbl);
 END LOOP;
 FOREACH tbl IN ARRAY ARRAY['supplier_file_remote_revisions','supplier_file_feed_schedule_revisions'] LOOP
  EXECUTE format('CREATE TRIGGER supplier_remote_immutable BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION supplier_remote_immutable()',tbl);
 END LOOP;
 FOREACH tbl IN ARRAY ARRAY['supplier_file_remotes','supplier_file_feed_schedules','supplier_file_remote_revisions','supplier_file_feed_schedule_revisions','supplier_file_fetch_runs'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER supplier_remote_complete AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_remote_complete()',tbl);
 END LOOP;
END$$;
REVOKE ALL ON FUNCTION supplier_remote_installed(),supplier_remote_access(uuid,uuid,boolean,boolean),supplier_remote_require(uuid,uuid,boolean),supplier_remote_lock(uuid),supplier_remote_quota(uuid),supplier_remote_policy_valid(jsonb),supplier_remote_cancel(uuid,text),supplier_remote_save_remote(uuid,jsonb,uuid,uuid),supplier_remote_save_schedule(uuid,jsonb,uuid,uuid),supplier_remote_queue(uuid,jsonb,uuid,uuid),supplier_remote_start(uuid,uuid,uuid),supplier_remote_finish(uuid,uuid,uuid,jsonb),supplier_remote_defer(uuid,text),supplier_remote_immutable(),supplier_remote_scope(),supplier_remote_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_remote_sweep(uuid),supplier_remote_retry(uuid,uuid,uuid,text,integer),supplier_remote_reap(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_remote_replay_remote(uuid,uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION supplier_remote_replay_remote(uuid,uuid,text,uuid,uuid) TO dyna_app;
GRANT EXECUTE ON FUNCTION supplier_remote_installed(),supplier_remote_access(uuid,uuid,boolean,boolean),supplier_remote_save_remote(uuid,jsonb,uuid,uuid),supplier_remote_save_schedule(uuid,jsonb,uuid,uuid),supplier_remote_queue(uuid,jsonb,uuid,uuid),supplier_remote_start(uuid,uuid,uuid),supplier_remote_finish(uuid,uuid,uuid,jsonb),supplier_remote_sweep(uuid),supplier_remote_retry(uuid,uuid,uuid,text,integer),supplier_remote_reap(uuid) TO dyna_app;
