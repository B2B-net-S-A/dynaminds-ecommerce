/** COM-008 (migration 245): inputs of the marketplace/helpdesk inbox and its connector port.
 * No Node imports: the web inbox reads CHANNELS from here. */
import { z } from 'zod';

export const CHANNELS = ['allegro', 'ebay', 'amazon', 'helpdesk'] as const;
export type Channel = (typeof CHANNELS)[number];
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const text = (max: number) => z.string().max(max).refine((v) => !control.test(v), 'Niedozwolony znak');
const line = (max: number) => z.string().trim().max(max).refine((v) => !control.test(v) && !/[\r\n]/.test(v), 'Wymagany jeden wiersz');

export const channelConnectionInput = z.strictObject({ channel: z.enum(CHANNELS), name: line(120).min(2) });
/** The connector port: one page of messages read from the provider (or a helpdesk export), at most 50. */
export const channelIngestInput = z.strictObject({
  messages: z
    .array(
      z.strictObject({
        external_thread_id: line(200).min(1),
        external_message_id: line(200).min(1),
        body: text(4000).min(1),
        subject: line(300).default(''),
        buyer_ref: line(200).default(''),
        sent_at: z.iso.datetime({ offset: true }).nullable().default(null),
        order_number: line(100).min(1).nullable().default(null),
      }),
    )
    .min(1)
    .max(50),
});
export const channelThreadsQuery = z.strictObject({
  channel: z.enum(CHANNELS).optional(),
  status: z.enum(['open', 'closed']).optional(),
  assigned: z.enum(['me', 'none']).optional(),
  unlinked: z.literal('1').optional(),
  cursor: z.string().max(100).optional(),
});
export const channelThreadPatch = z
  .strictObject({
    version: z.number().int().min(1),
    status: z.enum(['open', 'closed']).optional(),
    assigned_user_id: z.uuid().nullable().optional(),
    order_id: z.uuid().nullable().optional(),
    order_number: line(100).min(1).optional(),
  })
  .refine((v) => v.status !== undefined || v.assigned_user_id !== undefined || v.order_id !== undefined || v.order_number !== undefined, 'Brak zmiany')
  .refine((v) => v.order_id === undefined || v.order_number === undefined, 'Podaj zamówienie jednym sposobem');
export const channelMessageInput = z.strictObject({
  kind: z.enum(['reply', 'note']),
  body: text(4000).trim().min(1),
  client_key: z.uuid(),
});
