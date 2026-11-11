/** Host-only bridge validation. This module performs no IO and imports no application runtime. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validatePrintContent } from './print-job-values';

export const PRINT_BRIDGE_API_ORIGIN = 'http://127.0.0.1:4100';
export const PRINT_BRIDGE_MAX_BYTES = 2 * 1024 * 1024;
const uuid = z.uuid().transform((value) => value.toLowerCase());
const header = z.string().min(1).max(4096).regex(/^[\x20-\x7e]+$/);
export const printBridgeConfig = z.strictObject({
  tenant_id: uuid,
  printer_id: uuid,
  /** Exact new own queue job; no global FIFO traversal when selected. */
  job_id: uuid.optional(),
  api_token: header.optional(),
  cookie: header.optional(),
  local_fixture: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (Boolean(value.api_token) === Boolean(value.cookie) || (value.cookie && !value.local_fixture))
    ctx.addIssue({ code: 'custom', message: 'One authorized credential is required' });
});
export type PrintBridgeConfig = z.infer<typeof printBridgeConfig>;
export type PrintBridgeMode = 'once' | 'watch' | 'retry-ack' | 'reconcile';
export function printBridgeMode(args: string[]): PrintBridgeMode {
  if (!args.length) return 'once';
  if (args.length !== 1 || !['--once', '--watch', '--retry-ack', '--reconcile'].includes(args[0]))
    throw new Error('BRIDGE_ARGUMENTS_INVALID');
  return args[0].slice(2) as PrintBridgeMode;
}
export function printBridgeFileName(jobId: string, sha256: string, format: string) {
  const id = uuid.parse(jobId);
  if (!/^[a-f0-9]{64}$/.test(sha256) || !['pdf', 'zpl'].includes(format))
    throw new Error('BRIDGE_CONTENT_INVALID');
  return `${id}-${sha256}.${format}`;
}
export function verifyPrintBridgeBytes(
  bytes: Uint8Array,
  format: 'pdf' | 'zpl',
  sha256: string,
  expectedBytes: number,
) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > PRINT_BRIDGE_MAX_BYTES ||
      bytes.byteLength !== expectedBytes || !/^[a-f0-9]{64}$/.test(sha256) ||
      createHash('sha256').update(bytes).digest('hex') !== sha256)
    throw new Error('BRIDGE_CONTENT_INVALID');
  // The host checks exactly the same conservative printable subset as the queue.
  // This is not a full PDF parser or evidence of successful physical printing.
  validatePrintContent(Buffer.from(bytes).toString('base64'), format);
}
/** Only a configured local CUPS queue; no option, host, shell, or caller-selected filename. */
export function printBridgeCupsArgs(queue: string, copies: number, controlledFile: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(queue) ||
      !Number.isInteger(copies) || copies < 1 || copies > 10 ||
      !controlledFile.startsWith('/') || /[\r\n\0]/.test(controlledFile))
    throw new Error('BRIDGE_CUPS_CONFIG_INVALID');
  return ['-d', queue, '-n', String(copies), controlledFile];
}
export function printBridgeCupsReference(stdout: string, queue: string) {
  printBridgeCupsArgs(queue, 1, '/controlled/file');
  const match = /^request id is ([A-Za-z0-9_][A-Za-z0-9_.-]*-[1-9][0-9]*) \([1-9][0-9]* file\(s\)\)\s*$/.exec(stdout);
  if (!match || !match[1].startsWith(queue + '-') ||
      !/^[1-9][0-9]*$/.test(match[1].slice(queue.length + 1))) throw new Error('BRIDGE_CUPS_RESULT_UNKNOWN');
  return match[1];
}
export type PrintBridgeJournalState =
  'claim_intent' | 'claimed' | 'dispatch_intent' | 'ack_intent' | 'complete' | 'empty' | 'reconciled';
/** A saved claim/dispatch is never evidence that printing did not happen. */
export function printBridgeJournalDecision(state: PrintBridgeJournalState, mode: PrintBridgeMode) {
  if (mode === 'retry-ack') return state === 'ack_intent' ? 'retry_saved_ack' : 'manual_reconcile';
  if (mode === 'reconcile') return ['claim_intent','claimed','dispatch_intent','ack_intent'].includes(state)
    ? 'read_saved_job' : 'manual_reconcile';
  return state === 'complete' || state === 'empty' || state === 'reconciled' ? 'next_claim' : 'manual_reconcile';
}
/** Never render error.message/stack, response bodies, paths, tokens, cookies, or CUPS output. */
export function printBridgeSafeFailure(_error?: unknown) { return 'PRINT_BRIDGE_STOPPED_MANUAL_RECONCILIATION_REQUIRED'; }
