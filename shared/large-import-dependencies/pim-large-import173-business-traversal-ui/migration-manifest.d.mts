export interface ReleaseMigration {
  readonly number: number;
  readonly name: string;
  readonly file: string;
  readonly native_id: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly cold: {
    readonly contract: string;
    readonly source_contract: string;
    readonly compatibility: string;
    readonly project: string;
    readonly key: string;
    readonly marker: string;
    readonly requires: boolean;
  };
  readonly note: string;
}
export declare const RELEASE_MIGRATIONS: readonly ReleaseMigration[];
export declare const RELEASE_MIGRATION_PROGRAM: readonly (readonly [string, string])[];
