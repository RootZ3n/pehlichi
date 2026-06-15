// ══════════════════════════════════════════════════════════════════════
// PEHLICHI · SCENE DATA — binds each Settlement workspace to live backend
// data. Renderers are async, return HTML strings, and degrade to a
// friendly note when the backend is unreachable. defIds MUST match
// WORKSPACE_REGISTRY in index.html. All data flows from real APIs — no
// mock data.
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var esc = (typeof window.esc === 'function') ? window.esc : function (v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  function ago(ms) {
    if (ms == null) return '—';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function offline(r) {
    return '<div class="peh-live-off"><b>The line to the settlement is quiet.</b>' +
      '<span>' + esc(r && r.error ? r.error : 'backend unreachable') + '</span>' +
      '<span class="peh-live-off-hint">Is Peh\'s server up on :18830?</span></div>';
  }
  function stat(label, value) {
    return '<div class="peh-stat"><span class="peh-stat-v">' + esc(value) + '</span><span class="peh-stat-l">' + esc(label) + '</span></div>';
  }
  function rows(list) { return '<div class="peh-rows">' + list.join('') + '</div>'; }
  function row(title, meta, extra) {
    return '<div class="peh-row"><span class="peh-row-t">' + esc(title) + '</span>' +
      (meta != null ? '<span class="peh-row-m">' + esc(meta) + '</span>' : '') +
      (extra ? '<div class="peh-row-x">' + extra + '</div>' : '') + '</div>';
  }
  function dot(ok) { return '<i class="peh-live-dot ' + (ok ? 'on' : 'off') + '"></i>'; }

  // ── Renderers — one per workspace ──────────────────────────────────────────

  // keep-config: Coordination Hub — active sessions
  async function rSessions() {
    var r = await window.PehAPI.sessions();
    if (!r.ok || !r.data) return offline(r);
    var d = r.data;
    var head = '<div class="peh-stats">' +
      stat('active', d.count) +
      stat('converse', d.converseSessions != null ? d.converseSessions : 0) +
      stat('evicted', d.evicted) +
      '</div>';
    var list = (d.sessions || []).map(function (s) {
      return row((s.isDefault ? '⭐ ' : '') + s.roomKey, s.historyLength + ' msgs · idle ' + ago(s.idleMs));
    });
    return head + (list.length ? rows(list) : '<p class="peh-live-empty">No rooms in flight. Quiet watch tonight.</p>');
  }

  // training-identity / market-comms: Agent Network + Message Board
  async function rAgents() {
    var r = await window.PehAPI.agents();
    if (!r.ok || !r.data) return offline(r);
    var d = r.data;
    var head = d.self ? '<div class="peh-stats">' + stat('my tools', d.self.tools) + stat('peers', d.count) + '</div>' : '';
    var list = (d.agents || []).map(function (a) {
      return row(a.name, 'port ' + a.port + ' · ' + a.status,
        dot(a.status === 'available') + '<span class="peh-row-desc">' + esc(a.description) + '</span>');
    });
    return head + (list.length ? rows(list) : '<p class="peh-live-empty">No peers on the network yet.</p>');
  }

  // armory-tools: Diagnostics Bench — tool inventory + health
  async function rTools() {
    var t = await window.PehAPI.tools();
    var h = await window.PehAPI.health();
    if (!t.ok || !t.data) return offline(t);
    var head = '<div class="peh-stats">' +
      stat('tools', t.data.count) +
      (h.ok && h.data ? stat('uptime', ago((h.data.uptime || 0) * 1000)) + stat('commit', h.data.commit || '—') : stat('health', 'down')) +
      '</div>';
    var names = (t.data.tools || []).map(function (n) {
      return '<span class="peh-chip">' + esc(n) + '</span>';
    }).join('');
    return head + '<div class="peh-chips">' + names + '</div>';
  }

  // quest-research: Research Notes — active missions + capabilities
  async function rMissions() {
    var s = await window.PehAPI.sessions();
    var c = await window.PehAPI.capabilities();
    if (!s.ok && !c.ok) return offline(s.ok ? c : s);
    var queue = (s.ok && s.data) ? (s.data.sessions || []).filter(function (x) { return x.idleMs < 60000; }) : [];
    var feats = (c.ok && c.data) ? (c.data.features || []) : [];
    var head = '<div class="peh-stats">' + stat('in flight', queue.length) + stat('capabilities', feats.length) + '</div>';
    var fl = feats.map(function (f) { return '<span class="peh-chip">' + esc(f) + '</span>'; }).join('');
    var ql = queue.length
      ? rows(queue.map(function (q) { return row(q.roomKey, 'active · ' + q.historyLength + ' msgs'); }))
      : '<p class="peh-live-empty">No quests in progress. The board is clear.</p>';
    return head + ql + '<div class="peh-chips">' + fl + '</div>';
  }

  // campsite-memory: Memory — past lives + curated entries
  var _expanded = {};
  async function rMemories(full) {
    var r = await window.PehAPI.memories();
    if (!r.ok || !r.data) return offline(r);
    var d = r.data;
    var head = '<div class="peh-stats">' +
      stat('past lives', (d.pastLives || []).length) +
      stat('curated', (d.entries || []).length) +
      '</div>';
    var lives = (d.pastLives || []).map(function (l) {
      var open = !!_expanded[l.project];
      var detail = open
        ? '<div class="peh-mem-detail"><p>' + esc(l.traits) + '</p>' +
          (l.speechQuirks ? '<p class="peh-mem-quirk">"' + esc(l.speechQuirks) + '"</p>' : '') + '</div>'
        : '';
      return '<button class="peh-mem ' + (open ? 'open' : '') + '" type="button" ' +
        'onclick="PehScenes.toggleLife(\'' + esc(l.project) + '\')">' +
        '<span class="peh-mem-h">' +
          '<span class="peh-mem-name">' + esc(l.name) + '</span>' +
          '<span class="peh-mem-era">' + esc(l.era) + '</span>' +
        '</span>' + detail + '</button>';
    }).join('');
    var entries = full && (d.entries || []).length
      ? rows(d.entries.map(function (e) { return row(e.title, e.project + ' · v' + e.version + ' · ' + e.status); }))
      : '';
    return head + '<div class="peh-mem-list">' + lives + '</div>' +
      (entries ? '<h4 class="peh-live-sub">Curated memory</h4>' + entries : '');
  }

  // chapel-meditation: Identity — who Peh is
  async function rIdentity() {
    var i = await window.PehAPI.info();
    var a = await window.PehAPI.agentSelf();
    if (!i.ok && !a.ok) return offline(i.ok ? a : i);
    var d = i.data || {};
    var ad = a.data || {};
    var head = '<div class="peh-stats">' + stat('model', ad.model || '—') + stat('status', ad.status || 'active') + '</div>';
    var voice = d.voice_summary ? '<p class="peh-live-quote">' + esc(d.voice_summary) + '</p>' : '';
    var bits = [];
    if (d.personality) bits.push(row('Personality', d.personality));
    if (d.intensity) bits.push(row('Intensity', d.intensity));
    if (ad.uptime != null) bits.push(row('Uptime', ago(ad.uptime * 1000)));
    return head + voice + (bits.length ? rows(bits) : '');
  }

  // study-knowledge: Knowledge Desk — curated entries + bridge connections
  async function rKnowledge() {
    var m = await window.PehAPI.memories();
    var b = await window.PehAPI.bridge();
    if (!m.ok && !b.ok) return offline(m.ok ? b : m);
    var entries = (m.ok && m.data) ? (m.data.entries || []) : [];
    var bridges = (b.ok && b.data) ? (b.data.bridges || []) : [];
    var head = '<div class="peh-stats">' + stat('archived', entries.length) + stat('connections', bridges.length) + '</div>';
    var el = entries.length
      ? rows(entries.map(function (e) {
          return row(e.title, e.project + ' · ' + e.status, '<span class="peh-row-desc">' + esc(e.description || '') + '</span>');
        }))
      : '<p class="peh-live-empty">The archive shelves are bare — no curated entries yet.</p>';
    return head + el;
  }

  // console: Settlement Overview live strip (health + reach)
  async function rConsole() {
    var h = await window.PehAPI.health();
    var s = await window.PehAPI.sessions();
    var b = await window.PehAPI.bridge();
    if (!h.ok && !s.ok && !b.ok) return offline(h);
    var hd = h.data || {};
    return '<div class="peh-stats">' +
      stat('status',   h.ok ? 'ok' : 'down') +
      stat('sessions', (s.ok && s.data) ? s.data.count : '—') +
      stat('tools',    hd.toolCount  != null ? hd.toolCount  : '—') +
      stat('crons',    hd.cronJobs   != null ? hd.cronJobs   : '—') +
      stat('bridges',  (b.ok && b.data) ? b.data.count : '—') +
      '</div>';
  }

  // ── defId → renderer + actionable option buttons ────────────────────────────
  var MAP = {
    'console':           { fn: rConsole },
    'keep-config':       { fn: rSessions,                          options: [['Refresh', "PehScenes.fill('keep-config',true)"],       ['Ask Peh: who\'s active?', "PehApp.ask('Who is currently talking to you?')"]] },
    'training-identity': { fn: rAgents,                            options: [['Refresh', "PehScenes.fill('training-identity',true)"],  ['See the Market', "pehGoScene('market-square')"]] },
    'armory-tools':      { fn: rTools,                             options: [['Refresh', "PehScenes.fill('armory-tools',true)"],       ['Check health', "PehApp.runCommand('health')"]] },
    'quest-research':    { fn: rMissions,                          options: [['Refresh', "PehScenes.fill('quest-research',true)"]] },
    'market-comms':      { fn: rAgents,                            options: [['Refresh', "PehScenes.fill('market-comms',true)"],       ['Council view', "pehGoScene('training-yard')"]] },
    'campsite-memory':   { fn: function () { return rMemories(true); }, options: [['Refresh', "PehScenes.fill('campsite-memory',true)"],  ['Visit the Study', "pehGoScene('the-study')"]] },
    'chapel-meditation': { fn: rIdentity,                          options: [['Refresh', "PehScenes.fill('chapel-meditation',true)"],  ['Ask Peh who he is', "PehApp.ask('Who are you, really?')"]] },
    'study-knowledge':   { fn: rKnowledge,                         options: [['Refresh', "PehScenes.fill('study-knowledge',true)"],    ['Browse memories', "pehGoScene('the-campsite')"]] },
  };

  function optionRow(defId) {
    var cfg = MAP[defId];
    if (!cfg || !cfg.options) return '';
    return '<div class="peh-live-opts">' + cfg.options.map(function (o) {
      return '<button class="peh-live-opt" type="button" onclick="' + esc(o[1]) + '">' + esc(o[0]) + '</button>';
    }).join('') + '</div>';
  }

  // The placeholder-body override target: a live container that self-fills.
  function liveContainer(defId) {
    return '<div class="peh-live" id="peh-live-' + esc(defId) + '">' +
      optionRow(defId) +
      '<div class="peh-live-body">' +
        '<div class="peh-live-loading">Peh is fetching the latest… <span class="peh-live-spin"></span></div>' +
      '</div></div>';
  }

  async function fill(defId, fresh) {
    var cfg = MAP[defId];
    if (!cfg) return;
    if (fresh) window.PehAPI.refresh();
    var host = document.getElementById('peh-live-' + defId);
    if (!host) return;
    var body = host.querySelector('.peh-live-body');
    if (fresh && body) body.innerHTML = '<div class="peh-live-loading">Refreshing… <span class="peh-live-spin"></span></div>';
    var html;
    try { html = await cfg.fn(); } catch (e) { html = offline({ error: (e && e.message) || String(e) }); }
    // Re-query: a re-render may have replaced the node while we awaited.
    host = document.getElementById('peh-live-' + defId);
    if (!host) return;
    body = host.querySelector('.peh-live-body');
    if (body) body.innerHTML = html;
  }

  window.PehScenes = {
    has: function (defId) { return !!MAP[defId]; },
    liveContainer: liveContainer,
    fill: fill,
    toggleLife: function (project) {
      _expanded[project] = !_expanded[project];
      fill('campsite-memory');
    },
  };
})();
