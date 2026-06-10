/**
 * BRIDGE TOOLS — generic bridge operations for all agents.
 *
 * These tools let agents interact with any ecosystem service via bridges.
 * Registered via the core's tool-registration seam (extraTools).
 *
 * Services: pehlichi, ptah, luna, ikbi, toba, nusika, howa, kokuli, luak, ittunaha
 */
import type { ToolSpec } from "../core/driver.js";
import type { ToolHandler, ToolResult } from "../core/tools.js";

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

/** Service URL map — which port each service runs on. */
const SERVICE_PORTS: Record<string, number> = {
  pehlichi: 18830,
  ptah: 18810,
  luna: 18792,
  ikbi: 18796,
  toba: 18815,
  nusika: 18793,
  howa: 18799,
  kokuli: 3000,
  luak: 18795,
  ittunaha: 18821,
};

function getServiceUrl(service: string): string | undefined {
  const port = SERVICE_PORTS[service];
  if (port === undefined) return undefined;
  return `http://localhost:${port}`;
}

/**
 * Caller identity + correlation headers (H8). Every bridge call carries WHO is calling
 * (X-Agent-Id) and a unique X-Correlation-Id so a request can be traced across services
 * and a receiving server can attribute and audit it — instead of bare, anonymous HTTP
 * that any process on localhost could forge indistinguishably.
 */
function callerHeaders(agentId: string): Record<string, string> {
  const rand = Math.random().toString(36).slice(2, 10);
  return {
    'X-Agent-Id': agentId,
    'X-Correlation-Id': `${agentId}-${Date.now()}-${rand}`,
  };
}

/** The bridge tool specs — advertised to the model. */
export const bridgeToolSpecs: ToolSpec[] = [
  {
    name: "bridge.health",
    description: "Check if an ecosystem service is reachable and healthy. Read-only.",
    parameters: obj(
      { service: { type: "string", description: "Service name (pehlichi, ptah, luna, ikbi, toba, nusika, howa, kokuli, luak, ittunaha)" } },
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
];

/** Default bridge.request timeout — real agent work takes minutes, not 30s (B7). */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Create the bridge tool handlers. */
export function createBridgeToolHandlers(config: { agentId?: string } = {}): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const agentId = config.agentId ?? process.env.AGENT_ID ?? "unknown";

  handlers.set("bridge.health", async (args): Promise<ToolResult> => {
    const service = args.service as string;
    const url = getServiceUrl(service);
    if (!url) {
      return { ok: false, output: "", error: `Unknown service: ${service}. Available: ${Object.keys(SERVICE_PORTS).join(", ")}` };
    }
    try {
      const response = await fetch(`${url}/health`, { headers: callerHeaders(agentId), signal: AbortSignal.timeout(5000) });
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

    try {
      const fetchOpts: RequestInit = {
        method,
        headers: callerHeaders(agentId),
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (body && method === "POST") {
        fetchOpts.headers = { ...callerHeaders(agentId), "Content-Type": "application/json" };
        fetchOpts.body = JSON.stringify(body);
      }

      const response = await fetch(`${url}${path}`, fetchOpts);
      const data = await response.json();
      return {
        ok: response.ok,
        output: JSON.stringify(data, null, 2),
      };
    } catch (err) {
      return { ok: false, output: "", error: `${service}${path} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  return handlers;
}
