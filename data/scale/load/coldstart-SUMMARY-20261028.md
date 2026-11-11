# Cold start of the release: breakdown before and after (28.10.2026)

The raw evidence is in `<workspace>/development/full-base/data/scale/load/coldstart-{before-01,after-01,after-02}/`
(run.json for the CLI starts, `trace-*.ndjson` query traces, `report-*.json` phases, `cpu-*` CPU profiles).
Database `dynaminds_scale_20261028_71` (a copy of `_41`; the first start applied 244–252, and the copy is now
dropped). Each start ran alone, in the network namespace of `dyna-scale-pg18`. Host: M5 Max, load average 7–15.

| | before: 3983a95 (`scale-release-cs7-base-01`) | after: 758bfcb (`scale-release-cs7-after-02`) |
|---|---|---|
| CLI start to LISTENING (`tools/scale/load/coldstart.mjs`, same measure as run.mjs `_ready_ms`) | 213.3 s, 240.3 s | **119.5 s, 105.3 s** |
| intermediate ea7112e (`scale-release-cs7-after-01`) | | 115.8 s, 114.2 s |
| factory time in the probe | 217.9 s (with migrations), 226.4 s | 104.3 s |

## Phases (`tools/scale/load/coldstart-report.mjs`)

| phase | before | after | DB share |
|---|---|---|---|
| migrate() + resources + startup handle | 6.0 s | 5.7 s | ~0 |
| legacy owner-ACL normalization: catalogue read + release cold chain + compiled compare | **83.4 s** | 22.7 s | 1.2 s |
| activation: packing cold compartment, same JS work in the activation transaction | **78.8 s** | 23.1 s | 1.1 s |
| activation: native predicates (cert173 5 s, pim_dictionary 5–6 s, nested172 / parcel_wz / operative_delivery ~2.5 s each, ordinary187_approve 5 s), closing cuts, COMMIT | 29.2 s | 26.8 s | 23–25 s |
| composite inspection + buildApp capability guards (pim_dictionary 6 s, wave_print177 4 × 2.4 s, nested172, wz_issuer, packed_label, parcel_wz ~2.5 s each) | 28.9 s | 26.1 s | 25–27 s |

**Cause:** about 150 of the 226 s were JS CPU, not database time. The catalogue has 46 870 records and 67 MB of
canonical text, and each start reads it twice. On each read the release cold chain runs 41 compiled inverses. Every
inverse re-copied, re-checked, re-serialized, double-hashed and re-froze every record. In the profile that shows up
as 49 s of GC, 17 s of `canonicalText` and 14 s of sha256.

**Change:** a record that the reader normalized and deeply froze itself is reused, and its canonical text and JSON
budget are kept. Every check still runs for every catalogue, and the digest covers the same bytes. In the offline
benchmark (`coldstart-bench.mjs`, after252), `assertPackingNativeInstallation` went from 50.0 s to 14.0 s and the chain
alone from 42.7 s to 10.7 s.
