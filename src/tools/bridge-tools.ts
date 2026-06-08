/**
 * BRIDGE TOOLS — generic bridge operations for all agents.
 *
 * These tools let agents interact with any ecosystem service via bridges.
 * Registered via the core's tool-registration seam (extraTools).
 *
 * Services: ikbi, toba, nusika, howa, kokuli, luak, miko, honola, ittunaha, wyrms
 */
import type { ToolSpec } from "../core/driver.js";
import type { ToolHandler, ToolResult } from "../core/tools.js";

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

/** Service URL map — which port each service runs on. */
const SERVICE_PORTS: Record<string, number> = {
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

/** The bridge tool specs — advertised to the model. */
export const bridgeToolSpecs: ToolSpec[] = [
  {
    name: "bridge.health",
    description: "Check if an ecosystem service is reachable and healthy. Read-only.",
    parameters: obj(
      { service: { type: "string", description: "Service name (ikbi, toba, nusika, howa, kokuli, luak, ittunaha)" } },
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
      },
      ["service", "method", "path"],
    ),
  },
];

/** Create the bridge tool handlers. */
export function createBridgeToolHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set("bridge.health", async (args): Promise<ToolResult> => {
    const service = args.service as string;
    const url = getServiceUrl(service);
    if (!url) {
      return { ok: false, output: "", error: `Unknown service: ${service}. Available: ${Object.keys(SERVICE_PORTS).join(", ")}` };
    }
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
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

    try {
      const fetchOpts: RequestInit = {
        method,
        signal: AbortSignal.timeout(30000),
      };
      if (body && method === "POST") {
        fetchOpts.headers = { "Content-Type": "application/json" };
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
