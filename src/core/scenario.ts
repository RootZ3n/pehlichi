/**
 * The full-loop scenario, shared by tests and sanity scripts so the loop is
 * exercised identically whether asserted or watched.
 *
 * A tmp workspace holds two fake scripts that hardcode a wrong value; a scripted
 * driver investigates, diagnoses, fixes one, verifies on the real stack, banks a
 * skill, and closes with a structured summary.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DriverAction } from "./driver.js";

/** The sibling lab-store repo (single source of truth for skillpack content). */
const REAL_LAB_STORE = join(dirname(dirname(fileURLToPath(import.meta.url))), "..", "lab-store");

/**
 * Copy named modules (skillpacks/conventions) from the REAL lab-store into a
 * disposable store, so a sanity/test run gets the authored skillpack content
 * (one source of truth) while keeping writes (e.g. skill_manage_create)
 * contained to the tmp store. Searches the allowed type dirs for `<name>.md`.
 */
export function seedSkillpacks(storeRoot: string, names: readonly string[]): void {
  for (const name of names) {
    let copied = false;
    for (const type of ["skills", "conventions"]) {
      const src = join(REAL_LAB_STORE, type, `${name}.md`);
      if (!existsSync(src)) continue;
      mkdirSync(join(storeRoot, type), { recursive: true });
      copyFileSync(src, join(storeRoot, type, `${name}.md`));
      copied = true;
      break;
    }
    if (!copied) throw new Error(`seedSkillpacks: module "${name}" not found in ${REAL_LAB_STORE}`);
  }
}

export const WRONG_VALUE = "TIMEOUT=30";
export const RIGHT_VALUE = "TIMEOUT=60";
export const SKILL_NAME = "grep-verify-after-edit";

export const APP_BEFORE = `#!/bin/sh
RETRIES=3
${WRONG_VALUE}
echo "running with TIMEOUT=$TIMEOUT"
`;

export const APP_AFTER = `#!/bin/sh
RETRIES=3
${RIGHT_VALUE}
echo "running with TIMEOUT=$TIMEOUT"
`;

const LIB_CONTENT = `# mirror of app.sh
${WRONG_VALUE}
`;

/** Create a tmp workspace with the two fake scripts. Returns its root. */
export function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "lab-ws-"));
  writeFileSync(join(root, "app.sh"), APP_BEFORE);
  writeFileSync(join(root, "lib.sh"), LIB_CONTENT);
  return root;
}

/** Create a tmp lab-store: a real git repo with an empty skills/ dir. Returns its root. */
export function createLabStore(): string {
  const root = mkdtempSync(join(tmpdir(), "lab-store-"));
  mkdirSync(join(root, "skills"), { recursive: true });
  mkdirSync(join(root, "conventions"), { recursive: true });
  writeFileSync(join(root, "skills", ".gitkeep"), "");
  git(["init", "-q"], root);
  git(["config", "user.email", "lab@lab.local"], root);
  git(["config", "user.name", "pehlichi test"], root);
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "fixture: seed"], root);
  return root;
}

/** The canned driver sequence for the full-loop scenario. */
export function scenarioActions(): DriverAction[] {
  return [
    { kind: "narrate", phase: "investigate", text: "Reading the two scripts to find the timeout setting." },
    { kind: "tool", tool: "read", args: { path: "app.sh" } },
    { kind: "tool", tool: "read", args: { path: "lib.sh" } },
    { kind: "tool", tool: "search", args: { query: WRONG_VALUE } },
    {
      kind: "root-cause",
      text: `Both scripts hardcode ${WRONG_VALUE}, which is too low; app.sh must use ${RIGHT_VALUE}.`,
    },
    { kind: "narrate", phase: "act", text: "Raising the timeout to 60 in app.sh." },
    { kind: "tool", tool: "write", args: { path: "app.sh", content: APP_AFTER } },
    { kind: "narrate", phase: "verify", text: "Grepping the file to confirm the corrected value landed." },
    { kind: "tool", tool: "terminal", args: { command: "grep TIMEOUT app.sh" } },
    { kind: "tool", tool: "read", args: { path: "app.sh" } },
    {
      kind: "tool",
      tool: "skill_manage_create",
      args: {
        name: SKILL_NAME,
        description: "After editing a file, grep it on the real stack to confirm the new value landed.",
        type: "skills",
        tags: ["verification", "discipline"],
        body: "## When to use\nAfter any edit whose effect is a specific value in a file.\n## Steps\n1. Write the change.\n2. grep the file for the new value.\n3. Confirm exit 0 and the value in stdout.\n## Pitfalls\n- \"Files written\" is not \"value correct\"; only the grep proves it.\n",
      },
    },
    {
      kind: "done",
      summary: {
        rootCause: `app.sh hardcoded ${WRONG_VALUE}.`,
        changes: [`Set ${RIGHT_VALUE} in app.sh`],
        verification: ["grep TIMEOUT app.sh shows TIMEOUT=60 (exit 0)", "re-read app.sh confirms the line"],
      },
    },
  ];
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}
