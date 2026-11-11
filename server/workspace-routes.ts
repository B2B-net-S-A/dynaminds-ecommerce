import { bootstrapCrmTenantInOwnerTx } from './crm-bootstrap';
import { workspaceMfaAvailable, mfaSessionColumns, mfaSessionJoins } from './mfa-policy';
import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from './db';
import { ensure } from './errors';
import { tokenHash } from './security';
import { audit, type Actor } from './domain';
import { accountantAvailable, accountantColumn, displayRole, membershipRole, setAccountantGrantInTx, workspaceRole } from './accountant';
import { automationEditorColumn, automationEditorsAvailable, setAutomationEditorInTx } from './automation-editors';

const derive = promisify(scrypt);
const email = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());
const name = z.string().trim().min(2).max(100);
const role = workspaceRole;
const resourceLabel: Record<string, string> = {
  products: 'produkty',
  orders: 'zamówienia',
  channels: 'połączenia',
  warehouses: 'magazyny',
  memberships: 'miejsca w zespole',
};
const invitationToken = z.string().regex(/^[a-f0-9]{64}$/);
const organization = z.object({
  name,
  currency: z.enum(['PLN', 'EUR', 'USD', 'GBP', 'CZK']).default('PLN'),
  locale: z.enum(['pl-PL', 'en-GB', 'de-DE', 'cs-CZ']).default('pl-PL'),
});
const sessionToken = (req: FastifyRequest, cookieName = 'dyna_session') =>
  req.cookies[cookieName] ?? req.headers.authorization?.slice(7) ?? '';
