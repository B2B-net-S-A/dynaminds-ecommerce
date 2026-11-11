import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from './db';
import { authTx, lockAdmin, newSession, sessionCookie } from './workspace-routes';
import {
  ownedSession,
  accountRow,
  unlockExpired,
  attemptFailure,
  consumeFactor,
} from './account-security';
import { checkPassword } from './security';
import { ensure, Problem } from './errors';
import { audit } from './domain';
import { accountantAvailable, accountantColumn, displayRole } from './accountant';

const body = z.strictObject({
  require_mfa: z.boolean(),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  password: z.string().min(1).max(200),
  code: z.string().max(80).optional(),
});
export function registerWorkspaceSecurityRoutes(app: FastifyInstance, cookieName: string) {
  app.get('/api/workspaces/security', async (req) => {
    const policy = (
      await pool.query(
        'SELECT require_mfa,version,updated_at FROM workspace_security_policies WHERE tenant_id=$1',
        [req.actor.tenantId],
      )
    ).rows[0] ?? { require_mfa: false, version: 0, updated_at: null };
    const accountants = req.actor.role === 'admin' && (await accountantAvailable(pool));
    const members =
      req.actor.role === 'admin'
        ? (
            await pool.query(
              `SELECT u.id,u.name,u.email,m.role${accountantColumn(accountants)},a.enabled_at IS NOT NULL AS mfa_enabled
      FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN account_security a ON a.user_id=u.id
      WHERE m.tenant_id=$1 ORDER BY u.name,u.id`,
              [req.actor.tenantId],
            )
          ).rows.map(({ accountant, ...m }) => ({ ...m, role: displayRole(m.role, accountant) }))
        : undefined;
    return {
      ...policy,
      version: Number(policy.version),
      ...(members ? { members } : {}),
      scope: 'workspace_human_sessions_and_api_key_owner_enrollment',
    };
  });
  app.patch(
    '/api/workspaces/security',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = body.parse(req.body);
      const result = await authTx(async (c) => {
        const { user, session, actor } = await ownedSession(c, req, cookieName);
        await lockAdmin(c, actor);
        const prior = (
          await c.query(
            'SELECT require_mfa,version FROM workspace_security_policies WHERE tenant_id=$1',
            [actor.tenantId],
          )
        ).rows[0] ?? { require_mfa: false, version: 0 };
        ensure(
          Number(prior.version) === input.version,
          409,
          'Polityka zmieniła się. Odśwież panel przed potwierdzeniem.',
        );
        const row = await accountRow(c, user.id);
        ensure(
          row.secret_encrypted,
          409,
          'Administrator musi najpierw włączyć MFA na własnym koncie.',
        );
        const locked = await unlockExpired(c, row);
        if (locked) return locked;
        if (!checkPassword(input.password, user.password_hash)) return attemptFailure(c, row);
        const factor = await consumeFactor(c, row, input.code ?? '');
        if (factor instanceof Problem) return factor;
        const policy = (
          await c.query(
            `INSERT INTO workspace_security_policies(tenant_id,require_mfa,version,changed_by) VALUES($1,$2,1,$3)
        ON CONFLICT(tenant_id) DO UPDATE SET require_mfa=excluded.require_mfa,version=workspace_security_policies.version+1,changed_by=excluded.changed_by,updated_at=now()
        RETURNING require_mfa,version,updated_at`,
            [actor.tenantId, input.require_mfa, user.id],
          )
        ).rows[0];
        const token = req.cookies[cookieName] ?? req.headers.authorization?.slice(7) ?? '';
        const signed = await newSession(c, user.id, session.tenant_id, token, true);
        await audit(c, actor, 'workspace.mfa_policy_changed', actor.tenantId, {
          from: prior.require_mfa,
          to: input.require_mfa,
          version: Number(policy.version),
          method: factor.method,
        });
        return { ...signed, policy: { ...policy, version: Number(policy.version) } };
      });
      if (result instanceof Problem) throw result;
      sessionCookie(reply, result.token, cookieName);
      return { user: result.user, policy: result.policy };
    },
  );
}
