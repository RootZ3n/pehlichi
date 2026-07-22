/**
 * BRIDGE HOST — where ecosystem-service bridges point.
 *
 * Defaults to `localhost` (the lab's own box). Set LAB_BRIDGE_HOST to a reachable host — e.g. the
 * lab's Tailscale IP — so an OFF-BOX agent (Peh running on the phone) reaches the LAB's services
 * (luak/toba/nusika/howa/kokuli/…) instead of its own empty localhost. When the lab is unreachable
 * those bridges simply report unhealthy, which is the correct graceful degradation.
 */
export function bridgeHost(): string {
  const h = process.env.LAB_BRIDGE_HOST?.trim();
  return h !== undefined && h.length > 0 ? h : "localhost";
}
