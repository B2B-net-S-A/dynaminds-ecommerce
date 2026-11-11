/** Closed SOURCE inventory. A registration is not an installed native hook. */
export const OPERATIONS = {
 'fs-create': ['blob'],
 'fs-part-publish': ['raw','blob'],
 'fs-lock': ['blob'],
 'fs-seal': ['blob'],
 'fs-quarantine': ['blob'],
 'blob-create': ['blob'],
 'blob-part-append': ['raw','blob'],
 'batch-append': ['batch'],
 'blob-seal': ['blob'],
 'manifest-commit': ['blob'],
 'job-create': ['job'],
 'job-lease-claim': ['job'],
 'job-lease-release': ['job'],
 'job-checkpoint-event': ['job','event'],
 'review-append-bindings': ['review'],
 'upload-registry-claim': ['blob'],
 'upload-registry-settle': ['blob'],
 'private-witness-append': ['event'],
} as const;
export type Operation = keyof typeof OPERATIONS;
export const HOOKS = ['durable-byte-store','durable-upload-registry','raw-intents','blob-intents','batch-intents','job-intents','review-intents','event-intents','native-core-eligibility','native-core-pim-drivers','current-actor-custody'] as const;
export type Hook = typeof HOOKS[number];
export const NATIVE_DRIVERS = ['current-actor-custody','core-current-eligibility','core-preview','core-execute','pim-stage','pim-preview','pim-apply','upload-registry-recovery','retained-inventory'] as const;
export type NativeDriver = typeof NATIVE_DRIVERS[number];
export const RETAINED_AREAS = ['raw-parts','raw-owner','raw-seal','raw-pending','raw-quarantine','raw-locks','blobs','parts','batches','jobs','events','reviews','upload-registry','private-witnesses','quota-reservations','quota-resources'] as const;
export type RetainedArea = typeof RETAINED_AREAS[number];
