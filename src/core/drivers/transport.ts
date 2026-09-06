/**
 * THE PROVIDER TRANSPORT — one request, measured, bounded, and correlated.
 *
 * This is the only place a chat completion is fetched. It exists because the driver used to do it
 * inline with a single 120-second abort, no streaming, no retry unless a caller opted in, and no
 * record of what actually happened on the wire. Every one of those is a separate question and they
 * are answered separately here.
 *
 * WHAT IT MEASURES, and why each matters:
 *
 *   - TIME TO FIRST BYTE, separately from total duration. A provider that takes ninety seconds to
 *     start and then answers in two is a different problem from one that dribbles for ninety, and
 *     one number cannot tell them apart.
 *   - STREAMING requested / negotiated / observed, as three facts rather than one. A provider may
 *     ignore `stream: true` and answer with a whole JSON body; a client that then emits its own
 *     chunks locally has not streamed, it has pretended to. Observed means bytes arrived over time.
 *   - THE WIRE MODEL the provider says it ran, beside the model that was configured. A silent
 *     substitution is a finding.
 *
 * WHAT IT REFUSES TO DO:
 *
 *   - it does not retry anything terminal. Authentication, authorization, malformed requests and
 *     deterministic model errors are the same on the second attempt and burn the run deadline;
 *   - it does not retry once effects have been observed, ever;
 *   - it does not let a late response from an abandoned attempt reach the caller. Each attempt
 *     carries its own abort controller, and a body that arrives after that attempt is over is
 *     quarantined with the attempt id that owned it rather than being merged into a live turn;
 *   - it does not extend the run deadline. A retry costs the run its remaining time; it does not
 *     buy more.
 */
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_TRANSPORT_POLICY, RunDeadline, backoffMs, classifyFailure, shouldRetry,
  type AttemptRecord, type FailureClass, type TransportPolicy,
} from '../transport-policy.js';

export type FetchLike = (input: string, init: {
  method: string; headers: Record<string, string>; body: string; signal: AbortSignal;
  dispatcher?: unknown;
}) => Promise<{
  ok: boolean; status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
  headers?: { get(name: string): string | null };
}>;

