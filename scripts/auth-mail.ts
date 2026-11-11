// Host operator only. Never expose this mailbox through HTTP or an unauthenticated UI.
import { z } from 'zod';
import { pool } from '../server/db';
import { decrypt } from '../server/security';
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--email')
    throw new Error(
      'Użycie: npm run auth:mail -- --email <adres>. Wiadomości lokalne; bez wysyłki email.',
    );
  const email = z.email().max(254).parse(args[1].trim().toLowerCase());
  const rows = (
    await pool.query(
      `SELECT m.id,m.kind,m.created_at,m.expires_at,m.body_encrypted FROM account_local_mail m
    JOIN users u ON u.id=m.user_id WHERE u.email=$1 AND m.expires_at>now() ORDER BY m.created_at DESC,m.id LIMIT 20`,
      [email],
    )
  ).rows;
  console.log(
    JSON.stringify(
      {
        delivery: 'local_mailbox',
        messages: rows.map(({ body_encrypted, ...row }) => ({
          ...row,
          ...decrypt(body_encrypted),
        })),
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
