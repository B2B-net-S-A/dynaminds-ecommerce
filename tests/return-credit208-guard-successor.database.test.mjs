/** Independent Native208 integrity negatives. Import-inert/default SKIP.
 * Root supplies an already compiled, privately marked numeric scratch and source-derived
 * pre208 literal188/manifest207 digests. No factory, schema install or business seed.
 * Schema and source are pinned to the separately authored frozen208 candidate. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
const enabled = process.env.DYNA_NATIVE208_GUARD_QA === "true";
const options = { skip: !enabled, concurrency: false };
const SHA = /^[a-f0-9]{64}$/,
  IDENT = /^[a-z][a-z0-9_]{0,62}$/;
const integrityCodes = new Set([
  "23514",
  "42501",
  "55000",
  "42883",
  "42P01",
  "42703",
]);
const forbiddenPassCodes = new Set([
  "57014",
  "55P03",
  "40P01",
  "40001",
  "53300",
  "53400",
  "57P01",
  "57P02",
  "57P03",
]);
// Fixed by independent review of the final authored SQL; never supplied by the locator.
const FINAL208_SPEC = Object.freeze({
  prefix: "return_credit208_",
  manifest: "return_credit208_manifest",
  fingerprint: "return_credit208_fingerprint",
  sourceFiles: [
    "../server/208_consumer_return_credit_guard_dedup.sql",
    "../../native208-guard-cost/server/208_consumer_return_credit_guard_dedup.sql",
  ],
  sourceSha256:
    "a0091c26296575ea5b9b97fc794535e79bbcbfa056dcfa2ac33bab96c0c226a8",
});
const hash = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
const exact = (value, keys) => {
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
const quote = (name) => {
  assert(IDENT.test(name));
  return '"' + name + '"';
};
function finalSpec() {
  assert(
    FINAL208_SPEC,
    "Native208 final source schema has not yet been reviewed; no database IO is admitted",
  );
  return FINAL208_SPEC;
}
const fileCut = (s) =>
  [s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(
    ":",
  );
async function privateJson(file) {
  assert(
    typeof file === "string" &&
      path.isAbsolute(file) &&
      path.resolve(file) === file &&
      !/[\x00-\x1f\x7f]/.test(file),
  );
  assert.equal(await fs.realpath(file), file);
  const before = await fs.lstat(file, { bigint: true });
  assert(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.uid === BigInt(process.getuid()) &&
      before.nlink === 1n &&
      (before.mode & 0o777n) === 0o600n &&
      before.size > 0n &&
      before.size <= 16384n,
    "Private canonical single-link owner0600 locator required",
  );
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    assert.equal(fileCut(await fd.stat({ bigint: true })), fileCut(before));
    bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    for (;;) {
      const r = await fd.read(bytes, count, bytes.length - count, count);
      if (!r.bytesRead) break;
      count += r.bytesRead;
      if (count === bytes.length) break;
    }
    assert.equal(count, Number(before.size));
    assert.equal(fileCut(await fd.stat({ bigint: true })), fileCut(before));
    assert.equal(
      fileCut(await fs.lstat(file, { bigint: true })),
      fileCut(before),
    );
    assert.equal(await fs.realpath(file), file);
    return JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } finally {
    bytes?.fill(0);
    await fd.close();
  }
}
export function validateNative208GuardQaLocator(value) {
  exact(value, [
    "schema",
    "databaseUrl",
    "expectedDatabase",
    "expectedPort",
    "ownershipMarker",
    "expected208SqlSha256",
    "expectedLiteral188CatalogueSha256",
    "expectedOriginal207ManifestSha256",
    "receiptDirectory",
  ]);
  assert.equal(value.schema, "dynaminds-owned-native208-guard-qa/v1");
  assert(
    typeof value.databaseUrl === "string" && value.databaseUrl.length < 4096,
  );
  const u = new URL(value.databaseUrl);
  assert(["postgres:", "postgresql:"].includes(u.protocol));
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.username, "postgres");
  assert(u.password && !u.search && !u.hash);
  assert(
    Number.isInteger(value.expectedPort) &&
      value.expectedPort >= 1024 &&
      value.expectedPort <= 65535,
  );
  assert.equal(u.port, String(value.expectedPort));
  assert(/^dynaminds_test_\d{10,20}$/.test(value.expectedDatabase));
  assert.equal(u.pathname, "/" + value.expectedDatabase);
  assert(
    /^dynaminds-native208-guard-qa:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.ownershipMarker,
    ),
  );
  for (const key of [
    "expected208SqlSha256",
    "expectedLiteral188CatalogueSha256",
    "expectedOriginal207ManifestSha256",
  ])
    assert(SHA.test(value[key]));
  assert(
    typeof value.receiptDirectory === "string" &&
      path.isAbsolute(value.receiptDirectory) &&
      path.resolve(value.receiptDirectory) === value.receiptDirectory &&
      !/[\x00-\x1f\x7f]/.test(value.receiptDirectory),
  );
  return Object.freeze({ ...value });
}
async function receipt(locator, title, value) {
  const dir = locator.receiptDirectory;
  assert.equal(await fs.realpath(dir), dir);
  const s = await fs.lstat(dir);
  assert(
    s.isDirectory() &&
      !s.isSymbolicLink() &&
      s.uid === process.getuid() &&
      (s.mode & 0o777) === 0o700,
  );
  const name = title.replace(/[^a-z0-9-]/g, "-") + ".private.json";
  const fd = await fs.open(
    path.join(dir, name),
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await fd.writeFile(JSON.stringify(value, null, 2) + "\n");
    await fd.sync();
  } finally {
    await fd.close();
  }
}
/** Deliberately exported read-only snapshot shape so Root can capture the pre208
 * expected digest on its independently compiled source baseline, not bless after208. */
