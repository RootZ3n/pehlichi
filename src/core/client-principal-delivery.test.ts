/**
 * CLIENT PRINCIPAL DELIVERY — how each real client obtains authority, and what it must never do.
 *
 * Phase 2 made every lane require an externally issued principal, which made every real client
 * unusable, because none of them presented one. Phase 2B gave them one. The interesting part is
 * not that they now send a header; it is that four different clients had four different answers to
 * "where does a secret live", and only one of them is safe for a browser.
 *
 * What this file proves is the SHAPE of that delivery, on the real sources:
 *
 *   - a server-side client reads its principal from the systemd credential channel, once, with the
 *     descriptor closed, and never from a repository `.env`, an ordinary environment variable or
 *     argv;
 *   - the operator's terminal client is given a PATH in the environment and reads the file, so the
 *     document itself is never inherited by a child process or dumped with the environment;
 *   - the browser is given nothing at all: the server holds a principal on its behalf, applies it
 *     only to a request that authenticated with the chat bearer, and only when a bearer is
 *     actually configured -- so the fallback can never become an anonymous path;
 *   - a client that presents its own principal is served by that one, never by the server's.
 *
 * Whether a presented principal is ACCEPTED is not decided here and cannot be: that is the lane
 * authorization's answer, against an issuer named in a root-owned lease this process cannot write.
 * The live client matrix proves acceptance against real credentials and real servers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FORBIDDEN_RECEIPT_MARKERS } from './receipt-access.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SERVER = readFileSync(join(ROOT, 'runtime/server/server.ts'), 'utf8');
const REPL = readFileSync(join(ROOT, 'src/cli/repl.ts'), 'utf8');

/** The body of one named binding, from `const NAME` to the first line that closes it. */
function binding(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start > 0, `${declaration} is not where this test expects it`);
  // The two loaders sit at different nesting depths -- one inside `createAgentServer`, one at a
  // module's top level -- so the closer is matched at either indentation rather than at one.
  const candidates = [source.indexOf('\n  })();', start), source.indexOf('\n})();', start)]
    .filter((i) => i > start);
  const end = Math.min(...candidates);
  assert.ok(candidates.length > 0 && Number.isFinite(end), `${declaration} is no longer a self-invoked loader`);
  return source.slice(start, end);
}

// ── the server-held browser principal ───────────────────────────────────────────────────────

