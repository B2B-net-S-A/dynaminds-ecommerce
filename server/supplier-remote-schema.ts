import { z } from 'zod';
import type { Actor } from './domain';
import { supplierRemoteFeedUrl } from './supplier-remote-fetch-transport';

const uuid = z.uuid().transform((s) => s.toLowerCase());
const version = z.number().int().min(0).max(2147483646);
const secret = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !/[\u0000-\u001f\u007f]/u.test(s));
export const supplierRemoteAuthValue = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('basic'),
      username: z
        .string()
        .max(4096)
        .refine((s) => !/[:\u0000-\u001f\u007f]/u.test(s)),
      password: secret,
    })
    .refine(
      (v) =>
        v.username.length + v.password.length <= 4096 &&
        Buffer.byteLength(`${v.username}:${v.password}`, 'utf8') <= 10000,
    ),
  z.strictObject({ kind: z.literal('bearer'), token: secret.regex(/^[\x20-\x7e]+$/) }),
  z.strictObject({
    kind: z.literal('header'),
    name: z
      .string()
      .max(80)
      .regex(/^x-[a-z0-9]+(?:-[a-z0-9]+)*$/i)
      .refine(
        (s) => !/^x-(?:forwarded|real-ip|http-method|proxy|original|rewrite)(?:-|$)/i.test(s),
      ),
    value: secret.regex(/^[\x20-\x7e]+$/),
  }),
]);
export const supplierRemoteAuthInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('keep') }),
  z.strictObject({ action: z.literal('clear') }),
  z.strictObject({ action: z.literal('replace'), value: supplierRemoteAuthValue }),
]);
export const supplierRemoteUpdateInput = z
  .strictObject({
    client_key: uuid,
    version,
    source_version: version.min(1),
    url: z
      .string()
      .min(1)
      .max(8192)
      .refine((s) => {
        try {
          supplierRemoteFeedUrl(s);
          return true;
        } catch {
          return false;
        }
      }, 'Wymagany publiczny URL HTTPS bez userinfo/fragment'),
    auth: supplierRemoteAuthInput,
    scope: z.enum(['delta', 'full']),
    confirmed: z.literal(true),
  })
  .partial({ url: true });
export const supplierRemoteFetchInput = z.strictObject({
  client_key: uuid,
  remote_version: version.min(1),
  source_version: version.min(1),
});
export const supplierFeedPublishPolicy = z
  .strictObject({
    enabled: z.boolean().default(false),
    allow_new: z.boolean().default(false),
    withdrawal: z
      .strictObject({
        enabled: z.boolean().default(false),
        min_rows: z.number().int().min(1).max(500).default(1),
        max_missing: z.number().int().min(0).max(10000).default(0),
        max_missing_percent: z.number().int().min(0).max(100).default(0),
      })
      .default({ enabled: false, min_rows: 1, max_missing: 0, max_missing_percent: 0 }),
  })
  .default({
    enabled: false,
    allow_new: false,
    withdrawal: { enabled: false, min_rows: 1, max_missing: 0, max_missing_percent: 0 },
  });
export const supplierFeedScheduleInput = z.strictObject({
  client_key: uuid,
  version,
  source_version: version.min(1),
  remote_version: version.min(1),
  enabled: z.boolean(),
  interval_minutes: z.number().int().min(30).max(10080),
  confirmed: z.literal(true),
  publish: supplierFeedPublishPolicy,
});
export const supplierRemotePageInput = z.strictObject({
  after: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const SUPPLIER_REMOTE_FEED_LIMITS = Object.freeze({
  file_bytes: 2097152,
  rows: 500,
  previews: 200,
  source_items: 10000,
  history: 2000,
  retained_evidence_bytes: 33554432,
  pending_jobs: 1000,
  min_interval_minutes: 30,
  max_interval_minutes: 10080,
});
export type SupplierRemoteActor = Actor & { apiKeyId?: string; canReadValue?: boolean };
export type SupplierRemoteUpdateInput = z.infer<typeof supplierRemoteUpdateInput>;
export type SupplierRemoteFetchInput = z.infer<typeof supplierRemoteFetchInput>;
export type SupplierFeedScheduleInput = z.infer<typeof supplierFeedScheduleInput>;
export type SupplierRemotePageInput = z.infer<typeof supplierRemotePageInput>;
export type SupplierFeedPublishPolicy = z.infer<typeof supplierFeedPublishPolicy>;
export type SupplierRemoteView = {
  id?: string;
  source_id: string;
  version: number;
  source_version: number;
  configured: boolean;
  display_host: string | null;
  auth_kind: 'none' | 'basic' | 'bearer' | 'header';
  has_credentials: boolean;
  scope: 'delta' | 'full';
  created_at?: string;
  updated_at?: string;
};
export type SupplierRemoteFetchView = {
  id: string;
  source_id: string;
  job_id: string;
  source_version: number;
  remote_version: number;
  schedule_version: number | null;
  state:
    'queued' | 'fetching' | 'success' | 'awaiting-consent' | 'failed' | 'conflict' | 'cancelled';
  phase: string;
  attempt: number;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  http_status: number | null;
  wire_bytes: number | null;
  decoded_bytes: number | null;
  wire_hash: string | null;
  raw_hash: string | null;
  preview_id: string | null;
  run_id: string | null;
  summary: Record<string, number> | null;
  error_code: string | null;
};
export type SupplierFeedScheduleView = {
  source_id: string;
  version: number;
  source_version: number;
  remote_version: number;
  enabled: boolean;
  interval_minutes: number;
  publish: SupplierFeedPublishPolicy;
  next_at: string | null;
  last_fetch_id: string | null;
  error_code: string | null;
  created_at?: string;
  updated_at?: string;
};
