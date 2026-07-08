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
      { name: "pehlichi", port: 18830, desc: "Lab coordinator" },
      { name: "mechanic", port: 18810, desc: "Operational executor" },
      { name: "artist", port: 18792, desc: "Creative production" },
      { name: "ikbi", port: 18796, desc: "Build/repair engine" },
      { name: "toba", port: 18815, desc: "Career transformation" },
      { name: "nusika", port: 18793, desc: "Adaptive learning" },
      { name: "howa", port: 18799, desc: "Agent proving ground" },
      { name: "kokuli", port: 18800, desc: "Adversarial testing" },
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

  // Lab-status digest: ping every known service and return up/down summary
  handlers.set("lab_status_digest", async (): Promise<ToolResult> => {
    const allServices = [
      { name: "pehlichi", port: 18830 },
      { name: "mechanic", port: 18810 },
      { name: "artist", port: 18792 },
      { name: "ikbi", port: 18796 },
      { name: "toba", port: 18815 },
      { name: "nusika", port: 18793 },
      { name: "howa", port: 18799 },
      { name: "kokuli", port: 18800 },
      { name: "luak", port: 18795 },
      { name: "ittunaha", port: 18821 },
    ];

    const results = await Promise.allSettled(
      allServices.map(async (svc) => {
        const url = `http://localhost:${svc.port}/health`;
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
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
