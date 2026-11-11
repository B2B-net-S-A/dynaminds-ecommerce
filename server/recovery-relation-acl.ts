import type pg from 'pg';
import { z } from 'zod';

const relationSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  kind: z.enum(['r', 'p', 'v', 'm', 'S']),
  owner: z.string().min(1).max(63),
  explicit: z.boolean(),
  rls: z.boolean(),
  force_rls: z.boolean(),
  acl: z.array(z.string().min(1).max(1024)).max(1024),
}).strict();

// pg_dump may omit an explicit ACL equal to the owner's default. Native
// validators also inspect that physical representation, so seal it in the
// same snapshot as the dump instead of inferring it from restored defaults.
export const relationAclSnapshotSchema = z.array(relationSchema).max(20000).superRefine((rows, ctx) => {
  if (new Set(rows.map(row => row.name)).size !== rows.length)
    ctx.addIssue({ code: 'custom', message: 'Powtórzona relacja w metadanych ACL kopii' });
});
type Snapshot = z.infer<typeof relationAclSnapshotSchema>;

const inventorySql = `SELECT c.relname AS name,c.relkind::text AS kind,
  pg_get_userbyid(c.relowner) AS owner,c.relacl IS NOT NULL AS explicit,
  c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,
  ARRAY(SELECT a::text FROM unnest(coalesce(c.relacl,
    acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a ORDER BY a::text) AS acl,
  ARRAY(SELECT a::text FROM unnest(acldefault(
    CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner)) a ORDER BY a::text) AS default_acl
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace
  AND c.relkind IN ('r','p','v','m','S') ORDER BY c.relname`;

export async function captureRelationAclSnapshot(client: pg.Client): Promise<Snapshot> {
  const rows = (await client.query(inventorySql)).rows;
  return relationAclSnapshotSchema.parse(rows.map(({ default_acl: _default, ...row }) => row));
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';

// Caller owns a transaction in a new isolated restore database. This never
// reconstructs changed privileges: it only materializes an authenticated,
// default-equivalent owner ACL after checking the complete relation inventory.
export async function restoreRelationAclSnapshot(client: pg.Client, input: unknown): Promise<number> {
  const expected = relationAclSnapshotSchema.parse(input);
  const database = (await client.query('SELECT current_database() AS name')).rows[0]?.name;
  if (!/^dynaminds_restore_[a-f0-9]{16}$/.test(database ?? ''))
    throw new Error('Metadane ACL można odtwarzać wyłącznie w izolowanej bazie odtworzenia');
  const current = (await client.query(inventorySql)).rows;
  const byName = new Map(current.map(row => [row.name, row]));
  if (byName.size !== expected.length)
    throw new Error('Zbiór relacji różni się od metadanych ACL kopii');
  const materialize: Snapshot = [];
  // Validate every relation before the first GRANT; additional tenant grants,
  // changed owners, RLS or missing objects are never repaired automatically.
  for (const row of expected) {
    const found = byName.get(row.name);
    if (!found) throw new Error('Brak relacji zapisanej w metadanych ACL kopii');
    const { default_acl: defaults, ...actual } = found;
    if (!equal({ ...actual, explicit: row.explicit }, row))
      throw new Error('Efektywne uprawnienia, właściciel lub RLS różnią się od kopii');
    if (actual.explicit === row.explicit) continue;
    if (!row.explicit || actual.explicit || !equal(row.acl, defaults))
      throw new Error('Niedozwolona zmiana reprezentacji ACL podczas odtwarzania');
    materialize.push(row);
  }
  for (const row of materialize) {
    const target = row.kind === 'S' ? 'SEQUENCE' : 'TABLE';
    await client.query(`GRANT ALL PRIVILEGES ON ${target} public.${identifier(row.name)} TO ${identifier(row.owner)}`);
  }
  if (!equal(await captureRelationAclSnapshot(client), expected))
    throw new Error('Nie udało się wiernie odtworzyć reprezentacji ACL kopii');
  return materialize.length;
}
