/**
 * TOOL SCHEMA SANITIZER — make JSON schemas compatible with all providers.
 *
 * Ported from Hermes' schema_sanitizer.py. Fixes schemas that break
 * llama.cpp's json-schema-to-grammar, Ollama, and other strict parsers.
 *
 * Known issues fixed:
 * - {"type": "object"} without properties → adds empty properties
 * - anyOf/oneOf with null union → converts to nullable
 * - array types without items → adds items: {type: "string"}
 * - missing type field → adds type: "object"
 *
 * Usage:
 *   const sanitized = sanitizeToolSchema(rawSchema);
 */

/**
 * Sanitize a JSON Schema for tool parameters.
 * Returns a new schema object (does not mutate the original).
 */
export function sanitizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out = { ...schema };
  return sanitizeNode(out) as Record<string, unknown>;
}

function sanitizeNode(node: unknown): unknown {
  if (node === null || node === undefined || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(sanitizeNode);

  const obj = { ...(node as Record<string, unknown>) };

  // Ensure "type" exists (default to "object" if properties/required exist)
  if (!obj["type"] && (obj["properties"] || obj["required"])) {
    obj["type"] = "object";
  }

  // Fix bare objects without properties
  if (obj["type"] === "object" && !obj["properties"] && !obj["additionalProperties"]) {
    obj["properties"] = {};
    obj["additionalProperties"] = true;
  }

  // Fix bare objects with additionalProperties: false but no properties
  if (obj["type"] === "object" && !obj["properties"] && obj["additionalProperties"] === false) {
    obj["properties"] = {};
  }

  // Fix array types without items
  if (obj["type"] === "array" && !obj["items"]) {
    obj["items"] = { type: "string" };
  }

  // Convert anyOf/oneOf null unions to nullable
  // e.g., {"anyOf": [{"type": "string"}, {"type": "null"}]} → {"type": "string", "nullable": true}
  for (const unionKey of ["anyOf", "oneOf"]) {
    const union = obj[unionKey];
    if (Array.isArray(union) && union.length === 2) {
      const nullEntry = union.find((u: unknown) =>
        typeof u === "object" && u !== null && (u as Record<string, unknown>)["type"] === "null"
      );
      const nonNullEntry = union.find((u: unknown) =>
        typeof u === "object" && u !== null && (u as Record<string, unknown>)["type"] !== "null"
      );
      if (nullEntry && nonNullEntry) {
        // Merge the non-null entry into the parent, add nullable
        const merged = sanitizeNode(nonNullEntry) as Record<string, unknown>;
        Object.assign(obj, merged);
        obj["nullable"] = true;
        delete obj[unionKey];
      }
    }
  }

  // Recurse into properties
  if (obj["properties"] && typeof obj["properties"] === "object") {
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj["properties"] as Record<string, unknown>)) {
      props[key] = sanitizeNode(val);
    }
    obj["properties"] = props;
  }

  // Recurse into items
  if (obj["items"] && typeof obj["items"] === "object") {
    obj["items"] = sanitizeNode(obj["items"]);
  }

  // Recurse into additionalProperties if it's a schema
  if (obj["additionalProperties"] && typeof obj["additionalProperties"] === "object") {
    obj["additionalProperties"] = sanitizeNode(obj["additionalProperties"]);
  }

  return obj;
}

/**
 * Sanitize an entire tool definition array.
 * Input: [{name, description, parameters}, ...]
 * Output: same with sanitized parameters.
 */
export function sanitizeToolDefinitions(
  tools: Array<{ type: string; function: { name: string; description: string; parameters?: Record<string, unknown> } }>
): Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map((tool) => ({
    ...tool,
    function: {
      ...tool.function,
      parameters: tool.function.parameters
        ? sanitizeToolSchema(tool.function.parameters)
        : { type: "object", properties: {}, additionalProperties: true },
    },
  }));
}
