/** API key rotation and last use (API-001), migration 237. The core api_keys row is never extended: lineage
 * and last use live in auth237_api_key_state. Rotation issues a new secret with the same name, scopes (also
 * the CRM scopes of 218) and lifetime, owned by the administrator who received the secret. The old key is
 * revoked at once by default; an explicit overlap of up to one hour only shortens its expiry, so every
 * credential check that already reads revoked_at/expires_at refuses it afterwards. */
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from './db';
import { ensure } from './errors';
import { tokenHash } from './security';
import { authTx, lockAdmin } from './workspace-routes';
import { audit } from './domain';

const rotateInput = z.strictObject({ overlap_seconds: z.number().int().min(0).max(3600).default(0) });
const idParams = z.object({ id: z.uuid() });

/** Stamps the last use at most once a minute per key: a fresh stamp updates and inserts nothing (no row
 * version, no row lock), so steady traffic costs one indexed read, not a write per request. */
export async function touchApiKey(key: { api_key_id: string; tenant_id: string }, ip?: string): Promise<void> {
  await pool.query(
    `WITH u AS (UPDATE auth237_api_key_state SET last_used_at=clock_timestamp(),last_used_ip=$3
      WHERE key_id=$1 AND (last_used_at IS NULL OR last_used_at<clock_timestamp()-interval '60 seconds') RETURNING 1)
    INSERT INTO auth237_api_key_state(key_id,tenant_id,last_used_at,last_used_ip)
    SELECT $1,$2,clock_timestamp(),$3 WHERE NOT EXISTS(SELECT FROM auth237_api_key_state WHERE key_id=$1)
    ON CONFLICT(key_id) DO NOTHING`,
    [key.api_key_id, key.tenant_id, ip ? ip.slice(0, 64) : null],
  );
}

export function registerApiKeyRotationRoutes(app: FastifyInstance, options: { crmKeyScopes: boolean }): void {
  app.get('/api/developer/keys/state', async (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
    const data = (
      await pool.query(
        'SELECT key_id,rotated_from_id,rotated_at,last_used_at,last_used_ip FROM auth237_api_key_state WHERE tenant_id=$1',
        [req.actor.tenantId],
      )
    ).rows;
    return { data };
  });
  app.post('/api/developer/keys/:id/rotate', async (req, reply) => {
    const { id: oldId } = idParams.parse(req.params);
    const { overlap_seconds } = rotateInput.parse(req.body ?? {});
    const token = 'dyna_api_' + randomBytes(32).toString('hex'),
      id = randomUUID();
    const row = await authTx(async (c) => {
      await lockAdmin(c, req.actor);
      const old = (
        await c.query(
          'SELECT id,name,scopes,created_at,expires_at,revoked_at,expires_at>now() AS active FROM api_keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [req.actor.tenantId, oldId],
        )
      ).rows[0];
      ensure(old, 404, 'Nie znaleziono klucza API');
      ensure(!old.revoked_at && old.active, 409, 'Unieważnionego ani wygasłego klucza API nie można rotować');
      const successor = (await c.query('SELECT key_id FROM auth237_api_key_state WHERE rotated_from_id=$1', [oldId])).rows[0];
      ensure(!successor, 409, 'Ten klucz API został już zrotowany. Rotuj jego następcę.');
      if (overlap_seconds > 0) {
        const active = Number(
          (await c.query('SELECT count(*) FROM api_keys WHERE tenant_id=$1 AND revoked_at IS NULL AND expires_at>now()', [req.actor.tenantId]))
            .rows[0].count,
        );
        ensure(active < 20, 409, 'Organizacja może mieć maksymalnie 20 aktywnych kluczy API. Rotuj bez okresu przejściowego.');
      }
      const crm: string[] = options.crmKeyScopes
        ? (
            await c.query('SELECT scope FROM base_wire218_key_scopes WHERE tenant_id=$1 AND key_id=$2 ORDER BY scope', [req.actor.tenantId, oldId])
          ).rows.map((r: { scope: string }) => r.scope)
        : [];
      const days = Math.min(90, Math.max(1, Math.round((Date.parse(old.expires_at) - Date.parse(old.created_at)) / 86400000)));
      const created = (
        await c.query(
          'INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+make_interval(days=>$8)) RETURNING id,name,prefix,scopes,expires_at',
          [id, req.actor.tenantId, req.actor.userId, old.name, tokenHash(token), token.slice(0, 16), old.scopes, days],
        )
      ).rows[0];
      if (crm.length)
        await c.query('INSERT INTO base_wire218_key_scopes(tenant_id,key_id,scope) SELECT $1,$2,unnest($3::text[])', [req.actor.tenantId, id, crm]);
      const previous = (
        await c.query(
          overlap_seconds > 0
            ? 'UPDATE api_keys SET expires_at=least(expires_at,now()+make_interval(secs=>$3)) WHERE tenant_id=$1 AND id=$2 RETURNING expires_at AS valid_until'
            : 'UPDATE api_keys SET revoked_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING revoked_at AS valid_until',
          overlap_seconds > 0 ? [req.actor.tenantId, oldId, overlap_seconds] : [req.actor.tenantId, oldId],
        )
      ).rows[0];
      await c.query(
        'INSERT INTO auth237_api_key_state(key_id,tenant_id,rotated_from_id,rotated_by,rotated_at) VALUES($1,$2,$3,$4,now())',
        [id, req.actor.tenantId, oldId, req.actor.userId],
      );
      await audit(c, req.actor, 'api_key.rotated', id, {
        rotated_from: oldId,
        overlap_seconds,
        previous_valid_until: previous.valid_until,
        scopes: [...created.scopes, ...crm],
        expires_days: days,
      });
      return { ...created, scopes: [...created.scopes, ...crm], rotated_from_id: oldId, previous_valid_until: previous.valid_until };
    });
    return reply.code(201).send({ ...row, token });
  });
}
