// ══════════════════════════════════════════════════════════════════════
// PEHLICHI · API CLIENT — talks to Peh's backend (default port 18830).
// Pure vanilla. No deps. Every call resolves to {ok, data, error, status}
// and NEVER throws, so a scene can always render even when the backend
// is down. Endpoints: /health, /agent, /capabilities, /api/sessions,
// /api/memories, /api/agents, /api/bridge, /chat, /converse.
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // Resolve the backend base URL. Order: explicit ?api= query → injected
  // window.PEHLICHI_API → same-origin if already served from the agent port →
  // the local default. The agent binds 127.0.0.1:18830.
  function resolveBase() {
    try {
      var q = new URLSearchParams(location.search).get('api');
      if (q) return q.replace(/\/$/, '');
    } catch (e) { /* file:// has no usable search */ }
    if (typeof window !== 'undefined' && window.PEHLICHI_API) {
      return String(window.PEHLICHI_API).replace(/\/$/, '');
    }
    try {
      if (location.protocol.startsWith('http') && location.port === '18830') {
        return location.origin;
      }
    } catch (e) { /* ignore */ }
    return 'http://127.0.0.1:18830';
  }

  var BASE = resolveBase();

  // Tiny TTL cache so repeated renders of the same scene don't hammer the
  // backend. Keyed by path; cleared by refresh().
  var cache = new Map();
  var CACHE_MS = 4000;

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : new Date().getTime();
  }

  async function get(path, opts) {
    opts = opts || {};
    var fresh = opts.fresh === true;
    var key = path;
    if (!fresh) {
      var hit = cache.get(key);
      if (hit && (now() - hit.t) < CACHE_MS) return hit.v;
    }
    var result;
    try {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, opts.timeout || 6000);
      var res = await fetch(BASE + path, { method: 'GET', signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
      clearTimeout(timer);
      var data = null;
      try { data = await res.json(); } catch (e) { /* non-JSON body */ }
      result = { ok: res.ok, status: res.status, data: data, error: res.ok ? null : ('HTTP ' + res.status) };
    } catch (err) {
      var msg = (err && err.name === 'AbortError') ? 'timed out' : (err && err.message) || String(err);
      result = { ok: false, status: 0, data: null, error: msg };
    }
    cache.set(key, { t: now(), v: result });
    return result;
  }

  async function post(path, body, opts) {
    opts = opts || {};
    try {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, opts.timeout || 30000);
      var res = await fetch(BASE + path, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      clearTimeout(timer);
      var data = null;
      try { data = await res.json(); } catch (e) { /* ignore */ }
      return { ok: res.ok, status: res.status, data: data, error: res.ok ? null : ('HTTP ' + res.status) };
    } catch (err) {
      var msg = (err && err.name === 'AbortError') ? 'timed out' : (err && err.message) || String(err);
      return { ok: false, status: 0, data: null, error: msg };
    }
  }

  window.PehAPI = {
    base: BASE,
    // Read endpoints — the scene data sources.
    health:       function (o) { return get('/health', o); },
    info:         function (o) { return get('/info', o); },
    agentSelf:    function (o) { return get('/agent', o); },
    tools:        function (o) { return get('/tools', o); },
    capabilities: function (o) { return get('/capabilities', o); },
    sessions:     function (o) { return get('/api/sessions', o); },
    memories:     function (o) { return get('/api/memories', o); },
    agents:       function (o) { return get('/api/agents', o); },
    bridge:       function (o) { return get('/api/bridge', o); },
    // Conversational lanes — /chat for the floating panel, /converse for the command bar.
    chat:    function (message, o) { return post('/chat',    { message: message }, o); },
    converse: function (message, o) { return post('/converse', { message: message }, o); },
    // Drop cached reads so the next call refetches.
    refresh: function () { cache.clear(); },
    _get: get,
    _post: post,
  };
})();
