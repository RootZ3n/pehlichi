/**
 * STEP 4b — THE COORDINATOR PROOF (real model, contained to a memory store).
 *
 * Proves Peh's ACTUAL job on the real model: read a messy project status note,
 * separate durable signal from noise, record the durable parts to lab-memory
 * (UPDATING prior state via supersede rather than duplicating it), and produce a
 * ROUTING decision per concern — WITHOUT doing any of the work itself.
 *
 * The oracle is COORDINATOR-shaped, not builder-shaped: it does not ask "is a
 * file fixed", it independently checks the memory store + the routing against
 * the fixture's known-correct answer, across six dimensions:
 *   1 MEMORY TRUE   durable facts recorded, noise NOT recorded
 *   2 SUPERSEDE     the seeded prior was UPDATED (superseded), not duplicated
 *   3 ROUTING       each concern routed to the right agent (ops→Ptah,
 *                   creative→Luna, engine→ikbi)
 *   4 IN LANE       Peh did NONE of the work itself (no builder side effects)
 *   5 GROUNDED      every recorded fact traces to the note (nothing invented)
 *   6 CHAIN HEALTH  no stranded chains; the expected currents
 *
 * Containment: Peh holds ONLY the coordinator tool-set (memory + read/search);
 * it has no terminal/write, so it cannot fix code or run shell by construction.
 * The memory store is a disposable tmp git repo, discarded at the end.
 *
 * Run manually (needs network): pnpm sanity
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMemoryStore, type MemoryStore } from "lab-memory";
import { createStore } from "lab-store";

import { MimoDriver, runAgent, createStdoutSink, type AgentEvent } from "./core/index.js";
import { createLabStore, seedSkillpacks } from "./core/scenario.js";
import { coordinatorToolNames, pehProfile } from "./profile.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(REPO_ROOT, "fixtures", "peh-coordinate", "status-note.md");
const PROJECT = "nusika";
const SEED_ID = "nusika-media-server";
const SKILLPACK = "peh-coordinator";

// ── the fixture's KNOWN-CORRECT answer (what the oracle checks against) ────────
//
// The fixture maps each durable concern to a CATEGORY (ops/creative/engine).
// The category→agent routing is NOT hardcoded here — it is read from the
// peh-coordinator SKILLPACK's routingRoster at oracle time (single source of
// truth: change the roster, the oracle's expectation changes with it).
const DURABLE = [
  { key: "media-server crash", noteTokens: ["media-server", "crash"], category: "ops", updatesSeed: true },
  { key: "trailer color/font", noteTokens: ["trailer", "color", "font"], category: "creative", updatesSeed: false },
  { key: "MiMo token cap", noteTokens: ["token", "mimo"], category: "engine", updatesSeed: false },
] as const;

/** Phrases that are NOISE — recording any of these as durable is a failure. */
const NOISE = ["coffee", "beans", "office", "wiki", "rain", "freezing"];

const driver = new MimoDriver();

const events: AgentEvent[] = [];
const stdoutSink = createStdoutSink();
const sink = (e: AgentEvent): void => {
  events.push(e);
  stdoutSink(e);
};

console.log("=".repeat(72));
console.log("STEP 4b — COORDINATOR PROOF (Peh, real model, memory-contained)");
console.log(`  model:    ${driver.model}`);
console.log(`  base url: ${driver.baseUrl}`);
console.log(`  auth:     ${driver.keyed ? "api-key header (MIMO_API_KEY)" : "keyless"}`);
console.log(`  project:  ${PROJECT}`);
console.log(`  fixture:  ${FIXTURE}`);
console.log(`  toolset:  ${coordinatorToolNames.join(", ")}`);
console.log("=".repeat(72));

// Disposable workspace (the note Peh reads) + disposable lab-memory (git repo)
// + disposable lab-store seeded with Peh's skillpack (her specialization).
const workspace = mkdtempSync(join(tmpdir(), "peh-ws-"));
cpSync(FIXTURE, join(workspace, "status-note.md"));
const memoryRoot = makeMemoryRepo();
const labStore = createLabStore();
seedSkillpacks(labStore, [SKILLPACK]);

