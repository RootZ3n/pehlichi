/**
 * IKBI TOOLS — agent-facing surface over ikbi's HTTP API (Phase 10.3).
 *
 * Three tools that let Peh hand build/fix work to ikbi (the governed build engine)
 * and poll the result:
 *   - ikbi_build  : submit a build task   → returns a taskId (POST /api/build).
 *   - ikbi_fix    : submit a fix task     → returns a taskId (POST /api/fix).
 *   - ikbi_status : poll a task by id, or list recent tasks (GET /api/tasks[/:id]).
 *
 * ikbi runs as a separate HTTP service (default http://localhost:18796, overridable
 * via IKBI_API_URL). Every call is bounded by a timeout and every failure mode
 * (connection refused, timeout, 4xx/5xx, malformed body) becomes a clean
 * `{ ok: false }` tool result with an actionable message — never an unhandled throw —
 * so ikbi being down degrades gracefully instead of aborting Peh's turn.
 */
import type { ToolSpec, ToolHandler, ToolResult } from "../tools.js";

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

/** Default ikbi API base URL; overridable via IKBI_API_URL. */
const DEFAULT_IKBI_API_URL = "http://localhost:18796";

/** Hard timeout for any single ikbi request — a hung service can't stall a turn. */
const IKBI_REQUEST_TIMEOUT_MS = 30_000;

interface IkbiEndpoint {
  readonly url: string;
  readonly token: string | undefined;
  readonly label: string;
}

/**
 * The ordered ikbi endpoints to try: the PRIMARY (IKBI_API_URL — e.g. the lab ikbi over Tailscale),
 * then an optional FALLBACK (IKBI_API_URL_FALLBACK — e.g. an on-device ikbi). A request only falls
 * through to the next endpoint on a CONNECTIVITY failure (unreachable / timeout) — never on a valid
 * HTTP error response — so if "the PC loses connection" Peh transparently uses the local ikbi. Each
 * endpoint has its own bearer (IKBI_API_TOKEN / IKBI_API_TOKEN_FALLBACK); unset ⇒ no auth header.
 */
function ikbiEndpoints(): IkbiEndpoint[] {
  const norm = (u: string): string => u.replace(/\/+$/, "");
  const primary = process.env["IKBI_API_URL"]?.trim();
  const eps: IkbiEndpoint[] = [{
    url: norm(primary && primary.length > 0 ? primary : DEFAULT_IKBI_API_URL),
    token: process.env["IKBI_API_TOKEN"]?.trim() || undefined,
    label: "primary",
  }];
  const fb = process.env["IKBI_API_URL_FALLBACK"]?.trim();
  if (fb && fb.length > 0) {
    eps.push({ url: norm(fb), token: process.env["IKBI_API_TOKEN_FALLBACK"]?.trim() || undefined, label: "fallback" });
  }
  return eps;
}

/** Credential-safe origin of a URL (strips any `user:pass@`) for error messages. */
function originOf(url: string, path = ""): string {
  try {
    return `${new URL(url).origin}${path}`;
  } catch {
    return `${url}${path}`;
  }
}

export const ikbiToolSpecs: ToolSpec[] = [
  {
    name: "ikbi_build",
    description:
      "Submit a build task to ikbi (the governed build engine). Returns a taskId. " +
      "Use ikbi_status to check results.",
    parameters: obj(
      {
        goal: { type: "string", description: "What to build." },
        repo: { type: "string", description: "Absolute path to the repository." },
        builderMode: {
          type: "string",
          enum: ["agent", "patch"],
          description: '"agent" or "patch" (default: "agent").',
        },
      },
      ["goal", "repo"],
    ),
  },
  {
    name: "ikbi_fix",
    description:
      "Submit a fix task to ikbi. ikbi will diagnose and fix failing tests/checks. " +
      "Returns a taskId.",
    parameters: obj(
      {
        repo: { type: "string", description: "Absolute path to the repository." },
        check: { type: "string", description: "The check command to run (default: auto-detect)." },
        goal: { type: "string", description: "Additional context for the fix." },
        allowTestEdits: {
          type: "boolean",
          description: "Allow editing test files (default: false).",
        },
      },
      ["repo"],
    ),
  },
  {
    name: "ikbi_status",
    description:
      "Check the status of an ikbi task. Returns current status, roles completed, cost, " +
      "and result. With no taskId, lists recent tasks.",
    parameters: obj(
      {
        taskId: {
          type: "string",
          description: "Specific task to check. If omitted, lists all recent tasks.",
        },
      },
      [],
    ),
  },
];

