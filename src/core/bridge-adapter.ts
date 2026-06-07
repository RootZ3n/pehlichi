/**
 * BRIDGE-RECEIPT ADAPTER — wires any bridge's onReceipt callback into the
 * core's event stream as a generic bridge-receipt event.
 *
 * The core does NOT import any bridge. The consumer passes the bridge's
 * receipt sink point; this adapter wraps it to emit bridge-receipt events
 * with the bridge name as DATA (not as a hardcoded kind).
 */
import type { EventEmitter } from "./events.js";

/** The shape a bridge's onReceipt callback expects. Matches BridgeReceipt from bridges/comfyui. */
export interface BridgeReceiptInput {
  readonly tool: string;
  readonly transport: string;
  readonly op: string;
  readonly [key: string]: unknown;
}

/**
 * Create an onReceipt sink that emits bridge-receipt events into the core's
 * event stream. The consumer wires this into the bridge's constructor.
 */
export function createBridgeReceiptSink(
  emitter: EventEmitter,
  bridgeName: string,
): (receipt: BridgeReceiptInput) => void {
  return (receipt: BridgeReceiptInput) => {
    emitter.emit({
      kind: "bridge-receipt",
      bridge: bridgeName,
      op: receipt.op,
      detail: receipt as Record<string, unknown>,
    });
  };
}
