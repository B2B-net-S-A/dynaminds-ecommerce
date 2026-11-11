# Woo attachment fingerprint correction

Current service only: `server/local-woo-flow.ts`, opening SHA `6925889a1811be9e57ae3bda4f1df8da99f321e45395a83c73d70e885a788d1b`, final SHA `dbc928f67f718c2fc02a49c5c3d2caa4868ca3a88bdcabc06a3e5aaf5dfe3094`.

Preview hashes all connection settings. The old sync/status attachment changed those settings after preview and before the original processor's late comparison. Sync/status attachment now INSERTs a fixed receipt through existing domain.audit in the same queue/claim transaction. Order-stage attachment is unchanged. The global connection fingerprint and processors are unchanged.

Read, completion and failure handling hydrate detached references from exactly scoped audit data and validate original marker identity, count, strict fields, linked job payload/kind/attempt, plan owner/channel/job, sync listing/product or own cancelled imported order and captured cancelled status. This grants no claim, processor or retry authority. Complete writes ACK only after the original processor's real DONE; failure retains original refs and UNKNOWN. Existing failed keys are never retried or altered by this source change.

Audit is a source-owned appended reference carrier, not database-enforced immutable authority: audit_events has existing dyna_app table permissions. Every consumed attachment therefore validates the linked rows. No schema or permission change is required. COMMIT refusal never mints the private claim.

`node --test tests/local-woo-attachment.test.mjs`: actual terminal d49cc8, exit0, ten controls; complete compiled service with explicit SQL/processor models, no PG/API/provider calls. Covers old-source reproduction, both real source branches, fingerprint-preserving attachment, unchanged external settings refusal, COMMIT uncertainty, original error/IDs, foreign/ambiguous/conflicting receipts, linked job/plan refusal, old marker preservation and old paid status-plan refusal. Integrated strict/build and actual positive API acceptance belong to Root and remain separate from these source controls.