export async function authTx<T>(fn: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='8s'");
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
/** Secure session cookie (SR4-M5) when this request came over TLS to this process or the installation
 * declares an https public origin (DYNA_PUBLIC_ORIGIN, e.g. behind a TLS-terminating proxy). Plain
 * local http keeps working; X-Forwarded-Proto is not trusted (no trustProxy). */
export function secureSessionCookie(reply: FastifyReply, env: NodeJS.ProcessEnv = process.env): boolean {
  return reply.request.protocol === 'https' || /^https:\/\//i.test(env.DYNA_PUBLIC_ORIGIN?.trim() ?? '');
}
export function sessionCookie(reply: FastifyReply, token: string, cookieName = 'dyna_session') {
  reply.setCookie(cookieName, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: secureSessionCookie(reply),
    maxAge: 8 * 3600,
  });
}
export async function newSession(
  c: PoolClient,
  userId: string,
  tenantId: string,
  oldToken?: string,
  mfaVerified = false,
) {
  const policyAvailable = await workspaceMfaAvailable(c);
  let inheritedProof: Date | null = null;
  const token = randomBytes(32).toString('hex');
  if (oldToken) {
    const rotated = await c.query(
      `DELETE FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() RETURNING user_id${policyAvailable ? ',mfa_verified_at' : ''}`,
      [tokenHash(oldToken), userId],
    );
    ensure(rotated.rowCount, 401, 'Sesja została już zmieniona lub wygasła');
    inheritedProof = rotated.rows[0].mfa_verified_at ?? null;
  }
  const securityAvailable = (await c.query("SELECT to_regclass('public.account_security') present"))
    .rows[0].present;
  const version = securityAvailable
    ? ((await c.query('SELECT version FROM account_security WHERE user_id=$1', [userId])).rows[0]
        ?.version ?? 0)
    : 0;
  await c.query(
    policyAvailable
      ? "INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at,account_version,mfa_verified_at) VALUES($1,$2,$3,now()+interval '8 hours',$4,CASE WHEN $5 THEN now() ELSE $6::timestamptz END)"
      : securityAvailable
        ? "INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at,account_version) VALUES($1,$2,$3,now()+interval '8 hours',$4)"
        : "INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",
    policyAvailable
      ? [tokenHash(token), userId, tenantId, version, mfaVerified, inheritedProof]
      : securityAvailable
        ? [tokenHash(token), userId, tenantId, version]
        : [tokenHash(token), userId, tenantId],
  );
  const accountants = await accountantAvailable(c);
  const editors = await automationEditorsAvailable(c);
  const user = (
    await c.query(
      `SELECT u.id,u.name,u.email,t.id AS tenant_id,t.name AS tenant_name,t.plan,t.locale,t.currency,m.role${accountantColumn(accountants)}${automationEditorColumn(editors)}${policyAvailable ? mfaSessionColumns : ''}
     FROM users u JOIN memberships m ON m.user_id=u.id JOIN tenants t ON t.id=m.tenant_id
     ${policyAvailable ? 'JOIN sessions s ON s.token_hash=$3 LEFT JOIN account_security a ON a.user_id=u.id ' + mfaSessionJoins : ''}
     WHERE u.id=$1 AND t.id=$2`,
      policyAvailable ? [userId, tenantId, tokenHash(token)] : [userId, tenantId],
    )
  ).rows[0];
  ensure(user, 403, 'Brak dostępu do organizacji');
  return { token, user: { ...user, accountant: user.accountant === true, automation_editor: user.automation_editor === true } };
}
export async function lockAdmin(c: PoolClient, actor: Actor) {
  await c.query('SELECT id FROM tenants WHERE id=$1 FOR NO KEY UPDATE', [actor.tenantId]);
  const membership = (
    await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
      actor.tenantId,
      actor.userId,
    ])
  ).rows[0];
  ensure(membership?.role === 'admin', 403, 'Wymagana aktualna rola administratora');
}
export async function workspaceUsage(c: PoolClient, tenantId: string, at?: Date) {
  const tenant = (
    await c.query(
      'SELECT t.*,p.name AS plan_name,p.limits FROM tenants t JOIN service_plans p ON p.code=t.plan WHERE t.id=$1',
      [tenantId],
    )
  ).rows[0];
  const rows = (
    await c.query(
      `SELECT resource,used::int FROM workspace_usage WHERE tenant_id=$1 AND
    period=CASE WHEN resource='orders' THEN date_trunc('month',coalesce($2::timestamptz,now()) AT TIME ZONE 'UTC')::date ELSE '2000-01-01'::date END`,
      [tenantId, at ?? null],
    )
  ).rows;
  const pending = Number(
    (
      await c.query(
        "SELECT count(*) FROM workspace_invitations WHERE tenant_id=$1 AND status='pending' AND expires_at>coalesce($2::timestamptz,now())",
        [tenantId, at ?? null],
      )
    ).rows[0].count,
  );
  return {
    tenant,
    usage: Object.fromEntries(
      Object.keys(tenant.limits).map((r) => [r, rows.find((x) => x.resource === r)?.used ?? 0]),
    ),
    pending_invitations: pending,
  };
}
async function createOrganization(
  c: PoolClient,
  userId: string,
  input: z.infer<typeof organization>,
) {
  // Serialize organization creation by this account. Invitations may grant additional admin roles.
  await c.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [userId]);
  const count = Number(
    (await c.query("SELECT count(*) FROM memberships WHERE user_id=$1 AND role='admin'", [userId]))
      .rows[0].count,
  );
  ensure(count < 20, 409, 'Konto administruje już 20 organizacjami. Nie można utworzyć kolejnej.');
  const id = randomUUID();
  await c.query("INSERT INTO tenants(id,name,plan,currency,locale) VALUES($1,$2,'starter',$3,$4)", [
    id,
    input.name,
    input.currency,
    input.locale,
  ]);
  await bootstrapCrmTenantInOwnerTx(c, id);
  await c.query("INSERT INTO memberships VALUES($1,$2,'admin')", [userId, id]);
  await c.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Magazyn główny','MAIN')",
    [randomUUID(), id],
  );
  await audit(c, { userId, tenantId: id, role: 'admin' }, 'workspace.created', id, {
    plan: 'starter',
  });
  return id;
}
async function acceptInvitation(c: PoolClient, token: string, userId: string, userEmail: string) {
  // Discover only the scope, then take the same tenant-first lock used by invitation/member edits.
  const scope = (
    await c.query('SELECT tenant_id FROM workspace_invitations WHERE token_hash=$1', [
      tokenHash(token),
    ])
  ).rows[0];
  ensure(scope, 409, 'Zaproszenie jest nieważne, wygasło lub zostało wykorzystane');
  await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [scope.tenant_id]);
  const invite = (
    await c.query(
      "SELECT * FROM workspace_invitations WHERE token_hash=$1 AND status='pending' AND expires_at>now() FOR UPDATE",
      [tokenHash(token)],
    )
  ).rows[0];
  ensure(invite, 409, 'Zaproszenie jest nieważne, wygasło lub zostało wykorzystane');
  ensure(invite.email === userEmail, 403, 'Zaproszenie jest przeznaczone dla innego adresu email');
  ensure(
    !(
      await c.query('SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
        invite.tenant_id,
        userId,
      ])
    ).rowCount,
    409,
    'Konto należy już do tej organizacji',
  );
  // Release this reserved seat before converting it to membership, inside one transaction.
  await c.query("UPDATE workspace_invitations SET status='accepted',accepted_by=$2 WHERE id=$1", [
    invite.id,
    userId,
  ]);
  await c.query('INSERT INTO memberships VALUES($1,$2,$3)', [
    userId,
    invite.tenant_id,
    invite.role,
  ]);
  const accountant =
    (await accountantAvailable(c)) &&
    Boolean((await c.query('SELECT 1 FROM accountant266_invitations WHERE invitation_id=$1', [invite.id])).rowCount);
  if (accountant) await setAccountantGrantInTx(c, invite.tenant_id, userId, true, invite.invited_by);
  await audit(
    c,
    { tenantId: invite.tenant_id, userId, role: invite.role },
    'workspace.invitation_accepted',
    invite.id,
    { role: displayRole(invite.role, accountant) },
  );
  return invite.tenant_id as string;
}
export async function loginWorkspaceInTransaction(
  c: PoolClient,
  user: { id: string; name: string; email: string },
  invitation?: string,
  readOnly = false,
  mfaVerified = false,
) {
  ensure(!readOnly || !invitation, 423, 'Zaproszenia są wyłączone w podglądzie kopii');
  await c.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [user.id]);
  if (invitation) {
    const tenantId = await acceptInvitation(c, invitation, user.id, user.email);
    return newSession(c, user.id, tenantId, undefined, mfaVerified);
  }
  // Accounts survive membership removal. Serialize empty-account onboarding so parallel logins
  // create one private Starter organization and never restore revoked access to another firm.
  const first = (
    await c.query(
      'SELECT m.tenant_id FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 ORDER BY t.created_at,t.id LIMIT 1',
      [user.id],
    )
  ).rows[0];
  ensure(
    !readOnly || first,
    423,
    'Konto nie ma organizacji w tej kopii; tworzenie organizacji jest wyłączone',
  );
  const tenantId =
    first?.tenant_id ??
    (await createOrganization(c, user.id, {
      name: (user.name + ' — organizacja').slice(0, 100),
      currency: 'PLN',
      locale: 'pl-PL',
    }));
  return newSession(c, user.id, tenantId, undefined, mfaVerified);
}
export async function loginWorkspace(
  user: { id: string; name: string; email: string },
  invitation?: string,
  readOnly = false,
) {
  return authTx((c) => loginWorkspaceInTransaction(c, user, invitation, readOnly));
}
export function registerWorkspaceRoutes(
  app: FastifyInstance,
  cookieName = 'dyna_session',
  billingAvailable = false,
) {
  app.post(
    '/api/auth/signup',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = z
        .object({
          email,
          name,
          password: z.string().min(12).max(200),
          organization: organization.optional(),
          invitation_token: invitationToken.optional(),
        })
        .parse(req.body);
      ensure(
        Boolean(input.organization) !== Boolean(input.invitation_token),
        422,
        'Podaj organizację albo zaproszenie',
      );
      const salt = randomBytes(16).toString('hex');
      const digest = ((await derive(input.password, salt, 64)) as Buffer).toString('hex');
      const result = await authTx(async (c) => {
        const id = randomUUID();
        const created = await c.query(
          'INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
          [id, input.email, input.name, `${salt}:${digest}`],
        );
        ensure(
          created.rowCount,
          409,
          'Nie można utworzyć konta z tym adresem. Spróbuj się zalogować.',
        );
        const tenantId = input.invitation_token
          ? await acceptInvitation(c, input.invitation_token, id, input.email)
          : await createOrganization(c, id, input.organization!);
        return newSession(c, id, tenantId);
      });
      sessionCookie(reply, result.token, cookieName);
      return reply.code(201).send({ user: result.user });
    },
  );
  app.get('/api/workspaces', async (req) => {
    const accountants = await accountantAvailable(pool);
    const rows = (
      await pool.query(
        `SELECT t.id,t.name,t.plan,m.role${accountantColumn(accountants)} FROM memberships m JOIN tenants t ON t.id=m.tenant_id
     WHERE m.user_id=$1 ORDER BY t.created_at,t.id`,
        [req.actor.userId],
      )
    ).rows;
    return { data: rows.map(({ accountant, ...w }) => ({ ...w, role: displayRole(w.role, accountant) })) };
  });
  app.post('/api/workspaces', async (req, reply) => {
    const input = organization.parse(req.body);
    const result = await authTx(async (c) => {
      const tenantId = await createOrganization(c, req.actor.userId, input);
      return newSession(c, req.actor.userId, tenantId, sessionToken(req, cookieName));
    });
    sessionCookie(reply, result.token, cookieName);
    return reply.code(201).send({ user: result.user });
  });
  app.post('/api/workspaces/switch', async (req, reply) => {
    const input = z.object({ tenant_id: z.uuid() }).parse(req.body);
    const result = await authTx(async (c) => {
      await c.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [req.actor.userId]);
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR SHARE', [input.tenant_id]);
      ensure(
        (
          await c.query('SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
            input.tenant_id,
            req.actor.userId,
          ])
        ).rowCount,
        403,
        'Brak dostępu do organizacji',
      );
      // A concurrent replay of the previous session cannot resurrect it after rotation.
      const current = await c.query(
        'SELECT user_id FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() FOR UPDATE',
        [tokenHash(sessionToken(req, cookieName)), req.actor.userId],
      );
      ensure(current.rowCount, 401, 'Sesja wygasła');
      return newSession(c, req.actor.userId, input.tenant_id, sessionToken(req, cookieName));
    });
    sessionCookie(reply, result.token, cookieName);
    return { user: result.user };
  });
  app.get('/api/workspaces/settings', async (req) =>
    authTx(async (c) => {
      // Settings disclose organization details/usage to its members, the roster only to its admins.
      const result = await workspaceUsage(c, req.actor.tenantId);
      const plans = (await c.query("SELECT * FROM service_plans ORDER BY (limits->>'orders')::int"))
        .rows;
      const accountants = await accountantAvailable(c);
      const editors = await automationEditorsAvailable(c);
      const members =
        req.actor.role === 'admin'
          ? (
              await c.query(
                `SELECT u.id,u.name,u.email,m.role${accountantColumn(accountants)}${automationEditorColumn(editors)} FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY u.name,u.id`,
                [req.actor.tenantId],
              )
            ).rows.map(({ accountant, automation_editor, ...m }) => ({
              ...m,
              role: displayRole(m.role, accountant),
              // "Automatyzacje: edycja" (267): always for the administrator, by grant for an operator.
              automation_editor: m.role === 'admin' || automation_editor === true,
            }))
          : [];
      const invitations =
        req.actor.role === 'admin'
          ? (
              await c.query(
                `SELECT i.id,i.email,i.role,i.expires_at,i.created_at${accountants ? ',EXISTS(SELECT 1 FROM accountant266_invitations g WHERE g.invitation_id=i.id) AS accountant' : ''} FROM workspace_invitations i WHERE i.tenant_id=$1 AND i.status='pending' AND i.expires_at>now() ORDER BY i.created_at DESC`,
                [req.actor.tenantId],
              )
            ).rows.map(({ accountant, ...i }) => ({ ...i, role: displayRole(i.role, accountant) }))
          : [];
      return { ...result, plans, members, invitations, billing_available: billingAvailable };
    }),
  );
  app.patch('/api/workspaces/settings', async (req) => {
    const input = z.object({ name, locale: organization.shape.locale }).parse(req.body);
    return authTx(async (c) => {
      await lockAdmin(c, req.actor);
      await c.query('UPDATE tenants SET name=$2,locale=$3 WHERE id=$1', [
        req.actor.tenantId,
        input.name,
        input.locale,
      ]);
      await audit(c, req.actor, 'workspace.updated', req.actor.tenantId, input);
      return { ok: true };
    });
  });
  app.patch('/api/workspaces/plan', async (req) => {
    const input = z.object({ plan: z.enum(['starter', 'business', 'enterprise']) }).parse(req.body);
    return authTx(async (c) => {
      await lockAdmin(c, req.actor);
      const before = await workspaceUsage(c, req.actor.tenantId);
      const plan = (await c.query('SELECT * FROM service_plans WHERE code=$1', [input.plan]))
        .rows[0];
      for (const [resource, used] of Object.entries(before.usage)) {
        ensure(
          Number(used) + (resource === 'memberships' ? before.pending_invitations : 0) <=
            plan.limits[resource],
          409,
          `Plan ${plan.name} ma za mały limit: ${resourceLabel[resource]}`,
        );
      }
      if (billingAvailable) {
        const { legacyBillingPlanChange } = await import('./workspace-billing');
        await legacyBillingPlanChange(c, req.actor, input.plan);
      } else
        await c.query('UPDATE tenants SET plan=$2 WHERE id=$1', [req.actor.tenantId, input.plan]);
      await audit(c, req.actor, 'workspace.plan_changed', req.actor.tenantId, {
        from: before.tenant.plan,
        to: input.plan,
        billing: 'local_only',
      });
      return { ok: true, billing: 'local_only' };
    });
  });
  app.post('/api/workspaces/invitations', async (req, reply) => {
    const input = z.object({ email, role }).parse(req.body);
    const token = randomBytes(32).toString('hex');
    const id = randomUUID();
    const result = await authTx(async (c) => {
      await lockAdmin(c, req.actor);
      await c.query(
        "UPDATE workspace_invitations SET status='revoked' WHERE tenant_id=$1 AND status='pending' AND expires_at<=now()",
        [req.actor.tenantId],
      );
      ensure(
        !(
          await c.query(
            'SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND u.email=$2',
            [req.actor.tenantId, input.email],
          )
        ).rowCount,
        409,
        'Konto należy już do tej organizacji',
      );
      const state = await workspaceUsage(c, req.actor.tenantId);
      ensure(
        state.usage.memberships + state.pending_invitations < state.tenant.limits.memberships,
        409,
        'Limit miejsc w zespole został osiągnięty',
      );
      const accountant = input.role === 'accountant';
      ensure(!accountant || (await accountantAvailable(c)), 409, 'Rola Księgowa wymaga aktualizacji bazy danych (migracja 266)');
      const inserted = (
        await c.query(
          "INSERT INTO workspace_invitations(id,tenant_id,email,role,token_hash,invited_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '7 days') RETURNING id,email,role,expires_at",
          [id, req.actor.tenantId, input.email, membershipRole(input.role), tokenHash(token), req.actor.userId],
        )
      ).rows[0];
      if (accountant)
        await c.query('INSERT INTO accountant266_invitations(invitation_id,tenant_id) VALUES($1,$2)', [id, req.actor.tenantId]);
      const row = { ...inserted, role: input.role };
      await audit(c, req.actor, 'workspace.invited', id, {
        email: input.email,
        role: input.role,
        delivery: 'manual',
      });
      return row;
    });
    // Token is returned once; neither audit, roster nor database exposes its plaintext.
    return reply
      .code(201)
      .send({ ...result, token, join_path: '/#invite=' + token, delivery: 'manual' });
  });
  app.delete('/api/workspaces/invitations/:id', async (req) => {
    const id = z.object({ id: z.uuid() }).parse(req.params).id;
    return authTx(async (c) => {
      await lockAdmin(c, req.actor);
      const r = await c.query(
        "UPDATE workspace_invitations SET status='revoked' WHERE id=$1 AND tenant_id=$2 AND status='pending' RETURNING id",
        [id, req.actor.tenantId],
      );
      ensure(r.rowCount, 404, 'Zaproszenie nie istnieje');
      await audit(c, req.actor, 'workspace.invitation_revoked', id, {});
      return { ok: true };
    });
  });
  app.post('/api/workspaces/invitations/accept', async (req, reply) => {
    const input = z.object({ token: invitationToken }).parse(req.body);
    const result = await authTx(async (c) => {
      await c.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [req.actor.userId]);
      const tenantId = await acceptInvitation(
        c,
        input.token,
        req.actor.userId,
        req.currentUser.email,
      );
      return newSession(c, req.actor.userId, tenantId, sessionToken(req, cookieName));
    });
    sessionCookie(reply, result.token, cookieName);
    return { user: result.user };
  });
  const changeMember = async (req: FastifyRequest, removing: boolean) => {
    const id = z.object({ id: z.uuid() }).parse(req.params).id;
    const body = removing ? null : z.object({ role, automation_editor: z.boolean().optional() }).parse(req.body);
    const newRole = body?.role ?? null;
    ensure(
      !(body?.automation_editor === true && newRole !== 'operator'),
      422,
      'Uprawnienie „Automatyzacje: edycja” można nadać tylko magazynierowi (administrator ma je zawsze)',
    );
    return authTx(async (c) => {
      await lockAdmin(c, req.actor);
      const accountants = await accountantAvailable(c);
      const editors = await automationEditorsAvailable(c);
      const target = (
        await c.query(`SELECT m.role${accountantColumn(accountants)}${automationEditorColumn(editors)} FROM memberships m WHERE m.tenant_id=$1 AND m.user_id=$2`, [
          req.actor.tenantId,
          id,
        ])
      ).rows[0];
      ensure(target, 404, 'Użytkownik nie należy do organizacji');
      const from = displayRole(target.role, target.accountant);
      if (target.role === 'admin' && newRole !== 'admin') {
        const admins = Number(
          (
            await c.query("SELECT count(*) FROM memberships WHERE tenant_id=$1 AND role='admin'", [
              req.actor.tenantId,
            ])
          ).rows[0].count,
        );
        ensure(admins > 1, 409, 'Organizacja musi mieć co najmniej jednego administratora');
      }
      if (removing) {
        await c.query('DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
          req.actor.tenantId,
          id,
        ]);
        await c.query('DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2', [
          req.actor.tenantId,
          id,
        ]);
      } else {
        // An unchanged memberships.role writes nothing, so viewer <-> accountant keeps the member's API keys
        // (read-only either way); any other change revokes them as before (013).
        const stored = membershipRole(newRole!);
        if (stored !== target.role)
          await c.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2', [
            req.actor.tenantId,
            id,
            stored,
          ]);
        await setAccountantGrantInTx(c, req.actor.tenantId, id, newRole === 'accountant', req.actor.userId);
        // "Automatyzacje: edycja" (267) belongs to an operator; without the flag an operator keeps what they had.
        const editor = newRole === 'operator' && (body?.automation_editor ?? target.automation_editor === true);
        if (editor !== (target.automation_editor === true) || newRole !== 'operator')
          await setAutomationEditorInTx(c, req.actor.tenantId, id, editor, req.actor.userId);
      }
      await audit(
        c,
        req.actor,
        removing ? 'workspace.member_removed' : 'workspace.role_changed',
        id,
        {
          from,
          to: newRole,
          ...(body?.automation_editor !== undefined ? { automation_editor: newRole === 'operator' && body.automation_editor } : {}),
        },
      );
      return { ok: true };
    });
  };
  app.patch('/api/workspaces/members/:id', (req) => changeMember(req, false));
  app.delete('/api/workspaces/members/:id', (req) => changeMember(req, true));
}
