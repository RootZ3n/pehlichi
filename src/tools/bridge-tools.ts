/**
 * BRIDGE TOOLS — generic bridge operations for all agents.
 *
 * These tools let agents interact with any ecosystem service via bridges.
 * Registered via the core's tool-registration seam (extraTools).
 *
 * Services: pehlichi, mechanic, artist, ikbi, toba, nusika, howa, kokuli, luak, ittunaha
 */
import { randomUUID } from "node:crypto";
import type { ToolSpec } from "../core/driver.js";
import type { ToolHandler, ToolResult } from "../core/tools.js";
import { readVerifiedExternalData } from '../core/external-runtime-integrity.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

/**
 * Behaviour-preserving fallback map — the ports Peh used before the canonical
 * lab-registry existed. This is what keeps standalone / release-mode working
 * when the shared registry file is absent: if nothing can be read, these exact
 * values are used, so behaviour never regresses. Includes the legacy aliases
 * (mechanic, artist) that existing skills and tests still call by name.
 */
const DEFAULT_SERVICE_PORTS: Record<string, number> = {
  pehlichi: 18830,
  mechanic: 18810,
  artist: 18792,
  ptah: 18810,
  luna: 18792,
  ikbi: 18796,
  toba: 18815,
  nusika: 18793,
  howa: 18799,
  kokuli: 18800,
  luak: 18795,
  ittunaha: 18821,
};

/** Shape of one entry in the canonical lab-registry services.json (DATA, not a package). */
interface RegistryService {
  readonly id: string;
  readonly port?: number | null;
  readonly aliases?: readonly string[];
}

/**
 * Overlay the canonical lab service registry onto the fallback map. The registry
 * is the single source of truth in the lab; we read it as DATA (a JSON file),
 * never as a cross-repo runtime import — so Peh keeps owning her own core. If the
 * registry cannot be read (released standalone build, missing file, bad JSON) we
 * silently keep the defaults. Resolved once at module load.
 */
function loadServicePortMap(): Record<string, number> {
  const ports: Record<string, number> = { ...DEFAULT_SERVICE_PORTS };
  const bytes = readVerifiedExternalData('lab-registry', 'services.json');
  if (bytes === null) return ports;
  const parsed = JSON.parse(bytes) as { services?: readonly RegistryService[] };
  for (const svc of parsed.services ?? []) {
    if (typeof svc.port === "number" && svc.port > 0) {
      ports[svc.id] = svc.port;
      for (const alias of svc.aliases ?? []) ports[alias] = svc.port;
      }
  }
  return ports;
}

/** Service URL map — canonical lab-registry overlaid on the built-in fallback. */
const SERVICE_PORTS: Record<string, number> = loadServicePortMap();

function getServiceUrl(service: string): string | undefined {
  const port = SERVICE_PORTS[service];
  if (port === undefined) return undefined;
  return `http://localhost:${port}`;
}

/**
 * Caller identity + correlation + task headers (H8 / BLOCKER-2). Every bridge call carries
 * WHO is calling (X-Agent-Id), a unique X-Correlation-Id so a request can be traced across
 * services, and an X-Task-Id (UUID) that identifies the unit of work on the CALLEE side.
 *
 * The X-Task-Id is the key to BLOCKER-2: when a call times out, the caller no longer just
 * gives up blind — it knows the task id it stamped, so it (or the operator) can poll the
 * callee's `/task/<id>/status` to learn whether the orphaned work actually finished. The
 * SAME task id is reused across retries of one logical call, so a retry does not spawn a
 * second identity for the same work.
 */
function callerHeaders(agentId: string, correlationId: string, taskId: string): Record<string, string> {
  return {
    'X-Agent-Id': agentId,
    'X-Correlation-Id': correlationId,
    'X-Task-Id': taskId,
  };
}

