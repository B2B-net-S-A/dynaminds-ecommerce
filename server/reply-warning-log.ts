/** Release processes run Fastify without a request log (logging:false: no request lines, no URLs).
 * A second reply of one request must still be visible (load run full-20261029-02 died on one that nothing
 * had logged): this sink keeps Fastify silent except the reply warnings below. Each is counted (reported in
 * /api/health) and written as one internal JSON line to stderr with its code, the method and the path
 * without query (requestLogUrl redactions), never the message, body or headers. */
import type { FastifyBaseLogger, FastifyServerOptions } from 'fastify';
import { requestLogUrl } from './request-log';

export const REPLY_WARNING_CODES = [
  // reply.send on a request whose response has ended (Fastify reply.js "did you forget to return reply").
  'FST_ERR_REP_ALREADY_SENT',
  // A second reply that reached writeHead (Fastify safeWriteHead, before it throws ERR_HTTP_HEADERS_SENT).
  'ERR_HTTP_HEADERS_SENT',
  // An async handler rejected after its reply was sent (Fastify wrap-thenable).
  'FST_REPLY_SENT_PROMISE_ERROR',
  // A request hook failed after its continuation (ordinary-request-lifetime.ts lateFailure).
  'ORDINARY_LATE_HOOK_FAILURE',
] as const;
export type ReplyWarningCode = (typeof REPLY_WARNING_CODES)[number];
export type ReplyWarningCounts = Record<ReplyWarningCode, number>;

const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
function classify(args: unknown[]): { code: ReplyWarningCode; cause?: string } | undefined {
  const [first, second] = args;
  const fields = first !== null && typeof first === 'object' ? (first as { code?: unknown; err?: { code?: unknown } }) : undefined;
  const message = typeof first === 'string' ? first : typeof second === 'string' ? second : '';
  const errCode = fields?.err?.code;
  if (fields?.code === 'ORDINARY_LATE_HOOK_FAILURE')
    return { code: 'ORDINARY_LATE_HOOK_FAILURE', ...(typeof errCode === 'string' && CODE.test(errCode) ? { cause: errCode } : {}) };
  if (errCode === 'FST_ERR_REP_ALREADY_SENT') return { code: 'FST_ERR_REP_ALREADY_SENT' };
  if (message.startsWith('Reply was already sent')) return { code: 'ERR_HTTP_HEADERS_SENT' };
  if (message.startsWith('Promise errored, but reply.sent = true')) return { code: 'FST_REPLY_SENT_PROMISE_ERROR' };
  return undefined;
}

export type ReplyWarningLog = Readonly<{
  loggerInstance: FastifyBaseLogger;
  childLoggerFactory: NonNullable<FastifyServerOptions['childLoggerFactory']>;
  counts: () => ReplyWarningCounts;
}>;

export function createReplyWarningLog(write: (line: string) => void = line => { process.stderr.write(line); }): ReplyWarningLog {
  const counts = Object.fromEntries(REPLY_WARNING_CODES.map(c => [c, 0])) as ReplyWarningCounts;
  const make = (method: string | undefined, path: string | undefined, silent: boolean): FastifyBaseLogger => {
    const note = (...args: unknown[]) => {
      const found = classify(args);
      if (!found) return;
      counts[found.code]++;
      if (silent) return;
      // Diagnostics must never become the failure: a closed stderr only loses the line.
      try {
        write(JSON.stringify({ status: 'ORDINARY_HTTP_REPLY_WARNING', ...found, ...(method ? { method } : {}), ...(path ? { path } : {}) }) + '\n');
      } catch { /* the count above stays */ }
    };
    const noop = () => {};
    return {
      level: silent ? 'silent' : 'warn',
      fatal: noop, error: note, warn: note, info: noop, debug: noop, trace: noop, silent: noop,
      child: (_bindings: unknown, options?: { level?: string }) => make(method, path, silent || options?.level === 'silent'),
    } as unknown as FastifyBaseLogger;
  };
  return Object.freeze({
    loggerInstance: make(undefined, undefined, false),
    childLoggerFactory: (_logger, _bindings, options, rawRequest) =>
      make(rawRequest.method, rawRequest.url === undefined ? undefined : requestLogUrl(rawRequest.url).split('?')[0], options?.level === 'silent'),
    counts: () => ({ ...counts }),
  });
}
