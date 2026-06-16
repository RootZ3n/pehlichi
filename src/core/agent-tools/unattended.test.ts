/**
 * L6 unattended profile tests (req #3). Every gate is DENY BY DEFAULT.
 */
import { test, describe } from "node:test";
import { strictEqual, ok, match, throws, doesNotThrow } from "node:assert";
import {
  unattendedToolDenyReason,
  isToolAllowedUnattended,
  shellMetaDenyReason,
  terminalUnattendedDenyReason,
  fetchUnattendedDenyReason,
  browserUnattendedDenyReason,
  secretFileReadDenyReason,
  assertUnattendedStartup,
  delegationDepthDenyReason,
  SharedBudget,
  verifyUnattendedSuccess,
} from "./unattended.js";

describe("unattended tool gating", () => {
  test("denies terminal by default", () => {
    ok(unattendedToolDenyReason("terminal"));
    strictEqual(isToolAllowedUnattended("terminal"), false);
  });

  test("denies browser tools by default", () => {
    ok(unattendedToolDenyReason("browser_navigate"));
    ok(unattendedToolDenyReason("browser_console"));
  });

  test("denies raw web fetch + cron + brain sync by default", () => {
    ok(unattendedToolDenyReason("web_extract"));
    ok(unattendedToolDenyReason("cronjob"));
    ok(unattendedToolDenyReason("brain_sync"));
  });

  test("allows read-only + proposal tools", () => {
    strictEqual(isToolAllowedUnattended("read_file"), true);
    strictEqual(isToolAllowedUnattended("search_files"), true);
    strictEqual(isToolAllowedUnattended("memory_write"), true); // proposal-only
  });

  test("unknown tool is denied (deny by default)", () => {
    ok(unattendedToolDenyReason("some_new_tool"));
  });

  test("an explicit operator grant can allow delegate_task", () => {
    strictEqual(isToolAllowedUnattended("delegate_task"), false);
    strictEqual(isToolAllowedUnattended("delegate_task", { grantedTools: new Set(["delegate_task"]) }), true);
    // ...but a hard-denied tool can never be granted back
    ok(unattendedToolDenyReason("terminal", { grantedTools: new Set(["terminal"]) }));
  });
});

describe("unattended shell + terminal", () => {
  test("denies shell metacharacters", () => {
    ok(shellMetaDenyReason("rm -rf / ; echo hi"));
    ok(shellMetaDenyReason("cat foo && cat bar"));
    ok(shellMetaDenyReason("echo $(whoami)"));
    strictEqual(shellMetaDenyReason("status"), null);
  });

  test("terminal denied with no governed argv allowlist", () => {
    const r = terminalUnattendedDenyReason({ bin: "ls", args: ["-la"] });
    ok(r);
    match(r!, /no governed argv allowlist/);
  });

  test("terminal allowed only for an allowlisted binary via governed exec", () => {
    const allow = new Set(["git"]);
    strictEqual(terminalUnattendedDenyReason({ bin: "git", args: ["status"] }, allow), null);
    ok(terminalUnattendedDenyReason({ bin: "rm", args: ["-rf", "/"] }, allow));
    // metacharacters denied even for an allowlisted binary
    ok(terminalUnattendedDenyReason({ bin: "git", args: ["status; rm -rf /"] }, allow));
  });
});

describe("unattended network + secrets", () => {
  test("denies raw fetch by default (no egress allowlist)", () => {
    const r = fetchUnattendedDenyReason("evil.example.com");
    ok(r);
    match(r!, /network is disabled/);
  });

  test("fetch allowed only for an allowlisted host", () => {
    const allow = new Set(["docs.python.org"]);
    strictEqual(fetchUnattendedDenyReason("docs.python.org", allow), null);
    ok(fetchUnattendedDenyReason("evil.example.com", allow));
  });

  test("browser navigation/evaluate is always denied", () => {
    ok(browserUnattendedDenyReason());
  });

  test("denies reading secret-bearing files", () => {
    ok(secretFileReadDenyReason("/repo/.env"));
    ok(secretFileReadDenyReason("/repo/.env.production"));
    ok(secretFileReadDenyReason("/home/u/.ssh/id_rsa"));
    ok(secretFileReadDenyReason("/srv/private.key"));
    ok(secretFileReadDenyReason("/srv/server.pem"));
    ok(secretFileReadDenyReason("/app/.git-credentials"));
    ok(secretFileReadDenyReason("/app/credentials.json"));
    // normal source files are fine
    strictEqual(secretFileReadDenyReason("/repo/src/index.ts"), null);
    strictEqual(secretFileReadDenyReason("/repo/README.md"), null);
  });
});

describe("unattended startup guard", () => {
  test("fails startup with AGENT_FS_UNRESTRICTED=true", () => {
    throws(() => assertUnattendedStartup({ AGENT_FS_UNRESTRICTED: "true" } as NodeJS.ProcessEnv), /refuses to start/);
  });
  test("starts cleanly otherwise", () => {
    doesNotThrow(() => assertUnattendedStartup({} as NodeJS.ProcessEnv));
    doesNotThrow(() => assertUnattendedStartup({ AGENT_FS_UNRESTRICTED: "false" } as NodeJS.ProcessEnv));
  });
});

describe("unattended delegation + budget", () => {
  test("delegation depth beyond the grant fails closed", () => {
    strictEqual(delegationDepthDenyReason(0, 0), null);
    strictEqual(delegationDepthDenyReason(1, 1), null);
    ok(delegationDepthDenyReason(1, 0));
    ok(delegationDepthDenyReason(3, 2));
  });

  test("nested delegation consumes the SHARED global budget", () => {
    const budget = new SharedBudget(10);
    // parent consumes 4
    ok(budget.consume(4));
    // a nested delegate receives the SAME instance and consumes 4 more
    const nested = budget;
    ok(nested.consume(4));
    strictEqual(budget.spent, 8);
    strictEqual(budget.remaining, 2);
    // a deeper nested call cannot overrun the shared total
    strictEqual(nested.consume(5), false);
    ok(budget.exhausted);
  });

  test("budget exhaustion is never success", () => {
    const budget = new SharedBudget(2);
    budget.consume(2);
    const verdict = verifyUnattendedSuccess({ noChangeRequired: true, evidence: ["ran a check"] }, budget);
    strictEqual(verdict.verified, false);
    match(verdict.reason, /budget exhausted/);
  });

  test("noChangeRequired without independent evidence is NOT verified success", () => {
    strictEqual(verifyUnattendedSuccess({ noChangeRequired: true }).verified, false);
    strictEqual(verifyUnattendedSuccess({ noChangeRequired: true, evidence: [] }).verified, false);
    // with evidence and budget remaining, it IS verified
    strictEqual(verifyUnattendedSuccess({ noChangeRequired: true, evidence: ["tool result"] }).verified, true);
  });
});
