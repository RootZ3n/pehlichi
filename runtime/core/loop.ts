/**
 * The runtime's view of the agent loop.
 *
 * This was `export * from '../../src/core/loop.js'`, which re-exported the two below-admission
 * executors into a second namespace -- so closing the escape in `src/core/loop.ts` alone would
 * have left `import * as loop from 'runtime/core/loop.js'` reaching them by exactly the same
 * computed property. A star re-export cannot be audited by reading it: it exports whatever the
 * target exports, including whatever the target starts exporting tomorrow.
 *
 * Named forwarding only, therefore, and only the gated entry points and the types callers need.
 */
export {
  runAgent,
  runAgentInShadow,
  OperationalWorkRefused,
  unprovenClaim,
  type RunAgentOptions,
  type RunAgentResult,
  type RunAgentInShadowOptions,
  type ShadowRunResult,
  type ApprovalCallback,
  type ToolApprovalRequest,
  type ToolApprovalDecision
} from '../../src/core/loop.js';
