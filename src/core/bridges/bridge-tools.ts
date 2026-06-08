/**
 * BRIDGE TOOLS — wraps bridge operations as agent tools.
 *
 * Agents register these tools so the model can call ecosystem services.
 * Each tool wraps a bridge operation and returns a BridgeReceipt.
 *
 * NOTE: ToolSpec and ToolHandler types are defined here for standalone use.
 * When integrating into an agent, import from the agent's core instead.
 */

// Standalone types (matches agent core interfaces)
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
  receipt?: {
    operation: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    success: boolean;
  };
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

/**
 * Generic bridge tool specs — advertised to the model.
 * These are the COMMON operations available for all bridges.
 */
export const bridgeToolSpecs: ToolSpec[] = [
  {
    name: "bridge.health",
    description: "Check if a service is reachable and healthy. Read-only.",
    parameters: obj(
      { service: { type: "string", description: "Service name (e.g. 'ikbi', 'toba', 'howa')" } },
      ["service"],
    ),
  },
  {
    name: "bridge.list",
    description: "List all available bridges and their status. Read-only.",
    parameters: obj({}, []),
  },
  {
    name: "bridge.request",
    description: "Make an HTTP request to a service endpoint. Use for service-specific operations.",
    parameters: obj(
      {
        service: { type: "string", description: "Service name" },
        method: { type: "string", description: "HTTP method (GET, POST)" },
        path: { type: "string", description: "Endpoint path (e.g. '/api/profile')" },
        body: { type: "object", description: "Request body for POST requests" },
      },
      ["service", "method", "path"],
    ),
  },
];

/**
 * Create bridge tool handlers.
 * @param getServiceUrl - function that returns base URL for a service name
 */
export function createBridgeToolHandlers(
  getServiceUrl: (name: string) => string | undefined,
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set("bridge.health", async (args): Promise<ToolResult> => {
    const service = args.service as string;
    const url = getServiceUrl(service);
    if (!url) {
      return { ok: false, output: "", error: `Unknown service: ${service}` };
    }
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      return {
        ok: response.ok,
        output: JSON.stringify(data),
        receipt: { operation: `${service}/health`, exitCode: response.ok ? 0 : 1, stdout: "", stderr: "", durationMs: 0, success: response.ok },
      };
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  });

  handlers.set("bridge.list", async (): Promise<ToolResult> => {
    const services = [
      { name: "pehlichi", port: 18830, desc: "Lab coordinator (Julian)" },
      { name: "ptah", port: 18810, desc: "Operational executor" },
      { name: "luna", port: 18792, desc: "Creative production" },
      { name: "ikbi", port: 18796, desc: "Build/repair engine" },
      { name: "toba", port: 18815, desc: "Career transformation" },
      { name: "nusika", port: 18793, desc: "Adaptive learning" },
      { name: "howa", port: 18799, desc: "Agent proving ground" },
      { name: "kokuli", port: 3000, desc: "Adversarial testing" },
      { name: "luak", port: 18795, desc: "Scoreboard/evidence" },
      { name: "ittunaha", port: 18821, desc: "Command center" },
    ];
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
        output: JSON.stringify(data),
        receipt: { operation: `${service}${path}`, exitCode: response.ok ? 0 : 1, stdout: "", stderr: "", durationMs: 0, success: response.ok },
      };
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  });

  return handlers;
}
