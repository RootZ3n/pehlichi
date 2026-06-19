/**
 * loony-luna — core runtime re-exports.
 *
 * This is luna's OWN copy of the agent runtime (same code as mad-ptah/src/core/
 * and peh-agent/src/core/). Each agent owns its core — no shared package.
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
export { ShadowWorkspace } from "./shadow.js";

export { type AgentProfile } from "./profile.js";
export { buildSystemPrompt } from "./prompt.js";

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

export {
  runAgent,
  runAgentInShadow,
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
