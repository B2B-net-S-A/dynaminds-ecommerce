-- Supports exact tenant-private image library keyset pages.
-- Managed once by the existing advisory-locked migration transaction.
-- Both orders are needed: MIME ahead of created_at cannot provide the all-format order.
CREATE INDEX product_images_tenant_created_id
  ON public.product_images (tenant_id, created_at DESC, id DESC);
CREATE INDEX product_images_tenant_mime_created_id
  ON public.product_images (tenant_id, mime, created_at DESC, id DESC);
