-- Additive product-rule sale price/tag extension; no stock writer or capability change.
ALTER TABLE public.products ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
CREATE FUNCTION public.product_tags_valid(v text[]) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT cardinality(v)<=20 AND array_position(v,NULL) IS NULL AND cardinality(v)=(SELECT count(DISTINCT x) FROM unnest(v)x)
 AND NOT EXISTS(SELECT FROM unnest(v)x WHERE length(x) NOT BETWEEN 1 AND 80 OR x<>btrim(x) OR x<>normalize(x,NFC) OR x~'[[:cntrl:]]') $$;
ALTER TABLE public.products ADD CONSTRAINT product_tags_valid CHECK(public.product_tags_valid(tags));
ALTER TABLE public.price_bulk_edit_previews DROP CONSTRAINT price_bulk_edit_previews_source_check;
ALTER TABLE public.price_bulk_edit_previews ADD CONSTRAINT price_bulk_edit_previews_source_check CHECK(source IN('manual','api','product_rule'));
CREATE TABLE public.product_rule_price_executions(
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,price_list_id uuid NOT NULL,preview_id uuid NOT NULL,execution_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,run_id,price_list_id),
 UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,execution_id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES public.product_rule_runs(tenant_id,id),
 FOREIGN KEY(tenant_id,price_list_id) REFERENCES public.price_lists(tenant_id,id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES public.price_bulk_edit_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,execution_id,preview_id) REFERENCES public.price_bulk_edit_executions(tenant_id,id,preview_id));
