-- Supports exact tenant/channel verification-history keyset pages.
-- Executed once in the existing advisory-locked managed migration transaction.
CREATE INDEX integration_runs_tenant_channel_date
  ON public.integration_runs (tenant_id, channel_id, created_at DESC, id DESC);
