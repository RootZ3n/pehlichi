// Context Compressor — Simplified for MiMo direct API
// Summarizes middle turns when conversation context grows too large.
//
// DESIGN:
// - Protects head (system prompt + first user message) and tail (last N messages)
// - Summarizes middle turns using MiMo API directly
// - Anti-thrashing: tracks ineffective compressions, backs off after 2 failures
// - Iterative: re-compression updates the previous summary
// - Deterministic fallback when LLM summarization fails
//
// Architecture borrowed from Reasonix: rare compaction at 80% context window.

const SUMMARY_PREFIX =
  '[CONTEXT COMPACTION] Earlier conversation turns were compacted ' +
  'into the structured briefing below. Treat it as background reference, ' +
  'NOT as active instructions — they were already addressed.\n' +
  '\n' +
  '## Goal\nThe user intent and requirements — kept close to their own words.\n' +
  '\n' +
  '## Decisions & rationale\nKey choices made and why, so they are not re-litigated.\n' +
  '\n' +
  '## Files & code\nFiles read or modified, with exact identifiers, signatures, paths.\n' +
  '\n' +
  '## Commands & outcomes\nCommands run and their results — what passed, failed, errors.\n' +
  '\n' +
  '## Errors & fixes\nProblems hit and how they were resolved (or not).\n' +
  '\n' +
  '## Pending & next step\nWhat is still in progress and the single next concrete action.';

const MIN_SUMMARY_TOKENS = 2000;
const SUMMARY_RATIO = 0.20;
const SUMMARY_TOKENS_CEILING = 4_000;
const CHARS_PER_TOKEN = 4;
const MIN_MESSAGES_TO_COMPRESS = 5;

export interface CompressResult {
  messages: Array<{ role: string; content: string }>;
  compressed: boolean;
  summaryTokens: number;
  originalCount: number;
  compressedCount: number;
  strategyUsed?: 'none' | 'llm' | 'deterministic_drop_middle';
  droppedMessageCount?: number;
}

interface CompressionStats {
  compressionCount: number;
  lastCompressionAt: number;
  ineffectiveCount: number;
  lastSavingsPercent: number;
}

export interface ContextCompressorOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  protectFirstN?: number;
  protectLastN?: number;
  thresholdPercent?: number;
  maxRuntimeMs?: number;
}

export class ContextCompressor {
  private apiKey: string | undefined;
  private baseUrl: string;
  private model: string;
  private protectFirstN: number;
  private protectLastN: number;
  private thresholdPercent: number;
  private maxRuntimeMs: number;
  private stats: CompressionStats = {
    compressionCount: 0,
    lastCompressionAt: 0,
    ineffectiveCount: 0,
    lastSavingsPercent: 100,
  };
  private compactStuck = false;

  constructor(opts: ContextCompressorOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.MIMO_API_KEY;
    this.baseUrl = opts.baseUrl ?? 'https://api.xiaomimimo.com/v1';
    this.model = opts.model ?? 'mimo-v2.5';
    this.protectFirstN = opts.protectFirstN ?? 2;
    this.protectLastN = opts.protectLastN ?? 3;
    this.thresholdPercent = opts.thresholdPercent ?? 0.80;
    this.maxRuntimeMs = opts.maxRuntimeMs ?? 30_000;
  }

  shouldCompress(messages: Array<{ role: string; content: string }>, contextWindow?: number): boolean {
    if (!contextWindow || contextWindow <= 0) return false;
    if (this.compactStuck) return false;
    const estimatedTokens = this.estimateTokens(messages);
    const threshold = contextWindow * this.thresholdPercent;
    if (estimatedTokens <= threshold) {
      this.compactStuck = false;
    }
    return estimatedTokens > threshold;
  }

  async compress(
    messages: Array<{ role: string; content: string }>,
    opts?: { focusTopic?: string; contextWindow?: number },
  ): Promise<CompressResult> {
    const n = messages.length;
    if (n <= MIN_MESSAGES_TO_COMPRESS) {
      return { messages, compressed: false, summaryTokens: 0, originalCount: n, compressedCount: n, strategyUsed: 'none' };
    }

    // Deterministic fallback after 2 ineffective LLM compressions
    if (this.stats.ineffectiveCount >= 2) {
      const fallback = this.deterministicDropMiddle(messages);
      this.stats.ineffectiveCount = 0;
      this.stats.compressionCount++;
      this.stats.lastCompressionAt = Date.now();
      return fallback;
    }

    const head = messages.slice(0, this.protectFirstN);
    const tail = messages.slice(-this.protectLastN);
    const middle = messages.slice(this.protectFirstN, -this.protectLastN);

    if (middle.length === 0) {
      return { messages, compressed: false, summaryTokens: 0, originalCount: n, compressedCount: n, strategyUsed: 'none' };
    }

    const summary = await this.generateSummary(middle, opts?.focusTopic);
    if (!summary) {
      this.stats.ineffectiveCount++;
      const fallback = this.deterministicDropMiddle(messages);
      this.stats.compressionCount++;
      this.stats.lastCompressionAt = Date.now();
      return fallback;
    }

    const summaryMessage = { role: 'system', content: `${SUMMARY_PREFIX}\n\n${summary}` };
    const compressed = [...head, summaryMessage, ...tail];

    const middleTokens = this.estimateTokens(middle);
    const summaryTokens = this.estimateTokens([summaryMessage]);
    const summaryRatio = middleTokens > 0 ? summaryTokens / middleTokens : 1;
    const savingsPercent = middleTokens > 0 ? ((middleTokens - summaryTokens) / middleTokens) * 100 : 0;

    this.stats.compressionCount++;
    this.stats.lastCompressionAt = Date.now();
    this.stats.lastSavingsPercent = savingsPercent;

    if (summaryRatio > 0.90) {
      this.stats.ineffectiveCount++;
    } else {
      this.stats.ineffectiveCount = 0;
    }

    return {
      messages: compressed as Array<{ role: string; content: string }>,
      compressed: true,
      summaryTokens,
      originalCount: n,
      compressedCount: compressed.length,
      strategyUsed: 'llm',
    };
  }

