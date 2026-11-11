ALTER TABLE product_images ADD UNIQUE(tenant_id,id);
CREATE TABLE odoo_image_imports (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,product_id uuid NOT NULL,channel_id uuid NOT NULL,listing_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,input_hash text NOT NULL,
 connection_hash text NOT NULL,credentials_hash text NOT NULL,product_version integer NOT NULL,
 image_id uuid NOT NULL,sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),remote_id text NOT NULL,
 mode text NOT NULL CHECK(mode IN('simulation','external')),state text NOT NULL DEFAULT 'preview' CHECK(state IN('preview','applied')),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',applied_at timestamptz,
 UNIQUE(tenant_id,product_id,client_key),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 FOREIGN KEY(tenant_id,listing_id) REFERENCES listings(tenant_id,id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),
 FOREIGN KEY(tenant_id,image_id) REFERENCES product_images(tenant_id,id)
);
CREATE INDEX odoo_image_product_history ON odoo_image_imports(tenant_id,product_id,created_at DESC,id DESC);
ALTER TABLE odoo_image_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE odoo_image_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON odoo_image_imports TO dyna_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON odoo_image_imports TO dyna_app;
CREATE FUNCTION odoo_image_authorized(actor_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE member_role text;
BEGIN
 SELECT role INTO member_role FROM memberships WHERE user_id=actor_id AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid FOR SHARE;
 RETURN member_role='admin';
END $$;
REVOKE ALL ON FUNCTION odoo_image_authorized(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION odoo_image_authorized(uuid) TO dyna_app;
