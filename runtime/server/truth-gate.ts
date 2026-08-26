/**
 * Truth enforcement for the shared Trio runtime.
 *
 * This file is byte-identical across Pehlichi, Loony-Luna and Mad-Ptah, and must stay
 * that way: it is governed-runtime source, not identity. Everything that differs between
 * the three arrives as an argument -- the agent name, the workspace, the channel. Nothing
 * about a personality, a capability pack, a skin, or a deployment may reach in here and
 * change what the boundary does, because a boundary an identity can reconfigure is a
 * boundary the identity can remove.
 *
 * It contains no verifier logic. Authority lives in one implementation, reached through
 * the vendored `truth-agent-adapter`, so a rule tightened in the Truth Firewall tightens
 * all three agents at once.
 *
 * The shape of the integration:
 *
 *   1. `containStream()` wraps the caller's stream callback, so it receives transport
 *      liveness and never a model delta.
 *   2. the model runs; tools run; the dispatcher records what it executed.
 *   3. `finalize()` crosses the boundary once, and the caller is handed exactly
 *      `decision.deliverable()` and nothing else.
 *
 * A Trio session is a conversation, and most turns are genuinely conversational. Those
 * end ADVISORY: explicitly non-authoritative, and explicitly not a failure, so asking Peh
 * a question does not produce a wall of refusal. What changes is the moment a tool touches
 * the disk -- then the turn is work, and work has to be earned.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  containmentPlaceholder,
  finalizeTurn,
  mintTrustedBase,
  resolveTruthRuntime,
  type AdapterConfig,
  type Decision,
  type HostEvent,
  type HostEventKind,
  type LifecycleSituation,
  type OutputChannel,
  type ProposedClaim,
  type ResolvedRuntime,
  type TrustedRepositoryBinding
} from './truth-agent-adapter.js';

/** Identity is the only thing that varies between the three agents. */
export interface TruthGateIdentity {
  /** `pehlichi` | `loony-luna` | `mad-ptah`. */
  readonly agent: string;
  readonly sessionId: string;
  readonly taskId: string;
}

/**
 * Tools whose effects land on disk, and the event kind each produces.
 *
 * Unknown is not absent: a tool this map has never heard of is reported as an
 * unclassified mutation, so a capability pack that adds a tool cannot quietly obtain the
 * weakest policy by being unfamiliar. The map is an optimisation for the common cases,
 * never the thing that decides whether something counted.
 */
const KNOWN_TOOL_EVENTS: Readonly<Record<string, HostEventKind>> = {
  write_file: 'file-mutation',
  edit_file: 'file-mutation',
  patch_file: 'file-mutation',
  create_file: 'file-mutation',
  delete_file: 'file-mutation',
  move_file: 'file-mutation',
  apply_patch: 'file-mutation',
  memory_write: 'file-mutation',
  brain_put: 'file-mutation',
  git_commit: 'commit',
  bridge_call: 'remote-api-mutation',
  http_request: 'remote-api-mutation',
  send_message: 'external-message',
  delegate: 'delegated-mutation'
};

/** Tools that only read. Everything outside both maps is treated as mutating. */
const READ_ONLY_TOOLS = new Set([
  'read_file', 'list_files', 'glob', 'grep', 'search', 'find', 'stat',
  'git_status', 'git_log', 'git_diff', 'memory_read', 'recall', 'brain_get'
]);

export interface ObservedToolCall {
  readonly name: string;
  readonly ok?: boolean;
}

/**
 * Turn what the dispatcher actually ran into typed host events.
 *
 * The model's prose plays no part. A tool call the model declined to mention still lands
 * here, because this reads the runtime's own record of what it executed.
 */
export function hostEventsFor(
  toolCalls: readonly ObservedToolCall[] | undefined,
  repository: string | null
): HostEvent[] {
  const events: HostEvent[] = [];
  for (const call of toolCalls ?? []) {
    const name = String(call.name ?? '').trim();
    if (!name || READ_ONLY_TOOLS.has(name)) continue;
    const kind = KNOWN_TOOL_EVENTS[name];
    events.push({
      kind: kind ?? 'unknown-mutation',
      source: `trio-tool:${name}`,
      ...(repository ? { repository } : {}),
      ...(kind ? {} : { unclassified: true })
    });
  }
  // Deduplicate on shape so a loop of twenty edits does not become twenty events.
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.kind} ${event.source} ${event.repository ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function gitRootOf(cwd: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) return null;
  const root = (result.stdout ?? '').trim();
  return root && existsSync(root) ? resolve(root) : null;
}

function gitHeadOf(root: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const head = result.status === 0 ? (result.stdout ?? '').trim() : '';
  return /^[0-9a-f]{40}$/.test(head) ? head : null;
}

/**
 * Repository-relative paths that differ from HEAD right now, measured by the runtime.
 *
 * Never from anything the model said. This is the runtime looking at the repository with
 * its own eyes, which is what makes a `file_modified` claim something the host can stand
 * behind rather than something it is repeating.
 */
