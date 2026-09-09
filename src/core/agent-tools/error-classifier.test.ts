/**
 * ERROR CLASSIFIER — and specifically, what it must NOT conclude.
 *
 * The classifier reads prose when nothing better is available, and two of its rules were
 * matching words rather than meanings: any message containing "abort" became a provider
 * timeout (so caller-cancelled work looked retriable), and any message containing "length"
 * became a truncated completion (so ordinary text was sent to the compressor).
 *
 * The negative controls below are the point of this file. A classifier is easy to make pass on
 * inputs it was written against; what makes it trustworthy is that it declines to classify
 * inputs that merely LOOK like the ones it knows.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyError } from "./error-classifier.js";

// ---------------------------------------------------------------------------
// Negative controls: prose that must NOT be classified from its words alone
// ---------------------------------------------------------------------------

test("ordinary prose containing 'length' is NOT a truncated completion", () => {
  for (const prose of [
    "the response content-length header was missing",
    "Invalid length for parameter 'name'",
    "we should discuss the length of the retry window at some length",
    "argument list too long: check the length",
  ]) {
    const c = classifyError(new Error(prose));
    assert.notEqual(c.category, "truncated", `misclassified as truncated: ${prose}`);
    assert.equal(c.shouldCompress, false, `wrongly asked for compression: ${prose}`);
  }
});

test("caller-cancel language containing 'abort' is NOT a provider timeout", () => {
  for (const prose of [
    "the operator chose to abort the run",
    "aborting the plan because the user said stop",
    "abort: nothing to commit",
  ]) {
    const c = classifyError(new Error(prose));
    assert.notEqual(c.category, "timeout", `misclassified as timeout: ${prose}`);
    assert.equal(c.retryable, false, `wrongly marked retriable: ${prose}`);
  }
});

test("a real AbortError is a CANCELLATION, not a provider timeout", () => {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  const c = classifyError(err);
  assert.equal(c.category, "cancelled");
  // Retrying work somebody deliberately stopped is the failure this prevents.
  assert.equal(c.retryable, false);
  assert.equal(c.shouldFallback, false);
});

test("an explicit caller cancellation outranks any text in the message", () => {
  // Worst case: the message says "timed out", which the prose ladder would believe.
  const c = classifyError(new Error("request timed out"), undefined, undefined, { callerCancelled: true });
  assert.equal(c.category, "cancelled");
  assert.equal(c.retryable, false);
});

// ---------------------------------------------------------------------------
// Structured facts outrank prose
// ---------------------------------------------------------------------------

test("finish_reason=length is truncation, and it is read as a FIELD not a word", () => {
  const structured = classifyError(new Error("model stopped"), undefined, undefined, { finishReason: "length" });
  assert.equal(structured.category, "truncated");
  assert.equal(structured.shouldCompress, true);

  // The same word, arriving as prose, must not reach the same conclusion.
  const prose = classifyError(new Error("please keep the answer to a reasonable length"));
  assert.notEqual(prose.category, "truncated");
});

test("an elapsed deadline this process armed is a timeout", () => {
  const c = classifyError(new Error("gave up"), undefined, undefined, { deadlineElapsed: true });
  assert.equal(c.category, "timeout");
  assert.equal(c.retryable, true);
});

test("a TimeoutError is a timeout even when its message says nothing useful", () => {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  assert.equal(classifyError(err).category, "timeout");
});

test("a provider machine code is used in preference to the message", () => {
  const c = classifyError(new Error("something went wrong"), 400, "", { providerCode: "context_length_exceeded" });
  assert.equal(c.category, "context_overflow");
  assert.equal(c.shouldCompress, true);
});

test("an UNRECOGNISED provider code falls through rather than being forced into a category", () => {
  // A code from a dialect we do not speak must not be pattern-matched into a neighbour just
  // because it shares a word: it falls through to the ladder, which here finds a 5xx.
  const c = classifyError(new Error("upstream said no"), 503, "", { providerCode: "some_vendor_specific_code" });
  assert.equal(c.category, "server_error");
});

// ---------------------------------------------------------------------------
// The cases that already worked must keep working
// ---------------------------------------------------------------------------

test("status codes still classify without any prose at all", () => {
  assert.equal(classifyError(new Error(""), 401).category, "auth");
  assert.equal(classifyError(new Error(""), 429).category, "rate_limit");
  assert.equal(classifyError(new Error(""), 503).category, "server_error");
});

test("a genuine truncation phrase is still recognised", () => {
  assert.equal(classifyError(new Error("the response was truncated")).category, "truncated");
  assert.equal(classifyError(new Error('{"finish_reason": "length"}')).category, "truncated");
});

test("a real transport timeout is still retriable", () => {
  const c = classifyError(new Error("connect ETIMEDOUT: request timed out"));
  assert.equal(c.category, "timeout");
  assert.equal(c.retryable, true);
});

test("an unclassifiable error stays unknown and fails closed", () => {
  const c = classifyError(new Error("the flux capacitor disagreed"));
  assert.equal(c.category, "unknown");
  assert.equal(c.retryable, false);
  assert.equal(c.shouldFallback, false);
});