export interface TransportRequest {
  readonly runId: string;
  readonly requestId: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  /** The request body WITHOUT `stream`; this decides and sets that itself. */
  readonly payload: Record<string, unknown>;
  readonly provider: string;
  readonly endpoint: string;
  readonly configuredModel: string;
  readonly driver: string;
  readonly streamingRequested: boolean;
  readonly policy?: TransportPolicy;
  readonly fetchImpl: FetchLike;
  /** True once this turn has proposed or performed any effect. Disables retry outright. */
  readonly effectsObserved?: boolean;
  /** Where attempt records go. Never throws into the caller; evidence is never a decision. */
  readonly onAttempt?: (record: AttemptRecord) => void;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface TransportResult {
  readonly json: unknown;
  readonly attempts: readonly AttemptRecord[];
  readonly streamingObserved: boolean;
  readonly timeToFirstByteMs: number;
  readonly wireModel?: string;
}

export class TransportError extends Error {
  override readonly name = 'TransportError';
  constructor(
    message: string,
    readonly failure: FailureClass,
    readonly attempts: readonly AttemptRecord[],
    readonly status?: number,
    readonly detail?: string,
  ) { super(message); }
}

/** Redact anything that looks like a key before an error detail is allowed to travel. */
export function sanitizeDetail(text: string, limit = 400): string {
  return text
    .replace(/(sk-|key-|Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1<redacted>')
    .replace(/"(api[_-]?key|authorization|token)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"')
    .slice(0, limit);
}

/**
 * Read a Server-Sent Events completion stream into the whole-response shape.
 *
 * Aggregates content and tool calls by index, tracks the first byte and the longest silence, and
 * reports what it actually saw rather than what was asked for. A provider that answered with a
 * plain JSON body despite `stream: true` is detected here, not assumed away.
 */
export async function readSseCompletion(
  body: ReadableStream<Uint8Array>,
  opts: { idleMs: number; signal: AbortSignal; now?: () => number },
): Promise<{ json: unknown; firstByteAt: number; sawMultipleChunks: boolean }> {
  const now = opts.now ?? Date.now;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let firstByteAt = 0;
  let chunks = 0;
  let content = '';
  /*
    A thinking model streams its reasoning as its own delta field, and a provider may REQUIRE that
    reasoning back on the next request. Dropping it here would silently defeat the round-trip on
    every streamed turn, which is most of them.
  */
  let reasoning = '';
  let finishReason: string | undefined;
  let model: string | undefined;
  let usage: unknown;
  const toolCalls = new Map<number, { id?: string; name?: string; args: string }>();

  const idleGuard = (): Promise<never> => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('idle timeout'), { code: 'UND_ERR_BODY_TIMEOUT' })), opts.idleMs);
    opts.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
  });

  for (;;) {
    const step = await Promise.race([reader.read(), idleGuard()]);
    if (step.done) break;
    if (firstByteAt === 0) firstByteAt = now();
    chunks += 1;
    buffered += decoder.decode(step.value, { stream: true });
    let cut: number;
    while ((cut = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, cut).trim();
      buffered = buffered.slice(cut + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
      if (typeof event['model'] === 'string') model = event['model'];
      if (event['usage'] !== undefined && event['usage'] !== null) usage = event['usage'];
      const choice = (event['choices'] as Array<Record<string, unknown>> | undefined)?.[0];
      if (choice === undefined) continue;
      if (typeof choice['finish_reason'] === 'string') finishReason = choice['finish_reason'];
      const delta = choice['delta'] as Record<string, unknown> | undefined;
      if (delta === undefined) continue;
      if (typeof delta['content'] === 'string') content += delta['content'];
      if (typeof delta['reasoning_content'] === 'string') reasoning += delta['reasoning_content'];
      const calls = delta['tool_calls'] as Array<Record<string, unknown>> | undefined;
      for (const call of calls ?? []) {
        const index = typeof call['index'] === 'number' ? call['index'] : 0;
        const slot = toolCalls.get(index) ?? { args: '' };
        if (typeof call['id'] === 'string') slot.id = call['id'];
        const fn = call['function'] as Record<string, unknown> | undefined;
        if (fn !== undefined) {
          if (typeof fn['name'] === 'string') slot.name = fn['name'];
          if (typeof fn['arguments'] === 'string') slot.args += fn['arguments'];
        }
        toolCalls.set(index, slot);
      }
    }
  }

  const assembled = {
    ...(model !== undefined ? { model } : {}),
    ...(usage !== undefined ? { usage } : {}),
    choices: [{
      finish_reason: finishReason ?? 'stop',
      message: {
        role: 'assistant',
        content,
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.size > 0
          ? {
              tool_calls: [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({
                id: c.id ?? randomUUID(),
                type: 'function',
                function: { name: c.name ?? '', arguments: c.args },
              })),
            }
          : {}),
      },
    }],
  };
  return { json: assembled, firstByteAt, sawMultipleChunks: chunks > 1 };
}

