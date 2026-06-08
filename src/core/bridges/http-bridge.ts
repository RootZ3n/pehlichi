/**
 * Base HTTP bridge — reusable pattern for service bridges.
 * Each bridge extends this with service-specific operations.
 */
export interface BridgeConfig {
  /** Service base URL (e.g., http://localhost:18815) */
  readonly baseUrl: string;
  /** Request timeout in ms (default: 30000) */
  readonly timeoutMs?: number;
  /** Service name for receipts */
  readonly serviceName: string;
}

export interface BridgeReceipt {
  readonly operation: string;
  readonly success: boolean;
  readonly status?: number;
  readonly data?: unknown;
  readonly error?: string;
  readonly durationMs: number;
}

export class BridgeError extends Error {
  override readonly name = "BridgeError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Base HTTP bridge with health check and request helpers.
 */
export class HttpBridge {
  protected readonly baseUrl: string;
  protected readonly timeoutMs: number;
  protected readonly serviceName: string;

  constructor(config: BridgeConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.serviceName = config.serviceName;
  }

  /**
   * Check if the service is healthy.
   */
  async health(): Promise<BridgeReceipt> {
    return this.get("/health", "health");
  }

  /**
   * GET request helper.
   */
  protected async get(path: string, operation: string): Promise<BridgeReceipt> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        signal: controller.signal,
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) {
        return {
          operation,
          success: false,
          status: response.status,
          error: `HTTP ${response.status}`,
          durationMs: Date.now() - start,
        };
      }
      
      const data = await response.json();
      return {
        operation,
        success: true,
        status: response.status,
        data,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        operation,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * POST request helper.
   */
  protected async post(path: string, body: unknown, operation: string): Promise<BridgeReceipt> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) {
        return {
          operation,
          success: false,
          status: response.status,
          error: `HTTP ${response.status}`,
          durationMs: Date.now() - start,
        };
      }
      
      const data = await response.json();
      return {
        operation,
        success: true,
        status: response.status,
        data,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        operation,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * Check if the bridge is ready (service is reachable).
   */
  async isReady(): Promise<boolean> {
    const receipt = await this.health();
    return receipt.success;
  }
}