/** A JSON HTTP request to ikbi, with timeout + uniform error mapping. */
async function ikbiRequest(
  tool: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const endpoints = ikbiEndpoints();
  const connErrors: string[] = [];

  for (const ep of endpoints) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (ep.token !== undefined) headers["authorization"] = `Bearer ${ep.token}`;
    let response: Response;
    try {
      response = await fetch(`${ep.url}${path}`, {
        method,
        signal: AbortSignal.timeout(IKBI_REQUEST_TIMEOUT_MS),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      // CONNECTIVITY failure (connection refused / DNS / timeout): record it and try the NEXT
      // endpoint (e.g. lab down → on-device ikbi). Credential-safe origin only (no userinfo leak).
      const detail = err instanceof Error && err.name === "TimeoutError"
        ? `no response within ${IKBI_REQUEST_TIMEOUT_MS}ms`
        : err instanceof Error ? err.message : String(err);
      connErrors.push(`${ep.label} ${originOf(ep.url)} (${detail})`);
      continue;
    }

    // A real HTTP response — parse and return it (success OR error). We do NOT fall back on a
    // 4xx/5xx: a reachable ikbi that rejects the request is a genuine result, not a connectivity gap.
    const text = await response.text().catch(() => "");
    let data: unknown = undefined;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text; // non-JSON body (e.g. an HTML error page) — keep it for context.
      }
    }
    if (!response.ok) {
      const serverMsg =
        data !== null && typeof data === "object" && "error" in (data as Record<string, unknown>)
          ? String((data as Record<string, unknown>).error)
          : typeof data === "string" && data.length > 0
            ? data
            : response.statusText;
      return { ok: false, error: `${tool}: ikbi returned ${response.status} ${serverMsg}`.trim() };
    }
    return { ok: true, data };
  }

  // Every endpoint was unreachable.
  return {
    ok: false,
    error: `${tool}: cannot reach ikbi — tried ${connErrors.join("; ")}. Is an ikbi service running (lab or on-device)?`,
  };
}

/** Pull a taskId out of an ikbi submit response, accepting a couple of shapes. */
function extractTaskId(data: unknown): string | undefined {
  if (data !== null && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    const id = rec.taskId ?? rec.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

export function createIkbiToolHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set("ikbi_build", async (args): Promise<ToolResult> => {
    const goal = (args.goal as string)?.trim();
    const repo = (args.repo as string)?.trim();
    if (!goal) return { ok: false, output: "", error: "ikbi_build requires a goal" };
    if (!repo) return { ok: false, output: "", error: "ikbi_build requires a repo (absolute path)" };
    const builderMode = (args.builderMode as string)?.trim() || "agent";
    if (builderMode !== "agent" && builderMode !== "patch") {
      return { ok: false, output: "", error: `ikbi_build: builderMode must be "agent" or "patch" (got "${builderMode}")` };
    }

    const res = await ikbiRequest("ikbi_build", "POST", "/api/build", { goal, repo, builderMode });
    if (!res.ok) return { ok: false, output: "", error: res.error };

    const taskId = extractTaskId(res.data);
    if (!taskId) {
      return { ok: false, output: "", error: `ikbi_build: ikbi accepted the request but returned no taskId: ${JSON.stringify(res.data)}` };
    }
    return {
      ok: true,
      output: `ikbi build submitted — taskId: ${taskId}\n  goal: ${goal}\n  repo: ${repo}\n  mode: ${builderMode}\nUse ikbi_status with this taskId to check progress.`,
    };
  });

  handlers.set("ikbi_fix", async (args): Promise<ToolResult> => {
    const repo = (args.repo as string)?.trim();
    if (!repo) return { ok: false, output: "", error: "ikbi_fix requires a repo (absolute path)" };
    const check = (args.check as string)?.trim();
    const goal = (args.goal as string)?.trim();
    const allowTestEdits = args.allowTestEdits === true;

    const body: Record<string, unknown> = { repo, allowTestEdits };
    if (check) body.check = check;
    if (goal) body.goal = goal;

    const res = await ikbiRequest("ikbi_fix", "POST", "/api/fix", body);
    if (!res.ok) return { ok: false, output: "", error: res.error };

    const taskId = extractTaskId(res.data);
    if (!taskId) {
      return { ok: false, output: "", error: `ikbi_fix: ikbi accepted the request but returned no taskId: ${JSON.stringify(res.data)}` };
    }
    return {
      ok: true,
      output: `ikbi fix submitted — taskId: ${taskId}\n  repo: ${repo}${check ? `\n  check: ${check}` : ""}${goal ? `\n  goal: ${goal}` : ""}\n  allowTestEdits: ${allowTestEdits}\nUse ikbi_status with this taskId to check progress.`,
    };
  });

  handlers.set("ikbi_status", async (args): Promise<ToolResult> => {
    const taskId = (args.taskId as string)?.trim();
    if (taskId) {
      const res = await ikbiRequest("ikbi_status", "GET", `/api/tasks/${encodeURIComponent(taskId)}`);
      if (!res.ok) return { ok: false, output: "", error: res.error };
      return { ok: true, output: JSON.stringify(res.data, null, 2) };
    }

    const res = await ikbiRequest("ikbi_status", "GET", "/api/tasks?limit=10");
    if (!res.ok) return { ok: false, output: "", error: res.error };
    return { ok: true, output: JSON.stringify(res.data, null, 2) };
  });

  return handlers;
}