export async function snapshotLiteral188AndManifest207(c) {
  const functions = (
    await c.query(`SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,pg_get_userbyid(p.proowner) owner,p.provolatile,p.proisstrict,p.prosecdef,p.proparallel,p.proleakproof,p.proconfig,p.procost,p.prorows,
 (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY a.grantor::regrole::text,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,a.privilege_type,a.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a) acl
 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND (starts_with(p.proname,'local_consumer_credit_') OR p.proname='ordinary188_structure_valid') ORDER BY p.oid::regprocedure::text`)
  ).rows;
  assert(functions.length > 0);
  const relations = (
    await c.query(`SELECT c.relname,c.relkind,pg_get_userbyid(c.relowner) owner,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,
 (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY a.grantor::regrole::text,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,a.privilege_type,a.is_grantable) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a) acl,
 (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum) WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) columns,
 (SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid,true)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid) constraints,
 (SELECT jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) triggers,
 (SELECT jsonb_agg(jsonb_build_array(p.polname,p.polcmd,p.polpermissive,p.polroles,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid) policies,
 CASE WHEN c.relkind='i' THEN pg_get_indexdef(c.oid) ELSE NULL END index_definition
 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'local_consumer_credit_') ORDER BY c.relname`)
  ).rows;
  const literal188Manifest = (
    await c.query(
      "SELECT to_jsonb(m) row FROM public.local_consumer_credit_manifest m ORDER BY to_jsonb(m)::text",
    )
  ).rows.map((r) => r.row);
  const original207Manifest = (
    await c.query(
      "SELECT to_jsonb(m) row FROM public.return_credit206_manifest m ORDER BY to_jsonb(m)::text",
    )
  ).rows.map((r) => r.row);
  assert.equal(literal188Manifest.length, 1);
  assert.equal(original207Manifest.length, 1);
  return {
    literal188Catalogue: { functions, relations, manifest: literal188Manifest },
    original207Manifest,
  };
}
async function ownerContext(c, locator) {
  const r = (
    await c.query(
      `SELECT current_database() database,current_user,session_user,pg_backend_pid() pid,host(inet_server_addr()) server_address,inet_server_port() server_port,current_setting('server_version_num') server_version_num,current_setting('TimeZone') timezone,current_setting('jit') jit,current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout,current_setting('session_replication_role') replication_role,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) database_owner,(SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) ownership_marker`,
    )
  ).rows[0];
  assert.equal(r.database, locator.expectedDatabase);
  assert.equal(r.current_user, "postgres");
  assert.equal(r.session_user, "postgres");
  assert.equal(r.database_owner, "postgres");
  assert.equal(r.ownership_marker, locator.ownershipMarker);
  assert.equal(r.server_address, "127.0.0.1");
  assert.equal(r.server_port, locator.expectedPort);
  assert.equal(Math.floor(Number(r.server_version_num) / 10000), 18);
  assert.equal(r.timezone, "UTC");
  assert.equal(r.jit, "off");
  assert.equal(r.statement_timeout, "8s");
  assert.equal(r.lock_timeout, "8s");
  assert.equal(r.replication_role, "origin");
  return r;
}
async function fixture(title) {
  assert(enabled);
  const spec = finalSpec();
  const locator = validateNative208GuardQaLocator(
    await privateJson(process.env.DYNA_NATIVE208_GUARD_QA_LOCATOR),
  );
  assert.equal(
    locator.expected208SqlSha256,
    spec.sourceSha256,
    "Locator cannot substitute an unreviewed208 source",
  );
  let source;
  for (const file of spec.sourceFiles) {
    try {
      source = await fs.readFile(new URL(file, import.meta.url));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  assert(source, "Reviewed208 SQL file required");
  assert.equal(
    hash(source),
    spec.sourceSha256,
    "Reviewed authored208 source pin differs",
  );
  const receiptDir = await fs.lstat(locator.receiptDirectory);
  assert(
    receiptDir.isDirectory() &&
      !receiptDir.isSymbolicLink() &&
      receiptDir.uid === process.getuid() &&
      (receiptDir.mode & 0o777) === 0o700,
  );
  assert.equal(
    await fs.realpath(locator.receiptDirectory),
    locator.receiptDirectory,
  );
  try {
    await fs.lstat(
      path.join(locator.receiptDirectory, title + ".private.json"),
    );
    throw Error("Fresh receipt required");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const { default: pg } = await import("pg");
  const c = new pg.Client({
    connectionString: locator.databaseUrl,
    options:
      "-c timezone=UTC -c jit=off -c statement_timeout=8000 -c lock_timeout=8000",
    application_name: "dyna_native208_guard_qa_owned_scratch",
  });
  let connected = false;
  try {
    await c.connect();
    connected = true;
    const context = await ownerContext(c, locator);
    return { c, locator, spec, context };
  } catch (error) {
    if (connected) await c.end();
    throw error;
  }
}
async function healthy(c, locator, spec) {
  const predicates = (
    await c.query(
      "SELECT public.return_credit206_guards() successor,public.local_consumer_credit_guards() literal188,public.ordinary188_structure_valid() structure188",
    )
  ).rows[0];
  assert.deepEqual(predicates, {
    successor: true,
    literal188: true,
    structure188: true,
  });
  const certificate = (
    await c.query(
      "SELECT s.profile,s.original207=to_jsonb(o) original207_matches,s.successor207_fingerprint=public.return_credit206_fingerprint() current207_matches,s.fingerprint=public." +
        quote(spec.fingerprint) +
        "() metadata208_matches FROM public." +
        quote(spec.manifest) +
        " s CROSS JOIN public.return_credit206_manifest o WHERE s.id AND o.id",
    )
  ).rows;
  assert.deepEqual(certificate, [
    {
      profile: "207-to208-consumer-credit-deduplicated/v1",
      original207_matches: true,
      current207_matches: true,
      metadata208_matches: true,
    },
  ]);
  const snapshot = await snapshotLiteral188AndManifest207(c);
  assert.equal(
    hash(snapshot.literal188Catalogue),
    locator.expectedLiteral188CatalogueSha256,
  );
  assert.equal(
    hash(snapshot.original207Manifest),
    locator.expectedOriginal207ManifestSha256,
  );
  return { predicates, certificate, snapshot };
}
async function successorState(c, spec) {
  const functions = (
    await c.query(
      "SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,pg_get_userbyid(p.proowner) owner,p.proacl,p.proconfig FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,$1) ORDER BY p.oid::regprocedure::text",
      [spec.prefix],
    )
  ).rows;
  const rows = (
    await c.query(
      "SELECT to_jsonb(m) row FROM public." +
        quote(spec.manifest) +
        " m ORDER BY to_jsonb(m)::text",
    )
  ).rows.map((r) => r.row);
  return { functions, rows };
}
async function refusal(c, sql) {
  await c.query("SAVEPOINT expect_integrity_refusal");
  let result;
  try {
    const r = await c.query(sql);
    assert.equal(
      r.rows[0].valid,
      false,
      "A corrupted native predicate must not return true or NULL",
    );
    result = { kind: "false" };
  } catch (error) {
    if (
      forbiddenPassCodes.has(error.code) ||
      String(error.code ?? "").startsWith("08")
    )
      throw error;
    assert(
      integrityCodes.has(error.code),
      "Unexpected error cannot count as integrity refusal: " +
        String(error.code),
    );
    result = { kind: "integrity_error", code: error.code };
    await c.query("ROLLBACK TO SAVEPOINT expect_integrity_refusal");
  }
  await c.query("RELEASE SAVEPOINT expect_integrity_refusal");
  return result;
}
async function scenario(title, mutate) {
  const f = await fixture(title),
    { c, locator, spec } = f;
  const result = {
    schema: "dynaminds-native208-independent-guard-negative/v1",
    title,
    context: f.context,
    source208_sha256: locator.expected208SqlSha256,
    no_factory: true,
    no_business_writes: true,
  };
  let began = false,
    first;
  try {
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    began = true;
    await c.query("SELECT pg_advisory_xact_lock(982376)");
    result.before = await healthy(c, locator, spec);
    result.successor_before = await successorState(c, spec);
    if (mutate) {
      await mutate(c, spec, result);
      result.successor_refusal = await refusal(
        c,
        "SELECT public.return_credit206_guards() valid",
      );
    } else result.healthy = true;
  } catch (error) {
    first = error;
    result.error = {
      name: error.name,
      code: error.code ?? null,
      message: error.message,
    };
  } finally {
    if (began) {
      try {
        await c.query("ROLLBACK");
        result.rollback_confirmed = true;
      } catch (error) {
        first ??= error;
        result.rollback_confirmed = false;
      }
    }
    try {
      result.after = await healthy(c, locator, spec);
      result.successor_after = await successorState(c, spec);
      assert.deepEqual(result.after, result.before);
      assert.deepEqual(result.successor_after, result.successor_before);
      result.full_readback_restored = true;
    } catch (error) {
      first ??= error;
      result.postcheck_error = {
        name: error.name,
        code: error.code ?? null,
        message: error.message,
      };
    }
    await c.end();
    result.client_end_confirmed = true;
    result.status = first ? "FAIL" : "PASS";
    await receipt(locator, title, result);
  }
  if (first) throw first;
}

test(
  "native208 healthy and literal188 plus original207 manifest remain exact",
  options,
  () => scenario("healthy-literal188-original207"),
);
for (const [family, fn] of [
  ["157", "local_invoice_guards"],
  ["169", "catalog_stock_return_guards"],
  ["160", "b2b_credit_guards"],
])
  test(
    "native208 refuses actual unexpected PUBLIC ACL on parent" +
      family +
      " and rolls back",
    options,
    () =>
      scenario("parent-" + family + "-acl", async (c, _spec, result) => {
        assert.equal(
          (
            await c.query(
              "SELECT EXISTS(SELECT FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') allowed",
              [fn + "()"],
            )
          ).rows[0].allowed,
          false,
          "PUBLIC ACL mutation must change the baseline",
        );
        await c.query(
          "GRANT EXECUTE ON FUNCTION public." + quote(fn) + "() TO PUBLIC",
        );
        result.parent_refusal = await refusal(
          c,
          "SELECT public." + quote(fn) + "() valid",
        );
      }),
  );
test(
  "native208 refuses an extra object in its own namespace; rollback restores exact state",
  options,
  () =>
    scenario("extra208-function", async (c, spec) => {
      const name = spec.prefix + "negative_extra";
      assert(IDENT.test(name));
      await c.query(
        "CREATE FUNCTION public." +
          quote(name) +
          "() RETURNS boolean LANGUAGE sql AS " +
          "'SELECT true'",
      );
    }),
);
test(
  "native208 refuses missing fingerprint helper metadata; rollback restores exact state",
  options,
  () =>
    scenario("missing208-fingerprint", async (c, spec) => {
      await c.query(
        "ALTER FUNCTION public." +
          quote(spec.fingerprint) +
          "() RENAME TO " +
          quote(spec.prefix + "negative_missing"),
      );
    }),
);
test(
  "native208 refuses an unexpected manifest column; rollback restores exact state",
  options,
  () =>
    scenario("corrupt208-table-metadata", async (c, spec) => {
      await c.query(
        "ALTER TABLE public." +
          quote(spec.manifest) +
          " ADD COLUMN native208_negative_extra boolean",
      );
    }),
);
test(
  "native208 refuses missing certificate row without guessing its columns; rollback restores exact state",
  options,
  () =>
    scenario("missing208-manifest-row", async (c, spec) => {
      const triggers = (
        await c.query(
          "SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal ORDER BY tgname",
          ["public." + spec.manifest],
        )
      ).rows;
      assert(triggers.length > 0);
      for (const t of triggers) {
        assert.equal(t.tgenabled, "O");
        await c.query(
          "ALTER TABLE public." +
            quote(spec.manifest) +
            " DISABLE TRIGGER " +
            quote(t.tgname),
        );
      }
      assert.equal(
        (await c.query("DELETE FROM public." + quote(spec.manifest))).rowCount,
        1,
      );
      for (const t of triggers)
        await c.query(
          "ALTER TABLE public." +
            quote(spec.manifest) +
            " ENABLE TRIGGER " +
            quote(t.tgname),
        );
    }),
);
for (const [column, expression] of [
  ["original207", "original207||jsonb_build_object('native208_negative',true)"],
  ["successor207_fingerprint", "repeat('0',64)"],
  ["fingerprint", "repeat('0',64)"],
])
  test(
    "native208 refuses corrupted " +
      column +
      " certificate binding and rolls back",
    options,
    () =>
      scenario("corrupt208-" + column.replaceAll("_", "-"), async (c, spec) => {
        await c.query(
          "ALTER TABLE public." +
            quote(spec.manifest) +
            " DISABLE TRIGGER return_credit208_immutable",
        );
        assert.equal(
          (
            await c.query(
              "UPDATE public." +
                quote(spec.manifest) +
                " SET " +
                quote(column) +
                "=" +
                expression +
                " WHERE id",
            )
          ).rowCount,
          1,
        );
        await c.query(
          "ALTER TABLE public." +
            quote(spec.manifest) +
            " ENABLE TRIGGER return_credit208_immutable",
        );
      }),
  );
test(
  "native208 refuses unexpected helper ACL exposure and rolls back",
  options,
  () =>
    scenario("corrupt208-helper-acl", async (c, spec) => {
      await c.query(
        "GRANT EXECUTE ON FUNCTION public." +
          quote(spec.fingerprint) +
          "() TO dyna_app",
      );
    }),
);

test(
  "native208 full metadata seal refuses manifest reloptions drift and rolls back",
  options,
  () =>
    scenario("corrupt208-manifest-reloptions", async (c, spec, result) => {
      const before = (
        await c.query(
          "SELECT reloptions FROM pg_class WHERE oid=$1::regclass",
          ["public." + spec.manifest],
        )
      ).rows[0].reloptions;
      const fillfactor = before?.includes("fillfactor=71") ? 72 : 71;
      await c.query(
        "ALTER TABLE public." +
          quote(spec.manifest) +
          " SET (fillfactor=" +
          fillfactor +
          ")",
      );
      const after = (
        await c.query(
          "SELECT reloptions FROM pg_class WHERE oid=$1::regclass",
          ["public." + spec.manifest],
        )
      ).rows[0].reloptions;
      assert.notDeepEqual(
        after,
        before,
        "Reloptions negative must actually change metadata",
      );
      result.changed_reloptions = { before, after };
    }),
);

test(
  "native208 full metadata seal refuses composite type ACL drift and rolls back",
  options,
  () =>
    scenario("corrupt208-manifest-type-acl", async (c, spec, result) => {
      const read = async () =>
        (
          await c.query(
            "SELECT t.typacl,EXISTS(SELECT FROM aclexplode(coalesce(t.typacl,acldefault('T',t.typowner))) a WHERE a.grantee=0 AND a.privilege_type='USAGE') public_usage FROM pg_type t WHERE t.oid=$1::regtype",
            ["public." + spec.manifest],
          )
        ).rows[0];
      const before = await read();
      assert(before);
      const sql = before.public_usage
        ? "REVOKE USAGE ON TYPE public." + quote(spec.manifest) + " FROM PUBLIC"
        : "GRANT USAGE ON TYPE public." + quote(spec.manifest) + " TO PUBLIC";
      // Unsupported mutation errors fail this test; only the subsequent guard
      // refusal can establish the negative. Never count a SQL mutation error as PASS.
      await c.query(sql);
      const after = await read();
      assert.notDeepEqual(
        after.typacl,
        before.typacl,
        "Type ACL negative must actually change metadata",
      );
      assert.notEqual(after.public_usage, before.public_usage);
      result.changed_type_acl = { before, after };
    }),
);

test("controlled locator guard rejects Main, preview, remote hosts, aliases, wrong ownership and schema", () => {
  const value = {
    schema: "dynaminds-owned-native208-guard-qa/v1",
    databaseUrl:
      "postgres://postgres:CONTROLLED_NOT_REAL@127.0.0.1:57081/dynaminds_test_1792260802779",
    expectedDatabase: "dynaminds_test_1792260802779",
    expectedPort: 57081,
    ownershipMarker:
      "dynaminds-native208-guard-qa:12345678-1234-4123-8123-123456789abc",
    expected208SqlSha256: FINAL208_SPEC.sourceSha256,
    expectedLiteral188CatalogueSha256: "a".repeat(64),
    expectedOriginal207ManifestSha256: "b".repeat(64),
    receiptDirectory: "/private/controlled-native208-qa",
  };
  assert(Object.isFrozen(validateNative208GuardQaLocator(value)));
  for (const patch of [
    { expectedDatabase: "dynaminds_main" },
    { expectedDatabase: "dynaminds_full_base_preview_20261017" },
    { databaseUrl: value.databaseUrl.replace("127.0.0.1", "localhost") },
    {
      databaseUrl: value.databaseUrl.replace(
        "127.0.0.1",
        "external.example.test",
      ),
    },
    { databaseUrl: value.databaseUrl + "?options=controlled" },
    { databaseUrl: value.databaseUrl.replace(":57081", ":57082") },
    { ownershipMarker: "ordinary-unowned-scratch" },
    { expectedLiteral188CatalogueSha256: "not-a-sha" },
    { receiptDirectory: "relative" },
    { extra: true },
    { schema: "different" },
  ])
    assert.throws(() =>
      validateNative208GuardQaLocator({ ...value, ...patch }),
    );
});
test("controlled refusal classifier never treats timeout, cancellation, locks or connection failure as native integrity acceptance", async () => {
  for (const code of ["57014", "55P03", "40P01", "40001", "08006"]) {
    const error = Object.assign(new Error("Controlled interruption"), { code }),
      c = {
        query: async (sql) => {
          if (sql.startsWith("SELECT")) throw error;
          return { rows: [] };
        },
      };
    await assert.rejects(refusal(c, "SELECT controlled"), (e) => e === error);
  }
});
