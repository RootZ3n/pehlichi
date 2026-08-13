/**
 * MODEL SWITCH — on-the-fly model hot-swap for the running agent (4 cloud models, no local).
 *
 * The kernel shares ONE driver across every room session (KernelChatSession.driver is
 * readonly). To change the active model WITHOUT tearing down sessions or losing history,
 * we wrap that one driver in a SwappableDriver whose inner delegate can be replaced live.
 * Swapping the inner keeps each session's reference (and its message history) intact — the
 * next model call simply goes to the new backend. This mirrors ikbi's `/model` hot-swap
 * ("context preserved").
 *
 * Scope is GLOBAL: one swap changes which brain Peh is using everywhere.
 *
 * All targets are OpenAI-compatible CLOUD endpoints, so ONE driver (MimoDriver) serves them
 * all — it already routes auth by endpoint (Mimo uses an `api-key` header; DeepSeek/others use
 * `Bearer`). The four presets are the operator's roster: Mimo v2.5 (+ Pro) on xiaomimimo, and
 * DeepSeek v4 Flash (+ Pro) on api.deepseek.com. `keyKind` selects which API key the server
 * resolves for a target. PEHLICHI_MODEL_TARGETS (JSON) can add more; a custom POST /model can
 * name any model/endpoint on the fly. No on-device/local models by design.
 */
import {
  MimoDriver,
  isUsageReportingDriver,
  type Driver,
  type DriverContext,
  type DriverAction,
  type TokenUsage,
} from '../../../src/core/index.js';
import { CircuitBreaker } from '../../../src/core/agent-tools/circuit-breaker.js';
import { ResilientDriver } from './kernel-session.js';

/** Which API key a target authenticates with (Mimo api-key header vs DeepSeek Bearer). */
export type KeyKind = 'mimo' | 'deepseek' | 'minimax';

/** A selectable cloud model: the picker key `id`, the API model name, its endpoint, and key kind. */
export interface ModelTarget {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly keyKind: KeyKind;
}

const MIMO_BASE_DEFAULT = 'https://api.xiaomimimo.com/v1';
const DEEPSEEK_BASE_DEFAULT = 'https://api.deepseek.com/v1';

/**
 * A Driver whose inner delegate is REPLACEABLE at runtime. next()/drainUsage() forward to the
 * current inner; swap() atomically points it at a new backend. Sessions hold this stable
 * reference, so a swap changes the model for every in-flight and future turn.
 */
export class SwappableDriver implements Driver {
  private inner: Driver;
  private _active: ModelTarget;

  constructor(inner: Driver, active: ModelTarget) {
    this.inner = inner;
    this._active = active;
  }

  get active(): ModelTarget {
    return this._active;
  }

  swap(inner: Driver, active: ModelTarget): void {
    this.inner = inner;
    this._active = active;
  }

  next(ctx: DriverContext): Promise<DriverAction> {
    return this.inner.next(ctx);
  }

  drainUsage(): TokenUsage[] {
    return isUsageReportingDriver(this.inner) ? this.inner.drainUsage() : [];
  }
}

function inferKeyKind(baseUrl: string): KeyKind {
  if (baseUrl.includes('deepseek')) return 'deepseek';
  if (baseUrl.includes('minimax')) return 'minimax';
  return 'mimo';
}

function normalizeKeyKind(v: unknown, fallback: KeyKind): KeyKind {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'deepseek' || s === 'mimo' || s === 'minimax' ? s : fallback;
}

/** Parse the optional PEHLICHI_MODEL_TARGETS env (a JSON array of partial ModelTarget). Bad JSON ⇒ []. */
function parseTargetsEnv(raw: string | undefined): ModelTarget[] {
  if (raw === undefined || raw.trim() === '') return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: ModelTarget[] = [];
    for (const item of arr) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const model = typeof o.model === 'string' ? o.model.trim() : '';
      if (model === '') continue;
      const baseUrl = typeof o.baseUrl === 'string' && o.baseUrl.trim() !== '' ? o.baseUrl.trim() : MIMO_BASE_DEFAULT;
      const id = typeof o.id === 'string' && o.id.trim() !== '' ? o.id.trim() : model;
      const label = typeof o.label === 'string' && o.label.trim() !== '' ? o.label.trim() : model;
      out.push({ id, label, model, baseUrl, keyKind: normalizeKeyKind(o.keyKind, inferKeyKind(baseUrl)) });
    }
    return out;
  } catch {
    return [];
  }
}

const MINIMAX_BASE_DEFAULT = 'https://api.minimax.io/v1';

