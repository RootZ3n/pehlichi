import assert from "node:assert/strict";
import { test } from "node:test";

import { createIkbiToolHandlers, ikbiToolSpecs } from "./ikbi-tools.js";
import { createFullToolRegistry } from "./index.js";
import type { ToolContext } from "../tools.js";

const ctx: ToolContext = { workspaceRoot: "/tmp", labStoreRoot: "/tmp", store: {} };

/**
 * Install a fake global.fetch for the duration of `fn`, recording every request
 * it receives. `responder` returns either a Response-like object or throws (to
 * simulate a connection error / timeout). Restores the real fetch afterward.
 */
async function withFetch(
  responder: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
  fn: (calls: Array<{ url: string; init: RequestInit | undefined }>) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return responder(url, init);
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** Minimal Response builder for the success paths. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const handlers = createIkbiToolHandlers();

test("ikbi tools are registered in the full tool registry", () => {
  const tools = createFullToolRegistry({ workspaceRoot: "/tmp", agentServerUrl: "http://127.0.0.1:0" });
  const names = new Set(tools.map((t) => t.spec.name));
  for (const spec of ikbiToolSpecs) {
    assert.ok(names.has(spec.name), `${spec.name} registered`);
  }
});

test("ikbi_build with a valid request returns the taskId and POSTs to /api/build", async () => {
  await withFetch(
    () => jsonResponse(200, { taskId: "task-abc" }),
    async (calls) => {
      const res = await handlers.get("ikbi_build")!(
        { goal: "build a parser", repo: "/repo/x", builderMode: "patch" },
        ctx,
      );
      assert.equal(res.ok, true);
      assert.match(res.output, /task-abc/);
      assert.equal(calls.length, 1);
      assert.match(calls[0]!.url, /\/api\/build$/);
      assert.equal(calls[0]!.init?.method, "POST");
      const body = JSON.parse(String(calls[0]!.init?.body));
      assert.deepEqual(body, { goal: "build a parser", repo: "/repo/x", builderMode: "patch" });
    },
  );
});

test("ikbi_build defaults builderMode to 'agent'", async () => {
  await withFetch(
    () => jsonResponse(200, { taskId: "t1" }),
    async (calls) => {
      const res = await handlers.get("ikbi_build")!({ goal: "g", repo: "/r" }, ctx);
      assert.equal(res.ok, true);
      const body = JSON.parse(String(calls[0]!.init?.body));
      assert.equal(body.builderMode, "agent");
    },
  );
});

test("ikbi_build requires goal and repo", async () => {
  const noGoal = await handlers.get("ikbi_build")!({ repo: "/r" }, ctx);
  assert.equal(noGoal.ok, false);
  assert.match(noGoal.error ?? "", /goal/);
  const noRepo = await handlers.get("ikbi_build")!({ goal: "g" }, ctx);
  assert.equal(noRepo.ok, false);
  assert.match(noRepo.error ?? "", /repo/);
});

test("ikbi_build with a connection error returns a clear error (ikbi down)", async () => {
  await withFetch(
    () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:18796");
    },
    async () => {
      const res = await handlers.get("ikbi_build")!({ goal: "g", repo: "/r" }, ctx);
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /cannot reach ikbi/);
      assert.match(res.error ?? "", /ECONNREFUSED/);
    },
  );
});

test("ikbi_fix with a valid request returns the taskId and POSTs to /api/fix", async () => {
  await withFetch(
    () => jsonResponse(200, { taskId: "fix-1" }),
    async (calls) => {
      const res = await handlers.get("ikbi_fix")!(
        { repo: "/repo/y", check: "npm test", goal: "flaky", allowTestEdits: true },
        ctx,
      );
      assert.equal(res.ok, true);
      assert.match(res.output, /fix-1/);
      assert.match(calls[0]!.url, /\/api\/fix$/);
      const body = JSON.parse(String(calls[0]!.init?.body));
      assert.deepEqual(body, { repo: "/repo/y", allowTestEdits: true, check: "npm test", goal: "flaky" });
    },
  );
});

test("ikbi_fix defaults allowTestEdits to false and omits optional fields", async () => {
  await withFetch(
    () => jsonResponse(200, { taskId: "fix-2" }),
    async (calls) => {
      const res = await handlers.get("ikbi_fix")!({ repo: "/r" }, ctx);
      assert.equal(res.ok, true);
      const body = JSON.parse(String(calls[0]!.init?.body));
      assert.deepEqual(body, { repo: "/r", allowTestEdits: false });
    },
  );
});

test("ikbi_fix requires a repo", async () => {
  const res = await handlers.get("ikbi_fix")!({}, ctx);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /repo/);
});

