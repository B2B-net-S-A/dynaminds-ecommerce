-- Local print custody. file_saved/spool_submitted never assert physical printing.
CREATE TABLE print_printers (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), station_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), format text NOT NULL CHECK(format IN('pdf','zpl')),
 output_mode text NOT NULL CHECK(output_mode IN('file','cups')), cups_queue text,
 enabled boolean NOT NULL, version bigint NOT NULL CHECK(version>0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,station_id) REFERENCES packing_stations(tenant_id,id),
 CHECK((output_mode='cups' AND cups_queue ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$') OR (output_mode='file' AND cups_queue IS NULL))
);
CREATE TABLE print_jobs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), order_id uuid NOT NULL, station_id uuid NOT NULL, printer_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), api_key_id uuid, client_key uuid NOT NULL, request_hash text NOT NULL,
 order_snapshot jsonb NOT NULL, station_snapshot jsonb NOT NULL, printer_snapshot jsonb NOT NULL,
 source_kind text NOT NULL CHECK(source_kind='manual'), format text NOT NULL CHECK(format IN('pdf','zpl')), copies integer NOT NULL CHECK(copies BETWEEN 1 AND 10),
 content_base64 text NOT NULL, content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'), content_bytes integer NOT NULL CHECK(content_bytes BETWEEN 1 AND 2097152),
 retry_of_job_id uuid, version bigint NOT NULL DEFAULT 1 CHECK(version>0), state text NOT NULL CHECK(state IN('queued','claimed','file_saved','spool_submitted','failed','unknown','cancelled')),
 lease_hash text, claim_actor_id uuid REFERENCES users(id), claim_api_key_id uuid, lease_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id), FOREIGN KEY(tenant_id,station_id) REFERENCES packing_stations(tenant_id,id),
 FOREIGN KEY(tenant_id,printer_id) REFERENCES print_printers(tenant_id,id), FOREIGN KEY(tenant_id,retry_of_job_id) REFERENCES print_jobs(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id), FOREIGN KEY(tenant_id,claim_api_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK((state='queued' AND lease_hash IS NULL AND claim_actor_id IS NULL AND claim_api_key_id IS NULL AND lease_expires_at IS NULL) OR state='cancelled' OR (state IN('claimed','file_saved','spool_submitted','failed','unknown') AND lease_hash IS NOT NULL AND claim_actor_id IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE TABLE print_job_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), job_id uuid, printer_id uuid,
 actor_id uuid NOT NULL REFERENCES users(id), api_key_id uuid, client_key uuid NOT NULL, request_hash text NOT NULL,
 operation text NOT NULL CHECK(operation IN('printer_create','printer_update','job_create','claim','ack','reconcile')),
 version_before bigint, version_after bigint NOT NULL, before_head jsonb, result jsonb NOT NULL,
 top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(), transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,job_id) REFERENCES print_jobs(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,printer_id) REFERENCES print_printers(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK((job_id IS NOT NULL AND printer_id IS NULL AND operation IN('job_create','claim','ack','reconcile')) OR (job_id IS NULL AND printer_id IS NOT NULL AND operation IN('printer_create','printer_update'))),
 CHECK((version_before IS NULL AND version_after=1 AND operation IN('printer_create','job_create')) OR (version_before>0 AND version_after=version_before+1 AND operation NOT IN('printer_create','job_create')))
);
CREATE INDEX print_jobs_page ON print_jobs(tenant_id,created_at DESC,id DESC);
CREATE INDEX print_jobs_printer_page ON print_jobs(tenant_id,printer_id,state,created_at DESC,id DESC);
CREATE INDEX print_job_events_job ON print_job_events(tenant_id,job_id,version_after);
CREATE INDEX print_job_events_printer ON print_job_events(tenant_id,printer_id,version_after);
CREATE UNIQUE INDEX print_job_events_job_version ON print_job_events(tenant_id,job_id,version_after) WHERE job_id IS NOT NULL;
CREATE UNIQUE INDEX print_job_events_printer_version ON print_job_events(tenant_id,printer_id,version_after) WHERE printer_id IS NOT NULL;
DO $$ DECLARE rel text; BEGIN
 FOREACH rel IN ARRAY ARRAY['print_printers','print_jobs','print_job_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',rel); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',rel);
  EXECUTE format('CREATE POLICY print_job_tenant ON %I TO dyna_app USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',rel);
  EXECUTE format('CREATE POLICY print_job_owner ON %I TO %I USING (true) WITH CHECK (true)',rel,current_user);
 END LOOP;
END $$;
REVOKE ALL ON print_printers,print_jobs,print_job_events FROM PUBLIC,dyna_app;
GRANT SELECT ON print_printers TO dyna_app;
GRANT SELECT(id,tenant_id,order_id,station_id,printer_id,order_snapshot,station_snapshot,printer_snapshot,source_kind,format,copies,content_sha256,content_bytes,retry_of_job_id,version,state,lease_expires_at,created_at,updated_at) ON print_jobs TO dyna_app;
GRANT SELECT(id,tenant_id,job_id,printer_id,operation,version_before,version_after,result,created_at) ON print_job_events TO dyna_app;

CREATE FUNCTION print_job_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM migrations WHERE name='129_print_jobs') $$;
CREATE FUNCTION print_job_access(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; r text; k api_keys; valid boolean:=true; scoped boolean:=true;
BEGIN
 IF pin THEN SELECT role INTO r FROM memberships WHERE tenant_id=t AND user_id=uid FOR SHARE; ELSE SELECT role INTO r FROM memberships WHERE tenant_id=t AND user_id=uid; END IF;
 IF kid IS NOT NULL THEN
  IF pin THEN SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid FOR SHARE; ELSE SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid; END IF;
  valid:=k.id IS NOT NULL AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp());
  scoped:=valid AND 'orders:read'=ANY(k.scopes) AND (NOT writing OR 'orders:write'=ANY(k.scopes));
 END IF;
 RETURN jsonb_build_object('role',r,'key_valid',valid,'allowed',r IN('admin','operator','viewer') AND scoped AND (NOT writing OR r IN('admin','operator')),'can_write',r IN('admin','operator') AND scoped);