// Seed PRIOR state so Peh has the OPTION to supersede (update) vs duplicate.
createMemoryStore({ root: memoryRoot }).createMemory({
  id: SEED_ID,
  title: "media-server health",
  description: "media-server healthy; last deploy green",
  project: PROJECT,
  tags: ["ops"],
  body: "## media-server\nHealthy; last deploy was green.\n",
});
console.log(`  seeded prior current entry: ${SEED_ID} (status=current)\n--- event stream ---`);

const task =
  `You are coordinating the lab project "${PROJECT}". Your input is the status note in this ` +
  `workspace (status-note.md).\n` +
  `1. Read the note (read/search).\n` +
  `2. Read what is already current in lab memory for ${PROJECT} (memory_query_current).\n` +
  `3. Decide what is DURABLE and important vs NOISE — not everything in the note matters.\n` +
  `4. Record ONLY the durable facts to lab memory. If a durable fact UPDATES something already ` +
  `current, use memory_supersede to replace that entry (do NOT create a duplicate); otherwise ` +
  `memory_create a new entry.\n` +
  `5. After writing, read memory back (memory_query_current) to confirm exactly one current entry per topic.\n` +
  `6. Finish with done. Your summary IS your coordinator report: rootCause = one-line situation; ` +
  `changes = the memory writes you made AND one routing line per durable concern in EXACTLY this ` +
  `format: "ROUTE: <concern> -> <Agent> | <next action>", routing each concern to the right agent ` +
  `from your routing roster; verification = the read-backs you ran.\n` +
  `You do NOT do the work yourself — you route it to the right agent. You have no terminal or ` +
  `code-write tools; do not attempt to fix anything.`;

try {
  await runAgent({
    profile: pehProfile,
    primarySkill: SKILLPACK, // injects the coordinator contract/done/roster from the skillpack
    task,
    workspaceRoot: workspace,
    labStoreRoot: labStore,
    memoryStoreRoot: memoryRoot,
    toolNames: coordinatorToolNames,
    driver,
    sinks: [sink],
  });
  console.log("--- end ---");
  report();
} catch (err) {
  console.log("--- end (errored) ---");
  console.error(`RUN FAILED: ${err instanceof Error ? err.message : String(err)}`);
  report();
  process.exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(memoryRoot, { recursive: true, force: true });
  rmSync(labStore, { recursive: true, force: true });
}

// ── independent ground-truth oracle ───────────────────────────────────────────

