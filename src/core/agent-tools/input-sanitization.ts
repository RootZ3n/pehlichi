/**
 * INPUT SANITIZATION — safe text processing for model I/O.
 *
 * Ported from Hermes' message_sanitization.py.
 * Handles: surrogate code points, malformed JSON repair, control chars,
 * non-ASCII stripping for ASCII-only systems.
 *
 * Usage:
 *   const safe = sanitizeMessage(rawText);
 *   const repaired = repairJson(brokenJsonString);
 */

/**
 * Replace lone surrogates (U+D800..U+DFFF) with U+FFFD.
 * These are invalid in UTF-8 and can cause downstream errors.
 */
export function replaceSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}

/**
 * Strip non-ASCII characters (for systems that require ASCII-only).
 */
export function stripNonAscii(text: string): string {
  return text.replace(/[^\x20-\x7E\n\r\t]/g, "");
}

/**
 * Sanitize control characters in text.
 * Preserves \n, \r, \t; replaces everything else with space.
 */
export function sanitizeControlChars(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ");
}

/**
 * Cap text to a maximum byte length (UTF-8).
 * Returns the truncated text with a marker if truncated.
 */
export function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  const head = buf.subarray(0, maxBytes).toString("utf8");
  return { text: `${head}\n[truncated: ${buf.byteLength} bytes → ${maxBytes}]`, truncated: true };
}

/**
 * Attempt to repair malformed JSON from model output.
 * Handles: trailing commas, unclosed structures, control chars, markdown fences.
 */
export function repairJson(raw: string): { repaired: string; fixed: boolean } {
  let text = raw.trim();

  // Extract from markdown fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    text = fenceMatch[1].trim();
  }

  // Find the first { and last } (or [ and ])
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");

  // Try object first, then array
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  } else if (firstBracket !== -1 && lastBracket > firstBracket) {
    text = text.slice(firstBracket, lastBracket + 1);
  }

  // Sanitize control chars inside the JSON
  text = sanitizeControlChars(text);

  // Fix trailing commas before } or ]
  text = text.replace(/,\s*([}\]])/g, "$1");

  // Fix missing closing brackets (common with truncated output)
  const openBraces = (text.match(/{/g) || []).length;
  const closeBraces = (text.match(/}/g) || []).length;
  const openBrackets = (text.match(/\[/g) || []).length;
  const closeBrackets = (text.match(/]/g) || []).length;

  let repaired = text;
  for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += "]";
  for (let i = 0; i < openBraces - closeBraces; i++) repaired += "}";

  // Validate
  try {
    JSON.parse(repaired);
    return { repaired, fixed: repaired !== raw.trim() };
  } catch {
    return { repaired: raw.trim(), fixed: false };
  }
}

/**
 * Full message sanitization pipeline.
 * Run this on any text before sending to a model.
 */
export function sanitizeMessage(text: string): string {
  let out = text;
  out = replaceSurrogates(out);
  out = sanitizeControlChars(out);
  return out;
}

/**
 * Sanitize tool output before feeding back to the model.
 * More aggressive than message sanitization.
 */
export function sanitizeToolOutput(text: string, maxBytes: number = 32_768): string {
  let out = text;
  out = replaceSurrogates(out);
  out = sanitizeControlChars(out);
  const capped = capBytes(out, maxBytes);
  return capped.text;
}
