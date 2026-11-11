DO $$ BEGIN IF EXISTS(SELECT 1 FROM product_translations WHERE version IS NULL OR version<=0) THEN RAISE EXCEPTION 'Invalid existing translation versions; explicit repair required';END IF;END $$;
ALTER TABLE product_translations ALTER COLUMN version SET NOT NULL;
ALTER TABLE product_translations ADD CONSTRAINT product_translations_positive_version CHECK(version>0);

CREATE TABLE product_translation_bulk_edit_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),source text NOT NULL CHECK(source IN ('manual','api')),
 locales jsonb NOT NULL CHECK(jsonb_typeof(locales)='array' AND jsonb_array_length(locales) BETWEEN 1 AND 6),rules_snapshot jsonb NOT NULL CHECK(jsonb_typeof(rules_snapshot)='array'),
 total integer NOT NULL CHECK(total BETWEEN 1 AND 3000),product_count integer NOT NULL CHECK(product_count BETWEEN 1 AND 500),changed_pairs integer NOT NULL CHECK(changed_pairs>=0),unchanged_pairs integer NOT NULL CHECK(unchanged_pairs>=0),changed_products integer NOT NULL CHECK(changed_products BETWEEN 0 AND product_count),invalid integer NOT NULL CHECK(invalid>=0),conflicts integer NOT NULL CHECK(conflicts>=0),missing_after_count integer NOT NULL CHECK(missing_after_count BETWEEN 0 AND total),ready boolean NOT NULL,
 byte_count bigint NOT NULL DEFAULT 0 CHECK(byte_count>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 CHECK(total=product_count*jsonb_array_length(locales)),CHECK(changed_pairs+unchanged_pairs+invalid+conflicts=total),CHECK(ready=(invalid=0 AND conflicts=0))
);
CREATE INDEX product_translation_bulk_preview_history ON product_translation_bulk_edit_previews(tenant_id,created_at DESC,id DESC);
CREATE TABLE product_translation_bulk_edit_rows (
 tenant_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 2999),receipt_id uuid NOT NULL,
 product_id uuid NOT NULL,sku text NOT NULL,kind text NOT NULL,product_name text NOT NULL,product_version integer NOT NULL CHECK(product_version>0),locale text NOT NULL CHECK(locale~'^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$' AND length(locale)<=40),
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),source jsonb NOT NULL CHECK(jsonb_typeof(source)='object'),before jsonb NOT NULL CHECK(jsonb_typeof(before)='object'),after jsonb,
 status text NOT NULL CHECK(status IN ('changed','unchanged','invalid','conflict')),errors jsonb NOT NULL CHECK(jsonb_typeof(errors)='array'),byte_count bigint NOT NULL DEFAULT 0 CHECK(byte_count>0),
 PRIMARY KEY(tenant_id,preview_id,index),UNIQUE(tenant_id,receipt_id),UNIQUE(tenant_id,preview_id,product_id,locale),UNIQUE(tenant_id,preview_id,index,receipt_id,product_id,locale),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES product_translation_bulk_edit_previews(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 CHECK(status NOT IN ('changed','unchanged') OR (after IS NOT NULL AND jsonb_typeof(after)='object'))
);
CREATE TABLE product_translation_bulk_edit_executions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,source text NOT NULL CHECK(source IN ('manual','api')),
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),state text NOT NULL DEFAULT 'done' CHECK(state='done'),locales jsonb NOT NULL,rules_snapshot jsonb NOT NULL,
 total integer NOT NULL CHECK(total BETWEEN 1 AND 3000),product_count integer NOT NULL CHECK(product_count BETWEEN 1 AND 500),changed_pairs integer NOT NULL CHECK(changed_pairs>=0),unchanged_pairs integer NOT NULL CHECK(unchanged_pairs>=0),changed_products integer NOT NULL CHECK(changed_products BETWEEN 0 AND product_count),missing_after_count integer NOT NULL CHECK(missing_after_count BETWEEN 0 AND total),ack_missing_translations boolean NOT NULL,
 byte_count bigint NOT NULL DEFAULT 0 CHECK(byte_count>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,preview_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,preview_id) REFERENCES product_translation_bulk_edit_previews(tenant_id,id),
 CHECK(changed_pairs+unchanged_pairs=total),CHECK(missing_after_count=0 OR ack_missing_translations)
);
CREATE INDEX product_translation_bulk_execution_history ON product_translation_bulk_edit_executions(tenant_id,created_at DESC,id DESC);
CREATE TABLE product_translation_bulk_edit_execution_rows (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,execution_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 2999),product_id uuid NOT NULL,locale text NOT NULL,
 sku text NOT NULL,kind text NOT NULL,product_name text NOT NULL,input jsonb NOT NULL,operation text NOT NULL CHECK(operation IN ('none','set','remove')),status text NOT NULL CHECK(status IN ('changed','unchanged')),
 source jsonb NOT NULL,before jsonb NOT NULL,after jsonb NOT NULL,before_product_version integer NOT NULL CHECK(before_product_version>0),after_product_version integer NOT NULL CHECK(after_product_version>0),byte_count bigint NOT NULL DEFAULT 0 CHECK(byte_count>0),
 UNIQUE(tenant_id,id,product_id,locale),UNIQUE(tenant_id,execution_id,index),UNIQUE(tenant_id,execution_id,product_id,locale),
 FOREIGN KEY(tenant_id,execution_id,preview_id) REFERENCES product_translation_bulk_edit_executions(tenant_id,id,preview_id),FOREIGN KEY(tenant_id,preview_id,index,id,product_id,locale) REFERENCES product_translation_bulk_edit_rows(tenant_id,preview_id,index,receipt_id,product_id,locale),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 CHECK(after_product_version BETWEEN before_product_version AND before_product_version::bigint+1)
);
ALTER TABLE product_translations ADD COLUMN manual_receipt_id uuid;
ALTER TABLE product_translations ADD FOREIGN KEY(tenant_id,manual_receipt_id,product_id,locale) REFERENCES product_translation_bulk_edit_execution_rows(tenant_id,id,product_id,locale);
ALTER TABLE product_translations DROP CONSTRAINT product_translations_check;
ALTER TABLE product_translations ADD CONSTRAINT product_translations_provenance CHECK(num_nonnulls(ai_draft_id,deepl_draft_id,manual_receipt_id)=1);
GRANT DELETE ON product_translations TO dyna_app;

