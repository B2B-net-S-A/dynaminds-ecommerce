-- Local definition editor; the public Base API documents definition reads only.
-- Keep the identity/type and every existing customer value/file intact.
ALTER TABLE crm_extra_fields
 ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0),
 ADD COLUMN archived_at timestamptz;
ALTER TABLE crm_extra_fields ADD CONSTRAINT crm_field_position_nonnegative CHECK(position>=0);
GRANT INSERT ON crm_extra_fields TO dyna_app;
GRANT UPDATE(name,options,position,version,archived_at) ON crm_extra_fields TO dyna_app;
-- No DELETE and no UPDATE of id, tenant_id or editor_type. Existing FORCE RLS remains.
CREATE INDEX crm_values_field_definition_lookup ON crm_values(tenant_id,field_id,client_id);
