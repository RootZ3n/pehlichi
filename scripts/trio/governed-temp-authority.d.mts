/**
 * Type declarations for scripts/trio/governed-temp-authority.mjs.
 *
 * Allows src/core/temp-authority.ts to import the canonical ESM authority
 * under NodeNext moduleResolution without requiring allowJs in tsconfig.json.
 *
 * Part of the byte-identical Trio shared core.
 */

export const TEMP_ROOT_ENV: string;
export const TEMP_RUN_ID_ENV: string;
export const TEMP_COMPONENT_ENV: string;
export const ROOT_MARKER_NAME: string;
export const ROOT_MARKER: string;
export const CHILD_MARKER: string;
export const MARKER_VERSION: number;
export const RECORDS_DIRNAME: string;
export const ALLOWED_COMPONENTS: readonly string[];
export const FORBIDDEN_ROOTS: readonly string[];
export const MIN_FREE_BYTES: number;
export const MIN_FREE_INODES: number;

export class GovernedTempError extends Error {
  readonly code: string;
  constructor(code: string, detail: string);
}

export function isUnder(child: string, parent: string): boolean;

export function resolveGovernedTempRoot(env?: NodeJS.ProcessEnv): string;

export interface RunDirectoryHandle {
  readonly path: string;
  readonly runId: string;
  readonly root: string;
  readonly recordPath: string;
}

export function createRunDirectory(component: string, env?: NodeJS.ProcessEnv): RunDirectoryHandle;

export function cleanupRun(run: RunDirectoryHandle): void;

export function buildChildEnv(run: RunDirectoryHandle, component: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

export function assertGovernedTempSafety(env?: NodeJS.ProcessEnv): { readonly root: string; readonly scratch: string };

export const TEMP_RUN_CHAIN_ENV: string;

export const ENTRY_CLASSES: readonly string[];

export function canonicalizePath(candidate: string, depth?: number): string;

export function runChainOf(env?: NodeJS.ProcessEnv): string[];

export function assertCanonicalEntryEnvironment(env?: NodeJS.ProcessEnv): string;

export interface GovernedChildEnvironment {
  readonly root: string;
  readonly runDir: string;
  readonly runId: string;
  readonly component: string;
  readonly chain: readonly string[];
}

export function assertGovernedChildEnvironment(env?: NodeJS.ProcessEnv): GovernedChildEnvironment;

export function reapDisprovenRuns(env?: NodeJS.ProcessEnv): string[];
