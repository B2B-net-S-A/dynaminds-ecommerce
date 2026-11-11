import { requiredMfaOrganizations, allowMfaDisable } from './mfa-policy';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import QRCode from 'qrcode';
import { z } from 'zod';
import { Problem, ensure } from './errors';
import { checkPassword, decrypt, encrypt, hashPassword, tokenHash } from './security';
import { authTx, loginWorkspaceInTransaction, newSession, sessionCookie } from './workspace-routes';
import { audit } from './domain';
import { matchedStep, newTotpSecret, totpUri } from './totp';

const proof = z.object({
  password: z.string().min(1).max(200),
  code: z.string().max(80).optional(),
});
const options = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
const authToken = (req: FastifyRequest, cookieName: string) =>
  req.cookies[cookieName] ??
  (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '');
const normalizedRecovery = (code: string) => code.replace(/-/g, '').toUpperCase();
const recoveryHash = (userId: string, code: string) =>
  tokenHash('dyna-recovery:' + userId + ':' + normalizedRecovery(code));
function recoveryCodes(userId: string) {
  const codes = Array.from({ length: 8 }, () =>
    randomBytes(16).toString('hex').toUpperCase().match(/.{8}/g)!.join('-'),
  );
  return { codes, hashes: codes.map((code) => recoveryHash(userId, code)) };
}
export async function accountRow(c: PoolClient, id: string) {
  await c.query('INSERT INTO account_security(user_id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
  return (await c.query('SELECT * FROM account_security WHERE user_id=$1', [id])).rows[0];
}
// Returning a Problem commits the attempt counters; throwing would roll them back.
export async function attemptFailure(c: PoolClient, row: any) {
  await c.query(
    `UPDATE account_security SET failures=failures+1,
    locked_until=CASE WHEN failures+1>=5 THEN now()+interval '5 minutes' ELSE NULL END WHERE user_id=$1`,
    [row.user_id],
  );
  return new Problem(
    401,
    'Nieprawidłowe hasło lub kod. Po pięciu błędach weryfikacja jest blokowana na 5 minut.',
  );
}
export async function unlockExpired(c: PoolClient, row: any) {
  if (row.locked_until && new Date(row.locked_until).getTime() <= Date.now()) {
    await c.query('UPDATE account_security SET failures=0,locked_until=NULL WHERE user_id=$1', [
      row.user_id,
    ]);
    row.failures = 0;
    row.locked_until = null;
  }
  return row.locked_until
    ? new Problem(
        429,
        'Weryfikacja konta zablokowana na 5 minut po błędnych próbach. Spróbuj później.',
      )
    : undefined;
}
export async function consumeFactor(c: PoolClient, row: any, code: string) {
  const step = matchedStep(decrypt(row.secret_encrypted).secret, code, BigInt(row.last_step));
  if (step !== undefined) {
    await c.query(
      'UPDATE account_security SET last_step=$2,failures=0,locked_until=NULL WHERE user_id=$1',
      [row.user_id, step.toString()],
    );
    return { method: 'totp' };
  }
  if (/^[A-F0-9]{32}$/.test(normalizedRecovery(code))) {
    const digest = recoveryHash(row.user_id, code);
    if (row.recovery_hashes.includes(digest)) {
      await c.query(
        'UPDATE account_security SET recovery_hashes=$2,failures=0,locked_until=NULL WHERE user_id=$1',
        [row.user_id, JSON.stringify(row.recovery_hashes.filter((v: string) => v !== digest))],
      );
      return { method: 'recovery' };
    }
  }
  return attemptFailure(c, row);
}
export async function secureLogin(
  user: any,
  passwordHash: string,
  invitation?: string,
  code?: string,
  readOnly = false,
  // 237: records a refused second factor in the same transaction as its counter.
  onFactorRefused?: (c: PoolClient, outcome: 'mfa_failed' | 'mfa_locked') => Promise<void>,
) {
  const result = await authTx(async (c) => {
    const current = (await c.query('SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE', [user.id]))
      .rows[0];
    ensure(
      current?.password_hash === passwordHash,
      401,
      'Dane konta zmieniły się. Zaloguj się ponownie.',
    );
    const row = (await c.query('SELECT * FROM account_security WHERE user_id=$1', [user.id]))
      .rows[0];
    let method: string | undefined;
    if (row?.secret_encrypted) {
      if (!code) return { mfa_required: true };
      const locked = await unlockExpired(c, row);
      if (locked) {
        await onFactorRefused?.(c, 'mfa_locked');
        return locked;
      }
      const verified = await consumeFactor(c, row, code);
      if (verified instanceof Problem) {
        await onFactorRefused?.(c, 'mfa_failed');
        return verified;
      }
      method = verified.method;
    }
    const signed = await loginWorkspaceInTransaction(
      c,
      current,
      invitation,
      readOnly,
      Boolean(method),
    );
    if (method && !readOnly)
      await audit(
        c,
        { tenantId: signed.user.tenant_id, userId: user.id, role: signed.user.role },
        'account.mfa_login',
        user.id,
        { method },
      );
    return signed;
  });
  if (result instanceof Problem) throw result;
  return result;
}
export async function ownedSession(c: PoolClient, req: FastifyRequest, cookieName: string) {
  const user = (
    await c.query('SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE', [req.actor.userId])
  ).rows[0];
  ensure(user, 401, 'Konto nie istnieje');
  const session = (
    await c.query(
      `SELECT s.* FROM sessions s LEFT JOIN account_security a ON a.user_id=s.user_id
    WHERE s.token_hash=$1 AND s.user_id=$2 AND s.tenant_id=$3 AND s.expires_at>now()
    AND s.account_version=coalesce(a.version,0) FOR UPDATE OF s`,
      [tokenHash(authToken(req, cookieName)), user.id, req.actor.tenantId],
    )
  ).rows[0];
  ensure(session, 401, 'Sesja wygasła. Zaloguj się ponownie.');
  const membership = (
    await c.query('SELECT role FROM memberships WHERE user_id=$1 AND tenant_id=$2', [
      user.id,
      session.tenant_id,
    ])
  ).rows[0];
  ensure(membership, 403, 'Brak dostępu do organizacji');
  return { user, session, actor: { ...req.actor, role: membership.role } };
}
async function rotate(c: PoolClient, userId: string, tenantId: string, mfaVerified = false) {
  await c.query('UPDATE account_security SET version=version+1 WHERE user_id=$1', [userId]);
  await c.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
  return newSession(c, userId, tenantId, undefined, mfaVerified);
}
export function registerAccountSecurityRoutes(app: FastifyInstance, cookieName: string) {
  app.get('/api/auth/security', async (req) =>
    authTx(async (c) => {
      const { user, session } = await ownedSession(c, req, cookieName);
      const row = (
        await c.query(
          'SELECT enabled_at,pending_expires_at,recovery_hashes,version FROM account_security WHERE user_id=$1',
          [user.id],
        )
      ).rows[0];
      const sessions = (
        await c.query(
          `SELECT s.id,s.tenant_id,t.name AS tenant_name,s.created_at,s.expires_at,
      s.id=$2 AS current FROM sessions s JOIN tenants t ON t.id=s.tenant_id JOIN memberships m ON m.user_id=s.user_id AND m.tenant_id=s.tenant_id WHERE s.user_id=$1 AND s.expires_at>now() AND s.account_version=$3 ORDER BY s.created_at DESC,s.id`,
          [user.id, session.id, row?.version ?? 0],
        )
      ).rows;
      return {
        required_by_organizations: await requiredMfaOrganizations(c, user.id),
        enabled: Boolean(row?.enabled_at),
        enabled_at: row?.enabled_at ?? null,
        recovery_remaining: row?.recovery_hashes.length ?? 0,
        pending_expires_at: row?.pending_expires_at ?? null,
        sessions,
      };
    }),
  );
  app.post('/api/auth/security/verify', options, async (req, reply) => {
    const input = proof.parse(req.body);
    const result = await authTx(async (c) => {
      const { user, session, actor } = await ownedSession(c, req, cookieName);
      const row = await accountRow(c, user.id);
      ensure(row.secret_encrypted, 409, 'Najpierw skonfiguruj MFA.');
      const locked = await unlockExpired(c, row);
      if (locked) return locked;
      if (!checkPassword(input.password, user.password_hash)) return attemptFailure(c, row);
      const factor = await consumeFactor(c, row, input.code ?? '');
      if (factor instanceof Problem) return factor;
      const signed = await newSession(
        c,
        user.id,
        session.tenant_id,
        authToken(req, cookieName),
        true,
      );
      await audit(c, actor, 'account.mfa_verified', user.id, { method: factor.method });
      return signed;
    });
    if (result instanceof Problem) throw result;
    sessionCookie(reply, result.token, cookieName);
    return { user: result.user };
  });
  app.delete('/api/auth/security/sessions/:id', async (req) =>
    authTx(async (c) => {
      const { user, session, actor } = await ownedSession(c, req, cookieName);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      ensure(id !== session.id, 409, 'Bieżącą sesję zakończ przyciskiem Wyloguj.');
      const deleted = await c.query(
        'DELETE FROM sessions WHERE id=$1 AND user_id=$2 RETURNING id',
        [id, user.id],
      );
      ensure(deleted.rowCount, 404, 'Sesja nie istnieje');
      await audit(c, actor, 'account.session_revoked', user.id, {});
      return { ok: true };
    }),
  );
  app.delete('/api/auth/security/enroll', async (req) =>
    authTx(async (c) => {
      const { user, session } = await ownedSession(c, req, cookieName);
      await c.query(
        `UPDATE account_security SET pending_encrypted=NULL,pending_session_hash=NULL,pending_expires_at=NULL
      WHERE user_id=$1 AND pending_session_hash=$2`,
        [user.id, session.token_hash],
      );
      return { ok: true };
    }),
  );
  for (const action of ['enroll', 'confirm', 'disable', 'recovery', 'password'] as const) {
    app.post('/api/auth/security/' + action, options, async (req, reply) => {
      const input = (
        action === 'password' ? proof.extend({ new_password: z.string().min(12).max(200) }) : proof
      ).parse(req.body);
      // CPU-intensive password derivation is outside the row-locking transaction.
      const nextPassword =
        action === 'password' ? hashPassword((input as any).new_password) : undefined;
      const result = await authTx(async (c) => {
        const { user, session, actor } = await ownedSession(c, req, cookieName);
        const row = await accountRow(c, user.id);
        const locked = await unlockExpired(c, row);
        if (locked) return locked;
        if (!checkPassword(input.password, user.password_hash)) return attemptFailure(c, row);
        if (action === 'enroll') {
          ensure(!row.secret_encrypted, 409, 'MFA jest już włączone');
          const secret = newTotpSecret();
          const pending = (
            await c.query(
              `UPDATE account_security SET pending_encrypted=$2,pending_session_hash=$3,
            pending_expires_at=now()+interval '10 minutes',failures=0,locked_until=NULL WHERE user_id=$1 RETURNING pending_expires_at`,
              [user.id, encrypt({ secret }), session.token_hash],
            )
          ).rows[0];
          return {
            secret,
            uri: totpUri(secret, user.email),
            expires_at: pending.pending_expires_at,
          };
        }
        if (action === 'confirm') {
          ensure(!row.secret_encrypted, 409, 'MFA jest już włączone');
          ensure(
            row.pending_encrypted &&
              row.pending_session_hash === session.token_hash &&
              new Date(row.pending_expires_at).getTime() > Date.now(),
            409,
            'Konfiguracja wygasła lub pochodzi z innej sesji. Przygotuj nową.',
          );
          const step = matchedStep(decrypt(row.pending_encrypted).secret, input.code ?? '', -1n);
          if (step === undefined) return attemptFailure(c, row);
          const recovery = recoveryCodes(user.id);
          await c.query(
            `UPDATE account_security SET secret_encrypted=pending_encrypted,enabled_at=now(),last_step=$2,
            recovery_hashes=$3,pending_encrypted=NULL,pending_session_hash=NULL,pending_expires_at=NULL,failures=0,locked_until=NULL WHERE user_id=$1`,
            [user.id, step.toString(), JSON.stringify(recovery.hashes)],
          );
          const signed = await rotate(c, user.id, session.tenant_id, true);
          await audit(c, actor, 'account.mfa_enabled', user.id, { other_sessions_revoked: true });
          return { ...signed, recovery_codes: recovery.codes };
        }
        if (action === 'disable' || action === 'recovery')
          ensure(row.secret_encrypted, 409, 'MFA nie jest włączone');
        if (action === 'disable') await allowMfaDisable(c, user.id);
        if (row.secret_encrypted) {
          const verified = await consumeFactor(c, row, input.code ?? '');
          if (verified instanceof Problem) return verified;
        }
        let codes: string[] | undefined;
        if (action === 'disable')
          await c.query(
            `UPDATE account_security SET secret_encrypted=NULL,enabled_at=NULL,last_step=-1,recovery_hashes='[]',pending_encrypted=NULL,pending_session_hash=NULL,pending_expires_at=NULL,failures=0,locked_until=NULL WHERE user_id=$1`,
            [user.id],
          );
        if (action === 'recovery') {
          const recovery = recoveryCodes(user.id);
          codes = recovery.codes;
          await c.query('UPDATE account_security SET recovery_hashes=$2 WHERE user_id=$1', [
            user.id,
            JSON.stringify(recovery.hashes),
          ]);
        }
        if (action === 'password') {
          await c.query('UPDATE users SET password_hash=$2 WHERE id=$1', [user.id, nextPassword]);
          await c.query(
            'UPDATE account_security SET pending_encrypted=NULL,pending_session_hash=NULL,pending_expires_at=NULL,failures=0,locked_until=NULL WHERE user_id=$1',
            [user.id],
          );
        }
        const signed = await rotate(
          c,
          user.id,
          session.tenant_id,
          Boolean(row.secret_encrypted) && action !== 'disable',
        );
        await audit(
          c,
          actor,
          'account.' +
            (
              {
                disable: 'mfa_disabled',
                recovery: 'recovery_replaced',
                password: 'password_changed',
              } as const
            )[action],
          user.id,
          { other_sessions_revoked: true },
        );
        return { ...signed, ...(codes ? { recovery_codes: codes } : {}) };
      });
      if (result instanceof Problem) throw result;
      if ('uri' in result && typeof result.uri === 'string')
        return { ...result, qr: await QRCode.toDataURL(result.uri, { width: 240, margin: 2 }) };
      if ('token' in result) {
        sessionCookie(reply, result.token, cookieName);
        const { token, ...safe } = result;
        return safe;
      }
      return result;
    });
  }
}
