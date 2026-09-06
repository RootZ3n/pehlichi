/**
 * Lab agent — core runtime re-exports.
 *
 * Each agent ships its OWN byte-identical copy of this runtime; the only
 * per-agent differences live in the personality overlay (profile, skills,
 * branding). Never import another agent's runtime.
 */

export {
  EventEmitter,
  type AgentEvent,
  type AgentEventInput,
  type EventSink,
  type EventMeta,
  type Phase,
} from "./events.js";

export {
  ScriptedDriver,
  isUsageReportingDriver,
  type Driver,
  type DriverAction,
  type DriverContext,
  type Message,
  type ToolSpec,
  type TokenUsage,
  type UsageReportingDriver,
} from "./driver.js";

export {
  MimoDriver,
  MimoError,
  MIMO_RESPONSE_PROTOCOL,
  completionToAction,
  parseChatCompletion,
  toProviderTools,
  toWireMessages,
  type MimoDriverOptions,
  type ParsedCompletion,
  type FetchLike,
} from "./drivers/mimo.js";

export {
  LlamaCppDriver,
  LlamaCppError,
  LLAMACPP_RESPONSE_PROTOCOL,
  type LlamaCppDriverOptions,
} from "./drivers/llamacpp.js";

export {
  OllamaDriver,
  OllamaError,
  OLLAMA_RESPONSE_PROTOCOL,
  type OllamaDriverOptions,
} from "./drivers/ollama.js";

export {
  createToolRegistry,
  toolSpecs,
  type ToolContext,
  type ToolDef,
  type ToolHandler,
  type ToolRegistry,
  type ToolResult,
  type TerminalReceipt,
} from "./tools.js";

export { resolveInWorkspace, ToolError } from "./workspace.js";

/**
 * The one projection from a run's structured close to the answer a caller delivers.
 * Exported so a consumer renders through it rather than inventing a second, lossier join.
 */
export {
  renderRunSummary,
  summaryFields,
  renderingPreservesFields,
  type RunSummary,
  type RenderedResult,
} from "./result-render.js";
export { ShadowWorkspace } from "./shadow.js";

export { type AgentProfile } from "./profile.js";
export { buildSystemPrompt } from "./prompt.js";

// Runtime capabilities (P0.4): truthful, derived report of what the run can actually do.
export {
  runtimeCapabilities,
  activeCapabilityList,
  type RuntimeCapabilities,
  type RuntimeCapabilityInput,
} from "./runtime-capabilities.js";

// Reasonix infrastructure re-exports
export { ContextCompressor, type CompressResult, type ContextCompressorOptions } from "./context-compressor.js";
export { ReceiptStore, type Receipt, type ReceiptStoreOptions } from "./receipt-store.js";
export {
  CircuitBreaker,
  getCircuit,
  allCircuits,
  RetryPolicy,
  withRetry,
  isRetryable,
  sleep,
  IterationBudget,
  TokenMonitor,
  type CircuitConfig,
  type CircuitState,
  type CircuitStatus,
  type RetryConfig,
  type BudgetStatus,
  type TokenMonitorConfig,
  type UsageRecord,
  type TokenSummary,
} from "./agent-tools/infrastructure.js";

// Bridge infrastructure re-exports
export { HttpBridge, BridgeError, type BridgeConfig, type BridgeReceipt } from "./bridges/http-bridge.js";
export { BridgeRegistry, bridgeRegistry, type BridgeInfo, type BridgeHealth } from "./bridges/registry.js";

// Unattended policy re-exports
export {
  unattendedToolDenyReason,
  isToolAllowedUnattended,
  assertUnattendedStartup,
  delegationDepthDenyReason,
  verifyUnattendedSuccess,
  SharedBudget,
  UNATTENDED_ALLOWED_TOOLS,
  type UnattendedToolContext,
  type GovernedExecRequest,
  type UnattendedResult,
} from "./agent-tools/unattended.js";

/**
 * The operational-work admission boundary. Exported so every surface that starts a run --
 * the kernel chat session, the REPL, a test harness -- declares what the run is for through
 * the same vocabulary rather than inventing its own.
 */
/**
 * The operational-work admission boundary.
 *
 * Read-only status and refusal vocabulary only. Nothing here grants admission, and there is
 * deliberately no exported token, purpose or capability that could: while the governed status
 * is locked, `runAgent` executes nothing, and no value a caller can obtain changes that.
 *
 * `executeAgentRun` and `executeAgentInShadow` are also absent on purpose -- they live below
 * the boundary and are not part of the public API.
 */
export {
  admitWork,
  admitRunWork,
  admitNonWorkSurface,
  readOperationalStatus,
  describeRefusal,
  OperationalStatusUnreadable,
  GOVERNED_STATUS_PATH,
  type OperationalStatus,
  type OperationalState,
  type OperationalAuthorization,
  type AdmissionDecision,
  type AdmissionRefusal,
  type RefusalCode,
  type WorkCategory,
  type NonWorkSurface,
} from "./operational-admission.js";

/**
 * The qualification admission: verification and narrowing only.
 *
 * `qualifyRun` decides; there is deliberately no minting function here or anywhere in this
 * repository, so no caller can obtain an admission from inside the subject it would admit.
 */
export {
  qualifyRun,
  type QualificationRequest,
  type QualificationGrant,
  type QualifiedDecision,
  type QualificationRefusalReason,
} from "./qualification-admission.js";

export {
  runAgent,
  runAgentInShadow,
  OperationalWorkRefused,
  type RunAgentOptions,
  type RunAgentResult,
  type RunAgentInShadowOptions,
  type ShadowRunResult,
  type ApprovalCallback,
  type ToolApprovalRequest,
  type ToolApprovalDecision,
} from "./loop.js";

export { createStdoutSink, formatEvent } from "./sinks/stdout.js";

export { createBridgeReceiptSink, type BridgeReceiptInput } from "./bridge-adapter.js";
