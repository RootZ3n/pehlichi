/**
 * Active-agent seam. The persona + tool allowlist live in the per-agent
 * overlay (src/profiles/agent.ts). This file is the stable import path
 * (./profile.js) and is BYTE-IDENTICAL across the trio — swap the overlay
 * to swap the agent; nothing else changes.
 */
export { agentProfile, agentToolNames } from "./profiles/agent.js";
