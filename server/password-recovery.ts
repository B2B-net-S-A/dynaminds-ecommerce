import { createHmac, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localConfig } from './db';
import { authTx } from './workspace-routes';
import { accountRow, consumeFactor, unlockExpired } from './account-security';
import { encrypt, tokenHash } from './security';
import { ensure, Problem } from './errors';
import { audit } from './domain';
import { recordPasswordReset } from './login-history';

const derive = promisify(scrypt);
const resetToken = z.string().regex(/^[a-f0-9]{64}$/);
const resetInput = z
  .object({
    token: resetToken,
    password: z.string().min(12).max(200),
    confirm_password: z.string().min(12).max(200),
    code: z.string().max(80).optional(),
  })
  .strict()
  .refine((v) => v.password === v.confirm_password, {
    message: 'Hasła muszą być identyczne',
    path: ['confirm_password'],
  });
const response = {
  message: 'Jeśli konto istnieje, przygotowaliśmy wiadomość z instrukcją odzyskania hasła.',
  delivery: 'local_mailbox',
};
const invalidLink = () =>
  new Problem(401, 'Link odzyskiwania jest nieważny lub wygasł. Poproś o nowy link.');
const rateHash = (email: string) =>
  createHmac('sha256', Buffer.from(localConfig.encryptionKey, 'hex'))
    .update('dyna-password-reset-rate:' + email)
    .digest('hex');

