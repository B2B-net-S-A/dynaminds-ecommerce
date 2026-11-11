CREATE INDEX automation_runs_chain ON automation_runs(tenant_id,(context->>'chain_id'))
 WHERE (definition->>'limit_notice') IS DISTINCT FROM 'true';
