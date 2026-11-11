import { z } from 'zod';
import type { Actor } from './domain';
import type { AutomaticWzDocument } from './warehouse-wz-issuer-schema';

export const WZ_ISSUED_LIMITS = Object.freeze({ page: 50 as const, rows: 10000, file_bytes: 8 * 1024 * 1024 });
export const issuedWzUuid = z.uuid().transform(s => s.toLowerCase());
export const issuedWzQuery = z.strictObject({ warehouse_id: issuedWzUuid.optional(), order_id: issuedWzUuid.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50), cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional() });
export const issuedWzExportQuery = z.strictObject({ format: z.enum(['csv','xml']).default('csv'),
  include_values: z.enum(['true','false']).default('false').transform(v => v === 'true') });
export type IssuedWzActor = Actor;
export type IssuedWzFlags = { available: boolean; can_read: boolean; can_read_value: boolean;
  current_role: Actor['role']; read_only: boolean };
export type IssuedWzHeader = AutomaticWzDocument & { value_available: boolean };
export type IssuedWzRow = { ordinal: number; product_id: string; sku: string; name: string; quantity: number; location: string;
  stock_movement_id: string; location_movement_id: string; operation_id: string|null; issue_fragment_id: string|null;
  layer_movement_id: string|null; layer_id: string|null; lot_id: string|null;
  unit_cost_minor?: string|null; value_minor?: string|null; currency?: string; exponent?: number };
export type IssuedWzDetail = { document: IssuedWzHeader; rows: IssuedWzRow[]; snapshot_at: string };