function changedPathsIn(root: string): string[] {
  const diff = spawnSync('git', ['diff', '--name-only', 'HEAD', '--'], { cwd: root, encoding: 'utf8' });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  const paths = `${diff.stdout ?? ''}\n${untracked.stdout ?? ''}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(paths)].sort().slice(0, 200);
}

function repositoryIdentityOf(root: string): string | null {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
  if (common.status !== 0) return null;
  const commonDir = (common.stdout ?? '').trim();
  if (!commonDir) return null;
  // The identity the verifier computes, so an attestation binds this worktree and not
  // merely this repository: two worktrees share an object store but are different
  // workspaces, and a base captured in one must not be usable in the other.
  const payload = JSON.stringify({ commonDir: resolve(commonDir), gitRoot: root });
  const digest = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))', payload],
    { encoding: 'utf8' }
  );
  return digest.status === 0 ? (digest.stdout ?? '').trim() : null;
}

/**
 * The per-session boundary.
 *
 * The trusted base is captured in the constructor, not at finalization. A base captured
 * after the model has worked is a base the candidate could have moved, which is the whole
 * reason it exists.
 */
export class TruthSessionGate {
  private readonly config: AdapterConfig;
  private readonly identity: TruthGateIdentity;
  private readonly workspace: string;
  private readonly runtime: ResolvedRuntime | null;
  private readonly bindings: TrustedRepositoryBinding[] = [];
  private notified = false;

  constructor(identity: TruthGateIdentity, workspace: string = process.cwd()) {
    this.identity = identity;
    this.workspace = resolve(workspace);
    this.config = { agent: identity.agent, runtime: 'ts-trio-tui' };
    this.runtime = resolveTruthRuntime(this.config);

    const root = gitRootOf(this.workspace);
    if (root) {
      const head = gitHeadOf(root);
      const repositoryIdentity = repositoryIdentityOf(root);
      if (head && repositoryIdentity) {
        const attestation = mintTrustedBase(this.config, {
          agent: identity.agent,
          taskId: identity.taskId,
          sessionId: identity.sessionId,
          repositoryRoot: root,
          repositoryIdentity,
          commit: head
        }, this.runtime);
        this.bindings.push({ repository: root, commit: head, ...(attestation ? { attestation } : {}) });
      }
    }
  }

  /**
   * Wrap a caller's stream callback so it can never receive a model delta.
   *
   * The caller keeps its liveness -- one transport-level line, once -- and the UI keeps
   * working. What it loses is the ability to show text nothing has checked, which is the
   * point. Returning `undefined` instead would silently change the provider request shape
   * (`stream: !!onStream`), so the callback stays present and is defanged instead.
   */
  containStream(onStream?: (chunk: string) => void): ((chunk: string) => void) | undefined {
    if (!onStream) return undefined;
    return () => {
      if (this.notified) return;
      this.notified = true;
      onStream(containmentPlaceholder());
    };
  }

  /**
   * The claims the runtime measured for itself.
   *
   * Empty for a turn that changed nothing: a host with nothing to show should say nothing,
   * and an empty claim set is how an ordinary conversational turn stays ADVISORY instead
   * of being dressed up as work.
   */
  private hostClaims(events: readonly HostEvent[], repository: string | null): ProposedClaim[] {
    if (events.length === 0 || !repository) return [];
    const paths = changedPathsIn(repository);
    if (paths.length === 0) return [];
    return [
      {
        class: 'OBSERVED',
        type: 'file_modified',
        statement: 'the runtime measured these paths differing from the trusted base',
        scope: { paths }
      },
      ...(['test_result', 'typecheck_result', 'build_result'] as const).map((type) => ({
        class: 'OBSERVED' as const,
        type,
        statement: `the policy-owned ${type.replace('_result', '')} script is submitted for independent execution`,
        scope: {}
      })),
      {
        class: 'DERIVED',
        type: 'completion_claim',
        statement: 'scoped completion is derived from measured work and policy-owned evidence',
        scope: {}
      }
    ];
  }

  /** True when a line may be shown mid-turn: it carries no model-authored content. */
  static isTransportStatus(text: string): boolean {
    return text === containmentPlaceholder();
  }

  /**
   * Cross the authority boundary. Never returns raw model text, and never returns null.
   *
   * Called on every path that can produce a final answer -- including the error and
   * budget-exhausted returns, where the temptation to pass the last thing through is
   * strongest and the text has been checked least.
   */
  finalize(input: {
    readonly userMessage: string;
    readonly candidateNarrative: string;
    readonly toolCalls?: readonly ObservedToolCall[];
    readonly channel?: OutputChannel;
    readonly partial?: boolean;
  }): Decision {
    const repository = this.bindings[0]?.repository ?? null;
    const events = hostEventsFor(input.toolCalls, repository);
    const situation: LifecycleSituation = events.length > 0
      ? 'tool-mutation'
      : input.partial
        ? 'partial-work'
        : 'advisory-conversation';

    return finalizeTurn(this.config, {
      taskId: this.identity.taskId,
      sessionId: this.identity.sessionId,
      userOperation: input.userMessage.slice(0, 4000),
      situation,
      outputChannel: input.channel ?? 'tui',
      workspace: this.workspace,
      candidateNarrative: input.candidateNarrative,
      hostEvents: events,
      trustedRepositories: this.bindings,
      // Claims the *runtime* is willing to stand behind, never the model's. `file_modified`
      // is its own measurement of the repository; the verification entries are proposals
      // the protocol settles by running the repository's policy-owned scripts itself, so
      // submitting them asks a question rather than asserting an answer. Nothing here
      // describes the model's reasoning, because the runtime did not observe it.
      proposedClaims: this.hostClaims(events, repository),
      toolIdentities: [`trio-runtime@${this.identity.agent}`]
    }, this.runtime);
  }
}
