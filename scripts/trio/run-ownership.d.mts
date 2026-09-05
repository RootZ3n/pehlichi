/**
 * Types for the governed run-ownership authority.
 *
 * The implementation is plain `.mjs` because the reaper runs inside the bare-node governed launcher,
 * before any loader exists. This declaration lets the TypeScript suites consume the SAME module, so
 * the test and the reaper cannot disagree about what residue is — which is exactly how the previous
 * defect survived: the two had separate ideas of ownership.
 *
 * Part of the byte-identical Trio shared core.
 */

export type OwnershipState = 'LIVE' | 'DEAD' | 'UNKNOWN';

export declare const OWNERSHIP_SCHEMA_VERSION: number;
export declare const LAB_UNIT: RegExp;
export declare const STATE: Readonly<{ LIVE: 'LIVE'; DEAD: 'DEAD'; UNKNOWN: 'UNKNOWN' }>;

export interface OwnershipFacts {
  readonly ownershipSchemaVersion: number;
  readonly bootId?: string;
  readonly pid: number;
  readonly processStartTicks?: number;
  readonly unit?: string;
}

export interface OwnershipVerdict {
  readonly state: OwnershipState;
  readonly reason: string;
}

export interface RunVerdict extends OwnershipVerdict {
  readonly runId: string;
  readonly path: string;
}

export declare function readBootId(): string | undefined;
export declare function readStartTicks(pid: number): number | undefined;
export declare function readUnit(pid: number): string | undefined;
export declare function ownershipFacts(pid?: number): OwnershipFacts;
export declare function readSidecar(path: string): Record<string, unknown> | undefined;

export declare function classifyOwnership(
  record: Record<string, unknown> | undefined,
  childPath: string,
  options?: { bootId?: string | undefined; hostname?: string | undefined; uid?: number | undefined },
): OwnershipVerdict;

export declare function classifyComponent(
  root: string,
  component: string,
  recordsDirname?: string,
): readonly RunVerdict[];

export declare function residueOf(verdicts: readonly RunVerdict[]): readonly RunVerdict[];
