/**
 * PROMPT INJECTION DEFENSE — multi-scope pattern detection.
 *
 * Ported from Hermes' threat_patterns.py + message_sanitization.py.
 * Three scopes with increasing sensitivity:
 *   all:     narrow — catches obvious injection in any input
 *   context: medium — for user messages and tool outputs
 *   strict:  broad — for memory writes, skill creation, any persistent storage
 *
 * Usage:
 *   const result = scanForInjection(userInput, "context");
 *   if (result.detected) block(result.patterns);
 */

export type ScanScope = "all" | "context" | "strict";

export interface ScanResult {
  detected: boolean;
  patterns: string[];
  scope: ScanScope;
}

interface ThreatPattern {
  name: string;
  pattern: RegExp;
  scopes: ScanScope[];
}

/**
 * 25+ threat patterns organized by attack class.
 * Each pattern has a name and which scopes it applies to.
 */
const THREAT_PATTERNS: ThreatPattern[] = [
  // ── Classic injection ──
  {
    name: "ignore-instructions",
    pattern: /(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions|prompts|rules|directives|guidelines)/i,
    scopes: ["all", "context", "strict"],
  },
  {
    name: "you-are-now",
    pattern: /you\s+are\s+now\s+(?:a|an|the|my)\s+(?:assistant|bot|agent|ai|model|system|admin|root|god)/i,
    scopes: ["all", "context", "strict"],
  },
  {
    name: "new-instructions",
    pattern: /(?:new|updated|revised|different)\s+(?:instructions|prompt|rules|directives|system\s*prompt)/i,
    scopes: ["context", "strict"],
  },
  {
    name: "system-prompt-override",
    pattern: /(?:system\s*prompt|system\s*message)\s*(?:is|was|equals?|=)\s*[:"]/i,
    scopes: ["all", "context", "strict"],
  },

  // ── Role-play / identity hijack ──
  {
    name: "pretend-role",
    pattern: /(?:pretend|act|behave|imagine|suppose)\s+(?:you\s+are|you're|as\s+if)\s+(?:a|an|the)?\s*(?:unrestricted|unfiltered|jailbroken|evil|malicious)/i,
    scopes: ["all", "context", "strict"],
  },
  {
    name: "developer-mode",
    pattern: /(?:developer|debug|admin|sudo|root|god|DAN)\s*(?:mode|access|override|bypass)/i,
    scopes: ["all", "context", "strict"],
  },
  {
    name: "do-anything-now",
    pattern: /\bDAN\b|\bdo\s+anything\s+now\b/i,
    scopes: ["context", "strict"],
  },

  // ── C2 / promptware ──
  {
    name: "brainworm-persistence",
    pattern: /(?:remember|store|save|cache|persist)\s+(?:this|the\s+following)\s+(?:forever|always|permanently|in\s+(?:all|every)\s+(?:session|conversation))/i,
    scopes: ["strict"],
  },
  {
    name: "exfiltrate-data",
    pattern: /(?:send|exfiltrate|leak|dump|export|transmit)\s+(?:all|every|any)?\s*(?:data|info|memory|context|history|conversation)\s+(?:to|towards?|via)/i,
    scopes: ["all", "context", "strict"],
  },
  {
    name: "hidden-instruction",
    pattern: /<(?:system|assistant|user)\s*>[^<]*(?:ignore|override|forget|disregard)/i,
    scopes: ["all", "context", "strict"],
  },

  // ── Tag injection ──
  {
    name: "fake-system-tag",
    pattern: /<\/?(?:system|SYSTEM|System)>/,
    scopes: ["all", "context", "strict"],
  },
  {
    name: "fake-tool-tag",
    pattern: /<\/?(?:tool|TOOL|Tool|function_call|FUNCTION_CALL)>/,
    scopes: ["context", "strict"],
  },
  {
    name: "markdown-code-escape",
    pattern: /```(?:system|admin|root|override|prompt)/i,
    scopes: ["context", "strict"],
  },

  // ── Prompt leaking ──
  {
    name: "reveal-prompt",
    pattern: /(?:reveal|show|display|print|output|repeat|echo|dump)\s+(?:your|the|system)\s+(?:prompt|instructions|rules|initial\s+message|first\s+message)/i,
    scopes: ["all", "context", "strict"],
  },
  {
    name: "what-are-your-instructions",
    pattern: /what\s+(?:are|were|is)\s+your\s+(?:initial|original|system|first)\s+(?:instructions|prompt|message|rules|directives)/i,
    scopes: ["context", "strict"],
  },

  // ── Soft injection / social engineering ──
  {
    name: "soft-injection",
    pattern: /(?:between\s+you\s+and\s+me|just\s+between\s+us|off\s+the\s+record|don'?t\s+tell\s+anyone|this\s+is\s+secret|let'?s\s+keep\s+this\s+between\s+us|private\s+conversation\s+only)/i,
    scopes: ["all", "context", "strict"],
  },
  {
    name: "capability-probe",
    pattern: /(?:list\s+(?:all\s+)?(?:your|every)\s+(?:tools?|capabilities|abilities|functions|endpoints?)|what\s+(?:can|do)\s+you\s+(?:actually\s+)?(?:have|own|possess)\s+(?:in\s+terms\s+of|as)\s+(?:tools?|capabilities))/i,
    scopes: ["context", "strict"],
  },

  // ── Code execution attempts ──
  {
    name: "inline-code-exec",
    pattern: /(?:eval|exec|subprocess|os\.system|__import__|require\s*\(|child_process|spawn|popen)\s*\(/i,
    scopes: ["strict"],
  },
  {
    name: "shell-injection",
    pattern: /[;&|`$]\s*(?:rm\s+-rf|curl\s|wget\s|chmod|chown|mkfs|dd\s+if=)/i,
    scopes: ["strict"],
  },

  // ── Multi-word bypass prevention ──
  {
    name: "spaced-injection",
    pattern: /i\s+g\s+n\s+o\s+r\s+e\s+(?:p\s+r\s+e\s+v\s+i\s+o\s+u\s+s|a\s+l\s+l)/i,
    scopes: ["context", "strict"],
  },
  {
    name: "unicode-bypass",
    pattern: /(?:\u200B|\u200C|\u200D|\u2060|\u2061|\u2062|\u2063|\u2064|\uFEFF|\u00AD|\u034F|\u061C|\u115F|\u1160|\u17B4|\u17B5|\u180E)/,
    scopes: ["all", "context", "strict"],
  },

  // ── Credential/key extraction ──
  {
    name: "extract-api-key",
    pattern: /(?:give|send|show|reveal|output|print)\s+(?:me\s+)?(?:your|the|any)?\s*(?:api[_\s-]?key|secret|token|password|credential)/i,
    scopes: ["all", "context", "strict"],
  },
  {
    name: "env-var-probe",
    pattern: /(?:echo|print|cat|read|get|access)\s+(?:\$|%\s*)?(?:API_KEY|SECRET|TOKEN|PASSWORD|OPENAI|MIMO|OPENROUTER)/i,
    scopes: ["all", "context", "strict"],
  },

  // ── Social engineering ──
  {
    name: "authority-claim",
    pattern: /(?:I\s+(?:am|'m)\s+(?:a\s+)?(?:developer|admin|creator|owner|maintainer|developer)\s+(?:of|for)\s+(?:this|your)\s+(?:system|model|ai|agent))/i,
    scopes: ["context", "strict"],
  },
  {
    name: "urgency-manipulation",
    pattern: /(?:emergency|urgent|critical|immediately|right\s+now)\s+(?:override|bypass|ignore|disable)\s+(?:safety|security|filter|restriction)/i,
    scopes: ["all", "context", "strict"],
  },

  // ── Encoding attacks ──
  {
    name: "base64-encoded-instruction",
    pattern: /(?:decode|execute|run|interpret)\s+(?:this|the\s+following)\s+(?:base64|hex|rot13|encoded)/i,
    scopes: ["context", "strict"],
  },
  {
    name: "hex-escape-injection",
    pattern: /\\x[0-9a-fA-F]{2}(?:\\x[0-9a-fA-F]{2}){3,}/,
    scopes: ["strict"],
  },
];

/**
 * Scan text for prompt injection patterns.
 * Returns which patterns matched for the given scope.
 */
export function scanForInjection(text: string, scope: ScanScope = "context"): ScanResult {
  if (!text || text.length === 0) return { detected: false, patterns: [], scope };

  // Scope hierarchy: strict includes context, context includes all
  const activeScopes: ScanScope[] = scope === "strict"
    ? ["all", "context", "strict"]
    : scope === "context"
      ? ["all", "context"]
      : ["all"];

  const matched: string[] = [];

  for (const tp of THREAT_PATTERNS) {
    // Check if this pattern applies to the requested scope
    if (!tp.scopes.some((s) => activeScopes.includes(s))) continue;
    if (tp.pattern.test(text)) {
      matched.push(tp.name);
    }
  }

  return {
    detected: matched.length > 0,
    patterns: matched,
    scope,
  };
}

/**
 * Scan for invisible/bidirectional unicode characters.
 * These are used in injection attacks to hide text from visual inspection.
 */
const INVISIBLE_CHARS = /[\u200B\u200C\u200D\u2060\u2061\u2062\u2063\u2064\uFEFF\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069]/g;

export function detectInvisibleChars(text: string): { found: boolean; count: number; cleaned: string } {
  const matches = text.match(INVISIBLE_CHARS);
  return {
    found: matches !== null && matches.length > 0,
    count: matches?.length ?? 0,
    cleaned: text.replace(INVISIBLE_CHARS, ""),
  };
}

/** Strip all invisible/bidirectional characters from text. */
export function sanitizeUnicode(text: string): string {
  return text.replace(INVISIBLE_CHARS, "");
}
