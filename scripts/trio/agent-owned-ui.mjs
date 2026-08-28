/**
 * AGENT_OWNED_UI — governed product surface, not a parity loophole.
 *
 * Pehlichi, Loony-Luna and Mad-Ptah intentionally ship different interfaces.
 * Their UIs are part of their individual product identities, so byte parity is
 * the wrong question for them. What must stay identical is the *contract* the
 * UIs consume, and what must stay out of them is shared runtime behaviour.
 *
 * This module implements the eight verifier obligations for the class:
 *   1. exclude declared implementation files from byte comparison  (caller)
 *   2. every excluded UI path belongs to exactly one declared owner
 *   3. reject UI files outside declared ownership roots
 *   4. reject shared runtime / authority / transport / tool-execution logic
 *      hidden inside an agent-owned UI
 *   5. validate imported shared schemas and protocol versions
 *   6. fail when a UI implements its own work-order or authority semantics
 *   7. fail when an unclassified UI path appears
 *   8. permit each UI to expose different agent-specific features
 */

export const AGENT_OWNED_UI_CLASS = 'agent-owned-ui';

/**
 * The general form: content each agent owns its own copy of, or ships alone.
 *
 * Ownership here is a fact rather than a judgement -- a file present in exactly
 * one repository is owned by that repository. Bytes are not compared; what is
 * enforced is that the path stays inside its declared root, that it belongs to
 * a declared owner, and (for behaviour-bearing content) that shared runtime
 * logic is not hiding inside it.
 */
export const AGENT_OWNED_CONTENT_CLASS = 'agent-owned-content';

export const AGENT_OWNED_CLASSES = new Set([AGENT_OWNED_UI_CLASS, AGENT_OWNED_CONTENT_CLASS]);

/**
 * Behaviour that must never live in a UI. Each entry names what it is, so a
 * failure tells the reader which boundary was crossed rather than just
 * printing a regex.
 */