END $$;
CREATE FUNCTION print_job_require(uid uuid,kid uuid,writing boolean,pin boolean,admin_only boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g jsonb; BEGIN
 IF print_job_guards() IS NOT TRUE THEN RAISE EXCEPTION 'Moduł drukowania jest niekompletny' USING ERRCODE='55000'; END IF;
 g:=print_job_access(uid,kid,writing,pin);
 IF (g->>'key_valid')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'Klucz drukowania jest nieaktualny' USING ERRCODE='23514'; END IF;
 IF (g->>'allowed')::boolean IS NOT TRUE OR (admin_only AND g->>'role' IS DISTINCT FROM 'admin') THEN RAISE EXCEPTION 'Brak aktualnego uprawnienia do drukowania' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION print_job_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$ SELECT encode(sha256(convert_to(v::text,'UTF8')),'hex') $$;
CREATE FUNCTION print_job_head(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',v->'id','order_id',v->'order_id','order_number',v->'order_snapshot'->'number','station_id',v->'station_id','printer_id',v->'printer_id','order_snapshot',v->'order_snapshot','station_snapshot',v->'station_snapshot','printer_snapshot',v->'printer_snapshot','source_kind',v->'source_kind','format',v->'format','copies',v->'copies','content_sha256',v->'content_sha256','content_bytes',v->'content_bytes','retry_of_job_id',v->'retry_of_job_id','version',v->>'version','state',v->'state','lease_expires_at',v->'lease_expires_at','created_at',v->'created_at','updated_at',v->'updated_at')
$$;
CREATE FUNCTION print_job_printer_head(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$ SELECT (v-'tenant_id')||jsonb_build_object('version',v->>'version') $$;
CREATE FUNCTION print_job_lock() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT pg_advisory_xact_lock(hashtextextended('print.jobs:'||current_setting('app.tenant_id',true),0)) $$;
CREATE FUNCTION print_job_budget() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; BEGIN
 IF (SELECT count(*) FROM print_printers WHERE tenant_id=t)>100 OR (SELECT count(*) FROM print_jobs WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM print_job_events WHERE tenant_id=t)>10000 OR
  coalesce((SELECT sum(octet_length(content_base64)+octet_length(order_snapshot::text)+octet_length(station_snapshot::text)+octet_length(printer_snapshot::text)+512) FROM print_jobs WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(result::text)+octet_length(coalesce(before_head::text,''))+512) FROM print_job_events WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(to_jsonb(p)::text)) FROM print_printers p WHERE tenant_id=t),0)>67108864 THEN RAISE EXCEPTION 'Limit historii drukowania' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION print_job_content_valid(b64 text,fmt text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE b bytea; s text; cmd text; allowed text[]:=ARRAY['XA','XZ','FO','FT','FD','FS','A0','CF','CI','PW','LL','LH','LT','LS','FW','FB','FR','FX','BY','BC','B3','BQ','BE','GB','GF']; n integer:=0; gf integer:=0; g text[];
BEGIN
 IF b64 IS NULL OR b64 !~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' THEN RETURN false; END IF;
 b:=decode(b64,'base64'); IF octet_length(b) NOT BETWEEN 1 AND 2097152 OR replace(encode(b,'base64'),E'\n','')<>b64 THEN RETURN false; END IF;
 IF fmt='pdf' THEN
  -- ASCII marker search on bytes; arbitrary binary PDF streams remain uninterpreted.
  s:=encode(b,'escape');
  RETURN s ~ '^%PDF-1\.[0-9]' AND s ~ '%%EOF[\r\n\t ]*$' AND s !~* '/(JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile)\M' AND s !~* '#[0-9a-f]{2}';
 ELSIF fmt='zpl' THEN
  s:=convert_from(b,'UTF8'); IF s ~ '[^\x09\x0a\x0d\x20-\x7e]' OR position('~' IN s)>0 OR s !~ '^\s*\^XA' OR s !~ '\^XZ\s*$' OR (length(s)-length(replace(s,'^XA','')))<>3 OR (length(s)-length(replace(s,'^XZ','')))<>3 OR s ~ '\^GF(?!A,)' THEN RETURN false; END IF;
  FOR cmd IN SELECT x[1] FROM regexp_matches(s,'\^([A-Za-z0-9]{2})','g') x LOOP IF NOT cmd=ANY(allowed) THEN RETURN false; END IF; n:=n+1; END LOOP;
  FOR g IN SELECT x FROM regexp_matches(s,'\^GFA,([0-9]{1,7}),([0-9]{1,7}),([0-9]{1,4}),([A-Fa-f0-9]+)(?=\^|$)','g') x LOOP
   IF g[1]::integer<>g[2]::integer OR g[2]::integer NOT BETWEEN 1 AND 1048576 OR g[3]::integer NOT BETWEEN 1 AND 4096 OR g[2]::integer%g[3]::integer<>0 OR length(g[4])<>g[2]::integer*2 THEN RETURN false; END IF; gf:=gf+1;
  END LOOP;
  IF gf<>(length(s)-length(replace(s,'^GF','')))/3 THEN RETURN false; END IF;
  RETURN n=length(s)-length(replace(s,'^',''));
 END IF; RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;

CREATE FUNCTION print_job_replay(ck uuid,rh text,uid uuid,kid uuid,op text,entity uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e print_job_events; BEGIN
 SELECT * INTO e FROM print_job_events WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND client_key=ck;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF e.request_hash IS DISTINCT FROM rh OR e.actor_id IS DISTINCT FROM uid OR e.api_key_id IS DISTINCT FROM kid OR e.operation IS DISTINCT FROM op OR coalesce(e.job_id,e.printer_id) IS DISTINCT FROM entity THEN RAISE EXCEPTION 'Klucz polecenia drukowania ma inną treść' USING ERRCODE='23514'; END IF;
 RETURN e.result||jsonb_build_object('event',jsonb_build_object('id',e.id,'operation',e.operation,'version_before',e.version_before::text,'version_after',e.version_after::text,'result',e.result,'created_at',e.created_at),'reused',true);
END $$;
CREATE FUNCTION print_job_event(eid uuid,jid uuid,pid uuid,uid uuid,kid uuid,ck uuid,rh text,op text,beforeh jsonb,afterh jsonb,meta jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v jsonb; ts timestamptz:=clock_timestamp(); BEGIN
 v:=jsonb_build_object(CASE WHEN jid IS NULL THEN 'printer' ELSE 'job' END,afterh)||jsonb_build_object('receipt',meta);
 INSERT INTO print_job_events(id,tenant_id,job_id,printer_id,actor_id,api_key_id,client_key,request_hash,operation,version_before,version_after,before_head,result,created_at)
 VALUES(eid,nullif(current_setting('app.tenant_id',true),'')::uuid,jid,pid,uid,kid,ck,rh,op,(beforeh->>'version')::bigint,(afterh->>'version')::bigint,beforeh,v,ts);
 RETURN v||jsonb_build_object('event',jsonb_build_object('id',eid,'operation',op,'version_before',beforeh->>'version','version_after',afterh->>'version','result',v,'created_at',ts),'reused',false);
END $$;
CREATE FUNCTION print_job_printer_write(v jsonb,uid uuid,kid uuid,pid uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; p print_printers; st packing_stations; beforeh jsonb; afterh jsonb; rh text; old jsonb; outv jsonb; op text:=CASE WHEN pid IS NULL THEN 'printer_create' ELSE 'printer_update' END; nid uuid; ts timestamptz:=clock_timestamp();
BEGIN
 PERFORM print_job_lock(); PERFORM print_job_require(uid,kid,true,false,true);
 IF jsonb_typeof(v)<>'object' OR (v-ARRAY['client_key','version','station_id','station_version','name','format','output_mode','cups_queue','enabled'])<>'{}'::jsonb OR v->>'name' IS NULL OR length(btrim(v->>'name')) NOT BETWEEN 1 AND 120 OR v->>'name' ~ '[[:cntrl:]]' OR v->>'format' NOT IN('pdf','zpl') OR v->>'output_mode' NOT IN('file','cups') OR jsonb_typeof(v->'enabled') IS DISTINCT FROM 'boolean' OR (v->>'station_version') !~ '^[1-9][0-9]*$' OR ((v->>'output_mode'='cups' AND (v->>'cups_queue') ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$') OR (v->>'output_mode'='file' AND v->'cups_queue'='null'::jsonb)) IS NOT TRUE THEN RAISE EXCEPTION 'Niepoprawna konfiguracja drukarki' USING ERRCODE='23514'; END IF;
 rh:=print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'operation',op,'id',pid,'request',v));
 SELECT coalesce(e.printer_id,pid) INTO nid FROM print_job_events e WHERE e.tenant_id=t AND e.client_key=(v->>'client_key')::uuid; nid:=coalesce(nid,pid,gen_random_uuid());
 old:=print_job_replay((v->>'client_key')::uuid,rh,uid,kid,op,nid); IF old IS NOT NULL THEN RETURN old; END IF;
 SELECT * INTO st FROM packing_stations WHERE tenant_id=t AND id=(v->>'station_id')::uuid FOR UPDATE;
 IF st.id IS NULL OR NOT st.enabled OR st.version::text IS DISTINCT FROM v->>'station_version' THEN RAISE EXCEPTION 'Stanowisko drukowania zmieniło się' USING ERRCODE='23514'; END IF;
 IF pid IS NOT NULL THEN SELECT * INTO p FROM print_printers WHERE tenant_id=t AND id=pid FOR UPDATE; IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono drukarki' USING ERRCODE='P0002'; END IF; IF p.version::text IS DISTINCT FROM v->>'version' THEN RAISE EXCEPTION 'Drukarka zmieniła się' USING ERRCODE='23514'; END IF; beforeh:=print_job_printer_head(to_jsonb(p)); ELSE p.id:=nid; p.tenant_id:=t; p.version:=0; p.created_at:=ts; END IF;
 p.station_id:=st.id; p.name:=btrim(v->>'name'); p.format:=v->>'format'; p.output_mode:=v->>'output_mode'; p.cups_queue:=v->>'cups_queue'; p.enabled:=(v->>'enabled')::boolean; p.version:=p.version+1; p.updated_at:=ts;
 afterh:=print_job_printer_head(to_jsonb(p)); outv:=print_job_event(gen_random_uuid(),NULL,p.id,uid,kid,(v->>'client_key')::uuid,rh,op,beforeh,afterh);
 IF pid IS NULL THEN INSERT INTO print_printers SELECT p.*; ELSE UPDATE print_printers SET station_id=p.station_id,name=p.name,format=p.format,output_mode=p.output_mode,cups_queue=p.cups_queue,enabled=p.enabled,version=p.version,updated_at=p.updated_at WHERE tenant_id=t AND id=p.id; END IF;
 PERFORM print_job_budget(); PERFORM print_job_require(uid,kid,true,false,true); RETURN outv;
END $$;
CREATE FUNCTION print_job_create(v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; o orders; st packing_stations; p print_printers; j print_jobs; prior print_jobs; rh text; old jsonb; nid uuid; ts timestamptz:=clock_timestamp(); outv jsonb; b bytea;
BEGIN
 PERFORM print_job_lock(); PERFORM print_job_require(uid,kid,true,false);
 IF jsonb_typeof(v)<>'object' OR (v-ARRAY['client_key','order_id','order_version','station_id','station_version','printer_id','printer_version','source_kind','format','content_base64','copies','confirmed','retry_of_job_id','reprint_confirmed'])<>'{}'::jsonb OR v->>'source_kind' IS DISTINCT FROM 'manual' OR v->'confirmed' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(v->'copies') IS DISTINCT FROM 'number' OR (v->>'copies') !~ '^[0-9]+$' OR (v->>'copies')::integer NOT BETWEEN 1 AND 10 OR print_job_content_valid(v->>'content_base64',v->>'format') IS NOT TRUE OR ((v?'retry_of_job_id')<>(v?'reprint_confirmed')) OR (v?'reprint_confirmed' AND v->'reprint_confirmed' IS DISTINCT FROM 'true'::jsonb) THEN RAISE EXCEPTION 'Niepoprawna bezpieczna treść drukowania' USING ERRCODE='23514'; END IF;
 rh:=print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'operation','job_create','request',v));
 SELECT e.job_id INTO nid FROM print_job_events e WHERE e.tenant_id=t AND e.client_key=(v->>'client_key')::uuid; nid:=coalesce(nid,gen_random_uuid());
 old:=print_job_replay((v->>'client_key')::uuid,rh,uid,kid,'job_create',nid); IF old IS NOT NULL THEN RETURN old; END IF;
 SELECT * INTO o FROM orders WHERE tenant_id=t AND id=(v->>'order_id')::uuid FOR UPDATE;
 IF o.id IS NULL OR o.version::text IS DISTINCT FROM v->>'order_version' THEN RAISE EXCEPTION 'Zamówienie zmieniło się' USING ERRCODE='23514'; END IF;
 SELECT * INTO st FROM packing_stations WHERE tenant_id=t AND id=(v->>'station_id')::uuid FOR UPDATE;
 SELECT * INTO p FROM print_printers WHERE tenant_id=t AND id=(v->>'printer_id')::uuid FOR UPDATE;
 IF st.id IS NULL OR p.id IS NULL OR NOT st.enabled OR NOT p.enabled OR st.version::text IS DISTINCT FROM v->>'station_version' OR p.version::text IS DISTINCT FROM v->>'printer_version' OR p.station_id IS DISTINCT FROM st.id OR p.format IS DISTINCT FROM v->>'format' THEN RAISE EXCEPTION 'Konfiguracja drukowania zmieniła się' USING ERRCODE='23514'; END IF;
 b:=decode(v->>'content_base64','base64');
 IF v?'retry_of_job_id' THEN
  SELECT * INTO prior FROM print_jobs WHERE tenant_id=t AND id=(v->>'retry_of_job_id')::uuid FOR UPDATE;
  IF prior.id IS NULL OR prior.state IN('queued','claimed') OR prior.order_id IS DISTINCT FROM o.id OR prior.format IS DISTINCT FROM p.format OR prior.content_base64 IS DISTINCT FROM v->>'content_base64' THEN RAISE EXCEPTION 'Ponowne drukowanie wymaga zakończonego oryginału i tych samych bajtów' USING ERRCODE='23514'; END IF;
 END IF;
 j.id:=nid; j.tenant_id:=t; j.order_id:=o.id; j.station_id:=st.id; j.printer_id:=p.id; j.actor_id:=uid; j.api_key_id:=kid; j.client_key:=(v->>'client_key')::uuid; j.request_hash:=rh;
 j.order_snapshot:=jsonb_build_object('id',o.id,'number',o.number,'version',o.version::text,'status',o.status,'warehouse_id',o.warehouse_id);
 j.station_snapshot:=jsonb_build_object('id',st.id,'code',st.code,'label',st.label,'version',st.version::text,'enabled',st.enabled); j.printer_snapshot:=print_job_printer_head(to_jsonb(p));
 j.source_kind:='manual'; j.format:=p.format; j.copies:=(v->>'copies')::integer; j.content_base64:=v->>'content_base64'; j.content_sha256:=encode(sha256(b),'hex'); j.content_bytes:=octet_length(b); j.retry_of_job_id:=prior.id; j.version:=1; j.state:='queued'; j.created_at:=ts; j.updated_at:=ts;
 outv:=print_job_event(gen_random_uuid(),j.id,NULL,uid,kid,j.client_key,rh,'job_create',NULL,print_job_head(to_jsonb(j)));
 INSERT INTO print_jobs SELECT j.*; PERFORM print_job_budget(); PERFORM print_job_require(uid,kid,true,false); RETURN outv;
END $$;
CREATE FUNCTION print_job_command(jid uuid,v jsonb,uid uuid,kid uuid,op text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; j print_jobs; p print_printers; st packing_stations; oid uuid; rh text; old jsonb; beforeh jsonb; outv jsonb; ts timestamptz:=clock_timestamp();
BEGIN
 IF op NOT IN('claim','ack','reconcile') THEN RAISE EXCEPTION 'Niepoprawne polecenie drukowania' USING ERRCODE='23514'; END IF;
 PERFORM print_job_lock(); PERFORM print_job_require(uid,kid,true,false,op='reconcile');
 rh:=print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'operation',op,'id',jid,'request',v));
 old:=print_job_replay((v->>'client_key')::uuid,rh,uid,kid,op,jid); IF old IS NOT NULL THEN RETURN old; END IF;
 SELECT order_id INTO oid FROM print_jobs WHERE tenant_id=t AND id=jid;
 IF oid IS NULL THEN RAISE EXCEPTION 'Nie znaleziono zadania drukowania' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM orders WHERE tenant_id=t AND id=oid FOR UPDATE;
 SELECT * INTO j FROM print_jobs WHERE tenant_id=t AND id=jid;
 SELECT * INTO st FROM packing_stations WHERE tenant_id=t AND id=j.station_id FOR UPDATE;
 SELECT * INTO p FROM print_printers WHERE tenant_id=t AND id=j.printer_id FOR UPDATE;
 SELECT * INTO j FROM print_jobs WHERE tenant_id=t AND id=jid FOR UPDATE;
 IF j.version::text IS DISTINCT FROM v->>'version' THEN RAISE EXCEPTION 'Zadanie drukowania zmieniło się' USING ERRCODE='23514'; END IF;
 beforeh:=print_job_head(to_jsonb(j));
 IF op='claim' THEN
  IF (v-ARRAY['client_key','version','lease_token'])<>'{}'::jsonb OR j.state<>'queued' OR NOT p.enabled OR NOT st.enabled OR print_job_printer_head(to_jsonb(p)) IS DISTINCT FROM j.printer_snapshot OR jsonb_build_object('id',st.id,'code',st.code,'label',st.label,'version',st.version::text,'enabled',st.enabled) IS DISTINCT FROM j.station_snapshot THEN RAISE EXCEPTION 'Zadanie nie może zostać przejęte w tej konfiguracji' USING ERRCODE='23514'; END IF;
  j.lease_hash:=print_job_hash(to_jsonb((v->>'lease_token')::uuid)); j.claim_actor_id:=uid; j.claim_api_key_id:=kid; j.lease_expires_at:=clock_timestamp()+interval '90 seconds'; j.state:='claimed';
 ELSIF op='ack' THEN
  IF (v-ARRAY['client_key','version','lease_token','result','content_sha256','artifact_name','spool_job_id','error_code'])<>'{}'::jsonb OR j.state<>'claimed' OR j.claim_actor_id IS DISTINCT FROM uid OR j.claim_api_key_id IS DISTINCT FROM kid OR j.lease_hash IS DISTINCT FROM print_job_hash(to_jsonb((v->>'lease_token')::uuid)) OR j.lease_expires_at<=clock_timestamp() OR j.content_sha256 IS DISTINCT FROM v->>'content_sha256' THEN RAISE EXCEPTION 'Brak aktywnego własnego lease drukowania' USING ERRCODE='23514'; END IF;
  IF ((v->>'result'='file_saved' AND j.printer_snapshot->>'output_mode'='file' AND (v->>'artifact_name') ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$' AND NOT(v?'spool_job_id') AND NOT(v?'error_code')) OR (v->>'result'='spool_submitted' AND j.printer_snapshot->>'output_mode'='cups' AND (v->>'spool_job_id') ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$' AND NOT(v?'artifact_name') AND NOT(v?'error_code')) OR (v->>'result' IN('failed','unknown') AND v->>'error_code' IN('OUTPUT_FAILED','INTERRUPTED','UNCONFIRMED') AND NOT(v?'artifact_name') AND NOT(v?'spool_job_id'))) IS NOT TRUE THEN RAISE EXCEPTION 'Niepoprawne potwierdzenie drukowania' USING ERRCODE='23514'; END IF;
  -- ACK binds the frozen sink, not a later printer configuration.
  IF v->>'result'='file_saved' AND j.printer_snapshot->>'output_mode'<>'file' OR v->>'result'='spool_submitted' AND j.printer_snapshot->>'output_mode'<>'cups' THEN RAISE EXCEPTION 'Wynik nie odpowiada zamrożonemu wyjściu' USING ERRCODE='23514'; END IF;
  j.state:=v->>'result';
 ELSE
  IF (v-ARRAY['client_key','version','result','confirmed','note'])<>'{}'::jsonb OR v->'confirmed' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(v->'note') IS DISTINCT FROM 'string' OR length(v->>'note') NOT BETWEEN 3 AND 500 OR v->>'note' ~ '[[:cntrl:]]' OR ((j.state='queued' AND v->>'result'='cancelled') OR (j.state='claimed' AND j.lease_expires_at<=clock_timestamp() AND v->>'result' IN('unknown','cancelled'))) IS NOT TRUE THEN RAISE EXCEPTION 'Ręczne rozstrzygnięcie wymaga wygasłego lease lub anulowania kolejki' USING ERRCODE='23514'; END IF;
  j.state:=v->>'result';
 END IF;
 j.version:=j.version+1; j.updated_at:=clock_timestamp();
 outv:=print_job_event(gen_random_uuid(),j.id,NULL,uid,kid,(v->>'client_key')::uuid,rh,op,beforeh,print_job_head(to_jsonb(j)),v-ARRAY['client_key','version','lease_token']);
 UPDATE print_jobs SET state=j.state,version=j.version,lease_hash=j.lease_hash,claim_actor_id=j.claim_actor_id,claim_api_key_id=j.claim_api_key_id,lease_expires_at=j.lease_expires_at,updated_at=j.updated_at WHERE tenant_id=t AND id=j.id;
 PERFORM print_job_budget(); PERFORM print_job_require(uid,kid,true,false,op='reconcile'); RETURN outv;
END $$;
CREATE FUNCTION print_job_content(jid uuid,token uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j print_jobs; BEGIN
 PERFORM print_job_require(uid,kid,true,false);
 SELECT * INTO j FROM print_jobs WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND id=jid;
 IF j.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono zadania drukowania' USING ERRCODE='P0002'; END IF;
 IF j.state<>'claimed' OR j.claim_actor_id IS DISTINCT FROM uid OR j.claim_api_key_id IS DISTINCT FROM kid OR j.lease_hash IS DISTINCT FROM print_job_hash(to_jsonb(token)) OR j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Brak aktywnego własnego lease drukowania' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('job_id',j.id,'version',j.version::text,'format',j.format,'copies',j.copies,'content_base64',j.content_base64,'content_sha256',j.content_sha256,'content_bytes',j.content_bytes,'printer_snapshot',j.printer_snapshot,'lease_expires_at',j.lease_expires_at);
END $$;
CREATE FUNCTION print_job_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'Potwierdzenia drukowania są niezmienne' USING ERRCODE='23514'; END $$;
CREATE FUNCTION print_job_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e print_job_events; bh jsonb; ah jsonb; jid uuid; pid uuid; t uuid; BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Historia drukowania jest niezmienna' USING ERRCODE='23514'; END IF;
 t:=NEW.tenant_id;
 IF TG_TABLE_NAME='print_jobs' THEN jid:=NEW.id; ah:=print_job_head(to_jsonb(NEW)); IF TG_OP='UPDATE' THEN bh:=print_job_head(to_jsonb(OLD)); END IF;
 ELSE pid:=NEW.id; ah:=print_job_printer_head(to_jsonb(NEW)); IF TG_OP='UPDATE' THEN bh:=print_job_printer_head(to_jsonb(OLD)); END IF; END IF;
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR (TG_OP='UPDATE' AND (OLD.id IS DISTINCT FROM NEW.id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR NEW.version<>OLD.version+1)) THEN RAISE EXCEPTION 'Niepoprawny kontekst drukowania' USING ERRCODE='23514'; END IF;
 SELECT * INTO e FROM print_job_events WHERE tenant_id=t AND job_id IS NOT DISTINCT FROM jid AND printer_id IS NOT DISTINCT FROM pid AND version_after=NEW.version AND top_xid=pg_current_xact_id() AND transaction_started_at=transaction_timestamp();
 IF e.id IS NULL OR e.before_head IS DISTINCT FROM bh OR e.result->(CASE WHEN jid IS NULL THEN 'printer' ELSE 'job' END) IS DISTINCT FROM ah THEN RAISE EXCEPTION 'Zmiana drukowania wymaga rzeczywistego polecenia' USING ERRCODE='23514'; END IF;
 IF jid IS NOT NULL THEN
  IF TG_OP='INSERT' THEN
   IF e.operation<>'job_create' OR NEW.state<>'queued' OR NEW.actor_id IS DISTINCT FROM e.actor_id OR NEW.api_key_id IS DISTINCT FROM e.api_key_id OR NEW.request_hash IS DISTINCT FROM e.request_hash OR NEW.client_key IS DISTINCT FROM e.client_key OR print_job_content_valid(NEW.content_base64,NEW.format) IS NOT TRUE OR NEW.content_bytes IS DISTINCT FROM octet_length(decode(NEW.content_base64,'base64')) OR NEW.content_sha256 IS DISTINCT FROM encode(sha256(decode(NEW.content_base64,'base64')),'hex') THEN RAISE EXCEPTION 'Niepoprawne źródło zadania drukowania' USING ERRCODE='23514'; END IF;
  ELSE
   IF (to_jsonb(OLD)-ARRAY['version','state','lease_hash','claim_actor_id','claim_api_key_id','lease_expires_at','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['version','state','lease_hash','claim_actor_id','claim_api_key_id','lease_expires_at','updated_at']) THEN RAISE EXCEPTION 'Bajty i pochodzenie zadania są niezmienne' USING ERRCODE='23514'; END IF;
   IF e.operation='claim' THEN
    IF OLD.state<>'queued' OR NEW.state<>'claimed' OR NEW.claim_actor_id IS DISTINCT FROM e.actor_id OR NEW.claim_api_key_id IS DISTINCT FROM e.api_key_id OR NEW.lease_hash IS NULL OR NEW.lease_expires_at NOT BETWEEN clock_timestamp() AND clock_timestamp()+interval '91 seconds' THEN RAISE EXCEPTION 'Niepoprawne przejęcie drukowania' USING ERRCODE='23514'; END IF;
   ELSIF e.operation='ack' THEN
    IF OLD.state<>'claimed' OR NEW.state NOT IN('file_saved','spool_submitted','failed','unknown') OR OLD.claim_actor_id IS DISTINCT FROM e.actor_id OR OLD.claim_api_key_id IS DISTINCT FROM e.api_key_id OR OLD.lease_expires_at<=clock_timestamp() OR (to_jsonb(OLD)-ARRAY['version','state','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['version','state','updated_at']) THEN RAISE EXCEPTION 'Niepoprawny wynik drukowania' USING ERRCODE='23514'; END IF;
   ELSIF e.operation='reconcile' THEN
    IF NOT((OLD.state='queued' AND NEW.state='cancelled') OR (OLD.state='claimed' AND OLD.lease_expires_at<=clock_timestamp() AND NEW.state IN('unknown','cancelled'))) OR (to_jsonb(OLD)-ARRAY['version','state','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['version','state','updated_at']) THEN RAISE EXCEPTION 'Niepoprawne rozstrzygnięcie drukowania' USING ERRCODE='23514'; END IF;
   ELSE RAISE EXCEPTION 'Niepoprawna operacja drukowania' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  IF TG_OP='INSERT' AND e.operation<>'printer_create' OR TG_OP='UPDATE' AND (e.operation<>'printer_update' OR OLD.created_at IS DISTINCT FROM NEW.created_at) THEN RAISE EXCEPTION 'Niepoprawna konfiguracja drukarki' USING ERRCODE='23514'; END IF;
 END IF;
 PERFORM print_job_require(e.actor_id,e.api_key_id,true,false,pid IS NOT NULL OR e.operation='reconcile'); RETURN NEW;
END $$;
CREATE FUNCTION print_job_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE h jsonb; nextbefore jsonb; BEGIN
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR NEW.top_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.transaction_started_at IS DISTINCT FROM transaction_timestamp() THEN RAISE EXCEPTION 'Potwierdzenie wymaga bieżącej transakcji' USING ERRCODE='23514'; END IF;
 IF NEW.operation='ack' AND ((NEW.before_head->>'lease_expires_at')::timestamptz>clock_timestamp()) IS NOT TRUE THEN RAISE EXCEPTION 'Brak aktywnego własnego lease drukowania' USING ERRCODE='23514'; END IF;
 IF NEW.job_id IS NOT NULL THEN SELECT print_job_head(to_jsonb(j)) INTO h FROM print_jobs j WHERE tenant_id=NEW.tenant_id AND id=NEW.job_id; ELSE SELECT print_job_printer_head(to_jsonb(p)) INTO h FROM print_printers p WHERE tenant_id=NEW.tenant_id AND id=NEW.printer_id; END IF;
 IF h IS NULL OR (h->>'version')::bigint<NEW.version_after THEN RAISE EXCEPTION 'Brak pełnego potwierdzenia drukowania' USING ERRCODE='23514'; END IF;
 IF (h->>'version')::bigint=NEW.version_after THEN
  IF h IS DISTINCT FROM NEW.result->(CASE WHEN NEW.job_id IS NULL THEN 'printer' ELSE 'job' END) THEN RAISE EXCEPTION 'Stan drukowania różni się od potwierdzenia' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT before_head INTO nextbefore FROM print_job_events WHERE tenant_id=NEW.tenant_id AND job_id IS NOT DISTINCT FROM NEW.job_id AND printer_id IS NOT DISTINCT FROM NEW.printer_id AND version_before=NEW.version_after;
  IF nextbefore IS DISTINCT FROM NEW.result->(CASE WHEN NEW.job_id IS NULL THEN 'printer' ELSE 'job' END) THEN RAISE EXCEPTION 'Przerwany łańcuch drukowania' USING ERRCODE='23514'; END IF;
 END IF;
 PERFORM print_job_budget(); PERFORM print_job_require(NEW.actor_id,NEW.api_key_id,true,false,NEW.printer_id IS NOT NULL OR NEW.operation='reconcile'); RETURN NULL;
END $$;
CREATE TRIGGER print_job_printer_guard BEFORE INSERT OR UPDATE OR DELETE ON print_printers FOR EACH ROW EXECUTE FUNCTION print_job_guard();
CREATE TRIGGER print_job_job_guard BEFORE INSERT OR UPDATE OR DELETE ON print_jobs FOR EACH ROW EXECUTE FUNCTION print_job_guard();
CREATE TRIGGER print_job_event_immutable BEFORE UPDATE OR DELETE ON print_job_events FOR EACH ROW EXECUTE FUNCTION print_job_immutable();
CREATE CONSTRAINT TRIGGER print_job_event_complete AFTER INSERT ON print_job_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION print_job_complete();
CREATE FUNCTION print_job_guards() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND (SELECT count(*) FROM pg_class WHERE oid=ANY(ARRAY['print_printers'::regclass,'print_jobs'::regclass,'print_job_events'::regclass]) AND relrowsecurity AND relforcerowsecurity)=3
 AND NOT EXISTS(SELECT 1 FROM (VALUES ('print_printers','print_job_printer_guard','print_job_guard()',false),('print_jobs','print_job_job_guard','print_job_guard()',false),('print_job_events','print_job_event_immutable','print_job_immutable()',false),('print_job_events','print_job_event_complete','print_job_complete()',true)) g(rel,n,fn,d)
 WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(g.rel) AND t.tgname::text=g.n AND t.tgfoid=to_regprocedure(g.fn) AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgdeferrable=g.d AND t.tginitdeferred=g.d))
$$;
REVOKE ALL ON FUNCTION print_job_installed(),print_job_access(uuid,uuid,boolean,boolean),print_job_require(uuid,uuid,boolean,boolean,boolean),print_job_hash(jsonb),print_job_head(jsonb),print_job_printer_head(jsonb),print_job_lock(),print_job_budget(),print_job_content_valid(text,text),print_job_replay(uuid,text,uuid,uuid,text,uuid),print_job_event(uuid,uuid,uuid,uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb),print_job_printer_write(jsonb,uuid,uuid,uuid),print_job_create(jsonb,uuid,uuid),print_job_command(uuid,jsonb,uuid,uuid,text),print_job_content(uuid,uuid,uuid,uuid),print_job_immutable(),print_job_guard(),print_job_complete() FROM PUBLIC,dyna_app;
GRANT EXECUTE ON FUNCTION print_job_installed(),print_job_access(uuid,uuid,boolean,boolean),print_job_printer_write(jsonb,uuid,uuid,uuid),print_job_create(jsonb,uuid,uuid),print_job_command(uuid,jsonb,uuid,uuid,text),print_job_content(uuid,uuid,uuid,uuid) TO dyna_app;
REVOKE ALL ON FUNCTION print_job_guards() FROM PUBLIC,dyna_app;
