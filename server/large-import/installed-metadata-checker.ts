/** Fixed real metadata exercise. Export/import has no IO; no readiness mint. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDedicatedMetadataTransport, assertOriginalMetadataBinding, type Ports as TransportPorts } from '../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/transport';
import { createNativeResourceGroupBroker, attachNativeResourceGroups } from '../../shared/large-import-dependencies/pim-large-import173-bounded-native-groups-backend/groups';
import { createUploadQuotaBroker, type OwnedRequest } from '../../shared/large-import-dependencies/pim-large-import-upload-quota-broker-backend3/broker';
import { createMetadataMutationHooks, type MutationHooks } from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/hooks';
import { createPostgresJobStore, createPostgresBlobMetadata, type Client } from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/storage';
import { createPublicationAuthorityFactory } from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/authority';
import { createDurableUploadRegistry } from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/registry';
import { createQuotaRawStore } from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/store';
import { createBoundRawPort } from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/raw-port';
import { retainAndChunkImport, type Spec } from '../../shared/large-import-dependencies/pim-large-import-stream-foundation-ui2/stream';
import { createLargeImportCoordinator } from '../../shared/large-import-dependencies/pim-large-import-job-coordinator-backend5/coordinator';
import type { CoreConfig } from '../../shared/large-import-dependencies/pim-large-import-job-coordinator-backend5/native-batches';
import { beginReviewedStartupOperation, inspectCompositeStartupInOperation, closeReviewedStartupOperation, recheckReviewedStartupEvidence, type ReviewedStartupOperation, type ReviewedStartup } from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
import type { Actor } from '../domain';

export type MetadataExerciseRequest = Parameters<ReturnType<typeof createDedicatedMetadataTransport>['capture']>[0];
type Event = { sequence: number; phase: string; operation: string | null; key: string | null; fact: unknown };
export const METADATA_FIXTURE_SHA256 = '2ac0012299d1158fcade1409a7585e903416c481b2921662481c759606c044e7';
export type MetadataExerciseFixture = { bytes: Uint8Array; expectedSha256: typeof METADATA_FIXTURE_SHA256; spec: Spec; core: CoreConfig; catalogId: string; blobId: string; jobId: string };
export type MetadataExerciseData = { privateRoot: string; fixture: MetadataExerciseFixture; uploadAllocation: OwnedRequest; jobAllocation: OwnedRequest };
export type MetadataExerciseInput = MetadataExerciseData & {
  startup: ReviewedStartup; original: MetadataExerciseRequest; transport: TransportPorts;
  /** Installed code-owned catalog validator. Not an acceptance evaluator. */
  validateCatalog(actor: Actor, catalog: string): Promise<void>;
};
class LostDelivery extends Error { constructor() { super('fixed-checker-job-create-response-delivery-lost'); } }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const unavailable = async (): Promise<never> => { throw new Error('metadata-exercise-does-not-exercise-core-or-pim'); };