/** A fresh correlation id for one bridge call (stable across that call's retries). */
function newCorrelationId(agentId: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${agentId}-${Date.now()}-${rand}`;
}

/**
 * BLOCKER-2 retry classification. A transient failure (the callee may still be reachable on
 * a later attempt) is retried with backoff; a permanent failure is not. Timeouts (AbortError)
 * and connection resets are transient. An HTTP 4xx is a permanent client error — retrying it
 * just wastes time and tokens. An HTTP 5xx is treated as transient.
 */
function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const m = err.message.toLowerCase();
  return /econnreset|econnrefused|enotfound|ehostunreach|etimedout|socket hang up|network|fetch failed|terminated|timeout/.test(m);
}

/** Real backoff sleep (overridable in tests so retries don't add wall-clock delay). */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The bridge tool specs — advertised to the model. */
export const bridgeToolSpecs: ToolSpec[] = [
  {
    name: "bridge.health",
    description: "Check if an ecosystem service is reachable and healthy. Read-only.",
    parameters: obj(
      { service: { type: "string", description: "Service name (pehlichi, mechanic, artist, ikbi, toba, nusika, howa, kokuli, luak, ittunaha)" } },
      ["service"],
    ),
  },
  {
    name: "bridge.list",
    description: "List all available ecosystem services and their ports. Read-only.",
    parameters: obj({}, []),
  },
  {
    name: "bridge.request",
    description: "Make an HTTP request to an ecosystem service endpoint.",
    parameters: obj(
      {
        service: { type: "string", description: "Service name" },
        method: { type: "string", description: "HTTP method (GET, POST)" },
        path: { type: "string", description: "Endpoint path (e.g. '/health', '/api/profile')" },
        body: { type: "object", description: "Request body for POST requests" },
        timeout_ms: {
          type: "number",
          description:
            "Per-request timeout in ms (default 120000). Real agent tasks take minutes; " +
            "raise this for long-running endpoints so the call doesn't abort prematurely (B7).",
        },
      },
      ["service", "method", "path"],
    ),
  },
  {
    name: "lab_status_digest",
    description: "Proactive lab-status digest — pings every registered service and returns up/down. Read-only.",
    parameters: obj({}, []),
  },
];

/** Default bridge.request timeout — real agent work takes minutes, not 30s (B7). */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** BLOCKER-2 retry schedule: 2 retries after the first attempt, backing off 1s then 4s. */
const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [1000, 4000];

/** Configuration for the bridge tool handlers. */
export interface BridgeToolConfig {
  /** Canonical validated capsule id, stamped on X-Agent-Id. */
  agentId: string;
  /** Injectable fetch (tests pass a mock to drive retry classification). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable backoff sleep (tests pass a no-op so retries don't add wall-clock). Defaults to realSleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Backoff schedule (ms) for transient retries on bridge.request. Defaults to [1000, 4000]. */
  retryBackoffMs?: readonly number[];
}

/** Create the bridge tool handlers. */
export function createBridgeToolHandlers(config: BridgeToolConfig): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  if (!config || typeof config.agentId !== 'string' || config.agentId.length === 0) {
    throw new Error('bridge tools require the canonical validated agent identity');
  }
  const agentId = config.agentId;
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? realSleep;
  const backoff = config.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;

  handlers.set("bridge.health", async (args): Promise<ToolResult> => {
    const service = args.service as string;
    const url = getServiceUrl(service);
    if (!url) {
      return { ok: false, output: "", error: `Unknown service: ${service}. Available: ${Object.keys(SERVICE_PORTS).join(", ")}` };
    }
    try {
      const headers = callerHeaders(agentId, newCorrelationId(agentId), randomUUID());
      const response = await fetchImpl(`${url}/health`, { headers, signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      return {
        ok: response.ok,
        output: JSON.stringify(data, null, 2),
      };
    } catch (err) {
      return { ok: false, output: "", error: `Service ${service} unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  handlers.set("bridge.list", async (): Promise<ToolResult> => {
    const services = Object.entries(SERVICE_PORTS).map(([name, port]) => ({
      name,
      port,
      url: `http://localhost:${port}`,
    }));
    return { ok: true, output: JSON.stringify(services, null, 2) };
  });

  handlers.set("bridge.request", async (args): Promise<ToolResult> => {
    const service = args.service as string;
    const method = (args.method as string).toUpperCase();
    const path = args.path as string;
    const body = args.body as Record<string, unknown> | undefined;

    const url = getServiceUrl(service);
    if (!url) {
      return { ok: false, output: "", error: `Unknown service: ${service}` };
    }

    const timeoutMs = typeof args.timeout_ms === "number" && args.timeout_ms > 0
      ? args.timeout_ms
      : DEFAULT_REQUEST_TIMEOUT_MS;

    // BLOCKER-2: one task identity for the whole logical call. The SAME taskId + correlationId
    // are stamped on every retry, so the callee sees one unit of work (and the operator can
    // poll `/task/<taskId>/status` after a timeout to recover an orphaned result).
    const taskId = randomUUID();
    const correlationId = newCorrelationId(agentId);
    const trace = `taskId=${taskId} corr=${correlationId}`;

    const maxAttempts = backoff.length + 1; // first attempt + one per backoff step
    let lastError = "";

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const headers: Record<string, string> = callerHeaders(agentId, correlationId, taskId);
        const fetchOpts: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
        if (body && method === "POST") {
          fetchOpts.headers = { ...headers, "Content-Type": "application/json" };
          fetchOpts.body = JSON.stringify(body);
        }

        const response = await fetchImpl(`${url}${path}`, fetchOpts);

        if (!response.ok) {
          // 4xx is a permanent client error — never retry, just report it (BLOCKER-2).
          if (response.status >= 400 && response.status < 500) {
            const data = await response.json().catch(() => undefined);
            return {
              ok: false,
              output: data !== undefined ? JSON.stringify(data, null, 2) : "",
              error: `${service}${path} -> HTTP ${response.status} (client error, not retried; ${trace})`,
            };
          }
          // 5xx is transient — fall through to the retry path.
          lastError = `HTTP ${response.status}`;
        } else {
          const data = await response.json();
          return { ok: true, output: JSON.stringify(data, null, 2) };
        }
      } catch (err) {
        if (!isTransientError(err)) {
          return { ok: false, output: "", error: `${service}${path} failed: ${err instanceof Error ? err.message : String(err)} (${trace})` };
        }
        lastError = err instanceof Error ? err.message : String(err);
        // BLOCKER-2: log the task id + correlation id at error level so an operator can
        // investigate the orphaned callee work (poll /task/<id>/status on the callee).
        console.error(`[bridge] transient failure on ${service}${path} attempt ${attempt + 1}/${maxAttempts}: ${lastError} (${trace})`);
      }

      const isLastAttempt = attempt === maxAttempts - 1;
      if (!isLastAttempt) {
        await sleep(backoff[attempt] ?? 0);
      }
    }

    console.error(`[bridge] ${service}${path} EXHAUSTED ${maxAttempts} attempts: ${lastError} (${trace})`);
    return {
      ok: false,
      output: "",
      error: `${service}${path} failed after ${maxAttempts} attempts: ${lastError}. The callee may still be working — poll ${service} /task/${taskId}/status to recover the result. (${trace})`,
    };
  });

  // Lab-status digest: ping every known service and return up/down summary
  handlers.set("lab_status_digest", async (): Promise<ToolResult> => {
    const allServices = Object.entries(SERVICE_PORTS).map(([name, port]) => ({ name, port }));

    const results = await Promise.allSettled(
      allServices.map(async (svc) => {
        const url = `http://localhost:${svc.port}/health`;
        try {
          const resp = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
          return { name: svc.name, port: svc.port, up: resp.ok, status: resp.status };
        } catch {
          return { name: svc.name, port: svc.port, up: false, status: 0 };
        }
      }),
    );

    const digest = results.map((r) => (r.status === "fulfilled" ? r.value : { name: "unknown", port: 0, up: false, status: 0 }));
    const up = digest.filter((d) => d.up);
    const down = digest.filter((d) => !d.up);

    return {
      ok: true,
      output: JSON.stringify({
        summary: `${up.length} up, ${down.length} down`,
        up: up.map((d) => `${d.name}:${d.port}`),
        down: down.map((d) => `${d.name}:${d.port}`),
        services: digest,
      }, null, 2),
    };
  });

  return handlers;
}