/**
 * The presets the picker offers: the operator's cloud models.
 * (AGENT_BASE_URL for Mimo, DEEPSEEK_BASE_URL for DeepSeek); PEHLICHI_MODEL_TARGETS adds more.
 */
export function availableModelTargets(env: NodeJS.ProcessEnv = process.env): ModelTarget[] {
  const mimoBase = env.AGENT_BASE_URL || MIMO_BASE_DEFAULT;
  const dsBase = env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_DEFAULT;
  const builtin: ModelTarget[] = [
    { id: 'mimo-v2.5', label: 'Mimo v2.5 · main', model: 'mimo-v2.5', baseUrl: mimoBase, keyKind: 'mimo' },
    { id: 'mimo-v2.5-pro', label: 'Mimo v2.5 Pro · main', model: 'mimo-v2.5-pro', baseUrl: mimoBase, keyKind: 'mimo' },
    { id: 'deepseek-v4-flash', label: 'DeepSeek v4 Flash', model: 'deepseek-v4-flash', baseUrl: dsBase, keyKind: 'deepseek' },
    { id: 'deepseek-v4-pro', label: 'DeepSeek v4 Pro', model: 'deepseek-v4-pro', baseUrl: dsBase, keyKind: 'deepseek' },
    { id: 'minimax-m3', label: 'MiniMax M3', model: 'MiniMax-M3', baseUrl: env.MINIMAX_BASE_URL || MINIMAX_BASE_DEFAULT, keyKind: 'minimax' },
  ];
  const merged: ModelTarget[] = [...builtin];
  for (const t of parseTargetsEnv(env.PEHLICHI_MODEL_TARGETS)) {
    if (!merged.some((m) => m.id === t.id)) merged.push(t);
  }
  return merged;
}

/** The active backend at startup (default Mimo v2.5, or AGENT_MODEL if it names a known preset). */
export function initialActive(env: NodeJS.ProcessEnv = process.env): ModelTarget {
  const available = availableModelTargets(env);
  const want = (env.AGENT_MODEL || 'mimo-v2.5').trim();
  return available.find((t) => t.id === want) ?? available[0]!;
}

/**
 * Resolve a POST /model body into a ModelTarget: a preset `id`, or a custom
 * { model, base_url?, key_kind? } (endpoint defaults to Mimo; key kind inferred from the URL).
 * Returns { error } on bad input.
 */
export function resolveTargetRequest(
  body: Record<string, unknown>,
  available: ModelTarget[],
): ModelTarget | { error: string } {
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (id !== '') {
    const preset = available.find((t) => t.id === id);
    return preset ?? { error: `unknown model preset '${id}'` };
  }
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (model === '') return { error: "provide 'id' (a preset) or 'model' (a custom model name)" };
  const baseUrl = typeof body.base_url === 'string' && body.base_url.trim() !== '' ? body.base_url.trim() : MIMO_BASE_DEFAULT;
  return { id: model, label: model, model, baseUrl, keyKind: normalizeKeyKind(body.key_kind, inferKeyKind(baseUrl)) };
}

/**
 * Build a fresh resilient Driver for a target (its own circuit breaker). `apiKey` is the key the
 * server resolved for this target's keyKind; MimoDriver routes it to the right auth header by URL.
 */
/**
 * Per-model USD pricing (dollars per MILLION tokens), from the operator's roster. Used to turn
 * token usage into an estimated in/out cost shown under each reply. Unknown model ⇒ no estimate.
 */
export const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  'mimo-v2.5': { in: 0.3, out: 0.9 },
  'mimo-v2.5-pro': { in: 0.6, out: 1.8 },
  'deepseek-v4-flash': { in: 0.14, out: 0.28 },
  'deepseek-v4-pro': { in: 0.27, out: 1.1 },
  'MiniMax-M3': { in: 0.15, out: 0.6 },
};

/** Estimated USD cost for a turn's token usage on a given model. Undefined if the model is unpriced. */
export function estimateCostUsd(modelId: string, inTokens: number, outTokens: number): number | undefined {
  const p = MODEL_PRICING[modelId];
  if (p === undefined) return undefined;
  return (inTokens / 1_000_000) * p.in + (outTokens / 1_000_000) * p.out;
}

export function buildDriverForTarget(target: ModelTarget, apiKey: string | undefined): Driver {
  const breaker = new CircuitBreaker(`${target.keyKind}:${target.model}`, {
    failureThreshold: 5,
    cooldownMs: 30_000,
    successThreshold: 3,
  });
  const inner = new MimoDriver({ baseUrl: target.baseUrl, model: target.model, ...(apiKey !== undefined ? { apiKey } : {}) });
  return new ResilientDriver(inner, breaker);
}