/** No evaluator, operation callback, injected witness or positive result parameter. */
export async function runFixedMetadataExercise(input: MetadataExerciseInput) {
  // All ordinary data/callback identities detach before any async operation.
  const startup = input.startup, original = input.original, config = { ...input.transport },
    root = input.privateRoot, validateCatalog = input.validateCatalog,
    fixture = structuredClone(input.fixture), uploadAllocation = structuredClone(input.uploadAllocation),
    jobAllocation = structuredClone(input.jobAllocation);
  assert.equal(fixture.bytes.length, 622, 'fixed-real-622-byte-fixture');
  assert.equal(fixture.expectedSha256, METADATA_FIXTURE_SHA256, 'source-fixed-fixture-selection-sha');
  assert.equal(digest(fixture.bytes), fixture.expectedSha256, 'consumed-installed-fixture-sha');
  assert.equal(uploadAllocation.kind, 'upload'); assert.equal(jobAllocation.kind, 'job');
  assert.equal(jobAllocation.ceiling.raw, 0);
  assert.notEqual(uploadAllocation.requestId, jobAllocation.requestId);
  assert.notEqual(uploadAllocation.reservationId, jobAllocation.reservationId);
  assert.notEqual(uploadAllocation.privateToken, jobAllocation.privateToken);
  assert(uploadAllocation.ceiling.raw >= fixture.bytes.length);

  const events: Event[] = [], clients = new Map<Client, { pid: number; ended: boolean }>(), cleanup: unknown[] = [];
  let diagnosticPhase = 'private-assembly';
  let firstFailureDiagnostic: { phase: string; name: string; code: string | null; sourceLocation: { module: string; line: number; column: number } | null } | null = null;
  const stage = (phase: string) => { diagnosticPhase = phase; };
  const failureFact = (error: unknown) => {
    const name = error instanceof Error ? error.name : typeof error;
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
    let sourceLocation: { module: string; line: number; column: number } | null = null;
    if (error instanceof Error && typeof error.stack === 'string') for (const line of error.stack.split('\n').slice(1)) {
      // Copy only a code module basename and numerical position, never stack/message/input values.
      const match = /(?:^|[\/])([A-Za-z0-9_.-]+\.(?:mjs|cjs|js|mts|ts)):(\d+):(\d+)\)?$/.exec(line.trim());
      if (match) { const at = Number(match[2]), column = Number(match[3]); if (Number.isSafeInteger(at) && at > 0 && Number.isSafeInteger(column) && column > 0) { sourceLocation = { module: match[1], line: at, column }; break; } }
    }
    return { phase: diagnosticPhase, name, code, sourceLocation };
  };
  const ownedFailureClosers: Array<() => Promise<void>> = [];
  let storageClient: Client | undefined, tracePrincipal: unknown = null;
  let frame: { operation: string; key: string } | null = null, first: unknown, failed = false, result: unknown;
  const record = (phase: string, fact: unknown) => events.push({ sequence: events.length, phase, operation: frame?.operation ?? null, key: frame?.key ?? null, fact: structuredClone({ principal: tracePrincipal, fact }) });
  const report = (error: unknown) => { cleanup.push({ name: error instanceof Error ? error.name : typeof error }); try { config.cleanupFailure(error); } catch {} };
  const connect = config.connectOwner;
  const transportConfig: TransportPorts = {
    ...config, cleanupFailure: report,
    connectOwner: async () => {
      const c = await connect(); assert(!clients.has(c), 'checker-dedicated-client-never-reused');
      clients.set(c, { pid: -1, ended: false });
      const end = c.end.bind(c);
      // Keep the SAME client object used by the transport/publication WeakMaps.
      // This local lifecycle wrapper never adopts/proxies a foreign client.
      c.end = async () => { await end(); clients.get(c)!.ended = true; };
      await c.query("SET SESSION statement_timeout='8s'");
      await c.query("SET SESSION lock_timeout='8s'");
      await c.query('SET SESSION jit=off'); await c.query("SET SESSION timezone='UTC'");
      const row = (await c.query("SELECT pg_backend_pid() pid,current_user role,session_user session_role,current_setting('statement_timeout') timeout,current_setting('jit') jit,current_setting('TimeZone') zone")).rows[0];
      assert(row && row.role === config.expectedOwner && row.session_role === config.expectedOwner && row.timeout === '8s' && row.jit === 'off' && row.zone === 'UTC', 'actual-checker-owner-native8-identity');
      clients.get(c)!.pid = Number(row.pid); record('owner-client-identity', row); return c;
    },
    preflightOwner173: async c => { assert(releaseOperation, 'checker-private-release-operation-required'); await inspectCompositeStartupInOperation(c, startup, releaseOperation); return 'VALID'; },
  };
  let jobSnapshot: unknown, uploadSnapshot: unknown, evidence: unknown, releaseOperation: ReviewedStartupOperation | undefined;
  try {
    stage('reviewed-evidence-opening-full');
    releaseOperation = await beginReviewedStartupOperation(startup);
    stage('metadata-capture-and-binding');
    const metadata = createDedicatedMetadataTransport(transportConfig), actor = metadata.capture(original), bound = metadata.bind(actor);
    tracePrincipal = { tenantId: actor.tenantId, actorId: actor.userId, apiKeyId: actor.apiKeyId ?? null, role: actor.role };
    assertOriginalMetadataBinding(bound.ports, original, actor);
    const fresh = async () => {
      assertOriginalMetadataBinding(bound.ports, original, actor);
      let c: Client | undefined, refused = false, originalError: unknown;
      try { c = await bound.ports.connect(bound.scope); await bound.ports.admit(c, bound.scope); }
      catch (error) { refused = true; originalError = error; }
      finally { if (c) try { await c.end(); } catch (error) { report(error); if (!refused) { refused = true; originalError = error; } } }
      if (refused) throw originalError;
    };
    const inventory = { inspect: unavailable }; // No fabricated empty/complete inventory; ready close/reconciliation is unavailable.
    const uploadBroker = createUploadQuotaBroker(transportConfig), jobBroker = createUploadQuotaBroker(transportConfig);
    const uploadActor = uploadBroker.capture(original), jobActor = jobBroker.capture(original);
    const principal = (a: Actor) => ({ tenant: a.tenantId, actor: a.userId, key: a.apiKeyId ?? null, role: a.role });
    assert.deepEqual(principal(uploadActor), principal(actor)); assert.deepEqual(principal(jobActor), principal(actor));
    const upload = uploadBroker.bind(uploadActor, uploadAllocation, inventory), job = jobBroker.bind(jobActor, jobAllocation, inventory);
    stage('upload-reserve');
    await upload.quotas.reserve(upload.captured, uploadAllocation.ceiling.raw);
    ownedFailureClosers.push(() => upload.quotas.close({ id: uploadAllocation.reservationId }, { outcome: 'unknown', acknowledged_bytes: 0, raw: null }));
    stage('job-reserve');
    await job.quotas.reserve(job.captured, 0);
    ownedFailureClosers.push(() => job.quotas.close({ id: jobAllocation.reservationId }, { outcome: 'unknown', acknowledged_bytes: 0, raw: null }));
    const quota = (q: typeof job, allocation: OwnedRequest) => {
      const scalar = {
        intent: async (resource: Parameters<typeof q.intent>[0]) => { const fact = await q.intent(resource); record('native-intent-ack', { reservationId: allocation.reservationId, requestId: allocation.requestId, resource, fact }); return fact; },
        settle: async (resource: Parameters<typeof q.settle>[0]) => { const fact = await q.settle(resource); record('native-settle-ack', { reservationId: allocation.reservationId, requestId: allocation.requestId, resource, fact }); return fact; },
        snapshot: q.snapshot,
        unknown: async () => { await q.quotas.close({ id: allocation.reservationId }, { outcome: 'unknown', acknowledged_bytes: 0, raw: null }); record('native-owned-unknown', { reservationId: allocation.reservationId }); },
      };
      // The original metadata ports stay bound to the publication/storage client.
      // Group actors authorize only their own native quota transaction graph.
      const groups = createNativeResourceGroupBroker(transportConfig), groupActor = groups.capture(original);
      assert.deepEqual(principal(groupActor), principal(actor), 'checker-original-group-principal');
      const attached = attachNativeResourceGroups(scalar, groups.bind(groupActor, allocation));
      return {
        ...attached,
        async intentMany(...args: Parameters<typeof attached.intentMany>) {
          stage('native-group-intent');
          const facts = await attached.intentMany(...args);
          record('native-group-intent-ack', { reservationId: allocation.reservationId, requestId: allocation.requestId, resources: args[0], facts }); return facts;
        },
        async settleMany(...args: Parameters<typeof attached.settleMany>) {
          stage('native-group-settle');
          const facts = await attached.settleMany(...args);
          record('native-group-settle-ack', { reservationId: allocation.reservationId, requestId: allocation.requestId, resources: args[0], facts }); return facts;
        },
      };
    };
    stage('upload-group-assembly');
    const uq = quota(upload, uploadAllocation);
    stage('job-group-assembly');
    const jq = quota(job, jobAllocation);
    let loseJobCreateDelivery = true;
    const hook = (q: typeof jq): MutationHooks => {
      const real = createMetadataMutationHooks({ quota: q, admit: fresh, cleanupFailure: report });
      return {
        async perform(operation, key, resources, write, inspect) {
          assert.equal(frame, null, 'checker-fixed-serial-metadata-operation'); frame = { operation, key };
          try {
            const value = await real.perform(operation, key, resources, async () => {
              // Callback comes ONLY from the imported real storage factory below.
              // Verify actual independently committed intent rows before mutation.
              const cut = await q.snapshot();
              assert(storageClient && clients.get(storageClient)?.ended === false, 'checker-original-open-storage-client');
              await bound.ports.admit(storageClient, bound.scope);
              const identity = (await storageClient.query("SELECT pg_backend_pid() pid,current_user role,current_setting('app.tenant_id',true) tenant,current_setting('statement_timeout') timeout,current_setting('jit') jit")).rows[0];
              assert(identity?.role === 'dyna_app' && identity.tenant === actor.tenantId && identity.timeout === '8s' && identity.jit === 'off' && Number(identity.pid) === clients.get(storageClient)!.pid, 'checker-exact-storage-client-actor-native8');
              for (const resource of resources) {
                const row = cut.resources.find((r: Record<string, unknown>) => r.resource_key === resource.key);
                assert(row && row.state === 'intent' && row.kind === resource.kind && Number(row.byte_count) === resource.byte_count && row.sha256 === resource.sha256 && row.payload_text === (resource.payload_text ?? null), 'checker-real-intent-before-owned-write');
              }
              record('before-real-storage-write', { resources, native: cut, identity }); await write(); record('real-storage-write-returned', { resources, pid: identity.pid });
            }, async () => { const readback = await inspect(); record('real-storage-exact-readback', readback.resources); return readback; });
            record('real-hook-settled-return', { resources });
            if (operation === 'job-create' && loseJobCreateDelivery) {
              loseJobCreateDelivery = false; record('fixed-response-delivery-loss-after-settlement', { key }); throw new LostDelivery();
            }
            return value;
          } finally { frame = null; }
        },
        async prepareCleanup(key, resource) {
          assert.equal(frame, null); frame = { operation: 'job-lease-release', key };
          try { await real.prepareCleanup(key, resource); record('exact-cleanup-preallocated-before-claim', { resource }); } finally { frame = null; }
        },
        async cleanup(key, resource, write, inspect) {
          assert.equal(frame, null); frame = { operation: 'job-lease-release', key };
          try {
            // Do not insert a fresh gate that would prevent mandatory no-growth cleanup after revocation.
            await real.cleanup(key, resource, async () => { record('before-real-preallocated-cleanup', { resource }); await write(); }, async () => { const found = await inspect(); record('actual-cleanup-readback', found); return found; });
          } finally { frame = null; }
        },
      };
    };
    stage('publication-authority-assembly');
    const publication = createPublicationAuthorityFactory(transportConfig).bind(actor, original, uploadAllocation, bound.ports);
    stage('raw-store-assembly');
    const store = createQuotaRawStore({ root, publication, cleanupFailure: report,
      authorize: async a => { stage('publication-quota-snapshot'); assert.equal(a, actor); assertOriginalMetadataBinding(bound.ports, original, actor); const cut = await uq.snapshot(); assert.equal(cut.reservation.id, uploadAllocation.reservationId); return { scope: { tenantId: actor.tenantId, actorId: actor.userId, apiKeyId: actor.apiKeyId ?? null }, reservationId: uploadAllocation.reservationId, quota: uq }; },
      validateCatalog: async (a, id) => { stage('raw-current-catalog-validation'); assert.equal(a, actor); assert.equal(id, fixture.catalogId); await validateCatalog(actor, id); },
    });
    const storagePorts = (mutations: MutationHooks) => ({ ...bound.ports, mutations, connect: async (scope: typeof bound.scope) => {
      const c = await bound.ports.connect(scope); storageClient = c; record('original-bound-storage-client', { pid: clients.get(c)!.pid }); return c;
    } });
    stage('raw-metadata-port-assembly');
    const raw = createBoundRawPort(store, actor), blobs = createPostgresBlobMetadata(storagePorts(hook(uq)), bound.scope, raw);
    stage('durable-registry-assembly');
    const registry = createDurableUploadRegistry({ root, publication, cleanupFailure: report,
      authorize: async a => { stage('publication-quota-snapshot'); assert.equal(a, actor); assertOriginalMetadataBinding(bound.ports, original, actor); const cut = await uq.snapshot(); assert.equal(cut.reservation.id, uploadAllocation.reservationId); return { scope: { tenantId: actor.tenantId, actorId: actor.userId, apiKeyId: actor.apiKeyId ?? null }, reservationId: uploadAllocation.reservationId, quota: uq }; },
      validateCatalog: async (a,id) => { stage('registry-current-catalog-validation'); assert.equal(a,actor); assert.equal(id,fixture.catalogId); await validateCatalog(actor,id); },
      readReady: async (a,id,catalog) => { stage('registry-authoritative-retained-readback'); assert.equal(a,actor); assert.equal(id,fixture.blobId); assert.equal(catalog,fixture.catalogId); const native = await blobs.readManifest(id); const handle = `large-import-raw-file/v1:${actor.tenantId}:${id}`; assert.deepEqual(await store.inspect(actor,handle), {sha256:native.raw.sha256,byte_count:native.raw.byte_count}); return {schema:'retained-large-import-upload/v1',status:'UPLOAD_RETAINED_READY_NOT_NATIVE_APPROVED',blob_id:id,...native,whole_native_preview:'OPEN'}; },
    });
    stage('registry-claim-preparation');
    const ready = await registry.once(actor,uploadAllocation.requestId,fixture.catalogId,async claim => {
      // Source-owned durable claim/attachment precedes every blob publication. No hand-written FS bypass.
      stage('registry-blob-attachment');
      await claim.attach(fixture.blobId);
      stage('raw-owner-publication');
      const handle = await store.create(actor,fixture.blobId,fixture.catalogId,uploadAllocation.ceiling.raw);
      stage('native-blob-create');
      await blobs.create(fixture.blobId,handle,fixture.spec,uploadAllocation.ceiling.raw);
      const sink = blobs.sink(fixture.blobId);
      stage('native-part-batch-manifest-retention');
      const manifest = await retainAndChunkImport((async function*(){yield new Uint8Array(fixture.bytes);})(),fixture.spec,{
        appendOriginal:sink.appendOriginal,putBatch:sink.putBatch,commitManifest:sink.commitManifest,
        sealOriginal:async fact=>{await store.seal(actor,handle,{sha256:fact.sha256,byte_count:fact.byte_count});await sink.sealOriginal(fact);},
      });
      stage('retained-manifest-readback');
      const saved = await blobs.readManifest(fixture.blobId);assert.deepEqual(saved.manifest,manifest);assert.equal(saved.raw.sha256,fixture.expectedSha256);
      return {schema:'retained-large-import-upload/v1',status:'UPLOAD_RETAINED_READY_NOT_NATIVE_APPROVED',blob_id:fixture.blobId,...saved,whole_native_preview:'OPEN'};
    });
    const manifest=ready.manifest,saved={raw:ready.raw,manifest:ready.manifest,spec:ready.spec},handle=`large-import-raw-file/v1:${actor.tenantId}:${fixture.blobId}`;
    record('actual-durable-upload-registry-readback',ready);
    // Independent native row for the real same-client part, plus actual FS seal/hash inspection.
    stage('independent-native-part-and-seal-readback');
    let partClient: Client | undefined;
    try {
      partClient = await bound.ports.connect(bound.scope); await bound.ports.admit(partClient, bound.scope);
      const parts = (await partClient.query('SELECT offset_bytes::text,byte_count::text,sha256 FROM public.large_import_parts173 WHERE tenant_id=$1 AND blob_id=$2 ORDER BY offset_bytes', [actor.tenantId, fixture.blobId])).rows;
      assert.equal(parts.length, 1); assert.equal(Number(parts[0].offset_bytes), 0); assert.equal(Number(parts[0].byte_count), 622); assert.equal(parts[0].sha256, fixture.expectedSha256);
      assert.deepEqual(await store.inspect(actor, handle), { sha256: fixture.expectedSha256, byte_count: 622 }); record('actual-native-part-and-sealed-fs-readback', { parts });
    } finally { if (partClient) await partClient.end(); }
    stage('coordinator-assembly');
    const jobs = createPostgresJobStore(storagePorts(hook(jq)), bound.scope);
    const coordinator = createLargeImportCoordinator<Actor>({
      authority: async a => { assert.equal(a, actor); await fresh(); return structuredClone(bound.scope); }, blob: blobs, jobs,
      capacity: unavailable, validateCoreBatch: unavailable,
      core: { preview: unavailable, previewPage: unavailable, execute: unavailable, executionPage: unavailable },
      pim: { stage: unavailable, preview: unavailable, apply: unavailable },
    });
    const preparation = { jobId: fixture.jobId, raw: saved.raw, manifest: saved.manifest, spec: saved.spec, config: fixture.core };
    stage('job-create-response-loss');
    try { await coordinator.prepare(actor, preparation); assert.fail('fixed-response-loss-must-be-observed'); }
    catch (error) { if (!(error instanceof LostDelivery)) throw error; }
    const writesBeforeRetry = events.filter(x => x.phase === 'before-real-storage-write' && x.operation === 'job-create').length;
    stage('job-create-durable-replay');
    const initial = await coordinator.prepare(actor, preparation);
    assert.equal(events.filter(x => x.phase === 'before-real-storage-write' && x.operation === 'job-create').length, writesBeforeRetry, 'actual-original-job-create-replay-no-write');
    assert.equal(initial.revision, 0); assert.equal(initial.events.length, 0);
    stage('job-checkpoint-event');
    const approved = await coordinator.approve(actor, fixture.jobId, initial.plan_hash);
    assert.equal(approved.revision, 1); assert.equal(approved.approved, true); assert.equal(approved.events.length, 1); assert.equal(approved.events[0].kind, 'whole-file-approved');
    stage('job-checkpoint-replay');
    const replay = await coordinator.approve(actor, fixture.jobId, initial.plan_hash);
    assert.deepEqual(replay, approved, 'real-session-cas-replay-no-event');
    const checkpointWrites = events.filter(x => x.operation === 'job-checkpoint-event' && x.phase === 'before-real-storage-write');
    assert.equal(checkpointWrites.length, 1, 'one-actual-checkpoint-cas');
    stage('job-lease-final-readback');
    let inspectClient: Client | undefined;
    try {
      inspectClient = await bound.ports.connect(bound.scope); await bound.ports.admit(inspectClient, bound.scope);
      const lease = (await inspectClient.query('SELECT lease_token,leased_at,lease_fence::text fence,revision FROM public.large_import_jobs173 WHERE tenant_id=$1 AND id=$2 AND actor_id=$3 AND api_key_id IS NOT DISTINCT FROM $4::uuid', [actor.tenantId, fixture.jobId, actor.userId, actor.apiKeyId ?? null])).rows[0];
      assert(lease && lease.lease_token === null && lease.leased_at === null && lease.fence === '2' && Number(lease.revision) === 1, 'real-two-lease-cas-cleanup-cost'); record('actual-final-job-lease-readback', lease);
    } finally { if (inspectClient) await inspectClient.end(); }
    stage('job-final-quota-snapshot');
    jobSnapshot = await jq.snapshot();
    stage('upload-final-quota-snapshot');
    uploadSnapshot = await uq.snapshot();
    result = { initial, approved, replay, manifest, operationScope: 'REAL_METADATA_JOB_CREATE_RESPONSE_LOSS_REPLAY_AND_ONE_CAS_WITH_TWO_LEASES_PLUS_BLOB_PART_PIPELINE' };
  } catch (error) { failed = true; first = error; firstFailureDiagnostic = failureFact(error); }
  finally {
    // Only exact allocations successfully reserved by THIS invocation. Retain
    // uncertainty; no ready close, resource release, FS deletion or old-key repair.
    if (failed) for (const closeOwnedUnknown of ownedFailureClosers) try { await closeOwnedUnknown(); } catch (error) { report(error); }
    for (const [client, state] of clients) if (!state.ended) try { stage('owned-client-close'); await client.end(); } catch (error) { report(error); if (!failed) { failed = true; first = error; firstFailureDiagnostic = failureFact(error); } }
    try { stage('reviewed-evidence-force-full'); evidence = releaseOperation ? await closeReviewedStartupOperation(startup, releaseOperation) : await recheckReviewedStartupEvidence(startup); } catch (error) { report(error); if (!failed) { failed = true; first = error; firstFailureDiagnostic = failureFact(error); } }
  }
  const allClientsClosed = [...clients.values()].every(x => x.ended);
  return {
    status: !failed && cleanup.length === 0 && allClientsClosed ? 'FIXED_METADATA_EXERCISE_CLOSED_SOURCE_RUN_PASS' : 'FIXED_METADATA_EXERCISE_CLOSED_SOURCE_RUN_FAILED',
    result, events, jobSnapshot, uploadSnapshot, closedReviewedEvidence: evidence,
    firstFailureDiagnostic,
    clients: [...clients.values()], allClientsClosed, cleanup,
    error: failed ? { name: first instanceof Error ? first.name : typeof first, code: first && typeof first === 'object' && 'code' in first && typeof first.code === 'string' ? first.code : null } : null,
    uncertaintyScope: 'RESPONSE_DELIVERY_LOSS_AFTER_ACTUAL_SETTLEMENT_NOT_PROCESS_CRASH',
    retainedFixtureAllocations: true, acceptanceCapabilityMinted: false, all18Accepted: false,
  };
}