test("ikbi_status with a taskId GETs that task and returns its state", async () => {
  const state = { taskId: "t9", status: "running", roles: ["planner"], cost: 0.12, filesChanged: [] };
  await withFetch(
    () => jsonResponse(200, state),
    async (calls) => {
      const res = await handlers.get("ikbi_status")!({ taskId: "t9" }, ctx);
      assert.equal(res.ok, true);
      assert.match(res.output, /"status": "running"/);
      assert.match(calls[0]!.url, /\/api\/tasks\/t9$/);
      assert.equal(calls[0]!.init?.method, "GET");
    },
  );
});

test("ikbi_status without a taskId lists recent tasks", async () => {
  await withFetch(
    () => jsonResponse(200, { tasks: [{ taskId: "a" }, { taskId: "b" }] }),
    async (calls) => {
      const res = await handlers.get("ikbi_status")!({}, ctx);
      assert.equal(res.ok, true);
      assert.match(res.output, /"taskId": "a"/);
      assert.match(calls[0]!.url, /\/api\/tasks\?limit=10$/);
    },
  );
});

test("ikbi_status handles ikbi being down gracefully", async () => {
  await withFetch(
    () => {
      throw new Error("fetch failed");
    },
    async () => {
      const res = await handlers.get("ikbi_status")!({ taskId: "t" }, ctx);
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /cannot reach ikbi/);
    },
  );
});

test("ikbi tools surface a 4xx/5xx server error with its message", async () => {
  await withFetch(
    () => jsonResponse(400, { error: "repo not found" }),
    async () => {
      const res = await handlers.get("ikbi_build")!({ goal: "g", repo: "/r" }, ctx);
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /400/);
      assert.match(res.error ?? "", /repo not found/);
    },
  );
});

test("ikbi_build errors when ikbi accepts but returns no taskId", async () => {
  await withFetch(
    () => jsonResponse(200, { ok: true }),
    async () => {
      const res = await handlers.get("ikbi_build")!({ goal: "g", repo: "/r" }, ctx);
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /no taskId/);
    },
  );
});

test("an Authorization: Bearer header is sent when IKBI_API_TOKEN is set (HIGH 3)", async () => {
  const prev = process.env["IKBI_API_TOKEN"];
  process.env["IKBI_API_TOKEN"] = "s3cret-ikbi-token";
  try {
    await withFetch(
      () => jsonResponse(200, { taskId: "t" }),
      async (calls) => {
        await handlers.get("ikbi_build")!({ goal: "g", repo: "/r" }, ctx);
        const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
        assert.equal(headers?.["authorization"], "Bearer s3cret-ikbi-token");
        // The content-type is preserved for the POST body alongside the auth header.
        assert.equal(headers?.["content-type"], "application/json");
      },
    );
  } finally {
    if (prev === undefined) delete process.env["IKBI_API_TOKEN"];
    else process.env["IKBI_API_TOKEN"] = prev;
  }
});

test("no Authorization header is sent when IKBI_API_TOKEN is unset (open mode, HIGH 3)", async () => {
  const prev = process.env["IKBI_API_TOKEN"];
  delete process.env["IKBI_API_TOKEN"];
  try {
    await withFetch(
      () => jsonResponse(200, { tasks: [] }),
      async (calls) => {
        await handlers.get("ikbi_status")!({}, ctx);
        const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
        assert.equal(headers["authorization"], undefined);
      },
    );
  } finally {
    if (prev !== undefined) process.env["IKBI_API_TOKEN"] = prev;
  }
});

test("error messages strip credentials embedded in IKBI_API_URL (MEDIUM 7)", async () => {
  const prevUrl = process.env["IKBI_API_URL"];
  process.env["IKBI_API_URL"] = "http://peh:sup3rsecret@ikbi.internal:9999";
  try {
    await withFetch(
      () => {
        throw new Error("connect ECONNREFUSED");
      },
      async () => {
        const res = await handlers.get("ikbi_status")!({ taskId: "t" }, ctx);
        assert.equal(res.ok, false);
        const err = res.error ?? "";
        assert.doesNotMatch(err, /sup3rsecret/, "the password must not leak into the error");
        assert.doesNotMatch(err, /peh:/, "the userinfo must not leak into the error");
        assert.match(err, /ikbi\.internal:9999/, "the origin is still shown for diagnosability");
      },
    );
  } finally {
    if (prevUrl === undefined) delete process.env["IKBI_API_URL"];
    else process.env["IKBI_API_URL"] = prevUrl;
  }
});

test("IKBI_API_URL overrides the base URL", async () => {
  const prev = process.env["IKBI_API_URL"];
  process.env["IKBI_API_URL"] = "http://ikbi.internal:9999/";
  try {
    await withFetch(
      () => jsonResponse(200, { taskId: "t" }),
      async (calls) => {
        await handlers.get("ikbi_status")!({ taskId: "t" }, ctx);
        // Trailing slash trimmed, custom host honored.
        assert.equal(calls[0]!.url, "http://ikbi.internal:9999/api/tasks/t");
      },
    );
  } finally {
    if (prev === undefined) delete process.env["IKBI_API_URL"];
    else process.env["IKBI_API_URL"] = prev;
  }
});
