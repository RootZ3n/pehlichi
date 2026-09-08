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

/**
 * RETIRED: `ikbi_build` and `ikbi_fix`.
 *
 * Both submitted work to `POST /api/build`, which ikbi removed with its v1 engine. The route still
 * answered 202 with a taskId and only then failed inside its worker, so a model calling it received
 * something that looked exactly like an accepted build — the worst possible failure shape. It is
 * now a hard 404, and the governed implementation path is `delegate_implementation`, which runs
 * ikbi's canonical v2 engine with a declared mutation scope and supervises the evidence.
 *
 * They are removed from the assembled schema rather than shimmed. A shim would have to map a
 * scope-free `{goal, repo}` onto an engine that refuses to start without an explicit mutation
 * scope, and the only way to do that is to invent the scope — which is the exact widening the
 * whole design exists to prevent. `createIkbiToolHandlers` still answers to both names with a
 * typed refusal, so anything holding a stale reference is told plainly rather than served.
 *
 * `ikbi_status` stays: `GET /api/tasks[/:id]` is still served.
 */
export const ikbiToolSpecs: ToolSpec[] = [
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

/** The names this module will not serve, and what replaced them. */
export const RETIRED_IKBI_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  ikbi_build: 'ikbi_build was retired with ikbi\'s v1 HTTP build engine (POST /api/build is now 404). '
    + 'Use delegate_implementation, which runs the canonical v2 engine with an explicit mutation scope '
    + 'and deterministic acceptance checks.',
  ikbi_fix: 'ikbi_fix was retired with ikbi\'s v1 HTTP build engine (POST /api/build is now 404). '
    + 'Use delegate_implementation with the failing check as an acceptance check.',
});


/** A JSON HTTP request to ikbi, with timeout + uniform error mapping. */
/**
 * Is the HTTP build surface live, per ikbi's OWN authoritative declaration?
 *
 * `/capabilities` lists the endpoints ikbi currently serves. `/api/build` was removed from that
 * list when the v1 build engine was retired, even though the route still 202s and then fails in its
 * worker. So "does the declared surface include a build endpoint?" is the honest, forward-compatible
 * check: if ikbi ever restores HTTP build it re-appears here and this returns available again, with
 * no client change and no hardcoded retirement.
 *
 * Fails CLOSED. If capabilities cannot be read, build is reported unavailable rather than optimistic
 * — submitting a doomed task is the behaviour being removed.
 */
async function ikbiBuildAvailability(): Promise<{ status: "available" | "retired" | "unreachable"; detail: string }> {
  const res = await ikbiRequest("ikbi_build", "GET", "/capabilities");
  if (!res.ok) return { status: "unreachable", detail: `ikbi capabilities could not be read: ${res.error}` };
  const data = res.data as { endpoints?: unknown; tools?: unknown } | null;
  const endpoints = Array.isArray(data?.endpoints) ? data.endpoints.map(String) : [];
  const tools = Array.isArray(data?.tools) ? data.tools.map(String) : [];
  const declaresBuild =
    endpoints.some((e) => /\/(api\/)?build\b/.test(e)) || tools.some((t) => /(^|_)build$/.test(t));
  return declaresBuild
    ? { status: "available", detail: "the declared surface includes a build endpoint" }
    : { status: "retired", detail: "ikbi's declared endpoints do not include an HTTP build surface" };
}

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
  const retired = new Map<string, ToolHandler>();
  for (const [name, why] of Object.entries(RETIRED_IKBI_TOOLS)) {
    retired.set(name, async (): Promise<ToolResult> => ({ ok: false, output: '', error: why }));
  }

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

    // FAIL FAST ON A RETIRED SURFACE.
    //
    // `POST /api/build` still returns 202 with a taskId, then its worker throws "HTTP build tasks
    // are retired" — so submitting looks like success and can only fail downstream. `ikbi_build`
    // must not report accepted work for a task that cannot run. The authoritative live signal is
    // ikbi's own `/capabilities`, whose declared `endpoints` list no longer contains `/api/build`.
    // So the surface is checked before anything is submitted, and a retired build is a typed
    // terminal result naming the CLI replacement rather than a doomed task id.
    //
    // This resurrects nothing, redirects nothing, and hides nothing: it reports the retirement.
    const buildAvailability = await ikbiBuildAvailability();
    if (buildAvailability.status !== "available") {
      // The typed classification travels in the error text the model reads. RETIRED and UNREACHABLE
      // are distinct: the first is a permanent product fact with a named replacement, the second is
      // a transient connectivity gap. Neither reports accepted work.
      return {
        ok: false,
        output: "",
        error:
          `ikbi_build UNAVAILABLE [${buildAvailability.status}]: ${buildAvailability.detail}. `
          + `The HTTP build endpoint is retired; the canonical build engine is the ikbi CLI: `
          + `ikbi build "<goal>" --repo <path>. No task was submitted, so there is nothing to poll.`,
      };
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

  for (const [name, h] of retired) handlers.set(name, h);
  return handlers;
}
