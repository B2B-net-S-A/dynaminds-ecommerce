/** PostgreSQL 57014 (query_canceled): statement_timeout or a cancel request (pg_cancel_backend).
 * The statement's transaction has rolled back, so the client may retry. The response
 * carries only a Polish hint; message and PL/pgSQL context stay in the server log. */
export type StatementCancelResponse = {
  status: 503;
  reason: 'statement_timeout' | 'cancel_request';
  detail: string;
};

export function statementCancelResponse(err: unknown): StatementCancelResponse | null {
  try {
    if (!err || typeof err !== 'object' || (err as { code?: unknown }).code !== '57014') return null;
    const message = String((err as { message?: unknown }).message ?? '');
    return /due to user request/.test(message)
      ? { status: 503, reason: 'cancel_request', detail: 'Operacja została przerwana na serwerze. Spróbuj ponownie za chwilę.' }
      : { status: 503, reason: 'statement_timeout', detail: 'Operacja trwała zbyt długo. Spróbuj ponownie za chwilę.' };
  } catch {
    return null;
  }
}