export function registerPasswordRecoveryRoutes(app: FastifyInstance, available: boolean) {
  app.post(
    '/api/auth/password/request',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      ensure(available, 404, 'Odzyskiwanie hasła nie jest dostępne w tym schemacie');
      reply.header('Cache-Control', 'no-store');
      const { email } = z
        .object({
          email: z
            .string()
            .trim()
            .max(254)
            .pipe(z.email())
            .transform((v) => v.toLowerCase()),
        })
        .strict()
        .parse(req.body);
      const started = performance.now();
      // Same public response and minimum response time for unknown, throttled and known users.
      await authTx(async (c) => {
        // Bounded retention, including addresses which never existed. No tenant SQL access.
        for (const table of [
          'account_reset_limits',
          'account_password_resets',
          'account_local_mail',
        ]) {
          const expired =
            table === 'account_reset_limits'
              ? "last_request<now()-interval '1 day'"
              : 'expires_at<=now()';
          await c.query(
            `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${expired} LIMIT 100 FOR UPDATE SKIP LOCKED)`,
          );
        }
      });
      await authTx(async (c) => {
        const allowed = await c.query(
          `INSERT INTO account_reset_limits(email_hash) VALUES($1)
        ON CONFLICT(email_hash) DO UPDATE SET
          window_start=CASE WHEN account_reset_limits.window_start<=now()-interval '1 hour' THEN now() ELSE account_reset_limits.window_start END,
          requests=CASE WHEN account_reset_limits.window_start<=now()-interval '1 hour' THEN 1 ELSE account_reset_limits.requests+1 END,
          last_request=now()
        WHERE account_reset_limits.last_request<=now()-interval '1 minute'
          AND (account_reset_limits.window_start<=now()-interval '1 hour' OR account_reset_limits.requests<5)
        RETURNING email_hash`,
          [rateHash(email)],
        );
        if (!allowed.rowCount) return;
        const user = (
          await c.query('SELECT * FROM users WHERE email=$1 FOR NO KEY UPDATE', [email])
        ).rows[0];
        if (!user) return;
        const version =
          (await c.query('SELECT version FROM account_security WHERE user_id=$1', [user.id]))
            .rows[0]?.version ?? 0;
        const token = randomBytes(32).toString('hex');
        const row = (
          await c.query(
            `INSERT INTO account_password_resets(user_id,token_hash,password_fingerprint,account_version,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '15 minutes') ON CONFLICT(user_id) DO UPDATE SET
        token_hash=excluded.token_hash,password_fingerprint=excluded.password_fingerprint,account_version=excluded.account_version,
        database_name=current_database(),created_at=now(),expires_at=excluded.expires_at RETURNING expires_at`,
            [user.id, tokenHash(token), tokenHash(user.password_hash), version],
          )
        ).rows[0];
        await c.query("DELETE FROM account_local_mail WHERE user_id=$1 AND kind='password_reset'", [
          user.id,
        ]);
        await c.query(
          `INSERT INTO account_local_mail(user_id,kind,body_encrypted,expires_at) VALUES($1,'password_reset',$2,$3)`,
          [
            user.id,
            encrypt({
              to: user.email,
              subject: 'DYNAMINDS Ecommerce — odzyskanie hasła',
              text: 'Link jest ważny przez 15 minut i działa raz. Jeśli masz MFA, potrzebny będzie również kod. Jeśli nie prosisz o zmianę, zignoruj wiadomość.',
              // A fixed local origin; never construct this from Host, Origin, redirect or client input.
              url: 'http://127.0.0.1:5173/#password-reset=' + token,
            }),
            row.expires_at,
          ],
        );
      });
      await setTimeout(Math.max(0, 300 - (performance.now() - started)));
      return reply.code(202).send(response);
    },
  );
  app.post(
    '/api/auth/password/reset',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      ensure(available, 404, 'Odzyskiwanie hasła nie jest dostępne w tym schemacie');
      reply.header('Cache-Control', 'no-store');
      const input = resetInput.parse(req.body);
      const salt = randomBytes(16).toString('hex');
      const digest = ((await derive(input.password, salt, 64)) as Buffer).toString('hex');
      const result = await authTx(async (c) => {
        const found = (
          await c.query('SELECT user_id FROM account_password_resets WHERE token_hash=$1', [
            tokenHash(input.token),
          ])
        ).rows[0];
        if (!found) return invalidLink();
        // All account operations lock users first. Read again after obtaining the user lock.
        const user = (
          await c.query('SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE', [found.user_id])
        ).rows[0];
        if (!user) return invalidLink();
        const row = await accountRow(c, user.id);
        const reset = (
          await c.query(
            `SELECT * FROM account_password_resets WHERE user_id=$1 AND token_hash=$2
        AND expires_at>clock_timestamp() AND database_name=current_database() FOR UPDATE`,
            [user.id, tokenHash(input.token)],
          )
        ).rows[0];
        if (
          !reset ||
          String(reset.account_version) !== String(row.version) ||
          reset.password_fingerprint !== tokenHash(user.password_hash)
        )
          return invalidLink();
        if (row.secret_encrypted) {
          if (!input.code) return { mfa_required: true };
          const locked = await unlockExpired(c, row);
          if (locked) return locked;
          const verified = await consumeFactor(c, row, input.code);
          if (verified instanceof Problem) return verified;
        }
        await c.query('UPDATE users SET password_hash=$2 WHERE id=$1', [
          user.id,
          `${salt}:${digest}`,
        ]);
        await c.query(
          `UPDATE account_security SET version=version+1,pending_encrypted=NULL,pending_session_hash=NULL,
        pending_expires_at=NULL,failures=0,locked_until=NULL WHERE user_id=$1`,
          [user.id],
        );
        await c.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
        await c.query('DELETE FROM account_password_resets WHERE user_id=$1', [user.id]);
        await c.query("DELETE FROM account_local_mail WHERE user_id=$1 AND kind='password_reset'", [
          user.id,
        ]);
        // 237: the reset is in the login history and clears the failed-password lock of this login.
        await recordPasswordReset(c, req, user);
        await c.query(
          `INSERT INTO account_local_mail(user_id,kind,body_encrypted,expires_at) VALUES($1,'password_changed',$2,now()+interval '7 days')`,
          [
            user.id,
            encrypt({
              to: user.email,
              subject: 'DYNAMINDS Ecommerce — hasło zostało zmienione',
              text: 'Hasło zmieniono przez odzyskiwanie konta. Wszystkie sesje zostały zakończone. MFA pozostaje aktywne, jeśli było włączone. Zaloguj się ponownie.',
            }),
          ],
        );
        const memberships = (
          await c.query(
            'SELECT tenant_id,role FROM memberships WHERE user_id=$1 ORDER BY tenant_id',
            [user.id],
          )
        ).rows;
        for (const m of memberships)
          await audit(
            c,
            { tenantId: m.tenant_id, userId: user.id, role: m.role },
            'account.password_reset',
            user.id,
            {
              sessions_revoked: true,
              mfa_preserved: Boolean(row.secret_encrypted),
              delivery: 'local_mailbox',
            },
          );
        return { ok: true, sessions_revoked: true };
      });
      if (result instanceof Problem) throw result;
      // No automatic login or MFA reset. An existing browser session is now invalid as well.
      return result;
    },
  );
}