test('the browser principal is read from the credential channel, once, and closed', () => {
  const loader = binding(SERVER, 'const browserPrincipal = ((): string | undefined =>');
  assert.match(loader, /CREDENTIALS_DIRECTORY/, 'the browser principal is not read from the credential channel');
  assert.match(loader, /openSync\(/, 'the loader does not open a descriptor it can close');
  assert.match(loader, /closeSync\(fd\)/, 'the loader does not close its descriptor');
  assert.match(loader, /finally/, 'the descriptor is not closed on the failure path');
  // Read at construction, not per request: a value re-read on every request is a syscall that can
  // never return anything different, and a place for a race to appear later.
  assert.equal(/\breq\b/.test(loader), false, 'the browser principal is read per request');
});

test('the browser fallback cannot become an anonymous path', () => {
  const chooser = SERVER.slice(SERVER.indexOf('const presentedPrincipal ='));
  const body = chooser.slice(0, chooser.indexOf('\n  };'));
  // All three conditions, and in this order: a token must be CONFIGURED, a principal must be held,
  // and the request must have satisfied the token. Dropping any one of them opens the hole.
  assert.match(body, /hasChatToken && browserPrincipal !== undefined && declaresBrowserClient\(req\)/,
    'the browser fallback does not require a configured token and a declared browser client');
  assert.match(body, /chatAuthorized\(req\)/, 'the browser fallback does not require the token to be satisfied');
  /*
    A server-side client that forgets its credential must be REFUSED, not silently served as the
    browser. The caller declares itself rather than being sniffed: an earlier attempt inferred it
    from `Sec-Fetch-*`, which Node's own fetch also sends, so the signal separated nothing.
  */
  assert.match(SERVER, /const declaresBrowserClient = \(req: IncomingMessage\): boolean =>/,
    'nothing distinguishes a declared browser client from a daemon');
  assert.ok(SERVER.includes("req.headers['x-pehverse-client']"), 'the declaration header is not read');
  for (const sniffed of ['sec-fetch-mode', 'sec-fetch-site'])
    assert.equal(SERVER.includes(`req.headers['${sniffed}']`), false,
      `${sniffed} is used to guess the caller; Node's fetch sends it too`);
  // And the shipped page actually makes the declaration, or the fallback reaches nobody.
  assert.ok(readFileSync(join(ROOT, 'ui/chat.html'), 'utf8').includes('"x-pehverse-client":"browser-ui"'),
    'the browser UI does not declare itself');
  // A presented principal is answered first, so a real client is never served the server's.
  assert.ok(body.indexOf("req.headers['x-pehverse-principal']") < body.indexOf('browserPrincipal'),
    'the server principal is preferred over a client-presented one');
  assert.match(body, /return undefined;/, 'an unauthenticated request is not left absent');
});

test('the browser is never handed authority it could keep', () => {
  // Nothing in the server writes a principal into a response, a page or a cookie.
  for (const escape of ['Set-Cookie', 'set-cookie', 'browserPrincipal }', 'principal: browserPrincipal',
    'JSON.stringify(browserPrincipal', 'browserPrincipal)']) {
    assert.equal(SERVER.includes(escape), false, `the server can emit the browser principal via ${escape}`);
  }
  // And the shipped UI holds no principal of its own: it authenticates, and that is all.
  const ui = readFileSync(join(ROOT, 'ui/chat.html'), 'utf8');
  assert.equal(/x-pehverse-principal/i.test(ui), false, 'the browser UI sends a principal of its own');
  assert.equal(/pehverse-delegation/i.test(ui), false, 'the browser UI carries delegated authority');
});

// ── the operator's terminal client ──────────────────────────────────────────────────────────

test('the operator client is given a path, never the document', () => {
  const loader = binding(REPL, 'const OPERATOR_PRINCIPAL = ((): string =>');
  assert.match(loader, /AGENT_PRINCIPAL_FILE/, 'the operator client does not read a path from the environment');
  assert.match(loader, /openSync\(file, 'r'\)/, 'the operator client does not open the file it was pointed at');
  assert.match(loader, /closeSync\(fd\)/, 'the operator client leaks its descriptor');
  // The assertion itself must never be an environment variable: that is inherited by every child.
  assert.equal(/process\.env\.AGENT_PRINCIPAL\b/.test(REPL), false,
    'the operator client accepts the assertion itself from the environment');
  // Nor from argv, which is world-readable on this machine.
  assert.equal(/process\.argv[^\n]*principal/i.test(REPL), false, 'the operator client reads a principal from argv');
});

test('the operator client separates authentication from authorization', () => {
  const headers = REPL.slice(REPL.indexOf('function agentHeaders()'));
  const body = headers.slice(0, headers.indexOf('\n}'));
  assert.match(body, /authorization.*Bearer/s, 'the bearer is no longer sent');
  assert.match(body, /x-pehverse-principal/, 'the principal is not sent');
  // Two headers, two questions. Merging them is how a shared secret becomes an authorization.
  assert.notEqual(body.indexOf('authorization'), body.indexOf('x-pehverse-principal'));
});

test('every request the operator client makes carries whatever authority it holds', () => {
  // A client that authenticates some calls and not others teaches an operator that refusals are
  // random. Every fetch goes through the one header builder.
  // Scanned to the end of each statement rather than to the first `)`: a call like
  // `fetch(\`${BASE}/x/${encodeURIComponent(id)}\`, { headers })` closes an inner parenthesis
  // first, and a lazier scan reports it as bare when it is not.
  const bare: string[] = [];
  for (const match of REPL.matchAll(/fetch\(/g)) {
    const from = match.index ?? 0;
    const statementEnd = REPL.indexOf(';', from);
    const call = REPL.slice(from, statementEnd === -1 ? from + 400 : statementEnd);
    if (!call.includes('agentHeaders()')) bare.push(call.replace(/\s+/g, ' ').slice(0, 80));
  }
  assert.deepEqual(bare, [], `these calls bypass the header builder: ${bare.join(' | ')}`);
});

// ── the receipt-evidence guard knows about the new header ───────────────────────────────────

test('the forbidden-marker list covers the header a principal now travels on', () => {
  assert.ok(FORBIDDEN_RECEIPT_MARKERS.includes('x-pehverse-principal'));
  assert.ok(FORBIDDEN_RECEIPT_MARKERS.includes('pehverse-request-principal/'));
  assert.ok(FORBIDDEN_RECEIPT_MARKERS.includes('authorization'));
});