export const FORBIDDEN_UI_BEHAVIOUR = [
  { id: 'work-order-state-machine',
    why: 'a UI may render work-order state, never define its transitions',
    re: /\b(REQUESTED|TRIAGED|DISPATCHED|IN_PROGRESS|SUBMITTED|VERIFYING)\b[\s\S]{0,120}\b(COMPLETE|REJECTED)\b[\s\S]{0,120}(transition|allowedNext|stateMachine|EDGES)/i },
  { id: 'authority-decision',
    why: 'authorization is decided in shared runtime, never in a client',
    re: /\b(assertCapability|authorizeTool|grantAuthority|hasAuthority|checkPermission)\s*\(/ },
  { id: 'replay-protection',
    why: 'replay protection is a shared-runtime database property',
    re: /\b(contentDigest|replayProtect|dedupeMessage)\s*\(|\bmessage_ledger\b/ },
  { id: 'tool-execution',
    why: 'a UI must not execute tools or shell out',
    re: /\b(child_process|execSync|spawnSync|execFile|require\(['"]child_process)/ },
  { id: 'verdict-issuance',
    why: 'a UI may display a verdict; it may never issue one',
    re: /\b(recordVerdict|issueVerdict|markVerified)\s*\(/ },
  { id: 'direct-store-mutation',
    why: 'a UI must go through the shared contract, not the store',
    re: /\b(WorkOrderStore|work_order\s+SET|INSERT\s+INTO\s+work_order)\b/i },
];

const isText = (rel) => /\.(js|mjs|cjs|ts|tsx|jsx|html|htm|css|json|webmanifest|d\.ts)$/i.test(rel);

/**
 * Validate one agent's declared UI tree.
 *
 * @param {object} args
 * @param {string} args.slot            agent name
 * @param {string} args.root            repository root
 * @param {object} args.rule            the manifest rule (class agent-owned-ui)
 * @param {string[]} args.paths         repository-relative paths matched by the rule
 * @param {(rel:string)=>string|null} args.read  reads file text, null if unreadable
 * @param {object} args.sharedContracts declared shared contract versions
 * @returns {{failureClass:string,message:string,agent:string,affectedPath:string|null,details:object}[]}
 */
export function verifyAgentOwnedUi({ slot, rule, paths, read, sharedContracts }) {
  const out = [];
  const fail = (failureClass, message, affectedPath = null, details = {}) =>
    out.push({ failureClass, message, agent: slot, affectedPath, details });

  const owners = Array.isArray(rule.owners) ? rule.owners : [];
  if (owners.length === 0) {
    fail('UI_OWNERSHIP_CONTRACT',
      'An agent-owned-ui rule must declare which agents ship this surface', null, { rule: rule.id });
    return out;
  }

  // (2) The surface must belong to a declared owner. A path appearing in an
  // agent that does not declare the surface is an ownership violation, not a
  // permitted difference.
  if (!owners.includes(slot) && paths.length) {
    fail('UI_OWNERSHIP_VIOLATION',
      `${slot} ships ${paths.length} file(s) under a surface it does not own`,
      paths[0], { rule: rule.id, owners });
  }

  // (3)+(7) Every path must sit under a declared root. closedInventory already
  // rejects unknown paths; this catches a root escape explicitly.
  const root = rule.selector?.directory;
  if (root) {
    for (const rel of paths) {
      if (rel !== root && !rel.startsWith(root + '/')) {
        fail('UI_PATH_OUTSIDE_ROOT',
          `agent-owned UI path escapes its declared root ${root}`, rel, { rule: rule.id });
      }
    }
  }

  // (4)+(6) Content scan, for the UI class only. The rule being enforced is
  // "shared semantics must not live in the presentation layer". Agent-owned
  // skills and documentation legitimately contain code, so scanning them for
  // the same patterns produces noise, not governance.
  for (const rel of (rule.class === AGENT_OWNED_UI_CLASS ? paths : [])) {
    if (!isText(rel)) continue;
    const text = read(rel);
    if (text === null) continue;
    for (const rule_ of FORBIDDEN_UI_BEHAVIOUR) {
      if (rule_.re.test(text)) {
        fail('UI_CONTAINS_SHARED_BEHAVIOUR',
          `agent-owned UI contains ${rule_.id}: ${rule_.why}`, rel,
          { rule: rule.id, behaviour: rule_.id });
      }
    }
  }

  // (5) Where a UI declares the contract versions it speaks, they must match
  // the governed versions. A UI that silently speaks an older envelope is a
  // compatibility break wearing a presentation costume.
  if (sharedContracts && typeof sharedContracts === 'object') {
    for (const rel of paths) {
      if (!isText(rel)) continue;
      const text = read(rel);
      if (text === null) continue;
      for (const [name, expected] of Object.entries(sharedContracts)) {
        const m = new RegExp(`${name}\\s*[:=]\\s*["']?(\\d+)`).exec(text);
        if (m && m[1] !== String(expected)) {
          fail('UI_CONTRACT_VERSION_MISMATCH',
            `agent-owned UI declares ${name}=${m[1]} but the governed value is ${expected}`,
            rel, { rule: rule.id, declared: m[1], expected: String(expected) });
        }
      }
    }
  }

  return out;
}

/** Contract checks on the rule itself, run once per manifest. */
export function verifyAgentOwnedUiRule(rule, slotNames) {
  const out = [];
  const fail = (message, details = {}) =>
    out.push({ failureClass: 'UI_OWNERSHIP_CONTRACT', message, agent: null,
               affectedPath: null, details: { rule: rule.id, ...details } });

  if (rule.bytesMustMatch) fail('agent-owned UI cannot claim byte identity');
  if (rule.divergenceBlocking) fail('agent-owned UI divergence is permitted, not blocking');
  if (!Array.isArray(rule.owners) || rule.owners.length === 0) fail('missing owners');
  else for (const o of rule.owners) {
    if (!slotNames.includes(o)) fail(`unknown owner ${o}`, { owner: o });
  }
  if (typeof rule.attestation !== 'string' || rule.attestation.length < 20) {
    fail('agent-owned UI requires an attestation explaining why it diverges');
  }
  // An explicit path list is itself a closed inventory: it enumerates exactly
  // what is governed, so a new file simply is not in it and fails as
  // unclassified. A directory rule needs closedInventory to get the same
  // property.
  const closed = rule.selector?.closedInventory === true
    || (Array.isArray(rule.selector?.paths) && rule.selector.paths.length > 0);
  if (!closed) {
    fail('this class requires a closed inventory (or an explicit path list) so a new unclassified file fails');
  }
  const wantKind = rule.class === AGENT_OWNED_CONTENT_CLASS ? 'agent-owned-content' : 'agent-owned-ui';
  if (rule.validation?.kind !== wantKind) {
    fail(`this class requires validation.kind = ${wantKind}`);
  }
  return out;
}
