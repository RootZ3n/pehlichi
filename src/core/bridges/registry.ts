/**
 * BRIDGE REGISTRY — discovers and manages all available bridges.
 *
 * Agents use this to find and connect to ecosystem services.
 * Each bridge is standalone; the registry provides a unified interface.
 */
import type { BridgeReceipt } from "./http-bridge.js";

export interface BridgeInfo {
  readonly name: string;
  readonly description: string;
  readonly port: number;
  readonly status: "available" | "unavailable" | "unknown";
}

export interface BridgeHealth {
  readonly name: string;
  readonly healthy: boolean;
  readonly receipt?: BridgeReceipt;
}

/**
 * Registry of all available bridges.
 * Agents query this to discover which services they can connect to.
 */
export class BridgeRegistry {
  private readonly bridges: Map<string, BridgeInfo> = new Map();

  constructor() {
    // Register all known bridges
    this.register({ name: "ikbi", description: "Build/repair engine", port: 18796, status: "unknown" });
    this.register({ name: "comfyui", description: "Image generation", port: 8188, status: "unknown" });
    this.register({ name: "toba", description: "Career transformation", port: 18815, status: "unknown" });
    this.register({ name: "nusika", description: "Adaptive learning", port: 18793, status: "unknown" });
    this.register({ name: "howa", description: "Agent proving ground", port: 18799, status: "unknown" });
    this.register({ name: "kokuli", description: "Adversarial testing", port: 3000, status: "unknown" });
    this.register({ name: "luak", description: "Scoreboard/evidence", port: 18795, status: "unknown" });
    this.register({ name: "miko", description: "Governance/validation", port: 0, status: "unknown" });
    this.register({ name: "honola", description: "Weather guard", port: 0, status: "unknown" });
    this.register({ name: "ittunaha", description: "Command center", port: 18821, status: "unknown" });
    this.register({ name: "wyrms", description: "Game", port: 0, status: "unknown" });
  }

  register(info: BridgeInfo): void {
    this.bridges.set(info.name, info);
  }

  get(name: string): BridgeInfo | undefined {
    return this.bridges.get(name);
  }

  list(): BridgeInfo[] {
    return Array.from(this.bridges.values());
  }

  listAvailable(): BridgeInfo[] {
    return this.list().filter((b) => b.status === "available");
  }

  /**
   * Check health of all registered bridges.
   */
  async checkAll(): Promise<BridgeHealth[]> {
    const results: BridgeHealth[] = [];
    for (const [name, info] of this.bridges) {
      if (info.port === 0) {
        results.push({ name, healthy: false });
        continue;
      }
      try {
        const response = await fetch(`http://localhost:${info.port}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        results.push({
          name,
          healthy: response.ok,
          receipt: {
            operation: "health",
            success: response.ok,
            status: response.status,
            durationMs: 0,
          },
        });
      } catch {
        results.push({ name, healthy: false });
      }
    }
    return results;
  }
}

/**
 * Default registry instance.
 */
export const bridgeRegistry = new BridgeRegistry();
