/**
 * TOOL-CALL ARGUMENT REPAIR (P1.2) — small local models frequently emit tool-call arguments
 * that are ALMOST valid JSON: a trailing comma, single quotes, a ```json fence, Python
 * literals (True/False/None). The live MiMo driver previously did a bare `JSON.parse` and
 * failed the whole turn on any of these. Following Dirge's rule — "try the input just as it
 * is, then attempt to correct the parts that the schema rejected so that valid inputs never
 * get rewritten" — this repairs ONLY after a strict parse fails, and never touches input
 * that already parses. Irreparable input still fails loud (the caller throws a clear error).
 */

export interface ParsedArgs {
  readonly value: Record<string, unknown>;
  /** True when a repair was needed to parse (valid input is never rewritten ⇒ false). */
  readonly repaired: boolean;
}

/**
 * Parse tool-call arguments, repairing common near-JSON defects only if the strict parse
 * fails. Returns null when the input cannot be coerced to a JSON object by any repair, so the
 * caller can fail loud with its own message. An empty/whitespace string parses to `{}`.
 */
export function parseToolArguments(raw: string): ParsedArgs | null {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: {}, repaired: false };

  // 1) Strict first — valid input is NEVER rewritten.
  const strict = tryObject(trimmed);
  if (strict !== null) return { value: strict, repaired: false };

  // 2) Repair candidates, cheapest first. Each is tried independently AND cumulatively.
  for (const candidate of repairCandidates(trimmed)) {
    const parsed = tryObject(candidate);
    if (parsed !== null) return { value: parsed, repaired: true };
  }
  return null;
}

/** JSON.parse that only accepts a plain object (arrays/scalars are not valid tool args). */
function tryObject(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

/** Ordered repair attempts. Later entries apply more (cumulative) fixes. */
function repairCandidates(s: string): string[] {
  const out: string[] = [];

  // a) strip a ```json … ``` (or bare ```) fence.
  const unfenced = stripFence(s);
  if (unfenced !== s) out.push(unfenced);

  // b) extract the outermost { … } span (drops any prose around the object).
  const span = outermostObject(unfenced);
  if (span !== null && span !== unfenced) out.push(span);

  // c) on the best structural candidate, apply token-level fixes: Python literals,
  //    trailing commas, then single→double quotes.
  const base = span ?? unfenced;
  const pyFixed = base
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null");
  if (pyFixed !== base) out.push(pyFixed);

  const noTrailingCommas = pyFixed.replace(/,(\s*[}\]])/g, "$1");
  if (noTrailingCommas !== pyFixed) out.push(noTrailingCommas);

  // single quotes → double quotes (only when there are no double quotes to corrupt).
  if (!noTrailingCommas.includes('"') && noTrailingCommas.includes("'")) {
    out.push(noTrailingCommas.replace(/'/g, '"'));
  }
  // combined: quotes + trailing commas + python literals together.
  const combined = noTrailingCommas.includes('"')
    ? noTrailingCommas
    : noTrailingCommas.replace(/'/g, '"');
  if (combined !== base) out.push(combined);

  return out;
}

/** Remove a leading/trailing markdown code fence, if present. */
function stripFence(s: string): string {
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m && m[1] !== undefined ? m[1].trim() : s;
}

/** The substring from the first `{` to its matching-ish last `}` (outermost object span). */
function outermostObject(s: string): string | null {
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  return s.slice(first, last + 1);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