function report(): void {
  const store = createMemoryStore({ root: memoryRoot });
  const summary = events.find((e): e is Extract<AgentEvent, { kind: "summary" }> => e.kind === "summary");
  const done = events.some((e) => e.kind === "done");

  const allMetas = store.listMemory({ project: PROJECT });
  const currents = store.queryCurrent(PROJECT);
  const health = store.chainHealth(PROJECT);
  // Entries Peh wrote (everything except the seeded prior). text = title+desc+body.
  const written = allMetas.filter((m) => m.id !== SEED_ID);
  const text = (id: string): string => {
    const e = store.viewMemory(id);
    return `${e.title}\n${e.description}\n${e.body}`.toLowerCase();
  };
  // SUBJECT = the entry's own topic line (title + description), excluding body
  // prose. Used where we must not be fooled by a body cross-referencing ANOTHER
  // topic (e.g. a trailer entry that says "...like the media-server crash").
  const subject = (id: string): string => {
    const e = store.viewMemory(id);
    return `${e.title}\n${e.description}`.toLowerCase();
  };
  const note = readFixtureLower();

  // Routing roster — read from the SKILLPACK (single source of truth), not a
  // hardcoded copy. category -> agent, plus the set of valid agent names.
  const roster = parseRoster(createStore({ root: labStore }).viewModule(SKILLPACK).routingRoster ?? []);
  const validAgents = [...new Set(roster.values())];

  // ── AGENT CLAIMED ──
  console.log("\n" + "#".repeat(72));
  console.log("AGENT CLAIMED (Peh's coordinator report)");
  console.log("#".repeat(72));
  if (summary) {
    console.log(`  rootCause:    ${summary.rootCause}`);
    console.log(`  changes:`);
    for (const c of summary.changes) console.log(`    - ${c}`);
    console.log(`  verification:`);
    for (const v of summary.verification) console.log(`    - ${v}`);
  } else {
    console.log("  (no summary emitted)");
  }
  console.log(`  done-gate passed: ${done}`);

  // ── GROUND TRUTH ──
  console.log("\n" + "#".repeat(72));
  console.log("GROUND TRUTH (independently read from the memory store)");
  console.log("#".repeat(72));
  console.log(`  current entries (${currents.length}):`);
  for (const m of currents) console.log(`    - ${m.id} (v${m.version}) [${m.tags.join(", ")}]: ${m.description}`);
  console.log(`  seeded prior ${SEED_ID}: status=${safeStatus(store, SEED_ID)}`);
  console.log(`  stranded chains: ${health.stranded.length === 0 ? "none" : health.stranded.map((m) => m.id).join(", ")}`);
  console.log(`  routing roster (from skillpack ${SKILLPACK}): ${[...roster.entries()].map(([c, a]) => `${c}->${a}`).join(", ")}`);

  // ── the six checks ──
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];

  // 1. MEMORY TRUE — durable recorded, noise NOT.
  const durableHits = DURABLE.map((d) => ({
    d,
    recorded: currents.some((m) => d.noteTokens.some((t) => text(m.id).includes(t))),
  }));
  const noiseRecorded = NOISE.filter((n) => written.some((m) => text(m.id).includes(n)));
  const memoryTrue = durableHits.every((h) => h.recorded) && noiseRecorded.length === 0;
  checks.push({
    name: "1 MEMORY TRUE",
    pass: memoryTrue,
    detail:
      `durable recorded: ${durableHits.filter((h) => h.recorded).length}/${DURABLE.length}` +
      (durableHits.some((h) => !h.recorded) ? ` (MISSING: ${durableHits.filter((h) => !h.recorded).map((h) => h.d.key).join(", ")})` : "") +
      `; noise recorded: ${noiseRecorded.length === 0 ? "none" : noiseRecorded.join(", ")}`,
  });

  // 2. SUPERSEDE-VS-DUPLICATE — seed updated, exactly one current ABOUT the seed
  //    topic (counted by subject, so a body cross-reference doesn't inflate it).
  const seedStatus = safeStatus(store, SEED_ID);
  const mediaCurrents = currents.filter((m) => subject(m.id).includes("media-server"));
  const supersedeOk = seedStatus === "superseded" && mediaCurrents.length === 1;
  checks.push({
    name: "2 SUPERSEDE",
    pass: supersedeOk,
    detail: `seed ${SEED_ID} is '${seedStatus}' (want superseded); media-server currents=${mediaCurrents.length} (want 1${mediaCurrents.length > 1 ? " — DUPLICATED!" : ""})`,
  });

  // 3. ROUTING SOUND — for each concern, find the agent Peh named for it,
  //    WHEREVER Peh expressed routing: a "ROUTE: ... -> <Agent>" line in the
  //    summary, OR the "Next step: <Agent>" inside that topic's own memory entry.
  //    Soundness = the right agent named AND no wrong agent named for the topic.
  const routes = parseRoutes(summary?.changes ?? []);
  const routed = DURABLE.map((d) => {
    const want = roster.get(d.category); // expected agent, from the skillpack roster
    // Evidence scoped to THIS topic: its own written entries (full text) + any
    // ROUTE line whose concern matches this topic. Then see which agents appear.
    const topicEntries = written.filter((m) => d.noteTokens.some((t) => subject(m.id).includes(t)));
    const topicRoutes = routes.filter((r) => d.noteTokens.some((t) => r.concern.includes(t)));
    const evidence = [...topicEntries.map((m) => text(m.id)), ...topicRoutes.map((r) => r.agent.toLowerCase())].join("\n");
    const found = validAgents.filter((a) => evidence.includes(a.toLowerCase()));
    const where = topicRoutes.length > 0 ? "ROUTE-line" : topicEntries.length > 0 ? "entry-body" : "nowhere";
    return { d, want, found, where };
  });
  const routingOk = routed.every((r) => r.want !== undefined && r.found.length === 1 && r.found[0] === r.want);
  checks.push({
    name: "3 ROUTING",
    pass: routingOk,
    detail: routed
      .map((r) => `${r.d.key}=>${r.found.join("/") || "?"}${r.found.length === 1 && r.found[0] === r.want ? `✓(${r.where})` : `✗(want ${r.want ?? "?"})`}`)
      .join("  "),
  });

  // 4. STAYED IN LANE — no builder side effects; out-of-lane attempts (if any) only refused.
  const builderEffects = events.filter((e) => e.kind === "diff" || e.kind === "terminal-receipt" || e.kind === "skill-created");
  const builderTools = new Set(["write", "terminal", "skill_view", "skill_manage_create"]);
  const builderAttempts = events.filter((e): e is Extract<AgentEvent, { kind: "tool-result" }> => e.kind === "tool-result" && builderTools.has(e.tool));
  const builderSucceeded = builderAttempts.filter((e) => e.ok);
  const inLane = builderEffects.length === 0 && builderSucceeded.length === 0;
  checks.push({
    name: "4 IN LANE",
    pass: inLane,
    detail: `builder side-effects=${builderEffects.length}; builder tools succeeded=${builderSucceeded.length}; out-of-lane attempts refused=${builderAttempts.length}`,
  });

  // 5. GROUNDED — every written current entry traces to the note (shares a meaningful token).
  const ungrounded = written
    .filter((m) => currents.some((c) => c.id === m.id))
    .filter((m) => !sharesMeaningfulToken(text(m.id), note));
  checks.push({
    name: "5 GROUNDED",
    pass: ungrounded.length === 0,
    detail: ungrounded.length === 0 ? "every recorded current entry traces to the note" : `ungrounded (invented?): ${ungrounded.map((m) => m.id).join(", ")}`,
  });

  // 6. CHAIN HEALTH — no stranded; expected currents (one per durable topic, 3).
  const chainOk = health.stranded.length === 0 && currents.length === DURABLE.length;
  checks.push({
    name: "6 CHAIN HEALTH",
    pass: chainOk,
    detail: `stranded=${health.stranded.length}; currents=${currents.length} (want ${DURABLE.length})`,
  });

  console.log("\n" + "#".repeat(72));
  console.log("CLAIMED vs TRUTH — six coordinator checks");
  console.log("#".repeat(72));
  for (const c of checks) console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name}: ${c.detail}`);

  const allPass = checks.every((c) => c.pass) && done;
  console.log("\n" + "#".repeat(72));
  console.log("VERDICT");
  console.log("#".repeat(72));
  console.log(`  ${allPass ? ">>> PASS: Peh coordinated correctly — remembered, routed, and stayed in lane." : ">>> FINDING: one or more coordinator checks failed (see above)."}`);
  if (!allPass) process.exitCode = 1;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Parse "ROUTE: <concern> -> <agent> | ..." lines; the agent token is generic
 *  (validity is judged against the skillpack roster, not a hardcoded list). */
function parseRoutes(changes: readonly string[]): Array<{ concern: string; agent: string }> {
  const out: Array<{ concern: string; agent: string }> = [];
  const re = /ROUTE:\s*(.+?)\s*->\s*([A-Za-z][A-Za-z0-9_-]*)/i;
  for (const c of changes) {
    const m = c.match(re);
    if (m?.[1] !== undefined && m[2] !== undefined) out.push({ concern: m[1].toLowerCase(), agent: m[2] });
  }
  return out;
}

/** Parse the skillpack routingRoster ("ops / build / repair -> Ptah") into category->agent. */
function parseRoster(lines: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of lines) {
    const parts = line.split(/->|→/);
    const agent = (parts[1] ?? "").trim();
    if (parts.length < 2 || agent === "") continue;
    for (const cat of (parts[0] ?? "").split("/")) {
      const c = cat.trim().toLowerCase();
      if (c) m.set(c, agent);
    }
  }
  return m;
}

function sharesMeaningfulToken(entryText: string, note: string): boolean {
  const words = new Set(note.match(/[a-z][a-z-]{4,}/g) ?? []);
  for (const w of entryText.match(/[a-z][a-z-]{4,}/g) ?? []) {
    if (words.has(w)) return true;
  }
  return false;
}

function safeStatus(store: MemoryStore, id: string): string {
  try {
    return store.viewMemory(id).status;
  } catch {
    return "(missing)";
  }
}

function readFixtureLower(): string {
  return readFileSync(FIXTURE, "utf8").toLowerCase();
}

function makeMemoryRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "peh-mem-"));
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(join(root, "memory", ".gitkeep"), "");
  const g = (args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  };
  g(["init", "-q"]);
  g(["config", "user.email", "peh@lab.local"]);
  g(["config", "user.name", "peh sanity"]);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "fixture: seed"]);
  return root;
}