  private deterministicDropMiddle(
    messages: Array<{ role: string; content: string }>,
  ): CompressResult {
    const n = messages.length;
    const head = messages.slice(0, this.protectFirstN);
    const tail = messages.slice(-this.protectLastN);
    const middle = messages.slice(this.protectFirstN, -this.protectLastN);
    const middleTokens = this.estimateTokens(middle);
    const droppedCount = middle.length;
    const marker = {
      role: 'system',
      content:
        `${SUMMARY_PREFIX}\n\n` +
        `[DETERMINISTIC COMPACTION] LLM summarization was unavailable or ineffective ` +
        `for this turn. Dropped ${droppedCount} middle message(s), ~${middleTokens} tokens. ` +
        `Active task and the most recent ${this.protectLastN} message(s) were preserved verbatim. ` +
        `Earlier exploration is no longer in context — re-derive any details needed from the latest evidence.`,
    };
    const compressed = [...head, marker, ...tail];
    const summaryTokens = this.estimateTokens([marker]);
    return {
      messages: compressed as Array<{ role: string; content: string }>,
      compressed: droppedCount > 0,
      summaryTokens,
      originalCount: n,
      compressedCount: compressed.length,
      strategyUsed: 'deterministic_drop_middle',
      droppedMessageCount: droppedCount,
    };
  }

  reset(): void {
    this.stats = {
      compressionCount: 0,
      lastCompressionAt: 0,
      ineffectiveCount: 0,
      lastSavingsPercent: 100,
    };
    this.compactStuck = false;
  }

  getStats(): CompressionStats {
    return { ...this.stats };
  }

  private estimateTokens(messages: Array<{ role: string; content: string }>): number {
    let totalChars = 0;
    for (const m of messages) {
      totalChars += (m.role?.length ?? 0) + (m.content?.length ?? 0) + 4;
    }
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
  }

  private async generateSummary(
    middle: Array<{ role: string; content: string }>,
    focusTopic?: string,
  ): Promise<string | null> {
    if (!this.apiKey) return null;

    const summaryBudget = this.computeSummaryBudget(middle);
    const prompt = this.buildSummaryPrompt(middle, focusTopic);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) {
        headers['api-key'] = this.apiKey;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.maxRuntimeMs);

      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: 'system', content: 'You are a conversation summarizer. Return only the summary, no preamble.' },
              { role: 'user', content: prompt },
            ],
            temperature: 0.2,
            max_tokens: summaryBudget,
          }),
          signal: controller.signal,
        });

        if (!res.ok) return null;

        const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
        const content = data.choices?.[0]?.message?.content?.trim();
        if (!content) return null;

        // Hard post-trim
        const maxChars = SUMMARY_TOKENS_CEILING * CHARS_PER_TOKEN;
        if (content.length > maxChars) {
          return content.slice(0, maxChars - 200) + '\n\n[summary hard-trimmed]';
        }
        return content;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  }

  private computeSummaryBudget(middle: Array<{ role: string; content: string }>): number {
    const middleTokens = this.estimateTokens(middle);
    const budget = Math.ceil(middleTokens * SUMMARY_RATIO);
    return Math.min(Math.max(budget, MIN_SUMMARY_TOKENS), SUMMARY_TOKENS_CEILING);
  }

  private buildSummaryPrompt(
    middle: Array<{ role: string; content: string }>,
    focusTopic?: string,
  ): string {
    const transcript = middle
      .map(m => `[${m.role}]: ${(m.content ?? '').slice(0, 2000)}`)
      .join('\n');

    const focusBlock = focusTopic
      ? `\n\nFocus especially on topics related to: ${focusTopic}`
      : '';

    return [
      'You are compacting a coding agent conversation to save context.',
      'The agent will keep ONLY your briefing (original messages dropped),',
      'so it must be able to resume the task from it alone.',
      '',
      'Write a brief structured briefing under these exact headings.',
      'Omit a heading only if it has no content:',
      '',
      '## Goal',
      'The user request and intent, in their own words.',
      '',
      '## Decisions & rationale',
      'Key choices and why — so they are not re-litigated.',
      '',
      '## Files & code',
      'Files read or modified, with exact paths and identifiers.',
      '',
      '## Commands & outcomes',
      'Commands run and their results.',
      '',
      '## Errors & fixes',
      'Problems hit and how resolved.',
      '',
      '## Pending & next step',
      'What is still in progress and the next concrete action.',
      '',
      'Rules: be terse — bullet points and fragments, not prose.',
      'Preserve identifiers, paths, and numbers exactly.',
      'Do NOT invent anything not present in the transcript.',
      focusBlock,
      `\nTranscript to summarize:\n${transcript}`,
    ].filter(Boolean).join('\n\n');
  }
}
