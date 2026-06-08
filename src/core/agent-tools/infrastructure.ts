/**
 * AGENT INFRASTRUCTURE — pre-specialization bells and whistles.
 *
 * This module exports all the infrastructure components that every agent
 * needs before specialization:
 *
 * - Circuit breaker (provider failure protection)
 * - Retry with jittered backoff
 * - Provider chain (deterministic model routing with fallback)
 * - Iteration budget (runaway loop prevention)
 * - Prompt injection defense (25+ patterns, 3 scopes)
 * - Input sanitization (surrogates, JSON repair, control chars)
 * - Error classification (simplified taxonomy)
 * - Token monitoring (usage tracking, cost estimation)
 * - Schema sanitizer (llama.cpp compatibility)
 * - OpenRouter driver (new provider)
 */

// Reliability
export { CircuitBreaker, getCircuit, allCircuits, type CircuitConfig, type CircuitState, type CircuitStatus } from "./circuit-breaker.js";
export { RetryPolicy, withRetry, isRetryable, sleep, type RetryConfig } from "./retry.js";
export { ProviderChain, buildDefaultChain, type ProviderEntry, type ChainStatus } from "./provider-chain.js";
export { IterationBudget, type BudgetStatus } from "./iteration-budget.js";

// Security
export { scanForInjection, detectInvisibleChars, sanitizeUnicode, type ScanScope, type ScanResult } from "./prompt-injection.js";
export { replaceSurrogates, stripNonAscii, sanitizeControlChars, capBytes, repairJson, sanitizeMessage, sanitizeToolOutput } from "./input-sanitization.js";

// Providers
export { OpenRouterDriver, OpenRouterError, type OpenRouterDriverOptions } from "./openrouter-driver.js";
export { classifyError, type ErrorCategory, type ClassifiedError } from "./error-classifier.js";
export { sanitizeToolSchema, sanitizeToolDefinitions } from "./schema-sanitizer.js";

// Observability
export { TokenMonitor, type TokenMonitorConfig, type UsageRecord, type TokenSummary } from "./token-monitor.js";
