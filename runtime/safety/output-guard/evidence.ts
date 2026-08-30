/**
 * Named forwarding only.
 *
 * This was `export * from '../../../src/core/agent-tools/restricted-evidence.js'`. A star re-export cannot be audited by reading it: it exports
 * whatever the target exports, including whatever the target starts exporting tomorrow. That is
 * how `runtime/core/loop.ts` came to re-export both below-admission executors into a second
 * namespace, where the same computed-property bypass would have reached them.
 *
 * The names are written out so this file's surface is a decision somebody made, not a
 * consequence of a decision made elsewhere.
 */
export {
  type ToolTextChannel,
  type EvidenceOwner,
  type RestrictedEvidenceMetadata,
  type PublicFindingMetadata,
  type RestrictedEvidenceRecorder,
  type RestrictedForensicAccess,
  type RestrictedEvidenceOptions,
  RestrictedEvidenceVault,
  toPublicFinding,
  validateFindingMetadata,
  createRestrictedEvidenceVault,
  quarantineSummary
} from '../../../src/core/agent-tools/restricted-evidence.js';
