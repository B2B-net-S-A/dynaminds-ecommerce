# Local package build

These tools inspect and emit files. They do not start PostgreSQL, migrate a
database, seed accounts, start the application or enable the importer.

Use a complete selected developer tree, such as the finalized Source553 stage.
The mixed primary checkout currently lacks modules present in the reviewed
release. Do not repair it by copying just two files or overwriting its WIP.

Install the selected tree's locked development dependencies and build its actual
frontend first:

```sh
cd /absolute/developer-source
npm ci
npm run build
```

Then invoke the portable emitter from this repository. The source contract is
the complete, reviewed Source48 directory (48 members); obtain its manifest SHA from the
selected release binding, not from an untrusted input. The output must be a new
path outside both input directories, with an existing canonical parent.

```sh
node /absolute/repository/tools/build/local-package.mjs \
  --project /absolute/developer-source \
  --source-contract /absolute/release-contract \
  --source-manifest-sha TRUSTED_64_HEX_SHA \
  --output /absolute/output/local-package
```

Add `--check-only` to verify inputs without emission. The emitter preserves the
eleven entrypoints, runtime dependency closure, one private Startup namespace,
complete frontend/resource inventories and 32 MiB member/128 MiB emitted-package caps (Source contract remains64 MiB).
The package cap was 96 MiB until 26.10.2026; the package from HEAD with migration 235 is
100 666 753 B, 3 457 B over it, and stage 5 needs a release built from HEAD, so it is now
134 217 728 B in `emitted-release.mjs` and `resource-format210.mjs` (both copies).
Its esbuild metafile is saved beside the output as
`local-package.esbuild-metafile.json`, never inside the shipped inventory.

The source contract is validated in full before use. Its sixteen runtime-source
members, numbered Native migrations, compatibility JSON and validators must
match the developer tree. Application modules outside that roster, including
the two Source552 custody changes and Source548 order parcel code, are inspected
by the emitter and are not falsely classified as Source48 changes. Native or
contract drift refuses reuse; it needs a newly reviewed contract. No historical
snapshot, predecessor peer or source-builder derivation is loaded by these tools.
Dead historical code imports are externalized during static inspection and then
must disappear from the actual tree-shaken output. The unchanged emitter output
guard refuses any surviving historical import. This permits omitting archive
directories from developer source without allowing a runtime archive dependency.

The canonical CLI source now supports an explicit canonical decimal loopback
port1024..65535 and derives exactly `http://127.0.0.1:<port>` for the factory.
The existing positional4100 remains valid. `--nbp-eur` explicitly enables only
manual EUR reads from the exact NBP tableA route, with maximum age7days. Without
that flag provider reads remain disabled; enabling it performs no request.
No arbitrary provider/origin option or importer activation is accepted.

After emitting a new package containing this CLI source, choose an unoccupied
port and a private owned mode600 selection file. This is a source command,
not a claim that the preserved91ad CLI implements the new flag:

```sh
node /absolute/new-local-package/runtime/server/ordinary-local-cli.mjs \
  /absolute/private-selection.json SELECTION_SHA256 41586 --nbp-eur
```

Do not displace Main4100 or the Root-owned NBP listener41585. This command
requires its own authorized database/configuration selection and runs the real
ordinary migration/cold validation. It does not manage PostgreSQL ownership.
`--verified-stock-writers` and `--scoped-automation` remain separate explicit
local options; the example does not enable either. Importer availability remains
false: only a separate genuine current in-process installed producer closure
can enable it. A saved proof or the Source48 build contract cannot substitute for
that authority. The runtime contract is currently Source48/runtime16/Native26. Installed importer
authority still requires a fresh in-process proof; the build itself never supplies it.

Focused file-only checks:

```sh
node --test tools/build/local-package.test.mjs
```

`provenance.json` records exact original build-tool bytes. Validator and output
closure files are unchanged; the emitter changes only helper imports, proper
file-URL handling, the location of its build-time metafile and the bounded
historical-edge resolver described above.
