import test from "node:test";
import assert from "node:assert/strict";

import { bridgeHost } from "./host.js";

test("bridgeHost defaults to localhost, honours LAB_BRIDGE_HOST", () => {
  const prev = process.env.LAB_BRIDGE_HOST;
  try {
    delete process.env.LAB_BRIDGE_HOST;
    assert.equal(bridgeHost(), "localhost");
    process.env.LAB_BRIDGE_HOST = "100.84.209.89";
    assert.equal(bridgeHost(), "100.84.209.89");
    process.env.LAB_BRIDGE_HOST = "  ";
    assert.equal(bridgeHost(), "localhost", "blank falls back to localhost");
  } finally {
    if (prev === undefined) delete process.env.LAB_BRIDGE_HOST;
    else process.env.LAB_BRIDGE_HOST = prev;
  }
});
