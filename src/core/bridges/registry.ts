/**
 * BRIDGE REGISTRY — discovers and manages all available bridges.
 *
 * Agents use this to find and connect to ecosystem services.
 * Each bridge is standalone; the registry provides a unified interface.
 *
 * Service ids and ports are sourced from the canonical lab-registry
 * (`lab-utilities/lab-registry/services.json`), read as DATA at construction
 * time. When that file is absent (a released / standalone build) we fall back
 * to the built-in list below, so behaviour never regresses.
 */
import { readFileSync, existsSync } from "node:fs";
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

/** One entry in the canonical lab-registry services.json. */
interface RegistryService {
  readonly id: string;
  readonly displayName?: string;
  readonly port?: number | null;
  readonly aliases?: readonly string[];
}

/**
 * Behaviour-preserving fallback list — used verbatim when the canonical
 * lab-registry file cannot be read. Also carries the historically-known bridges
 * (comfyui, miko, wyrms) that are not (yet) in the canonical registry, so they
 * survive even when the registry IS read.
 */
const FALLBACK_BRIDGES: readonly BridgeInfo[] = [
  { name: "pehlichi", description: "Canonical Pehlichi coordinator", port: 18830, status: "unknown" },
  { name: "ikbi", description: "Build/repair engine", port: 18796, status: "unknown" },
  { name: "comfyui", description: "Image generation", port: 8188, status: "unknown" },
  { name: "toba", description: "Career transformation", port: 18815, status: "unknown" },
  { name: "nusika", description: "Adaptive learning", port: 18793, status: "unknown" },
  { name: "howa", description: "Agent proving ground", port: 18799, status: "unknown" },
  { name: "kokuli", description: "Adversarial testing", port: 18800, status: "unknown" },
  { name: "luak", description: "Scoreboard/evidence", port: 18795, status: "unknown" },
  { name: "miko", description: "Governance/validation", port: 0, status: "unknown" },
  { name: "honola", description: "Weather guard", port: 0, status: "unknown" },
  { name: "ittunaha", description: "Command center", port: 18821, status: "unknown" },
  { name: "wyrms", description: "Game", port: 0, status: "unknown" },
];

/**
 * Read the canonical lab service registry (DATA, not a runtime import).
 * Returns null when the file is absent or unreadable.
 */
function loadCanonicalBridges(): BridgeInfo[] | null {
  const candidates = [
    process.env.LAB_REGISTRY_PATH,
    "/pehverse/repos/lab-utilities/lab-registry/services.json",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { services?: readonly RegistryService[] };
      if (!parsed.services) continue;
      // Register the canonical id PLUS every alias, all pointing at the same
      // port (and therefore the same host/health endpoint), so that
      // bridgeRegistry.get(alias) resolves identically to the canonical service
      // (e.g. "peh" -> pehlichi, "mechanic" -> mad-ptah, "luna" -> loony-luna).
      return parsed.services.flatMap((s) => {
        const port = typeof s.port === "number" ? s.port : 0;
        const description = s.displayName ?? s.id;
        const canonical: BridgeInfo = { name: s.id, description, port, status: "unknown" };
        const aliases: BridgeInfo[] = (s.aliases ?? []).map((alias) => ({
          name: alias,
          description,
          port,
          status: "unknown",
        }));
        return [canonical, ...aliases];
      });
    } catch {
      // Unreadable / invalid registry — try the next candidate, else fall back.
    }
  }
  return null;
}

/**
 * Registry of all available bridges.
 * Agents query this to discover which services they can connect to.
 */
export class BridgeRegistry {
  private readonly bridges: Map<string, BridgeInfo> = new Map();

  constructor() {
    // Built-in list first (also seeds comfyui/miko/wyrms), then overlay the
    // canonical registry so its ids/ports win when present.
    for (const info of FALLBACK_BRIDGES) this.register(info);
    const canonical = loadCanonicalBridges();
    if (canonical) {
      for (const info of canonical) this.register(info);
    }
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