CREATE FUNCTION product_translation_bulk_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'Translation bulk evidence is immutable';END $$;
CREATE FUNCTION product_translation_bulk_bytes() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE n bigint;BEGIN
 -- Include every serialized column (including the byte counter itself), with a
 -- fixed-point iteration because adding the counter changes its digit width.
 LOOP n:=octet_length(to_jsonb(NEW)::text);EXIT WHEN NEW.byte_count=n;NEW.byte_count:=n;END LOOP;RETURN NEW;
END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['product_translation_bulk_edit_previews','product_translation_bulk_edit_rows','product_translation_bulk_edit_executions','product_translation_bulk_edit_execution_rows'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION product_translation_bulk_immutable()',t);EXECUTE format('CREATE TRIGGER serialized_bytes BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION product_translation_bulk_bytes()',t);
END LOOP;END $$;

CREATE FUNCTION product_translation_bulk_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE p record;e record;r record;BEGIN
 SELECT * INTO p FROM product_translation_bulk_edit_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
 IF TG_TABLE_NAME='product_translation_bulk_edit_rows' THEN
 IF p.id IS NULL OR NEW.index>=p.total OR NOT (p.locales ? NEW.locale) OR (NEW.input->>'product_id')::uuid IS DISTINCT FROM NEW.product_id OR NEW.input->>'locale' IS DISTINCT FROM NEW.locale THEN RAISE EXCEPTION 'Translation row outside scope';END IF;
 ELSIF TG_TABLE_NAME='product_translation_bulk_edit_executions' THEN
 IF p.id IS NULL OR NOT p.ready OR ROW(NEW.actor_id,NEW.source,NEW.scope_hash,NEW.locales,NEW.rules_snapshot,NEW.total,NEW.product_count,NEW.changed_pairs,NEW.unchanged_pairs,NEW.changed_products,NEW.missing_after_count) IS DISTINCT FROM ROW(p.actor_id,p.source,p.scope_hash,p.locales,p.rules_snapshot,p.total,p.product_count,p.changed_pairs,p.unchanged_pairs,p.changed_products,p.missing_after_count) THEN RAISE EXCEPTION 'Translation execution differs from preview';END IF;
 ELSE
 SELECT * INTO e FROM product_translation_bulk_edit_executions WHERE (tenant_id,id,preview_id)=(NEW.tenant_id,NEW.execution_id,NEW.preview_id);
 SELECT * INTO r FROM product_translation_bulk_edit_rows WHERE (tenant_id,preview_id,index)=(NEW.tenant_id,NEW.preview_id,NEW.index);
 IF e.id IS NULL OR r.receipt_id IS NULL OR ROW(NEW.id,NEW.product_id,NEW.locale,NEW.sku,NEW.kind,NEW.product_name,NEW.input,NEW.operation,NEW.status,NEW.source,NEW.before,NEW.after,NEW.before_product_version) IS DISTINCT FROM ROW(r.receipt_id,r.product_id,r.locale,r.sku,r.kind,r.product_name,r.input,r.input->>'operation',r.status,r.source,r.before,r.after,r.product_version)
 OR NEW.after_product_version<>(r.product_version::bigint+(CASE WHEN EXISTS(SELECT 1 FROM product_translation_bulk_edit_rows q WHERE q.tenant_id=r.tenant_id AND q.preview_id=r.preview_id AND q.product_id=r.product_id AND q.status='changed') THEN 1 ELSE 0 END)) THEN RAISE EXCEPTION 'Translation receipt differs from approved row';END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER scope BEFORE INSERT ON product_translation_bulk_edit_rows FOR EACH ROW EXECUTE FUNCTION product_translation_bulk_scope();
CREATE TRIGGER scope BEFORE INSERT ON product_translation_bulk_edit_executions FOR EACH ROW EXECUTE FUNCTION product_translation_bulk_scope();
CREATE TRIGGER scope BEFORE INSERT ON product_translation_bulk_edit_execution_rows FOR EACH ROW EXECUTE FUNCTION product_translation_bulk_scope();
CREATE FUNCTION product_translation_manual_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE r record;BEGIN
 IF NEW.manual_receipt_id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO r FROM product_translation_bulk_edit_execution_rows WHERE (tenant_id,id,product_id,locale)=(NEW.tenant_id,NEW.manual_receipt_id,NEW.product_id,NEW.locale);
 IF r.id IS NULL OR r.status<>'changed' OR r.operation<>'set' OR (r.after->>'present')::boolean IS DISTINCT FROM true OR ROW(NEW.name,NEW.description,NEW.version) IS DISTINCT FROM ROW(r.after->>'name',r.after->>'description',(r.after->>'version')::integer) OR (r.after#>>'{provenance,kind}') IS DISTINCT FROM 'manual' OR (r.after#>>'{provenance,id}')::uuid IS DISTINCT FROM NEW.manual_receipt_id THEN RAISE EXCEPTION 'Manual translation differs from its approved receipt';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER manual_scope BEFORE INSERT OR UPDATE ON product_translations FOR EACH ROW EXECUTE FUNCTION product_translation_manual_scope();

CREATE FUNCTION product_translation_bulk_budget() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE t uuid;n bigint;p uuid;BEGIN
 FOR t IN SELECT DISTINCT tenant_id FROM inserted LOOP
 PERFORM pg_advisory_xact_lock(hashtextextended('product.translation.bulk:'||t::text,0));
 IF (SELECT count(*) FROM product_translation_bulk_edit_previews WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM product_translation_bulk_edit_executions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Translation bulk history quota exceeded' USING ERRCODE='P0001';END IF;
 SELECT coalesce(sum(bytes),0) INTO n FROM (SELECT byte_count bytes FROM product_translation_bulk_edit_previews WHERE tenant_id=t UNION ALL SELECT byte_count FROM product_translation_bulk_edit_rows WHERE tenant_id=t UNION ALL SELECT byte_count FROM product_translation_bulk_edit_executions WHERE tenant_id=t UNION ALL SELECT byte_count FROM product_translation_bulk_edit_execution_rows WHERE tenant_id=t) s;
 IF n>134217728 THEN RAISE EXCEPTION 'Translation bulk storage quota exceeded' USING ERRCODE='P0001';END IF;
 IF TG_TABLE_NAME IN ('product_translation_bulk_edit_previews','product_translation_bulk_edit_rows') THEN
 FOR p IN EXECUTE (CASE WHEN TG_TABLE_NAME='product_translation_bulk_edit_previews' THEN 'SELECT id FROM inserted WHERE tenant_id=$1' ELSE 'SELECT DISTINCT preview_id FROM inserted WHERE tenant_id=$1' END) USING t LOOP
 SELECT h.byte_count+coalesce(sum(r.byte_count),0) INTO n FROM product_translation_bulk_edit_previews h LEFT JOIN product_translation_bulk_edit_rows r ON (r.tenant_id,r.preview_id)=(h.tenant_id,h.id) WHERE (h.tenant_id,h.id)=(t,p) GROUP BY h.byte_count;
 IF n>8388608 THEN RAISE EXCEPTION 'Translation bulk preview exceeds eight MiB' USING ERRCODE='P0001';END IF;
 END LOOP;END IF;
 END LOOP;RETURN NULL;END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['product_translation_bulk_edit_previews','product_translation_bulk_edit_rows','product_translation_bulk_edit_executions','product_translation_bulk_edit_execution_rows'] LOOP EXECUTE format('CREATE TRIGGER budget AFTER INSERT ON %I REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION product_translation_bulk_budget()',t);END LOOP;END $$;
