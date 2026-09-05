/**
 * THE version stamp for the containment authority.
 *
 * Runtime parity compares this string across every deployment that loads it. If they do not all
 * report the same value they are not running the same execution boundary, and any claim of
 * equivalency between them is void regardless of what else matches.
 *
 * Bump on ANY change to policy behaviour — the risk table, the argv construction, the availability
 * contract, the conformance controls. A version that stays put while behaviour moves is worse than
 * no version at all, because parity will report agreement that is not there.
 */
export const CONTAINMENT_VERSION = "1.5.0";

/**
 * The contract version of the *shape* callers depend on (the exported types and function
 * signatures). Separate from CONTAINMENT_VERSION so a pure policy tightening does not force every
 * consumer to be re-reviewed for an interface change that did not happen.
 */
export const CONTAINMENT_CONTRACT_VERSION = "1.4.0";