ALTER TABLE public.product_rule_price_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_rule_price_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.product_rule_price_executions TO dyna_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT ON public.product_rule_price_executions TO dyna_app;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.product_rule_price_executions FOR EACH ROW EXECUTE FUNCTION public.price_bulk_edit_immutable();
CREATE FUNCTION public.product_rule_price_binding() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid;rid uuid;r record;p record;e record;child record;expected integer;actual integer;src record;line record;
BEGIN
 t:=NEW.tenant_id;
 IF TG_TABLE_NAME='product_rule_price_executions' THEN rid:=NEW.run_id;
 ELSIF TG_TABLE_NAME='product_rule_runs' THEN rid:=NEW.id;
 ELSE
   IF NEW.source<>'product_rule' THEN RETURN NULL;END IF;
   SELECT run_id INTO rid FROM public.product_rule_price_executions WHERE(tenant_id,preview_id)=(t,NEW.id);
   IF rid IS NULL THEN RAISE EXCEPTION 'Brak trwałego rodzica natywnej ceny reguły' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO r FROM public.product_rule_runs WHERE(tenant_id,id)=(t,rid);
 IF NOT EXISTS(SELECT FROM public.product_rule_items i WHERE(i.tenant_id,i.run_id)=(t,rid) AND i.projected ? 'price_targets') THEN RETURN NULL;END IF;
 IF r.state IS DISTINCT FROM 'done' THEN
   IF EXISTS(SELECT FROM public.product_rule_price_executions x WHERE(x.tenant_id,x.run_id)=(t,rid)) THEN RAISE EXCEPTION 'Cena ma niezakończonego rodzica reguły' USING ERRCODE='23514';END IF;
   RETURN NULL;
 END IF;
 SELECT count(DISTINCT k) INTO expected FROM public.product_rule_items i CROSS JOIN LATERAL jsonb_object_keys(i.projected->'price_targets')k WHERE(i.tenant_id,i.run_id)=(t,rid);
 SELECT count(*) INTO actual FROM public.product_rule_price_executions x WHERE(x.tenant_id,x.run_id)=(t,rid);
 IF expected<>actual THEN RAISE EXCEPTION 'Niepełne natywne wykonania cen reguły' USING ERRCODE='23514';END IF;
 FOR child IN SELECT * FROM public.product_rule_price_executions x WHERE(x.tenant_id,x.run_id)=(t,rid) ORDER BY price_list_id LOOP
   SELECT * INTO p FROM public.price_bulk_edit_previews WHERE(tenant_id,id)=(t,child.preview_id);
   SELECT * INTO e FROM public.price_bulk_edit_executions WHERE(tenant_id,id,preview_id)=(t,child.execution_id,child.preview_id);
   IF p.source IS DISTINCT FROM 'product_rule' OR p.price_list_id IS DISTINCT FROM child.price_list_id OR e.id IS NULL OR e.price_list_id IS DISTINCT FROM child.price_list_id
   OR NOT(p.actor_id IS NOT DISTINCT FROM (CASE WHEN r.origin='manual' THEN r.queued_actor ELSE p.actor_id END))
   OR (r.origin='catalog' AND NOT EXISTS(SELECT FROM jsonb_array_elements(r.rules)x WHERE x->>'approved_by'=p.actor_id::text))
   THEN RAISE EXCEPTION 'Obcy rodzic cenowy reguły' USING ERRCODE='23514';END IF;
   SELECT count(*) INTO expected FROM public.product_rule_items i WHERE(i.tenant_id,i.run_id)=(t,rid) AND i.projected->'price_targets' ? child.price_list_id::text;
   IF p.total<>expected OR (SELECT count(*) FROM public.price_bulk_edit_execution_rows x WHERE(x.tenant_id,x.execution_id)=(t,e.id))<>expected THEN RAISE EXCEPTION 'Niepełny natywny manifest cen reguły' USING ERRCODE='23514';END IF;
   FOR src IN SELECT * FROM public.product_rule_items i WHERE(i.tenant_id,i.run_id)=(t,rid) AND i.projected->'price_targets' ? child.price_list_id::text LOOP
     SELECT * INTO line FROM public.price_bulk_edit_rows x WHERE(x.tenant_id,x.preview_id,x.product_id)=(t,p.id,src.product_id);
     IF line.product_id IS NULL OR line.product_version<>src.source_version OR line.input IS DISTINCT FROM jsonb_build_object('product_id',src.product_id,'product_version',src.source_version,'operation','set','basis','gross','amount_minor',(src.projected->'price_targets'->>child.price_list_id::text)::integer)
     OR line.before IS DISTINCT FROM src.source->'price_targets'->child.price_list_id::text->'snapshot'
     OR p.list_snapshot IS DISTINCT FROM src.source->'price_targets'->child.price_list_id::text->'frame'->'list'
     OR p.repricing_snapshot IS DISTINCT FROM src.source->'price_targets'->child.price_list_id::text->'frame'->'repricing_snapshot'
     OR (line.after->>'override_present')::boolean IS DISTINCT FROM true OR (line.after->>'override_price')::integer IS DISTINCT FROM (src.projected->'price_targets'->>child.price_list_id::text)::integer
     THEN RAISE EXCEPTION 'Natywna cena różni się od zgody reguły' USING ERRCODE='23514';END IF;
   END LOOP;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER product_rule_price_binding AFTER INSERT ON public.product_rule_price_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.product_rule_price_binding();
