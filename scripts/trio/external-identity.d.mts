/**
 * Types for the external deployment-identity root.
 *
 * The implementation is plain `.mjs` because it runs inside `governed-launch.mjs`, in a bare node
 * process before any loader exists. This declaration is what lets the TypeScript runtime consume
 * the same module rather than keeping a second copy that could drift from it.
 *
 * Part of the byte-identical Trio shared core.
 */

export declare const CREDENTIAL_NAME: string;
export declare const CREDENTIAL_ROOT: string;
export declare const IDENTITY_SCHEMA_VERSION: number;
/** The schema the pre-release source deployment presents. Off the release path only. */
export declare const LEGACY_SCHEMA_VERSION: number;

export declare const BOUND_FILES: Readonly<{
  package: string;
  capsule: string;
  deployment: string;
}>;

export declare class ExternalIdentityRefused extends Error {
  readonly code: string;
  constructor(code: string, detail: string);
}

export interface IdentityRecord {
  readonly schemaVersion: number;
  readonly agent: string;
  readonly package: { readonly name: string; readonly sha256: string };
  readonly capsule: { readonly sha256: string };
  readonly deployment: { readonly sha256: string };
  readonly containment: { readonly version: string };
}

/** What may be logged: identity, schema version, which files were bound, and that they matched. */
export interface BoundIdentity {
  readonly agent: string;
  readonly schemaVersion: number;
  readonly boundFiles: readonly string[];
  readonly digestsMatched: true;
}

export declare function fileDigest(path: string): string;
export declare function parseIdentityRecord(text: string): IdentityRecord;
export declare function readCredentialRecord(env?: NodeJS.ProcessEnv): IdentityRecord;
export declare function assertRepositoryBinding(repositoryRoot: string, record: IdentityRecord): IdentityRecord;
export declare function assertExternalBinding(repositoryRoot: string, env?: NodeJS.ProcessEnv): BoundIdentity;