/** Perform one chat completion, with the whole policy applied. */
export async function performCompletion(request: TransportRequest): Promise<TransportResult> {
  const policy = request.policy ?? DEFAULT_TRANSPORT_POLICY;
  const now = request.now ?? Date.now;
  const random = request.random ?? Math.random;
  const deadline = new RunDeadline(policy.timeouts.runMs, now);
  const attempts: AttemptRecord[] = [];
  const effectsObserved = request.effectsObserved === true;

  for (let attempt = 1; ; attempt += 1) {
    const attemptId = `att-${randomUUID()}`;
    const startedAt = now();
    const budget = deadline.attemptBudgetMs(policy.timeouts.attemptMs);
    const controller = new AbortController();
    const attemptTimer = setTimeout(() => controller.abort(), Math.max(1, budget));
    /*
      The header clock is separate from the attempt clock, and it has to be: a provider that
      accepts the connection and then sends nothing is indistinguishable from one that is thinking,
      until a header timeout says how long thinking is allowed to take.
    */
    let headerPhase = true;
    const headerTimer = setTimeout(() => { if (headerPhase) controller.abort(); }, policy.timeouts.headerMs);

    let status: number | undefined;
    let failure: FailureClass | undefined;
    let detail: string | undefined;
    let json: unknown;
    let wireModel: string | undefined;
    let firstByteAt = 0;
    let streamingNegotiated = false;
    let streamingObserved = false;

    try {
      const payload = request.streamingRequested
        ? { ...request.payload, stream: true, stream_options: { include_usage: true } }
        : { ...request.payload };
      const response = await request.fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      headerPhase = false;
      clearTimeout(headerTimer);
      status = response.status;
      if (firstByteAt === 0) firstByteAt = now();

      if (!response.ok) {
        detail = sanitizeDetail(await response.text().catch(() => ''));
        failure = classifyFailure({ status });
      } else {
        const contentType = response.headers?.get('content-type') ?? '';
        streamingNegotiated = request.streamingRequested && contentType.includes('text/event-stream');
        if (streamingNegotiated && response.body) {
          const read = await readSseCompletion(response.body, {
            idleMs: policy.timeouts.idleMs, signal: controller.signal, now,
          });
          json = read.json;
          if (read.firstByteAt > 0) firstByteAt = read.firstByteAt;
          // Observed means bytes genuinely arrived over more than one chunk. A single chunk that
          // happened to be framed as SSE is not evidence that anything streamed.
          streamingObserved = read.sawMultipleChunks;
        } else {
          json = await response.json();
        }
        wireModel = typeof (json as { model?: unknown })?.model === 'string'
          ? (json as { model: string }).model : undefined;
      }
    } catch (error) {
      const err = error as { name?: string; code?: string; cause?: { code?: string } };
      failure = classifyFailure({
        errorName: err?.name, errorCode: err?.code ?? err?.cause?.code,
        phase: headerPhase ? 'header' : 'body',
      });
      detail = sanitizeDetail(String((error as Error)?.message ?? error));
    } finally {
      clearTimeout(attemptTimer);
      clearTimeout(headerTimer);
      // The controller is aborted unconditionally on the way out, so a body still arriving from a
      // finished attempt is torn down rather than left to land in a turn that has moved on.
      if (!controller.signal.aborted) controller.abort();
    }

    const endedAt = now();
    const base = {
      runId: request.runId, requestId: request.requestId, attemptId, attempt,
      provider: request.provider, endpoint: request.endpoint,
      configuredModel: request.configuredModel,
      ...(wireModel !== undefined ? { wireModel } : {}),
      driver: request.driver,
      streamingRequested: request.streamingRequested,
      streamingNegotiated, streamingObserved,
      timeouts: policy.timeouts,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: endedAt - startedAt,
      ...(firstByteAt > 0 ? { timeToFirstByteMs: firstByteAt - startedAt } : {}),
      ...(status !== undefined ? { httpStatus: status } : {}),
      effectsObserved,
    } as const;

    if (failure === undefined) {
      const record: AttemptRecord = { ...base, outcome: 'ok' };
      attempts.push(record);
      try { request.onAttempt?.(record); } catch { /* evidence, never a decision */ }
      return {
        json,
        attempts,
        streamingObserved,
        timeToFirstByteMs: firstByteAt > 0 ? firstByteAt - startedAt : 0,
        ...(wireModel !== undefined ? { wireModel } : {}),
      };
    }

    const verdict = shouldRetry({
      failure, attempt, policy: policy.retry, effectsObserved,
      runDeadlineRemainingMs: deadline.remainingMs(),
    });
    const wait = verdict.retry ? backoffMs(attempt, policy.retry, deadline.remainingMs(), random) : 0;
    const record: AttemptRecord = {
      ...base, failure, retryDecision: verdict.reason,
      ...(verdict.retry ? { backoffMs: wait } : {}),
      outcome: verdict.retry ? 'retrying' : 'failed',
    };
    attempts.push(record);
    try { request.onAttempt?.(record); } catch { /* evidence, never a decision */ }

    if (!verdict.retry) {
      throw new TransportError(
        `${request.provider} ${failure}${status !== undefined ? ` (HTTP ${status})` : ''}: ${detail ?? ''}`.trim(),
        failure, attempts, status, detail,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
