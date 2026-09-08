/*
 * RETIRED TOOL TESTS REMOVED.
 *
 * `ikbi_build` and `ikbi_fix` submitted to `POST /api/build`, which ikbi deleted with its v1
 * engine and which now answers 404. They are gone from the assembled schema, so the twelve tests
 * that exercised their HTTP behaviour were describing a surface no model can reach. Their
 * replacement lives in `src/core/delegation/tool.test.ts`, which asserts the stronger property:
 * the names are absent from the schema, and calling one by hand yields a typed refusal naming
 * `delegate_implementation` rather than anything a model could mistake for an accepted build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createIkbiToolHandlers, ikbiToolSpecs } from "./ikbi-tools.js";
import { governedMkdtemp } from "../temp-authority.js";
import { createFullToolRegistry } from "./index.js";
import type { ToolContext } from "../tools.js";

const ctx: ToolContext = { workspaceRoot: governedMkdtemp("ikbi-ws-"), labStoreRoot: governedMkdtemp("ikbi-store-"), store: {} };

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

/**
 * A responder for the current two-step build flow: `ikbi_build` first GETs `/capabilities` to
 * confirm the surface is live, then POSTs `/api/build`. `caps.endpoints` decides availability.
 */
function buildResponder(opts: { endpoints?: string[]; taskId?: string } = {}) {
  const endpoints = opts.endpoints ?? ["/health", "/capabilities", "/api/build"];
  return (url: string) => {
    if (/\/capabilities$/.test(url)) return jsonResponse(200, { agent: "ikbi", endpoints, tools: [] });
    return jsonResponse(200, { taskId: opts.taskId ?? "task-abc" });
  };
}


test("ikbi tools are registered in the full tool registry", () => {
  const tools = createFullToolRegistry({ workspaceRoot: governedMkdtemp("ikbi-reg-ws-"), agentServerUrl: "http://127.0.0.1:0", agentId: "test-agent" });
  const names = new Set(tools.map((t) => t.spec.name));
  for (const spec of ikbiToolSpecs) {
    assert.ok(names.has(spec.name), `${spec.name} registered`);
  }
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

// ── fallback routing (lab → on-device) ────────────────────────────────────────
/** Run `fn` with primary+fallback ikbi endpoints set, restoring the env afterward. */
async function withEndpoints(
  env: { primary: string; fallback?: string; token?: string; fallbackToken?: string },
  fn: () => Promise<void>,
): Promise<void> {
  const keys = ["IKBI_API_URL", "IKBI_API_URL_FALLBACK", "IKBI_API_TOKEN", "IKBI_API_TOKEN_FALLBACK"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env["IKBI_API_URL"] = env.primary;
  if (env.fallback !== undefined) process.env["IKBI_API_URL_FALLBACK"] = env.fallback; else delete process.env["IKBI_API_URL_FALLBACK"];
  if (env.token !== undefined) process.env["IKBI_API_TOKEN"] = env.token; else delete process.env["IKBI_API_TOKEN"];
  if (env.fallbackToken !== undefined) process.env["IKBI_API_TOKEN_FALLBACK"] = env.fallbackToken; else delete process.env["IKBI_API_TOKEN_FALLBACK"];
  try { await fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  }
}

test("falls back to the on-device ikbi when the lab endpoint is UNREACHABLE", async () => {
  await withEndpoints({ primary: "http://lab:18796", fallback: "http://127.0.0.1:18796", fallbackToken: "local-tok" }, async () => {
    await withFetch(
      (url) => {
        if (url.startsWith("http://lab:18796")) throw new Error("ECONNREFUSED"); // lab down
        return jsonResponse(200, { tasks: [], total: 0 });
      },
      async (calls) => {
        const res = await handlers.get("ikbi_status")!({}, ctx);
        assert.equal(res.ok, true, "status succeeds via fallback");
        assert.equal(calls.length, 2, "tried lab then fell back to local");
        assert.ok(calls[0]!.url.startsWith("http://lab:18796"));
        assert.ok(calls[1]!.url.startsWith("http://127.0.0.1:18796"));
        // The fallback endpoint's own token is used, not the primary's.
        assert.equal((calls[1]!.init?.headers as Record<string, string>)["authorization"], "Bearer local-tok");
      },
    );
  });
});

test("does NOT fall back when the lab RESPONDS with an HTTP error (a real result, not a connectivity gap)", async () => {
  await withEndpoints({ primary: "http://lab:18796", fallback: "http://127.0.0.1:18796" }, async () => {
    await withFetch(
      (url) => (url.startsWith("http://lab:18796") ? jsonResponse(500, { error: "boom" }) : jsonResponse(200, { tasks: [] })),
      async (calls) => {
        const res = await handlers.get("ikbi_status")!({}, ctx);
        assert.equal(res.ok, false);
        assert.equal(calls.length, 1, "the reachable lab error is returned; no fallback");
      },
    );
  });
});

test("no fallback endpoint configured ⇒ a single attempt, unreachable surfaces clearly", async () => {
  await withEndpoints({ primary: "http://lab:18796" }, async () => {
    await withFetch(
      () => { throw new Error("ECONNREFUSED"); },
      async (calls) => {
        const res = await handlers.get("ikbi_status")!({}, ctx);
        assert.equal(res.ok, false);
        assert.equal(calls.length, 1);
        assert.match(res.error ?? "", /cannot reach ikbi/);
      },
    );
  });
});

// ── the retirement honesty fix ──────────────────────────────────────────────────────────────


test("ikbi_build reports a doomed 202-then-fail server honestly, not as accepted work", async () => {
  // This is the exact production shape: the endpoint 202s with a taskId, but its worker will throw
  // "HTTP build tasks are retired". The capabilities list is the surface's honest self-report, and
  // it omits the build endpoint, so the tool refuses before it can be handed a doomed task id.
  await withFetch(
    (url: string) => {
      if (/\/capabilities$/.test(url)) return jsonResponse(200, { endpoints: ["/health", "/chat"] });
      return jsonResponse(202, { taskId: "build-doomed-999" });  // the server WOULD accept it
    },
    async (calls) => {
      const res = await handlers.get("ikbi_build")!({ goal: "x", repo: "/r" }, ctx);
      assert.equal(res.ok, false);
      assert.equal((res.output ?? "").includes("build-doomed-999"), false,
        "the doomed task id leaked into a success-shaped output");
      assert.equal(calls.some((c) => /\/api\/build$/.test(c.url)), false);
    },
  );
});