CREATE CONSTRAINT TRIGGER product_rule_price_complete AFTER INSERT OR UPDATE ON public.product_rule_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.product_rule_price_binding();
CREATE CONSTRAINT TRIGGER product_rule_price_parent AFTER INSERT ON public.price_bulk_edit_previews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.product_rule_price_binding();
-- Owner-only manifest. Effective ACL canonicalization survives pg_dump owner defaults.
CREATE TABLE public.product_rule_price_tags_manifest(id boolean PRIMARY KEY DEFAULT true CHECK(id),fingerprint text NOT NULL);
REVOKE ALL ON public.product_rule_price_tags_manifest FROM PUBLIC,dyna_app;
CREATE FUNCTION public.product_rule_price_tags_fingerprint() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT md5(jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
 'acl',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a),
 'cols',(SELECT jsonb_agg(jsonb_build_array(x.attname,format_type(x.atttypid,x.atttypmod),x.attnotnull,(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(ca.grantor),CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,ca.is_grantable) ORDER BY CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,pg_get_userbyid(ca.grantor)::text,ca.is_grantable) FROM aclexplode(x.attacl)ca),pg_get_expr(d.adbin,d.adrelid)) ORDER BY x.attnum) FROM pg_attribute x LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(x.attrelid,x.attnum) WHERE x.attrelid=c.oid AND x.attnum>0 AND NOT x.attisdropped),
 'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid,true) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'policies',(SELECT jsonb_agg(jsonb_build_array(po.polname,(SELECT array_agg(CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END ORDER BY CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END) FROM unnest(po.polroles)x),po.polcmd,pg_get_expr(po.polqual,po.polrelid),pg_get_expr(po.polwithcheck,po.polrelid)) ORDER BY po.polname) FROM pg_policy po WHERE po.polrelid=c.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(tr.tgname,tr.tgenabled,pg_get_triggerdef(tr.oid,true)) ORDER BY tr.tgname) FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN('product_rule_price_executions','product_rule_price_tags_manifest','price_bulk_edit_previews','price_bulk_edit_rows','price_bulk_edit_executions','price_bulk_edit_execution_rows')),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN('product_tags_valid','product_rule_price_binding','product_rule_price_tags_guards','product_rule_price_tags_pin','product_rule_price_tags_fingerprint','price_bulk_edit_immutable','price_bulk_edit_scope')),
 'tag_column',(SELECT jsonb_build_array(format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) FROM pg_attribute a LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum) WHERE a.attrelid='public.products'::regclass AND a.attname='tags' AND NOT a.attisdropped),
 'tag_check',(SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.products'::regclass AND conname='product_tags_valid'),
 'origin_check',(SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.price_bulk_edit_previews'::regclass AND conname='price_bulk_edit_previews_source_check'),
 'parent_triggers',(SELECT jsonb_agg(jsonb_build_array(tgname,tgenabled,pg_get_triggerdef(oid,true)) ORDER BY tgname) FROM pg_trigger WHERE tgname IN('product_rule_price_complete','product_rule_price_parent'))
 )::text) $$;
CREATE FUNCTION public.product_rule_price_tags_guards() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.product_tags_valid(text[])','public.product_rule_price_binding()','public.product_rule_price_tags_fingerprint()','public.product_rule_price_tags_pin(uuid,uuid)','public.price_bulk_edit_immutable()','public.price_bulk_edit_scope()'] LOOP IF to_regprocedure(signature) IS NULL THEN RETURN false;END IF;END LOOP;
 IF to_regclass('public.product_rule_price_executions') IS NULL OR to_regclass('public.product_rule_price_tags_manifest') IS NULL THEN RETURN false;END IF;
 RETURN (SELECT fingerprint=public.product_rule_price_tags_fingerprint() FROM public.product_rule_price_tags_manifest WHERE id);
END $$;
CREATE FUNCTION public.product_rule_price_tags_pin(rid uuid,uid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r record;ownerid uuid;role text;
BEGIN
 SELECT * INTO r FROM public.product_rule_runs WHERE(tenant_id,id)=(t,rid);
 IF r.id IS NULL OR r.state<>'done' OR (r.origin='manual' AND r.queued_actor IS DISTINCT FROM uid) OR(r.origin='catalog' AND NOT EXISTS(SELECT FROM jsonb_array_elements(r.rules)x WHERE x->>'approved_by'=uid::text)) THEN RAISE EXCEPTION 'Obca zgoda reguły cen' USING ERRCODE='42501';END IF;
 FOR ownerid IN SELECT DISTINCT id FROM (SELECT uid id UNION ALL SELECT(x->>'approved_by')::uuid FROM jsonb_array_elements(r.rules)x)q ORDER BY id LOOP
 SELECT m.role INTO role FROM public.memberships m WHERE(m.tenant_id,m.user_id)=(t,ownerid) FOR SHARE;
 IF role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Cofnięto zgodę administratora' USING ERRCODE='42501';END IF;
 END LOOP;
 IF NOT public.product_rule_price_tags_guards() THEN RAISE EXCEPTION 'Niekompletny moduł reguł cen i tagów' USING ERRCODE='55000';END IF;
END $$;
REVOKE ALL ON FUNCTION public.product_rule_price_tags_fingerprint(),public.product_rule_price_binding() FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION public.product_rule_price_tags_guards(),public.product_rule_price_tags_pin(uuid,uuid),public.product_tags_valid(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.product_rule_price_tags_guards(),public.product_rule_price_tags_pin(uuid,uuid),public.product_tags_valid(text[]) TO dyna_app;
INSERT INTO public.product_rule_price_tags_manifest VALUES(true,public.product_rule_price_tags_fingerprint());
